const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fileURLToPath } = require('url');
const { createJobLogger, createJobUserLog, writeJobLogToFile, writeJobTextToFile } = require('./logUtils');
const { ensureFolder } = require('../utils/path');

const PROJECT_ORGANIZER_MESSAGE_KEYS = Object.freeze({
  'missing-output-or-selection': 'projectOrganizerLegacyMissingOutputOrSelection',
  'invalid-root-name': 'projectOrganizerLegacyInvalidRootName',
  'invalid-folder-selection': 'projectOrganizerLegacyInvalidFolderSelection',
  'invalid-input': 'projectOrganizerLegacyInvalidInput',
  'duplicate-folder-selection-removed': 'projectOrganizerLegacyDuplicateFolderSelectionRemoved',
  'output-root-missing': 'projectOrganizerLegacyOutputRootMustBeExistingFolder',
  'output-root-not-directory': 'projectOrganizerLegacyOutputRootMustBeExistingFolder',
  'output-root-not-writable': 'projectOrganizerLegacyOutputRootNotWritable',
  'root-not-directory': 'projectOrganizerLegacyRootNotDirectory',
  'root-exists': 'projectOrganizerLegacyRootExists',
  'asset-entry-invalid': 'projectOrganizerLegacyAssetEntryInvalid',
  'asset-file-url-invalid': 'projectOrganizerLegacyAssetFileUrlInvalid',
  'asset-path-not-absolute': 'projectOrganizerLegacyAssetPathNotAbsolute',
  'asset-unreadable': 'projectOrganizerLegacyAssetUnreadable',
  'asset-not-file': 'projectOrganizerLegacyAssetNotFile',
  'asset-not-readable': 'projectOrganizerLegacyAssetNotReadable',
  'asset-duplicate-skipped': 'projectOrganizerLegacyAssetDuplicateSkipped',
  'asset-copy-failed': 'projectOrganizerLegacyAssetCopyFailed',
  'project-structure-created-with-issues': 'projectOrganizerLegacySummaryCreatedWithIssues',
  'project-structure-created': 'projectOrganizerLegacySummaryCreated',
  'project-organizer-cancelled': 'projectOrganizerLegacyCancelled',
  'project-organizer-uncaught-error': 'projectOrganizerLegacyUncaughtError'
});

const PROJECT_ORGANIZER_REASON_KEYS = Object.freeze({
  folderNameReservedMetaKey: 'projectOrganizerReasonFolderNameReservedMetaKey',
  folderNameEmpty: 'projectOrganizerReasonFolderNameEmpty',
  folderNameContainsSeparator: 'projectOrganizerReasonFolderNameContainsSeparator',
  folderNameContainsDotDot: 'projectOrganizerReasonFolderNameContainsDotDot',
  folderNameEndsWithDotOrSpace: 'projectOrganizerReasonFolderNameEndsWithDotOrSpace',
  folderNameReservedDeviceName: 'projectOrganizerReasonFolderNameReservedDeviceName',
  folderNameIllegalCharacter: 'projectOrganizerReasonFolderNameIllegalCharacter',
  folderEntryMustBeString: 'projectOrganizerReasonFolderEntryMustBeString',
  folderEntryAbsolutePathNotAllowed: 'projectOrganizerReasonFolderEntryAbsolutePathNotAllowed',
  folderEntryDotSegmentNotAllowed: 'projectOrganizerReasonFolderEntryDotSegmentNotAllowed',
  folderEntryEmpty: 'projectOrganizerReasonFolderEntryEmpty',
  invalidRootName: 'projectOrganizerReasonInvalidRootName',
  invalidFolderSelection: 'projectOrganizerReasonInvalidFolderSelection',
  invalidInput: 'projectOrganizerReasonInvalidInput',
  ENOENT: 'projectOrganizerReasonErrNoEnt',
  EACCES: 'projectOrganizerReasonErrAccess',
  EPERM: 'projectOrganizerReasonErrPerm',
  EISDIR: 'projectOrganizerReasonErrIsDir',
  ENOTDIR: 'projectOrganizerReasonErrNotDir',
  EINVAL: 'projectOrganizerReasonErrInvalid',
  assetFileUrlInvalid: 'projectOrganizerReasonAssetFileUrlInvalid',
  assetUnreadable: 'projectOrganizerReasonAssetUnreadable',
  assetNotReadable: 'projectOrganizerReasonAssetNotReadable',
  assetNotFile: 'projectOrganizerReasonAssetNotFile',
  assetCopyFailed: 'projectOrganizerReasonAssetCopyFailed',
  destinationEscapesOutputRoot: 'projectOrganizerReasonDestinationEscapesOutputRoot',
  destinationOutsideOutputRoot: 'projectOrganizerReasonDestinationOutsideOutputRoot',
  destinationSymlinkOutsideOutputRoot: 'projectOrganizerReasonDestinationSymlinkOutsideOutputRoot',
  tooManyFilenameCollisions: 'projectOrganizerReasonTooManyFilenameCollisions',
  projectOrganizerUncaughtError: 'projectOrganizerReasonUncaughtError'
});

const localeMessagesCache = new Map();

function loadLocaleMessages(localeCode) {
  const normalized = String(localeCode || 'en').toLowerCase();
  if (localeMessagesCache.has(normalized)) return localeMessagesCache.get(normalized);
  const localePath = path.join(__dirname, '..', 'locales', `${normalized}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    localeMessagesCache.set(normalized, parsed && typeof parsed === 'object' ? parsed : {});
  } catch {
    localeMessagesCache.set(normalized, {});
  }
  return localeMessagesCache.get(normalized);
}

function interpolateTemplate(template, params = {}) {
  return String(template || '').replace(/{{\s*([^{}\s]+)\s*}}/g, (_match, token) => (
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : ''
  ));
}
/**
 * Create the folder structure based on config from renderer
 * with unified, job-based logging.
 */

function isReservedMetaKey(value) {
  return value === '__proto__' || value === 'prototype' || value === 'constructor';
}

function createReasonCodeError(reasonCode, message = '', reasonParams = {}) {
  const err = new Error(message || reasonCode || 'validation-error');
  err.reasonCode = reasonCode || 'validation-error';
  err.reasonParams = reasonParams && typeof reasonParams === 'object' ? reasonParams : {};
  return err;
}

async function createProjectStructure(config = {}) {
  const warnings = [];
  const errors = [];

  let structuredLogPath = null;
  let archivePath = null;

  if (!config.jobId) {
    config.jobId = `project-organizer-${Date.now()}`;
  }

  const jobLogger = createJobLogger({
    panel: 'project-organizer',
    jobId: config.jobId,
    stage: 'init',
    streamToFile: true,
  });

  structuredLogPath = jobLogger.getStructuredLogPath?.() || structuredLogPath;

  const userLog = createJobUserLog(jobLogger, {
    pickLevel: (text, isError) => {
      const inferredError = isError || /❌|\berror\b/i.test(text);
      const inferredWarn = !inferredError && (/⚠️|\bwarn\b/i.test(text));
      return inferredError ? 'error' : inferredWarn ? 'warn' : 'info';
    }
  });
  const log = userLog.lines;
  const logPush = userLog.push;

  let didPersistJobLogs = false;
  const persistJobLogs = () => {
    if (didPersistJobLogs) return;
    try {
      if (!structuredLogPath) {
        structuredLogPath = jobLogger.getStructuredLogPath?.() || null;
      }
      if (!structuredLogPath) {
        structuredLogPath = writeJobLogToFile(
          'project-organizer',
          config.jobId,
          jobLogger?.getEntries?.() || []
        );
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist project-organizer JSONL log:', e?.message || e);
    }

    try {
      if (!archivePath) {
        archivePath = writeJobTextToFile(
          'project-organizer',
          config.jobId,
          jobLogger?.getEntries?.() || [],
          {
            structuredLogPath: structuredLogPath,
            inputs: {
              sourceCount: Array.isArray(config.selectedFolders) ? config.selectedFolders.length : 0,
              sourceRoot: config.rootName || '',
              sources: Array.isArray(config.selectedFolders) ? config.selectedFolders.slice(0, 50) : [],
            },
            outputs: {
              primaryDestination: config.outputPath || '',
            },
            settings: {
              mode: 'manual',
              prependNumbers: !!config.prependNumbers,
            }
          }
        );
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist project-organizer TXT log:', e?.message || e);
    }

    didPersistJobLogs = true;
    try { jobLogger?.close?.(); } catch {}

  };

  const pushLog = (msg, detail = '', levelOrIsError = false, fileId = '') => {
    const isError = levelOrIsError === true || levelOrIsError === 'error';
    logPush(msg, detail, isError, fileId);
  };

  const resolveLocalizedTemplate = (key, params = {}) => {
    const localeRaw = String(config.locale || process.env.LA_LOCALE || 'en').toLowerCase();
    const locale = localeRaw.split('-')[0] || 'en';
    const preferred = loadLocaleMessages(locale);
    const english = loadLocaleMessages('en');
    const count = Number(params.count);
    const hasCount = Number.isFinite(count);
    const pluralKey = hasCount && count !== 1 ? `${key}_plural` : key;
    const template = preferred[pluralKey]
      || preferred[key]
      || english[pluralKey]
      || english[key]
      || key;
    return interpolateTemplate(template, params);
  };

  const localizeReason = (params = {}) => {
    const reasonCode = params.reasonCode || params.reason || '';
    const reasonKey = PROJECT_ORGANIZER_REASON_KEYS[reasonCode];
    if (!reasonKey) return reasonCode;
    return resolveLocalizedTemplate(reasonKey, params);
  };

  const formatLegacyMessage = (code, params = {}) => {
    const reason = localizeReason(params);
    const localizedParams = reason ? { ...params, reason } : { ...params };
    let key = PROJECT_ORGANIZER_MESSAGE_KEYS[code];
    if (!key) return '';
    if (code === 'asset-not-file' && (localizedParams.reason || localizedParams.reasonCode)) {
      key = 'projectOrganizerLegacyAssetNotFileWithReason';
    }
    return resolveLocalizedTemplate(key, localizedParams).trim();
  };

  const formatRuntimeMessage = (key, params = {}, { indent = '' } = {}) => (
    `${indent}${resolveLocalizedTemplate(key, params)}`.trimEnd()
  );

  const toMessagePayload = (code, params = {}, message = '') => ({
    code,
    params,
    message: message || formatLegacyMessage(code, params)
  });

  const recordWarning = (code, params = {}, message = '') => {
    warnings.push(toMessagePayload(code, params, message));
  };

  const recordError = (code, params = {}, message = '') => {
    errors.push(toMessagePayload(code, params, message));
  };

  const {
    rootName,
    selectedFolders,
    prependNumbers,
    outputPath,
    folderAssets,
    signal
  } = config || {};

  const createAbortError = () => {
    const err = new Error('Project organizer job cancelled');
    err.name = 'AbortError';
    return err;
  };

  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw createAbortError();
    }
  };

  // Optional: richer config debug
  if (process.env.DEBUG_LOGS && jobLogger) {
    try {
      const assetSummary = Object.fromEntries(
        Object.entries(folderAssets || {}).map(([k, v]) => [k, (v || []).length])
      );
      jobLogger.debug('Project organizer config received', {
        rootName,
        selectedCount: Array.isArray(selectedFolders) ? selectedFolders.length : 0,
        outputPath,
        assetSummary
      });
    } catch {
      // Never let debug logging crash the job
    }
  }

  // Basic validation
  if (!outputPath || !Array.isArray(selectedFolders) || selectedFolders.length === 0) {
    const validationError = toMessagePayload('missing-output-or-selection');
    const errMsg = validationError.message;
    pushLog(errMsg, '', true);
    recordError(validationError.code, validationError.params, errMsg);
    jobLogger?.setStage('error');
    jobLogger?.error('Project organizer validation failed', {
      reason: 'missing-output-or-selection'
    });

    persistJobLogs();

    return {
      success: false,
      log,
      warnings,
      errors,
      logText: userLog.text(),
      structuredLogPath,
      archivePath,
      validationError,
      jobId: config.jobId
    };
  }

  const sanitizedSegments = new Map();

  const sanitizeSegment = (segment, { allowEmpty = false } = {}) => {
    const original = segment == null ? '' : String(segment);
    const trimmed = original.trim();
    if (!trimmed) {
      if (allowEmpty) return '';
      throw createReasonCodeError('folderNameEmpty');
    }
    if (/[/\\]/.test(trimmed)) {
      throw createReasonCodeError('folderNameContainsSeparator');
    }
    if (trimmed.includes('..')) {
      throw createReasonCodeError('folderNameContainsDotDot');
    }
    if (/[ .]$/.test(original) || trimmed.endsWith('.')) {
      throw createReasonCodeError('folderNameEndsWithDotOrSpace');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) {
      throw createReasonCodeError('folderNameReservedDeviceName');
    }
    const hasControlChars = Array.from(trimmed).some((ch) => ch.charCodeAt(0) < 32);
    if (/[<>:"|?*]/.test(trimmed) || hasControlChars) {
      throw createReasonCodeError('folderNameIllegalCharacter');
    }
    if (isReservedMetaKey(trimmed)) {
      throw createReasonCodeError('folderNameReservedMetaKey');
    }

    return trimmed;
  };

  const sanitizeEntry = (entry) => {
    if (typeof entry !== 'string') {
      throw createReasonCodeError('folderEntryMustBeString');
    }

    if (path.isAbsolute(entry)) {
      throw createReasonCodeError('folderEntryAbsolutePathNotAllowed');
    }

    if (/(^|[\\/])\.\.?([\\/]|$)/.test(entry)) {
      throw createReasonCodeError('folderEntryDotSegmentNotAllowed');
    }

    const normalized = path
      .normalize(entry.replace(/\\/g, '/'))
      .split('/')
      .filter(Boolean);

    if (!normalized.length) {
      throw createReasonCodeError('folderEntryEmpty');
    }

    return normalized.map((seg) => sanitizeSegment(seg));
  };

  const ensureWithinRoot = (target, root) => {
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw createReasonCodeError('destinationEscapesOutputRoot');
    }
  };

  const isWithinRoot = (target, root) => {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  const getResolvedExistingPath = async (inputPath) => {
    const absolutePath = path.resolve(inputPath);
    const pathParts = path.parse(absolutePath);
    const trail = [];
    let probe = absolutePath;

    while (probe && probe !== pathParts.root) {
      try {
        const real = await fsp.realpath(probe);
        return { realPath: real, trail };
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          throw err;
        }
        trail.unshift(path.basename(probe));
        probe = path.dirname(probe);
      }
    }

    const realRoot = await fsp.realpath(pathParts.root);
    return { realPath: realRoot, trail };
  };

  const resolveDestinationParentWithinRoot = async (destinationParent, resolvedRootFolder) => {
    const { realPath, trail } = await getResolvedExistingPath(destinationParent);
    if (!isWithinRoot(realPath, resolvedRootFolder)) {
      throw createReasonCodeError('destinationOutsideOutputRoot');
    }

    let currentReal = realPath;
    for (const segment of trail) {
      const candidate = path.join(currentReal, segment);
      try {
        const st = await fsp.lstat(candidate);
        if (st.isSymbolicLink()) {
          const resolvedCandidate = await fsp.realpath(candidate);
          if (!isWithinRoot(resolvedCandidate, resolvedRootFolder)) {
            throw createReasonCodeError('destinationSymlinkOutsideOutputRoot');
          }
          currentReal = resolvedCandidate;
          continue;
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          throw err;
        }
      }
      currentReal = candidate;
    }

    return realPath;
  };

  const failValidation = (code, params = {}, reason = 'invalid-input', message = '') => {
    const payload = toMessagePayload(code, params, message);
    const errMsg = payload.message || `❌ ${code}`;
    pushLog(errMsg, '', true);
    jobLogger?.setStage('error');
    jobLogger?.error('Project organizer validation failed', {
      reason
    });

    persistJobLogs();

    return {
      success: false,
      log,
      warnings,
      errors,
      logText: userLog.text(),
      structuredLogPath,
      archivePath,
      validationError: payload,
      jobId: config.jobId
    };
  };

  let finalRootSegment;
  let rootFolder = null;
  let resolvedRootFolder = null;  
  let rootCreatedByJob = false;
  let dedupedSelectedFolders = null;
  const createdDirs = new Set();
  const copiedFiles = new Set();

  const ensureFolderTracked = (dirPath) => {
    const existedBefore = fs.existsSync(dirPath);
    ensureFolder(dirPath);
    if (!existedBefore) {
      createdDirs.add(dirPath);
    }
  };

  const rollbackCreatedArtifacts = async () => {
    const copiedPaths = Array.from(copiedFiles);
    const createdDirPaths = Array.from(createdDirs).sort((a, b) => {
      const depthA = a.split(path.sep).length;
      const depthB = b.split(path.sep).length;
      if (depthA !== depthB) return depthB - depthA;
      return b.length - a.length;
    });

    for (let i = copiedPaths.length - 1; i >= 0; i--) {
      const copiedPath = copiedPaths[i];
      try {
        await fsp.unlink(copiedPath);
        pushLog(formatRuntimeMessage('projectOrganizerRuntimeCleanupRemovedFile', { filePath: copiedPath }));
      } catch (cleanupErr) {
        if (cleanupErr?.code !== 'ENOENT') {
          pushLog(
            formatRuntimeMessage('projectOrganizerRuntimeCleanupRemoveFileFailed', {
              filePath: copiedPath,
              error: cleanupErr.message
            }),
            '',
            true
          );
        }
      }
    }

    for (const createdPath of createdDirPaths) {
      try {
        await fsp.rmdir(createdPath);
        pushLog(formatRuntimeMessage('projectOrganizerRuntimeCleanupRemovedFolder', { folderPath: createdPath }));
      } catch (cleanupErr) {
        if (cleanupErr?.code !== 'ENOENT') {
          pushLog(
            formatRuntimeMessage('projectOrganizerRuntimeCleanupRemoveFolderFailed', {
              folderPath: createdPath,
              error: cleanupErr.message
            }),
            '',
            true
          );
        }
      }
    }
  };

  try {
    try {
      const rootNameString =
        typeof rootName === 'string' ? rootName : rootName == null ? '' : String(rootName);
      finalRootSegment = sanitizeSegment(rootNameString, { allowEmpty: true });
    } catch (err) {
      return failValidation('invalid-root-name', { reasonCode: err.reasonCode || 'invalidRootName' }, 'invalid-root-name');
    }

    for (const rawName of selectedFolders) {
      try {
        sanitizedSegments.set(rawName, sanitizeEntry(rawName));
      } catch (err) {
        return failValidation('invalid-folder-selection', { rawName, reasonCode: err.reasonCode || 'invalidFolderSelection' }, 'invalid-input');
      }
    }

    dedupedSelectedFolders = [];
    const seenSelections = new Set();
    let duplicateSelections = 0;
    for (const rawName of selectedFolders) {
      const normalizedKey = sanitizedSegments.get(rawName).join('/');
      if (seenSelections.has(normalizedKey)) {
        duplicateSelections += 1;
        continue;
      }
      seenSelections.add(normalizedKey);
      dedupedSelectedFolders.push(rawName);
    }
    if (duplicateSelections > 0) {
      const warningMessage = formatRuntimeMessage('projectOrganizerRuntimeDuplicateSelectionRemoved', {
        count: duplicateSelections
      });
      pushLog(warningMessage, '', 'warn');
      recordWarning('duplicate-folder-selection-removed', { count: duplicateSelections }, warningMessage);
    }
  } catch (err) {
    return failValidation('invalid-input', { reasonCode: err.reasonCode || 'invalidInput' }, 'invalid-input');
  }

  const pickUniqueDestPath = async (dest) => {
    try {
      await fsp.access(dest);
    } catch {
      return dest; // doesn't exist
    }

    const dir = path.dirname(dest);
    const ext = path.extname(dest);
    const base = path.basename(dest, ext);

    for (let i = 1; i <= 999; i++) {
      const candidate = path.join(dir, `${base}_${i}${ext}`);
      try {
        await fsp.access(candidate);
      } catch {
        return candidate;
      }
    }
    const basename = path.basename(dest);
    throw createReasonCodeError(
      'tooManyFilenameCollisions',
      '',
      { basename }
    );
  };
  
  const copyAssetWithSignal = async (src, dest, options = {}) => {
    throwIfCancelled();
    if (typeof options.assertDestinationParentWithinRoot === 'function') {
      await options.assertDestinationParentWithinRoot(path.dirname(dest));
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const throttleMs = Number.isFinite(options.throttleMs)
      ? Math.max(0, options.throttleMs)
      : 250;

    let transferred = 0;
    let totalSize = typeof options.size === 'number' ? options.size : null;
    if (totalSize == null) {
      try {
        totalSize = (await fsp.stat(src)).size;
      } catch {
        totalSize = 0;
      }
    }

    let lastProgressEmit = 0;
    const reportProgress = (force = false) => {
      if (!onProgress) return;
      const now = Date.now();
      if (force || !lastProgressEmit || now - lastProgressEmit >= throttleMs) {
        lastProgressEmit = now;
        try {
          onProgress(transferred, totalSize);
        } catch {
          // Progress should never crash the job.
        }
      }
    };

    return new Promise((resolve, reject) => {
      const dir = path.dirname(dest);
      const tmpFile = path.join(
        dir,
        `.__leadai_assetcopy_${process.pid}_${Date.now()}_${Math.random()
          .toString(16)
          .slice(2)}.tmp`
      );
      let finished = false;
      const abortError = createAbortError();
      const read = fs.createReadStream(src, { highWaterMark: 64 * 1024 });
      const write = fs.createWriteStream(tmpFile, { flags: 'wx' });
      let tick = null;

      const waitForStreamClose = stream =>
        new Promise(resolve => {
          if (!stream || stream.destroyed || stream.closed) {
            resolve();
            return;
          }
          const done = () => {
            stream.removeListener('close', done);
            stream.removeListener('error', done);
            resolve();
          };
          stream.once('close', done);
          stream.once('error', done);
        });

      const destroyStream = stream => {
        if (!stream || stream.destroyed) return;
        try {
          stream.destroy();
        } catch {
          // Ignore destroy errors during cleanup.
        }
      };

      async function fail(err) {
        if (finished) return;
        finished = true;
        if (tick) clearInterval(tick);
        if (signal) signal.removeEventListener('abort', onAbort);
        destroyStream(read);
        destroyStream(write);
        await Promise.all([waitForStreamClose(read), waitForStreamClose(write)]);
        await fsp.unlink(tmpFile).catch(() => {});
        reject(err);
      }

      async function succeed(finalDest) {
        if (finished) return;
        finished = true;
        if (tick) clearInterval(tick);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(finalDest);
      }

      function onAbort() {
        void fail(abortError);
      }

      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      tick = setInterval(() => {
        if (signal?.aborted) onAbort();
      }, 200);

      // Emit an initial progress snapshot so the UI can switch out of 0%.
      reportProgress(true);

      read.on('data', chunk => {
        transferred += chunk?.length || 0;
        reportProgress(false);
        if (signal?.aborted) onAbort();
      });

      read.on('error', err => {
        void fail(err);
      });
      write.on('error', err => {
        void fail(err);
      });
      write.on('finish', async () => {
        if (finished) return;
        if (signal?.aborted) return onAbort();
        try {
          transferred = totalSize;
          reportProgress(true);
          const finalDest = await pickUniqueDestPath(dest);
          if (typeof options.assertDestinationParentWithinRoot === 'function') {
            await options.assertDestinationParentWithinRoot(path.dirname(finalDest));
          }
          await fsp.rename(tmpFile, finalDest);
          await succeed(finalDest);
        } catch (err) {
          await fail(err);
        }
      });

      read.pipe(write);
    });
  };

  try {
    // Resolve and validate the output root folder
    const outputRoot = path.resolve(outputPath);
    let outputStats;
    try {
      outputStats = await fsp.stat(outputRoot);
    } catch {
      return failValidation('output-root-missing', {}, 'output-root-missing');
    }
    if (!outputStats.isDirectory()) {
      return failValidation('output-root-not-directory', {}, 'output-root-not-directory');
    }
    try {
      await fsp.access(outputRoot, fs.constants.W_OK);
    } catch {
      return failValidation('output-root-not-writable', {}, 'output-root-not-writable');
    }
    const hasNamedRoot = Boolean(finalRootSegment);

    if (hasNamedRoot) {
      rootFolder = path.resolve(outputRoot, finalRootSegment);
      ensureWithinRoot(rootFolder, outputRoot);
      rootCreatedByJob = !fs.existsSync(rootFolder);

      // Prevent accidental merges into existing populated folders
      if (fs.existsSync(rootFolder)) {
        const st = fs.statSync(rootFolder);
        if (!st.isDirectory()) {
          return failValidation('root-not-directory', { rootFolder }, 'root-not-directory');
        }
        const entries = fs.readdirSync(rootFolder);
        if (entries.length > 0) {
          return failValidation('root-exists', { rootFolder }, 'root-exists');
        }
      } else {
        ensureFolderTracked(rootFolder);
      }
      resolvedRootFolder = await fsp.realpath(rootFolder);      
      pushLog(rootCreatedByJob
        ? formatRuntimeMessage('projectOrganizerRuntimeRootCreated', { rootPath: rootFolder })
        : formatRuntimeMessage('projectOrganizerRuntimeRootReady', { rootPath: rootFolder }));
    } else {
      // No project/root name: create folders directly inside the output location.
      rootFolder = outputRoot;
      resolvedRootFolder = await fsp.realpath(rootFolder);      
      rootCreatedByJob = false;
      pushLog(formatRuntimeMessage('projectOrganizerRuntimeUsingOutputAsRoot', { rootPath: rootFolder }));
    }

    const validatedFolderAssets = Object.create(null);
    if (folderAssets && typeof folderAssets === 'object') {
      for (const [assetFolderKey, list] of Object.entries(folderAssets)) {
        if (!Array.isArray(list)) continue;
        const validAssets = [];
        for (const asset of list) {
          if (typeof asset !== 'string' || !asset.trim()) {
            const warningMessage = formatRuntimeMessage(
              'projectOrganizerRuntimeAssetEntryInvalid',
              { folderKey: assetFolderKey },
              { indent: '  ' }
            );
            pushLog(warningMessage, '', 'warn');
            recordWarning('asset-entry-invalid', { folderKey: assetFolderKey }, warningMessage);
            continue;
          }
          let normalizedAsset = asset;
          if (asset.startsWith('file:')) {
            try {
              normalizedAsset = fileURLToPath(asset);
            } catch (err) {
              const errorMessage = formatRuntimeMessage(
                'projectOrganizerRuntimeAssetFileUrlInvalid',
                { asset, error: err.message },
                { indent: '  ' }
              );
              pushLog(errorMessage, '', true);
              recordError('asset-file-url-invalid', { asset, reasonCode: err.reasonCode || err.code || 'assetFileUrlInvalid' }, errorMessage);
              continue;
            }
          }
          if (!path.isAbsolute(normalizedAsset)) {
            const errorMessage = formatRuntimeMessage(
              'projectOrganizerRuntimeAssetPathNotAbsolute',
              { assetPath: normalizedAsset },
              { indent: '  ' }
            );
            pushLog(errorMessage, '', true);
            recordError('asset-path-not-absolute', { assetPath: normalizedAsset }, errorMessage);
            continue;
          }
          let stat;
          try {
            stat = await fsp.stat(normalizedAsset);
          } catch (err) {
            const errorMessage = formatRuntimeMessage(
              'projectOrganizerRuntimeAssetUnreadable',
              { assetPath: normalizedAsset, error: err.message },
              { indent: '  ' }
            );
            pushLog(errorMessage, '', true);
            recordError('asset-unreadable', { assetPath: normalizedAsset, reasonCode: err.reasonCode || err.code || 'assetUnreadable' }, errorMessage);
            continue;
          }
          if (!stat.isFile()) {
            const errorMessage = formatRuntimeMessage(
              'projectOrganizerRuntimeAssetNotFile',
              { assetPath: normalizedAsset },
              { indent: '  ' }
            );
            pushLog(errorMessage, '', true);
            recordError('asset-not-file', { assetPath: normalizedAsset }, errorMessage);
            continue;
          }
          try {
            await fsp.access(normalizedAsset, fs.constants.R_OK);
          } catch (err) {
            const errorMessage = formatRuntimeMessage(
              'projectOrganizerRuntimeAssetNotReadable',
              { assetPath: normalizedAsset, error: err.message },
              { indent: '  ' }
            );
            pushLog(errorMessage, '', true);
            recordError('asset-not-readable', { assetPath: normalizedAsset, reasonCode: err.reasonCode || err.code || 'assetNotReadable' }, errorMessage);
            continue;
          }
          validAssets.push(normalizedAsset);
        }
        if (validAssets.length) {
          validatedFolderAssets[assetFolderKey] = validAssets;
        }
      }
    }


    const rootRenameMap = new Map();
    let rootCounter = 1;
    let folderCount = 0;
    let assetCount = 0;

    // 🔢 Progress accounting
    //
    // The old organizer progress treated “folders created” and “files copied” as
    // equal-weight steps. That makes large file copies *look* stuck (e.g. 8%)
    // until the copy finishes, because there are no progress updates during the
    // stream.
    //
    // When assets are attached, we weight progress mostly by bytes copied so the
    // bar moves in a human-sane way.
    const totalFolders = Array.isArray(dedupedSelectedFolders) ? dedupedSelectedFolders.length : 0;
    let totalAssets = 0;
    if (Object.keys(validatedFolderAssets).length > 0 && Array.isArray(dedupedSelectedFolders)) {
      for (const rawName of dedupedSelectedFolders) {
        const list = validatedFolderAssets[rawName];
        if (Array.isArray(list)) {
          const uniqueAssets = new Set();
          for (const asset of list) {
            uniqueAssets.add(asset);
          }
          totalAssets += uniqueAssets.size;
        }
      }
    }

    const totalSteps = Math.max(1, totalFolders + totalAssets);
    let completedSteps = 0;

    // --- Byte-weighted progress for asset copies ---
    const assetSizeCache = new Map(); // absPath -> size (0 if unknown)
    let totalAssetBytes = 0;
    if (Object.keys(validatedFolderAssets).length > 0 && Array.isArray(dedupedSelectedFolders)) {
      for (const rawName of dedupedSelectedFolders) {
        const list = validatedFolderAssets[rawName];
        if (!Array.isArray(list)) continue;
        const uniqueAssets = new Set();
        for (const asset of list) uniqueAssets.add(asset);
        for (const abs of uniqueAssets) {
          if (!assetSizeCache.has(abs)) {
            try {
              const st = await fsp.stat(abs);
              assetSizeCache.set(abs, st.isFile() ? st.size : 0);
            } catch {
              assetSizeCache.set(abs, 0);
            }
          }
          totalAssetBytes += assetSizeCache.get(abs) || 0;
        }
      }
    }

    const useByteProgress = totalAssetBytes > 0;
    const FOLDER_PROGRESS_WEIGHT = useByteProgress ? 10 : 100;
    const ASSET_PROGRESS_WEIGHT = useByteProgress ? 90 : 0;

    let foldersCompleted = 0;
    let assetBytesCompleted = 0;

    const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

    const computeProgressPercent = (assetBytesOverride = null) => {
      if (!useByteProgress) {
        return Math.min(100, (completedSteps / totalSteps) * 100);
      }

      const folderRatio = totalFolders > 0 ? (foldersCompleted / totalFolders) : 1;
      const bytesDone = typeof assetBytesOverride === 'number' ? assetBytesOverride : assetBytesCompleted;
      const assetRatio = totalAssetBytes > 0 ? (bytesDone / totalAssetBytes) : 1;

      return clamp(
        (folderRatio * FOLDER_PROGRESS_WEIGHT) + (assetRatio * ASSET_PROGRESS_WEIGHT),
        0,
        100
      );
    };

    const emitProgress = ({ file = '', stage = '', assetBytes = null } = {}) => {
      if (!global.queue || !config.jobId) return;
      const percent = computeProgressPercent(assetBytes);
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'project-organizer',
        completed: completedSteps,
        total: totalSteps,
        percent,
        file,
        stage,
        copiedBytes: typeof assetBytes === 'number' ? assetBytes : assetBytesCompleted,
        totalBytes: totalAssetBytes
      });
    };

    // Initial 0% update
    emitProgress({ stage: 'start', assetBytes: 0 });

    for (const rawName of dedupedSelectedFolders) {
      throwIfCancelled();

      const originalSegments = sanitizedSegments.get(rawName);
      const root = originalSegments[0];
      const isRootLevel = originalSegments.length === 1;

      // Build rename map for root folders
      if (isRootLevel) {
        const prefix = prependNumbers
          ? `${String(rootCounter).padStart(2, '0')}_`
          : '';
        const newName = prefix + root;
        rootRenameMap.set(root, newName);
        rootCounter += 1;
      }

      // Apply renaming to all paths that share this root
      const segments = [...originalSegments];
      if (rootRenameMap.has(root)) {
        segments[0] = rootRenameMap.get(root);
      }

      let current = rootFolder;
      for (const seg of segments) {
        throwIfCancelled();

        current = path.resolve(current, seg);
        ensureWithinRoot(current, rootFolder);
        const currentParent = path.dirname(current);
        await resolveDestinationParentWithinRoot(currentParent, resolvedRootFolder);        
        ensureFolderTracked(current);
      }

      folderCount += 1;
      pushLog(formatRuntimeMessage('projectOrganizerRuntimeFolderCreated', {
        folderPath: segments.join('/')
      }));

      foldersCompleted += 1;
      completedSteps += 1;
      emitProgress({ stage: 'folders' });

      // Copy attached assets
      const assetKey = rawName;
      if (validatedFolderAssets && validatedFolderAssets[assetKey]) {
        const seenAssets = new Set();
        for (const asset of validatedFolderAssets[assetKey]) {
          const assetKeyPath = asset;
          if (seenAssets.has(assetKeyPath)) {
            const warningMessage = formatRuntimeMessage(
              'projectOrganizerRuntimeAssetDuplicateSkipped',
              { assetPath: asset },
              { indent: '  ' }
            );
            pushLog(warningMessage, '', 'warn');
            recordWarning('asset-duplicate-skipped', { assetPath: asset }, warningMessage);
            continue;
          }
          seenAssets.add(assetKeyPath);

          const progressFile = path.basename(asset);
          let expectedSizeForProgress = assetSizeCache.get(assetKeyPath) || 0;

          try {
            throwIfCancelled();

            let stat;
            try {
              stat = await fsp.stat(asset);
              if (stat?.isFile?.()) expectedSizeForProgress = stat.size;
            } catch (err) {
              const errorMessage = formatRuntimeMessage(
                'projectOrganizerRuntimeAssetNotFileWithError',
                { assetPath: asset, error: err.message },
                { indent: '  ' }
              );
              pushLog(errorMessage, '', true);
              recordError('asset-not-file', { assetPath: asset, reasonCode: err.reasonCode || err.code || 'assetNotFile' }, errorMessage);
              continue;
            }

            if (!stat.isFile()) {
              const errorMessage = formatRuntimeMessage(
                'projectOrganizerRuntimeAssetNotFile',
                { assetPath: asset },
                { indent: '  ' }
              );
              pushLog(errorMessage, '', true);
              recordError('asset-not-file', { assetPath: asset }, errorMessage);
              continue;
            }

            try {
              await fsp.access(asset, fs.constants.R_OK);
            } catch (err) {
              const errorMessage = formatRuntimeMessage(
                'projectOrganizerRuntimeAssetNotReadable',
                { assetPath: asset, error: err.message },
                { indent: '  ' }
              );
              pushLog(errorMessage, '', true);
              recordError('asset-not-readable', { assetPath: asset, reasonCode: err.reasonCode || err.code || 'assetNotReadable' }, errorMessage);
              continue;
            }

            const fileName = path.basename(asset);
            let destPath = path.resolve(current, fileName);
            ensureWithinRoot(destPath, rootFolder);
            await resolveDestinationParentWithinRoot(path.dirname(destPath), resolvedRootFolder);
            // copyAssetWithSignal will pick a unique name if needed
            const baseBytes = assetBytesCompleted;
            const finalDestPath = await copyAssetWithSignal(asset, destPath, {
              size: expectedSizeForProgress,
              onProgress: (bytesCopied) => {
                emitProgress({
                  stage: 'copy',
                  file: fileName,
                  assetBytes: baseBytes + (bytesCopied || 0)
                });
              },
              assertDestinationParentWithinRoot: (destParent) =>
                resolveDestinationParentWithinRoot(destParent, resolvedRootFolder)
            });
            copiedFiles.add(finalDestPath);
            assetCount += 1;
            const relativeCopiedPath = path.relative(rootFolder, finalDestPath);
            pushLog(formatRuntimeMessage(
              'projectOrganizerRuntimeAssetCopied',
              { destinationPath: relativeCopiedPath || path.basename(finalDestPath) },
              { indent: '  ' }
            ));
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            const errorMessage = formatRuntimeMessage(
              'projectOrganizerRuntimeAssetCopyFailed',
              { assetPath: asset, error: err.message },
              { indent: '  ' }
            );
            pushLog(errorMessage, '', true);
            recordError('asset-copy-failed', {
              assetPath: asset,
              ...(err?.reasonParams && typeof err.reasonParams === 'object' ? err.reasonParams : {}),
              reasonCode: err.reasonCode || err.code || 'assetCopyFailed'
            }, errorMessage);
          } finally {
            // Count each attempted asset as progress, success or fail
            assetBytesCompleted += expectedSizeForProgress;
            completedSteps += 1;
            emitProgress({ stage: 'copy', file: progressFile });
          }
        }
      }
    }

    // Safety: ensure we report 100% done
    completedSteps = totalSteps;
    foldersCompleted = totalFolders;
    assetBytesCompleted = totalAssetBytes;
    emitProgress({ stage: 'done', assetBytes: totalAssetBytes });

    const hasIssues = warnings.length > 0 || errors.length > 0;
    const summaryPayload = hasIssues
      ? toMessagePayload('project-structure-created-with-issues', {
          folderCount,
          assetCount,
          warningCount: warnings.length,
          errorCount: errors.length
        })
      : toMessagePayload('project-structure-created', {
          folderCount,
          assetCount
        });
    const summaryMessage = summaryPayload.message;
    pushLog(summaryMessage, '', hasIssues ? 'warn' : false);

    jobLogger?.setStage('complete');
    jobLogger?.info('Project organizer job completed', {
      folderCount,
      assetCount,
      warningCount: warnings.length,
      errorCount: errors.length
    });

    persistJobLogs();

    return {
      success: true,
      log,
      warnings,
      errors,
      summary: summaryMessage,
      summaryCode: summaryPayload.code,
      summaryParams: summaryPayload.params,
      logText: userLog.text(),
      structuredLogPath,
      archivePath,
      jobId: config.jobId
    };
  } catch (err) {
    const isCancelled = err?.name === 'AbortError';
    const runtimeErrorPayload = isCancelled
      ? toMessagePayload('project-organizer-cancelled')
      : toMessagePayload('project-organizer-uncaught-error', {
          ...(err?.reasonParams && typeof err.reasonParams === 'object' ? err.reasonParams : {}),
          reasonCode: err.reasonCode || err.code || 'projectOrganizerUncaughtError'
        });
    const errMsg = runtimeErrorPayload.message;
     
    console.error('[createProjectStructure] Uncaught error:', err);
    pushLog(errMsg, '', !isCancelled);

    if (copiedFiles.size > 0 || createdDirs.size > 0 || (rootCreatedByJob && rootFolder)) {
      await rollbackCreatedArtifacts();
    }

    if (isCancelled) {
      jobLogger?.setStage('cancelled');
      jobLogger?.info('Project organizer job cancelled');
    } else {
      jobLogger?.setStage('error');
      jobLogger?.error('Project organizer job failed', {
        error: err?.message || String(err),
        stack: err?.stack
      });
    }

    persistJobLogs();

    return {
      success: false,
      cancelled: isCancelled,
      log,
      warnings,
      errors,
      logText: userLog.text(),
      structuredLogPath,
      archivePath,
      runtimeError: runtimeErrorPayload,
      jobId: config.jobId
    };
  }
}

module.exports = { createProjectStructure };
