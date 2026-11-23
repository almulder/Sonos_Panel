// server/localPlaylists.js
//
// Local Playlists: the panel's own playlists, stored on the panel
// (DATA_DIR/playlists.db) instead of on the speakers. Sonos keeps its
// saved playlists in a small store on the speakers that fills up at a
// few thousand songs; these have no such limit, and they play through
// the same queue-fill path as Plex playlists.
//
// The playlists live in their own file, ATTACHed to the library index
// connection, so a rebuilt or deleted library.db never takes them with
// it -- while the track lists can still be a plain join on `tracks`.
//
// Entries are library files (by relative path) whenever the song is in
// the Local Music Library; anything else (a streaming-service song)
// keeps its Sonos uri + DIDL metadata so it can still be played.
//
// Container ids: L:LOCALPLAYLIST<SEP><id>; the list is L:LOCALPLAYLISTS.

const path = require('path');
const debugLog = require('./debugLog');

const SEP = '\u001f';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = 'playlists.db';

let db = null;
let trackItemFn = null;
let artUrlFn = null;

function init(database, helpers) {
  if (!database) {
    debugLog.warn('playlists', 'Local Playlists unavailable -- the Local Music Library index is not available (map "Music Path" in the template)');
    return false;
  }
  try {
    const attached = database.prepare('PRAGMA database_list').all().some((d) => d.name === 'pl');
    if (!attached) database.prepare('ATTACH DATABASE ? AS pl').run(path.join(DATA_DIR, FILE));
    database.exec(`
      CREATE TABLE IF NOT EXISTS pl.local_playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pl.local_playlist_tracks (
        entry INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        path TEXT,
        uri TEXT,
        title TEXT,
        artist TEXT,
        album TEXT,
        art_url TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS pl.idx_lpt_order ON local_playlist_tracks (playlist_id, position, entry);
    `);
  } catch (err) {
    debugLog.error('playlists', `Local Playlists could not open ${path.join(DATA_DIR, FILE)}: ${err.message}`);
    return false;
  }
  db = database;
  trackItemFn = helpers.trackItem;
  artUrlFn = helpers.artUrl;
  const n = db.prepare('SELECT COUNT(*) AS c FROM pl.local_playlists').get().c;
  debugLog.info('playlists', `Local Playlists ready (${n} playlist${n === 1 ? '' : 's'}) at ${path.join(DATA_DIR, FILE)}`);
  return true;
}

function isEnabled() {
  return !!db;
}

function requireDb() {
  if (!db) throw new Error('Local Playlists are not available (the Local Music Library is not set up)');
}

// Accepts the container id, or a bare number.
function parseId(id) {
  const s = String(id || '');
  const raw = s.startsWith('L:LOCALPLAYLIST') ? s.split(SEP)[1] : s;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Not a Local Playlist: ${s}`);
  return n;
}

function containerId(n) {
  return `L:LOCALPLAYLIST${SEP}${n}`;
}

// Rows that can still be shown: library files still in the index, or
// non-library entries (uri kept). Files that left the library drop out
// of view, the same as Plex playlists do.
const VISIBLE = '(lpt.path IS NULL OR t.path IS NOT NULL)';
const FROM = 'pl.local_playlist_tracks lpt LEFT JOIN tracks t ON t.path = lpt.path';

function list() {
  if (!db) return [];
  const rows = db.prepare(`
    SELECT p.id, p.title,
      (SELECT COUNT(*) FROM ${FROM} WHERE lpt.playlist_id = p.id AND ${VISIBLE}) AS songs,
      (SELECT COALESCE(t.art, '') || CHAR(31) || COALESCE(lpt.art_url, '') FROM ${FROM}
         WHERE lpt.playlist_id = p.id AND ${VISIBLE}
           AND ((t.art IS NOT NULL AND t.art <> '') OR (lpt.art_url IS NOT NULL AND lpt.art_url <> ''))
         ORDER BY lpt.position, lpt.entry LIMIT 1) AS art
    FROM pl.local_playlists p
    ORDER BY p.title COLLATE NOCASE
  `).all();
  return rows.map((r) => {
    let albumArtUrl = null;
    if (r.art) {
      const [libArt, extArt] = r.art.split(SEP);
      albumArtUrl = (libArt && artUrlFn(libArt)) || extArt || null;
    }
    return {
      id: containerId(r.id),
      title: r.title,
      artist: `${r.songs} song${r.songs === 1 ? '' : 's'}`,
      count: r.songs,
      browsable: true,
      albumArtUrl
    };
  });
}

function getTitle(id) {
  requireDb();
  const row = db.prepare('SELECT title FROM pl.local_playlists WHERE id = ?').get(parseId(id));
  return row ? row.title : null;
}

function create(title) {
  requireDb();
  const name = String(title || '').trim();
  if (!name) throw new Error('A playlist needs a name');
  const now = Date.now();
  const info = db.prepare('INSERT INTO pl.local_playlists (title, created_ms, updated_ms) VALUES (?, ?, ?)').run(name, now, now);
  debugLog.info('playlists', `Created Local Playlist "${name}"`);
  return { id: containerId(info.lastInsertRowid), title: name };
}

function rename(id, title) {
  requireDb();
  const name = String(title || '').trim();
  if (!name) throw new Error('A playlist needs a name');
  const n = parseId(id);
  const info = db.prepare('UPDATE pl.local_playlists SET title = ?, updated_ms = ? WHERE id = ?').run(name, Date.now(), n);
  if (info.changes === 0) throw new Error('That playlist no longer exists');
  return { id: containerId(n), title: name };
}

function remove(id) {
  requireDb();
  const n = parseId(id);
  const title = getTitle(n);
  db.transaction(() => {
    db.prepare('DELETE FROM pl.local_playlist_tracks WHERE playlist_id = ?').run(n);
    db.prepare('DELETE FROM pl.local_playlists WHERE id = ?').run(n);
  })();
  if (title) debugLog.info('playlists', `Deleted Local Playlist "${title}"`);
  return { ok: !!title };
}

// Library path for a panel stream/transcode URL, if it is one of ours.
function pathFromUri(uri) {
  const m = String(uri || '').match(/\/(stream|transcode)\/(.+)$/);
  if (!m) return null;
  let rel = m[2].split('?')[0];
  if (m[1] === 'transcode') rel = rel.replace(/\.flac$/i, '');
  try {
    return rel.split('/').map((seg) => decodeURIComponent(seg)).join('/');
  } catch (err) {
    return null;
  }
}

const getTrackByPath = () => db.prepare('SELECT path FROM tracks WHERE path = ?');

// items: [{ uri, metadata?, title?, artist?, album?, albumArtUrl? }]
// Library songs are stored by path; the rest keep uri + metadata.
function addItems(id, items) {
  requireDb();
  const n = parseId(id);
  if (!getTitle(n)) throw new Error('That playlist no longer exists');
  const byPath = getTrackByPath();
  const insert = db.prepare(`INSERT INTO pl.local_playlist_tracks
    (playlist_id, position, path, uri, title, artist, album, art_url, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  let skipped = 0;
  db.transaction(() => {
    let pos = (db.prepare('SELECT MAX(position) AS m FROM pl.local_playlist_tracks WHERE playlist_id = ?').get(n).m || 0) + 1;
    for (const it of items) {
      if (!it || !it.uri) { skipped += 1; continue; }
      const rel = pathFromUri(it.uri);
      if (rel && byPath.get(rel)) {
        insert.run(n, pos++, rel, null, null, null, null, null, null);
      } else if (rel) {
        skipped += 1; // a panel URL for a file the index no longer has
        continue;
      } else {
        insert.run(n, pos++, null, it.uri, it.title || null, it.artist || null, it.album || null, it.albumArtUrl || null, it.metadata || null);
      }
      added += 1;
    }
    db.prepare('UPDATE pl.local_playlists SET updated_ms = ? WHERE id = ?').run(Date.now(), n);
  })();
  return { added, skipped };
}

// Copies another list straight across in SQL -- how a 300,000-song Plex
// playlist gets added without paging it through the browse layer.
function addFromPlexPlaylist(id, plexId) {
  requireDb();
  const n = parseId(id);
  if (!getTitle(n)) throw new Error('That playlist no longer exists');
  let added = 0;
  db.transaction(() => {
    const base = db.prepare('SELECT MAX(position) AS m FROM pl.local_playlist_tracks WHERE playlist_id = ?').get(n).m || 0;
    added = db.prepare(`INSERT INTO pl.local_playlist_tracks (playlist_id, position, path)
      SELECT ?, ? + ROW_NUMBER() OVER (ORDER BY pt.position), pt.path
      FROM plex_playlist_tracks pt JOIN tracks t ON t.path = pt.path
      WHERE pt.playlist_id = ? ORDER BY pt.position`).run(n, base, plexId).changes;
    db.prepare('UPDATE pl.local_playlists SET updated_ms = ? WHERE id = ?').run(Date.now(), n);
  })();
  return { added, skipped: 0 };
}

function addFromLocalPlaylist(id, sourceId) {
  requireDb();
  const n = parseId(id);
  const src = parseId(sourceId);
  if (!getTitle(n)) throw new Error('That playlist no longer exists');
  let added = 0;
  db.transaction(() => {
    const base = db.prepare('SELECT MAX(position) AS m FROM pl.local_playlist_tracks WHERE playlist_id = ?').get(n).m || 0;
    const rows = db.prepare(`SELECT lpt.path, lpt.uri, lpt.title, lpt.artist, lpt.album, lpt.art_url, lpt.metadata
      FROM ${FROM} WHERE lpt.playlist_id = ? AND ${VISIBLE} ORDER BY lpt.position, lpt.entry`).all(src);
    const insert = db.prepare(`INSERT INTO pl.local_playlist_tracks
      (playlist_id, position, path, uri, title, artist, album, art_url, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((r, i) => insert.run(n, base + i + 1, r.path, r.uri, r.title, r.artist, r.album, r.art_url, r.metadata));
    added = rows.length;
    db.prepare('UPDATE pl.local_playlists SET updated_ms = ? WHERE id = ?').run(Date.now(), n);
  })();
  return { added, skipped: 0 };
}

// Removes the song shown at `index` (0-based, in playlist order).
function removeAt(id, index) {
  requireDb();
  const n = parseId(id);
  const row = db.prepare(`SELECT lpt.entry FROM ${FROM} WHERE lpt.playlist_id = ? AND ${VISIBLE}
    ORDER BY lpt.position, lpt.entry LIMIT 1 OFFSET ?`).get(n, Math.max(0, parseInt(index, 10) || 0));
  if (!row) return { removed: 0 };
  db.prepare('DELETE FROM pl.local_playlist_tracks WHERE entry = ?').run(row.entry);
  db.prepare('UPDATE pl.local_playlists SET updated_ms = ? WHERE id = ?').run(Date.now(), n);
  return { removed: 1 };
}

// One page of a playlist's songs, as browse items.
function tracksPage(id, start, limit) {
  if (!db) return { items: [], total: 0 };
  const n = parseId(id);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM ${FROM} WHERE lpt.playlist_id = ? AND ${VISIBLE}`).get(n).c;
  const rows = db.prepare(`
    SELECT lpt.entry, lpt.path AS lpath, lpt.uri, lpt.title AS ltitle, lpt.artist AS lartist, lpt.album AS lalbum,
           lpt.art_url, lpt.metadata,
           t.path, t.title, t.artist, t.album, t.duration_s, t.mime, t.art, t.transcode
    FROM ${FROM} WHERE lpt.playlist_id = ? AND ${VISIBLE}
    ORDER BY lpt.position, lpt.entry LIMIT ? OFFSET ?`).all(n, limit, start);
  const items = rows.map((r) => {
    if (r.lpath) return trackItemFn(r);
    return {
      id: `L:LOCALENTRY${SEP}${r.entry}`,
      title: r.ltitle || r.uri,
      browsable: false,
      uri: r.uri,
      artist: r.lartist || null,
      album: r.lalbum || null,
      albumArtUrl: r.art_url || null,
      metadata: r.metadata || ''
    };
  });
  return { items, total };
}

module.exports = {
  init,
  isEnabled,
  list,
  getTitle,
  create,
  rename,
  remove,
  addItems,
  addFromPlexPlaylist,
  addFromLocalPlaylist,
  removeAt,
  tracksPage,
  parseId,
  containerId,
  pathFromUri
};
