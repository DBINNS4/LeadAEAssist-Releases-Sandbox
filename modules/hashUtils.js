const crypto = require('crypto');
// Use Electron's unpatched fs when available so hashing works on `.asar` files
// in user folders (Electron's patched fs can treat `.asar` as a virtual dir).
const { fs } = require('../utils/nativeFs');

const isTestEnv = process.env.NODE_ENV === 'test';

function createAbortError(message = 'Operation canceled by user') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function bindAbortSignal(signal, stream) {
  if (!signal || typeof signal.addEventListener !== 'function' || !stream) return () => {};
  const handler = () => {
    try { stream.destroy(createAbortError()); } catch {}
  };
  signal.addEventListener('abort', handler, { once: true });
  return () => {
    try { signal.removeEventListener('abort', handler); } catch {}
  };
}

let Blake3Hasher;
let blake3Hash;
let blake3Available = true;
let xxhash, createXXHash64;
let xxhashReady = Promise.resolve(); // fallback
let xxhashAvailable = false;

// ✅ BLAKE3 init
try {
  ({ blake3: blake3Hash, Blake3Hasher } = require('@napi-rs/blake-hash'));
} catch (err) {
  blake3Available = false;
  console.warn(`⚠️ Failed to load @napi-rs/blake-hash: ${err.message}.`);
  blake3Hash = null;
  Blake3Hasher = null;
}

let resolveReady;
xxhashReady = new Promise(res => (resolveReady = res));

(async () => {
  try {
    const xx = await import('xxhash-wasm');
    const instance = await xx.default();

    // 🧪 Logging for verification
    if (!isTestEnv && process.env.DEBUG_LOGS) {
      // instance keys logged only in debug mode
    }

    // ✅ Use updated API from latest version
    xxhash = instance.h64Raw; 
    createXXHash64 = instance.create64;

    xxhashAvailable = typeof xxhash === 'function' && typeof createXXHash64 === 'function';

    if (!xxhashAvailable) {
      if (!isTestEnv) console.warn('⚠️ xxhash-wasm functions are still missing after updated init');
    } else {
      if (!isTestEnv && process.env.DEBUG_LOGS) {
        // dynamic init confirmed
      }
    }

    resolveReady(true);
  } catch (err) {
    if (!isTestEnv) console.warn('⚠️ Failed to dynamically initialize xxhash-wasm:', err.message);
    xxhashAvailable = false;
    resolveReady();
  }
})();

/**
 * 🔐 Generates hashes based on config flags.
 * @param {string} filePath
 * @param {object} verification - e.g. { useSha256, useMd5, useBlake3 }
 * @returns {Promise<object>} - e.g. { sha256, md5, blake3 }
 */
async function getHashes(filePath, verification, options = {}) {
  const results = {};

  if (options?.signal?.aborted) throw createAbortError();

  if (verification?.useSha256) {
    const hashResult = await getSha256Hash(filePath, options);
    results.sha256 = hashResult;
  }

  if (verification?.useMd5) {
    const hashResult = await getMd5Hash(filePath, options);
    results.md5 = hashResult;
  }

  if (verification?.useXxhash64) {
    const hashResult = await getXxHashHash(filePath, options);
    results.xxhash64 = hashResult;
  }

  if (verification?.useBlake3) {
    const hashResult = await getBlake3Hash(filePath, options);
    results.blake3 = hashResult;
  }

  return results;
}

/**
 * 🧮 Fast one-off checksum generator (non-streaming)
 * @param {string} filePath
 * @param {string} [method='sha256']
 * @returns {string}
 */
function generateChecksum(filePath, method = 'sha256', options = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(method);
    const stream = fs.createReadStream(filePath);
    const unbindAbort = bindAbortSignal(options?.signal, stream);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => { unbindAbort(); resolve(hash.digest('hex')); });
    stream.on('error', (err) => { unbindAbort(); reject(err); });
  });
}

/**
 * 🧬 Hybrid BLAKE3 hash: buffer mode for small, streaming for large files.
 * @param {string} filePath
 * @returns {Promise<{ hash: string, method: 'buffer' | 'streaming' }>}
 */
async function getBlake3Hash(filePath, options = {}) {
  if (options?.signal?.aborted) throw createAbortError();
  if (!blake3Available) {
    throw new Error('BLAKE3 unavailable');
  }

  const stats = fs.statSync(filePath);
  const TEN_MIB = 10 * 1024 * 1024;

  if (stats.size <= TEN_MIB) {
    if (options?.signal?.aborted) throw createAbortError();
    const buffer = fs.readFileSync(filePath);
    return {
      hash: blake3Hash(buffer).toString('hex'),
      method: 'buffer'
    };
  }

  // ✅ Clean, accurate log for large files using streaming hash
  if (!isTestEnv && process.env.DEBUG_LOGS) {
    // streaming hash path logged only in debug mode
  }

  return new Promise((resolve, reject) => {
    if (!Blake3Hasher) {
      reject(new Error('BLAKE3 unavailable'));
      return;
    }

    const hasher = new Blake3Hasher();
    const stream = fs.createReadStream(filePath);
    const unbindAbort = bindAbortSignal(options?.signal, stream);

    stream
      .on('data', chunk => hasher.update(chunk))
      .on('end', () => {
        unbindAbort();
        resolve({
          hash: hasher.digest('hex'),
          method: 'streaming'
        });
      })
      .on('error', (err) => { unbindAbort(); reject(err); });
  });
}

async function getSha256Hash(filePath, options = {}) {
  if (options?.signal?.aborted) throw createAbortError();
  const stats = fs.statSync(filePath);
  const TEN_MIB = 10 * 1024 * 1024;

  if (stats.size <= TEN_MIB) {
    if (options?.signal?.aborted) throw createAbortError();
    const buffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256');
    hash.update(buffer);
    return { hash: hash.digest('hex'), method: 'buffer' };
  }



 if (!isTestEnv && process.env.DEBUG_LOGS) {
   // using streaming SHA-256
 }

  return new Promise((resolve, reject) => {
    const sha256 = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    const unbindAbort = bindAbortSignal(options?.signal, stream);

    stream
      .on('data', chunk => sha256.update(chunk))
      .on('end', () => {
        unbindAbort();
        resolve({ hash: sha256.digest('hex'), method: 'streaming' });
      })
      .on('error', (err) => { try { if (typeof unbindAbort === 'function') unbindAbort(); } catch {} reject(err); });
  });
}

async function getMd5Hash(filePath, options = {}) {
  if (options?.signal?.aborted) throw createAbortError();
  const stats = fs.statSync(filePath);
  const TEN_MIB = 10 * 1024 * 1024;

  if (stats.size <= TEN_MIB) {
    if (options?.signal?.aborted) throw createAbortError();
    const buffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('md5');
    hash.update(buffer);
    return { hash: hash.digest('hex'), method: 'buffer' };
  }

  if (!isTestEnv && process.env.DEBUG_LOGS) {
    // using streaming MD5
  }

  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    const unbindAbort = bindAbortSignal(options?.signal, stream);

    stream
      .on('data', chunk => md5.update(chunk))
      .on('end', () => {
        unbindAbort();
        resolve({ hash: md5.digest('hex'), method: 'streaming' });
      })
      .on('error', (err) => { try { if (typeof unbindAbort === 'function') unbindAbort(); } catch {} reject(err); });
  });
}

async function getXxHashHash(filePath, options = {}) {
  if (options?.signal?.aborted) throw createAbortError();
  await xxhashReady;

  if (!xxhashAvailable) {
    if (!isTestEnv) console.warn('⚠️ xxhash64 functions not ready after init');
    return { hash: null, method: 'unavailable' };
  }

  const stats = fs.statSync(filePath);
  const TEN_MIB = 10 * 1024 * 1024;

  const toHex = value => {
    if (typeof value === 'number' || typeof value === 'bigint') {
      return value.toString(16).padStart(16, '0');
    }
    return Buffer.from(value).toString('hex');
  };

  if (stats.size <= TEN_MIB) {
    if (options?.signal?.aborted) throw createAbortError();
    const buffer = fs.readFileSync(filePath);
    return { hash: toHex(xxhash(new Uint8Array(buffer))), method: 'buffer' };
  }

  if (!isTestEnv && process.env.DEBUG_LOGS) {
    // using streaming xxHash64
  }

  return new Promise((resolve, reject) => {
    const hasher = createXXHash64();
    const stream = fs.createReadStream(filePath);
    const unbindAbort = bindAbortSignal(options?.signal, stream);

    stream
      .on('data', chunk => hasher.update(chunk))
      .on('end', () => {
        unbindAbort();
        const digest = hasher.digest();
        resolve({ hash: toHex(digest), method: 'streaming' });
      })
      .on('error', (err) => { try { if (typeof unbindAbort === 'function') unbindAbort(); } catch {} reject(err); });
  });
}

module.exports = {
  getHashes,
  generateChecksum,
  getBlake3Hash,
  getSha256Hash,
  getMd5Hash,
  getXxHashHash,
  blake3Available,
  xxhashReady,
  xxhashAvailable
};
