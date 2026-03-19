/* global loadPanelScript */
(() => {
  // Preview policy: show a sample preview for every text-based output (burn-in excluded).

  // SCC POLICY: CC1–CC4 supported (pop-on only). One SCC export = one caption service.
  // (If you need multiple services in one file, that's a different workflow and not handled here.)

  // ──────────────────────────────────────────────────────────────
  // Transcribe panel: format-scoped Scripted mini-panel wiring
  // Safe wrapper: don't let missing elements crash dropdown.js
  // ──────────────────────────────────────────────────────────────
  function safeSetupDropdown(id, options = [], defaultValue) {
    const el = document.getElementById(id);
    if (!el) {
      panelLog('info', `[dropdown] '#${id}' not found — skipping init`);
      return false;
    }
    try {
      setupStyledDropdown(id, options);
      let nextValue = defaultValue;
      if (nextValue !== undefined && Array.isArray(options) && options.length) {
        const match = options.find(o => o?.value === nextValue);
        if (!match) nextValue = options[0]?.value;
      }
      if (nextValue !== undefined) setDropdownValue(id, nextValue);
      return true;
    } catch (e) {
      panelLog('error', `[dropdown] init failed for #${id}:`, { error: e?.message || e });
      return false;
    }
  }

  // Format reset hooks (assigned by initSccAdvancedUi/initMccUi).
  // The Transcribe panel's main Reset button calls these so users have a single
  // place to restore "friendly" defaults.
  let _resetSccDefaults = null;
  let _resetMccDefaults = null;
  let _resetSrtDefaults = null;
  let _resetVttDefaults = null;

  function normalizeSccChannel(value) {
    const s = String(value ?? '').trim().toUpperCase();
    const m = s.match(/^CC\s*([1-4])$/);
    const n = m ? parseInt(m[1], 10) : parseInt(s, 10);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(4, n));
  }

  function getInclude608CompatibilityEl() {
    return document.getElementById('fmt-mcc-include-608-compatibility')
      || document.getElementById('fmt-mcc-include-608')
      || document.getElementById('include608-compatibility')
      || document.getElementById('include608Compatibility');
  }

  function isInclude608CompatibilityEnabled() {
    return getInclude608CompatibilityEl()?.checked === true;
  }

  function readNumericFps(...ids) {
    for (const id of ids) {
      if (!id) continue;
      const raw = document.getElementById(id)?.value;
      if (raw == null) continue;
      const trimmed = String(raw).trim();
      if (!trimmed) continue;
      const value = parseFloat(trimmed);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

window.logPanel?.log('transcribe', '✅ renderer.transcribe.js loaded');
// Phase 3 UI polish: EDM-on-EOC toggle for SCC

// 🔒 Purge stale SCC keys to prevent "mystery" centering/row changes
['scc-row-policy','edm-on-eoc','rollup-boundary-edm']
  .forEach(k => {
    try {
      localStorage.removeItem(k);
    } catch (err) {
      // Safe to continue: stale-key cleanup is best-effort and non-blocking.
      panelLog('warn', `[startup] unable to clear stale key "${k}"`, { error: err?.message || String(err) });
    }
  });

if (typeof ipc === 'undefined') {
  var ipc = window.ipc ?? window.electron;
}

// Watch mode utilities can be missing (or load later) depending on bundling/load order.
// Always read from window at the call site so we can degrade gracefully.
const getWatchUtils = () => window.watchUtils;

const PANEL_ID = 'transcribe';
const TRANSCRIBE_DEFAULTS = Object.freeze({
  engine: 'whisperx',
  language: 'en',
  accuracy: 'auto',
  translateTarget: 'en',
  translateEnabled: false,
  translateSideBySide: false
});

function clearTranscribePersistedSettings() {
  const exactKeys = new Set([
    'preferred-accuracy-mode',
    'preferred-transcribe-language',
    'preferred-translate-enabled',
    'preferred-translate-side-by-side',
    'preferred-translate-target',
    'gridCols-transcribe'
  ]);
  const prefixMatchers = ['srt-', 'vtt-', 'scc-', 'mcc-'];
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    keys.forEach((k) => {
      if (exactKeys.has(k) || prefixMatchers.some(prefix => k.startsWith(prefix))) {
        try {
          localStorage.removeItem(k);
        } catch (err) {
          panelLog('warn', `[settings] failed to clear persisted key "${k}"`, { error: err?.message || String(err) });
        }
      }
    });
  } catch (err) {
    panelLog('warn', '[settings] failed to enumerate persisted transcribe settings', { error: err?.message || String(err) });
  }
}

function panelLog(level, message, meta) {
  // DEV-only console diagnostics. Keep production users out of DevTools archaeology.
  const isDevUi = (window.electron?.isPackaged === false)
    || (window.electron?.DEBUG_UI === true)
    || (window.DEBUG_UI === true);
  if (!isDevUi) return;

  const formatted = `[${PANEL_ID}] [${String(level || 'info').toUpperCase()}] ${message}`;

  console[level === 'error' ? 'error' : 'log'](formatted, meta || {});
}

const tr = (key, fallback, opts = {}) => {
  try {
    const i18n = window.i18n;
    if (i18n && typeof i18n.t === 'function') {
      return i18n.t(key, { defaultValue: fallback, ...opts });
    }
  } catch (err) {
    panelLog('warn', `[i18n] translation lookup failed for key "${key}"`, { error: err?.message || String(err) });
  }
  return fallback;
};

const assetUi = window.runtimeAssetUi || null;
const startupRuntimeAssetBootstrap = window.runtimeAssetBootstrap || null;
const trTemplate = (key, fallback, replacements = {}) => tr(key, fallback, replacements);

const createRuntimeAssetSummary = (snapshot = {}, options = {}) => {
  if (assetUi && typeof assetUi.buildRuntimeAssetSummary === 'function') {
    return assetUi.buildRuntimeAssetSummary(snapshot, {
      ...options,
      translate: (key, fallback) => tr(key, fallback),
      translateTemplate: (key, fallback, replacements) => trTemplate(key, fallback, replacements)
    });
  }
  return '';
};

const createRuntimeAssetError = (snapshotOrError = {}, options = {}) => {
  if (assetUi && typeof assetUi.createRuntimeAssetError === 'function') {
    return assetUi.createRuntimeAssetError(snapshotOrError, {
      ...options,
      translate: (key, fallback) => tr(key, fallback),
      translateTemplate: (key, fallback, replacements) => trTemplate(key, fallback, replacements)
    });
  }
  if (snapshotOrError instanceof Error) return snapshotOrError;
  const err = new Error(String(snapshotOrError?.error || snapshotOrError?.message || snapshotOrError || tr('transcribeRuntimeAssetRequestFailed', 'Runtime asset request failed')));
  err.code = String(snapshotOrError?.code || 'ASSET_PREFETCH_FAILED').trim() || 'ASSET_PREFETCH_FAILED';
  err.snapshot = snapshotOrError;
  return err;
};

const isRuntimeAssetCancelError = (error) => {
  const code = String(error?.code || error?.snapshot?.error?.code || '').trim().toUpperCase();
  const state = String(error?.snapshot?.state || '').trim().toLowerCase();
  const name = String(error?.name || '').trim().toLowerCase();
  return code === 'ABORT_ERR' || code === 'ABORTED' || state === 'cancelled' || name === 'aborterror';
};

// ──────────────────────────────────────────────────────────────
// i18n helpers for styled dropdown option labels
// (Styled dropdown list items are NOT updated by translatePage,
// so we rebuild these option arrays on language change.)
// ──────────────────────────────────────────────────────────────
const getLanguageOptions = () => ([
  { value: 'en', label: tr('languageEnglish', 'English (EN)') },
  { value: 'es', label: tr('languageSpanish', 'Spanish (ES)') },
  { value: 'fr', label: tr('languageFrench', 'French (FR)') },
  { value: 'de', label: tr('languageGerman', 'German (DE)') },
  { value: 'ja', label: tr('languageJapanese', 'Japanese (JA)') },
  { value: 'zh', label: tr('languageChinese', 'Chinese (ZH)') }
]);

const getAccuracyOptions = () => ([
  { value: 'fast', label: tr('transcribeAccuracyFast', 'Fast') },
  { value: 'auto', label: tr('transcribeAccuracyAuto', 'Auto') },
  { value: 'accurate', label: tr('transcribeAccuracyAccurate', 'Accurate') }
]);

const getTimecodeFormatOptions = () => ([
  { value: 'ndf', label: tr('timecodeFormatNdf', 'NDF — HH:MM:SS:FF') },
  { value: 'df',  label: tr('timecodeFormatDf',  'DF — HH:MM:SS;FF') },
  { value: 'ms',  label: tr('timecodeFormatMs',  'Milliseconds — HH:MM:SS,mmm') }
]);

const getTimestampPlacementOptions = () => ([
  { value: 'none',       label: tr('timestampPlacementNone',      'None') },
  { value: 'start_end',  label: tr('timestampPlacementStartEnd',  'Start–End') },
  { value: 'start',      label: tr('timestampPlacementStartOnly', 'Start only') },
  { value: 'every_line', label: tr('timestampPlacementEveryLine', 'Every line') }
]);

const getLineEndingOptions = () => ([
  { value: 'lf',   label: tr('lineEndingLf',   'LF') },
  { value: 'crlf', label: tr('lineEndingCrlf', 'CRLF') }
]);

const getTranscribeOutputFormatOptions = () => ([
  { value: 'txt',    label: tr('formatPlainText', 'Plain Text (.txt)') },
  { value: 'srt',    label: tr('srt',             'SubRip (.srt)') },
  { value: 'vtt',    label: tr('formatWebVtt',    'WebVTT (.vtt)') },
  {
    value: 'scc',
    label: trTemplate('formatLabelWithBeta', '{{label}} - {{beta}}', {
      label: tr('formatScc', 'Scenarist CC (.scc)'),
      beta: tr('betaTag', 'BETA')
    })
  },
  {
    value: 'mcc',
    label: trTemplate('formatLabelWithBeta', '{{label}} - {{beta}}', {
      label: tr('formatMcc', 'MacCaption (.mcc)'),
      beta: tr('betaTag', 'BETA')
    })
  },
  { value: 'script', label: tr('formatScripted', 'Scripted (CSV)') },
  { value: 'burnIn', label: tr('burnIn',         'Burn-in MP4') }
]);

const getTextAlignmentOptions = () => ([
  { value: 'left',   label: tr('transcribeMccAlignLeft',   'Left') },
  { value: 'center', label: tr('transcribeMccAlignCenter', 'Center') },
  { value: 'right',  label: tr('transcribeMccAlignRight',  'Right') }
]);

const getSccChannelOptions = () => ([
  { value: '1', label: tr('sccChannelCc1', 'CC1 (Field 1 • Channel 1)') },
  { value: '2', label: tr('sccChannelCc2', 'CC2 (Field 1 • Channel 2)') },
  { value: '3', label: tr('sccChannelCc3', 'CC3 (Field 2 • Channel 1)') },
  { value: '4', label: tr('sccChannelCc4', 'CC4 (Field 2 • Channel 2)') }
]);

const getSccTimeSourceOptions = () => ([
  { value: 'auto',      label: tr('transcribe.scc.timeSource.auto') },
  { value: 'start',     label: tr('transcribe.scc.timeSource.startTc') },
  { value: 'ms',        label: tr('transcribe.scc.timeSource.millisecond') },
  { value: 'df-string', label: tr('transcribe.scc.timeSource.dfStringForce') }
]);

const getSccStartResetAtOptions = () => ([
  { value: 'auto',    label: tr('transcribe.scc.startResetAt.autoRecommended') },
  { value: 'off',     label: tr('transcribe.scc.startResetAt.off') },
  { value: 'zero',    label: tr('transcribe.scc.startResetAt.zero') },
  { value: 'startTc', label: tr('transcribe.scc.startResetAt.startTc') },
  { value: 'both',    label: tr('transcribe.scc.startResetAt.both') }
]);

const getSccStartResetOpOptions = () => ([
  { value: 'edm', label: tr('transcribe.scc.startResetOp.edm') },
  { value: 'rdc', label: tr('transcribe.scc.startResetOp.rdc') }
]);

const getSccExportPolicyOptions = () => ([
  { value: 'warn',       label: tr('transcribe.scc.exportPolicy.warn') },
  { value: 'gate_write', label: tr('transcribe.scc.exportPolicy.gateWrite') }
]);

const getMccOverflowPolicyOptions = () => ([
  { value: 'error', label: tr('transcribe.mcc.overflowPolicy.error') },
  { value: 'truncate', label: tr('transcribe.mcc.overflowPolicy.truncate') }
]);

const getMccNegativeTimePolicyOptions = () => ([
  { value: 'clamp', label: tr('transcribe.mcc.negativeTimePolicy.clamp') },
  { value: 'error', label: tr('transcribe.mcc.negativeTimePolicy.error') }
]);

const _getMccAnchorOptions = () => ([
  { value: '7', label: tr('transcribe.mcc.anchor.lowerCenter') },
  { value: '6', label: tr('transcribe.mcc.anchor.lowerLeft') },
  { value: '8', label: tr('transcribe.mcc.anchor.lowerRight') },
  { value: '1', label: tr('transcribe.mcc.anchor.upperCenter') },
  { value: '0', label: tr('transcribe.mcc.anchor.upperLeft') },
  { value: '2', label: tr('transcribe.mcc.anchor.upperRight') },
  { value: '4', label: tr('transcribe.mcc.anchor.center') },
  { value: '3', label: tr('transcribe.mcc.anchor.middleLeft') },
  { value: '5', label: tr('transcribe.mcc.anchor.middleRight') }
]);

const getSccShapeModeOptions = () => ([
  { value: 'off',          label: tr('transcribe.shapeMode.disabled', 'Disabled') },
  { value: 'conservative', label: tr('conservative', 'Conservative') },
  { value: 'aggressive',   label: tr('aggressive', 'Aggressive') }
]);

const getMccShapeModeOptions = () => ([
  { value: 'off',          label: tr('off', 'Off') },
  { value: 'conservative', label: tr('conservative', 'Conservative') },
  { value: 'aggressive',   label: tr('aggressive', 'Aggressive') }
]);

function autoResize(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}


function initTranscribeHideLogToggle() {
  const cb = document.getElementById('transcribe-hide-log');
  const logEl = document.getElementById('transcribe-log-output');
  if (!cb || !logEl) return;

  const storageKey = 'ui.transcribe.hideLogWindow';

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

const LOG_MAX_LINES = 5000;
const LOG_MAX_CHARS = 2 * 1024 * 1024;
const logBuffers = new WeakMap();

function isTextInputLike(el) {
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
}

function readLogElText(el) {
  if (!el) return '';
  return isTextInputLike(el) ? String(el.value || '') : String(el.textContent || '');
}

function writeLogElText(el, text) {
  if (!el) return;
  const s = text == null ? '' : String(text);
  if (isTextInputLike(el)) el.value = s;
  else el.textContent = s;
}

function trimLogBuffer(buffer) {
  while (buffer.lines.length > LOG_MAX_LINES || buffer.charCount > LOG_MAX_CHARS) {
    const removed = buffer.lines.shift() ?? '';
    buffer.charCount -= removed.length;
    if (buffer.lines.length > 0) {
      buffer.charCount -= 1;
    }
  }
  if (buffer.charCount < 0) buffer.charCount = 0;
}

function getLogBuffer(logEl) {
  if (!logEl) return null;
  let buffer = logBuffers.get(logEl);
  if (!buffer) {
    const existing = readLogElText(logEl);
    const lines = existing ? existing.split('\n') : [];
    buffer = { lines, charCount: existing.length };
    trimLogBuffer(buffer);
    logBuffers.set(logEl, buffer);
  }
  return buffer;
}

function renderLogBuffer(logEl, buffer) {
  if (!logEl || !buffer) return;
  writeLogElText(logEl, buffer.lines.join('\n'));
  logEl.scrollTop = logEl.scrollHeight;
}

function setLogText(logEl, text) {
  if (!logEl) return;
  const safeText = text == null ? '' : String(text);
  const buffer = getLogBuffer(logEl) || { lines: [], charCount: 0 };
  buffer.lines = safeText ? safeText.split('\n') : [];
  buffer.charCount = safeText.length;
  trimLogBuffer(buffer);
  logBuffers.set(logEl, buffer);
  renderLogBuffer(logEl, buffer);
}

function appendLogLine(logEl, text) {
  if (!logEl) return;
  const buffer = getLogBuffer(logEl);
  if (!buffer) return;
  const line = text == null ? '' : String(text);
  if (buffer.lines.length > 0) buffer.charCount += 1;
  buffer.lines.push(line);
  buffer.charCount += line.length;
  trimLogBuffer(buffer);
  renderLogBuffer(logEl, buffer);
}

function setupResizableGrid(gridEl, storageKey) {
  if (!gridEl) return;
  const isFirstInit = gridEl.dataset.resizable !== '1';
  if (isFirstInit) gridEl.dataset.resizable = '1';

  const COL_VARS = [
    '--col-file', '--col-format', '--col-resolution',
    '--col-fps', '--col-audio', '--col-duration'
  ];

  // Restore saved widths on first init only (avoid stomping active drag state).
  if (isFirstInit) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      COL_VARS.forEach(v => { if (saved[v]) gridEl.style.setProperty(v, saved[v]); });
    } catch {}
  }

  const headers = gridEl.querySelectorAll('.file-info-grid-header');
  headers.forEach((h, idx) => {
    h.style.position = 'relative';
    let handle = h.querySelector(':scope > .resize-handle');
    if (!handle) {
      handle = document.createElement('span');
      handle.className = 'resize-handle';
      h.appendChild(handle);
    }
    handle.title = tr('transcribeResizeHandleTooltip', 'Drag to resize • Double‑click to auto‑fit');

    let startX = 0, startW = 0;

    const finish = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      gridEl.classList.remove('resizing');
      // Persist current sizes
      const map = {};
      COL_VARS.forEach(v => {
        const val = gridEl.style.getPropertyValue(v);
        if (val) map[v] = val.trim();
      });
      try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
    };

    const onMove = (e) => {
      const dx = e.clientX - startX;
      const newW = Math.max(90, startW + dx); // clamp min width
      gridEl.style.setProperty(COL_VARS[idx], newW + 'px');
    };

    const onUp = () => finish();

    if (handle.dataset.resizeBound !== '1') {
      handle.dataset.resizeBound = '1';
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = h.getBoundingClientRect().width;
        gridEl.classList.add('resizing');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    // Double‑click header to auto‑fit column to content
    if (h.dataset.resizeDblclickBound !== '1') {
      h.dataset.resizeDblclickBound = '1';
      h.addEventListener('dblclick', () => {
        // children: 6 header cells, then body cells repeating in groups of 6
        const all = Array.from(gridEl.children);
        const body = all.slice(6);
        let maxW = h.scrollWidth;
        for (let i = idx; i < body.length; i += 6) {
          const w = body[i]?.scrollWidth || 0;
          if (w > maxW) maxW = w;
        }
        const pad = 24;
        const clientWidth = gridEl.clientWidth || 0;
        const maxWidth = Math.max(90, clientWidth - 60);
        const fittedW = Math.max(maxW + pad, 90);
        const newW = clientWidth === 0 ? fittedW : Math.min(fittedW, maxWidth);
        gridEl.style.setProperty(COL_VARS[idx], newW + 'px');
        // persist after auto-fit
        const map = {};
        COL_VARS.forEach(v => {
          const val = gridEl.style.getPropertyValue(v);
          if (val) map[v] = val.trim();
        });
        try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
      });
    }
  });
}

function refreshTranscribeResizeHandleTooltips() {
  const infoEl = document.getElementById('transcribe-file-info');
  if (!infoEl) return;
  const tooltip = tr('transcribeResizeHandleTooltip', 'Drag to resize • Double‑click to auto‑fit');
  infoEl.querySelectorAll('.resize-handle').forEach((handle) => {
    handle.title = tooltip;
  });
}

const FILE_INFO_HEADER_KEYS = Object.freeze([
  { primary: 'transcribeFileInfoHeaderFile', fallbackKey: 'fileInfoColumnFile', fallbackText: 'File' },
  { primary: 'transcribeFileInfoHeaderFormat', fallbackKey: 'fileInfoColumnFormat', fallbackText: 'Format' },
  { primary: 'transcribeFileInfoHeaderResolution', fallbackKey: 'fileInfoColumnResolution', fallbackText: 'Resolution' },
  { primary: 'transcribeFileInfoHeaderFps', fallbackKey: 'fileInfoColumnFps', fallbackText: 'FPS' },
  { primary: 'transcribeFileInfoHeaderAudio', fallbackKey: 'fileInfoColumnAudio', fallbackText: 'Audio' },
  { primary: 'transcribeFileInfoHeaderDuration', fallbackKey: 'fileInfoColumnDuration', fallbackText: 'Duration' }
]);

function getTranslatedFileInfoHeaderLabel(def) {
  const fromTranscribeScope = tr(def.primary, def.fallbackText);
  if (fromTranscribeScope !== def.primary) return fromTranscribeScope;
  const fromSharedScope = tr(def.fallbackKey, def.fallbackText);
  return fromSharedScope === def.fallbackKey ? def.fallbackText : fromSharedScope;
}

const getFileInfoHeaders = () => FILE_INFO_HEADER_KEYS
  .map(def => `\n  <div class="file-info-grid-header">${getTranslatedFileInfoHeaderLabel(def)}</div>`)
  .join('');

function reapplyTranscribeFileInfoHeaders() {
  const infoEl = document.getElementById('transcribe-file-info');
  if (!infoEl) return;

  const rows = Array.from(infoEl.querySelectorAll(':scope > .file-info-row'));
  const headers = Array.from(infoEl.querySelectorAll(':scope > .file-info-grid-header'));
  const expectedCount = FILE_INFO_HEADER_KEYS.length;

  // Fast-path: update labels in-place so current rows/state remain untouched.
  if (headers.length === expectedCount) {
    FILE_INFO_HEADER_KEYS.forEach((def, idx) => {
      const header = headers[idx];
      const nextLabel = getTranslatedFileInfoHeaderLabel(def);
      const handle = header.querySelector(':scope > .resize-handle');
      const labelNode = header.querySelector(':scope > .file-info-grid-header-label');
      if (labelNode) {
        labelNode.textContent = nextLabel;
      } else if (handle) {
        const label = document.createElement('span');
        label.className = 'file-info-grid-header-label';
        label.textContent = nextLabel;
        header.insertBefore(label, handle);
      } else {
        header.textContent = nextLabel;
      }
    });
    refreshTranscribeResizeHandleTooltips();
    return;
  }

  // Safe rebuild fallback: preserve existing rows while re-seeding translated headers.
  infoEl.textContent = '';
  const fragment = document.createDocumentFragment();
  FILE_INFO_HEADER_KEYS.forEach((def) => {
    const header = document.createElement('div');
    header.className = 'file-info-grid-header';
    const label = document.createElement('span');
    label.className = 'file-info-grid-header-label';
    label.textContent = getTranslatedFileInfoHeaderLabel(def);
    header.appendChild(label);
    fragment.appendChild(header);
  });
  rows.forEach(row => fragment.appendChild(row));
  infoEl.appendChild(fragment);
  setupResizableGrid(infoEl, 'gridCols-transcribe');
  refreshTranscribeResizeHandleTooltips();
}

function resetFileInfoGrid(panelId, storageKey) {
  const infoEl = document.getElementById(`${panelId}-file-info`);
  if (!infoEl) return null;
  infoEl.classList.add('file-info-grid');
  infoEl.classList.add('placeholder');
  infoEl.innerHTML = getFileInfoHeaders();
  if (panelId === 'transcribe') reapplyTranscribeFileInfoHeaders();
  delete infoEl.dataset.resizable;

  const COL_VARS = [
    '--col-file',
    '--col-format',
    '--col-resolution',
    '--col-fps',
    '--col-audio',
    '--col-duration'
  ];
  COL_VARS.forEach(v => infoEl.style.removeProperty(v));

  if (storageKey) {
    try { localStorage.removeItem(storageKey); } catch {}
  }

  const wrapper = infoEl.closest('.file-info-scroll');
  if (wrapper) {
    wrapper.scrollLeft = 0;
  }

  return infoEl;
}

function prepareFileInfoGrid(panelId) {
  const infoEl = document.getElementById(`${panelId}-file-info`);
  if (!infoEl) return null;
  infoEl.classList.add('file-info-grid');
  infoEl.classList.remove('placeholder');
  infoEl.innerHTML = getFileInfoHeaders();
  if (panelId === 'transcribe') reapplyTranscribeFileInfoHeaders();
  delete infoEl.dataset.resizable;

  const wrapper = infoEl.closest('.file-info-scroll');
  if (wrapper) {
    wrapper.classList.remove('no-hscroll');
  }

  return infoEl;
}

// Phase 2 security: build file-info grid rows with DOM APIs (no innerHTML/insertAdjacentHTML)
// This blocks XSS via filenames, paths, or ffprobe/ffmpeg error strings.
function makeFileInfoCell(text, opts = {}) {
  const cell = document.createElement('div');
  if (opts && typeof opts === 'object') {
    if (opts.title != null) cell.title = String(opts.title);
    if (opts.gridColumn != null) cell.style.gridColumn = String(opts.gridColumn);
  }
  cell.textContent = text == null ? '' : String(text);
  return cell;
}

function appendFileInfoRow(gridEl, cells = []) {
  if (!gridEl) return null;
  const row = document.createElement('div');
  row.className = 'file-info-row';
  for (const cell of cells) {
    if (cell) row.appendChild(cell);
  }
  gridEl.appendChild(row);
  return row;
}

function logTranscribe(msg, opts = {}) {
  window.logPanel?.log('transcribe', msg, opts);
}

// 🐹 Hamster helpers (same structure used elsewhere)
function ensureHamsterStructure(root) {
  if (!root) return;
  if (root.querySelector('.wheel')) return; // already built
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

// REPLACE your existing toggleTranscribing with this version
function toggleTranscribing(show) {
  const on = !!show;
  const label = tr('transcribeStatusTranscribing', 'Transcribing...');

  // Defensive cleanup: if the class/attr ever got applied to the container,
  // it produces the giant 90px cursor bar you’re seeing.
  if (el.loaderInline) {
    el.loaderInline.classList.remove('lae-scan-text');
    el.loaderInline.removeAttribute('data-scan-text');
  }

  // Match Transcode/SpeedTest behaviour: keep the slot reserved, only toggle visibility.
  if (el.loaderInline) el.loaderInline.classList.toggle('is-active', on);
  if (el.statusText) {
    // Animated scanner prompt (matches Speed Test "Running..." style)
    el.statusText.classList.toggle('lae-scan-text', on);
    if (on) {
      // data-scan-text drives the CSS animation; textContent is for accessibility.
      el.statusText.setAttribute('data-scan-text', label);
      el.statusText.textContent = label;
    } else {
      el.statusText.removeAttribute('data-scan-text');
      el.statusText.textContent = '';
    }
  }

  // Watch Mode UX: alternate between eyes (idle) and progress/hamster (active).
  // When a file is actively transcribing, hide the eyes to prevent UI crowding.
  // Between jobs, restore the eyes while Watch Mode remains active.
  const watchActive =
    transcribeWatchSessionRunning ||
    el.cancelBtn?.dataset?.watchActive === '1' ||
    (el.watchMode?.checked === true && el.watchMode?.disabled === true);

  if (watchActive) {
    setTranscribeWatchEyesActive(!on);
  } else {
    setTranscribeWatchEyesActive(false);
  }

  const status = el.jobStatus || document.getElementById('transcribe-job-status');
  if (!status) return;

  status.classList.toggle('is-active', on);

  if (on) {
    // Ensure there is a .wheel-and-hamster container and that it has inner parts
    let wheel = status.querySelector('.wheel-and-hamster');
    if (!wheel) {
      wheel = document.createElement('div');
      wheel.className = 'wheel-and-hamster';
      status.appendChild(wheel);
    }
    ensureHamsterStructure(wheel);
    status.dataset.jobActive = 'true';
  } else {
    delete status.dataset.jobActive;
    // Optional: clear markup so the animation resets next time, but keep layout slot.
    const wheel = status.querySelector('.wheel-and-hamster');
    if (wheel) wheel.innerHTML = '';
  }
}

function refreshActiveTranscribeStatusLabel() {
  const loaderInline = el.loaderInline || document.getElementById('transcribe-loader-inline');
  const statusText = el.statusText || document.getElementById('transcribe-status-text');
  const isActive = !!loaderInline?.classList?.contains('is-active');
  if (!isActive || !statusText) return;

  const label = tr('transcribeStatusTranscribing', 'Transcribing...');
  statusText.setAttribute('data-scan-text', label);
  statusText.textContent = label;
}

function setTranscribeWatchEyesActive(active) {
  const host = document.getElementById('transcribe-watch-eyes');
  if (!host) return;
  const on = !!active;
  host.classList.toggle('is-active', on);
  host.setAttribute('aria-hidden', on ? 'false' : 'true');
  host.closest('.watch-eyes-slot')?.classList.toggle('is-active', on);
}

let currentJobId = null;
let cancelPendingJobId = null;
let transcribeWatchSessionRunning = false;

function setTranscribeWatchSessionRunning(isRunning) {
  const next = !!isRunning;
  if (next === transcribeWatchSessionRunning) return;
  transcribeWatchSessionRunning = next;
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

// Cache ffprobe metadata for the currently selected source files.
// Used for UX preflight checks (e.g. SCC timebase validation) without re-probing.
const transcribeFileMetaCache = new Map();

const presetDir = window.electron.resolvePath('config', 'presets', 'transcribe');

// Late-load safe init (matches Speed Test / Transcode pattern)
function initTranscribeDropdowns() {
  clearTranscribePersistedSettings();
  const engineOpts = [
    { value: 'whisperx', label: tr('transcribeEngineWhisperx', 'WhisperX') },
    { value: 'whisper', label: tr('transcribeEngineWhisperapi', 'WhisperAPI') },
    { value: 'lead', label: tr('transcribeEngineLeadAi', 'Lead AI') }
  ];
  const savedModel = TRANSCRIBE_DEFAULTS.engine;
  safeSetupDropdown('transcribe-engine', engineOpts, savedModel);

  const languageOpts = getLanguageOptions();
  const savedLang = TRANSCRIBE_DEFAULTS.language;
  safeSetupDropdown('transcribe-language', languageOpts, savedLang);

  const accuracyOpts = getAccuracyOptions();
  const savedAccuracy = TRANSCRIBE_DEFAULTS.accuracy;
  const accuracyDefault = (accuracyOpts.find(o => o.value === savedAccuracy)?.value)
    || (accuracyOpts[1]?.value ?? accuracyOpts[0]?.value);
  safeSetupDropdown('transcribe-accuracy-mode', accuracyOpts, accuracyDefault);

  const translateOpts = [...languageOpts];
  const savedTarget = TRANSCRIBE_DEFAULTS.translateTarget;
  safeSetupDropdown('translate-target', translateOpts, savedTarget);

  try {
    const te = document.getElementById('translate-enable');
    if (te) te.checked = TRANSCRIBE_DEFAULTS.translateEnabled;
    const sbs = document.getElementById('translate-side-by-side');
    if (sbs) sbs.checked = TRANSCRIBE_DEFAULTS.translateSideBySide;
  } catch {}

  safeSetupDropdown('transcribe-timecode-style', getTimecodeFormatOptions(), 'ndf');


  // ──────────────────────────────────────────────────────────────
  // TXT (format‑scoped) controls — Option B
  // ──────────────────────────────────────────────────────────────
  // Timecode format (NDF / DF / ms) for TXT
  // (Phase B) Caption deliverables assume 29.97 DF by default.
  // TXT timecodes still auto-coerce to NDF for non-DF frame rates when writing.
  safeSetupDropdown('fmt-txt-timecode-format', getTimecodeFormatOptions(), 'df');

  // Timestamp placement (TXT)
  safeSetupDropdown('fmt-txt-timestamp-placement', getTimestampPlacementOptions(), 'none');

  // TXT: Timestamp Placement now controls whether timecodes are included.
  // When set to 'none', timecode-specific controls become non-interactive.
  try {
    const tp = document.getElementById('fmt-txt-timestamp-placement');
    if (tp && tp.dataset.tpBound !== '1') {
      tp.dataset.tpBound = '1';
      tp.addEventListener('change', () => {
        try { applyTxtTimestampPlacementLocks(); } catch {}
        try { updateDisabledOutputFormats(); } catch {}
      });
    }
  } catch {}
  try { applyTxtTimestampPlacementLocks(); } catch {}

  // Output hygiene (SRT): line endings
  safeSetupDropdown('fmt-srt-line-ending', getLineEndingOptions(), 'lf');

  // ──────────────────────────────────────────────────────────────
  // VTT advanced settings (no delivery profiles)
  // Persist caption shaping + VTT QC controls so they behave as
  // stable defaults (including before opening Subtitle Editor).
  // ──────────────────────────────────────────────────────────────
  (function initVttPrefsPersistence() {
    const guard = document.getElementById('fmt-vtt-qc-max-cps') || document.getElementById('fmt-vtt-max-chars');
    if (!guard || guard.dataset.vttBound === '1') return;
    guard.dataset.vttBound = '1';

    const clamp = (n, lo, hi) => {
      let v = Number(n);
      if (!Number.isFinite(v)) return null;
      if (typeof lo === 'number') v = Math.max(lo, v);
      if (typeof hi === 'number') v = Math.min(hi, v);
      return v;
    };

    const restoreNum = (id, lsKey, defVal, { integer = false, min = null, max = null } = {}) => {
      const el = document.getElementById(id);
      if (!el) return;
      let raw = '';
      try { raw = String(localStorage.getItem(lsKey) ?? '').trim(); } catch { raw = ''; }
      const base = raw === '' ? defVal : Number(raw);
      let v = clamp(base, min, max);
      if (v == null) v = defVal;
      if (integer) v = Math.trunc(v);
      el.value = String(v);
    };

    const restoreBool = (id, lsKey, defVal) => {
      const el = document.getElementById(id);
      if (!el || typeof el.checked !== 'boolean') return;
      try {
        const raw = localStorage.getItem(lsKey);
        if (raw == null || raw === '') el.checked = !!defVal;
        else el.checked = (raw === 'true');
      } catch {
        el.checked = !!defVal;
      }
    };

    const bindNum = (id, lsKey, defVal, { integer = false, min = null, max = null } = {}) => {
      const el = document.getElementById(id);
      if (!el) return;
      const save = () => {
        const raw = String(el.value ?? '').trim();
        const base = raw === '' ? defVal : Number(raw);
        let v = clamp(base, min, max);
        if (v == null) v = defVal;
        if (integer) v = Math.trunc(v);
        el.value = String(v);
        try { localStorage.setItem(lsKey, String(v)); } catch {}
      };
      el.addEventListener('change', save);
    };

    const bindBool = (id, lsKey) => {
      const el = document.getElementById(id);
      if (!el || typeof el.checked !== 'boolean') return;
      const save = () => {
        try { localStorage.setItem(lsKey, el.checked ? 'true' : 'false'); } catch {}
      };
      el.addEventListener('change', save);
    };

    // Caption shaping controls (VTT-specific)
    restoreNum('fmt-vtt-max-chars', 'vtt-max-chars', 42, { integer: true, min: 1, max: 200 });
    restoreNum('fmt-vtt-max-lines', 'vtt-max-lines', 2, { integer: true, min: 1, max: 3 });
    restoreNum('fmt-vtt-max-duration', 'vtt-max-duration', 6.0, { min: 0.1, max: 60 });

    // Writer-facing VTT toggles.
    restoreBool('fmt-vtt-include-style', 'vtt-include-style', false);
    // VTT QC / timing behavior (Advanced QC options).
    restoreNum('fmt-vtt-qc-max-cps', 'vtt-qc-max-cps', 20, { min: 1, max: 100 });
    restoreNum('fmt-vtt-qc-min-duration', 'vtt-qc-min-duration', 1.0, { min: 0, max: 60 });
    restoreNum('fmt-vtt-qc-min-split-duration', 'vtt-qc-min-split-duration', 0.5, { min: 0, max: 60 });
    restoreBool('fmt-vtt-prevent-overlaps', 'vtt-prevent-overlaps', false);
    restoreBool('fmt-vtt-allow-extension', 'vtt-allow-extension', true);
    restoreNum('fmt-vtt-max-end-extension', 'vtt-max-end-extension', 1.5, { min: 0, max: 60 });

    bindNum('fmt-vtt-max-chars', 'vtt-max-chars', 42, { integer: true, min: 1, max: 200 });
    bindNum('fmt-vtt-max-lines', 'vtt-max-lines', 2, { integer: true, min: 1, max: 3 });
    bindNum('fmt-vtt-max-duration', 'vtt-max-duration', 6.0, { min: 0.1, max: 60 });
    bindBool('fmt-vtt-include-style', 'vtt-include-style');
    bindNum('fmt-vtt-qc-max-cps', 'vtt-qc-max-cps', 20, { min: 1, max: 100 });
    bindNum('fmt-vtt-qc-min-duration', 'vtt-qc-min-duration', 1.0, { min: 0, max: 60 });
    bindNum('fmt-vtt-qc-min-split-duration', 'vtt-qc-min-split-duration', 0.5, { min: 0, max: 60 });
    bindBool('fmt-vtt-prevent-overlaps', 'vtt-prevent-overlaps');
    bindBool('fmt-vtt-allow-extension', 'vtt-allow-extension');
    bindNum('fmt-vtt-max-end-extension', 'vtt-max-end-extension', 1.5, { min: 0, max: 60 });

    // Expose a reset hook for the panel Reset button.
    _resetVttDefaults = () => {
      const setNum = (id, v) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = String(v);
        try { el.dispatchEvent(new Event('change')); } catch {}
      };
      const setBool = (id, v) => {
        const el = document.getElementById(id);
        if (!el || typeof el.checked !== 'boolean') return;
        el.checked = !!v;
        try { el.dispatchEvent(new Event('change')); } catch {}
      };

      setNum('fmt-vtt-max-chars', 42);
      setNum('fmt-vtt-max-lines', 2);
      setNum('fmt-vtt-max-duration', 6.0);
      setBool('fmt-vtt-include-style', false);
      setNum('fmt-vtt-qc-max-cps', 20);
      setNum('fmt-vtt-qc-min-duration', 1.0);
      setNum('fmt-vtt-qc-min-split-duration', 0.5);
      setBool('fmt-vtt-prevent-overlaps', false);
      setBool('fmt-vtt-allow-extension', true);
      setNum('fmt-vtt-max-end-extension', 1.5);
    };
  })();

  // ──────────────────────────────────────────────────────────────
  // SRT advanced settings + output hygiene
  // Persist SRT QC controls so they behave as stable defaults.
  // ──────────────────────────────────────────────────────────────
  (function initSrtPrefsPersistence() {
    const guard = document.getElementById('fmt-srt-qc-max-cps') || document.getElementById('fmt-srt-include-speaker-names');
    if (!guard || guard.dataset.srtBound === '1') return;
    guard.dataset.srtBound = '1';

    // Migration: older builds treated shaping as shared (stored under vtt-* keys).
    // If SRT shaping keys are unset, copy the prior shared values so behavior
    // doesn't change unexpectedly for existing users.
    try {
      const hasSrtChars = String(localStorage.getItem('srt-max-chars') ?? '').trim();
      const hasSrtLines = String(localStorage.getItem('srt-max-lines') ?? '').trim();
      const hasSrtDur = String(localStorage.getItem('srt-max-duration') ?? '').trim();

      if (!hasSrtChars) {
        const v = String(localStorage.getItem('vtt-max-chars') ?? '').trim();
        if (v) localStorage.setItem('srt-max-chars', v);
      }
      if (!hasSrtLines) {
        const v = String(localStorage.getItem('vtt-max-lines') ?? '').trim();
        if (v) localStorage.setItem('srt-max-lines', v);
      }
      if (!hasSrtDur) {
        const v = String(localStorage.getItem('vtt-max-duration') ?? '').trim();
        if (v) localStorage.setItem('srt-max-duration', v);
      }
    } catch {}

    const clamp = (n, lo, hi) => {
      let v = Number(n);
      if (!Number.isFinite(v)) return null;
      if (typeof lo === 'number') v = Math.max(lo, v);
      if (typeof hi === 'number') v = Math.min(hi, v);
      return v;
    };

    const restoreNum = (id, lsKey, defVal, { integer = false, min = null, max = null } = {}) => {
      const el = document.getElementById(id);
      if (!el) return;
      let raw = '';
      try { raw = String(localStorage.getItem(lsKey) ?? '').trim(); } catch { raw = ''; }
      const base = raw === '' ? defVal : Number(raw);
      let v = clamp(base, min, max);
      if (v == null) v = defVal;
      if (integer) v = Math.trunc(v);
      el.value = String(v);
    };

    const restoreBool = (id, lsKey, defVal = false) => {
      const el = document.getElementById(id);
      if (!el || typeof el.checked !== 'boolean') return;
      let raw = '';
      try { raw = String(localStorage.getItem(lsKey) ?? '').trim(); } catch { raw = ''; }
      if (raw === '') {
        el.checked = !!defVal;
      } else {
        const s = raw.toLowerCase();
        el.checked = ['1', 'true', 'yes', 'on'].includes(s);
      }
    };

    const restoreDd = (hiddenId, lsKey, defVal) => {
      const el = document.getElementById(hiddenId);
      if (!el) return;
      let raw = '';
      try { raw = String(localStorage.getItem(lsKey) ?? '').trim(); } catch { raw = ''; }
      const v = raw === '' ? defVal : raw;
      try { setDropdownValue(hiddenId, v); } catch {}
      el.value = v;
      try { el.dispatchEvent(new Event('change')); } catch {}
    };

    // Shaping (format-specific)
    restoreNum('fmt-srt-max-chars', 'srt-max-chars', 42, { integer: true, min: 1, max: 200 });
    restoreNum('fmt-srt-max-lines', 'srt-max-lines', 2, { integer: true, min: 1, max: 3 });
    restoreNum('fmt-srt-max-duration', 'srt-max-duration', 6.0, { min: 0.1, max: 60 });
    // Defaults (spec): maxCPS=20, minDur=1.0, minSplit=0.5, preventOverlaps=ON, allowExtension=ON, maxEndExtension=1.5.
    restoreNum('fmt-srt-qc-max-cps', 'srt-qc-max-cps', 20, { min: 1, max: 100 });
    restoreNum('fmt-srt-qc-min-duration', 'srt-qc-min-duration', 1.0, { min: 0, max: 60 });
    restoreNum('fmt-srt-qc-min-split-duration', 'srt-qc-min-split-duration', 0.5, { min: 0, max: 60 });
    restoreBool('fmt-srt-prevent-overlaps', 'srt-prevent-overlaps', true);
    restoreBool('fmt-srt-allow-extension', 'srt-allow-extension', true);
    restoreNum('fmt-srt-max-end-extension', 'srt-max-end-extension', 1.5, { min: 0, max: 60 });

    restoreBool('fmt-srt-utf8-bom', 'srt-utf8-bom', false);
    restoreDd('fmt-srt-line-ending', 'srt-line-ending', 'lf');

    const bindNum = (id, lsKey, defVal, { min = null, max = null } = {}) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        const v = clamp(el.value, min, max);
        const out = (v == null) ? defVal : v;
        try { localStorage.setItem(lsKey, String(out)); } catch {}
      });
    };

    const bindBool = (id, lsKey) => {
      const el = document.getElementById(id);
      if (!el || typeof el.checked !== 'boolean') return;
      el.addEventListener('change', () => {
        try { localStorage.setItem(lsKey, el.checked ? '1' : '0'); } catch {}
      });
    };

    const bindDd = (hiddenId, lsKey, defVal) => {
      const el = document.getElementById(hiddenId);
      if (!el) return;
      el.addEventListener('change', () => {
        const v = String(el.value || '').trim() || defVal;
        try { localStorage.setItem(lsKey, v); } catch {}
      });
    };

    bindNum('fmt-srt-max-chars', 'srt-max-chars', 42, { min: 1, max: 200 });
    bindNum('fmt-srt-max-lines', 'srt-max-lines', 2, { min: 1, max: 3 });
    bindNum('fmt-srt-max-duration', 'srt-max-duration', 6.0, { min: 0.1, max: 60 });

    bindNum('fmt-srt-qc-max-cps', 'srt-qc-max-cps', 20, { min: 1, max: 100 });
    bindNum('fmt-srt-qc-min-duration', 'srt-qc-min-duration', 1.0, { min: 0, max: 60 });
    bindNum('fmt-srt-qc-min-split-duration', 'srt-qc-min-split-duration', 0.5, { min: 0, max: 60 });
    bindBool('fmt-srt-prevent-overlaps', 'srt-prevent-overlaps');
    bindBool('fmt-srt-allow-extension', 'srt-allow-extension');
    bindNum('fmt-srt-max-end-extension', 'srt-max-end-extension', 1.5, { min: 0, max: 60 });

    bindBool('fmt-srt-utf8-bom', 'srt-utf8-bom');
    bindDd('fmt-srt-line-ending', 'srt-line-ending', 'lf');
    // Expose a reset hook for the panel Reset button.
    _resetSrtDefaults = () => {
      const setNum = (id, v) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = String(v);
        try { el.dispatchEvent(new Event('change')); } catch {}
      };
      const setBool = (id, v) => {
        const el = document.getElementById(id);
        if (!el || typeof el.checked !== 'boolean') return;
        el.checked = !!v;
        try { el.dispatchEvent(new Event('change')); } catch {}
      };
      const setDd = (id, v) => {
        const el = document.getElementById(id);
        if (!el) return;
        try { setDropdownValue(id, v); } catch {}
        el.value = v;
        try { el.dispatchEvent(new Event('change')); } catch {}
      };

      setNum('fmt-srt-qc-max-cps', 20);
      setNum('fmt-srt-qc-min-duration', 1.0);
      setNum('fmt-srt-qc-min-split-duration', 0.5);
      setBool('fmt-srt-prevent-overlaps', true);
      setBool('fmt-srt-allow-extension', true);
      setNum('fmt-srt-max-end-extension', 1.5);

      setNum('fmt-srt-max-chars', 42);
      setNum('fmt-srt-max-lines', 2);
      setNum('fmt-srt-max-duration', 6.0);

      setBool('fmt-srt-utf8-bom', false);
      setDd('fmt-srt-line-ending', 'lf');
    };
  })();
  // SCRIPT (format‑scoped) controls
  safeSetupDropdown('fmt-script-timestamp-placement', getTimestampPlacementOptions(), 'none');
  safeSetupDropdown('fmt-script-timecode-format', getTimecodeFormatOptions(), 'ndf');

  // Scripted: Timestamp Placement now controls whether timecodes are included.
  // When set to 'none', timecode-specific controls become non-interactive.
  try {
    const tp = document.getElementById('fmt-script-timestamp-placement');
    if (tp && tp.dataset.tpBound !== '1') {
      tp.dataset.tpBound = '1';
      tp.addEventListener('change', () => {
        try { applyScriptTimestampPlacementLocks(); } catch {}
      });
    }
  } catch {}
  try { applyScriptTimestampPlacementLocks(); } catch {}

  const formatOpts = getTranscribeOutputFormatOptions();

  // --- SAFETY: Wait for the multi-select wrapper before initializing ---
  const fmtEl = document.getElementById('transcribe-output-formats');
  if (!fmtEl) {
    panelLog('warn', '⚠️ Output Format dropdown not yet in DOM — retrying...');
    return setTimeout(initTranscribeDropdowns, 50);  // retry after DOM settles
  }

  safeSetupDropdown('transcribe-output-formats', formatOpts, 'txt');
  // If a legacy preset or saved value was "markers", force a sane default.
  if (fmtEl && fmtEl.value === 'markers') {
    setDropdownValue('transcribe-output-formats', 'txt');
    fmtEl.value = 'txt';
  }

  // === SCC alignment ===
  const alignOpts = getTextAlignmentOptions();
  const savedAlign = (localStorage.getItem('scc-alignment') || 'center');
  const alignDefault = (alignOpts.find(o => o.value === savedAlign)?.value)
    || (alignOpts.find(o => o.value === 'center')?.value)
    || alignOpts[0]?.value;
  safeSetupDropdown('scc-alignment', alignOpts, alignDefault);
  document.getElementById('scc-alignment')?.addEventListener('change', e => {
    try { localStorage.setItem('scc-alignment', e.target.value); } catch {}
  });

  // === SCC caption service (CC1–CC4) ===
  const svcOpts = getSccChannelOptions();
  let savedSvc = '1';
  try { savedSvc = localStorage.getItem('scc-channel') || '1'; } catch {}
  const svcDefault = String(normalizeSccChannel(savedSvc));
  safeSetupDropdown('scc-channel', svcOpts, svcDefault);
  document.getElementById('scc-channel')?.addEventListener('change', e => {
    try {
      const v = String(normalizeSccChannel(e.target.value));
      // Keep stored values canonical ('1'..'4')
      if (v !== e.target.value) e.target.value = v;
      localStorage.setItem('scc-channel', v);
    } catch {}
  });

  // === SCC placement (CEA-608) ===
  // Placement mode dropdown removed: SCC placement is always user-driven via the Visual placement grid.
  // Keep the legacy preference key for backward compatibility and force it to 'custom'.
  try { localStorage.setItem('scc-placement-mode', 'custom'); } catch {}
  try {
    const pmEl = document.getElementById('fmt-scc-placement-mode');
    if (pmEl) pmEl.value = 'custom';
  } catch {}

  // === SCC advanced dropdowns (must use styled dropdowns like the rest of the app) ===
  const sccTimeSourceOpts = getSccTimeSourceOptions();
  const savedSccTimeSource = (localStorage.getItem('scc-time-source') || 'auto');
  safeSetupDropdown('fmt-scc-time-source', sccTimeSourceOpts, savedSccTimeSource);

  const sccStartResetAtOpts = getSccStartResetAtOptions();
  // Default ON for broadcast friendliness: prefer Start TC if provided, otherwise 00:00:00.
  let savedSccStartResetAt = (localStorage.getItem('scc-start-reset-at') || '').trim();
  if (!savedSccStartResetAt) {
    savedSccStartResetAt = 'auto';
    try { localStorage.setItem('scc-start-reset-at', savedSccStartResetAt); } catch {}
  }
  safeSetupDropdown('fmt-scc-start-reset-at', sccStartResetAtOpts, savedSccStartResetAt);

  const sccStartResetOpOpts = getSccStartResetOpOptions();
  const savedSccStartResetOp = (localStorage.getItem('scc-start-reset-op') || 'edm');
  safeSetupDropdown('fmt-scc-start-reset-op', sccStartResetOpOpts, savedSccStartResetOp);

  // === SCC export policy (styled dropdown) ===
  const sccExportPolicyOpts = getSccExportPolicyOptions();
  // Ensure QC & Delivery prefs are migrated (legacy SCC keys → canonical export policy).
  try { window.qcDeliveryPrefs?.migrateLegacyPrefs?.(localStorage); } catch {}
  let savedSccExportPolicy = (localStorage.getItem('scc-export-policy') || 'warn').trim() || 'warn';
  // UI no longer exposes a third "strict" selection; collapse legacy strict mode into Delivery.
  try {
    const api = window.qcDeliveryPrefs;
    if (api && typeof api.normalizeExportPolicy === 'function') {
      savedSccExportPolicy = api.normalizeExportPolicy(savedSccExportPolicy, 'warn') || 'warn';
    }
  } catch {}
  if (savedSccExportPolicy === 'gate_block') savedSccExportPolicy = 'gate_write';
  try { localStorage.setItem('scc-export-policy', savedSccExportPolicy); } catch {}
  safeSetupDropdown('fmt-scc-export-policy', sccExportPolicyOpts, savedSccExportPolicy);

  // === SCC Auto-shape mode (styled dropdown) ===
  // Single control: dropdown includes an explicit Off state (replaces the old checkbox).
  const sccShapeModeOpts = getSccShapeModeOptions();

  // Derive UI default from persisted legacy keys:
  //   - scc-shape-enable controls whether shaping is on
  //   - scc-shape-mode stores the last non-off mode
  let savedShapeMode = 'conservative';
  let shapeEnabled = false;
  try { savedShapeMode = (localStorage.getItem('scc-shape-mode') || 'conservative').trim() || 'conservative'; } catch {}
  try { shapeEnabled = (localStorage.getItem('scc-shape-enable') === 'true'); } catch {}
  const shapeDefault = shapeEnabled ? savedShapeMode : 'off';

  safeSetupDropdown('fmt-scc-shape-mode', sccShapeModeOpts, shapeDefault);

  // Persist: the dropdown drives BOTH keys so older code paths keep working.
  document.getElementById('fmt-scc-shape-mode')?.addEventListener('change', (e) => {
    const v = String(e.target.value || 'off').trim();
    try {
      if (v === 'off') {
        localStorage.setItem('scc-shape-enable', 'false');
        // Intentionally do not overwrite scc-shape-mode; keep the last real mode.
      } else {
        localStorage.setItem('scc-shape-enable', 'true');
        localStorage.setItem('scc-shape-mode', v);
      }
    } catch {} 
   });

  // (Removed: legacy SCC control hider – those nodes no longer exist in the DOM)

  updateSccUiRows();

  // Keep the UI honest about what settings actually do for the selected engine.
  // (e.g. WhisperX uses Accuracy mode; Lead AI needs multilingual models for non-English.)
  try { applyTranscribeEngineAvailability(); } catch {}
}

function refreshSccInjectedI18nLabels() {
  try {
    const tcInput = document.getElementById('fmt-scc-tc-start');
    if (tcInput) {
      const tcRow = document.getElementById('scc-tc-start-row') || tcInput.closest('.form-item');
      const tcLabel = tcRow?.querySelector('label[for="fmt-scc-tc-start"]');
      if (tcLabel) tcLabel.textContent = tr('transcribe.sccStartTcLabel');
      tcInput.placeholder = tr('transcribe.sccStartTcPlaceholder');
    }

    const offsetInput = document.getElementById('fmt-scc-timecode-offset');
    if (offsetInput) {
      const offsetRow = document.getElementById('scc-timecode-offset-row') || offsetInput.closest('.form-item');
      const offsetLabel = offsetRow?.querySelector('label[for="fmt-scc-timecode-offset"]');
      if (offsetLabel) offsetLabel.textContent = tr('transcribe.sccOffsetLabel');
      offsetInput.placeholder = tr('transcribe.sccOffsetPlaceholder');
    }
  } catch {}
}

function refreshTranscribeDropdownLabels() {
  // Rebuild option lists while preserving current values.
  try {
    const curEngine = document.getElementById('transcribe-engine')?.value
      || localStorage.getItem('preferred-ai-model')
      || TRANSCRIBE_DEFAULTS.engine;
    safeSetupDropdown('transcribe-engine', [
      { value: 'whisperx', label: tr('transcribeEngineWhisperx', 'WhisperX') },
      { value: 'whisper',  label: tr('transcribeEngineWhisperapi', 'WhisperAPI') },
      { value: 'lead',     label: tr('transcribeEngineLeadAi', 'Lead AI') }
    ], curEngine);

    const langOpts = getLanguageOptions();
    safeSetupDropdown('transcribe-language', langOpts, document.getElementById('transcribe-language')?.value || 'en');
    safeSetupDropdown('translate-target',    langOpts, document.getElementById('translate-target')?.value || 'en');

    const accOpts = getAccuracyOptions();
    safeSetupDropdown('transcribe-accuracy-mode', accOpts, document.getElementById('transcribe-accuracy-mode')?.value || 'auto');

    safeSetupDropdown('transcribe-timecode-style', getTimecodeFormatOptions(), document.getElementById('transcribe-timecode-style')?.value || 'ndf');
    safeSetupDropdown('fmt-txt-timecode-format',   getTimecodeFormatOptions(), document.getElementById('fmt-txt-timecode-format')?.value || 'df');
    safeSetupDropdown('fmt-script-timecode-format', getTimecodeFormatOptions(), document.getElementById('fmt-script-timecode-format')?.value || 'ndf');

    safeSetupDropdown('fmt-txt-timestamp-placement',    getTimestampPlacementOptions(), document.getElementById('fmt-txt-timestamp-placement')?.value || 'none');
    safeSetupDropdown('fmt-script-timestamp-placement', getTimestampPlacementOptions(), document.getElementById('fmt-script-timestamp-placement')?.value || 'none');

    safeSetupDropdown('fmt-srt-line-ending', getLineEndingOptions(), document.getElementById('fmt-srt-line-ending')?.value || 'lf');

    safeSetupDropdown('transcribe-output-formats', getTranscribeOutputFormatOptions(), document.getElementById('transcribe-output-formats')?.value || 'txt');
    safeSetupDropdown('scc-alignment', getTextAlignmentOptions(), document.getElementById('scc-alignment')?.value || 'center');
    safeSetupDropdown('scc-channel',   getSccChannelOptions(),    document.getElementById('scc-channel')?.value || '1');
    safeSetupDropdown('fmt-scc-time-source', getSccTimeSourceOptions(), document.getElementById('fmt-scc-time-source')?.value || 'auto');
    safeSetupDropdown('fmt-scc-start-reset-at', getSccStartResetAtOptions(), document.getElementById('fmt-scc-start-reset-at')?.value || 'auto');
    safeSetupDropdown('fmt-scc-start-reset-op', getSccStartResetOpOptions(), document.getElementById('fmt-scc-start-reset-op')?.value || 'edm');
    safeSetupDropdown('fmt-scc-export-policy', getSccExportPolicyOptions(), document.getElementById('fmt-scc-export-policy')?.value || 'warn');
    safeSetupDropdown('fmt-scc-shape-mode', getSccShapeModeOptions(), document.getElementById('fmt-scc-shape-mode')?.value || 'off');
    safeSetupDropdown('fmt-mcc-overflow-policy', getMccOverflowPolicyOptions(), document.getElementById('fmt-mcc-overflow-policy')?.value || 'error');
    safeSetupDropdown('fmt-mcc-alignment', [
      { value: 'left', label: tr('transcribeMccAlignLeft', 'Left') },
      { value: 'center', label: tr('transcribeMccAlignCenter', 'Center') },
      { value: 'right', label: tr('transcribeMccAlignRight', 'Right') }
    ], document.getElementById('fmt-mcc-alignment')?.value || 'center');
    safeSetupDropdown('fmt-mcc-export-policy', [
      { value: 'warn', label: tr('transcribe.mcc.exportPolicy.warn') },
      { value: 'gate_write', label: tr('transcribe.mcc.exportPolicy.gateWrite') }
    ], document.getElementById('fmt-mcc-export-policy')?.value || 'warn');
    safeSetupDropdown('fmt-mcc-timecode-offset-policy', getMccNegativeTimePolicyOptions(), document.getElementById('fmt-mcc-timecode-offset-policy')?.value || 'clamp');
    safeSetupDropdown('fmt-mcc-shape-mode', getMccShapeModeOptions(), document.getElementById('fmt-mcc-shape-mode')?.value || 'off');
    // Keep format-dependent locks/visibility accurate after rebuilding.
    try { updateDisabledOutputFormats(); } catch {}
    try { applyCurrentFormatScope(); } catch {}
    try { window.translatePage?.(); } catch {}
  } catch {}
}

bindTranscribeI18nListenerWithRetry({
  guardKey: '__LEADAE_TRANSCRIBE_I18N_BOUND__',
  callback: () => {
    try { refreshActiveTranscribeStatusLabel(); } catch {}
    try { refreshTranscribeDropdownLabels(); } catch {}
    refreshPresetDropdown().catch(() => {});
    try { window.__refreshSccPlacementUiI18n?.(); } catch {}
    try { window.__refreshMccPlacementUiI18n?.(); } catch {}
    try { refreshSccInjectedI18nLabels(); } catch {}
    try { window.__applyMccCdpTimecodeFpsConstraint?.(); } catch {}
    try { reapplyTranscribeFileInfoHeaders(); } catch {}
    try { reapplyTranscribeFileInfoRows(); } catch {}
    try { refreshTranscribeResizeHandleTooltips(); } catch {}
    try { applyTranscribeEngineAvailability(); } catch {}
    try { window.__refreshTranscribeWatchUiI18n?.(); } catch {}
    try {
      const startupWhisperFeatureState = getStartupWhisperFeatureState();
      const startupBootstrapUiActive = startupWhisperBootstrapSummaryActive
        || !!startupWhisperFeatureState?.pending
        || (!!startupWhisperFeatureState?.error && !startupWhisperFeatureState?.ready);
      if (startupBootstrapUiActive) {
        syncStartupWhisperBootstrapGate(startupWhisperFeatureState);
      }
    } catch {}
  }
});

// ─── Transcribe: engine/option availability (UI honesty layer) ──────────────
function _setTranscribeFieldHint(id, text, isWarning = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const msg = String(text || '').trim();
  el.textContent = msg;
  el.classList.toggle('warning', !!msg && !!isWarning);
  // Hide empty hints so the grid stays tight.
  el.style.display = msg ? 'block' : 'none';
}

function _lockStyledDropdown(hiddenInputId, locked) {
  const hidden = document.getElementById(hiddenInputId);
  const wrap = hidden?.closest?.('.dropdown-wrapper');
  if (wrap) wrap.classList.toggle('locked', !!locked);
}

function setDd(hiddenInputId, value, defVal = '') {
  const v = (value == null || value === '') ? defVal : value;
  try {
    if (typeof setDropdownValue === 'function') {
      setDropdownValue(hiddenInputId, String(v ?? ''));
    }
  } catch {
    // ignore: renderer may not have styled dropdown helpers in all contexts
  }
  const el = document.getElementById(hiddenInputId);
  if (el) el.value = String(v ?? '');
  return v;
}

function _setStyledDropdownValue(hiddenInputId, value, defVal) {
  // Prefer shared helper if present so the chosen-value display updates correctly.
  try {
    if (typeof setDd === 'function') return setDd(hiddenInputId, value, defVal);
  } catch {}
  try {
    if (typeof setDropdownValue === 'function') return setDropdownValue(hiddenInputId, String(value ?? defVal ?? ''));
  } catch {}
  const hidden = document.getElementById(hiddenInputId);
  if (hidden) hidden.value = String(value ?? defVal ?? '');
}

// TXT (.txt): Timestamp Placement is now the sole source of truth for whether
// timecodes are included. When placement is 'none', timecode-related controls
// must be non-interactive.
function applyTxtTimestampPlacementLocks() {
  try {
    const placementEl = document.getElementById('fmt-txt-timestamp-placement');
    const raw = String(placementEl?.value || 'none').trim();
    const includeTimecodes = raw !== 'none' && raw !== '';

    // 1) Lock/unlock Timecode Format (styled dropdown)
    try { _lockStyledDropdown('fmt-txt-timecode-format', !includeTimecodes); } catch {}
    const tcHidden = document.getElementById('fmt-txt-timecode-format');
    const tcItem = tcHidden?.closest?.('.form-item');
    if (tcItem) tcItem.classList.toggle('locked', !includeTimecodes);

    // 2) Disable/enable FPS override
    const fpsEl = document.getElementById('fmt-txt-fps');
    if (fpsEl) {
      fpsEl.disabled = !includeTimecodes;
      fpsEl.closest?.('.form-item')?.classList.toggle('locked', !includeTimecodes);
    }

    // 3) Disable/enable Start Timecode Offset
    const startEl = document.getElementById('fmt-txt-tc-start');
    if (startEl) {
      startEl.disabled = !includeTimecodes;
      startEl.closest?.('.form-item')?.classList.toggle('locked', !includeTimecodes);
    }

    // 4) Keep the legacy global toggle in sync (internal-only control)
    // This preserves older code paths (and SCC prereq logic) without reintroducing
    // a user-facing checkbox.
    const legacy = document.getElementById('out-timecodes');
    if (legacy && typeof legacy.checked === 'boolean') {
      legacy.checked = includeTimecodes;
    }
  } catch (e) {
    console.warn('applyTxtTimestampPlacementLocks failed:', e);
  }
}

// Scripted (CSV): Timestamp Placement is the source of truth for whether
// timecodes are included. When placement is 'none', timecode-related controls
// must be non-interactive (mirrors Plain Text behavior).
function applyScriptTimestampPlacementLocks() {
  try {
    const placementEl = document.getElementById('fmt-script-timestamp-placement');
    const raw = String(placementEl?.value || 'none').trim();
    const includeTimecodes = raw !== 'none' && raw !== '';

    // 1) Lock/unlock Timecode Format (styled dropdown)
    try { _lockStyledDropdown('fmt-script-timecode-format', !includeTimecodes); } catch {}
    const tcHidden = document.getElementById('fmt-script-timecode-format');
    const tcItem = tcHidden?.closest?.('.form-item');
    if (tcItem) tcItem.classList.toggle('locked', !includeTimecodes);

    // 2) Disable/enable FPS override
    const fpsEl = document.getElementById('fmt-script-fps');
    if (fpsEl) {
      fpsEl.disabled = !includeTimecodes;
      fpsEl.closest?.('.form-item')?.classList.toggle('locked', !includeTimecodes);
    }

    // 3) Disable/enable Start Timecode Offset
    const startEl = document.getElementById('fmt-script-tc-start');
    if (startEl) {
      startEl.disabled = !includeTimecodes;
      startEl.closest?.('.form-item')?.classList.toggle('locked', !includeTimecodes);
    }
  } catch (e) {
    console.warn('applyScriptTimestampPlacementLocks failed:', e);
  }
}

async function _whisperCppModelExists(modelFile) {
  try {
    if (!window?.electron?.fileExistsAsync || !window?.electron?.joinPath) return false;
    // Dev-only probe: packaged builds install models through runtime assets under userData/assets.
    const whisperRoot = window.electron.pathResolve('whisper.cpp');
    const modelPath = window.electron.joinPath(whisperRoot, 'models', modelFile);
    return await window.electron.fileExistsAsync(modelPath);
  } catch {}
  return false;
}

function applyTranscribeEngineAvailability() {
  try {
    const engine = String(document.getElementById('transcribe-engine')?.value || TRANSCRIBE_DEFAULTS.engine).trim();
    const language = String(document.getElementById('transcribe-language')?.value || 'en').trim().toLowerCase();
    const isWhisperApi = engine === 'whisper';
    const isWhisperX = engine === 'whisperx';

    const accLocked = !isWhisperX;
    if (accLocked) {
      _setStyledDropdownValue('transcribe-accuracy-mode', 'auto', 'auto');
    }
    _lockStyledDropdown('transcribe-accuracy-mode', accLocked);
    _setTranscribeFieldHint(
      'transcribe-accuracy-hint',
      accLocked ? tr('transcribeAccuracyWhisperXOnlyHint', 'Accuracy applies to WhisperX only.') : '',
      false
    );

    _setTranscribeFieldHint(
      'transcribe-language-hint',
      (engine === 'lead' && language !== 'en')
        ? tr('transcribeLeadAiMultilingualHint', 'Lead AI requires a multilingual whisper.cpp model for non-English languages.')
        : '',
      false
    );

    const translateTargetId = 'translate-target';
    const translateTargetEl = document.getElementById(translateTargetId);
    const translateEnableEl = document.getElementById('translate-enable');

    const hintParts = [];

    if (!isWhisperApi) {
      _setStyledDropdownValue(translateTargetId, 'en', 'en');
      if (translateTargetEl) {
        translateTargetEl.value = 'en';
        translateTargetEl.disabled = true;
      }
      _lockStyledDropdown(translateTargetId, true);
      hintParts.push(
        tr(
          'transcribeTranslateWhisperOnlyHint',
          'WhisperAPI is required to translate to non-English targets. This engine is locked to English.'
        )
      );
    } else {
      if (translateTargetEl) translateTargetEl.disabled = false;
      _lockStyledDropdown(translateTargetId, false);
    }

    const translateOn = translateEnableEl?.checked === true;
    const hint = translateOn ? hintParts.join(' ') : hintParts.filter(Boolean).slice(0, 1).join(' ');
    _setTranscribeFieldHint('transcribe-translate-hint', hint, !isWhisperApi);

    _setTranscribeFieldHint('transcribe-engine-hint', '', false);
  } catch {}
}


// Run now if the DOM is already parsed (common when scripts are loaded on tab click)
if (document.readyState !== 'loading') {
  initTranscribeDropdowns();
} else {
  document.addEventListener('DOMContentLoaded', initTranscribeDropdowns, { once: true });
}

  // Panel outputs:
  // - summary: job preview (settings snapshot)
  // - log: append-only transcribe output shown under Summary
  const logTarget = document.getElementById('transcribe-log-output');
  const summaryTarget = document.getElementById('transcribe-job-preview-box');

  const el = {
    selectFiles: document.getElementById('transcribe-select-files'),
    files: document.getElementById('transcribe-files'),
    // Watch Mode: standard single-line path display (matches Ingest panel style)
    watchFolderPath: document.getElementById('transcribe-watch-folder-path'),
    outputSelect: document.getElementById('transcribe-output-select'),
    outputPath: document.getElementById('transcribe-output-path'),
    startBtn: document.getElementById('start-transcribe'),
    resetBtn: document.getElementById('reset-transcribe'),
    log: logTarget,
    summary: summaryTarget,
    saveConfig: document.getElementById('transcribe-save-config'),
    loadConfig: document.getElementById('transcribe-load-config'),

    enableN8N: document.getElementById('transcribe-enable-n8n'),
    n8nUrl: document.getElementById('transcribe-n8n-url'),
    n8nAllowPrivate: document.getElementById('transcribe-n8n-allow-private'),
    n8nLog: document.getElementById('transcribe-n8n-log'),
    watchMode: document.getElementById('transcribe-watch-mode'),
    cancelBtn: document.getElementById('cancel-transcribe'),
    presetSelect: document.getElementById('transcribe-preset'),
    notes: document.getElementById('transcribe-notes'),
    loaderInline: document.getElementById('transcribe-loader-inline'),
    jobStatus: document.getElementById('transcribe-job-status'),
    statusText: document.getElementById('transcribe-status-text')
  };

  autoResize(el.files);

  let activeTranscribeAssetController = null;
  let transcribeAssetSummaryRestoreText = '';
  let startupWhisperBootstrapSummaryRestoreText = '';
  let startupWhisperBootstrapSummaryActive = false;
  let transcribeControlsLocked = false;

  async function confirmTranscribeAction(options) {
    try {
      if (typeof window.rendererDialogs?.confirmAction === 'function') {
        return !!(await window.rendererDialogs.confirmAction(options));
      }
      if (typeof ipc?.showConfirmDialog === 'function') {
        return !!(await ipc.showConfirmDialog(options));
      }
      if (typeof ipc?.showConfirm === 'function') {
        return !!(await ipc.showConfirm(options));
      }
      if (typeof ipc?.invoke === 'function') {
        return !!(await ipc.invoke('show-confirm-dialog', options));
      }
      console.warn('Transcribe confirm dialog bridge unavailable.');
    } catch (err) {
      console.warn('Transcribe confirm dialog failed:', err?.message || err);
    }
    return false;
  }

  function ensureTranscribeToast() {
    let toastEl = document.getElementById('transcribe-toast');
    if (toastEl) return toastEl;
    if (!document.body) return null;
    toastEl = document.createElement('div');
    toastEl.id = 'transcribe-toast';
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
    return toastEl;
  }

  function hideTranscribeToast() {
    const toastEl = document.getElementById('transcribe-toast');
    if (showTranscribeToast._timer) {
      clearTimeout(showTranscribeToast._timer);
      showTranscribeToast._timer = null;
    }
    if (!toastEl) return;
    toastEl.classList.remove('show');
    toastEl.classList.remove('toast-error');
    toastEl.removeAttribute('title');
  }

  function showTranscribeToast(message, options = {}) {
    const toastEl = ensureTranscribeToast();
    const rawMsg = String(message ?? '').trim();
    if (!toastEl || !rawMsg) return;

    const compactMsg = rawMsg.replace(/\s+/g, ' ').trim();
    const persistent = !!options.persistent;
    const isError = !!options.isError;
    toastEl.textContent = compactMsg.length > 280 ? `${compactMsg.slice(0, 279)}…` : compactMsg;
    toastEl.title = rawMsg;
    toastEl.classList.toggle('toast-error', isError);
    toastEl.classList.add('show');
    toastEl.setAttribute('role', (persistent || isError) ? 'alert' : 'status');
    toastEl.setAttribute('aria-live', (persistent || isError) ? 'assertive' : 'polite');

    if (showTranscribeToast._timer) {
      clearTimeout(showTranscribeToast._timer);
      showTranscribeToast._timer = null;
    }

    if (!persistent) {
      showTranscribeToast._timer = setTimeout(() => {
        toastEl.classList.remove('show');
        showTranscribeToast._timer = null;
      }, 2000);
    }
  }

  function focusTranscribeElement(target, { selectText = false } = {}) {
    if (!target || typeof target.focus !== 'function') return;
    try { target.focus(); } catch {}
    if (selectText && typeof target.select === 'function') {
      try { target.select(); } catch {}
    }
  }

  function getTranscribeAssetLanguageLabel(language) {
    const normalized = String(language || 'en').trim().toLowerCase() || 'en';
    try {
      const match = getLanguageOptions().find(option => String(option?.value || '').trim().toLowerCase() === normalized);
      if (match?.label) return String(match.label);
    } catch {}
    return normalized;
  }

  function setTranscribeSummaryText(text) {
    if (!el.summary) return;
    writeLogElText(el.summary, text == null ? '' : String(text));
    if (el.summary.tagName === 'TEXTAREA') autoResize(el.summary);
  }

  function rememberTranscribeSummaryBeforeAssetUpdate() {
    transcribeAssetSummaryRestoreText = startupWhisperBootstrapSummaryActive
      ? String(startupWhisperBootstrapSummaryRestoreText || '')
      : readLogElText(el.summary);
  }

  function restoreTranscribeSummaryAfterAssetUpdate() {
    const previous = String(transcribeAssetSummaryRestoreText || '');
    transcribeAssetSummaryRestoreText = '';
    if (previous) {
      setTranscribeSummaryText(previous);
      return;
    }
    scheduleTranscribeJobPreviewUpdate();
  }

  function rememberTranscribeSummaryBeforeStartupBootstrap() {
    if (startupWhisperBootstrapSummaryActive) return;
    startupWhisperBootstrapSummaryRestoreText = readLogElText(el.summary);
  }

  function restoreTranscribeSummaryAfterStartupBootstrap() {
    if (!startupWhisperBootstrapSummaryActive) return;
    const previous = String(startupWhisperBootstrapSummaryRestoreText || '');
    startupWhisperBootstrapSummaryRestoreText = '';
    startupWhisperBootstrapSummaryActive = false;
    if (previous) {
      setTranscribeSummaryText(previous);
      return;
    }
    scheduleTranscribeJobPreviewUpdate();
  }

  function getStartupWhisperFeatureState() {
    if (!startupRuntimeAssetBootstrap || typeof startupRuntimeAssetBootstrap.getFeatureState !== 'function') return null;
    return startupRuntimeAssetBootstrap.getFeatureState('whisper');
  }

  function isLeadTranscribeEngineSelected() {
    const engine = String(document.getElementById('transcribe-engine')?.value || '').trim().toLowerCase();
    return engine === 'lead';
  }

  function isStartupWhisperBootstrapBlocking(featureState = getStartupWhisperFeatureState()) {
    return !!featureState?.pending && isLeadTranscribeEngineSelected();
  }

  function syncTranscribeStartButtonForBootstrap(featureState = getStartupWhisperFeatureState()) {
    const startupBlocked = isStartupWhisperBootstrapBlocking(featureState);
    if (el.startBtn) {
      el.startBtn.disabled = transcribeControlsLocked || startupBlocked;
      el.startBtn.classList.toggle('is-busy', startupBlocked);
      el.startBtn.setAttribute('aria-busy', startupBlocked ? 'true' : 'false');
    }
  }

  function renderStartupWhisperBootstrapSummary(featureState = getStartupWhisperFeatureState()) {
    const snapshot = featureState?.currentSnapshot || featureState?.lastSnapshot || null;
    rememberTranscribeSummaryBeforeStartupBootstrap();
    startupWhisperBootstrapSummaryActive = true;

    if (!snapshot) {
      if (!featureState?.pending) return false;
      setTranscribeSummaryText(
        tr('transcribeStartupPreparingLeadModels', 'Preparing local Lead AI transcription models…')
      );
      return true;
    }

    const languageLabel = featureState?.languageLabel
      || (featureState?.language === 'multi'
        ? tr('runtimeAssetLanguageMulti', 'All non-English languages')
        : getTranscribeAssetLanguageLabel(featureState?.language || snapshot?.language));
    const summary = createRuntimeAssetSummary(snapshot, {
      kind: 'whisper',
      languageLabel,
      progressOverride: featureState?.lastProgressRatio
    });
    if (summary) setTranscribeSummaryText(summary);
    return !!summary;
  }

  function syncStartupWhisperBootstrapGate(featureState = getStartupWhisperFeatureState()) {
    if (!startupRuntimeAssetBootstrap) return;
    const pending = !!featureState?.pending;
    const ready = !!featureState?.ready;
    const failed = !!featureState?.error && !ready;

    syncTranscribeStartButtonForBootstrap(featureState);

    if (pending || failed) {
      renderStartupWhisperBootstrapSummary(featureState);
      return;
    }

    restoreTranscribeSummaryAfterStartupBootstrap();
  }

  function renderTranscribeAssetSummary(snapshot, controller = activeTranscribeAssetController, options = {}) {
    const summary = createRuntimeAssetSummary(snapshot, {
      kind: 'whisper',
      languageLabel: options.languageLabel || getTranscribeAssetLanguageLabel(options.language || snapshot?.language),
      progressOverride: controller?.lastProgressRatio
    });
    if (summary) setTranscribeSummaryText(summary);
  }

  function shouldPrefetchWhisperAsset(config = {}) {
    const engine = String(config?.engine || '').trim().toLowerCase();
    return !!window.electron?.isPackaged
      && engine === 'lead'
      && !!assetUi
      && typeof assetUi.startRuntimeAssetPrefetch === 'function'
      && !!window.electron?.assets
      && typeof window.electron.assets.prefetch === 'function';
  }

  async function ensureWhisperAssetReadyForConfig(config = {}) {
    if (!shouldPrefetchWhisperAsset(config)) return null;
    if (activeTranscribeAssetController && !activeTranscribeAssetController.settled) {
      return activeTranscribeAssetController.promise;
    }

    const language = String(config?.language || 'en').trim().toLowerCase() || 'en';
    const languageLabel = getTranscribeAssetLanguageLabel(language);
    rememberTranscribeSummaryBeforeAssetUpdate();

    const controller = await assetUi.startRuntimeAssetPrefetch(
      window.electron.assets,
      { feature: 'whisper', language },
      {
        kind: 'whisper',
        languageLabel,
        translate: (key, fallback) => tr(key, fallback),
        translateTemplate: (key, fallback, replacements) => trTemplate(key, fallback, replacements),
        onSnapshot: (snapshot, currentController) => {
          renderTranscribeAssetSummary(snapshot, currentController, { language, languageLabel });
        }
      }
    );

    if (controller.immediate) {
      transcribeAssetSummaryRestoreText = '';
      return controller.snapshot;
    }

    activeTranscribeAssetController = controller;
    try {
      return await controller.promise;
    } finally {
      if (activeTranscribeAssetController === controller) {
        activeTranscribeAssetController = null;
      }
    }
  }

  async function cancelActiveTranscribeAssetRequest() {
    if (!activeTranscribeAssetController || activeTranscribeAssetController.settled) return false;
    const controller = activeTranscribeAssetController;
    try {
      await controller.cancel();
    } catch (error) {
      if (!isRuntimeAssetCancelError(error)) throw error;
    }
    return true;
  }

  function handleTranscribeAssetPrefetchFailure(error, config = {}) {
    const language = String(config?.language || 'en').trim().toLowerCase() || 'en';
    const languageLabel = getTranscribeAssetLanguageLabel(language);

    if (isRuntimeAssetCancelError(error)) {
      restoreTranscribeSummaryAfterAssetUpdate();
      const message = tr('transcribeModelDownloadCancelled', 'Transcription model download cancelled.');
      const line = `🛑 ${message}`;
      logTranscribe(line);
      if (el.log) appendLogLine(el.log, line);
      showTranscribeToast(message);
      return { cancelled: true, message };
    }

    const normalizedError = createRuntimeAssetError(
      error?.snapshot || {
        feature: 'whisper',
        state: 'error',
        error: {
          code: error?.code,
          message: error?.message || String(error)
        }
      },
      {
        kind: 'whisper',
        languageLabel
      }
    );

    const summary = createRuntimeAssetSummary(normalizedError.snapshot || normalizedError, {
      kind: 'whisper',
      languageLabel
    });
    if (summary) setTranscribeSummaryText(summary);

    const message = normalizedError.message;
    const line = `❌ ${message}`;
    logTranscribe(line, { isError: true });
    if (el.log) appendLogLine(el.log, line);
    showTranscribeToast(message, { persistent: true, isError: true });
    return { cancelled: false, message };
  }

  const transcribeLockWrapper = document.getElementById('transcribe-lock-wrapper');

  function _attachSubtitlePopoutButton() {
    const openEditorBtn = document.getElementById('open-subtitle-editor');
    if (!openEditorBtn || openEditorBtn.dataset.subtitlePopoutAttached === '1') return;
    openEditorBtn.dataset.subtitlePopoutAttached = '1';

    // Make the pop-out open instantly; user can choose files inside the editor
    openEditorBtn.addEventListener('click', async () => {
      try {
        await window.subtitleEditor?.open({});
      } catch (e) {
        panelLog('error', 'Pop-out failed:', { error: e?.message || e });
      }
    });
  }

  const openEditorBtn = document.getElementById('open-subtitle-editor');
  if (openEditorBtn) _attachSubtitlePopoutButton();

  const engineInput = document.getElementById('transcribe-engine');
  const languageInput = document.getElementById('transcribe-language');
  const accuracyInput = document.getElementById('transcribe-accuracy-mode');
  const translateTargetInput = document.getElementById('translate-target');
  const translateEnableInput = document.getElementById('translate-enable');

  engineInput?.addEventListener('change', e => {
    localStorage.setItem('preferred-ai-model', e.target.value);
    updateDisabledOutputFormats();
    try { applyTranscribeEngineAvailability(); } catch {}
  });

  languageInput?.addEventListener('change', e => {
    localStorage.setItem('preferred-transcribe-language', e.target.value);
    try { applyTranscribeEngineAvailability(); } catch {}
  });

  accuracyInput?.addEventListener('change', e => {
    localStorage.setItem('preferred-accuracy-mode', e.target.value);
    try { applyTranscribeEngineAvailability(); } catch {}
  });

    translateTargetInput?.addEventListener('change', e => {
      localStorage.setItem('preferred-translate-target', e.target.value);
    });

  translateEnableInput?.addEventListener('change', e => {
    try { localStorage.setItem('preferred-translate-enabled', e.target.checked ? '1' : '0'); } catch {}
    try { applyTranscribeEngineAvailability(); } catch {}
  });

    // ------------------------------------------------------------
    // SCC: format-scoped Start Timecode (offset) control
    // ------------------------------------------------------------
    function _getActiveTimecodeStyle() {
      return (
        document.getElementById('fmt-txt-timecode-format')?.value ||
        document.getElementById('transcribe-timecode-style')?.value ||
        'ndf'
      );
    }

    function _normalizeSmpteLabelForStyle(label, style) {
      const raw = String(label || '').trim();
      if (!raw) return '';
      const m = raw.match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
      if (!m) return raw;
      const sep = (String(style || '').toLowerCase() === 'df') ? ';' : ':';
      return `${m[1]}${sep}${m[2]}`;
    }

    function ensureSccTcStartRow() {
      // Inject a Start TC input into the SCC mini-panel if it doesn't exist yet.
      // If it already exists, refresh i18n-visible label text and placeholder.
      const existingInput = document.getElementById('fmt-scc-tc-start');
      if (existingInput) {
        const existingRow = document.getElementById('scc-tc-start-row') || existingInput.closest('.form-item');
        const existingLabel = existingRow?.querySelector('label[for="fmt-scc-tc-start"]');
        if (existingLabel) existingLabel.textContent = tr('transcribe.sccStartTcLabel');
        existingInput.placeholder = tr('transcribe.sccStartTcPlaceholder');
        return;
      }

      const wrap = document.getElementById('scc-starttc-slot');

      if (!wrap) return;

      const row = document.createElement('div');
      row.id = 'scc-tc-start-row';
      row.className = 'form-item';


      const label = document.createElement('label');
      label.htmlFor = 'fmt-scc-tc-start';
      label.textContent = tr('transcribe.sccStartTcLabel');

      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'fmt-scc-tc-start';
      input.placeholder = tr('transcribe.sccStartTcPlaceholder');
      input.autocomplete = 'off';
      input.spellcheck = false;

      row.appendChild(label);
      row.appendChild(input);

      // Insert above alignment row if possible, else append.
      const alignRow = document.getElementById('scc-align-row');
      if (alignRow && alignRow.parentElement === wrap) {
        wrap.insertBefore(row, alignRow);
      } else {
        wrap.appendChild(row);
      }

      // Restore saved value, else fall back to the global Start TC, else a sane default.
      let restored = '';
      try { restored = localStorage.getItem('scc-tc-start') || ''; } catch {}
      if (!restored) {
        restored =
          document.getElementById('transcribe-tc-start')?.value?.trim() ||
          document.getElementById('fmt-txt-tc-start')?.value?.trim() ||
          '';
      }
      if (!restored) {
        const style = _getActiveTimecodeStyle();
        restored = (style === 'df') ? '01:00:00;00' : '01:00:00:00';
      }
      input.value = _normalizeSmpteLabelForStyle(restored, _getActiveTimecodeStyle());

      const persist = () => {
        const style = _getActiveTimecodeStyle();
        const normalized = _normalizeSmpteLabelForStyle(input.value, style);
        input.value = normalized;
        try { localStorage.setItem('scc-tc-start', normalized); } catch {}
      };

      input.addEventListener('change', persist);
      input.addEventListener('blur', persist);

      // If the user flips DF/NDF style, normalize the delimiter in-place.
      const styleEl =
        document.getElementById('fmt-txt-timecode-format') ||
        document.getElementById('transcribe-timecode-style');
      styleEl?.addEventListener('change', persist);
    }


    function ensureSccTimecodeOffsetRow() {
      // Inject a Caption Slip/Offset input into the SCC mini-panel if it doesn't exist yet.
      // If it already exists, refresh i18n-visible label text and placeholder.
      const existingInput = document.getElementById('fmt-scc-timecode-offset');
      if (existingInput) {
        const existingRow = document.getElementById('scc-timecode-offset-row') || existingInput.closest('.form-item');
        const existingLabel = existingRow?.querySelector('label[for="fmt-scc-timecode-offset"]');
        if (existingLabel) existingLabel.textContent = tr('transcribe.sccOffsetLabel');
        existingInput.placeholder = tr('transcribe.sccOffsetPlaceholder');
        return;
      }

      const wrap = document.getElementById('scc-offset-slot');
      if (!wrap) return;

      const row = document.createElement('div');
      row.id = 'scc-timecode-offset-row';
      row.className = 'form-item';

      const label = document.createElement('label');
      label.htmlFor = 'fmt-scc-timecode-offset';
      label.textContent = tr('transcribe.sccOffsetLabel');

      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'fmt-scc-timecode-offset';
      input.placeholder = tr('transcribe.sccOffsetPlaceholder');
      input.autocomplete = 'off';
      input.spellcheck = false;

      row.appendChild(label);
      row.appendChild(input);
      wrap.appendChild(row);

      let restored = '';
      try { restored = localStorage.getItem('scc-timecode-offset') || ''; } catch {}
      input.value = String(restored || '').trim();

      const persist = () => {
        const v = String(input.value || '').trim();
        input.value = v;
        try {
          if (!v) localStorage.removeItem('scc-timecode-offset');
          else localStorage.setItem('scc-timecode-offset', v);
        } catch {}
      };

      input.addEventListener('change', persist);
      input.addEventListener('blur', persist);
    }


    function updateSccUiRows() {
      ensureSccTcStartRow();
      ensureSccTimecodeOffsetRow();

      const fmtSel = document.getElementById('transcribe-output-formats');
      const show = fmtSel?.value === 'scc';

      // SCC primary controls now live inside the SCC mini-panel (#fmt-scc).
      // The wrapper is #scc-primary-row (legacy builds used #scc-alignchan-wrap / #scc-channel-row).
      const wrap = document.getElementById('scc-primary-row');
      if (wrap) wrap.style.display = show ? 'grid' : 'none';
      // Keep inner items visible when wrapper is shown (defensive)
      const alignRow = document.getElementById('scc-align-row');
      const serviceRow = document.getElementById('scc-service-row');
      if (alignRow) alignRow.style.display = show ? 'flex' : 'none';
      if (serviceRow) serviceRow.style.display = show ? 'flex' : 'none';

      const tcRow = document.getElementById('scc-tc-start-row');
      if (tcRow) tcRow.style.display = show ? 'flex' : 'none';

      const offsetRow = document.getElementById('scc-timecode-offset-row');
      if (offsetRow) offsetRow.style.display = show ? 'flex' : 'none';
    }

    // Keep SCC prerequisites (timecodes enabled, 29.97 FPS, DF unless NDF is explicitly allowed)
    // in sync with the SCC panel. This function intentionally manipulates the *hidden* TXT/global
    // timecode controls so SCC exports don't end up in an impossible state.
    function syncSccPrereqsFromUi() {
      try {
        const fmtSel = document.getElementById('transcribe-output-formats');
        if (fmtSel?.value !== 'scc') return;

        // Timecodes are now controlled by TXT Timestamp Placement (and mirrored to the
        // legacy global toggle as an internal compatibility shim).
        const tpEl = document.getElementById('fmt-txt-timestamp-placement');
        const tcEl = document.getElementById('out-timecodes');
        const fpsEl = document.getElementById('fmt-txt-fps') || document.getElementById('transcribe-fps');
        const styleEl = document.getElementById('fmt-txt-timecode-format') || document.getElementById('transcribe-timecode-style');

        // Prefer the live checkbox state, but fall back to localStorage for safety.
        const allowNdfEl = document.getElementById('fmt-scc-allow-ndf');
        let allowNdf = false;
        if (allowNdfEl) allowNdf = allowNdfEl.checked === true;
        else {
          try { allowNdf = localStorage.getItem('scc-allow-ndf') === 'true'; } catch {}
        }

        // SCC requires timecodes.
        // Ensure TXT Timestamp Placement is not 'none' (since that implies no timecodes).
        if (tpEl) {
          const cur = String(tpEl.value || '').trim();
          if (!cur || cur === 'none') {
            try { if (typeof setDropdownValue === 'function') setDropdownValue(tpEl.id, 'start_end'); } catch {}
            tpEl.value = 'start_end';
            try { tpEl.dispatchEvent(new Event('change')); } catch {}
          }
        }
        // Keep legacy internal toggle consistent for older code paths.
        if (tcEl && !tcEl.checked) {
          tcEl.checked = true;
          try { tcEl.dispatchEvent(new Event('change')); } catch {}
        }

        // SCC defaults to DF. If the user already selected NDF *and* it's allowed, keep NDF.
        const currentStyle = String(styleEl?.value || 'df').trim().toLowerCase();
        const desiredStyle = (allowNdf && currentStyle === 'ndf') ? 'ndf' : 'df';
        if (styleEl && styleEl.value !== desiredStyle) {
          try { if (typeof setDropdownValue === 'function') setDropdownValue(styleEl.id, desiredStyle); } catch {}
          styleEl.value = desiredStyle;
          styleEl.dispatchEvent(new Event('change'));
        }

        // SCC is NTSC-based; keep the global FPS override pinned to 29.97 (for downstream formatting/UI guards).
        const fps = Number(fpsEl?.value);
        const isSccRate = Number.isFinite(fps) && Math.abs(fps - 29.97) < 0.05;
        if (fpsEl && (!Number.isFinite(fps) || !isSccRate)) {
          fpsEl.value = '29.97';
          fpsEl.dispatchEvent(new Event('input'));
        }
      } catch (e) {
        console.warn('syncSccPrereqsFromUi failed:', e);
      }
    }



  function initSccAdvancedUi() {
    // These were previously power-user localStorage keys; they now have UI controls
    // and we keep localStorage as the single source of truth for persistence.
    const bindNum = (id, key, defVal, min, max, opts = {}) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const raw = localStorage.getItem(key);
        if (raw != null && raw !== '') el.value = raw;
        else if (defVal != null && (el.value == null || String(el.value).trim() === '')) el.value = String(defVal);
      } catch {}

      const save = () => {
        const raw = (el.value == null) ? '' : String(el.value).trim();
        if (!raw) {
          try { localStorage.removeItem(key); } catch {}
          return;
        }
        let v = Number(raw);
        if (!Number.isFinite(v)) {
          try { localStorage.removeItem(key); } catch {}
          return;
        }
        if (opts.integer) v = Math.trunc(v);
        if (typeof min === 'number') v = Math.max(min, v);
        if (typeof max === 'number') v = Math.min(max, v);
        const out = String(v);
        el.value = out;
        try { localStorage.setItem(key, out); } catch {}
      };

      el.addEventListener('change', save);
    };

    const bindBool = (id, key, defVal, onChange) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const raw = localStorage.getItem(key);
        if (raw == null || raw === '') el.checked = !!defVal;
        else el.checked = (raw === 'true');
      } catch {
        el.checked = !!defVal;
      }

      const save = () => {
        try { localStorage.setItem(key, el.checked ? 'true' : 'false'); } catch {}
        if (typeof onChange === 'function') onChange(el.checked);
      };
      el.addEventListener('change', save);
    };

    const bindText = (id, key, defVal) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const raw = localStorage.getItem(key);
        if (raw != null) el.value = raw;
        else if (defVal != null && (el.value == null || String(el.value).trim() === '')) el.value = String(defVal);
      } catch {}
      const save = () => {
        try { localStorage.setItem(key, String(el.value || '')); } catch {}
      };
      el.addEventListener('change', save);
    };

    const bindSelect = (id, key, defVal) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const raw = localStorage.getItem(key);
        if (raw != null && raw !== '') el.value = raw;
        else if (defVal != null) el.value = defVal;
      } catch {
        if (defVal != null) el.value = defVal;
      }

      // Styled dropdowns use a hidden input; mirror the value into the visible field.
      try { if (typeof setDropdownValue === 'function') setDropdownValue(id, el.value); } catch {}

      const save = () => {
        try { localStorage.setItem(key, String(el.value || '')); } catch {}
      };
      el.addEventListener('change', save);
    };

    // SCC encoder options
    bindNum('fmt-scc-safe-left',  'scc-safe-left',  0, 0, 15, { integer: true });
    bindNum('fmt-scc-safe-right', 'scc-safe-right', 0, 0, 15, { integer: true });

    bindBool('fmt-scc-allow-ndf', 'scc-allow-ndf', false, () => {
      // This affects whether SCC is allowed when NDF is selected globally.
      // If SCC is currently selected, re-sync the hidden global timecode settings so we
      // don't end up in an impossible SCC state (e.g., ":" timecodes while allowNdf=false).
      syncSccPrereqsFromUi();
      updateDisabledOutputFormats();
      applyCurrentFormatScope();
    });
    bindBool('fmt-scc-repeat-control',  'scc-repeat-control',  true);
    bindBool('fmt-scc-repeat-preamble', 'scc-repeat-preamble', true);
    bindBool('fmt-scc-strip-leading-dashes', 'scc-strip-leading-dashes', false);
    bindBool('fmt-scc-pad-even', 'scc-pad-even', false);
    bindBool('fmt-scc-strict-encoding', 'scc-strict-encoding', false);
    bindNum('fmt-scc-prestart-roll', 'scc-prestart-roll', 0, 0, 30);

    bindSelect('fmt-scc-time-source', 'scc-time-source', 'auto');
    bindSelect('fmt-scc-start-reset-at', 'scc-start-reset-at', 'auto');
    bindSelect('fmt-scc-start-reset-op', 'scc-start-reset-op', 'edm');

    bindText('fmt-scc-prefix-words', 'scc-prefix-words', '');

    // Content QC thresholds (defaults match validateSccContentQc)
    bindNum('fmt-scc-qc-max-cps', 'scc-qc-max-cps', 20, 1, 60);
    bindNum('fmt-scc-qc-max-wpm', 'scc-qc-max-wpm', 180, 10, 400, { integer: true });
    bindNum('fmt-scc-qc-min-duration', 'scc-qc-min-duration', 0.8, 0, 10);
    bindNum('fmt-scc-qc-min-gap', 'scc-qc-min-gap', 0.1, 0, 10);
    bindNum('fmt-scc-qc-max-late-eoc', 'scc-qc-max-late-eoc', 0.1, 0, 2);
    bindNum('fmt-scc-qc-max-late-eoc-count', 'scc-qc-max-late-eoc-count', 0, 0, 999, { integer: true });

    // SCC export policy (single source of truth)
    // UI values: 'warn' (Draft) | 'gate_write' (Delivery)
    // Legacy/advanced configs may still supply 'gate_block'.
    bindSelect('fmt-scc-export-policy', 'scc-export-policy', 'warn');

    // When policy changes, keep legacy keys in sync + apply deliverable-safe defaults on gated modes.
    const polEl = document.getElementById('fmt-scc-export-policy');

    const applySccExportPolicySideEffects = (policyRaw) => {
      let policy = String(policyRaw || 'warn').trim();
      try {
        const api = window.qcDeliveryPrefs;
        if (api && typeof api.normalizeExportPolicy === 'function') {
          policy = api.normalizeExportPolicy(policy, 'warn') || 'warn';
        }
        if (api && typeof api.syncSccExportPolicy === 'function') {
          api.syncSccExportPolicy(localStorage, policy);
        } else {
          // Minimal fallback: keep the canonical key updated.
          try { localStorage.setItem('scc-export-policy', policy); } catch {}
        }
      } catch {}

      const gate = (policy === 'gate_write' || policy === 'gate_block');

      // ─────────────────────────────────────────────────────────────
      // Deliverable preset hygiene
      //
      // In gated modes we force strict encoding ON (so SCC export doesn't
      // silently emit illegal glyphs).
      // When returning to Draft (warn), we revert strict encoding only if it
      // was previously auto-forced by the gated preset.
      //
      // This avoids the common "why does Draft mode fail on emoji?" surprise
      // when a user briefly enabled Deliverable Mode.
      // ─────────────────────────────────────────────────────────────
      const STRICT_FORCED_KEY = 'scc-strict-encoding-forced';
      const wasStrictForced = (() => {
        try { return localStorage.getItem(STRICT_FORCED_KEY) === 'true'; } catch { return false; }
      })();

      // If the user manually toggles strict encoding, treat that as an explicit choice
      // and stop auto-restoring it on policy changes.
      try {
        const strictEl = document.getElementById('fmt-scc-strict-encoding');
        if (strictEl && strictEl.dataset.boundStrictForcedClear !== '1') {
          strictEl.dataset.boundStrictForcedClear = '1';
          strictEl.addEventListener('change', () => {
            try { localStorage.removeItem(STRICT_FORCED_KEY); } catch {}
          });
        }
      } catch {}

      // On any gated mode, force the deliverable-ish defaults:
      //  - strict encoding ON
      //  - redundancy ON (repeat control + preamble)
      //  - shaping ON (conservative) + startTC clamp fix
      if (gate) {
        // Only mark "forced" if we had to flip the setting.
        try {
          const cur = localStorage.getItem('scc-strict-encoding');
          const curOn = (cur === 'true');
          if (!curOn) {
            localStorage.setItem(STRICT_FORCED_KEY, 'true');
            localStorage.setItem('scc-strict-encoding', 'true');
          }
        } catch {
          // If localStorage is unavailable, still force the UI checkbox below.
        }
        try { localStorage.setItem('scc-repeat-control', 'true'); } catch {}
        try { localStorage.setItem('scc-repeat-preamble', 'true'); } catch {}
        try { localStorage.setItem('scc-shape-enable', 'true'); } catch {}
        try { localStorage.setItem('scc-shape-fix-starttc', 'true'); } catch {}

        const strictEl = document.getElementById('fmt-scc-strict-encoding');
        if (strictEl) strictEl.checked = true;

        const repCtrlEl = document.getElementById('fmt-scc-repeat-control');
        if (repCtrlEl) repCtrlEl.checked = true;
        const repPreEl = document.getElementById('fmt-scc-repeat-preamble');
        if (repPreEl) repPreEl.checked = true;

        const shapeModeEl = document.getElementById('fmt-scc-shape-mode');
        if (shapeModeEl) {
          const cur = String(shapeModeEl.value || '').trim();
          if (!cur || cur === 'off') {
            try { localStorage.setItem('scc-shape-mode', 'conservative'); } catch {}
            shapeModeEl.value = 'conservative';
            try { setDropdownValue('fmt-scc-shape-mode', 'conservative'); } catch {}
          }
        }

        const fixEl = document.getElementById('fmt-scc-shape-fix-starttc');
        if (fixEl) fixEl.checked = true;

      } else {
        // Leaving gated deliverable mode → restore draft-friendly strictness.
        // Only revert if strict encoding was auto-forced by the gated preset.
        if (wasStrictForced) {
          try { localStorage.setItem('scc-strict-encoding', 'false'); } catch {}
          try { localStorage.removeItem(STRICT_FORCED_KEY); } catch {}
          const strictEl = document.getElementById('fmt-scc-strict-encoding');
          if (strictEl) {
            strictEl.checked = false;
            try { strictEl.dispatchEvent(new Event('change')); } catch {}
          }
        }
      }

      // Keep auto-shape dependent knobs in sync with the current mode.
      try { applySccShapeModeConstraints(); } catch {}

    };

    if (polEl && polEl.dataset.boundPolicy !== '1') {
      polEl.dataset.boundPolicy = '1';
      polEl.addEventListener('change', () => {
        applySccExportPolicySideEffects(polEl.value);
      });
    }

    // Apply once on load too (sync legacy keys + enforce any gated-mode side effects).
    try {
      const cur = polEl ? polEl.value : (localStorage.getItem('scc-export-policy') || 'warn');
      applySccExportPolicySideEffects(cur);
    } catch {}

    // Auto-shape knobs are mode-dependent. Disable controls that have no effect
    // for the currently selected mode so the UI reflects reality.
    function applySccShapeModeConstraints() {
      const modeRaw = document.getElementById('fmt-scc-shape-mode')?.value;
      const mode = String(modeRaw || 'off').trim().toLowerCase();
      const normalized = (mode === 'aggressive' || mode === 'conservative' || mode === 'off') ? mode : 'conservative';

      const isOff = (normalized === 'off');
      const isAggressive = (normalized === 'aggressive');

      const setDisabled = (id, disabled) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = !!disabled;
        const item = (typeof el.closest === 'function') ? el.closest('.form-item') : null;
        if (item && item.classList) {
          if (disabled) item.classList.add('dependent-disabled');
          else item.classList.remove('dependent-disabled');
        }
      };

      // Off → disable all auto-shape controls.
      // Conservative → merge knobs only.
      // Aggressive → all knobs enabled.
      setDisabled('fmt-scc-shape-micro-dur', isOff);
      setDisabled('fmt-scc-shape-micro-gap', isOff);
      setDisabled('fmt-scc-shape-max-shift', isOff || !isAggressive);
      setDisabled('fmt-scc-shape-fix-starttc', isOff);
    }

    // SCC auto-shape: dropdown includes explicit Off state (replaces the old enable checkbox).
    // Persisted keys:
    //   - scc-shape-enable: 'true' | 'false'
    //   - scc-shape-mode: last non-off mode ('conservative'|'aggressive')
    (function bindSccShapeMode() {
      const el = document.getElementById('fmt-scc-shape-mode');
      if (!el) return;

      // Restore state
      let enabled = false;
      let mode = 'conservative';
      try { enabled = (localStorage.getItem('scc-shape-enable') === 'true'); } catch {}
      try { mode = (localStorage.getItem('scc-shape-mode') || 'conservative').trim() || 'conservative'; } catch {}

      const initial = enabled ? mode : 'off';
      el.value = initial;
      try { if (typeof setDropdownValue === 'function') setDropdownValue('fmt-scc-shape-mode', initial); } catch {}

      const save = () => {
        const v = String(el.value || 'off').trim();
        try {
          if (v === 'off') {
            localStorage.setItem('scc-shape-enable', 'false');
            // keep last real mode in scc-shape-mode
          } else {
            localStorage.setItem('scc-shape-enable', 'true');
            localStorage.setItem('scc-shape-mode', v);
          }
        } catch {}
      };

      const onChange = () => {
        save();
        try { applySccShapeModeConstraints(); } catch {}
      };

      el.addEventListener('change', onChange);

      // Reflect mode-dependent knobs immediately on load.
      try { applySccShapeModeConstraints(); } catch {}
    })();
    bindNum('fmt-scc-shape-micro-dur', 'scc-shape-micro-dur', 0.40, 0, 2);
    bindNum('fmt-scc-shape-micro-gap', 'scc-shape-micro-gap', 0.12, 0, 2);
    bindNum('fmt-scc-shape-max-shift', 'scc-shape-max-shift', 0.25, 0, 5);
    bindBool('fmt-scc-shape-fix-starttc', 'scc-shape-fix-starttc', true);

    // --- Reset to friendly defaults (Phase B) ---
    // Keep this non-strict by default; deliverable gating is opt-in via SCC Deliverable Mode.
    const resetSccDefaults = () => {
      const setLs = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };

      const forceBool = (id, key, val) => {
        const el = document.getElementById(id);
        if (el && typeof el.checked === 'boolean') {
          el.checked = !!val;
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
        setLs(key, val ? 'true' : 'false');
      };
      const forceNum = (id, key, val) => {
        const el = document.getElementById(id);
        if (el) {
          el.value = String(val);
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
        setLs(key, String(val));
      };
      const forceText = (id, key, val) => {
        const el = document.getElementById(id);
        if (el) {
          el.value = String(val ?? '');
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
        setLs(key, String(val ?? ''));
      };
      const forceSelect = (id, key, val) => {
        const el = document.getElementById(id);
        if (el) {
          el.value = String(val);
          try { setDropdownValue(id, el.value); } catch {}
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
        setLs(key, String(val));
      };

      // SCC mini-panel (non-LS)
      try {
        const maxCharsEl = document.getElementById('scc-max-chars') || document.getElementById('fmt-scc-max-chars');
        if (maxCharsEl) maxCharsEl.value = '28';
        const maxLinesEl = document.getElementById('scc-max-lines') || document.getElementById('fmt-scc-max-lines');
        if (maxLinesEl) maxLinesEl.value = '2';
        const maxDurEl = document.getElementById('scc-max-duration') || document.getElementById('fmt-scc-max-duration');
        if (maxDurEl) maxDurEl.value = '6.0';
      } catch {}

      // SCC service + alignment (mini-panel; persisted)
      try {
        const chEl = document.getElementById('scc-channel');
        if (chEl) {
          chEl.value = '1';
          try { setDropdownValue('scc-channel', '1'); } catch {}
          try { chEl.dispatchEvent(new Event('change')); } catch {}
        }
        setLs('scc-channel', '1');
      } catch {}
      try {
        const alEl = document.getElementById('scc-alignment');
        if (alEl) {
          alEl.value = 'center';
          try { setDropdownValue('scc-alignment', 'center'); } catch {}
          try { alEl.dispatchEvent(new Event('change')); } catch {}
        }
        setLs('scc-alignment', 'center');
      } catch {}

      // SCC placement (CEA-608): placement is always user-driven via Visual placement.
      // Default remains "lower center".
      forceSelect('fmt-scc-placement-mode', 'scc-placement-mode', 'custom');
      forceNum('fmt-scc-placement-bottom-row', 'scc-placement-bottom-row', 15);
      forceNum('fmt-scc-placement-left-col', 'scc-placement-left-col', 2);

      // Encoder/QC defaults
      forceSelect('fmt-scc-export-policy', 'scc-export-policy', 'warn');
      try { applySccExportPolicySideEffects('warn'); } catch {}

      forceBool('fmt-scc-allow-ndf', 'scc-allow-ndf', false);
      forceBool('fmt-scc-repeat-control', 'scc-repeat-control', true);
      forceBool('fmt-scc-repeat-preamble', 'scc-repeat-preamble', true);
      forceBool('fmt-scc-strip-leading-dashes', 'scc-strip-leading-dashes', false);
      forceBool('fmt-scc-pad-even', 'scc-pad-even', false);
      forceBool('fmt-scc-strict-encoding', 'scc-strict-encoding', false);
      forceNum('fmt-scc-safe-left', 'scc-safe-left', 0);
      forceNum('fmt-scc-safe-right', 'scc-safe-right', 0);
      forceNum('fmt-scc-prestart-roll', 'scc-prestart-roll', 0);

      forceSelect('fmt-scc-time-source', 'scc-time-source', 'auto');
      forceSelect('fmt-scc-start-reset-at', 'scc-start-reset-at', 'auto');
      forceSelect('fmt-scc-start-reset-op', 'scc-start-reset-op', 'edm');
      forceText('fmt-scc-prefix-words', 'scc-prefix-words', '');

      // Shaping OFF by default (friendly). Keep last mode conservative for quick re-enable.
      try {
        const shapeEl = document.getElementById('fmt-scc-shape-mode');
        if (shapeEl) {
          shapeEl.value = 'off';
          try { setDropdownValue('fmt-scc-shape-mode', 'off'); } catch {}
          try { shapeEl.dispatchEvent(new Event('change')); } catch {}
        }
        setLs('scc-shape-enable', 'false');
        setLs('scc-shape-mode', 'conservative');
      } catch {}
      forceNum('fmt-scc-shape-micro-dur', 'scc-shape-micro-dur', 0.40);
      forceNum('fmt-scc-shape-micro-gap', 'scc-shape-micro-gap', 0.12);
      forceNum('fmt-scc-shape-max-shift', 'scc-shape-max-shift', 0.25);
      forceBool('fmt-scc-shape-fix-starttc', 'scc-shape-fix-starttc', true);

      // QC thresholds
      forceNum('fmt-scc-qc-max-cps', 'scc-qc-max-cps', 20);
      forceNum('fmt-scc-qc-max-wpm', 'scc-qc-max-wpm', 180);
      forceNum('fmt-scc-qc-min-duration', 'scc-qc-min-duration', 0.8);
      forceNum('fmt-scc-qc-min-gap', 'scc-qc-min-gap', 0.1);
      forceNum('fmt-scc-qc-max-late-eoc', 'scc-qc-max-late-eoc', 0.1);
      forceNum('fmt-scc-qc-max-late-eoc-count', 'scc-qc-max-late-eoc-count', 0);

      // Clear SCC Start TC override (let global/auto logic decide).
      try {
        const tcEl = document.getElementById('fmt-scc-tc-start');
        if (tcEl) tcEl.value = '';
      } catch {}
      try { localStorage.removeItem('scc-tc-start'); } catch {}

      try { updateDisabledOutputFormats(); } catch {}
      try { applyCurrentFormatScope(); } catch {}
    };

    // Expose to the main Transcribe Reset button.
    _resetSccDefaults = resetSccDefaults;
  }

  function initSccPlacementUi() {
    const modeEl = document.getElementById('fmt-scc-placement-mode'); // optional hidden legacy input
    const bottomRowEl = document.getElementById('fmt-scc-placement-bottom-row');
    const leftColEl = document.getElementById('fmt-scc-placement-left-col');
    const gridWrapEl = document.getElementById('scc-window-grid-picker');
    const metaEl = document.getElementById('scc-window-grid-meta');
    const canvasEl = document.getElementById('fmt-scc-window-grid-canvas');
    const nudgeUpEl = document.getElementById('scc-window-nudge-up');
    const nudgeDownEl = document.getElementById('scc-window-nudge-down');
    const nudgeLeftEl = document.getElementById('scc-window-nudge-left');
    const nudgeRightEl = document.getElementById('scc-window-nudge-right');

    if (!bottomRowEl || !leftColEl || !gridWrapEl || !canvasEl) return;

    // Guard against double-init (renderer scripts can be hot-reloaded in dev).
    try {
      if (canvasEl.dataset.sccPlacementInit === '1') return;
      canvasEl.dataset.sccPlacementInit = '1';
    } catch {}

    // CEA-608 / SCC is a fixed 32×15 screen.
    const SCC_GRID_COLS = 32;
    const SCC_GRID_ROWS = 15;

    const LS_MODE = 'scc-placement-mode';
    const LS_ROW = 'scc-placement-bottom-row';
    const LS_COL = 'scc-placement-left-col';

    const getLs = (k) => {
      try { return localStorage.getItem(k); } catch { return null; }
    };
    const setLs = (k, v) => {
      try { localStorage.setItem(k, String(v)); } catch {}
    };

    const canonMode = (v) => {
      const s = String(v || '').trim().toLowerCase();
      if (s === 'custom' || s === 'manual' || s === 'fixed') return 'custom';
      return 'auto';
    };

    const clampInt = (v, min, max, fallback) => {
      const n = parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
    };

    const _cssVar = (name, fallback) => {
      try {
        const v = getComputedStyle(document.body).getPropertyValue(name);
        const s = String(v || '').trim();
        return s || fallback;
      } catch {
        return fallback;
      }
    };

    const _toRgba = (color, alpha) => {
      const a = Math.max(0, Math.min(1, Number(alpha)));
      const c = String(color || '').trim();
      if (!c) return `rgba(0,0,0,${a})`;

      // #rgb / #rrggbb
      if (c[0] === '#') {
        const hex = c.slice(1).trim();
        const h = (hex.length === 3)
          ? hex.split('').map(ch => ch + ch).join('')
          : hex;
        if (h.length === 6) {
          const r = parseInt(h.slice(0, 2), 16);
          const g = parseInt(h.slice(2, 4), 16);
          const b = parseInt(h.slice(4, 6), 16);
          if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return `rgba(${r},${g},${b},${a})`;
        }
      }

      // rgb(...) / rgba(...)
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (m && m[1]) {
        const parts = m[1].split(',').map(s => s.trim());
        const r = parseFloat(parts[0]);
        const g = parseFloat(parts[1]);
        const b = parseFloat(parts[2]);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return `rgba(${r},${g},${b},${a})`;
      }

      return c; // best effort
    };

    // Geometry: SCC / CEA-608 positioning is defined within the FCC safe caption area
    // (80% of a 4:3 picture, centered). We render a 16:9 viewport, show the 4:3
    // picture area inside it, and draw the 32×15 grid only inside the 80% safe area.
    const computeSccSafeGridGeometry = (cssW, cssH) => {
      const screenW = Math.max(1, Number(cssW) || 1);
      const screenH = Math.max(1, Number(cssH) || 1);

      // 4:3 picture area centered within the 16:9 viewport (pillarboxed if needed).
      let picH = screenH;
      let picW = picH * (4 / 3);
      if (picW > screenW) {
        picW = screenW;
        picH = picW * (3 / 4);
      }
      const picLeft = (screenW - picW) / 2;
      const picTop = (screenH - picH) / 2;

      // FCC safe caption area = 80% of the picture width/height, centered.
      const safeW = picW * 0.8;
      const safeH = picH * 0.8;
      const safeLeft = picLeft + (picW - safeW) / 2;
      const safeTop = picTop + (picH - safeH) / 2;

      return {
        screen: { left: 0, top: 0, w: screenW, h: screenH },
        picture4x3: { left: picLeft, top: picTop, w: picW, h: picH },
        safeGrid: { left: safeLeft, top: safeTop, w: safeW, h: safeH }
      };
    };

    // Placement mode UI removed: SCC placement is always user-driven via the Visual placement grid.
    // Force the legacy preference key to 'custom', but keep the previous value so we can migrate
    // old Auto users to an equivalent manual placement.
    const prevMode = (() => {
      try { return canonMode(getLs(LS_MODE) || modeEl?.value || ''); } catch { return 'auto'; }
    })();
    setLs(LS_MODE, 'custom');
    try { if (modeEl) modeEl.value = 'custom'; } catch {}

    // Restore persisted row/col (if present).
    let hadSavedRow = false;
    let hadSavedCol = false;
    try {
      const rawRow = getLs(LS_ROW);
      if (rawRow != null && rawRow !== '') {
        bottomRowEl.value = rawRow;
        hadSavedRow = true;
      }
    } catch {}
    try {
      const rawCol = getLs(LS_COL);
      if (rawCol != null && rawCol !== '') {
        leftColEl.value = rawCol;
        hadSavedCol = true;
      }
    } catch {}

    const readDims = () => {
      const safeLeftEl = document.getElementById('fmt-scc-safe-left');
      const safeRightEl = document.getElementById('fmt-scc-safe-right');
      const maxCharsEl = document.getElementById('fmt-scc-max-chars');
      const maxLinesEl = document.getElementById('fmt-scc-max-lines');
      const alignEl = document.getElementById('scc-alignment');

      const safeLeft = clampInt(safeLeftEl?.value, 0, 15, 0);
      const safeRight = clampInt(safeRightEl?.value, 0, 15, 0);
      const safeWidth = Math.max(1, SCC_GRID_COLS - safeLeft - safeRight);

      const maxChars = clampInt(maxCharsEl?.value, 1, SCC_GRID_COLS, 28);
      const maxLines = clampInt(maxLinesEl?.value, 1, 2, 2);
      const width = Math.max(1, Math.min(maxChars, safeWidth));

      const alignment = String(alignEl?.value || getLs('scc-alignment') || 'center').trim().toLowerCase();

      return { safeLeft, safeRight, safeWidth, maxChars, maxLines, width, alignment };
    };

    const computeAutoPlacement = (dims) => {
      // In Auto mode, we preview a full-width window (effectiveMax) inside safe margins.
      const free = Math.max(0, dims.safeWidth - dims.width);
      let leftCol = dims.safeLeft;
      if (dims.alignment === 'right') leftCol = dims.safeLeft + free;
      else if (dims.alignment === 'center') leftCol = dims.safeLeft + Math.floor(free / 2);

      const bottomRow = SCC_GRID_ROWS; // rowPolicy bottom2 => bottom line is 15
      return { bottomRow, leftCol };
    };

    const clampCustomPlacement = (dims, { persist } = {}) => {
      const height = dims.maxLines;

      let bottomRow = clampInt(bottomRowEl?.value, 1, SCC_GRID_ROWS, SCC_GRID_ROWS);
      bottomRow = Math.max(height, Math.min(SCC_GRID_ROWS, bottomRow));

      // Left edge must keep the full window inside safe margins.
      const maxLeft = Math.max(dims.safeLeft, SCC_GRID_COLS - dims.safeRight - dims.width);
      let leftCol = clampInt(leftColEl?.value, 0, SCC_GRID_COLS - 1, dims.safeLeft);
      leftCol = Math.max(dims.safeLeft, Math.min(maxLeft, leftCol));

      const rowClamped = String(bottomRowEl.value) !== String(bottomRow);
      const colClamped = String(leftColEl.value) !== String(leftCol);

      bottomRowEl.value = String(bottomRow);
      leftColEl.value = String(leftCol);

      if (persist) {
        setLs(LS_ROW, bottomRow);
        setLs(LS_COL, leftCol);
      }

      return { bottomRow, leftCol, height, rowClamped, colClamped, maxLeft };
    };

    // Seed manual placement when migrating from legacy Auto mode (or when no saved row/col yet)
    // so the default remains "lower center" in the 32×15 safe grid.
    try {
      const dims = readDims();
      const needSeed = (prevMode !== 'custom') || !hadSavedRow || !hadSavedCol;
      if (needSeed) {
        const a = computeAutoPlacement(dims);
        bottomRowEl.value = String(a.bottomRow);
        leftColEl.value = String(a.leftCol);
      }
      clampCustomPlacement(dims, { persist: true });
    } catch {}

    const setModeLockedState = () => {
      // Placement mode UI removed: visual placement is always active.
      gridWrapEl.classList.remove('locked');
      bottomRowEl.disabled = false;
      leftColEl.disabled = false;

      // Keep legacy preference key pinned to custom for downstream export paths.
      try { setLs(LS_MODE, 'custom'); } catch {}
      try { if (modeEl) modeEl.value = 'custom'; } catch {}
    };

    let _renderRaf = 0;
    const scheduleRender = () => {
      if (_renderRaf) return;
      _renderRaf = requestAnimationFrame(() => {
        _renderRaf = 0;
        render();
      });
    };

    // Lightweight i18n refresh hook used by the global transcribe language listener.
    // This redraws placement labels only and does not touch user-entered row/column values.
    try { window.__refreshSccPlacementUiI18n = scheduleRender; } catch {}

    const render = () => {
      const ctx = canvasEl.getContext('2d');
      if (!ctx) return;

      // Resize canvas to match CSS size (HiDPI aware).
      const rect = canvasEl.getBoundingClientRect();
      let cssW = Number(rect.width);
      let cssH = Number(rect.height);

      // When the SCC mini-panel is hidden, the canvas has no layout box (0×0).
      // Use a sane 16:9 fallback that matches the canvas' native attributes/CSS max-width
      // so the first visible paint already looks correct.
      if (!Number.isFinite(cssW) || !Number.isFinite(cssH) || cssW <= 0 || cssH <= 0) {
        const attrW = Number(canvasEl.getAttribute('width'));
        const attrH = Number(canvasEl.getAttribute('height'));
        cssW = (Number.isFinite(attrW) && attrW > 0) ? attrW : 640;
        cssH = (Number.isFinite(attrH) && attrH > 0) ? attrH : 360;
      }

      const w = Math.max(10, cssW);
      const h = Math.max(10, cssH);
      const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);

      const pxW = Math.round(w * dpr);
      const pxH = Math.round(h * dpr);
      if (canvasEl.width !== pxW) canvasEl.width = pxW;
      if (canvasEl.height !== pxH) canvasEl.height = pxH;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const border = _cssVar('--ui-border', '#c6c7cc');
      const panel = _cssVar('--ui-panel', '#f7f7f7');
      const surface = _cssVar('--ui-surface', '#ffffff');
      const accent = _cssVar('--ui-accent', '#c4b5fd');
      const accent2 = _cssVar('--ui-accent-2', '#a78bfa');

      const minor = _toRgba(border, 0.25);
      const major = _toRgba(border, 0.45);
      const safeShade = _toRgba(border, 0.08);
      const winFill = _toRgba(accent, 0.12);
      const winStroke = _toRgba(accent, 0.85);
      const anchorCol = _toRgba(accent2, 0.95);

      // Background (16:9 viewport)
      ctx.fillStyle = panel;
      ctx.fillRect(0, 0, w, h);

      // Geometry: 4:3 picture area + FCC safe caption area (80%) for the 32×15 grid.
      const geo = computeSccSafeGridGeometry(w, h);
      const p = geo.picture4x3;
      const g = geo.safeGrid;

      // 4:3 picture area (reference frame for CEA-608)
      ctx.fillStyle = surface;
      ctx.fillRect(p.left, p.top, p.w, p.h);
      ctx.strokeStyle = major;
      ctx.lineWidth = 2;
      ctx.strokeRect(p.left + 1, p.top + 1, Math.max(0, p.w - 2), Math.max(0, p.h - 2));

      // Shade the picture area outside the FCC safe caption area (10% margins).
      const overscanShade = _toRgba(border, 0.06);
      ctx.fillStyle = overscanShade;
      // top
      ctx.fillRect(p.left, p.top, p.w, Math.max(0, g.top - p.top));
      // bottom
      ctx.fillRect(p.left, g.top + g.h, p.w, Math.max(0, (p.top + p.h) - (g.top + g.h)));
      // left
      ctx.fillRect(p.left, g.top, Math.max(0, g.left - p.left), g.h);
      // right
      ctx.fillRect(g.left + g.w, g.top, Math.max(0, (p.left + p.w) - (g.left + g.w)), g.h);

      // Safe caption area border (this is where the CEA-608 32×15 grid lives)
      ctx.strokeStyle = _toRgba(border, 0.55);
      ctx.lineWidth = 2;
      ctx.strokeRect(g.left + 1, g.top + 1, Math.max(0, g.w - 2), Math.max(0, g.h - 2));

      const gLeft = g.left;
      const gTop = g.top;
      const gW = g.w;
      const gH = g.h;

      const cellW = gW / SCC_GRID_COLS;
      const cellH = gH / SCC_GRID_ROWS;

      const dims = readDims();

      // Safe margins shading (columns only).
      if (dims.safeLeft > 0) {
        ctx.fillStyle = safeShade;
        ctx.fillRect(gLeft, gTop, dims.safeLeft * cellW, gH);
      }
      if (dims.safeRight > 0) {
        ctx.fillStyle = safeShade;
        ctx.fillRect(gLeft + (SCC_GRID_COLS - dims.safeRight) * cellW, gTop, dims.safeRight * cellW, gH);
      }

      // Grid lines
      ctx.lineWidth = 1;
      for (let c = 0; c <= SCC_GRID_COLS; c++) {
        // Major every 4 columns: PAC indentation steps (0,4,8,...,28)
        ctx.strokeStyle = (c % 4 === 0) ? major : minor;
        const x = gLeft + (c * cellW);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, gTop);
        ctx.lineTo(x + 0.5, gTop + gH);
        ctx.stroke();
      }
      for (let r = 0; r <= SCC_GRID_ROWS; r++) {
        ctx.strokeStyle = (r % 5 === 0) ? major : minor;
        const y = gTop + (r * cellH);
        ctx.beginPath();
        ctx.moveTo(gLeft, y + 0.5);
        ctx.lineTo(gLeft + gW, y + 0.5);
        ctx.stroke();
      }

      // Placement preview window: width = effectiveMax chars, height = max lines.
      let bottomRow = SCC_GRID_ROWS;
      let leftCol = dims.safeLeft;
      let clampInfo = { rowClamped: false, colClamped: false };

      {
        const c = clampCustomPlacement(dims, { persist: true });
        bottomRow = c.bottomRow;
        leftCol = c.leftCol;
        clampInfo = c;
      }

      const height = dims.maxLines;
      const topRow = Math.max(1, bottomRow - height + 1);

      const wX = gLeft + (leftCol * cellW);
      const wY = gTop + ((topRow - 1) * cellH);
      const wW = dims.width * cellW;
      const wH = height * cellH;

      ctx.fillStyle = winFill;
      ctx.fillRect(wX, wY, wW, wH);
      ctx.strokeStyle = winStroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(wX + 1, wY + 1, Math.max(0, wW - 2), Math.max(0, wH - 2));

      if (height > 1) {
        ctx.save();
        ctx.strokeStyle = _toRgba(accent, 0.45);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        for (let i = 1; i < height; i++) {
          const y = wY + (i * cellH);
          ctx.beginPath();
          ctx.moveTo(wX, y + 0.5);
          ctx.lineTo(wX + wW, y + 0.5);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Anchor marker at bottom-left of the window.
      const aX = gLeft + (leftCol + 0.5) * cellW;
      const aY = gTop + (bottomRow - 0.5) * cellH;
      ctx.fillStyle = anchorCol;
      ctx.beginPath();
      ctx.arc(aX, aY, Math.max(2, Math.min(cellW, cellH) * 0.25), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = _toRgba(panel, 0.65);
      ctx.lineWidth = 2;
      ctx.stroke();

      // Meta readout (also helps explain the SCC row/col rules).
      if (metaEl) {
        const colsTxt = `${leftCol}–${Math.max(leftCol, leftCol + dims.width - 1)}`;
        const rowsTxt = `${topRow}–${bottomRow}`;
        const indent = Math.floor(leftCol / 4) * 4;
        const tab = leftCol - indent;
        const clampNote = (clampInfo.rowClamped || clampInfo.colClamped)
          ? tr('transcribePlacementClampedSuffix', ' (clamped)')
          : '';
        const hint = tr('transcribePlacementClickGridHint', 'Click grid (or nudge) to adjust.');
        metaEl.textContent = tr(
          'transcribePlacementMetaLine',
          'Placement: rows {{rows}}, cols {{cols}}{{clamp}} • Window {{maxLines}}×{{width}} • Safe cols L/R {{safeLeft}}/{{safeRight}} • Grid = FCC safe caption area (80% of 4:3) • PAC indent {{indent}} + tab {{tab}} (col {{leftCol}}) • {{hint}}',
          {
            rows: rowsTxt,
            cols: colsTxt,
            clamp: clampNote,
            maxLines: dims.maxLines,
            width: dims.width,
            safeLeft: dims.safeLeft,
            safeRight: dims.safeRight,
            indent,
            tab,
            leftCol,
            hint
          }
        );
      }
    };

    const applyCustom = (bottomRow, leftCol) => {
      const dims = readDims();
      bottomRowEl.value = String(bottomRow);
      leftColEl.value = String(leftCol);
      clampCustomPlacement(dims, { persist: true });
      scheduleRender();
    };

    const onExternalDimsChange = () => {
      const dims = readDims();
      clampCustomPlacement(dims, { persist: true });
      scheduleRender();
    };

    bottomRowEl.addEventListener('input', () => {
      const dims = readDims();
      clampCustomPlacement(dims, { persist: true });
      scheduleRender();
    });
    bottomRowEl.addEventListener('change', () => {
      const dims = readDims();
      clampCustomPlacement(dims, { persist: true });
      scheduleRender();
    });

    leftColEl.addEventListener('input', () => {
      const dims = readDims();
      clampCustomPlacement(dims, { persist: true });
      scheduleRender();
    });
    leftColEl.addEventListener('change', () => {
      const dims = readDims();
      clampCustomPlacement(dims, { persist: true });
      scheduleRender();
    });

    // Click-to-place
    canvasEl.addEventListener('click', (ev) => {
      const rect = canvasEl.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;

      const geo = computeSccSafeGridGeometry(rect.width, rect.height);
      const g = geo.safeGrid;

      // Map clicks into the FCC safe caption area (clamp if user clicks outside it).
      const gW = Math.max(1, g.w);
      const gH = Math.max(1, g.h);
      let relX = x - g.left;
      let relY = y - g.top;
      relX = Math.max(0, Math.min(gW - 0.000001, relX));
      relY = Math.max(0, Math.min(gH - 0.000001, relY));

      const col = Math.max(0, Math.min(SCC_GRID_COLS - 1, Math.floor((relX / gW) * SCC_GRID_COLS)));
      const row = Math.max(1, Math.min(SCC_GRID_ROWS, Math.floor((relY / gH) * SCC_GRID_ROWS) + 1));

      applyCustom(row, col);
    });

    // Nudge buttons
    const nudge = (dRow, dCol) => {
      const dims = readDims();
      const cur = clampCustomPlacement(dims, { persist: false });
      applyCustom(cur.bottomRow + dRow, cur.leftCol + dCol);
    };

    nudgeUpEl?.addEventListener('click', () => nudge(-1, 0));
    nudgeDownEl?.addEventListener('click', () => nudge(1, 0));
    nudgeLeftEl?.addEventListener('click', () => nudge(0, -1));
    nudgeRightEl?.addEventListener('click', () => nudge(0, 1));

    // Redraw when dependent SCC settings change.
    document.getElementById('fmt-scc-max-chars')?.addEventListener('input', onExternalDimsChange);
    document.getElementById('fmt-scc-max-chars')?.addEventListener('change', onExternalDimsChange);
    document.getElementById('fmt-scc-max-lines')?.addEventListener('input', onExternalDimsChange);
    document.getElementById('fmt-scc-max-lines')?.addEventListener('change', onExternalDimsChange);
    document.getElementById('fmt-scc-safe-left')?.addEventListener('input', onExternalDimsChange);
    document.getElementById('fmt-scc-safe-left')?.addEventListener('change', onExternalDimsChange);
    document.getElementById('fmt-scc-safe-right')?.addEventListener('input', onExternalDimsChange);
    document.getElementById('fmt-scc-safe-right')?.addEventListener('change', onExternalDimsChange);
    document.getElementById('scc-alignment')?.addEventListener('change', onExternalDimsChange);

    window.addEventListener('resize', scheduleRender);

    // Re-render when the SCC panel is shown (hidden → visible) or the canvas is
    // resized by layout changes. This prevents the “looks wrong until clicked” bug.
    try {
      if (!canvasEl.__sccResizeObserver && typeof ResizeObserver !== 'undefined') {
        canvasEl.__sccResizeObserver = new ResizeObserver(() => scheduleRender());
        canvasEl.__sccResizeObserver.observe(canvasEl);
      }
    } catch {}

    try {
      const fmtSccEl = document.getElementById('fmt-scc');
      if (fmtSccEl && !fmtSccEl.__sccVisibilityObserver && typeof MutationObserver !== 'undefined') {
        fmtSccEl.__sccVisibilityObserver = new MutationObserver(() => {
          try {
            if (!fmtSccEl.classList.contains('hidden')) {
              // One extra RAF helps when the panel becomes visible mid-frame.
              scheduleRender();
              requestAnimationFrame(scheduleRender);
            }
          } catch {}
        });
        fmtSccEl.__sccVisibilityObserver.observe(fmtSccEl, { attributes: true, attributeFilter: ['class'] });
      }
    } catch {}

    try {
      const fmtSel = document.getElementById('transcribe-output-formats');
      if (fmtSel && fmtSel.dataset.sccRenderBound !== '1') {
        fmtSel.dataset.sccRenderBound = '1';
        const maybeRender = () => {
          if (String(fmtSel.value || '') === 'scc') {
            scheduleRender();
            requestAnimationFrame(scheduleRender);
          }
        };
        ['change', 'input', 'dropdown:change'].forEach(ev => fmtSel.addEventListener(ev, maybeRender));
      }
    } catch {}

    setModeLockedState();
    scheduleRender();
  }

  function initMccUi() {
    const bindNum = (id, key, defVal, min, max, opts = {}, onChange) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const raw = localStorage.getItem(key);
        if (raw != null && raw !== '') el.value = raw;
        else if (defVal != null && (el.value == null || String(el.value).trim() === '')) el.value = String(defVal);
      } catch {}

      const save = () => {
        if (typeof onChange === 'function') { try { onChange(); } catch {} }
        let v = Number(el.value);
        if (!Number.isFinite(v)) v = Number(defVal);
        if (opts.integer) v = Math.trunc(v);
        if (typeof min === 'number') v = Math.max(min, v);
        if (typeof max === 'number') v = Math.min(max, v);
        const out = String(v);
        el.value = out;
        try { localStorage.setItem(key, out); } catch {}
      };

      el.addEventListener('change', save);
    };

    const bindBool = (id, key, defVal, onChange) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const raw = localStorage.getItem(key);
        if (raw == null || raw === '') el.checked = !!defVal;
        else el.checked = (raw === 'true');
      } catch {
        el.checked = !!defVal;
      }

      const save = () => {
        try { localStorage.setItem(key, el.checked ? 'true' : 'false'); } catch {}
        if (typeof onChange === 'function') onChange(el.checked);
      };
      el.addEventListener('change', save);
    };

    const bindText = (id, key, defVal) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const raw = localStorage.getItem(key);
        if (raw != null) el.value = raw;
        else if (defVal != null && (el.value == null || String(el.value).trim() === '')) el.value = String(defVal);
      } catch {}
      const save = () => {
        try { localStorage.setItem(key, String(el.value || '')); } catch {}
      };
      el.addEventListener('change', save);
    };

    const bindSelect = (id, key, defVal, onChange) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const raw = localStorage.getItem(key);
        if (raw != null && raw !== '') el.value = raw;
        else if (defVal != null) el.value = defVal;
      } catch {
        if (defVal != null) el.value = defVal;
      }

      try { if (typeof setDropdownValue === 'function') setDropdownValue(id, el.value); } catch {}

      const handle = () => {
        try { localStorage.setItem(key, String(el.value || '')); } catch {}
        if (typeof onChange === 'function') {
          try { onChange(el.value); } catch {}
        }
      };
      el.addEventListener('input', handle);
      el.addEventListener('change', handle);
      handle();
    };

        // CDP timecode (0x71) is SMPTE-12M style and is only valid at <=30fps in our current encoder.
    // Disable it when the active fps is >30 to avoid generating an invalid/garbled timecode section.
    const _readLsBool = (key, defVal) => {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null || raw === '') return !!defVal;
        return raw === 'true';
      } catch {
        return !!defVal;
      }
    };

    const applyMccCdpTimecodeFpsConstraint = () => {
      // If we have an explicit fps override (either MCC-specific or global), use it for UI constraints.
      // Backend validation uses the resolved fps regardless of UI.
      const _effectiveMccFps = readNumericFps('fmt-mcc-fps', 'transcribe-fps', 'fmt-txt-fps');

      const tooHigh = (_effectiveMccFps != null && _effectiveMccFps > 30.0001);

      const cdpEl = document.getElementById('fmt-mcc-embed-cdp-timecode');
      if (cdpEl && typeof cdpEl.checked === 'boolean') {
        if (tooHigh) {
          cdpEl.dataset.forcedByMccFps = '1';
          cdpEl.disabled = true;
          cdpEl.title = tr(
            'transcribeCdpFpsTooltip',
            'Disabled when fps > 30 (CDP SMPTE-12M timecode supports <=30fps only)'
          );
          cdpEl.checked = false;
        } else {
          const wasForced = (cdpEl.dataset.forcedByMccFps === '1');
          if (wasForced) {
            cdpEl.disabled = false;
            cdpEl.title = '';
            cdpEl.checked = _readLsBool('mcc-embed-cdp-timecode', false);
            try { delete cdpEl.dataset.forcedByMccFps; } catch {}
          }
        }
      }
    };

    try { window.__applyMccCdpTimecodeFpsConstraint = applyMccCdpTimecodeFpsConstraint; } catch {}

    // MCC Alignment (affects both 708 justify + 608 PAC)
    const mccAlignOpts = [
      { value: 'left', label: tr('transcribeMccAlignLeft', 'Left') },
      { value: 'center', label: tr('transcribeMccAlignCenter', 'Center') },
      { value: 'right', label: tr('transcribeMccAlignRight', 'Right') }
    ];
    const savedMccAlign = (localStorage.getItem('mcc-alignment') || localStorage.getItem('scc-alignment') || 'center').trim() || 'center';
    safeSetupDropdown('fmt-mcc-alignment', mccAlignOpts, savedMccAlign);
    bindSelect('fmt-mcc-alignment', 'mcc-alignment', savedMccAlign);

    // 608-compat advanced options (mirrors SCC's "thorough knobs")
    bindBool('fmt-mcc-repeat-control', 'mcc-repeat-control', false);
    bindBool('fmt-mcc-repeat-preamble', 'mcc-repeat-preamble', true);
    bindBool('fmt-mcc-pad-even', 'mcc-pad-even', false);
    bindBool('fmt-mcc-strict-encoding', 'mcc-strict-encoding', false);
    bindNum('fmt-mcc-safe-left', 'mcc-safe-left', 0, 0, 15, { integer: true });
    bindNum('fmt-mcc-safe-right', 'mcc-safe-right', 0, 0, 15, { integer: true });

    const mccOverflowOpts = getMccOverflowPolicyOptions();
    const savedMccOverflow = (() => {
      try { return (localStorage.getItem('mcc-overflow-policy') || '').trim(); } catch { return ''; }
    })() || 'error';

    safeSetupDropdown('fmt-mcc-overflow-policy', mccOverflowOpts, savedMccOverflow);
    bindSelect('fmt-mcc-overflow-policy', 'mcc-overflow-policy', savedMccOverflow);

    const mccShapeModeOpts = getMccShapeModeOptions();

    const bindMccShapeMode = () => {
      const el = document.getElementById('fmt-mcc-shape-mode');
      if (!el) return;

      let enabled = false;
      let mode = 'aggressive';

      try {
        enabled = localStorage.getItem('mcc-shape-enable') === 'true';
        const raw = localStorage.getItem('mcc-shape-mode');
        if (raw) mode = String(raw).trim().toLowerCase() || mode;
      } catch {}

      const initial = enabled ? mode : 'off';
      if (!el.value) el.value = initial;
      try { if (typeof setDropdownValue === 'function') setDropdownValue('fmt-mcc-shape-mode', el.value); } catch {}

      const handle = () => {
        const v = String(el.value || 'off').trim().toLowerCase();
        if (v === 'off') {
          try { localStorage.setItem('mcc-shape-enable', 'false'); } catch {}
        } else {
          try {
            localStorage.setItem('mcc-shape-enable', 'true');
            localStorage.setItem('mcc-shape-mode', v);
          } catch {}
        }
      };

      el.addEventListener('input', handle);
      el.addEventListener('change', handle);
      handle();
    };

    const shapeInitial = (() => {
      try {
        const enabled = localStorage.getItem('mcc-shape-enable') === 'true';
        const mode = String(localStorage.getItem('mcc-shape-mode') || 'conservative').trim().toLowerCase() || 'conservative';
        return enabled ? mode : 'off';
      } catch {
        return 'off';
      }
    })();

    safeSetupDropdown('fmt-mcc-shape-mode', mccShapeModeOpts, shapeInitial);
    bindMccShapeMode();

    bindNum('fmt-mcc-shape-micro-dur', 'mcc-shape-micro-dur', 0.40, 0, 2);
    bindNum('fmt-mcc-shape-micro-gap', 'mcc-shape-micro-gap', 0.12, 0, 2);
    bindNum('fmt-mcc-shape-max-shift', 'mcc-shape-max-shift', 0.25, 0, 5);

    // Caption slip / offset (post-production)
    const mccOffsetPolicyOpts = getMccNegativeTimePolicyOptions();
    const savedOffsetPolicy = (localStorage.getItem('mcc-timecode-offset-policy') || 'clamp').trim() || 'clamp';
    safeSetupDropdown('fmt-mcc-timecode-offset-policy', mccOffsetPolicyOpts, savedOffsetPolicy);
    bindSelect('fmt-mcc-timecode-offset-policy', 'mcc-timecode-offset-policy', savedOffsetPolicy);

    // 708 window placement (DefineWindow anchorId)
    const savedAnchor = (localStorage.getItem('mcc-window-anchor-id') || '7').trim() || '7';
    // Anchor point is derived from Screen position presets; the UI control was removed.
    // Keep the hidden anchor id input + localStorage in sync for downstream export.
    try {
      const anchorIdEl = document.getElementById('fmt-mcc-window-anchor-id');
      if (anchorIdEl) anchorIdEl.value = savedAnchor;
    } catch {}
    try { localStorage.setItem('mcc-window-anchor-id', savedAnchor); } catch {}
    bindNum('fmt-mcc-max-chars', 'mcc-max-chars', 42, 1, 42, { integer: true });
    // Lead AE policy: never allow more than 3 lines per subtitle block.
    // (608 compatibility remains hard-capped to 2 lines by the writer when enabled.)
    bindNum('fmt-mcc-max-lines', 'mcc-max-lines', 2, 1, 3, { integer: true });
    bindNum('fmt-mcc-max-duration', 'mcc-max-duration', 6.0, 0.1, 60);
    bindBool('fmt-mcc-include-608', 'mcc-include-608', true);
    bindBool('fmt-mcc-telestream-compress', 'mcc-telestream-compress', false);
    bindBool('fmt-mcc-embed-cdp-timecode', 'mcc-embed-cdp-timecode', false);
    bindBool('fmt-mcc-include-ccsvc-info', 'mcc-include-ccsvc-info', true);
    bindNum('fmt-mcc-service-number', 'mcc-service-number', 1, 1, 63, { integer: true });
    bindText('fmt-mcc-language', 'mcc-language', 'eng');

    // Optional FPS override (blank = Auto/detect)
    // Stored as raw text to allow blank values and avoid clamping.
    bindText('fmt-mcc-fps', 'mcc-fps', '');

    // Start TC override (blank => use global Start TC)
    bindText('fmt-mcc-tc-start', 'mcc-tc-start', '');
    // Caption slip / offset (string, frames, seconds)
    bindText('fmt-mcc-timecode-offset', 'mcc-timecode-offset', '');

    bindBool('fmt-mcc-pingpong-windows', 'mcc-pingpong-windows', true);
    // 708 window placement
    // Coordinate system:
    //   • REL => anchors are percentages (0..99)
    //   • ABS => anchors use CEA-708 absolute units (V 0..74, H 0..209)
    // Stored in localStorage('mcc-window-rel') and reflected in the UI.
    const winVEl = document.getElementById('fmt-mcc-window-anchor-v');
    const winHEl = document.getElementById('fmt-mcc-window-anchor-h');
    const winRowEl = document.getElementById('fmt-mcc-window-row');
    const winColEl = document.getElementById('fmt-mcc-window-col');
    const winLinesBottomEl = document.getElementById('fmt-mcc-window-lines-bottom-row');
    const winLinesHeightEl = document.getElementById('fmt-mcc-window-lines-height');
    const mccMaxLinesEl = document.getElementById('fmt-mcc-max-lines');
    const mccInclude608El = document.getElementById('fmt-mcc-include-608');

    // Coordinate-system badges next to Vertical/Horizontal position labels.
    const winVCoordEl = document.getElementById('mcc-window-v-coord');
    const winHCoordEl = document.getElementById('mcc-window-h-coord');

    const _readLsBoolWin = (key, defVal) => {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null || raw === '') return !!defVal;
        return raw === 'true';
      } catch {
        return !!defVal;
      }
    };

    // Coordinate system for MCC 708 window anchors.
    // Source of truth: localStorage('mcc-window-rel')
    //  • true  => REL (% 0..99)
    //  • false => ABS (V 0..74, H 0..209)
    // Legacy fallback: mcc-window-preset === 'custom' implies ABS.
    const getMccWindowRel = () => {
      try {
        const raw = localStorage.getItem('mcc-window-rel');
        if (raw != null && String(raw).trim() !== '') return raw === 'true';
      } catch {}
      try {
        const presetRaw = String(localStorage.getItem('mcc-window-preset') || '').trim().toLowerCase();
        if (presetRaw) return presetRaw !== 'custom';
      } catch {}
      return _readLsBoolWin('mcc-window-rel', true);
    };

    // Placement UI mode was simplified: MCC always places by window anchor.
    const setMccWindowRelLs = (rel) => { try { localStorage.setItem('mcc-window-rel', rel ? 'true' : 'false'); } catch {} };

    // Seed last-known state from storage so upgrades can auto-convert values.
    let _mccWindowRelLast = (() => {
      try {
        const raw = localStorage.getItem('mcc-window-rel');
        if (raw == null || raw === '') return null;
        return raw === 'true';
      } catch {
        return null;
      }
    })();

    // --- Placement mode: "Lines" (normal humans) ----------------------------
    // Users think: "Put the bottom line on row 15".
    // We convert that request into a window anchor row based on:
    //   • current anchor point (anchorId)
    //   • current block height (max lines)
    let _mccWindowSyncingLines = false;
    let _mccWindowSyncingLinesHeight = false;

    const _readMccWindowAnchorIdNum = () => {
      const raw = String(
        document.getElementById('fmt-mcc-window-anchor-id')?.value ||
        (function () { try { return localStorage.getItem('mcc-window-anchor-id'); } catch { return '7'; } })() ||
        '7'
      ).trim();
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? Math.max(0, Math.min(8, Math.trunc(n))) : 7;
    };

    const _readMccBlockHeight = () => {
      const raw = (mccMaxLinesEl?.value ?? winLinesHeightEl?.value ?? '');
      return _clampIntWin(raw, 1, 3, 2);
    };

    const _anchorVClass = (anchorIdNum) => {
      if (anchorIdNum <= 2) return 'top';
      if (anchorIdNum <= 5) return 'middle';
      return 'bottom';
    };

    const _computeAnchorRowFromBottomLine = (bottomRow, height, anchorIdNum) => {
      const h = _clampIntWin(height, 1, 3, 2);

      // Clamp so the whole block stays within the 15-row grid.
      let b = _clampIntWin(bottomRow, 1, MCC_GRID_ROWS, MCC_GRID_ROWS);
      b = Math.max(h, Math.min(MCC_GRID_ROWS, b));
      const top = b - h + 1;

      const cls = _anchorVClass(anchorIdNum);
      let anchorRow;
      if (cls === 'top') anchorRow = top;
      else if (cls === 'middle') anchorRow = top + Math.floor(h / 2);
      else anchorRow = b;

      anchorRow = Math.max(1, Math.min(MCC_GRID_ROWS, Math.trunc(anchorRow)));
      return { anchorRow, topRow: top, bottomRow: b };
    };

    const _computeBottomLineFromAnchorRow = (anchorRow, height, anchorIdNum) => {
      const h = _clampIntWin(height, 1, 3, 2);
      const a = _clampIntWin(anchorRow, 1, MCC_GRID_ROWS, MCC_GRID_ROWS);
      const cls = _anchorVClass(anchorIdNum);

      let bottom;
      if (cls === 'top') bottom = a + h - 1;
      else if (cls === 'middle') bottom = a + h - 1 - Math.floor(h / 2);
      else bottom = a;

      // Clamp to a valid, on-grid bottom row.
      bottom = Math.max(h, Math.min(MCC_GRID_ROWS, Math.trunc(bottom)));
      return bottom;
    };

    const _syncMccWindowLinesHeightFromMaxLines = () => {
      if (!winLinesHeightEl || !mccMaxLinesEl) return;
      if (_mccWindowSyncingLinesHeight) return;

      _mccWindowSyncingLinesHeight = true;
      try {
        const h = _readMccBlockHeight();
        if (String(winLinesHeightEl.value || '') !== String(h)) winLinesHeightEl.value = String(h);
      } finally {
        _mccWindowSyncingLinesHeight = false;
      }
    };

    const _syncMccWindowLinesFromCurrentPlacement = () => {
      if (!winLinesBottomEl) return;
      if (_mccWindowSyncingLines) return;

      _mccWindowSyncingLines = true;
      try {
        const h = _readMccBlockHeight();
        const anchorIdNum = _readMccWindowAnchorIdNum();
        const anchorRow = _clampIntWin(winRowEl?.value, 1, MCC_GRID_ROWS, MCC_GRID_ROWS);
        const bottom = _computeBottomLineFromAnchorRow(anchorRow, h, anchorIdNum);
        winLinesBottomEl.value = String(bottom);
      } finally {
        _mccWindowSyncingLines = false;
      }
    };


    // Friendly 42×15 grid helpers for MCC 708 window placement.
    // CTA-708 defines a 42×15 "screen" inside title-safe; users think in rows/cols,
    // while MCC stores window anchors as either:
    //   • relative percentages (0..99) OR
    //   • absolute anchor units (H:0..209, V:0..74).
    const MCC_GRID_COLS = 42;
    const MCC_GRID_ROWS = 15;

    // UX polish: show the active coordinate system next to the numeric fields and
    // make native stepping feel like the 42×15 grid.
    //
    // Default step = one row/col. Hold Alt/Option for fine step (handled on keydown).
    const updateMccWindowAnchorCoordUi = () => {
      const rel = getMccWindowRel();

      if (winVCoordEl) {
        winVCoordEl.textContent = rel
          ? tr('transcribePercentCoordinateRangeLabel', '% (0–99)')
          : tr('transcribeAbsoluteVerticalCoordinateRangeLabel', 'Abs (0–74)');
      }
      if (winHCoordEl) {
        winHCoordEl.textContent = rel
          ? tr('transcribePercentCoordinateRangeLabel', '% (0–99)')
          : tr('transcribeAbsoluteHorizontalCoordinateRangeLabel', 'Abs (0–209)');
      }

      // Default step = one row/col in the active coordinate system.
      //  - REL: approximate one row/col in % space
      //  - ABS: exact 5 units == 1 cell in the 42×15 minimum grid
      const vStep = rel ? Math.max(1, Math.round(99 / Math.max(1, MCC_GRID_ROWS - 1))) : 5;
      const hStep = rel ? Math.max(1, Math.round(99 / Math.max(1, MCC_GRID_COLS - 1))) : 5;

      if (winVEl) winVEl.step = String(vStep);
      if (winHEl) winHEl.step = String(hStep);
    };

    const _clampIntWin = (v, min, max, fallback) => {
      const n = parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
    };

    let _mccWindowSyncingGrid = false;

    const _gridToAnchors = (rel, row, col) => {
      const r = _clampIntWin(row, 1, MCC_GRID_ROWS, MCC_GRID_ROWS);
      const c = _clampIntWin(col, 1, MCC_GRID_COLS, Math.round(MCC_GRID_COLS / 2));

      const vMax = rel ? 99 : 74;
      const hMax = rel ? 99 : 209;

      const anchorV = Math.round(((r - 1) / Math.max(1, MCC_GRID_ROWS - 1)) * vMax);
      const anchorH = Math.round(((c - 1) / Math.max(1, MCC_GRID_COLS - 1)) * hMax);

      return {
        anchorV: Math.max(0, Math.min(vMax, anchorV)),
        anchorH: Math.max(0, Math.min(hMax, anchorH))
      };
    };

    const _anchorsToGrid = (rel, anchorV, anchorH) => {
      const vMax = rel ? 99 : 74;
      const hMax = rel ? 99 : 209;

      const v = _clampIntWin(anchorV, 0, vMax, rel ? 90 : 67);
      const h = _clampIntWin(anchorH, 0, hMax, rel ? 50 : 105);

      const row = Math.round((v / Math.max(1, vMax)) * (MCC_GRID_ROWS - 1)) + 1;
      const col = Math.round((h / Math.max(1, hMax)) * (MCC_GRID_COLS - 1)) + 1;

      return {
        row: Math.max(1, Math.min(MCC_GRID_ROWS, row)),
        col: Math.max(1, Math.min(MCC_GRID_COLS, col))
      };
    };

    const _syncMccWindowGridFromAnchors = () => {
      if (!winRowEl || !winColEl) return;
      if (_mccWindowSyncingGrid) return;

      _mccWindowSyncingGrid = true;
      try {
        const rel = getMccWindowRel();
        const v = winVEl ? parseInt(String(winVEl.value || ''), 10) : NaN;
        const h = winHEl ? parseInt(String(winHEl.value || ''), 10) : NaN;

        const g = _anchorsToGrid(rel, v, h);
        winRowEl.value = String(g.row);
        winColEl.value = String(g.col);
      } finally {
        _mccWindowSyncingGrid = false;
      }
    };

    const _syncMccWindowAnchorsFromGrid = (opts = {}) => {
      if (!winRowEl || !winColEl || !winVEl || !winHEl) return;
      if (_mccWindowSyncingGrid) return;

      _mccWindowSyncingGrid = true;
      try {
        const normalize = !!opts.normalize;
        const rel = getMccWindowRel();

        const rowRaw = parseInt(String(winRowEl.value || ''), 10);
        const colRaw = parseInt(String(winColEl.value || ''), 10);

        const r = _clampIntWin(rowRaw, 1, MCC_GRID_ROWS, MCC_GRID_ROWS);
        const c = _clampIntWin(colRaw, 1, MCC_GRID_COLS, Math.round(MCC_GRID_COLS / 2));

        if (normalize) {
          winRowEl.value = String(r);
          winColEl.value = String(c);
        }

        const a = _gridToAnchors(rel, r, c);

        winVEl.value = String(a.anchorV);
        winHEl.value = String(a.anchorH);

        // Persist programmatic changes (bindNum only persists on user input).
        try { clampWindowPlacement({ skipConvert: true }); } catch {}
      } finally {
        _mccWindowSyncingGrid = false;
      }
    };

    // Visual placement grid (42×15): click to set anchor + show window outline.
    const mccGridWrapEl = document.getElementById('mcc-window-grid-picker');
    const mccGridMetaEl = document.getElementById('mcc-window-grid-meta');
    const mccGridCanvasEl = document.getElementById('fmt-mcc-window-grid-canvas');
    const mccNudgeUpEl = document.getElementById('mcc-window-nudge-up');
    const mccNudgeDownEl = document.getElementById('mcc-window-nudge-down');
    const mccNudgeLeftEl = document.getElementById('mcc-window-nudge-left');
    const mccNudgeRightEl = document.getElementById('mcc-window-nudge-right');

    const _cssVarWin = (name, fallback) => {
      try {
        const v = getComputedStyle(document.body).getPropertyValue(name);
        const s = String(v || '').trim();
        return s || fallback;
      } catch {
        return fallback;
      }
    };

    const _toRgbaWin = (color, alpha) => {
      const a = Math.max(0, Math.min(1, Number(alpha)));
      const c = String(color || '').trim();
      if (!c) return `rgba(0,0,0,${a})`;

      // #rgb / #rrggbb
      if (c[0] === '#') {
        const hex = c.slice(1).trim();
        const h = (hex.length === 3)
          ? hex.split('').map(ch => ch + ch).join('')
          : hex;
        if (h.length === 6) {
          const r = parseInt(h.slice(0, 2), 16);
          const g = parseInt(h.slice(2, 4), 16);
          const b = parseInt(h.slice(4, 6), 16);
          if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return `rgba(${r},${g},${b},${a})`;
        }
      }

      // rgb(...) / rgba(...)
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (m && m[1]) {
        const parts = m[1].split(',').map(s => s.trim());
        const r = parseFloat(parts[0]);
        const g = parseFloat(parts[1]);
        const b = parseFloat(parts[2]);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return `rgba(${r},${g},${b},${a})`;
      }

      return c; // best effort
    };

    const _anchorPointWin = (anchorId) => {
      const id = String(anchorId ?? '7').trim();
      // 0..8, reading left-to-right, top-to-bottom.
      // 0 TL, 1 TC, 2 TR
      // 3 ML, 4 MC, 5 MR
      // 6 BL, 7 BC, 8 BR
      const map = {
        '0': { ax: 0,   ay: 0,   label: tr('transcribe.mcc.anchorLabel.topLeft', 'Top Left') },
        '1': { ax: 0.5, ay: 0,   label: tr('transcribe.mcc.anchorLabel.topCenter', 'Top Center') },
        '2': { ax: 1,   ay: 0,   label: tr('transcribe.mcc.anchorLabel.topRight', 'Top Right') },
        '3': { ax: 0,   ay: 0.5, label: tr('transcribe.mcc.anchorLabel.middleLeft', 'Middle Left') },
        '4': { ax: 0.5, ay: 0.5, label: tr('transcribe.mcc.anchorLabel.center', 'Center') },
        '5': { ax: 1,   ay: 0.5, label: tr('transcribe.mcc.anchorLabel.middleRight', 'Middle Right') },
        '6': { ax: 0,   ay: 1,   label: tr('transcribe.mcc.anchorLabel.bottomLeft', 'Bottom Left') },
        '7': { ax: 0.5, ay: 1,   label: tr('transcribe.mcc.anchorLabel.bottomCenter', 'Bottom Center') },
        '8': { ax: 1,   ay: 1,   label: tr('transcribe.mcc.anchorLabel.bottomRight', 'Bottom Right') }
      };
      return map[id] || map['7'];
    };

    const _anchorPointShortWin = (anchorId) => {
      const id = String(anchorId ?? '7').trim();
      const map = {
        '0': 'TL',
        '1': 'TC',
        '2': 'TR',
        '3': 'ML',
        '4': 'MC',
        '5': 'MR',
        '6': 'BL',
        '7': 'BC',
        '8': 'BR'
      };
      return map[id] || 'BC';
    };

    const _fmtRangeWin = (a, b) => {
      const x = Math.trunc(Number(a));
      const y = Math.trunc(Number(b));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return '—';
      return (x === y) ? String(x) : `${x}–${y}`;
    };

    const _computeWindowOccupancyWin = (row, col, dims, anchorId) => {
      const ap = _anchorPointWin(anchorId);
      const h = _clampIntWin(dims?.rows, 1, MCC_GRID_ROWS, 2);
      const w = _clampIntWin(dims?.cols, 1, MCC_GRID_COLS, 42);

      const aRow = _clampIntWin(row, 1, MCC_GRID_ROWS, 14);
      const aCol = _clampIntWin(col, 1, MCC_GRID_COLS, 22);

      const topUn = (ap.ay === 0) ? aRow : (ap.ay === 1) ? (aRow - h + 1) : (aRow - Math.floor(h / 2));
      const bottomUn = topUn + h - 1;
      const leftUn = (ap.ax === 0) ? aCol : (ap.ax === 1) ? (aCol - w + 1) : (aCol - Math.floor(w / 2));
      const rightUn = leftUn + w - 1;

      // Keep caption windows inside the CEA-708 screen.
      // If an anchor would push the window off-screen, clamp by SHIFTING (preserve size),
      // not by shrinking the window.
      let top = topUn;
      let bottom = bottomUn;
      if (h <= MCC_GRID_ROWS) {
        if (top < 1) {
          bottom += (1 - top);
          top = 1;
        }
        if (bottom > MCC_GRID_ROWS) {
          top -= (bottom - MCC_GRID_ROWS);
          bottom = MCC_GRID_ROWS;
        }
      }
      top = Math.max(1, Math.min(MCC_GRID_ROWS, top));
      bottom = Math.max(1, Math.min(MCC_GRID_ROWS, bottom));

      let left = leftUn;
      let right = rightUn;
      if (w <= MCC_GRID_COLS) {
        if (left < 1) {
          right += (1 - left);
          left = 1;
        }
        if (right > MCC_GRID_COLS) {
          left -= (right - MCC_GRID_COLS);
          right = MCC_GRID_COLS;
        }
      }
      left = Math.max(1, Math.min(MCC_GRID_COLS, left));
      right = Math.max(1, Math.min(MCC_GRID_COLS, right));

      const rowsClamped = (top !== topUn) || (bottom !== bottomUn);
      const colsClamped = (left !== leftUn) || (right !== rightUn);

      return {
        rows: { top, bottom, topUn, bottomUn, clamped: rowsClamped },
        cols: { left, right, leftUn, rightUn, clamped: colsClamped },
        ap
      };
    };


    const _readWinGridDims = () => {
      const maxCharsEl = document.getElementById('fmt-mcc-max-chars');
      const maxLinesEl = document.getElementById('fmt-mcc-max-lines');
      const cols = _clampIntWin(maxCharsEl?.value, 1, 42, 42);
      let rows = _clampIntWin(maxLinesEl?.value, 1, 3, 2);

      const include608 = !!mccInclude608El?.checked;
      return { cols, rows, include608 };
    };

    let _mccGridRenderRaf = 0;

    const renderMccWindowGrid = () => {
      if (!mccGridCanvasEl) return;

      const ctx = mccGridCanvasEl.getContext('2d');
      if (!ctx) return;

      // Resize canvas to match CSS size (HiDPI aware).
      const rect = mccGridCanvasEl.getBoundingClientRect();
      const cssW = Math.max(10, rect.width || 480);
      const cssH = Math.max(10, rect.height || 270);
      const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);

      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssH * dpr);
      if (mccGridCanvasEl.width !== pxW) mccGridCanvasEl.width = pxW;
      if (mccGridCanvasEl.height !== pxH) mccGridCanvasEl.height = pxH;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const border = _cssVarWin('--ui-border', '#c6c7cc');
      const panel = _cssVarWin('--ui-panel', '#f7f7f7');
      const surface = _cssVarWin('--ui-surface', '#ffffff');
      const accent = _cssVarWin('--ui-accent', '#c4b5fd');
      const accent2 = _cssVarWin('--ui-accent-2', '#a78bfa');

      const minor = _toRgbaWin(border, 0.25);
      const major = _toRgbaWin(border, 0.45);
      const winFill = _toRgbaWin(accent, 0.12);
      const winStroke = _toRgbaWin(accent, 0.85);
      const anchorCol = _toRgbaWin(accent2, 0.95);

      // Full frame (canvas) + CEA-708 safe-title box (10% margins; inner 80%).
      ctx.fillStyle = panel;
      ctx.fillRect(0, 0, cssW, cssH);

      const safePadX = Math.round(cssW * 0.1);
      const safePadY = Math.round(cssH * 0.1);
      const safeLeft = safePadX;
      const safeTop = safePadY;
      const safeW = Math.max(1, cssW - (safePadX * 2));
      const safeH = Math.max(1, cssH - (safePadY * 2));

      // Safe-title background + border so users see why "row 15" is not the bottom of the raster.
      ctx.fillStyle = surface;
      ctx.fillRect(safeLeft, safeTop, safeW, safeH);
      ctx.strokeStyle = major;
      ctx.lineWidth = 2;
      ctx.strokeRect(safeLeft + 1, safeTop + 1, Math.max(0, safeW - 2), Math.max(0, safeH - 2));

      const cellW = safeW / MCC_GRID_COLS;
      const cellH = safeH / MCC_GRID_ROWS;

      // Grid lines (inside safe-title only).
      ctx.lineWidth = 1;

      for (let c = 0; c <= MCC_GRID_COLS; c++) {
        ctx.strokeStyle = (c % 5 === 0) ? major : minor;
        const x = safeLeft + (c * cellW);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, safeTop);
        ctx.lineTo(x + 0.5, safeTop + safeH);
        ctx.stroke();
      }

      for (let r = 0; r <= MCC_GRID_ROWS; r++) {
        ctx.strokeStyle = (r % 5 === 0) ? major : minor;
        const y = safeTop + (r * cellH);
        ctx.beginPath();
        ctx.moveTo(safeLeft, y + 0.5);
        ctx.lineTo(safeLeft + safeW, y + 0.5);
        ctx.stroke();
      }

      // Current placement.
      const anchorIdEl = document.getElementById('fmt-mcc-window-anchor-id');
      const anchorId = String(anchorIdEl?.value || (function () { try { return localStorage.getItem('mcc-window-anchor-id'); } catch { return '7'; } })() || '7').trim() || '7';
      const ap = _anchorPointWin(anchorId);

      const row = _clampIntWin(winRowEl?.value, 1, MCC_GRID_ROWS, 14);
      const col = _clampIntWin(winColEl?.value, 1, MCC_GRID_COLS, 22);
      const dims = _readWinGridDims();

      // Anchor point (cell center).
      const aX = safeLeft + (col - 0.5) * cellW;
      const aY = safeTop + (row - 0.5) * cellH;

      // Window outline (derived from Max chars/lines).
      const occ = _computeWindowOccupancyWin(row, col, dims, anchorId);
      const wW = dims.cols * cellW;
      const wH = dims.rows * cellH;
      const wX = safeLeft + ((occ.cols.left - 1) * cellW);
      const wY = safeTop + ((occ.rows.top - 1) * cellH);

      // Fill + stroke.
      ctx.fillStyle = winFill;
      ctx.fillRect(wX, wY, wW, wH);
      ctx.strokeStyle = winStroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(wX + 1, wY + 1, Math.max(0, wW - 2), Math.max(0, wH - 2));

      // Line rows within the window.
      if (dims.rows > 1) {
        ctx.save();
        ctx.strokeStyle = _toRgbaWin(accent, 0.45);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        for (let i = 1; i < dims.rows; i++) {
          const y = wY + (i * cellH);
          ctx.beginPath();
          ctx.moveTo(wX, y + 0.5);
          ctx.lineTo(wX + wW, y + 0.5);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Anchor marker.
      ctx.fillStyle = anchorCol;
      ctx.beginPath();
      ctx.arc(aX, aY, Math.max(2, Math.min(cellW, cellH) * 0.25), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = _toRgbaWin(panel, 0.65);
      ctx.lineWidth = 2;
      ctx.stroke();

      // Meta text.
      if (mccGridWrapEl) {
        // The grid is always interactive for MCC.
        mccGridWrapEl.classList.remove('locked');
      }
      if (mccGridMetaEl) {
        const compat = dims.include608
          ? tr('transcribeMccCompatOn', '608 compat on')
          : tr('transcribeMccCompatOff', '608 compat off');
        const bottomLine = occ.rows.bottom;

        const rel = getMccWindowRel();
        const approx = rel ? '≈' : '';

        // (Already computed above for drawing.)
        const occRows = _fmtRangeWin(occ.rows.top, occ.rows.bottom);
        const occCols = _fmtRangeWin(occ.cols.left, occ.cols.right);
        const clampNote = (occ.rows.clamped || occ.cols.clamped)
          ? tr('transcribePlacementClampedSuffix', ' (clamped)')
          : '';

        const winLbl = (dims.rows === 1)
          ? tr('transcribeMccWindowLabelSingular', '{{rows}} line × {{cols}} cols', {
            rows: dims.rows,
            cols: dims.cols
          })
          : tr('transcribeMccWindowLabelPlural', '{{rows}} lines × {{cols}} cols', {
            rows: dims.rows,
            cols: dims.cols
          });
        const relLabel = rel
          ? tr('transcribeRelativeLabel', 'REL')
          : tr('transcribeAbsoluteLabel', 'ABS');
        mccGridMetaEl.textContent = tr(
          'transcribeMccPlacementMetaLine',
          'Placement: Anchor • Anchor: {{approx}}row {{row}}, {{approx}}col {{col}} • Window: rows {{occRows}}, cols {{occCols}}{{clamp}} • Bottom row {{bottomLine}} • {{winLabel}} • Anchor point: {{anchorLabel}} • {{compat}} • {{relLabel}}',
          {
            approx,
            row,
            col,
            occRows,
            occCols,
            clamp: clampNote,
            bottomLine,
            winLabel: winLbl,
            anchorLabel: ap.label,
            compat,
            relLabel
          }
        );
      }

    };

    const scheduleMccWindowGridRender = () => {
      if (!mccGridCanvasEl) return;
      if (_mccGridRenderRaf) return;
      _mccGridRenderRaf = window.requestAnimationFrame(() => {
        _mccGridRenderRaf = 0;
        try { renderMccWindowGrid(); } catch {}
      });
    };

    // Lightweight i18n refresh hook used by the global transcribe language listener.
    // This redraws placement labels only and does not mutate user-entered placement fields.
    try { window.__refreshMccPlacementUiI18n = scheduleMccWindowGridRender; } catch {}

    const _applyGridCellSelection = (row, col) => {
      if (!winRowEl || !winColEl) return;
      winRowEl.value = String(_clampIntWin(row, 1, MCC_GRID_ROWS, 14));
      winColEl.value = String(_clampIntWin(col, 1, MCC_GRID_COLS, 22));

      try { _syncMccWindowAnchorsFromGrid({ normalize: true }); } catch {}
      try { scheduleMccWindowGridRender(); } catch {}
    };

    const _nudgeGridSelection = (dRow, dCol) => {
      const curRow = _clampIntWin(winRowEl?.value, 1, MCC_GRID_ROWS, 14);
      const curCol = _clampIntWin(winColEl?.value, 1, MCC_GRID_COLS, 22);
      _applyGridCellSelection(curRow + Number(dRow || 0), curCol + Number(dCol || 0));
    };

    // Canvas click-to-place.
    try {
      mccGridCanvasEl?.addEventListener('click', (evt) => {
        if (!evt) return;
        const rect = mccGridCanvasEl.getBoundingClientRect();
        const x = Number(evt.clientX) - rect.left;
        const y = Number(evt.clientY) - rect.top;
        if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) return;

        // Map clicks into the CEA-708 safe-title box (inner 80%, 10% margins).
        const safeLeft = rect.width * 0.1;
        const safeTop = rect.height * 0.1;
        const safeW = rect.width * 0.8;
        const safeH = rect.height * 0.8;

        const nx = Math.max(0, Math.min(0.999999, (x - safeLeft) / Math.max(1e-6, safeW)));
        const ny = Math.max(0, Math.min(0.999999, (y - safeTop) / Math.max(1e-6, safeH)));

        const col = Math.max(1, Math.min(MCC_GRID_COLS, Math.floor(nx * MCC_GRID_COLS) + 1));
        const row = Math.max(1, Math.min(MCC_GRID_ROWS, Math.floor(ny * MCC_GRID_ROWS) + 1));
        _applyGridCellSelection(row, col);
      });
    } catch {}

    // Nudge buttons.
    try { mccNudgeUpEl?.addEventListener('click', () => _nudgeGridSelection(-1, 0)); } catch {}
    try { mccNudgeDownEl?.addEventListener('click', () => _nudgeGridSelection(1, 0)); } catch {}
    try { mccNudgeLeftEl?.addEventListener('click', () => _nudgeGridSelection(0, -1)); } catch {}
    try { mccNudgeRightEl?.addEventListener('click', () => _nudgeGridSelection(0, 1)); } catch {}

    // Re-render on size/theme changes.
    try { window.addEventListener('resize', scheduleMccWindowGridRender); } catch {}
    try {
      const mo = new MutationObserver(() => scheduleMccWindowGridRender());
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch {}

    // Re-render when window dimensions policy changes.
    try { document.getElementById('fmt-mcc-max-chars')?.addEventListener('input', scheduleMccWindowGridRender); } catch {}
    try { document.getElementById('fmt-mcc-max-lines')?.addEventListener('input', scheduleMccWindowGridRender); } catch {}
    try { winLinesHeightEl?.addEventListener('input', scheduleMccWindowGridRender); } catch {}
    try { winLinesBottomEl?.addEventListener('input', scheduleMccWindowGridRender); } catch {}
    try { document.getElementById('fmt-mcc-include-608')?.addEventListener('change', scheduleMccWindowGridRender); } catch {}

    const clampWindowPlacement = (opts = {}) => {
      const skipConvert = !!opts.skipConvert;
      const rel = getMccWindowRel();
      setMccWindowRelLs(rel);

      // If the user toggles between relative and absolute, convert the numeric
      // anchors so the window stays in the same *visual* place instead of
      // snapping wildly due to different coordinate ranges.
      try {
        if (_mccWindowRelLast != null && _mccWindowRelLast !== rel && !skipConvert) {
          const vNow = winVEl ? parseInt(String(winVEl.value || ''), 10) : NaN;
          const hNow = winHEl ? parseInt(String(winHEl.value || ''), 10) : NaN;

          if (winVEl && Number.isFinite(vNow)) {
            if (rel) {
              // absolute (0..74) -> relative (0..99)
              const vRel = Math.round((vNow / 74) * 99);
              winVEl.value = String(Math.max(0, Math.min(99, vRel)));
            } else {
              // relative (0..99) -> absolute (0..74)
              const vAbs = Math.round((vNow / 99) * 74);
              winVEl.value = String(Math.max(0, Math.min(74, vAbs)));
            }
          }

          if (winHEl && Number.isFinite(hNow)) {
            if (rel) {
              // absolute (0..209) -> relative (0..99)
              const hRel = Math.round((hNow / 209) * 99);
              winHEl.value = String(Math.max(0, Math.min(99, hRel)));
            } else {
              // relative (0..99) -> absolute (0..209)
              const hAbs = Math.round((hNow / 99) * 209);
              winHEl.value = String(Math.max(0, Math.min(209, hAbs)));
            }
          }
        }
      } catch {
        // ignore
      }

      _mccWindowRelLast = rel;

      if (winVEl) winVEl.max = rel ? 99 : 74;
      if (winHEl) winHEl.max = rel ? 99 : 209;

      // Keep labels/steps aligned with the active coordinate system.
      try { updateMccWindowAnchorCoordUi(); } catch {}

      if (winVEl) {
        const maxV = parseInt(String(winVEl.max || (rel ? 99 : 74)), 10);
        const v = parseInt(String(winVEl.value || ''), 10);
        if (Number.isFinite(v) && Number.isFinite(maxV) && v > maxV) winVEl.value = String(maxV);
      }
      if (winHEl) {
        const maxH = parseInt(String(winHEl.max || (rel ? 99 : 209)), 10);
        const h = parseInt(String(winHEl.value || ''), 10);
        if (Number.isFinite(h) && Number.isFinite(maxH) && h > maxH) winHEl.value = String(maxH);
      }

      // Persist any programmatic conversions/clamps (bindNum only persists on user input).
      try { if (winVEl) localStorage.setItem('mcc-window-anchor-v', String(winVEl.value || '')); } catch {}
      try { if (winHEl) localStorage.setItem('mcc-window-anchor-h', String(winHEl.value || '')); } catch {}

      // Keep the row/col UI in sync with the underlying numeric anchors.
      try { _syncMccWindowGridFromAnchors(); } catch {}

      // Keep "Lines" placement UI in sync with the underlying anchor.
      try { _syncMccWindowLinesHeightFromMaxLines(); } catch {}
      try { _syncMccWindowLinesFromCurrentPlacement(); } catch {}

      // Tell humans what they actually care about (row/col, occupied rows, safe-area mapping).

      // Keep the visual placement widget in sync.
      try { scheduleMccWindowGridRender(); } catch {}
    };

    // One-time migration: if a user ever toggled MCC 708 window placement from
    // relative (%) to absolute (0..209 / 0..74) without converting the numeric
    // anchors, captions can end up hard-left and too low (classic: H=50, V≈90% → clamped).
    // This repairs the common default-ish cases by translating the old % values into the
    // absolute coordinate space.
    try {
      const relRaw = String(localStorage.getItem('mcc-window-rel') || '').trim().toLowerCase();
      const hRaw = String(localStorage.getItem('mcc-window-anchor-h') || '').trim();
      const vRaw = String(localStorage.getItem('mcc-window-anchor-v') || '').trim();
      const didMigrate = String(localStorage.getItem('mcc-window-anchor-migrated-v1') || '').trim() === '1';

      if (!didMigrate && relRaw === 'false' && hRaw === '50') {
        // If V is still 90 (percent) or has been clamped to 74, assume the intent was the
        // default 90% placement.
        const vNum = parseInt(vRaw, 10);
        const vRel = Number.isFinite(vNum) ? vNum : 90;
        if (Number.isFinite(vRel) && vRel >= 0 && vRel <= 99) {
          const hAbs = Math.round((50 / 99) * 209);
          const vAbs = Math.round(((vRaw === '74') ? (90 / 99) : (vRel / 99)) * 74);
          localStorage.setItem('mcc-window-anchor-h', String(hAbs));
          localStorage.setItem('mcc-window-anchor-v', String(Math.max(0, Math.min(74, vAbs))));
          localStorage.setItem('mcc-window-anchor-migrated-v1', '1');
        }
      }
    } catch {
      // ignore
    }

    // One-time migration v2: inverse of v1.
    // If Relative coordinates are ON but the anchors are still in absolute space
    // (most obvious when H>99), the UI clamp will pin the window to the far right.
    // Convert absolute anchors into relative space instead of clamping.
    try {
      const relRaw = String(localStorage.getItem('mcc-window-rel') || '').trim().toLowerCase();
      const hRaw = String(localStorage.getItem('mcc-window-anchor-h') || '').trim();
      const vRaw = String(localStorage.getItem('mcc-window-anchor-v') || '').trim();
      const didMigrate = String(localStorage.getItem('mcc-window-anchor-migrated-v2') || '').trim() === '1';

      const hNum = parseInt(hRaw, 10);
      const vNum = parseInt(vRaw, 10);

      if (!didMigrate && relRaw === 'true' && Number.isFinite(hNum) && hNum > 99) {
        const hAbs = Math.max(0, Math.min(209, hNum));
        const hRel = Math.round((hAbs / 209) * 99);

        let vRel = vNum;
        if (Number.isFinite(vNum) && vNum >= 0 && vNum <= 74) {
          const vAbs = Math.max(0, Math.min(74, vNum));
          vRel = Math.round((vAbs / 74) * 99);
        }

        localStorage.setItem('mcc-window-anchor-h', String(Math.max(0, Math.min(99, hRel))));
        if (Number.isFinite(vRel)) localStorage.setItem('mcc-window-anchor-v', String(Math.max(0, Math.min(99, Math.trunc(vRel)))));
        localStorage.setItem('mcc-window-anchor-migrated-v2', '1');
      }
    } catch {
      // ignore
    }

    bindNum('fmt-mcc-window-anchor-v', 'mcc-window-anchor-v', 90, 0, 99, { integer: true }, clampWindowPlacement);
    bindNum('fmt-mcc-window-anchor-h', 'mcc-window-anchor-h', 50, 0, 209, { integer: true }, clampWindowPlacement);

    // Alt/Option + ↑/↓ = fine step (1 unit). Otherwise, native stepping uses the input's
    // step (which we set to one row/col in updateMccWindowAnchorCoordUi()).
    const onMccWindowAnchorFineStepKeydown = (evt) => {
      try {
        if (!evt || !evt.altKey) return;
        const k = String(evt.key || '');
        if (k !== 'ArrowUp' && k !== 'ArrowDown') return;

        const target = evt.target;
        if (!target || (target !== winVEl && target !== winHEl)) return;

        const rel = getMccWindowRel();
        const max = (target === winVEl) ? (rel ? 99 : 74) : (rel ? 99 : 209);

        const cur = parseInt(String(target.value || ''), 10);
        const curVal = Number.isFinite(cur) ? Math.trunc(cur) : 0;
        const delta = (k === 'ArrowUp') ? 1 : -1;
        const next = Math.max(0, Math.min(max, curVal + delta));

        evt.preventDefault();
        target.value = String(next);

        // Persist + sync derived UI immediately.
        try { localStorage.setItem((target === winVEl) ? 'mcc-window-anchor-v' : 'mcc-window-anchor-h', String(next)); } catch {}
        try { clampWindowPlacement({ skipConvert: true }); } catch {}
      } catch {}
    };
    try { winVEl?.addEventListener('keydown', onMccWindowAnchorFineStepKeydown); } catch {}
    try { winHEl?.addEventListener('keydown', onMccWindowAnchorFineStepKeydown); } catch {}

    clampWindowPlacement();

    // Window position presets (internal helper; the UI dropdown was removed).
    const mccWindowPresetDefs = {
      lower_center_safe: { rel: true, anchorId: '7', anchorV: 90, anchorH: 50, label: 'Lower Center (safe default)' },
      lower_left_safe:   { rel: true, anchorId: '6', anchorV: 90, anchorH: 10, label: 'Lower Left (safe)' },
      lower_right_safe:  { rel: true, anchorId: '8', anchorV: 90, anchorH: 90, label: 'Lower Right (safe)' },
      lower_center_lowest: { rel: true, anchorId: '7', anchorV: 99, anchorH: 50, label: 'Lower Center (lowest)' },
      lower_left_lowest:   { rel: true, anchorId: '6', anchorV: 99, anchorH: 10, label: 'Lower Left (lowest)' },
      lower_right_lowest:  { rel: true, anchorId: '8', anchorV: 99, anchorH: 90, label: 'Lower Right (lowest)' },
      upper_center_safe: { rel: true, anchorId: '1', anchorV: 10, anchorH: 50, label: 'Upper Center (safe)' },
      upper_left_safe:   { rel: true, anchorId: '0', anchorV: 10, anchorH: 10, label: 'Upper Left (safe)' },
      upper_right_safe:  { rel: true, anchorId: '2', anchorV: 10, anchorH: 90, label: 'Upper Right (safe)' },
      middle_left:       { rel: true, anchorId: '3', anchorV: 50, anchorH: 10, label: 'Middle Left' },
      center:            { rel: true, anchorId: '4', anchorV: 50, anchorH: 50, label: 'Center' },
      middle_right:      { rel: true, anchorId: '5', anchorV: 50, anchorH: 90, label: 'Middle Right' }
    };

    const _setLsStr = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };

    // Placement controls are always editable in the simplified MCC UI.
    const enableMccWindowPlacementControls = () => {
      try { if (winRowEl) winRowEl.disabled = false; } catch {}
      try { if (winColEl) winColEl.disabled = false; } catch {}
      try { if (winVEl) winVEl.disabled = false; } catch {}
      try { if (winHEl) winHEl.disabled = false; } catch {}
      try { if (winLinesHeightEl) winLinesHeightEl.disabled = false; } catch {}

      const row = document.getElementById('mcc-window-custom-controls');
      if (row) row.style.opacity = '';
    };

    let _mccApplyingWindowPreset = false;

    const applyMccWindowPreset = (presetKey) => {
      const p = mccWindowPresetDefs[presetKey];
      if (!p) return;

      _mccApplyingWindowPreset = true;
      try {
        // Presets use relative coords (0..99) to keep placement consistent and human-friendly.
        _setLsStr('mcc-window-rel', 'true');

        // Anchor point.
        const anchorIdEl = document.getElementById('fmt-mcc-window-anchor-id');
        if (anchorIdEl) {
          anchorIdEl.value = String(p.anchorId);
        }
        _setLsStr('mcc-window-anchor-id', String(p.anchorId));

        // Anchors in REL space.
        if (winVEl) winVEl.value = String(p.anchorV);
        if (winHEl) winHEl.value = String(p.anchorH);
        _setLsStr('mcc-window-anchor-v', String(p.anchorV));
        _setLsStr('mcc-window-anchor-h', String(p.anchorH));

        // Clamp ranges WITHOUT converting (we already wrote values in the correct space).
        try { clampWindowPlacement({ skipConvert: true }); } catch {}
      } finally {
        _mccApplyingWindowPreset = false;
      }

      try { enableMccWindowPlacementControls(); } catch {}
    };

    // Simplified MCC placement UI: placement is controlled via the visual grid and anchor fields.
    // No Screen position preset dropdown and no Placement mode dropdown.
    try { enableMccWindowPlacementControls(); } catch {}

    // Block height editor (mirrors Max lines per subtitle block).
    const onMccWindowLinesHeightEdit = (evt) => {
      if (_mccWindowSyncingLinesHeight) return;
      if (!winLinesHeightEl || !mccMaxLinesEl) return;

      _mccWindowSyncingLinesHeight = true;
      try {
        const normalize = !!(evt && evt.type === 'change');
        const h = _clampIntWin(winLinesHeightEl.value, 1, 3, 2);
        if (normalize) winLinesHeightEl.value = String(h);

        if (String(mccMaxLinesEl.value || '') !== String(h)) {
          mccMaxLinesEl.value = String(h);
          try { mccMaxLinesEl.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
          try { mccMaxLinesEl.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
        }
      } finally {
        _mccWindowSyncingLinesHeight = false;
      }

      // Sync readouts + visual placement widget.
      try { clampWindowPlacement({ skipConvert: true }); } catch {}
    };

    try { winLinesHeightEl?.addEventListener('input', onMccWindowLinesHeightEdit); } catch {}
    try { winLinesHeightEl?.addEventListener('change', onMccWindowLinesHeightEdit); } catch {}

    // If the user edits Max lines elsewhere, mirror it into the Lines UI.
    try {
      mccMaxLinesEl?.addEventListener('change', () => {
        if (_mccWindowSyncingLinesHeight) return;
        try { _syncMccWindowLinesHeightFromMaxLines(); } catch {}
        try { clampWindowPlacement({ skipConvert: true }); } catch {}
      });
    } catch {}

    const onMccWindowGridEdit = (evt) => {
      if (_mccWindowSyncingGrid) return;
      const normalize = !!(evt && evt.type === 'change');
      try { _syncMccWindowAnchorsFromGrid({ normalize }); } catch {}
    };

    try { winRowEl?.addEventListener('input', onMccWindowGridEdit); } catch {}
    try { winRowEl?.addEventListener('change', onMccWindowGridEdit); } catch {}
    try { winColEl?.addEventListener('input', onMccWindowGridEdit); } catch {}
    try { winColEl?.addEventListener('change', onMccWindowGridEdit); } catch {}



    bindNum('fmt-mcc-qc-max-cps', 'mcc-qc-max-cps', 20, 1, 60);
    bindNum('fmt-mcc-qc-max-wpm', 'mcc-qc-max-wpm', 180, 10, 400, { integer: true });
    bindNum('fmt-mcc-qc-min-duration', 'mcc-qc-min-duration', 0.8, 0, 10);
    bindNum('fmt-mcc-qc-min-gap', 'mcc-qc-min-gap', 0.1, 0, 10);
    const mccExportPolicyOpts = [
      { value: 'warn',       label: tr('transcribe.mcc.exportPolicy.warn') },
      { value: 'gate_write', label: tr('transcribe.mcc.exportPolicy.gateWrite') }
    ];

    // Normalize legacy values: collapse the old "gate_block" policy into Delivery.
    let savedPolicy = (localStorage.getItem('mcc-export-policy') || 'warn').trim() || 'warn';
    savedPolicy = String(savedPolicy || '').trim().toLowerCase();
    if (savedPolicy === 'gate_block') savedPolicy = 'gate_write';
    if (savedPolicy === 'draft') savedPolicy = 'warn';
    if (savedPolicy !== 'warn' && savedPolicy !== 'gate_write') savedPolicy = 'warn';
    try { localStorage.setItem('mcc-export-policy', savedPolicy); } catch {}

    safeSetupDropdown('fmt-mcc-export-policy', mccExportPolicyOpts, savedPolicy);
    bindSelect('fmt-mcc-export-policy', 'mcc-export-policy', savedPolicy);

    // --- Reset to friendly defaults (Phase B) -------
    // This is intentionally NOT "strict" and is aimed at typical NLE ingest.
    const resetMccDefaults = () => {

      // Window placement.
      try { applyMccWindowPreset('lower_center_safe'); } catch {}

      // Helpers that keep UI + localStorage in sync.
      const forceBool = (id, key, val) => {
        const el = document.getElementById(id);
        if (el && typeof el.checked === 'boolean') {
          el.checked = !!val;
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
        try { localStorage.setItem(key, val ? 'true' : 'false'); } catch {}
      };
      const forceNum = (id, key, val) => {
        const el = document.getElementById(id);
        if (el) {
          el.value = String(val);
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
        try { localStorage.setItem(key, String(val)); } catch {}
      };
      const forceText = (id, key, val) => {
        const el = document.getElementById(id);
        if (el) {
          el.value = String(val ?? '');
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
        try { localStorage.setItem(key, String(val ?? '')); } catch {}
      };
      const forceSelect = (id, key, val) => {
        const el = document.getElementById(id);
        if (el) {
          el.value = String(val);
          try { setDropdownValue(id, el.value); } catch {}
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
        try { localStorage.setItem(key, String(val)); } catch {}
      };

      // QC enforcement.

      forceSelect('fmt-mcc-export-policy', 'mcc-export-policy', 'warn');


      // Core defaults (user-tunable checkboxes).
      forceBool('fmt-mcc-include-608', 'mcc-include-608', true);
      forceBool('fmt-mcc-embed-cdp-timecode', 'mcc-embed-cdp-timecode', false);
      forceBool('fmt-mcc-include-ccsvc-info', 'mcc-include-ccsvc-info', true);
      forceBool('fmt-mcc-telestream-compress', 'mcc-telestream-compress', false);

      // Authoring limits: 2 lines, 42 cols, 6 sec.
      forceNum('fmt-mcc-max-chars', 'mcc-max-chars', 42);
      forceNum('fmt-mcc-max-lines', 'mcc-max-lines', 2);
      forceNum('fmt-mcc-max-duration', 'mcc-max-duration', 6.0);

      // Service + language.
      forceNum('fmt-mcc-service-number', 'mcc-service-number', 1);
      forceText('fmt-mcc-language', 'mcc-language', 'eng');

      // Optional FPS override (blank = Auto/detect).
      forceText('fmt-mcc-fps', 'mcc-fps', '');

      // 608 behavior.
      forceSelect('fmt-mcc-overflow-policy', 'mcc-overflow-policy', 'truncate');
      forceBool('fmt-mcc-repeat-control', 'mcc-repeat-control', false);
      forceBool('fmt-mcc-repeat-preamble', 'mcc-repeat-preamble', true);
      forceBool('fmt-mcc-pad-even', 'mcc-pad-even', false);
      forceBool('fmt-mcc-strict-encoding', 'mcc-strict-encoding', false);
      forceNum('fmt-mcc-safe-left', 'mcc-safe-left', 0);
      forceNum('fmt-mcc-safe-right', 'mcc-safe-right', 0);

      // Shaping: off by default (edit-friendly).
      try {
        const shapeEl = document.getElementById('fmt-mcc-shape-mode');
        if (shapeEl) {
          shapeEl.value = 'off';
          try { setDropdownValue('fmt-mcc-shape-mode', 'off'); } catch {}
          try { shapeEl.dispatchEvent(new Event('change')); } catch {}
        }
        try { localStorage.setItem('mcc-shape-enable', 'false'); } catch {}
        try { localStorage.setItem('mcc-shape-mode', 'conservative'); } catch {}
      } catch {}
      forceNum('fmt-mcc-shape-micro-dur', 'mcc-shape-micro-dur', 0.40);
      forceNum('fmt-mcc-shape-micro-gap', 'mcc-shape-micro-gap', 0.12);
      forceNum('fmt-mcc-shape-max-shift', 'mcc-shape-max-shift', 0.25);

      // QC thresholds.
      forceNum('fmt-mcc-qc-max-cps', 'mcc-qc-max-cps', 20);
      forceNum('fmt-mcc-qc-max-wpm', 'mcc-qc-max-wpm', 180);
      forceNum('fmt-mcc-qc-min-duration', 'mcc-qc-min-duration', 0.8);
      forceNum('fmt-mcc-qc-min-gap', 'mcc-qc-min-gap', 0.1);

      // Timing overrides.
      forceText('fmt-mcc-tc-start', 'mcc-tc-start', '');
      forceText('fmt-mcc-timecode-offset', 'mcc-timecode-offset', '');
      forceSelect('fmt-mcc-timecode-offset-policy', 'mcc-timecode-offset-policy', 'clamp');

      // Pop-on behavior.
      forceBool('fmt-mcc-pingpong-windows', 'mcc-pingpong-windows', true);
      // Alignment.
      forceSelect('fmt-mcc-alignment', 'mcc-alignment', 'center');

      // Kick constraints.
      try { applyMccCdpTimecodeFpsConstraint(); } catch {}
    };

    // Expose to the main Transcribe Reset button.
    _resetMccDefaults = resetMccDefaults;

        // Keep MCC CDP timecode fps constraint in sync when fps overrides change.
        try {
          const fpsIds = ['fmt-mcc-fps', 'transcribe-fps', 'fmt-txt-fps'];
          const onFpsChange = () => {
            try { applyMccCdpTimecodeFpsConstraint(); } catch {}
          };
          fpsIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', onFpsChange);
            el.addEventListener('input', onFpsChange);
          });
        } catch {}

        // Apply fps constraint on load.
        try { applyMccCdpTimecodeFpsConstraint(); } catch {}

      }



  function updateDisabledOutputFormats() {
    const engine = document.getElementById('transcribe-engine')?.value;
    const select = document.getElementById('transcribe-output-formats');
    if (!select) return;

    const fps = readNumericFps('fmt-txt-fps', 'transcribe-fps');

    // TXT timecodes are now controlled by Timestamp Placement.
    // (Legacy: #out-timecodes remains in the DOM as an internal fallback.)
    const txtPlacementRaw = String(
      document.getElementById('fmt-txt-timestamp-placement')?.value ??
      ''
    ).trim();
    const tcEnabled = (txtPlacementRaw !== '')
      ? (txtPlacementRaw !== 'none')
      : !!document.getElementById('out-timecodes')?.checked;
    const style =
      document.getElementById('fmt-txt-timecode-format')?.value ||
      document.getElementById('transcribe-timecode-style')?.value ||
      'ndf';
    const dfEnabled = style === 'df';                                                // drop-frame on?
    // Keep SCC Start TC UI aligned with the current DF/NDF selection.
    const sccTcStartEl = document.getElementById('fmt-scc-tc-start');
    if (sccTcStartEl) {
      const tcStyle = (style === 'ndf') ? 'ndf' : 'df';
      sccTcStartEl.placeholder = (tcStyle === 'ndf') ? '01:00:00:00' : '01:00:00;00';
      const raw = String(sccTcStartEl.value || '').trim();
      const norm = _normalizeSmpteLabelForStyle(raw, tcStyle);
      if (norm !== raw) sccTcStartEl.value = norm;
    }
      // SCC timebase is 29.97. DF/NDF is determined by label delimiter (; vs :).
    // We lock SCC to 29.97 and only allow NDF SCC when explicitly enabled.
    const isSccRate = fps == null ? false : (Math.abs(fps - 29.97) < 0.05);
    let allowNdf = false;
    try { allowNdf = (localStorage.getItem('scc-allow-ndf') === 'true'); } catch {}
    // SCC allowed when:
    //  • DF path: timecodes on + DF style + 29.97
    //  • NDF path: timecodes on + NDF style + 29.97 + (feature flag enabled)
    const sccAllowed = !!tcEnabled && isSccRate && (
      dfEnabled ||
      (allowNdf && style === 'ndf')
    );
    select.dataset.sccAllowed = sccAllowed ? 'true' : 'false';

    // Engine-specific disables go here. Keep arrays empty by default;
    // flip them on per engine as needed without touching UI code.
    // Example (disabled): { whisper: ['burnIn'] }
    const impossibleFormats = {
      lead: [],
      whisper: [],
      whisperx: []
    };

    const list = select.closest('.dropdown-wrapper')?.querySelector('.value-list');
    const disableList = impossibleFormats[engine] || [];

    // Styled dropdown: disable via the rendered <li> items (hidden field is not a <select>)
    if (list) {
      [...list.children].forEach(li => {
        const liDisabled = disableList.includes(li.dataset.value);
        if (liDisabled) {
          li.classList.add('disabled');
          li.classList.remove('selected');
        } else {
          li.classList.remove('disabled');
        }
      });
    }

    // Keep current selection unless it's explicitly disabled. Fallback to first enabled <li>.
    if (disableList.includes(select.value)) {
      const fallback = list
        ? ([...list.children].find(li => !li.classList.contains('disabled'))?.dataset.value || 'txt')
        : 'txt';
      setDropdownValue('transcribe-output-formats', fallback);
      select.value = fallback;
    } else {
      setDropdownValue('transcribe-output-formats', select.value || 'txt');
    }

    updateSccUiRows();
  }

  // ===== Format-scoped UI visibility (hard-coded map) =====
  const FORMAT_UI = {
    txt:              { subs:false, review:false },
    tokenAlignedTxt:  { subs:false, review:false },
    script:           { subs:false, review:false },
    srt:              { subs:false, review:true  },
    vtt:              { subs:true,  review:true  },
    scc:              { subs:true,  review:true  },
    mcc:              { subs:true,  review:true  },
    burnIn:           { subs:true,  review:true  },
    json:             { subs:false, review:false },
  };

  function _setDisplay(selector, on, onDisplay = '') {
    document.querySelectorAll(selector).forEach(el => {
      el.style.display = on ? onDisplay : 'none';
    });
  }

  function applyCurrentFormatScope() {
    const select = document.getElementById('transcribe-output-formats');
    const fmt = select?.value || 'txt';
    const cfg = FORMAT_UI[fmt] || {};

    const panelRoot = document.getElementById('transcribe');
    if (panelRoot) {
      panelRoot.dataset.formatScope = fmt;
    }

    _setDisplay('#subtitle-options', !!cfg.subs,   'block');
    _setDisplay('#subtitle-review',  !!cfg.review, 'block');

    updateSccUiRows();
  }

  // Recompute allowed formats and show/hide SCC rows on selection
  // NOTE: we keep only the smart handler below (which also auto-enables SCC prereqs)
  // and remove the bare one that immediately forces a fallback before prereqs are set.

  // Keep UI reactive to settings that affect SCC allowance
  document.getElementById('out-timecodes')?.addEventListener('change', updateDisabledOutputFormats);
  document.getElementById('transcribe-timecode-style')?.addEventListener('change', updateDisabledOutputFormats);
  document.getElementById('transcribe-fps')?.addEventListener('input', updateDisabledOutputFormats);
  document.getElementById('fmt-txt-timecode-format')?.addEventListener('change', updateDisabledOutputFormats);
  document.getElementById('fmt-txt-fps')?.addEventListener('input', updateDisabledOutputFormats);

  // Smart handler: when SCC is chosen, auto-enable prerequisites, then re-evaluate UI.
  document.getElementById('transcribe-output-formats')?.addEventListener('change', () => {
    const select = document.getElementById('transcribe-output-formats');
    const isScc = select?.value === 'scc';

    // Auto-enable prerequisites when SCC is chosen
    if (isScc) {
      syncSccPrereqsFromUi();
    }

    // Show/hide SCC rows (kept from your function)
    updateDisabledOutputFormats();
    applyCurrentFormatScope();
  });

  function initSubtitleOptionsToggle() {
    // Visibility now controlled by applyCurrentFormatScope()
  }

  function initMaxLinesGuardrails() {
    const maxLinesEls = [
      document.getElementById('fmt-vtt-max-lines'),
      document.getElementById('fmt-srt-max-lines')
    ].filter(Boolean);
    if (!maxLinesEls.length) return;

    const apply = () => {
      // 608 compatibility track guardrails:
      //  - 32 columns max (CEA-608)
      //  - 2 lines max for typical pop-on deliverables
      const include608El = getInclude608CompatibilityEl();
      const include608 = include608El?.checked === true;
      // Lead AE policy: never author more than 3 lines per block.
      // If 608 compatibility is enabled, the derived 608 track is still limited to 2.
      const capLines = include608 ? 2 : 3;
      for (const el of maxLinesEls) {
        el.max = String(capLines);
        const v = parseInt(el.value, 10);
        if (Number.isFinite(v) && v > capLines) el.value = String(capLines);
      }
    };

    apply();
    for (const el of maxLinesEls) el.addEventListener('change', apply);
    getInclude608CompatibilityEl()?.addEventListener('change', apply);
  }

  function initTextOptionsToggle() {
    // Visibility now controlled by applyCurrentFormatScope()
  }

  function initFormatLocks() {
    // Legacy global format locks (TXT/XML/SRT/VTT) have been removed.
    // Format-scoped mini-panels now own all option state. This is kept
    // as a no-op so existing initialization calls remain valid.
  }

  function _toggleTimecodeFields() {
    // Global timecode controls are no longer user-facing. Mini-panels own the
    // configuration, so this function remains for backward compatibility only.
  }


  let updateSamplePreview = null;

  function initSamplePreview() {
    const sample = document.getElementById('sample-preview');
    if (!sample) return;

    if (sample.dataset.previewInitBound === '1') {
      scheduleTranscribeJobPreviewUpdate();
      return;
    }
    sample.dataset.previewInitBound = '1';

    const update = async () => {
      const format = document.getElementById('transcribe-output-formats')?.value || '';

      const config = await gatherConfig({ silentDropFrameValidation: true }); // includes legacy txtOptions + new formats.txt

      const baseSegment = [{
        start: 1.0,
        end: 5.0,
        msStart: 1000,
        msEnd: 5000,
        speaker: tr('transcribe.samplePreview.speaker', 'SPEAKER'),
        text: tr('transcribe.samplePreview.text', 'Welcome to Lead AE. How can I Assist?'),
        tokens: []
      }];

      // Prefer the new format-scoped values for preview math
      const txtFmt = (config.formats && config.formats.txt) || {};
      // Base FPS selection for preview
      let fpsForPreview =
        Number(txtFmt.frameRateOverride) ||
        (config.system && Number(config.system.fps)) ||
        30;

      // DF is selected when TXT timecodeFormat is 'df'
      const dropPref = (txtFmt.timecodeFormat === 'df');

      // PREVIEW-ONLY RULE:
      // The Timecode Format dropdown is the *only* authority for DF vs NDF.
      // As soon as the user picks DF, force a canonical 29.97 DF preview,
      // ignoring any frame-rate override or source metadata.
      if (dropPref) {
        fpsForPreview = 29.97;
      }

      // Map TXT timecodeFormat → engine style
      const tcStyleFromTxt =
        (txtFmt.timecodeFormat === 'ms')
          ? 'ms'
          : (txtFmt.timecodeFormat === 'df' ? 'df' : 'colon');

      // Hand the preview a minimal system block so DF renders with semicolons when applicable
      const previewJson = {
        segments: baseSegment,
        system: {
          fps: fpsForPreview,
          dropFramePreferred: dropPref
        }
      };

      const needsEngine = ['txt', 'srt', 'vtt', 'script'].includes(format);
      if (needsEngine && !window.transcribeEngine) {
        sample.textContent = tr('transcribeEngineUnavailablePreview', 'Transcribe engine unavailable. Preview cannot be generated.');
        return;
      }

      sample.setAttribute('aria-busy', 'true');
      sample.textContent = tr('loadingEllipsis', 'Loading…');

      try {
        let output = '';

        if (format === 'txt') {
          // Merge new formats.txt values over legacy txtOptions (legacy stays as a shim)
          const mappedFromFormats = {
            includeSpeakers:   txtFmt.includeSpeakers,
            includeTimecodes:  txtFmt.includeTimecodes,
            timestampStyle:    txtFmt.timestampPlacement,
            speakerStyle:      txtFmt.speakerLabelStyle,
            groupBySpeaker:    txtFmt.groupBySpeaker
          };
          output = window.transcribeEngine.generatePlainText(
            previewJson,
            {
              ...(config.txtOptions || {}),
              ...(mappedFromFormats || {}),
              timecodeStyle: tcStyleFromTxt,
              fps: fpsForPreview
            }
          );
        } else if (format === 'srt') {
          output = await window.transcribeEngine.generateSRT(baseSegment, config);
        } else if (format === 'vtt') {
          output = await window.transcribeEngine.generateVTT(baseSegment, config);
        } else if (format === 'script') {
          // Preview Scripted as CSV.
          const scriptFmt = (config.formats && config.formats.script) || {};
          // decide preview fps/timecode style
          let fpsForPreview =
            Number(scriptFmt.frameRateOverride) ||
            (config.system && Number(config.system.fps)) ||
            30;
          const includeTc = (scriptFmt.includeTimecodes ?? true);
          const dropPreferred = includeTc && (scriptFmt.timecodeFormat === 'df');

          // PREVIEW-ONLY:
          // Scripted preview follows the Scripted Timecode Format dropdown only.
          // DF selection forces 29.97 DF for the sample, regardless of overrides.
          if (dropPreferred) {
            fpsForPreview = 29.97;
          }
          const scriptPreviewOptions = {
            fps: fpsForPreview,
            timecodeFormat:
              scriptFmt.timecodeFormat ||
              config.timecodeStyle ||
              'ndf',
            startTimecodeOffset:
              scriptFmt.startTimecodeOffset ||
              config.startTC ||
              null,
            includeSpeakers:
              scriptFmt.includeSpeakers ?? true,
            includeTimecodes: includeTc,
            groupBySpeaker: !!scriptFmt.groupBySpeaker,
            speakerStyle: scriptFmt.speakerLabelStyle || 'title',
            timestampStyle: scriptFmt.timestampPlacement || 'start-end'
          };

          output = window.transcribeEngine.generateSyncableScriptCSV(
            { segments: baseSegment },
            scriptPreviewOptions
          );
        } else if (format === 'mcc') {
            const svc = (() => {
              const v = parseInt(document.getElementById('fmt-mcc-service-number')?.value, 10);
              const n = Number.isFinite(v) ? Math.trunc(v) : 1;
              return Math.max(1, Math.min(63, n));
            })();
            const lang = (document.getElementById('fmt-mcc-language')?.value || 'eng').trim() || 'eng';
            const include608 = (document.getElementById('fmt-mcc-include-608')?.checked !== false);
            const authoringModel = 'true708';
            const compress = (document.getElementById('fmt-mcc-telestream-compress')?.checked === true);

            let cols = parseInt(document.getElementById('fmt-mcc-max-chars')?.value, 10);
            if (!Number.isFinite(cols)) cols = 42;
            cols = Math.max(1, Math.min(42, Math.trunc(cols)));

            let lines = parseInt(document.getElementById('fmt-mcc-max-lines')?.value, 10);
            if (!Number.isFinite(lines)) lines = 2;
            lines = Math.max(1, Math.min(3, Math.trunc(lines)));

            const startLabel = '00:00:00:00';
            // MCC header "Time Code Rate" uses canonical labels (e.g., 30DF), not raw numeric FPS.
            // Keep preview honest to spec (and aligned with the real encoder).
            const rateStr = (() => {
              // MCC preview respects the per-format FPS override (if provided)
              // instead of the TXT preview rule that forces DF → 29.97.
              const fps = Number((config?.mccOptions && config.mccOptions.fpsOverride) ?? fpsForPreview);
              const df = !!dropPref;
              const near = (a, b, eps) => Math.abs(a - b) <= eps;
              // Common broadcast / delivery rates
              if (near(fps, 23.976, 0.05) || near(fps, 23.98, 0.05) || near(fps, 24, 0.05)) return '24';
              if (near(fps, 25, 0.05)) return '25';
              if (near(fps, 29.97, 0.08) || near(fps, 30, 0.08)) return df ? '30DF' : '30';
              if (near(fps, 50, 0.2)) return '50';
              if (near(fps, 59.94, 0.2) || near(fps, 60, 0.2)) return df ? '60DF' : '60';
              // Preview fallback for odd/unsupported rates.
              return df ? '30DF' : '30';
            })();

            // MCC V2.0 is required for 60DF in common ingest/QC tooling.
            const mccVersion = (rateStr === '60DF') ? 'V2.0' : 'V1.0';
            const samplePayload = compress
              ? 'T 2A S Z Z Z Z Z Z Z Z'
              : '61 01 2A 96 69 00 00 00 00 00 00 00 00';

            output = [
              `File Format=MacCaption_MCC ${mccVersion}`,
              `Time Code Rate=${rateStr}`,
              `Drop Frame=${dropPref ? 'True' : 'False'}`,
              `Caption Service=${svc}`,
              `Language=${lang}`,
              '',
              `${startLabel}\t${samplePayload}  // sample ANC (illustrative only)`,
              `# authoringModel: ${authoringModel} • wrap: ${cols} cols • ${lines} lines • 608 compat: ${include608 ? 'ON' : 'OFF'}`
            ].join('\n');
          } else if (format === 'scc') {
            // SCC preview: show real-looking SCC (pop-on) without invoking the encoder.
            // Keep this static and honest: it's a sample snippet to show the *format* (example uses CC1 control codes).
            output = [
              'Scenarist_SCC V1.0',
              '',
              // CC1 pop-on, 29.97 DF example:
              // RCL (9420), ENM (942e), PAC row 15 indent 0 duplicated (9470 9470),
              // ASCII pairs, then EOC (942f)
              `${_normalizeSmpteLabelForStyle((document.getElementById('fmt-scc-tc-start')?.value?.trim()) || config.startTC || '01:00:00;00', (config.timecodeStyle || 'df'))} 9420 942e 9470 9470 5745 4c43 4f4d 4520 544f 204c 4541 4420 4145 2e20 484f 5720 4341 4e20 4920 4153 5349 5354 3f20 942f`
            ].join('\n');
        } else if (format === 'burnIn') {
          // Burn-in is a rendered video deliverable; there is no meaningful text preview here.
          output = [
            tr('burnIn', 'Burn-in MP4'),
            '',
            tr('burnInPreviewUnavailable', 'No text preview is available for burn-in outputs.'),
            tr('burnInPreviewExportNote', 'Export will render captions onto video during the job run.')
          ].join('\n');
        } else {
          // Restore translated placeholder (avoid clobbering on language change)
          sample.innerHTML = '';
          const span = document.createElement('span');
          span.setAttribute('data-i18n', 'selectFormatPreview');
          span.textContent = tr('selectFormatPreview', 'Select output format to preview');
          sample.appendChild(span);
          return;
        }

        sample.textContent = output.trim();
      } catch (err) {
        panelLog('warn', '⚠️ Sample preview error:', { error: err?.message || err });
        sample.textContent = tr('previewErrorRendering', '[Error rendering preview]');
      } finally {
        sample.setAttribute('aria-busy', 'false');
      }
    };

    updateSamplePreview = update;

    [
      'transcribe-output-formats',
      'out-speaker-names',
      'out-timecodes',
      'txt-timestamp-style',
      'txt-group-by-speaker',
      'transcribe-fps',
      'transcribe-timecode-style',
      // Format-scoped TXT controls
      'fmt-txt-timecode-format',
      'fmt-txt-fps',
      'fmt-txt-tc-start',
      'fmt-txt-timestamp-placement',
      'fmt-txt-group-by-speaker',
      'fmt-txt-include-speaker-names',
      // Format-scoped SRT controls
      'fmt-srt-include-speaker-names',
      'fmt-srt-max-chars',
      'fmt-srt-max-lines',
      'fmt-srt-max-duration',
      'fmt-srt-qc-max-cps',
      'fmt-srt-qc-min-duration',
      'fmt-srt-qc-min-split-duration',
      'fmt-srt-prevent-overlaps',
      'fmt-srt-allow-extension',
      'fmt-srt-max-end-extension',
      'fmt-srt-utf8-bom',
      'fmt-srt-line-ending',
      // Format-scoped VTT controls
      'fmt-vtt-include-speaker-names',
      'fmt-vtt-include-style',
      'fmt-vtt-max-chars',
      'fmt-vtt-max-lines',
      'fmt-vtt-max-duration',
      'fmt-vtt-qc-max-cps',
      'fmt-vtt-qc-min-duration',
      'fmt-vtt-qc-min-split-duration',
      'fmt-vtt-prevent-overlaps',
      'fmt-vtt-allow-extension',
      'fmt-vtt-max-end-extension',
      // SCC mini-panel (refresh preview when user tweaks these)
      'fmt-scc-tc-start',
      'fmt-scc-max-chars',
      'fmt-scc-max-lines',
      'fmt-scc-max-duration',
      'fmt-scc-safe-left',
      'fmt-scc-safe-right',
      'fmt-scc-allow-ndf',
      'fmt-scc-time-source',
      'fmt-scc-start-reset-at',
      'fmt-scc-start-reset-op',
      'fmt-scc-placement-mode',
      'fmt-scc-placement-bottom-row',
      'fmt-scc-placement-left-col',
      'fmt-scc-pad-even',
      'fmt-scc-prefix-words',
      'fmt-scc-repeat-control',
      'fmt-scc-repeat-preamble',
      'fmt-scc-strip-leading-dashes',
      'fmt-scc-qc-max-cps',
      'fmt-scc-qc-max-wpm',
      'fmt-scc-qc-min-duration',
      'fmt-scc-qc-min-gap',
      'fmt-scc-qc-max-late-eoc',
      'fmt-scc-qc-max-late-eoc-count',
      // MCC mini-panel
      'fmt-mcc-max-chars',
      'fmt-mcc-max-lines',
      'fmt-mcc-max-duration',
      'fmt-mcc-include-608',
      'fmt-mcc-telestream-compress',
      'fmt-mcc-embed-cdp-timecode',
      'fmt-mcc-include-ccsvc-info',
      'fmt-mcc-service-number',
      'fmt-mcc-language',
      'fmt-mcc-fps',
      'fmt-mcc-tc-start',
      'fmt-mcc-timecode-offset',
      'fmt-mcc-timecode-offset-policy',
      'fmt-mcc-pingpong-windows',
      'fmt-mcc-alignment',
      'fmt-mcc-window-anchor-id',
      'fmt-mcc-window-anchor-v',
      'fmt-mcc-window-anchor-h',
      'fmt-mcc-export-policy',
      'fmt-mcc-qc-max-cps',
      'fmt-mcc-qc-max-wpm',
      'fmt-mcc-qc-min-duration',
      'fmt-mcc-qc-min-gap',
      // Format-scoped Scripted controls
      'fmt-script-include-speaker-names',
      'fmt-script-group-by-speaker',
      'fmt-script-timestamp-placement',
      'fmt-script-timecode-format',
      'fmt-script-fps',
      'fmt-script-tc-start',
    ].forEach(id => document.getElementById(id)?.addEventListener('change', scheduleTranscribeJobPreviewUpdate));

    if (!window.__LEADAE_TRANSCRIBE_SAMPLE_PREVIEW_I18N_BOUND__) {
      window.__LEADAE_TRANSCRIBE_SAMPLE_PREVIEW_I18N_BOUND__ = true;

      const bindSamplePreviewI18n = () => {
        const i18n = window.i18n;
        if (!i18n?.on) return false;
        try {
          i18n.on('languageChanged', scheduleTranscribeJobPreviewUpdate);
          i18n.on('initialized', scheduleTranscribeJobPreviewUpdate);
        } catch {}
        scheduleTranscribeJobPreviewUpdate();
        return true;
      };

      if (!bindSamplePreviewI18n()) {
        let tries = 0;
        const maxTries = 50;
        const timer = setInterval(() => {
          tries += 1;
          if (bindSamplePreviewI18n() || tries >= maxTries) clearInterval(timer);
        }, 100);
      }
    }

    scheduleTranscribeJobPreviewUpdate();
  }

  let transcribePreviewTimer = null;
  let transcribePreviewInFlight = false;
  let transcribePreviewPending = false;

  function scheduleTranscribeJobPreviewUpdate() {
    try {
      if (transcribePreviewTimer) clearTimeout(transcribePreviewTimer);
      transcribePreviewTimer = setTimeout(() => {
        if (typeof updateSamplePreview === 'function') {
          updateSamplePreview().catch(() => {});
        }
        updateTranscribeJobPreview().catch(() => {});
      }, 120);
    } catch {
      // ignore
    }
  }

  function formatPreviewValue(raw) {
    const s = String(raw ?? '').trim();
    return s ? s : tr('ingestPreviewNotSet', '(not set)');
  }

  function formatFormatLabel(value) {
    const v = String(value ?? '').trim();
    if (!v) return tr('ingestPreviewNotSet', '(not set)');
    try {
      const opt = getTranscribeOutputFormatOptions().find(o => o?.value === v);
      if (opt?.label) return String(opt.label);
    } catch {}
    return v;
  }

  async function updateTranscribeJobPreview() {
    const previewEl = el.summary;
    if (!previewEl) return;

    if (transcribePreviewInFlight) {
      transcribePreviewPending = true;
      return;
    }
    transcribePreviewInFlight = true;
    transcribePreviewPending = false;

    try {
      const cfg = await gatherConfig({ silentDropFrameValidation: true });

      const isWatchMode = !!cfg.watchMode;
      const hasFiles = Array.isArray(cfg.files) && cfg.files.length > 0;
      const watchFolder = String(cfg.watchFolder || '').trim();
      const startupWhisperFeatureState = getStartupWhisperFeatureState();
      const startupWhisperPending = !!startupWhisperFeatureState?.pending;
      const startupWhisperFailed = !!startupWhisperFeatureState?.error && !startupWhisperFeatureState?.ready;

      if (startupWhisperPending || startupWhisperFailed) {
        renderStartupWhisperBootstrapSummary(startupWhisperFeatureState);
        return;
      }

      if (!hasFiles && !watchFolder) {
        writeLogElText(previewEl, '');
        if (previewEl.tagName === 'TEXTAREA') autoResize(previewEl);
        return;
      }

      const onLabel = tr('ingestPreviewOn', 'on');
      const offLabel = tr('ingestPreviewOff', 'off');
      const autoLabel = tr('ingestPreviewAuto', 'Auto');

      const selectedFormat = Object.keys(cfg.outputFormats || {}).find(k => cfg.outputFormats?.[k]) || '';
      const fmtLabel = formatFormatLabel(selectedFormat);
      const engine = formatPreviewValue(cfg.engine);
      const language = formatPreviewValue(cfg.language);
      const accuracy = formatPreviewValue(cfg.accuracyMode);

      const translationOn = !!cfg.translation?.enabled;
      const translationTarget = String(cfg.translation?.target || '').trim();

      const sendToSubtitle = !!cfg.postActions?.sendToSubtitle;
      const n8nOn = !!cfg.enableN8N;
      const n8nUrl = String(cfg.n8nUrl || '').trim();

      const outputPath = String(cfg.outputPath || '').trim();

      const lines = [];
      lines.push(`🧾 ${tr('transcribePreviewTitle', 'Transcribe Job Preview')}`);
      lines.push('──────────────────────────────');

      if (isWatchMode) {
        lines.push(`${tr('watchMode', 'Watch Mode')}: ${watchFolder ? watchFolder : tr('transcribeWatchFolderPlaceholder', 'Select a watch folder')}`);
      } else {
        lines.push(`${tr('transcribeInput', 'Input')}: ${tr('transcribePreviewFiles', '{{count}} file(s)', { count: cfg.files.length })}`);
      }

      lines.push(`${tr('engine', 'Engine')}: ${engine}`);
      lines.push(`${tr('language', 'Language')}: ${language}`);
      lines.push(`${tr('accuracy', 'Accuracy')}: ${accuracy}`);
      lines.push(`${tr('transcribeOutput', 'Output')}: ${fmtLabel}`);
      lines.push(`${tr('transcribeOutputFolder', 'Output folder')}: ${outputPath ? outputPath : tr('transcribeNoDestination', '(not set)')}`);

      const fmtCfg = (cfg.formats && selectedFormat) ? (cfg.formats[selectedFormat] || {}) : {};
      const includeTimecodes = (selectedFormat === 'txt' || selectedFormat === 'script')
        ? (fmtCfg.includeTimecodes !== false)
        : null;

      if (includeTimecodes === false) {
        lines.push(`${tr('includeTimecodes', 'Include Timecodes')}: ${offLabel}`);
      } else if (includeTimecodes === true || selectedFormat === 'scc' || selectedFormat === 'mcc') {
        const tcStyle = String(
          fmtCfg.timecodeFormat || cfg.timecodeStyle || ''
        ).trim();
        const fps = (fmtCfg.frameRateOverride != null)
          ? Number(fmtCfg.frameRateOverride)
          : (cfg.fpsOverride != null ? Number(cfg.fpsOverride) : null);
        const fpsLabel = (Number.isFinite(fps) && fps > 0) ? String(fps) : autoLabel;
        const startTc = String(fmtCfg.startTimecodeOffset || cfg.startTC || '').trim();

        if (tcStyle) lines.push(`${tr('timecodeFormat', 'Timecode Format')}: ${tcStyle}`);
        lines.push(`${tr('fpsOverride', 'Frame Rate Override (FPS)')}: ${fpsLabel}`);
        if (startTc) lines.push(`${tr('startTimecodeOffset', 'Start Timecode Offset')}: ${startTc}`);
      }

      lines.push(`${tr('translate', 'Translate')}: ${translationOn ? onLabel : offLabel}${translationOn && translationTarget ? ` → ${translationTarget}` : ''}`);
      lines.push(`${tr('transcribeSendToSubtitle', 'Send to Subtitle Editor')}: ${sendToSubtitle ? onLabel : offLabel}`);
      lines.push(`${tr('transcribeEnableN8N', 'n8n webhook')}: ${n8nOn ? (n8nUrl ? `${onLabel} → ${n8nUrl}` : onLabel) : offLabel}`);

      const notes = String(cfg.notes || '').trim();
      if (notes) {
        const clipped = notes.length > 180 ? `${notes.slice(0, 180)}…` : notes;
        lines.push(`${tr('notes', 'Notes')}: ${clipped}`);
      }

      writeLogElText(previewEl, lines.join('\n'));
      if (previewEl.tagName === 'TEXTAREA') autoResize(previewEl);
    } catch (err) {
      panelLog('warn', 'Transcribe job preview update failed:', { error: err?.message || err });
    } finally {
      transcribePreviewInFlight = false;
      if (transcribePreviewPending) {
        transcribePreviewPending = false;
        updateTranscribeJobPreview().catch(() => {});
      }
    }
  }

  function bindTranscribeJobPreviewEvents() {
    const panel = document.getElementById('transcribe');
    if (!panel || panel.dataset.previewBound === '1') return;
    panel.dataset.previewBound = '1';

    const ignoredIds = new Set([
      'transcribe-job-preview-box',
      'transcribe-log-output',
      'transcribe-hide-log'
    ]);

    const handler = (e) => {
      const target = e?.target;
      if (!target || !target.id) return;
      if (ignoredIds.has(target.id)) return;
      if (!target.matches?.('input,select,textarea')) return;
      scheduleTranscribeJobPreviewUpdate();
    };

    panel.addEventListener('change', handler, true);
    panel.addEventListener('input', handler, true);
    panel.addEventListener('dropdown:change', handler, true);

    bindTranscribeI18nListenerWithRetry({
      guardKey: '__LEADAE_TRANSCRIBE_PREVIEW_I18N_BOUND__',
      callback: scheduleTranscribeJobPreviewUpdate,
      includeInitialized: true
    });
  }

  if (document.readyState !== 'loading') {
    initSubtitleOptionsToggle();
    initTextOptionsToggle();
    initMaxLinesGuardrails();
    initFormatLocks();
    initSccAdvancedUi();
    initSccPlacementUi();
    initMccUi();
    refreshPresetDropdown().catch(() => {});
    updateDisabledOutputFormats();
    applyCurrentFormatScope();
    initSamplePreview();
    initTranscribeHideLogToggle();
    bindTranscribeJobPreviewEvents();
    updateTranscribeJobPreview().catch(() => {});
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      initSubtitleOptionsToggle();
      initTextOptionsToggle();
      initMaxLinesGuardrails();
      initFormatLocks();
      initSccAdvancedUi();
      initSccPlacementUi();
      initMccUi();
      refreshPresetDropdown().catch(() => {});
      updateDisabledOutputFormats();
      applyCurrentFormatScope();
      initSamplePreview();
      initTranscribeHideLogToggle();
      bindTranscribeJobPreviewEvents();
      updateTranscribeJobPreview().catch(() => {});
    });
  }

  // Cancel starts disabled until a transcription is running
  el.cancelBtn.disabled = true;

  function setTranscribeControlsDisabled(state) {
    transcribeControlsLocked = !!state;
    document.querySelectorAll('#transcribe input,#transcribe select,#transcribe textarea,#transcribe button').forEach(elem => {
      if (elem.id === 'transcribe-watch-mode') return;
      if (elem.id === 'cancel-transcribe') return;
      if (elem.id === 'transcribe-log-output') return;
      if (elem.id === 'transcribe-job-preview-box') return;
      if (elem.id === 'transcribe-hide-log') return;
      elem.disabled = state;
    });
    syncTranscribeStartButtonForBootstrap();
    el.resetBtn.disabled = state;

    if (state) {
      transcribeLockWrapper?.classList.add('locked');
    } else {
      transcribeLockWrapper?.classList.remove('locked');
    }
  }

  if (startupRuntimeAssetBootstrap && typeof startupRuntimeAssetBootstrap.onChange === 'function') {
    startupRuntimeAssetBootstrap.onChange((snapshot) => {
      syncStartupWhisperBootstrapGate(snapshot?.features?.whisper || null);
    });
    document.getElementById('transcribe-engine')?.addEventListener('change', () => {
      syncStartupWhisperBootstrapGate();
    });
    syncStartupWhisperBootstrapGate();
  }
  const FFPROBE_TIMEOUT_MS = 12000;

  function formatFfprobeError(error) {
    if (!error) return tr('transcribeFfprobeNoData', '❌ FFprobe returned no data');
    if (typeof error === 'object') {
      if (error.code === 'FFPROBE_TIMEOUT') {
        return tr('transcribeFfprobeTimedOut', '❌ metadata probe timed out');
      }
      return error.message || JSON.stringify(error);
    }
    return String(error);
  }

  function getFileMetadata(filePath) {
    return window.electron.ffprobeJson(filePath, [], { timeoutMs: FFPROBE_TIMEOUT_MS }).then(data => {
      if (!data) {
        return Promise.reject(tr('transcribeFfprobeNoData', '❌ FFprobe returned no data'));
      }
      if (data.error) {
        return Promise.reject(tr('transcribeFfprobeError', '❌ FFprobe error: {{error}}', { error: formatFfprobeError(data.error) }));
      }
      return data;
    });
  }

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function getTranscribeNotAvailableLabel() {
  return tr('notAvailableShort', tr('notAvailable', 'N/A'));
}

function getTranscribeAudioOnlyLabel() {
  return tr('transcribeFileInfoAudioOnly', 'Audio only');
}

function _parseFrameRate(rFrameRate) {
  if (!rFrameRate || rFrameRate === '0/0') return getTranscribeNotAvailableLabel();
  const [num, denom] = rFrameRate.split('/').map(Number);
  const formattedValue = (num / denom).toFixed(2);
  return trTemplate('transcribeFrameRateValueFps', '{{value}} {{unit}}', {
    value: formattedValue,
    unit: tr('fpsUnit', 'fps')
  });
}

function formatFrameRateForGrid(metadata) {
  if (!metadata || !Array.isArray(metadata.streams)) return getTranscribeNotAvailableLabel();

  const videoStream = metadata.streams.find(s => s.codec_type === 'video');
  if (!videoStream) return getTranscribeNotAvailableLabel();

  const r = videoStream.r_frame_rate || videoStream.avg_frame_rate || '';
  if (!r || r === '0/0') return getTranscribeNotAvailableLabel();

  const parts = r.split('/');
  if (parts.length !== 2) return r;

  const num = Number(parts[0]);
  const den = Number(parts[1]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return r;

  let fps = num / den;

  // Snap to common broadcast rates to avoid ugly 29.970029...
  const snap = (x, target) => Math.abs(x - target) < 0.01;
  if (snap(fps, 23.976)) fps = 23.976;
  else if (snap(fps, 24)) fps = 24;
  else if (snap(fps, 25)) fps = 25;
  else if (snap(fps, 29.97)) fps = 29.97;
  else if (snap(fps, 30)) fps = 30;
  else if (snap(fps, 50)) fps = 50;
  else if (snap(fps, 59.94)) fps = 59.94;
  else if (snap(fps, 60)) fps = 60;

  // Interlaced? (field_order like 'tb', 'bt', etc.)
  const fo = String(videoStream.field_order || '').toLowerCase();
  const isInterlaced = fo && fo !== 'progressive' && fo !== 'unknown';

  // Timecode tag: semicolon = drop-frame
  const tc =
    (videoStream.tags && videoStream.tags.timecode) ||
    (metadata.format && metadata.format.tags && metadata.format.tags.timecode) ||
    '';

  const hasTC = !!tc;
  const isDrop = hasTC && tc.includes(';');

  // If interlaced 29.97, treat as 59.94 fields/s for display
  let displayRate = fps;
  if (isInterlaced && snap(fps, 29.97)) {
    displayRate = fps * 2; // 29.97 frames → 59.94 fields
  }

  const rateStr = displayRate.toFixed(2).replace(/\.00$/, '');
  const tcSuffix = hasTC ? (isDrop ? 'DF' : 'NDF') : 'fps';

  return `${rateStr} ${tcSuffix}`;
}

function extractNumericFpsFromMetadata(metadata) {
  if (!metadata || !Array.isArray(metadata.streams)) return null;

  const videoStream = metadata.streams.find(s => s.codec_type === 'video');
  if (!videoStream) return null;

  const r = videoStream.r_frame_rate || videoStream.avg_frame_rate || '';
  if (!r || r === '0/0') return null;

  let fps = NaN;
  const parts = String(r).split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      fps = num / den;
    }
  } else {
    const n = Number(r);
    if (Number.isFinite(n)) fps = n;
  }

  if (!Number.isFinite(fps) || fps <= 0) return null;

  // Snap to common broadcast rates so we can do stable comparisons.
  const snap = (x, target) => Math.abs(x - target) < 0.01;
  if (snap(fps, 23.976)) fps = 23.976;
  else if (snap(fps, 24)) fps = 24;
  else if (snap(fps, 25)) fps = 25;
  else if (snap(fps, 29.97)) fps = 29.97;
  else if (snap(fps, 30)) fps = 30;
  else if (snap(fps, 50)) fps = 50;
  else if (snap(fps, 59.94)) fps = 59.94;
  else if (snap(fps, 60)) fps = 60;

  return fps;
}

// ─── Container + audio helpers (match other panels) ─────────────────────────
function _normalizeExt(p) {
  const m = /\.([^.]+)$/.exec(String(p || ''));
  return (m && m[1] ? m[1].toLowerCase() : '');
}
function resolveContainerLabel(metadata, filePath) {
  const ext = _normalizeExt(filePath);
  const up = ext ? ext.toUpperCase() : '';
  const reported = (metadata?.format?.format_name || '').toLowerCase();
  if (!reported) return up || getTranscribeNotAvailableLabel();
  const tokens = reported.split(',').map(s => s.trim());
  if (ext && tokens.includes(ext)) return up;
  if (tokens.includes('matroska')) {
    if (ext === 'mkv') return 'MKV';
    if (ext === 'webm') return 'WEBM';
  }
  if (tokens.includes('image2') && up) return up;
  if (tokens.includes('mov') && ext === 'mp4') return 'MP4';
  if (tokens.includes('mp4') && ext === 'mov') return 'MOV';
  return (tokens[0] || up || getTranscribeNotAvailableLabel()).toUpperCase();
}
function summarizeAudioStreams(streams = []) {
  const aud = streams.filter(s => s.codec_type === 'audio');
  if (!aud.length) return { codec: getTranscribeNotAvailableLabel(), label: '', tracks: 0 };
  const codecs = [...new Set(aud.map(s => String(s.codec_name || '').toUpperCase()))];
  const codec = codecs.length === 1 ? codecs[0] : codecs.join('+');
  const total = aud.reduce((sum, s) => sum + (s.channels || 0), 0);
  const allMono = aud.every(s => (s.channels || 0) === 1);
  let label = '';
  if (total === 1) label = tr('transcribeAudioMono', 'Mono');
  else if (total === 2) label = tr('transcribeAudioStereo', 'Stereo');
  else {
    const multiMono = allMono ? tr('transcribeAudioMultiMonoSuffix', ' (multi-mono)') : '';
    label = trTemplate('transcribeAudioChannelsLabel', '{{count}}ch{{multiMono}}', {
      count: total,
      multiMono
    });
  }
  return { codec, label, tracks: aud.length };
}

async function _summarizeTranscribeFile(filePath) {
  const name =
    (window.electron?.basename && window.electron.basename(filePath)) ||
    (filePath.split(/[\\/]/).pop());

  try {
    const md = await getFileMetadata(filePath);
    const container = resolveContainerLabel(md, filePath);
    const v = (md.streams || []).find(s => s.codec_type === 'video');
    const audioInfo = summarizeAudioStreams(md.streams || []);

    const res = v
      ? `${v.width}×${v.height}`
      : (audioInfo.tracks > 0 ? getTranscribeAudioOnlyLabel() : getTranscribeNotAvailableLabel());
    const fps = formatFrameRateForGrid(md);
    const dur = formatDuration(+md.format?.duration || 0);

    const vc = v?.codec_name ? v.codec_name.toUpperCase() : '';

    const line1 = `🎧 ${name}`;
    const line2 = `  ${container}  ${res}${fps ? `  ${fps}` : ''}`;
    const line3 = `  ${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}${vc ? ` • 🎬 ${vc}` : ''} • ${dur}`;
    return [line1, line2, line3].join('\n');
  } catch (err) {
    return tr('transcribeFormatLineError', '❌ {{name}} — {{error}}', { name, error: String(err) });
  }
}

function isSupportedDropFrameRate(fps) {
  const f = Number(fps);
  const dfRates = [29.97, 59.94, 119.88];
  return dfRates.some(r => Math.abs(f - r) < 0.02);
}

async function _updateFileInfoDisplay(filePath) {
  const infoBox = prepareFileInfoGrid('transcribe');
  if (!infoBox) return;

  try {
    const metadata = await getFileMetadata(filePath);
    const container = resolveContainerLabel(metadata, filePath);
    const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioInfo = summarizeAudioStreams(streams);

    const duration = formatDuration(+metadata.format?.duration || 0);
    const resolution = videoStream
      ? `${videoStream.width}×${videoStream.height}`
      : (audioInfo.tracks > 0 ? getTranscribeAudioOnlyLabel() : getTranscribeNotAvailableLabel());
    const frameRate = formatFrameRateForGrid(metadata);

    const audioCell = `${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}`;
    appendFileInfoRow(infoBox, [
      makeFileInfoCell(window.electron.basename(filePath)),
      makeFileInfoCell(container || getTranscribeNotAvailableLabel()),
      makeFileInfoCell(resolution),
      makeFileInfoCell(frameRate),
      makeFileInfoCell(audioCell),
      makeFileInfoCell(duration)
    ]);
  } catch (err) {
    appendFileInfoRow(infoBox, [
      makeFileInfoCell(window.electron.basename(filePath)),
      makeFileInfoCell(tr('transcribeFileInfoErrorCell', '❌ {{error}}', { error: String(err) }), { gridColumn: 'span 5' })
    ]);
  }

  setupResizableGrid(infoBox, 'gridCols-transcribe');
}

function reapplyTranscribeFileInfoRows() {
  const filesInput = document.getElementById('transcribe-files');
  const files = String(filesInput?.value || '')
    .split(/\r?\n/)
    .map(v => v.trim())
    .filter(Boolean);

  if (!files.length) return;

  const grid = prepareFileInfoGrid('transcribe');
  if (!grid) return;

  const missingMetaLabel = tr('transcribeFileInfoMetadataMissingCell', '⚠️ Metadata unavailable');

  files.forEach((filePath) => {
    const fileName =
      (window.electron?.basename && window.electron.basename(filePath)) ||
      (filePath.split(/[\\/]/).pop()) ||
      filePath;
    const metadata = transcribeFileMetaCache.get(filePath);

    if (!metadata) {
      appendFileInfoRow(grid, [
        makeFileInfoCell(fileName),
        makeFileInfoCell(missingMetaLabel, { gridColumn: 'span 5', title: getTranscribeNotAvailableLabel() })
      ]);
      return;
    }

    const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
    const container = resolveContainerLabel(metadata, filePath);
    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioInfo = summarizeAudioStreams(streams);

    const resolution = videoStream
      ? `${videoStream.width}×${videoStream.height}`
      : (audioInfo.tracks > 0 ? getTranscribeAudioOnlyLabel() : getTranscribeNotAvailableLabel());
    const frameRate = formatFrameRateForGrid(metadata);
    const duration = formatDuration(+metadata.format?.duration || 0);
    const audioCell = `${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}`;

    appendFileInfoRow(grid, [
      makeFileInfoCell(fileName),
      makeFileInfoCell(container || getTranscribeNotAvailableLabel()),
      makeFileInfoCell(resolution),
      makeFileInfoCell(frameRate),
      makeFileInfoCell(audioCell),
      makeFileInfoCell(duration)
    ]);
  });

  setupResizableGrid(grid, 'gridCols-transcribe');
}

function isPrivateAddress(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
  if (host.endsWith('.local')) return true;

  const octets = host.split('.');
  if (octets.length === 4 && octets.every(p => /^\d+$/.test(p))) {
    const [a, b] = octets.map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  const normalizedV6 = host.split('%')[0];
  if (normalizedV6.includes(':')) {
    if (normalizedV6 === '::1') return true;
    if (normalizedV6.startsWith('fc') || normalizedV6.startsWith('fd')) return true;
    if (normalizedV6.startsWith('fe80')) return true;
  }

  return false;
}

function validateN8nUrl(n8nUrl, opts = {}) {
  const allowPrivate = !!opts?.allowPrivate;
  const trimmed = (n8nUrl || '').trim();
  if (!trimmed) {
    return { valid: false, message: tr('transcribeN8nUrlRequiredError', '❌ Please provide an n8n URL when webhook logging is enabled.') };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, message: tr('transcribeN8nUrlInvalidError', '❌ Invalid n8n URL. Please use a full http/https address.') };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, message: tr('transcribeN8nUrlProtocolError', '❌ n8n URL must start with http:// or https://.') };
  }

  const hostname = String(parsed.hostname || '').trim().toLowerCase();
  if (!hostname) {
    return { valid: false, message: tr('transcribeN8nUrlHostnameError', '❌ Invalid n8n URL. Please include a hostname.') };
  }

  if (!allowPrivate && isPrivateAddress(hostname)) {
    return {
      valid: false,
      message: tr('transcribeN8nUrlPrivateTargetError', '❌ n8n URL cannot target localhost or private networks unless private targets are explicitly allowed.')
    };
  }

  return { valid: true, url: trimmed };
}

  async function gatherConfig(options = {}) {
    const { silentDropFrameValidation = false } = options || {};
    const rawFmt = String(document.getElementById('transcribe-output-formats')?.value || '').trim();
    const selectedFormat = rawFmt ? rawFmt.replace(/^\./, '') : '';
    const outputFormats = {
      txt: false,
      srt: false,
      vtt: false,
      scc: false,
      mcc: false,
      script: false,
      burnIn: false
    };
    if (selectedFormat && Object.prototype.hasOwnProperty.call(outputFormats, selectedFormat)) {
      outputFormats[selectedFormat] = true;
    }
    // Optional debug to surface what will actually be written
    panelLog('info', 'Output format selection:', { outputFormats });

    // Prefer TXT-scoped speaker toggle if present; fall back to global.
    // NOTE: This is *format scoped* and should not be treated as a global diarization switch.
    const includeSpeakersTxt =
      (document.getElementById('fmt-txt-include-speaker-names')?.checked) ??
      (document.getElementById('out-speaker-names')?.checked);

    // SECURITY: do not pull secret values into the renderer.
    // The main process loads the API key from secure storage when needed.

    const sccAlignment = document.getElementById('scc-alignment')?.value || 'center';
    // Caption service (CC1–CC4). Stored as '1'..'4' in localStorage, but we also accept 'CC1' etc
    // for backward compatibility / hand-edited configs.
    const sccChannel = (() => {
      const raw =
        document.getElementById('scc-channel')?.value
        || (() => { try { return localStorage.getItem('scc-channel') || ''; } catch { return ''; } })()
        || '1';
      return normalizeSccChannel(raw);
    })();
    const sccRowPolicy = 'bottom2';
    const sccMode = 'pop-on';
    // Timing anchor: ui control (fmt-scc-time-source) + legacy localStorage fallback.
    let sccTimeSource = String(document.getElementById('fmt-scc-time-source')?.value || '').trim();
    if (!sccTimeSource) {
      try { sccTimeSource = localStorage.getItem('scc-time-source') || ''; } catch {}
    }
    if (!sccTimeSource) sccTimeSource = 'auto';

    const globalTimecodeStyle = document.getElementById('transcribe-timecode-style')?.value || 'ndf';
    const include608Compatibility = isInclude608CompatibilityEnabled();
    const globalFpsValue = (() => {
      const raw = document.getElementById('transcribe-fps')?.value ?? '';
      const parsed = parseFloat(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })();
    const globalStartTc = document.getElementById('transcribe-tc-start')?.value?.trim() || null;
    const sccStartTc = document.getElementById('fmt-scc-tc-start')?.value?.trim() || null;

    // TXT: Timestamp Placement is the source of truth for whether timecodes are included.
    const txtTimestampPlacementUi = String(
      (document.getElementById('fmt-txt-timestamp-placement')?.value) ?? 'none'
    ).trim() || 'none';
    const txtTimestampPlacement = txtTimestampPlacementUi.replace(/_/g, '-');
    const txtIncludeTimecodes = (txtTimestampPlacementUi !== 'none');

    const txtFormat = {
      includeTimecodes: txtIncludeTimecodes,
      includeSpeakers: includeSpeakersTxt,
      groupBySpeaker:
        (document.getElementById('fmt-txt-group-by-speaker')?.checked),
      timestampPlacement: txtTimestampPlacement,
      speakerLabelStyle: 'title',
      timecodeFormat:
        (document.getElementById('fmt-txt-timecode-format')?.value) ??
        (document.getElementById('transcribe-timecode-style')?.value) ??
        'ndf',
      dropFrame: (() => {
        const fmtStyle = document.getElementById('fmt-txt-timecode-format')?.value;
        if (fmtStyle) return fmtStyle === 'df';
        const global = document.getElementById('transcribe-timecode-style')?.value;
        return global === 'df';
      })(),
      frameRateOverride: (function(){
        if (!txtIncludeTimecodes) return null;
        return readNumericFps('fmt-txt-fps', 'transcribe-fps');
      })(),
      startTimecodeOffset:
        txtIncludeTimecodes
          ? (
            (document.getElementById('fmt-txt-tc-start')?.value?.trim()) ??
            (document.getElementById('transcribe-tc-start')?.value?.trim()) ??
            null
          )
          : null
    };



    // Scripted: Timestamp Placement is the source of truth for whether timecodes are included.
    const scriptTimestampPlacementUi = String(
      (document.getElementById('fmt-script-timestamp-placement')?.value) ?? 'none'
    ).trim() || 'none';
    const scriptTimestampPlacement = scriptTimestampPlacementUi.replace(/_/g, '-');
    const scriptIncludeTimecodes = (scriptTimestampPlacementUi !== 'none');

    const scriptFormat = {
      exportFormat: 'csv',
      includeSpeakers:
        (document.getElementById('fmt-script-include-speaker-names')?.checked) ??
        includeSpeakersTxt,
      groupBySpeaker:
        (document.getElementById('fmt-script-group-by-speaker')?.checked) ?? false,
      speakerLabelStyle: 'title',
      timestampPlacement: scriptTimestampPlacement,
      includeTimecodes: scriptIncludeTimecodes,
      timecodeFormat:
        (document.getElementById('fmt-script-timecode-format')?.value) ?? 'ndf',
      frameRateOverride: (function(){
        if (!scriptIncludeTimecodes) return null;
        const raw =
          (document.getElementById('fmt-script-fps')?.value) ?? '';
        const v = parseFloat(raw);
        return Number.isFinite(v) && v > 0 ? v : null;
      })(),
      startTimecodeOffset:
        scriptIncludeTimecodes
          ? ((document.getElementById('fmt-script-tc-start')?.value?.trim()) ?? null)
          : null
    };

    const srtFormat = {
      includeSpeakers:
        (document.getElementById('fmt-srt-include-speaker-names')?.checked) ??
        includeSpeakersTxt,
      speakerLabelStyle: 'title',

      // Shaping (format-specific)
      maxCharsPerLine: (() => {
        const raw = document.getElementById('fmt-srt-max-chars')?.value;
        const v = parseInt(String(raw ?? '').trim(), 10);
        return Number.isFinite(v) ? Math.max(1, Math.min(200, Math.trunc(v))) : 42;
      })(),
      maxLinesPerBlock: (() => {
        const raw = document.getElementById('fmt-srt-max-lines')?.value;
        const v = parseInt(String(raw ?? '').trim(), 10);
        const n = Number.isFinite(v) ? Math.trunc(v) : 2;
        // Lead AE policy: never author more than 3 lines per block (UI guardrails also enforce this).
        return Math.max(1, Math.min(3, n));
      })(),
      maxDurationSeconds: (() => {
        const raw = document.getElementById('fmt-srt-max-duration')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        const n = Number.isFinite(v) ? v : 6.0;
        return Math.max(0.1, Math.min(60, n));
      })(),
      // Advanced QC controls
      maxCps: (() => {
        const raw = document.getElementById('fmt-srt-qc-max-cps')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        return Number.isFinite(v) ? v : undefined;
      })(),
      minDurationSeconds: (() => {
        const raw = document.getElementById('fmt-srt-qc-min-duration')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        return Number.isFinite(v) ? v : undefined;
      })(),
      minSplitDurationSeconds: (() => {
        const raw = document.getElementById('fmt-srt-qc-min-split-duration')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        return Number.isFinite(v) ? v : undefined;
      })(),
      preventOverlaps:
        (document.getElementById('fmt-srt-prevent-overlaps')?.checked) ?? true,
      allowTimeExtension:
        (document.getElementById('fmt-srt-allow-extension')?.checked) ?? true,
      maxEndExtensionSeconds: (() => {
        const raw = document.getElementById('fmt-srt-max-end-extension')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        return Number.isFinite(v) ? v : undefined;
      })(),

      // Output hygiene
      utf8Bom:
        (document.getElementById('fmt-srt-utf8-bom')?.checked) ?? false,
      lineEnding:
        (document.getElementById('fmt-srt-line-ending')?.value) ?? 'lf'
    };

    const vttFormat = {
      includeSpeakers:
        (document.getElementById('fmt-vtt-include-speaker-names')?.checked) ??
        includeSpeakersTxt,
      speakerLabelStyle: 'title',
      includeStyleMetadata:
        (document.getElementById('fmt-vtt-include-style')?.checked) ??
        (document.getElementById('sub-include-style')?.checked)
      ,

      // Shaping (format-specific)
      maxCharsPerLine: (() => {
        const raw = document.getElementById('fmt-vtt-max-chars')?.value;
        const v = parseInt(String(raw ?? '').trim(), 10);
        return Number.isFinite(v) ? Math.max(1, Math.min(200, Math.trunc(v))) : 42;
      })(),
      maxLinesPerBlock: (() => {
        const raw = document.getElementById('fmt-vtt-max-lines')?.value;
        const v = parseInt(String(raw ?? '').trim(), 10);
        const n = Number.isFinite(v) ? Math.trunc(v) : 2;
        return Math.max(1, Math.min(3, n));
      })(),
      maxDurationSeconds: (() => {
        const raw = document.getElementById('fmt-vtt-max-duration')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        const n = Number.isFinite(v) ? v : 6.0;
        return Math.max(0.1, Math.min(60, n));
      })(),
      // Advanced QC controls
      maxCps: (() => {
        const raw = document.getElementById('fmt-vtt-qc-max-cps')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        return Number.isFinite(v) ? v : undefined;
      })(),
      minDurationSeconds: (() => {
        const raw = document.getElementById('fmt-vtt-qc-min-duration')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        return Number.isFinite(v) ? v : undefined;
      })(),
      minSplitDurationSeconds: (() => {
        const raw = document.getElementById('fmt-vtt-qc-min-split-duration')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        return Number.isFinite(v) ? v : undefined;
      })(),
      preventOverlaps:
        (document.getElementById('fmt-vtt-prevent-overlaps')?.checked) ?? false,
      allowTimeExtension:
        (document.getElementById('fmt-vtt-allow-extension')?.checked) ?? true,
      maxEndExtensionSeconds: (() => {
        const raw = document.getElementById('fmt-vtt-max-end-extension')?.value;
        const v = parseFloat(String(raw ?? '').trim());
        return Number.isFinite(v) ? v : undefined;
      })()
    };

    const formats = {
      txt: txtFormat,
      script: scriptFormat,
      srt: srtFormat,
      vtt: vttFormat
    };

    // Global diarization should reflect *any* chosen deliverable's need for
    // speaker labels, not just the TXT mini-panel.
    const wantsSpeakers = !!(
      txtFormat?.includeSpeakers ||
      scriptFormat?.includeSpeakers ||
      srtFormat?.includeSpeakers ||
      vttFormat?.includeSpeakers
    );

    const scriptOptions = {
      timestampStyle: scriptFormat.timestampPlacement,
      speakerStyle: scriptFormat.speakerLabelStyle,
      groupBySpeaker: scriptFormat.groupBySpeaker,
      exportFormat: scriptFormat.exportFormat
    };

    let derivedTimecodeFormat = txtFormat.timecodeFormat || globalTimecodeStyle || 'ndf';
    let derivedDropFrame =
      typeof txtFormat.dropFrame === 'boolean'
        ? txtFormat.dropFrame
        : (derivedTimecodeFormat === 'df');
    const derivedFpsOverride =
      (txtFormat.frameRateOverride != null)
        ? txtFormat.frameRateOverride
        : globalFpsValue;
    let dropFrameValidation = null;

    // Guard against DF selection at unsupported frame rates (UI + presets).
    if (derivedTimecodeFormat === 'df' && derivedDropFrame) {
      const resolvedFps = Number.isFinite(derivedFpsOverride) ? derivedFpsOverride : null;
      if (resolvedFps != null && !isSupportedDropFrameRate(resolvedFps)) {
        const message = getDropFrameUnsupportedFpsMessage(resolvedFps);
        derivedTimecodeFormat = 'ndf';
        derivedDropFrame = false;
        formats.txt.timecodeFormat = 'ndf';
        formats.txt.dropFrame = false;
        dropFrameValidation = {
          message,
          resolvedFps,
          coercedToNdf: true
        };
        if (!silentDropFrameValidation) {
          panelLog('warn', message, { resolvedFps });
        }
      }
    }

    // SCC needs an always-available Start TC control because the TXT mini-panel
    // may be hidden when SCC is the active output format.
    const derivedStartTcRaw = (outputFormats.scc === true)
      ? (sccStartTc || txtFormat.startTimecodeOffset || globalStartTc)
      : (txtFormat.startTimecodeOffset || globalStartTc);

    const derivedStartTc = (outputFormats.scc === true && derivedStartTcRaw)
      ? _normalizeSmpteLabelForStyle(derivedStartTcRaw, derivedTimecodeFormat)
      : derivedStartTcRaw;

    const txtOptions = {
      includeSpeakers: txtFormat.includeSpeakers,
      includeTimecodes: txtFormat.includeTimecodes,
      timestampStyle: txtFormat.timestampPlacement,
      speakerStyle: txtFormat.speakerLabelStyle,
      groupBySpeaker: txtFormat.groupBySpeaker,
      frameRateOverride: txtFormat.frameRateOverride,
      startTimecodeOffset: derivedStartTc
    };

    // Phase 5: Prefer shared QC & Delivery prefs/builders so exports behave consistently
    // across Transcribe and the Subtitle Editor.
    const qcApi = window.qcDeliveryPrefs;

    const mccOptions = (() => {
      const readNum = (elId, lsKey, fallback, { integer = false } = {}) => {
        const rawEl = document.getElementById(elId)?.value;
        if (rawEl != null && String(rawEl).trim() !== '') {
          const v = integer ? parseInt(rawEl, 10) : parseFloat(rawEl);
          if (Number.isFinite(v)) return v;
        }
        try {
          const raw = localStorage.getItem(lsKey);
          if (raw != null && String(raw).trim() !== '') {
            const v = integer ? parseInt(raw, 10) : parseFloat(raw);
            if (Number.isFinite(v)) return v;
          }
        } catch {}
        return fallback;
      };

      const readBool = (elId, lsKey, fallback) => {
        const el = document.getElementById(elId);
        if (el && typeof el.checked === 'boolean') return !!el.checked;
        try {
          const raw = localStorage.getItem(lsKey);
          if (raw == null || raw === '') return !!fallback;
          return raw === 'true';
        } catch {
          return !!fallback;
        }
      };

      const readText = (elId, lsKey, fallback) => {
        const rawEl = document.getElementById(elId)?.value;
        if (typeof rawEl === 'string' && rawEl.trim()) return rawEl.trim();
        try {
          const raw = localStorage.getItem(lsKey);
          if (raw != null && String(raw).trim()) return String(raw).trim();
        } catch {}
        return fallback;
      };

      const readDropdown = (elId, lsKey, fallback) => {
        const rawEl = document.getElementById(elId)?.value;
        if (typeof rawEl === 'string' && rawEl.trim()) return rawEl.trim();
        try {
          const raw = localStorage.getItem(lsKey);
          if (raw != null && String(raw).trim()) return String(raw).trim();
        } catch {}
        return fallback;
      };

      const readInt = (elId, lsKey, fallback, min, max) => {
        const clamp = (n) => Math.max(min, Math.min(max, n));
        const fromEl = document.getElementById(elId)?.value;
        const n1 = parseInt(fromEl ?? '', 10);
        if (Number.isFinite(n1)) return clamp(n1);

        try {
          const raw = localStorage.getItem(lsKey);
          const n2 = parseInt(raw ?? '', 10);
          if (Number.isFinite(n2)) return clamp(n2);
        } catch {}

        return clamp(fallback);
      };

      const readFloat = (elId, lsKey, fallback, min, max) => {
        const clamp = (n) => Math.max(min, Math.min(max, n));
        const fromEl = document.getElementById(elId)?.value;
        const n1 = Number(fromEl);
        if (Number.isFinite(n1)) return clamp(n1);

        try {
          const raw = localStorage.getItem(lsKey);
          const n2 = Number(raw);
          if (Number.isFinite(n2)) return clamp(n2);
        } catch {}

        return clamp(fallback);
      };

      const include608Compatibility = readBool('fmt-mcc-include-608', 'mcc-include-608', true);
      const includeCdpTimecode = readBool('fmt-mcc-embed-cdp-timecode', 'mcc-embed-cdp-timecode', false);
      const includeCcsSvcInfo = readBool('fmt-mcc-include-ccsvc-info', 'mcc-include-ccsvc-info', true);

      // MCC authoring model: affects whether 708 authoring constraints are clamped
      // when 608 compatibility is enabled.
      let authoringModel = 'true708';

      const safeMargins = {
        left: readInt('fmt-mcc-safe-left', 'mcc-safe-left', 0, 0, 15),
        right: readInt('fmt-mcc-safe-right', 'mcc-safe-right', 0, 0, 15)
      };

      const overflowPolicy = (() => {
        const v = String(readDropdown('fmt-mcc-overflow-policy', 'mcc-overflow-policy', '')).trim().toLowerCase();
        return (v === 'truncate' || v === 'error') ? v : '';
      })();

      const strictCharacterEncoding = readBool('fmt-mcc-strict-encoding', 'mcc-strict-encoding', false);
      const padEven = readBool('fmt-mcc-pad-even', 'mcc-pad-even', false);
      const repeatControlCodes = readBool('fmt-mcc-repeat-control', 'mcc-repeat-control', false);
      const repeatPreambleCodes = readBool('fmt-mcc-repeat-preamble', 'mcc-repeat-preamble', true);

      const shaping = (() => {
        const ui = String(readDropdown('fmt-mcc-shape-mode', 'mcc-shape-mode', 'off')).trim().toLowerCase() || 'off';
        const enabled = ui !== 'off';
        const mode = enabled ? ui : (() => {
          try { return String(localStorage.getItem('mcc-shape-mode') || 'conservative').trim().toLowerCase() || 'conservative'; }
          catch { return 'conservative'; }
        })();

        return {
          enabled,
          mode,
          microCueSec: readFloat('fmt-mcc-shape-micro-dur', 'mcc-shape-micro-dur', 0.40, 0, 2),
          microGapSec: readFloat('fmt-mcc-shape-micro-gap', 'mcc-shape-micro-gap', 0.12, 0, 2),
          maxShiftSec: readFloat('fmt-mcc-shape-max-shift', 'mcc-shape-max-shift', 0.25, 0, 5)
        };
      })();

      let alignment = readDropdown('fmt-mcc-alignment', 'mcc-alignment', 'left');
      alignment = String(alignment || 'left').trim().toLowerCase();
      if (!['left', 'center', 'right'].includes(alignment)) alignment = 'left';
      const pingPongWindows = readBool('fmt-mcc-pingpong-windows', 'mcc-pingpong-windows', true);

      let startTcOverride = readText('fmt-mcc-tc-start', 'mcc-tc-start', '');
      startTcOverride = String(startTcOverride || '').trim();
      if (!startTcOverride) startTcOverride = null;

      let timecodeOffset = readText('fmt-mcc-timecode-offset', 'mcc-timecode-offset', '');
      timecodeOffset = String(timecodeOffset || '').trim();
      if (!timecodeOffset) timecodeOffset = null;

      let timecodeOffsetPolicy = readDropdown('fmt-mcc-timecode-offset-policy', 'mcc-timecode-offset-policy', 'clamp');
      timecodeOffsetPolicy = String(timecodeOffsetPolicy || '').trim().toLowerCase();
      if (!['clamp', 'error'].includes(timecodeOffsetPolicy)) timecodeOffsetPolicy = 'clamp';

      // 708 window placement
      // Source of truth: localStorage('mcc-window-rel') as set by the placement UI.
      // (The old Screen position preset dropdown was removed for MCC.)
      const winRel = (() => {
        try {
          const raw = localStorage.getItem('mcc-window-rel');
          if (raw != null && String(raw).trim() !== '') return raw === 'true';
        } catch {}
        return true;
      })();
      let anchorId = parseInt(readDropdown('fmt-mcc-window-anchor-id', 'mcc-window-anchor-id', '7'), 10);
      if (!Number.isFinite(anchorId)) anchorId = 7;
      anchorId = Math.max(0, Math.min(8, Math.trunc(anchorId)));

      let anchorV = readNum('fmt-mcc-window-anchor-v', 'mcc-window-anchor-v', 90, { integer: true });
      let anchorH = readNum('fmt-mcc-window-anchor-h', 'mcc-window-anchor-h', 50, { integer: true });
      const maxV = winRel ? 99 : 74;
      const maxH = winRel ? 99 : 209;
      anchorV = Math.max(0, Math.min(maxV, Math.trunc(anchorV)));
      anchorH = Math.max(0, Math.min(maxH, Math.trunc(anchorH)));

      const mcc708Window = { rel: winRel, anchorId, anchorV, anchorH };

      let maxCharsPerLine = readNum(
        'fmt-mcc-max-chars',
        'mcc-max-chars',
        42,
        { integer: true }
      );
      maxCharsPerLine = Math.max(1, Math.min(42, Math.trunc(maxCharsPerLine)));

      let maxLinesPerBlock = readNum('fmt-mcc-max-lines', 'mcc-max-lines', 2, { integer: true });
      maxLinesPerBlock = Math.max(1, Math.min(3, Math.trunc(maxLinesPerBlock)));

      let maxDurationSeconds = readNum('fmt-mcc-max-duration', 'mcc-max-duration', 6.0);
      maxDurationSeconds = Number.isFinite(maxDurationSeconds) ? Math.max(0.1, maxDurationSeconds) : 6.0;

      const telestreamCompression = readBool('fmt-mcc-telestream-compress', 'mcc-telestream-compress', false);

      let serviceNumber = readNum('fmt-mcc-service-number', 'mcc-service-number', 1, { integer: true });
      serviceNumber = Math.max(1, Math.min(63, Math.trunc(serviceNumber)));

      let language = readText('fmt-mcc-language', 'mcc-language', 'eng');
      language = String(language || 'eng').trim().toLowerCase();
      if (!/^[a-z]{3}$/.test(language)) language = 'eng';

      // Optional per-format fps override (blank = Auto/detect)
      // Kept inside mccOptions to avoid affecting other export formats.
      const fpsOverride = (() => {
        const raw = readText('fmt-mcc-fps', 'mcc-fps', '');
        const n = parseFloat(String(raw ?? '').trim());
        return (Number.isFinite(n) && n > 0) ? n : null;
      })();

      let exportPolicy = readText('fmt-mcc-export-policy', 'mcc-export-policy', 'warn');
      exportPolicy = String(exportPolicy || '').trim().toLowerCase();
      // Two-state QC enforcement:
      //  - Draft: warn-only
      //  - Delivery: write file, then fail job if QC fails
      if (exportPolicy === 'gate_block') exportPolicy = 'gate_write';
      if (!['warn', 'gate_write'].includes(exportPolicy)) exportPolicy = 'warn';

      const qcNum = (elId, lsKey) => {
        const rawEl = document.getElementById(elId)?.value;
        if (rawEl != null && String(rawEl).trim() !== '') {
          const v = Number(rawEl);
          if (Number.isFinite(v)) return v;
        }
        try {
          const raw = localStorage.getItem(lsKey);
          if (raw == null || String(raw).trim() === '') return undefined;
          const v = Number(raw);
          return Number.isFinite(v) ? v : undefined;
        } catch {
          return undefined;
        }
      };

      const raw = {
        authoringModel,
        includeCcsSvcInfo,
        alignment,
        pingPongWindows,
        mcc708Window,
        maxCharsPerLine,
        maxLinesPerBlock,
        maxDurationSeconds,
        include608Compatibility,
        includeCdpTimecode,
        telestreamCompression,
        timecodeOffset,
        timecodeOffsetPolicy,
        safeMargins,
        overflowPolicy,
        strictCharacterEncoding,
        padEven,
        repeatControlCodes,
        repeatPreambleCodes,
        shaping,
        serviceNumber,
        language,
        ...(fpsOverride != null ? { fpsOverride } : {}),
        ...(startTcOverride ? { startTc: startTcOverride, startTC: startTcOverride } : {}),
        exportPolicy,
        qc: {
          maxCps: qcNum('fmt-mcc-qc-max-cps', 'mcc-qc-max-cps'),
          maxWpm: qcNum('fmt-mcc-qc-max-wpm', 'mcc-qc-max-wpm'),
          minDurationSec: qcNum('fmt-mcc-qc-min-duration', 'mcc-qc-min-duration'),
          minGapSec: qcNum('fmt-mcc-qc-min-gap', 'mcc-qc-min-gap')
        }
      };

      // Prefer the shared QC & Delivery builder so exportPolicy/qc.gate normalization stays consistent.
      try {
        if (qcApi && typeof qcApi.readMccPrefs === 'function' && typeof qcApi.buildMccOptions === 'function') {
          const prefs = qcApi.readMccPrefs(localStorage);
          return qcApi.buildMccOptions(prefs, raw);
        }
      } catch {}

      // Fallback: raw options.
      // (qc.gate is derived by writers from exportPolicy when absent.)
      return raw;
    })();

    const sccOptions = (() => {
      const readText = (elId, lsKey, fallback) => {
        const rawEl = document.getElementById(elId)?.value;
        if (typeof rawEl === 'string' && rawEl.trim()) return rawEl.trim();
        try {
          const raw = localStorage.getItem(lsKey);
          if (raw != null && String(raw).trim()) return String(raw).trim();
        } catch {}
        return fallback;
      };

      const readBool = (elId, lsKey, fallback) => {
        const el = document.getElementById(elId);
        if (el && typeof el.checked === 'boolean') return !!el.checked;
        try {
          const raw = localStorage.getItem(lsKey);
          if (raw == null || raw === '') return !!fallback;
          return raw === 'true';
        } catch {
          return !!fallback;
        }
      };

      const readInt = (elId, lsKey, fallback, min, max) => {
        const clamp = (n) => Math.max(min, Math.min(max, Math.trunc(n)));
        const fromEl = document.getElementById(elId)?.value;
        const n1 = parseInt(String(fromEl ?? '').trim(), 10);
        if (Number.isFinite(n1)) return clamp(n1);
        try {
          const raw = localStorage.getItem(lsKey);
          const n2 = parseInt(String(raw ?? '').trim(), 10);
          if (Number.isFinite(n2)) return clamp(n2);
        } catch {}
        return clamp(fallback);
      };

      const readFloat = (elId, lsKey, fallback, min, max) => {
        const clamp = (n) => Math.max(min, Math.min(max, n));
        const fromEl = document.getElementById(elId)?.value;
        const n1 = parseFloat(String(fromEl ?? '').trim());
        if (Number.isFinite(n1)) return clamp(n1);
        try {
          const raw = localStorage.getItem(lsKey);
          const n2 = parseFloat(String(raw ?? '').trim());
          if (Number.isFinite(n2)) return clamp(n2);
        } catch {}
        return clamp(fallback);
      };

      const maxCharsPerLine = readInt('fmt-scc-max-chars', 'scc-max-chars', 28, 20, 32);
      const maxLinesPerBlock = readInt('fmt-scc-max-lines', 'scc-max-lines', 2, 1, 2);
      const maxDurationSeconds = readFloat('fmt-scc-max-duration', 'scc-max-duration', 6.0, 1, 10);

      const placementMode = (() => {
        const raw = String(readText('fmt-scc-placement-mode', 'scc-placement-mode', 'custom') || '').toLowerCase();
        return (raw === 'auto') ? 'auto' : 'custom';
      })();
      const placementBottomRow = readInt('fmt-scc-placement-bottom-row', 'scc-placement-bottom-row', 15, 1, 15);
      const placementLeftCol = readInt('fmt-scc-placement-left-col', 'scc-placement-left-col', 2, 0, 31);

      const timecodeOffsetRaw = readText('fmt-scc-timecode-offset', 'scc-timecode-offset', '');
      const timecodeOffset = timecodeOffsetRaw ? timecodeOffsetRaw : null;

      const preStartTransmitSec = readFloat('fmt-scc-prestart-roll', 'scc-prestart-roll', 0, 0, 30);
      const exportPolicyRaw = String(readText('fmt-scc-export-policy', 'scc-export-policy', 'warn') || '').trim().toLowerCase();
      const exportPolicy = ['warn', 'gate_write', 'gate_block'].includes(exportPolicyRaw) ? exportPolicyRaw : 'warn';

      const shapeModeUi = String(readText('fmt-scc-shape-mode', 'scc-shape-mode', 'off') || '').trim().toLowerCase() || 'off';
      const shaping = {
        enabled: shapeModeUi !== 'off',
        mode: shapeModeUi === 'off' ? String(readText('fmt-scc-shape-mode', 'scc-shape-mode', 'conservative') || 'conservative').trim().toLowerCase() : shapeModeUi,
        microCueSec: readFloat('fmt-scc-shape-micro-dur', 'scc-shape-micro-dur', 0.4, 0, 2),
        microGapSec: readFloat('fmt-scc-shape-micro-gap', 'scc-shape-micro-gap', 0.12, 0, 2),
        maxShiftSec: readFloat('fmt-scc-shape-max-shift', 'scc-shape-max-shift', 0.25, 0, 5),
        fixStartTcClamp: readBool('fmt-scc-shape-fix-starttc', 'scc-shape-fix-starttc', true)
      };
      shaping.fixStartTc = shaping.fixStartTcClamp;
      shaping.fixStartTC = shaping.fixStartTcClamp;

      const rawPrefixWords = readText('fmt-scc-prefix-words', 'scc-prefix-words', '');
      const prefixWords = rawPrefixWords
        ? rawPrefixWords.split(/[,\s]+/).map(t => t.trim()).filter(Boolean)
        : [];

      const overrides = {
        alignment: sccAlignment,
        channel: sccChannel,
        rowPolicy: sccRowPolicy,
        placementMode,
        placementBottomRow,
        placementLeftCol,
        maxCharsPerLine,
        maxLinesPerBlock,
        maxDurationSeconds,
        mode: sccMode,
        safeMargins: {
          left: readInt('fmt-scc-safe-left', 'scc-safe-left', 0, 0, 15),
          right: readInt('fmt-scc-safe-right', 'scc-safe-right', 0, 0, 15)
        },
        allowNdf: readBool('fmt-scc-allow-ndf', 'scc-allow-ndf', false),
        repeatControlCodes: readBool('fmt-scc-repeat-control', 'scc-repeat-control', true),
        repeatPreambleCodes: readBool('fmt-scc-repeat-preamble', 'scc-repeat-preamble', true),
        stripLeadingDashes: readBool('fmt-scc-strip-leading-dashes', 'scc-strip-leading-dashes', false),
        strictCharacterEncoding: readBool('fmt-scc-strict-encoding', 'scc-strict-encoding', false),
        padEven: readBool('fmt-scc-pad-even', 'scc-pad-even', false),
        preStartTransmitSec,
        prestartRollSec: preStartTransmitSec,
        timeSource: readText('fmt-scc-time-source', 'scc-time-source', sccTimeSource),
        startTc: derivedStartTc,
        startResetAt: readText('fmt-scc-start-reset-at', 'scc-start-reset-at', 'auto'),
        startResetOp: readText('fmt-scc-start-reset-op', 'scc-start-reset-op', 'edm'),
        timecodeOffset,
        exportPolicy,
        appendEOFAt: 'afterLast',
        eofOp: 'edm',
        shaping,
        prefixWords,
        qc: {
          maxCps: readFloat('fmt-scc-qc-max-cps', 'scc-qc-max-cps', 20, 1, 60),
          maxWpm: readInt('fmt-scc-qc-max-wpm', 'scc-qc-max-wpm', 180, 10, 400),
          minDurationSec: readFloat('fmt-scc-qc-min-duration', 'scc-qc-min-duration', 0.8, 0, 10),
          minGapSec: readFloat('fmt-scc-qc-min-gap', 'scc-qc-min-gap', 0.1, 0, 10),
          maxLateEocSec: readFloat('fmt-scc-qc-max-late-eoc', 'scc-qc-max-late-eoc', 0.1, 0, 2),
          maxLateEocCount: readInt('fmt-scc-qc-max-late-eoc-count', 'scc-qc-max-late-eoc-count', 0, 0, 999)
        }
      };

      try {
        if (qcApi && typeof qcApi.readSccPrefs === 'function' && typeof qcApi.buildSccOptions === 'function') {
          const prefs = qcApi.readSccPrefs(localStorage);
          return qcApi.buildSccOptions(prefs, overrides);
        }
      } catch {}

      return overrides;
    })();

    const isWatchMode = el.watchMode?.checked === true;
    const rawFileField = String(el.files?.value || '');
    const parsedPaths = rawFileField.split('\n').map(s => String(s || '').trim()).filter(Boolean);
    const watchFolder = isWatchMode
      ? (String(el.files?.dataset?.watchFolder || parsedPaths[0] || '').trim() || null)
      : null;
    const files = isWatchMode ? [] : parsedPaths;

    // Legacy/top-level shaping values: keep for backward compatibility in engines
    // that still read cfg.maxCharsPerLine/maxLinesPerBlock/maxDurationSeconds.
    // With single-output UX, map these to the currently selected deliverable.
    const activeOutputFormat = document.getElementById('transcribe-output-formats')?.value || 'txt';
    const activeShaping = (() => {
      const pick = (src, def) => {
        if (!src || typeof src !== 'object') return { ...def };
        return {
          maxCharsPerLine: Number.isFinite(Number(src.maxCharsPerLine)) ? Math.trunc(Number(src.maxCharsPerLine)) : def.maxCharsPerLine,
          maxLinesPerBlock: Number.isFinite(Number(src.maxLinesPerBlock)) ? Math.trunc(Number(src.maxLinesPerBlock)) : def.maxLinesPerBlock,
          maxDurationSeconds: Number.isFinite(Number(src.maxDurationSeconds)) ? Number(src.maxDurationSeconds) : def.maxDurationSeconds
        };
      };

      const defaults = { maxCharsPerLine: 42, maxLinesPerBlock: 2, maxDurationSeconds: 6.0 };

      if (activeOutputFormat === 'srt') return pick(srtFormat, defaults);
      if (activeOutputFormat === 'vtt') return pick(vttFormat, defaults);
      if (activeOutputFormat === 'scc') return pick(sccOptions, defaults);
      if (activeOutputFormat === 'mcc') return pick(mccOptions, defaults);

      // Fallback: prefer VTT shaping as the app-wide default.
      return pick(vttFormat, defaults);
    })();

    const cfg = {
      files,
      watchFolder,
      outputPath: el.outputPath.value,
      // Transcribe panel deliveries should only leave the user-facing export in the
      // destination, plus any text QC/report sidecar. JSON-ish sidecars are either
      // suppressed at write time or removed after the file finishes.
      writeJsonQcSidecars: false,
      cleanupOutputSidecars: true,
      language: document.getElementById('transcribe-language')?.value,
      multiSpeaker: wantsSpeakers,
      engine: document.getElementById('transcribe-engine')?.value,
      accuracyMode: document.getElementById('transcribe-accuracy-mode')?.value,
      outputFormats,
      extras: {
        syncableScript: document.getElementById('out-syncable')?.checked,
        speakerNames: wantsSpeakers,
        timecodes: !!txtFormat.includeTimecodes,
      },
      dropFrame: derivedDropFrame,
      fpsOverride: derivedFpsOverride ?? null,
      startTC: derivedStartTc,
      filterNonSpeech: document.getElementById('transcribe-filter-nonspeech')?.checked,
      removeFillers: document.getElementById('transcribe-remove-fillers')?.checked,
      removeLeadingChars: document.getElementById('transcribe-remove-leading-chars')?.checked,
      fileNameTemplate: document.getElementById('transcribe-naming-template')?.value?.trim(),
      // Store the raw dropdown selection (ndf | df | ms)
      timecodeStyle: derivedTimecodeFormat,
      sccOptions,
      mccOptions,
      maxCharsPerLine: activeShaping.maxCharsPerLine,
      maxLinesPerBlock: activeShaping.maxLinesPerBlock,
      verboseQcLogs: document.getElementById('verbose-qc-logs')?.checked === true,
      include608Compatibility,
      maxDurationSeconds: activeShaping.maxDurationSeconds,
      includeSpeakerNames: wantsSpeakers,
      enhancements: {
        redact: document.getElementById('acc-redact')?.checked,
      },
      // Legacy txtOptions remains for backward compatibility in engines
      txtOptions,
      // ─────────────────────────────────────────────────────────────
      // NEW: Format‑scoped config (Option B) — additive, not breaking
      // ─────────────────────────────────────────────────────────────
      formats,
      // Keep legacy scriptOptions for backward compatibility with engines/presets
      scriptOptions,
      // Legacy srtOptions (mirrors formats.srt) for backward compatibility
      srtOptions: {
        maxCharsPerLine: srtFormat.maxCharsPerLine,
        maxLinesPerBlock: srtFormat.maxLinesPerBlock,
        maxDurationSeconds: srtFormat.maxDurationSeconds,
        includeSpeakerNames: srtFormat.includeSpeakers,
        speakerLabelStyle: srtFormat.speakerLabelStyle,
        // QC / timing behavior
        maxCps: srtFormat.maxCps,
        minDurationSeconds: srtFormat.minDurationSeconds,
        minSplitDurationSeconds: srtFormat.minSplitDurationSeconds,
        preventOverlaps: srtFormat.preventOverlaps,
        allowTimeExtension: srtFormat.allowTimeExtension,
        maxEndExtensionSeconds: srtFormat.maxEndExtensionSeconds,
        // Output hygiene
        utf8Bom: srtFormat.utf8Bom,
        lineEnding: srtFormat.lineEnding
      },
      vttOptions: {
        maxCharsPerLine: vttFormat.maxCharsPerLine,
        maxLinesPerBlock: vttFormat.maxLinesPerBlock,
        maxDurationSeconds: vttFormat.maxDurationSeconds,
        includeStyle:
          (document.getElementById('fmt-vtt-include-style')?.checked) ??
          document.getElementById('sub-include-style')?.checked,

        // Keep legacy vttOptions in sync with formats.vtt
        maxCps: vttFormat.maxCps,
        minDurationSeconds: vttFormat.minDurationSeconds,
        minSplitDurationSeconds: vttFormat.minSplitDurationSeconds,
        preventOverlaps: vttFormat.preventOverlaps,
        allowTimeExtension: vttFormat.allowTimeExtension,
        maxEndExtensionSeconds: vttFormat.maxEndExtensionSeconds
      },
      translation: {
        enabled: document.getElementById('translate-enable')?.checked,
        target: document.getElementById('translate-target')?.value,
      },
      postActions: {
        sendToSubtitle: document.getElementById('transcribe-send-subtitle')?.checked,
      },
      enableN8N: !!el.enableN8N?.checked,
      n8nUrl: (el.n8nUrl?.value || '').trim(),
      n8nAllowPrivate: !!el.n8nAllowPrivate?.checked,
      n8nLog: !!el.n8nLog?.checked,
      notes: el.notes?.value || '',
      watchMode: isWatchMode,
      localSpeakerDetection: wantsSpeakers,
      detectSpeakers: wantsSpeakers
    };

    const legacyOutTimecodesEl = document.getElementById('out-timecodes');
    if (legacyOutTimecodesEl && typeof legacyOutTimecodesEl.checked === 'boolean') {
      // Backward compatibility shim for older presets that persisted the removed
      // global TXT timecode checkbox instead of formats.txt.timestampPlacement.
      cfg.legacyOutTimecodes = !!legacyOutTimecodesEl.checked;
    }


    // If Scripted is the active format, prefer its time settings globally so
    // downstream writers have consistent fps/style without reaching into formats.*
    // NOTE: only do this when Scripted is actually including timecodes.
    try {
      const sel = document.getElementById('transcribe-output-formats')?.value || '';
      if (sel === 'script') {
        const sf = cfg.formats?.script || {};
        const includeTc = (sf.includeTimecodes !== false);
        if (includeTc) {
          if (sf.timecodeFormat) {
            cfg.timecodeStyle = sf.timecodeFormat;   // 'ndf'|'df'|'ms'
            cfg.dropFrame = sf.timecodeFormat === 'df';
          }
          if (sf.frameRateOverride != null) {
            const ov = Number(sf.frameRateOverride);
            cfg.fpsOverride = Number.isFinite(ov) ? ov : null;
          }
          if (sf.startTimecodeOffset) cfg.startTC = sf.startTimecodeOffset;
        }
      }
    } catch {}

    // Final DF validation against the resolved fps override (if provided).
    // NOTE: cfg.fpsOverride is often null/empty when the user hasn't set an override.
    // Avoid Number(null) => 0, which would incorrectly trigger "0 fps" DF warnings.
    const resolvedFpsForValidation = (() => {
      const raw = cfg.fpsOverride;
      if (raw == null) return null;
      if (typeof raw === 'string' && raw.trim() === '') return null;
      const n = Number(raw);
      return (Number.isFinite(n) && n > 0) ? n : null;
    })();
    const wantsDropFrame = cfg.dropFrame || cfg.timecodeStyle === 'df';
    if (wantsDropFrame && resolvedFpsForValidation != null && !isSupportedDropFrameRate(resolvedFpsForValidation)) {
      const message = dropFrameValidation?.message ||
        getDropFrameUnsupportedFpsMessage(resolvedFpsForValidation);
      cfg.dropFrame = false;
      cfg.timecodeStyle = 'ndf';
      if (cfg.formats?.txt) {
        cfg.formats.txt.timecodeFormat = 'ndf';
        cfg.formats.txt.dropFrame = false;
      }
      dropFrameValidation = {
        ...(dropFrameValidation || {}),
        message,
        resolvedFps: resolvedFpsForValidation,
        coercedToNdf: true
      };
      if (!silentDropFrameValidation) {
        panelLog('warn', message, { resolvedFps: resolvedFpsForValidation });
      }
    }

    if (dropFrameValidation) {
      Object.defineProperty(cfg, '__dfValidation', {
        value: dropFrameValidation,
        enumerable: false
      });
    }

    return cfg;
  }


  function getDropFrameUnsupportedFpsMessage(fps) {
    return tr(
      'transcribeDropFrameUnsupportedFpsUsingNdf',
      'Drop-frame timecode is not supported at {{fps}} fps. Using non-drop-frame instead.',
      { fps }
    );
  }
  function scrubPresetSecrets(input) {
    if (Array.isArray(input)) {
      return input.map(item => scrubPresetSecrets(item));
    }
    if (!input || typeof input !== 'object') return input;

    const SENSITIVE_KEYS = [
      'apikey', 'apitoken', 'token', 'authtoken', 'bearertoken',
      'accesstoken', 'refreshtoken', 'clientsecret', 'secret'
    ];

    return Object.entries(input).reduce((acc, [key, value]) => {
      const normalized = key.toLowerCase();
      const isSecret = SENSITIVE_KEYS.some(k => normalized.includes(k));
      if (isSecret) {
        acc[key] = null;
      } else {
        acc[key] = scrubPresetSecrets(value);
      }
      return acc;
    }, {});
  }

  function applyTranscribePreset(data) {
    const asPlainObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    data = asPlainObject(data);

    const setDd = (id, raw, defVal = '') => {
      const v = (raw == null || raw === '') ? defVal : raw;
      try { if (typeof setDropdownValue === 'function') setDropdownValue(id, String(v)); } catch {}
      const hidden = document.getElementById(id);
      if (hidden) {
        hidden.value = String(v ?? '');
        try { hidden.dispatchEvent(new Event('change')); } catch {}
      }
    };

    const setField = (id, raw, defVal = '') => {
      const el = document.getElementById(id);
      if (!el) return;
      const v = (raw == null || raw === '') ? defVal : raw;
      el.value = String(v ?? '');
      try { el.dispatchEvent(new Event('input')); } catch {}
      try { el.dispatchEvent(new Event('change')); } catch {}
    };

    const setBool = (id, raw, defVal = false) => {
      const el = document.getElementById(id);
      if (!el || typeof el.checked !== 'boolean') return;
      const normalized = (raw === true || raw === 'true' || raw === 1 || raw === '1')
        ? true
        : (raw === false || raw === 'false' || raw === 0 || raw === '0')
          ? false
          : undefined;
      el.checked = (normalized !== undefined) ? normalized : !!defVal;
      try { el.dispatchEvent(new Event('input')); } catch {}
      try { el.dispatchEvent(new Event('change')); } catch {}
    };

    // These are styled dropdowns (hidden inputs) so we must update both hidden
    // value and the visible chosen-value text.
    setDd('transcribe-language', data.language, 'en');
    setDd('transcribe-engine', data.engine, TRANSCRIBE_DEFAULTS.engine);
    setDd('transcribe-accuracy-mode', data.accuracyMode, 'auto');

    // Translation target (also a styled dropdown)
    try {
      const t = data?.translation?.target ?? data?.translationTarget ?? data?.translateTarget ?? data?.translateTo;
      if (t != null) setDd('translate-target', t, 'en');
    } catch {}
    try {
      const te = document.getElementById('translate-enable');
      if (te && data?.translation?.enabled != null) te.checked = !!data.translation.enabled;
    } catch {}

    // Engine selection affects format availability.
    try { updateDisabledOutputFormats(); } catch {}
    try { applyTranscribeEngineAvailability(); } catch {}
    const select = document.getElementById('transcribe-output-formats');
    if (select) {
      let selectedFormat = 'txt';
      if (data.outputFormats) {
        let firstEnabled = Object.keys(data.outputFormats).find(k => data.outputFormats[k]);

        // Legacy: normalize removed formats to a safe default.
        // (We intentionally ignore XML/Final JSON for v1.)
        const allowed = new Set(['txt', 'srt', 'vtt', 'scc', 'mcc', 'script', 'burnIn']);

        if (!firstEnabled || firstEnabled === 'markers' || firstEnabled === 'xml' || firstEnabled === 'finalJson') {
          firstEnabled = 'txt';
        }
        if (!allowed.has(firstEnabled)) {
          firstEnabled = 'txt';
        }

        if (firstEnabled) selectedFormat = firstEnabled;
      } else if (select.value) {
        selectedFormat = select.value;
      }
      setDropdownValue('transcribe-output-formats', selectedFormat);
      select.value = selectedFormat;
      select.dispatchEvent(new Event('change'));
    }
    const fpsEl = document.getElementById('transcribe-fps');
    if (fpsEl) {
      fpsEl.value = data.fpsOverride || '';
      try { fpsEl.dispatchEvent(new Event('input')); } catch {}
      try { fpsEl.dispatchEvent(new Event('change')); } catch {}
    }
    const tcStartEl = document.getElementById('transcribe-tc-start');
    if (tcStartEl) tcStartEl.value = data.startTC || '';

    // Keep format-scoped fallback containers as plain objects so sparse, legacy,
    // or partially initialized presets can still flow through the apply path
    // without throwing on undefined nested reads.
    const formats = asPlainObject(data.formats);
    const legacyScc = asPlainObject(data.scc ?? data.legacySccOptions);
    const formatScc = asPlainObject(formats.scc);
    const scc = asPlainObject(data.sccOptions ?? formats.scc ?? legacyScc);

    const legacyMcc = asPlainObject(data.mcc ?? data.legacyMccOptions);
    const formatMcc = asPlainObject(formats.mcc);
    const mcc = asPlainObject(data.mccOptions ?? formats.mcc ?? legacyMcc);

    const sccAlignment = (
      scc.alignment
      ?? scc.captionAlignment
      ?? formatScc?.alignment
      ?? formatScc?.captionAlignment
      ?? data?.sccAlignment
    );
    setDd('scc-alignment', sccAlignment, 'center');

    const sccChannel = (
      scc.channel
      ?? scc.serviceNumber
      ?? formatScc?.channel
      ?? formatScc?.serviceNumber
      ?? data?.sccChannel
    );
    setDd('scc-channel', String(normalizeSccChannel(sccChannel)), '1');

    const sccStartTc = scc.startTc ?? scc.startTC ?? formatScc.startTc ?? formatScc.startTC ?? data.startTC ?? '';
    setField('fmt-scc-tc-start', sccStartTc, '');
    try { localStorage.setItem('scc-tc-start', String(sccStartTc ?? '')); } catch {}

    const sccOffset = scc.timecodeOffset ?? scc.captionOffset ?? scc.offset ?? formatScc.timecodeOffset ?? formatScc.captionOffset ?? formatScc.offset ?? '';
    setField('fmt-scc-timecode-offset', sccOffset, '');
    try {
      const v = String(sccOffset ?? '').trim();
      if (!v) localStorage.removeItem('scc-timecode-offset');
      else localStorage.setItem('scc-timecode-offset', v);
    } catch {}

    setField('fmt-scc-max-chars', scc.maxCharsPerLine ?? formatScc.maxCharsPerLine ?? data.maxCharsPerLine, 28);
    setField('fmt-scc-max-lines', scc.maxLinesPerBlock ?? formatScc.maxLinesPerBlock ?? data.maxLinesPerBlock, 2);
    setField('fmt-scc-max-duration', scc.maxDurationSeconds ?? formatScc.maxDurationSeconds ?? data.maxDurationSeconds, 6.0);
    setField('fmt-scc-safe-left', scc.safeMargins?.left ?? formatScc.safeMargins?.left, 0);
    setField('fmt-scc-safe-right', scc.safeMargins?.right ?? formatScc.safeMargins?.right, 0);
    setBool('fmt-scc-repeat-control', scc.repeatControlCodes ?? formatScc.repeatControlCodes, true);
    setBool('fmt-scc-repeat-preamble', scc.repeatPreambleCodes ?? formatScc.repeatPreambleCodes, true);
    setBool('fmt-scc-strict-encoding', scc.strictCharacterEncoding ?? formatScc.strictCharacterEncoding, false);
    setBool('fmt-scc-pad-even', scc.padEven ?? formatScc.padEven, false);
    setBool('fmt-scc-allow-ndf', scc.allowNdf ?? formatScc.allowNdf, false);
    setBool('fmt-scc-strip-leading-dashes', scc.stripLeadingDashes ?? formatScc.stripLeadingDashes, false);
    setField('fmt-scc-prestart-roll', scc.prestartRollSec ?? scc.prestartRoll ?? formatScc.prestartRollSec ?? formatScc.prestartRoll, 0);
    setDd('fmt-scc-time-source', scc.timeSource ?? formatScc.timeSource, 'auto');
    setDd('fmt-scc-start-reset-at', scc.startResetAt ?? formatScc.startResetAt, 'auto');
    setDd('fmt-scc-start-reset-op', scc.startResetOp ?? formatScc.startResetOp, 'edm');
    setDd('fmt-scc-export-policy', scc.exportPolicy ?? formatScc.exportPolicy, 'warn');
    setField('fmt-scc-prefix-words', scc.prefixWords ?? formatScc.prefixWords, '');
    setDd('fmt-scc-placement-mode', scc.placementMode ?? formatScc.placementMode, 'custom');
    setField('fmt-scc-placement-bottom-row', scc.placementBottomRow ?? formatScc.placementBottomRow, 15);
    setField('fmt-scc-placement-left-col', scc.placementLeftCol ?? formatScc.placementLeftCol, 2);
    setDd('fmt-scc-shape-mode', scc.shaping?.mode ?? formatScc.shaping?.mode ?? (scc.shaping?.enabled === false ? 'off' : undefined), 'off');
    setField('fmt-scc-shape-micro-dur', scc.shaping?.microCueSec ?? formatScc.shaping?.microCueSec, 0.4);
    setField('fmt-scc-shape-micro-gap', scc.shaping?.microGapSec ?? formatScc.shaping?.microGapSec, 0.12);
    setField('fmt-scc-shape-max-shift', scc.shaping?.maxShiftSec ?? formatScc.shaping?.maxShiftSec, 0.25);
    setBool('fmt-scc-shape-fix-starttc', scc.shaping?.fixStartTc ?? scc.shaping?.fixStartTC ?? formatScc.shaping?.fixStartTc ?? formatScc.shaping?.fixStartTC, true);
    setField('fmt-scc-qc-max-cps', scc.qc?.maxCps ?? formatScc.qc?.maxCps, 20);
    setField('fmt-scc-qc-max-wpm', scc.qc?.maxWpm ?? formatScc.qc?.maxWpm, 180);
    setField('fmt-scc-qc-min-duration', scc.qc?.minDurationSec ?? formatScc.qc?.minDurationSec, 0.8);
    setField('fmt-scc-qc-min-gap', scc.qc?.minGapSec ?? formatScc.qc?.minGapSec, 0.1);
    setField('fmt-scc-qc-max-late-eoc', scc.qc?.maxLateEocSec ?? formatScc.qc?.maxLateEocSec, 0.1);
    setField('fmt-scc-qc-max-late-eoc-count', scc.qc?.maxLateEocCount ?? formatScc.qc?.maxLateEocCount, 0);

    setField('fmt-mcc-max-chars', mcc.maxCharsPerLine ?? formatMcc.maxCharsPerLine ?? data.maxCharsPerLine, 42);
    setField('fmt-mcc-max-lines', mcc.maxLinesPerBlock ?? formatMcc.maxLinesPerBlock ?? data.maxLinesPerBlock, 2);
    setField('fmt-mcc-max-duration', mcc.maxDurationSeconds ?? formatMcc.maxDurationSeconds ?? data.maxDurationSeconds, 6.0);
    setField('fmt-mcc-safe-left', mcc.safeMargins?.left ?? formatMcc.safeMargins?.left, 0);
    setField('fmt-mcc-safe-right', mcc.safeMargins?.right ?? formatMcc.safeMargins?.right, 0);
    setField('fmt-mcc-service-number', mcc.serviceNumber ?? formatMcc.serviceNumber, 1);
    setField('fmt-mcc-language', mcc.language ?? formatMcc.language, 'eng');
    setBool('fmt-mcc-include-608', mcc.include608Compatibility ?? formatMcc.include608Compatibility, true);
    setBool('fmt-mcc-embed-cdp-timecode', mcc.includeCdpTimecode ?? formatMcc.includeCdpTimecode, false);
    setBool('fmt-mcc-include-ccsvc-info', mcc.includeCcsSvcInfo ?? formatMcc.includeCcsSvcInfo, true);
    setBool('fmt-mcc-strict-encoding', mcc.strictCharacterEncoding ?? formatMcc.strictCharacterEncoding, false);
    setBool('fmt-mcc-pad-even', mcc.padEven ?? formatMcc.padEven, false);
    setBool('fmt-mcc-repeat-control', mcc.repeatControlCodes ?? formatMcc.repeatControlCodes, false);
    setBool('fmt-mcc-repeat-preamble', mcc.repeatPreambleCodes ?? formatMcc.repeatPreambleCodes, true);
    setBool('fmt-mcc-telestream-compress', mcc.telestreamCompression ?? formatMcc.telestreamCompression, false);
    setDd('fmt-mcc-overflow-policy', mcc.overflowPolicy ?? formatMcc.overflowPolicy, 'error');
    setDd('fmt-mcc-export-policy', mcc.exportPolicy ?? formatMcc.exportPolicy, 'warn');
    setDd('fmt-mcc-timecode-offset-policy', mcc.timecodeOffsetPolicy ?? formatMcc.timecodeOffsetPolicy, 'clamp');
    setDd('fmt-mcc-shape-mode', mcc.shaping?.mode ?? formatMcc.shaping?.mode ?? (mcc.shaping?.enabled === false ? 'off' : undefined), 'off');
    setField('fmt-mcc-shape-micro-dur', mcc.shaping?.microCueSec ?? formatMcc.shaping?.microCueSec, 0.4);
    setField('fmt-mcc-shape-micro-gap', mcc.shaping?.microGapSec ?? formatMcc.shaping?.microGapSec, 0.12);
    setField('fmt-mcc-shape-max-shift', mcc.shaping?.maxShiftSec ?? formatMcc.shaping?.maxShiftSec, 0.25);
    setDd('fmt-mcc-alignment', mcc.alignment ?? formatMcc.alignment, 'left');
    setBool('fmt-mcc-pingpong-windows', mcc.pingPongWindows ?? formatMcc.pingPongWindows, true);
    setDd('fmt-mcc-window-anchor-id', mcc.mcc708Window?.anchorId ?? formatMcc.mcc708Window?.anchorId, 7);
    setField('fmt-mcc-window-anchor-v', mcc.mcc708Window?.anchorV ?? formatMcc.mcc708Window?.anchorV, 90);
    setField('fmt-mcc-window-anchor-h', mcc.mcc708Window?.anchorH ?? formatMcc.mcc708Window?.anchorH, 50);
    setField('fmt-mcc-qc-max-cps', mcc.qc?.maxCps ?? formatMcc.qc?.maxCps, 20);
    setField('fmt-mcc-qc-max-wpm', mcc.qc?.maxWpm ?? formatMcc.qc?.maxWpm, 180);
    setField('fmt-mcc-qc-min-duration', mcc.qc?.minDurationSec ?? formatMcc.qc?.minDurationSec, 0.8);
    setField('fmt-mcc-qc-min-gap', mcc.qc?.minGapSec ?? formatMcc.qc?.minGapSec, 0.1);

    // MCC optional FPS override (per-format)
    const mccFpsRaw = (mcc.fpsOverride ?? mcc.frameRateOverride ?? formatMcc.fpsOverride ?? formatMcc.frameRateOverride ?? data.fpsOverride ?? '');
    setField('fmt-mcc-fps', mccFpsRaw, '');
    try { localStorage.setItem('mcc-fps', String(mccFpsRaw ?? '')); } catch {}

    setField('fmt-mcc-tc-start', mcc.startTc ?? mcc.startTC ?? formatMcc.startTc ?? formatMcc.startTC ?? data.startTC, '');
    setField('fmt-mcc-timecode-offset', mcc.timecodeOffset ?? mcc.captionOffset ?? mcc.offset ?? formatMcc.timecodeOffset ?? formatMcc.captionOffset ?? formatMcc.offset, '');

    try {
      if ((mcc.mcc708Window?.rel ?? formatMcc.mcc708Window?.rel) != null) {
        localStorage.setItem('mcc-window-rel', String(!!(mcc.mcc708Window?.rel ?? formatMcc.mcc708Window?.rel)));
      }
    } catch {}
    setBool('transcribe-filter-nonspeech', data.filterNonSpeech, false);
    setBool('transcribe-remove-fillers', data.removeFillers, false);
    setBool('transcribe-remove-leading-chars', data.removeLeadingChars, false);
    setBool('transcribe-watch-mode', data.watchMode, false);
    setBool('verbose-qc-logs', data.verboseQcLogs, false);
    setBool('transcribe-send-subtitle', data?.postActions?.sendToSubtitle, false);
    setBool(
      'acc-redact',
      data?.enhancements?.redact
        ?? data?.enhancement?.redact
        ?? data?.redact
        ?? data?.redaction,
      false
    );
    const nameTpl = document.getElementById('transcribe-naming-template');
    if (nameTpl) nameTpl.value = data.fileNameTemplate || '';
    const tcStyle = document.getElementById('transcribe-timecode-style');
    if (tcStyle) {
      const uiStyle =
        (data.timecodeStyle === 'ms') ? 'ms' :
        (data.dropFrame ? 'df' : 'ndf');
      setDropdownValue('transcribe-timecode-style', uiStyle);
      tcStyle.value = uiStyle;
      tcStyle.dispatchEvent(new Event('change')); // keeps DF checkbox aligned
    }
    // Legacy top-level shaping keys were used by older presets. We now apply them
    // per-format when format-scoped values are absent.
    // Phase 4: VTT format-scoped controls
    try {
      const vttData = (data.formats && data.formats.vtt) || {};
      const legacyVtt = data.vttOptions || {};

      const includeStyle = !!(
        vttData.includeStyleMetadata ??
        vttData.includeStyle ??
        legacyVtt.includeStyleMetadata ??
        legacyVtt.includeStyle
      );

      const vttStyleEl = document.getElementById('fmt-vtt-include-style');
      if (vttStyleEl) {
        vttStyleEl.checked = includeStyle;
        try { vttStyleEl.dispatchEvent(new Event('change')); } catch {}
      }
      setBool(
        'fmt-vtt-include-speaker-names',
        vttData.includeSpeakers ?? vttData.includeSpeakerNames ?? data.includeSpeakerNames,
        !!data.includeSpeakerNames
      );

      const setNum = (id, raw, defVal) => {
        const el = document.getElementById(id);
        if (!el) return;
        const v = Number(raw);
        el.value = Number.isFinite(v) ? String(v) : String(defVal);
        try { el.dispatchEvent(new Event('change')); } catch {}
      };

      const setBool = (id, raw, defVal) => {
        const el = document.getElementById(id);
        if (!el || typeof el.checked !== 'boolean') return;
        const v = (raw === true || raw === 'true' || raw === 1 || raw === '1')
          ? true
          : (raw === false || raw === 'false' || raw === 0 || raw === '0')
            ? false
            : undefined;
        el.checked = (v !== undefined) ? v : !!defVal;
        try { el.dispatchEvent(new Event('change')); } catch {}
      };

      // Shaping (format-scoped). Fall back to legacy top-level keys for older presets.
      setNum('fmt-vtt-max-chars', vttData.maxCharsPerLine ?? legacyVtt.maxCharsPerLine ?? data.maxCharsPerLine, 42);
      setNum('fmt-vtt-max-lines', vttData.maxLinesPerBlock ?? legacyVtt.maxLinesPerBlock ?? data.maxLinesPerBlock, 2);
      setNum('fmt-vtt-max-duration', vttData.maxDurationSeconds ?? legacyVtt.maxDurationSeconds ?? data.maxDurationSeconds, 6.0);
      // Advanced QC settings
      setNum('fmt-vtt-qc-max-cps', vttData.maxCps ?? vttData.maxCPS ?? legacyVtt.maxCps ?? legacyVtt.maxCPS, 20);
      setNum('fmt-vtt-qc-min-duration', vttData.minDurationSeconds ?? legacyVtt.minDurationSeconds, 1.0);
      setNum('fmt-vtt-qc-min-split-duration', vttData.minSplitDurationSeconds ?? legacyVtt.minSplitDurationSeconds, 0.5);
      setBool('fmt-vtt-prevent-overlaps', vttData.preventOverlaps ?? legacyVtt.preventOverlaps, false);
      setBool('fmt-vtt-allow-extension', vttData.allowTimeExtension ?? legacyVtt.allowTimeExtension, true);
      setNum('fmt-vtt-max-end-extension', vttData.maxEndExtensionSeconds ?? legacyVtt.maxEndExtensionSeconds, 1.5);

      // Shaping controls are persisted via their change listeners (setNum dispatches change).
    } catch {}

    // Phase 4: SRT format-scoped controls
    try {
      const srtData = (data.formats && data.formats.srt) || {};
      const legacySrt = data.srtOptions || {};

      const setNum = (id, raw, defVal) => {
        const el = document.getElementById(id);
        if (!el) return;
        const v = Number(raw);
        el.value = Number.isFinite(v) ? String(v) : String(defVal);
        try { el.dispatchEvent(new Event('change')); } catch {}
      };

      const setBool = (id, raw, defVal) => {
        const el = document.getElementById(id);
        if (!el || typeof el.checked !== 'boolean') return;
        const v = (raw === true || raw === 'true' || raw === 1 || raw === '1')
          ? true
          : (raw === false || raw === 'false' || raw === 0 || raw === '0')
            ? false
            : undefined;
        el.checked = (v !== undefined) ? v : !!defVal;
        try { el.dispatchEvent(new Event('change')); } catch {}
      };

      const setDd = (id, val, defVal) => {
        const v = (val == null || val === '') ? defVal : val;
        try { setDropdownValue(id, v); } catch {}
        const el = document.getElementById(id);
        if (el) {
          el.value = String(v);
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
      };

      // Speaker name toggles
      setBool(
        'fmt-srt-include-speaker-names',
        srtData.includeSpeakers ?? srtData.includeSpeakerNames ?? legacySrt.includeSpeakers ?? legacySrt.includeSpeakerNames,
        !!data.includeSpeakerNames
      );
      // Shaping (format-scoped). Fall back to legacy top-level keys for older presets.
      setNum('fmt-srt-max-chars', srtData.maxCharsPerLine ?? legacySrt.maxCharsPerLine ?? data.maxCharsPerLine, 42);
      setNum('fmt-srt-max-lines', srtData.maxLinesPerBlock ?? legacySrt.maxLinesPerBlock ?? data.maxLinesPerBlock, 2);
      setNum('fmt-srt-max-duration', srtData.maxDurationSeconds ?? legacySrt.maxDurationSeconds ?? data.maxDurationSeconds, 6.0);
      // Advanced QC
      setNum('fmt-srt-qc-max-cps', srtData.maxCps ?? srtData.maxCPS ?? legacySrt.maxCps ?? legacySrt.maxCPS, 20);
      setNum('fmt-srt-qc-min-duration', srtData.minDurationSeconds ?? legacySrt.minDurationSeconds, 1.0);
      setNum('fmt-srt-qc-min-split-duration', srtData.minSplitDurationSeconds ?? legacySrt.minSplitDurationSeconds, 0.5);
      setBool('fmt-srt-prevent-overlaps', srtData.preventOverlaps ?? legacySrt.preventOverlaps, true);
      setBool('fmt-srt-allow-extension', srtData.allowTimeExtension ?? legacySrt.allowTimeExtension, true);
      setNum('fmt-srt-max-end-extension', srtData.maxEndExtensionSeconds ?? legacySrt.maxEndExtensionSeconds, 1.5);

      // Output hygiene
      setBool('fmt-srt-utf8-bom', srtData.utf8Bom ?? srtData.bom ?? legacySrt.utf8Bom ?? legacySrt.bom, false);
      setDd('fmt-srt-line-ending', srtData.lineEnding ?? legacySrt.lineEnding, 'lf');
    } catch {}

    // Legacy control (removed from UI) — keep for backward compatibility if present
    const subStyle = document.getElementById('sub-include-style');
    if (subStyle) subStyle.checked = !!data.vttOptions?.includeStyle;

    // Populate new Plain Text (.txt) format-scoped controls
    // Prefer new formats.txt, fall back to legacy txtOptions for older presets.
    try {
      const setDd = (id, val) => {
        try { setDropdownValue(id, val); } catch {}
        const el = document.getElementById(id);
        if (el) {
          el.value = String(val ?? '');
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
      };

      const txtData = (data.formats && data.formats.txt) || {};
      const legacyTxt = data.txtOptions || {};
      const legacyOutTimecodes = data.legacyOutTimecodes;

      const explicitTimestampPlacementRaw =
        txtData.timestampPlacement ??
        legacyTxt.timestampStyle;
      const hasExplicitTimestampPlacement = (() => {
        const raw = String(explicitTimestampPlacementRaw ?? '').trim();
        if (!raw) return false;
        const normalized = raw.replace(/_/g, '-').toLowerCase();
        return ['none', 'start-end', 'start', 'every-line'].includes(normalized);
      })();

      const includeTxtTimecodes = !!(
        txtData.includeTimecodes ??
        legacyTxt.includeTimecodes ??
        data.extras?.timecodes ??
        ((!hasExplicitTimestampPlacement && legacyOutTimecodes != null)
          ? legacyOutTimecodes
          : undefined) ??
        false
      );
      const includeTxtSpeakers = !!(
        txtData.includeSpeakers ??
        legacyTxt.includeSpeakers ??
        data.includeSpeakerNames ??
        false
      );
      const groupBySpeaker = !!(
        txtData.groupBySpeaker ??
        legacyTxt.groupBySpeaker ??
        false
      );
      let tsPlacementRaw = String(
        explicitTimestampPlacementRaw ??
        ''
      );
      if (!tsPlacementRaw.trim()) {
        // Back-compat: older presets stored a boolean includeTimecodes.
        // New default is "none" (no timecodes).
        tsPlacementRaw = includeTxtTimecodes ? 'start-end' : 'none';
      }
      const tsPlacementUi = tsPlacementRaw.replace(/-/g, '_');

      const tcFormat = String(
        txtData.timecodeFormat ??
        data.timecodeStyle ??
        (data.dropFrame ? 'df' : 'ndf') ??
        'ndf'
      );

      const fpsOverride =
        (txtData.frameRateOverride ?? legacyTxt.frameRateOverride ?? data.fpsOverride ?? '');
      const tcStart =
        (txtData.startTimecodeOffset ?? legacyTxt.startTimecodeOffset ?? data.startTC ?? '');

      const spkEl = document.getElementById('fmt-txt-include-speaker-names');
      if (spkEl) spkEl.checked = includeTxtSpeakers;

      const grpEl = document.getElementById('fmt-txt-group-by-speaker');
      if (grpEl) grpEl.checked = groupBySpeaker;

      setDd('fmt-txt-timecode-format', tcFormat);
      setDd('fmt-txt-timestamp-placement', tsPlacementUi);

      if (!hasExplicitTimestampPlacement && legacyOutTimecodes != null) {
        const legacyTcEl = document.getElementById('out-timecodes');
        if (legacyTcEl && typeof legacyTcEl.checked === 'boolean') {
          legacyTcEl.checked = !!legacyOutTimecodes;
          try { legacyTcEl.dispatchEvent(new Event('change')); } catch {}
        }
      }

      const fpsEl3 = document.getElementById('fmt-txt-fps');
      if (fpsEl3) {
        fpsEl3.value = (fpsOverride == null) ? '' : String(fpsOverride);
        try { fpsEl3.dispatchEvent(new Event('input')); } catch {}
        try { fpsEl3.dispatchEvent(new Event('change')); } catch {}
      }

      const tcStartEl3 = document.getElementById('fmt-txt-tc-start');
      if (tcStartEl3) tcStartEl3.value = (tcStart == null) ? '' : String(tcStart);
    } catch {}

    // Legacy controls (removed from UI) — keep for backward compatibility if present
    const txtTS = document.getElementById('txt-timestamp-style');
    if (txtTS) txtTS.value = data.txtOptions?.timestampStyle || 'start-end';
    const txtGroup = document.getElementById('txt-group-by-speaker');
    if (txtGroup) txtGroup.checked = !!data.txtOptions?.groupBySpeaker;
    const txtFps = document.getElementById('transcribe-fps');
    if (txtFps) txtFps.value = data.txtOptions?.frameRateOverride || '';

    // Populate Scripted format-scoped controls
    try {
      const scriptData = (data.formats && data.formats.script) || {};
      const so = data.scriptOptions || {};

      const setDd = (id, val, defVal) => {
        const v = (val == null || val === '') ? defVal : val;
        try { setDropdownValue(id, String(v)); } catch {}
        const el = document.getElementById(id);
        if (el) {
          el.value = String(v ?? '');
          try { el.dispatchEvent(new Event('change')); } catch {}
        }
      };

      const spkNames = document.getElementById('fmt-script-include-speaker-names');
      if (spkNames) {
        spkNames.checked = !!(scriptData.includeSpeakers ?? so.includeSpeakers ?? data.includeSpeakerNames);
        try { spkNames.dispatchEvent(new Event('change')); } catch {}
      }

      const grpSpk = document.getElementById('fmt-script-group-by-speaker');
      if (grpSpk) {
        grpSpk.checked = !!(scriptData.groupBySpeaker ?? so.groupBySpeaker);
        try { grpSpk.dispatchEvent(new Event('change')); } catch {}
      }

      // Timestamp placement (Scripted) also controls includeTimecodes; fall back for older presets
      let tsPlacementRaw = String(
        scriptData.timestampPlacement ??
        so.timestampStyle ??
        ''
      ).trim();
      if (!tsPlacementRaw) {
        const legacyInclude = (scriptData.includeTimecodes ?? so.includeTimecodes);
        tsPlacementRaw = (legacyInclude === false) ? 'none' : 'start-end';
      }
      const tsPlacementUi = tsPlacementRaw.replace(/-/g, '_');
      setDd('fmt-script-timestamp-placement', tsPlacementUi, 'none');

      // Timecode format
      setDd('fmt-script-timecode-format', scriptData.timecodeFormat || 'ndf', 'ndf');

      // FPS override
      const fpsEl2 = document.getElementById('fmt-script-fps');
      if (fpsEl2) {
        fpsEl2.value = scriptData.frameRateOverride || '';
        try { fpsEl2.dispatchEvent(new Event('input')); } catch {}
        try { fpsEl2.dispatchEvent(new Event('change')); } catch {}
      }

      // Start TC
      const tcStart2 = document.getElementById('fmt-script-tc-start');
      if (tcStart2) {
        tcStart2.value = scriptData.startTimecodeOffset || '01:00:00:00';
        try { tcStart2.dispatchEvent(new Event('change')); } catch {}
      }

      // Ensure timecode controls lock/unlock based on placement
      try { applyScriptTimestampPlacementLocks(); } catch {}
    } catch {}

    const notesEl = document.getElementById('transcribe-notes');
    if (notesEl) notesEl.value = data.notes || '';

    // Preset output path restore policy:
    // - non-empty string => overwrite field + dispatch change for listeners
    // - empty/blank/omitted => leave the current UI value unchanged
    // This prevents blank legacy presets from accidentally clearing a user's
    // working destination path.
    if (Object.prototype.hasOwnProperty.call(data, 'outputPath')) {
      const rawOutputPath = typeof data.outputPath === 'string' ? data.outputPath : '';
      const presetOutputPath = rawOutputPath.trim();
      if (presetOutputPath) {
        const outputPathEl = el.outputPath || document.getElementById('transcribe-output-path');
        if (outputPathEl) {
          outputPathEl.value = rawOutputPath;
          try { outputPathEl.dispatchEvent(new Event('change')); } catch {}
        }
      }
    }

    // Webhook settings (only apply when the preset explicitly includes them)
    try {
      const hasN8nKeys =
        Object.prototype.hasOwnProperty.call(data, 'enableN8N') ||
        Object.prototype.hasOwnProperty.call(data, 'n8nUrl') ||
        Object.prototype.hasOwnProperty.call(data, 'n8nLog') ||
        Object.prototype.hasOwnProperty.call(data, 'n8nAllowPrivate');

      if (hasN8nKeys) {
        const enableN8NEl = document.getElementById('transcribe-enable-n8n');
        if (enableN8NEl) enableN8NEl.checked = !!data.enableN8N;
        const n8nUrlEl = document.getElementById('transcribe-n8n-url');
        if (n8nUrlEl) n8nUrlEl.value = data.n8nUrl || '';
        const n8nLogEl = document.getElementById('transcribe-n8n-log');
        if (n8nLogEl) n8nLogEl.checked = !!data.n8nLog;
        const allowPrivateEl = document.getElementById('transcribe-n8n-allow-private');
        if (allowPrivateEl) allowPrivateEl.checked = !!data.n8nAllowPrivate;
      }
    } catch {}
  }

  async function refreshPresetDropdown() {
    const hidden = el.presetSelect;
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

      if (!mkdir || !readdir) {
        throw new Error(tr('transcribeElectronFsApiUnavailableError', 'Electron FS API unavailable'));
      }

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
          label: window.panelPresetDefaults?.isDefaultPresetFile?.(f)
            ? tr('defaultPresetLabel', 'Default')
            : f.replace(/\.json$/i, '')
        }));
    } catch (err) {
      const msg = tr('transcribeReadPresetsFailedLog', '❌ Failed to read transcribe presets: {{error}}', {
        error: err?.message || err
      });
      logTranscribe(msg, { isError: true });
      panelLog('error', 'Failed to read presets:', { error: err?.message || err });
    }

    setupStyledDropdown('transcribe-preset', opts);
    setDropdownValue('transcribe-preset', hidden.value || '');
    window.translatePage?.();

    if (!hidden.dataset.listenerBound) {
      hidden.addEventListener('change', async () => {
        const file = hidden.value;
        if (!file) return;
        try {
          const electronApi = window.electron;
          if (typeof electronApi?.readTextFileAsync !== 'function') {
            throw new Error(tr('transcribeReadTextFileAsyncUnavailableError', 'readTextFileAsync unavailable'));
          }

          const raw = await electronApi.readTextFileAsync(
            electronApi.joinPath(presetDir, file)
          );
          const data = JSON.parse(raw);
          applyTranscribePreset(data);
          logTranscribe(tr('transcribePresetAppliedLog', '📚 Applied transcribe preset "{{file}}".', {
            file
          }), {
            fileId: window.electron.joinPath(presetDir, file)
          });
        } catch (err) {
          const msg = tr('transcribeLoadPresetFailedLog', '❌ Failed to load preset "{{file}}": {{error}}', {
            file,
            error: err?.message || err
          });
          logTranscribe(msg, { isError: true });
          panelLog('error', 'Failed to load preset', { error: err?.message || err });
        }
      });
      hidden.dataset.listenerBound = 'true';
    }
  }

  function isWatchConfigValid(cfg) {
    if (!cfg) return tr('transcribeConfigMissingError', 'No transcribe config found.');
    const resolveComparablePath = (input) => {
      if (!input) return null;
      let resolved = input;
      try {
        if (window.electron?.pathResolve) {
          resolved = window.electron.pathResolve(input);
        }
      } catch {}
      const cleaned = String(resolved).replace(/[\\/]+$/, '');
      const platform = window.electron?.platform || '';
      if (platform === 'win32' || platform === 'darwin') {
        return cleaned.toLowerCase();
      }
      return cleaned;
    };
    const isSameOrChildPath = (parent, child) => {
      const parentPath = resolveComparablePath(parent);
      const childPath = resolveComparablePath(child);
      if (!parentPath || !childPath) return false;
      if (parentPath === childPath) return true;
      const sep = typeof window.electron?.sep === 'function' ? window.electron.sep() : '/';
      if (typeof window.electron?.relative === 'function') {
        try {
          const rel = window.electron.relative(parentPath, childPath);
          if (!rel || rel === '.') return true;
          const normalizedRel = String(rel).replace(/[\\/]+/g, sep);
          if (normalizedRel === '..') return false;
          return !normalizedRel.startsWith(`..${sep}`);
        } catch {}
      }
      const prefix = parentPath.endsWith(sep) ? parentPath : `${parentPath}${sep}`;
      return childPath.startsWith(prefix);
    };
    const missing = [];
    const isWatch = !!cfg.watchMode;
    if (isWatch) {
      if (!cfg.watchFolder) missing.push(tr('transcribeFieldWatchFolder', 'Watch Folder'));
    } else {
      if (!cfg.files?.length) missing.push(tr('transcribeFieldFiles', 'Files'));
    }
    if (!cfg.outputPath) missing.push(tr('transcribeFieldOutputPath', 'Output Path'));
    if (!Object.values(cfg.outputFormats || {}).some(v => v)) {
      missing.push(tr('transcribeFieldOutputFormatSelection', 'Output Format Selection'));
    }
    if (isWatch && cfg.watchFolder && cfg.outputPath) {
      if (isSameOrChildPath(cfg.watchFolder, cfg.outputPath)) {
        return tr('transcribeOutputPathInsideWatchFolderError', 'Output Path must not be the same as or inside the Watch Folder. Choose a different output folder.');
      }
    }
    return missing.length
      ? tr('transcribeMissingFields', 'Missing: {{fields}}', { fields: missing.join(', ') })
      : true;
  }

  if (window.watchValidators) {
    window.watchValidators.transcribe = isWatchConfigValid;
  }

  // Preserve the UI skin's nested button markup.
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

  const startBtn = el.startBtn;
  const cancelBtn = el.cancelBtn;
  const selectBtn = el.selectFiles;

  // Watch Mode UI (match Ingest-style path row)
  const transcribeInputRow = document.querySelector('#transcribe .transcribe-input-row');
  const transcribeFileInfoScroll = document.getElementById('transcribe-file-info')?.closest?.('.file-info-scroll') || null;

  const syncTranscribeWatchFolderPath = () => {
    if (!el.watchFolderPath) return;
    const wf = String(el.files?.dataset?.watchFolder || el.files?.value || '').trim();
    el.watchFolderPath.value = wf;
  };

  const setTranscribeWatchUiState = isWatch => {
    try {
      if (transcribeInputRow) {
        transcribeInputRow.classList.toggle('watch-mode', !!isWatch);
      }

      // Swap between textarea (file list) and single-line watch folder display.
      if (el.files) {
        el.files.classList.toggle('hidden', !!isWatch);
        if (!isWatch) {
          // Coming back from watch mode: ensure the textarea has a sane height again.
          try { autoResize(el.files); } catch {}
        }
      }
      if (el.watchFolderPath) {
        el.watchFolderPath.classList.toggle('hidden', !isWatch);
        if (isWatch) syncTranscribeWatchFolderPath();
        else el.watchFolderPath.value = '';
      }

      // Hide the file-info grid entirely in Watch Mode.
      if (transcribeFileInfoScroll) {
        transcribeFileInfoScroll.classList.toggle('hidden', !!isWatch);
      }
    } catch {}
  };

  // Keep button labels + UI skin in sync with the Watch Mode checkbox state.
  const applyTranscribeWatchButtonState = isWatch => {
    try {
      setButtonLabel(
        selectBtn,
        isWatch ? tr('selectWatchFolder', 'Select Watch Folder') : tr('transcribeSelectFiles', 'Select Source')
      );
      setButtonLabel(startBtn, isWatch ? tr('transcribeStartWatching', 'Start Watching') : tr('startTranscribe', 'Start'));
      setButtonLabel(cancelBtn, isWatch ? tr('transcribeStopWatching', 'Stop Watching') : tr('cancelTranscribe', 'Cancel'));
      setTranscribeWatchUiState(isWatch);
    } catch {}
  };

  const refreshTranscribeWatchI18nState = () => {
    applyTranscribeWatchButtonState(!!el.watchMode?.checked);
    const cb = el.watchMode;
    const watchUnavailable = cb && (cb.disabled || (cb.dataset.watchWarned === '1' && cb.dataset.watchInit !== '1'));
    if (watchUnavailable) {
      cb.title = tr('transcribeWatchUnavailableTitle', 'Watch Mode unavailable (watch module not loaded).');
    } else if (cb) {
      cb.title = '';
    }
  };

  window.__refreshTranscribeWatchUiI18n = refreshTranscribeWatchI18nState;

  // Backup listener so the UI stays consistent even when Watch Mode is toggled programmatically.
  el.watchMode?.addEventListener('change', () => {
    applyTranscribeWatchButtonState(!!el.watchMode?.checked);
  });
  bindTranscribeI18nListenerWithRetry({
    guardKey: '__LEADAE_TRANSCRIBE_WATCH_I18N_BOUND__',
    callback: refreshTranscribeWatchI18nState,
    includeInitialized: true
  });
  refreshTranscribeWatchI18nState();

  const initWatchToggle = () => {
    const cb = el.watchMode;
    if (cb?.dataset?.watchInit === '1') return true;
    const wu = getWatchUtils();
    if (typeof wu?.initWatchToggle !== 'function') return false;
    try {
      wu.initWatchToggle({
        checkboxId: 'transcribe-watch-mode',
        startBtnId: startBtn?.id || 'start-transcribe',
        cancelBtnId: cancelBtn?.id || 'cancel-transcribe',
        panel: 'transcribe',
        onToggle: isWatch => {
          // Stash/restore previous file selections so toggling watch mode doesn't
          // accidentally treat a folder path as an input file (or vice versa).
          try {
            if (isWatch) {
              if (el.files && el.files.dataset.prevFiles == null) {
                el.files.dataset.prevFiles = String(el.files.value || '');
              }
              // Clear UI list + metadata cache when entering watch mode.
              try { transcribeFileMetaCache.clear(); } catch {}
              resetFileInfoGrid('transcribe', 'gridCols-transcribe');

              const wf = String(el.files?.dataset?.watchFolder || '').trim();
              el.files.value = wf;
              if (el.files && !el.files.classList.contains('hidden')) {
                autoResize(el.files);
              }
            } else {
              // Leaving watch mode: clear the watch folder and restore the last file list.
              if (el.files) {
                const prev = (el.files.dataset.prevFiles != null) ? String(el.files.dataset.prevFiles) : '';
                delete el.files.dataset.prevFiles;
                delete el.files.dataset.watchFolder;
                el.files.value = prev;
                if (!el.files.classList.contains('hidden')) {
                  autoResize(el.files);
                }
              }
              try { transcribeFileMetaCache.clear(); } catch {}
              resetFileInfoGrid('transcribe', 'gridCols-transcribe');
            }
          } catch {}

          // After stash/restore, sync the Watch Mode UI (path box + grid visibility + labels).
          applyTranscribeWatchButtonState(!!isWatch);
        }
      });
      if (cb) {
        cb.dataset.watchInit = '1';
        cb.disabled = false;
        cb.title = '';
      }
      return true;
    } catch (e) {
      panelLog('warn', 'initWatchToggle failed (transcribe):', { error: e?.message || e });
      return false;
    }
  };

  if (!initWatchToggle() && el.watchMode) {
    const cb = el.watchMode;
    cb.checked = false;
    cb.disabled = true;
    cb.title = tr('transcribeWatchUnavailableTitle', 'Watch Mode unavailable (watch module not loaded).');
    // Keep UI labels in their non-watch state.
    setButtonLabel(startBtn, tr('startTranscribe', 'Start'));
    setButtonLabel(cancelBtn, tr('cancelTranscribe', 'Cancel'));
    setButtonLabel(selectBtn, tr('transcribeSelectFiles', 'Select Source'));
    if (!cb.dataset.watchWarned) {
      cb.dataset.watchWarned = '1';
      logTranscribe(tr('transcribeWatchUnavailableLog', '⚠️ Watch Mode is unavailable (watch module not loaded).'));
    }
    if (!cb.dataset.watchAwaiting) {
      cb.dataset.watchAwaiting = '1';
      window.addEventListener('watch-utils-ready', () => {
        cb.disabled = false;
        const ok = initWatchToggle();
        if (!ok) {
          cb.disabled = true;
          cb.checked = false;
          cb.title = tr('transcribeWatchUnavailableTitle', 'Watch Mode unavailable (watch module not loaded).');
        }
      }, { once: true });
    }
  }

  el.selectFiles?.addEventListener('click', async () => {
    hideTranscribeToast();
    const isWatch = el.watchMode?.checked === true;

    if (isWatch) {
      let folder = null;
      try {
        const canSelect =
          (typeof window.electron?.selectFolder === 'function') ||
          (typeof ipc?.invoke === 'function');
        if (!canSelect) {
          throw new Error(tr('transcribeFolderPickerUnavailableError', 'Folder picker unavailable (IPC bridge missing).'));
        }
        const dlgTitle = tr('selectWatchFolder', 'Select Watch Folder');
        if (typeof window.electron?.selectFolder === 'function') {
          folder = await window.electron.selectFolder({ title: dlgTitle });
        } else {
          folder = await ipc?.invoke?.('select-folder', { title: dlgTitle });
        }
      } catch (err) {
        const msg = tr('transcribeOpenFolderPickerFailedAlert', '❌ Failed to open folder picker: {{error}}', { error: err?.message || err });
        logTranscribe(msg, { isError: true });
        if (el.log) appendLogLine(el.log, msg);
        showTranscribeToast(msg, { persistent: true, isError: true });
        return;
      }
      if (!folder) return;

      try { transcribeFileMetaCache.clear(); } catch {}
      resetFileInfoGrid('transcribe', 'gridCols-transcribe');

      if (el.files) {
        el.files.dataset.watchFolder = String(folder);
        el.files.value = String(folder);
        if (!el.files.classList.contains('hidden')) autoResize(el.files);
      }

      // Ensure the watch folder path is visible in the standard single-line path box.
      syncTranscribeWatchFolderPath();

      const logMsg = tr('transcribeWatchFolderSelectedLog', 'Watch folder selected. {{folder}}', { folder });
      logTranscribe(logMsg, { fileId: folder });
      if (el.log) appendLogLine(el.log, logMsg);
      scheduleTranscribeJobPreviewUpdate();
      return;
    }

    let files = null;
    try {
      const canSelect =
        (typeof window.electron?.selectFiles === 'function') ||
        (typeof ipc?.invoke === 'function');
      if (!canSelect) {
        throw new Error(tr('transcribeFilePickerUnavailableError', 'File picker unavailable (IPC bridge missing).'));
      }
      const dialogTitle = tr('transcribeSelectSourceFilesDialogTitle', 'Select Source Files');
      if (typeof window.electron?.selectFiles === 'function') {
        files = await window.electron.selectFiles({ title: dialogTitle });
      } else {
        files = await ipc?.invoke?.('select-files', { title: dialogTitle });
      }
    } catch (err) {
      const msg = tr('transcribeOpenFilePickerFailedAlert', '❌ Failed to open file picker: {{error}}', { error: err?.message || err });
      logTranscribe(msg, { isError: true });
      if (el.log) appendLogLine(el.log, msg);
      showTranscribeToast(msg, { persistent: true, isError: true });
      return;
    }
    if (files && files.length) {
      // New selection → drop any old metadata.
      try { transcribeFileMetaCache.clear(); } catch {}
      el.files.value = files.join('\n');
      autoResize(el.files);
      const selMsg = tr('transcribeFilesSelectedSummary', '{{count}} file(s) selected.', { count: files.length });
      logTranscribe(selMsg, {
        detail: files.length > 1 ? files.join('\n') : files[0]
      });
      if (el.log) appendLogLine(el.log, selMsg);
      scheduleTranscribeJobPreviewUpdate();

      const grid = prepareFileInfoGrid('transcribe');
      if (!grid) return;

      const fileNames = await Promise.all(files.map(async (f) => {
        if (typeof window.electron?.basenameAsync === 'function') {
          try { return await window.electron.basenameAsync(f); } catch {}
        }
        return window.electron.basename(f);
      }));

      await Promise.all(
        files.map(async (f, idx) => {
          const fileName = fileNames[idx] || f;
          try {
            const meta = await getFileMetadata(f);
            try { transcribeFileMetaCache.set(f, meta); } catch {}
            const container = resolveContainerLabel(meta, f);
            const v = (meta.streams || []).find(s => s.codec_type === 'video');
            const audioInfo = summarizeAudioStreams(meta.streams || []);
            const res = v
              ? `${v.width}×${v.height}`
              : (audioInfo.tracks > 0 ? getTranscribeAudioOnlyLabel() : getTranscribeNotAvailableLabel());
            const fps = formatFrameRateForGrid(meta);
            const dur = formatDuration(+meta.format?.duration || 0);
            const audioCell = `${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}`;
            appendFileInfoRow(grid, [
              makeFileInfoCell(fileName),
              makeFileInfoCell(container),
              makeFileInfoCell(res),
              makeFileInfoCell(fps),
              makeFileInfoCell(audioCell),
              makeFileInfoCell(dur)
            ]);
          } catch (err) {
            try { transcribeFileMetaCache.delete(f); } catch {}
            appendFileInfoRow(grid, [
              makeFileInfoCell(fileName),
              makeFileInfoCell(tr('transcribeFileInfoErrorCell', '❌ {{error}}', { error: String(err) }), { gridColumn: 'span 5' })
            ]);
          }
        })
      );

      setupResizableGrid(grid, 'gridCols-transcribe');
    } else {
      try { transcribeFileMetaCache.clear(); } catch {}
      el.files.value = '';
      autoResize(el.files);
      resetFileInfoGrid('transcribe', 'gridCols-transcribe');
      scheduleTranscribeJobPreviewUpdate();
    }
  });

  el.outputSelect?.addEventListener('click', async () => {
    hideTranscribeToast();
    let folder = null;
    try {
      const canSelect =
        (typeof window.electron?.selectFolder === 'function') ||
        (typeof ipc?.invoke === 'function');
      if (!canSelect) {
        throw new Error(tr('transcribeFolderPickerUnavailableError', 'Folder picker unavailable (IPC bridge missing).'));
      }
      const outputTitle = tr('transcribeSelectOutputFolderDialogTitle', 'Select Output Folder');
      if (typeof window.electron?.selectFolder === 'function') {
        folder = await window.electron.selectFolder({ title: outputTitle });
      } else {
        folder = await ipc?.invoke?.('select-folder', { title: outputTitle });
      }
    } catch (err) {
      const msg = tr('transcribeSelectOutputFolderFailedAlert', '❌ Failed to select output folder: {{error}}', { error: err?.message || err });
      logTranscribe(msg, { isError: true });
      if (el.log) appendLogLine(el.log, msg);
      showTranscribeToast(msg, { persistent: true, isError: true });
      return;
    }
    if (folder) {
      el.outputPath.value = folder;
      const logMsg = tr('transcribeOutputFolderSetLog', '📁 Output folder set to: {{folder}}', { folder });
      logTranscribe(logMsg, { fileId: folder });
      if (el.log) appendLogLine(el.log, logMsg);
      scheduleTranscribeJobPreviewUpdate();
    }
  });

el.startBtn?.addEventListener('click', async () => {
  hideTranscribeToast();
  let config;
  try {
    const fmtSel = document.getElementById('transcribe-output-formats');
    if (fmtSel?.value === 'scc') {
      syncSccPrereqsFromUi();
      updateDisabledOutputFormats();
    }
    config = await gatherConfig();
  } catch (err) {
    const msg = tr('transcribeBuildConfigFailedAlert', '❌ Failed to build transcribe config: {{error}}', { error: err?.message || err });
    logTranscribe(msg, { isError: true });
    if (el.log) appendLogLine(el.log, msg);
    panelLog('error', msg, { error: err?.stack || String(err) });
    showTranscribeToast(msg, { persistent: true, isError: true });
    return;
  }
  const dfValidation = config.__dfValidation;
  if (dfValidation?.coercedToNdf) {
    const defaultMsg = tr(
      'transcribeDropFrameNotSupportedSelectedRate',
      'Drop-frame timecode is not supported for the selected frame rate.'
    );
    const warnMsg = tr(
      'transcribeDropFrameContinueWithNdfPrompt',
      '{{message}}\n\nContinue with non-drop-frame timecode?',
      { message: dfValidation.message || defaultMsg }
    );
    logTranscribe(tr('transcribeDropFrameWarningLog', '⚠️ {{message}}', {
      message: dfValidation.message || defaultMsg
    }), { isError: false });
    const proceed = await confirmTranscribeAction({
      title: tr('transcribe', 'Transcribe'),
      message: warnMsg,
      okLabel: tr('continue', 'Continue'),
      cancelLabel: tr('cancelTranscribe', 'Cancel'),
      type: 'warning'
    });
    if (!proceed) return;
  }

  if (config.enableN8N) {
    const n8nValidation = validateN8nUrl(config.n8nUrl, {
      allowPrivate: config.n8nAllowPrivate
    });
    if (!n8nValidation.valid) {
      const msg = n8nValidation.message || tr('transcribeN8nWebhookInvalidAlert', '❌ Invalid n8n webhook URL.');
      logTranscribe(msg, { isError: true });
      if (el.log) appendLogLine(el.log, msg);
      showTranscribeToast(msg, { persistent: true, isError: true });
      focusTranscribeElement(el.n8nUrl, { selectText: true });
      return;
    }
  }
  const isWatchMode = document.getElementById('transcribe-watch-mode')?.checked;
  if (isWatchMode) {
    const validation = typeof isWatchConfigValid === 'function'
      ? isWatchConfigValid(config)
      : true;
    if (validation !== true) {
      const errMsg = typeof validation === 'string' ? validation : tr('transcribeWatchConfigInvalidAlert', 'Invalid watch configuration.');
      logTranscribe(`❌ ${errMsg}`, { isError: true });
      if (el.log) appendLogLine(el.log, `❌ ${errMsg}`);
      showTranscribeToast(errMsg, { persistent: true, isError: true });
      return;
    }

    setTranscribeControlsDisabled(true);
    el.cancelBtn.disabled = false;

    try {
      await ensureWhisperAssetReadyForConfig(config);
      restoreTranscribeSummaryAfterAssetUpdate();
    } catch (error) {
      handleTranscribeAssetPrefetchFailure(error, config);
      setTranscribeControlsDisabled(false);
      el.cancelBtn.disabled = true;
      try { delete el.cancelBtn.dataset.watchActive; } catch {}
      setTranscribeWatchSessionRunning(false);
      setTranscribeWatchEyesActive(false);
      try { if (el.watchMode) el.watchMode.disabled = false; } catch {}
      return;
    }

    const wu = getWatchUtils();
    if (typeof wu?.startWatch !== 'function') {
      const errMsg = tr(
        'transcribeWatchUnavailableAlert',
        '❌ Watch Mode is unavailable (watch module not loaded).'
      );
      logTranscribe(errMsg, { isError: true });
      showTranscribeToast(errMsg, { persistent: true, isError: true });
      setTranscribeControlsDisabled(false);
      el.cancelBtn.disabled = false;
      try { delete el.cancelBtn.dataset.watchActive; } catch {}
      setTranscribeWatchSessionRunning(false);
      try { if (el.watchMode) el.watchMode.disabled = false; } catch {}
      if (el.watchMode) {
        el.watchMode.checked = false;
        try { el.watchMode.dispatchEvent(new Event('change')); } catch {}
      }
      return;
    }

    try {
      await wu.startWatch('transcribe', config);
      try { el.cancelBtn.dataset.watchActive = '1'; } catch {}
      setTranscribeWatchSessionRunning(true);
      setTranscribeWatchEyesActive(true);
      try { if (el.watchMode) el.watchMode.disabled = true; } catch {}
      const startedMsg = tr('transcribeWatchStartedLog', '👀 Watch Mode started.');
      logTranscribe(startedMsg);
      if (el.log) appendLogLine(el.log, startedMsg);
    } catch (err) {
      const errMsg = tr(
        'transcribeWatchStartFailedAlert',
        '❌ Failed to start Watch Mode: {{error}}',
        { error: err?.message || err }
      );
      logTranscribe(errMsg, { isError: true });
      showTranscribeToast(
        tr(
          'transcribeWatchStartFailedAlert',
          'Failed to start Watch Mode: {{error}}',
          { error: err?.message || err }
        ),
        { persistent: true, isError: true }
      );
      setTranscribeControlsDisabled(false);
      el.cancelBtn.disabled = false;
      try { delete el.cancelBtn.dataset.watchActive; } catch {}
      setTranscribeWatchSessionRunning(false);
      try { if (el.watchMode) el.watchMode.disabled = false; } catch {}
      return;
    }
    return;
  }

  if (!config.files.length) {
    const msg = tr('transcribeSelectFilesAlert', 'Please select file(s) to transcribe.');
    logTranscribe(`❌ ${msg}`, { isError: true });
    if (el.log) appendLogLine(el.log, `❌ ${msg}`);
    showTranscribeToast(msg, { persistent: true, isError: true });
    focusTranscribeElement(el.selectFiles);
    return;
  }
  if (!config.outputPath) {
    const msg = tr('transcribeSelectOutputFolderAlert', 'Please select an output folder.');
    logTranscribe(`❌ ${msg}`, { isError: true });
    if (el.log) appendLogLine(el.log, `❌ ${msg}`);
    showTranscribeToast(msg, { persistent: true, isError: true });
    focusTranscribeElement(el.outputSelect);
    return;
  }
  if (!Object.values(config.outputFormats).some(v => v)) {
    const msg = tr('transcribeSelectOutputFormatAlert', 'Please select at least one output format.');
    logTranscribe(`❌ ${msg}`, { isError: true });
    if (el.log) appendLogLine(el.log, `❌ ${msg}`);
    showTranscribeToast(msg, { persistent: true, isError: true });
    focusTranscribeElement(document.getElementById('transcribe-output-formats'));
    return;
  }

  // UX preflight: SCC timebase guard (writer hard-fails unless fps ≈ 29.97).
  // Warn BEFORE queuing so users don't discover this only after a long run.
  if (config?.outputFormats?.scc === true) {
    try {
      const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) <= eps;
      const mismatches = [];
      const unknown = [];
      const probeFailures = [];

      const missingMeta = (config.files || []).filter(f => !transcribeFileMetaCache.has(f));
      for (const f of missingMeta) {
        try {
          const meta = await getFileMetadata(f);
          try { transcribeFileMetaCache.set(f, meta); } catch {}
        } catch (err) {
          unknown.push(f);
          probeFailures.push({ file: f, reason: err?.message || String(err) });
          logTranscribe(tr('transcribeFfprobeFailedForFileLog', '⚠️ FFprobe failed for {{file}}: {{error}}', {
            file: (window.electron?.basename ? window.electron.basename(f) : f),
            error: (err?.message || err)
          }));
        }
      }

      for (const f of (config.files || [])) {
        if (unknown.includes(f)) continue;
        const meta = transcribeFileMetaCache.get(f);
        const fps = extractNumericFpsFromMetadata(meta);
        if (!Number.isFinite(fps)) {
          unknown.push(f);
          continue;
        }
        if (!near(fps, 29.97, 0.02)) {
          mismatches.push({ file: f, fps });
        }
      }

      // NOTE: fpsOverride is optional. Avoid Number(null)/Number('') => 0,
      // which can create bogus "0 fps" SCC mismatch warnings.
      // parseFloat also tolerates legacy strings like "29.97DF".
      const overrideFps = (() => {
        const v = parseFloat(String(config?.fpsOverride ?? '').trim());
        return (Number.isFinite(v) && v > 0) ? v : null;
      })();
      const overrideMismatch = (overrideFps != null) && !near(overrideFps, 29.97, 0.02);

      if (mismatches.length || unknown.length || overrideMismatch) {
        const lines = [];
        lines.push(tr('sccPreflightRequires2997', '⚠️ SCC export requires a 29.97 fps timebase.'));

        if (mismatches.length) {
          lines.push('');
          lines.push(tr('sccPreflightDetectedNon2997', 'Detected non-29.97 video frame rates (SCC export will fail):'));
          for (const m of mismatches.slice(0, 12)) {
            const name = window.electron?.basename ? window.electron.basename(m.file) : String(m.file);
            lines.push(`- ${name}: ${m.fps}`);
          }
          if (mismatches.length > 12) {
            lines.push(tr('sccPreflightAndMore', '- …and {{count}} more', { count: mismatches.length - 12 }));
          }
        }

        if (unknown.length) {
          lines.push('');
          lines.push(tr('sccPreflightUnableDetermineFps', 'Unable to determine fps for some inputs (ffprobe failed or no video stream detected):'));
          for (const f of unknown.slice(0, 12)) {
            const name = window.electron?.basename ? window.electron.basename(f) : String(f);
            const failure = probeFailures.find(p => p.file === f);
            lines.push(`- ${name}${failure ? ` (${failure.reason})` : ''}`);
          }
          if (unknown.length > 12) {
            lines.push(tr('sccPreflightAndMore', '- …and {{count}} more', { count: unknown.length - 12 }));
          }
        }

        if (overrideMismatch) {
          lines.push('');
          lines.push(tr('sccPreflightOverrideIncompatible', 'Your FPS override is {{fps}}, which is incompatible with SCC.', { fps: overrideFps }));
        }

        lines.push('');
        lines.push(tr('sccPreflightRecommendation', 'Recommendation: transcode to 29.97, or unselect SCC output.'));
        lines.push('');
        lines.push(tr('continueAnyway', 'Continue anyway?'));

        const proceed = await confirmTranscribeAction({
          title: tr('transcribe', 'Transcribe'),
          message: lines[0],
          detail: lines.slice(1).join('\n'),
          okLabel: tr('continue', 'Continue'),
          cancelLabel: tr('cancelTranscribe', 'Cancel'),
          type: 'warning'
        });
        if (!proceed) return;
      }
    } catch (e) {
      // Preflight must never block jobs due to an internal/UI exception.
      panelLog('warn', 'SCC preflight warning failed:', { error: e?.message || String(e) });
    }
  }

  const summary = tr(
    'transcribeStartSummary',
    'Engine: {{engine}}\nLanguage: {{language}}\nOutputs: {{outputs}}\nFiles: {{count}}',
    {
      engine: config.engine,
      language: config.language,
      outputs: Object.keys(config.outputFormats).filter(k => config.outputFormats[k]).join(', '),
      count: config.files.length
    }
  );
  const confirmRun = await confirmTranscribeAction({
    title: tr('transcribe', 'Transcribe'),
    message: tr('transcribeStartConfirmPrompt', 'Start transcription?'),
    detail: summary,
    okLabel: tr('startTranscribe', 'Start'),
    cancelLabel: tr('cancelTranscribe', 'Cancel'),
    type: 'question'
  });
  if (!confirmRun) return;

  setTranscribeControlsDisabled(true);
  el.cancelBtn.disabled = false;

  try {
    await ensureWhisperAssetReadyForConfig(config);
    restoreTranscribeSummaryAfterAssetUpdate();
  } catch (error) {
    handleTranscribeAssetPrefetchFailure(error, config);
    setTranscribeControlsDisabled(false);
    el.cancelBtn.disabled = true;
    currentJobId = null;
    return;
  }

  const queueMsg = tr('transcribeQueuing', '🚀 Queuing transcription...');
  logTranscribe(queueMsg);
  if (el.log) appendLogLine(el.log, queueMsg);

  try {
    currentJobId = await ipc.invoke('queue-add-transcribe', { config });
    const queuedMsg = tr('queueJobQueued', '🗳️ {{panel}} job queued.', { panel: tr('transcribe', 'Transcribe') });
    logTranscribe(queuedMsg);
    if (el.log) appendLogLine(el.log, queuedMsg);
  } catch (err) {
    const errMsg = tr('queueJobQueueError', '❌ Queue error: {{error}}', { error: err?.message || err });
    logTranscribe(errMsg, { isError: true });
    if (el.log) appendLogLine(el.log, errMsg);
    setTranscribeControlsDisabled(false);
    el.cancelBtn.disabled = true;
    currentJobId = null;
  }
});



  function resetTranscribeFields({ clearPersisted = true } = {}) {
    hideTranscribeToast();
    if (clearPersisted) clearTranscribePersistedSettings();

    // 1) Clear text inputs & checkboxes.
    // NOTE: This intentionally clears hidden inputs too (styled dropdown values),
    // and then we re-apply known defaults below.
    document.querySelectorAll('#transcribe input, #transcribe textarea').forEach(elem => {
      if (elem.id === 'transcribe-hide-log') return;
      if (elem.id === 'transcribe-job-preview-box') return;
      if (elem.id === 'transcribe-log-output') return;
      // Post-export handoff is a workflow preference, not transient job state.
      // Preserve it across resets so repeated exports keep opening the editor.
      if (elem.id === 'transcribe-send-subtitle') return;
      if (elem.type === 'checkbox') elem.checked = false;
      else elem.value = '';
    });

    const hideLogToggle = document.getElementById('transcribe-hide-log');
    if (hideLogToggle) {
      hideLogToggle.checked = true;
      try { hideLogToggle.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    }

    const removeLeading = document.getElementById('transcribe-remove-leading-chars');
    if (removeLeading) removeLeading.checked = true;

    const setDd = (id, val) => {
      try { setDropdownValue(id, val); } catch {}
      const el = document.getElementById(id);
      if (el) {
        el.value = String(val);
        try { el.dispatchEvent(new Event('change')); } catch {}
      }
    };

    // 2) Restore single dropdowns to saved defaults (same logic as init)
    setDd('transcribe-engine', TRANSCRIBE_DEFAULTS.engine);
    setDd('transcribe-language', TRANSCRIBE_DEFAULTS.language);
    setDd('transcribe-accuracy-mode', TRANSCRIBE_DEFAULTS.accuracy);
    setDd('translate-target', TRANSCRIBE_DEFAULTS.translateTarget);
    const te = document.getElementById('translate-enable');
    if (te) te.checked = TRANSCRIBE_DEFAULTS.translateEnabled;
    const sbs = document.getElementById('translate-side-by-side');
    if (sbs) sbs.checked = TRANSCRIBE_DEFAULTS.translateSideBySide;
    setDd('transcribe-timecode-style', 'ndf');

    // Restore format-scoped dropdown defaults.
    // (Phase B) Default DF timecodes so SCC/MCC deliverables work out of the box.
    setDd('fmt-txt-timecode-format', 'df');
    setDd('fmt-txt-timestamp-placement', 'none');
    setDd('fmt-script-timestamp-placement', 'none');
    setDd('fmt-script-timecode-format', 'ndf');
    // 3) Reset single format selector
    // 3) Reset output formats selector (single selection)
    setDd('transcribe-output-formats', 'txt');

    // 3b) Reset format-specific deliverable defaults (stored preferences)
    try { if (typeof _resetSccDefaults === 'function') _resetSccDefaults(); } catch {}
    try { if (typeof _resetMccDefaults === 'function') _resetMccDefaults(); } catch {}
    try { if (typeof _resetSrtDefaults === 'function') _resetSrtDefaults(); } catch {}
    try { if (typeof _resetVttDefaults === 'function') _resetVttDefaults(); } catch {}

    // 4) Reset file list UI & progress text
    autoResize(el.files);
    const noFileMsg = tr('noFileLoaded', 'No file loaded');
    logTranscribe(noFileMsg, { isError: true });
    setLogText(el.log, '');
    writeLogElText(el.summary, '');
    if (el.summary?.tagName === 'TEXTAREA') autoResize(el.summary);
    resetFileInfoGrid('transcribe', 'gridCols-transcribe');
    el.cancelBtn.disabled = true;
    setTranscribeWatchEyesActive(false);

    // 5) Clear logs and inline status
    logTranscribe('', { detail: 'clear' });
    setLogText(el.log, '');
    writeLogElText(el.summary, '');
    if (el.summary?.tagName === 'TEXTAREA') autoResize(el.summary);
    toggleTranscribing(false);

    // 6) Make sure engine-specific disables and timecode dependencies are up-to-date
    updateDisabledOutputFormats();

    // 7) Refresh the sample preview with clean state
    // (initSamplePreview has internal guards; calling it is safe)
    try { initSamplePreview(); } catch {}
  }

  el.resetBtn?.addEventListener('click', () => {
    if (window.panelPresetDefaults?.has?.('transcribe')) {
      void window.panelPresetDefaults.resetToDefault('transcribe')
        .then(applied => {
          if (!applied) resetTranscribeFields();
          const hideLogToggle = document.getElementById('transcribe-hide-log');
          if (hideLogToggle) {
            hideLogToggle.checked = true;
            try { hideLogToggle.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
          }
        })
        .catch(() => {
          resetTranscribeFields();
        });
      return;
    }

    resetTranscribeFields();
  });

  el.saveConfig?.addEventListener('click', async () => {
    hideTranscribeToast();
    const cfg = await gatherConfig();
    delete cfg.files;
    delete cfg.watchFolder;
    const safeCfg = scrubPresetSecrets(cfg);
    const file = await ipc.invoke('save-file-dialog', {
      title: tr('transcribeSavePresetTitle', 'Save Preset'),
      defaultPath: window.electron.joinPath(presetDir, 'transcribe-config.json')
    });
    if (file) {
      try {
        const serialized = JSON.stringify(safeCfg, null, 2);
        if (typeof ipc?.writeTextFileAtomicAsync === 'function') {
          await ipc.writeTextFileAtomicAsync(file, serialized);
        } else if (typeof ipc?.writeTextFileAsync === 'function') {
          await ipc.writeTextFileAsync(file, serialized);
        } else {
          throw new Error(
            tr('transcribeWriteApiUnavailableError', 'writeTextFileAsync unavailable')
          );
        }
        ipc.send('preset-saved', 'transcribe');
        refreshPresetDropdown().catch(() => {});
        logTranscribe(tr('transcribeConfigSavedLog', '💾 Transcribe config saved to "{{file}}".', {
          file
        }), {
          fileId: file
        });
        showTranscribeToast(tr('transcribeConfigSavedAlert', 'Config saved.'));
      } catch (err) {
        const errorText = err?.message || `${err}`;
        logTranscribe(
          tr('transcribeConfigSaveFailedLog', '❌ Failed to save config "{{file}}": {{error}}', {
            file,
            error: errorText
          }),
          { isError: true }
        );
        showTranscribeToast(
          tr('transcribeConfigSaveFailedAlert', 'Failed to save config: {{error}}', {
            error: errorText
          }),
          { persistent: true, isError: true }
        );
      }
    }
  });

  el.loadConfig?.addEventListener('click', async () => {
    hideTranscribeToast();
    if (typeof ipc?.readTextFileAsync !== 'function') {
      const msg = tr('transcribeLoadPresetRequiresAsyncFsLog', '❌ Load preset requires Electron async file APIs.');
      logTranscribe(msg, { isError: true });
      showTranscribeToast(msg, { persistent: true, isError: true });
      return;
    }
    const file = await ipc.invoke('open-file-dialog', {
      title: tr('transcribeLoadPresetTitle', 'Load Preset')
    });
    if (!file) return;
    try {
      const data = JSON.parse(await ipc.readTextFileAsync(file));
      applyTranscribePreset(data);
      logTranscribe(tr('transcribeConfigLoadedLog', '📥 Loaded transcribe config from "{{file}}".', {
        file
      }), {
        fileId: file
      });
    } catch (err) {
      const errorText = err?.message || `${err}`;
      const msg = tr('transcribeConfigLoadFailedLog', '❌ Failed to load config from "{{file}}": {{error}}', {
        file,
        error: errorText
      });
      logTranscribe(msg, { isError: true });
      showTranscribeToast(msg, { persistent: true, isError: true });
    }
  });

  el.cancelBtn?.addEventListener('click', async () => {
    if (activeTranscribeAssetController && !activeTranscribeAssetController.settled) {
      const cancelMsg = tr('transcribeModelDownloadCancelRequested', '⛔ Transcription model download cancel requested...');
      logTranscribe(cancelMsg);
      if (el.log) appendLogLine(el.log, cancelMsg);
      try {
        await cancelActiveTranscribeAssetRequest();
      } catch (err) {
        const errMsg = tr('transcribeModelDownloadCancelFailed', '❌ Failed to cancel transcription model download: {{error}}', {
          error: err?.message || err
        });
        logTranscribe(errMsg, { isError: true });
        if (el.log) appendLogLine(el.log, errMsg);
        showTranscribeToast(errMsg, { persistent: true, isError: true });
      }
      el.cancelBtn.disabled = true;
      return;
    }

    const watchActive =
      transcribeWatchSessionRunning ||
      el.cancelBtn?.dataset?.watchActive === '1' ||
      el.watchMode?.checked === true ||
      document.getElementById('transcribe-watch-mode')?.checked === true;
    if (watchActive) {
      const wu = getWatchUtils();
      try {
        if (typeof wu?.stopWatch === 'function') {
          await wu.stopWatch('transcribe');
        } else {
          logTranscribe(tr('transcribeWatchStopUnavailableLog', '⚠️ Watch Mode stop requested, but the watch module is unavailable.'));
        }
      } catch (err) {
        panelLog('warn', 'stopWatch failed (transcribe):', { error: err?.message || err });
      }
      const stopMsg = tr('transcribeWatchStoppedLog', '🛑 Watch Mode stopped.');
      logTranscribe(stopMsg);
      if (el.log) appendLogLine(el.log, stopMsg);
      el.cancelBtn.disabled = true;
      setTranscribeWatchEyesActive(false);
      try { delete el.cancelBtn.dataset.watchActive; } catch {}
      setTranscribeWatchSessionRunning(false);
      try { if (el.watchMode) el.watchMode.disabled = false; } catch {}
      if (el.watchMode) {
        el.watchMode.checked = false;
        try { el.watchMode.dispatchEvent(new Event('change')); } catch {}
      }
      setTranscribeControlsDisabled(false);
      return;
    }

    const cancelMsg = tr('transcribeCancelRequestedLog', '⛔ Cancel requested...');
    logTranscribe(cancelMsg);
    if (el.log) appendLogLine(el.log, cancelMsg);
    try {
      // Keep the current job ID until we receive the queue cancelled/completed signal,
      // otherwise late log/progress events can show up as "unscoped" noise.
      cancelPendingJobId = currentJobId;
      await ipc.invoke('queue-cancel-job', currentJobId);
    } catch (err) {
      const cancelErr = tr('transcribeCancelErrorLog', '❌ Cancel error: {{error}}', {
        error: err?.message || `${err}`
      });
      logTranscribe(cancelErr, { isError: true });
      if (el.log) appendLogLine(el.log, cancelErr);
    }
    el.cancelBtn.disabled = true;
  });

  // ────────────────────────────────────────────────────────────
  // SCC QC “stamp” (prevents the "Export SCC did nothing" spiral)
  // We can only reliably declare PASS/FAIL when the user chose a
  // gated deliverable mode (gate_write / gate_block).
  // ────────────────────────────────────────────────────────────
  function _normalizeSccExportPolicy(raw) {
    try {
      const api = window.qcDeliveryPrefs;
      if (api && typeof api.normalizeExportPolicy === 'function') {
        return api.normalizeExportPolicy(raw, '');
      }
    } catch (err) {
      panelLog('warn', '[scc] normalizeExportPolicy lookup failed', { error: err?.message || String(err) });
    }
    return '';
  }

  function _sccModeLabel(policy) {
    if (policy === 'gate_write' || policy === 'gate_block') {
      return tr('transcribeSccModeDelivery', 'Delivery');
    }
    return tr('transcribeSccModeDraft', 'Draft');
  }

  function _maybeStampSccQc(job, ok) {
    const cfg = job?.config || {};
    if (!cfg?.outputFormats?.scc) return;

    const policy = _normalizeSccExportPolicy(cfg?.sccOptions?.exportPolicy);
    if (!(policy === 'gate_write' || policy === 'gate_block')) return;

    const modeLabel = _sccModeLabel(policy);

    if (ok) {
      const msg = tr('transcribeSccQcExportedPassed', '✅ SCC exported — QC PASSED ({{mode}})', { mode: modeLabel });
      logTranscribe(msg);
      if (el.log) appendLogLine(el.log, msg);
      return;
    }

    const errText = String(
      job?.error || job?.errorMessage || job?.message || job?.reason || ''
    ).trim();

    let reportPath = '';
    let m = errText.match(/SCC:\s*([^•]+)\s*•\s*Report:\s*(.+)$/i);
    if (m) {
      reportPath = String(m[2] || '').trim();
    } else {
      m = errText.match(/Report:\s*(.+)$/i);
      if (m) reportPath = String(m[1] || '').trim();
    }

    const base = (policy === 'gate_block')
      ? tr('transcribeSccQcNotExportedFailed', '⛔ SCC NOT exported — QC FAILED ({{mode}})', { mode: modeLabel })
      : tr('transcribeSccQcExportedFailed', '⚠️ SCC exported — QC FAILED ({{mode}})', { mode: modeLabel });

    const msg = reportPath
      ? tr('transcribeSccQcWithReport', '{{base}} → {{report}}', { base, report: reportPath })
      : base;
    logTranscribe(msg, { isError: true });
    if (el.log) appendLogLine(el.log, msg);
  }

  if (typeof ipc !== 'undefined' && ipc.on) {
    ipc.on('queue-job-start', (_e, job) => {
      if (!job || typeof job !== 'object') {
        panelLog('warn', 'Malformed payload received on queue-job-start', { job });
        return;
      }
      if (job?.panel !== 'transcribe') return;
      if (job?.id != null) currentJobId = String(job.id);
      cancelPendingJobId = null;
      toggleTranscribing(true);
    });
    // Route logs to the Log Viewer and mirror them into the panel log box.
    ipc.on('watch-log', (_e, msg) => {
      const isDevUi = (window.electron?.isPackaged === false)
        || (window.electron?.DEBUG_UI === true)
        || (window.DEBUG_UI === true);
      if (!isDevUi) return;
      const line = msg == null ? '' : String(msg);
      if (!line.trim()) return;
      const watchPrefix = tr('transcribeWatchLogPrefix', '[watch]');
      const watchLine = `${watchPrefix} ${line}`;
      logTranscribe(watchLine);
      if (el.log) appendLogLine(el.log, watchLine);
    });
    ipc.on('transcribe-log-message', (_e, data) => {
      const payload = (data && typeof data === 'object') ? data : {};
      const rawMsg = payload.msg ?? payload.message ?? (typeof data === 'string' ? data : '');
      const msg = String(rawMsg ?? '').trim();
      if (!msg) return;

      const payloadJobId = payload.jobId != null ? String(payload.jobId) : '';
      const activeJobId = currentJobId != null ? String(currentJobId) : '';
      const cancelJobId = cancelPendingJobId != null ? String(cancelPendingJobId) : '';
      const hasTrackedJob = !!activeJobId || !!cancelJobId;

      // Job-valid only: if we're tracking a job, ignore other jobs and untagged noise.
      if (hasTrackedJob) {
        if (!payloadJobId) return;
        if (payloadJobId !== activeJobId && payloadJobId !== cancelJobId) return;
      } else if (payloadJobId) {
        // Adopt the id so subsequent events stay consistent (watch mode / edge cases).
        currentJobId = payloadJobId;
      }

      const isDevUi = (window.electron?.isPackaged === false)
        || (window.electron?.DEBUG_UI === true)
        || (window.DEBUG_UI === true);

      const level = String(
        payload.level || (payload.isWarning ? 'warn' : payload.isError ? 'error' : 'info')
      ).toLowerCase();
      if (level === 'debug' && !isDevUi) return;

      const stage = payload.stage != null ? String(payload.stage).trim() : '';
      const stagePrefixTemplate = tr('transcribeLogStagePrefix', '[{{stage}}] ', { stage });
      const prefix = (isDevUi && stage)
        ? String(stagePrefixTemplate).replace('{{stage}}', stage)
        : '';

      logTranscribe(prefix + msg, {
        level,
        isError: !!payload.isError || level === 'error',
        isWarning: !!payload.isWarning || level === 'warn' || level === 'warning',
        jobId: payloadJobId,
        stage,
        fileId: payload.fileId || '',
        detail: isDevUi ? (payload.detail || '') : '',
        meta: isDevUi ? (payload.meta || undefined) : undefined
      });

      if (el.log) appendLogLine(el.log, prefix + msg);

      // DEV-only: attach detail/meta in a clipped secondary line.
      if (isDevUi) {
        const detail = typeof payload.detail === 'string' ? payload.detail.trim() : '';
        if (detail && detail !== '{}') {
          const clipped = detail.length > 800 ? detail.slice(0, 800) + '…' : detail;
          if (el.log) {
            appendLogLine(
              el.log,
              tr('transcribeLogDetailLine', '↳ {{detail}}', { detail: clipped })
            );
          }
        }
      }
    });
    ipc.on('queue-job-progress', (_e, payload) => {
      if (!payload || typeof payload !== 'object') {
        panelLog('warn', 'Malformed payload received on queue-job-progress', { payload });
        return;
      }
      if (payload?.panel !== 'transcribe') return;

      const payloadId = payload?.id != null
        ? String(payload.id)
        : (payload?.jobId != null ? String(payload.jobId) : '');
      if (payloadId) {
        const activeId = currentJobId != null ? String(currentJobId) : '';
        const cancelId = cancelPendingJobId != null ? String(cancelPendingJobId) : '';
        const hasActive = !!activeId || !!cancelId;
        if (hasActive && payloadId !== activeId && payloadId !== cancelId) return;
        if (!activeId) currentJobId = payloadId;
      }

      const panel = document.getElementById('transcribe');
      if (!panel || panel.classList.contains('hidden')) return;
      // Indeterminate progress: keep inline loader visible
      toggleTranscribing(true);
    });
    ipc.on('queue-job-complete', async (_e, job) => {
      if (!job || typeof job !== 'object') {
        panelLog('warn', 'Malformed payload received on queue-job-complete', { job });
        return;
      }
      if (job?.panel !== 'transcribe') return;

      const cfg = (job?.config && typeof job.config === 'object') ? job.config : null;
      // IMPORTANT: derive the post-action from the submitted job config, not the live DOM.
      // The panel reset path can run before this handler finishes.
      const auto = !!(cfg?.postActions?.sendToSubtitle ?? document.getElementById('transcribe-send-subtitle')?.checked);

      if (job?.id != null && cancelPendingJobId != null && String(cancelPendingJobId) === String(job.id)) {
        cancelPendingJobId = null;
      }
      currentJobId = null;
      const watchActive = transcribeWatchSessionRunning || el.watchMode?.checked || el.cancelBtn?.dataset?.watchActive === '1';
      if (!watchActive) {
        setTranscribeControlsDisabled(false);
      }
      toggleTranscribing(false);
      if (watchActive) {
        // In watch mode the Cancel button doubles as “Stop Watching”.
        // renderer.js (global queue handlers) disables cancel buttons on completion,
        // which would strand the panel in watch mode (watch checkbox is disabled).
        // Ensure the Stop Watching control remains usable.
        if (el.cancelBtn) el.cancelBtn.disabled = false;
        const watchMsg = tr('transcribeWatchWaitingLog', '👀 Watch Mode active — waiting for new files.');
        logTranscribe(watchMsg);
        if (el.log) appendLogLine(el.log, watchMsg);
      } else {
        resetTranscribeFields();
      }
      try { _maybeStampSccQc(job, true); } catch {}
      if (!auto) return;

      try {
  const mediaPath = Array.isArray(cfg?.files) ? cfg.files[0] : undefined;
  const preferredExts = (() => {
    const out = cfg?.outputFormats || {};
    if (out.srt) return ['.srt'];
    if (out.vtt) return ['.vtt'];
    if (out.scc) return ['.scc'];
    if (out.mcc) return ['.mcc'];
    return null;
  })();
  if (!preferredExts) return;

  const findPayload = {
    outputPath: cfg?.outputPath,
    mediaPath,
    preferredExts
  };

  const guess = typeof ipc.invoke === 'function'
    ? await ipc.invoke('subtitle-editor-find-latest', findPayload)
    : null;
  if (!guess) return;

  const openOpts =
    typeof guess === 'string'
      ? { sourcePath: guess }
      : (guess && typeof guess === 'object' ? { ...guess } : null);
  if (!openOpts || !openOpts.sourcePath) return;
  if (mediaPath) openOpts.mediaPath = mediaPath;

  // Carry the exact format/QC options from the Transcribe job into the Subtitle Editor.
  if (cfg) {
    if (cfg.formats) openOpts.formats = cfg.formats;
    if (cfg.srtOptions) openOpts.srtOptions = cfg.srtOptions;
    if (cfg.vttOptions) openOpts.vttOptions = cfg.vttOptions;
    if (cfg.sccOptions) openOpts.sccOptions = cfg.sccOptions;
    if (cfg.mccOptions) openOpts.mccOptions = cfg.mccOptions;
  }

  // Sync QC/delivery prefs from this panel to the subtitle editor window's localStorage.
  try {
    const api = window.qcDeliveryPrefs;
    if (api && typeof api.snapshotStorage === 'function') {
      openOpts.qcDeliverySnapshot = api.snapshotStorage(localStorage);
    }
  } catch {}

  await window.subtitleEditor?.open(openOpts);
} catch (err) {
        panelLog('error', 'Failed to auto-open subtitle editor window:', { error: err?.message || err });
      }
    });
    ipc.on('queue-job-failed', async (_e, job) => {
      if (!job || typeof job !== 'object') {
        panelLog('warn', 'Malformed payload received on queue-job-failed', { job });
        return;
      }
      if (job?.panel !== 'transcribe') return;

      const cfg = (job?.config && typeof job.config === 'object') ? job.config : null;
      const auto = !!(cfg?.postActions?.sendToSubtitle ?? document.getElementById('transcribe-send-subtitle')?.checked);

      if (job?.id != null && cancelPendingJobId != null && String(cancelPendingJobId) === String(job.id)) {
        cancelPendingJobId = null;
      }
      currentJobId = null;
      const watchActive = transcribeWatchSessionRunning || el.watchMode?.checked || el.cancelBtn?.dataset?.watchActive === '1';
      if (!watchActive) {
        setTranscribeControlsDisabled(false);
      } else {
        // Keep Stop Watching available even after global queue handlers disable cancel buttons.
        if (el.cancelBtn) el.cancelBtn.disabled = false;
      }
      toggleTranscribing(false);
      try { _maybeStampSccQc(job, false); } catch {}

      // Surface the failure reason in the panel (otherwise it looks like "failed with no reason").
      try {
        const errText = String(job?.error?.message || job?.error || job?.errorMessage || job?.message || job?.reason || '').trim();
        const logPath = String(job?.result?.structuredLogPath || job?.result?.archivePath || '').trim();
        const idTag = job?.id ? ` (${job.id})` : '';
        const base = tr('transcribeJobFailedSummary', '❌ Job failed{{idTag}}{{errorPart}}{{logPart}}', { idTag, errorPart: errText ? ` — ${errText}` : '', logPart: logPath ? ` • Log: ${logPath}` : '' });

        logTranscribe(base, { isError: true });
        if (job?.error && typeof job.error === 'object') {
          logTranscribe(
            tr('transcribeJobFailedDiagnosticsLog', 'Diagnostics: {{payload}}', {
              payload: JSON.stringify(job.error),
            }),
            { isError: true }
          );
        }

        if (el.log) {
          const existing = readLogElText(el.log);
          // Avoid duplicating the exact same line.
          if (!existing.includes(base)) {
            appendLogLine(el.log, base);
          }
        }
      } catch {}

      // Even on failure, try to open whatever outputs were written so users can fix QC.
      if (!auto) return;

      try {
  const mediaPath = Array.isArray(cfg?.files) ? cfg.files[0] : undefined;
  const preferredExts = (() => {
    const out = cfg?.outputFormats || {};
    if (out.srt) return ['.srt'];
    if (out.vtt) return ['.vtt'];
    if (out.scc) return ['.scc'];
    if (out.mcc) return ['.mcc'];
    return null;
  })();
  if (!preferredExts) return;

  const findPayload = {
    outputPath: cfg?.outputPath,
    mediaPath,
    preferredExts
  };

  const guess = typeof ipc.invoke === 'function'
    ? await ipc.invoke('subtitle-editor-find-latest', findPayload)
    : null;
  if (!guess) return;

  const openOpts =
    typeof guess === 'string'
      ? { sourcePath: guess }
      : (guess && typeof guess === 'object' ? { ...guess } : null);
  if (!openOpts || !openOpts.sourcePath) return;
  if (mediaPath) openOpts.mediaPath = mediaPath;

  // Carry the exact format/QC options from the Transcribe job into the Subtitle Editor.
  if (cfg) {
    if (cfg.formats) openOpts.formats = cfg.formats;
    if (cfg.srtOptions) openOpts.srtOptions = cfg.srtOptions;
    if (cfg.vttOptions) openOpts.vttOptions = cfg.vttOptions;
    if (cfg.sccOptions) openOpts.sccOptions = cfg.sccOptions;
    if (cfg.mccOptions) openOpts.mccOptions = cfg.mccOptions;
  }

  // Sync QC/delivery prefs from this panel to the subtitle editor window's localStorage.
  try {
    const api = window.qcDeliveryPrefs;
    if (api && typeof api.snapshotStorage === 'function') {
      openOpts.qcDeliverySnapshot = api.snapshotStorage(localStorage);
    }
  } catch {}

  await window.subtitleEditor?.open(openOpts);
} catch (err) {
        panelLog('error', 'Failed to auto-open subtitle editor after failed job:', { error: err?.message || err });
      }
    });
    ipc.on('queue-job-cancelled', (_e, job) => {
      if (!job || typeof job !== 'object') {
        panelLog('warn', 'Malformed payload received on queue-job-cancelled', { job });
        return;
      }
      if (job?.panel !== 'transcribe') return;
      if (job?.id != null && cancelPendingJobId != null && String(cancelPendingJobId) === String(job.id)) {
        cancelPendingJobId = null;
      }
      currentJobId = null;
      const watchActive = transcribeWatchSessionRunning || el.watchMode?.checked || el.cancelBtn?.dataset?.watchActive === '1';
      if (!watchActive) {
        setTranscribeControlsDisabled(false);
      }
      toggleTranscribing(false);
      if (watchActive) {
        // Keep Stop Watching available even after global queue handlers disable cancel buttons.
        if (el.cancelBtn) el.cancelBtn.disabled = false;
        const watchMsg = tr('transcribeWatchWaitingLog', '👀 Watch Mode active — waiting for new files.');
        logTranscribe(watchMsg);
        if (el.log) appendLogLine(el.log, watchMsg);
      } else {
        resetTranscribeFields();
      }
    });
    ipc.on('transcribe-discrepancies', (_e, discrepancies) => {
      const start = () => window.reconcileDiscrepancies(discrepancies);
      if (typeof window.reconcileDiscrepancies === 'function') {
        start();
      } else {
        loadPanelScript('reconcile');
        window.addEventListener('reconcile-ready', start, { once: true });
      }
    });
  }

document.addEventListener('DOMContentLoaded', () => {
  try { _attachSubtitlePopoutButton(); } catch {}
  try { renderTranscribeEngineTooltip(); } catch {}
  try { renderTranscribeOverviewTooltip(); } catch {}
});

function renderTranscribeEngineTooltip() {
  const engineSettingsTooltip = document.querySelector('#transcribe #transcribe-engine-tooltip');
  if (!engineSettingsTooltip) return;

  engineSettingsTooltip.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header">${tr('transcribeTooltipEngineHeader', 'ENGINE SETTINGS')}</div>

      <div class="tooltip-section">
        <ul class="tooltip-list">
          <li><strong>${tr('transcribeTooltipEngineWhisperxLabel', 'WhisperX')}</strong> - ${tr('transcribeTooltipEngineWhisperxDescription', 'Intended for detailed timings and stable output. Accuracy mode applies here.')}</li>
          <li><strong>${tr('transcribeTooltipEngineWhisperapiLabel', 'WhisperAPI')}</strong> - ${tr('transcribeTooltipEngineWhisperapiDescription', 'Intended for workflows built around an external API/service for transcription and translation, so you can reuse an existing ASR provider.')}</li>
          <li><strong>${tr('transcribeTooltipEngineLeadAiLabel', 'Lead AI')}</strong> - ${tr('transcribeTooltipEngineLeadAiDescription', "Lead AE's built-in local engine (whisper.cpp). English is available by default; non-English requires a multilingual model.")}</li>
        </ul>
      </div>
    </div>
  `;
}

function renderTranscribeOverviewTooltip() {
  const transcribeOverview = document.querySelector('#transcribe #transcribe-overview-tooltip');
  if (!transcribeOverview) return;

  transcribeOverview.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header">${tr('transcribeTooltipOverviewHeader', 'TRANSCRIBE PANEL — Technical Overview')}</div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">${tr('transcribeTooltipOverviewCoreTitle', 'Core capabilities')}</span>
        <ul class="tooltip-list">
          <li>${tr('transcribeTooltipOverviewCoreBullet1', 'Runs batch transcription on audio and video sources using the selected engine.')}</li>
          <li>${tr('transcribeTooltipOverviewCoreBullet2', 'Produces transcripts, captions, and structured JSON suitable for downstream tools.')}</li>
          <li>${tr('transcribeTooltipOverviewCoreBullet3', 'Can route results directly into the Subtitle Editor for review and polish.')}</li>
        </ul>
      </div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">${tr('transcribeTooltipOverviewIoTitle', 'Inputs / outputs')}</span>
        <ul class="tooltip-list">
          <li>${tr('transcribeTooltipOverviewIoBullet1', 'Inputs: media files or watch folders, engine selection, language / accuracy mode.')}</li>
          <li>${tr('transcribeTooltipOverviewIoBullet2', 'Outputs: TXT, SRT, VTT, SCC, MCC, Script exports (CSV), and burn-in MP4 (when enabled).')}</li>
        </ul>
      </div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle">${tr('transcribeTooltipOverviewUnderHoodTitle', 'Under the hood')}</span>
        <ul class="tooltip-list">
          <li>${tr('transcribeTooltipOverviewUnderHoodBullet1', 'Uses engine-specific pipelines (WhisperX, Whisper API, or Lead AI) configured by accuracy mode.')}</li>
          <li>${tr('transcribeTooltipOverviewUnderHoodBullet2', 'Applies global timecode / FPS options and per-format settings before rendering outputs.')}</li>
          <li>${tr('transcribeTooltipOverviewUnderHoodBullet3', 'Can emit webhooks and logs so transcription jobs are visible to automation and ops.')}</li>
        </ul>
      </div>
    </div>
  `;
}

function renderTranscribeTooltips() {
  renderTranscribeEngineTooltip();
  renderTranscribeOverviewTooltip();
}

function bindTranscribeI18nListenerWithRetry({
  guardKey,
  callback,
  includeInitialized = true,
  includeLoaded = true,
  maxTries = 50,
  intervalMs = 100
} = {}) {
  if (!guardKey || typeof callback !== 'function') return;
  if (window[guardKey]) return;
  window[guardKey] = true;

  const attach = () => {
    const i18n = window.i18n;
    if (!i18n?.on) return false;
    try {
      i18n.on('languageChanged', callback);
      if (includeInitialized) i18n.on('initialized', callback);
      if (includeLoaded) i18n.on('loaded', callback);
    } catch {}
    if (i18n.isInitialized) {
      try { callback(); } catch {}
    }
    return true;
  };

  if (attach()) return;

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (attach() || tries >= maxTries) clearInterval(timer);
  }, intervalMs);
}

function bindTranscribeTooltipI18nRefresh() {
  bindTranscribeI18nListenerWithRetry({
    guardKey: '__LEADAE_TRANSCRIBE_TOOLTIP_I18N_BOUND__',
    callback: renderTranscribeTooltips,
    includeInitialized: true
  });
}

renderTranscribeTooltips();
bindTranscribeTooltipI18nRefresh();

if (window.panelPresetDefaults && !window.__LEAD_TRANSCRIBE_PRESET_DEFAULTS_REGISTERED__) {
  window.__LEAD_TRANSCRIBE_PRESET_DEFAULTS_REGISTERED__ = true;
  window.panelPresetDefaults.register({
    panelId: 'transcribe',
    presetInputId: 'transcribe-preset',
    refreshDropdown: () => refreshPresetDropdown(),
    applyPackagedDefaults: () => resetTranscribeFields({ clearPersisted: false }),
    buildPackagedDefaultPreset: () => gatherConfig({ silentDropFrameValidation: true }),
    applyPreset: data => applyTranscribePreset(data)
  });
}

if (typeof module !== 'undefined') {
  module.exports = { gatherConfig, isWatchConfigValid, applyTranscribePreset, refreshPresetDropdown };
}

})();
