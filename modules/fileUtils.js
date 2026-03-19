// IMPORTANT: use Electron's unpatched fs when available so `.asar` files in user
// folders are treated as regular files (not virtual directories).
const { fs, fsp } = require('../utils/nativeFs');
const path = require('path');
const { buildScanFilter } = require('../utils/scanFilters');
const { moveReplace, uniqueTempPath } = require('../utils/fsSafe');
const { generateChecksum } = require('./hashUtils');

/**
 * 📂 Recursively yields files **and** directories from a directory.
 * @param {string} dir
 * @returns {AsyncGenerator<{ fullPath: string, relativePath: string, isDirectory: boolean }>}
 */
async function* getAllItemsRecursively(dir, base = dir, options = {}) {
  const scanFilter = buildScanFilter(options);
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(0, options.maxDepth) : Infinity;
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, options.maxEntries) : Infinity;
  const onError = typeof options.onError === 'function' ? options.onError : null;  
  const signal = options.signal;
  let yielded = 0;

  const stack = [{
    dir,
    depth: 0,
    entries: null,
    index: 0
  }];

  while (stack.length > 0) {
    if (signal?.aborted) return;
    if (yielded >= maxEntries) return;

    const frame = stack[stack.length - 1];
    if (!frame.entries) {
      try {
        // Use dirents to reduce unnecessary stat calls when possible.
        frame.entries = await fsp.readdir(frame.dir, { withFileTypes: true });
      } catch (err) {
        if (onError) {
          try { onError(frame.dir, err); } catch {}
        }        // Skip unreadable system folders like .Spotlight-V100
        stack.pop();
        continue;
      }
    }

    if (frame.index >= frame.entries.length) {
      stack.pop();
      continue;
    }

    const entry = frame.entries[frame.index++];
    const name = entry?.name ?? String(entry);
    const isDirHint = typeof entry?.isDirectory === 'function' ? entry.isDirectory() : false;

    if (scanFilter.shouldSkipEntry(name, isDirHint)) continue;

    const fullPath = path.join(frame.dir, name);
    let stat;

    try {
      // Use lstat first so we can detect symlinks before any recursion.
      stat = await fsp.lstat(fullPath);
    } catch (err) {
      if (onError) {
        try { onError(fullPath, err); } catch {}
      }      continue; // Skip items that throw errors
    }

    // Policy: skip symlinks entirely to avoid cycles and out-of-root traversal.
    if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
      continue;
    }

    const isDirectory = stat.isDirectory();
    yield {
      fullPath,
      relativePath: path.relative(base, fullPath),
      isDirectory
    };
    yielded += 1;

    if (isDirectory && frame.depth < maxDepth) {
      stack.push({
        dir: fullPath,
        depth: frame.depth + 1,
        entries: null,
        index: 0
      });
    }
  }
}

/**
 * 📂 Recursively gathers files and directories, separated into lists
 * @param {string} dir
 * @param {string} [base=dir]
 * @returns {{ files: Array<{fullPath: string, relativePath: string}>, dirs: Array<{fullPath: string, relativePath: string}> }}
 */
async function getAllFilesRecursively(dir, base = dir, options = {}) {
  const files = [];
  const dirs = [];
  for await (const item of getAllItemsRecursively(dir, base, options)) {
    if (item.isDirectory) {
      dirs.push({ fullPath: item.fullPath, relativePath: item.relativePath });
    } else {
      files.push({ fullPath: item.fullPath, relativePath: item.relativePath });
    }
  }
  return { files, dirs };
}

/**
 * 🧪 Copy a file and optionally verify checksum
 * @param {string} src - Source file
 * @param {string} dest - Destination path
 * @param {string} method - Checksum method
 * @returns {Promise<void>}
 */
async function copyFileWithVerification(src, dest, method = 'sha256') {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);

  const [srcHash, destHash] = await Promise.all([
    generateChecksum(src, method),
    generateChecksum(dest, method)
  ]);

  if (srcHash !== destHash) {
    await fsp.unlink(dest); // Remove bad copy
    throw new Error(`Checksum mismatch for ${path.basename(src)}`);
  }
}

/**
 * 🚀 Copy a file with progress callback
 * @param {string} src - Source file
 * @param {string} dest - Destination path
 * @param {function} progressCallback - (percent) => void
 * @param {string} id - optional file id
 * @returns {Promise<void>}
 */
async function copyFileWithProgress(src, dest, progressCallback, signal) {
  const srcStat = await fsp.stat(src);
  const { size: totalSize } = srcStat;
  let transferred = 0;

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  // Copy into a temp file in the same directory, then move into place.
  // This avoids leaving a truncated/corrupt destination if the copy is aborted or errors mid-stream.
  const tempDest = uniqueTempPath(dest, '.__copytmp__');

  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(src, { highWaterMark: 64 * 1024 });
    const write = fs.createWriteStream(tempDest);

    let finished = false;
    let settled = false;

    // Async best-effort cleanup: do not block the event loop with unlinkSync on large files.
    const cleanupTemp = async () => {
      try { await fsp.unlink(tempDest); } catch {}
    };

    const reportProgress = (deltaBytes) => {
      const percent = totalSize > 0
        ? (Math.floor((transferred / totalSize) * 1000) / 10)
        : 100;
      try { progressCallback(percent, deltaBytes); } catch {}
    };

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      try { read.destroy(); } catch {}
      try { write.destroy(); } catch {}
      if (signal) {
        try { signal.removeEventListener('abort', abortHandler); } catch {}
      }
      // Cleanup async to avoid freezing main thread on large partial files.
      cleanupTemp().finally(() => {
        reject(new Error('Copy canceled by user'));
      });
    };

    if (signal) {
      if (signal.aborted) return abortHandler();
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    read.on('data', chunk => {
      transferred += chunk.length;
      reportProgress(chunk.length);
    });

    const onError = (err) => {
      if (settled) return;
      settled = true;
      try { read.destroy(); } catch {}
      try { write.destroy(); } catch {}
      if (signal) {
        try { signal.removeEventListener('abort', abortHandler); } catch {}
      }
      // Cleanup async to avoid freezing main thread on large partial files.
      cleanupTemp().finally(() => {
        reject(err);
      });
    };

    read.on('error', onError);
    write.on('error', onError);

    write.on('finish', () => {
      finished = true;
    });

    write.on('close', async () => {
      if (!finished) return;
      if (settled) return;
      settled = true;

      if (signal) {
        try { signal.removeEventListener('abort', abortHandler); } catch {}
      }

      try {
        await moveReplace(tempDest, dest);
        try {
          await fsp.utimes(dest, srcStat.atime, srcStat.mtime);
        } catch {}
        try {
          if (typeof srcStat.mode === 'number') {
            await fsp.chmod(dest, srcStat.mode);
          }
        } catch {}
        try { progressCallback(100, 0); } catch {}
        resolve();
      } catch (err) {
        cleanupTemp().finally(() => {
          reject(err);
        });
      }
    });

    // Emit an initial snapshot so UI can move off 0% immediately.
    reportProgress(0);

    read.pipe(write);
  });
}


/**
 * 🧵 Run async tasks with concurrency limit
 * @param {Function[]} tasks - Array of async functions
 * @param {number} limit - Concurrency limit
 */
async function runWithConcurrencyLimit(tasks, limit = 3, options = {}) {
  const results = [];
  const signal = (options && typeof options === 'object') ? options.signal : null;
  limit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 1;
  let index = 0;

  async function worker(id) {
    while (true) {
      if (signal?.aborted) break;
      const current = index++;
      if (current >= tasks.length) break;
      try {
        await tasks[current](id);
        results[current] = { success: true };
      } catch (err) {
        results[current] = { success: false, error: err.message };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < limit; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);
  return results;
}

/**
 * 📂 Recursively gathers files, but only within allowed folders.
 * This version is safe for Clone panel without affecting Ingest.
 *
 * @param {string} dir
 * @param {string} base
 * @param {string[]} allowedFolders
 * @returns {Promise<Array<{ fullPath: string, relativePath: string }>>}
 */
async function getFilteredFilesRecursively(dir, base = dir, allowedFolders = [], options = {}) {
  const scanFilter = buildScanFilter(options);

  const isAllowedDir = (p) => allowedFolders.some(allowed =>
    p === allowed || p.startsWith(allowed + path.sep)
  );

  const results = [];

  const walk = async (currentDir) => {
    if (!isAllowedDir(currentDir)) return;

    let list;
    try {
      list = await fsp.readdir(currentDir);
    } catch {
      return;
    }

    for (const name of list) {
      // Fast reject (no stat) for common ignores.
      if (scanFilter.shouldSkipEntry(name, false)) continue;

      const fullPath = path.join(currentDir, name);
      let stat;

      try {
        stat = await fsp.stat(fullPath);
      } catch {
        continue;
      }

      if (scanFilter.shouldSkipEntry(name, stat.isDirectory())) continue;

      if (stat.isDirectory()) {
        await walk(fullPath);
      } else {
        results.push({
          fullPath,
          relativePath: path.relative(base, fullPath),
        });
      }
    }
  };

  await walk(dir);
  return results;
}

/**
 * 📏 Preloads file sizes into a Map
 * @param {Array<{ fullPath: string }>} files
 * @returns {Map<string, number>}
 */
async function preloadFileSizes(files, logCallback, options = {}) {
  const map = new Map();
  const signal = (options && typeof options === 'object') ? options.signal : null;

  for (const file of files) {
    if (signal?.aborted) break;
    try {
      const { size } = await fsp.stat(file.fullPath);
      map.set(file.fullPath, size);
    } catch (err) {
      const msg = `⚠️ Failed to stat ${file.fullPath}: ${err.message}`;
      if (typeof logCallback === 'function') {
        logCallback(msg);
      } else {
        console.warn(msg);
      }
    }
  }

  return map;
}

/**
 * ⏳ Waits until a file's size and modified time stop changing.
 *
 * @param {string} filePath - Path to file.
 * @param {number} interval - Poll interval in ms.
 * @param {number} stableChecks - Number of matching checks before resolving.
 * @returns {Promise<boolean>} Resolves true if stable before retries run out.
 */
async function waitForStableFile(filePath, interval = 2000, stableChecks = 5, options = {}) {
  if (process.env.DEBUG_LOGS) {
    // Checking file stability
  }
  const opts = (options && typeof options === 'object') ? options : {};
  const signal = opts.signal;
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? Math.max(0, opts.maxWaitMs) : (10 * 60 * 1000); // 10 min default
  const startedAt = Date.now();

  const sleep = (ms) => new Promise(resolve => {
    if (!signal) return setTimeout(resolve, ms);
    if (signal.aborted) return resolve();

    let done = false;
    let t;

    const finish = () => {
      if (done) return;
      done = true;
      try { signal.removeEventListener('abort', onAbort); } catch {}
      resolve();
    };

    const onAbort = () => {
      if (t) clearTimeout(t);
      finish();
    };

    t = setTimeout(finish, ms);
    signal.addEventListener('abort', onAbort, { once: true });

    // If it aborted in the tiny race window between our first check and addEventListener
    if (signal.aborted) onAbort();
  });

  let prevSig = null;          // `${size}|${mtimeMs}`
  let consecutiveMatches = 0;
  let sawStat = false;

  const readSig = async () => {
    const { size, mtimeMs } = await fs.promises.stat(filePath);
    if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) throw new Error('invalid stat');
    return `${size}|${mtimeMs}`;
  };

  try { prevSig = await readSig(); sawStat = true; } catch { prevSig = null; }

  while (consecutiveMatches < stableChecks) {
    if (signal?.aborted) return false;
    if ((Date.now() - startedAt) > maxWaitMs) return false;

    await sleep(interval);

    if (signal?.aborted) return false;
    if ((Date.now() - startedAt) > maxWaitMs) return false;

    let currentSig = null;
    try {
      currentSig = await readSig();
      sawStat = true;
    } catch (err) {
      // If the file existed at least once and then disappears, treat that as
      // moved/renamed (common when writers use ".partial" then rename).
      if (err && err.code === 'ENOENT' && sawStat) {
        return false;
      }
      // Missing / unreadable != stable.
      consecutiveMatches = 0;
      prevSig = null;
      continue;
    }

    if (prevSig && currentSig === prevSig) {
      consecutiveMatches++;
    } else {
      consecutiveMatches = 0;
      prevSig = currentSig;
    }
  }

  if (process.env.DEBUG_LOGS) {
    // File confirmed stable
  }
  return sawStat;
}

module.exports = {
  getAllFilesRecursively,
  getAllItemsRecursively,
  getFilteredFilesRecursively,
  copyFileWithProgress,
  copyFileWithVerification,
  runWithConcurrencyLimit,
  preloadFileSizes,
  waitForStableFile
};
