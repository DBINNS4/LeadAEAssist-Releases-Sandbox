// ✅ Shared scope for testing
let el = {};
let logs = [];
const LOG_RENDER_LIMIT = Number.parseInt(window.LOG_VIEWER_RENDER_LIMIT ?? 500, 10) || 500;
// Keep an in-memory retention cap to avoid unbounded log growth, independent of render cap.
const DEFAULT_RETENTION_LIMIT = 5000;
const rawRetention = window.LOG_VIEWER_RETENTION_LIMIT ?? DEFAULT_RETENTION_LIMIT;
const parsedRetention = Number.parseInt(rawRetention, 10);
const LOG_RETENTION_LIMIT = Number.isFinite(parsedRetention) && parsedRetention > 0
  ? parsedRetention
  : Infinity; // Allow unlimited retention via 0/negative/NaN.
let expanded = false;
let _userInteracted = false;
let logViewerInitialized = false;
let renderTimeout = null;
let wrapLinesPreferred = false;
let syncExpandUi = () => {};
let isLoadingLogs = false;
let hasLoadedLogs = false;
let loadLogsPromise = null;
let searchDebounceTimeout = null;
let pinnedToBottom = true;
let initialAutoScrollDone = false;
let logViewerI18nRefreshBound = false;
let logViewerI18nBindTimer = null;
let exportFormatI18nBindTimer = null;

function isNearBottom(container, threshold = 32) {
  if (!container) return true;
  const client = container.clientHeight || 0;
  const scrollHeight = container.scrollHeight || 0;
  const scrollTop = container.scrollTop || 0;
  // In JSDOM clientHeight can be 0; treat that as "no scroll".
  if (client <= 0) return true;
  return (scrollHeight - scrollTop - client) <= threshold;
}

function scrollToBottom(container) {
  if (!container) return;
  container.scrollTop = container.scrollHeight;
}

function buildSearchBlob(log) {
  if (!log || typeof log !== 'object') return '';
  if (log.__searchDirty || typeof log.__search !== 'string') {
    const snapshot = { ...log };
    delete snapshot.__search;
    delete snapshot.__searchDirty;
    const safeStringify = (value) => {
      const seen = new WeakSet();
      return JSON.stringify(value, (key, val) => {
        if (key === '__search' || key === '__searchDirty') return undefined;
        if (typeof val === 'bigint') return val.toString();
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      });
    };
    const buildFallbackSnapshot = (entry) => {
      const meta = entry?.meta;
      let metaSummary = meta;
      if (meta && typeof meta === 'object') {
        if (Array.isArray(meta)) {
          metaSummary = { type: 'array', length: meta.length };
        } else {
          metaSummary = {
            type: 'object',
            keys: Object.keys(meta).filter(key => key !== '__search' && key !== '__searchDirty'),
          };
        }
      }
      return {
        timestamp: entry?.timestamp,
        type: entry?.type,
        status: entry?.status,
        message: entry?.message,
        detail: entry?.detail,
        panel: entry?.panel,
        jobId: entry?.jobId,
        stage: entry?.stage,
        meta: metaSummary,
      };
    };
    try {
      log.__search = safeStringify(snapshot).toLowerCase();
    } catch {
      const fallbackSnapshot = buildFallbackSnapshot(log);
      log.__search = safeStringify(fallbackSnapshot).toLowerCase();
    }
    log.__searchDirty = false;
  }
  return log.__search;
}

function invalidateSearchBlob(log) {
  if (!log || typeof log !== 'object') return;
  log.__searchDirty = true;
}

function rebuildSearchCache(targetLogs) {
  if (!Array.isArray(targetLogs)) return;
  targetLogs.forEach(log => {
    invalidateSearchBlob(log);
    buildSearchBlob(log);
  });
}

function appendLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return;
  invalidateSearchBlob(entry);
  buildSearchBlob(entry);
  logs.push(entry);
}

function initLogViewer() {
  if (logViewerInitialized) return;
  logViewerInitialized = true;

  console.log("✅ renderer.log-viewer.js loaded");

  const ipcBridge = typeof ipc === 'undefined' ? window.ipc ?? window.electron : ipc;

  const translate = (key, fallback) => {
    const t = window.i18n?.t;
    if (typeof t === "function") {
      const translated = t(key);
      if (translated) return translated;
    }
    return fallback;
  };

  const getLocalizedLevelLabel = (level) => {
    const normalized = String(level || 'info').trim().toLowerCase();
    const levelByKey = {
      info: translate('logViewerLevelInfo', 'INFO'),
      warn: translate('logViewerLevelWarning', 'WARNING'),
      warning: translate('logViewerLevelWarning', 'WARNING'),
      error: translate('logViewerLevelError', 'ERROR'),
      debug: translate('logViewerLevelDebug', 'DEBUG')
    };
    return levelByKey[normalized] || normalized.toUpperCase();
  };

  const withLimit = (text) => (typeof text === 'string'
    ? text.replace(/{{limit}}/g, LOG_RENDER_LIMIT)
    : text);
  const panelLabelKeyByCanonicalPanel = {
    ingest: ['logViewerToolIngest', 'Ingest'],
    transcode: ['logViewerToolTranscode', 'Transcode'],
    clone: ['logViewerToolClone', 'Clone'],
    'project-organizer': ['logViewerToolOrganizer', 'Organizer'],
    transcribe: ['logViewerToolTranscribe', 'Transcribe'],
    'adobe-utilities': ['logViewerToolAdobeUtilities', 'Adobe Utilities'],
    'nle-utilities': ['logViewerToolNleUtilities', 'NLE Utilities'],
    'speed-test': ['logViewerToolSpeedTest', 'Speed Test'],
    comparison: ['logViewerToolComparison', 'Comparison'],
    resolution: ['logViewerToolResolution', 'Resolution'],
    system: ['logViewerToolSystem', 'System']
  };

  const panelAliasToCanonicalPanel = {
    ingest: 'ingest',
    transcode: 'transcode',
    clone: 'clone',
    'project-organizer': 'project-organizer',
    projectorganizer: 'project-organizer',
    organizer: 'project-organizer',
    'project-organiser': 'project-organizer',
    projectorganiser: 'project-organizer',
    transcribe: 'transcribe',
    'adobe-utilities': 'adobe-utilities',
    adobeutilities: 'adobe-utilities',
    adobe: 'adobe-utilities',
    'nle-utilities': 'nle-utilities',
    nleutilities: 'nle-utilities',
    nle: 'nle-utilities',
    'speed-test': 'speed-test',
    speedtest: 'speed-test',
    comparison: 'comparison',
    resolution: 'resolution',
    system: 'system'
  };

  const getLocalizedPanelLabel = (panelOrType) => {
    const raw = panelOrType == null ? '' : String(panelOrType).trim();
    if (!raw) return translate('logViewerUnknownPanel', 'Unknown panel');

    const slug = raw.toLowerCase().replace(/[\s_]+/g, '-');
    const compact = raw.toLowerCase().replace(/[\s_-]+/g, '');
    const canonical = panelAliasToCanonicalPanel[slug]
      || panelAliasToCanonicalPanel[compact]
      || null;

    if (!canonical) return raw;

    const [key, fallback] = panelLabelKeyByCanonicalPanel[canonical] || [];
    if (!key) return raw;
    return translate(key, fallback);
  };

  // ─── Log Viewer: panel overview tooltip ───────────────────────────────────
  const overviewTooltip = document.getElementById('log-viewer-overview-tooltip');
  const renderOverviewTooltip = () => {
    if (!overviewTooltip) return;
    overviewTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">${translate('logViewerOverviewTooltipHeader', 'LOG VIEWER — Technical Overview')}</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('logViewerOverviewSectionCoreCapabilities', 'Core capabilities')}</span>
          <ul class="tooltip-list">
            <li>${translate('logViewerOverviewCoreBullet1', 'Aggregates ingest, transcode, automation, NLE utility, and system logs in one place.')}</li>
            <li>${translate('logViewerOverviewCoreBullet2', 'Filters by date range, tool, severity, and free-text search.')}</li>
            <li>${translate('logViewerOverviewCoreBullet3', 'Exports filtered views to TXT/JSON/CSV for support, QC, or documentation.')}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('logViewerOverviewSectionInputsOutputs', 'Inputs / outputs')}</span>
          <ul class="tooltip-list">
            <li>${translate('logViewerOverviewIoBullet1', 'Inputs: rolling log files emitted by the Assist backend and panels.')}</li>
            <li>${translate('logViewerOverviewIoBullet2', 'Outputs: on-screen filtered view plus optional export files on disk.')}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('logViewerOverviewSectionUnderTheHood', 'Under the hood')}</span>
          <ul class="tooltip-list">
            <li>${translate('logViewerOverviewHoodBullet1', 'Reads log files from the app’s log directory and keeps an in-memory retention window.')}</li>
            <li>${translate('logViewerOverviewHoodBullet2', 'Normalizes messages by panel / type so filters behave consistently across tools.')}</li>
            <li>${translate('logViewerOverviewHoodBullet3', 'Export uses the same filtered set that is rendered, not the entire archive.')}</li>
          </ul>
        </div>
      </div>
    `;
  };

  if (overviewTooltip && !overviewTooltip.dataset.bound) {
    renderOverviewTooltip();
    overviewTooltip.dataset.bound = 'true';
  }

  const bindOverviewTooltipI18nRefresh = () => {
    if (!overviewTooltip || overviewTooltip.dataset.i18nBound === 'true') return;

    const attach = () => {
      const i18n = window.i18n;
      if (!i18n?.on) return false;
      try {
        i18n.on('languageChanged', renderOverviewTooltip);
        i18n.on('initialized', renderOverviewTooltip);
        i18n.on('loaded', renderOverviewTooltip);
      } catch {
        return false;
      }
      if (i18n.isInitialized) {
        renderOverviewTooltip();
      }
      overviewTooltip.dataset.i18nBound = 'true';
      return true;
    };

    if (attach()) return;

    let tries = 0;
    const maxTries = 50;
    const timer = setInterval(() => {
      tries += 1;
      if (attach() || tries >= maxTries) {
        clearInterval(timer);
      }
    }, 100);
  };

  bindOverviewTooltipI18nRefresh();

  el = {
    dateFilter: document.getElementById("view-by-date"),
    startDate: document.getElementById("log-start-date"),
    endDate: document.getElementById("log-end-date"),
    toolFilter: document.getElementById("view-by-tool"),
    errorOnly: document.getElementById("show-errors-only"),
    systemLogs: document.getElementById("include-system-logs"),
    searchInput: document.getElementById("log-search"),
    expandBtn: document.getElementById("expand-task-details"),
    logView: document.getElementById("live-log-view"),
    exportFormat: document.getElementById("export-format"),
    exportBtn: document.getElementById("export-log-btn"),
    exportPathInput: document.getElementById("export-folder-path"),
    selectExportBtn: document.getElementById("select-export-folder"),
    toast: document.getElementById("log-toast"),
    resetBtn: document.getElementById("reset-log-viewer"),
    openLogFolderBtn: document.getElementById("open-log-folder")
  };

  // Track whether the user is "following" the latest logs.
  if (el.logView && !el.logView.dataset.boundScrollTracking) {
    el.logView.addEventListener('scroll', () => {
      pinnedToBottom = isNearBottom(el.logView);
      if (pinnedToBottom) initialAutoScrollDone = true;
    }, { passive: true });
    el.logView.dataset.boundScrollTracking = 'true';
  }

  const buildDateFilterOptions = () => ([
    { value: 'today', label: translate('logViewerDateToday', 'Today') },
    { value: '7days', label: translate('logViewerDateLast7Days', 'Last 7 Days') },
    { value: 'custom', label: translate('logViewerDateCustomRange', 'Custom Range') }
  ]);

  const refreshDateFilterLabels = () => {
    const selectedValue = el.dateFilter?.value || 'today';
    const localizedDateOpts = buildDateFilterOptions();
    setupStyledDropdown('view-by-date', localizedDateOpts);
    setDropdownValue('view-by-date', selectedValue);
    updateDateVisibility();
  };

  const buildToolFilterOptions = () => ([
    { value: 'all', label: translate('logViewerToolAll', 'All') },
    { value: 'ingest', label: translate('logViewerToolIngest', 'Ingest') },
    { value: 'transcode', label: translate('logViewerToolTranscode', 'Transcode') },
    { value: 'clone', label: translate('logViewerToolClone', 'Clone') },
    { value: 'project-organizer', label: translate('logViewerToolOrganizer', 'Organizer') },
    { value: 'transcribe', label: translate('logViewerToolTranscribe', 'Transcribe') },
    { value: 'adobe-utilities', label: translate('logViewerToolAdobeUtilities', 'Adobe Utilities') },
    { value: 'nle-utilities', label: translate('logViewerToolNleUtilities', 'NLE Utilities') },
    { value: 'speed-test', label: translate('logViewerToolSpeedTest', 'Speed Test') },
    { value: 'system', label: translate('logViewerToolSystem', 'System') }
  ]);

  const normalizeToolFilterValue = (value) => {
    const selected = value == null ? '' : String(value);
    return buildToolFilterOptions().some(opt => opt.value === selected)
      ? selected
      : 'all';
  };

  const refreshToolFilterLabels = () => {
    const selectedValue = normalizeToolFilterValue(el.toolFilter?.value || 'all');
    setupStyledDropdown('view-by-tool', buildToolFilterOptions());
    setDropdownValue('view-by-tool', selectedValue);
  };

  const buildExportFormatOptions = () => ([
    { value: 'txt', label: translate('logViewerExportTxt', 'TXT') },
    { value: 'json', label: translate('logViewerExportJson', 'JSON') },
    { value: 'csv', label: translate('logViewerExportCsv', 'CSV') }
  ]);

  const refreshExportFormatLabels = () => {
    const selectedValue = el.exportFormat?.value || 'txt';
    const localizedOptions = [
      { value: 'txt', label: translate('logViewerExportTxt', 'TXT') },
      { value: 'json', label: translate('logViewerExportJson', 'JSON') },
      { value: 'csv', label: translate('logViewerExportCsv', 'CSV') }
    ];
    setupStyledDropdown('export-format', localizedOptions);
    setDropdownValue('export-format', selectedValue);
  };

  const bindExportFormatI18nRefresh = () => {
    if (!el.exportFormat || el.exportFormat.dataset.i18nBound === 'true') return;

    const attach = () => {
      const i18n = window.i18n;
      if (!i18n?.on) return false;
      try {
        i18n.on('languageChanged', refreshExportFormatLabels);
        i18n.on('initialized', refreshExportFormatLabels);
        i18n.on('loaded', refreshExportFormatLabels);
      } catch {
        return false;
      }

      el.exportFormat.dataset.i18nBound = 'true';
      if (i18n.isInitialized) {
        refreshExportFormatLabels();
      }
      if (exportFormatI18nBindTimer) {
        clearInterval(exportFormatI18nBindTimer);
        exportFormatI18nBindTimer = null;
      }
      return true;
    };

    if (attach()) return;
    if (exportFormatI18nBindTimer) return;

    let tries = 0;
    const maxTries = 50;
    exportFormatI18nBindTimer = setInterval(() => {
      tries += 1;
      if (attach() || tries >= maxTries) {
        clearInterval(exportFormatI18nBindTimer);
        exportFormatI18nBindTimer = null;
      }
    }, 100);
  };

  const refreshLogViewerI18n = () => {
    refreshDateFilterLabels();
    refreshToolFilterLabels();
    refreshExportFormatLabels();
    if (typeof syncExpandUi === 'function') syncExpandUi();
    renderLogs();
  };

  const bindLogViewerI18nRefresh = () => {
    if (logViewerI18nRefreshBound || el.logView?.dataset.i18nBound === 'true') return;

    const attach = () => {
      const i18n = window.i18n;
      if (!i18n?.on) return false;
      try {
        i18n.on('languageChanged', refreshLogViewerI18n);
        i18n.on('initialized', refreshLogViewerI18n);
        i18n.on('loaded', refreshLogViewerI18n);
      } catch {
        return false;
      }

      if (i18n.isInitialized) {
        refreshLogViewerI18n();
      }

      logViewerI18nRefreshBound = true;
      if (el.logView) {
        el.logView.dataset.i18nBound = 'true';
      }
      if (logViewerI18nBindTimer) {
        clearInterval(logViewerI18nBindTimer);
        logViewerI18nBindTimer = null;
      }
      return true;
    };

    if (attach()) return;
    if (logViewerI18nBindTimer) return;

    let tries = 0;
    const maxTries = 50;
    logViewerI18nBindTimer = setInterval(() => {
      tries += 1;
      if (attach() || tries >= maxTries) {
        clearInterval(logViewerI18nBindTimer);
        logViewerI18nBindTimer = null;
      }
    }, 100);
  };

  setupStyledDropdown('view-by-date', buildDateFilterOptions());
  setDropdownValue('view-by-date', el.dateFilter?.value || 'today');

  setupStyledDropdown('view-by-tool', buildToolFilterOptions());
  setDropdownValue('view-by-tool', normalizeToolFilterValue(el.toolFilter?.value || 'all'));

  setupStyledDropdown('export-format', buildExportFormatOptions());
  setDropdownValue('export-format', el.exportFormat?.value || 'txt');
  bindExportFormatI18nRefresh();
  bindLogViewerI18nRefresh();


  async function loadLogsFromDisk() {
    if (isLoadingLogs && loadLogsPromise) return loadLogsPromise;

    isLoadingLogs = true;
    renderLogs();

    try {
      const logDir = window.electron.resolvePath('logs');
      const loader = ipcBridge?.invoke
        ? ipcBridge.invoke('log-viewer:read-log-files', logDir)
        : Promise.resolve(window.electron.readLogFiles(logDir));

      loadLogsPromise = loader;
      const past = await loader;
      logs = Array.isArray(past) ? past : [];
      enforceRetentionLimit();
      rebuildSearchCache(logs);
      hasLoadedLogs = true;
    } catch (err) {
      console.error("❌ Failed to load archived logs:", err);
    } finally {
      isLoadingLogs = false;
      loadLogsPromise = null;
      renderLogs();
    }

    return logs;
  }

  function enforceRetentionLimit() {
    if (!Number.isFinite(LOG_RETENTION_LIMIT)) return;
    const excess = logs.length - LOG_RETENTION_LIMIT;
    if (excess > 0) {
      sortLogsByTimestamp();
      logs.splice(LOG_RETENTION_LIMIT);
    }
  }

  function sortLogsByTimestamp() {
    logs.sort((a, b) => (b?.timestamp ?? 0) - (a?.timestamp ?? 0));
  }

  function showToast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    if (showToast._timer) clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.toast.classList.remove("show"), 2000);
  }



  function mapOpenLogFolderErrorCodeToToastKey(errorCode) {
    switch (errorCode) {
      case 'LOG_VIEWER_DIR_OUTSIDE_LOGS':
        return 'logViewerOpenLogFolderOutsideLogs';
      case 'LOG_VIEWER_OPEN_PATH_FAILED':
        return 'logViewerOpenLogFolderUnavailable';
      default:
        return 'logViewerOpenLogFolderFailed';
    }
  }

  async function openLogFolder() {
    const logDir = window.electron.resolvePath('logs');
    try {
      const result = window.electron.openLogFolder
        ? await window.electron.openLogFolder(logDir)
        : await ipcBridge.invoke('log-viewer:open-log-folder', logDir);
      if (!result?.ok) {
        const errorCode = result?.errorCode;
        const toastKey = mapOpenLogFolderErrorCodeToToastKey(errorCode);
        showToast(translate(toastKey, translate('logViewerOpenLogFolderFailed', 'Unable to open log folder')));
        if (errorCode) {
          console.warn('⚠️ Unable to open log folder', { errorCode });
        }
      }
    } catch (err) {
      showToast(translate('logViewerOpenLogFolderFailed', 'Unable to open log folder'));
      console.error('❌ Failed to open log folder:', err);
    }
  }
  function isDevUiEnabled() {
    return (window.electron?.isPackaged === false)
      || (window.electron?.DEBUG_UI === true)
      || (window.DEBUG_UI === true);
  }

  const debugUiEnabled = isDevUiEnabled();

  function showInitMessage() {
    if (!el.logView) return;
    el.logView.textContent = '';
    const initP = document.createElement('p');
    initP.style.color = 'green';
    initP.textContent = translate('logViewerInitialized', '🧪 Log Viewer Initialized');
    el.logView.appendChild(initP);
  }

  if (debugUiEnabled) {
    showInitMessage();
  }

  loadLogsFromDisk();


  function getFilteredLogs() {
    const tool = el.toolFilter.value;
    const showErrorsOnly = el.errorOnly.checked;
    const searchText = el.searchInput.value.toLowerCase();
    const includeSystem = el.systemLogs.checked || tool === 'system';
    const dateRange = el.dateFilter.value;
    const now = Date.now();
    const startDateVal = el.startDate?.value;
    const endDateVal = el.endDate?.value;
    const parseDate = (d, end) => {
      const ts = Date.parse(d + (end ? 'T23:59:59.999' : 'T00:00:00'));
      return Number.isNaN(ts) ? null : ts;
    };
    const startDate = startDateVal ? parseDate(startDateVal, false) : null;
    const endDate = endDateVal ? parseDate(endDateVal, true) : null;

    sortLogsByTimestamp();
    let filtered = logs.filter(log => {
      if (!includeSystem && log.type === 'system' && tool !== 'system') return false;
      if (tool !== "all" && log.type !== tool) return false;
      if (showErrorsOnly && log.status !== "error" && log.status !== "warning") return false;

      // Hide debug-level entries from non-DEV users.
      if (!debugUiEnabled && String(log.level || '').toLowerCase() === 'debug') return false;

      if (dateRange === 'today') {
        const logDate = new Date(log.timestamp);
        if (logDate.toDateString() !== new Date().toDateString()) return false;
      } else if (dateRange === '7days') {
        if (now - log.timestamp > 7 * 24 * 60 * 60 * 1000) return false;
      } else if (dateRange === 'custom') {
        if (startDate && log.timestamp < startDate) return false;
        if (endDate && log.timestamp > endDate) return false;
      }

      return true;
    });

    if (searchText) {
      filtered = filtered.filter(log =>
        buildSearchBlob(log).includes(searchText)
      );
    }

    sortLogsByTimestamp();
    return filtered;
  }

  function renderLogs() {
    console.log("🔁 renderLogs called");

    const container = el.logView || document.getElementById('live-log-view');
    if (!container) return;

    // Capture scroll state *before* we mutate the DOM.
    const wasPinned = pinnedToBottom || isNearBottom(container);
    const prevScrollTop = container.scrollTop || 0;

    if (isLoadingLogs) {
      container.textContent = translate('logViewerLoading', '⏳ Loading logs…');
      return;
    }

    if (!hasLoadedLogs && logs.length === 0) {
      container.textContent = translate('logViewerEmpty', '📭 No logs yet.');
      return;
    }

    const filtered = getFilteredLogs();
    // getFilteredLogs() is newest-first. Render oldest-to-newest so the newest ends up at the bottom.
    const windowed = LOG_RENDER_LIMIT > 0 ? filtered.slice(0, LOG_RENDER_LIMIT) : filtered;
    const renderLimited = windowed.slice().reverse();

    container.textContent = '';
    if (renderLimited.length) {
      const frag = document.createDocumentFragment();

      // If we're truncating, put the notice at the *top* so the newest log stays at the bottom.
      if (filtered.length > windowed.length) {
        const notice = document.createElement('div');
        notice.className = 'log-entry log-info';
        const limitText = translate(
          'logViewerRenderLimited',
          'Showing newest {{limit}} results on screen. Export uses your full filtered set.'
        );
        notice.textContent = withLimit(limitText);
        container.appendChild(notice);
      }

      renderLimited.forEach(log => {
        frag.appendChild(createLogLineElement(log));
      });
      container.appendChild(frag);
    } else {
      container.textContent = translate('logViewerNoResults', '📭 No logs found.');
    }

    // Auto-follow the tail unless the user scrolled up.
    const applyScroll = () => {
      if (!container) return;

      if (!initialAutoScrollDone && hasLoadedLogs) {
        scrollToBottom(container);
        pinnedToBottom = true;
        initialAutoScrollDone = true;
        return;
      }

      if (wasPinned) {
        scrollToBottom(container);
        pinnedToBottom = true;
      } else {
        // Preserve the user's scroll position when they're reviewing older logs.
        const maxTop = Math.max(0, (container.scrollHeight || 0) - (container.clientHeight || 0));
        container.scrollTop = Math.min(prevScrollTop, maxTop);
        pinnedToBottom = isNearBottom(container);
      }
    };

    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applyScroll);
    else setTimeout(applyScroll, 0);
  }

  function formatLogLine(log) {
    const tsRaw = log.timestamp;
    const ts = typeof tsRaw === 'number'
      ? tsRaw
      : typeof tsRaw === 'string'
        ? (Number.isFinite(Date.parse(tsRaw)) ? Date.parse(tsRaw) : Date.now())
        : Date.now();
    const date = ts ? new Date(ts).toLocaleString() : '';

    const panel = getLocalizedPanelLabel(log.panel || log.type);
    const jobId = (log.jobId != null && String(log.jobId).trim()) ? String(log.jobId).trim() : '—';
    const stage = (log.stage != null && String(log.stage).trim()) ? String(log.stage).trim() : '—';

    const derivedLevel = log.level
      ? String(log.level)
      : (log.status === 'error' ? 'error' : log.status === 'warning' ? 'warn' : 'info');
    const level = getLocalizedLevelLabel(derivedLevel);

    const parts = [date, panel, jobId, stage, level].map(p => `[${p}]`);
    const summary = `${parts.join(' ')} ${log.message ?? ''}`;
    if (expanded && debugUiEnabled && (log.detail || log.meta)) {
      const metaStr = log.detail || JSON.stringify(log.meta || {});
      return `${summary}<br>→ ${metaStr}`;
    }
    return summary;
  }

  function getNonEmptyJobId(jobId) {
    if (jobId == null) return '';
    const normalized = String(jobId).trim();
    return normalized ? normalized : '';
  }

  function getSingleJobId(entries) {
    const jobIds = new Set();
    entries.forEach(entry => {
      const id = getNonEmptyJobId(entry?.jobId);
      if (!id) return;
      jobIds.add(id);
    });
    if (jobIds.size !== 1) return '';
    return [...jobIds][0];
  }

  function extractPanelName(entries) {
    for (const entry of entries) {
      const panel = entry?.panel || entry?.type;
      if (panel) return String(panel);
    }
    return '';
  }

  function sanitizeRawFilePart(value) {
    return String(value ?? '')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  function sanitizeFilePart(value) {
    const sanitized = sanitizeRawFilePart(value);
    if (sanitized) return sanitized;
    return sanitizeRawFilePart(translate('logViewerFilenameFallbackBase', 'log-viewer')) || 'log-viewer';
  }

  function formatDateForFile(ts) {
    const date = new Date(ts);
    const pad = (value) => String(value).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join('') + '_' + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join('');
  }

  function buildJobReportTxt(entries, singleJobId) {
    const jobEntries = entries.filter(entry => getNonEmptyJobId(entry?.jobId) === singleJobId);
    const unknownToken = translate('logViewerJobReportUnknownValue', 'Unknown');

    if (!jobEntries.length) {
      return [translate('logViewerJobReportEmptyState', 'No log entries found for this job.')];
    }

    const isPlainObject = value => value && typeof value === 'object' && !Array.isArray(value);

    const hasStructuredValue = (value) => {
      if (value == null) return false;
      if (Array.isArray(value)) return value.some(hasStructuredValue);
      if (isPlainObject(value)) return Object.values(value).some(hasStructuredValue);
      return String(value).trim() !== '';
    };

    const appendKeyValueSection = (lines, title, data) => {
      if (!hasStructuredValue(data)) return;

      const pushScalar = (prefix, value) => {
        if (value == null) return;
        const str = String(value).trim();
        if (!str) return;
        lines.push(`${prefix}${str}`);
      };

      if (Array.isArray(data)) {
        lines.push(`${title}:`);
        data
          .map(item => String(item ?? '').trim())
          .filter(Boolean)
          .forEach(item => lines.push(`  - ${item}`));
        return;
      }

      if (isPlainObject(data)) {
        lines.push(`${title}:`);
        Object.keys(data).sort().forEach(key => {
          const value = data[key];
          if (!hasStructuredValue(value)) return;

          if (Array.isArray(value)) {
            lines.push(`  - ${key}:`);
            value
              .map(item => String(item ?? '').trim())
              .filter(Boolean)
              .forEach(item => lines.push(`      • ${item}`));
            return;
          }

          if (isPlainObject(value)) {
            lines.push(`  - ${key}:`);
            Object.keys(value).sort().forEach(subKey => {
              const subValue = value[subKey];
              if (!hasStructuredValue(subValue)) return;
              lines.push(`      • ${subKey}: ${String(subValue)}`);
            });
            return;
          }

          pushScalar(`  - ${key}: `, value);
        });
        return;
      }

      pushScalar(`${title}: `, data);
    };

    const getEntryTs = (entry) => {
      const raw = entry?.timestamp;
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    };

    const deriveLevel = (entry) => {
      const raw = entry?.level || (entry?.status === 'error' ? 'error' : entry?.status === 'warning' ? 'warn' : 'info');
      return String(raw || 'info').toLowerCase();
    };

    const deriveOutcome = (list) => {
      const latestStage = [...list]
        .reverse()
        .map(item => item?.stage != null ? String(item.stage).toLowerCase() : '')
        .find(Boolean) || '';

      if (latestStage.includes('cancel')) return 'cancelled';
      if (latestStage.includes('error') || latestStage.includes('fail')) return 'error';
      if (latestStage.includes('complete') || latestStage.includes('done') || latestStage.includes('success')) return 'complete';

      if (list.some(item => deriveLevel(item) === 'error')) return 'error';
      return 'unknown';
    };

    const formatDuration = (ms) => {
      const total = Math.max(0, Number(ms) || 0);
      const sec = Math.floor(total / 1000);
      const s = sec % 60;
      const min = Math.floor(sec / 60) % 60;
      const hr = Math.floor(sec / 3600);
      const hoursToken = translate('logViewerDurationHoursShort', 'h');
      const minutesToken = translate('logViewerDurationMinutesShort', 'm');
      const secondsToken = translate('logViewerDurationSecondsShort', 's');
      if (hr > 0) return `${hr}${hoursToken} ${min}${minutesToken} ${s}${secondsToken}`;
      if (min > 0) return `${min}${minutesToken} ${s}${secondsToken}`;
      return `${s}${secondsToken}`;
    };

    const pickReportSection = (sectionName) => {
      for (let i = jobEntries.length - 1; i >= 0; i -= 1) {
        const meta = jobEntries[i]?.meta;
        if (!isPlainObject(meta)) continue;
        const section = meta?.[sectionName];
        if (hasStructuredValue(section)) return section;
      }
      return null;
    };

    const panel = extractPanelName(jobEntries);
    const timestamps = jobEntries
      .map(entry => getEntryTs(entry))
      .filter(ts => ts != null);
    const startTs = timestamps.length ? Math.min(...timestamps) : null;
    const endTs = timestamps.length ? Math.max(...timestamps) : null;
    const startLocal = startTs != null ? new Date(startTs).toLocaleString() : unknownToken;
    const endLocal = endTs != null ? new Date(endTs).toLocaleString() : unknownToken;
    const duration = (startTs != null && endTs != null) ? formatDuration(endTs - startTs) : unknownToken;
    const outcome = deriveOutcome(jobEntries);
    const outcomeTextByKey = {
      cancelled: translate('logViewerJobReportOutcomeCancelled', 'cancelled'),
      error: translate('logViewerJobReportOutcomeError', 'error'),
      complete: translate('logViewerJobReportOutcomeComplete', 'complete'),
      unknown: translate('logViewerJobReportOutcomeUnknown', 'unknown')
    };
    const outcomeLabel = outcomeTextByKey[outcome] || unknownToken;

    const levelSummary = jobEntries.reduce((acc, entry) => {
      const level = deriveLevel(entry);
      if (level === 'error') acc.errors += 1;
      else if (level === 'warn' || level === 'warning') acc.warnings += 1;
      return acc;
    }, { warnings: 0, errors: 0 });

    const lines = [
      translate('logViewerJobReportTitle', 'LEAD AE ASSIST — Job Report'),
      `${translate('logViewerJobReportHeaderPanel', 'Panel')}: ${panel || unknownToken}`,
      `${translate('logViewerJobReportHeaderJobId', 'Job ID')}: ${singleJobId || unknownToken}`,
      `${translate('logViewerJobReportHeaderOutcome', 'Outcome')}: ${outcomeLabel}`,
      `${translate('logViewerJobReportHeaderStart', 'Start')}: ${startLocal}`,
      `${translate('logViewerJobReportHeaderEnd', 'End')}: ${endLocal}`,
      `${translate('logViewerJobReportHeaderDuration', 'Duration')}: ${duration}`,
      `${translate('logViewerJobReportHeaderWarnings', 'Warnings')}: ${levelSummary.warnings}`,
      `${translate('logViewerJobReportHeaderErrors', 'Errors')}: ${levelSummary.errors}`,
      ''
    ];

    appendKeyValueSection(lines, translate('logViewerJobReportSectionInputs', 'Inputs'), pickReportSection('inputs'));
    appendKeyValueSection(lines, translate('logViewerJobReportSectionOutputs', 'Outputs'), pickReportSection('outputs'));
    appendKeyValueSection(lines, translate('logViewerJobReportSectionSettings', 'Settings'), pickReportSection('settings'));
    appendKeyValueSection(lines, translate('logViewerJobReportSectionStats', 'Stats'), pickReportSection('stats'));

    if (lines[lines.length - 1] !== '') lines.push('');

    const stageGroups = new Map();
    jobEntries.forEach(entry => {
      const stage = entry?.stage ? String(entry.stage) : '';
      if (!stageGroups.has(stage)) stageGroups.set(stage, []);
      stageGroups.get(stage).push(entry);
    });

    const sortedStages = [...stageGroups.entries()].sort(([a], [b]) => {
      const sa = a.toLowerCase();
      const sb = b.toLowerCase();
      if (sa !== sb) {
        if (!sa) return 1;
        if (!sb) return -1;
        return sa.localeCompare(sb);
      }
      return 0;
    });

    sortedStages.forEach(([stage, stageEntries]) => {
      const stageLabel = stage || translate('logViewerJobReportStageFallback', 'Unspecified stage');
      lines.push(`${translate('logViewerJobReportStageLabel', 'Stage')}: ${stageLabel}`);
      const sortedEntries = [...stageEntries].sort((a, b) => (a?.timestamp ?? 0) - (b?.timestamp ?? 0));
      sortedEntries.forEach(entry => {
        lines.push(formatLogLine(entry).replace(/<br>/g, '\n'));
      });
      lines.push('');
    });

    return lines;
  }

  function createLogLineElement(log) {
    const lineEl = document.createElement('div');

    const tsRaw = log.timestamp;
    const ts = typeof tsRaw === 'number'
      ? tsRaw
      : typeof tsRaw === 'string'
        ? (Number.isFinite(Date.parse(tsRaw)) ? Date.parse(tsRaw) : Date.now())
        : Date.now();
    const date = ts ? new Date(ts).toLocaleString() : '';

    const panel = getLocalizedPanelLabel(log.panel || log.type);
    const jobId = (log.jobId != null && String(log.jobId).trim()) ? String(log.jobId).trim() : '—';
    const stage = (log.stage != null && String(log.stage).trim()) ? String(log.stage).trim() : '—';

    const derivedLevel = log.level
      ? String(log.level)
      : (log.status === 'error' ? 'error' : log.status === 'warning' ? 'warn' : 'info');
    const level = String(derivedLevel || 'info').toLowerCase();

    const parts = [date, panel, jobId, stage, getLocalizedLevelLabel(level)].map(p => `[${p}]`);
    lineEl.className = `log-entry log-${level}`;
    lineEl.textContent = `${parts.join(' ')} ${log.message ?? ''}`;
    if (expanded && debugUiEnabled && (log.detail || log.meta)) {
      lineEl.appendChild(document.createElement('br'));
      const detailEl = document.createElement('span');
      detailEl.textContent = '→ ' + (log.detail || JSON.stringify(log.meta || {}));
      lineEl.appendChild(detailEl);
    }
    return lineEl;
  }

  function scheduleRender() {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => {
      renderTimeout = null;
      renderLogs();
    }, 100);
  }

  function scheduleSearchRender() {
    if (searchDebounceTimeout) clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => {
      searchDebounceTimeout = null;
      renderLogs();
    }, 200);
  }

  async function writeLogToFile(lines, targetPath) {
    try {
      const payload = lines.join('\n');
      const fsApi = (typeof window !== 'undefined') ? (window.electron ?? ipcBridge) : null;
      if (typeof fsApi?.writeTextFileAsync === 'function') {
        await fsApi.writeTextFileAsync(targetPath, payload);
      } else if (typeof fsApi?.writeTextFile === 'function') {
        fsApi.writeTextFile(targetPath, payload);
      } else {
        throw new Error('Electron file APIs unavailable');
      }
      return true;
    } catch (err) {
      console.error('❌ Failed to write log file', err);
      return false;
    }
  }

  async function exportLog() {
    const exportDir = el.exportPathInput.value;
    if (!exportDir) {
      showToast(translate('logViewerSelectExportFolder', 'Please select export folder'));
      el.exportPathInput?.focus();
      el.exportPathInput?.select?.();
      return;
    }

    const format = el.exportFormat.value;
    const logsBaseName = sanitizeFilePart(translate('logViewerFilenameLogsBase', 'logs'));
    const jobReportBaseName = sanitizeFilePart(translate('logViewerFilenameJobReportBase', 'job-report'));
    let fileName = `${logsBaseName}.${format}`;
    let contentLines = [];
    const filtered = getFilteredLogs();
    const chronological = filtered.slice().reverse();
    const singleJobId = getSingleJobId(filtered);

    if (format === 'json') {
      const exportEntries = chronological.map(entry => {
        if (!entry || typeof entry !== 'object') {
          return entry;
        }
        const { __search, __searchDirty, ...rest } = entry;
        return rest;
      });
      contentLines = [JSON.stringify(exportEntries, null, 2)];
    } else if (format === 'csv') {
      const csvHeader = [
        translate('logViewerCsvHeaderTimestamp', 'timestamp'),
        translate('logViewerCsvHeaderPanel', 'panel'),
        translate('logViewerCsvHeaderType', 'type'),
        translate('logViewerCsvHeaderLevel', 'level'),
        translate('logViewerCsvHeaderJobId', 'jobId'),
        translate('logViewerCsvHeaderStage', 'stage'),
        translate('logViewerCsvHeaderMessage', 'message'),
        translate('logViewerCsvHeaderDetail', 'detail'),
        translate('logViewerCsvHeaderMeta', 'meta'),
        translate('logViewerCsvHeaderStatus', 'status'),
        translate('logViewerCsvHeaderFile', 'file')
      ];

      // Keep all export formats consistent: oldest-to-newest.
      const sorted = chronological;

      const csvLines = sorted.map(l => {
        const metaStrRaw =
          typeof l.meta === 'string'
            ? l.meta
            : (() => {
              try { return l.meta ? JSON.stringify(l.meta) : ''; } catch { return String(l.meta ?? ''); }
            })();
        const metaStr = String(metaStrRaw ?? '').replace(/\r?\n/g, '\\n').slice(0, 5000);

        const values = [
          l.timestamp,
          l.panel || l.type || '',
          l.type || l.panel || '',
          l.level || '',
          l.jobId || '',
          l.stage || '',
          String(l.message ?? '').replace(/\r?\n/g, '\\n'),
          String(l.detail ?? '').replace(/\r?\n/g, '\\n'),
          metaStr,
          l.status || '',
          l.file || ''
        ];

        return values
          .map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"')
          .join(',');
      });

      contentLines = [csvHeader.join(','), ...csvLines];
    } else {
      // txt
      if (singleJobId) {
        const jobEntries = filtered.filter(e => getNonEmptyJobId(e?.jobId) === singleJobId);
        const panel = extractPanelName(jobEntries);
        const startTs = jobEntries.reduce((min, e) => {
          const ts = e?.timestamp ?? Number.POSITIVE_INFINITY;
          return ts < min ? ts : min;
        }, Number.POSITIVE_INFINITY);

        const tsForName = Number.isFinite(startTs) ? startTs : Date.now();

        fileName = `${jobReportBaseName}_${sanitizeFilePart(panel)}_${formatDateForFile(tsForName)}_${sanitizeFilePart(singleJobId)}.txt`;
        contentLines = buildJobReportTxt(filtered, singleJobId);
      } else {
        contentLines = chronological.map(l => formatLogLine(l).replace(/<br>/g, '\n'));
        fileName = `${logsBaseName}.txt`;
      }
    }

    const fullPath = window.electron.joinPath(exportDir, fileName);
    if (await writeLogToFile(contentLines, fullPath)) {
      showToast(translate('logViewerExportSuccess', 'Log exported'));
    } else {
      showToast(translate('logViewerExportFailure', 'Failed to export log'));
    }
  }

function resetLogViewer() {
  // Clear logs and UI
  logs.length = 0;
  expanded = false;

  pinnedToBottom = true;
  initialAutoScrollDone = false;

  _userInteracted = false;
  if (el.dateFilter) {
    el.dateFilter.value = 'today';
    setDropdownValue('view-by-date', 'today');
  }
  if (el.startDate) el.startDate.value = '';
  if (el.endDate) el.endDate.value = '';
  updateDateVisibility();
  if (el.toolFilter) {
    el.toolFilter.value = 'all';
    setDropdownValue('view-by-tool', 'all');
  }
  if (el.errorOnly) el.errorOnly.checked = false;
  if (el.systemLogs) el.systemLogs.checked = false;
  if (el.searchInput) el.searchInput.value = '';
  if (el.exportFormat) {
    el.exportFormat.value = 'txt';
    setDropdownValue('export-format', 'txt');
  }
  if (el.exportPathInput) el.exportPathInput.value = '';

  syncExpandUi();
  loadLogsFromDisk();
  renderLogs();
}

  el.exportBtn?.addEventListener('click', exportLog);
  el.resetBtn?.addEventListener('click', resetLogViewer);
  el.openLogFolderBtn?.addEventListener('click', openLogFolder);

  function initIpcLogs() {
    if (!ipcBridge?.on) return;
    const panels = [
      'ingest',
      'transcode',
      'clone',
      'project-organizer',
      'transcribe',
      'adobe-utilities',
      'nle-utilities',
      'speed-test',
      'comparison',
      'resolution',
      'system'
    ];
    panels.forEach(type => {
      ipcBridge.on(`${type}-log-message`, (_e, data) => {
        const payload = data && typeof data === 'object' ? data : {};
        const level = payload.level || (payload.isWarning ? 'warn' : payload.isError ? 'error' : 'info');

        // Non-DEV users should never see debug-level plumbing.
        if (!debugUiEnabled && String(level).toLowerCase() === 'debug') return;
        const status =
          level === 'error' || payload.isError
            ? 'error'
            : level === 'warn' || payload.isWarning
              ? 'warning'
              : 'info';

        const rawMsg = payload.msg ?? payload.message ?? '';
        let message = rawMsg;

        let jobId = payload.jobId != null ? String(payload.jobId) : '';
        let stage = payload.stage != null ? String(payload.stage) : '';
        let meta =
          (payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta))
            ? payload.meta
            : null;

        // Best-effort parse JSON detail into meta if meta wasn't provided.
        // DEV-only: this can contain internal plumbing that isn't user-facing.
        if (debugUiEnabled && !meta) {
          const d = typeof payload.detail === 'string' ? payload.detail.trim() : '';
          if (d && d.startsWith('{') && d.endsWith('}') && d.length < 10000) {
            try { meta = JSON.parse(d); } catch {}
          }
        }

        // If this looks like createJobLogger output, strip the prefix to avoid duplicate headers.
        if (typeof rawMsg === 'string' && rawMsg.startsWith(`[${type}]`)) {
          const prefixMatch = rawMsg.match(/^(\[[^\]]+\]\s*)+/);
          if (prefixMatch) {
            const prefix = prefixMatch[0];
            const segments = Array.from(prefix.matchAll(/\[([^\]]+)\]/g)).map(m => m[1]);
            if (segments[0] === type && segments.length >= 2) {
              message = rawMsg.slice(prefix.length).trimStart();

              // Populate jobId/stage if they weren't sent explicitly.
              if (!jobId && !stage) {
                if (segments.length >= 3) {
                  jobId = segments[1];
                  stage = segments[2];
                } else if (segments.length === 2) {
                  const seg = segments[1];
                  const looksLikeUuid =
                    typeof seg === 'string' && seg.length >= 24 && /[0-9a-fA-F-]{8,}/.test(seg);
                  if (looksLikeUuid) jobId = seg;
                  else stage = seg;
                }
              } else {
                if (!jobId && segments.length >= 3) jobId = segments[1];
                if (!stage && segments.length >= 3) stage = segments[2];
              }
            }
          }
        }
        let ts = Date.now();
        if (payload.timestamp != null) {
          const num = Number(payload.timestamp);
          if (Number.isFinite(num)) ts = num;
          else {
            const parsed = Date.parse(String(payload.timestamp));
            if (!Number.isNaN(parsed)) ts = parsed;
          }
        }

        appendLogEntry({
          timestamp: ts,
          type,
          panel: payload.panel || type,
          message: message ?? '',
          detail: payload.detail ?? '',
          status,
          level,
          file: payload.fileId || '',
          jobId: jobId || '',
          stage: stage || '',
          meta: meta || undefined
        });
        enforceRetentionLimit();
        scheduleRender();
      });
    });
  }

  el.selectExportBtn?.addEventListener("click", async () => {
    if (!ipcBridge?.selectFolder) {
      showToast(translate('logViewerFolderPickerUnavailable', 'Folder selection unavailable in this environment'));
      return;
    }
    const folder = await ipcBridge?.selectFolder?.();
    if (folder) el.exportPathInput.value = folder;
  });

  if (el.expandBtn && el.logView) {
    wrapLinesPreferred = el.logView.classList.contains("wrap-lines");
    syncExpandUi = () => {
      if (!el.expandBtn || !el.logView) return;
      el.expandBtn.setAttribute("aria-pressed", String(expanded));
      const labelKey = expanded ? "collapseTaskDetails" : "expandTaskDetails";
      el.expandBtn.setAttribute("data-i18n", labelKey);
      el.expandBtn.textContent = translate(
        labelKey,
        expanded ? "Collapse Task Details" : "Expand Task Details"
      );
      el.logView.classList.toggle("wrap-lines", expanded || wrapLinesPreferred);
    };

    syncExpandUi();

    el.expandBtn.addEventListener("click", () => {
      expanded = !expanded;
      syncExpandUi();
      renderLogs();
    });
  }

  [el.dateFilter, el.toolFilter, el.errorOnly, el.systemLogs, el.startDate, el.endDate].forEach(control => {
    control?.addEventListener("change", () => {
      if (logs.length === 0) {
        loadLogsFromDisk();
      }
      _userInteracted = true;
      renderLogs();
    });

    control?.addEventListener("input", () => {
      if (logs.length === 0) {
        loadLogsFromDisk();
      }
      _userInteracted = true;
      renderLogs();
    });
  });

  el.searchInput?.addEventListener("input", () => {
    if (logs.length === 0) {
      loadLogsFromDisk();
    }
    _userInteracted = true;
    scheduleSearchRender();
  });

  el.searchInput?.addEventListener("change", () => {
    if (logs.length === 0) {
      loadLogsFromDisk();
    }
    _userInteracted = true;
    renderLogs();
  });

  function updateDateVisibility() {
    const isCustom = el.dateFilter.value === 'custom';
    if (el.startDate) el.startDate.classList.toggle('hidden', !isCustom);
    if (el.endDate) el.endDate.classList.toggle('hidden', !isCustom);
  }

  el.dateFilter?.addEventListener('change', () => {
    updateDateVisibility();
  });
  // ensure initial visibility state without triggering other change handlers
  updateDateVisibility();

  initIpcLogs();

  // Export inner functions after they're defined
  if (typeof module !== 'undefined') {
    module.exports = {
      el,
      renderLogs,
      formatLogLine,
      exportLog,
      getFilteredLogs,
      resetLogViewer,
      __setLogs: (mockLogs) => { logs = mockLogs; enforceRetentionLimit(); rebuildSearchCache(logs); },
      __setExpanded: (val) => { expanded = val; },
      __setUserInteracted: (val) => { _userInteracted = val; }
    };
  }
}

if (document.readyState !== 'loading') {
  initLogViewer();
} else {
  document.addEventListener('DOMContentLoaded', initLogViewer);
}
