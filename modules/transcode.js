const ProgressManager = require('../utils/progressManager');
const { spawn, execFile } = require('child_process');
const electron = require('electron');
const { bindProgressManager } = require('../progressBridge');
const path = require('path');
const fs = require('fs');
const { renameReplaceSync } = require('../utils/fsSafe');
const net = require('net');
const checkDiskSpace = require('check-disk-space').default;

const BrowserWindow = electron.BrowserWindow || null;
const app = electron.app || null;
const isPackaged = app?.isPackaged ?? false;

const { ffmpegPath, ffprobePath } = require('../utils/ffmpeg');
const { framesFromTimecodeLabel, formatTimecodeFromFrames, isDropFrameRate, secondsToFrames } = require('../utils/timeUtils');

const { detectBestGPUEncoder, getAvailableEncoderSet } = require('../utils/gpuEncoder');
const { getAudioOnlyWrapperSpec } = require('../utils/codex');

const { sendLogMessage, writeLogToFile, createJobLogger, createJobUserLog, writeJobLogToFile, writeJobTextToFile } = require('./logUtils');
const { runWithConcurrencyLimit } = require('./fileUtils');
const { ensureUserDataSubdir } = require('../utils/appPaths');
const { runSsimPsNrCheck } = require('../src/ff/qualityCheck');

// DNxHR target data rates (MB/s) from Avid's published table (Dec 23, 2025).
// We convert to Mbps for FFmpeg by multiplying by 8 and rounding.
// Keys intentionally match the transcode UI's resolution + frame rate set.
const DNXHR_TABLE_MBPS = {
  '1920x1080': {
    '444': { '23.976': 41.68, '25': 43.46, '29.97': 52.10, '50': 86.91, '59.94': 104.19 },
    'HQX': { '23.976': 20.79, '25': 21.68, '29.97': 25.99, '50': 43.36, '59.94': 51.98 },
    'HQ':  { '23.976': 20.79, '25': 21.68, '29.97': 25.99, '50': 43.36, '59.94': 51.98 },
    'SQ':  { '23.976': 13.77, '25': 14.36, '29.97': 17.21, '50': 28.71, '59.94': 34.42 },
    'LB':  { '23.976': 4.31,  '25': 4.49,  '29.97': 5.39,  '50': 8.98,  '59.94': 10.77 }
  },
  '3840x2160': {
    '444': { '23.976': 166.61, '25': 173.73, '29.97': 208.27, '50': 347.46, '59.94': 416.54 },
    'HQX': { '23.976': 83.26,  '25': 86.82,  '29.97': 104.08, '50': 173.63, '59.94': 208.15 },
    'HQ':  { '23.976': 83.26,  '25': 86.82,  '29.97': 104.08, '50': 173.63, '59.94': 208.15 },
    'SQ':  { '23.976': 55.07,  '25': 57.42,  '29.97': 68.84,  '50': 114.84, '59.94': 137.67 },
    'LB':  { '23.976': 17.14,  '25': 17.87,  '29.97': 21.42,  '50': 35.74,  '59.94': 42.85 }
  },
  '4096x2160': {
    '444': { '23.976': 177.67, '25': 185.25, '29.97': 222.08, '50': 370.51, '59.94': 444.16 },
    'HQX': { '23.976': 88.88,  '25': 92.68,  '29.97': 111.10, '50': 185.35, '59.94': 222.10 },
    'HQ':  { '23.976': 88.88,  '25': 92.68,  '29.97': 111.10, '50': 185.35, '59.94': 222.10 },
    'SQ':  { '23.976': 58.72,  '25': 61.23,  '29.97': 73.40,  '50': 122.46, '59.94': 146.81 },
    'LB':  { '23.976': 18.26,  '25': 19.04,  '29.97': 22.83,  '50': 38.09,  '59.94': 45.66 }
  }
};

const localeMessagesCache = new Map();

function loadLocaleMessages(localeCode) {
  const normalized = String(localeCode || 'en').toLowerCase();
  if (localeMessagesCache.has(normalized)) return localeMessagesCache.get(normalized);
  const localePath = path.join(__dirname, '..', 'locales', `${normalized}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    localeMessagesCache.set(normalized, parsed && typeof parsed === 'object' ? parsed : {});
  } catch {
    localeMessagesCache.set(normalized, {});
  }
  return localeMessagesCache.get(normalized);
}

function resolveTranscodeLocale() {
  const rawLocale = String(process.env.LA_LOCALE || app?.getLocale?.() || 'en').toLowerCase();
  return rawLocale.split('-')[0] || 'en';
}

function transcodeMessage(key, params = {}) {
  return { key, params };
}

function qualityReason(key, params = {}) {
  return { key, params };
}

function formatQualityReason(reasonPayload) {
  if (reasonPayload && typeof reasonPayload === 'object' && typeof reasonPayload.key === 'string') {
    return formatTranscodeMessage(reasonPayload);
  }
  if (typeof reasonPayload === 'string' && reasonPayload.trim()) {
    return reasonPayload;
  }
  return formatTranscodeMessage('transcodeQualityReasonUnknown');
}

function mapLegacyQualityReason(reason, status = 'skipped') {
  if (reason && typeof reason === 'object' && typeof reason.key === 'string') {
    return reason;
  }
  const normalized = String(reason || '').trim().toLowerCase();
  const byLegacyText = {
    'not requested': 'transcodeQualityReasonNotRequested',
    'insufficient disk space': 'transcodeQualityReasonInsufficientDiskSpace',
    'transcode failed': 'transcodeQualityReasonTranscodeFailed',
    'image sequence output': 'transcodeQualityReasonImageSequenceOutput',
    'encode failed': 'transcodeQualityReasonEncodeFailed',
    'audio-only output': 'transcodeQualityReasonAudioOnlyOutput',
    'caption embed verification': 'transcodeQualityReasonCaptionEmbedVerification',
    'ffprobe timed out': 'transcodeQualityReasonFfprobeTimedOut',
    'metadata verification failed': 'transcodeQualityReasonMetadataVerificationFailed',
    'metadata verification only': 'transcodeQualityReasonMetadataVerificationOnly',
    'output missing': 'transcodeQualityReasonOutputMissing',
    'missing required parameters': 'transcodeQualityReasonMissingRequiredParameters',
    'input or output file not found': 'transcodeQualityReasonInputOutputNotFound',
    'no metrics produced': 'transcodeQualityReasonNoMetricsProduced',
    'ffmpeg timeout': 'transcodeQualityReasonFfmpegTimeout'
  };
  const knownKey = byLegacyText[normalized];
  if (knownKey) return qualityReason(knownKey);
  const message = String(reason || '').trim();
  if (message) {
    return status === 'error'
      ? qualityReason('transcodeQualityReasonQcError', { message })
      : qualityReason('transcodeQualityReasonVerificationError', { message });
  }
  return qualityReason('transcodeQualityReasonUnknown');
}

function formatTranscodeMessage(keyOrPayload, params = {}) {
  const payload = typeof keyOrPayload === 'string'
    ? { key: keyOrPayload, params }
    : (keyOrPayload || {});
  const key = typeof payload.key === 'string' ? payload.key : '';
  const values = payload.params && typeof payload.params === 'object' ? payload.params : {};
  const locale = resolveTranscodeLocale();
  const preferred = loadLocaleMessages(locale);
  const english = loadLocaleMessages('en');
  const template = preferred[key] || english[key] || key;
  return String(template).replace(/{{\s*([^{}\s]+)\s*}}/g, (_m, token) => (
    Object.prototype.hasOwnProperty.call(values, token) ? String(values[token]) : ''
  ));
}


function createStderrLineRelay(onForward, opts = {}) {
  const forward = typeof onForward === 'function' ? onForward : () => {};
  const statusIntervalMs = Number.isFinite(Number(opts.statusIntervalMs)) && Number(opts.statusIntervalMs) > 0
    ? Math.floor(Number(opts.statusIntervalMs))
    : 1500;
  const markAsError = !!opts.markAsError;
  const maxLineLength = Number.isFinite(Number(opts.maxLineLength)) && Number(opts.maxLineLength) > 0
    ? Math.floor(Number(opts.maxLineLength))
    : 2000;

  const statusPattern = /(frame=\s*\d+|fps=\s*[\d.]+|q=\s*[-\d.]+|size=\s*\S+|time=\s*\S+|bitrate=\s*\S+|speed=\s*\S+|out_time=|out_time_ms=|progress=|dup_frames=|drop_frames=)/i;
  const errorPattern = /(\berror\b|\bfatal\b|\bpanic\b|\bfailed\b|invalid\s+argument|permission\s+denied|no\s+such\s+file|could\s+not|unable\s+to)/i;

  let carry = '';
  let lastStatusAt = 0;

  const normalizeLine = (line) => {
    let text = String(line || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length > maxLineLength) text = `${text.slice(0, maxLineLength - 1)}…`;
    return text;
  };

  const processLine = (line) => {
    const text = normalizeLine(line);
    if (!text) return;

    const isErrorLine = errorPattern.test(text);
    const isStatusLine = !isErrorLine && statusPattern.test(text);
    if (!isErrorLine && !isStatusLine) return;

    if (isStatusLine) {
      const now = Date.now();
      if (now - lastStatusAt < statusIntervalMs) return;
      lastStatusAt = now;
      forward(text, false);
      return;
    }

    forward(text, markAsError || isErrorLine);
  };

  const onData = (chunk) => {
    carry += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    const parts = carry.split(/\r?\n/);
    carry = parts.pop() || '';
    parts.forEach(processLine);
  };

  const flush = () => {
    if (!carry) return;
    processLine(carry);
    carry = '';
  };

  return { onData, flush };
}

// Capture a bounded tail of a stream (stderr/stdout) so we can surface real FFmpeg failure reasons
// even when the live relay is intentionally throttled/filtered.
function createTailBuffer(maxBytes = 64 * 1024) {
  const limit = Number.isFinite(Number(maxBytes)) ? Math.max(1024, Math.trunc(Number(maxBytes))) : (64 * 1024);
  const chunks = [];
  let total = 0;

  return {
    append(chunk) {
      if (!chunk || limit <= 0) return;
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
      if (!buf.length) return;

      // If a single chunk exceeds limit, keep only its tail.
      if (buf.length > limit) {
        buf = buf.subarray(buf.length - limit);
        chunks.length = 0;
        total = 0;
      }

      chunks.push(buf);
      total += buf.length;

      // Trim from the front until we're within limit.
      while (total > limit && chunks.length) {
        const first = chunks[0];
        const overflow = total - limit;
        if (first.length <= overflow) {
          chunks.shift();
          total -= first.length;
        } else {
          chunks[0] = first.subarray(overflow);
          total -= overflow;
        }
      }
    },
    toString() {
      if (!chunks.length) return '';
      return Buffer.concat(chunks, total).toString('utf8');
    },
    getBytes() {
      return total;
    }
  };
}

function strictPixFmtArg(fmt) {
  const v = String(fmt || '').trim();
  if (!v || v === 'default' || v === 'match') return null;
  return v.startsWith('+') ? v : `+${v}`;
}

function pixFmtValueFromArgs(args) {
  const idx = Array.isArray(args) ? args.lastIndexOf('-pix_fmt') : -1;
  if (idx === -1 || idx >= args.length - 1) return null;
  const raw = String(args[idx + 1] || '').trim();
  if (!raw) return null;
  return raw.startsWith('+') ? raw.slice(1) : raw;
}

function isPrivateHostname(hostname) {
  const host = (hostname || '').toLowerCase();
  const normalizedHost = host.split('%')[0];
  if (!normalizedHost) return true;
  if (['localhost', '127.0.0.1', '::1'].includes(normalizedHost)) return true;
  if (normalizedHost.endsWith('.local')) return true;

  const ipVersion = net.isIP(normalizedHost);
  if (ipVersion === 4) {
    const [a, b] = normalizedHost.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  if (ipVersion === 6) {
    if (normalizedHost === '::1') return true;
    if (normalizedHost.startsWith('fc') || normalizedHost.startsWith('fd')) return true;
    if (normalizedHost.startsWith('fe80')) return true;
  }

  return false;
}

function validateN8nUrl(n8nUrl, opts = {}) {
  const allowPrivate = !!opts?.allowPrivate;
  const allowlist = opts?.allowlist;
  const allowInsecureHttp = !!opts?.allowInsecureHttp;
  const packagedBuild = typeof opts?.isPackaged === 'boolean' ? opts.isPackaged : isPackaged;
  const trimmed = (n8nUrl || '').trim();
  if (!trimmed) {
    return { valid: false, message: formatTranscodeMessage('transcode.n8nUrl.required') };
  }

  let parsed;
  let parsedHostname;
  try {
    parsed = new URL(trimmed);
    parsedHostname = parsed.hostname;
  } catch {
    const scopedMatch = trimmed.match(/^(https?:)\/\/\[([^\]]+)\](.*)$/i);
    if (!scopedMatch) {
      return { valid: false, message: formatTranscodeMessage('transcode.n8nUrl.invalid') };
    }
    const scopedHost = scopedMatch[2];
    const sanitizedHost = scopedHost.split('%')[0];
    if (!sanitizedHost) {
      return { valid: false, message: formatTranscodeMessage('transcode.n8nUrl.invalid') };
    }
    try {
      parsed = new URL(`${scopedMatch[1]}//[${sanitizedHost}]${scopedMatch[3]}`);
      parsedHostname = scopedHost;
    } catch {
      return { valid: false, message: formatTranscodeMessage('transcode.n8nUrl.invalid') };
    }
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, message: formatTranscodeMessage('transcode.n8nUrl.protocolRequired') };
  }

  if (parsed.protocol === 'http:' && packagedBuild && !allowInsecureHttp) {
    return {
      valid: false,
      message: formatTranscodeMessage('transcode.n8nUrl.httpsRequiredPackaged')
    };
  }

  const hostname = String(parsedHostname || '').trim();
  if (!hostname) {
    return { valid: false, message: formatTranscodeMessage('transcode.n8nUrl.hostnameRequired') };
  }

  if (!allowPrivate && isPrivateHostname(hostname)) {
    return {
      valid: false,
      message: formatTranscodeMessage('transcode.n8nUrl.privateHostDisallowed')
    };
  }

  const normalizedAllowlist = Array.isArray(allowlist)
    ? allowlist.map(entry => String(entry || '').trim()).filter(Boolean)
    : [];
  if (normalizedAllowlist.length) {
    const match = normalizedAllowlist.some(allowed => hostname.toLowerCase() === allowed.toLowerCase());
    if (!match) {
      return {
        valid: false,
        message: formatTranscodeMessage('transcode.n8nUrl.hostNotAllowed', { host: hostname, allowedHosts: normalizedAllowlist.join(', ') })
      };
    }
  }

  return { valid: true, url: trimmed };
}

function envFlagEnabled(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseN8nAllowlist(rawAllowlist) {
  if (Array.isArray(rawAllowlist)) {
    return rawAllowlist.map(entry => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof rawAllowlist === 'string') {
    return rawAllowlist
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);
  }
  return [];
}

// ================================
// Exit code helpers
// ================================

function unwrapExitCode(code) {
  if (typeof code !== 'number' || !Number.isFinite(code)) return code;

  // Windows: sometimes negative error codes appear as unsigned 32-bit integers
  // (e.g. 4294967268 for -28). Force signed 32-bit.
  if (code > 255 && code <= 0xffffffff) {
    return code | 0;
  }

  // POSIX: 8-bit wrap for negative returns from main()
  return code > 127 ? code - 256 : code;
}

function explainExitCode(code) {
  const signed = unwrapExitCode(code);
  switch (signed) {
    case -28:
      return 'No space left on device (ENOSPC)';
    case -2:
      return 'No such file or directory (ENOENT)';
    case -13:
      return 'Permission denied (EACCES)';
    case -22:
      return 'Invalid argument (EINVAL)';
    default:
      return null;
  }
}

function formatExitInfo(code, signal) {
  if (signal) return `signal ${signal}`;
  if (typeof code !== 'number') return `code ${code}`;
  const signed = unwrapExitCode(code);
  const explained = explainExitCode(code);
  const signedPart = signed !== code ? ` / ${signed}` : '';
  const explainPart = explained ? `: ${explained}` : '';
  return `code ${code}${signedPart}${explainPart}`;
}

// ================================
// Disk space + size estimation
// ================================

function formatBytes(bytes) {
  const n = typeof bytes === 'bigint' ? Number(bytes) : Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let val = n;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function parseWxH(res) {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(res || ''));
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

function parseFps(fpsLike) {
  if (fpsLike == null) return null;
  const s = String(fpsLike).trim().toLowerCase().replace('df', '');
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractTimecodeTag(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';

  const collected = [];
  const seen = new Set();
  const pushTimecode = (value) => {
    if (value == null) return;
    const normalized = String(value).trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    collected.push(normalized);
  };

  pushTimecode(metadata.format?.tags?.timecode);
  if (Array.isArray(metadata.streams)) {
    const streamPriority = (stream) => {
      const codecTag = String(stream?.codec_tag_string || '').toLowerCase();
      const codecName = String(stream?.codec_name || '').toLowerCase();
      const codecType = String(stream?.codec_type || '').toLowerCase();
      if (codecTag === 'tmcd' || codecName === 'tmcd') return 0;
      if (codecType === 'data') return 1;
      if (codecType === 'video') return 2;
      return 3;
    };
    const orderedStreams = metadata.streams
      .filter(Boolean)
      .slice()
      .sort((a, b) => streamPriority(a) - streamPriority(b));
    for (const stream of orderedStreams) {
      pushTimecode(stream?.tags?.timecode);
    }
  }
  pushTimecode(metadata.timecode);
  pushTimecode(metadata.tags?.timecode);

  return collected.find(tc => tc.includes(';')) || collected[0] || '';
}

function normalizeDropFrameTimecodeLabel(timecode) {
  if (!timecode) return null;
  const label = String(timecode).trim();
  if (!label) return null;
  if (!/^\d{2}:\d{2}:\d{2}[:;]\d{2}/.test(label)) return null;
  return label.replace(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})/, '$1;$2');
}

function bytesPerPixel(pixFmt) {
  const p = String(pixFmt || '').toLowerCase();
  switch (p) {
    case 'yuv420p': return 1.5;
    case 'nv12': return 1.5;
    case 'yuv422p': return 2.0;
    case 'yuv444p': return 3.0;
    case 'yuv420p10le': return 3.0;
    case 'p010le': return 3.0;
    case 'yuv422p10le': return 4.0;
    case 'yuv444p10le': return 6.0;
    case 'gbrp10le': return 6.0;
    case 'rgb24': return 3.0;
    case 'rgba': return 4.0;
    case 'rgb48le': return 6.0;
    case 'rgba64le': return 8.0;
    default: return null;
  }
}

function pcmBytesPerSample(codec) {
  const c = String(codec || '').toLowerCase();
  if (c.startsWith('pcm_s16')) return 2;
  if (c.startsWith('pcm_s24')) return 3;
  if (c.startsWith('pcm_s32')) return 4;
  if (c.startsWith('pcm_f32')) return 4;
  if (c.startsWith('pcm_f64')) return 8;
  return null;
}

function channelsToCount(channels) {
  switch (String(channels || '').toLowerCase()) {
    case 'mono':
      return 1;
    case 'stereo':
      return 2;
    case '5.1':
      return 6;
    case '7.1':
      return 8;
    default:
      return 2;
  }
}

function parseSampleRateHz(sampleRate) {
  if (sampleRate && sampleRate !== 'default') {
    const n = parseInt(sampleRate, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 48000;
}

function estimateAudioBytesFromSettings(duration, audioCodec, channels, sampleRate, audioBitrate) {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return 0n;
  const enc = String(audioCodec || '').trim().toLowerCase();
  if (!enc || enc === 'copy') return 0n;

  const ch = channelsToCount(channels);
  const sr = parseSampleRateHz(sampleRate);

  const pcmBps = pcmBytesPerSample(enc);
  if (pcmBps) {
    return BigInt(Math.ceil(duration * sr)) * BigInt(ch) * BigInt(pcmBps);
  }

  const abr = audioBitrate ? parseInt(audioBitrate, 10) : null;
  if (abr && abr > 0) {
    // bitrate is in kbps
    return BigInt(Math.ceil(duration * (abr * 1000 / 8)));
  }

  return 0n;
}

// Video formats with known / implied target bitrates (bits per second).
const IMPLIED_VIDEO_BITRATE_BPS = {
  xdcam_hd35: 35000000,
  xdcam_hd50: 50000000
};

// ProRes model constants: approximate bits-per-pixel-per-frame (bppf).
// Derived from typical published ProRes data rates at 1920x1080 29.97fps,
// then scaled by pixels * fps. ProRes is VBR; this is used for disk preflight only.
const PRORES_BPPF = {
  prores_proxy: 0.724,
  prores_lt: 1.641,
  prores_422: 2.365,
  prores_422hq: 3.540,
  prores_4444: 5.310,
  prores_4444xq: 8.046
};

function resolveDiskCheckPath(targetFolder) {
  if (!targetFolder) return { resolvedPath: null, missing: true };
  const resolved = path.resolve(String(targetFolder));
  if (fs.existsSync(resolved)) {
    return { resolvedPath: resolved, missing: false };
  }

  const root = path.parse(resolved).root;
  let current = path.dirname(resolved);
  while (current && current !== root) {
    if (fs.existsSync(current)) {
      return { resolvedPath: current, missing: true };
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  if (root && fs.existsSync(root)) {
    return { resolvedPath: root, missing: true };
  }

  return { resolvedPath: null, missing: true };
}

async function getFreeDiskBytes(targetFolder) {
  const { resolvedPath } = resolveDiskCheckPath(targetFolder);
  if (!resolvedPath) return null;

  // Fast path: Node statfs (modern Electron)
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(resolvedPath);
      if (st && typeof st.bsize === 'number' && typeof st.bavail === 'number') {
        return BigInt(st.bsize) * BigInt(st.bavail);
      }
    }
  } catch {
    // fall through
  }

  // Fallback: check-disk-space
  try {
    const p = process.platform === 'win32'
      ? path.parse(resolvedPath).root
      : resolvedPath;
    const info = await checkDiskSpace(p);
    if (info && typeof info.free === 'number' && Number.isFinite(info.free)) {
      return BigInt(Math.max(0, Math.floor(info.free)));
    }
  } catch {
    // ignore
  }

  return null;
}

function estimateOutputBytes({
  inputBytes,
  inputMeta,
  outputFormat,
  containerFormat: _containerFormat,
  resolution,
  frameRate,
  pixelFormat,
  audioCodec,
  channels,
  sampleRate,
  audioBitrate,
  audioOnly
}) {
  try {
    const inSize = typeof inputBytes === 'number' && Number.isFinite(inputBytes) ? inputBytes : null;
    const duration = inputMeta?.duration && Number.isFinite(inputMeta.duration) ? inputMeta.duration : null;
    const inW = inputMeta?.width && Number.isFinite(inputMeta.width) ? inputMeta.width : null;
    const inH = inputMeta?.height && Number.isFinite(inputMeta.height) ? inputMeta.height : null;
    const inFrames = inputMeta?.frames && Number.isFinite(inputMeta.frames) ? inputMeta.frames : null;

    const outWH = resolution && resolution !== 'match' ? parseWxH(resolution) : null;
    let outW = outWH?.w || inW;
    let outH = outWH?.h || inH;
    // This pipeline enforces even dimensions via a final scale filter.
    if (Number.isFinite(outW) && outW > 0) outW = outW - (outW % 2);
    if (Number.isFinite(outH) && outH > 0) outH = outH - (outH % 2);

    const fpsOut = frameRate && frameRate !== 'match'
      ? parseFps(frameRate)
      : (inFrames && duration ? (inFrames / duration) : null);

    const fpsIn = inFrames && duration ? (inFrames / duration) : null;

    // ================================
    // Audio-only outputs
    // ================================
    if (audioOnly) {
      if (!duration) return null;

      const enc = String(audioCodec || '').trim().toLowerCase();
      const sr = sampleRate && sampleRate !== 'default' ? parseInt(sampleRate, 10) : 48000;
      const ch = channels === 'mono' ? 1
        : channels === 'stereo' ? 2
        : channels === '5.1' ? 6
        : channels === '7.1' ? 8
        : 2;

      const pcmBps = pcmBytesPerSample(enc);
      if (pcmBps) {
        const total = BigInt(Math.ceil(duration * sr)) * BigInt(ch) * BigInt(pcmBps);
        return { bytes: total, method: 'pcm' };
      }

      const abr = audioBitrate ? parseInt(audioBitrate, 10) : null;
      if (abr && abr > 0) {
        // bitrate is in kbps
        const total = BigInt(Math.ceil(duration * (abr * 1000 / 8)));
        return { bytes: total, method: 'bitrate' };
      }

      // Fallback: cannot estimate; return null
      return null;
    }

    // ================================
    // Raw / uncompressed video outputs
    // ================================
    const isRaw = outputFormat === 'uncompressed_yuv' || outputFormat === 'uncompressed_rgb';
    if (isRaw) {
      if (!duration || !outW || !outH) return null;

      const bpp = bytesPerPixel(pixelFormat && pixelFormat !== 'default' ? pixelFormat : null) ||
        (outputFormat === 'uncompressed_rgb' ? 3.0 : 2.0);
      const framesOut = fpsOut ? Math.max(1, Math.ceil(duration * fpsOut)) : (inFrames || null);
      if (!framesOut) return null;

      const bytesPerFrame = BigInt(Math.ceil(outW * outH * bpp));
      const videoBytes = bytesPerFrame * BigInt(framesOut);

      // Add PCM audio if configured
      let audioBytes = 0n;
      const enc = String(audioCodec || '').trim().toLowerCase();
      const pcmBps = pcmBytesPerSample(enc);
      if (pcmBps && duration) {
        const sr = sampleRate && sampleRate !== 'default' ? parseInt(sampleRate, 10) : 48000;
        const ch = channels === 'mono' ? 1
          : channels === 'stereo' ? 2
          : channels === '5.1' ? 6
          : channels === '7.1' ? 8
          : 2;
        audioBytes = BigInt(Math.ceil(duration * sr)) * BigInt(ch) * BigInt(pcmBps);
      }

      return { bytes: videoBytes + audioBytes, method: 'raw' };
    }

    // ================================
    // Bitrate-based estimates (where target / implied data rate is known)
    // ================================
    if (duration) {
      const fmt = String(outputFormat || '').toLowerCase();

      // Fixed-bitrate formats (e.g. XDCAM).
      const fixedBps = IMPLIED_VIDEO_BITRATE_BPS[fmt];
      if (fixedBps && fixedBps > 0) {
        const videoBytes = BigInt(Math.ceil(duration * (fixedBps / 8)));
        const audioBytes = estimateAudioBytesFromSettings(duration, audioCodec, channels, sampleRate, audioBitrate);
        return { bytes: videoBytes + audioBytes, method: 'bitrate' };
      }

      // ProRes model: bitrate ≈ bppf * pixels * fps
      if (fmt.startsWith('prores_') && outW && outH) {
        const bppf = PRORES_BPPF[fmt];
        const fps = fpsOut || fpsIn;
        if (bppf && fps && fps > 0) {
          const videoBitrateBps = bppf * outW * outH * fps;
          const videoBytes = BigInt(Math.ceil(duration * (videoBitrateBps / 8)));
          const audioBytes = estimateAudioBytesFromSettings(duration, audioCodec, channels, sampleRate, audioBitrate);
          return { bytes: videoBytes + audioBytes, method: 'bitrate_model' };
        }
      }
    }
    // ================================
    // Generic ratio estimate (fallback)
    // ================================
    if (inSize == null) return null;
    let ratio = estimatedSizeRatioMap[outputFormat] || 0.8;

    // Adjust estimate for scaling and retiming when we can.
    if (inW && inH && outW && outH) {
      const inPixels = inW * inH;
      const outPixels = outW * outH;
      if (inPixels > 0 && outPixels > 0) {
        ratio *= (outPixels / inPixels);
      }
    }
    if (fpsIn && fpsOut && fpsIn > 0 && fpsOut > 0) {
      ratio *= (fpsOut / fpsIn);
    }

    const est = Math.max(0, Math.floor(inSize * ratio));
    return { bytes: BigInt(est), method: 'ratio' };
  } catch {
    return null;
  }
}

function getJobFilePath() {
  return path.join(ensureUserDataSubdir('logs'), 'job-queue.json');
}

function removeJobFile() {
  const jobFile = getJobFilePath();
  try {
    if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
  } catch {
    // ignore cleanup errors
  }
}

const estimatedSizeRatioMap = {
  // ProRes family
  'prores_proxy': 0.7,
  'prores_lt': 0.85,
  'prores_422': 1.2,
  'prores_422hq': 1.4,
  'prores_4444': 1.6,
  'prores_4444xq': 1.8,


  // Web + Delivery
  'h264_auto_gpu': 0.4,
  'h264': 0.4,
  'h265': 0.3,
  'vp9': 0.35,
  'av1': 0.3,

  // Broadcast / Mastering
  'xdcam_hd35': 0.9,
  'xdcam_hd50': 1.1,
  'xavc_l_1080p': 1.2,
  'xavc_i_4k': 1.5,
  'xavc_s': 0.5,
  'jpeg2000': 2.0,
  'dnxhd': 1.2,
  'cfhd': 1.2,
  'speedhq': 1.3,
  'v210': 2.2,

  // Archival / Legacy
  'ffv1': 1.0,
  'mjpeg': 1.5,
  'qtrle': 2.0,
  'utvideo': 1.2,
  'huffyuv': 1.4,
  'ffvhuff': 1.4,
  'uncompressed_yuv': 2.2,
  'uncompressed_rgb': 2.5,

  // Image Sequences
  'png_sequence': 1.2,
  'tiff_sequence': 1.4,
  'exr_sequence': 2.0,
  'dpx_sequence': 2.0,
  'tga_sequence': 1.3,
  'image_sequence': 1.3
};

const parseRational = (value) => {
  if (value == null) return 0;
  const str = String(value).trim();
  if (!str) return 0;
  if (str.includes('/')) {
    const [numRaw, denRaw] = str.split('/');
    const num = Number(numRaw);
    const den = Number(denRaw);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      return num / den;
    }
    return 0;
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
};

const toIntSafe = (value) => {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
};

const toFloatSafe = (value) => {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

const FFPROBE_TIMEOUT_MS = 15000;
const FFPROBE_MAX_BUFFER = 10 * 1024 * 1024;
const FFPROBE_EXEC_OPTIONS = { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFPROBE_MAX_BUFFER };

const buildFfprobeErrorInfo = (err, filePath, context, logger = null) => {
  if (!err) return null;
  const message = err?.message || String(err);
  const isTimeout = err?.code === 'ETIMEDOUT' || err?.killed || /timed out/i.test(message);
  const isMaxBuffer = err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(message);
  const type = isTimeout ? 'timeout' : (isMaxBuffer ? 'max_buffer' : 'error');
  const recoverable = isTimeout || isMaxBuffer;

  if (recoverable) {
    const shortName = filePath ? path.basename(String(filePath)) : 'file';
    const detail = isTimeout
      ? `ffprobe ${context} timed out after ${Math.round(FFPROBE_TIMEOUT_MS / 1000)}s for ${shortName}`
      : `ffprobe ${context} exceeded output buffer for ${shortName}`;
    const msg = formatTranscodeMessage(transcodeMessage('transcodeWarningFfprobeRecoverableSkip', { detail }));
    const meta = {
      context,
      filePath: filePath ? String(filePath) : '',
      recoverable: true,
      type
    };

    if (logger && typeof logger.warn === 'function') {
      logger.warn(msg, meta);
    } else {
      sendLogMessage('transcode', msg, '', false, shortName, 'warn', '', '', meta);
    }
  }

  return {
    type,
    recoverable,
    message
  };
};

const getFFprobeData = async (filePath, opts = {}) => {
  // ⚡ Fast probe.
  // NOTE: do NOT use -count_frames here. That forces ffprobe to scan the whole file and can
  // add huge delays before FFmpeg even launches (especially on network volumes / long clips).
  const preferAudio = !!opts?.preferAudio;
  const logger = opts?.logger || null;
  const probeTargets = preferAudio ? ['a:0', 'v:0', null] : ['v:0', 'a:0', null];
  let lastError = null;
  let fallbackData = null;

  const runProbe = (streamSelector) => new Promise((resolve) => {
    const args = [
      '-v', 'error',
      ...(streamSelector ? ['-select_streams', streamSelector] : []),
      '-show_entries', 'stream=width,height,nb_frames,avg_frame_rate,r_frame_rate:format=duration',
      '-of', 'json',
      filePath
    ];
    const context = streamSelector ? `${streamSelector} probe` : 'fallback probe';
    execFile(ffprobePath, args, FFPROBE_EXEC_OPTIONS, (err, stdout) => {
      if (err) {
        return resolve({ data: null, hasStream: false, error: buildFfprobeErrorInfo(err, filePath, context, logger) });
      }
      try {
        const data = JSON.parse(stdout.toString());
        const stream = data.streams && data.streams[0] ? data.streams[0] : null;

        const duration = toFloatSafe(data.format?.duration);
        const width = toIntSafe(stream?.width);
        const height = toIntSafe(stream?.height);

        // nb_frames is often present for MOV/MP4, but can be "N/A". Fall back to duration * fps.
        let frames = toIntSafe(stream?.nb_frames);
        if (!frames && duration > 0) {
          const fps = parseRational(stream?.avg_frame_rate) || parseRational(stream?.r_frame_rate);
          if (fps > 0) frames = Math.max(1, secondsToFrames(duration, fps, 'ceil'));
        }

        resolve({
          data: { frames, duration, width, height },
          hasStream: !!stream,
          error: null
        });
      } catch {
        resolve({
          data: null,
          hasStream: false,
          error: {
            type: 'parse',
            recoverable: false,
            message: formatTranscodeMessage('transcodeErrorFfprobeParseOutput')
          }
        });
      }
    });
  });

  for (const target of probeTargets) {
    const result = await runProbe(target);
    if (result?.data) {
      const hasDuration = Number.isFinite(result.data.duration) && result.data.duration > 0;
      if (result.hasStream) {
        return { data: result.data, error: null };
      }
      if (hasDuration) {
        fallbackData = result.data;
      }
    }
    if (result?.error) lastError = result.error;
  }

  if (fallbackData) {
    return { data: fallbackData, error: null };
  }

  return {
    data: null,
    error: lastError || {
      type: 'no_streams',
      recoverable: false,
      message: formatTranscodeMessage('transcodeErrorFfprobeNoStreams')
    }
  };
};

const getFFprobeFullJson = async (filePath) => {
  return new Promise((resolve) => {
    execFile(ffprobePath, [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      '-of', 'json',
      filePath
    ], FFPROBE_EXEC_OPTIONS, (err, stdout) => {
      if (err) {
        return resolve({ data: null, error: buildFfprobeErrorInfo(err, filePath, 'full probe') });
      }
      try {
        resolve({ data: JSON.parse(stdout.toString()), error: null });
      } catch {
        resolve({
          data: null,
          error: {
            type: 'parse',
            recoverable: false,
            message: formatTranscodeMessage('transcodeErrorFfprobeParseOutput')
          }
        });
      }
    });
  });
};

// ================================
// Caption sidecar helpers (MCC/SCC -> MCC)
// ================================

function _parseMccHeaderRate(lines = []) {
  // Returns { fps: number|null, dropFrame: boolean|null }
  // MCC headers typically include:
  //   Time Code Rate=30DF (nominal) or 29.97
  //   Drop Frame=True/False
  let rateRaw = '';
  let dfRaw = '';

  for (const line of lines) {
    const s = String(line || '').trim();
    if (!s) continue;

    // Stop scanning when body starts.
    if (/^\d{2}:\d{2}:\d{2}[:;]\d{2}(?:\.|\s|\t|$)/.test(s)) break;

    const mRate = /^Time\s*Code\s*Rate\s*=\s*(.+)$/i.exec(s);
    if (mRate) rateRaw = String(mRate[1] || '').trim();

    const mDf = /^Drop\s*Frame\s*=\s*(.+)$/i.exec(s);
    if (mDf) dfRaw = String(mDf[1] || '').trim();
  }

  let fps = null;
  let dropFrame = null;

  if (rateRaw) {
    const m = /^([0-9]+(?:\.[0-9]+)?)(DF)?$/i.exec(rateRaw);
    if (m) {
      let n = Number(m[1]);
      const dfFromRate = !!m[2];
      if (Number.isFinite(n) && n > 0) {
        // Nominal DF mapping
        if (dfFromRate) {
          if (Math.abs(n - 30) < 0.1) n = 29.97;
          if (Math.abs(n - 60) < 0.2) n = 59.94;
        }
        fps = n;
        dropFrame = dfFromRate;
      }
    }
  }

  if (dfRaw) {
    if (/^true$/i.test(dfRaw)) dropFrame = true;
    else if (/^false$/i.test(dfRaw)) dropFrame = false;
  }

  return { fps, dropFrame };
}

function _normalizeMccTimecodesToZero({ inputPath, outputPath, fpsFallback = null, dropFrameFallback = null }) {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const text = String(raw || '').replace(/\uFEFF/g, '');
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const headerInfo = _parseMccHeaderRate(lines);
  const fps = (Number.isFinite(headerInfo.fps) && headerInfo.fps > 0)
    ? headerInfo.fps
    : (Number.isFinite(Number(fpsFallback)) && Number(fpsFallback) > 0 ? Number(fpsFallback) : 29.97);

  const dfHint = (typeof headerInfo.dropFrame === 'boolean')
    ? headerInfo.dropFrame
    : (typeof dropFrameFallback === 'boolean')
      ? dropFrameFallback
      : isDropFrameRate(fps);

  // Find the earliest timecode frame used in the file.
  let baseFrame = null;
  const tcLineRe = /^(\d{2}:\d{2}:\d{2}[:;]\d{2})(\.\d+,\d+)?(\s+|\t)(.*)$/;

  for (const line of lines) {
    const m = tcLineRe.exec(String(line || '').trim());
    if (!m) continue;
    const tcBase = m[1];
    const fr = framesFromTimecodeLabel(tcBase, fps, dfHint);
    if (Number.isFinite(fr) && (baseFrame == null || fr < baseFrame)) {
      baseFrame = fr;
    }
  }

  const base = (typeof baseFrame === 'number' && Number.isFinite(baseFrame)) ? baseFrame : 0;

  const outLines = lines.map((line) => {
    const trimmed = String(line || '').trim();
    const m = tcLineRe.exec(trimmed);
    if (!m) return line;

    const tcBase = m[1];
    const suffix = m[2] || '';
    const ws = m[3] || '\t';
    const payload = m[4] || '';

    const fr = framesFromTimecodeLabel(tcBase, fps, dfHint);
    const shifted = Math.max(0, fr - base);

    // MCC commonly uses ':' delimiter even for DF.
    const tcOut = String(formatTimecodeFromFrames(shifted, dfHint, fps, 'colon')).replace(';', ':');
    return `${tcOut}${suffix}${ws}${payload}`;
  });

  // MCC files are commonly CRLF.
  fs.writeFileSync(outputPath, outLines.join('\r\n') + '\r\n', 'utf8');

  return { fps, dropFrame: dfHint, baseFrame: base };
}

function _convertSccToMcc({ sccPath, outputPath, fpsHint = 29.97 }) {
  const { decodeSccFile } = require('./sccDecoder');
  const { generateMCC } = require('./sccEncoder');

  const fps = Number.isFinite(Number(fpsHint)) ? Number(fpsHint) : 29.97;

  // SCC in this codebase is fundamentally 29.97 (DF or opt-in NDF).
  if (Math.abs(fps - 29.97) > 0.06) {
    throw new Error(formatTranscodeMessage('transcodeErrorCaptionSccAttachRequires2997'));
  }

  const decoded = decodeSccFile(sccPath, { fps: 29.97 });
  const cues = Array.isArray(decoded?.cues) ? decoded.cues : [];

  const segments = cues.map((c) => {
    const lines = Array.isArray(c.lines) ? c.lines : String(c.text || '').split('\n');
    const placement = Array.isArray(c.sccPlacement) ? c.sccPlacement : null;

    // Preserve SCC placement (PAC-derived row/col) when converting to MCC.
    // SCC "center alignment" is encoded as a start column; if we don't carry row/col,
    // generateMCC will reflow as left-justified in Premiere.
    let text = String(c.text || '');
    if (placement && placement.length) {
      text = lines.map((ln, i) => {
        const p = placement[i] || {};
        const rowTag = Number.isFinite(p.row) ? `{row:${p.row}}` : '';
        const colTag = Number.isFinite(p.col) ? `{col:${p.col}}` : '';
        // Strip PAC-derived leading spaces so we don’t double-indent if tags are honored.
        const lineText = String(ln || '').replace(/^\s+/, '');
        return `${rowTag}${colTag}${lineText}`;
      }).join('\n');
    }

    return {
      start: Number(c.start) || 0,
      end: Number(c.end) || 0,
      text,
      lines,
      ...(placement ? { sccPlacement: placement } : {})
    };
  });

  const mcc = generateMCC(segments, {
    fps: 29.97,
    dropFrame: decoded?.dropFrame === true,
    include608Compatibility: true,
    compatGenerationRules: {
      // OPTION A: treat '\n' as HARD line breaks for 608 derivation.
      // This prevents the SCC→MCC step from reflowing words across lines,
      // which otherwise breaks your per-line start-column centering.
      allowExplicitLineBreaks: true
    },
    serviceNumber: 1,
    language: 'eng',
    sccOptions: {
      // Honor {row:}{col:} SPL tags as true 708 placement (Premiere often renders 708).
      preserveImported708Layout: true
    }
  });

  fs.writeFileSync(outputPath, String(mcc), 'utf8');
  return { fps: 29.97, dropFrame: decoded?.dropFrame === true };
}

async function preflightTranscodeDisk(config = {}) {
  const {
    inputFiles,
    outputFormat,
    containerFormat,
    outputFolder,
    resolution,
    frameRate,
    pixelFormat,
    audioCodec,
    channels,
    sampleRate,
    audioBitrate,
    audioOnly,
    logger
  } = config;

  const files = Array.isArray(inputFiles) ? inputFiles : [];
  if (!files.length || !outputFolder) {
    return { status: 'unknown', reason: 'missing input files or output folder' };
  }

  const { missing: outputFolderMissing } = resolveDiskCheckPath(outputFolder);
  const freeBytes = await getFreeDiskBytes(outputFolder);
  // v1 disk preflight should be conservative for batch workflows.
  // The previous implementation used the *largest* single-file estimate,
  // which can greenlight large batches that later run out of disk mid-run.
  // Here we estimate the *total* output for the entire batch.
  let totalEstimate = 0n;
  let estimatedCount = 0;
  let firstMethod = null;
  let mixedMethods = false;
  let maxFileEstimate = null;
  const skippedFiles = [];
  const fileResults = new Array(files.length);
  const preflightConcurrency = 4;

  const tasks = files.map((file, index) => async () => {
    if (!file) {
      fileResults[index] = { skipped: true, file };
      return;
    }

    let st = null;
    try {
      st = await fs.promises.stat(file);
    } catch {
      fileResults[index] = { skipped: true, file };
      return;
    }

    const inputMetaResult = await getFFprobeData(file, { preferAudio: audioOnly, logger });
    const inputMeta = inputMetaResult?.data || null;
    if (!inputMeta) {
      fileResults[index] = { skipped: true, file };
      return;
    }

    const estimate = estimateOutputBytes({
      inputBytes: st.size,
      inputMeta,
      outputFormat,
      containerFormat,
      resolution,
      frameRate,
      pixelFormat,
      audioCodec,
      channels,
      sampleRate,
      audioBitrate,
      audioOnly
    });

    fileResults[index] = { skipped: false, file, estimate };
  });

  await runWithConcurrencyLimit(tasks, preflightConcurrency);

  for (const result of fileResults) {
    if (!result) continue;
    if (result.skipped) {
      skippedFiles.push(result.file);
      continue;
    }

    const estimate = result.estimate;
    if (estimate?.bytes == null) continue;

    totalEstimate += estimate.bytes;
    estimatedCount += 1;

    if (!firstMethod) {
      firstMethod = estimate.method || null;
    } else if ((estimate.method || null) !== firstMethod) {
      mixedMethods = true;
    }

    if (!maxFileEstimate || estimate.bytes > maxFileEstimate.bytes) {
      maxFileEstimate = { ...estimate, file: result.file };
    }
  }

  const skippedCount = skippedFiles.length;
  const warnings = [];
  if (skippedCount) {
    warnings.push(`Skipped ${skippedCount} file(s) due to stat/metadata errors.`);
  }
  if (outputFolderMissing) {
    warnings.push('Output folder missing; free space checked on parent volume.');
  }
  const warning = warnings.length ? warnings.join(' ') : null;

  if (!estimatedCount || totalEstimate <= 0n) {
    return { status: 'unknown', freeBytes, warning, skippedFiles: skippedCount };
  }

  if (freeBytes == null) {
    return {
      status: 'unknown',
      freeBytes,
      estimateBytes: totalEstimate,
      estimateMethod: mixedMethods ? 'sum_mixed' : (firstMethod ? `sum_${firstMethod}` : 'sum'),
      estimateFile: maxFileEstimate?.file,
      estimatedFiles: estimatedCount,
      totalFiles: files.length,
      warning,
      skippedFiles: skippedCount
    };
  }

  const requiredBytes = (totalEstimate * 11n) / 10n;
  const status = freeBytes < requiredBytes ? 'insufficient' : 'ok';
  return {
    status,
    freeBytes,
    estimateBytes: totalEstimate,
    estimateMethod: mixedMethods ? 'sum_mixed' : (firstMethod ? `sum_${firstMethod}` : 'sum'),
    estimateFile: maxFileEstimate?.file,
    estimatedFiles: estimatedCount,
    totalFiles: files.length,
    requiredBytes,
    warning,
    skippedFiles: skippedCount
  };
}

function _stripAsciiControlChars(value) {
  return Array.from(String(value ?? '')).filter((ch) => ch.charCodeAt(0) >= 32).join('');
}

function stripIllegalFilenameChars(name) {
  const rawName = String(name ?? '');
  if (!rawName) return '';
  if (process.platform === 'win32') {
    const stripped = Array.from(rawName).filter((ch) => !(/[<>:"/\\|?*]/.test(ch) || ch.charCodeAt(0) < 32)).join('');
    return stripped.replace(/[. ]+$/g, '');
  }
  return rawName.replace(/[/\0]/g, '');
}

function isReservedWindowsDeviceName(name) {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
}

function appendNumericSuffix(filePath, index) {
  const ext = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  const suffix = String(index).padStart(2, '0');
  return `${base}_${suffix}${ext}`;
}

function _findAvailableOutputPath(outputPath, existsFn = (candidatePath) => fs.existsSync(candidatePath)) {
  let candidate = outputPath;
  let counter = 1;
  while (existsFn(candidate)) {
    candidate = appendNumericSuffix(outputPath, counter);
    counter += 1;
  }
  return candidate;
}

async function findAvailableOutputPathAsync(outputPath, existsFn) {
  let candidate = outputPath;
  let counter = 1;
  while (await existsFn(candidate)) {
    candidate = appendNumericSuffix(outputPath, counter);
    counter += 1;
  }
  return candidate;
}

function buildOutputName(inputPath, index, opts) {
  const { containerFormat, appendSeq = false, isBatch } = opts;
  const base = path.basename(inputPath, path.extname(inputPath));
  const strippedName = stripIllegalFilenameChars(base);
  const safeName = strippedName && strippedName !== '.' && strippedName !== '..' ? strippedName : 'output';
  // Windows device names (e.g., CON, PRN, COM1) are invalid even after sanitizing.
  // If the sanitized basename matches a reserved device name, append a safe suffix.
  const resolvedName = (process.platform === 'win32' && isReservedWindowsDeviceName(safeName))
    ? `${safeName}_1`
    : safeName;
  const seq = String(index).padStart(3, '0');
  const useSeq = appendSeq || isBatch;
  const ext = ['image_sequence', 'image2'].includes(containerFormat) ? '' : `.${containerFormat}`;
  return useSeq ? `${resolvedName}_${seq}${ext}` : `${resolvedName}${ext}`;
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  const normalized = path.normalize(resolved);
  return (process.platform === 'win32' || process.platform === 'darwin')
    ? normalized.toLowerCase()
    : normalized;
}

async function resolveOutputPathForInput({
  inputPath,
  index,
  outputFolder,
  containerFormat,
  appendSeq,
  isBatch,
  outputFormat
}) {
  const outName = buildOutputName(inputPath, index, {
    containerFormat,
    appendSeq,
    isBatch
  });
  let finalOutPath = path.join(outputFolder, outName);

  const isImageSeq = containerFormat === 'image_sequence' || containerFormat === 'image2';
  const imageSeqExtMap = {
    png_sequence: '.png',
    tiff_sequence: '.tiff',
    exr_sequence: '.exr',
    dpx_sequence: '.dpx',
    tga_sequence: '.tga'
  };
  const imageSeqExt = imageSeqExtMap[outputFormat] || '.png';
  const imageSeqExists = async (candidatePath) => {
    if (!isImageSeq) return fs.existsSync(candidatePath);
    if (fs.existsSync(candidatePath)) return true;
    const imageSeqDir = path.dirname(candidatePath);
    const imageSeqPrefix = path.basename(candidatePath);
    const imageSeqPrefixWithSep = `${imageSeqPrefix}_`;
    let dir;
    try {
      dir = await fs.promises.opendir(imageSeqDir);
      for await (const entry of dir) {
        const name = entry.name;
        if (!name.startsWith(imageSeqPrefixWithSep)) continue;
        if (!name.endsWith(imageSeqExt)) continue;
        const framePart = name.slice(
          imageSeqPrefixWithSep.length,
          name.length - imageSeqExt.length
        );
        if (/^\d+$/.test(framePart)) {
          return true;
        }
      }
    } catch {
      return false;
    } finally {
      if (dir) {
        try { await dir.close(); } catch {}
      }
    }
    return false;
  };

  finalOutPath = await findAvailableOutputPathAsync(finalOutPath, imageSeqExists);

  return {
    finalOutPath,
    outName: path.basename(finalOutPath),
    isImageSeq,
    imageSeqExt,
    wasSuffixed: finalOutPath !== path.join(outputFolder, outName)
  };
}

async function findOutputPathCollision({
  inputFiles,
  outputFolder,
  containerFormat,
  appendSeq,
  isBatch,
  outputFormat
}) {
  if (!Array.isArray(inputFiles) || inputFiles.length === 0) return null;
  if (!outputFolder) return null;

  for (let index = 0; index < inputFiles.length; index += 1) {
    const inputPath = inputFiles[index];
    if (!inputPath) continue;
    try {
      const stat = await fs.promises.stat(inputPath);
      if (stat.isDirectory()) continue;
    } catch {
      // skip stat failures; downstream validation will handle missing files
    }
    const outputPlan = await resolveOutputPathForInput({
      inputPath,
      index,
      outputFolder,
      containerFormat,
      appendSeq,
      isBatch,
      outputFormat
    });
    const outputPath = outputPlan.finalOutPath;
    if (normalizePathForCompare(outputPath) === normalizePathForCompare(inputPath)) {
      return { inputPath, outputPath };
    }
  }

  return null;
}

// ✅ Import cancel helpers
const { cancelJob, createCancelToken } = require('./cancelUtils');

// 🛑 Track running FFmpeg processes per job
const jobProcesses = new Map();
const cancellationEscalationTimers = new WeakMap();

function isProcessActive(proc) {
  return !!proc && proc.exitCode === null && proc.signalCode === null;
}

function clearEscalationTimer(proc) {
  const timer = cancellationEscalationTimers.get(proc);
  if (!timer) return;
  clearTimeout(timer);
  cancellationEscalationTimers.delete(proc);
}

function attachEscalationCleanupListener(proc) {
  if (!proc || proc.__leadAeCancelCleanupAttached) return;
  proc.__leadAeCancelCleanupAttached = true;
  const clearTimer = () => clearEscalationTimer(proc);
  if (typeof proc.once === 'function') {
    proc.once('exit', clearTimer);
    proc.once('close', clearTimer);
  }
}

function registerJobProcess(jobId, proc) {
  if (!jobId || !proc) return;
  let set = jobProcesses.get(jobId);
  if (!set) {
    set = new Set();
    jobProcesses.set(jobId, set);
  }
  set.add(proc);
}

function unregisterJobProcess(jobId, proc) {
  if (!jobId || !proc) return;
  const set = jobProcesses.get(jobId);
  if (!set) return;
  set.delete(proc);
  if (set.size === 0) {
    jobProcesses.delete(jobId);
  }
}

async function runTranscode(config) {
  if (!config.jobId) {
    config.jobId = `transcode-${Date.now()}`;
  }

  if (process.env.NODE_ENV === 'test') {
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId || 1,
        panel: 'transcode',
        percent: 100,
        completed: config.inputFiles?.length || 1,
        total: config.inputFiles?.length || 1
      });
    }
    const msg = formatTranscodeMessage(transcodeMessage('transcode.log.watchTriggered', { count: config.inputFiles?.length || 0 }));
  return Promise.resolve({ success: true, cancelled: false, log: [msg], logText: msg });
 }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const executeTranscode = async () => {
      let jobLogger = null;
      let logs = [];
      let archivePath = null;
      let structuredPath = null;
      let persistJobLogs = () => {};
      let refreshSavedJobReportCopies = () => {};
      let captionTempDir = null;
      let unbindProgress = null;
      let progressManager = null;
      const savedJobReportCopies = new Set();

      try {
      const fsAsync = fs.promises;
      const pathExists = async (targetPath) => {
        try {
          await fsAsync.access(targetPath, fs.constants.F_OK);
          return true;
        } catch {
          return false;
        }
      };

      const removeFileIfExists = async (targetPath) => {
        try {
          await fsAsync.unlink(targetPath);
          return true;
        } catch (err) {
          if (err?.code === 'ENOENT') return false;
          throw err;
        }
      };

      if (!config.signal) config.signal = createCancelToken(config.jobId);
      jobLogger = createJobLogger({
        panel: 'transcode',
        jobId: config.jobId,
        stage: 'init',
        streamToFile: true,
        maxEntries: 5000,
        maxEntryBytes: 8 * 1024 * 1024
      });

      const userLog = createJobUserLog(jobLogger, {
        maxLines: 5000,
        maxBytes: 2 * 1024 * 1024,
        pickLevel: (text, isError) => {
          const t = String(text || '').trim();

          // Command echoes often contain "-loglevel error" which is not an error condition.
          // Keep them informational to avoid false error/warn classification.
          if (/^🛠\s*FFmpeg args:/i.test(t) || /^🛠\s*FFprobe args:/i.test(t)) return 'info';

          const scrubbed = t.replace(/-loglevel\s+error\b/ig, '-loglevel <level>');

          const inferredError = isError || /❌|\berror\b/i.test(scrubbed);
          const inferredWarn = !inferredError && (/⚠️|\bwarn\b/i.test(scrubbed));
          return inferredError ? 'error' : inferredWarn ? 'warn' : 'info';
        }
      });
      logs = userLog.lines;

      const sendJobLog = (msg, isError = false, detail = '', fileId = '') => (
        userLog.push(msg, detail, isError, fileId)
      );
      structuredPath = jobLogger.getStructuredLogPath?.() || structuredPath;

      let didPersistJobLogs = false;
      let reportStats = {
        requestedFiles: Array.isArray(config.inputFiles) ? config.inputFiles.length : 0,
      };
      refreshSavedJobReportCopies = () => {
        if (!archivePath || savedJobReportCopies.size === 0) return;
        if (!fs.existsSync(archivePath)) return;
        for (const targetPath of savedJobReportCopies) {
          try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(archivePath, targetPath);
          } catch (err) {
            console.warn('⚠️ Failed to refresh saved transcode TXT log copy:', err?.message || err);
          }
        }
      };
      persistJobLogs = ({ rewriteText = false, closeLogger = true } = {}) => {
        if (didPersistJobLogs && !rewriteText) {
          if (closeLogger) {
            try { jobLogger.close?.(); } catch {}
          }
          return;
        }
        try {
          if (!structuredPath) {
            structuredPath = jobLogger.getStructuredLogPath?.() || null;
          }
          if (!structuredPath) {
            structuredPath = writeJobLogToFile('transcode', config.jobId, jobLogger.getEntries());
          }
        } catch (e) {
          console.warn('⚠️ Failed to persist transcode JSONL log:', e?.message || e);
        }
        try {
          if (!archivePath || rewriteText) {
            archivePath = writeJobTextToFile(
            'transcode',
            config.jobId,
            jobLogger.getEntries(),
            {
              structuredLogPath: structuredPath,
              inputs: {
                sourceCount: Array.isArray(config.inputFiles) ? config.inputFiles.length : 0,
                sources: Array.isArray(config.inputFiles)
                  ? config.inputFiles.slice(0, 30).map(f => (typeof f === 'string' ? f : (f?.fullPath || f?.path || String(f))))
                  : [],
              },
              outputs: {
                primaryDestination: config.outputFolder || '',
              },
              settings: {
                mode: config.watchMode ? 'watch' : 'manual',
                outputFormat: config.outputFormat || '',
                containerFormat: config.containerFormat || '',
                resolution: config.resolution || '',
                frameRate: config.frameRate || '',
                audioCodec: config.audioCodec || '',
                channels: config.channels || '',
                pixelFormat: config.pixelFormat || '',
                colorRange: config.colorRange || '',
                fieldOrder: config.fieldOrder || '',
                lutPath: config.lutPath || '',
                audioOnly: !!config.audioOnly,
                appendSequenceNumbers: !!config.appendSeq,
                preserveMetadata: config.preserveMetadata !== false,
                verificationMethod: config.verification?.method || 'none',
                saveLog: !!config.verification?.saveLog,
                captions: !!config.captionSidecarPath,
              },
              stats: reportStats,
            }
          );
          }
        } catch (e) {
          console.warn('⚠️ Failed to persist transcode TXT log:', e?.message || e);
        }
        didPersistJobLogs = true;
        if (closeLogger) {
          try { jobLogger.close?.(); } catch {}
        }

      };
    const {
      inputFiles,
      outputFormat,
      dnxProfile,
      containerFormat,
      outputFolder,
      resolution,
      frameRate,
      dropFrame,
      audioCodec,
      channels,
      pixelFormat,
      colorRange,
      fieldOrder,
      lutPath,
      sampleRate,
      audioBitrate,
      normalizeAudio,
      audioDelay,
      verification,
      captionSidecarPath,

      enableN8N,
      n8nUrl,
      n8nAllowPrivate,
      n8nAllowlist: n8nAllowlistConfig,
      n8nAllowedHosts,
      n8nIncludePaths,
      n8nLog,
      notes,
      watchMode,
      appendSeq = false,
      preserveMetadata = true,
      audioOnly = false
    } = config;

    const missingBinaries = [];
    const binaryChecks = [
      { label: 'ffmpeg', value: ffmpegPath },
      { label: 'ffprobe', value: ffprobePath }
    ];
    for (const { label, value } of binaryChecks) {
      if (!value || !fs.existsSync(value)) {
        missingBinaries.push(label);
        continue;
      }
      if (typeof fs.accessSync === 'function') {
        try {
          fs.accessSync(value, fs.constants.X_OK);
        } catch {
          missingBinaries.push(label);
        }
      }
    }

    if (missingBinaries.length > 0) {
      const expectedMessage = `ffmpeg: ${ffmpegPath || 'unset'}, ffprobe: ${ffprobePath || 'unset'}`;
      const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorFfmpegBinariesMissing', { expectedMessage }));
      sendJobLog(msg, true);
      jobLogger?.setStage?.('error');
      jobLogger?.error?.('FFmpeg binaries missing', {
        reason: 'missing_ffmpeg_binaries',
        missing: missingBinaries,
        ffmpegPath: ffmpegPath || null,
        ffprobePath: ffprobePath || null
      });
      persistJobLogs();
      if (global.queue) {
        const total = Array.isArray(inputFiles) ? inputFiles.length : 0;
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'transcode',
          status: msg,
          percent: 100,
          completed: 0,
          total: total || 1,
          eta: '0s'
        });
      }
      resolve({
        success: false,
        cancelled: false,
        log: logs,
        logText: logs.join('\n'),
        archivePath,
        structuredLogPath: structuredPath,
        jobId: config.jobId
      });
      return;
    }

    const captionSidecar = (typeof captionSidecarPath === 'string') ? captionSidecarPath.trim() : '';
    const embedCaptions = !!captionSidecar;
    const effectiveContainerFormat = embedCaptions ? 'mxf' : containerFormat;
    const captionSidecarResolved = embedCaptions ? path.resolve(captionSidecar) : null;
    let preparedCaptionMccPath = null;

    if (!Array.isArray(inputFiles) || inputFiles.length === 0) {
      const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorNoInputFiles'));
      sendJobLog(msg, true);
      jobLogger?.setStage?.('error');
      jobLogger?.error?.('Invalid transcode configuration', {
        reason: 'missing_input_files',
        inputFiles
      });
      persistJobLogs();
      resolve({
        success: false,
        cancelled: false,
        log: logs,
        logText: logs.join('\n'),
        archivePath,
        structuredLogPath: structuredPath,
        jobId: config.jobId
      });
      return;
    }

    const outputFolderPath = typeof outputFolder === 'string' ? outputFolder.trim() : '';
    try {
      if (!outputFolderPath) {
        throw new Error('empty_output_folder');
      }
      const outStats = await fs.promises.stat(outputFolderPath);
      if (!outStats.isDirectory()) {
        throw new Error('output_folder_not_directory');
      }
      try {
        await fs.promises.access(outputFolderPath, fs.constants.W_OK);
      } catch {
        const probeFile = path.join(
          outputFolderPath,
          `.lead-aeassist-write-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
        );
        try {
          await fs.promises.writeFile(probeFile, '');
          await fs.promises.unlink(probeFile);
        } catch {
          throw new Error('output_folder_not_writable');
        }
      }
    } catch (err) {
      let msg = formatTranscodeMessage(transcodeMessage('transcodeErrorOutputFolderNotFound'));
      if (err?.message === 'output_folder_not_writable') {
        msg = formatTranscodeMessage(transcodeMessage('transcodeErrorOutputFolderNotWritable'));
      } else if (err?.message === 'empty_output_folder') {
        msg = formatTranscodeMessage(transcodeMessage('transcodeErrorOutputFolderRequired'));
      }
      sendJobLog(msg, true);
      jobLogger?.setStage?.('error');
      jobLogger?.error?.('Invalid transcode configuration', {
        reason: 'invalid_output_folder',
        outputFolder
      });
      persistJobLogs();
      resolve({
        success: false,
        cancelled: false,
        log: logs,
        logText: logs.join('\n'),
        archivePath,
        structuredLogPath: structuredPath,
        jobId: config.jobId
      });
      return;
    }

    if (embedCaptions) {
      const msgForce = (String(containerFormat || '').toLowerCase() !== 'mxf')
        ? formatTranscodeMessage(transcodeMessage('transcodeLogCaptionsForceMxf'))
        : formatTranscodeMessage(transcodeMessage('transcodeLogCaptionsAlreadyMxf'));
      sendJobLog(msgForce);

      if (audioOnly) {
        const msg = formatTranscodeMessage('transcodeCaptionsNotAllowedAudioOnly');
        sendJobLog(msg, true);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Invalid transcode configuration', { reason: 'captions_audio_only', captionSidecarPath });
        persistJobLogs();
        resolve({ success: false, cancelled: false, log: logs, logText: logs.join('\n'), archivePath, structuredLogPath: structuredPath, jobId: config.jobId });
        return;
      }

      if (Array.isArray(inputFiles) && inputFiles.length !== 1) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorCaptionsSingleInputOnly'));
        sendJobLog(msg, true);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Invalid transcode configuration', { reason: 'captions_requires_single_input', inputCount: inputFiles.length });
        persistJobLogs();
        resolve({ success: false, cancelled: false, log: logs, logText: logs.join('\n'), archivePath, structuredLogPath: structuredPath, jobId: config.jobId });
        return;
      }

      try {
        if (!captionSidecarResolved || !(await pathExists(captionSidecarResolved))) {
          throw new Error(formatTranscodeMessage('transcodeErrorCaptionFileNotFound'));
        }
        const st = await fsAsync.stat(captionSidecarResolved);
        if (!st.isFile()) throw new Error(formatTranscodeMessage('transcodeErrorCaptionPathNotFile'));
        const ext = path.extname(captionSidecarResolved).toLowerCase();
        if (ext !== '.mcc' && ext !== '.scc') {
          throw new Error(formatTranscodeMessage('transcodeErrorCaptionFileMustBeMccOrScc'));
        }
      } catch (err) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorCaptionsAttachFailed', { error: err?.message || String(err) }));
        sendJobLog(msg, true);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Invalid caption sidecar configuration', { captionSidecarPath, error: err?.message || String(err) });
        persistJobLogs();
        resolve({ success: false, cancelled: false, log: logs, logText: logs.join('\n'), archivePath, structuredLogPath: structuredPath, jobId: config.jobId });
        return;
      }
    }

    const watchFolderPath = typeof config.watchFolder === 'string' ? config.watchFolder.trim() : '';
    if ((watchMode || watchFolderPath) && watchFolderPath) {
      const normalizedOutput = normalizePathForCompare(outputFolderPath);
      const normalizedWatch = normalizePathForCompare(watchFolderPath);
      const watchPrefix = normalizedWatch.endsWith(path.sep)
        ? normalizedWatch
        : `${normalizedWatch}${path.sep}`;
      if (normalizedOutput === normalizedWatch || normalizedOutput.startsWith(watchPrefix)) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorWatchOutputNested'));
        sendJobLog(msg, true);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Invalid transcode configuration', {
          reason: 'output_inside_watch_folder',
          outputFolder: outputFolderPath,
          watchFolder: config.watchFolder
        });
        persistJobLogs();
        resolve({
          success: false,
          cancelled: false,
          log: logs,
          logText: logs.join('\n'),
          jobId: config.jobId
        });
        return;
      }
    }

    const outputCollision = await findOutputPathCollision({
      inputFiles,
      outputFolder: outputFolderPath,
      containerFormat: effectiveContainerFormat,
      appendSeq,
      isBatch: Array.isArray(inputFiles) && inputFiles.length > 1,
      outputFormat
    });
    if (outputCollision) {
      const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorOutputCollision', { outputPath: outputCollision.outputPath, inputPath: outputCollision.inputPath }));
      sendJobLog(msg, true);
      jobLogger?.setStage?.('error');
      jobLogger?.error?.('Invalid transcode configuration', {
        reason: 'output_path_collision',
        inputPath: outputCollision.inputPath,
        outputPath: outputCollision.outputPath
      });
      persistJobLogs();
      resolve({
        success: false,
        cancelled: false,
        log: logs,
        logText: logs.join('\n'),
        archivePath,
        structuredLogPath: structuredPath,
        jobId: config.jobId
      });
      return;
    }

    if (!audioOnly && !embedCaptions) {
      const invalidFields = [];
      const hasValue = (value) => typeof value === 'string' && value.trim().length > 0;
      if (!hasValue(outputFormat)) invalidFields.push('outputFormat');
      if (!hasValue(containerFormat)) invalidFields.push('containerFormat');
      if (!hasValue(resolution)) invalidFields.push('resolution');
      if (!hasValue(frameRate)) invalidFields.push('frameRate');
      if (invalidFields.length > 0) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorInvalidConfigMissingFields', { fields: invalidFields.join(', ') }));
        sendJobLog(msg, true);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Invalid transcode configuration', {
          reason: 'missing_video_settings',
          invalidFields,
          outputFormat,
          containerFormat,
          resolution,
          frameRate
        });
        persistJobLogs();
        resolve({
          success: false,
          cancelled: false,
          log: logs,
          logText: logs.join('\n'),
          jobId: config.jobId
        });
        return;
      }
    }

    let batchPreflight = null;
    try {
      batchPreflight = await preflightTranscodeDisk({
        inputFiles,
        outputFormat,
        containerFormat,
        outputFolder: outputFolderPath,
        resolution,
        frameRate,
        pixelFormat,
        audioCodec,
        channels,
        sampleRate,
        audioBitrate,
        audioOnly,
        logger: jobLogger
      });
    } catch (err) {
      const msg = formatTranscodeMessage(transcodeMessage('transcodeWarningDiskPreflightFailed', { error: err?.message || String(err) }));
      sendJobLog(msg);
      jobLogger?.warn?.('Disk preflight failed', { error: err?.message || String(err) });
      batchPreflight = { status: 'unknown', reason: 'preflight_error' };
    }
    if (batchPreflight?.warning) {
      const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningFfprobeRecoverableSkip', { detail: batchPreflight.warning }));
      sendJobLog(warn);
    }
    if (batchPreflight?.status === 'insufficient') {
      const required = batchPreflight.requiredBytes;
      const free = batchPreflight.freeBytes;
      const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorDiskInsufficientStart', { required: formatBytes(required), free: formatBytes(free) }));
      sendJobLog(msg, true);
      jobLogger?.setStage?.('error');
      jobLogger?.error?.('Insufficient disk space for transcode batch', {
        reason: 'insufficient_disk_space',
        requiredBytes: required?.toString?.(),
        freeBytes: free?.toString?.(),
        estimateBytes: batchPreflight.estimateBytes?.toString?.(),
        estimateMethod: batchPreflight.estimateMethod
      });
      persistJobLogs();
      resolve({
        success: false,
        cancelled: false,
        log: logs,
        logText: logs.join('\n'),
        archivePath,
        structuredLogPath: structuredPath,
        jobId: config.jobId
      });
      return;
    }

    // Phase 1 guardrail: prevent sequence/container mismatches from producing
    // silently wrong outputs. The pipeline only switches to image-sequence
    // behavior when containerFormat is image_sequence/image2.
    if (!audioOnly && !embedCaptions) {
      const isSeqFormat = typeof outputFormat === 'string' && outputFormat.includes('sequence');
      const isSeqContainer = (containerFormat === 'image_sequence' || containerFormat === 'image2');
      if (isSeqFormat && !isSeqContainer) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorSeqFormatNeedsSeqContainer'));
        sendJobLog(msg, true);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Invalid transcode configuration', {
          reason: 'sequence_container_mismatch',
          outputFormat,
          containerFormat
        });
        persistJobLogs();
        resolve({
          success: false,
          cancelled: false,
          log: logs,
          logText: logs.join('\n'),
          jobId: config.jobId
        });
        return;
      }
      if (isSeqContainer && !isSeqFormat) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorSeqContainerNeedsSeqFormat'));
        sendJobLog(msg, true);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Invalid transcode configuration', {
          reason: 'container_sequence_format_mismatch',
          outputFormat,
          containerFormat
        });
        persistJobLogs();
        resolve({
          success: false,
          cancelled: false,
          log: logs,
          logText: logs.join('\n'),
          jobId: config.jobId
        });
        return;
      }
    }

    const durationMap = new Map();
    const metaMap = new Map();
    const timecodeMap = new Map();
    const skippedEntries = [];
    const fileEntries = inputFiles.map((file, idx) => ({ file, index: idx + 1 }));
    let totalDuration = 0;
    for (const entry of fileEntries) {
      const { file, index } = entry;
      try {
        const metaResult = await getFFprobeData(file, { preferAudio: audioOnly, logger: jobLogger });
        const meta = metaResult?.data;
        if (!meta) {
          throw new Error(metaResult?.error?.message || formatTranscodeMessage('transcodeErrorFfprobeNoMetadata'));
        }
        metaMap.set(file, meta);
        const durSec = meta?.duration ? parseFloat(meta.duration) : 0;
        const durMs = Math.floor(durSec * 1000);
        durationMap.set(file, durMs);
        totalDuration += durMs;
        if (dropFrame && !audioOnly) {
          try {
            const fullMetaResult = await getFFprobeFullJson(file);
            const timecode = extractTimecodeTag(fullMetaResult?.data);
            if (timecode) {
              timecodeMap.set(file, timecode);
            }
          } catch {
            // ignore timecode lookup failures
          }
        }
      } catch (err) {
        const reason = err?.message || String(err) || 'unknown error';
        const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorFfprobeFailedSkipping', { file: path.basename(file), reason }));
        sendJobLog(msg, true);
        skippedEntries.push({ file, index, reason });
      }
    }

    if (embedCaptions) {
      try {
        const inputPath = inputFiles[0];
        const inMeta = metaMap.get(inputPath) || null;
        const approxFps = (inMeta && inMeta.frames && inMeta.duration) ? (inMeta.frames / inMeta.duration) : null;
        const fpsHint = Number.isFinite(approxFps) && approxFps > 0 ? approxFps : 29.97;
        const dfHint = isDropFrameRate(fpsHint);

        const captionsBase = ensureUserDataSubdir('temp', 'captions');
        captionTempDir = fs.mkdtempSync(path.join(captionsBase, 'lead-aeassist-captions-'));
        const outMcc = path.join(captionTempDir, `caption_sidecar_${Date.now()}.mcc`);

        const ext = path.extname(captionSidecarResolved).toLowerCase();
        if (ext === '.scc') {
          const conv = _convertSccToMcc({ sccPath: captionSidecarResolved, outputPath: outMcc, fpsHint });
          preparedCaptionMccPath = outMcc;
          const msg = formatTranscodeMessage(transcodeMessage('transcodeLogCaptionSccConverted', { mode: conv.dropFrame ? 'DF' : 'NDF', fps: conv.fps }));
          sendJobLog(msg);
        } else {
          const info = _normalizeMccTimecodesToZero({ inputPath: captionSidecarResolved, outputPath: outMcc, fpsFallback: fpsHint, dropFrameFallback: dfHint });
          preparedCaptionMccPath = outMcc;
          const msg = formatTranscodeMessage(transcodeMessage('transcodeLogCaptionMccNormalized', { baseFrame: info.baseFrame }));
          sendJobLog(msg);
        }
      } catch (err) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorCaptionSidecarPrepareFailed', { error: err?.message || String(err) }));
        sendJobLog(msg, true);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Caption sidecar preparation failed', { captionSidecarPath, error: err?.message || String(err) });
        persistJobLogs();
        resolve({ success: false, cancelled: false, log: logs, logText: logs.join('\n'), archivePath, structuredLogPath: structuredPath, jobId: config.jobId });
        return;
      }
    }

    progressManager = new ProgressManager(totalDuration, 250, 'time');
    progressManager.setTotalFiles(inputFiles.length);

    // 🔗 Canonical progress wiring (overall/file/eta) → single contract
    unbindProgress = bindProgressManager(
      progressManager, { id: config.jobId, panel: 'transcode', stage: 'transcode' }
    );

    // ✅ Add this:
    const audioChannelMap = {
      mono: '1',
      stereo: '2',
      '5.1': '6',
      '7.1': '8'
    };
    const channelCount = audioChannelMap[channels];
    const hasInvalidChannels = channels && channels !== 'preserve' && !channelCount;
    if (hasInvalidChannels) {
      const msg = formatTranscodeMessage(transcodeMessage('transcodeWarningUnknownChannelSelection', { channels }));
      sendJobLog(msg, true);
    }

    const n8nValidation = enableN8N
      ? validateN8nUrl(n8nUrl, {
          allowPrivate: n8nAllowPrivate,
          allowlist: parseN8nAllowlist(n8nAllowlistConfig || n8nAllowedHosts),
          allowInsecureHttp: envFlagEnabled(process.env.LEADAE_ALLOW_INSECURE_N8N_HTTP)
        })
      : { valid: false };

    jobLogger.setStage('transcode');

    if (enableN8N) {
      if (n8nValidation.valid) {
        sendJobLog(formatTranscodeMessage('transcode.webhook.enabled', { urlSuffix: n8nValidation.url ? ` → ${n8nValidation.url}` : '' }));
      } else {
        const msg = n8nValidation.message || formatTranscodeMessage('transcode.n8nUrl.invalid');
        sendJobLog(msg, true);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Invalid transcode configuration', {
          reason: 'invalid_n8n_webhook',
          n8nUrl
        });
        persistJobLogs();
        resolve({
          success: false,
          cancelled: false,
          log: logs,
          logText: logs.join('\n'),
          archivePath,
          structuredLogPath: structuredPath,
          jobId: config.jobId
        });
        return;
      }
    }

    const isWatch = watchMode || !!config.watchFolder;
    if (isWatch) {
      const msg = formatTranscodeMessage('transcode.log.watchTriggered', { count: inputFiles.length });
      sendJobLog(msg);
    } else {
      const msg = formatTranscodeMessage('transcode.log.transcodingCount', { count: inputFiles.length });
      sendJobLog(msg);
    }
    const threadCount = 1;

    const isBatch = inputFiles.length > 1;

    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let total = inputFiles.length;

    const ffmpegLogLevel = (() => {
      const explicit = process.env.LEADAE_FFMPEG_LOGLEVEL || process.env.FFMPEG_LOGLEVEL;
      const debug = String(process.env.DEBUG_FFMPEG || '').toLowerCase();
      if (debug === '1' || debug === 'true' || debug === 'yes') return 'verbose';
      if (explicit) return String(explicit);
      // v1 default: keep FFmpeg quiet unless something is actually wrong.
      return 'error';
    })();

    // Cache the local FFmpeg encoder list once per job so we can:
    // - Avoid invalid encoder selections on "legal" FFmpeg builds (no libx264/libx265)
    const availableEncoders = getAvailableEncoderSet(ffmpegPath);

    function buildCommand(inputPath, outputPath, progressFile) {
      const progressPath = process.platform === 'win32'
        ? 'file:' + progressFile.replace(/\\/g, '/')
        : progressFile;
      const args = ['-nostats', '-loglevel', ffmpegLogLevel, '-progress', progressPath, '-y', '-i', inputPath];

      // Caption sidecar embed mode: produce MXF with SMPTE-436M ANC data stream.
      if (embedCaptions) {
        if (!preparedCaptionMccPath || !fs.existsSync(preparedCaptionMccPath)) {
          throw new Error(formatTranscodeMessage('transcodeErrorCaptionSidecarNotPrepared'));
        }

        args.push('-i', preparedCaptionMccPath);
        args.push('-map_metadata', '0');

        args.push('-map', '0:v');
        args.push('-map', '0:a?');
        args.push('-map', '1');

        args.push('-c', 'copy');
        args.push('-bsf:s', 'eia608_to_smpte436m');
        args.push('-f', 'mxf');

        args.push(outputPath);
        return args;
      }

      function escapeForFfmpegFilter(p) {
        let s = String(p).replace(/\\/g, '/').replace(/'/g, "\\'");
        if (process.platform === 'win32') s = s.replace(/^([A-Za-z]):/, '$1\\:');
        return s;
      }

      const delayMs = audioDelay != null ? parseFloat(audioDelay) : NaN;
      if (audioDelay != null && audioDelay !== '' && Number.isNaN(delayMs)) {
        const warnMsg = formatTranscodeMessage(transcodeMessage('transcodeWarningAudioDelayNotNumberIgnored'));
        sendJobLog(warnMsg);
        jobLogger?.warn?.('Invalid audio delay value', {
          audioDelay
        });
      }

      // Image sequences are written using the image2 muxer pattern and cannot carry audio.
      // In this codebase, we treat containerFormat=image_sequence as the explicit signal.
      const outputFormatValue = String(outputFormat || '');
      const containerFormatValue = String(effectiveContainerFormat || containerFormat || '');
      const resolutionValue = String(resolution || '');
      const frameRateValue = String(frameRate || '');
      const isImageSeq = containerFormatValue === 'image_sequence' || containerFormatValue === 'image2';
      const isSequenceOutput = isImageSeq || outputFormatValue.toLowerCase().endsWith('_sequence');
      const normalizedPixelFormat = String(pixelFormat || '').toLowerCase();
      const normalizedOutputFormat = outputFormatValue.toLowerCase();

      const pixelFormatRequiresEvenDimensions = (fmt) => {
        const value = String(fmt || '').toLowerCase();
        if (!value || value === 'default') return null;
        if (
          value.includes('yuv444') ||
          value.includes('yuva444') ||
          value.startsWith('rgb') ||
          value.startsWith('bgr') ||
          value.startsWith('gbr') ||
          value.startsWith('rgba') ||
          value.startsWith('bgra')
        ) {
          return false;
        }
        if (
          value.includes('yuv420') ||
          value.includes('yuv422') ||
          value.includes('yuvj420') ||
          value.includes('yuvj422') ||
          value.includes('nv12') ||
          value.includes('p010') ||
          value.includes('p210')
        ) {
          return true;
        }
        return null;
      };

      const outputFormatRequiresEvenDimensions = (fmt) => {
        if (!fmt) return false;
        if (fmt.startsWith('prores_')) {
          return !['prores_4444', 'prores_4444xq'].includes(fmt);
        }
        if (fmt === 'uncompressed_rgb') return false;
        if (fmt === 'uncompressed_yuv') return true;
        if (fmt.startsWith('xdcam') || fmt.startsWith('xavc')) return true;
        return ['h264', 'h264_auto_gpu', 'h265', 'vp9', 'av1'].includes(fmt);
      };

      const requiresEvenDimensions = !isSequenceOutput && (() => {
        const pixelRequirement = pixelFormatRequiresEvenDimensions(normalizedPixelFormat);
        if (pixelRequirement != null) return pixelRequirement;
        return outputFormatRequiresEvenDimensions(normalizedOutputFormat);
      })();

      // Pro workflow hardening: preserve metadata/streams when requested.
      // - Default behavior (non-MP4 containers): map all streams (incl. multi-track audio, timecode/data, subtitles)
      //   and copy non-A/V streams where possible. If the chosen container can't support a stream, FFmpeg will fail
      //   (preferred for pro safety).
      // - MP4/M4V compatibility mode: MP4 can't reliably mux some non-A/V tracks (notably timecode/data tracks),
      //   so when Preserve Metadata is enabled and the output container is MP4/M4V, we:
      //     - copy global/container metadata (-map_metadata 0)
      //     - preserve all video + audio streams (-map 0:v -map 0:a?)
      //     - drop data/attachment streams (-dn) and do NOT map all streams.
      //   Full source metadata/streams can be preserved via a sidecar JSON (written after encode).
      const preserveMeta = preserveMetadata !== false;
      const chapterContainer = containerFormatValue.toLowerCase();
      const chapterSafe = ['mov', 'mp4', 'm4v', 'mkv', 'webm'].includes(chapterContainer);
      const mp4Container = ['mp4', 'm4v'].includes(chapterContainer);
      const mxfContainer = (chapterContainer === 'mxf');
      const mkvContainer = ['mkv', 'matroska'].includes(chapterContainer);
      const webmContainer = chapterContainer === 'webm';
      const mp4PreserveCompat = preserveMeta && !isImageSeq && !audioOnly && mp4Container;
      const mxfPreserveCompat = preserveMeta && !isImageSeq && !audioOnly && mxfContainer;
      const mkvPreserveCompat = preserveMeta && !isImageSeq && !audioOnly && mkvContainer;
      const webmPreserveCompat = preserveMeta && !isImageSeq && !audioOnly && webmContainer;

      if (preserveMeta && !isImageSeq) {
        // Copy global/container metadata (reel name, timecode tags, etc.)
        args.push('-map_metadata', '0');

        // Chapters are meaningful for MOV/MP4/MKV; skip for other containers to avoid muxer errors.
        if (chapterSafe) {
          args.push('-map_chapters', '0');
        }

        // For video transcodes, explicitly map streams so FFmpeg doesn't silently drop tracks.
        if (!audioOnly) {
          if (mp4PreserveCompat) {
            // MP4/M4V: preserve A/V only (avoid copying timecode/data/attachments into MP4).
            args.push('-map', '0:v');
            args.push('-map', '0:a?');
            args.push('-dn'); // disable data streams in output (belt-and-suspenders)
          } else if (mxfPreserveCompat) {
            // MXF: be conservative. MXF muxer often rejects generic data streams (e.g., QuickTime tmcd) and unknown attachments.
            // Preserve A/V only and drop data streams to prevent muxer header failures.
            args.push('-map', '0:v');
            args.push('-map', '0:a?');
            args.push('-dn');
          } else if (mkvPreserveCompat) {
            // MKV (matroska): FFmpeg's matroska muxer does not support generic data streams (e.g., QuickTime tmcd).
            // Preserve A/V + subtitles and drop data streams to prevent muxer header failures.
            args.push('-map', '0:v');
            args.push('-map', '0:a?');
            args.push('-map', '0:s?');
            args.push('-dn');
            args.push('-c:s', 'copy');
          } else if (webmPreserveCompat) {
            // WebM: keep it conservative (A/V only). Subtitles and data streams are frequently incompatible.
            args.push('-map', '0:v');
            args.push('-map', '0:a?');
            args.push('-dn');
          } else {
            // Non-MP4 containers: preserve everything (preferred for pro safety).
            args.push('-map', '0');

            // Preserve non-A/V streams where possible (subtitles, data/timecode, attachments).
            // If the chosen container can't support a stream, FFmpeg will fail (preferred for pro safety).
            args.push('-copy_unknown');
            args.push('-c:s', 'copy');
            args.push('-c:d', 'copy');
            args.push('-c:t', 'copy');
          }
        }
      }

      if (audioOnly && !isImageSeq) {
        // Audio-only wrapper exports should emit a single audio stream.
        // Mapping all source audio streams breaks wrappers like WAV when
        // the source contains multiple audio tracks.
        args.push('-map', '0:a:0');
      }

      if (!audioOnly) {
        // Video options
        if (resolutionValue && resolutionValue !== 'match') args.push('-s', resolutionValue);
        if (colorRange) { const cr = String(colorRange).trim().toLowerCase(); const r = cr === 'full' ? 'pc' : cr === 'limited' ? 'tv' : colorRange; args.push('-color_range', r); }
        if (frameRateValue && frameRateValue !== 'match') args.push('-r', String(frameRateValue).replace(/df$/i, ''));
        // Strict pixel-format selection: fail if not possible instead of silently auto-picking.
        const strictPix = strictPixFmtArg(pixelFormat);
        if (strictPix) args.push('-pix_fmt', strictPix);
        if (fieldOrder && fieldOrder !== 'progressive') {
          args.push('-flags', '+ilme');
          const topFieldMap = {
            interlaced_tff: '1',
            interlaced_bff: '0',
            tff: '1',
            bff: '0'
          };
          args.push('-top', topFieldMap[fieldOrder] || '1');
        }
      } else {
        args.push('-vn');
      }

      // Audio options
      // - For image sequences, explicitly disable audio to avoid invalid/unused audio options.
      // - For audio-only mode, the UI currently provides container-ish values (mp3/wav/etc).
      //   Map those to real FFmpeg encoders so the feature works out of the box.
      if (isImageSeq) {
        args.push('-an');
      } else {
        let audioEncoder = audioCodec?.trim() || 'aac'; // Default to AAC if blank

        if (audioOnly) {
          const wrapper = String(containerFormatValue || audioCodec || '').trim().toLowerCase();
          // Use the shared audio-only wrapper spec so renderer validation and backend
          // encoder selection do not drift apart.
          const pickFirstAvailable = (cands) => {
            const list = Array.isArray(cands) ? cands : [];
            for (const c of list) {
              if (availableEncoders.has(String(c || '').toLowerCase())) return c;
            }
            return list.length ? list[list.length - 1] : null;
          };
          const wrapperSpec = getAudioOnlyWrapperSpec(wrapper);
          const candidates = Array.isArray(wrapperSpec?.codecCandidates) && wrapperSpec.codecCandidates.length
            ? wrapperSpec.codecCandidates
            : [String(wrapperSpec?.defaultCodec || '').trim().toLowerCase()].filter(Boolean);
          const chosen = pickFirstAvailable(candidates);
          if (chosen) {
            audioEncoder = chosen;
          } else if (wrapperSpec?.defaultCodec) {
            audioEncoder = wrapperSpec.defaultCodec;
          }
        }

        const audioEncoderLower = audioEncoder.toLowerCase();
        if (audioEncoderLower !== 'copy') args.push('-c:a', audioEncoder);

        if (channels && channels !== 'preserve' && channelCount) {
          args.push('-ac', channelCount);
        }
        if (sampleRate && sampleRate !== 'default') args.push('-ar', sampleRate);
        if (audioBitrate && audioEncoderLower !== 'copy' && !audioEncoderLower.startsWith('pcm_') && audioEncoderLower !== 'flac') {
          args.push('-b:a', `${audioBitrate}k`);
        }
        const audioFilters = [];
        if (normalizeAudio && audioEncoderLower !== 'copy') {
          audioFilters.push('loudnorm');
        }

      if (!Number.isNaN(delayMs) && Number.isFinite(delayMs) && delayMs !== 0) {
        if (delayMs < 0) {
          sendJobLog(formatTranscodeMessage('transcode.warning.negativeAudioDelay'));
        } else {
          const safeDelay = Math.round(delayMs);
          if (safeDelay > 0) {
            if (audioEncoderLower === 'copy') {
              sendJobLog(formatTranscodeMessage('transcode.warning.audioDelayIgnoredCodecCopy'));
            } else {
              audioFilters.push(`adelay=${safeDelay}|${safeDelay}:all=1`);
            }
          }
        }
      }

        if (audioFilters.length > 0) {
          args.push('-af', audioFilters.join(','));
        }
      }

      if (dropFrame && !audioOnly && !isImageSeq) {
        const sourceTimecode = timecodeMap.get(inputPath);
        const dropTimecode = normalizeDropFrameTimecodeLabel(sourceTimecode) || '00:00:00;00';
        args.push('-timecode', dropTimecode);
      }

      // Format-specific: video encoder selection.
      if (!audioOnly) {
        if (outputFormatValue.startsWith('prores')) {
          const profileMap = {
            prores_proxy: '0',
            prores_lt: '1',
            prores_422: '2',
            prores_422hq: '3',
            prores_4444: '4',
            prores_4444xq: '5'
          };

          // ProRes encoder availability varies by build; prefer prores_ks.
          let enc = 'prores_ks';
          if (!availableEncoders.has(enc)) {
            if (availableEncoders.has('prores_aw')) enc = 'prores_aw';
            else if (availableEncoders.has('prores')) enc = 'prores';
            else {
              throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableProres'));
            }
          }

          args.push('-c:v', enc);
          args.push('-profile:v', profileMap[outputFormatValue] || '3'); // default to HQ
        }

        // DNxHD / DNxHR (FFmpeg encoder name: dnxhd)
        else if (outputFormatValue === 'dnxhd' || outputFormatValue.startsWith('dnxhr_') || outputFormatValue.startsWith('dnxhd_')) {
          const enc = 'dnxhd';
          if (!availableEncoders.has(enc)) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableDnxhd'));
          }

          const replaceOrAppend = (flag, value) => {
            const idx = args.lastIndexOf(flag);
            if (idx !== -1 && idx < args.length - 1) {
              args[idx + 1] = String(value);
            } else {
              args.push(flag, String(value));
            }
          };

          const normalizeDnxFpsKey = (fps) => {
            const n = Number.parseFloat(fps);
            if (!Number.isFinite(n)) return '';
            if (Math.abs(n - 24) < 0.02) return '23.976';
            if (Math.abs(n - 30) < 0.02) return '29.97';
            if (Math.abs(n - 60) < 0.02) return '59.94';
            if (Math.abs(n - 23.976) < 0.02) return '23.976';
            if (Math.abs(n - 29.97) < 0.02) return '29.97';
            if (Math.abs(n - 59.94) < 0.02) return '59.94';
            if (Math.abs(n - 25) < 0.02) return '25';
            if (Math.abs(n - 50) < 0.02) return '50';
            return String(fps);
          };

          const resolveOutWxH = () => {
            if (resolutionValue && resolutionValue !== 'match') {
              const parsed = parseWxH(resolutionValue);
              if (parsed?.w && parsed?.h) return { w: parsed.w, h: parsed.h };
            }
            const meta = metaMap.get(inputPath) || null;
            if (meta?.width && meta?.height) return { w: meta.width, h: meta.height };
            return null;
          };

          const resolveOutFps = () => {
            if (frameRateValue && frameRateValue !== 'match') {
              const n = Number.parseFloat(frameRateValue);
              if (Number.isFinite(n) && n > 0) return n;
            }
            const meta = metaMap.get(inputPath) || null;
            if (meta?.frames && meta?.duration) {
              const n = meta.frames / meta.duration;
              if (Number.isFinite(n) && n > 0) return n;
            }
            return null;
          };

          const pickProfileAndBitrate = () => {
            const selected = String((outputFormatValue && (String(outputFormatValue).startsWith('dnxhr_') || String(outputFormatValue).startsWith('dnxhd_')))
              ? outputFormatValue
              : (dnxProfile || '')).trim().toLowerCase();
            const out = resolveOutWxH();
            const fps = resolveOutFps();

            // DNxHR selection
            if (selected.startsWith('dnxhr_')) {
              const profile = selected;
              const levelMap = {
                dnxhr_lb: 'LB',
                dnxhr_sq: 'SQ',
                dnxhr_hq: 'HQ',
                dnxhr_hqx: 'HQX',
                dnxhr_444: '444'
              };
              const level = levelMap[profile] || 'HQX';
              const pix = profile === 'dnxhr_444'
                ? 'yuv444p10le'
                : (profile === 'dnxhr_hqx' ? 'yuv422p10le' : 'yuv422p');

              // Resolve bitrate from Avid's table when possible. If we can't, fall back to a conservative default.
              let bitrateMbps = null;
              if (out && fps) {
                const fpsKey = normalizeDnxFpsKey(fps);
                const resKey = `${out.w}x${out.h}`;
                const table = DNXHR_TABLE_MBPS[resKey] || null;
                const mbps = table?.[level]?.[fpsKey];
                if (Number.isFinite(mbps)) {
                  bitrateMbps = Math.round(mbps * 8);
                }
              }

              // If we couldn't derive a bitrate, choose a "safe" default so we don't hit the 200k default.
              if (!bitrateMbps) {
                // Defaults roughly aligned with UHD24 expectations (in Mbps).
                bitrateMbps = (profile === 'dnxhr_lb') ? 140
                  : (profile === 'dnxhr_sq') ? 440
                  : (profile === 'dnxhr_hq') ? 660
                  : (profile === 'dnxhr_hqx') ? 700
                  : 1300; // 444
              }

              return { profile, pix, bitrateMbps };
            }

            // DNxHD selection (legacy bitrate variants)
            // Accepted `dnxProfile` values look like: dnxhd_220, dnxhd_220x, dnxhd_175, ...
            const m = selected.match(/^dnxhd_(\d+)(x)?$/i);
            if (m) {
              const bitrate = Number.parseInt(m[1], 10);
              const is10 = !!m[2];
              const pix = is10 ? 'yuv422p10le' : 'yuv422p';
              return { profile: 'dnxhd', pix, bitrateMbps: bitrate };
            }

            // Fallback: default to DNxHR HQX for UHD/4K, else DNxHD 175x-ish for HD.
            const outW = out?.w || 0;
            const outH = out?.h || 0;
            if (outW >= 3840 || outH >= 2160) {
              return { profile: 'dnxhr_hqx', pix: 'yuv422p10le', bitrateMbps: 700 };
            }
            return { profile: 'dnxhd', pix: 'yuv422p10le', bitrateMbps: 175 };
          };

          const dnx = pickProfileAndBitrate();

          args.push('-c:v', enc);
          if (dnx?.profile) args.push('-profile:v', dnx.profile);
          if (dnx?.bitrateMbps) replaceOrAppend('-b:v', `${dnx.bitrateMbps}M`);
          // DNx: honor UI pixel format (when set); otherwise use the preset's default.
          // Do NOT alias away the *le formats; your build supports yuv422p10le/yuv444p10le/gbrp10le explicitly.
          const userPix = (pixelFormat && pixelFormat !== 'default' && pixelFormat !== 'match')
            ? String(pixelFormat).trim()
            : '';
          const pixToUse = userPix || (dnx?.pix ? String(dnx.pix).trim() : '');
          // Keep strict pix_fmt behavior for DNx too (don't overwrite +pix_fmt with a non-+ value).
          const strictDnxPix = strictPixFmtArg(pixToUse);
          if (strictDnxPix) {
            replaceOrAppend('-pix_fmt', strictDnxPix);
          }
        }

        else if (outputFormatValue === 'h264_auto_gpu') {
          let enc = global.gpuEncoders?.h264 || detectBestGPUEncoder('h264', ffmpegPath);
          if (!enc) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableH264'));
          }
          args.push('-c:v', enc);
        }

        else if (outputFormatValue === 'h264') {
          // Prefer software when available; fall back to best available encoder.
          const enc = availableEncoders.has('libx264')
            ? 'libx264'
            : (global.gpuEncoders?.h264 || detectBestGPUEncoder('h264', ffmpegPath));
          if (!enc) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableH264'));
          }
          args.push('-c:v', enc);
        }

        else if (outputFormatValue === 'h265') {
          // Prefer software when available; fall back to best available encoder.
          const enc = availableEncoders.has('libx265')
            ? 'libx265'
            : (global.gpuEncoders?.hevc || detectBestGPUEncoder('hevc', ffmpegPath));
          if (!enc) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableHevc'));
          }
          args.push('-c:v', enc);
        }

        else if (outputFormatValue === 'vp9') {
          const enc = 'libvpx-vp9';
          if (!availableEncoders.has(enc)) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableVp9'));
          }
          args.push('-c:v', enc);
        }

        else if (outputFormatValue === 'av1') {
          // Prefer libaom if available; fall back to SVT-AV1 when present.
          let enc = 'libaom-av1';
          if (!availableEncoders.has(enc) && availableEncoders.has('libsvtav1')) {
            enc = 'libsvtav1';
          }
          if (!availableEncoders.has(enc)) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableAv1'));
          }
          args.push('-c:v', enc);
        }

        else if (outputFormatValue.startsWith('xdcam')) {
          args.push('-c:v', 'mpeg2video');
          const replaceOrAppend = (flag, value) => {
            const idx = args.lastIndexOf(flag);
            if (idx !== -1 && idx < args.length - 1) {
              args[idx + 1] = String(value);
            } else {
              args.push(flag, String(value));
            }
          };
          // XDCAM presets are fixed-bitrate deliverables.
          const target = (outputFormatValue === 'xdcam_hd50') ? '50M' : '35M';
          replaceOrAppend('-b:v', target);
          // Pin rate control so we don't accidentally under-shoot.
          replaceOrAppend('-minrate', target);
          replaceOrAppend('-maxrate', target);
          // Let FFmpeg infer MPEG-2 profile/level from pix_fmt + raster.
          // (Hard-coding profile/level has caused encoder-open failures on some builds.)
          // Common XDCAM encoder settings
          replaceOrAppend('-bf', '2');
          replaceOrAppend('-dc', '10');
          replaceOrAppend('-intra_vlc', '1');

          // XDCAM-in-MXF needs broadcast-legal MPEG-2 settings or the MXF muxer will reject the header.
          // GOP: 12 for 25fps, 15 for 29.97/30
          const fpsNum = parseFloat(frameRateValue || '0') || 0;
          const gop = (Math.abs(fpsNum - 25) < 0.01) ? 12 : ((Math.abs(fpsNum - 29.97) < 0.02 || Math.abs(fpsNum - 30) < 0.02) ? 15 : null);
          if (gop) replaceOrAppend('-g', String(gop));

          // VBV buffer helps MXF accept constant-bit-rate streams.
          const bufsize = (target === '50M') ? '17825792' : '12478054';
          replaceOrAppend('-bufsize', bufsize);

          // Ensure interlaced MPEG-2 uses ILDCT when field order is set.
          if (fieldOrder && fieldOrder !== 'progressive') {
            // Merge with existing -flags (+ilme already added earlier)
            replaceOrAppend('-flags', '+ilme+ildct');
          }

          // XDCAM HD35 is 4:2:0; HD50 is 4:2:2. Force pix_fmt to match deliverable.
          if (outputFormatValue === 'xdcam_hd35') {
            replaceOrAppend('-pix_fmt', '+yuv420p');
          } else {
            replaceOrAppend('-pix_fmt', '+yuv422p');
          }
        }

        else if (outputFormatValue.startsWith('xavc')) {
          // XAVC generally expects x264. If it's not available, fall back to best H.264 encoder.
          const enc = availableEncoders.has('libx264')
            ? 'libx264'
            : (global.gpuEncoders?.h264 || detectBestGPUEncoder('h264', ffmpegPath));
          if (!enc) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableXavcH264'));
          }
          args.push('-c:v', enc);

          const replaceOrAppend = (flag, value) => {
            const idx = args.lastIndexOf(flag);
            if (idx !== -1 && idx < args.length - 1) {
              args[idx + 1] = String(value);
            } else {
              args.push(flag, String(value));
            }
          };

          // Give XAVC presets deterministic targets (avoid “whatever defaults”).
          const target =
            (outputFormatValue === 'xavc_i_4k') ? '300M' :
            (outputFormatValue === 'xavc_l_1080p') ? '50M' :
            (outputFormatValue === 'xavc_s') ? '60M' :
            null;
          if (target) replaceOrAppend('-b:v', target);
        }
        else if (outputFormatValue === 'jpeg2000') {
          // Prefer the native jpeg2000 encoder; fall back to libopenjpeg if present.
          let enc = 'jpeg2000';
          if (!availableEncoders.has(enc) && availableEncoders.has('libopenjpeg')) {
            enc = 'libopenjpeg';
          }
          if (!availableEncoders.has(enc)) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableJpeg2000'));
          }
          args.push('-c:v', enc);
        }

        else if (outputFormatValue === 'ffv1') {
          if (!availableEncoders.has('ffv1')) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableFfv1'));
          }
          args.push('-c:v', 'ffv1');
        }

        else if (outputFormatValue === 'mjpeg') {
          if (!availableEncoders.has('mjpeg')) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableMjpeg'));
          }
          args.push('-c:v', 'mjpeg');
        }

        else if (outputFormatValue === 'qtrle') {
          if (!availableEncoders.has('qtrle')) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableQtrle'));
          }
          args.push('-c:v', 'qtrle');
        }

        else if (outputFormatValue === 'uncompressed_yuv' || outputFormatValue === 'uncompressed_rgb') {
          if (!availableEncoders.has('rawvideo')) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableRawvideo'));
          }
          args.push('-c:v', 'rawvideo');
        }

        else if (outputFormatValue.endsWith('_sequence')) {
          const codecMap = {
            png_sequence: 'png',
            tiff_sequence: 'tiff',
            exr_sequence: 'exr',
            dpx_sequence: 'dpx',
            tga_sequence: 'targa',
            // Generic sequence format defaults to PNG.
            image_sequence: 'png'
          };
          const seqEnc = codecMap[outputFormatValue] || 'png';
          if (!availableEncoders.has(seqEnc)) {
            throw new Error(formatTranscodeMessage('transcodeErrorEncoderUnavailableImageSequence', { encoder: seqEnc }));
          }
          args.push('-c:v', seqEnc);
        }

        // P1: Generic video encoder fallback.
        // If the selected outputFormat is itself a real FFmpeg encoder name and it's available,
        // honor it so formats like dnxhd/cfhd/speedhq/v210/utvideo/huffyuv/ffvhuff actually encode correctly.
        if (!args.includes('-c:v')) {
          const rawCandidate = String(outputFormatValue || '').trim();
          const lowerCandidate = rawCandidate.toLowerCase();
          const enc = availableEncoders.has(rawCandidate)
            ? rawCandidate
            : (availableEncoders.has(lowerCandidate) ? lowerCandidate : null);

          if (enc) {
            args.push('-c:v', enc);
          }
        }
      }

      // Container-specific (for image sequences or overrides)
      if (isImageSeq) {
        const extMap = {
          png_sequence: '.png',
          tiff_sequence: '.tiff',
          exr_sequence: '.exr',
          dpx_sequence: '.dpx',
          tga_sequence: '.tga'
        };
        const ext = extMap[outputFormatValue] || '.png';
        const extname = path.extname(outputPath);
        outputPath = extname
          ? outputPath.replace(extname, `_%03d${ext}`)
          : `${outputPath}_%03d${ext}`;
      }

      if (!audioOnly) {
        const vf = [];

        const vfIdx = args.indexOf('-vf');
        const hadVf = vfIdx !== -1 && Boolean(args[vfIdx + 1]);
        if (hadVf) {
          vf.push(args[vfIdx + 1]);
          args.splice(vfIdx, 2);
        }

        if (lutPath) {
          if (fs.existsSync(lutPath)) {
            vf.push(`lut3d=file='${escapeForFfmpegFilter(lutPath)}'`);
          } else {
            sendJobLog(formatTranscodeMessage('transcode.warning.lutNotFound', { lutPath }));
          }
        }

        if (requiresEvenDimensions) {
          let dimHint = null;
          if (resolutionValue && resolutionValue !== 'match') {
            dimHint = parseWxH(resolutionValue);
          } else {
            const meta = metaMap.get(inputPath);
            if (meta?.width && meta?.height) {
              dimHint = { w: meta.width, h: meta.height };
            }
          }

          if (dimHint && (dimHint.w % 2 !== 0 || dimHint.h % 2 !== 0)) {
            const msg = formatTranscodeMessage(transcodeMessage('transcodeWarningOddDimensionsScaledEven', { width: dimHint.w, height: dimHint.h }));
            sendJobLog(msg);
          }

          vf.push('scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2');
        }

        if (vf.length > 0 || hadVf) {
          // With strict +pix_fmt, make conversion explicit at the end of the graph.
          const requestedPixFmt = pixFmtValueFromArgs(args);
          if (requestedPixFmt) {
            const alreadyHasFormat = vf.some(f => /^format=/.test(String(f).trim()));
            if (!alreadyHasFormat) vf.push(`format=${requestedPixFmt}`);
          }
          args.push('-vf', vf.join(','));
        }
      }

      const hasThreads = args.includes('-threads');
      if (!hasThreads) {
        args.push('-threads', '0'); // auto
      }

      args.push(outputPath);

      return args;
    }

    function runOne(inputPath, index, streamId = index) {
      return new Promise((resolveOne) => {
        (async () => {
        let statusMap;
        let finalOutPath;
        let outName;
        let isImageSeq;
        let imageSeqExt;
        try {
          const progressDir = ensureUserDataSubdir('temp', 'ffmpeg-progress');
          const progressFile = path.join(progressDir, `ffmpeg-progress-${Date.now()}-${streamId}.txt`);
          const outputPlan = outputPathPlan.get(index)
            || await resolveOutputPathForInput({
              inputPath,
              index,
              outputFolder: outputFolderPath,
              containerFormat: effectiveContainerFormat,
              appendSeq,
              isBatch,
              outputFormat
            });
          finalOutPath = outputPlan.finalOutPath;
          outName = outputPlan.outName;
          isImageSeq = outputPlan.isImageSeq;
          imageSeqExt = outputPlan.imageSeqExt;

          const ext = path.extname(finalOutPath);
          const base = ext ? finalOutPath.slice(0, -ext.length) : finalOutPath;
          const tempOutPath = `${base}.__encoding__${ext}`;
          const imageSeqDir = path.dirname(finalOutPath);
          const imageSeqPrefix = path.basename(finalOutPath);
          const imageSeqPrefixWithSep = `${imageSeqPrefix}_`;
	          const listImageSeqFrames = async () => {
            const frames = [];
            let dir;
            try {
              dir = await fs.promises.opendir(imageSeqDir);
              for await (const entry of dir) {
                const name = entry.name;
                if (!name.startsWith(imageSeqPrefixWithSep)) continue;
                if (!name.endsWith(imageSeqExt)) continue;
                const framePart = name.slice(
                  imageSeqPrefixWithSep.length,
                  name.length - imageSeqExt.length
                );
                if (!/^\d+$/.test(framePart)) continue;
                frames.push(path.join(imageSeqDir, name));
              }
              frames.sort();
              return frames;
            } catch {
              return [];
            } finally {
              if (dir) {
                try { await dir.close(); } catch {}
              }
            }
          };

	        try {
	          await removeFileIfExists(tempOutPath);
	        } catch {
	          // best-effort
	        }

        // Remove any stale frames from a previous run so sequences don't get mixed together.
        if (isImageSeq) {
	          try {
	            const stale = await listImageSeqFrames();
	            for (const staleFrame of stale) {
	              try { await removeFileIfExists(staleFrame); } catch {}
	            }
	          } catch {
	            // best-effort
	          }
        }

        statusMap = {
          transcoded: false,
          verified: false,
          outputFile: outName,
          finalOutputPath: finalOutPath,
          tempOutputPath: tempOutPath
        };
        let qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonNotRequested') };
        const encodeOutPath = isImageSeq ? finalOutPath : tempOutPath;
        const args = buildCommand(inputPath, encodeOutPath, progressFile); // write to temp path first (or final prefix for sequences)

        sendJobLog(formatTranscodeMessage('transcode.log.ffmpegArgs', { args: args.join(' ') }));

        sendJobLog(formatTranscodeMessage('transcode.log.startingFile', { file: path.basename(inputPath) }));

	        const fileStat = await fsAsync.stat(inputPath);
	        const fileSize = fileStat.size;
        sendJobLog(formatTranscodeMessage('transcode.log.fileSizeMb', { sizeMb: (fileSize / 1024 / 1024).toFixed(2) }));

        // Rough output size estimate (improved for raw/uncompressed and audio-only)
        const inputMeta = metaMap.get(inputPath) || null;
        const estimate = estimateOutputBytes({
          inputBytes: fileSize,
          inputMeta,
          outputFormat,
          containerFormat,
          resolution,
          frameRate,
          pixelFormat,
          audioCodec,
          channels,
          sampleRate,
          audioBitrate,
          audioOnly
        });

        if (estimate?.bytes != null) {
          const estMsg = formatTranscodeMessage(transcodeMessage('transcodeLogEstimatedOutputSize', { size: formatBytes(estimate.bytes), methodSuffix: estimate.method ? ` (${estimate.method})` : '' }));
          sendJobLog(estMsg);

          // Preflight disk space so we fail fast instead of crashing deep into an encode.
          const freeBytes = await getFreeDiskBytes(outputFolderPath);
          if (freeBytes != null) {
            const freeMsg = formatTranscodeMessage(transcodeMessage('transcodeLogFreeDiskSpace', { free: formatBytes(freeBytes) }));
            sendJobLog(freeMsg);

            // Require 10% headroom (avoid borderline ENOSPC failures).
            const required = (estimate.bytes * 11n) / 10n;
            const reqMsg = formatTranscodeMessage(transcodeMessage('transcodeLogRequiredDiskSpace', { required: formatBytes(required) }));
            sendJobLog(reqMsg);

            if (freeBytes < required) {
              const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorDiskInsufficientSelectedFormat', { required: formatBytes(required), free: formatBytes(freeBytes) }));
              sendJobLog(msg, true);

              statusMap.transcoded = false;
              statusMap.verified = false;
              qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonInsufficientDiskSpace') };
              qualityResult.reason = mapLegacyQualityReason(qualityResult.reason, qualityResult.status);
          statusMap.quality = qualityResult;

              // Mark this file as "done" in the progress system so UI doesn't hang.
              const durMs = durationMap.get(inputPath) || 0;
              try { progressManager.startFile(streamId, inputPath, durMs); } catch {}
              try { if (durMs > 0) progressManager.update(streamId, durMs); } catch {}
              try { progressManager.finishFile(streamId, statusMap); } catch {}
              if (progressManager.completedFiles >= progressManager.totalFiles) {
                try { progressManager.complete(config.jobId); } catch {}
              }

              if (global.queue) {
                global.queue.emit('job-progress', {
                  id: config.jobId,
                  panel: 'transcode',
                  file: path.basename(inputPath),
                  status: { ...statusMap }
                });

                global.queue.emit('job-progress', {
                  id: config.jobId,
                  panel: 'transcode',
                  file: path.basename(finalOutPath),
                  status: formatTranscodeMessage('transcode.progress.failedFile', { file: path.basename(finalOutPath) }),
                  percent: 100,
                  filePercent: 100,
                  completed: completed + 1,
                  total,
                  eta: '0s'
                });
              }

              completed++;
              failed++;
              return resolveOne();
            }
          } else {
            const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningDiskPreflightSkippedFreeUnknown'));
            sendJobLog(warn);
          }
        } else {
          const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningDiskPreflightSkippedEstimateUnavailable'));
          sendJobLog(warn);
        }

        let shouldDelete = false;
        const durationMs = durationMap.get(inputPath) || 0;
        let started = false;
        try {
          progressManager.startFile(streamId, inputPath, durationMs);
          started = true;
        } catch {}

        if (isPackaged) {
          console.log('[DEBUG - packaged]', ffmpegPath, args);
        }
        console.log('[LeadAE Transcode]', ffmpegPath, args);

        const proc = spawn(ffmpegPath, args);
        proc.on('error', err => console.error('[FFmpeg Spawn Error]', err));
        const stderrTailMaxBytes = Number.isFinite(Number(process.env.LEADAE_FFMPEG_MAX_CAPTURE_BYTES))
          ? Math.max(1024, Math.trunc(Number(process.env.LEADAE_FFMPEG_MAX_CAPTURE_BYTES)))
          : (64 * 1024);
        const stderrTail = createTailBuffer(stderrTailMaxBytes);
        const markStderrAsError = ['error', 'fatal', 'panic'].includes(String(ffmpegLogLevel).toLowerCase());
        const stderrRelay = createStderrLineRelay(
          (msg, isErr) => sendJobLog(msg, isErr),
          { markAsError: markStderrAsError }
        );
        proc.stderr.on('data', d => {
          // Always capture the bounded tail for post-mortem, even if the live relay ignores the line.
          stderrTail.append(d);
          stderrRelay.onData(d);
        });

        registerJobProcess(config.jobId, proc);

        // Terminate FFmpeg immediately if the job's signal is aborted
        if (config.signal) {
          const onAbort = () => {
            if (proc && typeof proc.kill === 'function') {
              proc.kill('SIGINT');
            }
          };

          if (config.signal.aborted) {
            onAbort();
          } else {
            config.signal.addEventListener('abort', onAbort, { once: true });
          }

          proc.on('close', () => {
            config.signal.removeEventListener('abort', onAbort);
          });
        }

        const notifyWin = BrowserWindow?.getFocusedWindow?.();
        if (notifyWin && !notifyWin.isDestroyed()) {
          notifyWin.webContents.send('ffmpeg-progress-started', {
            jobId: streamId,
            progressFile
          });
        }

        let watchInterval;
        let throttledEmitTimeout;
        let readInFlight = false;
        let pendingRead = false;
        let watcherStopped = false;
        let latestProgressPayload = null;
        let lastProgressEmitAt = 0;
        const progressPollMs = 250; // 4 reads/sec max
        const progressEmitMinIntervalMs = 350; // throttle renderer updates to ~2.8/sec
        let finished = false;
        let progressStopped = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolveOne();
        };
        const stopProgress = () => {
          watcherStopped = true;
          if (watchInterval) {
            clearInterval(watchInterval);
            watchInterval = null;
          }
          if (throttledEmitTimeout) {
            clearTimeout(throttledEmitTimeout);
            throttledEmitTimeout = null;
          }
          if (!progressStopped && notifyWin && !notifyWin.isDestroyed()) {
            notifyWin.webContents.send('ffmpeg-progress-stopped', { jobId: streamId, progressFile });
          }
          progressStopped = true;
        };

        const emitProgress = (payload) => {
          const now = Date.now();
          const elapsed = now - lastProgressEmitAt;

          if (elapsed >= progressEmitMinIntervalMs) {
            lastProgressEmitAt = now;
            latestProgressPayload = null;
            if (global.queue) {
              global.queue.emit('job-progress', {
                id: config.jobId,
                panel: 'transcode',
                file: payload.file,
                percent: payload.overall,
                filePercent: payload.percent,
                eta: payload.eta,
                completed: payload.completedFiles,
                total: payload.totalFiles,
                streamId: payload.streamId
              });
            }
            return;
          }

          latestProgressPayload = payload;
          if (throttledEmitTimeout) return;

          throttledEmitTimeout = setTimeout(() => {
            throttledEmitTimeout = null;
            if (!latestProgressPayload || watcherStopped) return;
            const queuedPayload = latestProgressPayload;
            latestProgressPayload = null;
            emitProgress(queuedPayload);
          }, Math.max(10, progressEmitMinIntervalMs - elapsed));
        };

        const parseProgressFile = async () => {
          if (watcherStopped) return;
          if (readInFlight) {
            pendingRead = true;
            return;
          }

          readInFlight = true;
          try {
            const raw = await fs.promises.readFile(progressFile, 'utf8');
            if (watcherStopped) return;
            const lines = raw.trim().split('\n');
            const getVal = (key) => {
              for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].startsWith(key)) {
                  return lines[i].split('=')[1];
                }
              }
              return null;
            };
            const outMsStr = getVal('out_time_ms');
            const prog = getVal('progress');

            const outMs = parseInt(outMsStr, 10) / 1000;
            if (!isNaN(outMs)) {
              if (!started) {
                progressManager.startFile(streamId, inputPath, durationMs);
                started = true;
              }
              const delta = outMs - lastTime;
              if (delta >= 0) {
                lastTime = outMs;
                const payload = {
                  ...progressManager.update(streamId, delta),
                  streamId
                };
                emitProgress(payload);
              }
            }

            if (prog === 'end') {
              stopProgress();
            }
          } catch {
            // ignore read errors
          } finally {
            readInFlight = false;
            if (pendingRead && !watcherStopped) {
              pendingRead = false;
              setImmediate(parseProgressFile);
            }
          }
        };

	        proc.on('error', err => {
	          void (async () => {
	          const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorFailedStartFfmpeg', { error: err.message }));
	          sendJobLog(msg, true);
	          stopProgress();
	          try { await removeFileIfExists(progressFile); } catch {}
	          statusMap.transcoded = false;
	          statusMap.verified = false;
	          qualityResult.reason = mapLegacyQualityReason(qualityResult.reason, qualityResult.status);
          statusMap.quality = qualityResult;
          try { progressManager.finishFile(streamId, statusMap); } catch {}
          if (progressManager.completedFiles >= progressManager.totalFiles) {
            try { progressManager.complete(config.jobId); } catch {}
	          }
	          unregisterJobProcess(config.jobId, proc);
	          finish();
	          })();
	        });

        let lastTime = 0;
        watchInterval = setInterval(() => {
          void parseProgressFile();
        }, progressPollMs);
        void parseProgressFile();

proc.on('exit', (code, signal) => {
  const msg = formatTranscodeMessage(transcodeMessage('transcodeLogFfmpegExited', { exitInfo: formatExitInfo(code, signal) }));
  sendJobLog(msg);
});

	        proc.on('close', async (code, signal) => {
          // Flush any buffered relay line first.
          try { stderrRelay.flush(); } catch {}

          // If FFmpeg failed, dump a bounded stderr tail for the actual failure reason.
          // (The live relay is intentionally throttled/filtered for UX.)
          const wasAborted = !!config.signal?.aborted;
          if (code !== 0 && !wasAborted) {
            const tail = String(stderrTail?.toString?.() || '').trim();
            if (tail) {
              const kb = Math.max(1, Math.round((stderrTail.getBytes?.() || 0) / 1024));
              sendJobLog(formatTranscodeMessage('transcode.error.ffmpegStderrTail', { kb }), true, tail);
              try {
                jobLogger?.error?.('FFmpeg stderr tail captured', {
                  tailBytes: stderrTail.getBytes?.() || null,
                  tailPreview: tail.length > 2000 ? tail.slice(-2000) : tail
                });
              } catch {}
            }
          }

	          stopProgress();
	          try { await removeFileIfExists(progressFile); } catch {}

          statusMap.transcoded = code === 0;

          if (code !== 0) {
            const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorFailedOutputExit', { file: path.basename(finalOutPath), exitInfo: formatExitInfo(code, signal) }));
            sendJobLog(msg, true);
            qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonTranscodeFailed') };
          }

	          let outputExists = false;
	          let imageSeqFrames = [];
		  try {
		    if (isImageSeq) {
		      imageSeqFrames = await listImageSeqFrames();
		      outputExists = imageSeqFrames.length > 0;
		    } else {
		      try {
		        const tempStats = await fsAsync.stat(tempOutPath);
		        outputExists = tempStats.size > 0;
		      } catch {
		        outputExists = false;
		      }
		    }

	    if (outputExists) {
      const okMsg = formatTranscodeMessage(transcodeMessage('transcodeLogOutputExists', { file: path.basename(finalOutPath) }));
      sendJobLog(okMsg);

	      // Image sequences don't produce a single output file to probe/verify.
	      // Treat "frames exist + exit code 0" as success.
	      if (isImageSeq) {
	        const msg = formatTranscodeMessage(transcodeMessage('transcodeLogImageSequenceVerificationSkipped'));
	        sendJobLog(msg);
	        statusMap.verified = statusMap.transcoded;
	        qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonImageSequenceOutput') };

	        if (preserveMetadata !== false) {
	          try {
            const metaResult = await getFFprobeFullJson(inputPath);
            const meta = metaResult?.data;
	            if (meta) {
	              const sidecarPath = `${finalOutPath}_metadata.json`;
	              await fsAsync.writeFile(sidecarPath, JSON.stringify({
	                source: inputPath,
	                generatedAt: new Date().toISOString(),
	                ffprobe: meta
	              }, null, 2));
	              const msg2 = formatTranscodeMessage(transcodeMessage('transcodeLogMetadataSidecarWritten', { file: path.basename(sidecarPath) }));
              sendJobLog(msg2);
            } else {
              const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningPreserveMetadataSidecarUnreadable'));
              sendJobLog(warn);
            }
          } catch (e) {
            const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningMetadataSidecarWriteFailed', { error: e?.message || String(e) }));
            sendJobLog(warn);
          }
        }

	        // If FFmpeg failed but still produced some frames, clean them up.
	        if (!statusMap.transcoded && imageSeqFrames.length) {
	          for (const framePath of imageSeqFrames) {
	            try { await removeFileIfExists(framePath); } catch {}
	          }
	          const delMsg = formatTranscodeMessage(transcodeMessage('transcodeLogDeletedIncompleteImageSequence', { file: path.basename(finalOutPath), ext: imageSeqExt }));
	          sendJobLog(delMsg);
	        }
	      } else {

      // If FFmpeg exited with a failure code, skip verification entirely.
      // Verifying broken outputs just produces confusing logs.
      if (!statusMap.transcoded) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeLogVerificationSkippedEncodeFailed'));
        sendJobLog(msg);
        statusMap.verified = false;
        qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonEncodeFailed') };
      } else if (audioOnly) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeLogVerificationSkippedAudioOnly'));
        sendJobLog(msg);
        statusMap.verified = true;
        qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonAudioOnlyOutput') };
      } else {
        // Caption embed mode: do NOT run normal transcode verification heuristics.
        // They can falsely flag MOV->MXF remuxes and delete the file.
        // Only verify the MXF contains SMPTE-436M ANC.
        if (embedCaptions) {
          try {
            const probe = await new Promise((res) => {
              execFile(
                ffprobePath,
                [
                  '-v', 'error',
                  '-select_streams', 'd',
                  '-show_entries', 'stream=codec_name:stream_tags=data_type',
                  '-of', 'json',
                  tempOutPath
                ],
                (err, stdout) => {
                  if (err) return res(null);
                  try { res(JSON.parse(stdout.toString())); } catch { res(null); }
                }
              );
            });

            const streams = Array.isArray(probe?.streams) ? probe.streams : [];
            const hasAnc = streams.some((s) => {
              const name = String(s?.codec_name || '').toLowerCase();
              const dt = String(s?.tags?.data_type || '').toLowerCase();
              return name.includes('smpte_436m') || dt.includes('smpte_436');
            });

            if (!hasAnc) {
              const badMsg = formatTranscodeMessage(transcodeMessage('transcodeErrorCaptionsEmbeddingAncMissing'));
              sendJobLog(badMsg, true);
              shouldDelete = true;
              statusMap.verified = false;
              statusMap.transcoded = false;
            } else {
              const okMsg = formatTranscodeMessage(transcodeMessage('transcodeLogCaptionsEmbeddingAncDetected'));
              sendJobLog(okMsg);
              statusMap.verified = true;
            }

            qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonCaptionEmbedVerification') };
          } catch (err) {
            const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningCaptionVerifyFailed', { error: err?.message || String(err) }));
            sendJobLog(warn, true);
            // Don't delete; let user inspect file
            statusMap.verified = statusMap.transcoded;
          }
        } else {

      try {
        const codec = await new Promise(res => {
          execFile(ffprobePath, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            tempOutPath
          ], { encoding: 'utf-8' }, (err, stdout) => {
            if (err) return res('');
            res(stdout.toString().trim());
          });
        });
        if (codec) {
          const encMsg = formatTranscodeMessage(transcodeMessage('transcodeLogVideoStreamCodec', { codec }));
          sendJobLog(encMsg);
          if (/_videotoolbox|nvenc|qsv|amf/i.test(codec)) {
            const gpuMsg = formatTranscodeMessage(transcodeMessage('transcodeLogGpuEncoderConfirmed'));
            sendJobLog(gpuMsg);
          } else if (process.env.DEBUG_GPU) {
            const warnMsg = formatTranscodeMessage(transcodeMessage('transcodeWarningGpuEncoderNotDetected'));
            sendJobLog(warnMsg, true);
          }
        } else {
          const fallbackMsg = formatTranscodeMessage(transcodeMessage('transcodeWarningCodecInspectUnavailable'));
          sendJobLog(fallbackMsg);
        }
      } catch (err) {
        const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningCodecInspectFailed', { error: err.message }));
        sendJobLog(warn, true);
      }

      const inMetaResult = await getFFprobeData(inputPath, { preferAudio: audioOnly, logger: jobLogger });
      const outMetaResult = await getFFprobeData(tempOutPath, { preferAudio: audioOnly, logger: jobLogger });
      const inMeta = inMetaResult?.data || null;
      const outMeta = outMetaResult?.data || null;
      let resDiff = false;
      let rateDiff = false;
      if (inMeta && outMeta) {
        const safeFps = (frames, duration) => {
          if (!Number.isFinite(duration) || duration <= 0) {
            return null;
          }
          const rate = frames / duration;
          return Number.isFinite(rate) ? rate : null;
        };
        const formatFps = (value) => (value === null ? 'n/a' : value.toFixed(2));
        const inFps = inMeta?.frames && inMeta?.duration ? (inMeta.frames / inMeta.duration) : 0;
        const outFps = outMeta?.frames && outMeta?.duration ? (outMeta.frames / outMeta.duration) : 0;
        const hasScaleArg = Array.isArray(args) && args.includes('-s');
        resDiff =
          inMeta?.width !== outMeta?.width ||
          inMeta?.height !== outMeta?.height ||
          hasScaleArg;
        rateDiff = frameRate && Math.abs(outFps - inFps) > 0.5;

        // 🧩 Auto-fallback: skip SSIM when resolution, frame rate, or explicit -s scaling differ
        if (verification?.method === 'ssim_psnr' && (resDiff || rateDiff)) {
          const reason = resDiff
            ? 'resolution change detected'
            : 'frame-rate change detected';
          sendJobLog(formatTranscodeMessage('transcode.log.autoSwitchedMetadataVerification', { reason }));
          verification.method = 'metadata';
        }

        const metaMsg = formatTranscodeMessage(transcodeMessage('transcodeLogVerificationMetadataStats', { inFrames: inMeta.frames, outFrames: outMeta.frames, inDuration: inMeta.duration.toFixed(2), outDuration: outMeta.duration.toFixed(2) }));
        sendJobLog(metaMsg);
        if (inMeta.frames !== outMeta.frames) {
          const changedFps = !!frameRate && frameRate !== 'match';
          const msg = changedFps
            ? formatTranscodeMessage(transcodeMessage('transcodeLogFrameCountDiffFpsChange'))
            : formatTranscodeMessage(transcodeMessage('transcodeWarningFrameMismatch'));
          sendJobLog(msg);
        }
        if (Math.abs(inMeta.duration - outMeta.duration) > 0.1) {
          const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningDurationMismatch'));
          sendJobLog(warn, true);
        }

        // 🛑 Flag for possible deletion if metadata differs significantly
        const frameGap = Math.abs(inMeta.frames - outMeta.frames);
        const durationGap = Math.abs(inMeta.duration - outMeta.duration);

        const inFpsLog = formatFps(safeFps(inMeta.frames, inMeta.duration));
        const outFpsLog = formatFps(safeFps(outMeta.frames, outMeta.duration));
        sendJobLog(formatTranscodeMessage('transcode.log.frameRateInOut', { inFps: inFpsLog, outFps: outFpsLog }));

        // 🧩 Adjust deletion heuristic when frame rate or resolution changes
        const frameRatio = outMeta.frames / inMeta.frames;
        const fpsDelta = Math.abs(outFps - inFps);

        if (fpsDelta > 0.5) {
          // Allow larger frame differences when retimed
          shouldDelete = false;
        } else {
          shouldDelete = (
            frameRatio < 0.5 ||
            frameRatio > 2.0 ||
            frameGap > 1000 ||
            durationGap > 1.0
          );
        }
        if (resDiff) {
          // Allow large frame deltas when scaled
          shouldDelete = false;
        }
        if (shouldDelete) {
          const warnDel = formatTranscodeMessage(transcodeMessage('transcodeErrorIncompleteTranscodeFrames', { expectedFrames: inMeta.frames, actualFrames: outMeta.frames }));
          sendJobLog(warnDel, true);
        }
      }

      if (verification?.method === 'metadata') {
        const inMetaRecoverable = !!inMetaResult?.error?.recoverable;
        const outMetaRecoverable = !!outMetaResult?.error?.recoverable;
        // If metadata-based verification is requested but ffprobe can't read either side,
        // treat that as a verification failure (common with corrupt outputs), unless the
        // error is a recoverable timeout/buffer issue.
        if (!inMeta || !outMeta) {
          if (inMetaRecoverable || outMetaRecoverable) {
            const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningMetadataVerificationSkippedFfprobeLimits'));
            sendJobLog(warn);
            statusMap.verified = false;
            shouldDelete = false;
            qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonFfprobeTimedOut') };
          } else {
            sendJobLog(formatTranscodeMessage('transcode.error.metadataVerificationFailedUnreadable'), true);
            statusMap.verified = false;
            shouldDelete = true;
            qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonMetadataVerificationFailed') };
          }
        } else {
          if (resDiff || rateDiff) {
            sendJobLog(formatTranscodeMessage('transcode.log.ssimPsnrSkippedGeometryChange'));
          }
          const verificationMsg = shouldDelete
            ? formatTranscodeMessage(transcodeMessage('transcodeLogMetadataVerificationFlagged'))
            : formatTranscodeMessage(transcodeMessage('transcodeLogMetadataVerificationPassed'));
          sendJobLog(verificationMsg);
          statusMap.verified = !shouldDelete;
          qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonMetadataVerificationOnly') };
        }
      } else if (verification?.method === 'ssim_psnr') {
        if (containerFormat === 'image_sequence' || containerFormat === 'image2') {
          const msg = formatTranscodeMessage(transcodeMessage('transcodeLogSsimPsnrSkippedImageSequence'));
          sendJobLog(msg);
          qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonImageSequenceOutput') };
        } else {
          try {
            // If the job specified a frameRate (e.g. retime to 23.976), pass it through.
            // Otherwise, runSsimPsNrCheck will auto-read output FPS via ffprobe.
            const targetRetimeFps = frameRate && frameRate !== 'match'
              ? Number(String(frameRate).replace('df', ''))   // strip DF label if present
              : undefined;

            qualityResult = await runSsimPsNrCheck({
              ffmpegPath,
              ffprobePath,
              src: inputPath,
              out: tempOutPath,
              timeoutMs: 3 * 60 * 1000,
              retimeFps: targetRetimeFps
            });
          } catch (qcErr) {
            qualityResult = { status: 'error', reason: qualityReason('transcodeQualityReasonQcError', { message: qcErr.message }) };
          }

          if (qualityResult.status === 'ok') {
            const { ssim, psnr } = qualityResult;
            const hasSsim = typeof ssim === 'number' && Number.isFinite(ssim);
            const hasPsnr = typeof psnr === 'number' && Number.isFinite(psnr);
            const summary = formatTranscodeMessage('transcodeQualityOk', { prefix: '🧪', ssim: hasSsim ? ssim.toFixed(4) : 'n/a', psnr: hasPsnr ? formatTranscodeMessage('transcodePsnrDb', { value: psnr.toFixed(2) }) : 'n/a' });
            sendJobLog(summary);

            const degraded = (hasSsim && ssim < 0.95) || (hasPsnr && psnr < 35);
            const verdict = degraded
              ? formatTranscodeMessage(transcodeMessage('transcodeWarningQualityBelowThreshold'))
              : formatTranscodeMessage(transcodeMessage('transcodeLogSsimPsnrVerificationPassed'));
            sendJobLog(verdict);
            statusMap.verified = !degraded;
          } else if (qualityResult.status === 'skipped') {
            const skipMsg = formatTranscodeMessage('transcodeQualitySkipped', { reason: formatQualityReason(mapLegacyQualityReason(qualityResult.reason, qualityResult.status)) });
            sendJobLog(skipMsg);
          } else if (qualityResult.status === 'error') {
            const errMsg = formatTranscodeMessage('transcodeQualityError', { reason: formatQualityReason(mapLegacyQualityReason(qualityResult.reason, qualityResult.status)) });
            sendJobLog(errMsg, true);
          }
        }
      }
        }

	      if (shouldDelete) {
          statusMap.transcoded = false;
          statusMap.verified = false;
          sendJobLog(formatTranscodeMessage('transcode.error.verificationFailedOutputRemoved'), true);
	        try {
	          await removeFileIfExists(tempOutPath);
	          const delMsg = formatTranscodeMessage(transcodeMessage('transcodeLogDeletedIncompleteFile', { file: path.basename(finalOutPath) }));
	          sendJobLog(delMsg);
	        } catch (err) {
	          const failDel = formatTranscodeMessage(transcodeMessage('transcodeWarningDeletePartialFailed', { error: err.message }));
	          sendJobLog(failDel);
	        }
	      }

      } // end: statusMap.transcoded && !audioOnly verification block
	      }

    } else {
      const errMsg = formatTranscodeMessage(transcodeMessage('transcodeErrorOutputMissingOrEmpty', { file: path.basename(finalOutPath) }));
      sendJobLog(errMsg, true);
      qualityResult = { status: 'skipped', reason: qualityReason('transcodeQualityReasonOutputMissing') };
	      // If FFmpeg reported success but we cannot find any output, treat it as a failure.
	      statusMap.transcoded = false;
	      statusMap.verified = false;
    }
  } catch (verErr) {
    const errMsg = formatTranscodeMessage(transcodeMessage('transcodeWarningVerificationError', { error: verErr.message }));
    sendJobLog(errMsg, true);
    if (!qualityResult || qualityResult.status === 'skipped') {
      qualityResult = { status: 'error', reason: qualityReason('transcodeQualityReasonVerificationError', { message: verErr.message }) };
    }
  }


	          const canFinalize =
	            statusMap.transcoded &&
	            !shouldDelete &&
		            (isImageSeq ? outputExists : await pathExists(tempOutPath));

          if (canFinalize) {
	            // Image sequences are already written directly to the final prefix.
	            if (!isImageSeq) {
	              try {
	                renameReplaceSync(tempOutPath, finalOutPath);
                  sendJobLog(formatTranscodeMessage('transcode.log.finalOutput', { finalOutPath }));
	              } catch (err) {
                const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorFinalizeOutputFileFailed', { error: err.message, tempOutPath }));
	                sendJobLog(msg, true);
	                statusMap.transcoded = false;
	              }
	            }
          } else {
            // Best-effort: don’t leave stray partials around
	            try {
		              if (isImageSeq) {
		                // Remove any partial frames that may have been written.
		                const partial = await listImageSeqFrames();
		                for (const framePath of partial) {
		                  try { await removeFileIfExists(framePath); } catch {}
		                }
		              } else {
		                await removeFileIfExists(tempOutPath);
		              }
            } catch {
              /* ignore */
            }
          }

          if (statusMap.transcoded) {
            // MP4 Preserve Metadata compatibility mode:
            // MP4/M4V outputs can’t reliably embed non-A/V streams (e.g., timecode/data/attachments).
            // We preserve global metadata + all A/V streams in the container, and write a sidecar
            // with full source ffprobe metadata so nothing is lost downstream.
            const containerLower = String(containerFormat || '').toLowerCase();
            const shouldWritePreserveCompatSidecar =
              preserveMetadata !== false &&
              !audioOnly &&
              !isImageSeq &&
              ['mp4', 'm4v', 'mkv', 'webm'].includes(containerLower);

            if (shouldWritePreserveCompatSidecar) {
              try {
                const metaResult = await getFFprobeFullJson(inputPath);
                const meta = metaResult?.data;
                if (meta) {
                  const isMp4 = ['mp4', 'm4v'].includes(containerLower);
                  const mode = isMp4
                    ? 'mp4_av_only_plus_global_metadata'
                    : (containerLower === 'mkv'
                      ? 'mkv_avs_only_plus_global_metadata'
                      : 'webm_av_only_plus_global_metadata');

                  const note = isMp4
                    ? 'MP4/M4V output cannot reliably embed all non-A/V tracks (e.g., timecode/data/attachments). Full source ffprobe metadata is saved here as a sidecar.'
                    : (containerLower === 'mkv'
                      ? 'MKV output cannot carry generic data tracks (e.g., QuickTime tmcd timecode). Full source ffprobe metadata is saved here as a sidecar.'
                      : 'WebM output is constrained and cannot reliably embed non-A/V tracks. Full source ffprobe metadata is saved here as a sidecar.');

	                  const sidecarPath = `${finalOutPath}_metadata.json`;
	                  await fsAsync.writeFile(
	                    sidecarPath,
	                    JSON.stringify(
                      {
                        source: inputPath,
                        output: finalOutPath,
                        generatedAt: new Date().toISOString(),
                        mode,
                        note,
                        ffprobe: meta
                      },
                      null,
                      2
	                    )
	                  );
                  const label = (containerLower || 'output').toUpperCase();
                  const msg2 = formatTranscodeMessage(transcodeMessage('transcodeLogMetadataSidecarWrittenCompat', { label, file: path.basename(sidecarPath) }));
                  sendJobLog(msg2);
                } else {
                  const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningPreserveMetadataSidecarUnreadableCompat'));
                  sendJobLog(warn);
                }
              } catch (e) {
                const warn = formatTranscodeMessage(transcodeMessage('transcodeWarningMetadataSidecarWriteFailedCompat', { error: e?.message || String(e) }));
                sendJobLog(warn);
              }
            }

            sendJobLog(formatTranscodeMessage('transcode.progress.doneFile', { file: path.basename(finalOutPath) }));
          }

          qualityResult.reason = mapLegacyQualityReason(qualityResult.reason, qualityResult.status);
          statusMap.quality = qualityResult;

          progressManager.finishFile(streamId, statusMap);
          if (progressManager.completedFiles >= progressManager.totalFiles) {
            try {
              progressManager.complete(config.jobId);
            } catch {}
          }
          if (global.queue) {
            global.queue.emit('job-progress', {
              id: config.jobId,
              panel: 'transcode',
              file: path.basename(inputPath),
              status: { ...statusMap }
            });
          }

          unregisterJobProcess(config.jobId, proc);

          completed++;
          if (!statusMap.transcoded) failed++;

          if (global.queue) {
            const statusText = statusMap.transcoded
              ? formatTranscodeMessage('transcode.progress.doneFile', { file: path.basename(finalOutPath) })
              : formatTranscodeMessage('transcode.progress.failedFile', { file: path.basename(finalOutPath) });

            const donePayload = {
              id: config.jobId,
              panel: 'transcode',
              file: path.basename(finalOutPath),
              status: statusText,
              percent: 100,
              filePercent: 100,
              completed,
              total,
              eta: '0s'
            };
            global.queue.emit('job-progress', donePayload);
          }

          if (completed === total && !config.signal?.aborted) {
            sendJobLog(formatTranscodeMessage('transcode.log.jobComplete'));
          }

          finish();
        });

        } catch (err) {
          const errMsg = formatTranscodeMessage('transcode.error.internal', { error: err?.message || String(err) });
          sendJobLog(errMsg, true);
          if (statusMap) {
            statusMap.transcoded = false;
            statusMap.verified = false;
          }
          const fallbackStatus = statusMap || {
            transcoded: false,
            verified: false,
            outputFile: outName,
            finalOutputPath: finalOutPath
          };
          const durationMs = durationMap.get(inputPath) || 0;
          try { progressManager.startFile(streamId, inputPath, durationMs); } catch {}
          try { if (durationMs > 0) progressManager.update(streamId, durationMs); } catch {}
          try { progressManager.finishFile(streamId, fallbackStatus); } catch {}
          if (progressManager.completedFiles >= progressManager.totalFiles) {
            try { progressManager.complete(config.jobId); } catch {}
          }
          if (global.queue) {
            global.queue.emit('job-progress', {
              id: config.jobId,
              panel: 'transcode',
              file: path.basename(inputPath),
              status: { ...fallbackStatus }
            });

            global.queue.emit('job-progress', {
              id: config.jobId,
              panel: 'transcode',
              file: path.basename(finalOutPath || inputPath),
              status: formatTranscodeMessage('transcode.progress.failedFile', { file: path.basename(finalOutPath || inputPath) }),
              percent: 100,
              filePercent: 100,
              completed: completed + 1,
              total,
              eta: '0s'
            });
          }
          completed++;
          failed++;
          try { resolveOne(); } catch {}
        }

        })();
      });
    }

    const skippedOutName = (file, index) => buildOutputName(file, index, {
      containerFormat: effectiveContainerFormat,
      appendSeq,
      isBatch
    });
    skippedEntries.forEach(({ file, index, reason }) => {
      const streamId = `skip-${index}`;
      const statusMap = {
        transcoded: false,
        verified: false,
        outputFile: skippedOutName(file, index),
        skipped: true,
        skipReason: reason
      };
      progressManager.startFile(streamId, file, 0);
      progressManager.finishFile(streamId, statusMap);
      completed++;
      skipped++;
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'transcode',
          file: path.basename(file),
          status: formatTranscodeMessage('transcode.progress.skippedFile', { file: path.basename(file) }),
          percent: 100,
          filePercent: 100,
          completed,
          total,
          eta: '0s'
        });
      }
    });

    const skippedSet = new Set(skippedEntries.map(entry => entry.file));
    const transcodeEntries = fileEntries.filter(entry => !skippedSet.has(entry.file));

    const outputPathPlan = new Map();
    for (const entry of transcodeEntries) {
      if (config.signal?.aborted) break;
      const planned = await resolveOutputPathForInput({
        inputPath: entry.file,
        index: entry.index,
        outputFolder: outputFolderPath,
        containerFormat: effectiveContainerFormat,
        appendSeq,
        isBatch,
        outputFormat
      });
      outputPathPlan.set(entry.index, planned);
      if (planned.wasSuffixed) {
        sendJobLog(formatTranscodeMessage('transcode.warning.outputExistsUsing', { file: path.basename(planned.finalOutPath) }));
      }
    }

    // Chain all jobs sequentially
    const tasks = transcodeEntries.map(({ file, index }) => async (workerId) => {
      if (config.signal?.aborted) return;
      await runOne(file, index, workerId);
    });

    // Run all transcode tasks then finalize
    let taskResults;
    try {
      taskResults = await runWithConcurrencyLimit(tasks, threadCount);
    } catch (err) {
      const reason = err?.message || String(err) || 'unknown error';
      const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorQueueExecutionFailed', { reason }));
      sendJobLog(msg, true);
      jobLogger?.error?.('Transcode queue execution failed', {
        reason: 'run_with_concurrency_failed',
        error: reason,
        stack: err?.stack || null
      });
      throw err;
    }

    try {

      const taskFailures = (taskResults || []).filter(r => r && r.success === false);
      if (taskFailures.length) {
        const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorTaskCrashCount', { count: taskFailures.length }));
        sendJobLog(msg, true);
        taskFailures.slice(0, 5).forEach((f) => {
          if (f?.error) {
            const em = formatTranscodeMessage(transcodeMessage('transcodeErrorTaskCrashItem', { error: f.error }));
            sendJobLog(em, true);
          }
        });
      }

      reportStats = {
        requestedFiles: total,
        processedFiles: completed,
        successfulFiles: Math.max(0, completed - failed - skipped),
        failedFiles: failed,
        skippedFiles: skipped,
        taskCrashedCount: taskFailures.length,
      };

      if (verification?.saveLog) {
        persistJobLogs({ closeLogger: false });
        const logFile = path.join(outputFolderPath, `TranscodeLog_${Date.now()}.txt`);
        if (archivePath && fs.existsSync(archivePath)) {
          fs.copyFileSync(archivePath, logFile);
          savedJobReportCopies.add(logFile);
        } else {
          writeLogToFile(logs, logFile);
          savedJobReportCopies.add(logFile);
        }
        sendJobLog(formatTranscodeMessage('transcode.log.savedTo', { logFile }));
      }

      sendJobLog(formatTranscodeMessage('transcode.log.filesProcessed', {
        completed,
        total,
        failedSuffix: failed ? formatTranscodeMessage('transcode.log.failedSuffix', { failed }) : '',
        skippedSuffix: skipped ? formatTranscodeMessage('transcode.log.skippedSuffix', { skipped }) : ''
      }));
 
      const wasCanceled = config.signal?.aborted;
      if (wasCanceled) {
        sendJobLog(formatTranscodeMessage('transcode.log.cancelledByUser'));
      }

      const finalLogs = logs;

      try {
        removeJobFile();
      } catch {
        // ignore errors cleaning up job file
      }

      if (progressManager?.complete) {
        progressManager.complete(config.jobId);
      } else if (progressManager?.dispose) {
        progressManager.dispose();
      }

      try { unbindProgress?.(); } catch {}
      unbindProgress = null;

      const jobSucceeded = !wasCanceled
        && failed === 0
        && skipped === 0
        && taskFailures.length === 0
        && completed === total;

      const finalStage = wasCanceled ? 'cancelled' : (jobSucceeded ? 'complete' : 'error');
      jobLogger.setStage(finalStage);
      jobLogger.info(
        wasCanceled ? 'Transcode job cancelled' : (jobSucceeded ? 'Transcode job completed' : 'Transcode job failed')
      );

      reportStats = {
        ...reportStats,
        cancelled: !!wasCanceled,
      };

      persistJobLogs({ rewriteText: true, closeLogger: false });

      sendJobLog(formatTranscodeMessage('transcode.log.archivedTo', { archivePath }));

      if (enableN8N) {
        if (n8nValidation.valid) {
          const includeSensitivePaths = !!n8nIncludePaths;
          const payload = n8nLog
            ? { log: finalLogs }
            : {
                status: wasCanceled ? 'cancelled' : (jobSucceeded ? 'complete' : 'error'),
                notes,
                success: jobSucceeded,
                cancelled: wasCanceled,
                total,
                completed,
                failed,
                skipped,
                jobId: config.jobId,
                ...(includeSensitivePaths
                  ? {
                      outputFolder: outputFolderPath,
                      archivePath,
                      structuredLogPath: structuredPath
                    }
                  : {})
              };

          sendJobLog(formatTranscodeMessage('transcode.webhook.prepareValidated'));
          sendJobLog(formatTranscodeMessage(transcodeMessage('transcodeLogWebhookPayloadPreview', {
            payload: JSON.stringify(payload, null, 2)
          })));

          const timeoutMs = 8000;
          try {
            const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            let timeoutCleared = false;
            const clearTimeoutSafe = () => {
              if (!timeoutCleared) {
                clearTimeout(timeoutId);
                timeoutCleared = true;
              }
            };

            try {
              await fetch(n8nValidation.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
              });
              clearTimeoutSafe();
              sendJobLog(formatTranscodeMessage('transcode.webhook.triggered'));
            } finally {
              clearTimeoutSafe();
            }
          } catch (err) {
            if (err?.name === 'AbortError') {
              sendJobLog(formatTranscodeMessage('transcode.webhook.timeout', { timeoutMs }));
            } else {
              sendJobLog(formatTranscodeMessage('transcode.webhook.triggerFailed', { error: err?.message || err }));
            }
          }
        } else {
          sendJobLog(formatTranscodeMessage('transcode.webhook.skippedInvalid', { message: String(n8nValidation.message || '').replace(/^❌\s*/, '') }));
        }
      }

      if (captionTempDir) {
        try { fs.rmSync(captionTempDir, { recursive: true, force: true }); } catch {}
        captionTempDir = null;
      }

      persistJobLogs({ rewriteText: true });

      settle({
        success: jobSucceeded,
        cancelled: wasCanceled,
        log: finalLogs,
        logText: finalLogs.join('\n'),
        archivePath,
        structuredLogPath: structuredPath,
        jobId: config.jobId
      });
    } catch (finalizeErr) {
      const reason = finalizeErr?.message || String(finalizeErr) || 'unknown error';
      const msg = formatTranscodeMessage(transcodeMessage('transcodeErrorFinalizationFailed', { reason }));
      sendJobLog(msg, true);
      jobLogger?.error?.('Transcode finalization failed', {
        reason: 'transcode_finalization_failed',
        error: reason,
        stack: finalizeErr?.stack || null,
        jobId: config.jobId
      });
      throw finalizeErr;
    }
    } catch (err) {
      const reason = err?.message || String(err) || 'unknown error';
      const failureMsg = formatTranscodeMessage('transcode.error.failedUnexpectedly', { error: reason });
      try {
        logs.push(failureMsg);
        jobLogger?.setStage?.('error');
        jobLogger?.error?.('Transcode execution failed unexpectedly', {
          reason: 'unhandled_transcode_error',
          error: reason,
          stack: err?.stack || null,
          jobId: config.jobId
        });
      } catch {}
      try { persistJobLogs({ rewriteText: true }); } catch {}
      settle({
        success: false,
        cancelled: false,
        log: logs,
        logText: logs.join('\n'),
        archivePath,
        structuredLogPath: structuredPath,
        jobId: config.jobId
      });
    } finally {
      try { unbindProgress?.(); } catch {}
      try { progressManager?.dispose?.(); } catch {}
      if (captionTempDir) {
        try { fs.rmSync(captionTempDir, { recursive: true, force: true }); } catch {}
        captionTempDir = null;
      }
      try { removeJobFile(); } catch {}
      try { persistJobLogs(); } catch {}
      try { refreshSavedJobReportCopies(); } catch {}
    }
    };

    executeTranscode().catch((err) => {
      const reason = err?.message || String(err) || 'unknown error';
      settle({
        success: false,
        cancelled: false,
        log: [formatTranscodeMessage('transcode.error.failedUnexpectedly', { error: reason })],
        logText: formatTranscodeMessage('transcode.error.failedUnexpectedly', { error: reason }),
        jobId: config.jobId
      });
    });
  });
}

function cancelTranscode(id) {
  const procs = jobProcesses.get(id);
  if (procs) {
    for (const proc of procs) {
      if (proc && typeof proc.kill === 'function') {
        attachEscalationCleanupListener(proc);
        if (!isProcessActive(proc)) continue;

        try {
          proc.kill('SIGINT');
        } catch {
          try {
            proc.kill('SIGTERM');
          } catch {
            // ignore if signals are unsupported
          }
        }

        const escalationTimer = setTimeout(() => {
          if (isProcessActive(proc)) {
            sendLogMessage(
              'transcode',
              formatTranscodeMessage('transcode.cancel.escalation', { jobId: id }),
              '',
              false,
              id,
              'warn',
              id,
              'cancel-escalation',
              { jobId: id, escalationSignal: 'SIGKILL' },
              Date.now()
            );
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore if SIGKILL isn't supported
            }
          }
          clearEscalationTimer(proc);
        }, 1000);
        cancellationEscalationTimers.set(proc, escalationTimer);
      }
    }
  }
  if (id) {
    sendLogMessage(
      'transcode',
      formatTranscodeMessage('transcode.cancel.requested', { jobId: id }),
      '',
      false,
      id,
      'warn',
      id,
      'cancel-request',
      { jobId: id, cancelRequested: true },
      Date.now()
    );
  }
  cancelJob(id);
}

module.exports = {
  runTranscode,
  cancelTranscode,
  buildOutputName,
  jobProcesses,
  preflightTranscodeDisk,
  formatBytes,
  validateN8nUrl,
  createStderrLineRelay
};
