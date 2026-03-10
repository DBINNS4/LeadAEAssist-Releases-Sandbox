const fs = require('fs');
const path = require('path');
const { renameReplaceSync } = require('../utils/fsSafe');
const os = require('os');
const crypto = require('crypto');
const { ensureTempSubdir } = require('../utils/appPaths');
const { generatePlainText } = require('./plainTextFormatter');
// ... other requires
// Avoid loading transcribeEngine at module init time here.
// outputWriters is imported by transcribeEngine, so a top-level require would
// recreate the circular dependency that caused partially initialized exports.
//
// NOTE: Some test harnesses (and certain CLI contexts) load this module
// without Electron/OpenAI deps installed. Keep transcribeEngine access
// best-effort and lazy, since MCC/SCC/SRT/TXT exports do not depend on it.
let _transcribeEngine = null;
let _transcribeEngineLoadError = null;
let _transcribeEngineResolved = false;
function getTranscribeEngine() {
  if (_transcribeEngineResolved) return _transcribeEngine;
  _transcribeEngineResolved = true;
  try {
    _transcribeEngine = require('./transcribeEngine');
    _transcribeEngineLoadError = null;
  } catch (err) {
    _transcribeEngine = null;
    _transcribeEngineLoadError = err;
  }
  return _transcribeEngine;
}

function getTranscribeEngineMethod(methodName) {
  const engine = getTranscribeEngine();
  const method = engine && engine[methodName];
  if (typeof method === 'function') return method.bind(engine);
  const detail = _transcribeEngineLoadError?.message ? ` (${_transcribeEngineLoadError.message})` : '';
  throw new Error(`Required transcribeEngine method unavailable: ${methodName}${detail}`);
}

// Dependency-light WebVTT writer (Phase 1).
const vttWriter = require('./vttWriter');
const vttValidator = require('./vttValidator');
const srtValidator = require('./srtValidator');
const srtWriter = require('./srtWriter');
const { ensureUnique } = require('./whisperUtils');
// use the canonical 608 wrap from the encoder
const scc = require('../modules/sccEncoder');
const { extendedGlyphMap } = require('../modules/sccGlyphMap');
function normalizeSccChannel(value) {
  const s = String(value ?? '').trim().toUpperCase();
  const m = s.match(/^CC\s*([1-4])$/);
  const n = m ? parseInt(m[1], 10) : parseInt(s, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(4, n));
}
// Pretty DF timecodes for warnings + canonical DF predicate (centralized)
const { formatTimecode, isDropFrameRate, toMs, secondsToFrames, toFrameStart, toFrameEnd } = require('../utils/timeUtils');
const { resolveMccDualGradeEnabled, resolveMccWant708Qc, resolveMccQcProfiles } = require("../utils/mccQcUtils");
const { serializeCueV2 } = require('../utils/cueSchema');
const { addFullTimecodeMetadata } = require('./whisperFormatter');
const { shapeSegmentsForScc } = require('./sccShaper');

function writeAtomic(outPath, data, encoding = 'utf8') {
  const dir = path.dirname(outPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }

  const tempPath = `${outPath}.__temp__`;

  // Best-effort cleanup of any old temp
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  } catch {
    /* ignore */
  }

  // Single-process assumption: we just write then rename.
  //
  // Safety net: some generators (notably MCC) may return a *boxed* String
  // object (e.g., `new String('...')`) so they can attach metadata fields.
  // Newer Node/Electron runtimes can reject boxed strings in fs.writeFileSync.
  // Coerce boxed strings to primitive strings here to prevent export failures.
  if (data != null && typeof data === 'object') {
    const tag = Object.prototype.toString.call(data);
    if (data instanceof String || tag === '[object String]') {
      data = String(data);
    }
  }

  fs.writeFileSync(tempPath, data, encoding);

  // If this throws, you *don’t* end up with a half-written final file.
  renameReplaceSync(tempPath, outPath);

  return outPath;
}

function normalizeSccTextForWrite(rawSccText) {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  let s = String(rawSccText || '');

  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

  s = s.split(CR + LF).join(LF);
  s = s.split(CR).join(LF);

  let lines = s.split(LF);
  while (lines.length && !String(lines[0]).trim()) lines.shift();

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const t = String(lines[i]).trim();
    if (t.toLowerCase().startsWith('scenarist_scc')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx > 0) {
    const before = lines.slice(0, headerIdx);
    const headerLine = lines[headerIdx];
    const after = lines.slice(headerIdx + 1);
    const leadingComments = before.filter((l) => String(l).trim().startsWith('//'));
    lines = [headerLine, ...leadingComments, ...after];
  }

  while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop();
  const canonical = lines.join(LF) + LF;
  const writeText = canonical.split(LF).join(CR + LF);
  return { canonical, writeText };
}

function clampMaxLinesPerBlock(maxLinesPerBlock) {
  let clamped = Math.trunc(Number(maxLinesPerBlock));
  if (!Number.isFinite(clamped)) return maxLinesPerBlock;
  // Lead AE policy: never allow more than 3 lines per subtitle block.
  clamped = Math.max(1, Math.min(3, clamped));
  return clamped;
}

function stripLegacyTimecodeFields(segments) {
  if (!Array.isArray(segments)) return;
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    delete seg.timecodeStart;
    delete seg.timecodeEnd;
    if (Array.isArray(seg.tokens)) {
      for (const tok of seg.tokens) {
        if (!tok || typeof tok !== 'object') continue;
        delete tok.timecodeStart;
        delete tok.timecodeEnd;
        delete tok.timestamps; // string {from,to} mirror
      }
    }
  }
}

// Parse fps from values like 29.97, "29.97", or "29.97DF" and derive a DF hint
function parseFpsDf(raw, dflt = 29.97) {
  // IMPORTANT: treat null/undefined/blank as "no value".
  // Number(null) and Number('') both yield 0, which is *not* a valid FPS and
  // can incorrectly trigger DF/TC validation warnings.
  if (raw == null) return { fps: dflt, dfFromString: false };
  if (typeof raw === 'string' && raw.trim() === '') return { fps: dflt, dfFromString: false };
  if (typeof raw === 'string') {
    const m = raw.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(DF)?$/);
    if (m) {
      let fps = parseFloat(m[1]);
      const dfFromString = !!m[2];

      // Some UIs/users specify nominal DF labels like 30DF/60DF to mean 29.97/59.94.
      if (dfFromString && Number.isFinite(fps)) {
        if (Math.abs(fps - 30) < 0.06) fps = 29.97;
        if (Math.abs(fps - 60) < 0.12) fps = 59.94;
      }

      return { fps, dfFromString };
    }
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return { fps: n, dfFromString: false };
  return { fps: dflt, dfFromString: false };
}

function getFilename(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

async function writeTXT(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.txt`));
  const src = wrapped.finalWords
    ? { system: wrapped.system, segments: wrapped.finalWords.map(w => ({
        start: w.start,
        end: w.end,
        text: w.text || w.word,
        speaker: w.speaker
      })) }
    : wrapped;
  // NOTE: fpsOverride is optional. Treat null/undefined/blank as "no override".
  // (Number(null) and Number('') both yield 0, which is not a valid FPS and
  // can incorrectly trigger drop-frame warnings.)
  const overrideFps = (() => {
    const raw = config?.fpsOverride;
    if (raw == null) return null;
    if (typeof raw === 'string' && raw.trim() === '') return null;
    // Accept numeric values and legacy strings like "59.94DF".
    const { fps } = parseFpsDf(raw, NaN);
    return (Number.isFinite(fps) && fps > 0) ? fps : null;
  })();

  const resolvedFps =
    (overrideFps != null)
      ? overrideFps
      : (Number.isFinite(Number(wrapped?.system?.fps)) ? Number(wrapped.system.fps) : null);
  const requestedTimecodeStyle = config?.timecodeStyle || (config?.dropFrame ? 'df' : 'ndf');
  const wantsDropFrame = config?.dropFrame || config?.timecodeStyle === 'df';
  const safeTimecodeStyle =
    wantsDropFrame && resolvedFps != null && !isDropFrameRate(resolvedFps)
      ? 'ndf'
      : requestedTimecodeStyle;
  if (wantsDropFrame && safeTimecodeStyle === 'ndf' && resolvedFps != null) {
    console.warn(`[writeTXT] Drop-frame formatting disabled: ${resolvedFps} fps is not a supported drop-frame rate.`);
  }
  const text = generatePlainText(
    src,
    {
      ...(config.txtOptions || {}),
      startTimecodeOffset: config.txtOptions?.startTimecodeOffset ?? config.startTC,
      timecodeStyle: safeTimecodeStyle,
      fps: resolvedFps ?? src?.system?.fps
    }
  );
  return [`📝 TXT → ${writeAtomic(outPath, text, 'utf8')}`];
}

async function writeJSON(wrapped, filePath, config) {
  // Belt-and-suspenders: guarantee tri-format on segments/tokens before writing the plain JSON.
  try {
    const fps =
      (wrapped && wrapped.system && wrapped.system.fps) ??
      (typeof config?.fps === 'number' ? config.fps : Number(config?.fps));
    if (!fps) throw new Error('[writeJSON] Missing fps; expected wrapped.system.fps or config.fps');
    if (Array.isArray(wrapped?.segments)) {
      const sysPick = wrapped?.system?.timecodeRepresentations;
      const pick = sysPick
        ? sysPick
        : ((config.timecodeStyle === 'ms')
            ? { ndf: false, df: false, ms: true }
            : (config.dropFrame ? { ndf: false, df: true, ms: false }
                                : { ndf: true, df: false, ms: false }));
      const dfPref = Boolean(wrapped?.system?.dropFramePreferred ?? wrapped?.system?.dropFrame);
      addFullTimecodeMetadata(wrapped.segments, fps, dfPref, pick);
      stripLegacyTimecodeFields(wrapped.segments);
    }
  } catch (e) {
    console.warn('writeJSON: reapply timecode metadata failed:', e);
  }
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.json`));
  writeAtomic(outPath, JSON.stringify(wrapped, null, 2));
  return [`📝 JSON → ${outPath}`];
}

async function writeSRT(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.srt`));
  const segments = wrapped.finalWords
    ? wrapped.finalWords.map(w => ({
        start: w.start,
        end: w.end,
        text: w.text || w.word,
        speaker: w.speaker
      }))
    : wrapped.segments;
  const maxLinesPerBlock = clampMaxLinesPerBlock(config?.maxLinesPerBlock);
  const genSrt = (srtWriter && typeof srtWriter.generateSRT === 'function')
    ? srtWriter.generateSRT
    : null;
  if (!genSrt) {
    throw new Error('SRT export failed: SRT writer unavailable');
  }

  const srt = genSrt(segments, {
    ...config,
    maxLinesPerBlock
  });
  writeAtomic(outPath, srt, 'utf8');

  const logs = [`📼 SRT → ${outPath}`];

  // Phase 8: SRT QC sidecars (parity with VTT/SCC/MCC).
  // This validates the *written* SRT so QC reflects post-shaping/retiming output.
  const qc = writeSrtQcArtifacts({ srtText: srt, outPath, config, srcLabel: filePath });
  if (qc && qc.report) {
    const errs = Array.isArray(qc.report.errors) ? qc.report.errors.length : 0;
    const warns = Array.isArray(qc.report.warnings) ? qc.report.warnings.length : 0;
    const worstCps = (qc.report.stats && Number.isFinite(qc.report.stats.worstCps)) ? qc.report.stats.worstCps : 0;
    logs.push(`🧪 SRT QC → ${qc.txtPath}`);
    logs.push(`🧪 SRT QC: ${errs} error(s), ${warns} warning(s) • worstCPS=${worstCps.toFixed(2)}`);
  }

  return logs;
}

function shouldWriteSrtQc(config = {}) {
  const fmt = (config && config.formats && config.formats.srt && typeof config.formats.srt === 'object')
    ? config.formats.srt
    : {};
  const legacy = (config && config.srtOptions && typeof config.srtOptions === 'object')
    ? config.srtOptions
    : {};
  const raw = fmt.writeQcReport ?? fmt.qcReport ?? legacy.writeQcReport ?? legacy.qcReport ?? config.writeSrtQcReport ?? config.srtQcReport;
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (!s) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return true;
}

function shouldGateOnSrtQcErrors(config = {}) {
  const fmt = (config && config.formats && config.formats.srt && typeof config.formats.srt === 'object')
    ? config.formats.srt
    : {};
  const legacy = (config && config.srtOptions && typeof config.srtOptions === 'object')
    ? config.srtOptions
    : {};
  const raw = fmt.gateOnQcErrors ?? legacy.gateOnQcErrors ?? config.srtGateOnQcErrors;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function writeSrtQcArtifacts({ srtText, outPath, config = {}, srcLabel = '' }) {
  if (!outPath) return null;
  if (!shouldWriteSrtQc(config)) return null;

  const report = srtValidator.validateSRT(srtText, config, { outPath, srcLabel });
  const jsonPath = `${outPath}.qc.json`;
  const txtPath = `${outPath}.qc.txt`;

  try {
    writeAtomic(jsonPath, JSON.stringify(report, null, 2) + os.EOL, 'utf8');
  } catch {
    // Non-fatal; primary deliverable should still succeed.
  }
  try {
    writeAtomic(txtPath, srtValidator.formatSrtQcReportText(report), 'utf8');
  } catch {
    // Non-fatal.
  }

  // Optional strict gating (off by default).
  if (shouldGateOnSrtQcErrors(config) && Array.isArray(report.errors) && report.errors.length) {
    const first = report.errors[0];
    const msg = first && first.message ? String(first.message) : 'SRT QC errors present';
    const err = new Error(`SRT QC gate failed: ${report.errors.length} error(s). First: ${msg}`);
    err.qcReport = report;
    err.qcReportPath = txtPath;
    throw err;
  }

  return { report, jsonPath, txtPath };
}


function shouldWriteVttQc(config = {}) {
  const fmt = (config && config.formats && config.formats.vtt && typeof config.formats.vtt === 'object')
    ? config.formats.vtt
    : {};
  const legacy = (config && config.vttOptions && typeof config.vttOptions === 'object')
    ? config.vttOptions
    : {};
  const raw = fmt.writeQcReport ?? fmt.qcReport ?? legacy.writeQcReport ?? legacy.qcReport ?? config.writeVttQcReport ?? config.vttQcReport;
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (!s) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return true;
}

function shouldGateOnVttQcErrors(config = {}) {
  const fmt = (config && config.formats && config.formats.vtt && typeof config.formats.vtt === 'object')
    ? config.formats.vtt
    : {};
  const legacy = (config && config.vttOptions && typeof config.vttOptions === 'object')
    ? config.vttOptions
    : {};
  const raw = fmt.gateOnQcErrors ?? legacy.gateOnQcErrors ?? config.vttGateOnQcErrors;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function writeVttQcArtifacts({ vttText, outPath, config = {}, srcLabel = '' }) {
  if (!outPath) return null;
  if (!shouldWriteVttQc(config)) return null;

  const report = vttValidator.validateVTT(vttText, config, { outPath, srcLabel });
  const jsonPath = `${outPath}.qc.json`;
  const txtPath = `${outPath}.qc.txt`;

  try {
    writeAtomic(jsonPath, JSON.stringify(report, null, 2) + os.EOL, 'utf8');
  } catch {
    // Keep non-fatal; export of the primary deliverable should still succeed.
  }
  try {
    writeAtomic(txtPath, vttValidator.formatVttQcReportText(report), 'utf8');
  } catch {
    // non-fatal
  }

  // Optional strict gating (off by default).
  if (shouldGateOnVttQcErrors(config) && Array.isArray(report.errors) && report.errors.length) {
    const first = report.errors[0];
    const msg = first && first.message ? String(first.message) : 'VTT QC errors present';
    const err = new Error(`VTT QC gate failed: ${report.errors.length} error(s). First: ${msg}`);
    err.qcReport = report;
    err.qcReportPath = txtPath;
    throw err;
  }

  return { report, jsonPath, txtPath };
}

async function writeVTT(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.vtt`));
  const segments = wrapped.finalWords
    ? wrapped.finalWords.map(w => ({
        start: w.start,
        end: w.end,
        text: w.text || w.word,
        speaker: w.speaker
      }))
    : wrapped.segments;

  const vtt = vttWriter.generateVTT(segments, config);
  writeAtomic(outPath, vtt, 'utf8');

  const logs = [`🌐 VTT → ${outPath}`];

  const qc = writeVttQcArtifacts({ vttText: vtt, outPath, config, srcLabel: filePath });
  if (qc && qc.report) {
    const errs = Array.isArray(qc.report.errors) ? qc.report.errors.length : 0;
    const warns = Array.isArray(qc.report.warnings) ? qc.report.warnings.length : 0;
    const worstCps = (qc.report.stats && Number.isFinite(qc.report.stats.worstCps)) ? qc.report.stats.worstCps : 0;
    logs.push(`🧪 VTT QC → ${qc.txtPath}`);
    logs.push(`🧪 VTT QC: ${errs} error(s), ${warns} warning(s) • worstCPS=${worstCps.toFixed(2)}`);
  }

  return logs;
}

// ── NEW: SCC writer ─────────────────────────────────────────────────────────

function normalizeMusicGlyphLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return line;
  const up = raw.toUpperCase();
  // Only treat whole-line tokens as music icons.
  if (up === '[MUSIC]' || up === '[MUSIC ONLY]' || up === '[MUSIC INTRO]' || up === '[MUSIC OUT]') {
    return '♪';
  }
  return line;
}

async function writeSCC(wrapped, filePath, config) {
  const base = getFilename(filePath);
  const outPath = ensureUnique(path.join(config.outputPath, `${base}.scc`));

  const raw = wrapped?.system?.fps ?? config?.fpsOverride ?? config?.fps ?? 29.97;
  const { fps, dfFromString } = parseFpsDf(raw, 29.97);
  // SCC supports both 29.97 DF (';') and 29.97 NDF (':').
  // We keep DF as the default, and only allow NDF when explicitly enabled.
  const is2997 = Math.abs(Number(fps) - 29.97) <= 0.02;
  const dfCapable = isDropFrameRate(fps);
  const allowNdf = Boolean(config?.sccOptions?.allowNdf);

  const dropPref = config?.dropFrame ?? wrapped?.system?.dropFramePreferred ?? wrapped?.system?.dropFrame ?? dfFromString;
  const wantsDf = (dropPref === true) || (dropPref == null); // default DF
  const dropFrame = dfCapable && wantsDf;

  const dfOk = is2997 && dropFrame === true;
  const ndfOk = is2997 && dropFrame === false && allowNdf;
  if (!dfOk && !ndfOk) {
    if (!is2997) {
      throw new Error(`SCC timebase guard: writer requires 29.97; got fps=${fps}`);
    }
    if (dropFrame === false && !allowNdf) {
      throw new Error('SCC NDF guard: export of ":" timecodes is disabled. Enable sccOptions.allowNdf to export NDF SCC.');
    }
    throw new Error(`SCC timing guard: writer requires 29.97 DF (;) or (opt-in) 29.97 NDF (:); got dropFrame=${dropFrame}`);
  }

  // Encoder understands 'auto' | 'start' | 'ms' | 'df-string'; default to 'auto'.
  const timeSource = config?.sccOptions?.timeSource ?? 'auto';

  // SCC start timecode offset (e.g. 01:00:00;00).
  // This is the program-time origin used when captions are generated from 0-based segment timings.
  const startTc =
    config?.sccOptions?.startTc ||
    config?.sccOptions?.startTC ||
    config?.startTC ||
    config?.startTc ||
    null;

  // Optional post-production slip/offset applied to all SCC cue times.
  const sccTimecodeOffset = config?.sccOptions?.timecodeOffset ?? config?.sccOptions?.captionOffset ?? config?.sccOptions?.offset ?? null;

  // SCC must NOT accidentally inherit SRT/VTT subtitle constraints in multi-output jobs.
  // Prefer format-scoped SCC settings; fall back to legacy top-level config for backward compatibility.
  const uiMax = Number(
    config?.sccOptions?.maxCharsPerLine ??
    config?.maxCharsPerLine ??
    28
  );
  // Cap at the 608 hard limit.
  const per608Max = Math.min(32, Number.isFinite(uiMax) ? uiMax : 28);

  const safeLeft = (() => {
    const v = Number(config?.sccOptions?.safeMargins?.left);
    return Number.isFinite(v) ? Math.max(0, Math.min(31, Math.floor(v))) : 0;
  })();
  const safeRight = (() => {
    const v = Number(config?.sccOptions?.safeMargins?.right);
    return Number.isFinite(v) ? Math.max(0, Math.min(31, Math.floor(v))) : 0;
  })();
  const safeWidth = Math.max(1, 32 - safeLeft - safeRight);

  const effectiveMax = Math.min(per608Max, safeWidth);

  // SCC: hard 1–2 lines per pop-on block for broadcast sanity
  // Prefer SCC-scoped values; fall back to legacy top-level config.
  const rawLines = Number(
    config?.sccOptions?.maxLinesPerBlock ??
    config?.maxLinesPerBlock ??
    2
  );
  const maxLinesPerBlock = Math.max(1, Math.min(2, rawLines));

  // Use the SCC "Max subtitle duration" slider as the primary limit.
  // Prefer SCC-scoped values; fall back to legacy top-level config and then sccOptions.timing.maxBlockSec.
  const maxBlockSec = (() => {
    const ui = Number(config?.sccOptions?.maxDurationSeconds ?? config?.maxDurationSeconds);
    if (Number.isFinite(ui) && ui > 0) return ui;
    const opt = Number(config?.sccOptions?.timing?.maxBlockSec);
    return Number.isFinite(opt) && opt > 0 ? opt : 6;
  })();

  // Content QC config (also used by the shaping pass).
  const qcCfg = (config && config.sccOptions && config.sccOptions.qc) ? config.sccOptions.qc : {};
  // SCC speaker labels are a separate opt-in for QC safety.
  const includeSpeakerNamesScc = Boolean(config?.sccOptions?.includeSpeakerNames);

  // If enabled, bake speaker labels into the text here and disable encoder auto-prefixing.
  // This avoids placement/wrapping mismatches when we pre-wrap for row/col tags below.
  const segsOriginal = Array.isArray(wrapped?.segments) ? wrapped.segments : [];
  const segs608Base = includeSpeakerNamesScc
    ? segsOriginal.map(seg => {
        if (!seg) return seg;
        const sp = String(seg.speaker || '').trim();
        if (!sp) return seg;
        const prefix = `${sp}: `;
        const base = String(seg.text || '');
        return base.startsWith(prefix) ? seg : { ...seg, text: `${prefix}${base}` };
      })
    : segsOriginal;

  // Start-TC transmit policy:
  //  - preStartTransmitSec=0 means "no SCC lines before Start TC" (clamp).
  //  - preStartTransmitSec>0 allows a small pre-roll before Start TC.
  const preStartTransmitSec = (() => {
    const v = Number(config?.sccOptions?.preStartTransmitSec);
    return Number.isFinite(v) && v > 0 ? v : 0;
  })();

  // Optional shaping: improves first-pass deliverable quality by merging micro-cues,
  // enforcing min duration/gap, and reducing CPS/WPM via retiming/splitting.
  // IMPORTANT: we only shape the SCC writer’s segment copy; SRT/VTT outputs remain untouched.
  let segs608 = segs608Base;
  let shaping = null;
  try {
    const shapeCfg = config?.sccOptions?.shaping;
    if (shapeCfg && shapeCfg.enabled !== false) {
      const res = shapeSegmentsForScc(segs608Base, {
        fps,
        dropFrame,
        startTc,
        preStartTransmitSec,
        sccOptions: (config && config.sccOptions && typeof config.sccOptions === 'object') ? config.sccOptions : {},
        channel: normalizeSccChannel(config?.sccOptions?.channel),
        maxCharsPerLine: effectiveMax,
        maxLinesPerBlock,
        // Hard cap so shaping can’t extend beyond the actual source runtime.
        // Prefer video durationSeconds when available; fall back to the last cue end.
        maxEndSec: (() => {
          const v = Number(wrapped?.metadata?.durationSeconds);
          if (Number.isFinite(v) && v > 0) return v;
          const last = (Array.isArray(segs608Base) && segs608Base.length)
            ? (Number.isFinite(Number(segs608Base[segs608Base.length - 1].end))
              ? Number(segs608Base[segs608Base.length - 1].end)
              : ((Number(segs608Base[segs608Base.length - 1].msEnd) || 0) / 1000))
            : NaN;
          return (Number.isFinite(last) && last > 0) ? last : undefined;
        })(),
        preserveSpeakerBoundaries: true,
        clampToMaxEnd: true,
        maxDurationSec: maxBlockSec,
        qc: {
          maxCps: qcCfg.maxCps,
          maxWpm: qcCfg.maxWpm,
          minDurationSec: qcCfg.minDurationSec,
          minGapSec: qcCfg.minGapSec
        },
        mode: shapeCfg.mode || 'conservative',
        microCueSec: shapeCfg.microCueSec,
        microGapSec: shapeCfg.microGapSec,
        maxShiftSec: shapeCfg.maxShiftSec,
        fixStartTcClamp: shapeCfg.fixStartTcClamp !== false
      });
      if (res && Array.isArray(res.segments) && res.segments.length) {
        segs608 = res.segments;
        shaping = res.report || null;
      }
    }
  } catch (e) {
    // Shaping must never prevent SCC export. Treat failures as warnings.
    shaping = { ok: false, error: e?.message || String(e) };
    segs608 = segs608Base;
  }
  const placements = [];
  const wrappedLines = [];
  const wrapErrors = [];

  // Export policy:
  //  - warn: write SCC, never fail job (warnings only)
  //  - gate_write: write SCC + report, then fail job on QC
  //  - gate_block: if QC fails, do NOT write SCC (report only), and fail job
  const exportPolicy = (() => {
    const raw = String(config?.sccOptions?.exportPolicy || '').trim().toLowerCase();
    if (raw === 'gate_block' || raw === 'block' || raw === 'strict') return 'gate_block';
    if (raw === 'gate_write' || raw === 'gate') return 'gate_write';
    if (raw === 'warn' || raw === 'normal' || raw === 'off') return 'warn';
    return null;
  })();
  const isDeliverableMode = (exportPolicy === 'gate_write' || exportPolicy === 'gate_block');

  // Draft salvage behavior: default ON for transcription workflows.
  // In strict deliverable workflows you still often want a file to edit, even when failing QC gate.
  const allowDraft = config?.sccOptions?.draft !== false;

  // Requested overflow policy (strict) + safe fallback (draft).
  // Encoder defaults to 'error' unless explicitly told otherwise; we preserve that,
  // but we never allow it to block file creation in draft mode.
  const overflowRequested = (() => {
    const raw = isDeliverableMode ? 'error' : ((config?.sccOptions?.overflowPolicy) ?? 'error');
    const v = String(raw || '').trim().toLowerCase();
    return v || 'error';
  })();
  const overflowFallback = (() => {
    const raw = (config?.sccOptions?.fallbackOverflowPolicy) ?? 'truncate';
    const v = String(raw || '').trim().toLowerCase();
    // Never allow 'error' as the fallback; that defeats the workflow requirement.
    return (v && v !== 'error') ? v : 'truncate';
  })();

  // Pre-wrap every cue so we can:
  //  1) guarantee a file is produced (draft fallback when strict wrap fails)
  //  2) keep placement+wrapping deterministic between UI/editor and encoder
  //
  // IMPORTANT: preserve explicit user line breaks and {row}/{col} tags during pre-wrap.
  // wrapTextAndClamp() normalizes whitespace, which would otherwise destroy manual "\n" formatting.
  const _pullPlacementTagsInline = (line) => {
    let s = String(line || '');
    let row = null;
    let col = null;
    const re = /^\{\s*(row|col)\s*:\s*([0-9]{1,2})\s*\}\s*/i;
    while (true) {
      const m = re.exec(s);
      if (!m) break;
      const key = String(m[1] || '').toLowerCase();
      const num = Number(m[2]);
      if (key === 'row' && Number.isFinite(num)) row = num;
      if (key === 'col' && Number.isFinite(num)) col = num;
      s = s.slice(m[0].length);
    }
    return { text: s, row, col };
  };

  const _prewrapSccLines = (srcText, overflowPolicy, cueIndex) => {
    const raw = String(srcText || '').replace(/\r\n?/g, '\n');
    const hasExplicit = raw.includes('\n') || /\{\s*(row|col)\s*:\s*\d+\s*\}/i.test(raw);

    if (!hasExplicit) {
      return scc.wrapTextAndClamp(
        raw,
        effectiveMax,
        maxLinesPerBlock,
        { overflowPolicy, cueIndex }
      );
    }

    const outLines = [];
    const rawLines = raw.split('\n');
    for (const ln of rawLines) {
      const normalized = String(ln || '').replace(/\s+/g, ' ').trim();
      if (!normalized) continue;

      const pulled = _pullPlacementTagsInline(normalized);
      const clamped = scc.wrapTextAndClamp(
        pulled.text,
        effectiveMax,
        1,
        { overflowPolicy, cueIndex }
      );
      const body = Array.isArray(clamped) ? String(clamped[0] || '') : String(clamped || '');
      if (!body) continue;

      const rowTag = Number.isFinite(pulled.row) ? `{row:${pulled.row}}` : '';
      const colTag = Number.isFinite(pulled.col) ? `{col:${pulled.col}}` : '';
      outLines.push(`${rowTag}${colTag}${body}`);
    }

    if (outLines.length > maxLinesPerBlock) {
      if (String(overflowPolicy || '').toLowerCase() === 'error') {
        throw new Error(`Cue ${cueIndex} exceeds ${maxLinesPerBlock} lines at ${effectiveMax} cols (explicit line breaks).`);
      }
      return outLines.slice(0, maxLinesPerBlock);
    }

    return outLines.length ? outLines : [''];
  };

  // Default placement (Transcribe panel): allow a global fixed window anchor in the CEA-608 grid.
  // We implement this by injecting {row:}{col:} tags (per line) when no per-cue placement exists.
  // If a line already contains explicit placement tags, we leave it alone.
  const _canonPlacementMode = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (s === 'custom' || s === 'manual' || s === 'fixed') return 'custom';
    return 'auto';
  };

  const _lineHasSccPlacementTags = (line) => /\{\s*(row|col|pac)\s*:/i.test(String(line || ''));

  const _visible608Len = (text) => {
    let t = String(text || '');
    // Strip HTML and placement tags that don't consume 608 character cells.
    t = t.replace(/<[^>]+>/g, '');
    t = t.replace(/\{\s*(row|col|pac)\s*:\s*[^}]+\}\s*/gi, '');
    t = t.replace(/\{\s*NOP\s*\}\s*/gi, '');

    // Mid-row 608 formatting tags occupy a character cell (they emit a space).
    t = t.replace(/\{(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g, ' ');

    // Drop any other SCC-style tokens.
    t = t.replace(/\{[^}]+\}/g, '');

    return t.length;
  };

  const placementMode = _canonPlacementMode(config?.sccOptions?.placementMode);
  const useCustomPlacement = (placementMode === 'custom');

  const placementBottomRow = (() => {
    const n = Number(config?.sccOptions?.placementBottomRow);
    return Number.isFinite(n) ? Math.max(1, Math.min(15, Math.trunc(n))) : 15;
  })();

  const placementLeftCol = (() => {
    const n = Number(config?.sccOptions?.placementLeftCol);
    return Number.isFinite(n) ? Math.max(0, Math.min(31, Math.trunc(n))) : safeLeft;
  })();

  const _buildDefaultSccPlacement = (lines) => {
    if (!useCustomPlacement) return null;
    if (!Array.isArray(lines) || !lines.length) return null;

    const lineCount = Math.min(lines.length, maxLinesPerBlock);

    // Clamp the requested window left edge so the full window (effectiveMax cols wide)
    // stays inside the safe margins.
    const maxLeft = Math.max(safeLeft, 32 - safeRight - effectiveMax);
    const leftCol = Math.max(safeLeft, Math.min(maxLeft, placementLeftCol));

    const bottomRow = Math.max(lineCount, Math.min(15, placementBottomRow));
    const topRow = Math.max(1, bottomRow - lineCount + 1);

    const alignRaw = String(config?.sccOptions?.alignment || 'left').trim().toLowerCase();
    const align = (alignRaw === 'centre') ? 'center' : alignRaw;

    const out = [];
    for (let li = 0; li < lineCount; li++) {
      const line = lines[li] ?? '';
      if (_lineHasSccPlacementTags(line)) {
        out.push(null);
        continue;
      }

      const row = topRow + li;
      const vLen = Math.max(0, _visible608Len(line));

      // Start column is clamped to [safeLeft, 31] and also to avoid overflow.
      const minStart = safeLeft;
      const maxStart = Math.min(31, 32 - safeRight - vLen);

      let col = leftCol;
      if (align === 'center') col = leftCol + Math.floor(Math.max(0, effectiveMax - vLen) / 2);
      else if (align === 'right') col = leftCol + Math.max(0, effectiveMax - vLen);

      col = Math.max(minStart, Math.min(maxStart, col));
      out.push({ row, col });
    }

    return out;
  };

  segs608.forEach((seg, i) => {
    const srcText = String(seg?.text || '');
    const cueIndex = i + 1;
    let lines;
    try {
      lines = _prewrapSccLines(srcText, overflowRequested, cueIndex);
    } catch (err) {
      const msg = err?.message || String(err);
      wrapErrors.push({ cue: cueIndex, message: msg });

      if (!allowDraft) throw err;

      // Draft fallback: still produce SCC so the user can edit/fix.
      lines = _prewrapSccLines(srcText, overflowFallback, cueIndex);
    }
    wrappedLines[i] = Array.isArray(lines) ? lines : [srcText];
    placements[i] = seg?.sccPlacement ? seg.sccPlacement : null;

    if (!placements[i] && useCustomPlacement) {
      placements[i] = _buildDefaultSccPlacement(wrappedLines[i]);
    }
  });

  const segsForScc = segs608.map((seg, i) => {
    if (!seg) return seg;

    const p = placements[i];
    const lines = Array.isArray(wrappedLines[i]) && wrappedLines[i].length
      ? wrappedLines[i]
      : [String(seg?.text || '')];

    // Always feed the encoder explicit, pre-wrapped lines. This prevents the encoder
    // from re-wrapping raw text and throwing in strict mode before we can write a file.
    if (!p) {
      const body = lines.map(normalizeMusicGlyphLine).join('\n');
      return body === String(seg.text || '') ? seg : { ...seg, text: body };
    }

    const withTags = lines.map((line, li) => {
      const pl = p[li] || {};
      const rowTag = Number.isFinite(pl.row) ? `{row:${pl.row}}` : '';
      const colTag = Number.isFinite(pl.col) ? `{col:${pl.col}}` : '';
      const body = normalizeMusicGlyphLine(line);
      return `${rowTag}${colTag}${body}`;
    }).join('\n');

    return { ...seg, text: withTags };
  });

  const getColumnStart =
    (config?.sccOptions && typeof config.sccOptions.getColumnStart === 'function')
      ? config.sccOptions.getColumnStart
      : null;

  // UI passes Prefix SCC words as either an array of 4-hex SCC words or a free-text string
  // (e.g. "9420 94ae"). The encoder expects an array.
  const normalizePrefixWords = (value) => {
    if (Array.isArray(value)) {
      const out = value.map(v => String(v || '').trim()).filter(Boolean);
      return out.length ? out : null;
    }
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const toks = raw
      .split(/[\s,]+/g)
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => t.replace(/^0x/i, ''))
      .filter(t => /^[0-9A-Fa-f]{4}$/.test(t))
      .map(t => t.toUpperCase());
    return toks.length ? toks : null;
  };
  // Generate SCC (strict first; draft fallback if strict wrap/encode fails).
  const strictEncodingRequested = isDeliverableMode ? true : (config?.sccOptions?.strictCharacterEncoding === true);

  const encoderAttempts = [];
  let usedEncoder = { pass: 'primary', overflowPolicy: overflowRequested, strictCharacterEncoding: strictEncodingRequested };
  let sccRes = null;

  const genAttempts = [
    { pass: 'primary', overflowPolicy: overflowRequested, strictCharacterEncoding: strictEncodingRequested }
  ];
  if (allowDraft && (overflowFallback !== overflowRequested || strictEncodingRequested)) {
    genAttempts.push({ pass: 'draft', overflowPolicy: overflowFallback, strictCharacterEncoding: false });
  }

  const makeGenOpts = (attempt) => ({
    fps,
    dropFrame,
    startTc,
    maxCharsPerLine: effectiveMax,
    maxLinesPerBlock,
    // Speaker labels (if enabled) were baked into seg text above.
    includeSpeakerNames: false,
    sccOptions: {
      mode:      'pop-on',
      alignment: (config?.sccOptions?.alignment) ?? 'left',           // hard-left
      channel:   normalizeSccChannel(config?.sccOptions?.channel),
      rowPolicy: (config?.sccOptions?.rowPolicy) ?? 'bottom2',        // rows 14–15
      safeMargins: { left: safeLeft, right: safeRight },
      padEven:   config?.sccOptions?.padEven === true,
      extendedGlyphMap,
      overflowPolicy: attempt.overflowPolicy,
      // NDF SCC export is opt-in and must be explicitly enabled.
      allowNdf,
      strictCharacterEncoding: attempt.strictCharacterEncoding,
      preStartTransmitSec,
      // Match encoder's "redundancy ON by default" unless explicitly disabled
      repeatControlCodes:  isDeliverableMode ? true : (config?.sccOptions?.repeatControlCodes !== false),
      repeatPreambleCodes: isDeliverableMode ? true : (config?.sccOptions?.repeatPreambleCodes !== false),
      getColumnStart,
      // new plumbed options
      timeSource,
      // Start TC offset for SCC exports (HH:MM:SS;FF or HH:MM:SS:FF)
      startTc,
      timecodeOffset: sccTimecodeOffset,
      appendEOFAt: (config?.sccOptions?.appendEOFAt) ?? 'afterLast',
      eofOp:       (config?.sccOptions?.eofOp)       ?? 'edm',
      // NEW:
      stripLeadingDashes: Boolean(config?.sccOptions?.stripLeadingDashes),
      // Phase 1: wire existing UI options into the encoder.
      startResetAt: (config?.sccOptions?.startResetAt ?? 'auto'),
      startResetOp: (config?.sccOptions?.startResetOp ?? 'edm'),
      prefixWords: normalizePrefixWords(config?.sccOptions?.prefixWords)
    },
    returnStats: true
  });

  for (const attempt of genAttempts) {
    try {
      sccRes = scc.generateSCC(segsForScc, makeGenOpts(attempt));
      usedEncoder = attempt;
      break;
    } catch (e) {
      encoderAttempts.push({
        pass: attempt.pass,
        overflowPolicy: attempt.overflowPolicy,
        strictCharacterEncoding: attempt.strictCharacterEncoding,
        message: e?.message || String(e)
      });
    }
  }

  if (!sccRes) {
    const last = encoderAttempts[encoderAttempts.length - 1];
    throw new Error(last?.message || 'SCC generation failed');
  }

  let sccText = (sccRes && typeof sccRes === 'object' && 'scc' in sccRes) ? sccRes.scc : sccRes;
  const stats   = (sccRes && typeof sccRes === 'object' && sccRes.stats) ? sccRes.stats : {};
  if (stats && shaping) stats.shaping = shaping;
  // Belt‑and‑suspenders: ensure header is the first line in case a future change adds preface text.
  sccText = sccText.replace(/^\uFEFF/, '');
  const _lines = sccText.replace(/\r/g,'').split('\n');
  const _hdrIdx = _lines.findIndex(l => /^Scenarist_SCC\b/i.test(l.trim()));
  if (_hdrIdx > 0) {
    const pre = _lines.slice(0, _hdrIdx).filter(l => l.trim().startsWith('//'));
    sccText = [_lines[_hdrIdx], ...pre, ..._lines.slice(_hdrIdx + 1)]
      .join('\n').replace(/\n+$/, '') + '\n';
  }
  // SCC is traditionally CRLF-delimited; some broadcast/QC pipelines are picky.
  const sccWriteText = sccText.replace(/\r?\n/g, '\r\n');
  const notes = [];

  // ── Timing validation (Phase 2 — I) ───────────────────────────────────────
  const timing = validateTiming(segs608, { fps, dropFrame, maxBlockSec });
  if (stats) stats.timingWarnings = timing;
  if (timing.longBlocks.length) {
    console.warn(
      `⚠️ ${timing.longBlocks.length} caption block(s) exceed ${maxBlockSec}s —`,
      timing.longBlocks.slice(0, 3)
        .map(w => `${w.startTc}–${w.endTc} (${w.durationSec}s)`).join(' • ')
    );
  }
  if (timing.overlaps.length) {
    console.warn(
      `⚠️ ${timing.overlaps.length} overlap(s) detected —`,
      timing.overlaps.slice(0, 3)
        .map(w => `${w.endTc} > ${w.nextStartTc} (+${w.overlapMs}ms)`).join(' • ')
    );
  }

  // ── Content-level QC (Phase D) ────────────────────────────────────────────
  // Broadcast QC cares about *readability* and *timing*, not just file structure.
  // We compute CPS/WPM, minimum duration/gap, and late-EOC thresholds.
  const contentQc = validateSccContentQc(segsForScc, {
    fps,
    dropFrame,
    startTc,
    sccText,
    maxCharsPerLine: effectiveMax,
    maxLinesPerBlock,
    safeMargins: { left: safeLeft, right: safeRight },
    // Thresholds (defaults are pragmatic; override via config.sccOptions.qc.*)
    maxCps: qcCfg.maxCps,
    maxWpm: qcCfg.maxWpm,
    minDurationSec: qcCfg.minDurationSec,
    maxDurationSec: maxBlockSec,
    minGapSec: qcCfg.minGapSec,
    maxLateEocSec: qcCfg.maxLateEocSec,
    maxLateEocCount: qcCfg.maxLateEocCount,
    // Encoder-derived late EOC stats (when available)
    lateEocCount: Number(stats?.lateEocCount ?? 0),
    maxLateEocSecObserved: Number(stats?.maxLateEocSec ?? 0),
    // Unshowable cue stats (when available)
    unshowableCueCount: Number(stats?.unshowableCueCount ?? 0),
    maxUnshowableLateSecObserved: Number(stats?.maxUnshowableLateSec ?? 0)
  });
  if (stats) stats.contentQc = contentQc;

  // ── QC sidecar (report) including chosen row policy ────────────────────────
  // QC report mirrors actual writer settings
  const chan   = normalizeSccChannel(config?.sccOptions?.channel);
  const align  = (config?.sccOptions?.alignment) ?? 'left';
  const policy = (config?.sccOptions?.rowPolicy) ?? 'bottom2';
  const policyLabel = policy === '13-14' ? 'rows 13–14'
    : policy === '12-13' ? 'rows 12–13'
      : 'rows 14–15';
  const timeAnchor = timeSource;
  const language = config?.language || wrapped?.system?.language || 'en';

  let paritySummary = '';
  let rep;
  try {
    if (typeof scc.verifySCC === 'function') {
      rep = scc.verifySCC(sccText, { fps, dropFrame });
      paritySummary = rep?.summary || '';
    }
  } catch (e) {
    paritySummary = `Verifier error: ${e.message}`;
  }

  const reportPath = ensureUnique(path.join(config.outputPath, `${base}.scc.report.txt`));
  const lastSegment = segs608.length ? segs608[segs608.length - 1] : null;
  const durationSec = Number(wrapped?.metadata?.durationSeconds ?? lastSegment?.end ?? 0) || 0;
  const totalFrames = Math.max(0, secondsToFrames(durationSec, fps, 'ceil'));
  const maxChars    = effectiveMax;  // reflect the writer’s actual width
  const maxLines    = maxLinesPerBlock;

  // ── SCC transmit clamp annotation ─────────────────────────────────────────
  // Encoder-side clamp (when implemented) ensures no SCC lines are emitted earlier
  // than Start TC. We annotate the intent here so QC has explicit documentation.
  const transmitClampEnabled = !!(startTc && String(startTc).trim());
  const transmitClampLabel = !transmitClampEnabled
    ? 'OFF'
    : (preStartTransmitSec > 0
        ? `ON (allows up to ${preStartTransmitSec}s pre-roll before Start TC)`
        : 'ON (no SCC earlier than Start TC)');

  // Capture encoder warnings when returnStats is enabled (e.g. clamp warnings).
  const encoderWarnings = Array.isArray(stats?.warnings) ? stats.warnings.filter(Boolean) : [];
  const isClampWarning = (w) =>
    /pre[- ]transmit/i.test(String(w)) || /clamp/i.test(String(w));
  const clampWarnings = encoderWarnings.filter(isClampWarning);
  const otherEncoderWarnings = encoderWarnings.filter(w => !isClampWarning(w));

  // Keep reports readable but never “hide” counts.
  const maxWarnLines = 50;
  const warnList = otherEncoderWarnings.slice(0, maxWarnLines).map(w => `  - ${String(w)}`);
  const clampList = clampWarnings.slice(0, maxWarnLines).map(w => `  - ${String(w)}`);

  const strictEncoding = strictEncodingRequested === true;
  const startResetLabel = String(config?.sccOptions?.startResetAt || 'auto');
  const startResetOpLabel = config?.sccOptions?.startResetOp ? ` (${String(config.sccOptions.startResetOp).toUpperCase()})` : '';

  const shapingLines = (() => {
    if (!config?.sccOptions?.shaping || config.sccOptions.shaping.enabled === false) {
      return ['Auto-shape: OFF'];
    }
    const lines = [];
    lines.push(`Auto-shape: ON (${String(config.sccOptions.shaping.mode || 'conservative')})`);
    if (shaping?.ok === false) {
      lines.push(`  - Status: ERROR (ignored) — ${shaping.error}`);
      return lines;
    }
    const s = shaping?.summary || shaping || {};
    if (Number.isFinite(s.changedCues)) lines.push(`  - Changed cues: ${s.changedCues}`);
    if (Number.isFinite(s.mergedCues)) lines.push(`  - Merged cues: ${s.mergedCues}`);
    if (Number.isFinite(s.splitCues))  lines.push(`  - Split cues: ${s.splitCues}`);
    if (Number.isFinite(s.retimedCues)) lines.push(`  - Retimed cues: ${s.retimedCues}`);
    if (Number.isFinite(s.firstCueDelayedSec) && s.firstCueDelayedSec > 0) {
      lines.push(`  - First cue delayed: ${Number(s.firstCueDelayedSec).toFixed(3)}s (Start TC clamp)`);
    }
    return lines;
  })();

  const fmtQcRange = (it) => {
    if (it && it.endTc && it.nextStartTc) return `${it.endTc}–${it.nextStartTc}`;
    if (it && it.startTc && it.endTc) return `${it.startTc}–${it.endTc}`;
    if (it && it.startTc) return String(it.startTc);
    return '';
  };
  const qcFailuresLines = (Array.isArray(contentQc?.failures) ? contentQc.failures : [])
    .map(f => `  > ${f.type} ${fmtQcRange(f)} ${f.message}`.trim());
  const qcWarningsLines = (Array.isArray(contentQc?.warnings) ? contentQc.warnings : [])
    .map(w => `  - ${w.type} ${fmtQcRange(w)} ${w.message}`.trim());

  const prefixWords = normalizePrefixWords(config?.sccOptions?.prefixWords);
  const prefixWordsLabel = prefixWords ? prefixWords.join(' ') : 'OFF';

  const report = [
    'SCC QC REPORT',
    `File: ${outPath}`,
    `Start TC offset: ${startTc || '(none)'}`,
    `Transmit clamp: ${transmitClampLabel}`,
    `Strict encoding: ${strictEncoding ? 'ON (fail on unsupported glyphs)' : 'OFF (replace unsupported glyphs + warn)'}`,
    `Start reset: ${startResetLabel}${startResetOpLabel}`,
    `Prefix words: ${prefixWordsLabel}`,
    `Channel: CC${chan}`,
    `Row policy: ${policy} (${policyLabel})`,
    `Alignment: ${align}`,
    `Safe margins: L${safeLeft} / R${safeRight} (usable width ${maxChars})`,
    `Timing anchor: ${timeAnchor}`,
    `Language: ${language}`,
    '',
    '--- Auto-shape ---',
    ...shapingLines,
    '',
    '--- Draft/Fallback ---',
    `Pre-wrap overflow errors: ${wrapErrors.length}`,
    ...(wrapErrors.length
      ? wrapErrors.slice(0, 10).map(w => `  > Cue ${w.cue}: ${w.message}`)
      : ['  (none)']),
    `Encoder pass used: ${usedEncoder?.pass || 'unknown'} (overflowPolicy=${usedEncoder?.overflowPolicy || 'n/a'}, strictEncoding=${usedEncoder?.strictCharacterEncoding ? 'ON' : 'OFF'})`,
    `Encoder attempt failures: ${encoderAttempts.length}`,
    ...(encoderAttempts.length
      ? encoderAttempts.slice(0, 10).map(a => `  > ${a.pass} overflowPolicy=${a.overflowPolicy} strictEncoding=${a.strictCharacterEncoding ? 'ON' : 'OFF'} — ${a.message}`)
      : ['  (none)']),
    '',
    '--- Metrics ---',
    `Video FPS: ${fps}${dropFrame ? ' (drop-frame)' : ''}`,
    `Total frames (approx): ${totalFrames}`,
    `Caption blocks: ${Number(stats.captionsCount ?? 0)}`,
    `Average block duration: ${Number(stats.avgDurationSec ?? 0).toFixed(2)} s`,
    `Longest visible line: ${Number(stats.longestLineChars ?? 0)} / ${maxChars}`,
    `Max lines per block: ${maxLines}`,
    '',
    '--- Content QC (readability/timing) ---',
    `Thresholds: maxCPS ${contentQc.thresholds.maxCps}, maxWPM ${contentQc.thresholds.maxWpm}, minDur ${contentQc.thresholds.minDurationSec}s, minGap ${contentQc.thresholds.minGapSec}s, maxLateEOC ${contentQc.thresholds.maxLateEocSec}s (count ≤ ${contentQc.thresholds.maxLateEocCount})`,
    `Observed: maxCPS ${Number(contentQc.metrics.maxCps || 0).toFixed(2)}, maxWPM ${Number(contentQc.metrics.maxWpm || 0).toFixed(0)}, minDur ${Number.isFinite(contentQc.metrics.minDurationSec) ? contentQc.metrics.minDurationSec.toFixed(3) : 'n/a'}s, minGap ${Number.isFinite(contentQc.metrics.minGapSec) ? contentQc.metrics.minGapSec.toFixed(3) : 'n/a'}s, lateEOC ${Number(contentQc.metrics.lateEocCount || 0)} (max ${Number(contentQc.metrics.maxLateEocSec || 0).toFixed(3)}s)`,
    `Content QC: ${contentQc.ok ? 'PASS' : 'FAIL'} • failures ${contentQc.failures.length} • warnings ${contentQc.warnings.length}`,
    ...(contentQc.failures.length ? ['Failures:'].concat(qcFailuresLines) : ['Failures: (none)']),
    ...(contentQc.warnings.length ? ['Warnings:'].concat(qcWarningsLines) : ['Warnings: (none)']),
    '',
    '--- Encoder warnings ---',
    `Warnings: ${encoderWarnings.length} (clamp ${clampWarnings.length}, other ${otherEncoderWarnings.length})`,
    ...(warnList.length ? warnList : ['  (none)']),
    '',
    '--- Transmit clamp details ---',
    `Clamp warnings: ${clampWarnings.length}`,
    ...(clampList.length ? clampList : ['  (none)']),
    '',
    '--- Timing validation ---',
    `Max block allowed: ${maxBlockSec} s`,
    `Over‑long blocks: ${timing.longBlocks.length}`,
    `Overlaps: ${timing.overlaps.length}`,
    ...(timing.count ? [
      'Examples:',
      ...timing.longBlocks.slice(0, 10).map(w => `  > LONG  ${w.startTc} → ${w.endTc} (${w.durationSec}s)  ${w.text}`),
      ...timing.overlaps.slice(0, 10).map(w => `  > OVERL ${w.endTc} > ${w.nextStartTc} (+${w.overlapMs}ms)  ${w.text}`)
    ] : []),
    '',
    '--- Parity ---',
    paritySummary ? `Parity: ${paritySummary}` : null,
    rep ? `Parsed lines: ${rep.parsedLines} • Words: ${rep.totalWords} • Invalid tokens: ${rep.invalidTokens} • Parity errors: ${rep.parityErrors}` : null
  ].filter(Boolean).join('\n');
  writeAtomic(reportPath, report, 'utf8');
  notes.push(`🧪 SCC report → ${reportPath}`);

  // ── QC gate behavior ─────────────────────────────────────────────────────
  // Policy resolution:
  //  - if exportPolicy is set, it wins
  //  - otherwise fall back to legacy qc.gate flags
  const qcGate =
    (exportPolicy === 'gate_write' || exportPolicy === 'gate_block')
      ? true
      : (qcCfg?.gate === true || qcCfg?.failJob === true || config?.sccOptions?.qcGate === true);
  const blockWriteOnQcFail = (exportPolicy === 'gate_block');

  let qcFailed = false;

  if (wrapErrors.length) {
    qcFailed = true;
    const sample = wrapErrors.slice(0, 3).map(w => `Cue ${w.cue}: ${w.message}`).join(' • ');
    notes.push(`⚠️ SCC wrap overflow: ${wrapErrors.length} cue(s) exceeded 608 line limits; wrote draft using ${overflowFallback}.`);
    if (sample) notes.push(`⚠️ Sample: ${sample}`);
  }

  if (usedEncoder?.pass === 'draft') {
    qcFailed = true;
    notes.push(`⚠️ SCC encoder fallback used (overflowPolicy=${usedEncoder.overflowPolicy}, strictEncoding=OFF).`);
  }

  if (contentQc && contentQc.ok === false) {
    qcFailed = true;
    const top = contentQc.failures && contentQc.failures.length
      ? (contentQc.failures[0].message || contentQc.failures[0].type)
      : 'content QC failed';
    notes.push(`⚠️ SCC content QC FAIL (${contentQc.failures.length} issue(s)): ${top}`);
  }

  if (rep && !rep.ok) {
    qcFailed = true;
    notes.push(`⚠️ SCC structural QC FAIL: ${rep.summary}`);
  }

  if (qcFailed && blockWriteOnQcFail) {
    throw new Error(`SCC QC gate failed — SCC was NOT written. Report: ${reportPath}`);
  }

  // Otherwise write SCC now (always for warn/gate_write, and for gate_block when QC passes)
  writeAtomic(outPath, sccWriteText, 'utf8');
  notes.unshift(`📺 SCC → ${outPath}`);

  if (qcGate && qcFailed) {
    // gate_write behavior: write output + report, then FAIL the job on QC.
    // This keeps automation honest while still giving editors a usable file.
    const prefix = (exportPolicy === 'gate_write')
      ? 'SCC deliverable gate failed'
      : 'SCC QC gate failed';

    throw new Error(
      `${prefix} — output was written for editing. SCC: ${outPath} • Report: ${reportPath}`
    );
  }

  // Optional: parallel 608 XML sidecar (Phase 4)
  if (config?.sccOptions?.xmlSidecar) {
    try {
      // Force 'colon' style with the same fps/DF used for SCC so the XML timecodes
      // match the SCC frame grid exactly (HH:MM:SS;FF for DF).
      const generateXml = getTranscribeEngineMethod('generateXML');
      const xml = generateXml(
        wrapped.finalWords
          ? wrapped.finalWords.map(w => ({
              start: w.start,
              end: w.end,
              text: w.text || w.word,
              speaker: w.speaker
            }))
          : (wrapped.segments || []),
        'colon',
        fps,
        dropFrame
      );
      const xmlPath = ensureUnique(path.join(config.outputPath, `${base}.xml`));
      writeAtomic(xmlPath, xml, 'utf8');
      notes.push(`🧾 SCC XML sidecar → ${xmlPath}`);
    } catch (e) {
      notes.push(`⚠️ SCC XML sidecar failed: ${e.message}`);
    }
  }

  return notes;
}

function _approxEqualFps(a, b, eps = 0.12) {
  const A = Number(a);
  const B = Number(b);
  if (!Number.isFinite(A) || !Number.isFinite(B)) return false;
  return Math.abs(A - B) <= Number(eps);
}

// Hard-stop structural validation for MCC.
// - Do NOT allow caller-provided fps/df to mask bad headers.
// - Verify using MCC header-derived rate, and independently ensure it matches expected fps/df.
function assertMccStructurallyValid(mccText, verifyOptions, contextLabel) {
  const v = (verifyOptions && typeof verifyOptions === 'object') ? { ...verifyOptions } : {};
  const expectedFps = Number(v.fps);
  const expectedHasDrop = Object.prototype.hasOwnProperty.call(v, 'dropFrame');
  const expectedDropFrame = expectedHasDrop ? !!v.dropFrame : null;

  // Never override header-derived rate for structural verification.
  delete v.fps;
  delete v.dropFrame;

  const structural = scc.verifyMCC(mccText, v);
  const hdr = (structural && structural.header && typeof structural.header === 'object') ? structural.header : {};

  // Explicit header ↔ expected mismatch check.
  const mismatchErrors = [];
  if (Number.isFinite(expectedFps) && structural && Number.isFinite(Number(structural.fps))) {
    if (!_approxEqualFps(structural.fps, expectedFps, 0.12)) {
      mismatchErrors.push({
        line: 1,
        timecode: '',
        type: 'header',
        code: 'E_MCC_HEADER_MISMATCH',
        message:
          `Header timecode rate implies ~${Number(structural.fps).toFixed(3)}fps` +
          `${structural.dropFrame ? ' (DF)' : ' (NDF)'}, but export expected ~${Number(expectedFps).toFixed(3)}fps` +
          `${expectedDropFrame === null ? '' : (expectedDropFrame ? ' (DF)' : ' (NDF)')}. ` +
          `Time Code Rate=${hdr['time code rate'] ?? 'n/a'}; Drop Frame=${hdr['drop frame'] ?? 'n/a'}.`
      });
    }
  }

  if (expectedDropFrame !== null && structural && typeof structural.dropFrame === 'boolean') {
    if (!!structural.dropFrame !== !!expectedDropFrame) {
      mismatchErrors.push({
        line: 1,
        timecode: '',
        type: 'header',
        code: 'E_MCC_HEADER_MISMATCH',
        message:
          `Header Drop Frame=${structural.dropFrame ? 'True' : 'False'} does not match expected ` +
          `${expectedDropFrame ? 'True' : 'False'}. ` +
          `Time Code Rate=${hdr['time code rate'] ?? 'n/a'}; Drop Frame=${hdr['drop frame'] ?? 'n/a'}.`
      });
    }
  }

  const merged = (mismatchErrors.length)
    ? {
        ...structural,
        ok: false,
        headerErrors: Number(structural?.headerErrors || 0) + mismatchErrors.length,
        errors: [...mismatchErrors, ...(Array.isArray(structural?.errors) ? structural.errors : [])],
        summary: `FAIL — header mismatch (${mismatchErrors.length}) • ${structural?.summary || ''}`.trim()
      }
    : structural;

  if (merged && merged.ok === false) {
    const total = Array.isArray(merged.errors) ? merged.errors.length : 0;
    const head = (typeof scc.formatVerifyErrors === 'function')
      ? scc.formatVerifyErrors(merged.errors, 10)
      : (Array.isArray(merged.errors) ? merged.errors.slice(0, 10).map(e => String(e && e.message ? e.message : e)) : []);
    const shown = head.length;
    const label = String(contextLabel || 'MCC').trim() || 'MCC';
    const msg =
      `${label}: MCC structural validation failed (${total} error(s); first ${shown} shown).\n` +
      head.join('\n') +
      `\nSee .report.txt for full details.`;
    const err = new Error(msg);
    err.structuralQc = merged;
    throw err;
  }

  return merged;
}

async function writeMCC(wrapped, filePath, config) {
  const base = getFilename(filePath);
  const outPath = ensureUnique(path.join(config.outputPath, `${base}.mcc`));

  const mccOpts = config?.mccOptions || {};

  // v1 product scope: MCC export supports a single CEA-708 service per file (plus optional 608 compatibility).
  // The underlying encoder has multi-service capability, but we intentionally do NOT expose it in the app/UI for v1.
  // Fail fast if a config tries to pass multi-service inputs so we don't silently ignore or "pretend" support.
  const _hasMultiServiceInputs =
    (mccOpts && typeof mccOpts === 'object') && (
      mccOpts.services != null ||
      mccOpts.mccServices != null ||
      mccOpts.segmentsByService != null
    );
  if (_hasMultiServiceInputs) {
    throw new Error(
      'MCC multi-service export is not supported in v1. ' +
      'Remove mccOptions.services / mccOptions.mccServices / mccOptions.segmentsByService and export a single service instead.'
    );
  }


  // MCC can have a per-format FPS override (without affecting other outputs).
  const raw =
    mccOpts?.fpsOverride ??
    mccOpts?.frameRateOverride ??
    wrapped?.system?.fps ??
    config?.fpsOverride ??
    config?.fps ??
    29.97;

  const { fps, dfFromString } = parseFpsDf(raw, 29.97);
  const dropPref = config?.dropFrame ?? wrapped?.system?.dropFramePreferred ?? wrapped?.system?.dropFrame ?? dfFromString;
  const dfCapable = isDropFrameRate(fps);
  const dropFrame = dfCapable && (dropPref === true || dropPref == null);
  const include608Compatibility = (mccOpts.include608Compatibility ?? mccOpts.include608 ?? mccOpts.mccInclude608) !== false;
  // MCC authoring model: fixed to True 708 (708 is canonical; 608 is derived separately when enabled).
  const authoringModel = 'true708';

  const maxCharsPerLineRaw = Number(mccOpts.maxCharsPerLine);
  let maxCharsPerLine = Number.isFinite(maxCharsPerLineRaw)
    ? maxCharsPerLineRaw
    : 42;
  maxCharsPerLine = Math.max(1, Math.min(63, Math.trunc(maxCharsPerLine)));

  const maxLinesRaw = Number(mccOpts.maxLinesPerBlock);
  let maxLinesPerBlock = Number.isFinite(maxLinesRaw) ? maxLinesRaw : 2;
  // Lead AE policy: never allow more than 3 lines per subtitle block.
  maxLinesPerBlock = Math.max(1, Math.min(3, Math.trunc(maxLinesPerBlock)));

  const maxDurationRaw = Number(mccOpts.maxDurationSeconds);
  const maxDurationSeconds = Number.isFinite(maxDurationRaw) ? Math.max(0.1, maxDurationRaw) : 6.0;

  const telestreamCompression = (mccOpts.telestreamCompression ?? mccOpts.compress ?? mccOpts.mccCompress) === true;
  // IMPORTANT: Default OFF for NLE compatibility. Many parsers expect CC_DATA (0x72)
  // immediately after the CDP sequence counter and will ignore packets that include
  // the optional 0x71 SMPTE-12M timecode section.
  const includeCdpTimecode = (mccOpts.includeCdpTimecode ?? mccOpts.embedCdpTimecode ?? mccOpts.cdpTimecode) === true;

  // MCC V2.0 optional timecode suffix: ".<field>,<line>" (example: .0,9)
  // If present on an imported doc (doc.mccOptions.mccTimecodeSuffix), we propagate it for round-trip exports.
  const mccTimecodeSuffix = (mccOpts.mccTimecodeSuffix ?? mccOpts.mccV2TimecodeSuffix ?? mccOpts.timecodeSuffix ?? null);
  const compatibilityMode = mccOpts.compatibilityMode ?? mccOpts.compatMode ?? null;
  const includeCcsSvcInfo = (mccOpts.includeCcsSvcInfo ?? mccOpts.includeCcsSvcInfoSection ?? mccOpts.ccsvcInfo) === true;


  const serviceRaw = Number(mccOpts.serviceNumber);
  let serviceNumber = Number.isFinite(serviceRaw) ? serviceRaw : 1;
  serviceNumber = Math.max(1, Math.min(63, Math.trunc(serviceNumber)));

  let language = String(mccOpts.language || 'eng').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(language)) language = 'eng';

  // Caption slip / offset (post-production). Can be negative.
  const timecodeOffset = (typeof mccOpts.timecodeOffset === 'string' ? mccOpts.timecodeOffset : (mccOpts.captionOffset ?? mccOpts.offset ?? null));
  const timecodeOffsetFrames = Number.isFinite(Number(mccOpts.timecodeOffsetFrames)) ? Number(mccOpts.timecodeOffsetFrames) : undefined;
  const timecodeOffsetSeconds = Number.isFinite(Number(mccOpts.timecodeOffsetSeconds)) ? Number(mccOpts.timecodeOffsetSeconds) : undefined;
  let timecodeOffsetPolicy = String(mccOpts.timecodeOffsetPolicy ?? mccOpts.offsetPolicy ?? 'clamp').trim().toLowerCase();
  if (!['clamp', 'error'].includes(timecodeOffsetPolicy)) timecodeOffsetPolicy = 'clamp';

  const mcc708Window = (mccOpts.mcc708Window && typeof mccOpts.mcc708Window === 'object') ? mccOpts.mcc708Window : null;

  const exportPolicy = (() => {
    const rawPolicy = String(mccOpts.exportPolicy || '').trim().toLowerCase();
    if (rawPolicy === 'gate_block' || rawPolicy === 'block' || rawPolicy === 'strict') return 'gate_block';
    if (rawPolicy === 'gate_write' || rawPolicy === 'gate') return 'gate_write';
    if (rawPolicy === 'warn' || rawPolicy === 'normal' || rawPolicy === 'off') return 'warn';
    return 'warn';
  })();
  const strict = exportPolicy === 'gate_block';

  const qcCfg = (mccOpts && mccOpts.qc) ? mccOpts.qc : {};

  // Phase 2.1: resolve per-track QC profiles (708 vs 608) from config.
  // These are optional; when absent, both tracks inherit the legacy single-profile settings.
  const { qcProfile708, qcProfile608 } = resolveMccQcProfiles(qcCfg);


  // Option C — Dual grading (best UX)
  // Default behavior:
  //   • ON for all MCC exports (unless explicitly disabled)
  // Rationale: make it impossible to misread. Every export should clearly report:
  //   - broadcast-grade (CEA-708) result
  //   - legacy-grade (projected CEA-608) result
  const dualGrade = resolveMccDualGradeEnabled(qcCfg, compatibilityMode);

  const want708Qc = resolveMccWant708Qc(qcCfg, dualGrade);

  // Milestone 4: explicit 608 compatibility generation rules (used when authoringModel='true708').
  // Defaults to the same thresholds as QC so the derived 608 track stays readable.
  const compatGenerationRules = (() => {
    const userRules = (mccOpts && typeof mccOpts === 'object') ? (mccOpts.compatGenerationRules || null) : null;
    const userQc = (userRules && typeof userRules === "object") ? (userRules.qc || null) : null;

    const qc = {
      ...(userQc && typeof userQc === 'object' ? userQc : {}),
      maxCps: (userQc && userQc.maxCps != null) ? userQc.maxCps : ((qcProfile608 && qcProfile608.maxCps != null) ? qcProfile608.maxCps : qcCfg.maxCps),
      maxWpm: (userQc && userQc.maxWpm != null) ? userQc.maxWpm : ((qcProfile608 && qcProfile608.maxWpm != null) ? qcProfile608.maxWpm : qcCfg.maxWpm),
      minDurationSec: (userQc && userQc.minDurationSec != null) ? userQc.minDurationSec : ((qcProfile608 && qcProfile608.minDurationSec != null) ? qcProfile608.minDurationSec : qcCfg.minDurationSec),
      minGapSec: (userQc && userQc.minGapSec != null) ? userQc.minGapSec : ((qcProfile608 && qcProfile608.minGapSec != null) ? qcProfile608.minGapSec : qcCfg.minGapSec)
    };

    return {
      ...(userRules && typeof userRules === 'object' ? userRules : {}),
      qc
    };
  })();

  const includeSpeakerNamesMcc = mccOpts.includeSpeakerNames === true;

  // 608 wrap shaping preferences (speaker labels, punctuation, hyphenation, explicit line breaks).
  // These are optional and can live either at:
  //   - mccOptions.wrap608 / mccOptions.cea608Wrap
  //   - mccOptions.shaping.wrap608 (or .textWrap/.wrap)
  // If unset, sccEncoder will use broadcast-safe defaults.
  const wrap608Options = (() => {
    const direct = (mccOpts && typeof mccOpts === 'object')
      ? (mccOpts.wrap608 || mccOpts.cea608Wrap || mccOpts.textWrap608 || null)
      : null;
    if (direct && typeof direct === 'object') return direct;

    const sh = (mccOpts && mccOpts.shaping && typeof mccOpts.shaping === 'object') ? mccOpts.shaping : null;
    if (!sh) return null;

    const candidate = (sh.wrap608 && typeof sh.wrap608 === 'object') ? sh.wrap608
      : ((sh.textWrap && typeof sh.textWrap === 'object') ? sh.textWrap
        : ((sh.wrap && typeof sh.wrap === 'object') ? sh.wrap : sh));

    return (candidate && typeof candidate === 'object') ? candidate : null;
  })();
  const segsOriginal = Array.isArray(wrapped?.segments) ? wrapped.segments : [];
  let segsForMcc = includeSpeakerNamesMcc
    ? segsOriginal.map(seg => {
        if (!seg) return seg;
        const sp = String(seg.speaker || '').trim();
        if (!sp) return seg;
        const prefix = `${sp}: `;
        const baseText = String(seg.text || '');
        if (baseText.startsWith(prefix)) return seg;
        const out = { ...seg, text: `${prefix}${baseText}` };
        if (Array.isArray(seg.runs) && seg.runs.length) {
          const first = seg.runs[0];
          const inheritStyle = (first && typeof first === 'object' && first.style && typeof first.style === 'object')
            ? { ...first.style }
            : undefined;
          const prefixRun = inheritStyle ? { text: prefix, style: inheritStyle } : { text: prefix };
          out.runs = [prefixRun, ...seg.runs];
        }
        return out;
      })
    : segsOriginal;

  // Optional shaping pass (608-style) for MCC when 608 compatibility is enabled.
  // This is best-effort: it should improve pop-on timing + reduce CPS/WPM, but must never block export.
  let shaping = null;
  try {
    const shapeCfg = (mccOpts && mccOpts.shaping && typeof mccOpts.shaping === 'object') ? mccOpts.shaping : null;

    // P0-3: Broadcast/strict deliverables should shape by default when 608 compat is ON.
    // - If shaping is explicitly enabled, honor it.
    // - Else if compatibilityMode is broadcast/strict, enable conservative shaping.
    // - Else (nle/unknown), stay relaxed unless explicitly enabled.
    const explicitEnableShaping = (() => {
      if (!shapeCfg || typeof shapeCfg !== 'object') return false;
      const v = (shapeCfg.enabled ?? shapeCfg.enable ?? shapeCfg.on);
      return (v === true || v === 'true');
    })();

    const compatModeNorm = String(compatibilityMode || '').trim().toLowerCase();
    const autoEnableByProfile = (compatModeNorm === 'broadcast' || compatModeNorm === 'strict');
    const enableShaping = !!include608Compatibility && (explicitEnableShaping || autoEnableByProfile);

    // Phase A/B: auto-shaping operates on plain text and can drop per-run styling.
    // If the input contains rich runs[], skip shaping to avoid silently erasing styling.
    const hasRichRuns = Array.isArray(segsForMcc) && segsForMcc.some(s => Array.isArray(s?.runs) && s.runs.length);
    const enableShapingFinal = enableShaping && !hasRichRuns;

    if (enableShapingFinal && typeof shapeSegmentsForScc === 'function') {
      // Auto-shape(608) must enforce 608-safe constraints even if authoringModel is true708.
      // Respect any tighter user settings, but never exceed 608's 32x2 envelope.
      const shapeMaxCharsPerLine = Math.min(32, maxCharsPerLine);
      const shapeMaxLinesPerBlock = Math.min(2, maxLinesPerBlock);

      const res = shapeSegmentsForScc(segsForMcc, {
        fps,
        dropFrame,
        startTc: mccOpts?.startTC ?? mccOpts?.startTc ?? config?.startTC ?? config?.startTc ?? null,
        preStartTransmitSec: 0,
        fixStartTcClamp: false,
        maxCharsPerLine: shapeMaxCharsPerLine,
        maxLinesPerBlock: shapeMaxLinesPerBlock,
        maxDurationSec: maxDurationSeconds,
        // Hard cap so shaping can’t extend beyond the actual source runtime.
        maxEndSec: (() => {
          const v = Number(wrapped?.metadata?.durationSeconds);
          if (Number.isFinite(v) && v > 0) return v;
          const last = (Array.isArray(segsForMcc) && segsForMcc.length)
            ? (Number.isFinite(Number(segsForMcc[segsForMcc.length - 1].end))
              ? Number(segsForMcc[segsForMcc.length - 1].end)
              : ((Number(segsForMcc[segsForMcc.length - 1].msEnd) || 0) / 1000))
            : NaN;
          return (Number.isFinite(last) && last > 0) ? last : undefined;
        })(),
        preserveSpeakerBoundaries: true,
        clampToMaxEnd: true,
        qc: {
          maxCps: qcCfg.maxCps,
          maxWpm: qcCfg.maxWpm,
          minDurationSec: qcCfg.minDurationSec,
          minGapSec: qcCfg.minGapSec
        },
        // If auto-enabled by profile, force conservative defaults.
        // If explicitly enabled, honor user-tuned knobs.
        mode: explicitEnableShaping && shapeCfg && shapeCfg.mode ? shapeCfg.mode : 'conservative',
        microCueSec: explicitEnableShaping && shapeCfg ? shapeCfg.microCueSec : undefined,
        microGapSec: explicitEnableShaping && shapeCfg ? shapeCfg.microGapSec : undefined,
        maxShiftSec: explicitEnableShaping && shapeCfg ? shapeCfg.maxShiftSec : undefined
      });

      if (res && Array.isArray(res.segments) && res.segments.length) {
        segsForMcc = res.segments;
        shaping = res.report || null;
      }
    }
  } catch (e) {
    shaping = { ok: false, error: e?.message || String(e) };
  }

  // Deliverable behavior (mirrors SCC):
  //   - gate_block: strict only, do NOT write on failure
  //   - gate_write: write a draft fallback if strict encode fails, then fail job
  //   - warn: always write (draft fallback allowed)
  const _normOverflow = (v) => {
    const s = String(v || '').trim().toLowerCase();
    return (s === 'truncate' || s === 'error') ? s : '';
  };

  const allowDraft = exportPolicy !== 'gate_block';

  // If user didn’t pick an overflow policy, default to:
  //   - strict deliverable: error
  //   - everything else: truncate
  const overflowRequested = (() => {
    const v = _normOverflow(mccOpts.overflowPolicy);
    if (v) return v;
    return (exportPolicy === 'gate_block') ? 'error' : 'truncate';
  })();

  const strictEncodingRequested = (mccOpts.strictCharacterEncoding === true);

  const attempts = [
    { pass: 'primary', overflowPolicy: overflowRequested, strictCharacterEncoding: strictEncodingRequested }
  ];

  // Draft fallback pass: make *something* so the user can edit it.
  // This is what you expected “gate_write” to do.
  if (allowDraft && (overflowRequested === 'error' || strictEncodingRequested)) {
    attempts.push({ pass: 'draft', overflowPolicy: 'truncate', strictCharacterEncoding: false });
  }

  let mccText = '';
  const encoderAttempts = [];
  let usedPass = attempts[0].pass;

  for (const a of attempts) {
    try {
      mccText = scc.generateMCC(segsForMcc, {
        fps,
        dropFrame,
        startTc: mccOpts?.startTC ?? mccOpts?.startTc ?? config?.startTC ?? config?.startTc ?? null,
        timecodeOffset,
        timecodeOffsetFrames,
        timecodeOffsetSeconds,
        timecodeOffsetPolicy,
        includeCdpTimecode,
        mccTimecodeSuffix,
        compatibilityMode,
        includeCcsSvcInfo,
        authoringModel,
        include608Compatibility: include608Compatibility,
        compatGenerationRules,
        telestreamCompression: telestreamCompression,
        pingPongWindows: (mccOpts.pingPongWindows ?? mccOpts.popOnPingPongWindows ?? true) !== false,
        creationProgram: mccOpts.creationProgram ?? 'Lead AE Assist',
        maxCharsPerLine,
        maxLinesPerBlock,
        includeSpeakerNames: false,
        serviceNumber,
        language,
        sccOptions: {
          alignment: mccOpts.alignment,
          channel: normalizeSccChannel(mccOpts.channel ?? 1),
          rowPolicy: mccOpts.rowPolicy,
          safeMargins: mccOpts.safeMargins || null,
          overflowPolicy: a.overflowPolicy,
          strictCharacterEncoding: a.strictCharacterEncoding,
          padEven: !!mccOpts.padEven,
          repeatControlCodes: mccOpts.repeatControlCodes,
          repeatPreambleCodes: mccOpts.repeatPreambleCodes,
          mcc708Window: mcc708Window || mccOpts.windowPlacement || mccOpts.window || null,
          wrap608: wrap608Options || null,
          extendedGlyphMap
        }
      });
      usedPass = a.pass;
      break;
    } catch (e) {
      encoderAttempts.push({
        pass: a.pass,
        overflowPolicy: a.overflowPolicy,
        strictEncoding: a.strictCharacterEncoding,
        message: e?.message || String(e)
      });
    }
  }

  if (!mccText) {
    const last = encoderAttempts[encoderAttempts.length - 1];
    throw new Error(last?.message || 'MCC generation failed');
  }

  // Structural / container QC (MCC header + ANC/CDP integrity)
  const reportPath = ensureUnique(path.join(config.outputPath, `${base}.mcc.report.txt`));
  let structuralQc = null;
  let structuralErr = null;
  try {
    structuralQc = assertMccStructurallyValid(mccText, {
      fps,
      dropFrame,
      // Draft/edit: tolerate gaps/duplicates. Deliverable/strict: enforce per-frame continuity.
      checkUnitStep: strict,
      unitStepAsError: strict,
      strictTimeCodeRateFormat: strict,
      strictPayloadParse: strict
    }, `writeMCC(${base})`);
  } catch (e) {
    structuralErr = e;
    structuralQc = e?.structuralQc || {
      ok: false,
      errors: [{ line: 0, timecode: '', type: 'exception', message: e?.message || String(e) }],
      warnings: [],
      summary: 'Exception while verifying MCC'
    };
  }

  // HARD STOP: structural invalid MCC is never written (regardless of policy).
  if (structuralQc && structuralQc.ok === false) {
    writeMccQcReport({
      reportPath,
      outPath,
      fps,
      dropFrame,
      compatibilityMode,
      includeCcsSvcInfo,
      authoringModel,
      maxCharsPerLine,
      maxLinesPerBlock,
      maxDurationSeconds,
      include608Compatibility,
      includeCdpTimecode,
      telestreamCompression,
      serviceNumber,
      language,
      encoderPlan: attempts,
      encoderPass: usedPass,
      encoderAttempts,
      shaping,
      contentQc: null,
      structuralQc
    });

    const msg = structuralErr?.message || structuralQc?.summary || 'MCC structural validation failed.';
    throw new Error(`MCC export failed — MCC was NOT written due to structural validation failure. Report: ${reportPath}\n${msg}`);
  }

  // Content QC: decode from the FINAL MCC output so wrapping/line breaks are assessed
  // exactly as delivered (mirrors SCC QC behavior). This avoids false maxCols/maxLines
  // failures caused by evaluating unwrapped segment text.
  const contentQc = validateMccContentQc(segsForMcc, {
    fps,
    dropFrame,
    maxCharsPerLine,
    maxLinesPerBlock,
    maxDurationSec: maxDurationSeconds,
    maxCps: qcCfg.maxCps,
    maxWpm: qcCfg.maxWpm,
    minDurationSec: qcCfg.minDurationSec,
    minGapSec: qcCfg.minGapSec,
    qcProfile708,
    qcProfile608,
    // New: decode-from-output path.
    mccText,
    // Optional: run an additional 708 decode + QC pass on the same output.
    decode708: want708Qc,
    require708: qcCfg.require708 === true || qcCfg.gateOnMissing708 === true,
    serviceNumber,
    // Dual grading extras
    dualGrade,
    compatibilityMode,
    compatGenerationRules,
    safeMargins: (mccOpts && typeof mccOpts === 'object') ? (mccOpts.safeMargins || null) : null
  });

  writeMccQcReport({
    reportPath,
    outPath,
    fps,
    dropFrame,
    compatibilityMode,
    includeCcsSvcInfo,
    authoringModel,
    maxCharsPerLine,
    maxLinesPerBlock,
    maxDurationSeconds,
    include608Compatibility,
    includeCdpTimecode,
    telestreamCompression,
    serviceNumber,
    language,
    encoderPlan: attempts,
    encoderPass: usedPass,
    encoderAttempts,
    shaping,
    contentQc,
    structuralQc
  });

  const qcGate =
    (exportPolicy === 'gate_write' || exportPolicy === 'gate_block')
      ? true
      : (qcCfg?.gate === true || qcCfg?.failJob === true);
  const blockWriteOnQcFail = (exportPolicy === 'gate_block');

  const notes = [];

  const qcFailed = (contentQc && contentQc.ok === false) || (structuralQc && structuralQc.ok === false);

  // Encoder fallback (primary → draft) is a deliverable failure in gate_write mode.
  // In warn mode, it is reported but does not fail unless explicitly gated via qcCfg.
  const encoderFallbackUsed = (() => {
    const used = String(usedPass || '').trim();
    const primary = String(attempts[0]?.pass || 'primary').trim();
    return !!(used && primary && used !== primary);
  })();

  const gateOnDraftFallback =
    (exportPolicy === 'gate_write')
      ? true
      : (qcCfg?.gateOnDraftFallback === true || qcCfg?.failOnDraftFallback === true || qcCfg?.gateOnFallback === true);

  const gateReasons = [];
  if (qcFailed) gateReasons.push('QC failed');
  if (encoderFallbackUsed && gateOnDraftFallback) gateReasons.push('encoder fell back to draft pass');
  const gateFailed = gateReasons.length > 0;

  if (qcFailed && blockWriteOnQcFail) {
    throw new Error(`MCC QC gate failed — MCC was NOT written. Report: ${reportPath}`);
  }

  // IMPORTANT: sccEncoder.generateMCC() may return a boxed String object
  // (new String(...)) so it can carry _mccMeta for QC/reporting.
  // In newer Node/Electron runtimes, fs.writeFileSync is strict and will throw
  // on boxed strings. Always coerce to a primitive string for disk writes.
  // Also normalize to CRLF for best compatibility with common MCC consumers.
  const mccWriteText = String(mccText || '').replace(/\r?\n/g, '\r\n');
  writeAtomic(outPath, mccWriteText, 'utf8');
  notes.unshift(`📺 MCC → ${outPath}`);
  notes.push(`🧪 MCC report → ${reportPath}`);

  if (encoderFallbackUsed) {
    notes.push('⚠ MCC encoder used draft fallback (truncate/non-strict). See report.');
  }

  if (qcGate && gateFailed) {
    const both = qcFailed && encoderFallbackUsed && gateOnDraftFallback;
    const fallbackOnly = (!qcFailed) && encoderFallbackUsed && gateOnDraftFallback;

    const prefix = both
      ? 'MCC deliverable gate failed — QC failed and encoder fell back to draft pass'
      : (fallbackOnly
        ? 'MCC deliverable gate failed — encoder fell back to draft pass (truncate/non-strict)'
        : 'MCC QC gate failed');

    throw new Error(
      `${prefix} — output was written for editing. MCC: ${outPath} • Report: ${reportPath}`
    );
  }

  return notes;
}

async function writeSccFromTranscriptionJob(opts) {
  const {
    segments,
    sccConfig,
    outPath
  } = opts || {};

  if (!segments || !sccConfig || !outPath) return null;

  const sccText = scc.generateSCC(segments, sccConfig);
  const { canonical, writeText } = normalizeSccTextForWrite(sccText);
  writeAtomic(outPath, writeText, 'utf8');

  // G) Write QC report sidecar for SCC output
  const verify = (typeof scc.verifySCC === 'function')
    ? scc.verifySCC(canonical, { fps: sccConfig.fps, dropFrame: sccConfig.dropFrame })
    : null;
  const reportOut = writeSccQcReport({
    sccText: canonical,
    verify,
    metrics: verify?.metrics || null,
    srcLabel: opts?.srcLabel || 'transcription',
    outPath
  });
  if (reportOut?.reportPath) {
    // optional: log/report path
  }

  return { outPath };
}

function writeSccQcReport({
  sccText,
  verify,
  metrics,
  srcLabel = '',
  outPath
}) {
  if (!outPath) return null;
  const reportPath = `${outPath}.report.txt`;
  const lines = [];
  lines.push('=== SCC QC REPORT ===');
  if (srcLabel) lines.push(`Source: ${srcLabel}`);
  lines.push(`Output: ${outPath}`);
  lines.push('');
  if (verify) {
    lines.push('--- verifySCC() ---');
    lines.push(JSON.stringify(verify, null, 2));
    lines.push('');
  }
  if (metrics) {
    lines.push('--- metrics ---');
    lines.push(JSON.stringify(metrics, null, 2));
    lines.push('');
  }
  if (sccText) {
    lines.push('--- preview ---');
    lines.push(String(sccText).split(/\r?\n/).slice(0, 6).join('\n'));
    lines.push('');
  }
  try {
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  } catch (e) {
    return { reportPath, error: String(e?.message || e) };
  }
  return { reportPath };
}

function writeMccQcReport({
  reportPath,
  outPath,
  fps,
  dropFrame,
  compatibilityMode,
  includeCcsSvcInfo,
  authoringModel,
  maxCharsPerLine,
  maxLinesPerBlock,
  maxDurationSeconds,
  include608Compatibility,
  includeCdpTimecode,
  telestreamCompression,
  serviceNumber,
  language,
  encoderPlan,
  encoderPass,
  encoderAttempts,
  shaping,
  contentQc,
  structuralQc
}) {
  if (!reportPath || !outPath) return null;
  const lines = [];
  lines.push('MCC QC REPORT');
  lines.push('');
  lines.push('--- Export Details ---');
  lines.push(`File: ${outPath}`);
  lines.push(`Video FPS: ${Number(fps) || 29.97}${dropFrame ? ' (drop-frame)' : ''}`);
  const _normalizeMccCompatibilityMode = (mode) => {
    const raw = String(mode || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw === 'nle' || raw === 'edit' || raw === 'editor') return 'nle';
    if (raw === 'broadcast' || raw === 'bcast' || raw === 'tx') return 'broadcast';
    if (raw === 'strict' || raw === 'qc') return 'strict';
    return '';
  };

  const modeRaw = (compatibilityMode == null) ? '' : String(compatibilityMode).trim();
  const modeNorm = _normalizeMccCompatibilityMode(modeRaw);
  const modeShown = modeNorm || (modeRaw ? modeRaw : 'auto');
  lines.push(`Compatibility Mode: ${modeShown}${(modeRaw && !modeNorm) ? ` (unrecognized raw value)` : ''}`);
  if (!modeRaw) {
    lines.push('NOTE: Compatibility Mode is AUTO (not set); no mode-specific overrides are applied.');
  } else if (modeRaw && !modeNorm) {
    lines.push('NOTE: Unrecognized Compatibility Mode; treated as AUTO (no mode-specific overrides).');
  }

  lines.push(`Authoring Model: ${String(authoringModel || 'true708')}`);

  // Encoder diagnostics (primary vs draft fallback)
  const _encPlan = Array.isArray(encoderPlan) ? encoderPlan : [];
  const _encPrimaryPass = _encPlan.length ? String(_encPlan[0]?.pass || _encPlan[0]?.name || '') : '';
  const _encUsed = (encoderPass != null && String(encoderPass).trim()) ? String(encoderPass).trim() : '';
  const _encErrors = Array.isArray(encoderAttempts) ? encoderAttempts : [];

  if (_encPlan.length || _encUsed || _encErrors.length) {
    lines.push('');
    lines.push('Encoder:');
    if (_encPlan.length) {
      for (const p of _encPlan) {
        const pass = String(p?.pass || p?.name || '').trim() || 'pass';
        const ov = (p && p.overflowPolicy != null) ? String(p.overflowPolicy).trim() : '';
        const seRaw = (p && (p.strictCharacterEncoding != null ? p.strictCharacterEncoding : p.strictEncoding));
        const se = !!seRaw;
        const usedMark = (_encUsed && pass === _encUsed) ? ' (USED)' : '';
        lines.push(`  - ${pass}: overflowPolicy=${ov || 'auto'}; strictCharacterEncoding=${se ? 'true' : 'false'}${usedMark}`);
      }
    } else if (_encUsed) {
      lines.push(`  - usedPass: ${_encUsed}`);
    }

    if (_encUsed && _encPrimaryPass && _encUsed !== _encPrimaryPass) {
      lines.push('WARNING: Encoder fell back to a draft pass (truncate/non-strict). Output may be truncated or less strictly encoded.');
    }

    if (_encErrors.length) {
      lines.push('Encoder errors:');
      for (const a of _encErrors) {
        const pass = String(a?.pass || '').trim() || 'pass';
        const msg = String(a?.message || '').trim();
        if (!msg) continue;
        lines.push(`  - ${pass}: ${msg}`);
      }
    }
    lines.push('');
  }

  // Some MCC encoder behaviors are *overridden* by compatibility mode.
  // This report prints both the requested setting (as passed by the caller)
  // and the effective setting (what the encoder will actually emit).
  const isAuto = (v) => v == null;
  const onOff = (v) => (v ? 'ON' : 'OFF');
  const reqLabel = (v) => isAuto(v) ? 'AUTO' : onOff(!!v);

  const effInclude608 = (modeNorm === 'nle') ? true : !!include608Compatibility;
  const effIncludeCdpTimecode = (modeNorm === 'nle')
    ? false
    : ((modeNorm === 'strict' && isAuto(includeCdpTimecode)) ? true : !!includeCdpTimecode);
  const effIncludeCcsSvcInfo = (modeNorm === 'nle')
    ? false
    : (((modeNorm === 'broadcast' || modeNorm === 'strict') && isAuto(includeCcsSvcInfo)) ? true : !!includeCcsSvcInfo);
  const effTelestreamCompression = (modeNorm === 'nle') ? false : !!telestreamCompression;

  const fmtReqEff = (label, reqVal, effVal) => {
    const r = reqLabel(reqVal);
    const e = onOff(!!effVal);
    let note = '';
    if (r === 'AUTO') note = ' (mode default)';
    else if (!!reqVal !== !!effVal) note = ' (overridden by mode)';
    return `${label}: requested ${r} • effective ${e}${note}`;
  };

  if (modeNorm === 'nle') {
    lines.push('NOTE: NLE mode forces: 608 compatibility ON, CCSVCInfo OFF, CDP timecode OFF, Telestream compression OFF (max ingest reliability).');
  }

  lines.push(`Service: ${serviceNumber}`);
  lines.push(`Language: ${language}`);

  lines.push(fmtReqEff('Include 608 compatibility', include608Compatibility, effInclude608));
  lines.push(fmtReqEff('Include CDP service info (0x73)', includeCcsSvcInfo, effIncludeCcsSvcInfo));
  if (effIncludeCcsSvcInfo) {
    lines.push('NOTE: Some broadcast decoders behave better when CCSVCInfo is present.');
  }

  lines.push(fmtReqEff('Embed SMPTE timecode in CDP (0x71)', includeCdpTimecode, effIncludeCdpTimecode));
  if (effIncludeCdpTimecode) {
    lines.push('NOTE: Some NLEs/parsers ignore CDP packets that include the optional 0x71 timecode section.');
  }

  lines.push(fmtReqEff('Telestream compression', telestreamCompression, effTelestreamCompression));
  lines.push(`Max chars per line: ${maxCharsPerLine}`);
  lines.push(`Max lines per block: ${maxLinesPerBlock}`);
  lines.push(`Max duration (sec): ${maxDurationSeconds}`);

  // ---------------------------------------------------------------------------
  // Quick Answers (skimmable summary)
  // ---------------------------------------------------------------------------
  lines.push('');
  lines.push('--- Quick Answers ---');

  const _tracks = (contentQc && contentQc.tracks && typeof contentQc.tracks === 'object') ? contentQc.tracks : null;
  const _qc708 = _tracks ? (_tracks.cea708 || null) : null;
  const _qc608Eff = _tracks ? (_tracks.cea608 || null) : null;
  const _qc608Legacy = _tracks
    ? (_tracks.legacy608 || ((_qc608Eff && String(_qc608Eff.source || '').toLowerCase() === 'projected') ? _qc608Eff : null))
    : null;
  const _dual = (contentQc && contentQc.dual && typeof contentQc.dual === 'object') ? contentQc.dual : null;

  const _passFail = (qc) => {
    if (!qc) return 'N/A';
    if (qc.ok === true) return 'PASS';
    if (qc.ok === false) return 'FAIL';
    return 'N/A';
  };
  const _qcSrc = (qc) => {
    const src = String(qc?.source || '').trim().toLowerCase();
    if (!src) return 'unknown';
    if (src === 'decoded') return 'decoded';
    if (src === 'projected') return 'projected';
    if (src === 'segments') return 'pre-encode';
    return src;
  };

  // Structural QC can block content QC entirely.
  if (structuralQc && structuralQc.ok === false) {
    lines.push('Broadcast (CEA-708): N/A (structural QC failed — file not valid)');
    lines.push('Legacy ingest (CEA-608): N/A (structural QC failed — file not valid)');
  } else {
    const embedded608Detected = !!(_qc608Eff && String(_qc608Eff.source || '').toLowerCase() === 'decoded' && Number(_qc608Eff.metrics?.cues || 0) > 0);
    const embedded708Detected = !!(_qc708 && String(_qc708.source || '').toLowerCase() === 'decoded' && Number(_qc708.metrics?.cues || 0) > 0);
    lines.push(`Broadcast (CEA-708): ${_passFail(_qc708)} • source ${_qcSrc(_qc708)}${embedded708Detected ? ' • decoded cues present' : ''}`);
    lines.push(`Legacy ingest (CEA-608): ${_passFail(_qc608Eff)} • source ${_qcSrc(_qc608Eff)}${embedded608Detected ? ' • embedded 608 present' : ' • embedded 608 not detected'}`);
    if (_qc608Legacy && _qc608Legacy !== _qc608Eff) {
      lines.push(`Legacy projection (CEA-608): ${_passFail(_qc608Legacy)} • source ${_qcSrc(_qc608Legacy)}`);
    }
    const unsafeCount = Array.isArray(_dual?.legacyUnsafeCues) ? _dual.legacyUnsafeCues.length : null;
    if (unsafeCount != null) lines.push(`Broadcast-safe but legacy-unsafe cues: ${unsafeCount}`);
  }
  // Shaping summary (if enabled)
  if (shaping) {
    lines.push('');
    lines.push('--- Shaping (auto-retime) ---');
    if (shaping.ok === false) {
      lines.push(`Result: FAIL${shaping.error ? ` — ${shaping.error}` : ''}`);
    } else {
      const sum = shaping.summary || {};
      lines.push('Result: PASS');
      if (Number.isFinite(sum.originalCues) && Number.isFinite(sum.finalCues)) {
        lines.push(`Cues: ${sum.originalCues} → ${sum.finalCues}`);
      }
      if (Number.isFinite(sum.mergedCues) || Number.isFinite(sum.splitCues) || Number.isFinite(sum.retimedCues)) {
        lines.push(`Merged: ${sum.mergedCues || 0} • Split: ${sum.splitCues || 0} • Retimed: ${sum.retimedCues || 0}`);
      }
      if (Number.isFinite(sum.firstCueDelayedSec) && sum.firstCueDelayedSec > 0) {
        lines.push(`First cue delayed: ${sum.firstCueDelayedSec.toFixed(3)}s`);
      }
    }
    lines.push('');
  }


  const clampPreview = (s, maxChars = 72) => {
    const chars = Array.from(String(s ?? ''));
    if (chars.length <= maxChars) return chars.join('');
    return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
  };

  const fmtQcRange = (it) => {
    // Prefer spacing ranges when present (end→nextStart), otherwise show the cue range.
    if (it && it.endTc && it.nextStartTc) return `${it.endTc}–${it.nextStartTc}`;
    if (it && it.startTc && it.endTc) return `${it.startTc}–${it.endTc}`;
    if (it && it.startTc) return String(it.startTc);
    return '';
  };
  const fmtObserved = (qc) => {
    const m = qc?.metrics || {};
    return `Observed: maxCPS ${Number(m.maxCps || 0).toFixed(2)}, maxWPM ${Number(m.maxWpm || 0).toFixed(0)}, minDur ${Number.isFinite(m.minDurationSec) ? m.minDurationSec.toFixed(3) : 'n/a'}s, minGap ${Number.isFinite(m.minGapSec) ? m.minGapSec.toFixed(3) : 'n/a'}s`;
  };
  const fmtThresholds = (qc) => {
    const t = qc?.thresholds || {};
    const bits = [];
    if (Number.isFinite(Number(t.maxCharsPerLine)) && Number(t.maxCharsPerLine) > 0) bits.push(`maxCols ${Number(t.maxCharsPerLine)}`);
    if (Number.isFinite(Number(t.maxLinesPerBlock)) && Number(t.maxLinesPerBlock) > 0) bits.push(`maxLines ${Number(t.maxLinesPerBlock)}`);
    bits.push(`maxCPS ${t.maxCps}`, `maxWPM ${t.maxWpm}`, `minDur ${t.minDurationSec}s`, `minGap ${t.minGapSec}s`);
    if (Number.isFinite(Number(t.maxDurationSec)) && Number(t.maxDurationSec) > 0) bits.push(`maxDur ${Number(t.maxDurationSec)}s`);
    return `Thresholds: ${bits.join(', ')}`;
  };

  const _normalizeIssues = (arr, kind) => {
    const out = [];
    for (const it of (Array.isArray(arr) ? arr : [])) {
      if (it == null) continue;
      if (typeof it === 'string') {
        out.push({ type: kind === 'fail' ? 'failure' : 'warning', message: it });
        continue;
      }
      if (typeof it === 'object') out.push(it);
    }
    return out;
  };

  const fmtIssueMetric = (iss, thresholds) => {
    const t = (thresholds && typeof thresholds === 'object') ? thresholds : {};
    const ty = String(iss?.type || '').trim();
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    if (!ty) return '';

    if (ty === 'maxCols') {
      const a = num(iss.actualCols);
      const lim = num(iss.maxCols ?? t.maxCharsPerLine);
      const li = Number.isFinite(Number(iss.lineIndex)) ? (Number(iss.lineIndex) + 1) : null;
      if (a != null && lim != null) return `line ${li ?? '?'} cols ${a} > ${lim}`;
    }
    if (ty === 'maxLines') {
      const a = num(iss.actualLines);
      const lim = num(iss.maxLines ?? t.maxLinesPerBlock);
      if (a != null && lim != null) return `lines ${a} > ${lim}`;
    }
    if (ty === 'cps') {
      const a = num(iss.cps);
      const lim = num(iss.maxCps ?? t.maxCps);
      if (a != null && lim != null) return `CPS ${a.toFixed(2)} > ${lim}`;
    }
    if (ty === 'wpm') {
      const a = num(iss.wpm);
      const lim = num(iss.maxWpm ?? t.maxWpm);
      if (a != null && lim != null) return `WPM ${Math.round(a)} > ${lim}`;
    }
    if (ty === 'minDuration') {
      const a = num(iss.durationSec);
      const lim = num(iss.minDurationSec ?? t.minDurationSec);
      if (a != null && lim != null) return `duration ${a.toFixed(3)}s < ${lim}s`;
    }
    if (ty === 'maxDuration') {
      const a = num(iss.durationSec);
      const lim = num(iss.maxDurationSec ?? t.maxDurationSec);
      if (a != null && lim != null) return `duration ${a.toFixed(3)}s > ${lim}s`;
    }
    if (ty === 'minGap') {
      const a = num(iss.gapSec);
      const lim = num(iss.minGapSec ?? t.minGapSec);
      if (a != null && lim != null) return `gap ${a.toFixed(3)}s < ${lim}s`;
    }
    if (ty === 'overlap') {
      const a = num(iss.overlapSec);
      if (a != null) return `overlap ${a.toFixed(3)}s`;
    }
    if (ty === 'lineBreak') {
      const tok = String(iss.lastToken || '').trim();
      if (tok) return `ends with “${tok}”`;
    }
    return '';
  };

  const writeCueBreakdown = (qc, { cueLabel = 'Cue', maxShow = 50 } = {}) => {
    if (!qc || !Array.isArray(qc.byCue) || !qc.byCue.length) return;
    const thresholds = (qc.thresholds && typeof qc.thresholds === 'object') ? qc.thresholds : {};

    const failMap = new Map();
    for (const iss of _normalizeIssues(qc.failures, 'fail')) {
      const idx = Number.isFinite(Number(iss?.cueIndex)) ? Math.trunc(Number(iss.cueIndex)) : null;
      if (idx == null) continue;
      if (!failMap.has(idx)) failMap.set(idx, []);
      failMap.get(idx).push(iss);
    }

    const warnMap = new Map();
    for (const iss of _normalizeIssues(qc.warnings, 'warn')) {
      const idx = Number.isFinite(Number(iss?.cueIndex)) ? Math.trunc(Number(iss.cueIndex)) : null;
      if (idx == null) continue;
      if (!warnMap.has(idx)) warnMap.set(idx, []);
      warnMap.get(idx).push(iss);
    }

    const failing = qc.byCue.filter(r => r && Array.isArray(r.failTypes) && r.failTypes.length);
    const warningOnly = qc.byCue.filter(r => r && (!Array.isArray(r.failTypes) || !r.failTypes.length) && Array.isArray(r.warnTypes) && r.warnTypes.length);

    if (!failing.length && !warningOnly.length) return;

    const showFail = failing.slice(0, maxShow);
    if (failing.length) {
      lines.push('');
      lines.push(`Failing ${cueLabel}s: ${failing.length}${failing.length > showFail.length ? ` (showing ${showFail.length})` : ''}`);
      for (const r of showFail) {
        const cueNum = Number.isFinite(Number(r.sourceIndex)) ? (Math.trunc(Number(r.sourceIndex)) + 1) : (Number.isFinite(Number(r.cueIndex)) ? (Math.trunc(Number(r.cueIndex)) + 1) : null);
        const where = (r.startTc && r.endTc) ? `${r.startTc}–${r.endTc}` : '';
        const idBit = (r.id != null) ? ` • id ${r.id}` : '';
        const cueBit = (cueNum != null) ? ` (${cueLabel} ${cueNum})` : '';
        lines.push(`• ${where}${cueBit}${idBit}`.trim());
        lines.push(`  Failures: ${r.failTypes.join(', ')}`);
        if (r.textSnippet) lines.push(`  Text: “${clampPreview(r.textSnippet, 140)}”`);

        const needsLines = new Set([...(r.failTypes || []), ...(r.warnTypes || [])]);
        const showLines = needsLines.has('maxCols') || needsLines.has('maxLines') || needsLines.has('lineBreak');
        if (showLines) {
          const rawLines = Array.isArray(r.lines)
            ? r.lines
            : (typeof r.textFlat === 'string' ? String(r.textFlat).split('\n') : []);
          const lim = Number.isFinite(Number(thresholds.maxLinesPerBlock)) ? Math.max(1, Math.min(6, Math.trunc(Number(thresholds.maxLinesPerBlock)))) : 2;
          const disp = rawLines.slice(0, lim).map(ln => clampPreview(String(ln ?? ''), 72));
          if (disp.length) {
            lines.push('  Rendered lines:');
            for (const ln of disp) lines.push(`    ${ln}`);
          }
        }

        const iss = (failMap.get(Math.trunc(Number(r.cueIndex))) || []);
        if (iss.length) {
          lines.push('  Details:');
          const byType = new Map();
          for (const it of iss) {
            const ty = String(it?.type || 'failure');
            if (!byType.has(ty)) byType.set(ty, []);
            byType.get(ty).push(it);
          }
          for (const ty of (r.failTypes || [])) {
            const arr = byType.get(ty) || [];
            if (!arr.length) continue;
            if (ty === 'maxCols' && arr.length > 1) {
              const linesBad = arr.slice(0, 3).map(x => fmtIssueMetric(x, thresholds)).filter(Boolean);
              const extra = arr.length > 3 ? ` (+${arr.length - 3} more line(s))` : '';
              lines.push(`    - ${ty}: ${linesBad.join(' • ')}${extra}`.trim());
            } else {
              const m = fmtIssueMetric(arr[0], thresholds);
              lines.push(`    - ${ty}${m ? `: ${m}` : ''}`);
            }
          }
        }
      }
      if (failing.length > showFail.length) {
        lines.push(`… and ${failing.length - showFail.length} more failing ${cueLabel}(s)`);
      }
    }

    const showWarn = warningOnly.slice(0, Math.min(maxShow, 25));
    if (warningOnly.length) {
      lines.push('');
      lines.push(`Warning-only ${cueLabel}s: ${warningOnly.length}${warningOnly.length > showWarn.length ? ` (showing ${showWarn.length})` : ''}`);
      for (const r of showWarn) {
        const cueNum = Number.isFinite(Number(r.sourceIndex)) ? (Math.trunc(Number(r.sourceIndex)) + 1) : (Number.isFinite(Number(r.cueIndex)) ? (Math.trunc(Number(r.cueIndex)) + 1) : null);
        const where = (r.startTc && r.endTc) ? `${r.startTc}–${r.endTc}` : '';
        const cueBit = (cueNum != null) ? ` (${cueLabel} ${cueNum})` : '';
        lines.push(`• ${where}${cueBit}`.trim());
        lines.push(`  Warnings: ${r.warnTypes.join(', ')}`);
        if (r.textSnippet) lines.push(`  Text: “${clampPreview(r.textSnippet, 140)}”`);
      }
      if (warningOnly.length > showWarn.length) {
        lines.push(`… and ${warningOnly.length - showWarn.length} more warning-only ${cueLabel}(s)`);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Content QC (dual grading / track-specific)
  // ---------------------------------------------------------------------------

  const qcSourceLabel = (qc) => {
    const src = String(qc?.source || '').trim().toLowerCase();
    if (src === 'decoded') return 'decoded from exported MCC output';
    if (src === 'projected') return 'projected from canonical cues (legacy 608 transform)';
    if (src === 'segments') return 'input segments (pre-encode QC)';
    return src || 'unknown';
  };

  const writeQcSection = (title, qc, { notes = [] } = {}) => {
    lines.push('');
    lines.push(`--- ${title} ---`);
    if (!qc) {
      lines.push('Not available.');
      return;
    }

    lines.push(`QC source: ${qcSourceLabel(qc)}`);
    for (const n of (Array.isArray(notes) ? notes : [])) {
      const msg = String(n || '').trim();
      if (msg) lines.push(`NOTE: ${msg}`);
    }

    if (qc.thresholds) lines.push(fmtThresholds(qc));
    if (qc.metrics) lines.push(fmtObserved(qc));

    lines.push(`Result: ${qc.ok ? 'PASS' : 'FAIL'} • failures ${qc.failures?.length || 0} • warnings ${qc.warnings?.length || 0}`);

    // Cue-oriented breakdown (makes it hard to misread why something failed).
    writeCueBreakdown(qc, { cueLabel: 'Cue', maxShow: 60 });

    // Raw issues (debug-friendly). Keep short; detailed cue breakdown is above.
    const f = _normalizeIssues(qc.failures, 'fail');
    const w = _normalizeIssues(qc.warnings, 'warn');
    const rawLine = (it, kind) => {
      const bullet = (kind === 'fail') ? '  >' : '  -';
      const ty = (typeof it === 'object' && it && it.type) ? String(it.type) : (kind === 'fail' ? 'failure' : 'warning');
      const msg = (typeof it === 'object' && it && it.message) ? String(it.message) : (typeof it === 'string' ? it : '');
      const metric = (typeof it === 'object') ? fmtIssueMetric(it, qc.thresholds) : '';
      const where = (typeof it === 'object') ? fmtQcRange(it) : '';
      return `${bullet} ${ty}${where ? ` ${where}` : ''}${metric ? ` • ${metric}` : ''}${msg ? ` • ${msg}` : ''}`.trim();
    };
    lines.push('');
    lines.push(...(f.length ? ['Failures (raw; first 20):'].concat(f.slice(0, 20).map(it => rawLine(it, 'fail'))) : ['Failures: (none)']));
    lines.push(...(w.length ? ['Warnings (raw; first 20):'].concat(w.slice(0, 20).map(it => rawLine(it, 'warn'))) : ['Warnings: (none)']));
  };

  const hasContentQc = !!contentQc;

  if (!hasContentQc) {
    lines.push('--- Content QC (CEA-708) ---');
    lines.push('Not run (skipped because structural validation failed before decode/QC).');
  } else {
    const tracks = (contentQc.tracks && typeof contentQc.tracks === 'object') ? contentQc.tracks : null;

    const qc708 = tracks ? (tracks.cea708 || null) : null;
    const qc608Effective = tracks ? (tracks.cea608 || null) : null;

    const qc608Legacy = tracks
      ? (tracks.legacy608 || ((qc608Effective && String(qc608Effective.source || '').toLowerCase() === 'projected') ? qc608Effective : null))
      : null;

    // --- Content QC (CEA-708) ---
    if (!qc708) {
      lines.push('');
      lines.push('--- Content QC (CEA-708) ---');
      if (contentQc.source === 'segments') {
        lines.push('Not run (decode-from-output unavailable; QC ran pre-encode on input segments).');
      } else {
        lines.push('Not run (708 decode disabled / no 708 cues decoded).');
      }
    } else {
      const notes = [];
      if (qc708.serviceNumber != null) notes.push(`Service ${qc708.serviceNumber}`);
      if (Array.isArray(qc708.availableServices) && qc708.availableServices.length) {
        notes.push(`708 services present: ${qc708.availableServices.join(', ')}`);
      }
      writeQcSection('Content QC (CEA-708)', qc708, { notes });
    }

    // --- Content QC (CEA-608) decoded (if present) ---
    if (qc608Effective && String(qc608Effective.source || '').toLowerCase() === 'decoded') {
      const notes = [];
      if (qc608Effective.include608Compatibility === false) notes.push('608 compatibility flagged OFF (unexpected for decoded 608)');
      writeQcSection('Content QC (CEA-608)', qc608Effective, { notes });
    } else {
      lines.push('');
      lines.push('--- Content QC (CEA-608) ---');
      if (!qc608Effective) {
        lines.push('Not available.');
      } else if (String(qc608Effective.source || '').toLowerCase() === 'projected') {
        lines.push('No embedded 608 track in file; effective 608 QC is the legacy projection (see next section).');
      } else {
        lines.push('Not run / not available.');
      }
    }

    // --- Content QC (CEA-608 Legacy Projection) ---
    if (qc608Legacy && String(qc608Legacy.source || '').toLowerCase() === 'projected') {
      const proj = (qc608Legacy.projected && typeof qc608Legacy.projected === 'object') ? qc608Legacy.projected : {};
      const notes = [];
      if (Number.isFinite(Number(proj.maxCols)) || Number.isFinite(Number(proj.maxLines))) {
        notes.push(`Projection settings: maxCols ${proj.maxCols ?? 32} • maxLines ${proj.maxLines ?? 2}`);
      }
      if (proj.allowBoundedRipple === true) {
        notes.push('Projection uses bounded file-start ripple (timing may shift slightly to satisfy preload behavior).');
      }
      writeQcSection('Content QC (CEA-608 Legacy Projection)', qc608Legacy, { notes });
    } else {
      lines.push('');
      lines.push('--- Content QC (CEA-608 Legacy Projection) ---');
      if (qc608Effective && String(qc608Effective.source || '').toLowerCase() === 'projected') {
        lines.push('See effective 608 QC above (projection is the effective 608 input).');
      } else {
        lines.push('Not run.');
      }
    }

    // --- Dual Grade Summary ---
    lines.push('');
    lines.push('--- Dual Grade Summary ---');
    const dual = (contentQc.dual && typeof contentQc.dual === 'object') ? contentQc.dual : null;
    if (!dual || dual.enabled !== true) {
      lines.push('Not run (dualGrade disabled).');
    } else {
      if (dual.headline) lines.push(`Summary: ${dual.headline}`);

      if (dual.grade708) {
        lines.push(`CEA-708: ${dual.grade708.ok ? 'PASS' : 'FAIL'} • cues ${Number(dual.grade708.cues || 0)} • service ${dual.grade708.serviceNumber ?? serviceNumber}`);
      } else {
        lines.push('CEA-708: N/A');
      }

      if (dual.grade608) {
        const src = String(dual.grade608.source || '').trim().toLowerCase();
        const srcLabel = (src === 'decoded')
          ? 'decoded from exported MCC output'
          : (src === 'projected' ? 'projected from canonical cues' : (src || 'unknown'));
        lines.push(`CEA-608: ${dual.grade608.ok ? 'PASS' : 'FAIL'} • cues ${Number(dual.grade608.cues || 0)} • source ${srcLabel}`);
      } else {
        lines.push('CEA-608: N/A');
      }

      if (dual.legacy608 && dual.grade608 && String(dual.grade608.source || '').trim().toLowerCase() !== 'projected') {
        lines.push(`CEA-608 legacy projection: ${dual.legacy608.ok ? 'PASS' : 'FAIL'} • cues ${Number(dual.legacy608.cues || 0)} • maxCols ${dual.legacy608.maxCols ?? 32} • maxLines ${dual.legacy608.maxLines ?? 2}`);
      }

      const unsafe = Array.isArray(dual.legacyUnsafeCues) ? dual.legacyUnsafeCues : [];
      lines.push(`Broadcast-safe but legacy-unsafe cues: ${unsafe.length}`);
    }

    // --- Broadcast-safe but legacy-unsafe cues ---
    lines.push('');
    lines.push('--- Broadcast-safe but legacy-unsafe cues ---');

    const dual2 = (contentQc.dual && typeof contentQc.dual === 'object') ? contentQc.dual : null;
    const unsafe = Array.isArray(dual2?.legacyUnsafeCues) ? dual2.legacyUnsafeCues : [];

    if (!dual2 || dual2.enabled !== true) {
      lines.push('Not available (dualGrade disabled).');
    } else if (!unsafe.length) {
      lines.push('(none)');
    } else {
      const qc608ForDetails = qc608Effective || null;
      const thr = (qc608ForDetails && qc608ForDetails.thresholds && typeof qc608ForDetails.thresholds === 'object') ? qc608ForDetails.thresholds : {};

      const maxShow = 200;
      const show = unsafe.slice(0, maxShow);

      lines.push(`Legacy QC source used for this label: ${String(dual2.grade608?.source || qc608ForDetails?.source || 'unknown')}`);
      lines.push(`Showing ${show.length}${unsafe.length > show.length ? ` of ${unsafe.length}` : ''} cues:`);

      const eps = Math.max(0, (1 / (Number(fps) || 30)) * 2);

      const overlapSec = (aStart, aEnd, bStart, bEnd) => {
        const s = Math.max(Number(aStart) || 0, Number(bStart) || 0);
        const e = Math.min(Number(aEnd) || 0, Number(bEnd) || 0);
        return Math.max(0, e - s);
      };

      const pick608RecsForCanonical = (canonItem) => {
        const by = Array.isArray(qc608ForDetails?.byCue) ? qc608ForDetails.byCue : [];
        if (!by.length) return [];

        const canonIdx = Number.isFinite(Number(canonItem?.sourceIndex)) ? Math.trunc(Number(canonItem.sourceIndex)) : null;
        const hasSourceIndex = by.some(r => Number.isFinite(Number(r?.sourceIndex)));

        let candidates = [];
        if (hasSourceIndex && canonIdx != null) {
          candidates = by.filter(r => Number.isFinite(Number(r?.sourceIndex)) && Math.trunc(Number(r.sourceIndex)) === canonIdx);
        }

        if (!candidates.length) {
          const s0 = Number(canonItem?.start) || 0;
          const e0 = Number(canonItem?.end) || s0;
          candidates = by.filter(r => {
            const s1 = Number(r?.start) || 0;
            const e1 = Number(r?.end) || s1;
            return overlapSec(s0 - eps, e0 + eps, s1, e1) > 0;
          });
        }

        return candidates.sort((a, b) => (Number(a?.start) || 0) - (Number(b?.start) || 0));
      };

      const metricForFail = (failType, rec) => {
        const ft = String(failType || '').trim();
        const r = rec && typeof rec === 'object' ? rec : {};
        const bits = [];
        const num = (v) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };

        if (ft === 'maxCols') {
          const actual = num(r.maxLineLen);
          const lim = num(thr.maxCharsPerLine);
          if (actual != null && lim != null) bits.push(`maxCols ${actual} > ${lim}`);
        } else if (ft === 'maxLines') {
          const actual = num(r.lineCount);
          const lim = num(thr.maxLinesPerBlock);
          if (actual != null && lim != null) bits.push(`maxLines ${actual} > ${lim}`);
        } else if (ft === 'cps') {
          const actual = num(r.cps);
          const lim = num(thr.maxCps);
          if (actual != null && lim != null) bits.push(`CPS ${actual.toFixed(2)} > ${lim}`);
        } else if (ft === 'wpm') {
          const actual = num(r.wpm);
          const lim = num(thr.maxWpm);
          if (actual != null && lim != null) bits.push(`WPM ${Math.round(actual)} > ${lim}`);
        } else if (ft === 'minDuration') {
          const actual = num(r.durationSec);
          const lim = num(thr.minDurationSec);
          if (actual != null && lim != null) bits.push(`duration ${actual.toFixed(3)}s < ${lim}s`);
        } else if (ft === 'maxDuration') {
          const actual = num(r.durationSec);
          const lim = num(thr.maxDurationSec);
          if (actual != null && lim != null) bits.push(`duration ${actual.toFixed(3)}s > ${lim}s`);
        } else if (ft === 'minGap') {
          const actual = num(r.gapAfterSec);
          const lim = num(thr.minGapSec);
          const next = String(r.nextStartTc || '').trim();
          if (actual != null && lim != null) bits.push(`gap ${actual.toFixed(3)}s < ${lim}s${next ? ` (next @ ${next})` : ''}`);
        } else if (ft === 'overlap') {
          const actual = num(r.overlapAfterSec);
          const next = String(r.nextStartTc || '').trim();
          if (actual != null) bits.push(`overlap ${actual.toFixed(3)}s${next ? ` (next @ ${next})` : ''}`);
        }

        return bits.join(' • ');
      };

      for (const it of show) {
        const canonIdx = Number.isFinite(Number(it?.sourceIndex)) ? Math.trunc(Number(it.sourceIndex)) : null;
        const cueNum = (canonIdx != null) ? (canonIdx + 1) : null;

        const where = (it && it.startTc && it.endTc) ? `${it.startTc}–${it.endTc}` : '';
        const failTypes = Array.isArray(it?.legacyFailTypes) ? it.legacyFailTypes : [];
        const canonicalSnippet = String(it?.canonicalSnippet || '').trim();

        lines.push('');
        lines.push(`• ${where}${cueNum != null ? ` (cue ${cueNum})` : ''}${it?.cueId != null ? ` • id ${it.cueId}` : ''}`.trim());
        lines.push(`  608 failures: ${failTypes.length ? failTypes.join(', ') : '(unknown)'}`);

        if (canonicalSnippet) {
          lines.push(`  Canonical: “${clampPreview(canonicalSnippet, 140)}”`);
        }

        const recs = pick608RecsForCanonical(it);
        const showRecs = recs.slice(0, 3);

        // Show 608 on-air lines for context (trimmed), especially useful for maxCols/maxLines issues.
        if (showRecs.length) {
          lines.push(`  608 rendered (${recs.length} part${recs.length === 1 ? '' : 's'}):`);
          const maxLinesShow = Number.isFinite(Number(thr.maxLinesPerBlock)) ? Math.max(1, Math.min(6, Math.trunc(Number(thr.maxLinesPerBlock)))) : 2;

          for (let i = 0; i < showRecs.length; i++) {
            const r = showRecs[i] || {};
            const rWhere = (r.startTc && r.endTc) ? `${r.startTc}–${r.endTc}` : '';
            lines.push(`    - ${rWhere}`.trimEnd());

            const rawLines = Array.isArray(r.lines)
              ? r.lines
              : (typeof r.text === 'string' ? String(r.text).split('\n') : []);

            const disp = rawLines.slice(0, maxLinesShow).map(l => clampPreview(String(l ?? ''), 72));
            if (disp.length) {
              for (const ln of disp) lines.push(`      ${ln}`);
            } else if (r.textFlat) {
              lines.push(`      ${clampPreview(String(r.textFlat || ''), 72)}`);
            }
          }
          if (recs.length > showRecs.length) lines.push(`    … and ${recs.length - showRecs.length} more 608 part(s)`);
        } else {
          lines.push('  608 rendered: (no matching 608 cues found)');
        }

        // Fail metrics (actual vs threshold where available).
        if (qc608ForDetails && failTypes.length) {
          lines.push('  Details:');
          for (const ft of failTypes) {
            const rec = recs.find(r => Array.isArray(r?.failTypes) && r.failTypes.includes(ft)) || recs[0] || null;
            const detail = metricForFail(ft, rec);
            lines.push(`    - ${ft}${detail ? `: ${detail}` : ''}`);
          }
        }
      }

      if (unsafe.length > show.length) {
        lines.push('');
        lines.push(`… and ${unsafe.length - show.length} more legacy-unsafe cues not shown (limit ${maxShow}).`);
      }
    }
  }

  lines.push('');
  lines.push('--- Structural QC (MCC format / ANC / CDP) ---');
  if (!structuralQc) {
    lines.push('Not run.');
  } else {
    lines.push(`Result: ${structuralQc.ok ? 'PASS' : 'FAIL'}`);
    if (structuralQc.summary) lines.push(`Summary: ${structuralQc.summary}`);

    const sErrors = Array.isArray(structuralQc.errors) ? structuralQc.errors : [];
    const sWarns = Array.isArray(structuralQc.warnings) ? structuralQc.warnings : [];

    const categoryFor = (iss) => {
      const t = String(iss?.type || '').toLowerCase();
      if (t.startsWith('header')) return 'Header';
      if (t.startsWith('timecode') || t === 'monotonic' || t === 'smpte12m') return 'Timecode';
      if (t === 'payload') return 'Payload';
      if (t.startsWith('anc')) return 'ANC';
      if (t === 'sequence') return 'Sequence';
      if (t.startsWith('cdp') || t.startsWith('cc_count') || t === 'cea708') return 'CDP';
      if (t.startsWith('round') || t === 'round_trip' || t === 'roundtrip') return 'RoundTrip';
      return 'Other';
    };

    const hintForCode = (code) => {
      const c = String(code || '').trim();
      const hints = {
        // Header
        'E_MCC_HEADER_MISSING': 'Add a standard MCC header (File Format, Time Code Rate, Drop Frame, Caption Service, Language, etc.).',
        'E_MCC_HEADER_FILE_FORMAT': 'Header must include `File Format=MacCaption_MCC V1.0` or `V2.0`.',
        'E_MCC_HEADER_TIME_CODE_RATE': 'Header must include `Time Code Rate=<24|25|30|30DF|50|60|60DF>`.',
        'E_MCC_HEADER_TIME_CODE_RATE_FORMAT': 'Time Code Rate must be an integer base (24/25/30/50/60) optionally suffixed with DF (30DF/60DF).',
        'E_MCC_HEADER_VERSION_RATE_COMBO': 'Some rates require V2.0 (e.g., 60DF). Prefer `File Format=MacCaption_MCC V2.0` for modern deliverables.',
        'W_MCC_HEADER_DROP_FRAME_MISSING': 'Include `Drop Frame=True/False` in the header (recommended for determinism).',

        // Timecode
        'E_MCC_TIMECODE_DELIM': 'Timecode must be `HH:MM:SS:FF` or `HH:MM:SS;FF` (V2 may include `.field,line` suffix).',
        'E_MCC_TIMECODE_PARSE': 'Timecode label is malformed. Check zero-padding and frame range.',
        'E_MCC_TIMECODE_MONOTONIC': 'Timecodes must be non-decreasing. Sort rows or fix duplicated/out-of-order lines.',
        'E_MCC_TIMECODE_STEP': 'Frame-to-frame progression should be contiguous (no gaps) when exporting one row per frame.',
        'W_MCC_TIMECODE_MIXED_DELIMS': 'Use a consistent timecode delimiter throughout the file.',

        // Payload
        'E_MCC_PAYLOAD_PARSE': 'Payload must be valid MCC hex/macros (no spaces, only valid Telestream macros, even nibble count).',

        // ANC
        'E_MCC_ANC_DID_SDID': 'ANC DID/SDID should be 0x61/0x01 for EIA-708 CDP inside MCC.',
        'E_MCC_ANC_LENGTH': 'ANC DC must match payload length (DC+4). Fix DC or payload truncation.',
        'E_MCC_ANC_CHECKSUM': 'ANC checksum byte is wrong. Recompute checksum or re-export from source.',

        // CDP
        'E_MCC_CDP_IDENTIFIER': 'CDP must begin with 0x96 0x69.',
        'E_MCC_CDP_LENGTH': 'CDP length field must equal the actual CDP byte count.',
        'E_MCC_CDP_CHECKSUM': 'CDP checksum must make the full CDP byte-sum equal 0 modulo 256.',
        'E_MCC_CC_COUNT': 'CC count field does not match the number of triplets present.',
        'W_MCC_CDP_SEQUENCE_NONCONTIG': 'Sequence counters should increment by 1; gaps may indicate missing or duplicated frames.'        ,

        // Round-trip
        'W_MCC_ROUNDTRIP_708_MISMATCH': 'The 708 decode view differs after an encode→decode round-trip. This usually indicates a regression in 708 packetization or unsupported characters. Try re-exporting with simplified styling or disable preserveImported708Layout if applicable.',
        'W_MCC_ROUNDTRIP_608_MISMATCH': 'The forced-608 decode view differs after an encode→decode round-trip. Check 608 shaping/wrap settings, safe margins, and any compat608 overrides. If this appears unexpectedly, the 608 compatibility track may be malformed.',
        'W_MCC_ROUNDTRIP_ERROR': 'Round-trip QC could not run. This suggests the decoder failed to parse the generated MCC payload (or decode crashed).'

      };
      return hints[c] || '';
    };

    const groupIssues = (issues) => {
      const catMap = new Map();
      for (const iss of issues) {
        if (!iss || typeof iss !== 'object') continue;
        const cat = categoryFor(iss);
        if (!catMap.has(cat)) catMap.set(cat, new Map());
        const key = String(iss.code || iss.type || 'UNKNOWN').trim() || 'UNKNOWN';
        const m = catMap.get(cat);
        if (!m.has(key)) m.set(key, { code: key, count: 0, first: iss });
        const rec = m.get(key);
        rec.count += 1;
      }
      return catMap;
    };

    const writeGrouped = (label, issues) => {
      if (!issues.length) return;
      lines.push('');
      lines.push(`${label} (grouped / actionable):`);
      const catMap = groupIssues(issues);
      const catOrder = ['Header', 'Timecode', 'CDP', 'ANC', 'Payload', 'Sequence', 'RoundTrip', 'Other'];
      for (const cat of catOrder) {
        const m = catMap.get(cat);
        if (!m || m.size === 0) continue;
        const groups = Array.from(m.values()).sort((a, b) => (b.count || 0) - (a.count || 0));
        const total = groups.reduce((acc, g) => acc + (g.count || 0), 0);
        lines.push(`• ${cat} (${total})`);
        for (const g of groups) {
          const first = g.first || {};
          const where = first.timecode ? `${first.timecode}` : (first.line ? `L${first.line}` : 'n/a');
          const msg = String(first.message || '').trim();
          lines.push(`  - ${g.code} ×${g.count} • first @ ${where}${msg ? ` • ${msg}` : ''}`);
          const hint = hintForCode(g.code);
          if (hint) lines.push(`      Hint: ${hint}`);
        }
      }
    };

    lines.push(`Errors: ${sErrors.length}`);
    writeGrouped('Errors', sErrors);
    if (sErrors.length) {
      lines.push('');
      lines.push('Errors (raw list; first 30):');
      lines.push(...sErrors.slice(0, 30).map(e => `- [${e.code || ''}] L${e.line || 0} ${e.type || 'error'}: ${e.message || ''}${e.timecode ? ` [${e.timecode}]` : ''}`));
      if (sErrors.length > 30) lines.push(`  ... ${sErrors.length - 30} more`);
    }

    lines.push(`Warnings: ${sWarns.length}`);
    writeGrouped('Warnings', sWarns);
    if (sWarns.length) {
      lines.push('');
      lines.push('Warnings (raw list; first 30):');
      lines.push(...sWarns.slice(0, 30).map(w => `- [${w.code || ''}] L${w.line || 0} ${w.type || 'warn'}: ${w.message || ''}${w.timecode ? ` [${w.timecode}]` : ''}`));
      if (sWarns.length > 30) lines.push(`  ... ${sWarns.length - 30} more`);
    }
  }
  writeAtomic(reportPath, lines.join('\n'), 'utf8');
  return { reportPath };
}

async function writeXML(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.xml`));
  // Keep writer behavior in parity with preview: honor the configured timecode style.
  // transcribeEngine.generateXML already accepts (segments, style).
  const style = (config && config.timecodeStyle) || (wrapped && wrapped.metadata && wrapped.metadata.timecodeStyle) || 'colon';
  const fps = wrapped?.system?.fps || config.fps || 30;
  const dropPref = config?.dropFrame ?? wrapped?.system?.dropFramePreferred ?? wrapped?.system?.dropFrame;
  const dfCapable = isDropFrameRate(fps);
  const dropFrame = dfCapable && (dropPref === true || dropPref == null);
  const generateXml = getTranscribeEngineMethod('generateXML');
  const xml = generateXml(wrapped.segments, style, fps, dropFrame);
  writeAtomic(outPath, xml, 'utf8');
  return [`📝 XML → ${outPath}`];
}

async function writeScript(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.sync.csv`));
  const scriptFormat = config?.formats?.script || {};
  const fpsCandidates = [
    Number(scriptFormat.frameRateOverride),
    Number(config?.fpsOverride),
    Number(wrapped?.system?.fps),
    Number(config?.fps)
  ];
  const resolvedFps = fpsCandidates.find(v => Number.isFinite(v) && v > 0) || 30;
  const resolvedTimecodeFormat =
    scriptFormat.timecodeFormat ||
    config?.timecodeStyle ||
    (config?.dropFrame ? 'df' : 'ndf');
  const scriptOptions = {
    fps: resolvedFps,
    timecodeFormat: resolvedTimecodeFormat,
    startTimecodeOffset: scriptFormat.startTimecodeOffset || config?.startTC || null,
    includeSpeakers:
      scriptFormat.includeSpeakers ?? config?.includeSpeakerNames ?? true,
    includeTimecodes: scriptFormat.includeTimecodes ?? true,
    groupBySpeaker: !!scriptFormat.groupBySpeaker,
    speakerStyle: scriptFormat.speakerLabelStyle || 'title',
    timestampStyle: (scriptFormat.timestampPlacement || 'start-end').replace(/_/g, '-')
  };
  const generateSyncableScriptCsv = getTranscribeEngineMethod('generateSyncableScriptCSV');
  const csv = generateSyncableScriptCsv(
    wrapped,
    scriptOptions
  );
  writeAtomic(outPath, csv, 'utf8');
  return [`📓 Script → ${outPath}`];
}

async function writeMarkers(wrapped, filePath, config) {
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.markers.txt`));
  const dropPref = config?.dropFrame ?? wrapped.system.dropFramePreferred ?? wrapped.system.dropFrame;
  const dropFrame = Boolean(dropPref && isDropFrameRate(wrapped.system.fps));
  const generateMarkersTxt = getTranscribeEngineMethod('generateMarkersTXT');
  const text = generateMarkersTxt(
    wrapped.segments,
    wrapped.system.fps,
    wrapped.metadata.timecodeStyle,
    dropFrame
  );
  writeAtomic(outPath, text, 'utf8');
  return [`📌 Markers → ${outPath}`];
}

async function writeTokenAlignedTXT(wrapped, filePath, config) {
  const outPath = ensureUnique(
    path.join(config.outputPath, `${getFilename(filePath)}.tokenAligned.txt`)
  );
  const fmt = config.txtOptions?.timestampStyle || 'FF';
  const generateSegmentTextWithTokenTiming = getTranscribeEngineMethod('generateSegmentTextWithTokenTiming');
  const text = generateSegmentTextWithTokenTiming(
    wrapped.segments,
    fmt
  );
  writeAtomic(outPath, text, 'utf8');
  return [`🧠 Token-Aligned TXT → ${outPath}`];
}

async function writeBurnIn(wrapped, filePath, config) {
  fs.mkdirSync(config.outputPath, { recursive: true });
  const resolvedFilePath = filePath || config?.files?.[0];
  if (!resolvedFilePath) {
    throw new Error('writeBurnIn: missing source file path for burn-in.');
  }
  const keepTempArtifacts = ['1', 'true'].includes(String(process.env.LEADAE_KEEP_TEMP || '').trim().toLowerCase());
  const tempDir = ensureTempSubdir('subtitle', 'burnin');
  const jobSlug = String(config?.jobId ?? 'job').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const fileHash = crypto.createHash('sha1').update(String(resolvedFilePath)).digest('hex').slice(0, 12);
  const tempSubdir = path.join(tempDir, jobSlug, fileHash);
  fs.mkdirSync(tempSubdir, { recursive: true });
  const srtPath = path.join(tempSubdir, `${getFilename(resolvedFilePath)}.srt`);
  const segments = wrapped.finalWords
    ? wrapped.finalWords.map(w => ({
        start: w.start,
        end: w.end,
        text: w.text || w.word,
        speaker: w.speaker
      }))
    : wrapped.segments;
  if (!srtWriter || typeof srtWriter.generateSRT !== 'function') {
    throw new Error('Burn-in export failed: SRT writer unavailable');
  }
  const srt = srtWriter.generateSRT(segments, { ...config, strictTiming: true });
  writeAtomic(srtPath, srt, 'utf8');
  let result;
  try {
    const burnInSubtitles = getTranscribeEngineMethod('burnInSubtitles');
    result = await burnInSubtitles(
      resolvedFilePath,
      srtPath,
      config.outputPath
    );
  } finally {
    if (!keepTempArtifacts) {
      // Clean up the whole job folder so we don't leave thousands of empty job dirs.
      try {
        fs.rmSync(tempSubdir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }

      // Best-effort prune parent folders if they became empty.
      try {
        const jobDir = path.dirname(tempSubdir);
        if (fs.existsSync(jobDir) && fs.readdirSync(jobDir).length === 0) {
          fs.rmdirSync(jobDir);
        }
      } catch {}
    }
  }
  return [result];
}

async function writeFinalJSON(wrapped, filePath, config) {
  // Re-assert tri-format timecode metadata at write time to prevent drift.
  try {
    const fps =
      (wrapped && wrapped.system && wrapped.system.fps) ||
      (typeof config?.fps === 'number' ? config.fps : Number(config?.fps)) ||
      29.97;
    if (Array.isArray(wrapped?.segments)) {
      const sysPick = wrapped?.system?.timecodeRepresentations;
      const pick = sysPick
        ? sysPick
        : ((config.timecodeStyle === 'ms')
            ? { ndf: false, df: false, ms: true }
            : (config.dropFrame ? { ndf: false, df: true, ms: false }
                                : { ndf: true, df: false, ms: false }));
      addFullTimecodeMetadata(wrapped.segments, fps, /*ignored*/ false, pick);
      stripLegacyTimecodeFields(wrapped.segments);
    }
  } catch (e) {
    console.warn('writeFinalJSON: reapply timecode metadata failed:', e);
  }
  const outPath = ensureUnique(path.join(config.outputPath, `${getFilename(filePath)}.final.json`));
  writeAtomic(outPath, JSON.stringify(wrapped, null, 2));
  return [`📝 Final JSON → ${outPath}`];
}

function buildCorrectedJsonPayload(cues, meta = {}) {
  // Use the writing-context FPS/DF so labels match the project timing.
  const fps = Number(meta?.fps) || 29.97;
  const dfCapable = isDropFrameRate(fps);
  const dropFrame = !!meta?.dropFrame && dfCapable;
  const style = meta?.timecodeStyle;
  const pick =
    style === 'ms'
      ? 'ms'
      : style === 'df' && dropFrame
        ? 'df'
        : style === 'ndf'
          ? 'ndf'
          : (dropFrame ? 'df' : 'ndf');

  return {
    type: 'subtitleCorrection',
    schemaVersion: 2,
    correctedAt: new Date().toISOString(),
    cues: (cues || []).map(cue => {
      // Phase 1: canonical+overrides schema (kept alongside legacy flattened fields).
      const v2 = serializeCueV2(cue);
      const start = Number(cue.start) || 0;
      const end   = Number(cue.end)   || start;

      // Emit only the chosen representation
      const tc =
        pick === 'ms'
          ? { ms: { start: Math.max(0, toMs(start)), end: Math.max(0, toMs(end)) } }
          : pick === 'df'
              ? { df: {
                  start: formatTimecode(start, dropFrame, fps, 'colon'),
                  end: formatTimecode(end, dropFrame, fps, 'colon'),
                  dfCapable
                } }
              : { ndf: {
                  start: formatTimecode(start, false, fps, 'colon'),
                  end: formatTimecode(end, false, fps, 'colon')
                } };

      return {
        id: cue.id,
        ...(v2 && typeof v2 === 'object' ? { canonical: v2.canonical, overrides: v2.overrides } : {}),
        start, end,
        text: cue.text,
        speaker: cue.speaker || null,
        timecodes: tc,
        // new: keep editor placements
        sccPlacement: cue.sccPlacement ? { ...cue.sccPlacement } : undefined,
        // Milestone 3: optional per-cue 608 override (kept separate from canonical text)
        compat608: (cue.compat608 && typeof cue.compat608 === 'object')
          ? {
              ...cue.compat608,
              ...(Array.isArray(cue.compat608.lines)
                ? { lines: cue.compat608.lines.map(line => String(line || '')) }
                : {})
            }
          : undefined,
        compat608Text: (typeof cue.compat608Text === 'string' && cue.compat608Text.length)
          ? cue.compat608Text
          : undefined
      };
    }),
    meta: {
      ...meta,
      fps,
      dropFrame,
      dfCapable,
      timecodeStyle: pick
    }
  };
}

async function writeCorrectedJson(cues, targetDir, baseName, meta = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const outPath = ensureUnique(path.join(targetDir, `${baseName}.corrected.final.json`));
  const payload = buildCorrectedJsonPayload(cues, meta);

  writeAtomic(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function writeCorrectedJsonToPath(cues, outPath, meta = {}) {
  if (!outPath) throw new Error('Corrected JSON export failed: output path missing');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = buildCorrectedJsonPayload(cues, meta);
  writeAtomic(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function writeCorrectedSRT(cues, targetDir, baseName, config = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const outPath = ensureUnique(path.join(targetDir, `${baseName}.corrected.srt`));
  const segments = cues.map(cue => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
    speaker: cue.speaker
  }));
  const genSrt = (srtWriter && typeof srtWriter.generateSRT === 'function')
    ? srtWriter.generateSRT
    : null;
  if (!genSrt) {
    throw new Error('Corrected SRT export failed: SRT writer unavailable');
  }

  const srt = genSrt(segments, { ...config, strictTiming: true });
  writeAtomic(outPath, srt, 'utf8');

  // Phase 8: QC sidecars for corrected exports as well.
  writeSrtQcArtifacts({ srtText: srt, outPath, config, srcLabel: baseName });

  return outPath;
}

async function writeCorrectedSRTToPath(cues, outPath, config = {}) {
  if (!outPath) throw new Error('Corrected SRT export failed: output path missing');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const segments = cues.map(cue => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
    speaker: cue.speaker
  }));
  const genSrt = (srtWriter && typeof srtWriter.generateSRT === 'function')
    ? srtWriter.generateSRT
    : null;
  if (!genSrt) {
    throw new Error('Corrected SRT export failed: SRT writer unavailable');
  }

  const srt = genSrt(segments, { ...config, strictTiming: true });
  writeAtomic(outPath, srt, 'utf8');

  // Phase 8: QC sidecars for corrected exports as well.
  writeSrtQcArtifacts({ srtText: srt, outPath, config, srcLabel: path.basename(outPath) });

  return outPath;
}

async function writeCorrectedVTT(cues, targetDir, baseName, config = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const outPath = ensureUnique(path.join(targetDir, `${baseName}.corrected.vtt`));
  const segments = cues.map(cue => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
    speaker: cue.speaker
  }));
  const vtt = vttWriter.generateVTT(segments, config);
  writeAtomic(outPath, vtt, 'utf8');

  // Phase 5: write QC sidecars for corrected exports as well.
  writeVttQcArtifacts({ vttText: vtt, outPath, config, srcLabel: baseName });

  return outPath;
}

async function writeCorrectedVTTToPath(cues, outPath, config = {}) {
  if (!outPath) throw new Error('Corrected VTT export failed: output path missing');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const segments = cues.map(cue => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
    speaker: cue.speaker
  }));
  const vtt = vttWriter.generateVTT(segments, config);
  writeAtomic(outPath, vtt, 'utf8');

  // Phase 5: write QC sidecars for corrected exports as well.
  writeVttQcArtifacts({ vttText: vtt, outPath, config, srcLabel: path.basename(outPath) });

  return outPath;
}

async function writeAllOutputs(wrapped, filePath, config) {
  const writers = {
    txt: writeTXT,
    json: writeJSON,
    finalJson: writeFinalJSON,
    srt: writeSRT,
    vtt: writeVTT,
    // NEW:
    scc: writeSCC,
    mcc: writeMCC,
    xml: writeXML,
    script: writeScript,
    markers: writeMarkers,
    burnIn: writeBurnIn,
    tokenAlignedTxt: writeTokenAlignedTXT
  };

  const selected = Object.entries(config.outputFormats).filter(([, v]) => v);
  const outputLogs = [];
  const sccExportPolicy = String(config?.sccOptions?.exportPolicy || '').trim().toLowerCase();
  const sccGate =
    // Only hard-fail SCC exports when explicitly requested.
    // (Parity with MCC: qc.gate + deliverable exportPolicy modes should propagate failure.)
    config?.sccOptions?.qc?.gate === true ||
    config?.sccOptions?.qc?.failJob === true ||
    config?.sccOptions?.qcGate === true ||
    sccExportPolicy === 'gate_write' ||
    sccExportPolicy === 'gate_block';
  const mccGate =
    config?.mccOptions?.qc?.gate === true ||
    config?.mccOptions?.qc?.failJob === true ||
    config?.mccOptions?.qcGate === true ||
    config?.mccOptions?.exportPolicy === 'gate_write' ||
    config?.mccOptions?.exportPolicy === 'gate_block';

  let anySuccess = false;
  let lastError = null;

  for (const [format] of selected) {
    const writer = writers[format];
    if (writer) {
      try {
        const log = await writer(wrapped, filePath, config);
        outputLogs.push(...[].concat(log));
        anySuccess = true;
      } catch (err) {
        lastError = err;
        outputLogs.push(`❌ ${format.toUpperCase()} export failed: ${err.message}`);
        // Optional strict gating: only fail the whole job on SCC when explicitly enabled.
        if (format === 'scc' && sccGate) {
          throw err;
        }
        if (format === 'mcc' && mccGate) {
          throw err;
        }
      }
    } else if (format === 'cap') {
      // Legacy configs may still request CAP. Be explicit.
      outputLogs.push('❌ CAP export is no longer supported.');
    }
  }

  if (!anySuccess && lastError) {
    throw lastError;
  }

  return outputLogs;
}

function validateTiming(
  segments = [],
  { fps = 29.97, dropFrame = true, maxBlockSec = 6 } = {}
) {
  const out = { longBlocks: [], overlaps: [], count: 0 };
  const tc = (sec) => formatTimecode(sec, dropFrame, fps);
  const pickLabel = (s, which) => {
    const t = s?.timecodes;
    if (!t) return null;
    // prefer DF label when DF is active, else NDF
    return dropFrame ? (t.df?.[which] || t.ndf?.[which] || null)
                     : (t.ndf?.[which] || t.df?.[which] || null);
  };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] || {};
    const start = Number.isFinite(s.start) ? s.start : (s.msStart ?? 0) / 1000;
    const end = Number.isFinite(s.end)
      ? s.end
      : (s.msEnd ?? start * 1000) / 1000;
    const dur = Math.max(0, end - start);
    if (dur > maxBlockSec) {
      out.longBlocks.push({
        index: s.id ?? i,
        startTc: pickLabel(s, 'start') || tc(start),
        endTc: pickLabel(s, 'end') || tc(end),
        durationSec: Number(dur.toFixed(3)),
        text: String(s.text || '').trim().slice(0, 80)
      });
    }
    if (i + 1 < segments.length) {
      const next = segments[i + 1] || {};
      const nextStart = Number.isFinite(next.start)
        ? next.start
        : (next.msStart ?? 0) / 1000;
      if (end > nextStart) {
        out.overlaps.push({
          index: s.id ?? i,
          endTc: pickLabel(s, 'end') || tc(end),
          nextStartTc: pickLabel(next, 'start') || tc(nextStart),
          overlapMs: Math.round((end - nextStart) * 1000),
          text: String(s.text || '').trim().slice(0, 80)
        });
      }
    }
  }
  out.count = out.longBlocks.length + out.overlaps.length;
  return out;
}

function _strip608QcText(input) {
  // Remove HTML tags, SCC placement tags, and mid-row style tokens.
  let s = String(input || '');
  s = s.replace(/<[^>]*>/g, '');
  // Remove common editor/encoder tags: {row:15}{col:0}{pac:....}{NOP}{Wh}{GrU}...
  s = s.replace(/\{\s*(row|col|pac)\s*:\s*[^}]+\}\s*/gi, '');
  s = s.replace(/\{\s*(NOP)\s*\}\s*/gi, '');
  s = s.replace(/\{\s*(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\s*\}\s*/g, '');
  // Normalize whitespace but keep explicit line breaks for line-break heuristics
  s = s.replace(/\r\n?/g, '\n');
  return s;
}

function validateSccContentQc(segments = [], {
  fps = 29.97,
  dropFrame = true,
  startTc = null,
  // If provided, QC is computed from the FINAL SCC output (decoded back into cues)
  // so wrapping/line breaks are assessed exactly as delivered.
  sccText = null,
  maxCharsPerLine = null,
  maxLinesPerBlock = null,
  safeMargins = null,

  // thresholds (override per deliverable)
  maxCps = 20,              // chars/sec (excluding whitespace)
  maxWpm = 180,             // words/min
  minDurationSec = 0.80,    // blocks shorter than this read as “flashing”
  maxDurationSec = null,    // optional hard cap; pass from UI (e.g. maxDurationSeconds)
  maxDurationSeconds = null, // alias
  minGapSec = 0.10,         // gaps smaller than this can feel like flicker

  // late-EOC enforcement (encoder side computes these)
  maxLateEocSec = 0.10,
  maxLateEocCount = 0,

  // observed (optional)
  lateEocCount = 0,
  maxLateEocSecObserved = 0,
  unshowableCueCount = 0,
  maxUnshowableLateSecObserved = 0,

  // limits for report verbosity
  maxItems = 50
} = {}) {
  const hasPositiveLimit = (v) => Number.isFinite(Number(v)) && Number(v) > 0;

  const out = {
    ok: true,
    failures: [],
    warnings: [],
    thresholds: {
      maxCps, maxWpm, minDurationSec,
      maxDurationSec: (maxDurationSec ?? maxDurationSeconds),
      minGapSec,
      maxLateEocSec, maxLateEocCount,
      maxUnshowableCueCount: 0
    },
    metrics: {
      cues: 0,
      maxCps: 0,
      maxWpm: 0,
      maxDurationSec: 0,
      minDurationSec: Infinity,
      minGapSec: Infinity,
      lateEocCount,
      maxLateEocSec: maxLateEocSecObserved,
      unshowableCueCount,
      maxUnshowableLateSec: maxUnshowableLateSecObserved
    }
  };

  const { parseTime: parseTimeMs } = require('../utils/timeUtils');

  const startOffsetSec = (() => {
    const raw = String(startTc || '').trim();
    if (!raw) return 0;
    try {
      const ms = parseTimeMs(raw, fps, null);
      const sec = (typeof ms === 'number' && !Number.isNaN(ms)) ? (ms / 1000) : 0;
      return Number.isFinite(sec) ? sec : 0;
    } catch {
      return 0;
    }
  })();

  // baseOffsetSec is applied only when we're QC'ing 0-based segment times.
  // When QC is computed from decoded SCC cues (absolute program time), we must NOT add Start TC again.
  let baseOffsetSec = startOffsetSec;

  const labelFor = (seg, which, secFallback) => {
    const t = seg?.timecodes;
    const pref = dropFrame ? (t?.df?.[which] || t?.ndf?.[which]) : (t?.ndf?.[which] || t?.df?.[which]);
    if (typeof pref === 'string' && pref) return pref;
    // SCC encoder applies Start TC as an offset for numeric times; mirror that for labels.
    const sec = Number(secFallback) + (baseOffsetSec || 0);
    return formatTimecode(sec, dropFrame, fps, 'colon');
  };

  // Decide which source to QC:
  //  1) If we have SCC text, decode it and QC the decoded cues.
  //  2) Otherwise fall back to the input segments array.
  let cleaned = (Array.isArray(segments) ? segments : []).map(s => s || {});
  if (sccText) {
    try {
      const { decodeSccText } = require('../modules/sccDecoder');
      const dec = decodeSccText(String(sccText), { fps, dropFrame, keepAbsoluteTimecode: true });
      if (dec && dec.keepAbsoluteTimecode === true) baseOffsetSec = 0;
      if (dec && Array.isArray(dec.cues) && dec.cues.length) {
        cleaned = dec.cues.map((c, idx) => ({
          id: idx,
          start: c.start,
          end: c.end,
          text: Array.isArray(c.lines) ? c.lines.join('\n') : (c.text || '')
        }));
        // Some SCCs (and some encoders) redundantly re-display (or "stutter") blocks.
        // Collapse duplicates that share the same frame-aligned time range, keeping the
        // most "complete" (longest) text. This stabilizes QC counts/reports and prevents
        // confusing duplicated timecodes in the report.
        const byRange = new Map();
        let collapsed = 0;
        for (const c of cleaned) {
          const sFr = toFrameStart(Number(c.start || 0), fps);
          const eFr = toFrameEnd(Number(c.end || 0), fps);
          const key = `${sFr}|${eFr}`;
          const prev = byRange.get(key);
          if (!prev) {
            byRange.set(key, c);
            continue;
          }
          collapsed += 1;
          const prevLen = String(prev.text || '').replace(/\s+/g, '').length;
          const curLen  = String(c.text || '').replace(/\s+/g, '').length;
          if (curLen >= prevLen) byRange.set(key, c);
        }
        cleaned = Array.from(byRange.values());
        out.metrics.collapsedDuplicateCueRanges = collapsed;
      }
    } catch {}
  }
  cleaned = cleaned.map(s => ({ ...s, text: _strip608QcText(s?.text || '') }));
  const cues = cleaned.length;
  out.metrics.cues = cues;

  // Compute effective max columns with title-safe margins if provided.
  const safeLeft  = Number(safeMargins?.left ?? 0);
  const safeRight = Number(safeMargins?.right ?? 0);
  const safeWidth = (Number.isFinite(safeLeft) && Number.isFinite(safeRight))
    ? Math.max(1, 32 - safeLeft - safeRight)
    : null;
  const effMaxCols = hasPositiveLimit(maxCharsPerLine)
    ? (Number.isFinite(safeWidth) ? Math.min(Number(maxCharsPerLine), safeWidth) : Number(maxCharsPerLine))
    : (Number.isFinite(safeWidth) ? safeWidth : null);

  // Duration + reading-rate per cue
  for (let i = 0; i < cleaned.length; i++) {
    const seg = cleaned[i];
    const start = Number.isFinite(seg.start) ? seg.start : (Number(seg.msStart) || 0) / 1000;
    let end = Number.isFinite(seg.end) ? seg.end : (Number(seg.msEnd) || NaN) / 1000;

    // Fallback end if missing: next cue start, else a small tail
    if (!Number.isFinite(end) || end <= start) {
      const next = cleaned[i + 1];
      const ns = next ? (Number.isFinite(next.start) ? next.start : (Number(next.msStart) || NaN) / 1000) : NaN;
      end = (Number.isFinite(ns) && ns > start) ? ns : (start + Math.max(1 / (Number(fps) || 30), 0.5));
    }

    const dur = Math.max(0, end - start);
    out.metrics.maxDurationSec = Math.max(out.metrics.maxDurationSec, dur);
    out.metrics.minDurationSec = Math.min(out.metrics.minDurationSec, dur);

    const startTc = labelFor(seg, 'start', start);
    const endTc = labelFor(seg, 'end', end);

    const rawText = _strip608QcText(seg.text || seg.lines?.join?.('\n') || '');
    let lines = rawText.split('\n').map(x => x.trim()).filter(Boolean);

    // If line/col constraints are provided, evaluate them using the SAME wrapping logic as the encoder.
    // This avoids false "maxCols" failures for cues that would wrap cleanly on export.
    if (Number.isFinite(effMaxCols) && hasPositiveLimit(maxLinesPerBlock) && typeof scc?.wrapTextAndClamp === 'function') {
      try {
        lines = scc.wrapTextAndClamp(rawText, effMaxCols, Number(maxLinesPerBlock), { overflowPolicy: 'error', cueIndex: i + 1 });
      } catch (e) {
        if (out.failures.length < maxItems) out.failures.push({
          type: 'wrap',
          startTc, endTc,
          message: e?.message || String(e)
        });
        // Fall back to truncate so downstream heuristics still run on something reasonable.
        try {
          lines = scc.wrapTextAndClamp(rawText, effMaxCols, Number(maxLinesPerBlock), { overflowPolicy: 'truncate', cueIndex: i + 1 });
        } catch {}
      }
    }

    const flat = lines.join(' ').replace(/\s+/g, ' ').trim();

    const charNoSpace = flat.replace(/\s+/g, '').length;
    const wordCount = flat ? flat.split(/\s+/g).filter(Boolean).length : 0;

    const cps = dur > 0 ? (charNoSpace / dur) : Infinity;
    const wpm = dur > 0 ? (wordCount / (dur / 60)) : Infinity;

    out.metrics.maxCps = Math.max(out.metrics.maxCps, cps);
    out.metrics.maxWpm = Math.max(out.metrics.maxWpm, wpm);

    // Hard structural limits (what QC tools will flag immediately)
    if (hasPositiveLimit(maxLinesPerBlock) && lines.length > Number(maxLinesPerBlock)) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'maxLines',
        startTc, endTc,
        message: `Too many lines (${lines.length}) > ${Number(maxLinesPerBlock)}.`
      });
    }
    if (Number.isFinite(effMaxCols)) {
      for (const ln of lines) {
        const len = Array.from(ln).length;
        if (len > effMaxCols) {
          if (out.failures.length < maxItems) out.failures.push({
            type: 'maxCols',
            startTc, endTc,
            message: `Line exceeds max columns (${len}) > ${effMaxCols}: “${ln.slice(0, 60)}${ln.length > 60 ? '…' : ''}”`
          });
        }
      }
    }

    // Hard failures
    if (dur < (minDurationSec - 1e-9)) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'minDuration',
        index: seg.id ?? i,
        startTc, endTc,
        durationSec: Number(dur.toFixed(3)),
        message: `Duration ${dur.toFixed(3)}s < min ${minDurationSec}s`
      });
    }

    const maxDur = Number.isFinite(Number(maxDurationSec)) ? Number(maxDurationSec) : Number(maxDurationSeconds);
    if (Number.isFinite(maxDur) && maxDur > 0 && dur > (maxDur + 1e-9)) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'maxDuration',
        index: seg.id ?? i,
        startTc, endTc,
        durationSec: Number(dur.toFixed(3)),
        message: `Duration ${dur.toFixed(3)}s > max ${maxDur}s`
      });
    }
    if (cps > (maxCps + 1e-6)) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'cps',
        index: seg.id ?? i,
        startTc, endTc,
        cps: Number(cps.toFixed(2)),
        message: `CPS ${cps.toFixed(2)} > max ${maxCps}`
      });
    }
    if (wpm > (maxWpm + 1e-6)) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'wpm',
        index: seg.id ?? i,
        startTc, endTc,
        wpm: Number(wpm.toFixed(0)),
        message: `WPM ${wpm.toFixed(0)} > max ${maxWpm}`
      });
    }

    // Soft heuristics (warnings)
    // Suspicious line breaks: ending a line with a very short “hanger” word.
    if (lines.length >= 2) {
      const end1 = String(lines[0] || '').trim().toLowerCase();
      const lastTok = end1.split(/\s+/g).filter(Boolean).slice(-1)[0] || '';
      const hangers = new Set(['a','an','the','of','to','and','or','but','for','in','on','at','with','from','as','by']);
      if (hangers.has(lastTok)) {
        if (out.warnings.length < maxItems) out.warnings.push({
          type: 'lineBreak',
          index: seg.id ?? i,
          startTc, endTc,
          message: `Line break ends with “${lastTok}” (likely awkward split)`
        });
      }
    }
  }

  // Gap checks (between cues)
  for (let i = 0; i + 1 < cleaned.length; i++) {
    const a = cleaned[i];
    const b = cleaned[i + 1];
    const aEnd = Number.isFinite(a.end) ? a.end : (Number(a.msEnd) || NaN) / 1000;
    const bStart = Number.isFinite(b.start) ? b.start : (Number(b.msStart) || NaN) / 1000;
    if (!Number.isFinite(aEnd) || !Number.isFinite(bStart)) continue;

    const gap = bStart - aEnd;
    out.metrics.minGapSec = Math.min(out.metrics.minGapSec, gap);

    const aEndTc = labelFor(a, 'end', aEnd);
    const bStartTc = labelFor(b, 'start', bStart);

    if (gap < -1e-9) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'overlap',
        index: a.id ?? i,
        endTc: aEndTc,
        nextStartTc: bStartTc,
        overlapSec: Number((-gap).toFixed(3)),
        message: `Overlap ${(-gap).toFixed(3)}s (next starts before previous ends)`
      });
    } else if (gap < (minGapSec - 1e-9)) {
      if (out.failures.length < maxItems) out.failures.push({
        type: 'minGap',
        index: a.id ?? i,
        endTc: aEndTc,
        nextStartTc: bStartTc,
        gapSec: Number(gap.toFixed(3)),
        message: `Gap ${gap.toFixed(3)}s < min ${minGapSec}s`
      });
    }
  }

  // Late-EOC enforcement (encoder-side metric)
  if (Number.isFinite(maxLateEocSecObserved) && maxLateEocSecObserved > maxLateEocSec) {
    if (out.failures.length < maxItems) out.failures.push({
      type: 'lateEoc',
      index: null,
      message: `Max late EOC ${Number(maxLateEocSecObserved).toFixed(3)}s > max ${maxLateEocSec}s`
    });
  }
  if (Number.isFinite(lateEocCount) && lateEocCount > maxLateEocCount) {
    if (out.failures.length < maxItems) out.failures.push({
      type: 'lateEocCount',
      index: null,
      message: `Late EOC count ${lateEocCount} > max ${maxLateEocCount}`
    });
  }

  // Unshowable cue enforcement (encoder-side metric)
  if (Number.isFinite(unshowableCueCount) && unshowableCueCount > (out.thresholds.maxUnshowableCueCount ?? 0)) {
    if (out.failures.length < maxItems) out.failures.push({
      type: 'unshowableCue',
      index: null,
      message: `Unshowable cues: ${unshowableCueCount} cue(s) had EOC at or after cue end (max late-by ${Number(maxUnshowableLateSecObserved || 0).toFixed(3)}s)`
    });
  }

  const dedupIssues = (arr) => {
    const seen = new Set();
    const outArr = [];
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const key =
        `${it?.type || ''}|${it?.startTc || ''}|${it?.endTc || ''}|${it?.nextStartTc || ''}|${it?.message || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      outArr.push(it);
    }
    return outArr;
  };

  out.failures = dedupIssues(out.failures);
  out.warnings = dedupIssues(out.warnings);

  out.ok = out.failures.length === 0;
  return out;
}

function _computeMccContentQc(segments = [], {
  fps = 29.97,
  dropFrame = true,
  maxCharsPerLine = null,
  maxLinesPerBlock = null,

  // Optional maximum on-screen duration per cue.
  // Many broadcaster specs target ~6s max (but it varies), so we keep this configurable.
  // Set to null/undefined/<=0 to disable.
  maxDurationSec = null,

  maxCps = 20,
  maxWpm = 180,
  minDurationSec = 0.80,
  minGapSec = 0.10,

  maxItems = 50
} = {}) {
  const hasPositiveLimit = (v) => Number.isFinite(Number(v)) && Number(v) > 0;

  const out = {
    ok: true,
    failures: [],
    warnings: [],
    // Per-cue rollup (used for dual grading / UI labeling).
    // Each entry corresponds to the *input segment index*.
    byCue: [],
    thresholds: {
      maxCps, maxWpm, minDurationSec, minGapSec,
      ...(Number.isFinite(Number(maxCharsPerLine)) && Number(maxCharsPerLine) > 0
        ? { maxCharsPerLine: Number(maxCharsPerLine) }
        : {}),
      ...(Number.isFinite(Number(maxLinesPerBlock)) && Number(maxLinesPerBlock) > 0
        ? { maxLinesPerBlock: Number(maxLinesPerBlock) }
        : {}),
      ...(Number.isFinite(Number(maxDurationSec)) && Number(maxDurationSec) > 0
        ? { maxDurationSec: Number(maxDurationSec) }
        : {})
    },
    metrics: {
      cues: 0,
      maxCps: 0,
      maxWpm: 0,
      maxDurationSec: 0,
      minDurationSec: Infinity,
      minGapSec: Infinity
    }
  };

  const labelFor = (seg, which, secFallback) => {
    const t = seg?.timecodes;
    const pref = dropFrame ? (t?.df?.[which] || t?.ndf?.[which]) : (t?.ndf?.[which] || t?.df?.[which]);
    if (typeof pref === 'string' && pref) return pref;
    return formatTimecode(secFallback, dropFrame, fps, 'colon');
  };

  const cleaned = (Array.isArray(segments) ? segments : [])
    .map(s => ({ ...s, text: _strip608QcText(s?.text || '') }));
  out.metrics.cues = cleaned.length;
  out.byCue = new Array(cleaned.length);

  // Structured issue helpers: include cue identity + numeric fields for deterministic reporting/UI.
  const _issueBase = (cueRec) => ({
    cueId: cueRec?.id,
    cueIndex: cueRec?.cueIndex,
    sourceIndex: (cueRec && cueRec.sourceIndex != null) ? cueRec.sourceIndex : null,
    start: cueRec?.start,
    end: cueRec?.end,
    startTc: cueRec?.startTc,
    endTc: cueRec?.endTc
  });

  const _pushFail = (cueRec, issue) => {
    if (out.failures.length >= maxItems) return;
    const base = _issueBase(cueRec);
    out.failures.push({ ...base, ...(issue && typeof issue === 'object' ? issue : {}) });
  };

  const _pushWarn = (cueRec, issue) => {
    if (out.warnings.length >= maxItems) return;
    const base = _issueBase(cueRec);
    out.warnings.push({ ...base, ...(issue && typeof issue === 'object' ? issue : {}) });
  };

  const effMaxCols = hasPositiveLimit(maxCharsPerLine) ? Number(maxCharsPerLine) : null;

  for (let i = 0; i < cleaned.length; i++) {
    const seg = cleaned[i];
    const start = Number.isFinite(seg.start) ? seg.start : (Number(seg.msStart) || 0) / 1000;
    let end = Number.isFinite(seg.end) ? seg.end : (Number(seg.msEnd) || NaN) / 1000;

    if (!Number.isFinite(end) || end <= start) {
      const next = cleaned[i + 1];
      const ns = next ? (Number.isFinite(next.start) ? next.start : (Number(next.msStart) || NaN) / 1000) : NaN;
      end = (Number.isFinite(ns) && ns > start) ? ns : (start + Math.max(1 / (Number(fps) || 30), 0.5));
    }

    const dur = Math.max(0, end - start);
    out.metrics.minDurationSec = Math.min(out.metrics.minDurationSec, dur);
    out.metrics.maxDurationSec = Math.max(out.metrics.maxDurationSec, dur);

    const rawText = _strip608QcText(seg.text || seg.lines?.join?.('\n') || '');
    const lines = rawText.split('\n').map(x => x.trim()).filter(Boolean);
    const flat = lines.join(' ').replace(/\s+/g, ' ').trim();

	  // Keep a compact, deterministic snippet for UI/report context.
	  // IMPORTANT: Use Array.from so Unicode surrogate pairs count as a single visible character.
	  const flatChars = Array.from(flat);
	  const flatSnippet = (flatChars.length > 120)
	    ? `${flatChars.slice(0, 117).join('')}...`
	    : flat;

    const charNoSpace = flat.replace(/\s+/g, '').length;
    const wordCount = flat ? flat.split(/\s+/g).filter(Boolean).length : 0;

    const cps = dur > 0 ? (charNoSpace / dur) : Infinity;
    const wpm = dur > 0 ? (wordCount / (dur / 60)) : Infinity;

    out.metrics.maxCps = Math.max(out.metrics.maxCps, cps);
    out.metrics.maxWpm = Math.max(out.metrics.maxWpm, wpm);

    const startTc = labelFor(seg, 'start', start);
    const endTc = labelFor(seg, 'end', end);

    const cueFail = new Set();
    const cueWarn = new Set();

    // Keep a stable-ish mapping back to the source cue when available.
    const sourceIndex = Number.isFinite(Number(seg?.sourceIndex))
      ? Math.trunc(Number(seg.sourceIndex))
      : (Number.isFinite(Number(seg?.sourceIdx)) ? Math.trunc(Number(seg.sourceIdx)) : null);

    const cueId = (seg && seg.id != null) ? seg.id : i;
    const cueRec = {
      cueIndex: i,
      id: cueId,
      sourceIndex,
      start,
      end,
      startTc,
      endTc,
      durationSec: Number(dur.toFixed(6)),
      cps: Number.isFinite(cps) ? Number(cps.toFixed(6)) : cps,
      wpm: Number.isFinite(wpm) ? Number(wpm.toFixed(6)) : wpm,
      lineCount: lines.length,
      maxLineLen: lines.reduce((m, ln) => Math.max(m, Array.from(String(ln || '')).length), 0),
      // Context for report/UI (kept compact and deterministic).
      // lines are the QC-evaluated lines (after stripping 608 control glyphs).
      lines: lines.slice(0, 8),
      textFlat: flat,
      textSnippet: flatSnippet,
      // Gap/overlap values are populated in the post-pass that evaluates spacing.
      gapAfterSec: null,
      overlapAfterSec: null,
      nextStartTc: null,
      failTypes: [],
      warnTypes: [],
      ok: true
    };

    if (hasPositiveLimit(maxLinesPerBlock) && lines.length > Number(maxLinesPerBlock)) {
      _pushFail(cueRec, {
        type: 'maxLines',
        index: cueId,
        startTc, endTc,
        actualLines: lines.length,
        maxLines: Number(maxLinesPerBlock),
        message: `Too many lines (${lines.length}) > ${Number(maxLinesPerBlock)}.`
      });
      cueFail.add('maxLines');
    }
    if (Number.isFinite(effMaxCols)) {
      for (let li = 0; li < lines.length; li++) {
        const ln = lines[li];
        const len = Array.from(ln).length;
        if (len > effMaxCols) {
          _pushFail(cueRec, {
            type: 'maxCols',
            index: cueId,
            startTc, endTc,
            lineIndex: li,
            line: ln,
            actualCols: len,
            maxCols: effMaxCols,
            message: `Line exceeds max columns (${len}) > ${effMaxCols}: “${ln.slice(0, 60)}${ln.length > 60 ? '…' : ''}”`
          });
          cueFail.add('maxCols');
        }
      }
    }

    if (dur < (minDurationSec - 1e-9)) {
      _pushFail(cueRec, {
        type: 'minDuration',
        index: cueId,
        startTc, endTc,
        durationSec: Number(dur.toFixed(3)),
        minDurationSec: Number(minDurationSec),
        message: `Duration ${dur.toFixed(3)}s < min ${minDurationSec}s`
      });
      cueFail.add('minDuration');
    }

    if (Number.isFinite(Number(maxDurationSec)) && Number(maxDurationSec) > 0 && dur > (Number(maxDurationSec) + 1e-6)) {
      _pushFail(cueRec, {
        type: 'maxDuration',
        index: cueId,
        startTc, endTc,
        durationSec: Number(dur.toFixed(3)),
        maxDurationSec: Number(maxDurationSec),
        message: `Duration ${dur.toFixed(3)}s > max ${Number(maxDurationSec)}s`
      });
      cueFail.add('maxDuration');
    }
    if (cps > (maxCps + 1e-6)) {
      _pushFail(cueRec, {
        type: 'cps',
        index: cueId,
        startTc, endTc,
        cps: Number(cps.toFixed(2)),
        maxCps,
        message: `CPS ${cps.toFixed(2)} > max ${maxCps}`
      });
      cueFail.add('cps');
    }
    if (wpm > (maxWpm + 1e-6)) {
      _pushFail(cueRec, {
        type: 'wpm',
        index: cueId,
        startTc, endTc,
        wpm: Number(wpm.toFixed(0)),
        maxWpm,
        message: `WPM ${wpm.toFixed(0)} > max ${maxWpm}`
      });
      cueFail.add('wpm');
    }

    if (lines.length >= 2) {
      const end1 = String(lines[0] || '').trim().toLowerCase();
      const lastTok = end1.split(/\s+/g).filter(Boolean).slice(-1)[0] || '';
      const hangers = new Set(['a','an','the','of','to','and','or','but','for','in','on','at','with','from','as','by']);
      if (hangers.has(lastTok)) {
        _pushWarn(cueRec, {
          type: 'lineBreak',
          index: cueId,
          startTc, endTc,
          lastToken: lastTok,
          message: `Line break ends with “${lastTok}” (likely awkward split)`
        });
        cueWarn.add('lineBreak');
      }
    }

    cueRec.failTypes = Array.from(cueFail);
    cueRec.warnTypes = Array.from(cueWarn);
    cueRec.ok = cueFail.size === 0;
    out.byCue[i] = cueRec;
  }

  for (let i = 0; i + 1 < cleaned.length; i++) {
    const a = cleaned[i];
    const b = cleaned[i + 1];
    const aEnd = Number.isFinite(a.end) ? a.end : (Number(a.msEnd) || NaN) / 1000;
    const bStart = Number.isFinite(b.start) ? b.start : (Number(b.msStart) || NaN) / 1000;
    if (!Number.isFinite(aEnd) || !Number.isFinite(bStart)) continue;

    const gap = bStart - aEnd;
    out.metrics.minGapSec = Math.min(out.metrics.minGapSec, gap);

    const aEndTc = labelFor(a, 'end', aEnd);
    const bStartTc = labelFor(b, 'start', bStart);

    const cueRec = out.byCue[i];

    // Populate per-cue spacing metrics for report/UI (even when not failing).
    if (cueRec && typeof cueRec === 'object') {
      cueRec.gapAfterSec = Number.isFinite(gap) ? Number(gap.toFixed(6)) : gap;
      cueRec.nextStartTc = bStartTc;
      if (gap < 0) cueRec.overlapAfterSec = Number((-gap).toFixed(6));
    }

    if (gap < (-1e-9)) {
      _pushFail(cueRec, {
        type: 'overlap',
        index: a.id ?? i,
        endTc: aEndTc,
        nextStartTc: bStartTc,
        overlapSec: Number((-gap).toFixed(3)),
        message: `Overlap ${(-gap).toFixed(3)}s (next cue starts before previous ends)`
      });
      if (out.byCue[i] && typeof out.byCue[i] === 'object') {
        const set = new Set(Array.isArray(out.byCue[i].failTypes) ? out.byCue[i].failTypes : []);
        set.add('overlap');
        out.byCue[i].failTypes = Array.from(set);
        out.byCue[i].ok = false;
      }
    } else if (gap < (minGapSec - 1e-9)) {
      _pushFail(cueRec, {
        type: 'minGap',
        index: a.id ?? i,
        endTc: aEndTc,
        nextStartTc: bStartTc,
        gapSec: Number(gap.toFixed(3)),
        minGapSec: Number(minGapSec),
        message: `Gap ${gap.toFixed(3)}s < min ${minGapSec}s`
      });
      if (out.byCue[i] && typeof out.byCue[i] === 'object') {
        const set = new Set(Array.isArray(out.byCue[i].failTypes) ? out.byCue[i].failTypes : []);
        set.add('minGap');
        out.byCue[i].failTypes = Array.from(set);
        out.byCue[i].ok = false;
      }
    }
  }

  const dedupIssues = (arr) => {
    const seen = new Set();
    const outArr = [];
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const key =
        `${it?.type || ''}|${(it?.cueId ?? it?.index ?? '')}|${(it?.cueIndex ?? '')}|${it?.startTc || ''}|${it?.endTc || ''}|${it?.nextStartTc || ''}|${it?.message || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      outArr.push(it);
    }
    return outArr;
  };

  out.failures = dedupIssues(out.failures);
  out.warnings = dedupIssues(out.warnings);

  out.ok = out.failures.length === 0;
  return out;
}

function validateMccContentQc(segments = [], {
  fps = 29.97,
  dropFrame = true,
  maxCharsPerLine = null,
  maxLinesPerBlock = null,
  maxDurationSec = null,
  maxCps = 20,
  maxWpm = 180,
  minDurationSec = 0.80,
  minGapSec = 0.10,
  maxItems = 50,

  // Phase 2.1: per-track QC profiles (separately configurable).
  // If omitted, the legacy single-profile values above are used for both tracks.
  qcProfile708 = null,
  qcProfile608 = null,

  // New: when provided, QC is computed from the FINAL MCC output (decoded back into cues)
  // so maxCols/maxLines reflect the true delivered wrapping/line breaks.
  mccText = null,

  // Phase 2: dual grading (broadcast vs legacy/NLE).
  // When enabled, we compute BOTH 708 (decoded) and 608 (decoded or projected) QC results,
  // and label “broadcast-safe but legacy-unsafe” cues at the canonical cue level.
  compatibilityMode = 'nle', // 'nle' | 'broadcast' | 'strict'
  include608Compatibility = true,

  // Optional: also attempt a native CEA-708 decode + QC pass.
  decode708 = false,
  require708 = false,
  serviceNumber = 1,

  // Optional: when 608 compatibility is OFF, we can still QC a projected 608 track.
  // safeMargins can reduce the effective 608 width (e.g. 32 - left - right).
  safeMargins = null,
  // Optional: 608 compatibility generation rules (mirrors sccEncoder compatGenerationRules)
  compatGenerationRules = null,

  // Feature flag / toggle
  dualGrade = false,


} = {}) {
  const modeNorm = String(compatibilityMode || '').trim().toLowerCase();

  const _mergeProfile = (base, extra) => {
    if (!extra || typeof extra !== 'object') return { ...base };
    const out = { ...base };
    for (const k of Object.keys(extra)) {
      if (extra[k] === undefined) continue;
      out[k] = extra[k];
    }
    return out;
  };

  const baseCommon = {
    fps,
    dropFrame,
    maxDurationSec,
    maxCps,
    maxWpm,
    minDurationSec,
    minGapSec,
    maxItems
  };

  const profile708 = _mergeProfile({
    ...baseCommon,
    maxCharsPerLine,
    maxLinesPerBlock
  }, qcProfile708);

  const profile608 = _mergeProfile({
    ...baseCommon,
    maxCharsPerLine,
    maxLinesPerBlock
  }, qcProfile608);

  // Default / fallback: QC input segments directly (legacy behavior).
  // (Segments represent canonical authoring; treat this as 708-style QC.)
  let primary = _computeMccContentQc(segments, profile708);
  primary.source = 'segments';

  if (!mccText) return primary;

  // Phase 2: encoder-attached MCC timing meta. The encoder may return a String
  // object carrying _mccMeta (so callers still can treat it like a string).
  const mccMeta = (mccText && typeof mccText === 'object' && mccText._mccMeta)
    ? mccText._mccMeta
    : null;
  const timingPolicy = (mccMeta && mccMeta.timingPolicy) ? mccMeta.timingPolicy : null;
  const encoderTimingPolicy = (timingPolicy && timingPolicy.policy === 'bounded_start_ripple') ? timingPolicy : null;

  const _applyEncoderTimingPolicy = (qc) => {
    if (!qc || !encoderTimingPolicy) return qc;
    qc.metrics = qc.metrics && typeof qc.metrics === 'object' ? qc.metrics : {};
    qc.warnings = Array.isArray(qc.warnings) ? qc.warnings : [];
    qc.failures = Array.isArray(qc.failures) ? qc.failures : [];

    const shiftFrames = Number(encoderTimingPolicy.shiftFrames) || 0;
    const shiftSec = Number(encoderTimingPolicy.shiftSec) || 0;
    const maxShiftSec = Number(encoderTimingPolicy.maxShiftSec);
    const exceeded = !!encoderTimingPolicy.exceededBudget;

    qc.metrics.mccStartRippleShiftFrames = shiftFrames;
    qc.metrics.mccStartRippleShiftSeconds = shiftSec;
    if (Number.isFinite(maxShiftSec)) qc.metrics.mccStartRippleMaxShiftSeconds = maxShiftSec;
    qc.metrics.mccStartRippleExceededBudget = exceeded;

    if (shiftFrames > 0) {
      qc.warnings.push(
        `MCC timing: file-start ripple applied (+${shiftFrames} frames; ${shiftSec.toFixed(3)}s) to avoid start-of-file preload drift.`
      );
    }

    if (exceeded) {
      const budgetText = Number.isFinite(maxShiftSec) ? `${maxShiftSec.toFixed(3)}s` : 'the configured budget';
      qc.failures.push({
        type: 'mccTiming',
        startTc: '',
        endTc: '',
        message: `MCC timing: initial preload required a ${shiftSec.toFixed(3)}s shift, exceeding ${budgetText}. Add headroom at the start (pre-roll) or move the first captions later.`
      });
      qc.ok = false;
    }

    return qc;
  };

  // Decode-from-output path (preferred)
  try {
    const { decodeMccText } = require('../modules/mccDecoder');

    // Always decode 608 (forced), so if the file DOES contain compatibility bytes we grade them.
    const dec608 = decodeMccText(String(mccText), {
      fps,
      dropFrame,
      force608Compatibility: true,
      keepAbsoluteTimecode: true,
      shiftToZero: false
    });

    // Decode 708 when needed (dual grading, strict/broadcast, or explicit want).
    const wantDual = !!dualGrade;
    const effRequire708 = !!require708;
    const want708Decode = !!decode708 || wantDual || effRequire708 || modeNorm === 'broadcast' || modeNorm === 'strict';

    let dec708 = null;
    if (want708Decode) {
      dec708 = decodeMccText(String(mccText), {
        fps,
        dropFrame,
        serviceNumber,
        safeMargins: safeMargins || null,
        keepAbsoluteTimecode: true,
        shiftToZero: false
      });
    }

    // Build per-track QC inputs from decoded cues.
    let qc608Decoded = null;
    let qc708 = null;

    if (dec608?.kind === 'cea608' && Array.isArray(dec608?.cues) && dec608.cues.length) {
      const segs608 = dec608.cues.map((c, idx) => ({
        id: c.id ?? idx,
        start: c.start,
        end: c.end,
        text: Array.isArray(c.lines) ? c.lines.join('\n') : (c.text || '')
      }));
      qc608Decoded = _computeMccContentQc(segs608, profile608);
      qc608Decoded.source = 'decoded';
      qc608Decoded.track = 'cea608';
      qc608Decoded.include608Compatibility = !!dec608?.mccOptions?.include608Compatibility;
    }

    if (dec708?.kind === 'cea708' && Array.isArray(dec708?.cues) && dec708.cues.length) {
      const segs708 = dec708.cues.map((c, idx) => ({
        id: c.id ?? idx,
        start: c.start,
        end: c.end,
        text: Array.isArray(c.lines) ? c.lines.join('\n') : (c.text || '')
      }));
      qc708 = _computeMccContentQc(segs708, profile708);
      qc708.source = 'decoded';
      qc708.track = 'cea708';
      qc708.serviceNumber = dec708?.mccOptions?.serviceNumber ?? serviceNumber;
      qc708.availableServices = Array.isArray(dec708?.mccOptions?.availableServices)
        ? dec708.mccOptions.availableServices
        : null;
    }

    // Phase 2.2: If 608 is NOT included, generate a projected 608 track from canonical cues.
    // We also compute this for dual grading even when decoded 608 exists, so we can compare
    // “as-authored projection” vs “as-delivered 608 bytes” if they ever diverge.
    let qcLegacy608 = null;
    let legacyMaxCols = 32;
    let legacyMaxLines = 2;

    const _num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    };

    const _effective608Width = (sm) => {
      if (!sm || typeof sm !== 'object') return 32;
      const width = _num(sm.width);
      if (Number.isFinite(width) && width > 0) return Math.max(1, Math.min(32, Math.floor(width)));
      const left = _num(sm.left);
      const right = _num(sm.right);
      if (Number.isFinite(left) || Number.isFinite(right)) {
        const l = Number.isFinite(left) ? Math.max(0, Math.floor(left)) : 0;
        const r = Number.isFinite(right) ? Math.max(0, Math.floor(right)) : 0;
        return Math.max(1, Math.min(32, 32 - l - r));
      }
      return 32;
    };

    const _canonCues = (Array.isArray(segments) ? segments : []).map((seg, idx) => {
      const start = Number.isFinite(Number(seg?.start)) ? Number(seg.start) : (Number(seg?.msStart) || 0) / 1000;
      const end = Number.isFinite(Number(seg?.end)) ? Number(seg.end) : (Number(seg?.msEnd) || 0) / 1000;
      const text = Array.isArray(seg?.lines) ? seg.lines.join('\n') : String(seg?.text || '');
      return {
        ...seg,
        id: (seg && seg.id != null) ? seg.id : idx,
        start,
        end,
        text
      };
    });

    const needProjected608ForEffective = !qc608Decoded;
    const needProjected608 = wantDual || needProjected608ForEffective || include608Compatibility === false;

    if (needProjected608 && typeof scc?.derive608TrackFromCanonical === 'function' && _canonCues.length) {
      try {
        const rawRules = (compatGenerationRules && typeof compatGenerationRules === 'object') ? compatGenerationRules : {};
        const rules = { ...rawRules };

        // Ensure QC-like knobs are present for splitting decisions.
        const rawQc = (rawRules.qc && typeof rawRules.qc === 'object') ? rawRules.qc : {};
        rules.qc = {
          ...rawQc,
          // Use the *608* profile for these knobs (independently configurable).
          maxCps: profile608.maxCps,
          maxWpm: profile608.maxWpm,
          minDurationSec: profile608.minDurationSec,
          minGapSec: profile608.minGapSec
        };

        // Match the encoder's default: ripple is OFF unless explicitly enabled.
        const rippleSpecified =
          (rawRules.allowBoundedRipple != null) || (rawRules.allowRipple != null) || (rawRules.ripple != null);
        if (!rippleSpecified) rules.allowBoundedRipple = false;

        const safeWidth = _effective608Width(safeMargins);

        const maxColsRule = _num(rawRules.maxCols ?? rawRules.maxCols608 ?? rawRules.maxCharsPerLine);
        legacyMaxCols = Number.isFinite(maxColsRule) ? Math.max(1, Math.min(32, Math.floor(maxColsRule))) : safeWidth;

        const maxLinesRule = _num(rawRules.maxLines ?? rawRules.maxLines608 ?? rawRules.maxLinesPerBlock);
        legacyMaxLines = Number.isFinite(maxLinesRule) ? Math.max(1, Math.min(2, Math.floor(maxLinesRule))) : 2;

        // Feed defaults back into the rules object so derived track behavior is deterministic.
        if (rules.maxCols == null && rules.maxCols608 == null && rules.maxCharsPerLine == null) rules.maxCols = legacyMaxCols;
        if (rules.maxLines == null && rules.maxLines608 == null && rules.maxLinesPerBlock == null) rules.maxLines = legacyMaxLines;

        const derived = scc.derive608TrackFromCanonical(_canonCues, rules);
        const derivedSegs = (Array.isArray(derived) ? derived : [])
          .map((d, idx) => ({
            id: d?.id ?? d?.sourceCueId ?? d?.sourceIndex ?? idx,
            sourceIndex: Number.isFinite(Number(d?.sourceIndex)) ? Math.trunc(Number(d.sourceIndex)) : null,
            start: Number(d?.start),
            end: Number(d?.end),
            text: Array.isArray(d?.lines) ? d.lines.join('\n') : String(d?.text || '')
          }))
          .filter(s => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && String(s.text || '').trim());

        const legacyCfg = {
          ...profile608,
          maxCharsPerLine: legacyMaxCols,
          maxLinesPerBlock: legacyMaxLines
        };

        qcLegacy608 = _computeMccContentQc(derivedSegs, legacyCfg);
        qcLegacy608.source = 'projected';
        // Keep the public track label as 'cea608' so the report/UI can treat it as “legacy ingest”.
        qcLegacy608.track = 'cea608';
        qcLegacy608.projected = { maxCols: legacyMaxCols, maxLines: legacyMaxLines, allowBoundedRipple: rules.allowBoundedRipple === true };
        qcLegacy608.metrics = qcLegacy608.metrics && typeof qcLegacy608.metrics === 'object' ? qcLegacy608.metrics : {};
        qcLegacy608.metrics.projectedSourceCues = _canonCues.length;
      } catch (e) {
        qcLegacy608 = {
          ok: false,
          failures: [{
            type: 'legacy608',
            startTc: '',
            endTc: '',
            message: `Projected 608 derivation failed: ${e?.message || String(e)}`
          }],
          warnings: [],
          thresholds: {
            maxCps: profile608.maxCps,
            maxWpm: profile608.maxWpm,
            minDurationSec: profile608.minDurationSec,
            minGapSec: profile608.minGapSec
          },
          metrics: { cues: 0, maxCps: 0, maxWpm: 0, maxDurationSec: 0, minDurationSec: Infinity, minGapSec: Infinity },
          byCue: []
        };
        qcLegacy608.source = 'projected';
        qcLegacy608.track = 'cea608';
      }
    }

    // Effective 608 QC input:
    //  - If the file contains 608 compatibility bytes: grade decoded 608 cues.
    //  - Otherwise: grade the projected 608 track (canonical → compat transform → 608 overrides).
    const qc608 = qc608Decoded || qcLegacy608;

    // Choose primary track: broadcast/strict prefer 708; NLE prefer 608 when present.
    const prefer708Primary = (modeNorm === 'broadcast' || modeNorm === 'strict');
    const primaryTrack = prefer708Primary
      ? (qc708 || qc608 || primary)
      : (qc608 || qc708 || primary);

    primary = { ...primaryTrack };
    primary.source = primaryTrack.source || 'decoded';
    primary.track = primaryTrack.track || (prefer708Primary ? 'cea708' : 'cea608');

    // Decode metadata summary
    primary.decode = {
      cea608: {
        cues: Number(qc608Decoded?.metrics?.cues) || 0,
        include608Compatibility: !!dec608?.mccOptions?.include608Compatibility
      },
      cea708: (dec708 && dec708.kind === 'cea708')
        ? {
          cues: Number(qc708?.metrics?.cues) || 0,
          serviceNumber: dec708?.mccOptions?.serviceNumber ?? serviceNumber,
          availableServices: Array.isArray(dec708?.mccOptions?.availableServices) ? dec708.mccOptions.availableServices : null
        }
        : null
    };

    // Always attach both tracks for report/UI.
    primary.tracks = {
      cea608: qc608 || null,
      cea708: qc708 || null,
      ...(qcLegacy608 && qc608Decoded ? { legacy608: qcLegacy608 } : {})
    };

    // Apply dual grading (Phase 2): compare 708 vs effective 608 at canonical cue granularity.
    if (wantDual) {
      const dual = { enabled: true };

      const grade708 = qc708 ? {
        ok: !!qc708.ok,
        cues: Number(qc708?.metrics?.cues) || 0,
        serviceNumber: qc708?.serviceNumber ?? serviceNumber,
        source: qc708?.source || 'decoded'
      } : null;

      const grade608 = qc608 ? {
        ok: !!qc608.ok,
        cues: Number(qc608?.metrics?.cues) || 0,
        source: qc608?.source || 'decoded'
      } : null;

      dual.grade708 = grade708;
      dual.grade608 = grade608;

      // Keep a dedicated projection summary for the report (even when decoded 608 exists).
      dual.legacy608 = qcLegacy608 ? {
        ok: !!qcLegacy608.ok,
        cues: Number(qcLegacy608?.metrics?.cues) || 0,
        source: qcLegacy608?.source || 'projected',
        maxCols: legacyMaxCols,
        maxLines: legacyMaxLines
      } : null;

      // Compute cue labels: “broadcast-safe but legacy-unsafe”.
      dual.legacyUnsafeCues = [];

      const labelForSource = (seg, which, secFallback) => {
        const t = seg?.timecodes;
        const pref = dropFrame ? (t?.df?.[which] || t?.ndf?.[which]) : (t?.ndf?.[which] || t?.df?.[which]);
        if (typeof pref === 'string' && pref) return pref;
        return formatTimecode(secFallback, dropFrame, fps, 'colon');
      };

      const overlapSec = (aStart, aEnd, bStart, bEnd) => {
        const s = Math.max(Number(aStart) || 0, Number(bStart) || 0);
        const e = Math.min(Number(aEnd) || 0, Number(bEnd) || 0);
        return Math.max(0, e - s);
      };

	      const aggregateByOverlap = (sourceCues, qcObj, {
	        // When decoded cues preserve absolute file timecode (keepAbsoluteTimecode=true),
	        // their start/end seconds are offset by the file's base timecode. Canonical/source
	        // cues are typically relative to 0. Provide the base offset so overlap math lines up.
	        timeOffsetSec = 0
	      } = {}) => {
        const src = Array.isArray(sourceCues) ? sourceCues : [];
        const by = Array.isArray(qcObj?.byCue) ? qcObj.byCue : [];
        const eps = Math.max(0, (1 / (Number(fps) || 30)) * 2);
	        const off = (Number.isFinite(Number(timeOffsetSec)) ? Number(timeOffsetSec) : 0);

		      const _s = (c) => (Number(c?.start) || 0) - off;
		      const _e = (c) => (Number(c?.end) || (Number(c?.start) || 0)) - off;

        // Ensure candidates are start-sorted (decoder output should be; derived tracks should be).
	        const cand = by.slice().sort((a, b) => _s(a) - _s(b));

        const agg = new Array(src.length).fill(null).map(() => ({
          matched: 0,
          ok: true,
          failTypes: new Set(),
          warnTypes: new Set()
        }));

        let j = 0;
        for (let i = 0; i < src.length; i++) {
          const s0 = Number(src[i]?.start) || 0;
          const e0 = Number(src[i]?.end) || s0;

	          while (j < cand.length && _e(cand[j]) < (s0 - eps)) j++;

          let k = j;
	          while (k < cand.length && _s(cand[k]) <= (e0 + eps)) {
            const c = cand[k];
	            const s1 = _s(c);
	            const e1 = _e(c);
            const ov = overlapSec(s0, e0, s1, e1);
            if (ov > 0) {
              agg[i].matched += 1;
              agg[i].ok = agg[i].ok && !!c?.ok;
              for (const t of (Array.isArray(c?.failTypes) ? c.failTypes : [])) agg[i].failTypes.add(String(t));
              for (const t of (Array.isArray(c?.warnTypes) ? c.warnTypes : [])) agg[i].warnTypes.add(String(t));
            }
            k++;
          }
        }

        return agg.map(a => ({
          matched: a.matched,
          ok: a.matched ? a.ok : true,
          failTypes: Array.from(a.failTypes),
          warnTypes: Array.from(a.warnTypes)
        }));
      };

      const aggregateBySourceIndex = (sourceCues, qcObj) => {
        const src = Array.isArray(sourceCues) ? sourceCues : [];
        const by = Array.isArray(qcObj?.byCue) ? qcObj.byCue : [];
        const agg = new Array(src.length).fill(null).map(() => ({
          matched: 0,
          ok: true,
          failTypes: new Set(),
          warnTypes: new Set()
        }));

        for (const c of by) {
          const idx = Number.isFinite(Number(c?.sourceIndex)) ? Math.trunc(Number(c.sourceIndex)) : null;
          if (idx == null || idx < 0 || idx >= agg.length) continue;
          agg[idx].matched += 1;
          agg[idx].ok = agg[idx].ok && !!c?.ok;
          for (const t of (Array.isArray(c?.failTypes) ? c.failTypes : [])) agg[idx].failTypes.add(String(t));
          for (const t of (Array.isArray(c?.warnTypes) ? c.warnTypes : [])) agg[idx].warnTypes.add(String(t));
        }

        return agg.map(a => ({
          matched: a.matched,
          ok: a.matched ? a.ok : true,
          failTypes: Array.from(a.failTypes),
          warnTypes: Array.from(a.warnTypes)
        }));
      };

	      // If decoded cues preserve absolute timecode, shift them back to a 0-based timeline
	      // when matching against canonical cues.
	      const overlapOffset708 = (qc708?.source === 'decoded' && dec708?.keepAbsoluteTimecode === true)
	        ? (Number(dec708?.timecodeBaseSec) || 0)
	        : 0;
	      const overlapOffset608 = (qc608?.source === 'decoded' && dec608?.keepAbsoluteTimecode === true)
	        ? (Number(dec608?.timecodeBaseSec) || 0)
	        : 0;

	      const agg708 = qc708
	        ? aggregateByOverlap(_canonCues, qc708, { timeOffsetSec: overlapOffset708 })
	        : new Array(_canonCues.length).fill({ matched: 0, ok: true, failTypes: [], warnTypes: [] });

      // Prefer sourceIndex aggregation when we have it (projected 608), else fall back to overlap (decoded 608).
      const hasSourceIndex = !!(qc608 && Array.isArray(qc608.byCue) && qc608.byCue.some(r => Number.isFinite(Number(r?.sourceIndex))));
	      const agg608 = qc608
	        ? (hasSourceIndex
	          ? aggregateBySourceIndex(_canonCues, qc608)
	          : aggregateByOverlap(_canonCues, qc608, { timeOffsetSec: overlapOffset608 }))
	        : new Array(_canonCues.length).fill({ matched: 0, ok: true, failTypes: [], warnTypes: [] });

      for (let i = 0; i < _canonCues.length; i++) {
        const seg = _canonCues[i] || {};
        const ok708 = !!(agg708[i]?.ok);
        const ok608 = !!(agg608[i]?.ok);

        if (ok708 && !ok608) {
          const start = Number(seg.start) || 0;
          const end = Number(seg.end) || start;
          const startTc = labelForSource(seg, 'start', start);
          const endTc = labelForSource(seg, 'end', end);
          const canonTextRaw = Array.isArray(seg?.lines) ? seg.lines.join('\n') : String(seg?.text || '');
          const canonFlat = canonTextRaw.replace(/\s+/g, ' ').trim();
          const canonChars = Array.from(canonFlat);
          const canonicalSnippet = (canonChars.length > 140)
            ? `${canonChars.slice(0, 137).join('')}...`
            : canonFlat;

          dual.legacyUnsafeCues.push({
            sourceIndex: i,
            cueId: seg.id,
            start,
            end,
            startTc,
            endTc,
            canonicalSnippet,
            legacyFailTypes: Array.isArray(agg608[i]?.failTypes) ? agg608[i].failTypes : []
          });
        }
      }

      // Compact headline string for the report.
      const g708 = dual.grade708 ? (dual.grade708.ok ? '708-PASS' : '708-FAIL') : '708-N/A';
      const g608 = dual.grade608 ? (dual.grade608.ok ? '608-PASS' : '608-FAIL') : '608-N/A';
      dual.headline = `${g708} / ${g608}`;

      primary.dual = dual;
    }

    // Optional gate: require that 708 decodes into cues (presence/decodability, not QC thresholds).
    if (effRequire708) {
      const has708 = !!(dec708 && dec708.kind === 'cea708' && Array.isArray(dec708.cues) && dec708.cues.length > 0);
      if (!has708) {
        primary.ok = false;
        if (Array.isArray(primary.failures)) {
          primary.failures.unshift({
            type: 'missing708',
            startTc: '',
            endTc: '',
            message: 'Required CEA-708 captions were not decodable from the exported MCC output.'
          });
        }
      }
    }

    return _applyEncoderTimingPolicy(primary);
  } catch (e) {
    // If decode/QC-from-output fails, fall back to the segment QC (still useful).
    primary.warnings = Array.isArray(primary.warnings) ? primary.warnings : [];
    if (primary.warnings.length < maxItems) {
      primary.warnings.push({
        type: 'decode',
        startTc: '',
        endTc: '',
        message: `Decode-from-output QC failed; fell back to segment QC. ${e?.message || String(e)}`
      });
    }
    primary.source = 'segments';
    return _applyEncoderTimingPolicy(primary);
  }
}

module.exports = {
  writeTXT,
  writeJSON,
  writeFinalJSON,
  writeSRT,
  writeVTT,
  writeSCC,
  writeMCC,
  writeSccFromTranscriptionJob,
  writeXML,
  writeScript,
  writeMarkers,
  writeTokenAlignedTXT,
  writeBurnIn,
  writeAllOutputs,
  writeCorrectedJson,
  writeCorrectedSRT,
  writeCorrectedVTT,
  writeCorrectedJsonToPath,
  writeCorrectedSRTToPath,
  writeCorrectedVTTToPath,
  writeSccQcReport,
  writeMccQcReport,
  // Exported for subtitle-editor SCC exports so they can enforce the same
  // content-level QC as the automated SCC writer.
  validateSccContentQc,
  validateMccContentQc
};
