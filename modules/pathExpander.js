const fs = require('fs');
const path = require('path');
const { isMainThread, parentPort, workerData, Worker } = require('worker_threads');

const DEFAULT_OPTIONS = {
  maxDepth: 6,
  maxFiles: 5000,
  timeoutMs: 15000,
  skipHidden: true
};

function normalizeExtensions(extensions = []) {
  return Array.from(
    new Set(
      (Array.isArray(extensions) ? extensions : [])
        .map(ext => String(ext || '').trim())
        .filter(Boolean)
        .map(ext => (ext.startsWith('.') ? ext : `.${ext}`))
        .map(ext => ext.toLowerCase())
        .filter(ext => ext.length > 1)
    )
  );
}

function matchesExtensions(filePath, extensions = []) {
  if (!extensions.length) return true;
  const lower = String(filePath || '').toLowerCase();
  return extensions.some(ext => lower.endsWith(ext));
}

async function traversePaths(paths = [], options = {}) {
  const { maxDepth, maxFiles, timeoutMs, skipHidden, includeExtensions, includeMetadata } = {
    ...DEFAULT_OPTIONS,
    ...(options || {})
  };
  const normalizedExtensions = normalizeExtensions(includeExtensions);

  const files = [];
  const metadataByPath = includeMetadata ? {} : null;
  const queue = Array.isArray(paths)
    ? paths.filter(Boolean).map(p => ({ p, depth: 0 }))
    : [];
  const startedAt = Date.now();
  let truncated = false;
  let timedOut = false;

  while (queue.length > 0) {
    if (timeoutMs && Date.now() - startedAt > timeoutMs) {
      timedOut = true;
      break;
    }

    const { p, depth } = queue.shift();

    try {
      const stat = await fs.promises.lstat(p);

      // Do not follow symlinks at all – avoids cycles and surprises
      if (stat.isSymbolicLink()) {
        if (matchesExtensions(p, normalizedExtensions)) {
          files.push(p);
          if (metadataByPath) {
            metadataByPath[p] = {
              size: Number(stat.size) || 0,
              mtimeMs: Number(stat.mtimeMs) || 0
            };
          }
        }
      } else if (stat.isDirectory()) {
        if (depth >= maxDepth) continue;

        const entries = await fs.promises.readdir(p, { withFileTypes: true });
        for (const entry of entries) {
          if (skipHidden && entry.name.startsWith('.')) continue;
          const nextPath = path.join(p, entry.name);
          queue.push({ p: nextPath, depth: depth + 1 });
        }
      } else if (matchesExtensions(p, normalizedExtensions)) {
        files.push(p);
        if (metadataByPath) {
          metadataByPath[p] = {
            size: Number(stat.size) || 0,
            mtimeMs: Number(stat.mtimeMs) || 0
          };
        }
      }

      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    } catch {
      if (matchesExtensions(p, normalizedExtensions)) {
        files.push(p);
        if (metadataByPath) {
          metadataByPath[p] = null;
        }
      }
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }

    // Yield to event loop to keep worker responsive
    await new Promise(resolve => setImmediate(resolve));
  }

  const result = { files, truncated, timedOut };
  if (metadataByPath) {
    result.metadataByPath = metadataByPath;
  }
  return result;
}

function runWorker() {
  if (!parentPort) return;
  traversePaths(workerData?.paths, workerData?.options)
    .then(result => parentPort.postMessage({ type: 'success', result }))
    .catch(error =>
      parentPort.postMessage({ type: 'error', error: error?.message || String(error) })
    );
}

async function expandPaths(paths, options = {}) {
  const safePaths = Array.isArray(paths) ? paths : [];

// Resolve worker script explicitly; in packaged builds this must point at the unpacked file.
// (Worker threads can be picky about loading scripts from inside app.asar.)
let workerScript = path.join(__dirname, 'pathExpander.js');
if (workerScript.includes('.asar')) {
  workerScript = workerScript.replace(/\.asar([\\/])/, '.asar.unpacked$1');
}

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerScript, {
      workerData: {
        paths: safePaths,
        options
      }
    });

    let timeoutId;
    const timeoutMs = options?.timeoutMs || DEFAULT_OPTIONS.timeoutMs;

    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        worker.terminate();
        resolve({ files: [], truncated: true, timedOut: true });
      }, timeoutMs + 100);
    }

    worker.on('message', msg => {
      clearTimeout(timeoutId);
      if (msg?.type === 'success') {
        resolve(msg.result || { files: [] });
      } else {
        reject(new Error(msg?.error || 'Path expansion failed'));
      }
    });

    worker.on('error', err => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

if (!isMainThread) {
  runWorker();
}

module.exports = {
  expandPaths,
  traversePaths,
  DEFAULT_OPTIONS
};
