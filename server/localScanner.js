// server/localScanner.js
//
// PHASE 2 of the Local Music Library -- the background scanner + index.
//
// Walks the music folder, reads each file's embedded tags with
// music-metadata, and builds a SQLite index at DATA_DIR/library.db --
// which lives in the appdata volume, so the index survives container
// updates. The speakers never see any of this (they just play /stream/
// URLs); the index exists so the PANEL can browse/search an unlimited
// number of tracks, which is the entire point of sidestepping Sonos's
// 65,000-song limit.
//
// Design decisions, all per real requirements:
//   - BATCHED commits (500 files per transaction): the library becomes
//     usable/playable while a scan is still running, without paying
//     per-file transaction overhead across 65k+ files.
//   - INCREMENTAL: a file whose mtime+size match its indexed row is
//     skipped without re-reading tags. First scan is the only slow one;
//     every later scan (including the automatic startup scan) is mostly
//     just stat() calls.
//   - STARTUP RESCAN: every container boot triggers a scan, so the
//     index can never silently drift from the folder after a reboot.
//   - SCHEDULED RESCANS via the RESCAN_SCHEDULE env (Unraid variable):
//     "daily@HH:MM" or "weekly@DAY@HH:MM" (DAY = mon..sun), evaluated
//     in the container's TZ. Blank = startup scans only. inotify-style
//     live watching is deliberately NOT used -- it does not propagate
//     reliably through Unraid's /mnt/user shfs layer.
//   - SONOS COMPATIBILITY FILTER: only files Sonos can actually play
//     get indexed. Everything else lands in an incompatible list (with
//     the reason kept in the DB) and is written to
//     DATA_DIR/incompatible-files.txt -- full path, one per line.
//
// Compatibility rules implemented (Sonos S2 published limits):
//   Lossy:    MP3/MP4/M4A/AAC/HE-AAC/OGG(Vorbis) up to 320 kbps,
//             WMA up to 355 kbps
//   Lossless: FLAC/ALAC up to 24-bit, AIFF/WAV up to 16-bit,
//             all lossless capped at 48 kHz sample rate -- that cap is
//             Sonos's own footnote to the bit-depth table, and it's
//             exactly what a real S2 speaker rejected during Phase 1
//             testing ("can't play due to the sample rate" on a hi-res
//             FLAC), so it's enforced here.

const fs = require('fs');
const path = require('path');
const debugLog = require('./debugLog');
const localLibrary = require('./localLibrary');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RESCAN_SCHEDULE_RAW = (process.env.RESCAN_SCHEDULE || '').trim();
const DB_FILENAME = 'library.db';
const INCOMPATIBLE_FILENAME = 'incompatible-files.txt';

// Commit cadence. 500 keeps transactions chunky enough to be fast over
// 65k+ files while making freshly scanned music browsable/playable in
// well under a minute of scan progress.
const BATCH_SIZE = 500;
// Tag parsing is I/O-bound (especially through the shfs/fuse layer), so
// a small amount of parallelism meaningfully shortens the first full
// scan without hammering the array.
const PARSE_CONCURRENCY = 4;

// Extensions worth even looking at. Superset of what can pass the
// compatibility check -- an .opus file, for instance, isn't in here at
// all because Sonos has no Opus support in any container.
const SCAN_EXTENSIONS = new Set([
  '.mp3', '.mp4', '.m4a', '.aac', '.wma', '.ogg', '.oga',
  '.flac', '.aif', '.aiff', '.wav'
]);

// ---------------------------------------------------------------------
// Compatibility evaluation. Pure function so it's directly testable.
// Takes the file extension and music-metadata's parsed `format` object;
// returns { ok: true } or { ok: false, reason }.
//
// Missing measurements err toward ACCEPTING the file: a lossy file
// whose bitrate couldn't be determined is far more likely a quirky rip
// than a >320kbps one, and wrongly hiding playable music is the worse
// failure. Hard limits (bit depth / sample rate on lossless) are only
// enforced when the parser actually reported the number.
// ---------------------------------------------------------------------
const KBPS = 1000;

function evaluateCompatibility(ext, format) {
  const f = format || {};
  const codec = String(f.codec || '');
  const codecUpper = codec.toUpperCase();
  const kbps = f.bitrate ? Math.round(f.bitrate / KBPS) : null;
  const bits = f.bitsPerSample || null;
  const rate = f.sampleRate || null;

  const lossyCap = (capKbps, label) => {
    if (kbps !== null && kbps > capKbps) {
      return { ok: false, reason: `${label} ${kbps} kbps exceeds Sonos limit (${capKbps} kbps)` };
    }
    return { ok: true };
  };
  const losslessCap = (capBits, label) => {
    if (bits !== null && bits > capBits) {
      return { ok: false, reason: `${label} ${bits}-bit exceeds Sonos limit (${capBits}-bit)` };
    }
    if (rate !== null && rate > 48000) {
      return { ok: false, reason: `${label} ${Math.round(rate / 100) / 10} kHz sample rate exceeds Sonos limit (48 kHz)` };
    }
    return { ok: true };
  };

  switch (ext) {
    case '.mp3':
      return lossyCap(320, 'MP3');
    case '.mp4':
    case '.m4a':
    case '.aac':
      // The MP4 family carries either AAC (lossy) or ALAC (lossless) --
      // the codec, not the extension, decides which rule applies.
      if (codecUpper.includes('ALAC')) return losslessCap(24, 'ALAC');
      if (codecUpper.includes('AAC') || codec === '') return lossyCap(320, 'AAC');
      return { ok: false, reason: `unsupported codec "${codec}" in ${ext} container` };
    case '.wma':
      if (codecUpper.includes('LOSSLESS')) {
        return { ok: false, reason: 'WMA Lossless is not supported by Sonos' };
      }
      return lossyCap(355, 'WMA');
    case '.ogg':
    case '.oga':
      if (codecUpper.includes('OPUS')) {
        return { ok: false, reason: 'Opus codec is not supported by Sonos' };
      }
      if (codecUpper.includes('VORBIS') || codec === '') return lossyCap(320, 'OGG');
      return { ok: false, reason: `unsupported codec "${codec}" in Ogg container` };
    case '.flac':
      return losslessCap(24, 'FLAC');
    case '.aif':
    case '.aiff':
      return losslessCap(16, 'AIFF');
    case '.wav':
      return losslessCap(16, 'WAV');
    default:
      return { ok: false, reason: `unsupported file type ${ext}` };
  }
}

// ---------------------------------------------------------------------
// Rescan schedule parsing: "daily@HH:MM" | "weekly@DAY@HH:MM" | "".
// Evaluated against the container's local time (set TZ for that to
// mean wall-clock time -- see the Unraid template / Dockerfile).
// ---------------------------------------------------------------------
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseSchedule(raw) {
  if (!raw) return null;
  const parts = raw.toLowerCase().split('@').map((p) => p.trim());
  const timePart = parts[parts.length - 1];
  const m = /^(\d{1,2}):(\d{2})$/.exec(timePart);
  if (!m) return { raw, valid: false };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return { raw, valid: false };
  if (parts.length === 2 && parts[0] === 'daily') {
    return { raw, valid: true, type: 'daily', hh, mm };
  }
  if (parts.length === 3 && parts[0] === 'weekly') {
    const day = parts[1].slice(0, 3);
    if (!(day in DOW)) return { raw, valid: false };
    return { raw, valid: true, type: 'weekly', dow: DOW[day], hh, mm };
  }
  return { raw, valid: false };
}

function describeSchedule(sched) {
  if (!sched) return 'startup scans only (RESCAN_SCHEDULE not set)';
  if (!sched.valid) return `INVALID ("${sched.raw}") -- expected daily@HH:MM or weekly@DAY@HH:MM; startup scans only`;
  const t = `${String(sched.hh).padStart(2, '0')}:${String(sched.mm).padStart(2, '0')}`;
  if (sched.type === 'daily') return `daily at ${t}`;
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `weekly on ${names[sched.dow]} at ${t}`;
}

// ---------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------
let db = null;
let stmts = null;
let onProgressCb = null;
let unavailableReason = 'not initialized';
let schedule = null;
let scheduleTimer = null;
let lastScheduleSlot = '';
// Throttle for the periodic progress LOG line (WebSocket progress is
// separate and fires per batch) -- exists because a first full scan of
// a big library over the fuse layer can run for an hour+, and a log
// that says nothing between "Scan starting" and "Scan complete" is
// indistinguishable from a hang.
const PROGRESS_LOG_INTERVAL_MS = 30000;
let lastProgressLogMs = 0;

const scanState = {
  state: 'idle', // 'idle' | 'enumerating' | 'scanning'
  reason: null,
  startedAt: null,
  total: 0,
  processed: 0,
  indexed: 0,
  incompatible: 0,
  skippedUnchanged: 0,
  batches: 0,
  lastScan: null,
  lastError: null
};

function emitProgress(extra) {
  if (!onProgressCb) return;
  try {
    onProgressCb({
      state: scanState.state,
      reason: scanState.reason,
      total: scanState.total,
      processed: scanState.processed,
      indexed: scanState.indexed,
      incompatible: scanState.incompatible,
      skippedUnchanged: scanState.skippedUnchanged,
      batches: scanState.batches,
      lastScan: scanState.lastScan,
      ...extra
    });
  } catch (err) {
    debugLog.warn('scanner', `progress callback failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// init -- open/create the DB, prepare statements, start the scheduler.
// Returns true when the scanner is usable. Degrades gracefully (with a
// logged reason) rather than taking the panel down: the panel's core
// Sonos features owe nothing to this module.
// ---------------------------------------------------------------------
function init(options) {
  onProgressCb = (options && options.onProgress) || null;
  if (!localLibrary.isEnabled()) {
    unavailableReason = 'Local Music Library is not enabled (no Music Path mounted)';
    return false;
  }
  let Database;
  try {
    // eslint-disable-next-line global-require
    Database = require('better-sqlite3');
  } catch (err) {
    unavailableReason = `better-sqlite3 unavailable: ${err.message}`;
    debugLog.error('scanner', unavailableReason);
    return false;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(path.join(DATA_DIR, DB_FILENAME));
    // WAL so status/browse reads stay snappy while a scan is writing.
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        title TEXT, artist TEXT, album_artist TEXT, album TEXT,
        composer TEXT, genre TEXT,
        track_no INTEGER, disc_no INTEGER, year INTEGER,
        duration_s INTEGER, mime TEXT, embedded_art INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
      CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(album_artist);
      CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
      CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
      CREATE INDEX IF NOT EXISTS idx_tracks_composer ON tracks(composer);
      CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
      CREATE TABLE IF NOT EXISTS incompatible (
        path TEXT PRIMARY KEY,
        reason TEXT,
        generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    stmts = {
      getTrack: db.prepare('SELECT mtime_ms, size FROM tracks WHERE path = ?'),
      touchTrack: db.prepare('UPDATE tracks SET generation = ? WHERE path = ?'),
      upsertTrack: db.prepare(`
        INSERT INTO tracks (path, mtime_ms, size, generation, title, artist, album_artist, album,
                            composer, genre, track_no, disc_no, year, duration_s, mime, embedded_art)
        VALUES (@path, @mtime_ms, @size, @generation, @title, @artist, @album_artist, @album,
                @composer, @genre, @track_no, @disc_no, @year, @duration_s, @mime, @embedded_art)
        ON CONFLICT(path) DO UPDATE SET
          mtime_ms=excluded.mtime_ms, size=excluded.size, generation=excluded.generation,
          title=excluded.title, artist=excluded.artist, album_artist=excluded.album_artist,
          album=excluded.album, composer=excluded.composer, genre=excluded.genre,
          track_no=excluded.track_no, disc_no=excluded.disc_no, year=excluded.year,
          duration_s=excluded.duration_s, mime=excluded.mime, embedded_art=excluded.embedded_art
      `),
      getIncompatible: null,
      upsertIncompatible: db.prepare(`
        INSERT INTO incompatible (path, reason, generation) VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET reason=excluded.reason, generation=excluded.generation
      `),
      deleteStaleTracks: db.prepare('DELETE FROM tracks WHERE generation <> ?'),
      deleteStaleIncompatible: db.prepare('DELETE FROM incompatible WHERE generation <> ?'),
      countTracks: db.prepare('SELECT COUNT(*) AS c FROM tracks'),
      countIncompatible: db.prepare('SELECT COUNT(*) AS c FROM incompatible'),
      listIncompatible: db.prepare('SELECT path, reason FROM incompatible ORDER BY path'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    };
    const lastScanRow = stmts.getMeta.get('lastScan');
    if (lastScanRow) {
      try { scanState.lastScan = JSON.parse(lastScanRow.value); } catch (err) { /* ignore */ }
    }
  } catch (err) {
    unavailableReason = `could not open library database: ${err.message}`;
    debugLog.error('scanner', unavailableReason);
    db = null;
    return false;
  }
  unavailableReason = null;
  schedule = parseSchedule(RESCAN_SCHEDULE_RAW);
  if (schedule && !schedule.valid) {
    debugLog.warn('scanner', `RESCAN_SCHEDULE "${RESCAN_SCHEDULE_RAW}" is invalid -- expected daily@HH:MM or weekly@DAY@HH:MM. Falling back to startup scans only.`);
  }
  debugLog.info('scanner', `Library index ready at ${path.join(DATA_DIR, DB_FILENAME)} (${stmts.countTracks.get().c} tracks indexed). Rescan schedule: ${describeSchedule(schedule)}.`);
  startScheduleTicker();
  return true;
}

function startScheduleTicker() {
  if (scheduleTimer || !schedule || !schedule.valid) return;
  scheduleTimer = setInterval(() => {
    const now = new Date();
    if (now.getHours() !== schedule.hh || now.getMinutes() !== schedule.mm) return;
    if (schedule.type === 'weekly' && now.getDay() !== schedule.dow) return;
    // One trigger per matching minute, even across the ~2 ticks that
    // land inside it.
    const slot = `${schedule.raw}|${now.toDateString()} ${schedule.hh}:${schedule.mm}`;
    if (slot === lastScheduleSlot) return;
    lastScheduleSlot = slot;
    debugLog.info('scanner', `Scheduled rescan triggered (${describeSchedule(schedule)})`);
    startScan('scheduled');
  }, 30000);
}

// ---------------------------------------------------------------------
// Filesystem walk -- enumerate first (so progress has a real total),
// then process. Hidden files/dirs skipped, same as the browse listing.
// ---------------------------------------------------------------------
async function enumerateFiles() {
  const root = path.resolve(localLibrary.MUSIC_DIR);
  const found = [];
  const dirs = [''];
  while (dirs.length > 0) {
    const relDir = dirs.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch (err) {
      debugLog.warn('scanner', `cannot read directory "${relDir}": ${err.message}`);
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        dirs.push(rel);
      } else if (ent.isFile() && SCAN_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) {
        found.push(rel);
        if (found.length % 5000 === 0) {
          emitProgress({ state: 'enumerating', total: found.length });
        }
        if (found.length % 10000 === 0) {
          debugLog.info('scanner', `Enumerating: ${found.length} files found so far...`);
        }
      }
    }
  }
  return found;
}

// Pending writes accumulated between batch commits. Each entry is
// {kind: 'track'|'touch'|'incompatible', ...payload}.
let pendingOps = [];

function commitBatch(generation, force) {
  if (pendingOps.length === 0) return;
  if (!force && pendingOps.length < BATCH_SIZE) return;
  const ops = pendingOps;
  pendingOps = [];
  const txn = db.transaction((batch) => {
    for (const op of batch) {
      if (op.kind === 'track') stmts.upsertTrack.run(op.row);
      else if (op.kind === 'touch') stmts.touchTrack.run(generation, op.path);
      else if (op.kind === 'incompatible') stmts.upsertIncompatible.run(op.path, op.reason, generation);
    }
  });
  txn(ops);
  scanState.batches += 1;
  emitProgress({});
}

function firstOrJoin(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('; ') || null;
  return value || null;
}

async function processFile(rel, generation, mm) {
  const abs = path.join(path.resolve(localLibrary.MUSIC_DIR), rel);
  let stat;
  try {
    stat = await fs.promises.stat(abs);
  } catch (err) {
    return; // vanished mid-scan; the stale sweep will handle its row
  }
  const existing = stmts.getTrack.get(rel);
  if (existing && existing.mtime_ms === Math.round(stat.mtimeMs) && existing.size === stat.size) {
    scanState.skippedUnchanged += 1;
    pendingOps.push({ kind: 'touch', path: rel });
    return;
  }
  const ext = path.extname(rel).toLowerCase();
  let meta = null;
  let verdict;
  try {
    meta = await mm.parseFile(abs, { duration: true });
    verdict = evaluateCompatibility(ext, meta.format);
  } catch (err) {
    verdict = { ok: false, reason: `unreadable (${err.message})` };
  }
  if (!verdict.ok) {
    scanState.incompatible += 1;
    pendingOps.push({ kind: 'incompatible', path: rel, reason: verdict.reason });
    return;
  }
  const common = (meta && meta.common) || {};
  const format = (meta && meta.format) || {};
  const guessed = localLibrary.describeTrack(rel);
  scanState.indexed += 1;
  pendingOps.push({
    kind: 'track',
    row: {
      path: rel,
      mtime_ms: Math.round(stat.mtimeMs),
      size: stat.size,
      generation,
      title: common.title || guessed.title,
      artist: firstOrJoin(common.artist) || guessed.artist || null,
      album_artist: firstOrJoin(common.albumartist) || firstOrJoin(common.artist) || guessed.artist || null,
      album: common.album || guessed.album || null,
      composer: firstOrJoin(common.composer),
      genre: firstOrJoin(common.genre),
      track_no: (common.track && common.track.no) || null,
      disc_no: (common.disk && common.disk.no) || null,
      year: common.year || null,
      duration_s: Math.round((format.duration) || 0),
      mime: localLibrary.contentTypeFor(rel),
      embedded_art: common.picture && common.picture.length > 0 ? 1 : 0
    }
  });
}

function writeIncompatibleFile() {
  // Full container path, one per line, exactly as requested. /music/...
  // maps 1:1 onto whatever host folder the Music Path points at, so
  // translating a line back to the share is a straight prefix swap.
  const rows = stmts.listIncompatible.all();
  const lines = rows.map((r) => path.join(path.resolve(localLibrary.MUSIC_DIR), r.path)).join('\n');
  const target = path.join(DATA_DIR, INCOMPATIBLE_FILENAME);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, lines.length ? `${lines}\n` : '');
  fs.renameSync(tmp, target);
  debugLog.info('scanner', `${rows.length} incompatible file(s) listed in ${target}`);
}

// ---------------------------------------------------------------------
// startScan -- kicks off a scan in the background and returns
// immediately. Only one scan runs at a time.
// ---------------------------------------------------------------------
function startScan(reason) {
  if (!db) return { ok: false, error: unavailableReason || 'scanner unavailable' };
  if (scanState.state !== 'idle') return { ok: false, alreadyScanning: true };
  scanState.state = 'enumerating';
  scanState.reason = reason || 'manual';
  scanState.startedAt = new Date().toISOString();
  scanState.total = 0;
  scanState.processed = 0;
  scanState.indexed = 0;
  scanState.incompatible = 0;
  scanState.skippedUnchanged = 0;
  scanState.batches = 0;
  scanState.lastError = null;
  runScan().catch((err) => {
    scanState.lastError = err.message;
    scanState.state = 'idle';
    debugLog.error('scanner', `scan failed: ${err.message}`);
    emitProgress({});
  });
  return { ok: true, started: true, reason: scanState.reason };
}

async function runScan() {
  const startedMs = Date.now();
  debugLog.info('scanner', `Scan starting (${scanState.reason})...`);
  emitProgress({});
  // Dynamic require keeps module load order flexible; music-metadata is
  // already a hard dependency via localLibrary's duration parsing.
  // eslint-disable-next-line global-require
  const mm = require('music-metadata');
  const generation = Date.now();

  const enumerateStartMs = Date.now();
  const files = await enumerateFiles();
  scanState.total = files.length;
  scanState.state = 'scanning';
  debugLog.info('scanner', `Enumerated ${files.length} candidate file(s) in ${Math.round((Date.now() - enumerateStartMs) / 1000)}s; scanning with concurrency ${PARSE_CONCURRENCY}...`);
  lastProgressLogMs = Date.now();
  emitProgress({});

  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= files.length) return;
      await processFile(files[i], generation, mm);
      scanState.processed += 1;
      commitBatch(generation, false);
      if (Date.now() - lastProgressLogMs >= PROGRESS_LOG_INTERVAL_MS) {
        lastProgressLogMs = Date.now();
        const pct = scanState.total ? Math.round((scanState.processed / scanState.total) * 100) : 0;
        debugLog.info('scanner', `Scan progress: ${scanState.processed}/${scanState.total} (${pct}%) -- ${scanState.indexed} indexed/updated, ${scanState.incompatible} incompatible, ${scanState.skippedUnchanged} unchanged`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, () => worker()));
  commitBatch(generation, true);

  const removedTracks = stmts.deleteStaleTracks.run(generation).changes;
  const removedIncompatible = stmts.deleteStaleIncompatible.run(generation).changes;
  writeIncompatibleFile();

  scanState.lastScan = {
    finishedAt: new Date().toISOString(),
    reason: scanState.reason,
    durationSeconds: Math.round((Date.now() - startedMs) / 1000),
    filesSeen: files.length,
    indexedOrUpdated: scanState.indexed,
    skippedUnchanged: scanState.skippedUnchanged,
    incompatible: stmts.countIncompatible.get().c,
    removed: removedTracks + removedIncompatible,
    totalTracksInLibrary: stmts.countTracks.get().c
  };
  stmts.setMeta.run('lastScan', JSON.stringify(scanState.lastScan));
  scanState.state = 'idle';
  scanState.reason = null;
  debugLog.info('scanner', `Scan complete in ${scanState.lastScan.durationSeconds}s: ${scanState.lastScan.totalTracksInLibrary} tracks indexed, ${scanState.lastScan.incompatible} incompatible, ${scanState.lastScan.skippedUnchanged} unchanged, ${scanState.lastScan.removed} removed.`);
  emitProgress({});
}

// ---------------------------------------------------------------------
// Read APIs
// ---------------------------------------------------------------------
function isAvailable() {
  return !!db;
}

function getStatus() {
  if (!db) {
    return { available: false, reason: unavailableReason, schedule: describeSchedule(schedule) };
  }
  return {
    available: true,
    state: scanState.state,
    reason: scanState.reason,
    startedAt: scanState.startedAt,
    total: scanState.total,
    processed: scanState.processed,
    indexed: scanState.indexed,
    incompatible: scanState.incompatible,
    skippedUnchanged: scanState.skippedUnchanged,
    batches: scanState.batches,
    lastError: scanState.lastError,
    lastScan: scanState.lastScan,
    counts: {
      tracks: stmts.countTracks.get().c,
      incompatible: stmts.countIncompatible.get().c
    },
    schedule: describeSchedule(schedule),
    incompatibleListFile: path.join(DATA_DIR, INCOMPATIBLE_FILENAME)
  };
}

function getIncompatibleList() {
  if (!db) return [];
  return stmts.listIncompatible.all().map((r) => ({
    path: path.join(path.resolve(localLibrary.MUSIC_DIR), r.path),
    reason: r.reason
  }));
}

module.exports = {
  init,
  startScan,
  getStatus,
  getIncompatibleList,
  isAvailable,
  // exported for direct testing
  evaluateCompatibility,
  parseSchedule,
  describeSchedule
};
