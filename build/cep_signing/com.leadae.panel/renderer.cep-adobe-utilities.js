/* global CSInterface, panelDebug, SystemPath */
(() => {
  let __adobeJobPlan = null;
  let premiereConnected = false;
  let jsxRetryTimer = null;

  // Premiere scripting must NEVER control backend socket lifecycle
  const JSX_RETRY_MS = 1500;

  // Stamp this file so we can prove which build is running on each machine
  const PANEL_BUILD_ID = 'cep-hide-debug-window-2026-03-09';

  // Fallback: if ScriptPath didn't load for some reason, we allow ONE evalFile attempt
  let jsxLoadAttempted = false;

  // Backend bridge connection state (keep this independent from ExtendScript/Premiere)
  let __leadAE_connectInFlight = false;
  let __leadAE_lastConnectAttemptAt = 0;
  let __leadAE_reconnectTimer = null;
  let __leadAE_reconnectBackoffMs = 1000;
  const __leadAE_reconnectBackoffMaxMs = 30000;
  let __leadAE_lastBroadcastPayload = '';

  function isExplicitCepDebugUiEnabled() {
    if (window.electron?.isPackaged === true) {
      return false;
    }

    return (
      window.__LEADAE_ENABLE_CEP_DEBUG_UI__ === true ||
      window.DEBUG_UI === true ||
      window.electron?.DEBUG_UI === true
    );
  }

  function applyPanelDebugMode(_creds) {
    const enabled = isExplicitCepDebugUiEnabled();

    try {
      if (typeof window.setPanelDebugVisibility === 'function') {
        window.setPanelDebugVisibility(enabled);
      }
    } catch {}

    return enabled;
  }

  function buildEvalScript(fn, config) {
    // Always pass a single JSON string arg into JSX and wrap the call in try/catch
    let callArg = '';
    if (typeof config !== 'undefined') {
      const json = (typeof config === 'string' ? config : JSON.stringify(config))
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
      callArg = `'${json}'`;
    }
    // Return an IIFE that catches and returns error text instead of making CEP show "EvalScript error."
    return `(function(){try{ return ${fn}(${callArg}); }catch(e){ try{ $.writeln('❌ ${fn} failed: '+e); }catch(_){} return 'err|' + e; }})()`;
  }

  function safeEvalScript(csInterface, fn, config, cb) {
    const script = buildEvalScript(fn, config);
    return csInterface.evalScript(script, cb);
  }

  let bridgeCredentials;
  let checklistResetTimer;
  let currentJobId = null;
  const proxyDispatchTracker = new Map();
  // Phase memoization removed — we trust JSX events as the single source of truth.

  async function loadBridgeCredentials(force = false) {
    // Cache is fine only while the token is still valid. Tokens can rotate while the panel stays open.
    if (!force && bridgeCredentials?.token && bridgeCredentials?.port) {
      const expiresAt = Number(bridgeCredentials.expiresAt || 0);
      // If we don't know the expiry, keep the cached value.
      if (!expiresAt) return bridgeCredentials;
      // Refresh if the token is expired or about to expire within 60s.
      if (Date.now() < (expiresAt - 60000)) return bridgeCredentials;
    }

    const normalizeCreds = creds => {
      if (!creds?.token) return null;
      const token = String(creds.token || '').trim();
      if (!token) return null;
      const explicitPort = Number(creds.port);
      const metadataBaseUrl = typeof creds.baseUrl === 'string' ? creds.baseUrl : '';
      const metadataPort = metadataBaseUrl
        ? Number((metadataBaseUrl.match(/:(\d+)(?:\/|$)/) || [])[1])
        : NaN;
      const port = Number.isFinite(explicitPort) && explicitPort > 0
        ? explicitPort
        : metadataPort;
      if (!Number.isFinite(port) || port <= 0) return null;

      return {
        ...creds,
        token,
        expiresAt: Number(creds.expiresAt || 0) || undefined,
        port,
        baseUrl: `http://127.0.0.1:${port}`
      };
    };

    const setCreds = creds => {
      const normalized = normalizeCreds(creds);
      if (!normalized) return null;
      bridgeCredentials = normalized;
      applyPanelDebugMode(bridgeCredentials);
      return bridgeCredentials;
    };

    if (window.electron?.invoke) {
      try {
        const creds = await window.electron.invoke('bridge:get-credentials');
        if (creds && creds.ok === false) {
          const port = Number(creds.port);
          const msg =
            creds.code === 'EADDRINUSE'
              ? `Bridge port ${port} is already in use. Quit other copies of LEAD AE – ASSIST and retry.`
              : `Bridge credentials unavailable: ${creds.error || 'unknown error'}`;
          debugLog(`❌ ${msg}`);
          throw new Error(msg);
        }
        const finalized = setCreds(creds);
        if (finalized) return finalized;
      } catch (err) {
        debugLog(`⚠️ Failed to read bridge credentials via IPC: ${err?.message || err}`);
      }
    }

    // Prefer desktop app userData bridge.json (canonical source of truth)
    try {
      if (window.cep?.fs && typeof CSInterface !== 'undefined') {
        const cs = new CSInterface();
        const userDataRoot = cs.getSystemPath(SystemPath.USER_DATA);
        // Canonical location written by the desktop app (bridgeAuthService):
        // macOS:   ~/Library/Application Support/LeadAEAssist/bridge/bridge.json
        // Windows: %APPDATA%\LeadAEAssist\bridge\bridge.json
        const canonicalBridgePath = `${userDataRoot}/LeadAEAssist/bridge/bridge.json`;
        // Legacy location written by older builds:
        const legacyBridgePath = `${userDataRoot}/LeadAEAssist/config/bridge.json`;
        // Older/root-level location (avoid preferring this; it can be stale if created manually):
        const rootBridgePath = `${userDataRoot}/bridge/bridge.json`;
        const candidates = [canonicalBridgePath, legacyBridgePath, rootBridgePath];
        const found = [];

        for (const path of candidates) {
          const res = window.cep.fs.readFile(path);
          if (res?.err === 0 && res?.data) {
            try {
              const json = JSON.parse(res.data);
              const normalized = normalizeCreds({ ...json, filePath: path });
              if (normalized) found.push(normalized);
            } catch {
              debugLog(`⚠️ Invalid bridge.json (parse error): ${path}`);
            }
          } else if (res?.err) {
            debugLog(`⚠️ userData bridge.json read error ${res.err}: ${path}`);
          }
        }

        if (found.length) {
          const prefRank = (p) =>
            p === canonicalBridgePath ? 0 :
            p === legacyBridgePath ? 1 :
            p === rootBridgePath ? 2 : 3;

          found.sort((a, b) => {
            const ea = Number(a.expiresAt || 0);
            const eb = Number(b.expiresAt || 0);
            if (eb !== ea) return eb - ea; // newest expiry wins
            return prefRank(a.filePath) - prefRank(b.filePath);
          });

          if (found.length > 1) {
            debugLog(
              `🧭 Multiple bridge.json candidates found; selected ${found[0].filePath} (expiresAt=${found[0].expiresAt || 'unknown'})`
            );
          }

          return setCreds(found[0]);
        }
      }
    } catch (err) {
      debugLog(`⚠️ Unable to load userData bridge.json: ${err?.message || err}`);
    }

    // Fallback: read bridge.json from the CEP extension folder.
    try {
      if (window.cep?.fs && typeof CSInterface !== 'undefined') {
        const cs = new CSInterface();
        const bridgePath = `${cs.getSystemPath(SystemPath.EXTENSION)}/bridge.json`;
        const res = window.cep.fs.readFile(bridgePath);
        if (res?.err === 0 && res?.data) {
          const json = JSON.parse(res.data);
          const finalized = setCreds({ ...json, filePath: bridgePath });
          if (finalized) return finalized;
        } else if (res?.err) {
          debugLog(`⚠️ bridge.json read error ${res.err}: ${bridgePath}`);
        }
      }
    } catch (err) {
      debugLog(`⚠️ Unable to load bridge.json: ${err?.message || err}`);
    }

    throw new Error('Unable to load bridge credentials');
  }

  function debugLog(msg) {
    if (typeof panelDebug === 'function') panelDebug(msg);
    console.log(msg);
  }

  function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timeoutId));
  }

  function clearReconnectTimer() {
    if (__leadAE_reconnectTimer) {
      clearTimeout(__leadAE_reconnectTimer);
      __leadAE_reconnectTimer = null;
    }
  }

  function resetReconnectBackoff() {
    __leadAE_reconnectBackoffMs = 1000;
  }

  function scheduleBridgeReconnect(message, { force = true, immediate = false, resetBackoff = false } = {}) {
    try {
      if (resetBackoff) resetReconnectBackoff();
      clearReconnectTimer();
      const delay = immediate ? 0 : __leadAE_reconnectBackoffMs;
      debugLog(message);
      __leadAE_reconnectTimer = setTimeout(() => {
        __leadAE_reconnectTimer = null;
        connectToLeadAE(!!force);
      }, delay);
      __leadAE_reconnectBackoffMs = Math.min(
        __leadAE_reconnectBackoffMaxMs,
        Math.round(__leadAE_reconnectBackoffMs * 1.6)
      );
    } catch (err) {
      console.warn('Failed to schedule bridge reconnect', err);
    }
  }

  function renderChecklist(steps) {
    const ul = document.querySelector('#job-checklist ul');
    if (!ul) return;
    ul.innerHTML = '';
    for (const s of steps) {
      const li = document.createElement('li');
      li.dataset.step = s.key;
      li.innerHTML = `<span class="status">⬜</span> ${s.label}`;
      ul.appendChild(li);
    }
    const panel = document.getElementById('job-checklist');
    if (panel) {
      panel.style.display = steps.length <= 2 ? 'none' : '';
    }
    // Seed like the old panel: first *non-complete* step becomes pending; NEVER pend "complete".
    const first = document.querySelector('#job-checklist li[data-step]:not([data-step="complete"])');
    if (first) updateChecklist(first.dataset.step, 'pending');
  }

  // Build the checklist based on the selected actions for this run.
  function buildChecklistFromConfig(cfg = {}) {
    const steps = [
      { key: 'validate', label: 'Validate' },
      ...(cfg.importPremiere ? [{ key: 'import', label: 'Import Media' }] : []),
      ...(cfg.createBins ? [{ key: 'bins', label: 'Create Bins' }] : []),
      ...(cfg.generateProxies
        ? [{ key: 'proxies', label: 'Generate Proxies' }]
        : []),
      { key: 'complete', label: 'Complete' }
    ];

    renderChecklist(steps);
  }

  function clearChecklistResetTimer() {
    if (checklistResetTimer) {
      clearTimeout(checklistResetTimer);
      checklistResetTimer = undefined;
    }
  }

  function scheduleChecklistReset(delayMs = 5000) {
    clearChecklistResetTimer();
    checklistResetTimer = window.setTimeout(() => {
      resetChecklist({ blank: true });
      checklistResetTimer = undefined;
    }, delayMs);
  }

  function resetChecklist(options = {}) {
    const { blank = false } = options;
    const panel = document.getElementById('job-checklist');

    if (blank) {
      const list = panel?.querySelector('ul');
      if (list) list.innerHTML = '';
      if (panel) panel.style.display = 'none';
      return;
    }

    document.querySelectorAll('#job-checklist li').forEach(li => {
      li.className = '';
      const statusEl = li.querySelector('.status');
      if (statusEl) statusEl.textContent = '⬜';
    });
  }

  function updateChecklist(stage, status) {
    const li = document.querySelector(`#job-checklist li[data-step="${stage}"]`);
    if (!li) return;
    li.className = status || '';
    const statusEl = li.querySelector('.status');
    if (!statusEl) return;
    statusEl.textContent =
      status === 'active' || status === 'pending'
        ? '⏳'
        : status === 'done'
          ? '✅'
          : status === 'error'
            ? '❌'
            : '⬜';
  }

  function loadAdobeUtilitiesJSX(cb) {
    const callback = typeof cb === 'function' ? cb : () => {};

    try {
      const cs = new CSInterface();

      const getBackendConnected = () =>
        window.__leadAE_socket?.readyState === (window.WebSocket?.OPEN ?? 1);

      const updatePremiereState = connected => {
        premiereConnected = connected;
        window.__leadAE_jsx_ready = connected;
        broadcastState({ backend: getBackendConnected(), premiere: connected });
      };

      // Diagnostic: prove whether ExtendScript is responding at all (fast, harmless)
      cs.evalScript('1+1', out => {
        debugLog(`🧪 evalScript(1+1) => ${out}`);
      });

      const probe = (label, done) => {
        cs.evalScript(
          "(function(){try{return typeof $.global.LEADAE_test;}catch(e){return 'err|'+e;}})()",
          out => {
            debugLog(`🔍 LEADAE_test type${label ? ' ' + label : ''}: ${out}`);
            done(out);
          }
        );
      };

      probe('', out => {
        if (out === 'function') {
          if (jsxRetryTimer) {
            clearInterval(jsxRetryTimer);
            jsxRetryTimer = null;
          }
          updatePremiereState(true);
          callback(true);
          return;
        }

        // If ExtendScript is totally wedged, CEP returns "EvalScript error."
        if (out === 'EvalScript error.') {
          updatePremiereState(false);
          if (!jsxRetryTimer) {
            jsxRetryTimer = setInterval(() => {
              probe('(retry)', retryOut => {
                debugLog(`🔁 JSX retry result: ${retryOut}`);
                if (retryOut === 'function') {
                  clearInterval(jsxRetryTimer);
                  jsxRetryTimer = null;
                  updatePremiereState(true);
                }
              });
            }, JSX_RETRY_MS);
          }
          callback(false);
          return;
        }

        // Fallback: if ScriptPath didn't load for some reason, try ONE evalFile.
        if (!jsxLoadAttempted) {
          jsxLoadAttempted = true;
          const jsxPath = `${cs.getSystemPath(SystemPath.EXTENSION)}/jsx/adobe-utilities.jsx`;
          debugLog(`📂 Fallback $.evalFile: ${jsxPath}`);

          safeEvalScript(cs, '$.evalFile', jsxPath, () => {
            probe('(post-evalFile)', out2 => {
              if (out2 === 'function') {
                if (jsxRetryTimer) {
                  clearInterval(jsxRetryTimer);
                  jsxRetryTimer = null;
                }
                updatePremiereState(true);
                callback(true);
                return;
              }

              updatePremiereState(false);
              if (!jsxRetryTimer) {
                jsxRetryTimer = setInterval(() => {
                  probe('(retry)', retryOut => {
                    debugLog(`🔁 JSX retry result: ${retryOut}`);
                    if (retryOut === 'function') {
                      clearInterval(jsxRetryTimer);
                      jsxRetryTimer = null;
                      updatePremiereState(true);
                    }
                  });
                }, JSX_RETRY_MS);
              }
              callback(false);
            });
          });

          return;
        }

        // Otherwise, just retry later (probe only; do not evalFile repeatedly)
        updatePremiereState(false);

        if (!jsxRetryTimer) {
          jsxRetryTimer = setInterval(() => {
            probe('(retry)', retryOut => {
              debugLog(`🔁 JSX retry result: ${retryOut}`);
              if (retryOut === 'function') {
                clearInterval(jsxRetryTimer);
                jsxRetryTimer = null;
                updatePremiereState(true);
              }
            });
          }, JSX_RETRY_MS);
        }

        callback(false);
      });
    } catch (err) {
      debugLog(`❌ loadAdobeUtilitiesJSX error: ${err.message}`);
      callback(false);
    }
  }

  async function ensurePremiereConnected() {
    return new Promise(resolve => {
      loadAdobeUtilitiesJSX(loaded => {
        if (!loaded) return resolve(false);
        const cs = new CSInterface();
        // First: trivial JSX call that does not depend on Premiere project state
        safeEvalScript(cs, '$.global.HELLO_TEST', undefined, hello => {
          debugLog(`🔍 HELLO_TEST: ${hello}`);

          const okHello =
            typeof hello === 'string' &&
            hello !== 'EvalScript error.' &&
            !hello.startsWith('err|') &&
            hello.toLowerCase().indexOf('hello') !== -1;

          // Always log LEADAE_test for richer diagnostics, but don't block "connected" on project state
          safeEvalScript(cs, '$.global.LEADAE_test', undefined, res => {
            debugLog(`🔍 LEADAE_test: ${res}`);
            if (okHello) return resolve(true);
            resolve(typeof res === 'string' && res.startsWith('ok|'));
          });
        });
      });
    });
  }

  function initCS() {
    try {
      window.csInterface = new CSInterface();
      debugLog('✅ CSInterface initialized');
    } catch (err) {
      debugLog(`❌ CSInterface init error: ${err.message}`);
      window.csInterface = undefined;
    }
  }

  // Prevent re-binding CSInterface listeners on reconnects
  window.__premiereEventsBound = window.__premiereEventsBound || false;
  function registerPremiereEvents() {
    if (!window.csInterface) return;
    if (window.__premiereEventsBound) return;
    window.__premiereEventsBound = true;

    // Fallback timer in case we never see a 'queue-job-complete'
    let __proxiesDoneFallbackTimer;

    function handleJobProgress(payload) {
      if (payload.panel !== 'adobe-utilities') return;
      clearChecklistResetTimer();
      const stageMap = {
        validate: 'validate',
        copy: 'validate',
        import: 'import',
        bins: 'bins',
        proxies: 'proxies',
        complete: 'complete'
      };
      const stageKey = String(payload.stage || '').toLowerCase();
      const step = stageMap[stageKey];
      const pct = Number(payload.percent || 0);
      // Legacy: naked percent:100 ⇒ finalize immediately
      if (!stageKey && pct >= 100) {
        updateChecklist('complete', 'done');
        document.querySelectorAll('#job-checklist li').forEach(li => updateChecklist(li.dataset.step, 'done'));
        scheduleChecklistReset();
        return;
      }
      if (!step) return;
      const status = String(payload.status || 'start').toLowerCase();
      if (status === 'error') {
        if (step !== 'complete') updateChecklist(step, 'error');
        return;
      }
      if (status === 'complete') {
        if (step === 'proxies') {
          updateChecklist('proxies', 'done');
          clearTimeout(__proxiesDoneFallbackTimer);
          __proxiesDoneFallbackTimer = setTimeout(() => {
            updateChecklist('complete', 'done');
            document.querySelectorAll('#job-checklist li').forEach(li => updateChecklist(li.dataset.step, 'done'));
            scheduleChecklistReset();
          }, 1200);
          return;
        }
        if (step === 'complete') {
          if (pct >= 100) {
            updateChecklist('complete', 'done');
            document.querySelectorAll('#job-checklist li').forEach(li => updateChecklist(li.dataset.step, 'done'));
            scheduleChecklistReset();
          }
        } else {
          updateChecklist(step, 'done');
        }
        return;
      }
      // start/running → pend current step (never pend "complete")
      if ((status === 'running' || status === 'start') && step !== 'complete') {
        document
          .querySelectorAll('#job-checklist li.pending, #job-checklist li.active')
          .forEach(li => {
            if (li.dataset.step !== step && li.dataset.step !== 'complete') {
              updateChecklist(li.dataset.step, 'done');
            }
          });
        updateChecklist(step, 'pending');
        return;
      }
    }

    function handleJobComplete(job) {
      if ((job?.panel || '').toLowerCase() !== 'adobe-utilities') return;
      clearChecklistResetTimer();

      const active = document.querySelector('#job-checklist li.pending, #job-checklist li.active');
      if (active && active.dataset.step !== 'complete') updateChecklist(active.dataset.step, 'done');
      updateChecklist('complete', 'done');
      document.querySelectorAll('#job-checklist li').forEach(li => updateChecklist(li.dataset.step, 'done'));
      scheduleChecklistReset();
      return;
    }

    function summarizeQueuePayloadShape(value) {
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      if (type === 'string') {
        const trimmed = value.trim();
        return {
          type,
          length: value.length,
          startsWith: trimmed.slice(0, 1),
          endsWith: trimmed.slice(-1),
          preview: trimmed.slice(0, 180)
        };
      }
      if (type === 'array') {
        return { type, length: value.length };
      }
      if (type === 'object') {
        const keys = Object.keys(value);
        return { type, keys: keys.slice(0, 12), keyCount: keys.length };
      }
      return { type };
    }

    function logQueuePayloadParseFailure(eventName, reason, data, err) {
      const details = {
        event: eventName,
        reason,
        shape: summarizeQueuePayloadShape(data)
      };
      if (err) details.error = err?.message || String(err);
      debugLog(`❌ queue payload parse failure ${JSON.stringify(details)}`);
    }

    function parseQueueEventPayload(event, eventName) {
      const data = event?.data;
      let payload;

      if (typeof data === 'string') {
        const clean = data.trim();
        let jsonCandidate = clean;

        if (clean.startsWith('(') && clean.endsWith(')')) {
          jsonCandidate = clean.slice(1, -1).trim();
        }

        try {
          payload = JSON.parse(jsonCandidate);
        } catch (err) {
          logQueuePayloadParseFailure(eventName, 'invalid_json_string', data, err);
          return null;
        }
      } else if (data && typeof data === 'object') {
        payload = data; // already parsed
      } else {
        logQueuePayloadParseFailure(eventName, 'unsupported_payload_type', data);
        return null;
      }

      if (!payload || typeof payload !== 'object') {
        logQueuePayloadParseFailure(eventName, 'non_object_payload', payload);
        return null;
      }

      return payload;
    }

    // parseQueueEventPayload examples (fixture-style expectations):
    // 1) '{"jobId":"abc","progress":10}'         => object (valid)
    // 2) '[{"jobId":"abc"},{"jobId":"def"}]'    => array (valid)
    // 3) '({"jobId":"abc","status":"done"})'   => object (valid parenthesized JSON)
    // 4) '({jobId:"abc",status:"done"})'           => null + parse failure log (invalid object-literal syntax)
    // 5) '{"jobId":"abc"'                          => null + parse failure log (malformed/partial JSON)

    function parseProxyAttachSummary(text) {
      const s = String(text ?? '').trim();
      const m = /Attached\s+(\d+)\s*\/\s*(\d+)\s+proxies\s*\(missing:\s*(\d+),\s*failed:\s*(\d+),\s*already:\s*(\d+)\)/i.exec(s);
      if (!m) return { ok: false, attached: 0, total: 0, missing: 0, failed: 0, already: 0, text: s };
      const attached = Number(m[1]);
      const total = Number(m[2]);
      const missing = Number(m[3]);
      const failed = Number(m[4]);
      const already = Number(m[5]);
      const ok = total > 0 && missing === 0 && failed === 0 && (attached + already) >= total;
      return { ok, attached, total, missing, failed, already, text: s };
    }

    window.csInterface.addEventListener('premiere-attach-proxy', e => {
      let pairs = [];
      try {
        pairs = JSON.parse(e.data || '[]');
      } catch (err) {
        debugLog(`❌ premiere-attach-proxy parse error: ${err}`);
      }
      if (pairs && pairs.length) {
        // 🧩 Smart attach with 3-second grace window for Premiere to index imports
        const payload = JSON.stringify({ pairs, maxSeconds: 15 });
        const maxWaitMs = 3000;
        const startTime = Date.now();

        const tryImmediateAttach = () => {
          safeEvalScript(window.csInterface, '$.global.LEADAE_attachProxyWithRetry', payload, res => {
            const text = String(res ?? '');
            debugLog(`🔗 [WS] Proxy attach result: ${text}`);
            const info = parseProxyAttachSummary(text);
            const ok = info.ok;
            if (ok) {
              debugLog('✅ Proxy attach succeeded after short wait.');
              return;
            }
            if (Date.now() - startTime < maxWaitMs) {
              setTimeout(tryImmediateAttach, 500);
            } else {
              debugLog('⚠️ Proxy attach not confirmed yet — retry queued in JSX (up to ~15s).');
            }
          });
        };
        tryImmediateAttach();
      } else {
        debugLog('ℹ️ premiere-attach-proxy fired with no pairs');
      }
    });
    // 🔊 Show all JSX debug logs in the panel
    window.csInterface.addEventListener('leadAE-log', e => {
      try {
        const msg = e.data || '';
        debugLog('📝 JSX: ' + msg);
      } catch (err) {
        console.error('❌ Failed to parse leadAE-log', err);
      }
    });


    const WS_OPEN = window.WebSocket?.OPEN ?? 1;
    function sendToBridge(type, payload) {
      try {
        if (window.__leadAE_socket?.readyState === WS_OPEN) {
          window.__leadAE_socket.send(
            JSON.stringify({ type, ...payload })
          );
        }
      } catch (err) {
        debugLog(`❌ Bridge send failed: ${err}`);
      }
    }

    window.csInterface.addEventListener('queue-job-progress', e => {
      const payload = parseQueueEventPayload(e, 'queue-job-progress');
      if (!payload) return;

      handleJobProgress(payload);
      // 🔁 Forward CEP stage to backend bridge so Electron updates in lockstep
      sendToBridge('queue-job-progress', payload);
    });

    window.csInterface.addEventListener('queue-job-complete', e => {
      const payload = parseQueueEventPayload(e, 'queue-job-complete');
      if (!payload) return;
      // cancel fallback if real complete arrives
      try { clearTimeout(__proxiesDoneFallbackTimer); } catch (_) {}
      handleJobComplete(payload);
      // 🔁 Forward final completion as well
      sendToBridge('queue-job-complete', payload);
    });

    // Treat cancellations as terminal to avoid a stuck checklist
    window.csInterface.addEventListener('queue-job-cancelled', e => {
      try { clearTimeout(__proxiesDoneFallbackTimer); } catch (_) {}
      updateChecklist('complete', 'done'); // end the run visually
      scheduleChecklistReset();
      // Also clear any sticky proxy state in ExtendScript so the next run is clean
      try { safeEvalScript(window.csInterface, '$.global.LEADAE_resetProxyState', { clearAll: true }, function(){}); } catch (_) {}
    });
  }

  function handleBridgeMessage(e) {
    debugLog(`📩 ${e.data}`);
    let msg;
    if (typeof e.data === 'string') {
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        debugLog(`❌ WS message parse error: ${err}`);
        return;
      }
    } else if (typeof e.data === 'object') {
      msg = e.data;
    } else {
      return;
    }

    // Mirror backend progress/completion into CSXSEvents so the existing UI handlers run
    if (msg?.type === 'queue-job-progress' && msg.panel === 'adobe-utilities') {
      const packed = { type: 'queue-job-progress', payload: msg };
      safeEvalScript(window.csInterface, '$.global.LEADAE_emitPackedEvent', packed);
      return;
    }
    if (msg?.type === 'queue-job-complete' &&
        (msg.panel === 'adobe-utilities' || msg.job?.panel === 'adobe-utilities')) {
      // Send a tiny completion payload into CEP to avoid JSON parsing issues on big logs.
      const compact = {
        panel: msg.job?.panel || msg.panel || 'adobe-utilities',
        origin: 'backend',
        jobId: String(msg.job?.id || msg.jobId || '')
      };
      const packed = { type: 'queue-job-complete', payload: compact };
      safeEvalScript(window.csInterface, '$.global.LEADAE_emitPackedEvent', packed);
      return;
    }
    if (msg?.type === 'queue-job-cancelled' && msg.panel === 'adobe-utilities') {
      const packed = { type: 'queue-job-cancelled', payload: msg };
      safeEvalScript(window.csInterface, '$.global.LEADAE_emitPackedEvent', packed);
      return;
    }

    if (msg?.type === 'job-added' && msg.job?.panel === 'adobe-utilities') {
      __adobeJobPlan = Object.assign({}, msg.job.config || {});
      try {
        buildChecklistFromConfig(__adobeJobPlan);
      } catch (err) {
        debugLog(`⚠️ buildChecklistFromConfig failed: ${err}`);
      }
      return;
    }

    if (msg?.type === 'connection-state') {
      setReconnectButtonState({
        backend: !!msg.backend,
        premiere: !!msg.premiere
      });
      return;
    }

    // Allow backend WebSocket message to trigger proxy attachment
    if (msg?.type === 'premiere-attach-proxy') {
      const pairs = Array.isArray(msg.pairs)
        ? msg.pairs
        : typeof msg.data === 'string'
          ? (() => {
            // msg.data often arrives as an escaped JSON string like [{\"original\":...}]
            const raw = msg.data;
            try {
              const first = JSON.parse(raw);
              // If it was a JSON-encoded string, parse again.
              if (typeof first === 'string') return JSON.parse(first);
              return first;
            } catch (_) {
              try {
                return JSON.parse(String(raw).replace(/\\"/g, '"'));
              } catch {
                return [];
              }
            }
          })()
        : [];

      if (!pairs.length) {
        debugLog('ℹ️ premiere-attach-proxy (WS) received with no pairs');
        return;
      }

      // 🧩 Smart attach with 3-second grace window for Premiere to index imports
      const payload = JSON.stringify({ pairs, maxSeconds: 15 });
      const maxWaitMs = 3000;
      const startTime = Date.now();

      const tryImmediateAttach = () => {
        safeEvalScript(window.csInterface, '$.global.LEADAE_attachProxyWithRetry', payload, res => {
          const text = String(res ?? '');
          debugLog(`🔗 [WS] Proxy attach result: ${text}`);
          const info = parseProxyAttachSummary(text);
          const ok = info.ok;
          if (ok) {
            debugLog('✅ Proxy attach succeeded after short wait.');
            return;
          }
          if (Date.now() - startTime < maxWaitMs) {
            setTimeout(tryImmediateAttach, 500);
          } else {
            debugLog('⚠️ Proxy attach not confirmed yet — retry queued in JSX (up to ~15s).');
          }
        });
      };
      tryImmediateAttach();
      return;
    }

    // Allow backend to reset the JSX proxy poller/job state (used for FFmpeg fallback or cancellation).
    if (msg?.type === 'premiere-reset-proxy-state') {
      const opts = typeof msg.opts === 'object' && msg.opts ? msg.opts : { clearAll: true };
      const doReset = () => {
        safeEvalScript(window.csInterface, '$.global.LEADAE_resetProxyState', JSON.stringify(opts), res => {
          debugLog(`🧹 Proxy state reset: ${String(res ?? '')}`);
        });
      };

      if (!window.__leadAE_jsx_ready) {
        loadAdobeUtilitiesJSX(ok => {
          window.__leadAE_jsx_ready = ok === true;
          if (ok !== true) {
            debugLog('❌ Proxy state reset skipped: Adobe utilities JSX failed to load.');
            return;
          }
          doReset();
        });
      } else {
        doReset();
      }
      return;
    }

    if (!window.csInterface) {
      debugLog('⚠️ CSInterface not ready');
      return;
    }

    if (msg.type === 'runIngestWorkflow') {
      const cfg = msg.config || {};

      // Always reset UI for new ingest job
      clearChecklistResetTimer();
      resetChecklist();
      updateChecklist('validate', 'active');

      const isProxyRequest = !!(cfg.generateProxies && cfg.proxyPreset);
      let trackerKey;
      let tracker;
      let proxyKey;
      if (isProxyRequest) {
        const jobKey = String(cfg.jobId || cfg.id || '');
        const groupKey = cfg.groupKey || cfg.groupId || cfg.__groupId || '';
        const sourcesKey = Array.isArray(cfg.sources)
          ? [...cfg.sources].sort().join('|')
          : '';
        const rawPreset = String(cfg.proxyPreset || '');
        const presetKey = /temp-presets\/LeadAE_(proxy|dupe)_/i.test(rawPreset) ? '<temp>' : rawPreset;
        proxyKey = [groupKey, sourcesKey, presetKey].filter(Boolean).join('::');
        if (!proxyKey && sourcesKey) proxyKey = sourcesKey;
        if (!proxyKey) {
          try {
            proxyKey = JSON.stringify({ sources: cfg.sources || [], preset: presetKey, groupKey });
          } catch (_) {
            proxyKey = String(Date.now());
          }
        }
        trackerKey = jobKey || '__global__';
        tracker = proxyDispatchTracker.get(trackerKey);
        if (!tracker) {
          tracker = new Set();
          proxyDispatchTracker.set(trackerKey, tracker);
        }
        if (tracker.has(proxyKey)) {
          debugLog('🔒 Skipping duplicate AME queue request for this group.');
          return;
        }
        tracker.add(proxyKey);
      }

      // Direct, unconditional call into ExtendScript
      if (typeof window.csInterface !== 'undefined') {
        debugLog(
          isProxyRequest
            ? '🚀 AME QUEUE → calling LEADAE_generateProxies (once per group)'
            : '🚀 Dispatching runIngestWorkflow to ExtendScript (force mode)'
        );
        safeEvalScript(window.csInterface, '$.global.runIngestWorkflow', cfg, res => {
          if (isProxyRequest) {
            debugLog(`🎯 JSX return: ${res}`);
            let sRes = '';
            try {
              sRes = String(res ?? '');
              if (sRes.indexOf('err|ReferenceError') === 0 || /ReferenceError/.test(sRes)) {
                debugLog(
                  '⛔ JSX ReferenceError detected: ' +
                    sRes +
                    ' — recommended: add Array.isArray polyfill to adobe-utilities.jsx'
                );
              } else if (sRes.indexOf('err|') === 0) {
                debugLog('⛔ JSX reported error: ' + sRes);
              }
            } catch (e) {
              debugLog('⚠️ error while parsing JSX return: ' + e);
            }
            if (sRes.indexOf('error|no_AME_jobs') === 0) {
              debugLog(
                '⛔️ JSX reported no AME jobs enqueued. This means AME never accepted the queue call. (We will NOT claim success.)'
              );
              try {
                sendToBridge('queue-job-progress', {
                  panel: 'adobe-utilities',
                  stage: 'proxies',
                  status: 'error',
                  percent: 0,
                  message: 'AME did not accept any jobs (no_AME_jobs)'
                });
              } catch (_) {}
            }
          } else {
            debugLog(`🎬 runIngestWorkflow result: ${res}`);
          }
        });
      } else {
        if (isProxyRequest && tracker && proxyKey) {
          tracker.delete(proxyKey);
        }
        debugLog('❌ CSInterface unavailable — cannot dispatch runIngestWorkflow');
      }

      // Ensure reconnect button reflects correct state
      try {
        setReconnectButtonState({ backend: true, premiere: true });
      } catch (_) {}

      // Track current job id (for logging/UI only)
      currentJobId = String(cfg?.jobId || cfg?.id || '');
    }

    if (msg.type === 'LEADAE_importMedia') {
      const pathsStr = JSON.stringify(msg.paths);
      safeEvalScript(
        window.csInterface,
        '$.global.LEADAE_importMedia',
        pathsStr,
        res => debugLog(`🎬 Import result: ${res}`)
      );
    }

    if (msg.type === 'LEADAE_createBins') {
      const binsStr = JSON.stringify(msg.bins);
      safeEvalScript(
        window.csInterface,
        '$.global.LEADAE_createBins',
        binsStr,
        res => debugLog(`📁 Bin result: ${res}`)
      );
    }

    if (msg.type === 'LEADAE_attachProxy') {
      const arg = JSON.stringify(Array.isArray(msg.pairs) ? msg.pairs : []);
      const invoke = () =>
        safeEvalScript(
          window.csInterface,
          '$.global.LEADAE_attachProxy',
          arg,
          res => debugLog(`🔗 [WS] Proxy attach result: ${res}`)
        );

      // If JSX isn't ready yet, load it and then invoke
      if (!window.__leadAE_jsx_ready) {
        loadAdobeUtilitiesJSX(ok => {
          window.__leadAE_jsx_ready = ok;
          invoke();
        });
      } else {
        invoke();
      }
    }
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

  function initializeReconnectButtonState() {
    const openState = window.WebSocket?.OPEN ?? 1;
    const isConnected = window.__leadAE_socket?.readyState === openState;
    setReconnectButtonState({ backend: !!isConnected, premiere: false });
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

  async function connectToLeadAE(force = false) {
    if (window.__leadAE_initialized && !force) return;

    const now = Date.now();
    if (__leadAE_connectInFlight) return;
    if (now - __leadAE_lastConnectAttemptAt < 750) return;

    __leadAE_connectInFlight = true;
    __leadAE_lastConnectAttemptAt = now;
    clearReconnectTimer();
    window.__leadAE_initialized = true;

    try {

    let creds;
    try {
      creds = await loadBridgeCredentials(force);
      debugLog(
        `🔑 Loaded bridge credentials${creds.filePath ? ` from ${creds.filePath}` : ''}`
      );
    } catch (err) {
      debugLog(`❌ Unable to load bridge credentials: ${err?.message || err}`);
      setReconnectButtonState({ backend: false, premiere: false });
      window.__leadAE_initialized = false;
      return;
    }

    try {
      // /health is intentionally unauthenticated; use it for basic collision diagnostics.
      try {
        const res = await fetchWithTimeout(`${creds.baseUrl}/health`, {}, 2500);
        let json = null;
        try { json = await res.json(); } catch (_) {}
        debugLog(`🩺 Bridge health: ${JSON.stringify(json ?? { ok: res.ok, status: res.status })}`);
      } catch (err) {
        debugLog(`⚠️ Bridge health check failed: ${err?.message || err}`);
      }

      // Token validation must hit an authenticated endpoint (heartbeat).
      const heartbeatFetch = async (c) =>
        fetchWithTimeout(
          `${c.baseUrl}/heartbeat`,
          { headers: { Authorization: `Bearer ${c.token}` } },
          3500
        );

      let heartbeatRes;
      try {
        heartbeatRes = await heartbeatFetch(creds);
      } catch (err) {
        debugLog(`⚠️ Bridge heartbeat check failed: ${err?.message || err}`);
        setReconnectButtonState({ backend: false, premiere: false });
        scheduleBridgeReconnect('🔄 Auto-reconnecting to Lead AE bridge…', { force: true });
        return;
      }

      if (heartbeatRes.status === 401 || heartbeatRes.status === 403) {
        debugLog('🔑 Bridge heartbeat rejected — reloading credentials and retrying…');
        bridgeCredentials = undefined;
        creds = await loadBridgeCredentials(true);
        heartbeatRes = await heartbeatFetch(creds);
      }

      if (!heartbeatRes.ok) {
        const msg =
          `❌ Bridge heartbeat failed: ${heartbeatRes.status} ${heartbeatRes.statusText || ''}`.trim();
        debugLog(msg);
        setReconnectButtonState({ backend: false, premiere: false });
        scheduleBridgeReconnect('🔄 Auto-reconnecting to Lead AE bridge…', { force: true });
        return;
      }
    } catch (err) {
      debugLog(`⚠️ Bridge preflight failed: ${err?.message || err}`);
      setReconnectButtonState({ backend: false, premiere: false });
      scheduleBridgeReconnect('🔄 Auto-reconnecting to Lead AE bridge…', { force: true });
      return;
    }

    if (window.__leadAE_socket) {
      try {
        window.__leadAE_socket.removeEventListener('message', handleBridgeMessage);
        try { window.__leadAE_socket.close(1000, 'reconnect'); } catch (_) { window.__leadAE_socket.close(); }
        debugLog('♻️ Closed existing Lead AE socket');
      } catch (err) {
        debugLog(`⚠️ Error closing existing socket: ${err.message || err}`);
      } finally {
        window.__leadAE_runIngestListenerRegistered = false;
      }
    }

    debugLog(`📡 Connecting to Lead AE Assist bridge at ${creds.baseUrl}…`);
    const socket = new WebSocket(creds.baseUrl.replace('http', 'ws'), ['Bearer', creds.token]);
    let pingInterval;

    socket.onopen = () => {
      debugLog('✅ Connected to Lead AE bridge');
      resetReconnectBackoff();
      try {
        socket.send(JSON.stringify({ type: 'hello', from: 'premiere-panel' }));
      } catch {}
      pingInterval = setInterval(() => {
        const OPEN = window.WebSocket?.OPEN ?? 1;
        if (socket.readyState !== OPEN) return;
        try { socket.send(JSON.stringify({ type: 'ping' })); } catch {}
      }, 25000);

      // Backend is connected. Do NOT touch ExtendScript here.
      // Premiere connection is established only on explicit user action (Reconnect) or when needed.
      const state = { backend: true, premiere: false };
      setReconnectButtonState(state);
      broadcastState(state);
      debugLog(`🔄 Broadcast state: ${JSON.stringify(state)}`);
    };

    socket.onclose = e => {
      clearInterval(pingInterval);
      socket.removeEventListener('message', handleBridgeMessage);
      window.__leadAE_runIngestListenerRegistered = false;
      if (window.__leadAE_socket === socket) {
        const state = { backend: false, premiere: false };
        setReconnectButtonState(state);
        broadcastState(state);
        window.__leadAE_socket = undefined;
      }
      debugLog(`🔌 WS closed ${e.code} ${e.reason || ''}`);

      const code = Number(e.code);
      const reason = String(e.reason || '');

      const shouldReconnect =
        code === 1008 || // policy violation (unauthorized / origin_not_allowed)
        code === 4001 || // token_rotated
        code === 1011 || // internal
        code === 1012 || // service restart
        code === 1013 || // try again later
        code === 1006;   // abnormal close (no close frame)

      if (shouldReconnect) {
        if (code === 1008 || code === 4001) {
          // Force a credential reload on auth-related closes.
          bridgeCredentials = undefined;
          scheduleBridgeReconnect(
            `🔄 Auto-reconnecting after auth refresh (${code}${reason ? `:${reason}` : ''})…`,
            { force: true }
          );
          return;
        }
        scheduleBridgeReconnect(
          `🔄 Auto-reconnecting to Lead AE bridge (${code}${reason ? `:${reason}` : ''})…`,
          { force: true }
        );
      }
    };

    socket.onerror = err => debugLog(`❌ WS error ${err.message || err}`);

    if (window.__leadAE_runIngestListenerRegistered) {
      debugLog('⚠️ runIngestWorkflow listener already registered');
    } else {
      socket.addEventListener('message', handleBridgeMessage);
      window.__leadAE_runIngestListenerRegistered = true;
    }

    window.__leadAE_socket = socket;
  } finally {
    __leadAE_connectInFlight = false;
  }

  }

  document.addEventListener('DOMContentLoaded', () => {
    applyPanelDebugMode(null);
    resetChecklist({ blank: true });
    debugLog(`🧱 Panel build: ${PANEL_BUILD_ID}`);
    const startBtn = document.getElementById('start-adobe-utilities');
    startBtn?.addEventListener('click', () => {
      clearChecklistResetTimer();
      resetChecklist();
      updateChecklist('validate', 'active');
    });

    initializeReconnectButtonState();
    if (typeof window.__adobe_cep__ !== 'undefined' && typeof CSInterface !== 'undefined') {
      initCS();
      registerPremiereEvents();
      connectToLeadAE();
      // IMPORTANT: Do NOT call ExtendScript during startup. It can wedge PPro/CEP on clean user machines.

      // Hook Reconnect toggle
      const reconnectInput = getReconnectInput();
      reconnectInput?.addEventListener('change', event => {
        if (reconnectInput.disabled || event.target?.disabled) return;
        debugLog('🔄 Reconnecting…');
        setReconnectButtonState(false);

        initCS();
        registerPremiereEvents();
        // Do NOT reconnect backend here. Only attempt Premiere handshake.
        ensurePremiereConnected().then(connected => {
          debugLog(
            connected ? '✅ Premiere connected after reconnect'
                      : '❌ Premiere still not connected after reconnect'
          );
          const state = { backend: !!(window.__leadAE_socket && window.__leadAE_socket.readyState === (window.WebSocket?.OPEN ?? 1)), premiere: !!connected };
          setReconnectButtonState(state);
          broadcastState(state);
          debugLog(`🔄 Broadcast state: ${JSON.stringify(state)}`);
        });
      });
    } else {
      debugLog('⚠️ Not in CEP environment — skipping CEP init');
    }
  });
})();
