const fs = require('fs');
const path = require('path');
const { estimateSequentialWriteSpeedMiBps } = require('./diskBenchmark');

// Cache disk speed results so repeated jobs (especially watch-triggered bursts)
// don't re-run the benchmark over and over.
//
// Keying by device id (when available) makes this resilient to per-job subfolders
// (autoFolder, date-stamped destinations, etc.) that live on the same volume.
const SPEED_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const speedCache = new Map();

function getSpeedCacheKey(destFolder) {
  if (!destFolder) return null;
  let dev = null;
  try {
    dev = fs.statSync(destFolder)?.dev;
  } catch {
    dev = null;
  }

  let root = '';
  try {
    root = path.parse(path.resolve(destFolder)).root || '';
  } catch {
    root = '';
  }

  // When dev isn't available/meaningful, root still helps separate Windows volumes.
  return `${dev ?? 'na'}|${root}`;
}

/**
 * ⚡ Estimates disk write speed by doing a small sequential write test (flushed to disk).
 * @param {string} destFolder - Destination directory to test
 * @param {number} sizeInMB - Size of the test file in MiB (binary "MB") for legacy reasons
 * @returns {Promise<number>} - Estimated speed in MiB/s (rounded down)
 */
async function estimateDiskWriteSpeed(destFolder, sizeInMB = 25, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {};
  const useCache = opts.useCache !== false;
  const ttlMs = Number.isFinite(opts.cacheTtlMs) ? Math.max(0, opts.cacheTtlMs) : SPEED_CACHE_TTL_MS;

  const cacheKey = useCache ? getSpeedCacheKey(destFolder) : null;
  const now = Date.now();

  if (cacheKey) {
    const cached = speedCache.get(cacheKey);
    if (cached && (now - cached.at) < ttlMs && Number.isFinite(cached.speed)) {
      return cached.speed;
    }
  }

  const speedResult = await estimateSequentialWriteSpeedMiBps(destFolder, sizeInMB, opts);

  if (Number.isFinite(speedResult)) {
    const floored = Math.floor(speedResult);

    if (cacheKey && Number.isFinite(floored)) {
      speedCache.set(cacheKey, { speed: floored, at: now, destFolder });
    }

    return floored;
  }

  if (speedResult && typeof speedResult === 'object' && speedResult.success === false) {
    const err = new Error(speedResult.message || speedResult.error || 'Disk benchmark failed');
    if (speedResult.code) err.code = speedResult.code;
    if (speedResult.details !== undefined) err.details = speedResult.details;
    throw err;
  }

  throw new Error('Unexpected disk benchmark return payload');
}

module.exports = {
  estimateDiskWriteSpeed
};
