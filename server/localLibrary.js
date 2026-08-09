// server/localLibrary.js
//
// PHASE 1 of the Local Music Library -- streaming only, no index yet.
//
// WHY THIS EXISTS: Sonos's own Music Library tops out at ~65,000 tracks
// because the INDEX lives in the speakers' RAM. This feature sidesteps
// that entirely: the panel (which runs on a real server) will own the
// index, and the speakers just play plain HTTP audio URLs served from
// here -- they never index anything, so there's no track limit anywhere.
//
// Phase 1 deliberately ships only the risky part: serving audio files
// over HTTP in a way real Sonos hardware will actually play, seek, and
// (hopefully) gap-lessly chain. Everything cheap and safe (the tag
// scanner, the SQLite index, the browse tabs, local playlists) waits
// until this is verified on real speakers -- same
// prove-the-foundation-first approach as the rest of this project.
//
// PATHS: the music folder is volume-mounted at /music (see the Unraid
// template's "Music Path" mapping). It's the container-local view of
// the SAME folder Samba exposes as \\HUSKYSERVER\...\Music -- the
// container runs on the server itself, so it reads the disks directly
// rather than looping through SMB. UNC paths (\\server\share) are
// Windows syntax and don't work inside a Linux container at all; if
// the music ever lives on a DIFFERENT box, mount that share on the
// Unraid HOST (Unassigned Devices plugin -> /mnt/remotes/...) and
// point the same Music Path mapping there. Host handles the mounting;
// container stays dumb and fast.

const fs = require('fs');
const os = require('os');
const path = require('path');
const debugLog = require('./debugLog');

// Container-side mount point. Fixed at /music in the Unraid template /
// compose file so the app never has to care where the host keeps the
// files; MUSIC_DIR exists as an env override for local development
// (e.g. MUSIC_DIR=/tmp/music node server/index.js).
const MUSIC_DIR = process.env.MUSIC_DIR || '/music';

// Must match how index.js resolves PORT -- used when auto-detecting
// the stream base URL below.
const PORT = process.env.PORT || 3000;

// File extensions worth showing/serving, mapped to the Content-Type
// Sonos should be told. Deliberately explicit rather than trusting a
// generic mime lookup: Sonos S2's supported set is known, and being
// deterministic here means a playback failure can't be blamed on a
// surprise "audio/x-flac vs audio/flac" difference between mime DBs.
const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma'
};

function isAudioFile(name) {
  return Object.prototype.hasOwnProperty.call(AUDIO_TYPES, path.extname(name).toLowerCase());
}

function contentTypeFor(name) {
  return AUDIO_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// Album art images, for the /art/ route. Kept separate from AUDIO_TYPES
// on purpose: /stream/ serves ONLY audio and /art/ serves ONLY images,
// so neither route can be used to reach the other's file types.
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

function isImageFile(name) {
  return Object.prototype.hasOwnProperty.call(IMAGE_TYPES, path.extname(name).toLowerCase());
}

function imageContentTypeFor(name) {
  return IMAGE_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// Common cover-image filenames rippers leave next to the tracks, in
// preference order. Matched case-insensitively against the folder's
// actual contents (Cover.JPG etc. all count).
const ART_BASENAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall'];

// dir relPath -> art filename (or null), cached because every track in
// an album asks about the same folder. Process-lifetime cache is fine:
// art files change about never, and a container restart clears it.
const folderArtCache = new Map();

function findFolderArt(relDir) {
  const key = relDir || '';
  if (folderArtCache.has(key)) return folderArtCache.get(key);
  let found = null;
  const abs = resolveSafe(key);
  if (abs) {
    try {
      const entries = fs.readdirSync(abs);
      for (const base of ART_BASENAMES) {
        const hit = entries.find((e) => {
          const lower = e.toLowerCase();
          return isImageFile(lower) && lower.replace(/\.[^.]+$/, '') === base;
        });
        if (hit) { found = key ? `${key}/${hit}` : hit; break; }
      }
    } catch (err) { /* unreadable dir -> just no art */ }
  }
  folderArtCache.set(key, found);
  return found;
}

// The feature is entirely optional -- no Music Path mapped means /music
// simply doesn't exist, and everything here degrades to "disabled"
// rather than erroring. Checked live (not cached at require-time) so a
// fixed mount doesn't need an app restart to be noticed.
function isEnabled() {
  try {
    return fs.statSync(MUSIC_DIR).isDirectory();
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------
// Path safety. Every relative path arriving from a URL or request body
// goes through here before touching the filesystem. The rules:
//   - no absolute paths, no backslashes, no null bytes
//   - no ".." segments (checked AFTER URL-decoding, which Express has
//     already done -- so an encoded %2e%2e sneaks nothing past this)
//   - the fully resolved result must still live inside MUSIC_DIR
// Returns the absolute path, or null if anything smells wrong.
// ---------------------------------------------------------------------
function resolveSafe(relPath) {
  const rel = String(relPath || '');
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (rel.startsWith('/') || rel.startsWith('~')) return null;
  const segments = rel.split('/');
  if (segments.some((s) => s === '..')) return null;
  const abs = path.resolve(MUSIC_DIR, rel);
  const root = path.resolve(MUSIC_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// ---------------------------------------------------------------------
// Stream base URL -- the address the SPEAKERS will fetch audio from,
// which is not necessarily the address the browser used to reach the
// panel. Explicit PUBLIC_BASE_URL env wins; otherwise auto-detect the
// container's own LAN IP, which is reliable specifically because this
// deployment uses ipvlan br0 (the container has a real routable LAN
// address of its own) or host networking. Plain bridge networking
// would auto-detect an unreachable 172.17.x.x address -- one more
// reason bridge mode was already ruled out for this app (SSDP being
// the first).
// ---------------------------------------------------------------------
function detectLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}

function getPublicBaseUrl() {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const ip = detectLanIp();
  if (!ip) return null;
  // Port 80 is the template default and the URL reads cleaner bare;
  // any other port has to be explicit for the speakers to connect.
  return String(PORT) === '80' ? `http://${ip}` : `http://${ip}:${PORT}`;
}

// Builds the URL a speaker will be handed for one file. Encoding is
// per-segment: slashes must survive as real path separators, but
// everything else (spaces, #, &, %, unicode) has to be percent-encoded
// or Sonos will mangle/reject the URI.
function buildStreamUri(relPath) {
  const base = getPublicBaseUrl();
  if (!base) return null;
  const encoded = String(relPath)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${base}/stream/${encoded}`;
}

function buildArtUri(relPath) {
  const base = getPublicBaseUrl();
  if (!base) return null;
  const encoded = String(relPath)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${base}/art/${encoded}`;
}

// Best-effort display metadata straight from the path, assuming the
// common Artist/Album/Track layout. Good enough for the Phase 1
// hardware test (verifies DIDL metadata shows up on the panel/app);
// Phase 2's tag scanner replaces this with real embedded tags.
function describeTrack(relPath) {
  const parts = String(relPath).split('/').filter(Boolean);
  const file = parts[parts.length - 1] || '';
  const title = file
    .replace(/\.[^.]+$/, '')
    .replace(/^\d{1,3}\s*[-. ]\s*/, '')
    .trim() || file;
  const artRel = findFolderArt(parts.slice(0, -1).join('/'));
  return {
    title,
    album: parts.length >= 2 ? parts[parts.length - 2] : undefined,
    artist: parts.length >= 3 ? parts[parts.length - 3] : undefined,
    albumArtUrl: artRel ? buildArtUri(artRel) : undefined,
    mime: contentTypeFor(file)
  };
}

// Directory listing for the test harness (and, later, the Folders
// browse category). Returns dirs + audio files only, sorted dirs-first,
// capped so an accidental ls of a 20k-file flat folder can't melt the
// response.
const LS_MAX_ENTRIES = 500;

function listDir(relPath) {
  const abs = resolveSafe(relPath || '');
  if (!abs) return null;
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    return null;
  }
  const dirs = [];
  const files = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory()) dirs.push({ name: ent.name, type: 'dir' });
    else if (ent.isFile() && isAudioFile(ent.name)) files.push({ name: ent.name, type: 'file' });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const all = [...dirs, ...files];
  return {
    dir: relPath || '',
    truncated: all.length > LS_MAX_ENTRIES,
    entries: all.slice(0, LS_MAX_ENTRIES)
  };
}

function logStartupState() {
  if (!isEnabled()) {
    debugLog.info('locallib', `Local Music Library disabled -- no folder mounted at ${MUSIC_DIR} (map "Music Path" in the template to enable)`);
    return;
  }
  const base = getPublicBaseUrl();
  if (base) {
    debugLog.info('locallib', `Local Music Library enabled: serving ${MUSIC_DIR} at ${base}/stream/... ${process.env.PUBLIC_BASE_URL ? '(PUBLIC_BASE_URL)' : '(auto-detected LAN IP)'}`);
  } else {
    debugLog.warn('locallib', 'Local Music Library: music folder found but no LAN IP could be detected and PUBLIC_BASE_URL is unset -- speakers will not be able to stream');
  }
}

module.exports = {
  MUSIC_DIR,
  isEnabled,
  isAudioFile,
  contentTypeFor,
  isImageFile,
  imageContentTypeFor,
  findFolderArt,
  buildArtUri,
  resolveSafe,
  getPublicBaseUrl,
  buildStreamUri,
  describeTrack,
  listDir,
  logStartupState
};
