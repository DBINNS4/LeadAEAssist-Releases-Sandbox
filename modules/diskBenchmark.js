const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { execFile } = require('child_process');
const { promisify } = require('util');

const fsp = fs.promises;
const execFileAsync = promisify(execFile);

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 8 * BYTES_PER_MIB; // 8 MiB
const SEQUENTIAL_BENCHMARK_TEMP_FILE_COUNT = 3;
const SPEEDTEST_DIRNAME = '.lead-speedtest';
const SPEEDTEST_ACTIVE_PREFIX = '.__lead_speedtest_active_';
const SPEEDTEST_OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const SPEEDTEST_STALE_MIN_AGE_MS = 45 * 60 * 1000;
const SPEEDTEST_MARKER_STALE_MAX_AGE_MS = 60 * 60 * 1000;

function makeSpeedtestRunId(tag = '') {
  const safeTag = String(tag || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  return `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}${safeTag ? `_${safeTag}` : ''}`;
}

function isSpeedtestTempFile(name) {
  return (
    name.startsWith('lead_speedtest_')
    || name.startsWith('.__lead_speedtest_writecheck_')
    || name.startsWith('.__lead_speedtest_random_')
    || name.startsWith('.__speedtest_')
  );
}

function isSpeedtestActiveMarker(name) {
  return name.startsWith(SPEEDTEST_ACTIVE_PREFIX);
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch {
    // ignore
  }
}

async function ensureSpeedtestDir(basePath) {
  const dirPath = path.join(basePath, SPEEDTEST_DIRNAME);
  try {
    await fsp.mkdir(dirPath, { recursive: true });
  } catch {
    // ignore
  }
  return dirPath;
}

async function cleanupStaleSpeedtestFiles(dirPath, minAgeMs = SPEEDTEST_STALE_MIN_AGE_MS, options = {}) {
  try {
    await pruneStaleSpeedtestActiveMarkers(dirPath, options);
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && isSpeedtestActiveMarker(entry.name))) return;
    const staleBeforeMs = Date.now() - Math.max(0, Number(minAgeMs) || 0);

    await Promise.all(entries.map(async entry => {
      if (!entry.isFile()) return;
      if (!isSpeedtestTempFile(entry.name)) return;

      const entryPath = path.join(dirPath, entry.name);
      let stat;
      try {
        stat = await fsp.stat(entryPath);
      } catch {
        return;
      }
      if (!stat?.isFile?.() || stat.mtimeMs > staleBeforeMs) return;
      await safeUnlink(entryPath);
    }));

  } catch {
    // ignore
  }
}

async function createSpeedtestActiveMarker(dirPath, metadata = {}) {
  const runId = metadata?.runId || makeSpeedtestRunId(metadata?.tag || '');
  const name = `${SPEEDTEST_ACTIVE_PREFIX}${runId}.lock`;
  const markerPath = path.join(dirPath, name);
  const payload = {
    runId,
    tag: metadata?.tag || '',
    senderTag: metadata?.senderTag || '',
    senderId: metadata?.senderId ?? null,
    jobId: metadata?.jobId || '',
    pid: process.pid,
    createdAtMs: Date.now(),
    createdAt: new Date().toISOString()
  };
  try {
    await fsp.writeFile(markerPath, JSON.stringify(payload), { flag: 'wx' });
  } catch (error) {
    const markerError = new Error(`Failed to create speedtest marker: ${error?.message || String(error)}`);
    markerError.code = 'MARKER_CREATE_FAILED';
    markerError.cause = error;
    markerError.markerPath = markerPath;
    markerError.runId = runId;
    throw markerError;
  }
  return { markerPath, runId };
}

async function cleanupSpeedtestDirIfIdle(dirPath, options = {}) {
  try {
    await pruneStaleSpeedtestActiveMarkers(dirPath, options);
    let entries = await fsp.readdir(dirPath, { withFileTypes: true });

    // If another test is still active in this dir, don't touch it.
    if (entries.some(e => e.isFile() && isSpeedtestActiveMarker(e.name))) return;

    await Promise.all(entries.map(async entry => {
      if (!entry.isFile()) return;
      const name = entry.name;
      if (isSpeedtestTempFile(name) || SPEEDTEST_OS_JUNK.has(name)) {
        await safeUnlink(path.join(dirPath, name));
      }
    }));

    entries = await fsp.readdir(dirPath, { withFileTypes: true });
    if (entries.some(e => e.isFile() && isSpeedtestActiveMarker(e.name))) return;
    if (entries.length !== 0) return;

    await fsp.rmdir(dirPath);
  } catch {
    // ignore
  }
}

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function classifyStaleMarker({ payload, stat, maxAgeMs }) {
  if (!payload || typeof payload !== 'object') return 'malformed_payload';

  const createdAtMs = Number(payload.createdAtMs || Date.parse(payload.createdAt || ''));
  if (!Number.isFinite(createdAtMs)) return 'malformed_created_at';
  if ((Date.now() - createdAtMs) > maxAgeMs) return 'marker_expired';

  if (payload.pid != null && !isProcessAlive(payload.pid)) return 'dead_pid';

  if (stat && Number.isFinite(stat.mtimeMs) && (Date.now() - stat.mtimeMs) > maxAgeMs) return 'marker_file_expired';
  return null;
}

async function pruneStaleSpeedtestActiveMarkers(dirPath, options = {}) {
  const maxAgeMs = options?.maxAgeMs ?? SPEEDTEST_MARKER_STALE_MAX_AGE_MS;
  const logger = options?.logger;

  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    let reclaimedCount = 0;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !isSpeedtestActiveMarker(entry.name)) return;

      const markerPath = path.join(dirPath, entry.name);
      let stat = null;
      try {
        stat = await fsp.stat(markerPath);
      } catch {
        return;
      }

      let payload = null;
      try {
        const raw = await fsp.readFile(markerPath, 'utf8');
        payload = JSON.parse(raw);
      } catch {
        // leave payload null to classify malformed markers
      }

      const reason = classifyStaleMarker({ payload, stat, maxAgeMs });
      if (!reason) return;

      logger?.warn?.('Reclaimed stale speedtest marker', {
        reason,
        markerPath,
        runId: payload?.runId || null,
        senderTag: payload?.senderTag || null,
        senderId: payload?.senderId ?? null,
        jobId: payload?.jobId || null,
        pid: payload?.pid ?? null
      });

      await safeUnlink(markerPath);
      reclaimedCount += 1;
    }));

    if (reclaimedCount > 0) {
      logger?.info?.('Completed stale speedtest marker cleanup', { dirPath, reclaimedCount });
    }

  } catch {
    // ignore
  }
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function makeProgressEmitter(onProgressBytes, {
  minBytes = 8 * BYTES_PER_MIB,
  minIntervalMs = 120
} = {}) {
  if (typeof onProgressBytes !== 'function') return null;
  let pending = 0;
  let lastSentAt = performance.now();

  const emit = (force = false) => {
    if (pending <= 0) return;
    const now = performance.now();
    const due = force || pending >= minBytes || (now - lastSentAt) >= minIntervalMs;
    if (!due) return;
    try {
      onProgressBytes(pending);
    } catch {
      // Never let UI reporting break the benchmark.
    }
    pending = 0;
    lastSentAt = now;
  };

  return {
    add(bytes) {
      const n = Number(bytes) || 0;
      if (n <= 0) return;
      pending += n;
      emit(false);
    },
    flush() {
      emit(true);
    }
  };
}

async function writeSequential(filePath, fileSizeBytes, { chunkSizeBytes = DEFAULT_CHUNK_SIZE, throwIfCancelled, onProgressBytes, progressMinBytes, progressMinIntervalMs } = {}) {
  let fh;
  const chunkSize = Math.min(chunkSizeBytes, fileSizeBytes);
  const wbuf = Buffer.alloc(chunkSize, 0xaa);
  const ignorableFlushCodes = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);
  const isIgnorableFlushError = error => Boolean(error && ignorableFlushCodes.has(error.code));
  const progress = makeProgressEmitter(onProgressBytes, { minBytes: progressMinBytes, minIntervalMs: progressMinIntervalMs });

  const start = performance.now();
  try {
    fh = await fsp.open(filePath, 'w');

    let offset = 0;
    while (offset < fileSizeBytes) {
      throwIfCancelled?.();

      const remaining = fileSizeBytes - offset;
      const chunk = remaining < wbuf.length ? wbuf.subarray(0, remaining) : wbuf;
      const { bytesWritten } = await fh.write(chunk, 0, chunk.length, offset);
      if (bytesWritten <= 0) throw new Error('Write failed (0 bytes written)');
      offset += bytesWritten;
      progress?.add(bytesWritten);
    }

    // ✅ Force bytes to stable storage (prevents page-cache / write-back illusions)
    if (typeof fh.datasync === 'function') {
      try {
        await fh.datasync();
      } catch (error) {
        if (!isIgnorableFlushError(error)) throw error;
        try {
          await fh.sync?.();
        } catch (syncError) {
          if (!isIgnorableFlushError(syncError)) throw syncError;
        }
      }
    } else if (typeof fh.sync === 'function') {
      try {
        await fh.sync();
      } catch (error) {
        if (!isIgnorableFlushError(error)) throw error;
      }
    }

    // Flush any remaining progress only AFTER the storage flush completes.
    progress?.flush();
  } finally {
    try {
      // Best-effort: if we exit early (cancel/error), reflect last partial bytes.
      progress?.flush();
      await fh?.close();
    } catch {
      // ignore
    }
  }
  const end = performance.now();

  return (fileSizeBytes / BYTES_PER_MIB) / ((end - start) / 1000); // MiB/s
}

async function readSequential(filePath, fileSizeBytes, { chunkSizeBytes = DEFAULT_CHUNK_SIZE, throwIfCancelled, onProgressBytes, progressMinBytes, progressMinIntervalMs } = {}) {
  let fh;
  const chunkSize = Math.min(chunkSizeBytes, fileSizeBytes);
  const rbuf = Buffer.alloc(chunkSize);
  const progress = makeProgressEmitter(onProgressBytes, { minBytes: progressMinBytes, minIntervalMs: progressMinIntervalMs });

  const start = performance.now();
  try {
    fh = await fsp.open(filePath, 'r');

    let offset = 0;
    while (offset < fileSizeBytes) {
      throwIfCancelled?.();

      const remaining = fileSizeBytes - offset;
      const toRead = Math.min(rbuf.length, remaining);
      const { bytesRead } = await fh.read(rbuf, 0, toRead, offset);
      if (bytesRead <= 0) throw new Error('Read failed/EOF before expected size');
      offset += bytesRead;
      progress?.add(bytesRead);
    }
    progress?.flush();
  } finally {
    try {
      progress?.flush();
      await fh?.close();
    } catch {
      // ignore
    }
  }
  const end = performance.now();

  return (fileSizeBytes / BYTES_PER_MIB) / ((end - start) / 1000); // MiB/s
}

async function runCacheDropIfSupported() {
  if (process.platform === 'linux') {
    try {
      await fsp.access('/proc/sys/vm/drop_caches', fs.constants.W_OK);
      await fsp.writeFile('/proc/sys/vm/drop_caches', '3\n');
      return { attempted: true, applied: true, method: 'linux_drop_caches', reason: null };
    } catch (error) {
      return {
        attempted: true,
        applied: false,
        method: 'linux_drop_caches',
        reason: error?.message || String(error)
      };
    }
  }

  if (process.platform === 'darwin') {
    // In packaged Electron apps, PATH can be minimal/empty. Prefer an absolute path.
    // Fall back to plain 'purge' only if the absolute path isn't found.
    const candidates = ['/usr/bin/purge', 'purge'];
    let lastError = null;

    for (const cmd of candidates) {
      try {
        await execFileAsync(cmd);
        return { attempted: true, applied: true, method: 'darwin_purge', reason: null };
      } catch (error) {
        lastError = error;
        // If the command is missing, try the next candidate.
        if (error?.code === 'ENOENT') continue;
        // Any other failure (permissions, exit code, etc.) is a real failure—stop here.
        return {
          attempted: true,
          applied: false,
          method: 'darwin_purge',
          reason: error?.message || String(error)
        };
      }
    }

    return {
      attempted: true,
      applied: false,
      method: 'darwin_purge',
      reason: lastError?.message || String(lastError || 'purge not found')
    };
  }

  return {
    attempted: false,
    applied: false,
    method: 'not_supported',
    reason: `No privileged cache-drop API for platform: ${process.platform}`
  };
}

/**
 * Runs a sequential write + read benchmark in a target folder.
 * Notes:
 *  - Writes are flushed to stable storage (datasync/sync).
 *  - Reads can still be influenced by OS cache; staggering reads helps avoid the worst-case "immediate cached read."
 */
async function runSequentialDriveTest({
  drivePath,
  testSizeMiB = 1024,
  iterations = 5,
  senderTag = '0',
  senderId,
  jobId,
  logger,
  onProgressBytes,
  throwIfCancelled
} = {}) {
  if (!drivePath) throw new Error('Missing drivePath');

  const sizeMiB = clampInt(testSizeMiB, 1, 2048);
  const fileSizeBytes = sizeMiB * BYTES_PER_MIB;
  const speedtestDir = await ensureSpeedtestDir(drivePath);
  let activeMarkerPath = null;
  let runId;
  try {
    ({ markerPath: activeMarkerPath, runId } = await createSpeedtestActiveMarker(speedtestDir, {
      tag: 'seq',
      senderTag,
      senderId,
      jobId
    }));
  } catch (error) {
    if (error?.code === 'MARKER_CREATE_FAILED') {
      return {
        success: false,
        code: 'MARKER_CREATE_FAILED',
        error: 'Unable to acquire benchmark lock marker. Aborting speed test safely.',
        details: error?.message || String(error)
      };
    }
    throw error;
  }
  await cleanupStaleSpeedtestFiles(speedtestDir, SPEEDTEST_STALE_MIN_AGE_MS, { logger });

  const tmpFiles = Array.from({ length: SEQUENTIAL_BENCHMARK_TEMP_FILE_COUNT }, (_, index) => {
    const suffix = String.fromCharCode(97 + index); // a, b, c...
    return path.join(speedtestDir, `lead_speedtest_${senderTag}_${runId}_seq_${suffix}.tmp`);
  });

  const writeSpeeds = [];
  const readSpeeds = [];

  const readLagIterations = Math.min(2, Math.max(1, tmpFiles.length - 1));
  const pendingReadQueue = [];
  const cacheDropResult = await runCacheDropIfSupported();
  const cacheMitigation = {
    attempted: true,
    platform: process.platform,
    strategy: 'expanded_working_set_with_platform_drop',
    workingSetFiles: tmpFiles.length,
    readLagIterations,
    platformDropAttempted: cacheDropResult.attempted,
    platformDropApplied: cacheDropResult.applied,
    platformDropMethod: cacheDropResult.method,
    details: cacheDropResult.reason || null,
    fullyApplied: cacheDropResult.applied
  };

  try {
    for (let run = 0; run < iterations; run++) {
      throwIfCancelled?.();

      const curFile = tmpFiles[run % tmpFiles.length];
      await safeUnlink(curFile);

      const w = await writeSequential(curFile, fileSizeBytes, { throwIfCancelled, onProgressBytes });
      writeSpeeds.push(w);
      pendingReadQueue.push(curFile);

      // Stagger reads with a larger lag to reduce warm-cache bias.
      if (pendingReadQueue.length > readLagIterations) {
        const readTarget = pendingReadQueue.shift();
        const r = await readSequential(readTarget, fileSizeBytes, { throwIfCancelled, onProgressBytes });
        readSpeeds.push(r);
        await safeUnlink(readTarget);
      }
    }

    // Final read to balance phases
    while (pendingReadQueue.length > 0) {
      const readTarget = pendingReadQueue.shift();
      const r = await readSequential(readTarget, fileSizeBytes, { throwIfCancelled, onProgressBytes });
      readSpeeds.push(r);
      await safeUnlink(readTarget);
    }
  } finally {
    // Best-effort cleanup
    await Promise.all(tmpFiles.map(safeUnlink));
    if (activeMarkerPath) {
      await safeUnlink(activeMarkerPath);
    }
    await cleanupSpeedtestDirIfIdle(speedtestDir, { logger });
  }

  // Drop warm-up run (first measurement) when we have more than one sample.
  if (writeSpeeds.length > 1) {
    writeSpeeds.shift();
  }
  if (readSpeeds.length > 1) {
    readSpeeds.shift();
  }

  if (writeSpeeds.length === 0 || readSpeeds.length === 0) {
    return { success: false, code: 'INSUFFICIENT_SAMPLES' };
  }

  return {
    success: true,
    write: avg(writeSpeeds).toFixed(1),
    writeMin: Math.min(...writeSpeeds).toFixed(1),
    writeMax: Math.max(...writeSpeeds).toFixed(1),
    read: avg(readSpeeds).toFixed(1),
    readMin: Math.min(...readSpeeds).toFixed(1),
    readMax: Math.max(...readSpeeds).toFixed(1),
    cacheMitigation
  };
}

async function estimateSequentialWriteSpeedMiBps(destFolder, sizeMiB = 25, { throwIfCancelled } = {}) {
  if (!destFolder) throw new Error('Missing destFolder');

  const testMiB = clampInt(sizeMiB, 1, 256);
  const fileSizeBytes = testMiB * BYTES_PER_MIB;
  const speedtestDir = await ensureSpeedtestDir(destFolder);
  let activeMarkerPath = null;
  let runId;
  try {
    ({ markerPath: activeMarkerPath, runId } = await createSpeedtestActiveMarker(speedtestDir, {
      tag: 'estimate'
    }));
  } catch (error) {
    if (error?.code === 'MARKER_CREATE_FAILED') {
      return {
        success: false,
        code: 'MARKER_CREATE_FAILED',
        error: 'Unable to acquire benchmark lock marker. Aborting write speed estimate safely.',
        details: error?.message || String(error)
      };
    }
    throw error;
  }
  await cleanupStaleSpeedtestFiles(speedtestDir);
  const tmpFile = path.join(speedtestDir, `.__speedtest_${runId}.tmp`);

  try {
    return await writeSequential(tmpFile, fileSizeBytes, { throwIfCancelled });
  } finally {
    await safeUnlink(tmpFile);
    if (activeMarkerPath) {
      await safeUnlink(activeMarkerPath);
    }
    await cleanupSpeedtestDirIfIdle(speedtestDir);
  }
}

module.exports = {
  runSequentialDriveTest,
  estimateSequentialWriteSpeedMiBps,
  SEQUENTIAL_BENCHMARK_TEMP_FILE_COUNT,
  __private: {
    SPEEDTEST_STALE_MIN_AGE_MS,
    ensureSpeedtestDir,
    cleanupStaleSpeedtestFiles,
    createSpeedtestActiveMarker,
    cleanupSpeedtestDirIfIdle,
    makeSpeedtestRunId
  }
};
