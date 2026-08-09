// server/localBrowse.js
//
// PHASE 3 of the Local Music Library -- browsing the index.
//
// Presents the SQLite index as a tree of VIRTUAL CONTAINERS in an "L:"
// ID namespace, shaped exactly like the ContentDirectory items the
// panel's existing Music Library browser already renders. sonos.js
// intercepts any "L:" container ID at the top of browseContainerPaged
// and routes it here, which means every existing consumer works on
// local content for free: the browsing UI (with its Load More paging),
// category search (the client browses "<category>:<term>", same as
// Sonos), tap-to-play-with-album-context (play-playlist-track browses
// the container and queues it), now-playing metadata recovery, and the
// add-to-playlist buttons.
//
// ID GRAMMAR (SEP = U+001F unit separator, chosen because it survives
// URL encoding and never appears in real tag data):
//   L:                          root categories (via getCategories())
//   L:ARTISTS                   artist index (letter buckets when big)
//   L:ARTISTS<SEP>B             artists starting with B
//   L:ARTISTS:term              artist search (client-built, Sonos style)
//   L:ARTIST<SEP>name           one artist's albums
//   L:ALBUMS / <SEP>B / :term   album index, same pattern
//   L:ALBUM<SEP>artist<SEP>alb  one album's tracks (leaf items)
//   L:TRACKS / <SEP>B / :term   song index (always bucketed -- 160k+)
//   L:GENRES / :term            genres (flat), L:GENRE<SEP>g -> albums
//   L:COMPOSERS / <SEP>B /:term composers, L:COMPOSER<SEP>c -> tracks
//   L:FOLDERS, L:FOLDER<SEP>rel folder tree, derived from indexed paths
//
// Every leaf track item carries a ready-made DIDL `metadata` string
// (with <res duration>), so whichever play path picks it up hands the
// speaker complete information.

const path = require('path');
const debugLog = require('./debugLog');
const localLibrary = require('./localLibrary');
const localScanner = require('./localScanner');

const SEP = '\u001f';
// Indexes bigger than this split into A-Z/# letter buckets instead of a
// flat list. Overridable for testing/tuning.
const BUCKET_THRESHOLD = Number(process.env.LOCAL_BUCKET_THRESHOLD) || 300;
const PAGE_LIMIT = 200;

// Prepared-statement cache keyed by SQL text -- better-sqlite3 prepare
// is cheap but not free, and the browse queries repeat constantly.
const stmtCache = new Map();
function prep(sql) {
  const db = localScanner.getDatabase();
  if (!db) return null;
  let st = stmtCache.get(sql);
  if (!st) {
    st = db.prepare(sql);
    stmtCache.set(sql, st);
  }
  return st;
}

function available() {
  return !!localScanner.getDatabase();
}

// LIKE pattern with user input made literal.
function likePattern(term) {
  return `%${String(term).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

// ---------------------------------------------------------------------
// Item builders -- all output matches the shape mapDidlNode gives the
// client: {id, title, albumArtUrl, browsable, uri, artist?, metadata?}
// ---------------------------------------------------------------------
function folderArtUrlFor(relPath) {
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const artRel = localLibrary.findFolderArt(dir);
  return artRel ? localLibrary.buildArtUri(artRel) : null;
}

function trackItem(row) {
  const uri = localLibrary.buildStreamUri(row.path);
  const albumArtUrl = folderArtUrlFor(row.path);
  return {
    id: `L:TRACK${SEP}${row.path}`,
    title: row.title || row.path,
    browsable: false,
    uri,
    artist: row.artist || null,
    album: row.album || null,
    albumArtUrl,
    metadata: localLibrary.buildTrackDidl({
      uri,
      title: row.title,
      artist: row.artist,
      album: row.album,
      albumArtUrl,
      durationSeconds: row.duration_s || 0,
      mime: row.mime
    })
  };
}

function albumItem(artist, album, samplePath) {
  return {
    id: `L:ALBUM${SEP}${artist}${SEP}${album}`,
    title: album,
    artist: artist || null,
    browsable: true,
    albumArtUrl: samplePath ? folderArtUrlFor(samplePath) : null
  };
}

function letterBucketItems(prefix, letters) {
  return letters.map((l) => ({ id: `${prefix}${SEP}${l.letter}`, title: l.letter, browsable: true }));
}

// Letter distribution for a column, folded so anything outside A-Z
// (digits, punctuation, diacritics) lands in the '#' bucket -- matched
// by the same NOT BETWEEN condition the per-letter queries use.
function letterDistribution(column) {
  const st = prep(`
    SELECT upper(substr(trim(COALESCE(${column}, '')), 1, 1)) AS letter,
           COUNT(DISTINCT COALESCE(${column}, '')) AS c
    FROM tracks GROUP BY letter
  `);
  const buckets = new Map();
  for (const row of st.all()) {
    const key = /^[A-Z]$/.test(row.letter || '') ? row.letter : '#';
    buckets.set(key, (buckets.get(key) || 0) + row.c);
  }
  const order = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
  return order.filter((l) => buckets.has(l)).map((l) => ({ letter: l, count: buckets.get(l) }));
}

function letterCondition(column, letter) {
  if (letter === '#') {
    return `upper(substr(trim(COALESCE(${column}, '')), 1, 1)) NOT BETWEEN 'A' AND 'Z'`;
  }
  return `upper(substr(trim(COALESCE(${column}, '')), 1, 1)) = '${letter}'`;
}

function page(items, total, start) {
  return { items, total, start };
}

// Runs a COUNT + a LIMIT/OFFSET pair for simple list queries.
function pagedQuery(countSql, listSql, params, start, limit, mapRow) {
  const total = prep(countSql).get(...params).c;
  const rows = prep(listSql).all(...params, limit, start);
  return page(rows.map(mapRow), total, start);
}

// ---------------------------------------------------------------------
// Category roots
// ---------------------------------------------------------------------
function getCategories() {
  if (!available()) return [];
  const trackCount = prep('SELECT COUNT(*) AS c FROM tracks').get().c;
  if (trackCount === 0) return [];
  const categories = [
    { id: 'L:ARTISTS', title: 'Artists' },
    { id: 'L:ALBUMS', title: 'Albums' }
  ];
  const genreCount = prep("SELECT COUNT(*) AS c FROM tracks WHERE genre IS NOT NULL AND genre <> ''").get().c;
  if (genreCount > 0) categories.push({ id: 'L:GENRES', title: 'Genres' });
  const composerCount = prep("SELECT COUNT(*) AS c FROM tracks WHERE composer IS NOT NULL AND composer <> ''").get().c;
  if (composerCount > 0) categories.push({ id: 'L:COMPOSERS', title: 'Composers' });
  categories.push({ id: 'L:TRACKS', title: 'Songs' });
  categories.push({ id: 'L:FOLDERS', title: 'Folders' });
  return categories;
}

// ---------------------------------------------------------------------
// Per-category listers
// ---------------------------------------------------------------------
function listArtists(where, params, start, limit) {
  return pagedQuery(
    `SELECT COUNT(DISTINCT COALESCE(album_artist, '')) AS c FROM tracks ${where}`,
    `SELECT COALESCE(album_artist, '') AS artist, MIN(path) AS sample
     FROM tracks ${where} GROUP BY COALESCE(album_artist, '')
     ORDER BY artist COLLATE NOCASE LIMIT ? OFFSET ?`,
    params, start, limit,
    (r) => ({
      id: `L:ARTIST${SEP}${r.artist}`,
      title: r.artist || 'Unknown Artist',
      browsable: true,
      albumArtUrl: r.sample ? folderArtUrlFor(r.sample) : null
    })
  );
}

function listAlbums(where, params, start, limit) {
  return pagedQuery(
    `SELECT COUNT(*) AS c FROM (SELECT 1 FROM tracks ${where} GROUP BY COALESCE(album_artist, ''), COALESCE(album, ''))`,
    `SELECT COALESCE(album_artist, '') AS artist, COALESCE(album, '') AS album, MIN(path) AS sample
     FROM tracks ${where} GROUP BY COALESCE(album_artist, ''), COALESCE(album, '')
     ORDER BY album COLLATE NOCASE, artist COLLATE NOCASE LIMIT ? OFFSET ?`,
    params, start, limit,
    (r) => albumItem(r.artist, r.album || 'Unknown Album', r.sample)
  );
}

function listTracks(where, params, orderBy, start, limit) {
  return pagedQuery(
    `SELECT COUNT(*) AS c FROM tracks ${where}`,
    `SELECT path, title, artist, album, duration_s, mime FROM tracks ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    params, start, limit, trackItem
  );
}

function artistAlbums(artist, start, limit) {
  return pagedQuery(
    `SELECT COUNT(*) AS c FROM (SELECT 1 FROM tracks WHERE COALESCE(album_artist, '') = ? GROUP BY COALESCE(album, ''))`,
    `SELECT COALESCE(album, '') AS album, MIN(path) AS sample, MIN(year) AS year
     FROM tracks WHERE COALESCE(album_artist, '') = ? GROUP BY COALESCE(album, '')
     ORDER BY year IS NULL, year, album COLLATE NOCASE LIMIT ? OFFSET ?`,
    [artist], start, limit,
    (r) => albumItem(artist, r.album || 'Unknown Album', r.sample)
  );
}

function albumTracks(artist, album, start, limit) {
  return listTracks(
    'WHERE COALESCE(album_artist, \'\') = ? AND COALESCE(album, \'\') = ?',
    [artist, album],
    'disc_no IS NULL, disc_no, track_no IS NULL, track_no, title COLLATE NOCASE',
    start, limit
  );
}

function listGenres(where, params, start, limit) {
  return pagedQuery(
    `SELECT COUNT(DISTINCT genre) AS c FROM tracks ${where}`,
    `SELECT genre, COUNT(*) AS n FROM tracks ${where} GROUP BY genre ORDER BY genre COLLATE NOCASE LIMIT ? OFFSET ?`,
    params, start, limit,
    (r) => ({ id: `L:GENRE${SEP}${r.genre}`, title: r.genre, browsable: true })
  );
}

function genreAlbums(genre, start, limit) {
  return pagedQuery(
    `SELECT COUNT(*) AS c FROM (SELECT 1 FROM tracks WHERE genre = ? GROUP BY COALESCE(album_artist, ''), COALESCE(album, ''))`,
    `SELECT COALESCE(album_artist, '') AS artist, COALESCE(album, '') AS album, MIN(path) AS sample
     FROM tracks WHERE genre = ? GROUP BY COALESCE(album_artist, ''), COALESCE(album, '')
     ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE LIMIT ? OFFSET ?`,
    [genre], start, limit,
    (r) => albumItem(r.artist, r.album || 'Unknown Album', r.sample)
  );
}

function listComposers(where, params, start, limit) {
  return pagedQuery(
    `SELECT COUNT(DISTINCT composer) AS c FROM tracks ${where}`,
    `SELECT composer FROM tracks ${where} GROUP BY composer ORDER BY composer COLLATE NOCASE LIMIT ? OFFSET ?`,
    params, start, limit,
    (r) => ({ id: `L:COMPOSER${SEP}${r.composer}`, title: r.composer, browsable: true })
  );
}

// Folder tree derived from indexed paths -- only compatible, indexed
// files appear, which is the point (a filesystem view would show
// hi-res/incompatible files that error when tapped). Path PK range
// scan, then one pass to split out immediate children.
function folderChildren(relDir, start, limit) {
  const prefix = relDir ? `${relDir}/` : '';
  const st = prep("SELECT path, title, artist, album, duration_s, mime FROM tracks WHERE path >= ? AND path < ? ORDER BY path");
  const dirs = new Map(); // name -> child rel
  const files = [];
  for (const row of st.iterate(prefix, `${prefix}\uffff`)) {
    const rest = row.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push(trackItem(row));
    } else {
      const name = rest.slice(0, slash);
      if (!dirs.has(name)) dirs.set(name, prefix + name);
    }
  }
  const dirItems = [...dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, rel]) => ({ id: `L:FOLDER${SEP}${rel}`, title: name, browsable: true }));
  const all = [...dirItems, ...files];
  return page(all.slice(start, start + limit), all.length, start);
}

// ---------------------------------------------------------------------
// ID parsing + dispatch
// ---------------------------------------------------------------------
const CATEGORY_TOKENS = [
  'ARTISTS', 'ALBUMS', 'TRACKS', 'GENRES', 'COMPOSERS', 'FOLDERS',
  'ARTIST', 'ALBUM', 'TRACK', 'GENRE', 'COMPOSER', 'FOLDER'
];

function parseId(containerId) {
  const body = String(containerId).slice(2); // strip "L:"
  for (const token of CATEGORY_TOKENS) {
    if (body === token) return { cat: token };
    if (body.startsWith(`${token}:`)) {
      const raw = body.slice(token.length + 1);
      let term = raw;
      try { term = decodeURIComponent(raw); } catch (err) { /* use raw */ }
      return { cat: token, search: term };
    }
    if (body.startsWith(`${token}${SEP}`)) {
      return { cat: token, args: body.slice(token.length + 1).split(SEP) };
    }
  }
  return null;
}

async function browsePage(containerId, start = 0, limit = PAGE_LIMIT) {
  const safeStart = Math.max(0, parseInt(start, 10) || 0);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || PAGE_LIMIT, 1), PAGE_LIMIT);
  if (!available()) {
    debugLog.warn('localbrowse', 'browse requested but library index is not available');
    return page([], 0, safeStart);
  }
  const parsed = parseId(containerId);
  if (!parsed) {
    debugLog.warn('localbrowse', `unrecognized container id: ${containerId}`);
    return page([], 0, safeStart);
  }
  const { cat, args, search } = parsed;
  try {
    switch (cat) {
      case 'ARTISTS': {
        if (search !== undefined) {
          return listArtists("WHERE COALESCE(album_artist, '') LIKE ? ESCAPE '\\'", [likePattern(search)], safeStart, safeLimit);
        }
        if (args) {
          return listArtists(`WHERE ${letterCondition('album_artist', args[0])}`, [], safeStart, safeLimit);
        }
        const letters = letterDistribution('album_artist');
        const distinct = letters.reduce((sum, l) => sum + l.count, 0);
        if (distinct > BUCKET_THRESHOLD) {
          const items = letterBucketItems('L:ARTISTS', letters);
          return page(items.slice(safeStart, safeStart + safeLimit), items.length, safeStart);
        }
        return listArtists('', [], safeStart, safeLimit);
      }
      case 'ARTIST':
        return artistAlbums(args[0], safeStart, safeLimit);
      case 'ALBUMS': {
        if (search !== undefined) {
          return listAlbums("WHERE COALESCE(album, '') LIKE ? ESCAPE '\\'", [likePattern(search)], safeStart, safeLimit);
        }
        if (args) {
          return listAlbums(`WHERE ${letterCondition('album', args[0])}`, [], safeStart, safeLimit);
        }
        const st = prep("SELECT COUNT(*) AS c FROM (SELECT 1 FROM tracks GROUP BY COALESCE(album_artist, ''), COALESCE(album, ''))");
        if (st.get().c > BUCKET_THRESHOLD) {
          const letters = letterDistribution('album');
          const items = letterBucketItems('L:ALBUMS', letters);
          return page(items.slice(safeStart, safeStart + safeLimit), items.length, safeStart);
        }
        return listAlbums('', [], safeStart, safeLimit);
      }
      case 'ALBUM':
        return albumTracks(args[0], args[1] || '', safeStart, safeLimit);
      case 'TRACKS': {
        if (search !== undefined) {
          return listTracks(
            "WHERE (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\')",
            [likePattern(search), likePattern(search)],
            'title COLLATE NOCASE', safeStart, safeLimit
          );
        }
        if (args) {
          return listTracks(`WHERE ${letterCondition('title', args[0])}`, [], 'title COLLATE NOCASE', safeStart, safeLimit);
        }
        // Songs is always bucketed -- a flat 160k-row list helps nobody.
        const letters = letterDistribution('title');
        const items = letterBucketItems('L:TRACKS', letters);
        return page(items.slice(safeStart, safeStart + safeLimit), items.length, safeStart);
      }
      case 'GENRES': {
        const base = "WHERE genre IS NOT NULL AND genre <> ''";
        if (search !== undefined) {
          return listGenres(`${base} AND genre LIKE ? ESCAPE '\\'`, [likePattern(search)], safeStart, safeLimit);
        }
        return listGenres(base, [], safeStart, safeLimit);
      }
      case 'GENRE':
        return genreAlbums(args[0], safeStart, safeLimit);
      case 'COMPOSERS': {
        const base = "WHERE composer IS NOT NULL AND composer <> ''";
        if (search !== undefined) {
          return listComposers(`${base} AND composer LIKE ? ESCAPE '\\'`, [likePattern(search)], safeStart, safeLimit);
        }
        if (args) {
          return listComposers(`${base} AND ${letterCondition('composer', args[0])}`, [], safeStart, safeLimit);
        }
        const distinct = prep(`SELECT COUNT(DISTINCT composer) AS c FROM tracks ${base}`).get().c;
        if (distinct > BUCKET_THRESHOLD) {
          const letters = letterDistribution('composer');
          const items = letterBucketItems('L:COMPOSERS', letters.filter((l) => l.letter !== '#' || l.count > 0));
          return page(items.slice(safeStart, safeStart + safeLimit), items.length, safeStart);
        }
        return listComposers(base, [], safeStart, safeLimit);
      }
      case 'COMPOSER':
        return listTracks(
          'WHERE composer = ?', [args[0]],
          'album COLLATE NOCASE, disc_no IS NULL, disc_no, track_no IS NULL, track_no',
          safeStart, safeLimit
        );
      case 'FOLDERS':
        return folderChildren('', safeStart, safeLimit);
      case 'FOLDER':
        return folderChildren(args[0], safeStart, safeLimit);
      case 'TRACK': {
        // A single track "container" -- returned as a one-item list so
        // anything that browses an item id still gets something sane.
        const row = prep('SELECT path, title, artist, album, duration_s, mime FROM tracks WHERE path = ?').get(args[0]);
        return page(row ? [trackItem(row)] : [], row ? 1 : 0, safeStart);
      }
      default:
        return page([], 0, safeStart);
    }
  } catch (err) {
    debugLog.error('localbrowse', `browse ${containerId} failed: ${err.message}`);
    return page([], 0, safeStart);
  }
}

module.exports = {
  browsePage,
  getCategories,
  available,
  SEP
};
