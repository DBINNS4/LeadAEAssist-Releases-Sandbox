const { safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const platformPaths = require('../platform/paths');
const { renameReplaceSync, uniqueTempPath, atomicWriteJson } = require('../utils/fsSafe');

const SECRET_FILE_PREFIX_SAFE = 'SS1:';
const SECRET_FILE_PREFIX_FALLBACK = 'FB1:';
const SECRET_FILE_PREFIX_FALLBACK_V2 = 'FB2:';

function resolveUserDataPath() {
  const envPath = process.env.USER_DATA_PATH;

  // Trust the env var even if the directory doesn't exist yet (we'll create it).
  if (envPath && typeof envPath === 'string') {
    try { fs.mkdirSync(envPath, { recursive: true }); } catch {}
    return envPath;
  }

  // Cross-platform fallback when Electron's userData isn't available.
  const base = platformPaths.getAppDataBase();
  const variants = ['LeadAEAssist', 'Lead AE Assist'];

  for (const candidate of variants) {
    const resolved = path.join(base, candidate);
    try {
      if (fs.existsSync(resolved)) return resolved;
    } catch {}
  }

  const canonical = path.join(base, 'LeadAEAssist');
  try { fs.mkdirSync(canonical, { recursive: true }); } catch {}
  return canonical;
}

const userDataPath = resolveUserDataPath();
const secretsPath = path.join(userDataPath, 'config', 'secrets.bin');
const fallbackKeyPath = path.join(userDataPath, 'config', 'secrets.fallback.key');

let fallbackKeyCache = null;

function readFallbackKeyFile() {
  if (!fs.existsSync(fallbackKeyPath)) return null;
  const raw = fs.readFileSync(fallbackKeyPath, 'utf-8').trim();
  if (!raw) throw new Error('Fallback key file is empty');

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('Fallback key file is invalid');
  return key;
}

function writeFallbackKeyFile(keyBuffer) {
  fs.mkdirSync(path.dirname(fallbackKeyPath), { recursive: true });
  const tmpPath = uniqueTempPath(fallbackKeyPath, '.tmp');

  try {
    fs.writeFileSync(tmpPath, keyBuffer.toString('base64'), { encoding: 'utf-8', mode: 0o600 });
    renameReplaceSync(tmpPath, fallbackKeyPath);
    fs.chmodSync(fallbackKeyPath, 0o600);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function getFallbackKey() {
  if (fallbackKeyCache) return fallbackKeyCache;

  const existing = readFallbackKeyFile();
  if (existing) {
    fallbackKeyCache = existing;
    return fallbackKeyCache;
  }

  const generated = crypto.randomBytes(32);
  writeFallbackKeyFile(generated);
  fallbackKeyCache = generated;
  return fallbackKeyCache;
}

function isSafeStorageAvailable() {
  try {
    return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptFallback(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getFallbackKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptFallback(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Fallback decrypt requires a Buffer');
  if (buffer.length < 28) throw new Error('Fallback ciphertext too short');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getFallbackKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function encodeForDisk(plaintext) {
  // Prefer OS-backed safeStorage when available, but always persist a tagged format
  // so we can deterministically choose the correct decrypt method later.
  if (isSafeStorageAvailable())
    try {
      const buf = safeStorage.encryptString(plaintext);
      return `${SECRET_FILE_PREFIX_SAFE}${buf.toString('base64')}`;
    } catch {}

  const buf = encryptFallback(plaintext);
  return `${SECRET_FILE_PREFIX_FALLBACK_V2}${buf.toString('base64')}`;
}

function decodeFromDisk(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { plaintext: '{}', needsMigration: false };

  // Tagged formats (preferred)
  if (trimmed.startsWith(SECRET_FILE_PREFIX_SAFE)) {
    const b64 = trimmed.slice(SECRET_FILE_PREFIX_SAFE.length);
    const buf = Buffer.from(b64, 'base64');
    if (!isSafeStorageAvailable()) throw new Error('safeStorage encryption is not available to decrypt secrets.');
    try {
      return { plaintext: safeStorage.decryptString(buf), needsMigration: false };
    } catch {
      // If the file was mislabeled or corrupted, try the fallback path before giving up.
      return { plaintext: decryptFallback(buf), needsMigration: true };
    }
  }

  if (trimmed.startsWith(SECRET_FILE_PREFIX_FALLBACK)) {
    const b64 = trimmed.slice(SECRET_FILE_PREFIX_FALLBACK.length);
    const buf = Buffer.from(b64, 'base64');
    try {
      return { plaintext: decryptFallback(buf), needsMigration: true };
    } catch {
      // Mislabeled/corrupt file fallback
      if (!isSafeStorageAvailable()) throw new Error('Failed to decrypt fallback secrets and safeStorage is unavailable.');
      return { plaintext: safeStorage.decryptString(buf), needsMigration: true };
    }
  }

  if (trimmed.startsWith(SECRET_FILE_PREFIX_FALLBACK_V2)) {
    const b64 = trimmed.slice(SECRET_FILE_PREFIX_FALLBACK_V2.length);
    const buf = Buffer.from(b64, 'base64');
    try {
      return { plaintext: decryptFallback(buf), needsMigration: false };
    } catch {
      if (!isSafeStorageAvailable()) throw new Error('Failed to decrypt FB2 secrets and safeStorage is unavailable.');
      return { plaintext: safeStorage.decryptString(buf), needsMigration: true };
    }
  }

  // Plain JSON fallback (rare, but lets us recover from manual edits).
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return { plaintext: trimmed, needsMigration: true };

  // Legacy format: base64-only. Try safeStorage first (when available), then fallback.
  const buf = Buffer.from(trimmed, 'base64');

  if (isSafeStorageAvailable())
    try {
      return { plaintext: safeStorage.decryptString(buf), needsMigration: true };
    } catch {}

  return { plaintext: decryptFallback(buf), needsMigration: true };
}

let secretsCache = null;
let secretsCacheMtimeMs = 0;
let secretsCacheSize = 0;

function readSecrets(options = {}) {
  const { force = false } = options;

  try {
    if (!fs.existsSync(secretsPath)) return {};

    const st = fs.statSync(secretsPath);
    if (!force && secretsCache && st.mtimeMs === secretsCacheMtimeMs && st.size === secretsCacheSize) return secretsCache;

    const raw = fs.readFileSync(secretsPath, 'utf-8');
    const { plaintext, needsMigration } = decodeFromDisk(raw);
    const parsed = JSON.parse(plaintext);

    const next = parsed && typeof parsed === 'object' ? parsed : {};
    secretsCache = next;
    secretsCacheMtimeMs = st.mtimeMs;
    secretsCacheSize = st.size;

    // One-time migration to tagged format so we never have to "guess decrypt" again.
    if (needsMigration) writeSecrets(next);

    return next;
  } catch (err) {
    console.warn('⚠️ Failed to read encrypted secrets:', err?.message || err);
    return {};
  }
}

function writeSecrets(data) {
  try {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });

    const payload = encodeForDisk(JSON.stringify(data));
    const tmpPath = uniqueTempPath(secretsPath, '.tmp');

    // Atomic-ish: write temp then rename. Prevents truncation/corruption on crashes.
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    try {
      renameReplaceSync(tmpPath, secretsPath);
    } catch (err) {
      // Best-effort cleanup of temp if finalize fails
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
    try { fs.chmodSync(secretsPath, 0o600); } catch {}

    const st = fs.statSync(secretsPath);
    secretsCache = data;
    secretsCacheMtimeMs = st.mtimeMs;
    secretsCacheSize = st.size;

    return true;
  } catch (err) {
    console.error('❌ Failed to persist encrypted secrets:', err?.message || err);
    return false;
  }
}

function isAvailable() {
  return isSafeStorageAvailable();
}

function loadSecret(key) {
  const secrets = readSecrets();
  return secrets?.[key] ?? null;
}

function saveSecret(key, value) {
  if (!key) return false;
  const secrets = { ...readSecrets() };
  if (value === null || value === undefined) {
    delete secrets[key];
    return writeSecrets(secrets);
  }
  secrets[key] = value;
  return writeSecrets(secrets);
}

function deleteSecret(key) {
  if (!key) return false;
  const secrets = { ...readSecrets() };
  delete secrets[key];
  return writeSecrets(secrets);
}

async function migrateLegacyApiKey(statePath) {
  const prefsPath = statePath || path.join(userDataPath, 'config', 'state.json');
  try {
    const raw = await fsp.readFile(prefsPath, 'utf-8');
    const prefs = JSON.parse(raw);
    const legacyKey = prefs?.preferences?.apiKey;

    if (legacyKey && typeof legacyKey === 'string') {
      saveSecret('aiApiKey', legacyKey);
      if (prefs.preferences) {
        const mode = await fsp
          .stat(prefsPath)
          .then((st) => st.mode & 0o777)
          .catch(() => 0o600);

        const nextPrefs = {
          ...prefs,
          preferences: {
            ...prefs.preferences,
            apiKeyStored: true,
          },
        };
        delete nextPrefs.preferences.apiKey;

        try {
          await atomicWriteJson(prefsPath, nextPrefs, { mode });
        } catch (writeErr) {
          console.warn('⚠️ Failed to finalize legacy AI API key migration write; keeping legacy state for retry:', writeErr?.message || writeErr);
        }
      }
      return legacyKey;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('⚠️ Failed to migrate legacy AI API key:', err?.message || err);
    }
  }
  return null;
}

async function getAiApiKey(options = {}) {
  const existing = loadSecret('aiApiKey');
  if (existing && typeof existing === 'string' && existing.trim().length > 0) {
    // Secret already exists, but still attempt best-effort legacy state cleanup.
    await migrateLegacyApiKey(options.statePath);
    return existing;
  }

  const migrated = await migrateLegacyApiKey(options.statePath);
  if (migrated) return migrated;

  return '';
}

module.exports = {
  isAvailable,
  loadSecret,
  saveSecret,
  deleteSecret,
  getAiApiKey,
  migrateLegacyApiKey,
  resolveUserDataPath,
};
