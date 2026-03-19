const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
let BrowserWindow = null;
try {
  BrowserWindow = require('electron').BrowserWindow;
} catch {
  // Non-Electron / test harness context.
  BrowserWindow = null;
}
const { ensureUserDataSubdir } = require('../utils/appPaths');

function getRootLogDir() {
  return ensureUserDataSubdir('logs');
}

/**
 * Resolve the application version (best-effort).
 * This is useful to pin logs to a specific build.
 */
function getAppVersion() {
  try {
    // In the main Electron process, app is available globally
    // Fallback to env if running in atypical test harness
    const { app } = require('electron');
    return app?.getVersion?.() || process.env.APP_VERSION || '0.0.0';
  } catch {
    return process.env.APP_VERSION || '0.0.0';
  }
}
// Get the primary application window, ignoring DevTools focus
// Helper to get the primary application window in both main and test envs
const getMainWindow = () => {
  if (global.mainWindow) return global.mainWindow;
  if (BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function') {
    const win = BrowserWindow.getFocusedWindow();
    if (win) return win;
  }
  return BrowserWindow && typeof BrowserWindow.getAllWindows === 'function'
    ? BrowserWindow.getAllWindows()[0]
    : undefined;
};

function dispatchLogToRenderer(panel, payload) {
  const win = getMainWindow();
  if (win && win.webContents) {
    win.webContents.send(`${panel}-log-message`, payload);
  }
}


function captureTelemetryLogMessage(level, panel, message, detail, meta, jobId = '', stage = '') {
  try {
    const normalized = String(level || '').toLowerCase();
    if (normalized !== 'warn' && normalized !== 'warning' && normalized !== 'error') return;

    const telemetryService = require('../services/telemetryService');
    if (!telemetryService) return;

    const tags = {
      scope: 'panel-log',
      panel: panel || 'system',
      level: normalized === 'warning' ? 'warn' : normalized
    };
    const extraMeta = (meta && typeof meta === 'object') ? meta : undefined;
    const extra = {
      detail: detail || undefined,
      meta: extraMeta,
      jobId: jobId || undefined,
      stage: stage || undefined
    };
    const dedupeKey = `panel-log:${tags.panel}:${tags.level}:${String(message || '').slice(0, 200)}`;

    if (tags.level === 'error') {
      telemetryService.captureMessage?.(message, {
        level: 'error',
        tags,
        extra,
        dedupeKey,
        dedupeWindowMs: 30 * 1000
      });
    } else {
      telemetryService.captureMessage?.(message, {
        level: 'warning',
        tags,
        extra,
        dedupeKey,
        dedupeWindowMs: 30 * 1000
      });
    }
  } catch {
    // ignore
  }
}

function shouldCaptureTelemetryPanelLog(level, panel, message, meta, jobId) {
  try {
    const normalized = String(level || '').toLowerCase();
    if (normalized !== 'warn' && normalized !== 'warning' && normalized !== 'error') return false;

    const metaObj = (meta && typeof meta === 'object') ? meta : null;

    // Explicit opt-out (useful for very noisy call sites).
    if (metaObj && metaObj.suppressTelemetry === true) return false;

    // Default: do NOT capture job-scoped logs. These are often user/media specific and can be very noisy.
    const hasJob = jobId != null && String(jobId).trim() !== '';
    const explicit =
      !!(metaObj && (metaObj.telemetry === true || metaObj.telemetryCapture === true || metaObj.sentry === true));

    if (hasJob && !explicit) return false;

    // Avoid accidentally capturing command echoes (file paths, args, etc.)
    const msg = String(message || '');
    if (/^🛠\s*FFmpeg args:/i.test(msg) || /^🛠\s*FFprobe args:/i.test(msg)) return false;

    return true;
  } catch {
    return false;
  }
}

function sendLogMessage(
  type,
  message,
  detail = '',
  isError = false,
  fileId = '',
  level = null,
  jobId = '',
  stage = '',
  meta = null,
  timestamp = null
) {
  const resolvedLevel = level || (isError ? 'error' : 'info');
  const isWarning = resolvedLevel === 'warn';
  const isErr = resolvedLevel === 'error' || isError;

  sendLogToRenderer(
    message,
    isErr,
    false,
    fileId,
    type,
    detail,
    resolvedLevel,
    isWarning,
    jobId,
    stage,
    meta,
    timestamp
  );

  if (shouldCaptureTelemetryPanelLog(resolvedLevel, type, message, meta, jobId)) {
    captureTelemetryLogMessage(resolvedLevel, type, message, detail, meta, jobId, stage);
  }
}

function sendComparisonLog(message, isError = false, detail = '', fileId = '') {
  sendLogMessage('comparison', message, detail, isError, fileId);
}

function sendResolutionLog(message, isError = false, detail = '', fileId = '') {
  sendLogMessage('resolution', message, detail, isError, fileId);
}

/**
 * @typedef {Object} JobLogEntry
 * @property {string} timestamp ISO timestamp
 * @property {string} level    'debug' | 'info' | 'warn' | 'error'
 * @property {string} appVersion
 * @property {string} panel
 * @property {string} jobId
 * @property {string} stage
 * @property {string} message
 * @property {Object} [meta]
 */

/**
 * Create a job-scoped logger that:
 * - emits structured entries
 * - mirrors to the renderer for live UI
 */
function createJobLogger({
  panel,
  jobId,
  stage = 'init',
  collector = null,
  streamToFile = false,
  streamFlushEvery = 25,
  maxEntries = 0,
  maxEntryBytes = 0
} = {}) {
  const appVersion = getAppVersion();
  /** @type {JobLogEntry[]} */
  const entries = [];
  const entrySizes = [];
  const entryLimit = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0
    ? Math.floor(Number(maxEntries))
    : 0;
  const entryByteLimit = Number.isFinite(Number(maxEntryBytes)) && Number(maxEntryBytes) > 0
    ? Math.floor(Number(maxEntryBytes))
    : 0;
  let entryBytes = 0;

  // Phase 2E: crash-safe-ish structured logging.
  // We open a stream once and write JSONL entries incrementally.
  let structuredLogPath = null;
  let writeStream = null;
  let writesSinceFlush = 0;
  let flushTimer = null;
  let isFlushing = false;
  let isClosing = false;
  let isBackpressured = false;
  const writeBuffer = [];
  const startedStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const flushThreshold = Math.max(1, Number(streamFlushEvery) || 1);
  const flushDelayMs = 100;

  if (streamToFile) {
    try {
      const folder = path.join(getRootLogDir(), panel || 'system');
      fs.mkdirSync(folder, { recursive: true });
      const safeJobId = sanitizeFilePart(jobId) || 'unknown-job';
      structuredLogPath = path.join(folder, `${startedStamp}--${safeJobId}.jsonl`);
      writeStream = fs.createWriteStream(structuredLogPath, { flags: 'a' });
      writeStream.on('error', () => {
        writeStream = null;
        writeBuffer.length = 0;
      });
    } catch {
      structuredLogPath = null;
      writeStream = null;
    }
  }

  const finalizeClose = () => {
    if (!writeStream) return;
    writeStream.end();
    writeStream = null;
  };

  const flushBuffer = () => {
    if (!writeStream || isFlushing || isBackpressured) return;
    if (writeBuffer.length === 0) {
      if (isClosing) finalizeClose();
      return;
    }
    isFlushing = true;
    const chunk = writeBuffer.join('');
    writeBuffer.length = 0;
    writesSinceFlush = 0;
    const canWrite = writeStream.write(chunk, 'utf8');
    if (!canWrite) {
      isBackpressured = true;
      writeStream.once('drain', () => {
        isBackpressured = false;
        isFlushing = false;
        if (writeBuffer.length > 0) scheduleFlush(0);
        if (isClosing && writeBuffer.length === 0) finalizeClose();
      });
      return;
    }
    isFlushing = false;
    if (writeBuffer.length > 0) scheduleFlush(0);
    if (isClosing && writeBuffer.length === 0) finalizeClose();
  };

  const scheduleFlush = (delay) => {
    if (flushTimer || !writeStream) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBuffer();
    }, delay);
  };

  const appendToJsonl = (entry) => {
    if (!writeStream) return;
    try {
      writeBuffer.push(JSON.stringify(entry) + '\n');
      writesSinceFlush += 1;
      if (writesSinceFlush >= flushThreshold) {
        scheduleFlush(0);
      } else {
        scheduleFlush(flushDelayMs);
      }
    } catch {
      writeStream = null;
      writeBuffer.length = 0;
    }
  };

  const close = () => {
    if (!writeStream) return;
    isClosing = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushBuffer();
    if (!isFlushing && !isBackpressured && writeBuffer.length === 0) {
      finalizeClose();
    }
  };

  const push = (level, message, meta = {}) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      appVersion,
      panel,
      jobId: jobId || '',
      stage,
      message,
      meta
    };

    const entrySize = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    entries.push(entry);
    entrySizes.push(entrySize);
    entryBytes += entrySize;

    while (
      (entryLimit > 0 && entries.length > entryLimit) ||
      (entryByteLimit > 0 && entryBytes > entryByteLimit)
    ) {
      entries.shift();
      const removedSize = entrySizes.shift() || 0;
      entryBytes = Math.max(0, entryBytes - removedSize);
    }

    if (collector) collector.push(entry);
    appendToJsonl(entry);

    const isError = level === 'error';
    const metaObj =
      meta && typeof meta === 'object' && !Array.isArray(meta) && Object.keys(meta).length
        ? meta
        : null;

    const fileTag =
      metaObj && Object.prototype.hasOwnProperty.call(metaObj, 'fileId') && metaObj.fileId
        ? String(metaObj.fileId)
        : (jobId || '');

    let safeDetail = '';
    try {
      safeDetail = metaObj ? JSON.stringify(metaObj) : '';
    } catch {
      safeDetail = '';
    }

    // Canonical renderer payload (no UI prefix parsing needed)
    sendLogMessage(
      panel,
      message,
      safeDetail,
      isError,
      fileTag,
      level,
      jobId || '',
      stage || '',
      metaObj,
      Date.now()
    );
  };

  return {
    info: (msg, meta) => push('info', msg, meta),
    warn: (msg, meta) => push('warn', msg, meta),
    error: (msg, meta) => push('error', msg, meta),
    debug: (msg, meta) => push('debug', msg, meta),
    setStage(newStage) {
      stage = newStage || stage;
    },
    getEntries() {
      return entries.slice();
    },
    getStructuredLogPath() {
      return structuredLogPath;
    },
    close
  };
}

/**
 * 📤 Sends a message to the renderer (UI)
 *
 * @param {string} message - Message to display
 * @param {boolean} [isError=false] - Whether the message is an error
 * @param {boolean} [overwrite=false] - Whether to replace existing log line
 * @param {string|null} [fileId=null] - Optional ID to tag message to file
 */
function sendLogToRenderer(
  message,
  isError = false,
  overwrite = false,
  fileId = null,
  panel = 'ingest',
  detail = '',
  level = null,
  isWarning = false,
  jobId = '',
  stage = '',
  meta = null,
  timestamp = null
) {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;

  const resolvedLevel = level || (isError ? 'error' : isWarning ? 'warn' : 'info');
  const resolvedIsError = resolvedLevel === 'error' || isError;
  const resolvedIsWarning = resolvedLevel === 'warn' || isWarning;

  const payload = {
    msg: message,
    detail,
    isError: resolvedIsError,
    isWarning: resolvedIsWarning,
    level: resolvedLevel,
    overwrite,
    fileId,

    // ✅ Phase 1 canonical fields
    timestamp: (timestamp != null && Number.isFinite(Number(timestamp))) ? Number(timestamp) : Date.now(),
    panel: panel || 'system',
    jobId: jobId != null ? String(jobId) : '',
    stage: stage != null ? String(stage) : '',
    meta:
      meta && typeof meta === 'object' && !Array.isArray(meta) && Object.keys(meta).length
        ? meta
        : undefined
  };

  dispatchLogToRenderer(panel, payload);
}
/**
 * 📝 Writes the full ingest log to a file
 *
 * @param {string[]} logLines - Array of strings (log content)
 * @param {string} targetPath - File path to write to
 */
function writeLogToFile(logLines, targetPath) {
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, logLines.join('\n'));
    return true;
  } catch (err) {
    console.error(`❌ Failed to write log file: ${targetPath}`, err.message);
    return false;
  }
}

function archivePanelSessionLog(logLines, panel = 'system') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(getRootLogDir(), panel);
  const filePath = path.join(folder, `${timestamp}.txt`);
  writeLogToFile(logLines, filePath);
  return filePath;
}

// Shared metadata convention for writeJobTextToFile(..., { inputs, outputs, settings, stats }).
//
// Required: callers should always provide objects for inputs/outputs/settings (stats optional)
//           and prefer these common keys when applicable.
// Optional: panel-specific values can be added as extra keys under each section.
const JOB_TEXT_METADATA_CONVENTION = Object.freeze({
  inputs: Object.freeze([
    'sourceCount',
    'sources',
    'sourceRoot'
  ]),
  outputs: Object.freeze([
    'primaryDestination',
    'secondaryDestination'
  ]),
  settings: Object.freeze([
    'mode',
    'verificationMethod'
  ]),
  stats: Object.freeze([])
});

function applyMetadataKeyOrder(data, preferredKeys = []) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const ordered = {};

  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      ordered[key] = data[key];
    }
  }

  for (const key of Object.keys(data)) {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
      ordered[key] = data[key];
    }
  }

  return ordered;
}

function appendKeyValueSection(lines, title, data) {
  if (!lines || !Array.isArray(lines)) return;
  if (data == null) return;

  const pushScalar = (prefix, value) => {
    if (value == null) return;
    const str = String(value);
    if (!str.trim()) return;
    lines.push(`${prefix}${str}`);
  };

  const isPlainObject = v => v && typeof v === 'object' && !Array.isArray(v);

  if (Array.isArray(data)) {
    const items = data.map(v => String(v ?? '').trim()).filter(Boolean);
    if (!items.length) return;
    lines.push(`${title}:`);
    for (const item of items) lines.push(`  - ${item}`);
    return;
  }

  if (isPlainObject(data)) {
    const keys = Object.keys(data).filter(k => k != null && String(k).trim());
    const hasAny = keys.some(k => {
      const v = data[k];
      if (Array.isArray(v)) return v.filter(x => x != null && String(x).trim()).length > 0;
      if (isPlainObject(v)) return Object.keys(v).length > 0;
      return v != null && String(v).trim() !== '';
    });
    if (!hasAny) return;

    lines.push(`${title}:`);
    for (const k of keys) {
      const v = data[k];
      if (v == null) continue;

      if (Array.isArray(v)) {
        const items = v.map(x => String(x ?? '').trim()).filter(Boolean);
        if (!items.length) continue;
        lines.push(`  - ${k}:`);
        const limit = 40;
        const shown = items.slice(0, limit);
        for (const item of shown) lines.push(`      • ${item}`);
        if (items.length > limit) lines.push(`      • …and ${items.length - limit} more`);
        continue;
      }

      if (isPlainObject(v)) {
        const subKeys = Object.keys(v);
        if (!subKeys.length) continue;
        lines.push(`  - ${k}:`);
        for (const sk of subKeys) {
          const sv = v[sk];
          if (sv == null || String(sv).trim() === '') continue;
          lines.push(`      • ${sk}: ${String(sv)}`);
        }
        continue;
      }

      pushScalar(`  - ${k}: `, v);
    }
    return;
  }

  pushScalar(`${title}: `, data);
}

function sanitizeFilePart(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function parseJobIdFromFilename(filename) {
  const name = String(filename || '');
  const m = name.match(/--([^\\/]+)\.(?:txt|jsonl)$/i);
  return m ? m[1] : '';
}

function formatJobEntryForText(entry) {
  if (!entry || typeof entry !== 'object') return String(entry ?? '');
  const tsRaw = entry.timestamp;
  const ts = typeof tsRaw === 'string' ? tsRaw : new Date().toISOString();
  const panel = entry.panel ? String(entry.panel) : 'system';
  const job = entry.jobId != null && String(entry.jobId).trim() ? String(entry.jobId).trim() : 'unknown-job';
  const stage = entry.stage ? String(entry.stage) : '';
  const level = entry.level ? String(entry.level).toUpperCase() : 'INFO';
  const message = entry.message != null ? String(entry.message) : '';
  let meta = '';
  if (entry.meta && typeof entry.meta === 'object') {
    try {
      const s = JSON.stringify(entry.meta);
      if (s && s !== '{}' && s !== '[]') meta = ` → ${s}`;
    } catch {}
  }
  return `[${ts}] [${panel}] [${job}]${stage ? ` [${stage}]` : ''} [${level}] ${message}${meta}`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveJobOutcome(entries) {
  const list = Array.isArray(entries) ? entries : [];
  // Prefer the last explicit stage, otherwise fall back to last error/warn.
  const lastWithStage = [...list].reverse().find(e => e && typeof e === 'object' && e.stage);
  const stage = (lastWithStage?.stage || '').toLowerCase();

  if (stage.includes('cancel')) return 'cancelled';
  if (stage.includes('error') || stage.includes('fail')) return 'error';
  if (stage.includes('complete') || stage.includes('done') || stage.includes('success')) return 'complete';

  const lastError = [...list].reverse().find(e => e && typeof e === 'object' && e.level === 'error');
  if (lastError) return 'error';

  return 'unknown';
}

function formatDurationMs(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const sec = Math.floor(total / 1000);
  const s = sec % 60;
  const min = Math.floor(sec / 60) % 60;
  const hr = Math.floor(sec / 3600);

  if (hr > 0) return `${hr}h ${min}m ${s}s`;
  if (min > 0) return `${min}m ${s}s`;
  return `${s}s`;
}

function summarizeLevels(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let errors = 0;
  let warnings = 0;
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (e.level === 'error') errors += 1;
    else if (e.level === 'warn' || e.level === 'warning') warnings += 1;
  }
  return { errors, warnings };
}

function summarizeErrors(entries, limit = 5) {
  const list = Array.isArray(entries) ? entries : [];
  const errs = list.filter(e => e && typeof e === 'object' && e.level === 'error');
  if (!errs.length) return [];

  const tail = errs.slice(-Math.max(1, limit));
  return tail.map(e => {
    const stage = e.stage ? String(e.stage) : '';
    const msg = e.message != null ? String(e.message) : '';
    return stage ? `[${stage}] ${msg}` : msg;
  });
}

function deriveStampFromStructuredLogPath(structuredLogPath, safeJobId) {
  if (!structuredLogPath) return null;
  try {
    const base = path.basename(String(structuredLogPath));
    const re = new RegExp(`^(.*)--${escapeRegExp(safeJobId)}\\.jsonl$`, 'i');
    const m = base.match(re);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function writeJobTextToFile(panel, jobId, entries, options = {}) {
  const folder = path.join(getRootLogDir(), panel || 'system');
  fs.mkdirSync(folder, { recursive: true });

  const safeJobId = sanitizeFilePart(jobId) || 'unknown-job';
  const stamp =
    (options && options.timestampOverride)
      ? String(options.timestampOverride)
      : deriveStampFromStructuredLogPath(options?.structuredLogPath, safeJobId) ||
        new Date().toISOString().replace(/[:.]/g, '-');

  const filename = `${stamp}--${safeJobId}.txt`;
  const filePath = path.join(folder, filename);

  const list = Array.isArray(entries) ? entries : [];
  const appVersion = list[0]?.appVersion ? String(list[0].appVersion) : getAppVersion();

  const times = list
    .map(e => (typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) : null))
    .filter(v => v != null && !Number.isNaN(v));
  const startTs = times.length ? Math.min(...times) : null;
  const endTs = times.length ? Math.max(...times) : null;

  const startLocal = startTs != null ? new Date(startTs).toLocaleString() : 'Unknown';
  const endLocal = endTs != null ? new Date(endTs).toLocaleString() : 'Unknown';
  const duration = (startTs != null && endTs != null) ? formatDurationMs(endTs - startTs) : 'Unknown';

  const outcome = deriveJobOutcome(list);
  const { errors, warnings } = summarizeLevels(list);
  const errorSummary = summarizeErrors(list, 5);

  const structuredHint =
    options?.structuredLogPath
      ? String(options.structuredLogPath)
      : '(see matching JSONL in this folder)';

  const headerLines = [
    'LEAD AE ASSIST — Job Report',
    `Panel: ${panel || 'system'}`,
    `Job ID: ${jobId || 'unknown-job'}`,
    `Outcome: ${outcome}`,
    `Start: ${startLocal}`,
    `End: ${endLocal}`,
    `Duration: ${duration}`,
    `App Version: ${appVersion}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Structured Log (JSONL): ${structuredHint}`,
    `Human Log (TXT): ${filePath}`,
    `Warnings: ${warnings}`,
    `Errors: ${errors}`,
  ];

  appendKeyValueSection(
    headerLines,
    'Inputs',
    applyMetadataKeyOrder(options?.inputs, JOB_TEXT_METADATA_CONVENTION.inputs)
  );
  appendKeyValueSection(
    headerLines,
    'Outputs',
    applyMetadataKeyOrder(options?.outputs, JOB_TEXT_METADATA_CONVENTION.outputs)
  );
  appendKeyValueSection(
    headerLines,
    'Settings',
    applyMetadataKeyOrder(options?.settings, JOB_TEXT_METADATA_CONVENTION.settings)
  );
  appendKeyValueSection(
    headerLines,
    'Stats',
    applyMetadataKeyOrder(options?.stats, JOB_TEXT_METADATA_CONVENTION.stats)
  );

  if (errorSummary.length) {
    headerLines.push('Error Summary (latest):');
    for (const line of errorSummary) headerLines.push(`  - ${line}`);
  }

  headerLines.push('');

  const textLines = list.map(e => formatJobEntryForText(e));
  fs.writeFileSync(filePath, headerLines.concat(textLines).join('\n'), 'utf8');
  return filePath;
}


/**
 * Writes a single job's structured log entries to a JSONL file.
 * Filename format: YYYY-MM-DDTHH-MM-SS-ms--<jobId>.jsonl
 *
 * @param {string} panel
 * @param {string} jobId
 * @param {JobLogEntry[]} entries
 * @returns {string} full path to log file
 */
function writeJobLogToFile(panel, jobId, entries) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(getRootLogDir(), panel || 'system');
  fs.mkdirSync(folder, { recursive: true });

  const safeJobId = sanitizeFilePart(jobId) || 'unknown-job';
  const filename = `${timestamp}--${safeJobId}.jsonl`;
  const filePath = path.join(folder, filename);

  const lines = (entries || []).map(e => JSON.stringify(e));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

const MAX_LOG_FILE_BYTES = 8 * 1024 * 1024; // 8MB cap per file to avoid huge reads.
const MAX_LOG_LINES = 10000; // Keep only the last N lines to protect memory.

/**
 * 📖 Reads log files recursively and returns parsed entries.
 * Caps:
 * - File size: reads only the last 8MB of any log file.
 * - Line count: keeps only the last 10,000 lines per file.
 *
 * @param {string} dir - Folder containing log files or subfolders
 * @param {RegExp} [pattern=/\.(txt|jsonl)$/] - Filename pattern to match
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{timestamp:number,type:string,message:string,detail:string,status:string,file:string}>>}
 */
async function readLogFiles(dir, pattern = /\.(txt|jsonl)$/, options = {}) {
  const { signal } = options;
  const entries = [];

  if (signal?.aborted) return entries;
  try {
    await fsp.access(dir, fs.constants.F_OK);
  } catch {
    return entries;
  }

  let list = [];
  try {
    list = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const item of list) {
    if (signal?.aborted) return entries;
    const itemPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      const sub = await readLogFiles(itemPath, pattern, options);
      sub.forEach(log => {
        if (!log.type) log.type = item.name;
        entries.push(log);
      });
    } else if (pattern.test(item.name)) {
      try {
        const stat = await fsp.stat(itemPath);
        const type = path.basename(dir);
        let content = '';
        let truncatedBySize = false;
        if (stat.size > MAX_LOG_FILE_BYTES) {
          truncatedBySize = true;
          const start = Math.max(0, stat.size - MAX_LOG_FILE_BYTES);
          const length = stat.size - start;
          const handle = await fsp.open(itemPath, 'r');
          try {
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, start);
            content = buffer.toString('utf-8');
          } finally {
            await handle.close();
          }
        } else {
          content = await fsp.readFile(itemPath, 'utf-8');
        }

        let lines = content.split(/\r?\n/);
        let truncatedByLines = false;
        if (lines.length > MAX_LOG_LINES) {
          truncatedByLines = true;
          lines = lines.slice(-MAX_LOG_LINES);
        }

        if (truncatedBySize || truncatedByLines) {
          const sizeLimitMb = (MAX_LOG_FILE_BYTES / (1024 * 1024)).toFixed(0);
          const reasons = [];
          if (truncatedBySize) reasons.push(`last ${sizeLimitMb}MB`);
          if (truncatedByLines) reasons.push(`last ${MAX_LOG_LINES.toLocaleString()} lines`);
          entries.push({
            timestamp: stat.mtimeMs,
            type,
            panel: type,
            jobId: parseJobIdFromFilename(item.name) || '',
            stage: '',
            level: 'warn',
            message: `⚠️ Log file "${item.name}" truncated (${reasons.join(' & ')}).`,
            detail: `Caps: ${sizeLimitMb}MB per file, ${MAX_LOG_LINES.toLocaleString()} lines per file.`,
            status: 'warning',
            file: item.name
          });
        }

        if (item.name.endsWith('.jsonl')) {
          lines.forEach(line => {
            if (!line.trim()) return;
            try {
              const parsed = JSON.parse(line);
              const jobIdFromFile = parseJobIdFromFilename(item.name);
              if ((!parsed.jobId || !String(parsed.jobId).trim()) && jobIdFromFile) {
                parsed.jobId = jobIdFromFile;
              }
              const rawTimestamp = parsed.timestamp;
              let ts = NaN;
              if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
                ts = rawTimestamp;
              } else if (typeof rawTimestamp === 'string') {
                const trimmed = rawTimestamp.trim();
                if (/^\d+(\.\d+)?$/.test(trimmed)) {
                  ts = Number(trimmed);
                } else if (/^\d{4}-\d{2}-\d{2}([T\s].*)?$/.test(trimmed)) {
                  ts = Date.parse(trimmed);
                }
              }
              if (Number.isNaN(ts)) {
                ts = stat.mtimeMs;
              }
              const rawStatus = parsed.status ?? parsed.level;
              const normalizedStatus = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
              const status =
                normalizedStatus === 'error'
                  ? 'error'
                  : normalizedStatus === 'warn' || normalizedStatus === 'warning'
                    ? 'warning'
                    : 'info';
              entries.push({
                ...parsed,
                timestamp: ts,
                type: parsed.panel || parsed.type || type,
                status,
                file: item.name
              });
            } catch (err) {
              console.error('❌ Failed to parse JSON log line:', itemPath, err.message);
            }
          });
        } else {
          const jobIdFromFile = parseJobIdFromFilename(item.name);
          lines.forEach(line => {
            if (!line.trim()) return;
            const parsedStructured = parseStructuredTextLogLine(line);
            if (parsedStructured) {
              const lvl = parsedStructured.level || 'info';
              const status =
                lvl === 'error'
                  ? 'error'
                  : (lvl === 'warn' || lvl === 'warning')
                    ? 'warning'
                    : 'info';
              entries.push({
                timestamp: Number.isFinite(parsedStructured.timestampMs) ? parsedStructured.timestampMs : stat.mtimeMs,
                type: parsedStructured.panel || type,
                panel: parsedStructured.panel || type,
                jobId: parsedStructured.jobId || jobIdFromFile || '',
                stage: parsedStructured.stage || '',
                level: lvl,
                message: parsedStructured.message || '',
                detail: parsedStructured.detail || '',
                meta: parsedStructured.meta || undefined,
                status,
                file: item.name
              });
              return;
            }

            const trimmed = String(line || '').trimEnd();
            const parsedTimestamp = parseTimestampFromLine(trimmed);

            // Heuristic severity detection for plain-text logs.
            //
            // Be careful: summary lines like "Errors: 0" / "Warnings: 0" are *not* themselves
            // an error/warn. Only treat them as such when the count is non-zero.
            let status = 'info';
            const countLineMatch = trimmed.match(/^(?:(?:✅|❌|⚠️)\s*)?(Errors|Warnings|Failed)\s*:\s*(\d+)\b/i);
            if (countLineMatch) {
              const label = String(countLineMatch[1] || '').toLowerCase();
              const count = parseInt(countLineMatch[2], 10);
              if (Number.isFinite(count) && count > 0) {
                status = label.startsWith('warn') ? 'warning' : 'error';
              }
            } else if (/^🧪\s*FFmpeg command:/i.test(trimmed)) {
              status = 'info';
            } else {
              if (/❌|\berror\b/i.test(trimmed)) status = 'error';
              else if (/⚠️|\bwarn(?:ing)?\b/i.test(trimmed)) status = 'warning';
            }
            entries.push({
              timestamp: Number.isNaN(parsedTimestamp) ? stat.mtimeMs : parsedTimestamp,
              type,
              panel: type,
              jobId: jobIdFromFile || '',
              stage: '',
              level: status === 'error' ? 'error' : status === 'warning' ? 'warn' : 'info',
              message: trimmed,
              detail: '',
              status,
              file: item.name
            });
          });
        }
      } catch (err) {
        console.error('❌ Failed to read log file:', itemPath, err.message);
      }
    }
  }

  return entries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function parseTimestampFromLine(line) {
  if (!line) return NaN;
  const trimmed = line.trim();
  const isoMatch = trimmed.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0]);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const localeMatch = trimmed.match(/\[(\d{1,2}\/\d{1,2}\/\d{4}, [^\]]+)\]/);
  if (localeMatch) {
    const parsed = Date.parse(localeMatch[1]);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return NaN;
}

function parseStructuredTextLogLine(line) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) return null;

  const prefixMatch = trimmed.match(/^(\[[^\]]+\]\s*)+/);
  if (!prefixMatch) return null;

  const prefix = prefixMatch[0];
  const segments = Array.from(prefix.matchAll(/\[([^\]]+)\]/g)).map(m => m[1]);
  if (segments.length < 3) return null;

  const tsToken = String(segments[0] || '').trim();
  let timestampMs = NaN;
  if (/^\d+(\.\d+)?$/.test(tsToken)) timestampMs = Number(tsToken);
  else {
    const parsed = Date.parse(tsToken);
    if (!Number.isNaN(parsed)) timestampMs = parsed;
  }

  const panel = String(segments[1] || '').trim();
  const jobId = String(segments[2] || '').trim();

  let stage = '';
  let level = 'info';
  if (segments.length >= 5) {
    stage = String(segments[3] || '').trim();
    level = String(segments[4] || '').trim().toLowerCase();
  } else if (segments.length === 4) {
    level = String(segments[3] || '').trim().toLowerCase();
  }

  if (level === 'warning') level = 'warn';
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    level = level.includes('err') ? 'error' : level.includes('warn') ? 'warn' : 'info';
  }

  let message = trimmed.slice(prefix.length).trimStart();
  let detail = '';
  let meta = null;

  const arrowIndex = message.indexOf('→');
  if (arrowIndex !== -1) {
    const before = message.slice(0, arrowIndex).trimEnd();
    const after = message.slice(arrowIndex + 1).trim();
    message = before;
    detail = after;
    if (after.startsWith('{') && after.endsWith('}') && after.length < 20000) {
      try { meta = JSON.parse(after); } catch { meta = null; }
    }
  }

  return { timestampMs, panel, jobId, stage, level, message, detail, meta };
}

/**
 * Create a user-facing log line collector that also forwards each line to a job logger.
 * This replaces the old "override Array.push" pattern.
 *
 * @param {object} jobLogger - Result of createJobLogger(...)
 * @param {object} [opts]
 * @param {(msg:any)=>string} [opts.normalize] - Converts msg into a string line for storage.
 * @param {(normalizedMsg:string, isError:boolean, ctx:{detail?:string,fileId?:string})=>('info'|'warn'|'error')} [opts.pickLevel]
 * @returns {{ lines: string[], push: Function, text: Function }}
 */
function createJobUserLog(jobLogger, opts = {}) {
  const lines = [];
  const lineSizes = [];
  const maxLines = Number.isFinite(Number(opts.maxLines)) && Number(opts.maxLines) > 0
    ? Math.floor(Number(opts.maxLines))
    : 0;
  const maxBytes = Number.isFinite(Number(opts.maxBytes)) && Number(opts.maxBytes) > 0
    ? Math.floor(Number(opts.maxBytes))
    : 0;
  let totalBytes = 0;
  const normalize = typeof opts.normalize === 'function'
    ? opts.normalize
    : (msg) => (typeof msg === 'string' ? msg : String(msg ?? ''));

  const pickLevel = typeof opts.pickLevel === 'function'
    ? opts.pickLevel
    : (_normalizedMsg, isError) => (isError ? 'error' : 'info');

  // Back-compat: existing calls still pass (msg, detail, isError, fileId)
  const push = (msg, detail = '', isError = false, fileId = '') => {
    const normalized = normalize(msg);
    const meta = {};
    if (detail) meta.detail = detail;
    if (fileId) meta.fileId = fileId;

    const level = pickLevel(normalized, isError, { detail, fileId });
    if (level === 'error') jobLogger.error(normalized, meta);
    else if (level === 'warn') jobLogger.warn(normalized, meta);
    else jobLogger.info(normalized, meta);

    const lineSize = Buffer.byteLength(`${normalized}\n`, 'utf8');
    lines.push(normalized);
    lineSizes.push(lineSize);
    totalBytes += lineSize;

    while (
      (maxLines > 0 && lines.length > maxLines) ||
      (maxBytes > 0 && totalBytes > maxBytes)
    ) {
      lines.shift();
      const removedSize = lineSizes.shift() || 0;
      totalBytes = Math.max(0, totalBytes - removedSize);
    }

    return lines.length;
  };

  return {
    lines,
    push,
    text: () => lines.join('\n')
  };
}

function createSessionLogWriter({ panel = 'system', prefix = 'session', maxBytes = 5 * 1024 * 1024, maxFiles = 5 } = {}) {
  const folder = path.join(getRootLogDir(), panel || 'system');
  fs.mkdirSync(folder, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safePrefix = sanitizeFilePart(prefix) || 'session';
  const capBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  const capFiles = Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : 0;

  let part = 1;
  let stream = null;
  let currentBytes = 0;
  const filePaths = [];

  const buildPath = (index) => {
    const suffix = index > 1 ? `-part${index}` : '';
    return path.join(folder, `${stamp}--${safePrefix}${suffix}.txt`);
  };

  const openStream = () => {
    if (stream) return;
    const filePath = buildPath(part);
    stream = fs.createWriteStream(filePath, { flags: 'a' });
    currentBytes = 0;
    filePaths.push(filePath);

    if (capFiles > 0 && filePaths.length > capFiles) {
      const toDelete = filePaths.splice(0, filePaths.length - capFiles);
      for (const oldPath of toDelete) {
        try {
          fs.unlinkSync(oldPath);
        } catch {
          // ignore
        }
      }
    }

    stream.on('error', () => {
      stream = null;
    });
  };

  const rotate = () => {
    if (stream) {
      stream.end();
      stream = null;
    }
    part += 1;
    openStream();
  };

  const append = (line) => {
    if (line == null) return;
    openStream();
    if (!stream) return;
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (capBytes > 0 && currentBytes + bytes > capBytes) {
      rotate();
      if (!stream) return;
    }
    try {
      stream.write(text, 'utf8');
      currentBytes += bytes;
    } catch {
      stream = null;
    }
  };

  const close = () => {
    if (stream) {
      stream.end();
      stream = null;
    }
  };

  return {
    append,
    close,
    getCurrentPath: () => (stream ? buildPath(part) : null),
    getAllPaths: () => filePaths.slice()
  };
}

module.exports = {
  sendLogMessage,
  sendLogToRenderer,
  writeLogToFile,
  readLogFiles,
  archivePanelSessionLog,
  sendComparisonLog,
  sendResolutionLog,
  createJobLogger,
  createJobUserLog,
  writeJobLogToFile,
  writeJobTextToFile,
  createSessionLogWriter
};
