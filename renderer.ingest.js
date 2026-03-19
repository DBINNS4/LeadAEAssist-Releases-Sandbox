(() => {

// Watch mode utilities can be missing (or load later) depending on bundling/load order.
// Always read from window at the call site so we can degrade gracefully.
const getWatchUtils = () => window.watchUtils;
// Clone utilities can also be missing (feature gating, bundling, load failures).
const getCloneUtils = () => window.cloneUtils;
const presetDir = window.electron?.resolvePath?.('config', 'presets', 'ingest');

const PANEL_ID = 'ingest';

// Shared UI refresh hook (threading controls). Assigned in bindIngestPanelDomListeners
// once DOM refs exist. Watch Mode init calls this via the onToggle callback.
let updateControls = () => {};

const interpolateFallback = (template, options) => {
  if (!template) return '';
  if (!options) return template;
  return String(template).replace(/{{\s*([^{}\s]+)\s*}}/g, (match, token) => {
    if (Object.prototype.hasOwnProperty.call(options, token)) {
      return String(options[token]);
    }
    return match;
  });
};

const translate = (key, fallback, options) => {
  if (window.i18n?.t) {
    return window.i18n.t(key, { ...options, defaultValue: fallback ?? key });
  }
  return interpolateFallback(fallback ?? key, options);
};

const normalizeVerificationMethod = (value) => String(value || '').trim().toLowerCase();

const formatReadableVerificationMethod = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const withWordBoundaries = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withWordBoundaries) return '';
  return withWordBoundaries.replace(/\b\w/g, char => char.toUpperCase());
};

const getVerificationMethodLabel = (method) => {
  const normalizedMethod = normalizeVerificationMethod(method);
  switch (normalizedMethod) {
    case 'none':
      return translate('verificationNoneLabel', 'None');
    case 'bytecompare':
    case 'byte-compare':
    case 'byte_compare':
      return translate('byteCompare', 'Byte Compare');
    case 'blake3':
      return translate('verificationBlake3Label', 'BLAKE3');
    case 'sha256':
    case 'sha-256':
      return translate('verificationSha256Label', 'SHA-256');
    case 'md5':
      return translate('verificationMd5Label', 'MD5');
    case 'xxhash64':
    case 'xxhash-64':
    case 'xx_hash64':
      return translate('verificationXxhash64Label', 'xxHash64');
    default: {
      const genericLabel = translate('verificationMethodOtherLabel', 'Other');
      const readableMethod = formatReadableVerificationMethod(method);
      if (!readableMethod) return genericLabel;
      return translate('verificationMethodOtherWithValueLabel', '{{label}} ({{method}})', {
        label: genericLabel,
        method: readableMethod
      });
    }
  }
};

const getCloneTreePlaceholder = () => translate('cloneFolderTreePlaceholder', '📂 Folder tree will appear here...');
const getCloneTreeUnreadablePlaceholder = () => translate(
  'ingestCloneTreeUnreadablePlaceholder',
  '⚠️ Unable to read folder tree. Check permissions or choose a different folder.'
);

function isCloneTreePlaceholderState(container = document.getElementById('clone-folder-tree')) {
  if (!container) return false;
  if (container.querySelector('.tree-row, .tree-children, input[type="checkbox"]')) return false;
  if (container.dataset.cloneTreePlaceholder === '1') return true;

  const nonIndicatorChildren = Array.from(container.children)
    .filter(el => !el.classList.contains('clone-hidden-indicator'));
  if (nonIndicatorChildren.length > 0) return false;

  const text = Array.from(container.childNodes)
    .filter(node => !(node.nodeType === 1 && node.classList?.contains('clone-hidden-indicator')))
    .map(node => node.textContent || '')
    .join('')
    .trim();

  if (!text) return true;
  return text === '📂 Folder tree will appear here...' || text === getCloneTreePlaceholder();
}

function applyCloneTreePlaceholder(container = document.getElementById('clone-folder-tree')) {
  if (!container) return;
  container.textContent = getCloneTreePlaceholder();
  container.dataset.cloneTreePlaceholder = '1';
  container.dataset.cloneTreeI18nKey = 'cloneFolderTreePlaceholder';
  container.dataset.cloneTreeI18nFallback = '📂 Folder tree will appear here...';
  delete container.dataset.cloneTreeI18nParams;
}


function clearCloneTreePlaceholderMarker(container = document.getElementById('clone-folder-tree')) {
  if (!container) return;
  delete container.dataset.cloneTreePlaceholder;
  delete container.dataset.cloneTreeI18nKey;
  delete container.dataset.cloneTreeI18nFallback;
  delete container.dataset.cloneTreeI18nParams;
}

function refreshCloneTreePlaceholderI18n() {
  const container = document.getElementById('clone-folder-tree');
  if (!container) return;
  const hasRenderedTreeContent = !!container.querySelector('.tree-row, .tree-children, input[type="checkbox"]');
  if (hasRenderedTreeContent) return;

  if (container.dataset.cloneTreeI18nKey) {
    const key = container.dataset.cloneTreeI18nKey;
    const fallback = container.dataset.cloneTreeI18nFallback || container.textContent || '';
    let params;
    if (container.dataset.cloneTreeI18nParams) {
      try {
        params = JSON.parse(container.dataset.cloneTreeI18nParams);
      } catch {
        params = undefined;
      }
    }
    container.textContent = translate(key, fallback, params);
    return;
  }

  if (!isCloneTreePlaceholderState(container)) return;
  applyCloneTreePlaceholder(container);
}

function refreshCloneTreeUnreadablePlaceholderI18n() {
  refreshCloneTreePlaceholderI18n();
}

function refreshCloneUnavailableI18nState() {
  const toggle = ingestElements.enableClone;
  if (!toggle || toggle.dataset.disabledReason !== 'missing-clone-utils') return;

  const msg = translate('ingestCloneModeUnavailableModuleLog', '❌ Clone Mode is unavailable (clone module not loaded).');
  toggle.title = msg;

  const tree = document.getElementById('clone-folder-tree');
  if (!tree) return;

  // Only replace the tree body when it's currently being used to present
  // the clone-utils unavailable status (set by disableCloneMode()).
  if (tree.offsetParent === null) return;

  const treeText = (tree.textContent || '').trim();
  const wasMissingCloneUtilsState = tree.dataset.cloneUnavailableReason === 'missing-clone-utils';
  const matchesPriorUnavailableMessage = !!treeText
    && (
      treeText === (tree.dataset.cloneUnavailableMessage || '')
      || treeText === '❌ Clone Mode is unavailable (clone module not loaded).'
    );
  if (!wasMissingCloneUtilsState && !matchesPriorUnavailableMessage) return;

  tree.textContent = msg;
  tree.dataset.cloneUnavailableReason = 'missing-clone-utils';
  tree.dataset.cloneUnavailableMessage = msg;
}

const INGEST_ERROR_CODE_TO_I18N_KEY = Object.freeze({
  INGEST_PATH_VALIDATE_UNAVAILABLE: 'ingest.error.pathValidateUnavailable',
  INGEST_CALCULATE_BYTES_FAILED: 'ingest.error.calculateBytesFailed',
  INGEST_PRESET_LOAD_API_MISSING: 'ingest.error.presetLoadApiMissing',
  INGEST_WRITE_API_UNAVAILABLE: 'ingest.error.writeApiUnavailable',
  INGEST_FOLDER_TREE_TIMEOUT: 'ingest.error.folderTreeTimeout',
  INGEST_WEBHOOK_TIMEOUT: 'ingest.error.webhookTimeout',
  INGEST_WEBHOOK_NETWORK: 'ingest.error.webhookNetwork',
  INGEST_WEBHOOK_TRIGGER_FAILED: 'ingest.error.webhookTriggerFailed',
  INGEST_DESTINATION_NOT_WRITABLE: 'ingest.error.destinationNotWritable',
  INGEST_SOURCE_ACCESS_FAILED: 'ingest.error.sourceAccessFailed',
  INGEST_WATCH_FOLDER_ACCESS_FAILED: 'ingest.error.watchFolderAccessFailed',
  INGEST_BACKUP_NOT_WRITABLE: 'ingest.error.backupNotWritable',
  INGEST_UNHANDLED: 'ingest.error.unhandled'
});

const isIngestDevMode = () => (window.electron?.isPackaged === false) || (window.electron?.DEBUG_UI === true);

const ingestErrorFromCode = (code, params = {}) => {
  const key = INGEST_ERROR_CODE_TO_I18N_KEY[code] || 'ingest.error.unhandled';
  return { key, params: { ...params, code } };
};

const createIngestError = (code, params = {}, technicalMessage = '') => {
  const err = new Error(code);
  err.code = code;
  err.i18n = ingestErrorFromCode(code, params);
  if (technicalMessage) err.technicalMessage = technicalMessage;
  return err;
};


const formatStructuredIngestMessage = (message, fallback = '') => {
  if (typeof window.formatI18nMessage === 'function') {
    return window.formatI18nMessage(message, fallback);
  }
  if (!message || typeof message !== 'object') {
    return typeof message === 'string' ? message : (fallback || '');
  }
  const key = typeof message.key === 'string' ? message.key : '';
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (!key) return fallback || '';
  const translated = translate(key, key, params);
  if (translated && translated !== key) return translated;
  return interpolateFallback(fallback || key, params);
};

const resolveIngestDisplayText = (value) => {
  if (Array.isArray(value)) {
    return value.map(item => resolveIngestDisplayText(item)).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') {
    return formatStructuredIngestMessage(value);
  }
  return String(value ?? '').trim();
};

const appendIngestTechnicalDetail = (baseText, technicalDetail) => {
  const text = String(baseText || '').trim();
  const detail = String(technicalDetail || '').trim();
  if (!detail || !isIngestDevMode()) return text;
  return text ? `${text} (${detail})` : detail;
};

const getIngestUiErrorText = (err, fallbackCode = 'INGEST_UNHANDLED', params = {}) => {
  const coded = typeof err?.code === 'string' && err.code.trim() ? err.code.trim() : fallbackCode;
  const messagePayload = err?.i18n && typeof err.i18n === 'object'
    ? err.i18n
    : ingestErrorFromCode(coded, params);
  return appendIngestTechnicalDetail(
    resolveIngestDisplayText(messagePayload),
    err?.technicalMessage || err?.message || err
  );
};


async function confirmIngestAction(options) {
  const bridge = window.ipc ?? window.electron ?? null;
  try {
    if (typeof window.rendererDialogs?.confirmAction === 'function') {
      return !!(await window.rendererDialogs.confirmAction(options));
    }
    if (typeof bridge?.showConfirmDialog === 'function') {
      return !!(await bridge.showConfirmDialog(options));
    }
    if (typeof bridge?.showConfirm === 'function') {
      return !!(await bridge.showConfirm(options));
    }
    if (typeof bridge?.invoke === 'function') {
      return !!(await bridge.invoke('show-confirm-dialog', options));
    }
    console.warn('Ingest confirm dialog bridge unavailable.');
  } catch (err) {
    console.warn('Ingest confirm dialog failed:', err?.message || err);
  }
  return false;
}

async function confirmIngestTextInput(options) {
  try {
    if (typeof window.rendererDialogs?.confirmTextInput === 'function') {
      return await window.rendererDialogs.confirmTextInput(options);
    }
    console.warn('Ingest text confirmation dialog bridge unavailable.');
  } catch (err) {
    console.warn('Ingest text confirmation dialog failed:', err?.message || err);
  }
  return { confirmed: false, value: '' };
}

function ensureIngestToast() {
  let toastEl = document.getElementById('ingest-toast');
  if (toastEl) return toastEl;
  if (!document.body) return null;
  toastEl = document.createElement('div');
  toastEl.id = 'ingest-toast';
  toastEl.className = 'toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastEl);
  return toastEl;
}

function hideIngestToast() {
  const toastEl = document.getElementById('ingest-toast');
  if (showIngestToast._timer) {
    clearTimeout(showIngestToast._timer);
    showIngestToast._timer = null;
  }
  if (!toastEl) return;
  toastEl.classList.remove('show');
  toastEl.classList.remove('toast-error');
}

function showIngestToast(message, options = {}) {
  const toastEl = ensureIngestToast();
  const msg = String(message ?? '').trim();
  if (!toastEl || !msg) return;

  const persistent = !!options.persistent;
  const isError = !!options.isError;
  toastEl.textContent = msg;
  toastEl.classList.toggle('toast-error', isError);
  toastEl.classList.add('show');
  toastEl.setAttribute('role', (persistent || isError) ? 'alert' : 'status');
  toastEl.setAttribute('aria-live', (persistent || isError) ? 'assertive' : 'polite');

  if (showIngestToast._timer) {
    clearTimeout(showIngestToast._timer);
    showIngestToast._timer = null;
  }

  if (!persistent) {
    showIngestToast._timer = setTimeout(() => {
      toastEl.classList.remove('show');
      showIngestToast._timer = null;
    }, 2000);
  }
}

function initIngestHideLogToggle() {
  const cb = document.getElementById('ingest-hide-log');
  const logEl = document.getElementById('log-output');
  if (!cb || !logEl) return;

  const storageKey = 'ui.ingest.hideLogWindow';

  try {
    const saved = localStorage.getItem(storageKey);
    if (saved != null) cb.checked = saved === '1';
  } catch {}

  const apply = () => {
    const hide = !!cb.checked;
    logEl.classList.toggle('hidden', hide);
    logEl.setAttribute('aria-hidden', hide ? 'true' : 'false');
    try { localStorage.setItem(storageKey, hide ? '1' : '0'); } catch {}
  };

  cb.addEventListener('change', apply);
  apply();
}

function setButtonLabel(btn, label) {
  if (!btn) return;
  const text = String(label ?? '');
  const t = btn.querySelector?.('.button_text');
  if (t) t.textContent = text;
  else btn.textContent = text;
}

function _getButtonLabel(btn) {
  if (!btn) return '';
  const t = btn.querySelector?.('.button_text');
  return String(t?.textContent ?? btn.textContent ?? '').trim();
}

function updateThreadingControls({
  slider: threadingSlider,
  label: threadingLabel,
  enableThreads: threadingToggle,
  autoThreads: autoToggle
} = {}) {
  if (!threadingSlider || !threadingLabel) return;

  const shouldHoldDisabled = el => el?.dataset?.disabledReason || el?.dataset?.locked === 'true';
  const enabled = threadingToggle?.checked;
  const auto = autoToggle?.checked;
  if (autoToggle) {
    autoToggle.disabled = !enabled || shouldHoldDisabled(autoToggle);
  }
  threadingSlider.disabled = !enabled || auto || shouldHoldDisabled(threadingSlider);

  if (!enabled) {
    if (autoToggle) {
      autoToggle.checked = false;
      if ('prev' in autoToggle.dataset) autoToggle.dataset.prev = 'false';
    }
    threadingSlider.dataset.prevValue = threadingSlider.value;
    threadingSlider.value = '1';
    threadingLabel.textContent = '1';
    return;
  }

  if (auto) {
    threadingLabel.textContent = translate('autoLabel', 'Auto');
    return;
  }

  if ('prevValue' in threadingSlider.dataset) {
    threadingSlider.value = threadingSlider.dataset.prevValue;
    delete threadingSlider.dataset.prevValue;
  }
  threadingLabel.textContent = threadingSlider.value;
}


function panelLog(level, message, meta) {
  // DEV-only console diagnostics. Keep production users out of DevTools archaeology.
  const isDevUi = (window.electron?.isPackaged === false) || (window.electron?.DEBUG_UI === true);
  if (!isDevUi) return;

  const formatted = `[${PANEL_ID}] [${String(level || 'info').toUpperCase()}] ${message}`;
  console[level === 'error' ? 'error' : 'log'](formatted, meta || {});
}

let ingestWatchSessionRunning = false;
function setIngestWatchSessionRunning(isRunning) {
  const next = !!isRunning;
  if (next === ingestWatchSessionRunning) return;
  ingestWatchSessionRunning = next;
  try {
    window.dispatchEvent(new CustomEvent('lae:panel-running-state', {
      detail: {
        panel: PANEL_ID,
        isRunning: next,
        source: 'watch'
      }
    }));
  } catch {
    // ignore
  }
}

let currentJobId = null;
let pendingQueuedJobId = null;
let cancelPending = false;
let cancelPendingJobId = null;

const normalizeJobId = (id) => (id == null ? null : String(id));
const hasJobId = (id) => {
  const normalizedId = normalizeJobId(id);
  return normalizedId != null && normalizedId.trim() !== '';
};
const jobIdsMatch = (leftId, rightId) => {
  const left = normalizeJobId(leftId);
  const right = normalizeJobId(rightId);
  return left != null && right != null && left === right;
};
// UI phase text ("Initializing..." / "Finalizing...") — matches the Speed Test inline phase behavior.
let ingestUiPhase = 'idle'; // idle | initializing | running | finalizing | cancelling
let ingestPreviewEl = null;
const DEFAULT_CHECKSUM_METHOD = 'blake3';
let ingestPanelInitialized = false;

function resolveIngestPreviewEl() {
  if (!ingestPreviewEl || !document.body.contains(ingestPreviewEl)) {
    ingestPreviewEl = document.getElementById('ingest-job-preview-box');
  }
  return ingestPreviewEl;
}

// Build the hamster DOM structure if missing (same structure used in Adobe Automate)
function ensureHamsterStructure(root) {
  if (!root) return;
  if (root.querySelector('.wheel')) return;
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
    <div class="spoke"></div>
  `;
}

function setIngestInlineProgressActive(active) {
  const host = document.getElementById('ingest-loader-inline');
  if (!host) return;
  host.classList.toggle('is-active', !!active);
  host.setAttribute('aria-hidden', active ? 'false' : 'true');
}


function setIngestWatchEyesActive(active) {
  const host = document.getElementById('ingest-watch-eyes');
  if (!host) return;
  host.classList.toggle('is-active', !!active);
  host.setAttribute('aria-hidden', active ? 'false' : 'true');

  // The slot itself must collapse/expand so the eyes can truly center in Watch Mode
  // (and so the progress bar can use the full span when active).
  const slot = host.closest?.('.watch-eyes-slot');
  if (slot) slot.classList.toggle('is-active', !!active);
}

function showIngestHamster() {
  const status = document.getElementById('ingest-job-status');
  if (!status) return;
  let wheel = status.querySelector('.wheel-and-hamster');
  if (!wheel) {
    wheel = document.createElement('div');
    wheel.className = 'wheel-and-hamster';
    status.appendChild(wheel);
  }
  ensureHamsterStructure(wheel);
  status.classList.add('is-active');
  status.setAttribute('aria-hidden', 'false');
  status.dataset.jobActive = 'true';
}

function hideIngestHamster() {
  const status = document.getElementById('ingest-job-status');
  if (!status) return;
  delete status.dataset.jobActive;
  status.classList.remove('is-active');
  status.setAttribute('aria-hidden', 'true');
  const wheel = status.querySelector('.wheel-and-hamster');
  if (wheel) wheel.innerHTML = '';
}

function ensureEtaInline() {
  const host = document.getElementById('ingest-loader-inline');
  if (!host) return null;
  let eta = document.getElementById('ingest-eta-inline');
  if (!eta) {
    eta = document.createElement('span');
    eta.id = 'ingest-eta-inline';
    eta.className = 'eta-inline';
    host.appendChild(eta);
  }
  return eta;
}

function ensureIngestPhaseTextEl() {
  const host = document.getElementById('ingest-loader-inline');
  if (!host) return null;
  let el = document.getElementById('ingest-phase-text');
  if (!el) {
    el = document.createElement('span');
    el.id = 'ingest-phase-text';
    el.className = 'eta-inline';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.style.display = 'none';
    host.appendChild(el);
  }
  return el;
}

function syncIngestInlineTextMode() {
  const host = document.getElementById('ingest-loader-inline');
  if (!host) return;

  const bar = document.getElementById('ingest-progress');
  const out = document.getElementById('ingest-progress-output');
  const phaseEl = document.getElementById('ingest-phase-text');

  const barVisible = !!bar && bar.style.display !== 'none';
  const phaseVisible = !!phaseEl && phaseEl.style.display !== 'none' && !!phaseEl.textContent?.trim();
  const outText = out?.value?.trim() || '';
  const outIsNumeric = /^\d+(\.\d+)?$/.test(outText);
  const textOnlyMode = !barVisible && (phaseVisible || (!!outText && !outIsNumeric));

  host.classList.toggle('is-text-only', textOnlyMode);
}

function setIngestUiPhase(nextPhase, options = {}) {
  const force = !!options.force;
  if (ingestUiPhase === nextPhase && !force) return;
  ingestUiPhase = nextPhase;

  const host = document.getElementById('ingest-loader-inline');
  const bar = document.getElementById('ingest-progress');
  const out = document.getElementById('ingest-progress-output');
  const eta = document.getElementById('ingest-eta-inline');
  const phaseEl = ensureIngestPhaseTextEl();

  // Always keep the inline slot visible while a job is active.
  if (host) {
    host.classList.toggle('is-active', nextPhase !== 'idle');
  }

  if (nextPhase === 'running') {
    if (phaseEl) {
      phaseEl.classList.remove('lae-scan-text');
      phaseEl.removeAttribute('data-scan-text');
      phaseEl.textContent = '';
      phaseEl.style.display = 'none';
    }
    if (bar) bar.style.display = 'block';
    if (out) out.style.display = '';
    if (eta) {
      // ETA is handled elsewhere; do not overwrite here.
    }
    syncIngestInlineTextMode();    
    return;
  }

  if (nextPhase === 'initializing') {
    // Hide progress/percent while we do pre-copy setup (scans, preflight checks, task build).
    if (bar) bar.style.display = 'none';
    if (out) { out.value = ''; out.style.display = 'none'; }
    if (eta) eta.textContent = '';

    if (phaseEl) {
      phaseEl.style.display = '';
      const msg = translate('ingestInitializing', 'Initializing...');
      phaseEl.classList.add('lae-scan-text');
      phaseEl.setAttribute('data-scan-text', msg);
      phaseEl.textContent = msg;
    }
    syncIngestInlineTextMode();    
    return;
  }

  if (nextPhase === 'cancelling') {
    // Hide progress/percent while a cancel request is pending. Keep text centered and avoid the global output % suffix.
    if (bar) bar.style.display = 'none';
    if (out) { out.value = ''; out.style.display = 'none'; }
    if (eta) eta.textContent = '';

    if (phaseEl) {
      phaseEl.style.display = '';
      const msg = translate('ingestCancellingInline', 'Cancelling…');
      phaseEl.classList.add('lae-scan-text');
      phaseEl.setAttribute('data-scan-text', msg);
      phaseEl.textContent = msg;
    }
    syncIngestInlineTextMode();
    return;
  }

  if (nextPhase === 'finalizing') {
    // Hide progress/percent while we do post-copy work (writing logs, summaries, etc.)
    if (bar) bar.style.display = 'none';
    if (out) { out.value = ''; out.style.display = 'none'; }
    if (eta) eta.textContent = '';

    if (phaseEl) {
      phaseEl.style.display = '';
      const msg = translate('ingestFinalizing', 'Finalizing...');
      phaseEl.classList.add('lae-scan-text');
      phaseEl.setAttribute('data-scan-text', msg);
      phaseEl.textContent = msg;
    }
    syncIngestInlineTextMode();
    return;
  }

  // idle
  if (phaseEl) {
    phaseEl.classList.remove('lae-scan-text');
    phaseEl.removeAttribute('data-scan-text');
    phaseEl.textContent = '';
    phaseEl.style.display = 'none';
  }
  if (bar) { bar.style.display = 'none'; }
  if (out) { out.value = ''; out.style.display = ''; }
  syncIngestInlineTextMode();
}

function resetIngestProgressUI() {
  const bar = document.getElementById('ingest-progress');
  const out = document.getElementById('ingest-progress-output');
  if (bar) { bar.value = 0; bar.style.display = 'none'; }
  if (out) out.value = '';
  const eta = document.getElementById('ingest-eta-inline');
  if (eta) eta.textContent = '';
  setIngestInlineProgressActive(false);
  hideIngestHamster();
  setIngestUiPhase('idle');
}

function applyIngestTerminalUiTransition(terminalType, isWatchMode, resultMeta = {}) {
  const normalizedType = String(terminalType || '').toLowerCase();

  // Watch Mode UX: job ended => no active file => restore eyes if we're still watching.
  setIngestWatchEyesActive(!!isWatchMode);

  if (!isWatchMode) {
    setIngestControlsDisabled(false);
    if (ingestElements.cancelBtn) {
      ingestElements.cancelBtn.disabled = true;
      delete ingestElements.cancelBtn.dataset.watchActive;
      setButtonLabel(ingestElements.cancelBtn, translate('cancelIngest', 'Cancel'));
    }
    setButtonLabel(ingestElements.startBtn, translate('startIngest', 'Start'));
  } else if (ingestElements.cancelBtn) {
    // Watch Mode stays active between jobs.
    ingestElements.cancelBtn.disabled = false;
    ingestElements.cancelBtn.dataset.watchActive = '1';

    // Re-apply Watch Mode labels (some job lifecycle handlers can overwrite them).
    try {
      ingestElements.watchModeToggle?.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      // ignore
    }
  }

  updateIngestJobPreview();
  panelLog('log', `Applied terminal UI transition: ${normalizedType || 'unknown'}`, {
    terminalType: normalizedType,
    isWatchMode: !!isWatchMode,
    ...resultMeta
  });
}

function setIngestCancelPending(active, jobId) {
  cancelPending = !!active;
  cancelPendingJobId = active ? (jobId ?? currentJobId) : null;

  if (active) {
    setIngestUiPhase('cancelling');
    setIngestInlineProgressActive(true);
    showIngestHamster();

    const startBtn = document.getElementById('start-ingest');
    if (startBtn) startBtn.disabled = true;

    const cancelBtn = document.getElementById('cancel-ingest');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      setButtonLabel(cancelBtn, translate('ingestCancellingButton', 'Cancelling…'));
    }
    return;
  }

  const cancelBtn = document.getElementById('cancel-ingest');
  if (cancelBtn) {
    setButtonLabel(cancelBtn, translate('cancelIngest', 'Cancel'));
  }
  syncIngestInlineTextMode();  
}

async function calculateIngestBytes(cfg) {
  const res = await (window.ipc ?? window.electron).invoke('calculate-ingest-bytes', cfg);

  if (res?.success !== true) {
    throw createIngestError(
      'INGEST_CALCULATE_BYTES_FAILED',
      {},
      res?.error || translate(
        'ingest.error.calculateBytesFailedDetail',
        'calculate-ingest-bytes returned an unsuccessful response'
      )
    );
  }

  return {
    total: res?.total ?? 0,
    map: res?.map ?? {},
    fileCount: res?.fileCount ?? 0,
    folderCount: res?.folderCount ?? 0,
    truncated: !!res?.truncated,
    unreadableCount: res?.unreadableCount ?? 0
  };
}

async function fetchPathMetadata(paths) {
  const list = Array.isArray(paths)
    ? paths.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  if (!list.length) return { results: {}, mapping: {} };

  const ipcApi = window.ipc ?? window.electron;
  if (typeof ipcApi?.invoke !== 'function') {
    throw createIngestError(
      'INGEST_PATH_VALIDATE_UNAVAILABLE',
      {},
      translate(
        'ingest.error.pathValidateInvokeUnavailableDetail',
        'IPC invoke is unavailable for ingest path validation.'
      )
    );
  }

  const res = await ipcApi.invoke('ingest-validate-paths', list);
  if (res?.success !== true) {
    throw createIngestError(
      'INGEST_PATH_VALIDATE_UNAVAILABLE',
      {},
      translate(
        'ingest.error.pathValidateUnsuccessfulResponseDetail',
        'ingest-validate-paths returned an unsuccessful response'
      )
    );
  }

  return {
    results: res?.results || {},
    mapping: res?.mapping || {}
  };
}


const INGEST_PATH_META_REASON_TRANSLATION_KEYS = {
  PATH_NOT_ABSOLUTE: 'ingestPathMetaReasonPathNotAbsolute',
  PATH_NOT_WRITABLE: 'ingestPathMetaReasonPathNotWritable',
  PATH_NOT_FOUND: 'ingestPathMetaReasonPathNotFound'
};

function localizePathMetaReason(reason) {
  if (typeof reason !== 'string') return '';
  const trimmed = reason.trim();
  if (!trimmed) return '';
  const translationKey = INGEST_PATH_META_REASON_TRANSLATION_KEYS[trimmed];
  if (!translationKey) return trimmed;
  return translate(translationKey, trimmed);
}
function getPathMeta(pathMeta, inputPath) {
  const candidate = normalizePathInput(inputPath);
  if (!candidate) return {};
  const mapping = pathMeta?.mapping || {};
  const normalizedKey = mapping[candidate] || candidate;
  return pathMeta?.results?.[normalizedKey] || pathMeta?.results?.[candidate] || {};
}

function autoResizeTextArea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`; // ✅ allow full natural growth
}

function _prettyBytes(b) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(b) || 0;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(1)} ${units[idx]}`;
}

let ingestPreviewRequestToken = 0;
let ingestPreviewInFlight = null;
let ingestPreviewInFlightKey = null;
let ingestPreviewInFlightToken = 0;
let ingestPreviewPending = false;
let lastPreviewError = null;
let lastPreviewErrorAt = 0;
const previewErrorCooldownMs = 7000;
const ingestPreviewCache = {
  key: null,
  result: null
};
let cloneTreeRequestToken = 0;

function buildIngestPreviewCacheKey(cfg) {
  const normalizeArray = value => {
    if (!Array.isArray(value)) return [];
    return [...value].map(item => String(item)).sort();
  };

  const includeCache = typeof cfg.includeCache === 'boolean' ? cfg.includeCache : undefined;
  // Default behavior: exclude caches/dev folders unless explicitly included.
  const useDefaultIgnorePatterns = typeof includeCache === 'boolean'
    ? !includeCache
    : (cfg.useDefaultIgnorePatterns !== undefined ? !!cfg.useDefaultIgnorePatterns : true);

  return JSON.stringify({
    source: String(cfg.source || '').trim(),
    sourceFiles: normalizeArray(cfg.sourceFiles),
    destination: String(cfg.destination || '').trim(),
    backupPath: String(cfg.backupPath || '').trim(),
    include: cfg.filters?.include || cfg.includeExtensions || '',
    exclude: cfg.filters?.exclude || cfg.excludeExtensions || '',
    cloneMode: !!cfg.cloneMode,
    selectedFolders: normalizeArray(cfg.selectedFolders),
    foldersOnly: normalizeArray(cfg.foldersOnly),
    excludedFolders: normalizeArray(cfg.excludedFolders),
    includeSourceRoot: !!cfg.includeSourceRoot,
    includeHiddenFiles: !!cfg.includeHiddenFiles,
    useDefaultIgnorePatterns
  });
}

async function updateIngestJobPreview(options = {}) {
  const { skipEstimate = false } = options;
  const previewEl = resolveIngestPreviewEl();
  if (!previewEl) return;

  const requestToken = ++ingestPreviewRequestToken;
  const cfg = gatherIngestConfig();
  const previewCacheKey = buildIngestPreviewCacheKey(cfg);

  if (ingestPreviewInFlight && ingestPreviewInFlightKey === previewCacheKey) {
    ingestPreviewPending = true;
    return;
  }
  ingestPreviewPending = false;

  // Only show a preview if we actually have a source folder or source files
  const hasSourcePath = !!(cfg.source && cfg.source.trim());
  const hasSourceFiles = Array.isArray(cfg.sourceFiles) && cfg.sourceFiles.length > 0;
  const hasDestinationPath = !!(cfg.destination && cfg.destination.trim());

  if (!hasSourcePath && !hasSourceFiles) {
    previewEl.value = '';
    autoResizeTextArea(previewEl);
    return;
  }

  const lines = [];

  const modeTitle = cfg.cloneMode
    ? translate('ingestPreviewCloneTitle', 'Clone Job Preview')
    : translate('ingestPreviewIngestTitle', 'Ingest Job Preview');
  const onLabel = translate('ingestPreviewOn', 'on');
  const offLabel = translate('ingestPreviewOff', 'off');
  const autoLabel = translate('ingestPreviewAuto', 'Auto');
  const notSetLabel = translate('ingestPreviewNotSet', '(not set)');
  const multipleFilesLabel = translate('ingestPreviewMultipleFiles', '(multiple files)');
  const noneLabel = translate('ingestPreviewNoneValue', '(none)');
  const noUrlLabel = translate('ingestPreviewNoUrl', '(no URL)');
  lines.push(`🧾 ${modeTitle}`);
  lines.push('──────────────────────────────');

  // reuse hasSourceFiles from above
  const sourceLabel = cfg.sourceDisplayLabel || cfg.source || (hasSourceFiles ? multipleFilesLabel : notSetLabel);
  lines.push(`${translate('ingestPreviewSourceLabel', 'Source')}: ${sourceLabel}`);

  lines.push(`${translate('ingestPreviewDestinationLabel', 'Destination')}: ${cfg.destination || notSetLabel}`);
  if (cfg.dualCopy) {
    lines.push(`${translate('ingestPreviewBackupLabel', 'Backup')}: ${cfg.backupPath || notSetLabel}`);
  }

  if (!cfg.cloneMode) {
    lines.push(`${translate('ingestPreviewFlattenLabel', 'Flatten')}: ${cfg.flattenStructure ? onLabel : offLabel}`);
    lines.push(`${translate('ingestPreviewAutoFolderLabel', 'Auto-folder')}: ${cfg.autoFolder ? onLabel : offLabel}`);
  } else {
    // no per-line folder summary; totals handled below
  }

  const method = getVerificationMethodLabel(cfg.verification?.method || cfg.checksumMethod || 'none');
  lines.push(`${translate('ingestPreviewVerificationLabel', 'Verification')}: ${method}`);
  lines.push(`${translate('ingestPreviewSkipDuplicatesLabel', 'Skip duplicates')}: ${cfg.verification?.skipDuplicates ? onLabel : offLabel}`);

  lines.push(`${translate('ingestPreviewIncludeLabel', 'Include')}: ${cfg.filters?.include || cfg.includeExtensions || noneLabel}`);
  lines.push(`${translate('ingestPreviewExcludeLabel', 'Exclude')}: ${cfg.filters?.exclude || cfg.excludeExtensions || noneLabel}`);
  lines.push(`${translate('ingestPreviewIncludeHiddenLabel', 'Include hidden files')}: ${cfg.includeHiddenFiles ? onLabel : offLabel}`);
  const includeCachePreview = typeof cfg.includeCache === 'boolean'
    ? cfg.includeCache
    : !cfg.useDefaultIgnorePatterns;
  lines.push(`${translate('includeCache', 'Include Cache')}: ${includeCachePreview ? onLabel : offLabel}`);

  const threads = cfg.enableThreads
    ? (cfg.autoThreads ? autoLabel : String(cfg.maxThreads ?? 1))
    : offLabel;
  lines.push(`${translate('ingestPreviewThreadsLabel', 'Threads')}: ${threads}`);
  lines.push(`${translate('ingestPreviewRetryFailuresLabel', 'Retry failures')}: ${cfg.retryFailures ? onLabel : offLabel}`);
  lines.push(`${translate('ingestPreviewSaveLogLabel', 'Save log')}: ${cfg.saveLog ? onLabel : offLabel}`);

  lines.push(`${translate('ingestPreviewWatchModeLabel', 'Watch mode')}: ${document.getElementById('enable-watch-mode')?.checked ? onLabel : offLabel}`);
  lines.push(`${translate('ingestPreviewWatchExistingLabel', 'Process existing files on start')}: ${document.getElementById('ingest-watch-process-existing')?.checked ? onLabel : offLabel}`);
  lines.push(`${translate('ingestPreviewWebhookLabel', 'n8n webhook')}: ${cfg.enableN8N ? (cfg.n8nUrl || noUrlLabel) : offLabel}`);
  if (cfg.enableN8N) {
    lines.push(`${translate('ingestPreviewAllowPrivateLabel', 'Allow private/localhost targets')}: ${cfg.n8nAllowPrivate ? onLabel : offLabel}`);
    lines.push(`${translate('ingestPreviewWebhookLogLabel', 'n8n log')}: ${cfg.n8nLog ? onLabel : offLabel}`);
  }
  if (cfg.notes?.trim()) {
    lines.push(`${translate('ingestPreviewNotesLabel', 'Notes')}: ${cfg.notes.trim()}`);
  }

  if (!hasDestinationPath) {
    lines.push('──────────────────────────────');
    lines.push(translate('ingestPreviewPendingHeading', 'Preview pending:'));
    lines.push(translate('ingestPreviewSelectDestinationWarning', '• Select a destination to estimate job size.'));
    if (requestToken !== ingestPreviewRequestToken) return;
    previewEl.value = lines.join('\n');
    autoResizeTextArea(previewEl);
    return;
  }

  if (skipEstimate) {
    const cachedCounts = ingestPreviewCache.key === previewCacheKey ? ingestPreviewCache.result : null;
    if (cachedCounts) {
      lines.push(
        `${translate('ingestPreviewItemsLabel', 'Items')}: ${cachedCounts.fileCount || 0} ${translate('ingestPreviewFilesLabel', 'files')}, ${cachedCounts.folderCount || 0} ${translate('ingestPreviewFoldersLabel', 'folders')}`
      );
      if (cachedCounts.truncated) {
        lines.push(translate('ingestPreviewPartialEstimateWarning', '⚠️ Partial estimate: scan stopped early for performance.'));
      }
      if (cachedCounts.unreadableCount > 0) {
        lines.push(translate('ingestPreviewUnreadableEstimateWarning', '⚠️ Partial estimate: some items could not be read.'));
      }
    } else {
      lines.push('──────────────────────────────');
      lines.push(translate('ingestPreviewPendingHeading', 'Preview pending:'));
      lines.push(translate('ingestPreviewEstimateQueued', '• Updating size estimate…'));
    }
    if (requestToken !== ingestPreviewRequestToken) return;
    previewEl.value = lines.join('\n');
    autoResizeTextArea(previewEl);
    return;
  }

  try {
    let counts;
    if (ingestPreviewCache.key === previewCacheKey && ingestPreviewCache.result) {
      counts = ingestPreviewCache.result;
    } else {
      ingestPreviewInFlightKey = previewCacheKey;
      ingestPreviewInFlightToken = requestToken;
      const inFlightToken = ingestPreviewInFlightToken;
      ingestPreviewInFlight = (async () => {
        if (cfg.cloneMode && window.cloneUtils?.calculateCloneBytes) {
          const res = await window.cloneUtils.calculateCloneBytes(cfg);
          return {
            fileCount: res?.fileCount ?? res?.count ?? 0,
            folderCount: res?.folderCount ?? 0
          };
        }
        if (typeof calculateIngestBytes === 'function') {
          const {
            fileCount = 0,
            folderCount = 0,
            truncated = false,
            unreadableCount = 0
          } = await calculateIngestBytes({
            ...cfg,
            previewCacheKey,
            previewRequestId: requestToken
          });
          return { fileCount, folderCount, truncated, unreadableCount };
        }
        return { fileCount: 0, folderCount: 0, truncated: false, unreadableCount: 0 };
      })().finally(() => {
        if (ingestPreviewInFlightToken !== inFlightToken) return;
        ingestPreviewInFlight = null;
        ingestPreviewInFlightKey = null;
        if (ingestPreviewPending) {
          ingestPreviewPending = false;
          updateIngestJobPreview();
        }
      });
      counts = await ingestPreviewInFlight;
      if (requestToken !== ingestPreviewRequestToken) return;
      if (!counts?.truncated) {
        ingestPreviewCache.key = previewCacheKey;
        ingestPreviewCache.result = counts;
      }
    }
    if (requestToken !== ingestPreviewRequestToken) return;
    lines.push(
      `${translate('ingestPreviewItemsLabel', 'Items')}: ${counts.fileCount || 0} ${translate('ingestPreviewFilesLabel', 'files')}, ${counts.folderCount || 0} ${translate('ingestPreviewFoldersLabel', 'folders')}`
    );
    if (counts.truncated) {
      lines.push(translate('ingestPreviewPartialEstimateWarning', '⚠️ Partial estimate: scan stopped early for performance.'));
    }
    if (counts.unreadableCount > 0) {
      lines.push(translate('ingestPreviewUnreadableEstimateWarning', '⚠️ Partial estimate: some items could not be read.'));
    }
    lastPreviewError = null;
    lastPreviewErrorAt = 0;
  } catch (err) {
    if (requestToken !== ingestPreviewRequestToken) return;
    const errMsg = `${translate('ingestPreviewEstimateFailedPrefix', '⚠️ Failed to estimate job size:')} ${err?.message || err}`;
    const now = Date.now();
    const shouldLog = errMsg !== lastPreviewError || now - lastPreviewErrorAt > previewErrorCooldownMs;
    if (shouldLog) {
      logIngest(errMsg, { isError: true });
      lastPreviewError = errMsg;
      lastPreviewErrorAt = now;
    }
    lines.push(errMsg);
  }

  if (requestToken !== ingestPreviewRequestToken) return;
  previewEl.value = lines.join('\n');
  autoResizeTextArea(previewEl);
}

function bindIngestPreviewAutoUpdate() {
  let previewUpdateTimer;
  const schedulePreviewUpdate = (delay = 400) => {
    clearTimeout(previewUpdateTimer);
    previewUpdateTimer = setTimeout(updateIngestJobPreview, delay);
  };

  const ids = [
    'select-source','select-destination','select-backup',
    'source-path','destination-path','backup-path',
    'filter-include','filter-exclude',
    'include-hidden-files','include-cache',
    'flattenStructure','autoFolder','dualCopy',
    'checksum-method','skip-duplicates',
    'ingest-parallel','ingest-auto-threads','ingest-retry-failures',
    'concurrency-slider',
    'enable-n8n','n8n-url','n8n-allow-private','n8n-log',
    'enable-watch-mode','notes',
    'enable-clone','clone-folder-filter','clone-select-all-folders','clone-show-file-count'
  ];
  const immediatePreviewIds = new Set([
    'include-hidden-files',
    'include-cache',
    'source-path',
    'destination-path',
    'enable-n8n',
    'n8n-url',
    'notes'
  ]);

  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.dataset.previewBound) return;
    const ev = (() => {
      if (el.tagName === 'TEXTAREA') return 'input';
      if (el.tagName === 'INPUT') {
        if (['text', 'search', 'url', 'tel', 'password'].includes(el.type)) return 'input';
        if (el.type === 'range') return 'input';
        return 'change';
      }
      return 'change';
    })();
    el.addEventListener(ev, () => {
      if (immediatePreviewIds.has(id)) {
        updateIngestJobPreview({ skipEstimate: true });
        schedulePreviewUpdate(ev === 'input' ? 150 : 100);
        return;
      }
      schedulePreviewUpdate(ev === 'input' ? 400 : 250);
    });
    el.dataset.previewBound = 'true';
  });

  const tree = document.getElementById('clone-folder-tree');
  if (tree && !tree.dataset.previewBoundTree) {
    // small debounce to avoid spamming IPC
    let t;
    const schedule = () => { clearTimeout(t); t = setTimeout(updateIngestJobPreview, 200); };
    // any checkbox in the tree
    tree.addEventListener('change', e => {
      if (e.target?.matches?.('.tree-row input[type="checkbox"]')) schedule();
    });
    // expand/collapse can change per-row count badge
    tree.addEventListener('click', e => {
      if (e.target?.classList?.contains('tree-toggle')) schedule();
    });
    // custom signal from clone tree
    tree.addEventListener('clone-selection-changed', schedule);
    tree.dataset.previewBoundTree = 'true';
  }

}


// 🧼 Collapse all <details> sections on load
  document.querySelectorAll('#ingest details').forEach(section => {
    section.open = false;
  });

if (typeof ipc === 'undefined') {
  var ipc = window.ipc ?? window.electron;
}

// ===============================
// 📋 DOM References
// ===============================
const ingestElements = {
  sourceBtn: document.getElementById('select-source'),
  destBtn: document.getElementById('select-destination'),
  backupBtn: document.getElementById('select-backup'),
  startBtn: document.getElementById('start-ingest'),
  logOutput: document.getElementById('log-output'),
  cancelBtn: document.getElementById('cancel-ingest'),

  filterInclude: document.getElementById('filter-include'),
  filterExclude: document.getElementById('filter-exclude'),

  sourcePath: document.getElementById('source-path'),
  destPath: document.getElementById('destination-path'),
  backupPath: document.getElementById('backup-path'),

  dualCopy: document.getElementById('dualCopy'),
  flattenStructure: document.getElementById('flattenStructure'),
  autoFolder: document.getElementById('autoFolder'),

  enableClone: document.getElementById('enable-clone'),
  cloneOptions: document.getElementById('clone-options'),

  checksumMethod: document.getElementById('checksum-method'),
  skipDuplicates: document.getElementById('skip-duplicates'),
  includeHiddenFiles: document.getElementById('include-hidden-files'),
  includeCache: document.getElementById('include-cache'),

  saveLog: document.getElementById('saveLog'),
  hideLog: document.getElementById('ingest-hide-log'),
  notes: document.getElementById('notes'),

  enableN8N: document.getElementById('enable-n8n'),
  n8nUrl: document.getElementById('n8n-url'),
  n8nAllowPrivate: document.getElementById('n8n-allow-private'),
  n8nLog: document.getElementById('n8n-log'),

  watchModeToggle: document.getElementById('enable-watch-mode'),
  watchProcessExisting: document.getElementById('ingest-watch-process-existing'),

  enableThreads: document.getElementById('ingest-parallel'),
  autoThreads: document.getElementById('ingest-auto-threads'),
  retryFailures: document.getElementById('ingest-retry-failures'), 
  
  concurrencySlider: document.getElementById('concurrency-slider'),
  concurrencyValue: document.getElementById('concurrency-value'),
  presetSelect: document.getElementById('ingest-preset'),
  presetFallbackSelect: document.getElementById('ingest-preset-fallback'),
  saveConfigBtn: document.getElementById('ingest-save-config'),
  loadConfigBtn: document.getElementById('ingest-load-config'),
};

function renderSourceButtonLabelForWatchMode() {
  const sourceBtn = ingestElements.sourceBtn;
  if (!sourceBtn) return;
  const isWatchMode = !!ingestElements.watchModeToggle?.checked;
  const i18nKey = isWatchMode ? 'selectWatchFolder' : 'selectSource';
  const fallback = isWatchMode ? 'Select Watch Folder' : 'Select Source';
  sourceBtn.setAttribute('data-i18n', i18nKey);
  setButtonLabel(sourceBtn, translate(i18nKey, fallback));
}

const MAX_INGEST_LOG_LINES = 750;
const INGEST_LOG_PLACEHOLDER_I18N = 'logsWillAppearHere';

function isIngestLogPlaceholderSpan(node) {
  if (!node || node.nodeType !== 1) return false;
  const el = /** @type {HTMLElement} */ (node);
  if (el.tagName !== 'SPAN') return false;
  const key = el.getAttribute('data-i18n') || el.dataset?.i18n || '';
  return key === INGEST_LOG_PLACEHOLDER_I18N || el.classList.contains('lae-placeholder');
}

function isIngestLogPlaceholderOnly(logOutput) {
  if (!logOutput) return false;
  const meaningful = Array.from(logOutput.childNodes).filter(n => {
    if (n.nodeType === 3) return (n.textContent || '').trim().length > 0; // text
    return true;
  });
  return meaningful.length === 1 && isIngestLogPlaceholderSpan(meaningful[0]);
}

function clearIngestLogDom(logOutput) {
  if (!logOutput) return;
  while (logOutput.firstChild) {
    logOutput.removeChild(logOutput.firstChild);
  }
}

function ensureIngestLogPlaceholder(logOutput) {
  if (!logOutput) return;
  // If it's already placeholder-only, leave it.
  if (isIngestLogPlaceholderOnly(logOutput)) return;
  // If it has any real content, don't inject a placeholder.
  const hasContent = Array.from(logOutput.childNodes).some(n => {
    if (n.nodeType === 3) return (n.textContent || '').trim().length > 0;
    return true;
  });
  if (hasContent) return;

  const span = document.createElement('span');
  span.className = 'lae-placeholder';
  span.setAttribute('data-i18n', INGEST_LOG_PLACEHOLDER_I18N);
  span.textContent = translate(INGEST_LOG_PLACEHOLDER_I18N, 'Logs will appear here...');
  logOutput.appendChild(span);
  // If translations are already booted, update immediately.
  window.translatePage?.();
}

function stripIngestLogPlaceholder(logOutput) {
  if (!logOutput) return;
  if (!isIngestLogPlaceholderOnly(logOutput)) return;
  clearIngestLogDom(logOutput);
}

function pruneIngestLog(logOutput, maxLines) {
  const spans = Array.from(logOutput.querySelectorAll('span')).filter(s => {
    const key = s.getAttribute('data-i18n') || s.dataset?.i18n || '';
    return !(key === INGEST_LOG_PLACEHOLDER_I18N || s.classList.contains('lae-placeholder'));
  });
  let excess = spans.length - maxLines;
  while (excess > 0) {
    const firstSpan = spans.shift();
    if (!firstSpan) break;
    const nextNode = firstSpan.nextSibling;
    logOutput.removeChild(firstSpan);
    if (nextNode && nextNode.nodeName === 'BR') {
      logOutput.removeChild(nextNode);
    }
    excess -= 1;
  }
}

function updateIngestLog(msg, opts = {}) {
  const logOutput = ingestElements.logOutput;
  if (!logOutput) return;
  if (opts.clear) {
    clearIngestLogDom(logOutput);
  }
  const text = resolveIngestDisplayText(msg);
  if (!text) {
    // When cleared or still empty, keep the same placeholder copy used by Transcode.
    ensureIngestLogPlaceholder(logOutput);
    return;
  }

  // First real log line should replace the placeholder, not append after it.
  stripIngestLogPlaceholder(logOutput);

  const lines = text.split(/\r?\n/);
  lines.forEach(line => {
    if (logOutput.childNodes.length > 0) {
      logOutput.appendChild(document.createElement('br'));
    }
    const span = document.createElement('span');
    span.textContent = `${opts.prefix ?? ''}${line}`;
    if (opts.color) {
      span.style.color = opts.color;
    } else if (opts.isError) {
      span.style.color = 'red';
    }
    logOutput.appendChild(span);
  });
  pruneIngestLog(logOutput, MAX_INGEST_LOG_LINES);
  logOutput.scrollTop = logOutput.scrollHeight;
}

function showValidationError(msg) {
  logIngest(msg, { isError: true });
}

function appendIngestLogLine(msg, opts = {}) {
  updateIngestLog(msg, opts);
}

function logIngest(msg, opts = {}) {
  if (window.logPanel?.log) {
    window.logPanel.log('ingest', msg, opts);
  }
  updateIngestLog(msg, opts);
}

function disableCloneMode(reason, opts = {}) {
  const { disableToggle = true } = opts || {};
  const msg = String(reason ?? '').trim()
    || translate('cloneModeDisableFallbackReason', 'Clone Mode is unavailable.');

  // Clear selection globals so downstream config doesn't accidentally reuse stale state.
  window.cloneSelectedFolders = [];
  window.cloneFoldersOnly = [];
  window.cloneExcluded = [];
  window.cloneIncludeSourceRoot = false;

  // Clear/annotate the clone tree surface (if present).
  const tree = document.getElementById('clone-folder-tree');
  if (tree) {
    tree.innerHTML = '';
    clearCloneTreePlaceholderMarker(tree);
    tree.textContent = msg;
    if (disableToggle) {
      tree.dataset.cloneUnavailableReason = 'missing-clone-utils';
      tree.dataset.cloneUnavailableMessage = msg;
    } else {
      delete tree.dataset.cloneUnavailableReason;
      delete tree.dataset.cloneUnavailableMessage;
    }
  }

  // Turn off Clone Mode and optionally disable the toggle to prevent repeated failures.
  const toggle = ingestElements.enableClone;
  if (toggle) {
    toggle.checked = false;
    if (disableToggle) {
      toggle.disabled = true;
      toggle.dataset.disabledReason = 'missing-clone-utils';
      toggle.title = msg;
    }
    // Re-run the existing change handler so UI state stays consistent.
    try {
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      // non-fatal
    }
  }

  // Ensure style/state flips back even if the change event couldn't dispatch.
  document.getElementById('ingest')?.classList.remove('clone-mode');

  // Keep preview in sync.
  try {
    updateIngestJobPreview?.();
  } catch {
    // non-fatal
  }
}

// If clone utils load after the panel initializes, re-enable the toggle if we disabled it.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('clone-utils-ready', () => {
    const toggle = ingestElements.enableClone;
    if (!toggle) return;
    if (toggle.dataset.disabledReason === 'missing-clone-utils') {
      toggle.disabled = false;
      toggle.title = '';
      delete toggle.dataset.disabledReason;
      const tree = document.getElementById('clone-folder-tree');
      if (tree?.dataset.cloneUnavailableReason === 'missing-clone-utils') {
        delete tree.dataset.cloneUnavailableReason;
        delete tree.dataset.cloneUnavailableMessage;
      }
    }
  });
}

async function refreshCloneTreeFromSource(sourcePath, options = {}) {
  const requestToken = ++cloneTreeRequestToken;
  const enabled = ingestElements.enableClone?.checked;
  const src = (sourcePath ?? ingestElements.sourcePath?.value ?? '').trim();
  const container = document.getElementById('clone-folder-tree');
  const selectAllEl = document.getElementById('clone-select-all-folders');
  const { preserveSelection = false, includeSourceRoot } = options;
  const includeHiddenFiles = !!ingestElements.includeHiddenFiles?.checked;
  const includeCache = !!ingestElements.includeCache?.checked;
  const requestSnapshot = { src, includeHiddenFiles, includeCache };

  const cu = getCloneUtils();
  const timeoutMs = 15000;
  const isStaleRequest = () => requestToken !== cloneTreeRequestToken
    || requestSnapshot.src !== (ingestElements.sourcePath?.value ?? '').trim()
    || requestSnapshot.includeHiddenFiles !== !!ingestElements.includeHiddenFiles?.checked
    || requestSnapshot.includeCache !== !!ingestElements.includeCache?.checked;

  const clearCloneState = (message, i18n = null) => {
    if (container) {
      container.innerHTML = '';
      clearCloneTreePlaceholderMarker(container);
      delete container.dataset.cloneTreeState;
    }
    if (selectAllEl) selectAllEl.checked = false;
    if (!preserveSelection) {
      window.cloneSelectedFolders = [];
      window.cloneFoldersOnly = [];
      window.cloneExcluded = [];
      window.cloneIncludeSourceRoot = false;
    } else if (typeof includeSourceRoot === 'boolean') {
      window.cloneIncludeSourceRoot = includeSourceRoot;
    }
    if (container && window.cloneUtils?.renderFolderTree) {
      const rootLabel = translate('cloneTreeRootLabel', 'Source');
      window.cloneUtils.renderFolderTree({ name: src || rootLabel, path: '', children: [] }, container);
    }
    if (container && message) {
      clearCloneTreePlaceholderMarker(container);
      container.textContent = message;
      if (i18n?.key) {
        container.dataset.cloneTreeI18nKey = i18n.key;
        container.dataset.cloneTreeI18nFallback = i18n.fallback || message;
        if (i18n.params && typeof i18n.params === 'object') {
          container.dataset.cloneTreeI18nParams = JSON.stringify(i18n.params);
        } else {
          delete container.dataset.cloneTreeI18nParams;
        }
      }
      if (
        message === getCloneTreeUnreadablePlaceholder()
        || message === '⚠️ Unable to read folder tree. Check permissions or choose a different folder.'
      ) {
        container.dataset.cloneTreeState = 'unreadable-placeholder';
      }
    }
    updateCloneHiddenIndicator();
    cu?.updateCountsUI?.();
  };

  // Reset selection state when the source changes unless preserving a preset selection.
  clearCloneState();

  if (!enabled || !src) {
    return;
  }

  const { isFileSelection } = getSourceSelectionInfo(sourcePath);
  if (isFileSelection) {
    const msg = warnCloneModeRequiresFolder();
    if (ingestElements.enableClone) ingestElements.enableClone.checked = false;
    setCloneModeState(false);
    clearCloneState(msg, {
      key: 'ingestCloneModeRequiresFolderValidation',
      fallback: '⚠️ Clone Mode requires a folder; please select a source folder.'
    });
    updateIngestJobPreview();
    return;
  }

  if (typeof cu?.renderFolderTree !== 'function') {
    const msg = translate('ingestCloneModeUnavailableModuleLog', '❌ Clone Mode is unavailable (clone module not loaded).');
    showValidationError(msg);
    disableCloneMode(msg);
    return;
  }

  try {
    const result = await Promise.race([
      ipc.invoke('get-folder-tree', {
        rootPath: src,
        depth: 1,
        limit: 200,
        includeHiddenFiles,
        includeCache
      }),
      new Promise((_, reject) =>
        setTimeout(() => {
          const err = new Error('INGEST_FOLDER_TREE_TIMEOUT');
          err.code = 'INGEST_FOLDER_TREE_TIMEOUT';
          err.detail = { key: 'ingest.error.folderTreeTimeoutDetail' };
          reject(err);
        }, timeoutMs)
      )
    ]);
    if (isStaleRequest()) return;
    if (result?.success) {
      if (container) {
        container.innerHTML = '';
        clearCloneTreePlaceholderMarker(container);
        updateCloneHiddenIndicator();
        cu.renderFolderTree(result.tree, container);
        cu?.updateCountsUI?.();
      }
      if (result?.meta?.unreadableDirCount) {
        const warnMsg = translate(
          'ingestCloneTreeUnreadableFoldersWarningLog',
          '⚠️ {{count}} folder(s) could not be read due to permissions.',
          { count: result.meta.unreadableDirCount }
        );
        logIngest(warnMsg);
      }
      if (result?.meta?.truncated) {
        const warnMsg = translate(
          'ingestCloneTreeTruncatedWarningLog',
          '⚠️ Folder tree truncated. Expand folders or use "Load more" to continue.'
        );
        logIngest(warnMsg);
      }
    } else {
      const errMsg = resolveIngestDisplayText(result?.error) || translate('ingestFolderTreeUnableToFetch', 'Unable to fetch folder tree');
      const msg = translate('ingestFolderTreeFailedToLoad', '❌ Failed to load folder tree: {{error}}', { error: errMsg });
      const placeholder = getCloneTreeUnreadablePlaceholder();
      logIngest(msg);
      panelLog('error', 'Failed to load folder tree', { error: errMsg });
      clearCloneState(placeholder, {
        key: 'ingestCloneTreeUnreadablePlaceholder',
        fallback: '⚠️ Unable to read folder tree. Check permissions or choose a different folder.'
      });
    }
  } catch (err) {
    if (isStaleRequest()) return;
    const errorCode = typeof err?.code === 'string' ? err.code.trim() : '';
    const messagePayload = errorCode
      ? ingestErrorFromCode(errorCode)
      : ingestErrorFromCode('INGEST_UNHANDLED');
    const detailPayload = err?.detail && typeof err.detail === 'object'
      ? err.detail
      : messagePayload;
    const msg = translate('ingestFolderTreeFailedToLoad', '❌ Failed to load folder tree: {{error}}', {
      error: appendIngestTechnicalDetail(resolveIngestDisplayText(detailPayload), err?.message || err)
    });
    const placeholder = getCloneTreeUnreadablePlaceholder();
    logIngest(msg);
    panelLog('error', 'Failed to load folder tree', { error: err?.message || err });
    clearCloneState(placeholder, {
      key: 'ingestCloneTreeUnreadablePlaceholder',
      fallback: '⚠️ Unable to read folder tree. Check permissions or choose a different folder.'
    });
  }
}

function updateCloneHiddenIndicator() {
  const container = document.getElementById('clone-folder-tree');
  if (!container) return;
  const includeHidden = !!ingestElements.includeHiddenFiles?.checked;
  let indicator = container.querySelector('.clone-hidden-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'clone-hidden-indicator';
  }
  indicator.textContent = includeHidden
    ? translate('cloneHiddenItemsIncluded', 'Hidden items included.')
    : '';
  indicator.style.display = includeHidden ? '' : 'none';
  if (!indicator.parentNode) {
    container.prepend(indicator);
  }
}

ingestElements.enableClone?.addEventListener('change', async () => {
  const enabled = ingestElements.enableClone.checked;
  if (enabled) {
    const { isFileSelection } = getSourceSelectionInfo();
    if (isFileSelection) {
      warnCloneModeRequiresFolder();
      ingestElements.enableClone.checked = false;
      setCloneModeState(false);
      updateIngestJobPreview();
      return;
    }
    const watchToggle = ingestElements.watchModeToggle;
    const isWatchActive = !!watchToggle?.checked;
    if (isWatchActive) {
      const wu = getWatchUtils();
      if (typeof wu?.stopWatch !== 'function') {
        const msg = translate(
          'ingestCloneModeStopWatchBeforeEnableValidation',
          '⚠️ Stop Watch Mode before enabling Clone Mode.'
        );
        showValidationError(msg);
        ingestElements.enableClone.checked = false;
        setCloneModeState(false);
        updateIngestJobPreview();
        return;
      }
      try {
        await wu.stopWatch('ingest');
      } catch (e) {
        const errMsg = translate('ingestCloneModeStopWatchFailedValidation', '❌ Unable to stop Watch Mode: {{error}}', {
          error: e?.message || e
        });
        showValidationError(errMsg);
        ingestElements.enableClone.checked = false;
        setCloneModeState(false);
        updateIngestJobPreview();
        return;
      }
      if (watchToggle) {
        watchToggle.checked = false;
        try { watchToggle.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
      }
      ingestElements.startBtn.disabled = false;
      ingestElements.cancelBtn.disabled = true;
      setButtonLabel(ingestElements.startBtn, translate('startIngest', 'Start'));
      setButtonLabel(ingestElements.cancelBtn, translate('cancelIngest', 'Cancel'));
      setIngestWatchEyesActive(false);
    }
  }
  const modeMsg = enabled
    ? translate('ingestCloneModeEnabledLog', '🧬 Clone mode enabled.')
    : translate('ingestIngestModeEnabledLog', '📥 Ingest mode enabled.');
  logIngest(modeMsg);
  setCloneModeState(enabled);
  if (enabled && ingestElements.sourcePath.value) {
    refreshCloneTreeFromSource();
  }
  updateIngestJobPreview();
});

ingestElements.includeHiddenFiles?.addEventListener('change', () => {
  updateCloneHiddenIndicator();
  if (ingestElements.enableClone?.checked && ingestElements.sourcePath?.value) {
    refreshCloneTreeFromSource(undefined, { preserveSelection: true });
  }
});

ingestElements.includeCache?.addEventListener('change', () => {
  if (ingestElements.enableClone?.checked && ingestElements.sourcePath?.value) {
    refreshCloneTreeFromSource(undefined, { preserveSelection: true });
  }
});

// --- Select All (Clone) ---
const selectAll = document.getElementById('clone-select-all-folders');
if (selectAll) {
  selectAll.addEventListener('change', () => {
    const tree = document.getElementById('clone-folder-tree');
    if (!tree) return;
    tree.querySelectorAll('.tree-row input[type="checkbox"]').forEach(cb => {
      cb.indeterminate = false;
      cb.classList.remove('partial');
      cb.checked = selectAll.checked;
      // mark as programmatic bulk change so clone-utils will honor it
      cb.dataset.bulk = '1';
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

// --- Filter folders live ---
const folderFilter = document.getElementById('clone-folder-filter');
if (folderFilter) {
  folderFilter.addEventListener('input', () => {
    const tree = document.getElementById('clone-folder-tree');
    if (!tree) return;
    const query = folderFilter.value.toLowerCase().trim();
    tree.querySelectorAll('.tree-row').forEach(row => {
      const labelText = row.querySelector('.tree-label')?.textContent?.toLowerCase() || '';
      const directMatch = !query || labelText.includes(query);
      const siblingContainer = row.nextElementSibling;
      let descendantMatch = false;
      if (!directMatch && siblingContainer?.classList.contains('tree-children')) {
        descendantMatch = Array.from(
          siblingContainer.querySelectorAll('.tree-row .tree-label')
        ).some(lbl => (lbl.textContent || '').toLowerCase().includes(query));
      }
      const shouldShow = directMatch || descendantMatch;
      row.style.display = shouldShow ? '' : 'none';
      if (siblingContainer?.classList.contains('tree-children')) {
        siblingContainer.style.display = shouldShow ? '' : 'none';
      }
    });
  });
}

// --- Show file count (Clone) ---
const showCount = document.getElementById('clone-show-file-count');
if (showCount) {
  showCount.addEventListener('change', async () => {
    getCloneUtils()?.updateCountsUI?.();
    if (!showCount.checked) {
      updateIngestJobPreview();
      return;
    }

    try {
      const cfg = gatherIngestConfig();
      if (!cfg || !cfg.cloneMode) {
        updateIngestJobPreview();
        return;
      }
      if (!window.cloneUtils?.calculateCloneBytes) {
        updateIngestJobPreview();
        return;
      }
      await window.cloneUtils.calculateCloneBytes(cfg);
      updateIngestJobPreview();
    } catch (err) {
      const msg = translate(
        'ingestCloneBytesCalculateFailedLog',
        '❌ Failed to calculate clone bytes: {{error}}',
        { error: err?.message || err }
      );
      logIngest(msg, { isError: true });
      panelLog('error', 'Failed to calculate clone bytes', { error: err?.message || err });
      updateIngestJobPreview();
    }
  });
}

ingestElements.filterInclude?.addEventListener('input', () => {
  getCloneUtils()?.updateCountsUI?.();
});

ingestElements.filterExclude?.addEventListener('input', () => {
  getCloneUtils()?.updateCountsUI?.();
});

function enforceDataLocks() {
  document.querySelectorAll('#ingest [data-locked]').forEach(el => {
    if (el.dataset.locked === 'true') {
      el.disabled = true;
    }
  });
}

const ingestLockWrapper = document.getElementById('ingest-lock-wrapper');
const ingestLockControls = document.getElementById('ingest-lock-controls');

function setIngestControlsDisabled(state) {
  const shouldHoldDisabled = el =>
    el?.dataset?.disabledReason ||
    el?.dataset?.locked === 'true' ||
    el?.dataset?.cloneLocked === 'true';
  const applyThreadingControlRules = () => {
    if (typeof updateThreadingControls !== 'function') return;
    updateThreadingControls({
      slider: ingestElements.concurrencySlider || document.getElementById('concurrency-slider'),
      label: ingestElements.concurrencyValue || document.getElementById('concurrency-value'),
      enableThreads: ingestElements.enableThreads || document.getElementById('ingest-parallel'),
      autoThreads: ingestElements.autoThreads || document.getElementById('ingest-auto-threads')
    });
  };
  const toggleJobDisabled = elements => {
    elements.forEach(el => {
      if (!el) return;
      if (state) {
        if (!el.dataset.jobDisabled) {
          el.dataset.jobDisabled = 'true';
          el.dataset.jobDisabledPrev = el.disabled ? 'true' : 'false';
        }
        el.disabled = true;
      } else if (el.dataset.jobDisabled) {
        const wasDisabled = el.dataset.jobDisabledPrev === 'true';
        el.disabled = wasDisabled || shouldHoldDisabled(el);
        delete el.dataset.jobDisabled;
        delete el.dataset.jobDisabledPrev;
      } else if (!shouldHoldDisabled(el)) {
        el.disabled = false;
      }
    });
  };
  document.querySelectorAll(
    '#ingest-lock-wrapper input, #ingest-lock-wrapper select, #ingest-lock-wrapper textarea, #ingest-lock-wrapper button, #ingest-lock-controls button, #ingest-lock-concurrency input'
  ).forEach(el => {
    if (el.id === 'cancel-ingest') return;
    if (state) {
      el.disabled = true;
    } else if (!shouldHoldDisabled(el)) {
      el.disabled = false;
    }
  });

  const startIngest = document.getElementById('start-ingest');
  if (startIngest) {
    if (state) startIngest.disabled = true;
    else if (!shouldHoldDisabled(startIngest)) startIngest.disabled = false;
  }
  const resetFields = document.getElementById('reset-ingest-fields');
  if (resetFields) {
    if (state) resetFields.disabled = true;
    else if (!shouldHoldDisabled(resetFields)) resetFields.disabled = false;
  }

  if (state) {
    ingestLockWrapper?.classList.add('locked');
    ingestLockControls?.classList.add('locked');
  } else {
    ingestLockWrapper?.classList.remove('locked');
    ingestLockControls?.classList.remove('locked');
  }

  toggleJobDisabled(document.querySelectorAll('#ingest .panel-toolbar-controls input, #ingest .panel-toolbar-controls button, #notes'));

  if (!state) {
    applyThreadingControlRules();
  }
}

function sendIngestLog(msg, isError = false) {
  logIngest(msg, { isError });
}

// ===============================
// 🔁 Reset Logic
// ===============================
function resetIngestFields() {
  ingestElements.sourcePath.value = '';
  ingestElements.sourcePath.dataset.fileList = '[]';
  setSourceSelectionMode('folder');
  ingestElements.destPath.value = '';
  ingestElements.backupPath.value = '';

  ingestElements.dualCopy.checked = false;
  ingestElements.flattenStructure.checked = false;
  ingestElements.autoFolder.checked = false;

  ingestElements.checksumMethod.value = DEFAULT_CHECKSUM_METHOD;
  if (typeof setDropdownValue === 'function') {
    setDropdownValue('checksum-method', ingestElements.checksumMethod.value);
  }
  ingestElements.skipDuplicates.checked = true;

  ingestElements.saveLog.checked = false;

  if (ingestElements.hideLog) {
    ingestElements.hideLog.checked = true;
    try { ingestElements.hideLog.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
  }

  if (ingestElements.filterInclude) ingestElements.filterInclude.value = '';
  if (ingestElements.filterExclude) ingestElements.filterExclude.value = '';
  if (ingestElements.includeHiddenFiles) ingestElements.includeHiddenFiles.checked = false;
  if (ingestElements.includeCache) ingestElements.includeCache.checked = false;

  ingestElements.enableN8N.checked = false;
  if (ingestElements.n8nAllowPrivate) ingestElements.n8nAllowPrivate.checked = false;
  ingestElements.n8nLog.checked = false;

  ingestElements.enableThreads.checked = true;
  ingestElements.autoThreads.checked = true;
  ingestElements.retryFailures.checked = false;

  ingestElements.notes.value = '';
  ingestElements.n8nUrl.value = '';

  ingestElements.concurrencySlider.value = 1;
  ingestElements.concurrencySlider.disabled = false;
  if (ingestElements.concurrencySlider?.dataset) {
    delete ingestElements.concurrencySlider.dataset.prevValue;
  }
  ingestElements.concurrencyValue.textContent = translate('autoLabel', 'Auto');

  const watchToggle = ingestElements.watchModeToggle;
  if (watchToggle) {
    watchToggle.checked = false;
    if (ingestElements.backupPath) delete ingestElements.backupPath.dataset.prev;
    if (ingestElements.dualCopy) delete ingestElements.dualCopy.dataset.prev;
    if (ingestElements.saveLog) {
      delete ingestElements.saveLog.dataset.prev;
      delete ingestElements.saveLog.dataset.watchLogWarned; // legacy
      delete ingestElements.saveLog.dataset.watchLogHinted;
    }
    if (ingestElements.enableThreads) delete ingestElements.enableThreads.dataset.prev;
    if (ingestElements.autoThreads) delete ingestElements.autoThreads.dataset.prev;
    try { watchToggle.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
  }
  if (ingestElements.watchProcessExisting) ingestElements.watchProcessExisting.checked = false;

  if (ingestElements.backupPath) ingestElements.backupPath.value = '';
  if (ingestElements.dualCopy) ingestElements.dualCopy.checked = false;
  if (ingestElements.enableThreads) ingestElements.enableThreads.checked = true;
  if (ingestElements.autoThreads) ingestElements.autoThreads.checked = true;
  if (typeof updateControls === 'function') updateControls();

  setButtonLabel(ingestElements.startBtn, translate('startIngest', 'Start'));
  setButtonLabel(ingestElements.cancelBtn, translate('cancelIngest', 'Cancel'));

  // 🚫 Disable Clone Mode and clear related UI
  const wasCloneEnabled = !!ingestElements.enableClone?.checked;
  if (ingestElements.enableClone) {
    ingestElements.enableClone.checked = false;
    if (wasCloneEnabled) {
      try { ingestElements.enableClone.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    }
  }
  const ingestPanel = document.getElementById('ingest');
  ingestPanel?.classList.remove('clone-mode');
  const cloneFilter = document.getElementById('clone-folder-filter');
  if (cloneFilter) cloneFilter.value = '';
  const cloneSelectAll = document.getElementById('clone-select-all-folders');
  if (cloneSelectAll) cloneSelectAll.checked = false;
  const cloneShowCount = document.getElementById('clone-show-file-count');
  if (cloneShowCount) cloneShowCount.checked = false;
  const cloneTreeEl = document.getElementById('clone-folder-tree');
  if (cloneTreeEl) applyCloneTreePlaceholder(cloneTreeEl);
  window.cloneSelectedFolders = [];
  window.cloneFoldersOnly = [];
  window.cloneExcluded = [];
  window.cloneIncludeSourceRoot = false;
  window.cloneUtils?.updateCountsUI?.();
  updateCloneHiddenIndicator();

  updateIngestLog(null, { clear: true });
  resetIngestProgressUI();
  const watchEnabled = ingestElements.watchModeToggle?.checked;
  ingestElements.cancelBtn.disabled = !watchEnabled;
  updateIngestJobPreview();
  const box = document.getElementById('ingest-job-preview-box');
  if (box) {
    box.value = '';
    box.style.height = 'auto';
  }
}

function isPrivateAddress(hostname) {
  const host = (hostname || '').toLowerCase();
  const normalizedHost = host.split('%')[0];
  if (!normalizedHost) return true;
  if (['localhost', '127.0.0.1', '::1'].includes(normalizedHost)) return true;
  if (normalizedHost.endsWith('.local')) return true;

  const octets = normalizedHost.split('.');
  if (octets.length === 4 && octets.every(p => /^\d+$/.test(p))) {
    const [a, b] = octets.map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  if (normalizedHost.includes(':')) {
    if (normalizedHost === '::1') return true;
    if (normalizedHost.startsWith('fc') || normalizedHost.startsWith('fd')) return true;
    if (normalizedHost.startsWith('fe80')) return true;
  }

  return false;
}

function validateN8nUrl(n8nUrl, opts = {}) {
  const allowPrivate = !!opts?.allowPrivate;
  const trimmed = (n8nUrl || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      message: translate(
        'ingestN8nValidationMissingUrl',
        '❌ Please provide an n8n URL when webhook logging is enabled.'
      )
    };
  }

  let parsed;
  let parsedHostname;
  try {
    parsed = new URL(trimmed);
    parsedHostname = parsed.hostname;
  } catch {
    const scopedMatch = trimmed.match(/^(https?:)\/\/\[([^\]]+)\](.*)$/i);
    if (!scopedMatch) {
      return {
        valid: false,
        message: translate(
          'ingestN8nValidationInvalidFormat',
          '❌ Invalid n8n URL "{{url}}". Please use a full http/https address.',
          { url: trimmed }
        )
      };
    }
    const scopedHost = scopedMatch[2];
    const sanitizedHost = scopedHost.split('%')[0];
    if (!sanitizedHost) {
      return {
        valid: false,
        message: translate(
          'ingestN8nValidationInvalidFormat',
          '❌ Invalid n8n URL "{{url}}". Please use a full http/https address.',
          { url: trimmed }
        )
      };
    }
    try {
      parsed = new URL(`${scopedMatch[1]}//[${sanitizedHost}]${scopedMatch[3]}`);
      parsedHostname = scopedHost;
    } catch {
      return {
        valid: false,
        message: translate(
          'ingestN8nValidationInvalidFormat',
          '❌ Invalid n8n URL "{{url}}". Please use a full http/https address.',
          { url: trimmed }
        )
      };
    }
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      valid: false,
      message: translate(
        'ingestN8nValidationInvalidProtocol',
        '❌ n8n URL protocol "{{protocol}}" is not supported. Use http:// or https://.',
        { protocol: parsed.protocol || '' }
      )
    };
  }

  const hostname = String(parsedHostname || '').trim();
  if (!hostname) {
    return {
      valid: false,
      message: translate(
        'ingestN8nValidationMissingHostname',
        '❌ Invalid n8n URL "{{url}}". Please include a hostname.',
        { url: trimmed }
      )
    };
  }

  if (!allowPrivate && isPrivateAddress(hostname)) {
    return {
      valid: false,
      message: translate(
        'ingestN8nValidationPrivateDisallowed',
        '❌ n8n URL host "{{hostname}}" cannot target localhost or private networks unless private targets are explicitly allowed.',
        { hostname }
      )
    };
  }

  return { valid: true, url: trimmed };
}

function normalizePathInput(p) {
  const trimmed = (p || '').trim();
  if (!trimmed) return '';

  let candidate = trimmed;
  if (/^file:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'file:') {
        candidate = decodeURIComponent(parsed.pathname || '');
        const isWindowsPath = /^\/[A-Za-z]:/.test(candidate);
        if (isWindowsPath) candidate = candidate.slice(1);
      }
    } catch {
      // keep raw value if URL parsing fails
    }
  }

  const normalized = candidate.trim();
  if (!normalized) return '';
  if (window.electron?.isAbsolute?.(normalized)) {
    return window.electron.resolve?.(normalized) || normalized;
  }
  return normalized;
}

function readSourceFileList() {
  try {
    const parsed = JSON.parse(ingestElements.sourcePath?.dataset?.fileList || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getSourceSelectionMode() {
  const mode = ingestElements.sourcePath?.dataset?.selectionMode;
  if (mode) return mode;
  return readSourceFileList().length > 0 ? 'files' : 'folder';
}

function setSourceSelectionMode(mode) {
  if (!ingestElements.sourcePath) return;
  if (mode) {
    ingestElements.sourcePath.dataset.selectionMode = mode;
  } else {
    delete ingestElements.sourcePath.dataset.selectionMode;
  }
}

function formatSourceItemsSelectedLabel(count) {
  return translate('ingestItemsSelectedLabel', '{{count}} items selected', { count });
}

function setSourcePathFromFileSelection(paths) {
  if (!ingestElements.sourcePath) return;
  ingestElements.sourcePath.dataset.fileList = JSON.stringify(paths);
  ingestElements.sourcePath.dataset.fileSelectionSummary = 'true';
  ingestElements.sourcePath.value = paths.length === 1
    ? paths[0]
    : formatSourceItemsSelectedLabel(paths.length);
  setSourceSelectionMode('files');
}

function reapplySourcePathFileSelectionSummary() {
  const sourcePath = ingestElements.sourcePath;
  if (!sourcePath) return;
  const sourceFiles = readSourceFileList();
  const hasGeneratedSummary = sourcePath.dataset.fileSelectionSummary === 'true';
  const isFileSelectionMode = getSourceSelectionMode() === 'files';
  if (!hasGeneratedSummary || !isFileSelectionMode || sourceFiles.length === 0) return;

  sourcePath.value = sourceFiles.length === 1
    ? sourceFiles[0]
    : formatSourceItemsSelectedLabel(sourceFiles.length);
}

function getSourceSelectionInfo(sourcePathValue) {
  const sourceFiles = readSourceFileList();
  const normalizedSourcePath = normalizePathInput(
    sourcePathValue ?? ingestElements.sourcePath?.value
  );
  const selectionMode = getSourceSelectionMode();
  const isFileSelection = selectionMode === 'files' && sourceFiles.length > 0;
  return {
    sourceFiles,
    normalizedSourcePath,
    selectionMode,
    isFileSelection
  };
}

function setCloneModeState(enabled) {
  document.getElementById('ingest')?.classList.toggle('clone-mode', enabled);
  if (ingestElements.autoFolder) {
    if (enabled) {
      if (!ingestElements.autoFolder.dataset.cloneLocked) {
        ingestElements.autoFolder.dataset.clonePrevChecked = ingestElements.autoFolder.checked ? 'true' : 'false';
        ingestElements.autoFolder.dataset.cloneLocked = 'true';
        ingestElements.autoFolder.disabled = true;
        ingestElements.autoFolder.title = translate('ingestAutoFolderUnavailableInCloneTitle', 'Auto-folder is not available in Clone Mode.');
        if (ingestElements.autoFolder.checked) {
          ingestElements.autoFolder.checked = false;
          logIngest(translate('ingestAutoFolderDisabledCloneLog', 'ℹ️ Auto-folder disabled because Clone Mode is enabled.'));
        }
      }
    } else if (ingestElements.autoFolder.dataset.cloneLocked) {
      ingestElements.autoFolder.disabled = false;
      ingestElements.autoFolder.title = '';
      if (ingestElements.autoFolder.dataset.clonePrevChecked) {
        ingestElements.autoFolder.checked = ingestElements.autoFolder.dataset.clonePrevChecked === 'true';
        delete ingestElements.autoFolder.dataset.clonePrevChecked;
      }
      delete ingestElements.autoFolder.dataset.cloneLocked;
    }
  }
  if (ingestElements.watchModeToggle) {
    if (enabled) {
      ingestElements.watchModeToggle.checked = false;
      ingestElements.watchModeToggle.dataset.locked = 'true';
      ingestElements.watchModeToggle.disabled = true;
      try { ingestElements.watchModeToggle.dispatchEvent(new Event('change')); } catch {}
    } else {
      delete ingestElements.watchModeToggle.dataset.locked;
      // Re-enable only if watch utils are present; otherwise keep it disabled
      // (Step 3 production hardening: no hard dependency on watch-mode.js).
      const wu = getWatchUtils();
      const hasWatch = typeof wu?.initWatchToggle === 'function';
      ingestElements.watchModeToggle.disabled = !hasWatch;
      ingestElements.watchModeToggle.title = hasWatch ? '' : translate('ingestWatchModeUnavailableTitle', 'Watch Mode unavailable (watch module not loaded).');
      if (!hasWatch) {
        ingestElements.watchModeToggle.dataset.disabledReason = 'missing-watch-utils';
      } else {
        delete ingestElements.watchModeToggle.dataset.disabledReason;
      }
      if (!hasWatch) ingestElements.watchModeToggle.checked = false;
    }
  }
  if (ingestElements.watchProcessExisting) {
    if (enabled) {
      ingestElements.watchProcessExisting.checked = false;
      ingestElements.watchProcessExisting.dataset.locked = 'true';
      ingestElements.watchProcessExisting.disabled = true;
    } else {
      delete ingestElements.watchProcessExisting.dataset.locked;
      ingestElements.watchProcessExisting.disabled = false;
    }
  }
}

function applyMissingWatchUtilsUnavailableState(toggle = ingestElements.watchModeToggle) {
  if (!toggle) return;
  toggle.checked = false;
  toggle.disabled = true;
  toggle.dataset.disabledReason = 'missing-watch-utils';
  toggle.title = translate('ingestWatchModeUnavailableTitle', 'Watch Mode unavailable (watch module not loaded).');
  if (ingestElements.watchProcessExisting) {
    ingestElements.watchProcessExisting.disabled = true;
  }
}

function warnCloneModeRequiresFolder() {
  const msg = translate(
    'ingestCloneModeRequiresFolderValidation',
    '⚠️ Clone Mode requires a folder; please select a source folder.'
  );
  showValidationError(msg);
  return msg;
}

function isPathInside(base, candidate) {
  if (!base || !candidate) return false;
  const rel = window.electron.relative?.(base, candidate);
  if (typeof rel !== 'string') return false;
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return true;
}

async function collectSourceRoots(cfg, pathMeta) {
  const roots = new Set();
  const primary = normalizePathInput(cfg.source);
  if (primary) roots.add(primary);
  const watchFolder = normalizePathInput(cfg.watchFolder);
  if ((cfg.watchMode || watchFolder) && watchFolder) {
    roots.add(watchFolder);
  }

  if (Array.isArray(cfg.sourceFiles)) {
    let metaMap = pathMeta;
    if (!metaMap) {
      metaMap = await fetchPathMetadata(cfg.sourceFiles);
    }
    for (const item of cfg.sourceFiles) {
      const normalizedItem = normalizePathInput(item);
      if (!normalizedItem) continue;
      const meta = getPathMeta(metaMap, normalizedItem);
      const isDirectory = meta.isDirectory === true;
      const root = isDirectory ? normalizedItem : window.electron.dirname?.(normalizedItem);
      const normalizedRoot = normalizePathInput(root);
      if (normalizedRoot) roots.add(normalizedRoot);
    }
  }

  return Array.from(roots);
}

async function confirmMissingSourceOverride(cfg) {
  if (!cfg || cfg.watchMode || cfg.cloneMode) return { proceed: true };
  const selectionMode = getSourceSelectionMode();
  const hasSourceFiles = Array.isArray(cfg.sourceFiles) && cfg.sourceFiles.length > 0;
  if (selectionMode === 'files' && hasSourceFiles) return { proceed: true };
  const sourcePath = normalizePathInput(cfg.source);
  if (!sourcePath) return { proceed: true };

  const pathMeta = await fetchPathMetadata([sourcePath]);
  const meta = getPathMeta(pathMeta, sourcePath);
  const exists = typeof meta.exists === 'boolean' ? meta.exists : !!meta;
  if (exists) return { proceed: true };

  if (cfg.allowMissingSourceOverride) return { proceed: true, override: true };

  // Safety gate: keep a stable internal token so localization changes cannot weaken confirmation matching.
  const canonicalOverrideToken = 'OVERRIDE';
  const overrideDisplayToken = String(
    translate('ingestMissingSourceOverrideToken', canonicalOverrideToken)
  ).trim() || canonicalOverrideToken;

  const promptText = translate(
    'ingestMissingSourceOverridePrompt',
    '⚠️ Source folder not found:\n{{sourcePath}}\n\nIngest will NOT copy any files. If you continue, the job will be marked as skipped/failed.\n\nType {{token}} to proceed.',
    { sourcePath, token: overrideDisplayToken }
  );
  const response = await confirmIngestTextInput({
    title: translate('ingestMissingSourceOverrideTitle', 'Missing source folder'),
    message: promptText,
    inputLabel: translate('ingestMissingSourceOverrideInputLabel', 'Type {{token}} to continue', { token: overrideDisplayToken }),
    inputPlaceholder: overrideDisplayToken,
    expectedText: canonicalOverrideToken,
    matchMode: 'case-insensitive',
    hint: translate(
      'ingestMissingSourceOverrideHint',
      'This override only applies to this queued ingest job.'
    ),
    confirmLabel: translate('continueButtonLabel', 'Continue'),
    cancelLabel: translate('cancelButtonLabel', 'Cancel')
  });
  if (response?.confirmed) {
    cfg.allowMissingSourceOverride = true;
    logIngest(
      translate(
        'ingestMissingSourceOverrideEnabled',
        '⚠️ Missing source override enabled. The ingest will be marked as skipped/failed.'
      )
    );
    return { proceed: true, override: true };
  }

  logIngest(
    translate('ingestMissingSourceOverrideCancelled', 'Ingest cancelled: source folder not found.'),
    { isError: true }
  );
  return { proceed: false };
}

async function validateIngestConfig(cfg) {
  const errors = [];
  const warnings = [];
  const validSourceFileCandidates = [];
  try {
    const hasSourcePath = !!(cfg.source && cfg.source.trim());
    const hasSourceFiles = Array.isArray(cfg.sourceFiles) && cfg.sourceFiles.length > 0;
    const selectionMode = typeof getSourceSelectionMode === 'function'
      ? getSourceSelectionMode()
      : (hasSourceFiles ? 'files' : 'folder');
    const isFolderSelection = selectionMode === 'folder';

    const validationPaths = new Set();
    if (cfg.source) validationPaths.add(cfg.source);
    if (cfg.destination) validationPaths.add(cfg.destination);
    if (cfg.backupPath) validationPaths.add(cfg.backupPath);
    if (cfg.watchFolder) validationPaths.add(cfg.watchFolder);
    if (hasSourceFiles) {
      for (const filePath of cfg.sourceFiles) {
        validationPaths.add(filePath);
      }
    }
    const pathMeta = await fetchPathMetadata(Array.from(validationPaths));
    const sourceRoots = await collectSourceRoots(cfg, pathMeta);
    const destPath = normalizePathInput(cfg.destination);
    const backupPath = normalizePathInput(cfg.backupPath);

    for (const targetPath of validationPaths) {
      const meta = getPathMeta(pathMeta, targetPath);
      if (meta.invalid) {
        errors.push(translate('ingestValidationPathMustBeAbsolute', '❌ Path must be absolute. Please select a full path: {{path}}', { path: targetPath }));
      }
    }

    if (!hasSourcePath && !hasSourceFiles) {
      errors.push(translate('ingestValidationSelectSourceBeforeStarting', '❌ Please select a source folder or add files before starting.'));
    } else if (!cfg.cloneMode && isFolderSelection) {
      if (!hasSourcePath) {
        warnings.push(translate('ingestValidationSourcePathNotFoundWarning', '⚠️ Source path not found.'));
      } else {
        const meta = getPathMeta(pathMeta, cfg.source);
        const isDir = meta.isDirectory === true;
        if (!meta.exists) {
          if (cfg.allowMissingSourceOverride) {
            warnings.push(translate('ingestValidationSourcePathNotFoundOverrideWarning', '⚠️ Source path not found. Override enabled; job will be marked as skipped/failed.'));
          } else {
            errors.push(translate('ingestValidationSourcePathNotFoundOverrideRequired', '❌ Source path not found. Ingest requires an explicit override to proceed.'));
          }
        } else if (!isDir) {
          errors.push(translate('ingestValidationSourceMustBeFolder', '❌ Source must be a folder.'));
        }
      }
    }

    if (hasSourceFiles) {
      for (const filePath of cfg.sourceFiles) {
        const meta = getPathMeta(pathMeta, filePath);
        if (!meta.exists) {
          warnings.push(translate('ingestValidationSourceFileNotFound', '⚠️ Source file not found: {{path}}', { path: filePath }));
        } else if (!meta.isDirectory && !meta.isFile) {
          errors.push(translate('ingestValidationSourceEntryMustBeFileOrFolder', '❌ Source entry must be a file or folder: {{path}}', { path: filePath }));
        } else if (meta.isDirectory === true) {
          validSourceFileCandidates.push(filePath);
          if (cfg.cloneMode) {
            warnings.push(translate('ingestValidationSourceEntryFolderInCloneMode', '⚠️ Source entry is a folder in Clone Mode: {{path}}', { path: filePath }));
          } else {
            warnings.push(translate('ingestValidationSourceEntryFolderInfo', 'ℹ️ Source entry is a folder: {{path}}', { path: filePath }));
          }
        } else {
          validSourceFileCandidates.push(filePath);
        }
      }

      if (validSourceFileCandidates.length === 0) {
        errors.push(translate('ingestValidationNoSelectedSourceEntriesExist', '❌ None of the selected source files or folders exist. Please reselect your source inputs.'));
      }
    }

    if (!cfg.destination || !cfg.destination.trim()) {
      errors.push(translate('ingestValidationSetDestinationBeforeStarting', '❌ Please set a destination before starting.'));
    } else if (destPath && sourceRoots.some(root => isPathInside(root, destPath))) {
      errors.push(translate('ingestValidationDestinationInsideSource', '❌ Destination cannot be the same as the source or located inside the source folder.'));
    } else if (destPath && sourceRoots.some(root => isPathInside(destPath, root))) {
      errors.push(translate('ingestValidationSourceInsideDestination', '❌ Source cannot be the same as or located inside the destination folder.'));
    } else if (destPath) {
      const meta = getPathMeta(pathMeta, cfg.destination);
      if (!meta.exists) {
        warnings.push(translate('ingestValidationDestinationMissingCreatePrompt', '⚠️ Destination folder does not exist yet. You will be prompted to create it.'));
      } else if (!meta.isDirectory) {
        errors.push(translate('ingestValidationDestinationMustBeFolder', '❌ Destination must be a folder.'));
      } else if (meta.writable === false) {
        const localizedReason = localizePathMetaReason(meta.writeReason);
        const reason = localizedReason ? ` (${localizedReason})` : '';
        errors.push(translate('ingestValidationDestinationNotWritable', '❌ Destination folder is not writable{{reason}}', { reason }));
      }
    }

    if (cfg.dualCopy && !(cfg.backupPath && cfg.backupPath.trim())) {
      errors.push(translate('ingestValidationBackupRequiredForDualCopy', '❌ Backup path is required when dual copy is enabled.'));
    } else if (cfg.dualCopy && backupPath && sourceRoots.some(root => isPathInside(root, backupPath))) {
      errors.push(translate('ingestValidationBackupInsideSource', '❌ Backup path cannot be the same as the source or located inside the source folder.'));
    } else if (cfg.dualCopy && backupPath && sourceRoots.some(root => isPathInside(backupPath, root))) {
      errors.push(translate('ingestValidationSourceInsideBackup', '❌ Source cannot be the same as or located inside the backup folder.'));
    } else if (cfg.dualCopy && destPath && backupPath && (isPathInside(destPath, backupPath) || isPathInside(backupPath, destPath))) {
      errors.push(translate('ingestValidationDestinationBackupOverlap', '❌ Destination and backup paths cannot match or contain each other.'));
    } else if (cfg.dualCopy && backupPath) {
      const meta = getPathMeta(pathMeta, cfg.backupPath);
      if (!meta.exists) {
        warnings.push(translate('ingestValidationBackupMissingDualCopyWarning', '⚠️ Backup folder does not exist yet. Dual Copy requires creating it before ingest can start.'));
      } else if (!meta.isDirectory) {
        errors.push(translate('ingestValidationBackupMustBeFolder', '❌ Backup must be a folder.'));
      } else if (meta.writable === false) {
        const localizedReason = localizePathMetaReason(meta.writeReason);
        const reason = localizedReason ? ` (${localizedReason})` : '';
        errors.push(translate('ingestValidationBackupNotWritable', '❌ Backup folder is not writable{{reason}}', { reason }));
      }
    }

    if (cfg.enableN8N) {
      const { valid, message } = validateN8nUrl(cfg.n8nUrl, { allowPrivate: cfg.n8nAllowPrivate });
      if (!valid) errors.push(message);
    }

    if (cfg.cloneMode) {
      if (hasSourceFiles) {
        errors.push(translate('ingestValidationCloneModeOnlySupportsFolderSources', '❌ Clone Mode only supports folder sources. Please choose a folder.'));
      } else {
        if (!cfg.source) {
          errors.push(translate('ingestValidationCloneModeRequiresValidSourceFolder', '❌ Clone Mode requires a valid source folder. Please choose a folder.'));
        } else {
          const meta = getPathMeta(pathMeta, cfg.source);
          const isDir = meta.isDirectory === true;
          if (!meta.exists || !isDir) {
            errors.push(translate('ingestValidationCloneModeRequiresValidSourceFolder', '❌ Clone Mode requires a valid source folder. Please choose a folder.'));
          }
        }
      }
    }
  } catch (error) {
    const message = error?.message ?? String(error);
    errors.push(translate('ingestValidationUnableToValidateSettings', '❌ Unable to validate ingest settings: {{message}}', { message }));
  }

  return { errors, warnings };
}

// ===============================
// 🔁 Reset Button Handler
// ===============================
function bindIngestPanelDomListeners() {
document.getElementById('reset-ingest-fields')?.addEventListener('click', () => {
  if (window.panelPresetDefaults?.has?.('ingest')) {
    void window.panelPresetDefaults.resetToDefault('ingest')
      .then(applied => {
        if (!applied) resetIngestFields();
        if (ingestElements.hideLog) {
          ingestElements.hideLog.checked = true;
          try { ingestElements.hideLog.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
        }
      })
      .catch(() => {
        resetIngestFields();
      });
    return;
  }

  resetIngestFields();
});

// ===============================
// 📁 Folder Picker Events
// ===============================
ingestElements.sourceBtn?.addEventListener('click', async () => {
  const isWatchMode = ingestElements.watchModeToggle?.checked;
  if (isWatchMode) {
    const folder = await window.electron.selectFolder?.();
    if (!folder) return;
    ingestElements.sourcePath.value = folder;
    ingestElements.sourcePath.dataset.fileList = '[]';
    setSourceSelectionMode('folder');
    if (ingestElements.enableClone?.checked) {
      refreshCloneTreeFromSource(folder);
    }
    updateIngestJobPreview();
    return;
  }
  const paths = await window.electron.selectFolderOrFiles?.();
  if (!Array.isArray(paths) || !paths.length) return;
  let isDir = false;
  if (paths.length === 1) {
    let metadata = null;
    try {
      const metaMap = await fetchPathMetadata([paths[0]]);
      metadata = getPathMeta(metaMap, paths[0]) ?? null;
    } catch {
      // Ignore async metadata errors and fall back to sync stat below.
    }
    if (!metadata) {
      try {
        metadata = await window.electron.fsStat?.(paths[0]) ?? null;
      } catch {
        metadata = null;
      }
    }
    if (metadata) {
      isDir = typeof metadata.isDirectory === 'function'
        ? metadata.isDirectory()
        : metadata?.isDirectory === true;
    }
  }
  if (paths.length === 1 && isDir) {
    ingestElements.sourcePath.value = paths[0];
    ingestElements.sourcePath.dataset.fileList = '[]';
    setSourceSelectionMode('folder');
    if (ingestElements.enableClone?.checked) {
      refreshCloneTreeFromSource(paths[0]);
    }
  } else {
    if (ingestElements.enableClone?.checked) {
      const msg = translate(
        'ingestCloneModeRequiresSourceFolderDisabledValidation',
        '⚠️ Clone Mode requires a source folder. Clone Mode has been disabled.'
      );
      showValidationError(msg);
      disableCloneMode(msg, { disableToggle: false });
    }
    setSourcePathFromFileSelection(paths);
  }
  updateIngestJobPreview();
});

ingestElements.sourcePath?.addEventListener('change', () => {
  ingestElements.sourcePath.dataset.fileList = ingestElements.sourcePath.dataset.fileList || '[]';
  setSourceSelectionMode(readSourceFileList().length > 0 ? 'files' : 'folder');
  if (ingestElements.enableClone?.checked) {
    refreshCloneTreeFromSource();
  }
  updateIngestJobPreview();
});

ingestElements.sourcePath?.addEventListener('input', () => {
  const sourcePath = ingestElements.sourcePath;
  if (!sourcePath) return;
  const hadFileSelectionSummary = sourcePath.dataset.fileSelectionSummary === 'true';
  if (hadFileSelectionSummary) {
    sourcePath.value = '';
  }
  delete sourcePath.dataset.fileSelectionSummary;
  sourcePath.dataset.fileList = '[]';
  setSourceSelectionMode('folder');
  if (ingestElements.enableClone?.checked) {
    refreshCloneTreeFromSource();
  }
  updateIngestJobPreview();
});

ingestElements.destBtn?.addEventListener('click', async () => {
  const folder = await window.electron.selectFolder?.();
  if (folder) {
    ingestElements.destPath.value = folder;
    updateIngestJobPreview();
  }
});

ingestElements.backupBtn?.addEventListener('click', async () => {
  const folder = await window.electron.selectFolder?.();
  if (folder) {
    ingestElements.backupPath.value = folder;
    if (ingestElements.dualCopy && !ingestElements.dualCopy.checked) {
      ingestElements.dualCopy.checked = true;
      ingestElements.dualCopy.dispatchEvent(new Event('change', { bubbles: true }));
    }
    updateIngestJobPreview();
  }
});

// ===============================
// ▶️ Start Ingest Task
// ===============================
ingestElements.startBtn?.addEventListener('click', async () => {
  hideIngestToast();
  const isWatch = document.getElementById('enable-watch-mode')?.checked;
  ingestElements.startBtn.disabled = true;
  updateIngestLog(null, { clear: true });
  if (!isWatch) {
    setIngestControlsDisabled(true);
  }

  // Capture the user's intent before gatherIngestConfig potentially disables Clone Mode.
  const cloneRequested = !!ingestElements.enableClone?.checked;

  const restoreControls = () => {
    if (!isWatch) {
      setIngestControlsDisabled(false);
    }
    ingestElements.startBtn.disabled = false;
    ingestElements.cancelBtn.disabled = true;
  };

  let shouldRestore = true;

  try {
    const cfg = gatherIngestConfig();

    if (cfg.verification?.method === 'none') {
      const confirmNoneVerification = await confirmIngestAction({
        title: translate('ingestConfirmNoVerificationTitle', 'Continue without verification?'),
        message: translate(
          'ingestConfirmNoVerification',
          '⚠️ WARNING: Verification is set to None. Copy integrity will NOT be verified. Continue anyway?'
        ),
        type: 'warning',
        okLabel: translate('continueButtonLabel', 'Continue'),
        cancelLabel: translate('cancelButtonLabel', 'Cancel')
      });
      if (!confirmNoneVerification) {
        logIngest(translate('ingestNoVerificationCancelledLog', 'Ingest cancelled: verification "None" was not confirmed.'));
        restoreControls();
        return;
      }
    }

    // If the user requested Clone Mode but it couldn't be prepared (missing clone utils, etc.),
    // abort to avoid accidentally running a full ingest.
    if (cloneRequested && !cfg.cloneMode) {
      restoreControls();
      return;
    }
    if (isWatch) {
      const watchValidation = await validateWatchModeConfig(cfg);
      if (!watchValidation.valid) {
        const msg = watchValidation.errors.join('\n');
        sendIngestLog(msg, true);
        restoreControls();
        return;
      }
      cfg.watchFolder = watchValidation.watchFolder;
    }

    const missingSourceDecision = await confirmMissingSourceOverride(cfg);
    if (!missingSourceDecision.proceed) {
      restoreControls();
      return;
    }
    const { errors: validationErrors, warnings: validationWarnings } = await validateIngestConfig(cfg);
    if (validationWarnings.length) {
      validationWarnings.forEach(warn => logIngest(warn));
    }
    if (validationErrors.length) {
      const msg = validationErrors.join('\n');
      showValidationError(msg);
      restoreControls();
      return;
    }
    if (cfg.cloneMode && (!Array.isArray(cfg.selectedFolders) || cfg.selectedFolders.length === 0)) {
      const warn = translate('ingestCloneModeSelectAtLeastOneFolderLog', '⚠️ Select at least one folder to clone.');
      logIngest(warn, { isError: true });
      restoreControls();
      return;
    }

    const panelLabel = cfg.cloneMode
      ? translate('ingestPanelLabelClone', 'Clone')
      : translate('ingestPanelLabelIngest', 'Ingest');

    // Configuration summary is already shown in the preview box; keep the log for runtime events.
    let total = 0;
    let map = {};
    if (!isWatch) {
      try {
        if (cfg.cloneMode) {
          const cu = getCloneUtils();
          if (typeof cu?.calculateCloneBytes !== 'function') {
            const msg = translate('ingestCloneModeUnavailableModuleLog', '❌ Clone Mode is unavailable (clone module not loaded).');
            showValidationError(msg);
            disableCloneMode(msg);
            restoreControls();
            return;
          }
          const stats = await cu.calculateCloneBytes(cfg);
          total = stats?.total ?? 0;
        } else {
          ({ total, map } = await calculateIngestBytes(cfg));
        }
      } catch {
        const errMsg = translate(
          'ingestEstimateSizeFailedContinueWarningLog',
          '⚠️ Failed to estimate {{panel}} size; continuing without size estimate.',
          { panel: panelLabel }
        );
        logIngest(errMsg, { isError: true });
        total = 0;
        map = {};
      }
    }
    const panel = cfg.cloneMode ? 'clone' : 'ingest';
    const job = {
      config: cfg,
      expectedCopyBytes: total,
      expectedBackupBytes: cfg.dualCopy ? total : 0,
      fileSizeMap: cfg.cloneMode ? {} : map
    };

    if (isWatch) {
      const wu = getWatchUtils();
      if (typeof wu?.startWatch !== 'function') {
        const errDetail = translate('ingestWatchModeUnavailableErrorDetail', 'Watch Mode is unavailable (watch module not loaded).');
        sendIngestLog(
          translate('ingestWatchModeStartUnavailableErrorLog', '❌ {{error}}', { error: errDetail }),
          true
        );
        setIngestControlsDisabled(false);
        ingestElements.startBtn.disabled = false;
        ingestElements.cancelBtn.disabled = true;
        setButtonLabel(ingestElements.startBtn, translate('startIngest', 'Start'));
        setButtonLabel(ingestElements.cancelBtn, translate('cancelIngest', 'Cancel'));
        if (ingestElements.watchModeToggle) {
          ingestElements.watchModeToggle.checked = false;
          ingestElements.watchModeToggle.disabled = true;
          try { ingestElements.watchModeToggle.dispatchEvent(new Event('change')); } catch {}
        }
        return;
      }

      let result;
      try {
        result = await wu.startWatch(panel, cfg);
      } catch (err) {
        // Normalize thrown errors to the same shape we expect from the backend.
        result = {
          success: false,
          error: err?.message || String(err)
        };
      }
      const success = result && (result.success === true || result.ok === true);
      if (!result || success === false) {
        const errDetail = typeof result === 'string'
          ? result
          : resolveIngestDisplayText(result?.error) || translate('ingestWatchModeCouldNotStartErrorDetail', 'Watch mode could not be started.');
        sendIngestLog(
          translate('ingestWatchModeStartFailedErrorLog', '❌ {{error}}', { error: errDetail }),
          true
        );
        setIngestControlsDisabled(false);
        ingestElements.startBtn.disabled = false;
        ingestElements.cancelBtn.disabled = true;
        setButtonLabel(ingestElements.startBtn, translate('startIngest', 'Start'));
        setButtonLabel(ingestElements.cancelBtn, translate('cancelIngest', 'Cancel'));
        if (ingestElements.watchModeToggle) {
          ingestElements.watchModeToggle.checked = false;
          ingestElements.watchModeToggle.dispatchEvent(new Event('change'));
        }
        return;
      }
      if (typeof result === 'string') {
        sendIngestLog?.(result);
      } else {
        sendIngestLog?.(translate('ingestWatchModeStartedLog', '✅ Watch mode started.'));
      }
      setIngestControlsDisabled(true);
      ingestElements.cancelBtn.disabled = false;
      setIngestWatchEyesActive(true);
      setIngestWatchSessionRunning(true);
      shouldRestore = false;
      return;
    }

    const queueMsg = translate('ingestQueueingJobLog', '🚀 Queuing {{panel}} job...', {
      panel: panelLabel
    });
    logIngest(queueMsg);
    setIngestControlsDisabled(true);
    try {
      pendingQueuedJobId = await ipc.invoke('queue-add-ingest', job);
      currentJobId = pendingQueuedJobId;
      // 🔧 Start processing immediately (no UI lag)
      await ipc.invoke('queue-start');
      const queuedMsg = translate('ingestJobQueuedLog', '🗳️ {{panel}} job queued.', {
        panel: panelLabel
      });
      logIngest(queuedMsg);
    } catch (err) {
      const errDetail = err?.message || err?.error || String(err);
      const errMsg = translate('ingestQueueErrorLog', '❌ Queue error: {{error}}', {
        error: errDetail
      });
      logIngest(errMsg, { isError: true });
      restoreControls();
      return;
    }

    ingestElements.cancelBtn.disabled = false;
    shouldRestore = false;
  } finally {
    if (shouldRestore) {
      restoreControls();
    }
  }
});


// ===============================
// 🤖 Backend Triggered Field Sync
// ===============================
if (ipc?.on) {
  ipc.on('toggle-fields', (_event, changes) => {
    let summary = translate('ingestToggleFieldsSummaryHeader', '⚙️ Backend updated fields:\n');

    for (const [fieldId, value] of Object.entries(changes)) {
      const field = document.getElementById(fieldId);

      if (field && typeof field.checked !== 'undefined') {
        field.checked = value;
        summary += translate('ingestToggleFieldsBooleanUpdateLine', '✔️ {{fieldId}} set to {{value}}\n', {
          fieldId,
          value
        });
      } else if (field && typeof field.value === 'string') {
        field.value = value;
        if (fieldId === 'checksum-method' && typeof setDropdownValue === 'function') {
          setDropdownValue('checksum-method', value);
          summary += translate('ingestToggleFieldsChecksumUpdateLine', '📝 {{fieldId}} set to "{{value}}" (hashing enabled)\n', {
            fieldId,
            value: getVerificationMethodLabel(value)
          });
        } else {
          summary += translate('ingestToggleFieldsValueUpdateLine', '📝 {{fieldId}} set to "{{value}}"\n', {
            fieldId,
            value
          });
        }
      }
    }

    logIngest(summary);
    updateIngestJobPreview();
  });
}

ingestElements.cancelBtn?.addEventListener('click', async () => {
  if (ingestElements.watchModeToggle?.checked) {
    const panel = ingestElements.enableClone?.checked ? 'clone' : 'ingest';
    const panelLabel = panel === 'clone'
      ? translate('ingestPanelLabelClone', 'Clone')
      : translate('ingestPanelLabelIngest', 'Ingest');
    const wu = getWatchUtils();

    // Immediately switch the UI into a cancelling state (hide progress bar, keep hamster).
    const activeOrPendingJobId = currentJobId ?? pendingQueuedJobId;
    if (activeOrPendingJobId !== null) {
      setIngestCancelPending(true, activeOrPendingJobId);
    }
    setIngestControlsDisabled(true);
    setIngestWatchEyesActive(false);
    try {
      if (typeof wu?.stopWatch === 'function') {
        await wu.stopWatch(panel);
      } else {
        sendIngestLog(
          translate('ingestWatchModeStopUnavailableLog', '⚠️ Watch Mode stop requested, but the watch module is unavailable.'),
          true
        );
      }
    } catch (e) {
      panelLog('warn', 'stopWatch failed (ingest):', { error: e?.message || e });
    }

    if (activeOrPendingJobId !== null) {
      try {
        await ipc.invoke('queue-cancel-job', activeOrPendingJobId);
      } catch (err) {
        setIngestCancelPending(false);
        setIngestControlsDisabled(false);
        if (ingestElements.cancelBtn) {
          ingestElements.cancelBtn.disabled = false;
          ingestElements.cancelBtn.dataset.watchActive = '1';
          setButtonLabel(ingestElements.cancelBtn, translate('ingestStopWatching', 'Stop Watching'));
        }
        if (ingestElements.watchModeToggle?.checked) {
          setIngestWatchEyesActive(true);
        }
        logIngest(
          translate(
            'ingestWatchModeCancelCurrentJobFailedLog',
            '❌ Failed to cancel current watch job. Stop Watching remains active — please try again.'
          ),
          { isError: true }
        );
        panelLog('warn', 'queue-cancel-job failed (watch mode):', { error: err?.message || err });
        updateIngestJobPreview();
        return;
      }
    } else {
      // No active job: we're just stopping watch mode.
      resetIngestProgressUI();
      setIngestControlsDisabled(false);
      setIngestCancelPending(false);
      if (ingestElements.cancelBtn) {
        delete ingestElements.cancelBtn.dataset.watchActive;
        setButtonLabel(ingestElements.cancelBtn, translate('cancelIngest', 'Cancel'));
        ingestElements.cancelBtn.disabled = true;
      }
      if (ingestElements.startBtn) {
        setButtonLabel(ingestElements.startBtn, translate('startIngest', 'Start'));
      }
    }

    sendIngestLog(
      translate('ingestWatchModeStopRequestedAndCancellingLog', '🛑 Watch Mode stop requested and {{panel}} cancelling…', { panel: panelLabel })
    );

    // Stop watching immediately (UI), but keep the panel locked until the queue confirms cancellation.
    setIngestWatchSessionRunning(false);
    ingestElements.watchModeToggle.checked = false;
    try { ingestElements.watchModeToggle.dispatchEvent(new Event('change')); } catch {}
    updateIngestJobPreview();
    return;
  }

  const confirmCancel = await confirmIngestAction({
    title: translate('confirmCancelIngestTitle', 'Cancel ingest?'),
    message: translate('confirmCancelIngest', '⚠️ Are you sure you want to cancel the ingest?'),
    type: 'warning',
    okLabel: translate('cancelIngestConfirmButton', 'Cancel Ingest'),
    cancelLabel: translate('keepRunningButtonLabel', 'Keep Running')
  });
  if (!confirmCancel) return;

  logIngest(translate('ingestCancelRequestedLog', '🛑 Cancel requested...'));
  const activeOrPendingJobId = currentJobId ?? pendingQueuedJobId;
  if (activeOrPendingJobId === null) {
    const warnMsg = translate('ingestCancelNoActiveJobWarnLog', '⚠️ No active ingest job found to cancel.');
    logIngest(warnMsg);
    return;
  }
  setIngestCancelPending(true, activeOrPendingJobId);
  try {
    await ipc.invoke('queue-cancel-job', activeOrPendingJobId);
    // Keep the panel locked until the queue confirms cancellation.
    updateIngestJobPreview();
  } catch (err) {
    setIngestCancelPending(false);
    const errDetail = err?.message || err?.error || String(err);
    const errMsg = translate('ingestCancelErrorLog', '❌ Cancel error: {{error}}', { error: errDetail });
    logIngest(errMsg, { isError: true });
  }
});


// ✅ Run immediately — DOM is already loaded at this point
const slider = document.getElementById('concurrency-slider');
const label = document.getElementById('concurrency-value');
const enableThreads = document.getElementById('ingest-parallel');
const autoThreads = document.getElementById('ingest-auto-threads');

updateControls = () =>
  updateThreadingControls({
    slider,
    label,
    enableThreads,
    autoThreads
  });

if (slider && label) {
  slider.addEventListener('input', () => {
    if (!autoThreads?.checked) label.textContent = slider.value;
  });
  enableThreads?.addEventListener('change', updateControls);
  autoThreads?.addEventListener('change', updateControls);  
  
// Set initial value
  updateControls();
}
}


function renderIngestVerificationTooltip() {
  const ingestTooltip = document.querySelector('#ingest #ingest-verification-logging-tooltip');
  if (!ingestTooltip) return;
  ingestTooltip.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header">${translate('ingestVerificationTooltipHeader', 'VERIFICATION METHODS')}</div>

      <div class="tooltip-section">
        <ul class="tooltip-list">
          <li>${translate('ingestVerificationTooltipNone', '<strong>None</strong> - fastest, but no data integrity check. Only use for low-risk copies.')}</li>
          <li>${translate('ingestVerificationTooltipByteCompare', '<strong>Byte Compare</strong> - reads source and copy and compares bytes 1:1. Safest, but slowest.')}</li>
          <li>${translate('ingestVerificationTooltipBlake3', '<strong>BLAKE3</strong> - modern, very fast and strong. Good default for on-set and production ingest.')}</li>
          <li>${translate('ingestVerificationTooltipSha256', '<strong>SHA-256</strong> - widely accepted cryptographic hash. Slower but often required by facilities/IT.')}</li>
          <li>${translate('ingestVerificationTooltipMd5', '<strong>MD5</strong> - legacy option for systems that still expect MD5. Fast but weaker; use only for compatibility.')}</li>
          <li>${translate('ingestVerificationTooltipXxhash64', '<strong>xxHash64</strong> - extremely fast, non-cryptographic hash. Great for high-volume sanity checks when speed matters most.')}</li>
        </ul>
      </div>
    </div>
  `;
}

function renderCloneModeTooltip() {
  const cloneModeTooltip = document.querySelector('#ingest #clone-mode-tooltip');
  if (!cloneModeTooltip) return;
  cloneModeTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">${translate('cloneModeTooltipHeader', 'CLONE MODE OVERVIEW')}</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('cloneModeTooltipSectionWhatTitle', 'What Clone Mode does')}</span>
          <ul class="tooltip-list">
            <li>${translate('cloneModeTooltipBulletTree', 'Treats the source as a folder tree instead of a flat file list.')}</li>
            <li>${translate('cloneModeTooltipBulletSelectFolders', 'Only copies the folders you select in the Clone tree.')}</li>
            <li>${translate('cloneModeTooltipBulletPreserveStructure', 'Preserves original folder structure at the destination.')}</li>
            <li>${translate('cloneModeTooltipBulletRespectsFilters', 'Still respects your include/exclude extension filters and verification settings.')}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('cloneModeTooltipSectionControlsTitle', 'Controls in this row')}</span>
          <ul class="tooltip-list">
            <li>${translate('cloneModeTooltipBulletFilter', '<strong>Filter</strong> - type text to narrow the folder tree by name.')}</li>
            <li>${translate('cloneModeTooltipBulletSelectAll', '<strong>Select All</strong> - select/deselect every folder in the tree.')}</li>
            <li>${translate('cloneModeTooltipBulletShowFileCount', '<strong>Show File Count</strong> - show per-folder file counts (slower on huge trees).')}</li>
          </ul>
        </div>
      </div>
    `;
}

function renderIngestOverviewTooltip() {
  const ingestOverviewTooltip = document.querySelector('#ingest #ingest-overview-tooltip');
  if (!ingestOverviewTooltip) return;
  ingestOverviewTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">${translate('ingestOverviewTooltipHeader', 'INGEST PANEL — Technical Overview')}</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('ingestOverviewTooltipSectionCapabilitiesTitle', 'Core capabilities')}</span>
          <ul class="tooltip-list">
            <li>${translate('ingestOverviewTooltipBulletCopies', 'Creates verified copies of camera cards or source folders to one or two destinations.')}</li>
            <li>${translate('ingestOverviewTooltipBulletModes', 'Supports classic ingest and Clone Mode (tree-based, folder-selective copy).')}</li>
            <li>${translate('ingestOverviewTooltipBulletFilters', 'Applies include / exclude filters, duplicate skipping, and optional watch-folder ingest (with an optional startup scan).')}</li>
            <li>${translate('ingestOverviewTooltipBulletControls', 'Controls checksum / verification strategy, threading, retries, and log output.')}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('ingestOverviewTooltipSectionInputsTitle', 'Inputs / outputs')}</span>
          <ul class="tooltip-list">
            <li>${translate('ingestOverviewTooltipBulletInputs', 'Inputs: source folder or file list, primary destination, optional backup path.')}</li>
            <li>${translate('ingestOverviewTooltipBulletOutputs', 'Outputs: one or two fully copied trees plus optional job logs and webhook payloads.')}</li>
            <li>${translate('ingestOverviewTooltipBulletPrompts', 'Missing source paths stop ingest unless you explicitly override; missing destination folders can be created on prompt. With Dual Copy enabled, backup creation is mandatory and ingest fails if backup cannot be guaranteed.')}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('ingestOverviewTooltipSectionUnderHoodTitle', 'Under the hood')}</span>
          <ul class="tooltip-list">
            <li>${translate('ingestOverviewTooltipBulletMoves', 'File moves are performed by the Assist backend with optional threaded copy and retries.')}</li>
            <li>${translate('ingestOverviewTooltipBulletVerification', 'Verification can run as byte-compare or hash-based (BLAKE3, SHA-256, MD5, xxHash64).')}</li>
            <li>${translate('ingestOverviewTooltipBulletCloneMode', 'Clone Mode uses a pre-computed folder tree and selection map to limit what is copied.')}</li>
          </ul>
        </div>
      </div>
    `;
}

function renderIngestTooltips() {
  renderIngestVerificationTooltip();
  renderCloneModeTooltip();
  renderIngestOverviewTooltip();
}

function refreshIngestDropdownLabels() {
  const currentValue = ingestElements.checksumMethod?.value || DEFAULT_CHECKSUM_METHOD;
  const checksumOptions = [
    { value: 'none', label: getVerificationMethodLabel('none') },
    { value: 'bytecompare', label: getVerificationMethodLabel('bytecompare') },
    { value: 'blake3', label: getVerificationMethodLabel('blake3') },
    { value: 'sha256', label: getVerificationMethodLabel('sha256') },
    { value: 'md5', label: getVerificationMethodLabel('md5') },
    { value: 'xxhash64', label: getVerificationMethodLabel('xxhash64') }
  ];

  if (typeof setupStyledDropdown === 'function') {
    setupStyledDropdown('checksum-method', checksumOptions);
  }

  if (ingestElements.checksumMethod) {
    ingestElements.checksumMethod.value = currentValue;
  }

  if (typeof setDropdownValue === 'function') {
    setDropdownValue('checksum-method', currentValue);
  }
}

function bindIngestTooltipI18nRefresh() {
  // Prevent duplicate listeners if script is re-evaluated.
  if (bindIngestTooltipI18nRefresh.bound) return;
  bindIngestTooltipI18nRefresh.bound = true;

  // Initial render (fallback text if i18n is not ready yet).
  renderIngestTooltips();
  refreshIngestDropdownLabels();

  const renderI18nBoundUI = () => {
    renderIngestTooltips();
    const isAutoFolderCloneLocked = ingestElements.autoFolder?.dataset.cloneLocked === 'true';
    if (isAutoFolderCloneLocked) {
      ingestElements.autoFolder.title = translate(
        'ingestAutoFolderUnavailableInCloneTitle',
        'Auto-folder is not available in Clone Mode.'
      );
    }
    refreshIngestDropdownLabels();
    renderSourceButtonLabelForWatchMode();
    if (ingestElements.watchModeToggle?.dataset.disabledReason === 'missing-watch-utils') {
      applyMissingWatchUtilsUnavailableState(ingestElements.watchModeToggle);
    }
    refreshCloneTreePlaceholderI18n();
    refreshCloneTreeUnreadablePlaceholderI18n();
    reapplySourcePathFileSelectionSummary();
    if (ingestElements.enableClone?.dataset.disabledReason === 'missing-clone-utils') {
      refreshCloneUnavailableI18nState();
    }
    updateCloneHiddenIndicator();
    setIngestUiPhase(ingestUiPhase, { force: true });
    if (ingestElements.cancelBtn) {
      const key = cancelPending ? 'ingestCancellingButton' : 'cancelIngest';
      const fallback = cancelPending ? 'Cancelling…' : 'Cancel';
      setButtonLabel(ingestElements.cancelBtn, translate(key, fallback));
    }
    if (typeof updateControls === 'function') {
      updateControls();
    } else {
      updateThreadingControls({
        slider: document.getElementById('concurrency-slider'),
        label: document.getElementById('concurrency-value'),
        enableThreads: document.getElementById('ingest-parallel'),
        autoThreads: document.getElementById('ingest-auto-threads')
      });
    }

    // Refresh any currently visible preview text after other i18n-bound UI is updated,
    // without re-running byte-estimation IPC work on every language event.
    queueMicrotask(() => updateIngestJobPreview({ skipEstimate: true }));
  };

  const attach = () => {
    const i18n = window.i18n;
    if (!i18n?.on) return false;
    const refreshPresetDropdownI18n = () => {
      refreshPresetDropdown().catch(() => {});
    };

    try {
      i18n.on('languageChanged', renderI18nBoundUI);
      i18n.on('initialized', renderI18nBoundUI);
      i18n.on('loaded', renderI18nBoundUI);

      i18n.on('languageChanged', refreshPresetDropdownI18n);
      i18n.on('initialized', refreshPresetDropdownI18n);
      i18n.on('loaded', refreshPresetDropdownI18n);
    } catch {
      // Ignore builds without evented i18n.
    }
    if (i18n.isInitialized) {
      renderI18nBoundUI();
      refreshPresetDropdownI18n();
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
}

function getIngestPresetDisplayLabel(fileName) {
  if (window.panelPresetDefaults?.isDefaultPresetFile?.(fileName)) {
    return translate('defaultPresetLabel', 'Default');
  }
  return String(fileName || '').replace(/\.json$/i, '');
}

function bindIngestPanelListenersOnce() {
  if (ingestPanelInitialized) return;
  bindIngestPanelDomListeners();
  bindIngestPanelIpcListeners();
  initIngestHideLogToggle();
  bindIngestTooltipI18nRefresh();
  ingestPanelInitialized = true;
}

function syncIngestPanelState(resetDefaults = false) {
  // Ensure the log window starts with the same placeholder text used elsewhere.
  ensureIngestLogPlaceholder(ingestElements.logOutput);

  resolveIngestPreviewEl();
  enforceDataLocks();
  if (!ingestElements.checksumMethod.value || resetDefaults) {
    ingestElements.checksumMethod.value = DEFAULT_CHECKSUM_METHOD;
  }
  refreshIngestDropdownLabels();

  renderIngestTooltips();

  // Cancel should start disabled until an ingest is running
  ingestElements.cancelBtn.disabled = true;

  const initWatchToggle = () => {
    const cb = ingestElements.watchModeToggle;
    if (cb?.dataset?.watchInit === '1') return true;
    const wu = getWatchUtils();
    if (typeof wu?.initWatchToggle !== 'function') return false;
    try {
      wu.initWatchToggle({
        checkboxId: 'enable-watch-mode',
        startBtnId: 'start-ingest',
        cancelBtnId: 'cancel-ingest',
        panel: 'ingest',
        onToggle: isWatch => {
          const threadToggle = ingestElements.enableThreads || document.getElementById('ingest-parallel');
          const autoThreadToggle = ingestElements.autoThreads || document.getElementById('ingest-auto-threads');
          if (isWatch) {
            const fileListRaw = ingestElements.sourcePath?.dataset?.fileList;
            const hasFileList = readSourceFileList().length > 0 || (fileListRaw && fileListRaw !== '[]');
            if (hasFileList) {
              showValidationError(
                translate(
                  'ingestWatchModeRequiresFolderValidation',
                  '⚠️ Watch Mode requires a folder. Clear the file list and select a watch folder.'
                )
              );
              if (cb) {
                cb.checked = false;
                try { cb.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
              }
              return;
            }
          }
          // Mark Cancel as the persistent Stop Watching control (localization-safe).
          // This prevents global queue handlers from disabling the button while Watch Mode is active.
          if (ingestElements.cancelBtn) {
            if (isWatch) ingestElements.cancelBtn.dataset.watchActive = '1';
            else delete ingestElements.cancelBtn.dataset.watchActive;
          }
          // ... existing watch toggle logic ...
          renderSourceButtonLabelForWatchMode();
          if (ingestElements.saveLog) {
            // Watch Mode now supports log export:
            // when Stop Watching is pressed, the watch session log is copied to Destination and (if enabled) Backup.
            ingestElements.saveLog.disabled = false;
            if (isWatch && !ingestElements.saveLog.dataset.watchLogHinted) {
              ingestElements.saveLog.dataset.watchLogHinted = '1';
              sendIngestLog(
                translate(
                  'ingestWatchModeSaveLogHint',
                  'ℹ️ Watch Mode: “Save log” exports the watch session log to Destination/Backup when you stop watching.'
                )
              );
            }
          }
          if (threadToggle && autoThreadToggle) {
            if (isWatch) {
              // Keep the user's current threading toggles when entering Watch Mode.
              // Auto Threads is allowed in Watch Mode.
              // The backend resolves Auto Threads once when Watch starts (cache-backed) and caps it to a safe max.
              if (!threadToggle.dataset.watchThreadsHinted) {
                threadToggle.dataset.watchThreadsHinted = '1';
                sendIngestLog(
                  translate(
                    'ingestWatchModeAutoThreadsHint',
                    'ℹ️ Watch Mode: Auto Threads can be enabled. It benchmarks disk speed once when watching starts (cached) and caps the result at 4 threads. Manual Parallel Copy (2–4 threads) is also supported.'
                  )
                );
              }
            } else {
              if (!threadToggle.dataset.locked) threadToggle.disabled = false;
              if (!autoThreadToggle.dataset.locked) autoThreadToggle.disabled = false;
            }
            updateControls();
          }
        }
      });
      if (cb) {
        cb.dataset.watchInit = '1';
        cb.disabled = false;
        cb.title = '';
        delete cb.dataset.disabledReason;
      }
      if (ingestElements.watchProcessExisting) {
        ingestElements.watchProcessExisting.disabled = false;
      }
      return true;
    } catch (e) {
      panelLog('warn', 'initWatchToggle failed (ingest):', { error: e?.message || e });
      return false;
    }
  };

  if (!initWatchToggle() && ingestElements.watchModeToggle) {
    const cb = ingestElements.watchModeToggle;
    applyMissingWatchUtilsUnavailableState(cb);
    // Ensure the skinned buttons remain in their non-watch labels.
    setButtonLabel(ingestElements.startBtn, translate('startIngest', 'Start'));
    setButtonLabel(ingestElements.cancelBtn, translate('cancelIngest', 'Cancel'));
    if (!cb.dataset.watchWarned) {
      cb.dataset.watchWarned = '1';
      sendIngestLog(
        translate('ingestWatchModeUnavailableLog', '⚠️ Watch Mode is unavailable (watch module not loaded).')
      );
    }
    if (!cb.dataset.watchAwaiting) {
      cb.dataset.watchAwaiting = '1';
      window.addEventListener('watch-utils-ready', () => {
        // If Clone Mode is enabled, Watch Mode stays unavailable by design.
        if (ingestElements.enableClone?.checked) {
          cb.disabled = true;
          cb.checked = false;
          if (ingestElements.watchProcessExisting) {
            ingestElements.watchProcessExisting.disabled = true;
          }
          return;
        }
        cb.disabled = false;
        const ok = initWatchToggle();
        if (!ok) {
          applyMissingWatchUtilsUnavailableState(cb);
        } else if (ingestElements.watchProcessExisting) {
          ingestElements.watchProcessExisting.disabled = false;
        }
      }, { once: true });
    }
  }

  refreshPresetDropdown().catch(() => {});
  // ⛔ Do not auto-populate the job preview on first load
  bindIngestPreviewAutoUpdate();

  const cloneTree = document.getElementById('clone-folder-tree');
  if (cloneTree && !cloneTree.textContent?.trim()) {
    applyCloneTreePlaceholder(cloneTree);
  }
}

function initIngestPanel(resetDefaults = false) {
  const missingElements = [];
  if (!ingestElements.checksumMethod) missingElements.push('checksum-method');
  if (!ingestElements.startBtn) missingElements.push('start-ingest');
  if (!ingestElements.sourcePath) missingElements.push('source-path');
  if (missingElements.length) {
    panelLog('warn', 'initIngestPanel skipped; missing critical elements.', { missingElements });
    return;
  }

  bindIngestPanelListenersOnce();
  syncIngestPanelState(resetDefaults);
}

if (document.readyState !== 'loading') {
  initIngestPanel(false);
} else {
  // Listen on both window and document so tests can dispatch the event
  const handler = () => initIngestPanel(true);
  document.addEventListener('DOMContentLoaded', handler);
  window.addEventListener?.('DOMContentLoaded', handler);
  // Fallback for test environments where DOMContentLoaded may not fire
  initIngestPanel(true);
}

// 💾 Save and Load Preset
function gatherIngestConfig() {
  const selectedMethod = ingestElements.checksumMethod?.value || DEFAULT_CHECKSUM_METHOD;
  const skipDuplicates = ingestElements.skipDuplicates?.checked;
  const n8nUrl = (ingestElements.n8nUrl?.value || '').trim();
  const watchModeEnabled = document.getElementById('enable-watch-mode')?.checked;
  const watchProcessExisting = !!ingestElements.watchProcessExisting?.checked;
  // In UI: "Include Cache" (checked = include common cache/dev folders)
  // In backend: useDefaultIgnorePatterns (true = exclude those entries)
  const includeCache = !!ingestElements.includeCache?.checked;

  const enableThreads = ingestElements.enableThreads?.checked;
  const autoThreads = enableThreads ? ingestElements.autoThreads?.checked : false;
  let maxThreads;
  if (!enableThreads) maxThreads = 1;
  else if (autoThreads) maxThreads = null;
  else {
    const slider = ingestElements.concurrencySlider;
    const maxAttr = Number.parseInt(slider?.max, 10);
    const maxValue = Number.isFinite(maxAttr) ? maxAttr : null;
    const parsed = Number.parseInt(slider?.value, 10);
    let clamped = Number.isFinite(parsed) ? parsed : 1;
    if (clamped < 1) clamped = 1;
    if (Number.isFinite(maxValue) && clamped > maxValue) clamped = maxValue;
    if (!Number.isFinite(parsed) || String(slider?.value) !== String(clamped)) {
      if (slider) slider.value = String(clamped);
      if (ingestElements.concurrencyValue && !autoThreads) {
        ingestElements.concurrencyValue.textContent = String(clamped);
      }
    }
    maxThreads = clamped;
  }

  const sourceFiles = readSourceFileList().map(normalizePathInput).filter(Boolean);
  const normalizedSourcePath = normalizePathInput(ingestElements.sourcePath.value);
  const normalizedDestination = normalizePathInput(ingestElements.destPath.value);
  const normalizedBackupPath = normalizePathInput(ingestElements.backupPath.value);
  const selectionMode = getSourceSelectionMode();
  const isFileSelection = selectionMode === 'files' && sourceFiles.length > 0;
  const sourceDisplayLabel = isFileSelection ? normalizedSourcePath : '';
  const resolvedSourcePath = isFileSelection ? '' : normalizedSourcePath;

  const cfg = {
    source: resolvedSourcePath,
    sourceSelectionMode: selectionMode,
    sourceDisplayLabel,
    sourceFiles,
    destination: normalizedDestination,
    backup: ingestElements.dualCopy.checked,
    backupPath: normalizedBackupPath,
    dualCopy: ingestElements.dualCopy.checked,
    flattenStructure: ingestElements.flattenStructure.checked,
    includeHiddenFiles: !!ingestElements.includeHiddenFiles?.checked,
    includeCache,
    useDefaultIgnorePatterns: !includeCache,
    autoFolder: ingestElements.autoFolder.checked,
    saveLog: ingestElements.saveLog.checked,
    verbose: false,
    notes: ingestElements.notes.value,
    enableN8N: ingestElements.enableN8N.checked,
    n8nUrl,
    n8nAllowPrivate: !!ingestElements.n8nAllowPrivate?.checked,
    n8nLog: ingestElements.n8nLog.checked,
    watchMode: watchModeEnabled,
    watchFolder: normalizePathInput(watchModeEnabled && sourceFiles.length ? '' : resolvedSourcePath),
    processExistingOnStart: watchProcessExisting,
    verification: {
      useChecksum: selectedMethod !== 'none',
      method: selectedMethod,
      skipDuplicates,
      compareByte: selectedMethod === 'bytecompare',
      useSha256: selectedMethod === 'sha256',
      useMd5: selectedMethod === 'md5',
      useBlake3: selectedMethod === 'blake3',
      useXxhash64: selectedMethod === 'xxhash64'
    },
    filters: {
      include: ingestElements.filterInclude.value,
      exclude: ingestElements.filterExclude.value
    },
    enableThreads,
    autoThreads,
    maxThreads,
    retryFailures: ingestElements.retryFailures.checked,
    allowMissingSourceOverride: false,
    cloneMode: !!ingestElements.enableClone?.checked,
    cloneFolderFilter: document.getElementById('clone-folder-filter')?.value || '',
    cloneSelectAllFolders: !!document.getElementById('clone-select-all-folders')?.checked,
    cloneShowFileCount: !!document.getElementById('clone-show-file-count')?.checked
  };

  if (ingestElements.enableClone?.checked) {
    const cu = getCloneUtils();
    if (typeof cu?.getSelectedFolders !== 'function') {
      const msg = translate('ingestCloneModeUnavailableModuleLog', '❌ Clone Mode is unavailable (clone module not loaded).');
      showValidationError(msg);
      disableCloneMode(msg);
      cfg.cloneMode = false;
      delete cfg.selectedFolders;
      delete cfg.foldersOnly;
      delete cfg.excludedFolders;
      delete cfg.includeSourceRoot;
      return cfg;
    }

    let selection = {
      selectedFolders: [],
      foldersOnly: [],
      excludedFolders: [],
      includeSourceRoot: false
    };
    if (cfg.source?.trim()) {
      try {
        selection = cu.getSelectedFolders(cfg.source) || selection;
      } catch (err) {
        const msg = translate('ingestCloneFolderSelectionReadFailedValidation', '❌ Failed to read clone folder selection: {{error}}', {
          error: err?.message || err
        });
        showValidationError(msg);
        disableCloneMode(msg);
        return cfg;
      }
    }

    const selectedFolders = Array.isArray(selection?.selectedFolders) ? selection.selectedFolders : [];
    const foldersOnly = Array.isArray(selection?.foldersOnly) ? selection.foldersOnly : [];
    const excludedFolders = Array.isArray(selection?.excludedFolders) ? selection.excludedFolders : [];
    const includeSourceRoot = !!selection?.includeSourceRoot;

    cfg.selectedFolders = selectedFolders;
    cfg.foldersOnly = foldersOnly;
    cfg.excludedFolders = excludedFolders; // <- new: tell backend what to skip
    cfg.includeSourceRoot = includeSourceRoot;
    cfg.excludeExtensions = ingestElements.filterExclude.value;
    cfg.includeExtensions = ingestElements.filterInclude.value;
    cfg.flatten = cfg.flattenStructure;
    cfg.skipExisting = skipDuplicates;
    cfg.checksum = selectedMethod !== 'none';
    cfg.checksumMethod = selectedMethod;
    cfg.byteCompare = selectedMethod === 'bytecompare';
    // Clone Mode does not support Watch Mode.
    cfg.watchMode = false;
    cfg.watchFolder = '';
  }

  return cfg;
}

async function applyIngestPreset(data) {
  const includeFilter = data.filters?.include ?? data.includeExtensions ?? '';
  const excludeFilter = data.filters?.exclude ?? data.excludeExtensions ?? '';
  const skipDuplicates = data.verification?.skipDuplicates ?? data.skipExisting ?? false;

  const verificationMethod = typeof data.verification?.method === 'string'
    ? data.verification.method.trim()
    : '';
  const legacyChecksumMethod = typeof data.checksumMethod === 'string'
    ? data.checksumMethod.trim()
    : '';
  const methodProvided = verificationMethod.length > 0 || legacyChecksumMethod.length > 0;

  const checksumEnabled = data.verification?.useChecksum;
  const legacyChecksumEnabled = data.checksum;

  if (ingestElements.sourcePath) {
    const sourceValue = typeof data.source === 'string' && data.source.trim().length > 0
      ? data.source
      : (typeof data.watchFolder === 'string' && data.watchFolder.trim().length > 0 ? data.watchFolder : '');
    ingestElements.sourcePath.value = sourceValue;
    delete ingestElements.sourcePath.dataset.fileSelectionSummary;
    const persistedSelectionMode = typeof data.sourceSelectionMode === 'string'
      ? data.sourceSelectionMode.trim().toLowerCase()
      : '';
    const hasSourceFiles = Array.isArray(data.sourceFiles) && data.sourceFiles.length > 0;
    const restoreFileSelection = hasSourceFiles || (persistedSelectionMode === 'files' && Array.isArray(data.sourceFiles));

    if (restoreFileSelection) {
      setSourcePathFromFileSelection(data.sourceFiles);
    } else if (sourceValue) {
      try {
        const pathMeta = await fetchPathMetadata([sourceValue]);
        const meta = getPathMeta(pathMeta, sourceValue);
        const isDirectory = meta.isDirectory === true;
        const isFile = meta.isFile === true;

        if (isFile) {
          setSourcePathFromFileSelection([sourceValue]);
        } else {
          ingestElements.sourcePath.dataset.fileList = '[]';
          setSourceSelectionMode('folder');
          if (!isDirectory) {
            logIngest(translate('ingestPresetSourcePathNotFoundLog', '⚠️ Preset source path not found: {{path}}', { path: sourceValue }));
          }
        }
      } catch (error) {
        ingestElements.sourcePath.dataset.fileList = '[]';
        setSourceSelectionMode('folder');
        const safeError = ingestErrorFromCode(typeof error?.code === 'string' ? error.code : 'INGEST_PATH_VALIDATE_UNAVAILABLE');
        logIngest(
          translate('ingestPresetSourceValidateFailedLog', '⚠️ Unable to validate preset source path: {{error}}', {
            error: appendIngestTechnicalDetail(resolveIngestDisplayText(safeError), error?.message || error)
          })
        );
      }
    } else {
      ingestElements.sourcePath.dataset.fileList = '[]';
      setSourceSelectionMode('folder');
    }
  }
  if (ingestElements.destPath) ingestElements.destPath.value = data.destination || '';
  if (ingestElements.backupPath) ingestElements.backupPath.value = data.backupPath || '';
  if (ingestElements.dualCopy) {
    ingestElements.dualCopy.checked = Object.prototype.hasOwnProperty.call(data, 'dualCopy')
      ? !!data.dualCopy
      : !!data.backup;
  }
  if (ingestElements.flattenStructure) ingestElements.flattenStructure.checked = !!data.flattenStructure;
  if (ingestElements.includeHiddenFiles) ingestElements.includeHiddenFiles.checked = !!data.includeHiddenFiles;
  const includeCache = typeof data.includeCache === 'boolean'
    ? data.includeCache
    // Back-compat: older presets store useDefaultIgnorePatterns (true = exclude caches)
    : (data.useDefaultIgnorePatterns !== undefined ? !data.useDefaultIgnorePatterns : false);
  if (ingestElements.includeCache) ingestElements.includeCache.checked = !!includeCache;
  if (ingestElements.autoFolder) ingestElements.autoFolder.checked = !!data.autoFolder;
  if (ingestElements.checksumMethod) {
    let method = verificationMethod || legacyChecksumMethod || DEFAULT_CHECKSUM_METHOD;
    method = method.toLowerCase();
    if (data.verification?.compareByte) method = 'bytecompare';
    if (checksumEnabled === false && !methodProvided && !data.verification?.compareByte) {
      method = 'none';
    }
    if (legacyChecksumEnabled === false && !methodProvided && !data.verification?.compareByte) {
      method = 'none';
    }
    ingestElements.checksumMethod.value = method;
    if (typeof setDropdownValue === 'function') {
      setDropdownValue('checksum-method', method);
    }
  }
  if (ingestElements.skipDuplicates) ingestElements.skipDuplicates.checked = !!skipDuplicates;
  if (ingestElements.saveLog) ingestElements.saveLog.checked = !!data.saveLog;
  if (ingestElements.notes) ingestElements.notes.value = data.notes || '';
  if (ingestElements.filterInclude) ingestElements.filterInclude.value = includeFilter;
  if (ingestElements.filterExclude) ingestElements.filterExclude.value = excludeFilter;
  if (ingestElements.enableN8N) ingestElements.enableN8N.checked = !!data.enableN8N;
  if (ingestElements.n8nUrl) ingestElements.n8nUrl.value = data.n8nUrl || '';
  if (ingestElements.n8nAllowPrivate) ingestElements.n8nAllowPrivate.checked = !!data.n8nAllowPrivate;
  if (ingestElements.n8nLog) ingestElements.n8nLog.checked = !!data.n8nLog;
  if (ingestElements.enableThreads) ingestElements.enableThreads.checked = !!data.enableThreads;
  if (ingestElements.autoThreads) ingestElements.autoThreads.checked = !!data.autoThreads;
  if (ingestElements.concurrencySlider)
    ingestElements.concurrencySlider.value = data.maxThreads ?? '1';
  if (ingestElements.retryFailures) ingestElements.retryFailures.checked = !!data.retryFailures;
  updateThreadingControls({
    slider: ingestElements.concurrencySlider,
    label: ingestElements.concurrencyValue,
    enableThreads: ingestElements.enableThreads,
    autoThreads: ingestElements.autoThreads
  });

  if (ingestElements.enableClone) {
    const cloneUtilsReady = typeof window.cloneUtils?.getSelectedFolders === 'function'
      && typeof window.cloneUtils?.renderFolderTree === 'function';
    if (data.cloneMode && !cloneUtilsReady) {
      const warning = translate(
        'ingestCloneModeRequestedPresetUnavailableWarningLog',
        '⚠️ Clone Mode requested by preset, but clone utilities are unavailable.'
      );
      ingestElements.enableClone.checked = false;
      logIngest(warning);
      disableCloneMode(warning);
    } else {
      ingestElements.enableClone.checked = !!data.cloneMode;
      setCloneModeState(!!data.cloneMode);
      if (data.cloneMode) {
        if (ingestElements.filterExclude) {
          ingestElements.filterExclude.value =
            data.excludeExtensions || data.filters?.exclude || '';
        }
        const selectedFolders = Array.isArray(data.selectedFolders) ? data.selectedFolders : [];
        const foldersOnly = Array.isArray(data.foldersOnly) ? data.foldersOnly : [];
        const excludedFolders = Array.isArray(data.excludedFolders) ? data.excludedFolders : [];
        const includeSourceRoot = !!data.includeSourceRoot;

        window.cloneSelectedFolders = selectedFolders;
        window.cloneFoldersOnly = foldersOnly;
        window.cloneExcluded = excludedFolders;
        window.cloneIncludeSourceRoot = includeSourceRoot;

        const sourceValue = ingestElements.sourcePath?.value?.trim();
        if (sourceValue) {
          refreshCloneTreeFromSource(sourceValue, { preserveSelection: true, includeSourceRoot });
        } else if (selectedFolders.length || foldersOnly.length || excludedFolders.length || includeSourceRoot) {
          logIngest(translate('ingestClonePresetNoSourceSkipRestoreLog', '⚠️ Clone preset loaded without a source path; skipping folder selection restore.'));
        }

        const cloneFilter = document.getElementById('clone-folder-filter');
        if (cloneFilter) {
          cloneFilter.value = typeof data.cloneFolderFilter === 'string' ? data.cloneFolderFilter : '';
          cloneFilter.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const cloneSelectAll = document.getElementById('clone-select-all-folders');
        if (cloneSelectAll) {
          cloneSelectAll.checked = !!data.cloneSelectAllFolders;
          cloneSelectAll.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const cloneShowCount = document.getElementById('clone-show-file-count');
        if (cloneShowCount) {
          cloneShowCount.checked = !!data.cloneShowFileCount;
          cloneShowCount.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else {
        const cloneFilter = document.getElementById('clone-folder-filter');
        if (cloneFilter) cloneFilter.value = '';
        const cloneSelectAll = document.getElementById('clone-select-all-folders');
        if (cloneSelectAll) cloneSelectAll.checked = false;
        const cloneShowCount = document.getElementById('clone-show-file-count');
        if (cloneShowCount) cloneShowCount.checked = false;
        const cloneTreeEl = document.getElementById('clone-folder-tree');
        if (cloneTreeEl) applyCloneTreePlaceholder(cloneTreeEl);

        window.cloneSelectedFolders = [];
        window.cloneFoldersOnly = [];
        window.cloneExcluded = [];
        window.cloneIncludeSourceRoot = false;
        window.cloneUtils?.updateCountsUI?.();
      }
    }
  }
  if (ingestElements.watchModeToggle) {
    // Backwards-compatibility: older presets used `useDoneFlag` as a proxy for Watch Mode.
    const watchModeEnabled = typeof data.watchMode === 'boolean'
      ? data.watchMode
      : !!data.useDoneFlag;
    const wu = getWatchUtils();
    const hasWatchUtils = typeof wu?.initWatchToggle === 'function';
    const missingWatchUtils = ingestElements.watchModeToggle.dataset.disabledReason === 'missing-watch-utils'
      || !hasWatchUtils;
    let shouldDispatchWatchChange = true;
    if (data.cloneMode) {
      shouldDispatchWatchChange = false;
    } else if (missingWatchUtils) {
      ingestElements.watchModeToggle.disabled = true;
      ingestElements.watchModeToggle.checked = false;
      if (ingestElements.watchProcessExisting) {
        ingestElements.watchProcessExisting.disabled = true;
        ingestElements.watchProcessExisting.checked = false;
      }
      if (watchModeEnabled) {
        logIngest(translate('ingestWatchModeRequestedButUnavailableLog', '⚠️ Watch Mode requested by preset, but watch utilities are unavailable.'));
      }
      shouldDispatchWatchChange = false;
    } else {
      ingestElements.watchModeToggle.disabled = false;
      ingestElements.watchModeToggle.checked = watchModeEnabled;
      if (ingestElements.watchProcessExisting) {
        ingestElements.watchProcessExisting.disabled = false;
        ingestElements.watchProcessExisting.checked = !!data.processExistingOnStart;
      }
    }
    if (shouldDispatchWatchChange) {
      try { ingestElements.watchModeToggle.dispatchEvent(new Event('change')); } catch {}
    }
  }
  if (ingestElements.enableClone?.checked && ingestElements.sourcePath?.value && !data.cloneMode) {
    refreshCloneTreeFromSource();
  }
  updateIngestJobPreview();
}

function resolveWatchFolder(cfg) {
  return normalizePathInput(cfg?.watchFolder || cfg?.source);
}

async function validateWatchModeConfig(cfg) {
  const errors = [];
  const watchFolder = resolveWatchFolder(cfg);
  const hasDatasetFileList = readSourceFileList().length > 0 || (Array.isArray(cfg?.sourceFiles) && cfg.sourceFiles.length > 0);

  if (hasDatasetFileList) {
    errors.push(translate('ingestWatchValidationRequiresFolderPath', '❌ Watch mode requires a folder path. Please select a directory to watch instead of a file list.'));
  }

  if (!watchFolder) {
    errors.push(translate('ingestWatchValidationSelectFolderBeforeStart', '❌ Please select a watch folder before starting watch mode.'));
  }

  if (watchFolder) {
    let stat = null;
    try {
      const ipcApi = window.ipc ?? window.electron;
      if (typeof ipcApi?.invoke === 'function') {
        const pathMeta = await fetchPathMetadata([watchFolder]);
        stat = getPathMeta(pathMeta, watchFolder) ?? null;
      } else if (typeof window.electron?.stat === 'function') {
        stat = await window.electron.stat(watchFolder);
      } else {
        throw createIngestError(
          'INGEST_PATH_VALIDATE_UNAVAILABLE',
          {},
          translate(
            'ingest.error.pathValidateInvokeUnavailableDetail',
            'IPC invoke is unavailable for ingest path validation.'
          )
        );
      }
    } catch (err) {
      errors.push(translate('ingestWatchValidationUnableToAccessFolder', '❌ Unable to access watch folder: {{reason}}', {
        reason: getIngestUiErrorText(err, 'INGEST_PATH_VALIDATE_UNAVAILABLE')
      }));
    }

    const exists = typeof stat?.exists === 'boolean' ? stat.exists : !!stat;
    if (!exists && errors.length === 0) {
      errors.push(translate('ingestWatchValidationFolderNotFound', '❌ Watch folder not found: {{path}}', { path: watchFolder }));
    } else if (stat) {
      const isDirectory = typeof stat.isDirectory === 'function'
        ? stat.isDirectory()
        : stat?.isDirectory === true;
      if (!isDirectory) {
        errors.push(translate('ingestWatchValidationOnlySupportsFolders', '❌ Watch mode only supports folders. Please select a directory to watch.'));
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    watchFolder
  };
}

async function isWatchConfigValid(cfg) {
  if (!cfg) return translate('ingestWatchConfigMissingConfig', 'No ingest config found.');

  const fieldLabels = {
    source: translate('ingestWatchConfigFieldSource', 'Source Path'),
    destination: translate('ingestWatchConfigFieldDestination', 'Destination Path'),
    backup: translate('ingestWatchConfigFieldBackup', 'Backup Path'),
    checksumMethod: translate('ingestWatchConfigFieldChecksumMethod', 'Checksum Method'),
    filters: translate('ingestWatchConfigFieldFilters', 'Filters'),
    threadCount: translate('ingestWatchConfigFieldThreadCount', 'Thread Count')
  };

  const formatMissingFieldsMessage = (messageKey, fallback, fields) => (
    translate(messageKey, fallback, { fields: fields.join(', ') })
  );

  if (cfg.watchMode) {
    const watchMissing = [];
    if (!cfg.source?.trim()) watchMissing.push(fieldLabels.source);
    if (!cfg.destination?.trim()) watchMissing.push(fieldLabels.destination);
    if (watchMissing.length) {
      return formatMissingFieldsMessage(
        'ingestWatchConfigRequiresFields',
        'Watch mode requires: {{fields}}',
        watchMissing
      );
    }
  }

  const missing = [];
  if (cfg.dualCopy && !(cfg.backupPath && cfg.backupPath.trim())) missing.push(fieldLabels.backup);
  if (!cfg.verification?.method) missing.push(fieldLabels.checksumMethod);
  if (!cfg.filters) missing.push(fieldLabels.filters);
  if (cfg.enableThreads && !cfg.autoThreads && !cfg.maxThreads) missing.push(fieldLabels.threadCount);

  if (cfg.watchMode) {
    const watchValidation = await validateWatchModeConfig(cfg);
    if (!watchValidation.valid) return watchValidation.errors.join('\n');
  }

  return missing.length
    ? formatMissingFieldsMessage('ingestWatchConfigMissingFields', 'Missing: {{fields}}', missing)
    : true;
}

if (window.watchValidators) {
  window.watchValidators.ingest = isWatchConfigValid;
}

async function refreshPresetDropdown() {
  const hidden = ingestElements.presetSelect;
  if (!hidden) return;
  let opts = [];
  try {
    const electronApi = window.electron;
    const mkdir = (typeof electronApi?.mkdirAsync === 'function')
      ? electronApi.mkdirAsync.bind(electronApi)
      : (typeof electronApi?.mkdir === 'function')
        ? async (p) => { electronApi.mkdir(p); return true; }
        : null;

    const readdir = (typeof electronApi?.readdirAsync === 'function')
      ? electronApi.readdirAsync.bind(electronApi)
      : (typeof electronApi?.readdir === 'function')
        ? async (p, o) => (electronApi.readdir(p, o) || [])
        : null;

    if (mkdir && readdir && presetDir) {
      await mkdir(presetDir);
      const files = (await readdir(presetDir)) || [];
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
          label: getIngestPresetDisplayLabel(f)
        }));
    }
  } catch (err) {
    const msg = translate('ingestPresetReadFailedLog', '❌ Failed to read ingest presets: {{error}}', {
      error: err?.message || err
    });
    logIngest(msg, { isError: true });
    panelLog('error', 'Failed to read presets', { error: err?.message || err });
  }
  if (typeof setupStyledDropdown === 'function') {
    setupStyledDropdown('ingest-preset', opts);
    setDropdownValue('ingest-preset', hidden.value || '');
    if (ingestElements.presetFallbackSelect) {
      ingestElements.presetFallbackSelect.hidden = true;
    }
  } else {
    let fallbackSelect = ingestElements.presetFallbackSelect;
    if (!(fallbackSelect instanceof HTMLSelectElement)) {
      fallbackSelect = document.createElement('select');
      fallbackSelect.id = 'ingest-preset-fallback';
      fallbackSelect.name = 'ingest-preset-fallback';
      hidden.parentElement?.appendChild(fallbackSelect);
      ingestElements.presetFallbackSelect = fallbackSelect;
      attachPresetFallbackListener(fallbackSelect);
    }
    fallbackSelect.hidden = false;
    const selectedValue = hidden.value || fallbackSelect.value || '';
    while (fallbackSelect.options.length > 0) {
      fallbackSelect.remove(0);
    }
    opts.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      fallbackSelect.appendChild(option);
    });
    fallbackSelect.value = selectedValue;
    hidden.value = selectedValue;
  }
  window.translatePage?.();
}

async function handlePresetSelection(file) {
  if (!file) return;
  try {
    const electronApi = window.electron;
    if (!electronApi?.readTextFileAsync || !electronApi?.joinPath || !presetDir) {
      throw createIngestError(
        'INGEST_PRESET_LOAD_API_MISSING',
        {},
        translate(
          'ingest.error.presetLoadApiMissingDetail',
          ''
        )
      );
    }
    const raw = await electronApi.readTextFileAsync(electronApi.joinPath(presetDir, file));
    const data = JSON.parse(raw);
    await applyIngestPreset(data);
    logIngest(translate('ingestAppliedPresetLog', '📚 Applied ingest preset "{{preset}}".', { preset: file }), {
      fileId: electronApi.joinPath(presetDir, file)
    });
  } catch (err) {
    const msg = translate('ingestPresetLoadFailedLog', '❌ Failed to load ingest preset "{{file}}": {{error}}', {
      file,
      error: getIngestUiErrorText(err)
    });
    logIngest(msg, { isError: true });
    panelLog('error', 'Failed to load preset', { error: err?.message || err });
  }
}

function attachPresetFallbackListener(fallbackSelect) {
  if (!fallbackSelect || fallbackSelect.dataset.listenerAttached === 'true') return;
  fallbackSelect.addEventListener('change', () => {
    const file = fallbackSelect.value;
    if (ingestElements.presetSelect) {
      ingestElements.presetSelect.value = file;
    }
    handlePresetSelection(file);
  });
  fallbackSelect.dataset.listenerAttached = 'true';
}

// ✅ Auto-refresh preset dropdown when presets are saved or deleted
function bindIngestPanelIpcListeners() {
  if (typeof ipc !== 'undefined' && ipc.on) {
    ipc.on('preset-saved', (_e, panelId) => {
      if (panelId === 'ingest') refreshPresetDropdown().catch(() => {});
    });
    ipc.on('preset-deleted', (_e, panelId) => {
      if (panelId === 'ingest') refreshPresetDropdown().catch(() => {});
    });
  }

  ingestElements.presetSelect?.addEventListener('change', () => {
    handlePresetSelection(ingestElements.presetSelect.value);
  });

  attachPresetFallbackListener(ingestElements.presetFallbackSelect);
}

// expose for testing and external access
if (typeof globalThis !== 'undefined') {
  globalThis.gatherIngestConfig = gatherIngestConfig;
  globalThis.initIngestPanel = initIngestPanel;
  globalThis.applyIngestPreset = applyIngestPreset; // expose for tests
  globalThis.refreshPresetDropdown = refreshPresetDropdown;
}

ingestElements.saveConfigBtn?.addEventListener('click', async () => {
  hideIngestToast();
  if (typeof ipc?.saveFile !== 'function' || !window.electron?.joinPath || !presetDir) {
    const msg = translate(
      'ingestPresetSaveApisMissing',
      '❌ Save Preset is unavailable (missing desktop file APIs).'
    );
    logIngest(msg, { isError: true });
    panelLog('error', 'Save preset requires Electron file APIs.');
    showIngestToast(msg, { persistent: true, isError: true });
    return;
  }
  const cfg = gatherIngestConfig();
  const file = await ipc.saveFile({
    title: translate('ingestSavePresetTitle', 'Save Preset'),
    defaultPath: window.electron.joinPath(presetDir, 'ingest-config.json')
  });
  if (file) {
    try {
      const serialized = JSON.stringify(cfg, null, 2);
      if (typeof ipc?.writeTextFileAtomicAsync === 'function') {
        await ipc.writeTextFileAtomicAsync(file, serialized);
      } else if (typeof ipc?.writeTextFileAsync === 'function') {
        await ipc.writeTextFileAsync(file, serialized);
      } else {
        throw createIngestError(
          'INGEST_WRITE_API_UNAVAILABLE',
          {},
          translate(
            'ingest.error.writeApiUnavailableDetail',
            ''
          )
        );
      }
      ipc.send('preset-saved', 'ingest');
      refreshPresetDropdown().catch(() => {});
      logIngest(
        translate(
          'ingestConfigSavedToFileLog',
          `💾 Ingest config saved to "${file}".`,
          { file }
        ),
        {
          fileId: file
        }
      );
      showIngestToast(translate('ingestConfigSavedAlert', 'Config saved.'));
    } catch (err) {
      const errorText = getIngestUiErrorText(err);
      logIngest(
        translate(
          'ingestConfigSaveFailedLog',
          '❌ Failed to save ingest config to "{{file}}": {{error}}',
          { file, error: errorText }
        ),
        { isError: true }
      );
      showIngestToast(
        `${translate('ingestConfigSaveFailedAlertPrefix', 'Failed to save config:')} ${errorText}`,
        { persistent: true, isError: true }
      );
    }
  }
});

ingestElements.loadConfigBtn?.addEventListener('click', async () => {
  hideIngestToast();
  if (typeof ipc?.openFile !== 'function' || typeof ipc?.readTextFileAsync !== 'function') {
    const msg = translate(
      'ingestPresetLoadApisMissing',
      '❌ Load Preset is unavailable (missing desktop file APIs).'
    );
    logIngest(msg, { isError: true });
    panelLog('error', 'Load preset requires Electron async file APIs.');
    showIngestToast(msg, { persistent: true, isError: true });
    return;
  }
  const file = await ipc.openFile({
    title: translate('ingestLoadPresetTitle', 'Load Preset')
  });
  if (!file) return;
  try {
    const data = JSON.parse(await ipc.readTextFileAsync(file));
    await applyIngestPreset(data);
    logIngest(
      translate(
        'ingestLoadedConfigLog',
        `📥 Loaded ingest config from "${file}".`,
        { file }
      ),
      {
        fileId: file
      }
    );
  } catch (err) {
    const errorText = err?.message || `${err}`;
    const msg = translate(
      'ingestFailedToLoadConfig',
      `❌ Failed to load ingest config from "${file}": ${errorText}`,
      { file, error: errorText }
    );
    logIngest(msg, { isError: true });
    showIngestToast(
      `${translate('ingestConfigLoadFailedAlertPrefix', 'Failed to load config:')} ${errorText}`,
      { persistent: true, isError: true }
    );
  }
});

if (typeof ipc !== 'undefined' && ipc.on) {
  ['ingest', 'clone'].forEach(type => {
    ipc.on(`${type}-log-message`, (_e, data) => {
      const payload = data && typeof data === 'object' ? data : {};

      // Only show logs for the active queue job. This prevents stale/other-job noise.
      const payloadJobId = normalizeJobId(payload.jobId);
      const jobMatch = hasJobId(payloadJobId)
        && (jobIdsMatch(payloadJobId, currentJobId) || jobIdsMatch(payloadJobId, cancelPendingJobId));
      if (!jobMatch) return;

      const isDevUi = (window.electron?.isPackaged === false) || (window.electron?.DEBUG_UI === true);
      const level = (payload.level || (payload.isWarning ? 'warn' : payload.isError ? 'error' : 'info'))
        .toString()
        .toLowerCase();

      // Never surface debug-level plumbing unless DEV UI is enabled.
      if (level === 'debug' && !isDevUi) return;

      const rawMsg = payload.msg ?? payload.message ?? '';
      const msg = resolveIngestDisplayText(rawMsg);
      if (!msg) return;

      const isError = level === 'error' || !!payload.isError;
      const isWarning = level === 'warn' || level === 'warning' || !!payload.isWarning;
      const color = isError ? 'red' : (isWarning ? '#d98a00' : null);

      // Keep messages human-first in production; optionally annotate in DEV.
      const stage = payload.stage != null ? String(payload.stage).trim() : '';
      const prefix = (isDevUi && stage) ? `[${stage}] ` : '';
      appendIngestLogLine(prefix + msg, { isError, color });

      if (isDevUi) {
        const detail = typeof payload.detail === 'string' ? payload.detail.trim() : '';
        if (detail && detail !== '{}' && detail.length) {
          const clipped = detail.length > 800 ? detail.slice(0, 800) + '…' : detail;
          appendIngestLogLine(clipped, { color: '#777', prefix: '↳ ' });
        }
      }
    });
  });
  ipc.on('watch-log', (_event, msg) => {
    logIngest(msg);
  });

  const isActiveIngestJobEvent = (payloadOrJob, options = {}) => {
    const payload = (payloadOrJob && typeof payloadOrJob === 'object') ? payloadOrJob : null;
    if (!payload) return false;

    const panel = payload.panel;
    if (panel !== 'ingest' && panel !== 'clone') return false;

    const hasValidId = hasJobId(payload.id);
    if (!hasValidId) return false;

    const payloadId = normalizeJobId(payload.id);

    if (jobIdsMatch(payloadId, currentJobId)) {
      return true;
    }

    if (jobIdsMatch(payloadId, pendingQueuedJobId)) {
      return true;
    }

    if (options.allowCancelPending && jobIdsMatch(payloadId, cancelPendingJobId)) {
      return true;
    }

    return false;
  };

  // Watch Mode jobs are created server-side, so the renderer often doesn't know the jobId ahead of time.
  // When watching is enabled and we are not currently tracking an ingest job id, auto-adopt the first
  // ingest/clone queue event so the legacy Watch Mode UI (eyes off + progress on) works as expected.
  const shouldAutoAdoptWatchJobId = (payloadOrJob) => {
    if (!ingestElements.watchModeToggle?.checked) return false;

    const payload = (payloadOrJob && typeof payloadOrJob === 'object') ? payloadOrJob : null;
    if (!payload) return false;

    const panel = payload.panel;
    if (panel !== 'ingest' && panel !== 'clone') return false;

    if (!hasJobId(payload.id)) return false;

    // Only auto-adopt when we aren't already tracking a job id.
    if (hasJobId(currentJobId) || hasJobId(pendingQueuedJobId) || hasJobId(cancelPendingJobId)) return false;

    return true;
  };

  const autoAdoptWatchJobIdIfNeeded = (payloadOrJob) => {
    if (!shouldAutoAdoptWatchJobId(payloadOrJob)) return false;
    currentJobId = payloadOrJob.id;
    pendingQueuedJobId = null;
    setIngestCancelPending(false);
    panelLog('log', 'Watch Mode auto-adopted ingest job id from queue event.', { jobId: currentJobId });
    return true;
  };

  ipc.on('queue-job-start', (_e, job) => {
    const adopted = autoAdoptWatchJobIdIfNeeded(job);
    if (!adopted && !isActiveIngestJobEvent(job)) return;
    currentJobId = job.id;
    pendingQueuedJobId = null;
    setIngestCancelPending(false);
    const bar = document.getElementById('ingest-progress');
    const out = document.getElementById('ingest-progress-output');
    if (bar) { bar.value = 0; bar.style.display = 'none'; }
    if (out) out.value = '';
    setIngestInlineProgressActive(true);
    ensureEtaInline();
    showIngestHamster();
    setIngestUiPhase('initializing');

    // Watch Mode UX: when a file is actively processing, hide the "eyes" indicator so
    // the control row doesn't crowd/bunch on narrow panel widths. Between jobs, the
    // eyes will be restored.
    if (ingestElements.watchModeToggle?.checked) {
      setIngestWatchEyesActive(false);
    }
  });

  ipc.on('queue-job-cancelling', (_e, job) => {
    const adopted = autoAdoptWatchJobIdIfNeeded(job);
    if (!adopted && !isActiveIngestJobEvent(job, { allowCancelPending: true })) return;
    if (job?.id) currentJobId = job.id;
    pendingQueuedJobId = null;
    setIngestCancelPending(true, job?.id);
  });

  ipc.on('queue-job-progress', (_event, payload) => {
    const adopted = autoAdoptWatchJobIdIfNeeded(payload);
    if (!adopted && !isActiveIngestJobEvent(payload, { allowCancelPending: true })) return;
    const bar = document.getElementById('ingest-progress');
    const out = document.getElementById('ingest-progress-output');
    if (!bar || !out) return;

    // Flip from "Initializing..." to the normal progress UI once we actually receive progress.
    if (
      ingestUiPhase === 'initializing' &&
      (typeof payload.percent === 'number' || typeof payload.filePercent === 'number')
    ) {
      setIngestUiPhase('running');
    }

    const payloadJobId = normalizeJobId(payload?.id);
    const cancelMatch = cancelPending && jobIdsMatch(payloadJobId, cancelPendingJobId);
    if (cancelMatch) {
      setIngestUiPhase('cancelling');
      setIngestInlineProgressActive(true);
      showIngestHamster();
      return;
    }

    // Keep the inline progress slot visible while progress updates stream in.
    setIngestInlineProgressActive(true);
    const hasOverallPct = typeof payload.percent === 'number';
    const hasFilePct = typeof payload.filePercent === 'number';

    if (hasOverallPct || hasFilePct) {
      const isWatchMode = ingestElements.watchModeToggle?.checked;

      // Always drive the main progress bar from overall percent when available.
      // Overall percent is byte-weighted across the whole job (small files contribute less than large files).
      const pct = hasOverallPct ? payload.percent : payload.filePercent;

      // When we hit 100%, the backend may still be writing logs / summaries.
      // Show "Finalizing..." instead of freezing at 100% (non-watch mode only).
      if (!isWatchMode && pct >= 100 && !cancelPending) {
        setIngestUiPhase('finalizing');
      } else {
        setIngestUiPhase('running');
        bar.style.display = pct >= 100 ? 'none' : 'block';
        bar.value = Math.max(0, Math.min(100, pct));
        out.value = pct >= 100 ? '' : Math.round(pct);
      }

      const etaEl = ensureEtaInline();
      if (etaEl) {
        const showEta = !isWatchMode && pct < 100 && payload.eta;
        etaEl.textContent = showEta ? translate('ingestEtaInline', ' • ETA {{eta}}', { eta: payload.eta }) : '';
      }
    }

    showIngestHamster();

    // Watch Mode UX: progress/hamster visible => hide eyes (prevents UI crowding).
    if (ingestElements.watchModeToggle?.checked) {
      setIngestWatchEyesActive(false);
    }

  });
  ipc.on('queue-job-complete', (_e, job) => {
    const adopted = autoAdoptWatchJobIdIfNeeded(job);
    if (!adopted && !isActiveIngestJobEvent(job, { allowCancelPending: true })) return;
    currentJobId = null;
    pendingQueuedJobId = null;
    setIngestUiPhase('idle');
    const bar = document.getElementById('ingest-progress');
    const out = document.getElementById('ingest-progress-output');
    if (bar) { bar.value = 100; bar.style.display = 'none'; }
    if (out) out.value = '';
    const eta = document.getElementById('ingest-eta-inline');
    if (eta) eta.textContent = '';
    setIngestInlineProgressActive(false);
    hideIngestHamster();
    const isWatchMode = ingestElements.watchModeToggle?.checked;
    const result = job?.result || {};
    applyIngestTerminalUiTransition('complete', isWatchMode, { result });

    // Operator summary (keep the bottom log usable)
    try {
      const panelLabel = job?.panel === 'clone'
        ? translate('ingestPanelLabelClone', 'Clone')
        : translate('ingestPanelLabelIngest', 'Ingest');
      const stats = (result && typeof result === 'object') ? result.stats : null;

      // Watch Mode can process many files; avoid a "success" line for every file.
      const shouldLogInWatch =
        stats && (Number(stats.failed) > 0 || Number(stats.skipped) > 0)
          ? true
          : (result?.skipped === true || result?.cancelled === true);

      const shouldLog = !isWatchMode || shouldLogInWatch;

      if (shouldLog) {
        if (stats && typeof stats === 'object') {
          const ok = Number(stats.success) || 0;
          const skipped = Number(stats.skipped) || 0;
          const failed = Number(stats.failed) || 0;
          const prefix = failed > 0 ? '⚠️' : '✅';
          logIngest(
            translate(
              'ingestPanelCompleteSummaryLog',
              '{{prefix}} {{panel}} complete — OK: {{ok}}  Skipped: {{skipped}}  Failed: {{failed}}',
              { prefix, panel: panelLabel, ok, skipped, failed }
            )
          );
        } else {
          logIngest(
            translate('ingestPanelCompleteLog', '✅ {{panel}} complete.', { panel: panelLabel })
          );
        }

        if (!isWatchMode) {
          const structured = typeof result?.structuredLogPath === 'string' ? result.structuredLogPath.trim() : '';
          const archive = typeof result?.archivePath === 'string' ? result.archivePath.trim() : '';
          if (archive) {
            logIngest(translate('ingestLogSavedPathLog', '📄 Log saved: {{path}}', { path: archive }));
          } else if (structured) {
            logIngest(translate('ingestStructuredLogPathLog', '📄 Structured log: {{path}}', { path: structured }));
          }
        }
      }
    } catch {
      // ignore
    }
  });
  ipc.on('queue-job-failed', (_e, job) => {
    const adopted = autoAdoptWatchJobIdIfNeeded(job);
    if (!adopted && !isActiveIngestJobEvent(job, { allowCancelPending: true })) return;
    currentJobId = null;
    pendingQueuedJobId = null;
    setIngestUiPhase('idle');
    resetIngestProgressUI();
    const logText = resolveIngestDisplayText(job?.result?.logText);
    const summary = resolveIngestDisplayText(job?.result?.summary);
    const structuredLogPath = job?.result?.structuredLogPath?.trim();
    const errCode = typeof job?.error?.code === 'string' ? job.error.code.trim() : '';
    const errMessage = typeof job?.error?.message === 'string'
      ? job.error.message.trim()
      : (typeof job?.error === 'string' ? job.error.trim() : '');
    const errDetail = job?.error && typeof job.error === 'object'
      ? JSON.stringify(job.error)
      : errMessage;
    const failureIntro = translate('ingestJobFailedIntroLog', '❌ Ingest job failed.');
    const failureLines = [];
    if (summary) {
      failureLines.push(`${failureIntro} ${summary}`);
    } else if (logText) {
      failureLines.push(`${failureIntro} ${logText}`);
    } else if (errCode || errMessage) {
      const safeError = resolveIngestDisplayText(ingestErrorFromCode(errCode || 'INGEST_UNHANDLED'));
      failureLines.push(`${failureIntro} ${appendIngestTechnicalDetail(safeError, errMessage)}`);
    } else {
      failureLines.push(failureIntro);
    }
    if (summary && logText && logText !== summary) {
      failureLines.push(translate('ingestJobFailedDetailsLog', 'Details: {{details}}', { details: logText }));
    }
    if ((errCode || errMessage) && summary) {
      const safeError = resolveIngestDisplayText(ingestErrorFromCode(errCode || 'INGEST_UNHANDLED'));
      const renderedError = appendIngestTechnicalDetail(safeError, errMessage);
      if (renderedError && renderedError !== summary) {
        failureLines.push(translate('ingestJobFailedErrorLog', 'Error: {{error}}', { error: renderedError }));
      }
    } else if ((errCode || errMessage) && logText) {
      const safeError = resolveIngestDisplayText(ingestErrorFromCode(errCode || 'INGEST_UNHANDLED'));
      const renderedError = appendIngestTechnicalDetail(safeError, errMessage);
      if (renderedError && renderedError !== logText) {
        failureLines.push(translate('ingestJobFailedErrorLog', 'Error: {{error}}', { error: renderedError }));
      }
    }
    if (job?.error && typeof job.error === 'object') {
      failureLines.push(translate('ingestJobFailedDiagnosticsLog', 'Diagnostics: {{diagnostics}}', { diagnostics: JSON.stringify(job.error) }));
    }
    if (structuredLogPath) {
      failureLines.push(translate('ingestJobFailedStructuredLogPathLog', 'Structured log: {{path}}', { path: structuredLogPath }));
    }
    failureLines.forEach(line => logIngest(line, { isError: true }));
    const isWatchMode = ingestElements.watchModeToggle?.checked;
    applyIngestTerminalUiTransition('failed', isWatchMode, {
      summary,
      logText,
      structuredLogPath,
      error: errDetail
    });
  });
  ipc.on('queue-job-cancelled', (_e, job) => {
    const adopted = autoAdoptWatchJobIdIfNeeded(job);
    if (!adopted && !isActiveIngestJobEvent(job, { allowCancelPending: true })) return;
    currentJobId = null;
    pendingQueuedJobId = null;
    setIngestUiPhase('idle');
    resetIngestProgressUI();
    setIngestCancelPending(false);
    const isWatchMode = ingestElements.watchModeToggle?.checked;
    applyIngestTerminalUiTransition('cancelled', isWatchMode, {
      cancelledByUser: !!job?.cancelledByUser,
      result: job?.result || null
    });
    if (!isWatchMode) {
      logIngest(translate('ingestCancelledLog', '🛑 Ingest cancelled.'));
    }
  });
}

if (window.panelPresetDefaults && !window.__LEAD_INGEST_PRESET_DEFAULTS_REGISTERED__) {
  window.__LEAD_INGEST_PRESET_DEFAULTS_REGISTERED__ = true;
  window.panelPresetDefaults.register({
    panelId: 'ingest',
    presetInputId: 'ingest-preset',
    refreshDropdown: () => refreshPresetDropdown(),
    applyPackagedDefaults: () => resetIngestFields(),
    buildPackagedDefaultPreset: () => gatherIngestConfig(),
    applyPreset: data => applyIngestPreset(data)
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    gatherIngestConfig: globalThis.gatherIngestConfig,
    isWatchConfigValid,
    initIngestPanel: globalThis.initIngestPanel,
    applyIngestPreset,
    refreshPresetDropdown
  };
}

})();
