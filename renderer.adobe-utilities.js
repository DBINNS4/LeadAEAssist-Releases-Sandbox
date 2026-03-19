/* global CSInterface, panelDebug, SystemPath */
(() => {
  // ✅ Prevent double-binding of events and duplicate logs
  if (window.__LEADAE_ADOBE_UTILS_INIT__) return;
  window.__LEADAE_ADOBE_UTILS_INIT__ = true;

  function buildEvalScript(fn, config) {
    if (typeof config === 'undefined') return `${fn}()`;

    const json = (typeof config === 'string' ? config : JSON.stringify(config))
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    const needsObject =
      fn === 'runIngestWorkflow' || fn === 'LEADAE_generateProxies';
    return needsObject
      ? `${fn}(JSON.parse('${json}'))`
      : `${fn}('${json}')`;
  }

  function safeEvalScript(csInterface, fn, config, cb) {
    const script = buildEvalScript(fn, config);
    return csInterface.evalScript(script, cb);
  }

  let BASE_URL = 'http://127.0.0.1:32123';
  let TOKEN = null;
  let tokenSource = null;
  let tokenWarningLogged = false;
  let credentialRefreshTimer = null;
  let credentialRefreshBackoffMs = 1000;
  const credentialRefreshBackoffMaxMs = 30000;
  // Keep client-side credential refresh inside the bridge server's rotation window
  // (server rotates at expiresAt - 5000ms; bridgeAuthService preempts at 2500ms).
  const bridgeCredentialRefreshPreemptMs = 2500;
  let __leadAE_connectInFlight = false;
  let __leadAE_lastConnectAttemptAt = 0;
  let __leadAE_lastBroadcastPayload = '';
  const MATCH_SOURCE_SENTINEL = 'match-source-ffmpeg';
  const translate = (key, fallback, options) =>
    window.i18n?.t?.(key, options) ?? fallback ?? key;
  const getMatchSourceLabel = () =>
    translate('proxyPresetMatchSourceLabel', 'Match Source - ProRes Proxy - FFmpeg');
  const getMatchSourceDetailLabel = () =>
    translate(
      'proxyPresetMatchSourceDetailLabel',
      'Match Source (FFMPEG – dynamic, no .epr)'
    );
  const getFileGridResizeHandleTooltip = () =>
    translate('fileGridResizeHandleTooltip', 'Drag to resize • Double-click to auto-fit');

  function refreshResizableGridHandleTooltips(root = document) {
    const title = getFileGridResizeHandleTooltip();
    root.querySelectorAll?.('.resize-handle').forEach((handle) => {
      handle.title = title;
    });
  }

  if (!window.__LEADAE_ADOBE_UTILS_RESIZE_HANDLE_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_RESIZE_HANDLE_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try { refreshResizableGridHandleTooltips(); } catch {}
    });
  }

  function warnIfEnvToken(creds = {}) {
    const isEnvToken = creds.tokenSource === 'env';
    if (isEnvToken && !tokenWarningLogged) {
      tokenWarningLogged = true;
      setUILog(
        translate(
          'adobeUtilities.bridge.envTokenWarning',
          '⚠️ Using CEP_BRIDGE_TOKEN from the environment. Rotate if this was a shared or weak secret.'
        ),
        { isError: false }
      );
      debugLog('⚠️ Using user-supplied CEP_BRIDGE_TOKEN; ensure it is rotated if reused.');
    }
  }

  async function initBridgeCredentials() {
    try {
      if (!window.electron || !window.electron.invoke) {
        setUILog(
          translate(
            'adobeUtilities.bridge.credentialsUnavailableIpcNotReady',
            '❌ Bridge credentials unavailable: IPC not ready.'
          ),
          { isError: true }
        );
        return { ok: false, reason: 'ipc_unavailable' };
      }

      const creds = await window.electron.invoke('bridge:get-credentials');
      if (creds && creds.ok === false) {
        const port = Number(creds.port) || 32123;
        TOKEN = null;
        tokenSource = null;

        if (creds.code === 'EADDRINUSE') {
          setUILog(
            translate(
              'adobeUtilities.bridge.portInUse',
              `❌ Bridge port {{port}} is already in use.\n` +
                `• Quit any other running copies of LEAD AE – ASSIST\n` +
                `• macOS: lsof -nP -iTCP:{{port}} -sTCP:LISTEN\n` +
                `• Windows: netstat -ano | findstr :{{port}}\n` +
                'Then retry / reconnect.',
              { port }
            ),
            { isError: true }
          );
        } else {
          setUILog(
            translate(
              'adobeUtilities.bridge.unavailable',
              '❌ Bridge unavailable: {{error}}',
              { error: creds.error || 'unknown error' }
            ),
            { isError: true }
          );
        }

        return {
          ok: false,
          reason: creds.code || 'bridge_not_ready',
          code: creds.code || null,
          error: creds.error || null
        };
      }
      if (creds && creds.port) {
        BASE_URL = `http://127.0.0.1:${creds.port}`;
      }
      if (creds && creds.token) {
        TOKEN = creds.token;
        tokenSource = creds.tokenSource || null;
        warnIfEnvToken({ tokenSource: tokenSource, token: TOKEN });
        const expiresAt = Number(creds.expiresAt || 0);
        return { ok: true, expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null };
      }

      TOKEN = null;
      tokenSource = null;
      setUILog(
        translate(
          'adobeUtilities.bridge.credentialsMissing',
          '❌ Bridge credentials missing; cannot connect to Assist bridge.'
        ),
        { isError: true }
      );
      return { ok: false, reason: 'missing_token' };
    } catch (err) {
      TOKEN = null;
      tokenSource = null;
      setUILog(
        translate(
          'adobeUtilities.bridge.credentialsLoadFailed',
          '❌ Failed to load bridge credentials: {{error}}',
          { error: err?.message || err }
        ),
        { isError: true }
      );
      return { ok: false, reason: err?.message || 'credential_error' };
    }
  }

  function clearCredentialRefreshTimer() {
    if (credentialRefreshTimer) {
      clearTimeout(credentialRefreshTimer);
      credentialRefreshTimer = null;
      window.__leadAE_credentialRefreshTimer = null;
    }
  }

  function resetCredentialRefreshBackoff() {
    credentialRefreshBackoffMs = 1000;
  }

  function nextCredentialRefreshBackoff() {
    const next = credentialRefreshBackoffMs;
    credentialRefreshBackoffMs = Math.min(
      credentialRefreshBackoffMs * 2,
      credentialRefreshBackoffMaxMs
    );
    return next;
  }

  function logAutoReconnect(message) {
    const text =
      message ||
      translate(
        'adobeUtilities.bridge.autoReconnectRefreshAssistConnection',
        '🔄 Auto-reconnecting to refresh the Assist bridge connection…'
      );
    debugLog(text);
    setUILog(text);
  }

  function shouldAutoReconnect() {
    const input = getReconnectInput?.();
    if (!input) return true;
    return !!(input.checked || input.indeterminate);
  }

  function scheduleCredentialRefresh(expiresAtMs) {
    clearCredentialRefreshTimer();
    if (!expiresAtMs || !Number.isFinite(expiresAtMs)) return;

    const now = Date.now();
    const refreshAt = expiresAtMs - bridgeCredentialRefreshPreemptMs;
    let delay = refreshAt - now;

    if (delay <= 0) {
      delay = nextCredentialRefreshBackoff();
    } else {
      delay = Math.max(250, delay);
      resetCredentialRefreshBackoff();
    }

    credentialRefreshTimer = setTimeout(() => {
      clearCredentialRefreshTimer();
      if (!shouldAutoReconnect()) return;
      logAutoReconnect(
        translate(
          'adobeUtilities.bridge.autoReconnectRefreshCredentials',
          '🔄 Auto-reconnecting to refresh bridge credentials…'
        )
      );
      connectToLeadAE(true);
    }, delay);
    window.__leadAE_credentialRefreshTimer = credentialRefreshTimer;
  }

  function scheduleAutoReconnect(reason, { backoff = true } = {}) {
    if (!shouldAutoReconnect()) return;
    clearCredentialRefreshTimer();
    const delay = backoff ? nextCredentialRefreshBackoff() : 0;
    credentialRefreshTimer = setTimeout(() => {
      clearCredentialRefreshTimer();
      if (!shouldAutoReconnect()) return;
      logAutoReconnect(
        reason ||
          translate(
            'adobeUtilities.bridge.autoReconnectRefreshCredentials',
            '🔄 Auto-reconnecting to refresh bridge credentials…'
          )
      );
      connectToLeadAE(true);
    }, delay);
    window.__leadAE_credentialRefreshTimer = credentialRefreshTimer;
  }

  function normalizeProxyPresetValue(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return value;
    const trimmed = String(value).trim();
    if (!trimmed) return '';
    if (trimmed.toLowerCase() === 'match-source') {
      return MATCH_SOURCE_SENTINEL;
    }
    return trimmed;
  }  const LEGACY_MATCH_SOURCE_SENTINEL = 'match-source';
  const isMatchSourcePreset = value =>
    value === MATCH_SOURCE_SENTINEL || value === LEGACY_MATCH_SOURCE_SENTINEL;

  function buildProxySettingsTooltip(tooltip, presetDir) {
    if (!tooltip) return;
    tooltip.innerHTML = '';

    const content = document.createElement('div');
    content.className = 'tooltip-content';

    const header = document.createElement('div');
    header.className = 'tooltip-header';
    header.textContent = translate(
      'proxySettingsTooltipHeader',
      'Proxy Preset Details'
    );
    content.appendChild(header);

    const folderSection = document.createElement('div');
    folderSection.className = 'tooltip-section';

    const folderTitle = document.createElement('span');
    folderTitle.className = 'tooltip-subtitle';
    folderTitle.textContent = translate(
      'proxySettingsTooltipPresetFolderTitle',
      'Preset Folder'
    );
    folderSection.appendChild(folderTitle);

    const folderPath = document.createElement('div');
    folderPath.className = 'tooltip-path';
    folderPath.textContent = presetDir;
    folderSection.appendChild(folderPath);

    content.appendChild(folderSection);

    const rulesSection = document.createElement('div');
    rulesSection.className = 'tooltip-section';

    const rulesTitle = document.createElement('span');
    rulesTitle.className = 'tooltip-subtitle';
    rulesTitle.textContent = translate(
      'proxySettingsTooltipAttachmentRulesTitle',
      'Attachment Rules'
    );
    rulesSection.appendChild(rulesTitle);

    const ruleList = document.createElement('ul');
    ruleList.className = 'tooltip-list';

    const rules = [
      translate(
        'proxySettingsTooltipRuleContainer',
        'Container must match (mov/mp4)'
      ),
      translate(
        'proxySettingsTooltipRuleResolution',
        'Resolution / frame size must match source'
      ),
      translate(
        'proxySettingsTooltipRuleFrameRate',
        'Frame rate must match source'
      ),
      translate(
        'proxySettingsTooltipRuleAudio',
        'Audio must be discrete-layout parity with source (per stream): Stereo↔Stereo, Dual-Mono↔Dual-Mono, NxMono↔NxMono'
      )
    ];

    rules.forEach(rule => {
      const item = document.createElement('li');
      item.textContent = rule;
      ruleList.appendChild(item);
    });

    rulesSection.appendChild(ruleList);
    content.appendChild(rulesSection);

    tooltip.appendChild(content);
  }

  function renderProxySettingsTooltip(presetDir) {
    const tooltip = document.getElementById('proxy-settings-tooltip');
    buildProxySettingsTooltip(tooltip, presetDir || '');
  }

  const electron = window.electron ?? {};
  const ipc = window.ipc ?? electron;
  const isWindows = String(electron.platform || '').toLowerCase().startsWith('win');

  function normalizePathForContainment(inputPath) {
    if (!inputPath) return '';
    const sep = typeof electron.sep === 'function' ? electron.sep() : '/';
    let normalized = String(inputPath).trim();
    if (!normalized) return '';
    normalized = normalized.replace(/[\\/]+/g, sep);
    if (normalized.length > 1 && normalized.endsWith(sep)) {
      normalized = normalized.replace(/[\\/]+$/, '');
    }
    if (isWindows) {
      normalized = normalized.toLowerCase();
    }
    return normalized;
  }

  function isPathContainedInRoot(root, candidate) {
    const normalizedRoot = normalizePathForContainment(root);
    const normalizedCandidate = normalizePathForContainment(candidate);
    if (!normalizedRoot || !normalizedCandidate) return false;
    const rel = electron.relative?.(normalizedRoot, normalizedCandidate);
    if (typeof rel !== 'string') return false;
    const normalizedRel = rel.replace(/[\\/]+/g, '/');
    if (normalizedRel === '' || normalizedRel === '.') return false;
    if (normalizedRel.startsWith('..')) return false;
    if (normalizedRel.startsWith('/')) return false;
    if (/^[A-Za-z]:/.test(normalizedRel)) return false;
    if (typeof electron.isAbsolute === 'function' && electron.isAbsolute(rel)) return false;
    return true;
  }

  function renderRequirementsTooltip() {
    const reqTooltip = document.getElementById('automation-requirements-tooltip');
    if (!reqTooltip) return;

    reqTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">${translate('adobeUtilities.tooltip.requirements.header', 'ADOBE AUTOMATE — Technical Overview')}</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('adobeUtilities.tooltip.requirements.environment.subtitle', 'Requirements / environment')}</span>
          <ul class="tooltip-list">
            <li>${translate('adobeUtilities.tooltip.requirements.environment.item1', 'Adobe Premiere Pro must be open with a project loaded.')}</li>
            <li>${translate('adobeUtilities.tooltip.requirements.environment.item2', 'The Lead AE Assist CEP panel must be open and connected to the Assist bridge.')}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('adobeUtilities.tooltip.requirements.capabilities.subtitle', 'Core capabilities')}</span>
          <ul class="tooltip-list">
            <li>${translate('adobeUtilities.tooltip.requirements.capabilities.item1', 'Drives ingest from Assist into Premiere in one pass (copy, import, bin creation, proxies).')}</li>
            <li>${translate('adobeUtilities.tooltip.requirements.capabilities.item2', 'Can attach proxies to master clips using either AME presets or FFmpeg match-source mode.')}</li>
            <li>${translate('adobeUtilities.tooltip.requirements.capabilities.item3', 'Writes structured job logs and optional webhooks for automation / monitoring.')}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('adobeUtilities.tooltip.requirements.io.subtitle', 'Inputs / outputs')}</span>
          <ul class="tooltip-list">
            <li>${translate('adobeUtilities.tooltip.requirements.io.item1', 'Inputs: one or more source cards / folders, an ingest destination, and optional proxy path.')}</li>
            <li>${translate('adobeUtilities.tooltip.requirements.io.item2', 'Outputs: verified copies, optional Premiere bins, proxies attached back to master clips, and logs.')}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${translate('adobeUtilities.tooltip.requirements.underTheHood.subtitle', 'Under the hood')}</span>
          <ul class="tooltip-list">
            <li>${translate('adobeUtilities.tooltip.requirements.underTheHood.item1', 'Orchestrates Assist’s ingest / transcode engines plus a CEP JSX layer inside Premiere.')}</li>
            <li>${translate('adobeUtilities.tooltip.requirements.underTheHood.item2', 'Communicates with the desktop bridge over a local WebSocket secured with a runtime token.')}</li>
            <li>${translate('adobeUtilities.tooltip.requirements.underTheHood.item3', 'Falls back to FFmpeg for proxy generation when AME is unavailable or fails (unless disabled).')}</li>
          </ul>
        </div>
      </div>
    `;
  }

  function renderVerificationTooltip() {
    const verTooltip = document.getElementById('verification-logging-tooltip');
    if (!verTooltip) return;

    verTooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">${translate('adobeUtilities.tooltip.verification.header', 'VERIFICATION METHODS')}</div>

        <div class="tooltip-section">
          <ul class="tooltip-list">
            <li><strong>${translate('adobeUtilities.tooltip.verification.none.label', 'None')}</strong> - ${translate('adobeUtilities.tooltip.verification.none.description', 'fastest, but no data integrity check. Only use for low-risk copies.')}</li>
            <li><strong>${translate('adobeUtilities.tooltip.verification.byteCompare.label', 'Byte Compare')}</strong> - ${translate('adobeUtilities.tooltip.verification.byteCompare.description', 'reads source and copy and compares bytes 1:1. Safest, but slowest.')}</li>
            <li><strong>${translate('adobeUtilities.tooltip.verification.blake3.label', 'BLAKE3')}</strong> - ${translate('adobeUtilities.tooltip.verification.blake3.description', 'modern, very fast and strong. Good default for on-set and production ingest.')}</li>
            <li><strong>${translate('adobeUtilities.tooltip.verification.sha256.label', 'SHA-256')}</strong> - ${translate('adobeUtilities.tooltip.verification.sha256.description', 'widely accepted cryptographic hash. Slower but often required by facilities/IT.')}</li>
            <li><strong>${translate('adobeUtilities.tooltip.verification.md5.label', 'MD5')}</strong> - ${translate('adobeUtilities.tooltip.verification.md5.description', 'legacy option for systems that still expect MD5. Fast but weaker; use only for compatibility.')}</li>
            <li><strong>${translate('adobeUtilities.tooltip.verification.xxhash64.label', 'xxHash64')}</strong> - ${translate('adobeUtilities.tooltip.verification.xxhash64.description', 'extremely fast, non-cryptographic hash. Great for high-volume sanity checks when speed matters most.')}</li>
          </ul>
        </div>
      </div>
    `;
  }

  renderRequirementsTooltip();
  renderVerificationTooltip();

  function isDevUiEnabled() {
    return (window.electron?.isPackaged === false)
      || (window.electron?.DEBUG_UI === true)
      || (window.DEBUG_UI === true);
  }

  function debugLog(msg, opts = {}) {
    // DEV-only diagnostics. Keep production users out of Log Viewer archaeology.
    if (!isDevUiEnabled()) return;
    window.logPanel?.log('adobe-utilities', msg, opts);
    if (typeof panelDebug === 'function') panelDebug(msg);
  }

  function triggerPreviewUpdate() {
    requestAnimationFrame(() => updateJobPreview());
  }

  function applyProxySectionVisibility(show, { triggerPreview = true } = {}) {
    // IMPORTANT: Proxy Destination row is styled as a 2-column grid via
    // `#adobe-utilities .adobe-path-row { display: grid; grid-template-columns: ... }`.
    // If we force `display:flex` here, the row will wrap and the button/field
    // geometry won't match the other panels.
    if (el.proxyDestRow) {
      el.proxyDestRow.style.display = show ? 'grid' : 'none';
    }
    if (el.proxyPresetWrapper) {
      el.proxyPresetWrapper.style.display = show ? 'flex' : 'none';
    }
    // Ensure our toggle exists when the section is shown
    if (show) injectFfmpegFallbackToggle();
    if (triggerPreview) {
      updateJobPreview();
    }
  }

  function refreshFfmpegFallbackToggleI18n() {
    const input = document.getElementById('adobe-disable-ffmpeg');
    if (!input) return;

    input.title = window.i18n?.t?.('adobeUtilities.disableFfmpegFallbackTooltip')
      ?? 'Disable FFmpeg fallback';

    const labelText = input.parentElement?.querySelector('span');
    if (labelText) {
      labelText.textContent = window.i18n?.t?.('adobeUtilities.disableFfmpegFallbackLabel')
        ?? 'Disable FFmpeg fallback';
    }
  }

  if (!window.__LEADAE_ADOBE_UTILS_FFMPEG_TOGGLE_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_FFMPEG_TOGGLE_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try { refreshFfmpegFallbackToggleI18n(); } catch {}
    });
  }

  // === FFmpeg fallback toggle (runtime-injected; no HTML edits) ===
  function injectFfmpegFallbackToggle() {
    if (!el.proxyDestRow) return;
    // If this toggle already exists (including from a previous app build),
    // normalize its placement so it does NOT disrupt the [Button | Path] row.
    const existingInput = document.getElementById('adobe-disable-ffmpeg');
    const existingWrap = document.getElementById('adobe-disable-ffmpeg-wrapper');
    if (existingInput) {
      existingInput.checked = !!state.disableFfmpegFallback;

      // Ensure wrapper exists and is positioned AFTER the destination path input.
      if (existingWrap) {
        existingWrap.className = 'checkbox-row';
        if (existingWrap.parentNode !== el.proxyDestRow) {
          el.proxyDestRow.appendChild(existingWrap);
        } else if (existingWrap !== el.proxyDestRow.lastElementChild) {
          el.proxyDestRow.appendChild(existingWrap);
        }
      }
      refreshFfmpegFallbackToggleI18n();
      return;
    }
    // Container (placed UNDER the destination field, not inline between button/field)
    // so the row matches other panels: [Button | Path] with a checkbox underneath.
    const wrap = document.createElement('div');
    wrap.id = 'adobe-disable-ffmpeg-wrapper';
    wrap.className = 'checkbox-row';

    // Input
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'adobe-disable-ffmpeg';
    input.title = window.i18n.t('adobeUtilities.disableFfmpegFallbackTooltip');
    input.checked = !!state.disableFfmpegFallback;

    // Label text (match the rest of the app's checkbox markup: input + span)
    const text = document.createElement('span');
    text.textContent = window.i18n.t('adobeUtilities.disableFfmpegFallbackLabel');

    const label = document.createElement('label');
    label.appendChild(input);
    label.appendChild(text);

    // Bind
    input.addEventListener('change', () => {
      state.disableFfmpegFallback = input.checked;
      updateJobPreview();
    });

    wrap.appendChild(label);

    // Keep the first row strictly [Button | Path]. Append our toggle as a new grid row.
    el.proxyDestRow.appendChild(wrap);
    refreshFfmpegFallbackToggleI18n();
  }

  const isCEP =
    typeof window.__adobe_cep__ !== 'undefined' &&
    typeof CSInterface !== 'undefined';
  let lastConnectionState = null;

  function loadAdobeUtilitiesJSX(cb) {
    try {
      const cs = new CSInterface();
      const jsxPath = `${cs.getSystemPath(SystemPath.EXTENSION)}/jsx/adobe-utilities.jsx`;
      debugLog(`📂 Loading JSX from: ${jsxPath}`);
      const escPath = jsxPath.replace(/\\/g, '\\\\');
      cs.evalScript(`$.evalFile(new File("${escPath}"))`, res => {
        debugLog(`📂 JSX load result: ${res}`);
        cs.evalScript('typeof LEADAE_test', out => {
          debugLog(`🔍 LEADAE_test type: ${out}`);
          window.__leadAE_jsx_ready = (out === 'function');
          cb?.(out === 'function');
        });
      });
    } catch (err) {
      debugLog(`❌ loadAdobeUtilitiesJSX error: ${err.message}`);
      cb?.(false);
    }
  }

  async function ensurePremiereConnected() {
    return new Promise(resolve => {
      loadAdobeUtilitiesJSX(loaded => {
        if (!loaded) {
          resolve(false);
          return;
        }
        const cs = new CSInterface();
        safeEvalScript(cs, 'LEADAE_test', undefined, res => {
          if (!res || res.startsWith('err|')) {
            debugLog(`❌ LEADAE_test failed: ${res}`);
          } else {
            debugLog(`✅ Connection test: ${res}`);
          }
          resolve(res && res.startsWith('ok|'));
        });
      });
    });
  }

  async function ensureBridgeHeartbeat() {
    try {
      const creds = await initBridgeCredentials();
      if (!creds?.ok || !TOKEN) return false;
      const heartbeatTimeoutMs = 4000;
      let heartbeatRes = await fetchWithTimeout(
        `${BASE_URL}/heartbeat`,
        { headers: { Authorization: `Bearer ${TOKEN}` } },
        heartbeatTimeoutMs
      );
      if (heartbeatRes.status === 401 || heartbeatRes.status === 403) {
        const refreshed = await initBridgeCredentials();
        if (refreshed?.ok && TOKEN) {
          heartbeatRes = await fetchWithTimeout(
            `${BASE_URL}/heartbeat`,
            { headers: { Authorization: `Bearer ${TOKEN}` } },
            heartbeatTimeoutMs
          );
        }
      }
      return heartbeatRes.ok;
    } catch (err) {
      debugLog(`❌ Bridge heartbeat check failed: ${err?.message || err}`);
      return false;
    }
  }

  const el = {
    srcBtn: document.getElementById('adobe-select-source'),
    destBtn: document.getElementById('adobe-select-dest'),
    startBtn: document.getElementById('start-adobe-utilities'),
    cancelBtn: document.getElementById('cancel-adobe-utilities'),
    resetBtn: document.getElementById('reset-utilities'),
    srcPath: document.getElementById('adobe-source-path'),
    destPath: document.getElementById('adobe-dest-path'),
    backupBtn: document.getElementById('adobe-select-backup'),
    backupPath: document.getElementById('adobe-backup-path'),
    dualCopy: document.getElementById('adobe-dualCopy'),
    sourceList: document.getElementById('source-file-list'),
    sourceListGroup: document.getElementById('source-file-selection'),
    importPremiere: document.getElementById('adobe-import-premiere'),
    createBins: document.getElementById('adobe-create-bins'),
    generateProxies: document.getElementById('adobe-generate-proxies'),
    proxyPreset: document.getElementById('adobe-proxy-preset'),
    proxyPresetWrapper: document.getElementById('adobe-proxy-preset-wrapper'),
    loadProxyPreset: document.getElementById('load-proxy-preset'),
    proxyDestBtn: document.getElementById('adobe-select-proxy-dest'),
    proxyDestPath: document.getElementById('adobe-proxy-dest-path'),
    proxyDestRow: document.getElementById('adobe-proxy-dest-row'),
    binSelection: document.getElementById('adobe-bin-selection'),
    binList: document.getElementById('adobe-bin-list'),
    addFolder: document.getElementById('add-folder'),
    addSubfolder: document.getElementById('add-subfolder'),
    folderName: document.getElementById('adobe-folder-name'),
    notes: document.getElementById('adobe-notes'),
    summary: document.getElementById('adobe-summary'),
    logWindow: document.getElementById('adobe-log-window'),
    jobPreviewBox: document.getElementById('job-preview-box'),
    presetSelect: document.getElementById('adobe-utilities-preset'),
    saveConfig: document.getElementById('save-config'),
    loadConfig: document.getElementById('load-config'),
    saveLog: document.getElementById('adobe-save-log'),
    enableN8N: document.getElementById('adobe-enable-n8n'),
    n8nUrl: document.getElementById('adobe-n8n-url'),
    n8nAllowPrivate: document.getElementById('adobe-n8n-allow-private'),
    n8nLog: document.getElementById('adobe-n8n-log'),
    checksumMethod: document.getElementById('adobe-checksum-method'),
    enableThreads: document.getElementById('adobe-parallel'),
    autoThreads: document.getElementById('adobe-auto-threads'),
    retryFailures: document.getElementById('adobe-retry-failures'),
    concurrencySlider: document.getElementById('adobe-concurrency-slider'),
    concurrencyValue: document.getElementById('adobe-concurrency-value'),
    lockWrapper: document.getElementById('adobe-lock-wrapper'),
    lockControls: document.getElementById('adobe-lock-controls'),

    // Import-time controls
    onlySupportedImport: document.getElementById('adobe-only-supported-import'),
    excludePatterns: document.getElementById('adobe-exclude-patterns'),

    // Standalone backup queue UI
    backupQueueSelectDest: document.getElementById('adobe-backup-queue-select-dest'),
    backupQueueDest: document.getElementById('adobe-backup-queue-dest'),
    backupQueueMode: document.getElementById('adobe-backup-queue-mode'),
    backupQueueTemplateRow: document.getElementById('adobe-backup-queue-template-row'),
    backupQueueProject: document.getElementById('adobe-backup-queue-project'),
    backupQueueTemplate: document.getElementById('adobe-backup-queue-template'),
    backupQueueVerify: document.getElementById('adobe-backup-queue-verify'),
    backupQueueCollision: document.getElementById('adobe-backup-queue-collision'),
    backupQueueConcurrency: document.getElementById('adobe-backup-queue-concurrency'),
    backupQueueHtml: document.getElementById('adobe-backup-queue-html'),
    backupQueueAdd: document.getElementById('adobe-backup-queue-add'),
    backupQueueRun: document.getElementById('adobe-backup-queue-run'),
    backupQueuePause: document.getElementById('adobe-backup-queue-pause'),
    backupQueueCancel: document.getElementById('adobe-backup-queue-cancel'),
    backupQueueBody: document.getElementById('adobe-backup-queue-body')
  };

  async function confirmAdobeAction(options) {
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
      console.warn('Adobe Utilities confirm dialog bridge unavailable.');
    } catch (err) {
      console.warn('Adobe Utilities confirm dialog failed:', err?.message || err);
    }
    return false;
  }

  function ensureAdobeToast() {
    let toastEl = document.getElementById('adobe-utilities-toast');
    if (toastEl) return toastEl;
    if (!document.body) return null;
    toastEl = document.createElement('div');
    toastEl.id = 'adobe-utilities-toast';
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
    return toastEl;
  }

  function hideAdobeToast() {
    const toastEl = document.getElementById('adobe-utilities-toast');
    if (showAdobeToast._timer) {
      clearTimeout(showAdobeToast._timer);
      showAdobeToast._timer = null;
    }
    if (!toastEl) return;
    toastEl.classList.remove('show');
    toastEl.classList.remove('toast-error');
    toastEl.removeAttribute('title');
  }

  function showAdobeToast(message, options = {}) {
    const toastEl = ensureAdobeToast();
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

    if (showAdobeToast._timer) {
      clearTimeout(showAdobeToast._timer);
      showAdobeToast._timer = null;
    }

    if (!persistent) {
      showAdobeToast._timer = setTimeout(() => {
        toastEl.classList.remove('show');
        showAdobeToast._timer = null;
      }, 2000);
    }
  }

  function focusAdobeElement(target, { selectText = false } = {}) {
    if (!target || typeof target.focus !== 'function') return;
    try { target.focus(); } catch {}
    if (selectText && typeof target.select === 'function') {
      try { target.select(); } catch {}
    }
  }

  const state = window.watchConfigs?.adobeUtilities || {};
  window.watchConfigs = window.watchConfigs || {};
  window.watchConfigs.adobeUtilities = state;
  state.sources = Array.isArray(state.sources) ? state.sources : [];
  state.expandedSources = Array.isArray(state.expandedSources)
    ? state.expandedSources
    : state.sources.slice();
  // Default for new flag
  if (typeof state.disableFfmpegFallback !== 'boolean') {
    state.disableFfmpegFallback = false;
  }

  // Backup (mirrors Ingest dualCopy naming to avoid surprises)
  if (typeof state.dualCopy !== 'boolean') {
    state.dualCopy = false;
  }
  if (typeof state.backupPath !== 'string') {
    state.backupPath = '';
  }
  if (el.dualCopy) el.dualCopy.checked = state.dualCopy;
  if (el.backupPath) el.backupPath.value = state.backupPath;

  // Import-time controls state (session-scoped)
  if (typeof state.onlySupportedImport !== 'boolean') {
    state.onlySupportedImport = false;
  }
  if (typeof state.excludePatterns !== 'string') {
    state.excludePatterns = '';
  }
  if (typeof state.fileFlags !== 'object' || state.fileFlags === null) {
    state.fileFlags = {};
  }
  if (typeof state.sourceScanFailed !== 'boolean') {
    state.sourceScanFailed = false;
  }
  if (!Array.isArray(state.removedFiles)) {
    state.removedFiles = [];
  }
  if (el.onlySupportedImport) el.onlySupportedImport.checked = !!state.onlySupportedImport;
  if (el.excludePatterns) {
    el.excludePatterns.value = state.excludePatterns || '';
    try { autoResize(el.excludePatterns); } catch {}
  }


  if (el.notes && typeof state.notes === 'string') {
    el.notes.value = state.notes;
  }

  function getFileInfoHeadersMarkup() {
    return `
      <div class="file-info-grid-header">${translate('fileInfoColumnFile', 'File')}</div>
      <div class="file-info-grid-header">${translate('fileInfoColumnFormat', 'Format')}</div>
      <div class="file-info-grid-header">${translate('fileInfoColumnResolution', 'Resolution')}</div>
      <div class="file-info-grid-header">${translate('fileInfoColumnFps', 'FPS')}</div>
      <div class="file-info-grid-header">${translate('fileInfoColumnAudio', 'Audio')}</div>
      <div class="file-info-grid-header">${translate('fileInfoColumnDuration', 'Duration')}</div>
    `;
  }

  // --- Premiere compatibility helpers (conservative)
  function extOf(filePath) {
    try {
      return (window.electron.extname?.(filePath) || '').replace('.', '').toLowerCase();
    } catch {
      const m = /\.([^.]+)$/.exec(filePath || '');
      return (m?.[1] || '').toLowerCase();
    }
  }

  const IMPORTABLE_EXTS = new Set([
    // containers
    'mov','mp4','mxf','mkv','webm','avi',
    // audio
    'wav','mp3','aif','aiff','flac','ogg','m4a',
    // stills / gfx
    'jpg','jpeg','png','tiff','tif','tga','bmp','gif','psd','ai','svg'
  ]);

  const KNOWN_NOT_IMPORTABLE = new Set([
    // project/session file types
    'aep','prproj','sesx'
  ]);

  function importabilityOf(filePath) {
    const e = extOf(filePath);
    if (!e) return 'unknown';
    if (KNOWN_NOT_IMPORTABLE.has(e)) return 'no';
    if (IMPORTABLE_EXTS.has(e)) return 'yes';
    return 'unknown'; // be quiet unless we know it's bad
  }

  // --- Import-time controls: exclude-by-name + per-file import/encode flags
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function compileExcludePatterns(rawText) {
    const lines = String(rawText || '')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);

    const compiled = [];
    for (const raw of lines) {
      const hasWildcard = raw.includes('*') || raw.includes('?');
      if (hasWildcard) {
        // wildcard -> regex
        const rx = '^' + raw
          .split('')
          .map(ch => {
            if (ch === '*') return '.*';
            if (ch === '?') return '.';
            return escapeRegex(ch);
          })
          .join('') + '$';
        try {
          compiled.push({ raw, type: 'wildcard', re: new RegExp(rx, 'i') });
        } catch {
          // If the regex explodes, fall back to substring semantics.
          compiled.push({ raw, type: 'substring', re: new RegExp(escapeRegex(raw), 'i') });
        }
      } else {
        compiled.push({ raw, type: 'substring', re: new RegExp(escapeRegex(raw), 'i') });
      }
    }
    return compiled;
  }

  let _excludeCacheText = null;
  let _excludeCache = [];

  function getCompiledExcludePatterns() {
    const txt = String(state.excludePatterns || '');
    if (txt !== _excludeCacheText) {
      _excludeCacheText = txt;
      _excludeCache = compileExcludePatterns(txt);
    }
    return _excludeCache;
  }

  function getOrInitFileFlags(filePath) {
    const map = state.fileFlags || (state.fileFlags = {});
    if (!map[filePath]) {
      map[filePath] = {
        import: true,
        encode: false,
        manualImport: false,
        manualEncode: false,
        excludedBy: null,
        unsupported: false,
        notImportable: false
      };
    }
    return map[filePath];
  }

  function evaluateAutoFlagsForFile(filePath) {
    const base = (electron.basename?.(filePath) || filePath || '').toString();
    const patterns = getCompiledExcludePatterns();
    let excludedBy = null;
    for (const p of patterns) {
      if (p?.re && p.re.test(base)) {
        excludedBy = p.raw;
        break;
      }
    }

    const support = importabilityOf(filePath);
    const notImportable = (support === 'no');
    const unsupported = !!state.onlySupportedImport && (support !== 'yes');

    return { excludedBy, unsupported, notImportable, support };
  }

  function applyAutoRulesToFile(filePath) {
    const flags = getOrInitFileFlags(filePath);
    const { excludedBy, unsupported, notImportable } = evaluateAutoFlagsForFile(filePath);

    flags.excludedBy = excludedBy;
    flags.unsupported = unsupported;
    flags.notImportable = notImportable;

    // Default behavior:
    // - Excluded/unsupported/not-importable => Import off unless the user explicitly turned it on/off.
    if (!flags.manualImport) {
      flags.import = !(excludedBy || unsupported || notImportable);
    } else if (notImportable) {
      // Hard safety: "known not importable" should not be import-enabled.
      flags.import = false;
    }

    const proxiesEnabled = !!el.generateProxies?.checked;

    if (!flags.manualEncode) {
      // Encode defaults to global proxy toggle (but never for excluded/not-importable)
      flags.encode = proxiesEnabled && flags.import;
    } else if (notImportable) {
      flags.encode = false;
    }

    // If user requests encode for a file, it must be imported for proxy attach to make sense.
    if (flags.encode && !flags.import && !notImportable) {
      flags.import = true;
      flags.manualImport = true;
    }

    return flags;
  }

  function applyAutoRulesToAllFiles() {
    const files = Array.isArray(getEffectiveSources()) ? getEffectiveSources() : [];
    const keep = new Set(files);
    // Prune flags for removed files
    if (state.fileFlags) {
      for (const k of Object.keys(state.fileFlags)) {
        if (!keep.has(k)) delete state.fileFlags[k];
      }
    }
    for (const f of files) applyAutoRulesToFile(f);
  }


  function setupResizableGrid(gridEl, storageKey) {
    if (!gridEl || gridEl.dataset.resizable === '1') return;
    gridEl.dataset.resizable = '1';

    const COL_VARS = [
      '--col-file', '--col-format', '--col-resolution',
      '--col-fps', '--col-audio', '--col-duration'
    ];

    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      COL_VARS.forEach(v => { if (saved[v]) gridEl.style.setProperty(v, saved[v]); });
    } catch {}

    const headers = gridEl.querySelectorAll('.file-info-grid-header');
    headers.forEach((h, idx) => {
      h.style.position = 'relative';
      const handle = document.createElement('span');
      handle.className = 'resize-handle';
      handle.title = getFileGridResizeHandleTooltip();
      h.appendChild(handle);

      let startX = 0;
      let startW = 0;

      const finish = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        gridEl.classList.remove('resizing');
        const map = {};
        COL_VARS.forEach(v => {
          const val = gridEl.style.getPropertyValue(v);
          if (val) map[v] = val.trim();
        });
        try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
      };

      const onMove = (e) => {
        const dx = e.clientX - startX;
        const newW = Math.max(90, startW + dx);
        gridEl.style.setProperty(COL_VARS[idx], `${newW}px`);
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

      h.addEventListener('dblclick', () => {
        const all = Array.from(gridEl.children);
        const body = all.slice(6);
        let maxW = h.scrollWidth;
        for (let i = idx; i < body.length; i += 6) {
          const w = body[i]?.scrollWidth || 0;
          if (w > maxW) maxW = w;
        }
        const pad = 24;
        const newW = Math.min(Math.max(maxW + pad, 90), gridEl.clientWidth - 60);
        gridEl.style.setProperty(COL_VARS[idx], `${newW}px`);
        const map = {};
        COL_VARS.forEach(v => {
          const val = gridEl.style.getPropertyValue(v);
          if (val) map[v] = val.trim();
        });
        try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
      });
    });
  }

  function resetFileInfoGrid(panelId, storageKey) {
    const infoEl = document.getElementById(`${panelId}-file-info`);
    if (!infoEl) return null;

    infoEl.classList.add('file-info-grid');
    infoEl.classList.add('placeholder');
    infoEl.innerHTML = getFileInfoHeadersMarkup();
    delete infoEl.dataset.resizable;

    // Clear any per-column inline widths
    const COL_VARS = [
      '--col-file',
      '--col-format',
      '--col-resolution',
      '--col-fps',
      '--col-audio',
      '--col-duration'
    ];
    COL_VARS.forEach(v => {
      infoEl.style.removeProperty(v);
    });

    // Drop saved widths so we go back to defaults
    if (storageKey) {
      try {
        localStorage.removeItem(storageKey);
      } catch {}
    }

    // Reset scroll position in placeholder state
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
    infoEl.innerHTML = getFileInfoHeadersMarkup();
    delete infoEl.dataset.resizable;

    // We’re about to show real rows: re-enable horizontal scroll
    const wrapper = infoEl.closest('.file-info-scroll');
    if (wrapper) {
      wrapper.classList.remove('no-hscroll');
    }

    return infoEl;
  }

  const FFPROBE_TIMEOUT_MS = 12000;
  const getGridFallbackNa = () => translate('adobeUtilities.gridFallback.na', 'N/A');
  const getGridFallbackUnknown = () => translate('adobeUtilities.gridFallback.unknown', 'Unknown');

  function formatFfprobeError(error) {
    if (!error) {
      return translate(
        'adobeUtilities.ffprobeError.noData',
        'FFprobe returned no data'
      );
    }
    if (typeof error === 'object') {
      if (error.code === 'FFPROBE_TIMEOUT') {
        return translate(
          'adobeUtilities.ffprobeError.timeout',
          'Metadata probe timed out'
        );
      }
      return error.message || JSON.stringify(error) || getGridFallbackUnknown();
    }
    return String(error);
  }

  /**
   * getFileMetadata - tolerant metadata probe
   * * If ffprobe is present and returns JSON, return that object.
   * * If ffprobe missing or it errors, return a fallback object
   *   containing minimal fields (format, streams=[], and fs stats)
   *   and a `_probeError` string for soft warnings in the UI.
   */
  function getFileMetadata(filePath) {
    return new Promise((resolve) => {
      void (async () => {
        // default fallback skeleton
        const fallback = {
          format: { format_name: (window.electron.extname(filePath) || '').replace(/^\./, '').toUpperCase() || 'FILE' },
          streams: [],
          _probeError: null,
          _fs: {}
        };

        // attach basic filesystem info (size, mtime) if available
        try {
          const st = await window.electron.stat(filePath);
          fallback._fs.size = st?.size || 0;
          fallback._fs.mtime = st?.mtime || null;
        } catch {
          // ignore - we'll still show file row
        }

        try {
          const data = await window.electron.ffprobeJson(filePath, [], { timeoutMs: FFPROBE_TIMEOUT_MS });
          if (data && !data.error) {
            data.format = data.format || { format_name: (window.electron.extname(filePath) || '').replace(/^\./, '').toUpperCase() };
            data.streams = Array.isArray(data.streams) ? data.streams : [];
            data._fs = fallback._fs;
            data._probeError = null;
            return resolve(data);
          }
          fallback._probeError = formatFfprobeError(data?.error);
          return resolve(fallback);
        } catch (err) {
          // ffprobe errored (file not media, corrupt, permission, etc.)
          fallback._probeError = formatFfprobeError(err);
          return resolve(fallback);
        }
      })();
    });
  }

  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }

  function _parseFrameRate(rFrameRate) {
    if (!rFrameRate || rFrameRate === '0/0') return getGridFallbackNa();
    const [num, denom] = rFrameRate.split('/').map(Number);
    return `${(num / denom).toFixed(2)} fps`;
  }

  function formatFrameRateForGrid(metadata) {
    if (!metadata || !Array.isArray(metadata.streams)) return getGridFallbackNa();

    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
    if (!videoStream) return getGridFallbackNa();

    const r = videoStream.r_frame_rate || videoStream.avg_frame_rate || '';
    if (!r || r === '0/0') return getGridFallbackNa();

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

  // ─── Container + audio helpers ─────────────────────────────────────────────
  function summarizeAudioStreams(streams = []) {
    const aud = streams.filter(s => s.codec_type === 'audio');
    if (!aud.length) return { codec: getGridFallbackNa(), label: '', tracks: 0 };
    const codecs = [...new Set(aud.map(s => String(s.codec_name || '').toUpperCase()))];
    const codec = codecs.length === 1 ? codecs[0] : codecs.join('+');
    const total = aud.reduce((sum, s) => sum + (s.channels || 0), 0);
    const allMono = aud.every(s => (s.channels || 0) === 1);
    let label = '';
    if (total === 1) {
      label = translate('adobeUtilities.audioChannels.mono', 'Mono');
    } else if (total === 2) {
      label = translate('adobeUtilities.audioChannels.stereo', 'Stereo');
    } else {
      const channelCountLabel = translate(
        'adobeUtilities.audioChannels.countLabel',
        '{{count}}ch',
        { count: total }
      );
      const multiMonoSuffix = allMono
        ? translate('adobeUtilities.audioChannels.multiMonoSuffix', ' (multi-mono)')
        : '';
      label = `${channelCountLabel}${multiMonoSuffix}`;
    }
    return { codec, label, tracks: aud.length };
  }

  function normalizeExt(p) {
    try {
      return (window.electron.extname?.(p) || '').replace(/^\./, '').toLowerCase();
    } catch {
      const m = /\.([^.]+)$/.exec(p || '');
      return (m?.[1] || '').toLowerCase();
    }
  }

  /**
   * Prefer the real file extension when ffprobe reports a container "family".
   * Examples:
   *  - "mov,mp4,..." → show MP4 for *.mp4, MOV for *.mov
   *  - "matroska"    → show MKV / WEBM based on extension
   *  - "image2"      → show the still type (JPG/PNG/…)
   */
  function resolveFormatLabel(metadata, filePath) {
    const ext = normalizeExt(filePath);
    const upperExt = ext ? ext.toUpperCase() : '';
    const reported = metadata?.format?.format_name;

    // If ffprobe had no format (or errored), fall back to extension
    if (!reported || typeof reported !== 'string' || reported === 'unknown') {
      return upperExt || 'FILE';
    }

    const tokens = reported.split(',').map(s => s.trim().toLowerCase());

    // If the extension appears in ffprobe's alias list, prefer it
    if (ext && tokens.includes(ext)) return upperExt;

    // QuickTime/MP4 family: ffprobe often lists "mov,mp4,..."
    if (tokens.includes('mov') && ext === 'mp4') return 'MP4';
    if (tokens.includes('mp4') && ext === 'mov') return 'MOV';

    // Matroska family
    if (tokens.includes('matroska')) {
      if (ext === 'mkv') return 'MKV';
      if (ext === 'webm') return 'WEBM';
    }

    // Stills: ffprobe may return "image2"—prefer the real still type
    if (tokens.includes('image2') && upperExt) return upperExt;

    // Otherwise, use the first token as a last resort
    return (tokens[0] || upperExt || 'FILE').toUpperCase();
  }

  async function renderAdobeGrid(files) {
    const grid = prepareFileInfoGrid('adobe');
    if (!grid) return;

    for (const filePath of files) {
      const metadata = await getFileMetadata(filePath);
      const format = metadata.format || {};
      const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
      const container = resolveFormatLabel(metadata, filePath);
      const videoStream = streams.find(s => s.codec_type === 'video');
      const audioInfo = summarizeAudioStreams(streams);

      // human-friendly cells with fallbacks
      const duration = format.duration
        ? formatDuration(+format.duration)
        : (metadata._fs?.size ? '—' : getGridFallbackNa());
      const resolution = videoStream
        ? `${videoStream.width}×${videoStream.height}`
        : (audioInfo.tracks > 0
          ? translate('adobeUtilities.audioOnly', 'Audio only')
          : getGridFallbackNa());
      const frameRate = formatFrameRateForGrid(metadata);

      const fileName = window.electron.basename
        ? window.electron.basename(filePath)
        : (filePath.split(/[\\/]/).pop() || filePath);

      // Build DOM nodes (no innerHTML / insertAdjacentHTML) to avoid XSS via filenames/paths/ffprobe strings.
      const row = document.createElement('div');
      row.className = 'file-info-row';

      const nameCell = document.createElement('div');
      nameCell.title = String(filePath);
      nameCell.textContent = String(fileName);

      if (metadata._probeError) {
        const warn = document.createElement('span');
        warn.className = 'file-warn';
        warn.title = String(metadata._probeError);
        warn.textContent = '⚠️';
        nameCell.appendChild(document.createTextNode(' '));
        nameCell.appendChild(warn);
      }

      const audioCell = `${audioInfo.codec}${audioInfo.label ? ` • ${audioInfo.label}` : ''}`;

      const makeCell = (value) => {
        const cell = document.createElement('div');
        cell.textContent = value == null ? '' : String(value);
        return cell;
      };

      row.appendChild(nameCell);
      row.appendChild(makeCell(container));
      row.appendChild(makeCell(resolution));
      row.appendChild(makeCell(frameRate));
      row.appendChild(makeCell(audioCell));
      row.appendChild(makeCell(duration));

      grid.appendChild(row);
    }

    grid.classList.remove('placeholder');
    // Enable column resizing (persist widths)
    setupResizableGrid(grid, 'adobe-file-grid');
  }

  if (!window.__LEADAE_ADOBE_UTILS_GRID_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_GRID_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try {
        const effectiveFiles = Array.isArray(getEffectiveSources()) ? getEffectiveSources() : [];
        if (effectiveFiles.length > 0) {
          renderAdobeGrid(effectiveFiles).catch(err => {
            console.error('❌ Failed to re-render Adobe Automate grid after language change:', err);
          });
        } else {
          resetFileInfoGrid('adobe', 'adobe-file-grid');
        }
        renderSourceFileList();
      } catch {}
    });
  }

  if (el.enableN8N && typeof state.enableN8N === 'boolean') {
    el.enableN8N.checked = state.enableN8N;
  }
  if (el.n8nLog && typeof state.n8nLog === 'boolean') {
    el.n8nLog.checked = state.n8nLog;
  }
  if (el.n8nUrl && typeof state.n8nUrl === 'string') {
    el.n8nUrl.value = state.n8nUrl;
  }
  if (el.n8nAllowPrivate && typeof state.n8nAllowPrivate === 'boolean') {
    el.n8nAllowPrivate.checked = state.n8nAllowPrivate;
  }

  if (typeof state.enableThreads !== 'boolean') {
    state.enableThreads = true;
  }
  if (typeof state.autoThreads !== 'boolean') {
    state.autoThreads = true;
  }
  if (el.enableThreads) {
    el.enableThreads.checked = state.enableThreads;
  }
  if (el.autoThreads) {
    el.autoThreads.checked = state.autoThreads;
  }
  if (el.retryFailures && typeof state.retryFailures === 'boolean') {
    el.retryFailures.checked = state.retryFailures;
  }
  if (el.concurrencySlider) {
    if (typeof state.maxThreads === 'number') {
      el.concurrencySlider.value = String(state.maxThreads);
    } else if (!el.concurrencySlider.value) {
      el.concurrencySlider.value = '3';
    }
  }

  function syncAutomationState() {
    state.enableN8N = !!el.enableN8N?.checked;
    const raw = el.n8nUrl?.value;
    state.n8nUrl = typeof raw === 'string' ? raw.trim() : '';
    state.n8nAllowPrivate = !!el.n8nAllowPrivate?.checked;
    state.n8nLog = !!el.n8nLog?.checked;
  }

  syncAutomationState();

  function getThreadSettings() {
    // 🔗 Invariant: Auto Threads implies Parallel Copy (enableThreads)
    if (el.autoThreads?.checked && el.enableThreads && !el.enableThreads.checked) {
      el.enableThreads.checked = true;
    }

    const enableThreads = !!el.enableThreads?.checked;
    const autoThreads = !!el.autoThreads?.checked;
    let maxThreads;
    if (!enableThreads) {
      maxThreads = 1;
    } else if (autoThreads) {
      maxThreads = null;
    } else {
      const parsed = parseInt(el.concurrencySlider?.value || '1', 10);
      const clamped = Number.isNaN(parsed) ? 1 : Math.min(Math.max(parsed, 1), 10);
      maxThreads = clamped;
    }
    return { enableThreads, autoThreads, maxThreads };
  }

  function syncThreadState() {
    if (!state) return { enableThreads: true, autoThreads: true, maxThreads: null };
    const settings = getThreadSettings();
    state.enableThreads = settings.enableThreads;
    state.autoThreads = settings.autoThreads;
    state.maxThreads = settings.maxThreads;
    state.retryFailures = !!el.retryFailures?.checked;
    return settings;
  }

  function updateThreadControls() {
    const slider = el.concurrencySlider;
    const label = el.concurrencyValue;
    const settings = getThreadSettings();

    // If Parallel Copy is turned off, Auto Threads cannot stay on
    if (!settings.enableThreads && el.autoThreads && el.autoThreads.checked) {
      el.autoThreads.checked = false;
    }

    if (!slider || !label) {
      syncThreadState();
      return;
    }

    if (!settings.enableThreads) {
      slider.disabled = true;
      slider.value = '1';
      label.textContent = '1';
    } else if (settings.autoThreads) {
      slider.disabled = true;
      if (!slider.value) {
        slider.value = settings.maxThreads == null ? '3' : String(settings.maxThreads);
      }
      label.textContent = translate('autoLabel', 'Auto');
    } else {
      slider.disabled = false;
      if (!slider.value) {
        slider.value = String(settings.maxThreads || 1);
      }
      label.textContent = slider.value;
    }

    syncThreadState();
  }

  updateThreadControls();

  if (!window.__LEADAE_ADOBE_UTILS_THREAD_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_THREAD_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try { updateThreadControls(); } catch {}
    });
  }

  if (el.checksumMethod && !el.checksumMethod.value) {
    el.checksumMethod.value = 'blake3';
  }

  function renderChecksumDropdownOptions() {
    if (typeof setupStyledDropdown !== 'function') return;
    const selectedChecksumMethod = el.checksumMethod?.value || 'blake3';
    const checksumOptions = [
      { value: 'none', label: translate('verificationNoneLabel', 'None') },
      {
        value: 'bytecompare',
        label: translate('adobeUtilities.tooltip.verification.byteCompare.label', 'Byte Compare')
      },
      { value: 'blake3', label: translate('adobeUtilities.tooltip.verification.blake3.label', 'BLAKE3') },
      { value: 'sha256', label: translate('adobeUtilities.tooltip.verification.sha256.label', 'SHA-256') },
      { value: 'md5', label: translate('adobeUtilities.tooltip.verification.md5.label', 'MD5') },
      { value: 'xxhash64', label: translate('adobeUtilities.tooltip.verification.xxhash64.label', 'xxHash64') }
    ];
    setupStyledDropdown('adobe-checksum-method', checksumOptions);
    if (typeof setDropdownValue === 'function') {
      setDropdownValue('adobe-checksum-method', selectedChecksumMethod);
    } else if (el.checksumMethod) {
      el.checksumMethod.value = selectedChecksumMethod;
    }
  }

  renderChecksumDropdownOptions();

  if (!window.__LEADAE_ADOBE_UTILS_CHECKSUM_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_CHECKSUM_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try { renderChecksumDropdownOptions(); } catch {}
    });
  }

  // === Adobe Automate Cancel Support ===
  let currentJobId = null;
  let currentJobStage = null;
  let submittedJobConfig = null;
  let isCancelling = false;
  // ⛳️ One-shot latch so the panel only resets once per job
  let __adobeJobCompleted = false;

  // ───────────────────────────────────────────────────────────────
  // Finalize-once latch that survives reconnects (per job ID)
  // ───────────────────────────────────────────────────────────────
  const JOB_LATCH_KEY = '__leadae_adobe_job_latch';
  function _getLatch() {
    try {
      return JSON.parse(sessionStorage.getItem(JOB_LATCH_KEY) || '{}');
    } catch (_) {
      return {};
    }
  }
  function _setLatch(obj) {
    try {
      sessionStorage.setItem(JOB_LATCH_KEY, JSON.stringify(obj || {}));
    } catch (_) {}
  }
  const missingJobIdWarnings = new Set();
  function warnMissingJobId(context) {
    const key = context || 'unknown';
    if (missingJobIdWarnings.has(key)) return;
    missingJobIdWarnings.add(key);
    const message = `⚠️ Adobe Automate job latch skipped — missing job ID (${key}).`;
    debugLog(message, { isError: true });
    console.warn(message);
  }
  function normalizeJobId(raw) {
    if (raw === null || typeof raw === 'undefined') return null;
    const id = String(raw).trim();
    return id ? id : null;
  }
  function getActiveJobId() {
    return normalizeJobId(state?.currentJobId || currentJobId);
  }
  function logIgnoredJobEvent(context, jobKey, activeJobId) {
    const message = `🧹 Ignoring stale Adobe Automate event (${context}) for job ${jobKey}; active job is ${activeJobId}.`;
    debugLog(message);
    console.warn(message);
  }
  function currentJobKeyFrom(job, payload) {
    // prefer explicit job.id; otherwise fall back to the currently active job
    const id =
      job?.id ||
      job?.jobId ||
      payload?.job?.id ||
      payload?.job?.jobId ||
      payload?.jobId ||
      payload?.id;
    if (id) {
      return normalizeJobId(id);
    }
    return getActiveJobId() || normalizeJobId(currentJobId);
  }
  function wasFinalized(jobKey) {
    if (!jobKey) {
      warnMissingJobId('wasFinalized');
      return false;
    }
    const m = _getLatch();
    return !!m[jobKey];
  }
  function markFinalized(jobKey) {
    if (!jobKey) {
      warnMissingJobId('markFinalized');
      return;
    }
    const m = _getLatch();
    m[jobKey] = Date.now();
    _setLatch(m);
    __adobeJobCompleted = true;
  }
  function clearFinalized(jobKey) {
    if (!jobKey) {
      warnMissingJobId('clearFinalized');
      return;
    }
    const m = _getLatch();
    if (jobKey && m[jobKey]) {
      delete m[jobKey];
      _setLatch(m);
    }
  }

  if (el.cancelBtn) el.cancelBtn.disabled = true;

  const adobeLockSelector =
    '#adobe-lock-wrapper input, #adobe-lock-wrapper select, #adobe-lock-wrapper textarea, #adobe-lock-wrapper button';

  function setAdobeAutomateControlsDisabled(state) {
    document.querySelectorAll(adobeLockSelector).forEach(node => {
      if (node.id === 'cancel-adobe-utilities') return;
      if (!state && node.dataset.locked === 'true') {
        node.disabled = true;
        return;
      }
      node.disabled = state;
    });

    if (state) {
      el.lockWrapper?.classList.add('locked');
      el.lockControls?.classList.add('locked');
      if (el.cancelBtn) el.cancelBtn.disabled = false;
    } else {
      el.lockWrapper?.classList.remove('locked');
      el.lockControls?.classList.remove('locked');
    }
  }

  if (state.currentJobId) {
    currentJobId = state.currentJobId;
    currentJobStage = state.currentJobStage || null;
    setAdobeAutomateControlsDisabled(true);
    if (el.cancelBtn) el.cancelBtn.disabled = false;
  }

  function autoResize(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = parseInt(getComputedStyle(textarea).maxHeight) || 0;
    const newHeight = Math.min(textarea.scrollHeight, maxHeight || textarea.scrollHeight);
    textarea.style.height = `${newHeight}px`;
  }

  function updateSourcePathDisplay(paths = []) {
    if (!el.srcPath) return;
    if (paths.length === 0) {
      el.srcPath.value = '';
    } else if (paths.length === 1) {
      el.srcPath.value = paths[0];
    } else {
      const displayLimit = 500;
      const totalCount = paths.length;
      const displayCount = Math.min(totalCount, displayLimit);
      const truncated = totalCount > displayLimit;
      const totalSelectedLabel = translate(
        'adobeUtilities.sourceSummary.itemsSelected',
        '{{count}} items selected',
        { count: totalCount }
      );
      const showingFirstLabel = translate(
        'adobeUtilities.sourceSummary.showingFirst',
        'showing first {{count}}',
        { count: displayCount }
      );
      const header = truncated
        ? `${totalSelectedLabel} (${showingFirstLabel})`
        : totalSelectedLabel;
      const subset = paths.slice(0, displayCount).join('\n');
      const truncationNote = truncated
        ? `\n${translate(
          'adobeUtilities.sourceSummary.moreNotShown',
          '… {{count}} more not shown',
          { count: totalCount - displayCount }
        )}`
        : '';
      el.srcPath.value = `${header}:\n${subset}${truncationNote}`;
    }
    autoResize(el.srcPath);
  }

  if (!window.__LEADAE_ADOBE_UTILS_SOURCE_SUMMARY_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_SOURCE_SUMMARY_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try {
        updateSourcePathDisplay(getEffectiveSources());
      } catch {}
    });
  }

  function getEffectiveSources() {
    let files = [];
    if (Array.isArray(state.expandedSources) && state.expandedSources.length) {
      files = state.expandedSources;
    } else if (Array.isArray(state.sources)) {
      files = state.sources;
    }

    if (Array.isArray(state.removedFiles) && state.removedFiles.length) {
      const removed = new Set(state.removedFiles);
      files = files.filter(f => !removed.has(f));
    }

    return files || [];
  }

  let sourceScanToken = 0;
  let isSourceScanActive = false;

  function getStartButtonIdleLabel() {
    return translate('automate', 'Automate');
  }

  function setSourceScanState(isScanning) {
    isSourceScanActive = Boolean(isScanning);

    if (el.startBtn) {
      const labelEl = el.startBtn.querySelector('.button_text');
      const idleLabel = getStartButtonIdleLabel();
      if (labelEl) {
        labelEl.textContent = isScanning
          ? translate('adobeUtilities.scanningSources', 'Scanning sources…')
          : idleLabel;
      }
      el.startBtn.value = isScanning
        ? translate('adobeUtilities.scanningSources', 'Scanning sources…')
        : idleLabel;
      if (isScanning) {
        el.startBtn.disabled = true;
        el.startBtn.dataset.scanning = 'true';
      } else if (!state.currentJobId) {
        const hasValidSources =
          !state.sourceScanFailed && getEffectiveSources().length > 0;
        el.startBtn.disabled = !hasValidSources;
        delete el.startBtn.dataset.scanning;
      }
    }

    if (el.srcBtn) {
      if (isScanning) {
        el.srcBtn.dataset.loading = 'true';
        el.srcBtn.setAttribute('aria-busy', 'true');
      } else {
        delete el.srcBtn.dataset.loading;
        el.srcBtn.removeAttribute('aria-busy');
      }
    }
  }

  if (!window.__LEADAE_ADOBE_UTILS_SOURCE_SCAN_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_SOURCE_SCAN_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try {
        setSourceScanState(isSourceScanActive);
      } catch {}
    });
  }

  async function expandSourcePaths(paths = [], { showLoading = false } = {}) {
    const token = ++sourceScanToken;

    if (!Array.isArray(paths) || !paths.length) {
      state.expandedSources = [];
      _unassignedFiles = [];
      state.sourceScanFailed = false;
      updateSourcePathDisplay([]);
      renderSourceFileList();
      triggerPreviewUpdate();
      resetFileInfoGrid('adobe', 'adobe-file-grid');
      return { files: [] };
    }

    state.sourceScanFailed = false;
    if (showLoading) setSourceScanState(true);

    try {
      const response = await ipc?.expandPaths?.(paths, {
        maxDepth: 10,
        maxFiles: 15000,
        timeoutMs: 20000
      });

      if (token !== sourceScanToken) {
        return { files: state.expandedSources || [] };
      }

      if (!response || response.success === false) {
        throw new Error(
          response?.error ||
            translate('adobeUtilities.expandSourcesFailed', 'Unable to expand sources.')
        );
      }

      const files = Array.isArray(response.files) ? response.files : [];
      state.expandedSources = files;
      _unassignedFiles = files.filter(f => !fileToBinMap[f]);

      if (response.timedOut) {
        setUILog(
          `⚠️ ${translate(
            'adobeUtilities.sourceScanTimeout',
            'Source scan timed out. Please narrow your selection and try again.'
          )}`,
          { isError: true }
        );
      } else if (response.truncated) {
        setUILog(
          `⚠️ ${translate(
            'adobeUtilities.sourceScanTruncated',
            'Source scan hit the file limit; job may be truncated.'
          )}`,
          { isError: true }
        );
      }

      const effectiveFiles = getEffectiveSources();
      updateSourcePathDisplay(effectiveFiles);
      renderSourceFileList();
      updateJobPreview();
      await renderAdobeGrid(effectiveFiles);

      return {
        files,
        truncated: !!response.truncated,
        timedOut: !!response.timedOut
      };
    } catch (err) {
      if (token !== sourceScanToken) return { files: state.expandedSources || [] };
      state.expandedSources = [];
      _unassignedFiles = [];
      state.sourceScanFailed = true;
      updateSourcePathDisplay([]);
      renderSourceFileList();
      triggerPreviewUpdate();
      resetFileInfoGrid('adobe', 'adobe-file-grid');
      const sourceScanErrorMessage = translate(
        'adobeUtilities.sourceScanFailed',
        '❌ Failed to scan sources: {{error}}',
        { error: err.message }
      );
      setUILog(sourceScanErrorMessage, { isError: true });
      if (showLoading) {
        showAdobeToast(sourceScanErrorMessage, { persistent: true, isError: true });
      }
      return null;
    } finally {
      if (showLoading) setSourceScanState(false);
    }
  }

  const presetDir = electron.resolvePath('config', 'presets', 'adobe-utilities');
  const proxyPresetDir = electron.resolvePath('config', 'presets', 'media-encoder');
  const _proxyMatchRules = [
    translate(
      'adobeUtilities.proxyMatchRules.heading',
      'Proxy Attachment Rules:'
    ),
    translate(
      'adobeUtilities.proxyMatchRules.container',
      '• Container must match (mov/mp4)'
    ),
    translate(
      'adobeUtilities.proxyMatchRules.resolution',
      '• Resolution/frame size must match source'
    ),
    translate(
      'adobeUtilities.proxyMatchRules.frameRate',
      '• Frame rate must match source'
    ),
    translate(
      'adobeUtilities.proxyMatchRules.audioLayout',
      '• Audio layout/channel count must match source'
    )
  ].join('\n');

  // cache last message to suppress duplicates (job-scoped)
  let lastLogKey = '';
  const ADOBE_LOG_PLACEHOLDER_I18N = 'logsWillAppearHere';

  function isAdobeLogPlaceholderOnly(logEl) {
    if (!logEl) return false;
    const meaningful = Array.from(logEl.childNodes).filter(node => {
      if (node.nodeType === 3) return (node.textContent || '').trim().length > 0;
      return true;
    });
    if (meaningful.length !== 1) return false;
    const [onlyNode] = meaningful;
    if (onlyNode.nodeType !== 1) return false;
    const placeholderEl = /** @type {HTMLElement} */ (onlyNode);
    if (placeholderEl.tagName !== 'SPAN') return false;
    const key = placeholderEl.getAttribute('data-i18n') || placeholderEl.dataset?.i18n || '';
    return key === ADOBE_LOG_PLACEHOLDER_I18N || placeholderEl.classList.contains('lae-placeholder');
  }

  function ensureAdobeLogPlaceholder(logEl) {
    if (!logEl) return;
    if (isAdobeLogPlaceholderOnly(logEl)) return;

    const hasContent = Array.from(logEl.childNodes).some(node => {
      if (node.nodeType === 3) return (node.textContent || '').trim().length > 0;
      return true;
    });
    if (hasContent) return;

    const span = document.createElement('span');
    span.className = 'lae-placeholder';
    span.setAttribute('data-i18n', ADOBE_LOG_PLACEHOLDER_I18N);
    span.textContent = translate(ADOBE_LOG_PLACEHOLDER_I18N, 'Logs will appear here...');
    logEl.appendChild(span);
    window.translatePage?.();
  }

  function stripAdobeLogPlaceholder(logEl) {
    if (!logEl || !isAdobeLogPlaceholderOnly(logEl)) return;
    logEl.textContent = '';
  }

  function setUILog(msg, { append = true, isError, mirrorToMain = true } = {}) {
    const logEl = el.logWindow;
    const normalizedMsg = typeof msg === 'string' ? msg : String(msg ?? '');

    if (!append && !normalizedMsg) {
      if (logEl) {
        logEl.textContent = '';
        ensureAdobeLogPlaceholder(logEl);
      }
      lastLogKey = '';
      return;
    }

    if (!normalizedMsg.trim()) {
      ensureAdobeLogPlaceholder(logEl);
      return;
    }

    const activeJobId = getActiveJobId?.() || '';
    const dedupeKey = `${activeJobId}|${normalizedMsg}`;
    if (dedupeKey === lastLogKey) return;
    lastLogKey = dedupeKey;

    const hasErrorPrefix = normalizedMsg.trim().startsWith('❌');
    const effectiveIsError =
      typeof isError === 'boolean' ? isError : normalizedMsg.includes('❌');
    const prefix = effectiveIsError && !hasErrorPrefix ? '❌ ' : '';
    const now = new Date().toLocaleTimeString();
    const line = `[${now}] ${prefix}${normalizedMsg}`;

    if (logEl) {
      stripAdobeLogPlaceholder(logEl);
      if (append) {
        logEl.textContent = logEl.textContent
          ? `${logEl.textContent}\n${line}`
          : line;
      } else {
        logEl.textContent = line;
      }
    }

    if (mirrorToMain) {
      window.logPanel?.log('adobe-utilities', line, { isError: effectiveIsError });
    }
    if (typeof panelDebug === 'function') panelDebug(line);
    if (mirrorToMain) {
      logToViewer(line, { isError: effectiveIsError });
    }
  }

  ensureAdobeLogPlaceholder(el.logWindow);

  // 🔊 Also forward key events to the global Log Viewer
  function logToViewer(
    msg,
    { detail = '', isError = false, fileId = '' } = {}
  ) {
    const send = ipc?.send;
    if (typeof send !== 'function') return;

    const jobId = getActiveJobId?.() || null;
    const stage = state?.currentJobStage || currentJobStage || null;
    send('adobe-utilities-log-message', { msg, detail, isError, fileId, jobId, stage });
  }

  if (typeof ipc !== 'undefined' && typeof ipc.on === 'function') {
    ipc.on('adobe-utilities-log-message', (_e, data) => {
      const payload = data && typeof data === 'object' ? data : {};
      const payloadJobId = normalizeJobId(payload.jobId);
      const activeJobId = getActiveJobId();

      if (activeJobId) {
        if (!payloadJobId || payloadJobId !== activeJobId) return;
      } else if (payloadJobId) {
        if (wasFinalized(payloadJobId)) return;
        currentJobId = payloadJobId;
        state.currentJobId = payloadJobId;
      } else {
        return;
      }

      const rawMsg = payload.msg ?? payload.message ?? '';
      const msg = String(rawMsg ?? '').trim();
      if (!msg) return;

      const level = String(
        payload.level || (payload.isWarning ? 'warn' : payload.isError ? 'error' : 'info')
      ).toLowerCase();
      if (level === 'debug' && !isDevUiEnabled()) return;

      const isError = level === 'error' || !!payload.isError;
      const detail = typeof payload.detail === 'string' ? payload.detail.trim() : '';
      const showDetail = isDevUiEnabled() && detail && detail !== '{}';
      const clippedDetail = showDetail && detail.length > 800 ? `${detail.slice(0, 800)}…` : detail;
      const line = showDetail ? `${msg}\n↳ ${clippedDetail}` : msg;

      setUILog(line, { isError, mirrorToMain: false });
    });
  }

  function whenCEPReady(cb, timeoutMs = 3000) {
    const start = Date.now();
    const t = setInterval(() => {
      if (window.__adobe_cep__ && typeof CSInterface !== 'undefined') {
        clearInterval(t);
        cb();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        const msg = `❌ CEP not ready after ${timeoutMs}ms — CSInterface: ${typeof CSInterface}, CEP: ${typeof window.__adobe_cep__}`;
        debugLog(msg);
      }
    }, 100);
  }

  function initCS() {
    try {
      if (typeof CSInterface !== 'undefined') {
        window.csInterface = new CSInterface();
        console.log('✅ CSInterface initialized');
        if (typeof panelDebug === 'function') panelDebug('✅ CSInterface initialized');
      } else {
        console.warn('⚠️ CSInterface is undefined — not in CEP environment');
        if (typeof panelDebug === 'function')
          panelDebug('⚠️ CSInterface is undefined — not in CEP environment');
        window.csInterface = undefined;
      }
    } catch (err) {
      console.error('CSInterface init error:', err);
      if (typeof panelDebug === 'function')
        panelDebug(`CSInterface init error: ${err?.message || err}`);
      window.csInterface = undefined;
    }
  }

  function registerPremiereEvents() {
    if (!window.csInterface) return;
    window.csInterface.addEventListener('premiere-attach-proxy', e => {
      let pairs = [];
      try {
        pairs = JSON.parse(e.data || '[]');
      } catch (err) {
        debugLog(`❌ premiere-attach-proxy parse error: ${err}`);
      }
      if (pairs && pairs.length) {
        // Force stringify for ExtendScript
        const arg = JSON.stringify(pairs);
        safeEvalScript(window.csInterface, 'LEADAE_attachProxy', arg);
      }
    });
  }

  const reconnectButtonFallback = {
    reconnect: 'Reconnect',
    bridgeOnly: 'Bridge Only',
    connected: 'Connected'
  };

  function getReconnectInput() {
    return document.getElementById('reconnect-checkbox');
  }

  function getReconnectLabel() {
    return document.querySelector('label[for="reconnect-checkbox"]');
  }

  function getReconnectStateKey() {
    const label = getReconnectLabel();
    const state = label?.dataset?.state;
    if (state === 'reconnect' || state === 'bridgeOnly' || state === 'connected') {
      return state;
    }

    const input = getReconnectInput();
    if (input?.indeterminate) return 'bridgeOnly';
    if (input?.checked) return 'connected';
    return 'reconnect';
  }

  function translateReconnectButton(label, key) {
    if (!label) return;
    const text = window.i18n?.t ? window.i18n.t(key) : reconnectButtonFallback[key] ?? key;
    label.setAttribute('aria-label', text);
    label.setAttribute('title', text);
    label.dataset.state = key;
    window.translatePage?.();
  }

  function setReconnectButtonState(state) {
    const input = getReconnectInput();
    const label = getReconnectLabel();

    let labelKey = 'reconnect';
    let checked = false;
    let indeterminate = false;

    if (typeof state === 'boolean') {
      labelKey = state ? 'connected' : 'reconnect';
      checked = !!state;
    } else if (typeof state === 'string') {
      if (state === 'connected') {
        labelKey = 'connected';
        checked = true;
      } else if (state === 'bridge-only' || state === 'bridgeOnly' || state === 'bridge') {
        labelKey = 'bridgeOnly';
        indeterminate = true;
      } else {
        labelKey = 'reconnect';
      }
    } else if (state && typeof state === 'object') {
      const backendConnected = !!state.backend;
      const premiereProvided = Object.prototype.hasOwnProperty.call(state, 'premiere');
      const premiereConnected = !!state.premiere;

      if (backendConnected && premiereProvided) {
        if (premiereConnected) {
          labelKey = 'connected';
          checked = true;
        } else {
          labelKey = 'bridgeOnly';
          indeterminate = true;
        }
      } else if (backendConnected) {
        // Treat backend true with no Premiere info as fully connected
        labelKey = 'connected';
        checked = true;
      }
    }

    const shouldDisable = labelKey === 'connected';

    if (input) {
      input.checked = checked;
      input.indeterminate = indeterminate;
      input.disabled = shouldDisable;
    }
    translateReconnectButton(label, labelKey);
    if (label) {
      if (shouldDisable) {
        label.setAttribute('aria-disabled', 'true');
      } else {
        label.removeAttribute('aria-disabled');
      }
    }
  }

  if (!window.__LEADAE_ADOBE_UTILS_RECONNECT_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_RECONNECT_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try {
        translateReconnectButton(getReconnectLabel(), getReconnectStateKey());
      } catch {}
    });
  }

  function broadcastState(state) {
    try {
      const ws = window.__leadAE_socket;
      const OPEN = window.WebSocket?.OPEN ?? 1;
      if (!ws || ws.readyState !== OPEN) return;

      const payload = JSON.stringify({ type: 'connection-state', ...state });
      if (payload === __leadAE_lastBroadcastPayload) return;
      __leadAE_lastBroadcastPayload = payload;

      ws.send(payload);
    } catch (err) {
      console.warn('Failed to broadcast state', err);
    }
  }

  function initializeReconnectButtonState() {
    const openState = window.WebSocket?.OPEN ?? 1;
    const isConnected = window.__leadAE_socket?.readyState === openState;
    setReconnectButtonState({ backend: !!isConnected, premiere: false });
  }

  function clearSocketInterval(socket) {
    if (socket?.__leadAE_pingInterval) {
      clearInterval(socket.__leadAE_pingInterval);
      socket.__leadAE_pingInterval = null;
    }
  }

  function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
      .catch(err => {
        if (err?.name === 'AbortError') {
          const timeoutError = new Error(`Timeout after ${timeoutMs}ms`);
          timeoutError.name = 'TimeoutError';
          throw timeoutError;
        }
        throw err;
      })
      .finally(() => clearTimeout(timeoutId));
  }

  function handleConnectTimeout(stage, timeoutMs) {
    const timeoutSeconds = Math.round(timeoutMs / 1000);
    const message = translate(
      'adobeUtilities.bridge.connectTimeout',
      '⏱️ Assist bridge {{stage}} timed out after {{seconds}}s.',
      { stage, seconds: timeoutSeconds }
    );
    debugLog(message);
    setUILog(message, { isError: true });
    setReconnectButtonState(false);
  }

  function shutdownExistingSocket({ code = 1000, reason = 'reconnect' } = {}) {
    const closingState = window.WebSocket?.CLOSING ?? 2;
    const closedState = window.WebSocket?.CLOSED ?? 3;
    const existing = window.__leadAE_socket;

    if (!existing) return false;
    if (existing.readyState === closingState || existing.readyState === closedState) {
      return false;
    }

    debugLog('🔌 Closing existing Assist WebSocket before reconnect…');
    existing.onopen = null;
    existing.onclose = null;
    existing.onerror = null;
    existing.onmessage = null;
    clearSocketInterval(existing);

    try {
      existing.close(code, reason);
    } catch (err) {
      try {
        existing.close();
      } catch {}
      debugLog(`❌ Error closing existing Assist WebSocket: ${err?.message || err}`);
    }

    setReconnectButtonState({ backend: false, premiere: false });
    window.__leadAE_socket = null;
    return true;
  }

  function hasOpenSocketWithCurrentBridgeCredentials() {
    const openState = window.WebSocket?.OPEN ?? 1;
    const existing = window.__leadAE_socket;
    if (!existing || existing.readyState !== openState) return false;
    return existing.__leadAE_token === TOKEN && existing.__leadAE_baseUrl === BASE_URL;
  }

  async function connectToLeadAE(_force = false) {
    const now = Date.now();
    if (__leadAE_connectInFlight) return;
    if (now - __leadAE_lastConnectAttemptAt < 750) return;

    __leadAE_connectInFlight = true;
    __leadAE_lastConnectAttemptAt = now;

    try {
      const { ok, reason, expiresAt } = (await initBridgeCredentials()) || {};

      if (!ok || !TOKEN) {
        const detail = reason || 'no_token';
        const message =
          detail === 'missing_token'
            ? translate(
              'adobeUtilities.bridge.connectSkippedMissingToken',
              'Skipping CEP bridge connect: token unavailable.'
            )
            : translate(
              'adobeUtilities.bridge.connectSkippedReason',
              'Skipping CEP bridge connect: {{reason}}.',
              { reason: detail }
            );
        debugLog(`⏭️ ${message}`);
        setUILog(message, { isError: true });
        setReconnectButtonState(false);
        return;
      }

      scheduleCredentialRefresh(expiresAt);

      // Internal auto-connect/refresh callers pass _force=true. If the active socket is
      // already open with the same token + base URL, keep it instead of needlessly
      // reconnecting and churning the bridge logs. Manual reconnects (_force=false) still
      // rebuild the socket on demand.
      if (_force && hasOpenSocketWithCurrentBridgeCredentials()) {
        debugLog('✅ Assist bridge credentials unchanged; keeping existing WebSocket open.');
        return;
      }

      shutdownExistingSocket();

      const heartbeatTimeoutMs = 4000;
      let heartbeatRes;
      try {
        heartbeatRes = await fetchWithTimeout(
          `${BASE_URL}/heartbeat`,
          { headers: { Authorization: `Bearer ${TOKEN}` } },
          heartbeatTimeoutMs
        );
      } catch (err) {
        if (err?.name === 'TimeoutError') {
          handleConnectTimeout('heartbeat', heartbeatTimeoutMs);
          return;
        }
        throw err;
      }
      if (heartbeatRes.status === 401 || heartbeatRes.status === 403) {
        debugLog('🔑 Bridge heartbeat rejected — refreshing credentials and retrying…');
        const refreshed = await initBridgeCredentials();
        if (refreshed?.ok && TOKEN) {
          scheduleCredentialRefresh(refreshed.expiresAt);
          heartbeatRes = await fetchWithTimeout(
            `${BASE_URL}/heartbeat`,
            { headers: { Authorization: `Bearer ${TOKEN}` } },
            heartbeatTimeoutMs
          );
        }
      }
      if (!heartbeatRes.ok) {
        const message = translate(
          'adobeUtilities.bridge.heartbeatFailed',
          '❌ Assist bridge heartbeat failed: {{status}} {{statusText}}',
          {
            status: heartbeatRes.status,
            statusText: heartbeatRes.statusText || ''
          }
        ).trim();
        debugLog(message);
        setUILog(message, { isError: true });
        setReconnectButtonState(false);
        return;
      }

      const handshakeTimeoutMs = 4000;
      let handshakeRes;
      try {
        handshakeRes = await fetchWithTimeout(
          `${BASE_URL}/handshake`,
          { headers: { Authorization: `Bearer ${TOKEN}` } },
          handshakeTimeoutMs
        );
      } catch (err) {
        if (err?.name === 'TimeoutError') {
          handleConnectTimeout('handshake', handshakeTimeoutMs);
          return;
        }
        throw err;
      }
      if (handshakeRes.status === 401 || handshakeRes.status === 403) {
        debugLog('🔑 Bridge handshake rejected — refreshing credentials and retrying…');
        const refreshed = await initBridgeCredentials();
        if (refreshed?.ok && TOKEN) {
          scheduleCredentialRefresh(refreshed.expiresAt);
          handshakeRes = await fetchWithTimeout(
            `${BASE_URL}/handshake`,
            { headers: { Authorization: `Bearer ${TOKEN}` } },
            handshakeTimeoutMs
          );
        }
      }
      if (!handshakeRes.ok) {
        const message = translate(
          'adobeUtilities.bridge.handshakeFailed',
          '❌ Assist bridge handshake failed: {{status}} {{statusText}}',
          {
            status: handshakeRes.status,
            statusText: handshakeRes.statusText || ''
          }
        ).trim();
        debugLog(message);
        setUILog(message, { isError: true });
        setReconnectButtonState(false);
        return;
      }

      const socket = new WebSocket(BASE_URL.replace('http', 'ws'), ['Bearer', TOKEN]);
      socket.__leadAE_token = TOKEN;
      socket.__leadAE_baseUrl = BASE_URL;
      socket.__leadAE_pingInterval = setInterval(() => {
        const openState = window.WebSocket?.OPEN ?? 1;
        if (socket.readyState !== openState) {
          clearSocketInterval(socket);
          if (window.__leadAE_socket === socket) {
            const state = { backend: false, premiere: false };
            setReconnectButtonState(state);
            broadcastState(state);
          }
          return;
        }
        try {
          socket.send(JSON.stringify({ type: 'ping' }));
        } catch (err) {
          clearSocketInterval(socket);
          if (window.__leadAE_socket === socket) {
            const state = { backend: false, premiere: false };
            setReconnectButtonState(state);
            broadcastState(state);
          }
          debugLog(`❌ WS ping send failed: ${err?.message || err}`);
        }
      }, 25000);
      socket.onopen = () => {
        debugLog(
          '✅ Assist WebSocket open → should trigger [CEP Bridge] WebSocket connected in terminal'
        );
        debugLog('✅ Connected to Lead AE');
        resetCredentialRefreshBackoff();

        if (isCEP) {
          ensurePremiereConnected().then(premiereConnected => {
            if (window.__leadAE_socket === socket) {
              const state = { backend: true, premiere: premiereConnected };
              setReconnectButtonState(state);
              broadcastState(state);
              debugLog(`🔄 Broadcast state: ${JSON.stringify(state)}`);
            }
          });
        } else if (window.__leadAE_socket === socket) {
          // Only mark backend alive, don't force premiere=false
          setReconnectButtonState({ backend: true });
        }
      };
      socket.onclose = e => {
        clearSocketInterval(socket);
        const shouldReconnect = shouldAutoReconnect();
        if (window.__leadAE_socket === socket) {
          const state = { backend: false, premiere: false };
          setReconnectButtonState(state);
          broadcastState(state);
        }
        debugLog(`🔌 WS closed ${e.code} ${e.reason || ''}`);
        if (shouldReconnect && (e.code === 4001 || e.code === 1008)) {
          scheduleAutoReconnect(
            translate(
              'adobeUtilities.bridge.autoReconnectAfterAuthorizationRefresh',
              '🔄 Auto-reconnecting after authorization refresh…'
            ),
            {
              backoff: true
            }
          );
        }
      };
      socket.onerror = e => debugLog(`❌ WS error: ${e?.message || e}`);
      socket.onmessage = e => {
        debugLog(`📩 ${e.data}`);
        try {
          const msg = JSON.parse(e.data);
          if (msg?.type === 'connection-state') {
            debugLog(
              `📩 connection-state received: backend=${msg.backend}, premiere=${msg.premiere}`
            );
            lastConnectionState = {
              backend: !!msg.backend,
              premiere: !!msg.premiere
            };
            setReconnectButtonState({
              backend: !!msg.backend,
              premiere: !!msg.premiere
            });
          }
        } catch (err) {
          debugLog(`❌ WS message parse error: ${err}`);
        }
      };

      window.__leadAE_socket = socket;
    } catch (err) {
      debugLog(`❌ connectToLeadAE error: ${err?.message || err}`);
      const openState = window.WebSocket?.OPEN ?? 1;
      if (window.__leadAE_socket?.readyState !== openState) {
        setReconnectButtonState(false);
      }
    } finally {
      __leadAE_connectInFlight = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    ensureHamsterStructure(document.querySelector('#cep-job-status .wheel-and-hamster'));
    initializeReconnectButtonState();
    setTimeout(() => {
      debugLog('⏳ Auto-connecting to CEP bridge…');
      connectToLeadAE(true);
    }, 500);
    if (isCEP) {
      // Inside Premiere CEP panel
      whenCEPReady(() => {
        initCS();
        registerPremiereEvents();
        loadAdobeUtilitiesJSX(connected => {
          if (connected) debugLog('✅ Premiere connected on startup');
          else debugLog('⚠️ Premiere not connected on startup');
        });
      });
      // Create our toggle as soon as the row exists
      setTimeout(injectFfmpegFallbackToggle, 0);
    } else {
      // Electron-only: skip CEP init
      console.log('⚠️ Not inside Adobe — skipping CEP init');
    }
  });

  const reconnectInput = document.getElementById('reconnect-checkbox');
  reconnectInput?.addEventListener('change', event => {
    if (reconnectInput.disabled || event.target?.disabled) return;
    debugLog('🔄 Reconnecting…');
    setReconnectButtonState(false);
    connectToLeadAE();
  });

  let folderOrder = Array.isArray(state.binFolders) ? [...state.binFolders] : [];
  let draggedChildren = [];
  const fileToBinMap = {};
  let _unassignedFiles = getEffectiveSources().filter(f => !fileToBinMap[f]);

  function refreshUnassignedFiles() {
    _unassignedFiles = getEffectiveSources().filter(f => !fileToBinMap[f]);
  }

  let lastSelectedIndex;

  const folderGroup = el.folderName?.closest('.field-group');

  function renderFolderList() {
    if (!el.binList) return;
    el.binList.innerHTML = '';
    folderOrder.forEach(id => {
      const depth = id.split('/').length - 1;
      const li = document.createElement('li');
      li.className = 'draggable-item';
      li.dataset.id = id;
      li.dataset.groupId = id.split('/')[0];
      li.style.marginLeft = `${depth * 40}px`;

      const container = document.createElement('div');
      container.className = 'folder-row';
      container.style.display = 'flex';
      container.style.alignItems = 'center';

      const labelSpan = document.createElement('span');
      labelSpan.textContent = depth > 0 ? '↳ ' + id.split('/').pop() : id;
      container.appendChild(labelSpan);
      li.appendChild(container);

      if (depth === 0) {
        li.dataset.root = 'true';
        li.draggable = true;
        li.addEventListener('dragstart', handleDragStart);
        li.addEventListener('dragend', handleDragEnd);
      } else {
        li.dataset.root = 'false';
        li.draggable = false;
        li.classList.add('subfolder');
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-files-btn';
      removeBtn.textContent = '-';
      removeBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const targetId = li.dataset.id;
        const idsToRemove = folderOrder.filter(
          f => f === targetId || f.startsWith(`${targetId}/`)
        );

        // Remove any file assignments that pointed at the removed folders
        for (const [file, bin] of Object.entries(fileToBinMap)) {
          if (idsToRemove.some(id => String(bin || '').startsWith(id))) {
            delete fileToBinMap[file];
          }
        }
        refreshUnassignedFiles();
        folderOrder = folderOrder.filter(f => !idsToRemove.includes(f));
        renderFolderList();
        triggerPreviewUpdate();
        state.binFolders = folderOrder.slice();

        renderSourceFileList();
      });
      li.appendChild(removeBtn);

      li.addEventListener('dragover', e => e.preventDefault());
      li.addEventListener('drop', e => {
        e.preventDefault();
        const data = e.dataTransfer.getData('text/plain');
        if (data) {
          let files;
            try {
              files = JSON.parse(data);
              if (!Array.isArray(files)) files = [data];
            } catch {
              files = data
                .split('\n')
                .map(f => f.trim())
                .filter(Boolean);
            }
          files.forEach(filePath => {
            fileToBinMap[filePath] = li.dataset.id;
          });
          refreshUnassignedFiles();
          renderSourceFileList();
          renderFolderList();
          triggerPreviewUpdate();
        }
      });

      li.addEventListener('mousedown', event => {
        if (event.target.closest('button')) return;
        el.binList.querySelectorAll('li.draggable-item').forEach(item => item.classList.remove('selected'));
        li.classList.add('selected');
      });

      el.binList.appendChild(li);
    });

    triggerPreviewUpdate();
  }

  function renderSourceFileList() {
    if (!el.sourceList) return;

    // Keep file flags in sync with current sources + toggles
    applyAutoRulesToAllFiles();
    refreshUnassignedFiles();

    el.sourceList.innerHTML = '';
    const files = getEffectiveSources();
    lastSelectedIndex = undefined;

    files.forEach((file, index) => {
      const flags = applyAutoRulesToFile(file);
      const bin = fileToBinMap[file] || '';

      const li = document.createElement('li');
      li.className = 'draggable-item';
      li.dataset.path = file;
      li.draggable = true;

      // Visual cues
      if (flags.notImportable) li.style.opacity = '0.6';
      if (!bin) li.style.borderLeft = '3px solid rgba(255,255,255,0.15)';

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '10px';
      // Make the inner row fill the whole <li> so right-side metadata + X can pin to the far right.
      row.style.width = '100%';
      row.style.minWidth = '0';
      row.style.flex = '1 1 auto';

      // Import toggle
      const importWrap = document.createElement('label');
      importWrap.style.display = 'inline-flex';
      importWrap.style.alignItems = 'center';
      importWrap.style.gap = '6px';
      const importCb = document.createElement('input');
      importCb.type = 'checkbox';
      importCb.checked = !!flags.import;
      importCb.disabled = !!flags.notImportable;
      importCb.addEventListener('click', e => e.stopPropagation());
      importCb.addEventListener('change', e => {
        flags.import = !!e.target.checked;
        flags.manualImport = true;

        // If user turns import off, encoding can't sensibly proceed.
        if (!flags.import) {
          flags.encode = false;
          flags.manualEncode = true;
        }

        triggerPreviewUpdate();
        renderSourceFileList();
      });
      const importLbl = document.createElement('span');
      importLbl.textContent = translate('sourceFileImportLabel', 'Import');
      importWrap.appendChild(importCb);
      importWrap.appendChild(importLbl);

      // Encode / proxy toggle (only show when enabled globally)
      const encodeWrap = document.createElement('label');
      encodeWrap.style.display = el.generateProxies?.checked ? 'inline-flex' : 'none';
      encodeWrap.style.alignItems = 'center';
      encodeWrap.style.gap = '6px';
      const encodeCb = document.createElement('input');
      encodeCb.type = 'checkbox';
      encodeCb.checked = !!flags.encode;
      encodeCb.disabled = !!flags.notImportable;
      encodeCb.addEventListener('click', e => e.stopPropagation());
      encodeCb.addEventListener('change', e => {
        flags.encode = !!e.target.checked;
        flags.manualEncode = true;

        // Proxy attach requires import of the original.
        if (flags.encode && !flags.import && !flags.notImportable) {
          flags.import = true;
          flags.manualImport = true;
        }

        triggerPreviewUpdate();
        renderSourceFileList();
      });
      const encodeLbl = document.createElement('span');
      encodeLbl.textContent = translate('sourceFileProxyLabel', 'Proxy');
      encodeWrap.appendChild(encodeCb);
      encodeWrap.appendChild(encodeLbl);

      // File display
      const fileSpan = document.createElement('span');
      fileSpan.style.flex = '1';
      fileSpan.style.minWidth = '0';
      fileSpan.style.overflow = 'hidden';
      fileSpan.style.textOverflow = 'ellipsis';
      fileSpan.style.whiteSpace = 'nowrap';
      fileSpan.style.fontFamily = 'Courier New, monospace';
      fileSpan.textContent = electron.basename?.(file) || file;
      fileSpan.title = file;

      // Status / reasons
      const metaSpan = document.createElement('span');
      metaSpan.style.opacity = '0.85';
      metaSpan.style.fontSize = '11px';
      metaSpan.style.whiteSpace = 'nowrap';
      // Push status text to the far right (X button will sit immediately after it).
      metaSpan.style.marginLeft = 'auto';
      metaSpan.style.textAlign = 'right';
      metaSpan.style.minWidth = '0';
      metaSpan.style.overflow = 'hidden';
      metaSpan.style.textOverflow = 'ellipsis';
      metaSpan.style.maxWidth = '240px';

      const tags = [];
      if (bin) tags.push(translate('sourceFileTagBin', 'Bin: {{bin}}', { bin }));
      if (flags.notImportable) tags.push(translate('sourceFileTagNotImportable', 'Not importable'));
      else {
        if (flags.unsupported) tags.push(translate('sourceFileTagNotSupported', 'Not supported'));
        if (flags.excludedBy) {
          tags.push(translate('sourceFileTagExcluded', 'Excluded by: {{rule}}', { rule: flags.excludedBy }));
        }
        if (flags.excludedBy && flags.import) tags.push(translate('sourceFileTagOverride', 'Manual override'));
      }
      if (!tags.length && !bin) tags.push(translate('sourceFileTagUnassigned', 'Unassigned'));

      metaSpan.textContent = tags.join(' • ');

      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-files-btn';
      removeBtn.textContent = '×';
      removeBtn.title = translate('sourceFileRemoveTitle', 'Remove from list');
      removeBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (!Array.isArray(state.removedFiles)) state.removedFiles = [];
        if (!state.removedFiles.includes(file)) state.removedFiles.push(file);
        delete fileToBinMap[file];
        if (state.fileFlags) delete state.fileFlags[file];
        refreshUnassignedFiles();
        const effectiveFiles = getEffectiveSources();
        updateSourcePathDisplay(effectiveFiles);
        if (effectiveFiles.length) {
          renderAdobeGrid(effectiveFiles).catch(err => {
            console.error('❌ Failed to refresh Adobe source grid after file removal:', err);
          });
        } else {
          resetFileInfoGrid('adobe', 'adobe-file-grid');
        }
        triggerPreviewUpdate();
        renderSourceFileList();
      });

      row.appendChild(importWrap);
      row.appendChild(encodeWrap);
      row.appendChild(fileSpan);
      row.appendChild(metaSpan);
      row.appendChild(removeBtn);

      li.appendChild(row);

      li.addEventListener('mousedown', e => {
        // Don't change selection when interacting with controls
        if (e.target.closest('input') || e.target.closest('button') || e.target.closest('select') || e.target.closest('textarea')) {
          return;
        }

        const alreadySelected = li.classList.contains('selected');
        if (e.shiftKey && typeof lastSelectedIndex === 'number') {
          const items = el.sourceList.querySelectorAll('li.draggable-item');
          const start = Math.min(lastSelectedIndex, index);
          const end = Math.max(lastSelectedIndex, index);
          for (let i = start; i <= end; i++) items[i]?.classList.add('selected');
        } else if (!e.ctrlKey && !e.metaKey && !alreadySelected) {
          el.sourceList
            .querySelectorAll('li.draggable-item.selected')
            .forEach(item => item.classList.remove('selected'));
          li.classList.add('selected');
        } else if (e.ctrlKey || e.metaKey) {
          li.classList.toggle('selected');
        }
        lastSelectedIndex = index;
      });

      li.addEventListener('dragstart', e => {
        const selected = el.sourceList.querySelectorAll('li.draggable-item.selected');
        const paths = selected.length ? Array.from(selected).map(item => item.dataset.path) : [file];
        e.dataTransfer.setData('text/plain', JSON.stringify(paths));

        if (paths.length > 1) {
          const dragPreview = document.createElement('div');
          dragPreview.style.position = 'absolute';
          dragPreview.style.top = '-9999px';
          dragPreview.style.left = '-9999px';
          dragPreview.style.padding = '4px 8px';
          dragPreview.style.background = '#1e2a38';
          dragPreview.style.color = '#fff';
          dragPreview.style.border = '1px solid #ccc';
          dragPreview.style.borderRadius = '4px';
          dragPreview.style.fontSize = '12px';
          dragPreview.style.fontFamily = 'Courier New, monospace';
          dragPreview.textContent = translate(
            'adobeUtilities.filesCount',
            `${paths.length} files`,
            { count: paths.length }
          );
          document.body.appendChild(dragPreview);
          e.dataTransfer.setDragImage(dragPreview, 0, 0);
          setTimeout(() => document.body.removeChild(dragPreview), 0);
        }
      });

      el.sourceList.appendChild(li);
    });
  }

  function refreshSourceListTranslations() {
    renderSourceFileList();
    if (typeof window.translatePage === 'function') {
      window.translatePage();
    }
  }

  if (!window.__LEADAE_ADOBE_UTILS_SOURCE_LIST_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_SOURCE_LIST_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try {
        refreshSourceListTranslations();
      } catch {}
    });
  }

  function getDragAfterElement(y) {
    const items = [...el.binList.querySelectorAll('.draggable-item:not(.dragging)')].filter(i => !draggedChildren.includes(i));
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

  function handleDragStart(e) {
    const li = e.target.closest('li.draggable-item');
    if (!li || li.dataset.root !== 'true') {
      e.preventDefault();
      return;
    }
    const groupId = li.dataset.groupId;
    li.classList.add('dragging');
    const prefix = groupId + '/';
    draggedChildren = [...el.binList.querySelectorAll('li.draggable-item')].filter(item => item.dataset.id.startsWith(prefix) && item.dataset.id !== li.dataset.id);
  }

  function handleDragEnd() {
    const dragging = el.binList.querySelector('.dragging');
    if (dragging) dragging.classList.remove('dragging');
    draggedChildren = [];
    folderOrder = [...el.binList.querySelectorAll('li.draggable-item')].map(li => li.dataset.id);
  }

  el.binList?.addEventListener('dragover', e => {
    e.preventDefault();
    const after = getDragAfterElement(e.clientY);
    const dragging = el.binList.querySelector('.dragging');
    if (!dragging) return;
    const isAfterRoot = after?.dataset?.root === 'true';
    if (after == null) {
      el.binList.appendChild(dragging);
      draggedChildren.forEach(child => el.binList.appendChild(child));
    } else if (isAfterRoot) {
      el.binList.insertBefore(dragging, after);
      draggedChildren.forEach(child => el.binList.insertBefore(child, after));
    }
  });

  el.addFolder?.addEventListener('click', () => {
    const name = el.folderName.value.trim();
    if (!name || folderOrder.includes(name)) return;
    folderOrder.push(name);
    el.folderName.value = '';
    renderFolderList();
    triggerPreviewUpdate();
    const newItem = el.binList.querySelector(`[data-id="${CSS.escape(name)}"]`);
    if (newItem) newItem.classList.add('selected');
  });

  el.addSubfolder?.addEventListener('click', () => {
    const name = el.folderName.value.trim();
    if (!name) return;
    const selected = el.binList.querySelector('li.draggable-item.selected');
    if (!selected) {
      setUILog(
        translate(
          'adobeUtilities.folderNesting.selectParentRequired',
          '❌ Please select a folder to nest under.'
        )
      );
      return;
    }
    const base = selected.dataset.id;
    const full = `${base}/${name}`;
    if (folderOrder.includes(full)) return;
    let insertPos = folderOrder.indexOf(base) + 1;
    while (insertPos < folderOrder.length && folderOrder[insertPos].startsWith(`${base}/`)) insertPos++;
    folderOrder.splice(insertPos, 0, full);
    el.folderName.value = '';
    renderFolderList();
    triggerPreviewUpdate();
    const newItem = el.binList.querySelector(`[data-id="${CSS.escape(full)}"]`);
    if (newItem) newItem.classList.add('selected');
  });

  function getBinPaths() {
    const items = [...el.binList.querySelectorAll('li.draggable-item')];
    return items.map(li => li.dataset.id);
  }

  function toggleBinControls() {
    const show = el.createBins?.checked;
    if (el.binSelection) el.binSelection.style.display = show ? '' : 'none';
    if (el.sourceListGroup) el.sourceListGroup.style.display = show ? '' : 'none';
    if (folderGroup) folderGroup.style.display = show ? '' : 'none';
  }

  function gatherConfig() {
    const selectedMethod = (el.checksumMethod?.value || 'blake3').toLowerCase();
    const webhookUrl = typeof el.n8nUrl?.value === 'string' ? el.n8nUrl.value.trim() : '';
    const generateProxies = !!el.generateProxies?.checked;
    const proxyPreset = normalizeProxyPresetValue(el.proxyPreset?.value || '');

    const threadSettings = syncThreadState();
    const baseSources = Array.isArray(state.sources) ? [...state.sources] : [];
    const expandedSources = getEffectiveSources();
    // Import-time controls
    state.onlySupportedImport = !!el.onlySupportedImport?.checked;
    state.excludePatterns = (typeof el.excludePatterns?.value === 'string') ? el.excludePatterns.value : (state.excludePatterns || '');
    applyAutoRulesToAllFiles();

    const config = {
      sourcePaths: baseSources,
      expandedSources: Array.isArray(expandedSources) ? [...expandedSources] : [],
      sources: Array.isArray(expandedSources) ? [...expandedSources] : [],
      destination: state.destination || '',
      backup: !!el.dualCopy?.checked,
      backupPath: state.backupPath || '',
      dualCopy: !!el.dualCopy?.checked,
      importPremiere: !!el.importPremiere?.checked,
      createBins: !!el.createBins?.checked,
      generateProxies,
      proxyPreset,
      proxyDest: state.proxyDest || '',
      binFolders: folderOrder.slice(),
      saveLog: !!el.saveLog?.checked,
      notes: el.notes?.value || '',
      enableN8N: !!el.enableN8N?.checked,
      n8nUrl: webhookUrl,
      n8nAllowPrivate: !!el.n8nAllowPrivate?.checked,
      n8nLog: !!el.n8nLog?.checked,
      verification: {
        method: selectedMethod
      },
      enableThreads: threadSettings.enableThreads,
      autoThreads: threadSettings.autoThreads,
      maxThreads: threadSettings.maxThreads,
      retryFailures: !!el.retryFailures?.checked,

      // Import-time controls / per-file flags
      onlySupportedImport: !!state.onlySupportedImport,
      excludePatterns: state.excludePatterns || '',
      fileFlags: state.fileFlags || {},
      removedFiles: Array.isArray(state.removedFiles) ? state.removedFiles.slice() : []
    };

    // Map UI flag → backend flag: true (disable) ⇒ ffmpegFallback:false
    if (state.disableFfmpegFallback) {
      config.ffmpegFallback = false;
    }

    if (el.notes) {
      state.notes = el.notes.value;
    }

    syncAutomationState();

    if (config.createBins) {
      config.bins = getBinPaths();
      const _srcSet = new Set(Array.isArray(expandedSources) ? expandedSources : []);
      config.fileToBinMap = Object.fromEntries(Object.entries(fileToBinMap).filter(([k]) => _srcSet.has(k)));
      state.binFolders = config.binFolders.slice();
    }

    const verificationLabelMap = {
      none: translate('verificationNoneLabel', 'None'),
      bytecompare: translate('adobeUtilities.tooltip.verification.byteCompare.label', 'Byte Compare'),
      blake3: translate('adobeUtilities.tooltip.verification.blake3.label', 'BLAKE3'),
      sha256: translate('adobeUtilities.tooltip.verification.sha256.label', 'SHA-256'),
      md5: translate('adobeUtilities.tooltip.verification.md5.label', 'MD5'),
      xxhash64: translate('adobeUtilities.tooltip.verification.xxhash64.label', 'xxHash64')
    };

    const yesLabel = translate('adobeUtilities.jobPreview.yes', 'Yes');
    const noLabel = translate('adobeUtilities.jobPreview.no', 'No');
    const lines = [];
    lines.push(translate('adobeUtilities.jobPreview.header', '🚀 Job Preview:'));
    lines.push(
      translate('adobeUtilities.jobPreview.sourcesCount', '• Sources: {{count}}', {
        count: config.sources.length
      })
    );
    // Import-time controls summary
    const _flags = config.fileFlags || {};
    const _srcs = Array.isArray(config.sources) ? config.sources : [];
    const _importOn = _srcs.filter(p => (_flags[p]?.import ?? true) && !_flags[p]?.notImportable).length;
    const _proxyOn = _srcs.filter(p => (_flags[p]?.encode ?? false) && !_flags[p]?.notImportable).length;
    const _excluded = _srcs.filter(p => !!_flags[p]?.excludedBy).length;
    const _unsupported = _srcs.filter(p => !!_flags[p]?.unsupported).length;
    const _notImportable = _srcs.filter(p => !!_flags[p]?.notImportable).length;

    if (config.importPremiere) lines.push(translate('adobeUtilities.jobPreview.importEnabledPerFile', '• Import enabled (per-file): {{enabled}}/{{total}}', { enabled: _importOn, total: _srcs.length }));
    if (config.generateProxies) lines.push(translate('adobeUtilities.jobPreview.proxyEnabledPerFile', '• Proxy enabled (per-file): {{enabled}}/{{total}}', { enabled: _proxyOn, total: _srcs.length }));
    if (_excluded) lines.push(translate('adobeUtilities.jobPreview.excludedByPattern', '• Excluded by pattern: {{count}}', { count: _excluded }));
    if (_unsupported) lines.push(translate('adobeUtilities.jobPreview.notInSupportedList', '• Not in supported list: {{count}}', { count: _unsupported }));
    if (_notImportable) lines.push(translate('adobeUtilities.jobPreview.notImportable', '• Not importable: {{count}}', { count: _notImportable }));

    if (config.destination) lines.push(translate('adobeUtilities.jobPreview.destination', '• Destination: {{path}}', { path: config.destination }));
    if (config.backup) lines.push(translate('adobeUtilities.jobPreview.backup', '• Backup: {{path}}', { path: config.backupPath || translate('adobeUtilities.jobPreview.notSet', '(not set)') }));
    if (config.backup && !config.destination && !config.importPremiere && !config.createBins && !config.generateProxies) lines.push(translate('adobeUtilities.jobPreview.backupOnlyMode', '• Mode: Backup-only'));
    if (config.notes && config.notes.trim()) {
      lines.push(translate('adobeUtilities.jobPreview.notes', '• Notes: {{notes}}', { notes: config.notes.trim() }));
    }
    if (config.importPremiere) lines.push(translate('adobeUtilities.jobPreview.importIntoPremiere', '• Import into Premiere: {{value}}', { value: yesLabel }));
    if (config.createBins) {
      lines.push(translate('adobeUtilities.jobPreview.createBins', '• Create Bins: {{value}}', { value: yesLabel }));
      const map = config.fileToBinMap || {};
      const binToFiles = Object.entries(map).reduce((acc, [file, bin]) => {
        const name = electron.basename?.(file) || file;
        if (!acc[bin]) acc[bin] = [];
        acc[bin].push(name);
        return acc;
      }, {});

      const orderedBins = Array.isArray(config.bins) && config.bins.length
        ? [...config.bins]
        : Array.isArray(config.binFolders)
          ? [...config.binFolders]
          : [];
      const missingBins = Object.keys(binToFiles).filter(bin => !orderedBins.includes(bin));
      orderedBins.push(...missingBins);

      if (orderedBins.length) {
        lines.push(translate('adobeUtilities.jobPreview.binAssignments', '• Bin Assignments:'));
        const maxPerBin = 10;
        orderedBins.forEach(binPath => {
          const depth = binPath ? (binPath.match(/\//g) || []).length : 0;
          const indent = '   '.repeat(depth + 1);
          const labelParts = binPath.split('/').filter(Boolean);
          const label = labelParts.length
            ? labelParts[labelParts.length - 1]
            : binPath || translate('adobeUtilities.jobPreview.rootBin', '(root)');
          lines.push(`${indent}• ${label}`);
          const files = binToFiles[binPath] || [];
          if (files.length) {
            const fileIndent = '   '.repeat(depth + 2);
            files.slice(0, maxPerBin).forEach(name => {
              lines.push(`${fileIndent}- ${name}`);
            });
            if (files.length > maxPerBin) {
              lines.push(
                `${fileIndent}${translate(
                  'adobeUtilities.jobPreview.andMore',
                  '…and {{count}} more',
                  { count: files.length - maxPerBin }
                )}`
              );
            }
          }
        });
      }
    }

    const maxList = 20; // avoid overly long previews; adjust to taste
    if (config.sources?.length) {
      const names = config.sources.map(f => electron.basename?.(f) || f);
      const wantsBackup = !!config.backup && !!config.backupPath;
      const verb = config.importPremiere
        ? translate('adobeUtilities.jobPreview.verbImport', 'import')
        : config.destination
          ? translate('adobeUtilities.jobPreview.verbCopy', 'copy')
          : wantsBackup
            ? translate('adobeUtilities.jobPreview.verbBackup', 'backup')
            : translate('adobeUtilities.jobPreview.verbProcess', 'process');
      lines.push(translate('adobeUtilities.jobPreview.filesToVerb', '• Files to {{verb}}:', { verb }));
      names.slice(0, maxList).forEach(n => lines.push(`   • ${n}`));
      if (names.length > maxList) {
        lines.push(
          `   ${translate('adobeUtilities.jobPreview.andMore', '…and {{count}} more', {
            count: names.length - maxList
          })}`
        );
      }
    }

    if (config.generateProxies) {
      lines.push(translate('adobeUtilities.jobPreview.generateProxies', '• Generate Proxies: {{value}}', { value: yesLabel }));

      let presetName = translate('adobeUtilities.jobPreview.noneValue', '(none)');
      if (isMatchSourcePreset(config.proxyPreset)) {
        presetName = getMatchSourceDetailLabel();
      } else if (config.proxyPreset) {
        try {
          const parts = config.proxyPreset.split(/[\\/]/);
          presetName = parts[parts.length - 1] || config.proxyPreset;
        } catch {
          presetName = config.proxyPreset;
        }
      }

      lines.push(translate('adobeUtilities.jobPreview.proxyPreset', '   Preset: {{preset}}', { preset: presetName }));
      let displayProxyDest = config.proxyDest;

      if (!displayProxyDest) {
        if (config.destination) {
          const base = config.destination.replace(/[\\/]+$/, '');
          displayProxyDest = translate('adobeUtilities.jobPreview.proxyDestAuto', '{{base}}/Proxies (auto)', { base });
        } else {
          displayProxyDest = translate('adobeUtilities.jobPreview.notSet', '(not set)');
        }
      }

      lines.push(translate('adobeUtilities.jobPreview.proxyDestination', '   Proxy Dest: {{path}}', { path: displayProxyDest }));
      if (isMatchSourcePreset(config.proxyPreset)) {
        lines.push(
          translate(
            'adobeUtilities.jobPreview.dynamicFfmpegMode',
            '   • Dynamic FFmpeg mode (no Adobe Media Encoder preset)'
          )
        );
      }
      lines.push(
        translate('adobeUtilities.jobPreview.ffmpegFallback', '   FFmpeg fallback: {{mode}}', {
          mode: state.disableFfmpegFallback
            ? translate('adobeUtilities.jobPreview.ffmpegFallbackDisabled', 'Disabled')
            : translate('adobeUtilities.jobPreview.ffmpegFallbackAuto', 'Auto')
        })
      );
      // Single-group mode in effect (no compatibility auto-split).
    }

    if (selectedMethod) {
      const pretty = verificationLabelMap[selectedMethod] || selectedMethod;
      lines.push(translate('adobeUtilities.jobPreview.verification', '• Verification: {{method}}', { method: pretty }));
    }

    if (config.saveLog) {
      lines.push(translate('adobeUtilities.jobPreview.saveLog', '• Save Log: {{value}}', { value: yesLabel }));
    }

    if (config.enableThreads) {
      if (config.autoThreads) {
        lines.push(translate('adobeUtilities.jobPreview.threadingAuto', '• Threading: Parallel copy (Auto threads)'));
      } else {
        const threadCount = config.maxThreads || 1;
        const plural = threadCount === 1
          ? translate('adobeUtilities.jobPreview.threadSingular', 'thread')
          : translate('adobeUtilities.jobPreview.threadPlural', 'threads');
        lines.push(
          translate('adobeUtilities.jobPreview.threadingParallel', '• Threading: Parallel copy — {{count}} {{plural}}', {
            count: threadCount,
            plural
          })
        );
      }
    } else {
      lines.push(translate('adobeUtilities.jobPreview.threadingSingle', '• Threading: Single-thread (Parallel copy off)'));
    }

    if (config.retryFailures) {
      lines.push(translate('adobeUtilities.jobPreview.retryFailedCopies', '• Retry Failed Copies: {{value}}', { value: yesLabel }));
    }

    if (config.enableN8N) {
      lines.push(translate('adobeUtilities.jobPreview.webhook', '• Webhook: {{value}}', { value: config.n8nUrl ? config.n8nUrl : translate('adobeUtilities.jobPreview.enabled', 'Enabled') }));
      lines.push(
        translate(
          'adobeUtilities.jobPreview.allowPrivateTargets',
          '   • Allow private/localhost targets: {{value}}',
          { value: config.n8nAllowPrivate ? yesLabel : noLabel }
        )
      );
      if (config.n8nLog) {
        lines.push(translate('adobeUtilities.jobPreview.sendLogPayload', '   • Send log payload'));
      }
    } else {
      lines.push(translate('adobeUtilities.jobPreview.webhook', '• Webhook: {{value}}', { value: translate('adobeUtilities.jobPreview.disabled', 'Disabled') }));
    }

    config.summary = lines.join('\n');
    return config;
  }

  let lastSummary = '';

  function updateJobPreview() {
    const cfg = gatherConfig();

    // Only show a preview once we actually have at least one source
    const hasSources = Array.isArray(cfg.sources) && cfg.sources.length > 0;

    if (!hasSources) {
      lastSummary = '';
      if (el.jobPreviewBox) {
        el.jobPreviewBox.value = '';
        autoResize(el.jobPreviewBox);
      }
      return;
    }

    // Update the inline preview when the summary changes without spamming the log
    if (cfg.summary && cfg.summary !== lastSummary) {
      if (el.jobPreviewBox) {
        el.jobPreviewBox.value = cfg.summary;
        autoResize(el.jobPreviewBox);
      }
    }

    if (cfg.summary) {
      lastSummary = cfg.summary;
    }
  }

  if (!window.__LEADAE_ADOBE_UTILS_JOB_PREVIEW_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_JOB_PREVIEW_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try { updateJobPreview(); } catch {}
    });
  }

  async function applyPreset(data) {
    // Prefer the original (unexpanded) selection when present.
    // This keeps presets lightweight and avoids having to approve thousands of
    // expanded file paths when re-loading a preset.
    const presetSources = Array.isArray(data.sourcePaths) && data.sourcePaths.length
      ? data.sourcePaths
      : Array.isArray(data.sources)
        ? data.sources
        : [];
    state.sources = presetSources;
    const expansion = await expandSourcePaths(state.sources, { showLoading: true });
    const files = expansion?.files || getEffectiveSources();
    state.destination = data.destination || '';
    state.proxyDest = data.proxyDest || '';
    state.backupPath = data.backupPath || '';
    state.dualCopy = !!(data.backup ?? data.dualCopy);
    state.onlySupportedImport = !!data.onlySupportedImport;
    state.excludePatterns = (typeof data.excludePatterns === 'string') ? data.excludePatterns : '';
    state.fileFlags = (typeof data.fileFlags === 'object' && data.fileFlags) ? data.fileFlags : {};
    state.removedFiles = Array.isArray(data.removedFiles) ? data.removedFiles : [];
    if (el.destPath) el.destPath.value = state.destination;
    if (el.proxyDestPath) el.proxyDestPath.value = state.proxyDest;
    if (el.backupPath) el.backupPath.value = state.backupPath;
    if (el.dualCopy) el.dualCopy.checked = state.dualCopy;
    if (el.onlySupportedImport) el.onlySupportedImport.checked = !!state.onlySupportedImport;
    if (el.excludePatterns) {
      el.excludePatterns.value = state.excludePatterns || '';
      try { autoResize(el.excludePatterns); } catch {}
    }
    if (el.importPremiere) el.importPremiere.checked = !!data.importPremiere;
    if (el.createBins) el.createBins.checked = !!data.createBins;
    if (el.generateProxies) {
      el.generateProxies.checked = !!data.generateProxies;
      applyProxySectionVisibility(!!el.generateProxies.checked, { triggerPreview: false });
    }
    if (el.proxyPreset) {
      const presetValue = isMatchSourcePreset(data.proxyPreset)
        ? MATCH_SOURCE_SENTINEL
        : normalizeProxyPresetValue(data.proxyPreset || '');
      el.proxyPreset.value = presetValue;
      if (typeof setDropdownValue === 'function') {
        setDropdownValue('adobe-proxy-preset', presetValue);
      }
    }
    if (el.saveLog) el.saveLog.checked = !!data.saveLog;
    if (el.enableN8N) el.enableN8N.checked = !!data.enableN8N;
    if (el.n8nLog) el.n8nLog.checked = !!data.n8nLog;
    if (el.n8nAllowPrivate) el.n8nAllowPrivate.checked = !!data.n8nAllowPrivate;
    if (el.n8nUrl) el.n8nUrl.value = data.n8nUrl || '';
    if (el.notes) {
      el.notes.value = data.notes || '';
      autoResize(el.notes);
    }
    // Load fallback behavior from preset/config
    try {
      state.disableFfmpegFallback = (data.ffmpegFallback === false) || false;
      // Reflect into UI if already injected
      const input = document.getElementById('adobe-disable-ffmpeg');
      if (input) input.checked = state.disableFfmpegFallback;
    } catch {}
    if (el.checksumMethod) {
      const method = (data.verification?.method || 'blake3').toLowerCase();
      el.checksumMethod.value = method;
      if (typeof setDropdownValue === 'function') {
        setDropdownValue('adobe-checksum-method', method);
      }
    }
    if (el.enableThreads) el.enableThreads.checked = !!data.enableThreads;
    if (el.autoThreads) el.autoThreads.checked = !!data.autoThreads;
    if (el.retryFailures) el.retryFailures.checked = !!data.retryFailures;
    if (el.concurrencySlider) {
      if (data.maxThreads == null || data.autoThreads) {
        el.concurrencySlider.value = '3';
      } else {
        el.concurrencySlider.value = String(data.maxThreads || '1');
      }
    }
    updateThreadControls();

    syncAutomationState();

    folderOrder = Array.isArray(data.binFolders) ? [...data.binFolders] : [];
    state.binFolders = folderOrder.slice();
    state.notes = data.notes || '';
    for (const key in fileToBinMap) delete fileToBinMap[key];
    if (data.fileToBinMap) Object.assign(fileToBinMap, data.fileToBinMap);
    _unassignedFiles = files.filter(f => !fileToBinMap[f]);

    renderFolderList();
    updateSourcePathDisplay(files);
    triggerPreviewUpdate();
    renderSourceFileList();
    toggleBinControls();
    updateJobPreview();
    if (!files.length) {
      resetFileInfoGrid('adobe', 'adobe-file-grid');
    }
    // Make sure the toggle exists if proxies are visible
    if (el.generateProxies?.checked) injectFfmpegFallbackToggle();
  }

  async function refreshPresetDropdown() {
    const hidden = document.getElementById('adobe-utilities-preset');
    if (!hidden) return;
    const isDefaultPresetEntry = (value) => {
      if (window.panelPresetDefaults?.isDefaultPresetFile?.(value)) return true;
      const normalized = String(value || '').trim().toLowerCase();
      return normalized === 'default' || normalized === 'default.json';
    };
    const getPresetLabel = (presetName, presetFile) => {
      if (isDefaultPresetEntry(presetFile) || isDefaultPresetEntry(presetName)) {
        return translate('adobeUtilities.preset.defaultLabel', 'Default');
      }
      return presetName || String(presetFile || '').replace(/\.json$/i, '');
    };
    let opts = [];
    try {
      if (ipc?.invoke) {
        const presets = await ipc.invoke('list-panel-presets', 'adobe-utilities');
        opts = (Array.isArray(presets) ? presets : [])
          .filter(p => typeof p?.file === 'string')
          .map(p => ({
            value: p.file,
            label: getPresetLabel(p.name, p.file)
          }));
      } else {
        const mkdir = (typeof electron?.mkdirAsync === 'function')
          ? electron.mkdirAsync.bind(electron)
          : (typeof electron?.mkdir === 'function')
            ? async (p) => { electron.mkdir(p); return true; }
            : null;

        const readdir = (typeof electron?.readdirAsync === 'function')
          ? electron.readdirAsync.bind(electron)
          : (typeof electron?.readdir === 'function')
            ? async (p, o) => (electron.readdir(p, o) || [])
            : null;

        if (mkdir && readdir) {
          await mkdir(presetDir);
          const files = (await readdir(presetDir)) || [];
          opts = files
            .filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.json'))
            .sort((a, b) => {
              const aDefault = isDefaultPresetEntry(a);
              const bDefault = isDefaultPresetEntry(b);
              if (aDefault !== bDefault) return aDefault ? -1 : 1;
              return String(a).localeCompare(String(b), undefined, {
                sensitivity: 'base',
                numeric: true
              });
            })
            .map(f => ({
              value: f,
              label: getPresetLabel('', f)
            }));
        }
      }
    } catch (err) {
      console.error('Failed to read presets:', err);
    }
    setupStyledDropdown('adobe-utilities-preset', opts);
    setDropdownValue('adobe-utilities-preset', hidden.value || '');
    window.translatePage?.();

    if (!hidden.dataset.listenerBound) {
      hidden.addEventListener('change', async () => {
        const file = hidden.value;
        if (!file) return;
        try {
          const readText = (typeof electron?.readTextFileAsync === 'function')
            ? electron.readTextFileAsync.bind(electron)
            : async (p, enc) => electron.readTextFile(p, enc);

          const raw = await readText(electron.joinPath(presetDir, file));
          const data = JSON.parse(raw);
          await applyPreset(data);
        } catch (err) {
          console.error('Failed to load preset', err);
        }
      });
      hidden.dataset.listenerBound = 'true';
    }
  }

  function bindAdobeUtilitiesPresetDropdownI18nRefresh() {
    if (window.__LEADAE_ADOBE_UTILS_PRESET_I18N_BOUND__) return;

    const refreshPresetDropdownI18n = () => {
      refreshPresetDropdown().catch((err) => {
        console.error('Failed to refresh Adobe Utilities presets for i18n:', err);
      });
    };

    const attach = () => {
      const i18n = window.i18n;
      if (!i18n?.on) return false;
      try {
        i18n.on('languageChanged', refreshPresetDropdownI18n);
        i18n.on('initialized', refreshPresetDropdownI18n);
        i18n.on('loaded', refreshPresetDropdownI18n);
      } catch {
        return false;
      }
      window.__LEADAE_ADOBE_UTILS_PRESET_I18N_BOUND__ = true;
      if (i18n.isInitialized) {
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

  refreshPresetDropdown().catch(() => {});
  bindAdobeUtilitiesPresetDropdownI18nRefresh();

  el.saveConfig?.addEventListener('click', async () => {
    const cfg = gatherConfig();
    const file = await ipc.saveFile({
      title: translate('adobeUtilities.savePresetDialogTitle', 'Save Preset'),
      defaultPath: electron.joinPath(presetDir, 'adobe-utilities-config.json')
    });
    if (file) {
      const serialized = JSON.stringify(cfg, null, 2);
      if (typeof ipc?.writeTextFileAtomicAsync === 'function') {
        await ipc.writeTextFileAtomicAsync(file, serialized);
      } else if (typeof ipc?.writeTextFileAsync === 'function') {
        await ipc.writeTextFileAsync(file, serialized);
      } else {
        ipc.writeTextFile(file, serialized);
      }
      ipc.send('preset-saved', 'adobe-utilities');
      await refreshPresetDropdown();
      setUILog(translate('adobeUtilities.configSaved', '✅ Config saved.'));
    }
  });

  el.loadConfig?.addEventListener('click', async () => {
    const file = await ipc.openFile({
      title: translate('adobeUtilities.loadPresetDialogTitle', 'Load Preset')
    });
    if (!file) return;
    try {
      const data = JSON.parse(ipc.readTextFile(file));
      await applyPreset(data);
    } catch (err) {
      setUILog(
        translate(
          'adobeUtilities.configLoadFailed',
          '❌ Failed to load config: {{error}}',
          { error: err?.message || String(err) }
        ),
        { isError: true }
      );
    }
  });

  renderFolderList();
  renderSourceFileList();
  updateSourcePathDisplay(getEffectiveSources());
  const initialFiles = getEffectiveSources();
  if (Array.isArray(initialFiles) && initialFiles.length) {
    renderAdobeGrid(initialFiles);
  } else {
    resetFileInfoGrid('adobe', 'adobe-file-grid');
  }
  // ⚠️ Don't call updateJobPreview here

  toggleBinControls();
  el.createBins?.addEventListener('change', toggleBinControls);
  el.importPremiere?.addEventListener('change', updateJobPreview);
  el.createBins?.addEventListener('change', updateJobPreview);
  el.saveLog?.addEventListener('change', updateJobPreview);
  el.checksumMethod?.addEventListener('change', updateJobPreview);

  // Import-time controls: supported-only + exclude patterns
  el.onlySupportedImport?.addEventListener('change', () => {
    state.onlySupportedImport = !!el.onlySupportedImport.checked;
    applyAutoRulesToAllFiles();
    renderSourceFileList();
    updateJobPreview();
  });

  if (el.excludePatterns) {
    autoResize(el.excludePatterns);
    el.excludePatterns.addEventListener('input', () => {
      state.excludePatterns = el.excludePatterns.value;
      autoResize(el.excludePatterns);
      applyAutoRulesToAllFiles();
      renderSourceFileList();
      updateJobPreview();
    });
  }


  if (el.notes) {
    autoResize(el.notes);
    el.notes.addEventListener('input', () => {
      state.notes = el.notes.value;
      autoResize(el.notes);
      updateJobPreview();
    });
  }

  const handleAutomationChange = () => {
    syncAutomationState();
    updateJobPreview();
  };

  el.enableN8N?.addEventListener('change', handleAutomationChange);
  el.n8nLog?.addEventListener('change', handleAutomationChange);
  el.n8nAllowPrivate?.addEventListener('change', handleAutomationChange);
  el.n8nUrl?.addEventListener('input', handleAutomationChange);

  const handleThreadingChange = () => {
    updateThreadControls();
    updateJobPreview();
  };

  el.enableThreads?.addEventListener('change', handleThreadingChange);
  el.autoThreads?.addEventListener('change', handleThreadingChange);
  el.retryFailures?.addEventListener('change', () => {
    syncThreadState();
    updateJobPreview();
  });
  el.concurrencySlider?.addEventListener('input', () => {
    if (!el.autoThreads?.checked && el.concurrencyValue) {
      el.concurrencyValue.textContent = el.concurrencySlider.value;
    }
    syncThreadState();
    updateJobPreview();
  });

  function resetAdobeFields(opts = {}) {
    const { preserveJobPreview = false } = opts;
    hideAdobeToast();
    submittedJobConfig = null;
    for (const key in state) delete state[key];
    state.sources = [];
    state.expandedSources = [];
    state.destination = '';
    state.proxyDest = '';
    state.ffmpegPath = '';
    state.disableFfmpegFallback = false;
    state.backupPath = '';
    state.dualCopy = false;
    state.onlySupportedImport = false;
    state.excludePatterns = '';
    state.fileFlags = {};
    state.removedFiles = [];
    folderOrder = [];
    draggedChildren = [];
    for (const key in fileToBinMap) delete fileToBinMap[key];
    _unassignedFiles = [];

    if (el.srcPath) {
      el.srcPath.value = '';
      autoResize(el.srcPath);
    }
    resetFileInfoGrid('adobe', 'adobe-file-grid');
    if (el.destPath) el.destPath.value = '';
    if (el.proxyDestPath) el.proxyDestPath.value = '';
    if (el.backupPath) el.backupPath.value = '';

    if (el.importPremiere) el.importPremiere.checked = true;
    if (el.createBins) el.createBins.checked = true;
    if (el.generateProxies) el.generateProxies.checked = false;
    if (el.dualCopy) el.dualCopy.checked = false;
    if (el.onlySupportedImport) el.onlySupportedImport.checked = false;
    if (el.excludePatterns) {
      el.excludePatterns.value = '';
      try { autoResize(el.excludePatterns); } catch {}
    }
    if (el.saveLog) el.saveLog.checked = false;
    const hideLogToggle = document.getElementById('adobe-hide-log');
    if (hideLogToggle) {
      hideLogToggle.checked = true;
      try { hideLogToggle.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    }
    if (el.enableN8N) el.enableN8N.checked = false;
    if (el.n8nLog) el.n8nLog.checked = false;
    if (el.n8nAllowPrivate) el.n8nAllowPrivate.checked = false;
    if (el.n8nUrl) el.n8nUrl.value = '';
    if (el.checksumMethod) {
      el.checksumMethod.value = 'blake3';
      if (typeof setDropdownValue === 'function') {
        setDropdownValue('adobe-checksum-method', 'blake3');
      }
    }
    if (el.enableThreads) el.enableThreads.checked = true;
    if (el.autoThreads) el.autoThreads.checked = true;
    if (el.retryFailures) el.retryFailures.checked = false;
    if (el.concurrencySlider) el.concurrencySlider.value = '3';
    if (el.concurrencyValue) el.concurrencyValue.textContent = '3';
    if (el.proxyPreset) {
      el.proxyPreset.value = MATCH_SOURCE_SENTINEL;
      if (typeof setDropdownValue === 'function') {
        setDropdownValue('adobe-proxy-preset', MATCH_SOURCE_SENTINEL);
      }
    }
    if (el.proxyPresetWrapper) el.proxyPresetWrapper.style.display = 'none';
    if (el.folderName) el.folderName.value = '';
    if (el.notes) {
      el.notes.value = '';
      autoResize(el.notes);
    }
    if (el.proxyDestRow) el.proxyDestRow.style.display = 'none';
    // Reset FFmpeg fallback toggle
    state.disableFfmpegFallback = false;
    const ffcb = document.getElementById('adobe-disable-ffmpeg');
    if (ffcb) ffcb.checked = false;

    syncAutomationState();

    renderFolderList();
    renderSourceFileList();
    toggleBinControls();

    const bar = document.getElementById('adobe-progress');
    const out = document.querySelector('output[for="adobe-progress"]');
    if (bar) bar.value = 0;
    if (out) out.value = '';
    setUILog('', { append: false });
    if (el.jobPreviewBox && !preserveJobPreview) {
      el.jobPreviewBox.value = '';
      autoResize(el.jobPreviewBox);
      delete el.jobPreviewBox.dataset.joblogVisible;
    }
    if (!preserveJobPreview) lastSummary = '';

    window.watchConfigs.adobeUtilities = state;
    updateThreadControls();
  }

  el.resetBtn?.addEventListener('click', () => {
    if (window.panelPresetDefaults?.has?.('adobe-utilities')) {
      void window.panelPresetDefaults.resetToDefault('adobe-utilities')
        .then(applied => {
          if (!applied) resetAdobeFields();
          const hideLogToggle = document.getElementById('adobe-hide-log');
          if (hideLogToggle) {
            hideLogToggle.checked = true;
            try { hideLogToggle.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
          }
        })
        .catch(() => {
          resetAdobeFields();
        });
      return;
    }

    resetAdobeFields();
  });

  el.srcBtn?.addEventListener('click', async () => {
    const paths = await window.electron.selectFiles?.();
    if (!Array.isArray(paths) || !paths.length) return; // ✅ Prevents beep on cancel
    state.sources = paths;
    for (const key in fileToBinMap) delete fileToBinMap[key];
    await expandSourcePaths(paths, { showLoading: true });
  });

  el.destBtn?.addEventListener('click', async () => {
    const folder = await window.electron.selectFolder?.();
    if (!folder) return; // ✅ Prevents beep on cancel
    state.destination = folder;
    el.destPath.value = folder;
    updateJobPreview();
  });

  el.backupBtn?.addEventListener('click', async () => {
    const folder = await window.electron.selectFolder?.();
    if (!folder) return; // ✅ Prevents beep on cancel
    state.backupPath = folder;
    if (el.backupPath) el.backupPath.value = folder;
    updateJobPreview();
  });

  el.dualCopy?.addEventListener('change', () => {
    state.dualCopy = !!el.dualCopy.checked;
    updateJobPreview();
  });

  el.proxyDestBtn?.addEventListener('click', async () => {
    const folder = await window.electron.selectFolder?.();
    if (!folder) return; // ✅ Prevents beep on cancel
    state.proxyDest = folder;
    el.proxyDestPath.value = folder;
    updateJobPreview();
  });

  el.loadProxyPreset?.addEventListener('click', async () => {
    const files = await window.electron.selectFiles?.();
    const file = Array.isArray(files) ? files[0] : files;
    if (!file || !file.toLowerCase().endsWith('.epr')) return;
    el.proxyPreset.value = file;
    triggerPreviewUpdate();
    await loadProxyPresets();
    updateJobPreview();
  });

  el.generateProxies?.addEventListener('change', () => {
    const show = el.generateProxies.checked;
    applyProxySectionVisibility(show);
    applyAutoRulesToAllFiles();
    renderSourceFileList();
  });

  if (el.generateProxies) {
    const show = el.generateProxies.checked;
    applyProxySectionVisibility(show, { triggerPreview: false });
  }

  // 🔧 Helpers that delegate to main for OS-correct behavior
  async function normalizePath(p) {
    if (!p) return p;
    try {
      const out = await ipc?.invoke?.('normalize-path', p);
      return typeof out === 'string' ? out : p;
    } catch {
      return p;
    }
  }
  async function pathExists(p) {
    const candidate = typeof p === 'string' ? p.trim() : String(p ?? '').trim();
    if (!candidate) return false;
    try {
      if (ipc?.invoke) {
        const out = await ipc.invoke('path-exists', candidate);
        return !!out;
      }
    } catch {
      try {
        const st = await ipc?.invoke?.('stat-path', candidate);
        if (st && typeof st === 'object') return !!st.ok;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  function uniqPaths(list) {
    const out = [];
    const seen = new Set();
    const items = Array.isArray(list) ? list : [list];
    for (const item of items) {
      const s = typeof item === 'string' ? item.trim() : String(item ?? '').trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  // Prompt for path approvals only when the hardened fs policy requires it.
  // This is critical for presets: paths are persisted, approvals are not.
  async function maybeApprovePaths(paths, options = {}) {
    const list = uniqPaths(paths);
    if (!list.length) return { ok: true, approved: [], skipped: [] };

    let needsApproval = [];
    try {
      const checks = await Promise.all(list.map(pathExists));
      needsApproval = list.filter((_, i) => !checks[i]);
    } catch {
      needsApproval = list.slice();
    }

    if (!needsApproval.length) {
      return { ok: true, approved: [], skipped: list };
    }

    if (!ipc?.invoke) {
      return {
        ok: false,
        approved: [],
        skipped: list,
        error: translate(
          'adobeUtilities.pathApprovalIpcUnavailable',
          'IPC unavailable for path approvals.'
        )
      };
    }

    try {
      const approved = await ipc.invoke('approve-paths', needsApproval, {
        title: options.title || translate('adobeUtilities.approvePathsDefaultTitle', 'Allow file access?'),
        kindHint: options.kindHint || 'auto',
        confirm: true
      });
      if (!approved) {
        return {
          ok: false,
          approved: [],
          skipped: list,
          error: translate('adobeUtilities.pathApprovalDenied', 'File access was not granted.')
        };
      }
      return { ok: true, approved: needsApproval, skipped: list.filter(p => !needsApproval.includes(p)) };
    } catch (err) {
      return { ok: false, approved: [], skipped: list, error: err?.message || String(err) };
    }
  }

  async function normalizeJobConfig(config) {
    const cfg = { ...config };
    if (Array.isArray(cfg.sources)) {
      const norm = await Promise.all(cfg.sources.map(normalizePath));
      cfg.sources = norm;
    }
    if (cfg.destination) cfg.destination = await normalizePath(cfg.destination);
    if (cfg.proxyDest) cfg.proxyDest = await normalizePath(cfg.proxyDest);
    if (cfg.backupPath) cfg.backupPath = await normalizePath(cfg.backupPath);
    // ⛔ DO NOT normalize virtual presets like the match-source FFmpeg sentinel
    if (cfg.proxyPreset && !isMatchSourcePreset(cfg.proxyPreset)) {
      cfg.proxyPreset = await normalizePath(cfg.proxyPreset);
    }
    return cfg;
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
      return {
        valid: false,
        message: translate(
          'adobeUtilities.n8nUrlMissing',
          'Please provide an n8n URL when webhook logging is enabled.'
        )
      };
    }

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return {
        valid: false,
        message: translate(
          'adobeUtilities.n8nUrlInvalid',
          'Invalid n8n URL. Please use a full http/https address.'
        )
      };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        valid: false,
        message: translate(
          'adobeUtilities.n8nUrlProtocol',
          'n8n URL must start with http:// or https://.'
        )
      };
    }

    const hostname = String(parsed.hostname || '').trim();
    if (!hostname) {
      return {
        valid: false,
        message: translate(
          'adobeUtilities.n8nUrlHostnameMissing',
          'Invalid n8n URL. Please include a hostname.'
        )
      };
    }

    if (!allowPrivate && isPrivateAddress(hostname)) {
      return {
        valid: false,
        message: translate(
          'adobeUtilities.n8nUrlPrivateDisallowed',
          'n8n URL cannot target localhost or private networks unless private targets are explicitly allowed.'
        )
      };
    }

    return { valid: true, url: trimmed };
  }

  el.startBtn?.addEventListener('click', async () => {
    hideAdobeToast();
    // If paths were restored from a preset/config file, they are not automatically
    // "approved" under the hardened filesystem policy. Prompt only when needed.
    const srcApproval = await maybeApprovePaths(state.sources, {
      title: translate(
        'adobeUtilities.approveSourcePathsTitle',
        'Allow file access to the selected source paths?'
      ),
      kindHint: 'auto'
    });
    if (srcApproval?.ok === false) {
      const msg =
        srcApproval.error ||
        translate('adobeUtilities.approveSourcePathsFailed', 'Unable to approve source paths.');
      setUILog(`❌ ${msg}`, { isError: true });
      showAdobeToast(msg, { persistent: true, isError: true });
      return;
    }

    // Ensure we have a fresh expansion before queuing the job
    const expansion = await expandSourcePaths(state.sources, { showLoading: true });
    if (!expansion) return;

    if (expansion.timedOut) {
      const message = translate(
        'adobeUtilities.sourceScanTimeout',
        'Source scan timed out. Please narrow your selection and try again.'
      );
      setUILog(`⚠️ ${message}`);
      showAdobeToast(message, { persistent: true, isError: true });
      return;
    }

    if (expansion.truncated) {
      const proceed = await confirmAdobeAction({
        title: translate('adobeUtilities.confirmDialogTitle'),
        message: translate(
          'adobeUtilities.sourceScanTruncatedConfirm',
          'Source scanning hit the file limit. Proceed with the truncated file list?'
        ),
        okLabel: translate('adobeUtilities.proceedButtonLabel'),
        cancelLabel: translate('adobeUtilities.cancelButtonLabel'),
        type: 'warning'
      });
      if (!proceed) return;
    }

    const raw = gatherConfig();
    const config = await normalizeJobConfig(raw);

    const requiresPremiere =
      config.importPremiere || config.createBins || config.generateProxies;
    if (requiresPremiere) {
      const message = translate(
        'adobeUtilities.premiereConnectionRequired',
        'Adobe Automate requires the Premiere CEP panel to be connected for import/bins/proxies.'
      );
      if (!lastConnectionState?.premiere) {
        await ensureBridgeHeartbeat();
      }
      if (isCEP && window.csInterface && !lastConnectionState?.premiere) {
        const connected = await ensurePremiereConnected();
        if (connected) {
          lastConnectionState = {
            ...(lastConnectionState || {}),
            premiere: true
          };
        }
      }
      if (!lastConnectionState?.premiere) {
        setUILog(`❌ ${message}`, { isError: true });
        showAdobeToast(message, { persistent: true, isError: true });
        return;
      }
    }

    if (!Array.isArray(config.sources) || config.sources.length === 0) {
      const message = translate(
        'adobeUtilities.noSourceFilesSelected',
        'No Source Files Selected'
      );
      setUILog(message, { isError: true });
      showAdobeToast(message, { persistent: true, isError: true });
      focusAdobeElement(el.srcBtn);
      return;
    }

    const failValidation = message => {
      setUILog(`❌ ${message}`, { isError: true });
      showAdobeToast(message, { persistent: true, isError: true });
    };

    const getBasename = filePath => {
      const normalized = String(filePath || '');
      return normalized.split(/[\\/]/).pop() || '';
    };

    const getProxyOutputExtension = presetPath => {
      if (!presetPath || isMatchSourcePreset(presetPath)) return 'mov';
      if (!window.electron?.readTextFile) return 'mov';
      try {
        const presetXml = window.electron.readTextFile(presetPath, 'utf8');
        const extMatch =
          /<FileExt>([^<]+)<\/FileExt>/i.exec(presetXml) ||
          /<FileExtension>([^<]+)<\/FileExtension>/i.exec(presetXml);
        if (extMatch && extMatch[1]) {
          const ext = extMatch[1].replace(/^\./, '').trim();
          if (ext) return ext;
        }
      } catch {
        // ignore preset parsing errors and fall back to default
      }
      return 'mov';
    };

    const collectBasenameCollisions = sources => {
      const baseMap = new Map();
      sources.forEach(src => {
        const base = getBasename(src);
        if (!base) return;
        if (!baseMap.has(base)) baseMap.set(base, []);
        baseMap.get(base).push(src);
      });
      return Array.from(baseMap.entries())
        .filter(([, list]) => list.length > 1)
        .map(([basename, sourcesList]) => ({
          basename,
          sources: sourcesList
        }));
    };

    const formatCollisionMessage = (label, targetPath, collisions) => {
      if (!collisions.length) return '';
      const details = collisions
        .map(({ basename, sources }) => `• ${basename}\n  ${sources.join('\n  ')}`)
        .join('\n');
      if (targetPath) {
        return translate(
          'adobeUtilities.collisionMessageWithTarget',
          '{{label}} filename collision(s) detected ({{targetPath}}). Multiple sources map to the same basename:\n{{details}}',
          { label, targetPath, details }
        );
      }
      return translate(
        'adobeUtilities.collisionMessage',
        '{{label}} filename collision(s) detected. Multiple sources map to the same basename:\n{{details}}',
        { label, details }
      );
    };

    if (config.enableN8N) {
      const n8nValidation = validateN8nUrl(config.n8nUrl, {
        allowPrivate: config.n8nAllowPrivate
      });
      if (!n8nValidation.valid) {
        failValidation(
          n8nValidation.message ||
            translate('adobeUtilities.n8nUrlInvalidGeneric', 'Invalid n8n URL.')
        );
        return;
      }
    }

    const backupEnabled = !!(config.backup || config.dualCopy);
    const backupPath = typeof config.backupPath === 'string' ? config.backupPath.trim() : '';

    if (backupEnabled) {
      if (!backupPath) {
        failValidation(
          translate(
            'adobeUtilities.backupPathRequired',
            'Backup path is required when backup is enabled.'
          )
        );
        return;
      }
      const backupApproval = await maybeApprovePaths(backupPath, {
        title: translate(
          'adobeUtilities.approveBackupDestinationTitle',
          'Allow file access to the backup destination?'
        ),
        kindHint: 'dir'
      });
      if (backupApproval?.ok === false) {
        failValidation(
          backupApproval.error ||
            translate(
              'adobeUtilities.approveBackupDestinationFailed',
              'Unable to approve backup destination.'
            )
        );
        return;
      }
      if (!(await pathExists(backupPath))) {
        failValidation(
          translate('adobeUtilities.backupFolderNotFound', 'Backup folder not found: {{path}}', {
            path: backupPath
          })
        );
        return;
      }
    }

    const isBackupOnly =
      backupEnabled &&
      !!backupPath &&
      !config.destination &&
      !config.importPremiere &&
      !config.createBins &&
      !config.generateProxies;

    if (!config.destination && !isBackupOnly) {
      failValidation(
        translate('adobeUtilities.destinationPathRequired', 'Destination path is required.')
      );
      return;
    }

    if (config.destination) {
      const destApproval = await maybeApprovePaths(config.destination, {
        title: translate(
          'adobeUtilities.approveDestinationTitle',
          'Allow file access to the destination folder?'
        ),
        kindHint: 'dir'
      });
      if (destApproval?.ok === false) {
        failValidation(
          destApproval.error ||
            translate(
              'adobeUtilities.approveDestinationFailed',
              'Unable to approve destination folder.'
            )
        );
        return;
      }

      if (!(await pathExists(config.destination))) {
        failValidation(
          translate(
            'adobeUtilities.destinationFolderNotFound',
            'Destination folder not found: {{path}}',
            { path: config.destination }
          )
        );
        return;
      }
    }

    if (config.generateProxies) {
      if (!config.proxyDest && !config.destination) {
        failValidation(
          translate(
            'adobeUtilities.proxyDestinationRequired',
            'Proxy destination is required when generating proxies.'
          )
        );
        return;
      }

      if (config.proxyDest) {
        const proxyDestApproval = await maybeApprovePaths(config.proxyDest, {
          title: translate(
            'adobeUtilities.approveProxyDestinationTitle',
            'Allow file access to the proxy destination?'
          ),
          kindHint: 'dir'
        });
        if (proxyDestApproval?.ok === false) {
          failValidation(
            proxyDestApproval.error ||
              translate(
                'adobeUtilities.approveProxyDestinationFailed',
                'Unable to approve proxy destination.'
              )
          );
          return;
        }

        if (!(await pathExists(config.proxyDest))) {
          failValidation(
            translate(
              'adobeUtilities.proxyDestinationNotFound',
              'Proxy destination folder not found: {{path}}',
              { path: config.proxyDest }
            )
          );
          return;
        }
      }

      if (config.proxyPreset && !isMatchSourcePreset(config.proxyPreset)) {
        const proxyPresetApproval = await maybeApprovePaths(config.proxyPreset, {
          title: translate(
            'adobeUtilities.approveProxyPresetTitle',
            'Allow file access to the proxy preset (.epr) file?'
          ),
          kindHint: 'file'
        });
        if (proxyPresetApproval?.ok === false) {
          failValidation(
            proxyPresetApproval.error ||
              translate(
                'adobeUtilities.approveProxyPresetFailed',
                'Unable to approve proxy preset file.'
              )
          );
          return;
        }
      }
    }

    const collisionMessages = [];
    if (config.destination) {
      const destCollisions = collectBasenameCollisions(config.sources || []);
      const message = formatCollisionMessage(
        translate('adobeUtilities.destinationCollisionTitle', 'Destination'),
        config.destination,
        destCollisions
      );
      if (message) collisionMessages.push(message);
    }

    if (backupEnabled && backupPath) {
      const backupCollisions = collectBasenameCollisions(config.sources || []);
      const message = formatCollisionMessage(
        translate('adobeUtilities.backupCollisionTitle', 'Backup'),
        backupPath,
        backupCollisions
      );
      if (message) collisionMessages.push(message);
    }

    if (config.generateProxies) {
      const proxyTarget = config.proxyDest || config.destination;
      if (proxyTarget) {
        const proxyExt = getProxyOutputExtension(config.proxyPreset);
        const proxyOutputs = (config.sources || [])
          .map(src => {
            const base = getBasename(src).replace(/\.[^/.]+$/, '');
            if (!base) return '';
            if (window.electron?.joinPath) {
              return window.electron.joinPath(proxyTarget, `${base}_Proxy.${proxyExt}`);
            }
            const trimmedTarget = String(proxyTarget || '').replace(/[\\/]+$/, '');
            return `${trimmedTarget}/${base}_Proxy.${proxyExt}`;
          })
          .filter(Boolean);
        const proxyCollisions = collectBasenameCollisions(proxyOutputs);
        const message = formatCollisionMessage(
          translate('adobeUtilities.proxyCollisionTitle', 'Proxy'),
          proxyTarget,
          proxyCollisions
        );
        if (message) collisionMessages.push(message);
      }
    }

    if (collisionMessages.length) {
      failValidation(collisionMessages.join('\n\n'));
      return;
    }

    // 🧩 Simplified logic — let backend handle import + proxy sequencing.
    // Never send premiereImportOnly from the renderer.
    if (config.premiereImportOnly) {
      delete config.premiereImportOnly;
    }
    debugLog('⚙️ premiereImportOnly removed — backend controls import sequence.');

    // Snapshot the submitted config so progress/UI can reason about stage order
    submittedJobConfig = { ...config };

    try {
      const jobId = await ipc?.invoke?.('queue-add-adobe', { config });
      if (!jobId) {
        const message = translate(
          'adobeUtilities.queueAddFailed',
          'Failed to queue Adobe Automate job.'
        );
        setUILog(`❌ ${message}`, { isError: true });
        showAdobeToast(message, { persistent: true, isError: true });
        return;
      }
      __adobeJobCompleted = false; // starting a new job
      isCancelling = false;
      currentJobId = jobId;
      clearFinalized(currentJobKeyFrom({ id: jobId }));
      currentJobStage = 'initializing';
      state.currentJobId = currentJobId;
      state.currentJobStage = currentJobStage;
      setAdobeAutomateControlsDisabled(true);
      if (el.cancelBtn) el.cancelBtn.disabled = false;
      setUILog(
        translate(
          'adobeUtilities.jobStartedWithId',
          '🚀 Adobe Automate job started (ID: {{jobId}})',
          { jobId }
        )
      );

      // ✅ Keep everything visible during the job — don’t reset until the end
      if (el.jobPreviewBox) {
        delete el.jobPreviewBox.dataset.joblogVisible;
      }
    } catch (err) {
      const message = translate(
        'adobeUtilities.jobStartUnexpectedError',
        '❌ {{error}}',
        { error: err.message }
      );
      setUILog(message, { isError: true });
      showAdobeToast(message, { persistent: true, isError: true });
    }
  });

  el.cancelBtn?.addEventListener('click', async () => {
    // No active job or already cancelling.
    if (!currentJobId || isCancelling) return;
    const confirmed = await confirmAdobeAction({
      title: translate('adobeUtilities.confirmDialogTitle'),
      message: translate(
        'adobeAutomateCancelConfirm',
        'Cancel the current Adobe Automate job?'
      ),
      okLabel: translate('adobeUtilities.cancelJobButtonLabel'),
      cancelLabel: translate('adobeUtilities.keepRunningButtonLabel'),
      type: 'warning'
    });
    if (!confirmed) return;

    try {
      isCancelling = true;
      if (el.cancelBtn) el.cancelBtn.disabled = true;
      setUILog(
        translate(
          'adobeAutomateCancelRequestPending',
          '🛑 Cancel requested… waiting for confirmation from backend.'
        )
      );

      const res = await ipc?.invoke?.('queue-cancel-job', currentJobId);
      const normalizedStatus = (
        res && typeof res === 'object'
          ? res.status || res.code || res.result
          : ''
      )
        .toString()
        .trim()
        .toLowerCase();
      const backendDetail = (
        typeof res === 'string'
          ? res
          : res && typeof res === 'object'
            ? res.message || res.detail || res.error
            : ''
      )
        .toString()
        .trim();

      let logMessage = translate(
        'adobeAutomateCancelRequestDefault',
        'Cancel requested.'
      );

      if (
        normalizedStatus === 'already-cancelled' ||
        normalizedStatus === 'already_cancelled' ||
        normalizedStatus === 'already-canceled' ||
        normalizedStatus === 'already_canceled'
      ) {
        logMessage = translate(
          'adobeAutomateCancelAlreadyCancelled',
          'This job was already cancelled.'
        );
      } else if (
        normalizedStatus === 'not-found' ||
        normalizedStatus === 'not_found' ||
        normalizedStatus === 'missing' ||
        normalizedStatus === 'unknown-job'
      ) {
        logMessage = translate(
          'adobeAutomateCancelJobNotFound',
          'No matching job was found to cancel.'
        );
      }

      const detailSuffix = backendDetail
        ? ` ${translate('adobeAutomateCancelBackendDetail', '(details: {{detail}})', {
            detail: backendDetail
          })}`
        : '';

      // Keep the panel locked and progress visible; final reset happens on queue-job-cancelled/complete.
      setUILog(`🛑 ${logMessage}${detailSuffix}`);
    } catch (err) {
      isCancelling = false;
      if (el.cancelBtn) el.cancelBtn.disabled = false;
      setUILog(
        translate(
          'adobeAutomateCancelFailed',
          '❌ Cancel failed: {{error}}',
          {
            error: err?.message || err
          }
        )
      );
    }
  });

  ipc?.on('premiere-import-media', (_e, paths) => {
    if (window.csInterface) {
      safeEvalScript(window.csInterface, 'LEADAE_importMedia', paths);
    }
  });

  ipc?.on('premiere-create-bins', (_e, bins) => {
    if (window.csInterface) {
      safeEvalScript(window.csInterface, 'LEADAE_createBins', bins);
    }
  });

  // (Removed) Proxy attaches are routed exclusively via the CEP bridge to avoid duplicate events.

  // === PROGRESS + CEP STATUS HANDLER ===
  function resetAdobeAutomatePanelUI() {
    setAdobeAutomateControlsDisabled(false);
    try {
      const bar = document.getElementById('adobe-progress');
      const out = document.querySelector('output[for="adobe-progress"]');

      if (bar) { bar.value = 0; bar.style.display = 'none'; }
      if (out) out.value = '';

      const etaEl = document.getElementById('adobe-eta-inline');
      if (etaEl) etaEl.textContent = '';

      // CSS keeps these slots hidden until .is-active is applied.
      setAdobeInlineProgressActive(false);
      hideAdobeHamster();

      // clear checklist lines for the CEP-mirrored feed
      const list = document.getElementById('cep-task-list');
      if (list) {
        list.innerHTML = '';
        list.style.display = 'none';
      }
      setAdobeTextOnlyScanStatus('');
      console.log('✅ Adobe Automate job finished — panel reset, hamster stopped.');
    } catch (err) {
      console.error('❌ Failed to reset Adobe Automate panel:', err);
    }
  }

  function setAdobeInlineProgressActive(active) {
    const host = document.getElementById('loader-inline');
    if (!host) return;
    host.classList.toggle('is-active', !!active);
    host.setAttribute('aria-hidden', active ? 'false' : 'true');
  }

  function ensureAdobeEtaInline() {
    const host = document.getElementById('loader-inline');
    if (!host) return null;
    let eta = document.getElementById('adobe-eta-inline');
    if (!eta) {
      eta = document.createElement('span');
      eta.id = 'adobe-eta-inline';
      eta.className = 'eta-inline';
      host.appendChild(eta);
    }
    return eta;
  }

  // ─────────────────────────────────────────────────────────────
  // Adobe Automate: text-only mid-row scanner status (Importing / Proxies)
  // ─────────────────────────────────────────────────────────────
  function ensureAdobeStageLine() {
    const lane = document.getElementById('loader-inline');
    if (!lane) return null;
    let el = lane.querySelector('.adobe-stage-line');
    if (!el) {
      el = document.createElement('span');
      el.className = 'eta-inline adobe-stage-line';
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      lane.appendChild(el);
    }
    return el;
  }

  function setAdobeTextOnlyScanStatus(message, { animate = true } = {}) {
    const lane = document.getElementById('loader-inline');
    const el = ensureAdobeStageLine();
    if (!lane || !el) return;

    const msg = String(message ?? '').trim();
    if (!msg) {
      // Clear
      el.classList.remove('lae-scan-text');
      el.removeAttribute('data-scan-text');
      el.textContent = '';
      lane.classList.remove('is-text-only');
      return;
    }

    // Show text-only lane
    lane.classList.add('is-active');
    lane.classList.add('is-text-only');

    // Animated scanner (active phases) vs static text (done/error/cancelled)
    if (animate) {
      el.classList.add('lae-scan-text');
      el.setAttribute('data-scan-text', msg);
    } else {
      el.classList.remove('lae-scan-text');
      el.removeAttribute('data-scan-text');
    }

    // Always set real text for accessibility.
    el.textContent = msg;
  }

  function showAdobeHamster() {
    const status = document.getElementById('cep-job-status');
    if (!status) return;
    // Some builds still have CSS that sets #cep-job-status { display:none; }
    // Force a real display value so .is-active (visibility/opacity) can work.
    status.style.display = 'flex';
    status.classList.add('is-active');
    status.setAttribute('aria-hidden', 'false');
    let wheel = status.querySelector('.wheel-and-hamster');
    if (!wheel) {
      wheel = document.createElement('div');
      wheel.className = 'wheel-and-hamster';
      status.appendChild(wheel);
    }
    ensureHamsterStructure(wheel);
    status.dataset.jobActive = 'true';
  }

  function hideAdobeHamster() {
    const status = document.getElementById('cep-job-status');
    if (!status) return;
    delete status.dataset.jobActive;
    // Keep slot reserved; hiding is handled by removing .is-active.
    status.style.display = 'flex';
    status.classList.remove('is-active');
    status.setAttribute('aria-hidden', 'true');
    const wheel = status.querySelector('.wheel-and-hamster');
    if (wheel) wheel.innerHTML = '';
  }

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

  let currentStageKey = null;
  let currentStageState = null;
  let isInitializingStageMessage = false;

  function refreshAdobeStageLocalization() {
    const stageLineVisible = !!document.querySelector('#loader-inline .adobe-stage-line');
    if (!stageLineVisible) return;

    if (currentStageKey) {
      upsertStageFeed(currentStageKey, currentStageState || 'active');
      return;
    }

    if (isInitializingStageMessage || currentJobStage === 'initializing') {
      setAdobeTextOnlyScanStatus(
        translate('adobeUtilities.initializing', 'Initializing...'),
        { animate: true }
      );
    }
  }

  if (!window.__LEADAE_ADOBE_UTILS_STAGE_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_STAGE_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try { refreshAdobeStageLocalization(); } catch {}
    });
  }

  function clearStageFeed() {
    const list = document.getElementById('cep-task-list');
    if (list) {
      list.innerHTML = '';
      list.style.display = 'none';
    }
    setAdobeTextOnlyScanStatus('');
    currentStageKey = null;
    currentStageState = null;
    isInitializingStageMessage = false;
  }

  // ✅ Single-line, no-emoji status that REPLACES the progress bar
  function upsertStageFeed(stage, state = 'active', _stageLabel) {
    setAdobeInlineProgressActive(true);
    const loader = document.getElementById('loader-inline');
    if (!loader) return;
    const line = ensureAdobeStageLine();
    if (!line) return;
    const map = {
      import: {
        active: translate('adobeUtilities.stage.import.active', 'Importing media…'),
        done: translate('adobeUtilities.stage.import.done', 'Import complete'),
        error: translate('adobeUtilities.stage.import.error', 'Import failed'),
        cancelled: translate('adobeUtilities.stage.import.cancelled', 'Import cancelled')
      },
      bins: {
        active: translate('adobeUtilities.stage.bins.active', 'Creating bins…'),
        done: translate('adobeUtilities.stage.bins.done', 'Bins created'),
        error: translate('adobeUtilities.stage.bins.error', 'Bins failed'),
        cancelled: translate('adobeUtilities.stage.bins.cancelled', 'Bins cancelled')
      },
      proxies: {
        active: translate('adobeUtilities.stage.proxies.active', 'Generating proxies…'),
        done: translate('adobeUtilities.stage.proxies.done', 'Proxies complete'),
        error: translate('adobeUtilities.stage.proxies.error', 'Proxies failed'),
        cancelled: translate('adobeUtilities.stage.proxies.cancelled', 'Proxies cancelled')
      },
      attach: {
        active: translate('adobeUtilities.stage.attach.active', 'Attaching proxies…'),
        done: translate('adobeUtilities.stage.attach.done', 'Attach complete'),
        error: translate('adobeUtilities.stage.attach.error', 'Attach failed'),
        cancelled: translate('adobeUtilities.stage.attach.cancelled', 'Attach cancelled')
      },
      complete: {
        active: translate('adobeUtilities.stage.complete.active', 'Adobe Automate…'),
        done: translate('adobeUtilities.stage.complete.done', 'Adobe Automate complete'),
        error: translate('adobeUtilities.stage.complete.error', 'Adobe Automate failed'),
        cancelled: translate('adobeUtilities.stage.complete.cancelled', 'Adobe Automate cancelled')
      }
    };
    const s = (state || 'active').toLowerCase();
    currentStageKey = stage || null;
    currentStageState = s;
    isInitializingStageMessage = false;
    const stageText =
      (map[stage] && (map[stage][s] || map[stage].active)) ||
      translate('adobeUtilities.stage.defaultWorking', 'Working…');

    // Any CEP-driven stage (no progress bar) uses the unified text-only lane.
    // Animate ONLY while the stage is active; keep terminal messages static.
    setAdobeTextOnlyScanStatus(stageText, { animate: s === 'active' });

    const list = document.getElementById('cep-task-list');
    if (list) list.style.display = 'none'; // never show legacy list
  }


  // Show "Initializing..." + hamster as soon as the queue marks the job started.
  // Other panels do this on queue-job-start; Adobe Automate previously waited for queue-job-progress,
  // which creates a dead-air delay before the first copy progress tick.
  ipc?.on('queue-job-start', (_e, job) => {
    if ((job?.panel || '').toLowerCase() !== 'adobe-utilities') return;

    const jobKey = currentJobKeyFrom(job);
    const activeJobId = getActiveJobId();
    if (jobKey && activeJobId && jobKey !== activeJobId) {
      logIgnoredJobEvent('queue-job-start', jobKey, activeJobId);
      return;
    }
    if (!jobKey) {
      warnMissingJobId('queue-job-start');
      return;
    }

    // Robust to UI reloads: adopt the job ID from the start event.
    currentJobId = jobKey;
    state.currentJobId = currentJobId;

    __adobeJobCompleted = false;
    clearFinalized(jobKey);

    currentJobStage = 'initializing';
    state.currentJobStage = currentJobStage;

    setAdobeAutomateControlsDisabled(true);
    if (el.cancelBtn) el.cancelBtn.disabled = false;

    // Reset inline progress UI (no bar yet).
    const bar = document.getElementById('adobe-progress');
    const out = document.querySelector('output[for="adobe-progress"]');
    if (bar) { bar.value = 0; bar.style.display = 'none'; }
    if (out) out.value = '';

    const etaEl = document.getElementById('adobe-eta-inline');
    if (etaEl) etaEl.textContent = '';

    setAdobeInlineProgressActive(true);
    showAdobeHamster();

    // Animated scanner text (matches Ingest / Speed Test behavior).
    clearStageFeed();
    isInitializingStageMessage = true;
    setAdobeTextOnlyScanStatus(
      translate('adobeUtilities.initializing', 'Initializing...'),
      { animate: true }
    );
  });

  // progress events from queue
  ipc?.on('queue-job-progress', (_e, payload) => {
    if ((payload?.panel || '').toLowerCase() !== 'adobe-utilities') return;

    const jobKey = currentJobKeyFrom(null, payload);
    const activeJobId = getActiveJobId();
    if (jobKey && activeJobId && jobKey !== activeJobId) {
      logIgnoredJobEvent('queue-job-progress', jobKey, activeJobId);
      return;
    }
    if (!jobKey) {
      warnMissingJobId('queue-job-progress');
      return;
    }

    // 🔒 Ignore any further progress once this job is finalized
    if (__adobeJobCompleted || wasFinalized(jobKey)) {
      __adobeJobCompleted = true;
      return;
    }

    currentJobStage = payload.stage;
    state.currentJobStage = currentJobStage;

    // When the very first stage begins, clear completion latch (robust to backend restarts)
    if (((payload.stage === 'copy' || payload.stage === 'backup') && ((payload.overall ?? payload.percent ?? 0) <= 1)) || payload.stage === 'validate') {
      clearFinalized(jobKey);
      __adobeJobCompleted = false;
    }

    const bar = document.getElementById('adobe-progress');
    const cepStatus = document.getElementById('cep-job-status');
    const out = document.querySelector('output[for="adobe-progress"]');

    if (!bar || !cepStatus) return;

    // Make the reserved slots visible (CSS gates them behind .is-active).
    setAdobeInlineProgressActive(true);

    const ensureHamsterVisible = () => {
      showAdobeHamster();
    };

    // COPY ONLY — show real progress bar
    if (payload.stage === 'copy') {
      const base = (typeof payload.overall === 'number') ? payload.overall : payload.percent;
      const pct = Math.max(0, Math.min(100, Number(base) || 0));
      if (!cepStatus.dataset.jobActive || document.querySelector('#loader-inline .adobe-stage-line')) {
        clearStageFeed();
      }
      cepStatus.dataset.jobActive = 'true';

      ensureHamsterVisible();

      bar.value = pct;
      bar.style.display = pct >= 100 ? 'none' : 'block';
      if (out) {
        out.value = pct >= 100 ? '' : Math.round(pct);
      }

      if (pct >= 100) {
        bar.value = 100;
        bar.style.display = 'none';
        if (out) out.value = '';
        const cfg = submittedJobConfig || {};
        const wantsBackup = !!(cfg.backup || cfg.dualCopy) && !!String(cfg.backupPath || '').trim();
        const wantsCep = !!cfg.importPremiere || !!cfg.createBins || !!cfg.generateProxies;
        const nextStage = wantsBackup ? 'backup' : wantsCep ? 'import' : 'complete';
        // ⏱ Instantly switch: progress bar → first post-copy stage text
        upsertStageFeed(nextStage, 'active');
      }
      return;
    }

    // BACKUP — show real progress bar
    if (payload.stage === 'backup') {
      const base = (typeof payload.overall === 'number') ? payload.overall : payload.percent;
      const pct = Math.max(0, Math.min(100, Number(base) || 0));

      // If a stage-line is showing, remove it so the bar is the focus.
      if (!cepStatus.dataset.jobActive || document.querySelector('#loader-inline .adobe-stage-line')) {
        clearStageFeed();
      }
      cepStatus.dataset.jobActive = 'true';

      ensureHamsterVisible();

      bar.value = pct;
      bar.style.display = pct >= 100 ? 'none' : 'block';
      if (out) {
        out.value = pct >= 100 ? '' : Math.round(pct);
      }

      if (pct >= 100) {
        bar.value = 100;
        bar.style.display = 'none';
        if (out) out.value = '';

        const cfg = submittedJobConfig || {};
        const wantsCep = !!cfg.importPremiere || !!cfg.createBins || !!cfg.generateProxies;
        const nextStage = wantsCep ? 'import' : 'complete';

        upsertStageFeed(nextStage, 'active');
      }
      return;
    }

    // PROXIES via FFmpeg — show real progress bar + % + ETA (like Transcode)
    if (payload.stage === 'proxies' && (payload.origin === 'ffmpeg' || payload.engine === 'ffmpeg')) {
      const base = (typeof payload.overall === 'number') ? payload.overall : payload.percent;
      const pct = Math.max(0, Math.min(100, Number(base) || 0));

      if (!cepStatus.dataset.jobActive || document.querySelector('#loader-inline .adobe-stage-line')) {
        clearStageFeed();
      }
      cepStatus.dataset.jobActive = 'true';
      ensureHamsterVisible();

      bar.value = pct;
      bar.style.display = pct >= 100 ? 'none' : 'block';
      if (out) out.value = pct >= 100 ? '' : Math.round(pct);

      const etaEl = ensureAdobeEtaInline();
      if (etaEl) {
        const showEta = pct < 100 && payload.eta;
        etaEl.textContent = showEta
          ? translate('adobeUtilities.etaInline', ' • ETA {{eta}}', { eta: payload.eta })
          : '';
      }

      if (pct >= 100) {
        if (etaEl) etaEl.textContent = '';
        const cfg = submittedJobConfig || {};
        const wantsAttach = !!cfg.importPremiere || !!cfg.createBins || !!cfg.generateProxies;
        const nextStage = wantsAttach ? 'attach' : 'complete';
        upsertStageFeed(nextStage, 'active');
      }
      return;
    }

    // ✅ CEP STAGES — update sequential feed entries
    if (['bins', 'import', 'proxies', 'attach', 'complete'].includes(payload.stage)) {
      if (!cepStatus.dataset.jobActive) {
        clearStageFeed();
        cepStatus.dataset.jobActive = 'true';
      }

      ensureHamsterVisible();

      const statusRaw = (payload.status || '').toLowerCase();
      let normalized = 'active';
      if (['error', 'failed'].includes(statusRaw)) {
        normalized = 'error';
      } else if (['complete', 'done', 'success'].includes(statusRaw)) {
        normalized = 'done';
      } else if (payload.stage === 'complete' && Number(payload.overall ?? payload.percent) >= 100) {
        normalized = 'done';
      }

      if (normalized === 'active' && currentStageKey && currentStageKey !== payload.stage) {
        upsertStageFeed(currentStageKey, 'done');
      }

      if (normalized === 'active') {
        currentStageKey = payload.stage;
        currentStageState = normalized;
        isInitializingStageMessage = false;
      } else if (normalized === 'done') {
        if (currentStageKey && currentStageKey !== payload.stage) {
          upsertStageFeed(currentStageKey, 'done');
        }
        currentStageKey = null;
        currentStageState = null;
      }

      upsertStageFeed(payload.stage, normalized);

      /**
       * 🧩 Fix — Do NOT finalize here.
       *  This "complete" often comes from import-only or AME init steps.
       *  Wait for the backend queue-job-complete event before resetting the panel.
       */
      if (payload.stage === 'complete' && normalized === 'done') {
        console.log('⚙️ Stage=complete progress received — deferring reset until backend complete.');
        __adobeJobCompleted = false;
      }
    }
  });

  // when complete
  function buildJobLogText(job, title) {
    const result = job?.result ?? {};
    let lines = Array.isArray(result.log) ? result.log : null;
    if (!lines && Array.isArray(result.logSummary)) {
      lines = result.logSummary;
    }
    if (!lines && typeof result.log === 'string') {
      lines = [result.log];
    }
    const logBody = lines
      ? lines.join('\n')
      : translate('adobeUtilities.jobComplete.noLogEntries', 'No log entries were returned.');
    const truncatedNote = result.logTruncated
      ? `\n\n${translate('adobeUtilities.jobComplete.truncatedSummary', '(Showing truncated log summary.)')}`
      : '';
    return `${title}\n──────────────────────────────\n${logBody}${truncatedNote}`;
  }

ipc?.on('queue-job-complete', (_e, job) => {
  if ((job?.panel || '').toLowerCase() !== 'adobe-utilities') return;
  const jobKey = currentJobKeyFrom(job);
  const activeJobId = getActiveJobId();
  if (jobKey && activeJobId && jobKey !== activeJobId) {
    logIgnoredJobEvent('queue-job-complete', jobKey, activeJobId);
    return;
  }
  if (!jobKey) {
    warnMissingJobId('queue-job-complete');
    return;
  }

  // OLD behavior: finalize immediately on completion (no origin/wantsProxies gating)
  markFinalized(jobKey);

  resetAdobeAutomatePanelUI();
  resetAdobeFields();

  isCancelling = false;
  currentJobId = null;
  currentJobStage = null;
  state.currentJobId = null;
  state.currentJobStage = null;

  if (el.cancelBtn) el.cancelBtn.disabled = true;

  // Summary: write the backend log summary into the Adobe log window (not the Job Preview box).
  const summaryText = buildJobLogText(
        job,
        translate(
          'adobeUtilities.jobCompleteSummaryTitle',
          '✅ Job Completed — Log Summary...'
        )
      );
  if (el.logWindow) {
    el.logWindow.textContent = summaryText;
    try { el.logWindow.scrollTop = el.logWindow.scrollHeight; } catch {}
  }
});

  ipc?.on('queue-job-failed', (_e, job) => {
    if ((job?.panel || '').toLowerCase() !== 'adobe-utilities') return;
    const jobKey = currentJobKeyFrom(job);
    const activeJobId = getActiveJobId();
    if (jobKey && activeJobId && jobKey !== activeJobId) {
      logIgnoredJobEvent('queue-job-failed', jobKey, activeJobId);
      return;
    }
    if (!jobKey) {
      warnMissingJobId('queue-job-failed');
      return;
    }
    markFinalized(jobKey);
    __adobeJobCompleted = true;
    currentJobId = null;
    currentJobStage = null;
    state.currentJobId = currentJobId;
    state.currentJobStage = currentJobStage;
    if (el.cancelBtn) el.cancelBtn.disabled = true;
    currentStageKey = null;
    currentStageState = null;
    isInitializingStageMessage = false;
    resetAdobeAutomatePanelUI();
    resetAdobeFields();

    hideAdobeHamster();
    upsertStageFeed('complete', 'error');

    // ❌ Sticky log for failures
    // Summary: write the backend log summary into the Adobe log window (not the Job Preview box).
    const summaryText = buildJobLogText(
        job,
        translate('adobeUtilities.jobCompleteFailedSummaryTitle', '❌ Job Ended — Log Summary:')
      );
    if (el.logWindow) {
      el.logWindow.textContent = summaryText;
      try { el.logWindow.scrollTop = el.logWindow.scrollHeight; } catch {}
    }
  });

  ipc?.on('queue-job-cancelled', (_e, job) => {
    if ((job?.panel || '').toLowerCase() !== 'adobe-utilities') return;
    const jobKey = currentJobKeyFrom(job);
    const activeJobId = getActiveJobId();
    if (jobKey && activeJobId && jobKey !== activeJobId) {
      logIgnoredJobEvent('queue-job-cancelled', jobKey, activeJobId);
      return;
    }
    if (!jobKey) {
      warnMissingJobId('queue-job-cancelled');
      return;
    }
    markFinalized(jobKey);
    __adobeJobCompleted = true;
    isCancelling = false;
    currentJobId = null;
    currentJobStage = null;
    state.currentJobId = currentJobId;
    state.currentJobStage = currentJobStage;
    if (el.cancelBtn) el.cancelBtn.disabled = true;
    currentStageKey = null;
    currentStageState = null;
    isInitializingStageMessage = false;
    resetAdobeAutomatePanelUI();
    resetAdobeFields();

    hideAdobeHamster();
    upsertStageFeed('complete', 'cancelled');

    // 🛑 Sticky log for cancelled jobs
    // Summary: write the backend log summary into the Adobe log window (not the Job Preview box).
    const summaryText = buildJobLogText(
        job,
        translate('adobeUtilities.jobCompleteFailedSummaryTitle', '❌ Job Ended — Log Summary:')
      );
    if (el.logWindow) {
      el.logWindow.textContent = summaryText;
      try { el.logWindow.scrollTop = el.logWindow.scrollHeight; } catch {}
    }
  });

  function sendProxyJob(config) {
    if (typeof ipc?.invoke !== 'function') {
      panelDebug('⚠️ Electron IPC unavailable — cannot queue Adobe job.');
      return;
    }

    ipc
      .invoke('queue-add-adobe', { config })
      .then(jobId => {
        panelDebug(
          `📤 queued Adobe job via Electron main${jobId ? ` (ID: ${jobId})` : ''}`
        );
      })
      .catch(err => {
        panelDebug(
          `⚠️ Failed to queue Adobe job via Electron main: ${err?.message || err}`
        );
      });
  }

  function onProxyPresetChange() {
    const value = el.proxyPreset?.value || '';
    debugLog(`Preset changed to: ${value}`);
    if (isMatchSourcePreset(value)) {
      debugLog(`⚙️ ${getMatchSourceLabel()} selected — AME will be bypassed.`);
    }
    updateJobPreview();
  }

  async function loadProxyPresets() {
    try {
      const mkdir = (typeof electron?.mkdirAsync === 'function')
        ? electron.mkdirAsync.bind(electron)
        : (typeof electron?.mkdir === 'function')
          ? async (p) => { electron.mkdir(p); return true; }
          : null;

      const readdir = (typeof electron?.readdirAsync === 'function')
        ? electron.readdirAsync.bind(electron)
        : (typeof electron?.readdir === 'function')
          ? async (p, o) => (electron.readdir(p, o) || [])
          : null;

      if (!mkdir || !readdir) return;

      await mkdir(proxyPresetDir);
      const files = (await readdir(proxyPresetDir)) || [];

      const hidden = document.getElementById('adobe-proxy-preset');
      if (!hidden) return;
      let current = normalizeProxyPresetValue(el.proxyPreset?.value || hidden.value || '');
      if (isMatchSourcePreset(current)) {
        current = MATCH_SOURCE_SENTINEL;
        hidden.value = MATCH_SOURCE_SENTINEL;
      }

      const opts = files
        .filter(f => f.endsWith('.epr'))
        .map(f => ({
          value: electron.joinPath(proxyPresetDir, f),
          label: `🎬 ${f.replace(/\.epr$/i, '')}`
        }));
      // Prepend the virtual Match Source option (hidden defaults live under config/presets/media-encoder/defaults).
      opts.unshift({ value: MATCH_SOURCE_SENTINEL, label: getMatchSourceLabel() });

      if (
        current &&
        current.toLowerCase().endsWith('.epr') &&
        !opts.some(o => o.value === current)
      ) {
        const f = current.split(/[\\/]/).pop();
        opts.unshift({ value: current, label: `🎬 ${f.replace(/\.epr$/i, '')}` });
      }

      setupStyledDropdown('adobe-proxy-preset', opts);
      const nextValue = current || MATCH_SOURCE_SENTINEL;
      setDropdownValue('adobe-proxy-preset', nextValue);
      hidden.value = nextValue;
      triggerPreviewUpdate();
      window.translatePage?.();

      if (!hidden.dataset.proxyChangeBound) {
        hidden.addEventListener('change', onProxyPresetChange);
        hidden.dataset.proxyChangeBound = 'true';
      }

      renderProxySettingsTooltip(proxyPresetDir);
    } catch (err) {
      console.error('❌ Could not load Adobe Media Encoder presets:', err);
    }
  }

  document
    .getElementById('refresh-proxy-presets')
    ?.addEventListener('click', loadProxyPresets);

  if (document.readyState !== 'loading') {
    loadProxyPresets();
  } else {
    document.addEventListener('DOMContentLoaded', loadProxyPresets);
  }

  // 🔄 Auto-load presets when Adobe Automate panel is opened
  document
    .querySelector('[data-panel="adobe-utilities"]')
    ?.addEventListener('click', () => {
      loadProxyPresets();
    });

  if (!window.__LEADAE_ADOBE_UTILS_PROXY_PRESETS_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_PROXY_PRESETS_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try {
        loadProxyPresets();
      } catch {}
    });
  }

  if (!window.__LEADAE_ADOBE_UTILS_TOOLTIPS_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_TOOLTIPS_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try {
        renderRequirementsTooltip();
        renderVerificationTooltip();
        renderProxySettingsTooltip(proxyPresetDir);
      } catch {}
    });
  }

  // ✅ Auto-refresh preset dropdown when presets are saved or deleted
  if (typeof ipc !== 'undefined' && ipc.on) {
    ipc.on('preset-saved', (_e, panelId) => {
      if (panelId === 'adobe-utilities') refreshPresetDropdown();
    });
    ipc.on('preset-deleted', (_e, panelId) => {
      if (panelId === 'adobe-utilities') refreshPresetDropdown();
    });
  }

  // ───────────────────────────────────────────────────────────────
  // Standalone Backup Queue (separate from ingest/import)
  // ───────────────────────────────────────────────────────────────
  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    let u = -1;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u++;
    }
    return `${v.toFixed(v >= 10 ? 1 : 2)} ${units[u]}`;
  }

  function setBackupPauseButton(paused) {
    if (!el.backupQueuePause) return;
    el.backupQueuePause.dataset.paused = paused ? 'true' : 'false';
    const labelEl = el.backupQueuePause.querySelector('.button_text') || el.backupQueuePause;
    labelEl.textContent = paused
      ? translate('adobeUtilities.backupQueueResume', 'Resume')
      : translate('adobeUtilities.backupQueuePause', 'Pause');
  }

  let backupQueueActiveJobId = null;
  let backupQueueRowMap = new Map();
  let backupQueueRenderRequested = false;
  let backupQueuePendingState = null;

  function getBackupItemKey(item, index) {
    if (!item) return `row-${index}`;
    return item.id || `${item.sourcePath || ''}|${item.destPath || ''}|${index}`;
  }

  function setBackupRowCell(td, value, isPathColumn) {
    const text = String(value || '');
    if (td.textContent !== text) td.textContent = text;
    if (td.title !== text) td.title = text;
    if (isPathColumn) {
      td.style.maxWidth = '280px';
      td.style.overflow = 'hidden';
      td.style.textOverflow = 'ellipsis';
      td.style.whiteSpace = 'nowrap';
    }
  }

  const BACKUP_QUEUE_STATUS_KEY_MAP = {
    queued: 'adobeUtilities.backupQueueDisplay.queued',
    running: 'adobeUtilities.backupQueueDisplay.running',
    paused: 'adobeUtilities.backupQueueDisplay.paused',
    completed: 'adobeUtilities.backupQueueDisplay.completed',
    failed: 'adobeUtilities.backupQueueDisplay.failed',
    cancelled: 'adobeUtilities.backupQueueDisplay.cancelled',
    canceled: 'adobeUtilities.backupQueueDisplay.cancelled',
    unknown: 'adobeUtilities.backupQueueDisplay.unknown'
  };

  function getBackupQueueStatusDisplay(statusValue) {
    const normalizedStatus = String(statusValue || 'unknown').trim().toLowerCase() || 'unknown';
    const statusKey = BACKUP_QUEUE_STATUS_KEY_MAP[normalizedStatus];
    if (statusKey) {
      return translate(statusKey, normalizedStatus);
    }
    return translate(
      'adobeUtilities.backupQueueDisplay.statusFallback',
      normalizedStatus,
      { status: normalizedStatus }
    );
  }

  function updateBackupQueueRow(tr, item, job) {
    const status = item.status || job.status || 'unknown';
    const statusDisplay = getBackupQueueStatusDisplay(status);
    const result = item.result || item.error || '';
    const verifyMode = job.verifyMode || item.verifyMode || 'none';
    const verifyModeDisplay =
      verifyMode === 'none'
        ? translate('adobeUtilities.backupQueueDisplay.none', 'None')
        : verifyMode;
    const cells = [
      statusDisplay,
      electron.basename?.(item.sourcePath || '') || '',
      formatBytes(item.sizeBytes || 0),
      item.sourcePath || '',
      item.destPath || '',
      verifyModeDisplay,
      (typeof result === 'string') ? result : '',
      (item.startedAt && item.endedAt)
        ? `${Math.round((item.endedAt - item.startedAt) / 1000)}s`
        : ''
    ];

    while (tr.children.length < cells.length) {
      tr.appendChild(document.createElement('td'));
    }

    cells.forEach((val, idx) => {
      const td = tr.children[idx];
      setBackupRowCell(td, val, idx >= 3);
    });
  }

  function createBackupQueueRow(item, job) {
    const tr = document.createElement('tr');
    updateBackupQueueRow(tr, item, job);
    return tr;
  }

  function renderBackupQueueEmptyState() {
    el.backupQueueBody.innerHTML = '';
    backupQueueRowMap.clear();
    backupQueueActiveJobId = null;

    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.style.opacity = '0.75';
    td.textContent = window.i18n.t('adobeUtilities.noBackupJobsQueued');
    tr.appendChild(td);
    el.backupQueueBody.appendChild(tr);
  }

  function renderBackupQueueState(state, { forceFull = false } = {}) {
    if (!el.backupQueueBody) return;

    const svcPaused = !!state?.paused;
    setBackupPauseButton(svcPaused);

    // Pick the active job (or first queued) for display
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    const activeId = state?.activeJobId;
    const job = jobs.find(j => j.id === activeId) || jobs[0];

    if (!job) {
      renderBackupQueueEmptyState();
      return;
    }

    const currentJobId = job.id || activeId || 'single';
    const shouldFullRender = forceFull || currentJobId !== backupQueueActiveJobId;
    backupQueueActiveJobId = currentJobId;

    const items = Array.isArray(job.items) ? job.items : [];

    if (shouldFullRender) {
      el.backupQueueBody.innerHTML = '';
      backupQueueRowMap.clear();

      for (const [index, item] of items.entries()) {
        const key = getBackupItemKey(item, index);
        const tr = createBackupQueueRow(item, job);
        backupQueueRowMap.set(key, tr);
        el.backupQueueBody.appendChild(tr);
      }
      return;
    }

    const seenKeys = new Set();
    for (const [index, item] of items.entries()) {
      const key = getBackupItemKey(item, index);
      seenKeys.add(key);
      let tr = backupQueueRowMap.get(key);
      if (!tr) {
        tr = createBackupQueueRow(item, job);
        backupQueueRowMap.set(key, tr);
        el.backupQueueBody.appendChild(tr);
        continue;
      }
      updateBackupQueueRow(tr, item, job);
    }

    for (const [key, tr] of backupQueueRowMap.entries()) {
      if (!seenKeys.has(key)) {
        tr.remove();
        backupQueueRowMap.delete(key);
      }
    }
  }

  function scheduleBackupQueueRender(state) {
    backupQueuePendingState = state;
    if (backupQueueRenderRequested) return;
    backupQueueRenderRequested = true;
    const schedule = window.requestAnimationFrame || (cb => setTimeout(cb, 16));
    schedule(() => {
      backupQueueRenderRequested = false;
      const nextState = backupQueuePendingState;
      backupQueuePendingState = null;
      renderBackupQueueState(nextState);
    });
  }

  async function refreshBackupQueueState() {
    if (!ipc?.invoke) return;
    try {
      const st = await ipc.invoke('backup-get-state');
      renderBackupQueueState(st, { forceFull: true });
    } catch (e) {
      console.warn('[backup] get-state failed:', e);
    }
  }

  function refreshBackupQueueStateForI18n() {
    if (backupQueuePendingState) {
      renderBackupQueueState(backupQueuePendingState, { forceFull: true });
      return;
    }
    refreshBackupQueueState();
  }

  if (!window.__LEADAE_ADOBE_UTILS_BACKUP_QUEUE_I18N_BOUND__ && window.i18n?.on) {
    window.__LEADAE_ADOBE_UTILS_BACKUP_QUEUE_I18N_BOUND__ = true;
    window.i18n.on('languageChanged', () => {
      try {
        refreshBackupQueueStateForI18n();
      } catch {}
    });
  }

  function buildBackupQueueActionErrorMessage(baseMessage, detail) {
    const normalizedBase = String(baseMessage || '').trim();
    const normalizedDetail = String(detail || '').trim();
    if (!normalizedDetail) return normalizedBase;
    return `${normalizedBase}\n\n${translate('adobeUtilities.errorDetailLabel', 'Details')}: ${normalizedDetail}`;
  }

  function initBackupQueueUI() {
    if (!el.backupQueueSelectDest || !ipc?.invoke) return;

    // Restore UI defaults if blank
    if (el.backupQueueMode && !el.backupQueueMode.value) el.backupQueueMode.value = 'mirror';
    if (el.backupQueueVerify && !el.backupQueueVerify.value) el.backupQueueVerify.value = 'fast';
    if (el.backupQueueCollision && !el.backupQueueCollision.value) el.backupQueueCollision.value = 'version';

    el.backupQueueMode?.addEventListener('change', () => {
      const mode = el.backupQueueMode.value;
      if (el.backupQueueTemplateRow) {
        el.backupQueueTemplateRow.style.display = (mode === 'template') ? 'flex' : 'none';
      }
    });

    el.backupQueueSelectDest.addEventListener('click', async () => {
      const res = await ipc.invoke('select-folder', {
        title: translate(
          'adobeUtilities.selectBackupDestinationTitle',
          'Select Backup Destination'
        )
      });
      if (res?.canceled) return;
      const chosen = res?.filePaths?.[0];
      if (chosen && el.backupQueueDest) el.backupQueueDest.value = chosen;
    });

    el.backupQueueAdd?.addEventListener('click', async () => {
      hideAdobeToast();
      const sources = getEffectiveSources();
      const dest = String(el.backupQueueDest?.value || '').trim();
      if (!sources.length) {
        const message = translate(
          'adobeUtilities.backupQueueNoSources',
          'No sources selected in Adobe Automate.'
        );
        setUILog(`❌ ${message}`, { isError: true });
        showAdobeToast(message, { persistent: true, isError: true });
        focusAdobeElement(el.srcBtn);
        return;
      }
      if (!dest) {
        const message = translate(
          'adobeUtilities.backupQueueDestinationRequired',
          'Select a Backup Destination first.'
        );
        setUILog(`❌ ${message}`, { isError: true });
        showAdobeToast(message, { persistent: true, isError: true });
        focusAdobeElement(el.backupQueueDest);
        return;
      }

      const mode = String(el.backupQueueMode?.value || 'mirror');
      const verifyMode = String(el.backupQueueVerify?.value || 'fast');
      const onCollision = String(el.backupQueueCollision?.value || 'version');
      const concurrency = Math.max(1, Math.min(4, parseInt(el.backupQueueConcurrency?.value || '1', 10) || 1));

      const projectName = String(el.backupQueueProject?.value || '').trim();
      const template = String(el.backupQueueTemplate?.value || '').trim();
      const writeHtml = !!el.backupQueueHtml?.checked;

      // Best-effort root for mirroring: use the selected "source root" folder if it contains the file, else dirname(file).
      const rootHint = String(el.sourceRootPath?.value || '').trim();

      const items = sources.map(p => {
        const root = (rootHint && isPathContainedInRoot(rootHint, p)) ? rootHint : (electron.dirname?.(p) || '');
        return { sourcePath: p, sourceRoot: root };
      });

      const payload = { destinationRoot: dest, mode, verifyMode, onCollision, concurrency, projectName, template, writeHtml, items };

      try {
        const res = await ipc.invoke('backup-add-job', payload);
        if (!res?.success) {
          const message = buildBackupQueueActionErrorMessage(
            translate(
              'adobeUtilities.backupQueueAddFailed',
              'Backup queue add failed. Check console/logs.'
            ),
            res?.error
          );
          setUILog(message, { isError: true });
          showAdobeToast(message, { persistent: true, isError: true });
          return;
        }
        await refreshBackupQueueState();
      } catch (e) {
        console.error('[backup] add-job failed', e);
        const message = translate(
          'adobeUtilities.backupQueueAddFailed',
          'Backup queue add failed. Check console/logs.'
        );
        setUILog(message, { isError: true });
        showAdobeToast(message, { persistent: true, isError: true });
      }
    });

    el.backupQueueRun?.addEventListener('click', async () => {
      hideAdobeToast();
      try {
        const res = await ipc.invoke('backup-run');
        if (!res?.success) {
          const message = buildBackupQueueActionErrorMessage(
            translate(
              'adobeUtilities.backupQueueRunFailed',
              'Backup queue start failed. Check console/logs.'
            ),
            res?.error
          );
          setUILog(message, { isError: true });
          showAdobeToast(message, { persistent: true, isError: true });
        }
      } catch (e) {
        console.error('[backup] run failed', e);
        const message = translate(
          'adobeUtilities.backupQueueRunFailed',
          'Backup queue start failed. Check console/logs.'
        );
        setUILog(message, { isError: true });
        showAdobeToast(message, { persistent: true, isError: true });
      }
    });

    el.backupQueuePause?.addEventListener('click', async () => {
      hideAdobeToast();
      const paused = el.backupQueuePause?.dataset.paused === 'true';
      try {
        const action = paused ? 'backup-resume' : 'backup-pause';
        const res = await ipc.invoke(action);
        if (!res?.success) {
          const message = buildBackupQueueActionErrorMessage(
            translate(
              paused ? 'adobeUtilities.backupQueueResumeFailed' : 'adobeUtilities.backupQueuePauseFailed',
              paused
                ? 'Backup queue resume failed. Check console/logs.'
                : 'Backup queue pause failed. Check console/logs.'
            ),
            res?.error
          );
          setUILog(message, { isError: true });
          showAdobeToast(message, { persistent: true, isError: true });
        }
      } catch (e) {
        console.error('[backup] pause/resume failed', e);
        const message = translate(
          paused ? 'adobeUtilities.backupQueueResumeFailed' : 'adobeUtilities.backupQueuePauseFailed',
          paused
            ? 'Backup queue resume failed. Check console/logs.'
            : 'Backup queue pause failed. Check console/logs.'
        );
        setUILog(message, { isError: true });
        showAdobeToast(message, { persistent: true, isError: true });
      }
    });

    el.backupQueueCancel?.addEventListener('click', async () => {
      try {
        await ipc.invoke('backup-cancel');
      } catch (e) {
        console.error('[backup] cancel failed', e);
      }
    });

    refreshBackupQueueState();
  }

  // Live updates from the main process
  if (typeof ipc !== 'undefined' && ipc.on) {
    ipc.on('backup-state', (_e, st) => {
      scheduleBackupQueueRender(st);
    });
  }

  initBackupQueueUI();

  window.connectToLeadAE = connectToLeadAE;
  window.sendProxyJob = sendProxyJob;

  // ───────────────────────────────────────────────────────────────
  // 🧹 Sticky Log Lifecycle: clear when user changes settings or leaves panel
  // ───────────────────────────────────────────────────────────────
  const adobePanelEl = document.getElementById('adobe-utilities');
  ['input', 'change'].forEach(evt => {
    adobePanelEl?.addEventListener(evt, e => {
      if (!el.jobPreviewBox?.dataset.joblogVisible) return;
      if (e.target === el.jobPreviewBox) return; // ignore typing/scrolling inside the preview
      // Any setting change clears sticky log and fully resets the panel
      delete el.jobPreviewBox.dataset.joblogVisible;
      resetAdobeFields();
    }, { capture: true });
  });

  document.addEventListener('toolbar-updated', e => {
    if (e.detail?.panelId !== 'adobe-utilities') {
      if (el.jobPreviewBox?.dataset.joblogVisible) {
        delete el.jobPreviewBox.dataset.joblogVisible;
        resetAdobeFields();
      }
    }
  });


if (window.panelPresetDefaults && !window.__LEAD_ADOBE_PRESET_DEFAULTS_REGISTERED__) {
  window.__LEAD_ADOBE_PRESET_DEFAULTS_REGISTERED__ = true;
  window.panelPresetDefaults.register({
    panelId: 'adobe-utilities',
    presetInputId: 'adobe-utilities-preset',
    refreshDropdown: () => refreshPresetDropdown(),
    applyPackagedDefaults: () => resetAdobeFields(),
    buildPackagedDefaultPreset: () => gatherConfig(),
    applyPreset: data => applyPreset(data)
  });
}

})();
