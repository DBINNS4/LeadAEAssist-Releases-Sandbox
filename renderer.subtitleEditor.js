(() => {
  const loaderToken = window.__subtitleEditorLoaderToken || null;
  const bootState = window.__subtitleEditorBootState || (window.__subtitleEditorBootState = {});
  if (bootState.initialized) {
    console.info(`[subtitleEditor] duplicate renderer bootstrap skipped (loaderToken=${loaderToken || 'none'})`);
    if (loaderToken) bootState.readyToken = loaderToken;
    window.dispatchEvent(new CustomEvent('subtitle-editor-ready', { detail: { token: bootState.readyToken || loaderToken } }));
    return;
  }
  bootState.initialized = true;
  if (loaderToken) bootState.readyToken = loaderToken;
  // ---- Broadcast caption geometry (CEA-608 / CTA-708) ----------------------
  // Specs (FCC 00-259 / EIA-708 decoder guidance):
  //   - Captions live inside the "safe-title" area: inner 80% (width/height), centered.
  //   - Minimum grid resolution covering safe-title:
  //       * 4:3: 15 rows x 32 cols
  //       * 16:9: 15 rows x 42 cols
  //
  // Practical note: legacy CEA-608 captions in HD are typically carried in a centered 4:3
  // caption aperture. So for 608 preview math we derive that 4:3 aperture first, then
  // apply the same 80% safe-title reduction.
  function _calcBroadcastSafeTitleGeometry(rect, track) {
    const r = rect || { width: 1, height: 1 };
    const w = Math.max(1, Number(r.width) || 1);
    const h = Math.max(1, Number(r.height) || 1);
    const is708 = String(track) === '708';
    const cols = is708 ? 42 : 32;

    // 608: derive a centered 4:3 active region inside the preview box.
    const activeW = is708 ? w : Math.min(w, h * (4 / 3));
    const activeLeft = is708 ? 0 : (w - activeW) / 2;

    // Safe-title rectangle (inner 80%) inside the active region.
    const safeWidth = activeW * 0.8;
    const safeLeft = activeLeft + (activeW - safeWidth) / 2;

    const safeH = h * 0.8;
    const safeTop = (h - safeH) / 2;

    // The preview grid spans the safe-title rectangle.
    const gridLeft = safeLeft;
    const gridW = safeWidth;
    const gridTop = safeTop;
    const gridH = safeH;

    const cellW = gridW / cols;

    return { activeLeft, activeW, gridLeft, gridW, gridTop, gridH, cellW, safeLeft, safeWidth, safeTop, safeH, cols };
  }

  function _rowToYPx15(row, fullHeight) {
    const h = Math.max(0, Number(fullHeight) || 0);
    if (!h) return 0;

    const safeH = h * 0.8;
    const safeTop = (h - safeH) / 2;

    const clampedRow = Math.min(15, Math.max(1, Number(row) || 15));
    const rowH = safeH / 15;

    // Vertical centre of the row.
    return Math.round(safeTop + rowH * (clampedRow - 0.5));
  }

  // Inverse of _rowToYPx15(): yPxLocal is relative to the overlay's top edge.
  function _nearestRow15(yPxLocal, fullHeight) {
    const h = Math.max(0, Number(fullHeight) || 0);
    if (!h) return 15;

    const safeH = h * 0.8;
    const safeTop = (h - safeH) / 2;

    const rowH = safeH / 15;
    const y = Number(yPxLocal) || 0;

    const approx = ((y - safeTop) / Math.max(1e-6, rowH)) + 0.5;
    const row = Math.round(approx);
    return Math.min(15, Math.max(1, row));
  }

  // Unit-test shortcut: don't execute the full renderer bootstrap in Jest.
  if (typeof module !== 'undefined' && module.exports &&
      typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test') {
    module.exports = { _calcBroadcastSafeTitleGeometry, _rowToYPx15, _nearestRow15 };
    return;
  }

  function formatFallback(template, vars) {
    if (!template || !vars) return template;
    return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        return String(vars[key]);
      }
      return '';
    });
  }

  function tr(key, fallback, vars) {
    if (typeof window.i18n?.t === 'function') {
      const options = { ...(vars || {}) };
      if (fallback != null) options.defaultValue = fallback;
      return window.i18n.t(key, options);
    }
    if (fallback != null) return formatFallback(fallback, vars);
    return key;
  }

  const SUBTITLE_EDITOR_DEBUTT_DROPDOWN_OPTS = [
    { value: 'end', label: tr('subtitleEditor.dropdown.debutt.end', 'Debutt: Trim end (1f gap)') },
    { value: 'start', label: tr('subtitleEditor.dropdown.debutt.start', 'Debutt: Trim start (1f gap)') },
    { value: 'both', label: tr('subtitleEditor.dropdown.debutt.both', 'Debutt: Trim both (2f gap)') }
  ];

  const SUBTITLE_EDITOR_708_PLACEMENT_DROPDOWN_OPTS = [
    { value: 'zones', label: tr('subtitleEditor.dropdown.placement708.zones', 'Zones') },
    { value: 'exact', label: tr('subtitleEditor.dropdown.placement708.exact', 'Exact') }
  ];

  const SUBTITLE_EDITOR_608_TARGET_DROPDOWN_OPTS = [
    { value: 'block', label: tr('subtitleEditor.dropdown.target608.block', 'Block') },
    { value: 'line1', label: tr('subtitleEditor.dropdown.target608.line1', 'Line 1') },
    { value: 'line2', label: tr('subtitleEditor.dropdown.target608.line2', 'Line 2') }
  ];

  // ------------------------------------------------------------
  // Styled dropdown helpers (shared component with main panels)
  // ------------------------------------------------------------

  function _setupStyledDropdownSafe(hiddenId, options, value) {
    try {
      if (typeof window.setupStyledDropdown === 'function') {
        window.setupStyledDropdown(hiddenId, Array.isArray(options) ? options : []);
      }
    } catch {}

    try {
      if (typeof window.setDropdownValue === 'function') {
        window.setDropdownValue(hiddenId, value);
      } else {
        const el = document.getElementById(hiddenId);
        if (el) el.value = (value ?? '');
      }
    } catch {}

    // Defensive: ensure any stale filter state isn't persisted across refreshes.
    try {
      const w = document.getElementById(hiddenId)?.closest?.('.dropdown-wrapper');
      w?.querySelectorAll?.('.value-list li')?.forEach?.((li) => { li.style.display = ''; });
    } catch {}
  }

  function _setStyledDropdownValueSafe(hiddenId, value) {
    try {
      if (typeof window.setDropdownValue === 'function') {
        window.setDropdownValue(hiddenId, value);
        return;
      }
    } catch {}

    try {
      const el = document.getElementById(hiddenId);
      if (!el) return;
      el.value = String(value ?? '');

      const wrap = el.closest?.('.dropdown-wrapper');
      const input = wrap?.querySelector?.('.chosen-value');
      const match = wrap?.querySelector?.(`.value-list li[data-value="${String(value)}"]`);
      if (input && match) input.value = String(match.textContent || '');
    } catch {}
  }

  function _mkStyledDropdownWrapper({ hiddenId, name, ariaLabel, wrapperClass = '', inputId = '', placeholder = '' } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `dropdown-wrapper dropdown-display subtitle-editor-dropdown ${wrapperClass || ''}`.trim();
    // Subtitle editor dropdowns should be compact; the global dropdown styles add margins.
    try { wrap.style.margin = '0'; } catch {}

    const input = document.createElement('input');
    input.type = 'text';
    input.id = inputId || `${hiddenId}-input`;
    input.className = 'chosen-value';
    input.placeholder = placeholder || '';
    if (ariaLabel) input.setAttribute('aria-label', String(ariaLabel));
    input.autocomplete = 'off';

    const list = document.createElement('ul');
    list.className = 'value-list';

    const arrow = document.createElement('span');
    arrow.className = 'dropdown-arrow';

    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.id = hiddenId;
    if (name) hidden.name = String(name);

    wrap.appendChild(input);
    wrap.appendChild(list);
    wrap.appendChild(arrow);
    wrap.appendChild(hidden);

    return { wrap, hidden, input, list };
  }

  // --- Telemetry self-test hooks (dev/test only) ---
  // These helpers intentionally throw from inside renderer.subtitleEditor.js so
  // Sentry captures frames attributable to this window's renderer code.
  // They are inert unless explicitly called.
  window['__LEAD_SENTRY_SELFTEST_THROW_SUBTITLE_EDITOR'] = function __LEAD_SENTRY_SELFTEST_THROW_SUBTITLE_EDITOR() {
    throw new Error('LEAD_SENTRY_SELFTEST_SUBTITLE_EDITOR_THROW');
  };

  // Lightweight format detector for SCC-mode behaviors
  function isSccDoc(doc) {
    if (!doc) return false;
    const kind = String(doc.kind || doc.format || '').toLowerCase();
    if (kind === 'scc' || kind === 'cea608' || kind === '608') return true;
    const src = String(doc.sourcePath || doc.displayName || '').toLowerCase();
    return src.endsWith('.scc');
  }

  function isMccDoc(doc) {
    if (!doc) return false;
    const kind = String(doc.kind || doc.format || '').toLowerCase();
    if (kind === 'mcc') return true;
    const src = String(doc.sourcePath || doc.displayName || '').toLowerCase();
    return src.endsWith('.mcc');
  }

  function isSrtDoc(doc) {
    if (!doc) return false;
    const kind = String(doc.kind || doc.format || '').toLowerCase();
    if (kind === 'srt') return true;
    const src = String(doc.sourcePath || doc.displayName || '').toLowerCase();
    return src.endsWith('.srt');
  }

  function isVttDoc(doc) {
    if (!doc) return false;
    const kind = String(doc.kind || doc.format || '').toLowerCase();
    if (kind === 'vtt' || kind === 'webvtt') return true;
    const src = String(doc.sourcePath || doc.displayName || '').toLowerCase();
    return src.endsWith('.vtt');
  }

  function resolveCorrectionExportFormat(doc, requestedFormat = '') {
    const explicit = String(requestedFormat || '').trim().toLowerCase();
    if (explicit === 'srt' || explicit === 'vtt' || explicit === 'json') return explicit;

    const kind = String(doc?.kind || doc?.format || '').trim().toLowerCase();
    if (kind === 'srt') return 'srt';
    if (kind === 'vtt' || kind === 'webvtt') return 'vtt';
    if (kind === 'json' || kind === 'finaljson' || kind === 'final.json') return 'json';

    const src = String(doc?.sourcePath || doc?.displayName || '').trim().toLowerCase();
    if (src.endsWith('.srt')) return 'srt';
    if (src.endsWith('.vtt')) return 'vtt';
    if (src.endsWith('.json')) return 'json';

    if (doc?.originalJson && typeof doc.originalJson === 'object') return 'json';
    return isVttDoc(doc) ? 'vtt' : 'srt';
  }

  // Web-style captions (SRT / WebVTT) have different editing/display rules than 608.
  function isWebCaptionDoc(doc) {
    return isSrtDoc(doc) || isVttDoc(doc);
  }

  // Editor UI routing mode (Commit 1):
  // - 'broadcast' => SCC/MCC authoring & preview controls (locked)
  // - 'web'       => SRT/VTT authoring & preview controls
  const EditorMode = Object.freeze({ BROADCAST: 'broadcast', WEB: 'web' });

  function resolveEditorMode(doc) {
    return isWebCaptionDoc(doc) ? EditorMode.WEB : EditorMode.BROADCAST;
  }

  // 608-style docs (SCC + 608-only MCC) are hard-limited to 2 rows.
  function is608Doc(doc) {
    // Web captions (SRT/VTT) must never inherit 608 restrictions, even if stale
    // session state leaves doc.kind/doc.format pointing at SCC/MCC.
    if (isWebCaptionDoc(doc)) return false;
    return isSccDoc(doc) || (isMccDoc(doc) && !is708Doc(doc));
  }

  function _readMaxLinesPerBlock(doc, formatHint = null) {
    const f = String(formatHint || '').trim().toLowerCase();
    const raw =
      (f === 'srt' ? (doc?.formats?.srt?.maxLinesPerBlock ?? doc?.srtOptions?.maxLinesPerBlock) : null) ??
      (f === 'vtt' ? (doc?.formats?.vtt?.maxLinesPerBlock ?? doc?.vttOptions?.maxLinesPerBlock) : null) ??
      doc?.formats?.srt?.maxLinesPerBlock ??
      doc?.formats?.vtt?.maxLinesPerBlock ??
      doc?.srtOptions?.maxLinesPerBlock ??
      doc?.vttOptions?.maxLinesPerBlock ??
      doc?.maxLinesPerBlock ??
      doc?.maxLines ??
      null;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.trunc(n));
  }

  function _readAssistMaxLinesPerBlock(formatHint = null) {
    const f = String(formatHint || '').trim().toLowerCase();
    const read = (...keys) => {
      for (const key of keys) {
        try {
          const raw = localStorage.getItem(key);
          if (raw == null || String(raw).trim() === '') continue;
          const n = Number(raw);
          if (Number.isFinite(n)) return Math.max(1, Math.trunc(n));
        } catch {}
      }
      return null;
    };
    if (f === 'srt') return read('fmt-srt-max-lines', 'srt-max-lines');
    if (f === 'vtt') return read('fmt-vtt-max-lines', 'vtt-max-lines');
    return (
      read('fmt-srt-max-lines', 'srt-max-lines') ??
      read('fmt-vtt-max-lines', 'vtt-max-lines')
    );
  }

  function _readMaxCharsPerLine(doc, formatHint = null) {
    const f = String(formatHint || '').trim().toLowerCase();
    const raw =
      (f === 'srt' ? (doc?.formats?.srt?.maxCharsPerLine ?? doc?.srtOptions?.maxCharsPerLine) : null) ??
      (f === 'vtt' ? (doc?.formats?.vtt?.maxCharsPerLine ?? doc?.vttOptions?.maxCharsPerLine) : null) ??
      doc?.formats?.srt?.maxCharsPerLine ??
      doc?.formats?.vtt?.maxCharsPerLine ??
      doc?.srtOptions?.maxCharsPerLine ??
      doc?.vttOptions?.maxCharsPerLine ??
      doc?.maxCharsPerLine ??
      doc?.maxChars ??
      null;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.trunc(n));
  }

  function _readAssistMaxCharsPerLine(formatHint = null) {
    const f = String(formatHint || '').trim().toLowerCase();
    const read = (...keys) => {
      for (const key of keys) {
        try {
          const raw = localStorage.getItem(key);
          if (raw == null || String(raw).trim() === '') continue;
          const n = Number(raw);
          if (Number.isFinite(n)) return Math.max(1, Math.trunc(n));
        } catch {}
      }
      return null;
    };
    if (f === 'srt') return read('fmt-srt-max-chars', 'srt-max-chars');
    if (f === 'vtt') return read('fmt-vtt-max-chars', 'vtt-max-chars');
    return (
      read('fmt-srt-max-chars', 'srt-max-chars') ??
      read('fmt-vtt-max-chars', 'vtt-max-chars')
    );
  }

  function _maxLinesForCueLines(doc) {
    if (!doc) return 2;
    if (is608Doc(doc)) return 2;
    if (is708Doc(doc)) return 15;
    if (isWebCaptionDoc(doc)) {
      // Prefer format-scoped settings (Transcribe panel), else fall back to 3 (UI cap).
      const hint = isSrtDoc(doc) ? 'srt' : (isVttDoc(doc) ? 'vtt' : null);
      return _readMaxLinesPerBlock(doc, hint) ?? 3;
    }
    // Generic fallback: if the doc carries a shaping setting, respect it; otherwise be permissive.
    return _readMaxLinesPerBlock(doc) ?? 3;
  }

  function _shouldTreatPipeAsHardBreak(doc) {
    // Pipe-as-newline is a legacy/editor-internal convention for 608/MCC-like formats.
    // For SRT/VTT, '|' is a legitimate glyph and must be preserved.
    return !!(doc && !isWebCaptionDoc(doc));
  }

  function is708Doc(doc) {
    if (!doc) return false;
    const kind = String(doc.kind || doc.format || '').toLowerCase();
    if (kind === 'cea708' || kind === '708' || kind === 'dtvcc') return true;

    // Some importers attach 708 window data to cues even when doc.kind is generic.
    if (String(doc.format || '').toLowerCase() === 'mcc') {
      // MCC is *usually* 708-capable. Even when we strip heavyweight cue.cea708 snapshots
      // (session merge hygiene), we still want the editor to behave as a 708+derived-608 doc.
      // If the doc explicitly declares itself as 608-only, treat it as such.
      if (kind === 'cea608' || kind === '608') return false;
      return true;
    }
    return false;
  }

  // Milestone 5: show a side-by-side preview when the source is 708-capable.
  // Left pane: 708 (authoring source). Right pane: 608 (derived, with overrides).
  function wantsDualPreview(doc) {
    return is708Doc(doc);
  }

  function _include608CompatibilityEnabled(doc) {
    const v = doc?.mccOptions?.include608Compatibility ?? doc?.include608Compatibility;
    return v !== false;
  }

  function _getDocStartTimecodeLabel(doc) {
    if (!doc) return null;
    const raw =
      doc.startTc ||
      doc.startTC ||
      doc?.metadata?.startTimecode ||
      doc?.metadata?.startTc ||
      null;
    const s = (typeof raw === 'string') ? raw.trim() : '';
    return s || null;
  }

  function _getDocTimecodeOffsetSeconds(doc) {
    // Start TC is an offset that maps media time (t=0) to a SMPTE label (common for broadcast deliverables).
    // For SCC, we keep cues in 0-based seconds and store the base TC in doc.startTc so preview + export line up.
    if (!doc) return 0;
    if (doc.keepAbsoluteTimecode === true) return 0;
    const tc = _getDocStartTimecodeLabel(doc);
    if (!tc) return 0;

    const fps = Number(doc?.fps) || 30;
    const drop = !!doc?.dropFrame;

    try {
      const ms = window.transcribeEngine?.parseTime?.(tc, fps, drop ? true : null);
      const sec = (typeof ms === 'number' && !Number.isNaN(ms)) ? (ms / 1000) : 0;
      return Number.isFinite(sec) ? sec : 0;
    } catch {
      return 0;
    }
  }

  // Decide if this document should use SMPTE timecode display (HH:MM:SS:FF)
  function usesSmpteTimecode(doc) {
    if (!doc) return false;
    if (isSccDoc(doc)) return true; // SCC is always SMPTE-style
    // Also use SMPTE if the doc carries an explicit Start TC offset (common for broadcast deliverables).
    return !!_getDocStartTimecodeLabel(doc);
  }

  function refreshDebuttUiForDoc(doc) {
    // Debutt is a bulk timing helper that creates a small gap (1–2 frames)
    // between adjacent cues.
    //
    // It was originally added for frame-based broadcast deliverables (SCC/MCC),
    // but it also maps cleanly onto web captions (SRT/VTT) when editors want a
    // consistent frame-gap between cues.
    const show = !!doc && (isWebCaptionDoc(doc) || isSccDoc(doc) || isMccDoc(doc) || usesSmpteTimecode(doc));
    const hasCues = !!doc && Array.isArray(doc.cues) && doc.cues.length > 0;
    if (debuttModeWrap || debuttModeSel) {
      const wrapper = debuttModeWrap || debuttModeSel?.closest?.('.dropdown-wrapper');
      const inputEl = wrapper?.querySelector?.('.chosen-value');
      const target = wrapper || debuttModeSel;

      if (target) target.style.display = show ? '' : 'none';
      if (wrapper) wrapper.classList.toggle('disabled', !show);
      if (debuttModeSel) debuttModeSel.disabled = !show;
      if (inputEl) inputEl.disabled = !show;
    }
    if (debuttAllBtn) {
      debuttAllBtn.style.display = show ? '' : 'none';
      debuttAllBtn.disabled = !(show && hasCues);
    }
  }

  // Reduce the Debutt policy dropdown width so it only fits the longest option label.
  // (The app-wide form control styles set select{width:100%}, which is too wide in the cue header.)
  function sizeDebuttModeSelectToLongestOption() {
    const wrapper = debuttModeWrap || debuttModeSel?.closest?.('.dropdown-wrapper');
    const inputEl = wrapper?.querySelector?.('.chosen-value') || debuttModeSel;
    if (!inputEl) return;

    try {
      // Measure option text using the select's computed font.
      const cs = getComputedStyle(inputEl);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Prefer the full computed font string when available.
      const font = cs.font && cs.font !== '' ? cs.font : `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.font = font;

      const labels = Array.isArray(SUBTITLE_EDITOR_DEBUTT_DROPDOWN_OPTS)
        ? SUBTITLE_EDITOR_DEBUTT_DROPDOWN_OPTS.map((opt) => String(opt?.label ?? opt?.value ?? ''))
        : Array.from(debuttModeSel?.options || []).map((opt) => String(opt?.text || ''));

      let maxTextW = 0;
      for (const label of labels) {
        const w = ctx.measureText(label).width;
        if (w > maxTextW) maxTextW = w;
      }

      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0;

      // Space for the native dropdown arrow + right-side gutter.
      // (We already include padding; this is the extra chrome area.)
      const arrowGutter = 34;
      const px = Math.ceil(maxTextW + pl + pr + bl + br + arrowGutter);

      const target = wrapper || debuttModeSel;
      if (target) {
        target.style.width = `${px}px`;
        target.style.flex = '0 0 auto';
      }
    } catch {
      // Fall back to CSS sizing (width:auto) if anything goes sideways.
    }
  }

  // Keep the preview frame sized to the actual video so overlays stay aligned.
  function bindVideoAspectToFrame(videoEl, hostEl) {
    if (!videoEl || !hostEl) return;
    const apply = () => {
      const w = videoEl.videoWidth || 1920;
      const h = videoEl.videoHeight || 1080;
      hostEl.style.setProperty('--video-aspect', `${w} / ${h}`);
      // When the preview area is height-constrained (splitter drag / small windows),
      // the <video> will continue to scale proportionally but the host box can be
      // forced into a squashed aspect ratio by layout. That breaks overlays.
      // Keep the host fitted after we learn the real aspect.
      try { schedulePreviewHostFit(); } catch {}
    };
    if (videoEl.readyState >= 1) apply();
    videoEl.addEventListener('loadedmetadata', apply, { once: true });
  }

  // Fit preview hosts to their available slot while preserving the true video aspect.
  // This prevents the preview frame/grid from being "flattened" when the preview
  // row is shorter than the natural 16:9 (or source) height.
  let previewHostFitRaf = 0;
  function schedulePreviewHostFit() {
    if (previewHostFitRaf) return;
    previewHostFitRaf = requestAnimationFrame(() => {
      previewHostFitRaf = 0;
      try { fitAllPreviewVideoHosts(); } catch {}
    });
  }

  function _parseAspectRatio(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = s.match(/([0-9.]+)\s*\/\s*([0-9.]+)/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
    return a / b;
  }

  function fitPreviewVideoHost(hostEl) {
    if (!hostEl || !hostEl.getBoundingClientRect) return;
    const pane = hostEl.closest?.('.preview-pane') || hostEl.parentElement;
    if (!pane || !pane.getBoundingClientRect) return;

    // Skip hidden panes.
    const paneRect = pane.getBoundingClientRect();
    if (!paneRect || paneRect.width <= 1 || paneRect.height <= 1) return;

    const labelEl = pane.querySelector?.('.preview-label') || null;
    const labelH = labelEl?.getBoundingClientRect?.().height || 0;
    let gap = 0;
    try {
      const cs = getComputedStyle(pane);
      gap = parseFloat(cs.rowGap || cs.gap || '0') || 0;
    } catch {}

    const availableW = Math.max(0, paneRect.width);
    const availableH = Math.max(0, paneRect.height - labelH - gap);
    if (availableW <= 1 || availableH <= 1) return;

    // Height-constraining the preview host only makes sense when the preview row itself
    // is fixed (user resized / persisted --preview-h). When the preview row is auto-sized,
    // the pane height is content-driven and includes the host itself; treating that as a
    // hard constraint can create a feedback loop (continuous shrink/grow) from subpixel
    // rounding differences.
    const overlayRoot = hostEl.closest?.('#subtitle-editor-overlay') || null;
    const hasFixedPreviewH = !!String(overlayRoot?.style?.getPropertyValue?.('--preview-h') || '').trim();


    // Match the legacy CSS cap for the preview frame.
    const maxW = Math.min(availableW, 960);

    const videoEl = hostEl.querySelector?.('video') || null;
    const vw = Number(videoEl?.videoWidth) || 0;
    const vh = Number(videoEl?.videoHeight) || 0;
    const aspect = (vw > 0 && vh > 0)
      ? (vw / vh)
      : (
          _parseAspectRatio(hostEl.style?.getPropertyValue?.('--video-aspect')) ||
          _parseAspectRatio(getComputedStyle(hostEl).getPropertyValue('--video-aspect')) ||
          (16 / 9)
        );

    if (!Number.isFinite(aspect) || aspect <= 0) return;

    // "Contain" sizing: start by filling width, then fall back to height.
    let w = maxW;
    let h = w / aspect;
    if (hasFixedPreviewH && h > availableH) {
      h = availableH;
      w = h * aspect;
    }

    const EPS = 0.01;
    w = Math.max(1, Math.floor(w + EPS));
    h = Math.max(1, Math.floor(h + EPS));

    const prevW = parseFloat(hostEl.style.getPropertyValue('inline-size') || '') || 0;
    const prevH = parseFloat(hostEl.style.getPropertyValue('block-size') || '') || 0;
    if (Math.abs(prevW - w) < 0.5 && Math.abs(prevH - h) < 0.5) return;

    hostEl.style.setProperty('inline-size', `${w}px`);
    hostEl.style.setProperty('block-size', `${h}px`);
  }

  function fitAllPreviewVideoHosts() {
    const root = document.getElementById('subtitle-editor-overlay') || document;
    const hosts = root?.querySelectorAll?.('.preview-video-host');
    if (!hosts || !hosts.length) return;
    hosts.forEach((h) => { try { fitPreviewVideoHost(h); } catch {} });
  }

  function installPreviewHostFitter(rootEl) {
    const root = rootEl || document.getElementById('subtitle-editor-overlay');
    if (!root) return;

    const panesEl = root.querySelector?.('#subtitle-editor-preview-panes');
    if (!panesEl) return;

    // Observe the preview panes container: any width/height change means the host slots
    // changed, so we refit both frames.
    if (typeof ResizeObserver === 'function') {
      if (!panesEl.__previewHostFitRO) {
        panesEl.__previewHostFitRO = new ResizeObserver(() => {
          try { schedulePreviewHostFit(); } catch {}
        });
        panesEl.__previewHostFitRO.observe(panesEl);
      }
    } else if (!panesEl.__previewHostFitWin) {
      panesEl.__previewHostFitWin = true;
      window.addEventListener('resize', () => { try { schedulePreviewHostFit(); } catch {} });
    }

    // Initial fit.
    try { schedulePreviewHostFit(); } catch {}
  }

  const overlayId = 'subtitle-editor-overlay';
  const isPopout = new URLSearchParams(location.search).get('win') === 'subtitle-editor';

  // In pop-out subtitle editor windows, ensure body class is applied even if the
  // transcribe renderer script fails to initialize in time.
  if (isPopout) {
    document.body.classList.add('subtitle-editor-window');
  }

  if (typeof ipc === 'undefined') {
    var ipc = window.ipc ?? window.electron;
  }

  async function revealInFinder(absPath) {
    const p = String(absPath ?? '').trim();
    if (!p) return;
    try {
      if (ipc && typeof ipc.invoke === 'function') {
        await ipc.invoke('shell:show-item-in-folder', p);
      }
    } catch (e) {
      // Fallback: do nothing (export already reports the path); avoid hard-crashing UI.
      console.warn('[subtitleEditor] revealInFinder failed:', e);
    }
  }

  // Always ensure the overlay exists so this module installs its API.
  let overlay = document.getElementById(overlayId);
  if (isPopout) {
    if (overlay && overlay.closest('#window-content')) {
      try {
        overlay.parentElement.removeChild(overlay);
        document.body.appendChild(overlay);
      } catch {}
    }
  }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = 'subtitle-editor hidden';
    // If pop-out, mount directly to body so it isn't hidden by #window-content styles
    const mount = (isPopout ? document.body : (document.getElementById('window-content') || document.body));
    mount.appendChild(overlay);
  }

  overlay.tabIndex = -1;

  const state = {
    doc: null,
    mode: EditorMode.BROADCAST,
    // Start-screen selection (before a document is opened).
    pendingSourcePath: null,
    // Guard: prevent double-launch while IPC open/convert is in-flight.
    startBusy: false,
    activeCue: -1,
    // Phase 4: per-cue edit mode memory (canonical vs per-track override editors).
    // Stored in-memory only (not persisted to project files).
    editModeByCue: {},
    activeEditMode: 'canonical',
    // P0-1: determinism guard for click/jump seeking (prevents time-follow from overriding selection mid-seek)
    pendingSeekTime: null,
    pendingSeekSetAtMs: 0,
    lastExport: null,
    // Priority 1: in-editor QC (guided cleanup)
    qc: {
      ok: true,
      perCue: [],
      // Phase 4: dual-track (708 + 608) cue-level status for the cue list.
      // Each entry: { ok708, ok608, legacyUnsafe, failTypes708, failTypes608, warnTypes708, warnTypes608, source708, source608 }
      trackPerCue: [],
      issues: [],
      filteredIssues: [],
      filters: { fail: true, warn: true },
      activeIssueId: null,
      activeIssuePos: -1,
      lastComputedAt: 0,
      // Cache for SCC encoder-derived QC stats (late EOC) so QC remains snappy.
      sccCache: { key: '', sccText: null, stats: null, lastError: null }
    },
    // Milestone 5: MCC dual-preview cache (708 authoring vs derived 608)
    mccPreview: {
      ok: false,
      preview708: null,
      preview608: null,
      warnings: [],
      lastError: null,
      pending: false,
      lastUpdatedAt: 0,
      lastConfigKey: ''
    },
    history: {
      undo: [],
      redo: [],
      lastGroupId: null,
      lastGroupAtMs: 0,
      isRestoring: false
    }
  };

  let uiBuilt = false;
  // Guard: prevent duplicate initial opens in the pop-out (init events can arrive
  // late, early, or not at all depending on preload timing).
  let hasOpenedOnce = false;
  let toolbarTitle;
  let toolbarMeta;
  let statusEl;
  let importIssuesEl;
  let importIssuesSummaryEl;
  let importIssuesBodyEl;
  let cuesContainer;
  let videoEl;          // primary (interactive) video element
  let videoEl608;       // secondary (synced) video element for derived 608 preview
  let previewHostEl;    // primary host (kept for backward compat)
  let previewHostEl708; // explicit host for 708 pane
  let previewHostEl608; // explicit host for 608 pane
  let scrubEl;
  let playPauseBtnEl;
  let durationEl;
  let currentTimeEl;
  let closeBtn;
  let insertCueBtn;
  let deleteCueBtn;
  let debuttAllBtn;
  let debuttModeWrap;
  let debuttModeSel;
  let placement708ModeWrap;
  let placement708ModeSelect;
  let placement608TargetWrap;
  let placement608TargetSelect;
  let webGuidesToggleEl;
  let hideQcToggleEl;
  // Resizable split panels
  let mainEl;
  let previewRootEl;
  let previewSplitterEl;
  let editorLowerEl;
  let qcSplitterEl;
  let webLimitsEl;
  let serviceSelectWrap;
  let serviceSelectEl;
  // Priority 1: QC UI elements
  let qcPanelEl;
  let qcCountsEl;
  let qcListEl;
  let qcInspectorPreEl;
  let qcInspectorLastText = '';
  let qcFilterFailEl;
  let qcFilterWarnEl;
  let qcPrevBtn;
  let qcNextBtn;
  let qcFirstFailBtn;
  let preview608OverridePillEl;

  // Start screen (file chooser): shown when the editor opens without a subtitle document.
  let startScreenEl;
  let startStatusEl;
  let startDropSubEl;
  let startDropMediaEl;
  let startSubFileEl;
  let startMediaFileEl;
  let startLaunchBtn;
  // WebVTT/TextTrack preview path removed. Custom 608 overlay is authoritative.

  // Milestone 5: debounce rebuilds of the in-memory MCC dual-preview.
  let mccPreviewDebounceTimer = null;
  let mccPreviewRequestId = 0;

  // When seeking in SMPTE/frame timecode mode, snap the playhead to the nearest
  // frame boundary so native video controls don't land on "frame-looking" but
  // millisecond-precise times.
  let smpteSeekSnapInProgress = false;

  // Priority 1: debounce QC recompute (avoid per-keystroke full scans)
  let qcDebounceTimer = null;
  let qcRecomputeRequestId = 0;

  // ------------------------------------------------------------
  // SCC Glyph Picker (CEA-608 extended glyphs)
  // ------------------------------------------------------------
  let glyphModalEl = null;
  let glyphData = null; // { groups: {...} }
  function ensureGlyphPickerCSS() {
    // Glyph picker CSS is shipped in style.css.
    // Inline <style> injection is blocked by the strict CSP (style-src-elem).
    return;
  }


  async function fetchGlyphsIfNeeded() {
    if (glyphData) return glyphData;
    if (!ipc?.invoke) return null;
    try {
      const resp = await ipc.invoke('subtitle-editor-get-scc-glyphs');
      if (!resp || resp.error || resp.ok === false) {
        setStatus(resp?.error || tr('subtitleEditor.status.loadSccGlyphsFailed', 'Failed to load SCC glyphs.'), true);
        return null;
      }
      glyphData = resp;
      return glyphData;
    } catch (err) {
      setStatus(tr('subtitleEditor.status.loadSccGlyphsError', 'Failed to load SCC glyphs: {{error}}', { error: err.message }), true);
      return null;
    }
  }

  function findActiveCueTextarea() {
    // Prefer focused textarea, fallback to active row.
    const focused = document.activeElement;
    if (focused && focused.tagName === 'TEXTAREA') return focused;
    return overlay.querySelector('.cue.active textarea') || null;
  }

  function insertAtCaret(textarea, valueToInsert) {
    if (!textarea) return false;
    const v = String(textarea.value ?? '');
    const ins = String(valueToInsert ?? '');
    const start = Number(textarea.selectionStart ?? v.length);
    const end = Number(textarea.selectionEnd ?? v.length);
    const next = v.slice(0, start) + ins + v.slice(end);
    textarea.value = next;

    // Restore caret after insertion
    const caret = start + ins.length;
    try {
      textarea.setSelectionRange(caret, caret);
    } catch {}

    // Route through existing editor update pipeline:
    const row = textarea.closest('.cue');
    const idx = row ? parseInt(row.dataset.index || '-1', 10) : -1;
    if (Number.isInteger(idx) && idx >= 0) {
      try { autoSizeTextarea(textarea); } catch {}
      const track = String(textarea.dataset.track || 'canonical');
      try {
        if (track === '608') {
          const cue = state.doc?.cues?.[idx];
          _setCompat608OverrideText(cue, textarea.value, { groupId: `text:${idx}:608` });
          updateCompat608UiForCueRow(idx);
          state.activeCue = idx;
          markDirty();
        } else if (track === '708') {
          const cue = state.doc?.cues?.[idx];
          _setOverride708Text(cue, textarea.value, { groupId: `text:${idx}:708` });
          updateOverride708UiForCueRow(idx);
          state.activeCue = idx;
          markDirty();
        } else {
          updateCueText(idx, textarea.value);
        }
      } catch {}
      try { renderActiveCue608(); } catch {}
    }
    return true;
  }

  function closeGlyphPicker() {
    if (!glyphModalEl) return;
    try { glyphModalEl.remove(); } catch {}
    glyphModalEl = null;
  }

  function openGlyphPicker() {
    if (!isSccDoc(state.doc)) return;
    ensureGlyphPickerCSS();
    if (glyphModalEl) return;

    glyphModalEl = document.createElement('div');
    glyphModalEl.className = 'glyph-modal';
    glyphModalEl.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true" aria-label="${tr('subtitleEditor.glyph.dialogAriaLabel', 'CEA-608 Glyph Picker')}">
        <div class="header">
          <strong>${tr('subtitleEditor.glyph.title', 'CEA-608 Glyphs')}</strong>
          <div class="spacer"></div>
          <input type="search" id="glyph-search" placeholder="${tr('subtitleEditor.glyph.searchPlaceholder', 'Search glyph…')}" />
          <button type="button" class="close" id="glyph-close">${tr('subtitleEditor.glyph.close', 'Close')}</button>
        </div>
        <div class="tabs" id="glyph-tabs"></div>
        <div class="body">
          <div class="grid" id="glyph-grid"></div>
        </div>
        <div class="footer">
          <span id="glyph-count"></span>
          <span>${tr('subtitleEditor.glyph.footerHint', 'Click a glyph to insert into the active caption line')}</span>
        </div>
      </div>
    `;

    // click outside closes
    glyphModalEl.addEventListener('mousedown', (e) => {
      if (e.target === glyphModalEl) closeGlyphPicker();
    });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && glyphModalEl) {
        e.preventDefault();
        closeGlyphPicker();
        document.removeEventListener('keydown', onEsc, true);
      }
    }, true);

    document.body.appendChild(glyphModalEl);

    // Populate once we have glyph data
    (async () => {
      const data = await fetchGlyphsIfNeeded();
      if (!data?.groups) {
        closeGlyphPicker();
        return;
      }

      const tabsEl = glyphModalEl.querySelector('#glyph-tabs');
      const gridEl = glyphModalEl.querySelector('#glyph-grid');
      const searchEl = glyphModalEl.querySelector('#glyph-search');
      const closeEl = glyphModalEl.querySelector('#glyph-close');
      const countEl = glyphModalEl.querySelector('#glyph-count');

      closeEl?.addEventListener('click', () => closeGlyphPicker());

      const tabDefs = [
        { key: 'specialNorthAmerican', label: tr('subtitleEditor.glyph.tabs.specialNorthAmerican', 'Special NA') },
        { key: 'extendedWesternEuropean1', label: tr('subtitleEditor.glyph.tabs.extendedWesternEuropean1', 'Extended WE 1') },
        { key: 'extendedWesternEuropean2', label: tr('subtitleEditor.glyph.tabs.extendedWesternEuropean2', 'Extended WE 2') },
        { key: 'other', label: tr('subtitleEditor.glyph.tabs.other', 'Other') },
        { key: 'all', label: tr('subtitleEditor.glyph.tabs.all', 'All') }
      ];

      let activeTab = 'all';
      let query = '';

      const render = () => {
        const groups = data.groups || {};
        let list = [];
        if (activeTab === 'all') {
          list = []
            .concat(groups.specialNorthAmerican || [])
            .concat(groups.extendedWesternEuropean1 || [])
            .concat(groups.extendedWesternEuropean2 || [])
            .concat(groups.other || []);
        } else {
          list = (groups[activeTab] || []).slice();
        }

        if (query) {
          const q = query.toLowerCase();
          list = list.filter(g => String(g).toLowerCase().includes(q));
        }

        // Tabs
        tabsEl.innerHTML = '';
        tabDefs.forEach(t => {
          const b = document.createElement('div');
          b.className = 'tab' + (t.key === activeTab ? ' active' : '');
          b.textContent = t.label;
          b.addEventListener('click', () => {
            activeTab = t.key;
            render();
          });
          tabsEl.appendChild(b);
        });

        // Grid
        gridEl.innerHTML = '';
        list.forEach(g => {
          const btn = document.createElement('div');
          btn.className = 'glyph';
          btn.title = tr('subtitleEditor.glyph.insertTitle', 'Insert "{{glyph}}"', { glyph: g });
          btn.textContent = g;
          btn.addEventListener('click', () => {
            const ta = findActiveCueTextarea();
            if (!ta) {
              setStatus(tr('subtitleEditor.status.clickCaptionFieldInsertGlyph', 'Click into a caption text field, then insert a glyph.'), true);
              return;
            }
            insertAtCaret(ta, g);
            // Keep modal open for rapid insertion (pro workflow)
            try { ta.focus(); } catch {}
          });
          gridEl.appendChild(btn);
        });

        if (countEl) countEl.textContent = tr('subtitleEditor.glyph.count', '{{count}} glyph{{suffix}}', { count: list.length, suffix: list.length === 1 ? '' : 's' });
      };

      searchEl?.addEventListener('input', () => {
        query = String(searchEl.value || '').trim();
        render();
      });

      // initial paint
      render();
      try { searchEl?.focus(); } catch {}
    })();
  }


  // ------------------------------------------------------------
  // Start TC modal (SMPTE timecode offset for SCC preview/export)
  // ------------------------------------------------------------
  let startTcModalEl = null;
  function ensureStartTcModalCSS() {
    // Start TC modal CSS is shipped in style.css.
    // Inline <style> injection is blocked by the strict CSP (style-src-elem).
    return;
  }


  function refreshToolbarMetaForDoc(doc) {
    if (!toolbarMeta || !doc) return;
    const scc = isSccDoc(doc);
    const web = isWebCaptionDoc(doc);
    // SCC shows file + SMPTE metadata inside the centered preview header.
    // Avoid duplicating that info in the top-left toolbar area.
    // MCC now also shows file + SMPTE-ish metadata inside the centered preview header.
    overlay.classList.toggle('doc-scc', (scc || isMccDoc(doc)) && !web);
    const is708 = is708Doc(doc);
    const metaParts = [];
    // Web caption docs (SRT/VTT) are millisecond-based; FPS/DF is an editor timebase,
    // not meaningful file metadata. Hide it to avoid implying the file "is 30fps".
    if (!web) {
      if (doc.fps) metaParts.push(`${doc.fps} fps`);
      if (typeof doc.dropFrame === 'boolean') metaParts.push(doc.dropFrame ? 'DF' : 'NDF');
    }
    if (scc) metaParts.push('SCC');
    if (is708) {
      const svc = Number(doc?.mccOptions?.serviceNumber);
      if (Number.isFinite(svc)) metaParts.push(`708 SVC ${svc}`);
    }
    if (Array.isArray(doc.cues)) metaParts.push(`${doc.cues.length} ${scc ? 'blocks' : 'cues'}`);
    const startTcLabel = _getDocStartTimecodeLabel(doc);
    if (startTcLabel) metaParts.push(`Start TC ${startTcLabel}`);
    toolbarMeta.textContent = metaParts.join(' • ');
  }

  // Web caption docs (SRT/VTT): show file + cue-count metadata in the centered preview label.
  // Example: "TEST_02_5994.vtt 200 cues"
  function _formatWebPreviewHeaderLine(doc) {
    if (!doc) return 'Preview';

    const name =
      doc.displayName ||
      (doc.sourcePath
        ? window.electron?.basename?.(doc.sourcePath) || doc.sourcePath
        : '');

    const metaParts = [];
    // SRT/VTT timestamps are wall-clock milliseconds, not SMPTE timecode.
    // Do not surface FPS/DF here; it's an internal editor timebase.
    if (Array.isArray(doc.cues)) metaParts.push(`${doc.cues.length} cues`);

    const meta = metaParts.filter(Boolean).join(' • ');
    const line = `${name}${meta ? ` ${meta}` : ''}`.trim();
    return line || 'Preview';
  }

  // SCC docs: show file + SMPTE metadata in the centered preview label.
  // Example: "TEST_02_5994.scc 29.97 fps • DF • SCC • 200 blocks • Start TC 00:00:00;00"
  function _formatSccPreviewHeaderLine(doc) {
    if (!doc) return 'Preview';

    const name =
      doc.displayName ||
      (doc.sourcePath
        ? window.electron?.basename?.(doc.sourcePath) || doc.sourcePath
        : '');

    const metaParts = [];
    if (doc.fps) metaParts.push(`${doc.fps} fps`);
    if (typeof doc.dropFrame === 'boolean') metaParts.push(doc.dropFrame ? 'DF' : 'NDF');
    metaParts.push('SCC');
    if (Array.isArray(doc.cues)) metaParts.push(`${doc.cues.length} blocks`);
    const startTcLabel = _getDocStartTimecodeLabel(doc);
    if (startTcLabel) metaParts.push(`Start TC ${startTcLabel}`);

    const meta = metaParts.filter(Boolean).join(' • ');
    const line = `${name}${meta ? ` ${meta}` : ''}`.trim();
    return line || 'Preview';
  }

  // MCC docs: show file + SMPTE-ish metadata in a centered preview header line.
  // Example: "TEST_02_5994.mcc 59.94 fps • DF • 708 SVC 1 • 200 cues • Start TC 00:00:00;00"
  function _formatMccPreviewHeaderLine(doc) {
    if (!doc) return 'Preview';

    const name =
      doc.displayName ||
      (doc.sourcePath
        ? window.electron?.basename?.(doc.sourcePath) || doc.sourcePath
        : '');

    const metaParts = [];
    if (doc.fps) metaParts.push(`${doc.fps} fps`);
    if (typeof doc.dropFrame === 'boolean') metaParts.push(doc.dropFrame ? 'DF' : 'NDF');

    // MCC is 708-capable; prefer the active authoring service number.
    const svc = Number(doc?.mccOptions?.serviceNumber);
    if (Number.isFinite(svc)) metaParts.push(`708 SVC ${svc}`);

    if (Array.isArray(doc.cues)) metaParts.push(`${doc.cues.length} cues`);

    const startTcLabel = _getDocStartTimecodeLabel(doc);
    if (startTcLabel) metaParts.push(`Start TC ${startTcLabel}`);

    const meta = metaParts.filter(Boolean).join(' • ');
    const line = `${name}${meta ? ` ${meta}` : ''}`.trim();
    return line || 'Preview';
  }

  function refreshMccPreviewHeaderForDoc(doc) {
    const header = overlay?.querySelector('#subtitle-editor-preview-header');
    if (!header) return;


    // Web captions also use this same header element; don't fight them.
    if (doc && isWebCaptionDoc(doc)) return;

    // Header element is shared by MCC + SCC.
    // Only hide it when the active doc is neither format.
    if (!doc || (!isMccDoc(doc) && !isSccDoc(doc))) {
      if (header.style.display !== 'none') header.style.display = 'none';
      return;
    }

    // SCC owns the header text when active.
    if (doc && isSccDoc(doc) && !isMccDoc(doc)) return;

    const next = _formatMccPreviewHeaderLine(doc);
    if (header.textContent !== next) header.textContent = next;
    if (header.style.display !== 'block') header.style.display = 'block';
  }

  function refreshSccPreviewHeaderForDoc(doc) {
    const header = overlay?.querySelector('#subtitle-editor-preview-header');
    if (!header) return;


    // Web captions also use this same header element; don't fight them.
    if (doc && isWebCaptionDoc(doc)) return;

    // Always hide when not SCC (or when MCC is active) to avoid stale header text.
    if (!doc || !isSccDoc(doc) || isMccDoc(doc)) {
      // Only hide if MCC isn't going to show it.
      if (!doc || !isMccDoc(doc)) {
        if (header.style.display !== 'none') header.style.display = 'none';
      }
      return;
    }

    // SCC: mirror MCC ergonomics. Put the long file/meta line in the dedicated
    // centered preview header (row above panes) instead of the pane label.
    // This prevents the pane label height from feeding back into host-fitting.
    const next = _formatSccPreviewHeaderLine(doc);
    if (header.textContent !== next) header.textContent = next;
    if (header.style.display !== 'block') header.style.display = 'block';
  }

  function refreshWebPreviewHeaderForDoc(doc) {
    const header = overlay?.querySelector('#subtitle-editor-preview-header');
    if (!header) return;

    // Web caption docs (SRT/VTT): show file + cue-count metadata in the dedicated
    // centered preview header row (same approach as SCC/MCC) so the per-pane label
    // height stays stable and doesn't collapse the fitted video frame.
    if (!doc || !isWebCaptionDoc(doc)) {
      // When leaving web mode, hide the header unless SCC/MCC is about to own it.
      if (!doc || (!isSccDoc(doc) && !isMccDoc(doc))) {
        if (header.style.display !== 'none') header.style.display = 'none';
      }
      return;
    }

    const next = _formatWebPreviewHeaderLine(doc);
    if (header.textContent !== next) header.textContent = next;
    if (header.style.display !== 'block') header.style.display = 'block';
  }

  function _get708ServiceNumbers(doc) {
    const out = [];
    const pushSvc = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      const svc = Math.max(1, Math.min(63, Math.trunc(n)));
      if (!out.includes(svc)) out.push(svc);
    };

    try {
      const bySvc = doc?.cuesByService;
      if (bySvc && typeof bySvc === 'object') {
        for (const k of Object.keys(bySvc)) pushSvc(k);
      }
    } catch {}

    try {
      const avail = doc?.mccOptions?.availableServices;
      if (Array.isArray(avail)) {
        for (const s of avail) pushSvc(s);
      }
    } catch {}

    out.sort((a, b) => a - b);
    return out;
  }

  function refreshServiceSelectorForDoc(doc) {
    if (!serviceSelectWrap || !serviceSelectEl) return;

    // Hide by default.
    try { serviceSelectWrap.style.display = 'none'; } catch {}

    if (!doc || !is708Doc(doc)) return;
    const bySvc = doc.cuesByService;
    if (!bySvc || typeof bySvc !== 'object') return;

    const services = _get708ServiceNumbers(doc);
    if (services.length <= 1) return;

    // Ensure doc.cues and cuesByService share an array instance for the active service.
    const activeSvc = (() => {
      const n = Number(doc?.mccOptions?.serviceNumber);
      return Number.isFinite(n) ? Math.max(1, Math.min(63, Math.trunc(n))) : services[0];
    })();

    if (Array.isArray(doc.cues) && bySvc && bySvc[activeSvc] !== doc.cues) {
      bySvc[activeSvc] = doc.cues;
      try {
        if (doc.docsByService && doc.docsByService[activeSvc]) {
          doc.docsByService[activeSvc].cues = doc.cues;
        }

        // One-time migration v2: inverse of v1.
        // If Relative coordinates are ON but the anchors are still in absolute space
        // (most obvious when H>99), clamping pins the window to the far right.
        const didMigrate2 = localStorage.getItem('mcc-window-anchor-migrated-v2') === '1';
        const relRaw = String(
          localStorage.getItem('mcc-window-anchor-rel') ??
          localStorage.getItem('mcc-window-anchor-relative') ??
          'true'
        );
        const hRaw = String(localStorage.getItem('mcc-window-anchor-h') ?? '');
        const vRaw = String(localStorage.getItem('mcc-window-anchor-v') ?? '');

        if (!didMigrate2 && relRaw === 'true') {
          const hNum = parseInt(hRaw, 10);
          const vNum = parseInt(vRaw, 10);

          if (Number.isFinite(hNum) && hNum > 99) {
            const hAbs = Math.max(0, Math.min(209, hNum));
            const hRel = Math.round((hAbs / 209) * 99);

            // Convert V only if it also looks like absolute (<=74).
            let vRel = vNum;
            if (Number.isFinite(vNum) && vNum >= 0 && vNum <= 74) {
              const vAbs = Math.max(0, Math.min(74, vNum));
              vRel = Math.round((vAbs / 74) * 99);
            }

            localStorage.setItem('mcc-window-anchor-h', String(Math.max(0, Math.min(99, hRel))));
            if (Number.isFinite(vRel)) localStorage.setItem('mcc-window-anchor-v', String(Math.max(0, Math.min(99, Math.trunc(vRel)))));
            localStorage.setItem('mcc-window-anchor-migrated-v2', '1');
          }
        }
      } catch {}
    }

    // Build the dropdown (styled dropdown component; mirrors a hidden input).
    const opts = services.map((svc) => {
      const count = Array.isArray(bySvc?.[svc]) ? bySvc[svc].length : 0;
      return { value: String(svc), label: `S${svc} (${count})` };
    });

    const desired = String(services.includes(activeSvc) ? activeSvc : services[0]);

    try {
      _setupStyledDropdownSafe('subtitle-editor-service-select', opts, desired);
    } catch {}

    try { serviceSelectWrap.style.display = 'inline-flex'; } catch {}
  }

  function switchActive708Service(doc, serviceNumber) {
    if (!doc || !is708Doc(doc)) return;
    const bySvc = doc.cuesByService;
    if (!bySvc || typeof bySvc !== 'object') return;

    const svc = Math.max(1, Math.min(63, Math.trunc(Number(serviceNumber))));
    if (!Number.isFinite(svc)) return;

    const t = (typeof videoEl?.currentTime === 'number')
      ? (Number(videoEl.currentTime) || 0)
      : (Number(doc?.cues?.[state.activeCue]?.start) || 0);

    if (!Array.isArray(bySvc[svc])) bySvc[svc] = [];
    doc.cues = bySvc[svc];
    doc.mccOptions = { ...(doc.mccOptions && typeof doc.mccOptions === 'object' ? doc.mccOptions : {}), serviceNumber: svc };

    try {
      if (doc.docsByService && doc.docsByService[svc]) {
        doc.docsByService[svc].cues = doc.cues;
      }
    } catch {}

    // Update UI without marking the document dirty (this is a view switch).
    refreshServiceSelectorForDoc(doc);
    refreshToolbarMetaForDoc(doc);
    try { refreshMccPreviewHeaderForDoc(doc); } catch {}

    try { refreshDebuttUiForDoc(doc); } catch {}
    try { renderCues(doc.cues || []); } catch {}
    state.activeCue = -1;
    try { highlightCueForTime(t); } catch {}

    // Rebuild preview for the newly active track.
    try { scheduleMccPreviewRebuild(true); } catch {}
    try { renderActiveCue608(); } catch {}
    try { scheduleQcRecompute(true); } catch {}

    setStatus(tr('subtitleEditor.status.activeService', 'Active service: {{service}}', { service: svc }));
  }

  function closeStartTcModal() {
    if (!startTcModalEl) return;
    try { startTcModalEl.remove(); } catch {}
    startTcModalEl = null;
  }

  function openStartTcModal() {
    if (!state.doc) return;
    ensureStartTcModalCSS();
    if (startTcModalEl) return;

    const doc = state.doc;
    const fps = Number(doc?.fps) || 29.97;
    const drop = !!doc?.dropFrame;
    const sep = drop ? ';' : ':';
    const current = _getDocStartTimecodeLabel(doc) || (drop ? '01:00:00;00' : '01:00:00:00');
    const showSpeakers = isSccDoc(doc);
    const includeSpeakerNamesScc = showSpeakers && !!doc?.sccOptions?.includeSpeakerNames;

    const speakersRow = showSpeakers ? `
          <div class="row">
            <label for="tc-include-speakers">${tr('subtitleEditor.startTc.speakersLabel', 'Speakers')}</label>
            <div>
              <label class="checkbox-label tc-include-speakers-label">
                <input id="tc-include-speakers" type="checkbox" ${includeSpeakerNamesScc ? 'checked' : ''} />
                ${tr('subtitleEditor.startTc.includeSpeakers', 'Include speaker names in SCC export (e.g., “JOHN: …”)')}
              </label>
              <div class="tc-include-speakers-hint">
                ${tr('subtitleEditor.startTc.speakersHint', 'Off by default. Some QC specs reject speaker labels in 608 captions.')}
              </div>
            </div>
          </div>
    ` : '';

    startTcModalEl = document.createElement('div');
    startTcModalEl.className = 'tc-modal';
    startTcModalEl.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true" aria-label="${tr('subtitleEditor.startTc.dialogAriaLabel', 'Start Timecode')}">
        <div class="header">
          <strong>${tr('subtitleEditor.startTc.title', 'Start Timecode')}</strong>
          <div class="spacer"></div>
          <button type="button" class="close" id="tc-close">${tr('subtitleEditor.common.close', 'Close')}</button>
        </div>
        <div class="body">
          <p>
            ${tr('subtitleEditor.startTc.description', 'This maps <strong>media time 0</strong> to a SMPTE timecode label. It affects the timecode you see in the editor and the timecodes written when exporting SCC or MCC. It does <em>not</em> move cues.')}
          </p>
          <div class="row">
            <label for="tc-input">${tr('subtitleEditor.toolbar.startTc', 'Start TC')}</label>
            <input type="text" id="tc-input" placeholder="${drop ? '01:00:00;00' : '01:00:00:00'}" />
          </div>
          ${speakersRow}
          <div class="hint">${tr('subtitleEditor.startTc.expectedHint', 'Expected: HH:MM:SS{{sep}}FF • {{frameMode}} • {{fps}} fps', { sep, frameMode: drop ? tr('subtitleEditor.startTc.dropFrame', 'Drop-frame') : tr('subtitleEditor.startTc.nonDropFrame', 'Non-drop-frame'), fps })}</div>
          <div class="error hidden" id="tc-error"></div>
        </div>
        <div class="footer">
          <button type="button" class="btn" id="tc-cancel">${tr('subtitleEditor.common.cancel', 'Cancel')}</button>
          <button type="button" class="btn primary" id="tc-save">${tr('subtitleEditor.common.save', 'Save')}</button>
        </div>
      </div>
    `;

    // click outside closes
    startTcModalEl.addEventListener('mousedown', (e) => {
      if (e.target === startTcModalEl) closeStartTcModal();
    });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && startTcModalEl) {
        e.preventDefault();
        closeStartTcModal();
        document.removeEventListener('keydown', onEsc, true);
      }
    }, true);

    document.body.appendChild(startTcModalEl);

    const inputEl = startTcModalEl.querySelector('#tc-input');
    const closeEl = startTcModalEl.querySelector('#tc-close');
    const cancelEl = startTcModalEl.querySelector('#tc-cancel');
    const saveEl = startTcModalEl.querySelector('#tc-save');
    const errorEl = startTcModalEl.querySelector('#tc-error');

    if (inputEl) inputEl.value = current;

    const showError = (msg) => {
      if (!errorEl) return;
      errorEl.textContent = String(msg || tr('subtitleEditor.startTc.invalidTimecode', 'Invalid timecode.'));
      errorEl.style.display = '';
    };
    const clearError = () => {
      if (!errorEl) return;
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    };

    const onSave = () => {
      clearError();
      const raw = String(inputEl?.value || '').trim();
      const m = raw.match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
      if (!m) {
        showError(`Use HH:MM:SS${sep}FF (example: ${drop ? '01:00:00;00' : '01:00:00:00'}).`);
        return;
      }
      const normalized = `${m[1]}${sep}${m[2]}`;

      try {
        // Validate parseability with the engine parser (drop-frame legality included).
        const ms = window.transcribeEngine?.parseTime?.(normalized, fps, drop ? true : null);
        if (typeof ms !== 'number' || Number.isNaN(ms)) throw new Error('Invalid timecode');
      } catch (e) {
        showError(e?.message || tr('subtitleEditor.startTc.invalidTimecode', 'Invalid timecode.'));
        return;
      }

      doc.startTc = normalized;
      doc.startTC = normalized;
      doc.metadata = doc.metadata || {};
      doc.metadata.startTimecode = normalized;

      if (showSpeakers) {
        // Persist SCC speaker label preference per document.
        const includeSpk = !!startTcModalEl?.querySelector('#tc-include-speakers')?.checked;
        doc.sccOptions = {
          ...(doc.sccOptions || {}),
          includeSpeakerNames: includeSpk,
          startTc: normalized,
          startTC: normalized
        };
      }

      refreshToolbarMetaForDoc(doc);
      try { refreshMccPreviewHeaderForDoc(doc); } catch {}

    try { refreshDebuttUiForDoc(doc); } catch {}

      // Re-render times without reloading media.
      try { renderCues(doc.cues || []); } catch {}
      try { scheduleQcRecompute(true); } catch {}
      try {
        const tRaw = Number(videoEl?.currentTime) || 0;
        const isSmpte = usesSmpteTimecode(doc);
        const t = isSmpte ? _quantizeSecondsToSmpteFrame(tRaw, doc, 'nearest') : tRaw;
        if (currentTimeEl) currentTimeEl.textContent = formatSeconds(t);
        if (scrubEl) scrubEl.value = isSmpte ? _toStepString(t) : t.toFixed(2);
        try { refreshScrubberStepForDoc(doc); } catch {}
        const dur = Number(videoEl?.duration);
        if (durationEl && Number.isFinite(dur) && !Number.isNaN(dur)) {
          durationEl.textContent = formatSeconds(dur);
        }
      } catch {}

      closeStartTcModal();
      setStatus(tr('subtitleEditor.status.startTcUpdated', 'Start TC updated.'));
    };

    closeEl?.addEventListener('click', () => closeStartTcModal());
    cancelEl?.addEventListener('click', () => closeStartTcModal());
    saveEl?.addEventListener('click', () => onSave());
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onSave(); }
    });

    try { inputEl?.focus(); inputEl?.select?.(); } catch {}
  }

  function buildUI() {
    if (uiBuilt) return;
    overlay.innerHTML = `
      <div class="editor-start" id="subtitle-editor-start" aria-hidden="true">
        <div class="editor-start-grid">
          <div class="editor-dropzone" id="subtitle-editor-drop-sub" role="button" tabindex="0" aria-label="${tr('subtitleEditor.startScreen.dropzoneSubtitleAriaLabel', 'Choose subtitle file')}">
            <div class="editor-dropzone-title">${tr('subtitleEditor.startScreen.subtitleTitle', 'Subtitle file')}</div>
            <div class="editor-dropzone-hint">${tr('subtitleEditor.startScreen.subtitleHint', 'Drop a .json/.srt/.vtt/.scc/.mcc here, or click to browse')}</div>
            <div class="editor-dropzone-file" id="subtitle-editor-drop-sub-file"></div>
          </div>
          <div class="editor-dropzone" id="subtitle-editor-drop-media" role="button" tabindex="0" aria-label="${tr('subtitleEditor.startScreen.dropzoneMediaAriaLabel', 'Choose media file')}">
            <div class="editor-dropzone-title">${tr('subtitleEditor.startScreen.mediaTitle', 'Video file (optional)')}</div>
            <div class="editor-dropzone-hint">${tr('subtitleEditor.startScreen.mediaHint', 'Drop a video here (optional), or click to browse (.mp4/.mov/.m4v/.mkv/.webm)')}</div>
            <div class="editor-dropzone-file" id="subtitle-editor-drop-media-file"></div>
          </div>
        </div>
        <div class="editor-start-status" id="subtitle-editor-start-status"></div>
        <div class="editor-start-actions">
          <button type="button" class="btn primary" id="subtitle-editor-launch" disabled>${tr('subtitleEditor.startScreen.launch', 'Launch Editor')}</button>
        </div>
      </div>
      <div class="toolbar">
        <div class="toolbar-info">
          <strong id="subtitle-editor-title"></strong>
          <span id="subtitle-editor-meta"></span>
        </div>
        <div class="toolbar-actions">
          <div class="toolbar-actions-left">
            <button type="button" id="subtitle-editor-open-sub">${tr('subtitleEditor.toolbar.openSubtitle', 'Open Subtitle…')}</button>
            <button type="button" id="subtitle-editor-open-media">${tr('subtitleEditor.toolbar.openMedia', 'Open Media…')}</button>
            <span id="subtitle-editor-service-wrap" class="subtitle-editor-service-wrap" style="display:none">
              <label for="subtitle-editor-service-select-input" class="subtitle-editor-service-label">${tr('subtitleEditor.toolbar.serviceLabel', 'Service')}</label>
              <div class="dropdown-wrapper dropdown-display subtitle-editor-dropdown subtitle-editor-dropdown-zero-margin">
                <input id="subtitle-editor-service-select-input" class="chosen-value" type="text" placeholder="" aria-label="${tr('subtitleEditor.toolbar.serviceAriaLabel', 'Service')}" autocomplete="off" />
                <ul class="value-list"></ul>
                <span class="dropdown-arrow"></span>
                <input type="hidden" id="subtitle-editor-service-select" name="subtitle-editor-service-select" />
              </div>
            </span>
          </div>
          <div class="toolbar-actions-right">
            <button type="button" id="subtitle-editor-close">${tr('subtitleEditor.toolbar.close', 'Close')}</button>
          </div>
        </div>
        <div class="toolbar-toggles">
          <div class="toolbar-toggles-group broadcast-only">
            <label class="checkbox-label" id="toggle-inspector-wrap">
              <input type="checkbox" id="toggle-inspector" checked />
              ${tr('subtitleEditor.toolbar.toggleInspector', 'Row/indent inspector')}
            </label>
            <label class="checkbox-label" id="toggle-click-place-wrap">
              <input type="checkbox" id="toggle-click-place" />
              ${tr('subtitleEditor.toolbar.toggleClickToPlace', 'Click-to-place')}
            </label>
            <label class="checkbox-label toolbar-dropdown-label" style="display:none;" id="toggle-608-place-target-wrap">
              <span>${tr('subtitleEditor.toolbar.move608Label', '608 move:')}</span>
              <div class="dropdown-wrapper dropdown-display subtitle-editor-dropdown">
                <input id="toggle-608-place-target-input" class="chosen-value" type="text" placeholder="" aria-label="${tr('subtitleEditor.toolbar.move608AriaLabel', '608 move target')}" autocomplete="off" />
                <ul class="value-list"></ul>
                <span class="dropdown-arrow"></span>
                <input type="hidden" id="toggle-608-place-target" name="toggle-608-place-target" />
              </div>
            </label>
            <label class="checkbox-label toolbar-dropdown-label" style="display:none;" id="toggle-708-place-mode-wrap">
              <span>${tr('subtitleEditor.toolbar.placement708Label', '708 placement:')}</span>
              <div class="dropdown-wrapper dropdown-display subtitle-editor-dropdown">
                <input id="toggle-708-place-mode-input" class="chosen-value" type="text" placeholder="" aria-label="${tr('subtitleEditor.toolbar.placement708AriaLabel', '708 placement mode')}" autocomplete="off" />
                <ul class="value-list"></ul>
                <span class="dropdown-arrow"></span>
                <input type="hidden" id="toggle-708-place-mode" name="toggle-708-place-mode" />
              </div>
            </label>
          </div>
          <div class="toolbar-toggles-group web-only">
            <span class="toolbar-web-limits" id="subtitle-editor-web-limits"></span>
          </div>
        </div>
      </div>
      <div class="main">
        <div class="preview preview-dual" id="subtitle-editor-preview">
          <div class="preview-label preview-label-header" id="subtitle-editor-preview-header" style="display:none"></div>
          <div class="preview-panes" id="subtitle-editor-preview-panes">
            <div class="preview-pane" data-preview-track="708">
              <div class="preview-label">${tr('subtitleEditor.toolbar.preview708Label', '708 (authoring source)')}</div>
              <div class="preview-video-host">
                <video id="subtitle-editor-video-708" playsinline></video>
              </div>
            </div>
            <div class="preview-pane" data-preview-track="608">
              <div class="preview-label">
                <span class="preview-label-text">${tr('subtitleEditor.toolbar.preview608Label', '608 (derived, with overrides)')}</span>
                <span class="preview-pill preview-pill-override" id="subtitle-editor-608-override-pill" style="display:none">${tr('subtitleEditor.toolbar.previewOverridePill', 'Override')}</span>
              </div>
              <div class="preview-video-host">
                <video id="subtitle-editor-video-608" muted playsinline></video>
              </div>
            </div>
          </div>
          <div class="preview-scrub-row">
            <label class="checkbox-label preview-guides-toggle broadcast-only" title="${tr('subtitleEditor.toolbar.showSafeAreaBroadcastTitle', 'Show safe-area guides for SCC/MCC preview')}">
              <input type="checkbox" id="toggle-guides" checked />
              ${tr('subtitleEditor.toolbar.showSafeArea', 'Show safe-area')}
            </label>
            <label class="checkbox-label preview-guides-toggle web-only" title="${tr('subtitleEditor.toolbar.showSafeAreaWebTitle', 'Show action/title safe guides for SRT/VTT preview')}">
              <input type="checkbox" id="toggle-web-guides" checked />
              ${tr('subtitleEditor.toolbar.showSafeAreaGuides', 'Show safe-area guides')}
            </label>
            <div class="preview-transport">
              <button type="button" id="subtitle-editor-playpause" title="${tr('subtitleEditor.toolbar.playPauseTitle', 'Play/Pause (Space)')}">${tr('subtitleEditor.toolbar.play', 'Play')}</button>
              <input id="subtitle-editor-scrub" type="range" min="0" max="0" step="0.01" value="0" />
            </div>
            <label class="checkbox-label preview-hide-qc-toggle" title="${tr('subtitleEditor.toolbar.hideQcTitle', 'Hide the QC panel to widen the cue list')}">
              <input type="checkbox" id="toggle-hide-qc" />
              ${tr('subtitleEditor.toolbar.hideQc', 'Hide QC')}
            </label>
          </div>
          <div class="time-display">
            <span id="subtitle-editor-current">00:00:00.000</span>
            <span> / </span>
            <span id="subtitle-editor-duration">00:00:00.000</span>
          </div>
        </div>
        <div class="splitter preview-splitter" id="subtitle-editor-preview-splitter" role="separator" aria-orientation="horizontal" tabindex="0" title="${tr('subtitleEditor.splitter.previewResizeTitle', 'Drag to resize the preview')}"></div>
        <div class="editor-lower" id="subtitle-editor-lower">
          <div class="cue-pane">
            <div class="cue-pane-head">
              <button type="button" id="subtitle-editor-insert-cue">${tr('subtitleEditor.cue.insertCaption', 'Insert Caption')}</button>
              <button type="button" id="subtitle-editor-delete-cue">${tr('subtitleEditor.cue.deleteCaption', 'Delete Caption')}</button>
              <button type="button" id="subtitle-editor-debutt-all" title="${tr('subtitleEditor.cue.debuttAllTitle', 'Fix same-frame boundaries across all cues')}">${tr('subtitleEditor.cue.debuttAll', 'Debutt All')}</button>
              <div class="dropdown-wrapper dropdown-display subtitle-editor-dropdown subtitle-editor-dropdown-zero-margin" id="subtitle-editor-debutt-mode-wrap" title="${tr('subtitleEditor.cue.debuttPolicyTitle', 'Debutt policy')}">
                <input id="subtitle-editor-debutt-mode-input" class="chosen-value" type="text" placeholder="" aria-label="${tr('subtitleEditor.cue.debuttPolicyAriaLabel', 'Debutt policy')}" autocomplete="off" />
                <ul class="value-list"></ul>
                <span class="dropdown-arrow"></span>
                <input type="hidden" id="subtitle-editor-debutt-mode" name="subtitle-editor-debutt-mode" />
              </div>
            </div>
            <div class="cue-list" id="subtitle-editor-cue-list" tabindex="0"></div>
          </div>
          <div class="splitter qc-splitter" id="subtitle-editor-qc-splitter" role="separator" aria-orientation="vertical" tabindex="0" title="${tr('subtitleEditor.splitter.qcResizeTitle', 'Drag to resize the QC panel')}"></div>
          <div class="qc-panel" id="subtitle-editor-qc-panel" aria-label="${tr('subtitleEditor.qc.panelAriaLabel', 'QC')}">
            <div class="qc-header">
              <strong>${tr('subtitleEditor.qc.panelTitle', 'QC')}</strong>
              <span class="qc-counts" id="subtitle-editor-qc-counts"></span>
              <div class="qc-filters">
                <label class="checkbox-label" title="${tr('subtitleEditor.qc.filterFailTitle', 'Show failures')}">
                  <input type="checkbox" id="subtitle-editor-qc-filter-fail" checked />
                  ${tr('subtitleEditor.qc.filterFailLabel', 'Fail')}
                </label>
                <label class="checkbox-label" title="${tr('subtitleEditor.qc.filterWarnTitle', 'Show warnings')}">
                  <input type="checkbox" id="subtitle-editor-qc-filter-warn" checked />
                  ${tr('subtitleEditor.qc.filterWarnLabel', 'Warn')}
                </label>
              </div>
              <div class="qc-nav">
                <button type="button" id="subtitle-editor-first-fail" title="${tr('subtitleEditor.qc.navFirstFailTitle', 'Jump to first QC failure')}" disabled>${tr('subtitleEditor.qc.navFirstFailLabel', 'First fail')}</button>
                <button type="button" id="subtitle-editor-prev-issue" title="${tr('subtitleEditor.qc.navPrevIssueTitle', 'Jump to previous QC issue')}" disabled>${tr('subtitleEditor.qc.navPrevIssueLabel', 'Prev issue')}</button>
                <button type="button" id="subtitle-editor-next-issue" title="${tr('subtitleEditor.qc.navNextIssueTitle', 'Jump to next QC issue')}" disabled>${tr('subtitleEditor.qc.navNextIssueLabel', 'Next issue')}</button>
              </div>
              </div>
            <div class="qc-inspector" id="subtitle-editor-qc-inspector">
              <div class="qc-inspector-title">${tr('subtitleEditor.qc.inspectorTitle', 'Cue data')}</div>
              <pre class="qc-inspector-pre" id="subtitle-editor-qc-inspector-pre"></pre>
            </div>
            <div class="qc-list" id="subtitle-editor-qc-list"></div>
          </div>
        </div>
      </div>
      <div class="status-row">
        <span id="subtitle-editor-status"></span>
        <span id="row-indent-inspector" aria-hidden="true" style="display:none;"></span>
      </div>

      <details id="subtitle-editor-import-issues" class="import-issues hidden">
        <summary id="subtitle-editor-import-issues-summary"></summary>
        <div id="subtitle-editor-import-issues-body" class="import-issues-body"></div>
      </details>
    `;

    toolbarTitle = overlay.querySelector('#subtitle-editor-title');
    toolbarMeta = overlay.querySelector('#subtitle-editor-meta');
    statusEl = overlay.querySelector('#subtitle-editor-status');

    // Start screen (two-box chooser)
    startScreenEl = overlay.querySelector('#subtitle-editor-start');
    startStatusEl = overlay.querySelector('#subtitle-editor-start-status');
    startDropSubEl = overlay.querySelector('#subtitle-editor-drop-sub');
    startDropMediaEl = overlay.querySelector('#subtitle-editor-drop-media');
    startSubFileEl = overlay.querySelector('#subtitle-editor-drop-sub-file');
    startMediaFileEl = overlay.querySelector('#subtitle-editor-drop-media-file');
    startLaunchBtn = overlay.querySelector('#subtitle-editor-launch');

    importIssuesEl = overlay.querySelector('#subtitle-editor-import-issues');
    importIssuesSummaryEl = overlay.querySelector('#subtitle-editor-import-issues-summary');
    importIssuesBodyEl = overlay.querySelector('#subtitle-editor-import-issues-body');
    mainEl = overlay.querySelector('.main');
    previewRootEl = overlay.querySelector('#subtitle-editor-preview');
    previewSplitterEl = overlay.querySelector('#subtitle-editor-preview-splitter');
    editorLowerEl = overlay.querySelector('#subtitle-editor-lower');
    qcSplitterEl = overlay.querySelector('#subtitle-editor-qc-splitter');
    cuesContainer = overlay.querySelector('.cue-pane #subtitle-editor-cue-list');
    // Dual-preview: primary 708 video (interactive), secondary 608 video (synced)
    videoEl = overlay.querySelector('#subtitle-editor-video-708');
    videoEl608 = overlay.querySelector('#subtitle-editor-video-608');
    preview608OverridePillEl = overlay.querySelector('#subtitle-editor-608-override-pill');
    scrubEl = overlay.querySelector('#subtitle-editor-scrub');
    playPauseBtnEl = overlay.querySelector('#subtitle-editor-playpause');
    durationEl = overlay.querySelector('#subtitle-editor-duration');
    currentTimeEl = overlay.querySelector('#subtitle-editor-current');
    closeBtn = overlay.querySelector('#subtitle-editor-close');
    insertCueBtn = overlay.querySelector('#subtitle-editor-insert-cue');
    deleteCueBtn = overlay.querySelector('#subtitle-editor-delete-cue');
    debuttModeWrap = overlay.querySelector('#subtitle-editor-debutt-mode-wrap');
    debuttModeSel = overlay.querySelector('#subtitle-editor-debutt-mode');
    debuttAllBtn = overlay.querySelector('#subtitle-editor-debutt-all');

    // Styled dropdown: Debutt policy (shared dropdown component from main panels).
    try {
      const current = String(debuttModeSel?.value || '').trim().toLowerCase();
      const initial = SUBTITLE_EDITOR_DEBUTT_DROPDOWN_OPTS.some((o) => o.value === current) ? current : 'end';
      _setupStyledDropdownSafe('subtitle-editor-debutt-mode', SUBTITLE_EDITOR_DEBUTT_DROPDOWN_OPTS, initial);
    } catch {}

    // Keep the Debutt dropdown compact (fit longest option), and avoid layout jumps.
    // Two rAFs: let styles apply before measuring.
    try {
      requestAnimationFrame(() => requestAnimationFrame(() => sizeDebuttModeSelectToLongestOption()));
    } catch {}
    qcFirstFailBtn = overlay.querySelector('#subtitle-editor-first-fail');
    qcPrevBtn = overlay.querySelector('#subtitle-editor-prev-issue');
    qcNextBtn = overlay.querySelector('#subtitle-editor-next-issue');
    serviceSelectWrap = overlay.querySelector('#subtitle-editor-service-wrap');
    serviceSelectEl = overlay.querySelector('#subtitle-editor-service-select');
    qcPanelEl = overlay.querySelector('#subtitle-editor-qc-panel');
    qcCountsEl = overlay.querySelector('#subtitle-editor-qc-counts');
    qcInspectorPreEl = overlay.querySelector('#subtitle-editor-qc-inspector-pre');
    qcListEl = overlay.querySelector('#subtitle-editor-qc-list');
    qcFilterFailEl = overlay.querySelector('#subtitle-editor-qc-filter-fail');
    qcFilterWarnEl = overlay.querySelector('#subtitle-editor-qc-filter-warn');
    const openSubBtn = overlay.querySelector('#subtitle-editor-open-sub');
    const openMediaBtn = overlay.querySelector('#subtitle-editor-open-media');
    const guidesToggle = overlay.querySelector('#toggle-guides');
    const inspToggle = overlay.querySelector('#toggle-inspector');
    const clickPlaceToggle = overlay.querySelector('#toggle-click-place');
    webGuidesToggleEl = overlay.querySelector('#toggle-web-guides');
    hideQcToggleEl = overlay.querySelector('#toggle-hide-qc');
    webLimitsEl = overlay.querySelector('#subtitle-editor-web-limits');
    placement708ModeWrap = overlay.querySelector('#toggle-708-place-mode-wrap');
    placement708ModeSelect = overlay.querySelector('#toggle-708-place-mode');
    placement608TargetWrap = overlay.querySelector('#toggle-608-place-target-wrap');
    placement608TargetSelect = overlay.querySelector('#toggle-608-place-target');

    // Styled dropdowns: placement controls (shared dropdown component from main panels).

    // 708 placement mode (zones vs exact). Stored locally for convenience.
    try {
      const raw = String(localStorage.getItem('subtitle-editor-708-placement-mode') || 'zones').trim().toLowerCase();
      const mode = (raw === 'exact') ? 'exact' : 'zones';
      _setupStyledDropdownSafe('toggle-708-place-mode', SUBTITLE_EDITOR_708_PLACEMENT_DROPDOWN_OPTS, mode);
    } catch {}

    // 608 click-to-place target (block vs specific line). Stored locally for convenience.
    try {
      const raw = String(localStorage.getItem('subtitle-editor-608-placement-target') || 'block').trim().toLowerCase();
      const mode = (raw === 'line2' || raw === 'l2' || raw === '2')
        ? 'line2'
        : (raw === 'line1' || raw === 'l1' || raw === '1')
          ? 'line1'
          : 'block';
      _setupStyledDropdownSafe('toggle-608-place-target', SUBTITLE_EDITOR_608_TARGET_DROPDOWN_OPTS, mode);
    } catch {}

    try {
      const raw = String(localStorage.getItem('subtitle-editor-web-guides') || '1').trim();
      if (webGuidesToggleEl) webGuidesToggleEl.checked = raw !== '0';
    } catch {}
    try {
      const raw = String(localStorage.getItem('subtitle-editor-hide-qc') || '0').trim();
      if (hideQcToggleEl) hideQcToggleEl.checked = raw === '1';
      overlay.classList.toggle('qc-hidden', !!hideQcToggleEl?.checked);
    } catch {}

    // Resizable split panels (preview vs cues; cue list vs QC)
    try { initResizablePanels(); } catch {}

    closeBtn?.addEventListener('click', () => hideEditor());
    openSubBtn?.addEventListener('click', () => pickSubtitleAndLoad());
    openMediaBtn?.addEventListener('click', () => pickMediaAndLoad());

    // Prevent default browser navigation behavior when files are dragged/dropped.
    // (Without this, a stray drop can navigate the window away from the app.)
    document.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types?.includes?.('Files')) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
      if (event.dataTransfer?.types?.includes?.('Files')) event.preventDefault();
    });

    // Start screen: click or drop files into the dedicated zones.
    const bindStartDropzone = (zoneEl, kind) => {
      if (!zoneEl) return;

      const onPick = async () => {
        if (kind === 'subtitle') {
          await pickSubtitleForStart();
        } else {
          await pickMediaForStart();
        }
      };

      zoneEl.addEventListener('click', onPick);
      zoneEl.addEventListener('keydown', (e) => {
        const key = e.key || '';
        if (key === 'Enter' || key === ' ') {
          e.preventDefault();
          onPick();
        }
      });

      zoneEl.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types?.includes?.('Files')) return;
        e.preventDefault();
        zoneEl.classList.add('dragover');
      });
      zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('dragover'));
      zoneEl.addEventListener('drop', async (e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        zoneEl.classList.remove('dragover');

        const f = e.dataTransfer.files[0];
        let p = '';
        try {
          p = await window.electron?.getRealPath?.(f, e.dataTransfer, 0);
        } catch {
          p = '';
        }
        if (!p && f && typeof f.path === 'string') p = f.path;
        if (!p) {
          setStatus(tr('subtitleEditor.status.dropPathUnavailable', 'Drop failed: file path unavailable in this build.'), true);
          return;
        }

        if (kind === 'subtitle') {
          await setSubtitlePathForStart(p, { fromDrop: true });
        } else {
          if (!_isVideoPath(p)) {
            setStatus(tr('subtitleEditor.status.unsupportedVideoFile', 'Not a supported video file: {{file}}', { file: _safeBasename(p) }), true);
            return;
          }
          await setMediaPath(p, { fromDrop: true });
        }
      });
    };

    bindStartDropzone(startDropSubEl, 'subtitle');
    bindStartDropzone(startDropMediaEl, 'media');

    startLaunchBtn?.addEventListener('click', () => {
      try { launchStartSelection(); } catch {}
    });

    // Multi-service (CEA-708) track selector.
    serviceSelectEl?.addEventListener('change', () => {
      try {
        const doc = state.doc;
        if (!doc || !is708Doc(doc)) return;
        const bySvc = doc.cuesByService;
        if (!bySvc || typeof bySvc !== 'object') return;

        const svc = parseInt(String(serviceSelectEl.value || ''), 10);
        if (!Number.isFinite(svc)) return;

        const currentSvc = Number(doc?.mccOptions?.serviceNumber);
        if (Number.isFinite(currentSvc) && svc === currentSvc) return;

        switchActive708Service(doc, svc);
      } catch {}
    });
    insertCueBtn?.addEventListener('click', () => {
      if (!state.doc?.cues?.length) return;

      const activeIndex = state.activeCue >= 0 ? state.activeCue : 0;
      const cues = state.doc.cues;
      if (!cues[activeIndex]) return;

      const time =
        (typeof videoEl?.currentTime === 'number')
          ? videoEl.currentTime
          : (Number(cues[activeIndex].start) || 0);

      splitCue(activeIndex, time);
    });

    deleteCueBtn?.addEventListener('click', () => {
      if (!state.doc?.cues?.length) return;
      const activeIndex = state.activeCue >= 0 ? state.activeCue : 0;
      deleteCue(activeIndex);
    });

    debuttAllBtn?.addEventListener('click', () => {
      if (!state.doc?.cues?.length) return;
      const policy = String(debuttModeSel?.value || 'end');
      debuttAllCues({ policy });
    });

    // Priority 1: QC navigation + panel wiring
    qcFirstFailBtn?.addEventListener('click', () => {
      jumpToFirstQcFail();
    });
    qcPrevBtn?.addEventListener('click', () => {
      jumpToAdjacentQcIssue(-1);
    });
    qcNextBtn?.addEventListener('click', () => {
      jumpToAdjacentQcIssue(1);
    });

    const onQcFilterChange = () => {
      state.qc.filters.fail = !!qcFilterFailEl?.checked;
      state.qc.filters.warn = !!qcFilterWarnEl?.checked;
      // Rebuild filtered list + row decorations.
      try { scheduleQcRecompute(true); } catch {}
    };

    qcFilterFailEl?.addEventListener('change', onQcFilterChange);
    qcFilterWarnEl?.addEventListener('change', onQcFilterChange);

    qcListEl?.addEventListener('click', (e) => {
      const item = e.target?.closest?.('.qc-item');
      if (!item) return;
      const cueIndex = parseInt(String(item.dataset.cueIndex || '-1'), 10);
      const issueId = String(item.dataset.issueId || '');
      if (!Number.isFinite(cueIndex) || cueIndex < 0) return;
      setActiveQcIssue(issueId);
      jumpToCueIndex(cueIndex, { seek: true, focus: true });
    });

    const updateTransportPlayState = () => {
      if (!playPauseBtnEl || !videoEl) return;
      const paused = !!videoEl.paused;
      playPauseBtnEl.textContent = paused ? 'Play' : 'Pause';
      try {
        playPauseBtnEl.setAttribute('aria-label', paused ? 'Play' : 'Pause');
        playPauseBtnEl.setAttribute('aria-pressed', paused ? 'false' : 'true');
      } catch {}
    };

    playPauseBtnEl?.addEventListener('click', () => {
      toggleEditorPlayback();
      // Video events should update the label, but this makes it feel snappy.
      try { setTimeout(updateTransportPlayState, 0); } catch {}
    });
    try { updateTransportPlayState(); } catch {}

    videoEl?.addEventListener('timeupdate', () => {
      if (!videoEl?.duration || Number.isNaN(videoEl.duration)) return;
      const tRaw = videoEl.currentTime || 0;
      const doc = state.doc;
      const isSmpte = usesSmpteTimecode(doc);
      const t = isSmpte ? _quantizeSecondsToSmpteFrame(tRaw, doc, 'nearest') : tRaw;
      currentTimeEl.textContent = formatSeconds(t);
      scrubEl.value = isSmpte ? _toStepString(t) : t.toFixed(2);
      highlightCueForTime(t);
      // Keep the derived-608 preview video aligned to the primary.
      syncSecondaryTime(false);
      // Keep the custom 608 overlay in sync with playback
      renderActiveCue608();
    });

    // When the user plays/pauses/seeks the primary video, mirror it.
    videoEl?.addEventListener('play', () => {
      syncSecondaryPlaybackState();
      updateTransportPlayState();
    });
    videoEl?.addEventListener('pause', () => {
      syncSecondaryPlaybackState();
      updateTransportPlayState();
    });
    videoEl?.addEventListener('ratechange', () => {
      syncSecondaryPlaybackState();
      updateTransportPlayState();
    });
    videoEl?.addEventListener('seeking', () => {
      syncSecondaryTime(true);
    });
    videoEl?.addEventListener('seeked', () => {
      const doc = state.doc;
      const isSmpte = usesSmpteTimecode(doc);
      const tRaw = Number(videoEl?.currentTime) || 0;
      const t = isSmpte ? _quantizeSecondsToSmpteFrame(tRaw, doc, 'nearest') : tRaw;

      // Snap the actual playhead to the nearest frame boundary in SMPTE mode.
      // This covers native video controls (click-to-seek, trackpad scrubbing, etc.).
      if (isSmpte) {
        const delta = Math.abs(t - tRaw);
        if (!smpteSeekSnapInProgress && delta > 0.000001) {
          smpteSeekSnapInProgress = true;
          try { videoEl.currentTime = t; } catch {}
          return;
        }
      }
      smpteSeekSnapInProgress = false;

      // P0-1: clear pending seek once we land (or decide we've taken too long).
      try { _maybeClearPendingSeek(t); } catch {}
      try {
        if (currentTimeEl) currentTimeEl.textContent = formatSeconds(t);
        if (scrubEl) scrubEl.value = isSmpte ? _toStepString(t) : t.toFixed(2);
        highlightCueForTime(t);
      } catch {}
      syncSecondaryTime(true);
      try { renderActiveCue608(); } catch {}
    });

    videoEl?.addEventListener('loadedmetadata', () => {
      const duration = videoEl?.duration;
      if (typeof duration === 'number' && !Number.isNaN(duration)) {
        const isSmpte = usesSmpteTimecode(state.doc);
        scrubEl.max = isSmpte ? _toStepString(duration) : duration.toFixed(2);
        durationEl.textContent = formatSeconds(duration);
        try { refreshScrubberStepForDoc(state.doc); } catch {}
      }
      // Keep the safe-title grid in the right place after the video’s size is known.
      try {
        window.__editorSafe?.rebuild?.();
        window.__editorSafe708?.rebuild?.();
        window.__editorSafe608?.rebuild?.();
      } catch {}
      try { updateTransportPlayState(); } catch {}
    });
    videoEl?.addEventListener('error', () => {
      setStatus(tr('subtitleEditor.status.mediaDecodeUnavailable', 'This media cannot be decoded by the browser. Use “Open Media…” or let the editor create a preview.'));
    });

    scrubEl?.addEventListener('input', () => {
      if (!videoEl) return;
      const raw = parseFloat(scrubEl.value || '0');
      if (Number.isNaN(raw)) return;

      const doc = state.doc;
      const isSmpte = usesSmpteTimecode(doc);
      const t = isSmpte ? _quantizeSecondsToSmpteFrame(raw, doc, 'nearest') : raw;

      // Keep the slider itself snapped to frames for MCC/SCC.
      if (isSmpte) {
        try { scrubEl.value = _toStepString(t); } catch {}
      }

      try { videoEl.currentTime = t; } catch {}
      try { syncSecondaryTime(true); } catch {}
      try { if (currentTimeEl) currentTimeEl.textContent = formatSeconds(t); } catch {}
      try { highlightCueForTime(t); } catch {}
      try { if (videoEl.paused) renderActiveCue608(); } catch {}
    });

    // Wire up toolbar toggles
    guidesToggle?.addEventListener('change', (e) => {
      const on = !!e.target.checked;
      window.__editorSafe708?.setGuidesVisible?.(on);
      window.__editorSafe608?.setGuidesVisible?.(on);
      window.__editorSafe?.setGuidesVisible?.(on);
    });
    webGuidesToggleEl?.addEventListener('change', (e) => {
      const on = !!e.target.checked;
      window.__editorWeb?.setGuidesVisible?.(on);
      try { localStorage.setItem('subtitle-editor-web-guides', on ? '1' : '0'); } catch {}
    });
    hideQcToggleEl?.addEventListener('change', (e) => {
      const on = !!e.target.checked;
      overlay.classList.toggle('qc-hidden', on);
      try { localStorage.setItem('subtitle-editor-hide-qc', on ? '1' : '0'); } catch {}
    });
    inspToggle?.addEventListener('change', (e) => {
      const on = !!e.target.checked;
      window.__editorSafe708?.toggleInspector?.(on);
      window.__editorSafe608?.toggleInspector?.(on);
      window.__editorSafe?.toggleInspector?.(on);
    });
    clickPlaceToggle?.addEventListener('change', () => {
      const on = !!clickPlaceToggle.checked;
      // 608: row/col placement. 708: zone placement.
      window.__editorSafe708?.setPlacementEnabled?.(on);
      window.__editorSafe608?.setPlacementEnabled?.(on);
      // If legacy path uses __editorSafe, still set it.
      if (window.__editorSafe && window.__editorSafe !== window.__editorSafe608) {
        window.__editorSafe?.setPlacementEnabled?.(on);
      }

      // 608 placement targeting is only meaningful in primary-608 preview mode.
      try { update608PlacementTargetUiForDoc(state.doc); } catch {}
    });

    placement608TargetSelect?.addEventListener('change', () => {
      const raw = String(placement608TargetSelect.value || 'block').trim().toLowerCase();
      const mode = (raw === 'line2' || raw === 'l2' || raw === '2')
        ? 'line2'
        : (raw === 'line1' || raw === 'l1' || raw === '1')
          ? 'line1'
          : 'block';
      try { localStorage.setItem('subtitle-editor-608-placement-target', mode); } catch {}
      try {
        window.__editorSafe708?.set608PlacementTarget?.(mode);
        window.__editorSafe608?.set608PlacementTarget?.(mode);
        if (window.__editorSafe && window.__editorSafe !== window.__editorSafe608) {
          window.__editorSafe?.set608PlacementTarget?.(mode);
        }
      } catch {}
      try { renderActiveCue608(); } catch {}
    });

    placement708ModeSelect?.addEventListener('change', () => {
      const mode = String(placement708ModeSelect.value || 'zones').trim().toLowerCase();
      const normalized = (mode === 'exact') ? 'exact' : 'zones';
      try { localStorage.setItem('subtitle-editor-708-placement-mode', normalized); } catch {}
      try { window.__editorSafe708?.set708PlacementMode?.(normalized); } catch {}
      // Keep the preview responsive even if the decoded MCC is momentarily stale.
      try { renderActiveCue608(); } catch {}
    });

    overlay.addEventListener('keydown', handleHotkeys, true);
    cuesContainer?.addEventListener('click', onCueClick);

    uiBuilt = true;
    try { injectEditorToolbarButtons(); } catch {}
    try { installEditorSafeOverlay(); } catch {}

    // Apply initial toggle states to the controller
    try {
      const guidesOn = !!guidesToggle?.checked;
      const inspOn = !!inspToggle?.checked;
      const placeOn = !!clickPlaceToggle?.checked;

      window.__editorSafe708?.setGuidesVisible?.(guidesOn);
      window.__editorSafe608?.setGuidesVisible?.(guidesOn);
      window.__editorSafe?.setGuidesVisible?.(guidesOn);

      window.__editorSafe708?.toggleInspector?.(inspOn);
      window.__editorSafe608?.toggleInspector?.(inspOn);
      window.__editorSafe?.toggleInspector?.(inspOn);

      window.__editorSafe708?.setPlacementEnabled?.(placeOn);
      window.__editorSafe608?.setPlacementEnabled?.(placeOn);
      if (window.__editorSafe && window.__editorSafe !== window.__editorSafe608) {
        window.__editorSafe?.setPlacementEnabled?.(placeOn);
      }

      // Apply persisted 608 placement target to the controllers.
      try {
        const raw = String(placement608TargetSelect?.value || localStorage.getItem('subtitle-editor-608-placement-target') || 'block').trim().toLowerCase();
        const mode = (raw === 'line2' || raw === 'l2' || raw === '2')
          ? 'line2'
          : (raw === 'line1' || raw === 'l1' || raw === '1')
            ? 'line1'
            : 'block';
        window.__editorSafe708?.set608PlacementTarget?.(mode);
        window.__editorSafe608?.set608PlacementTarget?.(mode);
        if (window.__editorSafe && window.__editorSafe !== window.__editorSafe608) {
          window.__editorSafe?.set608PlacementTarget?.(mode);
        }
      } catch {}

      // Apply persisted 708 placement mode to the 708 controller.
      try {
        const raw = String(placement708ModeSelect?.value || localStorage.getItem('subtitle-editor-708-placement-mode') || 'zones').trim().toLowerCase();
        const mode = (raw === 'exact') ? 'exact' : 'zones';
        window.__editorSafe708?.set708PlacementMode?.(mode);
      } catch {}

      // Ensure the 608 placement target UI is visible when appropriate.
      try { update608PlacementTargetUiForDoc(state.doc); } catch {}
    } catch {}
  }


  // ===== Resizable split panels =====
  // - Preview (top) vs editor (bottom)
  // - Cue list vs QC panel (side-by-side, or stacked in narrow layouts)
  let splittersInstalled = false;

  function initResizablePanels() {
    if (splittersInstalled) return;
    splittersInstalled = true;

    const readStoredPx = (key) => {
      try {
        const raw = String(localStorage.getItem(key) || '').trim();
        if (!raw) return null;
        const v = parseFloat(raw);
        if (!Number.isFinite(v) || v <= 0) return null;
        return v;
      } catch {
        return null;
      }
    };

    const writeStoredPx = (key, v) => {
      try {
        const n = Math.round(Number(v) || 0);
        if (Number.isFinite(n) && n > 0) localStorage.setItem(key, String(n));
      } catch {}
    };

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    const canMeasureLayout = () => {
      try {
        if (!overlay || !mainEl || !previewRootEl) return false;
        // Hidden overlay or start-screen chooser → measurements are meaningless.
        if (overlay.classList?.contains?.('hidden')) return false;
        if (overlay.classList?.contains?.('is-chooser')) return false;

        const ms = getComputedStyle(mainEl);
        if (!ms || ms.display === 'none' || ms.visibility === 'hidden') return false;

        const r = mainEl.getBoundingClientRect();
        if (!r || r.width <= 1 || r.height <= 1) return false;
        return true;
      } catch {
        return false;
      }
    };


    const qcIsHidden = () => {
      try { return qcPanelEl && getComputedStyle(qcPanelEl).display === 'none'; } catch {}
      return false;
    };

    const isNarrowQcLayout = () => {
      try { return !!(window.matchMedia && window.matchMedia('(max-width: 1100px)').matches); } catch {}
      return false;
    };

    const qcConstraints = () => {
      const lowerRect = editorLowerEl?.getBoundingClientRect?.();
      const splitRect = qcSplitterEl?.getBoundingClientRect?.();
      const w = Number(lowerRect?.width) || 0;
      const h = Number(lowerRect?.height) || 0;
      const sw = Number(splitRect?.width) || 8;
      const sh = Number(splitRect?.height) || 8;

      const availableW = Math.max(0, w - sw);
      const availableH = Math.max(0, h - sh);

      let minPaneW = clamp(availableW * 0.25, 120, 260);
      if (availableW < minPaneW * 2) minPaneW = Math.max(80, availableW / 2);

      let minPaneH = clamp(availableH * 0.25, 90, 220);
      if (availableH < minPaneH * 2) minPaneH = Math.max(70, availableH / 2);

      const minQcW = Math.max(60, minPaneW);
      const maxQcW = Math.max(minQcW, availableW - minPaneW);

      const minQcH = Math.max(60, minPaneH);
      const maxQcH = Math.max(minQcH, availableH - minPaneH);

      return { minQcW, maxQcW, minQcH, maxQcH, splitterW: sw, splitterH: sh };
    };

    const previewControlsHeight = () => {
      let sum = 0;
      try {
        const header = previewRootEl?.querySelector?.('#subtitle-editor-preview-header');
        const scrub = previewRootEl?.querySelector?.('.preview-scrub-row');
        const time = previewRootEl?.querySelector?.('.time-display');

        const headerVisible = (() => {
          if (!header) return false;
          try { return getComputedStyle(header).display !== 'none' && header.getBoundingClientRect().height > 0; } catch {}
          return header.style.display !== 'none';
        })();

        if (headerVisible) sum += header.getBoundingClientRect().height;
        if (scrub) sum += scrub.getBoundingClientRect().height;
        if (time) sum += time.getBoundingClientRect().height;

        // Preview grid gaps: panes↔scrub, scrub↔time, plus header↔panes when header is visible.
        const cs = previewRootEl ? getComputedStyle(previewRootEl) : null;
        const rowGap = cs ? (parseFloat(cs.rowGap || cs.gap || '0') || 0) : 0;
        sum += rowGap * (headerVisible ? 3 : 2);
      } catch {}
      return sum;
    };

    const previewConstraints = () => {
      const mainRect = mainEl?.getBoundingClientRect?.();
      const splitRect = previewSplitterEl?.getBoundingClientRect?.();
      const h = Number(mainRect?.height) || 0;
      const sh = Number(splitRect?.height) || 8;
      const availableH = Math.max(0, h - sh);

      // Keep the entire preview visible (no internal scrollbars): reserve room for scrub/time rows
      // and require a minimum height for the preview panes row so the video never collapses.
      const controlsH = previewControlsHeight();
      const minVideoRowH = 140; // label + a small-but-usable video frame
      const desiredMinPreviewH = controlsH + minVideoRowH;

      // Also keep the editor lower area usable.
      const minLowerH = clamp(availableH * 0.25, 160, 320);

      // Always enforce a minimum preview height. If the window is too short,
      // allow the lower editor area to shrink/scroll rather than flattening
      // the preview frame into an unreadable strip.
      const minPreviewH = Math.max(60, desiredMinPreviewH);

      // Prefer leaving room for the editor lower area when possible, but never
      // allow the preview below the minimum.
      let maxPreviewH = Math.max(minPreviewH, availableH - minLowerH);

      // Only cap to the available height if that doesn't push us below the minimum.
      // (When the window is shorter than the minimum, the overall overlay will scroll.)
      if (availableH >= minPreviewH) maxPreviewH = Math.min(maxPreviewH, availableH);
      else maxPreviewH = minPreviewH;

      return { minPreviewH, maxPreviewH, splitterH: sh };
    };

    // NOTE: We intentionally do NOT apply persisted splitter sizes until the editor chrome
    // (toolbar + main grid) is actually visible. During the start-screen chooser the main
    // area is display:none, so any measurement/clamping would read as 0px and can corrupt
    // the stored sizes (opening the editor with a tiny, unreadable preview).

    const updateAria = () => {
      try {
        if (qcSplitterEl) {
          const narrow = isNarrowQcLayout();
          qcSplitterEl.setAttribute('aria-orientation', narrow ? 'horizontal' : 'vertical');
        }
      } catch {}
    };
    const clampPersisted = () => {
      try {
        if (!canMeasureLayout()) return;

        // Clamp QC based on current layout (only if it is visible).
        if (qcSplitterEl && qcPanelEl && editorLowerEl && !qcIsHidden()) {
          const narrow = isNarrowQcLayout();
          const c = qcConstraints();

          if (narrow) {
            const hasVar = !!String(overlay.style.getPropertyValue('--qc-panel-h') || '').trim();
            const stored = readStoredPx('subtitle-editor-qc-panel-h');
            const cur = qcPanelEl.getBoundingClientRect().height;
            const candidate = (!hasVar && stored) ? stored : cur;
            const next = clamp(candidate, c.minQcH, c.maxQcH);
            overlay.style.setProperty('--qc-panel-h', `${Math.round(next)}px`);
            writeStoredPx('subtitle-editor-qc-panel-h', next);
          } else {
            const hasVar = !!String(overlay.style.getPropertyValue('--qc-panel-w') || '').trim();
            const stored = readStoredPx('subtitle-editor-qc-panel-w');
            const cur = qcPanelEl.getBoundingClientRect().width;
            const candidate = (!hasVar && stored) ? stored : cur;
            const next = clamp(candidate, c.minQcW, c.maxQcW);
            overlay.style.setProperty('--qc-panel-w', `${Math.round(next)}px`);
            writeStoredPx('subtitle-editor-qc-panel-w', next);
          }
        }

        // Preview: apply stored size if present, otherwise choose a sensible default.
        // Always clamp to constraints and self-heal bad persisted values.
        if (previewSplitterEl && previewRootEl && mainEl) {
          const c = previewConstraints();

          const hasVar = !!String(overlay.style.getPropertyValue('--preview-h') || '').trim();
          const stored = readStoredPx('subtitle-editor-preview-h');

          const mainRect = mainEl.getBoundingClientRect();
          const splitRect = previewSplitterEl.getBoundingClientRect();
          const sh = Number(splitRect?.height) || 8;
          const availableH = Math.max(0, (Number(mainRect?.height) || 0) - sh);

          // Default: give the preview meaningful real estate so captions are readable.
          // (User can still drag the splitter; that setting persists.)
          const DEFAULT_SHARE = 0.60;
          const preferred = availableH * DEFAULT_SHARE;

          const cur = previewRootEl.getBoundingClientRect().height;
          const candidate = hasVar ? cur : (stored || preferred);

          const next = clamp(candidate, c.minPreviewH, c.maxPreviewH);
          overlay.style.setProperty('--preview-h', `${Math.round(next)}px`);
          writeStoredPx('subtitle-editor-preview-h', next);
        }
      } catch {}
    };

    // Expose a tiny hook so other flows (e.g. leaving the start-screen chooser)
    // can re-run sizing once the editor chrome becomes visible.
    try {
      overlay.__subtitleEditorRefreshSplitPanels = () => {
        try { updateAria(); } catch {}
        try { clampPersisted(); } catch {}
      };
    } catch {}

    // Apply aria + clamp after layout settles.

    try { requestAnimationFrame(() => { updateAria(); clampPersisted(); }); } catch {}

    const beginDrag = (which, pointerId) => {
      try { overlay.classList.add('dragging-splitter'); } catch {}
      try {
        const el = (which === 'qc') ? qcSplitterEl : previewSplitterEl;
        el?.setPointerCapture?.(pointerId);
      } catch {}
    };
    const endDrag = () => {
      try { overlay.classList.remove('dragging-splitter'); } catch {}
    };

    // QC splitter (cue list <-> QC)
    if (qcSplitterEl && qcPanelEl && editorLowerEl) {
      qcSplitterEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (qcIsHidden()) return;

        e.preventDefault();
        beginDrag('qc', e.pointerId);

        const narrow = isNarrowQcLayout();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = qcPanelEl.getBoundingClientRect().width;
        const startH = qcPanelEl.getBoundingClientRect().height;

        const move = (ev) => {
          const c = qcConstraints();
          if (narrow) {
            // QC is the bottom pane. Dragging down reduces its height.
            const dy = ev.clientY - startY;
            const next = clamp(startH - dy, c.minQcH, c.maxQcH);
            overlay.style.setProperty('--qc-panel-h', `${Math.round(next)}px`);
          } else {
            // QC is the right pane. Dragging right reduces its width.
            const dx = ev.clientX - startX;
            const next = clamp(startW - dx, c.minQcW, c.maxQcW);
            overlay.style.setProperty('--qc-panel-w', `${Math.round(next)}px`);
          }
        };

        const up = () => {
          window.removeEventListener('pointermove', move, true);
          window.removeEventListener('pointerup', up, true);
          endDrag();

          try {
            const narrowNow = isNarrowQcLayout();
            if (narrowNow) {
              writeStoredPx('subtitle-editor-qc-panel-h', qcPanelEl.getBoundingClientRect().height);
            } else {
              writeStoredPx('subtitle-editor-qc-panel-w', qcPanelEl.getBoundingClientRect().width);
            }
          } catch {}
        };

        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
      });
    }

    // Preview splitter (preview <-> cues/QC)
    if (previewSplitterEl && previewRootEl && mainEl) {
      previewSplitterEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;

        e.preventDefault();
        beginDrag('preview', e.pointerId);

        const startY = e.clientY;
        const startH = previewRootEl.getBoundingClientRect().height;

        // If the preview is currently auto-sized, lock it in so dragging is stable.
        overlay.style.setProperty('--preview-h', `${Math.round(startH)}px`);

        const move = (ev) => {
          const c = previewConstraints();
          const dy = ev.clientY - startY;
          const next = clamp(startH + dy, c.minPreviewH, c.maxPreviewH);
          overlay.style.setProperty('--preview-h', `${Math.round(next)}px`);
        };

        const up = () => {
          window.removeEventListener('pointermove', move, true);
          window.removeEventListener('pointerup', up, true);
          endDrag();
          try { writeStoredPx('subtitle-editor-preview-h', previewRootEl.getBoundingClientRect().height); } catch {}
        };

        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
      });
    }

    // Keep aria orientation + clamping updated when crossing the responsive breakpoint.
    try {
      const mq = window.matchMedia && window.matchMedia('(max-width: 1100px)');
      if (mq && typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', () => { updateAria(); clampPersisted(); });
      } else {
        window.addEventListener('resize', () => { updateAria(); clampPersisted(); });
      }
    } catch {}
  }

  function updateFormatButtonsForDoc(doc) {
    const scc = isSccDoc(doc);
    const web = isWebCaptionDoc(doc);
    const overlay = document.getElementById('subtitle-editor-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('.btn-scc-only').forEach(b => { b.style.display = scc ? '' : 'none'; });
    overlay.querySelectorAll('.btn-nonscc-only').forEach(b => { b.style.display = scc ? 'none' : ''; });
    const smpte = usesSmpteTimecode(doc);
    overlay.querySelectorAll('.btn-smpte-only').forEach(b => { b.style.display = smpte ? '' : 'none'; });

    // Web captions (SRT/VTT) should not be presented with SCC/MCC-focused
    // deliverable controls in the toolbar. Those exports are still available
    // from other doc types; here we hide them to reduce mode confusion.
    const btnExportMcc = overlay.querySelector('#subtitle-editor-export-mcc');
    if (btnExportMcc) btnExportMcc.style.display = web ? 'none' : '';

    const btnStartTc = overlay.querySelector('#subtitle-editor-start-tc');
    if (btnStartTc) btnStartTc.style.display = web ? 'none' : '';

    // Extra guard: never show “Normalize frames” in web caption mode, even if
    // a stale Start TC flag slipped through.
    if (web) {
      const btnNorm = overlay.querySelector('#subtitle-editor-normalize-frames');
      if (btnNorm) btnNorm.style.display = 'none';
    }
    // In SCC mode the user’s mental model is “I am exporting SCC / burn-in”, not “corrections”.
  }

  function updateWebToolbarForDoc(doc) {
    if (!webLimitsEl) return;

    const hint = isSrtDoc(doc) ? 'srt' : (isVttDoc(doc) ? 'vtt' : null);
    if (!hint) {
      webLimitsEl.textContent = '';
      webLimitsEl.title = '';
      return;
    }

    // Prefer the opened document's own shaping values. Local defaults are only a fallback.
    const maxLines = (
      _readMaxLinesPerBlock(doc, hint) ??
      _readAssistMaxLinesPerBlock(hint) ??
      2
    );
    const maxChars = (
      _readMaxCharsPerLine(doc, hint) ??
      _readAssistMaxCharsPerLine(hint) ??
      42
    );

    const fmt = hint.toUpperCase();
    webLimitsEl.textContent = tr('subtitleEditor.web.limitsSummary', '{{format}} · max {{maxLines}} lines · {{maxChars}} chars', { format: fmt, maxLines, maxChars });
    webLimitsEl.title = tr('subtitleEditor.web.limitsTitle', 'Active {{format}} format limits for this document', { format: fmt });
  }

  function updateEditorInteractionUiForDoc(doc) {
    // Commit 4: toolbar surfaces are mode-specific and driven by CSS classes
    // on the editor root (.mode-web vs .mode-broadcast). Do not mutate broadcast
    // toggle state when switching between doc types.
    try { updateWebToolbarForDoc(doc); } catch {}

    // Apply web guides preference to the web preview controller (SRT/VTT only).
    if (isWebCaptionDoc(doc)) {
      const on = !!webGuidesToggleEl?.checked;
      window.__editorWeb?.setGuidesVisible?.(on);
    }
  }

  function update708PlacementModeUiForDoc(doc) {
    // Only meaningful for 708-capable docs (MCC/CEA-708). Hide for everything else.
    if (!placement708ModeWrap || !placement708ModeSelect) return;
    const show = !!(doc && is708Doc(doc));
    placement708ModeWrap.style.display = show ? '' : 'none';
    if (!show) return;

    const raw = String(placement708ModeSelect.value || 'zones').trim().toLowerCase();
    const mode = (raw === 'exact') ? 'exact' : 'zones';
    try { window.__editorSafe708?.set708PlacementMode?.(mode); } catch {}
  }

  function update608PlacementTargetUiForDoc(doc) {
    // Only meaningful when the primary preview is 608 (single-pane mode).
    // In dual-preview (708 authoring), click-to-place is about 708 zones and
    // we don't want extra knobs that suggest direct 608 row/col editing there.
    if (!placement608TargetWrap || !placement608TargetSelect) return;

    // Commit 3: never show 608 click-to-place targeting controls for web captions (SRT/VTT).
    if (isWebCaptionDoc(doc)) {
      placement608TargetWrap.style.display = 'none';
      return;
    }

    const placeToggle = overlay?.querySelector?.('#toggle-click-place');
    const placeOn = !!placeToggle?.checked;

    // SCC: keep the 608 move target visible at all times so users can preselect
    // the target before enabling click-to-place (matches the MCC ergonomics).
    const isPureScc = !!(doc && isSccDoc(doc) && !isMccDoc(doc));

    const show = isPureScc
      ? !!doc
      : (isMccDoc(doc)
        ? !!(placeOn && doc)
        : !!(placeOn && doc && !wantsDualPreview(doc)));
    placement608TargetWrap.style.display = show ? '' : 'none';
    if (!show) return;

    // Keep controllers in sync with the current UI value.
    try {
      const raw = String(placement608TargetSelect.value || 'block').trim().toLowerCase();
      const mode = (raw === 'line2' || raw === 'l2' || raw === '2')
        ? 'line2'
        : (raw === 'line1' || raw === 'l1' || raw === '1')
          ? 'line1'
          : 'block';
      window.__editorSafe708?.set608PlacementTarget?.(mode);
      window.__editorSafe608?.set608PlacementTarget?.(mode);
      if (window.__editorSafe && window.__editorSafe !== window.__editorSafe608) {
        window.__editorSafe?.set608PlacementTarget?.(mode);
      }
    } catch {}
  }

  function _update608OverridePillForActiveCue() {
    if (!preview608OverridePillEl) return;

    // Only meaningful when authoring 708 with 608 compatibility enabled.
    const doc = state.doc;
    if (!doc || !wantsDualPreview(doc) || !_include608CompatibilityEnabled(doc)) {
      preview608OverridePillEl.style.display = 'none';
      preview608OverridePillEl.classList.remove('same', 'diff');
      return;
    }

    const idx = Number(state.activeCue);
    const cue = (Array.isArray(doc?.cues) && idx >= 0 && idx < doc.cues.length) ? doc.cues[idx] : null;

    const ov = _getCompat608OverrideText(cue);
    const active = !!String(ov || '').trim();
    if (!active) {
      preview608OverridePillEl.style.display = 'none';
      preview608OverridePillEl.classList.remove('same', 'diff');
      return;
    }

    let same = false;
    try {
      const derived = _buildDerived608CueForPreview(cue, doc, { ignoreOverride: true });
      const effective = _buildDerived608CueForPreview(cue, doc, { ignoreOverride: false });
      const a = _normalize608CompareText(derived?.text || '');
      const b = _normalize608CompareText(effective?.text || '');
      if (a && b && a === b) same = true;
    } catch {}

    preview608OverridePillEl.style.display = '';
    preview608OverridePillEl.textContent = same ? 'Override (same)' : 'Override';
    preview608OverridePillEl.classList.toggle('same', same);
    preview608OverridePillEl.classList.toggle('diff', !same);
  }

  function updatePreviewLayoutForDoc(doc) {
    const previewRoot = overlay?.querySelector('#subtitle-editor-preview');
    const panes = overlay?.querySelector('#subtitle-editor-preview-panes');
    if (!previewRoot || !panes) return;

    const dual = wantsDualPreview(doc);

    previewRoot.classList.toggle('is-dual', !!dual);
    previewRoot.classList.toggle('is-single', !dual);

    const pane708 = panes.querySelector('[data-preview-track="708"]');
    const pane608 = panes.querySelector('[data-preview-track="608"]');

    const label708 = pane708?.querySelector('.preview-label');
    const label608 = pane608?.querySelector('.preview-label');

    const setLabelText = (labelEl, text) => {
      if (!labelEl) return;
      const span = labelEl.querySelector?.('.preview-label-text');
      if (span) span.textContent = String(text || '');
      else labelEl.textContent = String(text || '');
    };

    if (dual) {
      setLabelText(label708, '708 (authoring source)');
      setLabelText(
        label608,
        _include608CompatibilityEnabled(doc)
          ? '608 (derived, with overrides)'
          : '608 (disabled in export)'
      );
      if (pane608) pane608.style.display = '';
    } else {
      // Single preview: keep the per-pane label stable so the fitted video frame
      // isn't collapsed by long metadata lines (those live in the centered header row).
      setLabelText(label708, 'Preview');
      if (pane608) pane608.style.display = 'none';
    }

    try { _update608OverridePillForActiveCue(); } catch {}
    // Layout changes (dual ↔ single, label text, hiding 608 pane) can change
    // the available host slot size; refit to keep the frame proportional.
    try { schedulePreviewHostFit(); } catch {}
  }

  function scheduleMccPreviewRebuild(immediate = false) {
    if (!state.doc || !wantsDualPreview(state.doc)) {
      // Ensure stale preview docs don't linger when switching formats.
      state.mccPreview.ok = false;
      state.mccPreview.preview708 = null;
      state.mccPreview.preview608 = null;
      state.mccPreview.warnings = [];
      state.mccPreview.lastError = null;
      state.mccPreview.pending = false;
      state.mccPreview.lastUpdatedAt = 0;
      state.mccPreview.lastConfigKey = '';
      return;
    }
    if (typeof ipc?.invoke !== 'function') return;

    const run = () => {
      mccPreviewDebounceTimer = null;
      rebuildMccPreviewNow().catch((err) => {
        state.mccPreview.pending = false;
        state.mccPreview.ok = false;
        state.mccPreview.lastError = err?.message || String(err);
      });
    };

    if (mccPreviewDebounceTimer) {
      clearTimeout(mccPreviewDebounceTimer);
      mccPreviewDebounceTimer = null;
    }

    if (immediate) {
      run();
    } else {
      mccPreviewDebounceTimer = setTimeout(run, 250);
    }
  }

  async function rebuildMccPreviewNow() {
    if (!state.doc || !wantsDualPreview(state.doc)) return;
    if (typeof ipc?.invoke !== 'function') return;

    // Preview must be export-faithful, including MCC prefs stored in localStorage
    // (safeMargins, wrap/overflow policy, strict encoding, etc.). Those prefs are NOT
    // embedded in MCC files, so the doc may not carry them unless it has been exported.
    const docForPreview = (() => {
      try {
        const doc = state.doc;
        const prefs = (typeof getMccPrefsFromLocalStorage === 'function') ? getMccPrefsFromLocalStorage() : null;
        const existing = (doc && doc.mccOptions && typeof doc.mccOptions === 'object') ? doc.mccOptions : {};
        if (!prefs || typeof prefs !== 'object') return doc;

        const mergedSafeMargins = { ...(prefs.safeMargins || {}), ...(existing.safeMargins || {}) };
        const mergedQc = { ...(prefs.qc || {}), ...(existing.qc || {}) };
        const mergedShaping = { ...(prefs.shaping || {}), ...(existing.shaping || {}) };

        const mergedOptions = { ...prefs, ...existing, safeMargins: mergedSafeMargins, qc: mergedQc, shaping: mergedShaping };
        return { ...doc, mccOptions: mergedOptions };
      } catch {
        return state.doc;
      }
    })();

    const updatedAt = Number(docForPreview?.updatedAt) || 0;

    const configKey = (() => {
      try {
        const mo = (docForPreview && docForPreview.mccOptions && typeof docForPreview.mccOptions === 'object') ? docForPreview.mccOptions : {};
        const safe = (mo.safeMargins && typeof mo.safeMargins === 'object') ? mo.safeMargins : { left: 0, right: 0 };
        const l = Number.isFinite(Number(safe.left)) ? Math.max(0, Math.min(15, Math.trunc(Number(safe.left)))) : 0;
        const r = Number.isFinite(Number(safe.right)) ? Math.max(0, Math.min(15, Math.trunc(Number(safe.right)))) : 0;

        // 708 window placement (DefineWindow anchor). This MUST be part of the key
        // because users can tweak it via MCC prefs without touching cue text.
        const winKey = (() => {
          try {
            const raw = (mo.mcc708Window && typeof mo.mcc708Window === 'object')
              ? mo.mcc708Window
              : ((mo.windowPlacement && typeof mo.windowPlacement === 'object')
                ? mo.windowPlacement
                : ((mo.window && typeof mo.window === 'object') ? mo.window : null));
            if (!raw) return 'win:na';

            const w = { ...raw };
            const rel = (w.rel !== false) && (w.relative !== false);

            const anchorIdRaw = Number.isFinite(Number(w.anchorId)) ? Math.trunc(Number(w.anchorId)) : 7;
            const anchorId = Math.max(0, Math.min(8, anchorIdRaw));

            let anchorV = Number.isFinite(Number(w.anchorV)) ? Math.trunc(Number(w.anchorV)) : (rel ? 90 : 67);
            let anchorH = Number.isFinite(Number(w.anchorH)) ? Math.trunc(Number(w.anchorH)) : (rel ? 50 : 105);

            // Normalize to avoid key churn between equivalent representations
            // (relative vs absolute coords, classic clamped defaults, etc.).
            if (rel) {
              // If Relative is ON but H looks like absolute (0..209), convert.
              if (Number.isFinite(anchorH) && anchorH > 99) {
                const hAbs = Math.max(0, Math.min(209, anchorH));
                anchorH = Math.round((hAbs / 209) * 99);

                // Convert V only if it also looks absolute (0..74).
                if (Number.isFinite(anchorV) && anchorV >= 0 && anchorV <= 74) {
                  const vAbs = Math.max(0, Math.min(74, anchorV));
                  anchorV = Math.round((vAbs / 74) * 99);
                }
              }
              anchorV = Math.max(0, Math.min(99, anchorV));
              anchorH = Math.max(0, Math.min(99, anchorH));
            } else {
              // Absolute mode: V is 0..74, H is 0..209.
              const vLooksRelative = (anchorV > 74 && anchorV <= 99);
              const classicClampedDefault = (anchorId === 7 && anchorH === 50 && anchorV === 74);

              if (vLooksRelative) {
                // Treat both anchors as relative percentages and convert to absolute.
                anchorH = Math.round((Math.max(0, Math.min(99, anchorH)) / 99) * 209);
                anchorV = Math.round((Math.max(0, Math.min(99, anchorV)) / 99) * 74);
              } else if (classicClampedDefault) {
                // Likely intended default ~90% vertical placement, but got clamped.
                anchorH = Math.round((50 / 99) * 209);
                anchorV = Math.round((90 / 99) * 74);
              }

              anchorV = Math.max(0, Math.min(74, anchorV));
              anchorH = Math.max(0, Math.min(209, anchorH));
            }

            return `win:${rel ? 1 : 0},${anchorId},${anchorV},${anchorH}`;
          } catch {
            return 'win:na';
          }
        })();

        // Keep key small and stable; only include knobs that affect MCC encoding / derived 608.
        return [
          'mccPreview:v1',
          `fps:${Number(docForPreview?.fps ?? 0).toFixed(3)}`,
          `df:${docForPreview?.dropFrame === false ? 0 : 1}`,
          `include608:${mo.include608Compatibility === false ? 0 : 1}`,
          `safe:${l},${r}`,
          winKey,
          `align:${String(mo.alignment || docForPreview?.alignment || '').trim().toLowerCase()}`,
          `rowPolicy:${String(mo.rowPolicy || docForPreview?.sccOptions?.rowPolicy || '').trim().toLowerCase()}`,
          `overflow:${String(mo.overflowPolicy || '').trim().toLowerCase()}`,
          `strict:${(mo.strictCharacterEncoding === true) ? 1 : 0}`,
          `padEven:${(mo.padEven === true) ? 1 : 0}`,
          `repeatCtl:${(mo.repeatControlCodes === false) ? 0 : 1}`,
          `repeatPac:${(mo.repeatPreambleCodes === false) ? 0 : 1}`,
          `maxChars:${Number.isFinite(Number(mo.maxCharsPerLine)) ? Math.trunc(Number(mo.maxCharsPerLine)) : ''}`,
          `maxLines:${Number.isFinite(Number(mo.maxLinesPerBlock)) ? Math.trunc(Number(mo.maxLinesPerBlock)) : ''}`,
          `maxDur:${Number.isFinite(Number(mo.maxDurationSeconds)) ? Number(mo.maxDurationSeconds) : ''}`,
          `compatMode:${String(mo.compatibilityMode || '').trim().toLowerCase()}`,
          `teles:${(mo.telestreamCompression === true) ? 1 : 0}`,
          `ccsvc:${(mo.includeCcsSvcInfo === false) ? 0 : 1}`,
          `cdpTc:${(mo.includeCdpTimecode === true || mo.embedCdpTimecode === true) ? 1 : 0}`
        ].join('|');
      } catch {
        return 'mccPreview:v1';
      }
    })();

    // Avoid spamming rebuilds if neither the doc nor the export-relevant prefs changed.
    if (state.mccPreview.ok && !state.mccPreview.pending) {
      const lastAt = Number(state.mccPreview.lastUpdatedAt) || 0;
      const lastKey = String(state.mccPreview.lastConfigKey || '');
      if ((updatedAt && updatedAt <= lastAt) && configKey === lastKey) return;
    }

    const reqId = ++mccPreviewRequestId;
    state.mccPreview.pending = true;
    state.mccPreview.lastError = null;

    const result = await ipc.invoke('subtitle-editor-preview-mcc', { doc: docForPreview });
    if (reqId !== mccPreviewRequestId) return; // stale response

    if (!result || result.error) {
      state.mccPreview.ok = false;
      state.mccPreview.pending = false;
      state.mccPreview.lastError = result?.error || 'Failed to build MCC preview.';
      return;
    }

    state.mccPreview.ok = !!result.ok;
    state.mccPreview.preview708 = result.preview708 || null;
    state.mccPreview.preview608 = result.preview608 || null;
    state.mccPreview.warnings = Array.isArray(result.warnings) ? result.warnings.slice(0, 50) : [];
    state.mccPreview.pending = false;
    state.mccPreview.lastUpdatedAt = updatedAt || Date.now();
    state.mccPreview.lastConfigKey = configKey;

    // Immediately re-render using the newly built preview docs.
    try { renderActiveCue608(); } catch {}
  }

  // Keep the two preview videos in lockstep so 708 and 608 can be compared.
  function isDualPreviewActive() {
    if (!videoEl || !videoEl608) return false;
    if (!state.doc || !wantsDualPreview(state.doc)) return false;
    // If the 608 pane is hidden (single preview), don't waste cycles.
    const pane608 = overlay?.querySelector('[data-preview-track="608"]');
    if (pane608 && pane608.style.display === 'none') return false;
    return true;
  }

  // P0-1: pending seek guard (cue click / QC navigation) ---------------------------------
  // While a seek is in-flight, we temporarily suppress time-follow selection updates so
  // the UI can't "flash" the old cue or desync 708/608 previews.
  const PENDING_SEEK_EPS_SEC = 0.12;
  const PENDING_SEEK_TIMEOUT_MS = 1500;

  function _nowMs() {
    try {
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
    } catch {}
    return Date.now();
  }

  function _hasPendingSeek() {
    return (state.pendingSeekTime != null) && Number.isFinite(Number(state.pendingSeekTime));
  }

  function _pendingSeekAgeMs() {
    return _hasPendingSeek() ? (_nowMs() - (Number(state.pendingSeekSetAtMs) || 0)) : 0;
  }

  function _pendingSeekTimedOut() {
    return _hasPendingSeek() && _pendingSeekAgeMs() > PENDING_SEEK_TIMEOUT_MS;
  }

  function _playheadCloseToPending(tNowSec) {
    const pending = Number(state.pendingSeekTime);
    const t = Number(tNowSec);
    if (!Number.isFinite(pending) || !Number.isFinite(t)) return false;
    return Math.abs(t - pending) <= PENDING_SEEK_EPS_SEC;
  }

  function _setPendingSeek(tSec) {
    const t = Number(tSec);
    if (!Number.isFinite(t)) {
      state.pendingSeekTime = null;
      state.pendingSeekSetAtMs = 0;
      return;
    }
    state.pendingSeekTime = t;
    state.pendingSeekSetAtMs = _nowMs();
  }

  function _clearPendingSeek() {
    state.pendingSeekTime = null;
    state.pendingSeekSetAtMs = 0;
  }

  // Returns a time override for rendering/sync, or null if none.
  function _getPendingSeekTimeForPreview() {
    if (!_hasPendingSeek()) return null;
    if (_pendingSeekTimedOut()) {
      _clearPendingSeek();
      return null;
    }
    return Number(state.pendingSeekTime);
  }

  function _maybeClearPendingSeek(tNowSec) {
    if (!_hasPendingSeek()) return false;
    if (_pendingSeekTimedOut() || _playheadCloseToPending(tNowSec)) {
      _clearPendingSeek();
      return true;
    }
    return false;
  }

  function syncSecondaryTime(force = false) {
    if (!isDualPreviewActive()) return;
    const pending = _getPendingSeekTimeForPreview();
    const t = Number(pending != null ? pending : videoEl.currentTime) || 0;
    try {
      const t2 = Number(videoEl608.currentTime) || 0;
      const drift = Math.abs(t2 - t);
      if (force || drift > 0.08) {
        videoEl608.currentTime = t;
      }
    } catch {}
  }

  function syncSecondaryPlaybackState() {
    if (!isDualPreviewActive()) return;
    try { videoEl608.playbackRate = videoEl.playbackRate || 1; } catch {}
    try {
      if (videoEl.paused) {
        videoEl608.pause();
      } else {
        // Muted + same user gesture usually satisfies autoplay policies.
        videoEl608.play();
      }
    } catch {}
  }

  // --- helpers --------------------------------------------------------------
  function autoSizeTextarea(ta) {
    if (!ta) return;

    // Cue editors are fixed-height (3 lines) across all subtitle formats.
    // Never auto-resize anything with the cue-text class (canonical + 708/608 overrides).
    if (ta.classList && ta.classList.contains('cue-text')) return;

    ta.style.height = 'auto';
    // scrollHeight does not include borders; add them so the last line isn't clipped.
    const cs = getComputedStyle(ta);
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    ta.style.height = `${Math.max(ta.scrollHeight + bt + bb, 40)}px`;
  }

  function findCueAtTime(cues, t) {
    if (!Array.isArray(cues) || !cues.length) return null;
    let lo = 0;
    let hi = cues.length - 1;
    const time = Number(t) || 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (!c) {
        hi = mid - 1;
        continue;
      }
      const s = Number(c.start) || 0;
      const e = Number(c.end) || 0;
      if (time < s) {
        hi = mid - 1;
      } else if (time >= e) {
        lo = mid + 1;
      } else {
        return c;
      }
    }
    return null;
  }

  // Web caption selection must be "active cue" accurate:
  // return the cue index where start <= t < end, else -1.
  function findCueIndexAtTime(cues, t) {
    if (!Array.isArray(cues) || !cues.length) return -1;
    let lo = 0;
    let hi = cues.length - 1;
    const time = Number(t) || 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (!c) { hi = mid - 1; continue; }
      const s = Number(c.start) || 0;
      const e = Number(c.end) || 0;
      if (time < s) hi = mid - 1;
      else if (time >= e) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function findCueOverlappingWindow(cues, start, end) {
    if (!Array.isArray(cues) || !cues.length) return null;
    const s0 = Number(start);
    const e0 = Number(end);

    if (!Number.isFinite(s0) || !Number.isFinite(e0) || e0 <= s0) {
      return findCueAtTime(cues, Number.isFinite(s0) ? s0 : 0);
    }

    // Lower-bound search by start time, then scan forward for overlaps.
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const ms = Number(cues[mid]?.start) || 0;
      if (ms < s0) lo = mid + 1;
      else hi = mid;
    }

    let best = null;
    let bestOverlap = 0;
    for (let i = Math.max(0, lo - 1); i < cues.length; i++) {
      const c = cues[i];
      if (!c) continue;
      const cs = Number(c.start) || 0;
      const ce = Number(c.end) || 0;
      if (cs >= e0) break;
      const overlap = Math.max(0, Math.min(ce, e0) - Math.max(cs, s0));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = c;
      }
    }

    return best;
  }

  function renderActiveCue608() {
    const cues = state.doc?.cues;
    const idx  = state.activeCue;
    let cue    = (cues && idx != null && idx >= 0 && idx < cues.length)
      ? cues[idx]
      : null;

    try { _update608OverridePillForActiveCue(); } catch {}

    if (is708Doc(state.doc)) {
      // P0-1: If a click/jump seek is in-flight, drive both preview panes using the
      // intended target time. This avoids "wrong cue flash" while the media element
      // is still showing the previous decoded frame/time.
      const pending = _getPendingSeekTimeForPreview();

      // If the video isn't actually loaded/decoding yet, currentTime will sit at 0
      // and make the 608/708 preview panes look "blank" even though captions exist.
      // Use the selected cue window as a fallback driver.
      const canUseVideoTime = (() => {
        if (!videoEl) return false;
        if (!videoEl.src) return false;
        if ((videoEl.readyState || 0) === 0) return false;
        return true;
      })();

      const t = (pending != null)
        ? Number(pending)
        : (canUseVideoTime
          ? (Number(videoEl.currentTime) || 0)
          : (Number(cue?.start) || 0));

      // If we have a built MCC preview, drive the panes off the decoded MCC.
      if (state.mccPreview.ok && state.mccPreview.preview708 && state.mccPreview.preview608) {
        const cues708 = state.mccPreview.preview708.cues;
        const cues608 = state.mccPreview.preview608.cues;

        let cue708 = findCueAtTime(cues708, t);
        let cue608 = findCueAtTime(cues608, t);

        const hasCanonicalWindow =
          !!(cue && Number.isFinite(Number(cue.start)) && Number.isFinite(Number(cue.end)) && (Number(cue.end) > Number(cue.start)));

        // Selection-driven (cue click / QC jump) should be deterministic:
        // prefer the decoded cue that best overlaps the selected canonical cue window.
        // This prevents "one cue behind" behavior around pop-on / late-EOC boundaries,
        // where the previous caption can still be on-air at cue.start.
        if (hasCanonicalWindow) {
          const win708 = findCueOverlappingWindow(cues708, cue.start, cue.end)
            || findCueAtTime(cues708, Number(cue.start) || 0);
          const win608 = findCueOverlappingWindow(cues608, cue.start, cue.end)
            || findCueAtTime(cues608, Number(cue.start) || 0);

          if (pending != null) {
            if (win708) cue708 = win708;
            if (win608) cue608 = win608;
          } else {
            if (!cue708 && win708) cue708 = win708;
            if (!cue608 && win608) cue608 = win608;
          }
        }

        const want608 = _include608CompatibilityEnabled(state.doc);
        let fallback608 = null;

        // Merge canonical per-cue placement overrides onto the decoded cue so
        // click-to-place updates render immediately (even before the MCC preview rebuild completes).
        const cue708ForRender = (() => {
          if (!cue708) return null;
          if (!cue) return cue708;
          const hasZone = !!(cue?.cea708Placement && typeof cue.cea708Placement === 'object' && cue.cea708Placement.an != null);
          const hasWin = !!(cue?.overrides && typeof cue.overrides === 'object' && cue.overrides['708'] && typeof cue.overrides['708'] === 'object' && cue.overrides['708'].window);
          if (!hasZone && !hasWin) return cue708;
          return { ...cue708, cea708Placement: cue.cea708Placement, overrides: cue.overrides };
        })();

        try { window.__editorSafe?.render708?.(cue708ForRender || null); } catch {}

        // If the decoded 608 cue isn't found, fall back to a local derived 608 render
        // from the canonical cue/override so the compat pane never goes blank.
        try {
          fallback608 = (want608 && cue && !cue608)
            ? _buildDerived608CueForPreview(cue, state.doc, { timeSec: t })
            : null;
          // IMPORTANT:
          // The decoded MCC 608 cue is the source of truth for placement. Only overlay
          // canonical placement when the user has just edited placement and the preview
          // is stale/pending. Otherwise the editor can lie about what Premiere will show.
          const cue608ForRender = (() => {
            if (!want608) return cue608 || null;
            if (!cue608) return null;
            if (!cue) return cue608;
            const lines = Array.isArray(cue608.lines) ? cue608.lines : null;
            if (!lines) return cue608;

            const o608 = (cue.overrides && typeof cue.overrides === 'object') ? cue.overrides['608'] : null;
            const hasPlacement = Array.isArray(o608?.placement) && o608.placement.length;
            const touched = !!(o608 && typeof o608 === 'object' && o608._placementTouched === true);
            const docAt = Number(state.doc?.updatedAt) || 0;
            const prevAt = Number(state.mccPreview?.lastUpdatedAt) || 0;
            const stale = !!state.mccPreview?.pending || (docAt > prevAt);

            // Only overlay when placement was touched and preview is stale/pending.
            if (!(hasPlacement && touched && stale)) return cue608;

            const safe = _read608SafeMarginsForPreview(state.doc);
            const alignment = _read608AlignmentForPreview(state.doc);
            const placements = _derive608PlacementsForPreviewLines(lines, cue, state.doc, { safe, alignment });
            if (!placements) return cue608;
            return { ...cue608, sccPlacement: placements };
          })();

          window.__editorSafe608?.render608?.(cue608ForRender || fallback608 || null);
        } catch {}

        // Surface *exact* placement data when we have it (decoded MCC), and be explicit
        // about fallbacks when we don't.
        try {
          updateQcInspectorForRenderedCues({
            canonicalCue: cue || null,
            cue708: cue708 || null,
            cue608: (cue608 || fallback608 || null),
            source708: cue708 ? 'decoded-mcc' : (cue ? 'canonical' : 'none'),
            source608: cue608 ? 'decoded-mcc' : (fallback608 ? 'derived-fallback' : 'none')
          });
        } catch {}
        return;
      }

      // Fallback: render the selected canonical cue (708) in the primary pane, and
      // render a derived 608 fallback in the compat pane so it never goes blank.
      const want608 = _include608CompatibilityEnabled(state.doc);
      let derived608 = null;

      try { window.__editorSafe?.render708?.(cue || null); } catch {}

      try {
        if (!want608 || !cue) {
          window.__editorSafe608?.render608?.(null);
        } else {
          derived608 = _buildDerived608CueForPreview(cue, state.doc, { timeSec: t });
          window.__editorSafe608?.render608?.(derived608 || null);
        }
      } catch {}

      try {
        updateQcInspectorForRenderedCues({
          canonicalCue: cue || null,
          cue708: cue || null,
          cue608: derived608 || null,
          source708: cue ? 'canonical' : 'none',
          source608: derived608 ? 'derived-fallback' : 'none'
        });
      } catch {}
      return;
    }

    // Web caption docs (SRT/VTT): render via the dedicated web-caption preview
    // layer attached directly to the preview host. This is intentionally separate
    // from the broadcast safe-title overlay so SRT/VTT never inherit SCC/MCC grids
    // or geometry.
    if (isWebCaptionDoc(state.doc)) {
      try { window.__editorWeb?.renderCue?.(cue || null, state.doc); } catch {}
      return;
    }

    // Non‑SCC: fall back to 608-style preview for everything else.
    if (!isSccDoc(state.doc) || !cue || !Array.isArray(cues)) {
      try { window.__editorSafe?.render608?.(cue || null); } catch {}
      return;
    }

    // SCC: reconstruct the full 608 pop‑on "block" by grouping cues that share
    // the same start/end (within ~1 frame). Many pipelines split each text row
    // into its own cue even though on-air it's one caption.
    const start = Number(cue.start) || 0;
    const end   = Number(cue.end)   || 0;
    // IMPORTANT: SCC is *usually* 29.97 (1001/30000), and our time parsing is ms-rounded.
    // Using a hard-coded 1/30 can fail on rounding-heavy files or if the doc fps differs.
    // Use the document fps when available and add a tiny epsilon for ms quantization.
    const fpsRaw = Number(state.doc?.fps);
    const fps = (Number.isFinite(fpsRaw) && fpsRaw > 0) ? fpsRaw : 29.97;
    const frameTol = (1 / fps) + 0.001; // 1 frame + 1ms epsilon

    const block = [cue];

    // Walk backwards for earlier rows with matching timing.
    for (let i = idx - 1; i >= 0; i--) {
      const c = cues[i];
      if (!c) break;
      const cs = Number(c.start) || 0;
      const ce = Number(c.end)   || 0;
      if (Math.abs(cs - start) <= frameTol && Math.abs(ce - end) <= frameTol) {
        block.unshift(c);
      } else if (ce < start - frameTol) {
        // Once we're clearly before this block, stop scanning.
        break;
      }
    }

    // Walk forwards for later rows with matching timing.
    for (let i = idx + 1; i < cues.length; i++) {
      const c = cues[i];
      if (!c) break;
      const cs = Number(c.start) || 0;
      const ce = Number(c.end)   || 0;
      if (Math.abs(cs - start) <= frameTol && Math.abs(ce - end) <= frameTol) {
        block.push(c);
      } else if (cs > end + frameTol) {
        // Once we're clearly after this block, stop scanning.
        break;
      }
    }

    // Build a virtual cue that contains up to two text rows plus row/col placement.
    if (block.length > 1) {
      const entries = [];
      for (const c of block) {
        const ln = Array.isArray(c.lines) && c.lines.length
          ? c.lines[0]
          : String(c.text || '');
        if (!ln) continue;

        let placement = null;
        const sp = c.sccPlacement;
        if (Array.isArray(sp)) {
          placement = sp[0] || null;
        } else if (sp && typeof sp === 'object') {
          // handle older object-style {0: {row, col}}
          placement = sp[0] || sp['0'] || null;
        }

        entries.push({
          ln,
          placement,
          // preserve original order for stable tie-breaking
          _i: entries.length
        });
      }

      // If we have explicit row placements for (at least) two entries, sort by row
      // so top-to-bottom order is correct even when file cue order is odd.
      const withRowCount = entries.reduce((n, e) => (
        (e.placement && Number.isFinite(e.placement.row)) ? (n + 1) : n
      ), 0);
      let picked = entries;
      if (withRowCount >= 2) {
        picked = entries.slice().sort((a, b) => {
          const ar = (a.placement && Number.isFinite(a.placement.row)) ? a.placement.row : Number.POSITIVE_INFINITY;
          const br = (b.placement && Number.isFinite(b.placement.row)) ? b.placement.row : Number.POSITIVE_INFINITY;
          if (ar !== br) return ar - br;

          const ac = (a.placement && Number.isFinite(a.placement.col)) ? a.placement.col : Number.POSITIVE_INFINITY;
          const bc = (b.placement && Number.isFinite(b.placement.col)) ? b.placement.col : Number.POSITIVE_INFINITY;
          if (ac !== bc) return ac - bc;

          return (a._i || 0) - (b._i || 0);
        });
      }

      picked = picked.slice(0, 2); // 608 pop‑on is max 2 visible rows here
      const lines = picked.map(e => e.ln);
      const placements = picked.map(e => e.placement || null);

      cue = { ...cue, lines, sccPlacement: placements };
    }

    try { window.__editorSafe?.render608?.(cue || null); } catch {}
  }

  function setStatus(message, isError = false) {
    const msg = message || '';
    if (!statusEl) {
      // Don’t silently eat errors; otherwise “nothing happens” when IPC fails.
      try {
        (isError ? console.error : console.log)(`[SubtitleEditor] ${msg}`);
      } catch {}
      // Still reflect into the start screen if present.
      if (startStatusEl) {
        startStatusEl.textContent = msg;
        startStatusEl.classList.toggle('text-error', !!isError);
      }
      return;
    }
    statusEl.textContent = msg;
    statusEl.classList.toggle('text-error', !!isError);

    // Mirror status into the start screen (it may be the only visible UI).
    if (startStatusEl) {
      startStatusEl.textContent = msg;
      startStatusEl.classList.toggle('text-error', !!isError);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Start screen (two-box file chooser)
  // ─────────────────────────────────────────────────────────────
  const __SUBTITLE_EXTS = ['.json', '.srt', '.vtt', '.scc', '.mcc'];
  const __VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'];

  function _extLower(p) {
    const s = String(p || '').trim();
    const m = s.toLowerCase().match(/\.[a-z0-9]+$/i);
    return m ? m[0] : '';
  }

  function _safeBasename(p) {
    const s = String(p || '').trim();
    if (!s) return '';
    try {
      return window.electron?.basename?.(s) || s.split(/[\\/]/).pop() || s;
    } catch {
      return s;
    }
  }

  function _isSubtitlePath(p) {
    const ext = _extLower(p);
    return __SUBTITLE_EXTS.includes(ext);
  }

  function _isVideoPath(p) {
    const ext = _extLower(p);
    return __VIDEO_EXTS.includes(ext);
  }

  function _refreshStartScreenUi() {
    if (!startScreenEl) return;

    const sourcePath = state?.pendingSourcePath ? String(state.pendingSourcePath) : '';

    const mediaPath = state?.doc?.mediaPath ? String(state.doc.mediaPath) : '';
    if (startMediaFileEl) startMediaFileEl.textContent = mediaPath ? _safeBasename(mediaPath) : '';
    if (startDropMediaEl) startDropMediaEl.classList.toggle('has-file', !!mediaPath);

    if (startSubFileEl) startSubFileEl.textContent = sourcePath ? _safeBasename(sourcePath) : '';
    if (startDropSubEl) startDropSubEl.classList.toggle('has-file', !!sourcePath);

    // Launch requires a subtitle; media is optional (preview only).
    // While loading/converting via IPC, keep Launch disabled to avoid double invokes.
    const busy = !!state?.startBusy;
    const canLaunch = !!sourcePath && !busy;
    if (startLaunchBtn) startLaunchBtn.disabled = !canLaunch;
  }

  function showStartScreen() {
    try { _refreshStartScreenUi(); } catch {}
    try { refreshDebuttUiForDoc(null); } catch {}
    overlay?.classList?.add('is-chooser');
    if (startScreenEl) startScreenEl.setAttribute('aria-hidden', 'false');
  }

  function hideStartScreen() {
    overlay?.classList?.remove('is-chooser');
    if (startScreenEl) startScreenEl.setAttribute('aria-hidden', 'true');
    // In chooser mode the toolbar is display:none; any sizing pass would measure 0px.
    // Re-run sizing now that the editor chrome is visible.
    try { scheduleToolbarActionSizing(); } catch {}
    try { overlay?.__subtitleEditorRefreshSplitPanels?.(); } catch {}
  }

  async function _approvePaths(paths, opts = {}) {
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [paths].filter(Boolean);
    if (!list.length) return [];
    if (typeof ipc?.invoke !== 'function') return list;
    try {
      // For drag/drop flows we treat the gesture as implicit approval and skip the extra confirm prompt.
      const confirm = opts.confirm === true ? true : false;
      return await ipc.invoke('approve-paths', list, { confirm, kindHint: 'file' });
    } catch {
      return list;
    }
  }

  async function setSubtitlePathForStart(sourcePath, opts = {}) {
    const p = String(sourcePath || '').trim();
    if (!p) return null;

    if (!_isSubtitlePath(p)) {
      setStatus(tr('subtitleEditor.status.unsupportedSubtitleFile', 'Not a supported subtitle file: {{file}}', { file: _safeBasename(p) }), true);
      return null;
    }

    if (opts.fromDrop) {
      await _approvePaths([p], { confirm: false });
    }

    state.pendingSourcePath = p;
    try { _refreshStartScreenUi(); } catch {}
    setStatus(tr('subtitleEditor.status.selectedSubtitle', 'Selected subtitle: {{file}}', { file: _safeBasename(p) }));
    return p;
  }

  async function pickSubtitleForStart() {
    if (typeof ipc?.invoke !== 'function') {
      setStatus(tr('subtitleEditor.status.filePickerUnavailable', 'File picker unavailable in this build.'), true);
      return null;
    }

    const picked = await ipc.invoke('open-file-dialog', {
      title: tr('subtitleEditor.dialog.openSubtitleTitle', 'Open subtitle'),
      filters: [
        { name: 'Subtitles', extensions: ['json', 'srt', 'vtt', 'scc', 'mcc'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!picked) return null;
    return await setSubtitlePathForStart(picked, { fromDrop: false });
  }

  async function launchStartSelection() {
    if (state?.startBusy) return;
    const sourcePath = state?.pendingSourcePath ? String(state.pendingSourcePath) : '';

    if (!sourcePath) {
      setStatus(tr('subtitleEditor.status.chooseSubtitleThenLaunch', 'Choose a subtitle file, then click Launch. (Video is optional.)'), true);
      try { _refreshStartScreenUi(); } catch {}
      return;
    }

    await loadSubtitleFromPath(sourcePath, { fromDrop: false });
  }

  async function setMediaPath(mediaPath, opts = {}) {
    const p = String(mediaPath || '').trim();
    if (!p) return null;

    if (opts.fromDrop) {
      await _approvePaths([p], { confirm: false });
    }

    state.doc = state.doc || {};
    state.doc.mediaPath = p;
    try { _refreshStartScreenUi(); } catch {}
    setStatus(tr('subtitleEditor.status.selectedMedia', 'Selected media: {{file}}', { file: _safeBasename(p) }));
    return p;
  }

  async function pickMediaForStart() {
    // Electron path (preferred; also approves the picked path).
    if (typeof ipc?.invoke === 'function') {
      const file = await ipc.invoke('open-file-dialog', {
        title: tr('subtitleEditor.dialog.selectVideoPreviewTitle', 'Select video for preview'),
        filters: [{ name: 'Video', extensions: ['mp4','mov','m4v','mkv','webm'] }]
      });
      if (!file) return null;
      return await setMediaPath(file, { fromDrop: false });
    }

    // Browser fallback: will load into the player immediately.
    await promptForMedia();
    try { _refreshStartScreenUi(); } catch {}
    return state.doc?.mediaPath || null;
  }

  async function loadSubtitleFromPath(sourcePath, opts = {}) {
    const p = String(sourcePath || '').trim();
    if (!p) return;

    if (state?.startBusy) return;
    state.startBusy = true;
    try { _refreshStartScreenUi(); } catch {}

    if (!_isSubtitlePath(p)) {
      setStatus(tr('subtitleEditor.status.unsupportedSubtitleFile', 'Not a supported subtitle file: {{file}}', { file: _safeBasename(p) }), true);
      return;
    }

    const mediaPath = state.doc?.mediaPath ? String(state.doc.mediaPath) : null;

    // Approve dropped paths so the subtitle-editor-open IPC guard accepts them.
    if (opts.fromDrop) {
      await _approvePaths([p, mediaPath].filter(Boolean), { confirm: false });
    }

    if (typeof ipc?.invoke !== 'function') {
      setStatus(tr('subtitleEditor.status.fileLoadingUnavailable', 'File loading unavailable in this build.'), true);
      return;
    }

    try {
      setStatus(tr('subtitleEditor.status.loadingSubtitle', 'Loading subtitle…'));
      const response = await ipc.invoke('subtitle-editor-open', {
        sourcePath: p,
        mediaPath: mediaPath || undefined,
        sessionId: state.doc?.sessionId || undefined
      });

      if (!response || response.error) {
        setStatus(response?.error || tr('subtitleEditor.status.loadSubtitleFailed', 'Failed to load subtitle.'), true);
        return;
      }

      state.doc = { ...response };
      resetUndoHistory();
      state.lastExport = response.lastExport || null;
      state.activeCue = 0;
      state.pendingSourcePath = null;

      await populateDoc(state.doc);
      hideStartScreen();
      setStatusForDoc(state.doc, 'Loaded subtitle.');
    } catch (err) {
      setStatus(tr('subtitleEditor.status.loadSubtitleError', 'Failed to load subtitle: {{error}}', { error: err.message }), true);
    } finally {
      state.startBusy = false;
      // If we're still on the start screen (load failed), re-enable Launch.
      try { _refreshStartScreenUi(); } catch {}
    }
  }

  function _getImportIssues(doc) {
    const importErrors = Array.isArray(doc?.importErrors) ? doc.importErrors : [];
    const importWarningsAll = Array.isArray(doc?.importWarnings) ? doc.importWarnings : [];
    const modelIssues = Array.isArray(doc?.modelIssues) ? doc.modelIssues : [];

    const importWarnings = importWarningsAll.filter((w) => {
      const s = String(w || '');
      return !(s.startsWith('Model issue:') || s.startsWith('Model overflow:'));
    });

    return { importErrors, importWarnings, modelIssues };
  }

  function renderImportIssues(doc) {
    if (!importIssuesEl || !importIssuesSummaryEl || !importIssuesBodyEl) return;
    const { importErrors, importWarnings, modelIssues } = _getImportIssues(doc);
    const total = importErrors.length + importWarnings.length + modelIssues.length;

    if (!total) {
      importIssuesEl.classList.add('hidden');
      importIssuesSummaryEl.textContent = '';
      importIssuesBodyEl.textContent = '';
      importIssuesEl.open = false;
      return;
    }

    importIssuesEl.classList.remove('hidden');
    importIssuesSummaryEl.textContent =
      `Import issues: ${total} (errors ${importErrors.length}, warnings ${importWarnings.length}, model ${modelIssues.length})`;

    importIssuesBodyEl.textContent = '';
    const list = document.createElement('ul');
    list.className = 'import-issues-list';

    const addItem = (text, kind) => {
      const li = document.createElement('li');
      li.className = `import-issue import-issue-${kind}`;
      li.textContent = text;
      list.appendChild(li);
    };

    for (const e of importErrors) addItem(String(e), 'error');
    for (const w of importWarnings) addItem(String(w), 'warn');
    for (const mi of modelIssues) {
      const label = mi && typeof mi === 'object'
        ? `${mi.code ? `${mi.code}: ` : ''}${mi.message || ''}`.trim()
        : String(mi);
      addItem(label || 'Model issue', mi?.severity === 'error' ? 'error' : 'model');
    }

    importIssuesBodyEl.appendChild(list);
    if (importErrors.length) importIssuesEl.open = true;
  }

  function getImportIssuesCount(doc) {
    const { importErrors, importWarnings, modelIssues } = _getImportIssues(doc);
    return importErrors.length + importWarnings.length + modelIssues.length;
  }

  function setStatusForDoc(doc, loadedMessage) {
    const statusBits = [];
    const mediaHint = (!doc?.mediaPath)
      ? 'ℹ️ No media selected. Use “Open Media…” to load a preview.'
      : '';
    if (doc?.format === 'scc' && doc?.dropFrame === false) {
      statusBits.push(
        '⚠️ This SCC is NDF (":" timecodes). Many broadcasters/QC pipelines reject NDF. Export may be rejected unless your spec allows it.'
      );
    }
    const importIssueCount = getImportIssuesCount(doc);
    if (importIssueCount) {
      statusBits.push(`⚠️ Imported with ${importIssueCount} issue(s). See Import issues below.`);
    }

    if (statusBits.length) {
      if (mediaHint) statusBits.push(mediaHint);
      setStatus(statusBits.join(' '), true);
      return;
    }

    if (loadedMessage) {
      setStatus(mediaHint ? `${loadedMessage} ${mediaHint}` : loadedMessage);
      return;
    }

    if (mediaHint) setStatus(mediaHint);
  }

  function hideEditor() {
    // Option B: in the standalone subtitle-editor window, “Close” should close the
    // window (not hide a now-empty overlay).
    if (isPopout) {
      try {
        window.close();
        return;
      } catch {}
    }
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    // P0-1: don't let a pending seek carry over across open/close.
    try { _clearPendingSeek(); } catch {}
    try {
      if (videoEl && !videoEl.paused) {
        videoEl.pause();
      }
      if (videoEl608 && !videoEl608.paused) {
        videoEl608.pause();
      }
    } catch {}
  }

  function showEditor() {
    overlay.classList.add('is-ready');
    overlay.classList.remove('hidden');
    overlay.removeAttribute('aria-hidden');
    overlay.focus({ preventScroll: true });

    // Now that the overlay is actually visible, re-run splitter sizing.
    // (This fixes the “preview opens tiny” bug caused by measuring while hidden/chooser.)
    try { requestAnimationFrame(() => overlay?.__subtitleEditorRefreshSplitPanels?.()); } catch {}
  }

  function injectEditorToolbarButtons() {
    const toolbar =
      overlay.querySelector('.toolbar .toolbar-actions-left') ||
      overlay.querySelector('.toolbar .toolbar-actions');
    if (!toolbar || toolbar.__subtitleButtonsInjected) return;
    toolbar.__subtitleButtonsInjected = true;

    const mkBtn = (id, label, handler) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.textContent = label;
      b.addEventListener('click', handler);
      return b;
    };

    const btnExportScc = mkBtn(
      'subtitle-editor-export-scc',
      tr('subtitleEditor.toolbar.exportScc', 'Export SCC'),
      async () => { try { await exportSccDoc(); } catch {} }
    );
    btnExportScc.classList.add('btn-scc-only');

    const btnExportMcc = mkBtn(
      'subtitle-editor-export-mcc',
      tr('subtitleEditor.toolbar.exportMcc', 'Export MCC'),
      async () => { try { await exportMccDoc(); } catch {} }
    );

    const btnGlyphs = mkBtn(
      'subtitle-editor-glyphs',
      tr('subtitleEditor.toolbar.glyphs', 'Glyphs'),
      async () => { try { openGlyphPicker(); } catch {} }
    );
    btnGlyphs.classList.add('btn-scc-only');

    const btnStartTc = mkBtn(
      'subtitle-editor-start-tc',
      tr('subtitleEditor.toolbar.startTc', 'Start TC'),
      () => { try { openStartTcModal(); } catch {} }
    );
    // Start TC affects any timecode-based export (SCC + MCC)

    const btnNormalizeFrames = mkBtn(
      'subtitle-editor-normalize-frames',
      tr('subtitleEditor.toolbar.normalizeFrames', 'Normalize frames'),
      () => { try { normalizeTimingsToFrames(); } catch {} }
    );
    btnNormalizeFrames.title = tr('subtitleEditor.toolbar.normalizeFramesTitle', 'Snap all cue timings (and 608 overrides) to exact SMPTE frame boundaries.');
    btnNormalizeFrames.classList.add('btn-smpte-only');

    const btnBurnIn = mkBtn(
      'subtitle-editor-burnin',
      tr('subtitleEditor.toolbar.burnIn', 'Burn‑in'),
      async () => { try { await burnInDoc(); } catch {} }
    );
    btnBurnIn.classList.add('btn-scc-only');

    const btnExportCorr = mkBtn(
      'subtitle-editor-export',
      tr('subtitleEditor.toolbar.exportCorrections', 'Export Corrections'),
      async () => { try { await exportDoc(); } catch {} }
    );
    btnExportCorr.classList.add('btn-nonscc-only');

    // Insert buttons in a stable, user-facing order.
    // Open Subtitle / Open Media already exist in the static HTML.
    // We insert our dynamic action buttons after “Open Media…” (before the service selector).
    const openMediaBtn = toolbar.querySelector('#subtitle-editor-open-media');
    const openSubBtn = toolbar.querySelector('#subtitle-editor-open-sub');
    let cursor = openMediaBtn || openSubBtn || null;

    const insertAfter = (ref, node) => {
      if (!node) return ref;
      if (ref && ref.parentNode === toolbar) {
        try {
          ref.insertAdjacentElement('afterend', node);
          return node;
        } catch {}
      }
      try { toolbar.appendChild(node); } catch {}
      return node;
    };

    // Non‑SCC docs show Export Corrections; SCC shows SCC/MCC tools.
    cursor = insertAfter(cursor, btnExportCorr);
    cursor = insertAfter(cursor, btnExportScc);
    cursor = insertAfter(cursor, btnExportMcc);
    cursor = insertAfter(cursor, btnStartTc);
    cursor = insertAfter(cursor, btnNormalizeFrames);
    cursor = insertAfter(cursor, btnGlyphs);
    insertAfter(cursor, btnBurnIn);

    // Keep SCC ergonomics consistent: all action buttons (except Close) should
    // be the same size as “Normalize frames”.
    try { scheduleToolbarActionSizing(); } catch {}
  }

  // SCC toolbar ergonomics:
  // - Make all left-side action buttons uniform width/height.
  // - Use “Normalize frames” as the reference size (fallback: widest visible button).
  function scheduleToolbarActionSizing() {
    const overlay = document.getElementById('subtitle-editor-overlay');
    if (!overlay) return;

    // Only enforce uniform action sizing for SCC.
    if (!overlay.classList.contains('doc-scc')) {
      overlay.style.removeProperty('--subtitle-editor-toolbar-btn-w');
      overlay.style.removeProperty('--subtitle-editor-toolbar-btn-h');
      return;
    }

    // Clear any stale sizing so we measure natural widths.
    overlay.style.removeProperty('--subtitle-editor-toolbar-btn-w');
    overlay.style.removeProperty('--subtitle-editor-toolbar-btn-h');

    const measureAndApply = () => {
      const left =
        overlay.querySelector('.toolbar .toolbar-actions-left') ||
        overlay.querySelector('.toolbar .toolbar-actions');
      if (!left) return false;

      const buttons = Array.from(left.querySelectorAll('button'))
        .filter(b => b && b.id !== 'subtitle-editor-close')
        // Only measure visible buttons.
        .filter(b => b.offsetParent !== null);
      if (!buttons.length) return false;

      let refW = 0;
      let refH = 0;

      const ref = overlay.querySelector('#subtitle-editor-normalize-frames');
      if (ref && ref.offsetParent !== null) {
        const r = ref.getBoundingClientRect();
        refW = r.width;
        refH = r.height;
      }

      if (!refW) {
        for (const b of buttons) {
          const r = b.getBoundingClientRect();
          refW = Math.max(refW, r.width);
          refH = Math.max(refH, r.height);
        }
      }

      if (refW) overlay.style.setProperty('--subtitle-editor-toolbar-btn-w', `${Math.ceil(refW)}px`);
      if (refH) overlay.style.setProperty('--subtitle-editor-toolbar-btn-h', `${Math.ceil(refH)}px`);
      return !!refW;
    };

    // Try immediately (avoids one-frame “uneven” buttons on first show), then
    // again on next frame in case fonts/layout weren't ready.
    const ok = measureAndApply();
    if (ok) return;
    try { requestAnimationFrame(() => { measureAndApply(); }); } catch {}
  }

  async function pickSubtitleAndLoad() {
    if (typeof ipc?.invoke !== 'function') {
      setStatus(tr('subtitleEditor.status.filePickerUnavailable', 'File picker unavailable in this build.'), true);
      return;
    }
    const picked = await ipc.invoke('open-file-dialog', {
      title: tr('subtitleEditor.dialog.openSubtitleTitle', 'Open subtitle'),
      filters: [
        { name: 'Subtitles', extensions: ['json', 'srt', 'vtt', 'scc', 'mcc'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!picked) return;

    await loadSubtitleFromPath(picked, { fromDrop: false });
  }

  async function pickMediaAndLoad() {
    await promptForMedia();
  }

  async function promptForMedia() {
    // Electron path
    if (typeof ipc?.invoke === 'function') {
      const file = await ipc.invoke('open-file-dialog', {
        title: tr('subtitleEditor.dialog.selectVideoPreviewTitle', 'Select video for preview'),
        filters: [{ name: 'Video', extensions: ['mp4','mov','m4v','mkv','webm'] }]
      });
      if (file) {
        state.doc = state.doc || {};
        state.doc.mediaPath = file;
        await loadMediaIntoPlayer(file);
        return;
      }
    }
    // Browser fallback
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [h] = await window.showOpenFilePicker({
          types: [{ description: 'Video', accept: { 'video/*': ['.mp4','.mov','.m4v','.mkv','.webm'] } }]
        });
        const f = await h.getFile();
        const url = URL.createObjectURL(f);
        if (videoEl) {
          videoEl.src = url;
          videoEl.load();
          bindVideoAspectToFrame(videoEl, previewHostEl708 || previewHostEl || videoEl?.parentElement);
        }
        if (videoEl608) {
          try { videoEl608.muted = true; videoEl608.volume = 0; } catch {}
          videoEl608.src = url;
          videoEl608.load();
          bindVideoAspectToFrame(videoEl608, previewHostEl608 || videoEl608?.parentElement);
        }
        setStatus(tr('subtitleEditor.status.loadedMediaBrowserPicker', 'Loaded media (browser file picker).'));
        return;
      } catch {}
    }
    setStatus(tr('subtitleEditor.status.filePickerUnavailable', 'File picker unavailable in this build.'), true);
  }

  function _toFileURL(p) {
    const raw = String(p || '').trim();
    if (!raw) return '';
    // If it already looks like a URL (file/http/blob/data), keep it as-is.
    if (/^(file|https?|blob|data):/i.test(raw)) return raw;

    const norm = raw.replace(/\\/g, '/');

    // Prefer an Electron-provided helper if available (it should handle Windows quirks).
    try {
      const u = window.electron?.pathToFileURL?.(norm);
      if (u) return u;
    } catch {}

    // UNC paths: //server/share/path  →  file://server/share/path
    if (norm.startsWith('//')) return 'file:' + encodeURI(norm);

    // Windows drive letters: C:/path → file:///C:/path
    if (/^[A-Za-z]:\//.test(norm)) return 'file:///' + encodeURI(norm);

    // POSIX absolute: /Users/... → file:///Users/...
    if (norm.startsWith('/')) return 'file://' + encodeURI(norm);

    // Relative path (best-effort)
    return 'file://' + encodeURI(norm);
  }

  async function ensurePlayableUrl(file) {
    if (!file) return null;
    try {
      // ── Recursion guard: if it already looks like a preview, prefer to play it —
      // but if it was made with the old MPEG‑4 fallback, rebuild it now.
      const previewDir = window.electron.joinPath(window.electron.userDataPath, 'temp', 'previews');
      const fileNorm = String(file).replace(/\\/g, '/');
      const prevNorm = String(previewDir).replace(/\\/g, '/');
      const looksLikePreview = fileNorm.includes(`${prevNorm}/`) || /\.preview\.[^/\\]+$/i.test(fileNorm);
      if (looksLikePreview) {
        try {
          const info0 = await window.electron?.probeMedia?.(file);
          const v0 = (info0?.streams || []).find(s => s.codec_type === 'video');
          const badLegacy = v0 && /^(mpeg4|mp4v)/i.test(String(v0.codec_name || ''));
          if (!badLegacy) return _toFileURL(file);
          // fall through and rebuild a new preview from this legacy preview input
        } catch { /* fall through: try to rebuild */ }
      }

      const info = await window.electron?.probeMedia?.(file);
      const streams = info?.streams || [];
      const v = streams.find(s => s.codec_type === 'video');
      if (!v) {
        setStatus(tr('subtitleEditor.status.noVideoTrackAudioOnly', 'Selected file has no video track. You will hear audio only.'));
        return _toFileURL(file);
      }
      const codec = String(v.codec_name || '').toLowerCase();
      const pix   = String(v.pix_fmt || '').toLowerCase();

      // Browser capability sniff (Electron/Chromium build dependent)
      const canType = (mime) => {
        try {
          if (window.MediaSource && typeof window.MediaSource.isTypeSupported === 'function') {
            return !!window.MediaSource.isTypeSupported(mime);
          }
          const vid = document.createElement('video');
          return !!vid.canPlayType && vid.canPlayType(mime) !== '';
        } catch { return false; }
      };
      const canH264 = canType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
      const canVP9  = canType('video/webm; codecs="vp9, opus"');

      // If the original is already known-playable to the browser, use it.
      const browserPlayable = (
        (codec === 'h264' && canH264) ||
        (codec === 'vp9'  && canVP9)  ||
        (codec === 'vp8'  && canType('video/webm; codecs="vp8, vorbis"')) ||
        (codec === 'av1'  && canType('video/mp4; codecs="av01.0.05M.08"')) // conservative av1 tag
      ) && (!pix || /^(yuv420p|nv12|p010)$/.test(pix));
      if (browserPlayable) return _toFileURL(file);

      // Fallback: create (or reuse) a lightweight preview in userData/temp/previews
      // so Preferences → Maintenance → Clear Temp Files also removes preview proxies.
      // P0-2: cache proxies by a stable hash so we don't re-transcode every open,
      // and so files with the same basename in different folders don't collide.
      try {
        const electronApi = window.electron;
        if (typeof electronApi?.mkdirAsync === 'function') {
          await electronApi.mkdirAsync(previewDir);
        } else if (typeof electronApi?.mkdir === 'function') {
          // Legacy fallback (may emit deprecation warnings on newer main-process builds).
          electronApi.mkdir(previewDir);
        }
      } catch {}

      // Strip any trailing ".preview" to avoid file.preview.preview.mp4
      const baseRaw = window.electron.basename(file, window.electron.extname(file));
      const base    = baseRaw.replace(/(\.preview)+$/i, '');

      const previewVersion = 'previewProxyV2';

      const _statLite = async (p) => {
        try {
          if (window.electron && typeof window.electron.fsStat === 'function') {
            const st = await window.electron.fsStat(p);
            if (st && typeof st === 'object') {
              return { size: Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0 };
            }
          }
        } catch {}
        // Fallback: minimal IPC helper.
        try {
          if (typeof ipc?.invoke === 'function') {
            const st = await ipc.invoke('path-stat', p);
            if (st && (st.ok === true || typeof st.size === 'number')) {
              return { size: Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0 };
            }
          }
        } catch {}
        return null;
      };

      const _hash16 = async (s) => {
        const text = String(s ?? '');
        // Prefer SHA-256 when available.
        try {
          if (globalThis.crypto?.subtle?.digest && typeof TextEncoder === 'function') {
            const data = new TextEncoder().encode(text);
            const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
            const bytes = new Uint8Array(buf);
            let hex = '';
            for (let i = 0; i < bytes.length; i++) {
              hex += bytes[i].toString(16).padStart(2, '0');
            }
            return hex.slice(0, 16);
          }
        } catch {}
        // Deterministic fallback: FNV-1a 64-bit.
        try {
          let h = 14695981039346656037n;
          const prime = 1099511628211n;
          for (let i = 0; i < text.length; i++) {
            h ^= BigInt(text.charCodeAt(i));
            h = (h * prime) & 0xFFFFFFFFFFFFFFFFn;
          }
          return h.toString(16).padStart(16, '0').slice(0, 16);
        } catch {}
        // Last resort: 32-bit rolling hash (padded)
        let h = 0;
        for (let i = 0; i < text.length; i++) {
          h = ((h << 5) - h) + text.charCodeAt(i);
          h |= 0;
        }
        return (h >>> 0).toString(16).padStart(8, '0') + '00000000';
      };

      // Build cache key: normalized path (best-effort) + size + mtimeMs + version.
      let normPath = String(file);
      try {
        if (typeof ipc?.invoke === 'function') {
          const n = await ipc.invoke('normalize-path', file);
          if (typeof n === 'string' && n.trim()) normPath = n;
        }
      } catch {}

      const srcStat = await _statLite(file);
      const size = Number(srcStat?.size) || 0;
      const mtimeMs = Number(srcStat?.mtimeMs) || 0;
      const hash16 = await _hash16(`${previewVersion}|${normPath}|${size}|${mtimeMs}`);

      const outMp4 = window.electron.joinPath(previewDir, `${base}.${hash16}.preview.mp4`);
      const outWebm = window.electron.joinPath(previewDir, `${base}.${hash16}.preview.webm`);

      // Cache hit: return immediately (skip ffmpeg, skip encoder list).
      const cached = await (async () => {
        if (canH264) {
          const st = await _statLite(outMp4);
          if (st && Number(st.size) > 0) return outMp4;
        }
        if (canVP9) {
          const st = await _statLite(outWebm);
          if (st && Number(st.size) > 0) return outWebm;
        }
        return null;
      })();

      if (cached) {
        setStatus(tr('subtitleEditor.status.usingCachedPreview', 'Using cached preview: {{file}}', { file: window.electron.basename(cached) }));
        return _toFileURL(cached);
      }

      // Cache miss: transcode once.
      let out = outMp4;
      setStatus(tr('subtitleEditor.status.convertingPreview', 'Converting {{codec}} → browser‑playable preview…', { codec: codec || tr('subtitleEditor.common.video', 'video') }));
      // Prefer H.264 hardware encoders; stay libx264‑free (LGPL compliance).
      let videoEnc = null; let useWebM = false;
      try {
        const { stdout: encodersOut = '' } =
          await window.electron.execFFmpeg(['-hide_banner','-encoders']);
        const has = (name) => new RegExp(`(^|\\W)${name}(\\W|$)`).test(encodersOut);
        const hw = [
          'h264_videotoolbox', // macOS
          'h264_nvenc',        // NVIDIA
          'h264_qsv',          // Intel
          'h264_amf',          // AMD
          'h264_v4l2m2m',      // Linux SoCs
          'h264_omx'           // older ARM
        ].find(has);
        if (hw && canH264) {
          videoEnc = hw;
        } else if (has('libopenh264') && canH264) {
          videoEnc = 'libopenh264';
        } else if (has('libvpx-vp9') && canVP9) {
          useWebM = true;
        }
      } catch {}

      // Destination container + audio codec
      let vArgs = [];
      let aArgs = [];
      if (videoEnc) {
        // H.264 path (hardware or libopenh264)
        out = outMp4;
        vArgs = ['-c:v', videoEnc, '-b:v','6M','-maxrate','6M','-bufsize','12M'];
        aArgs = ['-c:a','aac','-b:a','160k','-movflags','+faststart'];
      } else if (useWebM) {
        out = outWebm;
        vArgs = ['-c:v','libvpx-vp9','-b:v','2M','-row-mt','1','-deadline','good'];
        aArgs = ['-c:a','libopus','-b:a','128k'];
      } else {
        // As a last resort, don’t make something unplayable — hand back original with a warning.
        setStatus(tr('subtitleEditor.status.noDecoderNoEncoder', 'Browser can’t decode this media and no compatible encoder was found. Showing original; use “Open Media…” for a different file.'), true);
        return _toFileURL(file);
      }

      const args = [
        '-y','-i', file,
        '-map','0:v:0?','-map','0:a:0?',
        ...vArgs,
        '-pix_fmt','yuv420p',
        '-vf','scale=-2:1080',
        ...aArgs,
        out
      ];
      await window.electron.execFFmpeg(args);
      setStatus(tr('subtitleEditor.status.usingPreview', 'Using preview: {{file}}', { file: window.electron.basename(out) }));
      return _toFileURL(out);
    } catch (err) {
      const structured = err?.structured || err;
      const userMessage = err?.message || tr('subtitleEditor.status.previewFailedFallback', 'Unable to build preview');
      console.error('[SubtitleEditor][FFmpeg preview error]', {
        message: userMessage,
        code: structured?.code,
        exitCode: structured?.exitCode,
        signal: structured?.signal,
        timeoutMs: structured?.timeoutMs,
        stderrTail: structured?.stderrTail,
        stdoutTail: structured?.stdoutTail
      });
      setStatus(tr('subtitleEditor.status.previewFailed', 'Preview failed: {{error}}', { error: userMessage }));
      return _toFileURL(file);
    }
  }

  async function loadMediaIntoPlayer(file) {
    const url = await ensurePlayableUrl(file);
    if (!url) return;
    if (videoEl) {
      videoEl.src = url;
      videoEl.load();
      // Ensure the frame reflects the real video aspect so overlays/captions align.
      bindVideoAspectToFrame(videoEl, previewHostEl708 || previewHostEl || videoEl?.parentElement);
    }

    // Keep the derived 608 preview video in sync (muted, no controls).
    if (videoEl608) {
      try {
        videoEl608.muted = true;
        videoEl608.volume = 0;
      } catch {}
      videoEl608.src = url;
      videoEl608.load();
      bindVideoAspectToFrame(videoEl608, previewHostEl608 || videoEl608?.parentElement);
    }
  }

  function installEditorSafeOverlay() {
    const root = overlay || document.querySelector('.subtitle-editor');
    if (!root) return;
    const statusRow = root.querySelector('.status-row') || (() => {
      const s = document.createElement('div');
      s.className = 'status-row';
      root.appendChild(s);
      return s;
    })();

    // Row/indent inspector lives inside the shared status strip (separate from the status message).
    // Keep it resilient in case the HTML skeleton changes.
    const inspectorEl = root.querySelector('#row-indent-inspector') || (() => {
      const el = document.createElement('span');
      el.id = 'row-indent-inspector';
      el.setAttribute('aria-hidden', 'true');
      el.style.display = 'none';
      statusRow.appendChild(el);
      return el;
    })();

    const pane708 = root.querySelector('[data-preview-track="708"]');
    const pane608 = root.querySelector('[data-preview-track="608"]');

    const video708 = pane708?.querySelector('video') || null;
    const host708 = pane708?.querySelector('.preview-video-host') || video708?.parentElement || null;

    const video608 = pane608?.querySelector('video') || null;
    const host608 = pane608?.querySelector('.preview-video-host') || video608?.parentElement || null;

    previewHostEl708 = host708;
    previewHostEl608 = host608;
    previewHostEl = host708 || host608 || root.querySelector('.preview') || root;

    // Ensure preview host boxes stay proportional when the preview row is short.
    // (Otherwise the <video> scales correctly but the host frame/grid get squashed.)
    try { installPreviewHostFitter(root); } catch {}

    const ensureRel = (el) => {
      if (!el) return;
      const cs = getComputedStyle(el);
      if (cs.position === 'static') el.style.position = 'relative';
    };

    const attach = (slotName, host, video) => {
      if (!host) return null;
      ensureRel(host);
      try { bindVideoAspectToFrame(video, host); } catch {}
      if (!window[slotName]) {
        window[slotName] = createEditorSafeController({ root, preview: host, statusRow, inspectorEl, video, track: (slotName === '__editorSafe708' ? '708' : '608') });
      } else {
        window[slotName].setHost?.(host, video);
      }
      window[slotName].rebuild();
      window[slotName].refreshInspector();
      return window[slotName];
    };

    const ctrl708 = attach('__editorSafe708', host708, video708);
    const ctrl608 = attach('__editorSafe608', host608, video608);

    // Web caption preview (SRT/VTT): attach a dedicated layer directly to the primary preview host.
    // This must NOT be a child of the safe-title overlay; web captions should remain independent
    // from SCC/MCC grids and broadcast geometry.
    const webHost = host708 || host608 || previewHostEl;
    if (webHost) {
      ensureRel(webHost);
      if (!window.__editorWeb) {
        window.__editorWeb = createWebCaptionPreviewController({ host: webHost });
      } else {
        window.__editorWeb.setHost?.(webHost);
      }
    }

    // Backward compat: legacy call sites expect window.__editorSafe to refer
    // to the *primary* (left) preview pane.
    window.__editorSafe = ctrl708 || ctrl608 || window.__editorSafe;

    if (!root.__editorSafeOnEdit) {
      root.__editorSafeOnEdit = (e) => {
        if (e.target && e.target.closest && e.target.closest('.cue')) {
          window.__editorSafe708?.refreshInspector?.();
          window.__editorSafe608?.refreshInspector?.();
          window.__editorSafe?.refreshInspector?.();
        }
      };
      root.addEventListener('input', root.__editorSafeOnEdit);
      root.addEventListener('click', root.__editorSafeOnEdit);
    }

    if (!window.__editorSafeResize) {
      window.__editorSafeResize = () => {
        window.__editorSafe708?.rebuild?.();
        window.__editorSafe608?.rebuild?.();
        window.__editorSafe?.rebuild?.();

        // Captions are positioned in pixels based on the preview host geometry.
        // A resize changes that geometry; rebuild() updates guides/grid, but we must
        // re-render the active cue so the caption text stays locked to the frame.
        try { renderActiveCue608(); } catch {}
      };
      window.addEventListener('resize', window.__editorSafeResize);
    }

    const watch = (host, video, slotName) => {
      if (!host || typeof ResizeObserver !== 'function') return;
      if (host.__editorSafeRO) return;
      host.__editorSafeRO = new ResizeObserver(() => {
        window[slotName]?.rebuild?.();
        // Same as above: keep caption layers aligned during host resizes.
        try { renderActiveCue608(); } catch {}
      });
      host.__editorSafeRO.observe(video || host);
    };
    watch(host708, video708, '__editorSafe708');
    watch(host608, video608, '__editorSafe608');
  }


  // ─────────────────────────────────────────────────────────────
  // Web caption preview controller (SRT/VTT)
  // Renders SRT/VTT cues in a dedicated layer attached directly to the preview host.
  // This must stay independent from the broadcast safe-title overlay.
  // ─────────────────────────────────────────────────────────────
  function createWebCaptionPreviewController(ctx) {
    let host = ctx?.host || null;
    let layer = null;
    let guidesEl = null;
    let enabled = true;
    let guidesVisible = true;
    try {
      const raw = String(localStorage.getItem('subtitle-editor-web-guides') || '1').trim();
      guidesVisible = raw !== '0';
    } catch {}

    let measureEl = null;
    function ensureLayer() {
      if (!host) return null;
      // Be robust even if the host CSS changes.
      try {
        const cs = getComputedStyle(host);
        if (cs.position === 'static') host.style.position = 'relative';
      } catch {}

      // If the host changed, drop the old layer and remount.
      if (!layer || layer.parentElement !== host) {
        try { layer?.parentElement?.removeChild?.(layer); } catch {}
        layer = document.createElement('div');
        layer.className = 'ccweb-layer ccweb-layer-editor';
        host.appendChild(layer);
      }

      layer.style.display = enabled ? 'flex' : 'none';
      return layer;
    }

    function ensureGuides() {
      if (!host) return null;
      // Be robust even if the host CSS changes.
      try {
        const cs = getComputedStyle(host);
        if (cs.position === 'static') host.style.position = 'relative';
      } catch {}

      // If the host changed, drop the old guides and remount.
      if (!guidesEl || guidesEl.parentElement !== host) {
        try { guidesEl?.parentElement?.removeChild?.(guidesEl); } catch {}
        guidesEl = document.createElement('div');
        guidesEl.className = 'web-safe-guides web-safe-guides-editor';

        const action = document.createElement('div');
        action.className = 'web-safe-guide action-safe';
        const title = document.createElement('div');
        title.className = 'web-safe-guide title-safe';

        guidesEl.appendChild(action);
        guidesEl.appendChild(title);
        host.appendChild(guidesEl);
      }

      guidesEl.style.display = (enabled && guidesVisible) ? 'block' : 'none';
      return guidesEl;
    }

    function ensureMeasureEl() {
      const l = ensureLayer();
      if (!l) return null;

      if (!measureEl || measureEl.parentElement !== l) {
        try { measureEl?.parentElement?.removeChild?.(measureEl); } catch {}
        measureEl = document.createElement('div');
        measureEl.className = 'ccweb-cue ccweb-cue-measure';

        // Keep it out of layout/interaction, but measurable.
        measureEl.style.position = 'absolute';
        measureEl.style.left = '-10000px';
        measureEl.style.top = '-10000px';
        measureEl.style.visibility = 'hidden';
        measureEl.style.pointerEvents = 'none';
        measureEl.style.whiteSpace = 'pre';
        measureEl.style.maxWidth = 'none';

        // Ensure measurement isn't affected by background/padding overrides.
        measureEl.style.background = 'transparent';
        measureEl.style.padding = '0';
        measureEl.style.borderRadius = '0';

        l.appendChild(measureEl);
      }

      return measureEl;
    }

    function _pickActiveVideoRect() {
      if (!host) return null;

      // Prefer the actual <video> box so pillarbox/letterbox doesn't distort sizing.
      try {
        const v = host.querySelector?.('video');
        if (v?.getBoundingClientRect) {
          const r = v.getBoundingClientRect();
          if (r && r.width > 0 && r.height > 0) return r;
        }
      } catch {}

      try {
        const r = host.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0) return r;
      } catch {}

      return null;
    }

    function _applyWebFontSizing(opts = null) {
      const l = ensureLayer();
      if (!l) return;

      const rect = _pickActiveVideoRect();
      if (!rect) {
        try { l.style.removeProperty('--ccweb-editor-font-size'); } catch {}
        return;
      }

      // WebVTT rendering model: default font size is 5vh (5% of viewport height).
      // In-editor we bind that to the *active video* height so sizing is stable and professional.
      let fontPx = rect.height * 0.05;

      // Netflix timed text guidance: keep font size such that ~42 characters can fit across screen.
      // We enforce this by measuring a 42-character test line and scaling down if needed.
      const maxCharsRaw = Number(opts?.maxChars);
      const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(1, Math.trunc(maxCharsRaw)) : 42;
      const fitChars = Math.max(1, Math.min(42, maxChars));

      const meas = ensureMeasureEl();
      if (meas && rect.width > 0 && fontPx > 0) {
        meas.style.fontSize = `${fontPx}px`;
        meas.textContent = 'X'.repeat(fitChars);
        const w = meas.getBoundingClientRect?.().width || 0;

        if (w > rect.width && w > 0) {
          fontPx = fontPx * (rect.width / w);
        }
      }

      if (Number.isFinite(fontPx) && fontPx > 0) {
        l.style.setProperty('--ccweb-editor-font-size', `${fontPx}px`);
      } else {
        try { l.style.removeProperty('--ccweb-editor-font-size'); } catch {}
      }
    }

    function clear() {
      const l = ensureLayer();
      if (!l) return;
      while (l.firstChild) l.removeChild(l.firstChild);
      measureEl = null;
      if (!enabled) l.style.display = 'none';
    }

    function setGuidesVisible(on = false) {
      guidesVisible = !!on;
      try { ensureGuides(); } catch {}
    }

    function enable(v = true) {
      enabled = !!v;
      const l = ensureLayer();
      try { ensureGuides(); } catch {}
      if (!l) return;
      if (!enabled) {
        while (l.firstChild) l.removeChild(l.firstChild);
        measureEl = null;
        l.style.display = 'none';
      } else {
        // Keep flex layout so cues land in the bottom safe-area.
        l.style.display = 'flex';
        _applyWebFontSizing();
      }
    }

    function setHost(newHost) {
      const nextHost = newHost || host;
      const hostChanged = !!(nextHost && host && nextHost !== host);
      host = nextHost;

      // If the host moved (single/dual preview swaps), allow ensureLayer/ensureGuides
      // to remove old DOM nodes cleanly.
      if (hostChanged) {
        measureEl = null;
      }

      try { ensureGuides(); } catch {}
      ensureLayer();
      _applyWebFontSizing();
    }

    function _wrapWebLineByWords(line, maxChars) {
      const out = [];
      const words = String(line || '').trim().split(/\s+/).filter(Boolean);
      let cur = '';

      for (const w of words) {
        const word = String(w || '');
        if (!word) continue;

        if (!cur) {
          if (word.length <= maxChars) {
            cur = word;
          } else {
            for (let i = 0; i < word.length; i += maxChars) {
              out.push(word.slice(i, i + maxChars));
            }
            cur = '';
          }
          continue;
        }

        if ((cur.length + 1 + word.length) <= maxChars) {
          cur = `${cur} ${word}`;
          continue;
        }

        out.push(cur);

        if (word.length <= maxChars) {
          cur = word;
        } else {
          for (let i = 0; i < word.length; i += maxChars) {
            out.push(word.slice(i, i + maxChars));
          }
          cur = '';
        }
      }

      if (cur) out.push(cur);
      return out;
    }

    function _shapeWebCaptionText(text, maxChars, _maxLinesUnused) {
      const raw = String(text || '')
        .replace(/\r/g, '')
        .replace(/\\n/g, '\n');

      const inputLines = raw.split(/\n/);
      const wrapped = [];

      for (const l of inputLines) {
        const line = String(l ?? '');
        // Preserve explicit blank lines (rare, but valid in plain-text cues).
        if (line === '') {
          wrapped.push('');
          continue;
        }

        const pieces = _wrapWebLineByWords(line, maxChars);
        if (!pieces.length) {
          wrapped.push('');
          continue;
        }
        for (const p of pieces) wrapped.push(p);
      }

      // IMPORTANT: never truncate or rewrite caption content for preview.
      // If a cue violates max-lines/max-chars, QC should flag it; preview must
      // still render the full caption text.
      return wrapped;
    }

    function renderCue(cue, doc, opts = null) {
      const l = ensureLayer();
      if (!l) return;

      // Always clear previous cue to prevent ghost captions.
      while (l.firstChild) l.removeChild(l.firstChild);

      if (!enabled || !cue) {
        l.style.display = 'none';
        return;
      }

      const hint = isSrtDoc(doc) ? 'srt' : (isVttDoc(doc) ? 'vtt' : null);

      // Prefer the opened document's own shaping values. Local defaults are only a fallback.
      const maxLinesRaw = Number(opts?.maxLines);
      let maxLines = Number.isFinite(maxLinesRaw)
        ? Math.max(1, Math.trunc(maxLinesRaw))
        : (
            _readMaxLinesPerBlock(doc, hint) ??
            _readAssistMaxLinesPerBlock(hint) ??
            2
          );

      const maxCharsRaw = Number(opts?.maxChars);
      let maxChars = Number.isFinite(maxCharsRaw)
        ? Math.max(1, Math.trunc(maxCharsRaw))
        : (
            _readMaxCharsPerLine(doc, hint) ??
            _readAssistMaxCharsPerLine(hint) ??
            42
          );

      // Guardrails (preview only): avoid pathological values.
      maxLines = Math.max(1, Math.min(15, maxLines));
      maxChars = Math.max(1, Math.min(200, maxChars));

      _applyWebFontSizing({ maxChars });

      const baseText = _cueTextFromCue(cue);
      const shaped = _shapeWebCaptionText(baseText, maxChars, maxLines);

      if (!shaped.length) {
        l.style.display = 'none';
        return;
      }

      const el = document.createElement('div');
      el.className = 'ccweb-cue';
      el.textContent = shaped.join('\n');

      l.style.display = 'flex';
      l.appendChild(el);
    }

    return {
      setHost,
      enable,
      clear,
      setGuidesVisible,
      renderCue
    };
  }

  function createEditorSafeController(ctx) {
    let { preview, inspectorEl, root, video } = ctx;
    inspectorEl = inspectorEl || root?.querySelector?.('#row-indent-inspector') || null;
    // IMPORTANT: The *primary* preview pane is re-used for both:
    //  - 708 authoring (dual preview: left pane is 708)
    //  - 608-only docs like SCC/VTT/SRT (single preview: left pane is 608)
    //
    // So `track` must be switchable at runtime; otherwise SCC ends up using the
    // 708 geometry (42 cols / title-safe) while we render 608 (32 cols / 4:3),
    // which breaks spacing + click-to-place.
    let track = String(ctx?.track || '608');
    let overlayEl = null;
    let captionLayer = null; // 608 render layer
    let captionLayer708 = null;
    let enabled = true;
    let showInspector = true;
    let lastSize = { w: 0, h: 0 };
    let placementEnabled = false;
    let guidesVisible = true;
    let pendingLineIndex = 0;
    // 708 click-to-place mode:
    //  - zones: 3×3 ASS-style zones (\an1..\an9)
    //  - exact: 42×15 grid → explicit 708 window anchors (relative %)
    let placementMode708 = 'zones';

    // 608 click-to-place targeting:
    //  - block: move all visible 608 rows together (most common SCC workflow)
    //  - line1: move the top visible row only
    //  - line2: move the bottom visible row only
    let placementTarget608 = 'block';
    let lastActiveCue = -1;

    function _normalize708PlacementMode(v) {
      const s = String(v || '').trim().toLowerCase();
      if (s === 'exact' || s === 'grid' || s === 'coords') return 'exact';
      return 'zones';
    }

    function _normalizePreviewTrack(v) {
      const s = String(v || '').trim().toLowerCase();
      if (s === '708' || s === 'cea708' || s === 'dtvcc') return '708';
      // default: 608
      return '608';
    }

    function _normalize608PlacementTarget(v) {
      const s = String(v || '').trim().toLowerCase();
      if (s === 'line2' || s === 'l2' || s === '2' || s === 'bottom') return 'line2';
      if (s === 'line1' || s === 'l1' || s === '1' || s === 'top') return 'line1';
      return 'block';
    }

    // NOTE: The visible (left) preview pane is used as “Preview” for SCC.
    // That pane is wired up as __editorSafe708 for historical reasons (it has controls).
    // So we need a way to flip its geometry between 708 and 608.
    function setTrack(newTrack) {
      const next = _normalizePreviewTrack(newTrack);
      if (next === track) return;
      track = next;

      // Force a fresh layout + rebuilt hit-grids.
      lastSize = { w: 0, h: 0 };

      // Drop grids that are track-dependent so ensureGrid()/ensureZoneGrid() can rebuild.
      try { overlayEl?.querySelector?.('.col-grid')?.remove?.(); } catch {}
      try { overlayEl?.querySelector?.('.zone-grid')?.remove?.(); } catch {}

      // Clear any stale caption layer so we don't show the wrong track “stuck on screen”.
      try {
        if (track === '608') {
          clearCaption708();
        } else {
          clearCaption();
        }
      } catch {}

      // Rebuild overlay geometry + re-apply current toggle policies.
      try { api.rebuild(); } catch {}
      try { api.setGuidesVisible(guidesVisible); } catch {}
      try { api.refreshInspector(); } catch {}
    }

    function set708PlacementMode(v) {
      if (track !== '708') return;
      placementMode708 = _normalize708PlacementMode(v);
      // Toggle which click-surface is active: zone grid vs column grid.
      try { ensureZoneGrid(); } catch {}
      try { ensureGrid(); } catch {}
    }

    function set608PlacementTarget(v) {
      placementTarget608 = _normalize608PlacementTarget(v);
      // Keep marker/inspector selection predictable.
      if (placementTarget608 === 'line1') pendingLineIndex = 0;
      else pendingLineIndex = 1; // line2 or block → bottom-ish by default
      try { api.refreshInspector(); } catch {}
    }

    function rowToYPx(row, fullHeight) {
      return _rowToYPx15(row, fullHeight);
    }

    function _clampInt(n, min, max, defVal) {
      const v = Number(n);
      if (!Number.isFinite(v)) return defVal;
      return Math.max(min, Math.min(max, Math.round(v)));
    }

    // Safe margins are an export-time constraint, so the preview should SHOW them as guides
    // (not silently bake them into the coordinate system).
    function _readSafeMargins() {
      // Prefer explicit doc-provided margins, then MCC UI prefs, then SCC prefs.
      let left = Number(state.doc?.sccOptions?.safeMargins?.left);
      let right = Number(state.doc?.sccOptions?.safeMargins?.right);

      if (!Number.isFinite(left)) left = Number(state.doc?.mccOptions?.safeMargins?.left);
      if (!Number.isFinite(right)) right = Number(state.doc?.mccOptions?.safeMargins?.right);

      if (!Number.isFinite(left)) {
        try {
          const raw = localStorage.getItem('mcc-safe-left') || localStorage.getItem('scc-safe-left') || '0';
          left = parseInt(raw, 10);
        } catch { left = 0; }
      }
      if (!Number.isFinite(right)) {
        try {
          const raw = localStorage.getItem('mcc-safe-right') || localStorage.getItem('scc-safe-right') || '0';
          right = parseInt(raw, 10);
        } catch { right = 0; }
      }

      left = _clampInt(left, 0, 15, 0);
      right = _clampInt(right, 0, 15, 0);
      return { left, right };
    }

    function layoutColGuides(rect) {
      if (!overlayEl) return;
      const r = rect || overlayEl.getBoundingClientRect();
      const { gridLeft, cellW, safeLeft, safeWidth } = _calcSafeBox(r);
      const { left, right } = _readSafeMargins();

      // Positions are in pixels, relative to the overlay box.
      const pos = {
        'title-safe-left': safeLeft,
        'title-safe-right': safeLeft + safeWidth,
        'margin-left': gridLeft + (left * cellW),
        'margin-right': gridLeft + ((32 - right) * cellW)
      };

      overlayEl.querySelectorAll('.col-guide').forEach((el) => {
        const kind = String(el.dataset.kind || '');
        if (track === '708' && (kind === 'margin-left' || kind === 'margin-right')) {
          el.style.display = 'none';
          return;
        }
        const x = pos[kind];
        if (!Number.isFinite(x)) {
          el.style.display = 'none';
          return;
        }
        el.style.left = `${x}px`;

        // UX: in 608 view it's common for title-safe (TS) and column-safe margins (ML/MR)
        // to land very close together (e.g., 3 cols ≈ 9.375% vs title-safe = 10%).
        // Stagger the labels vertically to prevent visual collisions.
        const label = el.querySelector('.col-label');
        if (label) {
          if (track === '608' && (kind === 'margin-left' || kind === 'margin-right')) {
            label.style.top = '22px';
          } else {
            label.style.top = '6px';
          }
        }
        el.style.display = guidesVisible ? 'block' : 'none';
      });
    }

    // Centralized guide layout (always runs when asked, can be forced on create)
    function layoutGuides(heightPx) {
      if (!overlayEl) return;
      const h = Math.max(0, heightPx || 0);
      const rect = overlayEl.getBoundingClientRect();
      const { gridLeft, gridW } = _calcSafeBox(rect);

      overlayEl.querySelectorAll('.row-guide').forEach((el) => {
        const row = Number(el.dataset.row);
        const y = rowToYPx(row, h);
        el.style.top = `${y}px`;
        // Row guides track the safe-title grid region:
        // - 608: safe-title inside the centered 4:3 aperture
        // - 708: safe-title inside the full preview
        el.style.left = `${gridLeft}px`;
        el.style.right = 'auto';
        el.style.width = `${gridW}px`;
        const label = el.querySelector('.row-label');
        if (label) label.style.top = '0';
      });

      layoutColGuides(rect);
    }

    function ensureGrid() {
      if (!overlayEl) return null;
      const cols = (track === '708') ? 42 : 32;
      let grid = overlayEl.querySelector('.col-grid');

      // If the track switched (e.g., 708 pane reused for SCC single preview),
      // rebuild the grid so the number of hit-cells matches the coordinate system.
      try {
        if (grid) {
          const cur = Number(grid.dataset.cols || grid.children?.length || 0);
          if (cur !== cols) {
            grid.parentElement?.removeChild?.(grid);
            grid = null;
          }
        }
      } catch {}

      if (!grid) {
        grid = document.createElement('div');
        grid.className = 'col-grid';
        for (let i = 0; i < cols; i++) {
          const cell = document.createElement('div');
          cell.className = 'col-hit';
          cell.dataset.col = String(i);
          grid.appendChild(cell);
        }
        grid.dataset.cols = String(cols);
        overlayEl.appendChild(grid);
      }

      // The click grid should match caption coordinates:
      //   - 608: 32 columns across the 4:3 safe-title area (inner 80% of the 4:3 aperture)
      //   - 708: 42 columns across the 16:9 safe-title area (inner 80% of the preview)
      // SafeMargins remain separate guides (ML/MR) and are not baked into the grid.
      try {
        const rect = overlayEl.getBoundingClientRect();
        const { gridLeft, gridW, gridTop, gridH } = _calcSafeBox(rect);
        grid.style.position = 'absolute';
        grid.style.top = `${gridTop}px`;
        grid.style.bottom = 'auto';
        grid.style.left = `${gridLeft}px`;
        grid.style.right = 'auto';
        grid.style.width = `${gridW}px`;
        grid.style.height = `${gridH}px`;
        grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        grid.style.setProperty('--cc-cols', String(cols));
      } catch {}

      // Safe-area checkbox controls *visible* grid lines.
      // But the grid element may still need to exist (invisibly) for click-to-place.
      const showGridLines = guidesVisible;
      grid.classList.toggle('debug-grid', showGridLines);

      // Click-to-place:
      //  - 608: row/col placement (always uses the 32-col grid)
      //  - 708: either 3×3 zones (separate grid) or exact 42×15 clicks (reuse col grid)
      const allowClick = placementEnabled && (track === '608' || (track === '708' && placementMode708 === 'exact'));
      grid.style.pointerEvents = allowClick ? 'auto' : 'none';
      // Show the grid when either:
      //  - guides are enabled (visual grid lines), OR
      //  - click-to-place needs a pointer-events surface (invisible when guides are off)
      const showGrid = showGridLines || allowClick;
      grid.style.display = showGrid ? 'grid' : 'none';
      return grid;
    }

    // 708 click-to-place uses an ASS-style 3×3 alignment grid.
    // This maps cleanly onto the encoder's existing \an# → 708 window anchor mapping.
    function _assAnTo708WindowOverride(an) {
      const n = Number(an) | 0;
      // Use small safe-margins rather than hugging the edge.
      const TOP = 10, MID = 50, BOT = 90;
      const LEFT = 10, CTR = 50, RIGHT = 90;

      // CTA-708 anchorId grid assumption:
      //   0 UL, 1 UC, 2 UR, 3 ML, 4 MC, 5 MR, 6 LL, 7 LC, 8 LR
      const map = {
        1: { anchorId: 6, anchorV: BOT, anchorH: LEFT,  justify: 'left' },
        2: { anchorId: 7, anchorV: BOT, anchorH: CTR,   justify: 'center' },
        3: { anchorId: 8, anchorV: BOT, anchorH: RIGHT, justify: 'right' },
        4: { anchorId: 3, anchorV: MID, anchorH: LEFT,  justify: 'left' },
        5: { anchorId: 4, anchorV: MID, anchorH: CTR,   justify: 'center' },
        6: { anchorId: 5, anchorV: MID, anchorH: RIGHT, justify: 'right' },
        7: { anchorId: 0, anchorV: TOP, anchorH: LEFT,  justify: 'left' },
        8: { anchorId: 1, anchorV: TOP, anchorH: CTR,   justify: 'center' },
        9: { anchorId: 2, anchorV: TOP, anchorH: RIGHT, justify: 'right' }
      };
      return map[n] || null;
    }

    function _nameForAssAn(an) {
      const n = Number(an) | 0;
      const map = {
        1: tr('subtitleEditor.placement.zoneName.lowerLeft', 'lower-left'),
        2: tr('subtitleEditor.placement.zoneName.lowerCenter', 'lower-center'),
        3: tr('subtitleEditor.placement.zoneName.lowerRight', 'lower-right'),
        4: tr('subtitleEditor.placement.zoneName.middleLeft', 'middle-left'),
        5: tr('subtitleEditor.placement.zoneName.middleCenter', 'middle-center'),
        6: tr('subtitleEditor.placement.zoneName.middleRight', 'middle-right'),
        7: tr('subtitleEditor.placement.zoneName.upperLeft', 'upper-left'),
        8: tr('subtitleEditor.placement.zoneName.upperCenter', 'upper-center'),
        9: tr('subtitleEditor.placement.zoneName.upperRight', 'upper-right')
      };
      return map[n] || '';
    }

    function _getActiveCueForPlacement() {
      const activeCueEl = root?.querySelector('.cue.active') || root?.querySelector('.cue:focus-within');
      if (!activeCueEl) return null;
      const idx = Number(activeCueEl.dataset.index || -1);
      if (!Number.isInteger(idx) || idx < 0 || !state.doc?.cues?.[idx]) return null;
      return { cue: state.doc.cues[idx], idx };
    }

    function ensureZoneGrid() {
      if (!overlayEl || track !== '708') return null;
      let grid = overlayEl.querySelector('.zone-grid');
      if (!grid) {
        grid = document.createElement('div');
        grid.className = 'zone-grid';

        // Order: top row (7,8,9), middle row (4,5,6), bottom row (1,2,3)
        const cells = [7, 8, 9, 4, 5, 6, 1, 2, 3];
        for (const an of cells) {
          const cell = document.createElement('div');
          cell.className = 'zone-hit';
          cell.dataset.an = String(an);
          cell.title = tr('subtitleEditor.placement.zoneTitle', '708 zone: {{zoneName}}', { zoneName: _nameForAssAn(an) });
          grid.appendChild(cell);
        }
        overlayEl.appendChild(grid);
      }

      // Position the zone grid inside the title-safe rectangle (inner 80%).
      try {
        const rect = overlayEl.getBoundingClientRect();
        const safeW = rect.width * 0.8;
        const safeH = rect.height * 0.8;
        const safeLeft = (rect.width - safeW) / 2;
        const safeTop = (rect.height - safeH) / 2;
        grid.style.left = `${safeLeft}px`;
        grid.style.top = `${safeTop}px`;
        grid.style.width = `${safeW}px`;
        grid.style.height = `${safeH}px`;
      } catch {}

      // Only visible/clickable when click-to-place is enabled AND we're in zone mode.
      const on = placementEnabled && placementMode708 === 'zones';
      grid.style.display = on ? 'grid' : 'none';
      grid.style.pointerEvents = on ? 'auto' : 'none';

      // Highlight the active cue's current zone if it has one.
      try {
        const active = _getActiveCueForPlacement();
        const anRaw = active?.cue?.cea708Placement?.an ?? active?.cue?.cea708Placement?.assAn ?? active?.cue?.cea708An;
        const an = Number.isFinite(Number(anRaw)) ? Math.max(1, Math.min(9, Math.trunc(Number(anRaw)))) : null;
        grid.querySelectorAll('.zone-hit').forEach((el) => {
          const hitAn = Number(el.dataset.an || 0);
          el.classList.toggle('active', !!an && hitAn === an);
        });
      } catch {}

      return grid;
    }


    function _calcSafeBox(rect) {
      const r = rect || (overlayEl?.getBoundingClientRect() || { width: 1, height: 1 });
      return _calcBroadcastSafeTitleGeometry(r, track);
    }

    function _calc608SafeBox(rect) {
      const r = rect || (overlayEl?.getBoundingClientRect() || { width: 1, height: 1 });
      const g = _calcBroadcastSafeTitleGeometry(r, '608');
      // Keep legacy return keys used by render608()/placement marker.
      return { activeLeft: g.activeLeft, activeW: g.activeW, cellW: g.cellW, safeLeft: g.safeLeft, safeWidth: g.safeWidth };
    }
    function ensureCaptionCSS() {
      // Caption preview CSS is shipped in style.css.
      // Inline <style> injection is blocked by the strict CSP (style-src-elem),
      // and when these rules are missing captions fall back to normal-flow layout
      // (top-left), ignoring left/top coordinates.
      return;
    }


    function ensureCaptionLayer() {
      // If render608 runs before the safe-title overlay exists, bootstrap it
      // so caption rendering never silently no-ops.
      if (!overlayEl && preview) {
        api.rebuild();
      }
      if (!overlayEl) return null;
      if (!captionLayer) {
        captionLayer = document.createElement('div');
        captionLayer.className = 'cc608-layer';
        overlayEl.appendChild(captionLayer);
      }
      captionLayer.style.display = enabled ? 'block' : 'none';
      return captionLayer;
    }
    function ensureCaptionCSS708() {
      // Caption preview CSS is shipped in style.css.
      // Inline <style> injection is blocked by the strict CSP (style-src-elem).
      return;
    }


    function ensureCaptionLayer708() {
      if (!overlayEl && preview) {
        api.rebuild();
      }
      if (!overlayEl) return null;
      if (!captionLayer708) {
        captionLayer708 = document.createElement('div');
        captionLayer708.className = 'cc708-layer';
        overlayEl.appendChild(captionLayer708);
      }
      captionLayer708.style.display = enabled ? 'block' : 'none';
      return captionLayer708;
    }



    function toXY(row, col) {
      // Map 608 rows (1..15) into the inner 80% caption/title-safe band.
      // Map 32 columns across the 4:3 safe-title area (inner 80% of the 4:3 caption aperture).
      // Title-safe + safeMargins are shown as guide lines so preview matches export.
      const rect = overlayEl?.getBoundingClientRect() || { width: 1, height: 1 };

      const y = rowToYPx(row, rect.height);

      const { safeLeft, cellW } = _calc608SafeBox(rect);

      const x = safeLeft + col * cellW;
      return { x, y, cellW };
    }


    function clearCaption() {
      const layer = ensureCaptionLayer();
      if (!layer) return;
      while (layer.firstChild) layer.removeChild(layer.firstChild);
    }

    function clearCaption708() {
      const layer = ensureCaptionLayer708();
      if (!layer) return;
      while (layer.firstChild) layer.removeChild(layer.firstChild);
    }

    function render608(cue) {
      ensureCaptionCSS();
      const layer = ensureCaptionLayer();
      if (captionLayer708) captionLayer708.style.display = 'none';
      clearCaption();
      if (!enabled || !layer || !cue) return;

      const baseText = String(_cueTextFromCue(cue) || '').replace(/\\n/g, '\n');
      const raw = Array.isArray(cue.lines) && cue.lines.length
        ? cue.lines
        : (window.transcribeEngine?.wrap608
            ? window.transcribeEngine.wrap608(baseText, 32, 2)
            : baseText.split(/\r?\n|\s*\|\s*/g));

      const sccMode = isSccDoc(state.doc);

      const placementForLine = (i) => {
        // Phase B: read from overrides['608'].placement when present.
        return _readPlacementForCueLine(cue, i);
      };

      const pairs = raw
        .map((s, i) => {
          const pl = placementForLine(i);
          const rowNum = Number(pl?.row);
          const colNum = Number(pl?.col);
          const hasPac = !!(pl && (Number.isFinite(rowNum) || Number.isFinite(colNum)));
          const textRaw = String(s ?? '').replace(/\s+$/g, '');
          const inferredCol = (hasPac || sccMode)
            ? null
            : Math.max(0, Math.min(31, (textRaw.match(/^(\s*)/)?.[1] || '').length));

          // SCC decoders often emit row strings with leading spaces that represent the
          // PAC/indent position. If we also position the line using that same PAC/indent,
          // we must strip the positional padding or the caption will shift too far right
          // and get cut off.
          const textDisplay = hasPac
            ? textRaw.replace(/^[ ]+/, '')
            : (sccMode ? textRaw : textRaw.replace(/^\s+/, ''));
          return { text: textDisplay, pl, inferredCol, hasPac };
        })
        .filter(p => p.text && p.text.length)
        .slice(0, 2);

      const lines = pairs.map(p => p.text);

      const defaultRows = (lines.length === 1) ? [15] : [14, 15];
      const rows = [];
      const cols = [];

      for (let i = 0; i < lines.length; i++) {
        const pl = pairs[i]?.pl || {};
        const rowVal = Number(pl.row);
        const colVal = Number(pl.col);
        // IMPORTANT: allow full 608 row range (1..15). Title-safe (12..15) is a default,
        // not a hard restriction. SCC deliverables often reposition above lower-thirds.
        rows[i] = Math.max(1, Math.min(15, Number.isFinite(rowVal) ? rowVal : (defaultRows[i] ?? 15)));
        const fallbackCol = pairs[i]?.hasPac ? 0 : (pairs[i]?.inferredCol ?? 0);
        cols[i] = Math.max(0, Math.min(31, Number.isFinite(colVal) ? colVal : fallbackCol));
      }

      if (lines.length === 2 && rows[0] > rows[1]) {
        [rows[0], rows[1]] = [rows[1], rows[0]];
        [cols[0], cols[1]] = [cols[1], cols[0]];
        [lines[0], lines[1]] = [lines[1], lines[0]];
      }

      const overlayRect = overlayEl?.getBoundingClientRect() || { width: 1, height: 1 };
      const cellHeightSafe = (overlayRect.height * 0.8) / 15;
      const cellHeightStrict = cellHeightSafe;
      // Use strict font sizing if ANY line is PAC-driven (so it matches strict y-mapping)
      const anyPac = pairs.some(p => p?.hasPac);
      const cellHeight = anyPac ? cellHeightStrict : cellHeightSafe;
      const fontPx = Math.floor(cellHeight * 1.0);

      // SCC mid-row attribute tokens ({WhU},{I},{IU},...) are control codes in real
      // CEA-608. Decoders treat them as a style change AND a blank cell (space).
      // The preview must emulate that or users will "fix" captions based on a
      // representation that no broadcast decoder will ever show.
      const MIDROW_SPLIT_RE = /\{(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g;
      const _applyMidRowToken = (prev, tok) => {
        const next = { ...(prev || { color: 'wh', underline: false, italic: false }) };
        const t = String(tok || '').trim();
        if (!t) return next;

        if (t === 'I' || t === 'IU') {
          next.color = 'wh';
          next.italic = true;
          next.underline = (t === 'IU');
          return next;
        }

        // Color/underline attributes reset italics in most decoders.
        next.italic = false;
        next.underline = /U$/.test(t);
        const base = t.replace(/U$/, '');
        const map = { Wh: 'wh', Gr: 'gr', Bl: 'bl', Cy: 'cy', R: 'r', Y: 'y', Ma: 'ma' };
        if (map[base]) next.color = map[base];
        return next;
      };
      const _parse608Cells = (text) => {
        const parts = String(text || '').split(MIDROW_SPLIT_RE);
        let style = { color: 'wh', underline: false, italic: false };
        const cells = [];
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          if (p % 2 === 1) {
            // Token: change style, and occupy 1 blank cell.
            style = _applyMidRowToken(style, part);
            cells.push({ ch: ' ', style: { ...style }, isToken: true });
          } else if (part) {
            // Text: one cell per character (codepoint).
            for (const ch of Array.from(part)) {
              cells.push({ ch, style: { ...style }, isToken: false });
            }
          }
        }
        return cells;
      };
      const _clampCells = (cells, max) => {
        const out = Array.isArray(cells) ? cells.slice(0, Math.max(0, max)) : [];
        // Trim trailing whitespace cells (matches earlier string-based clamp)
        while (out.length && String(out[out.length - 1]?.ch || '') === ' ') out.pop();
        return out;
      };

      for (let i = 0; i < lines.length; i++) {
        const row = rows[i];
        const col = cols[i];
        const { x, y, cellW } = toXY(row, col);

        const el = document.createElement('div');
        el.className = 'cc608-line';

        const maxCols = Math.max(0, 32 - col);
        const rawText = lines[i] || '';
        const cells = _clampCells(_parse608Cells(rawText), maxCols);

        // Render as fixed 608 cells so PAC/col positioning is visually correct.
        el.style.setProperty('--cc-cellw', `${cellW}px`);
        while (el.firstChild) el.removeChild(el.firstChild);
        for (const c of cells) {
          const cell = document.createElement('span');
          cell.className = 'cc608-cell';
          const st = c?.style || {};
          if (st.italic) cell.classList.add('i');
          if (st.underline) cell.classList.add('u');
          if (st.color) cell.classList.add(`c-${st.color}`);
          cell.textContent = (c?.ch === ' ') ? '\u00A0' : String(c?.ch || '');
          el.appendChild(cell);
        }
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.lineHeight = '1';
        el.style.fontSize = `${fontPx}px`;
        el.style.width = `${cellW * Math.min(32 - col, cells.length)}px`;

        layer.appendChild(el);
      }
    }

    function render708(cue) {
      ensureCaptionCSS708();
      const layer = ensureCaptionLayer708();
      clearCaption708();

      // Hide the 608 overlay when rendering 708 windows.
      if (captionLayer) captionLayer.style.display = 'none';
      if (!enabled || !layer) return;

      if (!cue) {
        layer.style.display = 'none';
        return;
      }

      let windows = cue && cue.cea708 && Array.isArray(cue.cea708.windows) ? cue.cea708.windows : [];
      const fallbackText = String(cue.text || '').trim();

      if (!windows.length) {
        // Fallback: render as a single bottom-centered window.
        if (!fallbackText) {
          layer.style.display = 'none';
          return;
        }
        windows = [{
          anchorH: 50,
          anchorV: 90,
          anchorId: 7,
          justify: 'center',
          colCount: 42,
          rowCount: 2,
          lines: fallbackText.split(/\n/g)
        }];
      }

      // Per-cue 708 placement override:
      //  1) Exact window override (overrides['708'].window), when present.
      //  2) Zone override stored as ASS \an# (1..9) for the simpler 3×3 mode.
      let appliedPlacement = false;

      // Exact mode: overrides['708'].window
      try {
        const winRaw = cue?.overrides?.['708']?.window;
        const win = (winRaw && typeof winRaw === 'object') ? winRaw : null;
        if (win) {
          const rel = (win.rel ?? win.relative);
          const relative = (rel === false) ? false : true;
          windows = windows.map((w) => ({
            ...(w && typeof w === 'object' ? w : {}),
            relative,
            anchorId: (win.anchorId != null) ? win.anchorId : w?.anchorId,
            anchorV: (win.anchorV != null) ? win.anchorV : w?.anchorV,
            anchorH: (win.anchorH != null) ? win.anchorH : w?.anchorH,
            justify: (win.justify != null) ? win.justify : w?.justify
          }));
          appliedPlacement = true;
        }
      } catch {}

      // Zone mode: \an override
      if (!appliedPlacement) {
        try {
          const anRaw = cue?.cea708Placement?.an ?? cue?.cea708Placement?.assAn ?? cue?.cea708An;
          const anNum = Number(anRaw);
          const an = Number.isFinite(anNum) ? Math.max(1, Math.min(9, Math.trunc(anNum))) : null;
          const ov = an ? _assAnTo708WindowOverride(an) : null;
          if (ov) {
            windows = windows.map((w) => ({
              ...(w && typeof w === 'object' ? w : {}),
              // Force relative anchors so the preset lands inside title-safe.
              relative: true,
              anchorId: ov.anchorId,
              anchorV: ov.anchorV,
              anchorH: ov.anchorH,
              justify: ov.justify
            }));
          }
        } catch {}
      }

      layer.style.display = '';

      const rect = overlayEl?.getBoundingClientRect() || { width: 1, height: 1 };

      // CTA-708 defines a 42x15 "screen" that lives inside the title-safe area
      // (the inner 80% of the active picture). Most broadcast decoders and NLEs
      // (Premiere included) map anchors into that safe rectangle, not the full raster.
      //
      // If we map to the full raster, wide windows (e.g., 41 cols) will look
      // shoved against the edges and "left aligned" even when the file is centered.
      const fullW = rect.width;
      const fullH = rect.height;
      const safeW = fullW * 0.8;
      const safeH = fullH * 0.8;
      const safeLeft = (fullW - safeW) / 2;
      const safeTop = (fullH - safeH) / 2;

      const screenCols = 42;
      const screenRows = 15;
      const cellW = safeW / screenCols;
      const cellH = safeH / screenRows;
      const fontPx = Math.max(12, Math.floor(cellH * 0.9));

      const clampInt = (v, min, max, def) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return def;
        return Math.max(min, Math.min(max, Math.round(n)));
      };

      const anchorFactors = (id) => {
        switch (clampInt(id, 0, 8, 0)) {
          case 1: return { ax: 0.5, ay: 0 };
          case 2: return { ax: 1, ay: 0 };
          case 3: return { ax: 0, ay: 0.5 };
          case 4: return { ax: 0.5, ay: 0.5 };
          case 5: return { ax: 1, ay: 0.5 };
          case 6: return { ax: 0, ay: 1 };
          case 7: return { ax: 0.5, ay: 1 };
          case 8: return { ax: 1, ay: 1 };
          default: return { ax: 0, ay: 0 };
        }
      };

      const _opacityToAlpha = (op) => {
        // CTA-708 opacity: 0=solid, 1=flash, 2=translucent, 3=transparent.
        // We don't animate flash in the overlay; treat it as solid.
        const o = Number(op) | 0;
        if (o === 2) return 0.5;
        if (o === 3) return 0;
        return 1;
      };

      const _708ByteToRgba = (b, opacityOverride = null) => {
        const v = Number(b) & 0xFF;
        const op = (opacityOverride != null) ? (Number(opacityOverride) & 3) : ((v >> 6) & 3);
        const r2 = (v >> 4) & 3;
        const g2 = (v >> 2) & 3;
        const b2 = v & 3;
        const a = _opacityToAlpha(op);
        const r = r2 * 85;
        const g = g2 * 85;
        const bb = b2 * 85;
        return { css: `rgba(${r},${g},${bb},${a})`, a };
      };

      const _edgeShadow = (edgeType, edgeCss) => {
        const t = Number(edgeType) | 0;
        if (!t) return '';

        // Light-weight approximation of CTA-708 edge styles.
        // (Not pixel-perfect, but very helpful in practice.)
        switch (t) {
          case 3: // uniform
            return [
              `-1px 0 0 ${edgeCss}`,
              `1px 0 0 ${edgeCss}`,
              `0 -1px 0 ${edgeCss}`,
              `0 1px 0 ${edgeCss}`
            ].join(',');
          case 4: // shadow_left
            return `-1px 1px 0 ${edgeCss}`;
          case 5: // shadow_right
            return `1px 1px 0 ${edgeCss}`;
          case 1: // raised
            return [`-1px -1px 0 rgba(255,255,255,0.65)`, `1px 1px 0 ${edgeCss}`].join(',');
          case 2: // depressed
            return [`1px 1px 0 rgba(255,255,255,0.65)`, `-1px -1px 0 ${edgeCss}`].join(',');
          default:
            return `1px 1px 0 ${edgeCss}`;
        }
      };

      const makeCell = (ch, styleBits = 0, pen = null) => {
        const cell = document.createElement('span');
        cell.className = 'cc708-cell';
        const bits = Number(styleBits) | 0;
        if (bits & 1) cell.classList.add('i');
        if (bits & 2) cell.classList.add('u');

        if (pen && typeof pen === 'object') {
          if (pen.fgByte != null) {
            const fg = _708ByteToRgba(pen.fgByte);
            if (fg.a > 0) cell.style.color = fg.css;
          }
          if (pen.bgByte != null) {
            const bg = _708ByteToRgba(pen.bgByte);
            if (bg.a > 0) cell.style.backgroundColor = bg.css;
          }
          if (pen.edgeByte != null) {
            const fgOp = (pen.fgByte != null) ? ((Number(pen.fgByte) >> 6) & 3) : 0;
            const edge = _708ByteToRgba(Number(pen.edgeByte) & 0x3F, fgOp);
            const shadow = _edgeShadow(pen.edgeType, edge.css);
            cell.style.textShadow = shadow || 'none';
          }
        }

        cell.textContent = (ch === ' ') ? '\u00A0' : String(ch || '');
        return cell;
      };

      for (const w of windows) {
        const rowCount = clampInt(w.rowCount, 1, 15, 2);
        const colCount = clampInt(w.colCount, 1, 63, 42);
        const relative = (w.relative !== false);
        const hMax = relative ? 99 : 209;
        const vMax = relative ? 99 : 74;
        const anchorH = clampInt(w.anchorH, 0, hMax, 0);
        const anchorV = clampInt(w.anchorV, 0, vMax, 0);
        const { ax, ay } = anchorFactors(w.anchorId);

        const x = safeLeft + (anchorH / Math.max(1, hMax)) * safeW;
        const y = safeTop + (anchorV / Math.max(1, vMax)) * safeH;

	        const winW = colCount * cellW;
	        const winH = rowCount * cellH;
	        let left = x - (ax * winW);
	        let top = y - (ay * winH);

	        // Real-world decoders are expected to keep caption windows inside the
	        // safe-title area. Streams in the wild can contain window definitions
	        // that would otherwise place the window partially off-screen (e.g. a
	        // full-width 42-col window anchored "lower-center" with an anchorH
	        // that is not centered). Hardware decoders/NLEs effectively clamp these
	        // windows to the safe-title rectangle; the preview must match that.
	        const safeRight = safeLeft + safeW;
	        const safeBottom = safeTop + safeH;

	        // If the window is larger than the safe-title area, FCC/CEA-708 guidance
	        // allows the decoder to disregard it.
	        if (winW > safeW + 0.5 || winH > safeH + 0.5) {
	          continue;
	        }

	        if (left < safeLeft) left = safeLeft;
	        if (left + winW > safeRight) left = safeRight - winW;
	        if (top < safeTop) top = safeTop;
	        if (top + winH > safeBottom) top = safeBottom - winH;

        const winEl = document.createElement('div');
        winEl.className = 'cc708-window';
        if (guidesVisible || showInspector) winEl.classList.add('debug');

        winEl.style.left = `${left}px`;
        winEl.style.top = `${top}px`;
        winEl.style.width = `${winW}px`;
        winEl.style.height = `${winH}px`;
        winEl.style.fontSize = `${fontPx}px`;
        winEl.style.setProperty('--cc708-cellw', `${cellW}px`);
        winEl.style.setProperty('--cc708-cellh', `${cellH}px`);

        // Apply window-level styling (SWA) if present.
        const ws = (w.windowStyle && typeof w.windowStyle === 'object') ? w.windowStyle : null;
        if (ws) {
          const fillByte = ((Number(ws.fillOpacity) & 3) << 6)
            | ((Number(ws.fillColor?.r) & 3) << 4)
            | ((Number(ws.fillColor?.g) & 3) << 2)
            | (Number(ws.fillColor?.b) & 3);
          const fill = _708ByteToRgba(fillByte);
          if (fill.a > 0) winEl.style.backgroundColor = fill.css;

          const borderType = Number(ws.borderType) | 0;
          if (borderType > 0) {
            const borderByte = ((0 & 3) << 6)
              | ((Number(ws.borderColor?.r) & 3) << 4)
              | ((Number(ws.borderColor?.g) & 3) << 2)
              | (Number(ws.borderColor?.b) & 3);
            const border = _708ByteToRgba(borderByte, 0);
            winEl.style.border = `1px solid ${border.css}`;
          }
        }

        const hasSPL = !!w.hasSPL;
        const justify = String(w.justify || 'left').toLowerCase();
        const lines = Array.isArray(w.lines) ? w.lines.map(v => String(v || '')) : [];
        const grid = Array.isArray(w.grid) ? w.grid.map(v => String(v || '')) : null;
        const lineStyles = Array.isArray(w.lineStyles) ? w.lineStyles.map(v => String(v || '')) : null;
        const gridStyles = Array.isArray(w.gridStyles) ? w.gridStyles.map(v => String(v || '')) : null;

        const lineFg = Array.isArray(w.lineFg) ? w.lineFg : null;
        const lineBg = Array.isArray(w.lineBg) ? w.lineBg : null;
        const lineEdge = Array.isArray(w.lineEdge) ? w.lineEdge : null;
        const lineEdgeType = Array.isArray(w.lineEdgeType) ? w.lineEdgeType : null;
        const gridFg = Array.isArray(w.gridFg) ? w.gridFg : null;
        const gridBg = Array.isArray(w.gridBg) ? w.gridBg : null;
        const gridEdge = Array.isArray(w.gridEdge) ? w.gridEdge : null;
        const gridEdgeType = Array.isArray(w.gridEdgeType) ? w.gridEdgeType : null;

        const styleAt = (styleRow, idx) => {
          if (!styleRow) return 0;
          const code = styleRow.charCodeAt(idx) - 48;
          return (code >= 0 && code <= 3) ? code : 0;
        };

        for (let r = 0; r < rowCount; r++) {
          const rowEl = document.createElement('div');
          rowEl.className = 'cc708-row';
          rowEl.style.height = `${cellH}px`;
          rowEl.style.lineHeight = `${cellH}px`;

          if (hasSPL && grid) {
            const rowStr = String(grid[r] || '');
            const styleRow = gridStyles ? String(gridStyles[r] || '') : '';
            const fgRow = gridFg && gridFg[r] ? gridFg[r] : null;
            const bgRow = gridBg && gridBg[r] ? gridBg[r] : null;
            const edgeRow = gridEdge && gridEdge[r] ? gridEdge[r] : null;
            const edgeTypeRow = gridEdgeType && gridEdgeType[r] ? gridEdgeType[r] : null;
            const maxLen = Math.min(colCount, rowStr.length);
            let last = maxLen - 1;
            while (last >= 0 && rowStr[last] === ' ') last--;
            if (last >= 0) {
              // CTA-708 window justification still applies even when the encoder uses
              // explicit pen placement (SPL) to lay out rows. Our decoder snapshot
              // grid is left-anchored (pen columns), so apply justification only when
              // the row does NOT look like it was already positioned via SPL.
              let first = 0;
              while (first <= last && rowStr[first] === ' ') first++;

              const wantsJustify = (justify === 'center' || justify === 'right');
              const leading = first; // leading spaces before the first non-space cell
              const contentLen = Math.max(0, (last - first + 1));

              // Expected pad when SWA justify is applied to the *content*.
              let pad = 0;
              if (wantsJustify) {
                if (justify === 'center') pad = Math.floor((colCount - contentLen) / 2);
                else if (justify === 'right') pad = (colCount - contentLen);
                pad = Math.max(0, Math.min(colCount - 1, pad));
              }

              // Heuristic:
              // Some real-world streams (or decoder edge cases) can return a row that
              // begins with 1–2 blanks even when that whitespace is not a deliberate
              // SPL pen offset. If we treat *any* leading space as explicit offset,
              // we incorrectly opt out of SWA justification and the row renders
              // slightly left-ish.
              const minorLeading = (leading > 0 && leading <= 2);
              const nearExpectedPad = wantsJustify && (leading > 0) && (Math.abs(leading - pad) <= 1);

              const rowHasExplicitOffset = (leading > 0) && !minorLeading && !nearExpectedPad;
              const rowJustifyable = wantsJustify && !rowHasExplicitOffset;

              if (rowJustifyable) {

                for (let c = 0; c < pad && c < colCount; c++) rowEl.appendChild(makeCell(' ', 0));

                for (let i = 0; i < contentLen && (pad + i) < colCount; i++) {
                  const src = first + i;
                  const ch = (src < rowStr.length) ? rowStr[src] : ' ';
                  const pen = {
                    fgByte: fgRow && fgRow[src] != null ? fgRow[src] : null,
                    bgByte: bgRow && bgRow[src] != null ? bgRow[src] : null,
                    edgeByte: edgeRow && edgeRow[src] != null ? edgeRow[src] : null,
                    edgeType: edgeTypeRow && edgeTypeRow[src] != null ? edgeTypeRow[src] : 0
                  };
                  rowEl.appendChild(makeCell(ch, styleAt(styleRow, src), pen));
                }
              } else {
                for (let c = 0; c <= last && c < colCount; c++) {
                  const ch = (c < rowStr.length) ? rowStr[c] : ' ';
                  const pen = {
                    fgByte: fgRow && fgRow[c] != null ? fgRow[c] : null,
                    bgByte: bgRow && bgRow[c] != null ? bgRow[c] : null,
                    edgeByte: edgeRow && edgeRow[c] != null ? edgeRow[c] : null,
                    edgeType: edgeTypeRow && edgeTypeRow[c] != null ? edgeTypeRow[c] : 0
                  };
                  rowEl.appendChild(makeCell(ch, styleAt(styleRow, c), pen));
                }
              }
            }
          } else {
            const text = String(lines[r] || '');
            if (text) {
              const len = text.length;
              const styleRow = lineStyles ? String(lineStyles[r] || '') : '';
              const fgRow = lineFg && lineFg[r] ? lineFg[r] : null;
              const bgRow = lineBg && lineBg[r] ? lineBg[r] : null;
              const edgeRow = lineEdge && lineEdge[r] ? lineEdge[r] : null;
              const edgeTypeRow = lineEdgeType && lineEdgeType[r] ? lineEdgeType[r] : null;
              let start = 0;
              if (justify === 'center') start = Math.floor((colCount - len) / 2);
              else if (justify === 'right') start = (colCount - len);
              start = Math.max(0, Math.min(colCount - 1, start));

              for (let c = 0; c < start && c < colCount; c++) rowEl.appendChild(makeCell(' ', 0));
              for (let c = 0; c < len && (start + c) < colCount; c++) {
                const pen = {
                  fgByte: fgRow && fgRow[c] != null ? fgRow[c] : null,
                  bgByte: bgRow && bgRow[c] != null ? bgRow[c] : null,
                  edgeByte: edgeRow && edgeRow[c] != null ? edgeRow[c] : null,
                  edgeType: edgeTypeRow && edgeTypeRow[c] != null ? edgeTypeRow[c] : 0
                };
                rowEl.appendChild(makeCell(text[c], styleAt(styleRow, c), pen));
              }
            }
          }

          winEl.appendChild(rowEl);
        }

        layer.appendChild(winEl);
      }
    }

    function hidePlacementMarker() {
      const mark = overlayEl?.querySelector('.placement-marker');
      if (mark) mark.style.display = 'none';
    }

    function placementPac(row, col) {
      try {
        const nib = Math.floor(Math.max(0, Math.min(31, col)) / 4);
        return window.transcribeEngine?.pacForRow?.(row, nib, 1) || '';
      } catch {
        return '';
      }
    }

    function updateMarker(row, col, opts = {}) {
      if (!overlayEl) return;
      let mark = overlayEl.querySelector('.placement-marker');
      if (!mark) {
        mark = document.createElement('div');
        mark.className = 'placement-marker';
        overlayEl.appendChild(mark);
      }
      const overlayRect = overlayEl.getBoundingClientRect();

      const { safeLeft, cellW } = _calc608SafeBox(overlayRect);
      const x = safeLeft + (col + 0.5) * cellW;
      const y = rowToYPx(row, overlayRect.height);
      mark.style.left = `${x}px`;
      mark.style.top = `${y}px`;
      mark.style.display = placementEnabled ? 'block' : 'none';
      if (!opts?.silent && inspectorEl && placementEnabled && showInspector) {
        inspectorEl.textContent = tr('subtitleEditor.placement.inspectorRowCol', 'row {{row}}, col {{col}} → {{pac}}', { row, col, pac: placementPac(row, col) });
      }
    }

    function nearestRow(yPx) {
      // Compute row directly from click Y so placement works even if guides are hidden.
      if (!overlayEl) return 15;
      const rect = overlayEl.getBoundingClientRect();
      const yLocal = Number(yPx) - (rect.top || 0);
      return _nearestRow15(yLocal, rect.height);
    }

    function setPlacementEnabled(v) {
      // 608: row/col placement. 708: zones OR exact 708 window anchors.
      placementEnabled = !!v;
      pendingLineIndex = 0;
      // Guide/grid visibility depends on both the "Guides" toggle and placement mode.
      // Let setGuidesVisible(...) re-apply the correct policy for this track.
      api.setGuidesVisible(guidesVisible);
      // 708 zone grid is only visible/clickable while placement mode is enabled
      // AND we're in zone mode.
      try { ensureZoneGrid(); } catch {}
      if (!placementEnabled) {
        hidePlacementMarker();
      } else {
        api.refreshInspector();
      }
    }

    function _readPlacementForCueLine(cue, lineIdx) {
      if (!cue) return null;
      // Phase B: prefer 608 placement stored in overrides['608'].placement.
      // (Legacy fallback: cue.sccPlacement)
      const pOverride = Array.isArray(cue?.overrides?.['608']?.placement)
        ? cue.overrides['608'].placement
        : null;
      const pl = (pOverride && pOverride.length) ? pOverride : cue.sccPlacement;
      if (!pl) return null;
      if (Array.isArray(pl)) return pl[lineIdx] || null;
      if (typeof pl === 'object') {
        const looksLikeSingle = (pl && (Number.isFinite(pl.row) || Number.isFinite(pl.col) || typeof pl.pac === 'string'));
        if (looksLikeSingle) return (lineIdx === 0 ? pl : null);
        return pl[lineIdx] || pl[String(lineIdx)] || null;
      }
      return null;
    }

    function _writePlacementForCueLine(cue, lineIdx, row, col) {
      if (!cue) return;
      const r = _clampInt(row, 1, 15, 15);
      const c = _clampInt(col, 0, 31, 0);

      // Phase B: store placement override in overrides['608'].placement.
      // Mirror to cue.sccPlacement for backward compatibility (older exporters/preview code).
      cue.overrides = (cue.overrides && typeof cue.overrides === 'object') ? cue.overrides : {};
      cue.overrides['608'] = (cue.overrides['608'] && typeof cue.overrides['608'] === 'object') ? cue.overrides['608'] : {};
      const o608 = cue.overrides['608'];

      if (!Array.isArray(o608.placement)) o608.placement = [];
      o608.placement[lineIdx] = { row: r, col: c };
      // Mark as user-edited placement so dual-preview overlay only applies when appropriate
      o608._placementTouched = true;

      // Keep the legacy shape stable (array-of-placements).
      if (!Array.isArray(cue.sccPlacement)) cue.sccPlacement = [];
      cue.sccPlacement[lineIdx] = { row: r, col: c };
    }

    function _sccBlockIndicesAround(idx) {
      const doc = state.doc;
      const cues = Array.isArray(doc?.cues) ? doc.cues : [];
      if (!doc || !isSccDoc(doc) || !cues.length) return [idx];

      const base = cues[idx];
      const s0 = Number(base?.start);
      const e0 = Number(base?.end);
      if (!Number.isFinite(s0) || !Number.isFinite(e0)) return [idx];

      const fps = Number(doc?.fps) || 29.97;
      const frameTol = (1 / fps) + 0.001;

      const out = [idx];
      // Scan backward.
      for (let i = idx - 1; i >= 0; i--) {
        const c = cues[i];
        const s = Number(c?.start);
        const e = Number(c?.end);
        if (!Number.isFinite(s) || !Number.isFinite(e)) break;
        if (Math.abs(s - s0) <= frameTol && Math.abs(e - e0) <= frameTol) out.unshift(i);
        else break;
      }
      // Scan forward.
      for (let i = idx + 1; i < cues.length; i++) {
        const c = cues[i];
        const s = Number(c?.start);
        const e = Number(c?.end);
        if (!Number.isFinite(s) || !Number.isFinite(e)) break;
        if (Math.abs(s - s0) <= frameTol && Math.abs(e - e0) <= frameTol) out.push(i);
        else break;
      }
      return out.length ? out : [idx];
    }

    function _countNonEmptyLines(str) {
      const splitRe = _shouldTreatPipeAsHardBreak(state.doc)
        ? /\r?\n|\s*\|\s*/g
        : /\r?\n/g;
      const parts = String(str || '').split(splitRe);
      const nonEmpty = parts.map(s => String(s ?? '').replace(/\s+$/g, '')).filter(s => /[^\s]/.test(s));
      return Math.max(1, Math.min(2, nonEmpty.length || 1));
    }

    function _get608PlacementItems(idx, activeCueEl) {
      const doc = state.doc;
      const cues = Array.isArray(doc?.cues) ? doc.cues : [];
      const cue = cues[idx];
      if (!cue) return [];

      const items = [];

      // SCC special-case: some files represent a single pop-on "block" as multiple cues
      // that share the exact same timing. In that case, treat those cues as separate rows
      // for placement so "Block" can move them together.
      if (doc && isSccDoc(doc)) {
        const block = _sccBlockIndicesAround(idx);
        if (block.length > 1) {
          for (const bi of block) {
            const c = cues[bi];
            if (!c) continue;
            const ln = (Array.isArray(c.lines) && c.lines.length)
              ? String(c.lines[0] ?? '')
              : String(c.text ?? '');
            if (!/[^\s]/.test(ln)) continue;
            items.push({ cueIndex: bi, lineIndex: 0, placement: _readPlacementForCueLine(c, 0) });
          }
          // If we have explicit row placement for at least 2, sort by row (top→bottom)
          const withRow = items.reduce((n, it) => (Number.isFinite(it.placement?.row) ? n + 1 : n), 0);
          if (withRow >= 2) {
            items.sort((a, b) => {
              const ar = Number.isFinite(a.placement?.row) ? a.placement.row : Number.POSITIVE_INFINITY;
              const br = Number.isFinite(b.placement?.row) ? b.placement.row : Number.POSITIVE_INFINITY;
              if (ar !== br) return ar - br;
              const ac = Number.isFinite(a.placement?.col) ? a.placement.col : Number.POSITIVE_INFINITY;
              const bc = Number.isFinite(b.placement?.col) ? b.placement.col : Number.POSITIVE_INFINITY;
              if (ac !== bc) return ac - bc;
              return (a.cueIndex - b.cueIndex);
            });
          }
          return items.slice(0, 2);
        }
      }

      // Default: treat this single cue as up to 2 rows.
      let count = 1;
      // MCC/708: cue.lines is 708 authoring text (often 1 line) even when the derived 608 output
      // wraps into 2 lines. Click-to-place must follow the *effective 608* line count.
      let derivedCount = null;
      if (doc && is708Doc(doc) && !isSccDoc(doc)) {
        try {
          const tNow = (typeof video?.currentTime === 'number')
            ? (Number(video.currentTime) || 0)
            : (Number(cue.start) || 0);
          const derived = _buildDerived608CueForPreview(cue, doc, { timeSec: tNow });
          const dLines = Array.isArray(derived?.lines) ? derived.lines : null;
          if (dLines && dLines.length) {
            const nonEmpty = dLines
              .map(l => String(l ?? '').replace(/\s+$/g, ''))
              .filter(l => /[^\s]/.test(l));
            derivedCount = Math.max(1, Math.min(2, nonEmpty.length || dLines.length));
          }
        } catch {}
      }

      if (derivedCount != null) {
        count = derivedCount;
      } else if (Array.isArray(cue.lines) && cue.lines.length) {
        const nonEmpty = cue.lines.map(l => String(l ?? '').replace(/\s+$/g, '')).filter(l => /[^\s]/.test(l));
        count = Math.max(1, Math.min(2, nonEmpty.length || cue.lines.length));
      } else {
        const ta = activeCueEl?.querySelector?.('textarea') || activeCueEl?.querySelector?.('input[type="text"]');
        count = ta ? _countNonEmptyLines(ta.value || '') : 1;
      }

      for (let i = 0; i < count; i++) {
        items.push({ cueIndex: idx, lineIndex: i, placement: _readPlacementForCueLine(cue, i) });
      }

      const withRow = items.reduce((n, it) => (Number.isFinite(it.placement?.row) ? n + 1 : n), 0);
      if (withRow >= 2) {
        items.sort((a, b) => {
          const ar = Number.isFinite(a.placement?.row) ? a.placement.row : Number.POSITIVE_INFINITY;
          const br = Number.isFinite(b.placement?.row) ? b.placement.row : Number.POSITIVE_INFINITY;
          if (ar !== br) return ar - br;
          const ac = Number.isFinite(a.placement?.col) ? a.placement.col : Number.POSITIVE_INFINITY;
          const bc = Number.isFinite(b.placement?.col) ? b.placement.col : Number.POSITIVE_INFINITY;
          if (ac !== bc) return ac - bc;
          // Stable fallback: preserve original order.
          if (a.cueIndex !== b.cueIndex) return (a.cueIndex - b.cueIndex);
          return (a.lineIndex - b.lineIndex);
        });
      }

      return items;
    }

    const onOverlayClick = (ev) => {
      if (!placementEnabled) return;
      const target = ev.target;
      if (!target || !target.classList) return;

      // 708: click-to-place selects a 3×3 zone (ASS \an1..\an9).
      if (track === '708') {
        const mode = (placementMode708 === 'exact') ? 'exact' : 'zones';

        // Zone mode: click one of the 3×3 hitboxes.
        if (mode === 'zones') {
          if (!target.classList.contains('zone-hit')) return;

          const anRaw = Number(target.dataset.an || 0);
          const an = Number.isFinite(anRaw) ? Math.max(1, Math.min(9, Math.trunc(anRaw))) : null;
          if (!an) return;

          const active = _getActiveCueForPlacement();
          if (!active) return;
          const cue = active.cue;

          cue.cea708Placement = (cue.cea708Placement && typeof cue.cea708Placement === 'object')
            ? cue.cea708Placement
            : {};
          cue.cea708Placement.an = an;

          // Clear any exact window override so zones are the single source of truth.
          try {
            const o = cue.overrides;
            if (o && typeof o === 'object' && o['708'] && typeof o['708'] === 'object') {
              delete o['708'].window;
            }
          } catch {}

          // Mark the document dirty so MCC preview + QC re-run.
          try { markDirty(); } catch {}

          // Update UI + preview immediately.
          try { ensureZoneGrid(); } catch {}
          try { renderActiveCue608(); } catch {}
          api.refreshInspector();
          return;
        }

        // Exact mode: click a specific 42×15 grid position.
        if (!target.classList.contains('col-hit')) return;

        const cols = 42;
        const col = Math.max(0, Math.min(cols - 1, Math.trunc(Number(target.dataset.col || 0))));
        const row = nearestRow(ev.clientY);

        // Map row/col to a stable 3×3 anchor zone (for anchorId/justify semantics).
        const hBand = (col < 14) ? 0 : (col < 28 ? 1 : 2);
        const vBand = (row <= 5) ? 0 : (row <= 10 ? 1 : 2);
        const an = (
          vBand === 0 ? (hBand === 0 ? 7 : (hBand === 1 ? 8 : 9)) :
          vBand === 1 ? (hBand === 0 ? 4 : (hBand === 1 ? 5 : 6)) :
                        (hBand === 0 ? 1 : (hBand === 1 ? 2 : 3))
        );
        const base = _assAnTo708WindowOverride(an) || { anchorId: 7, justify: 'center' };

        // Convert grid coordinates to 0..99 relative anchor percentages.
        const anchorH = Math.round((col / Math.max(1, cols - 1)) * 99);
        const anchorV = Math.round(((Math.max(1, Math.min(15, row)) - 1) / 14) * 99);

        const active = _getActiveCueForPlacement();
        if (!active) return;
        const cue = active.cue;

        // Persist the exact placement as a per-cue 708 window override.
        cue.overrides = (cue.overrides && typeof cue.overrides === 'object') ? cue.overrides : {};
        cue.overrides['708'] = (cue.overrides['708'] && typeof cue.overrides['708'] === 'object') ? cue.overrides['708'] : {};
        cue.overrides['708'].window = {
          rel: true,
          anchorId: base.anchorId,
          anchorH,
          anchorV,
          justify: base.justify
        };

        // Also store the derived zone so switching back to "Zones" mode highlights sensibly.
        cue.cea708Placement = (cue.cea708Placement && typeof cue.cea708Placement === 'object')
          ? cue.cea708Placement
          : {};
        cue.cea708Placement.an = an;

        try { markDirty(); } catch {}
        try { renderActiveCue608(); } catch {}
        api.refreshInspector();
        return;
      }

      // 608: click-to-place selects a specific row/column.
      if (!target.classList.contains('col-hit')) return;

      const col = Math.max(0, Math.min(31, Math.trunc(Number(target.dataset.col || 0))));
      const row = nearestRow(ev.clientY);

      const activeCueEl = root?.querySelector('.cue.active') || root?.querySelector('.cue:focus-within');
      if (!activeCueEl) return;
      const idx = Number(activeCueEl.dataset.index || -1);
      if (!Number.isInteger(idx) || idx < 0 || !state.doc?.cues?.[idx]) return;

      const doc = state.doc;
      const cues = Array.isArray(doc?.cues) ? doc.cues : [];
      const cue = cues[idx];
      if (!cue) return;

      // Build the list of visible/movable 608 rows (top→bottom).
      const items = _get608PlacementItems(idx, activeCueEl);
      if (!items.length) return;

      const clampCol = (n) => _clampInt(n, 0, 31, 0);
      const clampRow = (n, min = 1, max = 15) => _clampInt(n, min, max, 15);

      const mode = _normalize608PlacementTarget(placementTarget608);

      // Default marker target:
      //  - block: bottom row
      //  - line1: top row
      //  - line2: bottom row
      const targetIdx = (mode === 'line1') ? 0 : Math.min(1, items.length - 1);

      // Move BOTH rows together (block) while preserving their current relative offset.
      if (mode === 'block' && items.length >= 2) {
        const top = items[0];
        const bottom = items[items.length - 1];

        const topPl = top.placement || _readPlacementForCueLine(cues[top.cueIndex], top.lineIndex) || null;
        const bottomPl = bottom.placement || _readPlacementForCueLine(cues[bottom.cueIndex], bottom.lineIndex) || null;

        const topRow = Number.isFinite(topPl?.row) ? topPl.row : 14;
        const bottomRow = Number.isFinite(bottomPl?.row) ? bottomPl.row : 15;
        const deltaRow = Math.max(1, Math.round(bottomRow - topRow) || 1);

        const topCol = Number.isFinite(topPl?.col) ? topPl.col : col;
        const bottomCol = Number.isFinite(bottomPl?.col) ? bottomPl.col : col;
        const deltaCol = Math.round(bottomCol - topCol) || 0;

        // Interpret click as the BOTTOM row target so row=15 naturally becomes 14/15 for 2-line captions.
        const newBottomRow = clampRow(row, 1 + deltaRow, 15);
        const newTopRow = clampRow(newBottomRow - deltaRow, 1, 15);

        const newBottomCol = clampCol(col);
        const newTopCol = clampCol(newBottomCol - deltaCol);

        _writePlacementForCueLine(cues[top.cueIndex], top.lineIndex, newTopRow, newTopCol);
        _writePlacementForCueLine(cues[bottom.cueIndex], bottom.lineIndex, newBottomRow, newBottomCol);

        pendingLineIndex = 1;
        updateMarker(newBottomRow, newBottomCol);
      } else {
        // Move a single row (top or bottom).
        const it = items[targetIdx] || items[0];

        let newRow = clampRow(row);
        const newCol = clampCol(col);

        if (items.length >= 2) {
          const top = items[0];
          const bottom = items[items.length - 1];
          const topRowCur = Number.isFinite(top.placement?.row) ? top.placement.row : 14;
          const bottomRowCur = Number.isFinite(bottom.placement?.row) ? bottom.placement.row : 15;

          // Maintain a strict top/bottom ordering to keep line targeting predictable.
          if (targetIdx === 0) {
            newRow = clampRow(Math.min(newRow, bottomRowCur - 1), 1, 14);
          } else {
            newRow = clampRow(Math.max(newRow, topRowCur + 1), 2, 15);
          }
        }

        _writePlacementForCueLine(cues[it.cueIndex], it.lineIndex, newRow, newCol);
        pendingLineIndex = targetIdx;
        updateMarker(newRow, newCol);
      }

      // Mark the document dirty so MCC preview + QC re-run.
      try { markDirty(); } catch {}
      try { renderActiveCue608(); } catch {}
      api.refreshInspector();
    };

    const api = {
      setHost(newPreview, newVideo) {
        preview = newPreview || preview;
        video = newVideo || video;
        overlayEl = null;
        captionLayer = null;
        captionLayer708 = null;
        // Force a fresh layout on next rebuild
        lastSize = { w: 0, h: 0 };
      },
      setTrack,
      render608,
      render708,
      setPlacementEnabled,
      set708PlacementMode,
      set608PlacementTarget,
      setGuidesVisible(v = true) {
        guidesVisible = !!v;
        if (!overlayEl) return;
        // UI policy:
        //  - 608: Keep the default view clean by showing only the title-safe band (rows 12–15),
        //         but show the full 1–15 grid when the inspector is enabled or click-to-place is on.
        //  - 708: Always show the full 15-row grid when guides are enabled (debuggable geometry)
        const showAllRows = (track === '708') ? true : (!!placementEnabled || !!showInspector);
        overlayEl.querySelectorAll('.row-guide').forEach((el) => {
          const row = Number(el.dataset.row);
          const inTitleSafeBand = (row >= 12 && row <= 15);
          const showThisRow = guidesVisible && (showAllRows ? true : inTitleSafeBand);
          el.style.display = showThisRow ? 'block' : 'none';
        });
        // Column grid lines are controlled by the safe-area toggle.
        // ensureGrid() also provides the pointer-events surface for click-to-place.
        ensureGrid();

        // Vertical guides (title-safe + safeMargins) should always be visible when guides are on.
        overlayEl.querySelectorAll('.col-guide').forEach((el) => {
          el.style.display = guidesVisible ? 'block' : 'none';
        });
        // Re-layout in case safeMargins have changed.
        try { layoutColGuides(overlayEl.getBoundingClientRect()); } catch {}
      },
      enable(v = true) {
        enabled = !!v;
        if (!enabled) {
          // Keep captions & grid machinery alive; just hide overlays.
          if (overlayEl) {
            overlayEl.style.display = 'none';
          }
          // When switching into web-caption mode, ensure the broadcast inspector
          // does not linger in the shared status strip.
          if (inspectorEl) {
            try { inspectorEl.textContent = ''; } catch {}
            try { inspectorEl.style.display = 'none'; } catch {}
          }
        } else {
          // Reset cached size so guides are laid out even if dimensions didn’t change.
          lastSize = { w: 0, h: 0 };
          api.rebuild();
          if (overlayEl) {
            overlayEl.style.display = 'block';
          }
          // Restore inspector visibility based on the current preference.
          if (inspectorEl) {
            try { inspectorEl.style.display = showInspector ? '' : 'none'; } catch {}
          }
          if (showInspector) {
            try { api.refreshInspector(); } catch {}
          }
        }
      },
      toggleInspector(v = true) {
        showInspector = !!v;
        if (!showInspector) {
          if (inspectorEl) { inspectorEl.textContent = ''; inspectorEl.style.display = 'none'; }
          if (overlayEl) overlayEl.querySelectorAll('.row-guide').forEach(el => el.classList.remove('highlight'));
        } else {
          if (inspectorEl) inspectorEl.style.display = '';
          api.refreshInspector();
        }

        // Row-guide visibility policy depends on showInspector for 608.
        // Re-apply guide display rules immediately when the inspector toggle changes.
        try { api.setGuidesVisible(guidesVisible); } catch {}
      },
      rebuild() {
        if (!preview) return api.destroy();
        // Commit 3: when disabled, the controller must remain inert. In particular,
        // it must NOT create new overlays/layers (which would leak SCC/MCC grids
        // into SRT/VTT sessions).
        if (!enabled) {
          if (overlayEl) overlayEl.style.display = 'none';
          return;
        }
        // Use the video box if available so rows map to the actual picture height
        const rect = (video || preview).getBoundingClientRect();
        if (!overlayEl) {
          overlayEl = document.createElement('div');
          overlayEl.className = 'safe-title-overlay';
          // Build row guides for the full 608 grid (1..15).
          // Visibility is controlled by setGuidesVisible():
          //   - normal: show 12–15
          //   - row/indent inspector or click-to-place: show 1–15
          (() => {
            const frag = document.createDocumentFragment();
            for (let r = 1; r <= 15; r++) {
              const d = document.createElement('div');
              d.className = 'row-guide';
              d.dataset.row = String(r);
              // Only label the title-safe band to keep the UI clean in normal mode
              // (labels still exist for all rows when placement mode is enabled).
              const label = document.createElement('span');
              label.className = 'row-label';
              label.textContent = String(r);
              d.appendChild(label);
              frag.appendChild(d);
            }
            overlayEl.appendChild(frag);
          })();

          // Vertical guides:
          //  - Title-safe boundaries (inner 80% of active aperture)
          //  - Export safeMargins boundaries (column-based left/right clip)
          (() => {
            const frag = document.createDocumentFragment();
            const mk = (kind, klass, labelText) => {
              const d = document.createElement('div');
              d.className = `col-guide ${klass}`;
              d.dataset.kind = kind;
              const label = document.createElement('span');
              label.className = 'col-label';
              label.textContent = labelText;
              d.appendChild(label);
              frag.appendChild(d);
            };
            mk('title-safe-left', 'title-safe', 'TS');
            mk('title-safe-right', 'title-safe', 'TS');
            mk('margin-left', 'margin', 'ML');
            mk('margin-right', 'margin', 'MR');
            overlayEl.appendChild(frag);
          })();
          preview.appendChild(overlayEl);
          // Make the overlay fill its host explicitly (robust to external CSS)
          overlayEl.style.position = 'absolute';
          overlayEl.style.top = '0';
          overlayEl.style.left = '0';
          overlayEl.style.right = '0';
          overlayEl.style.bottom = '0';
          ensureGrid();
          ensureZoneGrid();
          if (!overlayEl.__clickPlaceBound) {
            overlayEl.addEventListener('click', onOverlayClick);
            overlayEl.__clickPlaceBound = true;
          }
          // Always lay out guides right after creation, even if size didn’t change
          layoutGuides(rect.height);
          ensureCaptionCSS();
          ensureCaptionLayer();
        }
        if (Math.abs(lastSize.w - rect.width) > 1 || Math.abs(lastSize.h - rect.height) > 1) {
          lastSize = { w: rect.width, h: rect.height };
          layoutGuides(rect.height);
          ensureCaptionLayer();
        }
        ensureGrid();
        ensureCaptionLayer();
        ensureZoneGrid();
        api.setGuidesVisible(guidesVisible);
        if (!placementEnabled) hidePlacementMarker();
      },
      refreshInspector() {
        if (!inspectorEl || !showInspector) return;
        inspectorEl.textContent = '';
        if (!root) return;
        const active = root.querySelector('.cue.active') || root.querySelector('.cue:focus-within');
        if (!active) return;
        const idx = Number(active.dataset?.index ?? -1);
        if (!Number.isInteger(idx) || idx < 0) return;
        if (idx !== lastActiveCue) {
          lastActiveCue = idx;
          pendingLineIndex = 0;
        }
        const ta = active.querySelector('textarea') || active.querySelector('input[type="text"]');
        if (!ta) return;
        const lines = (ta.value || '').split(/\r?\n/);
        const maxLen = Math.max(0, ...lines.map(l => l.length));
        const indent = /^(\s*)/.exec(lines[0] || '')?.[1]?.length ?? 0;
        const cue = state.doc?.cues?.[idx];
        // Keep the 708 zone-grid highlight in sync with the active cue.
        try { ensureZoneGrid(); } catch {}

        // Optional per-cue 708 placement:
        //  - overrides['708'].window: exact window anchor (highest priority)
        //  - cea708Placement.an: 3×3 zone (\an1..\an9)
        const winRaw = cue?.overrides?.['708']?.window;
        const win = (winRaw && typeof winRaw === 'object') ? winRaw : null;

        const anRaw = cue?.cea708Placement?.an ?? cue?.cea708Placement?.assAn ?? cue?.cea708An;
        const anNum = Number(anRaw);
        const an = Number.isFinite(anNum) ? Math.max(1, Math.min(9, Math.trunc(anNum))) : null;
        const placements = (() => {
          const p = Array.isArray(cue?.overrides?.['608']?.placement) ? cue.overrides['608'].placement : null;
          if (p && p.length) return p;
          return (cue && cue.sccPlacement) ? cue.sccPlacement : null;
        })();
        const hints = [];
        if (win) {
          const rel = (win.rel ?? win.relative);
          const isRel = (rel === false) ? false : true;
          const denomH = isRel ? 99 : 209;
          const denomV = isRel ? 99 : 74;
          const anchorId = Number.isFinite(Number(win.anchorId)) ? Math.trunc(Number(win.anchorId)) : null;
          const anchorH = Number.isFinite(Number(win.anchorH)) ? Math.trunc(Number(win.anchorH)) : null;
          const anchorV = Number.isFinite(Number(win.anchorV)) ? Math.trunc(Number(win.anchorV)) : null;
          const justify = String(win.justify || '').trim().toLowerCase();
          const parts = [`708 exact: ${isRel ? 'rel' : 'abs'}`];
          if (justify) parts.push(justify);
          if (anchorId != null) parts.push(`id ${anchorId}`);
          if (anchorH != null) parts.push(`H ${anchorH}/${denomH}`);
          if (anchorV != null) parts.push(`V ${anchorV}/${denomV}`);
          hints.push(parts.join(' '));
        } else if (an) {
          const name = _nameForAssAn(an);
          if (name) hints.push(`708: ${name}`);
        }
        if (placements) {
          for (const lineIdx of [0, 1]) {
            const pl = placements[lineIdx];
            if (!pl || !Number.isFinite(pl.row) || !Number.isFinite(pl.col)) continue;
            hints.push(`L${lineIdx + 1}: row ${pl.row}, col ${pl.col} → ${placementPac(pl.row, pl.col)}`);
          }
          if (placementEnabled && track === '608') {
            const pref = placements[pendingLineIndex] || placements[0] || placements[1];
            if (pref && Number.isFinite(pref.row) && Number.isFinite(pref.col)) {
              updateMarker(pref.row, pref.col, { silent: true });
            } else {
              hidePlacementMarker();
            }
          } else if (placementEnabled) {
            // 708 placement mode uses the 3×3 zone grid, not the 608 row/col marker.
            hidePlacementMarker();
          }
        } else if (placementEnabled) {
          hidePlacementMarker();
        }
        const msg = `Lines: ${lines.length} | Max Len: ${maxLen} | Indent: ${indent}`;
        inspectorEl.textContent = hints.length ? `${msg} | ${hints.join(' | ')}` : msg;
        if (overlayEl) {
          overlayEl.querySelectorAll('.row-guide').forEach(el => el.classList.remove('highlight'));
          // Keep the old behavior of highlighting within the title-safe band by default:
          //  - 1 line highlights row 15
          //  - 2 lines highlights row 14
          const row = (lines.length <= 1) ? 15 : 14;
          const guide = overlayEl.querySelector(`.row-guide[data-row="${row}"]`);
          if (guide) guide.classList.add('highlight');
        }
      },
      destroy() {
        if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
        overlayEl = null;
        captionLayer = null;
        captionLayer708 = null;
        hidePlacementMarker();
      }
    };
    return api;
  }

  // ---- Timecode helpers ----------------------------------------------------

  let __timecodeFatal = null;
  function _timecodeFailOnce(message) {
    if (__timecodeFatal) return;
    __timecodeFatal = String(message || 'Timecode error');
    try { setStatus(__timecodeFatal, true); } catch {}
  }


  function formatSecondsGeneric(seconds = 0, msSep = '.') {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) seconds = 0;
    const totalMs = Math.max(0, Math.round(seconds * 1000));
    const ms = String(totalMs % 1000).padStart(3, '0');
    const totalSeconds = Math.floor(totalMs / 1000);
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60) % 60;
    const h = Math.floor(totalSeconds / 3600);
    const sep = (msSep === ',' ? ',' : '.');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${ms}`;
  }

  function parseSecondsGeneric(value, fallback = 0) {
    if (typeof value === 'number') return value;
    const str = (value || '').trim();
    if (!str) return fallback;
    if (/^\d+(?:\.\d+)?$/.test(str)) return parseFloat(str);
    const match = str.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (match) {
      const h = parseInt(match[1], 10) || 0;
      const m = parseInt(match[2], 10) || 0;
      const s = parseInt(match[3], 10) || 0;
      const ms = parseInt((match[4] || '').padEnd(3, '0'), 10) || 0;
      return h * 3600 + m * 60 + s + ms / 1000;
    }
    return fallback;
  }

  function formatSecondsSmpte(seconds = 0, doc) {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) seconds = 0;
    const fps = Number(doc?.fps) || 29.97;
    const drop = !!doc?.dropFrame;

    // Compute Start TC offset STRICTLY (no silent fallback).
    let offsetSec = 0;
    if (doc && doc.keepAbsoluteTimecode !== true) {
      const baseTc = _getDocStartTimecodeLabel(doc);
      if (baseTc) {
        const parseFn = window.transcribeEngine?.parseTime;
        if (typeof parseFn !== 'function') {
          _timecodeFailOnce('Timecode parser unavailable (transcribeEngine.parseTime missing in preload).');
          return 'TC_ERR';
        }
        try {
          const ms = parseFn(baseTc, fps, drop ? true : null);
          if (typeof ms !== 'number' || Number.isNaN(ms)) return 'TC_ERR';
          offsetSec = ms / 1000;
        } catch (err) {
          console.error('Start TC parse failed (no fallback allowed)', err);
          _timecodeFailOnce('Start TC parse failed (no fallback). See console for details.');
          return 'TC_ERR';
        }
      }
    }

    const displaySec = Math.max(0, seconds + offsetSec);

    const fmtFn = window.transcribeEngine?.formatTimecode;
    if (typeof fmtFn !== 'function') {
      _timecodeFailOnce('Timecode formatter unavailable (transcribeEngine.formatTimecode missing in preload).');
      return 'TC_ERR';
    }

    try {
      // Use nearest-frame rounding so Start TC aligns at t=0 (especially important for DF rates).
      const out = fmtFn(displaySec, drop, fps, 'colon', 'nearest');
      return (typeof out === 'string' && out.trim()) ? out : 'TC_ERR';
    } catch (err) {
      console.error('formatTimecode failed (no fallback allowed)', err);
      _timecodeFailOnce('Timecode formatter failed (no fallback). See console for details.');
      return 'TC_ERR';
    }
  }



  function parseSecondsSmpte(value, doc, fallback = 0) {
    if (typeof value === 'number') return value;
    const str = (value || '').trim();
    if (!str) return fallback;

    const fps = Number(doc?.fps) || 29.97;
    const drop = !!doc?.dropFrame;
    const offsetSec = _getDocTimecodeOffsetSeconds(doc);

    const parseFn = window.transcribeEngine?.parseTime;
    if (typeof parseFn !== 'function') {
      _timecodeFailOnce('Timecode parser unavailable (transcribeEngine.parseTime missing in preload).');
      return fallback;
    }

    try {
      const ms = parseFn(str, fps, drop ? true : null);
      if (typeof ms === 'number' && !Number.isNaN(ms)) {
        return Math.max(0, (ms / 1000) - offsetSec);
      }
    } catch (err) {
      console.error('parseSecondsSmpte: parseTime failed (no fallback allowed)', err);
      _timecodeFailOnce('Timecode parser failed (no fallback). See console for details.');
    }

    return fallback;
  }


  // Public helpers used throughout this module
  function formatSeconds(seconds = 0) {
    if (usesSmpteTimecode(state.doc)) {
      return formatSecondsSmpte(seconds, state.doc);
    }
    // Web captions: SRT uses comma milliseconds, VTT uses dot milliseconds.
    const msSep = isSrtDoc(state.doc) ? ',' : '.';
    return formatSecondsGeneric(seconds, msSep);
  }

  function parseSeconds(value, fallback = 0) {
    if (usesSmpteTimecode(state.doc)) {
      return parseSecondsSmpte(value, state.doc, fallback);
    }
    return parseSecondsGeneric(value, fallback);
  }

  function _getCompat608OverrideText(cue) {
    if (!cue) return '';
    // Phase 1: per-cue overrides schema (preferred)
    const o = cue.overrides;
    if (o && typeof o === 'object') {
      const o608 = o['608'];
      if (o608 && typeof o608 === 'object') {
        if (typeof o608.text === 'string' && o608.text.trim()) return o608.text;
        if (Array.isArray(o608.breaks) && o608.breaks.length) {
          const joined = o608.breaks.map(l => String(l || '')).join('\n');
          if (joined.trim()) return joined;
        }
      }
    }
    const direct = (typeof cue.compat608Text === 'string') ? cue.compat608Text : '';
    if (direct.trim()) return direct;
    const c = cue.compat608;
    if (c && typeof c === 'object' && Array.isArray(c.lines) && c.lines.length) {
      return c.lines.join('\n');
    }
    if (typeof c === 'string' && c.trim()) return c;
    return '';
  }

  function _setCompat608OverrideText(cue, text, opts = {}) {
    if (!cue) return;
    const { skipUndo = false, groupId = null, undoLabel = 'Edit 608 override' } = opts || {};
    if (!skipUndo) pushUndo(undoLabel, groupId);
    const raw = String(text || '').replace(/\r\n?/g, '\n');
    const trimmed = raw.trim();

    // Phase 1: store in overrides['608'] as authoritative.
    if (!cue.overrides || typeof cue.overrides !== 'object') cue.overrides = {};
    if (!cue.overrides['608'] || typeof cue.overrides['608'] !== 'object') cue.overrides['608'] = {};
    const o608 = cue.overrides['608'];
    // Nullable override semantics: null means inherit.
    o608.text = trimmed ? raw : null;
    o608.breaks = null;
    o608.parts = null;
    o608.mute = null;
    // Track staleness by remembering the canonical fingerprint at the moment this override was set.
    try {
      o608._baseCanonicalTextFp = _fingerprintText(_cueTextForEditing(cue));
    } catch {
      o608._baseCanonicalTextFp = null;
    }
    o608.overridePossiblyStale = false;

    // Keep legacy fields in sync for backward compatibility.
    cue.compat608Text = trimmed ? raw : '';
    // Normalize to a single legacy representation; encoder supports either, but we keep it simple.
    if (cue.compat608) delete cue.compat608;
  }

  

  function _setCompat608OverrideBreaks(cue, breaks, opts = {}) {
    if (!cue) return;
    const { skipUndo = false, groupId = null, undoLabel = 'Edit 608 override' } = opts || {};
    if (!skipUndo) pushUndo(undoLabel, groupId);
    const rawLines = Array.isArray(breaks)
      ? breaks
      : String(breaks ?? '').replace(/\r\n?/g, '\n').split('\n');

    const lines = rawLines.map(l => String(l ?? '').replace(/\r\n?/g, '').trimEnd());

    // Keep up to 2 lines; collapse extras into the last line so we never lose words silently.
    const out = [];
    for (const ln of lines) {
      if (!ln && out.length === 0) continue;
      if (out.length < 2) out.push(ln);
      else out[out.length - 1] = `${String(out[out.length - 1] || '').trim()} ${ln}`.trim();
    }

    while (out.length > 0 && !String(out[out.length - 1] || '').trim()) out.pop();

    if (!out.length) {
      _clearCompat608Override(cue, { skipUndo: true });
      return;
    }

    // Phase 1: store in overrides['608'] as authoritative.
    if (!cue.overrides || typeof cue.overrides !== 'object') cue.overrides = {};
    if (!cue.overrides['608'] || typeof cue.overrides['608'] !== 'object') cue.overrides['608'] = {};
    const o608 = cue.overrides['608'];

    // Nullable override semantics: null means inherit.
    o608.text = null;
    o608.breaks = out.slice(0, 2);
    o608.parts = null;
    o608.mute = null;

    // Track staleness by remembering the canonical fingerprint at the moment this override was set.
    try {
      o608._baseCanonicalTextFp = _fingerprintText(_cueTextForEditing(cue));
    } catch {
      o608._baseCanonicalTextFp = null;
    }
    o608.overridePossiblyStale = false;

    // Keep legacy fields in sync for backward compatibility.
    cue.compat608Text = o608.breaks.join('\n');
    if (cue.compat608) delete cue.compat608;
  }

  function _setCompat608OverrideParts(cue, parts, opts = {}) {
    if (!cue) return;
    const { skipUndo = false, groupId = null, undoLabel = 'Edit 608 override' } = opts || {};
    if (!skipUndo) pushUndo(undoLabel, groupId);
    const raw = Array.isArray(parts) ? parts : [parts];
    const out = [];
    for (const p of raw) {
      if (p == null) continue;
      const s = String(p ?? '').replace(/\r\n?/g, '\n').trim();
      if (!s) continue;
      out.push({ text: s });
    }

    if (!out.length) {
      _clearCompat608Override(cue, { skipUndo: true });
      return;
    }

    // Phase 1: store in overrides['608'] as authoritative.
    if (!cue.overrides || typeof cue.overrides !== 'object') cue.overrides = {};
    if (!cue.overrides['608'] || typeof cue.overrides['608'] !== 'object') cue.overrides['608'] = {};
    const o608 = cue.overrides['608'];

    o608.parts = out;
    o608.text = null;
    o608.breaks = null;
    o608.mute = null;

    // Track staleness.
    try {
      o608._baseCanonicalTextFp = _fingerprintText(_cueTextForEditing(cue));
    } catch {
      o608._baseCanonicalTextFp = null;
    }
    o608.overridePossiblyStale = false;

    // Legacy representation can't express split parts cleanly.
    cue.compat608Text = '';
    if (cue.compat608) delete cue.compat608;
  }

  function _setCompat608OverrideMute(cue, muted = true, note = null, opts = {}) {
    if (!cue) return;
    const { skipUndo = false, groupId = null, undoLabel = 'Mute 608 override' } = opts || {};
    if (!skipUndo) pushUndo(undoLabel, groupId);

    // Phase 1: store in overrides['608'] as authoritative.
    if (!cue.overrides || typeof cue.overrides !== 'object') cue.overrides = {};
    if (!cue.overrides['608'] || typeof cue.overrides['608'] !== 'object') cue.overrides['608'] = {};
    const o608 = cue.overrides['608'];

    o608.mute = muted === true;
    o608.parts = null;
    o608.text = null;
    o608.breaks = null;
    o608.start = null;
    o608.end = null;
    if (note != null) o608.note = String(note || '').trim() || null;

    try {
      o608._baseCanonicalTextFp = _fingerprintText(_cueTextForEditing(cue));
    } catch {
      o608._baseCanonicalTextFp = null;
    }
    o608.overridePossiblyStale = false;

    cue.compat608Text = '';
    if (cue.compat608) delete cue.compat608;
  }

  function _extractCompat608OverridePartsTextList(cue) {
    if (!cue || typeof cue !== 'object') return null;
    const o = cue.overrides;
    if (!o || typeof o !== 'object') return null;
    const o608 = o['608'];
    if (!o608 || typeof o608 !== 'object') return null;

    const raw = o608.parts;
    if (!Array.isArray(raw) || !raw.length) return null;

    const out = [];
    for (const part of raw) {
      if (part == null) continue;
      let t = null;
      if (typeof part === 'string') t = part;
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') t = part.text;
        else if (Array.isArray(part.lines) && part.lines.length) t = part.lines.map(l => String(l ?? '')).join('\n');
        else if (typeof part.value === 'string') t = part.value;
      }
      const s = String(t ?? '').replace(/\r\n?/g, '\n').trim();
      if (s) out.push(s);
    }
    return out.length ? out : null;
  }

  function _isCompat608Muted(cue) {
    const o = cue?.overrides;
    const o608 = (o && typeof o === 'object') ? o['608'] : null;
    return !!(o608 && typeof o608 === 'object' && o608.mute === true);
  }

  function _hasAnyMeaningfulOverride608(cue) {
    if (!cue) return false;

    const o = cue.overrides;
    if (o && typeof o === 'object') {
      const o608 = o['608'];
      if (o608 && typeof o608 === 'object') {
        if (o608.mute === true) return true;
        if (o608.start != null) return true;
        if (o608.end != null) return true;
        if (typeof o608.text === 'string' && o608.text.trim()) return true;
        if (Array.isArray(o608.breaks) && o608.breaks.some(l => String(l ?? '').trim())) return true;
        if (Array.isArray(o608.parts) && o608.parts.length) {
          const parts = _extractCompat608OverridePartsTextList(cue);
          if (parts && parts.length) return true;
        }
        if (typeof o608.note === 'string' && o608.note.trim()) return true;
      }
    }

    const legacy = (typeof cue.compat608Text === 'string') ? cue.compat608Text : '';
    return !!legacy.trim();
  }

function _clearCompat608Override(cue, opts = {}) {
    if (!cue) return;
    const { skipUndo = false, groupId = null, undoLabel = 'Clear 608 override' } = opts || {};
    if (!skipUndo) pushUndo(undoLabel, groupId);
    // Phase 1: clear schema overrides
    const o = cue.overrides;
    if (o && typeof o === 'object' && o['608'] && typeof o['608'] === 'object') {
      const o608 = o['608'];
      o608.start = null;
      o608.end = null;
      o608.text = null;
      o608.breaks = null;
      o608.parts = null;
      o608.mute = null;
      o608.note = null;
      o608._baseCanonicalTextFp = null;
      o608.overridePossiblyStale = false;
    }
    if (cue.compat608Text != null) delete cue.compat608Text;
    if (cue.compat608 != null) delete cue.compat608;
  }

  function _normalizeTextForFingerprint(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').trim();
  }

  // Fast, deterministic 32-bit FNV-1a fingerprint (matches utils/cueSchema.js).
  function _fingerprintText(text) {
    const s = _normalizeTextForFingerprint(text);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function _isOverridePossiblyStale608(cue) {
    if (!cue || typeof cue !== 'object') return false;
    const o = cue.overrides;
    const o608 = (o && typeof o === 'object') ? o['608'] : null;
    if (!o608 || typeof o608 !== 'object') return false;
    const hasOverride = (o608.text != null && String(o608.text).trim()) || (Array.isArray(o608.breaks) && o608.breaks.length);
    if (!hasOverride) return false;
    const base = o608._baseCanonicalTextFp;
    if (!base) return false;
    const cur = _fingerprintText(_cueTextForEditing(cue));
    return base !== cur;
  }

  // --- Phase 4: 708 per-cue text overrides (independent of canonical + 608) ---
  function _getOverride708Text(cue) {
    if (!cue || typeof cue !== 'object') return '';
    const o = cue.overrides;
    const o708 = (o && typeof o === 'object') ? o['708'] : null;
    if (o708 && typeof o708 === 'object' && typeof o708.text === 'string' && o708.text.trim()) {
      return o708.text;
    }
    return '';
  }

  function _setOverride708Text(cue, text, opts = {}) {
    if (!cue || typeof cue !== 'object') return;
    const { skipUndo = false, groupId = null, undoLabel = 'Edit 708 override' } = opts || {};
    if (!skipUndo) pushUndo(undoLabel, groupId);
    const raw = String(text || '').replace(/\r\n?/g, '\n');
    const trimmed = raw.trim();

    if (!cue.overrides || typeof cue.overrides !== 'object') cue.overrides = {};
    if (!cue.overrides['708'] || typeof cue.overrides['708'] !== 'object') cue.overrides['708'] = {};
    const o708 = cue.overrides['708'];

    // Nullable override semantics: null means inherit canonical.
    o708.text = trimmed ? raw : null;
    // Track staleness by remembering the canonical fingerprint at the moment this override was set.
    try {
      o708._baseCanonicalTextFp = _fingerprintText(_cueTextForEditing(cue));
    } catch {
      o708._baseCanonicalTextFp = null;
    }
    o708.overridePossiblyStale = false;
  }

  function _clearOverride708(cue, opts = {}) {
    if (!cue || typeof cue !== 'object') return;
    const { skipUndo = false, groupId = null, undoLabel = 'Clear 708 override' } = opts || {};
    if (!skipUndo) pushUndo(undoLabel, groupId);
    const o = cue.overrides;
    if (o && typeof o === 'object' && o['708'] && typeof o['708'] === 'object') {
      const o708 = o['708'];
      o708.text = null;
      o708._baseCanonicalTextFp = null;
      o708.overridePossiblyStale = false;
    }
  }

  function _isOverridePossiblyStale708(cue) {
    if (!cue || typeof cue !== 'object') return false;
    const o = cue.overrides;
    const o708 = (o && typeof o === 'object') ? o['708'] : null;
    if (!o708 || typeof o708 !== 'object') return false;
    const hasOverride = (o708.text != null && String(o708.text).trim());
    if (!hasOverride) return false;
    const base = o708._baseCanonicalTextFp;
    if (!base) return false;
    const cur = _fingerprintText(_cueTextForEditing(cue));
    return base !== cur;
  }

  function _normalize608CompareText(text) {
    // Normalize for “is this effectively the same output?” comparisons.
    // 608 indentation should be driven by PAC/placement, not spaces in the line.
    return String(text ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(l => String(l ?? '').trim())
      .filter(l => l.length)
      .join('\n')
      .trim();
  }

  function _compat608DiffSummary(derivedText, overrideText) {
    const a = _normalize608CompareText(derivedText);
    const b = _normalize608CompareText(overrideText);
    if (!a && !b) return '';
    const aLines = a ? a.split('\n').length : 0;
    const bLines = b ? b.split('\n').length : 0;
    const aChars = a.length;
    const bChars = b.length;
    const dLines = bLines - aLines;
    const dChars = bChars - aChars;
    const parts = [];
    if (dLines) parts.push(`${dLines > 0 ? '+' : ''}${dLines} line${Math.abs(dLines) === 1 ? '' : 's'}`);
    if (dChars) parts.push(`${dChars > 0 ? '+' : ''}${dChars} chars`);
    return parts.join(', ');
  }

  // Derive a 608-safe preview cue from the canonical cue without mutating it.
  // This is used as a fallback when the MCC round-trip preview pipeline isn't available.
  function _stripStylingFor608(text, { preserveNewlines = false } = {}) {
    let s = String(text ?? '');
    s = s.replace(/\r\n?/g, '\n');

    // Remove common styling containers.
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/\{[^}]*\}/g, '');

    // Normalize punctuation to be 608-friendly.
    s = s
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ')
      .replace(/`/g, "'");

    if (preserveNewlines) {
      // Collapse spaces/tabs but keep explicit newlines.
      s = s.replace(/[\t ]+/g, ' ');
      s = s.replace(/ *\n */g, '\n');
    } else {
      // Treat line breaks as spaces for 608 derivation (608 must be rewrapped).
      s = s.replace(/\n+/g, ' ');
      s = s.replace(/\s+/g, ' ');
    }

    return s.trim();
  }

  function _wrapTextGreedy(text, maxChars, maxLines) {
    const out = [];
    let truncated = false;

    const pushLine = (ln) => {
      if (out.length >= maxLines) {
        truncated = true;
        return false;
      }
      out.push(String(ln ?? '').slice(0, maxChars));
      return out.length < maxLines;
    };

    const parts = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    for (const part of parts) {
      const raw = String(part ?? '').trim();
      if (!raw) continue;

      const words = raw.split(/\s+/g).filter(Boolean);
      let cur = '';

      for (const w of words) {
        const word = String(w);

        if (!cur) {
          if (word.length <= maxChars) {
            cur = word;
            continue;
          }
          // Single overlong word: hard-clamp.
          if (!pushLine(word.slice(0, maxChars))) return { lines: out, truncated: true };
          continue;
        }

        if ((cur.length + 1 + word.length) <= maxChars) {
          cur += ' ' + word;
          continue;
        }

        if (!pushLine(cur)) return { lines: out, truncated: true };
        cur = (word.length <= maxChars) ? word : '';

        if (!cur && word.length > maxChars) {
          if (!pushLine(word.slice(0, maxChars))) return { lines: out, truncated: true };
        }
      }

      if (cur) {
        if (!pushLine(cur)) return { lines: out, truncated: true };
      }
    }

    return { lines: out, truncated };
  }

  function _applyTruncationEllipsis(lines, maxChars) {
    if (!Array.isArray(lines) || !lines.length) return lines;
    const ell = '…';
    const lastIdx = lines.length - 1;
    let last = String(lines[lastIdx] ?? '');
    if (last.includes(ell)) return lines;

    if (last.length >= maxChars) last = last.slice(0, Math.max(0, maxChars - 1));
    last = last.replace(/\s+$/g, '');
    lines[lastIdx] = (last + ell).slice(0, maxChars);
    return lines;
  }

  function _center608Line(line, maxChars) {
    const s = String(line ?? '').replace(/\s+$/g, '');
    const pad = Math.max(0, Math.floor((maxChars - s.length) / 2));
    return (' '.repeat(pad) + s).slice(0, maxChars);
  }

    // Preview-only helpers for 608 derivation.
  // The goal: match the encoder's practical behavior (32 cols, 2 lines, safe margins),
  // even when the round-trip preview pipeline isn't available.
  const _MIDROW_TOKENS_RE_608_PREVIEW = /\{(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g;

  function _visible608LengthForPreview(text) {
    // Mid-row attribute tokens occupy one blank cell on real decoders.
    const s = String(text || '').replace(_MIDROW_TOKENS_RE_608_PREVIEW, ' ');
    return Array.from(s).length;
  }

  function _read608AlignmentForPreview(doc) {
    // MCC uses its own alignment preference which also drives the 608 PAC placement.
    let a =
      doc?.mccOptions?.alignment ??
      doc?.sccOptions?.alignment ??
      null;

    if (!a) {
      try { a = localStorage.getItem('mcc-alignment') || localStorage.getItem('scc-alignment'); } catch { a = null; }
    }

    a = String(a || 'left').trim().toLowerCase();
    if (!['left', 'center', 'right'].includes(a)) a = 'left';
    return a;
  }

  function _read608SafeMarginsForPreview(doc) {
    // Match export behavior: prefer doc values, then MCC prefs, then SCC prefs.
    let left = Number(doc?.sccOptions?.safeMargins?.left);
    let right = Number(doc?.sccOptions?.safeMargins?.right);

    if (!Number.isFinite(left)) left = Number(doc?.mccOptions?.safeMargins?.left);
    if (!Number.isFinite(right)) right = Number(doc?.mccOptions?.safeMargins?.right);

    if (!Number.isFinite(left)) {
      try {
        const raw = localStorage.getItem('mcc-safe-left') || localStorage.getItem('scc-safe-left') || '0';
        left = parseInt(raw, 10);
      } catch { left = 0; }
    }
    if (!Number.isFinite(right)) {
      try {
        const raw = localStorage.getItem('mcc-safe-right') || localStorage.getItem('scc-safe-right') || '0';
        right = parseInt(raw, 10);
      } catch { right = 0; }
    }

    left = Math.max(0, Math.min(15, Math.trunc(left || 0)));
    right = Math.max(0, Math.min(15, Math.trunc(right || 0)));
    const width = Math.max(1, 32 - left - right);

    return { left, right, width };
  }

  function _rowsFor608Preview(lineCount) {
    // Keep it simple and consistent with the encoder default (bottom2):
    // - 1 line => row 15
    // - 2 lines => rows 14–15
    if (lineCount <= 1) return [15];
    return [14, 15].slice(0, Math.min(2, lineCount));
  }

  function _startColFor608Preview(alignment, lineText, safe) {
    const len = Math.max(0, Math.min(32, _visible608LengthForPreview(lineText)));
    const safeLeft = Math.max(0, Math.min(31, safe?.left ?? 0));
    const safeWidth = Math.max(1, Math.min(32, safe?.width ?? (32 - safeLeft)));

    // If the line is as wide as (or wider than) the usable area, clamp to safe-left.
    if (len >= safeWidth) return safeLeft;

    const remaining = safeWidth - len;
    let col = safeLeft;

    if (alignment === 'right') col = safeLeft + remaining;
    else if (alignment === 'center') col = safeLeft + Math.floor(remaining / 2);

    return Math.max(0, Math.min(31, Math.trunc(col)));
  }

  function _assAnTo708WindowOverridePreview(an) {
    const n = Number(an) | 0;
    const TOP = 10, MID = 50, BOT = 90;
    const LEFT = 10, CTR = 50, RIGHT = 90;
    const map = {
      1: { rel: true, anchorId: 6, anchorV: BOT, anchorH: LEFT,  justify: 'left' },
      2: { rel: true, anchorId: 7, anchorV: BOT, anchorH: CTR,   justify: 'center' },
      3: { rel: true, anchorId: 8, anchorV: BOT, anchorH: RIGHT, justify: 'right' },
      4: { rel: true, anchorId: 3, anchorV: MID, anchorH: LEFT,  justify: 'left' },
      5: { rel: true, anchorId: 4, anchorV: MID, anchorH: CTR,   justify: 'center' },
      6: { rel: true, anchorId: 5, anchorV: MID, anchorH: RIGHT, justify: 'right' },
      7: { rel: true, anchorId: 0, anchorV: TOP, anchorH: LEFT,  justify: 'left' },
      8: { rel: true, anchorId: 1, anchorV: TOP, anchorH: CTR,   justify: 'center' },
      9: { rel: true, anchorId: 2, anchorV: TOP, anchorH: RIGHT, justify: 'right' }
    };
    return map[n] || null;
  }

  function _normalizeAlignment(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return null;
    if (s === 'left' || s === 'l' || s === 'start') return 'left';
    if (s === 'center' || s === 'centre' || s === 'c' || s === 'middle') return 'center';
    if (s === 'right' || s === 'r' || s === 'end') return 'right';
    return null;
  }

  function _normalize708WinFor608Derivation(raw, fallbackAlignment) {
    if (!raw || typeof raw !== 'object') return null;

    const rel = raw.rel !== false && raw.relative !== false;

    let anchorId = Number.isFinite(Number(raw.anchorId)) ? Math.trunc(Number(raw.anchorId)) : 7;
    anchorId = Math.max(0, Math.min(8, anchorId));

    let anchorV = Number.isFinite(Number(raw.anchorV)) ? Math.trunc(Number(raw.anchorV)) : (rel ? 90 : 67);
    let anchorH = Number.isFinite(Number(raw.anchorH)) ? Math.trunc(Number(raw.anchorH)) : (rel ? 50 : 105);

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    if (rel) {
      // If values look like absolute but rel=true, convert.
      const hLooksAbs = Number.isFinite(anchorH) && anchorH > 99;
      if (hLooksAbs) {
        const hAbs = clamp(anchorH, 0, 209);
        anchorH = Math.round((hAbs / 209) * 99);

        // If V is in abs range (<=74), convert it too.
        if (Number.isFinite(anchorV) && anchorV <= 74) {
          const vAbs = clamp(anchorV, 0, 74);
          anchorV = Math.round((vAbs / 74) * 99);
        }
      }
      anchorH = clamp(anchorH, 0, 99);
      anchorV = clamp(anchorV, 0, 99);
    } else {
      // If values look like relative but rel=false, convert.
      const hLooksRel = Number.isFinite(anchorH) && anchorH <= 99;
      const vLooksRel = Number.isFinite(anchorV) && anchorV > 74 && anchorV <= 99;
      if (hLooksRel) {
        const hRel = clamp(anchorH, 0, 99);
        anchorH = Math.round((hRel / 99) * 209);

        if (vLooksRel) {
          const vRel = clamp(anchorV, 0, 99);
          anchorV = Math.round((vRel / 99) * 74);
        }
      }
      anchorH = clamp(anchorH, 0, 209);
      anchorV = clamp(anchorV, 0, 74);
    }

    const justify = _normalizeAlignment(raw.justify) || _normalizeAlignment(fallbackAlignment) || 'left';
    return { rel, anchorId, anchorV, anchorH, justify };
  }

  function _derive608PlacementsForPreviewLines(lines, canonicalCue, doc, opts = {}) {
    if (!Array.isArray(lines) || !lines.length) return null;

    const ignoreOverride = !!opts.ignoreOverride;

    // Respect explicit placement tags: do not add extra positioning.
    const hasPlacementTags = lines.some((ln) => /\{\s*(?:row|r|col|c|pac)\s*:/i.test(String(ln || '')));
    if (hasPlacementTags) return null;

    const safe = opts.safe || _read608SafeMarginsForPreview(doc);
    const alignment = opts.alignment || _read608AlignmentForPreview(doc);

    const rowFallbacks = _rowsFor608Preview(lines.length);

    const placementOverride = (() => {
      if (ignoreOverride) return null;
      const o608 = canonicalCue?.overrides?.['608'];
      const p = Array.isArray(o608?.placement) ? o608.placement : null;
      const legacy = Array.isArray(canonicalCue?.sccPlacement) ? canonicalCue.sccPlacement : null;
      const arr = (p && p.length) ? p : ((legacy && legacy.length) ? legacy : null);
      return arr && arr.length ? arr : null;
    })();

    const _placementForIndex = (idx) => {
      if (!placementOverride) return null;
      const raw = placementOverride[idx];
      if (raw == null) return null;
      if (!raw || typeof raw !== 'object') return null;
      const r = Number(raw.row);
      const c = Number(raw.col);
      return {
        row: Number.isFinite(r) ? Math.trunc(r) : null,
        col: Number.isFinite(c) ? Math.trunc(c) : null
      };
    };

    // Resolve effective 708 window for this cue:
    // base doc window → zone (\an) → per-cue window overrides.
    const baseWin = (doc?.mccOptions?.mcc708Window && typeof doc.mccOptions.mcc708Window === 'object')
      ? doc.mccOptions.mcc708Window
      : { rel: true, anchorId: 7, anchorV: 90, anchorH: 50, justify: alignment };

    const anRaw = canonicalCue?.cea708Placement?.an ?? canonicalCue?.cea708Placement?.assAn ?? canonicalCue?.cea708An;
    const anNum = Number(anRaw);
    const an = Number.isFinite(anNum) ? Math.max(1, Math.min(9, Math.trunc(anNum))) : null;
    const anOverride = an ? _assAnTo708WindowOverridePreview(an) : null;

    const cueWinOverride =
      (canonicalCue?.overrides?.['708']?.window && typeof canonicalCue.overrides['708'].window === 'object')
        ? canonicalCue.overrides['708'].window
        : ((canonicalCue?.mcc708Window && typeof canonicalCue.mcc708Window === 'object') ? canonicalCue.mcc708Window : null);

    const win = _normalize708WinFor608Derivation({ ...baseWin, ...(anOverride || {}), ...(cueWinOverride || {}) }, alignment);

    // Column derivation: map 708 anchorH into 608 safe width.
    const derivedColForIndex = (() => {
      if (!win) return null;

      const usable = Math.max(1, Math.min(32, safe.width));
      const maxIdx = Math.max(0, usable - 1);

      const anchorId = Math.max(0, Math.min(8, Math.trunc(Number(win.anchorId) || 7)));
      const hPos = anchorId % 3;

      const denomH = (win.rel === false) ? 209 : 99;
      const aH = Math.max(0, Math.min(denomH, Math.trunc(Number(win.anchorH) || (denomH === 99 ? 50 : 105))));
      const anchorCol = safe.left + Math.round((aH / denomH) * maxIdx);

      const lens = lines.map((l) => _visible608LengthForPreview(l));
      const maxLen = lens.length ? Math.max(1, ...lens) : 1;
      const windowWidth = Math.max(1, Math.min(usable, maxLen));

      const windowLeft = (hPos === 0)
        ? anchorCol
        : (hPos === 1)
          ? (anchorCol - Math.floor(windowWidth / 2))
          : (anchorCol - windowWidth + 1);

      const clampStart = (col, lineLen) => {
        const minStart = safe.left;
        const maxStart = Math.max(minStart, safe.left + usable - Math.max(0, lineLen));
        const requested = Math.trunc(Number(col) || 0);
        return Math.max(minStart, Math.min(maxStart, requested));
      };

      const cache = new Map();
      return (idx) => {
        if (cache.has(idx)) return cache.get(idx);

        const lineText = String(lines[idx] || '');
        const lineLen = Math.max(0, Math.min(32, _visible608LengthForPreview(lineText)));
        const extra = Math.max(0, windowWidth - lineLen);

        let start = windowLeft;
        if (win.justify === 'center') start = windowLeft + Math.floor(extra / 2);
        else if (win.justify === 'right') start = windowLeft + extra;

        start = clampStart(start, lineLen);
        cache.set(idx, start);
        return start;
      };
    })();

    // Row derivation: map 708 anchorV into 608 rows, honoring top/middle/bottom intent.
    const derivedRowForIndex = (() => {
      if (!win) return null;

      const anchorId = Math.max(0, Math.min(8, Math.trunc(Number(win.anchorId) || 7)));
      const vPos = Math.floor(anchorId / 3); // 0 top, 1 middle, 2 bottom

      const denomV = (win.rel === false) ? 74 : 99;
      const aV = Math.max(0, Math.min(denomV, Math.trunc(Number(win.anchorV) || (denomV === 99 ? 90 : 67))));
      const baseRowF = 1 + ((denomV ? aV / denomV : 0) * 14);

      const nonEmptyIdx = lines
        .map((ln, idx) => {
          const plain = String(ln ?? '').replace(/\{[^}]+\}/g, '').trim();
          return plain ? idx : null;
        })
        .filter((v) => v != null);

      const rowsByIndex = new Map();
      if (nonEmptyIdx.length === 1) {
        const r = Math.max(1, Math.min(15, Math.round(baseRowF)));
        rowsByIndex.set(nonEmptyIdx[0], r);
      } else if (nonEmptyIdx.length >= 2) {
        let top = null;
        let bottom = null;

        if (vPos === 2) {
          bottom = Math.max(2, Math.min(15, Math.round(baseRowF)));
          top = bottom - 1;
        } else if (vPos === 1) {
          top = Math.round(baseRowF - 0.5);
          top = Math.max(1, Math.min(14, top));
          bottom = top + 1;
        } else {
          top = Math.round(baseRowF);
          top = Math.max(1, Math.min(14, top));
          bottom = top + 1;
        }

        rowsByIndex.set(nonEmptyIdx[0], top);
        rowsByIndex.set(nonEmptyIdx[1], bottom);
      }

      return (idx) => (rowsByIndex.has(idx) ? rowsByIndex.get(idx) : null);
    })();

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    return lines.map((lineText, idx) => {
      const override = _placementForIndex(idx);

      // Row
      let row = null;
      if (override && Number.isFinite(override.row)) row = override.row;
      else if (typeof derivedRowForIndex === 'function') row = derivedRowForIndex(idx);
      if (!Number.isFinite(row)) row = rowFallbacks[idx] ?? rowFallbacks[rowFallbacks.length - 1] ?? 15;
      row = clamp(Math.trunc(row), 1, 15);

      // Col
      let col = null;
      if (override && Number.isFinite(override.col)) col = override.col;
      else if (typeof derivedColForIndex === 'function') col = derivedColForIndex(idx);
      if (!Number.isFinite(col)) col = _startColFor608Preview(alignment, lineText, safe);
      col = clamp(Math.trunc(col), 0, 31);

      return { row, col };
    });
  }


  function _buildDerived608CueForPreview(cue, doc, opts = {}) {
    if (!cue) return null;

    const ignoreOverride = !!opts.ignoreOverride;
    const timeSecRaw = Number(opts?.timeSec);
    const timeSec = Number.isFinite(timeSecRaw) ? timeSecRaw : null;

    const maxLines = 2;
    const safe = _read608SafeMarginsForPreview(doc);
    const maxChars = Math.max(1, Math.min(32, safe.width));
    const alignment = _read608AlignmentForPreview(doc);

    const placementFor = (lines) => {
      return _derive608PlacementsForPreviewLines(lines, cue, doc, { safe, alignment, ignoreOverride });
    };

    // ------------------------------------------------------------------
    // Phase 2: 608-only structural overrides (mute / parts)
    // ------------------------------------------------------------------
    // If a cue is split into multiple 608-only parts, choose the part that
    // overlaps the current playhead time. This keeps the compat preview in
    // sync with export/QC behavior (even when 608 isn't embedded/decoded).
    if (!ignoreOverride) {
      const o608 = (cue?.overrides && typeof cue.overrides === 'object') ? (cue.overrides['608'] || null) : null;
      const overrideMute = !!(o608 && typeof o608 === 'object' && o608.mute === true);
      if (overrideMute) return null;

      const extractParts = (raw) => {
        if (!Array.isArray(raw) || !raw.length) return null;
        const out = [];
        for (const part of raw) {
          if (part == null) continue;
          let t = null;
          if (typeof part === 'string') {
            t = part;
          } else if (part && typeof part === 'object') {
            if (typeof part.text === 'string') t = part.text;
            else if (Array.isArray(part.lines) && part.lines.length) t = part.lines.map(l => String(l ?? '')).join('\n');
            else if (typeof part.value === 'string') t = part.value;
          }
          const s = String(t ?? '').replace(/\r\n?/g, '\n').trim();
          if (s) out.push(s);
        }
        return out.length ? out : null;
      };

      const overrideParts = extractParts(o608?.parts);
      if (overrideParts && overrideParts.length) {
        const tNow = (timeSec != null) ? timeSec : (Number(cue?.start) || 0);
        const clampLine = (ln) => Array.from(String(ln ?? '')).slice(0, maxChars).join('');

        // Prefer the shared derivation engine so timing + wrapping match export/QC.
        try {
          const derive = window.transcribeEngine?.derive608TrackFromCanonical;
          if (typeof derive === 'function') {
            const rawRules =
              doc?.mccOptions?.compatGenerationRules ??
              doc?.compatGenerationRules ??
              null;

            const rules = (rawRules && typeof rawRules === 'object') ? { ...rawRules } : {};

            // Ensure QC-like knobs are in the expected nested shape.
            const qcIn = (rules.qc && typeof rules.qc === 'object') ? { ...rules.qc } : {};
            if (qcIn.minDurationSec == null && rules.minDurationSec != null) qcIn.minDurationSec = rules.minDurationSec;
            if (qcIn.minGapSec == null && rules.minGapSec != null) qcIn.minGapSec = rules.minGapSec;
            if (qcIn.maxCps == null && rules.maxCps != null) qcIn.maxCps = rules.maxCps;
            if (qcIn.maxWpm == null && rules.maxWpm != null) qcIn.maxWpm = rules.maxWpm;
            if (qcIn.maxShiftSec == null && rules.maxShiftSec != null) qcIn.maxShiftSec = rules.maxShiftSec;
            if (qcIn.maxTotalShiftSec == null && rules.maxTotalShiftSec != null) qcIn.maxTotalShiftSec = rules.maxTotalShiftSec;
            rules.qc = qcIn;

            // Match preview safe-width and never exceed 608 constraints.
            rules.maxCols = maxChars;
            rules.maxLines = maxLines;

            // Ensure timecode parsing matches this doc.
            rules.fps = Number(doc?.fps) || 30;
            rules.dropFrame = !!doc?.dropFrame;

            // Match export's default: ripple OFF unless explicitly enabled.
            const rippleSpecified =
              (rules.allowBoundedRipple != null) ||
              (rules.allowRipple != null) ||
              (rules.ripple != null);
            if (!rippleSpecified) {
              rules.allowBoundedRipple = false;
              rules.allowRipple = false;
              rules.ripple = false;
            }

            const derived = derive([cue], rules);
            const list = Array.isArray(derived) ? derived : [];

            // Choose the part that overlaps the current time.
            let hit = null;
            if (Number.isFinite(tNow)) {
              for (const d of list) {
                const s = Number(d?.start);
                const e = Number(d?.end);
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
                if (tNow >= s && tNow < e) { hit = d; break; }
              }
              // If the playhead is in an intentional gap between parts, render nothing.
              if (!hit) return null;
            }
            if (!hit) hit = list[0] || null;
            if (!hit) return null;

            const rawLines = Array.isArray(hit.lines)
              ? hit.lines
              : (typeof hit.text === 'string' ? String(hit.text).split('\n') : []);

            const lines = rawLines
              .slice(0, maxLines)
              .map(clampLine)
              .filter(l => /[^\s]/.test(l));

            if (!lines.length) return null;

            return {
              text: lines.join('\n'),
              lines,
              sccPlacement: placementFor(lines),
              _derived608: true,
              _usedOverride: true,
              _usedPartsOverride: true,
              _overflowed: !!hit.overflowed,
              _tokenTruncated: !!hit.truncated,
              _truncated: !!(hit.overflowed || hit.truncated)
            };
          }
        } catch {}

        // Fallback (should be rare): choose a part by proportional index and wrap locally.
        const start = Number(cue?.start) || 0;
        const end = Number(cue?.end) || start;
        const dur = Math.max(0.001, end - start);
        const rel = Number.isFinite(tNow) ? Math.max(0, Math.min(dur - 1e-6, tNow - start)) : 0;
        const idx = Math.max(0, Math.min(overrideParts.length - 1, Math.floor((rel / dur) * overrideParts.length)));
        const partText = overrideParts[idx];

        let meta = null;
        try {
          if (window.transcribeEngine?.wrap608WithMeta) {
            meta = window.transcribeEngine.wrap608WithMeta(partText, maxChars, maxLines, { allowExplicitLineBreaks: true });
          } else if (window.transcribeEngine?.wrap608) {
            const wrapped = window.transcribeEngine.wrap608(partText, maxChars, maxLines);
            meta = { lines: Array.isArray(wrapped) ? wrapped : [], overflowed: false, truncated: false, usedExplicitBreaks: true };
          }
        } catch {}

        const rawLines = Array.isArray(meta?.lines) ? meta.lines : [];
        const lines = rawLines
          .slice(0, maxLines)
          .map(clampLine)
          .filter(l => /[^\s]/.test(l));

        if (!lines.length) return null;

        return {
          text: lines.join('\n'),
          lines,
          sccPlacement: placementFor(lines),
          _derived608: true,
          _usedOverride: true,
          _usedPartsOverride: true,
          _overflowed: !!meta?.overflowed,
          _tokenTruncated: !!meta?.truncated,
          _truncated: !!(meta?.overflowed || meta?.truncated)
        };
      }
    }

    // If an override exists, honor it verbatim (clamped), and do NOT auto-wrap.
    // When ignoreOverride is true, compute the baseline derived fallback.
    const override = ignoreOverride ? '' : _getCompat608OverrideText(cue);
    if (override && String(override).trim()) {
      const rawLines = String(override).replace(/\r\n/g, '\n').split('\n');
      const cleaned = rawLines.map(ln => String(ln ?? '')).filter(ln => ln.trim().length);

      const overflowed = cleaned.length > maxLines;
      const clampLine = (ln) => Array.from(String(ln ?? '')).slice(0, maxChars).join('');

      let tokenTruncated = false;
      for (let i = 0; i < Math.min(cleaned.length, maxLines); i++) {
        if (Array.from(cleaned[i] || '').length > maxChars) { tokenTruncated = true; break; }
      }

      const lines = cleaned
        .slice(0, maxLines)
        .map(clampLine)
        .filter(l => /[^\s]/.test(l));

      if (!lines.length) return null;

      return {
        text: lines.join('\n'),
        lines,
        sccPlacement: placementFor(lines),
        _derived608: true,
        _usedOverride: true,
        _overflowed: !!overflowed,
        _tokenTruncated: !!tokenTruncated,
        _truncated: !!(overflowed || tokenTruncated)
      };
    }

    const textFromRuns = Array.isArray(cue.runs)
      ? cue.runs.map(r => String((r && typeof r === 'object') ? (r.text ?? '') : '')).join('')
      : '';
    const baseText = (typeof cue.text === 'string' && cue.text.length)
      ? cue.text
      : (Array.isArray(cue.lines) && cue.lines.length ? cue.lines.join('\n') : textFromRuns);

    // IMPORTANT: Treat 708 line breaks as *soft* for derived 608. 608 has different width constraints.
    const stripped = _stripStylingFor608(baseText, { preserveNewlines: false });
    if (!stripped) return null;

    // Prefer the engine wrapper if present, but still clamp to safe-width x 2.
    // IMPORTANT: We must NOT insert UI ellipses (…); the preview should match export bytes.
    let lines = null;
    let overflowed = false;
    let tokenTruncated = false;
    let usedExplicitBreaks = false;

    const clampLine = (ln) => Array.from(String(ln ?? '')).slice(0, maxChars).join('');

    try {
      if (window.transcribeEngine?.wrap608WithMeta) {
        const meta = window.transcribeEngine.wrap608WithMeta(stripped, maxChars, maxLines, { allowExplicitLineBreaks: false });
        if (meta && Array.isArray(meta.lines) && meta.lines.length) {
          lines = meta.lines.slice(0, maxLines).map(clampLine).filter(l => /[^\s]/.test(l));
          overflowed = !!meta.overflowed;
          tokenTruncated = !!meta.truncated;
          usedExplicitBreaks = !!meta.usedExplicitBreaks;
        }
      } else if (window.transcribeEngine?.wrap608) {
        // Legacy API (no reliable truncation metadata).
        const wrapped = window.transcribeEngine.wrap608(stripped, maxChars, maxLines);
        if (Array.isArray(wrapped) && wrapped.length) {
          lines = wrapped.slice(0, maxLines).map(clampLine).filter(l => /[^\s]/.test(l));
        }
      }
    } catch {}

    if (!lines) {
      const res = _wrapTextGreedy(stripped, maxChars, maxLines);
      lines = (Array.isArray(res?.lines) ? res.lines : []).map(clampLine).filter(l => /[^\s]/.test(l));
      // Greedy wrapper can't separate overflow vs token clamp perfectly, but we can flag “something got cut”.
      const wasTruncated = !!res?.truncated;
      overflowed = wasTruncated && (Array.isArray(lines) ? (lines.length >= maxLines) : false);
      tokenTruncated = wasTruncated && !overflowed;
    }

    if (!Array.isArray(lines) || !lines.length) return null;

    return {
      text: lines.join('\n'),
      lines,
      sccPlacement: placementFor(lines),
      _derived608: true,
      _usedOverride: false,
      _overflowed: !!overflowed,
      _tokenTruncated: !!tokenTruncated,
      _usedExplicitBreaks: !!usedExplicitBreaks,
      _truncated: !!(overflowed || tokenTruncated)
    };
  }

  // ------------------------------------------------------------
  // Priority 1: In-editor QC (guided cleanup)
  // ------------------------------------------------------------

    // Strip formatting/control tokens so QC counting matches writer intent.
  // Keep this aligned with outputWriters.validateSccContentQc()/validateMccContentQc()
  // so CPS/WPM numbers in the editor don’t “argue” with export QC.
  const _QC_STRIP_RE = {
    // HTML-ish tags
    html: /<[^>]*>/g,
    // ASS/SSA override blocks that contain backslash tags (e.g. {\an8}, {\i1})
    ass: /\{[^}]*\\[a-zA-Z][^}]*\}/g,
    // Editor placement tags (non-rendered): {row:..}{col:..}{pac:...}
    placement: /\{(?:row|r|col|c|pac)\s*:[^}]+\}/gi,
    // Explicit “no-op” token (non-rendered)
    nop: /\{\s*NOP\s*\}/gi,
    // CEA-608 mid-row styling tokens used elsewhere in the app; not “spoken” text
    midrow: /\{(?:WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g,
    // Pipes sometimes appear as “soft” line breaks in user edits
    pipes: /\s*\|\s*/g
  };

  function _qcStripText(input) {
    let s = String(input ?? '');
    if (!s) return '';
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(_QC_STRIP_RE.pipes, '\n');
    s = s.replace(_QC_STRIP_RE.html, '');
    s = s.replace(_QC_STRIP_RE.ass, '');
    s = s.replace(_QC_STRIP_RE.placement, '');
    s = s.replace(_QC_STRIP_RE.nop, '');
    s = s.replace(_QC_STRIP_RE.midrow, '');
    return s;
  }

  function _qcCharCountNoSpace(text) {
    const flat = String(text ?? '').replace(/\s+/g, '');
    // Match the export-side QC logic (UTF-16 code units).
    return flat.length;
  }

  function _qcWordCount(text) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return 0;
    return s.split(' ').filter(Boolean).length;
  }

  
  // ------------------------------------------------------------
  // Phase 2/4: Per-track QC profiles (708 vs 608) in the editor.
  // Keep semantics aligned with utils/mccQcUtils.js (Node side).
  // ------------------------------------------------------------

  function _normalizeQcProfileForEditor(raw) {
    const src = (raw && typeof raw === 'object') ? raw : null;
    if (!src) return null;

    const hasOwn = (k) => Object.prototype.hasOwnProperty.call(src, k);

    const _numOrNull = (v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      if (typeof v === 'string' && v.trim() === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const pick = (keys) => {
      for (const k of keys) {
        if (hasOwn(k)) return src[k];
      }
      return undefined;
    };

    const out = {};

    const maxCols = _numOrNull(pick(['maxCharsPerLine', 'maxCols', 'maxColumns', 'maxColsPerLine']));
    if (maxCols !== undefined) out.maxCharsPerLine = maxCols;

    const maxLines = _numOrNull(pick(['maxLinesPerBlock', 'maxLines', 'maxRows', 'maxLinesPerCaption']));
    if (maxLines !== undefined) out.maxLinesPerBlock = maxLines;

    const maxDur = _numOrNull(pick(['maxDurationSec', 'maxDurationSeconds', 'maxDurSec', 'maxDur']));
    if (maxDur !== undefined) out.maxDurationSec = maxDur;

    const maxCps = _numOrNull(pick(['maxCps', 'maxCPS', 'cpsMax']));
    if (maxCps !== undefined) out.maxCps = maxCps;

    const maxWpm = _numOrNull(pick(['maxWpm', 'maxWPM', 'wpmMax']));
    if (maxWpm !== undefined) out.maxWpm = maxWpm;

    const minDur = _numOrNull(pick(['minDurationSec', 'minDurationSeconds', 'minDurSec', 'minDur']));
    if (minDur !== undefined) out.minDurationSec = minDur;

    const minGap = _numOrNull(pick(['minGapSec', 'minGapSeconds', 'minGap']));
    if (minGap !== undefined) out.minGapSec = minGap;

    const maxItems = _numOrNull(pick(['maxItems']));
    if (maxItems !== undefined) out.maxItems = maxItems;

    return Object.keys(out).length ? out : null;
  }

  function _resolveMccQcProfilesForEditor(qcCfg) {
    const cfg = (qcCfg && typeof qcCfg === 'object') ? qcCfg : {};
    const hasOwn = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

    const pickObj = (obj, keys) => {
      for (const k of keys) {
        if (hasOwn(obj, k)) {
          const v = obj[k];
          if (v && typeof v === 'object') return v;
        }
      }
      return null;
    };

    const profilesRoot = pickObj(cfg, ['profiles', 'qcProfiles', 'trackProfiles']);

    const fromScalars = (suffix) => {
      const out = {};
      const setNum = (canonKey, keys) => {
        for (const k of keys) {
          if (hasOwn(cfg, k)) {
            out[canonKey] = cfg[k];
            return;
          }
        }
      };

      setNum('maxCharsPerLine', [`maxCharsPerLine${suffix}`, `maxCols${suffix}`, `maxColumns${suffix}`]);
      setNum('maxLinesPerBlock', [`maxLinesPerBlock${suffix}`, `maxLines${suffix}`, `maxRows${suffix}`]);
      setNum('maxDurationSec', [`maxDurationSec${suffix}`, `maxDurationSeconds${suffix}`, `maxDurSec${suffix}`, `maxDur${suffix}`]);
      setNum('maxCps', [`maxCps${suffix}`, `maxCPS${suffix}`]);
      setNum('maxWpm', [`maxWpm${suffix}`, `maxWPM${suffix}`]);
      setNum('minDurationSec', [`minDurationSec${suffix}`, `minDurationSeconds${suffix}`, `minDurSec${suffix}`, `minDur${suffix}`]);
      setNum('minGapSec', [`minGapSec${suffix}`, `minGapSeconds${suffix}`, `minGap${suffix}`]);
      setNum('maxItems', [`maxItems${suffix}`]);

      return Object.keys(out).length ? out : null;
    };

    const raw708 =
      pickObj(cfg, ['qcProfile708', 'profile708', 'p708', 'cea708', 'track708']) ||
      (profilesRoot ? pickObj(profilesRoot, ['708', 'cea708', 'track708', 'svc708']) : null);

    const raw608 =
      pickObj(cfg, ['qcProfile608', 'profile608', 'p608', 'cea608', 'track608', 'legacy608']) ||
      (profilesRoot ? pickObj(profilesRoot, ['608', 'cea608', 'track608', 'legacy608', 'svc608']) : null);

    const scalar708 = fromScalars('708');
    const scalar608 = fromScalars('608');

    const prof708 = _normalizeQcProfileForEditor({ ...(raw708 || {}), ...(scalar708 || {}) });
    const prof608 = _normalizeQcProfileForEditor({ ...(raw608 || {}), ...(scalar608 || {}) });

    return { qcProfile708: prof708, qcProfile608: prof608 };
  }

  function _getQcConfigForDoc(doc) {
    // Prefer explicit per-document settings, but fall back to the Transcribe panel prefs.
    const defaults = {
      maxCps: 20,
      maxWpm: 180,
      minDurationSec: 0.8,
      minGapSec: 0.1,
      // SCC only: how late the final EOC may land after cue end (seconds)
      maxLateEocSec: 0.10,
      // SCC only: how many late-EOC events are tolerated
      maxLateEocCount: 0
    };
const scc = isSccDoc(doc);
const mcc = isMccDoc(doc);
const dual = wantsDualPreview(doc);
const srt = isSrtDoc(doc);
const vtt = isVttDoc(doc);

// Pull prefs only when needed (localStorage can throw in some embedding contexts).
let fallbackQc = null;
try {
  if (scc) fallbackQc = getSccPrefsFromLocalStorage()?.qc || null;
  else if (dual || mcc || is708Doc(doc)) fallbackQc = getMccPrefsFromLocalStorage()?.qc || null;
  else if (srt) fallbackQc = window?.qcDeliveryPrefs?.readSrtPrefs?.(localStorage)?.qc || null;
  else if (vtt) fallbackQc = window?.qcDeliveryPrefs?.readVttPrefs?.(localStorage)?.qc || null;
} catch { fallbackQc = null; }

// Web-caption docs (SRT/VTT) can optionally carry per-file QC values via formats.*.qc or *Options.
const webDocQc = (() => {
  const qcFromFormat = srt ? doc?.formats?.srt?.qc : (vtt ? doc?.formats?.vtt?.qc : null);
  const opts = srt ? doc?.srtOptions : (vtt ? doc?.vttOptions : null);

  const out = {};
  if (qcFromFormat && typeof qcFromFormat === 'object') {
    if (qcFromFormat.maxCps != null) out.maxCps = qcFromFormat.maxCps;
    if (qcFromFormat.maxWpm != null) out.maxWpm = qcFromFormat.maxWpm;
    if (qcFromFormat.minDurationSec != null) out.minDurationSec = qcFromFormat.minDurationSec;
    if (qcFromFormat.minGapSec != null) out.minGapSec = qcFromFormat.minGapSec;
    if (qcFromFormat.maxLateEocSec != null) out.maxLateEocSec = qcFromFormat.maxLateEocSec;
    if (qcFromFormat.maxLateEocCount != null) out.maxLateEocCount = qcFromFormat.maxLateEocCount;
  }
  if (opts && typeof opts === 'object') {
    // Allow both canonical keys and the Transcribe panel’s legacy names.
    if (opts.maxCps != null) out.maxCps = opts.maxCps;
    if (opts.maxWpm != null) out.maxWpm = opts.maxWpm;
    if (opts.minDurationSec != null) out.minDurationSec = opts.minDurationSec;
    if (opts.minDurationSeconds != null) out.minDurationSec = opts.minDurationSeconds;
    if (opts.minGapSec != null) out.minGapSec = opts.minGapSec;
    if (opts.minGapSeconds != null) out.minGapSec = opts.minGapSeconds;
    if (opts.maxLateEocSec != null) out.maxLateEocSec = opts.maxLateEocSec;
    if (opts.maxLateEocCount != null) out.maxLateEocCount = opts.maxLateEocCount;
  }

  return Object.keys(out).length ? out : null;
})();

const docQc = (
  scc ? doc?.sccOptions?.qc :
  (dual || mcc || is708Doc(doc)) ? (doc?.mccOptions?.qc || doc?.sccOptions?.qc) :
  webDocQc
) || null;

    // Phase 2/4: per-track QC profiles (optional).
    // We merge fallback prefs and per-doc overrides so the editor UI matches export behavior.
    const mergedQc = {
      ...(fallbackQc && typeof fallbackQc === 'object' ? fallbackQc : {}),
      ...(docQc && typeof docQc === 'object' ? docQc : {})
    };

    const { qcProfile708, qcProfile608 } = _resolveMccQcProfilesForEditor(mergedQc);


    const readNum = (v, defVal) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : defVal;
    };

    const readInt = (v, defVal) => {
      const n = parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) ? n : defVal;
    };

    const maxCps = readNum(docQc?.maxCps ?? fallbackQc?.maxCps, defaults.maxCps);
    const maxWpm = readNum(docQc?.maxWpm ?? fallbackQc?.maxWpm, defaults.maxWpm);
    const minDurationSec = readNum(docQc?.minDurationSec ?? fallbackQc?.minDurationSec, defaults.minDurationSec);
    const minGapSec = readNum(docQc?.minGapSec ?? fallbackQc?.minGapSec, defaults.minGapSec);

    // SCC-only: late EOC thresholds (used when we can compute encoder stats)
    const maxLateEocSec = readNum(docQc?.maxLateEocSec ?? fallbackQc?.maxLateEocSec, defaults.maxLateEocSec);
    const maxLateEocCount = readInt(docQc?.maxLateEocCount ?? fallbackQc?.maxLateEocCount, defaults.maxLateEocCount);

    // Max duration is treated as a 608 “block length” limit (SCC defaults to 6s).
    const maxDurationSec = (() => {
      const ui = Number(doc?.maxDurationSeconds);
      if (Number.isFinite(ui) && ui > 0) return ui;

      // Web-caption shaping settings (SRT/VTT)
      const fmtDur = srt
        ? Number(doc?.formats?.srt?.maxDurationSec ?? doc?.formats?.srt?.maxDurationSeconds)
        : (vtt ? Number(doc?.formats?.vtt?.maxDurationSec ?? doc?.formats?.vtt?.maxDurationSeconds) : NaN);
      if (Number.isFinite(fmtDur) && fmtDur > 0) return fmtDur;

      const optDur = srt
        ? Number(doc?.srtOptions?.maxDurationSeconds ?? doc?.srtOptions?.maxDurationSec)
        : (vtt ? Number(doc?.vttOptions?.maxDurationSeconds ?? doc?.vttOptions?.maxDurationSec) : NaN);
      if (Number.isFinite(optDur) && optDur > 0) return optDur;

      const sOpt = Number(doc?.sccOptions?.timing?.maxBlockSec);
      if (Number.isFinite(sOpt) && sOpt > 0) return sOpt;
      const mOpt = Number(doc?.mccOptions?.timing?.maxBlockSec);
      if (Number.isFinite(mOpt) && mOpt > 0) return mOpt;
      return scc ? 6 : null;
    })();

    // Track-specific QC thresholds (null = disable check).
    const maxCps708 = (qcProfile708 && qcProfile708.maxCps !== undefined) ? qcProfile708.maxCps : maxCps;
    const maxWpm708 = (qcProfile708 && qcProfile708.maxWpm !== undefined) ? qcProfile708.maxWpm : maxWpm;
    const minDurationSec708 = (qcProfile708 && qcProfile708.minDurationSec !== undefined) ? qcProfile708.minDurationSec : minDurationSec;
    const minGapSec708 = (qcProfile708 && qcProfile708.minGapSec !== undefined) ? qcProfile708.minGapSec : minGapSec;
    const maxDurationSec708 = (qcProfile708 && qcProfile708.maxDurationSec !== undefined) ? qcProfile708.maxDurationSec : maxDurationSec;
    const maxItems708 = (qcProfile708 && qcProfile708.maxItems !== undefined) ? qcProfile708.maxItems : null;

    const maxCps608 = (qcProfile608 && qcProfile608.maxCps !== undefined) ? qcProfile608.maxCps : maxCps;
    const maxWpm608 = (qcProfile608 && qcProfile608.maxWpm !== undefined) ? qcProfile608.maxWpm : maxWpm;
    const minDurationSec608 = (qcProfile608 && qcProfile608.minDurationSec !== undefined) ? qcProfile608.minDurationSec : minDurationSec;
    const minGapSec608 = (qcProfile608 && qcProfile608.minGapSec !== undefined) ? qcProfile608.minGapSec : minGapSec;
    const maxDurationSec608 = (qcProfile608 && qcProfile608.maxDurationSec !== undefined) ? qcProfile608.maxDurationSec : maxDurationSec;
    const maxItems608 = (qcProfile608 && qcProfile608.maxItems !== undefined) ? qcProfile608.maxItems : null;

    // 608 structural limits (when relevant)
    const safe = _read608SafeMarginsForPreview(doc);
    let maxCols608 = Math.max(1, Math.min(32, safe.width));
    const docMaxCols = Number(doc?.maxCharsPerLine);
    if (Number.isFinite(docMaxCols) && docMaxCols > 0 && docMaxCols <= 32) {
      maxCols608 = Math.max(1, Math.min(maxCols608, Math.trunc(docMaxCols)));
    }

    return {
      // Legacy single-profile defaults (still used by the primary QC panel).
      maxCps,
      maxWpm,
      minDurationSec,
      minGapSec,
      maxDurationSec,

      // Phase 2: optional per-track profiles (708 vs 608).
      qcProfile708,
      qcProfile608,

      // Track-resolved thresholds (null = disable check).
      maxCps708,
      maxWpm708,
      minDurationSec708,
      minGapSec708,
      maxDurationSec708,
      maxItems708,

      maxCps608,
      maxWpm608,
      minDurationSec608,
      minGapSec608,
      maxDurationSec608,
      maxItems608,

      // SCC-only thresholds (used when we can compute encoder stats)
      maxLateEocSec,
      maxLateEocCount,

      // Only enforce 608 row/col constraints when the doc is actually targeting 608 output.
      enforce608: !!(scc || (dual && _include608CompatibilityEnabled(doc))),
      maxLines608: 2,
      maxCols608,
      safe608: safe
    };
  }

  function computeEditorQcLegacy(doc) {
    const cues = Array.isArray(doc?.cues) ? doc.cues : [];
    const cfg = _getQcConfigForDoc(doc);

    const smpte = usesSmpteTimecode(doc);
    const tolFrames = 1e-4;

    const perCue = new Array(cues.length);
    const issues = [];

    const pushIssue = (issue) => {
      if (!issue || !issue.id) return;
      issues.push(issue);
    };

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i] || {};
      const start = Number(cue.start) || 0;
      let end = Number(cue.end);
      if (!Number.isFinite(end) || end <= start) {
        const nextStart = Number(cues[i + 1]?.start);
        end = (Number.isFinite(nextStart) && nextStart > start) ? nextStart : (start + 2.0);
      }
      const dur = Math.max(0, end - start);

      const nextStart = (i + 1 < cues.length) ? Number(cues[i + 1]?.start) : NaN;
      const gapToNext = (Number.isFinite(nextStart)) ? (nextStart - end) : NaN;

      const derived608 = (cfg.enforce608)
        ? _buildDerived608CueForPreview(cue, doc)
        : null;

      const rawForQc = cfg.enforce608
        ? (derived608?.text || '')
        : _cueTextForEditing(cue);

      const stripped = _qcStripText(rawForQc);
      const flat = stripped.replace(/\n+/g, ' ').trim();

      const charNoSpace = _qcCharCountNoSpace(flat);
      const wordCount = _qcWordCount(flat);

      const cps = dur > 0 ? (charNoSpace / dur) : 0;
      const wpm = dur > 0 ? (wordCount / (dur / 60)) : 0;

      // Track cue-level aggregates for row highlighting.
      let failCount = 0;
      let warnCount = 0;

      const startLabel = formatSeconds(start);
      const endLabel = formatSeconds(end);

      // SMPTE timing sanity: warn when cue edges (or explicit 608 override edges) are off-frame.
      if (smpte) {
        const notes = [];
        const fmt = (d) => `${d >= 0 ? '+' : ''}${d.toFixed(3)}f`;

        const dStart = _frameAlignmentDeltaFrames(start, doc);
        const dEnd = _frameAlignmentDeltaFrames(end, doc);
        if (Math.abs(dStart) > tolFrames) notes.push(`start ${fmt(dStart)}`);
        if (Math.abs(dEnd) > tolFrames) notes.push(`end ${fmt(dEnd)}`);

        const o = cue?.overrides;
        const o608 = (o && typeof o === 'object') ? o['608'] : null;
        if (o608 && typeof o608 === 'object') {
          if (o608.start != null && String(o608.start).trim() !== '') {
            const s = parseSecondsSmpte(o608.start, doc, start);
            const d = _frameAlignmentDeltaFrames(s, doc);
            if (Math.abs(d) > tolFrames) notes.push(`608 start ${fmt(d)}`);
          }
          if (o608.end != null && String(o608.end).trim() !== '') {
            const e = parseSecondsSmpte(o608.end, doc, end);
            const d = _frameAlignmentDeltaFrames(e, doc);
            if (Math.abs(d) > tolFrames) notes.push(`608 end ${fmt(d)}`);
          }
        }

        if (notes.length) {
          warnCount++;
          pushIssue({
            id: `frame:${i}`,
            cueIndex: i,
            severity: 'warn',
            kind: 'frameAlign',
            start,
            end,
            timeLabel: startLabel,
            message: tr('subtitleEditor.qc.timingNotFrameAligned', 'Timing not frame-aligned ({{notes}}). Use “Normalize frames”.', { notes: notes.join(', ') })
          });
        }
      }

      // ---- Reading speed + timing QC ----
      if (Number.isFinite(cfg.minDurationSec) && dur + 1e-9 < cfg.minDurationSec) {
        failCount++;
        pushIssue({
          id: `dur:${i}`,
          cueIndex: i,
          severity: 'fail',
          kind: 'minDuration',
          start,
          end,
          timeLabel: startLabel,
          message: `Duration ${dur.toFixed(2)}s < min ${cfg.minDurationSec}s`
        });
      }

      if (Number.isFinite(cfg.maxCps) && cps - 1e-9 > cfg.maxCps) {
        failCount++;
        pushIssue({
          id: `cps:${i}`,
          cueIndex: i,
          severity: 'fail',
          kind: 'maxCps',
          start,
          end,
          timeLabel: startLabel,
          message: `CPS ${cps.toFixed(1)} > max ${cfg.maxCps}`
        });
      }

      if (Number.isFinite(cfg.maxWpm) && wpm - 1e-9 > cfg.maxWpm) {
        failCount++;
        pushIssue({
          id: `wpm:${i}`,
          cueIndex: i,
          severity: 'fail',
          kind: 'maxWpm',
          start,
          end,
          timeLabel: startLabel,
          message: `WPM ${Math.round(wpm)} > max ${cfg.maxWpm}`
        });
      }

      if (Number.isFinite(cfg.minGapSec) && i + 1 < cues.length && Number.isFinite(gapToNext)) {
        if (gapToNext < 0) {
          failCount++;
          pushIssue({
            id: `overlap:${i}`,
            cueIndex: i,
            severity: 'fail',
            kind: 'overlap',
            start,
            end,
            timeLabel: startLabel,
            message: `Overlap ${(Math.abs(gapToNext)).toFixed(2)}s (${endLabel} → ${formatSeconds(nextStart)})`
          });
        } else if (gapToNext + 1e-9 < cfg.minGapSec) {
          failCount++;
          pushIssue({
            id: `gap:${i}`,
            cueIndex: i,
            severity: 'fail',
            kind: 'minGap',
            start,
            end,
            timeLabel: startLabel,
            message: `Gap ${gapToNext.toFixed(2)}s < min ${cfg.minGapSec}s (${endLabel} → ${formatSeconds(nextStart)})`
          });
        }
      }

      // ---- 608 structural QC (only when 608 output is relevant) ----
      if (cfg.enforce608) {
        const lines = Array.isArray(derived608?.lines)
          ? derived608.lines.map(l => String(l ?? ''))
          : String(rawForQc ?? '').replace(/\r\n?/g, '\n').split('\n');

        const nonEmptyLines = lines.filter(l => /[^\s]/.test(l));
        if (nonEmptyLines.length > cfg.maxLines608) {
          failCount++;
          pushIssue({
            id: `lines:${i}`,
            cueIndex: i,
            severity: 'fail',
            kind: 'maxLines',
            start,
            end,
            timeLabel: startLabel,
            message: `Lines ${nonEmptyLines.length} > max ${cfg.maxLines608} (608)`
          });
        }

        let tooWide = false;
        for (const ln of nonEmptyLines.slice(0, cfg.maxLines608)) {
          const vis = _visible608LengthForPreview(ln);
          if (vis > cfg.maxCols608) {
            tooWide = true;
            break;
          }
        }
        if (tooWide) {
          failCount++;
          pushIssue({
            id: `cols:${i}`,
            cueIndex: i,
            severity: 'fail',
            kind: 'maxCols',
            start,
            end,
            timeLabel: startLabel,
            message: `Line exceeds ${cfg.maxCols608} cols (safe area)`
          });
        }

        // Derived-608 overflow/truncation must be detected from metadata,
        // not by mutating text with UI ellipses.
        const overflowed = !!derived608?._overflowed;
        const tokenTruncated = !!derived608?._tokenTruncated;

        if (overflowed || tokenTruncated) {
          warnCount++;
          const msg =
            overflowed && tokenTruncated
              ? 'Derived 608 overflow + token truncation — review'
              : (overflowed
                ? 'Derived 608 overflow (more than 2 lines) — review'
                : 'Derived 608 token truncated (word longer than safe width) — review');

          pushIssue({
            id: `trunc:${i}`,
            cueIndex: i,
            severity: 'warn',
            kind: 'truncation',
            start,
            end,
            timeLabel: startLabel,
            message: msg
          });
        }

      }

      perCue[i] = {
        cueIndex: i,
        start,
        end,
        dur,
        gapToNext,
        cps,
        wpm,
        failCount,
        warnCount
      };
    }

    // Stable ordering: by start time, then cue index, then severity.
    issues.sort((a, b) => {
      const ta = Number(a?.start) || 0;
      const tb = Number(b?.start) || 0;
      if (ta !== tb) return ta - tb;
      const ia = Number(a?.cueIndex) || 0;
      const ib = Number(b?.cueIndex) || 0;
      if (ia !== ib) return ia - ib;
      const sa = a?.severity === 'fail' ? 0 : 1;
      const sb = b?.severity === 'fail' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return String(a?.id || '').localeCompare(String(b?.id || ''));
    });

    let failTotal = 0;
    let warnTotal = 0;
    for (const it of issues) {
      if (it.severity === 'fail') failTotal++;
      else warnTotal++;
    }

    return {
      cfg,
      perCue,
      issues,
      failTotal,
      warnTotal
    };
  }

  const isPromiseLike = (v) => !!(v && typeof v.then === 'function');

  function computeEditorQc(doc) {
    const validateScc =
      (typeof window.transcribeEngine?.validateSccContentQcSync === 'function')
        ? window.transcribeEngine.validateSccContentQcSync
        : window.transcribeEngine?.validateSccContentQc;
    const validateMcc =
      (typeof window.transcribeEngine?.validateMccContentQcSync === 'function')
        ? window.transcribeEngine.validateMccContentQcSync
        : window.transcribeEngine?.validateMccContentQc;

    // If the shared validators aren't available, fall back to the legacy in-editor mirror.
    if (typeof validateScc !== 'function' || typeof validateMcc !== 'function') {
      return computeEditorQcLegacy(doc);
    }

    const cues = Array.isArray(doc?.cues) ? doc.cues : [];
    const cfg = _getQcConfigForDoc(doc);

    const perCue = new Array(cues.length);
    const issues = [];

    if (!cues.length) {
      return { cfg, perCue: [], issues: [], failTotal: 0, warnTotal: 0 };
    }

    const fps = Number(doc?.fps) || 29.97;
    const dropFrame = !!doc?.dropFrame;
    const startTc = _getDocStartTimecodeLabel(doc);
    const scc = isSccDoc(doc);

    const smpte = usesSmpteTimecode(doc);
    const tolFrames = 1e-4;

    // Stable-ish ID: compact hash of the important bits.
    const _hash = (str) => {
      let h = 0;
      const s = String(str || '');
      for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
      }
      return h.toString(16);
    };

    const kindFromType = (type) => {
      const t = String(type || '').trim();
      if (t === 'cps') return 'maxCps';
      if (t === 'wpm') return 'maxWpm';
      if (t === 'minDuration') return 'minDuration';
      if (t === 'maxDuration') return 'maxDuration';
      if (t === 'minGap') return 'minGap';
      if (t === 'overlap') return 'overlap';
      if (t === 'wrap') return 'wrap';
      if (t === 'maxLines') return 'maxLines';
      if (t === 'maxCols') return 'maxCols';
      if (t === 'lineBreak') return 'lineBreak';
      if (t === 'lateEoc') return 'lateEoc';
      if (t === 'lateEocCount') return 'lateEocCount';
      if (t === 'decode708') return 'decode708';
      if (t === 'missing708') return 'missing708';
      return t || 'qc';
    };

    const isValidCueIndex = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n < cues.length;
    };

    // Build validator segments + per-cue metrics.
    const segments = new Array(cues.length);
    const mapStartEnd = new Map();
    const mapEndNext = new Map();

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i] || {};
      const start = Number(cue.start) || 0;
      let end = Number(cue.end);
      if (!Number.isFinite(end) || end <= start) {
        const nextStart = Number(cues[i + 1]?.start);
        end = (Number.isFinite(nextStart) && nextStart > start) ? nextStart : (start + 2.0);
      }
      const dur = Math.max(0, end - start);

      const nextStart = (i + 1 < cues.length) ? Number(cues[i + 1]?.start) : NaN;
      const gapToNext = (Number.isFinite(nextStart)) ? (nextStart - end) : NaN;

      const startLabel = formatSeconds(start);
      const endLabel = formatSeconds(end);

      mapStartEnd.set(`${startLabel}|${endLabel}`, i);
      if (Number.isFinite(nextStart)) {
        const nextStartLabel = formatSeconds(nextStart);
        mapEndNext.set(`${endLabel}|${nextStartLabel}`, i);
      }

      // QC text should match the deliverable path:
      //  - SCC: validate *source* text and let the validator wrap/clamp like export.
      //  - Dual 708→608 deliverables: validate the derived 608 preview text.
      let derived608 = null;
      let qcText = '';
      if (scc) {
        qcText = _cueTextForEditing(cue);
      } else if (cfg.enforce608) {
        derived608 = _buildDerived608CueForPreview(cue, doc);
        qcText = derived608?.text || '';
      } else {
        qcText = _cueTextForEditing(cue);
      }

      // CPS/WPM display numbers (note: pass/fail comes from the shared validators).
      const stripped = _qcStripText(qcText);
      const flat = stripped.replace(/\n+/g, ' ').trim();
      const charNoSpace = _qcCharCountNoSpace(flat);
      const wordCount = _qcWordCount(flat);

      const cps = dur > 0 ? (charNoSpace / dur) : 0;
      const wpm = dur > 0 ? (wordCount / (dur / 60)) : 0;

      perCue[i] = {
        cueIndex: i,
        start,
        end,
        dur,
        gapToNext,
        cps,
        wpm,
        failCount: 0,
        warnCount: 0,
        badgeStatus: { dur: 'ok', gap: 'ok', cps: 'ok', wpm: 'ok' }
      };

      segments[i] = {
        id: i,
        start,
        end,
        text: qcText,
        // Provide timecode labels so editor + validator share a consistent “key”
        // even when the doc isn't using SMPTE display.
        timecodes: {
          df: { start: startLabel, end: endLabel },
          ndf: { start: startLabel, end: endLabel }
        }
      };

      // Derived-608 overflow/truncation must be flagged without altering preview text.
      if (!scc && cfg.enforce608) {
        const overflowed = !!derived608?._overflowed;
        const tokenTruncated = !!derived608?._tokenTruncated;

        if (overflowed || tokenTruncated) {
          const msg =
            overflowed && tokenTruncated
              ? 'Derived 608 overflow + token truncation — review'
              : (overflowed
                ? 'Derived 608 overflow (more than 2 lines) — review'
                : 'Derived 608 token truncated (word longer than safe width) — review');

          issues.push({
            id: `qc:${_hash(`trunc|${i}|${startLabel}|${endLabel}`)}`,
            cueIndex: i,
            severity: 'warn',
            kind: 'truncation',
            start,
            end,
            timeLabel: startLabel,
            message: msg
          });
          perCue[i].warnCount++;
        }
      }

      // SMPTE timing sanity: warn when cue edges (or explicit 608 override edges) are off-frame.
      if (smpte) {
        const notes = [];
        const fmt = (d) => `${d >= 0 ? '+' : ''}${d.toFixed(3)}f`;

        const dStart = _frameAlignmentDeltaFrames(start, doc);
        const dEnd = _frameAlignmentDeltaFrames(end, doc);
        if (Math.abs(dStart) > tolFrames) notes.push(`start ${fmt(dStart)}`);
        if (Math.abs(dEnd) > tolFrames) notes.push(`end ${fmt(dEnd)}`);

        const o = cue?.overrides;
        const o608 = (o && typeof o === 'object') ? o['608'] : null;
        if (o608 && typeof o608 === 'object') {
          if (o608.start != null && String(o608.start).trim() !== '') {
            const s = parseSecondsSmpte(o608.start, doc, start);
            const d = _frameAlignmentDeltaFrames(s, doc);
            if (Math.abs(d) > tolFrames) notes.push(`608 start ${fmt(d)}`);
          }
          if (o608.end != null && String(o608.end).trim() !== '') {
            const e = parseSecondsSmpte(o608.end, doc, end);
            const d = _frameAlignmentDeltaFrames(e, doc);
            if (Math.abs(d) > tolFrames) notes.push(`608 end ${fmt(d)}`);
          }
        }

        if (notes.length) {
          issues.push({
            id: `frame:${i}`,
            cueIndex: i,
            severity: 'warn',
            kind: 'frameAlign',
            start,
            end,
            timeLabel: startLabel,
            message: tr('subtitleEditor.qc.timingNotFrameAligned', 'Timing not frame-aligned ({{notes}}). Use “Normalize frames”.', { notes: notes.join(', ') })
          });
          perCue[i].warnCount++;
        }
      }

    }

    // SCC-only: compute encoder-derived late-EOC stats once per doc edit (cached).
    let lateEocCount = null;
    let maxLateEocSecObserved = null;
    let lateEocCues = null;
    let sccText = null;

    if (scc && typeof window.transcribeEngine?.generateSCC === 'function') {
      const cache = (state.qc && typeof state.qc === 'object') ? (state.qc.sccCache || null) : null;

      const sccOptionsHash = (() => {
        try { return _hash(JSON.stringify((doc && doc.sccOptions && typeof doc.sccOptions === 'object') ? doc.sccOptions : {})); }
        catch { return '0'; }
      })();

      const key = JSON.stringify({
        updatedAt: Number(doc?.updatedAt) || 0,
        cueCount: cues.length,
        fps,
        dropFrame,
        startTc: String(startTc || ''),
        maxCols: cfg.maxCols608,
        maxLines: cfg.maxLines608,
        safeLeft: Number(cfg?.safe608?.left) || 0,
        safeRight: Number(cfg?.safe608?.right) || 0,
        sccOptionsHash
      });

      const cacheHit = cache && cache.key === key && cache.stats && typeof cache.stats === 'object';
      if (cacheHit) {
        lateEocCount = Number(cache.stats.lateEocCount) || 0;
        maxLateEocSecObserved = Number(cache.stats.maxLateEocSec) || 0;
        lateEocCues = Array.isArray(cache.stats.lateEocCues) ? cache.stats.lateEocCues : [];
        sccText = (typeof cache.sccText === 'string') ? cache.sccText : null;
      } else {
        try {
          const encSegs = segments.map(s => ({ start: s.start, end: s.end, text: s.text }));
          const res = window.transcribeEngine.generateSCC(encSegs, {
            fps,
            dropFrame,
            startTc,
            maxCharsPerLine: cfg.maxCols608,
            maxLinesPerBlock: cfg.maxLines608,
            sccOptions: (doc && doc.sccOptions && typeof doc.sccOptions === 'object') ? doc.sccOptions : {},
            returnStats: true
          });

          if (res && typeof res === 'object') {
            sccText = (typeof res.scc === 'string') ? res.scc : null;
            const st = (res.stats && typeof res.stats === 'object') ? res.stats : {};
            lateEocCount = Number(st.lateEocCount) || 0;
            maxLateEocSecObserved = Number(st.maxLateEocSec) || 0;
            lateEocCues = Array.isArray(st.lateEocCues) ? st.lateEocCues : [];

            if (cache) {
              cache.key = key;
              cache.sccText = sccText;
              cache.stats = st;
              cache.lastError = null;
            } else if (state.qc) {
              state.qc.sccCache = { key, sccText, stats: st, lastError: null };
            }
          }
        } catch (e) {
          if (cache) cache.lastError = e?.message || String(e);
          else if (state.qc) state.qc.sccCache = { key, sccText: null, stats: null, lastError: e?.message || String(e) };
        }
      }
    }

    // SCC-only: surface per-cue late-EOC “start too late” details so the editor can point to
    // the *exact* cue(s) that will display late in pop-on workflows.
    // IMPORTANT: This is additive UI help; the shared validator below remains the gating source-of-truth.
    if (scc) {
      const list = Array.isArray(lateEocCues) ? lateEocCues : [];
      for (const entry of list) {
        const cueIndex = Number(entry?.cueIndex);
        if (!isValidCueIndex(cueIndex)) continue;

        const lateSec = Number(entry?.lateSec) || 0;
        const lateFrames = Number.isFinite(Number(entry?.lateFrames)) ? Number(entry?.lateFrames) : null;

        const intended = String(entry?.startTc || '').trim();
        const actual = String(entry?.eocTc || '').trim();

        // Severity: if ANY late-EOC is disallowed (count threshold <= 0), mark as fail so it shows up
        // in the failures list even though the validator emits a global count failure.
        const hardFailBySec = Number.isFinite(cfg.maxLateEocSec) && (lateSec - 1e-9 > cfg.maxLateEocSec);
        const hardFailByCount = Number.isFinite(cfg.maxLateEocCount) && (cfg.maxLateEocCount <= 0);

        const severity = (hardFailBySec || hardFailByCount) ? 'fail' : 'warn';
        const start = perCue[cueIndex]?.start ?? 0;
        const end = perCue[cueIndex]?.end ?? start;

        const msg =
          `Pop-on pre-roll short: intended ${intended || formatSeconds(start)} → EOC @ ${actual || '(unknown)'} ` +
          `(+${lateFrames != null ? lateFrames : '?'}f / ${lateSec.toFixed(3)}s)`;

        issues.push({
          id: `qc:${_hash(`lateeoc|${cueIndex}|${intended}|${actual}|${lateFrames}|${lateSec.toFixed(6)}`)}`,
          cueIndex,
          severity,
          kind: 'lateEoc',
          start,
          end,
          timeLabel: intended || formatSeconds(start),
          message: msg
        });

        if (severity === 'fail') perCue[cueIndex].failCount++;
        else perCue[cueIndex].warnCount++;
      }
    }

    // Run the shared validator (this is the source-of-truth for deliverable gating).
    let qcRes = null;
    const editorQcMaxItems = (() => {
      const candidates = [cfg?.maxItems608, cfg?.maxItems708]
        .map(v => Number(v))
        .filter(n => Number.isFinite(n) && n > 0)
        .map(n => Math.trunc(n));
      return candidates.length ? Math.max(250, ...candidates) : 5000;
    })();
    try {
      if (scc) {
        qcRes = validateScc(segments, {
          fps,
          dropFrame,
          startTc,
          maxCharsPerLine: cfg.maxCols608,
          maxLinesPerBlock: cfg.maxLines608,
          safeMargins: { left: cfg?.safe608?.left ?? 0, right: cfg?.safe608?.right ?? 0 },
          maxDurationSec: cfg.maxDurationSec,
          maxCps: cfg.maxCps,
          maxWpm: cfg.maxWpm,
          minDurationSec: cfg.minDurationSec,
          minGapSec: cfg.minGapSec,
          maxLateEocSec: cfg.maxLateEocSec,
          maxLateEocCount: cfg.maxLateEocCount,
          // These are optional; validator will ignore if null/undefined.
          lateEocCount,
          maxLateEocSecObserved,
          sccText,
          // In-editor: show substantially more than the export report’s default,
          // and honor any explicit per-profile override.
          maxItems: editorQcMaxItems
        });
      } else {
        qcRes = validateMcc(segments, {
          fps,
          dropFrame,
          maxCharsPerLine: cfg.enforce608 ? cfg.maxCols608 : undefined,
          maxLinesPerBlock: cfg.enforce608 ? cfg.maxLines608 : undefined,
          maxDurationSec: Number.isFinite(cfg.maxDurationSec) ? cfg.maxDurationSec : undefined,
          maxCps: cfg.maxCps,
          maxWpm: cfg.maxWpm,
          minDurationSec: cfg.minDurationSec,
          minGapSec: cfg.minGapSec,
          maxItems: editorQcMaxItems
        });
      }
    } catch (err) {
      console.error('Shared QC validator failed; falling back to legacy QC.', err);
      return computeEditorQcLegacy(doc);
    }

    if (isPromiseLike(qcRes)) return computeEditorQcLegacy(doc);

    const failures = Array.isArray(qcRes?.failures) ? qcRes.failures : [];
    const warnings = Array.isArray(qcRes?.warnings) ? qcRes.warnings : [];

    const ingest = (items, severity) => {
      for (const raw of items) {
        const type = String(raw?.type || 'qc');
        const kind = kindFromType(type);

        let cueIndex = null;
        if (isValidCueIndex(raw?.index)) {
          cueIndex = Number(raw.index);
        } else if (raw?.startTc && raw?.endTc) {
          const key = `${raw.startTc}|${raw.endTc}`;
          if (mapStartEnd.has(key)) cueIndex = mapStartEnd.get(key);
        } else if (raw?.endTc && raw?.nextStartTc) {
          const key = `${raw.endTc}|${raw.nextStartTc}`;
          if (mapEndNext.has(key)) cueIndex = mapEndNext.get(key);
        }

        const hasCue = isValidCueIndex(cueIndex);

        const start = hasCue ? (perCue[cueIndex].start) : 0;
        const end = hasCue ? (perCue[cueIndex].end) : 0;
        const timeLabel = String(raw?.startTc || raw?.endTc || (hasCue ? formatSeconds(start) : ''));

        const message = String(raw?.message || '').trim() || `${kind}`;

        const idBase = `${severity}|${kind}|${hasCue ? cueIndex : 'g'}|${timeLabel}|${message}`;
        const id = `qc:${_hash(idBase)}`;

        issues.push({
          id,
          cueIndex: hasCue ? cueIndex : null,
          severity,
          kind,
          start,
          end,
          timeLabel,
          message
        });

        if (hasCue) {
          if (severity === 'fail') perCue[cueIndex].failCount++;
          else perCue[cueIndex].warnCount++;

          if (severity === 'fail') {
            if (kind === 'minDuration' || kind === 'maxDuration') perCue[cueIndex].badgeStatus.dur = 'fail';
            if (kind === 'minGap' || kind === 'overlap') perCue[cueIndex].badgeStatus.gap = 'fail';
            if (kind === 'maxCps') perCue[cueIndex].badgeStatus.cps = 'fail';
            if (kind === 'maxWpm') perCue[cueIndex].badgeStatus.wpm = 'fail';
          }
        }
      }
    };

    ingest(failures, 'fail');
    ingest(warnings, 'warn');

    // Stable ordering: by start time, then cue index, then severity.
    issues.sort((a, b) => {
      const ta = Number(a?.start) || 0;
      const tb = Number(b?.start) || 0;
      if (ta !== tb) return ta - tb;

      const ia = Number.isFinite(Number(a?.cueIndex)) ? Number(a.cueIndex) : -1;
      const ib = Number.isFinite(Number(b?.cueIndex)) ? Number(b.cueIndex) : -1;
      if (ia !== ib) return ia - ib;

      const sa = a?.severity === 'fail' ? 0 : 1;
      const sb = b?.severity === 'fail' ? 0 : 1;
      if (sa !== sb) return sa - sb;

      return String(a?.id || '').localeCompare(String(b?.id || ''));
    });

    let failTotal = 0;
    let warnTotal = 0;
    for (const it of issues) {
      if (it.severity === 'fail') failTotal++;
      else warnTotal++;
    }

    return { cfg, perCue, issues, failTotal, warnTotal };
  }


  // ------------------------------------------------------------
  // Phase 4: Dual-track cue status for badges + edit-mode defaults
  // ------------------------------------------------------------

  function _getQcTrackLimitsForDoc(doc, cfg = null) {
    const fps = Number(doc?.fps) || 29.97;

    const prof708 = (cfg && cfg.qcProfile708 && typeof cfg.qcProfile708 === 'object') ? cfg.qcProfile708 : null;
    const prof608 = (cfg && cfg.qcProfile608 && typeof cfg.qcProfile608 === 'object') ? cfg.qcProfile608 : null;

    const clampIntOrNull = (v, min, max, fallback) => {
      if (v === undefined) return fallback;
      if (v === null) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return fallback;
      return Math.max(min, Math.min(max, Math.trunc(n)));
    };

    // 708 (CEA-708) structural limits (default from doc/export prefs; optionally overridden by qcProfile708)
    const baseCols708Raw = Number(doc?.mccOptions?.maxCharsPerLine ?? doc?.maxCharsPerLine);
    const baseCols708 = (Number.isFinite(baseCols708Raw) && baseCols708Raw > 0)
      ? Math.max(1, Math.min(63, Math.trunc(baseCols708Raw)))
      : 42;

    const baseLines708Raw = Number(doc?.mccOptions?.maxLinesPerBlock ?? doc?.maxLinesPerBlock);
    const baseLines708 = (Number.isFinite(baseLines708Raw) && baseLines708Raw > 0)
      ? Math.max(1, Math.min(15, Math.trunc(baseLines708Raw)))
      : 2;

    const maxCols708 = clampIntOrNull(prof708 ? prof708.maxCharsPerLine : undefined, 1, 63, baseCols708);
    const maxLines708 = clampIntOrNull(prof708 ? prof708.maxLinesPerBlock : undefined, 1, 15, baseLines708);

    // 608 (CEA-608) structural limits (default from safe-margins; optionally overridden by qcProfile608)
    const baseCols608Raw = Number(cfg?.maxCols608);
    const baseCols608 = (Number.isFinite(baseCols608Raw) && baseCols608Raw > 0)
      ? Math.max(1, Math.min(63, Math.trunc(baseCols608Raw)))
      : 32;

    const baseLines608Raw = Number(cfg?.maxLines608);
    const baseLines608 = (Number.isFinite(baseLines608Raw) && baseLines608Raw > 0)
      ? Math.max(1, Math.min(15, Math.trunc(baseLines608Raw)))
      : 2;

    const maxCols608 = clampIntOrNull(prof608 ? prof608.maxCharsPerLine : undefined, 1, 63, baseCols608);
    const maxLines608 = clampIntOrNull(prof608 ? prof608.maxLinesPerBlock : undefined, 1, 15, baseLines608);

    return { fps, maxCols708, maxLines708, maxCols608, maxLines608 };
  }

  function _cueWindowSecondsForIndex(cues, idx, fps = 29.97) {
    const cue = cues?.[idx] || {};
    const start = Number(cue.start) || 0;
    let end = Number(cue.end);
    if (!Number.isFinite(end) || end <= start) {
      const nextStart = Number(cues?.[idx + 1]?.start);
      end = (Number.isFinite(nextStart) && nextStart > start) ? nextStart : (start + Math.max(2 / (Number(fps) || 30), 0.5));
    }
    return { start, end };
  }

  function _aggregateTrackByOverlap(sourceWindows, trackByCue, fps = 29.97) {
    const eps = Math.max(0, (2 / (Number(fps) || 30)) + 0.001); // ~2 frames + tiny ms fudge
    const cand = Array.isArray(trackByCue)
      ? trackByCue
          .filter(r => r && Number.isFinite(r.start) && Number.isFinite(r.end) && (Number(r.end) > Number(r.start)))
          .map(r => ({
            start: Number(r.start) || 0,
            end: Number(r.end) || 0,
            ok: !!r.ok,
            failTypes: Array.isArray(r.failTypes) ? r.failTypes.slice() : [],
            warnTypes: Array.isArray(r.warnTypes) ? r.warnTypes.slice() : []
          }))
      : [];

    cand.sort((a, b) => (a.start - b.start) || (a.end - b.end));

    let j = 0;
    const out = new Array(sourceWindows.length);

    for (let i = 0; i < sourceWindows.length; i++) {
      const w = sourceWindows[i] || {};
      const s0 = Number(w.start) || 0;
      const e0 = Number(w.end) || 0;

      while (j < cand.length && (cand[j].end + eps) < s0) j++;

      let k = j;
      let ok = true;
      let matched = 0;
      const ft = new Set();
      const wt = new Set();

      while (k < cand.length && cand[k].start <= (e0 + eps)) {
        const s1 = cand[k].start;
        const e1 = cand[k].end;
        const overlap = Math.max(0, Math.min(e0, e1) - Math.max(s0, s1));
        if (overlap > 0) {
          matched += 1;
          ok = ok && !!cand[k].ok;
          for (const t of cand[k].failTypes) ft.add(t);
          for (const t of cand[k].warnTypes) wt.add(t);
        }
        k += 1;
      }

      out[i] = {
        ok: matched ? ok : true,
        failTypes: Array.from(ft),
        warnTypes: Array.from(wt),
        matchedCount: matched
      };
    }

    return out;
  }

  function _segmentsFromDecodedPreviewCues(previewCues) {
    if (!Array.isArray(previewCues)) return [];
    const out = [];
    for (let i = 0; i < previewCues.length; i++) {
      const c = previewCues[i];
      if (!c) continue;
      const start = Number(c.start) || 0;
      const end = Number(c.end);
      if (!Number.isFinite(end) || end <= start) continue;
      const text = Array.isArray(c.lines)
        ? c.lines.map(l => String(l ?? '')).join('\n')
        : String(c.text ?? '');
      out.push({ id: c.id ?? `decoded_${i}`, start, end, text });
    }
    return out;
  }

  function _segmentsFromProjected608(cues, doc) {
    const out = [];
    if (!Array.isArray(cues)) return out;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (!cue) continue;
      const start = Number(cue.start) || 0;
      const end = Number(cue.end);
      const derived = _buildDerived608CueForPreview(cue, doc);
      const text = String(derived?.text ?? '');
      out.push({ id: cue.id ?? `proj608_${i}`, start, end, text });
    }
    return out;
  }

  function computeDualTrackStatusForCueList(doc, cfg = null) {
    const cues = Array.isArray(doc?.cues) ? doc.cues : [];
    if (!cues.length) return [];

    const has708 = !!is708Doc(doc);
    const cfgLocal = cfg || _getQcConfigForDoc(doc);
    const lim = _getQcTrackLimitsForDoc(doc, cfgLocal);

    // Canonical cue windows (stable end fallback) for mapping decoded cues → canonical rows.
    const sourceWindows = cues.map((_, i) => _cueWindowSecondsForIndex(cues, i, lim.fps));

    // 708 QC input
    let seg708 = [];
    let source708 = 'pre-encode';
    if (has708 && state.mccPreview?.ok && state.mccPreview.preview708?.cues) {
      seg708 = _segmentsFromDecodedPreviewCues(state.mccPreview.preview708.cues);
      if (seg708.length) source708 = 'decoded-mcc';
    }
    if (has708 && !seg708.length) {
      // Fallback: use canonical text (pre-encode). This won't reflect encoder wrapping.
      seg708 = cues.map((cue, i) => ({
        id: cue.id ?? `canon_${i}`,
        start: Number(cue.start) || 0,
        end: Number(cue.end) || 0,
        text: String(_cueTextForEditing(cue) || '')
      }));
      source708 = 'canonical';
    }

    // 608 QC input
    let seg608 = [];
    let source608 = 'projected';
    const wantDecoded608 = !!(has708 && state.mccPreview?.ok && _include608CompatibilityEnabled(doc));
    if (wantDecoded608 && state.mccPreview.preview608?.cues) {
      seg608 = _segmentsFromDecodedPreviewCues(state.mccPreview.preview608.cues);
      if (seg608.length) source608 = 'decoded-mcc';
    }
    if (!seg608.length) {
      // Always compute a projected 608 grade so we can guide NLE ingest fixes
      // even when 608 isn't included in the file.
      seg608 = _segmentsFromProjected608(cues, doc);
      source608 = 'projected';
    }

    // Run QC (cue-level) for each track.
    let qc708 = null;
    let qc608 = null;
    try {
      if (has708) {
        qc708 = window.transcribeEngine?.validateMccContentQc
          ? window.transcribeEngine.validateMccContentQc(seg708, {
              fps: lim.fps,
              dropFrame: !!doc?.dropFrame,
              maxDurationSec: cfgLocal.maxDurationSec708,
              maxCps: cfgLocal.maxCps708,
              maxWpm: cfgLocal.maxWpm708,
              minDurationSec: cfgLocal.minDurationSec708,
              minGapSec: cfgLocal.minGapSec708,
              maxCharsPerLine: lim.maxCols708,
              maxLinesPerBlock: lim.maxLines708,
              maxItems: (Number.isFinite(Number(cfgLocal.maxItems708)) ? Math.max(1, Math.trunc(Number(cfgLocal.maxItems708))) : 5000)
            })
          : null;
      }
    } catch { qc708 = null; }

    try {
      qc608 = window.transcribeEngine?.validateMccContentQc
        ? window.transcribeEngine.validateMccContentQc(seg608, {
            fps: lim.fps,
            dropFrame: !!doc?.dropFrame,
            maxDurationSec: cfgLocal.maxDurationSec608,
            maxCps: cfgLocal.maxCps608,
            maxWpm: cfgLocal.maxWpm608,
            minDurationSec: cfgLocal.minDurationSec608,
            minGapSec: cfgLocal.minGapSec608,
            maxCharsPerLine: lim.maxCols608,
            maxLinesPerBlock: lim.maxLines608,
            maxItems: (Number.isFinite(Number(cfgLocal.maxItems608)) ? Math.max(1, Math.trunc(Number(cfgLocal.maxItems608))) : 5000)
          })
        : null;
    } catch { qc608 = null; }

    // Map decoded/projected QC-by-cue back onto canonical cue rows.
    const agg708 = has708 && qc708?.byCue
      ? _aggregateTrackByOverlap(sourceWindows, qc708.byCue, lim.fps)
      : sourceWindows.map(() => ({ ok: true, failTypes: [], warnTypes: [], matchedCount: 0 }));

    const agg608 = qc608?.byCue
      ? _aggregateTrackByOverlap(sourceWindows, qc608.byCue, lim.fps)
      : sourceWindows.map(() => ({ ok: true, failTypes: [], warnTypes: [], matchedCount: 0 }));

    const out = new Array(cues.length);
    for (let i = 0; i < cues.length; i++) {
      const a708 = agg708[i] || { ok: true, failTypes: [], warnTypes: [] };
      const a608 = agg608[i] || { ok: true, failTypes: [], warnTypes: [] };
      const ok708 = has708 ? !!a708.ok : true;
      const ok608 = !!a608.ok;

      out[i] = {
        ok708,
        ok608,
        legacyUnsafe: !!(has708 && ok708 && !ok608),
        failTypes708: Array.isArray(a708.failTypes) ? a708.failTypes : [],
        warnTypes708: Array.isArray(a708.warnTypes) ? a708.warnTypes : [],
        failTypes608: Array.isArray(a608.failTypes) ? a608.failTypes : [],
        warnTypes608: Array.isArray(a608.warnTypes) ? a608.warnTypes : [],
        source708,
        source608
      };
    }

    return out;
  }


  function scheduleQcRecompute(immediate = false) {
    if (!state.doc) return;

    if (qcDebounceTimer) {
      clearTimeout(qcDebounceTimer);
      qcDebounceTimer = null;
    }

    const reqId = ++qcRecomputeRequestId;
    const run = () => {
      if (reqId !== qcRecomputeRequestId) return;
      qcDebounceTimer = null;
      refreshQcNow();
    };

    if (immediate) run();
    else qcDebounceTimer = setTimeout(run, 200);
  }

  function refreshQcNow() {
    if (!uiBuilt) return;
    if (!state.doc) {
      state.qc.ok = true;
      state.qc.perCue = [];
      state.qc.trackPerCue = [];
      state.qc.issues = [];
      state.qc.filteredIssues = [];
      state.qc.activeIssueId = null;
      state.qc.activeIssuePos = -1;
      state.qc.lastComputedAt = Date.now();
      try { renderQcPanel(); } catch {}
      try { applyQcToCueRows(); } catch {}
      try { updateQcNavButtons(); } catch {}
      return;
    }

    const prevSelected = state.qc.activeIssueId;
    const qc = computeEditorQc(state.doc);

    state.qc.ok = qc.failTotal === 0;
    state.qc.perCue = qc.perCue;
    state.qc.issues = qc.issues;
    state.qc.lastComputedAt = Date.now();

    // Phase 4: compute dual-track per-cue status for badges + edit-mode defaults.
    // This is intentionally independent from the single-track QC panel, which is
    // still used for primary deliverable gating.
    try {
      const trackPerCue = computeDualTrackStatusForCueList(state.doc, qc.cfg);
      state.qc.trackPerCue = Array.isArray(trackPerCue) ? trackPerCue : [];
      // Attach to perCue entries for convenience (non-breaking).
      if (Array.isArray(state.qc.perCue) && Array.isArray(state.qc.trackPerCue)) {
        for (let i = 0; i < state.qc.perCue.length; i++) {
          const q = state.qc.perCue[i];
          if (q && typeof q === 'object') q.track = state.qc.trackPerCue[i] || null;
        }
      }
    } catch {
      state.qc.trackPerCue = [];
      if (Array.isArray(state.qc.perCue)) {
        for (let i = 0; i < state.qc.perCue.length; i++) {
          const q = state.qc.perCue[i];
          if (q && typeof q === 'object' && 'track' in q) {
            try { delete q.track; } catch { q.track = null; }
          }
        }
      }
    }

    // Rebuild filtered list based on current filters.
    const showFail = state.qc.filters.fail !== false;
    const showWarn = state.qc.filters.warn !== false;
    state.qc.filteredIssues = qc.issues.filter(it => {
      if (it?.severity === 'fail') return showFail;
      return showWarn;
    });

    // Preserve selection when possible.
    if (prevSelected && state.qc.filteredIssues.some(it => it.id === prevSelected)) {
      state.qc.activeIssueId = prevSelected;
      state.qc.activeIssuePos = state.qc.filteredIssues.findIndex(it => it.id === prevSelected);
    } else {
      state.qc.activeIssueId = null;
      state.qc.activeIssuePos = -1;
    }

    try { applyQcToCueRows(); } catch {}
    try { renderQcPanel(qc.failTotal, qc.warnTotal); } catch {}
    try { updateQcNavButtons(); } catch {}
  }

  function applyQcToCueRows() {
    if (!cuesContainer) return;
    const rows = Array.from(cuesContainer.children || []);
    const perCue = Array.isArray(state.qc.perCue) ? state.qc.perCue : [];

    const cfg = _getQcConfigForDoc(state.doc);
    const cfg608 = _qcCfgFor608Actions(cfg);
    const lim = _getQcTrackLimitsForDoc(state.doc, cfg);

    const showFail = state.qc.filters.fail !== false;
    const showWarn = state.qc.filters.warn !== false;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const q = perCue[i] || null;
      const track = (Array.isArray(state.qc.trackPerCue) ? state.qc.trackPerCue[i] : null)
        || (q && typeof q === 'object' ? (q.track || null) : null);
      const hasFail = !!(q && q.failCount > 0);
      const hasWarn = !!(q && q.warnCount > 0);

      // Row highlighting responds to current filters.
      const showFailHere = showFail && hasFail;
      row.classList.toggle('qc-fail', showFailHere);
      row.classList.toggle('qc-warn', showWarn && hasWarn && !showFailHere);

      // Phase 4: dual-track badges (708/608) + legacy-unsafe highlighting.
      try {
        row.classList.toggle('legacy-unsafe', !!track?.legacyUnsafe);
        const badgeWrap = row.querySelector('.cue-track-badges') || (isMccDoc(state.doc) ? row.querySelector('.cue-qc') : null);
        if (badgeWrap) {
          const b708 = badgeWrap.querySelector('[data-track="708"]');
          const b608 = badgeWrap.querySelector('[data-track="608"]');
          const bDual = badgeWrap.querySelector('[data-track="dual"]');

          if (b708) {
            const has708 = !!is708Doc(state.doc);
            b708.style.display = has708 ? '' : 'none';
            if (has708 && track) {
              const ok = !!track.ok708;
              b708.textContent = ok ? tr('subtitleEditor.qc.badge708Pass', '708 ✅') : tr('subtitleEditor.qc.badge708Fail', '708 ❌');
              b708.classList.toggle('ok', ok);
              b708.classList.toggle('fail', !ok);
            } else {
              b708.textContent = tr('subtitleEditor.qc.badge708Ellipsis', '708 …');
              b708.classList.remove('ok', 'fail');
            }
          }

          if (b608) {
            if (track) {
              const ok = !!track.ok608;
              b608.textContent = ok ? tr('subtitleEditor.qc.badge608Pass', '608 ✅') : tr('subtitleEditor.qc.badge608Fail', '608 ❌');
              b608.classList.toggle('ok', ok);
              b608.classList.toggle('fail', !ok);
            } else {
              b608.textContent = tr('subtitleEditor.qc.badge608Ellipsis', '608 …');
              b608.classList.remove('ok', 'fail');
            }
          }

          if (bDual) {
            const show = !!track?.legacyUnsafe;
            bDual.style.display = show ? '' : 'none';
            if (show) bDual.textContent = tr('subtitleEditor.qc.broadcastSafeLegacyUnsafe', 'Broadcast-safe / Legacy-unsafe ⚠️');
          }
        }
      } catch {}

      // SCC cue list: 608 badge may be rendered in the QC row (before CPS).
      try {
        const b608Alt = row.querySelector('.cue-qc .qc-badge[data-track="608"]');
        if (b608Alt) {
          if (track) {
            const ok = !!track.ok608;
            b608Alt.textContent = ok ? tr('subtitleEditor.qc.badge608Pass', '608 ✅') : tr('subtitleEditor.qc.badge608Fail', '608 ❌');
            b608Alt.classList.toggle('ok', ok);
            b608Alt.classList.toggle('fail', !ok);
          } else {
            b608Alt.textContent = tr('subtitleEditor.qc.badge608Ellipsis', '608 …');
            b608Alt.classList.remove('ok', 'fail');
          }
        }
      } catch {}

      // Phase 5: context-aware 608-only fix actions (shown only when the 608 projection fails).
      try {
        const fixBtns = row.querySelectorAll('.cue-tool-608only');
        if (fixBtns && fixBtns.length) {
          const failTypes608 = Array.isArray(track?.failTypes608) ? track.failTypes608 : [];
          const warnTypes608 = Array.isArray(track?.warnTypes608) ? track.warnTypes608 : [];
          const wantsReflow = failTypes608.includes('maxCols') || failTypes608.includes('maxLines') || warnTypes608.includes('lineBreak');
          const wantsPad = failTypes608.includes('minDuration') || failTypes608.includes('cps') || failTypes608.includes('wpm');
          const wantsSplit = failTypes608.includes('cps') || failTypes608.includes('wpm');

          // Prefer padding first. Only suggest merge when padding cannot satisfy minDuration.
          let wantsMerge = false;
          if (failTypes608.includes('minDuration') && (i + 1 < rows.length)) {
            try {
              const cues = Array.isArray(state.doc?.cues) ? state.doc.cues : [];
              const cue = cues[i];
              const prevCue = cues[i - 1] || null;
              const nextCue = cues[i + 1] || null;
              if (cue) {
                const fps = Number(lim?.fps) || (Number(state.doc?.fps) || 29.97);
                const tol = 0.5 / (Number.isFinite(fps) && fps > 0 ? fps : 30);

                const parts = _effective608PartsForActions(cue, state.doc);
                let required = _requiredTotalDurationFor608Parts(parts, cfg608);
                const maxDur = Number(cfg608?.maxDurationSec);
                if (Number.isFinite(maxDur) && maxDur > 0) required = Math.min(required, maxDur);

                const w = _effective608WindowSec(cue, state.doc);
                const curDur = Math.max(0, w.end - w.start);
                const need = required - curDur;

                const minGap = Math.max(0, Number(cfg608?.minGapSec) || 0);

                const prevEnd = prevCue ? _effective608WindowSec(prevCue, state.doc).end : null;
                const nextStart = nextCue ? _effective608WindowSec(nextCue, state.doc).start : null;

                const slackBefore = (prevEnd != null) ? Math.max(0, w.start - (prevEnd + minGap)) : 0;
                const slackAfter = (nextStart != null) ? Math.max(0, (nextStart - minGap) - w.end) : 0;

                const canPad = (need <= (slackBefore + slackAfter + tol));
                wantsMerge = !canPad;
              }
            } catch {
              wantsMerge = true;
            }
          }

          for (const b of fixBtns) {
            const action = String(b.dataset.action || '');
            let show = false;
            if (action === 'reflow608') show = wantsReflow;
            else if (action === 'pad608') show = wantsPad;
            else if (action === 'split608') show = wantsSplit;
            else if (action === 'merge608') show = wantsMerge;
            b.style.display = show ? '' : 'none';
          }
        }
      } catch {}

      // Update badges when present.
      const qcWrap = row.querySelector('.cue-qc');
      if (!qcWrap || !q) continue;

      const setBadge = (metric, text, cls) => {
        const el = qcWrap.querySelector(`.qc-badge[data-metric="${metric}"]`);
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('fail', cls === 'fail');
        el.classList.toggle('warn', cls === 'warn');
        el.classList.toggle('ok', cls === 'ok');
      };

      const badge = (q && q.badgeStatus && typeof q.badgeStatus === 'object') ? q.badgeStatus : null;

      // Duration (min/max). Fail status comes from shared QC when available.
      let durCls = (badge && typeof badge.dur === 'string') ? badge.dur : 'ok';
      if (!badge) {
        const minFail = Number.isFinite(cfg.minDurationSec) && (q.dur + 1e-9 < cfg.minDurationSec);
        const maxFail = Number.isFinite(cfg.maxDurationSec) && (q.dur - 1e-9 > cfg.maxDurationSec);
        if (minFail || maxFail) durCls = 'fail';
      }
      setBadge('dur', `Dur ${q.dur.toFixed(2)}s`, durCls);

      // Gap / overlap. Fail status comes from shared QC when available.
      if (!Number.isFinite(q.gapToNext)) {
        setBadge('gap', 'Gap —', 'ok');
      } else {
        let gapCls = (badge && typeof badge.gap === 'string') ? badge.gap : 'ok';
        if (!badge) {
          const gapFail = Number.isFinite(cfg.minGapSec) && (q.gapToNext + 1e-9 < cfg.minGapSec);
          if (gapFail) gapCls = 'fail';
        }
        const gapText = (q.gapToNext < 0)
          ? `Overlap ${Math.abs(q.gapToNext).toFixed(2)}s`
          : `Gap ${q.gapToNext.toFixed(2)}s`;
        setBadge('gap', gapText, gapCls);
      }

      // CPS
      let cpsCls = (badge && typeof badge.cps === 'string') ? badge.cps : 'ok';
      if (!badge) {
        const cpsFail = Number.isFinite(cfg.maxCps) && (q.cps - 1e-9 > cfg.maxCps);
        if (cpsFail) cpsCls = 'fail';
      }
      setBadge('cps', `CPS ${q.cps.toFixed(1)}`, cpsCls);

      // WPM
      let wpmCls = (badge && typeof badge.wpm === 'string') ? badge.wpm : 'ok';
      if (!badge) {
        const wpmFail = Number.isFinite(cfg.maxWpm) && (q.wpm - 1e-9 > cfg.maxWpm);
        if (wpmFail) wpmCls = 'fail';
      }
      setBadge('wpm', `WPM ${Math.round(q.wpm)}`, wpmCls);
    }
  }

  function renderQcPanel(failTotal = null, warnTotal = null) {
    if (!qcListEl || !qcCountsEl) return;

    const issuesAll = Array.isArray(state.qc.issues) ? state.qc.issues : [];
    const issues = Array.isArray(state.qc.filteredIssues) ? state.qc.filteredIssues : [];

    const failCount = (failTotal == null)
      ? issuesAll.filter(it => it.severity === 'fail').length
      : failTotal;
    const warnCount = (warnTotal == null)
      ? issuesAll.filter(it => it.severity !== 'fail').length
      : warnTotal;

    qcCountsEl.textContent = tr('subtitleEditor.qc.counts', '{{failCount}} fail • {{warnCount}} warn', { failCount, warnCount });

    qcListEl.innerHTML = '';

    if (!issuesAll.length) {
      const empty = document.createElement('div');
      empty.className = 'qc-empty';
      empty.textContent = tr('subtitleEditor.qc.noIssuesFound', 'No QC issues found.');
      qcListEl.appendChild(empty);
      return;
    }

    if (!issues.length) {
      const empty = document.createElement('div');
      empty.className = 'qc-empty';
      empty.textContent = tr('subtitleEditor.qc.noIssuesMatchFilters', 'No issues match the current filters.');
      qcListEl.appendChild(empty);
      return;
    }

    const selectedId = state.qc.activeIssueId;

    for (let pos = 0; pos < issues.length; pos++) {
      const it = issues[pos];
      const item = document.createElement('div');
      item.className = `qc-item ${it.severity === 'fail' ? 'fail' : 'warn'}`;
      if (selectedId && it.id === selectedId) item.classList.add('selected');
      item.dataset.cueIndex = String(it.cueIndex ?? -1);
      item.dataset.issueId = String(it.id || '');
      item.dataset.pos = String(pos);

      const time = document.createElement('div');
      time.className = 'qc-item-time';
      time.textContent = String(it.timeLabel || formatSeconds(Number(it.start) || 0));

      const msg = document.createElement('div');
      msg.className = 'qc-item-msg';
      const cueIdxNum = Number(it.cueIndex);
      const cueNo = (Number.isFinite(cueIdxNum) && cueIdxNum >= 0) ? (cueIdxNum + 1) : null;
      msg.textContent = cueNo ? `#${cueNo} — ${it.message}` : String(it.message || '');

      item.appendChild(time);
      item.appendChild(msg);
      qcListEl.appendChild(item);
    }
  }

  function setActiveQcIssue(issueId) {
    const id = String(issueId || '');
    if (!id) {
      state.qc.activeIssueId = null;
      state.qc.activeIssuePos = -1;
      try { renderQcPanel(); } catch {}
      try { updateQcNavButtons(); } catch {}
      return;
    }

    const list = Array.isArray(state.qc.filteredIssues) ? state.qc.filteredIssues : [];
    const pos = list.findIndex(it => it && it.id === id);
    if (pos < 0) {
      state.qc.activeIssueId = null;
      state.qc.activeIssuePos = -1;
      try { renderQcPanel(); } catch {}
      try { updateQcNavButtons(); } catch {}
      return;
    }

    state.qc.activeIssueId = id;
    state.qc.activeIssuePos = pos;
    try { renderQcPanel(); } catch {}
    try { updateQcNavButtons(); } catch {}

    // Keep the selected item visible.
    try {
      const el = qcListEl?.querySelector?.(`.qc-item[data-issue-id="${CSS.escape(id)}"]`);
      el?.scrollIntoView?.({ block: 'nearest' });
    } catch {}
  }

  function updateQcNavButtons() {
    const list = Array.isArray(state.qc.filteredIssues) ? state.qc.filteredIssues : [];
    const hasJumpable = list.some(it => Number.isFinite(Number(it?.cueIndex)) && Number(it.cueIndex) >= 0);

    if (qcPrevBtn) qcPrevBtn.disabled = !hasJumpable;
    if (qcNextBtn) qcNextBtn.disabled = !hasJumpable;

    // Optional: jump to first failure (only meaningful when a failure exists in the filtered view).
    const hasFail = list.some(it => it?.severity === 'fail' && Number.isFinite(Number(it?.cueIndex)) && Number(it.cueIndex) >= 0);
    if (qcFirstFailBtn) qcFirstFailBtn.disabled = !hasFail;
  }

  function jumpToFirstQcFail() {
    const list = Array.isArray(state.qc.filteredIssues) ? state.qc.filteredIssues : [];
    if (!list.length) return;

    const pos = list.findIndex(it => it?.severity === 'fail' && Number.isFinite(Number(it?.cueIndex)) && Number(it.cueIndex) >= 0);
    if (pos < 0) return;

    const it = list[pos];
    setActiveQcIssue(it.id);
    jumpToCueIndex(Number(it.cueIndex), { seek: true, focus: true });
  }

  function jumpToAdjacentQcIssue(delta) {
    const dir = (delta < 0) ? -1 : 1;
    const list = Array.isArray(state.qc.filteredIssues) ? state.qc.filteredIssues : [];
    if (!list.length) return;

    const isJumpable = (it) => Number.isFinite(Number(it?.cueIndex)) && Number(it.cueIndex) >= 0;
    if (!list.some(isJumpable)) return;

    let pos = Number(state.qc.activeIssuePos);

    const advance = (p, step) => {
      let np = p + step;
      if (np < 0) np = list.length - 1;
      if (np >= list.length) np = 0;
      return np;
    };

    if (!Number.isFinite(pos) || pos < 0 || pos >= list.length) {
      // Pick a starting point relative to the active cue.
      const curIdx = Number.isFinite(Number(state.activeCue)) ? Number(state.activeCue) : -1;

      if (dir > 0) {
        pos = list.findIndex(it => isJumpable(it) && Number(it.cueIndex) > curIdx);
        if (pos < 0) pos = list.findIndex(isJumpable);
      } else {
        pos = -1;
        for (let i = list.length - 1; i >= 0; i--) {
          if (!isJumpable(list[i])) continue;
          if (Number(list[i].cueIndex) < curIdx) { pos = i; break; }
        }
        if (pos < 0) {
          for (let i = list.length - 1; i >= 0; i--) {
            if (isJumpable(list[i])) { pos = i; break; }
          }
        }
      }
    } else {
      // Wrap + skip non-jumpable (global) issues.
      let tries = 0;
      let np = pos;
      while (tries < list.length) {
        np = advance(np, dir);
        if (isJumpable(list[np])) { pos = np; break; }
        tries++;
      }
    }

    const it = list[pos];
    if (!it || !isJumpable(it)) return;

    setActiveQcIssue(it.id);
    jumpToCueIndex(Number(it.cueIndex), { seek: true, focus: true });
  }

  function jumpToCueIndex(index, { seek = true, focus = false } = {}) {
    if (!Array.isArray(state.doc?.cues) || !state.doc.cues.length) return;
    let idx = Math.trunc(Number(index));
    if (!Number.isFinite(idx)) return;
    idx = Math.max(0, Math.min(state.doc.cues.length - 1, idx));

    // P0-1: deterministic cue switching for QC navigation too.
    if (seek && videoEl && typeof videoEl.currentTime === 'number') {
      const cue = state.doc.cues[idx];
      const t = Number(cue?.start) || 0;
      _setPendingSeek(t);
      try { videoEl.currentTime = t; } catch {}
      try { syncSecondaryTime(true); } catch {}
    }

    state.activeCue = idx;
    highlightCue(idx);

    const row = cuesContainer?.children?.[idx];
    try { row?.scrollIntoView?.({ block: 'center' }); } catch {}

    if (focus) {
      try {
        const ta = row?.querySelector?.('textarea');
        ta?.focus?.();
      } catch {}
    }
  }


  // --- Priority 1.5: "No guessing" cue data inspector -----------------------
  // This surfaces what the encoded/decoded 708 + 608 actually contain (when available),
  // so placement/line breaks can be verified against the file, not vibes.
  function _qcPacFor(row, col) {
    try {
      const nib = Math.floor(Math.max(0, Math.min(31, Number(col) || 0)) / 4);
      return window.transcribeEngine?.pacForRow?.(Number(row) || 0, nib, 1) || '';
    } catch {
      return '';
    }
  }

  function _anchorName708(id) {
    switch (Number(id)) {
      case 0: return 'UPPER_LEFT';
      case 1: return 'UPPER_CENTER';
      case 2: return 'UPPER_RIGHT';
      case 3: return 'MIDDLE_LEFT';
      case 4: return 'MIDDLE_CENTER';
      case 5: return 'MIDDLE_RIGHT';
      case 6: return 'LOWER_LEFT';
      case 7: return 'LOWER_CENTER';
      case 8: return 'LOWER_RIGHT';
      default: return 'UNKNOWN';
    }
  }

  function _cueLinesForInspector(cue) {
    if (!cue) return [];
    // For web captions (SRT/VTT), treat `cue.text` as the canonical source of truth.
    if (!isWebCaptionDoc(state.doc) && Array.isArray(cue.lines) && cue.lines.length) {
      return cue.lines.map(s => String(s ?? ''));
    }
    const t = (typeof cue.text === 'string') ? cue.text : '';
    if (!t) return [];
    return t.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n/);
  }

  function updateQcInspectorForRenderedCues(payload = {}) {
    if (!qcInspectorPreEl) return;

    const canonicalCue = payload.canonicalCue || null;
    const cue708 = payload.cue708 || null;
    const cue608 = payload.cue608 || null;
    const source708 = String(payload.source708 || 'none');
    const source608 = String(payload.source608 || 'none');

    const out = [];

    const cueNum = Number.isFinite(Number(state.activeCue)) ? (Number(state.activeCue) + 1) : null;
    if (canonicalCue) {
      out.push(`Cue ${cueNum != null ? cueNum : ''}: ${formatSeconds(Number(canonicalCue.start) || 0)} → ${formatSeconds(Number(canonicalCue.end) || 0)}`);
    } else {
      out.push('Cue: —');
    }

    // 708 section
    out.push('');
    out.push(`708 (${source708}):`);
    if (cue708 && cue708.cea708 && Array.isArray(cue708.cea708.windows) && cue708.cea708.windows.length) {
      cue708.cea708.windows.forEach((w, i) => {
        const rel = (w.relative !== false);
        const hMax = rel ? 99 : 209;
        const vMax = rel ? 99 : 74;

        const anchorH = Number.isFinite(Number(w.anchorH)) ? Number(w.anchorH) : 0;
        const anchorV = Number.isFinite(Number(w.anchorV)) ? Number(w.anchorV) : 0;
        const anchorId = Number.isFinite(Number(w.anchorId)) ? Number(w.anchorId) : 0;

        const colCount = Number.isFinite(Number(w.colCount)) ? Number(w.colCount) : null;
        const rowCount = Number.isFinite(Number(w.rowCount)) ? Number(w.rowCount) : null;

        const justify = (w.justify != null) ? String(w.justify) : 'left';
        const vis = (w.visible === false) ? ' hidden' : '';

        out.push(
          `  W${i}: ${(rel ? 'rel' : 'abs')} anchorH ${anchorH}/${hMax} anchorV ${anchorV}/${vMax} ` +
          `anchorId ${anchorId} (${_anchorName708(anchorId)}) size ${colCount ?? '?'}x${rowCount ?? '?'} justify ${justify}${vis}`
        );
      });
    } else if (cue708) {
      out.push('  (no 708 window metadata on this cue)');
    } else {
      out.push('  (no 708 cue)');
    }

    const lines708 = _cueLinesForInspector(cue708);
    if (lines708.length) {
      out.push('  Text:');
      for (const ln of lines708) out.push(`    ${ln}`);
    }

    // 608 section
    out.push('');
    out.push(`608 (${source608}):`);

    // Priority 3: make 608 overrides feel intentional and safe.
    // Surface whether an override is active and whether it actually changes output.
    if (wantsDualPreview(state.doc) && canonicalCue) {
      const ov = _getCompat608OverrideText(canonicalCue);
      if (String(ov || '').trim()) {
        let same = false;
        try {
          const derived = _buildDerived608CueForPreview(canonicalCue, state.doc, { ignoreOverride: true });
          const effective = _buildDerived608CueForPreview(canonicalCue, state.doc, { ignoreOverride: false });
          const a = _normalize608CompareText(derived?.text || '');
          const b = _normalize608CompareText(effective?.text || '');
          if (a && b && a === b) same = true;
        } catch {}
        out.push(`  Override: ACTIVE (${same ? 'same as derived' : 'differs from derived'})`);
      } else {
        out.push('  Override: off');
      }
    }
    if (cue608 && Array.isArray(cue608.sccPlacement) && cue608.sccPlacement.length) {
      cue608.sccPlacement.forEach((pl, i) => {
        if (!pl) return;
        const row = Number.isFinite(Number(pl.row)) ? Number(pl.row) : null;
        const col = Number.isFinite(Number(pl.col)) ? Number(pl.col) : null;
        if (row == null || col == null) return;
        const pac = _qcPacFor(row, col);
        out.push(`  L${i + 1}: row ${row}, col ${col}${pac ? ` → ${pac}` : ''}`);
      });
    } else if (cue608) {
      out.push('  (no PAC row/col metadata on this cue)');
    } else {
      out.push('  (no 608 cue)');
    }

    const lines608 = _cueLinesForInspector(cue608);
    if (lines608.length) {
      out.push('  Text:');
      for (const ln of lines608) out.push(`    ${ln}`);
    }

    const finalText = out.join('\n');
    if (finalText === qcInspectorLastText) return;
    qcInspectorLastText = finalText;
    qcInspectorPreEl.textContent = finalText;
  }


  function copyDerived608IntoOverride(index, rowEl = null) {
    const doc = state.doc;
    if (!doc || !wantsDualPreview(doc)) return;
    const cue = doc?.cues?.[index];
    if (!cue) return;

    const row = rowEl || cuesContainer?.querySelector?.(`.cue[data-index="${index}"]`);
    const wrap = row?.querySelector?.('.cue-compat608') || null;
    const cb = wrap?.querySelector?.('input.compat608-enabled') || null;
    const ta = wrap?.querySelector?.('textarea.compat608-text') || null;

    // Compute the baseline derived output ignoring any existing override.
    let seed = '';
    try {
      const derived = _buildDerived608CueForPreview(cue, doc, { ignoreOverride: true });
      seed = Array.isArray(derived?.lines) ? derived.lines.join('\n') : String(derived?.text || '');
    } catch { seed = ''; }
    if (!String(seed || '').trim()) {
      seed = String(_cueTextForEditing(cue) || '').trim();
    }
    if (!String(seed || '').trim()) return;

    if (cb && !cb.checked) {
      cb.checked = true;
      wrap?.classList?.remove?.('disabled');
    }
    if (ta) {
      ta.disabled = false;
      ta.value = String(seed || '').trim();
      autoSizeTextarea(ta);
    }

    pushUndo('Copy derived 608 override');
    _setCompat608OverrideText(cue, String(seed || '').trim(), { skipUndo: true });
    state.activeCue = index;
    markDirty();
    try { scheduleMccPreviewRebuild(true); } catch {}
    try { scheduleQcRecompute(true); } catch {}
    try { updateCompat608UiForCueRow(index, row); } catch {}
    renderActiveCue608();
  }

  function _override708Placeholder() {
    return tr('subtitleEditor.override.placeholder708', 'Optional: override the 708 text only (use Enter for a hard line break)');
  }

  function _override608PlaceholderDefault() {
    return tr('subtitleEditor.override.placeholder608Default', 'Optional: override the derived 608 fallback (use Enter for a hard line break)');
  }

  function _override608PlaceholderMuted() {
    return tr('subtitleEditor.override.placeholder608Muted', 'Muted in 608 (legacy) output');
  }

  function _override608PlaceholderSplit(count) {
    return tr('subtitleEditor.override.placeholder608Split', '608 split override ({{count}} parts) — use the 608 tools to adjust', { count: Number(count) || 0 });
  }

  function updateCompat608UiForCueRow(index, rowEl = null) {
    const doc = state.doc;
    if (!doc || !wantsDualPreview(doc)) return;

    const cue = doc?.cues?.[index];
    if (!cue) return;

    const row = rowEl || cuesContainer?.querySelector?.(`.cue[data-index="${index}"]`);
    if (!row) return;

    const wrap = row.querySelector('.cue-compat608');
    if (!wrap) return;

    const cb = wrap.querySelector('input.compat608-enabled');
    const ta = wrap.querySelector('textarea.compat608-text');
    const status = wrap.querySelector('.compat608-status');
    const compare = wrap.querySelector('.compat608-compare');
    const preDerived = wrap.querySelector('.compat608-compare-pre-derived');
    const preOverride = wrap.querySelector('.compat608-compare-pre-override');
    const copyBtn = wrap.querySelector('button.compat608-copy-derived');

    const partsList = _extractCompat608OverridePartsTextList(cue);
    const muted = _isCompat608Muted(cue);

    const hasAny = _hasAnyMeaningfulOverride608(cue);
    if (cb && cb.checked !== hasAny) cb.checked = hasAny;

    const enabled = hasAny;

    const raw = String(ta?.value ?? _getCompat608OverrideText(cue) ?? '');
    const hasText = !!raw.trim();
    const hasParts = !!(partsList && partsList.length);

    // Timing-only overrides still affect the 608 track even if text is inherited.
    const o = cue?.overrides;
    const o608 = (o && typeof o === 'object') ? o['608'] : null;
    const hasTiming = !!(o608 && typeof o608 === 'object' && (o608.start != null || o608.end != null));

    const active = enabled && (muted || hasParts || hasText || hasTiming);

    // Keep the text field usable only when the override is text-based.
    if (ta) {
      if (muted) {
        ta.disabled = true;
        ta.placeholder = _override608PlaceholderMuted();
        if (ta.value) ta.value = '';
      } else if (hasParts) {
        ta.disabled = true;
        ta.placeholder = _override608PlaceholderSplit(partsList.length);
        const joined = partsList.join('\n\n');
        if (ta.value !== joined) ta.value = joined;
      } else {
        ta.disabled = !enabled;
        ta.placeholder = _override608PlaceholderDefault();

        // Keep the textarea in sync with the stored override when the editor isn't actively typing.
        // (Avoid stomping cursor position while focused.)
        try {
          const desired = String(_getCompat608OverrideText(cue) || '');
          if (ta.value !== desired && document.activeElement !== ta) {
            ta.value = desired;
            try { autoSizeTextarea(ta); } catch {}
          }
        } catch {}
      }
    }
    wrap.classList.toggle('disabled', !enabled);

    // Phase 1.3: staleness tracking — override was authored against an older canonical.
    const possiblyStale = !!(active && _isOverridePossiblyStale608(cue));

    row.classList.toggle('has-608-override', !!active);
    row.classList.toggle('override-possibly-stale', possiblyStale);

    // Only compute derived/compare when the override is enabled (or present).
    let derivedText = '';
    let effectiveOverrideText = '';
    let sameAsDerived = false;

    if (enabled) {
      try {
        const derived = _buildDerived608CueForPreview(cue, doc, { ignoreOverride: true });
        derivedText = String(derived?.text || '');
      } catch { derivedText = ''; }

      if (active) {
        try {
          const eff = _buildDerived608CueForPreview(cue, doc, { ignoreOverride: false });
          effectiveOverrideText = String(eff?.text || raw || '');
        } catch { effectiveOverrideText = raw || ''; }

        const a = _normalize608CompareText(derivedText);
        const b = _normalize608CompareText(effectiveOverrideText);
        sameAsDerived = !!(a && b && a === b);
      }
    }

    const textBased = !!(enabled && hasText && !muted && !hasParts);
    row.classList.toggle('override-same-as-derived', !!(textBased && sameAsDerived));
    row.classList.toggle('override-differs-from-derived', !!(active && (!textBased || !sameAsDerived)));

    if (status) {
      status.classList.remove('is-off', 'is-empty', 'is-same', 'is-diff', 'is-stale');
      if (!enabled) {
        status.textContent = tr('subtitleEditor.override.statusOff', 'Override off');
        status.classList.add('is-off');
      } else if (muted) {
        status.textContent = tr('subtitleEditor.override.statusMuted', '{{stalePrefix}}Override active • muted for 608{{staleSuffix}}', { stalePrefix: possiblyStale ? tr('subtitleEditor.override.stalePrefix', '⚠️ ') : '', staleSuffix: possiblyStale ? tr('subtitleEditor.override.staleSuffix', ' • canonical changed since set') : '' });
        status.classList.add('is-diff');
      } else if (hasParts) {
        status.textContent = tr('subtitleEditor.override.statusSplit', '{{stalePrefix}}Override active • split into {{count}} part{{suffix}}{{staleSuffix}}', { stalePrefix: possiblyStale ? tr('subtitleEditor.override.stalePrefix', '⚠️ ') : '', count: partsList.length, suffix: partsList.length === 1 ? '' : 's', staleSuffix: possiblyStale ? tr('subtitleEditor.override.staleSuffix', ' • canonical changed since set') : '' });
        status.classList.add('is-diff');
      } else if (hasTiming && !hasText) {
        status.textContent = tr('subtitleEditor.override.statusTimingRetime', '{{stalePrefix}}Override active • timing retime (text inherited){{staleSuffix}}', { stalePrefix: possiblyStale ? tr('subtitleEditor.override.stalePrefix', '⚠️ ') : '', staleSuffix: possiblyStale ? tr('subtitleEditor.override.staleSuffix', ' • canonical changed since set') : '' });
        status.classList.add('is-diff');
      } else if (!hasText) {
        status.textContent = tr('subtitleEditor.override.statusOnEmptyUsingDerived', 'Override on • empty (using derived)');
        status.classList.add('is-empty');
      } else if (sameAsDerived) {
        status.textContent = possiblyStale
          ? tr('subtitleEditor.override.statusSameAsDerivedStale', '⚠️ Override active • same as derived (canonical changed since set)')
          : tr('subtitleEditor.override.statusSameAsDerived', 'Override active • same as derived');
        status.classList.add('is-same');
      } else {
        const summary = _compat608DiffSummary(derivedText, effectiveOverrideText);
        status.textContent = summary
          ? tr('subtitleEditor.override.statusDiffersSummary', '{{stalePrefix}}Override active • differs ({{summary}}){{staleSuffix}}', { stalePrefix: possiblyStale ? tr('subtitleEditor.override.stalePrefix', '⚠️ ') : '', summary, staleSuffix: possiblyStale ? tr('subtitleEditor.override.staleSuffix', ' • canonical changed since set') : '' })
          : tr('subtitleEditor.override.statusDiffersFromDerived', '{{stalePrefix}}Override active • differs from derived{{staleSuffix}}', { stalePrefix: possiblyStale ? tr('subtitleEditor.override.stalePrefix', '⚠️ ') : '', staleSuffix: possiblyStale ? tr('subtitleEditor.override.staleSuffix', ' • canonical changed since set') : '' });
        status.classList.add('is-diff');
      }
      if (possiblyStale) status.classList.add('is-stale');
    }

    if (compare) {
      compare.style.display = enabled ? '' : 'none';
      compare.classList.toggle('same', !!sameAsDerived);
      compare.classList.toggle('diff', !!(active && !sameAsDerived));
      if (preDerived) preDerived.textContent = enabled ? (derivedText || tr('subtitleEditor.common.emDash', '—')) : '';
      if (preOverride) {
        preOverride.textContent = enabled
          ? (hasText ? (effectiveOverrideText || tr('subtitleEditor.common.emDash', '—')) : tr('subtitleEditor.common.emDash', '—'))
          : '';
      }
    }

    if (copyBtn) {
      copyBtn.disabled = false;
    }

    if (Number(state.activeCue) === Number(index)) {
      try { _update608OverridePillForActiveCue(); } catch {}
    }
  }

  function updateOverride708UiForCueRow(index, rowEl = null) {
    const doc = state.doc;
    if (!doc || !is708Doc(doc)) return;

    const cue = doc?.cues?.[index];
    if (!cue) return;

    const row = rowEl || cuesContainer?.querySelector?.(`.cue[data-index="${index}"]`);
    if (!row) return;

    const wrap = row.querySelector('.cue-override708');
    if (!wrap) return;

    const cb = wrap.querySelector('input.override708-enabled');
    const ta = wrap.querySelector('textarea.override708-text');
    const status = wrap.querySelector('.override708-status');

    const enabled = !!cb?.checked;
    const raw = String(ta?.value ?? _getOverride708Text(cue) ?? '');
    const hasText = !!raw.trim();
    const active = enabled && hasText;
    const possiblyStale = !!(active && _isOverridePossiblyStale708(cue));

    row.classList.toggle('has-708-override', !!active);
    row.classList.toggle('override708-possibly-stale', possiblyStale);

    if (status) {
      status.classList.remove('is-off', 'is-empty', 'is-on', 'is-stale');
      if (!enabled) {
        status.textContent = tr('subtitleEditor.override.statusOff', 'Override off');
        status.classList.add('is-off');
        if (ta) ta.placeholder = _override708Placeholder();
      } else if (!hasText) {
        status.textContent = tr('subtitleEditor.override.statusOnEmptyUsingCanonical', 'Override on • empty (using canonical)');
        status.classList.add('is-empty');
        if (ta) ta.placeholder = _override708Placeholder();
      } else {
        status.textContent = possiblyStale
          ? tr('subtitleEditor.override.statusActiveStale', '⚠️ Override active • canonical changed since set')
          : tr('subtitleEditor.override.statusActive', 'Override active');
        status.classList.add('is-on');
        if (ta) ta.placeholder = _override708Placeholder();
      }
      if (possiblyStale) status.classList.add('is-stale');
    }
  }


  function renderCuesWeb(cues) {
    if (!cuesContainer) return;
    const isScc = isSccDoc(state.doc);
    const isMcc = isMccDoc(state.doc);
    cuesContainer.innerHTML = '';
    cues.forEach((cue, idx) => {
      const row = document.createElement('div');
      row.className = 'cue';
      row.dataset.index = String(idx);
      if (isScc) row.classList.add('scc-cue');

      // MCC should use the same compact cue layout rules as SCC.
      if (isMcc) row.classList.add('mcc-cue');

      const postMountDropdowns = [];

      const startInput = document.createElement('input');
      startInput.type = 'text';
      startInput.value = formatSeconds(cue.start);
      startInput.addEventListener('change', () => updateCueTime(idx, 'start', startInput.value));

      const endInput = document.createElement('input');
      endInput.type = 'text';
      endInput.value = formatSeconds(cue.end);
      endInput.addEventListener('change', () => updateCueTime(idx, 'end', endInput.value));

      const textArea = document.createElement('textarea');
      textArea.className = 'cue-text cue-text-canonical';
      textArea.dataset.track = 'canonical';
      textArea.value = String(_cueTextForEditing(cue) || '');
      textArea.rows = 3;
      // Ensure true multi-line editing (fixed 3-line height; no auto-grow)
      textArea.style.whiteSpace = 'pre-wrap';
      _attachHistorySyncHandlers(textArea);
      textArea.addEventListener('input', () => {
        updateCueText(idx, textArea.value);
      });

      // Minimal timing tools for web captions (SRT/VTT).
      // Keep this intentionally lightweight: frame-steal (bounded ripple) and
      // frame-remove (no ripple).
      //
      // Layout goal (per request): keep *each* Steal/Remove control set on a
      // single horizontal line (no 2×2 layout).
      const tools = document.createElement('div');
      tools.className = 'cue-tools cue-tools-web-timing-inline';
      tools.style.gridColumn = '1 / -1';

      const mkToolBtn = (label, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cue-tool-btn';
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          try { onClick(ev); } catch {}
        });
        return b;
      };

      // Timing helper: steal 2–4 frames from neighbors (bounded ripple)
      const stealFramesDropdownId = `cue-${idx}-steal-frames`;
      const stealFramesOpts = [
        { value: '2', label: '2f' },
        { value: '3', label: '3f' },
        { value: '4', label: '4f' }
      ];
      const { wrap: stealSelWrap, hidden: stealSel } = _mkStyledDropdownWrapper({
        hiddenId: stealFramesDropdownId,
        ariaLabel: 'Steal frames',
        wrapperClass: 'cue-tool-select cue-steal-frames'
      });
      stealSelWrap.addEventListener('click', (ev) => { ev.stopPropagation(); });
      stealSel.value = '2';
      postMountDropdowns.push(() => _setupStyledDropdownSafe(stealFramesDropdownId, stealFramesOpts, stealSel.value));

      const stealLeftBtn = mkToolBtn('Steal ←', 'Shorten previous cue and give these frames to this cue.', () => {
        stealFramesFromNeighbor(idx, -1, Number(stealSel.value) || 2);
      });
      const stealRightBtn = mkToolBtn('Steal →', 'Shorten next cue and give these frames to this cue.', () => {
        stealFramesFromNeighbor(idx, +1, Number(stealSel.value) || 2);
      });
      stealLeftBtn.disabled = (idx <= 0);
      stealRightBtn.disabled = (idx >= (cues.length - 1));

      // Inline group: Steal ← [dropdown] Steal →
      const stealInline = document.createElement('div');
      stealInline.className = 'cue-tool-inline-group cue-tool-inline-group-steal';
      stealInline.appendChild(stealLeftBtn);
      stealInline.appendChild(stealSelWrap);
      stealInline.appendChild(stealRightBtn);

      // Timing helper: remove N frames from this cue's start/end (no neighbor ripple)
      const removeFramesDropdownId = `cue-${idx}-remove-frames`;
      const removeFramesOpts = [
        { value: '1', label: '1f' },
        { value: '2', label: '2f' },
        { value: '3', label: '3f' },
        { value: '4', label: '4f' }
      ];
      const { wrap: removeSelWrap, hidden: removeSel } = _mkStyledDropdownWrapper({
        hiddenId: removeFramesDropdownId,
        ariaLabel: 'Remove frames',
        wrapperClass: 'cue-tool-select cue-remove-frames'
      });
      removeSelWrap.addEventListener('click', (ev) => { ev.stopPropagation(); });
      removeSel.value = '1';
      postMountDropdowns.push(() => _setupStyledDropdownSafe(removeFramesDropdownId, removeFramesOpts, removeSel.value));

      const getRemoveFrames = () => {
        const n = parseInt(String(removeSel.value || '1'), 10);
        return Math.max(1, Math.min(12, Number.isFinite(n) ? n : 1));
      };

      const removeLeftBtn = mkToolBtn('Remove ←', 'Shorten this cue by removing frames from its start (no ripple).', () => {
        removeFramesFromCue(idx, 'left', getRemoveFrames());
      });
      const removeRightBtn = mkToolBtn('Remove →', 'Shorten this cue by removing frames from its end (no ripple).', () => {
        removeFramesFromCue(idx, 'right', getRemoveFrames());
      });
      // Inline group: Remove ← [dropdown] Remove →
      const removeInline = document.createElement('div');
      removeInline.className = 'cue-tool-inline-group cue-tool-inline-group-remove';
      removeInline.appendChild(removeLeftBtn);
      removeInline.appendChild(removeSelWrap);
      removeInline.appendChild(removeRightBtn);

      tools.appendChild(stealInline);
      tools.appendChild(removeInline);

      row.appendChild(startInput);
      row.appendChild(endInput);
      row.appendChild(textArea);
      row.appendChild(tools);

      cuesContainer.appendChild(row);
      try {
        for (const fn of postMountDropdowns) {
          try { fn(); } catch {}
        }
      } catch {}

    });
    highlightCue(state.activeCue);
    // Preview rendering is format-aware (web captions render via __editorWeb).
    renderActiveCue608();

    // Fresh rows were created; decorate them immediately.
    try { scheduleQcRecompute(true); } catch {}
  }

  function renderCuesBroadcast(cues) {
    if (!cuesContainer) return;
    const qcCfg = _getQcConfigForDoc(state.doc);
    const lim = _getQcTrackLimitsForDoc(state.doc, qcCfg);
    const isScc = isSccDoc(state.doc);
    const isMcc = isMccDoc(state.doc);
    cuesContainer.innerHTML = '';
    cues.forEach((cue, idx) => {
      const row = document.createElement('div');
      row.className = 'cue';
      row.dataset.index = String(idx);

      // SCC cue list has a slightly different compact layout (tools row + QC row).
      if (isScc) row.classList.add('scc-cue');

      // MCC cue list should visually match the SCC compact layout.
      if (isMcc) row.classList.add('mcc-cue');

      const postMountDropdowns = [];
      let styleWrapPending = null;
      let editModeWrapPending = null;

      const startInput = document.createElement('input');
      startInput.type = 'text';
      startInput.value = formatSeconds(cue.start);
      startInput.addEventListener('change', () => updateCueTime(idx, 'start', startInput.value));

      const endInput = document.createElement('input');
      endInput.type = 'text';
      endInput.value = formatSeconds(cue.end);
      endInput.addEventListener('change', () => updateCueTime(idx, 'end', endInput.value));

      const textArea = document.createElement('textarea');
      textArea.className = 'cue-text cue-text-canonical';
      textArea.dataset.track = 'canonical';
      const textFromRuns = _cueTextFromRuns(cue.runs || cue.canonical?.runs);
      const initialText = (() => {
        // Only prefer `lines[]` as the editor value for 608-style docs.
        // Web captions (SRT/VTT) and V2 JSON payloads may populate only canonical fields.
        const preferLines = is608Doc(state.doc);
        if (preferLines) {
          const l = (Array.isArray(cue.lines) && cue.lines.length)
            ? cue.lines
            : (Array.isArray(cue.canonical?.lines) && cue.canonical.lines.length)
              ? cue.canonical.lines
              : null;
          if (l && l.length) return l.join('\n');
        }

        // Prefer plain text, then runs, then lines.
        if (typeof cue.text === 'string' && cue.text.length) return cue.text;
        if (typeof cue.canonical?.text === 'string' && cue.canonical.text.length) return cue.canonical.text;
        if (textFromRuns) return textFromRuns;
        if (Array.isArray(cue.lines) && cue.lines.length) return cue.lines.join('\n');
        if (Array.isArray(cue.canonical?.lines) && cue.canonical.lines.length) return cue.canonical.lines.join('\n');
        return '';
      })();
      const cueListText = isSccDoc(state.doc) ? _cueTextForCueList(cue) : initialText;
      textArea.value = cueListText;
      textArea.rows = 3;
      // Ensure true multi-line editing (fixed 3-line height; no auto-grow)
      textArea.style.whiteSpace = 'pre-wrap';
      _attachHistorySyncHandlers(textArea);
      textArea.addEventListener('input', () => {
        updateCueText(idx, textArea.value);
      });

      row.appendChild(startInput);
      row.appendChild(endInput);
      row.appendChild(textArea);

      // Cue-level styling (runs[]) — only relevant for MCC/708 cues.
      // These controls are intentionally per-caption (not global) and only shown on the active cue.
      if (is708Doc(state.doc)) {
        const styleWrap = document.createElement('div');
        styleWrap.className = 'cue-style-controls';
        styleWrap.style.gridColumn = '1 / -1';
        styleWrap.style.display = 'none';

        // Prevent bubbling to the cue-row click handler while interacting with style controls.
        styleWrap.addEventListener('click', (ev) => { ev.stopPropagation(); });

        const label = document.createElement('span');
        label.className = 'cue-style-label';
        label.textContent = tr('subtitleEditor.override.styleLabel', 'Style:');

        const mkBtn = (cls, title, text, inlineStyle = null) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `cue-style-btn ${cls}`;
          b.setAttribute('aria-pressed', 'false');
          if (title) b.title = title;
          b.textContent = text;
          if (inlineStyle && typeof inlineStyle === 'object') {
            try { Object.assign(b.style, inlineStyle); } catch {}
          }
          b.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            try { _toggleAriaPressed(b); } catch {}
            try { _applyCueLevelStyleFromControls(idx, styleWrap); } catch {}
          });
          return b;
        };

        const mkSelect = (cls, title, ariaLabel, options) => {
          const key = String(cls || '').toLowerCase();
          const hiddenId = key.includes('cue-style-fg')
            ? `cue-${idx}-style-fg`
            : key.includes('cue-style-bg')
              ? `cue-${idx}-style-bg`
              : `cue-${idx}-style-${String(cls || 'opt').replace(/[^a-z0-9]+/gi, '-')}`;

          const opts = (Array.isArray(options) ? options : []).map(([value, labelText]) => ({
            value: String(value),
            label: String(labelText)
          }));

          const { wrap, hidden } = _mkStyledDropdownWrapper({
            hiddenId,
            ariaLabel: ariaLabel || title || tr('subtitleEditor.cue.styleAriaLabel', 'Style'),
            wrapperClass: `cue-style-select ${cls}`
          });

          // Preserve native select affordances (hover tooltip).
          if (title) wrap.title = title;

          // Mark the hidden input for easy lookup.
          hidden.className = `cue-style-hidden ${cls}`;

          // Default selection (will be synced for the active cue).
          hidden.value = String(opts?.[0]?.value || '');

          hidden.addEventListener('change', (ev) => {
            ev.stopPropagation();
            try { _applyCueLevelStyleFromControls(idx, styleWrap); } catch {}
          });

          // Populate after this row is in the DOM.
          postMountDropdowns.push(() => _setupStyledDropdownSafe(hiddenId, opts, hidden.value));

          return wrap;
        };

        styleWrap.appendChild(label);
        styleWrap.appendChild(mkBtn('cue-style-italic', tr('subtitleEditor.cue.styleItalicTitle', 'Italic'), 'I', { fontStyle: 'italic', minWidth: '32px' }));
        styleWrap.appendChild(mkBtn('cue-style-underline', tr('subtitleEditor.cue.styleUnderlineTitle', 'Underline'), 'U', { textDecoration: 'underline', minWidth: '32px' }));
        styleWrap.appendChild(mkSelect(
          'cue-style-fg',
          tr('subtitleEditor.cue.styleTextColorTitle', 'Text color'),
          tr('subtitleEditor.cue.styleTextColorAriaLabel', 'Text color'),
          [
            ['white', tr('subtitleEditor.cue.styleTextWhite', 'Text: White')],
            ['yellow', tr('subtitleEditor.cue.styleTextYellow', 'Text: Yellow')],
            ['cyan', tr('subtitleEditor.cue.styleTextCyan', 'Text: Cyan')],
            ['green', tr('subtitleEditor.cue.styleTextGreen', 'Text: Green')],
            ['magenta', tr('subtitleEditor.cue.styleTextMagenta', 'Text: Magenta')],
            ['red', tr('subtitleEditor.cue.styleTextRed', 'Text: Red')],
            ['blue', tr('subtitleEditor.cue.styleTextBlue', 'Text: Blue')]
          ]
        ));
        styleWrap.appendChild(mkSelect(
          'cue-style-bg',
          tr('subtitleEditor.cue.styleBackgroundTitle', 'Background'),
          tr('subtitleEditor.cue.styleBackgroundAriaLabel', 'Background'),
          [
            ['none', tr('subtitleEditor.cue.styleBgNone', 'BG: None')],
            ['black75', tr('subtitleEditor.cue.styleBgBlack75', 'BG: Black 75%')],
            ['black100', tr('subtitleEditor.cue.styleBgBlack100', 'BG: Black 100%')]
          ]
        ));

        styleWrapPending = styleWrap;
      }

      if (!isScc && !isMcc) {

      // Phase 4: per-cue dual-track badges (708/608) + special legacy-unsafe marker.
      // (Actual pass/fail values are filled by applyQcToCueRows() after QC runs.)
      const trackBadgeWrap = document.createElement('div');
      trackBadgeWrap.className = 'cue-track-badges';
      trackBadgeWrap.style.gridColumn = '1 / -1';
      trackBadgeWrap.style.display = 'flex';
      trackBadgeWrap.style.alignItems = 'center';
      trackBadgeWrap.style.gap = '6px';
      trackBadgeWrap.style.flexWrap = 'wrap';
      trackBadgeWrap.style.margin = '2px 0 2px 0';

      const mkTrackBadge = (track, text) => {
        const b = document.createElement('span');
        b.className = 'qc-badge';
        b.dataset.track = track;
        b.textContent = text;
        return b;
      };

      // 708 badge is hidden for non-708 docs in applyQcToCueRows().
      trackBadgeWrap.appendChild(mkTrackBadge('708', tr('subtitleEditor.qc.badge708Ellipsis', '708 …')));
      trackBadgeWrap.appendChild(mkTrackBadge('608', tr('subtitleEditor.qc.badge608Ellipsis', '608 …')));
      const dual = mkTrackBadge('dual', tr('subtitleEditor.qc.legacyUnsafe', 'Legacy-unsafe ⚠️'));
      dual.style.display = 'none';
      trackBadgeWrap.appendChild(dual);

      row.appendChild(trackBadgeWrap);

      }

      // Phase 4: explicit edit mode toggle (only shown for the active cue).
      // SCC/608-only docs are always canonical, so skip this block to avoid clutter.
      if (is708Doc(state.doc)) {
        const editModeWrap = document.createElement('div');
        editModeWrap.className = 'cue-edit-mode';
        editModeWrap.style.gridColumn = '1 / -1';
        editModeWrap.style.display = 'none';

        const topLine = document.createElement('div');
        topLine.style.display = 'flex';
        topLine.style.alignItems = 'center';
        topLine.style.gap = '10px';
        topLine.style.flexWrap = 'wrap';

        const editLabel = document.createElement('span');
        editLabel.textContent = tr('subtitleEditor.override.editLabel', 'Edit:');

        const mkModeOption = (value, labelText) => {
          const l = document.createElement('label');
          l.style.display = 'inline-flex';
          l.style.alignItems = 'center';
          l.style.gap = '6px';

          // Don't let the cue-row click handler reset edit mode while interacting with radios.
          l.addEventListener('click', (ev) => { ev.stopPropagation(); });

          const r = document.createElement('input');
          r.type = 'radio';
          r.name = `editMode_${idx}`;
          r.value = value;
          // Prevent bubbling to the cue-row click handler (which can re-apply defaults before change runs).
          r.addEventListener('click', (ev) => { ev.stopPropagation(); });
          r.addEventListener('change', () => {
            if (!r.checked) return;
            try { setEditModeForCue(idx, value, true); } catch {}
          });
          const s = document.createElement('span');
          s.textContent = labelText;
          l.appendChild(r);
          l.appendChild(s);
          return l;
        };

        topLine.appendChild(editLabel);
        topLine.appendChild(mkModeOption('canonical', 'Canonical'));
        topLine.appendChild(mkModeOption('708', '708 override'));
        topLine.appendChild(mkModeOption('608', '608 override'));

        // Keep the edit-mode selector, but drop the verbose per-cue hint/stats
        // (redundant with other QC/metadata panels and consumes too much space).
        editModeWrap.appendChild(topLine);
        if (isMcc) {
          // MCC layout matches SCC: edit-mode selector lives under Style row (and above QC).
          editModeWrapPending = editModeWrap;
        } else {
          row.appendChild(editModeWrap);
        }
      }

      // Phase 4: 708 per-cue text override editor.
      // This overrides *only* the 708 service text in the exported MCC, while 608 continues to project
      // from canonical (and can have its own independent override).
      if (is708Doc(state.doc)) {
        const ovWrap = document.createElement('div');
        ovWrap.className = 'cue-override708';
        ovWrap.style.gridColumn = '1 / -1';

        const head = document.createElement('div');
        head.className = 'override708-head';

        const label = document.createElement('label');
        label.className = 'checkbox-label override708-label';
        // Avoid cue-row click handler running before the checkbox change handler.
        label.addEventListener('click', (ev) => { ev.stopPropagation(); });

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'override708-enabled';
        cb.addEventListener('click', (ev) => { ev.stopPropagation(); });

        const title = document.createElement('span');
        title.textContent = tr('subtitleEditor.override.title708', '708 override');

        label.appendChild(cb);
        label.appendChild(title);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'override708-copy-canonical';
        copyBtn.textContent = tr('subtitleEditor.override.copyCanonicalToOverride', 'Copy canonical → override');
        copyBtn.title = tr('subtitleEditor.override.copyCanonicalToOverrideTitle', 'Seed the 708 override with the current canonical text.');
        copyBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          try {
            cb.checked = true;
            const seed = String(_cueTextForEditing(cue) || '').trim();
            ta.value = seed;
            autoSizeTextarea(ta);
            // Let the normal checkbox pipeline handle state changes + dirty flagging.
            try { cb.dispatchEvent(new Event('change')); } catch {}
          } catch {}
        });

        head.appendChild(label);
        head.appendChild(copyBtn);

        const status = document.createElement('div');
        status.className = 'override708-status';
        status.textContent = tr('subtitleEditor.override.statusOff', 'Override off');

        const ta = document.createElement('textarea');
        ta.className = 'cue-text override708-text';
        ta.dataset.track = '708';
        ta.placeholder = _override708Placeholder();
        ta.rows = 3;
        _attachHistorySyncHandlers(ta);

        const existing = _getOverride708Text(cue);
        const enabled = !!existing && String(existing).trim().length > 0;
        cb.checked = enabled;
        ta.value = enabled ? existing : '';
        ta.disabled = !enabled;
        ovWrap.classList.toggle('disabled', !enabled);

        cb.addEventListener('change', () => {
          const on = !!cb.checked;
          ovWrap.classList.toggle('disabled', !on);
          ta.disabled = !on;
          if (on) {
            if (!ta.value.trim()) {
              const seed = String(_cueTextForEditing(cue) || '').trim();
              ta.value = seed;
            }
            _setOverride708Text(cue, ta.value, { undoLabel: 'Enable 708 override' });
            // Focus to make “Edit 708 override” feel immediate.
            try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
          } else {
            _clearOverride708(cue, { undoLabel: 'Disable 708 override' });
            ta.value = '';
          }
          autoSizeTextarea(ta);
          updateOverride708UiForCueRow(idx, row);
          state.activeCue = idx;
          markDirty();
          try { scheduleMccPreviewRebuild(false); } catch {}
          try { scheduleQcRecompute(false); } catch {}
          try { renderActiveCue608(); } catch {}
          try { _updateActiveCueEditModeUi(); } catch {}
        });

        ta.addEventListener('input', () => {
          autoSizeTextarea(ta);
          if (!cb.checked) return;
          _setOverride708Text(cue, ta.value, { groupId: `text:${idx}:708` });
          updateOverride708UiForCueRow(idx, row);
          state.activeCue = idx;
          markDirty();
          try { scheduleMccPreviewRebuild(false); } catch {}
          try { scheduleQcRecompute(false); } catch {}
          try { renderActiveCue608(); } catch {}
          try { _updateActiveCueEditModeUi(); } catch {}
        });

        ovWrap.appendChild(head);
        ovWrap.appendChild(status);
        ovWrap.appendChild(ta);

        row.appendChild(ovWrap);

        // Initialize status classes/text.
        try { updateOverride708UiForCueRow(idx, row); } catch {}
      }

      // Milestone 5: expose a 608 override field (stored on the canonical cue
      // as compat608Text) so editors can fix the fallback without changing 708.
      if (wantsDualPreview(state.doc)) {
        const compatWrap = document.createElement('div');
        compatWrap.className = 'cue-compat608';
        compatWrap.style.gridColumn = '1 / -1';

        const head = document.createElement('div');
        head.className = 'compat608-head';

        const label = document.createElement('label');
        label.className = 'checkbox-label compat608-label';
        // Avoid cue-row click handler running before the checkbox change handler.
        label.addEventListener('click', (ev) => { ev.stopPropagation(); });

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'compat608-enabled';
        cb.addEventListener('click', (ev) => { ev.stopPropagation(); });

        const title = document.createElement('span');
        title.textContent = tr('subtitleEditor.override.title608', '608 override');

        label.appendChild(cb);
        label.appendChild(title);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'compat608-copy-derived';
        copyBtn.textContent = tr('subtitleEditor.override.copyDerivedToOverride', 'Copy derived → override');
        copyBtn.title = tr('subtitleEditor.override.copyDerivedToOverrideTitle', 'Copy the current derived 608 fallback (computed without override) into the override field.');
        copyBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          try { copyDerived608IntoOverride(idx, row); } catch {}
        });

        head.appendChild(label);
        head.appendChild(copyBtn);

        const status = document.createElement('div');
        status.className = 'compat608-status';
        status.textContent = tr('subtitleEditor.override.statusOff', 'Override off');

        const ta = document.createElement('textarea');
        ta.className = 'cue-text compat608-text';
        ta.dataset.track = '608';
        ta.placeholder = _override608PlaceholderDefault();
        ta.rows = 3;
        _attachHistorySyncHandlers(ta);

        const existing = _getCompat608OverrideText(cue);
        const partsList = _extractCompat608OverridePartsTextList(cue);
        const muted = _isCompat608Muted(cue);
        const enabled = _hasAnyMeaningfulOverride608(cue);

        cb.checked = enabled;

        if (muted) {
          ta.value = '';
          ta.placeholder = _override608PlaceholderMuted();
          ta.disabled = true;
        } else if (partsList && partsList.length) {
          ta.value = partsList.join('\n\n');
          ta.placeholder = _override608PlaceholderSplit(partsList.length);
          ta.disabled = true;
        } else {
          ta.value = enabled ? existing : '';
          ta.placeholder = _override608PlaceholderDefault();
          ta.disabled = !enabled;
        }
        compatWrap.classList.toggle('disabled', !enabled);

        cb.addEventListener('change', () => {
          const on = !!cb.checked;
          compatWrap.classList.toggle('disabled', !on);
          ta.disabled = !on;
          if (on) {
            if (!ta.value.trim()) {
              // Safer default: seed from the *derived 608 baseline* (no override).
              let seed = '';
              try {
                const derived = _buildDerived608CueForPreview(cue, state.doc, { ignoreOverride: true });
                seed = Array.isArray(derived?.lines) ? derived.lines.join('\n') : String(derived?.text || '');
              } catch { seed = ''; }
              if (!String(seed || '').trim()) seed = String(_cueTextForEditing(cue) || '').trim();
              ta.value = String(seed || '').trim();
              autoSizeTextarea(ta);
            }
            _setCompat608OverrideText(cue, ta.value, { undoLabel: 'Enable 608 override' });
          } else {
            _clearCompat608Override(cue, { undoLabel: 'Disable 608 override' });
            ta.value = '';
            autoSizeTextarea(ta);
          }
          state.activeCue = idx;
          markDirty();
          try { updateCompat608UiForCueRow(idx, row); } catch {}
          renderActiveCue608();
          try { _updateActiveCueEditModeUi(); } catch {}
        });

        ta.addEventListener('input', () => {
          if (!cb.checked) return;
          _setCompat608OverrideText(cue, ta.value, { groupId: `text:${idx}:608` });
          state.activeCue = idx;
          markDirty();
          // Preview is built from encoded MCC; debounce to avoid per-keystroke IPC churn.
          scheduleMccPreviewRebuild(false);
          try { updateCompat608UiForCueRow(idx, row); } catch {}
          renderActiveCue608();
          try { _updateActiveCueEditModeUi(); } catch {}
        });

        // Side-by-side derived vs override clarity.
        const compare = document.createElement('div');
        compare.className = 'compat608-compare';

        const mkCol = (titleText, preClass) => {
          const col = document.createElement('div');
          col.className = 'compat608-compare-col';
          const t = document.createElement('div');
          t.className = 'compat608-compare-title';
          t.textContent = titleText;
          const pre = document.createElement('pre');
          pre.className = `compat608-compare-pre ${preClass}`;
          pre.textContent = tr('subtitleEditor.common.emDash', '—');
          col.appendChild(t);
          col.appendChild(pre);
          return col;
        };

        compare.appendChild(mkCol(tr('subtitleEditor.override.compareDerivedTitle', 'Derived 608 (baseline)'), 'compat608-compare-pre-derived'));
        compare.appendChild(mkCol(tr('subtitleEditor.override.compareOverrideTitle', 'Override 608 (effective)'), 'compat608-compare-pre-override'));

        autoSizeTextarea(ta);
        compatWrap.appendChild(head);
        compatWrap.appendChild(status);
        compatWrap.appendChild(ta);
        compatWrap.appendChild(compare);
        row.appendChild(compatWrap);

        // Initialize UI state once.
        try { updateCompat608UiForCueRow(idx, row); } catch {}
      }
      // Priority 2: one-click fix helpers (human stays in charge)
      const tools = document.createElement('div');
      tools.className = 'cue-tools';
      tools.style.gridColumn = '1 / -1';

      const mkToolBtn = (label, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cue-tool-btn';
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          try { onClick(ev); } catch {}
        });
        return b;
      };

      // Split helpers
      const splitCursorBtn = mkToolBtn('Split @ cursor', 'Split this cue at the text cursor (time uses playhead when possible).', () => {
        splitCueAtCursor(idx, textArea);
      });
      const splitPunctBtn = mkToolBtn('Split on punct', 'Split this cue at a good punctuation boundary.', () => {
        splitCueOnPunctuation(idx);
      });

      // SCC/MCC: keep Split/Steal/Remove on one compact row beneath the cue.
      // Other broadcast modes keep Split buttons as simple standalone controls above timing tools.
      if (!isScc && !isMcc) {
        tools.appendChild(splitCursorBtn);
        tools.appendChild(splitPunctBtn);
      }

      // Timing helpers: Steal/Remove frames.
      // SCC cue list uses an inline layout (buttons + dropdown on one row).
      // Other broadcast modes keep the compact 2×2 layout (dropdowns on top).
      const stealFramesDropdownId = `cue-${idx}-steal-frames`;
      const stealFramesOpts = [
        { value: '2', label: '2f' },
        { value: '3', label: '3f' },
        { value: '4', label: '4f' }
      ];
      const { wrap: stealSelWrap, hidden: stealSel } = _mkStyledDropdownWrapper({
        hiddenId: stealFramesDropdownId,
        ariaLabel: 'Steal frames',
        wrapperClass: 'cue-tool-select cue-steal-frames'
      });
      stealSelWrap.addEventListener('click', (ev) => { ev.stopPropagation(); });
      stealSel.value = '2';
      postMountDropdowns.push(() => _setupStyledDropdownSafe(stealFramesDropdownId, stealFramesOpts, stealSel.value));

      const stealLeftBtn = mkToolBtn('Steal ←', 'Shorten previous cue and give these frames to this cue.', () => {
        stealFramesFromNeighbor(idx, -1, Number(stealSel.value) || 2);
      });
      const stealRightBtn = mkToolBtn('Steal →', 'Shorten next cue and give these frames to this cue.', () => {
        stealFramesFromNeighbor(idx, +1, Number(stealSel.value) || 2);
      });
      stealLeftBtn.disabled = (idx <= 0);
      stealRightBtn.disabled = (idx >= (cues.length - 1));

      const removeFramesDropdownId = `cue-${idx}-remove-frames`;
      const removeFramesOpts = [
        { value: '1', label: '1f' },
        { value: '2', label: '2f' },
        { value: '3', label: '3f' },
        { value: '4', label: '4f' }
      ];
      const { wrap: removeSelWrap, hidden: removeSel } = _mkStyledDropdownWrapper({
        hiddenId: removeFramesDropdownId,
        ariaLabel: 'Remove frames',
        wrapperClass: 'cue-tool-select cue-remove-frames'
      });
      removeSelWrap.addEventListener('click', (ev) => { ev.stopPropagation(); });
      removeSel.value = '1';
      postMountDropdowns.push(() => _setupStyledDropdownSafe(removeFramesDropdownId, removeFramesOpts, removeSel.value));

      const getRemoveFrames = () => {
        const n = parseInt(String(removeSel.value || '1'), 10);
        return Math.max(1, Math.min(12, Number.isFinite(n) ? n : 1));
      };

      const removeLeftBtn = mkToolBtn('Remove ←', 'Shorten this cue by removing frames from its start (no ripple).', () => {
        removeFramesFromCue(idx, 'left', getRemoveFrames());
      });
      const removeRightBtn = mkToolBtn('Remove →', 'Shorten this cue by removing frames from its end (no ripple).', () => {
        removeFramesFromCue(idx, 'right', getRemoveFrames());
      });

      if (isScc) {
        // SCC layout (reference): Split buttons (left) then Steal and Remove groups (right).
        const timingInline = document.createElement('div');
        timingInline.className = 'cue-tools-scc-timing-inline';

        const splitInline = document.createElement('div');
        splitInline.className = 'cue-tool-inline-group cue-tool-inline-group-split';
        splitInline.appendChild(splitCursorBtn);
        splitInline.appendChild(splitPunctBtn);
        timingInline.appendChild(splitInline);

        const stealInline = document.createElement('div');
        stealInline.className = 'cue-tool-inline-group cue-tool-inline-group-steal';
        stealInline.appendChild(stealLeftBtn);
        stealInline.appendChild(stealSelWrap);
        stealInline.appendChild(stealRightBtn);

        const removeInline = document.createElement('div');
        removeInline.className = 'cue-tool-inline-group cue-tool-inline-group-remove';
        removeInline.appendChild(removeLeftBtn);
        removeInline.appendChild(removeSelWrap);
        removeInline.appendChild(removeRightBtn);

        timingInline.appendChild(stealInline);
        timingInline.appendChild(removeInline);
        tools.appendChild(timingInline);
      } else if (isMcc) {
        // MCC should visually match SCC: a single compact row in this exact order:
        // Split @ cursor, Split on punct, Steal ←, [2f], Steal →, Remove ←, [1f], Remove →
        tools.appendChild(splitCursorBtn);
        tools.appendChild(splitPunctBtn);

        tools.appendChild(stealLeftBtn);
        tools.appendChild(stealSelWrap);
        tools.appendChild(stealRightBtn);

        tools.appendChild(removeLeftBtn);
        tools.appendChild(removeSelWrap);
        tools.appendChild(removeRightBtn);
      } else {
        // 2×2 layout: dropdowns on top, action buttons centered beneath.
        const timingWrap = document.createElement('div');
        timingWrap.className = 'cue-tools cue-tools-web-timing cue-tools-broadcast-timing';

        const stealGroup = document.createElement('div');
        stealGroup.className = 'cue-tool-group cue-tool-group-steal';
        const stealActions = document.createElement('div');
        stealActions.className = 'cue-tool-actions';
        stealActions.appendChild(stealLeftBtn);
        stealActions.appendChild(stealRightBtn);
        stealGroup.appendChild(stealSelWrap);
        stealGroup.appendChild(stealActions);

        const removeGroup = document.createElement('div');
        removeGroup.className = 'cue-tool-group cue-tool-group-remove';
        const removeActions = document.createElement('div');
        removeActions.className = 'cue-tool-actions';
        removeActions.appendChild(removeLeftBtn);
        removeActions.appendChild(removeRightBtn);
        removeGroup.appendChild(removeSelWrap);
        removeGroup.appendChild(removeActions);

        timingWrap.appendChild(stealGroup);
        timingWrap.appendChild(removeGroup);
        tools.appendChild(timingWrap);
      }


      // 608-only fix actions (dual preview): these ONLY change the legacy projection track.
      if (wantsDualPreview(state.doc)) {
        const cols = Math.max(1, Math.min(32, Math.floor(Number(lim?.maxCols608) || 32)));
        const lines = Math.max(1, Math.min(2, Math.floor(Number(lim?.maxLines608) || 2)));

        const reflowBtn = mkToolBtn(
          'Reflow 608',
          `Reflow the 608 projection to fit ${cols} cols × ${lines} lines (keeps 708 untouched).`,
          () => {
            reflowCueFor608Only(idx, row);
          }
        );
        reflowBtn.classList.add('cue-tool-608only');
        reflowBtn.dataset.action = 'reflow608';
        reflowBtn.style.display = 'none';
        tools.appendChild(reflowBtn);

        const padBtn = mkToolBtn('Pad 608', 'Extend 608 timing into nearby gaps to satisfy min duration / CPS / WPM without changing 708.', () => {
          padCueTimingFor608Only(idx, row);
        });
        padBtn.classList.add('cue-tool-608only');
        padBtn.dataset.action = 'pad608';
        padBtn.style.display = 'none';
        tools.appendChild(padBtn);

        const splitBtn = mkToolBtn('Split 608', 'Split this cue in 608 only (keeps 708 untouched). Also attempts to pad if slack exists.', () => {
          splitCueFor608Only(idx, row);
        });
        splitBtn.classList.add('cue-tool-608only');
        splitBtn.dataset.action = 'split608';
        splitBtn.style.display = 'none';
        tools.appendChild(splitBtn);

        const mergeBtn = mkToolBtn('Merge 608 → next', 'Merge this cue with the next one in 608 only (mutes next in 608).', () => {
          mergeCue608WithNext(idx, row);
        });
        mergeBtn.classList.add('cue-tool-608only');
        mergeBtn.dataset.action = 'merge608';
        mergeBtn.style.display = 'none';
        tools.appendChild(mergeBtn);
      }

      if (isMcc) {
        // MCC layout ordering (match SCC):
        // timecode+text → tools row → style row → edit-mode row → (override editors) → QC row.
        // Override editors are appended earlier; insert the compact rows directly beneath the main cue.
        const ref = row.querySelector('.cue-override708, .cue-override608');
        if (ref) {
          row.insertBefore(tools, ref);
          if (styleWrapPending) row.insertBefore(styleWrapPending, ref);
          if (editModeWrapPending) row.insertBefore(editModeWrapPending, ref);
        } else {
          row.appendChild(tools);
          if (styleWrapPending) row.appendChild(styleWrapPending);
          if (editModeWrapPending) row.appendChild(editModeWrapPending);
        }
      } else {
        row.appendChild(tools);
      }


      // Priority 1: per-cue QC badges (CPS/WPM/min gap/min dur)
      const qcWrap = document.createElement('div');
      qcWrap.className = 'cue-qc';
      qcWrap.style.gridColumn = '1 / -1';
      if (isScc) {
        const b608 = document.createElement('span');
        b608.className = 'qc-badge';
        b608.dataset.track = '608';
        b608.textContent = tr('subtitleEditor.qc.badge608Ellipsis', '608 …');
        qcWrap.appendChild(b608);
      }
      else if (isMcc) {
        // MCC: show 708/608 track badges inline on the QC row (like SCC’s 608 placement).
        const b708 = document.createElement('span');
        b708.className = 'qc-badge';
        b708.dataset.track = '708';
        b708.textContent = tr('subtitleEditor.qc.badge708Ellipsis', '708 …');
        qcWrap.appendChild(b708);

        const b608 = document.createElement('span');
        b608.className = 'qc-badge';
        b608.dataset.track = '608';
        b608.textContent = tr('subtitleEditor.qc.badge608Ellipsis', '608 …');
        qcWrap.appendChild(b608);

        const dual = document.createElement('span');
        dual.className = 'qc-badge';
        dual.dataset.track = 'dual';
        dual.textContent = tr('subtitleEditor.qc.legacyUnsafe', 'Legacy-unsafe ⚠️');
        dual.style.display = 'none';
        qcWrap.appendChild(dual);
      }
      const mkBadge = (metric, label) => {
        const b = document.createElement('span');
        b.className = 'qc-badge ok';
        b.dataset.metric = metric;
        b.textContent = label;
        return b;
      };
      qcWrap.appendChild(mkBadge('cps', 'CPS —'));
      qcWrap.appendChild(mkBadge('wpm', 'WPM —'));
      qcWrap.appendChild(mkBadge('dur', 'Dur —'));
      qcWrap.appendChild(mkBadge('gap', 'Gap —'));
      row.appendChild(qcWrap);

      // 708/MCC style controls (active cue only):
      // - MCC: inserted above (under tools) to match SCC ordering.
      // - Other 708 docs: keep beneath QC.
      if (styleWrapPending && !isMcc) row.appendChild(styleWrapPending);

      cuesContainer.appendChild(row);
      try {
        for (const fn of postMountDropdowns) {
          try { fn(); } catch {}
        }
      } catch {}

    });
    highlightCue(state.activeCue);
    // We render only the active cue on top of video using custom 608 renderer.
    renderActiveCue608();

    // Fresh rows were created; decorate them immediately.
    try { scheduleQcRecompute(true); } catch {}
  }

  function renderCues(cues) {
    // Commit 5: web captions use a clean cue row (time + text only).
    if (state.mode === EditorMode.WEB || isWebCaptionDoc(state.doc)) return renderCuesWeb(cues);
    return renderCuesBroadcast(cues);
  }

  function updateCueTime(index, field, value) {
    if (!state.doc?.cues?.[index]) return;
    pushUndo('Edit cue time', `time:${index}:${field}`);
    const doc = state.doc;
    const cue = state.doc.cues[index];
    const numeric = parseSeconds(value, cue[field]);

    // In SMPTE/timecode docs (MCC/SCC), keep cue boundaries frame-aligned.
    if (usesSmpteTimecode(doc)) {
      const fps = Number(doc?.fps) || 29.97;
      const meta = _fpsMetaForFrameStep(fps);
      const offsetSec = _getDocTimecodeOffsetSeconds(doc);
      const frameSec = _secondsPerFrameFromMeta(meta);

      let sF = _frameIndexNearestFromSeconds(Math.max(0, (Number(cue.start) || 0) + offsetSec), meta);
      let eF = _frameIndexNearestFromSeconds(Math.max(0, (Number(cue.end) || 0) + offsetSec), meta);
      if (eF < sF + 1) eF = sF + 1;

      const desiredF = _frameIndexNearestFromSeconds(Math.max(0, numeric + offsetSec), meta);
      if (field === 'end') {
        eF = Math.max(desiredF, sF + 1);
      } else {
        sF = Math.max(0, Math.min(desiredF, eF - 1));
      }
      if (eF < sF + 1) eF = sF + 1;

      cue.start = Math.max(0, (sF * meta.den) / meta.num - offsetSec);
      cue.end = Math.max(cue.start + frameSec, (eF * meta.den) / meta.num - offsetSec);
    } else {
      // Generic time: millisecond-level edits.
      if (field === 'end') {
        cue.end = Math.max(numeric, cue.start + 0.01);
      } else {
        const currentEnd = cue.end;
        cue.start = Math.min(numeric, currentEnd - 0.01);
      }
    }
    markDirty();
    state.activeCue = index;
    renderCues(state.doc.cues);
    highlightCue(index);
  }

  function _setCueTextFromEditorValue(cue, text, doc) {
    if (!cue) return;
    const maxLines = _maxLinesForCueLines(doc);
    const splitRe = _shouldTreatPipeAsHardBreak(doc)
      ? /\r?\n|\s*\|\s*/g
      : /\r?\n/g;

    // Keep lines in sync with the editor text so the 608 overlay stays correct
    cue.text = String(text || '');
    cue.lines = String(text || '')
      .replace(/\\n/g, '\n')
      .split(splitRe)   // treat \n (and, for 608/MCC-like formats, |) as hard breaks
      .map(s => {
        const str = String(s || '');
        return isSccDoc(doc) ? str.replace(/\s+$/g, '') : str.trim();
      })
      .filter(Boolean)
      .slice(0, maxLines);

    // Phase B (cue-level styling): when a cue has runs[], treat plain-text edits as
    // rewriting the entire cue. This collapses multi-run styling for now, but preserves
    // cue-level styling state.
    if (Array.isArray(cue.runs) && cue.runs.length) {
      const first = cue.runs[0];
      const style = (first && typeof first === 'object' && first.style && typeof first.style === 'object')
        ? { ...first.style }
        : undefined;
      cue.runs = [{ text: String(text || ''), ...(style ? { style } : {}) }];
    }
  }

  function updateCueText(index, text, opts = {}) {
    if (!state.doc?.cues?.[index]) return;
    if (!opts?.skipUndo) {
      pushUndo('Edit cue text', `text:${index}:canonical`);
    }
    const cue = state.doc.cues[index];
    _setCueTextFromEditorValue(cue, text, state.doc);
    state.activeCue = index;
    markDirty();
    // Custom 608 overlay is the preview; update it immediately
    renderActiveCue608();

    // If this cue has a 608 override UI, keep its status/compare panel in sync as the
    // derived baseline changes.
    try { updateCompat608UiForCueRow(index); } catch {}
    try { updateOverride708UiForCueRow(index); } catch {}
    try { _updateActiveCueEditModeUi(); } catch {}
  }


  // ---- Styling controls (Phase B: "good enough" cue-level runs)
  const _SAFE_FG_708 = new Set(['white', 'yellow', 'cyan', 'green', 'magenta', 'red', 'blue']);

  // Cue-level styling UI helpers (per-cue controls, not toolbar-wide).
  function _toggleAriaPressed(btn) {
    if (!btn) return;
    const cur = String(btn.getAttribute('aria-pressed') || 'false') === 'true';
    btn.setAttribute('aria-pressed', cur ? 'false' : 'true');
  }

  function _getStyleControlsFromWrap(wrap) {
    if (!wrap) return null;

    const fgHidden = wrap.querySelector('input.cue-style-hidden.cue-style-fg');
    const bgHidden = wrap.querySelector('input.cue-style-hidden.cue-style-bg');

    const fgWrap = fgHidden?.closest?.('.dropdown-wrapper');
    const bgWrap = bgHidden?.closest?.('.dropdown-wrapper');

    return {
      italicBtn: wrap.querySelector('button.cue-style-italic'),
      underlineBtn: wrap.querySelector('button.cue-style-underline'),
      fgHidden,
      bgHidden,
      fgWrap,
      bgWrap,
      fgInput: fgWrap?.querySelector?.('.chosen-value'),
      bgInput: bgWrap?.querySelector?.('.chosen-value')
    };
  }

  function _cueTextFromRuns(runs) {
    return Array.isArray(runs)
      ? runs.map(r => String((r && typeof r === 'object') ? (r.text ?? '') : '')).join('')
      : '';
  }

  // Robust cue text extraction that works across:
  //  - legacy cues (cue.text / cue.lines)
  //  - V2-only payloads (cue.canonical.text / cue.canonical.lines)
  //  - styled cues (runs[] on either flattened or canonical)
  //
  // This is intentionally *format-agnostic* — callers can still choose to prefer
  // `lines[]` vs `text` depending on the editing mode, but preview should never
  // go blank just because the payload only populated canonical fields.
  function _cueTextFromCue(cue) {
    if (!cue || typeof cue !== 'object') return '';

    // 1) Flattened plain text (most common)
    if (typeof cue.text === 'string' && cue.text.length) return cue.text;

    // 2) Canonical plain text (V2 payloads)
    if (typeof cue.canonical?.text === 'string' && cue.canonical.text.length) return cue.canonical.text;

    // 3) Styled runs (flattened or canonical)
    const fromRuns = _cueTextFromRuns(cue.runs || cue.canonical?.runs);
    if (fromRuns) return fromRuns;

    // 4) Explicit line arrays (flattened or canonical)
    if (Array.isArray(cue.lines) && cue.lines.length) return cue.lines.join('\n');
    if (Array.isArray(cue.canonical?.lines) && cue.canonical.lines.length) return cue.canonical.lines.join('\n');

    return '';
  }

  function _cueTextForEditing(cue) {
    if (!cue) return '';
    const preferLines = is608Doc(state.doc);
    if (preferLines) {
      const l = (Array.isArray(cue.lines) && cue.lines.length)
        ? cue.lines
        : (Array.isArray(cue.canonical?.lines) && cue.canonical.lines.length)
          ? cue.canonical.lines
          : null;
      if (l && l.length) return l.join('\n');
    }

    return _cueTextFromCue(cue);
  }

  // SCC cue list display: show plain left-aligned text (no PAC/indent padding).
  // The preview pane is responsible for representing true 608 placement.
  function _cueTextForCueList(cue) {
    const raw = String(_cueTextForEditing(cue) || '').replace(/\r\n?/g, '\n');
    if (!isSccDoc(state.doc)) return raw;

    // SCC decoders often include leading spaces in each row string to represent
    // PAC/indent positioning. That padding is useful for strict round-trips, but
    // it makes the cue list editor look "centered" / indented in confusing ways.
    // Strip it for the cue list so editing is always left-aligned.
    return raw
      .split('\n')
      .map((ln) => String(ln || '').replace(/^\s+/, ''))
      .join('\n');
  }

  function _normalizeFg708(name) {
    const s = String(name || '').trim().toLowerCase();
    return _SAFE_FG_708.has(s) ? s : 'white';
  }

  function _normalizeBgMode(mode) {
    const m = String(mode || '').trim().toLowerCase();
    if (m === 'black75') return 'black75';
    if (m === 'black100') return 'black100';
    return 'none';
  }

  function _readStyleUiStateFromControls(styleWrap) {
    const c = _getStyleControlsFromWrap(styleWrap);
    const italic = String(c?.italicBtn?.getAttribute('aria-pressed') || 'false') === 'true';
    const underline = String(c?.underlineBtn?.getAttribute('aria-pressed') || 'false') === 'true';
    const fg = _normalizeFg708(c?.fgHidden?.value || 'white');
    const bgMode = _normalizeBgMode(c?.bgHidden?.value || 'none');

    // Canonical style model stored in runs[].style
    const style = { italic, underline, fg, fgOpacity: 0 };
    if (bgMode === 'none') {
      style.bg = 'black';
      style.bgOpacity = 3; // transparent
    } else if (bgMode === 'black75') {
      style.bg = 'black';
      style.bgOpacity = 2; // translucent
    } else {
      style.bg = 'black';
      style.bgOpacity = 0; // solid
    }
    return { style, bgMode };
  }

  function _extractCueCueLevelStyle(cue) {
    // Best-effort: for mixed-style cues, we reflect the first run's style.
    const first = (cue && Array.isArray(cue.runs) && cue.runs.length) ? cue.runs[0] : null;
    const s = (first && typeof first === 'object' && first.style && typeof first.style === 'object')
      ? first.style
      : null;

    const italic = !!(s && s.italic);
    const underline = !!(s && s.underline);
    const fg = _normalizeFg708(s && (s.fg ?? s.color ?? s.foreground));

    // Background dropdown is intentionally minimal.
    const bgOpacity = (s && typeof s.bgOpacity === 'number') ? s.bgOpacity : (s && typeof s.backgroundOpacity === 'number' ? s.backgroundOpacity : 3);
    let bgMode = 'none';
    if (bgOpacity === 0) bgMode = 'black100';
    else if (bgOpacity === 2) bgMode = 'black75';

    return { italic, underline, fg, bgMode };
  }

  function syncStyleControlsForActiveCue() {
    if (!cuesContainer) return;

    // Styling is only meaningful for 708 docs, and only applies to the active cue.
    const doc = state.doc;
    const idx = Number(state.activeCue);
    const cue = (doc && Array.isArray(doc.cues) && idx >= 0 && idx < doc.cues.length) ? doc.cues[idx] : null;

    // Hide all per-row style panels by default.
    const wraps = Array.from(cuesContainer.querySelectorAll('.cue-style-controls'));
    for (const w of wraps) {
      try { w.style.display = 'none'; } catch {}
    }

    if (!is708Doc(doc) || !cue) return;

    const activeRow = cuesContainer.querySelector(`.cue[data-index="${idx}"]`);
    const wrap = activeRow?.querySelector?.('.cue-style-controls');
    if (!wrap) return;

    // Only show controls on the active cue.
    wrap.style.display = '';

    const enabled = !!(_normalizeEditMode(state.activeEditMode) === 'canonical');
    const c = _getStyleControlsFromWrap(wrap);

    // Buttons + styled dropdown inputs must be disabled together.
    const controls = [c?.italicBtn, c?.underlineBtn, c?.fgInput, c?.bgInput].filter(Boolean);
    for (const el of controls) {
      try { el.disabled = !enabled; } catch {}
    }
    try { c?.fgHidden && (c.fgHidden.disabled = !enabled); } catch {}
    try { c?.bgHidden && (c.bgHidden.disabled = !enabled); } catch {}
    try { c?.fgWrap?.classList?.toggle?.('disabled', !enabled); } catch {}
    try { c?.bgWrap?.classList?.toggle?.('disabled', !enabled); } catch {}

    // Reflect the cue's style in the UI (even when disabled).
    const st = _extractCueCueLevelStyle(cue);
    c?.italicBtn?.setAttribute('aria-pressed', st.italic ? 'true' : 'false');
    c?.underlineBtn?.setAttribute('aria-pressed', st.underline ? 'true' : 'false');
    if (c?.fgHidden?.id) _setStyledDropdownValueSafe(c.fgHidden.id, st.fg);
    if (c?.bgHidden?.id) _setStyledDropdownValueSafe(c.bgHidden.id, st.bgMode);
  }

  function _applyCueLevelStyleFromControls(index, styleWrap) {
    if (!is708Doc(state.doc)) return;
    const idx = Number(index);
    const cue = state.doc?.cues?.[idx];
    if (!cue) return;

    const { style } = _readStyleUiStateFromControls(styleWrap);
    const txt = _cueTextForEditing(cue);

    pushUndo('Update cue style');
    cue.runs = [{ text: String(txt || ''), style }];
    // Keep cue.text/lines in sync (and trigger previews/dirty state).
    updateCueText(idx, txt, { skipUndo: true });
    try { syncStyleControlsForActiveCue(); } catch {}
  }

  function onCueClick(event) {
    const row = event.target.closest('.cue');
    if (!row) return;
    const idx = parseInt(row.dataset.index || '-1', 10);
    if (Number.isNaN(idx) || idx < 0) return;

    const cue = state.doc?.cues?.[idx];

    // P0-1: deterministic cue switching.
    // 1) mark pending seek
    // 2) seek primary
    // 3) sync secondary
    // 4) then highlight + render
    if (cue && videoEl && typeof videoEl.currentTime === 'number') {
      const targetTime = Number(cue.start) || 0;
      _setPendingSeek(targetTime);
      try { videoEl.currentTime = targetTime; } catch {}
      try { syncSecondaryTime(true); } catch {}
    }

    state.activeCue = idx;
    highlightCue(idx);
  }

  // ------------------------------------------------------------
  // Phase 4: Edit mode (canonical vs per-track overrides) + guardrails
  // ------------------------------------------------------------

  function _normalizeEditMode(mode) {
    const m = String(mode || '').trim();
    if (m === '608' || m === '708' || m === 'canonical') return m;
    return 'canonical';
  }

  function _defaultEditModeForCue(index) {
    const doc = state.doc;
    if (!doc || !is708Doc(doc)) return 'canonical';

    const t = (Array.isArray(state.qc.trackPerCue) ? state.qc.trackPerCue[index] : null);
    if (t && t.legacyUnsafe) return '608';
    return 'canonical';
  }

  function _getRememberedEditModeForCue(index) {
    const v = (state.editModeByCue && typeof state.editModeByCue === 'object')
      ? state.editModeByCue[index]
      : null;
    return _normalizeEditMode(v || '');
  }

  function setEditModeForCue(index, mode, persist = true) {
    const idx = Number(index);
    if (!Number.isFinite(idx) || idx < 0) return;

    const m = _normalizeEditMode(mode);
    state.activeEditMode = m;
    if (persist) {
      state.editModeByCue = state.editModeByCue && typeof state.editModeByCue === 'object' ? state.editModeByCue : {};
      state.editModeByCue[idx] = m;
    }

    // If the user changes edit mode on a non-active row (e.g., by clicking the toggle),
    // make that row active so the UI is consistent.
    if (state.activeCue !== idx) state.activeCue = idx;

    try { _applyEditModeUiForAllCueRows(); } catch {}
    try { syncStyleControlsForActiveCue(); } catch {}
    try { renderActiveCue608(); } catch {}

    // Focus the appropriate editor when possible.
    try {
      const row = cuesContainer?.querySelector(`.cue[data-index="${idx}"]`);
      if (row) {
        if (m === '608') {
          (row.querySelector('.cue-compat608 textarea.compat608-text') || row.querySelector('.cue-compat608 input.compat608-enabled'))?.focus?.();
        } else if (m === '708') {
          (row.querySelector('.cue-override708 textarea.override708-text') || row.querySelector('.cue-override708 input.override708-enabled'))?.focus?.();
        } else {
          row.querySelector('textarea.cue-text-canonical')?.focus?.();
        }
      }
    } catch {}
  }

  function _computeTextStats(text, durationSec) {
    const t = String(text || '').replace(/\r\n/g, '\n');
    const lines = t.split('\n').map(l => String(l || '').replace(/\s+$/g, ''));
    const cols = lines.reduce((m, l) => Math.max(m, Array.from(l).length), 0);

    const charsNoSpace = Array.from(t.replace(/\s+/g, '')).length;
    const cps = durationSec > 0 ? (charsNoSpace / durationSec) : 0;

    const words = t.trim().length ? t.trim().split(/\s+/).filter(Boolean).length : 0;
    const wpm = durationSec > 0 ? (words / (durationSec / 60)) : 0;

    return { cols, cps, wpm, charsNoSpace, words };
  }

  function _buildEditModeHint(cue, mode) {
    const has708TextOverride = !!(_getOverride708Text(cue) || '').trim();
    const has608TextOverride = !!(_getCompat608OverrideText(cue) || '').trim();

    if (mode === '708') {
      return has608TextOverride
        ? 'Editing 708 override: affects 708 text only. 608 text stays overridden separately.'
        : 'Editing 708 override: affects 708 text only. 608 stays projected from canonical.';
    }

    if (mode === '608') {
      return has708TextOverride
        ? 'Editing 608 override: affects 608 text only. 708 text stays overridden separately.'
        : 'Editing 608 override: affects 608 text only. 708 stays canonical.';
    }

    // canonical
    if (has708TextOverride && has608TextOverride) {
      return 'Editing canonical: updates the source text, but both 708 and 608 texts are currently overridden for this cue.';
    }
    if (has708TextOverride) {
      return 'Editing canonical: affects the 608 projection, but 708 text is currently overridden for this cue.';
    }
    if (has608TextOverride) {
      return 'Editing canonical: affects 708 text, but 608 text is currently overridden for this cue.';
    }
    return 'Editing canonical: affects 708 text and also feeds the 608 projection.';
  }

  function _buildEditModeStatsText(cue, doc, mode) {
    const cfg = _getQcConfigForDoc(doc);
    const lim = _getQcTrackLimitsForDoc(doc, cfg);

    const start = Number(cue?.start) || 0;
    const end = Number(cue?.end);
    const dur = (Number.isFinite(end) && end > start) ? (end - start) : 0;
    const durText = `${dur.toFixed(2)}s`;

    const t708 = (_getOverride708Text(cue) || _cueTextForEditing(cue) || '').toString();
    const derived608 = _buildDerived608CueForPreview(cue, doc, { ignoreOverride: false });
    const t608 = String(derived608?.text || '');

    const s708 = _computeTextStats(t708, dur);
    const s608 = _computeTextStats(t608, dur);

    const fmt = (n, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : '0.0');

    const fmtLimNum = (v, digits = 1) => {
      if (v === null) return '—';
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(digits) : '—';
    };

    const fmtLimInt = (v) => {
      if (v === null) return '—';
      const n = Number(v);
      return Number.isFinite(n) ? String(Math.trunc(n)) : '—';
    };

    const cols708Lim = lim.maxCols708;
    const cols608Lim = lim.maxCols608;

    const cps708Lim = cfg.maxCps708;
    const wpm708Lim = cfg.maxWpm708;

    const cps608Lim = cfg.maxCps608;
    const wpm608Lim = cfg.maxWpm608;

    if (mode === '708') {
      return `708: cols ${s708.cols}/${fmtLimInt(cols708Lim)}, cps ${fmt(s708.cps)}/${fmtLimNum(cps708Lim)}, wpm ${fmt(s708.wpm)}/${fmtLimNum(wpm708Lim)} · dur ${durText}`;
    }
    if (mode === '608') {
      return `608: cols ${s608.cols}/${fmtLimInt(cols608Lim)}, cps ${fmt(s608.cps)}/${fmtLimNum(cps608Lim)}, wpm ${fmt(s608.wpm)}/${fmtLimNum(wpm608Lim)} · dur ${durText}`;
    }
    return `708: cols ${s708.cols}/${fmtLimInt(cols708Lim)}, cps ${fmt(s708.cps)}/${fmtLimNum(cps708Lim)}, wpm ${fmt(s708.wpm)}/${fmtLimNum(wpm708Lim)}  |  608: cols ${s608.cols}/${fmtLimInt(cols608Lim)}, cps ${fmt(s608.cps)}/${fmtLimNum(cps608Lim)}, wpm ${fmt(s608.wpm)}/${fmtLimNum(wpm608Lim)}  · dur ${durText}`;
  }

  function _applyEditModeUiForCueRow(index, rowEl) {
    const doc = state.doc;
    if (!doc || !rowEl) return;
    const cue = doc?.cues?.[index];
    if (!cue) return;

    const isActive = Number(state.activeCue) === Number(index);
    const mode = isActive ? _normalizeEditMode(state.activeEditMode) : _getRememberedEditModeForCue(index);

    const editWrap = rowEl.querySelector('.cue-edit-mode');

    // Web captions (SRT/VTT) are plain text+time. Hide 708/608 override UI.
    if (isWebCaptionDoc(state.doc)) {
      if (editWrap) editWrap.style.display = 'none';
      const o708 = rowEl.querySelector('.cue-override708');
      if (o708) o708.style.display = 'none';
      const c608 = rowEl.querySelector('.cue-compat608');
      if (c608) c608.style.display = 'none';
      return;
    }
    if (editWrap) {
      editWrap.style.display = isActive ? '' : 'none';
      if (isActive) {
        const radios = editWrap.querySelectorAll('input[type="radio"]');
        radios.forEach(r => { try { r.checked = (String(r.value) === mode); } catch {} });

        const hint = editWrap.querySelector('.cue-edit-hint');
        if (hint) hint.textContent = _buildEditModeHint(cue, mode);

        const stats = editWrap.querySelector('.cue-edit-stats');
        if (stats) stats.textContent = _buildEditModeStatsText(cue, doc, mode);
      }
    }

    // Canonical editor: lock when not the active edit mode.
    const canonicalTa = rowEl.querySelector('textarea.cue-text-canonical');
    if (canonicalTa && isActive) {
      canonicalTa.readOnly = (mode !== 'canonical');
    }

    // 708 override editor visibility + lock.
    const ov708Wrap = rowEl.querySelector('.cue-override708');
    if (ov708Wrap) {
      // Show override controls whenever the cue is active so the user can
      // enable overrides even while in Canonical mode.
      const show = isActive;
      ov708Wrap.style.display = show ? '' : 'none';
      const ta = ov708Wrap.querySelector('textarea.override708-text');
      if (ta && show) ta.readOnly = (mode !== '708');
    }

    // 608 override editor visibility + lock.
    const compatWrap = rowEl.querySelector('.cue-compat608');
    if (compatWrap) {
      // Show override controls whenever the cue is active so the user can
      // enable overrides even while in Canonical mode.
      const show = isActive;
      compatWrap.style.display = show ? '' : 'none';
      const ta = compatWrap.querySelector('textarea.compat608-text');
      if (ta && show) ta.readOnly = (mode !== '608');
    }

    // Keep row-level override warning classes up-to-date.
    try { updateCompat608UiForCueRow(index, rowEl); } catch {}
    try { updateOverride708UiForCueRow(index, rowEl); } catch {}
  }

  function _applyEditModeUiForAllCueRows() {
    if (!cuesContainer) return;
    const rows = Array.from(cuesContainer.querySelectorAll('.cue'));
    for (const row of rows) {
      const idx = parseInt(row.dataset.index || '-1', 10);
      if (!Number.isInteger(idx) || idx < 0) continue;
      _applyEditModeUiForCueRow(idx, row);
    }
  }


  // Keep the active cue’s edit-mode hint/stats in sync while typing.
  // (renderCues() is expensive; this updates only the active row.)
  function _updateActiveCueEditModeUi() {
    const idx = Number(state.activeCue);
    if (!Number.isInteger(idx) || idx < 0) return;
    if (!cuesContainer) return;
    const row = cuesContainer.querySelector(`.cue[data-index="${idx}"]`);
    if (!row) return;
    _applyEditModeUiForCueRow(idx, row);
  }

  function highlightCue(index) {
    if (!cuesContainer) return;
    Array.from(cuesContainer.children).forEach((child, idx) => {
      child.classList.toggle('active', idx === index);
    });

    // Phase 4: determine default edit mode based on cue-level dual track status
    // (broadcast-safe but legacy-unsafe -> default to editing 608 override).
    if (Number.isInteger(index) && index >= 0) {
      const remembered = _getRememberedEditModeForCue(index);
      const fallback = _defaultEditModeForCue(index);
      state.activeEditMode = _normalizeEditMode(remembered || fallback);
    } else {
      state.activeEditMode = 'canonical';
    }

    try { _applyEditModeUiForAllCueRows(); } catch {}
    if (Number.isInteger(index) && index >= 0) {
      try { updateCompat608UiForCueRow(index); } catch {}
      try { updateOverride708UiForCueRow(index); } catch {}
    }
    try { syncStyleControlsForActiveCue(); } catch {}
    renderActiveCue608();
  }

  function highlightCueForTime(timeSec, opts = {}) {
    const cues = state.doc?.cues;
    if (!Array.isArray(cues) || !cues.length) return;

    const t = Number(timeSec) || 0;
    const force = !!opts.force;
    const allowScroll = (opts.scroll !== false);

    // P0-1: While a cue-click/QC jump seek is pending, suppress time-follow updates
    // until the playhead is close to the intended time (or we time out).
    if (_hasPendingSeek() && !_maybeClearPendingSeek(t)) {
      return;
    }

    let idx = -1;

    if (isWebCaptionDoc(state.doc)) {
      // For SRT/VTT, only treat cues as active inside their [start,end) window.
      idx = findCueIndexAtTime(cues, t);
    } else {
      // Legacy behavior for broadcast/editor modes: last cue with start <= t
      let lo = 0;
      let hi = cues.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = Number(cues[mid].start) || 0;
        if (s <= t + 0.0005) { idx = mid; lo = mid + 1; }
        else { hi = mid - 1; }
      }
    }

    // If no cue is active (e.g. t < first start, or in a gap), clear selection for web captions.
    if (idx === -1) {
      if (force || state.activeCue !== -1) {
        state.activeCue = -1;
        highlightCue(-1);
      }
      return;
    }

    if (force || idx !== state.activeCue) {
      state.activeCue = idx;
      highlightCue(idx);
      if (allowScroll) {
        const target = cuesContainer?.children?.[idx];
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  }

  // ---- Priority 2: one-click fix helpers (human stays in charge) -----------

  function _qcMinEdgeSeconds(doc) {
    // Keep splits away from cue edges so we don't create tiny "flash" cues by accident.
    // In SMPTE modes, use ~2 frames; otherwise fall back to ~50ms.
    return usesSmpteTimecode(doc) ? (2 * _frameStepSecondsForDoc(doc)) : 0.05;
  }

  function _splitTextAtIndex(text, idx) {
    const s = String(text ?? '');
    const i = Math.max(0, Math.min(s.length, Math.trunc(Number(idx) || 0)));
    const leftRaw = s.slice(0, i);
    const rightRaw = s.slice(i);

    const left = leftRaw.replace(/\s+$/g, '');
    const right = rightRaw.replace(/^\s+/g, '');

    return { left, right };
  }

  function _findNearestWhitespaceSplitIndex(text, targetIdx) {
    const s = String(text ?? '');
    if (!s) return 0;
    const t = Math.max(0, Math.min(s.length, Math.trunc(Number(targetIdx) || 0)));

    // Scan outward from target index looking for a whitespace boundary.
    for (let d = 0; d < s.length; d++) {
      const left = t - d;
      const right = t + d;

      if (left > 0 && /\s/.test(s[left - 1]) && /\S/.test(s[left] || '')) return left;
      if (right > 0 && right < s.length && /\s/.test(s[right - 1]) && /\S/.test(s[right] || '')) return right;
    }
    return t;
  }

  function _pickPunctuationSplitIndex(text) {
    const s = String(text ?? '');
    if (!s) return null;

    const candidates = [];
    const addMatches = (re, weightBase) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s)) !== null) {
        const pos = m.index + m[0].length;
        candidates.push({ pos, weightBase });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    };

    // Sentence-ish boundaries
    addMatches(/[.!?]+["')\]]*\s+/g, 0);
    // Clause-ish boundaries
    addMatches(/[,;:]+["')\]]*\s+/g, 6);

    if (!candidates.length) return null;

    const tokens = (str) => str.trim().split(/\s+/g).filter(Boolean);

    const mid = s.length / 2;
    let best = null;

    for (const c of candidates) {
      const { left, right } = _splitTextAtIndex(s, c.pos);
      const L = left.trim();
      const R = right.trim();
      if (!L || !R) continue;

      const lw = tokens(L);
      const rw = tokens(R);
      if (!lw.length || !rw.length) continue;

      const lastChar = L.slice(-1);
      const lastTok = (lw[lw.length - 1] || '').toLowerCase().replace(/[^a-z']/g, '');
      const hangers = new Set(['a','an','the','of','to','and','or','but','for','in','on','at','with','from','as','by']);

      let score = 0;

      // Prefer balanced halves
      score += Math.abs(lw.length - rw.length) * 3;
      score += Math.abs(c.pos - mid) / Math.max(1, s.length) * 10;

      // Penalize awkward 2nd lines
      if (rw.length === 1) score += 25;

      // Penalize hanger endings
      if (hangers.has(lastTok)) score += 18;

      // Punctuation preference: end-of-sentence beats comma.
      if (/[.!?]/.test(lastChar)) score -= 6;
      else if (/[,;:]/.test(lastChar)) score -= 2;

      score += c.weightBase;

      if (!best || score < best.score) best = { score, pos: c.pos };
    }

    return best ? best.pos : null;
  }

  function _pickSplitTimeForCue(cue, ratio = null) {
    if (!cue) return null;

    const start = Number(cue.start) || 0;
    const end = Number(cue.end) || 0;
    if (!(end > start)) return null;

    const edge = _qcMinEdgeSeconds(state.doc);

    // 1) Prefer playhead if it's inside the cue
    const playhead = (typeof videoEl?.currentTime === 'number') ? (Number(videoEl.currentTime) || 0) : NaN;
    if (Number.isFinite(playhead) && playhead > start + edge && playhead < end - edge) return playhead;

    // 2) If we have a text cursor ratio, map it across cue time
    if (Number.isFinite(ratio)) {
      const r = Math.max(0, Math.min(1, Number(ratio)));
      const t = start + (end - start) * r;
      if (t > start + edge && t < end - edge) return t;
    }

    // 3) Default: midpoint
    const mid = (start + end) / 2;
    return Math.min(end - edge, Math.max(start + edge, mid));
  }

  function _splitCueWithText(index, timeSec, splitIndex = null) {
    const cue = state.doc?.cues?.[index];
    if (!cue) return false;

    const start = Number(cue.start) || 0;
    const end = Number(cue.end) || 0;
    if (!(end > start)) return false;

    const edge = _qcMinEdgeSeconds(state.doc);
    let t = Number(timeSec);
    if (!Number.isFinite(t)) t = (start + end) / 2;
    if (t <= start + edge || t >= end - edge) {
      // Clamp rather than bail; if it's still too close, give up.
      t = Math.min(end - edge, Math.max(start + edge, t));
      if (t <= start + edge || t >= end - edge) return false;
    }

    // In SMPTE modes (MCC/SCC), keep newly-created cue edges frame-perfect.
    // Even if the UI displays frames (FF), the underlying media time can land between frames.
    if (usesSmpteTimecode(state.doc)) {
      const doc = state.doc;
      const fps = Number(doc?.fps) || 29.97;
      const meta = _fpsMetaForFrameStep(fps);
      const offsetSec = _getDocTimecodeOffsetSeconds(doc);
      const frameSec = _secondsPerFrameFromMeta(meta);
      const edgeFrames = Math.max(0, Math.ceil(edge / Math.max(1e-9, frameSec)));

      const startDisp = Math.max(0, start + offsetSec);
      const endDisp = Math.max(0, end + offsetSec);
      const tDisp = Math.max(0, t + offsetSec);

      const startF = _frameIndexNearestFromSeconds(startDisp, meta);
      const endF = _frameIndexNearestFromSeconds(endDisp, meta);
      const minSplitF = startF + edgeFrames + 1;
      const maxSplitF = endF - edgeFrames - 1;
      if (maxSplitF < minSplitF) return false;

      const tF = _frameIndexNearestFromSeconds(tDisp, meta);
      const splitF = Math.max(minSplitF, Math.min(maxSplitF, tF));

      const disp = (splitF * meta.den) / meta.num;
      t = Math.max(0, disp - offsetSec);

      // Safety: if quantization pushed us out of range due to rounding, refuse.
      if (t <= start + edge || t >= end - edge) return false;
    }

    const fullText = _cueTextForEditing(cue);
    const idxSafe = (splitIndex == null)
      ? null
      : Math.max(0, Math.min(String(fullText ?? '').length, Math.trunc(Number(splitIndex) || 0)));

    let leftText = '';
    let rightText = '';

    if (idxSafe != null) {
      const parts = _splitTextAtIndex(fullText, idxSafe);
      leftText = parts.left;
      rightText = parts.right;
    } else {
      // No explicit index → split around punctuation near the middle, else nearest whitespace.
      const punct = _pickPunctuationSplitIndex(fullText);
      const midIdx = Math.floor(String(fullText ?? '').length / 2);
      const wsIdx = _findNearestWhitespaceSplitIndex(fullText, punct ?? midIdx);
      const parts = _splitTextAtIndex(fullText, wsIdx);
      leftText = parts.left;
      rightText = parts.right;
    }

    if (!String(leftText || '').trim() || !String(rightText || '').trim()) return false;

    const firstCue = { ...cue, end: t };
    const secondCue = { ...cue, start: t };

    _setCueTextFromEditorValue(firstCue, leftText, state.doc);
    _setCueTextFromEditorValue(secondCue, rightText, state.doc);

    // Best-effort: split 608 override text too (when present).
    const override = _getCompat608OverrideText(cue);
    if (String(override || '').trim()) {
      const ovIdx = (idxSafe != null)
        ? Math.max(0, Math.min(String(override).length, idxSafe))
        : Math.floor(String(override).length / 2);
      const ovParts = _splitTextAtIndex(String(override), ovIdx);
      if (String(ovParts.left || '').trim() && String(ovParts.right || '').trim()) {
        _setCompat608OverrideText(firstCue, ovParts.left, { skipUndo: true });
        _setCompat608OverrideText(secondCue, ovParts.right, { skipUndo: true });
      } else {
        _clearCompat608Override(firstCue, { skipUndo: true });
        _clearCompat608Override(secondCue, { skipUndo: true });
      }
    } else {
      _clearCompat608Override(firstCue, { skipUndo: true });
      _clearCompat608Override(secondCue, { skipUndo: true });
    }

    // Keep IDs stable when possible, but avoid duplicates.
    if (cue.id != null) {
      const baseId = String(cue.id);
      const suffix = baseId.endsWith('-b') ? '-b2' : '-b';
      secondCue.id = `${baseId}${suffix}`;
    }

    state.doc.cues.splice(index, 1, firstCue, secondCue);
    markDirty();
    state.activeCue = index + 1;
    renderCues(state.doc.cues);
    highlightCue(index + 1);
    return true;
  }

  function splitCueAtCursor(index, textArea) {
    const cue = state.doc?.cues?.[index];
    if (!cue) return;
    pushUndo('Split cue');

    const text = String(textArea?.value ?? _cueTextForEditing(cue));
    const caret = Number(textArea?.selectionStart);
    const splitIndex = Number.isFinite(caret) ? caret : Math.floor(text.length / 2);
    const ratio = text.length ? (splitIndex / text.length) : null;

    const t = _pickSplitTimeForCue(cue, ratio);
    _splitCueWithText(index, t, splitIndex);
  }

  function splitCueOnPunctuation(index) {
    const cue = state.doc?.cues?.[index];
    if (!cue) return;
    pushUndo('Split cue');

    const text = _cueTextForEditing(cue);
    const splitIndex = _pickPunctuationSplitIndex(text) ?? _findNearestWhitespaceSplitIndex(text, Math.floor(String(text ?? '').length / 2));
    const ratio = String(text ?? '').length ? (splitIndex / String(text ?? '').length) : null;

    const t = _pickSplitTimeForCue(cue, ratio);
    _splitCueWithText(index, t, splitIndex);
  }

  // Existing action (Enter / Insert button): split at the playhead time (if possible),
  // but pick a good text breakpoint automatically.
  function splitCue(index, timeSec) {
    const cue = state.doc?.cues?.[index];
    if (!cue) return;
    pushUndo('Split cue');

    const text = _cueTextForEditing(cue);
    const splitIndex = _pickPunctuationSplitIndex(text) ?? null;

    const ok = _splitCueWithText(index, timeSec, splitIndex);
    if (!ok) {
      // If the playhead is outside the cue, fall back to a safe midpoint split.
      const t = _pickSplitTimeForCue(cue, null);
      _splitCueWithText(index, t, splitIndex);
    }
  }

  function mergeCue(index) {
    if (!Array.isArray(state.doc?.cues)) return;
    const cue = state.doc.cues[index];
    const next = state.doc.cues[index + 1];
    if (!cue || !next) return;
    pushUndo('Merge cue');

    const merged = { ...cue };
    merged.end = Math.max(Number(cue.end) || 0, Number(next.end) || 0);

    const aText = String(_cueTextForEditing(cue) || '').trim();
    const bText = String(_cueTextForEditing(next) || '').trim();
    const mergedText = [aText, bText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    _setCueTextFromEditorValue(merged, mergedText, state.doc);

    // Merge 608 overrides when present.
    const aOv = String(_getCompat608OverrideText(cue) || '').trim();
    const bOv = String(_getCompat608OverrideText(next) || '').trim();
    if (aOv || bOv) {
      const mergedOv = [aOv, bOv].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (mergedOv) _setCompat608OverrideText(merged, mergedOv, { skipUndo: true });
      else _clearCompat608Override(merged, { skipUndo: true });
    } else {
      _clearCompat608Override(merged, { skipUndo: true });
    }

    state.doc.cues.splice(index, 2, merged);
    markDirty();
    state.activeCue = index;
    renderCues(state.doc.cues);
    highlightCue(index);
  }

  

  // ---------- Phase 5 (milestone 3): 608-safe actions that DO NOT change 708 ----------
  // These helpers intentionally write only into cue.overrides['608'].

  // Normalize the per-doc QC config into the fields the “608-only” helpers expect.
  // (Phase 2 introduced independent QC profiles; the fix actions must honor the 608 profile.)
  function _qcCfgFor608Actions(cfg) {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};

    const pick = (a, b) => (a != null ? a : b);
    const out = {
      maxCps: pick(c.maxCps608, c.maxCps),
      maxWpm: pick(c.maxWpm608, c.maxWpm),
      minDurationSec: pick(c.minDurationSec608, c.minDurationSec),
      maxDurationSec: pick(c.maxDurationSec608, c.maxDurationSec),
      minGapSec: pick(c.minGapSec608, c.minGapSec)
    };

    return out;
  }

  function _normalizeTextForQcMetrics(text) {
    return String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function _metricsForQcText(text) {
    const flat = _normalizeTextForQcMetrics(text);
    const charNoSpace = flat.replace(/\s+/g, '').length;
    const wordCount = flat ? flat.split(/\s+/g).filter(Boolean).length : 0;
    return { flat, charNoSpace, wordCount };
  }

  function _requiredDurationForQcText(text, cfg) {
    const { charNoSpace, wordCount } = _metricsForQcText(text);
    const minDurationSec = Math.max(0, Number(cfg?.minDurationSec) || 0);

    let need = minDurationSec;

    const maxCps = Number(cfg?.maxCps);
    if (Number.isFinite(maxCps) && maxCps > 0) need = Math.max(need, charNoSpace / maxCps);

    const maxWpm = Number(cfg?.maxWpm);
    if (Number.isFinite(maxWpm) && maxWpm > 0) need = Math.max(need, (wordCount * 60) / maxWpm);

    return need;
  }

  function _requiredTotalDurationFor608Parts(parts, cfg) {
    const list = Array.isArray(parts) ? parts.filter(Boolean) : [];
    if (!list.length) return 0;

    const minGapSec = Math.max(0, Number(cfg?.minGapSec) || 0);

    let total = 0;
    for (const p of list) total += _requiredDurationForQcText(p, cfg);
    if (list.length > 1) total += minGapSec * (list.length - 1);
    return total;
  }

  function _effective608PartsForActions(cue, doc) {
    if (!cue) return [];
    if (_isCompat608Muted(cue)) return [];

    const parts = _extractCompat608OverridePartsTextList(cue);
    if (parts && parts.length) return parts;

    const ov = String(_getCompat608OverrideText(cue) || '').trim();
    if (ov) return [ov];

    // Prefer the projected 608 text (ignoring overrides), since that's what QC uses.
    try {
      const d = _buildDerived608CueForPreview(cue, doc, { ignoreOverride: true });
      const dt = String(d?.text || '').trim();
      if (dt) return [dt];
    } catch {}

    const base = String(_cueTextForEditing(cue) || cue.text || '').trim();
    return base ? [base] : [];
  }

  function _effective608WindowSec(cue, doc) {
    let start = Number(cue?.start) || 0;
    let end = Number(cue?.end) || 0;

    const o = cue?.overrides;
    const o608 = (o && typeof o === 'object') ? o['608'] : null;
    if (o608 && typeof o608 === 'object') {
      if (o608.start != null) {
        const s = parseSecondsSmpte(o608.start, doc, start);
        if (Number.isFinite(s)) start = s;
      }
      if (o608.end != null) {
        const e = parseSecondsSmpte(o608.end, doc, end);
        if (Number.isFinite(e)) end = e;
      }
    }

    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = start;
    if (end < start) end = start;

    return { start, end };
  }

  function _pickWhitespaceSplitIndexNearMiddle(text) {
    const s = String(text || '');
    if (!s) return null;
    const mid = Math.floor(s.length / 2);
    const matches = [...s.matchAll(/\s+/g)];
    if (!matches.length) return null;

    let best = null;
    let bestDist = Infinity;
    for (const m of matches) {
      const idx = Number(m.index) || 0;
      const dist = Math.abs(idx - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = idx + String(m[0] || '').length;
      }
    }
    return Number.isFinite(best) ? best : null;
  }

  function _splitTextToFit608Parts(text, lim, maxParts = 4) {
    const cols = Math.max(1, Math.min(32, Math.floor(Number(lim?.maxCols608) || 32)));
    const lines = Math.max(1, Math.min(2, Math.floor(Number(lim?.maxLines608) || 2)));

    const wrapWithMeta = (t) => {
      try {
        return window.transcribeEngine?.wrap608WithMeta
          ? window.transcribeEngine.wrap608WithMeta(String(t || ''), cols, lines, { allowExplicitLineBreaks: true })
          : null;
      } catch { return null; }
    };

    const needsSplit = (t) => {
      const meta = wrapWithMeta(t);
      return !!(meta && (meta.overflowed || meta.truncated));
    };

    let parts = [_normalizeTextForQcMetrics(text)].filter(Boolean);
    if (!parts.length) return [];

    // Greedy split: keep splitting the first overflowed part until everything fits or we hit maxParts.
    while (parts.length < maxParts) {
      const idxFail = parts.findIndex(p => needsSplit(p));
      if (idxFail < 0) break;

      const target = parts[idxFail];
      let splitIdx = _pickPunctuationSplitIndex(target);
      if (splitIdx == null) splitIdx = _pickWhitespaceSplitIndexNearMiddle(target);
      if (splitIdx == null) break;

      const { left, right } = _splitTextAtIndex(target, splitIdx);
      const a = String(left || '').trim();
      const b = String(right || '').trim();
      if (!a || !b) break;

      parts.splice(idxFail, 1, a, b);
    }

    return parts.map(p => String(p || '').trim()).filter(Boolean);
  }

  function padCueTimingFor608Only(index, rowEl = null, opts = null) {
    const doc = state.doc;
    if (!doc || !wantsDualPreview(doc)) return { changed: false, fullySatisfied: false };

    const cues = doc?.cues;
    const cue = cues?.[index];
    if (!cue) return { changed: false, fullySatisfied: false };
    if (_isCompat608Muted(cue)) return { changed: false, fullySatisfied: false };

    const qcCfg = _getQcConfigForDoc(doc);
    const cfg608 = _qcCfgFor608Actions(qcCfg);

    const parts = _effective608PartsForActions(cue, doc);
    if (!parts.length) return { changed: false, fullySatisfied: false };

    let required = _requiredTotalDurationFor608Parts(parts, cfg608);
    const maxDurationSec = Number(cfg608?.maxDurationSec);
    if (Number.isFinite(maxDurationSec) && maxDurationSec > 0) required = Math.min(required, maxDurationSec);

    const curWin = _effective608WindowSec(cue, doc);
    const curDur = Math.max(0, curWin.end - curWin.start);

    if (!(required > curDur + 1e-6)) return { changed: false, fullySatisfied: true };
    if (!opts?.skipUndo) pushUndo('Pad 608 timing');

    const minGap = Math.max(0, Number(cfg608?.minGapSec) || 0);

    // Slack is based on canonical neighbors (we avoid pushing 608 timing across actual spoken cue boundaries).
    const prevEnd = (index > 0) ? Number(cues?.[index - 1]?.end) : NaN;
    const nextStart = (index + 1 < (cues?.length || 0)) ? Number(cues?.[index + 1]?.start) : NaN;

    const slackBefore = Number.isFinite(prevEnd) ? Math.max(0, curWin.start - prevEnd - minGap) : Math.max(0, curWin.start - minGap);
    const slackAfter = Number.isFinite(nextStart) ? Math.max(0, nextStart - curWin.end - minGap) : 0;

    let newStart = curWin.start;
    let newEnd = curWin.end;
    let remaining = required - curDur;

    // Prefer padding into the following gap (more consistent with broadcast timing).
    const takeAfter = Math.min(remaining, slackAfter);
    newEnd += takeAfter;
    remaining -= takeAfter;

    const takeBefore = Math.min(remaining, slackBefore);
    newStart -= takeBefore;
    remaining -= takeBefore;

    if (newStart < 0) newStart = 0;
    if (newEnd < newStart) newEnd = newStart;

    // In SMPTE modes (MCC/SCC), make sure any newly-written 608 timing overrides land
    // exactly on frame boundaries. Otherwise you get “frame-looking” timecodes that
    // were actually derived from millisecond math.
    if (usesSmpteTimecode(doc)) {
      const willChangeEnd = takeAfter > 1e-9;
      const willChangeStart = takeBefore > 1e-9;

      // Allowed bounds (mirrors slack calculations above).
      const minStartAllowed = Number.isFinite(prevEnd)
        ? Math.max(0, prevEnd + minGap)
        : Math.max(0, minGap);
      const maxEndAllowed = Number.isFinite(nextStart)
        ? Math.max(0, nextStart - minGap)
        : NaN;

      if (willChangeStart) {
        const minQ = _quantizeSecondsToSmpteFrame(minStartAllowed, doc, 'ceil');
        const maxQ = _quantizeSecondsToSmpteFrame(curWin.start, doc, 'floor');
        if (Number.isFinite(minQ) && Number.isFinite(maxQ) && maxQ >= minQ - 1e-9) {
          let q = _quantizeSecondsToSmpteFrame(newStart, doc, 'nearest');
          if (q < minQ) q = minQ;
          if (q > maxQ) q = maxQ;
          newStart = q;
        } else {
          // No legal frame boundary exists inside the allowed window — refuse to shift start.
          newStart = curWin.start;
        }
      }

      if (willChangeEnd && Number.isFinite(maxEndAllowed)) {
        const minQ = _quantizeSecondsToSmpteFrame(curWin.end, doc, 'ceil');
        const maxQ = _quantizeSecondsToSmpteFrame(maxEndAllowed, doc, 'floor');
        if (Number.isFinite(minQ) && Number.isFinite(maxQ) && maxQ >= minQ - 1e-9) {
          let q = _quantizeSecondsToSmpteFrame(newEnd, doc, 'nearest');
          if (q < minQ) q = minQ;
          if (q > maxQ) q = maxQ;
          newEnd = q;
        } else {
          // No legal frame boundary exists inside the allowed window — refuse to shift end.
          newEnd = curWin.end;
        }
      }

      if (newEnd < newStart) newEnd = newStart;
    }

    const fps = Number(doc?.fps) || 29.97;
    const tol = (Number.isFinite(fps) && fps > 0) ? (0.5 / fps) : 0.02;

    const changedStart = Math.abs(newStart - curWin.start) >= tol;
    const changedEnd = Math.abs(newEnd - curWin.end) >= tol;
    if (!changedStart && !changedEnd) return { changed: false, fullySatisfied: remaining <= tol };

    // Apply timing overrides without touching text/parts.
    if (!cue.overrides || typeof cue.overrides !== 'object') cue.overrides = {};
    if (!cue.overrides['608'] || typeof cue.overrides['608'] !== 'object') cue.overrides['608'] = {};
    const o608 = cue.overrides['608'];

    if (changedStart) o608.start = formatSecondsSmpte(newStart, doc);
    if (changedEnd) o608.end = formatSecondsSmpte(newEnd, doc);

    try {
      o608._baseCanonicalTextFp = _fingerprintText(_cueTextForEditing(cue));
    } catch {
      o608._baseCanonicalTextFp = null;
    }
    o608.overridePossiblyStale = false;

    const mark = !(opts && opts.mark === false);

    if (mark) {
      state.activeCue = index;
      markDirty();
      try { updateCompat608UiForCueRow(index, rowEl); } catch {}
      try { renderActiveCue608(); } catch {}
      setStatus(remaining <= tol ? tr('subtitleEditor.status.padded608Timing', 'Padded 608 timing') : tr('subtitleEditor.status.padded608TimingLimited', 'Padded 608 timing (limited by nearby gaps)'));
    }

    return { changed: true, fullySatisfied: remaining <= tol };
  }

  function splitCueFor608Only(index, rowEl = null) {
    const doc = state.doc;
    if (!doc || !wantsDualPreview(doc)) return;
    const cue = doc?.cues?.[index];
    if (!cue) return;
    if (_isCompat608Muted(cue)) return;
    pushUndo('Split 608 override');

    const cfg = _getQcConfigForDoc(doc);
    const lim = _getQcTrackLimitsForDoc(doc, cfg);

    // Base text: prefer the current 608 output, then projected 608, then canonical.
    let base = '';
    const existingParts = _extractCompat608OverridePartsTextList(cue);
    if (existingParts && existingParts.length) base = existingParts.join(' ');
    else base = String(_getCompat608OverrideText(cue) || '').trim();

    if (!base) {
      try {
        const d = _buildDerived608CueForPreview(cue, doc, { ignoreOverride: true });
        base = String(d?.text || '').trim();
      } catch {}
    }
    if (!base) base = String(_cueTextForEditing(cue) || cue.text || '').trim();

    base = _normalizeTextForQcMetrics(base);
    if (!base) return;

    // Split into at most 2 parts by default; if either part still doesn't fit 608, we allow more (up to 4).
    let parts = _splitTextToFit608Parts(base, lim, 2);
    if (parts.length < 2) parts = _splitTextToFit608Parts(base, lim, 4);
    if (parts.length < 2) return;

    _setCompat608OverrideParts(cue, parts, { skipUndo: true });

    // After splitting, attempt to pad into nearby gaps to meet CPS/WPM/minDuration (when possible).
    padCueTimingFor608Only(index, rowEl, { mark: false, skipUndo: true });

    state.activeCue = index;
    markDirty();
    try { updateCompat608UiForCueRow(index, rowEl); } catch {}
    try { renderActiveCue608(); } catch {}
    setStatus(tr('subtitleEditor.status.splitCue608Only', 'Split cue for 608 only'));
  }

  function mergeCue608WithNext(index, rowEl = null) {
    const doc = state.doc;
    if (!doc || !wantsDualPreview(doc)) return;
    const cues = doc?.cues;
    const cue = cues?.[index];
    const next = cues?.[index + 1];
    if (!cue || !next) return;
    pushUndo('Merge 608 overrides');

    const cfg = _getQcConfigForDoc(doc);
    const lim = _getQcTrackLimitsForDoc(doc, cfg);

    const aParts = _effective608PartsForActions(cue, doc);
    const bParts = _effective608PartsForActions(next, doc);

    const aText = _normalizeTextForQcMetrics(aParts.join(' '));
    const bText = _normalizeTextForQcMetrics(bParts.join(' '));

    const combined = [aText, bText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!combined) return;

    const cols = Math.max(1, Math.min(32, Math.floor(Number(lim?.maxCols608) || 32)));
    const lines = Math.max(1, Math.min(2, Math.floor(Number(lim?.maxLines608) || 2)));

    let mergedAsSingle = false;
    try {
      const meta = window.transcribeEngine?.wrap608WithMeta
        ? window.transcribeEngine.wrap608WithMeta(combined, cols, lines, { allowExplicitLineBreaks: true })
        : null;

      if (meta && !meta.overflowed && !meta.truncated) {
        _setCompat608OverrideBreaks(cue, meta.lines, { skipUndo: true });
        mergedAsSingle = true;
      }
    } catch { mergedAsSingle = false; }

    if (!mergedAsSingle) {
      // Fallback: keep them as sequential 608-only parts inside the merged window.
      let parts = [...aParts, ...bParts].map(t => _normalizeTextForQcMetrics(t)).filter(Boolean);

      // Clamp to something sane; the 608 encoder supports more, but UI/UX gets weird fast.
      const maxParts = 4;
      if (parts.length > maxParts) {
        const head = parts.slice(0, maxParts - 1);
        const tail = parts.slice(maxParts - 1).join(' ').replace(/\s+/g, ' ').trim();
        parts = [...head, tail].filter(Boolean);
      }

      _setCompat608OverrideParts(cue, parts, { skipUndo: true });
    }

    // Extend the 608 window to cover the next cue’s time range.
    if (!cue.overrides || typeof cue.overrides !== 'object') cue.overrides = {};
    if (!cue.overrides['608'] || typeof cue.overrides['608'] !== 'object') cue.overrides['608'] = {};
    const o608 = cue.overrides['608'];
    const nextEnd = Number(next.end);
    if (Number.isFinite(nextEnd)) {
      const endSec = usesSmpteTimecode(doc)
        ? _quantizeSecondsToSmpteFrame(nextEnd, doc, 'nearest')
        : nextEnd;
      o608.end = formatSecondsSmpte(endSec, doc);
    }

    try {
      o608._baseCanonicalTextFp = _fingerprintText(_cueTextForEditing(cue));
    } catch {
      o608._baseCanonicalTextFp = null;
    }
    o608.overridePossiblyStale = false;

    // Suppress the next cue in 608 so we don’t double-display.
    _setCompat608OverrideMute(next, true, 'Muted for 608: merged into previous cue', { skipUndo: true });

    state.activeCue = index;
    markDirty();
    try { updateCompat608UiForCueRow(index, rowEl); } catch {}
    try { updateCompat608UiForCueRow(index + 1); } catch {}
    try { renderActiveCue608(); } catch {}
    setStatus(tr('subtitleEditor.status.mergedNextCue608Only', 'Merged next cue for 608 only'));
  }

function stealFramesFromNeighbor(index, direction, frames = 2) {
    if (!Array.isArray(state.doc?.cues)) return false;
    const doc = state.doc;
    const cues = doc.cues;
    const cue = cues[index];
    if (!cue) return false;
    pushUndo('Steal frames');

    const cfg = _getQcConfigForDoc(doc);
    const nFrames = Math.max(1, Math.min(12, Math.trunc(Number(frames) || 2)));

    const isSmpte = usesSmpteTimecode(doc);
    const fps = Number(doc?.fps) || 29.97;

    // In SMPTE modes (MCC/SCC), stealing frames must be *exactly* N frames.
    // Do the math in integer frame indices (with doc timecode offset), then convert back.
    const meta = isSmpte ? _fpsMetaForFrameStep(fps) : null;
    const offsetSec = isSmpte ? _getDocTimecodeOffsetSeconds(doc) : 0;
    const frameSec = isSmpte ? _secondsPerFrameFromMeta(meta) : (1 / fps);
    const delta = nFrames * frameSec;

    const toFrame = (sec) => {
      const s = Number(sec);
      if (!Number.isFinite(s)) return 0;
      return _frameIndexNearestFromSeconds(Math.max(0, s + offsetSec), meta);
    };

    const fromFrame = (f) => {
      const fi = Math.max(0, Math.trunc(Number(f) || 0));
      const disp = (fi * meta.den) / meta.num;
      return Math.max(0, disp - offsetSec);
    };

    const minDur = Number(cfg?.minDurationSec);
    const effMinDur = (Number.isFinite(minDur) && minDur > 0) ? minDur : 0;

    const maxDur = Number(cfg?.maxDurationSec);
    const effMaxDur = (Number.isFinite(maxDur) && maxDur > 0) ? maxDur : null;

    if (direction < 0) {
      const prev = cues[index - 1];
      if (!prev) return false;

      let newPrevEnd;
      let newStart;

      if (isSmpte) {
        const prevEndF = toFrame(prev.end);
        const cueStartF = toFrame(cue.start);
        const newPrevEndF = prevEndF - nFrames;
        const newCueStartF = cueStartF - nFrames;
        if (newPrevEndF < 0 || newCueStartF < 0) return false;
        newPrevEnd = fromFrame(newPrevEndF);
        newStart = fromFrame(newCueStartF);
      } else {
        newPrevEnd = (Number(prev.end) || 0) - delta;
        newStart = (Number(cue.start) || 0) - delta;
      }

      if (newStart < 0) return false;
      if ((newPrevEnd - (Number(prev.start) || 0)) < effMinDur) return false;
      if ((Number(cue.end) || 0) - newStart < 0.05) return false;
      if (effMaxDur != null && ((Number(cue.end) || 0) - newStart) > (effMaxDur + 1e-6)) return false;

      prev.end = newPrevEnd;
      cue.start = newStart;
    } else {
      const next = cues[index + 1];
      if (!next) return false;

      let newEnd;
      let newNextStart;

      if (isSmpte) {
        const cueEndF = toFrame(cue.end);
        const nextStartF = toFrame(next.start);
        const newCueEndF = cueEndF + nFrames;
        const newNextStartF = nextStartF + nFrames;
        newEnd = fromFrame(newCueEndF);
        newNextStart = fromFrame(newNextStartF);
      } else {
        newEnd = (Number(cue.end) || 0) + delta;
        newNextStart = (Number(next.start) || 0) + delta;
      }

      if ((Number(next.end) || 0) - newNextStart < effMinDur) return false;
      if (newEnd - (Number(cue.start) || 0) < 0.05) return false;
      if (effMaxDur != null && (newEnd - (Number(cue.start) || 0)) > (effMaxDur + 1e-6)) return false;

      cue.end = newEnd;
      next.start = newNextStart;
    }

    markDirty();
    state.activeCue = index;
    renderCues(state.doc.cues);
    highlightCue(index);
    return true;
  }

  
  // Bulk timing helper: fix butt-cuts (end on same frame as the next start) across the doc.
  // policy:
  //  - 'end'  : prefer trimming the previous cue end (1f gap), fallback to delaying the next start
  //  - 'start': prefer delaying the next start (1f gap), fallback to trimming the previous cue end
  //  - 'both' : enforce a 2f gap, preferring a balanced trim (end + start), best effort
  function debuttAllCues(opts = {}) {
    if (!Array.isArray(state.doc?.cues)) return { fixed: 0, failed: 0, changed: 0 };
    const doc = state.doc;
    const cues = doc.cues;
    if (!cues.length) return { fixed: 0, failed: 0, changed: 0 };
    pushUndo('Debutt cues');

    const policyRaw = String(opts.policy || 'end').trim().toLowerCase();
    const policy = (policyRaw === 'start' || policyRaw === 'both') ? policyRaw : 'end';

    // Frame math needs an FPS. SCC/MCC are always frame-based; MCC imports carry doc.fps.
    const fps = Number(doc?.fps) || 29.97;
    const meta = _fpsMetaForFrameStep(fps);
    const offsetSec = _getDocTimecodeOffsetSeconds(doc);

    const toFrame = (sec) => {
      const s = Number(sec);
      if (!Number.isFinite(s)) return 0;
      return _frameIndexNearestFromSeconds(Math.max(0, s + offsetSec), meta);
    };

    const fromFrame = (f) => {
      const fi = Math.max(0, Math.trunc(Number(f) || 0));
      const disp = (fi * meta.den) / meta.num;
      return Math.max(0, disp - offsetSec);
    };

    const gapFrames = (policy === 'both') ? 2 : 1;

    let fixed = 0;
    let failed = 0;
    let changed = 0;

    for (let i = 0; i < cues.length - 1; i++) {
      const a = cues[i];
      const b = cues[i + 1];
      if (!a || !b) continue;

      let aS = toFrame(a.start);
      let aE = toFrame(a.end);
      let bS = toFrame(b.start);
      let bE = toFrame(b.end);

      // Ensure each cue is at least 1 frame long in frame-space.
      if (aE < aS + 1) aE = aS + 1;
      if (bE < bS + 1) bE = bS + 1;

      // Already has enough gap in frame-space.
      if (aE + gapFrames <= bS) continue;

      // Frames we need to "create" to satisfy the gap.
      const needed = (aE + gapFrames) - bS;
      if (!(needed > 0)) continue;

      const availEnd = Math.max(0, aE - (aS + 1));      // how many frames we can trim from a.end
      const availStart = Math.max(0, (bE - 1) - bS);    // how many frames we can push b.start right

      let useEnd = 0;
      let useStart = 0;

      if (policy === 'start') {
        useStart = Math.min(availStart, needed);
        useEnd = Math.min(availEnd, Math.max(0, needed - useStart));
      } else if (policy === 'end') {
        useEnd = Math.min(availEnd, needed);
        useStart = Math.min(availStart, Math.max(0, needed - useEnd));
      } else {
        // Balanced split: try half on each side, then fill the remainder from whichever side has room.
        useEnd = Math.min(availEnd, Math.ceil(needed / 2));
        useStart = Math.min(availStart, Math.max(0, needed - useEnd));

        if (useEnd + useStart < needed) {
          const remain1 = needed - (useEnd + useStart);
          const addStart = Math.min(availStart - useStart, remain1);
          useStart += addStart;

          const remain2 = needed - (useEnd + useStart);
          const addEnd = Math.min(availEnd - useEnd, remain2);
          useEnd += addEnd;
        }
      }

      if (useEnd + useStart < needed) {
        failed++;
        continue;
      }

      let did = false;
      if (useEnd > 0) {
        const newAE = Math.max(aS + 1, aE - useEnd);
        if (newAE !== aE) {
          a.end = fromFrame(newAE);
          aE = newAE;
          changed++;
          did = true;
        }
      }

      if (useStart > 0) {
        const newBS = Math.min(bE - 1, bS + useStart);
        if (newBS !== bS) {
          b.start = fromFrame(newBS);
          bS = newBS;
          changed++;
          did = true;
        }
      }

      if (did) fixed++;
    }

    if (changed > 0) {
      markDirty();
      renderCues(state.doc.cues);
      if (state.activeCue >= 0) highlightCue(state.activeCue);
      try { scheduleQcRecompute(true); } catch {}
      try { renderActiveCue608(); } catch {}
    }

    const tag = (policy === 'both') ? '2f gap' : '1f gap';
    if (changed > 0) {
      setStatus(tr('subtitleEditor.status.debuttedSummary', 'Debutted {{count}} {{boundaryLabel}} ({{tag}}){{failedSuffix}}.', { count: fixed, boundaryLabel: fixed === 1 ? tr('subtitleEditor.common.boundary', 'boundary') : tr('subtitleEditor.common.boundaries', 'boundaries'), tag, failedSuffix: failed ? tr('subtitleEditor.status.debuttedFailedSuffix', ' • {{count}} couldn\'t be fixed', { count: failed }) : '' }));
    } else {
      setStatus(failed
        ? tr('subtitleEditor.status.debuttFailedToFix', 'Debutt: {{count}} {{boundaryLabel}} couldn\'t be fixed.', { count: failed, boundaryLabel: failed === 1 ? tr('subtitleEditor.common.boundary', 'boundary') : tr('subtitleEditor.common.boundaries', 'boundaries') })
        : tr('subtitleEditor.status.debuttNoBoundariesFound', 'Debutt: no same-frame boundaries found.'));
    }

    return { fixed, failed, changed, gapFrames };
  }

  // Timing helper: remove frames from a cue edge (no neighbor ripple).
  // - left : move cue.start forward (shorter)
  // - right: move cue.end backward (shorter)
  // In SMPTE modes (MCC/SCC), this is done in integer frame indices for exactness.
  function removeFramesFromCue(index, edge = 'right', frames = 1) {
    if (!Array.isArray(state.doc?.cues)) return false;
    const doc = state.doc;
    const cues = doc.cues;
    const cue = cues[index];
    if (!cue) return false;
    pushUndo('Remove frames');

    const nFrames = Math.max(1, Math.min(12, Math.trunc(Number(frames) || 1)));
    const isSmpte = usesSmpteTimecode(doc);
    const fps = Number(doc?.fps) || 29.97;

    if (isSmpte) {
      const meta = _fpsMetaForFrameStep(fps);
      const offsetSec = _getDocTimecodeOffsetSeconds(doc);
      const frameSec = _secondsPerFrameFromMeta(meta);

      const toFrame = (sec) => {
        const s = Number(sec);
        if (!Number.isFinite(s)) return 0;
        return _frameIndexNearestFromSeconds(Math.max(0, s + offsetSec), meta);
      };

      const fromFrame = (f) => {
        const fi = Math.max(0, Math.trunc(Number(f) || 0));
        const disp = (fi * meta.den) / meta.num;
        return Math.max(0, disp - offsetSec);
      };

      let sF = toFrame(cue.start);
      let eF = toFrame(cue.end);
      if (eF < sF + 1) eF = sF + 1;

      const e = String(edge || 'right').trim().toLowerCase();
      if (e === 'left' || e === 'start') {
        const newSF = Math.min(sF + nFrames, eF - 1);
        cue.start = Math.max(0, fromFrame(newSF));
        cue.end = Math.max(cue.start + frameSec, fromFrame(eF));
      } else {
        const newEF = Math.max(eF - nFrames, sF + 1);
        cue.end = Math.max(fromFrame(newEF), (Number(cue.start) || 0) + frameSec);
      }
    } else {
      const frameSec = (Number.isFinite(fps) && fps > 0) ? (1 / fps) : 0.04;
      const delta = nFrames * frameSec;
      if (String(edge || 'right').toLowerCase() === 'left' || String(edge || '').toLowerCase() === 'start') {
        cue.start = Math.min((Number(cue.start) || 0) + delta, (Number(cue.end) || 0) - 0.01);
      } else {
        cue.end = Math.max((Number(cue.end) || 0) - delta, (Number(cue.start) || 0) + 0.01);
      }
    }

    markDirty();
    state.activeCue = index;
    renderCues(state.doc.cues);
    highlightCue(index);
    return true;
  }

  function _suggestBalanced608Lines(inputText, maxCols = 32) {
    const cols = Math.max(1, Math.min(32, Math.floor(Number(maxCols) || 32)));
    const ulen = (s) => {
      try { return Array.from(String(s ?? '')).length; } catch { return String(s ?? '').length; }
    };

    const raw = String(inputText ?? '');
    const text = raw
      .replace(/\r\n?/g, '\n')
      .replace(/\n+/g, ' ')
      .replace(/\s*\|\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return null;

    const tokens = text.split(' ').filter(Boolean);
    if (tokens.length === 1) return [tokens[0], ''];

    const hangers = new Set(['a','an','the','of','to','and','or','but','for','in','on','at','with','from','as','by']);

    let best = null;
    const mid = tokens.length / 2;

    for (let i = 1; i < tokens.length; i++) {
      const line1 = tokens.slice(0, i).join(' ');
      const line2 = tokens.slice(i).join(' ');

      if (ulen(line1) > cols || ulen(line2) > cols) continue;

      const lastTok = String(tokens[i - 1] || '').toLowerCase().replace(/[^a-z']/g, '');
      const endChar = line1.trim().slice(-1);

      let score = 0;

      // Prefer similar visual weights
      score += Math.abs(ulen(line1) - ulen(line2));

      // Prefer breaks closer to the middle of the sentence
      score += Math.abs(i - mid) * 0.35;

      // Avoid a single-word second line
      if ((tokens.length - i) === 1) score += 80;

      // Avoid "hangers" on line 1
      if (hangers.has(lastTok)) score += 40;

      // Prefer punctuation boundaries a bit
      if (/[.!?]/.test(endChar)) score -= 10;
      else if (/[,;:]/.test(endChar)) score -= 3;

      if (!best || score < best.score) best = { score, line1, line2 };
    }

    if (best) return [best.line1, best.line2];

    // Fallback to the shared wrapper (same as export path).
    try {
      const meta = window.transcribeEngine?.wrap608WithMeta?.(text, cols, 2, { allowExplicitLineBreaks: false });
      if (meta && Array.isArray(meta.lines) && meta.lines.length && !meta.overflowed && !meta.truncated) {
        return meta.lines.slice(0, 2);
      }
    } catch {}

    return null;
  }

  function reflowCueFor608Only(index, rowEl = null) {
    const doc = state.doc;
    if (!doc || !wantsDualPreview(doc)) return;

    const cue = doc?.cues?.[index];
    if (!cue) return;
    if (_isCompat608Muted(cue)) {
      setStatus(tr('subtitleEditor.status.reflowSkippedMuted608', '608 is muted for this cue; reflow skipped.'));
      return;
    }

    const cfg = _getQcConfigForDoc(doc);
    const lim = _getQcTrackLimitsForDoc(doc, cfg);
    const cols = Math.max(1, Math.min(32, Math.floor(Number(lim?.maxCols608) || 32)));

    const row = rowEl || cuesContainer?.querySelector?.(`.cue[data-index="${index}"]`) || null;
    const wrap = row?.querySelector?.('.cue-compat608') || null;
    const cb = wrap?.querySelector?.('input.compat608-enabled') || null;
    const ta = wrap?.querySelector?.('textarea.compat608-text') || null;

    if (!wrap || !cb || !ta) return;
    pushUndo('Reflow 608 override');

    // Ensure override is enabled; seed from derived 608 when it was off.
    if (!cb.checked) {
      cb.checked = true;
      wrap.classList.remove('disabled');
      ta.disabled = false;

      let seed = '';
      try {
        const tmp = { ...cue };
        _clearCompat608Override(tmp, { skipUndo: true });
        const derived = _buildDerived608CueForPreview(tmp, doc, { ignoreOverride: true });
        seed = Array.isArray(derived?.lines) ? derived.lines.join('\n').trim() : String(derived?.text || '').trim();
      } catch { seed = ''; }
      if (!String(seed || '').trim()) seed = String(_cueTextForEditing(cue) || cue.text || '').trim();

      ta.value = String(seed || '').trim();
      try { autoSizeTextarea(ta); } catch {}
      _setCompat608OverrideText(cue, ta.value, { skipUndo: true });
    }

    // If we already have a split override, reflow each part individually.
    const existingParts = _extractCompat608OverridePartsTextList(cue);
    if (existingParts && existingParts.length) {
      const outParts = [];
      let changed = false;

      for (const p of existingParts) {
        const proposed = _suggestBalanced608Lines(p, cols);
        if (!proposed) {
          outParts.push(String(p || '').trim());
          continue;
        }
        const out = proposed.filter(l => String(l || '').trim().length).join('\n').trim();
        outParts.push(out);
        if (String(out || '').trim() !== String(p || '').trim()) changed = true;
      }

      if (!changed) {
        setStatus(tr('subtitleEditor.status.reflowNotNeeded608', '608 parts already look good; no reflow needed.'));
        return;
      }

      _setCompat608OverrideParts(cue, outParts, { skipUndo: true });
      state.activeCue = index;
      markDirty();
      try { updateCompat608UiForCueRow(index, row); } catch {}
      try { scheduleMccPreviewRebuild(true); } catch {}
      try { scheduleQcRecompute(true); } catch {}
      try { renderActiveCue608(); } catch {}
      setStatus(tr('subtitleEditor.status.reflowed608SplitOverride', 'Reflowed 608 split override ({{count}} parts)', { count: outParts.length }));
      return;
    }

    // Otherwise, reflow the current override text into a clean 608 2-line break.
    const base = String(ta.value || _getCompat608OverrideText(cue) || '').trim();
    const proposed = _suggestBalanced608Lines(base, cols);

    if (proposed) {
      const outText = proposed.filter(l => String(l || '').trim().length).join('\n').trim();
      if (!outText) return;

      ta.value = outText;
      try { autoSizeTextarea(ta); } catch {}
      _setCompat608OverrideBreaks(cue, proposed, { skipUndo: true });
      state.activeCue = index;
      markDirty();
      try { updateCompat608UiForCueRow(index, row); } catch {}
      try { scheduleMccPreviewRebuild(true); } catch {}
      try { scheduleQcRecompute(true); } catch {}
      try { renderActiveCue608(); } catch {}
      setStatus(tr('subtitleEditor.status.reflowed608LineBreaks', 'Reflowed 608 line breaks ({{cols}} cols)', { cols }));
      return;
    }

    // Too long to fit as a 2-line 608 → fall back to a 608-only split (preserves text).
    const normalized = _normalizeTextForQcMetrics(base);
    const parts = _splitTextToFit608Parts(normalized, lim, 4);
    if (parts && parts.length >= 2) {
      _setCompat608OverrideParts(cue, parts, { skipUndo: true });
      // After splitting, attempt to pad into nearby gaps when possible.
      try { padCueTimingFor608Only(index, row, { mark: false, skipUndo: true }); } catch {}

      state.activeCue = index;
      markDirty();
      try { updateCompat608UiForCueRow(index, row); } catch {}
      try { scheduleMccPreviewRebuild(true); } catch {}
      try { scheduleQcRecompute(true); } catch {}
      try { renderActiveCue608(); } catch {}
      setStatus(tr('subtitleEditor.status.reflowed608BySplit', 'Reflowed 608 by splitting into {{count}} parts', { count: parts.length }));
      return;
    }

    setStatus(tr('subtitleEditor.status.reflow608Failed', 'Could not reflow 608: text may be too long or contains an unbreakable token. Try Split 608 or edit the 608 override.'), true);
  }


  function deleteCue(index) {
    if (!Array.isArray(state.doc?.cues)) return;
    const cues = state.doc.cues;
    if (!cues[index]) return;
    pushUndo('Delete cue');

    // Remove the cue
    cues.splice(index, 1);
    markDirty();

    if (!cues.length) {
      // Nothing left – clear selection and UI
      state.activeCue = -1;
      renderCues(cues);
      return;
    }

    // Pick a sane next selection: same index, or previous if we deleted the last one
    const nextIndex = Math.min(index, cues.length - 1);
    state.activeCue = nextIndex;
    renderCues(cues);
    highlightCue(nextIndex);
  }

  function nudgeCue(index, delta, target = 'start') {
    const cue = state.doc?.cues?.[index];
    if (!cue) return;
    pushUndo('Nudge cue', `nudge:${index}:${target}`);
    const doc = state.doc;

    // In SMPTE/timecode docs (MCC/SCC), keep cues frame-aligned and nudge in whole frames.
    if (usesSmpteTimecode(doc)) {
      const fps = Number(doc?.fps) || 29.97;
      const meta = _fpsMetaForFrameStep(fps);
      const offsetSec = _getDocTimecodeOffsetSeconds(doc);
      const frameSec = _secondsPerFrameFromMeta(meta);

      let sF = _frameIndexNearestFromSeconds(Math.max(0, (Number(cue.start) || 0) + offsetSec), meta);
      let eF = _frameIndexNearestFromSeconds(Math.max(0, (Number(cue.end) || 0) + offsetSec), meta);
      if (eF < sF + 1) eF = sF + 1;

      const deltaSec = Number(delta) || 0;
      let deltaFrames = Math.round((deltaSec * meta.num) / meta.den);
      if (!deltaFrames && deltaSec) deltaFrames = Math.sign(deltaSec);

      if (target === 'end') {
        eF = Math.max(sF + 1, eF + deltaFrames);
      } else {
        sF = Math.max(0, Math.min(eF - 1, sF + deltaFrames));
      }
      if (eF < sF + 1) eF = sF + 1;

      cue.start = Math.max(0, (sF * meta.den) / meta.num - offsetSec);
      cue.end = Math.max(cue.start + frameSec, (eF * meta.den) / meta.num - offsetSec);
    } else {
      if (target === 'end') {
        cue.end = Math.max(cue.start + 0.01, cue.end + delta);
      } else {
        cue.start = Math.min(cue.end - 0.01, Math.max(0, cue.start + delta));
      }
    }
    markDirty();
    state.activeCue = index;
    renderCues(state.doc.cues);
    highlightCue(index);
  }

  const UNDO_STACK_LIMIT = 75;
  const UNDO_GROUP_WINDOW_MS = 800;

  function _safeStructuredClone(value) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch {}
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  function snapshotDocState() {
    if (!state.doc) return null;
    const selection = (() => {
      const ta = findActiveCueTextarea();
      if (!ta) return null;
      const row = ta.closest?.('.cue');
      const idx = Number(row?.dataset?.index ?? state.activeCue ?? -1);
      const start = Number.isFinite(Number(ta.selectionStart)) ? ta.selectionStart : null;
      const end = Number.isFinite(Number(ta.selectionEnd)) ? ta.selectionEnd : null;
      return {
        cueIndex: Number.isFinite(idx) ? idx : -1,
        track: String(ta.dataset?.track || 'canonical'),
        start,
        end
      };
    })();

    return {
      doc: _safeStructuredClone(state.doc),
      activeCue: Number.isFinite(Number(state.activeCue)) ? Number(state.activeCue) : -1,
      editModeByCue: _safeStructuredClone(state.editModeByCue || {}),
      activeEditMode: state.activeEditMode || 'canonical',
      context: {
        cuesScrollTop: Number(cuesContainer?.scrollTop || 0),
        qcScrollTop: Number(qcListEl?.scrollTop || 0),
        selection
      }
    };
  }

  function _restoreEditorContext(context = {}) {
    if (!context) return;
    try { if (cuesContainer) cuesContainer.scrollTop = Number(context.cuesScrollTop || 0); } catch {}
    try { if (qcListEl) qcListEl.scrollTop = Number(context.qcScrollTop || 0); } catch {}

    const selection = context.selection;
    if (!selection) return;

    const applySelection = () => {
      const idx = Number(selection.cueIndex);
      if (!Number.isFinite(idx) || idx < 0) return;
      const row = cuesContainer?.querySelector?.(`.cue[data-index="${idx}"]`);
      if (!row) return;
      const track = String(selection.track || 'canonical');
      const ta = row.querySelector(`textarea[data-track="${track}"]`) || row.querySelector('textarea');
      if (!ta) return;
      try {
        ta.focus?.();
        if (selection.start != null && selection.end != null) {
          ta.setSelectionRange(selection.start, selection.end);
        }
      } catch {}
    };

    try {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => applySelection());
      } else {
        setTimeout(applySelection, 0);
      }
    } catch {
      applySelection();
    }
  }

  function _restoreSnapshot(snapshot) {
    if (!snapshot) return;
    state.doc = snapshot.doc ? _safeStructuredClone(snapshot.doc) : null;
    state.editModeByCue = _safeStructuredClone(snapshot.editModeByCue || {});
    state.activeEditMode = snapshot.activeEditMode || 'canonical';

    if (Array.isArray(state.doc?.cues) && state.doc.cues.length) {
      const maxIdx = state.doc.cues.length - 1;
      const next = Number.isFinite(Number(snapshot.activeCue)) ? Number(snapshot.activeCue) : 0;
      state.activeCue = Math.max(0, Math.min(maxIdx, next));
    } else {
      state.activeCue = -1;
    }
  }

  function _renderAfterHistoryRestore(snapshot, label, action) {
    if (!uiBuilt) return;
    renderCues(state.doc?.cues || []);
    if (Number.isFinite(Number(state.activeCue)) && state.activeCue >= 0) {
      highlightCue(state.activeCue);
    }
    renderActiveCue608();
    try { refreshWebPreviewHeaderForDoc(state.doc); } catch {}
    try { refreshSccPreviewHeaderForDoc(state.doc); } catch {}
    try { refreshMccPreviewHeaderForDoc(state.doc); } catch {}
    try { scheduleMccPreviewRebuild(true); } catch {}
    try { scheduleQcRecompute(true); } catch {}
    _restoreEditorContext(snapshot?.context);
    const msg = label ? `${action}: ${label}` : `${action}`;
    setStatus(msg);
  }

  function pushUndo(actionLabel = 'Edit', groupId = null) {
    if (!state.doc || !state.history || state.history.isRestoring) return;
    const now = Date.now();
    const history = state.history;
    const groupKey = groupId || null;
    const withinGroup = groupKey &&
      history.lastGroupId === groupKey &&
      (now - (history.lastGroupAtMs || 0)) <= UNDO_GROUP_WINDOW_MS;

    if (!withinGroup) {
      const snapshot = snapshotDocState();
      if (!snapshot) return;
      history.undo.push({
        label: String(actionLabel || 'Edit'),
        groupId: groupKey,
        at: now,
        snapshot
      });
      if (history.undo.length > UNDO_STACK_LIMIT) history.undo.shift();
    }

    history.lastGroupId = groupKey;
    history.lastGroupAtMs = now;
    if (history.redo.length) history.redo = [];
  }

  function undo() {
    const history = state.history;
    if (!history || !history.undo.length) {
      setStatus(tr('subtitleEditor.status.nothingToUndo', 'Nothing to undo.'));
      return;
    }
    const entry = history.undo.pop();
    const current = snapshotDocState();
    if (current) {
      history.redo.push({
        label: entry.label,
        groupId: entry.groupId,
        at: Date.now(),
        snapshot: current
      });
      if (history.redo.length > UNDO_STACK_LIMIT) history.redo.shift();
    }
    history.isRestoring = true;
    _restoreSnapshot(entry.snapshot);
    history.isRestoring = false;
    history.lastGroupId = null;
    history.lastGroupAtMs = 0;
    _renderAfterHistoryRestore(entry.snapshot, entry.label, 'Undo');
  }

  function redo() {
    const history = state.history;
    if (!history || !history.redo.length) {
      setStatus(tr('subtitleEditor.status.nothingToRedo', 'Nothing to redo.'));
      return;
    }
    const entry = history.redo.pop();
    const current = snapshotDocState();
    if (current) {
      history.undo.push({
        label: entry.label,
        groupId: entry.groupId,
        at: Date.now(),
        snapshot: current
      });
      if (history.undo.length > UNDO_STACK_LIMIT) history.undo.shift();
    }
    history.isRestoring = true;
    _restoreSnapshot(entry.snapshot);
    history.isRestoring = false;
    history.lastGroupId = null;
    history.lastGroupAtMs = 0;
    _renderAfterHistoryRestore(entry.snapshot, entry.label, 'Redo');
  }

  function resetUndoHistory() {
    if (!state.history) return;
    state.history.undo = [];
    state.history.redo = [];
    state.history.lastGroupId = null;
    state.history.lastGroupAtMs = 0;
    state.history.isRestoring = false;
  }

  function markDirty() {
    state.doc.updatedAt = Date.now();
    setStatus(tr('subtitleEditor.status.unsavedChanges', 'Unsaved changes'));

    // Keep the centered web header (SRT/VTT) in sync with cue count changes.
    // (e.g., Insert/Delete Caption)
    try { refreshWebPreviewHeaderForDoc(state.doc); } catch {}
    try { refreshSccPreviewHeaderForDoc(state.doc); } catch {}
    try { refreshMccPreviewHeaderForDoc(state.doc); } catch {}

    // Keep MCC dual preview in sync with edits.
    try { scheduleMccPreviewRebuild(false); } catch {}
    // Keep in-editor QC in sync with edits.
    try { scheduleQcRecompute(false); } catch {}
  }

  function normalizeTimingsToFrames() {
    const doc = state.doc;
    if (!doc) {
      setStatus(tr('subtitleEditor.status.noDocumentLoaded', 'No document loaded.'), true);
      return;
    }

    if (!usesSmpteTimecode(doc)) {
      setStatus(tr('subtitleEditor.status.notSmpteNothingNormalize', 'This document is not in SMPTE/timecode mode — nothing to normalize.'));
      return;
    }
    pushUndo('Normalize timings to frames');

    const frameSec = _frameStepSecondsForDoc(doc);
    const tol = 1e-9;

    let changedEdges = 0;
    let changedOverrides = 0;
    let changedCues = 0;
    let totalCues = 0;

    const seen = new Set();

    const processCueArray = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return;

      for (let i = 0; i < arr.length; i++) {
        const cue = arr[i];
        if (!cue || typeof cue !== 'object') continue;

        totalCues++;
        let changedThisCue = false;

        const rawStartVal = Number(cue.start);
        const startWasInvalid = !Number.isFinite(rawStartVal) || rawStartVal < 0;
        const startBase = startWasInvalid ? 0 : rawStartVal;

        const rawEndVal = Number(cue.end);
        const endWasInvalid = !Number.isFinite(rawEndVal) || rawEndVal <= startBase;
        const endBase = endWasInvalid ? (startBase + frameSec) : rawEndVal;

        let startQ = _quantizeSecondsToSmpteFrame(startBase, doc, 'nearest');
        let endQ = _quantizeSecondsToSmpteFrame(endBase, doc, 'nearest');

        const minEnd = _quantizeSecondsToSmpteFrame(startQ + frameSec, doc, 'ceil');
        if (!Number.isFinite(endQ) || endQ < minEnd - 1e-9) endQ = minEnd;
        if (endQ < startQ) endQ = minEnd;

        if (startWasInvalid || Math.abs(startQ - rawStartVal) > tol) {
          cue.start = startQ;
          changedEdges++;
          changedThisCue = true;
        }

        if (endWasInvalid || Math.abs(endQ - rawEndVal) > tol) {
          cue.end = endQ;
          changedEdges++;
          changedThisCue = true;
        }

        // Quantize any explicit 608 timing overrides (do not touch text overrides here).
        const o = cue.overrides;
        const o608 = (o && typeof o === 'object') ? o['608'] : null;
        if (o608 && typeof o608 === 'object') {
          const origStartRaw = o608.start;
          const origEndRaw = o608.end;

          const hasStart = origStartRaw != null && String(origStartRaw).trim() !== '';
          const hasEnd = origEndRaw != null && String(origEndRaw).trim() !== '';

          let oStartSec = hasStart ? parseSecondsSmpte(origStartRaw, doc, startQ) : null;
          let oEndSec = hasEnd ? parseSecondsSmpte(origEndRaw, doc, endQ) : null;

          if (hasStart) {
            const q = _quantizeSecondsToSmpteFrame(oStartSec, doc, 'nearest');
            const label = formatSecondsSmpte(q, doc);
            if (String(origStartRaw).trim() != label) {
              o608.start = label;
              changedOverrides++;
              changedThisCue = true;
            } else if (String(origStartRaw) !== label) {
              // Normalize whitespace/type quirks without counting as a timing change.
              o608.start = label;
            }
            oStartSec = q;
          }

          if (hasEnd) {
            let q = _quantizeSecondsToSmpteFrame(oEndSec, doc, 'nearest');
            if (hasStart && Number.isFinite(oStartSec) && (q < oStartSec + frameSec - 1e-9)) {
              q = _quantizeSecondsToSmpteFrame(oStartSec + frameSec, doc, 'ceil');
            }
            const label = formatSecondsSmpte(q, doc);
            if (String(origEndRaw).trim() != label) {
              o608.end = label;
              changedOverrides++;
              changedThisCue = true;
            } else if (String(origEndRaw) !== label) {
              o608.end = label;
            }
          }
        }

        if (changedThisCue) changedCues++;
      }
    };

    const addArray = (arr) => {
      if (!Array.isArray(arr) || seen.has(arr)) return;
      seen.add(arr);
      processCueArray(arr);
    };

    addArray(doc.cues);

    const bySvc = doc.cuesByService;
    if (bySvc && typeof bySvc === 'object') {
      for (const k of Object.keys(bySvc)) addArray(bySvc[k]);
    }

    const docsBySvc = doc.docsByService;
    if (docsBySvc && typeof docsBySvc === 'object') {
      for (const k of Object.keys(docsBySvc)) addArray(docsBySvc[k]?.cues);
    }

    if (changedEdges || changedOverrides) {
      const active = Number(state.activeCue);
      markDirty();
      try { renderCues(doc.cues || []); } catch {}
      if (Number.isFinite(active) && active >= 0) {
        try { highlightCue(active); } catch {}
      }
      try { renderActiveCue608(); } catch {}
      try { scheduleMccPreviewRebuild(true); } catch {}
      try { scheduleQcRecompute(true); } catch {}
      setStatus(tr('subtitleEditor.status.normalizedToFrames', 'Normalized to frames: {{changedEdges}} cue edge(s), {{changedOverrides}} 608 override edge(s) across {{changedCues}}/{{totalCues}} cue(s).', { changedEdges, changedOverrides, changedCues, totalCues }));
    } else {
      setStatus(tr('subtitleEditor.status.alreadyFrameAligned', 'Already frame-aligned — no changes.'));
    }
  }

  // ---- Playback hotkeys (subtitle editor) ---------------------------------
  // Space: play/pause (unless typing). Arrow keys: step backward/forward.
  // In SMPTE modes (MCC/SCC), stepping is frame-accurate (not milliseconds).

  function _isTextEntryTargetForHotkeys(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      // Allow range sliders (scrub) to use playback hotkeys.
      const type = String(target.type || '').toLowerCase();
      if (type === 'range') return false;
      return true;
    }
    try { if (target.isContentEditable) return true; } catch {}
    return false;
  }

  function _attachHistorySyncHandlers(textarea) {
    if (!textarea) return;
    textarea.addEventListener('beforeinput', (event) => {
      const inputType = String(event?.inputType || '');
      if (inputType === 'historyUndo') {
        event.preventDefault();
        event.stopPropagation();
        undo();
        return;
      }
      if (inputType === 'historyRedo') {
        event.preventDefault();
        event.stopPropagation();
        redo();
      }
    });
  }

  function toggleEditorPlayback() {
    if (!videoEl) return;
    try {
      if (videoEl.paused) {
        const p = videoEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } else {
        videoEl.pause();
      }
    } catch {}
  }

  function _fpsMetaForFrameStep(fps) {
    const f = Number(fps);
    // Prefer exact rationals for common fractional rates so stepping doesn't drift.
    const candidates = [
      { fps: 23.976, num: 24000, den: 1001 },
      { fps: 24,     num: 24,    den: 1 },
      { fps: 25,     num: 25,    den: 1 },
      { fps: 29.97,  num: 30000, den: 1001 },
      { fps: 30,     num: 30,    den: 1 },
      { fps: 50,     num: 50,    den: 1 },
      { fps: 59.94,  num: 60000, den: 1001 },
      { fps: 60,     num: 60,    den: 1 }
    ];

    if (!Number.isFinite(f) || f <= 0) return { num: 30000, den: 1001 };

    let best = { num: f, den: 1 };
    let bestErr = Infinity;

    for (const c of candidates) {
      const err = Math.abs(f - c.fps);
      if (err < bestErr) {
        bestErr = err;
        best = { num: c.num, den: c.den };
      }
    }

    // Within ~0.05 FPS is "close enough" to treat as that canonical broadcast rate.
    if (bestErr <= 0.05) return best;

    // Fallback: treat fps as a simple float ratio.
    return { num: f, den: 1 };
  }

  function _frameIndexFromSeconds(sec, meta) {
    const s = Number(sec);
    if (!Number.isFinite(s) || !meta || !Number.isFinite(meta.num) || !Number.isFinite(meta.den) || meta.den === 0) return 0;

    const exact = (s * meta.num) / meta.den;
    if (!Number.isFinite(exact)) return 0;

    // Snap values extremely close to an integer frame index so stepping doesn't
    // get stuck at frame boundaries due to floating point quirks.
    const nearest = Math.round(exact);
    if (Math.abs(exact - nearest) < 1e-4) return nearest;

    return Math.floor(exact + 1e-9);
  }

  function _frameIndexNearestFromSeconds(sec, meta) {
    const s = Number(sec);
    if (!Number.isFinite(s) || !meta || !Number.isFinite(meta.num) || !Number.isFinite(meta.den) || meta.den === 0) return 0;
    const exact = (s * meta.num) / meta.den;
    if (!Number.isFinite(exact)) return 0;
    return Math.max(0, Math.round(exact));
  }

  function _frameAlignmentDeltaFrames(seconds, doc) {
    const t = Number(seconds);
    if (!Number.isFinite(t) || !doc) return 0;
    if (!usesSmpteTimecode(doc)) return 0;

    const fps = Number(doc?.fps) || 29.97;
    const meta = _fpsMetaForFrameStep(fps);
    const offsetSec = _getDocTimecodeOffsetSeconds(doc);

    const disp = Math.max(0, t + offsetSec);
    const exact = (disp * meta.num) / meta.den;
    if (!Number.isFinite(exact)) return 0;

    const nearest = Math.round(exact);
    return exact - nearest;
  }

  function _secondsPerFrameFromMeta(meta) {
    if (!meta || !Number.isFinite(meta.num) || !Number.isFinite(meta.den) || meta.num <= 0) return (1001 / 30000);
    return meta.den / meta.num;
  }

  function _toStepString(value) {
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return '0.01';
    // Use a fixed-point string to avoid scientific notation, then trim.
    const s = v.toFixed(12);
    return s.replace(/0+$/g, '').replace(/\.$/g, '');
  }

  function _quantizeSecondsToSmpteFrame(seconds, doc, mode = 'nearest') {
    const t = Number(seconds);
    if (!Number.isFinite(t)) return 0;
    if (!usesSmpteTimecode(doc)) return Math.max(0, t);

    const fps = Number(doc?.fps) || 29.97;
    const meta = _fpsMetaForFrameStep(fps);
    const offsetSec = _getDocTimecodeOffsetSeconds(doc);

    const disp = Math.max(0, t + offsetSec);
    const exact = (disp * meta.num) / meta.den;
    if (!Number.isFinite(exact)) return Math.max(0, t);

    let frames;
    const m = String(mode || 'nearest').toLowerCase();
    if (m === 'floor') frames = Math.floor(exact + 1e-9);
    else if (m === 'ceil') frames = Math.ceil(exact - 1e-9);
    else frames = Math.round(exact);

    const dispQ = (frames * meta.den) / meta.num;
    return Math.max(0, dispQ - offsetSec);
  }

  function _frameStepSecondsForDoc(doc) {
    const fps = Number(doc?.fps) || 29.97;
    const meta = _fpsMetaForFrameStep(fps);
    return _secondsPerFrameFromMeta(meta);
  }

  function refreshScrubberStepForDoc(doc) {
    if (!scrubEl) return;
    if (!usesSmpteTimecode(doc)) {
      scrubEl.step = '0.01';
      scrubEl.dataset.stepMode = 'time';
      return;
    }

    const step = _frameStepSecondsForDoc(doc);
    scrubEl.step = _toStepString(step);
    scrubEl.dataset.stepMode = 'frame';

    // Increase value precision so the slider doesn't collapse distinct frames.
    // (We still quantize on input anyway.)
    try {
      const max = parseFloat(String(scrubEl.max || '0'));
      if (Number.isFinite(max) && max > 0) {
        const q = _quantizeSecondsToSmpteFrame(max, doc, 'ceil');
        scrubEl.max = _toStepString(q);
      }
    } catch {}
  }

  function stepEditorPlayhead(dir = 0) {
    if (!videoEl) return;
    const doc = state.doc || null;

    const dirInt = Math.sign(Number(dir) || 0);
    if (!dirInt) return;

    const tNow = Number(videoEl.currentTime) || 0;
    const dur = Number(videoEl.duration);
    const hasDur = Number.isFinite(dur) && !Number.isNaN(dur);

    let tTarget = tNow;

    if (usesSmpteTimecode(doc)) {
      const fps = Number(doc?.fps) || 29.97;
      const meta = _fpsMetaForFrameStep(fps);
      const offsetSec = _getDocTimecodeOffsetSeconds(doc);

      const dispNow = Math.max(0, tNow + offsetSec);
      const curFrames = _frameIndexFromSeconds(dispNow, meta);

      const maxDisp = hasDur ? Math.max(0, dur + offsetSec) : null;
      const maxFrames = (maxDisp != null)
        ? _frameIndexFromSeconds(maxDisp, meta)
        : Number.POSITIVE_INFINITY;

      const nextFrames = Math.max(0, Math.min(maxFrames, curFrames + dirInt));
      const nextDisp = (nextFrames * meta.den) / meta.num;

      tTarget = Math.max(0, nextDisp - offsetSec);
    } else {
      // Non-SMPTE: keep a small, predictable seek (50ms).
      tTarget = Math.max(0, tNow + dirInt * 0.05);
    }

    if (hasDur) tTarget = Math.min(tTarget, Math.max(0, dur));

    try { videoEl.currentTime = tTarget; } catch {}
    try { syncSecondaryTime(true); } catch {}

    // Update the counter immediately (the media element will also fire timeupdate/seeked).
    try {
      if (currentTimeEl) currentTimeEl.textContent = formatSeconds(tTarget);
      const isSmpte = usesSmpteTimecode(doc);
      if (scrubEl) scrubEl.value = isSmpte ? _toStepString(tTarget) : tTarget.toFixed(2);
    } catch {}

    // Keep cue selection in sync even while paused.
    try { highlightCueForTime(tTarget); } catch {}

    // If paused, update overlays right away for "frame stepping" feel.
    try { if (videoEl.paused) renderActiveCue608(); } catch {}
  }

  function handleHotkeys(event) {
    if (overlay.classList.contains('hidden')) return;

    if ((event.metaKey || event.ctrlKey) && event.key?.toLowerCase() === 'o') {
      event.preventDefault();
      if (overlay?.classList?.contains?.('is-chooser')) {
        pickSubtitleForStart();
      } else {
        pickSubtitleAndLoad();
      }
      return;
    }

    const target = event.target;
    const key = String(event.key || '').toLowerCase();
    const isUndo = (event.metaKey || event.ctrlKey) && key === 'z' && !event.shiftKey;
    const isRedo = (event.metaKey || event.ctrlKey) && ((key === 'z' && event.shiftKey) || key === 'y');

    if (event.key === 'Escape') {
      event.preventDefault();
      hideEditor();
      return;
    }

    if (isUndo || isRedo) {
      if (_isTextEntryTargetForHotkeys(target)) return;
      event.preventDefault();
      if (isUndo) {
        undo();
      } else {
        redo();
      }
      return;
    }

    // Playback controls (work even if no cues are loaded yet)
    const isPlain = !event.metaKey && !event.ctrlKey && !event.altKey;

    if (isPlain && (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar')) {
      if (_isTextEntryTargetForHotkeys(target)) return;
      event.preventDefault();
      toggleEditorPlayback();
      return;
    }

    if (isPlain && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      if (_isTextEntryTargetForHotkeys(target)) return;
      event.preventDefault();
      stepEditorPlayhead(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }

    if (!state.doc?.cues?.length) return;

    const activeIndex = state.activeCue >= 0 ? state.activeCue : 0;

    if ((event.key === 'Delete' || event.key === 'Backspace') &&
        !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Don't eat Backspace/Delete while typing in fields
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      deleteCue(activeIndex);
      event.preventDefault();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      if (target && target.tagName === 'TEXTAREA') return;
      const time = videoEl?.currentTime ?? state.doc.cues[activeIndex]?.start;
      splitCue(activeIndex, time);
      event.preventDefault();
      return;
    }

    if (event.key === 'Enter' && event.shiftKey) {
      mergeCue(activeIndex);
      event.preventDefault();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && (event.key === '.' || event.key === '>')) {
      const step = usesSmpteTimecode(state.doc) ? _frameStepSecondsForDoc(state.doc) : 0.05;
      nudgeCue(activeIndex, step, 'end');
      event.preventDefault();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && (event.key === ',' || event.key === '<')) {
      const step = usesSmpteTimecode(state.doc) ? _frameStepSecondsForDoc(state.doc) : 0.05;
      nudgeCue(activeIndex, -step, 'start');
      event.preventDefault();
    }
  }

  async function openEditor(options = {}) {
    hasOpenedOnce = true;

// If this editor was launched from the Transcribe panel, it may include a
// QC/delivery preference snapshot. Apply it before UI/QC evaluation so the
// initial settings match what was used to generate the file.
try {
  const snap = options?.qcDeliverySnapshot;
  if (snap && typeof snap === 'object') {
    const api = window.qcDeliveryPrefs;
    if (api && typeof api.applyStorageSnapshot === 'function') {
      // Don’t delete existing keys—just overlay what we were given.
      api.applyStorageSnapshot(localStorage, snap, { removeMissing: false });
    } else {
      for (const [k, v] of Object.entries(snap)) {
        if (v === undefined) continue;
        try { localStorage.setItem(k, String(v)); } catch {}
      }
    }
  }
} catch {}

    buildUI();

    // If the window is already holding a loaded doc and we get a “blank” open,
    // just surface the existing editor state (don’t reset to an empty screen).
    const hasDoc = !!(state.doc && Array.isArray(state.doc.cues) && state.doc.cues.length);
    const hasExplicitOpen = !!(options?.sourcePath || options?.sessionId);

    // Remember any mediaPath hint early (used by both the chooser and doc-open flows).
    if (options?.mediaPath) {
      state.doc = state.doc || {};
      state.doc.mediaPath = options.mediaPath;
      try { _refreshStartScreenUi(); } catch {}
    }

    // No explicit file to open → show the chooser (two boxes) when no doc is loaded.
    if (!hasExplicitOpen) {
      if (!hasDoc) {
        showStartScreen();
        showEditor();
        setStatus(tr('subtitleEditor.status.chooseSubtitleLaunchOptionalVideo', 'Choose a subtitle file (video is optional), then click Launch.'));
        return;
      }

      // A doc is already loaded; just show it.
      hideStartScreen();
      showEditor();

      // If a media hint was provided, try to load it into the player.
      if (options?.mediaPath) {
        try {
          await loadMediaIntoPlayer(options.mediaPath);
          setStatusForDoc(state.doc, 'Loaded media.');
        } catch {
          setStatus(tr('subtitleEditor.status.loadedMedia', 'Loaded media.'), false);
        }
      } else {
        try { setStatusForDoc(state.doc); } catch {}
      }
      return;
    }

    // Explicit open request: hide chooser and load the doc.
    hideStartScreen();
    showEditor();
    setStatus(tr('subtitleEditor.status.loadingSubtitle', 'Loading subtitle…'));

    try {
      // Pop-out window has its own webContents; paths coming from another window
      // may not be approved yet for this sender. Best-effort approve.
      const approveList = [options?.sourcePath, options?.mediaPath].filter(Boolean);
      if (approveList.length) {
        await _approvePaths(approveList, { confirm: false });
      }

      const payload = {
        sourcePath: options.sourcePath,
        mediaPath: options.mediaPath,
        sessionId: options.sessionId,

        // Optional Transcribe→Subtitle Editor handoff (no paths; safe to pass through IPC)
        formats: options.formats,
        srtOptions: options.srtOptions,
        vttOptions: options.vttOptions,
        sccOptions: options.sccOptions,
        mccOptions: options.mccOptions
      };
      const response = typeof ipc.invoke === 'function'
        ? await ipc.invoke('subtitle-editor-open', payload)
        : null;

      if (!response || response.error) {
        setStatus(response?.error || tr('subtitleEditor.status.openDocumentFailed', 'Failed to open document.'), true);
        if (!hasDoc) showStartScreen();
        return;
      }

      state.doc = { ...response };
      resetUndoHistory();
      state.lastExport = response.lastExport || null;
      state.activeCue = 0;
      await populateDoc(state.doc);
      setStatusForDoc(state.doc, 'Opened.');
    } catch (err) {
      setStatus(tr('subtitleEditor.status.openFailed', 'Failed to open: {{error}}', { error: err.message }), true);
      if (!hasDoc) showStartScreen();
    }
  }

  async function populateDoc(doc) {
    if (!doc) return;

    // Apply editor mode classes once per document load (Commit 1).
    state.mode = resolveEditorMode(doc);
    overlay.classList.toggle('mode-web', state.mode === EditorMode.WEB);
    overlay.classList.toggle('mode-broadcast', state.mode === EditorMode.BROADCAST);

    // Commit 3: SCC/MCC authoring overlays (safe-title grids, inspectors, click-to-place)
    // are broadcast-only. In web-caption mode (SRT/VTT), they must be hidden and inert.
    const webOn = (state.mode === EditorMode.WEB);
    try {
      const broadcastOn = !webOn;
      window.__editorSafe708?.enable?.(broadcastOn);
      window.__editorSafe608?.enable?.(broadcastOn);
      window.__editorSafe?.enable?.(broadcastOn);
    } catch {}

    // Web caption preview controller visibility follows the doc mode.
    try {
      window.__editorWeb?.enable?.(webOn);
      // Always clear on doc load to prevent stale captions carrying across docs.
      window.__editorWeb?.clear?.();

      if (webOn) {
        // Ensure broadcast caption layers never "ghost" behind the web layer when switching formats.
        const ctrls = [window.__editorSafe708, window.__editorSafe608];
        for (const c of ctrls) {
          try { c?.render608?.(null); } catch {}
          try { c?.render708?.(null); } catch {}
        }
      }
    } catch {}

    const scc = isSccDoc(doc);
    const maxLines = _maxLinesForCueLines(doc);
    const splitRe = _shouldTreatPipeAsHardBreak(doc)
      ? /\r?\n|\s*\|\s*/g
      : /\r?\n/g;

    toolbarTitle.textContent =
      doc.displayName ||
      (doc.sourcePath
        ? window.electron?.basename?.(doc.sourcePath) || doc.sourcePath
        : 'Subtitle Document');

    refreshToolbarMetaForDoc(doc);
    try { refreshWebPreviewHeaderForDoc(doc); } catch {}
    try { refreshSccPreviewHeaderForDoc(doc); } catch {}
    try { refreshMccPreviewHeaderForDoc(doc); } catch {}

    try { refreshDebuttUiForDoc(doc); } catch {}

    // Multi-service (CEA-708): expose a service selector and ensure the active service
    // uses a shared cue array with doc.cuesByService.
    try { refreshServiceSelectorForDoc(doc); } catch {}

    // Toggle Export SCC / Export Corrections visibility based on format
    updateFormatButtonsForDoc(doc);
    // SCC toolbar: keep uniform button sizing after show/hide rules apply.
    try { scheduleToolbarActionSizing(); } catch {}
    // Web caption docs (SRT/VTT) should not inherit 608/708-specific toggles.
    try { updateEditorInteractionUiForDoc(doc); } catch {}
    // Milestone 5: switch preview layout (single vs dual) based on 708 authoring.
    try { updatePreviewLayoutForDoc(doc); } catch {}
    try { update708PlacementModeUiForDoc(doc); } catch {}
    try { update608PlacementTargetUiForDoc(doc); } catch {}

    // The left preview pane is the only visible pane in single-preview mode.
    // It is created as __editorSafe708 (because it's the "primary" pane with controls).
    // Policy:
    //  - 708 authoring (dual preview): primary track is 708.
    //  - SCC / other 608-style docs (single preview): primary track uses 608 geometry.
    //  - Web captions (SRT/VTT): primary pane stays on 708 geometry, but captions render
    //    via the independent web-caption overlay (Commit 2).
    try {
      const primaryTrack = wantsDualPreview(doc) ? '708' : (webOn ? '708' : '608');
      window.__editorSafe708?.setTrack?.(primaryTrack);
      // Keep legacy alias aligned with the visible pane.
      if (window.__editorSafe && window.__editorSafe === window.__editorSafe708) {
        window.__editorSafe?.setTrack?.(primaryTrack);
      }
    } catch {}
    renderImportIssues(doc);

    // Try to play doc.mediaPath even if we can't stat it (no preload).
    const canStat = typeof window.electron?.fileExistsAsync === 'function';
    const mediaExists = !canStat
      ? true
      : await window.electron.fileExistsAsync(doc.mediaPath).catch(() => false);
    if (doc.mediaPath && mediaExists) {
      await loadMediaIntoPlayer(doc.mediaPath);
    } else {
      // No automatic media prompt anymore. The start screen + Launch button
      // handles initial selection, and in-editor changes are explicit via
      // “Open Media…”. Keeping this silent avoids surprise dialogs.
      try {
        if (videoEl) videoEl.removeAttribute('src');
        if (videoEl608) videoEl608.removeAttribute('src');
      } catch {}
    }

    // Normalize `lines` and fix legacy placements so the first line renders on top.
    if (Array.isArray(doc.cues)) {
      doc.cues.forEach((c) => {
        if (!Array.isArray(c.lines) || !c.lines.length) {
          const base = String(_cueTextFromCue(c) || '').replace(/\\n/g, '\n');
          c.lines = base
            .split(splitRe)
            .map((s) => {
              const str = String(s || '');
              // SCC: preserve leading spaces, only strip trailing whitespace
              return scc ? str.replace(/\s+$/g, '') : str.trim();
            })
            // For SCC, keep lines that contain any non-space char (but preserve leading spaces)
            .filter((line) => (scc ? /[^\s]/.test(line) : Boolean(line)))
            .slice(0, maxLines);
        }
        if (Array.isArray(c.lines) && c.lines.length === 2 && c.sccPlacement) {
          const r0 = Number(c.sccPlacement[0]?.row);
          const r1 = Number(c.sccPlacement[1]?.row);
          if (Number.isFinite(r0) && Number.isFinite(r1) && r0 > r1) {
            // Normalize to [top, bottom] across both placement AND text.
            [c.sccPlacement[0], c.sccPlacement[1]] = [c.sccPlacement[1], c.sccPlacement[0]];
            [c.lines[0], c.lines[1]] = [c.lines[1], c.lines[0]];
            c.text = c.lines.join('\n');
          }
        }

        if (c.sccPlacement == null && scc) {
          // Build effective SCC options: prefer explicit doc.sccOptions,
          // but fall back to doc.alignment when present.
          const sccOpts = (() => {
            const base = { ...(doc.sccOptions || {}) };
            if (!base.alignment && doc.alignment) {
              const raw = String(doc.alignment || '').trim().toLowerCase();
              base.alignment = (raw === 'centre') ? 'center' : (raw || 'left');
            }
            return base;
          })();

          const audit = window.transcribeEngine?.computeCea608PlacementAudit?.(
            [{ text: c.lines.join('\n'), start: c.start, end: c.end }],
            {
              maxCharsPerLine: doc.maxCharsPerLine || 28,
              maxLinesPerBlock: doc.maxLinesPerBlock || 2,
              includeSpeakerNames: true,
              sccOptions: sccOpts
            }
          );

          const first = audit && audit[0];
          if (first && Array.isArray(first.lines) && first.lines.length) {
            // IMPORTANT: use the 608‑wrapped lines from the audit so the
            // text we render matches the placement we’re using.
            c.lines = first.lines.map(l => l.text);
            c.text = c.lines.join('\n');

            c.sccPlacement = first.lines.map(l => ({
              row: l.row,
              col: l.columnStart
            }));
          }
        }
      });
    }

    renderCues(doc.cues || []);
    // Web captions (SRT/VTT): don't default to cue #0 at t=0 when the first cue starts later.
    // This prevents the preview from showing the first available caption at the start.
    if (isWebCaptionDoc(doc)) {
      const t0 = (typeof videoEl?.currentTime === 'number') ? (Number(videoEl.currentTime) || 0) : 0;
      highlightCueForTime(t0, { force: true, scroll: false });
    } else {
      highlightCue(0);
    }
    if (Array.isArray(doc.cues) && doc.cues.length) {
      const last = doc.cues[doc.cues.length - 1];
      const isSmpte = usesSmpteTimecode(doc);
      const maxTime = isSmpte ? _quantizeSecondsToSmpteFrame(Number(last.end) || 0, doc, 'ceil') : (Number(last.end) || 0);
      durationEl.textContent = formatSeconds(maxTime);
      scrubEl.max = isSmpte ? _toStepString(maxTime) : maxTime.toFixed(2);
    } else {
      durationEl.textContent = '00:00:00.000';
      scrubEl.max = '0';
    }

    // Ensure the scrubber steps match the doc's time model (frames for MCC/SCC).
    try { refreshScrubberStepForDoc(doc); } catch {}

    // Build dual-preview docs (encode MCC + decode 708 and forced-608) so the
    // preview reflects what we'd actually export.
    try { scheduleMccPreviewRebuild(true); } catch {}

    // Priority 1: compute QC immediately so cues + panel are decorated on load.
    try { scheduleQcRecompute(true); } catch {}
  }

  // eslint-disable-next-line no-unused-vars
  async function pickExportDirectory(_defaultDir) {
    if (typeof ipc?.invoke !== 'function') {
      setStatus(tr('subtitleEditor.status.folderPickerUnavailable', 'Folder picker unavailable.'), true);
      return null;
    }
    try {
      // Your IPC handler 'select-folder' takes no args. Options are ignored there.
      // Keep title/defaultPath local if you later enhance the handler.
      const dir = await ipc.invoke('select-folder');
      return dir || null;
    } catch (err) {
      setStatus(tr('subtitleEditor.export.cancelledWithError', 'Export cancelled: {{error}}', { error: err.message }), true);
      return null;
    }
  }

  // Minimal "Save As…" for SCC (Option A: use real IPC channel)
  function normalizeDialogPath(raw) {
    // Electron dialogs can return either:
    //  - string (file path)
    //  - object { filePath: string } (common pattern)
    //  - object { path: string } (defensive)
    //  - null/undefined (cancel)
    if (!raw) return null;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') {
      const fp = raw.filePath || raw.path || raw.outPath || null;
      return (typeof fp === 'string' && fp.trim()) ? fp : null;
    }
    return null;
  }

  function ensureFileExtension(filePath, ext) {
    const cleanExt = String(ext || '').replace(/^\./, '');
    if (!cleanExt) return filePath;
    const raw = String(filePath || '');
    return raw.toLowerCase().endsWith(`.${cleanExt.toLowerCase()}`) ? raw : `${raw}.${cleanExt}`;
  }

  async function saveSrtAs(defaultName) {
    if (typeof ipc?.invoke !== 'function') {
      setStatus(tr('subtitleEditor.export.saveDialogUnavailable', 'Save dialog unavailable.'), true);
      return null;
    }
    const raw = await ipc.invoke('save-file-dialog', {
      title: tr('subtitleEditor.export.dialogTitleSrt', 'Export SRT'),
      defaultPath: defaultName || 'subtitle.corrected.srt',
      filters: [{ name: 'SubRip SRT', extensions: ['srt'] }]
    });
    return normalizeDialogPath(raw);
  }

  async function saveVttAs(defaultName) {
    if (typeof ipc?.invoke !== 'function') {
      setStatus(tr('subtitleEditor.export.saveDialogUnavailable', 'Save dialog unavailable.'), true);
      return null;
    }
    const raw = await ipc.invoke('save-file-dialog', {
      title: tr('subtitleEditor.export.dialogTitleVtt', 'Export VTT'),
      defaultPath: defaultName || 'subtitle.corrected.vtt',
      filters: [{ name: 'WebVTT', extensions: ['vtt'] }]
    });
    return normalizeDialogPath(raw);
  }

  async function saveJsonAs(defaultName) {
    if (typeof ipc?.invoke !== 'function') {
      setStatus(tr('subtitleEditor.export.saveDialogUnavailable', 'Save dialog unavailable.'), true);
      return null;
    }
    const raw = await ipc.invoke('save-file-dialog', {
      title: tr('subtitleEditor.export.dialogTitleJson', 'Export JSON'),
      defaultPath: defaultName || 'subtitle.corrected.final.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    return normalizeDialogPath(raw);
  }

  async function saveSccAs(defaultName) {
    if (typeof ipc?.invoke !== 'function') {
      setStatus(tr('subtitleEditor.export.saveDialogUnavailable', 'Save dialog unavailable.'), true);
      return null;
    }
    const raw = await ipc.invoke('save-file-dialog', {
      title: tr('subtitleEditor.export.dialogTitleScc', 'Export SCC'),
      defaultPath: defaultName || 'subtitle.corrected.scc',
      filters: [{ name: 'Scenarist SCC', extensions: ['scc'] }]
    });
    return normalizeDialogPath(raw);
  }

  async function saveMccAs(defaultName) {
    if (typeof ipc?.invoke !== 'function') {
      setStatus(tr('subtitleEditor.export.saveDialogUnavailable', 'Save dialog unavailable.'), true);
      return null;
    }
    const raw = await ipc.invoke('save-file-dialog', {
      title: tr('subtitleEditor.export.dialogTitleMcc', 'Export MCC'),
      defaultPath: defaultName || 'subtitle.corrected.mcc',
      filters: [{ name: 'MacCaption MCC', extensions: ['mcc'] }]
    });
    return normalizeDialogPath(raw);
  }

  async function exportDoc(options = {}) {
    if (!state.doc) {
      setStatus(tr('subtitleEditor.export.nothingToExport', 'Nothing to export'), true);
      return;
    }
    try {
      const doc = state.doc;

      const base =
        doc.baseName ||
        (doc.sourcePath
          ? (window.electron?.basename?.(doc.sourcePath, window.electron?.extname?.(doc.sourcePath)) || 'subtitle')
          : null) ||
        (doc.mediaPath
          ? (window.electron?.basename?.(doc.mediaPath, window.electron?.extname?.(doc.mediaPath)) || 'subtitle')
          : 'subtitle');

      const exportFormat = resolveCorrectionExportFormat(doc, options?.exportFormat);
      const ext = (exportFormat === 'json') ? 'json' : exportFormat;
      const defaultFileName = (exportFormat === 'json')
        ? `${base}.corrected.final.json`
        : `${base}.corrected.${ext}`;

      let defaultPath = defaultFileName;
      try {
        const dir =
          doc.outputDir ||
          (doc.sourcePath && window.electron?.dirname ? window.electron.dirname(doc.sourcePath) : null) ||
          (doc.mediaPath && window.electron?.dirname ? window.electron.dirname(doc.mediaPath) : null) ||
          null;
        if (dir && window.electron?.joinPath) {
          defaultPath = window.electron.joinPath(dir, defaultFileName);
        }
      } catch {}

      const primary = (exportFormat === 'vtt')
        ? await saveVttAs(defaultPath)
        : (exportFormat === 'json')
          ? await saveJsonAs(defaultPath)
          : await saveSrtAs(defaultPath);

      if (!primary) {
        setStatus(tr('subtitleEditor.export.cancelled', 'Export cancelled.'), true);
        return;
      }

      const primaryWithExt = ensureFileExtension(primary, ext);

      const payload = {
        doc,
        sessionId: doc.sessionId,
        exportFormat,
        lastExport: state.lastExport,
        outputPaths: { [exportFormat]: primaryWithExt }
      };
      const result = typeof ipc.invoke === 'function'
        ? await ipc.invoke('subtitle-editor-export', payload)
        : null;

      if (result?.error) {
        setStatus(result.error, true);
        return;
      }

      if (result?.outputs) {
        state.lastExport = result.outputs;
        if (result.outputs.directory) {
          state.doc.outputDir = result.outputs.directory;
        }
      }
      const exportedPath = result?.outputs?.[exportFormat] || primaryWithExt;
      setStatus(result?.message || tr('subtitleEditor.export.exportedPath', 'Exported: {{path}}', { path: exportedPath }));
    } catch (err) {
      console.error('Subtitle export failed', err);
      setStatus(tr('subtitleEditor.export.failed', 'Export failed: {{error}}', { error: err.message }), true);
    }
  }

  function getSccPrefsFromLocalStorage() {
    // Single source of truth: use the shared QC & Delivery module.
    // We keep a tiny fallback so the editor doesn't crash if the script tag is missing.
    try {
      const api = window.qcDeliveryPrefs;
      if (api && typeof api.readSccPrefs === 'function') {
        return api.readSccPrefs(localStorage);
      }
    } catch {}
    return { exportPolicy: 'warn', qc: { gate: false } };
  }

  function getMccPrefsFromLocalStorage() {
    // Single source of truth: use the shared QC & Delivery module.
    try {
      const api = window.qcDeliveryPrefs;
      if (api && typeof api.readMccPrefs === 'function') {
        return api.readMccPrefs(localStorage);
      }
    } catch {}
    return { exportPolicy: 'warn', qc: { gate: false } };
  }

  // Phase 5: Single merge path for QC & Delivery prefs.
  // This ensures Transcribe panel prefs are honored when exporting from the Subtitle Editor.
  function applyQcDeliveryPrefsToDocForExport(docIn) {
    const doc = (docIn && typeof docIn === 'object') ? docIn : null;
    if (!doc) return docIn;

    // Use the shared QC & Delivery module (same logic as Transcribe panel).
    try {
      const api = window.qcDeliveryPrefs;
      if (api && typeof api.mergeDocOptionsForExport === 'function') {
        const prefsAll = (typeof api.readAll === 'function') ? api.readAll(localStorage) : null;
        return api.mergeDocOptionsForExport(doc, prefsAll);
      }
    } catch {}

    // If the shared module isn't available, leave the doc unchanged.
    return docIn;
  }

  async function exportSccDoc() {
    if (!state.doc) {
      setStatus(tr('subtitleEditor.export.nothingToExport', 'Nothing to export'), true);
      return;
    }
    try {
      // Phase 5: unify export behavior with Transcribe panel prefs.
      try { state.doc = applyQcDeliveryPrefsToDocForExport(state.doc); } catch {}

      // Save-as every time (simple, explicit, reliable)
      const base = state.doc.baseName
        || (state.doc.sourcePath
          ? (window.electron?.basename?.(state.doc.sourcePath, window.electron?.extname?.(state.doc.sourcePath)) || 'subtitle')
          : 'subtitle');
      // Prefer a directory-based default so the dialog opens where users expect.
      // 1) doc.outputDir
      // 2) folder of the source subtitle
      // 3) fallback to just filename
      let defaultPath = `${base}.corrected.scc`;
      try {
        const dir =
          state.doc.outputDir ||
          (state.doc.sourcePath && window.electron?.dirname ? window.electron.dirname(state.doc.sourcePath) : null) ||
          null;
        if (dir && window.electron?.joinPath) {
          defaultPath = window.electron.joinPath(dir, `${base}.corrected.scc`);
        }
      } catch {}

      const outPath = await saveSccAs(defaultPath);
      if (!outPath) {
        setStatus(tr('subtitleEditor.export.cancelled', 'Export cancelled.'));
        return;
      }

      // Persist dir for other exports if desired
      try { state.doc.outputDir = window.electron?.dirname ? window.electron.dirname(outPath) : state.doc.outputDir; } catch {}

      const payload = {
        doc: state.doc,
        sessionId: state.doc.sessionId,
        lastExport: state.lastExport,
        outputPath: outPath
      };

      const result = await ipc.invoke('subtitle-editor-export-scc', payload);

      // Human-readable “deliverable mode” label (so users know WHY QC is gating).
      const policy = (() => {
        try {
          const api = window.qcDeliveryPrefs;
          if (api && typeof api.normalizeExportPolicy === 'function') {
            const raw = state.doc?.sccOptions?.exportPolicy || (() => { try { return localStorage.getItem('scc-export-policy'); } catch { return ''; } })() || '';
            return api.normalizeExportPolicy(raw, 'warn') || 'warn';
          }
        } catch {}
        return 'warn';
      })();
      const modeLabel = (policy === 'gate_block') ? tr('subtitleEditor.export.modeLabelGateBlock', 'Strict Delivery — block write on QC fail')
        : (policy === 'gate_write') ? tr('subtitleEditor.export.modeLabelGateWrite', 'Delivery — write + fail on QC')
        : tr('subtitleEditor.export.modeLabelWarn', 'Draft — write + warn');

      const status = String(result?.status || '').trim();

      // Prefer machine-parseable result fields when available.
      const saved = (Array.isArray(result?.writtenFiles) && result.writtenFiles.length)
        ? result.writtenFiles[0]
        : ((typeof result?.output === 'string' && result.output) ? result.output : outPath);
      const report = (typeof result?.reportPath === 'string' && result.reportPath) ? result.reportPath : '';

      const message = (typeof result?.message === 'string' && result.message)
        ? result.message
        : ((typeof result?.error === 'string' && result.error) ? result.error : '');

      if (status) {
        const warn = !!(status !== 'success' || result?.warning || (Array.isArray(result?.warnings) && result.warnings.length));
        setStatus(
          message || (
            status === 'success'
              ? tr('subtitleEditor.export.sccPassed', '✅ SCC exported — QC PASSED ({{modeLabel}}) • {{saved}}', { modeLabel, saved })
              : (status === 'partial_written' || status === 'fail_fallback')
                ? tr('subtitleEditor.export.sccExportConsideredFailed', '⚠️ SCC exported — export considered FAILED ({{modeLabel}}) • {{saved}} • Report: {{report}}', { modeLabel, saved, report })
                : tr('subtitleEditor.export.sccNotExportedFailed', '⛔ SCC NOT exported — export FAILED ({{modeLabel}}) • Report: {{report}}', { modeLabel, report })
          ),
          warn
        );

        try { if (report) await revealInFinder(report); } catch {}
        try { if (saved) await revealInFinder(saved); } catch {}
        return;
      }

      // Legacy fallback (pre-status result)
      // QC gate failure (deliverable modes) is a SPECIAL CASE: we still want a clear UX stamp.
      if (result?.qcGateFailed) {
        if (result?.qcGateBlocked) {
          setStatus(
            report
              ? tr('subtitleEditor.export.sccNotExportedQcFailedReport', '⛔ SCC NOT exported — QC FAILED ({{modeLabel}}) • Report: {{report}}', { modeLabel, report })
              : tr('subtitleEditor.export.sccNotExportedQcFailed', '⛔ SCC NOT exported — QC FAILED ({{modeLabel}})', { modeLabel }),
            true
          );
          return;
        }
        setStatus(
          report
            ? tr('subtitleEditor.export.sccExportedQcFailedReport', '⚠️ SCC exported — QC FAILED ({{modeLabel}}) • {{saved}} • Report: {{report}}', { modeLabel, saved, report })
            : tr('subtitleEditor.export.sccExportedQcFailed', '⚠️ SCC exported — QC FAILED ({{modeLabel}}) • {{saved}}', { modeLabel, saved }),
          true
        );
        return;
      }

      // Hard errors (encoding, disk, IPC, etc.)
      if (result?.error) {
        setStatus(result.error, true);
        return;
      }

      // Non-gated warnings (Draft mode) still deserve visibility.
      if (result?.warning) {
        setStatus(
          report
            ? tr('subtitleEditor.export.sccExportedQcWarningsReport', '⚠️ SCC exported — QC WARNINGS ({{modeLabel}}) • {{saved}} • Report: {{report}}', { modeLabel, saved, report })
            : tr('subtitleEditor.export.sccExportedQcWarnings', '⚠️ SCC exported — QC WARNINGS ({{modeLabel}}) • {{saved}}', { modeLabel, saved }),
          true
        );
        return;
      }

      setStatus(tr('subtitleEditor.export.sccPassed', '✅ SCC exported — QC PASSED ({{modeLabel}}) • {{saved}}', { modeLabel, saved }));
    } catch (err) {
      console.error(err);
      setStatus(tr('subtitleEditor.export.sccFailed', 'SCC export failed: {{error}}', { error: err.message }), true);
    }
  }

  async function exportMccDoc() {
    if (!state.doc) {
      setStatus(tr('subtitleEditor.export.nothingToExport', 'Nothing to export'), true);
      return;
    }

    try {
      // Phase 5: unify export behavior with Transcribe panel prefs.
      try { state.doc = applyQcDeliveryPrefsToDocForExport(state.doc); } catch {}

      let defaultPath = null;
      try {
        const base =
          state.doc.baseName ||
          (state.doc.sourcePath ? window.electron?.basename?.(state.doc.sourcePath, window.electron?.extname?.(state.doc.sourcePath)) : null) ||
          (state.doc.mediaPath ? window.electron?.basename?.(state.doc.mediaPath, window.electron?.extname?.(state.doc.mediaPath)) : null) ||
          'subtitle';

        const dir =
          state.doc.outputDir ||
          (state.doc.sourcePath && window.electron?.dirname ? window.electron.dirname(state.doc.sourcePath) : null) ||
          null;

        if (dir && window.electron?.joinPath) {
          defaultPath = window.electron.joinPath(dir, `${base}.corrected.mcc`);
        }
      } catch {}

      const outPath = await saveMccAs(defaultPath);
      if (!outPath) {
        setStatus(tr('subtitleEditor.export.cancelled', 'Export cancelled.'));
        return;
      }

      try { state.doc.outputDir = window.electron?.dirname ? window.electron.dirname(outPath) : state.doc.outputDir; } catch {}

      const payload = {
        doc: state.doc,
        sessionId: state.doc.sessionId,
        lastExport: state.lastExport,
        outputPath: outPath
      };

      const result = await ipc.invoke('subtitle-editor-export-mcc', payload);

      const policy = (() => {
        try {
          const api = window.qcDeliveryPrefs;
          if (api && typeof api.normalizeExportPolicy === 'function') {
            return api.normalizeExportPolicy(state.doc?.mccOptions?.exportPolicy || '', 'warn') || 'warn';
          }
        } catch {}
        return 'warn';
      })();
      const modeLabel = (policy === 'gate_block') ? tr('subtitleEditor.export.modeLabelGateBlock', 'Strict Delivery — block write on QC fail')
        : (policy === 'gate_write') ? tr('subtitleEditor.export.modeLabelGateWrite', 'Delivery — write + fail on QC')
        : tr('subtitleEditor.export.modeLabelWarn', 'Draft — write + warn');

      const status = String(result?.status || '').trim();
      const saved = (Array.isArray(result?.writtenFiles) && result.writtenFiles.length)
        ? result.writtenFiles[0]
        : ((typeof result?.output === 'string' && result.output) ? result.output : '');
      const report = (typeof result?.reportPath === 'string' && result.reportPath) ? result.reportPath : '';

      const message = (typeof result?.message === 'string' && result.message)
        ? result.message
        : ((typeof result?.error === 'string' && result.error) ? result.error : '');

      // New deterministic export result (preferred)
      if (status) {
        const warn = !!(status !== 'success' || result?.warning || (Array.isArray(result?.warnings) && result.warnings.length));
        setStatus(
          message || (
            status === 'success'
              ? tr('subtitleEditor.export.mccSaved', 'MCC saved ({{modeLabel}})', { modeLabel })
              : (status === 'partial_written' || status === 'fail_fallback')
                ? tr('subtitleEditor.export.mccSavedExportFailed', '⚠️ MCC saved but {{modeLabel}} export failed (see report).', { modeLabel })
                : tr('subtitleEditor.export.mccNotSavedExportFailed', '⛔ MCC NOT saved — {{modeLabel}} export failed (see report).', { modeLabel })
          ),
          warn
        );

        try { if (report) await revealInFinder(report); } catch {}
        try { if (saved) await revealInFinder(saved); } catch {}
        return;
      }

      // Legacy fallback (pre-status result)
      const legacySaved = (typeof result?.output === 'string' && result.output) ? result.output : outPath;

      // Hard errors (encoding, disk, IPC, path guards, etc.)
      if (result?.error) {
        setStatus(result.error, true);
        return;
      }

      if (result?.qcGateFailed) {
        if (result?.qcGateBlocked) {
          setStatus(tr('subtitleEditor.export.mccNotSavedQcGateFailed', '⛔ MCC NOT saved — {{modeLabel}} QC gate failed. See report.', { modeLabel }), true);
        } else {
          setStatus(tr('subtitleEditor.export.mccSavedButQcFailed', '⚠️ MCC saved but {{modeLabel}} QC failed (see report).', { modeLabel }), true);
        }
        try { if (report) await revealInFinder(report); } catch {}
        return;
      }

      const warn = !!(result?.warning || (Array.isArray(result?.warnings) && result.warnings.length));
      setStatus(warn
        ? tr('subtitleEditor.export.mccSavedSeeReport', '⚠️ MCC saved ({{modeLabel}}) — see report', { modeLabel })
        : tr('subtitleEditor.export.mccSaved', 'MCC saved ({{modeLabel}})', { modeLabel }),
        warn);

      try { if (report) await revealInFinder(report); } catch {}
      try { if (legacySaved) await revealInFinder(legacySaved); } catch {}
    } catch (err) {
      setStatus(err?.message || String(err), true);
    }
  }

  async function burnInDoc() {
    if (!state.doc) {
      setStatus(tr('subtitleEditor.export.nothingToBurnIn', 'Nothing to burn in'), true);
      return;
    }

    try {
      if (!state.lastExport || !state.lastExport.srt || !state.lastExport.directory) {
        setStatus(tr('subtitleEditor.export.exportingCorrectionsBeforeBurnIn', 'Exporting corrections before burn-in…'));
        await exportDoc({ exportFormat: 'srt' });
        if (!state.lastExport || !state.lastExport.srt || !state.lastExport.directory) {
          setStatus(tr('subtitleEditor.export.failedNoOutputDirectory', 'Export failed: no output directory known'), true);
          return;
        }
      }
      const payload = {
        doc: state.doc,
        sessionId: state.doc.sessionId,
        lastExport: state.lastExport
      };
      const result = typeof ipc.invoke === 'function'
        ? await ipc.invoke('subtitle-editor-burnin', payload)
        : null;
      if (result?.output) {
        state.lastExport = { ...(state.lastExport || {}), burnIn: result.output };
      }
      setStatus(result?.message || tr('subtitleEditor.export.burnInStarted', 'Burn-in started.'));
    } catch (err) {
      console.error('Subtitle burn-in failed', err);
      setStatus(tr('subtitleEditor.export.burnInFailed', 'Burn-in failed: {{error}}', { error: err.message }), true);
    }
  }

  window.subtitleEditorExport = exportDoc;
  window.subtitleEditorBurnIn = burnInDoc;

  // Preferred: subscribe directly to the preload fan‑out for init payloads
  if (window.subtitleEditor && typeof window.subtitleEditor.onInit === 'function') {
    window.subtitleEditor.onInit((data) => openEditor(data || {}));
  }
  // Back‑compat: also accept a DOM event from any legacy forwarders
  window.openSubtitleEditorOverlay = (data) => openEditor(data || {});
  window.addEventListener('subtitle-editor:init', (e) => openEditor((e && e.detail) || {}), { once: true });

  // Pop-out bootstrap (Option B): the subtitle editor window should never
  // open “blank”. Even if the init payload is lost due to timing, the user
  // should see the full UI immediately, and we can pull the latest init
  // payload from the main process as a fallback.
  if (isPopout) {
    const boot = async () => {
      // Let any preload fan-out fire first.
      try { await Promise.resolve(); } catch {}
      if (hasOpenedOnce) return;

      let pending = null;
      try {
        pending = (typeof ipc?.invoke === 'function')
          ? await ipc.invoke('subtitle-editor-get-pending-init')
          : null;
      } catch {}

      if (hasOpenedOnce) return;
      // openEditor(...) will build/show UI even when pending is empty.
      try { await openEditor(pending || {}); } catch { try { await openEditor({}); } catch {} }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  const readyToken = loaderToken || window.__subtitleEditorLoaderToken || null;
  if (readyToken) bootState.readyToken = readyToken;
  window.dispatchEvent(new CustomEvent('subtitle-editor-ready', {
    detail: { token: bootState.readyToken || readyToken }
  }));
})();
