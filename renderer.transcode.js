(() => {


// setupStyledDropdown / setDropdownValue are provided by the shared renderer bootstrap (eslint globals).
  // Collapse all detail sections on load
document.querySelectorAll('#transcode details').forEach(section => {
  section.open = false;
});

if (typeof ipc === 'undefined') {
  var ipc = window.ipc ?? window.electron;
}

// Watch mode utilities can be missing (or load later) depending on bundling/load order.
// Always read from window at the call site so we can degrade gracefully.
const getWatchUtils = () => window.watchUtils;

const PANEL_ID = 'transcode';

function panelLog(level, message, meta) {
  const formatted = `[${PANEL_ID}] [${level.toUpperCase()}] ${message}`;
   
  console[level === 'error' ? 'error' : 'log'](formatted, meta || {});
}

// Ensure the Codex API is reachable in the renderer.
// Some builds expose Codex on window.codex; others expose only window.electron.invoke.
// Transcode relies on Codex for capability-driven dropdowns and compatibility filtering.
(function ensureCodexBridge() {
  const inv = window.electron?.invoke || window.ipc?.invoke || ipc?.invoke;
  if (typeof inv !== 'function') return;

  const existing = (window.codex && typeof window.codex === 'object') ? window.codex : {};
  const call = (channel, payload) => inv(channel, payload);

  window.codex = {
    ...existing,
    listFormats: (typeof existing.listFormats === 'function')
      ? existing.listFormats
      : () => call('codex:list-formats'),
    listAudioCodecs: (typeof existing.listAudioCodecs === 'function')
      ? existing.listAudioCodecs
      : () => call('codex:list-audio-codecs'),
    getCompatibility: (typeof existing.getCompatibility === 'function')
      ? existing.getCompatibility
      : (format) => call('codex:get-compatibility', { format }),
    getAudioConstraints: (typeof existing.getAudioConstraints === 'function')
      ? existing.getAudioConstraints
      : (codec) => call('codex:get-audio-constraints', { codec }),
    isAudioContainerValid: (typeof existing.isAudioContainerValid === 'function')
      ? existing.isAudioContainerValid
      : (codec, container) => call('codex:is-audio-container-valid', { codec, container }),
    getSpec: (typeof existing.getSpec === 'function')
      ? existing.getSpec
      : () => call('codex:get-spec'),
    getFormatCapabilities: (typeof existing.getFormatCapabilities === 'function')
      ? existing.getFormatCapabilities
      : (format) => call('codex:get-format-capabilities', { format })
  };
})();

function formatFallback(template, vars) {
  if (!template || !vars) return template;
  return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return '';
  });
}


function buildTranscodePreflightFragments(params = {}) {
  const estimateMethod = String(params.estimateMethod || '').trim();
  const method = estimateMethod
    ? t('transcodePreflightMethodSuffix', ' ({{estimateMethod}})', { estimateMethod })
    : '';

  const estimatedFiles = Number(params.estimatedFiles);
  const totalFiles = Number(params.totalFiles);
  let batchNote = '';
  if (Number.isFinite(totalFiles) && totalFiles > 1) {
    if (Number.isFinite(estimatedFiles) && estimatedFiles > 0 && estimatedFiles !== totalFiles) {
      batchNote = t(
        'transcodePreflightBatchNotePartial',
        ' (sum of {{estimatedFiles}}/{{totalFiles}} files)',
        { estimatedFiles, totalFiles }
      );
    } else {
      batchNote = t('transcodePreflightBatchNoteTotal', ' (sum of {{totalFiles}} files)', { totalFiles });
    }
  }

  const skippedCount = Number(params.skippedCount);
  const warningParts = [];
  if (params.hasWarning && Number.isFinite(skippedCount) && skippedCount > 0) {
    warningParts.push(
      t(
        'transcodePreflightWarningSkippedFiles',
        'Skipped {{skippedCount}} file(s) due to stat/metadata errors.',
        { skippedCount }
      )
    );
  }
  if (Number.isFinite(skippedCount) && skippedCount > 0) {
    warningParts.push(
      t(
        'transcodePreflightWarningEstimateExcludes',
        'Estimate excludes {{skippedCount}} file(s) due to metadata/stat errors.',
        { skippedCount }
      )
    );
  }

  return {
    method,
    batchNote,
    warningSuffix: warningParts.length ? ` ${warningParts.join(' ')}` : ''
  };
}

function normalizeTranscodeI18nPayload(message) {
  if (!message || typeof message !== 'object') return message;
  const key = typeof message.key === 'string' ? message.key : '';
  if (key !== 'transcodePreflightSkippedUnknownFreeSpace' && key !== 'transcodePreflightEstimatedSizeSummary') {
    return message;
  }
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const { method, batchNote, warningSuffix } = buildTranscodePreflightFragments(params);
  return {
    ...message,
    params: {
      ...params,
      method,
      batchNote,
      warningSuffix
    }
  };
}

function formatI18nPayloadMessage(message, fallback = '') {
  if (!message || typeof message !== 'object') {
    return typeof message === 'string' ? message : String(fallback || '');
  }
  const normalizedMessage = normalizeTranscodeI18nPayload(message);
  if (typeof window.formatI18nMessage === 'function') {
    return window.formatI18nMessage(normalizedMessage, fallback);
  }

  const key = typeof normalizedMessage.key === 'string' ? normalizedMessage.key : '';
  const params = normalizeI18nMessageParams(
    normalizedMessage.params && typeof normalizedMessage.params === 'object'
      ? normalizedMessage.params
      : {}
  );
  if (!key) return formatFallback(fallback || '', params);
  return t(key, fallback || key, params);
}

function normalizeI18nMessageParams(params) {
  if (!params || typeof params !== 'object') return {};
  const normalized = {};
  Object.keys(params).forEach((key) => {
    normalized[key] = normalizeI18nMessageParamValue(params[key]);
  });
  return normalized;
}

function normalizeI18nMessageParamValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeI18nMessageParamValue);
  }
  if (!value || typeof value !== 'object') return value;

  if (typeof value.key === 'string') {
    return formatI18nPayloadMessage(value, value.fallback || value.key);
  }

  const normalized = {};
  Object.keys(value).forEach((key) => {
    normalized[key] = normalizeI18nMessageParamValue(value[key]);
  });
  return normalized;
}

function resolveTranscodeMessageText(message, fallback = '') {
  if (message && typeof message === 'object') return formatI18nPayloadMessage(message, fallback);
  if (typeof message === 'string') return message;
  if (message == null) return String(fallback || '');
  return String(message);
}

const transcodeStatusLogModel = [];
let isRenderingTranscodeStatusModel = false;

function isTranscodeLogElement(logEl) {
  return !!logEl && logEl.id === 'transcode-log-output';
}

function toTranscodeStatusLogEntry(msg, fallback = '') {
  if (msg && typeof msg === 'object' && typeof msg.key === 'string') {
    const normalizedMessage = normalizeTranscodeI18nPayload(msg);
    const params = normalizedMessage.params && typeof normalizedMessage.params === 'object'
      ? { ...normalizedMessage.params }
      : {};
    return {
      kind: 'i18n',
      key: normalizedMessage.key,
      params,
      fallback: String(
        fallback
        || normalizedMessage.fallback
        || normalizedMessage.defaultValue
        || normalizedMessage.key
      )
    };
  }

  return {
    kind: 'text',
    text: resolveTranscodeMessageText(msg, fallback)
  };
}

function renderTranscodeStatusLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.kind === 'i18n') {
    return formatI18nPayloadMessage(
      { key: entry.key, params: entry.params || {} },
      entry.fallback || ''
    );
  }
  return String(entry.text || '');
}

function isSameTranscodeStatusEntry(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'i18n') {
    return a.key === b.key
      && (a.fallback || '') === (b.fallback || '')
      && JSON.stringify(a.params || {}) === JSON.stringify(b.params || {});
  }
  return String(a.text || '') === String(b.text || '');
}

function trimTranscodeStatusLogModel() {
  while (transcodeStatusLogModel.length > LOG_MAX_LINES) {
    transcodeStatusLogModel.shift();
  }
  let rendered = transcodeStatusLogModel.map(renderTranscodeStatusLogEntry);
  let totalChars = rendered.join('\n').length;
  while (transcodeStatusLogModel.length > 0 && totalChars > LOG_MAX_CHARS) {
    transcodeStatusLogModel.shift();
    rendered = transcodeStatusLogModel.map(renderTranscodeStatusLogEntry);
    totalChars = rendered.join('\n').length;
  }
}

function renderTranscodeStatusLogFromModel() {
  const logEl = document.getElementById('transcode-log-output');
  if (!logEl) return;
  const lines = transcodeStatusLogModel
    .map(renderTranscodeStatusLogEntry)
    .filter((line) => line !== '');
  isRenderingTranscodeStatusModel = true;
  try {
    setLogText(logEl, lines.join('\n'));
  } finally {
    isRenderingTranscodeStatusModel = false;
  }
}

function pushTranscodeStatusLogEntry(msg, fallback = '') {
  const entry = toTranscodeStatusLogEntry(msg, fallback);
  const text = renderTranscodeStatusLogEntry(entry);
  if (!text) return;

  const lastEntry = transcodeStatusLogModel.length
    ? transcodeStatusLogModel[transcodeStatusLogModel.length - 1]
    : null;
  if (lastEntry) {
    const lastText = renderTranscodeStatusLogEntry(lastEntry);
    if (isSameTranscodeStatusEntry(lastEntry, entry) || lastText === text) {
      return;
    }
  }

  transcodeStatusLogModel.push(entry);
  trimTranscodeStatusLogModel();
  renderTranscodeStatusLogFromModel();
}

function t(key, fallback, vars) {
  if (window.i18n?.t) {
    const options = { ...(vars || {}) };
    if (fallback != null) options.defaultValue = fallback;
    return window.i18n.t(key, options);
  }
  if (fallback != null) return formatFallback(fallback, vars);
  return key;
}

function i18nMsg(key, fallback, params) {
  return {
    key,
    params: params && typeof params === 'object' ? { ...params } : {},
    fallback: fallback == null ? key : String(fallback)
  };
}

function initTranscodeHideLogToggle() {
  const cb = document.getElementById('transcode-hide-log');
  const logEl = document.getElementById('transcode-log-output');
  if (!cb || !logEl) return;

  const storageKey = 'ui.transcode.hideLogWindow';

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

function autoResize(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function setupResizableGrid(gridEl, storageKey) {
  if (!gridEl || gridEl.dataset.resizable === '1') return;
  gridEl.dataset.resizable = '1';

  const COL_VARS = [
    '--col-file', '--col-format', '--col-resolution',
    '--col-fps', '--col-audio', '--col-duration'
  ];

  // Restore saved widths
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    COL_VARS.forEach(v => { if (saved[v]) gridEl.style.setProperty(v, saved[v]); });
  } catch {}

  const headers = gridEl.querySelectorAll('.file-info-grid-header');
  headers.forEach((h, idx) => {
    h.style.position = 'relative';
    const handle = document.createElement('span');
    handle.className = 'resize-handle';
    handle.dataset.i18n = 'transcodeResizeHandleTitle';
    handle.dataset.i18nAttrs = 'title:transcodeResizeHandleTitle';
    handle.title = t(
      'transcodeResizeHandleTitle',
      'Drag to resize • Double‑click to auto‑fit'
    );
    h.appendChild(handle);

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

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = h.getBoundingClientRect().width;
      gridEl.classList.add('resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Double‑click header to auto‑fit column to content
    h.addEventListener('dblclick', () => {
      const rows = gridEl.querySelectorAll('.file-info-row');
      let maxW = h.scrollWidth;
      rows.forEach((row) => {
        const w = row.children[idx]?.scrollWidth || 0;
        if (w > maxW) maxW = w;
      });
      const pad = 24;
      const newW = Math.min(Math.max(maxW + pad, 90), gridEl.clientWidth - 60);
      gridEl.style.setProperty(COL_VARS[idx], newW + 'px');
      // persist after auto-fit
      const map = {};
      COL_VARS.forEach(v => {
        const val = gridEl.style.getPropertyValue(v);
        if (val) map[v] = val.trim();
      });
      try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
    });
  });
}

const FILE_INFO_HEADER_KEYS = [
  'fileInfoColumnFile',
  'fileInfoColumnFormat',
  'fileInfoColumnResolution',
  'fileInfoColumnFps',
  'fileInfoColumnAudio',
  'fileInfoColumnDuration'
];

const FILE_INFO_HEADER_FALLBACKS = {
  fileInfoColumnFile: 'File',
  fileInfoColumnFormat: 'Format',
  fileInfoColumnResolution: 'Resolution',
  fileInfoColumnFps: 'FPS',
  fileInfoColumnAudio: 'Audio',
  fileInfoColumnDuration: 'Duration'
};

function rebuildFileInfoHeaders(infoEl) {
  if (!infoEl) return;
  while (infoEl.firstChild) {
    infoEl.removeChild(infoEl.firstChild);
  }

  FILE_INFO_HEADER_KEYS.forEach((key) => {
    const header = document.createElement('div');
    header.className = 'file-info-grid-header';
    header.dataset.i18n = key;
    header.textContent = t(key, FILE_INFO_HEADER_FALLBACKS[key] || key);
    infoEl.appendChild(header);
  });
}

function resetFileInfoGrid(panelId, storageKey) {
  const infoEl = document.getElementById(`${panelId}-file-info`);
  if (!infoEl) return null;
  infoEl.classList.add('file-info-grid');
  infoEl.classList.add('placeholder');
  rebuildFileInfoHeaders(infoEl);
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
  rebuildFileInfoHeaders(infoEl);
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

let currentJobId = null;
let cancelPendingJobId = null;
let lastProgressSnapshot = { completed: 0, total: 0 };
let isQueueingTranscode = false;
let pendingCancel = false;
let transcodeWatchSessionRunning = false;

function setTranscodeWatchSessionRunning(isRunning) {
  const next = !!isRunning;
  if (next === transcodeWatchSessionRunning) return;
  transcodeWatchSessionRunning = next;
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

function ensureTranscodeHamsterStructure(root) {
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

// Keep the Transcode controls row layout stable (mirrors Speed Test / Project Organizer):
// - loader + hamster slots stay in-flow
// - visibility is toggled via .is-active, not display:none
function setTranscodeInlineProgressActive(active) {
  const host = document.getElementById('transcode-loader-inline');
  if (!host) return;
  host.classList.toggle('is-active', !!active);
  host.setAttribute('aria-hidden', active ? 'false' : 'true');
}

function setTranscodeWatchEyesActive(active) {
  const host = document.getElementById('transcode-watch-eyes');
  if (!host) return;
  host.classList.toggle('is-active', !!active);
  host.setAttribute('aria-hidden', active ? 'false' : 'true');

  // The slot itself must collapse/expand so the eyes can truly center in Watch Mode
  // (and so the progress bar can use the full span when active).
  const slot = host.closest?.('.watch-eyes-slot');
  if (slot) slot.classList.toggle('is-active', !!active);
}


function showTranscodeHamster() {
  const status = document.getElementById('transcode-job-status');
  if (!status) return;

  // IMPORTANT: do NOT clear/rebuild the hamster DOM on every progress tick.
  // Recreating the nodes restarts the CSS animation and looks "glitchy".
  let wheel = status.querySelector('.wheel-and-hamster');
  if (!wheel) {
    wheel = document.createElement('div');
    wheel.className = 'wheel-and-hamster';
    status.appendChild(wheel);
  }

  ensureTranscodeHamsterStructure(wheel);

  status.classList.add('is-active');
  status.setAttribute('aria-hidden', 'false');
  status.dataset.jobActive = 'true';
}


function hideTranscodeHamster() {
  const status = document.getElementById('transcode-job-status');
  if (!status) return;
  delete status.dataset.jobActive;

  status.classList.remove('is-active');
  status.setAttribute('aria-hidden', 'true');

  // Leave the container in-flow so spacing doesn't jump; just clear visuals.
  const wheel = status.querySelector('.wheel-and-hamster');
  if (wheel) wheel.innerHTML = '';
}

function ensureTranscodeEtaInline() {
  const host = document.getElementById('transcode-loader-inline');
  if (!host) return null;
  let eta = document.getElementById('transcode-eta-inline');
  if (!eta) {
    eta = document.createElement('span');
    eta.id = 'transcode-eta-inline';
    eta.className = 'eta-inline';
    host.appendChild(eta);
  }
  return eta;
}

function showTranscodeStatusText(msg) {
  // Transcode status text should only surface in the Summary section (log box).
  // This avoids duplicate/stray UI text near the Start/Reset/Cancel controls.
  pushTranscodeStatusLogEntry(msg);
}

function resetTranscodeProgressUI() {
  const bar = document.getElementById('transcode-progress');
  const out = document.getElementById('transcode-progress-output');
  if (bar) { bar.value = 0; bar.style.display = 'none'; }
  if (out) out.value = '';
  const eta = document.getElementById('transcode-eta-inline');
  if (eta) eta.textContent = '';
  setTranscodeInlineProgressActive(false);
  hideTranscodeHamster();
}


function logTranscode(msg, opts = {}) {
  window.logPanel?.log('transcode', msg, opts);
}

function emitTranscodeStatus(msg, { level, meta } = {}) {
  const text = resolveTranscodeMessageText(msg);
  if (!text) return;

  if (level || (meta && typeof meta === 'object')) {
    const logOpts = {
      ...(meta && typeof meta === 'object' ? meta : {}),
      ...(level ? { level } : {})
    };
    logTranscode(msg, logOpts);
  }

  showTranscodeStatusText(msg);
}

const getMatchSourceFolderTooltip = () => t(
  'transcodeMatchSourceFolderTooltip',
  'Match Source requires a single file (not a watch folder or multiple files).'
);
const FOLDER_SELECTION_ERROR_TTL_MS = 3000;
const folderSelectionCache = {
  key: null,
  result: null,
  error: null,
  promise: null,
  checkedAt: 0,
  errorAt: 0
};

function readInputFileList(inputEl = el?.inputFiles) {
  if (!inputEl) return [];
  const raw = inputEl.dataset?.fileList;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    inputEl.dataset.fileList = '[]';
    return [];
  }
}

function resetFolderSelectionCache() {
  folderSelectionCache.key = null;
  folderSelectionCache.result = null;
  folderSelectionCache.error = null;
  folderSelectionCache.promise = null;
  folderSelectionCache.checkedAt = 0;
  folderSelectionCache.errorAt = 0;
}

async function statPathAsync(candidate) {
  try {
    if (window.electron && typeof window.electron.stat === 'function') {
      const st = await window.electron.stat(candidate);
      if (st && typeof st === 'object') {
        if (st.ok === false) return { ok: false, error: st.error || 'stat_failed' };
        if (typeof st.isDirectory === 'boolean') {
          return { ok: true, isDirectory: st.isDirectory };
        }
        if (typeof st.isDirectory === 'function') {
          return { ok: true, isDirectory: !!st.isDirectory() };
        }
      }
    }
  } catch (err) {
    return { ok: false, error: err?.message || err };
  }

  try {
    if (typeof ipc?.invoke === 'function') {
      const st = await ipc.invoke('stat-path', candidate);
      if (st && typeof st === 'object') {
        if (st.ok === false) return { ok: false, error: st.error || 'stat_failed' };
        if (typeof st.isDirectory === 'boolean') {
          return { ok: true, isDirectory: st.isDirectory };
        }
      }
    }
  } catch (err) {
    return { ok: false, error: err?.message || err };
  }

  return { ok: false, error: 'stat_unavailable' };
}

async function isFolderInputSelected() {
  const files = readInputFileList();
  if (files.length !== 1) {
    resetFolderSelectionCache();
    return false;
  }
  const candidate = files[0];
  if (folderSelectionCache.key === candidate) {
    if (folderSelectionCache.error) {
      const age = Date.now() - (folderSelectionCache.errorAt || 0);
      if (age < FOLDER_SELECTION_ERROR_TTL_MS) {
        return false;
      }
    } else if (typeof folderSelectionCache.result === 'boolean') {
      return folderSelectionCache.result;
    }
    if (folderSelectionCache.promise) return folderSelectionCache.promise;
  }

  folderSelectionCache.key = candidate;
  folderSelectionCache.promise = (async () => {
    const st = await statPathAsync(candidate);
    const isDir = !!st?.isDirectory;
    folderSelectionCache.result = isDir;
    folderSelectionCache.error = st?.ok === false ? st.error : null;
    folderSelectionCache.checkedAt = Date.now();
    folderSelectionCache.errorAt = folderSelectionCache.error ? folderSelectionCache.checkedAt : 0;
    folderSelectionCache.promise = null;
    return isDir;
  })();

  return folderSelectionCache.promise;
}

async function getDirectoryStatusForPath(path, { bypassCache = false } = {}) {
  if (!path || typeof path !== 'string') {
    return { ok: false, isDirectory: false, error: 'invalid_path' };
  }
  if (!bypassCache && folderSelectionCache.key === path) {
    const isDirectory = await isFolderInputSelected();
    const err = folderSelectionCache.error;
    return { ok: !err, isDirectory, error: err || null };
  }
  const st = await statPathAsync(path);
  if (st?.ok === false) {
    return { ok: false, isDirectory: false, error: st.error || 'stat_failed' };
  }
  return { ok: true, isDirectory: !!st?.isDirectory, error: null };
}

function setMatchSourceState(isDisabled, reason) {
  if (!el.matchSource) return;
  el.matchSource.disabled = !!isDisabled;
  const tooltip = (typeof reason === 'string' && reason.trim())
    ? reason
    : getMatchSourceFolderTooltip();
  el.matchSource.title = isDisabled ? tooltip : '';
  if (isDisabled && el.matchSource.checked) {
    el.matchSource.checked = false;
    if (el.resolution) el.resolution.disabled = false;
    if (el.frameRate) el.frameRate.disabled = false;
  }
  updateAudioSectionDisabledState();
  updateSummary(el);
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

function normalizeLogWritePayloadLines(message) {
  if (Array.isArray(message)) {
    return message.flatMap((item) => normalizeLogWritePayloadLines(item));
  }
  if (message == null) return [''];
  if (typeof message === 'string') {
    return message.split('\n');
  }
  if (typeof message === 'object') {
    return [message];
  }
  return [String(message)];
}

function setLogText(logEl, message) {
  if (!logEl) return;

  if (isTranscodeLogElement(logEl) && !isRenderingTranscodeStatusModel) {
    transcodeStatusLogModel.length = 0;
    const modelLines = normalizeLogWritePayloadLines(message);
    for (const line of modelLines) {
      transcodeStatusLogModel.push(toTranscodeStatusLogEntry(line));
    }
    trimTranscodeStatusLogModel();
  }

  const safeText = normalizeLogWritePayloadLines(message)
    .map((line) => resolveTranscodeMessageText(line))
    .join('\n');
  const buffer = getLogBuffer(logEl) || { lines: [], charCount: 0 };
  buffer.lines = safeText ? safeText.split('\n') : [];
  buffer.charCount = safeText.length;
  trimLogBuffer(buffer);
  logBuffers.set(logEl, buffer);
  renderLogBuffer(logEl, buffer);
}

function appendLogLine(logEl, message) {
  if (!logEl) return;

  const entry = toTranscodeStatusLogEntry(message);
  const line = renderTranscodeStatusLogEntry(entry);
  if (isTranscodeLogElement(logEl) && !isRenderingTranscodeStatusModel) {
    const lastEntry = transcodeStatusLogModel.length
      ? transcodeStatusLogModel[transcodeStatusLogModel.length - 1]
      : null;
    const lastText = lastEntry ? renderTranscodeStatusLogEntry(lastEntry) : '';
    if (lastEntry && (isSameTranscodeStatusEntry(lastEntry, entry) || lastText === line)) return;

    transcodeStatusLogModel.push(entry);
    trimTranscodeStatusLogModel();
  }

  const buffer = getLogBuffer(logEl);
  if (!buffer) return;
  if (buffer.lines.length > 0) buffer.charCount += 1;
  buffer.lines.push(line);
  buffer.charCount += line.length;
  trimLogBuffer(buffer);
  renderLogBuffer(logEl, buffer);
}

// Compatibility resolution now comes from the backend Codex API (no local maps).
// We retain the map names as transient caches so existing helpers keep working.
const __compatCache = new Map(); // format -> {containers,resolutions,frameRates,pixelFormats,audioCodecs,defaults}

// ✅ Declare compatibility maps before they are used
const resolutionCompatibility = {};   // populated from Codex at runtime
const pixelFormatCompatibility = {};  // populated from Codex at runtime
const audioCodecCompatibility = {};   // populated from Codex at runtime
const sampleRateCompatibility = {};   // populated from Codex at runtime
const channelCompatibility = {};      // populated from Codex at runtime
const frameRateCompatibility = {};    // populated from Codex at runtime
const FFPROBE_TIMEOUT_MS = 12000;

function isAudioOnlyFile(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  return ['mp3', 'aac', 'wav', 'flac', 'm4a', 'ogg', 'opus'].includes(ext);
}

const resolvePresetDir = () => {
  const resolved = window.electron?.resolvePath?.('config', 'presets', 'transcode');
  if (typeof resolved !== 'string') return '';
  return resolved.trim();
};

const presetAvailability = {
  warned: false,
  disabled: false
};

function setPresetFeaturesEnabled(enabled) {
  const next = !!enabled;
  [el?.savePresetBtn, el?.loadPresetBtn, el?.presetSelect].forEach(control => {
    if (control) control.disabled = !next;
  });
  presetAvailability.disabled = !next;
}

function warnPresetUnavailable() {
  if (presetAvailability.warned) return;
  const msg = i18nMsg(
    'transcodePresetDirUnavailable',
    '⚠️ Preset features are disabled because the preset directory is unavailable.'
  );
  emitTranscodeStatus(msg, { level: 'warn' });
  presetAvailability.warned = true;
}

function ensurePresetDirAvailable() {
  const dir = resolvePresetDir();
  if (!dir) {
    setPresetFeaturesEnabled(false);
    warnPresetUnavailable();
    return '';
  }
  if (presetAvailability.disabled) setPresetFeaturesEnabled(true);
  return dir;
}

function formatFfprobeError(error) {
  if (!error) return t('metadataProbeFailed', 'metadata probe failed');
  if (typeof error === 'object') {
    if (error.code === 'FFPROBE_TIMEOUT') {
      return t('metadataProbeTimedOut', 'metadata probe timed out');
    }
    return error.message || JSON.stringify(error);
  }
  return String(error);
}

function getFileMetadata(filePath) {
  return window.electron.ffprobeJson(filePath, [], { timeoutMs: FFPROBE_TIMEOUT_MS }).then(data => {
    if (data?.error) {
      return Promise.reject(formatFfprobeError(data.error));
    }
    return data;
  });
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function _parseFrameRate(rFrameRate) {
  const notAvailableLabel = t('notAvailable', 'N/A');
  const fpsUnit = t('transcodeFrameRateUnitFps', 'fps');
  if (!rFrameRate || rFrameRate === '0/0') return notAvailableLabel;
  const [num, denom] = String(rFrameRate).split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom === 0) return notAvailableLabel;
  return `${(num / denom).toFixed(3)} ${fpsUnit}`;
}

const FRAME_RATE_SNAP_TOLERANCE = 0.01;
const FRAME_RATE_OPTIONS = [
  { value: 23.976, label: '23.976' },
  { value: 24, label: '24' },
  { value: 25, label: '25' },
  { value: 29.97, label: '29.97', dropLabel: '29.97df' },
  { value: 30, label: '30' },
  { value: 50, label: '50' },
  { value: 59.94, label: '59.94', dropLabel: '59.94df' },
  { value: 60, label: '60' }
];

function getMetadataTimecode(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';

  const collected = [];
  const seen = new Set();
  const pushTimecode = (value) => {
    if (value == null) return;
    const normalized = String(value).trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    collected.push(normalized);
  };

  // Prefer authoritative container / tmcd-style stream tags before any
  // synthetic top-level fields. Match Source metadata is renderer-shaped and may
  // expose the video stream's tags at the root, which can differ from the
  // dedicated timecode stream. We must not let that shadow a DF tmcd tag.
  pushTimecode(metadata.format?.tags?.timecode);

  if (Array.isArray(metadata.streams)) {
    const streamPriority = (stream) => {
      const codecTag = String(stream?.codec_tag_string || '').toLowerCase();
      const codecName = String(stream?.codec_name || '').toLowerCase();
      const codecType = String(stream?.codec_type || '').toLowerCase();
      if (codecTag === 'tmcd' || codecName === 'tmcd') return 0;
      if (codecType === 'data') return 1;
      if (codecType === 'video') return 2;
      return 3;
    };
    const orderedStreams = metadata.streams
      .filter(Boolean)
      .slice()
      .sort((a, b) => streamPriority(a) - streamPriority(b));
    for (const stream of orderedStreams) {
      pushTimecode(stream?.tags?.timecode);
    }
  }

  pushTimecode(metadata.timecode);
  pushTimecode(metadata.tags?.timecode);

  return collected.find(tc => tc.includes(';')) || collected[0] || '';
}

function isDropFrameTimecode(metadata) {
  const timecode = getMetadataTimecode(metadata);
  return Boolean(timecode && timecode.includes(';'));
}

function mapSourceFieldOrder(rawFieldOrder) {
  const fo = String(rawFieldOrder || '').trim().toLowerCase();
  if (!fo || fo === 'unknown') return '';
  if (fo === 'progressive') return 'progressive';
  if (['tt', 'tb', 'tff'].includes(fo)) return 'interlaced_tff';
  if (['bb', 'bt', 'bff'].includes(fo)) return 'interlaced_bff';
  return '';
}

function snapFrameRate(rawFps, { dropFrame = false } = {}) {
  if (!Number.isFinite(rawFps)) return null;
  const matched = FRAME_RATE_OPTIONS.find(option =>
    Math.abs(rawFps - option.value) < FRAME_RATE_SNAP_TOLERANCE
  );
  if (!matched) return null;
  return {
    value: matched.value,
    label: dropFrame && matched.dropLabel ? matched.dropLabel : matched.label
  };
}

function formatFrameRateForGrid(metadata) {
  const notAvailableLabel = t('notAvailable', 'N/A');
  const fpsUnit = t('transcodeFrameRateUnitFps', 'fps');
  if (!metadata || !Array.isArray(metadata.streams)) return notAvailableLabel;

  const videoStream = metadata.streams.find(s => s.codec_type === 'video');
  if (!videoStream) return notAvailableLabel;

  const r = videoStream.r_frame_rate || videoStream.avg_frame_rate || '';
  if (!r || r === '0/0') return notAvailableLabel;

  const parts = r.split('/');
  if (parts.length !== 2) return notAvailableLabel;

  const num = Number(parts[0]);
  const den = Number(parts[1]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return notAvailableLabel;

  const fps = num / den;

  // Interlaced? (field_order like 'tb', 'bt', etc.)
  const fo = String(videoStream.field_order || '').toLowerCase();
  const isInterlaced = fo && fo !== 'progressive' && fo !== 'unknown';

  // Timecode tag: semicolon = drop-frame
  const timecode = getMetadataTimecode(metadata);
  const hasTC = Boolean(timecode);
  const isDrop = isDropFrameTimecode(metadata);

  const snapped = snapFrameRate(fps, { dropFrame: isDrop });

  // If interlaced 29.97, treat as 59.94 fields/s for display
  let displayRate = snapped ? snapped.value : fps;
  let displaySnap = snapped;
  if (isInterlaced && snapped?.value === 29.97) {
    const interlacedSnap = snapFrameRate(fps * 2, { dropFrame: isDrop });
    displayRate = interlacedSnap ? interlacedSnap.value : fps * 2; // 29.97 frames → 59.94 fields
    displaySnap = interlacedSnap;
  }

  const fractionalOptions = FRAME_RATE_OPTIONS.filter(option => option.value % 1 !== 0);
  const isKnownFractional = fractionalOptions.some(option =>
    Math.abs(displayRate - option.value) < FRAME_RATE_SNAP_TOLERANCE
  );
  const rateStr = displaySnap
    ? displaySnap.label
    : isKnownFractional
      ? displayRate.toFixed(3)
      : displayRate.toFixed(2).replace(/\.00$/, '');
  const tcSuffix = hasTC ? (isDrop ? 'DF' : 'NDF') : fpsUnit;

  return `${rateStr} ${tcSuffix}`;
}

// ─── Container + audio helpers (match Adobe panel semantics) ────────────────
function _normalizeExt(p) {
  const m = /\.([^.]+)$/.exec(String(p || ''));
  return (m && m[1] ? m[1].toLowerCase() : '');
}
function resolveContainerLabel(metadata, filePath) {
  const ext = _normalizeExt(filePath);
  const up = ext ? ext.toUpperCase() : '';
  const reported = (metadata?.format?.format_name || '').toLowerCase();
  const notAvailableLabel = t('notAvailable', 'N/A');
  if (!reported) return up || notAvailableLabel;
  const tokens = reported.split(',').map(s => s.trim());
  if (ext && tokens.includes(ext)) return up;
  if (tokens.includes('matroska')) {
    if (ext === 'mkv') return 'MKV';
    if (ext === 'webm') return 'WEBM';
  }
  if (tokens.includes('image2') && up) return up;
  if (tokens.includes('mov') && ext === 'mp4') return 'MP4';
  if (tokens.includes('mp4') && ext === 'mov') return 'MOV';
  return (tokens[0] || up || notAvailableLabel).toUpperCase();
}
function summarizeAudioStreams(streams = []) {
  const aud = streams.filter(s => s.codec_type === 'audio');
  const notAvailableLabel = t('notAvailable', 'N/A');
  if (!aud.length) return { codec: notAvailableLabel, label: '', tracks: 0 };
  const codecs = [...new Set(aud.map(s => String(s.codec_name || '').toUpperCase()))];
  const codec = codecs.length === 1 ? codecs[0] : codecs.join('+');
  const total = aud.reduce((sum, s) => sum + (s.channels || 0), 0);
  const allMono = aud.every(s => (s.channels || 0) === 1);
  let label = '';
  const monoLabel = t('transcodeAudioMono', 'Mono');
  const stereoLabel = t('transcodeAudioStereo', 'Stereo');
  const multiMonoSuffix = allMono ? t('transcodeAudioMultiMonoSuffix', ' (multi-mono)') : '';
  if (total === 1) label = monoLabel;
  else if (total === 2) label = stereoLabel;
  else label = t('transcodeAudioChannelsLabel', '{{count}}ch{{multiMono}}', {
    count: total,
    multiMono: multiMonoSuffix
  });
  return { codec, label, tracks: aud.length };
}

async function _summarizeTranscodeFile(filePath) {
  const name =
    (window.electron?.basename && window.electron.basename(filePath)) ||
    (filePath.split(/[\\/]/).pop());

  try {
    const md = await getFileMetadata(filePath);
    const container = resolveContainerLabel(md, filePath);
    const v = (md.streams || []).find(s => s.codec_type === 'video');
    const audioInfo = summarizeAudioStreams(md.streams || []);
    const audioOnlyLabel = t('transcodeFileInfoAudioOnly', 'Audio only');
    const notAvailableLabel = t('notAvailable', 'N/A');

    const res = v ? `${v.width}×${v.height}` : (audioInfo.tracks > 0 ? audioOnlyLabel : notAvailableLabel);
    const fps = formatFrameRateForGrid(md);
    const dur = formatDuration(+md.format?.duration || 0);

    const vc = v?.codec_name ? v.codec_name.toUpperCase() : '';

    const line1 = `🎞️ ${name}`;
    const line2 = `  ${container}  ${res}${fps ? `  ${fps}` : ''}`;
    const line3 = `  🎧 ${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}${vc ? ` • 🎬 ${vc}` : ''} • ${dur}`;
    return [line1, line2, line3].join('\n');
  } catch (err) {
    return t('transcodeFileSummaryReadError', '❌ {{name}} — {{error}}', {
      name,
      error: String(err)
    });
  }
}

function applyLockedDropdownStyles(li) {
  if (!li) return;
  li.dataset.locked = 'true';
  li.dataset.i18n = 'transcodeRequiresLicenseTitle';
  li.dataset.i18nAttrs = 'title:transcodeRequiresLicenseTitle';
  li.disabled = true;
  li.classList.add('disabled');
  const baseLabel = li.dataset.lockLabel || li.textContent;
  if (!li.dataset.lockLabel) {
    li.dataset.lockLabel = baseLabel;
  }
  li.textContent = `${baseLabel} 🔒`;
  li.title = t('transcodeRequiresLicenseTitle', 'Requires a license');
}

function refreshTranscodeDynamicTitles() {
  document.querySelectorAll('#transcode .resize-handle').forEach((handle) => {
    handle.title = t(
      'transcodeResizeHandleTitle',
      'Drag to resize • Double‑click to auto‑fit'
    );
  });

  document.querySelectorAll('#transcode [data-locked], #transcode li[data-locked="true"]').forEach((node) => {
    node.title = t('transcodeRequiresLicenseTitle', 'Requires a license');
  });

  if (el?.watchMode?.disabled) {
    el.watchMode.title = t(
      'transcodeWatchUnavailable',
      'Watch Mode unavailable (watch module not loaded).'
    );
  }

  if (el?.lutDrop && !el.lutDrop.dataset.path) {
    el.lutDrop.title = t('transcodeLutDropTitle', 'Drop LUT (.cube/.3dl/.dat) here');
  }
}

function setDropdownIfNeeded(id, value, options = {}) {
  if (!value) return;
  const hidden = document.getElementById(id);
  const list = hidden?.closest('.dropdown-wrapper')?.querySelector('.value-list');
  if (!hidden || !list) return;
  const exists = [...list.children].some(li => li.dataset.value === value);
  if (!exists) {
    const li = document.createElement('li');
    li.dataset.value = value;
    li.textContent = value;
    if (options.locked) {
      applyLockedDropdownStyles(li);
    }
    list.appendChild(li);
  }
  setDropdownValue(id, value);
}

function normalizeFrameRateLabel(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const drop = value.endsWith('df');
  const numeric = Number(value.replace(/df$/i, ''));
  return {
    raw: value,
    drop,
    numeric: Number.isFinite(numeric) ? numeric : null
  };
}

function normalizeAllowedFrameRate(candidate) {
  if (candidate == null) return null;
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    return normalizeFrameRateLabel(candidate);
  }
  if (typeof candidate !== 'object') return null;
  const dropFlag = (typeof candidate.dropFrame === 'boolean')
    ? candidate.dropFrame
    : (typeof candidate.drop_frame === 'boolean')
      ? candidate.drop_frame
      : (typeof candidate.dropframe === 'boolean')
        ? candidate.dropframe
        : (typeof candidate.df === 'boolean')
          ? candidate.df
          : null;
  const labelSource = candidate.label ?? candidate.rate ?? candidate.value ?? candidate.frameRate ?? candidate.fps;
  const normalized = normalizeFrameRateLabel(labelSource);
  if (!normalized) return null;
  return {
    ...normalized,
    drop: (typeof dropFlag === 'boolean') ? dropFlag : normalized.drop
  };
}

function isAllowedFrameRate(value, allowed) {
  if (!value) return false;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  const raw = String(value);
  if (allowed.includes(raw)) return true;
  const target = normalizeFrameRateLabel(raw);
  if (!target || target.numeric === null) return false;
  for (const candidate of allowed) {
    const normalized = normalizeAllowedFrameRate(candidate);
    if (!normalized || normalized.numeric === null) continue;
    if (Math.abs(normalized.numeric - target.numeric) < FRAME_RATE_SNAP_TOLERANCE) {
      // Drop-frame vs non-drop is a timecode *labeling* distinction, not an FFmpeg
      // encode capability. If the numeric rate matches, treat it as allowed.
      return true;
    }
  }
  return false;
}

function clearMatchSourceSelection() {
  if (el.matchSource?.checked) {
    el.matchSource.checked = false;
  }
  if (el.resolution) el.resolution.disabled = false;
  if (el.frameRate) el.frameRate.disabled = false;
  updateAudioSectionDisabledState();
  updateSummary(el);
}

async function applyMatchSource() {
  const files = readInputFileList();
  if (files.length !== 1) {
    if (files.length > 1) {
      showError(t(
        'transcodeMatchSourceRequiresSingleFileError',
        '❌ Match Source requires a single file input (not a watch folder or multiple files).'
      ));
    }
    setMatchSourceState(true);
    return false;
  }
  if (await isFolderInputSelected()) {
    showError(t(
      'transcodeMatchSourceRequiresSingleFileError',
      '❌ Match Source requires a single file input (not a watch folder or multiple files).'
    ));
    return false;
  }
  let meta;
  try {
    meta = await window.electron.getSourceMetadata?.(files[0]);
  } catch (err) {
    showError(t(
      'transcodeMatchSourceMetadataReadFailedError',
      '❌ Match Source failed to read metadata. {{error}}',
      { error: String(err) }
    ));
    clearMatchSourceSelection();
    return false;
  }
  const videoMeta = meta?.videoStream || (
    Array.isArray(meta?.streams)
      ? (meta.streams.find(stream => stream?.codec_type === 'video') || meta)
      : meta
  );

  const hasVideoDimensions = Number.isFinite(Number(videoMeta?.width)) &&
    Number.isFinite(Number(videoMeta?.height)) &&
    Number(videoMeta.width) > 0 &&
    Number(videoMeta.height) > 0;
  if (!hasVideoDimensions) {
    const msg = t(
      'transcodeMatchSourceRequiresVideoError',
      '❌ Match Source requires video inputs.'
    );
    showError(msg);
    setMatchSourceState(true, msg);
    return false;
  }
  const res = `${videoMeta.width}x${videoMeta.height}`;
  let fps = '';
  let normalizedRate = '';
  const parseRational = (value) => {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (!s.includes('/')) {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const [nRaw, dRaw] = s.split('/', 2);
    const n = Number(nRaw);
    const d = Number(dRaw);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
    const out = n / d;
    return Number.isFinite(out) && out > 0 ? out : null;
  };

  const sourceR = parseRational(videoMeta.r_frame_rate);
  const sourceAvg = parseRational(videoMeta.avg_frame_rate);

  // The source grid intentionally shows FIELD rate for interlaced material
  // (e.g. 1080i29.97 -> 59.94 DF). The Match Source dropdown, however, controls
  // FRAME rate. For interlaced sources we therefore need 29.97/25 + field order,
  // not the field-rate display value.
  const fo = String(videoMeta.field_order || '').toLowerCase();
  const isInterlaced = fo && fo !== 'progressive' && fo !== 'unknown';
  const interlaceFrameRate = (() => {
    if (!isInterlaced) return null;
    const finite = [sourceR, sourceAvg].filter(value => Number.isFinite(value) && value > 0);
    if (!finite.length) return null;
    const hi = Math.max(...finite);
    const lo = Math.min(...finite);
    // Common case: one probe field reports field rate while another reports frame rate.
    if (finite.length >= 2 && Math.abs(hi - (lo * 2)) < 0.05) return lo;
    if (hi > 40) return hi / 2;
    return lo;
  })();

  const orderedCandidates = [];
  const addCandidate = (value) => {
    if (!Number.isFinite(value) || value <= 0) return;
    if (orderedCandidates.some(existing => Math.abs(existing - value) < FRAME_RATE_SNAP_TOLERANCE)) return;
    orderedCandidates.push(value);
  };
  addCandidate(interlaceFrameRate);
  addCandidate(sourceAvg);
  addCandidate(sourceR);
  if (isInterlaced && sourceR && sourceR > 40) addCandidate(sourceR / 2);
  if (isInterlaced && sourceAvg && sourceAvg > 40) addCandidate(sourceAvg / 2);

  const frameRateList = el.frameRate
    ?.closest('.dropdown-wrapper')
    ?.querySelector('.value-list');
  const frameRateValues = frameRateList
    ? new Set([...frameRateList.children].map(li => li?.dataset?.value).filter(Boolean))
    : null;

  let rawFps = orderedCandidates[0] ?? null;
  const dropFrame = isDropFrameTimecode(meta);
  let chosenSnapped = null;
  for (const candidate of orderedCandidates) {
    const snapped = snapFrameRate(candidate, { dropFrame });
    if (!snapped) continue;
    if (!frameRateValues || frameRateValues.has(snapped.label)) {
      rawFps = candidate;
      chosenSnapped = snapped;
      break;
    }
  }

  if (rawFps) {
    fps = rawFps.toFixed(3);
    if (chosenSnapped) normalizedRate = chosenSnapped.label;
    else {
      const snapped = snapFrameRate(rawFps, { dropFrame });
      if (snapped) normalizedRate = snapped.label;
    }
  }
  const format = el.outputFormat?.value;
  if (format) {
    const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
    if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
    const allowedResolutions = Array.isArray(compat?.resolutions) ? compat.resolutions : [];
    const allowedRates = Array.isArray(compat?.frameRates) ? compat.frameRates : [];
    const rateCandidate = normalizedRate || fps;
    const resolutionAllowed = allowedResolutions.length === 0 || allowedResolutions.includes(res);
    const frameRateAllowed = !rateCandidate || isAllowedFrameRate(rateCandidate, allowedRates);
    if (!resolutionAllowed || !frameRateAllowed) {
      const issues = [];
      if (!resolutionAllowed) {
        issues.push(t(
          'transcodeMatchSourceIssueResolution',
          'resolution {{value}}',
          { value: res }
        ));
      }
      if (!frameRateAllowed && rateCandidate) {
        issues.push(t(
          'transcodeMatchSourceIssueFrameRate',
          'frame rate {{value}}',
          { value: rateCandidate }
        ));
      }
      const issueJoiner = t('transcodeValueAnd', 'and');
      const details = issues.length
        ? t(
          'transcodeMatchSourceIssueDetails',
          ' ({{issues}}).',
          { issues: issues.join(` ${issueJoiner} `) }
        )
        : '.';
      const warnMsg = i18nMsg(
        'transcodeMatchSourceNotListedWarning',
        '⚠️ Match Source{{details}} is not listed as compatible with {{format}}. Attempting anyway.',
        { details, format }
      );
      logTranscode(warnMsg);
      showTranscodeStatusText(warnMsg);
    }
  }
  if (window.license?.isFeatureEnabled) {
    try {
      const resolutionEnabled = await window.license.isFeatureEnabled(res);
      if (!resolutionEnabled) {
        showError(t(
          'transcodeMatchSourceRestrictedResolutionError',
          '❌ Resolution "{{resolution}}" is restricted.',
          { resolution: res }
        ));
        clearMatchSourceSelection();
        return false;
      }
    } catch {
      /* fail open */
    }
  }
  const rateValue = normalizedRate || fps;
  if (rateValue && window.license?.isFeatureEnabled) {
    try {
      const rateEnabled = await window.license.isFeatureEnabled(rateValue);
      if (!rateEnabled) {
        showError(t(
          'transcodeMatchSourceRestrictedFrameRateError',
          '❌ Frame rate "{{frameRate}}" is restricted.',
          { frameRate: rateValue }
        ));
        clearMatchSourceSelection();
        return false;
      }
    } catch {
      /* fail open */
    }
  }
  setDropdownIfNeeded('resolution', res);
  if (rateValue) setDropdownIfNeeded('frameRate', rateValue);
  const sourceFieldOrder = mapSourceFieldOrder(videoMeta.field_order);
  if (sourceFieldOrder) setDropdownIfNeeded('fieldOrder', sourceFieldOrder);
  return true;
}

async function _updateFileInfoDisplay(filePath) {
  const infoBox = prepareFileInfoGrid('transcode');
  if (!infoBox) return;

  try {
    const metadata = await getFileMetadata(filePath);
    appendFileInfoRow(infoBox, buildTranscodeFileInfoCells(filePath, metadata));
  } catch (err) {
    appendFileInfoRow(infoBox, buildTranscodeFileInfoErrorCells(filePath, err));
  }

  setupResizableGrid(infoBox, 'gridCols-transcode');
}

function buildTranscodeFileInfoCells(filePath, metadata, fileNameOverride = null) {
  const container = resolveContainerLabel(metadata, filePath);
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const videoStream = streams.find(s => s.codec_type === 'video');
  const audioInfo = summarizeAudioStreams(streams);
  const duration = formatDuration(+metadata?.format?.duration || 0);
  const notAvailableLabel = t('notAvailable', 'N/A');
  const audioOnlyLabel = t('transcodeFileInfoAudioOnly', 'Audio only');
  const resolution = videoStream
    ? `${videoStream.width}×${videoStream.height}`
    : (audioInfo.tracks > 0 ? audioOnlyLabel : notAvailableLabel);
  const frameRate = formatFrameRateForGrid(metadata);
  const audioCell = `${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}`;

  return [
    makeFileInfoCell(fileNameOverride || window.electron.basename(filePath)),
    makeFileInfoCell(container || t('notAvailable', 'N/A')),
    makeFileInfoCell(resolution),
    makeFileInfoCell(frameRate),
    makeFileInfoCell(audioCell),
    makeFileInfoCell(duration)
  ];
}

function buildTranscodeFileInfoErrorCells(filePath, error, fileNameOverride = null) {
  return [
    makeFileInfoCell(fileNameOverride || window.electron.basename(filePath)),
    makeFileInfoCell(t('transcodeFileInfoErrorCell', '❌ {{error}}', { error: String(error) }), { gridColumn: 'span 5' })
  ];
}

// Bootstrap caches from backend Codex once at startup (formats + audio constraints).
(async () => {
  try {
    const formats = await window.codex?.listFormats?.();
    for (const fmt of (formats || [])) {
      const compat = await window.codex?.getCompatibility?.(fmt);
      if (!compat) continue;
      __compatCache.set(fmt, compat);
      resolutionCompatibility[fmt] = compat?.resolutions || [];
      pixelFormatCompatibility[fmt] = compat?.pixelFormats || [];
      frameRateCompatibility[fmt] = compat?.frameRates || [];
      audioCodecCompatibility[fmt] = compat?.audioCodecs || [];
    }
    const audioList = await window.codex?.listAudioCodecs?.();
    for (const c of (audioList || [])) {
      const ac = await window.codex?.getAudioConstraints?.(c);
      sampleRateCompatibility[c] = ac?.sampleRates || [];
      channelCompatibility[c] = ac?.channels || [];
    }
  } catch (err) {
    panelLog('error', '❌ Codex bootstrap failed:', { error: err?.message || err });
  }
})();


async function enforceLicenseLocks() {
  // No license object in test/non‑Electron environments → leave options unlocked
  if (!window.license?.isFeatureEnabled) return;
  const items = Array.from(document.querySelectorAll('[data-locked]'));
  await Promise.all(items.map(async (option) => {
    const key = option.value ?? option.dataset?.value;
    try {
      const ok = await window.license.isFeatureEnabled(key);
      if (!ok) {
        const baseLabel = option.dataset.lockLabel || option.textContent;
        if (!option.dataset.lockLabel) {
          option.dataset.lockLabel = baseLabel;
        }
        option.dataset.i18n = 'transcodeRequiresLicenseTitle';
        option.dataset.i18nAttrs = 'title:transcodeRequiresLicenseTitle';
        option.disabled = true;
        option.textContent = `${baseLabel} 🔒`;
        option.title = t('transcodeRequiresLicenseTitle', 'Requires a license');
      }
    } catch {
      /* on IPC failure, fail open */
    }
  }));
}

function restoreDropdownOptions(hiddenEl) {
  if (!hiddenEl) return;
  const list = hiddenEl.closest('.dropdown-wrapper')?.querySelector('.value-list');
  if (!list) return;
  [...list.children].forEach(li => {
    li.style.display = '';
    li.style.color = '';
  });
}

async function filterContainerOptions(format, expectedFormat) {
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  const hidden = document.getElementById('containerFormat');
  if (!hidden) return;

  if (!format) {
    restoreDropdownOptions(hidden);
    return;
  }

  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  const list = hidden.closest('.dropdown-wrapper')?.querySelector('.value-list');
  if (!list) return;

  const raw = Array.isArray(compat?.containers) ? compat.containers : [];
  const listValues = new Set([...list.children].map(li => li.dataset.value));

  // If we don't have container guidance for this format, fail open and keep everything visible.
  if (!compat || raw.length === 0) {
    restoreDropdownOptions(hidden);
    if (!listValues.has(hidden.value)) {
      const fallback = [...listValues][0];
      if (fallback) setDropdownValue('containerFormat', fallback);
    }
    return;
  }

  // Normalize legacy image2 → image_sequence (panel uses image_sequence as the user-facing value).
  if (hidden.value === 'image2' && listValues.has('image_sequence')) {
    setDropdownValue('containerFormat', 'image_sequence');
  }

  const normalized = [...new Set(raw.map(value => (value === 'image2' ? 'image_sequence' : value)))];
  const recommended = normalized.filter(value => listValues.has(value));

  // Strict: hide containers that are not compatible with the selected format.
  [...list.children].forEach(li => {
    const isRecommended = recommended.includes(li.dataset.value);
    li.style.display = isRecommended ? '' : 'none';
    li.style.color = '';
  });

  // Safety: if the current selection isn't even in the dropdown, fall back to the first option.
  if (!listValues.has(hidden.value)) {
    const fallback = [...listValues][0];
    if (fallback) setDropdownValue('containerFormat', fallback);
  }
}



async function filterResolutionOptions(format, el, expectedFormat) {
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (!format) {
    restoreDropdownOptions(el.resolution);
    return;
  }
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  const allowed = compat?.resolutions || [];
  filterGenericOptions(el.resolution, allowed);
}

async function filterFieldOrderOptions(format, el, expectedFormat) {
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (!format) {
    restoreDropdownOptions(el.fieldOrder);
    return;
  }
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  const allowed = compat?.fieldOrders || [];

  // XDCAM: constrain field order based on resolution + container.
  const fmt = String(format || '').toLowerCase();
  const container = String(el.containerFormat?.value || '').toLowerCase();
  const res = String(el.resolution?.value || '').trim();
  if ((fmt === 'xdcam_hd35' || fmt === 'xdcam_hd50') && container === 'mxf') {
    if (res === '1280x720') {
      filterGenericOptions(el.fieldOrder, ['progressive']);
      return;
    }
    filterGenericOptions(el.fieldOrder, ['interlaced_tff','interlaced_bff']);
    return;
  }

  filterGenericOptions(el.fieldOrder, allowed);
}

async function filterFrameRateOptions(format, el, expectedFormat) {
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (!format) {
    restoreDropdownOptions(el.frameRate);
    return;
  }
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  const allowed = compat?.frameRates || [];

  // XDCAM: constrain FPS based on resolution + container so user can't pick invalid combos.
  const fmt = String(format || '').toLowerCase();
  const container = String(el.containerFormat?.value || '').toLowerCase();
  const res = String(el.resolution?.value || '').trim();
  if ((fmt === 'xdcam_hd35' || fmt === 'xdcam_hd50') && container === 'mxf') {
    if (res === '1280x720') {
      filterGenericOptions(el.frameRate, ['50','59.94','59.94df','60']);
      return;
    }
    // 1080 XDCAM in MXF: keep it interlaced rates only
    filterGenericOptions(el.frameRate, ['25','29.97','29.97df','30']);
    return;
  }

  filterGenericOptions(el.frameRate, allowed);
}

async function filterColorRangeOptions(format, el, expectedFormat) {
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (!format) {
    restoreDropdownOptions(el.colorRange);
    return;
  }
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  const allowed = (compat?.colorRanges || []).map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
  filterGenericOptions(el.colorRange, allowed);
}

async function filterPixelFormats(format, el, expectedFormat) {
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (!format) {
    restoreDropdownOptions(el.pixelFormat);
    return;
  }
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  const allowed = compat?.pixelFormats || [];
  filterGenericOptions(el.pixelFormat, allowed);
  if (el.pixelFormat && allowed.length) {
    const best = choosePreferredPixelFormat(allowed, compat?.defaults?.pixelFormat);
    if (best && (!el.pixelFormat.value || !allowed.includes(el.pixelFormat.value))) {
      setDropdownValue('pixelFormat', best);
    }
  }
}

async function filterAudioCodecs(format, el, expectedFormat) {
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (!format) {
    restoreDropdownOptions(el.audioCodec);
    return;
  }
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);
  let allowed = compat?.audioCodecs || [];
  const container = el.containerFormat?.value;
  if (container && allowed.length) {
    const vetted = await Promise.all(allowed.map(async codec => ({
      codec,
      ok: await isAudioContainerValid(codec, container)
    })));
    if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
    allowed = vetted.filter(v => v.ok).map(v => v.codec);
  }
  filterGenericOptions(el.audioCodec, allowed);
}

async function filterSampleRates(format, el, expectedFormat) {
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;

  if (isAudioOnlyActiveUI()) {
    const wrapper = el.audioCodec?.value || '';
    const wrapperConstraints = await getAudioOnlyWrapperConstraints(wrapper);
    if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
    const allowed = Array.isArray(wrapperConstraints?.sampleRates) ? wrapperConstraints.sampleRates : [];
    filterGenericOptions(el.sampleRate, allowed);
    return;
  }

  const codec = el.audioCodec?.value || '';
  const ac = await window.codex?.getAudioConstraints?.(codec);
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  const compat = format ? (__compatCache.get(format) || await window.codex?.getCompatibility?.(format)) : null;
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);

  const codecRates = Array.isArray(ac?.sampleRates) ? ac.sampleRates : [];
  const formatRates = Array.isArray(compat?.sampleRates) ? compat.sampleRates : [];
  const allowed = formatRates.length ? codecRates.filter(v => formatRates.includes(v)) : codecRates;

  filterGenericOptions(el.sampleRate, allowed);
}

async function filterChannels(format, el, expectedFormat) {
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;

  if (isAudioOnlyActiveUI()) {
    const wrapper = el.audioCodec?.value || '';
    const wrapperConstraints = await getAudioOnlyWrapperConstraints(wrapper);
    if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
    const allowed = Array.isArray(wrapperConstraints?.channels) ? wrapperConstraints.channels : [];
    filterGenericOptions(el.channels, allowed);
    return;
  }

  const codec = el.audioCodec?.value || '';
  const ac = await window.codex?.getAudioConstraints?.(codec);
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  const compat = format ? (__compatCache.get(format) || await window.codex?.getCompatibility?.(format)) : null;
  if (expectedFormat && el.outputFormat?.value !== expectedFormat) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);

  const codecCh = Array.isArray(ac?.channels) ? ac.channels : [];
  const formatCh = Array.isArray(compat?.channelOptions) ? compat.channelOptions : [];
  const allowed = formatCh.length ? codecCh.filter(v => formatCh.includes(v)) : codecCh;

  filterGenericOptions(el.channels, allowed);
}

function filterGenericOptions(hiddenEl, allowed) {
  if (!hiddenEl) return;
  const list = hiddenEl.closest('.dropdown-wrapper')?.querySelector('.value-list');
  if (!list) return;
  const hasFilter = Array.isArray(allowed) && allowed.length > 0;

  const id = hiddenEl.id;
  const alwaysAllow = new Set(['preserve']);
  if (id === 'resolution' || id === 'frameRate') alwaysAllow.add('match');

  const allowedSet = new Set((allowed || []).map(v => String(v)));
  let firstVisible = null;

  [...list.children].forEach(li => {
    const value = String(li.dataset.value || '');
    const baseVal = value.endsWith('df') ? value.replace('df', '') : value;
    const ok = !hasFilter || alwaysAllow.has(value) || allowedSet.has(value) || allowedSet.has(baseVal);
    li.style.display = ok ? '' : 'none';
    if (ok && !firstVisible) firstVisible = value;
  });

  if (hasFilter) {
    const cur = String(hiddenEl.value || '');
    const curBase = cur.endsWith('df') ? cur.replace('df', '') : cur;
    const curOk = alwaysAllow.has(cur) || allowedSet.has(cur) || allowedSet.has(curBase);
    if (!curOk) {
      if (firstVisible) {
        setDropdownValue(id, firstVisible);
      }
    }
  }
}

function pixelFormatScore(fmt) {
  if (!fmt) return 0;
  const chroma = fmt.includes('444') ? 3
    : (fmt.includes('422') || fmt.includes('j422')) ? 2
      : fmt.includes('420') ? 1
        : 0;
  const depthMatch = fmt.match(/(\d{2})/);
  const bitDepth = depthMatch ? Number(depthMatch[1]) : 8;
  return chroma * 100 + bitDepth;
}

function choosePreferredPixelFormat(allowed, preferred) {
  const options = (allowed || []).filter(Boolean);
  if (!options.length) return '';
  const ranked = options.slice().sort((a, b) => {
    const diff = pixelFormatScore(b) - pixelFormatScore(a);
    return diff === 0 ? options.indexOf(a) - options.indexOf(b) : diff;
  });
  const top = ranked[0];
  if (preferred && options.includes(preferred)) {
    const prefScore = pixelFormatScore(preferred);
    if (prefScore >= pixelFormatScore(top)) return preferred;
  }
  return top;
}

// The following helpers were used in an earlier version of the panel but are
// currently unused. They are kept for reference in case future compatibility
// checks are reintroduced.
/*
function isSourceCompatibleWithDNxHD(resolution, pixelFormat, frameRate) {
  const validSizes = ['1920x1080', '1440x1080', '1280x720', '960x720'];
  const validPixFmts = ['yuv422p', 'yuv422p10', 'yuv422p10le'];
  const validRates = ['23.976', '24', '25', '29.97', '29.97df', '30', '50', '59.94', '59.94df', '60'];

  return (
    validSizes.includes(resolution) &&
    validPixFmts.includes(pixelFormat) &&
    validRates.includes(frameRate)
  );
}

function isSourceCompatibleWithDNxHR(resolution, pixelFormat, frameRate) {
  const validSizes = ['1920x1080', '3840x2160', '4096x2160'];
  const validPixFmts = ['yuv422p', 'yuv422p10', 'yuv422p10le', 'yuv444p10le'];
  const validRates = ['23.976', '24', '25', '29.97', '29.97df', '30', '50', '59.94', '59.94df', '60'];

  return (
    validSizes.includes(resolution) &&
    validPixFmts.includes(pixelFormat) &&
    validRates.includes(frameRate)
  );
}
*/

async function isAudioContainerValid(codec, container) {
  try {
    return !!(await window.codex?.isAudioContainerValid?.(codec, container));
  } catch {
    return true; // fail-open in dev if IPC unavailable
  }
}



  // async, but fire-and-forget is fine for initial UI state
  enforceLicenseLocks();
  let isTranscoding = false;
  let isStartingWatch = false;
  function showCompatibilityWarnings(elements) {
  const format = elements.outputFormat.value;
  const container = elements.containerFormat.value;

  // Phase 1 guardrail: sequence/container mismatches must be treated as *errors*
  // (silent wrong output is unacceptable in pro workflows).
  const isSeqFormat = typeof format === 'string' && format.includes('sequence');
  const isSeqContainer = (container === 'image_sequence' || container === 'image2');

  let msg = null;

  if (format.includes('4444') && container === 'mp4') {
    msg = i18nMsg('transcodeWarnMp4NoAlpha', '⚠️ MP4 does not support alpha channels. Use MOV.');
  } else if (isSeqFormat && !isSeqContainer) {
    msg = i18nMsg(
      'transcodeErrorSeqFormatNeedsSeqContainer',
      '🛑 Output format is an image sequence. Set container to "image_sequence".'
    );
  } else if (isSeqContainer && !isSeqFormat) {
    msg = i18nMsg(
      'transcodeErrorSeqContainerNeedsSeqFormat',
      '🛑 Container is set to "image_sequence" but output format is not a sequence. Choose a sequence format.'
    );
  } else if (!!elements.preserveMetadata?.checked && !isAudioOnlyActiveUI() && (container === 'mp4' || container === 'm4v') && !isSeqContainer && !isSeqFormat) {
    msg = i18nMsg(
      'transcodeWarnPreserveMetadataMp4',
      '⚠️ Preserve Metadata is enabled with MP4. MP4 can’t reliably embed some side tracks (e.g., timecode/data). Video/audio + global metadata will be preserved; a sidecar metadata JSON will be written.'
    );
  } else if (!!elements.preserveMetadata?.checked && isSeqContainer && isSeqFormat) {
    msg = i18nMsg(
      'transcodeInfoPreserveMetadataImageSequence',
      'ℹ️ Metadata preservation is enabled. Image sequences cannot embed metadata; a sidecar metadata file will be written.'
    );
  }

  if (msg) {
    showTranscodeStatusText(msg);
  }
}
const isImageSequenceOutput = (containerFormat, outputFormat) => {
  const container = (containerFormat || '').toLowerCase();
  const format = (outputFormat || '').toLowerCase();
  return container === 'image_sequence' || container === 'image2' || format.includes('sequence');
};

function updateSummary(elements) {
  const selectedFiles = readInputFileList(elements.inputFiles);
  const fileCount = selectedFiles.length;
  const isWatchMode = !!elements.watchMode?.checked;
  const watchFolder = isWatchMode ? selectedFiles[0] : '';
  const watchPlaceholder = t('transcodeWatchFolderPlaceholder', 'Select a watch folder');
  const isAudioOnly = isAudioOnlyActiveUI();
  const captionSidecar = (elements.captionSidecarPath?.value || '').trim();
  const captionsAttached = !!captionSidecar;
  const format = elements.outputFormat.value;
  const container = elements.containerFormat.value;
  const resolution = elements.resolution.value;
  const frameRate = elements.frameRate.value;
  const frLabel = frameRate
    ? frameRate.endsWith('df')
      ? frameRate
      : `${frameRate}fps`
    : '';
  const videoSummary = [resolution, frLabel && `@ ${frLabel}`].filter(Boolean).join(' ')
    || t('transcodeSummaryCustomSettings', 'custom settings');
  const audioCodec = elements.audioCodec.value;
  const audioChannels = elements.channels.value;

  const chanText = audioChannels === 'preserve'
    ? t('transcodeSummaryOriginalChannels', 'original channels')
    : audioChannels;
  const audioSummary = isImageSequenceOutput(container, format)
    ? t('transcodeSummaryNoAudioImageSequence', 'no audio (image sequence)')
    : t('transcodeSummaryAudioCodecChannels', '{{codec}} {{channels}}', {
      codec: audioCodec,
      channels: chanText
    });
  const watchSummaryBase = isWatchMode
    ? t('transcodeSummaryWatchingFolder', 'Watching folder {{folder}}', {
      folder: (watchFolder || watchPlaceholder)
    })
    : '';
  const captionSummary = t('transcodeSummaryCaptionsLocked', '🧩 Captions attached → MXF (match source)');
  const summaryText = captionsAttached
    ? (isWatchMode
      ? t('transcodeSummaryWatchCaptions', '👀 {{watch}} → {{captionFlow}}', {
        watch: watchSummaryBase,
        captionFlow: captionSummary
      })
      : t('transcodeSummaryBatchCaptions', '🧩 Captions attached to {{count}} file(s) → MXF (match source)', {
        count: fileCount
      }))
    : (isWatchMode
      ? (isAudioOnly
        ? t('transcodeSummaryWatchAudioOnly', '👀 {{watch}} → {{target}} ({{channels}})', {
          watch: watchSummaryBase,
          target: (audioCodec || t('transcodeSummaryAudioGeneric', 'audio')),
          channels: chanText
        })
        : t('transcodeSummaryWatchVideo', '👀 {{watch}} → {{format}} ({{video}}) → {{container}} with {{audio}}', {
          watch: watchSummaryBase,
          format,
          video: videoSummary,
          container,
          audio: audioSummary
        }))
      : (isAudioOnly
        ? t('transcodeSummaryBatchAudioOnly', '🎧 Transcoding {{count}} file(s) to {{target}} ({{channels}})', {
          count: fileCount,
          target: (audioCodec || t('transcodeSummaryAudioGeneric', 'audio')),
          channels: chanText
        })
        : t('transcodeSummaryBatchVideo', '🎬 Transcoding {{count}} file(s) to {{format}} ({{video}}) → {{container}} with {{audio}}', {
          count: fileCount,
          format,
          video: videoSummary,
          container,
          audio: audioSummary
        })));
  writeLogElText(elements.summary, summaryText);
  if (elements.summary?.tagName === 'TEXTAREA') {
    autoResize(elements.summary);
  }
  updateTranscodeJobPreview();
}

async function applyPresetToFields(preset, elements) {
  if (!preset) return;
  if (elements.outputPath && typeof preset.outputPath === 'string') {
    elements.outputPath.value = preset.outputPath;
  }

  const presetSourceListRaw = (
    Array.isArray(preset.inputFiles) ? preset.inputFiles
      : Array.isArray(preset.sourcePaths) ? preset.sourcePaths
        : typeof preset.sourcePaths === 'string' ? [preset.sourcePaths]
          : []
  );
  const presetSourceList = presetSourceListRaw
    .map(item => String(item || '').trim())
    .filter(Boolean);

  const presetWatchFolder = String(
    preset.watchFolder
    || preset.watchFolderPath
    || presetSourceList[0]
    || ''
  ).trim();

  const shouldApplyWatchSource = !!presetWatchFolder && !!preset.watchMode;
  const sourcesToApply = shouldApplyWatchSource
    ? [presetWatchFolder]
    : presetSourceList;

  if (elements.inputFiles && sourcesToApply.length) {
    elements.inputFiles.value = sourcesToApply.join('\n');
    elements.inputFiles.dataset.fileList = JSON.stringify(sourcesToApply);
    if (!elements.inputFiles.classList?.contains('hidden')) {
      autoResize(elements.inputFiles);
    }
  }

  if (presetWatchFolder && elements.watchFolderPath) {
    elements.watchFolderPath.value = presetWatchFolder;
  }

  const presetVideoSelections = {
    outputFormat: preset.outputFormat || '',
    containerFormat: preset.containerFormat || '',
    resolution: preset.resolution || '',
    frameRate: preset.frameRate || '',
    pixelFormat: preset.pixelFormat || '',
    colorRange: preset.colorRange || '',
    fieldOrder: preset.fieldOrder || '',
    lutPath: preset.lutPath || ''
  };

  const audioOnly = !!preset.audioOnly;
  if (audioOnly) {
    await ensureAudioOnlyWrapperMetadataLoaded();
  }
  if (elements.audioOnly) {
    elements.audioOnly.checked = audioOnly;
    elements.audioOnly.dataset.auto = '0';
    elements.audioOnly.disabled = false;
    await toggleAudioOnlyMode({ restoreCached: false });
  }
  if (audioOnly) {
    // Preserve preset video selections so toggling audio-only off restores
    // the preset's saved video state instead of the transient pre-toggle UI state.
    cachedVideoSelections = { ...presetVideoSelections };
  }
  if (!audioOnly) {
    setDropdownValue('outputFormat', presetVideoSelections.outputFormat);
    // If a preset references an output format that this FFmpeg build cannot encode,
    // clear it so we don’t silently carry an invalid hidden value into a job.
    const requestedFmt = String(presetVideoSelections.outputFormat || '').trim();
    if (requestedFmt) {
      try {
        const caps = await window.codex?.getFormatCapabilities?.(requestedFmt);
        if (!caps?.encoderAvailable) {
          const unsupportedPresetFormatMsg = i18nMsg(
            'transcodeWarnPresetFormatUnsupported',
            '⚠️ Preset requested output format "{{format}}", but this FFmpeg build can’t encode it. Please choose a supported format.',
            { format: requestedFmt }
          );
          logTranscode(unsupportedPresetFormatMsg);
          setDropdownValue('outputFormat', '');
        }
      } catch {
        // Ignore capability lookup failures here; the backend will still guard at job start.
      }
    }
    setDropdownValue('containerFormat', presetVideoSelections.containerFormat);
    setDropdownValue('resolution', presetVideoSelections.resolution);
    setDropdownValue('frameRate', presetVideoSelections.frameRate);
    setDropdownValue('pixelFormat', presetVideoSelections.pixelFormat);
    setDropdownValue('colorRange', presetVideoSelections.colorRange);
    setDropdownValue('fieldOrder', presetVideoSelections.fieldOrder);
    setLut(presetVideoSelections.lutPath);
  }
  let nextAudioCodec = preset.audioCodec || '';
  if (audioOnly) {
    const requestedAudioCodec = String(preset.audioCodec || '').trim();
    const fallbackWrapper = audioWrapperList.includes('wav')
      ? 'wav'
      : (audioWrapperList[0] || '');
    if (!requestedAudioCodec) {
      nextAudioCodec = fallbackWrapper;
    } else if (!audioWrapperList.includes(requestedAudioCodec)) {
      nextAudioCodec = findAudioOnlyWrapperForCodec(requestedAudioCodec) || fallbackWrapper;
      const normalizedAudioCodecMsg = i18nMsg(
        'transcodeWarnPresetAudioCodecNormalized',
        '⚠️ Preset audio codec "{{codec}}" isn’t valid for audio-only wrappers. Normalized to "{{normalized}}".',
        { codec: requestedAudioCodec, normalized: nextAudioCodec }
      );
      logTranscode(normalizedAudioCodecMsg);
    }
  }
  await initSampleRateDropdown();
  setDropdownValue('audioCodec', nextAudioCodec);
  setDropdownValue('channels', preset.channels || '');
  setDropdownValue('sampleRate', preset.sampleRate || '');
  setDropdownValue('audioBitrate', preset.audioBitrate ?? '');
  elements.audioDelay.value = preset.audioDelay ?? '';
  setCaptionSidecar(preset.captionSidecarPath || '');
  elements.normalizeAudio.checked = !!preset.normalizeAudio;
  const verificationMethod = String(
    preset.verificationMethod
    || preset.verification?.method
    || 'metadata'
  ).trim() || 'metadata';
  if (elements['transcode-verification-method']) {
    setDropdownValue('transcode-verification-method', verificationMethod);
  }
  if (elements.saveLog) {
    elements.saveLog.checked = !!(preset.saveLog ?? preset.verification?.saveLog);
  }
  if (elements.enableN8N) {
    elements.enableN8N.checked = !!preset.enableN8N;
  }
  if (elements.n8nUrl) {
    elements.n8nUrl.value = preset.n8nUrl || '';
  }
  if (elements.n8nAllowPrivate) {
    elements.n8nAllowPrivate.checked = !!preset.n8nAllowPrivate;
  }
  if (elements.n8nLog) {
    elements.n8nLog.checked = !!preset.n8nLog;
  }
  if (elements.notes) {
    elements.notes.value = preset.notes || '';
  }
  if (elements.watchMode) {
    elements.watchMode.checked = !!preset.watchMode;
  }
  if (elements.watchProcessExisting) {
    elements.watchProcessExisting.checked = !!(
      preset.watchProcessExisting
      ?? preset.processExistingOnStart
    );
  }
  // Mirror checkbox-change watch-mode UI sync when preset values are loaded.
  // Respect watch availability guardrails: a disabled Watch Mode checkbox means
  // the watch module is unavailable, so we force non-watch UI/button state.
  const effectiveWatchMode = !!elements.watchMode?.checked && !elements.watchMode?.disabled;
  applyTranscodeWatchButtonState(effectiveWatchMode);
  await updateStartButtonForWatchState(effectiveWatchMode);

  if (elements.matchSource) {
    elements.matchSource.checked = !!preset.matchSource;
  }

  if (elements.preserveMetadata) {
    elements.preserveMetadata.checked = preset.preserveMetadata !== false;
  }

  await filterContainerOptions(elements.outputFormat.value);
  await filterResolutionOptions(elements.outputFormat.value, elements);
  await filterPixelFormats(elements.outputFormat.value, elements);
  await filterAudioCodecs(elements.outputFormat.value, elements);
  await filterSampleRates(elements.outputFormat.value, elements);
  await filterChannels(elements.outputFormat.value, elements);


  updateAudioSectionDisabledState();
  updateSummary(elements);
  showCompatibilityWarnings(elements);

  const shouldSkipMatchSource = !!elements.watchMode?.checked
    || audioOnly
    || await isFolderInputSelected();

  if (shouldSkipMatchSource) {
    if (elements.matchSource) {
      elements.matchSource.checked = false;
    }
    elements.resolution.disabled = false;
    elements.frameRate.disabled = false;
    updateSummary(elements);
    updateTranscodeJobPreview();
  } else if (elements.matchSource?.checked) {
    applyMatchSource().then(() => {
      elements.resolution.disabled = true;
      elements.frameRate.disabled = true;
    });
  } else {
    elements.resolution.disabled = false;
    elements.frameRate.disabled = false;
  }

  // Re-apply conditional section disables after preset load.
  updateAudioSectionDisabledState();
}

// Panel outputs:
// - summary: one-line job preview
// - log: append-only transcode output shown under Summary
const logTarget = document.getElementById('transcode-log-output');
const summaryTarget = document.getElementById('transcode-job-preview-box');

const el = {
  inputFiles: document.getElementById('inputFiles'),
  selectInputFiles: document.getElementById('selectInputFiles'),
  // Watch Mode: standard single-line path display (matches Ingest panel style)
  watchFolderPath: document.getElementById('transcode-watch-folder-path'),
  outputFormat: document.getElementById('outputFormat'),
  containerFormat: document.getElementById('containerFormat'),
  outputPath: document.getElementById('outputPath'),
  selectOutput: document.getElementById('selectOutput'),
  resolution: document.getElementById('resolution'),
  frameRate: document.getElementById('frameRate'),
  audioCodec: document.getElementById('audioCodec'),
  channels: document.getElementById('channels'),
  pixelFormat: document.getElementById('pixelFormat'),
  colorRange: document.getElementById('colorRange'),
  lutDisplay: document.getElementById('transcode-lut-display'),
  lutPath: document.getElementById('transcode-lut-path'),
  lutDrop: document.getElementById('transcode-lut-drop'),
  fieldOrder: document.getElementById('fieldOrder'),
  sampleRate: document.getElementById('sampleRate'),
  audioBitrate: document.getElementById('audioBitrate'),
  normalizeAudio: document.getElementById('normalizeAudio'),
  audioDelay: document.getElementById('audioDelay'),
  startBtn: document.getElementById('startTranscode'),
  cancelBtn: document.getElementById('cancelTranscode'),
  resetBtn: document.getElementById('resetTranscode'),
  progressBar: document.getElementById('transcode-progress'),
  log: logTarget,
  summary: summaryTarget,
  presetSelect: document.getElementById('transcode-preset'),
  savePresetBtn: document.getElementById('saveTranscodePreset'),
  loadPresetBtn: document.getElementById('loadTranscodePreset'),
  'transcode-verification-method': document.getElementById('transcode-verification-method'),
  saveLog: document.getElementById('transcode-save-log'),
  hideLog: document.getElementById('transcode-hide-log'),

  enableN8N: document.getElementById('transcode-enable-n8n'),
  n8nUrl: document.getElementById('transcode-n8n-url'),
  n8nAllowPrivate: document.getElementById('transcode-n8n-allow-private'),
  n8nLog: document.getElementById('transcode-n8n-log'),

  notes: document.getElementById('transcode-notes'),

  watchMode: document.getElementById('transcode-watch-mode'),
  watchProcessExisting: document.getElementById('transcode-watch-process-existing'),
  matchSource: document.getElementById('transcode-match-source'),
  preserveMetadata: document.getElementById('transcode-preserve-metadata'),
  videoDetails: document.getElementById('transcode-video-details'),
  audioOnly: document.getElementById('transcode-audio-only'),
  audioDetails: document.getElementById('transcode-audio-details'),
  captionSidecarButton: document.getElementById('transcode-select-captions'),
  captionSidecarDisplay: document.getElementById('transcode-captions-display'),
  captionSidecarPath: document.getElementById('transcode-captions-path'),
  captionSidecarClear: document.getElementById('transcode-clear-captions'),
  captionSidecarNotice: document.getElementById('transcode-caption-lock-notice'),
};

initTranscodeHideLogToggle();

if (el.audioOnly && !el.audioOnly.dataset.auto) {
  el.audioOnly.dataset.auto = '0';
}

const transcodePanelState = {
  probeSessionId: 0,
  fileInfoRows: [],
  fileInfoSource: 'none'
};

let captionSidecarSettingsLocked = false;
let captionSidecarAutoMatchSource = false;

/**
 * Disable/grey out Audio Settings when output container is an image sequence.
 * Image sequences cannot carry audio, and we don’t want audio validation or UI
 * to trip users up for sequence exports.
 */
function isAudioOnlyActiveUI() {
  const audioOnlyMode = !!el.audioOnly?.checked;
  const inferredAudioOnly = el.audioOnly?.dataset.auto === '1';
  return audioOnlyMode || inferredAudioOnly;
}

function bindAudioDetailsDisableGuards() {
  const details = el.audioDetails;
  if (!details) return;
  const summary = details.querySelector('summary');
  if (!summary || summary.dataset.disableGuardBound === '1') return;

  const blockIfDisabled = (e) => {
    if (details.dataset.disabled === '1') {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    return true;
  };

  summary.addEventListener('click', blockIfDisabled);
  summary.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      blockIfDisabled(e);
    }
  });

  summary.dataset.disableGuardBound = '1';
}

function updateAudioSectionDisabledState() {
  const details = el.audioDetails;
  if (!details) return;

  const container = el.containerFormat?.value || '';
  const outputFormat = el.outputFormat?.value || '';
  const isImageSeq = isImageSequenceOutput(container, outputFormat);
  const captionsAttached = !!String(el.captionSidecarPath?.value || '').trim();
  // Image sequences cannot carry audio, but caption attach controls live inside
  // this section, so keep the section reachable while a caption sidecar is attached.
  const disable = isImageSeq && !captionsAttached;

  details.dataset.disabled = disable ? '1' : '0';
  details.classList.toggle('section-disabled', disable);
  details.setAttribute('aria-disabled', disable ? 'true' : 'false');

  // Prevent accidental toggling/interaction when disabled.
  if (disable) details.open = false;

  // Disable/enable all controls inside the section.
  const controls = details.querySelectorAll('input, select, textarea, button');
  controls.forEach(ctrl => {
    ctrl.disabled = disable;
  });

  // Styled dropdown wrappers need a class to block pointer events reliably.
  const wrappers = details.querySelectorAll('.dropdown-wrapper');
  wrappers.forEach(w => w.classList.toggle('disabled', disable));

  // Close any open dropdowns if we disable the section while a list is open.
  if (disable) {
    details.querySelectorAll('.value-list.open').forEach(l => l.classList.remove('open'));
    details.querySelectorAll('.chosen-value.open').forEach(i => i.classList.remove('open'));
    details.querySelectorAll('.dropdown-wrapper.open').forEach(w => w.classList.remove('open'));
  }
}

// Bind once and set initial state.
bindAudioDetailsDisableGuards();
updateAudioSectionDisabledState();


function isLutFile(p) {
  const ext = (window.electron.extname(p || '') || '').toLowerCase();
  return ['.cube', '.3dl', '.dat'].includes(ext);
}

function setLut(p) {
  const path = p || '';
  if (el.lutPath) el.lutPath.value = path;
  if (el.lutDisplay) el.lutDisplay.value = path ? window.electron.basename(path) : '';
  if (el.lutDrop) {
    el.lutDrop.title = path || t('transcodeLutDropTitle', 'Drop LUT (.cube/.3dl/.dat) here');
  }
  updateSummary(el);
  updateTranscodeJobPreview();
}

function getLutDialogFilters() {
  return [{
    name: t('transcodeFilterLut', 'LUT'),
    extensions: ['cube', '3dl', 'dat']
  }];
}

// Captions sidecar picker (MCC/SCC)
function getCaptionSidecarDialogFilters() {
  return [
    {
      name: t('transcodeFilterCaptions', 'Captions'),
      extensions: ['mcc', 'scc']
    }
  ];
}

function getTranscodeLockTooltipText(lockState) {
  switch (lockState) {
    case 'captionSidecarLocked':
      return t(
        'transcodeCaptionSidecarLockedTitle',
        'Locked for caption attach (MXF + match source).'
      );
    case 'audioOnlyVideoSettingLocked':
      return t(
        'transcodeAudioOnlyVideoSettingDisabled',
        'Disabled in audio-only mode (video-only setting).'
      );
    default:
      return '';
  }
}

function setTranscodeLockTooltipState(field, lockState, { defaultTitleResolver } = {}) {
  if (!field) return;

  // Clear legacy cache data so we never restore stale literal strings from a
  // previous locale.
  delete field.dataset.prevTitle;

  if (lockState) {
    field.dataset.titleState = lockState;
    const lockTitle = getTranscodeLockTooltipText(lockState);
    if (lockTitle) {
      field.setAttribute('title', lockTitle);
    } else {
      field.removeAttribute('title');
    }
    return;
  }

  delete field.dataset.titleState;
  const resolvedTitle = typeof defaultTitleResolver === 'function'
    ? defaultTitleResolver(field)
    : '';
  if (resolvedTitle) {
    field.setAttribute('title', resolvedTitle);
  } else {
    field.removeAttribute('title');
  }
}

function setCaptionSidecarSettingsLocked(state) {
  captionSidecarSettingsLocked = !!state;
}

function releaseCaptionSidecarAutoMatchSource() {
  if (!captionSidecarAutoMatchSource) return;
  captionSidecarAutoMatchSource = false;
}

function updateCaptionSidecarNotice() {
  if (!el.captionSidecarNotice) return;

  const captionPath = String(el.captionSidecarPath?.value || '').trim();
  if (!captionPath) {
    el.captionSidecarNotice.hidden = true;
    el.captionSidecarNotice.textContent = '';
    return;
  }

  const fileLabel = typeof window.electron?.basename === 'function'
    ? window.electron.basename(captionPath)
    : captionPath;
  el.captionSidecarNotice.hidden = false;
  el.captionSidecarNotice.textContent = t(
    'transcodeCaptionSidecarNoticeLocked',
    'Caption attached: {{file}}. Video and audio settings were cleared and locked. Export uses MXF + Match Source automatically until the caption file is removed or the job completes.',
    { file: fileLabel }
  );
}

function setCaptionAttachControlDisabled(field, disabled, lockState = '', { defaultTitleResolver } = {}) {
  if (!field) return;

  const nextDisabled = !!disabled;
  field.disabled = nextDisabled;
  setTranscodeLockTooltipState(field, nextDisabled ? lockState : '', { defaultTitleResolver });

  const wrapper = typeof field.closest === 'function'
    ? field.closest('.dropdown-wrapper')
    : null;
  const chosen = wrapper?.querySelector('.chosen-value');
  if (chosen) {
    chosen.disabled = nextDisabled;
    setTranscodeLockTooltipState(chosen, nextDisabled ? lockState : '', { defaultTitleResolver });
  }

  if (!wrapper) return;

  wrapper.classList.toggle('disabled', nextDisabled);
  if (nextDisabled) {
    wrapper.classList.remove('open');
    wrapper.querySelectorAll('.value-list.open').forEach(list => list.classList.remove('open'));
    wrapper.querySelectorAll('.chosen-value.open').forEach(input => input.classList.remove('open'));
  }
}

function clearCaptionSidecarManagedSelections() {
  captionSidecarAutoMatchSource = false;

  if (el.audioOnly) {
    el.audioOnly.checked = false;
    el.audioOnly.dataset.auto = '0';
  }
  if (el.normalizeAudio) el.normalizeAudio.checked = false;
  if (el.preserveMetadata) el.preserveMetadata.checked = true;

  if (el.matchSource) {
    el.matchSource.checked = false;
    el.matchSource.disabled = false;
  }
  if (el.resolution) el.resolution.disabled = false;
  if (el.frameRate) el.frameRate.disabled = false;

  cachedVideoSelections = null;

  ['outputFormat', 'containerFormat', 'resolution', 'frameRate', 'pixelFormat', 'colorRange', 'fieldOrder', 'audioCodec', 'channels', 'sampleRate', 'audioBitrate']
    .forEach(id => setDropdownValue(id, ''));

  if (el.audioDelay) el.audioDelay.value = '';
  setLut('');
  updateAudioSectionDisabledState();
}

async function normalizeCaptionSidecarClearedLists() {
  try {
    if (typeof initAudioCodecDropdown === 'function') {
      await initAudioCodecDropdown();
      setDropdownValue('audioCodec', '');
    }

    await filterContainerOptions('');
    await filterResolutionOptions('', el);
    await filterFieldOrderOptions('', el);
    await filterFrameRateOptions('', el);
    await filterPixelFormats('', el);
    await filterColorRangeOptions('', el);
    await filterAudioCodecs('', el);
    await filterSampleRates('', el);
    await filterChannels('', el);
  } catch (_) {
    // Best effort only. Caption attach ignores these fields anyway.
  }

  updateAudioSectionDisabledState();
  setCaptionSidecarLockState();
  updateSummary(el);
  updateTranscodeJobPreview();
}

function setCaptionSidecarLockState() {
  const hasCaption = !!String(el.captionSidecarPath?.value || '').trim();
  const captionLockActive = hasCaption && captionSidecarSettingsLocked;
  const isAudioOnly = isAudioOnlyActiveUI();
  const audioSectionDisabled = el.audioDetails?.dataset.disabled === '1';
  const videoLockState = captionLockActive
    ? 'captionSidecarLocked'
    : (isAudioOnly ? 'audioOnlyVideoSettingLocked' : '');
  const videoDisabled = captionLockActive || isAudioOnly;

  if (el.videoDetails) {
    el.videoDetails.dataset.disabled = videoDisabled ? '1' : '0';
    el.videoDetails.classList.toggle('section-disabled', videoDisabled);
    el.videoDetails.setAttribute('aria-disabled', videoDisabled ? 'true' : 'false');
  }

  [
    el.outputFormat,
    el.containerFormat,
    el.resolution,
    el.frameRate,
    el.pixelFormat,
    el.colorRange,
    el.fieldOrder,
    el.preserveMetadata
  ].forEach(field => {
    setCaptionAttachControlDisabled(field, videoDisabled, videoLockState);
  });

  setCaptionAttachControlDisabled(el.lutDisplay, videoDisabled, videoLockState);
  if (el.lutDrop) {
    el.lutDrop.classList.toggle('disabled', videoDisabled);
    el.lutDrop.setAttribute('aria-disabled', videoDisabled ? 'true' : 'false');
    el.lutDrop.tabIndex = videoDisabled ? -1 : 0;
    setTranscodeLockTooltipState(el.lutDrop, videoDisabled ? videoLockState : '');
  }

  const audioDisabled = captionLockActive || audioSectionDisabled;
  const audioLockState = captionLockActive ? 'captionSidecarLocked' : '';
  [
    el.audioOnly,
    el.normalizeAudio,
    el.audioCodec,
    el.channels,
    el.sampleRate,
    el.audioBitrate,
    el.audioDelay
  ].forEach(field => {
    setCaptionAttachControlDisabled(field, audioDisabled, audioLockState);
  });

  if (el.matchSource) {
    const matchDisable = captionLockActive || isAudioOnly;
    const matchLockState = captionLockActive
      ? 'captionSidecarLocked'
      : (isAudioOnly ? 'audioOnlyVideoSettingLocked' : '');
    const previousLockState = el.matchSource.dataset.titleState;
    el.matchSource.disabled = matchDisable;
    setTranscodeLockTooltipState(el.matchSource, matchDisable ? matchLockState : '', {
      defaultTitleResolver: () => (el.matchSource.disabled ? getMatchSourceFolderTooltip() : '')
    });

    if (
      !matchDisable
      && (previousLockState === 'captionSidecarLocked' || previousLockState === 'audioOnlyVideoSettingLocked')
    ) {
      Promise.resolve(updateMatchSourceFromSelection()).catch(() => {});
    }
  }

  updateCaptionSidecarNotice();
}

function setCaptionSidecar(filePath) {
  const p = (filePath || '').trim();
  if (el.captionSidecarPath) el.captionSidecarPath.value = p;
  if (el.captionSidecarDisplay) el.captionSidecarDisplay.value = p;
  if (el.captionSidecarClear) el.captionSidecarClear.disabled = !p;

  if (!p) {
    setCaptionSidecarSettingsLocked(false);
    releaseCaptionSidecarAutoMatchSource();
    if (el.videoDetails) {
      el.videoDetails.dataset.disabled = '0';
      el.videoDetails.classList.remove('section-disabled');
      el.videoDetails.setAttribute('aria-disabled', 'false');
    }
    setCaptionSidecarLockState();
    updateAudioSectionDisabledState();
    updateSummary(el);
    updateTranscodeJobPreview();
    return;
  }

  setCaptionSidecarSettingsLocked(true);
  clearCaptionSidecarManagedSelections();
  setCaptionSidecarLockState();
  updateSummary(el);
  updateTranscodeJobPreview();
  Promise.resolve(normalizeCaptionSidecarClearedLists()).catch(() => {});
}

function clearCaptionSidecar() {
  setCaptionSidecar('');
}

async function pickSingleFile({ title, filters }) {
  const canSelect =
    (typeof window.electron?.openFile === 'function') ||
    (typeof ipc?.invoke === 'function');
  if (!canSelect) {
    throw new Error(t('transcodeFilePickerUnavailable', 'File picker unavailable (IPC bridge missing).'));
  }

  if (typeof window.electron?.openFile === 'function') {
    return window.electron.openFile({ title, filters });
  }

  if (typeof ipc?.invoke === 'function') {
    return ipc.invoke('open-file-dialog', { title, filters });
  }

  throw new Error(t('transcodeFilePickerUnavailable', 'File picker unavailable (IPC bridge missing).'));
}

el.captionSidecarButton?.addEventListener('click', async () => {
  let file = null;
  try {
    const title = t('transcodeCaptionSidecarDialogTitle', 'Select Caption File (.mcc or .scc)');
    file = await pickSingleFile({ title, filters: getCaptionSidecarDialogFilters() });
  } catch (err) {
    showError(t(
      'transcodeCaptionSidecarPickerFailed',
      '❌ Failed to select caption file: {{error}}',
      { error: err?.message || err }
    ));
    return;
  }

  if (file) {
    setCaptionSidecar(file);
    const msg = i18nMsg('transcodeCaptionSidecarAttached', '🧩 Captions attached: {{file}}', { file });
    logTranscode(msg, { fileId: file });
    appendLogLine(el.log, msg);
  }
});

el.captionSidecarClear?.addEventListener('click', () => {
  const prev = (el.captionSidecarPath?.value || '').trim();
  clearCaptionSidecar();
  const msg = i18nMsg('transcodeCaptionSidecarCleared', '🗑️ Captions cleared.');
  logTranscode(msg, { fileId: prev || '' });
  appendLogLine(el.log, msg);
});

const openLutFilePicker = async () => {
  if (el.lutDisplay?.disabled) return;
  let file = null;
  try {
    const title = t('transcodeSelectLutDialogTitle', 'Select LUT File');
    file = await pickSingleFile({ title, filters: getLutDialogFilters() });
  } catch (err) {
    showError(t(
      'transcodeLutPickerFailedError',
      '❌ Failed to select LUT file: {{error}}',
      { error: err?.message || err }
    ));
    return;
  }

  if (file) setLut(file);
};

el.lutDrop?.addEventListener('click', openLutFilePicker);

el.lutDrop?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  openLutFilePicker();
});

el.lutDrop?.addEventListener('dragover', (e) => {
  if (el.lutDisplay?.disabled) return;
  if (e.dataTransfer?.types?.includes?.('Files')) {
    e.preventDefault();
    el.lutDrop.classList.add('dragover');
  }
});

el.lutDrop?.addEventListener('dragleave', () => {
  el.lutDrop.classList.remove('dragover');
});

el.lutDrop?.addEventListener('drop', async (e) => {
  if (el.lutDisplay?.disabled) return;
  if (!e.dataTransfer?.types?.includes?.('Files')) return;
  e.preventDefault();
  el.lutDrop.classList.remove('dragover');

  const file = [...(e.dataTransfer.files || [])][0];
  let p = '';
  try {
    p = await window.electron?.getRealPath?.(file, e.dataTransfer, 0);
  } catch {
    p = '';
  }
  if (!p && file && typeof file.path === 'string') p = file.path;
  if (!p) return;

  if (!isLutFile(p)) {
    showTranscodeStatusText(i18nMsg('transcodeWarnNotALut', '⚠️ Not a LUT (.cube/.3dl/.dat).'));
    return;
  }

  // SECURITY: dropped file paths have not necessarily been approved in the main
  // process. Approve before storing into config so queue ingestion doesn't fail.
  let approvedPath = p;
  try {
    const approve = ipc.approvePaths || window.electron?.approvePaths;
    if (typeof approve === 'function') {
      const res = await approve([p], { kind: 'file', confirm: true });
      approvedPath = Array.isArray(res) ? (res[0] || '') : approvedPath;
    } else if (typeof ipc.invoke === 'function') {
      const res = await ipc.invoke('approve-paths', [p], { kind: 'file', confirm: true });
      approvedPath = Array.isArray(res) ? (res[0] || '') : approvedPath;
    }
  } catch (err) {
    showTranscodeStatusText(i18nMsg(
      'transcodeLutApproveFailedError',
      '❌ Failed to approve LUT: {{error}}',
      { error: err?.message || err }
    ));
    return;
  }

  if (!approvedPath) return;
  setLut(approvedPath);
  showTranscodeStatusText(i18nMsg(
    'transcodeLutSet',
    '🎨 LUT set: {{file}}',
    { file: window.electron.basename(approvedPath) }
  ));
});

el['transcode-verification-method'] = document.getElementById('transcode-verification-method');

autoResize(el.inputFiles);

const transcodeLockWrapper = document.getElementById('transcode-lock-wrapper');

// ========== Job Preview ==========
const transcodePreviewEl = document.getElementById('transcode-job-preview-box');

function updateTranscodeJobPreview() {
  if (!transcodePreviewEl) return;
  const cfg = gatherTranscodeConfig();

  const pixelFormatLabelMap = {
    yuv420p:      t('transcodePixelFormatYuv420p', 'YUV 4:2:0 8‑bit'),
    yuv422p:      t('transcodePixelFormatYuv422p', 'YUV 4:2:2 8‑bit'),
    yuv444p:      t('transcodePixelFormatYuv444p', 'YUV 4:4:4 8‑bit'),
    yuv422p10:    t('transcodePixelFormatYuv422p10', 'YUV 4:2:2 10‑bit'),
    yuv422p10le:  t('transcodePixelFormatYuv422p10le', 'YUV 4:2:2 10‑bit (LE)'),
    yuv444p10le:  t('transcodePixelFormatYuv444p10le', 'YUV 4:4:4 10‑bit'),
    yuv420p10le:  t('transcodePixelFormatYuv420p10le', 'YUV 4:2:0 10‑bit')
  };

  const fieldOrderLabelMap = {
    progressive:     t('transcodeFieldOrderProgressive', 'Progressive'),
    interlaced_tff:  t('transcodeFieldOrderUpperTff', 'Upper field first (TFF)'),
    tff:             t('transcodeFieldOrderUpperTff', 'Upper field first (TFF)'),
    interlaced_bff:  t('transcodeFieldOrderLowerBff', 'Lower field first (BFF)'),
    bff:             t('transcodeFieldOrderLowerBff', 'Lower field first (BFF)')
  };

  const verificationLabelMap = {
    metadata:  t('transcodeVerificationDurationFrame', 'Duration / Frame'),
    ssim_psnr: t('transcodeVerificationSsimPsnr', 'SSIM / PSNR')
  };

  const pixelFormatLabel = cfg.pixelFormat
    ? (pixelFormatLabelMap[cfg.pixelFormat] || cfg.pixelFormat)
    : t('transcodeValueDefault', 'default');

  const fieldOrderLabel = cfg.fieldOrder
    ? (fieldOrderLabelMap[cfg.fieldOrder] || cfg.fieldOrder)
    : t('transcodeFieldOrderProgressive', 'Progressive');

  const hasInputs = Array.isArray(cfg.inputFiles) && cfg.inputFiles.length > 0;
  const hasWatchFolder = !!cfg.watchFolder;
  const isWatchMode = !!el.watchMode?.checked;
  const captionSidecar = (cfg.captionSidecarPath || '').trim();
  const captionsAttached = !!captionSidecar;

  // No source files or watch folder? Clear preview so placeholder summary text is shown.
  if (!hasInputs && !hasWatchFolder && !isWatchMode) {
    transcodePreviewEl.value = '';
    transcodePreviewEl.placeholder = t('summaryPlaceholder', 'Summary will appear here.');
    autoResize(transcodePreviewEl);
    return;
  }

  const lines = [];

  lines.push(t('transcodeJobPreviewTitle', '🧾 Transcode Job Preview'));
  lines.push('──────────────────────────────');

  if (isWatchMode) {
    const watchFolderLabel = hasWatchFolder ? cfg.watchFolder : t('transcodeValueNoneSelected', 'none selected');
    lines.push(t(
      'transcodeJobPreviewInputWatch',
      'Input: Watch folder ({{folder}})',
      { folder: watchFolderLabel }
    ));
    lines.push(t(
      'transcodeJobPreviewWatchExisting',
      'Process existing files on start: {{state}}',
      { state: cfg.processExistingOnStart ? t('transcodeToggleOn', 'on') : t('transcodeToggleOff', 'off') }
    ));
  } else if (hasInputs) {
    const count = cfg.inputFiles.length;
    lines.push(t(
      'transcodeJobPreviewInputFiles',
      'Input: {{count}} file(s)',
      { count }
    ));
  }
  lines.push(t(
    'transcodeJobPreviewOutputFolder',
    'Output folder: {{folder}}',
    { folder: cfg.outputFolder || t('transcodeValueNotSet', '(not set)') }
  ));
  lines.push(t(
    'transcodeJobPreviewAudioOnly',
    'Audio-only mode: {{state}}',
    { state: cfg.audioOnly ? t('transcodeToggleOn', 'on') : t('transcodeToggleOff', 'off') }
  ));

  if (cfg.audioOnly) {
    lines.push(t(
      'transcodeJobPreviewOutputType',
      'Output type: {{value}}',
      { value: cfg.containerFormat || t('transcodeValueNone', '(none)') }
    ));
  } else {
    const outputFormatLabel = captionsAttached
      ? t('transcodeJobPreviewCaptionsFormat', 'match source (captions attached)')
      : (cfg.outputFormat || t('transcodeValueNone', '(none)'));
    const containerLabel = captionsAttached
      ? t('transcodeJobPreviewCaptionsContainer', 'mxf (locked)')
      : (cfg.containerFormat || t('transcodeValueNone', '(none)'));
    lines.push(t(
      'transcodeJobPreviewOutputFormat',
      'Output format: {{value}}',
      { value: outputFormatLabel }
    ));
    lines.push(t(
      'transcodeJobPreviewContainer',
      'Container: {{value}}',
      { value: containerLabel }
    ));
    lines.push(t(
      'transcodeJobPreviewResolution',
      'Resolution: {{value}}',
      { value: cfg.resolution || t('transcodeValueMatch', 'match') }
    ));
    const frameRateLabel = cfg.frameRate
      ? (
          cfg.dropFrame
            ? t('transcodeFrameRateValueDropFrame', '{{value}} DF', { value: cfg.frameRate })
            : t('transcodeFrameRateValueFps', '{{value}} fps', { value: cfg.frameRate })
        )
      : t('transcodeValueMatch', 'match');
    lines.push(t(
      'transcodeJobPreviewFrameRate',
      'Frame rate: {{value}}',
      { value: frameRateLabel }
    ));
    lines.push(t(
      'transcodeJobPreviewPixelFormat',
      'Pixel format: {{value}}',
      { value: pixelFormatLabel }
    ));
    lines.push(t(
      'transcodeJobPreviewLut',
      'LUT: {{value}}',
      { value: cfg.lutPath ? window.electron.basename(cfg.lutPath) : t('transcodeToggleOff', 'off') }
    ));
    lines.push(t(
      'transcodeJobPreviewColorRange',
      'Color range: {{value}}',
      { value: cfg.colorRange || t('transcodeValueUnspecified', 'unspecified') }
    ));
    lines.push(t(
      'transcodeJobPreviewFieldOrder',
      'Field order: {{value}}',
      { value: fieldOrderLabel }
    ));
    lines.push(t(
      'transcodeJobPreviewMatchSource',
      'Match source: {{state}}',
      {
        state: captionsAttached
          ? t('transcodeCaptionMatchSourceLocked', 'on (locked)')
          : (cfg.matchSource ? t('transcodeToggleOn', 'on') : t('transcodeToggleOff', 'off'))
      }
    ));
  }

  lines.push(t(
    'transcodeJobPreviewPreserveMetadata',
    'Preserve metadata: {{state}}',
    { state: cfg.preserveMetadata ? t('transcodeToggleOn', 'on') : t('transcodeToggleOff', 'off') }
  ));

  if (captionsAttached) {
    lines.push(t(
      'transcodeJobPreviewCaptionSidecar',
      'Caption sidecar: {{file}}',
      { file: captionSidecar ? window.electron.basename(captionSidecar) : t('transcodeValueNone', '(none)') }
    ));
  }

  if (!cfg.audioOnly && isImageSequenceOutput(cfg.containerFormat, cfg.outputFormat)) {
    lines.push(t(
      'transcodeJobPreviewAudioNoneImageSequence',
      'Audio: no audio (image sequence)'
    ));
  } else {
    const audioWrapperLabel = cfg.audioOnly
      ? (cfg.containerFormat || cfg.audioCodec)
      : cfg.audioCodec;
    lines.push(t(
      'transcodeJobPreviewAudioWrapper',
      'Audio wrapper: {{value}}',
      { value: audioWrapperLabel || t('transcodeValueNone', '(none)') }
    ));
    if (cfg.audioOnly && cfg.audioCodec && cfg.audioCodec !== cfg.containerFormat) {
      lines.push(t(
        'transcodeJobPreviewAudioCodec',
        'Audio codec: {{value}}',
        { value: cfg.audioCodec }
      ));
    }
    lines.push(t(
      'transcodeJobPreviewAudioChannels',
      'Channels: {{value}}',
      { value: cfg.channels || t('transcodeValuePreserve', 'preserve') }
    ));
    lines.push(t(
      'transcodeJobPreviewSampleRate',
      'Sample rate: {{value}}',
      { value: cfg.sampleRate || t('transcodeValueDefault', 'default') }
    ));
    lines.push(t(
      'transcodeJobPreviewAudioBitrate',
      'Audio bitrate: {{value}}',
      { value: cfg.audioBitrate || t('transcodeValueAuto', '(auto)') }
    ));
    lines.push(t(
      'transcodeJobPreviewNormalizeAudio',
      'Normalize audio: {{state}}',
      { state: cfg.normalizeAudio ? t('transcodeToggleOn', 'on') : t('transcodeToggleOff', 'off') }
    ));
    lines.push(t(
      'transcodeJobPreviewAudioDelay',
      'Audio delay: {{value}}',
      {
        value: cfg.audioDelay
          ? t('transcodeValueMilliseconds', '{{ms}} ms', { ms: cfg.audioDelay })
          : t('transcodeValueZeroMs', '0 ms')
      }
    ));
  }

  const verificationMethod = cfg.verification?.method || 'metadata';
  const verificationLabel = verificationLabelMap[verificationMethod] || verificationMethod;
  lines.push(t(
    'transcodeJobPreviewVerify',
    'Verify: {{value}}',
    { value: verificationLabel }
  ));
  lines.push(t(
    'transcodeJobPreviewSaveLog',
    'Save log: {{state}}',
    { state: cfg.verification?.saveLog ? t('transcodeToggleOn', 'on') : t('transcodeToggleOff', 'off') }
  ));

  if (isWatchMode && !hasWatchFolder) {
    lines.push(t(
      'transcodePreviewWatchOnNoFolder',
      'Watch mode: on (no folder selected)'
    ));
  } else {
    lines.push(t(
      'transcodePreviewWatchState',
      'Watch mode: {{state}}',
      { state: isWatchMode ? t('transcodeToggleOn', 'on') : t('transcodeToggleOff', 'off') }
    ));
  }
  lines.push(t(
    'transcodeJobPreviewN8nWebhook',
    'n8n webhook: {{value}}',
    { value: cfg.enableN8N ? (cfg.n8nUrl || t('transcodeValueNoUrl', '(no URL)')) : t('transcodeToggleOff', 'off') }
  ));
  if (cfg.enableN8N) {
    lines.push(t(
      'transcodeJobPreviewN8nAllowPrivate',
      'Allow private/localhost targets: {{state}}',
      { state: cfg.n8nAllowPrivate ? t('transcodeToggleOn', 'on') : t('transcodeToggleOff', 'off') }
    ));
  }
  lines.push(t(
    'transcodeJobPreviewN8nSendLog',
    'Send log to n8n: {{state}}',
    { state: cfg.n8nLog ? t('transcodeToggleOn', 'on') : t('transcodeToggleOff', 'off') }
  ));
  if (cfg.notes?.trim()) {
    lines.push(t(
      'transcodeJobPreviewNotes',
      'Notes: {{notes}}',
      { notes: cfg.notes.trim() }
    ));
  }

  transcodePreviewEl.value = lines.join('\n');
  autoResize(transcodePreviewEl);
}

const previewBindingIds = [
  'inputFiles',
  'outputPath',
  'outputFormat',
  'containerFormat',
  'resolution',
  'frameRate',
  'pixelFormat',
  'transcode-lut-path',
  'colorRange',
  'fieldOrder',
  'transcode-match-source',
  'transcode-preserve-metadata',
  'audioCodec',
  'channels',
  'sampleRate',
  'audioBitrate',
  'normalizeAudio',
  'audioDelay',
  'transcode-enable-n8n',
  'transcode-n8n-url',
  'transcode-n8n-allow-private',
  'transcode-n8n-log',
  'transcode-watch-mode',
  'transcode-notes',
  'transcode-audio-only',
  'transcode-verification-method',
  'transcode-save-log'
];

previewBindingIds.forEach(id => {
  const target = document.getElementById(id);
  if (!target) return;
  let eventName = 'change';
  if (target.tagName === 'INPUT' && (target.type === 'text' || target.type === 'number')) {
    eventName = 'input';
  } else if (target.tagName === 'TEXTAREA') {
    eventName = 'input';
  }
  target.addEventListener(eventName, updateTranscodeJobPreview);
});

updateTranscodeJobPreview();

function showError(msg) {
  logTranscode(msg, { isError: true });
  appendLogLine(el.log, msg);
}

// Disable cancel until a transcode is running
el.cancelBtn.disabled = true;

function setTranscodeControlsDisabled(state) {
  const transcodeDisabledSelector = [
    '#transcode input:not(#transcode-log-output):not(#transcode-job-preview-box):not(#transcode-hide-log)',
    '#transcode select:not(#transcode-log-output):not(#transcode-job-preview-box)',
    '#transcode textarea:not(#transcode-log-output):not(#transcode-job-preview-box)',
    '#transcode button:not(#transcode-log-output):not(#transcode-job-preview-box)'
  ].join(',');

  document.querySelectorAll(transcodeDisabledSelector).forEach(elem => {
if (elem.id === 'transcode-watch-mode') {
  elem.disabled = state; // allow it to lock like others
  return;
}

    if (elem.id === 'cancelTranscode') return;    
    elem.disabled = state;
  });
  el.startBtn.disabled = state;
  el.resetBtn.disabled = state;

  if (state) {
    transcodeLockWrapper?.classList.add('locked');
  } else {
    transcodeLockWrapper?.classList.remove('locked');
    // Re-apply conditional disables (e.g., image sequence outputs have no audio section).
    updateAudioSectionDisabledState();
    setCaptionSidecarLockState();
  }
}

function setVideoControlsDisabled(state) {
  [
    el.outputFormat,
    el.containerFormat,
    el.resolution,
    el.frameRate,
    el.pixelFormat,
    el.colorRange,
    el.lutDisplay,
    el.lutPath,
    el.lutDrop,
    el.fieldOrder
  ].forEach(field => {
    if (field) field.disabled = state;
  });

  const videoOnlyFields = [el.matchSource, el.preserveMetadata];
  let clearedVideoOnlyFlags = false;
  videoOnlyFields.forEach(field => {
    if (!field) return;
    field.disabled = state;
    if (state) {
      setTranscodeLockTooltipState(field, 'audioOnlyVideoSettingLocked');
      if (field.checked) {
        field.checked = false;
        clearedVideoOnlyFlags = true;
      }
    } else {
      setTranscodeLockTooltipState(field, '', {
        defaultTitleResolver: () => (field === el.matchSource && field.disabled ? getMatchSourceFolderTooltip() : '')
      });
    }
  });

  if (!state && el.matchSource?.dataset.titleState === 'audioOnlyVideoSettingLocked') {
    Promise.resolve(updateMatchSourceFromSelection()).catch(() => {});
  }

  if (clearedVideoOnlyFlags) {
    updateSummary(el);
    updateTranscodeJobPreview();
  }
}

let cachedVideoSelections = null;
let cachedAudioCodec = '';

async function toggleAudioOnlyMode(options = {}) {
  const { restoreCached = true } = options;
  const enabled = !!el.audioOnly?.checked;
  const currentAudioCodec = (el.audioCodec?.value || '').trim();
  await ensureAudioOnlyWrapperMetadataLoaded();
  setVideoControlsDisabled(enabled);
  if (enabled) {
    cachedVideoSelections = {
      outputFormat: el.outputFormat?.value,
      containerFormat: el.containerFormat?.value,
      resolution: el.resolution?.value,
      frameRate: el.frameRate?.value,
      pixelFormat: el.pixelFormat?.value,
      colorRange: el.colorRange?.value,
      fieldOrder: el.fieldOrder?.value,
      lutPath: el.lutPath?.value
    };
    cachedAudioCodec = currentAudioCodec;
    setDropdownValue('outputFormat', '');
    setDropdownValue('containerFormat', '');
    setDropdownValue('resolution', '');
    setDropdownValue('frameRate', '');
    setDropdownValue('pixelFormat', '');
    setDropdownValue('colorRange', '');
    setDropdownValue('fieldOrder', '');
    setLut('');
    setupStyledDropdown('audioCodec', audioWrapperList);
    enforceLicenseLocks();
    const fallbackWrapper = audioWrapperList.includes('wav')
      ? 'wav'
      : (audioWrapperList[0] || '');
    const nextAudioCodec = currentAudioCodec && audioWrapperList.includes(currentAudioCodec)
      ? currentAudioCodec
      : fallbackWrapper;
    setDropdownValue('audioCodec', nextAudioCodec);
    const allowedChannels = new Set(['mono', 'stereo', '5.1', '7.1', 'preserve']);
    const currentChannels = (el.channels?.value || '').trim();
    if (!allowedChannels.has(currentChannels)) {
      setDropdownValue('channels', 'preserve');
    }
    await initSampleRateDropdown();
    await filterSampleRates('', el);
    await filterChannels('', el);
  } else {
    if (restoreCached && cachedVideoSelections) {
      setDropdownValue('outputFormat', cachedVideoSelections.outputFormat || '');
      // If a cached selection refers to a format unavailable in this FFmpeg build, clear it
      // so we don’t resurrect an invalid hidden value.
      const cachedFmt = (cachedVideoSelections.outputFormat || '').trim();
      if (cachedFmt) {
        try {
          const caps = await window.codex?.getFormatCapabilities?.(cachedFmt);
          if (!caps?.encoderAvailable) {
            logTranscode(i18nMsg(
              'transcodeWarnCachedFormatUnsupported',
              '⚠️ Cached output format "{{format}}" is not supported by this FFmpeg build. Please choose a supported format.',
              { format: cachedFmt }
            ));
            setDropdownValue('outputFormat', '');
            cachedVideoSelections.outputFormat = '';
          }
        } catch {
          // ignore
        }
      }
      setDropdownValue('containerFormat', cachedVideoSelections.containerFormat || '');
      setDropdownValue('resolution', cachedVideoSelections.resolution || '');
      setDropdownValue('frameRate', cachedVideoSelections.frameRate || '');
      setDropdownValue('pixelFormat', cachedVideoSelections.pixelFormat || '');
      setDropdownValue('colorRange', cachedVideoSelections.colorRange || '');
      setDropdownValue('fieldOrder', cachedVideoSelections.fieldOrder || '');
      setLut(cachedVideoSelections.lutPath || '');
      const restoredFormat = cachedVideoSelections.outputFormat || '';
      await filterContainerOptions(restoredFormat);
      await filterResolutionOptions(restoredFormat, el);
      await filterPixelFormats(restoredFormat, el);
      await filterAudioCodecs(restoredFormat, el);
      await filterSampleRates(restoredFormat, el);
      await filterChannels(restoredFormat, el);
    }
    if (!cachedAudioCodecList.length) {
      await initAudioCodecDropdown();
    } else {
      setupStyledDropdown('audioCodec', cachedAudioCodecList);
      enforceLicenseLocks();
    }
    const restoredAudioCodec = cachedAudioCodecList.includes(cachedAudioCodec)
      ? cachedAudioCodec
      : (cachedAudioCodecList[0] || '');
    setDropdownValue('audioCodec', restoredAudioCodec);
  }
  updateAudioSectionDisabledState();
  updateSummary(el);
}

function gatherTranscodeConfig() {
  const inputList = readInputFileList();
  const captionSidecarPath = (el.captionSidecarPath?.value || '').trim();
  const captionsAttached = !!captionSidecarPath;
  const audioOnlyMode = captionsAttached ? false : !!el.audioOnly?.checked;
  const inferredAudioOnly = !captionsAttached && el.audioOnly?.dataset.auto === '1';
  const isAudioOnly = audioOnlyMode || inferredAudioOnly;
  const audioWrapper = isAudioOnly ? el.audioCodec?.value : null;
  const audioOnlySettings = isAudioOnly
    ? resolveAudioOnlySettings(audioWrapper, el.audioBitrate?.value || null)
    : null;
  const format = captionsAttached ? '' : (el.outputFormat?.value || '');
  const pixelFmt = captionsAttached ? '' : (el.pixelFormat?.value || '');
  const sampleRate = captionsAttached ? '' : (el.sampleRate?.value || '');
  const selectedRate = captionsAttached ? '' : (el.frameRate?.value || '');
  const numericRate = selectedRate.endsWith('df') ? selectedRate.replace('df', '') : selectedRate;
  const cfg = {
    inputFiles: inputList,
    outputFormat: captionsAttached ? null : (isAudioOnly ? null : format),
    containerFormat: captionsAttached ? 'mxf' : (isAudioOnly ? audioOnlySettings?.wrapper : el.containerFormat?.value),
    outputFolder: el.outputPath?.value,
    resolution: captionsAttached ? null : (isAudioOnly ? null : el.resolution?.value),
    frameRateRaw: captionsAttached ? null : (isAudioOnly ? null : selectedRate),
    frameRate: captionsAttached ? null : (isAudioOnly ? null : numericRate),
    dropFrame: captionsAttached ? false : selectedRate.endsWith('df'),
    audioCodec: captionsAttached ? null : (isAudioOnly ? audioOnlySettings?.audioCodec : el.audioCodec?.value),
    channels: captionsAttached ? null : el.channels?.value,
    pixelFormat: captionsAttached ? null : (isAudioOnly ? null : pixelFmt),
    colorRange: captionsAttached ? null : el.colorRange?.value,
    fieldOrder: captionsAttached ? null : el.fieldOrder?.value,
    lutPath: captionsAttached ? null : (el.lutPath?.value || null),
    sampleRate: captionsAttached ? null : sampleRate,
    audioBitrate: captionsAttached ? null : (isAudioOnly ? audioOnlySettings?.audioBitrate : (el.audioBitrate?.value || null)),
    normalizeAudio: captionsAttached ? false : !!el.normalizeAudio?.checked,
    audioDelay: captionsAttached ? null : (el.audioDelay?.value || null),
    captionSidecarPath: captionSidecarPath || null,
    enableN8N: !!el.enableN8N?.checked,
    n8nUrl: (el.n8nUrl?.value || '').trim(),
    n8nAllowPrivate: !!el.n8nAllowPrivate?.checked,
    n8nLog: !!el.n8nLog?.checked,
    notes: el.notes?.value || '',
    matchSource: captionsAttached ? true : !!el.matchSource?.checked,
    preserveMetadata: captionsAttached ? true : !!el.preserveMetadata?.checked,
    audioOnly: captionsAttached ? false : isAudioOnly,
    processExistingOnStart: !!el.watchProcessExisting?.checked
  };

  if (!captionsAttached && !isAudioOnly && isImageSequenceOutput(cfg.containerFormat, cfg.outputFormat)) {
    cfg.audioCodec = null;
    cfg.channels = null;
    cfg.sampleRate = null;
    cfg.audioBitrate = null;
    cfg.normalizeAudio = false;
    cfg.audioDelay = null;
  }

  cfg.verification = {
    method: el['transcode-verification-method']?.value || 'metadata',
    saveLog: !!el.saveLog?.checked
  };

  if (el.watchMode?.checked && inputList.length === 1) {
    cfg.watchFolder = inputList[0];
  }

  return cfg;
}

function buildTranscodePresetPayload() {
  const selectedInputFiles = readInputFileList(el.inputFiles)
    .map(file => String(file || '').trim())
    .filter(Boolean);
  const isWatchMode = !!el.watchMode?.checked;
  const isAudioOnlyPreset = !!el.audioOnly?.checked;
  const watchFolder = isWatchMode
    ? String(selectedInputFiles[0] || '').trim()
    : '';
  const preservedVideoSelections = isAudioOnlyPreset ? (cachedVideoSelections || {}) : {};

  return {
    outputPath: el.outputPath?.value || '',
    outputFormat: isAudioOnlyPreset ? (preservedVideoSelections.outputFormat || '') : el.outputFormat.value,
    containerFormat: isAudioOnlyPreset ? (preservedVideoSelections.containerFormat || '') : el.containerFormat?.value,
    resolution: isAudioOnlyPreset ? (preservedVideoSelections.resolution || '') : el.resolution?.value,
    frameRate: isAudioOnlyPreset ? (preservedVideoSelections.frameRate || '') : el.frameRate?.value,
    pixelFormat: isAudioOnlyPreset ? (preservedVideoSelections.pixelFormat || '') : el.pixelFormat?.value,
    colorRange: isAudioOnlyPreset ? (preservedVideoSelections.colorRange || '') : el.colorRange?.value,
    fieldOrder: isAudioOnlyPreset ? (preservedVideoSelections.fieldOrder || '') : el.fieldOrder?.value,
    lutPath: isAudioOnlyPreset ? (preservedVideoSelections.lutPath || '') : (el.lutPath?.value || ''),
    audioCodec: el.audioCodec?.value,
    channels: el.channels?.value,
    sampleRate: el.sampleRate?.value,
    audioBitrate: el.audioBitrate?.value,
    audioDelay: el.audioDelay?.value,
    captionSidecarPath: el.captionSidecarPath?.value || '',
    verificationMethod: el['transcode-verification-method']?.value || 'metadata',
    verification: {
      method: el['transcode-verification-method']?.value || 'metadata',
      saveLog: !!el.saveLog?.checked
    },
    saveLog: !!el.saveLog?.checked,
    enableN8N: !!el.enableN8N?.checked,
    n8nUrl: (el.n8nUrl?.value || '').trim(),
    n8nAllowPrivate: !!el.n8nAllowPrivate?.checked,
    n8nLog: !!el.n8nLog?.checked,
    notes: el.notes?.value || '',
    watchMode: isWatchMode,
    watchProcessExisting: !!el.watchProcessExisting?.checked,
    processExistingOnStart: !!el.watchProcessExisting?.checked,
    watchFolder,
    watchFolderPath: watchFolder,
    inputFiles: isWatchMode ? [] : selectedInputFiles,
    sourcePaths: isWatchMode ? [] : selectedInputFiles,
    audioOnly: isAudioOnlyPreset,
    normalizeAudio: !!el.normalizeAudio?.checked,
    matchSource: !!el.matchSource?.checked,
    preserveMetadata: !!el.preserveMetadata?.checked
  };
}

function isPrivateAddress(hostname) {
  const host = (hostname || '').toLowerCase();
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
    return { valid: false, message: `❌ ${t('adobeUtilities.n8nUrlMissing', 'Please provide an n8n URL when webhook logging is enabled.')}` };
  }

  let parsed;
  let parsedHostname;
  try {
    parsed = new URL(trimmed);
    parsedHostname = parsed.hostname;
  } catch {
    const scopedMatch = trimmed.match(/^(https?:)\/\/\[([^\]]+)\](.*)$/i);
    if (!scopedMatch) {
      return { valid: false, message: `❌ ${t('adobeUtilities.n8nUrlInvalid', 'Invalid n8n URL. Please use a full http/https address.')}` };
    }
    const scopedHost = scopedMatch[2];
    const sanitizedHost = scopedHost.split('%')[0];
    if (!sanitizedHost) {
      return { valid: false, message: `❌ ${t('adobeUtilities.n8nUrlInvalid', 'Invalid n8n URL. Please use a full http/https address.')}` };
    }
    try {
      parsed = new URL(`${scopedMatch[1]}//[${sanitizedHost}]${scopedMatch[3]}`);
      parsedHostname = scopedHost;
    } catch {
      return { valid: false, message: `❌ ${t('adobeUtilities.n8nUrlInvalid', 'Invalid n8n URL. Please use a full http/https address.')}` };
    }
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, message: `❌ ${t('adobeUtilities.n8nUrlProtocol', 'n8n URL must start with http:// or https://.')}` };
  }

  const hostname = String(parsedHostname || '').trim();
  if (!hostname) {
    return { valid: false, message: `❌ ${t('adobeUtilities.n8nUrlHostnameMissing', 'Invalid n8n URL. Please include a hostname.')}` };
  }

  const normalizedHostname = hostname.split('%')[0];
  if (!allowPrivate && isPrivateAddress(normalizedHostname)) {
    return {
      valid: false,
      message: `❌ ${t('adobeUtilities.n8nUrlPrivateDisallowed', 'n8n URL cannot target localhost or private networks unless private targets are explicitly allowed.')}`
    };
  }

  return { valid: true, url: trimmed };
}

function validateRequiredVideoSettings(cfg) {
  if (!cfg || cfg.audioOnly) return true;

  const missing = [];
  if (!cfg.outputFormat) missing.push(t('outputFormat', 'Output Format'));
  if (!cfg.containerFormat) missing.push(t('containerFormat', 'Container Format'));
  if (!cfg.resolution) missing.push(t('resolution', 'Resolution'));
  if (!cfg.frameRate) missing.push(t('frameRate', 'Frame Rate'));

  if (!missing.length) return true;
  return t('transcodeMissingFields', 'Missing: {{fields}}', { fields: missing.join(', ') });
}

function formatValidationMessage(message) {
  if (!message) return '';
  return message.startsWith('❌') ? message : `❌ ${message}`;
}

async function validateTranscodeStartConfig(cfg) {
  if (!cfg) {
    return { ok: false, message: formatValidationMessage(t('transcodeNoConfigFound', 'No transcode configuration found.')) };
  }

  const outputFolder = String(cfg.outputFolder || '').trim();
  if (!outputFolder) {
    return {
      ok: false,
      message: formatValidationMessage(t('transcodeSelectOutputFolderError', '❌ Please select an output folder.'))
    };
  }

  const captionSidecar = String(cfg.captionSidecarPath || '').trim();
  if (captionSidecar) {
    if (cfg.audioOnly) {
      return {
        ok: false,
        message: formatValidationMessage(
          t('transcodeCaptionsNotAllowedAudioOnly', 'Captions cannot be embedded in audio-only exports.')
        )
      };
    }

    const files = Array.isArray(cfg.inputFiles) ? cfg.inputFiles.filter(Boolean) : [];
    if (files.length !== 1) {
      return {
        ok: false,
        message: formatValidationMessage(
          t('transcodeCaptionsAttachNeedsSingleInput', 'Captions attach requires exactly 1 input file.')
        )
      };
    }

    const ext = (window.electron?.extname ? window.electron.extname(captionSidecar) : captionSidecar).toLowerCase();
    if (!ext.endsWith('.mcc') && !ext.endsWith('.scc')) {
      return {
        ok: false,
        message: formatValidationMessage(t('transcodeCaptionFileMustBeMccOrScc', 'Caption file must be .mcc or .scc'))
      };
    }

    // Captions-attach mode is “match source → MXF”. Video/audio settings are ignored by the backend.
    return { ok: true };
  }

  const matchSourceFiles = Array.isArray(cfg.inputFiles) ? cfg.inputFiles.filter(Boolean) : [];
  if (cfg.matchSource && matchSourceFiles.length !== 1) {
    return {
      ok: false,
      message: formatValidationMessage(
        t('transcodeMatchSourceNeedsSingleInput', 'Match Source requires exactly 1 input file.')
      )
    };
  }

  const format = cfg.outputFormat;
  const container = cfg.containerFormat;
  const resolution = cfg.resolution;
  const frameRate = cfg.frameRate;
  const frameRateRaw = cfg.frameRateRaw ?? frameRate;
  const pixelFmt = cfg.pixelFormat;
  const sampleRate = cfg.sampleRate;
  const codec = cfg.audioCodec;
  const audioOnlyMode = cfg.audioOnly;
  const audioWrapper = audioOnlyMode ? String(cfg.containerFormat || '').trim().toLowerCase() : '';

  const requiredCheck = validateRequiredVideoSettings(cfg);
  if (requiredCheck !== true) {
    return { ok: false, message: formatValidationMessage(requiredCheck) };
  }


  const audioDelayValue = cfg.audioDelay;
  const numericAudioDelay = audioDelayValue === null || audioDelayValue === ''
    ? null
    : Number(audioDelayValue);
  if (audioDelayValue !== null && audioDelayValue !== '' && !Number.isFinite(numericAudioDelay)) {
    return { ok: false, message: formatValidationMessage(t('transcodeAudioDelayMustBeNumber', 'Audio delay must be a number.')) };
  }
  if (Number.isFinite(numericAudioDelay) && numericAudioDelay < 0) {
    return { ok: false, message: formatValidationMessage(t('transcodeAudioDelayMustBeNonNegative', 'Audio delay must be 0 ms or greater.')) };
  }

  if (!audioOnlyMode && !cfg.containerFormat) {
    return { ok: false, message: formatValidationMessage(t('transcodeSelectContainerFormatBeforeStart', 'Please select a container format before starting.')) };
  }

  // Phase 1 guardrail: prevent sequence/container mismatches from producing
  // silently wrong outputs. The backend only switches to image sequence
  // behavior when containerFormat is image_sequence/image2.
  if (!audioOnlyMode) {
    const isSeqFormat = typeof format === 'string' && format.includes('sequence');
    const isSeqContainer = (container === 'image_sequence' || container === 'image2');

    if (isSeqFormat && !isSeqContainer) {
      return { ok: false, message: t('transcodeErrorSeqFormatNeedsSeqContainer', '🛑 Output format is an image sequence. Set container to "image_sequence".') };
    }
    if (isSeqContainer && !isSeqFormat) {
      return {
        ok: false,
        message: t('transcodeErrorSeqContainerNeedsSeqFormat', '🛑 Container is set to "image_sequence" but output format is not a sequence. Choose a sequence format.')
      };
    }
  }

  const formatCompat = format
    ? (__compatCache.get(format) || await window.codex?.getCompatibility?.(format))
    : null;
  if (formatCompat && !__compatCache.has(format)) __compatCache.set(format, formatCompat);

  // Image sequence outputs cannot carry audio. Do not require or validate audio codec in that case.
  const isImageSeqContainer = (container === 'image_sequence' || container === 'image2');
  const formatHasAudio = Array.isArray(formatCompat?.audioCodecs)
    ? formatCompat.audioCodecs.length > 0
    : true; // if unknown, assume audio is possible to avoid silent misconfig
  const audioRelevant = !!audioOnlyMode || (!isImageSeqContainer && formatHasAudio);

  if (audioRelevant && !codec) {
    return { ok: false, message: t('transcodeNoAudioCodecSelected', '❌ No audio codec selected.') };
  }

  if (!audioOnlyMode) {
    // Strict compatibility check: reject incompatible container selection.
    const validList = formatCompat?.containers || [];
    if (validList.length && !validList.includes(container)) {
      return {
        ok: false,
        message: t(
          'transcodeFormatContainerIncompatible',
          '❌ {{format}} is not compatible with {{container}}.',
          { format, container }
        ),
        log: true,
        status: 'invalid_container'
      };
    }

    const allowedResolutions = Array.isArray(formatCompat?.resolutions) ? formatCompat.resolutions : [];
    if (allowedResolutions.length && resolution && !allowedResolutions.includes(resolution)) {
      return {
        ok: false,
        message: t(
          'transcodeResolutionNotCompatible',
          '❌ Resolution "{{resolution}}" is not compatible with format "{{format}}".',
          { resolution, format }
        ),
        log: true,
        status: 'invalid_resolution'
      };
    }

    const allowedFrameRates = Array.isArray(formatCompat?.frameRates) ? formatCompat.frameRates : [];
    if (allowedFrameRates.length && frameRateRaw && !isAllowedFrameRate(frameRateRaw, allowedFrameRates)) {
      return {
        ok: false,
        message: t(
          'transcodeFrameRateNotCompatible',
          '❌ Frame rate "{{frameRate}}" is not compatible with format "{{format}}".',
          { frameRate: frameRateRaw, format }
        ),
        log: true,
        status: 'invalid_frame_rate'
      };
    }

    // Only validate audio settings when this output actually supports audio.
    if (audioRelevant) {
      const audioContainerOK = await isAudioContainerValid(codec, container);
      if (!audioContainerOK) {
        return {
          ok: false,
          message: t(
            'transcodeAudioCodecNotCompatibleWithContainer',
            '❌ Audio codec "{{codec}}" is not compatible with container "{{container}}".',
            { codec, container }
          ),
          log: true,
          status: 'invalid_audio_container'
        };
      }

      // Strict compatibility check: reject incompatible audio codec for format.
      const allowedAudio = formatCompat?.audioCodecs || audioCodecCompatibility[format];
      if (Array.isArray(allowedAudio) && allowedAudio.length > 0) {
        if (!allowedAudio.includes(codec)) {
          return {
            ok: false,
            message: t(
              'transcodeAudioCodecNotCompatibleWithFormat',
              '❌ Audio codec "{{codec}}" is not compatible with format "{{format}}".',
              { codec, format }
            ),
            log: true,
            status: 'invalid_audio_codec'
          };
        }
      }
    }
  }

  if (audioRelevant) {
    const audioOnlyWrapperConstraints = audioOnlyMode
      ? await getAudioOnlyWrapperConstraints(audioWrapper)
      : null;

    if (audioOnlyMode && audioWrapper && !audioOnlyWrapperConstraints) {
      return {
        ok: false,
        message: t(
          'transcodeAudioWrapperUnsupported',
          '❌ Audio wrapper "{{wrapper}}" is not supported.',
          { wrapper: audioWrapper }
        ),
        log: true,
        status: 'invalid_audio_wrapper'
      };
    }

    const audioConstraints = !audioOnlyMode && codec
      ? await window.codex?.getAudioConstraints?.(codec)
      : null;
    const allowedSampleRatesRaw = audioOnlyMode
      ? (audioOnlyWrapperConstraints?.sampleRates || [])
      : (audioConstraints?.sampleRates || sampleRateCompatibility[codec] || []);
    const allowedChannelOptionsRaw = audioOnlyMode
      ? (audioOnlyWrapperConstraints?.channels || [])
      : (audioConstraints?.channels || channelCompatibility[codec] || []);
    const formatSampleRates = Array.isArray(formatCompat?.sampleRates) ? formatCompat.sampleRates : [];
    const formatChannelOptions = Array.isArray(formatCompat?.channelOptions) ? formatCompat.channelOptions : [];

    const allowedSampleRates = (!audioOnlyMode && formatSampleRates.length)
      ? allowedSampleRatesRaw.filter(v => formatSampleRates.includes(v))
      : allowedSampleRatesRaw;
    const allowedChannelOptions = (!audioOnlyMode && formatChannelOptions.length)
      ? allowedChannelOptionsRaw.filter(v => formatChannelOptions.includes(v))
      : allowedChannelOptionsRaw;

    if (sampleRate && allowedSampleRates.length && !allowedSampleRates.includes(sampleRate)) {
      return {
        ok: false,
        message: audioOnlyMode
          ? t(
            'transcodeSampleRateNotCompatibleAudioWrapper',
            '❌ Sample rate "{{sampleRate}}" is not compatible with audio wrapper "{{wrapper}}".',
            { sampleRate, wrapper: audioWrapper }
          )
          : t(
            'transcodeSampleRateNotCompatible',
            '❌ Sample rate "{{sampleRate}}" is not compatible with codec "{{codec}}" for this format.',
            { sampleRate, codec }
          ),
        log: true,
        status: 'invalid_sample_rate'
      };
    }

    const defaultChannels = new Set(['mono', 'stereo', '5.1', '7.1', 'preserve']);
    let channels = (cfg.channels || '').trim();
    if (!channels) {
      channels = 'preserve';
      cfg.channels = 'preserve';
    }
    // P0: "preserve" is a control flag ("do not set -ac"), not a codec capability.
    // It must never be rejected by allowlists.
    if (channels !== 'preserve' && allowedChannelOptions.length) {
      if (!allowedChannelOptions.includes(channels)) {
        return {
          ok: false,
          message: audioOnlyMode
            ? t(
              'transcodeChannelsNotCompatibleAudioWrapper',
              '❌ Channels "{{channels}}" are not compatible with audio wrapper "{{wrapper}}".',
              { channels, wrapper: audioWrapper }
            )
            : t(
              'transcodeChannelsNotCompatible',
              '❌ Channels "{{channels}}" are not compatible with codec "{{codec}}" for this format.',
              { channels, codec }
            ),
          log: true,
          status: 'invalid_channels'
        };
      }
    } else if (!defaultChannels.has(channels)) {
      return {
        ok: false,
        message: t(
          'transcodeInvalidChannelSelection',
          '❌ Invalid channel selection "{{channels}}". Choose mono, stereo, 5.1, 7.1, or preserve.',
          { channels }
        ),
        log: true,
        statusText: t('transcodeStatusInvalidChannelSelection', '🛑 Invalid channel selection')
      };
    }
  }

  if (!audioOnlyMode) {
    const fmtLi = el.outputFormat.closest('.dropdown-wrapper')?.querySelector('.value-list li.selected');
    if (fmtLi?.dataset.locked && !(await window.license?.isFeatureEnabled?.(format))) {
      return { ok: false, message: t('transcodeFormatRestricted', '❌ Format "{{format}}" is restricted.', { format }), log: true };
    }
    const resLi = el.resolution.closest('.dropdown-wrapper')?.querySelector('.value-list li.selected');
    if (resLi?.dataset.locked && !(await window.license?.isFeatureEnabled?.(resolution))) {
      return { ok: false, message: t('transcodeResolutionRestricted', '❌ Resolution "{{resolution}}" is restricted.', { resolution }), log: true };
    }
    const pixLi = el.pixelFormat.closest('.dropdown-wrapper')?.querySelector('.value-list li.selected');
    if (pixLi?.dataset.locked && !(await window.license?.isFeatureEnabled?.(pixelFmt))) {
      return { ok: false, message: t('transcodePixelFormatRestricted', '❌ Pixel format "{{pixelFormat}}" is restricted.', { pixelFormat: pixelFmt }), log: true };
    }
  }

  if (audioRelevant) {
    // Guard: sample rate licensing should only apply when audio is actually used (avoid seq regressions).
    const rateLi = el.sampleRate.closest('.dropdown-wrapper')?.querySelector('.value-list li.selected');
    if (rateLi?.dataset.locked && !(await window.license?.isFeatureEnabled?.(sampleRate))) {
      return { ok: false, message: t('transcodeSampleRateRestricted', '❌ Sample rate "{{sampleRate}}" is restricted.', { sampleRate }), log: true };
    }
  }

  const outputCollision = await findOutputPathCollision(cfg);
  if (outputCollision) {
    return {
      ok: false,
      message: t(
        'transcodeOutputPathCollision',
        '❌ Output path matches a source file. Choose a different output folder or enable suffixing.'
      )
    };
  }

  return { ok: true };
}

const WATCH_OUTPUT_RELATION_ERROR = 'Output folder cannot be the watch folder or inside it.';
const getWatchOutputRelationErrorText = () => t(
  'transcodeWatchOutputRelationError',
  WATCH_OUTPUT_RELATION_ERROR
);

function normalizePathForCompare(rawPath) {
  const input = String(rawPath ?? '').trim();
  if (!input) return '';
  let normalized = input.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.length > 1) normalized = normalized.replace(/\/$/, '');
  const fallbackPlatform = (
    window.electron?.platform ||
    window.platform ||
    window.APP_PLATFORM ||
    navigator?.userAgentData?.platform ||
    navigator?.platform
  );
  const platform = ipc?.platform ?? fallbackPlatform;
  const platformLabel = typeof platform === 'string' ? platform.toLowerCase() : '';
  const isWindows = platformLabel.startsWith('win') || platformLabel.includes('windows');
  if (isWindows) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function joinPathSafe(...parts) {
  if (typeof window.electron?.joinPath === 'function') {
    return window.electron.joinPath(...parts);
  }
  return parts
    .filter(p => p != null && String(p).length)
    .map((p, index) => {
      const normalized = String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
      return index === 0 ? normalized.replace(/\/+$/g, '') : normalized.replace(/^\/+|\/+$/g, '');
    })
    .join('/')
    .replace(/\/+/g, '/');
}

function getNormalizedOutputFolder(rawOutputFolder) {
  return String(rawOutputFolder || '').trim();
}

function buildOutputNameForCheck(inputPath, index, opts) {
  const { containerFormat, appendSeq = false, isBatch } = opts || {};
  const ext = window.electron?.extname?.(inputPath) || '';
  const rawBase = String(inputPath || '').split(/[\\/]/).pop() || '';
  const baseName = window.electron?.basename
    ? window.electron.basename(inputPath, ext)
    : (ext && rawBase.endsWith(ext) ? rawBase.slice(0, -ext.length) : rawBase);
  const safeName = baseName.replace(/[^\w\d_-]+/g, '_');
  const seq = String(index).padStart(3, '0');
  const useSeq = appendSeq || isBatch;
  const outExt = ['image_sequence', 'image2'].includes(containerFormat) ? '' : `.${containerFormat}`;
  return useSeq ? `${safeName}_${seq}${outExt}` : `${safeName}${outExt}`;
}

async function findOutputPathCollision(cfg) {
  if (!cfg) return null;
  const inputFiles = Array.isArray(cfg.inputFiles) ? cfg.inputFiles : [];
  if (!inputFiles.length) return null;
  const outputFolder = String(cfg.outputFolder || '').trim();
  if (!outputFolder) return null;

  const isBatch = inputFiles.length > 1;
  const appendSeq = !!cfg.appendSeq;
  const containerFormat = cfg.containerFormat;

  for (let index = 0; index < inputFiles.length; index += 1) {
    const inputPath = inputFiles[index];
    if (!inputPath) continue;
    const stat = await statPathAsync(inputPath);
    if (stat?.ok && stat.isDirectory) continue;
    const outName = buildOutputNameForCheck(inputPath, index, {
      containerFormat,
      appendSeq,
      isBatch
    });
    const outputPath = joinPathSafe(outputFolder, outName);
    if (normalizePathForCompare(outputPath) === normalizePathForCompare(inputPath)) {
      return { inputPath, outputPath };
    }
  }

  return null;
}

function getWatchInputCardinalityError(inputFiles) {
  const watchInputCount = Array.isArray(inputFiles) ? inputFiles.length : 0;
  if (watchInputCount === 1) return null;
  return t(
    'transcodeWatchRequiresExactlyOneInput',
    '❌ Watch Mode requires exactly one selected input folder. Select one folder to watch.'
  );
}

function getWatchOutputRelationError(watchFolder, outputFolder) {
  const normalizedWatch = normalizePathForCompare(watchFolder);
  const normalizedOutput = normalizePathForCompare(outputFolder);
  if (!normalizedWatch || !normalizedOutput) return null;
  const errorText = getWatchOutputRelationErrorText();
  if (normalizedOutput === normalizedWatch) return errorText;
  if (normalizedOutput.startsWith(`${normalizedWatch}/`)) return errorText;
  return null;
}

function isWatchConfigValid(cfg) {
  if (!cfg) return t('transcodeNoConfigFound', 'No transcode config found.');
  if (!cfg.watchFolder) return t('transcodeWatchFolderNotSet', 'Watch folder not set.');
  const missing = [];

  // Phase 1 guardrail: block sequence/container mismatches in watch mode too.
  if (!cfg.audioOnly) {
    const isSeqFormat = typeof cfg.outputFormat === 'string' && cfg.outputFormat.includes('sequence');
    const isSeqContainer = (cfg.containerFormat === 'image_sequence' || cfg.containerFormat === 'image2');
    if (isSeqFormat && !isSeqContainer) {
      return t(
        'transcodeWatchSeqFormatNeedsSeqContainer',
        'Output format is an image sequence, but container is not set to image_sequence.'
      );
    }
    if (isSeqContainer && !isSeqFormat) {
      return t(
        'transcodeWatchSeqContainerNeedsSeqFormat',
        'Container is set to image_sequence, but output format is not a sequence format.'
      );
    }
  }

  const isImageSeq = !cfg.audioOnly && (
    cfg.containerFormat === 'image_sequence' ||
    cfg.containerFormat === 'image2' ||
    (typeof cfg.outputFormat === 'string' && cfg.outputFormat.includes('sequence'))
  );

  if (!cfg.audioOnly && !cfg.containerFormat) missing.push(t('containerFormat', 'Container Format'));

  // Audio codec is required for audio-only watch jobs, and for video jobs that support audio.
  // Image sequence outputs (png/tiff/exr/tga sequences) do not carry audio.
  if (cfg.audioOnly) {
    if (!cfg.audioCodec) missing.push(t('transcodeAudioCodecPlaceholder', 'Audio Codec'));
  } else if (!isImageSeq) {
    if (!cfg.audioCodec) missing.push(t('transcodeAudioCodecPlaceholder', 'Audio Codec'));
  }

  if (!cfg.outputFolder) missing.push(t('transcodeOutputFolderLabel', 'Output folder'));
  if (!cfg.audioOnly) {
    if (!cfg.outputFormat) missing.push(t('outputFormat', 'Output Format'));
    if (!cfg.resolution) missing.push(t('resolution', 'Resolution'));
    if (!cfg.frameRate) missing.push(t('frameRate', 'Frame Rate'));
  }

  const watchOutputError = getWatchOutputRelationError(cfg.watchFolder, cfg.outputFolder);
  if (watchOutputError) return watchOutputError;

  return missing.length
    ? t('transcodeMissingFields', 'Missing: {{fields}}', { fields: missing.join(', ') })
    : true;
}

function resolveQualityReasonPayload(reason, status = 'skipped') {
  const reasonPayload = (reason && typeof reason === 'object') ? reason : null;
  const reasonKey = reasonPayload?.key || (typeof reason === 'string' ? reason : '');
  const reasonParams = (reasonPayload?.params && typeof reasonPayload.params === 'object') ? reasonPayload.params : {};

  const mappedKeys = {
    transcodeQualityReasonNotRequested: 'not requested',
    transcodeQualityReasonInsufficientDiskSpace: 'insufficient disk space',
    transcodeQualityReasonTranscodeFailed: 'transcode failed',
    transcodeQualityReasonImageSequenceOutput: 'image sequence output',
    transcodeQualityReasonEncodeFailed: 'encode failed',
    transcodeQualityReasonAudioOnlyOutput: 'audio-only output',
    transcodeQualityReasonCaptionEmbedVerification: 'caption embed verification',
    transcodeQualityReasonFfprobeTimedOut: 'ffprobe timed out',
    transcodeQualityReasonMetadataVerificationFailed: 'metadata verification failed',
    transcodeQualityReasonMetadataVerificationOnly: 'metadata verification only',
    transcodeQualityReasonOutputMissing: 'output missing',
    transcodeQualityReasonMissingRequiredParameters: 'missing required parameters',
    transcodeQualityReasonInputOutputNotFound: 'input or output file not found',
    transcodeQualityReasonNoMetricsProduced: 'no metrics produced',
    transcodeQualityReasonFfmpegTimeout: 'ffmpeg timeout',
    transcodeQualityReasonQcError: '{{message}}',
    transcodeQualityReasonVerificationError: '{{message}}',
    transcodeQualityReasonUnknown: 'no reason provided'
  };

  if (reasonKey && mappedKeys[reasonKey]) {
    return i18nMsg(reasonKey, mappedKeys[reasonKey], reasonParams);
  }

  const fallbackKey = status === 'error' ? 'transcodeQualityReasonVerificationError' : 'transcodeQualityReasonUnknown';
  const fallbackParams = reasonKey
    ? { message: reasonKey }
    : (Object.keys(reasonParams).length ? reasonParams : {});
  return i18nMsg(
    fallbackKey,
    fallbackKey === 'transcodeQualityReasonVerificationError' ? '{{message}}' : 'no reason provided',
    fallbackParams
  );
}

function formatQualityMessage(quality, verified) {
  if (!quality || !quality.status) return '';
  const reason = resolveQualityReasonPayload(quality.reason, quality.status);
  if (quality.status === 'ok') {
    const hasSsim = typeof quality.ssim === 'number' && Number.isFinite(quality.ssim);
    const hasPsnr = typeof quality.psnr === 'number' && Number.isFinite(quality.psnr);
    const ssimText = hasSsim
      ? quality.ssim.toFixed(4)
      : i18nMsg('notAvailable', 'N/A');
    const psnrText = hasPsnr
      ? i18nMsg('transcodePsnrDb', '{{value}} dB', { value: quality.psnr.toFixed(2) })
      : i18nMsg('notAvailable', 'N/A');
    const prefix = verified === false ? '⚠️' : '🧪';
    return i18nMsg(
      'transcodeQualityOk',
      '{{prefix}} Quality: SSIM {{ssim}} | PSNR {{psnr}}',
      { prefix, ssim: ssimText, psnr: psnrText }
    );
  }
  if (quality.status === 'skipped') {
    return i18nMsg('transcodeQualitySkipped', '🧪 Quality: skipped ({{reason}})', { reason });
  }
  if (quality.status === 'error') {
    return i18nMsg('transcodeQualityError', '🧪 Quality: error ({{reason}})', { reason });
  }
  return '';
}

if (window.watchValidators) {
  window.watchValidators.transcode = isWatchConfigValid;
}

const startBtn = el.startBtn;
const cancelBtn = el.cancelBtn;
const inputBtn = el.selectInputFiles;

// Watch Mode UI (match Ingest-style path row)
const transcodeInputRow = document.querySelector('#transcode .transcode-input-row');
const transcodeFileInfoScroll = document.getElementById('transcode-file-info')?.closest?.('.file-info-scroll') || null;
const syncTranscodeWatchFolderPath = () => {
  if (!el.watchFolderPath) return;
  const list = readInputFileList(el.inputFiles);
  el.watchFolderPath.value = String((list && list[0]) || '');
};
const setTranscodeWatchUiState = isWatch => {
  try {
    if (transcodeInputRow) {
      transcodeInputRow.classList.toggle('watch-mode', !!isWatch);
    }

    // Swap between textarea (file list) and single-line watch folder display.
    if (el.inputFiles) {
      el.inputFiles.classList.toggle('hidden', !!isWatch);
      if (!isWatch) {
        // Coming back from watch mode: ensure the textarea has a sane height again.
        try { autoResize(el.inputFiles); } catch {}
      }
    }
    if (el.watchFolderPath) {
      el.watchFolderPath.classList.toggle('hidden', !isWatch);
      if (isWatch) syncTranscodeWatchFolderPath();
      else el.watchFolderPath.value = '';
    }

    // Hide the file-info grid entirely in Watch Mode.
    if (transcodeFileInfoScroll) {
      transcodeFileInfoScroll.classList.toggle('hidden', !!isWatch);
    }
  } catch {}
};

// Keep Transcode button labels + input UI in sync with the Watch Mode checkbox state.
// (This intentionally does not rely solely on watch-utils so the UI stays consistent.)
const applyTranscodeWatchButtonState = isWatch => {
  try {
    if (inputBtn) {
      setButtonLabel(
        inputBtn,
        isWatch
          ? t('transcodeSelectWatchFolder', 'Select Watch Folder')
          : t('selectInputFiles', 'Select Source')
      );
    }
    if (startBtn) {
      setButtonLabel(
        startBtn,
        isWatch ? t('transcodeStartWatching', 'Start Watching') : t('startTranscode', 'Start')
      );
    }
    if (cancelBtn) {
      setButtonLabel(
        cancelBtn,
        isWatch ? t('transcodeStopWatching', 'Stop Watching') : t('cancelTranscode', 'Cancel')
      );
    }
    setTranscodeWatchUiState(isWatch);
  } catch {}
};

// Backup listener in case watch-utils isn't the only thing managing checkbox changes.
el.watchMode?.addEventListener('change', () => {
  applyTranscodeWatchButtonState(!!el.watchMode?.checked);
});
applyTranscodeWatchButtonState(!!el.watchMode?.checked);

const clearInputSelection = () => {
  if (!el.inputFiles) return;
  el.inputFiles.value = '';
  el.inputFiles.dataset.fileList = '[]';
  autoResize(el.inputFiles);
  if (el.watchFolderPath) el.watchFolderPath.value = '';
  resetFileInfoGrid('transcode', 'gridCols-transcode');
  transcodePanelState.fileInfoRows = [];
  transcodePanelState.fileInfoSource = 'none';
  resetFolderSelectionCache();
  if (el.audioOnly) {
    const wasAutoAudio = el.audioOnly.dataset.auto === '1';
    el.audioOnly.dataset.auto = '0';
    el.audioOnly.disabled = false;
    if (wasAutoAudio && el.audioOnly.checked) {
      el.audioOnly.checked = false;
      toggleAudioOnlyMode().catch(() => {});
    }
  }
  updateAudioSectionDisabledState();
  updateSummary(el);
  updateTranscodeJobPreview();
};
const updateStartButtonForWatchState = async isWatch => {
  if (!startBtn) return;
  const status = document.getElementById('transcode-job-status');

  // Non-watch mode: keep Start enabled when no job is active.
  if (!isWatch) {
    if (!status?.dataset?.jobActive) startBtn.disabled = false;
    return;
  }

  // Watch mode: Start is only enabled once we have a valid folder watch input + a valid output folder.
  const watchInput = readInputFileList()[0];
  const watchInputStatus = await getDirectoryStatusForPath(watchInput, { bypassCache: true });
  if (!watchInputStatus.ok || !watchInputStatus.isDirectory) {
    startBtn.disabled = true;
    return;
  }
  const watchOutput = (el.outputPath?.value || '').trim();
  if (!watchOutput) {
    startBtn.disabled = true;
    return;
  }
  const outputStatus = await getDirectoryStatusForPath(watchOutput);
  if (!outputStatus.ok || !outputStatus.isDirectory) {
    startBtn.disabled = true;
    return;
  }
  const watchOutputError = getWatchOutputRelationError(watchInput, watchOutput);
  if (watchOutputError) {
    startBtn.disabled = true;
    return;
  }
  if (!status?.dataset?.jobActive) startBtn.disabled = false;
};
const updateMatchSourceFromSelection = async () => {
  const files = readInputFileList();
  if (files.length !== 1) {
    setMatchSourceState(true);
    return false;
  }
  const isFolder = await isFolderInputSelected();
  setMatchSourceState(isFolder);
  return !isFolder;
};
const initWatchToggle = () => {
  const cb = el.watchMode;
  if (cb?.dataset?.watchInit === '1') return true;
  const wu = getWatchUtils();
  if (typeof wu?.initWatchToggle !== 'function') return false;
  try {
    wu.initWatchToggle({
      checkboxId: 'transcode-watch-mode',
      startBtnId: startBtn?.id || 'startTranscode',
      cancelBtnId: cancelBtn?.id || 'cancelTranscode',
      panel: 'transcode',
      onToggle: async isWatch => {
        if (isWatch) {
          setMatchSourceState(true);
          if (!await isFolderInputSelected()) {
            clearInputSelection();
            showError(t('transcodeWatchSelectFolderWarning', '⚠️ Select a watch folder.'));
          }
        } else {
          if (await isFolderInputSelected()) {
            clearInputSelection();
            showError(t(
              'transcodeWatchRequiresFoldersWarning',
              '⚠️ Watch Mode requires folders; please select files.'
            ));
          }
          await updateMatchSourceFromSelection();
        }
        await updateStartButtonForWatchState(isWatch);
        // After validation + any selection changes, ensure UI is aligned with watch state.
        applyTranscodeWatchButtonState(!!isWatch);
      }
    });
    if (cb) {
      cb.dataset.watchInit = '1';
      cb.disabled = false;
      cb.title = '';
    }
    if (el.watchProcessExisting) {
      el.watchProcessExisting.disabled = false;
    }
    return true;
  } catch (e) {
    panelLog('warn', 'initWatchToggle failed (transcode):', { error: e?.message || e });
    return false;
  }
};

if (!initWatchToggle() && el.watchMode) {
  const cb = el.watchMode;
  cb.checked = false;
  cb.disabled = true;
  cb.title = t(
    'transcodeWatchUnavailable',
    'Watch Mode unavailable (watch module not loaded).'
  );
  if (el.watchProcessExisting) {
    el.watchProcessExisting.disabled = true;
  }
  // Keep UI labels in their non-watch state.
  setButtonLabel(el.startBtn, t('startTranscode', 'Start'));
  setButtonLabel(el.cancelBtn, t('cancelTranscode', 'Cancel'));
  if (!cb.dataset.watchWarned) {
    cb.dataset.watchWarned = '1';
    logTranscode(i18nMsg(
      'transcodeWatchUnavailableWarning',
      '⚠️ Watch Mode is unavailable (watch module not loaded).'
    ));
  }
  if (!cb.dataset.watchAwaiting) {
    cb.dataset.watchAwaiting = '1';
    window.addEventListener('watch-utils-ready', () => {
      cb.disabled = false;
      const ok = initWatchToggle();
      if (!ok) {
        cb.disabled = true;
        cb.checked = false;
        cb.title = t(
          'transcodeWatchUnavailable',
          'Watch Mode unavailable (watch module not loaded).'
        );
        if (el.watchProcessExisting) {
          el.watchProcessExisting.disabled = true;
        }
      } else if (el.watchProcessExisting) {
        el.watchProcessExisting.disabled = false;
      }
    }, { once: true });
  }
}

async function initOutputFormatDropdown() {
  // IMPORTANT: We must not show formats that are unsupported by the currently bundled FFmpeg.
  // Selling an app with FFmpeg often requires a 'legal' build that omits certain codecs/encoders.
  // We therefore query the runtime-supported formats and fail closed if detection fails.
  let formats = [];
  let usedFallback = false;
  try {
    formats = await window.codex?.listFormats?.();
  } catch (err) {
    usedFallback = true;
    panelLog('warn', 'Codex listFormats failed; using fallback output formats.', {
      error: err?.message || err
    });
    logTranscode(i18nMsg(
      'transcodeWarnFormatsFallback',
      '⚠️ Unable to load output formats from Codex. Using a conservative fallback list.'
    ));
  }

  // Keep the UI ordering stable, but **do not** hide formats that the bundled FFmpeg actually supports.
  // Codex (main process) already filters formats against runtime encoder availability. We should present
  // everything Codex reports as supported, not just a hard-coded subset.
  const formatLabelMap = {
    // ProRes family
    prores_422: t('transcodeFormatProres422', 'ProRes 422'),
    prores_422hq: t('transcodeFormatProres422Hq', 'ProRes 422 HQ'),
    prores_4444: t('transcodeFormatProres4444', 'ProRes 4444'),
    prores_4444xq: t('transcodeFormatProres4444Xq', 'ProRes 4444 XQ'),
    prores_lt: t('transcodeFormatProresLt', 'ProRes LT'),
    prores_proxy: t('transcodeFormatProresProxy', 'ProRes Proxy'),

    // Avid / broadcast / mastering
    dnxhd: t('transcodeFormatDnxhd', 'DNxHD / DNxHR'),
    xdcam_hd35: t('transcodeFormatXdcamHd35', 'XDCAM HD 35'),
    xdcam_hd50: t('transcodeFormatXdcamHd50', 'XDCAM HD 50'),
    xavc_l_1080p: t('transcodeFormatXavcL1080p', 'XAVC-L 1080p'),
    xavc_i_4k: t('transcodeFormatXavcI4k', 'XAVC-I 4K'),
    xavc_s: t('transcodeFormatXavcS', 'XAVC-S'),
    jpeg2000: t('transcodeFormatJpeg2000', 'JPEG 2000'),
    cfhd: t('transcodeFormatCfhd', 'CineForm (CFHD)'),
    speedhq: t('transcodeFormatSpeedHq', 'Avid SpeedHQ'),
    v210: t('transcodeFormatV210', 'v210 (10-bit 4:2:2 Uncompressed)'),

    // Delivery / web
    av1: t('transcodeFormatAv1', 'AV1'),
    h264: t('transcodeFormatH264', 'H.264'),
    h264_auto_gpu: t('transcodeFormatH264AutoGpu', 'H.264 (Auto GPU)'),
    h265: t('transcodeFormatH265', 'H.265 / HEVC'),
    vp9: t('transcodeFormatVp9', 'VP9'),

    // Archival / legacy / misc
    ffv1: t('transcodeFormatFfv1', 'FFV1'),
    mjpeg: t('transcodeFormatMjpeg', 'MJPEG'),
    qtrle: t('transcodeFormatQtrle', 'QTRLE (Animation)'),
    uncompressed_rgb: t('transcodeFormatUncompressedRgb', 'Uncompressed RGB'),
    uncompressed_yuv: t('transcodeFormatUncompressedYuv', 'Uncompressed YUV'),

    // Image sequences
    exr_sequence: t('transcodeFormatExrSequence', 'EXR Sequence'),
    image_sequence: t('transcodeFormatImageSequence', 'Image Sequence'),
    png_sequence: t('transcodeFormatPngSequence', 'PNG Sequence'),
    tga_sequence: t('transcodeFormatTgaSequence', 'TGA Sequence'),
    tiff_sequence: t('transcodeFormatTiffSequence', 'TIFF Sequence')
  };

  const preferredOrder = [
    // ProRes
    'prores_422',
    'prores_422hq',
    'prores_4444',
    'prores_4444xq',
    'prores_lt',
    'prores_proxy',

    // Avid / broadcast / mastering
    'dnxhd',
    'xdcam_hd35',
    'xdcam_hd50',
    'xavc_l_1080p',
    'xavc_i_4k',
    'xavc_s',
    'jpeg2000',
    'cfhd',
    'speedhq',
    'v210',

    // Delivery / web
    'h264',
    'h264_auto_gpu',
    'h265',
    'vp9',
    'av1',

    // Archival / misc
    'ffv1',
    'mjpeg',
    'qtrle',
    'uncompressed_rgb',
    'uncompressed_yuv',

    // Image sequences
    'exr_sequence',
    'image_sequence',
    'png_sequence',
    'tga_sequence',
    'tiff_sequence'
  ];

  const labelForFormat = (key) => {
    const k = String(key || '').trim();
    if (!k) return '';
    if (isDnxVariantFormat(k)) {
      const dnxLabel = getDnxVariantLabel(k);
      if (dnxLabel) return dnxLabel;
    }
    if (formatLabelMap[k]) return formatLabelMap[k];

    // Generic prettifier for any additional formats added to codex_format_spec.json.
    const tokens = k.split('_').filter(Boolean);
    const pretty = tokens.map((tok) => {
      const lower = tok.toLowerCase();
      if (['h264', 'h265', 'hevc', 'av1', 'vp9', 'mxf', 'mov', 'mp4', 'mkv', 'rgb', 'yuv'].includes(lower)) {
        return tok.toUpperCase();
      }
      if (/^\d+p$/.test(lower)) return tok; // e.g. 1080p
      if (/^\d+k$/.test(lower)) return tok.toUpperCase(); // e.g. 4k
      if (/^hd\d+$/i.test(tok)) return tok.toUpperCase(); // e.g. hd35/hd50
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    }).join(' ');
    return pretty;
  };

  const fallbackFormatValues = ['h264', 'h265', 'prores_422', 'prores_422hq'];

  // Preferred: formats reported by Codex (which should already be constrained by the
  // bundled FFmpeg build). If that list is empty, probe each known UI format against
  // the runtime encoder set via codex:get-format-capabilities.
  const supported = new Set(Array.isArray(formats) ? formats.filter(Boolean) : []);
  const hasAnySupported = preferredOrder.some((value) => supported.has(value));
  if (!usedFallback && !hasAnySupported && typeof window.codex?.getFormatCapabilities === 'function') {
    try {
      const results = await Promise.all(
        preferredOrder.map(async (value) => {
          try {
            const caps = await window.codex.getFormatCapabilities(value);
            return caps?.encoderAvailable ? value : null;
          } catch {
            return null;
          }
        })
      );
      results.filter(Boolean).forEach(v => supported.add(v));
      if (supported.size > 0) {
        panelLog('warn', 'Codex listFormats returned empty; using getFormatCapabilities probe.', {
          count: supported.size
        });
      }
    } catch (err) {
      // If the probe itself fails, fall back to a conservative list.
      usedFallback = true;
      panelLog('warn', 'Codex getFormatCapabilities probe failed; using fallback output formats.', {
        error: err?.message || err
      });
      logTranscode(i18nMsg(
        'transcodeWarnFormatsFallback',
        '⚠️ Unable to load output formats from Codex. Using a conservative fallback list.'
      ));
    }
  }

  let formatOpts = [];
  if (usedFallback) {
    formatOpts = fallbackFormatValues
      .map((value) => ({ value, label: labelForFormat(value) }))
      .filter((opt) => opt.value);
  } else {
    const preferredSet = new Set(preferredOrder);
    for (const value of preferredOrder) {
      if (supported.has(value)) {
        formatOpts.push({ value, label: labelForFormat(value) });
      }
    }
    const remaining = Array.from(supported)
      .filter((value) => !preferredSet.has(value))
      .sort((a, b) => String(a).localeCompare(String(b)));
    for (const value of remaining) {
      formatOpts.push({ value, label: labelForFormat(value) });
    }
  }

  // Belt-and-suspenders: verify encoder availability per format.
  // In practice, Codex listFormats can drift toward being "spec-defined" rather than "FFmpeg-build-defined".
  // We therefore filter formats against runtime encoder availability when possible.
  if (formatOpts.length) {
    try {
      const inv = window.electron?.invoke || window.ipc?.invoke || ipc?.invoke;

      // Build a quick lookup set of available *video* encoders from the bundled FFmpeg.
      let videoEncoders = null;
      if (typeof inv === 'function') {
        try {
          const caps = await inv('ffmpeg:get-capabilities');
          const encs = Array.isArray(caps?.encoders) ? caps.encoders : [];
          const names = encs
            .filter(e => e && e.type === 'video' && typeof e.name === 'string')
            .map(e => e.name.trim())
            .filter(Boolean)
            .map(n => n.toLowerCase());
          if (names.length) videoEncoders = new Set(names);
        } catch {}
      }

      const hasAny = (set, names) => {
        if (!set) return false;
        for (const n of (names || [])) {
          if (set.has(String(n).toLowerCase())) return true;
        }
        return false;
      };
      const hasPrefix = (set, prefix) => {
        if (!set) return false;
        const p = String(prefix || '').toLowerCase();
        if (!p) return false;
        for (const n of set) {
          if (String(n).startsWith(p)) return true;
        }
        return false;
      };

      const fallbackEncoderAvailableForFormat = (fmt) => {
        const f = String(fmt || '').trim().toLowerCase();
        if (!f || !videoEncoders) return null;

        // Family/preset formats that map to real encoders.
        if (f.startsWith('prores_')) return hasAny(videoEncoders, ['prores_ks', 'prores_aw', 'prores']);
        if (f === 'dnxhd' || f.startsWith('dnxhd_') || f.startsWith('dnxhr_')) return hasAny(videoEncoders, ['dnxhd']);
        if (f === 'h264') return hasAny(videoEncoders, ['libx264']) || hasPrefix(videoEncoders, 'h264_') || hasPrefix(videoEncoders, 'avc_');
        if (f === 'h264_auto_gpu') return hasPrefix(videoEncoders, 'h264_') || hasPrefix(videoEncoders, 'avc_');
        if (f === 'h265') return hasAny(videoEncoders, ['libx265']) || hasPrefix(videoEncoders, 'hevc_') || hasPrefix(videoEncoders, 'h265_');
        if (f === 'vp9') return hasAny(videoEncoders, ['libvpx-vp9', 'vp9']);
        if (f === 'av1') return hasAny(videoEncoders, ['libaom-av1', 'libsvtav1', 'av1']);
        if (f.startsWith('xdcam')) return hasAny(videoEncoders, ['mpeg2video']);
        if (f.startsWith('xavc')) return hasAny(videoEncoders, ['libx264']) || hasPrefix(videoEncoders, 'h264_') || hasPrefix(videoEncoders, 'avc_');
        if (f === 'jpeg2000') return hasAny(videoEncoders, ['jpeg2000', 'libopenjpeg']);
        if (f === 'uncompressed_rgb' || f === 'uncompressed_yuv') return hasAny(videoEncoders, ['rawvideo']);
        if (f.endsWith('_sequence')) {
          const codecMap = {
            png_sequence: 'png',
            tiff_sequence: 'tiff',
            exr_sequence: 'exr',
            dpx_sequence: 'dpx',
            tga_sequence: 'targa',
            image_sequence: 'png'
          };
          const enc = codecMap[f] || 'png';
          return hasAny(videoEncoders, [enc]);
        }

        // Direct encoder-name formats (utvideo, ffv1, mjpeg, qtrle, v210, cfhd, speedhq, etc.).
        if (videoEncoders.has(f)) return true;

        return null;
      };

      const canQueryCaps = (typeof window.codex?.getFormatCapabilities === 'function');

      const checks = await Promise.all(formatOpts.map(async (opt) => {
        const value = String(opt?.value || '').trim();
        if (!value) return false;

        if (canQueryCaps) {
          try {
            const caps = await window.codex.getFormatCapabilities(value);
            if (caps && typeof caps.encoderAvailable === 'boolean') {
              return !!caps.encoderAvailable;
            }
          } catch {}
        }

        const fb = fallbackEncoderAvailableForFormat(value);
        if (typeof fb === 'boolean') return fb;

        // No signal: keep (so we don't accidentally hide everything on older builds),
        // but this means the Codex handler should be improved.
        return true;
      }));

      const before = formatOpts.length;
      const filtered = formatOpts.filter((_, i) => checks[i]);
      const removedCount = before - filtered.length;
      if (removedCount > 0) {
        panelLog('warn', 'Filtered unsupported output formats based on encoder availability.', { removedCount });
      }
      formatOpts = filtered;
    } catch (err) {
      panelLog('warn', 'Output format encoder-availability filtering failed; keeping Codex listFormats results.', {
        error: err?.message || err
      });
    }
  }

  // Last-resort: if detection produced nothing, prefer a conservative list rather than an empty UI.
  if (!formatOpts.length && !usedFallback) {
    const fallback = fallbackFormatValues
      .map((value) => ({ value, label: labelForFormat(value) }))
      .filter((opt) => opt.value);
    if (fallback.length) {
      formatOpts = fallback;
      usedFallback = true;
      logTranscode(i18nMsg(
        'transcodeWarnFormatsFallback',
        '⚠️ Unable to detect supported output formats. Using a conservative fallback list.'
      ));
    }
  }

  if (!formatOpts.length) {
    // Fail closed: no formats detected means we cannot safely offer anything.
    setupStyledDropdown('outputFormat', []);
    enforceLicenseLocks();
    setDropdownValue('outputFormat', '');
    logTranscode(i18nMsg(
      'transcodeErrorNoFormatsDetected',
      '❌ No supported output formats detected in this FFmpeg build. Check your bundled FFmpeg encoders (ffmpeg -encoders) and Codex handler filtering.'
    ));
    renderTranscodeOverviewTooltip();
    return;
  }

  setupStyledDropdown('outputFormat', formatOpts);
  enforceLicenseLocks();

  // If a previously-saved value is no longer supported (e.g. user upgraded to a more restrictive
  // FFmpeg build), clear it so we don't silently keep an invalid hidden value.
  const current = String(el.outputFormat?.value || '').trim();
  const currentIsValid = !current || formatOpts.some(o => o.value === current);

  if (current && !currentIsValid) {
    logTranscode(i18nMsg(
      'transcodeWarnCachedFormatUnsupported',
      '⚠️ Cached output format "{{format}}" is not supported by this FFmpeg build. Please choose a supported format.',
      { format: current }
    ));
  }

  // Keep blank if user hasn't picked yet; otherwise, keep current if valid.
  const nextVal = currentIsValid ? current : (formatOpts[0]?.value || '');
  setDropdownValue('outputFormat', nextVal);

  renderTranscodeOverviewTooltip();
}
initOutputFormatDropdown().catch((err) => {
  panelLog('warn', 'initOutputFormatDropdown failed (transcode):', { error: err?.message || err });
});

function initContainerFormats() {
  const containerOptions = [
    { value: 'mov', label: t('transcodeContainerQuicktime', 'Quicktime') },
    { value: 'mp4', label: t('transcodeContainerMpeg4', 'MPEG-4') },
    { value: 'mkv', label: t('transcodeContainerMatroska', 'Matroska (MKV)') },
    { value: 'mxf', label: t('transcodeContainerMxf', 'MXF') },
    { value: 'webm', label: t('transcodeContainerWebm', 'WebM') },
    { value: 'avi', label: t('transcodeContainerAvi', 'AVI') },
    { value: 'image_sequence', label: t('transcodeContainerImageSequence', 'Image Sequence') }
  ];

  setupStyledDropdown('containerFormat', containerOptions);
  setDropdownValue('containerFormat', el.containerFormat.value || '');
}

if (document.readyState !== 'loading') {
  initContainerFormats();
} else {
  document.addEventListener('DOMContentLoaded', initContainerFormats);
}

setupStyledDropdown('resolution', ['720x480', '1280x720', '1440x1080', '1920x1080', '2048x1080', '3840x2160', '4096x2160']);
setDropdownValue('resolution', el.resolution.value || '');
setupStyledDropdown('frameRate', ['23.976', '24', '25', '29.97', '29.97df', '30', '50', '59.94', '59.94df', '60']);
setDropdownValue('frameRate', el.frameRate.value || '');
function buildPixelFormatOptions() {
  const pixelFormatOptions = [
    { value: 'yuv420p',     label: t('transcodePixelFormatYuv420p', 'YUV 4:2:0 8‑bit') },
    { value: 'yuv422p',     label: t('transcodePixelFormatYuv422p', 'YUV 4:2:2 8‑bit') },
    { value: 'yuv444p',     label: t('transcodePixelFormatYuv444p', 'YUV 4:4:4 8‑bit') },

    // RGB / alpha / packed formats (needed for image sequences + some uncompressed outputs)
    { value: 'rgb24',       label: t('transcodePixelFormatRgb24', 'RGB 8‑bit (24bpp)') },
    { value: 'rgba',        label: t('transcodePixelFormatRgba', 'RGBA 8‑bit (32bpp, alpha)') },
    { value: 'rgb48le',     label: t('transcodePixelFormatRgb48le', 'RGB 16‑bit (48bpp)') },

    // Packed 10-bit 4:2:2 (uncompressed codecs like v210)
    { value: 'v210',        label: t('transcodePixelFormatV210', 'v210 (10‑bit 4:2:2 packed)') },
    { value: 'yuvj422p',    label: t('transcodePixelFormatYuvj422p', 'YUVJ 4:2:2 8‑bit (full range)') },
    { value: 'yuv422p10le', label: t('transcodePixelFormatYuv422p10le', 'YUV 4:2:2 10‑bit (LE)') },
    { value: 'yuv444p10le', label: t('transcodePixelFormatYuv444p10le', 'YUV 4:4:4 10‑bit') },
    { value: 'yuv420p10le', label: t('transcodePixelFormatYuv420p10le', 'YUV 4:2:0 10‑bit') }
  ];

  // Add additional pixel formats as needed, without duplicating options if the list already contains them.
  const ensurePixelFormat = (value, i18nKey, fallbackLabel) => {
    if (pixelFormatOptions.some(o => o && o.value === value)) return;
    pixelFormatOptions.push({ value, label: t(i18nKey, fallbackLabel) });
  };

  // Hardware encoders / post codecs
  ensurePixelFormat('nv12',         'transcodePixelFormatNv12',         'YUV 4:2:0 8‑bit (NV12)');
  ensurePixelFormat('p010le',       'transcodePixelFormatP010le',       'YUV 4:2:0 10‑bit (P010)');
  ensurePixelFormat('gbrp10le',     'transcodePixelFormatGbrp10le',     'GBR 4:4:4 10‑bit (planar)');
  ensurePixelFormat('yuva444p10le', 'transcodePixelFormatYuva444p10le', 'YUV 4:4:4 10‑bit + alpha');

  // Image sequences: TGA/Targa + EXR encoders have strict supported pix_fmts.
  ensurePixelFormat('bgr24',        'transcodePixelFormatBgr24',        'BGR 8‑bit (24bpp)');
  ensurePixelFormat('bgra',         'transcodePixelFormatBgra',         'BGRA 8‑bit (32bpp, alpha)');
  ensurePixelFormat('rgb555le',     'transcodePixelFormatRgb555le',     'RGB 5:5:5 (16‑bit)');
  ensurePixelFormat('gray',         'transcodePixelFormatGray',         'Grayscale 8‑bit');
  ensurePixelFormat('pal8',         'transcodePixelFormatPal8',         'Paletted 8‑bit');
  ensurePixelFormat('grayf32le',    'transcodePixelFormatGrayF32le',    'Grayscale 32‑bit float');
  ensurePixelFormat('gbrpf32le',    'transcodePixelFormatGbrpF32le',    'GBR 32‑bit float (planar)');
  ensurePixelFormat('gbrapf32le',   'transcodePixelFormatGbrapF32le',   'GBRA 32‑bit float (planar, alpha)');

  return pixelFormatOptions;
}

function initPixelFormatDropdown() {
  setupStyledDropdown('pixelFormat', buildPixelFormatOptions());
  setDropdownValue('pixelFormat', el.pixelFormat.value || '');
}

function initColorRangeDropdown() {
  setupStyledDropdown('colorRange', [
    { value: 'limited', label: t('transcodeColorRangeLimited', 'Limited (16–235)') },
    { value: 'full', label: t('transcodeColorRangeFull', 'Full (0–255)') }
  ]);
  setDropdownValue('colorRange', el.colorRange.value || '');
}

function initFieldOrderDropdown() {
  setupStyledDropdown('fieldOrder', [
    { value: 'progressive',     label: t('transcodeFieldOrderProgressive', 'Progressive') },
    { value: 'interlaced_tff',  label: t('transcodeFieldOrderUpperTff', 'Upper field first (TFF)') },
    { value: 'interlaced_bff',  label: t('transcodeFieldOrderLowerBff', 'Lower field first (BFF)') }
  ]);
  setDropdownValue('fieldOrder', el.fieldOrder.value || '');
}

initPixelFormatDropdown();
initColorRangeDropdown();
initFieldOrderDropdown();

// --- DNxHD / DNxHR profile selection ---------------------------------------
// The Codex output format key `dnxhd` covers both DNxHD and DNxHR via FFmpeg's `dnxhd` encoder.
// DNx is picky: profile + bitrate + pixel format must be coherent.
// We expose an explicit profile dropdown so the user isn't stuck with a vague "DNxHD / DNxHR" switch.

const _DNX_PROFILE_PIXEL_FORMAT = {
  // DNxHR quality levels
  dnxhr_lb: 'yuv422p',
  dnxhr_sq: 'yuv422p',
  dnxhr_hq: 'yuv422p',
  dnxhr_hqx: 'yuv422p10le',
  dnxhr_444: 'yuv444p10le',

  // DNxHD 10-bit variants (x)
  dnxhd_90x: 'yuv422p10le',
  dnxhd_110x: 'yuv422p10le',
  dnxhd_175x: 'yuv422p10le',
  dnxhd_185x: 'yuv422p10le',
  dnxhd_220x: 'yuv422p10le',
  dnxhd_365x: 'yuv422p10le',
  dnxhd_440x: 'yuv422p10le',
  dnxhd_350x: 'yuv444p10le'
};

let DNXHR_PROFILE_OPTIONS = [];

// DNxHD options vary by output resolution, frame rate, and scan type.
// This table is deliberately scoped to the output sizes and rates exposed in the UI.
// (If we later add more sizes/rates, extend this table.)
function buildDnxhdPresetTable() {
  return {
  // 1080 progressive
  '1920x1080p': {
    '23.976': [
      { value: 'dnxhd_175x', label: t('transcodeDnxhd175x', 'DNxHD 175x') },
      { value: 'dnxhd_175',  label: t('transcodeDnxhd175',  'DNxHD 175') },
      { value: 'dnxhd_115',  label: t('transcodeDnxhd115',  'DNxHD 115') },
      { value: 'dnxhd_36',   label: t('transcodeDnxhd36',   'DNxHD 36') }
    ],
    '25': [
      { value: 'dnxhd_185x', label: t('transcodeDnxhd185x', 'DNxHD 185x') },
      { value: 'dnxhd_185',  label: t('transcodeDnxhd185',  'DNxHD 185') },
      { value: 'dnxhd_120',  label: t('transcodeDnxhd120',  'DNxHD 120') },
      { value: 'dnxhd_36',   label: t('transcodeDnxhd36',   'DNxHD 36') }
    ],
    '29.97': [
      { value: 'dnxhd_220x', label: t('transcodeDnxhd220x', 'DNxHD 220x') },
      { value: 'dnxhd_220',  label: t('transcodeDnxhd220',  'DNxHD 220') },
      { value: 'dnxhd_145',  label: t('transcodeDnxhd145',  'DNxHD 145') },
      { value: 'dnxhd_100',  label: t('transcodeDnxhd100',  'DNxHD 100') },
      { value: 'dnxhd_45',   label: t('transcodeDnxhd45',   'DNxHD 45') }
    ],
    '50': [
      { value: 'dnxhd_365x', label: t('transcodeDnxhd365x', 'DNxHD 365x') },
      { value: 'dnxhd_365',  label: t('transcodeDnxhd365',  'DNxHD 365') },
      { value: 'dnxhd_240',  label: t('transcodeDnxhd240',  'DNxHD 240') },
      { value: 'dnxhd_75',   label: t('transcodeDnxhd75',   'DNxHD 75') }
    ],
    '59.94': [
      { value: 'dnxhd_440x', label: t('transcodeDnxhd440x', 'DNxHD 440x') },
      { value: 'dnxhd_440',  label: t('transcodeDnxhd440',  'DNxHD 440') },
      { value: 'dnxhd_290',  label: t('transcodeDnxhd290',  'DNxHD 290') },
      { value: 'dnxhd_90',   label: t('transcodeDnxhd90',   'DNxHD 90') }
    ]
  },

  // 1080 interlaced
  '1920x1080i': {
    '25': [
      { value: 'dnxhd_185x', label: t('transcodeDnxhd185x', 'DNxHD 185x') },
      { value: 'dnxhd_185',  label: t('transcodeDnxhd185',  'DNxHD 185') },
      { value: 'dnxhd_120',  label: t('transcodeDnxhd120',  'DNxHD 120') },
      { value: 'dnxhd_85',   label: t('transcodeDnxhd85',   'DNxHD 85') }
    ],
    '29.97': [
      { value: 'dnxhd_220x', label: t('transcodeDnxhd220x', 'DNxHD 220x') },
      { value: 'dnxhd_220',  label: t('transcodeDnxhd220',  'DNxHD 220') },
      { value: 'dnxhd_145',  label: t('transcodeDnxhd145',  'DNxHD 145') },
      { value: 'dnxhd_100',  label: t('transcodeDnxhd100',  'DNxHD 100') }
    ]
  },

  // 720 progressive
  '1280x720p': {
    '23.976': [
      { value: 'dnxhd_90x', label: t('transcodeDnxhd90x', 'DNxHD 90x') },
      { value: 'dnxhd_90',  label: t('transcodeDnxhd90',  'DNxHD 90') },
      { value: 'dnxhd_60',  label: t('transcodeDnxhd60',  'DNxHD 60') },
      { value: 'dnxhd_45',  label: t('transcodeDnxhd45',  'DNxHD 45') }
    ],
    '25': [
      { value: 'dnxhd_90x', label: t('transcodeDnxhd90x', 'DNxHD 90x') },
      { value: 'dnxhd_90',  label: t('transcodeDnxhd90',  'DNxHD 90') },
      { value: 'dnxhd_60',  label: t('transcodeDnxhd60',  'DNxHD 60') },
      { value: 'dnxhd_45',  label: t('transcodeDnxhd45',  'DNxHD 45') }
    ],
    '29.97': [
      { value: 'dnxhd_110x', label: t('transcodeDnxhd110x', 'DNxHD 110x') },
      { value: 'dnxhd_110',  label: t('transcodeDnxhd110',  'DNxHD 110') },
      { value: 'dnxhd_75',   label: t('transcodeDnxhd75',   'DNxHD 75') },
      { value: 'dnxhd_50',   label: t('transcodeDnxhd50',   'DNxHD 50') }
    ],
    '50': [
      { value: 'dnxhd_175x', label: t('transcodeDnxhd175x', 'DNxHD 175x') },
      { value: 'dnxhd_175',  label: t('transcodeDnxhd175',  'DNxHD 175') },
      { value: 'dnxhd_115',  label: t('transcodeDnxhd115',  'DNxHD 115') },
      { value: 'dnxhd_85',   label: t('transcodeDnxhd85',   'DNxHD 85') }
    ],
    '59.94': [
      { value: 'dnxhd_220x', label: t('transcodeDnxhd220x', 'DNxHD 220x') },
      { value: 'dnxhd_220',  label: t('transcodeDnxhd220',  'DNxHD 220') },
      { value: 'dnxhd_145',  label: t('transcodeDnxhd145',  'DNxHD 145') },
      { value: 'dnxhd_100',  label: t('transcodeDnxhd100',  'DNxHD 100') }
    ]
  }
};
}

let DNXHD_PRESET_TABLE = buildDnxhdPresetTable();

let DNX_VARIANT_LABELS = new Map();

function rebuildDnxLocalizedOptions() {
  DNXHR_PROFILE_OPTIONS = [
    { value: 'dnxhr_lb',  label: t('transcodeDnxhrLb',  'DNxHR LB') },
    { value: 'dnxhr_sq',  label: t('transcodeDnxhrSq',  'DNxHR SQ') },
    { value: 'dnxhr_hq',  label: t('transcodeDnxhrHq',  'DNxHR HQ') },
    { value: 'dnxhr_hqx', label: t('transcodeDnxhrHqx', 'DNxHR HQX') },
    { value: 'dnxhr_444', label: t('transcodeDnxhr444', 'DNxHR 444') }
  ];
  DNXHD_PRESET_TABLE = buildDnxhdPresetTable();

  const map = new Map();
  try {
    for (const o of (DNXHR_PROFILE_OPTIONS || [])) {
      if (o?.value) map.set(String(o.value), String(o.label || o.value));
    }
  } catch {}
  try {
    for (const tableKey of Object.keys(DNXHD_PRESET_TABLE || {})) {
      const frMap = DNXHD_PRESET_TABLE[tableKey] || {};
      for (const fpsKey of Object.keys(frMap)) {
        const arr = frMap[fpsKey] || [];
        for (const o of arr) {
          if (o?.value) map.set(String(o.value), String(o.label || o.value));
        }
      }
    }
  } catch {}
  DNX_VARIANT_LABELS = map;
}

rebuildDnxLocalizedOptions();

function isDnxVariantFormat(fmt) {
  const f = String(fmt || '').toLowerCase();
  return f.startsWith('dnxhr_') || f.startsWith('dnxhd_');
}

function getDnxVariantLabel(fmt) {
  const key = String(fmt || '');
  return DNX_VARIANT_LABELS.get(key) || '';
}

const fallbackAudioOnlyWrapperSpecs = Object.freeze({
  wav: {
    codecCandidates: ['pcm_s16le'],
    defaultCodec: 'pcm_s16le',
    sampleRates: ['44100', '48000', '96000'],
    channels: ['mono', 'stereo', '5.1', '7.1']
  },
  flac: {
    codecCandidates: ['flac'],
    defaultCodec: 'flac',
    sampleRates: ['44100', '48000', '96000'],
    channels: ['mono', 'stereo', '5.1', '7.1']
  },
  m4a: {
    codecCandidates: ['aac'],
    defaultCodec: 'aac',
    sampleRates: ['44100', '48000'],
    channels: ['mono', 'stereo', '5.1', '7.1'],
    defaultBitrate: '192'
  },
  ogg: {
    codecCandidates: ['libvorbis', 'vorbis'],
    defaultCodec: 'libvorbis',
    sampleRates: ['44100', '48000'],
    channels: ['mono', 'stereo'],
    defaultBitrate: '192'
  },
  opus: {
    codecCandidates: ['libopus', 'opus'],
    defaultCodec: 'libopus',
    sampleRates: ['48000'],
    channels: ['mono', 'stereo'],
    defaultBitrate: '128'
  }
});

let audioWrapperList = Object.keys(fallbackAudioOnlyWrapperSpecs);
let audioOnlyWrapperSpecCache = null;
let audioOnlyWrapperMetadataPromise = null;
let fallbackAudioOnlyWrapperSpecCache = null;
let cachedSampleRateOptions = ['44100', '48000', '96000'];

function normalizeAudioOnlyWrapperEntry(wrapper, raw) {
  const normalizedWrapper = String(wrapper || '').trim().toLowerCase();
  const entry = raw && typeof raw === 'object' ? raw : {};
  const codecCandidates = Array.from(new Set(
    (entry.codecCandidates || entry.audioCodecs || [])
      .map(v => String(v || '').trim().toLowerCase())
      .filter(Boolean)
  ));
  const defaultCodec = String(entry.defaultCodec || codecCandidates[0] || normalizedWrapper).trim().toLowerCase();
  const sampleRates = Array.from(new Set(
    (entry.sampleRates || [])
      .map(v => String(v || '').trim())
      .filter(Boolean)
  ));
  const channels = Array.from(new Set(
    (entry.channels || [])
      .map(v => String(v || '').trim())
      .filter(Boolean)
  ));
  const defaultBitrate = entry.defaultBitrate == null || entry.defaultBitrate === ''
    ? null
    : String(entry.defaultBitrate).trim();
  return {
    wrapper: normalizedWrapper,
    codecCandidates,
    defaultCodec,
    sampleRates,
    channels,
    defaultBitrate
  };
}

function getFallbackAudioOnlyWrapperSpecs() {
  if (!fallbackAudioOnlyWrapperSpecCache) {
    fallbackAudioOnlyWrapperSpecCache = Object.fromEntries(
      Object.entries(fallbackAudioOnlyWrapperSpecs).map(([wrapper, spec]) => [
        String(wrapper).trim().toLowerCase(),
        normalizeAudioOnlyWrapperEntry(wrapper, spec)
      ])
    );
  }
  return fallbackAudioOnlyWrapperSpecCache;
}

function mergeAudioOnlyWrapperSpecs(rawWrappers) {
  const overrides = rawWrappers && typeof rawWrappers === 'object' ? rawWrappers : {};
  const fallbackSpecs = getFallbackAudioOnlyWrapperSpecs();
  const merged = Object.fromEntries(
    Object.entries(fallbackSpecs).map(([wrapper, spec]) => [
      wrapper,
      { ...spec }
    ])
  );

  for (const wrapper of Object.keys(overrides)) {
    const normalizedWrapper = String(wrapper || '').trim().toLowerCase();
    const baseEntry = merged[normalizedWrapper] && typeof merged[normalizedWrapper] === 'object'
      ? merged[normalizedWrapper]
      : {};
    const overrideEntry = overrides[wrapper] && typeof overrides[wrapper] === 'object'
      ? overrides[wrapper]
      : {};
    merged[normalizedWrapper] = normalizeAudioOnlyWrapperEntry(normalizedWrapper, {
      ...baseEntry,
      ...overrideEntry
    });
  }

  return merged;
}

function buildSampleRateOptions(values) {
  const preferred = ['44100', '48000', '96000'];
  const normalized = Array.from(new Set((values || [])
    .map(v => String(v || '').trim())
    .filter(Boolean)));
  const preferredSet = new Set(preferred);
  const extra = normalized
    .filter(v => !preferredSet.has(v))
    .sort((a, b) => Number(a) - Number(b));
  const ordered = preferred.filter(v => normalized.includes(v)).concat(extra);
  return ordered.length ? ordered : preferred.slice();
}

function getAudioOnlyWrapperSpecsSync() {
  return audioOnlyWrapperSpecCache || getFallbackAudioOnlyWrapperSpecs();
}

async function ensureAudioOnlyWrapperMetadataLoaded() {
  if (audioOnlyWrapperSpecCache) return audioOnlyWrapperSpecCache;
  if (audioOnlyWrapperMetadataPromise) return audioOnlyWrapperMetadataPromise;

  audioOnlyWrapperMetadataPromise = (async () => {
    let spec = null;
    try {
      spec = await window.codex?.getSpec?.();
    } catch {
      spec = null;
    }

    const rawWrappers = spec?.audioOnlyWrappers && typeof spec.audioOnlyWrappers === 'object'
      ? spec.audioOnlyWrappers
      : fallbackAudioOnlyWrapperSpecs;
    const normalized = mergeAudioOnlyWrapperSpecs(rawWrappers);

    audioOnlyWrapperSpecCache = Object.keys(normalized).length ? normalized : getFallbackAudioOnlyWrapperSpecs();
    audioWrapperList = Object.keys(audioOnlyWrapperSpecCache);

    const codexAudioRates = spec?.audio && typeof spec.audio === 'object'
      ? Object.values(spec.audio).flatMap(entry => Array.isArray(entry?.sampleRates) ? entry.sampleRates : [])
      : [];
    const wrapperRates = Object.values(audioOnlyWrapperSpecCache)
      .flatMap(entry => Array.isArray(entry?.sampleRates) ? entry.sampleRates : []);
    cachedSampleRateOptions = buildSampleRateOptions([
      ...codexAudioRates,
      ...wrapperRates,
      '44100',
      '48000',
      '96000'
    ]);

    return audioOnlyWrapperSpecCache;
  })();

  try {
    return await audioOnlyWrapperMetadataPromise;
  } finally {
    audioOnlyWrapperMetadataPromise = null;
  }
}

function getAudioOnlyWrapperConstraintsSync(wrapper) {
  const normalizedWrapper = String(wrapper || '').trim().toLowerCase();
  const specs = getAudioOnlyWrapperSpecsSync();
  return specs[normalizedWrapper] || null;
}

async function getAudioOnlyWrapperConstraints(wrapper) {
  await ensureAudioOnlyWrapperMetadataLoaded();
  return getAudioOnlyWrapperConstraintsSync(wrapper);
}

function findAudioOnlyWrapperForCodec(codec) {
  const normalizedCodec = String(codec || '').trim().toLowerCase();
  if (!normalizedCodec) return '';
  const specs = getAudioOnlyWrapperSpecsSync();
  for (const wrapper of Object.keys(specs)) {
    const entry = specs[wrapper];
    if (!entry) continue;
    if (wrapper === normalizedCodec || entry.defaultCodec === normalizedCodec || entry.codecCandidates.includes(normalizedCodec)) {
      return wrapper;
    }
  }
  return '';
}

function resolveAudioOnlySettings(wrapper, audioBitrate) {
  const normalizedWrapper = String(wrapper || '').trim().toLowerCase();
  const entry = getAudioOnlyWrapperConstraintsSync(normalizedWrapper);
  const resolvedCodec = entry?.defaultCodec || normalizedWrapper;
  const resolvedBitrate = entry?.defaultBitrate
    ? (audioBitrate || entry.defaultBitrate || null)
    : null;
  return {
    wrapper: normalizedWrapper,
    audioCodec: resolvedCodec,
    audioBitrate: resolvedBitrate
  };
}
let cachedAudioCodecList = [];
async function initAudioCodecDropdown() {
  const fallbackAudioCodecs = ['aac', 'pcm_s16le', 'pcm_s24le', 'mp3', 'flac'];

  const listAudioEncodersFromFfmpeg = async () => {
    try {
      const inv = window.electron?.invoke || window.ipc?.invoke || ipc?.invoke;
      if (typeof inv !== 'function') return [];
      const caps = await inv('ffmpeg:get-capabilities');
      const encoders = Array.isArray(caps?.encoders) ? caps.encoders : [];
      return encoders
        .filter(e => (e?.type === 'audio') && typeof e?.name === 'string' && e.name.trim())
        .map(e => e.name.trim())
        .filter(name => name.toLowerCase() !== 'anull');
    } catch {
      return [];
    }
  };

  let codecs = [];
  let codexError = false;
  try {
    codecs = await window.codex?.listAudioCodecs?.();
  } catch (err) {
    codexError = true;
    panelLog('warn', 'Codex listAudioCodecs failed; using fallback audio codecs.', {
      error: err?.message || err
    });
  }
  const codexList = Array.isArray(codecs) ? codecs.filter(Boolean) : [];
  let resolvedCodecs = codexList;
  let usedFallback = false;
  let usedFfmpegList = false;

  if (!resolvedCodecs.length) {
    const ffmpegList = await listAudioEncodersFromFfmpeg();
    if (ffmpegList.length) {
      resolvedCodecs = ffmpegList;
      usedFfmpegList = true;
    } else {
      const compatibilityList = Object.keys(sampleRateCompatibility || {});
      resolvedCodecs = compatibilityList.length
        ? Array.from(new Set([...compatibilityList, ...fallbackAudioCodecs]))
        : fallbackAudioCodecs;
      usedFallback = true;
    }
  }

  cachedAudioCodecList = resolvedCodecs
    .filter(k => !String(k).startsWith('avid_'))
    .sort();

  if (usedFallback) {
    logTranscode(i18nMsg(
      'transcodeWarnAudioCodecMetadataUnavailable',
      '⚠️ Audio codec metadata unavailable from Codex. Using fallback list: {{list}}.',
      { list: fallbackAudioCodecs.join(', ') }
    ));
  } else if (usedFfmpegList) {
    logTranscode(i18nMsg(
      'transcodeWarnAudioCodecMetadataFromFfmpeg',
      '⚠️ Audio codec metadata unavailable from Codex. Using the bundled FFmpeg encoder list.'
    ));
  } else if (codexError) {
    logTranscode(i18nMsg(
      'transcodeWarnAudioCodecQueryFailed',
      '⚠️ Unable to load audio codec list from Codex. Using a conservative fallback list.'
    ));
  }

  setupStyledDropdown('audioCodec', cachedAudioCodecList);
  enforceLicenseLocks();
  setDropdownValue('audioCodec', el.audioCodec.value || '');
}
initAudioCodecDropdown().catch((err) => {
  panelLog('warn', 'initAudioCodecDropdown failed (transcode):', { error: err?.message || err });
});
function initChannelsDropdown() {
  setupStyledDropdown('channels', [
    { value: 'preserve', label: t('transcodeChannelPreserveOriginal', 'Preserve Original') },
    { value: 'mono', label: t('transcodeChannelMonoLabel', 'Mono') },
    { value: 'stereo', label: t('transcodeChannelStereoLabel', 'Stereo') },
    '5.1', '7.1'
  ]);
  setDropdownValue('channels', el.channels.value || 'preserve');
}
initChannelsDropdown();
async function initSampleRateDropdown() {
  await ensureAudioOnlyWrapperMetadataLoaded();
  setupStyledDropdown('sampleRate', cachedSampleRateOptions);
  setDropdownValue('sampleRate', el.sampleRate.value || '');
}
initSampleRateDropdown().catch((err) => {
  panelLog('warn', 'initSampleRateDropdown failed (transcode):', { error: err?.message || err });
});
function initAudioBitrateDropdown() {
  setupStyledDropdown('audioBitrate', [
    { value: '96', label: t('transcodeAudioBitrateLabel96', '96 kbps') },
    { value: '128', label: t('transcodeAudioBitrateLabel128', '128 kbps') },
    { value: '160', label: t('transcodeAudioBitrateLabel160', '160 kbps') },
    { value: '192', label: t('transcodeAudioBitrateLabel192', '192 kbps') },
    { value: '256', label: t('transcodeAudioBitrateLabel256', '256 kbps') },
    { value: '320', label: t('transcodeAudioBitrateLabel320', '320 kbps') },
    { value: '384', label: t('transcodeAudioBitrateLabel384', '384 kbps') },
    { value: '512', label: t('transcodeAudioBitrateLabel512', '512 kbps') },
    { value: '768', label: t('transcodeAudioBitrateLabel768', '768 kbps') }
  ]);
  setDropdownValue('audioBitrate', el.audioBitrate.value || '');
}
initAudioBitrateDropdown();

function initVerificationDropdown() {
  const hidden = document.getElementById('transcode-verification-method');
  if (!hidden || typeof window.setupStyledDropdown !== 'function') return;

  window.setupStyledDropdown('transcode-verification-method', [
    { value: 'metadata', label: t('transcodeVerificationDurationFrame', 'Duration / Frame') },
    { value: 'ssim_psnr', label: t('transcodeVerificationSsimPsnr', 'SSIM / PSNR') }
  ]);

  if (typeof window.setDropdownValue === 'function') {
    // Respect any preloaded value; default to 'metadata'
    window.setDropdownValue('transcode-verification-method', hidden.value || 'metadata');
  }
}

async function refreshTranscodeDynamicI18n() {
  const reinitDropdown = async (id, initializer) => {
    const hidden = document.getElementById(id);
    const previousValue = hidden?.value;
    await initializer();
    if (typeof window.setDropdownValue === 'function' && hidden) {
      window.setDropdownValue(id, previousValue || '');
    }
  };

  const dnxProfileIds = ['transcode-dnx-profile', 'transcode-dnx-profile-hidden', 'dnxProfile'];
  const dnxProfileValues = new Map();
  dnxProfileIds.forEach((id) => {
    const node = document.getElementById(id);
    if (node) dnxProfileValues.set(id, node.value);
  });

  rebuildDnxLocalizedOptions();

  await reinitDropdown('outputFormat', initOutputFormatDropdown);
  await reinitDropdown('containerFormat', initContainerFormats);
  await reinitDropdown('pixelFormat', initPixelFormatDropdown);
  await reinitDropdown('colorRange', initColorRangeDropdown);
  await reinitDropdown('fieldOrder', initFieldOrderDropdown);
  await reinitDropdown('channels', initChannelsDropdown);
  await reinitDropdown('audioBitrate', initAudioBitrateDropdown);
  await reinitDropdown('transcode-verification-method', initVerificationDropdown);
  await refreshPresetDropdown();

  if (typeof window.setDropdownValue === 'function') {
    dnxProfileValues.forEach((value, id) => {
      if (!document.getElementById(id)) return;
      window.setDropdownValue(id, value || '');
    });
  }

  refreshTranscodeDynamicTitles();
}

function rerenderTranscodeFileInfoRowsForI18n() {
  const rows = Array.isArray(transcodePanelState.fileInfoRows)
    ? transcodePanelState.fileInfoRows
    : [];
  if (!rows.length || transcodePanelState.fileInfoSource === 'watch') return;

  const grid = prepareFileInfoGrid('transcode');
  if (!grid) return;

  rows.forEach((rowState, index) => {
    if (!rowState || typeof rowState !== 'object') return;
    const { filePath, fileName, metadata, error, status } = rowState;
    if (!filePath) return;

    let cells = null;
    if (status === 'probing') {
      cells = [
        makeFileInfoCell(fileName || window.electron.basename(filePath)),
        makeFileInfoCell(t('transcodeProbingPlaceholder', '⏳ Probing…'), { gridColumn: 'span 5' })
      ];
    } else if (metadata) {
      cells = buildTranscodeFileInfoCells(filePath, metadata, fileName);
    } else if (error) {
      cells = buildTranscodeFileInfoErrorCells(filePath, error, fileName);
    }

    if (!cells) return;
    const row = appendFileInfoRow(grid, cells);
    if (row) {
      row.dataset.index = String(index);
    }
  });

  setupResizableGrid(grid, 'gridCols-transcode');
}

async function refreshMatchSourceStateForI18n() {
  if (!el?.matchSource) return;

  // Recompute current Match Source availability so translated tooltip text is
  // regenerated via setMatchSourceState(...)/t(...).
  await updateMatchSourceFromSelection();

  // Re-apply higher-priority lock state (caption attach / audio-only lock) so
  // this refresh cannot override lock-specific titles/disable reasons.
  setCaptionSidecarLockState();
}

function handleTranscodeI18nChange() {
  Promise.resolve()
    .then(() => refreshTranscodeDynamicI18n())
    .then(() => refreshPresetDropdown())
    .then(() => refreshMatchSourceStateForI18n())
    .then(() => {
      window.translatePage?.();
      applyTranscodeWatchButtonState(!!el.watchMode?.checked);
      refreshTranscodeDynamicTitles();
      rerenderTranscodeFileInfoRowsForI18n();

      const hasCaptionControls = !!(
        el?.captionSidecarPath ||
        el?.captionSidecarDisplay ||
        el?.captionSidecarButton ||
        el?.captionSidecarClear
      );
      if (hasCaptionControls) {
        setCaptionSidecarLockState();
      }

      // Recompute dynamic summary + preview strings on language updates so both
      // populated previews and localized placeholder text refresh immediately
      // across file, watch, and audio-only states.
      updateSummary(el);
      updateTranscodeJobPreview();
      renderTranscodeStatusLogFromModel();
    })
    .catch((err) => {
      panelLog('warn', 'transcode languageChanged refresh failed:', {
        error: err?.message || err
      });
    });
}

function attachTranscodeI18nListeners() {
  if (window.__LEADAE_TRANSCODE_I18N_BOUND__) return true;
  const i18n = window.i18n;
  if (!i18n?.on) return false;

  window.__LEADAE_TRANSCODE_I18N_BOUND__ = true;
  i18n.on('languageChanged', handleTranscodeI18nChange);
  i18n.on('initialized', handleTranscodeI18nChange);
  i18n.on('loaded', handleTranscodeI18nChange);

  if (i18n.isInitialized) {
    handleTranscodeI18nChange();
  }
  return true;
}

if (!attachTranscodeI18nListeners()) {
  let tries = 0;
  const maxTries = 50;
  const timer = setInterval(() => {
    tries += 1;
    if (attachTranscodeI18nListeners()) {
      clearInterval(timer);
      return;
    }
    if (tries >= maxTries) {
      clearInterval(timer);
    }
  }, 100);
}

// Panel scripts are lazy‑loaded after the main DOM in renderer.js.
// Run immediately if the DOM is already ready; otherwise fall back to DOMContentLoaded.
if (document.readyState !== 'loading') {
  initVerificationDropdown();
} else {
  document.addEventListener('DOMContentLoaded', initVerificationDropdown);
}

// ─── Transcode tooltips: panel overview + verification ──────────────────────

function renderTranscodeOverviewTooltip() {
  const transcodeOverviewTooltip = document.querySelector('#transcode #transcode-overview-tooltip');
  if (!transcodeOverviewTooltip) return;

  transcodeOverviewTooltip.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header" data-i18n="transcodeOverviewTooltipHeader"></div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle" data-i18n="transcodeOverviewTooltipCoreTitle"></span>
        <ul class="tooltip-list">
          <li data-i18n="transcodeOverviewTooltipCoreItem1"></li>
          <li data-i18n="transcodeOverviewTooltipCoreItem2"></li>
          <li data-i18n="transcodeOverviewTooltipCoreItem3"></li>
          <li data-i18n="transcodeOverviewTooltipCoreItem4"></li>
        </ul>
      </div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle" data-i18n="transcodeOverviewTooltipIOTitle"></span>
        <ul class="tooltip-list">
          <li data-i18n="transcodeOverviewTooltipIOItem1"></li>
          <li data-i18n="transcodeOverviewTooltipIOItem2"></li>
          <li data-i18n="transcodeOverviewTooltipIOItem3"></li>
        </ul>
      </div>

      <div class="tooltip-section">
        <span class="tooltip-subtitle" data-i18n="transcodeOverviewTooltipUnderHoodTitle"></span>
        <ul class="tooltip-list">
          <li data-i18n="transcodeOverviewTooltipUnderHoodItem1"></li>
          <li data-i18n="transcodeOverviewTooltipUnderHoodItem2"></li>
          <li data-i18n="transcodeOverviewTooltipUnderHoodItem3"></li>
        </ul>
      </div>
    </div>
  `;
  transcodeOverviewTooltip.dataset.bound = 'true';
  window.translatePage?.();
  applyTranscodeWatchButtonState(!!el.watchMode?.checked);
}

renderTranscodeOverviewTooltip();

const transcodeAudioTooltip = document.querySelector('#transcode #transcode-audio-tooltip');
if (transcodeAudioTooltip && !transcodeAudioTooltip.dataset.bound) {
  transcodeAudioTooltip.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header" data-i18n="transcodeAudioTooltipHeader"></div>

      <div class="tooltip-section">
        <ul class="tooltip-list">
          <li>
            <strong data-i18n="transcodeAudioTooltipGeneralTitle"></strong>
            <span aria-hidden="true"> – </span>
            <span data-i18n="transcodeAudioTooltipGeneralBody"></span>
          </li>
          <li>
            <strong data-i18n="transcodeAudioTooltipCaptionRulesTitle"></strong>
            <span aria-hidden="true"> – </span>
            <span data-i18n="transcodeAudioTooltipCaptionRulesBody"></span>
          </li>
          <li>
            <strong data-i18n="transcodeAudioTooltipSccMccTitle"></strong>
            <span aria-hidden="true"> – </span>
            <span data-i18n="transcodeAudioTooltipSccMccBody"></span>
          </li>
          <li>
            <strong data-i18n="transcodeAudioTooltipMxfTitle"></strong>
            <span aria-hidden="true"> – </span>
            <span data-i18n="transcodeAudioTooltipMxfBody"></span>
          </li>
        </ul>
      </div>
    </div>
  `;
  transcodeAudioTooltip.dataset.bound = 'true';
  window.translatePage?.();
  applyTranscodeWatchButtonState(!!el.watchMode?.checked);
}

const transcodeVerificationTooltip = document.querySelector('#transcode #transcode-verification-tooltip');
if (transcodeVerificationTooltip && !transcodeVerificationTooltip.dataset.bound) {
  transcodeVerificationTooltip.innerHTML = `
    <div class="tooltip-content">
      <div class="tooltip-header" data-i18n="transcodeVerificationTooltipHeader"></div>

      <div class="tooltip-section">
        <ul class="tooltip-list">
          <li>
            <strong data-i18n="transcodeVerificationTooltipMetadataTitle"></strong>
            <span aria-hidden="true"> – </span>
            <span data-i18n="transcodeVerificationTooltipMetadataBody"></span>
          </li>
          <li>
            <strong data-i18n="transcodeVerificationTooltipSsimTitle"></strong>
            <span aria-hidden="true"> – </span>
            <span data-i18n="transcodeVerificationTooltipSsimBody"></span>
          </li>
        </ul>
      </div>
    </div>
  `;
  transcodeVerificationTooltip.dataset.bound = 'true';
  window.translatePage?.();
  applyTranscodeWatchButtonState(!!el.watchMode?.checked);
}

if (window.DEBUG_UI) {
  panelLog('debug', 'Transcode panel initialized');
}

el.audioCodec?.addEventListener('change', async () => {
  // In Audio-only mode, the "Audio Codec" dropdown is repurposed as an audio wrapper selector
  // (mp3, wav, etc). Refilter wrapper-specific audio constraints immediately.
  if (isAudioOnlyActiveUI()) {
    await filterSampleRates('', el);
    await filterChannels('', el);
    updateSummary(el);
    return;
  }

  const codec = el.audioCodec.value;
  const constraints = await window.codex?.getAudioConstraints?.(codec);
  const allowed = Array.isArray(constraints?.containers) ? constraints.containers : [];
  const hasContainerConstraints = allowed.length > 0;
  if (hasContainerConstraints) {
    const list = el.containerFormat.closest('.dropdown-wrapper')?.querySelector('.value-list');
    if (list) {
      [...list.children].forEach(li => {
        const isRecommended = allowed.includes(li.dataset.value);
        li.style.display = isRecommended ? '' : 'none';
        li.style.color = '';
      });
    }

    if (el.containerFormat?.value && !allowed.includes(el.containerFormat.value)) {
      logTranscode(i18nMsg(
        'transcodeWarnAudioCodecContainerUnlisted',
        '⚠️ Container "{{container}}" is not listed for audio codec "{{codec}}". Attempting anyway.',
        { container: el.containerFormat.value, codec }
      ));
    }

    showTranscodeStatusText(i18nMsg(
      'transcodeAudioCodecSupportsContainers',
      '🎧 {{codec}} recommended containers: {{containers}}',
      { codec, containers: allowed.join(', ') }
    ));
  } else {
    logTranscode(i18nMsg(
      'transcodeWarnNoContainerConstraintsForAudioCodec',
      '⚠️ No container constraints available for audio codec "{{codec}}". Keeping container options visible.',
      { codec }
    ));
  }

  await filterSampleRates('', el);
  await filterChannels('', el);

  // Ensure summary/preview reflect any async constraint/fallback adjustments.
  updateSummary(el);
});

// 🟡 Show/hide compatibility warnings for containers
el.containerFormat?.addEventListener('change', async () => {
  showCompatibilityWarnings(el);
  const container = el.containerFormat.value;
  if (container === 'mov' && !el.audioCodec.value) {
    const list = el.audioCodec.closest('.dropdown-wrapper')?.querySelector('.value-list');
    const hasOption = codec => [...(list?.children || [])].some(li => li.dataset.value === codec && !li.dataset.locked);
    const defaultAudio = ['pcm_s16le', 'aac'].find(hasOption);
    if (defaultAudio) {
      setDropdownValue('audioCodec', defaultAudio);
    }
  }
  await filterAudioCodecs(el.outputFormat.value, el);
  await filterSampleRates('', el);
  await filterChannels('', el);
  updateAudioSectionDisabledState();

  // Ensure summary/preview reflect any async constraint/fallback adjustments.
  updateSummary(el);
});

// 🔵 Respond to changes in output format
el.outputFormat?.addEventListener('change', async () => {
  const format = el.outputFormat.value;
  const isFormatCurrent = () => el.outputFormat.value === format;
  showCompatibilityWarnings(el);
  const compat = __compatCache.get(format) || await window.codex?.getCompatibility?.(format);
  if (!isFormatCurrent()) return;
  if (compat && !__compatCache.has(format)) __compatCache.set(format, compat);

  await filterContainerOptions(format, format);
  if (!isFormatCurrent()) return;

  await filterResolutionOptions(format, el, format);
  if (!isFormatCurrent()) return;
  await filterFieldOrderOptions(format, el, format);
  if (!isFormatCurrent()) return;
  await filterFrameRateOptions(format, el, format);
  if (!isFormatCurrent()) return;
  await filterPixelFormats(format, el, format);
  if (!isFormatCurrent()) return;
  await filterColorRangeOptions(format, el, format);
  if (!isFormatCurrent()) return;
  await filterAudioCodecs(format, el, format);
  if (!isFormatCurrent()) return;
  await filterSampleRates(format, el, format);
  if (!isFormatCurrent()) return;
  await filterChannels(format, el, format);
  if (!isFormatCurrent()) return;

  // Pull normalized defaults from backend to avoid renderer drift
  try {
    const defaultsSource = compat || await window.codex?.getCompatibility?.(format);
    if (!isFormatCurrent()) return;
    const d = defaultsSource?.defaults || {};
    if (d.container) setDropdownValue('containerFormat', d.container);
    if (d.resolution) setDropdownValue('resolution', d.resolution);
    if (d.frameRate) setDropdownValue('frameRate', d.frameRate);
    const bestPixelFormat = choosePreferredPixelFormat(compat?.pixelFormats || [], d.pixelFormat);
    if (bestPixelFormat) {
      setDropdownValue('pixelFormat', bestPixelFormat);
    }
    if (d.colorRange) setDropdownValue('colorRange', String(d.colorRange).trim().toLowerCase());
    if (d.fieldOrder) setDropdownValue('fieldOrder', d.fieldOrder);
    if (d.audio) setDropdownValue('audioCodec', d.audio);
    if (d.channels) setDropdownValue('channels', d.channels);
    if (d.sampleRate) setDropdownValue('sampleRate', d.sampleRate);
    if (d.audioBitrate && el.audioBitrate) setDropdownValue('audioBitrate', d.audioBitrate);
  } catch {}

  // DNx has additional profile/bitrate requirements; keep the profile control in sync after defaults.

  // 🎯 Enforce valid audio codec when format changes
  const allowedAudio = compat?.audioCodecs || audioCodecCompatibility[format];
  if (allowedAudio && allowedAudio.length) {
    const current = el.audioCodec.value;
    if (!allowedAudio.includes(current)) {
      setDropdownValue('audioCodec', allowedAudio[0]);
    }
  }

  // 🎯 Enforce valid sample rate
  const audioCodec = el.audioCodec.value;
  const codecConstraints = await window.codex?.getAudioConstraints?.(audioCodec);
  if (!isFormatCurrent()) return;
  const allowedRates = codecConstraints?.sampleRates || sampleRateCompatibility[audioCodec];
  if (allowedRates && allowedRates.length) {
    const currentRate = el.sampleRate.value;
    if (!allowedRates.includes(currentRate)) {
      setDropdownValue('sampleRate', allowedRates[0]);
    }
  }

  // 🎯 Enforce valid channels
  const allowedChans = codecConstraints?.channels || channelCompatibility[audioCodec];
  if (allowedChans && allowedChans.length) {
    const currentChans = el.channels.value;
    if (!allowedChans.includes(currentChans)) {
      setDropdownValue('channels', allowedChans[0]);
    }
  }

  updateAudioSectionDisabledState();
  updateSummary(el);
  if (!isFormatCurrent()) return;
  if (el.matchSource?.checked) {
    await applyMatchSource();
    if (!isFormatCurrent()) return;
    el.resolution.disabled = true;
    el.frameRate.disabled = true;
  }
});

el.resolution?.addEventListener('change', () => {
});
el.frameRate?.addEventListener('change', () => {
});
el.fieldOrder?.addEventListener('change', () => {
});

el.matchSource?.addEventListener('change', async e => {
  captionSidecarAutoMatchSource = false;

  if (e.target.checked) {
    const ok = await applyMatchSource();
    if (!ok) {
      e.target.checked = false;
      return;
    }
    el.resolution.disabled = true;
    el.frameRate.disabled = true;
  } else {
    el.resolution.disabled = false;
    el.frameRate.disabled = false;
  }
  updateAudioSectionDisabledState();
  updateSummary(el);
});

el.audioOnly?.addEventListener('change', () => {
  if (!el.audioOnly.checked && el.audioOnly.dataset.auto === '1') {
    el.audioOnly.dataset.auto = '0';
  }
  toggleAudioOnlyMode().catch(() => {});
  updateTranscodeJobPreview();
});

el.selectInputFiles?.addEventListener('click', async () => {
  resetFolderSelectionCache();
  let probeSessionId = null;
  const isProbeSessionActive = () =>
    probeSessionId === null || transcodePanelState.probeSessionId === probeSessionId;
  const isWatch = document.getElementById('transcode-watch-mode')?.checked;
  if (isWatch) {
    let folder = null;
    try {
      const canSelect =
        (typeof window.electron?.selectFolder === 'function') ||
        (typeof ipc?.invoke === 'function');
      if (!canSelect) {
        throw new Error(t('transcodeFolderPickerUnavailable', 'Folder picker unavailable (IPC bridge missing).'));
      }
      const watchTitle = t('transcodeSelectWatchFolderDialogTitle', 'Select Watch Folder');
      if (typeof window.electron?.selectFolder === 'function') {
        folder = await window.electron.selectFolder({ title: watchTitle });
      } else {
        folder = await ipc?.invoke?.('select-folder', { title: watchTitle });
      }
    } catch (err) {
      showError(t(
        'transcodeFolderPickerFailedError',
        '❌ Failed to open folder picker: {{error}}',
        { error: err?.message || err }
      ));
      return;
    }
    if (folder) {
      el.inputFiles.value = folder;
      el.inputFiles.dataset.fileList = JSON.stringify([folder]);
      if (!el.inputFiles.classList.contains('hidden')) autoResize(el.inputFiles);
      syncTranscodeWatchFolderPath();
      logTranscode(i18nMsg('transcodeWatchFolderSetLog', '📁 Watch folder set to: {{folder}}', { folder }), { fileId: folder });
      showTranscodeStatusText(i18nMsg('transcodeWatchFolderSetLog', '📁 Watch folder set to: {{folder}}', { folder }));
      setMatchSourceState(true);
      if (el.audioOnly) {
        el.audioOnly.dataset.auto = '0';
        el.audioOnly.disabled = false;
      }
      // In Watch Mode we hide the file grid entirely and show the watched folder
      // in the standard single-line path box instead.
      resetFileInfoGrid('transcode', 'gridCols-transcode');
      transcodePanelState.fileInfoRows = [];
      transcodePanelState.fileInfoSource = 'watch';
      updateTranscodeJobPreview();
      updateSummary(el);
      await updateStartButtonForWatchState(true);
    }
    if (!folder) {
      await updateStartButtonForWatchState(true);
    }
    return;
  }

  let files = null;
  try {
    const canSelect =
      (typeof window.electron?.selectFiles === 'function') ||
      (typeof ipc?.invoke === 'function');
    if (!canSelect) {
      throw new Error(t('transcodeFilePickerUnavailable', 'File picker unavailable (IPC bridge missing).'));
    }
    const sourceTitle = t('transcodeSelectSourceFilesDialogTitle', 'Select Source Files');
    if (typeof window.electron?.selectFiles === 'function') {
      files = await window.electron.selectFiles({ title: sourceTitle });
    } else {
      files = await ipc?.invoke?.('select-files', { title: sourceTitle });
    }
  } catch (err) {
    showError(t(
      'transcodeFilePickerFailedError',
      '❌ Failed to open file picker: {{error}}',
      { error: err?.message || err }
    ));
    return;
  }
  if (files && files.length) {
    probeSessionId = ++transcodePanelState.probeSessionId;
    transcodePanelState.fileInfoSource = 'files';
    transcodePanelState.fileInfoRows = [];
    el.inputFiles.value = files.length === 1 ? files[0] : files.join('\n');
    el.inputFiles.dataset.fileList = JSON.stringify(files);
    autoResize(el.inputFiles);
    await updateMatchSourceFromSelection();
    await updateStartButtonForWatchState(false);

    if (files.length === 1) {
      const sourceSetSingleMsg = i18nMsg('transcodeSourceSetLogSingle', '📁 Source set to file: {{file}}', { file: files[0] });
      logTranscode(sourceSetSingleMsg, { detail: '' });
      showTranscodeStatusText(sourceSetSingleMsg);
    } else {
      const sourceSetMultiMsg = i18nMsg('transcodeSourceSetLogMulti', '📁 Source set to {{count}} files', { count: files.length });
      logTranscode(sourceSetMultiMsg, {
        detail: files.join('\n')
      });
      showTranscodeStatusText(sourceSetMultiMsg);
    }

    const grid = prepareFileInfoGrid('transcode');
    if (!grid) return;

    const totalFiles = files.length;
    let probedCount = 0;
    const updateProbeStatus = () => {
      if (!isProbeSessionActive()) return;
      showTranscodeStatusText(i18nMsg(
        'transcodeStatusProbing',
        '🔎 Probing {{current}}/{{total}}…',
        { current: probedCount, total: totalFiles }
      ));
    };
    updateProbeStatus();

    const fileNames = await Promise.all(files.map(async (file) => {
      if (typeof window.electron?.basenameAsync === 'function') {
        try { return await window.electron.basenameAsync(file); } catch {}
      }
      return window.electron.basename(file);
    }));

    const fileRows = files.map((file, index) => {
      const fileName = fileNames[index] || file;
      transcodePanelState.fileInfoRows[index] = { filePath: file, fileName, status: 'probing' };
      const row = appendFileInfoRow(grid, [
        makeFileInfoCell(fileName),
        makeFileInfoCell(t('transcodeProbingPlaceholder', '⏳ Probing…'), { gridColumn: 'span 5' })
      ]);
      if (row) {
        row.dataset.index = String(index);
      }
      return row;
    });

    const updateFileRow = (index, cells) => {
      if (!isProbeSessionActive()) return;
      const row = fileRows[index];
      if (!row) return;
      row.replaceChildren(...cells.filter(Boolean));
    };

    const maxConcurrentProbes = 6;
    let nextIndex = 0;
    const fileStreamInfo = new Array(files.length).fill(null);
    const probeNext = async () => {
      while (nextIndex < files.length) {
        if (!isProbeSessionActive()) return;
        const fileIndex = nextIndex++;
        const f = files[fileIndex];
        try {
          const meta = await getFileMetadata(f);
          if (!isProbeSessionActive()) return;
          const streams = meta.streams || [];
          const hasVideoStream = streams.some(s => s.codec_type === 'video');
          const v = streams.find(s => s.codec_type === 'video');
          const videoCodecName = typeof v?.codec_name === 'string' ? v.codec_name.toLowerCase() : '';
          const isDNX = Boolean(videoCodecName && videoCodecName.startsWith('dnx'));
          if (!isProbeSessionActive()) return;
          fileStreamInfo[fileIndex] = { hasVideoStream, videoCodecName, isDNX };
          const fileName = fileNames[fileIndex] || f;
          transcodePanelState.fileInfoRows[fileIndex] = {
            filePath: f,
            fileName,
            metadata: meta,
            status: 'ready'
          };
          updateFileRow(fileIndex, buildTranscodeFileInfoCells(f, meta, fileName));
        } catch (err) {
          if (!isProbeSessionActive()) return;
          fileStreamInfo[fileIndex] = null;
          const fileName = fileNames[fileIndex] || f;
          transcodePanelState.fileInfoRows[fileIndex] = {
            filePath: f,
            fileName,
            error: String(err),
            status: 'error'
          };
          updateFileRow(fileIndex, buildTranscodeFileInfoErrorCells(f, err, fileName));
        } finally {
          if (isProbeSessionActive()) {
            probedCount += 1;
            updateProbeStatus();
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(maxConcurrentProbes, files.length) }, () => probeNext())
    );

    if (!isProbeSessionActive()) return;
    setupResizableGrid(grid, 'gridCols-transcode');

    const allAudioOnly = files.every((file, index) => {
      const info = fileStreamInfo[index];
      if (info && typeof info.hasVideoStream === 'boolean') {
        return !info.hasVideoStream;
      }
      return isAudioOnlyFile(file);
    });
    const hasDNX = fileStreamInfo.some(info => info?.isDNX);

    if (!isProbeSessionActive()) return;
    if (el.audioOnly) {
      const wasAutoAudio = el.audioOnly.dataset.auto === '1';
      el.audioOnly.dataset.auto = allAudioOnly ? '1' : '0';
      el.audioOnly.disabled = allAudioOnly;
      if (allAudioOnly) {
        if (!el.audioOnly.checked) {
          el.audioOnly.checked = true;
        }
        if (isProbeSessionActive()) {
          await toggleAudioOnlyMode();
        }
      } else if (wasAutoAudio && el.audioOnly.checked) {
        el.audioOnly.checked = false;
        if (isProbeSessionActive()) {
          await toggleAudioOnlyMode();
        }
      } else if (!el.audioOnly.checked) {
        if (!isProbeSessionActive()) return;
        setVideoControlsDisabled(false);
      }
    } else {
      if (!isProbeSessionActive()) return;
      setVideoControlsDisabled(allAudioOnly);
    }

    if (!isProbeSessionActive()) return;
    if (hasDNX) {
      showTranscodeStatusText(i18nMsg(
        'transcodeWarnDnxhdr',
        '⚠️ DNxHD/R source detected. FFmpeg may not handle it well.'
      ));
    } else {
      showTranscodeStatusText(
        allAudioOnly
          ? i18nMsg(
            'transcodeStatusAudioOnlyDetected',
            '🎧 Audio-only file(s) detected. Audio-only mode locked; video options disabled.'
          )
          : i18nMsg('transcodeStatusFilesLoaded', '✅ Files loaded.')
      );
    }
  } else {
    clearInputSelection();
  }

  if (!isProbeSessionActive()) return;
  updateAudioSectionDisabledState();
  updateSummary(el);
  if (el.matchSource?.checked) {
    await applyMatchSource();
    el.resolution.disabled = true;
    el.frameRate.disabled = true;
  }
  updateTranscodeJobPreview();
});

el.selectOutput?.addEventListener('click', async () => {
  let folder = null;
  try {
    const canSelect =
      (typeof window.electron?.selectFolder === 'function') ||
      (typeof ipc?.invoke === 'function');
    if (!canSelect) {
      throw new Error(t('transcodeFolderPickerUnavailable', 'Folder picker unavailable (IPC bridge missing).'));
    }
    const outputTitle = t('transcodeSelectOutputFolderDialogTitle', 'Select Output Folder');
    folder =
      (await window.electron?.selectFolder?.({ title: outputTitle })) ??
      (await ipc?.invoke?.('select-folder', { title: outputTitle }));
  } catch (err) {
    showError(t(
      'transcodeOutputFolderPickerFailedError',
      '❌ Failed to select output folder: {{error}}',
      { error: err?.message || err }
    ));
    return;
  }
  if (folder) {
    el.outputPath.value = folder;
    const outputFolderSetMsg = i18nMsg('transcodeOutputFolderSetLog', '📁 Output folder set to: {{folder}}', { folder });
    logTranscode(outputFolderSetMsg, { fileId: folder });
    showTranscodeStatusText(outputFolderSetMsg);
    updateTranscodeJobPreview();
    updateSummary(el);
    if (el.watchMode?.checked) {
      await updateStartButtonForWatchState(true);
    }
  }
});

el.outputPath?.addEventListener('input', async () => {
  if (el.watchMode?.checked) {
    await updateStartButtonForWatchState(true);
  }
});

el.outputPath?.addEventListener('change', async () => {
  if (el.watchMode?.checked) {
    await updateStartButtonForWatchState(true);
  }
});

el.startBtn?.addEventListener('click', async () => {
    if (isTranscoding || isStartingWatch) return;
    isTranscoding = true;
    el.startBtn.disabled = true;
    let jobQueued = false;
    try {
      const cfg = gatherTranscodeConfig();
      const isWatchMode = document.getElementById('transcode-watch-mode')?.checked;
      const resetStartState = () => {
        isTranscoding = false;
        if (el.startBtn) el.startBtn.disabled = false;
      };

      if (isWatchMode) {
        const watchInputError = getWatchInputCardinalityError(cfg.inputFiles);
        if (watchInputError) {
          showError(watchInputError);
          setTranscodeControlsDisabled(false);
          el.resetBtn.disabled = false;
          el.cancelBtn.disabled = true;
          updateTranscodeJobPreview();
          resetStartState();
          return;
        }
      }

      const hasInputs = Array.isArray(cfg.inputFiles) && cfg.inputFiles.length > 0;
      const hasWatchFolder = !!cfg.watchFolder;

      if (!hasInputs && !hasWatchFolder) {
        const msg = t(
          'transcodeStartNeedsInputOrWatch',
          '❌ Please add at least one input file or select a watch folder to start.'
        );
        showError(msg);
        setTranscodeControlsDisabled(false);
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        updateTranscodeJobPreview();
        resetStartState();
        return;
      }

      if (cfg.enableN8N) {
        const n8nValidation = validateN8nUrl(cfg.n8nUrl, { allowPrivate: cfg.n8nAllowPrivate });
        if (!n8nValidation.valid) {
          const msg = n8nValidation.message || `❌ ${t('adobeUtilities.n8nUrlInvalidGeneric', 'Invalid n8n URL.')}`;
          showError(msg);
          setTranscodeControlsDisabled(false);
          el.resetBtn.disabled = false;
          el.cancelBtn.disabled = true;
          updateTranscodeJobPreview();
          resetStartState();
          return;
        }
      }

      const clearWatchStartGuard = ({ enableStartButton = true } = {}) => {
        isStartingWatch = false;
        isTranscoding = false;
        if (enableStartButton) {
          el.startBtn.disabled = false;
        }
      };

      if (isWatchMode) {
        isStartingWatch = true;
        el.startBtn.disabled = true;

        cfg.watchFolder = cfg.inputFiles[0];

        // ✅ Watch Mode requires a folder path (not a file). Validate before starting.
        if (cfg.watchFolder) {
          const stat = await getDirectoryStatusForPath(cfg.watchFolder, { bypassCache: true });
          if (!stat.ok) {
            const unknownErrorText = t('transcodeWatchUnknownError', 'unknown error');
            const errMsg = i18nMsg(
              'transcodeWatchUnableAccessFolder',
              '❌ Unable to access watch folder: {{folder}} ({{error}})',
              { folder: cfg.watchFolder, error: stat.error || unknownErrorText }
            );
            emitTranscodeStatus(errMsg, { level: 'error', meta: { isError: true } });
            clearWatchStartGuard();
            return;
          }

          const isDirectory = !!stat.isDirectory;

          if (!isDirectory) {
            const errMsg = i18nMsg(
              'transcodeWatchPathNotFolder',
              '❌ Watch Mode requires a folder to watch. Selected path is not a folder: {{folder}}',
              { folder: cfg.watchFolder }
            );
            emitTranscodeStatus(errMsg, { level: 'error', meta: { isError: true } });
            clearWatchStartGuard();
            return;
          }
        }

        const watchOutput = (el.outputPath?.value || '').trim();
        if (!watchOutput) {
          const errMsg = i18nMsg(
            'transcodeWatchSelectOutputBeforeStart',
            '❌ Please select an output folder before starting watch mode.'
          );
          emitTranscodeStatus(errMsg, { level: 'error', meta: { isError: true } });
          clearWatchStartGuard();
          return;
        }

        const outputStatus = await getDirectoryStatusForPath(watchOutput);
        if (!outputStatus.ok) {
          const unknownErrorText = t('transcodeWatchUnknownError', 'unknown error');
          const errMsg = i18nMsg(
            'transcodeWatchUnableAccessOutput',
            '❌ Unable to access output folder: {{folder}} ({{error}})',
            { folder: watchOutput, error: outputStatus.error || unknownErrorText }
          );
          emitTranscodeStatus(errMsg, { level: 'error', meta: { isError: true } });
          clearWatchStartGuard();
          return;
        }
        if (!outputStatus.isDirectory) {
          const errMsg = i18nMsg(
            'transcodeWatchOutputNotFolder',
            '❌ Output path must be a folder. Selected path is not a folder: {{folder}}',
            { folder: watchOutput }
          );
          emitTranscodeStatus(errMsg, { level: 'error', meta: { isError: true } });
          clearWatchStartGuard();
          return;
        }

        const watchOutputError = getWatchOutputRelationError(cfg.watchFolder, watchOutput);
        if (watchOutputError) {
          const errMsg = i18nMsg('transcodeWatchOutputRelationErrorPrefixed', '❌ {{error}}', { error: watchOutputError });
          emitTranscodeStatus(errMsg, { level: 'error', meta: { isError: true } });
          clearWatchStartGuard();
          return;
        }

        cfg.outputFolder = watchOutput;
        const sharedValidation = await validateTranscodeStartConfig(cfg);
        if (!sharedValidation.ok) {
          const errMsg = sharedValidation.message || t('transcodeInvalidTranscodeConfiguration', '❌ Invalid transcode configuration.');
          emitTranscodeStatus(sharedValidation.statusText || errMsg, {
            level: 'error',
            meta: { isError: true }
          });
          clearWatchStartGuard();
          return;
        }
        if (Array.isArray(sharedValidation.warnings) && sharedValidation.warnings.length) {
          for (const warn of sharedValidation.warnings) {
            emitTranscodeStatus(warn);
          }
        }
        const validation = typeof isWatchConfigValid === 'function'
          ? isWatchConfigValid(cfg)
          : true;
        if (validation !== true) {
          const errMsg = typeof validation === 'string'
            ? validation
            : t('transcodeInvalidWatchConfig', 'Invalid watch configuration.');
          const formatted = `❌ ${errMsg}`;
          emitTranscodeStatus(formatted, { level: 'error', meta: { isError: true } });
          clearWatchStartGuard();
          return;
        }
        const wu = getWatchUtils();
        if (typeof wu?.startWatch !== 'function') {
          const errMsg = i18nMsg(
            'transcodeWatchUnavailableError',
            '❌ Watch Mode is unavailable (watch module not loaded).'
          );
          emitTranscodeStatus(errMsg, { level: 'error', meta: { isError: true } });
          if (el.watchMode) {
            el.watchMode.checked = false;
            el.watchMode.disabled = true;
            el.watchMode.title = t(
              'transcodeWatchUnavailable',
              'Watch Mode unavailable (watch module not loaded).'
            );
          }
          setTranscodeWatchSessionRunning(false);
          // Ensure the UI returns to its non-watch state when Watch Mode is disabled.
          applyTranscodeWatchButtonState(false);
          setTranscodeControlsDisabled(false);
          el.resetBtn.disabled = false;
          el.cancelBtn.disabled = true;
          clearWatchStartGuard();
          return;
        }

        try {
          await wu.startWatch('transcode', cfg);
        } catch (err) {
          const errMsg = i18nMsg(
            'transcodeWatchStartFailed',
            '❌ Failed to start Watch Mode: {{error}}',
            { error: err?.message || err }
          );
          emitTranscodeStatus(errMsg, { level: 'error', meta: { isError: true } });
          setTranscodeWatchSessionRunning(false);
          setTranscodeControlsDisabled(false);
          el.resetBtn.disabled = false;
          el.cancelBtn.disabled = true;
          clearWatchStartGuard();
          return;
        }

        setTranscodeWatchSessionRunning(true);
        const startedMsg = i18nMsg(
          'transcodeWatchStarted',
          '👀 Watch Mode started.'
        );
        emitTranscodeStatus(startedMsg);

        clearWatchStartGuard({ enableStartButton: false });
        setTranscodeControlsDisabled(true);
        el.cancelBtn.disabled = false;
        setTranscodeWatchEyesActive(true);
        return;
      }

      if (await isFolderInputSelected()) {
        const msg = t(
          'transcodeSelectFilesOrEnableWatchError',
          '❌ Please select files (or enable Watch Mode for folders).'
        );
        showError(msg);
        setTranscodeControlsDisabled(false);
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        updateTranscodeJobPreview();
        resetStartState();
        return;
      }

      const outputPath = getNormalizedOutputFolder(el.outputPath?.value);
      if (!outputPath) {
        const msg = i18nMsg('transcodeSelectOutputFolderError', '❌ Please select an output folder.');
        emitTranscodeStatus(msg, { level: 'error', meta: { isError: true } });
        isTranscoding = false;
        setTranscodeControlsDisabled(false);
        el.startBtn.disabled = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;        
        return;
      }

      const reportOutputPathError = errMsg => {
        emitTranscodeStatus(errMsg, { level: 'error', meta: { isError: true } });
        isTranscoding = false;
        setTranscodeControlsDisabled(false);
        el.startBtn.disabled = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;        
      };

      const outputStatus = await getDirectoryStatusForPath(outputPath);
      if (!outputStatus.ok) {
        const msg = i18nMsg('transcodeWatchUnableAccessOutput',
          '❌ Unable to access output folder: {{folder}} ({{error}})',
          { folder: outputPath, error: outputStatus.error || t('transcodeWatchUnknownError', 'unknown error') }
        );
        reportOutputPathError(msg);
        return;
      }
      if (!outputStatus.isDirectory) {
        const msg = i18nMsg('transcodeWatchOutputNotFolder',
          '❌ Output path must be a folder. Selected path is not a folder: {{folder}}',
          { folder: outputPath }
        );
        reportOutputPathError(msg);
        return;
      }

      cfg.outputFolder = outputPath;
      const sharedValidation = await validateTranscodeStartConfig(cfg);
      if (!sharedValidation.ok) {
        const errMsg = sharedValidation.message || t('transcodeInvalidTranscodeConfiguration', '❌ Invalid transcode configuration.');
        if (sharedValidation.log) {
          logTranscode(errMsg, { isError: true });
          appendLogLine(el.log, errMsg);
          if (sharedValidation.statusText) {
            showTranscodeStatusText(sharedValidation.statusText);
          }
        } else {
          showError(errMsg);
          setTranscodeControlsDisabled(false);
          resetStartState();
        }
        isTranscoding = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        return;
      }

      if (Array.isArray(sharedValidation.warnings) && sharedValidation.warnings.length) {
        for (const warn of sharedValidation.warnings) {
          logTranscode(warn);
          appendLogLine(el.log, warn);
        }
      }

      const format = cfg.outputFormat;
      const resolution = cfg.resolution;
      const audioOnlyMode = cfg.audioOnly;
      const formatCompat = format
        ? (__compatCache.get(format) || await window.codex?.getCompatibility?.(format))
        : null;
      if (formatCompat && !__compatCache.has(format)) __compatCache.set(format, formatCompat);

      el.resetBtn.disabled = true;
      el.cancelBtn.disabled = true;
      pendingCancel = false;

      const outputFolder = getNormalizedOutputFolder(cfg.outputFolder);

      const config = {
        ...cfg,
        outputFolder,
        watchMode: el.watchMode.checked,
        verification: {
          method: el['transcode-verification-method']?.value || 'metadata',
          saveLog: el.saveLog.checked
        }
      };

      const inputList = config.inputFiles || [];

      if (audioOnlyMode) {
        let preflight = null;
        try {
          preflight = await ipc.invoke('transcode-preflight', {
            ...config,
            inputFiles: inputList,
            outputFolder
          });
        } catch (err) {
          preflight = {
            status: 'unknown',
            message: i18nMsg(
              'transcodeWarnPreflightSkipped',
              '⚠️ Disk space preflight skipped ({{error}}).',
              { error: err?.message || err }
            )
          };
        }

        if (preflight?.message) {
          const isError = preflight.status === 'insufficient';
          logTranscode(preflight.message, { isError });
          appendLogLine(el.log, preflight.message);
          showTranscodeStatusText(preflight.message);
        }

        if (preflight?.status === 'insufficient') {
          showTranscodeStatusText(
            preflight.message ||
            i18nMsg('transcodeErrorDiskSpaceInsufficient', '🛑 Aborted: Not enough disk space')
          );
          resetStartState();
          el.resetBtn.disabled = false;
          el.cancelBtn.disabled = true;
          return;
        }

        try {
          isQueueingTranscode = true;
          currentJobId = await ipc.invoke('queue-add-transcode', { config });
          jobQueued = true;
          isQueueingTranscode = false;
          const queuedMsg = i18nMsg('transcodeLogQueued', '🗳️ Transcode job queued.');
          logTranscode(queuedMsg);
          appendLogLine(el.log, queuedMsg);
          showTranscodeStatusText(queuedMsg);
          setTranscodeControlsDisabled(true);
          if (pendingCancel) {
            pendingCancel = false;
            isTranscoding = false;
            await cancelQueuedTranscode();
            return;
          }
          el.cancelBtn.disabled = false;
        } catch (err) {
          isQueueingTranscode = false;
          currentJobId = null;
          pendingCancel = false;
          const errMsg = i18nMsg('queueJobQueueError', '❌ Queue error: {{error}}', { error: err?.message || err });
          logTranscode(errMsg, { isError: true });
          appendLogLine(el.log, errMsg);
          showTranscodeStatusText(errMsg);
          // Queue submission failed. Restore the UI so the panel doesn't appear frozen/locked.
          el.resetBtn.disabled = false;
          el.cancelBtn.disabled = true;
          hideTranscodeHamster();
          isTranscoding = false;
          return;
        }
        isTranscoding = false;
        return;
      }

      const selectedEntry = formatCompat?.defaults;

      if (inputList.length && selectedEntry) {
        const validationWarnings = [];

        for (const inputFile of inputList) {
          let metadata = null;
          let metadataWarning = '';
          try {
            metadata = await window.electron.getSourceMetadata?.(inputFile);
          } catch (err) {
            metadata = null;
            metadataWarning = i18nMsg(
              'transcodeWarnMetadataReadFailed',
              '⚠️ Unable to read metadata for {{file}} ({{error}}).',
              { file: window.electron.basename?.(inputFile) || inputFile, error: err?.message || err }
            );
          }

          if (!metadata) {
            const warnMsg =
              metadataWarning ||
              i18nMsg('transcodeWarnMetadataReadFailedNoError', '⚠️ Unable to read metadata for {{file}}.', {
                file: window.electron.basename?.(inputFile) || inputFile
              });
            logTranscode(warnMsg);
            appendLogLine(el.log, warnMsg);
            showTranscodeStatusText(warnMsg);
            validationWarnings.push({
              file: inputFile,
              reason: t('transcodeValidationReasonMetadataUnavailable', 'metadata unavailable')
            });
            continue;
          }

          const ok = await window.electron.validateCodexInput?.(metadata, selectedEntry);
          if (!ok) {
            validationWarnings.push({
              file: inputFile,
              reason: t('transcodeValidationReasonSpecsMismatch', 'specs mismatch')
            });
          }
        }
        if (validationWarnings.length) {
          const fileList = validationWarnings
            .map(({ file, reason }) => {
              const name = window.electron.basename?.(file) || file;
              return reason ? `${name} (${reason})` : name;
            })
            .join(', ');
          const specWarn = i18nMsg(
            'transcodeWarnSpecsMismatchProceed',
            '⚠️ The following files do not meet recommended specs for {{format}}: {{files}}. Continuing anyway.',
            { format: selectedEntry.name || format, files: fileList }
          );
          logTranscode(specWarn);
          appendLogLine(el.log, specWarn);
          showTranscodeStatusText(specWarn);
        }
      }

      const startMsg = i18nMsg('transcodeLogStarting', '⚙️ Starting transcode...');
      logTranscode(startMsg);
      setLogText(el.log, startMsg);
      showTranscodeStatusText(i18nMsg('transcodeLogStartingStatus', '🔄 Starting transcode...'));

      let preflight = null;
      try {
        preflight = await ipc.invoke('transcode-preflight', {
          ...config,
          inputFiles: inputList,
          outputFolder
        });
      } catch (err) {
        preflight = {
          status: 'unknown',
          message: i18nMsg(
            'transcodeWarnPreflightSkipped',
            '⚠️ Disk space preflight skipped ({{error}}).',
            { error: err?.message || err }
          )
        };
      }

      if (preflight?.message) {
        const isError = preflight.status === 'insufficient';
        logTranscode(preflight.message, { isError });
        appendLogLine(el.log, preflight.message);
        showTranscodeStatusText(preflight.message);
      }

      if (preflight?.status === 'insufficient') {
        showTranscodeStatusText(
          preflight.message ||
          i18nMsg('transcodeErrorDiskSpaceInsufficient', '🛑 Aborted: Not enough disk space')
        );
        isTranscoding = false;
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        return;
      }


      if (!audioOnlyMode && format?.startsWith('xdcam')) {
        const validXDCAMRes = ['1920x1080', '1440x1080'];
        const validInterlacedFields = ['interlaced_tff', 'interlaced_bff'];
        if (!validXDCAMRes.includes(resolution) || !validInterlacedFields.includes(el.fieldOrder.value)) {
          const xdcamMsg = i18nMsg(
            'transcodeErrorXdcamSettings',
            '❌ XDCAM HD requires 1080i resolutions and interlaced output (upper or lower field first).'
          );
          logTranscode(xdcamMsg, { isError: true });
          appendLogLine(el.log, xdcamMsg);
          showTranscodeStatusText(i18nMsg('transcodeStatusInvalidXdcam', '🛑 Invalid XDCAM settings'));
          isTranscoding = false;
          el.resetBtn.disabled = false;
          el.cancelBtn.disabled = true;
          return;
        }
      } else if (!audioOnlyMode && format?.startsWith('xavc')) {
        if (resolution !== '1920x1080' && resolution !== '3840x2160') {
          const xavcMsg = i18nMsg(
            'transcodeErrorXavcResolution',
            '❌ XAVC formats require 1080p or UHD resolution.'
          );
          logTranscode(xavcMsg, { isError: true });
          appendLogLine(el.log, xavcMsg);
          showTranscodeStatusText(i18nMsg('transcodeStatusInvalidXavc', '🛑 Invalid XAVC resolution'));
          isTranscoding = false;
          el.resetBtn.disabled = false;
          el.cancelBtn.disabled = true;
          return;
        }
      }

      setTranscodeControlsDisabled(true);

      try {
        isQueueingTranscode = true;
        currentJobId = await ipc.invoke('queue-add-transcode', { config });
        jobQueued = true;
        isQueueingTranscode = false;
        const queuedMsg2 = i18nMsg('transcodeLogQueued', '🗳️ Transcode job queued.');
        logTranscode(queuedMsg2);
        showTranscodeStatusText(queuedMsg2);
        appendLogLine(el.log, queuedMsg2);
        if (pendingCancel) {
          pendingCancel = false;
          isTranscoding = false;
          await cancelQueuedTranscode();
          return;
        }
      } catch (err) {
        isQueueingTranscode = false;
        currentJobId = null;
        pendingCancel = false;
        const errMsg2 = i18nMsg('queueJobQueueError', '❌ Queue error: {{error}}', { error: err?.message || err });
        emitTranscodeStatus(errMsg2, { level: 'error', meta: { isError: true } });

        // Queue submission failed. Restore the UI to an idle state immediately so the
        // panel doesn't appear frozen/locked.
        setTranscodeControlsDisabled(false);
        el.resetBtn.disabled = false;
        el.cancelBtn.disabled = true;
        hideTranscodeHamster();
        isTranscoding = false;
        return;
      }

      isTranscoding = false;
      el.cancelBtn.disabled = false;
    } finally {
      const isActivelyWatching = transcodeWatchSessionRunning;
      if (!jobQueued && !isActivelyWatching) {
        el.startBtn.disabled = false;
      }
      isTranscoding = false;
    }
});


  async function cancelQueuedTranscode() {
    if (!currentJobId) {
      return;
    }
    const cancelingMsg = i18nMsg('transcodeLogCanceling', '🛑 Canceling...');
    emitTranscodeStatus(cancelingMsg);
    const cancelRequestedMsg = i18nMsg('transcodeLogCancelRequested', '🛑 Cancel requested by user.');
    emitTranscodeStatus(cancelRequestedMsg);
    el.cancelBtn.disabled = true;

    try {
      cancelPendingJobId = currentJobId;
      await ipc.invoke('cancel-transcode', currentJobId);
      await ipc.invoke('queue-cancel-job', currentJobId);
      currentJobId = null;
      emitTranscodeStatus(i18nMsg('transcodeStatusCancelRequested', '🛑 Cancel requested...'));
      await resetTranscodeFields();
    } catch (err) {
      emitTranscodeStatus(i18nMsg('transcodeWarnCancelFailed', '⚠️ Cancel failed.'));
      const cancelErr = i18nMsg(
        'transcodeCancelError',
        '❌ Cancel error: {{error}}',
        { error: err?.message || err }
      );
      emitTranscodeStatus(cancelErr, { level: 'error', meta: { isError: true } });
    }
  }

  el.cancelBtn?.addEventListener('click', async () => {
    // Decide based on actual watch state, not button text.
    const isWatchCheckboxOn = !!el.watchMode?.checked;
    const wu = getWatchUtils();
    const isActivelyWatching = transcodeWatchSessionRunning;

    if (isWatchCheckboxOn || isActivelyWatching) {
      try {
        if (typeof wu?.stopWatch === 'function') {
          await wu.stopWatch('transcode');
        }
      } catch (e) {
        panelLog('warn', 'stopWatch failed (transcode):', { error: e?.message || e });
      }
      setTranscodeWatchSessionRunning(false);
      showTranscodeStatusText(i18nMsg('transcodeWatchStopped', '🛑 Watch Mode stopped.'));
      el.startBtn.disabled = false;
      el.cancelBtn.disabled = true;
      setButtonLabel(el.startBtn, t('startTranscode', 'Start'));
      setButtonLabel(el.cancelBtn, t('cancelTranscode', 'Cancel'));
      if (el.watchMode) el.watchMode.checked = false;
      applyTranscodeWatchButtonState(false);
      setTranscodeWatchEyesActive(false);
      setTranscodeControlsDisabled(false);
      return;
    }

    if (isQueueingTranscode && !currentJobId) {
      pendingCancel = true;
      const cancelPendingMsg = i18nMsg('transcodeLogCancelPending', '🛑 Cancel pending...');
      emitTranscodeStatus(cancelPendingMsg);
      const cancelQueueMsg = i18nMsg(
        'transcodeLogCancelWhileQueueing',
        '🛑 Cancel requested while queueing.'
      );
      emitTranscodeStatus(cancelQueueMsg);
      return;
    }

    await cancelQueuedTranscode();
  });

  async function resetTranscodeFields() {
    if (isTranscoding) return;

    el.inputFiles.value = '';
    el.inputFiles.dataset.fileList = '[]';
    if (!el.inputFiles.classList.contains('hidden')) autoResize(el.inputFiles);
    if (el.watchFolderPath) el.watchFolderPath.value = '';
    resetFileInfoGrid('transcode', 'gridCols-transcode');
    transcodePanelState.fileInfoRows = [];
    transcodePanelState.fileInfoSource = 'none';
    el.outputPath.value = '';
    showTranscodeStatusText(i18nMsg('transcodeStatusIdle', 'Idle'));
    setLogText(el.log, '');
    el.cancelBtn.disabled = true;
    resetTranscodeProgressUI();
    setTranscodeWatchEyesActive(false);
    // Bottom per-file summary was removed; nothing additional to reset here.

    setDropdownValue('outputFormat', '');
    const format = el.outputFormat.value;
    ['containerFormat','resolution','frameRate','audioCodec','channels','pixelFormat','colorRange','fieldOrder','sampleRate']
      .forEach(id => setDropdownValue(id, ''));
    setDropdownValue('transcode-verification-method', 'metadata');
    await filterResolutionOptions(format, el);
    await filterPixelFormats(format, el);
    await filterAudioCodecs(format, el);
    await filterSampleRates(format, el);
    await filterChannels(format, el);

    [
      el.audioBitrate, el.audioDelay
    ].forEach(input => { if (input) input.value = ''; });

    [
      el.normalizeAudio,
      el.enableN8N,
      el.n8nAllowPrivate,
      el.n8nLog,
      el.watchMode,
      el.watchProcessExisting
    ].forEach(cb => { if (cb) cb.checked = false; });
    if (el.saveLog) el.saveLog.checked = false;

    if (el.hideLog) {
      el.hideLog.checked = true;
      try { el.hideLog.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    }

    // Pro workflow default: preserve metadata/streams unless explicitly disabled.
    if (el.preserveMetadata) el.preserveMetadata.checked = true;

    if (el.matchSource) {
      el.matchSource.checked = false;
      el.resolution.disabled = false;
      el.frameRate.disabled = false;
    }

    if (el.audioOnly) {
      el.audioOnly.checked = false;
      el.audioOnly.dataset.auto = '0';
      cachedVideoSelections = null;
      await toggleAudioOnlyMode({ restoreCached: false });
    }

    if (el.n8nUrl) el.n8nUrl.value = '';
    if (el.notes) el.notes.value = '';
    clearCaptionSidecar();
    setLut('');
    await filterContainerOptions(el.outputFormat.value);

    updateSummary(el);
    updateTranscodeJobPreview();
    await updateStartButtonForWatchState(false);
  }

  el.resetBtn?.addEventListener('click', () => {
    if (window.panelPresetDefaults?.has?.('transcode')) {
      void window.panelPresetDefaults.resetToDefault('transcode')
        .then(applied => {
          if (!applied) {
            resetTranscodeFields().catch(() => {});
          }
          if (el.hideLog) {
            el.hideLog.checked = true;
            try { el.hideLog.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
          }
        })
        .catch(() => {
          resetTranscodeFields().catch(() => {});
        });
      return;
    }

    resetTranscodeFields().catch(() => {});
  });

// 💾 Save Preset
el.savePresetBtn?.addEventListener('click', async () => {
  const presetDir = ensurePresetDirAvailable();
  if (!presetDir) return;
  const preset = buildTranscodePresetPayload();

  const file = await window.electron.saveFile({
    defaultPath: window.electron.joinPath(presetDir, 'transcode-preset.json'),
    filters: [{ name: t('transcodePresetFilterLabel', 'Preset'), extensions: ['json'] }]
  });

  if (file) {
    const serialized = JSON.stringify(preset, null, 2);
    if (typeof window.electron?.writeTextFileAtomicAsync === 'function') {
      await window.electron.writeTextFileAtomicAsync(file, serialized);
    } else if (typeof window.electron?.writeTextFileAsync === 'function') {
      await window.electron.writeTextFileAsync(file, serialized);
    } else {
      window.electron.writeTextFile(file, serialized);
    }
    ipc.send('preset-saved', 'transcode');
    const name = window.electron.basename(file);
    showTranscodeStatusText(i18nMsg(
      'transcodeLogPresetSavedAs',
      '💾 Preset saved as {{name}}',
      { name }
    ));
    refreshPresetDropdown();
    setDropdownValue('transcode-preset', name);
    if (el.presetSelect) {
      el.presetSelect.value = name;
    }
  } else {
    showTranscodeStatusText(i18nMsg('transcodeWarnSaveCanceled', '⚠️ Save canceled.'));
  }
});

// 📂 Load Preset
el.loadPresetBtn?.addEventListener('click', async () => {
  if (!ensurePresetDirAvailable()) return;
  const file = await window.electron.openFile({
    filters: [{ name: t('transcodePresetFilterLabel', 'Preset'), extensions: ['json'] }]
  });

  if (!file) {
    showTranscodeStatusText(i18nMsg('transcodeWarnLoadCanceled', '⚠️ Load canceled.'));
    return;
  }

  try {
    const raw = window.electron.readTextFile(file);
    const preset = JSON.parse(raw);
    await applyPresetToFields(preset, el);
    showTranscodeStatusText(i18nMsg(
      'transcodeLogPresetLoaded',
      '📂 Loaded {{file}}',
      { file: window.electron.basename(file) }
    ));
    const name = window.electron.basename(file);
    refreshPresetDropdown();
    setDropdownValue('transcode-preset', name);
    if (el.presetSelect) {
      el.presetSelect.value = name;
    }
  } catch (err) {
    panelLog('error', 'Failed to load preset:', { error: err?.message || err });
    showTranscodeStatusText(i18nMsg('transcodeErrorPresetLoadFailed', '❌ Failed to load preset.'));
  }
});

// 🧩 Auto-update summary when key fields change
[
  el.containerFormat,
  el.resolution,
  el.frameRate,
  el.audioCodec,
  el.channels,
  el.pixelFormat,
  el.colorRange,
  el.fieldOrder,
  el.sampleRate,
  el.audioBitrate,
  el.audioDelay,
  el.preserveMetadata
].forEach(elm => {
  if (elm) {
    elm.addEventListener('change', () => updateSummary(el));
  }
});

// Keep compatibility warnings in sync when Preserve Metadata is toggled.
el.preserveMetadata?.addEventListener('change', () => {
  showCompatibilityWarnings(el);
});


const TRANSCODE_IPC_GUARD_KEY = '__transcodeIpcBound';
const TRANSCODE_IPC_TEARDOWN_KEY = '__transcodeIpcTeardown';

function createIpcUnsubscriber(channel, listener, onReturnValue) {
  if (typeof onReturnValue === 'function') {
    return onReturnValue;
  }
  if (typeof ipc?.off === 'function') {
    return () => ipc.off(channel, listener);
  }
  if (typeof ipc?.removeListener === 'function') {
    return () => ipc.removeListener(channel, listener);
  }
  return null;
}

function bindTranscodeIpcHandlers() {
  if (typeof ipc === 'undefined' || typeof ipc.on !== 'function') return () => {};
  if (window[TRANSCODE_IPC_GUARD_KEY]) {
    return typeof window[TRANSCODE_IPC_TEARDOWN_KEY] === 'function'
      ? window[TRANSCODE_IPC_TEARDOWN_KEY]
      : () => {};
  }

  const unsubscribers = [];
  const register = (channel, listener) => {
    const onReturnValue = ipc.on(channel, listener);
    const unsubscribe = createIpcUnsubscriber(channel, listener, onReturnValue);
    if (typeof unsubscribe === 'function') {
      unsubscribers.push(unsubscribe);
    }
  };

  window[TRANSCODE_IPC_GUARD_KEY] = true;

  // Show unified progress like the ingest panel
  register('queue-job-start', (_e, job) => {
    if (job.panel !== 'transcode') return;
    if (job?.id != null) { currentJobId = String(job.id); }
    cancelPendingJobId = null;
    lastProgressSnapshot = { completed: 0, total: job.total ?? 0 };

    const bar = document.getElementById('transcode-progress');
    const out = document.getElementById('transcode-progress-output');
    if (bar) { bar.value = 0; bar.style.display = 'block'; }
    if (out) out.value = '0';

    const etaEl = ensureTranscodeEtaInline();
    if (etaEl) etaEl.textContent = '';
    setTranscodeInlineProgressActive(true);
    showTranscodeHamster();

    // Watch Mode UX: when a file is actively processing, hide the "eyes" indicator so
    // the control row doesn't crowd/bunch on narrow panel widths. Between jobs, the
    // eyes will be restored.
    if (el.watchMode?.checked) {
      setTranscodeWatchEyesActive(false);
    }
  });
  register('queue-job-progress', (_e, payload) => {
    if (payload.panel !== 'transcode') return;

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

    // Keep the inline progress slot visible while updates stream in.
    setTranscodeInlineProgressActive(true);

    lastProgressSnapshot = {
      completed: typeof payload.completed === 'number' ? payload.completed : lastProgressSnapshot.completed,
      total: typeof payload.total === 'number' ? payload.total : lastProgressSnapshot.total
    };

    const bar = document.getElementById('transcode-progress');
    const out = document.getElementById('transcode-progress-output');
    if (!bar) return;

    const hasPercent =
      typeof payload.overall === 'number' ||
      typeof payload.percent === 'number' ||
      typeof payload.filePercent === 'number';

    if (hasPercent) {
      const isWatchMode = !!el.watchMode?.checked;

      let pct =
        (typeof payload.overall === 'number' ? payload.overall :
         typeof payload.percent === 'number' ? payload.percent : 0);

      if (
        typeof payload.filePercent === 'number' &&
        (isWatchMode || (typeof payload.overall !== 'number' && typeof payload.percent !== 'number'))
      ) {
        pct = payload.filePercent;
      }

      pct = Math.max(0, Math.min(100, pct));

      bar.style.display = 'block';
      bar.value = pct;

      if (out) out.value = Math.round(pct);

      const etaEl = ensureTranscodeEtaInline();
      if (etaEl) {
        const showEta = !isWatchMode && pct < 100 && payload.eta;
        etaEl.textContent = showEta
          ? t('transcodeEtaInline', ' • ETA {{eta}}', { eta: payload.eta })
          : '';
      }
    }

    showTranscodeHamster();

    // Watch Mode UX: progress/hamster visible => hide eyes (prevents UI crowding).
    if (el.watchMode?.checked) {
      setTranscodeWatchEyesActive(false);
    }

    if (payload.file && payload.status) {
      if (payload.status.transcoded) {
        logTranscode(i18nMsg(
          'transcodeLogTranscodedFile',
          '✅ Transcoded {{file}}',
          { file: payload.file }
        ));
      }
      const qualityMsg = formatQualityMessage(payload.status.quality, payload.status.verified);
      if (qualityMsg) {
        logTranscode(qualityMsg);
      }
    }
  });

  register('transcode-log-message', (_e, data) => {
    const payload = data && typeof data === 'object' ? data : {};

    const rawMsg = payload.msg ?? payload.message ?? '';
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
      // Watch mode / out-of-band job: adopt the id so subsequent events stay consistent.
      currentJobId = payloadJobId;
    }

    const isDevUi = (window.electron?.isPackaged === false) || (window.electron?.DEBUG_UI === true) || (window.DEBUG_UI === true);
    const isError = !!payload.isError;
    const isWarning = !!payload.isWarning;
    const level = String(
      payload.level || (isWarning ? 'warn' : isError ? 'error' : 'info')
    ).toLowerCase();

    // Never surface debug-level plumbing unless DEV UI is enabled.
    if (level === 'debug' && !isDevUi) return;

    const stage = payload.stage != null ? String(payload.stage).trim() : '';
    const prefix = (isDevUi && stage) ? `[${stage}] ` : '';

    // Always feed the Log Viewer stream (job-valid + debug-gated).
    logTranscode(prefix + msg, {
      level,
      isError,
      isWarning,
      jobId: payloadJobId,
      stage,
      detail: isDevUi ? (payload.detail || '') : '',
      meta: isDevUi ? (payload.meta || undefined) : undefined
    });

    // Mirror into the panel's inline log box for operator visibility during long jobs.
    if (el.log) appendLogLine(el.log, prefix + msg);

    // DEV-only: attach detail/meta in a clipped secondary line.
    if (isDevUi) {
      const detail = typeof payload.detail === 'string' ? payload.detail.trim() : '';
      if (detail && detail !== '{}') {
        const clipped = detail.length > 800 ? detail.slice(0, 800) + '…' : detail;
        if (el.log) appendLogLine(el.log, `↳ ${clipped}`);
      }
    }
  });

  register('watch-log', (_e, msg) => {
    const isDevUi = (window.electron?.isPackaged === false) || (window.electron?.DEBUG_UI === true) || (window.DEBUG_UI === true);
    if (!isDevUi) return;
    const line = msg == null ? '' : String(msg);
    if (!line) return;
    showTranscodeStatusText(i18nMsg('transcodeWatchLogLine', '[watch] {{line}}', { line }));
  });
  register('queue-job-complete', (_e, job) => {
    if (job.panel !== 'transcode') return;
    if (job?.id != null && cancelPendingJobId != null && String(cancelPendingJobId) === String(job.id)) {
      cancelPendingJobId = null;
    }
    currentJobId = null;
    hideTranscodeHamster();
    resetTranscodeProgressUI();
    const completed = lastProgressSnapshot.completed;
    const total = lastProgressSnapshot.total || completed;
    const completeMsg = i18nMsg(
      'transcodeJobCompleteLog',
      '✅ Job complete ({{completed}}/{{total}}){{jobSuffix}}',
      {
        completed,
        total,
        jobSuffix: job.id ? ` • ${job.id}` : ''
      }
    );
    logTranscode(completeMsg);
    const isWatchMode = !!el.watchMode?.checked;

    // Watch Mode UX: job ended => no active file => restore eyes when still watching.
    setTranscodeWatchEyesActive(isWatchMode);
    if (!isWatchMode) {
      setTranscodeControlsDisabled(false);
      resetTranscodeFields().catch(() => {});
      return;
    }
    el.cancelBtn.disabled = false;
    const watchStatus = i18nMsg(
      'transcodeWatchJobCompleteActive',
      '✅ Job complete. Watch mode is still active—listening for new files.'
    );
    emitTranscodeStatus(watchStatus);
    // No bottom per-file overlay or summary text remains to update.
  });
  register('queue-job-failed', (_e, job) => {
    if (job.panel !== 'transcode') return;
    if (job?.id != null && cancelPendingJobId != null && String(cancelPendingJobId) === String(job.id)) {
      cancelPendingJobId = null;
    }
    currentJobId = null;
    resetTranscodeProgressUI();
    const errorMessage = typeof job?.error?.message === 'string'
      ? job.error.message
      : (job?.error ? String(job.error) : '');
    const failureMsg = i18nMsg(
      'transcodeJobFailedLog',
      '❌ Job failed{{jobIdPart}}{{errorPart}}',
      {
        jobIdPart: job.id ? ` (${job.id})` : '',
        errorPart: errorMessage ? ` — ${errorMessage}` : ''
      }
    );
    emitTranscodeStatus(failureMsg, { level: 'error' });
    if (job?.error && typeof job.error === 'object') {
      const detail = JSON.stringify(job.error);
      const diagnosticsMsg = i18nMsg(
        'transcodeDiagnosticsLine',
        'Diagnostics: {{detail}}',
        { detail }
      );
      logTranscode(diagnosticsMsg, { level: 'error', isError: true });
      showTranscodeStatusText(diagnosticsMsg);
    }
    const isWatchMode = !!el.watchMode?.checked;

    // Watch Mode UX: job ended (failed) => restore eyes if we're still watching.
    setTranscodeWatchEyesActive(isWatchMode);

    if (!isWatchMode) {
      setCaptionSidecarSettingsLocked(false);
      releaseCaptionSidecarAutoMatchSource();
      setTranscodeControlsDisabled(false);
    }
  });
  register('queue-job-cancelled', (_e, job) => {
    if (job.panel !== 'transcode') return;
    if (job?.id != null && cancelPendingJobId != null && String(cancelPendingJobId) === String(job.id)) {
      cancelPendingJobId = null;
    }
    currentJobId = null;

    resetTranscodeProgressUI();

    const isWatchMode = !!el.watchMode?.checked;

    // Watch Mode UX: job ended (cancelled) => restore eyes if we're still watching.
    setTranscodeWatchEyesActive(isWatchMode);

    if (!isWatchMode) {
      setCaptionSidecarSettingsLocked(false);
      releaseCaptionSidecarAutoMatchSource();
      setTranscodeControlsDisabled(false);
    } else {
      el.cancelBtn.disabled = false;
    }

    resetTranscodeFields().catch(() => {});
    // No bottom per-file overlay present anymore.
  });

  // ✅ Auto-refresh preset dropdown when presets are saved or deleted
  register('preset-saved', (_e, panelId) => {
    if (panelId === 'transcode') refreshPresetDropdown().catch(() => {});
  });
  register('preset-deleted', (_e, panelId) => {
    if (panelId === 'transcode') refreshPresetDropdown().catch(() => {});
  });

  const teardownTranscodeIpc = () => {
    while (unsubscribers.length) {
      const unsubscribe = unsubscribers.pop();
      try {
        unsubscribe();
      } catch {}
    }
    window[TRANSCODE_IPC_GUARD_KEY] = false;
    window[TRANSCODE_IPC_TEARDOWN_KEY] = null;
  };

  window[TRANSCODE_IPC_TEARDOWN_KEY] = teardownTranscodeIpc;
  window.addEventListener('beforeunload', teardownTranscodeIpc, { once: true });
  return teardownTranscodeIpc;
}

async function refreshPresetDropdown() {
  const hidden = el.presetSelect;
  if (!hidden) return;
  let selectedPresetFile = hidden.value || '';
  let opts = [];
  try {
    const presetDir = ensurePresetDirAvailable();
    if (!presetDir) {
      setupStyledDropdown('transcode-preset', opts);
      setDropdownValue('transcode-preset', '');
      return;
    }
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
      setupStyledDropdown('transcode-preset', opts);
      setDropdownValue('transcode-preset', '');
      return;
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
          ? t('transcodeDefaultPresetLabel', 'Default')
          : f.replace(/\.json$/i, '')
      }));
  } catch (err) {
    setPresetFeaturesEnabled(false);
    warnPresetUnavailable();
    panelLog('error', 'Failed to read transcode presets:', { error: err?.message || err });
  }

  const hasSelectedPreset = !!selectedPresetFile
    && opts.some(opt => String(opt?.value || '') === selectedPresetFile);

  if (!hasSelectedPreset) {
    selectedPresetFile = opts.find(opt => window.panelPresetDefaults?.isDefaultPresetFile?.(opt?.value))?.value || '';
  }

  setupStyledDropdown('transcode-preset', opts);
  enforceLicenseLocks();
  setDropdownValue('transcode-preset', selectedPresetFile);
  hidden.value = selectedPresetFile;
  window.translatePage?.();
  refreshTranscodeDynamicTitles();
  applyTranscodeWatchButtonState(!!el.watchMode?.checked);

  if (!hidden.dataset.listenerBound) {
    hidden.addEventListener('change', async () => {
      const file = hidden.value;
      if (!file) return;
      try {
        const presetDir = ensurePresetDirAvailable();
        if (!presetDir) return;
        const electronApi = window.electron;
        const readText = (typeof electronApi?.readTextFileAsync === 'function')
          ? electronApi.readTextFileAsync.bind(electronApi)
          : async (p, enc) => electronApi.readTextFile(p, enc);

        const raw = await readText(
          electronApi.joinPath(presetDir, file)
        );
        const data = JSON.parse(raw);
        await applyPresetToFields(data, el);
        showTranscodeStatusText(i18nMsg(
          'transcodeLogPresetLoaded',
          '📂 Loaded {{file}}',
          { file }
        ));
        updateSummary(el);
      } catch (err) {
        panelLog('error', 'Failed to load preset', { error: err?.message || err });
      }
    });
    hidden.dataset.listenerBound = 'true';
  }
}

bindTranscodeIpcHandlers();

if (window.panelPresetDefaults && !window.__LEAD_TRANSCODE_PRESET_DEFAULTS_REGISTERED__) {
  window.__LEAD_TRANSCODE_PRESET_DEFAULTS_REGISTERED__ = true;
  window.panelPresetDefaults.register({
    panelId: 'transcode',
    presetInputId: 'transcode-preset',
    refreshDropdown: () => refreshPresetDropdown(),
    applyPackagedDefaults: () => resetTranscodeFields(),
    buildPackagedDefaultPreset: () => buildTranscodePresetPayload(),
    applyPreset: data => applyPresetToFields(data, el)
  });
} else {
  refreshPresetDropdown().catch(() => {});
}

if (typeof module !== 'undefined') {
  module.exports = {
    applyPresetToFields,
    gatherTranscodeConfig,
    isWatchConfigValid,
    getWatchInputCardinalityError,
    initContainerFormats,
    __getTranscodeStatusLogModel: () => transcodeStatusLogModel.map((entry) => ({
      ...entry,
      params: entry?.params && typeof entry.params === 'object' ? { ...entry.params } : entry?.params
    }))
  };
}
})();
