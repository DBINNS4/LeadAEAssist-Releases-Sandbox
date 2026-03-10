/**
 * ExtendScript helpers for LEAD AE Adobe Automate panel.
 * Provides functions to import media, create bins, and generate proxies.
 */

// Ensure PlugPlug is loaded so CSXSEvent().dispatch() works
try {
    if (!$.global.__plugplug_loaded__) {
        $.global.__plugplug_loaded__ = new ExternalObject('lib:PlugPlugExternalObject');
        $.writeln('✅ PlugPlugExternalObject loaded');
    }
} catch (e) {
    $.writeln('❌ Could not load PlugPlugExternalObject: ' + e);
}

// Build stamp for debugging (keep in sync with renderer build id)
$.global.LEADAE_JSX_BUILD_ID = $.global.LEADAE_JSX_BUILD_ID || 'jsx-connfix-2026-01-23';

// If JSON / JSON.parse missing in ExtendScript, provide a strict fallback.
// (Classic json2 approach: validate JSON string, then eval.)
if (typeof JSON === 'undefined') JSON = {};

if (typeof JSON.parse !== 'function') {
    JSON.parse = function (text) {
        text = String(text);
        // basic validation: only legal JSON tokens/whitespace
        // (this is the core json2 safety gate)
        if (/^[\],:{}\s]*$/.test(
            text.replace(/\\["\\\/bfnrtu]/g, '@')
                .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
                .replace(/(?:^|:|,)(?:\s*\[)+/g, '')
        )) {
            return eval('(' + text + ')');
        }
        throw new Error('Invalid JSON');
    };
}

// JSON.stringify can safely fall back to toSource() where available.
if (typeof JSON.stringify !== 'function') {
    JSON.stringify = function (o) {
        try { return o.toSource(); } catch (e) { return String(o); }
    };
}

// --- Polyfill: ensure Array.isArray exists in older ExtendScript runtimes (AME 2025 compatibility) ---
if (typeof Array.isArray !== 'function') {
    Array.isArray = function (v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    };
}
// --- end polyfill ---

function __attachSummaryIsSuccess(summary) {
    summary = String(summary || '');
    var m = /Attached\s+(\d+)\s*\/\s*(\d+)/i.exec(summary);
    var a = /already:\s*(\d+)/i.exec(summary);
    var f = /failed:\s*(\d+)/i.exec(summary);
    var x = /missing:\s*(\d+)/i.exec(summary);
    var attached = m ? Number(m[1]) : 0;
    var total    = m ? Number(m[2]) : 0;
    var already  = a ? Number(a[1]) : 0;
    var failed   = f ? Number(f[1]) : 0;
    var missing  = x ? Number(x[1]) : 0;
    // Success if everything is either newly attached or was already attached
    return total > 0 && missing === 0 && failed === 0 && (attached + already) >= total;
}

/**
 * Forward debug messages from JSX back to CEP panel + Electron.
 */
function debugLog(msg) {
    try {
        $.writeln(msg); // still print inside Premiere debug console
        var evt = new CSXSEvent();
        evt.type = 'leadAE-log';
        evt.scope = 'APPLICATION';
        evt.extensionId = 'com.leadae.panel';
        evt.data = String(msg);
        evt.dispatch();
    } catch (e) {
        $.writeln('❌ debugLog dispatch failed: ' + e);
    }
}

function dispatchQueueEvent(type, payload) {
    try {
        var evt = new CSXSEvent();
        evt.type = type;
        evt.scope = 'APPLICATION';
        evt.extensionId = 'com.leadae.panel';
        // ✅ Always send well-formed JSON so CEP can parse correctly
        if (typeof payload === 'string') {
            // Ensure it's valid JSON string; wrap if necessary
            try {
                JSON.parse(payload); // already JSON?
                evt.data = payload;
            } catch (_) {
                evt.data = JSON.stringify({ message: payload });
            }
        } else {
            evt.data = JSON.stringify(payload || {});
        }
        evt.dispatch();
    } catch (e) {
        debugLog('❌ ' + type + ' dispatch failed: ' + e);
    }
}

$.global.LEADAE_emitPackedEvent = function (packed) {
    try {
        var msg = (typeof packed === 'string') ? JSON.parse(packed) : packed;
        if (!msg || !msg.type) { return 'err|missing type'; }
        dispatchQueueEvent(msg.type, msg.payload || {});
        return 'ok';
    } catch (e) {
        debugLog('❌ LEADAE_emitPackedEvent failed: ' + e);
        return 'err|' + e;
    }
};

debugLog("✅ adobe-utilities.jsx loaded into Premiere");

// ⛳️ Proxy presets are resolved in the Node layer; if "match-source-ffmpeg"
// is provided it indicates the FFmpeg-based auto preset flow handled upstream.

// Global state for proxy polling
$.global.LEADAE_proxyPollTaskId = 0;
$.global.LEADAE_proxyJobs         = $.global.LEADAE_proxyJobs || {};
$.global.LEADAE_proxyJobsStarted  = $.global.LEADAE_proxyJobsStarted || 0;
$.global.LEADAE_encoderBound      = $.global.LEADAE_encoderBound || false;
$.global.LEADAE_queuedProxyPaths  = $.global.LEADAE_queuedProxyPaths || {};
// Targeted re-attach support
$.global.LEADAE_pendingAttach     = $.global.LEADAE_pendingAttach || {};
$.global.LEADAE_retryAttachTimer  = $.global.LEADAE_retryAttachTimer || 0;

// Hard caps to prevent runaway polling/retries (override from panel if needed)
$.global.LEADAE_retryAttachMaxAttempts   = $.global.LEADAE_retryAttachMaxAttempts   || 12; // seconds-ish (1/sec)
$.global.LEADAE_proxyPollMaxSeconds      = $.global.LEADAE_proxyPollMaxSeconds      || 90; // total poll runtime
$.global.LEADAE_proxyAttachMaxAttempts   = $.global.LEADAE_proxyAttachMaxAttempts   || 10; // per proxy file

$.global.LEADAE_resetProxyState = function (opts) {
    var parsedOpts = opts;
    if (typeof opts === 'string') {
        try {
            parsedOpts = JSON.parse(opts);
        } catch (err) {
            debugLog('❌ LEADAE_resetProxyState parse error: ' + err);
            return 'Reset proxy state error: invalid JSON opts';
        }
    }
    opts = parsedOpts || {};
    var clearAll = !!opts.clearAll;
    // Stop thinking jobs are pending
    try { $.global.LEADAE_proxyJobs = {}; } catch (_) {}
    try { $.global.LEADAE_proxyJobsStarted = 0; } catch (_) {}

    // Let the poller exit on next tick by leaving no pending
    try { $.global.LEADAE_proxyPollTaskId = 0; } catch (_) {}

    // Aggressive de-dupe reset if requested
    if (clearAll) {
        try { $.global.LEADAE_queuedProxyPaths = {}; } catch (_) {}
    }

    // Also clear any pending attach retries and poll timing
    try { $.global.LEADAE_pendingAttach = {}; } catch (_) {}
    try { $.global.LEADAE_retryAttachTimer = 0; } catch (_) {}
    try { $.global.LEADAE_proxyPollStartedAt = 0; } catch (_) {}
    return 'ok';
};

function LEADAE_queueAttachRetry(original, proxy, reason, attempt) {
    try {
        var key = new File(proxy).fsName;
        var entry = $.global.LEADAE_pendingAttach[key] || {
            original: original, proxy: proxy, attempts: 0, lastReason: ''
        };
        entry.attempts = (attempt || entry.attempts || 0);
        entry.lastReason = String(reason || '');
        $.global.LEADAE_pendingAttach[key] = entry;
    } catch (_) {}
    // ensure the timer is running
    if (!$.global.LEADAE_retryAttachTimer) {
        $.global.LEADAE_retryAttachTimer = LEADAE_setTimeout(function LEADAE_retryTick() {
            var hasPending = false;
            try {
                var keys = [];
                for (var k in $.global.LEADAE_pendingAttach) { keys.push(k); }
                for (var i = 0; i < keys.length; i++) {
                    var info = $.global.LEADAE_pendingAttach[keys[i]];
                    if (!info) { continue; }
                    hasPending = true;
                    var maxAttempts = Number($.global.LEADAE_retryAttachMaxAttempts || 60);
                    if (info.attempts >= maxAttempts) { // cap ~N seconds
                        try { delete $.global.LEADAE_pendingAttach[keys[i]]; } catch (_) {}
                        continue;
                    }
                    info.attempts++;
                    try {
                        var one = [{ original: info.original, proxy: info.proxy }];
                        var res = $.global.LEADAE_attachProxy(one);
                        if (__attachSummaryIsSuccess(res)) {
                            debugLog('✅ (retry) proxy attach succeeded: ' + String(res));
                            try {
                                dispatchQueueEvent('queue-job-progress', {
                                    panel: 'adobe-utilities', stage: 'attach', status: 'complete', percent: 100,
                                    message: 'Proxy attached (retry)'
                                });
                            } catch (_) {}
                            try { delete $.global.LEADAE_pendingAttach[keys[i]]; } catch (_) {}
                            // ✅ Remove the corresponding proxy job entry so the poller can finish
                            try {
                                var pFs = (new File(info.proxy)).fsName;
                                for (var jid in $.global.LEADAE_proxyJobs) {
                                    var j = $.global.LEADAE_proxyJobs[jid];
                                    if (j && j.proxy) {
                                        var jFs = (new File(j.proxy)).fsName;
                                        if (jFs === pFs) {
                                            try { delete $.global.LEADAE_proxyJobs[jid]; } catch (_) {}
                                        }
                                    }
                                }
                                // Also clear from queued-paths dedupe
                                try { delete $.global.LEADAE_queuedProxyPaths[pFs]; } catch (_) {}
                            } catch (__cleanErr) {}
                            // 🔔 Nudge the poller to detect "no pending" and emit the true completion
                            try {
                                if (!$.global.LEADAE_proxyPollTaskId) {
                                    $.global.LEADAE_proxyPollTaskId = LEADAE_setTimeout($.global.LEADAE_checkProxies, 500);
                                }
                            } catch (_) {}
                        }
                    } catch (e) {
                        // keep for next tick
                    }
                }
            } catch (err) {}
            if (hasPending) {
                $.global.LEADAE_retryAttachTimer = LEADAE_setTimeout(LEADAE_retryTick, 1000);
            } else {
                $.global.LEADAE_retryAttachTimer = 0;
            }
        }, 1000);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical AME callbacks + binding (single copy only)
// ─────────────────────────────────────────────────────────────────────────────
$.global.LEADAE_onProxyComplete = function (jobID, outputFilePath) {
    try {
        debugLog('✅ onProxyComplete: jobID=' + jobID + ' out=' + outputFilePath);
        var jobs = $.global.LEADAE_proxyJobs || {};
        var k = jobID;
        // 2025 may report 0; store under both string and numeric keys just in case.
        var entry = jobs[k] || jobs[String(k)] || jobs[Number(k)];
        if (!entry) {
            // Fallback: match by the actual finished proxy path AME reported.
            try {
                var outFs = (new File(outputFilePath)).fsName;
                for (var jk in jobs) {
                    var j = jobs[jk];
                    if (j && j.proxy) {
                        try {
                            if ((new File(j.proxy)).fsName === outFs) { entry = j; break; }
                        } catch (_) {}
                    }
                }
            } catch (_) {}
            if (!entry) {
                debugLog('⚠️ Proxy complete with unknown jobID and no path match: ' + jobID + ' → ' + outputFilePath);
                return;
            }
            debugLog('🧭 Matched completion by path: ' + outputFilePath);
        }
        var res = '';
        if (entry.original && outputFilePath) {
            entry.proxy = outputFilePath;
            try {
                res = $.global.LEADAE_attachProxy([{ original: entry.original, proxy: outputFilePath }]);
                debugLog('🔗 attach result: ' + res);
            } catch (eA) {
                debugLog('❌ attach error: ' + eA);
                res = 'attach-error: ' + eA;
            }
        }
        if (!__attachSummaryIsSuccess(res)) {
            dispatchQueueEvent('queue-job-progress', {
                panel: 'adobe-utilities', stage: 'attach', status: 'error', percent: 0, message: String(res || 'attach failed')
            });
            debugLog('↩️ Keeping job for retry');
            // 🔁 targeted micro-retry (don't wait for global poller)
            LEADAE_queueAttachRetry(entry.original, outputFilePath, res, 0);
        } else {
            if (entry && entry.storeKey !== undefined) {
                delete jobs[entry.storeKey];
            }
            delete jobs[k]; delete jobs[String(k)]; delete jobs[Number(k)];
            try {
                if (entry && entry.proxy) {
                    var key = new File(entry.proxy).fsName;
                    delete $.global.LEADAE_queuedProxyPaths[key];
                }
            } catch (_) {}
            // 🔇 Do NOT emit final completion here — poller owns the one true finish.
        }
        // Poller still validates completion once all attachments are stable.
    } catch (e) {
        debugLog('❌ LEADAE_onProxyComplete error: ' + e);
    }
};

$.global.LEADAE_onProxyProgress = function (jobID, progress) {
    try {
        debugLog('📊 Proxy progress: jobID=' + jobID + ' progress=' + progress + '%');
        dispatchQueueEvent('queue-job-progress', {
            panel: 'adobe-utilities', stage: 'proxies', status: 'active', percent: progress
        });
    } catch (e) { debugLog('❌ LEADAE_onProxyProgress error: ' + e); }
};

$.global.LEADAE_onEncoderJobError = function (jobID, errorCode) {
    try {
        debugLog('❌ AME job error: id=' + jobID + ' code=' + errorCode);
        dispatchQueueEvent('queue-job-progress', {
            panel: 'adobe-utilities', stage: 'proxies', status: 'error', percent: 0,
            message: 'AME error ' + errorCode + ' (job ' + jobID + ')'
        });
        // 🧹 Unblock retries: drop the job & dedupe entry for this proxy
        try {
            var jobs = $.global.LEADAE_proxyJobs || {};
            var entry = jobs[jobID] || jobs[String(jobID)] || jobs[Number(jobID)];
            if (entry && entry.proxy) {
                try { delete jobs[jobID]; delete jobs[String(jobID)]; delete jobs[Number(jobID)]; }
                catch (_) {}
                try {
                    var key = (new File(entry.proxy)).fsName;
                    if ($.global.LEADAE_queuedProxyPaths) { delete $.global.LEADAE_queuedProxyPaths[key]; }
                } catch (_) {}
            }
        } catch (_) {}
    } catch (e) { debugLog('❌ onEncoderJobError dispatch failed: ' + e); }
};

// ─────────────────────────────────────────────────────────────────────────────
// AME encoder binding (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────
$.global.LEADAE_encoderBound = !!$.global.LEADAE_encoderBound;
function LEADAE_bindEncoderOnce() {
    try {
        if (!$.global.LEADAE_encoderBound) {
            try {
                var __launchLog = '';
                try { __launchLog = String(app.encoder.launchEncoder()); }
                catch (__launchErr) { __launchLog = 'launch-failed:' + __launchErr; }
                debugLog('🧩 app.encoder.launchEncoder() → ' + __launchLog);
            } catch (__e) {
                try { debugLog('⚠️ LEADAE_bindEncoderOnce launch telemetry failed: ' + __e); } catch (eLaunchTelemetry) {}
            }
            app.encoder.bind('onEncoderJobComplete', 'LEADAE_onProxyComplete');
            app.encoder.bind('onEncoderJobError', 'LEADAE_onEncoderJobError');
            try { app.encoder.bind('onEncoderJobProgress', 'LEADAE_onProxyProgress'); } catch (_) {}
            $.global.LEADAE_encoderBound = true;
        }
    } catch (e) {
        $.global.LEADAE_encoderBound = false;
    }
    debugLog('🧩 Encoder bound = ' + $.global.LEADAE_encoderBound);
    return $.global.LEADAE_encoderBound;
}

// Cross-app timeout helper. Premiere does not ship `$.setTimeout`, and
// `app.scheduleTask` is only available in certain hosts (e.g. After Effects).
// This helper uses whichever mechanism exists, falling back to a synchronous
// `$.sleep` if nothing else is available. It mirrors the signature of
// `setTimeout(fn, delay)` and returns an opaque handle when possible.
function LEADAE_setTimeout(fn, delay) {
    var body;
    if (typeof fn === 'function') {
        body = '(' + fn.toString() + ')()';
    } else {
        body = String(fn);
    }

    try {
        if (app && typeof app.scheduleTask === 'function') {
            return app.scheduleTask(body, delay, false);
        }
    } catch (e) {
        // ignore and try BridgeTalk
    }

    if (typeof BridgeTalk === 'object') {
        try {
            var bt = new BridgeTalk();
            bt.target = BridgeTalk.appName;
            bt.body = body;
            bt.delay = delay;
            bt.send();
            return bt;
        } catch (e2) {
            // ignore and fall through to sleep
        }
    }

    $.sleep(delay);
    try {
        eval(body);
    } catch (e3) {
        // final fallback does nothing on error
    }
    return 0;
}

$.global.LEADAE_checkProxies = function () {
    try {
        var pending = [];
        var proxyJobs = $.global.LEADAE_proxyJobs || {};
        for (var id in proxyJobs) {
            var jobRef = proxyJobs[id];
            if (!jobRef) { continue; }
            var seen = false;
            for (var p = 0; p < pending.length; p++) {
                if (pending[p] === jobRef) { seen = true; break; }
            }
            if (!seen) {
                pending.push(jobRef);
            }
        }

        // heartbeat – helps prove the poller is alive
        debugLog('⏱️ Polling proxies, pending: ' + pending.length);

        // ⛔️ Hard cap: never poll forever (prevents CEP lockups if attach keeps failing).
        try {
            var now = (new Date()).getTime();
            $.global.LEADAE_proxyPollStartedAt = $.global.LEADAE_proxyPollStartedAt || now;
            var maxPollSec = Number($.global.LEADAE_proxyPollMaxSeconds || 90);
            if (!isNaN(maxPollSec) && maxPollSec > 0 && (now - $.global.LEADAE_proxyPollStartedAt) > (maxPollSec * 1000)) {
                debugLog('⛔️ Proxy polling timed out after ' + maxPollSec + 's; stopping.');
                dispatchQueueEvent('queue-job-progress', {
                    panel: 'adobe-utilities',
                    stage: 'proxies',
                    status: 'error',
                    percent: 100,
                    message: 'Proxy attach timed out'
                });
                dispatchQueueEvent('queue-job-complete', {
                    panel: 'adobe-utilities',
                    origin: 'jsx',
                    jobId: $.global.LEADAE_currentJobId || ''
                });
                try { $.global.LEADAE_proxyJobs = {}; } catch (_) {}
                $.global.LEADAE_proxyPollTaskId = 0;
                return;
            }
        } catch (_) {}

        if (!pending.length) {
            // ✅ Proxies truly finished → mark proxies complete, then job complete (once)
            debugLog('🏁 No pending proxy jobs; marking proxies complete and finishing.');
            dispatchQueueEvent('queue-job-progress', {
                panel: 'adobe-utilities',
                stage: 'proxies',
                status: 'complete',
                percent: 100,
                origin: 'jsx',
                jobId: $.global.LEADAE_currentJobId || ''
            });
            dispatchQueueEvent('queue-job-progress', {
                panel: 'adobe-utilities',
                percent: 100,
                origin: 'jsx',
                jobId: $.global.LEADAE_currentJobId || ''
            });
            dispatchQueueEvent('queue-job-complete', {
                panel: 'adobe-utilities',
                origin: 'jsx',
                jobId: $.global.LEADAE_currentJobId || ''
            });
            $.global.LEADAE_proxyPollTaskId = 0;
            $.global.LEADAE_proxyJobsStarted = 0;
            try { $.global.LEADAE_proxyPollStartedAt = 0; } catch (_) {}
            return; // done
        }

        var ready = [];
        for (var i = 0; i < pending.length; i++) {
            var job = pending[i];
            var proxyFile = new File(job.proxy);
            if (!proxyFile.exists) { continue; }
            var size = proxyFile.length;            // size > 0 indicates writing started
            job.__stableCount = job.__stableCount || 0;
            if (job.__lastSize && job.__lastSize === size && size > 0) {
                job.__stableCount++;
            } else {
                job.__stableCount = 0;
            }
            if (job.__stableCount >= 2) { // two consecutive stable checks
                ready.push(job);
            }
            job.__lastSize = size; // track for next poll
        }

        if (ready.length) {
            // Attach inline; only drop on full success
            // Per-file attach retry cap (prevents infinite loops if Premiere rejects the proxy or input is malformed)
            var maxAttachAttempts = Number($.global.LEADAE_proxyAttachMaxAttempts || 10);
            var stillReady = [];
            for (var rr = 0; rr < ready.length; rr++) {
                var j = ready[rr];
                j.__attachAttempts = (j.__attachAttempts || 0) + 1;
                if (!isNaN(maxAttachAttempts) && maxAttachAttempts > 0 && j.__attachAttempts > maxAttachAttempts) {
                    debugLog('⛔️ Giving up attaching proxy after ' + maxAttachAttempts + ' attempts: ' + String(j.proxy || ''));
                    // Remove ALL keys for this proxy so the poller can eventually finish.
                    try {
                        for (var jid2 in $.global.LEADAE_proxyJobs) {
                            if ($.global.LEADAE_proxyJobs[jid2] && $.global.LEADAE_proxyJobs[jid2].proxy === j.proxy) {
                                delete $.global.LEADAE_proxyJobs[jid2];
                            }
                        }
                    } catch (_) {}
                } else {
                    stillReady.push(j);
                }
            }
            ready = stillReady;
            if (!ready.length) {
                // Nothing left to try this tick.
                $.global.LEADAE_proxyPollTaskId = LEADAE_setTimeout($.global.LEADAE_checkProxies, 1000);
                return;
            }

            var res = $.global.LEADAE_attachProxy(ready);
            debugLog('🔗 [poll] ' + res);

            // If attach is failing due to malformed JSON, don't spin forever.
            if (/^Attach error: bad JSON/i.test(String(res || ''))) {
                debugLog('⛔️ Proxy attach aborted: bad JSON. Stopping poller to avoid CEP lockup.');
                dispatchQueueEvent('queue-job-progress', {
                    panel: 'adobe-utilities',
                    stage: 'proxies',
                    status: 'error',
                    percent: 100,
                    message: 'Proxy attach failed (bad JSON)'
                });
                dispatchQueueEvent('queue-job-complete', {
                    panel: 'adobe-utilities',
                    origin: 'jsx',
                    jobId: $.global.LEADAE_currentJobId || ''
                });
                try { $.global.LEADAE_proxyJobs = {}; } catch (_) {}
                $.global.LEADAE_proxyPollTaskId = 0;
                return;
            }

            var m = /Attached\s+(\d+)\s*\/\s*(\d+)/.exec(res);
            var attachedCount = m ? Number(m[1]) : 0;
            var totalCount = m ? Number(m[2]) : ready.length;
            var a = /already:\s*(\d+)/i.exec(res);
            var alreadyCount = a ? Number(a[1]) : 0;

            if ((attachedCount + alreadyCount) === totalCount) {
                // All attached → remove from map
                for (var r = 0; r < ready.length; r++) {
                    for (var jid in $.global.LEADAE_proxyJobs) {
                        if ($.global.LEADAE_proxyJobs[jid].proxy === ready[r].proxy) {
                            delete $.global.LEADAE_proxyJobs[jid];
                        }
                    }
                }
            } else {
                debugLog('↩️ Not all proxies attached; will retry on next poll');
            }
        }

        // re-schedule using cross-app helper (faster cadence reduces perceived lag)
        $.global.LEADAE_proxyPollTaskId = LEADAE_setTimeout($.global.LEADAE_checkProxies, 1000);
    } catch (err) {
        debugLog('❌ Proxy polling error: ' + err);
        $.global.LEADAE_proxyPollTaskId = LEADAE_setTimeout($.global.LEADAE_checkProxies, 1000);
    }
};

/**
 * Simple connectivity probe to verify ExtendScript is alive
 * and Premiere's DOM is accessible.
 */
$.global.LEADAE_test = function () {
    try {
        if (typeof app === 'undefined') {
            debugLog("❌ LEADAE_test: app is undefined");
            return 'err|app is undefined';
        }
        if (!app.project) {
            debugLog("❌ LEADAE_test: project not accessible (no project open?)");
            return 'err|project not accessible';
        }
        var appName = app.name || "UnknownApp";
        var appVersion = app.version || "UnknownVersion";
        debugLog("✅ LEADAE_test: " + appName + " " + appVersion);
        return 'ok|' + appName + '|' + appVersion + '|' + ($.global.LEADAE_JSX_BUILD_ID || '');
    } catch (error) {
        debugLog("❌ LEADAE_test exception: " + error);
        return 'err|' + error;
    }
};

/**
 * Trivial diagnostic function to confirm CEP ↔ JSX binding.
 */
$.global.HELLO_TEST = function () {
    debugLog("✅ HELLO_TEST called");
    return "hello from jsx|" + ($.global.LEADAE_JSX_BUILD_ID || "");
};

/**
 * Import media files into Premiere project
 * paths can be an Array or a JSON stringified Array.
 */
$.global.LEADAE_importMedia = function (paths, targetBin) {
    var parsedPaths = paths;

    if (typeof paths === 'string') {
        try {
            parsedPaths = JSON.parse(paths);
        } catch (err) {
            debugLog('❌ LEADAE_importMedia parse error: ' + err);
            return 'Import error: invalid JSON paths';
        }
    }

    if (!parsedPaths || !parsedPaths.length) {
        return 'No paths provided.';
    }

    try {
        var parent = app.project.rootItem;

        if (typeof targetBin === 'string' && targetBin !== '') {
            var parts = targetBin.split('/');
            for (var i = 0; i < parts.length; i++) {
                var next = parts[i];
                var existing = null;

                for (var j = 0; j < parent.children.numItems; j++) {
                    var child = parent.children[j];
                    if (child.name === next && child.type === 2) {
                        existing = child;
                        break;
                    }
                }

                if (!existing) {
                    existing = parent.createBin(next);
                }
                parent = existing;
            }
        }

        app.project.importFiles(parsedPaths, 1, parent, 0);
        return 'Imported ' + parsedPaths.length + ' file(s).';
    } catch (err) {
        debugLog('❌ Import error: ' + err);
        return 'Import error: ' + err;
    }
};

/**
 * Create bins in Premiere project
 * binPaths can be an Array or a JSON stringified Array.
 */
$.global.LEADAE_createBins = function (binPaths) {
    var parsedBinPaths = binPaths;

    if (typeof binPaths === 'string') {
        try {
            parsedBinPaths = JSON.parse(binPaths);
        } catch (err) {
            debugLog('❌ LEADAE_createBins parse error: ' + err);
            return 'Bin error: invalid JSON bin paths';
        }
    }

    if (!parsedBinPaths || !parsedBinPaths.length) {
        return 'No bin paths provided.';
    }

    var root = app.project.rootItem;

    function ensureBin(parent, parts) {
        if (!parts.length) return;
        var next = parts.shift();
        var existing = null;

        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            if (child.name === next && child.type === 2) {
                existing = child;
                break;
            }
        }

        if (!existing) {
            existing = parent.createBin(next);
        }
        ensureBin(existing, parts);
    }

    try {
        for (var i = 0; i < parsedBinPaths.length; i++) {
            ensureBin(root, String(parsedBinPaths[i]).split('/'));
        }
        return 'Processed ' + parsedBinPaths.length + ' bin path(s).';
    } catch (err) {
        debugLog('❌ Bin error: ' + err);
        return 'Bin error: ' + err;
    }
};

/**
 * Attach proxy files to their original media in Premiere (verbose logging).
 * Input: Array or JSON string of [{original, proxy}]
 */
$.global.LEADAE_attachProxy = function (pairsIn) {
    // Accept either a JSON string or a raw Array/Object (some call sites pass objects directly).
    var pairs = pairsIn;

    // First: if it's a string, try strict JSON parse.
    if (typeof pairsIn === 'string') {
        try {
            pairs = JSON.parse(pairsIn);
        } catch (e1) {
            // Second chance: handle accidentally-escaped JSON like [{\"original\":...}]
            // (This happens if a JSON string is embedded inside another JSON payload.)
            try {
                var s = String(pairsIn || '');
                if (s.indexOf('\\"') !== -1) {
                    pairs = JSON.parse(s.replace(/\\\"/g, '"'));
                } else {
                    throw e1;
                }
            } catch (e2) {
                try {
                    var snippet = String(pairsIn || '').substr(0, 200);
                    debugLog('❌ LEADAE_attachProxy: bad JSON: ' + e1 + ' | input: ' + snippet);
                } catch (_) {
                    debugLog('❌ LEADAE_attachProxy: bad JSON: ' + e1);
                }
                return 'Attach error: bad JSON';
            }
        }
    }

    // If the first parse returned a JSON-encoded string, parse again.
    if (typeof pairs === 'string') {
        try { pairs = JSON.parse(pairs); } catch (_) {}
    }

    // Support payload objects: {pairs:[...]}
    if (!Array.isArray(pairs) && pairs && pairs.pairs && Array.isArray(pairs.pairs)) {
        pairs = pairs.pairs;
    }
    if (!pairs || !pairs.length) {
        debugLog('ℹ️ LEADAE_attachProxy: no pairs given');
        return 'No proxy pairs';
    }

    function normalizeFsPath(p) {
        if (!p) return '';
        try {
            p = new File(p).fsName; // resolves symlinks
        } catch (e) {}
        p = String(p).replace(/\\/g, '/');
        if ($.os && $.os.toLowerCase().indexOf('windows') === 0) {
            p = p.toLowerCase();
        }
        return p;
    }

    function findItemByPath(parent, absFsPath) {
        var normAbs = normalizeFsPath(absFsPath);
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            if (child) {
                if (child.type === 1) {
                    try {
                        if (child.getMediaPath) {
                            var normChild = normalizeFsPath(child.getMediaPath && child.getMediaPath());
                            // match on filename even if parent differs
                            if (normChild === normAbs || normChild.endsWith('/' + new File(absFsPath).name)) {
                                return child;
                            }
                        }
                    } catch (e) {}
                }
                if (child.type === 2) {
                    var hit = findItemByPath(child, absFsPath);
                    if (hit) return hit;
                }
            }
        }
        return null;
    }

    function stripExt(name) {
        return String(name || '').replace(/\.[^\.]+$/, '').toLowerCase();
    }

    function findItemByPathOrName(parent, targetPath) {
        var wantedFs = normalizeFsPath(targetPath);
        var wantedName = new File(targetPath).name;
        var wantedBase = stripExt(wantedName);

        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            if (!child) { continue; }

            if (child.type === 1) { // ProjectItem
                // Try media path (canonicalized)
                try {
                    var childFs = normalizeFsPath(child.getMediaPath && child.getMediaPath());
                    if (childFs && childFs === wantedFs) { return child; }
                } catch (e) {}

                // Fall back to name with/without extension
                var nm = String(child.name || '').toLowerCase();
                if (nm === wantedName.toLowerCase() || nm === wantedBase) { return child; }
            }

            if (child.type === 2) { // Bin
                var hit = findItemByPathOrName(child, targetPath);
                if (hit) { return hit; }
            }
        }
        return null;
    }

    var attached = 0, missing = 0, failed = 0, already = 0;
    for (var i = 0; i < pairs.length; i++) {
        try {
            var origPath = String(pairs[i].original || '');
            var proxyPath = String(pairs[i].proxy || '');
            if (!origPath || !proxyPath) { failed++; continue; }

            var origFile = new File(origPath);
            var proxyFile = new File(proxyPath);
            var origFs = origFile.fsName;
            var proxyFs = proxyFile.fsName;

            debugLog('🔍 Attempting attach: ' + origFs + ' → ' + proxyFs);

            // Find project item
            var item = findItemByPath(app.project.rootItem, origFs);
            if (!item) {
                item = findItemByPathOrName(app.project.rootItem, origFs);
            }
            if (!item) {
                missing++;
                debugLog('❌ Not in project: ' + origFs);
                continue;
            }

            // Skip if proxy already present
            try {
                if (item && item.hasProxy && item.hasProxy() === true) {
                    debugLog('ℹ️ Already has proxy, skipping: ' + item.name);
                    already++;
                    continue;
                }
            } catch (e) {}

            var ok = false;

            try {
                if (item.canProxy && !item.canProxy()) {
                    debugLog('⚠️ item.canProxy() returned false for this clip');
                }
            } catch (e) {}

            // Try attach using the provided proxy path first
            if (!ok) {
                try {
                    if (item.attachProxy) {
                        debugLog('➡️ Trying attachProxy(proxyPath, 0)');
                        var res = item.attachProxy(proxyPath, 0); // 0 = proxy, 1 = hi-res
                        if (res === 0 || res === undefined) {
                            ok = true;
                            debugLog('✅ attachProxy(proxyPath, 0) succeeded');
                        } else if (res === 4) {
                            ok = true;
                            debugLog('ℹ️ attachProxy(proxyPath, 0) proxy already attached (code 4)');
                        } else {
                            debugLog('⚠️ attachProxy(proxyPath, 0) returned code ' + res);
                        }
                    }
                } catch (e2) {
                    debugLog('❌ attachProxy(proxyPath, 0) failed: ' + e2);
                }
            }

            // If that failed, retry using the canonical fsName
            if (!ok) {
                try {
                    if (item.attachProxy) {
                        debugLog('➡️ Trying attachProxy(File.fsName, 0)');
                        var res2 = item.attachProxy(proxyFs, 0);
                        if (res2 === 0 || res2 === undefined) {
                            ok = true;
                            debugLog('✅ attachProxy(File.fsName, 0) succeeded');
                        } else if (res2 === 4) {
                            ok = true;
                            debugLog('ℹ️ attachProxy(File.fsName, 0) proxy already attached (code 4)');
                        } else {
                            debugLog('⚠️ attachProxy(File.fsName, 0) returned code ' + res2);
                        }
                    }
                } catch (e4) {
                    debugLog('❌ attachProxy(File.fsName, 0) failed: ' + e4);
                }
            }

            // (Optional legacy fallback for older internal builds only)
            if (!ok && item.setProxy) {
                try {
                    debugLog('➡️ Trying legacy setProxy(path)');
                    item.setProxy(proxyFs);
                    ok = true;
                    debugLog('✅ setProxy(path) assumed success');
                } catch (e3) { debugLog('❌ legacy setProxy(path) failed: ' + e3); }
            }

            if (ok) {
                attached++;
            } else {
                failed++;
                debugLog('❌ All proxy attach attempts failed for: ' + origFs);
            }
        } catch (err) {
            failed++;
            debugLog('❌ Proxy attach exception: ' + err);
        }
    }

    var result = 'Attached ' + attached + ' / ' + pairs.length +
                 ' proxies (missing: ' + missing + ', failed: ' + failed + ', already: ' + already + ')';
    debugLog('📊 ' + result);
    return result;
};

/**
 * Attach proxies, and if not yet attachable (import/indexing lag), queue a retry loop (default ~60s).
 * Input: { pairs: [{original, proxy}], maxSeconds?: number }
 */
$.global.LEADAE_attachProxyWithRetry = function (payloadIn) {
    var payload = payloadIn;
    if (typeof payloadIn === 'string') {
        try { payload = JSON.parse(payloadIn); } catch (_) { payload = payloadIn; }
    }

    var pairs = Array.isArray(payload) ? payload : (payload && payload.pairs) ? payload.pairs : [];
    var maxSeconds = Number((payload && payload.maxSeconds) || 60);
    // Hard clamp to avoid runaway retry spam from CEP.
    if (isNaN(maxSeconds) || maxSeconds <= 0) maxSeconds = 20;
    if (maxSeconds > 30) maxSeconds = 30;
    if (!pairs || !pairs.length) { return 'No proxy pairs'; }

    // Configure retry window (~1 attempt/sec).
    try { $.global.LEADAE_retryAttachMaxAttempts = Math.max(5, Math.floor(maxSeconds)); } catch (_) {}

    var res = '';
    try {
        res = $.global.LEADAE_attachProxy(pairs);
    } catch (e) {
        res = 'attach-error: ' + e;
    }

    // If we're not even parsing JSON, retries are pointless and can spin forever.
    if (/^Attach error: bad JSON/i.test(String(res || ''))) {
        return String(res);
    }

    if (!__attachSummaryIsSuccess(res)) {
        // Queue a longer retry loop (covers "import not indexed yet" cases).
        try {
            for (var i = 0; i < pairs.length; i++) {
                var p = pairs[i];
                if (p && p.original && p.proxy) {
                    LEADAE_queueAttachRetry(p.original, p.proxy, res, 0);
                }
            }
        } catch (_) {}
        return String(res) + ' (retry queued)';
    }
    return String(res);
};

function LEADAE_asciiPreset(presetPath) {
    try {
        // Only copy to an ASCII-only temp path when needed.
        // Copying every time makes AME look like it's using the "wrong" preset (different filename/path).
        var needsCopy = false;
        try {
            var p = String(presetPath || '');
            needsCopy = /[^\x20-\x7E]/.test(p);
            if ($.os && $.os.toLowerCase().indexOf('windows') === 0) needsCopy = true;
        } catch (_) {}
        if (!needsCopy) { return presetPath; }

        var src = new File(presetPath);
        if (!src.exists) { return presetPath; }
        var tmpDir = new Folder(Folder.temp.fsName + '/LeadAE_ASCII');
        if (!tmpDir.exists) {
            try {
                if (!tmpDir.create()) { return presetPath; }
            } catch (_) {
                return presetPath;
            }
        }
        var dst = new File(tmpDir.fsName + '/preset_' + Date.now() + '.epr');
        var ok  = src.copy(dst.fsName);
        if (ok) { try { debugLog('🧩 Copied preset to ASCII-safe path: ' + dst.fsName); } catch (_) {} }
        return ok ? dst.fsName : presetPath;
    } catch (_) {
        return presetPath;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical AME queuing (AME 2025-safe; jobID 0 is valid)
// ─────────────────────────────────────────────────────────────────────────────
$.global.LEADAE_generateProxies = function (sourcesJson, presetPath, destPath) {
    var queued = 0;
    try {
        var sources;
        if (Array.isArray(sourcesJson)) {
            sources = sourcesJson;
        } else if (typeof sourcesJson === 'string' && sourcesJson.length) {
            try {
                sources = JSON.parse(sourcesJson);
            } catch (parseErr) {
                debugLog('❌ Source list parse error: ' + parseErr);
                return 'error|source_parse';
            }
        } else {
            sources = [];
        }

        if (!sources || !sources.length) {
            debugLog('ℹ️ No sources provided for proxy encode');
            return 'error|no_sources';
        }

        LEADAE_bindEncoderOnce();

        debugLog('🎛 Preset requested: ' + String(presetPath || ''));
        var presetFs = LEADAE_asciiPreset(presetPath || '');
        var destFolder = destPath ? new Folder(destPath) : null;
        if (destFolder && !destFolder.exists) {
            try { destFolder.create(); } catch (destErr) { debugLog('⚠️ Could not create proxy dest: ' + destErr); }
        }
        var destFs = (destFolder && destFolder.exists) ? destFolder.fsName : '';
        if (!destFs) {
            try {
                var fallbackFile = new File(sources[0]);
                destFs = fallbackFile.parent.fsName;
            } catch (_) { destFs = ''; }
        }
        debugLog('🧩 Using preset (fs): ' + presetFs + ' ; dest (fs): ' + destFs);

        var presetFile = new File(presetFs);
        var outExt = 'mov';
        try {
            if (presetFile.exists) {
                presetFile.open('r');
                var presetText = presetFile.read();
                presetFile.close();
                try {
                    var n1 = /<PresetName>([^<]+)<\/PresetName>/i.exec(presetText);
                    var n2 = /<Name>([^<]+)<\/Name>/i.exec(presetText);
                    var presetName = (n1 && n1[1]) ? n1[1] : (n2 && n2[1]) ? n2[1] : '';
                    if (presetName) debugLog('🎛 Preset internal name: ' + presetName);
                } catch (_) {}
                var match = /<FileExt>([^<]+)<\/FileExt>/i.exec(presetText)
                         || /<FileExtension>([^<]+)<\/FileExtension>/i.exec(presetText);
                if (match && match[1]) { outExt = match[1].replace(/^\./, ''); }
                debugLog('🎞 Preset output extension: ' + outExt);
            }
        } catch (eExt) { try { presetFile.close(); } catch (_) {} }

        // Keep existing entries so AME completion can still find them
        $.global.LEADAE_proxyJobs        = $.global.LEADAE_proxyJobs || {};
        $.global.LEADAE_proxyJobsStarted = $.global.LEADAE_proxyJobsStarted || 0;
        // 🔒 Do NOT wipe queuedProxyPaths here; keep it as a cross-run dedupe.
        // We remove keys only when a proxy actually completes/attaches.
        $.global.LEADAE_queuedProxyPaths = $.global.LEADAE_queuedProxyPaths || {};
        var jobStore = $.global.LEADAE_proxyJobs;
        var _queuedThisRun = {};

        function rememberJob(jobId, originalFs, proxyFs) {
            var n = Number(jobId);
            var unique = 'proxy-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
            var storeKey = (!isNaN(n) && n >= 0) ? (n === 0 ? unique : String(n)) : unique;
            var entry = { original: originalFs, proxy: proxyFs, jobId: (!isNaN(n) ? n : jobId), storeKey: storeKey };
            jobStore[storeKey] = entry;
            jobStore[String(jobId)] = entry;
            if (!isNaN(n) && n >= 0) {
                jobStore[n] = entry;
                jobStore[String(n)] = entry;
            }
            // per-run dedupe is handled by _queuedThisRun
            return true;
        }

        function isGoodJob(id) {
            var n = Number(id);
            return !isNaN(n) && n >= 0;
        }

        function queueOne(absFs, proxyFs) {
            var k;
            try { k = new File(proxyFs).fsName; } catch (_) { k = String(proxyFs || ''); }
            // 🚫 Skip if already queued in this run OR a *live* previous run
            //     (clear stale dedupe keys that have no job and no file on disk)
            var isStale = false;
            try {
                var pf = new File(k);
                var hasFile = pf.exists;
                var hasJob = false;
                var jobs = $.global.LEADAE_proxyJobs || {};
                for (var jid in jobs) {
                    var j = jobs[jid];
                    try {
                        if (j && (new File(j.proxy)).fsName === k) { hasJob = true; break; }
                    } catch (_) {}
                }
                isStale = !hasFile && !hasJob;
            } catch (_) { isStale = false; }
            if ($.global.LEADAE_queuedProxyPaths && $.global.LEADAE_queuedProxyPaths[k] && isStale) {
                try { delete $.global.LEADAE_queuedProxyPaths[k]; } catch (_) {}
            }
            if (_queuedThisRun[k] || ($.global.LEADAE_queuedProxyPaths && $.global.LEADAE_queuedProxyPaths[k])) {
                debugLog('🔒 Skipping duplicate AME queue (this run): ' + k);
                return false;
            }
            var jobId;
            try {
                jobId = app.encoder.encodeFile(absFs, proxyFs, presetFs, 0, 0);
                try { debugLog('🎬 encodeFile returned jobID: ' + String(jobId) + ' for ' + absFs); }
                catch (eJobLog) { try { debugLog('⚠️ encodeFile telemetry failed: ' + eJobLog); } catch (eJobLogInner) {} }
                if (isGoodJob(jobId)) {
                    _queuedThisRun[k] = true;
                    $.global.LEADAE_queuedProxyPaths[k] = true; // remember globally
                    rememberJob(jobId, absFs, proxyFs);
                    // ✅ Ensure poller starts immediately
                    $.global.LEADAE_proxyJobsStarted = ($.global.LEADAE_proxyJobsStarted || 0) + 1;
                    return true;
                }
            } catch (encodeErr) {
                debugLog('⚠️ encodeFile failed: ' + encodeErr);
            }
            return false;
        }

        for (var i = 0; i < sources.length; i++) {
            var srcFile = new File(sources[i]);
            if (!srcFile.exists) {
                debugLog('⚠️ Missing source: ' + sources[i]);
                continue;
            }
            var base = srcFile.name.replace(/\.[^.]+$/, '');
            var root = destFs || srcFile.parent.fsName;
            var proxyFs = (new File(root + '/' + base + '_Proxy.' + outExt)).fsName;
            if (queueOne(srcFile.fsName, proxyFs)) {
                queued++;
            }
        }

        if (queued > 0) {
            try {
                app.encoder.startBatch();
                debugLog('🚀 Called app.encoder.startBatch() for ' + queued + ' job(s).');
            } catch (startErr) {
                debugLog('⚠️ app.encoder.startBatch() threw: ' + startErr);
            }
            $.global.LEADAE_proxyPollTaskId = LEADAE_setTimeout($.global.LEADAE_checkProxies, 2000);
            return 'ok|queued:' + queued;
        }

        // 🧩 AME returned no “good” IDs, but it may still encode.
        // Seed entries so onProxyComplete/poller can match by path and attach.
        try {
            var seeded = 0;
            for (var i = 0; i < sources.length; i++) {
                var srcFile = new File(sources[i]);
                if (!srcFile.exists) { continue; }
                var base = srcFile.name.replace(/\.[^.]+$/, '');
                var root = destFs || srcFile.parent.fsName;
                var proxyFs = (new File(root + '/' + base + '_Proxy.' + outExt)).fsName;
                var assumedId = 'assumed-' + Date.now() + '-' + i;
                if (rememberJob(assumedId, srcFile.fsName, proxyFs)) {
                    $.global.LEADAE_proxyJobsStarted = ($.global.LEADAE_proxyJobsStarted || 0) + 1;
                    seeded++;
                }
            }
            if (seeded > 0 && !$.global.LEADAE_proxyPollTaskId) {
                $.global.LEADAE_proxyPollTaskId = LEADAE_setTimeout($.global.LEADAE_checkProxies, 2000);
            }
            debugLog('⚙️ Proceeding with assumed jobs seeded (no good AME IDs).');
        } catch (_) {}
        return 'ok|assumed';
    } catch (err) {
        debugLog('❌ LEADAE_generateProxies error: ' + err);
        return 'error|' + err;
    }
};



/**
 * Combined ingest workflow
 */
$.global.runIngestWorkflow = function (config) {
    var cfg;
    try {
        if (typeof config === 'string') {
            cfg = JSON.parse(config);
        } else {
            cfg = config || {};
        }
    } catch (err) {
        debugLog('❌ Config parse error: ' + err);
        return 'err|Config parse error: ' + err;
    }

    // Track job id so our completion events can be unambiguous in CEP.
    try {
        $.global.LEADAE_currentJobId = String(cfg.jobId || cfg.id || '');
    } catch (_) {
        $.global.LEADAE_currentJobId = '';
    }

    debugLog("🚀 runIngestWorkflow CALLED with config: " + JSON.stringify(cfg));

    // ✅ Begin Validate stage
    dispatchQueueEvent('queue-job-progress', {
        panel: 'adobe-utilities',
        stage: 'validate',
        status: 'start',
        percent: 0
    });

    if (cfg.premiereImportOnly) {
        cfg.destination = '';
    }

    var msgs = [];
    var stageOrder = [];
    if (cfg.createBins && cfg.bins && cfg.bins.length) {
        stageOrder.push('bins');
    }
    if (cfg.importPremiere && cfg.sources && cfg.sources.length) {
        stageOrder.push('import');
    }
    if (cfg.generateProxies && cfg.proxyPreset) {
        stageOrder.push('proxies');
    }

    var stageIndexMap = {};
    for (var st = 0; st < stageOrder.length; st++) {
        stageIndexMap[stageOrder[st]] = st;
    }

    function emitStageProgress(stage, status) {
        var payload = { panel: 'adobe-utilities', stage: stage };
        if (status) {
            payload.status = status;
        }
        if (stageOrder.length) {
            var idx = stageIndexMap[stage];
            if (typeof idx === 'number') {
                var fraction;
                if (status === 'complete') {
                    fraction = (idx + 1) / stageOrder.length;
                } else {
                    fraction = idx / stageOrder.length;
                }
                payload.percent = Math.round(fraction * 100);
            }
        }
        dispatchQueueEvent('queue-job-progress', payload);
    }

    if (cfg.createBins && cfg.bins && cfg.bins.length) {
        emitStageProgress('bins', 'start');
        msgs.push(LEADAE_createBins(cfg.bins));
        emitStageProgress('bins', 'complete');
    }

    // ✅ Mark Validate complete once we begin Premiere-side tasks
    dispatchQueueEvent('queue-job-progress', {
        panel: 'adobe-utilities',
        stage: 'validate',
        status: 'complete',
        percent: 100
    });
    if (cfg.importPremiere && cfg.sources && cfg.sources.length) {
        emitStageProgress('import', 'start');
        var map = cfg.fileToBinMap || {};
        var remaining = [];
        for (var i = 0; i < cfg.sources.length; i++) {
            var f = cfg.sources[i];
            var binPath = map[f];
            if (typeof binPath === 'string' && binPath !== '') {
                msgs.push(LEADAE_importMedia([f], binPath));
            } else {
                remaining.push(f);
            }
        }
        if (remaining.length) {
            msgs.push(LEADAE_importMedia(remaining));
        }
        for (var s = 0; s < cfg.sources.length; s++) {
            cfg.sources[s] = new File(cfg.sources[s]).fsName;
        }
        emitStageProgress('import', 'complete');
    }
    if (cfg.generateProxies && cfg.proxyPreset) {
        if (cfg.resetBeforeProxies) {
            try { $.global.LEADAE_resetProxyState({ clearAll: true }); } catch (_) {}
        }
        // Start the proxies stage, but DO NOT mark it complete here.
        // AME completion (or the poller) will emit the true completion.
        emitStageProgress('proxies', 'start');
        var proxySources = Array.isArray(cfg.sources) ? cfg.sources.slice() : [];
        var proxyDest = cfg.proxyDest || cfg.destination || '';
        if ((!proxyDest || proxyDest === '') && proxySources.length) {
            try {
                var seedFile = new File(proxySources[0]);
                proxyDest = seedFile.parent.fsName;
            } catch (_) { proxyDest = ''; }
        }
        var proxyResult = LEADAE_generateProxies(JSON.stringify(proxySources), cfg.proxyPreset, proxyDest || '');
        msgs.push(proxyResult);
    }
    var result = msgs.join('\n');
    debugLog("🚀 runIngestWorkflow result: " + result);

    // ✅ Old behavior: only self-complete when *no proxies* are part of the job.
    // Skip the pre-import leg of a proxies job (marked by _importedAlready:true).
    if (!(cfg.generateProxies && cfg.proxyPreset) && !cfg._importedAlready) {
        dispatchQueueEvent('queue-job-progress', {
            panel: 'adobe-utilities',
            stage: 'complete', status: 'complete', percent: 100,
            origin: 'jsx', jobId: $.global.LEADAE_currentJobId || ''
        });
        dispatchQueueEvent('queue-job-complete', {
            panel: 'adobe-utilities',
            origin: 'jsx', jobId: $.global.LEADAE_currentJobId || ''
        });
    }
    return result;
};
