// =====================================================
// 📂 renderer.js – Manages Tab Switching and Panel Logic
// =====================================================
(() => {
  if (window.__LEAD_RENDERER_LOADED__) {
    console.warn('⚠️ renderer.js already loaded; skipping duplicate initialization.');
    return;
  }
  window.__LEAD_RENDERER_LOADED__ = true;

  if (!window.electron) {
    const noop = () => {};
    const rejectInvoke = channel => Promise.reject(new Error(`IPC unavailable: ${channel}`));
    window.electron = {
      invoke: (...args) => rejectInvoke(args[0]),
      send: noop,
      on: noop,
      once: noop,
      removeListener: noop,
      resolvePath: (...parts) => parts.filter(Boolean).join('/'),
    };
  }

// Defer license logs until preload finishes and object is available
function logLicenseStatus() {
  if (window.license) {
    // License tier and feature info available in debug mode
  } else {
    console.warn("⚠️ License API unavailable – running outside Electron?");
  }
}

// 🌐 Declare global ipc once for all panels
window.ipc = window.electron;
const ipc = window.ipc ?? window.electron;

async function confirmAction(messageOrOptions) {
  try {
    if (typeof window.rendererDialogs?.confirmAction === 'function') {
      return !!(await window.rendererDialogs.confirmAction(messageOrOptions));
    }
  } catch (err) {
    console.warn('⚠️ Native confirm helper failed; falling back to direct IPC confirm:', err?.message || err);
  }

  if (typeof ipc?.showConfirmDialog === 'function') {
    return !!(await ipc.showConfirmDialog(messageOrOptions));
  }

  return !!(await ipc.invoke('show-confirm-dialog', messageOrOptions));
}

// --- Telemetry self-test hooks (dev/test only) ---
// These helpers intentionally throw from inside renderer.js so Sentry sourcemaps
// can symbolicate frames for dist-obfuscated/renderer.js in packaged builds.
// They are inert unless explicitly called.
window['__LEAD_SENTRY_SELFTEST_THROW_RENDERER'] = function __LEAD_SENTRY_SELFTEST_THROW_RENDERER() {
  throw new Error('LEAD_SENTRY_SELFTEST_RENDERER_THROW');
};
window['__LEAD_SENTRY_SELFTEST_UNHANDLED_REJECTION'] = function __LEAD_SENTRY_SELFTEST_UNHANDLED_REJECTION() {
   
  Promise.reject(new Error('LEAD_SENTRY_SELFTEST_RENDERER_REJECTION'));
};

// Prevent unintended form submissions that cause beeps
document.addEventListener('submit', e => {
  e.preventDefault();
  console.warn('⚠️ Prevented unintended form submit');
});


// 🌐 Shared Watch Mode configs for panels
const PANEL_PRESET_EXTENSIONS = ['.json'];
const PANEL_DEFAULT_PRESET_BASENAME = 'Default';
const PANEL_DEFAULT_PRESET_FILE = `${PANEL_DEFAULT_PRESET_BASENAME}.json`;
const panelPresetAdapters = new Map();

function isDefaultPanelPresetFile(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === PANEL_DEFAULT_PRESET_FILE.toLowerCase()
    || normalized === PANEL_DEFAULT_PRESET_BASENAME.toLowerCase();
}

function findDefaultPanelPresetEntry(entries) {
  const presets = Array.isArray(entries) ? entries : [];
  return presets.find(entry => isDefaultPanelPresetFile(entry?.file) || isDefaultPanelPresetFile(entry?.name)) || null;
}

function getPanelPresetHiddenInput(adapter) {
  const hiddenId = adapter?.presetInputId;
  return hiddenId ? document.getElementById(hiddenId) : null;
}

function setPanelPresetSelection(adapter, presetFile) {
  const hidden = getPanelPresetHiddenInput(adapter);
  if (!hidden) return;

  const nextValue = String(presetFile || '').trim();
  hidden.value = nextValue;

  if (typeof window.setDropdownValue === 'function') {
    try {
      window.setDropdownValue(hidden.id, nextValue);
      return;
    } catch (_) {
      // Fall through to a best-effort manual update.
    }
  }

  const wrapper = hidden.closest('.dropdown-wrapper');
  const chosen = wrapper?.querySelector('.chosen-value');
  if (chosen) {
    chosen.value = nextValue ? nextValue.replace(/\.json$/i, '') : '';
  }
}

async function ensurePanelDefaultPreset(panelId) {
  const adapter = panelPresetAdapters.get(panelId);
  if (!adapter) return null;

  const presets = await ipc.invoke('list-panel-presets', panelId);
  const existingDefault = findDefaultPanelPresetEntry(presets);
  if (existingDefault) return existingDefault;

  if (typeof adapter.applyPackagedDefaults === 'function') {
    await adapter.applyPackagedDefaults();
  }

  const contents = typeof adapter.buildPackagedDefaultPreset === 'function'
    ? await adapter.buildPackagedDefaultPreset()
    : (typeof adapter.gatherPreset === 'function' ? await adapter.gatherPreset() : null);

  if (contents == null) {
    throw new Error(`No packaged default preset builder registered for ${panelId}`);
  }

  await ipc.invoke('write-panel-preset', {
    panel: panelId,
    presetName: PANEL_DEFAULT_PRESET_FILE,
    contents
  });

  const refreshedPresets = await ipc.invoke('list-panel-presets', panelId);
  return findDefaultPanelPresetEntry(refreshedPresets) || {
    file: PANEL_DEFAULT_PRESET_FILE,
    name: PANEL_DEFAULT_PRESET_BASENAME
  };
}

async function applyPanelDefaultPreset(panelId) {
  const adapter = panelPresetAdapters.get(panelId);
  if (!adapter) return false;
  if (adapter.__defaultPresetPromise) return adapter.__defaultPresetPromise;

  adapter.__defaultPresetPromise = (async () => {
    if (typeof adapter.refreshDropdown === 'function') {
      try {
        await adapter.refreshDropdown();
      } catch (err) {
        console.warn(`⚠️ Failed to refresh preset dropdown before applying Default for ${panelId}:`, err);
      }
    }

    const defaultEntry = await ensurePanelDefaultPreset(panelId);
    const defaultFile = String(defaultEntry?.file || PANEL_DEFAULT_PRESET_FILE);

    if (typeof adapter.applyPackagedDefaults === 'function') {
      await adapter.applyPackagedDefaults();
    }

    const raw = await ipc.invoke('read-panel-preset', {
      panel: panelId,
      presetName: defaultFile
    });

    if (!raw) {
      throw new Error(`Default preset "${defaultFile}" is unavailable for ${panelId}`);
    }

    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    await adapter.applyPreset(data);

    const hidden = getPanelPresetHiddenInput(adapter);
    if (hidden) hidden.value = defaultFile;

    if (typeof adapter.refreshDropdown === 'function') {
      await adapter.refreshDropdown();
    }

    setPanelPresetSelection(adapter, defaultFile);
    adapter.__defaultPresetApplied = true;
    return true;
  })().catch(err => {
    console.error(`❌ Failed to apply managed Default preset for ${panelId}:`, err);
    return false;
  }).finally(() => {
    adapter.__defaultPresetPromise = null;
  });

  return adapter.__defaultPresetPromise;
}

window.panelPresetDefaults = {
  register(adapter) {
    const panelId = String(adapter?.panelId || '').trim();
    if (!panelId) {
      throw new Error('Panel preset adapter requires a panelId');
    }
    if (typeof adapter.applyPreset !== 'function') {
      throw new Error(`Panel preset adapter for ${panelId} requires applyPreset(data)`);
    }
    if (typeof adapter.buildPackagedDefaultPreset !== 'function' && typeof adapter.gatherPreset !== 'function') {
      throw new Error(`Panel preset adapter for ${panelId} requires gatherPreset() or buildPackagedDefaultPreset()`);
    }

    const normalizedAdapter = {
      ...adapter,
      panelId,
      presetInputId: adapter.presetInputId || `${panelId}-preset`,
      __defaultPresetApplied: false,
      __defaultPresetPromise: null
    };

    panelPresetAdapters.set(panelId, normalizedAdapter);

    Promise.resolve().then(() => applyPanelDefaultPreset(panelId));
    return normalizedAdapter;
  },

  has(panelId) {
    return panelPresetAdapters.has(panelId);
  },

  ensureDefaultPreset(panelId) {
    return ensurePanelDefaultPreset(panelId);
  },

  applyDefaultPreset(panelId) {
    return applyPanelDefaultPreset(panelId);
  },

  resetToDefault(panelId) {
    return applyPanelDefaultPreset(panelId);
  },

  getDefaultPresetFile() {
    return PANEL_DEFAULT_PRESET_FILE;
  },

  isDefaultPresetFile(value) {
    return isDefaultPanelPresetFile(value);
  }
};

// Central mapping of per-panel job UI (summary + progress)
const PANEL_JOB_UI = {
  transcode: {
    progressId: 'transcode-progress',
    // Status text is handled inside the Transcode panel's Summary log.
    // Keep this null to avoid writing/clearing the log on tab switches.
    summaryId: null,
  },
  transcribe: {
    progressId: null,
    // Status text is handled inside the Transcribe panel's Summary log.
    // Keep this null to avoid writing/clearing the log on tab switches.
    summaryId: null,
  },
  'adobe-utilities': {
    progressId: 'adobe-progress',
    summaryId: null,
  },
  'project-organizer': {
    progressId: 'project-organizer-progress',
    summaryId: 'project-summary',
  },
};

// Panel log-window visibility toggles (persisted in localStorage)
function initHideLogToggle({ checkboxId, logId, storageKey }) {
  const cb = document.getElementById(checkboxId);
  const logEl = document.getElementById(logId);
  if (!cb || !logEl) return;

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

window.watchConfigs = {
  ingest: null,
  transcode: null,
  transcribe: null
};

// Validation helpers for each panel's watch config
window.watchValidators = {};

if (ipc?.on) {
  ipc.on('auto-connect-leadae', () => {
    console.log('🔌 Auto-connect trigger from main');
    if (typeof window.connectToLeadAE === 'function') {
      window.connectToLeadAE(true);
    }
  });

  ipc.on('app-critical-error', (_event, payload) => {
    const message = payload?.message || 'A critical error occurred. Jobs were halted.';
    const show = () => showCriticalErrorToast(message);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', show, { once: true });
    } else {
      show();
    }
  });

  ipc.on('transcribe-open-reconcile', (_e, discrepancies) => {
    const start = () => window.reconcileDiscrepancies(discrepancies);
    if (typeof window.reconcileDiscrepancies === 'function') {
      start();
    } else {
      loadPanelScript('reconcile');
      window.addEventListener('reconcile-ready', start, { once: true });
    }
  });

}

// Track loaded panel scripts to avoid duplicate event handlers
const loadedPanels = new Set();

// Name of the home panel (no active home panel currently)
const HOME_PANEL = 'home';


// Ensure shared QC & Delivery preference logic is available in all renderer windows.
// Some windows (e.g. subtitle-editor pop-outs) may not include utils/qcDeliveryPrefs.js in their HTML.
function ensureQcDeliveryPrefsLoaded() {
  try {
    if (window.qcDeliveryPrefs) return Promise.resolve(true);

    // If a script tag already exists, wait for it.
    const existing = document.querySelector('script[data-qc-delivery-prefs]');
    if (existing) {
      return new Promise(resolve => {
        existing.addEventListener('load', () => resolve(true), { once: true });
        existing.addEventListener('error', () => resolve(false), { once: true });
      });
    }

    return new Promise(resolve => {
      const s = document.createElement('script');
      s.setAttribute('data-qc-delivery-prefs', '1');
      s.src = './utils/qcDeliveryPrefs.js';
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      (document.head || document.documentElement || document.body).appendChild(s);
    });
  } catch {
    return Promise.resolve(false);
  }
}



// Phase 3: Canonical QC & Delivery prefs sync (state.json via IPC)
// We keep localStorage as the runtime source for now, but sync it to/from state.json so all windows
// stay deterministic (and pop-outs don't depend on localStorage origin quirks).
let __qcDeliverySyncInstalled = false;
let __qcDeliveryPrefsBootstrapped = false;
let __qcDeliveryUpdateListenerInstalled = false;
let __qcDeliverySyncSuppressed = false;

function suppressQcDeliverySync(value) {
  __qcDeliverySyncSuppressed = !!value;
}

function isQcDeliverySyncSuppressed() {
  return __qcDeliverySyncSuppressed === true;
}

function installQcDeliveryPrefsUpdateListener() {
  if (__qcDeliveryUpdateListenerInstalled) return;
  __qcDeliveryUpdateListenerInstalled = true;
  if (!ipc?.on) return;

  ipc.on('prefs:qc-delivery-updated', async (_e, store) => {
    try {
      await ensureQcDeliveryPrefsLoaded();
      const api = window.qcDeliveryPrefs;
      if (!api || typeof localStorage === 'undefined' || !localStorage) return;

      const storage = (store && typeof store === 'object') ? store.storage : null;
      if (!storage || typeof storage !== 'object') return;

      suppressQcDeliverySync(true);
      if (typeof api.applyStorageSnapshot === 'function') {
        api.applyStorageSnapshot(localStorage, storage, { removeMissing: true });
      } else {
        for (const [k, v] of Object.entries(storage)) {
          try {
            if (v == null) localStorage.removeItem(k);
            else localStorage.setItem(k, String(v));
          } catch {
            // ignore
          }
        }
      }

      // Keep derived legacy keys consistent.
      try { api.migrateLegacyPrefs?.(localStorage); } catch {}

      suppressQcDeliverySync(false);
    } catch {
      try { suppressQcDeliverySync(false); } catch {}
    }
  });
}

function installQcDeliveryPrefsStateSync() {
  if (__qcDeliverySyncInstalled) return;
  __qcDeliverySyncInstalled = true;

  if (typeof localStorage === 'undefined' || !localStorage) return;

  const api = window.qcDeliveryPrefs;
  const keys = api?.STORAGE_KEYS
    || (typeof api?.getStorageKeys === 'function' ? api.getStorageKeys() : []);
  const list = Array.isArray(keys) ? keys.map(String) : [];
  const keySet = new Set(list);
  if (!keySet.size) return;

  // Debounce writes to avoid thrashing state.json when many keys update at once.
  let pending = {};
  let timer = null;

  const flush = () => {
    const patch = pending;
    pending = {};
    timer = null;

    if (!patch || !Object.keys(patch).length) return;

    try {
      if (ipc?.send) ipc.send('prefs:set-qc-delivery', { patch });
      else if (ipc?.invoke) ipc.invoke('prefs:set-qc-delivery', { patch }).catch(() => {});
    } catch {
      // ignore
    }
  };

  const queue = (k, v) => {
    if (isQcDeliverySyncSuppressed()) return;
    pending[String(k)] = v;
    if (timer) return;
    timer = setTimeout(flush, 150);
  };

  const origSetItem = localStorage.setItem.bind(localStorage);
  const origRemoveItem = localStorage.removeItem.bind(localStorage);
  const origClear = (typeof localStorage.clear === 'function') ? localStorage.clear.bind(localStorage) : null;

  localStorage.setItem = function (k, v) {
    origSetItem(k, v);
    const key = String(k);
    if (keySet.has(key)) queue(key, String(v));
  };

  localStorage.removeItem = function (k) {
    origRemoveItem(k);
    const key = String(k);
    if (keySet.has(key)) queue(key, null);
  };

  if (origClear) {
    localStorage.clear = function () {
      origClear();
      if (isQcDeliverySyncSuppressed()) return;

      const patch = {};
      for (const k of keySet) patch[k] = null;

      try {
        if (ipc?.send) ipc.send('prefs:set-qc-delivery', { patch });
        else if (ipc?.invoke) ipc.invoke('prefs:set-qc-delivery', { patch }).catch(() => {});
      } catch {
        // ignore
      }
    };
  }
}

async function bootstrapQcDeliveryPrefsFromState() {
  if (__qcDeliveryPrefsBootstrapped) return true;
  __qcDeliveryPrefsBootstrapped = true;

  if (!ipc?.invoke) return false;
  if (typeof localStorage === 'undefined' || !localStorage) return false;

  try {
    await ensureQcDeliveryPrefsLoaded();
    const api = window.qcDeliveryPrefs;
    if (!api) return false;

    // Read canonical store (state.json). If empty, we will seed it from localStorage after migrations.
    const store = await ipc.invoke('prefs:get-qc-delivery');
    const stored = (store && typeof store === 'object') ? store.storage : null;

    suppressQcDeliverySync(true);

    if (stored && typeof stored === 'object' && Object.keys(stored).length) {
      if (typeof api.applyStorageSnapshot === 'function') {
        api.applyStorageSnapshot(localStorage, stored, { removeMissing: true });
      } else {
        for (const [k, v] of Object.entries(stored)) {
          try {
            if (v == null) localStorage.removeItem(k);
            else localStorage.setItem(k, String(v));
          } catch {
            // ignore
          }
        }
      }
    }

    // Always run migrations so derived keys (like SCC legacy gate flags) are consistent.
    try { api.migrateLegacyPrefs?.(localStorage); } catch {}

    suppressQcDeliverySync(false);

    // Persist a canonical post-migration snapshot back to state.json.
    try {
      const snap = (typeof api.snapshotStorage === 'function')
        ? api.snapshotStorage(localStorage)
        : {};
      await ipc.invoke('prefs:set-qc-delivery', { replace: true, storage: snap });
    } catch {
      // ignore
    }

    return true;
  } catch (err) {
    try { suppressQcDeliverySync(false); } catch {}
    console.warn('⚠️ QC prefs bootstrap failed:', err?.message || err);
    return false;
  }
}

async function setupQcDeliveryPrefsSync() {
  try { await ensureQcDeliveryPrefsLoaded(); } catch {}
  try { installQcDeliveryPrefsUpdateListener(); } catch {}
  try { installQcDeliveryPrefsStateSync(); } catch {}
  try { await bootstrapQcDeliveryPrefsFromState(); } catch {}
  return true;
}
// Dynamically loads a JavaScript file for a given panel
function loadPanelScript(panelName) {
  if (loadedPanels.has(panelName)) {
    return;
  }
  const scriptId = `panel-script-${panelName}`;
  const preloaded = document.getElementById(scriptId);
  if (preloaded) {
    loadedPanels.add(panelName);
    return;
  }

  // 📥 Create and load new script element
  const script = document.createElement("script");
  script.id = scriptId;
  // In file:// pages, absolute filesystem paths in <script src> won't resolve.
  // Always load panel scripts relative to index.html.
  const preferDev = !!(window.electron?.DEBUG_UI && window.electron?.isPackaged === false); /* exposed in preload */
  const forcePlainScript = panelName === 'subtitleEditor';
  const useObfuscated = !preferDev && !forcePlainScript;
  const primarySrc = useObfuscated
    ? `./dist-obfuscated/renderer.${panelName}.js`
    : `./renderer.${panelName}.js`;
  const fallbackSrc = useObfuscated
    ? `./renderer.${panelName}.js`
    : (forcePlainScript ? null : `./dist-obfuscated/renderer.${panelName}.js`);
  script.src = primarySrc;
  script.onerror = () => {
    if (!fallbackSrc || fallbackSrc === primarySrc) {
      console.error(`❌ Failed to load panel script ${primarySrc}`);
      return;
    }
    const fallback = document.createElement('script');
    fallback.id = `${scriptId}-fallback`;
    fallback.src = fallbackSrc;
    fallback.onerror = () => {
      console.error(`❌ Failed to load fallback renderer.${panelName}.js`);
    };
    document.body.appendChild(fallback);
  };
  script.onload = () => {};
  document.body.appendChild(script);
  loadedPanels.add(panelName);  
}

window.addEventListener('reconcile-complete', e => {
  ipc?.send('transcribe-final-words', e.detail);
});

function updateToolbar(panelId) {
  const detail = { panelId: panelId ?? null };
  document.dispatchEvent(new CustomEvent('toolbar-updated', { detail }));
}

// =====================================
// 🚀 Initialize Tabs & AI on Page Load
// =====================================
// IMPORTANT:
// In some CSP-hardened builds (e.g. when a script loader dynamically injects
// renderer.js), this file may execute AFTER DOMContentLoaded has already fired.
// If we only wire the UI inside a DOMContentLoaded handler, the sidebar tabs
// will never receive click handlers and panels won't open.
//
// So we boot immediately when the DOM is already ready, otherwise we wait for
// DOMContentLoaded.
(function bootWhenReady() {
  const __boot = async () => {
  // If this is the subtitle-editor pop-out, bootstrap only what it needs.
  const params = new URLSearchParams(location.search);
  if (params.get('win') === 'subtitle-editor') {
    document.body.classList.add('subtitle-editor-window');
    try { await setupQcDeliveryPrefsSync(); } catch {}
    loadPanelScript('subtitleEditor');
    return; // Skip tabs/toolbars/etc. in the pop-out
  }

  // Main window: ensure QC & Delivery prefs are synced before any panel scripts read localStorage.
  try { await setupQcDeliveryPrefsSync(); } catch {}

  // Start button handler (unchanged wiring to build cfg)
  // window.electron.invoke('queue-add-clone', cfg); (unchanged wiring to build cfg)
  // window.electron.invoke('queue-add-clone', cfg);
  const licenseAvailable = typeof window.license !== "undefined";
  logLicenseStatus();

  // Phase 1: auto-refresh short-lived subscription entitlements.
  // - Never blocks UI startup
  // - Only attempts when entitlement indicates it needs a refresh
  async function maybeAutoSyncEntitlement(trigger = 'startup') {
    try {
      if (!window.license?.getEntitlement || !window.license?.syncEntitlement) return false;

      const ent = await window.license.getEntitlement({ forceReload: false });
      const tier = String(ent?.tier || '').toLowerCase();
      const status = String(ent?.status || '');

      // Only Pro subscriptions need periodic refresh. Enterprise files are typically long-lived.
      if (tier !== 'pro' && status !== 'ACTIVE' && status !== 'LOCKED') return false;

      const shouldSync =
        ent?.needsSync === true ||
        ent?.warning === 'offline_grace' ||
        ent?.warning === 'refresh_soon' ||
        ent?.reason === 'refresh_required' ||
        ent?.reason === 'license_expired';

      if (!shouldSync) return false;

      const res = await window.license.syncEntitlement({});
      return !(res && typeof res === 'object' && res.ok === false);
    } catch {
      return false;
    }
  }

  // Fire-and-forget: first refresh attempt shortly after boot
  setTimeout(() => { try { maybeAutoSyncEntitlement('startup'); } catch {} }, 2000);
  // Periodic refresh (6h)
  setInterval(() => { try { maybeAutoSyncEntitlement('interval'); } catch {} }, 6 * 60 * 60 * 1000);

  window.translatePage?.();

  // Panel-specific log toggles
  initHideLogToggle({ checkboxId: 'adobe-hide-log', logId: 'adobe-log-window', storageKey: 'ui.adobeUtilities.hideLogWindow' });

  if ("Notification" in window && Notification.permission !== "granted") {
    Notification.requestPermission();
  }
  const tabs = document.querySelectorAll(".tab");

  const RUNNING_TAB_CLASS = 'job-running';
  const panelActivityState = new Map();

  function getPanelActivityState(panel) {
    if (!panelActivityState.has(panel)) {
      panelActivityState.set(panel, {
        directActive: false,
        watchActive: false,
        activeJobs: new Set(),
        anonymousJobs: 0
      });
    }
    return panelActivityState.get(panel);
  }

  function applyPanelRunningState(panel) {
    if (!panel) return;
    const tab = Array.from(tabs).find(t => t.getAttribute('data-panel') === panel);
    if (!tab) return;

    const state = getPanelActivityState(panel);
    const isRunning =
      state.directActive === true ||
      state.watchActive === true ||
      state.activeJobs.size > 0 ||
      state.anonymousJobs > 0;

    tab.classList.toggle(RUNNING_TAB_CLASS, isRunning);
    tab.setAttribute('aria-busy', isRunning ? 'true' : 'false');
  }

  function setPanelRunningState(panel, isRunning) {
    if (!panel) return;
    const state = getPanelActivityState(panel);
    state.directActive = !!isRunning;
    applyPanelRunningState(panel);
  }

  function setPanelWatchState(panel, isWatching) {
    if (!panel) return;
    const state = getPanelActivityState(panel);
    state.watchActive = !!isWatching;
    applyPanelRunningState(panel);
  }

  function markPanelJobStarted(job) {
    const panel = job?.panel;
    if (!panel) return;

    const state = getPanelActivityState(panel);
    const jobId = job?.id == null ? '' : String(job.id).trim();
    if (jobId) {
      state.activeJobs.add(jobId);
    } else {
      state.anonymousJobs += 1;
    }
    applyPanelRunningState(panel);
  }

  function markPanelJobEnded(job) {
    const panel = job?.panel;
    if (!panel) return;

    const state = getPanelActivityState(panel);
    const jobId = job?.id == null ? '' : String(job.id).trim();
    if (jobId) {
      state.activeJobs.delete(jobId);
    } else if (state.anonymousJobs > 0) {
      state.anonymousJobs -= 1;
    }
    applyPanelRunningState(panel);
  }

  window.addEventListener('lae:panel-running-state', (event) => {
    const detail = event?.detail || {};
    const panel = detail.panel;
    if (!panel) return;
    if (detail.source === 'watch') {
      setPanelWatchState(panel, !!detail.isRunning);
      return;
    }
    setPanelRunningState(panel, !!detail.isRunning);
  });

  // Keep sidebar right-side toggles in sync with the active panel state
  function syncNavToggles(activePanelId) {
    tabs.forEach(t => {
      const panel = t.getAttribute('data-panel');
      const cb = t.querySelector('.lae-navtoggle-check');
      if (!cb) return;
      cb.checked = !!activePanelId && panel === activePanelId;
    });
  }

  // 🌐 Localized string helper
  const translate = (key, options, fallback) => {
    const translator = window.i18n?.t?.bind(window.i18n);
    const translated = translator ? translator(key, options) : undefined;
    if (translated && translated !== key) return translated;
    if (fallback) return fallback;
    return translated ?? key;
  };

  // ✅ License check for tab visibility (async‑safe)
// In development, keep *all* panels visible so you can finish building/testing.
// Enforcement still happens in the main process IPC layer.
  const __devShowAllPanels = !!(window.electron?.isPackaged === false || window.electron?.DEBUG_UI === true);
  async function applyPanelVisibility(reason = 'startup') {
    if (__devShowAllPanels) return;
    if (!licenseAvailable || !window.license?.isFeatureEnabled) return;

    for (const tab of tabs) {
      const panel = tab.getAttribute("data-panel");
      try {
        const isEnabled = await Promise.resolve(window.license.isFeatureEnabled(panel));
        // IMPORTANT: restore when enabled; previously we only ever hid panels once.
        tab.style.display = isEnabled ? '' : 'none';
      } catch {
        // Fail open on IPC errors to avoid bricking UI.
        tab.style.display = '';
      }
    }
  }

  // Initial gating pass
  applyPanelVisibility('startup');

  // React to license changes (Sync Subscription / Install License / Clear License)
  if (window.electron?.onLicenseChanged) {
    window.electron.onLicenseChanged(() => {
      // Recompute tab visibility immediately
      applyPanelVisibility('license_changed');
    });
  }

  const panels = document.querySelectorAll(".panel-section");
  const app = document.getElementById("app");
  const mainPanel = document.querySelector('.main-panel');
  let activePanel = null;

  // All panels share the same .main-panel scroll context. If you scroll down in one panel,
  // the next panel would otherwise inherit that scroll offset.
  function resetMainPanelScroll() {
    try {
      if (mainPanel) mainPanel.scrollTop = 0;
    } catch {
      // ignore
    }
    // Defensive: some environments still scroll the window/doc.
    try { window.scrollTo(0, 0); } catch {}
    try { document.documentElement.scrollTop = 0; } catch {}
    try { document.body.scrollTop = 0; } catch {}
  }

  const getCloneProgressElements = () => ({
    bar: document.getElementById('clone-progress-bar')
      ?? document.getElementById('clone-progress')
      ?? document.getElementById('progressBar'),
    eta: document.getElementById('clone-progress-eta')
      ?? document.getElementById('clone-eta')
      ?? document.getElementById('eta'),
    status: document.getElementById('clone-progress-status')
      ?? document.getElementById('clone-status')
      ?? document.getElementById('status')
  });

  const updateCloneStatus = text => {
    const { status } = getCloneProgressElements();
    if (status) {
      status.textContent = text;
    } else if (text) {
      console.log(text);
    }
  };

  if (ipc?.on) {
    ipc.on('clone:progress', (_evt, p) => {
      const { bar, eta, status } = getCloneProgressElements();
      if (p?.phase === 'scan') {
        updateCloneStatus(translate('cloneStatusScanningSelection', undefined, 'Scanning selection…'));
        return;
      }
      if (p?.phase === 'start') {
        updateCloneStatus(
          translate(
            'cloneStatusCopyingFileCount',
            { count: p.files ?? 0 },
            `Copying ${p.files ?? 0} file(s)…`
          )
        );
        if (bar) {
          bar.max = p.totalBytes || 1;
          bar.value = 0;
        }
        if (eta) {
          eta.textContent = '';
        }
        return;
      }
      if (p?.phase === 'copy') {
        if (bar) {
          bar.value = p.copiedBytes ?? bar.value ?? 0;
        }
        updateCloneStatus(
          p?.file
            ? translate('cloneStatusCopyingFilePath', { file: p.file }, `Copying: ${p.file}`)
            : translate('cloneStatusCopyingGeneric', undefined, 'Copying…')
        );
        if (eta && p.totalBytes) {
          const pct = Math.floor(((p.copiedBytes ?? 0) / p.totalBytes) * 100);
          eta.textContent = `${pct}%`;
        }
        return;
      }
      if (p?.phase === 'done') {
        if (bar) {
          bar.value = p.totalBytes ?? bar.max ?? bar.value ?? 0;
        }
        updateCloneStatus(translate('cloneStatusDone', undefined, 'Done.'));
        if (eta) {
          eta.textContent = '100%';
        }
        return;
      }

      if (!status) {
        console.log('clone:progress', p);
      }
    });

    ipc.on('clone:done', (_evt, msg) => {
      if (!msg) return;
      if (msg.ok) {
        updateCloneStatus(translate('cloneStatusComplete', undefined, 'Clone complete.'));
      } else {
        updateCloneStatus(
          translate('cloneStatusFailed', { error: msg.error }, `Clone failed: ${msg.error}`)
        );
      }
    });
  }

  // Load Project Organizer logic but keep panel hidden
  loadPanelScript('project-organizer');
  document.getElementById('project-organizer')?.classList.add('hidden');

  // Load Speed Test logic but keep panel hidden
  loadPanelScript('speed-test');
  document.getElementById('speed-test')?.classList.add('hidden');

  // 🔧 Load Preferences logic early so webhook visibility matches saved state
  loadPanelScript('preferences');
  document.getElementById('preferences')?.classList.add('hidden');

  // Preload preset-backed panels so the managed Default preset exists as soon as the app boots.
  [
    'adobe-utilities',
    'ingest',
    'transcode',
    'transcribe',
    'nle-utilities'
  ].forEach(loadPanelScript);

  // Hide all panels initially
  panels.forEach(p => p.classList.add("hidden"));
  document.body.classList.remove('home-active');
  mainPanel?.classList.add('hidden');

  updateToolbar('ingest');
  syncNavToggles(null);

  // 🗑️ Preset deletion (shared across panels)
  document.querySelectorAll('.delete-preset-btn').forEach(btn => {
    // Use the actual panel section id as the preset namespace (matches where presets are saved)
    const panelId = btn.closest('.panel-section')?.id || btn.dataset.panel;

    // Find the preset dropdown next to this trash button
    const toolbar = btn.closest('.panel-toolbar-controls');
    const dropdownWrapper = toolbar?.querySelector('.dropdown-wrapper');
    const hiddenInput = dropdownWrapper?.querySelector('input[type="hidden"]');
    const dropdownInput = dropdownWrapper?.querySelector('.chosen-value');
    const listEl = dropdownWrapper?.querySelector('.value-list');

    if (!hiddenInput) {
      btn.disabled = true;
      return;
    }

    const syncDeleteState = () => {
      // If the visible field is empty, treat it as “no selection”
      if (dropdownInput && !dropdownInput.value) hiddenInput.value = '';
      btn.disabled = !hiddenInput.value;
    };

    // Initial state + keep in sync when a preset is selected
    syncDeleteState();
    hiddenInput.addEventListener('change', syncDeleteState);

    // If the user clears the visible field, clear the hidden value too
    dropdownInput?.addEventListener('input', () => {
      if (!dropdownInput.value) {
        hiddenInput.value = '';
        hiddenInput.dispatchEvent(new Event('change'));
      }
    });

    async function refreshPresetOptions() {
      if (!panelId || typeof window.setupStyledDropdown !== 'function') return;

      const presets = await ipc.invoke('list-panel-presets', panelId);
      const opts = (Array.isArray(presets) ? presets : [])
        .filter(p => typeof p?.file === 'string' && p.file.toLowerCase().endsWith('.json'))
        .map(p => ({ value: p.file, label: p.name || p.file.replace(/\.json$/i, '') }));

      window.setupStyledDropdown(hiddenInput.id, opts);
      window.setDropdownValue?.(hiddenInput.id, hiddenInput.value || '');
      window.translatePage?.();
    }

    // After deleting a preset, return the current panel UI to its Default preset.
    async function resetPanelToDefaults() {
      if (panelId && window.panelPresetDefaults?.has?.(panelId)) {
        return window.panelPresetDefaults.resetToDefault(panelId);
      }

      const root = btn.closest('.panel-section') || (panelId ? document.getElementById(panelId) : null);
      if (!root) return false;

      const tryClick = (el) => {
        if (!el || typeof el.click !== 'function') return false;
        if (el.disabled) return false;
        try { el.click(); } catch { return false; }
        return true;
      };

      // Prefer explicit IDs where they are stable/known.
      const explicitSelectors = [
        '#reset-ingest-fields',
        '#reset-utilities',
        '#reset-project-organizer',
        '#reset-transcode',
        '#reset-transcode-fields',
        '#reset-transcribe',
        '#reset-nle-utilities',
      ];

      for (const sel of explicitSelectors) {
        if (tryClick(root.querySelector(sel))) return true;
      }

      // Prefer resets inside the panel's main controls row (when present).
      const controlsRoot =
        root.querySelector(`#${panelId}-lock-controls`) ||
        root.querySelector(`#${panelId}-controls`) ||
        root;

      // Next-best: a single reset button with an i18n key starting with "reset"
      // (covers reset, resetIngest, resetTranscribe, resetProjectOrganizer, etc.).
      const i18nResetButtons = Array.from(controlsRoot.querySelectorAll('button[data-i18n^="reset"]'))
        .filter(b => b && !b.disabled);
      if (i18nResetButtons.length === 1 && tryClick(i18nResetButtons[0])) return true;

      // Last fallback: a single button whose id starts with "reset-".
      const idResetButtons = Array.from(controlsRoot.querySelectorAll('button[id^="reset-"]'))
        .filter(b => b && !b.disabled);
      if (idResetButtons.length === 1 && tryClick(idResetButtons[0])) return true;

      return false;
    }

    btn.addEventListener('click', async () => {
      const presetFile = hiddenInput.value;

      // Hard guard in case UI state gets out of sync
      if (!presetFile) {
        syncDeleteState();
        return;
      }

      const labelFromList =
        listEl && [...listEl.children].find(li => li.dataset.value === presetFile)?.textContent;

      const presetName = (labelFromList || presetFile).replace(/\.json$/i, '');

      const confirmed = await confirmAction({
        title: translate('presetDeleteConfirmTitle', {}, 'Confirm preset deletion'),
        message: translate(
          'presetDeleteConfirm',
          { preset: presetName },
          `Are you sure you want to delete the preset "${presetName}"?`
        ),
        type: 'warning',
        okLabel: translate('deleteButton', {}, 'Delete'),
        cancelLabel: translate('cancelButtonLabel', {}, 'Cancel')
      });
      if (!confirmed) return;

      const success = await ipc.invoke('delete-panel-preset', {
        panel: panelId,
        presetName: presetFile
      });

      if (success) {
        // Clear selection + UI
        hiddenInput.value = '';
        if (dropdownInput) dropdownInput.value = '';
        hiddenInput.dispatchEvent(new Event('change'));

        // Restore the panel fields to Default after preset deletion.
        await resetPanelToDefaults();

        // Rebuild options after the reset, because deleting Default recreates it lazily.
        await refreshPresetOptions();

        showPresetToast(
          translate(
            'presetDeleteSuccess',
            { preset: presetName },
            `✅ Preset "${presetName}" deleted successfully.`
          )
        );
      } else {
        showCriticalErrorToast(
          translate(
            'presetDeleteError',
            { preset: presetName },
            `❌ Could not delete preset "${presetName}".`
          )
        );
      }
    });
  });

  const accountToggleBtn = document.querySelector('.setting-btn');
  const UI_COLLAPSE_ACK_TIMEOUT_MS = 450;
  let uiCollapseRequestId = 0;
  let pendingUICollapseAck = null;

  function clearPendingUICollapseAck() {
    if (pendingUICollapseAck?.watchdog) {
      clearTimeout(pendingUICollapseAck.watchdog);
    }
    pendingUICollapseAck = null;
  }

  function finalizeExpandTransition(requestId) {
    if (!pendingUICollapseAck || pendingUICollapseAck.requestId !== requestId) return;
    const panel = document.getElementById(pendingUICollapseAck.panelId);
    panel?.classList.remove('content-hidden');
    resetMainPanelScroll();
    clearPendingUICollapseAck();
  }

  ipc?.on?.('ui:collapsed-applied', (_event, payload = {}) => {
    const requestId = Number(payload?.requestId);
    if (!Number.isFinite(requestId)) return;
    finalizeExpandTransition(requestId);
  });

  function handlePanelToggle(targetPanel, tabEl = null) {
    const isActive = (activePanel === targetPanel) || (tabEl && tabEl.classList.contains('active'));

    // === CLOSE CURRENT PANEL ===
    if (isActive) {
      clearPendingUICollapseAck();

      // Clear sidebar active state (Account has no sidebar tab).
      if (tabEl) {
        tabEl.classList.remove('active');
      } else {
        tabs.forEach(t => t.classList.remove('active'));
      }

      panels.forEach(p => {
        p.classList.remove('content-hidden');
        p.classList.add('hidden');
      });
      app.classList.remove('panel-open');
      mainPanel?.classList.add('hidden');
      ipc?.send?.('ui:set-collapsed', { collapsed: true, requestId: ++uiCollapseRequestId });
      activePanel = null;
      document.body.classList.remove('home-active');
      updateToolbar(null);
      syncNavToggles(null);
      return;
    }

    // === SWITCH TO ANOTHER PANEL ===
    const wasCollapsed = !app.classList.contains('panel-open');
    clearPendingUICollapseAck();

    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => {
      p.classList.add('hidden');
      p.classList.remove('content-hidden');
    });

    if (tabEl) tabEl.classList.add('active');
    const selectedPanel = document.getElementById(targetPanel);
    selectedPanel?.classList.remove('hidden');

    // Reset scroll so the newly selected panel always starts at the top.
    resetMainPanelScroll();

    // If the app was collapsed, hide content during expansion
    if (wasCollapsed) {
      const requestId = ++uiCollapseRequestId;
      selectedPanel?.classList.add('content-hidden');
      pendingUICollapseAck = {
        requestId,
        panelId: targetPanel,
        watchdog: setTimeout(() => finalizeExpandTransition(requestId), UI_COLLAPSE_ACK_TIMEOUT_MS)
      };
      ipc?.send?.('ui:set-collapsed', { collapsed: false, requestId });
    } else {
      // Instantly show contents when switching panels
      selectedPanel?.classList.remove('content-hidden');
    }

    mainPanel?.classList.remove('hidden');
    app.classList.add('panel-open');
    activePanel = targetPanel;
    document.body.classList.toggle('home-active', targetPanel === HOME_PANEL);
    updateToolbar(targetPanel);
    syncNavToggles(targetPanel);

    // 🧼 Clear all progress bars and summaries across panels
    Object.values(PANEL_JOB_UI).forEach(cfg => {
      const fill = cfg.progressId
        ? document.getElementById(cfg.progressId)
        : null;
      const summaryEl = cfg.summaryId
        ? document.getElementById(cfg.summaryId)
        : null;

      if (fill) {
        if (fill.tagName === 'PROGRESS') {
          fill.value = 0;
        } else {
          fill.style.width = '0%';
        }
      }

      if (summaryEl) {
        if ('value' in summaryEl) {
          summaryEl.value = '';
        } else {
          summaryEl.textContent = '';
        }
      }
    });

    loadPanelScript(targetPanel);

    // adobe-utilities manages its own bridge connection lifecycle inside renderer.adobe-utilities.js
  }

  // Titlebar Account button: behaves exactly like the old sidebar Account tab
  accountToggleBtn?.addEventListener('click', () => {
    handlePanelToggle('account', null);
  });
  // === Handle Tab Clicks ===
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetPanel = tab.getAttribute('data-panel');
      handlePanelToggle(targetPanel, tab);
    });
  });


  function updatePanelSummary(panel, text) {
    const cfg = PANEL_JOB_UI[panel];
    if (!cfg || !cfg.summaryId) return;
    const el = document.getElementById(cfg.summaryId);
    if (!el) return;

    if ('value' in el) {
      // textarea / input / output with value
      el.value = text;
    } else {
      // div/span/etc.
      el.textContent = text;
    }
  }

  function getCancelButton(panel) {
    const map = {
      ingest: 'cancel-ingest',
      transcode: 'cancelTranscode',
      transcribe: 'cancel-transcribe',
      'adobe-utilities': 'cancel-adobe-utilities',
      'project-organizer': 'cancel-project-organizer'
    };
    return document.getElementById(map[panel]);
  }

  // Some panels re-use the "Cancel" button as a persistent "Stop Watching" control.
  // In that mode, disabling the cancel button on job completion strands the UI in watch mode.
  function isWatchStopButton(btn) {
    if (!btn) return false;
    try {
      if (btn.dataset?.watchActive === '1') return true;
      const label =
        btn.querySelector?.('.button_text')?.textContent ||
        btn.textContent ||
        '';
      return String(label).toLowerCase().includes('stop watching');
    } catch {
      return false;
    }
  }

  ipc?.on('queue-job-added', (_e, job) => {
    const text = translate(
      "queueJobQueued",
      { panel: job.panel },
      `🗳️ ${job.panel} job queued.`
    );
    updatePanelSummary(job.panel, text);
  });

  ipc?.on('queue-job-start', (_e, job) => {
    markPanelJobStarted(job);
    const text = translate(
      "queueJobStarted",
      { panel: job.panel },
      `🚀 ${job.panel} job started.`
    );
    updatePanelSummary(job.panel, text);
    const btn = getCancelButton(job.panel);
    if (btn) btn.disabled = false;

    const fillMap = {
      ingest: 'ingest-progress',
      transcode: 'transcode-progress',
      transcribe: 'transcribe-progress-fill',
      'adobe-utilities': 'adobe-progress'
    };
    const fillId = fillMap[job.panel];
    const fill = document.getElementById(fillId);
    if (fill) {
      if (fill.tagName === 'PROGRESS') {
        fill.value = 0;
      } else {
        fill.style.transition = 'none';
        fill.style.width = '0%';
        void fill.offsetWidth;
        fill.style.transition = '';
      }
    }
  });

  ipc?.on('queue-job-complete', (_e, job) => {
    markPanelJobEnded(job);
    const skippedWithError = job?.result?.success === false && job?.result?.skipped === true;
    const text = skippedWithError
      ? translate(
          'queueJobWarning',
          { panel: job.panel },
          `⚠️ ${job.panel} job skipped with warnings.`
        )
      : translate(
          "queueJobComplete",
          { panel: job.panel },
          `✅ ${job.panel} job complete.`
        );
    updatePanelSummary(job.panel, text);
    const btn = getCancelButton(job.panel);
    if (btn && !isWatchStopButton(btn)) btn.disabled = true;
  });

  ipc?.on('queue-job-failed', (_e, job) => {
    markPanelJobEnded(job);
    const text = translate(
      "queueJobFailed",
      { panel: job.panel },
      `❌ ${job.panel} job failed.`
    );
    updatePanelSummary(job.panel, text);
    const btn = getCancelButton(job.panel);
    if (btn && !isWatchStopButton(btn)) btn.disabled = true;
  });

  ipc?.on('queue-job-cancelled', (_e, job) => {
    markPanelJobEnded(job);
    const text = translate(
      "queueJobCancelled",
      { panel: job.panel },
      `🛑 ${job.panel} job cancelled.`
    );
    updatePanelSummary(job.panel, text);
    const btn = getCancelButton(job.panel);
    if (btn && !isWatchStopButton(btn)) btn.disabled = true;
  });

  };

  const __runBoot = () => {
    __boot().catch(err => {
      console.error('❌ renderer.js bootstrap failed', err);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', __runBoot, { once: true });
  } else {
    __runBoot();
  }
})();

function showPresetToast(message) {
  let toast = document.getElementById('preset-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'preset-toast';
    toast.style.position = 'fixed';
    toast.style.top = '12px';
    toast.style.right = '20px';
    toast.style.padding = '10px 18px';
    toast.style.background = '#00b894';
    toast.style.color = '#fff';
    toast.style.borderRadius = '8px';
    toast.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
    toast.style.fontFamily = 'system-ui, sans-serif';
    toast.style.fontSize = '13px';
    toast.style.zIndex = '9999';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.transition = 'opacity 0.4s ease';
  setTimeout(() => (toast.style.opacity = '0'), 2000);
}

function showCriticalErrorToast(message) {
  let toast = document.getElementById('critical-error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'critical-error-toast';
    toast.style.position = 'fixed';
    toast.style.top = '12px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.padding = '12px 18px';
    toast.style.background = '#c0392b';
    toast.style.color = '#fff';
    toast.style.borderRadius = '8px';
    toast.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
    toast.style.fontFamily = 'system-ui, sans-serif';
    toast.style.fontSize = '13px';
    toast.style.zIndex = '10000';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.transition = 'opacity 0.4s ease';
  setTimeout(() => (toast.style.opacity = '0'), 4000);
}

// Listen for save/delete events for visual feedback
ipc?.on?.('preset-saved', (_e, panelId) => {
  showPresetToast(
    translate(
      'presetToastSaved',
      { panel: panelId },
      `✅ Preset saved for ${panelId}`
    )
  );
});
ipc?.on?.('preset-deleted', (_e, panelId) => {
  showPresetToast(
    translate(
      'presetToastDeleted',
      { panel: panelId },
      `🗑️ Preset deleted from ${panelId}`
    )
  );
});

// ===================================
// 💡 Global Theme Toggle Control (Light = On)
// ===================================
document.addEventListener('DOMContentLoaded', () => {
  const themeToggle = document.getElementById('theme-toggle');
  if (!themeToggle) return;

  // ✅ Checked means LIGHT MODE
  const savedTheme = localStorage.getItem('theme') || 'light';
  const isLight = savedTheme === 'light';
  document.body.classList.toggle('dark-mode', !isLight);
  themeToggle.checked = isLight;

  const broadcast = (theme) => {
    document.dispatchEvent(
      new CustomEvent('theme-toggle-updated', { detail: { theme } })
    );
  };

  themeToggle.addEventListener('change', () => {
    const isLightNow = themeToggle.checked;
    const newTheme = isLightNow ? 'light' : 'dark';
    document.body.classList.toggle('dark-mode', !isLightNow);
    localStorage.setItem('theme', newTheme);
    broadcast(newTheme);
  });
});



})();
