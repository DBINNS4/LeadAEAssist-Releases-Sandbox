const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app, BrowserWindow, dialog, ipcMain, session, screen, shell, Menu } = require('electron');
const { assertTrustedIpcSender } = require('./utils/trustedIpcSender');
const { assertApprovedPath, toLocalPathIfFileUrl } = require('./utils/ipcPathGuards');
const ffmpegBridge = require('./utils/ffmpegBridge');
const { getBinaryPaths } = ffmpegBridge;
const { preflightFfmpegBinaries, looksLikeGatekeeperKill } = require('./utils/ffmpegPreflight');
const ffmpegCaps = require('./utils/ffmpegCapabilities');
const { installExternalNavigationGuards } = require('./utils/externalNavigationGuards');
const licenseService = require('./services/licenseService');
const cloneCore = require('./modules/clone');
const { sendLogMessage, createSessionLogWriter } = require('./modules/logUtils');
const isPackaged = app?.isPackaged ?? false;
const allowDevTools = !isPackaged || process.env.DEBUG_UI === 'true';
const { startCEPBridge } = require('./modules/cepBridge');
const { getCredentials } = require('./services/bridgeServerService');
const { registerIpcHandlers } = require('./ipc');
const telemetryService = require('./services/telemetryService');
const { initAutoUpdates } = require('./services/autoUpdateService');
const platformPaths = require('./platform/paths');
const { atomicWriteJson: atomicWriteJsonSafe } = require('./utils/fsSafe');
const { runStartupMaintenance } = require('./utils/maintenance');
const { readState } = require('./utils/state');
const { buildStartupHealth, loadStartupDependencies } = require('./utils/startupBootstrap');
const { registerGlobalErrorHandlers } = require('./utils/globalErrorHandlers');
const {
  getSharedWatchRegistry,
  flushSharedWatchRegistrySave,
  createSessionKey: createWatchSessionKey,
  createFileSignature: createWatchFileSignature,
  isProcessed: isWatchFileProcessed
} = require('./utils/watchRegistry');

const execFileAsync = promisify(execFile);
const EXEC_FILE_TIMEOUT_MS = 1500;

const APP_CONTENT_SECURITY_POLICY = `default-src 'self' file:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*; script-src 'self' file:; script-src-attr 'none'; style-src 'self' file:; style-src-elem 'self' file:; style-src-attr 'unsafe-inline'; img-src 'self' data: file: blob:; media-src 'self' file: blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none';`;

// FFmpeg can be slow to spawn on first run (quarantine scan, AV, cold disk).
// Allow override for support/debug via env.
const FFMPEG_VERSION_TIMEOUT_MS = Number(process.env.FFMPEG_VERSION_TIMEOUT_MS || 10000);
const WATCH_REGISTRY_HASH_BYTES = Number(process.env.WATCH_REGISTRY_HASH_BYTES || 256 * 1024);
const FALLBACK_WARN_THROTTLE_MS = Number(process.env.FALLBACK_WARN_THROTTLE_MS || 60 * 1000);

function createThrottledWarnLogger(defaultWindowMs = FALLBACK_WARN_THROTTLE_MS) {
  const lastByKey = new Map();
  return (key, detail, { windowMs = defaultWindowMs } = {}) => {
    const now = Date.now();
    const last = lastByKey.get(key) || 0;
    if ((now - last) < windowMs) return;
    lastByKey.set(key, now);
    console.warn(`[fallback:${key}]`, detail);
  };
}

const warnFallback = createThrottledWarnLogger();


const localeMessagesCache = new Map();

function loadLocaleMessages(localeCode) {
  const normalized = String(localeCode || 'en').toLowerCase();
  if (localeMessagesCache.has(normalized)) return localeMessagesCache.get(normalized);
  const localePath = path.join(__dirname, 'locales', `${normalized}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    localeMessagesCache.set(normalized, parsed && typeof parsed === 'object' ? parsed : {});
  } catch {
    localeMessagesCache.set(normalized, {});
  }
  return localeMessagesCache.get(normalized);
}

function getLocalizedMainMessage(key, fallback) {
  const localeRaw = String(app?.getLocale?.() || 'en').toLowerCase();
  const locale = localeRaw.split('-')[0] || 'en';
  const preferred = loadLocaleMessages(locale);
  if (preferred && typeof preferred[key] === 'string' && preferred[key].trim()) {
    return preferred[key];
  }
  const english = loadLocaleMessages('en');
  if (english && typeof english[key] === 'string' && english[key].trim()) {
    return english[key];
  }
  return fallback || key;
}

function verifyRequiredDirectoryReadWriteAccess(requiredDirs = []) {
  for (const dirPath of requiredDirs) {
    try {
      const stats = fs.statSync(dirPath);
      if (!stats.isDirectory()) {
        return {
          ok: false,
          dirPath,
          errorCode: 'ENOTDIR',
          message: `${dirPath} is not a directory`
        };
      }
      fs.accessSync(dirPath, fs.constants.W_OK);
    } catch (err) {
      return {
        ok: false,
        dirPath,
        errorCode: err?.code || 'E_STORAGE_INIT',        
        message: err?.message || String(err)
      };
    }
  }

  return { ok: true };
}

function abortStartupForStorageInitFailure({ failingPath = '', errorCode = 'E_STORAGE_INIT', message = '' } = {}) {
  const event = 'startup/storage-init-failed';
  const pathDetail = String(failingPath || '').trim() || '(unknown path)';
  const codeDetail = String(errorCode || 'E_STORAGE_INIT');
  const messageDetail = String(message || '').trim() || 'Unknown storage initialization error';
  const dialogMessage = [
    'Storage initialization failed.',
    '',
    `Path: ${pathDetail}`,
    `Error Code: ${codeDetail}`,
    `Details: ${messageDetail}`,
    '',
    'Please verify permissions for the selected storage location and ensure sufficient free disk space.'
  ].join('\n');

  try {
    telemetryService.captureMessage?.(event, {
      level: 'fatal',
      tags: {
        scope: 'startup',
        subsystem: 'storage',
        event
      },
      extra: {
        path: pathDetail,
        errorCode: codeDetail,
        message: messageDetail
      },
      dedupeKey: `${event}:${pathDetail}:${codeDetail}`,
      dedupeWindowMs: 5 * 60 * 1000
    });
  } catch (err) {
    warnFallback('startup.storage.telemetry-failed', err?.message || err);
  }

  sendLogMessage(
    'system',
    '❌ Startup storage initialization failed.',
    `path=${pathDetail};code=${codeDetail};message=${messageDetail}`,
    false,
    '',
    'error'
  );

  dialog.showErrorBox('Startup Error', dialogMessage);
  app.exit(1);
}

function isOfflineModeEnabled() {
  try {
    const state = readState() || {};
    return !!state?.preferences?.offlineMode;
  } catch {
    return false;
  }
}

function makeOfflineNetworkError(target) {
  const err = new Error(
    `Offline Mode is enabled. Network access is blocked.${target ? ` (${target})` : ''} ` +
    `Disable Offline Mode in Preferences to re-enable network features.`
  );
  err.name = 'OfflineModeError';
  err.code = 'OFFLINE_MODE';
  err.details = { target: target || '' };
  return err;
}

function isLocalhostHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return false;
  // Allow localhost only (CEP bridge + internal services).
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function parseHostnameFromUrlLike(urlLike) {
  try {
    const raw = String(urlLike || '').trim();
    if (!raw) return { hostname: '', raw };
    // Support ws/wss/http/https plus bare host:port patterns.
    const u = raw.includes('://') ? new URL(raw) : new URL(`http://${raw}`);
    return { hostname: u.hostname || '', raw };
  } catch {
    return { hostname: '', raw: String(urlLike || '') };
  }
}

function extractHostnameFromHttpArgs(args) {
  // http(s).request supports:
  //   request(url[, options][, cb])
  //   request(options[, cb])
  // We only care about hostname/host when Offline Mode is enabled.
  const a0 = args && args.length ? args[0] : null;
  const a1 = args && args.length > 1 ? args[1] : null;

  // URL string or URL object in arg0
  if (typeof a0 === 'string' || a0 instanceof URL) {
    const parsed = parseHostnameFromUrlLike(a0.toString());
    // options can override hostname
    const opts = (a1 && typeof a1 === 'object' && !(a1 instanceof Function)) ? a1 : null;
    const hostOverride = opts?.hostname || opts?.host;
    if (hostOverride) {
      const overrideParsed = parseHostnameFromUrlLike(String(hostOverride));
      return { hostname: overrideParsed.hostname, target: a0.toString() };
    }
    return { hostname: parsed.hostname, target: a0.toString() };
  }

  // Options object in arg0
  if (a0 && typeof a0 === 'object') {
    const host = a0.hostname || a0.host || '';
    const parsed = parseHostnameFromUrlLike(String(host));
    const target = a0.href ? String(a0.href) : (parsed.raw || '');
    return { hostname: parsed.hostname, target };
  }

  return { hostname: '', target: '' };
}

function installNodeOfflineNetworkGate() {
  if (process.__leadAeOfflineNetworkGateInstalled) return;
  process.__leadAeOfflineNetworkGateInstalled = true;

  const { EventEmitter } = require('events');

  class BlockedClientRequest extends EventEmitter {
    constructor(err) {
      super();
      this._err = err;
      // Emit asynchronously to mimic real request failure patterns.
      process.nextTick(() => this.emit('error', err));
      process.nextTick(() => this.emit('close'));
    }
    end() { return this; }
    write() { return false; }
    abort() { return this.destroy(); }
    destroy() {
      process.nextTick(() => this.emit('close'));
      return this;
    }
    setTimeout() { return this; }
    setHeader() { return this; }
    removeHeader() { return this; }
    getHeader() { return undefined; }
    flushHeaders() { return this; }
  }

  const shouldBlockHost = (hostname) => {
    if (!isOfflineModeEnabled()) return false;
    // Block anything that isn't localhost while Offline Mode is enabled.
    return !isLocalhostHostname(hostname);
  };

  const wrapNodeRequest = (mod, key) => {
    const original = mod && typeof mod[key] === 'function' ? mod[key] : null;
    if (!original || original.__leadAeOfflineWrapped) return;

    const wrapped = function (...args) {
      const { hostname, target } = extractHostnameFromHttpArgs(args);
      if (!shouldBlockHost(hostname)) {
        return original.apply(this, args);
      }
      const err = makeOfflineNetworkError(target || hostname || 'request');
      return new BlockedClientRequest(err);
    };
    wrapped.__leadAeOfflineWrapped = true;
    mod[key] = wrapped;
  };

  // Patch Node http/https so *all* main-process network attempts fail consistently in Offline Mode.
  try {
    const http = require('http');
    wrapNodeRequest(http, 'request');
    // http.get calls http.request internally; patch request is sufficient.
  } catch {}
  try {
    const https = require('https');
    wrapNodeRequest(https, 'request');
  } catch {}

  // Patch global fetch (OpenAI SDK / undici path) with a consistent OfflineModeError.
  try {
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch === 'function' && !originalFetch.__leadAeOfflineWrapped) {
      const wrappedFetch = async (input, init) => {
        if (!isOfflineModeEnabled()) return originalFetch(input, init);
        const urlStr =
          typeof input === 'string'
            ? input
            : (input && typeof input === 'object' && typeof input.url === 'string')
              ? input.url
              : '';
        const { hostname, raw } = parseHostnameFromUrlLike(urlStr);
        if (isLocalhostHostname(hostname)) return originalFetch(input, init);
        throw makeOfflineNetworkError(raw || hostname || 'fetch');
      };
      wrappedFetch.__leadAeOfflineWrapped = true;
      globalThis.fetch = wrappedFetch;
    }
  } catch {}
}

function installRendererOfflineNetworkGate() {
  // Block renderer-initiated http(s)/ws(s) when Offline Mode is enabled.
  // (Main-process Node gate is handled separately.)
  try {
    const blocker = (details, callback) => {
      try {
        const url = String(details?.url || '');
        if (!url) return callback({});
        // Only gate actual network schemes.
        if (!/^https?:\/\//i.test(url) && !/^wss?:\/\//i.test(url)) return callback({});
        if (!isOfflineModeEnabled()) return callback({});

        const { hostname } = parseHostnameFromUrlLike(url);
        if (isLocalhostHostname(hostname)) return callback({});

        return callback({ cancel: true });
      } catch {
        // Fail safe: if Offline Mode is enabled and we can't parse, cancel.
        if (isOfflineModeEnabled()) return callback({ cancel: true });
        return callback({});
      }
    };

    // Idempotent-ish: Electron will throw if you attach multiple identical handlers in some versions.
    // Guard with a flag.
    if (!session.defaultSession.__leadAeOfflineWebRequestGateInstalled) {
      session.defaultSession.__leadAeOfflineWebRequestGateInstalled = true;
      session.defaultSession.webRequest.onBeforeRequest(blocker);
    }
  } catch (err) {
    console.warn('⚠️ Offline network gate (renderer) setup failed (best-effort):', err?.message || String(err));
  }
}

function applyOfflineModeRestrictions(panel, cfg) {
  if (!isOfflineModeEnabled()) return cfg;

  const base = (cfg && typeof cfg === 'object') ? cfg : {};
  const nextCfg = { ...base };

  // Offline Mode guarantee: no non-local network access.
  // Allow localhost automation (127.0.0.1/localhost/::1) for same-machine workflows.
  const disableNonLocalWebhookIfConfigured = () => {
    const enabled = !!(nextCfg.enableN8N || nextCfg.n8nLog);
    if (!enabled) return;

    const url = String(nextCfg.n8nUrl || '').trim();
    const { hostname } = parseHostnameFromUrlLike(url);
    const isLocal = url && isLocalhostHostname(hostname);
    if (isLocal) return;

    nextCfg.enableN8N = false;
    nextCfg.n8nLog = false;

    // Keep URL intact for when Offline Mode is disabled again.
    try {
      if (!Array.isArray(nextCfg.__offlineDisabledFeatures)) {
        Object.defineProperty(nextCfg, '__offlineDisabledFeatures', { value: [], enumerable: false });
      }
      nextCfg.__offlineDisabledFeatures.push('webhook');
    } catch {}
  };

  disableNonLocalWebhookIfConfigured();

  // Transcribe: online-only features
  if (panel === 'transcribe') {
    if (nextCfg.engine === 'whisper') {
      throw new Error('Offline Mode is enabled. Whisper API is unavailable while offline.');
    }
    const t = nextCfg.translation;
    if (t && typeof t === 'object' && t.enabled) {
      nextCfg.translation = { ...t, enabled: false };
      try {
        if (!Array.isArray(nextCfg.__offlineDisabledFeatures)) {
          Object.defineProperty(nextCfg, '__offlineDisabledFeatures', { value: [], enumerable: false });
        }
        nextCfg.__offlineDisabledFeatures.push('translation');
      } catch {}
    }
  }

  return nextCfg;
}

const cachedFfmpegVersions = new Map();
const cachedFsTypes = new Map();

async function execFileWithTimeout(command, args, options = {}) {
  const timeoutMs = Number.isFinite(Number(options?.timeout))
    ? Number(options.timeout)
    : EXEC_FILE_TIMEOUT_MS;
  // Override any provided timeout with the computed one (no unused vars → passes eslint recommended).
  return execFileAsync(command, args, { ...(options || {}), timeout: timeoutMs });
}

async function getSmallFileHash(filePath) {
  const data = await fs.promises.readFile(filePath);
  return crypto.createHash('sha1').update(data).digest('hex');
}

async function getCachedFfmpegVersion(ffmpegBinary, { forceRefresh = false } = {}) {
  if (!forceRefresh && cachedFfmpegVersions.has(ffmpegBinary)) {
    return cachedFfmpegVersions.get(ffmpegBinary);
  }
  const fetchPromise = (async () => {
    const { stdout } = await execFileWithTimeout(ffmpegBinary, ['-version'], {
      encoding: 'utf-8', timeout: FFMPEG_VERSION_TIMEOUT_MS
    });
    return stdout;
  })();
  cachedFfmpegVersions.set(ffmpegBinary, fetchPromise);
  try {
    const version = await fetchPromise;
    cachedFfmpegVersions.set(ffmpegBinary, version);
    return version;
  } catch (err) {
    cachedFfmpegVersions.delete(ffmpegBinary);
    throw err;
  }
}

async function getCachedFsType(p) {
  if (!p) return 'unknown';
  if (cachedFsTypes.has(p)) {
    return cachedFsTypes.get(p);
  }
  const fetchPromise = (async () => {
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await execFileWithTimeout('stat', ['-f', '%T', p], { encoding: 'utf8' });
        return stdout.trim().toLowerCase() || 'unknown';
      }
      if (process.platform === 'linux') {
        const { stdout } = await execFileWithTimeout('stat', ['-f', '-c', '%T', p], { encoding: 'utf8' });
        return stdout.trim().toLowerCase() || 'unknown';
      }
    } catch {
      // ignore
    }
    return 'unknown';
  })();
  cachedFsTypes.set(p, fetchPromise);
  try {
    const fsType = await fetchPromise;
    cachedFsTypes.set(p, fsType);
    return fsType;
  } catch (err) {
    cachedFsTypes.delete(p);
    throw err;
  }
}

// Atomic JSON writer for sensitive config (bridge token)
async function atomicWriteJson(filePath, obj) {
  await atomicWriteJsonSafe(filePath, obj, { mode: 0o600 });
}
// Delay loading modules that may touch V8 or native code until after app.whenReady
let waitForStableFile;
let getAllFilesRecursively;
let detectBestGPUEncoder;
let chokidar;
let runIngest;
let cancelIngest;
let validateIngestConfig;
let runTranscode;
let cancelTranscode;
let runTranscribe;
let cancelTranscribe;
let cancelClone;
let archivePanelSessionLog;
let PQueue;
let runAdobeUtilities;
let cancelAdobeUtilities;
let validateAdobeConfig;
let bridgeToken;
let startupHealth = buildStartupHealth();
const pendingStartupStatusPayloads = [];

// Ensure production environment when packaged
if (isPackaged) {
  process.env.NODE_ENV = 'production';
}

// Licensing:
// No free tier. Users either have an ACTIVE entitlement (Pro/Enterprise) or an
// active TRIAL. When LOCKED, only minimal recovery surfaces remain available.
// Premium work is denied at execution boundaries (IPC + queue contracts).

// Debug flag to toggle verbose logging
const DEBUG_LOGS = process.env.DEBUG_LOGS === 'true';

// Paths populated once Electron is ready
let userDataDir;
let logsDir;
let configDir;
let defaultConfigDir;
let defaultState;
let userState;
let JOB_FILE;
let watchSessionLogs = {};
let watchSessionLogWriters = {};
let watchPanelConfigs = {}; // last panelConfig used for watch mode (per panel)


// Resolve FFmpeg/FFprobe through the shared bridge so every module stays in sync
const { ffmpegPath, ffprobePath } = getBinaryPaths();
ffmpegCaps.configure({ ffmpegPath });
// Startup FFmpeg status: if false, disable transcode/transcribe queue contracts with a clean error.
let ffmpegStartupOk = true;
let ffmpegStartupError = '';
if (!isPackaged) {
  try {
    fs.statSync(ffmpegPath);
    fs.statSync(ffprobePath);
  } catch (err) {
    console.error('❌ FFmpeg or FFprobe not found:', err);
  }
}

function listAvailableEncoders() {
  try {
    const encoders = ffmpegCaps.listEncoders({ type: 'video' });
    const gpuEncoders = encoders.filter(e => e.hwAccel);
    if (DEBUG_LOGS) {
      console.log('Available GPU encoders:', gpuEncoders.map(e => e.name).join(', '));
    }
  } catch (err) {
    console.error('⚠️ Failed to list encoders:', err.message);
  }
}

const preloadPath = path.join(__dirname, 'preload.js');

ipcMain.handle('shell:show-item-in-folder', async (event, absPath) => {
  try {
    assertTrustedIpcSender(event, 'shell:show-item-in-folder');

    if (typeof absPath !== 'string') return false;
    const localPath = toLocalPathIfFileUrl(absPath);
    if (typeof localPath !== 'string') return false;

    const trimmedPath = localPath.trim();
    if (!trimmedPath || !path.isAbsolute(trimmedPath)) return false;

    const approvedPath = assertApprovedPath(event?.sender?.id, trimmedPath);
    if (!approvedPath) return false;

    shell.showItemInFolder(approvedPath);
    return true;
  } catch {
    return false;
  }
});

// ---- Global Electron hardening (applies to ALL webContents) ----
// We keep per-window guards too, but this prevents regressions when new windows
// are added later (plugins, popouts, tests).

function installCspResponseHeaders() {
  try {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = { ...(details.responseHeaders || {}) };

      responseHeaders['Content-Security-Policy'] = [APP_CONTENT_SECURITY_POLICY];

      callback({ responseHeaders });
    });
  } catch (err) {
    console.warn('⚠️ CSP header setup failed (best-effort):', err?.message || String(err));
  }
}

function installGlobalElectronHardening() {
  // Deny dangerous/irrelevant permission requests by default.
  // Allow only the minimum you actually need for UI ergonomics.
  try {
    const ALLOW_PERMISSIONS = new Set([
      // Enables navigator.clipboard.writeText in modern browsers without opening
      // up broader permission surfaces.
      'clipboard-sanitized-write'
    ]);

    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(ALLOW_PERMISSIONS.has(permission));
    });

    // Some Chromium paths call permission checks without a request callback.
    if (typeof session.defaultSession.setPermissionCheckHandler === 'function') {
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
        return ALLOW_PERMISSIONS.has(permission);
      });
    }
  } catch (err) {
    console.warn('⚠️ Permission handler setup failed (best-effort):', err?.message || String(err));
  }

  // Block <webview> attachment entirely. You do not use it, and it's a common
  // footgun for privilege inheritance.
  app.on('web-contents-created', (_event, contents) => {
    try {
      contents.on('will-attach-webview', (event) => {
        event.preventDefault();
      });
    } catch {
      // ignore
    }

    // Ensure every webContents gets your external navigation guard.
    // This is idempotent inside installExternalNavigationGuards().
    try {
      installExternalNavigationGuards(contents, { isOfflineModeEnabled });
    } catch {
      // ignore
    }

    // Optional diagnostic: if a window is created without sandbox in production,
    // shout loudly in logs. (Does not crash.)
    try {
      const prefs = typeof contents.getLastWebPreferences === 'function'
        ? contents.getLastWebPreferences()
        : null;
      if (isPackaged && prefs && prefs.sandbox === false) {
        console.error('❌ SECURITY: webContents created without sandbox=true');
      }
    } catch {
      // ignore
    }
  });
}


function migrateLegacyUserDataArtifacts(canonicalUserDataPath) {
  // One-time cleanup/migration:
  // Some older builds could accidentally create a second userData folder derived from the branded app name
  // ("LEAD AE – ASSIST") and write a few cache/temp artifacts there.
  // We keep the branding name for window titles, but all on-disk storage must live under LeadAEAssist.
  try {
    const base = platformPaths.getAppDataBase();
    const legacyRoots = [
      'LEAD AE – ASSIST', // en-dash variant
      'LEAD AE - ASSIST'  // hyphen variant
    ];

    const readJsonSafe = (p) => {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        return null;
      }
    };

    const writeJsonSafe = (p, obj) => {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
        return true;
      } catch {
        return false;
      }
    };

    const mergeByTimestamp = (dstObj, srcObj) => {
      const out = { ...(dstObj || {}) };
      const src = srcObj || {};
      for (const [k, v] of Object.entries(src)) {
        if (!out[k]) {
          out[k] = v;
          continue;
        }
        const a = out[k];
        const ta = (a && typeof a === 'object') ? Number(a.timestamp) : NaN;
        const tb = (v && typeof v === 'object') ? Number(v.timestamp) : NaN;
        if (Number.isFinite(tb) && Number.isFinite(ta)) {
          if (tb > ta) out[k] = v;
        } else {
          // Prefer existing destination when timestamps are unavailable.
          // (Avoid surprising overrides.)
        }
      }
      return out;
    };

    const migrateJsonFile = (legacyPath, destPath, { merge } = {}) => {
      try {
        if (!fs.existsSync(legacyPath)) return false;

        // If destination doesn't exist, prefer a fast move.
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          try {
            fs.renameSync(legacyPath, destPath);
            return true;
          } catch {
            // Fall back to copy+delete.
            const srcObj = readJsonSafe(legacyPath);
            if (srcObj && writeJsonSafe(destPath, srcObj)) {
              try { fs.unlinkSync(legacyPath); } catch {}
              return true;
            }
            return false;
          }
        }

        // Destination exists: merge.
        const dstObj = readJsonSafe(destPath) || {};
        const srcObj = readJsonSafe(legacyPath) || {};
        const merged = typeof merge === 'function' ? merge(dstObj, srcObj) : { ...dstObj, ...srcObj };
        if (writeJsonSafe(destPath, merged)) {
          try { fs.unlinkSync(legacyPath); } catch {}
          return true;
        }
      } catch {
        // ignore
      }
      return false;
    };

    const pruneUpIfEmpty = (dir, stopAt) => {
      try {
        let cur = dir;
        while (cur && cur.startsWith(stopAt)) {
          try {
            const entries = fs.readdirSync(cur);
            if (entries.length > 0) break;
            fs.rmdirSync(cur);
          } catch {
            break;
          }
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      } catch {
        // ignore
      }
    };

    for (const legacyName of legacyRoots) {
      const legacyRoot = path.join(base, legacyName);
      if (!fs.existsSync(legacyRoot)) continue;

      // cache/watch/processed.json (watch registry)
      const legacyProcessed = path.join(legacyRoot, 'cache', 'watch', 'processed.json');
      const destProcessed = path.join(canonicalUserDataPath, 'cache', 'watch', 'processed.json');
      const movedProcessed = migrateJsonFile(legacyProcessed, destProcessed, { merge: mergeByTimestamp });

      // logs/hash-cache.json (legacy hash cache) -> config/cache/hash-cache.json
      const legacyHashCache = path.join(legacyRoot, 'logs', 'hash-cache.json');
      const destHashCache = path.join(canonicalUserDataPath, 'config', 'cache', 'hash-cache.json');
      const movedHashCache = migrateJsonFile(legacyHashCache, destHashCache);

      const legacyHashCacheBak = path.join(legacyRoot, 'logs', 'hash-cache.json.bak');
      const destHashCacheBak = path.join(canonicalUserDataPath, 'config', 'cache', 'hash-cache.json.bak');
      migrateJsonFile(legacyHashCacheBak, destHashCacheBak);

      if (movedProcessed || movedHashCache) {
        console.log('🧹 Migrated legacy app data from:', legacyRoot);
      }

      // Prune empty directories we touched.
      pruneUpIfEmpty(path.join(legacyRoot, 'cache', 'watch'), legacyRoot);
      pruneUpIfEmpty(path.join(legacyRoot, 'cache'), legacyRoot);
      pruneUpIfEmpty(path.join(legacyRoot, 'logs'), legacyRoot);
      pruneUpIfEmpty(legacyRoot, legacyRoot);
    }

// Also prune empty transcribe job folders in the canonical temp dir (older builds left these behind).
try {
  const transcribeTempRoot = path.join(canonicalUserDataPath, 'temp', 'transcribe');
  if (fs.existsSync(transcribeTempRoot)) {
    for (const name of fs.readdirSync(transcribeTempRoot)) {
      const p = path.join(transcribeTempRoot, name);
      try {
        const st = fs.statSync(p);
        if (!st.isDirectory()) continue;
        const entries = fs.readdirSync(p);
        if (entries.length === 0) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  }
} catch {
  // ignore
}

  } catch (err) {
    console.warn('⚠️ Legacy user data migration skipped:', err?.message || String(err));
  }
}

app.setName('LEAD AE – ASSIST');
// NOTE: Renderer sandbox is enabled. Preload must remain sandbox-safe:
// no Node.js built-ins (e.g. require('path'), 'fs', etc.) and no local CommonJS requires.

const USER_DATA_DIR_NAME = 'LeadAEAssist';
const userDataSupportPath = platformPaths.getUserDataRoot(USER_DATA_DIR_NAME);
platformPaths.ensureDirSync(userDataSupportPath);
app.setPath('userData', userDataSupportPath);
process.env.USER_DATA_PATH = userDataSupportPath; // expose canonical path to preload/renderer

// One-time migration: consolidate legacy on-disk artifacts into LeadAEAssist.
migrateLegacyUserDataArtifacts(userDataSupportPath);

// True Offline Mode network gate (main-process boundary).
// - Blocks Node http/https + global fetch in main process.
// - Renderer network is gated after app.whenReady via webRequest.
installNodeOfflineNetworkGate();

registerGlobalErrorHandlers({
  telemetry: telemetryService,
  sendLog: ({ level, kind, fatal, message, error }) => {
    const prefix = fatal ? 'Critical runtime failure' : 'Unhandled runtime issue';
    const detail = error?.stack ? String(error.stack) : '';
    sendLogMessage('system', `${prefix} (${kind}): ${message}`, detail, fatal, '', level, '', 'runtime');
    try {
      if (fatal) console.error('❌ [runtime-fatal]', kind, error);
      else console.warn('⚠️ [runtime]', kind, error);
    } catch (err) {
      warnFallback('runtime.send-log.console', err?.message || err);
    }
  },
  sendStatus: (payload) => {
    try {
      if (global.mainWindow && !global.mainWindow.isDestroyed()) {
        global.mainWindow.webContents.send('app-runtime-status', { ...payload, timestamp: Date.now() });
      }
    } catch (err) {
      warnFallback('startup.status.send-failed', err?.message || err);
    }
  },
  onFatal: () => {
    try {
      const msg = 'A critical runtime error occurred and the app must close.';
      if (app.isReady()) dialog.showErrorBox('LEAD AE – ASSIST', msg);
    } catch (err) {
      warnFallback('runtime.fatal.dialog-failed', err?.message || err);
    }
    setTimeout(() => {
      try { app.quit(); } catch (err) {
        warnFallback('runtime.fatal.quit-failed', err?.message || err);
      }
    }, 50);
  }
});

// Initialize crash/error reporting as early as possible.
// (Requires USER_DATA_PATH for preference/config lookup.)
try {
  telemetryService.init({ appRootDir: __dirname, isPackaged });
} catch (err) {
  // Never block startup for telemetry.
  const message = err?.message || String(err);
  try {
    console.warn('⚠️ Telemetry init skipped:', message);
    telemetryService.captureMessage?.('Telemetry init skipped', {
      level: 'warning',
      tags: { scope: 'startup', subsystem: 'telemetry' },
      extra: { message },
      dedupeKey: 'startup:telemetry:init-skipped',
      dedupeWindowMs: 5 * 60 * 1000
    });
  } catch {}
}

const log = console;

const ipcContext = {
  startWatchFolder: config => startWatchFolder(config),
  stopWatchFolder: panel => stopWatchFolder(panel),
  getBridgeToken: () => bridgeToken,
  handleUICollapse: collapsed => handleUICollapse(collapsed),
  getStartupHealth: () => ({ ...startupHealth })
};

registerIpcHandlers(ipcMain, ipcContext);

// Help window can be opened from renderer contexts (future: contextual help buttons).
// Keep it tightly scoped to trusted senders.
ipcMain.handle('help:open', async (event, route = '/') => {
  assertTrustedIpcSender(event, 'help:open');
  await openHelp(route);
  return { ok: true };
});

function isExecTimeout(err) {
  if (!err) return false;
  if (err.code === 'ETIMEDOUT') return true;
  const msg = String(err.message || '');
  return /timed out/i.test(msg);
}

async function checkFFmpegCompliance(ffmpegBinary) {
  try {
    const args = ['-version'];
    if (isPackaged) {
      console.log('[DEBUG - packaged]', ffmpegBinary, args);
    }
    console.log('[LeadAE Transcode]', ffmpegBinary, args);

    const version = await getCachedFfmpegVersion(ffmpegBinary);
    console.log('[FFmpeg exited]', 0);
    const config = version.split('\n').find(line => line.startsWith('configuration:')) || '';

    if (config.includes('--enable-gpl') || config.includes('--enable-nonfree')) {
      throw new Error('🚨 FFmpeg build is not LGPL-compliant. GPL flags detected.');
    }

    ffmpegStartupOk = true;
    ffmpegStartupError = '';
    log.info('✅ FFmpeg is LGPL-safe.');
  } catch (caughtErr) {
    let err = caughtErr;
    // Timeout is not a reliable signal that FFmpeg is broken; it's often just slow process spawn.
    // Treat as "unknown", do NOT kill the app or disable features.
    if (isExecTimeout(err)) {
      ffmpegStartupOk = true;
      ffmpegStartupError = `FFmpeg compliance check timed out after ${FFMPEG_VERSION_TIMEOUT_MS}ms (continuing).`;
      console.warn(`⚠️ ${ffmpegStartupError}`);
      telemetryService.captureMessage?.(ffmpegStartupError, {
        level: 'warning',
        tags: { scope: 'startup', subsystem: 'ffmpeg', reason: 'compliance-timeout' },
        extra: { ffmpegBinary, timeoutMs: FFMPEG_VERSION_TIMEOUT_MS },
        dedupeKey: 'startup:ffmpeg:compliance-timeout',
        dedupeWindowMs: 5 * 60 * 1000
      });
      return;
    }

    // macOS Gatekeeper frequently kills quarantined binaries, which bubbles up as:
    // status: null, signal: SIGKILL, stdout/stderr empty.
    if (process.platform === 'darwin' && looksLikeGatekeeperKill(err)) {
      // In dev builds we can often fix this automatically by clearing quarantine.
      if (!isPackaged) {
        try {
          preflightFfmpegBinaries({ ffmpegPath, ffprobePath, isPackaged });
          const version = await getCachedFfmpegVersion(ffmpegBinary, { forceRefresh: true });
          const config =
            version.split('\n').find(line => line.startsWith('configuration:')) || '';
          if (config.includes('--enable-gpl') || config.includes('--enable-nonfree')) {
            throw new Error('🚨 FFmpeg build is not LGPL-compliant. GPL flags detected.');
          }
          ffmpegStartupOk = true;
          ffmpegStartupError = '';
          log.info('✅ FFmpeg is LGPL-safe.');
          return;
        } catch (retryErr) {
          err = retryErr;
        }
      }

      ffmpegStartupOk = false;
      ffmpegStartupError = err?.message || String(err);

      const title = 'FFmpeg Blocked by macOS Gatekeeper';
      const message = 'macOS blocked the bundled FFmpeg helper (Gatekeeper / quarantine).';
      const detail =
        `This is an OS-level block, not a codec/encoder issue.

` +
        `DEV fix (run once):
` +
        `  xattr -dr com.apple.quarantine "${ffmpegBinary}"
` +
        `  xattr -dr com.apple.quarantine "${ffprobePath}"

` +
        `RELEASE fix: the app (including FFmpeg/FFprobe) must be codesigned AND notarized.

` +
        `Binary: ${ffmpegBinary}
` +
        `Error: ${ffmpegStartupError}`;

      log.error(`❌ FFmpeg blocked by macOS Gatekeeper: ${err?.message || err}`);
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title,
        message,
        detail,
        buttons: ['Quit', 'Continue (limited mode)'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (response === 1) return;
      app.quit();
      return;
    }

    // Non-Gatekeeper errors: surface details clearly.
    const detail = err?.message || String(err);
    ffmpegStartupOk = false;
    ffmpegStartupError = detail;
    log.error(`❌ FFmpeg compliance check failed: ${detail}`);
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'FFmpeg Startup Error',
      message: 'FFmpeg failed to run during startup. Transcode/Transcribe will be unavailable until this is fixed.',
      detail: `Binary: ${ffmpegBinary}\n\n${detail}`,
      buttons: ['Quit', 'Continue (limited mode)'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (response === 1) return;
    app.quit();
  }
}


let mainWindow;
let helpWindow;
let queue;
let lastExpandedSize = [1200, 800]; // remember expanded size
let firstPanelOpen = true; // track if first main panel has been opened
let uiCollapsed = null; // track collapsed/expanded state (null = unknown)
let uiCollapseNonce = 0; // prevents stale async collapse calls from winning
const SIDEBAR_WIDTH = 230;

const ADOBE_LOG_MAX_LINES = 200;

// -----------------------------------------------------------------------------
// Help system (Phase B)
// -----------------------------------------------------------------------------

function normalizeHelpRoute(route) {
  const raw = String(route || '').trim();
  if (!raw) return '/';
  let r = raw;
  if (!r.startsWith('/')) r = `/${r}`;
  r = r.replace(/\/+/g, '/');
  if (!r.endsWith('/')) r += '/';
  return r;
}

function getHelpBundleRoot() {
  // In dev: <repo>/resources/help
  // In packaged: <app.asar>/resources/help
  return path.join(app.getAppPath(), 'resources', 'help');
}

function getHelpIndexPath() {
  return path.join(getHelpBundleRoot(), 'index.html');
}

function getHelpManifestPath() {
  return path.join(getHelpBundleRoot(), '_meta', 'help-manifest.json');
}

function readHelpManifestSafe() {
  try {
    const manifestPath = getHelpManifestPath();
    if (!fs.existsSync(manifestPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function openHelp(route = '/') {
  const indexPath = getHelpIndexPath();
  if (!fs.existsSync(indexPath)) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Help content missing',
      message: 'The offline help bundle is not available in this build.',
      detail: `Expected: ${indexPath}\n\nIf you are running from source, run: npm run build:help`,
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    });
    return;
  }

  const r = normalizeHelpRoute(route);

  // If the window exists, focus + navigate without a full reload.
  if (helpWindow && !helpWindow.isDestroyed()) {
    try {
      helpWindow.show();
      helpWindow.focus();
      await helpWindow.webContents.executeJavaScript(
        `try { window.location.hash = ${JSON.stringify(r)}; } catch {}`,
        true
      );
      return;
    } catch {
      // If navigation injection fails (rare), fall back to reload.
      try {
        await helpWindow.loadFile(indexPath, { hash: r, query: { v: app.getVersion() } });
        return;
      } catch {
        // continue to recreate the window
      }
    }
  }

  // Create help window
  helpWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    title: 'Lead AE Assist Help',
    backgroundColor: '#0f1115',
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    show: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: allowDevTools
    }
  });

  helpWindow.on('closed', () => {
    helpWindow = null;
  });

  // Best-effort: open external links in default browser.
  try {
    installExternalNavigationGuards(helpWindow.webContents, { isOfflineModeEnabled });
  } catch {
    // ignore
  }

  await helpWindow.loadFile(indexPath, {
    hash: r,
    query: { v: app.getVersion() }
  });
}

function openLogsFolder() {
  try {
    const logsDir = platformPaths.getLogsDir();
    platformPaths.ensureDirSync(logsDir);
    shell.openPath(logsDir);
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Open Logs Folder failed',
      message: 'Could not open the logs folder.',
      detail: err?.message || String(err),
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    });
  }
}

function buildAppMenuTemplate() {
  const manifest = readHelpManifestSafe();
  const helpMenuRoutes = manifest?.helpMenuRoutes || {};
  const quickLinks = manifest?.quickLinks || {};

  const helpSubmenu = [
    {
      label: 'Help Home',
      accelerator: 'F1',
      click: () => openHelp(helpMenuRoutes.userGuide || '/')
    },
    {
      label: 'Search Help',
      accelerator: 'CmdOrCtrl+Shift+F',
      click: () => openHelp(helpMenuRoutes.search || '/search/')
    },
    {
      label: 'License Information',
      click: () => openHelp(
        helpMenuRoutes.licenseInformation ||
        quickLinks.licenseInformation ||
        '/reference/license-information/'
      )
    },
    { type: 'separator' },
    {
      label: 'Troubleshooting',
      click: () => openHelp(helpMenuRoutes.troubleshooting || '/troubleshooting/')
    },
    {
      label: 'Logs and support bundle',
      click: () => openHelp(helpMenuRoutes.logs || quickLinks.logsAndSupport || '/reference/logs-and-support-bundle/')
    },
    {
      label: 'Panel Guides',
      click: () => openHelp(helpMenuRoutes.panelGuides || quickLinks.panelGuides || '/panels/')
    },
    { type: 'separator' },
    {
      label: 'Open Logs Folder',
      click: () => openLogsFolder()
    }
  ];

  if (process.platform === 'darwin') {
    const template = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          ...(allowDevTools
            ? [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' }
              ]
            : []),
          { role: 'togglefullscreen' }
        ]
      },
      {
        label: 'Window',
        role: 'window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      },
      {
        role: 'help',
        submenu: helpSubmenu
      }
    ];
    return template;
  }

  // Windows/Linux: keep it minimal (and avoid stomping on the app UI).
  return [
    {
      label: 'Help',
      submenu: helpSubmenu
    }
  ];
}

function applyAppMenu() {
  try {
    const template = buildAppMenuTemplate();
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  } catch (err) {
    console.warn('⚠️ Failed to build application menu:', err?.message || String(err));
  }
}

function sanitizeForIPC(value, seen = new WeakSet()) {
  const t = typeof value;
  if (value === null) return null;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return undefined;
  if (t !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .map(v => sanitizeForIPC(v, seen))
      .filter(v => v !== undefined);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const sv = sanitizeForIPC(v, seen);
    if (sv !== undefined) out[k] = sv;
  }
  return out;
}

function summarizeLogForIPC(logLines) {
  if (!Array.isArray(logLines)) return { log: undefined };
  if (logLines.length <= ADOBE_LOG_MAX_LINES) {
    return { log: logLines };
  }
  const headCount = Math.ceil(ADOBE_LOG_MAX_LINES / 2);
  const tailCount = Math.floor(ADOBE_LOG_MAX_LINES / 2);
  const omittedCount = logLines.length - headCount - tailCount;
  const summary = [
    ...logLines.slice(0, headCount),
    `… ${omittedCount} lines omitted …`,
    ...logLines.slice(-tailCount)
  ];
  return { log: summary, logTruncated: true };
}

function buildResultForIPC(job) {
  const result = job?.result;
  if (!result || typeof result !== 'object') return result;

  if (job.panel === 'adobe-utilities') {
    return { ...result, ...summarizeLogForIPC(result.log) };
  }

  return { ...result, log: undefined };
}

function buildQueueErrorForIPC(error) {
  if (!error || typeof error !== 'object') {
    return {
      message: typeof error === 'string' && error.trim() ? error.trim() : 'Job failed',
      stack: undefined,
      code: undefined,
      name: 'Error',
      details: undefined
    };
  }

  const safeMessage =
    typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : 'Job failed';

  return sanitizeForIPC({
    message: safeMessage,
    stack: typeof error.stack === 'string' ? error.stack : undefined,
    code: error.code != null ? String(error.code) : undefined,
    name:
      typeof error.name === 'string' && error.name.trim()
        ? error.name.trim()
        : 'Error',
    details: error.details
  });
}

function cleanupQueueAndJobs() {
  try {
    if (queue && typeof queue.drainAll === 'function') {
      queue.drainAll();
    }
  } catch (err) {
    console.error('Failed to drain queue during shutdown:', err);
  }

  if (JOB_FILE) {
    try {
      if (fs.existsSync(JOB_FILE)) {
        fs.unlinkSync(JOB_FILE);
      }
    } catch (err) {
      console.error('Failed to remove job file during shutdown:', err);
    }
  }
}

app.on('before-quit', cleanupQueueAndJobs);

function formatCrashReport(kind, error) {
  const message = error?.message || String(error || 'Unknown error');
  const stack = error?.stack ? String(error.stack) : '';
  return [
    `timestamp=${new Date().toISOString()}`,
    `kind=${kind}`,
    `message=${message}`,
    '',
    'stack:',
    stack || '(no stack)'
  ].join('\n');
}

function writeCrashReport(kind, error) {
  try {
    const baseDir = logsDir || path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(baseDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `crash-${kind}-${stamp}.log`;
    const filePath = path.join(baseDir, fileName);
    fs.writeFileSync(filePath, formatCrashReport(kind, error), 'utf8');
    return filePath;
  } catch (err) {
    console.warn('⚠️ Failed to write crash report:', err?.message || err);
    return null;
  }
}

function haltInFlightJobs(reason) {
  const jobIds = [];
  if (!queue || !queue.inProgress) return jobIds;
  try {
    queue.pauseQueue?.();
  } catch {}
  try {
    if (Array.isArray(queue.pending)) queue.pending = [];
  } catch {}
  const inFlightIds = Array.from(queue.inProgress.keys());
  for (const id of inFlightIds) {
    jobIds.push(id);
    try {
      const job = queue.inProgress.get(id);
      const contract = job?.panel && typeof queue.getContract === 'function'
        ? queue.getContract(job.panel)
        : null;
      if (contract?.cancel) contract.cancel(id);
    } catch {}
    try {
      queue.failJob(id, new Error(reason));
    } catch (err) {
      console.warn('⚠️ Failed to mark job as failed:', id, err?.message || err);
    }
  }
  try {
    queue.emit('queue-fatal', { reason, jobIds, timestamp: Date.now() });
  } catch {}
  return jobIds;
}

function notifyCriticalError(kind, error, jobIds = []) {
  const message = error?.message || 'A critical error occurred. Jobs were halted.';
  try {
    sendLogMessage(
      'system',
      `❌ Critical error (${kind}): ${message}`,
      error?.stack ? String(error.stack) : '',
      true,
      '',
      'error',
      '',
      'runtime'
    );
  } catch {}
  try {
    safeSend('queue-fatal', { kind, message, jobIds, timestamp: Date.now() });
    safeSend('app-critical-error', { kind, message, jobIds, timestamp: Date.now() });
  } catch {}
}

function installProcessCrashHandlers() {
  if (process.__leadProcessCrashHandlersInstalled) return;
  process.__leadProcessCrashHandlersInstalled = true;

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const CRASH_CLEANUP_TIMEOUT_MS = 10000;
  const CRASH_POLL_INTERVAL_MS = 200;

  const snapshotInFlightJobs = () => {
    if (!queue?.inProgress) return [];
    return Array.from(queue.inProgress.values()).map(job => ({
      id: job?.id,
      panel: job?.panel,
      config: job?.config
    }));
  };

  const getTranscodeProcesses = (jobIds) => {
    try {
      const { jobProcesses } = require('./modules/transcode');
      if (!jobProcesses || typeof jobProcesses.get !== 'function') return new Set();
      const procs = new Set();
      for (const id of jobIds) {
        const set = jobProcesses.get(id);
        if (!set) continue;
        for (const proc of set) {
          if (proc) procs.add(proc);
        }
      }
      return procs;
    } catch {
      return new Set();
    }
  };

  const waitForJobCancellation = async (jobIds, deadlineMs) => {
    if (!queue?.inProgress || jobIds.length === 0) return { complete: true, pending: [] };
    while (Date.now() < deadlineMs) {
      const pending = jobIds.filter(id => queue.inProgress.has(id));
      if (pending.length === 0) return { complete: true, pending: [] };
      await delay(CRASH_POLL_INTERVAL_MS);
    }
    return { complete: false, pending: jobIds.filter(id => queue.inProgress.has(id)) };
  };

  const ensureChildProcessesTerminated = async (jobIds, deadlineMs) => {
    const procs = getTranscodeProcesses(jobIds);
    if (procs.size === 0) return { complete: true, forced: 0 };
    for (const proc of procs) {
      if (!proc || proc.killed) continue;
      try {
        proc.kill('SIGTERM');
      } catch {}
    }
    while (Date.now() < deadlineMs) {
      let hasLive = false;
      for (const proc of procs) {
        if (!proc) continue;
        if (proc.exitCode == null && !proc.killed) {
          hasLive = true;
          break;
        }
      }
      if (!hasLive) return { complete: true, forced: 0 };
      await delay(CRASH_POLL_INTERVAL_MS);
    }
    let forced = 0;
    for (const proc of procs) {
      if (!proc) continue;
      if (proc.exitCode == null && !proc.killed) {
        forced += 1;
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
    }
    return { complete: false, forced };
  };

  const flushCrashState = async () => {
    try {
      for (const panelKey of Object.keys(watchSessionLogWriters)) {
        try {
          watchSessionLogWriters[panelKey]?.close();
        } catch {}
      }
    } catch {}
    try {
      if (typeof archivePanelSessionLog === 'function') {
        for (const panelKey of Object.keys(watchSessionLogs)) {
          try {
            archivePanelSessionLog(watchSessionLogs[panelKey], panelKey);
          } catch {}
        }
      }
    } catch {}
    try {
      if (typeof flushSharedWatchRegistrySave === 'function') {
        await flushSharedWatchRegistrySave();
      }
    } catch {}
  };

  const handleCrash = async (kind, error) => {
    if (process.__leadProcessCrashHandling) return;
    process.__leadProcessCrashHandling = true;

    const err = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
    const reason = `Job halted due to ${kind}: ${err.message || 'Unknown error'}`;
    const inFlightJobs = snapshotInFlightJobs();
    const jobIds = haltInFlightJobs(reason);
    const crashPath = writeCrashReport(kind, err);
    notifyCriticalError(kind, err, jobIds);

    try {
      if (crashPath) {
        console.error(`❌ Critical error (${kind}). Crash report: ${crashPath}`);
      } else {
        console.error(`❌ Critical error (${kind}).`);
      }
      console.error(err?.stack || err);
    } catch {}

    try {
      if (app.isReady()) {
        dialog.showErrorBox(
          'Critical Error',
          'A critical error occurred and jobs were halted. The app will now close.'
        );
      }
    } catch {}

    const cleanupDeadline = Date.now() + CRASH_CLEANUP_TIMEOUT_MS;
    try {
      for (const job of inFlightJobs) {
        if (job?.config?.cloneMode && typeof cancelClone === 'function') {
          try { cancelClone(job.id); } catch {}
        }
      }
    } catch {}

    try {
      await waitForJobCancellation(jobIds, cleanupDeadline);
    } catch {}

    try {
      await ensureChildProcessesTerminated(jobIds, cleanupDeadline);
    } catch {}

    try {
      await flushCrashState();
    } catch {}

    try { app.quit(); } catch {}
    setTimeout(() => {
      try { process.exit(1); } catch {}
    }, 500);
  };

  process.on('uncaughtException', (error) => { void handleCrash('uncaughtException', error); });
  // Do not hard-crash on every unhandled rejection here.
  // Updater apply failures on macOS surface as promise rejections from ShipIt/
  // Squirrel.Mac and should be handled as updater errors, not fatal process crashes.
}

installProcessCrashHandlers();

function safeSend(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch (err) {
    try {
      const sanitized = sanitizeForIPC(payload);
      mainWindow.webContents.send(channel, sanitized);
    } catch (err2) {
      console.error(
        `❌ safeSend failed for "${channel}" (original + sanitized).`,
        err?.message || err,
        err2?.message || err2
      );
    }
  }
}

function emitStartupRuntimeStatus(payload) {
  const runtimePayload = { ...payload, timestamp: Date.now() };
  pendingStartupStatusPayloads.push(runtimePayload);
  safeSend('app-runtime-status', runtimePayload);
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: SIDEBAR_WIDTH,
    height: 800,
    minWidth: SIDEBAR_WIDTH,
    maxWidth: SIDEBAR_WIDTH,
    minHeight: 400,
    maxHeight: 10000,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      // Preload exposes required APIs, so disable Node integration
      nodeIntegration: false,
      // Isolate context for improved security
      contextIsolation: true,
      // Renderer sandbox ON (preload is sandbox-safe; no Node built-ins).
      sandbox: true,
      // Explicitly disable <webview> (not used; reduces attack surface)
      webviewTag: false,
      // Ensure no Node integration in subframes (defense-in-depth)
      nodeIntegrationInSubFrames: false,
      // Legacy flag (ignored on newer Electron) but harmless
      enableRemoteModule: false,
      webSecurity: true,
      devTools: allowDevTools,
      preload: preloadPath
    }
  });

  // Security: ensure any attempt to open external links does NOT create a new
  // Electron window (which could inherit preload privileges). Instead, open
  // safe external URLs in the user's default browser.
  installExternalNavigationGuards(mainWindow.webContents, { isOfflineModeEnabled });

  // Hygiene: clear any approved-roots state for this renderer when its
  // webContents is destroyed. Prevents stale sender entries from accumulating.
  try {
    const { resetApproved } = require('./utils/fsAccessControl');
    const senderId = mainWindow.webContents.id;
    mainWindow.webContents.on('destroyed', () => {
      try { resetApproved(senderId); } catch {}
    });
  } catch {
    // best-effort
  }

  // Load the app UI from the app's own directory (absolute path), so navigation
  // guards can safely restrict file:// navigations to the app bundle only.
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setTitle('LEAD AE – ASSIST');
  if (allowDevTools) {
    mainWindow.webContents.openDevTools();
  }
  global.mainWindow = mainWindow; // Allow modules to access main window directly

  mainWindow.on('close', () => {
    cleanupQueueAndJobs();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    try {
      if (fs.existsSync(JOB_FILE)) {
        fs.unlinkSync(JOB_FILE);
      }
    } catch (err) {
      log.error('Failed to remove stale job file on load:', err.message);
    }
    // Optional: run a deterministic Sentry smoke-test (does not ship unless env var is set).
    try {
      const { runTelemetrySelfTest } = require('./utils/telemetrySelfTest');
      runTelemetrySelfTest({ mainWindow, appRootDir: __dirname });
    } catch {
      // ignore
    }

    safeSend('auto-connect-leadae', {});
    if (pendingStartupStatusPayloads.length > 0) {
      for (const payload of pendingStartupStatusPayloads) {
        safeSend('app-runtime-status', payload);
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    global.mainWindow = null;
  });
}


app.whenReady().then(async () => {
  // Security hardening (permissions, webview disable, global navigation guards)
  installGlobalElectronHardening();
  installCspResponseHeaders();
  installRendererOfflineNetworkGate();

  // Preflight FFmpeg/FFprobe early so startup checks don't get killed by Gatekeeper in dev.
  try {
    preflightFfmpegBinaries({ ffmpegPath, ffprobePath, isPackaged });
  } catch {
    // best-effort only
  }

  try {
    const bootstrap = await loadStartupDependencies({
      requireFn: require,
      importFn: (specifier) => import(specifier),
      cloneCore
    });
    startupHealth = bootstrap.health;

    ({ waitForStableFile, getAllFilesRecursively } = bootstrap.deps);
    ({ detectBestGPUEncoder } = bootstrap.deps);
    ({ chokidar } = bootstrap.deps);
    ({ runIngest, cancelIngest, validateIngestConfig } = bootstrap.deps);
    ({ runTranscode, cancelTranscode } = bootstrap.deps);
    ({ runTranscribe, cancelTranscribe } = bootstrap.deps);
    ({ cancelClone } = bootstrap.deps);
    ({ archivePanelSessionLog } = bootstrap.deps);
    ({ runAdobeUtilities, cancelAdobeUtilities, validateAdobeConfig } = bootstrap.deps);
    ({ PQueue } = bootstrap.deps);

    if (!startupHealth.ok) {
      const details = startupHealth.criticalFailures
        .map(entry => `• ${entry.key}: ${entry.message}`)
        .join('\n');
      console.error('❌ Critical bootstrap dependencies failed:', details);
      dialog.showErrorBox(
        'Startup Error',
        `Critical startup dependencies failed to load. The app cannot continue.\n\n${details}`
      );
      app.quit();
      return;
    }

    if (startupHealth.optionalFailures.length > 0) {
      const optionalSummary = startupHealth.optionalFailures
        .map(entry => `${entry.key}: ${entry.message}`)
        .join(' | ');
      console.warn('⚠️ Optional startup dependencies unavailable:', optionalSummary);
      telemetryService.captureMessage?.('Optional startup dependencies unavailable', {
        level: 'warning',
        tags: { scope: 'startup', subsystem: 'bootstrap', health: 'degraded' },
        extra: { optionalSummary },
        contexts: {
          startupHealth: {
            optionalFailures: startupHealth.optionalFailures
          }
        },
        dedupeKey: `startup:optional-failures:${optionalSummary}`,
        dedupeWindowMs: 2 * 60 * 1000
      });
      sendLogMessage(
        'system',
        '⚠️ Startup degraded mode: optional features are disabled.',
        optionalSummary,
        false,
        '',
        'warn'
      );
    }
  } catch (bootErr) {
    console.error('❌ Startup bootstrap failed:', bootErr);
    dialog.showErrorBox(
      'Startup Error',
      `Failed to initialize startup dependencies.\n\n${bootErr?.message || bootErr}`
    );
    app.quit();
    return;
  }

  // Canonical cross-platform userData directory.
  // macOS:   ~/Library/Application Support/LeadAEAssist
  // Windows: %APPDATA%\LeadAEAssist
  userDataDir = app.getPath('userData');
  process.env.USER_DATA_PATH = userDataDir;
  logsDir = path.join(userDataDir, 'logs');
  configDir = path.join(userDataDir, 'config');

  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
  } catch (err) {
    console.error('❌ Failed to create data directories:', err);
    abortStartupForStorageInitFailure({
      failingPath: err?.path || userDataDir,
      errorCode: err?.code || 'E_STORAGE_INIT',
      message: err?.message || String(err)
    });
    return;
  }

  const dirAccessCheck = verifyRequiredDirectoryReadWriteAccess([logsDir, configDir]);
  if (!dirAccessCheck.ok) {
    console.error('❌ Required directory is not readable/writable:', dirAccessCheck);
    abortStartupForStorageInitFailure({
      failingPath: dirAccessCheck.dirPath,
      errorCode: dirAccessCheck.errorCode || 'E_STORAGE_INIT',
      message: dirAccessCheck.message
    });
    return;
  }

  defaultConfigDir = path.join(app.getAppPath(), 'config');
  defaultState = path.join(defaultConfigDir, 'state.json');
  userState = path.join(configDir, 'state.json');
  if (!fs.existsSync(userState) && fs.existsSync(defaultState)) {
    try {
      fs.copyFileSync(defaultState, userState);
    } catch (err) {
      console.error('❌ Failed to copy default state.json:', err);
    }
  }

  try {
    const state = readState() || {};
    const prefs = (state.preferences && typeof state.preferences === 'object') ? state.preferences : {};
    const tempMaxAgeDays = parseInt(prefs.tempMaxAgeDays, 10);
    const tempFileMaxAgeMs = Number.isFinite(tempMaxAgeDays) && tempMaxAgeDays >= 0
      ? tempMaxAgeDays * 24 * 60 * 60 * 1000
      : undefined;
    const logRetentionDays = Number.parseInt(prefs.logRetentionDays, 10);
    const logRetentionMaxTotalMb = Number.parseFloat(prefs.logRetentionMaxTotalMb);
    const config = {
      clearTempOnStartup: !!prefs.clearTempOnStartup,
      clearCacheOnStartup: !!prefs.clearCacheOnStartup
    };
    if (Number.isFinite(tempFileMaxAgeMs)) {
      config.tempFileMaxAgeMs = tempFileMaxAgeMs;
    }
    if (Number.isFinite(logRetentionDays) && logRetentionDays >= 0) {
      config.logRetentionMaxAgeMs = logRetentionDays * 24 * 60 * 60 * 1000;
    }
    if (Number.isFinite(logRetentionMaxTotalMb) && logRetentionMaxTotalMb >= 0) {
      config.logRetentionMaxTotalBytes = logRetentionMaxTotalMb * 1024 * 1024;
    }
    const result = await runStartupMaintenance({
      app,
      session,
      userDataDir,
      logger: console,
      config
    });
    if (result?.temp?.ok) {
      console.log(`🧹 Temp cleanup: ${result.temp.removedCount || 0} removed, freed ${result.temp.freed || '0 B'}.`);
    }
    if (result?.cache?.ok) {
      console.log(`🧹 Cache cleanup: ${result.cache.removedCount || 0} removed, freed ${result.cache.freed || '0 B'}.`);
    }
    if (result?.logs?.ok) {
      console.log(`🧹 Log cleanup: ${result.logs.removedCount || 0} removed, freed ${result.logs.freed || '0 B'}.`);
    }
  } catch (err) {
    console.warn('⚠️ Startup maintenance skipped:', err?.message || err);
  }

  JOB_FILE = path.join(logsDir, 'job-queue.json');
  try {
    if (fs.existsSync(JOB_FILE)) {
      fs.unlinkSync(JOB_FILE);
    }
  } catch (err) {
    console.error('❌ Failed to clear lingering job queue file:', err);
  }

  const bridgeCredentials = await getCredentials();
  // bridgeCredentials = { ok: true, token, port: 32123, expiresAt } OR { ok: false, ... }

  if (bridgeCredentials && bridgeCredentials.ok === false) {
    bridgeToken = null;
    console.error(
      `❌ Bridge server not ready on port ${bridgeCredentials.port || 32123}: ${bridgeCredentials.error || 'unknown error'}`
    );
  } else {
    const bridgePayload = {
      token: bridgeCredentials.token,
      port: bridgeCredentials.port,
      expiresAt: bridgeCredentials.expiresAt,
      tokenSource: bridgeCredentials.tokenSource,
      baseUrl: `http://127.0.0.1:${bridgeCredentials.port}`
    };

    bridgeToken = bridgeCredentials.token;
    try {
      // Single canonical copy for desktop app + CEP panel (via USER_DATA/SystemPath.USER_DATA)
      const bridgeConfigPath = path.join(configDir, 'bridge.json');
      await atomicWriteJson(bridgeConfigPath, bridgePayload);
    } catch (err) {
      console.error('❌ Failed to write bridge token file:', err);
    }
  }

  if (typeof detectBestGPUEncoder === 'function') {
    global.gpuEncoders = {
      h264: detectBestGPUEncoder('h264', ffmpegPath),
      hevc: detectBestGPUEncoder('hevc', ffmpegPath)
    };
  } else {
    global.gpuEncoders = { h264: null, hevc: null };
    const warnContext = {
      detectBestGPUEncoderType: typeof detectBestGPUEncoder,
      ffmpegPath,
      startupOptionalFailures: startupHealth.optionalFailures || []
    };
    console.warn('⚠️ GPU encoder detection unavailable; running with safe defaults.', warnContext);
    emitStartupRuntimeStatus({
      scope: 'startup',
      subsystem: 'gpu',
      level: 'warning',
      degraded: true,
      code: 'gpu-encoder-detection-unavailable',
      message: 'GPU encoder auto-detection is unavailable. Hardware encoding defaults are disabled for this session.',
      context: warnContext
    });
  }

  // --- SAFEGUARD: prevent crash if validateAdobeConfig wasn't loaded ---
  if (typeof validateAdobeConfig !== 'function') {
    console.warn('⚠️ validateAdobeConfig not defined; using no-op validator');
    validateAdobeConfig = () => true;
  }

  const qmMod = require('./modules/queueManager');
  const QueueManagerCtor =
    qmMod?.QueueManager || qmMod?.default || qmMod;
  if (typeof QueueManagerCtor !== 'function') {
    throw new Error('QueueManager export shape unsupported (need class/function)');
  }

  const deny = (featureKey) => ({
    success: false,
    error: `License required for ${featureKey}`,
    summary: `License required for ${featureKey}`
  });

  const getAdobeUtilitiesUnavailableMessage = () => {
    const startupFailure = (startupHealth?.optionalFailures || []).find(
      entry => entry?.key === 'adobeUtilities'
    );
    const dependencyDetail = startupFailure?.message
      ? ` Startup dependency error: ${startupFailure.message}`
      : '';
    return (
      'Adobe Utilities is unavailable because its startup dependency failed to load. ' +
      'Restart LEAD AE – ASSIST. If the issue persists, reinstall/update and review startup logs.' +
      dependencyDetail
    );
  };

  const isAdobeUtilitiesStartupReady = () => {
    return !(startupHealth?.optionalFailures || []).some(entry => entry?.key === 'adobeUtilities');
  };

  const buildAdobeUtilitiesUnavailableResult = (message) => ({
    success: false,
    error: message,
    summary: message,
    actionableMessage: message,
    log: [message]
  });

  const getIngestStartupUnavailableMessage = () => {
    return getLocalizedMainMessage(
      'ingest.startupDependencyFailed',
      'Ingest is unavailable: startup dependency failed to load.'
    );
  };

  const queueContracts = {
    ingest: {
      validate: (cfg) => {
        if (!startupHealth.ingestReady) {
          return [getIngestStartupUnavailableMessage()];
        }
        return typeof validateIngestConfig === 'function' ? validateIngestConfig(cfg) : [];
      },
      run: async (cfg) => {
        if (!startupHealth.ingestReady || typeof runIngest !== 'function') {
          throw new Error(getIngestStartupUnavailableMessage());
        }
        const isClone = !!cfg?.cloneMode;
        const feature = isClone ? 'clone' : 'ingest';
        if (!licenseService.isFeatureEnabled(feature)) return deny(feature);
        return runIngest(applyOfflineModeRestrictions('ingest', cfg));
      },
      cancel: cancelIngest
    },
    transcode: {
      validate: (cfg) => {
        if (!ffmpegStartupOk) {
          return [`FFmpeg is unavailable: ${ffmpegStartupError || 'startup check failed.'}`];
        }
        if (!Array.isArray(cfg?.inputFiles) || cfg.inputFiles.length === 0) {
          return ['Invalid transcode config: inputFiles must be a non-empty array.'];
        }
        return [];
      },
      run: async (cfg) => {
        if (!ffmpegStartupOk) {
          throw new Error(`FFmpeg is unavailable: ${ffmpegStartupError || 'startup check failed.'}`);
        }
        if (!startupHealth.transcodeReady || typeof runTranscode !== 'function') {
          throw new Error('Transcode is unavailable: startup dependency failed to load.');
        }
        if (!licenseService.isFeatureEnabled('transcode')) return deny('transcode');
        return runTranscode(applyOfflineModeRestrictions('transcode', cfg));
      },
      cancel: cancelTranscode
    },
    transcribe: {
      validate: () => {
        if (!ffmpegStartupOk) {
          return [`FFmpeg is unavailable: ${ffmpegStartupError || 'startup check failed.'}`];
        }
        if (!startupHealth.transcribeReady) {
          return ['Transcribe is unavailable: startup dependency failed to load.'];
        }
        return [];
      },
      run: async (cfg) => {
        if (!ffmpegStartupOk) {
          throw new Error(`FFmpeg is unavailable: ${ffmpegStartupError || 'startup check failed.'}`);
        }
        if (!startupHealth.transcribeReady || typeof runTranscribe !== 'function') {
          throw new Error('Transcribe is unavailable: startup dependency failed to load.');
        }
        if (!licenseService.isFeatureEnabled('transcribe')) return deny('transcribe');
        return runTranscribe(applyOfflineModeRestrictions('transcribe', cfg));
      },
      cancel: cancelTranscribe
    },
    'adobe-utilities': {
      validate: (cfg) => {
        if (!isAdobeUtilitiesStartupReady()) {
          return [getAdobeUtilitiesUnavailableMessage()];
        }
        return typeof validateAdobeConfig === 'function' ? validateAdobeConfig(cfg) : [];
      },
      run: async (cfg) => {
        if (!isAdobeUtilitiesStartupReady() || typeof runAdobeUtilities !== 'function') {
          return buildAdobeUtilitiesUnavailableResult(getAdobeUtilitiesUnavailableMessage());
        }
        if (!licenseService.isFeatureEnabled('adobe-utilities')) return deny('adobe-utilities');
        return runAdobeUtilities(applyOfflineModeRestrictions('adobe-utilities', cfg));
      },
      cancel: cancelAdobeUtilities
    },
    'project-organizer': {
      validate(cfg) {
        const hasCopyPayload =
          cfg && Array.isArray(cfg.sourcePaths) && cfg.sourcePaths.length > 0 && cfg.destRoot;
        const hasOrganizerConfig = cfg?.outputPath && Array.isArray(cfg?.selectedFolders);
        if (hasCopyPayload || hasOrganizerConfig) return [];
        return ['Invalid project-organizer config'];
      },
      run: async (cfg) => {
        if (!licenseService.isFeatureEnabled('project-organizer')) return deny('project-organizer');
        return require('./modules/project-organizer').createProjectStructure(cfg);
      }
    }
  };

  const queueOptions = {
    maxConcurrency: 2,
    panelConcurrency: {
      ingest: 1,
      transcode: 1,
      transcribe: 1,
      'project-organizer': 1
    },
    exclusivePanels: {
      'adobe-utilities': 1
    }
  };

  const hasPrototypeMethods =
    QueueManagerCtor.prototype &&
    Object.getOwnPropertyNames(QueueManagerCtor.prototype).length > 1;

  queue = hasPrototypeMethods
    ? new QueueManagerCtor(queueContracts, queueOptions)
    : QueueManagerCtor(queueContracts, queueOptions);
  global.queue = queue;

  queue.on('job-added', job => {
    safeSend('queue-job-added', job);
  });
  queue.on('job-start', job => {
    safeSend('queue-job-start', job);
    try { logWatchQueueEvent('start', job); } catch {}
  });
  queue.on('job-cancelling', job => {
    safeSend('queue-job-cancelling', job);
    try { logWatchQueueEvent('cancelling', job); } catch {}
  });
  queue.on('job-complete', job => {
    if (mainWindow) {
      const { id, panel, config, status, statusMap } = job;
      const resultForIPC = buildResultForIPC(job);

      safeSend('queue-job-complete', {
        id,
        panel,
        config,
        status,
        statusMap,
        result: resultForIPC
      });
    }
    try { logWatchQueueEvent('complete', job); } catch {}
  });
  queue.on('job-failed', job => {
    const jobForIPC = job && typeof job === 'object' ? { ...job } : job;
    if (jobForIPC && jobForIPC.result && typeof jobForIPC.result === 'object') {
      jobForIPC.result = buildResultForIPC(job);
    } else if (jobForIPC?.panel === 'adobe-utilities') {
      const message =
        typeof jobForIPC?.error?.message === 'string' && jobForIPC.error.message.trim()
          ? jobForIPC.error.message.trim()
          : getAdobeUtilitiesUnavailableMessage();
      jobForIPC.result = buildAdobeUtilitiesUnavailableResult(message);
    }
    if (jobForIPC && typeof jobForIPC === 'object') {
      jobForIPC.error = buildQueueErrorForIPC(jobForIPC.error);
    }
    safeSend('queue-job-failed', sanitizeForIPC(jobForIPC));
    try { logWatchQueueEvent('failed', job); } catch {}
  });
  queue.on('job-cancelled', job => {
    safeSend('queue-job-cancelled', job);
    try { logWatchQueueEvent('cancelled', job); } catch {}
  });
  queue.on('job-progress', data => {
    safeSend('queue-job-progress', data);

    try {
      global.cepBridge?.broadcast({
        type: 'queue-job-progress',
        ...(sanitizeForIPC(data) || {})
      });
    } catch {}
  });

  const cepBridge = await startCEPBridge();

  const buildQueueJobForBridge = job => {
    if (!job || typeof job !== 'object') return job;

    const jobForBridge = {
      id: job.id,
      panel: job.panel,
      config: job.config,
      status: job.status,
      statusMap: job.statusMap,
      result: buildResultForIPC(job)
    };

    if (job.error) {
      jobForBridge.error = buildQueueErrorForIPC(job.error);
    }

    return sanitizeForIPC(jobForBridge);
  };

  // Make the CEP bridge globally accessible so modules can dispatch jobs
  global.cepBridge = cepBridge;

  // Echo connection-state messages back to all clients (Electron UI can see them)
  cepBridge.on('connection-state', msg => {
    try {
      cepBridge.broadcast({
        type: 'connection-state',
        backend: !!msg.backend,
        premiere: !!msg.premiere
      });
    } catch {}
  });

  queue.on('job-added', job => {
    cepBridge.broadcast({ type: 'job-added', job });
  });

  queue.on('job-complete', job => {
    const jobForBridge = buildQueueJobForBridge(job);

    cepBridge.broadcast({
      type: 'queue-job-complete',
      panel: jobForBridge?.panel || job?.panel,
      job: jobForBridge
    });

    // Keep the legacy event for older CEP builds that only listen for job-complete.
    cepBridge.broadcast({ type: 'job-complete', job: jobForBridge });
  });

  queue.on('job-failed', job => {
    cepBridge.broadcast({ type: 'job-failed', job });
  });

  queue.on('job-cancelling', job => {
    cepBridge.broadcast({ type: 'job-cancelling', job });
  });

  queue.on('job-cancelled', job => {
    const jobForBridge = buildQueueJobForBridge(job);

    cepBridge.broadcast({
      type: 'queue-job-cancelled',
      panel: jobForBridge?.panel || job?.panel,
      id: jobForBridge?.id || job?.id,
      job: jobForBridge
    });

    cepBridge.broadcast({ type: 'job-cancelled', job: jobForBridge });
  });

  // Even if the above throws, we still want *a* window so the user sees errors.
  try {
    await checkFFmpegCompliance(ffmpegPath);
  } catch (e) {
    const message = e?.message || String(e);
    console.warn('FFmpeg compliance check skipped:', message);
    telemetryService.captureMessage?.('FFmpeg compliance check skipped', {
      level: 'warning',
      tags: { scope: 'startup', subsystem: 'ffmpeg', reason: 'check-skipped' },
      extra: { message },
      dedupeKey: 'startup:ffmpeg:check-skipped',
      dedupeWindowMs: 5 * 60 * 1000
    });
  }
  try {
    listAvailableEncoders();
  } catch {}
  applyAppMenu();
  createWindow();
  initAutoUpdates({
    sendStatus: (status, info) => {
      safeSend('auto-update-status', { status, info });
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


// ===============================
// 🔁 Watch Folder Automation
// ===============================

const watchContexts = {}; // panel -> { instance, queue, abortController, runtimeState }
const MAX_WATCH_LOG_LINES = 2000;
const MAX_WATCH_LOG_BYTES = 2 * 1024 * 1024;
const MAX_WATCH_LOG_FILES = 4;

let watchSessionState = {}; // panel -> { panel, folderKey, stopRequested, finalized, finalizePending:Set, finalizeTimer }
const WATCH_FINALIZE_TIMEOUT_MS = 60_000;

function normalizeWatchPanelKey(panel) {
  const p = String(panel || '').trim();
  if (!p) return '';
  return p === 'clone' ? 'ingest' : p;
}

function getWatchContext(panel, { create = false } = {}) {
  const key = normalizeWatchPanelKey(panel);
  if (!key) return null;
  if (!watchContexts[key] && create) {
    watchContexts[key] = { instance: null, queue: null, abortController: null, runtimeState: null };
  }
  return watchContexts[key] || null;
}

async function stopWatchResources(panel) {
  const key = normalizeWatchPanelKey(panel);
  const ctx = key ? watchContexts[key] : null;
  if (!ctx) return;

  if (ctx.abortController) {
    try {
      ctx.abortController.abort();
    } catch {
      // ignore
    }
  }
  ctx.abortController = null;

  if (ctx.runtimeState?.clear) {
    try {
      ctx.runtimeState.clear();
    } catch {
      // ignore
    }
  }
  ctx.runtimeState = null;

  if (ctx.instance) {
    try {
      await ctx.instance.close();
    } catch {
      // ignore
    }
  }
  ctx.instance = null;

  if (ctx.queue) {
    try {
      ctx.queue.clear();
    } catch {
      // ignore
    }
  }
  ctx.queue = null;
}

function initWatchSessionLogWriter(panel) {
  if (!panel) return;
  if (watchSessionLogWriters[panel]) {
    watchSessionLogWriters[panel].close();
  }
  watchSessionLogWriters[panel] = createSessionLogWriter({
    panel,
    prefix: `watch-${panel}`,
    maxBytes: MAX_WATCH_LOG_BYTES,
    maxFiles: MAX_WATCH_LOG_FILES
  });
}

function closeWatchSessionLogWriter(panel) {
  if (!panel || !watchSessionLogWriters[panel]) return;
  watchSessionLogWriters[panel].close();
  delete watchSessionLogWriters[panel];
}

function logWatch(panel, line) {
  if (!panel) return;
  safeSend('watch-log', line);
  if (!watchSessionLogs[panel]) {
    watchSessionLogs[panel] = [];
  }
  watchSessionLogs[panel].push(line);
  if (MAX_WATCH_LOG_LINES > 0 && watchSessionLogs[panel].length > MAX_WATCH_LOG_LINES) {
    watchSessionLogs[panel].splice(0, watchSessionLogs[panel].length - MAX_WATCH_LOG_LINES);
  }
  if (!watchSessionLogWriters[panel]) {
    initWatchSessionLogWriter(panel);
  }
  watchSessionLogWriters[panel]?.append(line);
}


function normalizeWatchPathForCompare(input) {
  if (!input) return '';
  let resolved = input;
  try {
    resolved = fs.realpathSync(input);
  } catch {
    try {
      resolved = path.resolve(input);
    } catch {
      resolved = String(input);
    }
  }
  const cleaned = String(resolved).replace(/[\\/]+$/, '');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return cleaned.toLowerCase();
  }
  return cleaned;
}

function getActiveWatchSession(panel) {
  const s = watchSessionState?.[panel];
  if (!s || s.finalized) return null;
  return s;
}

function isWatchJobForSession(session, job) {
  if (!session || !job || typeof job !== 'object') return false;
  const cfg = job.config;
  if (!cfg || typeof cfg !== 'object') return false;
  if (cfg.watchTriggered !== true && cfg.watchMode !== true) return false;
  const jobFolderKey = normalizeWatchPathForCompare(cfg.watchFolder || '');
  if (!jobFolderKey || !session.folderKey) return false;
  return jobFolderKey === session.folderKey;
}

function registerWatchTriggeredJob(panel, folder, jobId) {
  const session = getActiveWatchSession(panel);
  if (!session) return;
  try {
    if (!session.folderKey) session.folderKey = normalizeWatchPathForCompare(folder);
    session.trackedJobIds?.add?.(jobId);
  } catch {
    // ignore
  }
}

function summarizeWatchJobInputs(panel, cfg) {
  const safeList = (arr) => (Array.isArray(arr) ? arr.filter(Boolean) : []);
  if (!cfg || typeof cfg !== 'object') return { count: 0, preview: '' };

  if (panel === 'ingest') {
    const files = safeList(cfg.sourceFiles);
    const count = files.length || (cfg.source ? 1 : 0);
    const preview = files.slice(0, 3).map(p => path.basename(p)).join(', ');
    return { count, preview };
  }
  if (panel === 'transcode') {
    const files = safeList(cfg.inputFiles);
    const count = files.length;
    const preview = files.slice(0, 3).map(p => path.basename(p)).join(', ');
    return { count, preview };
  }
  if (panel === 'transcribe') {
    const files = safeList(cfg.files);
    const count = files.length;
    const preview = files.slice(0, 3).map(p => path.basename(p)).join(', ');
    return { count, preview };
  }
  return { count: 0, preview: '' };
}

function readTextFileTail(filePath, maxBytes = 64 * 1024) {
  try {
    if (!filePath || typeof filePath !== 'string') return '';
    const stat = fs.statSync(filePath);
    const size = Number(stat?.size || 0);
    if (!Number.isFinite(size) || size <= 0) return '';
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  } catch {
    return '';
  }
}

function extractWatchJobHighlights(panel, job) {
  const res = job?.result;
  if (!res || typeof res !== 'object') return [];
  const archivePath = typeof res.archivePath === 'string' ? res.archivePath.trim() : '';

  let text =
    (typeof res.logText === 'string' && res.logText.trim())
      ? res.logText
      : (Array.isArray(res.log) && res.log.length)
        ? res.log.join('\n')
        : '';

  if (!text && archivePath) {
    text = readTextFileTail(archivePath);
  }

  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => String(l || '').trim())
    .filter(Boolean);

  const tail = lines.slice(-120);
  const picked = [];

  if (panel === 'ingest') {
    for (const l of tail) {
      if (
        l.startsWith('🔍 Verification') ||
        l.startsWith('✅ Ingest complete') ||
        l.startsWith('⏱️ Elapsed') ||
        l.startsWith('⚠️ Watch-triggered job finished with errors')
      ) {
        picked.push(l);
      }
    }
  } else {
    if (typeof res.summary === 'string' && res.summary.trim()) {
      picked.push(`🧾 ${res.summary.trim()}`);
    }
    for (const l of tail) {
      if (l.startsWith('✅') || l.startsWith('❌') || l.startsWith('⚠️') || l.startsWith('⏱️')) {
        picked.push(l);
      }
    }
  }

  if (archivePath) {
    picked.push(`📄 Job log: ${archivePath}`);
  }

  const seen = new Set();
  return picked.filter(l => {
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
}

function scheduleFinalizeWatchSession(panel) {
  const session = getActiveWatchSession(panel);
  if (!session) return;

  if (session.finalizeTimer) {
    try { clearTimeout(session.finalizeTimer); } catch {}
    session.finalizeTimer = null;
  }

  session.finalizeTimer = setTimeout(() => {
    const s = getActiveWatchSession(panel);
    if (!s || s.finalized) return;
    logWatch(panel, `⚠️ Watch stop timeout (${Math.round(WATCH_FINALIZE_TIMEOUT_MS / 1000)}s) — archiving session log anyway.`);
    finalizeWatchSession(panel, { forced: true }).catch(() => {});
  }, WATCH_FINALIZE_TIMEOUT_MS);
}

function maybeFinalizeWatchSession(panel, jobId) {
  const session = getActiveWatchSession(panel);
  if (!session || !session.stopRequested) return;
  if (jobId && session.finalizePending?.has?.(jobId)) {
    session.finalizePending.delete(jobId);
  }
  if (session.finalizePending && session.finalizePending.size === 0) {
    finalizeWatchSession(panel).catch(() => {});
  }
}

function logWatchQueueEvent(kind, job) {
  const panel = job?.panel;
  const session = getActiveWatchSession(panel);
  if (!session) return;
  if (!isWatchJobForSession(session, job)) return;

  const id = job?.id || job?.config?.jobId || '(unknown)';
  const { count, preview } = summarizeWatchJobInputs(panel, job?.config || {});
  const previewText = preview ? `: ${preview}${count > 3 ? ` (+${count - 3} more)` : ''}` : '';

  if (kind === 'start') {
    logWatch(panel, `🚀 Started ${panel} job ${id}${count ? ` (${count} file(s))` : ''}${previewText}`);
    return;
  }
  if (kind === 'cancelling') {
    logWatch(panel, `🛑 Cancelling ${panel} job ${id}…`);
    return;
  }
  if (kind === 'failed') {
    const err = job?.error || job?.result?.error || '';
    logWatch(panel, `❌ ${panel} job ${id} failed${err ? `: ${String(err)}` : ''}`);
    for (const line of extractWatchJobHighlights(panel, job)) {
      logWatch(panel, `↳ ${line}`);
    }
    maybeFinalizeWatchSession(panel, job?.id);
    return;
  }
  if (kind === 'cancelled') {
    logWatch(panel, `🚫 ${panel} job ${id} cancelled`);
    for (const line of extractWatchJobHighlights(panel, job)) {
      logWatch(panel, `↳ ${line}`);
    }
    maybeFinalizeWatchSession(panel, job?.id);
    return;
  }
  if (kind === 'complete') {
    logWatch(panel, `✅ ${panel} job ${id} completed`);
    for (const line of extractWatchJobHighlights(panel, job)) {
      logWatch(panel, `↳ ${line}`);
    }
    maybeFinalizeWatchSession(panel, job?.id);
  }
}

async function finalizeWatchSession(panel, { forced: _forced = false } = {}) {
  const session = getActiveWatchSession(panel);
  if (session) {
    if (session.finalized) return;
    session.finalized = true;
    if (session.finalizeTimer) {
      try { clearTimeout(session.finalizeTimer); } catch {}
      session.finalizeTimer = null;
    }
  }

  try {
    if (watchSessionLogs[panel] && watchSessionLogs[panel].length) {
      const archivePath = archivePanelSessionLog(watchSessionLogs[panel], panel);
      if (mainWindow) {
        safeSend('watch-log', `📂 Session log archived to: ${archivePath}`);
      }

      try {
        const cfg = watchPanelConfigs?.[panel];
        const saveLog = !!cfg?.saveLog;
        const destination = typeof cfg?.destination === 'string' ? cfg.destination.trim() : '';
        const backupEnabled = !!(cfg?.dualCopy ?? cfg?.backup);
        const backupPath = typeof cfg?.backupPath === 'string' ? cfg.backupPath.trim() : '';

        if (saveLog && archivePath && typeof archivePath === 'string') {
          const baseName = path.basename(archivePath);
          const outName = `WatchLog_${baseName}`;

          const exportTo = async (dir, label) => {
            if (!dir) return;
            try {
              fs.mkdirSync(dir, { recursive: true });
            } catch {}
            const outPath = path.join(dir, outName);
            await fs.promises.copyFile(archivePath, outPath);
            if (mainWindow) safeSend('watch-log', `📄 Watch log exported (${label}): ${outPath}`);
          };

          await exportTo(destination, 'destination');
          if (backupEnabled && backupPath) {
            await exportTo(backupPath, 'backup');
          }
        }
      } catch (err) {
        if (mainWindow) safeSend('watch-log', `⚠️ Failed to export watch log: ${err?.message || err}`);
      }

      watchSessionLogs[panel] = [];
    }

    try {
      if (watchPanelConfigs && panel && watchPanelConfigs[panel]) delete watchPanelConfigs[panel];
    } catch {}

    try {
      const saveRes = await flushSharedWatchRegistrySave();
      if (saveRes && saveRes.ok === false && mainWindow) {
        safeSend('watch-log', `⚠️ Failed to save watch registry: ${saveRes.error || 'unknown error'}`);
      }
    } catch {}
  } finally {
    closeWatchSessionLogWriter(panel);
    try { delete watchSessionState[panel]; } catch {}
  }
}

async function startWatchFolder(config) {
  try {
    config = (config && typeof config === 'object') ? config : {};

    const {
      folder,
      panel,
      recursive,
      ignoreHidden: ignoreHiddenRaw,
      logActions,
      panelConfig,
      stableChecks = 5,
      requireDoneFile = false,
      includeHiddenFiles
    } = config;


    if (!panel) {
      throw new Error('Watch folder config missing panel id.');
    }

    const ctx = getWatchContext(panel, { create: true });

    // Stop any existing watcher/queue/timers for this panel only.
    await stopWatchResources(panel);

    ctx.abortController = (typeof AbortController !== 'undefined')
      ? new AbortController()
      : null;

    // Reset per-panel watch log buffer/writer.
    watchSessionLogs[panel] = [];
    initWatchSessionLogWriter(panel);

    // Initialize watch session state for log routing + stop/finalize.
    try {
      watchSessionState[panel] = {
        panel,
        folderKey: normalizeWatchPathForCompare(folder),
        trackedJobIds: new Set(),
        stopRequested: false,
        finalized: false,
        finalizePending: new Set(),
        finalizeTimer: null
      };
    } catch {
      // ignore
    }

    // Persist the last watch config so stopWatchFolder can export the session log
    // to the panel's Destination/Backup when Stop Watching is pressed.
    try {
      if (panel) {
        watchPanelConfigs[panel] = (panelConfig && typeof panelConfig === 'object') ? { ...panelConfig } : {};
      }
    } catch {
      // ignore
    }

    // Some volumes (exFAT, SMB, NTFS, etc.) can be unreliable with native
    // file system events on macOS. When that happens, chokidar will report
    // "ready" but never emit add/addDir events.
    //
    // Fix: automatically fall back to polling on external/network mounts
    // and on filesystems known to be problematic, while keeping native events
    // for internal APFS/HFS.
    // Compute once (cached, async, and timeout-limited).
    const detectedFsType = await getCachedFsType(folder);

    // macOS mount points:
    // - Typical mounts live at /Volumes/<Name>
    // - On Catalina+ realpath() commonly resolves /Volumes/... into
    //   /System/Volumes/Data/Volumes/... (firmlinks). Treat both as "external".
    const isMacExternalMountPath = (p) => {
      const s = String(p || '').replace(/\\/g, '/');
      const lower = s.toLowerCase();
      return (
        lower.startsWith('/volumes/') ||
        lower.startsWith('/system/volumes/data/volumes/')
      );
    };

    // Used for log clarity ("why are we polling?")
    let watchBackendReason = '';

    const shouldUsePollingWatch = () => {
      // Explicit override (UI/config)
      if (typeof config.watchUsePolling === 'boolean') {
        watchBackendReason = `config:${config.watchUsePolling ? 'polling' : 'native'}`;
        return config.watchUsePolling;
      }
      if (typeof panelConfig?.watchUsePolling === 'boolean') {
        watchBackendReason = `panelConfig:${panelConfig.watchUsePolling ? 'polling' : 'native'}`;
        return panelConfig.watchUsePolling;
      }

      // Env overrides (handy for support)
      if (process.env.LEADAE_WATCH_POLLING === '0') {
        watchBackendReason = 'env:LEADAE_WATCH_POLLING=0';
        return false;
      }
      if (process.env.CHOKIDAR_USEPOLLING === '0') {
        watchBackendReason = 'env:CHOKIDAR_USEPOLLING=0';
        return false;
      }
      if (process.env.LEADAE_WATCH_POLLING === '1') {
        watchBackendReason = 'env:LEADAE_WATCH_POLLING';
        return true;
      }
      if (process.env.CHOKIDAR_USEPOLLING === '1') {
        watchBackendReason = 'env:CHOKIDAR_USEPOLLING';
        return true;
      }

      // Auto-detect on macOS.
      if (process.platform === 'darwin') {
        // Anything mounted under /Volumes is external or network.
        // These are the most common cases where native events go dark.
        let isExternalMount = false;
        try {
          const rp = fs.realpathSync(folder);
          isExternalMount = isMacExternalMountPath(rp) || isMacExternalMountPath(folder);
        } catch {
          isExternalMount = isMacExternalMountPath(folder);
        }
        if (isExternalMount) {
          watchBackendReason = 'darwin:external-mount';
          return true;
        }

        // APFS/HFS are generally safe with FSEvents on internal volumes.
        // Non-native types frequently require polling.
        const nativeTypes = new Set(['apfs', 'hfs']);
        if (detectedFsType && !nativeTypes.has(detectedFsType)) {
          watchBackendReason = `darwin:fsType:${detectedFsType}`;
          return true;
        }
      }

      // Auto-detect UNC paths on Windows (network shares).
      if (process.platform === 'win32') {
        const p = String(folder || '');
        if (p.startsWith('\\\\')) {
          watchBackendReason = 'win32:unc';
          return true;
        }
      }

      watchBackendReason = 'default:native';
      return false;
    };

    const watchUsePolling = shouldUsePollingWatch();

    const resolveWatchPath = (input) => {
      if (!input) return null;
      let resolved = input;
      try {
        resolved = fs.realpathSync(input);
      } catch {
        try {
          resolved = path.resolve(input);
        } catch {
          resolved = String(input);
        }
      }
      const cleaned = String(resolved).replace(/[\\/]+$/, '');
      if (process.platform === 'win32' || process.platform === 'darwin') {
        return cleaned.toLowerCase();
      }
      return cleaned;
    };

    const normalizeVariantPath = (input) => {
      if (!input) return '';
      return resolveWatchPath(input) || String(input).trim();
    };

    const normalizeVariantValue = (value) => {
      if (value === null || value === undefined) return '';
      return String(value).trim();
    };

    const stableStringify = (value) => {
      if (value === null || value === undefined) return '';
      if (typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
      }
      const keys = Object.keys(value).sort();
      return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    };

    const hashVariantPayload = (payload) => {
      if (!payload || typeof payload !== 'object') return '';
      const stablePayload = stableStringify(payload);
      if (!stablePayload || stablePayload === '{}') return '';
      return crypto.createHash('sha1').update(stablePayload).digest('hex');
    };

    const resolvePresetName = (cfg) => normalizeVariantValue(
      cfg?.presetName || cfg?.preset || cfg?.presetFile || cfg?.presetKey || cfg?.presetId || ''
    );

    const buildWatchVariantKey = (panelId, cfg) => {
      const normalizedPanelId = panelId === 'clone' ? 'ingest' : panelId;
      const presetName = resolvePresetName(cfg);
      if (normalizedPanelId === 'ingest') {
        const destination = normalizeVariantPath(cfg?.destination || cfg?.destPath || cfg?.dest);
        const usesBackup = cfg?.dualCopy === true || cfg?.backup === true;
        const backupPath = usesBackup
          ? normalizeVariantPath(cfg?.backupPath || cfg?.backupDestination)
          : '';
        return hashVariantPayload({ destination, backupPath, presetName });
      }
      if (normalizedPanelId === 'transcode') {
        const outputFolder = normalizeVariantPath(cfg?.outputFolder || cfg?.outputPath);
        return hashVariantPayload({ outputFolder, presetName });
      }
      if (normalizedPanelId === 'transcribe') {
        const outputPath = normalizeVariantPath(cfg?.outputPath || cfg?.outputFolder);
        return hashVariantPayload({ outputPath, presetName });
      }
      const fallbackDestination = normalizeVariantPath(
        cfg?.outputFolder || cfg?.outputPath || cfg?.destination || cfg?.destPath || cfg?.dest
      );
      return hashVariantPayload({ destination: fallbackDestination, presetName });
    };

    const isSameOrChildPath = (parent, child) => {
      const parentPath = resolveWatchPath(parent);
      const childPath = resolveWatchPath(child);
      if (!parentPath || !childPath) return false;
      if (parentPath === childPath) return true;
      try {
        const rel = path.relative(parentPath, childPath);
        if (!rel || rel === '.') return true;
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      } catch {
        const prefix = parentPath.endsWith(path.sep) ? parentPath : `${parentPath}${path.sep}`;
        return childPath.startsWith(prefix);
      }
    };

    if (panel === 'transcribe') {
      const outputPath = panelConfig?.outputPath || config.outputPath || null;
      if (folder && outputPath && isSameOrChildPath(folder, outputPath)) {
        throw new Error(
          'Transcribe Watch Mode output path must be outside the watch folder. Choose an output folder that is not the watch folder or a subfolder.'
        );
      }
    }

    if (panel === 'transcode') {
      const outputFolder = panelConfig?.outputFolder || panelConfig?.outputPath || config.outputFolder || config.outputPath || null;
      if (folder && outputFolder && isSameOrChildPath(folder, outputFolder)) {
        throw new Error(
          getLocalizedMainMessage(
            'transcodeOutputPathInsideWatchFolderError',
            'Transcode Watch Mode output folder must be outside the watch folder. Choose an output folder that is not the watch folder or a subfolder.'
          )
        );
      }
    }

    if (panel === 'ingest' && !(panelConfig?.cloneMode || config.cloneMode)) {
      const destination = panelConfig?.destination || panelConfig?.destPath || panelConfig?.dest || config.destination || config.destPath || config.dest || null;
      const usesBackup = (
        panelConfig?.dualCopy === true ||
        panelConfig?.backup === true ||
        config.dualCopy === true ||
        config.backup === true
      );
      const backupPath = usesBackup
        ? (panelConfig?.backupPath || panelConfig?.backupDestination || config.backupPath || config.backupDestination || null)
        : null;

      if (folder && destination && isSameOrChildPath(folder, destination)) {
        throw new Error(
          getLocalizedMainMessage(
            'ingestWatchValidationDestinationOutsideWatchFolder',
            'Ingest Watch Mode destination must be outside the watch folder. Choose a destination folder that is not the watch folder or a subfolder.'
          )
        );
      }
      if (folder && backupPath && isSameOrChildPath(folder, backupPath)) {
        throw new Error(
          getLocalizedMainMessage(
            'ingestWatchValidationBackupOutsideWatchFolder',
            'Ingest Watch Mode backup destination must be outside the watch folder. Choose a backup folder that is not the watch folder or a subfolder.'
          )
        );
      }
    }

    // Backward compatibility: older panels/configs may not send ignoreHidden.
    // If the panel exposes `includeHiddenFiles`, derive ignoreHidden from it.
    const ignoreHidden = (typeof ignoreHiddenRaw === 'boolean')
      ? ignoreHiddenRaw
      : !(includeHiddenFiles);
    const processExistingOnStart = (typeof config.processExistingOnStart === 'boolean')
      ? config.processExistingOnStart
      : !!panelConfig?.processExistingOnStart;

    if (panel === 'clone' || panelConfig?.cloneMode) {
      throw new Error(
        getLocalizedMainMessage(
          'ingest.validation.watchMode.cloneModeUnsupportedAutomation',
          '❌ Clone Mode does not support Watch Folder Automation.'
        )
      );
    }

    const queuePanel = panel;
    const normalizedPanel = queuePanel;
    const isCloneMode = false;
    const watchSignal = ctx.abortController?.signal;

    // Ingest watch mode needs "already processed" tracking so we don't have to
    // touch source media (camera cards / read-only volumes).
    const useRegistry = normalizedPanel === 'ingest' && !isCloneMode;
    const registry = useRegistry ? getSharedWatchRegistry() : null;
    const variantKey = buildWatchVariantKey(queuePanel, panelConfig || config || {});    
    const watchSessionKey = useRegistry
      ? createWatchSessionKey(queuePanel, resolveWatchPath(folder) || folder, variantKey)
      : null;

    const clampInt = (value, min, max, fallback) => {
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };

    const toPositiveInt = (value, fallback = 0) => {
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n)) return fallback;
      return Math.max(0, n);
    };

    const requestedThreadsRaw = toPositiveInt(panelConfig?.maxThreads, 0);
    const requestedThreads = requestedThreadsRaw > 0 ? requestedThreadsRaw : 1;

    // Enable batching automatically when the user explicitly chose multiple threads
    // (parallel copy) for watch mode. This keeps legacy behavior by default.
    const explicitBatch = config.watchBatchEnabled === true || panelConfig?.watchBatchEnabled === true;
    const batchingEnabled = (normalizedPanel === 'ingest')
      && !isCloneMode
      && (explicitBatch || requestedThreads > 1);

    const batchWindowMs = batchingEnabled
      ? clampInt(panelConfig?.watchBatchWindowMs ?? config.watchBatchWindowMs, 0, 5000, 500)
      : 0;
    const batchMaxFiles = batchingEnabled
      ? clampInt(panelConfig?.watchBatchMaxFiles ?? config.watchBatchMaxFiles, 1, 200, 25)
      : 1;
    // 0 disables byte-based flushing (file-count + time window still apply)
    const batchMaxBytes = batchingEnabled
      ? toPositiveInt(panelConfig?.watchBatchMaxBytes ?? config.watchBatchMaxBytes, 0)
      : 0;

    const defaultStableConcurrency = batchingEnabled
      ? Math.min(8, Math.max(2, requestedThreads * 2))
      : 1;
    const stableConcurrency = clampInt(
      panelConfig?.watchStableConcurrency ?? config.watchStableConcurrency,
      1,
      32,
      defaultStableConcurrency
    );

    ctx.queue = new PQueue({ concurrency: stableConcurrency });

    const recentlySeen = new Set();
    const pendingSet = new Set();
    const batchedSet = new Set();
    const retryScheduled = new Set();

    // ------------------------------------------------------------------
    // Dir-scan fallback (readdir-based)
    //
    // Why: On ExFAT (and some NAS mounts), directory mtimes may NOT update
    // when new entries appear. Chokidar polling can miss new files forever.
    // A readdir loop is dumb but reliable: if the name exists, we see it.
    //
    // Default: enable whenever watchUsePolling is true.
    // Overrides:
    //   config.watchDirScan / panelConfig.watchDirScan (boolean)
    //   LEADAE_WATCH_DIRSCAN=0|1
    // Tuning:
    //   LEADAE_WATCH_DIRSCAN_INTERVAL_MS
    //   LEADAE_WATCH_DIRSCAN_MAX_DIRS_PER_TICK
    //   LEADAE_WATCH_DIRSCAN_MAX_TRACKED_DIRS
    // ------------------------------------------------------------------
    const shouldUseDirScanWatch = () => {
      if (typeof config.watchDirScan === 'boolean') return config.watchDirScan;
      if (typeof panelConfig?.watchDirScan === 'boolean') return panelConfig.watchDirScan;
      if (process.env.LEADAE_WATCH_DIRSCAN === '0') return false;
      if (process.env.LEADAE_WATCH_DIRSCAN === '1') return true;
      return !!watchUsePolling;
    };
    const watchUseDirScan = shouldUseDirScanWatch();
    const dirScanIntervalMs = clampInt(
      panelConfig?.watchDirScanIntervalMs
        ?? config.watchDirScanIntervalMs
        ?? process.env.LEADAE_WATCH_DIRSCAN_INTERVAL_MS,
      250,
      10000,
      1000
    );
    const dirScanMaxDirsPerTick = clampInt(
      panelConfig?.watchDirScanMaxDirsPerTick
        ?? config.watchDirScanMaxDirsPerTick
        ?? process.env.LEADAE_WATCH_DIRSCAN_MAX_DIRS_PER_TICK,
      1,
      200,
      25
    );
    const dirScanMaxTrackedDirs = clampInt(
      panelConfig?.watchDirScanMaxTrackedDirs
        ?? config.watchDirScanMaxTrackedDirs
        ?? process.env.LEADAE_WATCH_DIRSCAN_MAX_TRACKED_DIRS,
      10,
      200000,
      10000
    );

    const dirScanState = {
      timer: null,
      inFlight: false,
      rootKey: normalizeWatchPathForCompare(folder),
      order: [],
      rrIndex: 0,
      info: new Map(), // key -> { path, initialized, emitOnFirstScan, seen:Set<string> }
      warnedCap: false
    };

    const stopDirScanFallback = () => {
      if (dirScanState.timer) {
        try { clearInterval(dirScanState.timer); } catch {}
        dirScanState.timer = null;
      }
      dirScanState.inFlight = false;
      dirScanState.order = [];
      dirScanState.rrIndex = 0;
      dirScanState.info.clear();
      dirScanState.warnedCap = false;
    };

    const trackDirForDirScan = (dirPath, { emitOnFirstScan = false } = {}) => {
      if (!watchUseDirScan) return null;
      if (!dirPath) return null;
      const key = normalizeWatchPathForCompare(dirPath);
      if (!key) return null;
      if (dirScanState.info.has(key)) return key;

      if (dirScanState.info.size >= dirScanMaxTrackedDirs) {
        if (!dirScanState.warnedCap && logActions) {
          dirScanState.warnedCap = true;
          logWatch(panel, `⚠️ Dir-scan cap reached (${dirScanMaxTrackedDirs} dirs). Consider watching a narrower folder.`);
        }
        return null;
      }

      dirScanState.info.set(key, {
        path: dirPath,
        initialized: false,
        emitOnFirstScan: !!emitOnFirstScan,
        seen: new Set()
      });

      if (key === dirScanState.rootKey) {
        // Root stays first for fast detection of top-level drops.
        dirScanState.order = [key].concat(dirScanState.order.filter(k => k !== key));
      } else {
        dirScanState.order.push(key);
      }
      return key;
    };

    if (watchUseDirScan) {
      trackDirForDirScan(folder, { emitOnFirstScan: processExistingOnStart });
    }

    // Watch-mode log de-spam (UI-facing). This is intentionally lightweight:
    // - Dedup repeated "Detected" spam while a file is still being written.
    // - Throttle "Missing/empty (retrying)" so users don't think the job is failing.
    const WATCH_LOG_THROTTLE = {
      detectedMs: 12_000,
      missingEmptyMs: 12_000
    };
    const watchLogState = new Map(); // key -> { detectedAt, missingEmptyAt }
    const getWatchLogState = (key) => {
      if (!key) return null;
      let st = watchLogState.get(key);
      if (!st) {
        st = { detectedAt: 0, missingEmptyAt: 0 };
        watchLogState.set(key, st);
      }
      return st;
    };

    // Retry policy for watch-preflight (stability/signature). This is intentionally separate
    // from Ingest "Retry failures" (copy/verification stage).
    const WATCH_RETRY_POLICIES = {
      // Missing/empty files typically indicate transient filesystem churn (e.g., Spotlight temp files)
      // or incomplete writes. Cap these to avoid infinite noisy loops.
      missingEmpty: { maxRetries: 10, maxAgeMs: 60_000, delayMs: 2000, label: 'missing/empty' },
      // Queueing a batched job failing shouldn't loop forever either.
      queueFailure: { maxRetries: 10, maxAgeMs: 60_000, delayMs: 1000, label: 'queue failure' },
      // Legitimate waiting states: do not hard-cap by default.
      notStable: { maxRetries: 0, maxAgeMs: 0, delayMs: 2000, label: 'not stable' },
      doneFlag: { maxRetries: 0, maxAgeMs: 0, delayMs: 2000, label: 'done flag' }
    };

    const retryTracker = new Map(); // key -> { [reason]: { firstMs, retries, dropped, logged } }

    const clearRetryState = (key) => {
      if (!key) return;
      retryTracker.delete(key);
    };

    const getRetryMeta = (key, reason) => {
      if (!key) return null;
      const r = String(reason || 'missingEmpty');
      let perKey = retryTracker.get(key);
      if (!perKey) {
        perKey = {};
        retryTracker.set(key, perKey);
      }
      if (!perKey[r]) {
        perKey[r] = { firstMs: Date.now(), retries: 0, dropped: false, logged: false };
      }
      return perKey[r];
    };

    const dropRetryKey = (filePath, key, reason, details) => {
      const meta = getRetryMeta(key, reason);
      if (meta) meta.dropped = true;
      pendingSet.delete(key);
      retryScheduled.delete(key);

      if (logActions && meta && !meta.logged) {
        meta.logged = true;
        const basename = path.basename(filePath || '');
        const label = WATCH_RETRY_POLICIES[reason]?.label || reason;
        // UX: "giving up" reads like a failure, but in watch mode this is usually
        // just a file that's still being copied into the watch folder. We drop
        // the current attempt, but we continue watching and can re-detect later.
        if (reason === 'missingEmpty') {
          const ageSec = Math.max(0, Math.round((Date.now() - meta.firstMs) / 1000));
          logWatch(
            panel,
            `⏳ Still copying: ${basename} (not ready after ${ageSec}s). Will keep watching for it to stabilize.`
          );
        } else {
          logWatch(panel, `⚠️ Giving up on ${basename} (${label}).${details ? ' ' + details : ''}`);
        }
      }
    };

    const scheduleRetryWithPolicy = (filePath, key, reason = 'missingEmpty', delayOverrideMs) => {
      if (!key) key = normalizeWatchKey(filePath);
      const policy = WATCH_RETRY_POLICIES[reason] || WATCH_RETRY_POLICIES.missingEmpty;
      const delayMs = Number.isFinite(delayOverrideMs)
        ? Math.max(0, Math.floor(delayOverrideMs))
        : Math.max(0, Math.floor(policy.delayMs || 2000));

      // Unlimited policies are used for legitimate waiting states.
      if (!policy.maxRetries && !policy.maxAgeMs) {
        scheduleRetry(filePath, key, delayMs);
        return;
      }

      const meta = getRetryMeta(key, reason);
      if (!meta || meta.dropped) {
        pendingSet.delete(key);
        retryScheduled.delete(key);
        return;
      }

      meta.retries += 1;
      const ageMs = Date.now() - meta.firstMs;
      const overRetries = policy.maxRetries > 0 && meta.retries > policy.maxRetries;
      const overAge = policy.maxAgeMs > 0 && ageMs > policy.maxAgeMs;

      if (overRetries || overAge) {
        const parts = [];
        if (overRetries) parts.push(`max retries (${policy.maxRetries}) reached`);
        if (overAge) parts.push(`max age (${Math.round(policy.maxAgeMs / 1000)}s) exceeded`);
        dropRetryKey(filePath, key, reason, parts.join(', '));
        return;
      }

      if (logActions && reason === 'missingEmpty') {
        const basename = path.basename(filePath || '');
        const st = getWatchLogState(key);
        const now = Date.now();
        const shouldLog =
          !st || (now - (st.missingEmptyAt || 0)) >= WATCH_LOG_THROTTLE.missingEmptyMs || meta.retries <= 1;
        if (st) st.missingEmptyAt = now;

        // Throttled, and reframed as normal watch behavior.
        if (shouldLog) {
          const ageSec = Math.max(0, Math.round(ageMs / 1000));
          logWatch(panel, `⏳ Waiting for file to finish copying: ${basename} (${ageSec}s)`);
        }
      }

      scheduleRetry(filePath, key, delayMs);
    };

    function buildJobConfig(cfg, p, fileListOrPath) {
      const normalizedPanel = p === 'clone' ? 'ingest' : p;
      const files = Array.isArray(fileListOrPath)
        ? fileListOrPath.filter(Boolean)
        : (fileListOrPath ? [fileListOrPath] : []);
      const firstPath = files[0];
      const fresh = JSON.parse(JSON.stringify(cfg || {}));
      fresh.watchMode = true;
      fresh.watchTriggered = true;
      fresh.watchFolder = folder;
      if (normalizedPanel === 'ingest') {
        const isCloneMode = p === 'clone' || fresh.cloneMode;
        if (isCloneMode) {
          fresh.cloneMode = true;
          fresh.source = firstPath;
          if (!Array.isArray(fresh.selectedFolders) || !fresh.selectedFolders.length) {
            fresh.selectedFolders = firstPath ? [firstPath] : [];
          }
        } else {
          fresh.sourceFiles = files;
          // Use the watch folder root so relative paths are preserved
          fresh.source = folder;
        }
      }
      if (normalizedPanel === 'transcode') {
        fresh.inputFiles = files;
      }
      if (normalizedPanel === 'transcribe') {
        fresh.files = files;
        // Preserve the user-selected destination outputPath.
        // Setting outputPath to the watched folder breaks the panel expectation
        // and can cause output to land in the watch folder unintentionally.
      }
      return fresh;
    }
    function debounceTrigger(fp, fn, { force = false } = {}) {
      if (!force && recentlySeen.has(fp)) return;
      recentlySeen.add(fp);
      setTimeout(() => recentlySeen.delete(fp), 30000); // 30 seconds
      fn();
    }


    function hasDoneFile(filePath) {
      const dir = path.dirname(filePath);
      const base = path.basename(dir);
      const names = [
        path.join(dir, 'CLIP.done'),
        path.join(dir, 'REEL.done'),
        path.join(dir, `${base}.done`),
        path.join(dir, `${base}.doneflag`)
      ];
      return names.some(p => fs.existsSync(p));
    }

    function parseSidecar(filePath) {
      if (filePath.toLowerCase().endsWith('.doneflag')) return null;
      const dir = path.dirname(filePath);
      const base = path.basename(filePath, path.extname(filePath));
      const exts = ['.ale', '.xml', '.mhl', '.md5'];
      const meta = {};
      for (const ext of exts) {
        const p = path.join(dir, base + ext);
        if (fs.existsSync(p)) {
          try {
            meta[ext.slice(1)] = fs.readFileSync(p, 'utf-8').trim().slice(0, 200);
          } catch (err) {
            log.error(`Failed to read sidecar ${p}:`, err.message);
          }
        }
      }
      return Object.keys(meta).length ? meta : null;
    }
    const splitRelParts = (p) => {
      try {
        const rel = path.relative(folder, p);
        if (!rel || rel === '.') return [];
        // Split on both Windows and POSIX separators defensively.
        return String(rel).split(/[\\/]+/).filter(Boolean);
      } catch {
        return [];
      }
    };

    // Always ignore macOS metadata folders that cause noisy churn on removable/network volumes.
    // This remains ignored even when "Include hidden files" is enabled.
    const MAC_SYSTEM_DIR_SEGMENTS = new Set([
      '.spotlight-v100',
      '.fseventsd',
      '.trashes',
      '.temporaryitems',
      '.documentrevisions-v100'
    ]);

    const isMacSystemMetadataPath = (p) => {
      const parts = splitRelParts(p);
      for (const seg of parts) {
        if (!seg) continue;
        if (MAC_SYSTEM_DIR_SEGMENTS.has(String(seg).toLowerCase())) return true;
      }
      return false;
    };

    const isHiddenWithinWatchRoot = (p) => {
      if (!ignoreHidden) return false;
      const parts = splitRelParts(p);
      return parts.some(seg => seg && seg !== '.' && seg !== '..' && seg.startsWith('.'));
    };

    const normalizeWatchKey = (p) => {
      try {
        // realpathSync helps dedupe different spellings of the same path (symlinks, case)
        return fs.realpathSync(p);
      } catch {
        try {
          return path.resolve(p);
        } catch {
          return String(p);
        }
      }
    };

    const getWatchSignatureInfo = async (filePath) => {
      try {
        const stat = await fs.promises.stat(filePath);
        const sizeBytes = stat.size;
        const mtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : (stat.mtime?.getTime?.() || 0);
        const ctimeMs = Number.isFinite(stat.ctimeMs) ? stat.ctimeMs : (stat.ctime?.getTime?.() || 0);
        const dev = Number.isFinite(stat.dev) ? stat.dev : null;
        const ino = Number.isFinite(stat.ino) ? stat.ino : null;
        const inode = (dev !== null || ino !== null) ? `${dev ?? '0'}:${ino ?? '0'}` : '';
        let contentHash = '';
        if (sizeBytes > 0 && sizeBytes <= WATCH_REGISTRY_HASH_BYTES) {
          try {
            contentHash = await getSmallFileHash(filePath);
          } catch {
            contentHash = '';
          }
        }
        const signature = createWatchFileSignature(folder, filePath, sizeBytes, mtimeMs, {
          ctimeMs,
          inode,
          contentHash
        });
        return {
          sizeBytes,
          mtimeMs,
          ctimeMs,
          inode,
          contentHash,
          signature
        };
      } catch (err) {
        return { error: err };
      }
    };

    let batchTimer = null;
    let batchEntries = [];
    let batchBytes = 0;

    const clearBatchTimer = () => {
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
    };

    const flushBatch = (reason = 'window') => {
      if (!batchingEnabled) return;
      if (watchSignal?.aborted) return;
      if (!batchEntries.length) return;

      const entries = batchEntries;
      const totalBytes = batchBytes;

      // Reset state before queueing so new arrivals can start a fresh batch.
      batchEntries = [];
      batchBytes = 0;
      clearBatchTimer();

      const filePaths = entries.map(e => e.filePath);
      const jobConfig = buildJobConfig(panelConfig, panel, filePaths);
      if (useRegistry && watchSessionKey) {
        const registryEntries = entries.map(e => e.registryEntry).filter(Boolean);
        if (registryEntries.length) {
          jobConfig.watchRegistry = { sessionKey: watchSessionKey, entries: registryEntries };
        }
      }

      try {
        const jobId = global.queue.addJob({ panel: queuePanel, config: jobConfig });
        registerWatchTriggeredJob(panel, folder, jobId);

        for (const e of entries) {
          batchedSet.delete(e.key);
        }

        if (logActions) {
          const previewNames = filePaths.slice(0, 3).map(fp => path.basename(fp)).join(', ');
          const more = filePaths.length > 3 ? ` +${filePaths.length - 3} more` : '';
          logWatch(
            panel,
            `✅ Queued ${panel} batch job ${jobId} (${filePaths.length} file(s), ${totalBytes} bytes) [${reason}]: ${previewNames}${more}`
          );
        }
      } catch (err) {
        // If queueing failed, drop out of "batched" state and requeue individual files
        // so we don't silently miss ingesting a stable drop.
        for (const e of entries) {
          batchedSet.delete(e.key);
          pendingSet.add(e.key);
          scheduleRetryWithPolicy(e.filePath, e.key, 'queueFailure', 1000);
        }
        if (logActions) {
          logWatch(panel, `❌ Failed to queue ${panel} batch: ${err.message}`);
        }
      }
    };

    const scheduleBatchFlush = () => {
      if (!batchingEnabled) return;
      if (batchTimer) return;
      if (batchWindowMs <= 0) {
        flushBatch('immediate');
        return;
      }
      batchTimer = setTimeout(() => flushBatch('window'), batchWindowMs);
    };

    const addToBatch = ({ filePath, key, sizeBytes, registryEntry }) => {
      if (!batchingEnabled) return false;
      if (watchSignal?.aborted) return false;
      if (batchedSet.has(key)) return false;

      batchedSet.add(key);
      batchEntries.push({ filePath, key, sizeBytes, registryEntry });
      batchBytes += Math.max(0, sizeBytes || 0);

      const overMaxFiles = batchMaxFiles > 0 && batchEntries.length >= batchMaxFiles;
      const overMaxBytes = batchMaxBytes > 0 && batchBytes >= batchMaxBytes;

      if (overMaxFiles) {
        flushBatch('max-files');
        return true;
      }
      if (overMaxBytes) {
        flushBatch('max-bytes');
        return true;
      }

      scheduleBatchFlush();
      return true;
    };

    // Expose a tiny bit of state so stopWatchFolder can clean up timers.
    ctx.runtimeState = {
      clear: () => {
        stopDirScanFallback();
        clearBatchTimer();
        batchEntries = [];
        batchBytes = 0;
        pendingSet.clear();
        batchedSet.clear();
        retryScheduled.clear();
        retryTracker.clear();
        recentlySeen.clear();
      }
    };

    try {
      const folderStats = await fs.promises.stat(folder);
      if (!folderStats.isDirectory()) {
        const errorMessage = `Watch folder path is not a directory: ${folder}. Choose an existing folder to watch.`;
        logWatch(panel, `⚠️ ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
    } catch {
      const errorMessage = `Unable to access watch folder: ${folder}. Verify the folder exists and you have permission.`;
      logWatch(panel, `⚠️ ${errorMessage}`);
      return { success: false, error: errorMessage };
    }

    const watcher = chokidar.watch(folder, {
      ignored: (filePath, stats) => {
        const name = path.basename(filePath).toLowerCase();

        // Always ignore internal marker files.
        if (name.endsWith('.done') || name.endsWith('.doneflag')) return true;

        // macOS AppleDouble sidecar files on non-APFS / network volumes.
        // These are metadata stubs and should never be ingested.
        if (name.startsWith('._')) return true;

        // Always ignore macOS metadata folders (Spotlight, fseventsd, etc.) even when hidden files are included.
        if (isMacSystemMetadataPath(filePath)) return true;

        // Hidden/system handling (configurable): ignore dotfiles *and* anything inside dot-directories.
        if (isHiddenWithinWatchRoot(filePath)) return true;
        if (ignoreHidden && name.startsWith('.')) return true;

        // Common platform metadata.
        if (['.ds_store', 'thumbs.db'].includes(name)) return true;

        // Temporary/incomplete writes.
        const ext = path.extname(filePath).toLowerCase();
        const tmpExt = /(\.tmp|\.part|\.partial)$/.test(ext) || name.endsWith('.copying');
        if (tmpExt) return true;

        // For directories, if we're not ignoring them, allow traversal.
        if (stats?.isDirectory?.()) return false;

        return false;
      },
      ignoreInitial: !processExistingOnStart,
      persistent: true,
      alwaysStat: true,
      depth: recursive === false ? 0 : undefined,

      // Polling is slower/heavier, but it works reliably on external/network
      // volumes where native events often fail.
      usePolling: watchUsePolling,
      interval: watchUsePolling ? 1000 : undefined,
      binaryInterval: watchUsePolling ? 2000 : undefined
    }); // ✅ Properly closed config object

    function scheduleRetry(filePath, key, delayMs = 2000) {
      if (!key) key = normalizeWatchKey(filePath);
      if (watchSignal?.aborted) {
        pendingSet.delete(key);
        retryScheduled.delete(key);
        return;
      }
      if (retryScheduled.has(key)) return;

      retryScheduled.add(key);
      setTimeout(() => {
        retryScheduled.delete(key);

        if (watchSignal?.aborted) {
          pendingSet.delete(key);
          return;
        }
        if (!ctx.queue) {
          pendingSet.delete(key);
          return;
        }

        ctx.queue.add(() => handleFile(filePath, key));
      }, Math.max(0, delayMs));
    }

    async function handleFile(filePath, key = normalizeWatchKey(filePath)) {
      const basename = path.basename(filePath);
      let keepPending = false;

      if (watchSignal?.aborted) {
        pendingSet.delete(key);
        return;
      }

      // Safety net: ignore temp/incomplete files even if they slip into the queue
      // (e.g. via manual dir scans).
      const lowerBase = basename.toLowerCase();
      const ext = path.extname(filePath).toLowerCase();
      if (/(\.tmp|\.part|\.partial)$/.test(ext) || lowerBase.endsWith('.copying')) {
        clearRetryState(key);
        pendingSet.delete(key);
        retryScheduled.delete(key);
        return;
      }

      try {
        if (requireDoneFile && !hasDoneFile(filePath)) {
          if (logActions) logWatch(panel, `⏳ Waiting for done flag in ${path.dirname(filePath)}`);
          keepPending = true;
          scheduleRetryWithPolicy(filePath, key, 'doneFlag');
          return;
        }

        const stable = await waitForStableFile(filePath, 2000, stableChecks, { signal: watchSignal });
        if (!stable) {
          if (watchSignal?.aborted) {
            pendingSet.delete(key);
            return;
          }
          // If it disappeared while we were waiting for stability, stop retrying.
          try {
            await fs.promises.stat(filePath);
          } catch (statErr) {
            if (statErr && statErr.code === 'ENOENT') {
              if (logActions) logWatch(panel, `⚠️ Disappeared (dropping): ${basename}`);
              clearRetryState(key);
              pendingSet.delete(key);
              retryScheduled.delete(key);
              return;
            }
          }

          if (logActions) logWatch(panel, `⏳ Not stable: ${basename}`);
          keepPending = true;
          scheduleRetryWithPolicy(filePath, key, 'notStable');
          return;
        }

        let registryEntry = null;
        let sizeBytes = 0;
        let mtimeMs = 0;
        try {
          const signatureInfo = await getWatchSignatureInfo(filePath);
          if (signatureInfo?.error) throw signatureInfo.error;
          sizeBytes = signatureInfo?.sizeBytes || 0;
          mtimeMs = signatureInfo?.mtimeMs || 0;
          if (!signatureInfo || !sizeBytes) {
            const emptyErr = new Error('empty file');
            emptyErr.code = 'LEADAE_EMPTY_FILE';
            throw emptyErr;
          }

          if (useRegistry) {
            const signature = signatureInfo.signature;
            if (isWatchFileProcessed(registry, watchSessionKey, signature)) {
              if (logActions) logWatch(panel, `↩️ Skipping already processed: ${basename}`);
              clearRetryState(key);
              pendingSet.delete(key);
              return;
            }
            registryEntry = { filePath, sizeBytes, mtimeMs, signature };
          }
        } catch (err) {
          if (watchSignal?.aborted) {
            pendingSet.delete(key);
            return;
          }

          // If the file disappeared, stop retrying immediately (common for temporary/system files).
          if (err && err.code === 'ENOENT') {
            if (logActions) logWatch(panel, `⚠️ Disappeared (dropping): ${basename}`);
            clearRetryState(key);
            pendingSet.delete(key);
            retryScheduled.delete(key);
            return;
          }

          keepPending = true;
          scheduleRetryWithPolicy(filePath, key, 'missingEmpty', 2000);
          return;
        }

        const meta = parseSidecar(filePath);
        if (meta && logActions) {
          logWatch(panel, `📑 Sidecar for ${basename}`);
        }

        if (logActions) logWatch(panel, `🎬 Stable: ${basename}`);

        // ✅ Batch stable files into a single ingest job so we can safely use ingest's
        // existing thread engine (runWithConcurrencyLimit) without launching multiple jobs.
        if (batchingEnabled) {
          clearRetryState(key);
          pendingSet.delete(key);
          addToBatch({ filePath, key, sizeBytes, registryEntry });
          if (logActions) logWatch(panel, `📦 Batched: ${basename}`);
          return;
        }

        const handler = {
          ingest: runIngest,
          transcode: runTranscode,
          transcribe: runTranscribe
        }[queuePanel];

        const jobConfig = buildJobConfig(panelConfig, panel, filePath);
        if (useRegistry && registryEntry && watchSessionKey) {
          jobConfig.watchRegistry = { sessionKey: watchSessionKey, entries: [registryEntry] };
        }

        if (typeof handler === 'function') {
          const jobId = global.queue.addJob({ panel: queuePanel, config: jobConfig });
          registerWatchTriggeredJob(panel, folder, jobId);
          clearRetryState(key);
          if (logActions) logWatch(panel, `✅ Queued ${panel} job ${jobId} for ${basename}`);
        } else {
          log.error(`❌ No queue handler for panel: ${panel}`);
        }
      } catch (err) {
        if (logActions) logWatch(panel, `❌ ${panel} failed for ${basename}: ${err.message}`);
      } finally {
        // Only clear if we aren't currently batched (batchedSet is cleared at flush).
        if (!keepPending && !batchedSet.has(key)) pendingSet.delete(key);
      }
    }

    const onDetected = (filePath) => {
      if (DEBUG_LOGS) {
        // Detected file path logged only in debug mode
      }
      const basename = path.basename(filePath);
      const lowerBase = basename.toLowerCase();
      if (lowerBase.endsWith('.done') || lowerBase.endsWith('.doneflag')) return;
      if (isMacSystemMetadataPath(filePath)) return;
      if (isHiddenWithinWatchRoot(filePath)) return;

      // Ignore temporary/incomplete writes regardless of how they were discovered
      // (chokidar event vs manual dir scan).
      const ext = path.extname(filePath).toLowerCase();
      if (/(\.tmp|\.part|\.partial)$/.test(ext) || lowerBase.endsWith('.copying')) return;

      const key = normalizeWatchKey(filePath);
      if (logActions) {
        const st = getWatchLogState(key);
        const now = Date.now();
        const shouldLog =
          !st || (now - (st.detectedAt || 0)) >= WATCH_LOG_THROTTLE.detectedMs || !pendingSet.has(key);
        if (st) st.detectedAt = now;
        if (shouldLog) {
          logWatch(panel, `📁 Detected: ${basename}`);
        }
      }
      if (!ctx.queue) return;
      if (pendingSet.has(key) || batchedSet.has(key)) return;
      pendingSet.add(key);
      ctx.queue.add(() => handleFile(filePath, key));
    };

    // ---------------- Dir-scan implementation (readdir loop) ----------------
    const dirScanIsIgnored = (fullPath, _dirent) => {
      const name = path.basename(fullPath).toLowerCase();
      if (name.endsWith('.done') || name.endsWith('.doneflag')) return true;
      if (name.startsWith('._')) return true;
      if (isMacSystemMetadataPath(fullPath)) return true;
      if (isHiddenWithinWatchRoot(fullPath)) return true;
      if (ignoreHidden && name.startsWith('.')) return true;
      if (['.ds_store', 'thumbs.db'].includes(name)) return true;
      const ext = path.extname(fullPath).toLowerCase();
      if (/(\.tmp|\.part|\.partial)$/.test(ext) || name.endsWith('.copying')) return true;
      // directories are handled by caller
      return false;
    };

    const dirScanReadDir = async (dirPath) => {
      const out = { entries: new Set(), dirs: new Set(), files: new Set() };
      let dirents;
      try {
        dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const de of dirents) {
        const child = path.join(dirPath, de.name);
        if (dirScanIsIgnored(child, de)) continue;
        out.entries.add(child);
        if (de.isDirectory?.()) out.dirs.add(child);
        else out.files.add(child);
      }
      return out;
    };

    const dirScanHandleNewDir = async (dirPath) => {
      if (!dirPath || watchSignal?.aborted) return;
      if (recursive === false) return;
      if (isMacSystemMetadataPath(dirPath)) return;
      if (isHiddenWithinWatchRoot(dirPath)) return;

      trackDirForDirScan(dirPath, { emitOnFirstScan: false });
      if (logActions) logWatch(panel, `📂 Folder detected: ${path.basename(dirPath)}`);

      try {
        const { files, dirs } = await getAllFilesRecursively(dirPath, dirPath, {
          includeHidden: !ignoreHidden,
          signal: watchSignal
        });

        for (const d of (dirs || [])) {
          trackDirForDirScan(d.fullPath, { emitOnFirstScan: false });
        }
        for (const f of (files || [])) {
          const lower = String(f.fullPath || '').toLowerCase();
          if (lower.endsWith('.done') || lower.endsWith('.doneflag')) continue;
          debounceTrigger(f.fullPath, () => onDetected(f.fullPath));
        }

        // Baseline this directory so we don't re-emit its current contents.
        const k = normalizeWatchPathForCompare(dirPath);
        const info = k ? dirScanState.info.get(k) : null;
        if (info) {
          const snap = await dirScanReadDir(dirPath);
          info.seen = snap.entries;
          info.initialized = true;
          info.emitOnFirstScan = false;
        }
      } catch (err) {
        if (logActions) {
          logWatch(panel, `⚠️ Dir-scan folder read failed: ${path.basename(dirPath)} (${err?.message || err})`);
        }
      }
    };

    const dirScanScanKey = async (dirKey) => {
      const info = dirKey ? dirScanState.info.get(dirKey) : null;
      if (!info || watchSignal?.aborted) return;

      const snap = await dirScanReadDir(info.path);

      // First scan = baseline (unless explicitly emitting existing)
      if (!info.initialized) {
        info.initialized = true;
        info.seen = snap.entries;

        if (info.emitOnFirstScan) {
          for (const d of snap.dirs) {
            await dirScanHandleNewDir(d);
          }
          for (const f of snap.files) {
            debounceTrigger(f, () => onDetected(f));
          }
          info.emitOnFirstScan = false;
        } else if (recursive !== false) {
          // Track existing subdirs for future diff scans (baseline-only)
          for (const d of snap.dirs) {
            trackDirForDirScan(d, { emitOnFirstScan: false });
          }
        }
        return;
      }

      // Diff scan
      for (const d of snap.dirs) {
        if (!info.seen.has(d)) {
          await dirScanHandleNewDir(d);
        }
      }
      for (const f of snap.files) {
        if (!info.seen.has(f)) {
          debounceTrigger(f, () => onDetected(f));
        }
      }

      info.seen = snap.entries;
    };

    const dirScanTick = async () => {
      if (!watchUseDirScan) return;
      if (dirScanState.inFlight) return;
      if (watchSignal?.aborted) return;
      if (!dirScanState.order.length) return;

      dirScanState.inFlight = true;
      try {
        // Always scan root first for fast top-level detection.
        if (dirScanState.rootKey) {
          await dirScanScanKey(dirScanState.rootKey);
        }

        const extra = Math.max(0, dirScanMaxDirsPerTick - 1);
        for (let i = 0; i < extra; i++) {
          if (watchSignal?.aborted) break;
          if (dirScanState.order.length <= 1) break;

          dirScanState.rrIndex = (dirScanState.rrIndex + 1) % dirScanState.order.length;
          const k = dirScanState.order[dirScanState.rrIndex];
          if (!k || k === dirScanState.rootKey) continue;
          await dirScanScanKey(k);
        }
      } finally {
        dirScanState.inFlight = false;
      }
    };

    const startDirScanFallback = () => {
      if (!watchUseDirScan) return;
      if (dirScanState.timer) return;
      // Kick an immediate tick so we don't wait a whole interval.
      void dirScanTick();
      dirScanState.timer = setInterval(() => { void dirScanTick(); }, dirScanIntervalMs);
      if (logActions) {
        logWatch(panel, `🔎 Dir-scan active: ${dirScanIntervalMs}ms (max ${dirScanMaxDirsPerTick} dirs/tick)`);
      }
    };

    watcher.on('add', fp => {
      debounceTrigger(fp, () => onDetected(fp));
    });
    watcher.on('change', async fp => {
      const basename = path.basename(fp);
      const lowerBase = basename.toLowerCase();
      if (lowerBase.endsWith('.done') || lowerBase.endsWith('.doneflag')) return;
      if (isMacSystemMetadataPath(fp)) return;
      if (isHiddenWithinWatchRoot(fp)) return;

      let force = false;
      if (useRegistry && watchSessionKey) {
        const signatureInfo = await getWatchSignatureInfo(fp);
        if (signatureInfo?.signature && !isWatchFileProcessed(registry, watchSessionKey, signatureInfo.signature)) {
          force = true;
        }
      }
      debounceTrigger(fp, () => onDetected(fp), { force });
    });
    watcher.on('addDir', async dir => {
        if (isMacSystemMetadataPath(dir)) return;
        if (isHiddenWithinWatchRoot(dir)) return;
        if (logActions) {
          const base = path.basename(dir);
          logWatch(panel, `📂 Folder detected: ${base}`);
        }
      const { files } = await getAllFilesRecursively(dir, dir, { includeHidden: !ignoreHidden });
      for (const { fullPath } of files) {
        const lower = fullPath.toLowerCase();
        if (lower.endsWith('.done') || lower.endsWith('.doneflag')) continue;
        debounceTrigger(fullPath, () => onDetected(fullPath));
      }
    });

    watcher.on('ready', () => {
      if (DEBUG_LOGS) {
        // Watcher ready message logged only in debug mode
      }
      if (watchUseDirScan) {
        startDirScanFallback();
      }
      if (logActions) {
        const mode = watchUsePolling ? 'polling' : 'native';
        const fsLabel = detectedFsType ? ` (${detectedFsType})` : '';
        const reason = watchBackendReason ? ` • ${watchBackendReason}` : '';
        const extra = watchUseDirScan ? ' + dirscan' : '';
        logWatch(panel, `🧭 Watch backend: ${mode}${fsLabel}${reason}${extra}`);
        logWatch(panel, `✅ Watcher ready: ${folder}`);
      }
    });

    watcher.on('error', err => {
      console.error('❌ chokidar error:', err);
        if (logActions) {
          logWatch(panel, `❌ Watcher error: ${err.message}`);
        }
    });
    ctx.instance = watcher;

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function stopWatchFolder(panel) {
  try {
    const panelKey = normalizeWatchPanelKey(panel);
    const sessionPanel = panelKey || panel;
    await stopWatchResources(sessionPanel);

    const normalizedPanel = panel === 'clone' ? 'ingest' : panel;
    let cancelledJobs = 0;
    let hasMatchingQueuedJob = false;
    if (queue && normalizedPanel && typeof queue.cancelJob === 'function') {
      for (const job of queue.pending.slice()) {
        if (job.panel === normalizedPanel) {
          hasMatchingQueuedJob = true;
          cancelledJobs += 1;
          queue.cancelJob(job.id);
        }
      }
      for (const [id, job] of queue.inProgress.entries()) {
        if (job.panel === normalizedPanel) {
          hasMatchingQueuedJob = true;
          cancelledJobs += 1;
          queue.cancelJob(id);
        }
      }
    }

    const session = getActiveWatchSession(sessionPanel);
    if (session) {
      session.stopRequested = true;
    }

    // Defer archiving the watch session log until watch-triggered jobs finish/cancel.
    // Otherwise, Stop Watching produces an incomplete watch log (missing verification/completion).
    try {
      const s = getActiveWatchSession(sessionPanel);
      if (s) {
        const pendingIds = new Set();

        if (queue) {
          for (const job of (queue.pending || [])) {
            if (isWatchJobForSession(s, job) && job.id) pendingIds.add(job.id);
          }
          const inProgressEntries = (queue.inProgress && typeof queue.inProgress.entries === 'function')
            ? Array.from(queue.inProgress.entries())
            : [];
          for (const [id, job] of inProgressEntries) {
            if (isWatchJobForSession(s, job) && id) pendingIds.add(id);
          }
        }

        s.finalizePending = pendingIds;
        if (pendingIds.size) {
          logWatch(sessionPanel, `🛑 Stop requested. Waiting for ${pendingIds.size} watch job(s) to finish/cancel before archiving this watch log…`);
          scheduleFinalizeWatchSession(sessionPanel);
        } else {
          finalizeWatchSession(sessionPanel).catch(() => {});
        }
      } else {
        finalizeWatchSession(sessionPanel).catch(() => {});
      }
    } catch {
      finalizeWatchSession(sessionPanel, { forced: true }).catch(() => {});
    }

    const cancelMap = {
      ingest: cancelIngest,
      transcode: cancelTranscode,
      clone: cancelClone,
      transcribe: cancelTranscribe,
      'adobe-utilities': cancelAdobeUtilities
    };

    const fn = cancelMap[panel];
    if (fn && hasMatchingQueuedJob) {
      fn();
    }

    return {
      watcherStopped: true,
      cancelledJobs,
      message: '🛑 Watcher stopped.'
    };
  } catch (err) {
    return `❌ Failed to stop watcher: ${err.message}`;
  }
}

function handleUICollapse(collapsed) {
  if (!mainWindow) return Promise.resolve();

  const next = !!collapsed;

  // Ignore redundant calls (e.g., switching panels while already expanded).
  // This prevents the window from snapping back to the default width.
  if (uiCollapsed === next) return Promise.resolve();

  uiCollapsed = next;
  const nonce = ++uiCollapseNonce;

  if (next) {
    const [w, h] = mainWindow.getSize();
    if (!firstPanelOpen) {
      // Save current size before collapsing
      lastExpandedSize = [w, h];
    }

    // Shrink to sidebar width
    return mainWindow.webContents
      .executeJavaScript(
        'Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)'
      )
      .then((sidebarWidth) => {
        // If another collapse/expand request happened after this one, ignore.
        if (nonce !== uiCollapseNonce) return;

        const width = Number.isFinite(sidebarWidth) && sidebarWidth > 0
          ? sidebarWidth
          : SIDEBAR_WIDTH;
        mainWindow.setResizable(false);
        mainWindow.setMinimumSize(width, 400);
        mainWindow.setMaximumSize(width, 10000);
        mainWindow.setSize(width, h, true);
      })
      .catch(() => {
        // Best-effort fallback if the sidebar DOM isn't ready.
        if (nonce !== uiCollapseNonce) return;
        mainWindow.setResizable(false);
        mainWindow.setMinimumSize(SIDEBAR_WIDTH, 400);
        mainWindow.setMaximumSize(SIDEBAR_WIDTH, 10000);
        mainWindow.setSize(SIDEBAR_WIDTH, mainWindow.getSize()[1], true);
      });
  }

  // Restore to last expanded (no hard cap)
  const [w, h] = lastExpandedSize;
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(980, 600);

  // Allow up to the current display's work area (so users can go wider).
  let maxW = 10000;
  let maxH = 10000;
  try {
    const display = screen.getDisplayMatching(mainWindow.getBounds());
    if (display?.workAreaSize?.width)  maxW = display.workAreaSize.width;
    if (display?.workAreaSize?.height) maxH = display.workAreaSize.height;
  } catch {}

  mainWindow.setMaximumSize(maxW, maxH);
  mainWindow.setSize(
    Math.min(w, maxW),
    Math.min(Math.max(h, 600), maxH),
    true
  );
  firstPanelOpen = false;
  return Promise.resolve();
}
