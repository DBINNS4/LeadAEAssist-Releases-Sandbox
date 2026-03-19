// setupStyledDropdown is provided by the shared renderer bootstrap (eslint globals).
;(async () => {

  if (typeof ipc === 'undefined') {
    var ipc = window.ipc ?? window.electron;
  }

  const PANEL_ID = 'preferences';

  const electron = window.electron;
  const preferencesApi = window.preferences;

  // Secrets are only accessible via allowlisted IPC methods.
  // SECURITY: the renderer must never receive secret values.
  const secrets = electron?.secrets;

  // Track API key state without ever loading the key into JS memory.
  let hasApiKey = false;
  let apiKeyDirty = false;
  let lastPreferencesErrorState = null;

  const defaultPreferences = {
    offlineMode: false,
    // Default ON unless explicitly disabled by the user.
    crashReporting: true,
    theme: "light",
    language: "en",
    apiKeyStored: false,
    webhookUrl: "",
    webhookLogging: false,
    webhookOnlyFail: false,
    clearTempOnStartup: false,
    clearCacheOnStartup: false,
    tempMaxAgeDays: 7,
    autoUpdateCheckOnLaunch: true,
    autoUpdateAutoDownload: false
  };

  // Utility: Read and Write Preferences via main-process IPC.
  async function loadPreferences() {
    if (typeof ipc?.invoke !== 'function') {
      return {
        ok: false,
        code: 'PREFS_LOAD_STORAGE_UNAVAILABLE',
        error: 'PREFS_LOAD_STORAGE_UNAVAILABLE',
        preferences: {}
      };
    }
    try {
      const result = (typeof preferencesApi?.get === 'function')
        ? await preferencesApi.get()
        : await ipc.invoke('prefs:get-preferences');
      if (!result || result.ok !== true) {
        return {
          ok: false,
          code: result?.code || 'PREFS_LOAD_FAILED',
          recoverable: result?.recoverable === true,
          error: result?.error || 'PREFS_LOAD_FAILED',
          params: result?.params,
          preferences: {}
        };
      }
      const prefs = (result.preferences && typeof result.preferences === 'object')
        ? result.preferences
        : {};
      return {
        ok: true,
        recoverable: result?.recoverable === true,
        warning: typeof result?.warning === 'string' ? result.warning : '',
        code: result?.code,
        preferences: { ...prefs }
      };
    } catch (err) {
      console.error("❌ Failed to load preferences:", err);
      return { ok: false, error: err?.message || String(err), preferences: {} };
    }
  }

  function classifyLoadIssue(loadResult) {
    const explicitRecoverable = loadResult?.recoverable === true;
    const code = String(loadResult?.code || '').toUpperCase();
    const msg = String(loadResult?.error || loadResult?.warning || '').trim();
    const recoverablePattern = /(schema|legacy|unsupported|unknown\s+key|dropped\s+key|sanitiz)/i;
    const recoverableCodePattern = /(SCHEMA|LEGACY|SANITIZ|UNSUPPORTED|UNKNOWN_KEY)/i;
    const recoverable = explicitRecoverable || recoverablePattern.test(msg) || recoverableCodePattern.test(code);
    return {
      recoverable,
      message: msg
    };
  }

  function interpolateTemplate(template, params = {}) {
    return String(template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, token) => {
      const value = params?.[token];
      return value == null ? '' : String(value);
    });
  }

  function translatePreferencesErrorCode(code, params = {}, fallbackMessage = '') {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return fallbackMessage;

    const map = {
      PREFS_PAYLOAD_NOT_OBJECT: () => translate('preferencesErrorPayloadNotObject', 'Preferences payload must be an object.'),
      PREFS_UNSUPPORTED_KEY: () => translate('preferencesErrorUnsupportedKey', 'Unsupported preference key: {{key}}.', { key: params?.key || '' }),
      PREFS_VALUE_TYPE_BOOLEAN: () => translate('preferencesErrorValueTypeBoolean', 'Preference "{{key}}" must be a boolean.', { key: params?.key || '' }),
      PREFS_VALUE_TYPE_STRING: () => translate('preferencesErrorValueTypeString', 'Preference "{{key}}" must be a string.', { key: params?.key || '' }),
      PREFS_INVALID_WEBHOOK_URL: () => translate('preferencesErrorInvalidWebhookUrl', 'Preference "webhookUrl" must be a valid http(s) URL.'),
      PREFS_INVALID_THEME: () => translate('preferencesErrorInvalidTheme', 'Preference "theme" must be one of: {{allowed}}.', { allowed: params?.allowed || 'light, dark' }),
      PREFS_INVALID_LANGUAGE: () => translate('preferencesErrorInvalidLanguage', 'Preference "language" must be one of: {{allowed}}.', { allowed: params?.allowed || 'en, es, fr, de, ja, zh' }),
      PREFS_TEMP_MAX_AGE_NOT_INTEGER: () => translate('preferencesErrorTempMaxAgeNotInteger', 'Preference "tempMaxAgeDays" must be an integer.'),
      PREFS_TEMP_MAX_AGE_OUT_OF_RANGE: () => translate(
        'preferencesErrorTempMaxAgeOutOfRange',
        'Preference "tempMaxAgeDays" must be between {{min}} and {{max}}.',
        { min: params?.min, max: params?.max }
      ),
      PREFS_LOAD_STORAGE_UNAVAILABLE: () => translate(
        'preferencesLoadStorageUnavailable',
        'Preferences storage is unavailable outside Electron.'
      ),
      PREFS_LOAD_FAILED: () => translate('preferencesLoadFailedGeneric', 'Failed to load preferences.'),
      PREFS_PERSIST_FAILED: () => translate('preferencesSavePersistFailed', 'Failed to persist preferences.')
    };

    const resolver = map[normalized];
    if (typeof resolver !== 'function') return fallbackMessage;
    return interpolateTemplate(resolver(), params);
  }

  async function savePreferences(data) {
    const SAVE_ERROR_CODES = {
      STORAGE_UNAVAILABLE: 'PREFS_SAVE_STORAGE_UNAVAILABLE',
      PERSIST_FAILED: 'PREFS_SAVE_PERSIST_FAILED'
    };

    try {
      if (typeof ipc?.invoke !== 'function') {
        const message = SAVE_ERROR_CODES.STORAGE_UNAVAILABLE;
        console.error('❌', message);
        return {
          ok: false,
          error: {
            message,
            source: 'renderer.preferences',
            code: 'PREFS_IPC_UNAVAILABLE'
          }
        };
      }

      const payload = (data && typeof data === 'object' && data.preferences && typeof data.preferences === 'object')
        ? { preferences: { ...data.preferences } }
        : { preferences: {} };

      let result = null;
      if (typeof preferencesApi?.set === 'function') {
        result = await preferencesApi.set(payload);
      } else if (typeof ipc?.invoke === 'function') {
        result = await ipc.invoke('prefs:set-preferences', payload);
      }

      if (result && result.ok === true) {
        return {
          ok: true,
          preferences: (result.preferences && typeof result.preferences === 'object')
            ? { ...result.preferences }
            : {}
        };
      }
      const message = result?.error || SAVE_ERROR_CODES.PERSIST_FAILED;
      return {
        ok: false,
        error: {
          message,
          params: result?.params,
          source: 'prefs:set-preferences',
          code: result?.code || 'PREFS_SAVE_REJECTED',
          details: result
        }
      };
    } catch (err) {
      console.error('❌ Failed to save preferences:', err);
      return {
        ok: false,
        error: {
          message: err?.message || String(err),
          source: 'prefs:set-preferences',
          code: 'PREFS_SAVE_THROWN'
        }
      };
    }
  }

  function getSaveErrorMessage(error, fallbackMessage) {
    const saveErrorCodeToTranslation = {
      PREFS_SAVE_STORAGE_UNAVAILABLE: () => translate(
        'preferencesSaveStorageUnavailable',
        'Preferences storage is unavailable outside Electron.'
      ),
      PREFS_SAVE_PERSIST_FAILED: () => translate(
        'preferencesSavePersistFailed',
        'Failed to persist preferences.'
      )
    };

    const translateSaveErrorCode = (code) => {
      const normalized = String(code || '').trim().toUpperCase();
      if (!normalized) return '';
      const resolver = saveErrorCodeToTranslation[normalized];
      return typeof resolver === 'function' ? resolver() : '';
    };

    if (typeof error === 'string' && error.trim()) {
      const translatedFromCode = translateSaveErrorCode(error);
      if (translatedFromCode) return translatedFromCode;
      return translatePreferencesErrorCode(error, {}, fallbackMessage) || fallbackMessage || error;
    }

    if (error && typeof error === 'object') {
      const translatedFromCode = translateSaveErrorCode(error.code || error.message);
      if (translatedFromCode) return translatedFromCode;
      const translatedPreferenceError = translatePreferencesErrorCode(
        error.code || error.message,
        error.params || error.details?.params,
        ''
      );
      if (translatedPreferenceError) return translatedPreferenceError;
      const message = typeof error.message === 'string' ? error.message.trim() : '';
      if (message && /^PREFS_[A-Z0-9_]+$/.test(message)) {
        return translatePreferencesErrorCode(message, error.params || error.details?.params, fallbackMessage);
      }
      if (message) return message;
    }
    return fallbackMessage || translate('preferencesSaveFailed', 'Failed to save preferences.');
  }

  async function loadApiKeyPresence() {
    try {
      if (typeof secrets?.hasAiApiKey === 'function') {
        return !!(await secrets.hasAiApiKey());
      }
      if (typeof ipc?.invoke === 'function') {
        return !!(await ipc.invoke('secure-store:has-ai-api-key'));
      }
      return false;
    } catch (err) {
      console.error('❌ Failed to check AI API key state:', err);
      return false;
    }
  }

  const API_KEY_PERSIST_ERROR_CODES = Object.freeze({
    DELETE_FAILED: 'API_KEY_PERSIST_DELETE_FAILED',
    WRITE_FAILED: 'API_KEY_PERSIST_WRITE_FAILED',
    UNKNOWN_FAILED: 'API_KEY_PERSIST_UNKNOWN_FAILED'
  });

  function normalizeApiKeyPersistErrorCode(value) {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) return '';
    if (Object.values(API_KEY_PERSIST_ERROR_CODES).includes(normalized)) {
      return normalized;
    }
    return API_KEY_PERSIST_ERROR_CODES.UNKNOWN_FAILED;
  }

  function createApiKeyPersistError(code, detail) {
    const normalizedCode = normalizeApiKeyPersistErrorCode(code);
    const err = new Error(normalizedCode || API_KEY_PERSIST_ERROR_CODES.UNKNOWN_FAILED);
    err.code = normalizedCode || API_KEY_PERSIST_ERROR_CODES.UNKNOWN_FAILED;
    if (detail) err.detail = String(detail);
    return err;
  }

  function translateApiKeyPersistErrorCode(code, fallbackKey = 'preferencesApiKeySaveFailed') {
    const map = {
      [API_KEY_PERSIST_ERROR_CODES.DELETE_FAILED]: () => translate(
        'preferencesApiKeyPersistDeleteFailed',
        'Could not remove the saved API key from secure storage.'
      ),
      [API_KEY_PERSIST_ERROR_CODES.WRITE_FAILED]: () => translate(
        'preferencesApiKeyPersistWriteFailed',
        'Could not write the API key to secure storage.'
      )
    };
    const normalized = normalizeApiKeyPersistErrorCode(code);
    const resolver = map[normalized];
    if (typeof resolver === 'function') return resolver();
    return translate(fallbackKey, 'Failed to save API key.');
  }

  async function persistApiKeyValue(value) {
    const v = String(value ?? '').trim();

    try {
      if (!v) {
        let res;
        if (typeof secrets?.deleteAiApiKey === 'function') {
          res = await secrets.deleteAiApiKey();
        } else if (typeof ipc?.invoke === 'function') {
          res = await ipc.invoke('secure-store:delete-ai-api-key');
        }
        if (res && typeof res === 'object' && res.ok === false) {
          throw createApiKeyPersistError(API_KEY_PERSIST_ERROR_CODES.DELETE_FAILED, res.error);
        }
        // Confirm real state (do not guess).
        return {
          ok: true,
          hasApiKey: await loadApiKeyPresence()
        };
      }

      let res;
      if (typeof secrets?.setAiApiKey === 'function') {
        res = await secrets.setAiApiKey(v);
      } else if (typeof ipc?.invoke === 'function') {
        res = await ipc.invoke('secure-store:set-ai-api-key', v);
      }
      if (res && typeof res === 'object' && res.ok === false) {
        throw createApiKeyPersistError(API_KEY_PERSIST_ERROR_CODES.WRITE_FAILED, res.error);
      }

      // Confirm real state (do not guess).
      return {
        ok: true,
        hasApiKey: await loadApiKeyPresence()
      };
    } catch (err) {
      console.error('❌ Failed to persist AI API key:', err);
      const normalizedErrorCode = normalizeApiKeyPersistErrorCode(err?.code || err?.message);
      // Best-effort: re-check actual state so UI stays honest.
      try {
        return {
          ok: false,
          errorCode: normalizedErrorCode,
          errorDetail: err?.detail || err?.message || String(err),
          hasApiKey: await loadApiKeyPresence()
        };
      } catch {
        return {
          ok: false,
          errorCode: normalizedErrorCode,
          errorDetail: err?.detail || err?.message || String(err),
          hasApiKey: false
        };
      }
    }
  }

  async function clearStoredApiKeyAfterReset() {
    const keyPresentBeforeDelete = await loadApiKeyPresence();
    const deleteResult = await persistApiKeyValue('');
    const keyPresentAfterDelete = !!deleteResult?.hasApiKey;

    // Keep UI state honest by checking the persisted secure-store state again.
    const confirmedPresence = await loadApiKeyPresence();
    const deleteLikelyFailed = keyPresentBeforeDelete && (keyPresentAfterDelete || confirmedPresence);

    return {
      ok: !!deleteResult?.ok && !deleteLikelyFailed,
      errorCode: deleteResult?.ok
        ? (deleteLikelyFailed ? API_KEY_PERSIST_ERROR_CODES.DELETE_FAILED : '')
        : (deleteResult?.errorCode || API_KEY_PERSIST_ERROR_CODES.DELETE_FAILED),
      errorDetail: deleteResult?.errorDetail || '',
      hasApiKey: confirmedPresence
    };
  }


  // Legacy migration is handled in the main process via secureStore.getAiApiKey()
  // when the boolean presence check runs. Keep the renderer unaware of the value.

  const el = {
    offlineMode: document.getElementById("offline-mode"),
    offlineModeWarning: document.getElementById("offline-mode-warning"),
    crashReporting: document.getElementById("crash-reporting"),
    // Adobe CEP panel installer (Premiere)
    cepStatus: document.getElementById("cep-panel-status"),
    cepError: document.getElementById("cep-panel-error"),
    cepInstallBtn: document.getElementById("cep-install-panel"),
    cepUninstallBtn: document.getElementById("cep-uninstall-panel"),
    cepOpenFolderBtn: document.getElementById("cep-open-folder"),
    language: document.getElementById("language-select"),
    apiKeyInput: document.getElementById("ai-api-key"),
    webhookUrl: document.getElementById("webhook-url"),
    webhookUrlError: document.getElementById("webhook-url-error"),
    webhookLog: document.getElementById("webhook-logging"),
    webhookFailOnly: document.getElementById("webhook-only-fail"),
    tempFolderPath: document.getElementById("temp-folder-path"),
    maintenanceStatus: document.getElementById("maintenance-status"),
    saveError: document.getElementById("preferences-save-error"),
    openTempFolderBtn: document.getElementById("open-temp-folder"),
    clearTempNowBtn: document.getElementById("clear-temp-now"),
    clearCacheNowBtn: document.getElementById("clear-cache-now"),
    clearTempOnStartup: document.getElementById("clear-temp-on-startup"),
    clearCacheOnStartup: document.getElementById("clear-cache-on-startup"),
    tempMaxAgeDays: document.getElementById("temp-max-age-days"),
    autoUpdateCheckOnLaunch: document.getElementById("auto-update-check-on-launch"),
    autoUpdateAutoDownload: document.getElementById("auto-update-auto-download"),
    checkUpdatesNowBtn: document.getElementById("check-updates-now"),
    downloadUpdateBtn: document.getElementById("download-update-now"),
    installUpdateBtn: document.getElementById("install-update-now"),
    updateStatusText: document.getElementById("update-status-text"),
    updateProgress: document.getElementById("update-download-progress"),
    resetButton: document.getElementById("reset-preferences"),
    appVersion: document.getElementById("app-version"),
    themeSelect: document.getElementById('theme-select')
  };

  // Track explicit user edits to the API key field so unrelated preference
  // changes do not accidentally delete the stored key.
  el.apiKeyInput?.addEventListener('input', () => {
    apiKeyDirty = true;
  });

  const webhookSections = Array.from(document.querySelectorAll('[data-webhook-section]'));

  function translate(key, fallback, options = {}) {
    if (window.i18n?.t) {
      return window.i18n.t(key, { defaultValue: fallback, ...options });
    }
    return fallback;
  }

  async function confirmPreferencesAction(options) {
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
      console.warn('Preferences confirm dialog bridge unavailable.');
    } catch (err) {
      console.warn('Preferences confirm dialog failed:', err?.message || err);
    }
    return false;
  }

  function updateOfflineModeWarning() {
    const warningEl = el.offlineModeWarning;
    if (!warningEl) return;

    const enabled = !!el.offlineMode?.checked;
    if (!enabled) {
      warningEl.textContent = '';
      warningEl.style.display = 'none';
      return;
    }

    warningEl.style.display = '';
    warningEl.textContent = translate(
      'offlineModeProWindowWarning',
      'Offline Mode blocks all non-local network access (localhost only). Pro licenses can run offline for up to 5 days before the app must validate your license online.'
    );
  }

  function validateWebhookUrl(value) {
    const url = value?.trim?.() || '';
    if (!url) {
      return { url, configured: false, valid: true, message: '' };
    }

    const invalidMsg = translate('webhookUrlInvalid', 'Please enter a valid webhook URL (http(s)://...)');

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { url, configured: true, valid: false, message: invalidMsg };
      }
      if (!String(parsed.hostname || '').trim()) {
        return { url, configured: true, valid: false, message: invalidMsg };
      }
      return { url, configured: true, valid: true, message: '' };
    } catch (_err) {
      return {
        url,
        configured: true,
        valid: false,
        message: invalidMsg
      };
    }
  }

  function updateWebhookValidationUI() {
    const validation = validateWebhookUrl(el.webhookUrl?.value);
    const invalid = validation.configured && !validation.valid;
    const disabled = !validation.configured || invalid;
    [el.webhookLog, el.webhookFailOnly].forEach(ctrl => {
      if (!ctrl) return;
      ctrl.disabled = disabled;
      if (disabled) ctrl.checked = false;
    });

    if (el.webhookUrlError) {
      el.webhookUrlError.textContent = invalid ? validation.message : '';
      el.webhookUrlError.hidden = !invalid;
    }

    document.body?.classList.toggle('webhook-invalid', invalid);
    return validation;
  }

  function setDropdownValue(hiddenId, value) {
    const hidden = document.getElementById(hiddenId);
    const wrapper = hidden?.closest('.dropdown-wrapper');
    const input = wrapper?.querySelector('.chosen-value');
    const list = wrapper?.querySelector('.value-list');
    const li = [...(list?.children || [])].find(l => l.dataset.value === value);
    if (li && input && hidden) {
      input.value = li.textContent;
      hidden.value = value;
    } else if (input && hidden) {
      input.value = '';
      hidden.value = value;
    }
  }

  function setupPreferencesDropdowns({ themeValue, languageValue } = {}) {
    setupStyledDropdown('theme-select', [
      { value: 'light', label: translate('lightMode', 'Light') },
      { value: 'dark', label: translate('darkMode', 'Dark') }
    ]);

    setupStyledDropdown('language-select', [
      { value: 'en', label: translate('languageEnglish', 'English (EN)') },
      { value: 'es', label: translate('languageSpanish', 'Spanish (ES)') },
      { value: 'fr', label: translate('languageFrench', 'French (FR)') },
      { value: 'de', label: translate('languageGerman', 'German (DE)') },
      { value: 'ja', label: translate('languageJapanese', 'Japanese (JA)') },
      { value: 'zh', label: translate('languageChinese', 'Chinese (ZH)') }
    ]);

    // Re-apply the current values so the visible label updates when the app language changes.
    const currentTheme = themeValue
      ?? document.getElementById('theme-select')?.value
      ?? localStorage.getItem('theme')
      ?? 'light';
    const currentLanguage = languageValue
      ?? document.getElementById('language-select')?.value
      ?? 'en';
    setDropdownValue('theme-select', currentTheme);
    setDropdownValue('language-select', currentLanguage);
  }

  setupPreferencesDropdowns();
  const toastEl = document.getElementById("prefs-toast");

  function updateWebhookVisibility() {
    const visible = !!(el.webhookLog?.checked || el.webhookFailOnly?.checked);
    webhookSections.forEach(section => {
      if (!section) return;
      if (visible) {
        section.removeAttribute('hidden');
        section.removeAttribute('aria-hidden');
      } else {
        section.setAttribute('hidden', '');
        section.setAttribute('aria-hidden', 'true');
      }
    });
    document.body?.classList.toggle('webhook-disabled', !visible);
  }

  function mirrorWebhookSettings() {
    const validation = updateWebhookValidationUI();
    const url = validation.valid && validation.configured ? validation.url : '';
    const logging = !!el.webhookLog?.checked && !!url;
    const onlyFail = !!el.webhookFailOnly?.checked && !!url;
    const enabled = url && (logging || onlyFail);
    const mappings = [
      { enable: 'adobe-enable-n8n', url: 'adobe-n8n-url', log: 'adobe-n8n-log' },
      { enable: 'enable-n8n', url: 'n8n-url', log: 'n8n-log' },
      { enable: 'transcode-enable-n8n', url: 'transcode-n8n-url', log: 'transcode-n8n-log' },
      { enable: 'transcribe-enable-n8n', url: 'transcribe-n8n-url', log: 'transcribe-n8n-log' }
    ];
    mappings.forEach(m => {
      const en = document.getElementById(m.enable);
      const ur = document.getElementById(m.url);
      const lg = document.getElementById(m.log);
      if (en) en.checked = !!enabled;
      if (ur) ur.value = url;
      if (lg) lg.checked = logging;
    });

    updateWebhookVisibility();
  }

  function showToast(msg, options = {}) {
    const persistent = !!options.persistent;
    const isError = !!options.isError;
    if (!toastEl) return;
    toastEl.textContent = String(msg ?? '');
    toastEl.classList.toggle('toast-error', isError);
    toastEl.classList.add("show");
    if (showToast._timer) clearTimeout(showToast._timer);
    if (!persistent) {
      showToast._timer = setTimeout(() => toastEl.classList.remove("show"), 2000);
    }
  }

  function clearToast() {
    if (!toastEl) return;
    if (showToast._timer) clearTimeout(showToast._timer);
    toastEl.classList.remove('show');
  }

  function setSaveError(message, { markUnsaved = false, preserveState = false } = {}) {
    const msg = String(message ?? '').trim();
    if (!preserveState) lastPreferencesErrorState = null;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.toggle('has-unsaved-changes', !!(markUnsaved && msg));
    if (el.saveError) {
      el.saveError.textContent = msg;
      el.saveError.hidden = !msg;
    }
  }

  function buildPreferencesCodeErrorState(code, params = {}, fallback = '', markUnsaved = false) {
    return {
      type: 'preferences-code',
      code: String(code || '').trim(),
      params: (params && typeof params === 'object') ? { ...params } : {},
      fallback: String(fallback || ''),
      markUnsaved: !!markUnsaved
    };
  }

  function buildSaveErrorDescriptor(error, fallback = '', markUnsaved = true) {
    if (typeof error === 'string') {
      return {
        type: 'save-error',
        code: error,
        params: {},
        fallback: String(fallback || ''),
        markUnsaved: !!markUnsaved
      };
    }

    if (error && typeof error === 'object') {
      return {
        type: 'save-error',
        code: String(error.code || '').trim(),
        message: String(error.message || '').trim(),
        params: error.params || error.details?.params || {},
        fallback: String(fallback || ''),
        markUnsaved: !!markUnsaved
      };
    }

    return {
      type: 'save-error',
      code: '',
      params: {},
      fallback: String(fallback || ''),
      markUnsaved: !!markUnsaved
    };
  }

  function resolvePreferencesErrorState(errorState) {
    if (!errorState || typeof errorState !== 'object') return '';

    if (errorState.type === 'preferences-code') {
      return translatePreferencesErrorCode(
        errorState.code,
        errorState.params || {},
        errorState.fallback || ''
      );
    }

    if (errorState.type === 'save-error') {
      const payload = {
        code: errorState.code,
        message: errorState.message,
        params: errorState.params
      };
      return getSaveErrorMessage(payload, errorState.fallback || '');
    }

    return String(errorState.fallback || '').trim();
  }

  function setSaveErrorWithState(errorState) {
    const message = resolvePreferencesErrorState(errorState);
    lastPreferencesErrorState = errorState;
    setSaveError(message, { markUnsaved: !!errorState?.markUnsaved, preserveState: true });
  }

  async function persistPreferencesAndHandleError(nextState, fallbackMessage) {
    const result = await savePreferences(nextState);
    if (!result?.ok) {
      const errorState = buildSaveErrorDescriptor(result?.error, fallbackMessage, true);
      const errorMessage = resolvePreferencesErrorState(errorState);
      setSaveErrorWithState(errorState);
      showToast(errorMessage, { persistent: true, isError: true });
      return false;
    }
    prefs.preferences = (result.preferences && typeof result.preferences === 'object')
      ? result.preferences
      : nextState.preferences;
    setSaveError('', { markUnsaved: false });
    return true;
  }

  function applyTheme(theme) {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    localStorage.setItem('theme', normalized);
    document.body.classList.toggle('dark-mode', normalized === 'dark');

    // Keep the top-bar toggle in sync even when theme changes programmatically
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) themeToggle.checked = normalized === 'light';
  }
  
  const prefs = await loadPreferences();
  hasApiKey = await loadApiKeyPresence();

  let currentAppVersion = '';
  const renderAppVersionLabel = () => {
    if (!el.appVersion || !currentAppVersion) return;
    el.appVersion.textContent = translate(
      'preferencesAppVersionLabel',
      `Version ${currentAppVersion}`,
      { version: currentAppVersion }
    );
  };

  try {
    const version = await ipc.invoke('app:get-version');
    currentAppVersion = String(version || '').trim();
    renderAppVersionLabel();
  } catch (err) {
    console.error('Failed to load app version:', err);
  }

  // ─── Adobe CEP Panel installer (Premiere) ─────────────────────────────
  function _setCepError(message) {
    if (!el.cepError) return;
    const msg = String(message ?? '').trim();
    el.cepError.textContent = msg;
    el.cepError.hidden = !msg;
  }

  function _setCepErrorFromModel(errorModel, fallbackMessage) {
    lastCepErrorModel = errorModel
      ? {
        source: errorModel,
        fallbackMessage: String(fallbackMessage || '').trim()
      }
      : null;

    if (!lastCepErrorModel) {
      _setCepError('');
      return;
    }

    _setCepError(_resolveCepErrorMessage(lastCepErrorModel.source, lastCepErrorModel.fallbackMessage));
  }

  function _resolveCepErrorMessage(error, fallbackMessage) {
    const fallback = String(fallbackMessage || '').trim();
    if (!error) return fallback;

    if (typeof error === 'string') {
      return error.trim() || fallback;
    }

    const payload = (error && typeof error === 'object') ? error : {};
    const params = (payload.params && typeof payload.params === 'object') ? payload.params : {};
    const normalizedCode = String(payload.code || '').trim().toUpperCase();
    const key = typeof payload.key === 'string' ? payload.key.trim() : '';

    if (key) {
      const translated = translate(key, key, params);
      if (translated && translated !== key) return translated;
    }

    const codeMap = {
      CEP_STATUS_READ_FAILED: () => translate('cepStatusCheckFailed', 'CEP status check failed'),
      CEP_SYSTEM_INSTALL_MAC_ONLY: () => translate(
        'cepSystemInstallMacOnly',
        'System-scope install is only supported on macOS from this app.'
      ),
      CEP_SYSTEM_INSTALL_NOT_RECOMMENDED: () => translate(
        'cepSystemInstallNotRecommended',
        'System-scope CEP install is not recommended. Use user-scope install.'
      ),
      CEP_SIGNED_ZXP_NOT_FOUND: () => translate(
        'cepSignedZxpNotFound',
        'Signed ZXP not found at: {{zxpPath}}',
        { zxpPath: params.zxpPath || '' }
      ),
      CEP_SIGNED_ZXP_INVALID: () => translate(
        'cepSignedZxpInvalid',
        'Signed ZXP extracted but no CSXS/manifest.xml found. zxp={{zxpPath}}',
        { zxpPath: params.zxpPath || '' }
      ),
      CEP_INSTALL_FAILED: () => translate('cepInstallFailed', 'Install failed'),
      CEP_SYSTEM_UNINSTALL_MAC_ONLY: () => translate(
        'cepSystemUninstallMacOnly',
        'System-scope uninstall is only supported on macOS from this app.'
      ),
      CEP_UNINSTALL_FAILED: () => translate('cepUninstallFailed', 'Uninstall failed'),
      CEP_OPEN_FOLDER_FAILED: () => translate('cepOpenFolderFailed', 'Unable to open folder')
    };

    const resolver = codeMap[normalizedCode];
    if (typeof resolver === 'function') return resolver();

    const message = String(payload.message || '').trim();
    if (message) return message;
    return fallback;
  }

  function normalizeBackendErrorPayload(errorLike) {
    const normalizeCode = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^[A-Z0-9_]+$/.test(raw)) return raw;
      if (/offline\s+mode/i.test(raw)) return 'OFFLINE_MODE';
      if (/no\s+published\s+versions|cannot\s+find\s+latest\.yml|status\s+code\s+404|empty\s+channel/i.test(raw)) {
        return 'ERR_UPDATER_NO_PUBLISHED_VERSIONS';
      }
      return '';
    };

    if (!errorLike) {
      return { code: '', key: '', params: {} };
    }

    if (typeof errorLike === 'string') {
      return {
        code: normalizeCode(errorLike),
        key: '',
        params: {}
      };
    }

    const payload = (errorLike && typeof errorLike === 'object') ? errorLike : {};
    const params = (payload.params && typeof payload.params === 'object') ? payload.params : {};
    const code = normalizeCode(payload.code || payload.error?.code || payload.message || payload.error?.message);
    const key = typeof payload.key === 'string' ? payload.key.trim() : '';

    return { code, key, params };
  }

  function resolveLocalizedBackendError(errorLike, options = {}) {
    const { code, key, params } = normalizeBackendErrorPayload(errorLike);
    const fallbackKey = String(options.fallbackKey || '').trim();
    const fallbackMessage = String(options.fallbackMessage || '').trim();
    const operation = String(options.operation || '').trim();

    if (key) {
      const translated = translate(key, key, params);
      if (translated && translated !== key) return translated;
    }

    const codeMap = {
      OFFLINE_MODE: () => translate('updateErrorOfflineMode', 'Offline Mode is enabled. Disable it to continue.'),
      ERR_UPDATER_NO_PUBLISHED_VERSIONS: () => translate('updateErrorNoPublishedVersions', 'No published updates are available yet.'),
      EACCES: () => translate('preferencesMaintenanceErrorPermissionDenied', 'Permission denied while running {{operation}}.', { operation }),
      EPERM: () => translate('preferencesMaintenanceErrorPermissionDenied', 'Permission denied while running {{operation}}.', { operation }),
      ENOENT: () => translate('preferencesMaintenanceErrorNotFound', 'Required file or folder was not found for {{operation}}.', { operation }),
      ENOTDIR: () => translate('preferencesMaintenanceErrorNotFound', 'Required file or folder was not found for {{operation}}.', { operation }),
      EBUSY: () => translate('preferencesMaintenanceErrorBusy', 'Some files are currently in use. Close related apps and retry {{operation}}.', { operation })
    };

    const resolver = codeMap[code];
    if (typeof resolver === 'function') return resolver();

    if (code) {
      return translate(
        'preferencesBackendErrorWithCode',
        '{{message}} (Code: {{code}})',
        {
          message: fallbackKey ? translate(fallbackKey, fallbackMessage, params) : fallbackMessage,
          code
        }
      );
    }

    return fallbackKey
      ? translate(fallbackKey, fallbackMessage, params)
      : fallbackMessage;
  }

  let lastCepStatusModel = null;
  let lastCepErrorModel = null;

  function _renderCepStatusFromModel(status) {
    if (!el.cepStatus) return;
    if (!status || status.ok === false) {
      el.cepStatus.textContent = translate('cepStatusUnavailable', 'Unable to determine panel status.');
      _setCepErrorFromModel(status?.error, translate('cepStatusCheckFailed', 'CEP status check failed'));
      return;
    }

    _setCepErrorFromModel(null, '');
    const installedUser = !!status.installed?.user;
    const installedSystem = !!status.installed?.system;
    const installedAny = !!status.installed?.any;

    const userPath = status.paths?.userExt;
    const systemHits = status.paths?.systemHits;
    const systemPath = Array.isArray(systemHits) && systemHits.length ? systemHits[0] : null;

    if (installedAny) {
      const where = installedSystem
        ? translate('cepStatusScopeSystem', 'system')
        : translate('cepStatusScopeUser', 'user');
      el.cepStatus.textContent = translate('cepStatusInstalled', 'Panel installed ({{where}}).', { where });
    } else {
      el.cepStatus.textContent = translate('cepStatusNotInstalled', 'Panel not installed yet.');
    }

    if (installedSystem && systemPath) {
      const systemLabel = translate('cepStatusSystemLabel', 'System');
      el.cepStatus.textContent += ` ${systemLabel}: ${systemPath}`;
    } else if (installedUser && userPath) {
      const userLabel = translate('cepStatusUserLabel', 'User');
      el.cepStatus.textContent += ` ${userLabel}: ${userPath}`;
    }
  }

  async function _refreshCepStatus() {
    if (!el.cepStatus || !ipc?.invoke) return;

    try {
      _setCepErrorFromModel(null, '');
      const status = await ipc.invoke('cep:get-status');
      lastCepStatusModel = status || null;
      _renderCepStatusFromModel(status);
    } catch {
      lastCepStatusModel = {
        ok: false,
        error: { code: 'CEP_STATUS_READ_FAILED' }
      };
      _renderCepStatusFromModel(lastCepStatusModel);
    }
  }

  async function _installCepPanel() {
    if (!ipc?.invoke) return;
    const confirmed = await confirmPreferencesAction({
      title: translate('cepInstallConfirmTitle', 'Install or repair panel'),
      message: translate('cepInstallConfirmMessage', 'Install/Repair the Adobe Premiere CEP panel?'),
      detail: translate(
        'cepInstallConfirmDetail',
        'This will copy or overwrite the panel files in your user CEP extensions folder.'
      ),
      type: 'question',
      okLabel: translate('cepInstallConfirmButton', 'Install'),
      cancelLabel: translate('cancelButtonLabel', 'Cancel')
    });
    if (!confirmed) return;
    _setCepErrorFromModel(null, '');
    const res = await ipc.invoke('cep:install', { scope: 'user' });
    if (!res || res.ok === false) {
      _setCepErrorFromModel(res?.error || { code: 'CEP_INSTALL_FAILED' }, translate('cepInstallFailed', 'Install failed'));
      return;
    }
    showToast(translate('cepInstalledToast', 'Panel installed'));
    await _refreshCepStatus();
  }

  async function _uninstallCepPanel() {
    if (!ipc?.invoke) return;
    const confirmed = await confirmPreferencesAction({
      title: translate('cepUninstallConfirmTitle', 'Remove panel'),
      message: translate('cepUninstallConfirmMessage', 'Uninstall the Adobe Premiere CEP panel?'),
      detail: translate(
        'cepUninstallConfirmDetail',
        'This will remove the panel files from your user CEP extensions folder.'
      ),
      type: 'warning',
      okLabel: translate('cepUninstallConfirmButton', 'Remove'),
      cancelLabel: translate('cancelButtonLabel', 'Cancel')
    });
    if (!confirmed) return;
    _setCepErrorFromModel(null, '');
    const res = await ipc.invoke('cep:uninstall', { scope: 'user' });
    if (!res || res.ok === false) {
      _setCepErrorFromModel(res?.error || { code: 'CEP_UNINSTALL_FAILED' }, translate('cepUninstallFailed', 'Uninstall failed'));
      return;
    }
    showToast(translate('cepUninstalledToast', 'Panel removed'));
    await _refreshCepStatus();
  }

  if (el.cepInstallBtn && !el.cepInstallBtn.dataset.bound) {
    el.cepInstallBtn.addEventListener('click', _installCepPanel);
    el.cepInstallBtn.dataset.bound = 'true';
  }

  if (el.cepUninstallBtn && !el.cepUninstallBtn.dataset.bound) {
    el.cepUninstallBtn.addEventListener('click', _uninstallCepPanel);
    el.cepUninstallBtn.dataset.bound = 'true';
  }

  if (el.cepOpenFolderBtn && !el.cepOpenFolderBtn.dataset.bound) {
    el.cepOpenFolderBtn.addEventListener('click', async () => {
      try {
        _setCepErrorFromModel(null, '');
        const res = await ipc.invoke('cep:open-folder', { scope: 'user' });
        if (res && res.ok === false) {
          _setCepErrorFromModel(res.error || { code: 'CEP_OPEN_FOLDER_FAILED' }, translate('cepOpenFolderFailed', 'Unable to open folder'));
        }
      } catch {
        _setCepErrorFromModel({ code: 'CEP_OPEN_FOLDER_FAILED' }, translate('cepOpenFolderFailed', 'Unable to open folder'));
      }
    });
    el.cepOpenFolderBtn.dataset.bound = 'true';
  }

  // Kick initial status read.
  _refreshCepStatus();

  function setApiKeyPlaceholder() {
    if (!el.apiKeyInput) return;
    // Never populate the input with the actual key.
    el.apiKeyInput.value = '';
    el.apiKeyInput.placeholder = hasApiKey
      ? translate('apiKeyPlaceholderSaved', 'Saved (enter a new key to replace)')
      : translate('apiKeyPlaceholderEmpty', 'Enter your API key here...');
  }

  function renderPreferencesOverviewTooltip() {
    const prefsOverview = document.querySelector('#preferences #preferences-overview-tooltip');
    if (!prefsOverview) return;

    const overviewText = {
      header: translate('preferencesOverviewHeader', 'PREFERENCES — Technical Overview'),
      coreCapabilities: translate('preferencesOverviewCoreCapabilities', 'Core capabilities'),
      coreBullet1: translate('preferencesOverviewCoreBullet1', 'Controls global behaviour of the app: offline mode, theme, and language.'),
      coreBullet2: translate('preferencesOverviewCoreBullet2', 'Stores the AI API key in the secure store instead of plain config.'),
      coreBullet3: translate('preferencesOverviewCoreBullet3', 'Defines global webhook URL and logging policy for automation hooks.'),
      underTheHood: translate('preferencesOverviewUnderTheHood', 'Under the hood'),
      hoodBullet1: translate('preferencesOverviewHoodBullet1', 'Persists settings in <code>config/state.json</code> plus the OS-level secure store for secrets.'),
      hoodBullet2: translate('preferencesOverviewHoodBullet2', 'Broadcasts theme changes to the top-bar toggle and other panels.'),
      hoodBullet3: translate('preferencesOverviewHoodBullet3', 'Mirrors webhook settings into Ingest, Transcode, and Adobe Automate panels.'),
      operationalNotes: translate('preferencesOverviewOperationalNotes', 'Operational notes'),
      notesBullet1: translate('preferencesOverviewNotesBullet1', 'Resetting preferences clears local API keys and webhook settings.')
    };

    prefsOverview.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-header">${overviewText.header}</div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${overviewText.coreCapabilities}</span>
          <ul class="tooltip-list">
            <li>${overviewText.coreBullet1}</li>
            <li>${overviewText.coreBullet2}</li>
            <li>${overviewText.coreBullet3}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${overviewText.underTheHood}</span>
          <ul class="tooltip-list">
            <li>${overviewText.hoodBullet1}</li>
            <li>${overviewText.hoodBullet2}</li>
            <li>${overviewText.hoodBullet3}</li>
          </ul>
        </div>

        <div class="tooltip-section">
          <span class="tooltip-subtitle">${overviewText.operationalNotes}</span>
          <ul class="tooltip-list">
            <li>${overviewText.notesBullet1}</li>
          </ul>
        </div>
      </div>
    `;
  }

  function populateFields(p = defaultPreferences) {
    if (el.offlineMode) el.offlineMode.checked = !!p.offlineMode;
    updateOfflineModeWarning();
    if (el.crashReporting) el.crashReporting.checked = p.crashReporting !== false;
    setDropdownValue('language-select', p.language || 'en');
    if (window.i18n) {
      window.i18n.changeLanguage(p.language || 'en').then(() => {
        setupPreferencesDropdowns({ languageValue: p.language || 'en' });
        renderPreferencesOverviewTooltip();
        window.translatePage?.();
        setApiKeyPlaceholder();
        refreshPreferencesLocalizedRuntimeText();
      });
    }

    if (el.themeSelect) {
      const storedTheme = localStorage.getItem('theme');
      const localTheme = (storedTheme === 'dark' || storedTheme === 'light') ? storedTheme : null;
      const prefTheme = (p.theme === 'dark' || p.theme === 'light') ? p.theme : null;
      const theme = localTheme || prefTheme || 'light';
      setDropdownValue('theme-select', theme);
      applyTheme(theme);
    }

    setApiKeyPlaceholder();

    if (el.webhookUrl) el.webhookUrl.value = p.webhookUrl || '';
    if (el.webhookLog) el.webhookLog.checked = p.webhookLogging || false;
    if (el.webhookFailOnly) el.webhookFailOnly.checked = p.webhookOnlyFail || false;
    if (el.clearTempOnStartup) el.clearTempOnStartup.checked = !!p.clearTempOnStartup;
    if (el.clearCacheOnStartup) el.clearCacheOnStartup.checked = !!p.clearCacheOnStartup;
    if (el.autoUpdateCheckOnLaunch) el.autoUpdateCheckOnLaunch.checked = p.autoUpdateCheckOnLaunch !== false;
    if (el.autoUpdateAutoDownload) el.autoUpdateAutoDownload.checked = p.autoUpdateAutoDownload === true;
    if (el.tempMaxAgeDays) {
      el.tempMaxAgeDays.value = Number.isFinite(Number(p.tempMaxAgeDays)) ? p.tempMaxAgeDays : 7;
    }

    updateWebhookValidationUI();
    mirrorWebhookSettings();
  }

  if (prefs.ok && prefs.preferences) {
    // Trust the real secure-store state over any on-disk flag.
    prefs.preferences.apiKeyStored = !!hasApiKey;
    populateFields(prefs.preferences);

    const loadIssue = classifyLoadIssue(prefs);
    const loadIssueMessage = translatePreferencesErrorCode(
      prefs?.code || loadIssue.message,
      prefs?.params,
      loadIssue.message
    );
    if (loadIssue.recoverable && loadIssueMessage) {
      setSaveErrorWithState(
        buildPreferencesCodeErrorState(
          prefs?.code || loadIssue.message,
          prefs?.params,
          loadIssue.message,
          false
        )
      );
      showToast(loadIssueMessage, { isError: false });
    } else {
      setSaveError('', { markUnsaved: false });
    }
  } else {
    const loadIssue = classifyLoadIssue(prefs);
    const defaultLoadError = translate('preferencesLoadFailed', 'Failed to load saved preferences. Using defaults.');
    const loadError = translatePreferencesErrorCode(
      prefs?.code || prefs?.error,
      prefs?.params,
      translatePreferencesErrorCode(loadIssue.message, prefs?.params, loadIssue.message) || defaultLoadError
    );
    setSaveErrorWithState(
      buildPreferencesCodeErrorState(
        prefs?.code || prefs?.error,
        prefs?.params,
        translatePreferencesErrorCode(loadIssue.message, prefs?.params, loadIssue.message) || defaultLoadError,
        false
      )
    );
    showToast(loadError, { persistent: !loadIssue.recoverable, isError: !loadIssue.recoverable });
    prefs.preferences = { ...defaultPreferences, apiKeyStored: !!hasApiKey };
    populateFields(prefs.preferences);
  }

  function attachSaveEvents() {
    const save = async () => {
      const webhookValidation = updateWebhookValidationUI();
      mirrorWebhookSettings();

      const pendingApiKeyValue = apiKeyDirty
        ? (el.apiKeyInput?.value?.trim?.() || '')
        : null;

      if (!webhookValidation.valid && webhookValidation.url) {
        showToast(translate('webhookUrlInvalidToast', 'Enter a valid webhook URL before saving.'));
        return;
      }

      const didRequestApiKeyWrite = pendingApiKeyValue !== null;

      const currentPrefs = (prefs.preferences && typeof prefs.preferences === 'object') ? prefs.preferences : {};
      const previousTempMaxAgeDays = (() => {
        const n = parseInt(currentPrefs.tempMaxAgeDays, 10);
        return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : 7;
      })();
      const tempMaxAgeRaw = el.tempMaxAgeDays?.value ?? currentPrefs.tempMaxAgeDays;
      const tempMaxAgeParsed = parseInt(tempMaxAgeRaw, 10);
      const tempMaxAgeValid = Number.isInteger(tempMaxAgeParsed) && tempMaxAgeParsed >= 0 && tempMaxAgeParsed <= 3650;

      if (!tempMaxAgeValid) {
        const invalidTempMaxAgeMessage = translate(
          'preferencesTempMaxAgeRange',
          'Temp max age must be an integer between 0 and 3650 days.'
        );
        if (el.tempMaxAgeDays) el.tempMaxAgeDays.value = String(previousTempMaxAgeDays);
        setSaveError(invalidTempMaxAgeMessage, { markUnsaved: true });
        showToast(invalidTempMaxAgeMessage, { persistent: true, isError: true });
        return;
      }

      const nextPrefs = {
        ...currentPrefs,
        offlineMode: el.offlineMode ? !!el.offlineMode.checked : !!currentPrefs.offlineMode,
        crashReporting: el.crashReporting ? !!el.crashReporting.checked : (currentPrefs.crashReporting !== false),
        theme: el.themeSelect?.value || currentPrefs.theme || 'light',
        language: el.language?.value || currentPrefs.language || 'en',
        apiKeyStored: !!hasApiKey,
        webhookUrl: el.webhookUrl ? (webhookValidation.valid ? webhookValidation.url : '') : (currentPrefs.webhookUrl || ''),
        webhookLogging: el.webhookLog ? (webhookValidation.valid && !!el.webhookLog.checked) : !!currentPrefs.webhookLogging,
        webhookOnlyFail: el.webhookFailOnly ? (webhookValidation.valid && !!el.webhookFailOnly.checked) : !!currentPrefs.webhookOnlyFail,
        clearTempOnStartup: el.clearTempOnStartup ? !!el.clearTempOnStartup.checked : !!currentPrefs.clearTempOnStartup,
        clearCacheOnStartup: el.clearCacheOnStartup ? !!el.clearCacheOnStartup.checked : !!currentPrefs.clearCacheOnStartup,
        autoUpdateCheckOnLaunch: el.autoUpdateCheckOnLaunch ? !!el.autoUpdateCheckOnLaunch.checked : (currentPrefs.autoUpdateCheckOnLaunch !== false),
        autoUpdateAutoDownload: el.autoUpdateAutoDownload ? !!el.autoUpdateAutoDownload.checked : (currentPrefs.autoUpdateAutoDownload === true),
        tempMaxAgeDays: tempMaxAgeParsed
      };

      const prefsChanged = JSON.stringify(nextPrefs) !== JSON.stringify(currentPrefs);

      // Apply crash reporting toggle immediately (no restart required).
      // We persist preferences to state.json below; this IPC call updates the main
      // process runtime state (and crash upload setting) right away.
      const prevCrashReporting = currentPrefs.crashReporting !== false;
      const nextCrashReporting = nextPrefs.crashReporting !== false;
      const crashRuntimeApplyFailedMessage = translate(
        'preferencesCrashRuntimeApplyFailed',
        'Unable to apply crash reporting change right now.'
      );
      let crashReportingRuntimeApplied = false;
      if (prevCrashReporting !== nextCrashReporting && typeof ipc?.invoke === 'function') {
        try {
          const runtimeRes = await ipc.invoke('telemetry:set-enabled', { enabled: nextCrashReporting, persist: false });
          if (runtimeRes && typeof runtimeRes === 'object' && runtimeRes.ok === false) {
            const detail = typeof runtimeRes.error === 'string' ? runtimeRes.error.trim() : '';
            const messageWithDetail = detail
              ? `${crashRuntimeApplyFailedMessage} (${detail})`
              : crashRuntimeApplyFailedMessage;
            throw new Error(messageWithDetail);
          }
          crashReportingRuntimeApplied = true;
        } catch (err) {
          const detail = err && typeof err.message === 'string' ? err.message.trim() : '';
          const runtimeErrorMessage = detail || crashRuntimeApplyFailedMessage;
          setSaveError(runtimeErrorMessage, { markUnsaved: true });
          showToast(runtimeErrorMessage, { persistent: true, isError: true });
          return;
        }
      }

      // Nothing changed (and no API key write requested) → don't thrash disk or spam toasts.
      if (!prefsChanged && !didRequestApiKeyWrite) {
        setSaveError('', { markUnsaved: false });
        return;
      }

      const saveResult = await savePreferences({ ...prefs, preferences: nextPrefs });
      if (!saveResult?.ok) {
        const baseErrorState = buildSaveErrorDescriptor(saveResult?.error, '', true);
        const baseError = resolvePreferencesErrorState(baseErrorState);
        const temporaryCrashMessage = crashReportingRuntimeApplied
          ? ` ${translate('preferencesCrashTemporaryNotice', 'Crash reporting was updated for this session only and will revert after restart unless you save again.')}`
          : '';
        const errorMessage = `${baseError}${temporaryCrashMessage}`.trim();
        if (temporaryCrashMessage) {
          lastPreferencesErrorState = null;
          setSaveError(errorMessage, { markUnsaved: true });
        } else {
          setSaveErrorWithState(baseErrorState);
        }
        showToast(errorMessage, { persistent: true, isError: true });
        return;
      }

      prefs.preferences = (saveResult.preferences && typeof saveResult.preferences === 'object')
        ? saveResult.preferences
        : nextPrefs;

      if (pendingApiKeyValue !== null) {
        const apiKeySaveResult = await persistApiKeyValue(pendingApiKeyValue);
        hasApiKey = !!apiKeySaveResult?.hasApiKey;

        if (!apiKeySaveResult?.ok) {
          const apiKeyErrorMessage = translateApiKeyPersistErrorCode(
            apiKeySaveResult?.errorCode,
            'preferencesApiKeySaveFailed'
          );
          console.error('❌ API key save failed:', {
            code: apiKeySaveResult?.errorCode,
            detail: apiKeySaveResult?.errorDetail
          });
          setSaveError(apiKeyErrorMessage, { markUnsaved: true });
          showToast(apiKeyErrorMessage, { persistent: true, isError: true });
          return;
        }

        apiKeyDirty = false;
        setApiKeyPlaceholder();
      }

      prefs.preferences.apiKeyStored = !!hasApiKey;
      setSaveError('', { markUnsaved: false });
      applyTheme(nextPrefs.theme);
    };

    // Only auto-save for real preference controls.
    const onChange = [
      el.offlineMode,
      el.crashReporting,
      el.themeSelect,
      el.webhookLog,
      el.webhookFailOnly,
      el.clearTempOnStartup,
      el.clearCacheOnStartup,
      el.autoUpdateCheckOnLaunch,
      el.autoUpdateAutoDownload
    ].filter(Boolean);

    const onChangeOrBlur = [
      el.apiKeyInput,
      el.webhookUrl,
      el.tempMaxAgeDays
    ].filter(Boolean);

    onChange.forEach(node => {
      node.addEventListener('change', save);
    });

    onChangeOrBlur.forEach(node => {
      node.addEventListener('change', save);
      node.addEventListener('blur', save);
    });
  }

  attachSaveEvents();

  // Keep Offline Mode warning in sync with checkbox + language changes.
  if (el.offlineMode && el.offlineModeWarning && !el.offlineMode.dataset.offlineModeWarningBound) {
    el.offlineMode.addEventListener('change', updateOfflineModeWarning);
    el.offlineMode.dataset.offlineModeWarningBound = 'true';
  }
  if (window.i18n?.on && !window.__LEADAE_PREFS_OFFLINE_I18N_BOUND__) {
    window.__LEADAE_PREFS_OFFLINE_I18N_BOUND__ = true;
    try { window.i18n.on('languageChanged', refreshPreferencesLocalizedRuntimeText); } catch {}
  }
  if (window.i18n?.on && !window.__LEADAE_PREFS_OVERVIEW_I18N_BOUND__) {
    window.__LEADAE_PREFS_OVERVIEW_I18N_BOUND__ = true;
    try { window.i18n.on('languageChanged', renderPreferencesOverviewTooltip); } catch {}
  }
  if (window.i18n?.on && !window.__LEADAE_PREFS_APIKEY_PLACEHOLDER_I18N_BOUND__) {
    window.__LEADAE_PREFS_APIKEY_PLACEHOLDER_I18N_BOUND__ = true;
    try { window.i18n.on('languageChanged', setApiKeyPlaceholder); } catch {}
  }

  let lastUpdateStatus = null;
  function setUpdateUI({ status, info }) {
    if (!el.updateStatusText) return;
    lastUpdateStatus = { status, info };

    const tUpdate = (key, fallback, options = {}) => translate(`updateStatus.${key}`, fallback, options);

    if (el.updateProgress) el.updateProgress.style.display = 'none';
    if (el.downloadUpdateBtn) el.downloadUpdateBtn.hidden = true;
    if (el.installUpdateBtn) el.installUpdateBtn.hidden = true;

    if (status === 'disabled') {
      el.updateStatusText.textContent =
        info?.reason === 'offlineMode'
          ? tUpdate('disabledOfflineMode', 'Updates disabled (Offline Mode).')
          : tUpdate('disabledAutoCheck', 'Auto update checks disabled.');
      return;
    }

    if (status === 'checking') {
      el.updateStatusText.textContent = tUpdate('checking', 'Checking for updates…');
      return;
    }

    if (status === 'none') {
      el.updateStatusText.textContent = tUpdate('none', 'No updates available.');
      return;
    }

    if (status === 'available') {
      const ver = info?.version || info?.latestVersion || tUpdate('defaultVersionLabel', 'new version');
      el.updateStatusText.textContent = tUpdate('available', 'Update available: {{version}}', { version: ver });

      const autoDl = el.autoUpdateAutoDownload ? !!el.autoUpdateAutoDownload.checked : false;
      if (!autoDl && el.downloadUpdateBtn) el.downloadUpdateBtn.hidden = false;
      return;
    }

    if (status === 'progress') {
      const pct = Math.max(0, Math.min(100, Math.round(Number(info?.percent) || 0)));
      el.updateStatusText.textContent = tUpdate('progress', 'Downloading… {{percent}}%', { percent: pct });
      if (el.updateProgress) {
        el.updateProgress.style.display = '';
        el.updateProgress.max = 100;
        el.updateProgress.value = pct;
      }
      return;
    }

    if (status === 'downloaded') {
      const ver = info?.version || tUpdate('defaultVersionLabel', 'new version');
      el.updateStatusText.textContent = tUpdate('downloaded', 'Update downloaded ({{version}}). Restart to install.', { version: ver });
      if (el.installUpdateBtn) el.installUpdateBtn.hidden = false;
      return;
    }

    if (status === 'error') {
      const updateErrorMessage = resolveLocalizedBackendError(info, {
        fallbackKey: 'updateErrorGeneric',
        fallbackMessage: 'Update failed.',
        operation: translate('updateOperation', 'update')
      });
      el.updateStatusText.textContent = tUpdate('error', 'Update error: {{error}}', { error: updateErrorMessage }).trim();
      return;
    }

    el.updateStatusText.textContent = status
      ? tUpdate('unknown', 'Unknown update status: {{status}}', { status: String(status) })
      : '';
  }

  function refreshPreferencesLocalizedRuntimeText() {
    updateOfflineModeWarning();
    updateWebhookValidationUI();
    updateWebhookVisibility();

    if (currentAppVersion) renderAppVersionLabel();

    if (lastCepStatusModel) {
      _renderCepStatusFromModel(lastCepStatusModel);
    } else {
      _refreshCepStatus();
    }

    if (lastCepErrorModel) {
      _setCepError(_resolveCepErrorMessage(lastCepErrorModel.source, lastCepErrorModel.fallbackMessage));
    }

    if (lastUpdateStatus) setUpdateUI(lastUpdateStatus);
    renderMaintenanceStatusFromState();

    if (lastPreferencesErrorState) {
      setSaveErrorWithState(lastPreferencesErrorState);
    }

    // Transient toasts can contain stale-language strings.
    clearToast();
  }

  ipc?.on?.('auto-update-status', (_evt, payload) => {
    if (!payload) return;
    setUpdateUI(payload);
  });

  (async () => {
    if (!ipc?.invoke) return;
    try {
      const last = await ipc.invoke('updates:get-status');
      if (last) setUpdateUI(last);
    } catch {}
  })();

  el.autoUpdateAutoDownload?.addEventListener('change', () => {
    if (lastUpdateStatus) setUpdateUI(lastUpdateStatus);
  });

  el.checkUpdatesNowBtn?.addEventListener('click', async () => {
    if (!ipc?.invoke) return;
    try {
      setUpdateUI({ status: 'checking' });
      const res = await ipc.invoke('updates:check');
      if (res?.ok === false) {
        setUpdateUI({
          status: 'error',
          info: res?.error
        });
      }
    } catch (err) {
      setUpdateUI({
        status: 'error',
        info: err
      });
    }
  });

  el.downloadUpdateBtn?.addEventListener('click', async () => {
    if (!ipc?.invoke) return;
    try {
      const res = await ipc.invoke('updates:download');
      if (res?.ok === false) {
        setUpdateUI({
          status: 'error',
          info: res?.error
        });
      }
    } catch (err) {
      setUpdateUI({
        status: 'error',
        info: err
      });
    }
  });

  el.installUpdateBtn?.addEventListener('click', async () => {
    const ok = await confirmPreferencesAction({
      title: translate('updatesInstallConfirmTitle', 'Install downloaded update'),
      message: translate('updatesInstallConfirm', 'Restart LEAD AE – ASSIST now to install the update?'),
      type: 'warning',
      okLabel: translate('updatesInstallConfirmButton', 'Restart now'),
      cancelLabel: translate('cancelButtonLabel', 'Cancel')
    });
    if (!ok) return;
    const installBtn = el.installUpdateBtn;
    try {
      if (!ipc?.invoke) return;
      if (installBtn) installBtn.disabled = true;
      const result = await ipc.invoke('updates:quit-and-install');
      if (result?.ok === false) {
        if (installBtn) installBtn.disabled = false;
        setUpdateUI({
          status: 'error',
          info: result?.error
        });
      }
    } catch (err) {
      if (installBtn) installBtn.disabled = false;
      setUpdateUI({
        status: 'error',
        info: err
      });
    }
  });

  el.webhookUrl?.addEventListener('input', () => {
    updateWebhookValidationUI();
    updateWebhookVisibility();
  });

  el.language?.removeAttribute?.('disabled');
  el.language?.addEventListener('change', async () => {
    const currentPrefs = (prefs.preferences && typeof prefs.preferences === 'object') ? prefs.preferences : {};
    const previousLanguage = currentPrefs.language || 'en';
    const newLang = el.language?.value || previousLanguage;

    if (newLang === previousLanguage) {
      return;
    }

    const persisted = await persistPreferencesAndHandleError(
      {
        ...prefs,
        preferences: {
          ...currentPrefs,
          language: newLang
        }
      },
      translate('preferencesSaveFailed', 'Failed to save preferences.')
    );

    if (!persisted) {
      setDropdownValue('language-select', previousLanguage);
      return;
    }

    await window.i18n?.changeLanguage(newLang);
    setupPreferencesDropdowns({ languageValue: newLang });
    renderPreferencesOverviewTooltip();
    window.translatePage?.();
    setApiKeyPlaceholder();
    refreshPreferencesLocalizedRuntimeText();
  });


  el.resetButton?.addEventListener("click", async () => {
    const confirmed = await confirmPreferencesAction({
      title: translate('preferencesResetConfirmTitle', 'Reset preferences'),
      message: translate('preferencesResetConfirmMessage', 'Reset all preferences to defaults?'),
      detail: translate(
        'preferencesResetConfirmDetail',
        'This will remove your saved API key and webhook configuration, and restore panel settings to their original defaults.'
      ),
      type: 'warning',
      okLabel: translate('preferencesResetConfirmButton', 'Reset'),
      cancelLabel: translate('cancelButtonLabel', 'Cancel')
    });
    if (!confirmed) return;

    const currentPrefs = (prefs.preferences && typeof prefs.preferences === 'object') ? prefs.preferences : {};
    const resetPreferencesPayload = {
      ...currentPrefs,
      ...defaultPreferences,
      apiKeyStored: false,
      webhookUrl: '',
      webhookLogging: false,
      webhookOnlyFail: false
    };

    const saveResult = await savePreferences({
      ...prefs,
      preferences: resetPreferencesPayload
    });
    if (!saveResult?.ok) {
      const errorState = buildSaveErrorDescriptor(
        saveResult?.error,
        translate('preferencesSaveFailed', 'Failed to save preferences.'),
        true
      );
      const errorMessage = resolvePreferencesErrorState(errorState);
      setSaveErrorWithState(errorState);
      showToast(errorMessage, { persistent: true, isError: true });
      return;
    }

    prefs.preferences = {
      ...resetPreferencesPayload,
      ...(saveResult.preferences && typeof saveResult.preferences === 'object' ? saveResult.preferences : {})
    };

    const apiKeyResetResult = await clearStoredApiKeyAfterReset();
    hasApiKey = apiKeyResetResult.hasApiKey;
    apiKeyDirty = false;
    prefs.preferences.apiKeyStored = !!hasApiKey;

    populateFields(prefs.preferences);
    mirrorWebhookSettings();
    setApiKeyPlaceholder();

    setSaveError('', { markUnsaved: false });

    if (!apiKeyResetResult.ok) {
      const apiKeyResetError = apiKeyResetResult.errorCode
        ? translateApiKeyPersistErrorCode(apiKeyResetResult.errorCode, 'preferencesResetApiKeyRemovalFailed')
        : translate('preferencesResetApiKeyStillPresent', 'Preferences were reset, but the saved API key is still present.');
      console.error('❌ API key reset cleanup failed:', {
        code: apiKeyResetResult.errorCode,
        detail: apiKeyResetResult.errorDetail
      });
      setSaveError(apiKeyResetError, { markUnsaved: false });
      showToast(apiKeyResetError, { persistent: true, isError: true });
      return;
    }

    // Reset implies default telemetry preference; update main process runtime too.
    try {
      const enabled = prefs.preferences?.crashReporting !== false;
      ipc?.invoke?.('telemetry:set-enabled', { enabled, persist: false }).catch(() => {});
    } catch { /* ignore */ }
    showToast(translate('preferencesReset', 'Preferences reset'));
  });

  async function refreshMaintenanceInfo() {
    if (!el.tempFolderPath || !ipc?.invoke) return;
    try {
      const info = await ipc.invoke('maintenance:get-info');
      if (info?.ok && info.tempDir) {
        el.tempFolderPath.textContent = info.tempDir;
      }
    } catch (err) {
      console.error('Failed to load maintenance info:', err);
    }
  }

  let lastMaintenanceStatus = null;

  function renderMaintenanceStatusFromState() {
    if (!el.maintenanceStatus) return;
    if (!lastMaintenanceStatus) {
      el.maintenanceStatus.textContent = '';
      return;
    }

    if (lastMaintenanceStatus.type === 'translation') {
      const { key, fallback, params } = lastMaintenanceStatus;
      el.maintenanceStatus.textContent = translate(key, fallback, params || {});
      return;
    }

    if (lastMaintenanceStatus.type === 'error') {
      const { error, fallbackKey, fallbackMessage, operationKey, operationFallback } = lastMaintenanceStatus;
      el.maintenanceStatus.textContent = resolveLocalizedBackendError(error, {
        fallbackKey,
        fallbackMessage,
        operation: translate(operationKey, operationFallback)
      });
      return;
    }

    el.maintenanceStatus.textContent = '';
  }

  function setMaintenanceStatusTranslation(key, fallback, params = {}) {
    lastMaintenanceStatus = { type: 'translation', key, fallback, params };
    renderMaintenanceStatusFromState();
  }

  function setMaintenanceStatusError(error, {
    fallbackKey,
    fallbackMessage,
    operationKey,
    operationFallback
  }) {
    lastMaintenanceStatus = {
      type: 'error',
      error,
      fallbackKey,
      fallbackMessage,
      operationKey,
      operationFallback
    };
    renderMaintenanceStatusFromState();
  }

  el.openTempFolderBtn?.addEventListener('click', async () => {
    if (!ipc?.invoke) return;
    setMaintenanceStatusTranslation('preferencesMaintenanceOpeningTemp', 'Opening temp folder…');
    try {
      const res = await ipc.invoke('maintenance:open-temp-folder');
      if (res?.ok) {
        setMaintenanceStatusTranslation('preferencesMaintenanceTempOpened', 'Temp folder opened.');
      } else {
        setMaintenanceStatusError(res?.error, {
          fallbackKey: 'preferencesMaintenanceTempOpenFailed',
          fallbackMessage: 'Unable to open temp folder.',
          operationKey: 'preferencesMaintenanceOperationOpenTemp',
          operationFallback: 'opening temp folder'
        });
      }
    } catch (err) {
      setMaintenanceStatusError(err, {
        fallbackKey: 'preferencesMaintenanceTempOpenFailed',
        fallbackMessage: 'Unable to open temp folder.',
        operationKey: 'preferencesMaintenanceOperationOpenTemp',
        operationFallback: 'opening temp folder'
      });
    }
  });

  el.clearTempNowBtn?.addEventListener('click', async () => {
    if (!ipc?.invoke) return;
    const days = parseInt(el.tempMaxAgeDays?.value, 10);
    const maxAgeDays = Number.isFinite(days) && days >= 0 ? days : 7;
    setMaintenanceStatusTranslation('preferencesMaintenanceClearingTemp', 'Clearing temp files…');
    try {
      const res = await ipc.invoke('maintenance:clear-temp', { maxAgeDays });
      if (res?.ok) {
        setMaintenanceStatusTranslation(
          'preferencesMaintenanceTempClearComplete',
          'Temp cleanup complete: {{removedCount}} removed, freed {{freed}}.',
          { removedCount: res.removedCount ?? 0, freed: res.freed || '0 B' }
        );
      } else {
        setMaintenanceStatusError(res?.error, {
          fallbackKey: 'preferencesMaintenanceTempClearFailed',
          fallbackMessage: 'Temp cleanup failed.',
          operationKey: 'preferencesMaintenanceOperationClearTemp',
          operationFallback: 'clearing temp files'
        });
      }
    } catch (err) {
      setMaintenanceStatusError(err, {
        fallbackKey: 'preferencesMaintenanceTempClearFailed',
        fallbackMessage: 'Temp cleanup failed.',
        operationKey: 'preferencesMaintenanceOperationClearTemp',
        operationFallback: 'clearing temp files'
      });
    }
  });

  el.clearCacheNowBtn?.addEventListener('click', async () => {
    if (!ipc?.invoke) return;
    setMaintenanceStatusTranslation('preferencesMaintenanceClearingCache', 'Clearing cache…');
    try {
      const res = await ipc.invoke('maintenance:clear-cache');
      if (res?.ok) {
        setMaintenanceStatusTranslation(
          'preferencesMaintenanceCacheClearComplete',
          'Cache cleanup complete: {{removedCount}} removed, freed {{freed}}.',
          { removedCount: res.removedCount ?? 0, freed: res.freed || '0 B' }
        );
      } else {
        setMaintenanceStatusError(res?.error, {
          fallbackKey: 'preferencesMaintenanceCacheClearFailed',
          fallbackMessage: 'Cache cleanup failed.',
          operationKey: 'preferencesMaintenanceOperationClearCache',
          operationFallback: 'clearing cache'
        });
      }
    } catch (err) {
      setMaintenanceStatusError(err, {
        fallbackKey: 'preferencesMaintenanceCacheClearFailed',
        fallbackMessage: 'Cache cleanup failed.',
        operationKey: 'preferencesMaintenanceOperationClearCache',
        operationFallback: 'clearing cache'
      });
    }
  });

  refreshMaintenanceInfo();

  // =====================================
  // 🌙 Sync Topbar Toggle with Preferences Dropdown (runs immediately)
  // =====================================
  (function wireThemeSync() {
    const themeToggle = document.getElementById('theme-toggle');
    const themeSelect = el.themeSelect;
    if (!themeToggle || !themeSelect) return;

    const isSupportedTheme = (value) => value === 'light' || value === 'dark';

    const syncThemeUi = (theme) => {
      themeSelect.value = theme;
      localStorage.setItem('theme', theme);
      themeToggle.checked = theme === 'light';
      setDropdownValue('theme-select', theme);
      applyTheme(theme);
      prefs.preferences.theme = theme;
    };

    // Initial sync order: localStorage → preferences → default.
    // localStorage is always updated by the top-bar toggle immediately,
    // while preferences persistence can lag if the panel is not initialized yet.
    const preferredTheme = isSupportedTheme(prefs?.preferences?.theme)
      ? prefs.preferences.theme
      : null;
    const storedTheme = localStorage.getItem('theme');
    const localStorageTheme = isSupportedTheme(storedTheme) ? storedTheme : null;
    const initialTheme = localStorageTheme || preferredTheme || 'light';
    syncThemeUi(initialTheme);

    // Dropdown → Toggle (persistence handled by attachSaveEvents).
    themeSelect.addEventListener('change', () => {
      const newTheme = themeSelect.value;
      syncThemeUi(newTheme);
      // notify other listeners (optional)
      document.dispatchEvent(new CustomEvent('theme-toggle-updated', { detail: { theme: newTheme } }));
    });

    // Toggle → Dropdown (persist by reusing dropdown change autosave path).
    themeToggle.addEventListener('change', () => {
      const isLight = themeToggle.checked;
      const newTheme = isLight ? 'light' : 'dark';
      syncThemeUi(newTheme);
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Respond to broadcasts from renderer.js
    document.addEventListener('theme-toggle-updated', (e) => {
      const theme = e.detail?.theme;
      if (!theme) return;
      if (themeSelect.value === theme && themeToggle.checked === (theme === 'light')) return;
      syncThemeUi(theme);
    });
  })();

  if (typeof window !== 'undefined' && typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test') {
    window.__prefsTestHooks = {
      updateWebhookVisibility,
      webhookSections,
      controls: el
    };
  }

  renderPreferencesOverviewTooltip();
})();
