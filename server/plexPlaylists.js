// server/plexPlaylists.js
//
// Plex playlists in the Local Music Library (v0.20.0).
//
// WHAT: reads the music playlists on a Plex Media Server and shows them
// under Local Library -> Plex Playlists. Each Plex track is matched to
// the SAME FILE in this panel's own index, so playback goes through the
// panel's /stream/ route exactly like every other Local Library track --
// no Sonos 65,000-track index limit, no Sonos playlist size limit, and
// none of the UPnP 501s Sonos answers when Plex-service tracks are
// added to a Sonos playlist.
//
// Plex stays the master copy: playlists are edited in Plex, and this
// module mirrors them (read-only) at startup, after every library scan
// (so the RESCAN_SCHEDULE covers it), every SYNC_INTERVAL_MS, and when
// the Sources refresh button is tapped.
//
// REQUIREMENT: Plex must read the same music files that are mounted at
// the panel's Music Path. The folder names can differ -- Plex might see
// /data/music/Artist/Album/01.flac where the panel sees
// /music/Artist/Album/01.flac -- and the differing front part is worked
// out automatically (or set with PLEX_PATH_PREFIX). Tracks whose path
// can't be matched fall back to an artist + album + title match against
// the index; anything still unmatched is skipped and counted in the log.
//
// SETTINGS (env):
//   PLEX_URL          e.g. http://10.1.10.25:32400 -- blank = feature off
//   PLEX_TOKEN        the account's X-Plex-Token. Sent only as a request
//                     header, never logged and never put in a URL.
//   PLEX_PATH_PREFIX  optional: the folder Plex sees as the root of the
//                     panel's Music Path (e.g. /data/music). Blank =
//                     auto-detect.
//
// STORAGE: two tables in the Local Library's own library.db. They hold
// library-relative paths (the tracks table's primary key), so browsing
// a Plex playlist is a plain join -- see localBrowse.js PLEXPLAYLIST.

const axios = require('axios');
const debugLog = require('./debugLog');

const PLEX_URL = String(process.env.PLEX_URL || '').trim().replace(/\/+$/, '');
const PLEX_TOKEN = String(process.env.PLEX_TOKEN || '').trim();
// One folder, or several separated by ';' (a Plex library can span
// several folders).
const PLEX_PATH_PREFIXES = String(process.env.PLEX_PATH_PREFIX || '')
  .split(';')
  .map((p) => normalizePath(p.trim()).replace(/\/+$/, ''))
  .filter(Boolean);

const REQUEST_TIMEOUT_MS = 20000;
const ITEMS_PAGE_SIZE = 500;
// Picks up playlist edits made in Plex without anyone tapping refresh.
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
// How many unmatched track names make it into the log per sync -- enough
// to spot a path problem without flooding the log on a big mismatch.
const UNMATCHED_LOG_SAMPLE = 5;

let db = null;
let stmts = null;
let syncTimer = null;
let syncInFlight = null; // the running sync's promise, shared by callers
// Plex-side folders that map to the Music Path root, learned from
// tracks whose paths matched (or PLEX_PATH_PREFIX). A Plex music library
// often spans several folders, so every one found is kept (most
// recently matched first); kept across syncs.
const MAX_PREFIXES = 20;
const learnedPrefixes = [...PLEX_PATH_PREFIXES];

const state = {
  lastSync: null, // { finishedAt, playlists, tracks, matched, unmatched, durationSeconds }
  lastError: null
};

function isConfigured() {
  return !!(PLEX_URL && PLEX_TOKEN);
}

function isEnabled() {
  return isConfigured() && !!db;
}

// Plex on Windows reports D:\Music\..., everything else forward slashes.
function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

// ---------------------------------------------------------------------
// init -- needs the Local Library's open database (localScanner.init()
// must have succeeded). Without a Music Path there is nothing to match
// Plex tracks against, so the feature stays off with a log line.
// ---------------------------------------------------------------------
function init(database) {
  if (!isConfigured()) {
    if (PLEX_URL || PLEX_TOKEN) {
      debugLog.warn('plex', 'Plex playlists disabled -- both PLEX_URL and PLEX_TOKEN must be set');
    }
    return false;
  }
  if (!database) {
    debugLog.warn('plex', 'Plex playlists disabled -- they play through the Local Music Library, which is not available (map "Music Path" in the template)');
    return false;
  }
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS plex_playlists (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      smart INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      plex_count INTEGER NOT NULL DEFAULT 0,
      matched_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS plex_playlist_tracks (
      playlist_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (playlist_id, position)
    );
  `);
  // Tag lookups compare title exactly so they ride idx_tracks_title
  // (a NOCASE compare can't use it, and would scan the whole index once
  // per unmatched track). Plex reads the same tags, so case agrees.
  stmts = {
    trackByPath: db.prepare('SELECT path FROM tracks WHERE path = ?'),
    trackByTagsAlbum: db.prepare(`
      SELECT path, duration_s FROM tracks
      WHERE title = ? AND album = ? COLLATE NOCASE
        AND (album_artist = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
      LIMIT 5`),
    trackByTags: db.prepare(`
      SELECT path, duration_s FROM tracks
      WHERE title = ?
        AND (album_artist = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
      LIMIT 20`),
    clearPlaylists: db.prepare('DELETE FROM plex_playlists'),
    clearTracks: db.prepare('DELETE FROM plex_playlist_tracks'),
    insertPlaylist: db.prepare(`
      INSERT INTO plex_playlists (id, title, smart, position, plex_count, matched_count)
      VALUES (@id, @title, @smart, @position, @plex_count, @matched_count)`),
    insertTrack: db.prepare('INSERT INTO plex_playlist_tracks (playlist_id, position, path) VALUES (?, ?, ?)')
  };
  const existing = db.prepare('SELECT COUNT(*) AS c FROM plex_playlists').get().c;
  debugLog.info('plex', `Plex playlists enabled: ${PLEX_URL} (${existing} playlist(s) from the last sync; path prefix ${PLEX_PATH_PREFIXES.length ? `"${PLEX_PATH_PREFIXES.join('; ')}" (PLEX_PATH_PREFIX)` : 'auto-detect'})`);
  syncTimer = setInterval(() => { sync('interval').catch(() => {}); }, SYNC_INTERVAL_MS);
  if (syncTimer.unref) syncTimer.unref();
  return true;
}

// ---------------------------------------------------------------------
// Plex HTTP API
// ---------------------------------------------------------------------
async function plexGet(pathAndQuery, extraHeaders) {
  try {
    const res = await axios.get(`${PLEX_URL}${pathAndQuery}`, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': PLEX_TOKEN,
        'X-Plex-Product': 'Sonos Panel',
        'X-Plex-Client-Identifier': 'sonos-panel',
        ...extraHeaders
      }
    });
    return (res.data && res.data.MediaContainer) || {};
  } catch (err) {
    // Plain message only: axios errors carry the request config, which
    // includes the token header.
    const status = err.response ? err.response.status : null;
    if (status === 401) throw new Error('Plex rejected the token (401) -- check PLEX_TOKEN');
    throw new Error(status ? `Plex answered HTTP ${status} for ${pathAndQuery.split('?')[0]}` : `Could not reach Plex at ${PLEX_URL}: ${err.message}`);
  }
}

async function fetchPlaylists() {
  const mc = await plexGet('/playlists?playlistType=audio');
  return (mc.Metadata || [])
    .filter((p) => p.ratingKey && (p.playlistType === 'audio' || !p.playlistType))
    .map((p) => ({
      id: String(p.ratingKey),
      title: String(p.title || 'Untitled'),
      smart: p.smart === true || p.smart === 1 || p.smart === '1'
    }));
}

async function fetchPlaylistTracks(id) {
  const tracks = [];
  for (let start = 0; ; start += ITEMS_PAGE_SIZE) {
    const mc = await plexGet(
      `/playlists/${encodeURIComponent(id)}/items?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${ITEMS_PAGE_SIZE}`,
      { 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(ITEMS_PAGE_SIZE) }
    );
    const page = mc.Metadata || [];
    for (const t of page) {
      const media = (t.Media && t.Media[0]) || {};
      const part = (media.Part && media.Part[0]) || {};
      tracks.push({
        title: t.title || '',
        artist: t.originalTitle || t.grandparentTitle || '',
        albumArtist: t.grandparentTitle || '',
        album: t.parentTitle || '',
        durationSeconds: t.duration ? Math.round(Number(t.duration) / 1000) : 0,
        file: part.file ? normalizePath(part.file) : ''
      });
    }
    const total = Number(mc.totalSize != null ? mc.totalSize : mc.size);
    if (page.length === 0 || page.length < ITEMS_PAGE_SIZE || (Number.isFinite(total) && start + page.length >= total)) break;
  }
  return tracks;
}

// ---------------------------------------------------------------------
// Matching a Plex track to an indexed file
// ---------------------------------------------------------------------
function relUnderPrefix(file, prefix) {
  if (!prefix) return null;
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return file.toLowerCase().startsWith(p.toLowerCase()) ? file.slice(p.length) : null;
}

// Tries the known prefixes first, then every trailing part of the Plex
// path (longest first, at least folder/file) -- the first that exists
// in the index is the match, and the part in front of it is remembered
// as another known prefix.
function matchByPath(file) {
  if (!file) return null;
  for (let k = 0; k < learnedPrefixes.length; k++) {
    const known = relUnderPrefix(file, learnedPrefixes[k]);
    if (known && stmts.trackByPath.get(known)) {
      // Move to the front: tracks of one folder tend to come in runs.
      if (k > 0) learnedPrefixes.unshift(learnedPrefixes.splice(k, 1)[0]);
      return known;
    }
  }
  if (PLEX_PATH_PREFIXES.length) return null; // explicit prefixes: no guessing
  const segs = file.split('/').filter(Boolean);
  for (let i = 0; i <= segs.length - 2; i++) {
    const rel = segs.slice(i).join('/');
    if (stmts.trackByPath.get(rel)) {
      const prefix = `${file.startsWith('/') ? '/' : ''}${segs.slice(0, i).join('/')}`;
      if (!learnedPrefixes.includes(prefix)) {
        learnedPrefixes.unshift(prefix);
        if (learnedPrefixes.length > MAX_PREFIXES) learnedPrefixes.pop();
        debugLog.info('plex', `Plex folder "${prefix || '/'}" matches the panel's Music Path`);
      }
      return rel;
    }
  }
  return null;
}

// Closest duration wins among same-named candidates; with no duration
// to compare, only an unambiguous single hit counts.
function pickByDuration(rows, seconds) {
  if (rows.length === 1) return rows[0].path;
  if (!seconds) return null;
  let best = null;
  for (const r of rows) {
    const diff = Math.abs((r.duration_s || 0) - seconds);
    if (diff <= 3 && (!best || diff < best.diff)) best = { path: r.path, diff };
  }
  return best ? best.path : null;
}

function matchByTags(t) {
  if (!t.title) return null;
  const artists = [...new Set([t.artist, t.albumArtist].filter(Boolean))];
  for (const artist of artists) {
    if (t.album) {
      const hit = pickByDuration(stmts.trackByTagsAlbum.all(t.title, t.album, artist, artist), t.durationSeconds);
      if (hit) return hit;
    }
    const hit = pickByDuration(stmts.trackByTags.all(t.title, artist, artist), t.durationSeconds);
    if (hit) return hit;
  }
  return null;
}

function matchTrack(t) {
  return matchByPath(t.file) || matchByTags(t);
}

// ---------------------------------------------------------------------
// sync -- one at a time; a caller arriving mid-sync gets the same
// result. Writes happen in one transaction at the end, so a failed sync
// leaves the previous playlists in place rather than half of them.
// ---------------------------------------------------------------------
function sync(reason) {
  if (!isEnabled()) return Promise.resolve({ ok: false, error: 'Plex playlists are not enabled' });
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync(reason || 'manual')
    .catch((err) => {
      state.lastError = err.message;
      debugLog.warn('plex', `Plex playlist sync failed (${reason}): ${err.message}`);
      return { ok: false, error: err.message };
    })
    .finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function runSync(reason) {
  const startedMs = Date.now();
  const lists = await fetchPlaylists();
  const results = [];
  const unmatchedSample = [];
  let plexTracks = 0;
  let matched = 0;
  let pathMatches = 0;
  for (const list of lists) {
    const tracks = await fetchPlaylistTracks(list.id);
    const paths = [];
    for (const t of tracks) {
      const viaPath = matchByPath(t.file);
      const rel = viaPath || matchByTags(t);
      if (rel) {
        paths.push(rel);
        if (viaPath) pathMatches += 1;
      } else if (unmatchedSample.length < UNMATCHED_LOG_SAMPLE) {
        unmatchedSample.push(`"${t.title}" by ${t.artist || 'unknown'} (${list.title})`);
      }
    }
    plexTracks += tracks.length;
    matched += paths.length;
    results.push({ ...list, plexCount: tracks.length, paths });
  }

  db.transaction(() => {
    stmts.clearTracks.run();
    stmts.clearPlaylists.run();
    results.forEach((r, position) => {
      stmts.insertPlaylist.run({
        id: r.id, title: r.title, smart: r.smart ? 1 : 0, position,
        plex_count: r.plexCount, matched_count: r.paths.length
      });
      r.paths.forEach((p, i) => stmts.insertTrack.run(r.id, i, p));
    });
  })();

  const unmatched = plexTracks - matched;
  state.lastError = null;
  state.lastSync = {
    reason,
    finishedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedMs) / 1000),
    playlists: results.length,
    tracks: plexTracks,
    matched,
    unmatched
  };
  debugLog.info('plex', `Plex playlist sync (${reason}): ${results.length} playlist(s), ${matched} of ${plexTracks} track(s) matched (${pathMatches} by path, ${matched - pathMatches} by tags) in ${state.lastSync.durationSeconds}s`);
  if (unmatched > 0) {
    debugLog.warn('plex', `${unmatched} Plex track(s) had no matching file in the Music Path and were skipped, e.g. ${unmatchedSample.join('; ')}`);
    if (plexTracks > 0 && matched === 0) {
      debugLog.warn('plex', 'No Plex tracks matched at all -- Plex must read the same music files that are mounted as the Music Path. If it does, set PLEX_PATH_PREFIX to the folder Plex sees as the Music Path root.');
    }
  }
  return { ok: true, ...state.lastSync };
}

function getStatus() {
  return {
    configured: isConfigured(),
    enabled: isEnabled(),
    syncing: !!syncInFlight,
    lastSync: state.lastSync,
    lastError: state.lastError
  };
}

module.exports = {
  init,
  sync,
  isEnabled,
  getStatus,
  // exported for direct testing
  matchTrack,
  normalizePath
};
