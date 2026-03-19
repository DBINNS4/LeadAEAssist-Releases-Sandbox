// renderer.account.js
// Account & licensing panel.
//
// Notes:
// - All licensing enforcement happens in the main process.
// - This renderer panel only displays state and calls safe IPC wrappers.

(function initAccountPanel() {
  const root = document.getElementById('account');
  if (!root) return;

  const api = window.license;
  const hasApi = !!(api && typeof api.getEntitlement === 'function');

  const els = {
    status: document.getElementById('account-license-status'),
    tier: document.getElementById('account-license-tier'),
    expires: document.getElementById('account-license-expires'),
    trialRemaining: document.getElementById('account-trial-remaining'),
    reason: document.getElementById('account-license-reason'),
    warning: document.getElementById('account-trial-warning'),
    installBtn: document.getElementById('account-install-license'),
    clearBtn: document.getElementById('account-clear-license')
  };



  // --- Version / Build / Dependency info (Account ▸ top card) ---
  const versionEls = {
    box: document.getElementById('account-version-specs'),
    copyBtn: document.getElementById('account-copy-version-specs'),
    status: document.getElementById('account-version-status')
  };

  let lastVersionSpecs = null;
  let versionCopyStatusKey = null;

  function renderVersionStatusFromKey() {
    const el = versionEls.status;
    if (!el) return;
    if (!versionCopyStatusKey) {
      el.textContent = '';
      return;
    }

    if (versionCopyStatusKey === 'copied') {
      el.textContent = tSafe('accountVersionCopied', 'Copied.');
      return;
    }

    if (versionCopyStatusKey === 'failed') {
      el.textContent = tSafe('accountVersionCopyFailed', 'Copy failed.');
      return;
    }

    el.textContent = '';
  }

  function setVersionStatusKey(statusKey) {
    versionCopyStatusKey = statusKey === 'copied' || statusKey === 'failed' ? statusKey : null;
    renderVersionStatusFromKey();
  }

  function formatKeyValue(label, value) {
    const l = String(label || '').trim();
    const v = (value == null || value === '') ? '—' : String(value);
    return `${l}: ${v}`;
  }

  function renderVersionSpecs(specs) {
    if (!versionEls.box) return;
    lastVersionSpecs = (specs && typeof specs === 'object') ? specs : null;

    if (!lastVersionSpecs) {
      versionEls.box.textContent = tSafe('accountVersionUnavailable', 'Version info unavailable.');
      return;
    }

    const productName = lastVersionSpecs.productName || lastVersionSpecs.name || 'LEAD AE – ASSIST';
    const appVersion = lastVersionSpecs.appVersion || lastVersionSpecs.version || '';

    const buildBits = [];
    if (typeof lastVersionSpecs.isPackaged === 'boolean') {
      buildBits.push(lastVersionSpecs.isPackaged
        ? tSafe('accountBuildPackaged', 'packaged')
        : tSafe('accountBuildDev', 'dev'));
    }
    if (lastVersionSpecs.nodeEnv) buildBits.push(String(lastVersionSpecs.nodeEnv));
    if (lastVersionSpecs.debugUI === true) buildBits.push('DEBUG_UI');
    const buildLine = buildBits.length ? buildBits.join(' · ') : '—';

    const rt = lastVersionSpecs.runtime && typeof lastVersionSpecs.runtime === 'object' ? lastVersionSpecs.runtime : {};
    const runtimeBits = [];
    if (rt.electron) runtimeBits.push(`Electron ${rt.electron}`);
    if (rt.node) runtimeBits.push(`Node ${rt.node}`);
    if (rt.chrome) runtimeBits.push(`Chrome ${rt.chrome}`);
    if (rt.v8) runtimeBits.push(`V8 ${rt.v8}`);
    const runtimeLine = runtimeBits.length ? runtimeBits.join(' · ') : '—';

    const osBits = [];
    if (lastVersionSpecs.platform) osBits.push(String(lastVersionSpecs.platform));
    if (lastVersionSpecs.arch) osBits.push(String(lastVersionSpecs.arch));
    if (lastVersionSpecs.osVersion) osBits.push(String(lastVersionSpecs.osVersion));
    else if (lastVersionSpecs.osRelease) osBits.push(String(lastVersionSpecs.osRelease));
    const osLine = osBits.length ? osBits.join(' ') : '—';

    const deps = lastVersionSpecs.deps && typeof lastVersionSpecs.deps === 'object' ? lastVersionSpecs.deps : {};
    const depEntries = Object.entries(deps).filter(([k, v]) => k && v);
    const deviceId = typeof lastVersionSpecs.deviceId === 'string' ? lastVersionSpecs.deviceId.trim() : '';

    const lines = [];
    lines.push(formatKeyValue(tSafe('accountVersionSpecApp', 'App'), productName));
    lines.push(formatKeyValue(tSafe('accountVersionSpecVersion', 'Version'), appVersion || '—'));
    lines.push(formatKeyValue(tSafe('accountVersionSpecBuild', 'Build'), buildLine));
    lines.push(formatKeyValue(tSafe('accountVersionSpecRuntime', 'Runtime'), runtimeLine));
    lines.push(formatKeyValue(tSafe('accountVersionSpecOS', 'OS'), osLine));

    if (depEntries.length) {
      lines.push('');
      lines.push(`${tSafe('accountVersionSpecDeps', 'Key dependencies')}:`);
      for (const [name, ver] of depEntries) {
        lines.push(`  ${name} ${ver}`);
      }
      lines.push(formatKeyValue(tSafe('accountVersionSpecDeviceId', 'Device ID'), deviceId || '—'));
    } else {
      lines.push('');
      lines.push(formatKeyValue(tSafe('accountVersionSpecDeviceId', 'Device ID'), deviceId || '—'));
    }

    versionEls.box.textContent = lines.join('\n');
  }

  async function refreshVersionSpecs() {
    if (!versionEls.box) return;
    try {
      if (!window.electron?.invoke) {
        // Best-effort fallback (no IPC).
        renderVersionSpecs({
          productName: document.title || 'LEAD AE – ASSIST',
          appVersion: '',
          isPackaged: !!window.electron?.isPackaged,
          debugUI: !!window.electron?.DEBUG_UI,
          platform: window.electron?.platform || '',
          runtime: {},
          deps: {}
        });
        return;
      }

      const res = await window.electron.invoke('app:get-version-specs');
      if (res && typeof res === 'object' && res.ok === false) {
        throw new Error(res.error || 'app:get-version-specs failed');
      }
      const specs = (res && typeof res === 'object' && 'value' in res) ? res.value : res;
      renderVersionSpecs(specs);
    } catch (err) {
      console.warn('Account panel: failed to load version specs', err?.message || err);
      lastVersionSpecs = null;
      versionEls.box.textContent = tSafe('accountVersionUnavailable', 'Version info unavailable.');
    }
  }

  async function copyVersionSpecsToClipboard() {
    const text = String(versionEls.box?.textContent || '').trim();
    if (!text) return;

    // Prefer async clipboard API.
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setVersionStatusKey('copied');
        setTimeout(() => setVersionStatusKey(null), 2000);
        return;
      }
    } catch {
      // fall through to execCommand
    }

    // Fallback for older/hardened environments.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      setVersionStatusKey(ok ? 'copied' : 'failed');
    } catch {
      setVersionStatusKey('failed');
    } finally {
      setTimeout(() => setVersionStatusKey(null), 2000);
    }
  }

  versionEls.copyBtn?.addEventListener('click', () => {
    copyVersionSpecsToClipboard();
  });

  // Keep the last entitlement for UI state (do not expose device identifiers).
  let lastEntitlement = null;
  let lastSubscribeStatus = null;
  let lastInstallStatus = null;
  let lastCheckoutOpenedAt = 0;
  const RECENT_CHECKOUT_WINDOW_MS = 10 * 60 * 1000;

  function formatFallback(template, vars) {
    if (!template || !vars) return template;
    return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        return String(vars[key]);
      }
      return '';
    });
  }

  function _t(key, fallback, vars) {
    if (window.i18n?.t) {
      return window.i18n.t(key, vars);
    }
    if (fallback) return formatFallback(fallback, vars);
    return key;
  }

  function tSafe(key, fallback, vars) {
    try {
      if (window.i18n?.t) {
        const out = window.i18n.t(key, vars);
        if (typeof out === 'string' && out && out !== key) return out;
      }
    } catch {
      // ignore
    }
    if (fallback) return formatFallback(fallback, vars);
    return key;
  }

  async function confirmAccountAction(options) {
    try {
      if (typeof window.rendererDialogs?.confirmAction === 'function') {
        return !!(await window.rendererDialogs.confirmAction(options));
      }

      if (typeof window.electron?.invoke === 'function') {
        return !!(await window.electron.invoke('show-confirm-dialog', options));
      }
    } catch (err) {
      console.warn('Account confirm dialog failed:', err?.message || err);
    }

    return false;
  }

  function normalizeAccountError(rawError, rawCode) {
    const detail = String(rawError || '').trim();
    const code = String(rawCode || '').trim().toLowerCase();
    const probe = `${code} ${detail}`.toLowerCase();
    const includes = (token) => probe.includes(token);

    const knownMappings = [
      {
        match: () => includes('no active entitlement token installed') || includes('missing_bearer_token'),
        key: 'accountErrorEntitlementTokenMissing',
        fallback: 'No active entitlement token installed.'
      },
      {
        match: () => includes('entitlement_not_configured') || includes('entitlement server not configured'),
        key: 'accountErrorEntitlementNotConfigured',
        fallback: 'Entitlement server is not configured.'
      },
      {
        match: () => includes('fetch_unavailable') || includes('fetch unavailable'),
        key: 'accountErrorFetchUnavailable',
        fallback: 'Network service is unavailable in this app session.'
      },
      {
        match: () => includes('device_id_missing') || includes('missing deviceid'),
        key: 'accountErrorDeviceIdMissing',
        fallback: 'Missing device ID.'
      },
      {
        match: () => includes('portal request failed'),
        key: 'accountErrorPortalRequestFailed',
        fallback: 'Billing portal request failed.'
      },
      {
        match: () => includes('portal url invalid'),
        key: 'accountErrorPortalUrlInvalid',
        fallback: 'Billing portal URL is invalid.'
      },
      {
        match: () => includes('failed to open browser'),
        key: 'accountErrorBrowserOpenFailed',
        fallback: 'Failed to open your browser.'
      },
      {
        match: () => includes('billing not configured') || includes('missing paddle'),
        key: 'accountErrorBillingNotConfigured',
        fallback: 'Billing is not configured.'
      },
      {
        match: () => includes('rate_limited') || includes('too many requests') || includes('429'),
        key: 'accountErrorRateLimited',
        fallback: 'Too many requests. Please try again in a moment.'
      },
      {
        match: () => includes('entitlement_timeout') || includes('timed out'),
        key: 'accountErrorTimeout',
        fallback: 'The request timed out. Please try again.'
      },
      {
        match: () => includes('entitlement_network_error') || includes('network error'),
        key: 'accountErrorNetwork',
        fallback: 'Network error. Check your connection and try again.'
      }
    ];

    const known = knownMappings.find((entry) => entry.match());
    if (known) {
      return {
        known: true,
        baseMessage: tSafe(known.key, known.fallback),
        detail
      };
    }

    return {
      known: false,
      baseMessage: tSafe('accountGenericError', 'Something went wrong.'),
      detail
    };
  }

  function formatAccountErrorMessage(rawError, rawCode) {
    const normalized = normalizeAccountError(rawError, rawCode);
    if (!normalized.detail) return normalized.baseMessage;

    return tSafe('accountGenericErrorWithDetail', '{{message}} Details: {{error}}', {
      message: normalized.baseMessage,
      error: normalized.detail
    });
  }

  function setText(el, value) {
    if (!el) return;
    el.textContent = (value == null || value === '') ? '—' : String(value);
  }

  function setWarning(message) {
    const el = els.warning;
    if (!el) return;
    if (!message) {
      el.textContent = '';
      el.hidden = true;
      return;
    }
    el.textContent = String(message);
    el.hidden = false;
  }

  function ensureSubscribeControls() {
    // Already present?
    if (document.getElementById('account-subscribe')) return;

    // Account panel has no real toolbar row; don't inject into the same button row.
    // Put Billing in its own section (like other panels).
    const anchor =
      els.installBtn?.closest('.field-group') ||
      els.clearBtn?.closest('.field-group') ||
      null;

    const section = document.createElement('div');
    section.id = 'account-billing-section';
    section.className = 'account-billing-section spaced-top';
    section.hidden = true;

    const h3 = document.createElement('h3');
    h3.textContent = tSafe('accountBillingHeader', 'Billing');
    section.appendChild(h3);

    const row1 = document.createElement('div');
    row1.className = 'field-group horizontal account-billing-row';

    const plan = document.createElement('select');
    plan.id = 'account-subscribe-plan';
    const monthlyOption = document.createElement('option');
    monthlyOption.value = 'monthly';
    monthlyOption.textContent = tSafe('accountPlanMonthly', 'Monthly');

    const yearlyOption = document.createElement('option');
    yearlyOption.value = 'yearly';
    yearlyOption.textContent = tSafe('accountPlanYearly', 'Yearly');

    plan.appendChild(monthlyOption);
    plan.appendChild(yearlyOption);

    const btn = document.createElement('button');
    btn.id = 'account-subscribe';
    btn.className = 'button';
    btn.textContent = tSafe('accountSubscribe', 'Subscribe');

    const syncBtn = document.createElement('button');
    syncBtn.id = 'account-sync-entitlement';
    syncBtn.className = 'button';
    syncBtn.textContent = tSafe('accountSyncSubscription', 'Sync Subscription');

    row1.appendChild(plan);
    row1.appendChild(btn);
    section.appendChild(row1);

    const clearLicenseBtn = document.getElementById('account-clear-license');
    if (clearLicenseBtn?.parentElement) {
      clearLicenseBtn.insertAdjacentElement('afterend', syncBtn);
    }

    // Small status line (not the giant status-log box)
    const status = document.createElement('div');
    status.id = 'account-subscribe-status';
    status.className = 'field-hint';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    section.appendChild(status);

    if (anchor) anchor.insertAdjacentElement('afterend', section);
    else root.appendChild(section);
  }

  function refreshSubscribeControlsI18n() {
    const plan = document.getElementById('account-subscribe-plan');
    if (plan) {
      const monthlyOption = plan.querySelector('option[value="monthly"]');
      if (monthlyOption) {
        monthlyOption.textContent = tSafe('accountPlanMonthly', 'Monthly');
      }
      const yearlyOption = plan.querySelector('option[value="yearly"]');
      if (yearlyOption) {
        yearlyOption.textContent = tSafe('accountPlanYearly', 'Yearly');
      }
    }

    const subscribeBtn = document.getElementById('account-subscribe');
    if (subscribeBtn) {
      subscribeBtn.textContent = tSafe('accountSubscribe', 'Subscribe');
    }

    const syncBtn = document.getElementById('account-sync-entitlement');
    if (syncBtn) {
      syncBtn.textContent = tSafe('accountSyncSubscription', 'Sync Subscription');
    }

    const billingHeader = document.querySelector('#account-billing-section h3');
    if (billingHeader) {
      billingHeader.textContent = tSafe('accountBillingHeader', 'Billing');
    }
  }

  function resolveStatusMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';

    if (payload.formatter === 'accountError') {
      return formatAccountErrorMessage(payload.rawError, payload.rawCode);
    }

    if (payload.key) {
      return tSafe(payload.key, payload.fallback, payload.vars);
    }

    if (payload.raw) {
      return String(payload.raw);
    }

    return '';
  }

  function renderSubscribeStatus() {
    const el = document.getElementById('account-subscribe-status');
    if (!el) return;
    el.textContent = resolveStatusMessage(lastSubscribeStatus);
  }

  function setSubscribeStatus(payload) {
    lastSubscribeStatus = payload || null;
    renderSubscribeStatus();
  }

  function resolveInstallStatusMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';

    if (payload.kind === 'error') {
      return formatAccountErrorMessage(payload.rawError, payload.rawCode);
    }

    if (payload.kind === 'textKey') {
      return tSafe(payload.key, payload.fallback, payload.vars);
    }

    return '';
  }

  function ensureInstallStatus() {
    let statusEl = document.getElementById('account-install-status');
    if (statusEl) return statusEl;
    const actionsRow = els.installBtn?.closest('.field-group') || els.clearBtn?.closest('.field-group');
    if (!actionsRow) return null;
    statusEl = document.createElement('div');
    statusEl.id = 'account-install-status';
    statusEl.className = 'input-error';
    statusEl.setAttribute('role', 'alert');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.hidden = true;
    actionsRow.insertAdjacentElement('afterend', statusEl);
    return statusEl;
  }

  function setInstallStatus(payload) {
    if (payload == null || payload === '') {
      lastInstallStatus = null;
    } else {
      lastInstallStatus = payload;
    }
    renderInstallStatus();
  }

  function renderInstallStatus() {
    const statusEl = ensureInstallStatus();
    if (!statusEl) return;
    const msg = resolveInstallStatusMessage(lastInstallStatus).trim();
    statusEl.textContent = msg;
    statusEl.hidden = !msg;
  }

  function hasRecentCheckoutAttempt() {
    return Number.isFinite(lastCheckoutOpenedAt) &&
      lastCheckoutOpenedAt > 0 &&
      (Date.now() - lastCheckoutOpenedAt) <= RECENT_CHECKOUT_WINDOW_MS;
  }

  function hasRealInstalledEntitlement(ent, resolvedStatus) {
    if (!ent || typeof ent !== 'object') return false;
    if (ent?.reason === 'dev_fail_open') return false;
    if (ent?.valid !== true) return false;

    const status = String(resolvedStatus || ent?.status || '').trim().toUpperCase();
    return status === 'ACTIVE' || status === 'TRIAL';
  }

  function setBillingVisibility(visible) {
    const section = document.getElementById('account-billing-section');
    if (!section) return;
    section.hidden = !visible;
    if (!visible) setSubscribeStatus(null);
  }

  function formatShortDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const mins = Math.ceil(n / 60000);
    if (mins < 60) {
      return tSafe('accountDurationMinutes', '{{count}} min', { count: mins });
    }
    const hours = Math.ceil(mins / 60);
    return tSafe('accountDurationHours', '{{count}} hour(s)', { count: hours });
  }

  function formatIso(iso) {
    if (!iso) return '—';
    const ms = Date.parse(String(iso));
    if (!Number.isFinite(ms)) return String(iso);
    try {
      const activeLanguage = String(window.i18n?.language || navigator?.language || '').trim() || undefined;
      return new Date(ms).toLocaleString(activeLanguage);
    } catch {
      return new Date(ms).toISOString();
    }
  }

  function localizeStatus(rawStatus) {
    const status = String(rawStatus || '').trim();
    if (!status) return tSafe('accountUnknownValue', 'Unknown');
    const normalized = status.toUpperCase();
    const keyByCode = {
      ACTIVE: 'accountStatusActive',
      TRIAL: 'accountStatusTrial',
      LOCKED: 'accountStatusLocked'
    };
    const key = keyByCode[normalized];
    if (!key) return tSafe('accountUnknownValue', 'Unknown');

    const fallbackByCode = {
      ACTIVE: 'Active',
      TRIAL: 'Trial',
      LOCKED: 'Locked'
    };
    return tSafe(key, fallbackByCode[normalized]);
  }

  function localizeAccountTier(rawTier) {
    const tier = String(rawTier || '').trim();
    if (!tier) return tier;
    const normalized = tier.toLowerCase();
    const keyByTier = {
      none: 'accountTierNone',
      pro: 'accountTierPro',
      studio: 'accountTierStudio',
      enterprise: 'accountTierEnterprise',
      trial: 'accountTierTrial'
    };
    const key = keyByTier[normalized];
    if (!key) return tier;

    const fallbackByTier = {
      none: 'None',
      pro: 'Pro',
      studio: 'Studio',
      enterprise: 'Enterprise',
      trial: 'Trial'
    };
    return tSafe(key, fallbackByTier[normalized]);
  }

  function localizeReason(rawReason) {
    const reason = String(rawReason || '').trim();
    if (!reason) return tSafe('accountUnknownValue', 'Unknown');
    const keyByReason = {
      trial_expired: 'accountReasonTrialExpired',
      entitlement_unavailable: 'accountReasonEntitlementUnavailable',
      license_api_unavailable: 'accountReasonLicenseApiUnavailable',
      license_expired: 'accountReasonLicenseExpired',
      refresh_required: 'accountReasonRefreshRequired',
      missing_exp: 'accountReasonMissingExp',
      issuer_mismatch: 'accountReasonIssuerMismatch',
      audience_mismatch: 'accountReasonAudienceMismatch',
      device_mismatch: 'accountReasonDeviceMismatch'
    };
    const key = keyByReason[reason];
    if (!key) return tSafe('accountUnknownValue', 'Unknown');

    const fallbackByReason = {
      trial_expired: 'Trial expired',
      entitlement_unavailable: 'Entitlement unavailable',
      license_api_unavailable: 'License API unavailable',
      license_expired: 'License expired',
      refresh_required: 'Subscription refresh required',
      missing_exp: 'Missing expiry in entitlement token',
      issuer_mismatch: 'Entitlement issuer mismatch',
      audience_mismatch: 'Entitlement audience mismatch',
      device_mismatch: 'License is bound to a different device'
    };
    return tSafe(key, fallbackByReason[reason]);
  }

  function render(ent) {
    lastEntitlement = ent || null;
    let warnMsg = '';

    // Warnings are advisory only. All enforcement happens in the main process.
    if (ent?.warning === 'offline_grace') {
      warnMsg = tSafe('accountWarningOfflineGrace', 'Subscription refresh is overdue. You may be running on a short offline grace period.');
    } else if (ent?.warning === 'refresh_soon') {
      warnMsg = tSafe('accountWarningRefreshSoon', 'Subscription refresh is due soon. Click “Sync Subscription”.');
    } else if (String(ent?.status || '').toUpperCase() === 'TRIAL') {
      warnMsg = tSafe('accountWarningTrial', 'Trial active. Click “Sync Subscription” after checkout if the app does not unlock automatically.');
    }

    setWarning(warnMsg);
    // Never treat "valid" as "ACTIVE" — trials can be valid.
    const status = (() => {
      if (ent?.status) return ent.status;
      // Best-effort fallback if older entitlement shapes ever omit status.
      const tier = String(ent?.tier || '').toLowerCase();
      if (ent?.trial || tier === 'trial') return 'TRIAL';
      return ent?.valid ? 'ACTIVE' : 'LOCKED';
    })();
    setText(els.status, localizeStatus(status));
    setText(els.tier, localizeAccountTier(ent?.tier || 'none'));
    setText(els.expires, ent?.expiresAt ? formatIso(ent.expiresAt) : '—');
    setText(els.reason, localizeReason(ent?.reason));
    setBillingVisibility(!hasRealInstalledEntitlement(ent, status));

    // If they’re already active, don’t encourage double-purchase.
    const subBtn = document.getElementById('account-subscribe');
    if (subBtn) {
      // In DEV (non-packaged) ALWAYS allow clicking so you can test Paddle.
      // preload exposes isPackaged + DEBUG_UI on window.electron.
      const isDev = (window.electron?.isPackaged === false) || (window.electron?.DEBUG_UI === true);
      // IMPORTANT: TRIAL entitlements may still be "valid". Only disable for paid ACTIVE.
      const isPaidActive =
        ((ent?.status === 'ACTIVE') || (ent?.status == null && status === 'ACTIVE')) &&
        !isDev; // fallback if status missing
      subBtn.disabled = !!isPaidActive;
      subBtn.title = isPaidActive ? tSafe('accountAlreadyActive', 'Subscription already active.') : '';
    }

    // Trial info
    if (ent?.status === 'TRIAL' && ent?.trial) {
      const ms = ent.trial?.msRemaining;
      const d = ent.trial?.daysRemaining;

      if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms < (24 * 60 * 60 * 1000)) {
        setText(els.trialRemaining, formatShortDuration(ms));
      } else if (typeof d === 'number' && Number.isFinite(d)) {
        setText(els.trialRemaining, tSafe('accountDurationDays', '{{count}} day(s)', { count: d }));
      } else if (typeof ms === 'number' && Number.isFinite(ms)) {
        const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
        setText(els.trialRemaining, tSafe('accountDurationDays', '{{count}} day(s)', { count: days }));
      } else {
        setText(els.trialRemaining, '—');
      }
    } else {
      // If locked and we have a trial end date, show it as expired.
      if (ent?.reason === 'trial_expired' && ent?.expiresAt) {
        setText(els.trialRemaining, tSafe('accountTrialExpiredOn', 'Expired ({{date}})', { date: formatIso(ent.expiresAt) }));
      } else {
        setText(els.trialRemaining, '—');
      }
    }
  }

  async function refresh(force = false) {
    if (!hasApi) {
      render({ status: 'LOCKED', tier: 'none', valid: false, reason: 'license_api_unavailable' });
      return;
    }

    try {
      const ent = await api.getEntitlement({ forceReload: !!force });
      render(ent);
    } catch (err) {
      console.warn('Account panel: failed to refresh entitlement', err?.message || err);
      render({ status: 'LOCKED', tier: 'none', valid: false, reason: 'entitlement_unavailable' });
    }
  }

  async function install() {
    if (!hasApi || typeof api.selectAndInstall !== 'function') return;
    let installErrorMessage = null;
    setInstallStatus('');
    try {
      const res = await api.selectAndInstall();
      if (res?.cancelled) {
        return; // user cancelled
      }
      if (!res?.ok) {
        installErrorMessage = {
          kind: 'error',
          rawError: res?.error,
          rawCode: res?.code || 'license_install_failed'
        };
        return;
      }
      lastCheckoutOpenedAt = 0;
    } catch (err) {
      installErrorMessage = {
        kind: 'error',
        rawError: err?.message || err,
        rawCode: 'license_install_failed'
      };
    } finally {
      await refresh(true);
      setInstallStatus(installErrorMessage);
    }
  }

  async function clear() {
    if (!hasApi || typeof api.clear !== 'function') return;

    const confirmed = await confirmAccountAction({
      title: tSafe('accountClearLicenseConfirmTitle', 'Clear installed license?'),
      message: tSafe(
        'accountClearLicenseConfirmMessage',
        'This removes the locally installed license token from this machine. You can install it again later if needed.'
      ),
      detail: tSafe('accountClearLicenseConfirmDetail', 'This action cannot be undone.'),
      type: 'warning',
      okLabel: tSafe('accountClearLicenseConfirmButton', 'Clear license'),
      cancelLabel: tSafe('cancelButtonLabel', 'Cancel')
    });
    if (!confirmed) return;

    setInstallStatus('');
    try {
      lastCheckoutOpenedAt = 0;
      await api.clear();
    } catch {
      // ignore
    } finally {
      await refresh(true);
    }
  }

  els.installBtn?.addEventListener('click', install);
  els.clearBtn?.addEventListener('click', clear);

  // Subscribe wiring
  ensureSubscribeControls();
  document.getElementById('account-manage-link')?.addEventListener('click', async (e) => {
    try { e.preventDefault(); } catch {}
    setSubscribeStatus(null);
    try {
      if (!window.electron?.invoke) {
        setSubscribeStatus({ key: 'accountBillingPortalUnavailable', fallback: 'Billing unavailable.' });
        return;
      }
      const res = await window.electron.invoke('billing:open-portal', {});
      if (res && res.ok === false) {
        setSubscribeStatus({ formatter: 'accountError', rawError: res?.error, rawCode: res?.code });
        return;
      }
      setSubscribeStatus({ key: 'accountBillingPortalOpened', fallback: 'Portal opened.' });
    } catch (err) {
      setSubscribeStatus({ formatter: 'accountError', rawError: err?.message || err });
    }
  });
  document.getElementById('account-subscribe')?.addEventListener('click', async () => {
    setSubscribeStatus(null);

    const plan = (document.getElementById('account-subscribe-plan')?.value || 'monthly').toLowerCase();

    try {
      if (!window.electron?.invoke) {
        setSubscribeStatus({
          key: 'accountBillingCheckoutUnavailable',
          fallback: 'Billing unavailable (window.electron.invoke missing).'
        });
        return;
      }
      const res = await window.electron.invoke('billing:open-checkout', { plan });
      if (res && typeof res === 'object' && res.ok === false) {
        setSubscribeStatus({ formatter: 'accountError', rawError: res?.error, rawCode: res?.code });
        return;
      }
      lastCheckoutOpenedAt = Date.now();
      setSubscribeStatus({ key: 'accountBillingCheckoutOpened', fallback: 'Checkout opened.' });
    } catch (err) {
      setSubscribeStatus({ formatter: 'accountError', rawError: err?.message || err });
    }
  });

  // Sync subscription -> fetch /entitlement -> install token (no manual file)
  document.getElementById('account-sync-entitlement')?.addEventListener('click', async () => {
    setSubscribeStatus(null);
    if (!hasApi || typeof api.syncEntitlement !== 'function') {
      setSubscribeStatus({ key: 'accountSyncEntitlementUnavailable', fallback: 'Sync unavailable.' });
      return;
    }
    try {
      const waitForEntitlement = hasRecentCheckoutAttempt();
      if (waitForEntitlement) {
        setSubscribeStatus({ key: 'accountSyncEntitlementPending', fallback: 'Checking billing status…' });
      }
      const res = await api.syncEntitlement({ waitForEntitlement });
      if (!res?.ok) {
        setSubscribeStatus({ formatter: 'accountError', rawError: res?.error, rawCode: res?.code });
        return;
      }
      lastCheckoutOpenedAt = 0;
      setSubscribeStatus({ key: 'accountSyncEntitlementSuccess', fallback: 'Synced.' });
    } catch (err) {
      setSubscribeStatus({ formatter: 'accountError', rawError: err?.message || err });
    } finally {
      await refresh(true);
    }
  });

  // Initial paint
  refreshSubscribeControlsI18n();
  refreshVersionSpecs();

  try {
    window.electron?.onLicenseChanged?.((ent) => {
      try {
        if (ent?.valid) lastCheckoutOpenedAt = 0;
        render(ent);
      } catch {}
    });
  } catch {}

  const rerenderAccountI18n = () => {
    refreshSubscribeControlsI18n();
    renderVersionSpecs(lastVersionSpecs);
    render(lastEntitlement);
    renderSubscribeStatus();
    renderInstallStatus();
    renderVersionStatusFromKey();
  };

  const bindAccountI18nListeners = () => {
    if (window.__LEADAE_ACCOUNT_I18N_BOUND__) return true;
    const i18n = window.i18n;
    if (!i18n?.on) return false;

    window.__LEADAE_ACCOUNT_I18N_BOUND__ = true;
    i18n.on('languageChanged', rerenderAccountI18n);
    i18n.on('initialized', rerenderAccountI18n);
    i18n.on('loaded', rerenderAccountI18n);

    if (i18n.isInitialized) {
      rerenderAccountI18n();
    }
    return true;
  };

  if (!bindAccountI18nListeners()) {
    const maxAttempts = 50;
    let attempts = 0;
    const retryTimer = setInterval(() => {
      attempts += 1;
      if (bindAccountI18nListeners() || attempts >= maxAttempts) {
        clearInterval(retryTimer);
      }
    }, 100);

    const docReadyEvents = ['i18n-ready', 'i18n-initialized', 'lae:i18n-ready'];
    const onPotentialI18nReady = () => {
      if (!bindAccountI18nListeners()) return;
      for (const eventName of docReadyEvents) {
        document.removeEventListener(eventName, onPotentialI18nReady);
      }
      clearInterval(retryTimer);
    };

    for (const eventName of docReadyEvents) {
      document.addEventListener(eventName, onPotentialI18nReady, { once: true });
    }
  }

  refresh(false);
})();
