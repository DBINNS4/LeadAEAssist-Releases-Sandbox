// =====================================================
// ⚡ renderer.speed-test.js – Connected to Backend
// =====================================================
console.log("⚡ Speed Test Panel Loaded");

(function initSpeedTest() {
  const start = () => {
    const ipc = window.electron;

    const translate = (key, fallback) => {
      const t = window.i18n?.t;
      if (typeof t === "function") {
        const translated = t(key);
        if (typeof translated === "string" && translated && translated !== key) return translated;
      }
      return fallback;
    };

    const translateTemplate = (key, fallback, replacements = {}) => {
      const template = translate(key, fallback);
      return Object.entries(replacements).reduce((str, [token, value]) => {
        const pattern = new RegExp(`{{${token}}}`, "g");
        return str.replace(pattern, () => String(value ?? ""));
      }, template);
    };

    const getDefaultSpeedtestError = () => translate("speedTestUnknownError", "Unknown error.");
    const getNotAvailableLabel = () => translate("notAvailable", "N/A");
    const normalizeNotAvailable = (value) => (String(value) === "N/A" ? getNotAvailableLabel() : value);
    const assetUi = window.runtimeAssetUi || null;
    const startupRuntimeAssetBootstrap = window.runtimeAssetBootstrap || null;

    const createRuntimeAssetSummary = (snapshot = {}, options = {}) => {
      if (assetUi && typeof assetUi.buildRuntimeAssetSummary === "function") {
        return assetUi.buildRuntimeAssetSummary(snapshot, {
          ...options,
          translate,
          translateTemplate
        });
      }
      return "";
    };

    const createRuntimeAssetError = (snapshotOrError = {}, options = {}) => {
      if (assetUi && typeof assetUi.createRuntimeAssetError === "function") {
        return assetUi.createRuntimeAssetError(snapshotOrError, {
          ...options,
          translate,
          translateTemplate
        });
      }
      if (snapshotOrError instanceof Error) return snapshotOrError;
      const err = new Error(
        String(
          snapshotOrError?.error
            || snapshotOrError?.message
            || snapshotOrError
            || translate("runtimeAssetRequestFailed", "Runtime asset request failed")
        )
      );
      err.code = String(snapshotOrError?.code || "ASSET_PREFETCH_FAILED").trim() || "ASSET_PREFETCH_FAILED";
      err.snapshot = snapshotOrError;
      return err;
    };

    const isRuntimeAssetCancelError = (error) => {
      const code = String(error?.code || error?.snapshot?.error?.code || "").trim().toUpperCase();
      const state = String(error?.snapshot?.state || "").trim().toLowerCase();
      const name = String(error?.name || "").trim().toLowerCase();
      return code === "ABORT_ERR" || code === "ABORTED" || state === "cancelled" || name === "aborterror";
    };

    const debugSpeedTestPayload = (scope, payload = {}) => {
      if (typeof console === "undefined" || typeof console.debug !== "function") return;
      console.debug(`[speed-test] ${scope}`, {
        code: payload?.code,
        message: payload?.message,
        error: payload?.error
      });
    };

    const mapDriveWarning = (warning = {}) => {
      const _oneLine = (value, maxLen = 180) => {
        const line = String(value ?? "").split(/\r?\n/)[0].trim();
        if (!line) return "";
        return line.length > maxLen ? line.slice(0, maxLen) + "…" : line;
      };

      const code = warning?.code;
      if (code === "DISK_SPACE_CHECK_FAILED") {
        return {
          warningKey: "driveTestDiskSpaceCheckWarningMessage",
          warningFallback: "Unable to verify free space; proceeding at your own risk."
        };
      }

      debugSpeedTestPayload("Unmapped drive warning", {
        ...warning,
        detail: _oneLine(warning?.error || warning?.message)
      });
      return {
        warningKey: "driveTestUnknownWarning",
        warningFallback: "A drive warning occurred. Please review logs for details."
      };
    };

    const mapSpeedTestError = ({ code, error } = {}) => {
      switch (code) {
        case "TIMEOUT":
          return translate("speedTestTimeoutError", "Speed test timed out. Please try again.");
        case "EXEC_ERROR":
          return translate(
            "speedTestExecError",
            "Speed test failed to run the network test tool. Please try again."
          );
        case "PARSE_ERROR":
          return translate(
            "speedTestParseError",
            "Speed test returned unreadable results. Please try again."
          );
        case "SPAWN_ERROR":
          return translate(
            "speedTestSpawnError",
            "Unable to start the network test tool. Please check permissions or reinstall the app."
          );
        case "DEPENDENCY_MISSING":
          return translate(
            "speedTestDependencyMissing",
            "Network test tool is missing. Please reinstall the app."
          );
        case "BROWSER_MISSING":
          return translate(
            "speedTestBrowserMissing",
            "Browser dependency for the network test is missing. Please reinstall the app or run the browser download step."
          );
        case "ASSET_OFFLINE_BLOCKED":
          return translate(
            "speedTestBrowserOfflineBlocked",
            "Offline Mode is enabled. The browser dependency cannot be downloaded while offline."
          );
        case "ASSET_DOWNLOAD_FAILED":
          return translate(
            "speedTestBrowserDownloadFailed",
            "Failed to download the browser dependency. Check your network connection and retry."
          );
        case "ASSET_EXTRACT_FAILED":
          return translate(
            "speedTestBrowserInstallFailed",
            "Downloaded browser dependency could not be installed. Retry or reinstall the app."
          );
        case "ASSET_CHECKSUM_MISMATCH":
          return translate(
            "speedTestBrowserChecksumFailed",
            "Downloaded browser dependency failed checksum verification. Retry after publishing a fresh asset build."
          );
        case "ASSET_MISSING_CHECKSUM":
          return translate(
            "speedTestBrowserMissingChecksum",
            "This build is missing checksum metadata for the browser dependency."
          );
        case "ALREADY_RUNNING":
          return translate("speedTestAlreadyRunning", "A speed test is already running.");
        case "LICENSE_REQUIRED":
          return translate("speedTestLicenseRequired", "License required to run speed tests.");
        case "OFFLINE_MODE":
          return translate(
            "speedTestOfflineMode",
            "Offline Mode is enabled. Network speed tests are unavailable while offline."
          );
        case "NETWORK_TEST_CANCELLED":
        case "DRIVE_TEST_CANCELLED":
        case "CANCELLED":
          return translate("speedTestCancelled", "Cancelled.");
        default: {
          debugSpeedTestPayload("Unmapped speed test error", { code, error });
          return getDefaultSpeedtestError();
        }
      }
    };

    const clampInt = (value, min, max) => {
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n)) return min;
      return Math.min(max, Math.max(min, n));
    };

    const formatBytesBinary = (bytes) => {
      const n = Number(bytes);
      if (!Number.isFinite(n)) return String(bytes);
      const abs = Math.abs(n);
      const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
      let unitIdx = 0;
      let value = abs;
      while (value >= 1024 && unitIdx < units.length - 1) {
        value /= 1024;
        unitIdx += 1;
      }
      const decimals = unitIdx >= 3 ? 1 : 0;
      return `${value.toFixed(decimals)} ${units[unitIdx]}`;
    };

    const TOOLTIP_ALLOWED_TAGS = new Set(["DIV", "SPAN", "UL", "LI", "STRONG", "EM", "BR"]);
    const TOOLTIP_ALLOWED_ATTRS = new Set(["class"]);

    function sanitizeTooltipFragment(fragment) {
      const elements = [];
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        elements.push(walker.currentNode);
      }

      for (const el of elements) {
        if (!TOOLTIP_ALLOWED_TAGS.has(el.tagName)) {
          // Replace any disallowed element with its plain text
          el.replaceWith(document.createTextNode(el.textContent || ""));
          continue;
        }

        // Strip all attributes except a tiny allowlist (prevents on* handlers, style, href, etc.)
        for (const attr of Array.from(el.attributes)) {
          if (!TOOLTIP_ALLOWED_ATTRS.has(attr.name)) {
            el.removeAttribute(attr.name);
          }
        }
      }
    }

    function setTooltipContentSafe(target, html) {
      if (!target) return;
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      sanitizeTooltipFragment(tpl.content);
      target.replaceChildren(tpl.content);
    }

    // ─── Speed Test Tooltips ────────────────────────────────────────────────
    // Important: these are injected via JS (not data-i18n), so we must re-render
    // when i18n finishes initializing and whenever the language changes.
    const overviewTooltip = document.getElementById("speed-test-overview-tooltip");
    const speedTooltip = document.getElementById("speedtest-info-tooltip");

    const renderSpeedTestTooltips = () => {
      if (overviewTooltip) {
        setTooltipContentSafe(overviewTooltip, `
          <div class="tooltip-content">
            <div class="tooltip-header">${translate("speedTestOverviewHeader", "SPEED TEST PANEL — Technical Overview")}</div>

            <div class="tooltip-section">
              <span class="tooltip-subtitle">${translate("speedTestOverviewPurposeTitle", "What it measures")}</span>
              <ul class="tooltip-list">
                <li>${translate("speedTestOverviewPurpose1", "Network throughput and latency (download/upload/ping).")}</li>
                <li>${translate("speedTestOverviewPurpose2", "Sequential drive read/write for large transfers (media copy, exports, proxies).")}</li>
                <li>${translate("speedTestOverviewPurpose3", "Random drive read/write for small I/O workloads (project load, cache, databases).")}</li>
              </ul>
            </div>

            <div class="tooltip-section">
              <span class="tooltip-subtitle">${translate("speedTestOverviewWorkflowTitle", "How to read the results")}</span>
              <ul class="tooltip-list">
                <li>${translate("speedTestOverviewWorkflow1", "<strong>Network</strong> - higher download/upload and lower ping generally feel snappier.")}</li>
                <li>${translate("speedTestOverviewWorkflow2", "<strong>Sequential</strong> - focus on sustained MB/s for large media and exports.")}</li>
                <li>${translate("speedTestOverviewWorkflow3", "<strong>Random</strong> - focus on IOPS/latency when lots of small files are involved.")}</li>
                <li>${translate("speedTestOverviewWorkflow4", "<strong>Shared storage</strong> - test the same mount/path your NLE will use.")}</li>
              </ul>
            </div>

            <div class="tooltip-section">
              <span class="tooltip-subtitle">${translate("speedTestOverviewNotesTitle", "Tips")}</span>
              <ul class="tooltip-list">
                <li>${translate("speedTestOverviewNotes1", "Use larger test sizes to reduce OS caching effects.")}</li>
                <li>${translate("speedTestOverviewNotes2", "Close heavy I/O apps during testing for cleaner numbers.")}</li>
              </ul>
            </div>
          </div>
        `);
      }

      // 🧩 Drive Test Tooltip (identical to Adobe Automate)
      if (speedTooltip) {
        setTooltipContentSafe(speedTooltip, `
          <div class="tooltip-content">
            <div class="tooltip-header">${translate("driveTestInfoHeader", "DRIVE TEST INFO")}</div>

            <div class="tooltip-section">
              <span class="tooltip-subtitle">${translate("driveTestInfoModeTitle", "Mode")}</span>
              <ul class="tooltip-list">
                <li>${translate("driveTestInfoSequential", "<strong>Sequential:</strong> Measures sustained throughput for large, continuous files. Writes are flushed to disk; reads may be influenced by OS cache.")}</li>
                <li>${translate("driveTestInfoRandom", "<strong>Random:</strong> Tests many small reads/writes across the drive — highlights latency and metadata/cache behavior.")}</li>
              </ul>
            </div>

            <div class="tooltip-section">
              <span class="tooltip-subtitle">${translate("driveTestInfoSizeTitle", "Test Size")}</span>
              <ul class="tooltip-list">
                <li>${translate("driveTestInfoSizeSmall", "<strong>Small (256-512 MiB):</strong> Quick test — can be optimistic due to OS caching.")}</li>
                <li>${translate("driveTestInfoSizeMedium", "<strong>Medium (1 GiB):</strong> Better balance for real-world file transfers.")}</li>
                <li>${translate("driveTestInfoSizeLarge", "<strong>Large (2 GiB):</strong> Best for sustained throughput (exports/proxies) and reduced cache effects.")}</li>
              </ul>
            </div>
          </div>
        `);
      }
    };

    const bindSpeedTestTooltipI18nRefresh = () => {
      // Prevent duplicate listeners if the script is ever re-evaluated.
      if (bindSpeedTestTooltipI18nRefresh.bound) return;
      bindSpeedTestTooltipI18nRefresh.bound = true;

      // Initial render (may be English fallback if i18n isn't ready yet).
      renderSpeedTestTooltips();

      // Re-render once i18n is initialized + on every language change.
      // (Tooltips are not in translatePage(), so we handle them explicitly.)
      const attach = () => {
        const i18n = window.i18n;
        if (!i18n?.on) return false;
        try {
          i18n.on('languageChanged', renderSpeedTestTooltips);
          i18n.on('initialized', renderSpeedTestTooltips);
          i18n.on('loaded', renderSpeedTestTooltips);
        } catch {
          // Ignore if i18n doesn't support events in a given build.
        }
        // If resources are already ready, render immediately.
        if (i18n.isInitialized) {
          renderSpeedTestTooltips();
        }
        return true;
      };

      if (attach()) return;

      // i18n may not be available yet if this panel loads very early.
      // Poll briefly until it exists, then attach + render.
      let tries = 0;
      const maxTries = 50; // ~5s @ 100ms
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
    };

    bindSpeedTestTooltipI18nRefresh();

    // Preserve the UI skin's nested button markup.
    function _getButtonLabel(btn) {
      if (!btn) return "";
      try {
        const t = btn.querySelector?.('.button_text');
        if (t) return String(t.textContent ?? "");
      } catch {}
      return String(btn.textContent ?? "");
    }

    function _setButtonLabel(btn, label) {
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

    const netBtn = document.getElementById("start-network-test");
    const resetNetworkTestBtn = document.getElementById("reset-network-test");
    const netCancelBtn = document.getElementById("cancel-network-test");
    let networkTestActive = false;
    let networkCancelRequested = false;
    let driveTestActive = false;
    let speedPanelRunningState = false;

    function syncSpeedPanelRunningState() {
      const isRunning = networkTestActive || driveTestActive;
      if (isRunning === speedPanelRunningState) return;
      speedPanelRunningState = isRunning;
      window.dispatchEvent(new CustomEvent("lae:panel-running-state", {
        detail: {
          panel: "speed-test",
          isRunning
        }
      }));
    }

    function setNetworkTestActive(active) {
      networkTestActive = active;
      syncSpeedPanelRunningState();

      if (netBtn) {
        netBtn.disabled = active;
        netBtn.classList.toggle("is-busy", active);
        netBtn.setAttribute("aria-busy", active ? "true" : "false");
      }

      if (resetNetworkTestBtn) {
        resetNetworkTestBtn.disabled = active;
      }

      // Cancel button is enabled only while the test is active.
      if (netCancelBtn) {
        if (!active) networkCancelRequested = false;
        netCancelBtn.disabled = !active || networkCancelRequested;
        netCancelBtn.classList.toggle("is-busy", networkCancelRequested);
        netCancelBtn.setAttribute("aria-busy", networkCancelRequested ? "true" : "false");
      }

      updateSpeedtestButtonsState();

      // Center "Running..." loader while the network test is active (same lifetime as hamster).
      if (networkConnecting) {
        networkConnecting.classList.toggle("is-active", active);
        networkConnecting.setAttribute("aria-hidden", active ? "false" : "true");
      }

      // Keep the inline status slot visible while the test is active (loader) or when a message is present.
      // Do not downgrade keyed/translated state to raw text during active-state transitions.
      if (networkInlineStatusKey) {
        renderNetworkInlineStatusFromState();
      } else {
        const currentInlineMessage = networkInlineMessage?.textContent || "";
        if (!networkInlineStatusRawMessage && currentInlineMessage) {
          networkInlineStatusRawMessage = currentInlineMessage;
        }
        renderNetworkInlineStatusFromState();
      }

    }

    const netResults = document.getElementById("network-test-results");
    const driveResults = document.getElementById("drive-test-results");
    const networkInlineStatus = document.getElementById("network-test-inline-status");
    const networkConnecting = document.getElementById("network-test-connecting");
    const networkInlineMessage = document.getElementById("network-test-inline-message");

    // Network summary box doubles as a live status area during runs.
    if (netResults) {
      netResults.setAttribute("aria-live", "polite");
      netResults.setAttribute("role", "status");
    }
    // Inline loader elements (new)
    const inlineLoader = document.getElementById("speedtest-loader-inline");
    const inlineProgress = document.getElementById("speedtest-progress");
    const inlineOutput = document.getElementById("speedtest-progress-output");
    let networkInlineStatusKey = "";
    let networkInlineStatusFallback = "";
    let networkInlineStatusParams = null;
    let networkInlineStatusRawMessage = "";

    // Drive-test phase text: "Initializing..." / "Finalizing..."
    // NOTE: We cannot use <output> for this text because global CSS appends '%' to non-empty output.
    const ensureDrivePhaseTextEl = () => {
      if (!inlineLoader) return null;
      let el = document.getElementById("speedtest-drive-phase-text");
      if (!el) {
        el = document.createElement("span");
        el.id = "speedtest-drive-phase-text";
        el.className = "eta-inline";
        el.setAttribute("aria-live", "polite");
        el.setAttribute("aria-atomic", "true");
        el.style.display = "none";
        inlineLoader.appendChild(el);
      }
      return el;
    };
    const drivePhaseTextEl = ensureDrivePhaseTextEl();
    const liveStatus =
      document.getElementById("speedtest-live-status") ||
      (() => {
        const region = document.createElement("div");
        region.id = "speedtest-live-status";
        region.setAttribute("role", "status");
        region.setAttribute("aria-live", "polite");
        // Inline visually-hidden pattern to avoid layout shifts
        Object.assign(region.style, {
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0
        });
        driveResults?.parentElement?.appendChild(region);
        return region;
      })();

    // Track whether the drive results pane is still showing the default
    // "no results" placeholder. This matters because language switching
    // only updates elements with data-i18n — if we overwrite the placeholder
    // with plain text, it will get "stuck" in the old language.
    let driveResultsMode = "placeholder"; // placeholder | output

    /**
     * @typedef {Object} DriveResultEntry
     * @property {"start"|"inProgress"|"warning"|"result"|"error"|"cancelled"|"cancelRequested"|"failure"} type
     * @property {Record<string, unknown>} data
     */

    /** @type {DriveResultEntry[]} */
    let driveResultEntries = [];
    const driveWarningsSeen = new Set();

    const renderDriveResultsPlaceholder = () => {
      if (!driveResults) return;
      driveResultsMode = "placeholder";
      driveResultEntries = [];
      driveWarningsSeen.clear();
      driveResults.setAttribute("aria-live", "polite");
      driveResults.setAttribute("role", "status");
      driveResults.innerHTML = '<span data-i18n="noDriveResults"></span>';
      if (typeof window.translatePage === "function") {
        window.translatePage();
      }
      syncStartupChromiumBootstrapGate();
    };

    const renderDriveResultsFromState = () => {
      if (!driveResults) return;
      driveResultsMode = "output";
      const rendered = driveResultEntries.map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const data = entry.data || {};
        switch (entry.type) {
          case "start": {
            const modeLabel = data.mode === "random"
              ? translate("testModeRandom", "Random")
              : translate("testModeSequential", "Sequential");
            const testSize = clampInt(data.testSize, 1, 2048);
            const testSizeLabel = formatTestSizeLabel(testSize);
            const iterationSummary = translateTemplate(
              "driveTestIterationsWarmupSuffix",
              "{{total}} ({{warmup}} warm-up)",
              { total: data.totalIterations, warmup: data.warmupIterations }
            );
            return `${translate("driveTestModeLabel", "Mode")}: ${modeLabel} | ${translate("driveTestSizeLabel", "Test Size")}: ${testSizeLabel} | ${translate("driveTestIterationsLabel", "Iterations")}: ${iterationSummary}\n`;
          }
          case "inProgress":
            return `\n${translateTemplate(
              "driveTestInProgress",
              "⏳ Testing Drive {{index}} at {{path}}...",
              { index: data.index, path: data.path }
            )}`;
          case "warning":
            return `${translateTemplate(
              "driveTestDiskSpaceCheckWarning",
              "⚠️ {{warning}}",
              {
                warning: translate(data.warningKey, data.warningFallback)
              }
            )}\n`;
          case "result": {
            const timestamp = new Date(Number(data.timestampMs) || Date.now()).toLocaleString();
            return `\n${translateTemplate(
              "driveTestResultSummary",
              "Drive {{index}} ({{path}}) Results:\n   🔹 Write: {{write}} MiB/s (min: {{writeMin}}, max: {{writeMax}})\n   🔹 Read:  {{read}} MiB/s (min: {{readMin}}, max: {{readMax}})\n   Time: {{timestamp}}\n",
              {
                index: data.index,
                path: data.path,
                write: data.write,
                writeMin: data.writeMin,
                writeMax: data.writeMax,
                read: data.read,
                readMin: data.readMin,
                readMax: data.readMax,
                timestamp
              }
            )}`;
          }
          case "error": {
            if (data.code === "INSUFFICIENT_DISK_SPACE") {
              return `\n${translateTemplate(
                "driveTestInsufficientDiskSpace",
                "❌ Drive {{index}} ({{path}}): Insufficient free space (need ~{{required}} free, have {{available}}). Reduce test size or free up space.\n",
                {
                  index: data.index,
                  path: data.path,
                  required: formatBytesBinary(data.requiredBytes),
                  available: formatBytesBinary(data.freeBytes)
                }
              )}`;
            }
            if (data.code === "DRIVE_NOT_WRITABLE") {
              return `\n${translateTemplate(
                "driveTestDriveNotWritable",
                "❌ Drive {{index}} ({{path}}): Drive is read-only or lacks write permissions.\n",
                { index: data.index, path: data.path }
              )}`;
            }
            if (data.code === "DISK_SPACE_CHECK_FAILED") {
              return `\n${translateTemplate(
                "driveTestDiskSpaceCheckFailed",
                "⚠️ Drive {{index}} ({{path}}): Unable to verify free space before test. {{error}}\n",
                {
                  index: data.index,
                  path: data.path,
                  error: mapSpeedTestError({ code: data.code, error: data.error })
                }
              )}`;
            }
            return `\n${translateTemplate(
              "driveTestError",
              "❌ Drive {{index}} ({{path}}): {{error}}\n",
              {
                index: data.index,
                path: data.path,
                error: mapSpeedTestError({ code: data.code, error: data.error })
              }
            )}`;
          }
          case "cancelled":
            return `\n${translate("driveTestCancelled", "🛑 Drive test cancelled.")}\n`;
          case "cancelRequested":
            return `\n${translate("driveCancelRequested", "🛑 Cancel requested...")}`;
          case "failure":
            return `\n${translateTemplate(
              "driveTestFailure",
              "❌ Drive test failed: {{error}}",
              { error: mapSpeedTestError({ code: data.code, error: data.error }) }
            )}`;
          default:
            return "";
        }
      });
      driveResults.textContent = rendered.join("");
    };

    const appendDriveResults = (entry) => {
      driveResultEntries.push(entry);
      renderDriveResultsFromState();
    };

    const addDriveWarning = ({ warningKey, warningFallback } = {}) => {
      const warningId = `${warningKey || ""}|${warningFallback || ""}`;
      if (!warningId || driveWarningsSeen.has(warningId)) return;
      driveWarningsSeen.add(warningId);
      const warningEntry = {
        type: "warning",
        data: { warningKey, warningFallback }
      };
      if (driveResultEntries.length > 0) {
        driveResultEntries.splice(1, 0, warningEntry);
      } else {
        driveResultEntries.push(warningEntry);
      }
      renderDriveResultsFromState();
    };

    // 🐹 Hamster helpers (same structure used elsewhere)
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

    // Drive-test hamster (bottom controls row)
    function showSpeedtestHamsterForDrives() {
      const status = document.getElementById('speedtest-job-status');
      if (!status) return;
      let wheel = status.querySelector('.wheel-and-hamster');
      if (!wheel) {
        wheel = document.createElement('div');
        wheel.className = 'wheel-and-hamster';
        status.appendChild(wheel);
      }
      ensureHamsterStructure(wheel);
      status.dataset.jobActive = 'true';
      status.setAttribute('aria-hidden', 'false');
    }

    function hideSpeedtestHamsterForDrives() {
      const status = document.getElementById('speedtest-job-status');
      if (!status) return;
      delete status.dataset.jobActive;
      status.setAttribute('aria-hidden', 'true');
      status.querySelector('.wheel-and-hamster')?.remove();
    }

    // Network-test hamster (on the Test Speed row)
    function showSpeedtestHamsterForNetwork() {
      const status = document.getElementById('speedtest-network-job-status');
      if (!status) return;
      let wheel = status.querySelector('.wheel-and-hamster');
      if (!wheel) {
        wheel = document.createElement('div');
        wheel.className = 'wheel-and-hamster';
        status.appendChild(wheel);
      }
      ensureHamsterStructure(wheel);
      status.dataset.jobActive = 'true';
      status.setAttribute('aria-hidden', 'false');
    }

    function hideSpeedtestHamsterForNetwork() {
      const status = document.getElementById('speedtest-network-job-status');
      if (!status) return;
      delete status.dataset.jobActive;
      status.setAttribute('aria-hidden', 'true');
      status.querySelector('.wheel-and-hamster')?.remove();
    }

    function renderNetworkInlineStatusFromState() {
      if (!networkInlineStatus) return;

      let msg = "";
      if (networkInlineStatusKey) {
        const replacements = networkInlineStatusParams || {};
        msg = Object.keys(replacements).length > 0
          ? translateTemplate(networkInlineStatusKey, networkInlineStatusFallback, replacements)
          : translate(networkInlineStatusKey, networkInlineStatusFallback);
      } else if (networkInlineStatusRawMessage) {
        msg = networkInlineStatusRawMessage;
      }

      // Keep the Connecting loader DOM intact; only update the message span.
      if (networkInlineMessage) {
        networkInlineMessage.textContent = msg;
      } else {
        // Fallback (shouldn't happen): use textContent if the span is missing.
        networkInlineStatus.textContent = msg;
      }

      const shouldShow = Boolean(msg) || networkTestActive;
      networkInlineStatus.style.visibility = shouldShow ? "visible" : "hidden";
      networkInlineStatus.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    }

    function setNetworkInlineStatus(message) {
      if (!networkInlineStatus) return;
      networkInlineStatusKey = "";
      networkInlineStatusFallback = "";
      networkInlineStatusParams = null;
      networkInlineStatusRawMessage = message ? String(message) : "";
      renderNetworkInlineStatusFromState();
    }

    function setNetworkInlineStatusLocalized(key, fallback, replacements = null) {
      networkInlineStatusKey = String(key || "");
      networkInlineStatusFallback = String(fallback || "");
      networkInlineStatusParams = replacements && typeof replacements === "object"
        ? { ...replacements }
        : null;
      networkInlineStatusRawMessage = "";
      renderNetworkInlineStatusFromState();
    }

    // Track whether the results pane is showing the default "no results" placeholder
    // so it can be refreshed on language changes (without clobbering real output).
    let networkResultsMode = "placeholder"; // placeholder | output | bootstrap
    let networkResultState = null;
    let activeNetworkAssetController = null;

    const getStartupChromiumFeatureState = () => {
      if (!startupRuntimeAssetBootstrap || typeof startupRuntimeAssetBootstrap.getFeatureState !== 'function') return null;
      return startupRuntimeAssetBootstrap.getFeatureState('chromium');
    };

    const renderStartupChromiumBootstrapSummary = (featureState = getStartupChromiumFeatureState()) => {
      if (!netResults) return false;
      const snapshot = featureState?.currentSnapshot || featureState?.lastSnapshot || null;
      if (!snapshot) {
        if (!featureState?.pending) return false;
        networkResultsMode = "bootstrap";
        netResults.textContent = translate('runtimeAssetPreparingBrowserDependency', 'Preparing browser dependency…');
        return true;
      }
      const summary = createRuntimeAssetSummary(snapshot, {
        kind: 'chromium',
        progressOverride: featureState?.lastProgressRatio
      });
      if (!summary) return false;
      networkResultsMode = "bootstrap";
      netResults.textContent = summary;
      return true;
    };

    const syncStartupChromiumBootstrapGate = (featureState = getStartupChromiumFeatureState()) => {
      if (!startupRuntimeAssetBootstrap) return;
      const pending = !!featureState?.pending;
      const ready = !!featureState?.ready;
      const failed = !!featureState?.error && !ready;

      if (netBtn && !networkTestActive) {
        netBtn.disabled = pending;
        netBtn.classList.toggle("is-busy", pending);
        netBtn.setAttribute("aria-busy", pending ? "true" : "false");
      }

      if (networkTestActive) return;

      if (pending || failed) {
        renderStartupChromiumBootstrapSummary(featureState);
        return;
      }

      if (networkResultsMode === "bootstrap") {
        renderNetworkResultsPlaceholder();
      }
    };

    function renderNetworkResultsFromState() {
      if (!netResults || networkResultsMode !== "output" || !networkResultState) return;

      const state = networkResultState;
      let message = "";
      switch (state.type) {
        case "running":
          message = translate("runningNetworkTest", "⏳ Running network speed test...");
          break;
        case "cancelled":
          message = translate("networkTestCancelled", "🛑 Network test cancelled.");
          break;
        case "success": {
          const timestamp = state.timestamp
            ? new Date(state.timestamp).toLocaleString()
            : new Date().toLocaleString();
          message = translateTemplate(
            "networkTestResultSummary",
            "Download: {{download}} Mbps\nUpload: {{upload}} Mbps\nPing: {{ping}} ms\n{{sourceLine}}\nTime: {{timestamp}}",
            {
              download: normalizeNotAvailable(state.download),
              upload: normalizeNotAvailable(state.upload),
              ping: normalizeNotAvailable(state.ping),
              sourceLine: translate("networkTestSourceAttribution", "Source: FAST.com (Netflix)"),
              timestamp
            }
          );
          break;
        }
        case "error":
          message = translateTemplate("networkTestError", "❌ {{error}}", {
            error: mapSpeedTestError({ code: state.code, error: state.error })
          });
          break;
        case "failure":
          message = translateTemplate(
            "networkTestFailure",
            "❌ Network test failed: {{error}}",
            {
              error: mapSpeedTestError({ code: state.code, error: state.error })
            }
          );
          break;
        case "asset-summary":
          message = createRuntimeAssetSummary(state.snapshot, {
            kind: 'chromium',
            progressOverride: state.progressOverride
          }) || "";
          break;
        default:
          message = String(state.message || "");
      }

      netResults.textContent = String(message ?? "");
    }

    function setNetworkResultState(state = null, mode = "output") {
      networkResultState = state && typeof state === "object"
        ? { ...state }
        : null;
      if (!netResults) return;
      networkResultsMode = mode;
      renderNetworkResultsFromState();
    }

    const renderNetworkAssetSummary = (snapshot, controller = activeNetworkAssetController) => {
      setNetworkResultState({
        type: "asset-summary",
        snapshot,
        progressOverride: controller?.lastProgressRatio
      });
    };

    const ensureChromiumAssetReadyForNetworkTest = async () => {
      if (!window.electron?.isPackaged) return null;
      if (!ipc?.assets || typeof ipc.assets.prefetch !== 'function') return null;
      if (!assetUi || typeof assetUi.startRuntimeAssetPrefetch !== 'function') return null;
      if (activeNetworkAssetController && !activeNetworkAssetController.settled) {
        return activeNetworkAssetController.promise;
      }

      const controller = await assetUi.startRuntimeAssetPrefetch(
        ipc.assets,
        { feature: 'chromium' },
        {
          kind: 'chromium',
          translate,
          translateTemplate,
          onSnapshot: (snapshot, currentController) => {
            renderNetworkAssetSummary(snapshot, currentController);
          }
        }
      );

      if (controller.immediate) {
        return controller.snapshot;
      }

      activeNetworkAssetController = controller;
      try {
        return await controller.promise;
      } finally {
        if (activeNetworkAssetController === controller) {
          activeNetworkAssetController = null;
        }
      }
    };

    const cancelActiveNetworkAssetRequest = async () => {
      if (!activeNetworkAssetController || activeNetworkAssetController.settled) return false;
      const controller = activeNetworkAssetController;
      try {
        await controller.cancel();
      } catch (error) {
        if (!isRuntimeAssetCancelError(error)) throw error;
      }
      return true;
    };

    function renderNetworkResultsPlaceholder() {
      if (!netResults) return;
      networkResultsMode = "placeholder";
      netResults.setAttribute("aria-live", "polite");
      netResults.setAttribute("role", "status");
      netResults.innerHTML = '<span data-i18n="noNetworkResults"></span>';
      // Ensure the newly injected span gets translated immediately.
      if (typeof window.translatePage === "function") {
        window.translatePage();
      }
      syncStartupChromiumBootstrapGate();
    }

    if (startupRuntimeAssetBootstrap && typeof startupRuntimeAssetBootstrap.onChange === 'function') {
      startupRuntimeAssetBootstrap.onChange((snapshot) => {
        syncStartupChromiumBootstrapGate(snapshot?.features?.chromium || null);
      });
      syncStartupChromiumBootstrapGate();
    }

    // 🛑 Cancel Network Test
    netCancelBtn?.addEventListener("click", async () => {
      if (!networkTestActive || networkCancelRequested) return;
      networkCancelRequested = true;

      // Disable cancel immediately to prevent spamming.
      if (netCancelBtn) {
        netCancelBtn.disabled = true;
        netCancelBtn.classList.toggle("is-busy", true);
      }

      setNetworkInlineStatusLocalized("networkCancelRequested", "🛑 Cancel requested...");

      try {
        if (await cancelActiveNetworkAssetRequest()) {
          return;
        }
        await ipc.invoke("cancel-network-test");
      } catch (err) {
        // If cancel fails, allow the user to try again.
        networkCancelRequested = false;
        if (netCancelBtn) {
          netCancelBtn.disabled = false;
          netCancelBtn.classList.toggle("is-busy", false);
        }
        setNetworkInlineStatusLocalized(
          "networkTestCancelFailed",
          "❌ Cancel failed: {{error}}",
          { error: err?.message || getDefaultSpeedtestError() }
        );
      }
    });

    // 🛑 Reset (Network Tests only)
    resetNetworkTestBtn?.addEventListener("click", () => {
      if (networkTestActive) return;

      networkCancelRequested = false;
      renderNetworkResultsPlaceholder();
      setNetworkInlineStatus("");
      hideSpeedtestHamsterForNetwork();
      setNetworkTestActive(false);
    });

    // 🌐 Network Test
    netBtn?.addEventListener("click", async () => {
      if (networkTestActive) return;
      networkCancelRequested = false;
      setNetworkTestActive(true);
      // Keep the inline status row for cancel-related messaging; show acquisition state in Summary.
      setNetworkInlineStatus("");
      setNetworkResultState({ type: "running" });

      hideSpeedtestHamsterForNetwork();

      try {
        try {
          await ensureChromiumAssetReadyForNetworkTest();
        } catch (err) {
          if (err?.snapshot) {
            renderNetworkAssetSummary(err.snapshot);
          } else if (isRuntimeAssetCancelError(err)) {
            setNetworkResultState({
              type: "asset-summary",
              snapshot: {
                feature: 'chromium',
                state: 'cancelled',
                error: {
                  code: 'ABORT_ERR',
                  message: mapSpeedTestError({ code: 'CANCELLED' })
                }
              }
            });
          } else {
            const normalizedError = createRuntimeAssetError(
              {
                feature: 'chromium',
                state: 'error',
                error: {
                  code: err?.code,
                  message: mapSpeedTestError({ code: err?.code, error: err?.message || err })
                }
              },
              { kind: 'chromium' }
            );
            setNetworkResultState({
              type: "asset-summary",
              snapshot: normalizedError.snapshot || normalizedError
            });
          }
          return;
        }

        setNetworkResultState({ type: "running" });

        // Network test uses its own hamster; no shared progress bar
        showSpeedtestHamsterForNetwork();

        const res = await ipc.invoke("run-network-test");

        if (res?.cancelled) {
          setNetworkResultState({ type: "cancelled" });
        } else if (res?.success) {
          setNetworkResultState({
            type: "success",
            download: res.download,
            upload: res.upload,
            ping: res.ping,
            timestamp: Date.now()
          });
        } else {
          setNetworkResultState({ type: "error", code: res?.code, error: res?.error });
        }
      } catch (err) {
        setNetworkResultState({ type: "failure", code: err?.code, error: err?.message || err });
      } finally {
        activeNetworkAssetController = null;
        setNetworkTestActive(false);
        hideSpeedtestHamsterForNetwork();
        setNetworkInlineStatus("");
      }
    });

    // 💽 Drive Tests
    const testSelectedDrivesBtn = document.getElementById("test-selected-drives");
    const testSizeSelect = document.getElementById("test-size");
    const modeSelect = document.getElementById("io-mode");
    const resetSpeedtestBtn = document.getElementById("reset-speedtest");
    const cancelSpeedtestBtn = document.getElementById("cancel-speedtest");
    const driveSelectionButtons = [
      document.getElementById("select-drive-1"),
      document.getElementById("select-drive-2"),
      document.getElementById("select-drive-3")
    ];
    const drivePathBoxes = [1, 2, 3].map(index => document.getElementById(`drive-path-${index}`));
    let drivePathSlotStates = [1, 2, 3].map(() => ({ kind: "empty" }));
    let driveCancelRequested = false;
    // 🔒 Lock Test Size + Mode dropdowns while a Drive Test is running (match Drive button behavior)
    function getStyledDropdownParts(hiddenInput) {
      const wrapper = hiddenInput?.closest?.(".dropdown-wrapper");
      const input = wrapper?.querySelector?.(".chosen-value");
      const list = wrapper?.querySelector?.(".value-list");
      return {
        hidden: hiddenInput ?? null,
        wrapper: wrapper ?? null,
        input: input ?? null,
        list: list ?? null
      };
    }

    const testSizeDropdown = getStyledDropdownParts(testSizeSelect);
    const modeDropdown = getStyledDropdownParts(modeSelect);

    function setStyledDropdownDisabled(dropdown, disabled) {
      const wrapper = dropdown?.wrapper;
      const input = dropdown?.input;
      const list = dropdown?.list;

      if (wrapper) {
        wrapper.classList.toggle("disabled", disabled);
        wrapper.setAttribute("aria-disabled", disabled ? "true" : "false");
        wrapper.classList.remove("open");
      }

      if (input) {
        input.disabled = disabled;
        input.setAttribute("aria-disabled", disabled ? "true" : "false");
        input.classList.remove("open");
      }

      if (list) {
        list.classList.remove("open");
        [...list.querySelectorAll("li")].forEach(li => {
          li.tabIndex = disabled ? -1 : 0;
        });
      }
    }

    function updateSpeedtestButtonsState() {
      // Reset only affects Drive Tests. Disable only while a drive test is running.
      if (resetSpeedtestBtn) {
        resetSpeedtestBtn.disabled = driveTestActive;
      }

      // Cancel is only relevant for drive tests.
      if (cancelSpeedtestBtn) {
        cancelSpeedtestBtn.disabled = !driveTestActive || driveCancelRequested;
        cancelSpeedtestBtn.classList.toggle("is-busy", driveCancelRequested);
        cancelSpeedtestBtn.setAttribute("aria-busy", driveCancelRequested ? "true" : "false");
      }
    }

    function setDriveTestActive(active) {
      driveTestActive = active;
      syncSpeedPanelRunningState();
      if (!active) driveCancelRequested = false;
      if (testSelectedDrivesBtn) {
        testSelectedDrivesBtn.disabled = active;
        testSelectedDrivesBtn.dataset.running = active ? "true" : "false";
      }
      driveSelectionButtons.forEach(btn => {
        if (!btn) return;
        btn.disabled = active;
        if (active) {
          btn.dataset.running = "true";
        } else {
          delete btn.dataset.running;
        }
      });

      // Disable Test Size + Mode dropdowns while a Drive Test is active
      setStyledDropdownDisabled(testSizeDropdown, active);
      setStyledDropdownDisabled(modeDropdown, active);

      updateSpeedtestButtonsState();

      if (liveStatus) {
        liveStatus.textContent = active
          ? translate("speedTestRunningStatus", "Speed test running. Controls are temporarily disabled.")
          : translate("speedTestIdleStatus", "Speed test idle. Controls are available.");
      }
    }

    // 🧩 Populate dropdowns using the same utility as other panels
    function populateDropdown(selectId, values, defaultValue) {
      // Preferred path: shared dropdown helper provided by utils/dropdown.js
      if (typeof window.setupStyledDropdown === "function") {
        window.setupStyledDropdown(selectId, values);
        if (typeof window.setDropdownValue === "function" && defaultValue != null) {
          window.setDropdownValue(selectId, String(defaultValue));
        }
        return;
      }
      // Fallback path (dev): minimal inline wiring so the dropdown still works
      const hidden = document.getElementById(selectId);
      if (!hidden) return;
      const wrapper = hidden.closest(".dropdown-wrapper");
      const chosen = wrapper?.querySelector(".chosen-value");
      const list = wrapper?.querySelector(".value-list");
      if (!wrapper || !list || !chosen) return;
      list.innerHTML = "";
      values.forEach(v => {
        const li = document.createElement("li");
        li.textContent = v.label;
        li.dataset.value = String(v.value);
        li.addEventListener("click", () => {
          hidden.value = String(v.value);
          chosen.value = v.label;
          list.classList.remove("open");
          chosen.classList.remove("open");
          wrapper.classList.remove("open");
        });
        list.appendChild(li);
      });
      if (!chosen.dataset.dropdownToggleBound) {
        chosen.addEventListener("click", () => {
          const isOpen = list.classList.toggle("open");
          chosen.classList.toggle("open", isOpen);
          wrapper.classList.toggle("open", isOpen);
        });
        chosen.dataset.dropdownToggleBound = "true";
      }
      if (defaultValue != null) {
        const def = values.find(v => String(v.value) === String(defaultValue)) || values[0];
        if (def) {
          hidden.value = String(def.value);
          chosen.value = def.label;
        }
      }
    }

    // These dropdown options are built dynamically (not via data-i18n), so we must
    // rebuild them whenever the language changes.
    const buildTestSizeOptions = () => [
      { label: translate("speedTestSize256", "256 MiB"), value: 256 },
      { label: translate("speedTestSize512", "512 MiB"), value: 512 },
      { label: translate("speedTestSize1024", "1 GiB"), value: 1024 },
      { label: translate("speedTestSize2048", "2 GiB"), value: 2048 }
    ];

    const buildModeOptions = () => [
      { label: translate("sequential", "Sequential"), value: "sequential" },
      { label: translate("random", "Random"), value: "random" }
    ];

    let testSizeOptions = buildTestSizeOptions();
    let modeOptions = buildModeOptions();

    const refreshSpeedTestDropdowns = () => {
      testSizeOptions = buildTestSizeOptions();
      modeOptions = buildModeOptions();

      const currentTestSize = testSizeSelect?.value || 1024;
      const currentMode = modeSelect?.value || "sequential";

      populateDropdown("test-size", testSizeOptions, currentTestSize);
      populateDropdown("io-mode", modeOptions, currentMode);

      // Maintain disabled styling if a drive test is currently running.
      setStyledDropdownDisabled(testSizeDropdown, driveTestActive);
      setStyledDropdownDisabled(modeDropdown, driveTestActive);
    };

    refreshSpeedTestDropdowns();

    // Some Speed Test UI is built dynamically (dropdown labels + results placeholders)
    // and will not be updated by translatePage() alone. Refresh it on i18n init
    // and on every language change.
    const syncNetworkRunningScanLabel = () => {
      const scanTextEl = networkConnecting?.querySelector?.(".lae-scan-text");
      if (!scanTextEl) return;
      const msg = translate("speedTestRunningLabel", "Running...");
      scanTextEl.textContent = msg;
      scanTextEl.setAttribute("data-scan-text", msg);
    };

    let speedTestDynamicI18nStateReady = false;

    const refreshSpeedTestDynamicI18n = () => {
      if (!speedTestDynamicI18nStateReady) return;

      refreshSpeedTestDropdowns();
      updateDrivePathsDisplay();

      // Ensure the "no results" placeholders stay bound to data-i18n so they
      // update correctly when a user switches languages.
      if (networkResultsMode === "placeholder") {
        const hasPlaceholder = !!netResults?.querySelector?.('[data-i18n="noNetworkResults"]');
        if (!hasPlaceholder) {
          renderNetworkResultsPlaceholder();
        }
      } else if (networkResultsMode === "output") {
        renderNetworkResultsFromState();
      } else if (networkResultsMode === "bootstrap") {
        renderStartupChromiumBootstrapSummary();
      }

      if (driveResultsMode === "placeholder") {
        const hasPlaceholder = !!driveResults?.querySelector?.('[data-i18n="noDriveResults"]');
        const hasSelectWarning = !!driveResults?.querySelector?.('[data-i18n="driveTestSelectDriveWarning"]');
        if (!hasPlaceholder && !hasSelectWarning) {
          renderDriveResultsPlaceholder();
        } else if (hasSelectWarning && typeof window.translatePage === "function") {
          window.translatePage();
        }
      } else if (driveResultsMode === "output") {
        renderDriveResultsFromState();
      }

      // Keep the network running scanner text in sync with the active language.
      syncNetworkRunningScanLabel();

      // Keep drive phase scanner text in sync for non-progress phases.
      // Avoid touching "running" to prevent disrupting the progress animation state.
      if (driveUiPhase === "initializing" || driveUiPhase === "finalizing") {
        setDriveUiPhase(driveUiPhase);
      }

      // Keep the live region message consistent with the selected language.
      if (liveStatus) {
        liveStatus.textContent = driveTestActive
          ? translate("speedTestRunningStatus", "Speed test running. Controls are temporarily disabled.")
          : translate("speedTestIdleStatus", "Speed test idle. Controls are available.");
      }

      const isInlineVisible = networkInlineStatus?.getAttribute("aria-hidden") === "false";
      if (isInlineVisible && networkInlineStatusKey) {
        renderNetworkInlineStatusFromState();
      }
    };

    const bindSpeedTestDynamicI18nRefresh = () => {
      if (bindSpeedTestDynamicI18nRefresh.bound) return;
      bindSpeedTestDynamicI18nRefresh.bound = true;

      const attach = () => {
        const i18n = window.i18n;
        if (!i18n?.on) return false;
        try {
          i18n.on('languageChanged', refreshSpeedTestDynamicI18n);
          i18n.on('initialized', refreshSpeedTestDynamicI18n);
          i18n.on('loaded', refreshSpeedTestDynamicI18n);
        } catch {
          // ignore
        }
        if (i18n.isInitialized) {
          refreshSpeedTestDynamicI18n();
        }
        return true;
      };

      if (attach()) return;

      let tries = 0;
      const maxTries = 50; // ~5s @ 100ms
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
    };

    // (Defaults are applied by populateDropdown above)
    const selectedDrivePaths = ["", "", ""];
    const ITERATIONS = 5; // main process also uses 5; first is warm-up
    const WARMUP_ITERATIONS = 1;
    const BYTES_PER_MIB = 1024 * 1024;
    const PHASES_PER_ITERATION = 2; // write + read per iteration

    let totalBytes = 0;
    let completedBytes = 0;
    let pendingDriveProgressBytes = 0;
    let driveUiPhase = "idle"; // idle | initializing | running | finalizing

    speedTestDynamicI18nStateReady = true;
    bindSpeedTestDynamicI18nRefresh();

    // Smooth progress animation state
    let displayedPct = 0;
    let targetPct = 0;
    let progressAnimFrame = null;
    let progressTransitionUnlockFrame = null;
    const PROGRESS_EASING_EPSILON = 0.1;
    const PROGRESS_NEAR_COMPLETE_SNAP = 99.9;

    function getRenderedProgressPct({ displayed, target, stillAnimating }) {
      const boundedDisplayed = Math.min(100, Math.max(0, Number(displayed) || 0));
      const boundedTarget = Math.min(100, Math.max(0, Number(target) || 0));
      const done = !stillAnimating && boundedTarget >= PROGRESS_NEAR_COMPLETE_SNAP;
      return done ? 100 : Math.floor(boundedDisplayed);
    }

    function renderSyncedProgress() {
      const stillAnimating =
        Math.abs(targetPct - displayedPct) >= PROGRESS_EASING_EPSILON &&
        displayedPct < 100;
      const renderedPct = getRenderedProgressPct({
        displayed: displayedPct,
        target: targetPct,
        stillAnimating
      });

      if (inlineProgress) inlineProgress.value = renderedPct;
      if (inlineOutput) inlineOutput.value = renderedPct;

      return stillAnimating;
    }

    function renderDriveProgressImmediate(pct) {
      const v = Number(pct);
      const clamped = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
      displayedPct = clamped;
      targetPct = clamped;
      renderSyncedProgress();
    }

    function setInlineProgressValue(value, { instant = false } = {}) {
      if (!inlineProgress) return;

      if (instant) {
        inlineProgress.classList.add("no-transition");
        // Force style recalculation so the class takes effect immediately.
        // This cancels any in-flight CSS transition (prevents the bar from draining backwards).
        void inlineProgress.offsetWidth;
      }

      inlineProgress.value = value;

      if (instant) {
        // Flush the value update while transitions are disabled.
        void inlineProgress.offsetWidth;

        if (progressTransitionUnlockFrame != null) {
          cancelAnimationFrame(progressTransitionUnlockFrame);
        }
        progressTransitionUnlockFrame = requestAnimationFrame(() => {
          inlineProgress?.classList.remove("no-transition");
          progressTransitionUnlockFrame = null;
        });
      }
    }

    function cancelSmoothProgress() {
      if (progressAnimFrame != null) {
        cancelAnimationFrame(progressAnimFrame);
        progressAnimFrame = null;
      }
    }

    function setDriveUiPhase(nextPhase) {
      driveUiPhase = nextPhase;

      if (!inlineLoader) return;

      const active = nextPhase !== "idle";
      inlineLoader.classList.toggle("is-active", active);

      // If we're not actively showing progress, hide the bar/% and show text.
      const showProgress = nextPhase === "running";
      if (!showProgress) cancelSmoothProgress();
      if (inlineProgress) inlineProgress.style.display = showProgress ? "" : "none";
      if (inlineOutput) inlineOutput.style.display = showProgress ? "" : "none";

      if (!drivePhaseTextEl) return;

      if (!active || showProgress) {
        drivePhaseTextEl.classList.remove("lae-scan-text");
        drivePhaseTextEl.removeAttribute("data-scan-text");
        drivePhaseTextEl.textContent = "";
        drivePhaseTextEl.style.display = "none";
        return;
      }

      const msg =
        nextPhase === "finalizing"
          ? translate("driveTestFinalizing", "Finalizing...")
          : translate("driveTestInitializing", "Initializing...");

      drivePhaseTextEl.classList.add("lae-scan-text");
      drivePhaseTextEl.setAttribute("data-scan-text", msg);
      drivePhaseTextEl.textContent = msg;
      drivePhaseTextEl.style.display = "";
    }

    function startSmoothProgress() {
      if (!inlineProgress) return;

      // Make sure bar + number are visible when animating
      inlineProgress.style.display = "";
      if (inlineOutput) inlineOutput.style.display = "";

      const duration = 300; // ms to ease toward each new target
      let lastTime = null;

      function step(timestamp) {
        if (!lastTime) lastTime = timestamp;
        const dt = timestamp - lastTime;
        lastTime = timestamp;

        const diff = targetPct - displayedPct;
        if (targetPct >= PROGRESS_NEAR_COMPLETE_SNAP) {
          // Avoid a long visible easing tail when we're effectively done.
          displayedPct = targetPct;
        } else if (Math.abs(diff) < PROGRESS_EASING_EPSILON) {
          displayedPct = targetPct;
        } else {
          const factor = Math.min(dt / duration, 1);
          displayedPct += diff * factor;
        }

        // Clamp to [0, 100]
        if (displayedPct < 0) displayedPct = 0;
        if (displayedPct > 100) displayedPct = 100;

        const stillAnimating = renderSyncedProgress();

        if (stillAnimating) {
          progressAnimFrame = requestAnimationFrame(step);
        } else {
          progressAnimFrame = null;
        }
      }

      if (progressAnimFrame == null) {
        progressAnimFrame = requestAnimationFrame(step);
      }
    }

    function resetProgressUI() {
      cancelSmoothProgress();
      displayedPct = 0;
      targetPct = 0;
      totalBytes = 0;
      completedBytes = 0;
      pendingDriveProgressBytes = 0;
      setDriveUiPhase("idle");
      if (inlineLoader) {
        inlineLoader.classList.remove("is-active");
      }
      if (inlineProgress) {
        setInlineProgressValue(0, { instant: true });
        inlineProgress.style.display = "";
      }
      if (inlineOutput) {
        inlineOutput.value = "";
        inlineOutput.style.display = "";
      }
    }

    function _getOptionLabel(options, value, fallback) {
      const match = options.find(option => String(option.value) === String(value));
      return match?.label ?? fallback;
    }

    function formatTestSizeLabel(sizeMiB) {
      if (!Number.isFinite(sizeMiB)) return String(sizeMiB);
      const knownSizeLabelKeyByMiB = {
        256: "speedTestSize256",
        512: "speedTestSize512",
        1024: "speedTestSize1024",
        2048: "speedTestSize2048"
      };

      const knownKey = knownSizeLabelKeyByMiB[sizeMiB];
      if (knownKey) {
        return translate(knownKey, sizeMiB >= 1024 ? `${sizeMiB / 1024} GiB` : `${sizeMiB} MiB`);
      }

      const unitMiB = translate("speedTestUnitMiB", "MiB");
      const unitGiB = translate("speedTestUnitGiB", "GiB");
      if (sizeMiB >= 1024) {
        return `${sizeMiB / 1024} ${unitGiB}`;
      }
      return `${sizeMiB} ${unitMiB}`;
    }

    function updateDrivePathsDisplay() {
      const emptyLabel = translate("drivePathEmpty", "No drive selected");
      let needsTranslate = false;
      drivePathSlotStates.forEach((slotState, idx) => {
        const target = drivePathBoxes[idx];
        if (!target) return;

        if (slotState?.kind === "path") {
          // When a real path is present, keep it free of data-i18n so a later
          // translatePage() call (e.g., language switching) cannot overwrite it.
          target.removeAttribute("data-i18n");
          target.textContent = String(slotState?.path || "");
          return;
        }

        if (slotState?.kind === "selectError") {
          target.removeAttribute("data-i18n");
          target.textContent = translateTemplate(
            "driveSelectFolderError",
            "❌ Failed to select drive folder: {{error}}",
            {
              error: slotState?.errorMessage || slotState?.errorCode || getDefaultSpeedtestError()
            }
          );
          return;
        }

        // When empty, show a translated placeholder. We keep the placeholder in a
        // child <span data-i18n> so it can update automatically on language changes.
        const existing = target.querySelector?.('[data-i18n="drivePathEmpty"]');
        if (existing) {
          // Ensure there's readable fallback text even before i18n finishes loading.
          if (!existing.textContent?.trim()) {
            existing.textContent = emptyLabel;
          }
        } else {
          target.innerHTML = `<span data-i18n="drivePathEmpty">${emptyLabel}</span>`;
          needsTranslate = true;
        }
      });

      if (needsTranslate && typeof window.translatePage === "function") {
        window.translatePage();
      }
    }

    updateDrivePathsDisplay();

    [1, 2, 3].forEach(i => {
      const selectBtn = document.getElementById(`select-drive-${i}`);
      selectBtn?.addEventListener("click", async () => {
        if (driveTestActive) return;

        let folder = null;
        try {
          folder = typeof ipc?.selectFolder === "function"
            ? await ipc.selectFolder()
            : await ipc.invoke("select-folder");
        } catch (err) {
          console.error("❌ select-folder failed:", err);
          selectedDrivePaths[i - 1] = "";
          drivePathSlotStates[i - 1] = {
            kind: "selectError",
            errorMessage: err?.message || "",
            errorCode: err?.code || ""
          };
          updateDrivePathsDisplay();
          return;
        }
        if (folder) {
          selectedDrivePaths[i - 1] = folder;
          drivePathSlotStates[i - 1] = { kind: "path", path: folder };
          updateDrivePathsDisplay();
        }
      });
    });

    let driveTestProgressHandler = null;
    let driveTestWarningHandler = null;

    testSelectedDrivesBtn?.addEventListener("click", async () => {
      if (driveTestActive) return;
      if (!driveResults) return;

      const paths = selectedDrivePaths.filter(Boolean);
      if (!paths.length) {
        driveResults.setAttribute("aria-live", "polite");
        driveResults.setAttribute("role", "status");
        driveResultsMode = "placeholder";
        driveResultEntries = [];
        driveWarningsSeen.clear();
        driveResults.innerHTML = '<span data-i18n="driveTestSelectDriveWarning"></span>';
        window.translatePage?.();
        return;
      }

      driveCancelRequested = false;
      setDriveTestActive(true);
      let keepDriveSelections = false;
      let hadFailure = false;
      try {
        await ipc.invoke("reset-drive-test-cancel");
      } catch {
        // ignore if handler isn't wired yet
      }
      driveResults.setAttribute("aria-live", "polite");
      driveResults.setAttribute("role", "status");
      driveResultsMode = "output";
      driveResultEntries = [];
      driveWarningsSeen.clear();
      const testSize = clampInt(testSizeSelect?.value || 1024, 1, 2048);
      const mode = modeSelect?.value || "sequential";
      const handler = mode === "random" ? "run-drive-test-random" : "run-drive-test";
      appendDriveResults({
        type: "start",
        data: {
          mode,
          testSize,
          totalIterations: ITERATIONS,
          warmupIterations: WARMUP_ITERATIONS
        }
      });

      try {
        // Compute total bytes for this batch of tests
        const phasesPerIteration = PHASES_PER_ITERATION; // write + read
        const plannedTotalBytes = paths.length * ITERATIONS * phasesPerIteration * testSize * BYTES_PER_MIB;
        completedBytes = 0;
        displayedPct = 0;
        targetPct = 0;

        // ✅ Make sure we don't double-bind progress
        if (driveTestProgressHandler) {
          if (typeof ipc.off === "function") {
            ipc.off("drive-test-progress", driveTestProgressHandler);
          } else if (typeof ipc.removeListener === "function") {
            ipc.removeListener("drive-test-progress", driveTestProgressHandler);
          }
        }
        if (driveTestWarningHandler) {
          if (typeof ipc.off === "function") {
            ipc.off("drive-test-warning", driveTestWarningHandler);
          } else if (typeof ipc.removeListener === "function") {
            ipc.removeListener("drive-test-warning", driveTestWarningHandler);
          }
        }
        driveTestProgressHandler = (_event, payload) => {
          if (!driveTestActive) return;
          if (driveCancelRequested) return;
          if (!payload || typeof payload.bytes !== "number") return;
          const delta = Math.max(0, payload.bytes);
          // If totals aren't ready yet (or a late event from a previous run arrives),
          // buffer progress so the UI doesn't start/end "wrong".
          if (totalBytes <= 0) {
            pendingDriveProgressBytes += delta;
            return;
          }
          // First real progress tick: switch UI from "Initializing..." to progress bar + %.
          if (driveUiPhase !== "running") {
            setDriveUiPhase("running");
          }
          const effectiveDelta = delta + pendingDriveProgressBytes;
          pendingDriveProgressBytes = 0;
          completedBytes = Math.min(completedBytes + effectiveDelta, totalBytes);
          const pct = (completedBytes / totalBytes) * 100;
          targetPct = pct > 100 ? 100 : pct;
          startSmoothProgress();
        };
        driveTestWarningHandler = (_event, payload) => {
          if (!driveTestActive) return;
          if (driveCancelRequested) return;
          addDriveWarning(mapDriveWarning(payload));
        };
        ipc.on("drive-test-progress", driveTestProgressHandler);
        ipc.on("drive-test-warning", driveTestWarningHandler);

        // reset inline loader + show hamster (drive tests only)
        resetProgressUI();
        totalBytes = plannedTotalBytes;
        // Show a consistent starting state (0%) instead of a blank/leftover value.
        if (inlineOutput) inlineOutput.value = 0;
        // Show "Initializing..." until the backend starts emitting progress bytes.
        setDriveUiPhase("initializing");
        showSpeedtestHamsterForDrives();

        // If any buffered progress arrived before totals were set, apply it now.
        if (pendingDriveProgressBytes > 0 && totalBytes > 0) {
          setDriveUiPhase("running");
          completedBytes = Math.min(completedBytes + pendingDriveProgressBytes, totalBytes);
          pendingDriveProgressBytes = 0;
          targetPct = Math.min(100, (completedBytes / totalBytes) * 100);
          startSmoothProgress();
        }

        for (let i = 0; i < selectedDrivePaths.length; i++) {
          if (driveCancelRequested) break;
          const path = selectedDrivePaths[i];
          if (!path) continue;
          appendDriveResults({ type: "inProgress", data: { index: i + 1, path } });
          const res = await ipc.invoke(handler, path, testSize);
          if (res?.cancelled) {
            driveCancelRequested = true;
            appendDriveResults({ type: "cancelled", data: {} });
            break;
          }
          if (res?.warning) {
            const warnings = Array.isArray(res.warning) ? res.warning : [res.warning];
            warnings.forEach((warning) => addDriveWarning(mapDriveWarning(warning)));
          }
          if (res.success) {
            appendDriveResults({
              type: "result",
              data: {
                index: i + 1,
                path,
                write: res.write,
                writeMin: res.writeMin,
                writeMax: res.writeMax,
                read: res.read,
                readMin: res.readMin,
                readMax: res.readMax,
                timestampMs: Date.now()
              }
            });
          } else {
            hadFailure = true;
            const code = res?.code;
            if (code === "INSUFFICIENT_DISK_SPACE" && typeof res?.freeBytes === "number" && typeof res?.requiredBytes === "number") {
              keepDriveSelections = true;
              appendDriveResults({
                type: "error",
                data: { code, index: i + 1, path, requiredBytes: res.requiredBytes, freeBytes: res.freeBytes }
              });
            } else if (code === "DRIVE_NOT_WRITABLE") {
              keepDriveSelections = true;
              appendDriveResults({ type: "error", data: { code, index: i + 1, path } });
            } else if (code === "DISK_SPACE_CHECK_FAILED") {
              keepDriveSelections = true;
              appendDriveResults({ type: "error", data: { code, index: i + 1, path, error: res?.error } });
            } else {
              appendDriveResults({ type: "error", data: { code, index: i + 1, path, error: res?.error } });
            }
          }
        }
        if (!driveCancelRequested && !hadFailure && inlineProgress) {
          renderDriveProgressImmediate(100);
        }
      } catch (err) {
        if (driveCancelRequested) {
          appendDriveResults({ type: "cancelled", data: {} });
        } else {
          hadFailure = true;
          appendDriveResults({ type: "failure", data: { code: err?.code, error: err?.message || err } });
        }
      } finally {
        if (driveTestProgressHandler) {
          if (typeof ipc.off === "function") {
            ipc.off("drive-test-progress", driveTestProgressHandler);
          } else if (typeof ipc.removeListener === "function") {
            ipc.removeListener("drive-test-progress", driveTestProgressHandler);
          }
        }
        if (driveTestWarningHandler) {
          if (typeof ipc.off === "function") {
            ipc.off("drive-test-warning", driveTestWarningHandler);
          } else if (typeof ipc.removeListener === "function") {
            ipc.removeListener("drive-test-warning", driveTestWarningHandler);
          }
        }

        // Swap bar/% out for "Finalizing..." while we detach handlers + reset UI.
        setDriveUiPhase("finalizing");

        const teardown = () => {
          if (inlineLoader) inlineLoader.classList.remove("is-active");
          hideSpeedtestHamsterForDrives();
          setDriveTestActive(false);
          // Defer resetting the visible progress values until after the loader is hidden
          // so the bar/number don't visibly snap at the end.
          requestAnimationFrame(() => resetProgressUI());
        };

        // 🔥 Hide progress bar and hamster together after a short delay
        // so the 100% state is actually visible.
        if (inlineProgress || inlineOutput) {
          setTimeout(teardown, 400);
        } else {
          teardown();
        }

        keepDriveSelections = keepDriveSelections || driveCancelRequested;
        // Keep selections when a user needs to adjust test size / free space.
        if (!keepDriveSelections) {
          selectedDrivePaths.fill("");
          drivePathSlotStates.forEach((_, index) => {
            drivePathSlotStates[index] = { kind: "empty" };
          });
        }
        updateDrivePathsDisplay();
      }
    });

    // 🛑 Drive Tests: Cancel
    cancelSpeedtestBtn?.addEventListener("click", async () => {
      if (!driveTestActive || driveCancelRequested) return;
      driveCancelRequested = true;
      updateSpeedtestButtonsState();

      appendDriveResults({ type: "cancelRequested", data: {} });
      try {
        await ipc.invoke("cancel-drive-test");
      } catch {
        // ignore if handler isn't wired yet
      }
    });

    // 🛑 Reset (Drive Tests only)
    resetSpeedtestBtn?.addEventListener("click", async () => {
      // Reset is intentionally disabled while a Drive Test is running.
      if (driveTestActive) return;

      renderDriveResultsPlaceholder();
      resetProgressUI();
      hideSpeedtestHamsterForDrives();
      selectedDrivePaths.fill("");
      drivePathSlotStates.forEach((_, index) => {
        drivePathSlotStates[index] = { kind: "empty" };
      });
      updateDrivePathsDisplay();
      setDriveTestActive(false);

      try {
        await ipc.invoke("reset-drive-test-cancel");
      } catch {
        // ignore if handler isn't wired yet
      }

      updateSpeedtestButtonsState();
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
