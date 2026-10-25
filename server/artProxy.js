// server/artProxy.js
//
// Album-art proxy + cache for artwork that lives ON THE SPEAKERS
// (http://<speaker>:1400/getaa?..., /img/...).
//
// WHY THIS EXISTS: browse/queue payloads hand the browser dozens of
// speaker art URLs, and a Sonos speaker answers getaa requests one at a
// time (~150-250ms each -- measured: 29 queue covers fired at one
// speaker stair-stepped from 0.2s to 4.8s total). The browser's prefetch
// pass and the queue panel used to flood a single speaker with all of
// them at once, so the now-playing cover (and even internet art, stuck
// behind the same connection pool) took 4-5s on the wall panel. Routing
// speaker art through here gives us:
//   - a shared cache (memory LRU + disk), so each image is fetched from
//     a speaker once per server, not once per browser per page load;
//   - single-flight per URL and a per-speaker concurrency cap, so the
//     server never floods a speaker either;
//   - priority: what a screen is showing right now jumps ahead of the
//     background warm-up, and spills onto other idle speakers when its
//     own speaker is busy (getaa is household-wide -- verified: the same
//     path returns byte-identical images from different speakers);
//   - a negative cache: about half the getaa URLs in a real household
//     404 (Amazon tracks the speaker has no art for), and re-asking for
//     those on every screen open is pure waste.
//
// SSRF: this is NOT a general proxy. Only http://<ip>:1400/<art path> on
// a host that is a currently known Sonos device is ever fetched; internet
// CDN art (Pandora, TuneIn, ...) keeps loading directly in the browser.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const debugLog = require('./debugLog');
const localLibrary = require('./localLibrary');
const localScanner = require('./localScanner');

const SPEAKER_PORT = '1400';
// Speaker paths that serve images. getaa is the album-art extractor;
// /img/ and /images/ are the speaker's own static icons.
const ART_PATH_RE = /^\/(getaa(\?|$)|img\/|images\/)/;

// Matches the ~3-4s device timeouts used elsewhere (DEVICE_CALL_TIMEOUT_MS,
// /status/zp). A speaker that can't produce a cover in 4s isn't going to.
const UPSTREAM_TIMEOUT_MS = 4000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
// Two at a time per speaker: they serialize getaa internally anyway, so
// more parallelism only queues inside the speaker where we can't
// prioritize it.
const PER_HOST_LIMIT = 2;
// A speaker that just timed out / refused a connection (asleep Roam,
// rebooting) isn't picked as a spill-over target for a while.
const HOST_FAIL_COOLDOWN_MS = 60 * 1000;
const SPILL_RECENT_OK_MS = 15 * 60 * 1000;

const MEMORY_MAX_BYTES = 40 * 1024 * 1024;
const DISK_MAX_BYTES = 300 * 1024 * 1024;
const DISK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// "Speaker has no art for this" is effectively permanent for a track;
// transient failures (timeout, 5xx) get a short memory so a flaky
// speaker isn't hammered but recovers quickly.
const NEGATIVE_404_MS = 30 * 60 * 1000;
const NEGATIVE_ERROR_MS = 30 * 1000;

const BROWSER_CACHE_HEADER = 'public, max-age=86400';

let getKnownHosts = () => [];
let dataRoot = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let diskDir = null;

// key -> { buf, type }. Map iteration order doubles as LRU order:
// a hit deletes + re-inserts, eviction takes from the front.
const memory = new Map();
let memoryBytes = 0;
// hash -> { file, size, mtimeMs } for what's on disk, so lookups and the
// warm-up's "already have it?" check never touch the filesystem.
const diskIndex = new Map();
let diskBytes = 0;
const negative = new Map(); // key -> expiry ms
const inflight = new Map(); // key -> { promise: Promise<{buf,type}|null>, ctl }

const stats = { mem: 0, disk: 0, local: 0, fetched: 0, missing: 0, failed: 0 };

// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------
function configure({ hostsProvider, dataDir }) {
  if (typeof hostsProvider === 'function') getKnownHosts = hostsProvider;
  if (dataDir) dataRoot = dataDir;
  // Separate from the scanner's artcache/ (local-library covers, named
  // by album-folder hash) so pruning here can never delete those.
  // The index is built in the background: on an Unraid user share (FUSE)
  // or a spun-down disk, stat-ing thousands of files can take seconds,
  // and startup shouldn't wait for it. Until it's done the disk cache is
  // simply off (diskDir stays null) and art comes from memory/speakers.
  const dir = path.join(dataRoot, 'artcache-remote');
  indexDiskCache(dir).then(() => {
    diskDir = dir;
    pruneDisk();
    debugLog.info('art', `Remote art disk cache: ${diskIndex.size} file(s), ${(diskBytes / 1048576).toFixed(1)} MB`);
  }).catch((err) => {
    debugLog.warn('art', `Remote art disk cache unavailable (memory only): ${err.message}`);
  });
}

async function indexDiskCache(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  for (const file of await fs.promises.readdir(dir)) {
    const full = path.join(dir, file);
    // Leftover from a write interrupted by a crash/restart.
    if (file.endsWith('.tmp')) { await fs.promises.unlink(full).catch(() => {}); continue; }
    const m = file.match(/^([a-f0-9]{40})\.(jpg|png|gif|webp)$/);
    if (!m) continue;
    const st = await fs.promises.stat(full).catch(() => null);
    if (!st) continue;
    const prev = diskIndex.get(m[1]);
    if (prev) {
      // Two types for one image: keep the newer, delete the other.
      const dropFile = prev.mtimeMs >= st.mtimeMs ? file : prev.file;
      await fs.promises.unlink(path.join(dir, dropFile)).catch(() => {});
      if (dropFile === file) continue;
      diskBytes -= prev.size;
    }
    diskIndex.set(m[1], { file, size: st.size, mtimeMs: st.mtimeMs });
    diskBytes += st.size;
  }
}

// ---------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------

// The sonos library absolutizes relative art as host + ':' + port + uri,
// so a relative path without a leading slash (Sonos returns
// "images/playlist_legacy.png" for some SoundCloud favorites) became
// "http://10.1.11.201:1400images/..." -- a URL no browser can load.
function repairSpeakerUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/^(http:\/\/[0-9.]+:1400)(?=[^/0-9])/, '$1/');
}

// Parses and validates a speaker art URL. Returns { host, key } where
// key is path+query (the cache key -- host-independent on purpose, see
// the header comment), or null if this isn't speaker art at all.
function parseSpeakerArt(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let u;
  try {
    u = new URL(repairSpeakerUrl(raw));
  } catch (err) {
    return null;
  }
  if (u.protocol !== 'http:' || u.port !== SPEAKER_PORT) return null;
  if (u.username || u.password) return null;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) return null;
  const key = u.pathname + u.search;
  if (!ART_PATH_RE.test(key)) return null;
  if (u.pathname === '/getaa' && !isAllowedGetaaTarget(u.searchParams.get('u'))) return null;
  return { host: u.hostname, key };
}

// getaa makes the SPEAKER fetch whatever its u= names and hand back the
// cover, so an unchecked u= would let /api/art relay requests to any
// host through a speaker. Sonos track URIs (x-sonos-http:, x-sonosapi-*:,
// x-file-cifs:, aac:, ...) are resolved by the speaker through its own
// services and can't name an arbitrary web host; plain http(s) is only
// allowed for our own Local Library stream URLs.
function isAllowedGetaaTarget(inner) {
  if (typeof inner !== 'string' || !inner) return false;
  const scheme = (inner.match(/^([a-z][a-z0-9+.-]*):/i) || [])[1];
  if (!scheme) return false;
  const s = scheme.toLowerCase();
  if (s === 'http' || s === 'https') {
    const base = localLibrary.getPublicBaseUrl();
    return !!base && inner.startsWith(`${base}/stream/`);
  }
  return s !== 'file' && s !== 'ftp' && s !== 'data' && s !== 'javascript';
}

function isKnownHost(host) {
  return getKnownHosts().includes(host);
}

// The ONE place speaker art becomes a proxy URL for clients. Anything
// that isn't speaker art on a known device (internet CDN art, our own
// /art/ URLs, null) passes through untouched.
function toClientUrl(url) {
  const parsed = parseSpeakerArt(url);
  if (!parsed || !isKnownHost(parsed.host)) return url;
  return `/api/art?u=${encodeURIComponent(`http://${parsed.host}:${SPEAKER_PORT}${parsed.key}`)}`;
}

// Hooked in as Express's 'json replacer', so every res.json() payload
// gets proxied art without any route knowing about it. A replacer (not
// an in-place rewrite) matters: the objects being serialized are often
// live cache entries (favorites, container items) that other server code
// later feeds back to the speakers in DIDL metadata -- those must keep
// the original, speaker-reachable URL.
function jsonReplacer(key, value) {
  // Cheap prefilter first: most art values (internet CDNs, our own
  // /art/ library URLs) can't be speaker art, and new URL() on a relative
  // path throws -- costly across a 200-row library page.
  if (key === 'albumArtUrl' && typeof value === 'string' && value.startsWith('http://') && value.includes(':1400')) {
    return toClientUrl(value);
  }
  return value;
}

// ---------------------------------------------------------------------
// Memory + disk cache
// ---------------------------------------------------------------------
function hashKey(key) {
  return crypto.createHash('sha1').update(key).digest('hex');
}

function extForType(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('png')) return 'png';
  if (t.includes('gif')) return 'gif';
  if (t.includes('webp')) return 'webp';
  return 'jpg';
}

const TYPE_FOR_EXT = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
// Only raster types are ever stored or served. Anything else -- SVG above
// all, which can carry script and would run on the panel's own origin
// (the API has no auth) -- is treated as "no image".
const ALLOWED_TYPES = new Set(Object.values(TYPE_FOR_EXT).concat('image/jpg', 'image/pjpeg'));
function safeImageType(raw) {
  const t = String(raw || '').split(';')[0].trim().toLowerCase();
  return ALLOWED_TYPES.has(t) ? TYPE_FOR_EXT[extForType(t)] : null;
}

// "No art" answers are remembered per URL; capped so junk URLs can't
// grow it forever (each key can be ~4 KB).
const NEGATIVE_MAX_ENTRIES = 5000;
// transient = the speaker failed (timeout, 5xx, redirect) rather than
// answering "no art" -- the browser must not cache that (see handleRequest).
function rememberMissing(key, ms, transient) {
  negative.delete(key); // re-insert at the back: insertion order = eviction order
  negative.set(key, { until: Date.now() + ms, transient: !!transient });
  if (negative.size <= NEGATIVE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, rec] of negative) if (rec.until <= now) negative.delete(k);
  for (const k of negative.keys()) {
    if (negative.size <= NEGATIVE_MAX_ENTRIES) break;
    negative.delete(k); // oldest first (insertion order)
  }
}
// More than this many images waiting for a speaker slot means something is
// requesting junk in bulk -- shed it rather than queue without limit.
const MAX_WAITERS = 300;

function memGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  memory.delete(key);
  memory.set(key, entry);
  return entry;
}

function memPut(key, entry) {
  if (entry.buf.length > MAX_IMAGE_BYTES) return;
  const old = memory.get(key);
  if (old) { memoryBytes -= old.buf.length; memory.delete(key); }
  memory.set(key, entry);
  memoryBytes += entry.buf.length;
  for (const [k, v] of memory) {
    if (memoryBytes <= MEMORY_MAX_BYTES) break;
    memory.delete(k);
    memoryBytes -= v.buf.length;
  }
}

function diskHas(key) {
  const rec = diskIndex.get(hashKey(key));
  return !!rec && Date.now() - rec.mtimeMs < DISK_MAX_AGE_MS;
}

async function diskGet(key) {
  if (!diskDir) return null;
  const hash = hashKey(key);
  const rec = diskIndex.get(hash);
  if (!rec || Date.now() - rec.mtimeMs >= DISK_MAX_AGE_MS) return null;
  try {
    const buf = await fs.promises.readFile(path.join(diskDir, rec.file));
    const ext = rec.file.split('.').pop();
    return { buf, type: TYPE_FOR_EXT[ext] || 'image/jpeg' };
  } catch (err) {
    diskIndex.delete(hash);
    diskBytes -= rec.size;
    return null;
  }
}

let writesSincePrune = 0;
function diskPut(key, entry) {
  if (!diskDir) return;
  const hash = hashKey(key);
  const file = `${hash}.${extForType(entry.type)}`;
  // Fire-and-forget: the response never waits on the disk. Written to a
  // temp name and renamed, so a crash mid-write can't leave a truncated
  // file that gets indexed and served for a month.
  const tmp = path.join(diskDir, `${file}.${process.pid}.${Date.now()}.tmp`);
  fs.promises.writeFile(tmp, entry.buf).then(() => fs.promises.rename(tmp, path.join(diskDir, file))).then(() => {
    const old = diskIndex.get(hash);
    if (old) {
      diskBytes -= old.size;
      // Same image came back as a different type: drop the other file,
      // or it would sit on disk uncounted and never be evicted.
      if (old.file !== file) fs.promises.unlink(path.join(diskDir, old.file)).catch(() => {});
    }
    diskIndex.set(hash, { file, size: entry.buf.length, mtimeMs: Date.now() });
    diskBytes += entry.buf.length;
    if (++writesSincePrune >= 100 || diskBytes > DISK_MAX_BYTES) { writesSincePrune = 0; pruneDisk(); }
  }).catch((err) => {
    fs.promises.unlink(tmp).catch(() => {});
    debugLog.warn('art', `could not write art cache file: ${err.message}`);
  });
}

// Oldest-written-first eviction, plus anything past max age. Once over
// the cap it trims to 90% so a full cache doesn't re-sort on every write.
function pruneDisk() {
  if (!diskDir) return;
  const now = Date.now();
  const target = diskBytes > DISK_MAX_BYTES ? DISK_MAX_BYTES * 0.9 : DISK_MAX_BYTES;
  const byAge = [...diskIndex.entries()].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  for (const [hash, rec] of byAge) {
    if (diskBytes <= target && now - rec.mtimeMs < DISK_MAX_AGE_MS) break;
    fs.promises.unlink(path.join(diskDir, rec.file)).catch(() => { /* already gone */ });
    diskIndex.delete(hash);
    diskBytes -= rec.size;
  }
}

// load() resolves to this (not null) when the speaker failed rather than
// said "no art", so the route can answer "try again" instead of 404.
const TRANSIENT = Object.freeze({ transient: true });

// Returns null (no record), or the TRANSIENT / missing outcome to report.
function negativeHit(key) {
  const rec = negative.get(key);
  if (!rec) return null;
  if (Date.now() < rec.until) return rec.transient ? TRANSIENT : 'missing';
  negative.delete(key);
  return null;
}

// ---------------------------------------------------------------------
// Per-speaker concurrency limiter with priority
// ---------------------------------------------------------------------
const hostState = new Map(); // host -> { active, failUntil }
const waiters = []; // { prefer, high, resolve } in arrival order

function stateFor(host) {
  let s = hostState.get(host);
  if (!s) { s = { active: 0, failUntil: 0, lastOkAt: 0 }; hostState.set(host, s); }
  return s;
}

// Interactive requests take their own speaker if it has a free slot,
// otherwise the least-busy healthy speaker. Background (warm-up)
// requests only ever use their own speaker, so the warm-up can't fan
// out across the house while music is playing.
function pickHost(waiter) {
  const own = stateFor(waiter.prefer);
  const ownHealthy = Date.now() >= own.failUntil;
  if (own.active < PER_HOST_LIMIT && (ownHealthy || !waiter.high)) return waiter.prefer;
  if (!waiter.high) return null;
  let best = null;
  let bestActive = PER_HOST_LIMIT;
  const now = Date.now();
  // Only speakers that served art recently: a sleeping Roam/Move is
  // still "known" but would just eat the 4 s timeout on a visible image.
  for (const host of getKnownHosts()) {
    if (host === waiter.prefer) continue;
    const s = stateFor(host);
    if (now - s.lastOkAt > SPILL_RECENT_OK_MS) continue;
    if (s.active < bestActive && now >= s.failUntil) { best = host; bestActive = s.active; }
  }
  if (best) return best;
  // Everything else busy or unhealthy: an unhealthy own speaker with a
  // free slot still beats waiting.
  return own.active < PER_HOST_LIMIT ? waiter.prefer : null;
}

function pump() {
  // High-priority waiters first, each group in arrival order.
  for (const wantHigh of [true, false]) {
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i];
      if (w.high !== wantHigh) continue;
      const host = pickHost(w);
      if (!host) continue;
      waiters.splice(i, 1);
      i--;
      stateFor(host).active++;
      w.resolve(host);
    }
  }
}

// ctl is a per-load object ({ high }) that becomes the queue entry
// itself, so a later interactive request for the same image can promote
// a queued background fetch in place (see load()).
function acquire(prefer, ctl) {
  return new Promise((resolve) => {
    ctl.prefer = prefer;
    ctl.resolve = resolve;
    waiters.push(ctl);
    pump();
  });
}

function release(host, unhealthy) {
  const s = stateFor(host);
  s.active = Math.max(0, s.active - 1);
  if (unhealthy) s.failUntil = Date.now() + HOST_FAIL_COOLDOWN_MS;
  pump();
}

// ---------------------------------------------------------------------
// Local-library shortcut: a getaa that wraps one of OUR OWN /stream/
// URLs makes the speaker download (part of) the audio file from us just
// to dig out the embedded cover. The scanner has usually already
// resolved that track's art, so serve it straight from disk.
// ---------------------------------------------------------------------
const EMBEDDED_FILE_RE = /^[a-f0-9]{40}\.(jpg|jpeg|png|gif|webp)$/;

async function localArtFor(key) {
  if (!key.startsWith('/getaa?')) return null;
  const inner = new URLSearchParams(key.slice('/getaa?'.length)).get('u');
  const base = localLibrary.getPublicBaseUrl();
  if (!inner || !base || !inner.startsWith(`${base}/stream/`)) return null;
  const db = localScanner.getDatabase();
  if (!db || !localLibrary.isEnabled()) return null;
  let rel;
  try {
    rel = decodeURIComponent(inner.slice(`${base}/stream/`.length).split('?')[0]);
  } catch (err) {
    return null;
  }
  let row;
  try {
    row = db.prepare('SELECT art FROM tracks WHERE path = ?').get(rel);
  } catch (err) {
    return null;
  }
  const art = row && row.art;
  if (!art) return null;
  let abs = null;
  if (art.startsWith('f:')) {
    abs = localLibrary.resolveSafe(art.slice(2));
    if (abs && !localLibrary.isImageFile(abs)) abs = null;
  } else if (art.startsWith('e:') && EMBEDDED_FILE_RE.test(art.slice(2))) {
    // Same folder the /art/embedded/ route serves from.
    abs = path.join(dataRoot, 'artcache', art.slice(2));
  }
  if (!abs) return null;
  try {
    const buf = await fs.promises.readFile(abs);
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    const type = safeImageType(localLibrary.imageContentTypeFor(abs));
    return type ? { buf, type } : null;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------
function sniffImageType(data) {
  const b = data ? Buffer.from(data) : null;
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function fetchFromSpeaker(host, key) {
  const res = await axios.get(`http://${host}:${SPEAKER_PORT}${key}`, {
    responseType: 'arraybuffer',
    // axios' timeout is an inactivity timer; the signal is the hard
    // deadline, so a speaker trickling bytes can't hold a slot forever.
    timeout: UPSTREAM_TIMEOUT_MS,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    maxContentLength: MAX_IMAGE_BYTES,
    maxRedirects: 0,
    validateStatus: () => true
  });
  // Some replies carry no or a generic content type (the browser used to
  // sniff those); recognise the raster formats by their first bytes.
  const type = safeImageType(res.headers['content-type']) || (res.status === 200 ? sniffImageType(res.data) : null);
  if (res.status === 200 && type && res.data && res.data.length > 0) {
    return { entry: { buf: Buffer.from(res.data), type } };
  }
  return { status: res.status };
}

// Resolves to {buf,type}, or null when there is no image. Concurrent
// callers for the same key share one fetch.
function load(key, prefer, high) {
  const hit = memGet(key);
  if (hit) { stats.mem++; return Promise.resolve(Object.assign({ source: 'mem' }, hit)); }
  const known = negativeHit(key);
  if (known) return Promise.resolve(known === TRANSIENT ? TRANSIENT : null);
  const pending = inflight.get(key);
  if (pending) {
    // Someone is looking at this image NOW while the warm-up has it
    // queued at background priority: promote it rather than wait.
    if (high && !pending.ctl.high) { pending.ctl.high = true; pump(); }
    return pending.promise;
  }

  const ctl = { high };
  const p = (async () => {
    const local = await localArtFor(key);
    if (local) { stats.local++; memPut(key, local); return Object.assign({ source: 'local' }, local); }
    const fromDisk = await diskGet(key);
    if (fromDisk) { stats.disk++; memPut(key, fromDisk); return Object.assign({ source: 'disk' }, fromDisk); }

    // One retry on a different speaker for network-level failures only
    // (a 404 is an answer, not a failure).
    let target = prefer;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const host = await acquire(target, ctl);
      let unhealthy = false;
      try {
        const result = await fetchFromSpeaker(host, key);
        stateFor(host).lastOkAt = Date.now(); // it answered (even a 404 means awake)
        if (result.entry) {
          stats.fetched++;
          memPut(key, result.entry);
          diskPut(key, result.entry);
          return Object.assign({ source: 'speaker' }, result.entry);
        }
        stats.missing++;
        // Only a clean "no image" answer (404, or 200 that isn't a raster
        // image) is real absence; 5xx/3xx/etc. are the speaker struggling.
        const absent = result.status === 404 || result.status === 200;
        rememberMissing(key, absent ? NEGATIVE_404_MS : NEGATIVE_ERROR_MS, !absent);
        return absent ? null : TRANSIENT;
      } catch (err) {
        unhealthy = true;
        target = pickRetryHost(host);
        if (attempt === 2 || !target) {
          stats.failed++;
          debugLog.warn('art', `art fetch failed from ${host}: ${err.message}`);
          rememberMissing(key, NEGATIVE_ERROR_MS, true);
          return TRANSIENT;
        }
      } finally {
        release(host, unhealthy);
      }
    }
    return null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, { promise: p, ctl });
  return p;
}

function pickRetryHost(exclude) {
  const now = Date.now();
  const hosts = getKnownHosts().filter((h) => h !== exclude && now >= stateFor(h).failUntil);
  if (hosts.length === 0) return null;
  return hosts.reduce((a, b) => (stateFor(a).active <= stateFor(b).active ? a : b));
}

// ---------------------------------------------------------------------
// Route: GET /api/art?u=<encoded speaker art URL>
// ---------------------------------------------------------------------
async function handleRequest(req, res) {
  const parsed = parseSpeakerArt(req.query.u);
  if (!parsed || !isKnownHost(parsed.host)) {
    return res.status(400).json({ error: 'Not a speaker art URL' });
  }
  // Belt and braces on top of the raster-only type check: never let the
  // browser sniff or run anything served from here.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (waiters.length >= MAX_WAITERS && !memory.has(parsed.key) && !inflight.has(parsed.key)) {
    res.setHeader('Retry-After', '5');
    return res.status(503).end();
  }
  try {
    const entry = await load(parsed.key, parsed.host, true);
    if (entry === TRANSIENT) {
      // Speaker hiccup (rebooting, busy, timed out): never let the
      // browser remember this, or tiles stay blank long after it recovers.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).end();
    }
    if (!entry) {
      // The panel shows art as CSS background-image, so a 404 simply
      // leaves the tile blank / falls through to the service icon.
      // Cached briefly by the browser too, so the same dead URL isn't
      // re-asked on every render.
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(404).end();
    }
    res.setHeader('Content-Type', entry.type);
    res.setHeader('Cache-Control', BROWSER_CACHE_HEADER);
    res.setHeader('X-Art-Cache', entry.source);
    return res.end(entry.buf);
  } catch (err) {
    debugLog.warn('art', `art proxy error: ${err.message}`);
    if (!res.headersSent) res.status(502).end();
  }
}

// ---------------------------------------------------------------------
// Background warm-up: fetch every speaker art URL we already know the
// UI will show (Favorites, Playlists and their tracks) at background
// priority, two at a time, so the first visit to those screens -- on any
// browser -- is all cache hits.
// ---------------------------------------------------------------------
async function warm(urls) {
  const started = Date.now();
  const seen = new Set();
  const todo = [];
  let already = 0;
  for (const url of urls) {
    const parsed = parseSpeakerArt(url);
    if (!parsed || !isKnownHost(parsed.host) || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    if (memory.has(parsed.key) || diskHas(parsed.key) || negativeHit(parsed.key)) { already++; continue; }
    todo.push(parsed);
  }
  let got = 0;
  let none = 0;
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const { key, host } = todo[next++];
      const entry = await load(key, host, false).catch(() => null);
      if (entry && entry.buf) got++; else none++;
    }
  }
  await Promise.all([worker(), worker()]);
  debugLog.info('art', `Art warm-up: ${seen.size} speaker image(s) -- ${already} already cached, ${got} fetched, ${none} unavailable, in ${Date.now() - started}ms`);
  return { total: seen.size, already, fetched: got, unavailable: none };
}

function getStats() {
  return {
    ...stats,
    memoryEntries: memory.size,
    memoryBytes,
    diskEntries: diskIndex.size,
    diskBytes,
    negativeEntries: negative.size,
    inflight: inflight.size,
    waiting: waiters.length
  };
}

module.exports = {
  configure,
  repairSpeakerUrl,
  toClientUrl,
  jsonReplacer,
  handleRequest,
  warm,
  getStats
};
