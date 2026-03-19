(() => {

  // 🧼 Collapse all <details> on load
  document.querySelectorAll('#nle-utilities details').forEach(section => {
    section.open = false;
  });

  // ---------------------------------------------------------------------------
  // ✅ IPC hard-guard
  // Prevent a white-screen crash if preload failed or the panel runs outside Electron.
  // ---------------------------------------------------------------------------
  const ipc = window.ipc ?? window.electron;
  const PANEL_ID = 'nle-utilities';

  const getLocalizedText = (key, fallback = '', options = {}) => {
    if (window.i18n?.t) {
      return window.i18n.t(key, options);
    }
    return fallback;
  };

  const getBackupTimestamp = () => {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  };

  const localizePresetLoadError = (err) => {
    if (err?.name === 'SyntaxError') {
      return getLocalizedText('nlePresetInvalidFormat', 'Preset file is not valid JSON.');
    }

    const rawMessage = String(err?.message || '');
    if (/preset not found/i.test(rawMessage)) {
      return getLocalizedText('nlePresetNotFound', 'Preset not found');
    }

    return getLocalizedText('nlePresetLoadErrorUnknown', 'Unknown error');
  };

  const localizeConfigLoadError = (err) => {
    if (err?.name === 'SyntaxError') {
      return getLocalizedText('nleConfigInvalidFormat', 'Config file is not valid JSON.');
    }

    return getLocalizedText('nleConfigLoadErrorUnknown', 'Unknown error');
  };

  let ipcUnavailableState = null;
  let renderNleOverviewTooltip = null;
  let rerenderSummaryState = null;

  const bindNleI18nHandlers = () => {
    if (!window.i18n?.on) return false;

    if (!window.__LEAD_NLE_IPC_UNAVAILABLE_I18N_BOUND__) {
      window.__LEAD_NLE_IPC_UNAVAILABLE_I18N_BOUND__ = true;
      window.i18n.on('languageChanged', rerenderIpcUnavailable);
      window.i18n.on('initialized', rerenderIpcUnavailable);
      window.i18n.on('loaded', rerenderIpcUnavailable);
    }

    if (typeof renderNleOverviewTooltip === 'function' && !window.__LEAD_NLE_OVERVIEW_TOOLTIP_I18N_BOUND__) {
      window.__LEAD_NLE_OVERVIEW_TOOLTIP_I18N_BOUND__ = true;
      window.i18n.on('languageChanged', renderNleOverviewTooltip);
      window.i18n.on('initialized', renderNleOverviewTooltip);
      window.i18n.on('loaded', renderNleOverviewTooltip);
    }

    if (typeof rerenderSummaryState === 'function' && !window.__LEAD_NLE_SUMMARY_STATE_I18N_BOUND__) {
      window.__LEAD_NLE_SUMMARY_STATE_I18N_BOUND__ = true;
      window.i18n.on('languageChanged', rerenderSummaryState);
      window.i18n.on('initialized', rerenderSummaryState);
      window.i18n.on('loaded', rerenderSummaryState);
    }

    if (!window.__LEAD_NLE_PRESET_DROPDOWN_I18N_BOUND__) {
      const refreshPresetDropdownI18n = () => {
        refreshPresetDropdown().catch(err => {
          console.error('Failed to refresh NLE Utilities presets for i18n:', err);
        });
      };
      window.__LEAD_NLE_PRESET_DROPDOWN_I18N_BOUND__ = true;
      window.i18n.on('languageChanged', refreshPresetDropdownI18n);
      window.i18n.on('initialized', refreshPresetDropdownI18n);
      window.i18n.on('loaded', refreshPresetDropdownI18n);
      if (window.i18n.isInitialized) {
        refreshPresetDropdownI18n();
      }
    }

    return !!(
      window.__LEAD_NLE_IPC_UNAVAILABLE_I18N_BOUND__
      && window.__LEAD_NLE_OVERVIEW_TOOLTIP_I18N_BOUND__
      && window.__LEAD_NLE_SUMMARY_STATE_I18N_BOUND__
      && window.__LEAD_NLE_PRESET_DROPDOWN_I18N_BOUND__
    );
  };

  bindNleI18nHandlers();

  setTimeout(bindNleI18nHandlers, 0);

  let nleI18nBindAttempts = 0;
  const nleI18nBindMaxAttempts = 25;
  const nleI18nBindRetryIntervalMs = 200;
  const nleI18nBindInterval = setInterval(() => {
    nleI18nBindAttempts += 1;
    if (bindNleI18nHandlers() || nleI18nBindAttempts >= nleI18nBindMaxAttempts) {
      clearInterval(nleI18nBindInterval);
    }
  }, nleI18nBindRetryIntervalMs);

  function renderIpcUnavailable(reason, missingFns = []) {
    try {
      const panelRoot = document.querySelector('#nle-utilities .section') || document.getElementById('nle-utilities');
      if (!panelRoot) return;

      // Disable all interactive controls inside the panel
      panelRoot.querySelectorAll('button, input, select, textarea').forEach(el => {
        try { el.disabled = true; } catch { /* ignore */ }
      });

      // Note: keep external assistant links clickable even when IPC is unavailable.

      const existingAlert = panelRoot.querySelector('[data-nle-ipc-warning="true"]');
      const alert = existingAlert || document.createElement('div');

      alert.className = 'alert warning';
      alert.setAttribute('data-nle-ipc-warning', 'true');
      const details = missingFns.length
        ? `\n\n${getLocalizedText('nleIpcMissingFunctions', 'Missing IPC functions: {{functions}}', {
          functions: missingFns.join(', ')
        })}`
        : '';
      alert.textContent = getLocalizedText(
        'nleIpcUnavailableMessage',
        'NLE Utilities is unavailable because the IPC bridge did not load correctly.\n\n{{reason}}{{details}}',
        {
          reason,
          details
        }
      );
      if (!existingAlert) {
        panelRoot.prepend(alert);
      }
    } catch (e) {
      // Last-resort: never throw from the guard
      console.error('Failed to render IPC unavailable state for NLE Utilities:', e);
    }
  }

  function rerenderIpcUnavailable() {
    if (!ipcUnavailableState) return;

    const missingFns = [
      ...(ipcUnavailableState.missingFns || []),
      ...(ipcUnavailableState.missingFsCapabilities || []).map(capability => getLocalizedText(capability.key, capability.fallback))
    ];

    renderIpcUnavailable(
      getLocalizedText(ipcUnavailableState.reasonKey, ipcUnavailableState.reasonFallback),
      missingFns
    );
  }

  const bindIpcUnavailableI18nHandlers = () => {
    bindNleI18nHandlers();
  };

  const enterIpcUnavailableState = (state) => {
    ipcUnavailableState = state;
    rerenderIpcUnavailable();
    bindIpcUnavailableI18nHandlers();
  };

  const REQUIRED_IPC_FNS = [
    // path primitives used throughout this panel
    'joinPath',
    'resolvePath',
    // Needed for Adobe scope resolution (true OS path resolving)
    'pathResolve',
    'basename',
    'extname',
    'relative',
    'isAbsolute',
    'sep',
    // dialogs/panel wiring
    'selectFolder',
    'openFile',
    'saveFile',
    'showConfirm',
    // misc
    'expandPaths',
    'invoke',
    'send',
    'isMediaComposerRunning'
  ];

  const FS_CAPABILITY_REQUIREMENTS = [
    { key: 'nleIpcCapabilityReaddir', fallback: 'readdirAsync || readdir', has: (bridge) => typeof bridge?.readdirAsync === 'function' || typeof bridge?.readdir === 'function' },
    { key: 'nleIpcCapabilityMkdir', fallback: 'mkdirAsync || mkdir', has: (bridge) => typeof bridge?.mkdirAsync === 'function' || typeof bridge?.mkdir === 'function' },
    { key: 'nleIpcCapabilityCopyFile', fallback: 'copyFileAsync || copyFile', has: (bridge) => typeof bridge?.copyFileAsync === 'function' || typeof bridge?.copyFile === 'function' },
    { key: 'nleIpcCapabilityReadTextFile', fallback: 'readTextFileAsync || readTextFile', has: (bridge) => typeof bridge?.readTextFileAsync === 'function' || typeof bridge?.readTextFile === 'function' },
    { key: 'nleIpcCapabilityWriteTextFile', fallback: 'writeTextFileAsync || writeTextFile', has: (bridge) => typeof bridge?.writeTextFileAsync === 'function' || typeof bridge?.writeTextFile === 'function' },
    { key: 'nleIpcCapabilityFileExists', fallback: 'fileExistsAsync || fileExists', has: (bridge) => typeof bridge?.fileExistsAsync === 'function' || typeof bridge?.fileExists === 'function' },
    { key: 'nleIpcCapabilityStat', fallback: 'fsStat || statSync', has: (bridge) => typeof bridge?.fsStat === 'function' || typeof bridge?.statSync === 'function' }
  ];

  if (!ipc) {
    enterIpcUnavailableState({
      reasonKey: 'nleIpcMissingObject',
      reasonFallback: 'IPC object not found (preload missing or blocked).',
      missingFns: [],
      missingFsCapabilities: []
    });
    return;
  }

  const missingFns = REQUIRED_IPC_FNS.filter(fn => typeof ipc?.[fn] !== 'function');
  const missingFsCapabilities = FS_CAPABILITY_REQUIREMENTS
    .filter(capability => !capability.has(ipc));
  if (missingFns.length) {
    enterIpcUnavailableState({
      reasonKey: 'nleIpcIncompleteObject',
      reasonFallback: 'IPC object is present but incomplete (preload corruption or sandbox restrictions).',
      missingFns,
      missingFsCapabilities: []
    });
    return;
  }
  if (missingFsCapabilities.length) {
    enterIpcUnavailableState({
      reasonKey: 'nleIpcIncompleteObject',
      reasonFallback: 'IPC object is present but incomplete (preload corruption or sandbox restrictions).',
      missingFns: [],
      missingFsCapabilities
    });
    return;
  }

  const fs = {
    readdir: (dir, opts) => {
      if (typeof ipc?.readdirAsync === 'function') return ipc.readdirAsync(dir, opts || {});
      return Promise.resolve(ipc.readdir(dir, opts || {}) || []);
    },
    readdirWithTypes: (dir) => {
      if (typeof ipc?.readdirWithTypesAsync === 'function') return ipc.readdirWithTypesAsync(dir);
      if (typeof ipc?.readdirWithTypes === 'function') return Promise.resolve(ipc.readdirWithTypes(dir));

      // ✅ Compat: modern preload exposes readdirAsync(dir, { withFileTypes: true })
      // (Dirent objects are serialized in the main process).
      if (typeof ipc?.readdirAsync === 'function') return ipc.readdirAsync(dir, { withFileTypes: true });
      if (typeof ipc?.readdir === 'function') return Promise.resolve(ipc.readdir(dir, { withFileTypes: true }) || []);

      return Promise.resolve([]);
    },
    unlink: (filePath) => {
      if (typeof ipc?.unlinkAsync === 'function') return ipc.unlinkAsync(filePath);
      return Promise.resolve(ipc.unlink(filePath));
    },
    mkdir: (dir) => {
      if (typeof ipc?.mkdirAsync === 'function') return ipc.mkdirAsync(dir);
      return Promise.resolve(ipc.mkdir(dir));
    },
    copyFile: (src, dest) => {
      if (typeof ipc?.copyFileAsync === 'function') return ipc.copyFileAsync(src, dest);
      return Promise.resolve(ipc.copyFile(src, dest));
    },
    writeFile: (filePath, content, encoding) => {
      if (typeof ipc?.writeTextFileAsync === 'function') return ipc.writeTextFileAsync(filePath, content, encoding);
      return Promise.resolve(ipc.writeTextFile(filePath, content, encoding));
    },
    readFile: (filePath, encoding) => {
      if (typeof ipc?.readTextFileAsync === 'function') return ipc.readTextFileAsync(filePath, encoding);
      return Promise.resolve(ipc.readTextFile(filePath, encoding));
    },
    exists: async (filePath) => {
      if (typeof ipc?.fileExistsAsync === 'function') return !!(await ipc.fileExistsAsync(filePath));
      return !!ipc.fileExists(filePath);
    },
    stat: async (filePath) => {
      if (typeof ipc?.fsStat === 'function') return ipc.fsStat(filePath);
      return ipc.statSync(filePath);
    }
  };

  const path = {
    join: ipc.joinPath,
    // IMPORTANT: use true OS path resolver for user-selected filesystem paths.
    resolve: ipc.pathResolve,
    basename: ipc.basename,
    extname: ipc.extname,
    relative: (...args) => ipc.relative(...args),
    isAbsolute: (value) => ipc.isAbsolute(value),
    sep: typeof ipc.sep === 'function' ? ipc.sep() : ipc.sep
  };

  const readdirAsync = fs.readdir;
  const mkdirpAsync = fs.mkdir;

  // ---------------------------------------------------------------
  // 🔐 Path approval helper
  //
  // Renderer filesystem operations are intentionally locked down.
  // Paths coming from native dialogs are auto-approved, but paths
  // loaded from presets or typed/pasted into inputs are NOT.
  //
  // NLE Utilities actions are destructive (unlink), and already
  // require a confirmation prompt, so we silently approve the chosen
  // root folder right before scanning/deleting.
  // ---------------------------------------------------------------
  async function ensureApprovedDir(dirPath, label = 'folder') {
    const raw = String(dirPath || '').trim();
    if (!raw) {
      return {
        ok: false,
        messageEntry: {
          key: 'nleApprovePathEmpty',
          fallback: '❌ No {{label}} path provided.',
          params: { label }
        }
      };
    }

    try {
      if (typeof path?.isAbsolute === 'function' && !path.isAbsolute(raw)) {
        return {
          ok: false,
          messageEntry: {
            key: 'nleApprovePathMustBeAbsolute',
            fallback: '❌ {{label}} path must be an absolute filesystem path. Use Select Folder.',
            params: { label }
          }
        };
      }
    } catch {
      // If isAbsolute blows up for some reason, just fall through to approval.
    }

    try {
      // Prefer the direct bridge helper when present.
      const approved = (typeof ipc?.approvePaths === 'function')
        ? await ipc.approvePaths([raw], { kind: 'dir', confirm: false })
        : await ipc.invoke('approve-paths', [raw], { kind: 'dir', confirm: false });

      if (!Array.isArray(approved) || approved.length === 0) {
        return {
          ok: false,
          messageEntry: {
            key: 'nleApprovePathDenied',
            fallback: '❌ Access to {{label}} was not approved: {{path}}',
            params: { label, path: raw }
          }
        };
      }

      return { ok: true, approvedPath: approved[0] };
    } catch (err) {
      const message = err?.message || String(err);
      return {
        ok: false,
        messageEntry: {
          key: 'nleApprovePathFailed',
          fallback: '❌ Failed to approve {{label}} path: {{error}}',
          params: { label, error: message }
        }
      };
    }
  }

  // Panel presets are managed via IPC:
  // list-panel-presets / read-panel-preset / write-panel-preset / delete-panel-preset

  // Helper to verify standard Avid MediaFiles path
  const isAvidMxfPath = (dir) => {
    const normalized = dir.replace(/\\/g, '/');
    return /\/Avid MediaFiles\/MXF(\/|$)/i.test(normalized);
  };

  const isAvidMxfRoot = (dir) => {
    const normalized = dir.replace(/\\/g, '/').replace(/[\\/]+$/, '');
    return /\/Avid MediaFiles\/MXF$/i.test(normalized);
  };

  const isAvidMediaFilesRoot = (dir) => {
    const normalized = dir.replace(/\\/g, '/').replace(/[\\/]+$/, '');
    return /\/Avid MediaFiles$/i.test(normalized);
  };

  // Context-bridge safe: IPC cannot transfer Node's Dirent/Stats methods.
  // Our hardened preload returns plain objects with boolean flags.
  const isDirectoryLike = (obj) => {
    if (!obj) return false;
    try {
      if (typeof obj.isDirectory === 'function') return !!obj.isDirectory();
    } catch {
      // ignore
    }
    return obj.isDirectory === true;
  };

  const isExistingDirectory = async (dir) => {
    try {
      // IMPORTANT:
      // Using fs.stat() as an existence probe is fine in plain Node, but in this app
      // it goes through an IPC handler (fs:stat). When stat() hits a missing path,
      // the main-process handler throws ENOENT and Electron logs:
      //   "Error occurred in handler for 'fs:stat' ..."
      // even if the renderer catches it.
      //
      // So we do a quiet exists() check first and only stat() when the path exists.
      if (!(await fs.exists(dir))) return false;
      return isDirectoryLike(await fs.stat(dir));
    } catch {
      return false;
    }
  };

  const resolveAvidSettingsBase = async (selectedFolder) => {
  const baseFolderRaw = String(selectedFolder || '').trim();
  if (!baseFolderRaw) {
    return {
      ok: false,
      messageEntry: {
        key: 'avidSelectFolderFirst',
        fallback: 'Select an Avid folder first.',
        params: {}
      }
    };
  }

  // Normalize trailing separators for stable checks.
  const normalized = baseFolderRaw.replace(/\\/g, '/').replace(/[\\/]+$/, '');
  const leaf = normalized.split('/').pop().toLowerCase();

  // If the user picked "Settings" or "Avid Users" directly, treat its parent as the base.
  // If the user picked an individual user folder inside "Avid Users/<name>", treat the grandparent as the base.
  // (This keeps the picker flexible: selecting either the root, the Users folder, or a specific user folder works.)
  const LEAF_BASE_NAMES = new Set(['settings', 'avid users', 'avid_users', 'users', 'site_settings', 'site settings']);
  const parentNormalized = path
    .resolve(baseFolderRaw, '..')
    .replace(/\\/g, '/')
    .replace(/[\\/]+$/, '');
  const parentLeaf = parentNormalized.split('/').pop().toLowerCase();

  let baseCandidate = baseFolderRaw;

  if (LEAF_BASE_NAMES.has(leaf)) {
    baseCandidate = path.resolve(baseFolderRaw, '..');
  } else if (parentLeaf === 'avid users' || parentLeaf === 'avid_users') {
    baseCandidate = path.resolve(baseFolderRaw, '..', '..');
  } else if (parentLeaf === 'users' || parentLeaf === 'site_settings' || parentLeaf === 'site settings') {
    // Legacy-style selection of an individual user folder under <base>/Users/<name>
    baseCandidate = path.resolve(baseFolderRaw, '..', '..');
  }


  // 🔐 Ensure we can access the computed base (and its siblings).
  // This fixes the common case where the user selects "Settings" or a specific
  // user folder; the native dialog approves only that folder, not the parent.
  const baseApproval = await ensureApprovedDir(
    baseCandidate,
    getLocalizedText('avidSettingsBaseLabel', 'Avid settings base')
  );
  if (!baseApproval.ok) {
    return {
      ok: false,
      messageEntry: {
        key: baseApproval.messageEntry?.key || '',
        fallback: baseApproval.messageEntry?.fallback || '',
        params: baseApproval.messageEntry?.params || {}
      }
    };
  }
  if (baseApproval.approvedPath) {
    baseCandidate = baseApproval.approvedPath;
  }

  // ✅ Avid documented layout: <root>/Settings and <root>/Avid Users
  const settingsFolder = path.join(baseCandidate, 'Settings');
  const avidUsersFolder = path.join(baseCandidate, 'Avid Users');

  const hasSettings = await isExistingDirectory(settingsFolder);
  const hasAvidUsers = await isExistingDirectory(avidUsersFolder);

  if (hasSettings && hasAvidUsers) {
    return {
      ok: true,
      layout: 'avid-docs',
      baseFolder: baseCandidate,
      settingsFolder,
      usersFolder: avidUsersFolder
    };
  }

  // ♻️ Legacy panel layout: <base>/Site_Settings and <base>/Users
  const legacyUsersFolder = path.join(baseCandidate, 'Users');
  const legacySiteFolder = path.join(baseCandidate, 'Site_Settings');

  const hasLegacyUsers = await isExistingDirectory(legacyUsersFolder);
  const hasLegacySite = await isExistingDirectory(legacySiteFolder);

  if (hasLegacyUsers && hasLegacySite) {
    return {
      ok: true,
      layout: 'legacy-panel',
      baseFolder: baseCandidate,
      settingsFolder: legacySiteFolder,
      usersFolder: legacyUsersFolder
    };
  }

  const looksLikeMediaFolder = isAvidMxfPath(baseCandidate)
    || isAvidMediaFilesRoot(baseCandidate)
    || isAvidMxfRoot(baseCandidate);

  const platform = String(ipc?.platform || '').toLowerCase();
  const defaultSettingsRootHint =
    platform === 'darwin'
      ? 'For Site/User Settings resets, select the Avid application folder that contains both "Settings" and "Avid Users" (macOS example: /Users/Shared/AvidMediaComposer).'
      : platform === 'win32'
        ? 'For Site/User Settings resets, select the Avid application folder that contains both "Settings" and "Avid Users" (Windows default: C:\\Users\\Public\\Public Documents\\Avid Media Composer).'
        : 'For Site/User Settings resets, select the Avid application folder that contains both "Settings" and "Avid Users".';


  return {
    ok: false,
    settingsFolder,
    usersFolder: avidUsersFolder,
    legacyUsersFolder,
    legacySiteFolder,
    messageEntries: [
      {
        key: 'avidSettingsRootNotFound',
        fallback: 'Missing required folders for Site/User Settings resets:',
        params: {}
      },
      {
        key: 'avidSettingsBasePath',
        fallback: '{{path}}',
        params: { path: baseCandidate }
      },
      looksLikeMediaFolder
        ? {
          key: 'avidSelectHintSettingsInsteadOfMedia',
          fallback: 'You selected an Avid media folder. For Site/User Settings resets, select the Avid application folder that contains both "Settings" and "Avid Users".',
          params: {}
        }
        : {
          key: 'avidSelectHintSettingsRoot',
          fallback: defaultSettingsRootHint,
          params: {}
        },
      {
        key: 'avidSelectHintMediaDb',
        fallback: 'For Media Database actions, select an "Avid MediaFiles/MXF" folder on your media drive instead.',
        params: {}
      }
    ]
  };
};

// Back-compat: existing handlers use this name
const validateAvidSettingsBase = resolveAvidSettingsBase;

  // ===============================
// 🧵 Helpers: Traverse without freezing the UI
// ===============================

// Yield control back to the browser so the UI can repaint during huge loops.
const yieldToUI = () => new Promise(resolve => {
  try {
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(() => resolve());
    }
  } catch {
    // ignore
  }
  setTimeout(resolve, 0);
});

// Safe wrappers around sync IPC reads (never throw).
async function safeReaddirWithTypes(dir) {
  try {
    const entries = await fs.readdirWithTypes(dir);
    return Array.isArray(entries) ? entries : [];
  } catch (err) {
    console.warn('⚠️ readdirWithTypes failed:', dir, err);
    return [];
  }
}

async function safeReaddir(dir) {
  try {
    const entries = await fs.readdir(dir);
    return Array.isArray(entries) ? entries : [];
  } catch (err) {
    console.warn('⚠️ readdir failed:', dir, err);
    return [];
  }
}

// ===============================
// 🔁 Helper: Recursively collect all files (async, non-blocking UI)
// Uses main-process worker traversal via `expand-paths` when available.
// Falls back to sync traversal with defensive error handling.
// ===============================
function normalizeFilterExtensions(extensions = []) {
  return Array.from(
    new Set(
      (Array.isArray(extensions) ? extensions : [])
        .map(ext => String(ext || '').trim())
        .filter(Boolean)
        .map(ext => (ext.startsWith('.') ? ext : `.${ext}`))
        .map(ext => ext.toLowerCase())
        .filter(ext => ext.length > 1)
    )
  );
}

function fileMatchesExtensions(filePath, extensions = []) {
  if (!extensions.length) return true;
  const lower = String(filePath || '').toLowerCase();
  return extensions.some(ext => lower.endsWith(ext));
}

async function readdirRecursive(baseDir, options = {}) {
  const cfg = {
    // Be generous for NLE environments, but keep a hard ceiling to avoid runaway memory use.
    maxDepth: 99,
    maxFiles: 500000,
    timeoutMs: 180000,
    skipHidden: true,
    yieldEvery: 250,
    allowSyncFallback: false,
    includeMetadata: false,
    ...(options && typeof options === 'object' ? options : {})
  };
  const normalizedExtensions = normalizeFilterExtensions(cfg.includeExtensions);

  // Preferred path: one async IPC call (keeps renderer responsive).
  try {
    const res = await ipc.expandPaths([baseDir], {
      ...cfg,
      includeExtensions: normalizedExtensions,
      includeMetadata: !!cfg.includeMetadata
    });
    if (res && res.success && Array.isArray(res.files)) {
      const filtered = normalizedExtensions.length
        ? res.files.filter(file => fileMatchesExtensions(file, normalizedExtensions))
        : res.files;
      const metadataByPath = cfg.includeMetadata
        ? (res.metadataByPath && typeof res.metadataByPath === 'object' ? res.metadataByPath : null)
        : null;
      const filteredMetadata = metadataByPath
        ? filtered.reduce((acc, filePath) => {
          if (Object.prototype.hasOwnProperty.call(metadataByPath, filePath)) {
            acc[filePath] = metadataByPath[filePath];
          }
          return acc;
        }, {})
        : null;
      return {
        files: filtered,
        metadataByPath: filteredMetadata,
        truncated: !!res.truncated,
        timedOut: !!res.timedOut,
        scanFailed: false,
        scanError: null
      };
    }
    if (!cfg.allowSyncFallback) {
      console.warn('⚠️ expand-paths failed; sync fallback disabled:', res);
      return {
        files: [],
        metadataByPath: null,
        truncated: false,
        timedOut: false,
        scanFailed: true,
        scanError: (res && typeof res === 'object' && typeof res.error === 'string' && res.error.trim())
          ? res.error
          : 'expand-paths failed'
      };
    }
    console.warn('⚠️ expand-paths failed; falling back to sync traversal:', res);
  } catch (err) {
    if (!cfg.allowSyncFallback) {
      console.warn('⚠️ expand-paths failed; sync fallback disabled:', err);
      return {
        files: [],
        metadataByPath: null,
        truncated: false,
        timedOut: false,
        scanFailed: true,
        scanError: err?.message || String(err)
      };
    }
    console.warn('⚠️ expand-paths failed; falling back to sync traversal:', err);
  }

  // Fallback path (legacy): sync traversal but never throw.
  const results = [];
  const metadataByPath = cfg.includeMetadata ? {} : null;
  const startTime = Date.now();
  let fileCount = 0;
  let truncated = false;
  let timedOut = false;
  const hasTimedOut = () => Date.now() - startTime > cfg.timeoutMs;
  const shouldStop = () => truncated || timedOut;
  const isSymlinkLike = entry =>
    entry?.isSymbolicLink === true ||
    (typeof entry?.isSymbolicLink === 'function' && entry.isSymbolicLink());
  let entryCounter = 0;
  const walk = async (dir, depth) => {
    if (shouldStop()) return;
    if (hasTimedOut()) {
      timedOut = true;
      return;
    }
    if (depth > cfg.maxDepth) {
      truncated = true;
      return;
    }

    const entries = await safeReaddirWithTypes(dir);

    for (const entry of entries) {
      if (shouldStop()) return;
      if (hasTimedOut()) {
        timedOut = true;
        return;
      }

      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!name) continue;
      if (cfg.skipHidden && name.startsWith('.')) continue;
      const fullPath = path.join(dir, name);

      if (isSymlinkLike(entry)) continue;

      let isDir = false;
      if (typeof entry === 'string') {
        // Unknown shape; best-effort stat.
        try {
          const st = await fs.stat(fullPath);
          if (isSymlinkLike(st)) continue;
          isDir = isDirectoryLike(st);
        } catch {
          isDir = false;
        }
      } else {
        isDir = isDirectoryLike(entry);
        // If the object doesn't include type info, fall back to stat once.
        if (!isDir && entry && typeof entry === 'object' && !('isDirectory' in entry) && typeof entry.isDirectory !== 'function') {
          try {
            const st = await fs.stat(fullPath);
            if (isSymlinkLike(st)) continue;
            isDir = isDirectoryLike(st);
          } catch {
            isDir = false;
          }
        }
      }

      if (isDir) {
        await walk(fullPath, depth + 1);
      } else {
        if (fileCount >= cfg.maxFiles) {
          truncated = true;
          return;
        }
        if (fileMatchesExtensions(fullPath, normalizedExtensions)) {
          results.push(fullPath);
          fileCount += 1;
          if (metadataByPath) {
            try {
              const st = await fs.stat(fullPath);
              metadataByPath[fullPath] = {
                size: Number(st.size) || 0,
                mtimeMs: Number(st.mtimeMs) || 0
              };
            } catch {
              metadataByPath[fullPath] = null;
            }
          }
          if (fileCount >= cfg.maxFiles) {
            truncated = true;
          }
        }
      }

      entryCounter += 1;
      if (cfg.yieldEvery > 0 && entryCounter % cfg.yieldEvery === 0) {
        await yieldToUI();
      }
    }
  };

  await walk(baseDir, 0);
  return {
    files: results,
    metadataByPath,
    truncated,
    timedOut,
    scanFailed: false,
    scanError: null
  };
}

  // ===============================
  // 📁 Avid: MXF Folder Picker
  // ===============================

const avid = {
  selectBtn: document.getElementById('avid-select-folder'),
  pathField: document.getElementById('avid-folder-path'),
  summary: document.getElementById('avid-summary'),
  userSelect: document.getElementById('avid-user-select')
};

const SUMMARY_MODE_DEFAULT = 'default';
const SUMMARY_MODE_SELECTED_FOLDER = 'selected-folder';
const SUMMARY_MODE_CANCELED = 'selection-canceled';

const avidSummaryState = {
  mode: SUMMARY_MODE_DEFAULT,
  selectedFolder: '',
  entries: []
};

const adobeSummaryState = {
  mode: SUMMARY_MODE_DEFAULT,
  selectedFolder: '',
  entries: []
};

const SUMMARY_ENTRY_TYPE_MESSAGE = 'message';
const SUMMARY_ENTRY_TYPE_BUSY = 'busy';
const SUMMARY_ENTRY_TYPE_BATCH = 'batch';
const SUMMARY_ENTRY_TYPE_RAW = 'raw';

const createSummaryEntry = ({
  key = '',
  fallback = '',
  params = {},
  type = SUMMARY_ENTRY_TYPE_MESSAGE,
  entries = [],
  separator = '',
  prefix = '',
  suffix = '',
  rawText = '',
  isLocalizedRaw = false
} = {}) => ({
  key,
  fallback,
  params,
  type,
  entries,
  separator,
  prefix,
  suffix,
  rawText,
  isLocalizedRaw
});

const renderSummaryState = ({ summaryEl, state, buildBaseline }) => {
  if (!summaryEl || !state || typeof buildBaseline !== 'function') return;

  const baseline = buildBaseline(state);
  const messageBody = (state.entries || [])
    .map((entry) => {
      if (!entry) return '';
      if (entry.type === SUMMARY_ENTRY_TYPE_BATCH) {
        const batchLines = (entry.entries || [])
          .map((line) => {
            if (!line || (!line.key && !line.fallback)) return '';
            return getLocalizedText(line.key, line.fallback || '', line.params || {});
          })
          .filter(Boolean)
          .join(typeof entry.separator === 'string' ? entry.separator : '\n');

        if (!batchLines) return '';
        return `${entry.prefix || ''}${batchLines}${entry.suffix || ''}`;
      }

      if (entry.type === SUMMARY_ENTRY_TYPE_RAW) {
        if (entry.isLocalizedRaw) {
          return getLocalizedText(entry.key || '', entry.fallback || entry.rawText || '', entry.params || {});
        }

        // Compatibility path for truly non-localizable/raw text. These entries
        // are stored as rendered text and will not change during i18n rerenders.
        return entry.rawText || '';
      }

      if (!entry.key && !entry.fallback) return '';
      return getLocalizedText(entry.key, entry.fallback || '', entry.params || {});
    })
    .join('');

  summaryEl.textContent = `${baseline}${messageBody}`;
};

const appendSummaryEntry = ({ state, render }, key = '', fallback = '', params = {}, options = {}) => {
  if (!state) return;
  if (!key && !fallback) return;
  state.entries.push(createSummaryEntry({
    key,
    fallback,
    params,
    type: options.type || SUMMARY_ENTRY_TYPE_MESSAGE
  }));
  render();
};

const appendSummaryRawEntry = ({ state, render }, text = '', options = {}) => {
  if (!state) return;
  if (!text) return;
  const isLocalizedRaw = options.isLocalizedRaw === true;
  state.entries.push(createSummaryEntry({
    type: options.type || SUMMARY_ENTRY_TYPE_RAW,
    rawText: text,
    isLocalizedRaw,
    key: isLocalizedRaw ? (options.key || '') : '',
    fallback: isLocalizedRaw ? (options.fallback || text) : '',
    params: isLocalizedRaw ? (options.params || {}) : {}
  }));
  render();
};

const appendSummaryBatchEntry = ({ state, render }, entries = [], options = {}) => {
  if (!state || !Array.isArray(entries) || entries.length === 0) return;
  state.entries.push(createSummaryEntry({
    type: SUMMARY_ENTRY_TYPE_BATCH,
    entries,
    separator: options.separator,
    prefix: options.prefix,
    suffix: options.suffix
  }));
  render();
};

const removeSummaryEntriesByType = ({ state, render }, type) => {
  if (!state?.entries) return;
  const nextEntries = state.entries.filter(entry => entry?.type !== type);
  if (nextEntries.length === state.entries.length) return;
  state.entries = nextEntries;
  render();
};

const appendAvidSummaryEntry = (key, fallback = '', params = {}, options = {}) => {
  appendSummaryEntry({ state: avidSummaryState, render: renderAvidSummaryState }, key, fallback, params, options);
};

const appendAdobeSummaryEntry = (key, fallback = '', params = {}, options = {}) => {
  appendSummaryEntry({ state: adobeSummaryState, render: renderAdobeSummaryState }, key, fallback, params, options);
};

const appendAdobeSummaryBatch = (entries = [], options = {}) => {
  appendSummaryBatchEntry({ state: adobeSummaryState, render: renderAdobeSummaryState }, entries, options);
};

const appendAvidSummaryMessage = (key, fallback = '', params = {}) => appendAvidSummaryEntry(key, fallback, params);
const appendAdobeSummaryMessage = (key, fallback = '', params = {}) => appendAdobeSummaryEntry(key, fallback, params);
const _appendAvidSummaryText = (text, options = {}) => appendSummaryRawEntry({ state: avidSummaryState, render: renderAvidSummaryState }, text, options);
const appendAdobeSummaryText = (text, options = {}) => appendSummaryRawEntry({ state: adobeSummaryState, render: renderAdobeSummaryState }, text, options);
const getMessageEntryText = (entry) => {
  if (!entry) return '';
  return getLocalizedText(entry.key || '', entry.fallback || '', entry.params || {});
};
const appendAvidSummaryDescriptors = ({ messageEntry, messageEntries } = {}) => {
  if (Array.isArray(messageEntries) && messageEntries.length > 0) {
    messageEntries.forEach((entry) => {
      if (!entry || (!entry.key && !entry.fallback)) return;
      appendAvidSummaryMessage(
        entry.key || '',
        `\n${entry.fallback || ''}`,
        entry.params || {}
      );
    });
    return;
  }

  if (messageEntry && (messageEntry.key || messageEntry.fallback)) {
    appendAvidSummaryMessage(
      messageEntry.key || '',
      `\n${messageEntry.fallback || ''}`,
      messageEntry.params || {}
    );
  }
};

const renderAvidSummaryState = () => {
  renderSummaryState({
    summaryEl: avid.summary,
    state: avidSummaryState,
    buildBaseline: (state) => {
      if (state.mode === SUMMARY_MODE_SELECTED_FOLDER) {
        return getLocalizedText(
          'avidSelectedFolder',
          '📂 Selected Avid folder:\n{{folder}}',
          { folder: state.selectedFolder || '' }
        );
      }

      if (state.mode === SUMMARY_MODE_CANCELED) {
        return getLocalizedText(
          'nleFolderSelectionCanceled',
          '⚠️ Folder selection canceled.'
        );
      }

      return getLocalizedText('avidSummary', '');
    }
  });
};

const renderAdobeSummaryState = () => {
  renderSummaryState({
    summaryEl: adobe.summary,
    state: adobeSummaryState,
    buildBaseline: (state) => {
      if (state.mode === SUMMARY_MODE_SELECTED_FOLDER) {
        return getLocalizedText(
          'adobeSelectedFolder',
          '📂 Selected Adobe folder:\n{{folder}}',
          { folder: state.selectedFolder || '' }
        );
      }

      if (state.mode === SUMMARY_MODE_CANCELED) {
        return getLocalizedText(
          'nleFolderSelectionCanceled',
          '⚠️ Folder selection canceled.'
        );
      }

      return getLocalizedText('adobeSummary', '');
    }
  });
};

const setAvidUserPlaceholder = () => {
  if (!avid.userSelect) return;
  avid.userSelect.innerHTML = '';
  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.setAttribute('data-i18n', 'selectUser');
  placeholderOption.textContent = getLocalizedText('selectUser', 'Select user');
  avid.userSelect.appendChild(placeholderOption);
  window.translatePage?.();
};

function logNLE(msg, opts = {}) {
  window.logPanel?.log('nle-utilities', msg, opts);
}

function appendAvidTraversalWarning(key, fallback, params = {}) {
  const msg = getLocalizedText(key, fallback, params);
  logNLE(msg, { isWarning: true });
  appendAvidSummaryMessage(key, `\n${fallback}`, params);
}

const getMediaComposerStateWarning = () => getLocalizedText(
  'avidMediaComposerCheckFailed',
  '⚠️ Unable to verify Media Composer state; please ensure it is closed before continuing.'
);

const checkMediaComposerRunning = async (summaryTarget) => {
  try {
    const result = await ipc.isMediaComposerRunning?.();
    return result === true;
  } catch {
    const warningMsg = getMediaComposerStateWarning();
    logNLE(warningMsg, { isWarning: true });
    if (summaryTarget === avid.summary) {
      appendAvidSummaryMessage(
        'avidMediaComposerCheckFailed',
        '\n⚠️ Unable to verify Media Composer state; please ensure it is closed before continuing.'
      );
    } else if (summaryTarget === adobe.summary) {
      appendAdobeSummaryMessage(
        'avidMediaComposerCheckFailed',
        '\n⚠️ Unable to verify Media Composer state; please ensure it is closed before continuing.'
      );
    }
    return false;
  }
};

const avidSection = avid.summary?.closest('details');
const adobeSection = document.getElementById('adobe-summary')?.closest('details');
const getAvidBusyMessageEntry = () => ({ key: 'avidBusyMessage', fallback: '🔄 Avid operation in progress…', params: {} });
const AVID_TRIGGER_CLEANUP_DELAY_MS = 15000;

const buildAvidRebuildTriggerPath = (folder, attempt = 0) => {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const attemptSuffix = attempt > 0 ? `_${attempt}` : '';
  return path.join(folder, `REBUILD_TRIGGER_${timestamp}_${randomSuffix}${attemptSuffix}.mxf`);
};

const createAvidRebuildTriggerFile = async (folder, maxAttempts = 5) => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = buildAvidRebuildTriggerPath(folder, attempt);
    if (await fs.exists(candidate)) {
      continue;
    }
    await fs.writeFile(candidate, 'Avid Rebuild Trigger');
    return candidate;
  }
  throw new Error(getLocalizedText(
    'avidRebuildTriggerCreateFailed',
    'Unable to create unique rebuild trigger in {{folder}} after {{attempts}} attempts.',
    {
      folder,
      attempts: maxAttempts
    }
  ));
};

const scheduleAvidTriggerCleanup = (dummyFile) => {
  const delaySeconds = Math.round(AVID_TRIGGER_CLEANUP_DELAY_MS / 1000);
  if (avid.summary) {
    appendAvidSummaryMessage(
      'avidTriggerCleanupScheduled',
      '\n🧹 Trigger file will be removed in ~{{delaySeconds}}s.',
      { delaySeconds }
    );
  }
  setTimeout(async () => {
    let removed = false;
    try {
      if (await fs.exists(dummyFile)) {
        await fs.unlink(dummyFile);
        removed = true;
      }
    } catch (err) {
      console.warn('⚠️ Failed to remove Avid rebuild trigger file; please remove manually:', dummyFile, err);
    } finally {
      if (!removed && await fs.exists(dummyFile)) {
        console.warn('⚠️ Avid rebuild trigger file still exists; please remove manually:', dummyFile);
      }
    }
  }, AVID_TRIGGER_CLEANUP_DELAY_MS);
};
const getAdobeBusyMessageEntry = () => ({ key: 'adobeBusyMessage', fallback: '🔄 Adobe operation in progress…', params: {} });

const busyCounters = new WeakMap();

function setSectionBusyControls(section, isBusy) {
  if (!section) return;
  section.querySelectorAll('button, input, select, textarea').forEach((el) => {
    if (isBusy) {
      if (!el.disabled) {
        el.dataset.busyDisabled = 'true';
        el.disabled = true;
      }
    } else if (el.dataset.busyDisabled === 'true') {
      el.disabled = false;
      delete el.dataset.busyDisabled;
    }
  });
}

function resolveSummaryStateHandlers(summary) {
  if (summary === avid.summary) {
    return {
      appendEntry: (key, fallback, params = {}, options = {}) => appendAvidSummaryEntry(key, fallback, params, options),
      removeBusyEntries: () => removeSummaryEntriesByType({ state: avidSummaryState, render: renderAvidSummaryState }, SUMMARY_ENTRY_TYPE_BUSY)
    };
  }

  if (summary === adobe.summary) {
    return {
      appendEntry: (key, fallback, params = {}, options = {}) => appendAdobeSummaryEntry(key, fallback, params, options),
      removeBusyEntries: () => removeSummaryEntriesByType({ state: adobeSummaryState, render: renderAdobeSummaryState }, SUMMARY_ENTRY_TYPE_BUSY)
    };
  }

  return null;
}

function addBusyStatus(summary, messageEntry = { key: 'nleBusyMessage', fallback: '🔄 Operation in progress…', params: {} }) {
  const handlers = resolveSummaryStateHandlers(summary);
  if (!handlers) return;

  const entry = messageEntry && (messageEntry.key || messageEntry.fallback)
    ? messageEntry
    : { key: 'nleBusyMessage', fallback: '🔄 Operation in progress…', params: {} };

  handlers.removeBusyEntries();
  handlers.appendEntry(entry.key, `\n${entry.fallback || ''}`, entry.params || {}, {
    type: SUMMARY_ENTRY_TYPE_BUSY
  });
}

function removeBusyStatus(summary) {
  const handlers = resolveSummaryStateHandlers(summary);
  if (!handlers) return;
  handlers.removeBusyEntries();
}

async function withBusyState({ section, summary, messageEntry }, task) {
  if (typeof task !== 'function') return;
  if (!section) {
    addBusyStatus(summary, messageEntry);
    try {
      return await task();
    } finally {
      removeBusyStatus(summary);
    }
  }
  const currentCount = busyCounters.get(section) || 0;
  if (currentCount === 0) {
    setSectionBusyControls(section, true);
    addBusyStatus(summary, messageEntry);
  }
  busyCounters.set(section, currentCount + 1);

  try {
    return await task();
  } finally {
    const nextCount = (busyCounters.get(section) || 1) - 1;
    if (nextCount <= 0) {
      busyCounters.delete(section);
      setSectionBusyControls(section, false);
      removeBusyStatus(summary);
    } else {
      busyCounters.set(section, nextCount);
    }
  }
}

async function confirmNonStandardAvidFolders(folders, actionLabel) {
  const riskyFolders = folders.filter(folder => !isAvidMxfPath(folder));
  if (riskyFolders.length === 0) return true;

  const formattedList = riskyFolders.map(folder => `• ${folder}`).join('\n');
  const confirmMessage = [
    getLocalizedText('avidNonStandardHeader', '⚠️ Non-standard Avid MXF paths detected.'),
    '',
    getLocalizedText(
      'avidNonStandardDescription',
      'The following folder(s) are not in the standard /Avid MediaFiles/MXF/ structure and may be skipped by Media Composer or could be unintended targets:'
    ),
    '',
    formattedList,
    '',
    getLocalizedText('avidNonStandardProceed', 'Do you want to {{actionLabel}} anyway?', { actionLabel }),
    '',
    getLocalizedText('nleCancelDefaultChoice', 'Cancel is the default choice.')
  ].join('\n');

  const confirmed = await ipc.showConfirm?.(confirmMessage);
  if (!confirmed) {
    const cancelKey = 'avidNonStandardCanceled';
    const cancelFallback = '⛔ {{actionLabel}} canceled: non-standard MXF folder(s) detected.';
    const cancelParams = { actionLabel };
    const cancelMsg = getLocalizedText(cancelKey, cancelFallback, cancelParams);
    logNLE(cancelMsg);
    appendAvidSummaryMessage(cancelKey, `\n${cancelFallback}`, cancelParams);
    return false;
  }

  return true;
}

async function collectAvidFolders(baseFolder, options = {}) {
  const cfg = {
    includeSubfolders: false,
    maxDepth: 8,
    maxFolders: 2000,
    timeoutMs: 20000,
    yieldEvery: 25,
    ...(options && typeof options === 'object' ? options : {})
  };

  const folders = [];
  const stack = [{ dir: baseFolder, depth: 0 }];
  const startTime = Date.now();
  let hitMaxDepth = false;
  let hitMaxFolders = false;
  let timedOut = false;

  const isSymlinkLike = entry =>
    entry?.isSymbolicLink === true ||
    (typeof entry?.isSymbolicLink === 'function' && entry.isSymbolicLink());
  const hasTimedOut = () => Date.now() - startTime > cfg.timeoutMs;

  while (stack.length) {
    if (hasTimedOut()) {
      timedOut = true;
      break;
    }

    const { dir, depth } = stack.pop();
    folders.push(dir);

    if (folders.length >= cfg.maxFolders) {
      hitMaxFolders = true;
      break;
    }

    if (!cfg.includeSubfolders) continue;
    if (depth >= cfg.maxDepth) {
      hitMaxDepth = true;
      continue;
    }

    const entries = await safeReaddirWithTypes(dir);

    for (const entry of entries) {
      if (hasTimedOut()) {
        timedOut = true;
        break;
      }

      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!name) continue;
      const fullPath = path.join(dir, name);

      if (isSymlinkLike(entry)) continue;

      let isDir = isDirectoryLike(entry);
      if (!isDir && typeof entry === 'string') {
        try {
          const stats = await fs.stat(fullPath);
          if (isSymlinkLike(stats)) continue;
          isDir = isDirectoryLike(stats);
        } catch {
          isDir = !name.includes('.') && !name.startsWith('.');
        }
      } else if (!isDir && entry && typeof entry === 'object' && !('isDirectory' in entry) && typeof entry.isDirectory !== 'function') {
        try {
          const stats = await fs.stat(fullPath);
          if (isSymlinkLike(stats)) continue;
          isDir = isDirectoryLike(stats);
        } catch {
          isDir = false;
        }
      }

      if (isDir) {
        stack.push({ dir: fullPath, depth: depth + 1 });
      }
    }

    if (cfg.yieldEvery > 0 && folders.length % cfg.yieldEvery === 0) {
      await yieldToUI();
    }
  }

  return {
    folders,
    hitMaxDepth,
    hitMaxFolders,
    timedOut,
    cfg
  };
}

  async function buildAvidCountSummary(baseFolder, options = {}) {
    const {
      showCounts = false,
      scanSubfolders = false,
      maxDepth = 8,
      maxFolders = 2000,
      timeoutMs = 15000,
      yieldEvery = 25
    } = options;

    if (!showCounts) return '';

    const baseApproval = await ensureApprovedDir(
      baseFolder,
      getLocalizedText('avidFolderLabel', 'Avid folder')
    );
    if (!baseApproval.ok) {
      return {
        key: '',
        fallback: `
${baseApproval.error}`,
        params: {}
      };
    }


    const normalizePath = (p) => String(p || '').replace(/\\/g, '/').replace(/[\\/]+$/, '');
    const splitSegmentsLower = (p) => normalizePath(p).split('/').filter(Boolean).map(s => String(s).toLowerCase());

    const lowerSegments = splitSegmentsLower(baseFolder);
    const lastSeg = lowerSegments[lowerSegments.length - 1] || '';
    const usersIdx = lowerSegments.findIndex(seg => seg === 'avid users' || seg === 'avid_users' || seg === 'users');
    const isUsersFolder = lastSeg === 'avid users' || lastSeg === 'avid_users' || lastSeg === 'users';
    const isUserFolder = usersIdx >= 0 && usersIdx < lowerSegments.length - 1 && !isUsersFolder;
    const isSettingsFolder = lastSeg === 'settings' || lastSeg === 'site_settings' || lastSeg === 'site settings';

    const looksLikeMediaFolder = isAvidMxfPath(baseFolder)
      || isAvidMediaFilesRoot(baseFolder)
      || isAvidMxfRoot(baseFolder);

    const countExactName = (files, exactLower) =>
      files.reduce((acc, f) => acc + (String(f).toLowerCase() === exactLower ? 1 : 0), 0);

    const countEndsWith = (files, extLower) =>
      files.reduce((acc, f) => acc + (String(f).toLowerCase().endsWith(extLower) ? 1 : 0), 0);

    try {
      // ─────────────────────────────────────────────────────────────
      // Media DB folder counts (Avid MediaFiles/MXF/...)
      // Avid targets: msmFMID.pmr + msmMMOB.mdb (and the occasional msmMMOB.mbd typo in some docs)
      // ─────────────────────────────────────────────────────────────
      if (looksLikeMediaFolder) {
        const {
          folders: foldersToScan,
          hitMaxDepth,
          hitMaxFolders,
          timedOut,
          cfg
        } = await collectAvidFolders(baseFolder, {
          includeSubfolders: scanSubfolders,
          maxDepth,
          maxFolders,
          timeoutMs,
          yieldEvery
        });

        let totalMXF = 0;
        let totalMDBAll = 0;
        let totalPMRAll = 0;
        let totalMsmFMID = 0;
        let totalMsmMMOB = 0;
        let totalMsmMMOB_MBD = 0;

        for (let index = 0; index < foldersToScan.length; index += 1) {
          const dir = foldersToScan[index];
          const files = await safeReaddir(dir);

          totalMXF += countEndsWith(files, '.mxf');
          totalMDBAll += countEndsWith(files, '.mdb');
          totalPMRAll += countEndsWith(files, '.pmr');

          totalMsmFMID += countExactName(files, 'msmfmid.pmr');
          totalMsmMMOB += countExactName(files, 'msmmmob.mdb');
          totalMsmMMOB_MBD += countExactName(files, 'msmmmob.mbd');

          if (yieldEvery > 0 && (index + 1) % yieldEvery === 0) {
            await yieldToUI();
          }
        }

        if (hitMaxDepth) {
          appendAvidTraversalWarning(
            'avidFolderScanMaxDepth',
            '⚠️ Folder scan hit max depth ({{maxDepth}}). Some subfolders were skipped.',
            { maxDepth: cfg.maxDepth }
          );
        }
        if (hitMaxFolders) {
          appendAvidTraversalWarning(
            'avidFolderScanMaxFolders',
            '⚠️ Folder scan reached the {{maxFolders}} folder limit. Some folders were skipped.',
            { maxFolders: cfg.maxFolders }
          );
        }
        if (timedOut) {
          appendAvidTraversalWarning(
            'avidFolderScanTimedOut',
            '⚠️ Folder scan timed out after {{seconds}}s. Some folders were skipped.',
            { seconds: Math.floor(cfg.timeoutMs / 1000) }
          );
        }

        return {
          key: 'avidFileCountsSummaryMediaDb',
          fallback: '\n📊 File Counts — {{folderCount}} folder(s)\n• MXF: {{totalMXF}} | msmFMID.pmr: {{totalMsmFMID}} | msmMMOB.mdb: {{totalMsmMMOB}} | msmMMOB.mbd: {{totalMsmMMOB_MBD}} ✅',
          params: {
            folderCount: foldersToScan.length,
            totalMXF,
            totalMsmFMID,
            totalMsmMMOB,
            totalMsmMMOB_MBD,
            // Keep legacy totals available for older locale strings / debugging.
            totalMDB: totalMDBAll,
            totalPMR: totalPMRAll
          }
        };
      }

      // ─────────────────────────────────────────────────────────────
      // User folder counts (…/Avid Users/<user>)
      // Targets for reset: MCState + *.xml + *.avs (we also show *.ave for context)
      // ─────────────────────────────────────────────────────────────
      if (isUserFolder) {
        const files = await safeReaddir(baseFolder);
        const mcstate = countExactName(files, 'mcstate') + countExactName(files, 'mc state');
        const xml = countEndsWith(files, '.xml');
        const avs = countEndsWith(files, '.avs');
        const ave = countEndsWith(files, '.ave');

        return { key: 'avidFileCountsSummaryUserFolder', fallback: '\n📊 File Counts — User Folder\n• MCState: {{mcstate}} | XML: {{xml}} | AVS: {{avs}} | AVE: {{ave}} ✅', params: { mcstate, xml, avs, ave } };
      }
      if (isUsersFolder) {
        let userFolders = [];
        try {
          const entries = await safeReaddirWithTypes(baseFolder);
          userFolders = entries
            .filter(entry => isDirectoryLike(entry))
            .map(entry => entry.name)
            .filter(Boolean);
        } catch {
          userFolders = [];
        }

        let mcstate = 0;
        let xml = 0;
        let avs = 0;
        let ave = 0;

        for (let index = 0; index < userFolders.length; index += 1) {
          const userDir = path.join(baseFolder, userFolders[index]);
          const files = await safeReaddir(userDir);
          mcstate += countExactName(files, 'mcstate') + countExactName(files, 'mc state');
          xml += countEndsWith(files, '.xml');
          avs += countEndsWith(files, '.avs');
          ave += countEndsWith(files, '.ave');

          if (yieldEvery > 0 && (index + 1) % yieldEvery === 0) {
            await yieldToUI();
          }
        }

        return { key: 'avidFileCountsSummaryUsersFolder', fallback: '\n📊 File Counts — Avid Users ({{userFolderCount}} folder(s))\n• MCState: {{mcstate}} | XML: {{xml}} | AVS: {{avs}} | AVE: {{ave}} ✅', params: { userFolderCount: userFolders.length, mcstate, xml, avs, ave } };
      }

      // ─────────────────────────────────────────────────────────────
      // Settings folder counts
      // Targets for site reset: MCState + Site_Attributes + Site_Settings.xml
      // ─────────────────────────────────────────────────────────────
      if (isSettingsFolder) {
        const files = await safeReaddir(baseFolder);
        const mcstate = countExactName(files, 'mcstate') + countExactName(files, 'mc state');
        const siteAttr = countExactName(files, 'site_attributes') + countExactName(files, 'site attributes');
        const siteXml = countExactName(files, 'site_settings.xml') + countExactName(files, 'site settings.xml');

        return { key: 'avidFileCountsSummarySettingsFolder', fallback: '\n📊 File Counts — Settings Folder\n• MCState: {{mcstate}} | Site_Attributes: {{siteAttr}} | Site_Settings.xml: {{siteXml}} ✅', params: { mcstate, siteAttr, siteXml } };
      }

      // Settings root counts
      const resolved = await resolveAvidSettingsBase(baseFolder);
      if (resolved?.ok) {
        const settingsFiles = await safeReaddir(resolved.settingsFolder);
        const siteMcstate = countExactName(settingsFiles, 'mcstate') + countExactName(settingsFiles, 'mc state');
        const siteAttr = countExactName(settingsFiles, 'site_attributes') + countExactName(settingsFiles, 'site attributes');
        const siteXml = countExactName(settingsFiles, 'site_settings.xml') + countExactName(settingsFiles, 'site settings.xml');

        let userFolderCount = 0;
        try {
          const entries = await safeReaddirWithTypes(resolved.usersFolder);
          userFolderCount = entries.filter(e => isDirectoryLike(e)).length;
        } catch {
          userFolderCount = 0;
        }

        return { key: 'avidFileCountsSummarySettingsRoot', fallback: '\n📊 File Counts — Avid Settings Root\n• Settings: MCState {{siteMcstate}} | Site_Attributes {{siteAttr}} | Site_Settings.xml {{siteXml}}\n• Users: {{userFolderCount}} folder(s) ✅', params: { siteMcstate, siteAttr, siteXml, userFolderCount } };
      }

      // Fallback: legacy-style extension counts (kept for robustness)
      const {
        folders: foldersToScan
      } = await collectAvidFolders(baseFolder, {
        includeSubfolders: scanSubfolders,
        maxDepth,
        maxFolders,
        timeoutMs,
        yieldEvery
      });
      let totalMXF = 0, totalMDB = 0, totalPMR = 0;

      for (let index = 0; index < foldersToScan.length; index += 1) {
        const dir = foldersToScan[index];
        const files = await safeReaddir(dir);
        totalMXF += countEndsWith(files, '.mxf');
        totalMDB += countEndsWith(files, '.mdb');
        totalPMR += countEndsWith(files, '.pmr');
        if (yieldEvery > 0 && (index + 1) % yieldEvery === 0) {
          await yieldToUI();
        }
      }

      return {
        key: 'avidFileCountsSummary',
        fallback: '\n📊 File Counts — {{folderCount}} folder(s)\n• MXF: {{totalMXF}} | MDB: {{totalMDB}} | PMR: {{totalPMR}} ✅',
        params: {
          folderCount: foldersToScan.length,
          totalMXF,
          totalMDB,
          totalPMR
        }
      };
    } catch (err) {
      return { key: 'avidCountFilesFailed', fallback: '\n❌ Failed to count files: {{error}}', params: { error: err.message } };
    }
  }

  // ===============================
  // 🤝 NLE Utilities: AI Assistants
  // ===============================

  const nleAssistButtons = document.querySelectorAll('#nle-utilities .nle-assist-button');

  const isExternalAssistLink = (btn) => {
    if (btn?.tagName !== 'A') return false;
    const href = btn.getAttribute('href');
    return Boolean(href && /^https?:\/\//i.test(href));
  };

  const showAssistNotice = (message, options = {}) => {
    const variant = String(options?.variant || 'info').trim().toLowerCase();
    const duration = Number.isFinite(Number(options?.duration))
      ? Math.max(1200, Number(options.duration))
      : 2400;
    let toast = document.getElementById('nle-assist-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'nle-assist-toast';
      toast.style.position = 'fixed';
      toast.style.top = '12px';
      toast.style.right = '20px';
      toast.style.padding = '10px 18px';
      toast.style.color = '#fff';
      toast.style.borderRadius = '8px';
      toast.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
      toast.style.fontFamily = 'system-ui, sans-serif';
      toast.style.fontSize = '13px';
      toast.style.zIndex = '9999';
      document.body.appendChild(toast);
    }
    toast.style.background = variant === 'error'
      ? '#c0392b'
      : variant === 'success'
        ? '#00b894'
        : '#2d3436';
    toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transition = 'opacity 0.4s ease';
    if (showAssistNotice._timer) clearTimeout(showAssistNotice._timer);
    showAssistNotice._timer = setTimeout(() => (toast.style.opacity = '0'), duration);
  };

  async function apiKeyIsValid() {
    try {
      return !!(await ipc.invoke('secure-store:has-ai-api-key'));
    } catch (err) {
      console.warn('⚠️ Unable to verify API key state for assistants:', err);
      return false;
    }
  }

  async function updateAssistButtonState(validOverride) {
    const valid = typeof validOverride === 'boolean' ? validOverride : await apiKeyIsValid();
    nleAssistButtons.forEach((btn) => {
      const isExternal = isExternalAssistLink(btn);
      if (!valid && !isExternal) {
        btn.classList.add('disabled');
        btn.setAttribute('aria-disabled', 'true');
        btn.setAttribute('tabindex', '-1');
        if (btn.hasAttribute('href')) {
          btn.dataset.assistHref = btn.getAttribute('href');
          btn.removeAttribute('href');
        }
      } else {
        btn.classList.remove('disabled');
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('tabindex');
        if (!btn.hasAttribute('href') && btn.dataset.assistHref) {
          btn.setAttribute('href', btn.dataset.assistHref);
          delete btn.dataset.assistHref;
        }
      }
    });
  }

  nleAssistButtons.forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const hasKey = await apiKeyIsValid();
      const isExternal = isExternalAssistLink(btn);
      if (!hasKey) {
        if (!isExternal) {
          e.preventDefault();
          e.stopPropagation();
          showAssistNotice(
            getLocalizedText(
              'nleAssistApiKeyRequired',
              'Enter a valid API key in Preferences to use in-app NLE assistants.'
            )
          );
        }
      }
    });
  });

  updateAssistButtonState();

  // ✅ Keep assistant availability in sync when returning to the panel.
  // This avoids the "disabled until reload" feel after adding an API key in Preferences.
  document.addEventListener('toolbar-updated', (e) => {
    const panelId = e?.detail?.panelId;
    if (panelId === 'nle-utilities') {
      updateAssistButtonState();
    }
  });

async function detectActiveAvidUser(resolved, userNames = []) {
  const names = Array.isArray(userNames) ? userNames.filter(Boolean) : [];
  if (!names.length) return null;

  // Best-effort: MCState in the main Settings folder remembers the last active user/projects.
  // This file is not guaranteed to be clean UTF-8, so parsing is intentionally defensive.
  if (resolved?.settingsFolder) {
    const mcStatePath = path.join(resolved.settingsFolder, 'MCState');
    try {
      if (await fs.exists(mcStatePath)) {
        const raw = await fs.readFile(mcStatePath, 'utf8');
        const text = String(raw || '').toLowerCase();

        // Prefer longer names first to avoid substring collisions.
        const sorted = [...names].sort((a, b) => String(b).length - String(a).length);
        const matches = sorted.filter(name => text.includes(String(name).toLowerCase()));
        if (matches.length === 1) return matches[0];
      }
    } catch {
      // ignore; fall back to timestamp heuristic
    }
  }

  // Fallback: pick the user whose per-user MCState file is newest.
  let best = null;
  let bestMtime = -1;

  for (const user of names) {
    const userDir = path.join(resolved.usersFolder, user);
    const userMcState = path.join(userDir, 'MCState');
    try {
      if (await fs.exists(userMcState)) {
        const st = await fs.stat(userMcState);
        const mtime = Number(st?.mtimeMs) || 0;
        if (mtime > bestMtime) {
          bestMtime = mtime;
          best = user;
        }
      }
    } catch {
      // ignore
    }
  }

  return best;
}

async function populateAvidUsers(baseFolder, preselectedUser) {
  if (!avid.userSelect) return;

  setAvidUserPlaceholder();
  if (!baseFolder) return;

  // If the selected folder is an Avid media folder (Avid MediaFiles/MXF),
  // Site/User settings discovery is irrelevant. Keep the dropdown empty without erroring.
  if (isAvidMxfPath(baseFolder) || isAvidMediaFilesRoot(baseFolder) || isAvidMxfRoot(baseFolder)) {
    return;
  }

  const normalized = String(baseFolder || '').replace(/\\/g, '/').replace(/[\\/]+$/, '');
  const leafLower = String(path.basename(normalized)).toLowerCase();

  const parentDir = path.resolve(baseFolder, '..').replace(/\\/g, '/').replace(/[\\/]+$/, '');
  const parentLeaf = parentDir.split('/').pop().toLowerCase();

  const isUsersFolderSelected =
    leafLower === 'avid users'
    || leafLower === 'avid_users'
    || leafLower === 'users';

  const isDirectUserFolder =
    (parentLeaf === 'avid users' || parentLeaf === 'avid_users' || parentLeaf === 'users')
    && leafLower !== parentLeaf;

  // Only resolve the full Settings root when we actually need it.
  // If the user picked "Avid Users" (or a specific user inside it), we can populate the dropdown
  // from that folder alone without requiring sibling "Settings" access/approval.
  let resolved = null;
  let usersDir = null;

  if (isDirectUserFolder) {
    usersDir = path.resolve(baseFolder, '..');
    if (!preselectedUser) {
      preselectedUser = path.basename(baseFolder);
    }
  } else if (isUsersFolderSelected) {
    usersDir = baseFolder;
  } else {
    resolved = await resolveAvidSettingsBase(baseFolder);
    if (!resolved.ok) {
      return;
    }
    usersDir = resolved.usersFolder;
  }

  // When we only have the usersDir (no Settings root), we can still infer "active" user
  // by per-user MCState timestamps.
  const resolvedForDetect = resolved?.ok
    ? resolved
    : { usersFolder: usersDir, settingsFolder: null };

  let entries = [];
  try {
    entries = await fs.readdirWithTypes(usersDir);
  } catch (err) {
    // If the user selected a specific user folder, we may not have permission to list the parent.
    // In that case, still allow the dropdown to contain the chosen user so reset-user can proceed.
    if (isDirectUserFolder && preselectedUser) {
      const option = document.createElement('option');
      option.value = preselectedUser;
      option.textContent = preselectedUser;
      option.selected = true;
      avid.userSelect.appendChild(option);
      return;
    }

    appendAvidSummaryMessage(
      'avidLoadUsersFailed',
      '\n❌ Unable to load users from {{usersDir}}: {{error}}',
      { usersDir, error: err.message }
    );
    return;
  }

  const IGNORED_USER_DIRS = new Set([
    '__macosx',
    'settings',
    'site_settings',
    'site settings',
    'reports',
    'avid fatalerrorreports',
    'avid fatal errorreports',
    'avid fatalerror reports',
    'fatalerrorreports',
    'fatal errorreports',
    'fatal error reports'
  ]);

  const candidates = [];

  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry?.name;
    if (!entryName) continue;

    const lowerName = String(entryName).toLowerCase();
    if (lowerName.startsWith('.')) continue;
    if (IGNORED_USER_DIRS.has(lowerName)) continue;

    // Determine if this entry is a directory (Dirent-like object or via stat fallback).
    if (isDirectoryLike(entry)) {
      candidates.push(entryName);
      continue;
    }

    try {
      const stats = await fs.stat(path.join(usersDir, entryName));
      if (isDirectoryLike(stats)) {
        candidates.push(entryName);
      }
    } catch {
      // ignore
    }
  }

  // Heuristic: Avid user folders usually contain MCState and user settings files.
  // Prefer positive identification so we don't list internal folders like Settings/Reports.
  const looksLikeAvidUserFolder = async (name) => {
    try {
      const folder = path.join(usersDir, name);

      const mc1 = path.join(folder, 'MCState');
      const mc2 = path.join(folder, 'MC State');

      if (await fs.exists(mc1)) return true;
      if (await fs.exists(mc2)) return true;

      const files = await fs.readdir(folder);
      const lower = (Array.isArray(files) ? files : []).map(f => String(f || '').toLowerCase());

      // Common user artifacts: .ave (profile), .xml (settings), .avs (legacy settings)
      if (lower.some(f => f.endsWith('.ave') || f.endsWith('.xml') || f.endsWith('.avs'))) return true;
      return false;
    } catch {
      return false;
    }
  };

  let userNames = [];
  for (const name of candidates) {
    if (await looksLikeAvidUserFolder(name)) {
      userNames.push(name);
    }
  }

  // Fallback: if we couldn't positively identify users, show the directory candidates anyway
  // (still excluding known non-user folders).
  if (userNames.length === 0 && candidates.length > 0) {
    userNames = [...candidates];
  }

  if (userNames.length === 0) {
    appendAvidSummaryMessage(
      'avidNoUserFolders',
      '\n⚠️ No user folders found in {{usersDir}}.',
      { usersDir }
    );
    return;
  }

  // Stable UI ordering.
  userNames.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));

  // If we don't have a saved/preselected user, try to infer the last active user.
  let inferredActiveUser = null;
  if (!preselectedUser) {
    inferredActiveUser = await detectActiveAvidUser(resolvedForDetect, userNames);
    if (inferredActiveUser) {
      preselectedUser = inferredActiveUser;
      appendAvidSummaryMessage(
        'avidActiveUserDetected',
        '\n👤 Detected last active user: {{user}}',
        { user: inferredActiveUser }
      );
    }
  }

  userNames.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    if (preselectedUser && preselectedUser === name) {
      option.selected = true;
    }
    avid.userSelect.appendChild(option);
  });

  if (preselectedUser && !userNames.includes(preselectedUser)) {
    appendAvidSummaryMessage(
      'avidSavedUserMissing',
      '\n⚠️ Saved user “{{preselectedUser}}” not found in {{usersDir}}.',
      { preselectedUser, usersDir }
    );
  }
}

const avidDeleteDbBtn = document.getElementById('avid-delete-db');
const avidScanSubfolders = document.getElementById('avid-scan-subfolders');

const ensureAvidDbSubfolderScan = (folder) => {
  let includeSubfolders = avidScanSubfolders?.checked;
  if ((isAvidMxfRoot(folder) || isAvidMediaFilesRoot(folder)) && !includeSubfolders) {
    includeSubfolders = true;
    if (avidScanSubfolders) {
      avidScanSubfolders.checked = true;
    }
    const warningMsg = getLocalizedText(
      'avidDbSubfolderScanEnabled',
      '⚠️ Avid DB files live in subfolders under /Avid MediaFiles. Enabling subfolder scan for this run.'
    );
    logNLE(warningMsg);
    appendAvidSummaryMessage(
      'avidDbSubfolderScanEnabled',
      '\n⚠️ Avid DB files live in subfolders under /Avid MediaFiles. Enabling subfolder scan for this run.'
    );
  }
  return includeSubfolders;
};

avidDeleteDbBtn?.addEventListener('click', () => withBusyState({
  section: avidSection,
  summary: avid.summary,
  messageEntry: getAvidBusyMessageEntry()
}, async () => {
  const folder = avid.pathField.value;
  if (!folder) {
    const errKey = 'avidSelectMxfFolderFirst';
    const errFallback = '❌ Please select a MXF folder first.';
    const errMsg = getLocalizedText(errKey, errFallback);
    logNLE(errMsg, { isError: true });
    appendAvidSummaryMessage(errKey, `\n${errFallback}`);
    return;
  }

  const approval = await ensureApprovedDir(
    folder,
    getLocalizedText('avidFolderLabel', 'Avid folder')
  );
  if (!approval.ok) {
    const approvalEntry = approval.messageEntry || {};
    const approvalMsg = getMessageEntryText(approvalEntry);
    logNLE(approvalMsg, { isError: true });
    appendAvidSummaryMessage(
      approvalEntry.key || '',
      `\n${approvalEntry.fallback || ''}`,
      approvalEntry.params || {}
    );
    return;
  }

  const isMediaComposerRunning = await checkMediaComposerRunning(avid.summary);
  if (isMediaComposerRunning) {
    appendAvidSummaryMessage(
      'avidQuitMediaComposerBeforeDeleteDb',
      '\n⚠️ Media Composer is currently running. Quit it before deleting databases.'
    );
    return;
  }

  const confirmed = await ipc.showConfirm?.(
    getLocalizedText(
      'nleConfirmAvidDeleteDb',
      "This will remove the Avid Media Database files from the selected folder(s):\n\n• msmFMID.pmr\n• msmMMOB.mdb\n\nMedia Composer rebuilds these automatically on next launch.\n\n⚠️ Avoid this on shared Nexis/ISIS/Interplay/MediaCentral workflows unless you know exactly what you’re doing.\n\nDo you want to continue?"
    )
  );
  if (!confirmed) {
    const cancelKey = 'avidDbDeletionCanceled';
    const cancelFallback = '⛔ DB deletion canceled by user.';
    const cancelMsg = getLocalizedText(cancelKey, cancelFallback);
    logNLE(cancelMsg);
    appendAvidSummaryMessage(cancelKey, `\n${cancelFallback}`);
    return;
  }

  let allowNonStandardTargets = false;
  if (!isAvidMxfPath(folder) && !isAvidMediaFilesRoot(folder)) {
    const okToScan = await confirmNonStandardAvidFolders(
      [folder],
      getLocalizedText('avidActionScanDbFiles', 'scan for Avid database files')
    );
    if (!okToScan) return;
    allowNonStandardTargets = true;
  }

  const includeSubfolders = ensureAvidDbSubfolderScan(folder);
  const showCounts = document.getElementById('avid-show-counts')?.checked;
  const {
    folders: mxfFolders,
    hitMaxDepth,
    hitMaxFolders,
    timedOut,
    cfg
  } = await collectAvidFolders(folder, {
    includeSubfolders,
    maxDepth: 12,
    maxFolders: 3000,
    timeoutMs: 30000,
    yieldEvery: 20
  });

  if (hitMaxDepth) {
    appendAvidTraversalWarning(
      'avidFolderScanMaxDepth',
      '⚠️ Folder scan hit max depth ({{maxDepth}}). Some subfolders were skipped.',
      { maxDepth: cfg.maxDepth }
    );
  }
  if (hitMaxFolders) {
    appendAvidTraversalWarning(
      'avidFolderScanMaxFolders',
      '⚠️ Folder scan reached the {{maxFolders}} folder limit. Some folders were skipped.',
      { maxFolders: cfg.maxFolders }
    );
  }
  if (timedOut) {
    appendAvidTraversalWarning(
      'avidFolderScanTimedOut',
      '⚠️ Folder scan timed out after {{seconds}}s. Some folders were skipped.',
      { seconds: Math.floor(cfg.timeoutMs / 1000) }
    );
  }

  for (const dir of mxfFolders) {
    const scanMsg = getLocalizedText('avidScanningFolder', '🔍 Scanning folder: {{dir}}', { dir });
    logNLE(scanMsg);
    appendAvidSummaryMessage('avidScanningFolder', '\n🔍 Scanning folder: {{dir}}', { dir });

    if (showCounts) {
      try {
        const allFiles = await safeReaddir(dir);
        const mxfCount = allFiles.filter(f => String(f).toLowerCase().endsWith('.mxf')).length;

        // Avid media database targets (per Avid KB): msmFMID.pmr + msmMMOB.mdb
        const msmFMIDCount = allFiles.filter(f => String(f).toLowerCase() === 'msmfmid.pmr').length;
        const msmMMOBCount = allFiles.filter(f => String(f).toLowerCase() === 'msmmmob.mdb').length;

        // Some Avid KBs contain a .mbd typo; count it for visibility if present.
        const msmMMOB_MBD_Count = allFiles.filter(f => String(f).toLowerCase() === 'msmmmob.mbd').length;

        const countMsg = getLocalizedText(
          'avidPerFolderCountLine',
          ' [MXF: {{mxfCount}} | msmFMID.pmr: {{msmFMIDCount}} | msmMMOB.mdb: {{msmMMOBCount}} | msmMMOB.mbd: {{msmMMOB_MBD_Count}}]',
          { mxfCount, msmFMIDCount, msmMMOBCount, msmMMOB_MBD_Count }
        );
        logNLE(countMsg);
        appendAvidSummaryMessage(
          'avidPerFolderCountLine',
          ' [MXF: {{mxfCount}} | msmFMID.pmr: {{msmFMIDCount}} | msmMMOB.mdb: {{msmMMOBCount}} | msmMMOB.mbd: {{msmMMOB_MBD_Count}}]',
          { mxfCount, msmFMIDCount, msmMMOBCount, msmMMOB_MBD_Count }
        );
      } catch (err) {
        const countErr = getLocalizedText(
          'avidCountFilesInFolderFailed',
          '❌ Failed to count files in {{dir}}: {{error}}',
          { dir, error: err.message }
        );
        logNLE(countErr, { isError: true });
        appendAvidSummaryMessage(
          'avidCountFilesInFolderFailed',
          '\n❌ Failed to count files in {{dir}}: {{error}}',
          { dir, error: err.message }
        );
      }
    }

    await yieldToUI();
  }

  const nonStandardFolders = mxfFolders.filter(sub =>
    !isAvidMxfPath(sub) && !isAvidMediaFilesRoot(sub) && !isAvidMxfRoot(sub)
  );
  if (nonStandardFolders.length > 0 && !allowNonStandardTargets) {
    const okToDelete = await confirmNonStandardAvidFolders(
      nonStandardFolders,
      getLocalizedText('avidActionDeleteDbFiles', 'delete Avid database files')
    );
    if (!okToDelete) return;
    allowNonStandardTargets = true;
  }

  const targetMxfFolders = allowNonStandardTargets
    ? mxfFolders
    : mxfFolders.filter(sub => isAvidMxfPath(sub));
  if (targetMxfFolders.length === 0) {
    const warningKey = allowNonStandardTargets ? 'avidNoMxfFoldersDelete' : 'avidNoStandardMxfFoldersDelete';
    const warningFallback = allowNonStandardTargets
      ? '⚠️ No MXF folders found. Delete canceled.'
      : '⚠️ No standard Avid MXF folders found. Delete canceled.';
    const warningMsg = getLocalizedText(warningKey, warningFallback);
    logNLE(warningMsg);
    appendAvidSummaryMessage(warningKey, `\n${warningFallback}`);
    return;
  }
  if (!allowNonStandardTargets && targetMxfFolders.length !== mxfFolders.length) {
    const skippedMsg = getLocalizedText(
      'avidSkippingNonStandardFolders',
      '⚠️ Skipping {{count}} non-standard folder(s) (outside /Avid MediaFiles/MXF/).',
      { count: mxfFolders.length - targetMxfFolders.length }
    );
    logNLE(skippedMsg);
    appendAvidSummaryMessage(
      'avidSkippingNonStandardFolders',
      '\n⚠️ Skipping {{count}} non-standard folder(s) (outside /Avid MediaFiles/MXF/).',
      { count: mxfFolders.length - targetMxfFolders.length }
    );
  }
  if (allowNonStandardTargets && nonStandardFolders.length > 0) {
    const includeMsg = getLocalizedText(
      'avidIncludingNonStandardFolders',
      '⚠️ Including {{count}} non-standard folder(s) after confirmation.',
      { count: nonStandardFolders.length }
    );
    logNLE(includeMsg);
    appendAvidSummaryMessage(
      'avidIncludingNonStandardFolders',
      '\n⚠️ Including {{count}} non-standard folder(s) after confirmation.',
      { count: nonStandardFolders.length }
    );
  }

  let totalDeleted = 0;

  const AVID_MEDIA_DB_FILENAMES = new Set(['msmfmid.pmr', 'msmmmob.mdb', 'msmmmob.mbd']);

  const MAX_FILE_LOGS = 50;
let fileLogs = 0;

for (const sub of targetMxfFolders) {

  const dirEntries = await safeReaddir(sub);
  const dbFiles = dirEntries.filter(f =>
    AVID_MEDIA_DB_FILENAMES.has(String(f).toLowerCase())
  );

  if (dbFiles.length === 0) {
    appendAvidSummaryMessage(
      'avidNoDbFilesFound',
      '\n📭 No .pmr or .mdb files found in: {{folder}}',
      { folder: sub }
    );
  } else {
    appendAvidSummaryMessage(
      'avidDbFilesFound',
      '\n📂 Found {{count}} db file(s) in {{folder}}',
      { count: dbFiles.length, folder: sub }
    );
  }

  for (const file of dbFiles) {
    const filePath = path.join(sub, file);

    // Avoid spamming the DOM on large deletes (that itself can freeze the UI).
    if (fileLogs < MAX_FILE_LOGS) {
      appendAvidSummaryMessage(
        'avidDeletingFile',
        '\n🧹 Deleting: {{filePath}}',
        { filePath }
      );
      fileLogs++;
    } else if (fileLogs === MAX_FILE_LOGS) {
      appendAvidSummaryMessage(
        'avidPerFileOutputSuppressed',
        '\n⚠️ Further per-file output suppressed to keep the panel responsive.'
      );
      fileLogs++;
    }

    try {
      await fs.unlink(filePath);
      totalDeleted++;
    } catch (err) {
      console.error(`❌ Failed to delete ${filePath}: ${err.message}`);
      appendAvidSummaryMessage(
        'avidDeleteFileFailed',
        '\n❌ Failed to delete {{filePath}}: {{error}}',
        { filePath, error: err.message }
      );
    }

    if (totalDeleted % 250 === 0) {
      await yieldToUI();
    }
  }

  await yieldToUI();
}

  if (totalDeleted === 0) {
    appendAvidSummaryMessage(
      'avidNoDbFilesToDelete',
      '\n✅ No .mdb or .pmr files found to delete.'
    );
  } else {
    appendAvidSummaryMessage(
      'avidDeletedDbFiles',
      '\n✅ Deleted {{count}} database file(s).',
      { count: totalDeleted }
    );
  }

  // ✅ Optionally trigger rebuild
const autoRebuild = document.getElementById('avid-auto-rebuild');
if (autoRebuild?.checked && targetMxfFolders.length > 0) {
  const isMediaComposerRunning = await checkMediaComposerRunning(avid.summary);
  if (isMediaComposerRunning) {
    appendAvidSummaryMessage(
      'avidQuitMediaComposerBeforeAutoRebuild',
      '\n⚠️ Media Composer is currently running. Quit it before auto-rebuilding databases.'
    );
    return;
  }
  logNLE(getLocalizedText(
    'avidAutoRebuildEnabled',
    '⚙️ Auto-rebuild trigger enabled for selected MXF folders.'
  ));

  let rebuildSuccessCount = 0;
  let rebuildFailureCount = 0;

  for (const sub of targetMxfFolders) {
    try {
      const dummyFile = await createAvidRebuildTriggerFile(sub);
      scheduleAvidTriggerCleanup(dummyFile);
      rebuildSuccessCount += 1;
    } catch (err) {
      rebuildFailureCount += 1;
      const errorMessage = err instanceof Error ? err.message : String(err);
      appendAvidSummaryMessage(
        'avidAutoRebuildFailedForFolder',
        '\n❌ Auto-rebuild failed for {{folder}}: {{error}}',
        { folder: sub, error: errorMessage }
      );
      logNLE(getLocalizedText(
        'avidAutoRebuildFailedForFolderLog',
        '❌ Auto-rebuild failed for {{folder}}: {{error}}',
        { folder: sub, error: errorMessage }
      ), { isError: true });
    }
  }

  appendAvidSummaryMessage(
    'avidAutoRebuildTriggeredSummary',
    '\n⚙️ Auto-rebuild triggered in {{count}} folder(s).',
    { count: rebuildSuccessCount }
  );
  logNLE(getLocalizedText(
    'avidAutoRebuildTriggeredLog',
    '✅ Auto-rebuild triggered in {{count}} folder(s).',
    { count: rebuildSuccessCount }
  ));

  if (rebuildFailureCount > 0) {
    appendAvidSummaryMessage(
      'avidAutoRebuildFailuresSummary',
      '\n❌ Auto-rebuild failed in {{count}} folder(s).',
      { count: rebuildFailureCount }
    );
    logNLE(getLocalizedText(
      'avidAutoRebuildFailuresLog',
      '❌ Auto-rebuild failed in {{count}} folder(s).',
      { count: rebuildFailureCount }
    ), { isError: true });
  }
}

}));

const avidRebuildDbBtn = document.getElementById('avid-rebuild-db');

avidRebuildDbBtn?.addEventListener('click', () => withBusyState({
  section: avidSection,
  summary: avid.summary,
  messageEntry: getAvidBusyMessageEntry()
}, async () => {
  const folder = avid.pathField.value;
  if (!folder) {
    appendAvidSummaryMessage('avidSelectMxfFolderFirst', '❌ Please select a MXF folder first.');
    return;
  }

  const approval = await ensureApprovedDir(
    folder,
    getLocalizedText('avidFolderLabel', 'Avid folder')
  );
  if (!approval.ok) {
    const approvalEntry = approval.messageEntry || {};
    const approvalMsg = getMessageEntryText(approvalEntry);
    appendAvidSummaryMessage(
      approvalEntry.key || '',
      `\n${approvalEntry.fallback || ''}`,
      approvalEntry.params || {}
    );
    logNLE(approvalMsg, { isError: true });
    return;
  }

  const isMediaComposerRunning = await checkMediaComposerRunning(avid.summary);
  if (isMediaComposerRunning) {
    appendAvidSummaryMessage(
      'avidQuitMediaComposerBeforeRebuild',
      '\n⚠️ Media Composer is currently running. Quit it before rebuilding databases.'
    );
    return;
  }

  let allowNonStandardTargets = false;
  if (!isAvidMxfPath(folder) && !isAvidMediaFilesRoot(folder)) {
    const okToScan = await confirmNonStandardAvidFolders(
      [folder],
      getLocalizedText('avidActionScanRebuildTargets', 'scan for Avid rebuild targets')
    );
    if (!okToScan) return;
    allowNonStandardTargets = true;
  }

  const includeSubfolders = ensureAvidDbSubfolderScan(folder);
  const {
    folders: mxfFolders,
    hitMaxDepth,
    hitMaxFolders,
    timedOut,
    cfg
  } = await collectAvidFolders(folder, {
    includeSubfolders,
    maxDepth: 12,
    maxFolders: 3000,
    timeoutMs: 30000,
    yieldEvery: 20
  });

  if (hitMaxDepth) {
    appendAvidTraversalWarning(
      'avidFolderScanMaxDepth',
      '⚠️ Folder scan hit max depth ({{maxDepth}}). Some subfolders were skipped.',
      { maxDepth: cfg.maxDepth }
    );
  }
  if (hitMaxFolders) {
    appendAvidTraversalWarning(
      'avidFolderScanMaxFolders',
      '⚠️ Folder scan reached the {{maxFolders}} folder limit. Some folders were skipped.',
      { maxFolders: cfg.maxFolders }
    );
  }
  if (timedOut) {
    appendAvidTraversalWarning(
      'avidFolderScanTimedOut',
      '⚠️ Folder scan timed out after {{seconds}}s. Some folders were skipped.',
      { seconds: Math.floor(cfg.timeoutMs / 1000) }
    );
  }

  if (mxfFolders.length === 0) {
    appendAvidSummaryMessage(
      'avidNoFoldersToRebuild',
      '\n⚠️ No folders found to trigger rebuild.'
    );
    logNLE(getLocalizedText(
      'avidRebuildSkippedNoFolders',
      '⚠️ Rebuild trigger skipped: no folders found.'
    ));
    return;
  }

  const nonStandardFolders = mxfFolders.filter(sub =>
    !isAvidMxfPath(sub) && !isAvidMediaFilesRoot(sub) && !isAvidMxfRoot(sub)
  );
  if (nonStandardFolders.length > 0 && !allowNonStandardTargets) {
    const okToRebuild = await confirmNonStandardAvidFolders(
      nonStandardFolders,
      getLocalizedText('avidActionTriggerRebuild', 'trigger Avid rebuilds')
    );
    if (!okToRebuild) return;
    allowNonStandardTargets = true;
  }

  const targetMxfFolders = allowNonStandardTargets
    ? mxfFolders
    : mxfFolders.filter(sub => isAvidMxfPath(sub));
  if (targetMxfFolders.length === 0) {
    const warningKey = allowNonStandardTargets ? 'avidNoMxfFoldersRebuild' : 'avidNoStandardMxfFoldersRebuild';
    const warningFallback = allowNonStandardTargets
      ? '⚠️ No MXF folders found. Rebuild canceled.'
      : '⚠️ No standard Avid MXF folders found. Rebuild canceled.';
    const warningMsg = getLocalizedText(warningKey, warningFallback);
    logNLE(warningMsg);
    appendAvidSummaryMessage(warningKey, `\n${warningFallback}`);
    return;
  }

  if (!allowNonStandardTargets && targetMxfFolders.length !== mxfFolders.length) {
    const skippedMsg = getLocalizedText(
      'avidSkippingNonStandardFolders',
      '⚠️ Skipping {{count}} non-standard folder(s) (outside /Avid MediaFiles/MXF/).',
      { count: mxfFolders.length - targetMxfFolders.length }
    );
    logNLE(skippedMsg);
    appendAvidSummaryMessage(
      'avidSkippingNonStandardFolders',
      '\n⚠️ Skipping {{count}} non-standard folder(s) (outside /Avid MediaFiles/MXF/).',
      { count: mxfFolders.length - targetMxfFolders.length }
    );
  }
  if (allowNonStandardTargets && nonStandardFolders.length > 0) {
    const includeMsg = getLocalizedText(
      'avidIncludingNonStandardFolders',
      '⚠️ Including {{count}} non-standard folder(s) after confirmation.',
      { count: nonStandardFolders.length }
    );
    logNLE(includeMsg);
    appendAvidSummaryMessage(
      'avidIncludingNonStandardFolders',
      '\n⚠️ Including {{count}} non-standard folder(s) after confirmation.',
      { count: nonStandardFolders.length }
    );
  }

  let triggered = 0;

  logNLE(getLocalizedText('avidTriggeringRebuild', '⚙️ Triggering Avid rebuild in MXF folders…'));

  for (const sub of targetMxfFolders) {
    try {
      const dummyFile = await createAvidRebuildTriggerFile(sub);
      scheduleAvidTriggerCleanup(dummyFile);
      appendAvidSummaryMessage(
        'avidRebuildTriggeredInFolder',
        '\n⚙️ Rebuild triggered in: {{folder}}',
        { folder: sub }
      );
      triggered++;
    } catch (err) {
      appendAvidSummaryMessage(
        'avidRebuildFailedInFolder',
        '\n❌ Failed in {{folder}}: {{error}}',
        { folder: sub, error: err.message }
      );
      logNLE(getLocalizedText(
        'avidRebuildFailedInFolderLog',
        '❌ Rebuild trigger failed in {{folder}}: {{error}}',
        { folder: sub, error: err.message }
      ), { isError: true });
    }

    if (triggered % 25 === 0) {
      await yieldToUI();
    }
  }

  if (triggered === 0) {
    appendAvidSummaryMessage(
      'avidNoDummyFilesCreated',
      '\n⚠️ No dummy files created.'
    );
    logNLE(getLocalizedText(
      'avidRebuildSkippedNoDummyFiles',
      '⚠️ Rebuild trigger skipped: no dummy files created.'
    ));
  } else {
    appendAvidSummaryMessage(
      'avidDummyFilesCreated',
      '\n✅ Dummy files created in {{count}} folder(s).',
      { count: triggered }
    );
    logNLE(getLocalizedText(
      'avidRebuildTriggeredLog',
      '✅ Rebuild triggered in {{count}} folder(s).',
      { count: triggered }
    ));
  }
}));

avid.selectBtn?.addEventListener('click', async () => {
  const folder = await ipc.selectFolder?.();
  if (folder) {
    avid.pathField.value = folder;
    avidSummaryState.mode = SUMMARY_MODE_SELECTED_FOLDER;
    avidSummaryState.selectedFolder = folder;
    avidSummaryState.entries = [];
    renderAvidSummaryState();
    // If the user picked an individual user folder inside "Avid Users/<name>", preselect that user.
    const parentDir = path.resolve(folder, '..').replace(/\\/g, '/').replace(/[\\/]+$/, '');
    const parentLeaf = parentDir.split('/').pop().toLowerCase();
    const inferredUser = (parentLeaf === 'avid users' || parentLeaf === 'avid_users' || parentLeaf === 'users')
      ? path.basename(folder)
      : null;

    await populateAvidUsers(folder, inferredUser || avid.userSelect?.value);
  } else {
    avidSummaryState.mode = SUMMARY_MODE_CANCELED;
    avidSummaryState.selectedFolder = '';
    avidSummaryState.entries = [];
    renderAvidSummaryState();
    return;
  }

  const showCounts = document.getElementById('avid-show-counts')?.checked;
  const scanSubfolders = document.getElementById('avid-scan-subfolders')?.checked;
  const summaryText = await buildAvidCountSummary(folder, { showCounts, scanSubfolders });

  if (summaryText && typeof summaryText === 'object') {
    appendAvidSummaryMessage(summaryText.key, summaryText.fallback, summaryText.params || {});
  }
});

document.getElementById('avid-show-counts')?.addEventListener('change', async () => {
  const folder = avid.pathField.value;
  if (!folder) return;

  avidSummaryState.mode = SUMMARY_MODE_SELECTED_FOLDER;
  avidSummaryState.selectedFolder = folder;
  avidSummaryState.entries = [];
  renderAvidSummaryState();

  const showCounts = document.getElementById('avid-show-counts')?.checked;
  const scanSubfolders = document.getElementById('avid-scan-subfolders')?.checked;
  const summaryText = await buildAvidCountSummary(folder, { showCounts, scanSubfolders });

  if (summaryText && typeof summaryText === 'object') {
    appendAvidSummaryMessage(summaryText.key, summaryText.fallback, summaryText.params || {});
  }
});

document.getElementById('avid-scan-subfolders')?.addEventListener('change', async () => {
  const folder = avid.pathField.value;
  if (!folder) return;

  avidSummaryState.mode = SUMMARY_MODE_SELECTED_FOLDER;
  avidSummaryState.selectedFolder = folder;
  avidSummaryState.entries = [];
  renderAvidSummaryState();

  const showCounts = document.getElementById('avid-show-counts')?.checked;
  const scanSubfolders = document.getElementById('avid-scan-subfolders')?.checked;
  const summaryText = await buildAvidCountSummary(folder, { showCounts, scanSubfolders });

  if (summaryText && typeof summaryText === 'object') {
    appendAvidSummaryMessage(summaryText.key, summaryText.fallback, summaryText.params || {});
  }
});

// ===============================
// 🧹 Avid: Site Settings Reset
// ===============================
const avidResetSiteBtn = document.getElementById('avid-reset-site');
const avidBackupSiteCheckbox = document.getElementById('avid-backup-settings');

// Avid-documented Site Settings rebuild targets (Windows/macOS):
// Settings/MCState, Settings/Site_Attributes, Settings/Site_Settings.xml
const AVID_SITE_SETTINGS_FILES = new Set([
  'mcstate',
  'mc state',
  'site_attributes',
  'site attributes',
  'site_settings.xml',
  'site settings.xml'
]);

avidResetSiteBtn?.addEventListener('click', () => withBusyState({
  section: avidSection,
  summary: avid.summary,
  messageEntry: getAvidBusyMessageEntry()
}, async () => {
  const baseFolder = avid.pathField.value;
  if (!baseFolder) {
    appendAvidSummaryMessage(
      'avidSelectFolderFirst',
      '\n❌ Please select an Avid folder first.'
    );
    return;
  }
  const baseValidation = await validateAvidSettingsBase(baseFolder);
  if (!baseValidation.ok) {
    appendAvidSummaryDescriptors(baseValidation);
    return;
  }
  const isMediaComposerRunning = await checkMediaComposerRunning(avid.summary);
  if (isMediaComposerRunning) {
    appendAvidSummaryMessage(
      'avidQuitMediaComposerBeforeReset',
      '\n⚠️ Media Composer is currently running. Quit it before resetting.'
    );
    return;
  }
  const settingsFolder = baseValidation.settingsFolder;

  const confirmed = await ipc.showConfirm?.(
    getLocalizedText(
      'nleConfirmAvidResetSite',
      "This will delete the Avid Site Settings files from the Settings folder:\n\n• MCState\n• Site_Attributes\n• Site_Settings.xml\n\nMedia Composer will rebuild these automatically on next launch.\n\nDo you want to continue?"
    )
  );
  if (!confirmed) {
    appendAvidSummaryMessage(
      'avidSiteResetCanceled',
      '\n⛔ Site settings reset canceled by user.'
    );
    return;
  }

  const deleted = [];
  const backedUp = [];
  const failed = [];

  try {
    logNLE(getLocalizedText('avidResetSiteStart', '🚀 Resetting Avid site settings…'));

    const settingsFiles = (await readdirAsync(settingsFolder)).map(f => String(f));
    const targets = settingsFiles.filter(f => AVID_SITE_SETTINGS_FILES.has(f.toLowerCase()));

    if (targets.length === 0) {
      appendAvidSummaryMessage(
        'avidNoSiteSettingsToDelete',
        '\n✅ No Site Settings files were found to delete in:\n{{folder}}',
        { folder: settingsFolder }
      );
      return;
    }

    if (avidBackupSiteCheckbox?.checked) {
      const backupFolder = path.join(settingsFolder, `Site_Backup_${getBackupTimestamp()}`);
      await mkdirpAsync(backupFolder);

      for (const file of targets) {
        const src = path.join(settingsFolder, file);
        const dest = path.join(backupFolder, file);
        try {
          await fs.copyFile(src, dest);
          backedUp.push(file);
        } catch (err) {
          failed.push(file);
          logNLE(getLocalizedText(
            'avidBackupSiteSettingFailed',
            '⚠️ Failed to back up site setting {{file}}: {{error}}',
            { file, error: err.message }
          ), { isError: true });
        }
      }

      appendAvidSummaryMessage(
        'avidSiteSettingsBackedUp',
        '\n📦 Backed up {{count}} file(s) to:\n{{backupFolder}}',
        { count: backedUp.length, backupFolder }
      );
    }

    for (const file of targets) {
      const filePath = path.join(settingsFolder, file);
      try {
        await fs.unlink(filePath);
        deleted.push(file);
      } catch (err) {
        failed.push(file);
        logNLE(getLocalizedText(
          'avidDeleteSiteSettingFailed',
          '⚠️ Failed to delete site setting {{file}}: {{error}}',
          { file, error: err.message }
        ), { isError: true });
      }
    }

    if (deleted.length) {
      appendAvidSummaryMessage(
        'avidSiteSettingsDeleted',
        '\n🧹 Deleted site setting files:\n{{files}}',
        { files: deleted.join(', ') }
      );
    }
    if (failed.length) {
      appendAvidSummaryMessage(
        'avidSiteSettingsFailedCount',
        '\n⚠️ Failed to process {{count}} file(s): {{files}}',
        { count: failed.length, files: failed.join(', ') }
      );
      logNLE(getLocalizedText(
        'avidSiteSettingsResetFailedLog',
        '⚠️ Site settings reset completed with failures ({{count}} failed).',
        { count: failed.length }
      ), { isError: true });
    }
    const removedMessage = deleted.length
      ? getLocalizedText(
        'avidSiteSettingsResetCompleteWithRemoved',
        '✅ Site settings reset complete ({{deleted}} file(s) removed{{failedSuffix}}).',
        {
          deleted: deleted.length,
          failedSuffix: failed.length ? getLocalizedText(
            'avidFailedSuffix',
            ', {{failed}} failed',
            { failed: failed.length }
          ) : ''
        }
      )
      : getLocalizedText(
        'avidSiteSettingsResetCompleteNoRemoved',
        '✅ Site settings reset complete (no files removed{{failedSuffix}}).',
        {
          failedSuffix: failed.length ? getLocalizedText(
            'avidFailedSuffix',
            ', {{failed}} failed',
            { failed: failed.length }
          ) : ''
        }
      );
    logNLE(removedMessage);
  } catch (err) {
    appendAvidSummaryMessage(
      'avidResetSiteError',
      '\n❌ Error resetting site settings: {{error}}',
      { error: err.message }
    );
    logNLE(getLocalizedText(
      'avidResetSiteErrorLog',
      '❌ Error resetting site settings: {{error}}',
      { error: err.message }
    ), { isError: true });
  }
}));

// ===============================
// 🔧 Avid: User Settings Reset
// ===============================
const avidResetUserBtn = document.getElementById('avid-reset-user');
const avidBackupCheckbox = document.getElementById('avid-backup-settings');

const AVID_USER_RESET_NOEXT_FILES = new Set([
  'mcstate',
  'mc state'
]);
const AVID_USER_RESET_EXTS = ['.xml', '.avs'];

avidResetUserBtn?.addEventListener('click', () => withBusyState({
  section: avidSection,
  summary: avid.summary,
  messageEntry: getAvidBusyMessageEntry()
}, async () => {
  const baseFolder = avid.pathField.value;
  if (!baseFolder) {
    appendAvidSummaryMessage(
      'avidSelectFolderFirst',
      '\n❌ Please select an Avid folder first.'
    );
    return;
  }
  const normalized = String(baseFolder || '').replace(/\\/g, '/').replace(/[\\/]+$/, '');
  const parentDir = path.resolve(baseFolder, '..').replace(/\\/g, '/').replace(/[\\/]+$/, '');
  const parentLeaf = parentDir.split('/').pop().toLowerCase();

  const leafLower = String(path.basename(normalized)).toLowerCase();

  const isUsersFolderSelected =
    leafLower === 'avid users'
    || leafLower === 'avid_users'
    || leafLower === 'users';

  const isDirectUserFolder = (parentLeaf === 'avid users' || parentLeaf === 'avid_users' || parentLeaf === 'users')
    && leafLower !== parentLeaf;

  let selectedUser = avid.userSelect?.value;
  let userFolder = null;

  if (isDirectUserFolder) {
    selectedUser = path.basename(baseFolder);
    userFolder = baseFolder;
  } else if (isUsersFolderSelected) {
    if (!selectedUser) {
      appendAvidSummaryMessage(
        'avidSelectUserBeforeReset',
        '\n❌ Please select an Avid user before resetting.'
      );
      return;
    }
    userFolder = path.join(baseFolder, selectedUser);
  } else {
    const baseValidation = await validateAvidSettingsBase(baseFolder);
    if (!baseValidation.ok) {
      appendAvidSummaryDescriptors(baseValidation);
      return;
    }

    if (!selectedUser) {
      appendAvidSummaryMessage(
        'avidSelectUserBeforeReset',
        '\n❌ Please select an Avid user before resetting.'
      );
      return;
    }

    userFolder = path.join(baseValidation.usersFolder, selectedUser);
  }
  const isMediaComposerRunning = await checkMediaComposerRunning(avid.summary);
  if (isMediaComposerRunning) {
    appendAvidSummaryMessage(
      'avidQuitMediaComposerBeforeReset',
      '\n⚠️ Media Composer is currently running. Quit it before resetting.'
    );
    return;
  }
  const folder = userFolder;

  if (!(await isExistingDirectory(folder))) {
    appendAvidSummaryMessage(
      'avidUserFolderMissing',
      '\n❌ The user folder {{folder}} does not exist.',
      { folder }
    );
    return;
  }
  
  const confirmed = await ipc.showConfirm?.(
    getLocalizedText(
      'nleConfirmAvidResetUser',
      "This will delete Avid user settings for the selected user:\n\n• MCState (window/layout state)\n• *.xml (current settings)\n• *.avs (legacy settings, if present)\n\nNote: This does NOT delete the user profile (.ave).\n\nDo you want to continue?"
    )
  );
  if (!confirmed) {
    appendAvidSummaryMessage(
      'avidUserResetCanceled',
      '\n⛔ Deletion canceled by user.'
    );
    return;
  }

  const deleted = [];
  const backedUp = [];
  const failed = [];

  try {
    logNLE(getLocalizedText(
      'avidResetUserStart',
      '🚀 Resetting Avid user settings for “{{user}}”…',
      { user: selectedUser }
    ));

    const allFiles = (await readdirAsync(folder)).map(f => String(f));
    const targets = allFiles.filter((file) => {
      const lower = file.toLowerCase();
      if (AVID_USER_RESET_NOEXT_FILES.has(lower)) return true;
      return AVID_USER_RESET_EXTS.some(ext => lower.endsWith(ext));
    });

    if (targets.length === 0) {
      appendAvidSummaryMessage(
        'avidNoUserSettingsToDelete',
        '\n✅ No user settings files were found to delete for {{user}}.',
        { user: selectedUser }
      );
      return;
    }

    // 🔒 Optional Backup
    if (avidBackupCheckbox?.checked) {
      const backupFolder = path.join(folder, `User_Backup_${getBackupTimestamp()}`);
      await mkdirpAsync(backupFolder);

      for (const file of targets) {
        const src = path.join(folder, file);
        const dest = path.join(backupFolder, file);
        try {
          await fs.copyFile(src, dest);
          backedUp.push(file);
        } catch (err) {
          failed.push(file);
          logNLE(getLocalizedText(
            'avidBackupUserSettingFailed',
            '⚠️ Failed to back up user setting {{file}}: {{error}}',
            { file, error: err.message }
          ), { isError: true });
        }
      }

      appendAvidSummaryMessage(
        'avidUserSettingsBackedUp',
        '\n📦 Backed up {{count}} file(s) to:\n{{backupFolder}}',
        { count: backedUp.length, backupFolder }
      );
    }

    // 🧹 Delete settings
    for (const file of targets) {
      const filePath = path.join(folder, file);
      try {
        await fs.unlink(filePath);
        deleted.push(file);
      } catch (err) {
        failed.push(file);
        logNLE(getLocalizedText(
          'avidDeleteUserSettingFailed',
          '⚠️ Failed to delete user setting {{file}}: {{error}}',
          { file, error: err.message }
        ), { isError: true });
      }
    }

    if (deleted.length) {
      appendAvidSummaryMessage(
        'avidUserSettingsDeleted',
        '\n🧹 Deleted user setting files:\n{{files}}',
        { files: deleted.join(', ') }
      );
    }
    if (failed.length) {
      appendAvidSummaryMessage(
        'avidUserSettingsFailedCount',
        '\n⚠️ Failed to process {{count}} file(s): {{files}}',
        { count: failed.length, files: failed.join(', ') }
      );
      logNLE(getLocalizedText(
        'avidUserSettingsResetFailedLog',
        '⚠️ User settings reset completed with failures for {{user}} ({{count}} failed).',
        { user: selectedUser, count: failed.length }
      ), { isError: true });
    }
    const removedMessage = deleted.length
      ? getLocalizedText(
        'avidUserSettingsResetCompleteWithRemoved',
        '✅ User settings reset complete for {{user}} ({{deleted}} file(s) removed{{failedSuffix}}).',
        {
          user: selectedUser,
          deleted: deleted.length,
          failedSuffix: failed.length ? getLocalizedText(
            'avidFailedSuffix',
            ', {{failed}} failed',
            { failed: failed.length }
          ) : ''
        }
      )
      : getLocalizedText(
        'avidUserSettingsResetCompleteNoRemoved',
        '✅ User settings reset complete for {{user}} (no files removed{{failedSuffix}}).',
        {
          user: selectedUser,
          failedSuffix: failed.length ? getLocalizedText(
            'avidFailedSuffix',
            ', {{failed}} failed',
            { failed: failed.length }
          ) : ''
        }
      );
    logNLE(removedMessage);
  } catch (err) {
    appendAvidSummaryMessage(
      'avidResetUserError',
      '\n❌ Error: {{error}}',
      { error: err.message }
    );
    logNLE(getLocalizedText(
      'avidResetUserErrorLog',
      '❌ Error resetting user settings for {{user}}: {{error}}',
      { user: selectedUser, error: err.message }
    ), { isError: true });
  }
}));

// ===============================
// 🧼 Adobe: Folder Picker + Setup
// ===============================
const adobe = {
  selectFolderBtn: document.getElementById('adobe-select-folder'),
  pathField: document.getElementById('adobe-folder-path'),
  summary: document.getElementById('adobe-summary'),
  clearCache: document.getElementById('adobe-clear-cache'),
  deleteAutosaves: document.getElementById('adobe-delete-autosaves'),
  removePreviews: document.getElementById('adobe-remove-previews')
};

// File extensions used across Adobe cleanup actions
const mediaCacheExtensions = [
  '.pek',
  '.cfa',
  '.ims',
  '.mcdb',
  '.mxf',
  '.mpgindex',
  '.mxfindex',
  '.wav.cfa',
  '.prmdc2'
];

const previewExtensions = [
  '.mpg',
  '.mpeg',
  '.mp4',
  '.mov',
  '.avi',
  '.m4v',
  '.mxf'
];

const normalizeExtensions = (extensions) => Array.from(new Set(
  (extensions || [])
    .map(ext => String(ext || '').trim())
    .filter(Boolean)
    .map(ext => ext.startsWith('.') ? ext : `.${ext}`)
    .map(ext => ext.toLowerCase())
    .filter(ext => ext.length > 1)
));

// Premiere autosaves are typically stored in a folder whose name contains "Auto-Save".
// For v1 safety: only delete .prproj files that live inside an Auto-Save-like folder.
function isPremiereAutosaveProjectPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (!normalized.endsWith('.prproj')) return false;

  const parts = normalized.split('/').filter(Boolean);
  // Remove filename
  parts.pop();

  const autosaveMarkers = [
    'auto-save',
    'autosave',
    'auto save',
    'auto-saves',
    'autosaves',
    'auto saves'
  ];
  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const autosaveMarkerPattern = new RegExp(
    `^(${autosaveMarkers.map(escapeRegex).join('|')})(\\s+\\d+)?$`
  );

  return parts.some(seg => {
    const s = String(seg || '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return autosaveMarkerPattern.test(s)
      || autosaveMarkers.some(m => s.endsWith(` ${m}`));
  });
}

function validateAdobeAgeFilter() {
  const skipRecent = document.getElementById('adobe-skip-recent')?.checked;
  const ageRaw = (document.getElementById('adobe-age-days')?.value || '').trim();
  const ageDays = parseInt(ageRaw || '0', 10);

  if (skipRecent && (!Number.isFinite(ageDays) || ageDays <= 0)) {
    appendAdobeSummaryMessage(
      'adobeSkipRecentRequiresAge',
      '\n❌ "Skip recent" requires a positive age (days) value.'
    );
    return { ok: false, skipRecent, ageDays };
  }

  return {
    ok: true,
    skipRecent,
    ageDays,
    skipRecentEffective: !!skipRecent && Number.isFinite(ageDays) && ageDays > 0
  };
}

const adobeCacheGuardFolders = [
  'Media Cache',
  'Media Cache Files',
  'Media Cache Databases'
];

const adobePreviewGuardFolders = [
  'Preview Files',
  'Adobe Premiere Pro Preview Files',
  'Render Cache',
  'Render Cache Files',
  'Render Files'
];

function normalizePathSegments(targetPath) {
  return String(targetPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map(segment => segment.toLowerCase());
}

function isPathWithinNamedFolder(targetPath, folderNames = []) {
  const segments = normalizePathSegments(targetPath);
  return folderNames.some(name => segments.includes(String(name || '').toLowerCase()));
}

let cachedPlatform = null;
const getSafePlatform = async () => {
  if (typeof cachedPlatform === 'string') return cachedPlatform;
  const platform = ipc?.platform;
  if (typeof platform === 'string') {
    cachedPlatform = platform;
    return cachedPlatform;
  }
  if (typeof ipc?.invoke === 'function') {
    try {
      const maybePlatform = await ipc.invoke('get-platform');
      if (typeof maybePlatform === 'string') {
        cachedPlatform = maybePlatform;
        return cachedPlatform;
      }
    } catch {
      // ignore
    }
  }
  if (typeof navigator !== 'undefined' && typeof navigator.platform === 'string') {
    cachedPlatform = navigator.platform;
    return cachedPlatform;
  }
  cachedPlatform = 'unknown';
  return cachedPlatform;
};

async function resolveAdobeScope(folder, scopeInput) {
  const baseResolvedFs = path.resolve(folder);
  let scanRoot = folder;

  if (!scopeInput) {
    return {
      ok: true,
      scanRoot,
      scopeApplied: false,
      scopeLineEntry: null,
      scopeLabelEntry: null
    };
  }

  const scopedResolvedFs = path.resolve(folder, scopeInput);
  const scopedResolved = scopedResolvedFs.replace(/\\/g, '/');
  const safePlatform = await getSafePlatform();
  const isWindowsPlatform = typeof safePlatform === 'string' && safePlatform.toLowerCase().startsWith('win');
  const baseCompare = isWindowsPlatform ? baseResolvedFs.toLowerCase() : baseResolvedFs;
  const scopedCompare = isWindowsPlatform ? scopedResolvedFs.toLowerCase() : scopedResolvedFs;
  const relativeScope = path.relative(baseCompare, scopedCompare);
  const isInsideScope =
    relativeScope === '' ||
    (!relativeScope.startsWith(`..${path.sep}`) &&
      relativeScope !== '..' &&
      !path.isAbsolute(relativeScope));

  if (!isInsideScope) {
    return {
      ok: false,
      messageEntry: {
        key: 'adobeScopeMustStayInside',
        fallback: '\n❌ Scope must stay inside the selected Adobe folder.',
        params: {}
      }
    };
  }

  try {
    const stats = await fs.stat(scopedResolvedFs);
    if (!isDirectoryLike(stats)) {
      return {
        ok: false,
        messageEntry: {
          key: 'adobeScopedPathNotFolder',
          fallback: '\n❌ Scoped path is not a folder: {{path}}',
          params: { path: scopedResolved }
        }
      };
    }
  } catch (err) {
    return {
      ok: false,
      messageEntry: {
        key: 'adobeScopedPathReadFailed',
        fallback: '\n❌ Unable to read scoped path: {{error}}',
        params: { error: err.message }
      }
    };
  }

  scanRoot = scopedResolvedFs;
  const scopeApplied = scanRoot !== folder;

  return {
    ok: true,
    scanRoot,
    scopeApplied,
    scopeLineEntry: scopeApplied
      ? { key: 'adobeScopeLine', fallback: 'Scope: {{scope}}\n', params: { scope: scanRoot } }
      : null,
    scopeLabelEntry: scopeApplied
      ? { key: 'adobeScopeLabel', fallback: ' within scope {{scope}}', params: { scope: scanRoot } }
      : null
  };
}

// ===============================
// 🧹 Adobe: Clear Media Cache Logic
// ===============================
adobe.clearCache?.addEventListener('click', () => withBusyState({
  section: adobeSection,
  summary: adobe.summary,
  messageEntry: getAdobeBusyMessageEntry()
}, async () => {
  let folder = adobe.pathField.value;
  if (!folder) {
    appendAdobeSummaryMessage(
      'adobeSelectFolderFirst',
      '\n❌ Please select an Adobe folder first.'
    );
    return;
  }

  // Paths typed/pasted into inputs or loaded via presets are not auto-approved.
  // Approve silently here (user confirmation already happens below).
  const approval = await ensureApprovedDir(
    folder,
    getLocalizedText('adobeFolderLabel', 'Adobe folder')
  );
  if (!approval.ok) {
    const approvalEntry = approval.messageEntry || {};
    appendAdobeSummaryMessage(
      approvalEntry.key || '',
      `\n${approvalEntry.fallback || ''}`,
      approvalEntry.params || {}
    );
    return;
  }
  folder = approval.approvedPath || folder;

  const filterInput = document.getElementById('adobe-media-cache-filter')?.value?.trim() || '';
  const scopeInput = document.getElementById('adobe-media-cache-scope')?.value?.trim() || '';

  const parsedFilters = normalizeExtensions(filterInput.split(/[,\s]+/));
  const extensionsToUse = parsedFilters.length > 0
    ? parsedFilters
    : normalizeExtensions(mediaCacheExtensions);

  if (parsedFilters.length > 0 && extensionsToUse.length === 0) {
    appendAdobeSummaryMessage(
      'adobeProvideValidExtension',
      '\n❌ Please provide at least one valid extension (e.g., .cfa, .pek).'
    );
    return;
  }

  const scopeResult = await resolveAdobeScope(folder, scopeInput);
  if (!scopeResult.ok) {
    if (scopeResult.messageEntry?.key || scopeResult.messageEntry?.fallback) {
      appendAdobeSummaryMessage(scopeResult.messageEntry.key || '', scopeResult.messageEntry.fallback || '', scopeResult.messageEntry.params || {});
    } else if (scopeResult.rawMessageEntry?.key || scopeResult.rawMessageEntry?.fallback) {
      appendAdobeSummaryMessage(
        scopeResult.rawMessageEntry.key || '',
        scopeResult.rawMessageEntry.fallback || '',
        scopeResult.rawMessageEntry.params || {}
      );
    } else if (scopeResult.rawMessage) {
      appendAdobeSummaryText(scopeResult.rawMessage, { isLocalizedRaw: false });
    }
    return;
  }
  const { scanRoot, scopeLineEntry, scopeLabelEntry } = scopeResult;
  const scopeLine = getMessageEntryText(scopeLineEntry);
  const scopeLabel = getMessageEntryText(scopeLabelEntry);

  const mediaCacheList = extensionsToUse.map(ext => `• ${ext}`).join('\n');

  const confirmed = await ipc.showConfirm?.(
    getLocalizedText(
      'nleConfirmAdobeClearCache',
      `This will permanently delete Adobe media cache files:\n\n${mediaCacheList}\n\n${scopeLine}Safety guard: if the selected path doesn't look like a Media Cache folder, you'll be asked to confirm a second time to proceed.\n\nDo you want to continue?`,
      { mediaCacheList, scopeLine }
    )
  );
  if (!confirmed) {
    appendAdobeSummaryMessage(
      'adobeCacheClearingCanceled',
      '\n⛔ Cache clearing canceled by user.'
    );
    return;
  }

  if (!isPathWithinNamedFolder(scanRoot, adobeCacheGuardFolders)) {
    const guardFolderList = adobeCacheGuardFolders.map(name => `• ${name}`).join('\n');
    const guardConfirmed = await ipc.showConfirm?.(
      getLocalizedText(
        'nleConfirmAdobeCacheSafetyOverride',
        `Safety guard: "${scanRoot}" does not look like a Media Cache folder.\n\nExpected folder names:\n${guardFolderList}\n\nIf you understand the risk and still want to proceed, click OK again.`,
        { scanRoot, guardFolderList }
      )
    );
    if (!guardConfirmed) {
      appendAdobeSummaryMessage(
        'adobeCacheClearingCanceledByGuard',
        '\n⛔ Cache clearing canceled by safety guard.'
      );
      return;
    }
  }

const ageValidation = validateAdobeAgeFilter();
if (!ageValidation.ok) {
  return;
}
const { ageDays, skipRecentEffective } = ageValidation;
const sizeFilterEnabled = document.getElementById('adobe-size-skip')?.checked;

// v1 validation: if size filter is enabled, reject empty/0 so cleanup doesn't silently skip everything.
const sizeLimitRaw = (document.getElementById('adobe-size-mb')?.value || '').trim();
const sizeLimitMB = parseInt(sizeLimitRaw, 10);

  if (sizeFilterEnabled) {
    if (!Number.isFinite(sizeLimitMB) || sizeLimitMB <= 0) {
    appendAdobeSummaryMessage(
      'adobeSizeFilterRequiresLimit',
      '\n❌ Size filter is enabled, but the size limit is empty or 0. Enter a value of 1 MB or higher.'
    );
    return;
  }
}

const needsStat = skipRecentEffective || !!sizeFilterEnabled;



  let deleted = 0;
  let skipped = 0;

  try {
    logNLE(getLocalizedText('adobeClearCacheStart', '🚀 Clearing Adobe media cache files…'));

    const {
      files: allFiles,
      metadataByPath,
      truncated,
      timedOut,
      scanFailed,
      scanError
    } = await readdirRecursive(scanRoot, {
      includeExtensions: extensionsToUse,
      includeMetadata: needsStat,
      allowSyncFallback: true
    });
    const now = Date.now();

    let errors = 0;
const MAX_ERROR_LINES = 25;
const errorEntries = [];
let suppressedErrors = false;

let checked = 0;

for (let i = 0; i < allFiles.length; i++) {
  const filePath = allFiles[i];
  checked++;

  if (needsStat) {
    const metadata = metadataByPath?.[filePath];
    if (!metadata || typeof metadata.mtimeMs !== 'number' || typeof metadata.size !== 'number') {
      errors++;
      if (errorEntries.length < MAX_ERROR_LINES) {
        errorEntries.push({
          key: 'adobeReadFileStatsFailed',
          fallback: '❌ Failed to read file stats: {{filePath}}: {{error}}',
          params: { filePath, error: 'metadata unavailable' }
        });
      } else {
        suppressedErrors = true;
      }
      if (checked % 250 === 0) await yieldToUI();
      continue;
    }

    const fileAgeDays = (now - (Number(metadata.mtimeMs) || 0)) / (1000 * 60 * 60 * 24);
    const fileSizeMB = (Number(metadata.size) || 0) / (1024 * 1024);

    // Apply filters
    if (skipRecentEffective && fileAgeDays < ageDays) {
      skipped++;
      if (checked % 250 === 0) await yieldToUI();
      continue;
    }

    if (sizeFilterEnabled && fileSizeMB > sizeLimitMB) {
      skipped++;
      if (checked % 250 === 0) await yieldToUI();
      continue;
    }
  }

  try {
    await fs.unlink(filePath);
    deleted++;
  } catch (err) {
    errors++;
    if (errorEntries.length < MAX_ERROR_LINES) {
      errorEntries.push({
        key: 'adobeDeleteFileFailed',
        fallback: '❌ Failed to delete {{filePath}}: {{error}}',
        params: { filePath, error: err.message }
      });
    } else {
      suppressedErrors = true;
    }
  }

  if (checked % 250 === 0) {
    await yieldToUI();
  }
}

if (errorEntries.length) {
  appendAdobeSummaryBatch(errorEntries, { prefix: '\n', separator: '\n' });
}
if (suppressedErrors) {
  appendAdobeSummaryMessage(
    'adobeAdditionalErrorsSuppressed',
    '\n⚠️ Additional errors were suppressed. Check logs for details.'
  );
}
if (errors > 0) {
  appendAdobeSummaryMessage(
    'adobeErrorsEncountered',
    '\n❌ Errors encountered: {{count}}.',
    { count: errors }
  );
}
if (timedOut) {
  appendAdobeSummaryMessage(
    'adobeScanTimedOut',
    '\n⚠️ Scan timed out before reaching all files. Results may be incomplete.'
  );
} else if (truncated) {
  appendAdobeSummaryMessage(
    'adobeScanHitFileLimitWithScope',
    '\n⚠️ Scan hit the file limit and may be incomplete. Narrow the folder or use Scope.'
  );
}
  if (scanFailed) {
    appendAdobeSummaryMessage(
      'adobeScanFailed',
      '\n⚠️ Scan failed; no files were processed.'
    );
    if (scanError) {
      appendAdobeSummaryMessage(
        'adobeScanFailedReason',
        '\n⚠️ Scan failure reason: {{error}}',
        { error: scanError }
      );
    }
  }

    appendAdobeSummaryMessage(
      'adobeDeletedMediaCacheFiles',
      '\n🧹 Deleted {{count}} media cache file(s){{scopeLabel}}.',
      { count: deleted, scopeLabel }
    );
    appendAdobeSummaryMessage(
      'adobeExtensionsTargeted',
      '\n🔍 Extensions targeted: {{extensions}}',
      { extensions: extensionsToUse.join(', ') }
    );
    if (skipped > 0) {
      appendAdobeSummaryMessage(
        'adobeSkippedDueToFilters',
        '\n⏩ Skipped {{count}} file(s) due to filters.',
        { count: skipped }
      );
    }

    if (deleted === 0 && skipped === 0 && !scanFailed) {
      appendAdobeSummaryMessage(
        'adobeNoMediaCacheFilesFound',
        '\n✅ No media cache files found.'
      );
    }

    logNLE(getLocalizedText(
      'adobeMediaCacheCleanupComplete',
      '✅ Adobe media cache cleanup complete ({{deleted}} deleted, {{skipped}} skipped).',
      { deleted, skipped }
    ));

  } catch (err) {
    appendAdobeSummaryMessage(
      'adobeClearCacheError',
      '\n❌ Error clearing cache: {{error}}',
      { error: err.message }
    );
    logNLE(getLocalizedText(
      'adobeClearCacheErrorLog',
      '❌ Error clearing Adobe media cache: {{error}}',
      { error: err.message }
    ), { isError: true });
  }
}));

// ===============================
// 🗑 Adobe: Delete Autosave Logic
// ===============================
adobe.deleteAutosaves?.addEventListener('click', () => withBusyState({
  section: adobeSection,
  summary: adobe.summary,
  messageEntry: getAdobeBusyMessageEntry()
}, async () => {
  let folder = adobe.pathField.value;
  if (!folder) {
    appendAdobeSummaryMessage(
      'adobeSelectFolderFirst',
      '\n❌ Please select an Adobe folder first.'
    );
    return;
  }

  // Paths typed/pasted into inputs or loaded via presets are not auto-approved.
  // Approve silently here (user confirmation already happens below).
  const approval = await ensureApprovedDir(
    folder,
    getLocalizedText('adobeFolderLabel', 'Adobe folder')
  );
  if (!approval.ok) {
    const approvalEntry = approval.messageEntry || {};
    appendAdobeSummaryMessage(
      approvalEntry.key || '',
      `\n${approvalEntry.fallback || ''}`,
      approvalEntry.params || {}
    );
    return;
  }
  folder = approval.approvedPath || folder;

  const scopeInput = document.getElementById('adobe-media-cache-scope')?.value?.trim() || '';
  const scopeResult = await resolveAdobeScope(folder, scopeInput);
  if (!scopeResult.ok) {
    if (scopeResult.messageEntry?.key || scopeResult.messageEntry?.fallback) {
      appendAdobeSummaryMessage(scopeResult.messageEntry.key || '', scopeResult.messageEntry.fallback || '', scopeResult.messageEntry.params || {});
    } else if (scopeResult.rawMessageEntry?.key || scopeResult.rawMessageEntry?.fallback) {
      appendAdobeSummaryMessage(
        scopeResult.rawMessageEntry.key || '',
        scopeResult.rawMessageEntry.fallback || '',
        scopeResult.rawMessageEntry.params || {}
      );
    } else if (scopeResult.rawMessage) {
      appendAdobeSummaryText(scopeResult.rawMessage, { isLocalizedRaw: false });
    }
    return;
  }
  const { scanRoot, scopeLineEntry, scopeLabelEntry } = scopeResult;
  const scopeLine = getMessageEntryText(scopeLineEntry);
  const scopeLabel = getMessageEntryText(scopeLabelEntry);

  const confirmed = await ipc.showConfirm?.(
    getLocalizedText(
      'nleConfirmAdobeDeleteAutosaves',
      `This will permanently delete Adobe autosave project files (".prproj") found inside Auto-Save folders under:\n\n${folder}\n\n${scopeLine}It will NOT delete project files outside Auto-Save folders.\n\nDo you want to continue?`,
      { folder, scopeLine }
    )
  );
  if (!confirmed) {
    appendAdobeSummaryMessage(
      'adobeAutosaveDeletionCanceled',
      '\n⛔ Autosave deletion canceled by user.'
    );
    return;
  }

const ageValidation = validateAdobeAgeFilter();
if (!ageValidation.ok) {
  return;
}
const { ageDays, skipRecentEffective } = ageValidation;
const sizeFilterEnabled = document.getElementById('adobe-size-skip')?.checked;

// v1 validation: if size filter is enabled, reject empty/0 so cleanup doesn't silently skip everything.
const sizeLimitRaw = (document.getElementById('adobe-size-mb')?.value || '').trim();
const sizeLimitMB = parseInt(sizeLimitRaw, 10);

if (sizeFilterEnabled) {
  if (!Number.isFinite(sizeLimitMB) || sizeLimitMB <= 0) {
    appendAdobeSummaryMessage(
      'adobeSizeFilterRequiresLimit',
      '\n❌ Size filter is enabled, but the size limit is empty or 0. Enter a value of 1 MB or higher.'
    );
    return;
  }
}

const needsStat = skipRecentEffective || !!sizeFilterEnabled;


  let deleted = 0;
  let skipped = 0;
  let protectedProjects = 0;

  try {
    logNLE(getLocalizedText('adobeAutosaveDeleteStart', '🚀 Deleting Adobe autosave files…'));

    const {
      files: allFiles,
      metadataByPath,
      truncated,
      timedOut,
      scanFailed,
      scanError
    } = await readdirRecursive(scanRoot, {
      includeExtensions: ['.prproj'],
      includeMetadata: needsStat,
      allowSyncFallback: true
    });
    const now = Date.now();

    let errors = 0;
const MAX_ERROR_LINES = 25;
const errorEntries = [];
let suppressedErrors = false;

let checked = 0;

for (let i = 0; i < allFiles.length; i++) {
  const file = allFiles[i];
  checked++;

  if (!isPremiereAutosaveProjectPath(file)) {
    // Safety: never delete regular Premiere project files.
    protectedProjects++;
    if (checked % 250 === 0) await yieldToUI();
    continue;
  }

  const filePath = file;

  if (needsStat) {
    const metadata = metadataByPath?.[filePath];
    if (!metadata || typeof metadata.mtimeMs !== 'number' || typeof metadata.size !== 'number') {
      errors++;
      if (errorEntries.length < MAX_ERROR_LINES) {
        errorEntries.push({
          key: 'adobeReadFileStatsFailed',
          fallback: '❌ Failed to read file stats: {{filePath}}: {{error}}',
          params: { filePath, error: 'metadata unavailable' }
        });
      } else {
        suppressedErrors = true;
      }
      if (checked % 250 === 0) await yieldToUI();
      continue;
    }

    const fileAgeDays = (now - (Number(metadata.mtimeMs) || 0)) / (1000 * 60 * 60 * 24);
    const fileSizeMB = (Number(metadata.size) || 0) / (1024 * 1024);

    if (skipRecentEffective && fileAgeDays < ageDays) {
      skipped++;
      if (checked % 250 === 0) await yieldToUI();
      continue;
    }

    if (sizeFilterEnabled && fileSizeMB > sizeLimitMB) {
      skipped++;
      if (checked % 250 === 0) await yieldToUI();
      continue;
    }
  }

  try {
    await fs.unlink(filePath);
    deleted++;
  } catch (err) {
    errors++;
    if (errorEntries.length < MAX_ERROR_LINES) {
      errorEntries.push({
        key: 'adobeDeleteFileFailed',
        fallback: '❌ Failed to delete {{filePath}}: {{error}}',
        params: { filePath, error: err.message }
      });
    } else {
      suppressedErrors = true;
    }
  }

  if (checked % 250 === 0) {
    await yieldToUI();
  }
}

if (errorEntries.length) {
  appendAdobeSummaryBatch(errorEntries, { prefix: '\n', separator: '\n' });
}
if (suppressedErrors) {
  appendAdobeSummaryMessage(
    'adobeAdditionalErrorsSuppressed',
    '\n⚠️ Additional errors were suppressed. Check logs for details.'
  );
}
if (errors > 0) {
  appendAdobeSummaryMessage(
    'adobeErrorsEncountered',
    '\n❌ Errors encountered: {{count}}.',
    { count: errors }
  );
}
if (timedOut) {
  appendAdobeSummaryMessage(
    'adobeScanTimedOut',
    '\n⚠️ Scan timed out before reaching all files. Results may be incomplete.'
  );
} else if (truncated) {
  appendAdobeSummaryMessage(
    'adobeScanHitFileLimit',
    '\n⚠️ Scan hit the file limit and may be incomplete. Narrow the folder.'
  );
}
  if (scanFailed) {
    appendAdobeSummaryMessage(
      'adobeScanFailed',
      '\n⚠️ Scan failed; no files were processed.'
    );
    if (scanError) {
      appendAdobeSummaryMessage(
        'adobeScanFailedReason',
        '\n⚠️ Scan failure reason: {{error}}',
        { error: scanError }
      );
    }
  }

    appendAdobeSummaryMessage(
      'adobeDeletedAutosaveFiles',
      '\n🗑 Deleted {{count}} autosave file(s){{scopeLabel}}.',
      { count: deleted, scopeLabel }
    );
    if (skipped > 0) {
      appendAdobeSummaryMessage(
        'adobeSkippedDueToFilters',
        '\n⏩ Skipped {{count}} file(s) due to filters.',
        { count: skipped }
      );
    }

    if (protectedProjects > 0) {
      appendAdobeSummaryMessage(
        'adobeProtectedProjects',
        '\n🔒 Protected {{count}} project file(s) outside Auto-Save folders.',
        { count: protectedProjects }
      );
    }

    if (deleted === 0 && skipped === 0 && !scanFailed) {
      appendAdobeSummaryMessage(
        'adobeNoAutosaveFilesFound',
        '\n✅ No autosave files found.'
      );
    }

    logNLE(getLocalizedText(
      'adobeAutosaveCleanupComplete',
      '✅ Adobe autosave cleanup complete ({{deleted}} deleted, {{skipped}} skipped, {{protected}} protected).',
      { deleted, skipped, protected: protectedProjects }
    ));

  } catch (err) {
    appendAdobeSummaryMessage(
      'adobeAutosaveDeleteError',
      '\n❌ Error deleting autosaves: {{error}}',
      { error: err.message }
    );
    logNLE(getLocalizedText(
      'adobeAutosaveDeleteErrorLog',
      '❌ Error deleting Adobe autosaves: {{error}}',
      { error: err.message }
    ), { isError: true });
  }
}));

// ===============================
// 🗑 Adobe: Remove Preview Files Logic
// ===============================
adobe.removePreviews?.addEventListener('click', () => withBusyState({
  section: adobeSection,
  summary: adobe.summary,
  messageEntry: getAdobeBusyMessageEntry()
}, async () => {
  let folder = adobe.pathField.value;
  if (!folder) {
    appendAdobeSummaryMessage(
      'adobeSelectFolderFirst',
      '\n❌ Please select an Adobe folder first.'
    );
    return;
  }

  // Paths typed/pasted into inputs or loaded via presets are not auto-approved.
  // Approve silently here (user confirmation already happens below).
  const approval = await ensureApprovedDir(
    folder,
    getLocalizedText('adobeFolderLabel', 'Adobe folder')
  );
  if (!approval.ok) {
    const approvalEntry = approval.messageEntry || {};
    appendAdobeSummaryMessage(
      approvalEntry.key || '',
      `\n${approvalEntry.fallback || ''}`,
      approvalEntry.params || {}
    );
    return;
  }
  folder = approval.approvedPath || folder;

  const scopeInput = document.getElementById('adobe-media-cache-scope')?.value?.trim() || '';
  const scopeResult = await resolveAdobeScope(folder, scopeInput);
  if (!scopeResult.ok) {
    if (scopeResult.messageEntry?.key || scopeResult.messageEntry?.fallback) {
      appendAdobeSummaryMessage(scopeResult.messageEntry.key || '', scopeResult.messageEntry.fallback || '', scopeResult.messageEntry.params || {});
    } else if (scopeResult.rawMessageEntry?.key || scopeResult.rawMessageEntry?.fallback) {
      appendAdobeSummaryMessage(
        scopeResult.rawMessageEntry.key || '',
        scopeResult.rawMessageEntry.fallback || '',
        scopeResult.rawMessageEntry.params || {}
      );
    } else if (scopeResult.rawMessage) {
      appendAdobeSummaryText(scopeResult.rawMessage, { isLocalizedRaw: false });
    }
    return;
  }
  const { scanRoot, scopeLineEntry, scopeLabelEntry } = scopeResult;
  const scopeLine = getMessageEntryText(scopeLineEntry);
  const scopeLabel = getMessageEntryText(scopeLabelEntry);

  const previewList = previewExtensions.map(ext => `• ${ext}`).join('\n');
  const confirmed = await ipc.showConfirm?.(
    getLocalizedText(
      'nleConfirmAdobeDeletePreviews',
      `This will permanently delete Adobe preview files:\n\n${previewList}\n\n${scopeLine}Safety guard: if the selected path doesn't look like a Preview/Render cache folder, you'll be asked to confirm a second time to proceed.\n\nDo you want to continue?`,
      { previewList, scopeLine }
    )
  );
  if (!confirmed) {
    appendAdobeSummaryMessage(
      'adobePreviewDeletionCanceled',
      '\n⛔ Preview deletion canceled by user.'
    );
    return;
  }

  if (!isPathWithinNamedFolder(scanRoot, adobePreviewGuardFolders)) {
    const guardFolderList = adobePreviewGuardFolders.map(name => `• ${name}`).join('\n');
    const guardConfirmed = await ipc.showConfirm?.(
      getLocalizedText(
        'nleConfirmAdobePreviewSafetyOverride',
        `Safety guard: "${scanRoot}" does not look like a Preview/Render cache folder.\n\nExpected folder names:\n${guardFolderList}\n\nIf you understand the risk and still want to proceed, click OK again.`,
        { scanRoot, guardFolderList }
      )
    );
    if (!guardConfirmed) {
      appendAdobeSummaryMessage(
        'adobePreviewDeletionCanceledByGuard',
        '\n⛔ Preview deletion canceled by safety guard.'
      );
      return;
    }
  }

const ageValidation = validateAdobeAgeFilter();
if (!ageValidation.ok) {
  return;
}
const { ageDays, skipRecentEffective } = ageValidation;
const sizeFilterEnabled = document.getElementById('adobe-size-skip')?.checked;

// v1 validation: if size filter is enabled, reject empty/0 so cleanup doesn't silently skip everything.
const sizeLimitRaw = (document.getElementById('adobe-size-mb')?.value || '').trim();
const sizeLimitMB = parseInt(sizeLimitRaw, 10);

if (sizeFilterEnabled) {
  if (!Number.isFinite(sizeLimitMB) || sizeLimitMB <= 0) {
    appendAdobeSummaryMessage(
      'adobeSizeFilterRequiresLimit',
      '\n❌ Size filter is enabled, but the size limit is empty or 0. Enter a value of 1 MB or higher.'
    );
    return;
  }
}

const needsStat = skipRecentEffective || !!sizeFilterEnabled;



  let deleted = 0;
  let skipped = 0;

  try {
    logNLE(getLocalizedText('adobePreviewDeleteStart', '🚀 Deleting Adobe preview files…'));

    const {
      files: allFiles,
      metadataByPath,
      truncated,
      timedOut,
      scanFailed,
      scanError
    } = await readdirRecursive(scanRoot, {
      includeExtensions: normalizeExtensions(previewExtensions),
      includeMetadata: needsStat,
      allowSyncFallback: true
    });
    const now = Date.now();

    let errors = 0;
const MAX_ERROR_LINES = 25;
const errorEntries = [];
let suppressedErrors = false;

let checked = 0;

for (let i = 0; i < allFiles.length; i++) {
  const file = allFiles[i];
  checked++;

  const filePath = file;

  if (needsStat) {
    const metadata = metadataByPath?.[filePath];
    if (!metadata || typeof metadata.mtimeMs !== 'number' || typeof metadata.size !== 'number') {
      errors++;
      if (errorEntries.length < MAX_ERROR_LINES) {
        errorEntries.push({
          key: 'adobeReadFileStatsFailed',
          fallback: '❌ Failed to read file stats: {{filePath}}: {{error}}',
          params: { filePath, error: 'metadata unavailable' }
        });
      } else {
        suppressedErrors = true;
      }
      if (checked % 250 === 0) await yieldToUI();
      continue;
    }

    const fileAgeDays = (now - (Number(metadata.mtimeMs) || 0)) / (1000 * 60 * 60 * 24);
    const fileSizeMB = (Number(metadata.size) || 0) / (1024 * 1024);

    if (skipRecentEffective && fileAgeDays < ageDays) {
      skipped++;
      if (checked % 250 === 0) await yieldToUI();
      continue;
    }

    if (sizeFilterEnabled && fileSizeMB > sizeLimitMB) {
      skipped++;
      if (checked % 250 === 0) await yieldToUI();
      continue;
    }
  }

  try {
    await fs.unlink(filePath);
    deleted++;
  } catch (err) {
    errors++;
    if (errorEntries.length < MAX_ERROR_LINES) {
      errorEntries.push({
        key: 'adobeDeletePreviewFailed',
        fallback: '❌ Failed to delete {{file}}: {{error}}',
        params: { file: path.basename(file), error: err.message }
      });
    } else {
      suppressedErrors = true;
    }
  }

  if (checked % 250 === 0) {
    await yieldToUI();
  }
}

if (errorEntries.length) {
  appendAdobeSummaryBatch(errorEntries, { prefix: '\n', separator: '\n' });
}
if (suppressedErrors) {
  appendAdobeSummaryMessage(
    'adobeAdditionalErrorsSuppressed',
    '\n⚠️ Additional errors were suppressed. Check logs for details.'
  );
}
if (errors > 0) {
  appendAdobeSummaryMessage(
    'adobeErrorsEncountered',
    '\n❌ Errors encountered: {{count}}.',
    { count: errors }
  );
}
if (timedOut) {
  appendAdobeSummaryMessage(
    'adobeScanTimedOut',
    '\n⚠️ Scan timed out before reaching all files. Results may be incomplete.'
  );
} else if (truncated) {
  appendAdobeSummaryMessage(
    'adobeScanHitFileLimit',
    '\n⚠️ Scan hit the file limit and may be incomplete. Narrow the folder.'
  );
}
  if (scanFailed) {
    appendAdobeSummaryMessage(
      'adobeScanFailed',
      '\n⚠️ Scan failed; no files were processed.'
    );
    if (scanError) {
      appendAdobeSummaryMessage(
        'adobeScanFailedReason',
        '\n⚠️ Scan failure reason: {{error}}',
        { error: scanError }
      );
    }
  }

    appendAdobeSummaryMessage(
      'adobeDeletedPreviewFiles',
      '\n🗑 Deleted {{count}} preview file(s){{scopeLabel}}.',
      { count: deleted, scopeLabel }
    );
    if (skipped > 0) {
      appendAdobeSummaryMessage(
        'adobeSkippedDueToFilters',
        '\n⏩ Skipped {{count}} file(s) due to filters.',
        { count: skipped }
      );
    }

    if (deleted === 0 && skipped === 0 && !scanFailed) {
      appendAdobeSummaryMessage(
        'adobeNoPreviewFilesFound',
        '\n✅ No preview files found.'
      );
    }

    logNLE(getLocalizedText(
      'adobePreviewCleanupComplete',
      '✅ Adobe preview cleanup complete ({{deleted}} deleted, {{skipped}} skipped).',
      { deleted, skipped }
    ));

  } catch (err) {
    appendAdobeSummaryMessage(
      'adobePreviewDeleteError',
      '\n❌ Error deleting preview files: {{error}}',
      { error: err.message }
    );
    logNLE(getLocalizedText(
      'adobePreviewDeleteErrorLog',
      '❌ Error deleting Adobe preview files: {{error}}',
      { error: err.message }
    ), { isError: true });
  }
}));

adobe.selectFolderBtn?.addEventListener('click', async () => {
  const folder = await ipc.selectFolder?.();
  if (folder) {
    adobe.pathField.value = folder;
    adobeSummaryState.mode = SUMMARY_MODE_SELECTED_FOLDER;
    adobeSummaryState.selectedFolder = folder;
    adobeSummaryState.entries = [];
    renderAdobeSummaryState();
  } else {
    adobeSummaryState.mode = SUMMARY_MODE_CANCELED;
    adobeSummaryState.selectedFolder = '';
    adobeSummaryState.entries = [];
    renderAdobeSummaryState();
  }
});

  // ===============================
  // 💾 Preset Handling
  // ===============================
  const saveBtn = document.getElementById('nle-save-config');
  const loadBtn = document.getElementById('nle-load-config');

  function gatherConfig() {
    const adobeSizeSkipToggle = document.getElementById('adobe-size-skip');
    const adobeSizeLimitField = document.getElementById('adobe-size-mb');
    const adobeCacheFilterField = document.getElementById('adobe-media-cache-filter');
    const adobeCacheScopeField = document.getElementById('adobe-media-cache-scope');

    return {
      avidFolder: document.getElementById('avid-folder-path').value,
      avidUser: document.getElementById('avid-user-select')?.value || '',
      scanSubfolders: document.getElementById('avid-scan-subfolders').checked,
      backupSettings: document.getElementById('avid-backup-settings').checked,
      avidShowCounts: document.getElementById('avid-show-counts').checked,
      avidAutoRebuild: document.getElementById('avid-auto-rebuild').checked,
      adobeFolder: document.getElementById('adobe-folder-path').value,
      adobeSkipRecent: document.getElementById('adobe-skip-recent').checked,
      adobeAgeDays: document.getElementById('adobe-age-days').value,
      adobeSizeSkip: adobeSizeSkipToggle?.checked ?? false,
      adobeSizeLimitMB: adobeSizeLimitField?.value ?? '',
      adobeMediaCacheFilter: adobeCacheFilterField?.value ?? '',
      adobeMediaCacheScope: adobeCacheScopeField?.value ?? ''
    };
  }

  function applyPreset(data) {
    document.getElementById('avid-folder-path').value = data.avidFolder || '';
    void populateAvidUsers(data.avidFolder || '', data.avidUser);
    if (avid.userSelect && data.avidUser) {
      avid.userSelect.value = data.avidUser;
    }
    document.getElementById('avid-scan-subfolders').checked = !!data.scanSubfolders;
    document.getElementById('avid-backup-settings').checked = !!data.backupSettings;
    document.getElementById('avid-show-counts').checked = !!data.avidShowCounts;
    document.getElementById('avid-auto-rebuild').checked = !!data.avidAutoRebuild;
    document.getElementById('adobe-folder-path').value = data.adobeFolder || '';
    document.getElementById('adobe-skip-recent').checked = !!data.adobeSkipRecent;
    document.getElementById('adobe-age-days').value = data.adobeAgeDays || '';

    const adobeSizeSkipToggle = document.getElementById('adobe-size-skip');
    const adobeSizeLimitField = document.getElementById('adobe-size-mb');
    const adobeCacheFilterField = document.getElementById('adobe-media-cache-filter');
    const adobeCacheScopeField = document.getElementById('adobe-media-cache-scope');

    if (adobeSizeSkipToggle) {
      adobeSizeSkipToggle.checked = !!data.adobeSizeSkip;
    }

    if (adobeSizeLimitField) {
      adobeSizeLimitField.value = data.adobeSizeLimitMB ?? '';
    }

    if (adobeCacheFilterField && typeof data.adobeMediaCacheFilter !== 'undefined') {
      adobeCacheFilterField.value = data.adobeMediaCacheFilter;
    }

    if (adobeCacheScopeField && typeof data.adobeMediaCacheScope !== 'undefined') {
      adobeCacheScopeField.value = data.adobeMediaCacheScope;
    }
  }

  async function refreshPresetDropdown() {
    const hidden = document.getElementById('nle-utilities-preset');
    if (!hidden || !ipc?.invoke) return;

    try {
      const presets = await ipc.invoke('list-panel-presets', PANEL_ID);
      const opts = (Array.isArray(presets) ? presets : [])
        .filter(p => typeof p?.file === 'string' && p.file.toLowerCase().endsWith('.json'))
        .map(p => ({
          value: p.file,
          label: window.panelPresetDefaults?.isDefaultPresetFile?.(p.file)
            ? getLocalizedText('defaultPresetLabel', 'Default')
            : (p.name || p.file.replace(/\.json$/i, ''))
        }));

      setupStyledDropdown('nle-utilities-preset', opts);
      setDropdownValue('nle-utilities-preset', hidden.value || '');
    } catch (err) {
      console.error('Failed to read presets:', err);
    }

    window.translatePage?.();

    // Bind loader once: selecting an item in the preset dropdown applies it.
    if (!hidden.dataset.listenerBound) {
      hidden.addEventListener('change', async () => {
        const file = hidden.value;
        if (!file) return;
        try {
          const raw = await ipc.invoke('read-panel-preset', { panel: PANEL_ID, presetName: file });
          if (!raw) {
            throw new Error(getLocalizedText('nlePresetNotFound', 'Preset not found'));
          }
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          applyPreset(data);
        } catch (err) {
          console.error('Failed to load preset', err);
          showAssistNotice(
            getLocalizedText('nlePresetLoadFailed', 'Failed to load preset: {{error}}', {
              error: localizePresetLoadError(err)
            }),
            { variant: 'error', duration: 4000 }
          );
        }
      });
      hidden.dataset.listenerBound = 'true';
    }
  }

  // Auto-refresh preset dropdown after save/delete, even if another component triggered it.
  // (Some builds may not broadcast these events; refreshPresetDropdown is also called locally.)
  if (ipc?.on) {
    ipc.on('preset-saved', (_e, panelId) => {
      if (panelId === PANEL_ID) refreshPresetDropdown();
    });
    ipc.on('preset-deleted', (_e, panelId) => {
      if (panelId === PANEL_ID) refreshPresetDropdown();
    });
  }

  refreshPresetDropdown();

  saveBtn?.addEventListener('click', async () => {
    const cfg = gatherConfig();
    const hidden = document.getElementById('nle-utilities-preset');
    const suggestedName = (hidden?.value || PANEL_ID).replace(/\.json$/i, '') || PANEL_ID;
    const presetDir = ipc.resolvePath('config', 'presets', PANEL_ID);
    try {
      await fs.mkdir(presetDir);
    } catch {}

    const file = await ipc.saveFile({
      title: getLocalizedText('nlePresetPromptSaveAs', 'Save preset as'),
      defaultPath: path.join(presetDir, `${suggestedName}.json`),
      filters: [{ name: getLocalizedText('nlePresetFilterName', 'Preset'), extensions: ['json'] }]
    });
    if (!file) return;

    try {
      const serialized = JSON.stringify(cfg, null, 2);
      if (typeof ipc?.writeTextFileAsync === 'function') {
        await ipc.writeTextFileAsync(file, serialized);
      } else {
        await fs.writeFile(file, serialized);
      }
      const savedFile = path.basename(file) || `${suggestedName}.json`;

      ipc.send?.('preset-saved', PANEL_ID);
      await refreshPresetDropdown();
      setDropdownValue('nle-utilities-preset', savedFile);
      showAssistNotice(getLocalizedText('nleConfigSaved', 'Config saved.'), { variant: 'success' });
    } catch (err) {
      console.error('Failed to save preset', err);
      showAssistNotice(
        getLocalizedText('nlePresetSaveFailed', 'Failed to save preset: {{error}}', {
          error: err?.message || String(err)
        }),
        { variant: 'error', duration: 4000 }
      );
    }
  });

  loadBtn?.addEventListener('click', async () => {
    const hidden = document.getElementById('nle-utilities-preset');
    const selected = hidden?.value;

    // Prefer loading from the managed preset folder so packaged builds work reliably.
    if (selected) {
      try {
        const raw = await ipc.invoke('read-panel-preset', { panel: PANEL_ID, presetName: selected });
        if (!raw) {
          throw new Error(getLocalizedText('nlePresetNotFound', 'Preset not found'));
        }
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        applyPreset(data);
        return;
      } catch (err) {
        console.error('Failed to load preset via managed folder:', err);
      }
    }

    // Fallback: import a JSON preset file from disk.
    const file = await ipc.openFile({
      title: getLocalizedText('loadPreset', 'Load Preset')
    });
    if (!file) return;
    try {
      const data = JSON.parse(await fs.readFile(file));
      applyPreset(data);
    } catch (err) {
      console.error('Failed to import preset', err);
      showAssistNotice(
        getLocalizedText('nleConfigLoadFailed', 'Failed to load config: {{error}}', {
          error: localizeConfigLoadError(err)
        }),
        { variant: 'error', duration: 4000 }
      );
    }
  });

// ===============================
  // 🔁 NLE Utilities: Full Panel Reset
  // ===============================
  function resetNleUtilitiesFields() {
    const avidSummaryEl = document.getElementById('avid-summary');
    const adobeSummaryEl = document.getElementById('adobe-summary');

    // Reset all form controls within the NLE Utilities panel to their default states
    const nleUtilitiesPanel = document.getElementById('nle-utilities');
    if (nleUtilitiesPanel) {
      nleUtilitiesPanel.querySelectorAll('input, select, textarea').forEach((field) => {
        if (field.type === 'checkbox' || field.type === 'radio') {
          field.checked = field.defaultChecked;
        } else {
          field.value = field.defaultValue;
        }
      });

      const presetField = document.getElementById('nle-utilities-preset');
      if (presetField && typeof setDropdownValue === 'function') {
        setDropdownValue('nle-utilities-preset', presetField.defaultValue || '');
      }
    }

    // 🔹 Avid Fields
    if (avid.userSelect) {
      setAvidUserPlaceholder();
    }
    if (avidSummaryEl) {
      avidSummaryState.mode = SUMMARY_MODE_DEFAULT;
      avidSummaryState.selectedFolder = '';
      avidSummaryState.entries = [];
      renderAvidSummaryState();
    }

    // 🔹 Adobe Fields
    if (adobeSummaryEl) {
      adobeSummaryState.mode = SUMMARY_MODE_DEFAULT;
      adobeSummaryState.selectedFolder = '';
      adobeSummaryState.entries = [];
      renderAdobeSummaryState();
    }

    // Reset any dynamic elements, tooltips, or logs if needed
  }

  document.getElementById('reset-nle-utilities')?.addEventListener('click', () => {
    if (window.panelPresetDefaults?.has?.('nle-utilities')) {
      void window.panelPresetDefaults.resetToDefault('nle-utilities')
        .then(applied => {
          if (!applied) resetNleUtilitiesFields();
        })
        .catch(() => {
          resetNleUtilitiesFields();
        });
      return;
    }

    resetNleUtilitiesFields();
  });

  // ─── NLE Utilities: panel overview tooltip ────────────────────────────────
  renderNleOverviewTooltip = () => {
    const nleOverview = document.querySelector('#nle-utilities #nle-overview-tooltip');
    if (!nleOverview) return;

    const overviewHeader = getLocalizedText(
      'nleOverviewHeader',
      'NLE UTILITIES — Technical Overview'
    );
    const coreTitle = getLocalizedText('nleOverviewCoreTitle', 'Core capabilities');
    const coreItems = [
      getLocalizedText(
        'nleOverviewCoreItem1',
        'Deletes and rebuilds Avid MXF database files to fix offline or stale media indexes.'
      ),
      getLocalizedText(
        'nleOverviewCoreItem2',
        'Resets Avid site / user settings with optional backups.'
      ),
      getLocalizedText(
        'nleOverviewCoreItem3',
        'Cleans Adobe/Premiere caches, autosaves, and preview media using path-scoped rules.'
      )
    ];
    const hoodTitle = getLocalizedText('nleOverviewHoodTitle', 'Under the hood');
    const hoodItems = [
      getLocalizedText(
        'nleOverviewHoodItem1',
        'Operates directly on filesystem targets you select (no hidden locations).'
      ),
      getLocalizedText(
        'nleOverviewHoodItem2',
        'Uses simple rules: match by extension, optional age/size filters, optional subfolder recursion.'
      ),
      getLocalizedText(
        'nleOverviewHoodItem3',
        'Writes a plain-text summary of folders touched and files deleted or backed up.'
      )
    ];
    const notesTitle = getLocalizedText('nleOverviewNotesTitle', 'Operational notes');
    const notesItems = [
      getLocalizedText(
        'nleOverviewNotesItem1',
        'Most actions are destructive and do <strong>not</strong> use the OS trash.'
      ),
      getLocalizedText(
        'nleOverviewNotesItem2',
        'Always confirm the target path; avoid entire volumes or home directories.'
      )
    ];

    nleOverview.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">${overviewHeader}</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${coreTitle}</span>
          <ul class="tooltip-list">
            ${coreItems.map(item => `<li>${item}</li>`).join('')}
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${hoodTitle}</span>
          <ul class="tooltip-list">
            ${hoodItems.map(item => `<li>${item}</li>`).join('')}
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${notesTitle}</span>
          <ul class="tooltip-list">
            ${notesItems.map(item => `<li>${item}</li>`).join('')}
          </ul>
        </div>
      </div>
    `;
  };

  renderNleOverviewTooltip();

  rerenderSummaryState = () => {
    renderAvidSummaryState();
    renderAdobeSummaryState();
  };

  bindNleI18nHandlers();

if (window.panelPresetDefaults && !window.__LEAD_NLE_PRESET_DEFAULTS_REGISTERED__) {
  window.__LEAD_NLE_PRESET_DEFAULTS_REGISTERED__ = true;
  window.panelPresetDefaults.register({
    panelId: 'nle-utilities',
    presetInputId: 'nle-utilities-preset',
    refreshDropdown: () => refreshPresetDropdown(),
    applyPackagedDefaults: () => resetNleUtilitiesFields(),
    buildPackagedDefaultPreset: () => gatherConfig(),
    applyPreset: data => applyPreset(data)
  });
}

})();
