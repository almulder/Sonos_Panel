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

// ---------------------------------------------------------------------
// Bucket normalization (v0.10.0): leading articles are stripped and
// diacritics folded so "The Beatles" buckets under B and "Éxito" under
// E instead of '#'. Applied via small in-memory indexes for artists /
// albums / genres / composers (a few thousand entries each), memoized
// against COUNT+MAX(mtime) so retags invalidate them. Songs (160k
// rows) stay SQL-side with article-stripping only.
// ---------------------------------------------------------------------
function stripArticles(str) {
  return String(str || '').replace(/^(the|a|an)\s+/i, '');
}
function foldDiacritics(str) {
  try { return str.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (err) { return str; }
}
function bucketLetter(str) {
  const c = (foldDiacritics(stripArticles(String(str || '').trim())).charAt(0) || '').toUpperCase();
  return /^[A-Z]$/.test(c) ? c : '#';
}
function sortKey(str) {
  return foldDiacritics(stripArticles(String(str || ''))).toLowerCase();
}
function splitValues(joined) {
  return String(joined || '').split(/;\s*/).map((v) => v.trim()).filter(Boolean);
}

const memo = { key: null, data: {} };
function memoIndex(name, build) {
  const row = prep('SELECT COUNT(*) AS c, COALESCE(MAX(mtime_ms), 0) AS m FROM tracks').get();
  const key = `${row.c}:${row.m}`;
  if (memo.key !== key) { memo.key = key; memo.data = {}; }
  if (!memo.data[name]) memo.data[name] = build();
  return memo.data[name];
}

function artistIndex() {
  return memoIndex('artists', () => prep(
    "SELECT COALESCE(album_artist, '') AS name, MAX(art) AS art FROM tracks GROUP BY COALESCE(album_artist, '')"
  ).all()
    .map((r) => ({ name: r.name, art: r.art, letter: bucketLetter(r.name), key: sortKey(r.name) }))
    .sort((a, b) => a.key.localeCompare(b.key)));
}
function albumIndex() {
  return memoIndex('albums', () => prep(
    "SELECT COALESCE(album_artist, '') AS artist, COALESCE(album, '') AS album, MAX(art) AS art FROM tracks GROUP BY COALESCE(album_artist, ''), COALESCE(album, '')"
  ).all()
    .map((r) => ({ artist: r.artist, album: r.album, art: r.art, letter: bucketLetter(r.album), key: sortKey(r.album) }))
    .sort((a, b) => a.key.localeCompare(b.key)));
}
// Multi-value tags ("Lennon; McCartney", "Electronic; Ambient") fold
// into separate entries with combined counts.
function splitIndex(column) {
  return memoIndex(`split:${column}`, () => {
    const map = new Map();
    for (const r of prep(`SELECT ${column} AS v, COUNT(*) AS n FROM tracks WHERE ${column} IS NOT NULL AND ${column} <> '' GROUP BY ${column}`).all()) {
      for (const val of splitValues(r.v)) {
        map.set(val, (map.get(val) || 0) + r.n);
      }
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count, letter: bucketLetter(name), key: sortKey(name) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  });
}
// SQL fragment matching a single value inside a joined multi-value
// column ('X', 'X; ...', '...; X', '...; X; ...').
function splitMatch(column) {
  return `(${column} = ? OR ${column} LIKE ? || '; %' OR ${column} LIKE '%; ' || ? OR ${column} LIKE '%; ' || ? || '; %')`;
}
function splitMatchParams(value) {
  return [value, value, value, value];
}

// Article-stripped first letter for SQL-side track bucketing.
const TITLE_BUCKET_EXPR = `upper(substr(ltrim(CASE
  WHEN title LIKE 'The %' THEN substr(title, 5)
  WHEN title LIKE 'An %' THEN substr(title, 4)
  WHEN title LIKE 'A %' THEN substr(title, 3)
  ELSE title END), 1, 1))`;

function pageFolded(list, mapItem, start, limit) {
  return page(list.slice(start, start + limit).map(mapItem), list.length, start);
}

// Containers whose natural browse yields ALBUMS (no uris): translated
// to their all-tracks twins by queue/playlist adds so "queue this
// artist/genre" queues actual music.
function flattenContainerId(containerId) {
  const parsed = typeof containerId === 'string' && containerId.startsWith('L:') ? parseId(containerId) : null;
  if (parsed && parsed.args) {
    if (parsed.cat === 'ARTIST') return `L:ARTISTTRACKS${SEP}${parsed.args[0]}`;
    if (parsed.cat === 'GENRE') return `L:GENRETRACKS${SEP}${parsed.args[0]}`;
  }
  return containerId;
}

// LIKE pattern with user input made literal.
function likePattern(term) {
  return `%${String(term).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

// ---------------------------------------------------------------------
// Item builders -- all output matches the shape mapDidlNode gives the
// client: {id, title, albumArtUrl, browsable, uri, artist?, metadata?}
// ---------------------------------------------------------------------
// Art references come pre-resolved from the scanner (tracks.art):
// 'f:<image relpath>' -> folder image via /art/, 'e:<cachefile>' ->
// extracted embedded cover via /art/embedded/. No filesystem work at
// browse time -- which is also why big letter-bucket pages render
// faster than the v0.5.x folder-lookup-per-row approach.
function artUrl(art) {
  if (!art) return null;
  if (art.startsWith('f:')) return localLibrary.buildArtUri(art.slice(2));
  if (art.startsWith('e:')) return localLibrary.buildEmbeddedArtUri(art.slice(2));
  return null;
}

function trackItem(row) {
  const uri = localLibrary.buildStreamUri(row.path);
  const albumArtUrl = artUrl(row.art);
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

function albumItem(artist, album, art) {
  return {
    id: `L:ALBUM${SEP}${artist}${SEP}${album}`,
    title: album,
    artist: artist || null,
    browsable: true,
    // MAX(art) in the callers: string ordering makes 'f:' beat 'e:'
    // beat '', so folder images win when any track has one.
    albumArtUrl: artUrl(art)
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
    { id: 'L:ALL', title: 'Search' },
    { id: 'L:ARTISTS', title: 'Artists' },
    { id: 'L:ALBUMS', title: 'Albums' },
    { id: 'L:RECENT', title: 'Recently Added' }
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
    `SELECT COALESCE(album_artist, '') AS artist, MAX(art) AS art
     FROM tracks ${where} GROUP BY COALESCE(album_artist, '')
     ORDER BY artist COLLATE NOCASE LIMIT ? OFFSET ?`,
    params, start, limit,
    (r) => ({
      id: `L:ARTIST${SEP}${r.artist}`,
      title: r.artist || 'Unknown Artist',
      browsable: true,
      albumArtUrl: artUrl(r.art)
    })
  );
}

function listAlbums(where, params, start, limit) {
  return pagedQuery(
    `SELECT COUNT(*) AS c FROM (SELECT 1 FROM tracks ${where} GROUP BY COALESCE(album_artist, ''), COALESCE(album, ''))`,
    `SELECT COALESCE(album_artist, '') AS artist, COALESCE(album, '') AS album, MAX(art) AS art
     FROM tracks ${where} GROUP BY COALESCE(album_artist, ''), COALESCE(album, '')
     ORDER BY album COLLATE NOCASE, artist COLLATE NOCASE LIMIT ? OFFSET ?`,
    params, start, limit,
    (r) => albumItem(r.artist, r.album || 'Unknown Album', r.art)
  );
}

function listTracks(where, params, orderBy, start, limit) {
  return pagedQuery(
    `SELECT COUNT(*) AS c FROM tracks ${where}`,
    `SELECT path, title, artist, album, duration_s, mime, art FROM tracks ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    params, start, limit, trackItem
  );
}

function artistAlbums(artist, start, limit) {
  return pagedQuery(
    `SELECT COUNT(*) AS c FROM (SELECT 1 FROM tracks WHERE COALESCE(album_artist, '') = ? GROUP BY COALESCE(album, ''))`,
    `SELECT COALESCE(album, '') AS album, MAX(art) AS art, MIN(year) AS year
     FROM tracks WHERE COALESCE(album_artist, '') = ? GROUP BY COALESCE(album, '')
     ORDER BY year IS NULL, year, album COLLATE NOCASE LIMIT ? OFFSET ?`,
    [artist], start, limit,
    (r) => albumItem(artist, r.album || 'Unknown Album', r.art)
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
    `SELECT COUNT(*) AS c FROM (SELECT 1 FROM tracks WHERE ${splitMatch('genre')} GROUP BY COALESCE(album_artist, ''), COALESCE(album, ''))`,
    `SELECT COALESCE(album_artist, '') AS artist, COALESCE(album, '') AS album, MAX(art) AS art
     FROM tracks WHERE ${splitMatch('genre')} GROUP BY COALESCE(album_artist, ''), COALESCE(album, '')
     ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE LIMIT ? OFFSET ?`,
    splitMatchParams(genre), start, limit,
    (r) => albumItem(r.artist, r.album || 'Unknown Album', r.art)
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
  const st = prep("SELECT path, title, artist, album, duration_s, mime, art FROM tracks WHERE path >= ? AND path < ? ORDER BY path");
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
  'ARTISTTRACKS', 'GENRETRACKS', 'RECENT', 'ALL',
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
        const idx = artistIndex();
        const toItem = (a) => ({
          id: `L:ARTIST${SEP}${a.name}`,
          title: a.name || 'Unknown Artist',
          browsable: true,
          albumArtUrl: artUrl(a.art)
        });
        if (args) {
          return pageFolded(idx.filter((a) => a.letter === args[0]), toItem, safeStart, safeLimit);
        }
        if (idx.length > BUCKET_THRESHOLD) {
          const letters = [...new Set(idx.map((a) => a.letter))];
          const order = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
          const items = letterBucketItems('L:ARTISTS', order.filter((l) => letters.includes(l)).map((l) => ({ letter: l })));
          return page(items.slice(safeStart, safeStart + safeLimit), items.length, safeStart);
        }
        return pageFolded(idx, toItem, safeStart, safeLimit);
      }
      case 'ARTIST': {
        // "All Songs" pseudo-entry pinned first, then the albums.
        const allSongs = {
          id: `L:ARTISTTRACKS${SEP}${args[0]}`,
          title: 'All Songs',
          artist: args[0] || null,
          browsable: true
        };
        if (safeStart === 0) {
          const inner = artistAlbums(args[0], 0, safeLimit - 1);
          return page([allSongs, ...inner.items], inner.total + 1, 0);
        }
        const inner = artistAlbums(args[0], safeStart - 1, safeLimit);
        return page(inner.items, inner.total + 1, safeStart);
      }
      case 'ARTISTTRACKS':
        return listTracks(
          "WHERE COALESCE(album_artist, '') = ?", [args[0]],
          'album COLLATE NOCASE, disc_no IS NULL, disc_no, track_no IS NULL, track_no, title COLLATE NOCASE',
          safeStart, safeLimit
        );
      case 'ALBUMS': {
        if (search !== undefined) {
          return listAlbums("WHERE COALESCE(album, '') LIKE ? ESCAPE '\\'", [likePattern(search)], safeStart, safeLimit);
        }
        const idx = albumIndex();
        const toItem = (a) => albumItem(a.artist, a.album || 'Unknown Album', a.art);
        if (args) {
          return pageFolded(idx.filter((a) => a.letter === args[0]), toItem, safeStart, safeLimit);
        }
        if (idx.length > BUCKET_THRESHOLD) {
          const letters = [...new Set(idx.map((a) => a.letter))];
          const order = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
          const items = letterBucketItems('L:ALBUMS', order.filter((l) => letters.includes(l)).map((l) => ({ letter: l })));
          return page(items.slice(safeStart, safeStart + safeLimit), items.length, safeStart);
        }
        return pageFolded(idx, toItem, safeStart, safeLimit);
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
          const cond = args[0] === '#'
            ? `${TITLE_BUCKET_EXPR} NOT BETWEEN 'A' AND 'Z'`
            : `${TITLE_BUCKET_EXPR} = '${args[0]}'`;
          return listTracks(`WHERE ${cond}`, [], 'title COLLATE NOCASE', safeStart, safeLimit);
        }
        // Songs is always bucketed -- a flat 160k-row list helps nobody.
        // Article-stripped in SQL so "The ..." titles land on their
        // real letter (diacritics stay '#' at this scale).
        const rows = prep(`SELECT ${TITLE_BUCKET_EXPR} AS letter, COUNT(*) AS c FROM tracks GROUP BY letter`).all();
        const present = new Set(rows.map((r) => (/^[A-Z]$/.test(r.letter || '') ? r.letter : '#')));
        const order = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
        const items = letterBucketItems('L:TRACKS', order.filter((l) => present.has(l)).map((l) => ({ letter: l })));
        return page(items.slice(safeStart, safeStart + safeLimit), items.length, safeStart);
      }
      case 'GENRES': {
        let idx = splitIndex('genre');
        if (search !== undefined) {
          const term = String(search).toLowerCase();
          idx = idx.filter((g) => g.name.toLowerCase().includes(term));
        }
        return pageFolded(idx, (g) => ({ id: `L:GENRE${SEP}${g.name}`, title: g.name, browsable: true }), safeStart, safeLimit);
      }
      case 'GENRE':
        return genreAlbums(args[0], safeStart, safeLimit);
      case 'GENRETRACKS':
        return listTracks(
          `WHERE ${splitMatch('genre')}`, splitMatchParams(args[0]),
          'artist COLLATE NOCASE, album COLLATE NOCASE, disc_no IS NULL, disc_no, track_no IS NULL, track_no',
          safeStart, safeLimit
        );
      case 'COMPOSERS': {
        let idx = splitIndex('composer');
        const toItem = (c) => ({ id: `L:COMPOSER${SEP}${c.name}`, title: c.name, browsable: true });
        if (search !== undefined) {
          const term = String(search).toLowerCase();
          return pageFolded(idx.filter((c) => c.name.toLowerCase().includes(term)), toItem, safeStart, safeLimit);
        }
        if (args) {
          return pageFolded(idx.filter((c) => c.letter === args[0]), toItem, safeStart, safeLimit);
        }
        if (idx.length > BUCKET_THRESHOLD) {
          const letters = [...new Set(idx.map((c) => c.letter))];
          const order = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
          const items = letterBucketItems('L:COMPOSERS', order.filter((l) => letters.includes(l)).map((l) => ({ letter: l })));
          return page(items.slice(safeStart, safeStart + safeLimit), items.length, safeStart);
        }
        return pageFolded(idx, toItem, safeStart, safeLimit);
      }
      case 'COMPOSER':
        return listTracks(
          `WHERE ${splitMatch('composer')}`, splitMatchParams(args[0]),
          'album COLLATE NOCASE, disc_no IS NULL, disc_no, track_no IS NULL, track_no',
          safeStart, safeLimit
        );
      case 'FOLDERS':
        return folderChildren('', safeStart, safeLimit);
      case 'FOLDER':
        return folderChildren(args[0], safeStart, safeLimit);
      case 'RECENT':
        // Newest files first -- indexed on mtime_ms, so the sort is
        // cheap; a fresh rip clusters at the top by album naturally.
        return listTracks('WHERE 1=1', [], 'mtime_ms DESC, path', safeStart, safeLimit);
      case 'ALL': {
        // Unified search across artists, albums, and songs. Empty
        // query = empty page (the search box is the interface); with a
        // term: up to 30 artists + 40 albums, songs fill to 200. One
        // page total -- refine the term rather than paging deep.
        if (search === undefined || !String(search).trim()) return page([], 0, safeStart);
        const pat = likePattern(search);
        const artists = prep(
          "SELECT COALESCE(album_artist, '') AS name, MAX(art) AS art FROM tracks WHERE COALESCE(album_artist, '') LIKE ? ESCAPE '\\' GROUP BY COALESCE(album_artist, '') ORDER BY name COLLATE NOCASE LIMIT 30"
        ).all(pat).map((r) => ({
          id: `L:ARTIST${SEP}${r.name}`, title: r.name, browsable: true, artist: 'Artist', albumArtUrl: artUrl(r.art)
        }));
        const albums = prep(
          "SELECT COALESCE(album_artist, '') AS artist, COALESCE(album, '') AS album, MAX(art) AS art FROM tracks WHERE COALESCE(album, '') LIKE ? ESCAPE '\\' GROUP BY COALESCE(album_artist, ''), COALESCE(album, '') ORDER BY album COLLATE NOCASE LIMIT 40"
        ).all(pat).map((r) => ({
          id: `L:ALBUM${SEP}${r.artist}${SEP}${r.album}`, title: r.album, browsable: true,
          artist: `Album \u00b7 ${r.artist || 'Unknown Artist'}`, albumArtUrl: artUrl(r.art)
        }));
        const room = 200 - artists.length - albums.length;
        const tracks = prep(
          "SELECT path, title, artist, album, duration_s, mime, art FROM tracks WHERE (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\') ORDER BY title COLLATE NOCASE LIMIT ?"
        ).all(pat, pat, room).map(trackItem);
        const items = [...artists, ...albums, ...tracks];
        return page(items.slice(safeStart, safeStart + safeLimit), items.length, safeStart);
      }
      case 'TRACK': {
        // A single track "container" -- returned as a one-item list so
        // anything that browses an item id still gets something sane.
        const row = prep('SELECT path, title, artist, album, duration_s, mime, art FROM tracks WHERE path = ?').get(args[0]);
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
  flattenContainerId,
  getCategories,
  available,
  SEP
};
