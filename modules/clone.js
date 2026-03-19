const ProgressManager = require('../utils/progressManager');
// IMPORTANT: use Electron's unpatched fs when available so `.asar` files in user
// folders are treated as regular files (not virtual directories).
const { fs, fsp } = require('../utils/nativeFs');
const path = require('path');
const { buildScanFilter } = require('../utils/scanFilters');
const net = require('net');
const { BrowserWindow, dialog } = require('electron');
// Helper to always target the main window, even when DevTools has focus
const getMainWindow = () => global.mainWindow || BrowserWindow.getAllWindows()[0];
const { sendLogMessage, writeLogToFile, createJobLogger, createJobUserLog, writeJobLogToFile, writeJobTextToFile } = require('./logUtils');
const {
  getBlake3Hash,
  getSha256Hash,
  getMd5Hash,
  getXxHashHash,
  xxhashReady,
  xxhashAvailable
} = require('./hashUtils');
const { ensureUserDataSubdir } = require('../utils/appPaths');

function getJobFilePath() {
  return path.join(ensureUserDataSubdir('logs'), 'job-queue.json');
}

function removeJobFile() {
  const jobFile = getJobFilePath();
  try {
    if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
  } catch {
    // ignore cleanup errors
  }
}

function isPrivateHostname(hostname) {
  const host = (hostname || '').toLowerCase();
  if (!host) return true;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
  if (host.endsWith('.local')) return true;

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  if (ipVersion === 6) {
    const normalized = host.split('%')[0];
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80')) return true;
  }

  return false;
}

function validateN8nUrl(n8nUrl, opts = {}) {
  const allowPrivate = !!opts?.allowPrivate;
  const trimmed = (n8nUrl || '').trim();
  if (!trimmed) {
    return { valid: false, message: '❌ Please provide an n8n URL when webhook logging is enabled.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, message: '❌ Invalid n8n URL. Please use a full http/https address.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, message: '❌ n8n URL must start with http:// or https://.' };
  }

  const hostname = String(parsed.hostname || '').trim();
  if (!hostname) {
    return { valid: false, message: '❌ Invalid n8n URL. Please include a hostname.' };
  }

  if (!allowPrivate && isPrivateHostname(hostname)) {
    return {
      valid: false,
      message: '❌ n8n URL cannot target localhost or private networks unless private targets are explicitly allowed.'
    };
  }

  return { valid: true, url: trimmed };
}

const {
  copyFileWithProgress,       // ✅ Add this
  runWithConcurrencyLimit
} = require('./fileUtils');
const { cancelIngest, createCancelToken } = require('./cancelUtils');
const { estimateDiskWriteSpeed } = require('./speedUtils');
const { compareFilesByteByByte } = require('../utils/compare');

// 🛑 Allows user to cancel the clone operation
function cancelClone(id) {
  cancelIngest(id);
  // Include jobId + stage so the log viewer can filter/search the cancel event reliably.
  sendLogMessage('clone', '🛑 Clone cancel requested...', '', false, id || '', 'warn', id || '', 'cancelled', { cancelRequested: true });
}


const toForwardSlash = (value) => (typeof value === 'string' ? value.replace(/\\/g, '/') : '');

const safeResolvePath = (input) => {
  if (typeof input !== 'string' || input.length === 0) return null;
  try {
    return path.resolve(input);
  } catch {
    return null;
  }
};

async function bestEffortFsync(filePath, logFn, contextLabel, fileLabel) {
  let fd;
  try {
    fd = await fsp.open(filePath, 'r');
    await fd.sync();
  } catch (err) {
    if (typeof logFn === 'function') {
      const context = contextLabel ? ` (${contextLabel})` : '';
      const label = fileLabel || filePath;
      logFn(`⚠️ fsync failed for ${label}${context}: ${err.message}`);
    }
  } finally {
    if (fd) {
      try {
        await fd.close();
      } catch {}
    }
  }
}

async function applySourceTimestamps(sourcePath, targetPath, logFn, label) {
  try {
    const srcStat = await fsp.stat(sourcePath);
    await fsp.utimes(targetPath, srcStat.atime, srcStat.mtime);
  } catch (err) {
    if (typeof logFn === 'function') {
      const targetLabel = label || targetPath;
      logFn(`⚠️ Unable to preserve timestamps for ${targetLabel}: ${err.message}`);
    }
  }
}

function normalizePathForCompare(p) {
  return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

function parseExtension(name = '') {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function normalizeExtensions(extString = '') {
  return String(extString)
    .split(',')
    .map(str => str.trim().toLowerCase().replace(/^\*/, ''))
    .filter(Boolean)
    .map(ext => (ext.startsWith('.') ? ext : `.${ext}`));
}

const CLONE_PREVIEW_FILE_CAP = 5000;
const CLONE_PREVIEW_TIME_BUDGET_MS = 1500;

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function buildSelection(config) {
  const norm = (arr) => {
    const out = new Set();
    for (const p of Array.isArray(arr) ? arr : []) {
      const n = normalizePathForCompare(p);
      if (n) out.add(n);
    }
    return out;
  };
  // Keep nested selections; traversal rules in the planner rely on them.
  const blue = norm(config.selectedFolders);
  const red = norm(config.foldersOnly);
  const off = norm(config.excludedFolders);
  return { blue, red, off };
}

function filterSelectionByRoot(selection, rootPath) {
  const normalizedRoot = normalizePathForCompare(rootPath);
  const filterSet = (set = new Set()) => {
    const next = new Set();
    for (const value of set) {
      const normalized = normalizePathForCompare(value);
      if (!normalized) continue;
      if (!normalizedRoot) {
        next.add(normalized);
      } else if (normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)) {
        next.add(normalized);
      }
    }
    return next;
  };

  return {
    blue: filterSet(selection?.blue),
    red: filterSet(selection?.red),
    off: filterSet(selection?.off)
  };
}

function isExcluded(pathNorm, offSet) {
  if (!pathNorm) return false;
  if (offSet.has(pathNorm)) return true;
  let cur = pathNorm;
  while (true) {
    const idx = cur.lastIndexOf('/');
    if (idx < 0) return false;
    cur = cur.slice(0, idx);
    if (offSet.has(cur)) return true;
  }
}

async function* iterateCloneEntries(config) {
  const sourceRoot = normalizePathForCompare(config.source);
  if (!sourceRoot) return;

  const includeExts = normalizeExtensions(config.includeExtensions || config.filters?.include || '');
  const excludeExts = normalizeExtensions(config.excludeExtensions || config.filters?.exclude || '');
  const excludePatternsInput = Array.isArray(config.excludePatterns)
    ? config.excludePatterns
    : String(config.excludePatterns || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
  const excludePatterns = excludePatternsInput.map(s => String(s || '').toLowerCase());

  const includeCache = typeof config.includeCache === 'boolean' ? config.includeCache : undefined;
  // Default behavior: exclude caches/dev folders unless explicitly included.
  const useDefaultIgnorePatterns = typeof includeCache === 'boolean'
    ? !includeCache
    : (config.useDefaultIgnorePatterns !== undefined ? !!config.useDefaultIgnorePatterns : true);

  const scanFilter = buildScanFilter({
    includeHidden: !!config.includeHiddenFiles,
    useDefaultIgnorePatterns
  });

  const shouldIncludeFile = (name) => {
    if (scanFilter.shouldSkipFile(name)) return false;
    const ext = parseExtension(name);
    if (includeExts.length && !includeExts.includes(ext)) return false;
    if (excludeExts.includes(ext)) return false;
    const lower = name.toLowerCase();
    if (excludePatterns.some(p => lower.includes(p))) return false;
    return true;
  };

  const selection = config.selection || buildSelection(config);
  const { blue, red, off } = selection;
  const shouldAbort = typeof config.shouldAbort === 'function' ? config.shouldAbort : () => false;

  const toPosix = p => String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const hasSelectedDescendant = (dir) => {
    const base = toPosix(dir);
    const prefix = base.endsWith('/') ? base : `${base}/`;
    for (const s of blue) {
      const ss = toPosix(s);
      if (ss !== base && ss.startsWith(prefix)) return true;
    }
    for (const s of red) {
      const ss = toPosix(s);
      if (ss !== base && ss.startsWith(prefix)) return true;
    }
    return false;
  };

  const roots = Array.from(new Set([...blue, ...red]));

  const normalizedRootsSet = new Set();

  for (const node of roots) {
    const normalizedNode = normalizePathForCompare(node);
    if (!normalizedNode) continue;
    if (!(normalizedNode === sourceRoot || normalizedNode.startsWith(`${sourceRoot}/`))) continue;
    normalizedRootsSet.add(normalizedNode);
  }

  const normalizedRoots = Array.from(normalizedRootsSet).sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  const visited = new Set();
  const stack = [];

  for (let i = normalizedRoots.length - 1; i >= 0; i -= 1) {
    const root = normalizedRoots[i];
    if (visited.has(root)) continue;
    if (isExcluded(root, off)) continue;
    const mode = blue.has(root) ? 'blue' : 'red';
    stack.push({ dirNorm: root, mode });
  }

  while (stack.length > 0) {
    if (shouldAbort()) return;
    const { dirNorm, mode } = stack.pop();
    if (!dirNorm) continue;
    if (visited.has(dirNorm)) continue;
    if (isExcluded(dirNorm, off)) continue;
    visited.add(dirNorm);

    let entries;
    try {
      entries = await fsp.readdir(dirNorm, { withFileTypes: true });
    } catch {
      continue;
    }

    const relDir = dirNorm.slice(sourceRoot.length).replace(/^[\\/]/, '');
    if (relDir) {
      yield { type: 'dir', fullPath: dirNorm, relativePath: relDir };
    }

    if (mode === 'blue') {
      for (const entry of entries) {
        if (entry.isFile() && shouldIncludeFile(entry.name)) {
          const fullPath = `${dirNorm}/${entry.name}`.replace(/[\\/]+/g, '/');
          yield {
            type: 'file',
            fullPath,
            relativePath: relDir ? `${relDir}/${entry.name}` : entry.name
          };
        }
      }
    }

    const childDirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childNorm = normalizePathForCompare(`${dirNorm}/${entry.name}`);
      if (isExcluded(childNorm, off)) continue;

      if (scanFilter.shouldSkipDir(entry.name)) {
        if (!red.has(childNorm) && !blue.has(childNorm) && !hasSelectedDescendant(childNorm)) continue;
      }

      let shouldDescend = false;
      let nextMode = 'red';

      if (red.has(childNorm)) {
        shouldDescend = true;
        nextMode = 'red';
      } else if (blue.has(childNorm)) {
        shouldDescend = true;
        nextMode = 'blue';
      } else if (mode === 'red') {
        shouldDescend = true;
        nextMode = 'red';
      } else if (hasSelectedDescendant(childNorm)) {
        shouldDescend = true;
        nextMode = 'red';
      }

      if (shouldDescend) {
        childDirs.push({ dirNorm: childNorm, mode: nextMode });
      }
    }

    for (let i = childDirs.length - 1; i >= 0; i -= 1) {
      stack.push(childDirs[i]);
    }
  }
}

async function _planCloneEntries(config) {
  const files = [];
  const dirSet = new Set();

  for await (const entry of iterateCloneEntries(config)) {
    if (!entry) continue;
    if (entry.type === 'dir') {
      dirSet.add(entry.relativePath);
    } else if (entry.type === 'file') {
      files.push({ fullPath: entry.fullPath, relativePath: entry.relativePath });
    }
  }

  const filesSorted = files.slice().sort((a, b) => {
    const relA = a?.relativePath ?? '';
    const relB = b?.relativePath ?? '';
    return relA.localeCompare(relB);
  });

  return {
    files: filesSorted,
    dirs: Array.from(dirSet).sort()
  };
}


// 🚀 Main clone function
async function runClone(config) {
  try {
    removeJobFile();
  } catch {}
  if (!config.signal) config.signal = createCancelToken();

  // Ensure a jobId exists for job-scoped JSONL + TXT logs and log viewer filtering.
  if (!config.jobId) {
    config.jobId = `clone-${Date.now()}`;
  }

  const jobLogger = createJobLogger({
    panel: 'clone',
    jobId: config.jobId,
    stage: 'init',
    streamToFile: true,
  });

  const userLog = createJobUserLog(jobLogger, {
    normalize: (msg) => {
      if (typeof msg === 'string') return msg;
      try { return JSON.stringify(msg); } catch { return String(msg); }
    },
    pickLevel: (text, isError) => {
      const inferredError = isError || /❌|\berror\b/i.test(text);
      const inferredWarn = !inferredError && (/⚠️|\bwarn\b/i.test(text));
      return inferredError ? 'error' : inferredWarn ? 'warn' : 'info';
    }
  });
  const log = userLog.lines;
  const logPush = userLog.push;

  let archivePath = null;
  let structuredLogPath = null;
  structuredLogPath = jobLogger.getStructuredLogPath?.() || structuredLogPath;
  let didPersistJobLogs = false;
  let reportPrimaryDestination = config.destination || '';
  let reportSecondaryDestination = config.backupPath || '';
  let reportStats = {};
  const savedJobReportCopies = new Set();

  const getReportSourceCount = () => {
    if (Array.isArray(config.selectedFolders) && config.selectedFolders.length) return config.selectedFolders.length;
    return config.source ? 1 : 0;
  };

  const persistJobLogs = ({ rewriteText = false, closeLogger = true } = {}) => {
    if (didPersistJobLogs && !rewriteText) {
      if (closeLogger) {
        try { jobLogger.close?.(); } catch {}
      }
      return;
    }
    try {
      if (!structuredLogPath) {
        structuredLogPath = jobLogger.getStructuredLogPath?.() || null;
      }
      if (!structuredLogPath) {
        structuredLogPath = writeJobLogToFile('clone', config.jobId, jobLogger.getEntries());
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist clone JSONL log:', e?.message || e);
    }
    try {
      if (!archivePath || rewriteText) {
        archivePath = writeJobTextToFile(
          'clone',
          config.jobId,
          jobLogger.getEntries(),
          {
            structuredLogPath: structuredLogPath,
            inputs: {
              sourceCount: getReportSourceCount(),
              sourceRoot: config.source || '',
              sources: Array.isArray(config.selectedFolders) ? config.selectedFolders.slice(0, 50) : [],
            },
            outputs: {
              primaryDestination: reportPrimaryDestination,
              secondaryDestination: reportSecondaryDestination,
            },
            settings: {
              mode: 'manual',
              skipExisting: !!config.skipExisting,
              checksum: !!config.checksum,
              byteCompare: !!config.byteCompare,
              flattenStructure: !!config.flatten,
              retryFailures: !!config.retryFailures,
              removeEmptyFolders: !!config.removeEmptyFolders,
              saveLog: !!config.saveLog,
              verificationMethod: config.checksum ? (config.checksumMethod || 'sha256') : (config.byteCompare ? 'byte-by-byte' : 'none'),
              maxThreads: config.maxThreads != null ? String(config.maxThreads) : '',
            },
            stats: reportStats,
          }
        );
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist clone TXT log:', e?.message || e);
    }
    didPersistJobLogs = true;
    if (closeLogger) {
      try { jobLogger.close?.(); } catch {}
    }
  };

  const refreshSavedJobReportCopies = () => {
    if (!archivePath || savedJobReportCopies.size === 0) return;
    if (!fs.existsSync(archivePath)) return;
    for (const targetPath of savedJobReportCopies) {
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(archivePath, targetPath);
      } catch (err) {
        console.warn('⚠️ Failed to refresh saved clone TXT log copy:', err?.message || err);
      }
    }
  };

  const finish = (result = {}) => {
    persistJobLogs({ rewriteText: true });
    const out = (result && typeof result === 'object') ? result : {};
    out.jobId = out.jobId || config.jobId;
    out.structuredLogPath = out.structuredLogPath || structuredLogPath;
    out.archivePath = out.archivePath || archivePath;
    if (!('logText' in out)) out.logText = log.join('\n');
    return out;
  };
  try {
  const {
    source,
    destination,
    createIfMissing,
    skipExisting,
    checksum,
    checksumMethod: rawChecksumMethod,
    verbose,
    maxThreads = 3,
    saveLog,
    enableN8N,
    n8nUrl: rawN8nUrl,
    n8nAllowPrivate,
    n8nLog,
    notes
  } = config;

  const n8nUrl = typeof rawN8nUrl === 'string' ? rawN8nUrl.trim() : '';
  
  const cloneSourceRoot = source; // ✅ Anchor point for relative paths

  const checksumMethod = String(rawChecksumMethod || 'sha256').toLowerCase();

  const computeSelectedHash = async (filePath, method = checksumMethod) => {
    switch (method) {
      case 'blake3':
        return getBlake3Hash(filePath);
      case 'sha256':
        return getSha256Hash(filePath);
      case 'md5':
        return getMd5Hash(filePath);
      case 'xxhash64':
        return getXxHashHash(filePath);
      default:
        throw new Error(`Unsupported checksum method: ${method}`);
    }
  };

  const allowedMethods = ['blake3', 'sha256', 'md5', 'xxhash64'];
  if (checksum && !allowedMethods.includes(checksumMethod)) {
    const msg = `❌ Unsupported checksum method: ${checksumMethod}`;
    logPush(msg, '', true);
    jobLogger.setStage('error');
    return finish({ success: false, log: [msg] });
  }

  if (checksum && checksumMethod === 'xxhash64') {
    await xxhashReady;
    if (!xxhashAvailable) {
      const msg = '❌ xxHash64 unavailable. Please choose a different checksum method.';
      logPush(msg, '', true);
      const window = getMainWindow();
      if (window && !window.isDestroyed()) {
        await dialog.showMessageBox(window, {
          type: 'error',
          title: 'xxHash64 Unavailable',
          message: msg
        });
      }
      jobLogger.setStage('error');
      return finish({ success: false, log: [msg] });
    }
  }

  if (!fs.existsSync(source)) {
    const msg = `❌ Source folder does not exist: ${source}`;
    logPush(msg, '', true);
    jobLogger.setStage('error');
    return finish({ success: false, log: [msg] });
  }

  if (!fs.existsSync(destination)) {
    if (createIfMissing) {
      fs.mkdirSync(destination, { recursive: true });
      logPush(`📁 Created destination folder: ${destination}`);
    } else {
      const msg = `❌ Destination folder does not exist: ${destination}`;
      logPush(msg, '', true);
      jobLogger.setStage('error');
      return finish({ success: false, log: [msg] });
    }
  }

  const rootName = path.basename(cloneSourceRoot);
  const destRoot = path.join(destination, rootName);
  fs.mkdirSync(destRoot, { recursive: true });
  reportPrimaryDestination = destRoot;
  logPush(`📁 Ensured root folder: ${destRoot}`);

  let backupRoot = null;
  if (config.backup && config.backupPath) {
    backupRoot = path.join(config.backupPath, rootName);
    fs.mkdirSync(backupRoot, { recursive: true });
    reportSecondaryDestination = backupRoot;
    logPush(`📁 Ensured backup root folder: ${backupRoot}`);
  }

  const resolvedSourceRoot = safeResolvePath(cloneSourceRoot) || cloneSourceRoot;
  const normalizedSourceRoot = normalizePathForCompare(resolvedSourceRoot);
  const selection = filterSelectionByRoot(buildSelection(config), resolvedSourceRoot);
  const selectedNodes = new Set([...selection.blue, ...selection.red]);

  const selectionEntriesMap = new Map();
  for (const value of selection.blue) {
    const normalized = normalizePathForCompare(value);
    if (!normalized) continue;
    selectionEntriesMap.set(normalized, { path: normalized, isRed: false });
  }
  for (const value of selection.red) {
    const normalized = normalizePathForCompare(value);
    if (!normalized) continue;
    selectionEntriesMap.set(normalized, { path: normalized, isRed: true });
  }

  const selectionEntries = Array.from(selectionEntriesMap.values())
    .sort((a, b) => b.path.length - a.path.length);

  const deepestSelected = (absPath) => {
    const normalized = normalizePathForCompare(absPath);
    if (!normalized) return null;
    for (const entry of selectionEntries) {
      if (normalized === entry.path || normalized.startsWith(`${entry.path}/`)) {
        return entry;
      }
    }
    return null;
  };

  const toRelativeFromSource = (absPath) => {
    const normalized = normalizePathForCompare(absPath);
    if (!normalizedSourceRoot || !normalized) return '';
    if (normalized === normalizedSourceRoot) return '';
    if (!normalized.startsWith(`${normalizedSourceRoot}/`)) return '';
    return normalized.slice(normalizedSourceRoot.length + 1);
  };

  if (!selectedNodes.size) {
    const msg = `⚠️ No folders selected. Please select at least one.`;
    logPush(msg, '', true);
    jobLogger.setStage('error');
    return finish({ success: false, log: [msg] });
  }

  const includeExts = normalizeExtensions(config.includeExtensions || config.filters?.include || '');
  const excludeExts = normalizeExtensions(config.excludeExtensions || config.filters?.exclude || '');
  const rawExcludePatterns = Array.isArray(config.excludePatterns)
    ? config.excludePatterns
    : String(config.excludePatterns || '')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);
  const excludePatterns = rawExcludePatterns.map(p => p.toLowerCase());

  const selectedList = Array.from(selectedNodes).map(toForwardSlash).sort();
  logPush(`🔍 Selected nodes: ${JSON.stringify(selectedList)}`);
  if (selection.red.size) {
    const foldersOnly = Array.from(selection.red).map(toForwardSlash).sort();
    logPush(`📁 Folders-only: ${JSON.stringify(foldersOnly)}`);
  }
  if (selection.off.size) {
    const excluded = Array.from(selection.off).map(toForwardSlash).sort();
    logPush(`🚫 Excluded folders: ${JSON.stringify(excluded)}`);
  }

  const plannerConfig = {
    ...config,
    source: resolvedSourceRoot,
    selection,
    excludePatterns: rawExcludePatterns
  };
  const mappedFiles = [];
  const scanBatch = [];
  const scanBatchSize = 250;
  let scanCount = 0;
  let lastScanLogAt = 0;
  const flushScanBatch = () => {
    if (!scanBatch.length) return;
    for (const item of scanBatch) {
      if (!item || !item.fullPath) continue;
      const fullPath = item.fullPath;
      const relativePath = config.flatten
        ? path.basename(fullPath)
        : item.relativePath;
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        continue;
      }
      mappedFiles.push({ fullPath, relativePath });
      scanCount += 1;
    }
    scanBatch.length = 0;
    const now = Date.now();
    if (now - lastScanLogAt > 1000) {
      lastScanLogAt = now;
      logPush(`🔍 Scanning selection… ${scanCount} file(s) found`);
    }
  };

  for await (const entry of iterateCloneEntries(plannerConfig)) {
    if (!entry || entry.type !== 'file') continue;
    scanBatch.push(entry);
    if (scanBatch.length >= scanBatchSize) {
      flushScanBatch();
    }
  }
  flushScanBatch();

  const files = mappedFiles.filter(({ fullPath }) => {
    const abs = normalizePathForCompare(fullPath);
    if (!abs) return false;
    if (isExcluded(abs, selection.off)) return false;

    const anc = deepestSelected(abs);
    if (!anc) return false;

    const parentDir = normalizePathForCompare(path.dirname(fullPath));

    if (anc.isRed && parentDir === anc.path) return false;
    if (!anc.isRed && parentDir !== anc.path) return false;

    return true;
  });

  if (config.flatten && files.length > 1) {
    const byName = new Map();
    for (const file of files) {
      const baseName = path.basename(file.fullPath);
      const key = baseName.toLowerCase();
      const entry = byName.get(key) || { names: new Set(), sources: new Set() };
      entry.names.add(baseName);
      entry.sources.add(file.fullPath);
      byName.set(key, entry);
    }

    const collisions = [];
    for (const [key, entry] of byName.entries()) {
      if (entry.sources.size > 1) {
        collisions.push({
          key,
          names: Array.from(entry.names).sort(),
          sources: Array.from(entry.sources).sort()
        });
      }
    }

    if (collisions.length > 0) {
      const maxCollisionsToShow = 8;
      const maxPathsPerCollision = 6;
      const lines = [];

      for (const collision of collisions.slice(0, maxCollisionsToShow)) {
        const displayName = collision.names.length === 1
          ? collision.names[0]
          : `${collision.names[0]} (case variants: ${collision.names.slice(1).join(', ')})`;

        lines.push(displayName);
        for (const source of collision.sources.slice(0, maxPathsPerCollision)) {
          lines.push(`  • ${source}`);
        }
        if (collision.sources.length > maxPathsPerCollision) {
          lines.push(`  • …and ${collision.sources.length - maxPathsPerCollision} more`);
        }
        lines.push('');
      }

      if (collisions.length > maxCollisionsToShow) {
        lines.push(`…and ${collisions.length - maxCollisionsToShow} more collision(s)`);
      }

      const msg =
        `Flatten Structure is enabled, but ${collisions.length} filename collision(s) were found.\n\n` +
        `When flattening, files with the same name would overwrite or be skipped.\n\n` +
        `Disable Flatten Structure or rename files so each filename is unique.\n\n` +
        `Collisions (examples):\n\n${lines.join('\n')}`;

      const errorMessage = '❌ Clone cancelled: Flatten Structure filename collisions detected.';
      logPush(errorMessage);
      logPush(msg);
      logPush(errorMessage, '', true);
      logPush(msg, '', true);

      const window = getMainWindow();
      if (window && !window.isDestroyed()) {
        await dialog.showMessageBox(window, {
          type: 'error',
          title: 'Flatten Structure Collision',
          message: msg,
          buttons: ['OK']
        });
      }

      jobLogger.setStage('error');
      return finish({ success: false, log });
    }
  }

  const dirSet = new Set();

  for (const entry of selectionEntries) {
    const rel = toRelativeFromSource(entry.path);
    if (rel && rel !== '.' && !rel.startsWith('..')) dirSet.add(rel);
  }

  for (const file of files) {
    const relDir = path.posix.dirname(file.relativePath);
    if (relDir && relDir !== '.' && !relDir.startsWith('..')) dirSet.add(relDir);
  }

  const dirsToCreate = Array.from(dirSet).sort();

  for (const rel of dirsToCreate) {
    try {
      fs.mkdirSync(path.join(destRoot, rel), { recursive: true });
      logPush(`📁 Ensured folder: ${rel}`);
    } catch (err) {
      logPush(`⚠️ Failed to create folder ${rel}: ${err.message}`);
    }
    if (backupRoot) {
      try {
        fs.mkdirSync(path.join(backupRoot, rel), { recursive: true });
      } catch (err) {
        logPush(`⚠️ Failed to create backup folder ${rel}: ${err.message}`);
      }
    }
  }

  logPush(`📂 Selected folders:`);
  selectedList.forEach(f => logPush(`  • ${f}`));
  logPush(`✅ Include extensions: ${includeExts.join(', ') || 'All'}`);
  logPush(`🚫 Exclude extensions: ${excludeExts.join(', ') || 'None'}`);
  logPush(`🚫 Exclude patterns: ${excludePatterns.join(', ') || 'None'}`);

  const copiedFiles = [];
  const skippedFiles = [];
  const failedFiles = [];

  let totalBytes = 0;
  files.forEach(({ fullPath }) => {
    try {
      const size = fs.statSync(fullPath).size;
      totalBytes += backupRoot ? size * 2 : size;
    } catch {}
  });

  const progressManager = new ProgressManager(totalBytes, 250, 'bytes');
  progressManager.setTotalFiles(files.length);

  logPush(`📦 Found ${files.length} file(s) to clone.`);
  reportStats = {
    discoveredFiles: mappedFiles.length,
    eligibleFiles: files.length,
    plannedFolders: dirsToCreate.length,
  };

  if (!files.length) {
    const notice = '⚠️ No files to copy based on current selection.';
    logPush(notice);
    progressManager.finishAll?.();
    progressManager.dispose?.();
    if (global.queue) {
      global.queue.emit('job-complete', {
        id: config.jobId,
        panel: 'clone',
        result: { success: true }
      });
    }
    jobLogger.setStage('complete');
    jobLogger.info('Clone job completed (no files)');
    return finish({ success: true, log });
  }


  progressManager.on('stream-progress', payload => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
  // Progress routed solely through the queue manager
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'clone',
      file: payload.file,
      percent: payload.overall,
      eta: payload.eta,
      completed: payload.completedFiles,
      total: payload.totalFiles,
      streamId: payload.streamId
    });
  }
});

progressManager.on('overall-progress', payload => {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  // Legacy 'clone-progress' event removed; queue manager handles updates
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'clone',
      percent: payload.overall,
      eta: payload.eta,
      completed: payload.completedFiles,
      total: payload.totalFiles
    });
  }
});

progressManager.on('file-status', payload => {
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'clone',
      file: payload.file,
      status: { ...payload.statusMap },
      streamId: payload.streamId
    });
  }
});

// 🧵 Prepare file copy tasks
  const tasks = files.map(({ fullPath, relativePath }) => async (streamId) => {
    const statusMap = { copied: false, backedUp: false, checksummed: false };
    if (verbose) logPush(`📁 Starting copy: ${relativePath}`);

    const safeUnlink = async (p) => {
      if (!p) return;
      await fsp.unlink(p).catch(() => {});
    };

    let started = false;
    let finished = false;
    let destVerified = false;
    let backupVerified = false;
    let finalBackupPath = null;

    if (config.signal?.aborted) {
      const msg = `🛑 Clone canceled during: ${relativePath}`;
      logPush(msg);
      failedFiles.push(relativePath);
      return;
    }

    const destPath = path.join(destRoot, relativePath);
    const destDir = path.dirname(destPath);
    let finalDest = destPath;

    try {
      fs.mkdirSync(destDir, { recursive: true });

      const exists = fs.existsSync(finalDest);
      if (exists) {
        if (skipExisting) {
          if (verbose) logPush(`⚠️ Skipped (exists): ${relativePath}`);
          skippedFiles.push(relativePath);
          return;
        }

        else {
  logPush(`🔍 Overwriting existing file: ${relativePath}`);
}
      }

      // ✅ Step 1: Copy the file
      const fileSize = fs.statSync(fullPath).size;

      progressManager.startFile(streamId, fullPath, fileSize);
      started = true;

      await copyFileWithProgress(
        fullPath,
        finalDest,
        (_percent, chunkSize) => {
          progressManager.updateStream(streamId, chunkSize);
        },
        config.signal
      );
      await bestEffortFsync(finalDest, logPush, 'destination', relativePath);
      await applySourceTimestamps(fullPath, finalDest, logPush, `destination ${relativePath}`);

      statusMap.copied = true;
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'clone',
          file: relativePath,
          status: { ...statusMap }
        });
      }

      // ✅ Immediately notify UI of successful copy
      if (verbose) logPush(`✅ Copied: ${relativePath}`);

      // ✅ Step 2: Verify destination (if enabled)
      let srcHash = null;
      let srcHashMethod = null;

      if (checksum) {
        if (verbose) logPush(`🔍 Verifying: ${relativePath}`);

        const src = await computeSelectedHash(fullPath, checksumMethod);
        const dest = await computeSelectedHash(finalDest, checksumMethod);

        srcHash = src?.hash || null;
        srcHashMethod = src?.method;

        logPush(`🧪 Verifying ${relativePath} with ${checksumMethod.toUpperCase()}`);
        logPush(`🔍 Source hash (${srcHashMethod || 'unknown'}): ${srcHash}`);
        logPush(`🔍 Dest hash   (${dest?.method || 'unknown'}): ${dest?.hash || null}`);

        if (!srcHash) {
          await safeUnlink(finalDest);
          statusMap.copied = false;
          throw new Error(`Source checksum unavailable (${checksumMethod})`);
        }

        if (!dest?.hash) {
          await safeUnlink(finalDest);
          statusMap.copied = false;
          throw new Error(`Destination checksum unavailable (${checksumMethod})`);
        }

        if (srcHash !== dest.hash) {
          await safeUnlink(finalDest);
          statusMap.copied = false;
          throw new Error(`${checksumMethod.toUpperCase()} mismatch`);
        }

        logPush(`✅ Verified with ${checksumMethod.toUpperCase()}`);
      }

      if (config.byteCompare) {
        if (verbose) logPush(`🔍 Byte-level comparing: ${relativePath}`);
        const isIdentical = await compareFilesByteByByte(fullPath, finalDest);
        if (!isIdentical) {
          await safeUnlink(finalDest);
          statusMap.copied = false;
          throw new Error('Byte-level mismatch');
        }
        if (verbose) logPush(`✅ Byte-level match: ${relativePath}`);
      }

      // Destination is verified if verification is disabled, or enabled checks passed.
      destVerified = true;

      // ✅ Step 3: Backup copy AFTER verification
      if (backupRoot) {
        finalBackupPath = path.join(backupRoot, relativePath);
        fs.mkdirSync(path.dirname(finalBackupPath), { recursive: true });

        await copyFileWithProgress(
          fullPath,
          finalBackupPath,
          (_percent, chunkSize) => progressManager.updateStream(streamId, chunkSize),
          config.signal
        );
        await bestEffortFsync(finalBackupPath, logPush, 'backup', relativePath);
        await applySourceTimestamps(fullPath, finalBackupPath, logPush, `backup ${relativePath}`);

        // ✅ Step 4: Verify backup using same selected method(s)
        if (checksum) {
          // srcHash should already be present when checksum is enabled
          if (!srcHash) {
            const src = await computeSelectedHash(fullPath, checksumMethod);
            srcHash = src?.hash || null;
            srcHashMethod = src?.method;
          }

          if (!srcHash) {
            await safeUnlink(finalBackupPath);
            throw new Error(`Source checksum unavailable for backup (${checksumMethod})`);
          }

          const backup = await computeSelectedHash(finalBackupPath, checksumMethod);
          logPush(`🧪 Verifying backup ${relativePath} with ${checksumMethod.toUpperCase()}`);
          logPush(`🔍 Source hash (${srcHashMethod || 'unknown'}): ${srcHash}`);
          logPush(`🔍 Backup hash (${backup?.method || 'unknown'}): ${backup?.hash || null}`);

          if (!backup?.hash) {
            await safeUnlink(finalBackupPath);
            throw new Error(`Backup checksum unavailable (${checksumMethod})`);
          }

          if (srcHash !== backup.hash) {
            await safeUnlink(finalBackupPath);
            throw new Error(`${checksumMethod.toUpperCase()} mismatch (backup)`);
          }

          logPush(`✅ Backup verified with ${checksumMethod.toUpperCase()}`);
        }

        if (config.byteCompare) {
          const isIdentical = await compareFilesByteByByte(finalDest, finalBackupPath);
          if (!isIdentical) {
            await safeUnlink(finalBackupPath);
            throw new Error('Byte-level mismatch (backup)');
          }
          if (verbose) logPush(`✅ Byte-level match (dest ↔ backup): ${relativePath}`);
        }

        backupVerified = true;
        statusMap.backedUp = true;
        logPush(`📦 Backed up: ${relativePath}`);
      } else {
        backupVerified = true;
      }

      if (checksum) {
        statusMap.checksummed = true;
        if (global.queue) {
          global.queue.emit('job-progress', {
            id: config.jobId,
            panel: 'clone',
            file: relativePath,
            status: { ...statusMap }
          });
        }
      }

      if (verbose) logPush(`✅ Copied: ${relativePath}`);
      copiedFiles.push(relativePath);

} catch (err) {
      if (config.signal?.aborted) {
        const msg = `🛑 Canceled during: ${relativePath}`;
        logPush(msg);
        failedFiles.push(relativePath);
        return;
      }
      const msg = `❌ Failed: ${relativePath} → ${err.message}`;
      logPush(msg);
      failedFiles.push(relativePath);
      // Cleanup partial/invalid outputs. Keep verified destination if only backup failed.
      if (!backupVerified && finalBackupPath) {
        await safeUnlink(finalBackupPath);
        statusMap.backedUp = false;
      }
      if (!destVerified) {
        await safeUnlink(finalDest);
        statusMap.copied = false;
      }
    } finally {
      if (started && !finished) {
        progressManager.finishFile(streamId, statusMap);
        finished = true;
        if (global.queue) {
          global.queue.emit('job-progress', {
            id: config.jobId,
            panel: 'clone',
            file: relativePath,
            status: { ...statusMap }
          });
        }
      }
    }
  });

  let threadCount = maxThreads;

  if (!threadCount || isNaN(threadCount)) {
    try {
      const speed = await estimateDiskWriteSpeed(destination);
      logPush(`⚡ Estimated write speed: ${speed} MiB/s`);
      threadCount =
        speed < 50  ? 2 :
        speed < 100 ? 3 :
        speed < 200 ? 4 :
        speed < 400 ? 5 :
                      6;
      logPush(`🧵 Auto-selected thread count: ${threadCount}`);
    } catch (err) {
      threadCount = 3;
      logPush(`⚠️ Disk speed check failed${err?.code ? ` [${err.code}]` : ''} (${err.message}), defaulting to ${threadCount} threads`);
    }
  } else {
    logPush(`🧵 Using user-defined thread count: ${threadCount}`);
  }

  jobLogger.setStage('copy');
  const results = await runWithConcurrencyLimit(tasks, threadCount);
  let retryResults = [];

  if (config.signal?.aborted) {
    jobLogger.setStage('cancelled');
    jobLogger.warn('Clone job cancelled', { cancelled: true });
    logPush('🛑 Clone cancelled by user.');
    return finish({ success: false, cancelled: true, log });
  }

// 🔁 Retry failed files if enabled
if (config.retryFailures && failedFiles.length > 0) {
  const finalFailedFiles = [...failedFiles]; // ✅ Preserve original failures
  failedFiles.length = 0; // ✅ Clear for retry tracking

  logPush(`🔁 Retrying ${finalFailedFiles.length} failed file(s)...`);

  const retryTasks = files.filter(f =>
    finalFailedFiles.includes(f.relativePath)
  ).map(({ fullPath, relativePath }) => async (streamId) => {
    const statusMap = { copied: false, backedUp: false, checksummed: false };
    const safeUnlink = async (p) => {
      if (!p) return;
      await fsp.unlink(p).catch(() => {});
    };

    let started = false;
    let finished = false;
    let destVerified = false;
    let backupVerified = false;
    let finalBackupPath = null;

    const destPath = path.join(destRoot, relativePath);

    try {
      const destDir = path.dirname(destPath);
      fs.mkdirSync(destDir, { recursive: true });

      const fileSize = fs.statSync(fullPath).size;
      progressManager.startFile(streamId, fullPath, fileSize);
      started = true;

      // 1) Copy src → dest
      await copyFileWithProgress(
        fullPath,
        destPath,
        (_p, c) => {
          progressManager.updateStream(streamId, c);
        },
        config.signal
      );
      await applySourceTimestamps(fullPath, destPath, logPush, `destination ${relativePath}`);

      statusMap.copied = true;
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'clone',
          file: relativePath,
          status: { ...statusMap }
        });
      }

      // 2) Verify destination
      let srcHash = null;
      let srcHashMethod = null;

      if (checksum) {
        const src = await computeSelectedHash(fullPath, checksumMethod);
        const dest = await computeSelectedHash(destPath, checksumMethod);

        srcHash = src?.hash || null;
        srcHashMethod = src?.method;

        logPush(`🧪 Verifying (retry) ${relativePath} with ${checksumMethod.toUpperCase()}`);
        logPush(`🔍 Source hash (${srcHashMethod || 'unknown'}): ${srcHash}`);
        logPush(`🔍 Dest hash   (${dest?.method || 'unknown'}): ${dest?.hash || null}`);

        if (!srcHash) {
          await safeUnlink(destPath);
          statusMap.copied = false;
          throw new Error(`Source checksum unavailable (${checksumMethod})`);
        }

        if (!dest?.hash) {
          await safeUnlink(destPath);
          statusMap.copied = false;
          throw new Error(`Destination checksum unavailable (${checksumMethod})`);
        }

        if (srcHash !== dest.hash) {
          await safeUnlink(destPath);
          statusMap.copied = false;
          throw new Error(`${checksumMethod.toUpperCase()} mismatch`);
        }

        logPush(`✅ Verified (retry) with ${checksumMethod.toUpperCase()}`);
      }

      if (config.byteCompare) {
        const isIdentical = await compareFilesByteByByte(fullPath, destPath);
        if (!isIdentical) {
          await safeUnlink(destPath);
          statusMap.copied = false;
          throw new Error('Byte-level mismatch');
        }
      }

      destVerified = true;

      // 3) Backup AFTER verification
      if (backupRoot) {
        finalBackupPath = path.join(backupRoot, relativePath);
        fs.mkdirSync(path.dirname(finalBackupPath), { recursive: true });

        await copyFileWithProgress(
          fullPath,
          finalBackupPath,
          (_percent, chunkSize) => progressManager.updateStream(streamId, chunkSize),
          config.signal
        );
        await applySourceTimestamps(fullPath, finalBackupPath, logPush, `backup ${relativePath}`);

        // 4) Verify backup using same method(s)
        if (checksum) {
          if (!srcHash) {
            const src = await computeSelectedHash(fullPath, checksumMethod);
            srcHash = src?.hash || null;
            srcHashMethod = src?.method;
          }

          if (!srcHash) {
            await safeUnlink(finalBackupPath);
            throw new Error(`Source checksum unavailable for backup (${checksumMethod})`);
          }

          const backup = await computeSelectedHash(finalBackupPath, checksumMethod);

          logPush(`🧪 Verifying backup (retry) ${relativePath} with ${checksumMethod.toUpperCase()}`);
          logPush(`🔍 Source hash (${srcHashMethod || 'unknown'}): ${srcHash}`);
          logPush(`🔍 Backup hash (${backup?.method || 'unknown'}): ${backup?.hash || null}`);

          if (!backup?.hash) {
            await safeUnlink(finalBackupPath);
            throw new Error(`Backup checksum unavailable (${checksumMethod})`);
          }

          if (srcHash !== backup.hash) {
            await safeUnlink(finalBackupPath);
            throw new Error(`${checksumMethod.toUpperCase()} mismatch (backup)`);
          }

          logPush(`✅ Backup verified (retry) with ${checksumMethod.toUpperCase()}`);
        }

        if (config.byteCompare) {
          const isIdentical = await compareFilesByteByByte(destPath, finalBackupPath);
          if (!isIdentical) {
            await safeUnlink(finalBackupPath);
            throw new Error('Byte-level mismatch (backup)');
          }
        }

        backupVerified = true;
        statusMap.backedUp = true;
        logPush(`📦 Backed up (retry): ${relativePath}`);
      } else {
        backupVerified = true;
      }

      if (checksum) {
        statusMap.checksummed = true;
        if (global.queue) {
          global.queue.emit('job-progress', {
            id: config.jobId,
            panel: 'clone',
            file: relativePath,
            status: { ...statusMap }
          });
        }
      }

      copiedFiles.push(relativePath);
      logPush(`✅ Retried & copied: ${relativePath}`);
    } catch (err) {
      logPush(`❌ Retry failed: ${relativePath} → ${err.message}`);
      failedFiles.push(relativePath); // ✅ Track persistent failures

      // Cleanup partial/invalid outputs. Keep verified destination if only backup failed.
      if (!backupVerified && finalBackupPath) {
        await safeUnlink(finalBackupPath);
        statusMap.backedUp = false;
      }
      if (!destVerified) {
        await safeUnlink(destPath);
        statusMap.copied = false;
      }
    } finally {
      if (started && !finished) {
        progressManager.finishFile(streamId, statusMap);
        finished = true;
        if (global.queue) {
          global.queue.emit('job-progress', {
            id: config.jobId,
            panel: 'clone',
            file: relativePath,
            status: { ...statusMap }
          });
        }
      }
    }
  });

  retryResults = await runWithConcurrencyLimit(retryTasks, threadCount);
}

  const allTaskResults = [...results, ...retryResults];
  if (progressManager?.dispose) {
    progressManager.finishAll?.();
    progressManager.dispose();
  } else if (progressManager?.finishAll) {
    progressManager.finishAll();
  }

  if (global.queue) {
    const overallSuccess =
      allTaskResults.length === 0
        ? failedFiles.length === 0
        : allTaskResults.every(result => !result || result.success !== false);
    global.queue.emit('job-complete', {
      id: config.jobId,
      panel: 'clone',
      result: {
        success: overallSuccess && failedFiles.length === 0,
        files: copiedFiles.length,
        skipped: skippedFiles.length,
        failed: failedFiles.length
      }
    });
  }

  // ✅ Log summary
  logPush(`\n✅ Clone complete.`);
  logPush(`   • Copied: ${copiedFiles.length}`);
  logPush(`   • Skipped: ${skippedFiles.length}`);
  logPush(`   • Failed: ${failedFiles.length}`);

  
  reportStats = {
    discoveredFiles: mappedFiles.length,
    eligibleFiles: files.length,
    plannedFolders: dirsToCreate.length,
    copiedFiles: copiedFiles.length,
    skippedFiles: skippedFiles.length,
    failedFiles: failedFiles.length,
    retryAttempts: retryResults.length,
  };

  if (enableN8N) {
    if (!n8nUrl) {
      logPush('⚠️ Webhook enabled but no URL provided.');
    } else {
      const n8nValidation = validateN8nUrl(n8nUrl, {
        allowPrivate: !!n8nAllowPrivate
      });

      if (!n8nValidation.valid) {
        logPush(n8nValidation.message || '⚠️ n8n URL blocked by validation.');
        logPush('ℹ️ Skipping webhook trigger due to invalid URL.');
      } else {
        const payload = n8nLog
          ? { log }
          : {
              status: 'complete',
              notes,
              success: true,
              skipped: skippedFiles.length,
              failed: failedFiles.length
            };

        logPush(`🛰️ Preparing to send data to: ${n8nValidation.url}`);
        logPush(`📦 Payload preview:\n${JSON.stringify(payload, null, 2)}`);

        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        const controller = new AbortController();
        const timeoutMs = 8000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          await fetch(n8nValidation.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          logPush('🌐 n8n webhook triggered');
        } catch (err) {
          if (err?.name === 'AbortError') {
            logPush('⚠️ n8n webhook timed out after 8000ms');
          } else {
            logPush(`⚠️ Failed to trigger n8n webhook: ${err?.message || err}`);
          }
        } finally {
          clearTimeout(timeoutId);
        }
      }
    }
  }

  if (saveLog) {
    persistJobLogs({ closeLogger: false });
    const logPath = path.join(destination, `clone-log-${Date.now()}.txt`);
    if (archivePath && fs.existsSync(archivePath)) {
      fs.copyFileSync(archivePath, logPath);
      savedJobReportCopies.add(logPath);
    } else {
      writeLogToFile(log, logPath);
      savedJobReportCopies.add(logPath);
    }
    logPush(`📝 Log saved to: ${logPath}`);
  }

  // Job-scoped logs are persisted via finish() (JSONL + TXT under userData/logs/clone).

  // 🧹 Optionally remove empty folders
if (config.removeEmptyFolders) {
  const removeEmptyDirs = dir => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        continue;
      }
      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch (err) {
        logPush(`⚠️ Unable to stat ${fullPath}: ${err?.message || err}`);
        continue;
      }
      if (stats.isDirectory()) {
        removeEmptyDirs(fullPath);
      }
    }
    const leftover = fs.readdirSync(dir);
    if (leftover.length === 0) {
      const relative = path.relative(destRoot, dir);
      const isInsideDestRoot = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      if (!isInsideDestRoot) {
        if (!relative || relative === '') {
          return;
        }
        logPush(`⚠️ Skipping removal outside destRoot: ${dir}`);
        return;
      }
      try {
        fs.rmdirSync(dir);
        logPush(`🗑 Removed empty folder: ${dir}`);
      } catch (err) {
        logPush(`⚠️ Unable to remove empty folder ${dir}: ${err?.message || err}`);
      }
    }
  };

  removeEmptyDirs(destRoot);
}

if (skippedFiles.length) {
  logPush(`⚠️ Skipped files (${skippedFiles.length}):`);
  skippedFiles.forEach(f => logPush(`  • ${f}`));
}

if (failedFiles.length) {
  logPush(`❌ Failed files (${failedFiles.length}):`);
  failedFiles.forEach(f => logPush(`  • ${f}`));
}

  const safeLog = log.map(entry => {
    if (typeof entry === 'string') return entry;
    try {
      return JSON.stringify(entry);
    } catch {
      return String(entry);
    }
  });
  const finalSuccess = !config.signal?.aborted && failedFiles.length === 0;
  jobLogger.setStage(finalSuccess ? 'complete' : (config.signal?.aborted ? 'cancelled' : 'error'));
  if (finalSuccess) {
    jobLogger.info('Clone job completed', { copied: copiedFiles.length, skipped: skippedFiles.length, failed: failedFiles.length });
  } else if (config.signal?.aborted) {
    jobLogger.warn('Clone job cancelled', { cancelled: true, copied: copiedFiles.length, skipped: skippedFiles.length, failed: failedFiles.length });
  } else {
    jobLogger.error('Clone job finished with failures', { copied: copiedFiles.length, skipped: skippedFiles.length, failed: failedFiles.length });
  }

  return finish({ success: finalSuccess, cancelled: Boolean(config.signal?.aborted), log: safeLog });
  } catch (err) {
    const msg = `❌ Unhandled clone error: ${err?.message || err}`;
    logPush(msg, '', true);
    jobLogger.setStage(config.signal?.aborted ? 'cancelled' : 'error');
    jobLogger.error('Clone job crashed', { error: err?.message || String(err), stack: err?.stack });
    return finish({ success: false, cancelled: Boolean(config.signal?.aborted), log });
  } finally {
    try { refreshSavedJobReportCopies(); } catch {}
    // Best-effort cleanup
    try { removeJobFile(); } catch {}
  }

}

async function calculateCloneBytes(cfg = {}) {
  try {
    const resolvedSourceRoot = path.resolve(cfg.source ?? cfg.sourceRoot ?? cfg.root ?? '');
    const selection = filterSelectionByRoot(buildSelection(cfg), resolvedSourceRoot);
    const rawExcludePatterns = Array.isArray(cfg.excludePatterns)
      ? cfg.excludePatterns
      : String(cfg.excludePatterns || '')
          .split(',')
          .map(p => p.trim())
          .filter(Boolean);

    const startedAt = Date.now();
    const fileCap = clampNumber(cfg?.previewFileCap ?? CLONE_PREVIEW_FILE_CAP, 1, CLONE_PREVIEW_FILE_CAP);
    const timeBudgetMs = clampNumber(cfg?.previewTimeBudgetMs ?? CLONE_PREVIEW_TIME_BUDGET_MS, 50, CLONE_PREVIEW_TIME_BUDGET_MS);
    let truncated = false;
    let total = 0;
    let fileCount = 0;
    let folderCount = 0;

    const shouldAbort = () => {
      if (fileCount >= fileCap || Date.now() - startedAt >= timeBudgetMs) {
        truncated = true;
        return true;
      }
      return false;
    };

    const iteratorConfig = {
      ...cfg,
      source: resolvedSourceRoot,
      selection,
      excludePatterns: rawExcludePatterns,
      shouldAbort
    };

    for await (const entry of iterateCloneEntries(iteratorConfig)) {
      if (!entry) continue;
      if (entry.type === 'dir') {
        folderCount += 1;
        continue;
      }
      if (entry.type !== 'file') continue;
      const full = entry.fullPath;
      if (!full) continue;
      try {
        const stats = await fsp.stat(full);
        const isFile = typeof stats.isFile === 'function' ? stats.isFile() : stats.isFile;
        if (isFile) {
          total += stats.size;
          fileCount += 1;
        }
      } catch {}
      if (shouldAbort()) break;
    }
    return { success: true, total, count: fileCount, fileCount, folderCount, truncated };
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

module.exports = {
  runClone,
  cancelClone,
  calculateCloneBytes
};
