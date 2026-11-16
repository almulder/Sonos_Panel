// server/transcoder.js
//
// On-the-fly transcoding for files Sonos can't play as-is (v0.21.0).
//
// WHAT: hi-res FLAC/ALAC/WAV/AIFF (above 24-bit or 48 kHz on S2, 16-bit
// on S1), WMA Lossless, Opus, DSD, APE and WavPack used to be filed as
// "incompatible" and hidden. With ffmpeg available they're indexed like
// any other track instead, and converted to FLAC at the best quality the
// speakers accept the first time a speaker asks for one.
//
// WHY A CACHE, NOT A LIVE PIPE: Sonos seeks with HTTP Range requests and
// reads the track length from the response. A live ffmpeg pipe has no
// length and can't jump to a byte offset, so seeking breaks and the
// progress bar has no end. Converting to a file first (a few seconds
// for a typical song) and then serving that file with res.sendFile
// keeps seeking, gapless chaining and durations exactly as they are for
// native files. Tracks are also converted ahead of time when they're
// queued (prewarm), so the speaker usually finds them ready.
//
// CACHE: DATA_DIR/transcode/<sha1>.flac, keyed on path + mtime + size +
// target, so an edited file converts again and the old copy ages out.
// Capped at TRANSCODE_CACHE_GB (default 5); least recently played files
// are removed first.
//
// SETTINGS (env):
//   TRANSCODE           'off' disables. Default: on whenever ffmpeg is found.
//   TRANSCODE_CACHE_GB  cache cap in GB (default 5, decimals allowed)
//   FFMPEG_PATH         ffmpeg binary (default: 'ffmpeg' on PATH)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const debugLog = require('./debugLog');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'transcode');
const FFMPEG = String(process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
const DISABLED = String(process.env.TRANSCODE || '').trim().toLowerCase() === 'off';
const CACHE_CAP_BYTES = Math.max(0.01, Number(process.env.TRANSCODE_CACHE_GB) || 5) * 1024 * 1024 * 1024;
const SONOS_SYSTEM = String(process.env.SONOS_SYSTEM || 's2').toLowerCase() === 's1' ? 's1' : 's2';
const MAX_BITS = SONOS_SYSTEM === 's1' ? 16 : 24;
// One conversion at a time for prewarm, plus one more for a speaker
// that's waiting -- keeps a scan or a 500-track queue from pinning
// every core on a home server.
const MAX_CONCURRENT = 2;
const PREWARM_QUEUE_MAX = 50;
// A conversion that runs this long is stuck (a 30-minute DSD track takes
// well under a minute on any recent CPU).
const CONVERT_TIMEOUT_MS = 5 * 60 * 1000;
// Cache files used this recently are never evicted (see evict()).
const RECENT_KEEP_MS = 10 * 60 * 1000;

function gb(bytes) {
  const v = bytes / 1073741824;
  return v < 1 ? v.toFixed(2) : v.toFixed(1);
}

// Extensions that only make sense WITH transcoding (Sonos plays none of
// them natively) -- the scanner looks at them only when this is enabled.
const TRANSCODE_ONLY_EXTENSIONS = ['.opus', '.dsf', '.dff', '.ape', '.wv'];

let ffmpegVersion = null; // null = not checked, false = missing
function detectFfmpeg() {
  if (ffmpegVersion !== null) return ffmpegVersion;
  try {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000 });
    const m = r.status === 0 && /ffmpeg version (\S+)/.exec(r.stdout || '');
    ffmpegVersion = m ? m[1] : false;
  } catch (err) {
    ffmpegVersion = false;
  }
  return ffmpegVersion;
}

function isEnabled() {
  return !DISABLED && !!detectFfmpeg();
}

// ---------------------------------------------------------------------
// Target format. Stored by the scanner in tracks.transcode as
// "flac:<bits>:<rate>" so the stream route needs no probing. Bits are
// capped at what this Sonos generation plays; rates above 48 kHz drop
// to 44.1 or 48 kHz, whichever family the source belongs to (an exact
// 2:1 or 4:1 step resamples most cleanly). Lossy sources (Opus) become
// 16-bit -- there's no more detail in them than that.
// ---------------------------------------------------------------------
function targetFor(format, lossySource) {
  const f = format || {};
  let srcBits = Number(f.bitsPerSample) || (lossySource ? 16 : 24);
  if (srcBits < 8) srcBits = 24; // DSD reports 1-bit: treat as hi-res
  const bits = lossySource ? 16 : (srcBits > 16 ? MAX_BITS : 16);
  const srcRate = Number(f.sampleRate) || 44100;
  let rate = srcRate;
  if (srcRate > 48000) rate = srcRate % 44100 === 0 ? 44100 : 48000;
  // DSD reports its 1-bit rate (2.8 MHz+); always a 44.1k family.
  if (srcRate > 384000) rate = 44100;
  return `flac:${bits}:${rate}`;
}

function parseTarget(target) {
  const m = /^flac:(16|24):(\d+)$/.exec(String(target || ''));
  return m ? { bits: Number(m[1]), rate: Number(m[2]) } : null;
}

function ffmpegArgs(absIn, absOut, target) {
  const t = parseTarget(target) || { bits: 16, rate: 44100 };
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', absIn,
    '-map', '0:a:0', '-vn', '-map_metadata', '-1'];
  // Triangular dither when cutting bit depth; plain resample otherwise.
  args.push('-af', t.bits === 16 ? `aresample=${t.rate}:dither_method=triangular` : `aresample=${t.rate}`);
  args.push('-c:a', 'flac', '-compression_level', '5');
  if (t.bits === 24) args.push('-sample_fmt', 's32', '-bits_per_raw_sample', '24');
  else args.push('-sample_fmt', 's16');
  args.push('-f', 'flac', absOut);
  return args;
}

// ---------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------
function cacheKey(absIn, target) {
  const st = fs.statSync(absIn);
  return crypto.createHash('sha1')
    .update(`${absIn}\n${Math.round(st.mtimeMs)}\n${st.size}\n${target}`)
    .digest('hex');
}

const inFlight = new Map(); // key -> Promise<cachedPath>
let running = 0;
const waiting = []; // { run, high } -- speaker requests jump ahead of prewarm

function schedule(run, high) {
  return new Promise((resolve, reject) => {
    const job = { run: () => run().then(resolve, reject), high };
    if (high) {
      const firstLow = waiting.findIndex((w) => !w.high);
      if (firstLow === -1) waiting.push(job); else waiting.splice(firstLow, 0, job);
    } else {
      waiting.push(job);
    }
    pump();
  });
}

function pump() {
  while (running < MAX_CONCURRENT && waiting.length > 0) {
    const job = waiting.shift();
    running += 1;
    job.run().finally(() => { running -= 1; pump(); });
  }
}

function convert(absIn, absOut, target, label) {
  return new Promise((resolve, reject) => {
    const tmp = `${absOut}.part`;
    const started = Date.now();
    let stderr = '';
    const proc = spawn(FFMPEG, ffmpegArgs(absIn, tmp, target), { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => proc.kill('SIGKILL'), CONVERT_TIMEOUT_MS);
    proc.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          fs.renameSync(tmp, absOut);
        } catch (err) {
          return reject(err);
        }
        debugLog.info('transcode', `Converted "${label}" -> ${target} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return resolve(absOut);
      }
      fs.rm(tmp, { force: true }, () => {});
      reject(new Error(signal ? `ffmpeg killed (${signal})` : `ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() || 'no output'}`));
    });
  });
}

// Returns the path of a ready-to-serve FLAC for this file, converting
// it first if needed. Concurrent callers for the same file share one
// conversion. `high` = a speaker is waiting on it right now.
async function getConverted(absIn, target, label, high) {
  if (!isEnabled()) throw new Error('transcoding is not enabled');
  const key = cacheKey(absIn, target);
  const out = path.join(CACHE_DIR, `${key}.flac`);
  if (fs.existsSync(out)) {
    // Mark as recently used for eviction.
    const now = new Date();
    fs.utimes(out, now, now, () => {});
    return out;
  }
  if (inFlight.has(key)) return inFlight.get(key);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const p = schedule(() => convert(absIn, out, target, label), high)
    .then((result) => { evictSoon(); return result; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// Oldest-used first until the cache is under 90% of the cap. Runs after
// conversions, debounced; never removes a file that's being written.
let evictTimer = null;
function evictSoon() {
  if (evictTimer) return;
  evictTimer = setTimeout(() => { evictTimer = null; evict(); }, 2000);
}

function cacheEntries() {
  let names = [];
  try { names = fs.readdirSync(CACHE_DIR); } catch (err) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.flac')) continue;
    try {
      const st = fs.statSync(path.join(CACHE_DIR, name));
      out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch (err) { /* removed meanwhile */ }
  }
  return out;
}

function evict() {
  const entries = cacheEntries().sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = entries.reduce((n, e) => n + e.size, 0);
  if (total <= CACHE_CAP_BYTES) return;
  const goal = CACHE_CAP_BYTES * 0.9;
  let removed = 0;
  // Anything played or converted in the last few minutes is probably
  // playing right now or about to -- never removed, even when that leaves
  // the cache over its cap for a while (a single file bigger than the
  // cap would otherwise be deleted the moment it was made).
  const recentCutoff = Date.now() - RECENT_KEEP_MS;
  for (const e of entries) {
    if (total <= goal) break;
    if (e.mtimeMs >= recentCutoff) continue;
    try {
      fs.rmSync(path.join(CACHE_DIR, e.name), { force: true });
      total -= e.size;
      removed += 1;
    } catch (err) { /* in use on some platforms -- skip */ }
  }
  if (removed) debugLog.info('transcode', `Cache over ${gb(CACHE_CAP_BYTES)} GB: removed ${removed} least recently played file(s)`);
}

// Leftover .part files from a crash or restart mid-conversion.
function cleanPartials() {
  let names = [];
  try { names = fs.readdirSync(CACHE_DIR); } catch (err) { return; }
  for (const name of names) {
    if (name.endsWith('.part')) fs.rmSync(path.join(CACHE_DIR, name), { force: true });
  }
}

// ---------------------------------------------------------------------
// Prewarm: convert queued tracks before the speaker gets to them. Takes
// the panel's own /transcode/ URLs; a resolver (set by index.js) maps a
// URL back to the file and its target. Bounded, low priority.
// ---------------------------------------------------------------------
let resolveUri = null;
let prewarmPending = 0;
function setUriResolver(fn) { resolveUri = fn; }

function prewarm(uri) {
  if (!resolveUri || typeof uri !== 'string' || !uri.includes('/transcode/') || !isEnabled()) return;
  if (prewarmPending >= PREWARM_QUEUE_MAX) return;
  let job;
  try { job = resolveUri(uri); } catch (err) { job = null; }
  if (!job) return;
  prewarmPending += 1;
  getConverted(job.abs, job.target, job.rel, false)
    .catch((err) => debugLog.warn('transcode', `Prewarm of "${job.rel}" failed: ${err.message}`))
    .finally(() => { prewarmPending -= 1; });
}

function init() {
  if (DISABLED) {
    debugLog.info('transcode', 'Transcoding disabled (TRANSCODE=off) -- files Sonos cannot play stay on the incompatible list');
    return false;
  }
  const v = detectFfmpeg();
  if (!v) {
    debugLog.info('transcode', `Transcoding unavailable -- ffmpeg not found (${FFMPEG}); files Sonos cannot play stay on the incompatible list`);
    return false;
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  cleanPartials();
  evict();
  debugLog.info('transcode', `Transcoding enabled (ffmpeg ${v}): files Sonos can't play are converted to FLAC up to ${MAX_BITS}-bit/48 kHz, cache ${gb(CACHE_CAP_BYTES)} GB at ${CACHE_DIR}`);
  return true;
}

function getStatus() {
  const entries = isEnabled() ? cacheEntries() : [];
  return {
    enabled: isEnabled(),
    ffmpeg: detectFfmpeg() || null,
    disabledBySetting: DISABLED,
    cacheFiles: entries.length,
    cacheBytes: entries.reduce((n, e) => n + e.size, 0),
    cacheCapBytes: CACHE_CAP_BYTES,
    converting: running,
    queued: waiting.length
  };
}

module.exports = {
  init,
  isEnabled,
  targetFor,
  parseTarget,
  getConverted,
  prewarm,
  setUriResolver,
  getStatus,
  TRANSCODE_ONLY_EXTENSIONS,
  // exported for direct testing
  ffmpegArgs
};
