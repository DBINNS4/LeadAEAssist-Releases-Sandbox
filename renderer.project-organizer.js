(() => {

const electron = window.electron ?? {};
const ipc = window.ipc ?? electron;
const PANEL_ID = 'project-organizer';

const translate = (key, fallback, options) => {
  const t = window.i18n?.t;
  if (typeof t === 'function') {
    const translated = t(key, options);
    if (typeof translated === 'string' && translated && translated !== key) return translated;
  }
  return fallback;
};

const translateCount = (key, count, fallback) => {
  const t = window.i18n?.t;
  if (typeof t === 'function') {
    const translated = t(key, { count });
    if (typeof translated === 'string' && translated && translated !== key) return translated;
  }
  return fallback;
};

const PROJECT_ORGANIZER_UI_STRINGS = Object.freeze({
  started: { key: 'projectOrganizerStarted', fallback: '⏳ Project organizer started...' },
  completedWithIssues: {
    key: 'projectOrganizerCompletedWithIssues',
    fallback: '⚠️ Project organizer completed with issues.'
  },
  errorsLabel: { key: 'projectOrganizerErrors', fallbackBase: 'Errors' },
  warningsLabel: { key: 'projectOrganizerWarnings', fallbackBase: 'Warnings' },
  created: { key: 'projectOrganizerCreated', fallback: '✅ Project structure created.' },
  failed: { key: 'projectOrganizerFailed', fallback: '❌ Project organizer failed.' },
  diagnosticsHeading: { key: 'projectOrganizerDiagnosticsHeading', fallback: 'Diagnostics:' },
  diagnosticFallbackHeading: {
    key: 'projectOrganizerDiagnosticFallbackHeading',
    fallback: '[Diagnostic fallback: raw backend text ({{contextLabel}})]'
  },
  diagnosticFallbackSummaryLabel: {
    key: 'projectOrganizerDiagnosticFallbackSummaryLabel',
    fallback: 'summary'
  },
  diagnosticFallbackLogTextLabel: {
    key: 'projectOrganizerDiagnosticFallbackLogTextLabel',
    fallback: 'logText'
  },
  cancelled: { key: 'projectOrganizerCancelled', fallback: '⚠️ Project organizer cancelled.' },
  approveDroppedFilesFailed: {
    key: 'projectOrganizerApproveDroppedFilesFailed',
    fallback: '❌ Failed to approve dropped files: {{error}}'
  },
  filePickerFailed: { key: 'projectOrganizerFilePickerFailed', fallback: '❌ File picker failed: {{error}}' },
  folderPickerFailed: { key: 'projectOrganizerFolderPickerFailed', fallback: '❌ Folder picker failed: {{error}}' },
  summaryOutputLocation: {
    key: 'projectOrganizerSummaryOutputLocation',
    fallback: '(Output Location)'
  },
  summaryNoPath: { key: 'projectOrganizerSummaryNoPath', fallback: '[No Path]' },
  summaryNone: { key: 'projectOrganizerSummaryNone', fallback: 'None' },
  summaryRootFolderLine: { key: 'projectOrganizerSummaryRootFolderLine', fallback: 'Root Folder: {{root}}' },
  summarySelectedFoldersLine: {
    key: 'projectOrganizerSummarySelectedFoldersLine',
    fallback: 'Selected Folders: {{folders}}'
  },
  summaryOutputPathLine: { key: 'projectOrganizerSummaryOutputPathLine', fallback: 'Output Path: {{path}}' },
  summaryAttachmentLine: { key: 'projectOrganizerSummaryAttachmentLine', fallback: '📎 {{folder}}: {{files}}' },
  outputPathRequired: {
    key: 'projectOrganizerOutputPathRequired',
    fallback: '❌ Please set an Output Path before generating.'
  },
  outputPathAccessFailed: {
    key: 'projectOrganizerOutputPathAccessFailed',
    fallback: '❌ Unable to access Output Path: {{error}}'
  },
  outputPathMustBeFolder: {
    key: 'projectOrganizerOutputPathMustBeFolder',
    fallback: '❌ Output Path must be an existing folder. Please choose a valid directory.'
  },
  generatingStructure: { key: 'projectOrganizerGeneratingStructure', fallback: '⚙️ Generating structure...' },
  queueFailed: { key: 'projectOrganizerQueueFailed', fallback: '❌ Organizer job failed to queue: {{error}}' },
  noJobToCancel: { key: 'projectOrganizerNoJobToCancel', fallback: '⚠️ No organizer job to cancel.' },
  cancelRequested: { key: 'projectOrganizerCancelRequested', fallback: '⛔ Cancel requested...' },
  cancelError: { key: 'projectOrganizerCancelError', fallback: '❌ Cancel error: {{error}}' }
});

const CUSTOM_FOLDER_LABEL_KEY = 'projectOrganizerCustomFolderLabel';
const CUSTOM_FOLDER_LABEL_FALLBACK = '(Custom)';

function formatOrganizerFallback(template, params = {}) {
  return String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, token) => {
    const value = params[token];
    return value === undefined || value === null ? '' : String(value);
  });
}

function tOrganizerUi(name, options = {}) {
  const entry = PROJECT_ORGANIZER_UI_STRINGS[name];
  if (!entry) return '';
  return translate(entry.key, formatOrganizerFallback(entry.fallback, options), options);
}

function tOrganizerUiCount(name, count) {
  const entry = PROJECT_ORGANIZER_UI_STRINGS[name];
  if (!entry) return '';
  return translateCount(entry.key, count, `${entry.fallbackBase} (${count}):`);
}


const PROJECT_ORGANIZER_REASON_KEYS = Object.freeze({
  folderNameEmpty: 'projectOrganizerReasonFolderNameEmpty',
  folderNameContainsSeparator: 'projectOrganizerReasonFolderNameContainsSeparator',
  folderNameContainsDotDot: 'projectOrganizerReasonFolderNameContainsDotDot',
  folderNameEndsWithDotOrSpace: 'projectOrganizerReasonFolderNameEndsWithDotOrSpace',
  folderNameReservedDeviceName: 'projectOrganizerReasonFolderNameReservedDeviceName',
  folderNameIllegalCharacter: 'projectOrganizerReasonFolderNameIllegalCharacter',
  folderNameReservedMetaKey: 'projectOrganizerReasonFolderNameReservedMetaKey',
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
  projectOrganizerUncaughtError: 'projectOrganizerReasonUncaughtError'
});

const PROJECT_ORGANIZER_MESSAGE_KEYS = Object.freeze({
  'missing-output-or-selection': 'projectOrganizerMessageMissingOutputOrSelection',
  'invalid-root-name': 'projectOrganizerMessageInvalidRootName',
  'invalid-folder-selection': 'projectOrganizerMessageInvalidFolderSelection',
  'invalid-input': 'projectOrganizerMessageInvalidInput',
  'duplicate-folder-selection-removed': 'projectOrganizerMessageDuplicateFolderSelectionRemoved',
  'output-root-missing': 'projectOrganizerMessageOutputRootMissing',
  'output-root-not-directory': 'projectOrganizerMessageOutputRootNotDirectory',
  'output-root-not-writable': 'projectOrganizerMessageOutputRootNotWritable',
  'root-not-directory': 'projectOrganizerMessageRootNotDirectory',
  'root-exists': 'projectOrganizerMessageRootExists',
  'asset-entry-invalid': 'projectOrganizerMessageAssetEntryInvalid',
  'asset-file-url-invalid': 'projectOrganizerMessageAssetFileUrlInvalid',
  'asset-path-not-absolute': 'projectOrganizerMessageAssetPathNotAbsolute',
  'asset-unreadable': 'projectOrganizerMessageAssetUnreadable',
  'asset-not-file': 'projectOrganizerMessageAssetNotFile',
  'asset-not-readable': 'projectOrganizerMessageAssetNotReadable',
  'asset-duplicate-skipped': 'projectOrganizerMessageAssetDuplicateSkipped',
  'asset-copy-failed': 'projectOrganizerMessageAssetCopyFailed',
  'project-structure-created': 'projectOrganizerMessageSummaryCreated',
  'project-structure-created-with-issues': 'projectOrganizerMessageSummaryCreatedWithIssues',
  'project-organizer-cancelled': 'projectOrganizerMessageCancelled',
  'project-organizer-uncaught-error': 'projectOrganizerMessageUncaughtError'
});

function renderProjectOrganizerMessage(payload, fallback = '', options = {}) {
  if (!payload || typeof payload !== 'object') return fallback;
  const allowRawMessage = !!options.allowRawMessage;
  const code = typeof payload.code === 'string' ? payload.code : '';
  const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
  const reasonCode = typeof params.reasonCode === 'string' ? params.reasonCode : '';
  const reasonKey = PROJECT_ORGANIZER_REASON_KEYS[reasonCode];
  const translatedReason = reasonKey
    ? translate(reasonKey, reasonCode, params)
    : (params.reason || reasonCode || '');
  const localizedParams = translatedReason ? { ...params, reason: translatedReason } : params;

  let key = PROJECT_ORGANIZER_MESSAGE_KEYS[code];
  if (code === 'asset-not-file' && (localizedParams.reason || localizedParams.reasonCode)) {
    key = 'projectOrganizerMessageAssetNotFileWithReason';
  }
  if (key) {
    const translatedFallback = allowRawMessage
      ? (payload.message || fallback || code)
      : (fallback || code);
    return translate(key, translatedFallback, localizedParams);
  }
  if (allowRawMessage && payload.message) return payload.message;
  return fallback;
}

function shouldShowOrganizerDiagnostics() {
  return !!(window.DEBUG_LOGS || window.__LAE_DIAGNOSTICS__ || window.localStorage?.getItem?.('lae:diagnostics') === '1');
}

function getOrganizerDiagnosticFallback(jobResult, contextLabel = 'unknown') {
  if (!shouldShowOrganizerDiagnostics() || !jobResult || typeof jobResult !== 'object') return '';
  const rawSummary = typeof jobResult.summary === 'string' ? jobResult.summary.trim() : '';
  const rawLogText = typeof jobResult.logText === 'string' ? jobResult.logText.trim() : '';
  const lines = [];
  const summaryLabel = tOrganizerUi('diagnosticFallbackSummaryLabel');
  const logTextLabel = tOrganizerUi('diagnosticFallbackLogTextLabel');
  if (rawSummary) lines.push(`${summaryLabel}: ${rawSummary}`);
  if (rawLogText) lines.push(`${logTextLabel}: ${rawLogText}`);
  if (!lines.length) return '';
  const heading = tOrganizerUi('diagnosticFallbackHeading', { contextLabel });
  return `\n\n${heading}\n${lines.join('\n')}`;
}

function renderProjectOrganizerMessageList(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        return renderProjectOrganizerMessage(item, '', { allowRawMessage: false });
      }
      return '';
    })
    .filter(Boolean);
}

const ORGANIZER_PRESET_LOAD_ERROR_CODES = Object.freeze({
  REQUIRES_ASYNC_FS: 'requiresAsyncFs',
  INVALID_JSON: 'invalidJson',
  UNKNOWN: 'unknown'
});

function resolveOrganizerPresetLoadReason(err) {
  const code = err?.code;
  if (code === ORGANIZER_PRESET_LOAD_ERROR_CODES.REQUIRES_ASYNC_FS) {
    return translate(
      'projectOrganizerPresetLoadReasonRequiresAsyncFs',
      'Preset loading requires Electron async file APIs.'
    );
  }
  if (code === ORGANIZER_PRESET_LOAD_ERROR_CODES.INVALID_JSON || err instanceof SyntaxError) {
    return translate(
      'projectOrganizerPresetLoadReasonInvalidJson',
      'Preset file content is invalid.'
    );
  }
  return translate(
    'projectOrganizerPresetLoadReasonUnknown',
    'An unexpected error occurred while loading the preset.'
  );
}

// Renderer-safe snapshot helper: no require, no Node API.
function snapshotOrganizerJobState(state) {
  const payload = {
    selectedFolders: state.selectedFolders,
    folderOrder: state.folderOrder,
    customFolders: state.customFolders,
    folderAssets: state.folderAssets
  };

  if (typeof structuredClone === 'function') {
    return structuredClone(payload);
  }

  return JSON.parse(JSON.stringify(payload));
}

const organizerState = {
  currentJobId: null
};

let organizerSummaryWarning = [];

function clearOrganizerSummaryWarning() {
  organizerSummaryWarning = [];
}

function normalizeOrganizerWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .filter(Boolean)
    .map(warning => {
      if (typeof warning === 'string') {
        return {
          type: 'generic',
          message: warning
        };
      }
      if (!warning || typeof warning !== 'object') return null;
      const type = typeof warning.type === 'string' ? warning.type : 'generic';
      const key = typeof warning.key === 'string' ? warning.key : '';
      const params = warning.params && typeof warning.params === 'object' ? warning.params : undefined;
      const fallback = typeof warning.fallback === 'string' ? warning.fallback : undefined;
      const message = typeof warning.message === 'string' ? warning.message : undefined;
      return { type, key, params, fallback, message };
    })
    .filter(Boolean);
}

function isOrganizerWarningRelevant(warning) {
  if (!warning || (!warning.key && !warning.message)) return false;
  if (warning.type === 'output-path') {
    return !(el.outputPath?.value || '').trim();
  }
  return true;
}

function getOrganizerWarningParamsWithSourceLabel(params = {}) {
  if (!params || typeof params !== 'object') return {};
  const nextParams = { ...params };
  const sourceType = typeof nextParams.sourceType === 'string' ? nextParams.sourceType : '';
  if (!sourceType) return nextParams;
  const sourceFile = typeof nextParams.sourceFile === 'string' ? nextParams.sourceFile : '';
  nextParams.sourceLabel = sourceFile
    ? getOrganizerSourceLabel(sourceType, sourceFile)
    : getOrganizerSourceTypeLabel(sourceType);
  return nextParams;
}

function getOrganizerSummaryWarningText() {
  const warnings = normalizeOrganizerWarnings(organizerSummaryWarning)
    .filter(isOrganizerWarningRelevant)
    .map(warning => {
      const warningParams = getOrganizerWarningParamsWithSourceLabel(warning.params || {});
      if (warning.key) {
        const fallback = warning.fallback || warning.message || warning.key;
        return translate(warning.key, fallback, warningParams);
      }
      return warning.message || '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return warnings;
}

const el = {
  lockWrapper: document.getElementById('project-organizer-lock-wrapper'),
  folderList: document.getElementById('folder-list'),
  addCustomFolder: document.getElementById('add-custom-folder'),
  addSubfolder: document.getElementById('organizer-add-subfolder'),
  customFolderName: document.getElementById('custom-folder-name'),
  resetButton: document.getElementById('reset-project-organizer'),
  generateButton: document.getElementById('generate-project-folders'),
  cancelButton: document.getElementById('cancel-project-organizer'),
  summary: document.getElementById('project-summary'),
  outputPath: document.getElementById('output-location-path'),
  outputBtn: document.getElementById('select-output-location'),
  rootName: document.getElementById('root-folder-name'),
  prependNumbers: document.getElementById('prepend-numbers'),
  presetSelect: document.getElementById('organizer-preset'),
  saveConfig: document.getElementById('organizer-save-config'),
  loadConfig: document.getElementById('organizer-load-config'),
  status: document.getElementById('project-organizer-job-status'),
  wheel: document.querySelector('#project-organizer-job-status .wheel-and-hamster'),
  loaderInline: document.getElementById('project-organizer-loader-inline'),
  progress: document.getElementById('project-organizer-progress'),
  progressOutput: document.getElementById('project-organizer-progress-output')
};

if (el.cancelButton) el.cancelButton.disabled = true;

function setOrganizerSummary(text) {
  if (!el.summary) return;
  const nextText = text == null ? '' : String(text);
  if ('value' in el.summary) {
    el.summary.value = nextText;
    return;
  }
  el.summary.textContent = nextText;
}

let organizerPanelRunning = false;

function setOrganizerPanelRunning(isRunning) {
  const next = !!isRunning;
  if (next === organizerPanelRunning) return;
  organizerPanelRunning = next;
  window.dispatchEvent(new CustomEvent('lae:panel-running-state', {
    detail: {
      panel: PANEL_ID,
      isRunning: next
    }
  }));
}

// Keep the controls row layout stable (mirrors Speed Test):
// - loader + hamster slots stay in-flow
// - visibility is toggled via .is-active, not display:none
if (el.loaderInline) {
  el.loaderInline.classList.remove('is-active');
  el.loaderInline.setAttribute('aria-hidden', 'true');
}
if (el.status) {
  el.status.classList.remove('is-active');
  el.status.setAttribute('aria-hidden', 'true');
}

// Preserve the UI skin's nested button markup.
function getButtonLabel(btn) {
  if (!btn) return '';
  try {
    const t = btn.querySelector?.('.button_text');
    if (t) return String(t.textContent ?? '');
  } catch {}
  return String(btn.textContent ?? '');
}

function setButtonLabel(btn, label) {
  if (!btn) return;
  try {
    const t = btn.querySelector?.('.button_text');
    if (t) {
      t.textContent = String(label ?? '');
      return;
    }
  } catch {}
  btn.textContent = String(label ?? '');
}

function enforceGenerateButtonLabel() {
  if (!el.generateButton) return;
  const desired = translate('generateProjectFoldersShort', 'Generate');
  const current = getButtonLabel(el.generateButton).trim();
  if (current === String(desired).trim()) return;
  setButtonLabel(el.generateButton, desired);
}

// i18n may apply after this script runs; guard the short label.
(function bindGenerateLabelGuard() {
  if (!el.generateButton) return;
  enforceGenerateButtonLabel();
  try {
    const obs = new MutationObserver(() => enforceGenerateButtonLabel());
    obs.observe(el.generateButton, { childList: true, characterData: true, subtree: true });
  } catch {}
  setTimeout(enforceGenerateButtonLabel, 0);
  setTimeout(enforceGenerateButtonLabel, 100);
  setTimeout(enforceGenerateButtonLabel, 500);
})();

function ensureHamster(root) {
  if (!root || root.querySelector('.wheel')) return;
  root.innerHTML = `
      <div class="wheel"></div>
      <div class="hamster">
        <div class="hamster__body">
          <div class="hamster__head">
            <div class="hamster__ear"></div>
            <div class="hamster__eye"></div>
            <div class="hamster__nose"></div>
          </div>
          <div class="hamster__limb hamster__limb--fr"></div>
          <div class="hamster__limb hamster__limb--fl"></div>
          <div class="hamster__limb hamster__limb--br"></div>
          <div class="hamster__limb hamster__limb--bl"></div>
          <div class="hamster__tail"></div>
        </div>
      </div>
      <div class="spoke"></div>`;
}

function showOrganizerHamster() {
  if (!el.status) return;
  el.status.classList.add('is-active');
  el.status.setAttribute('aria-hidden', 'false');

  // Ensure the wheel container exists (HTML keeps it, but be defensive)
  if (!el.wheel) {
    el.wheel = el.status.querySelector('.wheel-and-hamster');
    if (!el.wheel) {
      el.wheel = document.createElement('div');
      el.wheel.className = 'wheel-and-hamster';
      el.status.appendChild(el.wheel);
    }
  }

  ensureHamster(el.wheel);
}

function hideOrganizerHamster() {
  if (el.status) {
    el.status.classList.remove('is-active');
    el.status.setAttribute('aria-hidden', 'true');
  }
  if (el.wheel) el.wheel.innerHTML = '';
}

function logOrganizer(msg, opts = {}) {
  window.logPanel?.log(PANEL_ID, msg, opts);
}


async function chooseOrganizerReparentAction({ title, message, detail, removeLabel, moveLabel }) {
  const dialogOptions = {
    type: 'warning',
    title,
    message,
    detail,
    buttons: [removeLabel, moveLabel],
    defaultId: 1,
    cancelId: 0
  };

  try {
    if (typeof window.rendererDialogs?.showMessageDialog === 'function') {
      const result = await window.rendererDialogs.showMessageDialog(dialogOptions);
      return Number(result?.response) === 1 ? 'move' : 'remove';
    }
    if (typeof ipc?.showMessageDialog === 'function') {
      const result = await ipc.showMessageDialog(dialogOptions);
      return Number(result?.response) === 1 ? 'move' : 'remove';
    }
    if (typeof ipc?.invoke === 'function') {
      const result = await ipc.invoke('show-message-dialog', dialogOptions);
      if (result && typeof result === 'object') {
        return Number(result?.response) === 1 ? 'move' : 'remove';
      }
    }
    console.warn('Project Organizer choice dialog bridge unavailable. Defaulting to move-to-root.');
  } catch (err) {
    console.warn('Project Organizer choice dialog failed:', err?.message || err);
  }

  return 'move';
}

function ensureOrganizerToast() {
  let toastEl = document.getElementById('project-organizer-toast');
  if (toastEl) return toastEl;
  if (!document.body) return null;
  toastEl = document.createElement('div');
  toastEl.id = 'project-organizer-toast';
  toastEl.className = 'toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastEl);
  return toastEl;
}

function hideOrganizerToast() {
  const toastEl = document.getElementById('project-organizer-toast');
  if (showOrganizerToast._timer) {
    clearTimeout(showOrganizerToast._timer);
    showOrganizerToast._timer = null;
  }
  currentOrganizerToastI18n = null;
  if (!toastEl) return;
  toastEl.classList.remove('show');
  toastEl.classList.remove('toast-error');
}

let currentOrganizerToastI18n = null;

function resolveOrganizerToastMessage(message, options = {}) {
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const fallback = formatOrganizerFallback(message.fallback || '', params);
    const translated = message.key ? translate(message.key, fallback, params) : fallback;
    return {
      msg: String(translated ?? '').trim(),
      persistent: !!message.persistent,
      isError: !!message.isError,
      i18nPayload: message.key
        ? {
          key: message.key,
          fallback: message.fallback || '',
          params
        }
        : null
    };
  }

  return {
    msg: String(message ?? '').trim(),
    persistent: !!options.persistent,
    isError: !!options.isError,
    i18nPayload: null
  };
}

function refreshActiveOrganizerToastText() {
  if (!currentOrganizerToastI18n) return;
  const toastEl = document.getElementById('project-organizer-toast');
  if (!toastEl || !toastEl.classList.contains('show')) return;
  const params = currentOrganizerToastI18n.params && typeof currentOrganizerToastI18n.params === 'object'
    ? currentOrganizerToastI18n.params
    : {};
  const fallback = formatOrganizerFallback(currentOrganizerToastI18n.fallback || '', params);
  const translated = translate(currentOrganizerToastI18n.key, fallback, params);
  const msg = String(translated ?? '').trim();
  if (msg) toastEl.textContent = msg;
}

function showOrganizerToast(message, options = {}) {
  const toastEl = ensureOrganizerToast();
  const resolved = resolveOrganizerToastMessage(message, options);
  const msg = resolved.msg;
  if (!toastEl || !msg) return;

  const persistent = resolved.persistent;
  const isError = resolved.isError;
  currentOrganizerToastI18n = resolved.i18nPayload;
  toastEl.textContent = msg;
  toastEl.classList.toggle('toast-error', isError);
  toastEl.classList.add('show');
  toastEl.setAttribute('role', (persistent || isError) ? 'alert' : 'status');
  toastEl.setAttribute('aria-live', (persistent || isError) ? 'assertive' : 'polite');

  if (showOrganizerToast._timer) {
    clearTimeout(showOrganizerToast._timer);
    showOrganizerToast._timer = null;
  }

  if (!persistent) {
    showOrganizerToast._timer = setTimeout(() => {
      toastEl.classList.remove('show');
      currentOrganizerToastI18n = null;
      showOrganizerToast._timer = null;
    }, 2000);
  }
}

let organizerFolderValidationState = null;

const ORGANIZER_FOLDER_VALIDATION_CODES = Object.freeze({
  folderNameEmpty: 'folderNameEmpty',
  folderNameContainsSeparator: 'folderNameContainsSeparator',
  folderNameContainsDotDot: 'folderNameContainsDotDot',
  folderNameEndsWithDotOrSpace: 'folderNameEndsWithDotOrSpace',
  folderNameReservedDeviceName: 'folderNameReservedDeviceName',
  folderNameIllegalCharacter: 'folderNameIllegalCharacter',
  folderNameReservedMetaKey: 'folderNameReservedMetaKey',
  selectOneFolderToNest: 'selectOneFolderToNest',
  folderAlreadyExists: 'folderAlreadyExists'
});

function getOrganizerFolderValidationMessage(reasonState) {
  if (!reasonState || typeof reasonState !== 'object') return '';
  const params = reasonState.params && typeof reasonState.params === 'object'
    ? reasonState.params
    : {};
  switch (reasonState.code) {
    case ORGANIZER_FOLDER_VALIDATION_CODES.folderNameEmpty:
      return translate('projectOrganizerFolderNameEmpty', 'Folder names cannot be empty.');
    case ORGANIZER_FOLDER_VALIDATION_CODES.folderNameContainsSeparator:
      return translate('projectOrganizerFolderNameNoSeparators', 'Folder names cannot contain path separators.');
    case ORGANIZER_FOLDER_VALIDATION_CODES.folderNameContainsDotDot:
      return translate('projectOrganizerFolderNameNoDotDot', 'Folder names cannot contain "..".');
    case ORGANIZER_FOLDER_VALIDATION_CODES.folderNameEndsWithDotOrSpace:
      return translate('projectOrganizerFolderNameNoTrailingDotSpace', 'Folder names cannot end with a dot or space.');
    case ORGANIZER_FOLDER_VALIDATION_CODES.folderNameReservedDeviceName:
      return translate('projectOrganizerFolderNameReservedDevice', 'Folder names cannot use reserved device names.');
    case ORGANIZER_FOLDER_VALIDATION_CODES.folderNameIllegalCharacter:
      return translate('projectOrganizerFolderNameIllegalChars', 'Folder names contain illegal characters.');
    case ORGANIZER_FOLDER_VALIDATION_CODES.folderNameReservedMetaKey:
      return translate('projectOrganizerFolderNameReservedMetaKey', 'Folder names cannot use reserved object meta keys.');
    case ORGANIZER_FOLDER_VALIDATION_CODES.selectOneFolderToNest:
      return translate('projectOrganizerSelectOneFolderToNest', 'Please select exactly one folder to nest under.');
    case ORGANIZER_FOLDER_VALIDATION_CODES.folderAlreadyExists:
      return translate(
        'projectOrganizerFolderAlreadyExists',
        `Folder "${params.folderId || ''}" already exists.`,
        { folderId: params.folderId || '' }
      );
    default:
      return '';
  }
}

function refreshOrganizerValidationMessage() {
  if (!organizerFolderValidationState) return;
  const message = getOrganizerFolderValidationMessage(organizerFolderValidationState);
  if (!message) {
    setOrganizerFolderValidation('');
    return;
  }
  setOrganizerFolderValidation(`❌ ${message}`, organizerFolderValidationState);
}

function ensureOrganizerFolderValidation() {
  let statusEl = document.getElementById('project-organizer-folder-status');
  if (statusEl) return statusEl;
  if (!el.customFolderName) return null;
  statusEl = document.createElement('div');
  statusEl.id = 'project-organizer-folder-status';
  statusEl.className = 'input-error';
  statusEl.setAttribute('role', 'alert');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.hidden = true;
  const host = el.customFolderName.closest('.organizer-custom-folder') || el.customFolderName.parentElement;
  if (host) {
    host.insertAdjacentElement('afterend', statusEl);
  } else {
    el.customFolderName.insertAdjacentElement('afterend', statusEl);
  }
  el.customFolderName.setAttribute('aria-describedby', statusEl.id);
  return statusEl;
}

function setOrganizerFolderValidation(message, reasonState = null) {
  const statusEl = ensureOrganizerFolderValidation();
  const msg = String(message ?? '').trim();
  organizerFolderValidationState = msg ? reasonState : null;

  if (el.customFolderName) {
    if (msg) {
      el.customFolderName.setAttribute('aria-invalid', 'true');
    } else {
      el.customFolderName.removeAttribute('aria-invalid');
    }
  }

  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.hidden = !msg;
}

function showOrganizerFolderValidation(message, reasonState = null) {
  setOrganizerFolderValidation(message, reasonState);
  el.customFolderName?.focus();
  el.customFolderName?.scrollIntoView?.({ block: 'nearest' });
}

function setOrganizerInlineProgressActive(active) {
  if (!el.loaderInline) return;
  el.loaderInline.classList.toggle('is-active', !!active);
  el.loaderInline.setAttribute('aria-hidden', active ? 'false' : 'true');
}

function resetOrganizerProgressUI({ hide } = {}) {
  if (el.progress) {
    el.progress.value = 0;
  }
  if (el.progressOutput) {
    el.progressOutput.value = '';
  }
  setOrganizerInlineProgressActive(!hide);
}

function updateOrganizerProgress(payload) {
  if (!el.progress || !el.progressOutput) return;
  const rawPercent = typeof payload.percent === 'number'
    ? payload.percent
    : typeof payload.overall === 'number'
      ? payload.overall
      : null;

  if (rawPercent === null) return;

  const pct = Math.max(0, Math.min(100, rawPercent));
  setOrganizerInlineProgressActive(true);
  el.progress.value = pct;
  el.progressOutput.value = pct >= 100 ? '' : Math.round(pct);
}

function getOrganizerLockRoot() {
  return el.lockWrapper || document.getElementById(PANEL_ID);
}

function isOrganizerLocked() {
  return !!getOrganizerLockRoot()?.classList?.contains('locked');
}

function setOrganizerInputsDisabled(disabled) {
  const lockRoot = getOrganizerLockRoot();
  lockRoot?.classList?.toggle('locked', !!disabled);

  const shouldSkip = node => node?.id === 'cancel-project-organizer';

  const toggleJobDisabled = node => {
    if (!node || shouldSkip(node)) return;
    if (disabled) {
      if (!node.dataset.jobDisabled) {
        node.dataset.jobDisabled = 'true';
        node.dataset.jobDisabledPrev = node.disabled ? 'true' : 'false';
      }
      node.disabled = true;
      return;
    }

    if (!node.dataset.jobDisabled) return;
    const wasDisabled = node.dataset.jobDisabledPrev === 'true';
    node.disabled = wasDisabled;
    delete node.dataset.jobDisabled;
    delete node.dataset.jobDisabledPrev;
  };

  // Disable every interactive control inside the panel while the job runs.
  // Restores each element's previous disabled state when the job ends.
  lockRoot?.querySelectorAll?.('input, select, textarea, button')?.forEach(toggleJobDisabled);

  // Stop reordering while a job is active.
  el.folderList?.querySelectorAll('li.draggable-item').forEach(item => {
    if (disabled) {
      item.setAttribute('draggable', 'false');
    } else if (item.dataset.root === 'true') {
      item.setAttribute('draggable', 'true');
    }
  });
}

// Prevent default browser behavior when files are dragged over the document
// or dropped outside of explicit targets. This ensures the app doesn't
// inadvertently navigate away or open files in the browser context.
document.addEventListener('dragover', event => {
  if (event.dataTransfer?.types?.includes?.('Files')) {
    event.preventDefault();
  }
});

document.addEventListener('drop', event => {
  if (event.dataTransfer?.types?.includes?.('Files')) {
    event.preventDefault();
  }
});

ipc?.on?.('queue-job-start', (_e, job) => {
  if (job.panel !== PANEL_ID) return;
  organizerState.currentJobId = job.id;
  if (el.cancelButton) el.cancelButton.disabled = false;
  setOrganizerInputsDisabled(true);
  setOrganizerPanelRunning(true);
  resetOrganizerProgressUI({ hide: false });
  showOrganizerHamster();
  if (el.summary) {
    setOrganizerSummary(tOrganizerUi('started'));
  }
});

ipc?.on?.('queue-job-progress', (_event, payload) => {
  if (payload.panel !== PANEL_ID) return;

  // Job-valid progress only: ignore stale progress from other organizer jobs.
  const payloadId = payload?.id != null
    ? String(payload.id)
    : (payload?.jobId != null ? String(payload.jobId) : '');

  if (payloadId) {
    const activeId = organizerState.currentJobId != null ? String(organizerState.currentJobId) : '';
    if (activeId && payloadId !== activeId) return;
    if (!activeId) organizerState.currentJobId = payloadId;
  }

  updateOrganizerProgress(payload);
  showOrganizerHamster();
});

ipc?.on?.('queue-job-complete', (_e, job) => {
  if (job.panel !== PANEL_ID) return;
  if (organizerState.currentJobId && job.id !== organizerState.currentJobId) return;
  organizerState.currentJobId = null;
  if (el.cancelButton) el.cancelButton.disabled = true;
  setOrganizerInputsDisabled(false);
  setOrganizerPanelRunning(false);
  hideOrganizerHamster();
  resetOrganizerProgressUI({ hide: true });
  if (el.summary) {
    const warnings = renderProjectOrganizerMessageList(job.result?.warnings);
    const errors = renderProjectOrganizerMessageList(job.result?.errors);
    const summaryPayload = job.result?.summaryCode
      ? {
          code: job.result.summaryCode,
          params: job.result.summaryParams,
          message: job.result.summary
        }
      : null;
    let message = '';
    if (warnings.length || errors.length) {
      const lines = [];
      lines.push(
        renderProjectOrganizerMessage(summaryPayload, '') ||
          tOrganizerUi('completedWithIssues')
      );
      if (errors.length) {
        lines.push(
          tOrganizerUiCount('errorsLabel', errors.length)
        );
        errors.forEach(item => lines.push(`• ${item}`));
      }
      if (warnings.length) {
        lines.push(
          tOrganizerUiCount('warningsLabel', warnings.length)
        );
        warnings.forEach(item => lines.push(`• ${item}`));
      }
      message = lines.join('\n');
    } else {
      message =
        renderProjectOrganizerMessage(summaryPayload, '') ||
        tOrganizerUi('created');
    }
    message += getOrganizerDiagnosticFallback(job.result, 'queue-job-complete');
    setOrganizerSummary(message);
  }

});

ipc?.on?.('queue-job-failed', (_e, job) => {
  if (job.panel !== PANEL_ID) return;
  if (organizerState.currentJobId && job.id !== organizerState.currentJobId) return;
  organizerState.currentJobId = null;
  if (el.cancelButton) el.cancelButton.disabled = true;
  setOrganizerInputsDisabled(false);
  setOrganizerPanelRunning(false);
  hideOrganizerHamster();
  resetOrganizerProgressUI({ hide: true });
  if (el.summary) {
    const runtimeMessage = renderProjectOrganizerMessage(job?.result?.runtimeError, '');
    const validationMessage = renderProjectOrganizerMessage(job?.result?.validationError, '');
    const summaryMessage = runtimeMessage || validationMessage || tOrganizerUi('failed');
    const diagnostics = job?.error && typeof job.error === 'object'
      ? `

${tOrganizerUi('diagnosticsHeading')}
${JSON.stringify(job.error, null, 2)}`
      : '';
    const rawDiagnostic = getOrganizerDiagnosticFallback(job?.result, 'queue-job-failed');
    setOrganizerSummary(`${summaryMessage}${diagnostics}${rawDiagnostic}`);
  }
});

ipc?.on?.('queue-job-cancelled', (_e, job) => {
  if (job.panel !== PANEL_ID) return;
  if (organizerState.currentJobId && job.id !== organizerState.currentJobId) return;
  organizerState.currentJobId = null;
  if (el.cancelButton) el.cancelButton.disabled = true;
  setOrganizerInputsDisabled(false);
  setOrganizerPanelRunning(false);
  hideOrganizerHamster();
  resetOrganizerProgressUI({ hide: true });
  if (el.summary) {
    setOrganizerSummary(tOrganizerUi('cancelled'));
  }
});


function updateFolderAssetPaths() {
  const newAssets = createFolderAssetsStore();

  function recurse(parent, parentPath = '') {
    const items = parent.querySelectorAll(':scope > li.draggable-item');
    const possibleOldKeys = Object.keys(folderAssets);

    items.forEach(li => {
      const id = li.dataset.id;
      const localId = id.split('/').pop();
      const currentPath = parentPath ? `${parentPath}/${localId}` : id;

      const subList = li.querySelector('ul');
      if (subList) {
        recurse(subList, currentPath);
      }

      // Match only exact folder IDs
      for (const oldKey of possibleOldKeys) {
        if (oldKey === id || oldKey === currentPath) {
          if (!newAssets[currentPath]) newAssets[currentPath] = [];
          newAssets[currentPath].push(...folderAssets[oldKey]);
          break;
        }
      }
    });
  }

  recurse(el.folderList);

  // Replace old mapping
  clearFolderAssetsStore(folderAssets);
  assignFolderAssetsStore(folderAssets, newAssets);
}


let selectedFolders = [];
let customFolders = [];
const folderAssets = createFolderAssetsStore(); // key = folder ID, value = array of file paths
let draggedChildren = [];

const defaultFolders = [
  {
    id: 'PROJECT',
    label: 'Project files',
    labelKey: 'projectOrganizerFolderTooltipProject',
    groupId: 'PROJECT'
  },
  {
    id: 'MEDIA',
    label: 'Media: camera, audio, stills',
    labelKey: 'projectOrganizerFolderTooltipMedia',
    groupId: 'MEDIA'
  },
  {
    id: 'EDITOR',
    label: 'Editor workspace',
    labelKey: 'projectOrganizerFolderTooltipEditor',
    groupId: 'EDITOR'
  },
  {
    id: 'ASSIST',
    label: 'Assistant editor materials',
    labelKey: 'projectOrganizerFolderTooltipAssist',
    groupId: 'ASSIST'
  },
  {
    id: 'GFX',
    label: 'Graphics / VFX',
    labelKey: 'projectOrganizerFolderTooltipGfx',
    groupId: 'GFX'
  },
  {
    id: 'MUSIC',
    label: 'Music',
    labelKey: 'projectOrganizerFolderTooltipMusic',
    groupId: 'MUSIC'
  },
  {
    id: 'SFX',
    label: 'Sound FX',
    labelKey: 'projectOrganizerFolderTooltipSfx',
    groupId: 'SFX'
  },
  {
    id: 'MIX',
    label: 'Mix / Stems',
    labelKey: 'projectOrganizerFolderTooltipMix',
    groupId: 'MIX'
  },
  {
    id: 'COLOR',
    label: 'Color',
    labelKey: 'projectOrganizerFolderTooltipColor',
    groupId: 'COLOR'
  },
  {
    id: 'ONLINE',
    label: 'Online / Conform',
    labelKey: 'projectOrganizerFolderTooltipOnline',
    groupId: 'ONLINE'
  },
  {
    id: 'QC',
    label: 'QC notes',
    labelKey: 'projectOrganizerFolderTooltipQc',
    groupId: 'QC'
  },
  {
    id: 'EXPORTS',
    label: 'Exports / Deliverables',
    labelKey: 'projectOrganizerFolderTooltipExports',
    groupId: 'EXPORTS'
  }
];

// Preserve pristine list for full reset capability
const originalDefaultFolders = JSON.parse(JSON.stringify(defaultFolders));

// Track current order of folders. Start with the default order.
let folderOrder = defaultFolders.map(f => f.id);

// 🧩 Build folder checkboxes
function renderFolderList() {
  el.folderList.innerHTML = '';

  const all = [...defaultFolders, ...customFolders];
  const map = new Map(all.map(f => [f.id, f]));

  if (folderOrder.length === 0) {
    folderOrder = all.map(f => f.id).sort((a, b) => a.localeCompare(b));
  } else {
    folderOrder = folderOrder.filter(id => map.has(id));
    all.forEach(f => {
      if (!folderOrder.includes(f.id)) folderOrder.push(f.id);
    });
  }

  folderOrder.forEach(id => {
    const folder = map.get(id);
    if (!folder) return;

    const li = document.createElement('li');
    li.className = 'draggable-item';
    li.dataset.id = folder.id;
    // Group ID always reflects the top-most root folder
    li.dataset.groupId = folder.id.split('/')[0];

    const depth = folder.id.split('/').length - 1;

    const container = document.createElement('div');
    container.className = 'folder-row';
    // Indent by depth, but keep RIGHT edge aligned (no overflow).
    const indent = depth * 40;
    li.style.marginLeft = `${indent}px`;
    li.style.width = `calc(100% - ${indent}px)`;
    li.style.boxSizing = 'border-box';

    const labelSpan = document.createElement('span');

    if (depth > 0) {
      li.classList.add('subfolder');
      li.dataset.root = 'false';
      li.draggable = false; // 🔒 Disable dragging for subfolders
      container.classList.add('subfolder');
      labelSpan.textContent = '↳ ' + folder.id.split('/').pop();
    } else {
      li.draggable = true;
      li.dataset.root = 'true';
      li.addEventListener('dragstart', handleDragStart);
      labelSpan.textContent = folder.id;
    }

    const labelTitle = folder.labelKey
      ? translate(folder.labelKey, folder.labelFallback || folder.label || '')
      : folder.label;
    if (labelTitle) labelSpan.title = labelTitle;

    const actions = document.createElement('div');
    actions.className = 'folder-actions';

    container.appendChild(labelSpan);
    container.appendChild(actions);
    li.appendChild(container);

    // Allow dropping files directly onto this folder node
    li.addEventListener('dragover', ev => {
      if (ev.dataTransfer?.types?.includes?.('Files')) {
        ev.preventDefault();
      }
    });

    li.addEventListener('drop', async ev => {
      if (!ev.dataTransfer?.types?.includes?.('Files')) return;
      ev.preventDefault();

      const files = [...(ev.dataTransfer.files || [])];
      const targetId = li.dataset.id;
      const rawPaths = (await Promise.all(files.map(async (file, index) => {
        try {
          const resolved = await electron?.getRealPath?.(file, ev.dataTransfer, index);
          if (typeof resolved === 'string' && resolved.trim()) return resolved;
        } catch {
          // ignore and fall back
        }
        return (file && typeof file.path === 'string') ? file.path : '';
      }))).filter(Boolean);
      if (!rawPaths.length) return;

      // SECURITY: dropped file paths have not necessarily been "approved" in the
      // main process (unlike paths returned by dialog-based pickers). Our queue
      // ingestion rejects unapproved absolute paths, so we must explicitly
      // approve dropped paths before storing them into job config.
      //
      // UX: drag-and-drop is an explicit user gesture, so we treat it as user
      // verification and approve silently (no extra confirmation prompt).
      let approvedPaths = rawPaths;
      try {
        const approve = ipc.approvePaths || electron.approvePaths;
        if (typeof approve === 'function') {
          approvedPaths = await approve(rawPaths, { kind: 'file', confirm: false });
        } else if (typeof ipc.invoke === 'function') {
          approvedPaths = await ipc.invoke('approve-paths', rawPaths, { kind: 'file', confirm: false });
        }
      } catch (err) {
        const errorText = err?.message || `${err}`;
        const msg = tOrganizerUi('approveDroppedFilesFailed', { error: errorText });
        logOrganizer(msg, { isError: true });
        setOrganizerSummary(msg);
        return;
      }

      if (!approvedPaths?.length) return;
      approvedPaths = approvedPaths.map(pathValue => normalizeAssetPath(pathValue));
      if (!folderAssets[targetId]) folderAssets[targetId] = [];
      folderAssets[targetId].push(...approvedPaths);
      updateSummary();
      updateAttachmentIndicators();
    });

    // ➕ Add files button
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'add-files-btn';
    addBtn.textContent = '+';
    addBtn.title = translate('projectOrganizerAddFilesTooltip', 'Add files');
    addBtn.addEventListener('click', async ev => {
      ev.stopPropagation();
      let files = [];
      try {
        files = await ipc.selectFiles?.();
      } catch (err) {
        const errorText = err?.message || `${err}`;
        const msg = tOrganizerUi('filePickerFailed', { error: errorText });
        logOrganizer(msg, { isError: true });
        setOrganizerSummary(msg);
        return;
      }
      if (!files?.length) return;

      // 🔧 Normalize if raw filePaths were returned instead of { path }
      if (typeof files[0] === 'string') {
        files = files.map(p => ({ path: p }));
      }

      const targetId = li.dataset.id;
      const paths = files.map(f => normalizeAssetPath(f.path)).filter(Boolean);
      if (!paths.length) return;

      if (!folderAssets[targetId]) folderAssets[targetId] = [];
      folderAssets[targetId].push(...paths);

      logOrganizer(
        translate(
          'projectOrganizerAttachedFilesLog',
          `📎 Attached ${paths.length} file(s) to "${targetId}".`,
          { count: paths.length, folderId: targetId }
        ),
        { detail: paths.join('\n') }
      );

      updateSummary();
      updateAttachmentIndicators();
    });

    actions.appendChild(addBtn);

    const folderId = folder.id;

    // ➖ Remove files button
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-files-btn';
    removeBtn.textContent = '-';
    removeBtn.title = folderAssets[folderId]?.length > 0
     ? translate('projectOrganizerRemoveFilesTooltip', 'Remove attached files')
     : (folder.id.includes('/')
       ? translate('projectOrganizerRemoveSubfolderTooltip', 'Remove this subfolder')
       : translate('projectOrganizerNoFilesToRemoveTooltip', 'No files to remove'));

    removeBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      const targetId = li.dataset.id;
      const hasFiles = folderAssets[targetId]?.length > 0;

      if (hasFiles) {
        const removed = folderAssets[targetId].slice();
        delete folderAssets[targetId];
        updateSummary();
        updateAttachmentIndicators();

        logOrganizer(
          translate(
            'projectOrganizerClearedAttachedFilesLog',
            `🧹 Cleared ${removed.length} attached file(s) from ${targetId}.`,
            { count: removed.length, folderId: targetId }
          ),
          { detail: removed.join('\n') }
        );
      } else {
        // 🧹 Handle root folder and all nested subfolders
        const idsToRemove = folderOrder.filter(
          id => id === targetId || id.startsWith(`${targetId}/`)
        );

        li.style.transition = 'opacity 0.3s ease';
        li.style.opacity = '0';

        setTimeout(() => {
          idsToRemove.forEach(id => {
            customFolders = customFolders.filter(f => f.id !== id);
            const defaultIdx = defaultFolders.findIndex(f => f.id === id);
            if (defaultIdx !== -1) defaultFolders.splice(defaultIdx, 1);
            folderOrder = folderOrder.filter(f => f !== id);
            delete folderAssets[id];
          });

          logOrganizer(
            translate(
              'projectOrganizerRemovedFolderAndSubfoldersLog',
              `🗑️ Removed folder ${targetId} and ${Math.max(idsToRemove.length - 1, 0)} subfolder(s).`,
              {
                folderId: targetId,
                subfolderCount: Math.max(idsToRemove.length - 1, 0)
              }
            ),
            { detail: idsToRemove.join(', ') }
          );

          clearOrganizerSummaryWarning();
          renderFolderList();
          updateSelectedFolders();
        }, 300);
      }
    });

    actions.appendChild(removeBtn);
    
    // 📎 Paperclip goes to the LEFT of the buttons inside .folder-actions
    if (folderAssets[folderId]?.length) {
      const clip = document.createElement('span');
      clip.className = 'attachment-indicator';
      clip.textContent = '📎';
      clip.title = translate(
        'projectOrganizerAttachmentCountTooltip',
        '{{count}} attached file',
        { count: folderAssets[folderId].length }
      );
      actions.insertBefore(clip, actions.firstChild);
    }
    
li.addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) return;
  if (isOrganizerLocked()) return;

  // 🛠 Make root folders draggable again on click
  if (li.dataset.root === 'true') {
    li.setAttribute('draggable', 'true');
  } else {
    li.removeAttribute('draggable');
  }

  // 🧹 Deselect all
  el.folderList.querySelectorAll('li.draggable-item').forEach(item => {
    item.classList.remove('selected');
  });

  // ✅ Select the clicked item
  li.classList.add('selected');

  // 🔁 Update selection tracking
  updateSelectedFolders();
});

// 🧲 Drag end only on root folders
if (depth === 0) {
  li.addEventListener('dragend', handleDragEnd);
}

    el.folderList.appendChild(li);
  }); // ✅ <- This was missing

  const renderedItems = [...el.folderList.querySelectorAll('li.draggable-item')];
  selectedFolders.forEach(id => {
    const item = renderedItems.find(node => node.dataset.id === id);
    if (item) item.classList.add('selected');
  });

  updateSelectedFolders();
  updateAttachmentIndicators();
}

function refreshOrganizerLocalizedRowUi() {
  const selectedInDom = [...(el.folderList?.querySelectorAll?.('li.draggable-item.selected') || [])]
    .map(item => item.dataset.id)
    .filter(Boolean);
  const previousSelection = selectedInDom.length
    ? selectedInDom
    : (Array.isArray(selectedFolders) ? [...selectedFolders] : []);

  selectedFolders = previousSelection;
  renderFolderList();
}

function handleDragStart(e) {
  const li = e.target.closest('li.draggable-item');
  if (!li || li.dataset.root !== 'true') {
    e.preventDefault();
    return;
  }

  const groupId = li.dataset.groupId;
  li.classList.add('dragging');

  // Collect ALL nested subfolders under this root, preserving order
const rootPrefix = groupId + '/';
const allItems = [...el.folderList.querySelectorAll('li.draggable-item')];
draggedChildren = allItems.filter(item =>
  item.dataset.id.startsWith(rootPrefix) && item.dataset.id !== li.dataset.id
 );
}

async function handleDragEnd() {
  const dragging = el.folderList.querySelector('.dragging');
  if (dragging) dragging.classList.remove('dragging');
  draggedChildren = [];

  clearOrganizerSummaryWarning();
  folderOrder = [...el.folderList.querySelectorAll('li.draggable-item')].map(li => li.dataset.id);  

  updateSelectedFolders();
  updateFolderAssetPaths();

  const allItems = [...el.folderList.querySelectorAll('li.draggable-item')];
  folderOrder = allItems.map(li => li.dataset.id);

  const idMap = Object.fromEntries(customFolders.map(f => [f.id, f]));
  customFolders = await Promise.all(folderOrder.map(async id => {
    const folder = idMap[id];
    if (!folder) return null;
    const li = allItems.find(li => li.dataset.id === folder.id);
    if (!li) return folder;

    // Compute depth from the folder path (PROJECT/Child/Subchild => depth 0/1/2)
    const depth = li.dataset.id.split('/').length - 1;
    const isRootLevel = depth === 0;
    const isNested = folder.id.includes('/');

    if (isRootLevel && isNested) {
      const parent = folder.id.split('/')[0];
      const name = folder.id.split('/').pop();

      const moveLabel = translate('projectOrganizerMoveToRootButton', '');
      const removeLabel = translate('projectOrganizerRemoveFolderButton', '');
      const choice = await chooseOrganizerReparentAction({
        title: translate('projectOrganizerResolveMovedFolderTitle', ''),
        message: translate(
          'projectOrganizerReparentConfirm',
          '',
          { folderId: folder.id, parent, name }
        ),
        detail: translate(
          'projectOrganizerReparentConfirmDetail',
          '',
          { name, moveLabel, removeLabel }
        ),
        removeLabel,
        moveLabel
      });

      if (choice === 'move') {
        return { id: name, label: folder.label, groupId: name }; // Flatten to root
      }
      return null; // Remove from list
    }

    return folder;
  }));

  // Remove any null entries
  customFolders = customFolders.filter(f => f);
  renderFolderList();
  folderOrder = [...el.folderList.querySelectorAll('li.draggable-item')].map(
    li => li.dataset.id
  );
}

function updateSelectedFolders() {
  selectedFolders = [...el.folderList.querySelectorAll('li.draggable-item.selected')]
    .map(li => li.dataset.id);

  // If nothing is explicitly selected, treat all visible folders as included
  // so the generator always reflects the current structure unless the user
  // removes folders entirely.
  if (selectedFolders.length === 0) {
    selectedFolders = [...el.folderList.querySelectorAll('li.draggable-item')]
      .map(li => li.dataset.id);
  }
  if (organizerFolderValidationState?.code === ORGANIZER_FOLDER_VALIDATION_CODES.selectOneFolderToNest) {
    setOrganizerFolderValidation('');
  }
  updateSummary();
}

// ✅ Patched dragover handler
el.folderList.addEventListener('dragover', e => {
  e.preventDefault();
  const after = getDragAfterElement(e.clientY);
  const dragging = el.folderList.querySelector('.dragging');
  if (!dragging) return;

  // 🧱 Only allow drop before/after other root folders
  const isAfterRoot = after?.dataset?.root === 'true';
  if (after && !isAfterRoot) return;

  if (after == null) {
    el.folderList.appendChild(dragging);
  } else {
    after.parentElement.insertBefore(dragging, after);
  }

if (draggedChildren.length) {
  const insertAfter = dragging;
  const parent = insertAfter.parentElement;

  // Preserve visual order by reversing before insert
  [...draggedChildren].reverse().forEach(child => {
    parent.insertBefore(child, insertAfter.nextSibling);
  });
}

});

function getDragAfterElement(y) {
  const items = [...el.folderList.querySelectorAll('.draggable-item:not(.dragging)')]
    .filter(i => !draggedChildren.includes(i));
  return items.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function validateCustomFolderName(rawName) {
  const original = rawName || '';
  const trimmed = (rawName || '').trim();
  if (!trimmed) {
    return {
      ok: false,
      reasonState: { code: ORGANIZER_FOLDER_VALIDATION_CODES.folderNameEmpty }
    };
  }
  if (/[/\\]/.test(trimmed)) {
    return {
      ok: false,
      reasonState: { code: ORGANIZER_FOLDER_VALIDATION_CODES.folderNameContainsSeparator }
    };
  }
  if (trimmed.includes('..')) {
    return {
      ok: false,
      reasonState: { code: ORGANIZER_FOLDER_VALIDATION_CODES.folderNameContainsDotDot }
    };
  }
  if (/[ .]$/.test(original) || trimmed.endsWith('.')) {
    return {
      ok: false,
      reasonState: { code: ORGANIZER_FOLDER_VALIDATION_CODES.folderNameEndsWithDotOrSpace }
    };
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) {
    return {
      ok: false,
      reasonState: { code: ORGANIZER_FOLDER_VALIDATION_CODES.folderNameReservedDeviceName }
    };
  }
  const hasControlChars = Array.from(trimmed).some((ch) => ch.charCodeAt(0) < 32);
  if (/[<>:"|?*]/.test(trimmed) || hasControlChars) {
    return {
      ok: false,
      reasonState: { code: ORGANIZER_FOLDER_VALIDATION_CODES.folderNameIllegalCharacter }
    };
  }

  if (trimmed === '__proto__' || trimmed === 'prototype' || trimmed === 'constructor') {
    return {
      ok: false,
      reasonState: { code: ORGANIZER_FOLDER_VALIDATION_CODES.folderNameReservedMetaKey }
    };
  }

  return { ok: true, value: trimmed };
}

function createFolderAssetsStore() {
  return Object.create(null);
}

function clearFolderAssetsStore(store) {
  Object.keys(store).forEach(key => delete store[key]);
}

function isReservedMetaKey(key) {
  return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

function sanitizeFolderAssetEntries(entries) {
  if (!Array.isArray(entries)) return [];

  return entries
    .map(entry => {
      if (entry === null || entry === undefined) return '';
      if (typeof entry === 'symbol') return '';
      try {
        return String(entry).trim();
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

function assignFolderAssetsStore(store, value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, entries] of Object.entries(value)) {
    if (isReservedMetaKey(key)) continue;
    if (!Array.isArray(entries)) continue;
    const sanitized = sanitizeFolderAssetEntries(entries);
    if (sanitized.length > 0) {
      store[key] = [...sanitized];
    }
  }
}

function reportInvalidFolderName(reasonState) {
  const message = getOrganizerFolderValidationMessage(reasonState);
  if (!message) return;
  const errMsg = `❌ ${message}`;
  logOrganizer(errMsg, { isError: true });
  showOrganizerFolderValidation(errMsg, reasonState);
}

el.addSubfolder?.addEventListener('click', () => {
  const rawName = el.customFolderName.value;
  if (!rawName.trim()) return;

  const validation = validateCustomFolderName(rawName);
  if (!validation.ok) {
    reportInvalidFolderName(validation.reasonState);
    return;
  }
  const sanitizedName = validation.value;

  const selected = el.folderList.querySelectorAll('li.draggable-item.selected');
  if (selected.length !== 1) {
    const reasonState = { code: ORGANIZER_FOLDER_VALIDATION_CODES.selectOneFolderToNest };
    const errMsg = `❌ ${getOrganizerFolderValidationMessage(reasonState)}`;
    logOrganizer(errMsg, { isError: true });
    showOrganizerFolderValidation(errMsg, reasonState);
    return;
  }

  const base = selected[0].dataset.id;
  const fullPath = `${base}/${sanitizedName}`;
  const hasIdCollision =
    defaultFolders.some(folder => folder.id === fullPath) ||
    folderOrder.includes(fullPath);
  if (hasIdCollision) {
    reportInvalidFolderName({
      code: ORGANIZER_FOLDER_VALIDATION_CODES.folderAlreadyExists,
      params: { folderId: fullPath }
    });
    return;
  }

  if (!customFolders.some(f => f.id === fullPath)) {
    customFolders.push({
      id: fullPath,
      labelKey: CUSTOM_FOLDER_LABEL_KEY,
      labelFallback: CUSTOM_FOLDER_LABEL_FALLBACK,
      groupId: base.split('/')[0]
    });
    const idx = folderOrder.indexOf(base);
    if (idx >= 0) {
      folderOrder.splice(idx + 1, 0, fullPath);
    } else {
      folderOrder.push(fullPath);
    }
    logOrganizer(
      translate(
        'projectOrganizerAddedSubfolderLog',
        `📂 Added subfolder "${fullPath}".`,
        { folderId: fullPath }
      )
    );
  }

  setOrganizerFolderValidation('');
  el.customFolderName.value = '';
  clearOrganizerSummaryWarning();
  renderFolderList();

  // ✅ Select newly added subfolder
  const fullPathSelector = `[data-id="${CSS.escape(fullPath)}"]`;
  const newItem = el.folderList.querySelector(fullPathSelector);
  if (newItem) {
    el.folderList.querySelectorAll('li.draggable-item').forEach(item =>
      item.classList.remove('selected')
    );
    newItem.classList.add('selected');
    updateSelectedFolders();
  }
});

// ➕ Add regular (root-level) custom folder
el.addCustomFolder?.addEventListener('click', () => {
  const rawName = el.customFolderName.value;
  if (!rawName.trim()) return;

  const validation = validateCustomFolderName(rawName);
  if (!validation.ok) {
    reportInvalidFolderName(validation.reasonState);
    return;
  }
  const sanitizedName = validation.value;

  const hasIdCollision =
    defaultFolders.some(folder => folder.id === sanitizedName) ||
    folderOrder.includes(sanitizedName);
  if (hasIdCollision) {
    reportInvalidFolderName({
      code: ORGANIZER_FOLDER_VALIDATION_CODES.folderAlreadyExists,
      params: { folderId: sanitizedName }
    });
    return;
  }

  if (!customFolders.some(f => f.id === sanitizedName)) {
    customFolders.push({
      id: sanitizedName,
      labelKey: CUSTOM_FOLDER_LABEL_KEY,
      labelFallback: CUSTOM_FOLDER_LABEL_FALLBACK,
      groupId: sanitizedName
    });
    folderOrder.push(sanitizedName);
    logOrganizer(
      translate(
        'projectOrganizerAddedCustomRootFolderLog',
        `📂 Added custom root folder "${sanitizedName}".`,
        { folderId: sanitizedName }
      )
    );
  }

  el.customFolderName.value = '';
  clearOrganizerSummaryWarning();
  renderFolderList();

  // ✅ Select newly added folder
  const newItem = el.folderList.querySelector(`[data-id="${CSS.escape(sanitizedName)}"]`);
  if (newItem) {
    el.folderList.querySelectorAll('li.draggable-item').forEach(item =>
      item.classList.remove('selected')
    );
    newItem.classList.add('selected');
    updateSelectedFolders();
  }
});

// 📍 Output path selector
el.customFolderName?.addEventListener('input', () => {
  if (organizerFolderValidationState) {
    setOrganizerFolderValidation('');
  }
});

// 📍 Output path selector
el.outputBtn?.addEventListener('click', async () => {
  try {
    const folder = await ipc?.selectFolder?.();
    if (folder) {
      el.outputPath.value = folder;
      logOrganizer(
        translate(
          'projectOrganizerOutputPathSetLog',
          `📁 Output path set to: ${folder}`,
          { path: folder }
        ),
        { fileId: folder }
      );
      clearOrganizerSummaryWarning();
      updateSummary();
    }
  } catch (err) {
    const errorText = err?.message || `${err}`;
    const msg = tOrganizerUi('folderPickerFailed', { error: errorText });
    logOrganizer(msg, { isError: true });
    setOrganizerSummary(msg);
  }
});


// 🏷️ Update summary when numbering option changes
el.prependNumbers?.addEventListener('change', () => {
  clearOrganizerSummaryWarning();
  updateSummary();
});
el.rootName?.addEventListener('input', () => {
  clearOrganizerSummaryWarning();
  updateSummary();
});

// 🧹 Reset
function resetOrganizerFields() {
  hideOrganizerToast();
  setOrganizerFolderValidation('');
  clearOrganizerSummaryWarning();
  selectedFolders = [];
  customFolders = [];
  clearFolderAssetsStore(folderAssets);
  if (el.prependNumbers) el.prependNumbers.checked = true;

  // 🔁 Restore original default folders
  defaultFolders.length = 0;
  defaultFolders.push(
    ...JSON.parse(JSON.stringify(originalDefaultFolders))
  );

  folderOrder = defaultFolders.map(f => f.id);

  // 🧹 Clear all input fields
  el.customFolderName.value = '';
  el.outputPath.value = '';
  el.rootName.value = '';
  if (el.presetSelect) {
    el.presetSelect.value = '';
  }
  if (typeof setDropdownValue === 'function') {
    setDropdownValue('organizer-preset', '');
  }
  if (typeof setupStyledDropdown === 'function') {
    void refreshPresetDropdown();
  }
  logOrganizer(
    translate('projectOrganizerNoStructure', 'No structure defined yet.')
  );

  // 🖼️ Rerender list
  renderFolderList();
  updateSelectedFolders();
}

el.resetButton?.addEventListener('click', () => {
  if (window.panelPresetDefaults?.has?.('project-organizer')) {
    void window.panelPresetDefaults.resetToDefault('project-organizer')
      .then(applied => {
        if (!applied) resetOrganizerFields();
      })
      .catch(() => {
        resetOrganizerFields();
      });
    return;
  }

  resetOrganizerFields();
});

// 📊 Summary Update
function updateSummary() {
  selectedFolders = [...el.folderList.querySelectorAll('li.draggable-item')]
    .map(li => li.dataset.id);

  const rootIds = [
    ...el.folderList.querySelectorAll('li.draggable-item[data-root="true"]')
  ].map(li => li.dataset.id);
  const renameMap = {};

  rootIds.forEach((id, idx) => {
    const prefix = el.prependNumbers.checked
      ? `${String(idx + 1).padStart(2, '0')}_`
      : '';
    renameMap[id] = prefix + id;
  });

  const numbered = selectedFolders.map(name => {
    const parts = name.split('/');
    const root = parts[0];
    if (renameMap[root]) {
      parts[0] = renameMap[root];
    }
    return parts.join('/');
  });

  const rootRaw = (el.rootName?.value || '').trim();
  const root = rootRaw || tOrganizerUi('summaryOutputLocation');
  const output = el.outputPath.value || tOrganizerUi('summaryNoPath');
  const folderList = numbered.join(', ') || tOrganizerUi('summaryNone');
  const summaryLines = [
    tOrganizerUi('summaryRootFolderLine', { root }),
    tOrganizerUi('summarySelectedFoldersLine', { folders: folderList }),
    tOrganizerUi('summaryOutputPathLine', { path: output })
  ];

  numbered.forEach((name, idx) => {
    const id = selectedFolders[idx];
    if (folderAssets[id]?.length > 0) {
      const files = folderAssets[id].map(p => {
        const fileName = typeof electron.basename === 'function'
          ? electron.basename(p)
          : p.split(/[\\/]/).pop();
        return fileName;
      });
      summaryLines.push(
        tOrganizerUi('summaryAttachmentLine', { folder: name, files: files.join(', ') })
      );
    }
  });

  const summaryMsg = summaryLines.join('\n');
  const warningText = getOrganizerSummaryWarningText();
  const combinedMsg = warningText ? `${warningText}\n${summaryMsg}` : summaryMsg;
  setOrganizerSummary(combinedMsg);
}

function updateAttachmentIndicators() {
  [...el.folderList.querySelectorAll('.draggable-item')].forEach(li => {
    const id = li.dataset.id;
    const actions = li.querySelector('.folder-actions');
    if (!actions) return;
    let clip = actions.querySelector('.attachment-indicator');
    const count = folderAssets[id]?.length || 0;
    if (count > 0) {
      if (!clip) {
        clip = document.createElement('span');
        clip.className = 'attachment-indicator';
        actions.insertBefore(clip, actions.firstChild);
      }
      clip.textContent = '📎';
      clip.title = translate(
        'projectOrganizerAttachmentCountTooltip',
        '{{count}} attached file',
        { count }
      );
    } else if (clip) {
      clip.remove();
    }
  });
}

// 🧠 Generate Folder Structure
el.generateButton?.addEventListener('click', async () => {
  if (el.generateButton?.disabled) return;
  updateFolderAssetPaths();

  const rawRootName = el.rootName?.value || '';
  const trimmedRootName = rawRootName.trim();
  const outputPath = (el.outputPath?.value || '').trim();

  let rootName = '';
  if (!trimmedRootName) {
    rootName = '';
  } else {
    const rootNameValidation = validateCustomFolderName(rawRootName);
    if (!rootNameValidation.ok) {
      const errMsg = `❌ ${rootNameValidation.message}`;
      logOrganizer(errMsg, { isError: true });
      setOrganizerSummary(errMsg);
      return;
    }
    rootName = rootNameValidation.value;
  }

  // Normalize UI inputs (strip whitespace)
  if (el.rootName) el.rootName.value = rootName;
  if (el.outputPath) el.outputPath.value = outputPath;

  if (!outputPath) {
    const errMsg = tOrganizerUi('outputPathRequired');
    logOrganizer(errMsg, { isError: true });
    setOrganizerSummary(errMsg);
    return;
  }

  let outputStat = null;
  try {
    if (typeof electron?.fsStat === 'function') {
      outputStat = await electron.fsStat(outputPath);
    } else {
      outputStat = null;
    }
  } catch (error) {
    const message = error?.message ?? String(error);
    const errMsg = tOrganizerUi('outputPathAccessFailed', { error: message });
    logOrganizer(errMsg, { isError: true });
    setOrganizerSummary(errMsg);
    return;
  }

  const isOutputDir = outputStat && typeof outputStat.isDirectory === 'function'
    ? outputStat.isDirectory()
    : outputStat?.isDirectory;
  if (!isOutputDir) {
    const errMsg = tOrganizerUi('outputPathMustBeFolder');
    logOrganizer(errMsg, { isError: true });
    setOrganizerSummary(errMsg);
    return;
  }

  setOrganizerInputsDisabled(true);
  setOrganizerPanelRunning(true);

  const genMsg = tOrganizerUi('generatingStructure');
  logOrganizer(genMsg);
  setOrganizerSummary(genMsg);

  // 🔥 Make sure the hamster shows up immediately
  showOrganizerHamster();

  const snapshot = snapshotOrganizerJobState({
    selectedFolders,
    folderOrder,
    customFolders,
    folderAssets
  });

  const config = {
    rootName,
    prependNumbers: el.prependNumbers.checked,
    outputPath,
    ...snapshot
  };

  let jobId = null;
  try {
    jobId = await ipc.invoke('queue-add-project-organizer', config);
    organizerState.currentJobId = jobId;
    await ipc.invoke('queue-start');
    logOrganizer(
      translate(
        'projectOrganizerQueuedJobLog',
        `✅ Project organizer queued (Job ID: ${jobId})`,
        { jobId }
      )
    );
  } catch (err) {
    const errorText = err?.message || `${err}`;
    const errMsg = tOrganizerUi('queueFailed', { error: errorText });
    logOrganizer(errMsg, { isError: true });
    setOrganizerSummary(errMsg);
    organizerState.currentJobId = null;
    if (el.cancelButton) el.cancelButton.disabled = true;
    if (jobId) {
      try {
        await ipc.invoke('queue-cancel-job', jobId);
        logOrganizer(
          translate(
            'projectOrganizerCleanedUpQueuedJobLog',
            `🧹 Cleaned up queued organizer job ${jobId}.`,
            { jobId }
          )
        );
      } catch (cleanupErr) {
        const cleanupErrorText = cleanupErr?.message || `${cleanupErr}`;
        logOrganizer(
          translate(
            'projectOrganizerCleanupQueuedJobFailed',
            `⚠️ Failed to clean up queued organizer job ${jobId}: ${cleanupErrorText}`,
            { jobId, error: cleanupErrorText }
          ),
          { isError: true }
        );
      }
    }
    setOrganizerInputsDisabled(false);
    setOrganizerPanelRunning(false);
    hideOrganizerHamster();
    resetOrganizerProgressUI({ hide: true });
    return;
  }
});

el.cancelButton?.addEventListener('click', async () => {
  if (!organizerState.currentJobId) {
    const noJobMsg = tOrganizerUi('noJobToCancel');
    logOrganizer(noJobMsg, { isError: true });
    setOrganizerSummary(noJobMsg);
    return;
  }

  const cancelMsg = tOrganizerUi('cancelRequested');
  logOrganizer(cancelMsg);
  setOrganizerSummary(cancelMsg);
  el.cancelButton.disabled = true;

  try {
    await ipc.invoke('queue-cancel-job', organizerState.currentJobId);
  } catch (err) {
    const errorText = err?.message || `${err}`;
    const errMsg = tOrganizerUi('cancelError', { error: errorText });
    logOrganizer(errMsg, { isError: true });
    setOrganizerSummary(errMsg);
    if (organizerState.currentJobId) el.cancelButton.disabled = false;
  }
});

// 💾 Save and Load Preset
function gatherOrganizerConfig() {
  const clonedFolderAssets = createFolderAssetsStore();
  assignFolderAssetsStore(clonedFolderAssets, folderAssets);

  return {
    rootName: el.rootName.value,
    customFolderName: el.customFolderName?.value || '',
    prependNumbers: el.prependNumbers.checked,
    outputPath: el.outputPath.value,
    customFolders: customFolders.map(folder => ({ ...folder })),
    folderOrder: [...folderOrder],
    selectedFolders: [...selectedFolders],
    folderAssets: clonedFolderAssets
  };
}

function toStringArray(value, label, errors) {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      errors.push(
        translate(
          'projectOrganizerPresetArrayOfStringsRequired',
          `${label} must be an array of strings`,
          { label }
        )
      );
    }
    return [];
  }

  const cleaned = sanitizeFolderAssetEntries(value);
  if (cleaned.length !== value.length) {
    errors.push(
      translate(
        'projectOrganizerPresetNonStringEntriesRemoved',
        `${label} contained non-string entries that were removed`,
        { label }
      )
    );
  }
  return cleaned;
}

function getOrganizerPresetFieldLabel(fieldKey) {
  const labels = {
    folderOrder: translate('projectOrganizerFieldFolderOrderLabel', 'Folder order'),
    selectedFolders: translate('projectOrganizerFieldSelectedFoldersLabel', 'Selected folders'),
    folderAssets: translate('projectOrganizerFieldFolderAssetsLabel', 'Folder assets'),
    customFolders: translate('projectOrganizerFieldCustomFoldersLabel', 'Custom folders')
  };
  return labels[fieldKey] || fieldKey;
}

function getOrganizerPresetPathLabel(baseLabel, pathLabelKey, pathOptions = {}, fallback) {
  return translate(pathLabelKey, fallback, { label: baseLabel, ...pathOptions });
}

function sanitizeFolderAssets(rawAssets, errors) {
  const folderAssetsLabel = getOrganizerPresetFieldLabel('folderAssets');
  if (!rawAssets || typeof rawAssets !== 'object') {
    if (rawAssets !== undefined) {
      errors.push(
        translate(
          'projectOrganizerPresetFolderAssetsMustBeObject',
          '{{label}} must be an object',
          { label: folderAssetsLabel }
        )
      );
    }
    return createFolderAssetsStore();
  }

  const sanitized = createFolderAssetsStore();
  for (const [key, value] of Object.entries(rawAssets)) {
    if (typeof key !== 'string' || !key.trim()) {
      errors.push(
        translate(
          'projectOrganizerPresetFolderAssetsNonStringKeySkipped',
          '{{label}} contains a non-string key and it was skipped',
          { label: folderAssetsLabel }
        )
      );
      continue;
    }
    if (isReservedMetaKey(key)) {
      errors.push(
        translate(
          'projectOrganizerPresetFolderAssetsReservedMetaKeySkipped',
          '{{label}} contains reserved key "{{key}}" and it was skipped',
          { label: folderAssetsLabel, key }
        )
      );
      continue;
    }

    const entryLabel = getOrganizerPresetPathLabel(
      folderAssetsLabel,
      'projectOrganizerFieldFolderAssetsEntryLabel',
      { key },
      `${folderAssetsLabel} (${key})`
    );
    const paths = toStringArray(value, entryLabel, errors);
    if (paths.length > 0) sanitized[key] = [...paths];
  }
  return sanitized;
}

function sanitizeFolderId(rawId, label, errors) {
  if (typeof rawId !== 'string') {
    errors.push(
      translate(
        'projectOrganizerPresetMustBeString',
        `${label} must be a string`,
        { label }
      )
    );
    return null;
  }

  const normalized = rawId.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (!segments.length) {
    errors.push(
      translate(
        'projectOrganizerPresetCannotBeEmpty',
        `${label} cannot be empty`,
        { label }
      )
    );
    return null;
  }

  const sanitizedSegments = [];
  for (const segment of segments) {
    const validation = validateCustomFolderName(segment);
    if (!validation.ok) {
      const segmentErrorMessage = getOrganizerFolderValidationMessage(validation.reasonState);
      errors.push(
        translate(
          'projectOrganizerPresetInvalidSegment',
          `${label} contains invalid segment "${segment}": ${segmentErrorMessage}`,
          { label, segment, message: segmentErrorMessage }
        )
      );
      return null;
    }
    sanitizedSegments.push(validation.value);
  }

  return sanitizedSegments.join('/');
}

function sanitizeFolderIdArray(value, label, errors) {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      errors.push(
        translate(
          'projectOrganizerPresetArrayOfStringsRequired',
          `${label} must be an array of strings`,
          { label }
        )
      );
    }
    return [];
  }

  const sanitized = [];
  value.forEach((entry, index) => {
    const entryLabel = translate(
      'projectOrganizerPresetEntryAtIndexLabel',
      `${label} entry at index ${index}`,
      { label, index }
    );
    const sanitizedId = sanitizeFolderId(entry, entryLabel, errors);
    if (sanitizedId) sanitized.push(sanitizedId);
  });

  if (sanitized.length !== value.length) {
    errors.push(
      translate(
        'projectOrganizerPresetInvalidEntriesRemoved',
        `${label} contained invalid entries that were removed`,
        { label }
      )
    );
  }

  return sanitized;
}

function dedupeFolderIds(list, label, errors) {
  const seen = new Set();
  const deduped = [];
  let removed = 0;
  list.forEach(id => {
    if (seen.has(id)) {
      removed += 1;
      return;
    }
    seen.add(id);
    deduped.push(id);
  });
  if (removed > 0) {
    errors.push(
      translate(
        'projectOrganizerPresetDuplicateIdsRemoved',
        `${label} contained duplicate ids that were removed`,
        { label }
      )
    );
  }
  return deduped;
}

function dedupeCustomFolders(list, label, errors) {
  const seen = new Set();
  const deduped = [];
  let removed = 0;
  list.forEach(folder => {
    if (seen.has(folder.id)) {
      removed += 1;
      return;
    }
    seen.add(folder.id);
    deduped.push(folder);
  });
  if (removed > 0) {
    errors.push(
      translate(
        'projectOrganizerPresetDuplicateIdsRemoved',
        '{{label}} contained duplicate ids that were removed',
        { label }
      )
    );
  }
  return deduped;
}

function normalizeCustomFolderForI18n(folder) {
  if (!folder || typeof folder !== 'object') return null;
  return {
    ...folder,
    labelKey: typeof folder.labelKey === 'string' && folder.labelKey
      ? folder.labelKey
      : CUSTOM_FOLDER_LABEL_KEY,
    labelFallback: typeof folder.labelFallback === 'string' && folder.labelFallback
      ? folder.labelFallback
      : (typeof folder.label === 'string' && folder.label ? folder.label : CUSTOM_FOLDER_LABEL_FALLBACK)
  };
}

function validateOrganizerPreset(data) {
  const errors = [];
  const customFoldersLabel = getOrganizerPresetFieldLabel('customFolders');
  const folderOrderLabel = getOrganizerPresetFieldLabel('folderOrder');
  const selectedFoldersLabel = getOrganizerPresetFieldLabel('selectedFolders');
  const folderAssetsLabel = getOrganizerPresetFieldLabel('folderAssets');

  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      errors: [
        translate(
          'projectOrganizerPresetInvalidJsonObject',
          'Preset file is not a valid JSON object'
        )
      ]
    };
  }

  const sanitized = {
    rootName: typeof data.rootName === 'string' ? data.rootName : '',
    customFolderName:
      typeof data.customFolderName === 'string'
        ? data.customFolderName.trim()
        : '',
    prependNumbers: !!data.prependNumbers,
    outputPath: typeof data.outputPath === 'string' ? data.outputPath : '',
    hasFolderOrderField: Array.isArray(data.folderOrder)
  };

  sanitized.folderOrder = sanitizeFolderIdArray(
    data.folderOrder,
    folderOrderLabel,
    errors
  );
  sanitized.folderOrder = dedupeFolderIds(
    sanitized.folderOrder,
    folderOrderLabel,
    errors
  );

  if (Array.isArray(data.customFolders)) {
    sanitized.customFolders = data.customFolders
      .map((folder, index) => {
        if (
          !folder ||
          typeof folder !== 'object' ||
          typeof folder.id !== 'string' ||
          typeof folder.groupId !== 'string'
        ) {
          errors.push(
            translate(
              'projectOrganizerPresetCustomFoldersEntryInvalid',
              `${customFoldersLabel} entry at index ${index} is invalid`,
              { label: customFoldersLabel, index }
            )
          );
          return null;
        }

        const sanitizedId = sanitizeFolderId(
          folder.id,
          getOrganizerPresetPathLabel(
            customFoldersLabel,
            'projectOrganizerFieldCustomFolderIdAtIndexLabel',
            { index },
            `${customFoldersLabel} entry at index ${index} id`
          ),
          errors
        );
        if (!sanitizedId) return null;

        return {
          id: sanitizedId,
          label: typeof folder.label === 'string' ? folder.label : '',
          labelKey: typeof folder.labelKey === 'string' ? folder.labelKey : '',
          labelFallback: typeof folder.labelFallback === 'string' ? folder.labelFallback : '',
          groupId: folder.groupId
        };
      })
      .filter(Boolean);

    if (sanitized.customFolders.length !== data.customFolders.length) {
      errors.push(
        translate(
          'projectOrganizerPresetInvalidEntriesRemoved',
          '{{label}} contained invalid entries that were removed',
          { label: customFoldersLabel }
        )
      );
    }
    sanitized.customFolders = dedupeCustomFolders(
      sanitized.customFolders,
      customFoldersLabel,
      errors
    );
  } else {
    sanitized.customFolders = [];
    if (data.customFolders !== undefined) {
      errors.push(
        translate(
          'projectOrganizerPresetCustomFoldersMustBeArray',
          '{{label}} must be an array of objects',
          { label: customFoldersLabel }
        )
      );
    }
  }

  sanitized.selectedFolders = sanitizeFolderIdArray(
    data.selectedFolders,
    selectedFoldersLabel,
    errors
  );

  const baseFolderOrderIds = sanitized.hasFolderOrderField
    ? sanitized.folderOrder
    : originalDefaultFolders.map(folder => folder.id);
  const validIds = new Set([
    ...baseFolderOrderIds,
    ...sanitized.customFolders.map(folder => folder.id)
  ]);
  const originalSelectedCount = sanitized.selectedFolders.length;
  sanitized.selectedFolders = sanitized.selectedFolders.filter(id =>
    validIds.has(id)
  );
  if (sanitized.selectedFolders.length !== originalSelectedCount) {
    errors.push(
      translate(
        'projectOrganizerPresetSelectedFoldersInvalidEntries',
        '{{selectedFoldersLabel}} contained entries not in {{folderOrderLabel}} or {{customFoldersLabel}}',
        { selectedFoldersLabel, folderOrderLabel, customFoldersLabel }
      )
    );
  }

  sanitized.folderAssets = sanitizeFolderAssets(data.folderAssets, errors);
  const originalAssetKeys = Object.keys(sanitized.folderAssets);
  const filteredFolderAssets = createFolderAssetsStore();
  originalAssetKeys
    .filter(key => validIds.has(key))
    .forEach(key => {
      filteredFolderAssets[key] = sanitized.folderAssets[key];
    });
  sanitized.folderAssets = filteredFolderAssets;
  if (sanitized.folderAssets && Object.keys(sanitized.folderAssets).length !== originalAssetKeys.length) {
    errors.push(
      translate(
        'projectOrganizerPresetFolderAssetsInvalidEntriesRemoved',
        '{{folderAssetsLabel}} contained entries not in {{folderOrderLabel}} or {{customFoldersLabel}} and were removed',
        { folderAssetsLabel, folderOrderLabel, customFoldersLabel }
      )
    );
  }

  return { ok: true, sanitized, errors };
}

function isAbsolutePathLike(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('file:')) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('\\\\')) return true;
  return trimmed.startsWith('/');
}

function normalizeAssetPath(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('file:')) return value;
  try {
    const url = new URL(trimmed);
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname;
  } catch {
    return value;
  }
}

async function reapproveFolderAssets(source = {}) {
  const sourceType = typeof source?.sourceType === 'string' ? source.sourceType : 'preset';
  const sourceFile = typeof source?.sourceFile === 'string' ? source.sourceFile : '';
  const sourceLabel = sourceFile
    ? getOrganizerSourceLabel(sourceType, sourceFile)
    : getOrganizerSourceTypeLabel(sourceType);
  const warnings = [];
  const absolutePaths = [];
  let nonAbsoluteCount = 0;
  Object.values(folderAssets).forEach(list => {
    if (!Array.isArray(list)) return;
    list.forEach(p => {
      if (isAbsolutePathLike(p)) {
        absolutePaths.push(p);
      } else {
        nonAbsoluteCount += 1;
      }
    });
  });

  if (nonAbsoluteCount > 0) {
    let removedNonAbsolute = 0;
    Object.keys(folderAssets).forEach(folderId => {
      const entries = folderAssets[folderId];
      if (!Array.isArray(entries)) return;
      const kept = entries.filter(p => {
        if (isAbsolutePathLike(p)) return true;
        removedNonAbsolute += 1;
        return false;
      });
      if (kept.length) {
        folderAssets[folderId] = kept;
      } else {
        delete folderAssets[folderId];
      }
    });
    if (removedNonAbsolute > 0) {
      const warning = {
        type: 'asset-paths',
        key: 'projectOrganizerRemovedNonAbsoluteAssetPaths',
        params: { count: removedNonAbsolute, sourceType, sourceFile },
        fallback: `⚠️ Removed ${removedNonAbsolute} non-absolute asset path(s) from organizer ${sourceLabel}.`
      };
      const warnMsg = translate(warning.key, warning.fallback, warning.params);
      logOrganizer(warnMsg, { isWarning: true });
      warnings.push(warning);
    }
  }

  const uniquePaths = [...new Set(absolutePaths)];
  if (!uniquePaths.length) return warnings;

  let approvedPaths = [];
  try {
    const approve = ipc.approvePaths || electron.approvePaths;
    if (typeof approve === 'function') {
      approvedPaths = await approve(uniquePaths, { kind: 'file', confirm: true });
    } else if (typeof ipc.invoke === 'function') {
      approvedPaths = await ipc.invoke('approve-paths', uniquePaths, { kind: 'file', confirm: true });
    }
  } catch (err) {
    const errorText = err?.message || `${err}`;
    const msg = translate(
      'projectOrganizerApproveAssetPathsFailed',
      `❌ Failed to approve organizer asset paths from ${sourceLabel}: ${errorText}`,
      { sourceLabel, error: errorText }
    );
    logOrganizer(msg, { isError: true });
    setOrganizerSummary(msg);
    approvedPaths = [];
  }

  const approvedSet = new Set(Array.isArray(approvedPaths) ? approvedPaths : []);
  if (approvedSet.size === uniquePaths.length) return warnings;

  let removedCount = 0;
  Object.keys(folderAssets).forEach(folderId => {
    const entries = folderAssets[folderId];
    if (!Array.isArray(entries)) return;
    const kept = entries.filter(p => {
      if (!isAbsolutePathLike(p)) return true;
      const approved = approvedSet.has(p);
      if (!approved) removedCount += 1;
      return approved;
    });
    if (kept.length) {
      folderAssets[folderId] = kept;
    } else {
      delete folderAssets[folderId];
    }
  });

  if (removedCount > 0) {
    const warning = {
      type: 'asset-paths',
      key: 'projectOrganizerRemovedUnapprovedAssetPaths',
      params: { count: removedCount, sourceType, sourceFile },
      fallback: `⚠️ Removed ${removedCount} unapproved asset path(s) from organizer ${sourceLabel}.`
    };
    const warnMsg = translate(warning.key, warning.fallback, warning.params);
    logOrganizer(warnMsg, { isWarning: true });
    warnings.push(warning);
  }

  return warnings;
}

async function reapprovePresetOutputPath(outputPath, source = {}) {
  const sourceType = typeof source?.sourceType === 'string' ? source.sourceType : 'preset';
  const sourceFile = typeof source?.sourceFile === 'string' ? source.sourceFile : '';
  const sourceLabel = sourceFile
    ? getOrganizerSourceLabel(sourceType, sourceFile)
    : getOrganizerSourceTypeLabel(sourceType);
  if (!outputPath || !isAbsolutePathLike(outputPath)) {
    return { outputPath, warning: null };
  }

  let approvedPaths = [];
  try {
    const approve = ipc.approvePaths || electron.approvePaths;
    if (typeof approve === 'function') {
      approvedPaths = await approve([outputPath], { kind: 'dir', confirm: true });
    } else if (typeof ipc.invoke === 'function') {
      approvedPaths = await ipc.invoke('approve-paths', [outputPath], { kind: 'dir', confirm: true });
    }
  } catch (err) {
    const errorText = err?.message || `${err}`;
    const msg = translate(
      'projectOrganizerApproveOutputPathFailed',
      `❌ Failed to approve organizer output path from ${sourceLabel}: ${errorText}`,
      { sourceLabel, error: errorText }
    );
    logOrganizer(msg, { isError: true });
    setOrganizerSummary(msg);
    return { outputPath: '', warning: null };
  }

  const approvedSet = new Set(Array.isArray(approvedPaths) ? approvedPaths : []);
  if (approvedSet.has(outputPath)) {
    return { outputPath, warning: null };
  }

  const warning = {
    type: 'output-path',
    key: 'projectOrganizerUnapprovedOutputPathRemoved',
    params: { sourceType, sourceFile },
    fallback: `⚠️ Removed unapproved output path from organizer ${sourceLabel}.`
  };
  const warnMsg = translate(warning.key, warning.fallback, warning.params);
  logOrganizer(warnMsg, { isWarning: true });
  return { outputPath: '', warning };
}

function getOrganizerSourceTypeLabel(type) {
  if (type === 'config') {
    return translate('projectOrganizerSourceTypeConfig', 'config');
  }
  return translate('projectOrganizerSourceTypePreset', 'preset');
}

function getOrganizerSourceLabel(type, file) {
  const typeLabel = getOrganizerSourceTypeLabel(type);
  if (typeof file !== 'string' || !file.trim()) return typeLabel;
  return translate(
    'projectOrganizerSourceLabelWithFile',
    '{{typeLabel}} "{{file}}"',
    { typeLabel, file }
  );
}

async function applyOrganizerPreset(rawData, source = {}) {
  const sourceType = typeof source?.sourceType === 'string' ? source.sourceType : 'preset';
  const sourceFile = typeof source?.sourceFile === 'string' ? source.sourceFile : '';
  const sourceLabel = sourceFile
    ? getOrganizerSourceLabel(sourceType, sourceFile)
    : getOrganizerSourceTypeLabel(sourceType);
  const validation = validateOrganizerPreset(rawData);
  if (!validation.ok) {
    const errMsg = translate(
      'projectOrganizerUnableToApplyOrganizer',
      `❌ Unable to apply organizer ${sourceLabel}: ${validation.errors.join(', ')}`,
      { sourceLabel, errors: validation.errors.join(', ') }
    );
    logOrganizer(errMsg, { isError: true });
    showOrganizerFolderValidation(errMsg);
    return;
  }

  if (validation.errors.length) {
    const warnMsg = translate(
      'projectOrganizerInvalidDataIgnoredWarning',
      `⚠️ Organizer ${sourceLabel} contained invalid data that was ignored: ${validation.errors.join(', ')}`,
      { sourceLabel, errors: validation.errors.join(', ') }
    );
    logOrganizer(warnMsg, { isWarning: true });
  }

  const data = validation.sanitized;
  const hasFolderOrderField = !!data.hasFolderOrderField;

  if (el.rootName) el.rootName.value = data.rootName || '';
  if (el.customFolderName) el.customFolderName.value = data.customFolderName || '';
  if (el.prependNumbers) el.prependNumbers.checked = !!data.prependNumbers;
  const presetOutputPath = data.outputPath || '';
  if (el.outputPath) el.outputPath.value = presetOutputPath;
  const { outputPath: approvedOutputPath, warning: outputWarning } =
    await reapprovePresetOutputPath(presetOutputPath, { sourceType, sourceFile });
  if (el.outputPath) el.outputPath.value = approvedOutputPath;

  const rootIds = new Set();
  (data.folderOrder || []).forEach(id => rootIds.add(id.split('/')[0]));
  (data.customFolders || []).forEach(f => rootIds.add(f.id.split('/')[0]));

  defaultFolders.length = 0;
  if (!hasFolderOrderField) {
    defaultFolders.push(...originalDefaultFolders);
  } else {
    defaultFolders.push(
      ...originalDefaultFolders.filter(f => rootIds.has(f.id))
    );
  }

  customFolders = (data.customFolders || []).map(f => ({
    ...normalizeCustomFolderForI18n(f),
    groupId: f.id.split('/')[0]
  }));

  folderOrder = hasFolderOrderField
    ? data.folderOrder
    : originalDefaultFolders.map(f => f.id);
  selectedFolders = data.selectedFolders || [];

  clearFolderAssetsStore(folderAssets);
  assignFolderAssetsStore(folderAssets, data.folderAssets || {});

  const warnings = [];
  if (outputWarning) warnings.push(outputWarning);
  const assetWarnings = await reapproveFolderAssets({ sourceType, sourceFile });
  if (Array.isArray(assetWarnings) && assetWarnings.length) {
    warnings.push(...assetWarnings);
  }
  organizerSummaryWarning = warnings;
  setOrganizerFolderValidation('');

  renderFolderList();
  updateSelectedFolders();
  selectedFolders = [...el.folderList.querySelectorAll('li.draggable-item.selected')]
    .map(li => li.dataset.id);
  updateSummary();
  updateAttachmentIndicators();
  return true;
}

const presetDir = electron?.resolvePath?.('config', 'presets', 'project-organizer');
function getDefaultPresetLabel() {
  return translate('projectOrganizerDefaultPresetLabel', 'Default');
}

async function refreshPresetDropdown() {
  const hidden = el.presetSelect;
  if (!hidden) return;
  let opts = [];
  try {
    if (electron?.mkdirAsync && electron?.readdirAsync && presetDir) {
      await electron.mkdirAsync(presetDir);
      const files = (await electron.readdirAsync(presetDir)) || [];
      opts = files
        .filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.json'))
        .sort((a, b) => {
          const aDefault = !!window.panelPresetDefaults?.isDefaultPresetFile?.(a);
          const bDefault = !!window.panelPresetDefaults?.isDefaultPresetFile?.(b);
          if (aDefault !== bDefault) return aDefault ? -1 : 1;
          return String(a).localeCompare(String(b), undefined, {
            sensitivity: 'base',
            numeric: true
          });
        })
        .map(f => ({
          value: f,
          label: window.panelPresetDefaults?.isDefaultPresetFile?.(f)
            ? getDefaultPresetLabel()
            : f.replace(/\.json$/i, '')
        }));
    } else if (electron?.mkdir && electron?.readdir && presetDir) {
      // Fallback for older builds (may emit deprecation warnings).
      electron.mkdir(presetDir);
      const files = electron.readdir(presetDir) || [];
      opts = files
        .filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.json'))
        .sort((a, b) => {
          const aDefault = !!window.panelPresetDefaults?.isDefaultPresetFile?.(a);
          const bDefault = !!window.panelPresetDefaults?.isDefaultPresetFile?.(b);
          if (aDefault !== bDefault) return aDefault ? -1 : 1;
          return String(a).localeCompare(String(b), undefined, {
            sensitivity: 'base',
            numeric: true
          });
        })
        .map(f => ({
          value: f,
          label: window.panelPresetDefaults?.isDefaultPresetFile?.(f)
            ? getDefaultPresetLabel()
            : f.replace(/\.json$/i, '')
        }));
    }
  } catch (err) {
    console.error('Failed to read presets:', err);
    const errorText = err?.message || `${err}`;
    logOrganizer(
      translate(
        'projectOrganizerFailedToReadPresets',
        `❌ Failed to read organizer presets: ${errorText}`,
        { error: errorText }
      ),
      {
        isError: true
      }
    );
  }
  try {
    setupStyledDropdown('organizer-preset', opts);
    setDropdownValue('organizer-preset', hidden.value || '');
    window.translatePage?.();
  } catch (err) {
    // Prevent unhandled rejections on startup if UI helpers are unavailable.
    console.error('Failed to update preset dropdown:', err);
  }
}

// ✅ Auto-refresh preset dropdown when presets are saved or deleted
if (typeof ipc !== 'undefined' && ipc.on) {
  ipc.on('preset-saved', (_e, panelId) => {
    if (panelId === 'project-organizer') void refreshPresetDropdown();
  });
  ipc.on('preset-deleted', (_e, panelId) => {
    if (panelId === 'project-organizer') void refreshPresetDropdown();
  });
}

el.presetSelect?.addEventListener('change', async () => {
  const file = el.presetSelect.value;
  if (!file) return;
  try {
    hideOrganizerToast();
    if (!electron?.joinPath || !electron?.readTextFileAsync || !presetDir) {
      throw { code: ORGANIZER_PRESET_LOAD_ERROR_CODES.REQUIRES_ASYNC_FS };
    }
    const fullPath = electron.joinPath(presetDir, file);
    const raw = await electron.readTextFileAsync(fullPath, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      throw { code: ORGANIZER_PRESET_LOAD_ERROR_CODES.INVALID_JSON, cause: parseErr };
    }
    const applied = await applyOrganizerPreset(data, { sourceType: 'preset', sourceFile: file });
    if (!applied) return;
    logOrganizer(
      translate(
        'projectOrganizerAppliedPresetLog',
        `📚 Applied organizer preset "${file}".`,
        { file }
      ),
      { fileId: fullPath }
    );
  } catch (err) {
    console.error('Failed to load preset', err);
    const reasonText = resolveOrganizerPresetLoadReason(err);
    const errMsg = translate(
      'projectOrganizerFailedToLoadPreset',
      `❌ Failed to load preset "${file}": ${reasonText}`,
      { file, reason: reasonText }
    );
    logOrganizer(errMsg, { isError: true });
    showOrganizerToast({
      key: 'projectOrganizerFailedToLoadPreset',
      fallback: '❌ Failed to load preset "{{file}}": {{reason}}',
      params: { file, reason: reasonText },
      persistent: true,
      isError: true
    });
  }
});

el.saveConfig?.addEventListener('click', async () => {
  hideOrganizerToast();
  if (!ipc?.saveFile || !electron?.joinPath || !presetDir) {
    const msg = translate(
      'projectOrganizerSavePresetRequiresFsLog',
      '❌ Save preset requires Electron file APIs.'
    );
    logOrganizer(msg, { isError: true });
    showOrganizerToast({
      key: 'projectOrganizerSavePresetRequiresFsLog',
      fallback: '❌ Save preset requires Electron file APIs.',
      persistent: true,
      isError: true
    });
    return;
  }
  const cfg = gatherOrganizerConfig();
  const file = await ipc.saveFile({
    title: translate('projectOrganizerSavePresetTitle', 'Save Preset'),
    defaultPath: electron.joinPath(presetDir, 'organizer-config.json')
  });
  if (file) {
    try {
      if (typeof ipc.writeTextFileAtomicAsync === 'function') {
        await ipc.writeTextFileAtomicAsync(file, JSON.stringify(cfg, null, 2), 'utf8');
      } else if (typeof ipc.writeTextFileAsync === 'function') {
        await ipc.writeTextFileAsync(file, JSON.stringify(cfg, null, 2), 'utf8');
      } else {
        throw new Error(
          translate(
            'projectOrganizerWriteApiUnavailableReason',
            'writeTextFileAsync unavailable'
          )
        );
      }
      void refreshPresetDropdown();
      logOrganizer(
        translate(
          'projectOrganizerConfigSavedToFileLog',
          `💾 Organizer config saved to "${file}".`,
          { file }
        ),
        { fileId: file }
      );
      showOrganizerToast({
        key: 'projectOrganizerConfigSavedAlert',
        fallback: 'Config saved.'
      });
    } catch (err) {
      const errorText = err?.message || `${err}`;
      logOrganizer(
        translate(
          'projectOrganizerFailedToSaveConfig',
          `❌ Failed to save config to "${file}": ${errorText}`,
          { file, error: errorText }
        ),
        { isError: true }
      );
      showOrganizerToast({
        key: 'projectOrganizerConfigSaveFailedAlert',
        fallback: 'Failed to save config: {{error}}',
        params: { error: errorText },
        persistent: true,
        isError: true
      });
    }
  }
});

el.loadConfig?.addEventListener('click', async () => {
  hideOrganizerToast();
  if (!ipc?.openFile || !ipc?.readTextFileAsync) {
    const msg = translate(
      'projectOrganizerLoadPresetRequiresAsyncFsLog',
      '❌ Load preset requires Electron async file APIs.'
    );
    logOrganizer(msg, { isError: true });
    showOrganizerToast({
      key: 'projectOrganizerLoadPresetRequiresAsyncFsLog',
      fallback: '❌ Load preset requires Electron async file APIs.',
      persistent: true,
      isError: true
    });
    return;
  }
  const file = await ipc.openFile({
    title: translate('projectOrganizerLoadPresetTitle', 'Load Preset')
  });
  if (!file) return;
  try {
    const raw = await ipc.readTextFileAsync(file, 'utf8');
    const data = JSON.parse(raw);
    const applied = await applyOrganizerPreset(data, { sourceType: 'config', sourceFile: file });
    if (!applied) return;
    logOrganizer(
      translate(
        'projectOrganizerLoadedConfigLog',
        `📥 Loaded organizer config from "${file}".`,
        { file }
      ),
      { fileId: file }
    );
  } catch (err) {
    const errorText = err?.message || `${err}`;
    const errMsg = translate(
      'projectOrganizerFailedToLoadConfig',
      `❌ Failed to load config from "${file}": ${errorText}`,
      { file, error: errorText }
    );
    logOrganizer(errMsg, { isError: true });
    showOrganizerToast({
      key: 'projectOrganizerConfigLoadFailedAlert',
      fallback: 'Failed to load config: {{error}}',
      params: { error: errorText },
      persistent: true,
      isError: true
    });
  }
});

// 🔁 Init
folderOrder = defaultFolders.map(f => f.id);
renderFolderList();
void refreshPresetDropdown();

// ─── Project Organizer: panel overview tooltip ────────────────────────────
const organizerOverview = document.querySelector('#project-organizer #project-organizer-overview-tooltip');

const renderOrganizerOverviewTooltip = () => {
  if (!organizerOverview) return;

  const content = document.createElement('div');
  content.className = 'tooltip-content';

  const header = document.createElement('div');
  header.className = 'tooltip-header';
  header.textContent = translate(
    'projectOrganizerTooltipHeader',
    'PROJECT ORGANIZER — Technical Overview'
  );
  content.appendChild(header);

  const sections = [
    {
      titleKey: 'projectOrganizerTooltipSectionCore',
      titleFallback: 'Core capabilities',
      items: [
        {
          key: 'projectOrganizerTooltipCoreItem1',
          fallback: 'Defines a reusable project folder tree for shows, clients, or facilities.'
        },
        {
          key: 'projectOrganizerTooltipCoreItem2',
          fallback: 'Combines built‑in template folders with arbitrary custom folders and nested subfolders.'
        },
        {
          key: 'projectOrganizerTooltipCoreItem3',
          fallback: 'Optionally prefixes top-level folders with numeric ordering tokens.'
        }
      ]
    },
    {
      titleKey: 'projectOrganizerTooltipSectionInputs',
      titleFallback: 'Inputs / outputs',
      items: [
        {
          key: 'projectOrganizerTooltipInputsItem1',
          fallback: 'Inputs: template selection, custom folder definitions, project/root folder name, and output path.'
        },
        {
          key: 'projectOrganizerTooltipInputsItem2',
          fallback: 'Project/root folder name is optional; if blank, folders are created directly in the output path.'
        },
        {
          key: 'projectOrganizerTooltipInputsItem3',
          fallback: 'Outputs: a deterministic folder tree created on disk plus a text summary of the structure.'
        }
      ]
    },
    {
      titleKey: 'projectOrganizerTooltipSectionUnderHood',
      titleFallback: 'Under the hood',
      items: [
        {
          key: 'projectOrganizerTooltipUnderHoodItem1',
          fallback: 'Uses a simple ordered list of IDs and paths to generate folder trees for presets and jobs.'
        },
        {
          key: 'projectOrganizerTooltipUnderHoodItem2',
          fallback: 'Organizer presets snapshot the current structure so shows can share the same layout.'
        }
      ]
    }
  ];

  for (const section of sections) {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'tooltip-section';

    const subtitle = document.createElement('span');
    subtitle.className = 'tooltip-subtitle';
    subtitle.textContent = translate(section.titleKey, section.titleFallback);
    sectionEl.appendChild(subtitle);

    const list = document.createElement('ul');
    list.className = 'tooltip-list';

    for (const item of section.items) {
      const li = document.createElement('li');
      li.textContent = translate(item.key, item.fallback);
      list.appendChild(li);
    }

    sectionEl.appendChild(list);
    content.appendChild(sectionEl);
  }

  organizerOverview.replaceChildren(content);
};

const bindOrganizerTooltipI18nRefresh = () => {
  if (!organizerOverview || organizerOverview.dataset.bound) return;
  organizerOverview.dataset.bound = 'true';

  renderOrganizerOverviewTooltip();

  const attach = () => {
    const i18n = window.i18n;
    if (!i18n?.on) return false;
    try {
      i18n.on('languageChanged', renderOrganizerOverviewTooltip);
      i18n.on('initialized', renderOrganizerOverviewTooltip);
      i18n.on('loaded', renderOrganizerOverviewTooltip);
    } catch {
      // Ignore builds without evented i18n.
    }
    if (i18n.isInitialized) {
      renderOrganizerOverviewTooltip();
    }
    return true;
  };

  if (attach()) return;

  let tries = 0;
  const maxTries = 50;
  const timer = setInterval(() => {
    tries += 1;
    if (attach()) {
      clearInterval(timer);
      return;
    }
    if (tries >= maxTries) {
      clearInterval(timer);
    }
  }, 100);
};

bindOrganizerTooltipI18nRefresh();

const bindOrganizerI18nRefreshHandlers = () => {
  if (window.__LEADAE_ORGANIZER_I18N_REFRESH_BOUND__) return;

  const refreshSummaryUi = () => {
    refreshOrganizerLocalizedRowUi();
    refreshOrganizerValidationMessage();
    refreshActiveOrganizerToastText();
    updateSummary();
  };

  const refreshPresetDropdownI18n = () => {
    void refreshPresetDropdown();
  };

  const attach = () => {
    const i18n = window.i18n;
    if (!i18n?.on) return false;
    try {
      i18n.on('languageChanged', refreshSummaryUi);
      i18n.on('initialized', refreshSummaryUi);
      i18n.on('loaded', refreshSummaryUi);

      i18n.on('languageChanged', refreshPresetDropdownI18n);
      i18n.on('initialized', refreshPresetDropdownI18n);
      i18n.on('loaded', refreshPresetDropdownI18n);
    } catch {
      return false;
    }

    window.__LEADAE_ORGANIZER_I18N_REFRESH_BOUND__ = true;
    refreshSummaryUi();
    refreshPresetDropdownI18n();
    return true;
  };

  if (attach()) return;

  let tries = 0;
  const maxTries = 50;
  const timer = setInterval(() => {
    tries += 1;
    if (attach()) {
      clearInterval(timer);
      return;
    }
    if (tries >= maxTries) {
      clearInterval(timer);
    }
  }, 100);
};

bindOrganizerI18nRefreshHandlers();

if (window.panelPresetDefaults && !window.__LEAD_ORGANIZER_PRESET_DEFAULTS_REGISTERED__) {
  window.__LEAD_ORGANIZER_PRESET_DEFAULTS_REGISTERED__ = true;
  window.panelPresetDefaults.register({
    panelId: 'project-organizer',
    presetInputId: 'organizer-preset',
    refreshDropdown: () => refreshPresetDropdown(),
    applyPackagedDefaults: () => resetOrganizerFields(),
    buildPackagedDefaultPreset: () => gatherOrganizerConfig(),
    applyPreset: data => applyOrganizerPreset(data, { sourceType: 'preset', sourceFile: getDefaultPresetLabel() })
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    gatherOrganizerConfig,
    renderFolderList,
    get customFolders() { return customFolders; },
    set customFolders(val) { customFolders = val; },
    get folderOrder() { return folderOrder; },
    set folderOrder(val) { folderOrder = val; },
    get selectedFolders() {
      const selectedInDom = [...(el.folderList?.querySelectorAll?.('li.draggable-item.selected') || [])]
        .map(item => item.dataset.id)
        .filter(Boolean);
      return selectedInDom.length ? selectedInDom : selectedFolders;
    },
    set selectedFolders(val) { selectedFolders = val; },
    get folderAssets() { return folderAssets; },
    set folderAssets(val) {
      clearFolderAssetsStore(folderAssets);
      assignFolderAssetsStore(folderAssets, val);
    },
    applyOrganizerPreset,
    refreshPresetDropdown
  };
}

})();
