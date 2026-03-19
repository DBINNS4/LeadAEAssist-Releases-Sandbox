const ProgressManager = require('../utils/progressManager');
// IMPORTANT: in Electron, the default `fs` is ASAR-aware and can treat `.asar`
// archives in user folders as virtual directories. For ingest/backup we need
// real filesystem behavior.
const { fs, fsp } = require('../utils/nativeFs');
const { DEFAULT_IGNORE_ENTRY_NAMES: _DEFAULT_IGNORE_ENTRY_NAMES, shouldAlwaysSkipFile } = require('../utils/scanFilters');
const path = require('path');
const net = require('net');
const { dialog, BrowserWindow, app } = require('electron');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { fileURLToPath } = require('url');
const checkDiskSpace = require('check-disk-space').default;
const { runClone } = require('./clone');

const execFileAsync = promisify(execFile);

// Reference to the main application window, falling back to the first window
const getMainWindow = () => {
  if (global.mainWindow) return global.mainWindow;
  const windows = BrowserWindow?.getAllWindows?.() || [];
  return windows[0] || null;
};

const { getHashes, xxhashReady, xxhashAvailable, getBlake3Hash, blake3Available } = require('./hashUtils');
const {
  copyFileWithProgress,
  getAllItemsRecursively,
  runWithConcurrencyLimit,
  preloadFileSizes
} = require('./fileUtils');
const { queueBackup, setConcurrency } = require('./backupQueue');


const { estimateDiskWriteSpeed } = require('./speedUtils');
const { writeLogToFile, createJobLogger, createJobUserLog, writeJobLogToFile, writeJobTextToFile } = require('./logUtils');
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
const { compareFilesByteByByte } = require('../utils/compare');

const { filterOutDestination } = require('./workflowUtils');

// Watch-mode processed tracking (internal registry under userData/cache).
const { markProcessedShared } = require('../utils/watchRegistry');

// Debug flag for detailed hash logging
const DEBUG_HASH = process.env.DEBUG_HASH === 'true';

const INGEST_STATUS = Object.freeze({
  COMPLETE: 'complete',
  WATCH_SKIPPED_MISSING_SOURCE: 'watch-skipped-missing-source',
  WATCH_SKIPPED_MISSING_DESTINATION: 'watch-skipped-missing-destination',
  WATCH_SKIPPED_MISSING_BACKUP: 'watch-skipped-missing-backup'
});

const INGEST_REASON = Object.freeze({
  MISSING_SOURCE: 'missing-source',
  MISSING_DESTINATION: 'missing-destination',
  MISSING_BACKUP: 'missing-backup'
});

const INGEST_ERROR_CODE = Object.freeze({
  PATH_VALIDATE_UNAVAILABLE: 'INGEST_PATH_VALIDATE_UNAVAILABLE',
  DESTINATION_NOT_WRITABLE: 'INGEST_DESTINATION_NOT_WRITABLE',
  SOURCE_ACCESS_FAILED: 'INGEST_SOURCE_ACCESS_FAILED',
  WATCH_FOLDER_ACCESS_FAILED: 'INGEST_WATCH_FOLDER_ACCESS_FAILED',
  BACKUP_NOT_WRITABLE: 'INGEST_BACKUP_NOT_WRITABLE',
  WEBHOOK_TIMEOUT: 'INGEST_WEBHOOK_TIMEOUT',
  WEBHOOK_NETWORK: 'INGEST_WEBHOOK_NETWORK',
  WEBHOOK_TRIGGER_FAILED: 'INGEST_WEBHOOK_TRIGGER_FAILED',
  UNHANDLED: 'INGEST_UNHANDLED'
});

const INGEST_ERROR_CODE_TO_I18N_KEY = Object.freeze({
  [INGEST_ERROR_CODE.PATH_VALIDATE_UNAVAILABLE]: 'ingest.error.pathValidateUnavailable',
  [INGEST_ERROR_CODE.DESTINATION_NOT_WRITABLE]: 'ingest.error.destinationNotWritable',
  [INGEST_ERROR_CODE.SOURCE_ACCESS_FAILED]: 'ingest.error.sourceAccessFailed',
  [INGEST_ERROR_CODE.WATCH_FOLDER_ACCESS_FAILED]: 'ingest.error.watchFolderAccessFailed',
  [INGEST_ERROR_CODE.BACKUP_NOT_WRITABLE]: 'ingest.error.backupNotWritable',
  [INGEST_ERROR_CODE.WEBHOOK_TIMEOUT]: 'ingest.error.webhookTimeout',
  [INGEST_ERROR_CODE.WEBHOOK_NETWORK]: 'ingest.error.webhookNetwork',
  [INGEST_ERROR_CODE.WEBHOOK_TRIGGER_FAILED]: 'ingest.error.webhookTriggerFailed',
  [INGEST_ERROR_CODE.UNHANDLED]: 'ingest.error.unhandled'
});

const INGEST_I18N_FALLBACKS = Object.freeze({
  'ingest.validation.invalidConfig': '❌ Invalid ingest config.',
  'ingest.validation.autoEjectUnsupported': '❌ Auto-eject is not supported yet. Please turn off autoEject and eject media manually after ingest.',
  'ingest.validation.sourceMissing': '❌ Please select a source folder or add files before starting.',
  'ingest.validation.destinationMissing': '❌ Please set a destination before starting.',
  'ingest.validation.destinationMustBeFolder': '❌ Destination must be a folder.',
  'ingest.validation.cloneMode.folderSourcesOnly': '❌ Clone Mode only supports folder sources. Please choose a folder.',
  'ingest.validation.cloneMode.validSourceRequired': '❌ Clone Mode requires a valid source folder. Please choose a folder.',
  'ingest.validation.cloneMode.selectedFolderRequired': '❌ Clone Mode requires at least one selected folder.',
  'ingest.validation.watchMode.folderPathRequired': '❌ Watch mode requires a folder path. Please select a directory to watch instead of a file list.',
  'ingest.validation.watchMode.watchFolderRequired': '❌ Please select a watch folder before starting watch mode.',
  'ingest.validation.watchMode.foldersOnly': '❌ Watch mode only supports folders. Please select a directory to watch.',
  'ingest.validation.destinationInsideSource': '❌ Destination cannot be the same as the source or located inside the source folder.',
  'ingest.validation.sourceInsideDestination': '❌ Source cannot be the same as or located inside the destination folder.',
  'ingest.validation.backupPathRequired': '❌ Backup path is required when dual copy is enabled.',
  'ingest.validation.backupMustBeFolder': '❌ Backup must be a folder.',
  'ingest.validation.backupInsideSource': '❌ Backup path cannot be the same as the source or located inside the source folder.',
  'ingest.validation.sourceInsideBackup': '❌ Source cannot be the same as or located inside the backup folder.',
  'ingest.validation.destinationBackupOverlap': '❌ Destination and backup paths cannot match or contain each other.',
  'ingest.validation.n8n.missingUrl': '❌ Please provide an n8n URL when webhook logging is enabled.',
  'ingest.validation.n8n.invalidFormat': '❌ Invalid n8n URL. Please use a full http/https address.',
  'ingest.validation.n8n.invalidProtocol': '❌ n8n URL must start with http:// or https://.',
  'ingest.validation.n8n.httpsRequired': '❌ n8n webhook URL must use https:// in packaged builds. Set LEADAE_ALLOW_INSECURE_N8N_HTTP=true only for local development/testing.',
  'ingest.validation.n8n.missingHostname': '❌ Invalid n8n URL. Please include a hostname.',
  'ingest.validation.n8n.privateDisallowed': '❌ n8n URL cannot target localhost or private networks unless private targets are explicitly allowed.',
  'ingest.validation.n8n.hostNotAllowed': '❌ n8n URL host not allowed. Allowed hosts: {{hosts}}',
  'ingest.started': '🚀 Ingest started ({{jobId}})',
  'ingest.header.source': '📥 Source: {{sourceLabel}}',
  'ingest.header.destination': '📤 Destination: {{destination}}',
  'ingest.header.backup': '📦 Backup: {{backupPath}}',
  'ingest.header.options': '⚙️ Options: flatten={{flatten}}, autoFolder={{autoFolder}}, verify={{verifyMethod}}, skipDuplicates={{skipDup}}, retryFailures={{retryFailures}}, saveLog={{saveLog}}, watchMode={{watchMode}}',
  'ingest.header.filters': '🧩 Filters: include={{include}}, exclude={{exclude}}',
  'ingest.header.scan': '🧹 Scan: hidden={{hidden}}, cache={{cache}}, defaultIgnore={{defaultIgnore}}',
  'ingest.header.threads': '🧵 Threads: {{threads}}',
  'ingest.header.webhook': '🛰️ Webhook: enabled{{hostSuffix}}',
  'ingest.log.settings': '⚙️ Settings: hidden={{hidden}}, cache={{cache}}, defaultIgnore={{defaultIgnore}}',
  'ingest.log.normalizedSelection': 'ℹ️ Normalized source selection: removed {{notes}}.',
  'ingest.log.skippedDestinationAsSource': '⚠️ Skipped destination folder passed as source: {{path}}',
  'ingest.log.sourceFileNotFound': '⚠️ Source file not found: {{path}}',
  'ingest.log.noSourceInputsExist': '❌ None of the selected source files or folders exist. Please reselect your source inputs.',
  'ingest.log.triggeredForSources': '🚀 Ingest triggered for {{count}} file(s)',
  'ingest.log.triggeredForRetries': '🔁 Retry Mode ingest triggered for {{count}} file(s)',
  'ingest.log.startingFromSource': '🚀 Starting ingest from: {{source}}',
  'ingest.log.duplicateRootNamesAdjusted': 'ℹ️ Detected duplicate root folder names; adjusted relative paths:',
  'ingest.log.duplicateRootRenameDetail': '• {{base}} ({{dir}}) → {{name}}',
  'ingest.log.skipUnreadableSourcePath': '⚠️ Skipping missing/unreadable source path: {{path}} ({{error}})',
  'ingest.log.duplicateFileNamesNamespaced': 'ℹ️ Detected duplicate filenames in selected files; added parent folder names for {{count}} file(s) to prevent overwrites.',
  'ingest.log.fileListReady': '📦 File list ready: {{fileCount}} file(s){{folderClause}}',
  'ingest.log.unreadablePathsSkipped': '⚠️ Unreadable paths skipped during scan: {{count}}.{{sampleClause}}',
  'ingest.log.cancelledByUser': '🛑 Ingest cancelled by user.',
  'ingest.log.watchSkippedSourceMissing': '⏭️ Watch-triggered job skipped: source missing ({{source}}).',
  'ingest.log.sourceMissingCancelled': '❌ Ingest cancelled: Source folder not found ({{source}}).',
  'ingest.log.sourceMissingOverrideEnabled': '⚠️ Source missing override enabled; ingest marked as skipped ({{source}}).',
  'ingest.log.destinationMissingCancelled': '❌ Ingest cancelled: No valid destination path provided.',
  'ingest.log.watchSkippedDestinationMissing': '⏭️ Watch-triggered job skipped: destination missing ({{destination}}).',
  'ingest.log.destinationCreated': '📁 Created destination: {{destination}}',
  'ingest.log.destinationCreateFailed': '❌ Failed to create destination: {{error}}',
  'ingest.log.destinationNotCreatedCancelled': '❌ Ingest cancelled: Destination folder not created.',
  'ingest.log.notes': '📝 Notes: {{notes}}',
  'ingest.log.watchSkippedBackupMissing': '⏭️ Watch-triggered job skipped: backup path missing ({{backupPath}}).',
  'ingest.log.backupPathCreated': '📁 Created backup path: {{backupPath}}',
  'ingest.log.backupPathCreateFailedDualCopy': '❌ Ingest failed: Dual copy guarantee not met because backup path could not be created ({{error}}).',
  'ingest.log.backupPathNotCreatedDualCopy': '❌ Ingest failed: Dual copy guarantee not met because backup folder was not created.',
  'ingest.log.extensionFiltersApplied': '📂 Extension filters applied: {{rawCount}} → {{filteredCount}} file(s)',
  'ingest.log.noFilesAfterFilters': '⚠️ No files found to ingest after filters.',
  'ingest.log.destExistsBackupMissingRecopy': 'ℹ️ Destination exists but backup is missing; re-copying to create backup: {{relPath}}',
  'ingest.log.byteIdenticalSkipped': '⚠️ Skipped byte-identical file: {{relPath}}',
  'ingest.log.byteCompareCheckFailed': '⚠️ Byte-compare check failed for {{relPath}}: {{error}}',
  'ingest.log.noIngestOccurredCancelled': '🛑 No ingest occurred; job cancelled before folder creation or archive logging.',
  'ingest.log.watchSkippedNoEligibleFiles': '⏭️ Watch-triggered job skipped (no eligible files).',

  'ingest.log.filenameCollisionsCancelled': '❌ Ingest cancelled: Filename collisions detected.',
  'ingest.log.autoFolderResolved': '📁 Auto-folder resolved: {{baseDestFolder}}',
  'ingest.log.cancelledDuringFile': '🛑 Ingest cancelled by user during: {{relativePath}}',
  'ingest.log.hashPreviouslySeen': '🔍 Hash {{computedHash}} previously seen: {{hashSeenBefore}} (target exists: {{targetExists}})',
  'ingest.log.duplicateContentSkippedVerified': '⚠️ Duplicate content skipped (verified{{methodLabel}}): {{relPath}}',
  'ingest.log.existingContentDifferedRecopy': '⚠️ Existing content differed; re-copying: {{relPath}}',
  'ingest.log.rollbackMovedAside': '♻️ Moved existing {{label}} aside for rollback: {{rollbackName}}',
  'ingest.log.rollbackRestoredAfterFailure': '↩️ Restored previous {{label}} after failure: {{relPath}}',
  'ingest.log.fileOk': '✅ OK: {{relPath}}',
  'ingest.log.backupOk': '📦 Backup OK: {{relPath}}',
  'ingest.log.estimatedWriteSpeed': '⚡ Estimated write speed: {{speed}} MiB/s',
  'ingest.log.autoSelectedThreadCount': '🧵 Auto-selected thread count: {{threadCount}}',
  'ingest.log.watchClampedThreadCount': '🧵 Watch Mode: clamping auto-selected thread count from {{threadCount}} to 4',
  'ingest.log.userDefinedThreadCount': '🧵 Using user-defined thread count: {{threadCount}}',
  'ingest.log.singleThreaded': '🧵 Running ingest single-threaded',
  'ingest.log.retryingFailedFiles': '🔁 Retrying {{count}} failed file(s)...',
  'ingest.log.retryComplete': '🔁 Retry complete. {{count}} file(s) failed again.',
  'ingest.log.logSaved': '📄 Log saved to: {{logPath}}',
  'ingest.log.logAlsoSavedToBackup': '📁 Log also saved to backup: {{backupLogPath}}',
  'ingest.log.failedSummarySaved': '📄 Skipped/failed files saved to: {{failureLogPath}}',
  'ingest.log.retryListCreated': '📂 Retry list created: {{retryListPath}}',

  'ingest.log.prefixedWarning': '⚠️ {{msg}}',
  'ingest.log.prefixedError': '❌ {{msg}}',
  'ingest.log.statSourceSizeFailed': '⚠️ Failed to stat source for size ({{relPath}}): {{error}}',
  'ingest.log.computeSourceHashFailed': '⚠️ Unable to compute source {{checksumMethod}} hash for {{relPath}}: {{error}}',
  'ingest.log.verifyDestinationHashFailed': '⚠️ Unable to verify existing destination hash for {{relPath}}: {{error}}',
  'ingest.log.verifyBackupHashFailed': '⚠️ Unable to verify existing backup hash for {{relPath}}: {{error}}',
  'ingest.log.byteCompareBackupFailed': '⚠️ Byte-compare check failed for backup {{relPath}}: {{error}}',
  'ingest.log.verifyDestinationMethodHashFailed': '⚠️ Unable to verify existing destination {{checksumMethod}} hash for {{relPath}}: {{error}}',
  'ingest.log.verifyBackupMethodHashFailed': '⚠️ Unable to verify existing backup {{checksumMethod}} hash for {{relPath}}: {{error}}',
  'ingest.log.verifyDest.byteCompare': '{{status}} Verify destination (byte-compare) {{relPath}} | bytes={{byteSize}} | {{elapsedMs}}ms',
  'ingest.log.verifyDest.hash.ok': '{{status}} Verify destination ({{checksumMethod}}) {{relPath}} | src={{srcHash}} | dest={{destHash}} | {{elapsedMs}}ms',
  'ingest.log.verifyDest.hash.missing': '{{status}} Verify destination ({{checksumMethod}}) {{relPath}} | src={{srcHash}} | dest={{destHash}} | {{elapsedMs}}ms',
  'ingest.log.verifyBackup.byteCompare': '{{status}} Verify backup (byte-compare) {{relPath}} | bytes={{byteSize}} | {{elapsedMs}}ms',
  'ingest.log.verifyBackup.hash.ok': '{{status}} Verify backup ({{checksumMethod}}) {{relPath}} | src={{srcHash}} | backup={{backupHash}} | {{elapsedMs}}ms',
  'ingest.log.verifyBackup.hash.missing': '{{status}} Verify backup ({{checksumMethod}}) {{relPath}} | src={{srcHash}} | backup={{backupHash}} | {{elapsedMs}}ms',
  'ingest.log.rollbackRemoveFailed': '⚠️ Unable to remove {{label}} rollback file for {{relPath}}: {{error}}',
  'ingest.log.rollbackRestoreFailed': '❌ Failed to restore previous {{label}} for {{relPath}}: {{error}}',
  'ingest.log.readSourceTimestampsFailed': '⚠️ Unable to read source timestamps for {{relPath}}: {{error}}',
  'ingest.log.preserveTimestampsFailed': '⚠️ Unable to preserve timestamps for {{targetLabel}}{{relPath}}: {{error}}',
  'ingest.log.errorIngestingFile': '❌ Error ingesting {{relPath}}: {{error}}',
  'ingest.log.writeIngestLogFailed': '⚠️ Failed to write ingest log: {{error}}',
  'ingest.log.writeBackupLogFailed': '⚠️ Failed to write backup log: {{error}}',
  'ingest.failureLog.heading.skippedFiles': '⚠️ Skipped Files:',
  'ingest.failureLog.heading.failedFiles': '❌ Failed Files:',
  'ingest.log.writeFailedSummaryFailed': '⚠️ Failed to write skipped/failed summary ({{failureLogPath}}): {{error}}',
  'ingest.log.writeRetryListFailed': '⚠️ Failed to write retry list ({{retryListPath}}): {{error}}',
  'ingest.log.workload': '📦 Workload: {{count}} file(s) — dest {{destSize}}{{backupClause}}',
  'ingest.log.diskSpacePreflightSkipped': '⚠️ Disk space preflight skipped (could not determine free space).',
  'ingest.log.backupDiskSpacePreflightSkipped': '⚠️ Backup disk space preflight skipped (could not determine free space).',
  'ingest.log.diskSpaceUndeterminedCancelled': '❌ Ingest cancelled: Disk space could not be determined.',
  'ingest.log.backupDiskSpaceUndeterminedCancelled': '❌ Ingest cancelled: Backup disk space could not be determined.',
  'ingest.log.diskSpeedCheckFailedDefaulting': '⚠️ Disk speed check failed{{codeClause}} ({{reason}}), defaulting to {{threadCount}} threads',
  'ingest.log.webhook.sending': '🛰️ Sending data to validated n8n webhook…',
  'ingest.log.webhook.triggered': '🌐 n8n webhook triggered',
  'ingest.log.webhook.httpStatus': '⚠️ n8n webhook returned HTTP {{status}} {{statusText}}',
  'ingest.log.webhook.httpStatusWithExcerpt': '⚠️ n8n webhook returned HTTP {{status}} {{statusText}} — {{excerpt}}',
  'ingest.summary.verification.destination': '🔍 Verification ({{verificationLabel}}) — Destination: {{ok}}/{{required}} {{result}}',
  'ingest.summary.verification.backup': '🔍 Verification ({{verificationLabel}}) — Backup: {{ok}}/{{required}} {{result}}',
  'ingest.summary.verification.off': '🔍 Verification: off',
  'ingest.summary.verification.label.off': 'off',
  'ingest.summary.verification.label.byteByByte': 'byte-by-byte',
  'ingest.summary.verification.label.sha256': 'sha256',
  'ingest.summary.verification.label.md5': 'md5',
  'ingest.summary.verification.label.blake3': 'blake3',
  'ingest.summary.verification.label.xxhash64': 'xxhash64',
  'ingest.summary.verification.label.other': '{{method}}',
  'ingest.summary.verification.result.passed': 'passed',
  'ingest.summary.verification.result.verified': 'verified',
  'ingest.summary.complete': '✅ Ingest complete — OK: {{success}}  Skipped: {{skipped}}  Failed: {{failed}}',
  'ingest.summary.elapsed': '⏱️ Elapsed: {{seconds}}s',
  'ingest.summary.allSkipped': '⚠️ All files skipped. Check filters or skipDuplicate settings.',
  'ingest.summary.watchErrors': '⚠️ Watch-triggered job finished with errors; see log for details.',
  'ingest.summary.result': 'OK: {{success}}  Skipped: {{skipped}}  Failed: {{failed}}',
  'ingest.dialog.button.ok': 'OK',
  'ingest.dialog.button.yes': 'Yes',
  'ingest.dialog.button.no': 'No',
  'ingest.dialog.button.continue': 'Continue',
  'ingest.dialog.button.cancel': 'Cancel',
  'ingest.dialog.blake3Unavailable.title': 'BLAKE3 Unavailable',
  'ingest.dialog.blake3Unavailable.message': '❌ BLAKE3 unavailable. Please install the native BLAKE3 module or choose a different checksum method.',
  'ingest.dialog.xxhash64Unavailable.title': 'xxHash64 Unavailable',
  'ingest.dialog.xxhash64Unavailable.message': '❌ xxHash64 unavailable. Please choose a different checksum method.',
  'ingest.dialog.sourceNotFound.title': 'Source Not Found',
  'ingest.dialog.sourceNotFound.message': 'The source folder does not exist:\n\n{{source}}\n\nIngest cannot continue without an explicit override.',
  'ingest.dialog.destinationNotFound.title': 'Destination Not Found',
  'ingest.dialog.destinationNotFound.message': 'The destination folder does not exist:\n\n{{destination}}\n\nWould you like to create it?',
  'ingest.dialog.backupPathNotFound.title': 'Backup Path Not Found',
  'ingest.dialog.backupPathNotFound.message': 'Dual Copy is enabled and the backup path does not exist:\n\n{{backupPath}}\n\nCreate it now?',
  'ingest.dialog.noFilesFound.title': 'No Files Found',
  'ingest.dialog.noFilesFound.message': 'No files found to ingest after filters.',
  'ingest.dialog.collision.title': 'Ingest Collision',
  'ingest.dialog.collision.message': '{{detail}}',
  'ingest.dialog.diskSpaceCheckSkipped.title': 'Disk Space Check Skipped',
  'ingest.dialog.diskSpaceCheckSkipped.message': '{{reason}}\n\nContinue anyway?',
  'ingest.dialog.insufficientDiskSpace.title': 'Insufficient Disk Space',
  'ingest.dialog.insufficientDiskSpace.message': '{{detail}}',
  'ingest.dialog.backupDiskSpaceCheckSkipped.title': 'Backup Disk Space Check Skipped',
  'ingest.dialog.backupDiskSpaceCheckSkipped.message': '{{reason}}\n\nContinue anyway?',
  'ingest.dialog.insufficientBackupSpace.title': 'Insufficient Backup Space',
  'ingest.dialog.insufficientBackupSpace.message': '{{detail}}',
  'ingest.dialog.finishedWithErrors.title': 'Ingest Finished with Errors',
  'ingest.dialog.finishedWithErrors.message': '{{failed}} file(s) failed to ingest.\nCheck the log for details.',
  'ingest.invalidConfig': '❌ Ingest failed: Invalid ingest configuration (expected an object).',
  'ingest.unhandledError': '❌ Unhandled ingest error: {{error}}',
  'ingest.webhook.skippedInvalid': '⚠️ Skipping n8n webhook: {{message}}',
  'ingest.error.pathValidateUnavailable': '⚠️ Unable to validate the selected path right now.',
  'ingest.error.destinationNotWritable': '❌ Destination folder is not writable.',
  'ingest.error.sourceAccessFailed': '❌ Unable to access source folder.',
  'ingest.error.watchFolderAccessFailed': '❌ Unable to access watch folder.',
  'ingest.error.backupNotWritable': '❌ Backup folder is not writable.',
  'ingest.error.webhookTimeout': '⚠️ n8n webhook request timed out.',
  'ingest.error.webhookNetwork': '⚠️ n8n webhook network error.',
  'ingest.error.webhookTriggerFailed': '⚠️ Failed to trigger n8n webhook.',
  'ingest.error.rollbackPathUnavailable': '❌ Unable to create rollback-safe path for existing {{label}}.',
  'ingest.error.copyCancelled': '🛑 Cancelled during file copy.',
  'ingest.error.byteMismatchDest': '❌ Byte-level mismatch (src vs dest).',
  'ingest.error.cancelledBeforeChecksum': '🛑 Cancelled before checksum.',
  'ingest.error.sourceChecksumUnavailableComparison': '❌ Source checksum unavailable for comparison ({{checksumMethod}}).',
  'ingest.error.destinationChecksumUnavailable': '❌ Destination checksum unavailable ({{checksumMethod}}).',
  'ingest.error.checksumMismatchDest': '❌ Checksum mismatch (src vs dest).',
  'ingest.error.cancelledBeforeBackup': '🛑 Cancelled before backup.',
  'ingest.error.backupCopyCancelled': '🛑 Cancelled during backup copy.',
  'ingest.error.byteMismatchBackup': '❌ Byte-level mismatch (dest vs backup).',
  'ingest.error.sourceChecksumUnavailableBackupComparison': '❌ Source checksum unavailable for backup comparison ({{checksumMethod}}).',
  'ingest.error.backupChecksumUnavailable': '❌ Backup checksum unavailable ({{checksumMethod}}).',
  'ingest.error.checksumMismatchBackup': '❌ Checksum mismatch (src vs backup).',
  'ingest.error.unhandled': '❌ Unhandled ingest error.'
});

function ingestMessage(key, params = {}) {
  return { key, params };
}

function ingestDialogPayload(payload = {}) {
  return payload;
}

function formatIngestMessage(message) {
  if (!message || typeof message !== 'object') return String(message ?? '');
  const key = typeof message.key === 'string' ? message.key : '';
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const template = INGEST_I18N_FALLBACKS[key] || key;
  return String(template).replace(/{{\s*([^{}\s]+)\s*}}/g, (_m, token) => (
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : ''
  ));
}

function resolveIngestDialogValue(value) {
  if (value && typeof value === 'object' && typeof value.key === 'string') {
    return formatIngestMessage(value);
  }
  return String(value ?? '');
}

function createIngestError(key, params = {}) {
  const i18nPayload = ingestMessage(key, params);
  const err = new Error(formatIngestMessage(i18nPayload));
  err.i18n = i18nPayload;
  return err;
}

function resolveIngestErrorMessage(err) {
  if (err && err.i18n && typeof err.i18n === 'object') {
    return formatIngestMessage(err.i18n);
  }
  return String(err?.message || err || '');
}

function resolveIngestDialogPayload(payload = {}) {
  const resolved = { ...payload };
  if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
    resolved.title = resolveIngestDialogValue(payload.title);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'message')) {
    resolved.message = resolveIngestDialogValue(payload.message);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'detail')) {
    resolved.detail = resolveIngestDialogValue(payload.detail);
  }
  if (Array.isArray(payload.buttons)) {
    resolved.buttons = payload.buttons.map(resolveIngestDialogValue);
  }
  return resolved;
}

// Regression note: all user-facing ingest dialogs should use i18n payloads
// (ingestMessage/ingestDialogPayload) instead of inline English strings.
async function showIngestDialog(parentWindow, payload = {}) {
  return dialog.showMessageBox(parentWindow, resolveIngestDialogPayload(payload));
}

function toSafeTechnicalDetail(err) {
  if (!err) return '';
  const code = typeof err?.code === 'string' ? err.code.trim() : '';
  const message = typeof err?.message === 'string' ? err.message.trim() : '';
  const detail = [code, message].filter(Boolean).join(': ');
  return detail.slice(0, 240);
}

function ingestErrorMessage(code, params = {}) {
  const key = INGEST_ERROR_CODE_TO_I18N_KEY[code] || 'ingest.error.unhandled';
  return { key, params: { ...params, code } };
}

function envFlagEnabled(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseN8nAllowlist(rawAllowlist) {
  if (Array.isArray(rawAllowlist)) {
    return rawAllowlist.map(entry => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof rawAllowlist === 'string') {
    return rawAllowlist
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);
  }
  return [];
}

// ✅ Cancel helpers
const { cancelIngest, createCancelToken } = require('./cancelUtils');

const {
  loadCache,
  saveCache,
  updateCacheEntry,
  isDuplicate
} = require('../utils/hashCache');

// 🗂️ Load persistent hash cache
const hashCache = loadCache();
// ✅ Hash cache loaded: silently handled for production

function isPrivateHostname(hostname) {
  const host = (hostname || '').toLowerCase();
  const normalizedHost = host.split('%')[0];
  if (!normalizedHost) return true;
  if (['localhost', '127.0.0.1', '::1'].includes(normalizedHost)) return true;
  if (normalizedHost.endsWith('.local')) return true;

  const ipVersion = net.isIP(normalizedHost);
  if (ipVersion === 4) {
    const [a, b] = normalizedHost.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  if (ipVersion === 6) {
    if (normalizedHost === '::1') return true;
    if (normalizedHost.startsWith('fc') || normalizedHost.startsWith('fd')) return true;
    if (normalizedHost.startsWith('fe80')) return true;
  }

  return false;
}

function validateN8nUrl(n8nUrl, opts = {}) {
  const allowPrivate = !!opts?.allowPrivate;
  const allowlist = opts?.allowlist;
  const allowInsecureHttp = !!opts?.allowInsecureHttp;
  const packagedBuild = typeof opts?.isPackaged === 'boolean'
    ? opts.isPackaged
    : (app?.isPackaged ?? false);
  const trimmed = (n8nUrl || '').trim();
  if (!trimmed) {
    return { valid: false, message: ingestMessage('ingest.validation.n8n.missingUrl') };
  }

  let parsed;
  let parsedHostname;
  try {
    parsed = new URL(trimmed);
    parsedHostname = parsed.hostname;
  } catch {
    const scopedMatch = trimmed.match(/^(https?:)\/\/\[([^\]]+)\](.*)$/i);
    if (!scopedMatch) {
      return { valid: false, message: ingestMessage('ingest.validation.n8n.invalidFormat') };
    }
    const scopedHost = scopedMatch[2];
    const sanitizedHost = scopedHost.split('%')[0];
    if (!sanitizedHost) {
      return { valid: false, message: ingestMessage('ingest.validation.n8n.invalidFormat') };
    }
    try {
      parsed = new URL(`${scopedMatch[1]}//[${sanitizedHost}]${scopedMatch[3]}`);
      parsedHostname = scopedHost;
    } catch {
      return { valid: false, message: ingestMessage('ingest.validation.n8n.invalidFormat') };
    }
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, message: ingestMessage('ingest.validation.n8n.invalidProtocol') };
  }

  if (parsed.protocol === 'http:' && packagedBuild && !allowInsecureHttp) {
    return {
      valid: false,
      message: ingestMessage('ingest.validation.n8n.httpsRequired')
    };
  }

  const hostname = String(parsedHostname || '').trim();
  if (!hostname) {
    return { valid: false, message: ingestMessage('ingest.validation.n8n.missingHostname') };
  }

  if (!allowPrivate && isPrivateHostname(hostname)) {
    return {
      valid: false,
      message: ingestMessage('ingest.validation.n8n.privateDisallowed')
    };
  }

  const normalizedAllowlist = parseN8nAllowlist(allowlist);
  if (normalizedAllowlist.length) {
    const match = normalizedAllowlist.some(allowed => hostname.toLowerCase() === allowed.toLowerCase());
    if (!match) {
      return {
        valid: false,
        message: ingestMessage('ingest.validation.n8n.hostNotAllowed', { hosts: normalizedAllowlist.join(', ') })
      };
    }
  }

  return { valid: true, url: trimmed };
}

function resolvePathSafe(p) {
  try {
    if (typeof p === 'string') {
      if (!p.trim()) return null;
    } else if (!p) {
      return null;
    }
    const normalized = String(p).trim();
    if (!normalized) return null;
    return path.resolve(normalized);
  } catch {
    return null;
  }
}

function sanitizeOperationalPath(p) {
  if (typeof p !== 'string') return '';
  const trimmed = p.trim();
  if (!trimmed) return '';

  let local = trimmed;
  if (/^file:\/\//i.test(local)) {
    try {
      local = fileURLToPath(local);
    } catch {
      local = trimmed;
    }
  }

  try {
    return path.resolve(local.trim());
  } catch {
    return local.trim();
  }
}

function resolveRealPathSafe(p) {
  const resolved = resolvePathSafe(p);
  if (!resolved) return null;
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function resolvePathSafeAsync(p) {
  return resolvePathSafe(p);
}

async function resolveRealPathSafeAsync(p) {
  const resolved = await resolvePathSafeAsync(p);
  if (!resolved) return null;
  try {
    return await fsp.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function yieldToMainThread() {
  await new Promise(resolve => setImmediate(resolve));
}

async function pathExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(base, candidate) {
  if (!base || !candidate) return false;
  const relative = path.relative(base, candidate);
  if (!relative || relative === '.') return true;
  if (relative.startsWith('..')) return false;
  return !path.isAbsolute(relative);
}

async function normalizeSourceFiles(sourceFiles = [], { watchTriggered = false } = {}) {
  const entries = [];
  const seen = new Set();
  let duplicateCount = 0;

  for (let idx = 0; idx < sourceFiles.length; idx += 1) {
    const entry = sourceFiles[idx];
    const resolvedPath = await resolvePathSafeAsync(entry);
    if (!resolvedPath) continue;

    let isSymlink = false;
    try {
      const stat = await fsp.lstat(resolvedPath);
      isSymlink = typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink();
    } catch {
      // ignore lstat errors; keep as a file entry so missing paths still surface
    }

    const realPath = await resolveRealPathSafeAsync(resolvedPath) || resolvedPath;
    const dedupeKey = realPath || resolvedPath;
    if (seen.has(dedupeKey)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(dedupeKey);
    let isDir = false;
    if (!isSymlink) {
      try {
        isDir = (await fsp.stat(realPath)).isDirectory();
      } catch {
        // ignore stat errors; keep as a file entry so missing paths still surface
      }
    }
    entries.push({ fullPath: isSymlink ? resolvedPath : realPath, isDir });

    if ((idx + 1) % 200 === 0) {
      await yieldToMainThread();
    }
  }

  let normalizedEntries = entries;
  let descendantCount = 0;

  if (!watchTriggered) {
    const dirPaths = entries.filter(entry => entry.isDir).map(entry => entry.fullPath);
    if (dirPaths.length) {
      normalizedEntries = [];

      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        const isDescendant = dirPaths.some(dir => dir !== entry.fullPath && isPathInside(dir, entry.fullPath));
        if (!isDescendant) normalizedEntries.push(entry);
        if ((i + 1) % 250 === 0) {
          await yieldToMainThread();
        }
      }

      descendantCount = entries.length - normalizedEntries.length;
    }
  }

  return {
    files: normalizedEntries.map(entry => entry.fullPath),
    duplicateCount,
    descendantCount
  };
}

function getFileListRelativePath(filePath, options = {}) {
  const { watchRootForRel = null, useParentFolderPrefix = false } = options;
  let relativePath = path.basename(filePath);

  if (watchRootForRel) {
    const resolvedFp = resolvePathSafe(filePath);
    if (resolvedFp && isPathInside(watchRootForRel, resolvedFp)) {
      const rel = path.relative(watchRootForRel, resolvedFp);
      if (rel && rel !== '.' && !rel.startsWith('..')) {
        relativePath = rel;
      }
    }
  }

  if (useParentFolderPrefix && relativePath === path.basename(filePath)) {
    const parentName = path.basename(path.dirname(filePath));
    if (parentName && parentName !== path.basename(filePath)) {
      relativePath = path.join(parentName, path.basename(filePath));
    }
  }

  return relativePath;
}

function resolveCopyRelativePath(file, options = {}) {
  const { flattenStructure = false, sourceFolderRootName = null } = options;
  if (file?.resolvedRelativePath) {
    return file.resolvedRelativePath;
  }
  return flattenStructure
    ? (sourceFolderRootName ? file.relativePath : path.basename(file.fullPath))
    : file.relativePath;
}

function buildSuffixedRelPath(relPath, suffix) {
  const parsed = path.parse(relPath);
  const nextName = `${parsed.name}${suffix}${parsed.ext}`;
  return parsed.dir ? path.join(parsed.dir, nextName) : nextName;
}

function getParentSegments(filePath, stopPath = null) {
  const segments = [];
  const resolvedStop = stopPath ? resolvePathSafe(stopPath) : null;
  let current = path.dirname(filePath);
  const root = path.parse(current).root;
  while (current && current !== root) {
    if (resolvedStop && path.resolve(current) === resolvedStop) break;
    const name = path.basename(current);
    if (name) segments.push(name);
    current = path.dirname(current);
  }
  return segments;
}

function buildParentPrefixedRelPath(file, options, depth, parentSegments) {
  const { sourceFolderRootName = null } = options;
  const name = path.basename(file.fullPath);
  const selectedParents = parentSegments.slice(0, depth).reverse();
  if (sourceFolderRootName) {
    return path.join(sourceFolderRootName, ...selectedParents, name);
  }
  return path.join(...selectedParents, name);
}

function normalizeExtensions(extString = '') {
  // Matches the IPC estimator normalization:
  // - split on commas
  // - trim
  // - lowercase
  // - strip a leading '*'
  // - ensure a leading '.'
  return String(extString || '')
    .split(',')
    .map(str => str.trim().toLowerCase().replace(/^\*/, ''))
    .filter(Boolean)
    .map(ext => (ext.startsWith('.') ? ext : `.${ext}`));
}

async function collectSourceRoots(config) {
  const roots = new Set();
  const resolvedSource = await resolveRealPathSafeAsync(config.source);
  if (resolvedSource) roots.add(resolvedSource);

  if (Array.isArray(config.sourceFiles)) {
    for (const entry of config.sourceFiles) {
      const resolvedEntry = await resolveRealPathSafeAsync(entry);
      if (!resolvedEntry) continue;
      try {
        const stat = await fsp.stat(resolvedEntry);
        const root = stat.isDirectory() ? resolvedEntry : path.dirname(resolvedEntry);
        roots.add(root);
      } catch {
        roots.add(path.dirname(resolvedEntry));
      }
    }
  }

  if (config.watchFolder) {
    const resolvedWatch = await resolveRealPathSafeAsync(config.watchFolder);
    if (resolvedWatch) roots.add(resolvedWatch);
  }

  return Array.from(roots);
}

async function validateIngestConfig(config) {
  if (!config || typeof config !== 'object') {
    return [formatIngestMessage(ingestMessage('ingest.validation.invalidConfig'))];
  }

  const errors = [];
  const source = String(config.source || '').trim();
  const destination = String(config.destination || '').trim();
  const backupPath = String(config.backupPath || '').trim();
  const sourceFiles = Array.isArray(config.sourceFiles)
    ? config.sourceFiles
        .map(entry => (typeof entry === 'string' ? entry.trim() : entry))
        .filter(entry => (typeof entry === 'string' ? entry.length > 0 : Boolean(entry)))
    : [];
  const isClone = !!config.cloneMode;
  const isWatch = !!config.watchMode;
  const usesBackup = !!(config.dualCopy ?? config.backup);
  const watchFolder = String(config.watchFolder || '').trim();
  const enableN8N = !!config.enableN8N;
  const n8nUrl = String(config.n8nUrl || '').trim();
  const n8nAllowPrivate = !!config.n8nAllowPrivate;
  const n8nAllowlist = parseN8nAllowlist(config.n8nAllowlist || config.n8nAllowedHosts);
  const allowInsecureN8nHttp = envFlagEnabled(process.env.LEADAE_ALLOW_INSECURE_N8N_HTTP);
  const isPackagedOverride = config.isPackagedOverride;
  const isPackagedForValidation = typeof isPackagedOverride === 'boolean'
    ? isPackagedOverride
    : (app?.isPackaged ?? false);

  // `autoEject` is intentionally unsupported at this time.
  if (config.autoEject === true) {
    errors.push(ingestMessage('ingest.validation.autoEjectUnsupported'));
  }

  const hasSourcePath = !!source;
  const hasSourceFiles = sourceFiles.length > 0;

  if (!hasSourcePath && !hasSourceFiles) {
    errors.push(ingestMessage('ingest.validation.sourceMissing'));
  }

  if (!destination) {
    errors.push(ingestMessage('ingest.validation.destinationMissing'));
  }

  if (destination && await pathExists(destination)) {
    try {
      const stat = await fsp.stat(destination);
      if (!stat.isDirectory()) {
        errors.push(ingestMessage('ingest.validation.destinationMustBeFolder'));
      } else {
        try {
          await fsp.access(destination, fs.constants.W_OK);
        } catch (_err) {
          errors.push(ingestErrorMessage(INGEST_ERROR_CODE.DESTINATION_NOT_WRITABLE));
        }
      }
    } catch {
      // ignore destination stat errors here; other validation will surface access issues
    }
  }

  if (isClone) {
    if (hasSourceFiles) {
      errors.push(ingestMessage('ingest.validation.cloneMode.folderSourcesOnly'));
    } else if (!hasSourcePath) {
      errors.push(ingestMessage('ingest.validation.cloneMode.validSourceRequired'));
    } else {
      try {
        const stat = await fsp.stat(source);
        if (!stat.isDirectory()) {
          errors.push(ingestMessage('ingest.validation.cloneMode.validSourceRequired'));
        }
      } catch {
        errors.push(ingestErrorMessage(INGEST_ERROR_CODE.SOURCE_ACCESS_FAILED));
      }
    }

    if (!Array.isArray(config.selectedFolders) || config.selectedFolders.length === 0) {
      errors.push(ingestMessage('ingest.validation.cloneMode.selectedFolderRequired'));
    }
  }

  if (isWatch) {
    // In the UI, Watch Mode is a *folder automation* toggle, so we block manual file lists.
    // But when the watcher triggers an ingest job, we *intentionally* pass a file list for the
    // specific item that was detected. Those watch-triggered jobs set `watchTriggered=true`.
    const isWatchTriggered = !!config.watchTriggered;

    if (hasSourceFiles && !isWatchTriggered) {
      errors.push(ingestMessage('ingest.validation.watchMode.folderPathRequired'));
    }

    const watchRoot = watchFolder || source;
    if (!watchRoot) {
      errors.push(ingestMessage('ingest.validation.watchMode.watchFolderRequired'));
    } else {
      try {
        const stat = await fsp.stat(watchRoot);
        if (!stat.isDirectory()) {
          errors.push(ingestMessage('ingest.validation.watchMode.foldersOnly'));
        }
      } catch {
        errors.push(ingestErrorMessage(INGEST_ERROR_CODE.WATCH_FOLDER_ACCESS_FAILED));
      }
    }
  }

  const resolvedDestination = resolveRealPathSafe(destination);
  const sourceRoots = await collectSourceRoots({ source, sourceFiles, watchFolder });

  if (resolvedDestination && sourceRoots.length) {
    for (const root of sourceRoots) {
      if (!root) continue;
      if (isPathInside(root, resolvedDestination)) {
        errors.push(ingestMessage('ingest.validation.destinationInsideSource'));
        break;
      }
      if (isPathInside(resolvedDestination, root)) {
        errors.push(ingestMessage('ingest.validation.sourceInsideDestination'));
        break;
      }
    }
  }

  const resolvedBackupPath = resolveRealPathSafe(backupPath);

  if (usesBackup && !backupPath) {
    errors.push(ingestMessage('ingest.validation.backupPathRequired'));
  }

  if (backupPath && await pathExists(backupPath)) {
    try {
      const stat = await fsp.stat(backupPath);
      if (!stat.isDirectory()) {
        errors.push(ingestMessage('ingest.validation.backupMustBeFolder'));
      } else if (usesBackup) {
        try {
          await fsp.access(backupPath, fs.constants.W_OK);
        } catch (_err) {
          errors.push(ingestErrorMessage(INGEST_ERROR_CODE.BACKUP_NOT_WRITABLE));
        }
      }
    } catch {
      // ignore backup stat errors here; other validation will surface access issues
    }
  }

  if (usesBackup && resolvedBackupPath && sourceRoots.length) {
    for (const root of sourceRoots) {
      if (!root) continue;
      if (isPathInside(root, resolvedBackupPath)) {
        errors.push(ingestMessage('ingest.validation.backupInsideSource'));
        break;
      }
      if (isPathInside(resolvedBackupPath, root)) {
        errors.push(ingestMessage('ingest.validation.sourceInsideBackup'));
        break;
      }
    }
  }

  if (usesBackup && resolvedDestination && resolvedBackupPath) {
    const overlap = isPathInside(resolvedDestination, resolvedBackupPath) || isPathInside(resolvedBackupPath, resolvedDestination);
    if (overlap) {
      errors.push(ingestMessage('ingest.validation.destinationBackupOverlap'));
    }
  }

  if (enableN8N) {
    const n8nValidation = validateN8nUrl(n8nUrl, {
      allowPrivate: n8nAllowPrivate,
      allowlist: n8nAllowlist,
      allowInsecureHttp: allowInsecureN8nHttp,
      isPackaged: isPackagedForValidation
    });
    if (!n8nValidation.valid) {
      errors.push(n8nValidation.message || ingestMessage('ingest.validation.n8n.invalidFormat'));
    }
  }

  return errors.map((entry) => formatIngestMessage(entry));
}


// ================================
// ⏱️ ETA Calculation
// ================================

async function getFreeDiskSpace(targetPath) {
  if (process.platform === 'win32') {
    try {
      const { free } = await checkDiskSpace(path.parse(targetPath).root);
      return free;
    } catch {
      return null;
    }
  }

  try {
    const sanitizedPath = path.resolve(String(targetPath));
    const { stdout } = await execFileAsync('df', ['-k', sanitizedPath], {
      encoding: 'utf-8',
      timeout: 1500
    });
    const output = stdout || '';
    const lines = output.trim().split(/\n/);
    if (lines.length > 1) {
      const parts = lines[1].trim().split(/\s+/);
      const freeKb = parseInt(parts[3], 10);
      if (!Number.isNaN(freeKb)) return freeKb * 1024;
    }
  } catch (error) {
    if (error && (error.killed || error.code === 'ETIMEDOUT')) {
      return null;
    }
    return null;
  }
  return null;
}

function _formatBytesBinary(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatBytesDecimal(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1000 && i < units.length - 1) {
    val /= 1000;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}


/**
 * ⌛ Estimates time remaining based on average time per file.
 *
 * @param {number} processed - Number of files processed
 * @param {number} total - Total number of files
 * @returns {string} - Estimated time remaining as a string (e.g. "42s")
 */

async function runIngest(config) {
  if (!config || typeof config !== 'object') {
    const log = [ingestMessage('ingest.invalidConfig')];
    return {
      success: false,
      cancelled: false,
      jobId: null,
      log,
      logText: log.map(entry => formatIngestMessage(entry)).join('\n')
    };
  }

  config.source = sanitizeOperationalPath(config.source);
  config.destination = sanitizeOperationalPath(config.destination);
  config.backupPath = sanitizeOperationalPath(config.backupPath);
  config.watchFolder = sanitizeOperationalPath(config.watchFolder);
  if (Array.isArray(config.sourceFiles)) {
    config.sourceFiles = config.sourceFiles
      .map(sanitizeOperationalPath)
      .filter(Boolean);
  }

  const validationErrors = await validateIngestConfig(config);
  if (validationErrors.length) {
    const log = [...validationErrors];
    return { success: false, log, logText: log.map(entry => formatIngestMessage(entry)).join('\n') };
  }

  if (config.cloneMode) {
    return runClone(config);
  }
  if (!config.signal) config.signal = createCancelToken();

  if (!config.jobId) {
    config.jobId = `ingest-${Date.now()}`;
  }

  await xxhashReady;
  const jobLogger = createJobLogger({
    panel: 'ingest',
    jobId: config.jobId,
    stage: 'init',
    streamToFile: true,
  });

  const startedAtMs = Date.now();

  const renderUserLogLine = (msg) => {
    if (msg && typeof msg === 'object') return formatIngestMessage(msg);
    if (typeof msg === 'string') return msg;
    return String(msg ?? '');
  };

  const userLog = createJobUserLog(jobLogger, {
    normalize: renderUserLogLine,
    pickLevel: (text, isError) => {
      const rendered = renderUserLogLine(text);
      const inferredError = isError || /❌|\berror\b/i.test(rendered);
      const inferredWarn = !inferredError && (/⚠️|\bwarn\b/i.test(rendered));
      return inferredError ? 'error' : inferredWarn ? 'warn' : 'info';
    }
  });
  const log = userLog.lines;
  const logPush = userLog.push;
  const getLogText = () => log.map(entry => formatIngestMessage(entry)).join('\n');
  const window = getMainWindow();
  const dialogParentWindow = window && !window.isDestroyed?.() ? window : undefined;

  let archivePath = null;
  let structuredPath = null;
  structuredPath = jobLogger.getStructuredLogPath?.() || structuredPath;
  let didPersistJobLogs = false;
  let reportDiscoveredFileCount = 0;
  let reportEligibleFileCount = 0;
  let reportQueuedFileCount = 0;
  let reportStats = {};
  let reportPrimaryDestination = config.destination || '';
  const reportSources = (
    Array.isArray(config.sourceFiles) && config.sourceFiles.length
      ? config.sourceFiles.slice(0, 50)
      : (Array.isArray(config.retryFiles) && config.retryFiles.length ? config.retryFiles.slice(0, 50) : [])
  );
  const savedJobReportCopies = new Set();

  const getReportSourceCount = () => {
    if (Array.isArray(config.sourceFiles) && config.sourceFiles.length) return config.sourceFiles.length;
    if (Array.isArray(config.retryFiles) && config.retryFiles.length) return config.retryFiles.length;
    return (config.source || config.watchFolder) ? 1 : 0;
  };

  const getReportMode = () => {
    if (Array.isArray(config.retryFiles) && config.retryFiles.length) return 'retry';
    return config.watchMode ? 'watch' : 'manual';
  };

  const getReportVerificationMethod = () => {
    if (config.verification?.compareByte) return 'byte-by-byte';
    return config.verification?.method || (config.verification?.useChecksum ? 'checksum' : 'none');
  };

  const persistJobLogs = ({ rewriteText = false, closeLogger = true } = {}) => {
    if (didPersistJobLogs && !rewriteText) {
      if (closeLogger) {
        try { jobLogger.close?.(); } catch {}
      }
      return;
    }
    try {
      if (!structuredPath) {
        structuredPath = jobLogger.getStructuredLogPath?.() || null;
      }
      if (!structuredPath) {
        structuredPath = writeJobLogToFile('ingest', config.jobId, jobLogger.getEntries());
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist ingest JSONL log:', e?.message || e);
    }
    try {
      if (!archivePath || rewriteText) {
        archivePath = writeJobTextToFile(
          'ingest',
          config.jobId,
          jobLogger.getEntries(),
          {
            structuredLogPath: structuredPath,
            inputs: {
              sourceCount: getReportSourceCount(),
              sourceRoot: config.source || '',
              sources: reportSources,
              watchFolder: config.watchFolder || '',
            },
            outputs: {
              primaryDestination: reportPrimaryDestination,
              secondaryDestination: config.backupPath || '',
            },
            settings: {
              autoFolder: !!config.autoFolder,
              dualCopy: !!(config.dualCopy ?? config.backup),
              flattenStructure: !!config.flattenStructure,
              mode: getReportMode(),
              retryFailures: !!config.retryFailures,
              saveLog: !!config.saveLog,
              skipDuplicates: !!config.verification?.skipDuplicates,
              verificationMethod: getReportVerificationMethod(),
              watchMode: !!config.watchMode,
            },
            stats: reportStats,
          }
        );
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist ingest TXT log:', e?.message || e);
    }
    didPersistJobLogs = true;
    if (closeLogger) {
      try { jobLogger.close?.(); } catch {}
    }
  };

  const refreshSavedJobReportCopies = async () => {
    if (!archivePath || savedJobReportCopies.size === 0) return;
    try {
      if (!await pathExists(archivePath)) return;
    } catch {
      return;
    }

    for (const targetPath of savedJobReportCopies) {
      try {
        await fsp.mkdir(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(archivePath, targetPath);
      } catch (err) {
        console.warn('⚠️ Failed to refresh saved ingest TXT log copy:', err?.message || err);
      }
    }
  };

  let progressManager;
  let cacheDirty = false;

  const buildWatchTriggeredSkipResult = (reason, status) => ({
    success: false,
    skipped: true,
    reason,
    status,
    log,
    logText: getLogText(),
    cancelled: false,
    archivePath,
    structuredLogPath: structuredPath,
    jobId: config.jobId
  });

  const flushHashCache = () => {
    if (!cacheDirty) return;
    saveCache(hashCache);

    cacheDirty = false;
  };

  try {
    const counters = {
      success: 0,
      skipped: 0,
      failed: 0,
      verifyDestRequired: 0,
      verifyDestPassed: 0,
      verifyBackupRequired: 0,
      verifyBackupPassed: 0
    };
    const skippedFiles = [];
    const failedFiles = new Set();
    const recordFailure = relPath => {
      if (relPath) failedFiles.add(relPath);
    };
    const clearFailure = relPath => {
      if (relPath) failedFiles.delete(relPath);
    };
    const destPaths = [];

    const {
      source,
      destination,
      flattenStructure,
      autoFolder,
      saveLog,
      notes,
      enableN8N,
      n8nUrl,
      n8nAllowPrivate,
      n8nAllowlist,
      n8nIncludePaths,
      n8nLog,
      watchMode,
      verification,
      includeHiddenFiles,
      includeCache,
      useDefaultIgnorePatterns: useDefaultIgnorePatternsRaw
    } = config;
    const isWatchTriggered = !!watchMode && !!config.watchTriggered;

    // Watch-mode processed tracking (no source-folder mutations).
    // main.js provides config.watchRegistry for watch-triggered jobs.
    const watchRegistrySessionKey = isWatchTriggered ? config.watchRegistry?.sessionKey : null;
    const watchRegistryEntries = isWatchTriggered && Array.isArray(config.watchRegistry?.entries)
      ? config.watchRegistry.entries
      : [];

    const normalizeWatchRegistryPath = p => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };

    const watchRegistrySigByPath = new Map();
    for (const entry of watchRegistryEntries) {
      if (!entry || typeof entry.filePath !== 'string' || typeof entry.signature !== 'string') continue;
      watchRegistrySigByPath.set(normalizeWatchRegistryPath(entry.filePath), entry.signature);
    }

    const getWatchSignatureForPath = p => {
      if (!watchRegistrySessionKey) return null;
      return watchRegistrySigByPath.get(normalizeWatchRegistryPath(p)) || null;
    };

    const markWatchProcessed = (srcPath, meta = {}) => {
      if (!watchRegistrySessionKey) return;
      const sig = getWatchSignatureForPath(srcPath);
      if (!sig) return;
      markProcessedShared(watchRegistrySessionKey, sig, {
        srcPath,
        ...meta
      });
    };

    // UI prefers "Include Cache" (checked = include typical cache/dev folders).
    // Backend historically used `useDefaultIgnorePatterns` (true = exclude those entries).
    // Support both, and default to excluding caches/dev folders.
    const includeCacheEffective = typeof includeCache === 'boolean'
      ? includeCache
      : (useDefaultIgnorePatternsRaw !== undefined ? !useDefaultIgnorePatternsRaw : false);
    const useDefaultIgnorePatterns = !includeCacheEffective;
    // Backwards/forwards compatibility:
    // - Older configs may use `backup` to mean "Dual Copy"
    // - Newer configs may use `dualCopy`
    // Treat `dualCopy` as authoritative when present, and keep both fields in sync.
    const dualCopyEnabled = config.dualCopy ?? config.backup;
    let backup = !!dualCopyEnabled;
    config.backup = backup;
    config.dualCopy = backup;
    let backupPath = config.backupPath;

    // ------------------------------------------
    // 🧾 Operator log header (saved log file)
    // Keep concise, but include job-critical facts.
    // ------------------------------------------
    const verifyMethod = String(verification?.method || (verification?.useChecksum ? 'checksum' : 'none')).toLowerCase();
    const skipDup = !!verification?.skipDuplicates;
    const includeStr = String(config.filters?.include || config.includeExtensions || '').trim() || 'all';
    const excludeStr = String(config.filters?.exclude || config.excludeExtensions || '').trim() || 'none';
    const sourceLabel = (Array.isArray(config.sourceFiles) && config.sourceFiles.length)
      ? `${config.sourceFiles.length} selected item(s)`
      : (config.retryFiles?.length ? `${config.retryFiles.length} retry item(s)` : (source || '(none)'));
    const threadsLabel = config.enableThreads
      ? (config.autoThreads ? 'auto' : `manual ${String(config.maxThreads ?? 1)}`)
      : 'off';

    const pushMessage = (key, params = {}, detail = '', isError = false, fileId = '') => (
      logPush(ingestMessage(key, params), detail, isError, fileId)
    );

    pushMessage('ingest.started', { jobId: config.jobId });
    pushMessage('ingest.header.source', { sourceLabel });
    pushMessage('ingest.header.destination', { destination });
    if (backup) pushMessage('ingest.header.backup', { backupPath: backupPath || '(not set)' });
    pushMessage('ingest.header.options', {
      flatten: flattenStructure ? 'on' : 'off',
      autoFolder: autoFolder ? 'on' : 'off',
      verifyMethod,
      skipDup: skipDup ? 'on' : 'off',
      retryFailures: config.retryFailures ? 'on' : 'off',
      saveLog: saveLog ? 'on' : 'off',
      watchMode: watchMode ? 'on' : 'off'
    });
    pushMessage('ingest.header.filters', { include: includeStr, exclude: excludeStr });
    pushMessage('ingest.header.scan', {
      hidden: includeHiddenFiles ? 'on' : 'off',
      cache: includeCacheEffective ? 'on' : 'off',
      defaultIgnore: useDefaultIgnorePatterns ? 'on' : 'off'
    });
    pushMessage('ingest.header.threads', { threads: threadsLabel });
    if (enableN8N) {
      const host = (() => { try { return new URL(String(n8nUrl || '')).host; } catch { return ''; } })();
      pushMessage('ingest.header.webhook', { hostSuffix: host ? ` (${host})` : '' });
    }

    // Keep extension filtering behavior consistent with IPC estimation.
    // Users may type: "mov", ".mov", "*.mov" — all should behave the same.
    const filters = {
      include: normalizeExtensions(config.filters?.include || config.includeExtensions || ''),
      exclude: normalizeExtensions(config.filters?.exclude || config.excludeExtensions || '')
    };

    const scanOptions = {
      includeHidden: !!includeHiddenFiles,
      useDefaultIgnorePatterns,
      signal: config.signal
    };
    const scanSkipped = { count: 0, samples: [] };
    scanOptions.onError = (scanPath, err) => {
      scanSkipped.count += 1;
      if (scanSkipped.samples.length < 5) {
        scanSkipped.samples.push(`${scanPath} (${err.message})`);
      }
    };
    const scanBatchSize = 250;
    const flushScanBatch = (batch, { rootPrefix, flatten, flattenRootPrefix }) => {
      if (!batch.length) return;
      for (const item of batch) {
        if (item.isDirectory) {
          if (!flatten) {
            directories.push({
              fullPath: item.fullPath,
              relativePath: path.join(rootPrefix, item.relativePath)
            });
          }
        } else {
          const flatPrefix = flatten ? flattenRootPrefix : rootPrefix;
          files.push({
            fullPath: item.fullPath,
            relativePath: flatten
              ? path.join(flatPrefix || '', path.basename(item.fullPath)).replace(/^[\\/]/, '')
              : path.join(rootPrefix, item.relativePath)
          });
        }
      }
      batch.length = 0;
    };

    if (destination && await pathExists(destination)) {
      const stat = await fsp.stat(destination);
      if (!stat.isDirectory()) {
        const message = ingestMessage('ingest.validation.destinationMustBeFolder');
        logPush(message, '', true);
        return { success: false, log, logText: message };
      }
    }

    if (backupPath && await pathExists(backupPath)) {
      const stat = await fsp.stat(backupPath);
      if (!stat.isDirectory()) {
        const message = ingestMessage('ingest.validation.backupMustBeFolder');
        logPush(message, '', true);
        return { success: false, log, logText: message };
      }
    }

    logPush(ingestMessage('ingest.log.settings', {
      hidden: includeHiddenFiles ? 'on' : 'off',
      cache: includeCacheEffective ? 'on' : 'off',
      defaultIgnore: useDefaultIgnorePatterns ? 'on' : 'off'
    }));

    const n8nValidation = enableN8N
      ? validateN8nUrl(n8nUrl, {
          allowPrivate: n8nAllowPrivate,
          allowlist: n8nAllowlist,
          allowInsecureHttp: envFlagEnabled(process.env.LEADAE_ALLOW_INSECURE_N8N_HTTP)
        })
      : { valid: false };

    if (enableN8N && !n8nValidation.valid) {
      const message = n8nValidation.message || ingestMessage('ingest.validation.n8n.invalidFormat');
      logPush(message, '', true);
      return {
        success: false,
        log,
        logText: getLogText(),
        cancelled: false,
        archivePath,
        structuredLogPath: structuredPath,
        jobId: config.jobId
      };
    }

    if (Array.isArray(config.sourceFiles) && config.sourceFiles.length > 0) {
      const { files, duplicateCount, descendantCount } = await normalizeSourceFiles(config.sourceFiles, {
        watchTriggered: !!config.watchTriggered
      });
      const removedCount = duplicateCount + descendantCount;
      if (removedCount > 0) {
        const notes = [];
        if (duplicateCount) notes.push(`${duplicateCount} duplicate path(s)`);
        if (descendantCount) notes.push(`${descendantCount} nested path(s) already included via a selected folder`);
        logPush(ingestMessage('ingest.log.normalizedSelection', {
          notes: notes.join(' and ')
        }));
      }
      config.sourceFiles = files;

      const beforeCount = config.sourceFiles.length;
      const filtered = filterOutDestination(config.sourceFiles, config.destination);
      const afterCount = filtered.length;
      if (afterCount < beforeCount) {
        const resolvedDest = path.resolve(config.destination || '');
        logPush(ingestMessage('ingest.log.skippedDestinationAsSource', { path: resolvedDest }));
      }
      config.sourceFiles = filtered;

      const validSourceFiles = [];
      const missingSourceFiles = [];
      for (const sourcePath of config.sourceFiles) {
        try {
          await fsp.stat(sourcePath);
          validSourceFiles.push(sourcePath);
        } catch {
          missingSourceFiles.push(sourcePath);
        }
      }

      for (const missingPath of missingSourceFiles) {
        logPush(ingestMessage('ingest.log.sourceFileNotFound', { path: missingPath }));
      }

      if (config.sourceFiles.length > 0 && validSourceFiles.length === 0) {
        const message = ingestMessage('ingest.log.noSourceInputsExist');
        logPush(message, '', true);
        return {
          success: false,
          log,
          logText: getLogText(),
          cancelled: false,
          archivePath,
          structuredLogPath: structuredPath,
          jobId: config.jobId
        };
      }

      config.sourceFiles = validSourceFiles;
      logPush(ingestMessage('ingest.log.triggeredForSources', { count: config.sourceFiles.length }));
    } else if (config.retryFiles?.length) {
      logPush(ingestMessage('ingest.log.triggeredForRetries', { count: config.retryFiles.length }));
    } else {
      logPush(ingestMessage('ingest.log.startingFromSource', { source }));
    }

    // ==========================================
    // 📁 Gather file and directory lists for ingest
    // ==========================================

    let files = [];
    let directories = [];
    let sourceFolderRootName = null;

    // When Watch Mode triggers a job, we ingest a *specific file* but still want to
    // preserve its path relative to the watched folder (so subfolders are mirrored).
    const watchRootForRel =
      watchMode && !!config.watchTriggered
        ? resolvePathSafe(config.watchFolder || config.source)
        : null;
    // When selecting multiple items, we *used to* namespace every standalone file under its
    // parent folder (e.g. CARD_A/clip.mov) to avoid basename collisions.
    // That behavior is surprising when the user selects a folder + a single file.
    // New behavior: copy standalone files by basename unless we detect a filename collision.
    const explicitSelectedFiles = [];
    const rootFolderAliases = new Map();
    const rootFolderRenameMessages = [];

    if (Array.isArray(config.sourceFiles) && config.sourceFiles.length > 0) {
      const rootDirectories = [];
      for (const fp of config.sourceFiles) {
        try {
          if ((await fsp.stat(fp)).isDirectory()) {
            rootDirectories.push(fp);
          }
        } catch {
          // Ignore here; we'll log missing paths later in the main loop.
        }
      }

      const byBasename = new Map();
      for (const dir of rootDirectories) {
        const base = path.basename(dir);
        const group = byBasename.get(base) || [];
        group.push(dir);
        byBasename.set(base, group);
      }

      const usedNames = new Set();
      for (const [base, group] of byBasename.entries()) {
        if (group.length === 1) {
          const [dir] = group;
          const name = base;
          rootFolderAliases.set(dir, name);
          usedNames.add(name);
          continue;
        }

        group.forEach((dir, index) => {
          const parent = path.basename(path.dirname(dir));
          let name = parent ? `${parent}_${base}` : base;
          if (usedNames.has(name)) {
            name = `${name}_${String(index + 1).padStart(2, '0')}`;
          }
          rootFolderAliases.set(dir, name);
          usedNames.add(name);
          rootFolderRenameMessages.push(ingestMessage('ingest.log.duplicateRootRenameDetail', { base, dir, name }));
        });
      }
    }

    if (Array.isArray(config.sourceFiles) && config.sourceFiles.length > 0) {
      if (rootFolderRenameMessages.length > 0) {
        logPush(ingestMessage('ingest.log.duplicateRootNamesAdjusted'));
        rootFolderRenameMessages.forEach(message => logPush(message));
      }
      for (const fp of config.sourceFiles) {
        let stat;
        try {
          stat = await fsp.stat(fp);
        } catch (err) {
          const msg = ingestMessage('ingest.log.skipUnreadableSourcePath', { path: fp, error: err.message });
          logPush(msg);
          recordFailure(path.basename(fp));
          continue;
        }
        if (stat.isDirectory()) {
          const rootPrefix = rootFolderAliases.get(fp) || path.basename(fp);
          if (!flattenStructure) {
            directories.push({ fullPath: fp, relativePath: rootPrefix });
          }
          const batch = [];
          for await (const item of getAllItemsRecursively(fp, fp, scanOptions)) {
            batch.push(item);
            if (batch.length >= scanBatchSize) {
              flushScanBatch(batch, {
                rootPrefix,
                flatten: flattenStructure,
                flattenRootPrefix: ''
              });
            }
          }
          flushScanBatch(batch, {
            rootPrefix,
            flatten: flattenStructure,
            flattenRootPrefix: ''
          });          
        } else {
          const relativePath = getFileListRelativePath(fp, {
            watchRootForRel,
            useParentFolderPrefix: false
          });

          const entry = {
            fullPath: fp,
            relativePath
          };
          files.push(entry);
          explicitSelectedFiles.push(entry);
        }
      }
      // Only namespace standalone files when needed to prevent overwriting collisions.
      if (explicitSelectedFiles.length > 1) {
        const byKey = new Map();
        for (const entry of explicitSelectedFiles) {
          const key = String(entry.relativePath || '').toLowerCase();
          if (!key) continue;
          const group = byKey.get(key) || [];
          group.push(entry);
          byKey.set(key, group);
        }

        let namespacedCount = 0;
        for (const group of byKey.values()) {
          if (group.length <= 1) continue;
          for (const entry of group) {
            const nextRel = getFileListRelativePath(entry.fullPath, {
              watchRootForRel,
              useParentFolderPrefix: true
            });
            if (nextRel && nextRel !== entry.relativePath) {
              entry.relativePath = nextRel;
              namespacedCount += 1;
            }
          }
        }

        if (namespacedCount > 0) {
          logPush(
            ingestMessage('ingest.log.duplicateFileNamesNamespaced', { count: namespacedCount })
          );
        }
      }
      // Watch mode details are logged via structured summary
    } else if (config.retryFiles && Array.isArray(config.retryFiles)) {
      files = config.retryFiles.map(relPath => ({
        fullPath: path.join(config.source, relPath),
        relativePath: relPath
      }));
      directories = Array.from(new Set(config.retryFiles.map(p => path.dirname(p))))
        .filter(p => p !== '.')
        .map(rel => ({ relativePath: rel }));
    } else {
      const base = config.source || '.';
      const sourceFolderName = path.basename(path.resolve(base));
      sourceFolderRootName = sourceFolderName;
      if (!flattenStructure) {
        directories = [{ fullPath: base, relativePath: sourceFolderName }];
      }

      if (await pathExists(base)) {
        const batch = [];
        for await (const item of getAllItemsRecursively(base, base, scanOptions)) {
          batch.push(item);
          if (batch.length >= scanBatchSize) {
            flushScanBatch(batch, {
              rootPrefix: sourceFolderName,
              flatten: flattenStructure,
              flattenRootPrefix: sourceFolderName
            });
          }
        }
        flushScanBatch(batch, {
          rootPrefix: sourceFolderName,
          flatten: flattenStructure,
          flattenRootPrefix: sourceFolderName
        });
      }
    }

    // 🧹 Hidden/system file handling (configurable)
    files = files.filter(({ fullPath, relativePath }) => {
      const name = path.basename(fullPath);

      if (shouldAlwaysSkipFile(name)) return false;

      if (!includeHiddenFiles) {
        // Skip dotfiles by default.
        if (name.startsWith('.')) return false;

        // Also skip anything *inside* hidden directories (e.g. TEST/.Spotlight-V100/...).
        // This matters in Watch Mode where a watched file path may point into a dot-directory
        // even though the file itself doesn't start with a dot.
        const rel = String(relativePath || '').split(/[\\/]+/).filter(Boolean);
        if (rel.some(seg => seg && seg !== '.' && seg !== '..' && seg.startsWith('.'))) {
          return false;
        }
      }

      return true;
    });

    // Summary of what will be processed.
    reportDiscoveredFileCount = files.length;
    logPush(ingestMessage('ingest.log.fileListReady', {
      fileCount: files.length,
      folderClause: flattenStructure ? '' : `, ${directories.length} folder(s)`
    }));
    if (scanSkipped.count > 0) {
      const sampleClause = scanSkipped.samples.length
        ? ` Examples: ${scanSkipped.samples.slice(0, 3).join(' | ')}`
        : '';
      logPush(ingestMessage('ingest.log.unreadablePathsSkipped', { count: scanSkipped.count, sampleClause }));
    }

if (config.signal?.aborted) {
  logPush(ingestMessage('ingest.log.cancelledByUser'));
  removeJobFile();
  flushHashCache();
  structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
  jobLogger.setStage('cancelled');
  jobLogger.info('Ingest job cancelled');
  persistJobLogs();
  return {
    success: false,
    log,
    logText: getLogText(),
    cancelled: true,
    archivePath,
    structuredLogPath: structuredPath,
    jobId: config.jobId
  };
}

const fileSizeMap = await preloadFileSizes(files, msg => logPush(msg), { signal: config.signal });

if (config.signal?.aborted) {
  logPush(ingestMessage('ingest.log.cancelledByUser'));
  removeJobFile();
  flushHashCache();
  structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
  jobLogger.setStage('cancelled');
  jobLogger.info('Ingest job cancelled');
  persistJobLogs();
  return {
    success: false,
    log,
    logText: getLogText(),
    cancelled: true,
    archivePath,
    structuredLogPath: structuredPath,
    jobId: config.jobId
  };
}
let filesToCopy = [];
let totalBytesToCopy = 0;
let destBytesToCopy = 0;
let backupBytesToCopy = 0;


// ==========================================
// 🔍 Verification Options Unpacking
// ==========================================

const {
  useChecksum: verify = false,        // Global on/off toggle
  method: checksumMethod = 'sha256',  // Default hash type
  compareByte: byteMatch = false,     // Byte-level shortcut check
  skipDuplicates,                     // Skip if file already exists
} = verification || {};

if (checksumMethod === 'blake3' && !blake3Available) {
  const msg = ingestMessage('ingest.dialog.blake3Unavailable.message');
  logPush(msg, '', true);
  if (!isWatchTriggered) {
    await showIngestDialog(dialogParentWindow, ingestDialogPayload({
      type: 'error',
      title: ingestMessage('ingest.dialog.blake3Unavailable.title'),
      message: ingestMessage('ingest.dialog.blake3Unavailable.message')
    }));
  }
  return { success: false, log, logText: getLogText() };
}

if (checksumMethod === 'xxhash64') {
  await xxhashReady;
  if (!xxhashAvailable) {
    const msg = ingestMessage('ingest.dialog.xxhash64Unavailable.message');
    logPush(msg, '', true);
    if (!isWatchTriggered) {
      await showIngestDialog(dialogParentWindow, ingestDialogPayload({
        type: 'error',
        title: ingestMessage('ingest.dialog.xxhash64Unavailable.title'),
        message: ingestMessage('ingest.dialog.xxhash64Unavailable.message')
      }));
    }
    return { success: false, log, logText: getLogText() };
  }
}

// ==========================================
// ✅ Step 1: Validate Source Directory
// ==========================================

if ((!Array.isArray(config.sourceFiles) || config.sourceFiles.length === 0) && !await pathExists(source)) {
  if (isWatchTriggered) {
    const message = ingestMessage('ingest.log.watchSkippedSourceMissing', { source });
    logPush(message, '', true);
    return buildWatchTriggeredSkipResult(INGEST_REASON.MISSING_SOURCE, INGEST_STATUS.WATCH_SKIPPED_MISSING_SOURCE);
  }

  const allowOverride = !!config.allowMissingSourceOverride;
  if (!allowOverride) {
    const message = ingestMessage('ingest.log.sourceMissingCancelled', { source });
    logPush(message, '', true);
    await showIngestDialog(dialogParentWindow, ingestDialogPayload({
      type: 'error',
      title: ingestMessage('ingest.dialog.sourceNotFound.title'),
      message: ingestMessage('ingest.dialog.sourceNotFound.message', { source }),
      buttons: [ingestMessage('ingest.dialog.button.ok')],
      defaultId: 0,
      cancelId: 0
    }));
    jobLogger.setStage('error');
    persistJobLogs();
    return { success: false, log, logText: getLogText() };
  }

  const overrideMessage = ingestMessage('ingest.log.sourceMissingOverrideEnabled', { source });
  logPush(overrideMessage, '', true);
  jobLogger.setStage('skipped');
  persistJobLogs();
  return {
    success: false,
    skipped: true,
    overrideMissingSource: true,
    log,
    logText: getLogText()
  };
}

// ==========================================
// 📂 Step 2: Validate Destination Directory
// ==========================================

const sourceRoots = await collectSourceRoots(config);
const resolvedDestination = resolveRealPathSafe(destination);

if (!destination || !destination.trim()) {
  logPush(ingestMessage('ingest.log.destinationMissingCancelled'), '', true);
  return { success: false, log, logText: getLogText() };
}

if (resolvedDestination && sourceRoots.some(root => isPathInside(root, resolvedDestination))) {
  const overlapMessage = ingestMessage('ingest.validation.destinationInsideSource');
  logPush(overlapMessage, '', true);
  return { success: false, log, logText: overlapMessage };
}

if (resolvedDestination && sourceRoots.some(root => isPathInside(resolvedDestination, root))) {
  const overlapMessage = ingestMessage('ingest.validation.sourceInsideDestination');
  logPush(overlapMessage, '', true);
  return { success: false, log, logText: overlapMessage };
}

if (!await pathExists(destination)) {
  if (isWatchTriggered) {
    const message = ingestMessage('ingest.log.watchSkippedDestinationMissing', { destination });
    logPush(message, '', true);
    return buildWatchTriggeredSkipResult(INGEST_REASON.MISSING_DESTINATION, INGEST_STATUS.WATCH_SKIPPED_MISSING_DESTINATION);
  }
  const { response } = await showIngestDialog(dialogParentWindow, ingestDialogPayload({
    type: 'warning',
    title: ingestMessage('ingest.dialog.destinationNotFound.title'),
    message: ingestMessage('ingest.dialog.destinationNotFound.message', { destination }),
    buttons: [
      ingestMessage('ingest.dialog.button.yes'),
      ingestMessage('ingest.dialog.button.no')
    ],
    defaultId: 0,
    cancelId: 1
  }));

  if (response === 0) {
    try {
      await fsp.mkdir(destination, { recursive: true });
      logPush(ingestMessage('ingest.log.destinationCreated', { destination }));
    } catch (err) {
      logPush(ingestMessage('ingest.log.destinationCreateFailed', { error: err.message }), '', true);
      return { success: false, log, logText: getLogText() };
    }
  } else {
    const cancelMessage = ingestMessage('ingest.log.destinationNotCreatedCancelled');
    return { success: false, log: [cancelMessage], logText: formatIngestMessage(cancelMessage) };
  }
}

if (backup && (!backupPath || !backupPath.trim())) {
  const backupMessage = ingestMessage('ingest.validation.backupPathRequired');
  logPush(backupMessage, '', true);
  return { success: false, log, logText: backupMessage };
}

// ==========================================
// 📝 Step 2.5: Log User Notes (Optional)
// ==========================================

if (notes && notes.trim()) {
  logPush(ingestMessage('ingest.log.notes', { notes: notes.trim() }));
}

// ==========================================
// 💾 Step 3: Validate/Create Backup Directory (if enabled)
// ==========================================

const resolvedBackupPath = resolveRealPathSafe(backupPath);

if (backup && resolvedBackupPath && sourceRoots.some(root => isPathInside(root, resolvedBackupPath))) {
  const overlapMessage = ingestMessage('ingest.validation.backupInsideSource');
  logPush(overlapMessage, '', true);
  return { success: false, log, logText: overlapMessage };
}

if (backup && resolvedBackupPath && sourceRoots.some(root => isPathInside(resolvedBackupPath, root))) {
  const overlapMessage = ingestMessage('ingest.validation.sourceInsideBackup');
  logPush(overlapMessage, '', true);
  return { success: false, log, logText: overlapMessage };
}

if (backup && resolvedDestination && resolvedBackupPath) {
  const overlap = isPathInside(resolvedDestination, resolvedBackupPath) || isPathInside(resolvedBackupPath, resolvedDestination);
  if (overlap) {
    const overlapMessage = ingestMessage('ingest.validation.destinationBackupOverlap');
    logPush(overlapMessage, '', true);
    return { success: false, log, logText: overlapMessage };
  }
}

if (backup && backupPath && !await pathExists(backupPath)) {
  if (isWatchTriggered) {
    const message = ingestMessage('ingest.log.watchSkippedBackupMissing', { backupPath });
    logPush(message, '', true);
    return buildWatchTriggeredSkipResult(INGEST_REASON.MISSING_BACKUP, INGEST_STATUS.WATCH_SKIPPED_MISSING_BACKUP);
  }
  const { response } = await showIngestDialog(dialogParentWindow, ingestDialogPayload({
    type: 'question',
    title: ingestMessage('ingest.dialog.backupPathNotFound.title'),
    message: ingestMessage('ingest.dialog.backupPathNotFound.message', { backupPath }),
    buttons: [
      ingestMessage('ingest.dialog.button.yes'),
      ingestMessage('ingest.dialog.button.no')
    ],
    defaultId: 0,
    cancelId: 1
  }));

  if (response === 0) {
    try {
      await fsp.mkdir(backupPath, { recursive: true });
      logPush(ingestMessage('ingest.log.backupPathCreated', { backupPath }));
    } catch (err) {
      const message = ingestMessage('ingest.log.backupPathCreateFailedDualCopy', { error: err.message });
      logPush(message, '', true);
      return {
        success: false,
        log,
        logText: message,
        dualCopyGuaranteeFailed: true
      };
    }
  } else {
    const cancelMessage = ingestMessage('ingest.log.backupPathNotCreatedDualCopy');
    logPush(cancelMessage, '', true);
    return {
      success: false,
      log,
      logText: cancelMessage,
      dualCopyGuaranteeFailed: true
    };
  }
} // ✅

// ==========================================
// 🗂️ Step 4: Apply Auto-Folder Logic (Optional)
// ==========================================

let baseDestFolder = destination;
reportPrimaryDestination = baseDestFolder;

if (autoFolder) {
  const now = new Date();
  const localDate = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}_${String(now.getDate()).padStart(2, '0')}`;
  const localTime = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const baseFolderName = `Ingest_${localDate}_${localTime}`;
  let resolvedFolderName = baseFolderName;
  let suffix = 1;

  while (await pathExists(path.join(destination, resolvedFolderName))) {
    resolvedFolderName = `${baseFolderName}_${suffix}`;
    suffix += 1;
  }

  baseDestFolder = path.join(destination, resolvedFolderName);
  reportPrimaryDestination = baseDestFolder;
}

// ==========================================
// 🧼 Step 5: Filter by Include/Exclude Extensions
// ==========================================

const rawCount = files.length;
files = files.filter(({ fullPath }) => {
  const baseName = path.basename(fullPath).toLowerCase();
  // Exclude internal marker files that should never be ingested
  if (baseName.endsWith('.done') || baseName.endsWith('.doneflag')) return false;
  const ext = path.extname(fullPath).toLowerCase();
  if (filters.include.length && !filters.include.includes(ext)) return false;
  if (filters.exclude.includes(ext)) return false;
  return true;
});
const filteredCount = files.length;
reportEligibleFileCount = filteredCount;
logPush(ingestMessage('ingest.log.extensionFiltersApplied', { rawCount, filteredCount }));
if (filteredCount === 0) {
  logPush(ingestMessage('ingest.log.noFilesAfterFilters'));
}

filesToCopy = [];
for (const file of files) {
  const relPath = resolveCopyRelativePath(file, { flattenStructure, sourceFolderRootName });
  const destPath = path.join(baseDestFolder, relPath);
  const backupDestPath = backup && backupPath
    ? path.join(backupPath, relPath)
    : null;
  const destExists = await pathExists(destPath);
  const backupExists = backupDestPath ? await pathExists(backupDestPath) : false;
  if (skipDuplicates && destExists && backupDestPath && !backupExists) {
    logPush(ingestMessage('ingest.log.destExistsBackupMissingRecopy', { relPath }));
  }
  if (byteMatch && destExists && (!backupDestPath || backupExists)) {
    try {
      const isIdentical = await compareFilesByteByByte(file.fullPath, destPath, { signal: config.signal });
      if (isIdentical) {
        logPush(ingestMessage('ingest.log.byteIdenticalSkipped', { relPath }));
        counters.skipped++;
        skippedFiles.push(relPath);
        continue;
      }
    } catch (err) {
      // If we can't compare either side, fall back to normal copy/verification.
      logPush(ingestMessage('ingest.log.byteCompareCheckFailed', { relPath, error: err.message }));
    }
  }
  filesToCopy.push(file);
}

reportQueuedFileCount = filesToCopy.length;

if (filesToCopy.length === 0) {
  const msg = formatIngestMessage(ingestMessage('ingest.dialog.noFilesFound.message'));
  logPush(ingestMessage('ingest.log.prefixedWarning', { msg }));
  logPush(ingestMessage('ingest.log.noIngestOccurredCancelled'));
  // In Watch Mode, this is normal (hidden/system artifacts like ._ files,
  // or extension filters). Do not treat as a failure.
  if (watchMode && config.watchTriggered) {
    logPush(ingestMessage('ingest.log.watchSkippedNoEligibleFiles'));
    return { success: true, skipped: true, log, logText: getLogText(), jobId: config.jobId };
  }
  await showIngestDialog(dialogParentWindow, ingestDialogPayload({
    type: 'warning',
    title: ingestMessage('ingest.dialog.noFilesFound.title'),
    message: ingestMessage('ingest.dialog.noFilesFound.message'),
    buttons: [ingestMessage('ingest.dialog.button.ok')]
  }));
  return { success: false, log, logText: getLogText() };
}

// ==========================================
// 🧩 Step 5.2: Disambiguate Flattened Filenames
// ==========================================

if (flattenStructure && filesToCopy.length > 1) {
  const baseRelByFile = new Map();
  const byName = new Map();

  for (const file of filesToCopy) {
    const baseRel = resolveCopyRelativePath(file, { flattenStructure, sourceFolderRootName });
    baseRelByFile.set(file, baseRel);
    const key = baseRel.toLowerCase();
    const group = byName.get(key) || [];
    group.push(file);
    byName.set(key, group);
  }

  const collisionGroups = [];
  const collidingFiles = new Set();
  for (const group of byName.values()) {
    if (group.length <= 1) continue;
    collisionGroups.push(group);
    for (const file of group) {
      collidingFiles.add(file);
    }
  }

  if (collisionGroups.length > 0) {
    const usedRelPaths = new Set();
    for (const file of filesToCopy) {
      if (collidingFiles.has(file)) continue;
      usedRelPaths.add(String(baseRelByFile.get(file)).toLowerCase());
    }

    const warningLines = [
      `⚠️ Flatten Structure detected ${collisionGroups.length} filename collision(s).`,
      'Auto-disambiguation applied to prevent overwrites:'
    ];

    const sourceRootPath = config.source ? resolvePathSafe(config.source) : null;

    for (const group of collisionGroups) {
      const baseRel = baseRelByFile.get(group[0]);
      let chosenStrategy = null;
      const parentSegmentsByFile = new Map();
      let maxDepth = 0;

      for (const file of group) {
        const stopPath =
          sourceRootPath && isPathInside(sourceRootPath, file.fullPath)
            ? sourceRootPath
            : null;
        const parentSegments = getParentSegments(file.fullPath, stopPath);
        parentSegmentsByFile.set(file, parentSegments);
        maxDepth = Math.max(maxDepth, parentSegments.length);
      }

      for (let depth = 1; depth <= maxDepth; depth += 1) {
        const candidateMap = new Map();
        const candidateKeys = new Set();
        let valid = true;

        for (const file of group) {
          const parentSegments = parentSegmentsByFile.get(file);
          if (parentSegments.length < depth) {
            valid = false;
            break;
          }
          const candidate = buildParentPrefixedRelPath(
            file,
            { sourceFolderRootName },
            depth,
            parentSegments
          );
          const candidateKey = candidate.toLowerCase();
          if (candidateKeys.has(candidateKey) || usedRelPaths.has(candidateKey)) {
            valid = false;
            break;
          }
          candidateKeys.add(candidateKey);
          candidateMap.set(file, candidate);
        }

        if (valid) {
          chosenStrategy = { label: 'parent folder prefix', candidates: candidateMap };
          break;
        }
      }

      if (!chosenStrategy) {
        const candidateMap = new Map();
        const ordered = [...group].sort((a, b) => a.fullPath.localeCompare(b.fullPath));
        for (const file of ordered) {
          const base = baseRelByFile.get(file);
          let suffixIndex = 1;
          let candidate = null;
          do {
            const suffix = `_${String(suffixIndex).padStart(2, '0')}`;
            candidate = buildSuffixedRelPath(base, suffix);
            suffixIndex += 1;
          } while (usedRelPaths.has(candidate.toLowerCase()));
          candidateMap.set(file, candidate);
          usedRelPaths.add(candidate.toLowerCase());
        }
        chosenStrategy = { label: 'numeric suffix', candidates: candidateMap };
      }

      warningLines.push(`- ${baseRel}: ${chosenStrategy.label}`);
      for (const [file, candidate] of chosenStrategy.candidates.entries()) {
        file.resolvedRelativePath = candidate;
        usedRelPaths.add(candidate.toLowerCase());
        warningLines.push(`  • ${file.fullPath} → ${candidate}`);
      }
    }

    logPush(warningLines.join('\n'));
  }
}

// ==========================================
// 🧨 Step 5.25: Fail Fast on Collisions
// ==========================================
// When flattenStructure is enabled, multiple files with the same basename would map to the same
// destination path. When ingesting multiple selected items, relative paths can also collide.
const shouldCheckCollisions = filesToCopy.length > 1;

if (shouldCheckCollisions) {
  // Use a case-insensitive key to avoid data loss on common case-insensitive filesystems
  // (exFAT/NTFS/default macOS). This is intentionally conservative for safety.
  const byName = new Map();
  for (const f of filesToCopy) {
    const resolvedRelPath = resolveCopyRelativePath(f, { flattenStructure, sourceFolderRootName });
    const key = resolvedRelPath.toLowerCase();
    const entry = byName.get(key) || { names: new Set(), sources: new Set() };
    entry.names.add(resolvedRelPath);
    entry.sources.add(f.fullPath);
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
    for (const c of collisions.slice(0, maxCollisionsToShow)) {
      const displayName = c.names.length === 1
        ? c.names[0]
        : `${c.names[0]} (case variants: ${c.names.slice(1).join(', ')})`;

      lines.push(displayName);
      for (const p of c.sources.slice(0, maxPathsPerCollision)) {
        lines.push(`  • ${p}`);
      }
      if (c.sources.length > maxPathsPerCollision) {
        lines.push(`  • …and ${c.sources.length - maxPathsPerCollision} more`);
      }
      lines.push('');
    }
    if (collisions.length > maxCollisionsToShow) {
      lines.push(`…and ${collisions.length - maxCollisionsToShow} more collision(s)`);
    }

    const heading = flattenStructure
      ? `Flatten Structure is enabled, but ${collisions.length} filename collision(s) were found.`
      : `Multiple selected items resolve to the same destination path (${collisions.length} collision(s)).`;
    const detail = flattenStructure
      ? 'When flattening, files with the same name would overwrite or be skipped.'
      : 'Selected files resolve to identical relative paths and would overwrite or be skipped.';
    const guidance = flattenStructure
      ? 'Disable Flatten Structure or rename files so each filename is unique.'
      : 'Rename files or adjust selections so each destination path is unique.';

    const msg =
      `${heading}\n\n` +
      `${detail}\n\n` +
      `${guidance}\n\n` +
      `Collisions (examples):\n\n${lines.join('\n')}`;

    logPush(ingestMessage('ingest.log.filenameCollisionsCancelled'), '', true);
    logPush(msg, '', true);
    if (!isWatchTriggered) {
      await showIngestDialog(dialogParentWindow, ingestDialogPayload({
        type: 'error',
        title: ingestMessage('ingest.dialog.collision.title'),
        message: ingestMessage('ingest.dialog.collision.message', { detail: msg }),
        buttons: [ingestMessage('ingest.dialog.button.ok')]
      }));
    }
    return { success: false, log, logText: getLogText() };
  }
}

// ==========================================
// 📁 Step 5.4: Create Destination Folders
// ==========================================

if (autoFolder) {
  await fsp.mkdir(baseDestFolder, { recursive: true });
  logPush(ingestMessage('ingest.log.autoFolderResolved', { baseDestFolder }));
}

// Create directory structure before copying files
if (!flattenStructure) {
  const uniqueDirs = Array.from(new Set(directories.map(d => d.relativePath)));
  uniqueDirs.sort();
  for (const rel of uniqueDirs) {
    const destDir = path.join(baseDestFolder, rel);
    try { await fsp.mkdir(destDir, { recursive: true }); } catch { /* ignore */ }
    if (backup && backupPath) {
      try { await fsp.mkdir(path.join(backupPath, rel), { recursive: true }); } catch { /* ignore */ }
    }
  }
}

// ==========================================
// 📊 Progress Manager Setup (after filesToCopy populated)
// ==========================================

for (const file of filesToCopy) {
  try {
    const size = fileSizeMap.get(file.fullPath) || 0;
    destBytesToCopy += size;
    if (backup && backupPath) backupBytesToCopy += size;
  } catch {
    continue;
  }
}

totalBytesToCopy = destBytesToCopy + backupBytesToCopy;

progressManager = new ProgressManager(totalBytesToCopy, 250, 'bytes');
progressManager.setTotalFiles(filesToCopy.length);
const backupClause = backup && backupPath
  ? `, backup ${formatBytesDecimal(backupBytesToCopy)}`
  : '';
logPush(ingestMessage('ingest.log.workload', {
  count: filesToCopy.length,
  destSize: formatBytesDecimal(destBytesToCopy),
  backupClause
}));

// ==========================================
// 🗄️ Step 5.5: Validate Available Disk Space
// ==========================================

const diskSpacePath =
  autoFolder && !await pathExists(baseDestFolder)
    ? destination
    : baseDestFolder;
const destFree = await getFreeDiskSpace(diskSpacePath);
const headroomFactor = 0.1;
const destBytesWithHeadroom = Math.ceil(destBytesToCopy * (1 + headroomFactor));
const backupBytesWithHeadroom = Math.ceil(backupBytesToCopy * (1 + headroomFactor));
if (destFree === null) {
  const msg = ingestMessage('ingest.log.diskSpacePreflightSkipped');
  logPush(msg);
  if (!isWatchTriggered) {
    const { response } = await showIngestDialog(dialogParentWindow, ingestDialogPayload({
      type: 'warning',
      title: ingestMessage('ingest.dialog.diskSpaceCheckSkipped.title'),
      message: ingestMessage('ingest.dialog.diskSpaceCheckSkipped.message', { reason: msg }),
      buttons: [
        ingestMessage('ingest.dialog.button.continue'),
        ingestMessage('ingest.dialog.button.cancel')
      ],
      defaultId: 0,
      cancelId: 1
    }));
    if (response === 1) {
      const cancelMessage = ingestMessage('ingest.log.diskSpaceUndeterminedCancelled');
      logPush(cancelMessage, '', true);
      return { success: false, log, logText: getLogText() };
    }
  }
} else if (destFree < destBytesWithHeadroom) {
  const msg = `Not enough space on destination drive. Required ${formatBytesDecimal(destBytesToCopy)} (raw), ${formatBytesDecimal(destBytesWithHeadroom)} (incl 10% headroom), available ${formatBytesDecimal(destFree)}`;
  logPush(ingestMessage('ingest.log.prefixedError', { msg }), '', true);
  if (!isWatchTriggered) {
    await showIngestDialog(dialogParentWindow, ingestDialogPayload({
      type: 'error',
      title: ingestMessage('ingest.dialog.insufficientDiskSpace.title'),
      message: ingestMessage('ingest.dialog.insufficientDiskSpace.message', { detail: msg })
    }));
  }
  return { success: false, log, logText: getLogText() };
}

if (backup && backupPath) {
  const backupFree = await getFreeDiskSpace(backupPath);
  if (backupFree === null) {
    const msg = ingestMessage('ingest.log.backupDiskSpacePreflightSkipped');
    logPush(msg);
    if (!isWatchTriggered) {
      const { response } = await showIngestDialog(dialogParentWindow, ingestDialogPayload({
        type: 'warning',
        title: ingestMessage('ingest.dialog.backupDiskSpaceCheckSkipped.title'),
        message: ingestMessage('ingest.dialog.backupDiskSpaceCheckSkipped.message', { reason: msg }),
        buttons: [
          ingestMessage('ingest.dialog.button.continue'),
          ingestMessage('ingest.dialog.button.cancel')
        ],
        defaultId: 0,
        cancelId: 1
      }));
      if (response === 1) {
        const cancelMessage = ingestMessage('ingest.log.backupDiskSpaceUndeterminedCancelled');
        logPush(cancelMessage, '', true);
        return { success: false, log, logText: getLogText() };
      }
    }
  } else if (backupFree < backupBytesWithHeadroom) {
    const msg = `Not enough space on backup drive. Required ${formatBytesDecimal(backupBytesToCopy)} (raw), ${formatBytesDecimal(backupBytesWithHeadroom)} (incl 10% headroom), available ${formatBytesDecimal(backupFree)}`;
    logPush(ingestMessage('ingest.log.prefixedError', { msg }), '', true);
    if (!isWatchTriggered) {
      await showIngestDialog(dialogParentWindow, ingestDialogPayload({
        type: 'error',
        title: ingestMessage('ingest.dialog.insufficientBackupSpace.title'),
        message: ingestMessage('ingest.dialog.insufficientBackupSpace.message', { detail: msg })
      }));
    }
    return { success: false, log, logText: getLogText() };
  }
}

progressManager.on('stream-progress', payload => {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  // Progress updates are routed exclusively through the queue manager
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'ingest',
      file: payload.file,
      percent: payload.overall,
      filePercent: payload.percent,
      eta: payload.eta,
      completed: payload.completedFiles,
      total: payload.totalFiles,
      streamId: payload.streamId
    });
  }
});

progressManager.on('overall-progress', payload => {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  // Deprecated: 'ingest-progress' event removed; use 'job-progress' instead
  if (global.queue) {
    global.queue.emit('job-progress', {
      id: config.jobId,
      panel: 'ingest',
      file: payload.overall === 100 ? '' : '',
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
      panel: 'ingest',
      file: payload.file,
      status: { ...payload.statusMap },
      streamId: payload.streamId
    });
  }
});

// ==========================================
// 🛠 Step 6: Build File Copy Tasks
// ==========================================

const tasks = [];

// Logging policy:
// - Saved log file: show per-file success only for small jobs.
// - Always show per-file errors.
// - For large jobs, rely on summary + failures list.
const smallJob = (filesToCopy && filesToCopy.length <= 25);
let skipLogSamples = 0;
const SKIP_LOG_SAMPLE_MAX = 10;

function buildCopyTask(file) {
  file.statusMap = {
    copied: false,
    backedUp: false,
    checksummed: false,
    cached: false
  };
  return async (streamId) => {
    if (config.signal?.aborted) {
      logPush(ingestMessage('ingest.log.cancelledDuringFile', { relativePath: file.relativePath }));
      return;
    }

    const { fullPath: srcPath } = file;

    const relPath = resolveCopyRelativePath(file, { flattenStructure, sourceFolderRootName });

    const finalDestPath = path.join(baseDestFolder, relPath);
    const tempDestPath = `${finalDestPath}.partial`;
    const finalBackupPath = backup && backupPath
      ? path.join(backupPath, relPath)
      : null;
    let originalSize = fileSizeMap.get(srcPath);
    if (originalSize == null) {
      try {
        originalSize = (await fsp.stat(srcPath)).size;
      } catch (err) {
        logPush(ingestMessage('ingest.log.statSourceSizeFailed', { relPath, error: err.message }));
        originalSize = 0;
      }
    }

    const computeSelectedHash = async filePath => {
      if (checksumMethod === 'blake3') {
        const { hash, method } = await getBlake3Hash(filePath, { signal: config.signal });
        return { hash, method };
      }

      const hashResults = await getHashes(filePath, {
        useSha256: checksumMethod === 'sha256',
        useMd5: checksumMethod === 'md5',
        useBlake3: checksumMethod === 'blake3',
        useXxhash64: checksumMethod === 'xxhash64'
      }, { signal: config.signal });

      const result = hashResults[checksumMethod] || {};
      return { hash: result.hash || null, method: result.method };
    };

    // 🔍 Compute BLAKE3 early ONLY when needed (performance)
    // Needed when:
    //   - skipDuplicates is enabled (hash-based dedupe)
    //   - verification is enabled AND method is blake3 (reuse the source hash)
    const shouldPreHash = (skipDuplicates === true) || (verify && checksumMethod === 'blake3');

    let computedHash = null;
    if (shouldPreHash) {
      try {
        ({ hash: computedHash } = await getBlake3Hash(srcPath, { signal: config.signal }));
      } catch (err) {
        if (config.signal?.aborted) throw err;
        computedHash = null;
      }
    }

    let srcHash = null;
    if (verify && checksumMethod !== 'none') {
      try {
        if (checksumMethod === 'blake3') {
          if (computedHash) {
            srcHash = computedHash;
          } else {
            ({ hash: srcHash } = await getBlake3Hash(srcPath, { signal: config.signal }));
          }
        } else {
          const srcHashes = await getHashes(srcPath, {
            useSha256: checksumMethod === 'sha256',
            useMd5: checksumMethod === 'md5',
            useBlake3: checksumMethod === 'blake3',
            useXxhash64: checksumMethod === 'xxhash64'
          }, { signal: config.signal });
          srcHash = srcHashes[checksumMethod]?.hash || null;
        }
      } catch (err) {
        if (config.signal?.aborted) throw err;
        srcHash = null;
      }
    }

    const destExists = await pathExists(finalDestPath);
    const backupExists = finalBackupPath ? await pathExists(finalBackupPath) : false;
    const targetExists = destExists && (!finalBackupPath || backupExists);
    const verificationEnabled = Boolean(byteMatch || (verify && checksumMethod !== 'none'));

    const hashSeenBefore = computedHash ? isDuplicate(hashCache, computedHash) : false;

    if (DEBUG_HASH && computedHash) {
      logPush(ingestMessage('ingest.log.hashPreviouslySeen', { computedHash, hashSeenBefore, targetExists }));
    }

    let skipDuplicateSourceHash = null;
    if (skipDuplicates && checksumMethod !== 'none' && checksumMethod !== 'blake3') {
      try {
        ({ hash: skipDuplicateSourceHash } = await computeSelectedHash(srcPath));
      } catch (err) {
        if (config.signal?.aborted) throw err;
        logPush(ingestMessage('ingest.log.computeSourceHashFailed', { checksumMethod, relPath, error: err.message }));
      }
    }

    if (skipDuplicates && targetExists) {
      let destMatches = false;
      let backupMatches = !finalBackupPath;
      let verifiedDuplicate = false;
      let ___duplicateMethod = null;
      let ___destHashForLog = null;
      let ___backupHashForLog = null;
      let ___destElapsedMs = null;
      let ___backupElapsedMs = null;

      if (computedHash) {
        ___duplicateMethod = 'blake3';
        try {
          const t0 = Date.now();
          const { hash: destHash } = await getBlake3Hash(finalDestPath, { signal: config.signal });
          ___destElapsedMs = Date.now() - t0;
          ___destHashForLog = destHash || null;
          destMatches = destHash && destHash === computedHash;
        } catch (err) {
        if (config.signal?.aborted) throw err;
          logPush(ingestMessage('ingest.log.verifyDestinationHashFailed', { relPath, error: err.message }));
        }

        if (finalBackupPath) {
          try {
            const t0 = Date.now();
            const { hash: backupHash } = await getBlake3Hash(finalBackupPath, { signal: config.signal });
            ___backupElapsedMs = Date.now() - t0;
            ___backupHashForLog = backupHash || null;
            backupMatches = backupHash && backupHash === computedHash;
          } catch (err) {
        if (config.signal?.aborted) throw err;
            logPush(ingestMessage('ingest.log.verifyBackupHashFailed', { relPath, error: err.message }));
          }
        }

        verifiedDuplicate = destMatches && backupMatches;
      } else if (checksumMethod === 'none') {
        ___duplicateMethod = 'byte-compare';
        try {
          const t0 = Date.now();
          destMatches = await compareFilesByteByByte(srcPath, finalDestPath, { signal: config.signal });
          ___destElapsedMs = Date.now() - t0;
        } catch (err) {
        if (config.signal?.aborted) throw err;
          logPush(ingestMessage('ingest.log.byteCompareCheckFailed', { relPath, error: err.message }));
        }

        if (finalBackupPath) {
          try {
            const t0 = Date.now();
            backupMatches = await compareFilesByteByByte(srcPath, finalBackupPath, { signal: config.signal });
            ___backupElapsedMs = Date.now() - t0;
          } catch (err) {
        if (config.signal?.aborted) throw err;
            logPush(ingestMessage('ingest.log.byteCompareBackupFailed', { relPath, error: err.message }));
          }
        }

        verifiedDuplicate = destMatches && backupMatches;
      } else if (skipDuplicateSourceHash) {
        ___duplicateMethod = String(checksumMethod || 'checksum');
        try {
          const t0 = Date.now();
          const { hash: destHash } = await computeSelectedHash(finalDestPath);
          ___destElapsedMs = Date.now() - t0;
          ___destHashForLog = destHash || null;
          destMatches = destHash && destHash === skipDuplicateSourceHash;
        } catch (err) {
        if (config.signal?.aborted) throw err;
          logPush(ingestMessage('ingest.log.verifyDestinationMethodHashFailed', { checksumMethod, relPath, error: err.message }));
        }

        if (finalBackupPath) {
          try {
            const t0 = Date.now();
            const { hash: backupHash } = await computeSelectedHash(finalBackupPath);
            ___backupElapsedMs = Date.now() - t0;
            ___backupHashForLog = backupHash || null;
            backupMatches = backupHash && backupHash === skipDuplicateSourceHash;
          } catch (err) {
        if (config.signal?.aborted) throw err;
            logPush(ingestMessage('ingest.log.verifyBackupMethodHashFailed', { checksumMethod, relPath, error: err.message }));
          }
        }

        verifiedDuplicate = destMatches && backupMatches;
      }

      if (verifiedDuplicate) {
        if (smallJob || skipLogSamples < SKIP_LOG_SAMPLE_MAX) {
          const methodLabel = checksumMethod ? ` via ${checksumMethod}` : '';
          logPush(ingestMessage('ingest.log.duplicateContentSkippedVerified', { methodLabel, relPath }));
          skipLogSamples += 1;
        }

        counters.skipped++;
        skippedFiles.push(relPath);
        progressManager.adjustTotal(-originalSize);
        if (finalBackupPath) progressManager.adjustTotal(-originalSize);

        // Mark processed for watch-mode so the same source doesn't re-queue
        // (e.g., volume remount) without touching source media.
        markWatchProcessed(srcPath, { relPath, result: 'skipped-duplicate-verified' });
        return;
      }

      if (destMatches === false || backupMatches === false) {
        logPush(ingestMessage('ingest.log.existingContentDifferedRecopy', { relPath }));
      }
    }

    if (byteMatch && destExists && (!finalBackupPath || backupExists)) {
      try {
        const isIdentical = await compareFilesByteByByte(srcPath, finalDestPath, { signal: config.signal });
        if (isIdentical) {
          counters.skipped++;
          skippedFiles.push(relPath);
          progressManager.adjustTotal(-originalSize);
          if (finalBackupPath) progressManager.adjustTotal(-originalSize);

          markWatchProcessed(srcPath, { relPath, result: 'skipped-byte-identical' });
          return;
        }
      } catch (err) {
        if (config.signal?.aborted) throw err;
        // If we can't compare either side, fall back to normal copy/verification.
        logPush(ingestMessage('ingest.log.byteCompareCheckFailed', { relPath, error: err.message }));
      }
    }

    // Track verification requirements for summary logs.
    // Only count files that will actually be copied (i.e., not skipped).
    if (verificationEnabled) {
      counters.verifyDestRequired += 1;
      if (finalBackupPath) counters.verifyBackupRequired += 1;
    }

    // Helper: emit per-file status without duplicating boilerplate
    const emitStatus = () => {
      if (!global.queue) return;
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'ingest',
        file: relPath,
        status: { ...file.statusMap }
      });
    };

    const safeUnlink = async p => {
      if (!p) return;
      await fs.promises.unlink(p).catch(() => {});
    };
    const createRollbackPath = targetPath => {
      const safeJobId = String(config.jobId || 'job').replace(/[^a-zA-Z0-9_-]/g, '_');
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      return `${targetPath}.preexisting.${safeJobId}.${stamp}`;
    };
    const moveExistingToRollback = async (targetPath, label) => {
      if (!targetPath || !await pathExists(targetPath)) return null;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const rollbackPath = createRollbackPath(targetPath);
        try {
          await fs.promises.rename(targetPath, rollbackPath);
          logPush(ingestMessage('ingest.log.rollbackMovedAside', { label, rollbackName: path.basename(rollbackPath) }));
          return rollbackPath;
        } catch (err) {
          if (err.code === 'ENOENT') return null;
          if (err.code === 'EEXIST') continue;
          throw err;
        }
      }

      throw createIngestError('ingest.error.rollbackPathUnavailable', { label });
    };
    const cleanupRollback = async (rollbackPath, label) => {
      if (!rollbackPath) return;
      try {
        await fs.promises.unlink(rollbackPath);
      } catch (err) {
        logPush(ingestMessage('ingest.log.rollbackRemoveFailed', { label, relPath, error: err.message }));
      }
    };
    const restoreRollback = async (rollbackPath, targetPath, label) => {
      if (!rollbackPath) return true;

      await safeUnlink(targetPath);

      try {
        await fs.promises.rename(rollbackPath, targetPath);
        logPush(ingestMessage('ingest.log.rollbackRestoredAfterFailure', { label, relPath }));
        return true;
      } catch (err) {
        logPush(ingestMessage('ingest.log.rollbackRestoreFailed', { label, relPath, error: err.message }), '', true);
        return false;
      }
    };
    const replaceTempWithRollbackSafeRename = async (tempPath, finalPath, label, getRollbackPath, setRollbackPath) => {
      let rollbackPath = await getRollbackPath();
      if (rollbackPath) setRollbackPath(rollbackPath);

      try {
        await fs.promises.rename(tempPath, finalPath);
      } catch (renameErr) {
        if (renameErr.code === 'EXDEV') {
          await fs.promises.copyFile(tempPath, finalPath);
          await fs.promises.unlink(tempPath).catch(() => {});
          return;
        }

        if (process.platform === 'win32' && (renameErr.code === 'EEXIST' || renameErr.code === 'EPERM')) {
          rollbackPath = rollbackPath || await moveExistingToRollback(finalPath, label);
          if (rollbackPath) setRollbackPath(rollbackPath);

          try {
            await fs.promises.rename(tempPath, finalPath);
          } catch (retryErr) {
            if (retryErr.code === 'EXDEV') {
              await fs.promises.copyFile(tempPath, finalPath);
              await fs.promises.unlink(tempPath).catch(() => {});
              return;
            }
            throw retryErr;
          }
          return;
        }

        await fs.promises.unlink(tempPath).catch(() => {});
        throw renameErr;
      }
    };
    let sourceStatCache = null;
    let sourceStatError = null;
    const getSourceStat = async () => {
      if (sourceStatCache || sourceStatError) return sourceStatCache;
      try {
        sourceStatCache = await fsp.stat(srcPath);
      } catch (err) {
        sourceStatError = err;
        logPush(ingestMessage('ingest.log.readSourceTimestampsFailed', { relPath, error: err.message }));
      }
      return sourceStatCache;
    };
    const applySourceTimestamps = async (targetPath, label) => {
      const srcStat = await getSourceStat();
      if (!srcStat) return;
      try {
        await fsp.utimes(targetPath, srcStat.atime, srcStat.mtime);
      } catch (err) {
        const targetLabel = label ? `${label} ` : '';
        logPush(ingestMessage('ingest.log.preserveTimestampsFailed', { targetLabel, relPath, error: err.message }));
      }
    };

    let started = false;
    let destVerified = false;   // dest is safe to keep
    let backupVerified = false; // backup is safe to keep (only meaningful when enabled)
    let destRollbackPath = null;
    let backupRollbackPath = null;

    try {
      // Progress is byte-based across all work triggered by this file.
      // With Dual Copy enabled, each file is copied twice (dest + backup).
      const progressSize = originalSize * (finalBackupPath ? 2 : 1);
      progressManager.startFile(streamId, srcPath, progressSize);
      started = true;

      // ===============================
      // 1) Copy src → dest
      // ===============================
      try {
        await copyFileWithProgress(
          srcPath,
          tempDestPath,
          (_percent, chunkSize) => {
            if (config.signal?.aborted) throw createIngestError('ingest.error.copyCancelled');
            progressManager.updateStream(streamId, chunkSize);
          },
          config.signal
        );

        // best-effort fsync to reduce "looks copied" but not flushed risks
        try {
          const fd = await fs.promises.open(tempDestPath, 'r');
          await fd.sync();
          await fd.close();
        } catch {
          /* best effort */
        }

        await replaceTempWithRollbackSafeRename(
          tempDestPath,
          finalDestPath,
          'destination file',
          async () => moveExistingToRollback(finalDestPath, 'destination file'),
          rollbackPath => {
            if (!destRollbackPath) destRollbackPath = rollbackPath;
          }
        );

        await applySourceTimestamps(finalDestPath, 'destination');
      } catch (copyErr) {
        await fs.promises.unlink(tempDestPath).catch(() => {});
        throw copyErr;
      }

      file.statusMap.copied = true;
      emitStatus();


      // ===============================
      // 2) Verify dest according to user choice
      // ===============================
      if (byteMatch) {
        const t0 = Date.now();
        const isIdentical = await compareFilesByteByByte(srcPath, finalDestPath, { signal: config.signal });
        const elapsedMs = Date.now() - t0;
        logPush(
          ingestMessage('ingest.log.verifyDest.byteCompare', {
            status: isIdentical ? '✅' : '❌',
            relPath,
            byteSize: Number.isFinite(originalSize) ? originalSize : 'unknown',
            elapsedMs
          }),
          '',
          !isIdentical,
          relPath
        );
        if (!isIdentical) {
          await safeUnlink(finalDestPath);
          file.statusMap.copied = false;
          throw createIngestError('ingest.error.byteMismatchDest');
        }

        destVerified = true;
      } else if (verify && checksumMethod !== 'none') {
        if (config.signal?.aborted) throw createIngestError('ingest.error.cancelledBeforeChecksum');

        // Ensure we have a source hash. If early pre-hash failed, compute it now.
        if (!srcHash) {
          const { hash: recomputedSrcHash } = await computeSelectedHash(srcPath);
          srcHash = recomputedSrcHash;
        }

        if (!srcHash) {
          logPush(
            ingestMessage('ingest.log.verifyDest.hash.missing', {
              status: '❌',
              checksumMethod,
              relPath,
              srcHash: '(missing)',
              destHash: '(missing)',
              elapsedMs: 'n/a'
            }),
            '',
            true,
            relPath
          );
          await safeUnlink(finalDestPath);
          file.statusMap.copied = false;
          throw createIngestError('ingest.error.sourceChecksumUnavailableComparison', { checksumMethod });
        }

        const t0 = Date.now();
        const { hash: destHash } = await computeSelectedHash(finalDestPath);
        const elapsedMs = Date.now() - t0;

        if (!destHash) {
          logPush(
            ingestMessage('ingest.log.verifyDest.hash.missing', {
              status: '❌',
              checksumMethod,
              relPath,
              srcHash,
              destHash: '(missing)',
              elapsedMs
            }),
            '',
            true,
            relPath
          );
          await safeUnlink(finalDestPath);
          file.statusMap.copied = false;
          throw createIngestError('ingest.error.destinationChecksumUnavailable', { checksumMethod });
        }

        if (srcHash !== destHash) {
          logPush(
            ingestMessage('ingest.log.verifyDest.hash.ok', {
              status: '❌',
              checksumMethod,
              relPath,
              srcHash,
              destHash,
              elapsedMs
            }),
            '',
            true,
            relPath
          );
          await safeUnlink(finalDestPath);
          file.statusMap.copied = false;
          throw createIngestError('ingest.error.checksumMismatchDest');
        }

        logPush(
          ingestMessage('ingest.log.verifyDest.hash.ok', {
            status: '✅',
            checksumMethod,
            relPath,
            srcHash,
            destHash,
            elapsedMs
          }),
          '',
          false,
          relPath
        );
        destVerified = true;
      } else {
        // Verification disabled / method none

        destVerified = true;
      }

      if (destVerified && destRollbackPath) {
        await cleanupRollback(destRollbackPath, 'destination');
        destRollbackPath = null;
      }

      // ===============================
      // 3) Only if dest verification passes: src → backup
      // ===============================
      if (finalBackupPath) {
        if (config.signal?.aborted) throw createIngestError('ingest.error.cancelledBeforeBackup');

        await queueBackup(file, async () => {
          const tempBackupPath = `${finalBackupPath}.partial`;

          try {
            await copyFileWithProgress(
              srcPath,
              tempBackupPath,
              (_percent, chunkSize) => {
                if (config.signal?.aborted) throw createIngestError('ingest.error.backupCopyCancelled');
                progressManager.updateStream(streamId, chunkSize);
              },
              config.signal
            );

            try {
              const fd = await fs.promises.open(tempBackupPath, 'r');
              await fd.sync();
              await fd.close();
            } catch {
              /* best effort */
            }

            await replaceTempWithRollbackSafeRename(
              tempBackupPath,
              finalBackupPath,
              'backup file',
              async () => moveExistingToRollback(finalBackupPath, 'backup file'),
              rollbackPath => {
                if (!backupRollbackPath) backupRollbackPath = rollbackPath;
              }
            );

            await applySourceTimestamps(finalBackupPath, 'backup');
          } catch (copyErr) {
            await fs.promises.unlink(tempBackupPath).catch(() => {});
            throw copyErr;
          }
        });

        // ===============================
        // 4) Verify backup according to user choice
        // ===============================
        if (byteMatch) {
          const t0 = Date.now();
          const isIdentical = await compareFilesByteByByte(finalDestPath, finalBackupPath, { signal: config.signal });
          const elapsedMs = Date.now() - t0;
          logPush(
            ingestMessage('ingest.log.verifyBackup.byteCompare', {
              status: isIdentical ? '✅' : '❌',
              relPath,
              byteSize: Number.isFinite(originalSize) ? originalSize : 'unknown',
              elapsedMs
            }),
            '',
            !isIdentical,
            relPath
          );
          if (!isIdentical) {
            await safeUnlink(finalBackupPath);
            throw createIngestError('ingest.error.byteMismatchBackup');
          }

          backupVerified = true;
        } else if (verify && checksumMethod !== 'none') {
          if (!srcHash) {
            const { hash: recomputedSrcHash } = await computeSelectedHash(srcPath);
            srcHash = recomputedSrcHash;
          }

          if (!srcHash) {
            logPush(
              ingestMessage('ingest.log.verifyBackup.hash.missing', {
                status: '❌',
                checksumMethod,
                relPath,
                srcHash: '(missing)',
                backupHash: '(missing)',
                elapsedMs: 'n/a'
              }),
              '',
              true,
              relPath
            );
            await safeUnlink(finalBackupPath);
            throw createIngestError('ingest.error.sourceChecksumUnavailableBackupComparison', { checksumMethod });
          }

          const t0 = Date.now();
          const { hash: backupHash } = await computeSelectedHash(finalBackupPath);
          const elapsedMs = Date.now() - t0;

          if (!backupHash) {
            logPush(
              ingestMessage('ingest.log.verifyBackup.hash.missing', {
                status: '❌',
                checksumMethod,
                relPath,
                srcHash,
                backupHash: '(missing)',
                elapsedMs
              }),
              '',
              true,
              relPath
            );
            await safeUnlink(finalBackupPath);
            throw createIngestError('ingest.error.backupChecksumUnavailable', { checksumMethod });
          }

          if (srcHash !== backupHash) {
            logPush(
              ingestMessage('ingest.log.verifyBackup.hash.ok', {
                status: '❌',
                checksumMethod,
                relPath,
                srcHash,
                backupHash,
                elapsedMs
              }),
              '',
              true,
              relPath
            );
            await safeUnlink(finalBackupPath);
            throw createIngestError('ingest.error.checksumMismatchBackup');
          }

          logPush(
            ingestMessage('ingest.log.verifyBackup.hash.ok', {
              status: '✅',
              checksumMethod,
              relPath,
              srcHash,
              backupHash,
              elapsedMs
            }),
            '',
            false,
            relPath
          );
          backupVerified = true;
        } else {
          // Verification disabled / method none

          backupVerified = true;
        }

        if (backupVerified && backupRollbackPath) {
          await cleanupRollback(backupRollbackPath, 'backup');
          backupRollbackPath = null;
        }

        // Mark backup as complete only after it verified cleanly
        file.statusMap.backedUp = true;
        emitStatus();

      } else {
        // no backup requested; treat as satisfied
        backupVerified = true;
      }

      // ===============================
      // 5) Only after all required steps pass
      // ===============================
      file.statusMap.checksummed = true;
      emitStatus();

      if (computedHash && originalSize > 10 * 1024) {
        updateCacheEntry(hashCache, computedHash, relPath);

        file.statusMap.cached = true;
        cacheDirty = true;
        emitStatus();
      }

      clearFailure(relPath);
      if (smallJob) {
        logPush(ingestMessage('ingest.log.fileOk', { relPath }));
        if (finalBackupPath) logPush(ingestMessage('ingest.log.backupOk', { relPath }));
      }

      if (verificationEnabled) {
        counters.verifyDestPassed += 1;
        if (finalBackupPath) counters.verifyBackupPassed += 1;
      }
      counters.success++;
      destPaths.push(finalDestPath);

      markWatchProcessed(srcPath, { relPath, result: 'success' });
    } catch (err) {
      // ==========================================
      // Verification/copy failure handling
      // ==========================================

      // Always clean partials
      await safeUnlink(tempDestPath);
      if (finalBackupPath) await safeUnlink(`${finalBackupPath}.partial`);

      // Remove bad copies (dest and/or backup) as appropriate
      if (finalBackupPath && !backupVerified) {
        await safeUnlink(finalBackupPath);
        if (backupRollbackPath) {
          await restoreRollback(backupRollbackPath, finalBackupPath, 'backup');
          backupRollbackPath = null;
        }
        file.statusMap.backedUp = false;
      }

      if (!destVerified) {
        await safeUnlink(finalDestPath);
        if (destRollbackPath) {
          await restoreRollback(destRollbackPath, finalDestPath, 'destination');
          destRollbackPath = null;
        }
        file.statusMap.copied = false;
      }

      // Do not mark verification/caching stages as completed on failure
      file.statusMap.checksummed = false;
      file.statusMap.cached = false;
      emitStatus();

      if (config.signal?.aborted) {
        return;
      }

      logPush(ingestMessage('ingest.log.errorIngestingFile', { relPath, error: resolveIngestErrorMessage(err) }), '', true);
      recordFailure(relPath);
      return;
    } finally {
      if (started) {
        progressManager.finishFile(streamId, file.statusMap);
      }
    }

    return;
  };
}

for (const file of filesToCopy) {
  tasks.push(buildCopyTask(file));
}

// ==========================================
// 🧠 Step 12: Estimate Disk Speed → Choose Thread Count
// ==========================================

let threadCount;

// ⚡ Auto-tune threading if not set
if (!config.maxThreads || isNaN(config.maxThreads)) {
  try {
    const speed = await estimateDiskWriteSpeed(baseDestFolder);
    logPush(ingestMessage('ingest.log.estimatedWriteSpeed', { speed }));

    threadCount =
      speed < 50  ? 2 :
      speed < 100 ? 3 :
      speed < 200 ? 4 :
                    5;

    logPush(ingestMessage('ingest.log.autoSelectedThreadCount', { threadCount }));

    // Watch Mode: keep Auto Threads conservative to avoid thrashing slower volumes.
    if (watchMode && threadCount > 4) {
      logPush(ingestMessage('ingest.log.watchClampedThreadCount', { threadCount }));
      threadCount = 4;
    }
  } catch (err) {
    threadCount = 3;
    logPush(ingestMessage('ingest.log.diskSpeedCheckFailedDefaulting', {
      codeClause: err?.code ? ` [${err.code}]` : '',
      reason: err?.message || 'unknown error',
      threadCount
    }));
  }
} else {
  threadCount = parseInt(config.maxThreads, 10);
  if (isNaN(threadCount) || threadCount < 1) threadCount = 1;
  logPush(ingestMessage('ingest.log.userDefinedThreadCount', { threadCount }));
}

  // Sync backup queue concurrency with ingest threads
  setConcurrency(threadCount);

if (threadCount === 1) {
   logPush(ingestMessage('ingest.log.singleThreaded'));
 }

// ==========================================
// 🚀 Step 13: Run Tasks with Concurrency
// ==========================================

await runWithConcurrencyLimit(tasks, threadCount, { signal: config.signal });

if (config.signal?.aborted) {
  logPush(ingestMessage('ingest.log.cancelledByUser'));
  if (progressManager?.dispose) progressManager.dispose();
  removeJobFile();
  flushHashCache();
  return {
    success: false,
    log,
    logText: getLogText(),
    cancelled: true
  };
}

// 🔁 Retry failed files if enabled
if (config.retryFailures && failedFiles.size > 0) {
  const fileRelativePaths = new Set(files.map(file => file.relativePath));
  const retryCandidates = Array.from(failedFiles).filter(relPath => fileRelativePaths.has(relPath));
  for (const relPath of retryCandidates) {
    clearFailure(relPath);
  }

  logPush(ingestMessage('ingest.log.retryingFailedFiles', { count: retryCandidates.length }));

  const retryTasks = files
    .filter(f => retryCandidates.includes(f.relativePath))
    .map(buildCopyTask);

  await runWithConcurrencyLimit(retryTasks, threadCount, { signal: config.signal });
  if (config.signal?.aborted) {
    logPush(ingestMessage('ingest.log.cancelledByUser'));
    if (progressManager?.dispose) progressManager.dispose();
    removeJobFile();
    flushHashCache();
    return {
      success: false,
      log,
      logText: getLogText(),
      cancelled: true
    };
  }
  logPush(ingestMessage('ingest.log.retryComplete', { count: failedFiles.size }));
}

// ==========================================
// 📄 Step 14: Save Ingest Log
// ==========================================

const failedFileList = Array.from(failedFiles);
counters.failed = failedFileList.length;
reportStats = {
  scannedFiles: reportDiscoveredFileCount,
  eligibleFiles: reportEligibleFileCount,
  queuedFiles: reportQueuedFileCount,
  copiedFiles: counters.success,
  skippedFiles: counters.skipped,
  failedFiles: counters.failed,
};
if (counters.verifyDestRequired > 0) {
  reportStats.destinationVerified = `${counters.verifyDestPassed}/${counters.verifyDestRequired}`;
}
if (backup && backupPath && counters.verifyBackupRequired > 0) {
  reportStats.backupVerified = `${counters.verifyBackupPassed}/${counters.verifyBackupRequired}`;
}

if (saveLog && !watchMode) {
  const logFileName = `IngestLog_${Date.now()}.txt`;
  const logPath = path.join(baseDestFolder, logFileName);

  try {
    // Ensure the canonical per-job log exists, then copy *that exact text*.
    // This makes the "Save Log" output match the Library ingest TXT 1:1.
    persistJobLogs({ closeLogger: false });

    if (archivePath && await pathExists(archivePath)) {
      await fsp.mkdir(path.dirname(logPath), { recursive: true });
      fs.copyFileSync(archivePath, logPath);
      savedJobReportCopies.add(logPath);
      logPush(ingestMessage('ingest.log.logSaved', { logPath }));
    } else {
      // Fallback (should be rare): write the inline user log.
      writeLogToFile(log, logPath);
      savedJobReportCopies.add(logPath);
      logPush(ingestMessage('ingest.log.logSaved', { logPath }));
    }
  } catch (err) {
    logPush(ingestMessage('ingest.log.writeIngestLogFailed', { error: err.message }));
  }

// ✅ Optionally save log to backup folder
  if (backup && backupPath) {
    const backupLogPath = path.join(backupPath, logFileName);

    try {
      persistJobLogs({ closeLogger: false });

      if (archivePath && await pathExists(archivePath)) {
        await fsp.mkdir(path.dirname(backupLogPath), { recursive: true });
        fs.copyFileSync(archivePath, backupLogPath);
        savedJobReportCopies.add(backupLogPath);
        logPush(ingestMessage('ingest.log.logAlsoSavedToBackup', { backupLogPath }));
      } else {
        writeLogToFile(log, backupLogPath);
        savedJobReportCopies.add(backupLogPath);
        logPush(ingestMessage('ingest.log.logAlsoSavedToBackup', { backupLogPath }));
      }
    } catch (err) {
      logPush(ingestMessage('ingest.log.writeBackupLogFailed', { error: err.message }));
    }
  }

  // 🗂 Step 15: Write Skipped/Failed File Summary (if any)
  if (skippedFiles.length || failedFileList.length) {
    const failureLogPath = path.join(baseDestFolder, `IngestFailures_${Date.now()}.txt`);
    const failureLog = [];
    const skippedFilesHeading = formatIngestMessage(ingestMessage('ingest.failureLog.heading.skippedFiles'));
    const failedFilesHeading = formatIngestMessage(ingestMessage('ingest.failureLog.heading.failedFiles'));

    if (skippedFiles.length) {
      failureLog.push(`${skippedFilesHeading}\n${skippedFiles.join('\n')}\n`);
    }
    if (failedFileList.length) {
      failureLog.push(`${failedFilesHeading}\n${failedFileList.join('\n')}\n`);
    }

    try {
      await fsp.writeFile(failureLogPath, failureLog.join('\n'));
      logPush(ingestMessage('ingest.log.failedSummarySaved', { failureLogPath }));
    } catch (err) {
      logPush(ingestMessage('ingest.log.writeFailedSummaryFailed', { failureLogPath, error: err.message }));
    }
  }

  // 📝 Step 16: Generate Retry List (if any failures)
  if (failedFileList.length) {
    const retryListPath = path.join(baseDestFolder, `RetryList_${Date.now()}.txt`);
    try {
      await fsp.writeFile(retryListPath, failedFileList.join('\n'));
      logPush(ingestMessage('ingest.log.retryListCreated', { retryListPath }));
    } catch (err) {
      logPush(ingestMessage('ingest.log.writeRetryListFailed', { retryListPath, error: err.message }));
    }
  }
}

// ==========================================
// ✅ Step 17: Final Ingest Summary
// ==========================================

const verificationEnabled = Boolean(byteMatch || (verify && checksumMethod !== 'none'));
const verificationMethodKey = {
  sha256: 'ingest.summary.verification.label.sha256',
  md5: 'ingest.summary.verification.label.md5',
  blake3: 'ingest.summary.verification.label.blake3',
  xxhash64: 'ingest.summary.verification.label.xxhash64'
};

let verificationLabel = formatIngestMessage(ingestMessage('ingest.summary.verification.label.off'));
if (byteMatch) {
  verificationLabel = formatIngestMessage(ingestMessage('ingest.summary.verification.label.byteByByte'));
} else if (verify && checksumMethod && checksumMethod !== 'none') {
  const normalizedMethod = String(checksumMethod).toLowerCase();
  const methodLabelKey = verificationMethodKey[normalizedMethod] || 'ingest.summary.verification.label.other';
  verificationLabel = formatIngestMessage(ingestMessage(methodLabelKey, { method: String(checksumMethod) }));
}

if (verificationEnabled) {
  const destOk = counters.verifyDestPassed;
  const destReq = counters.verifyDestRequired;
  const allDestOk = destReq > 0 && destOk === destReq;
  const destinationResult = formatIngestMessage(ingestMessage(
    allDestOk ? 'ingest.summary.verification.result.passed' : 'ingest.summary.verification.result.verified'
  ));
  logPush(ingestMessage('ingest.summary.verification.destination', { verificationLabel, ok: destOk, required: destReq, result: destinationResult }));

  if (backup && backupPath) {
    const bOk = counters.verifyBackupPassed;
    const bReq = counters.verifyBackupRequired;
    const allBackupOk = bReq > 0 && bOk === bReq;
    const backupResult = formatIngestMessage(ingestMessage(
      allBackupOk ? 'ingest.summary.verification.result.passed' : 'ingest.summary.verification.result.verified'
    ));
    logPush(ingestMessage('ingest.summary.verification.backup', { verificationLabel, ok: bOk, required: bReq, result: backupResult }));
  }
} else {
  logPush(ingestMessage('ingest.summary.verification.off'));
}

logPush(ingestMessage('ingest.summary.complete', { success: counters.success, skipped: counters.skipped, failed: counters.failed }));
logPush(ingestMessage('ingest.summary.elapsed', { seconds: Math.max(0, Math.round((Date.now() - startedAtMs) / 1000)) }));

if (counters.success === 0 && counters.skipped > 0) {
  logPush(ingestMessage('ingest.summary.allSkipped'));
}

// 🧩 Final push to renderer to mark all files 100%
// Renderer table updates are handled via the queue manager

// Progress updates are now handled exclusively via the queue manager

// ==========================================
// 🛑 Step 19: Show Alert if Any Files Failed
// ==========================================

if (counters.failed > 0) {
  if (isWatchTriggered) {
    logPush(ingestMessage('ingest.summary.watchErrors'), '', true);
  } else {
    await showIngestDialog(dialogParentWindow, ingestDialogPayload({
      type: 'warning',
      title: ingestMessage('ingest.dialog.finishedWithErrors.title'),
      message: ingestMessage('ingest.dialog.finishedWithErrors.message', { failed: counters.failed }),
      buttons: [ingestMessage('ingest.dialog.button.ok')]
    }));
  }
}

// ==========================================
// 🛰️ Step 20: Optional n8n Webhook Trigger
// ==========================================

    if (enableN8N && n8nValidation.valid) {
      const payload = n8nLog
        ? { log }
        : {
            status: 'complete',
            notes,
            success: true,
            skipped: skippedFiles.length,
            failed: failedFileList.length,
            ...(n8nIncludePaths
              ? {
                  archivePath,
                  structuredLogPath: structuredPath,
                  destination
                }
              : {})
          };
      logPush(ingestMessage('ingest.log.webhook.sending'));

      let timeoutId;
      try {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        const controller = new AbortController();
        const timeoutMs = 8000;
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(n8nValidation.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        if (response.ok) {
          logPush(ingestMessage('ingest.log.webhook.triggered'));
        } else {
          let responseExcerpt = '';
          try {
            const rawBody = await response.text();
            const normalizedBody = String(rawBody || '').replace(/\s+/g, ' ').trim();
            if (normalizedBody) {
              const maxExcerptLength = 240;
              responseExcerpt = normalizedBody.length > maxExcerptLength
                ? `${normalizedBody.slice(0, maxExcerptLength)}…`
                : normalizedBody;
            }
          } catch {
            // Ignore read failures; status message below still includes HTTP metadata.
          }

          if (responseExcerpt) {
            logPush(ingestMessage('ingest.log.webhook.httpStatusWithExcerpt', {
              status: response.status,
              statusText: response.statusText || '',
              excerpt: responseExcerpt
            }));
          } else {
            logPush(ingestMessage('ingest.log.webhook.httpStatus', {
              status: response.status,
              statusText: response.statusText || ''
            }));
          }
        }
      } catch (_err) {
        const detail = toSafeTechnicalDetail(_err);
        if (_err?.name === 'AbortError') {
          logPush(ingestErrorMessage(INGEST_ERROR_CODE.WEBHOOK_TIMEOUT), detail);
        } else if (_err?.name === 'FetchError' || _err?.code || _err instanceof TypeError) {
          logPush(ingestErrorMessage(INGEST_ERROR_CODE.WEBHOOK_NETWORK), detail);
        } else {
          logPush(ingestErrorMessage(INGEST_ERROR_CODE.WEBHOOK_TRIGGER_FAILED), detail);
        }
      } finally {
        try { if (timeoutId) clearTimeout(timeoutId); } catch {}
      }
    } else if (enableN8N && !n8nValidation.valid) {
      logPush(ingestMessage('ingest.webhook.skippedInvalid', { message: formatIngestMessage(n8nValidation.message).replace(/^❌\s*/, '') }));
    }

       // ==========================================
    // 🏁 Step 21: Return Summary
    // ==========================================
if (progressManager?.dispose) progressManager.dispose();
removeJobFile();

// 💾 Persist hash cache
flushHashCache();
config.sources = destPaths;
jobLogger.setStage('complete');
jobLogger.info('Ingest job completed');
persistJobLogs({ rewriteText: true });
const stats = { success: counters.success, skipped: counters.skipped, failed: counters.failed };
const summary = ingestMessage('ingest.summary.result', { success: stats.success, skipped: stats.skipped, failed: stats.failed });
return {
  success: true,
  status: INGEST_STATUS.COMPLETE,
  config,
  archivePath,
  structuredLogPath: structuredPath,
  stats,
  summary,
  log,
  logText: getLogText(),
  jobId: config.jobId
};

  } catch (err) {
    const errorCode = (typeof err?.code === 'string' && err.code.trim())
      ? err.code.trim()
      : INGEST_ERROR_CODE.UNHANDLED;
    const errorMsg = ingestErrorMessage(errorCode);
    console.error('[runIngest] Uncaught error:', err);
    logPush(errorMsg, toSafeTechnicalDetail(err));
    jobLogger.setStage('error');
    jobLogger.error('Ingest job failed', { error: err?.message || String(err), stack: err?.stack });
    if (progressManager?.dispose) progressManager.dispose();
    removeJobFile();
    flushHashCache();
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    persistJobLogs({ rewriteText: true });
    return {
  success: false,
  log,
  logText: getLogText(),
  cancelled: Boolean(config?.signal?.aborted),
  archivePath,
  structuredLogPath: structuredPath,
  jobId: config.jobId
};
  } finally {
    persistJobLogs();
    await refreshSavedJobReportCopies();
  }
}

// ==========================================
// 📦 Exports
// ==========================================

module.exports = {
  runIngest,
  validateIngestConfig,
  validateN8nUrl,
  cancelIngest,
  filterOutDestination,
  getFileListRelativePath,
  resolveCopyRelativePath,
  normalizeSourceFiles
};
