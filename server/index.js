// server/index.js
//
// Run with: npm install && npm start
// Then open http://localhost:3000

const fs = require('fs');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const sonos = require('./sonos');
const localLibrary = require('./localLibrary');
const localScanner = require('./localScanner');
const localBrowse = require('./localBrowse');
const debugLog = require('./debugLog');

const PORT = process.env.PORT || 3000;
// Surfaced in /api/config and the boot log so "which build is this
// panel actually running" is always answerable in one request.
// eslint-disable-next-line global-require
const PKG_VERSION = require('../package.json').version;
// User-selectable accent color (hex). Drives the UI accent (buttons,
// highlights, borders) and the idle screensaver's color-cycle animation --
// see public/js/theme.js for how it's applied client-side.
const THEME_COLOR = process.env.THEME_COLOR || '#e8a33d';

// How long with no touch/click before the screensaver kicks in. Default
// matches what felt right for a wall-mounted panel that's glanced at
// occasionally, not actively used continuously.
const SCREENSAVER_TIMEOUT_SECONDS = Number(process.env.SCREENSAVER_TIMEOUT_SECONDS) || 600;

// Up to three extra tabs alongside the built-in Sonos tab, each pointing
// at another local dashboard/app (Hubitat, Home Assistant, etc.) shown in
// an iframe. Only _URL is required to make a tab appear -- _TITLE,
// _COLOR, and _ICON are all optional (title falls back to a generic
// label, color falls back to THEME_COLOR, icon is simply omitted if
// blank). A tab is skipped entirely if its URL isn't set.
function buildExtraTabs() {
  const tabs = [];
  for (const n of [2, 3, 4]) {
    const url = process.env[`TAB${n}_URL`];
    if (!url) continue;
    tabs.push({
      id: `tab${n}`,
      title: process.env[`TAB${n}_TITLE`] || `Tab ${n}`,
      color: process.env[`TAB${n}_COLOR`] || THEME_COLOR,
      icon: process.env[`TAB${n}_ICON`] || '',
      url
    });
  }
  return tabs;
}

// Now a SAFETY-NET cadence rather than the primary update mechanism --
// see sonos.js's attachDeviceEventListeners/attachTopologyListener for
// the real-time push updates that handle the common case instantly.
// This still runs regularly specifically because that push path has a
// known gap (documented in sonos.js): if a UPnP subscription's renewal
// fails for certain reasons, the library stops retrying it silently,
// with no self-healing. 15s means a dead subscription is caught and
// corrected reasonably quickly rather than a room silently going stale
// until a manual restart.
const POLL_INTERVAL_MS = 15000;
// Tightened from 500ms now that a burst only re-queries the room(s)
// actually involved (see triggerSonosFastPoll) instead of every device --
// the risk with a fast interval was always about how many speakers get
// hit per tick, not the interval number itself. 150ms is a meaningful
// step down without the request-overlap/overload risk a much lower
// number (e.g. 50ms) would carry across 9+ real devices.
const SONOS_FAST_POLL_INTERVAL_MS = 150;
// Separate, more conservative interval specifically for FULL polls
// (grouping/ungrouping, which changes topology and needs every device
// re-checked). This intentionally stays at the original safer cadence --
// a full poll touches every device no matter how fast it's requested, so
// it shouldn't run at the same tightened rate as a targeted poll that
// only touches one or two.
const SONOS_FULL_POLL_INTERVAL_MS = 500;

// Lets route handlers push an update immediately (e.g. right after an
// optimistic topology patch) instead of waiting for the next scheduled
// poll tick. Set once main() creates the real broadcast function.
let broadcastNow = null;

// Brief burst of faster Sonos polling right after a room/volume/group
// action, then back to the normal 2s cadence -- per request, room
// grouping/ungrouping, volume changes, and track changes felt slow to
// reflect. Kept short and, critically, SCOPED to just the room(s)
// actually involved (sonosFastPollTargets) rather than polling every
// speaker at this faster rate -- a single-room volume tweak only
// re-queries that one device now, regardless of total room count. This
// is what makes a fast interval safe: the earlier version already hit a
// real "excessive hub load" style problem once before on different
// hardware from polling too broadly, and multiplying a fast interval
// across every device would risk the same thing again. Grouping/
// ungrouping is the one exception -- topology itself changes, so those
// two pass null (see below) to force a full untargeted poll, since a
// grouping change can affect how OTHER rooms display their group label
// too, not just the room that was tapped. Full polls run at the more
// conservative SONOS_FULL_POLL_INTERVAL_MS rather than the tightened
// targeted one.
const SONOS_FAST_POLL_BURST_MS = 5000;
let sonosFastPollUntil = 0;
// Two pieces of state, kept explicit rather than overloading one
// variable: sonosFastPollFullPoll flags a topology-changing action
// (group/ungroup) that needs every device re-queried; sonosFastPollTargets
// holds the specific rooms for everything else. Reset to a clean slate
// whenever a trigger arrives after the previous burst has fully expired,
// so stale targets from an old burst never leak into a new one.
let sonosFastPollFullPoll = false;
let sonosFastPollTargets = new Set();
function triggerSonosFastPoll(targetRoomNames) {
  const burstActive = Date.now() < sonosFastPollUntil;
  sonosFastPollUntil = Date.now() + SONOS_FAST_POLL_BURST_MS;

  if (!targetRoomNames) {
    sonosFastPollFullPoll = true;
    return;
  }

  if (!burstActive) {
    sonosFastPollFullPoll = false;
    sonosFastPollTargets = new Set(targetRoomNames);
  } else if (!sonosFastPollFullPoll) {
    // Accumulate rather than overwrite -- adjusting two different
    // rooms in quick succession within the same burst window should
    // get both refreshed, not just the most recent one.
    targetRoomNames.forEach((name) => sonosFastPollTargets.add(name));
  }
  // else: a full-poll trigger is already active this burst (from a
  // group/ungroup action) -- don't downgrade it to a targeted poll.
}

const app = express();
app.use(express.json());
// no-cache here means "revalidate every time", NOT "don't cache":
// browsers still keep the files but send a conditional request on each
// load, and the ETag turns unchanged files into ~1ms 304s on the LAN.
// Without this, express.static serves no Cache-Control at all and
// browsers fall back to heuristic caching -- which is exactly how a
// wall tablet kept running week-old sonosView.js after a container
// update and rendered the new Local Library source as an empty
// streaming service (found the hard way in v0.5.0 testing).
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ---------------------------------------------------------------------
// Crash safety net #1: wrap every async route handler. Without this, a
// rejected promise inside a route (e.g. a UPnP call failing) becomes an
// unhandled rejection, and Node's default behavior is to terminate the
// whole process. This is exactly what took the server down previously --
// one speaker returning a UPnP error mid-session killed the app for
// everyone, not just that one request.
// ---------------------------------------------------------------------
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      debugLog.error('server', `Route ${req.method} ${req.path} failed: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  };
}

// Crash safety net #2: catch anything that still slips through (e.g. an
// error thrown outside of a request, like inside the poll loop's own
// bugs). Logs and keeps running rather than taking the whole panel down --
// for a device mounted outside, "stay alive and log the problem" beats
// "crash and require someone to go reboot it."
process.on('unhandledRejection', (reason) => {
  debugLog.error('server', `Unhandled rejection: ${(reason && reason.message) || reason}`);
});
process.on('uncaughtException', (err) => {
  debugLog.error('server', `Uncaught exception: ${err.message}`);
});

// ---------------- App config ----------------
// Single endpoint the client fetches once at boot -- color, screensaver
// timing, and extra tabs all come from here rather than separate calls.

app.get('/api/config', (req, res) => {
  res.json({
    version: PKG_VERSION,
    color: THEME_COLOR,
    screensaverTimeoutMs: SCREENSAVER_TIMEOUT_SECONDS * 1000,
    tabs: buildExtraTabs()
  });
});

// ---------------- Sonos routes ----------------

app.get('/api/sonos/rooms', asyncHandler(async (req, res) => {
  const rooms = await sonos.getRooms();
  res.json({ rooms, mock: sonos.isMock() });
}));

app.get('/api/sonos/nowplaying/:room', asyncHandler(async (req, res) => {
  const track = await sonos.getNowPlaying(req.params.room);
  res.json(track);
}));

app.post('/api/sonos/room/:room/play', asyncHandler(async (req, res) => {
  await sonos.play(req.params.room);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/pause', asyncHandler(async (req, res) => {
  await sonos.pause(req.params.room);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/next', asyncHandler(async (req, res) => {
  await sonos.next(req.params.room);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/previous', asyncHandler(async (req, res) => {
  await sonos.previous(req.params.room);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/volume', asyncHandler(async (req, res) => {
  await sonos.setVolume(req.params.room, req.body.volume);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

app.get('/api/sonos/room/:room/group-volume', asyncHandler(async (req, res) => {
  const volume = await sonos.getGroupVolume(req.params.room);
  res.json({ volume });
}));

app.post('/api/sonos/room/:room/group-volume', asyncHandler(async (req, res) => {
  await sonos.setGroupVolume(req.params.room, req.body.volume);
  // Group volume affects every member of the bonded group, not just
  // the room that was tapped -- target all of them so they all refresh.
  triggerSonosFastPoll(sonos.getGroupMemberNames(req.params.room));
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/mute', asyncHandler(async (req, res) => {
  await sonos.setMute(req.params.room, req.body.muted);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/group-mute', asyncHandler(async (req, res) => {
  await sonos.setGroupMute(req.params.room, req.body.muted);
  triggerSonosFastPoll(sonos.getGroupMemberNames(req.params.room));
  res.json({ ok: true });
}));

app.post('/api/sonos/group', asyncHandler(async (req, res) => {
  const [coordinatorName] = req.body.rooms;
  const { succeeded, failed, dissolved } = await sonos.groupRooms(req.body.rooms);
  // Reflect the intended grouping immediately, rather than waiting on
  // Sonos's own join-settling time (which can genuinely take several
  // seconds) before the UI shows anything. Only the rooms that actually
  // joined get patched -- a room that failed (unplugged, unreachable)
  // shouldn't show as grouped when it isn't really. Rooms dissolved out
  // of a conflicting prior group (see resolveGroupConflicts) get
  // patched back to being their own coordinator, so that group doesn't
  // keep showing a member that's actually left.
  //
  // Deliberately NOT triggering a fast-poll burst here anymore: a burst
  // would re-check real topology every 500ms for the next 5 seconds,
  // and if a tick lands before Sonos has actually finished settling the
  // join, it reports genuinely-true-but-stale "not grouped yet" data
  // that overwrites this correct optimistic patch -- which is exactly
  // what caused the member room to visually revert until something
  // else forced a re-render. The real ZonesChanged event (see sonos.js)
  // now delivers genuine confirmation the moment Sonos actually
  // finishes, with the slow 15s baseline poll as an ultimate fallback
  // if that event is ever missed.
  dissolved.forEach((name) => sonos.patchCoordinatorOptimistically([name], name));
  if (succeeded.length > 0) {
    sonos.patchCoordinatorOptimistically([coordinatorName, ...succeeded], coordinatorName);
  }
  if ((succeeded.length > 0 || dissolved.length > 0) && broadcastNow) broadcastNow();
  res.json({ ok: true, succeeded, failed });
}));

app.post('/api/sonos/room/:room/ungroup', asyncHandler(async (req, res) => {
  const result = await sonos.ungroupRoom(req.params.room);
  // Ungrouping makes a room its own coordinator again -- reflected
  // locally regardless of whether the physical command actually
  // reached the device (see ungroupRoom in sonos.js: a disconnected
  // room can't receive the command, but the panel should still be able
  // to show it as ungrouped rather than getting stuck).
  sonos.patchCoordinatorOptimistically([req.params.room], req.params.room);
  if (broadcastNow) broadcastNow();
  res.json({ ok: true, reachable: result.reachable });
}));

// Exact-membership grouping for the Group Rooms dialog: the clicked
// room is the coordinator, checked rooms join it, unchecked current
// members leave -- and rooms in OTHER groups that weren't touched stay
// exactly where they are (unlike /api/sonos/group's dissolve-overlaps
// semantics, which suit the saved-group presets).
app.post('/api/sonos/room/:room/group-members', asyncHandler(async (req, res) => {
  const members = Array.isArray(req.body.members) ? req.body.members : [];
  const result = await sonos.setGroupMembers(req.params.room, members);
  if (broadcastNow) broadcastNow();
  res.json({ ok: true, ...result });
}));

// ---------------- Saved group presets ----------------
// Local equivalent of the official app's "Saved Groups" -- see the
// comment above these functions in sonos.js for why this couldn't just
// read Sonos's own saved groups (cloud-account-only, no local API).

app.get('/api/sonos/saved-groups', asyncHandler(async (req, res) => {
  res.json({ groups: sonos.getSavedGroups() });
}));

app.post('/api/sonos/saved-groups', asyncHandler(async (req, res) => {
  const { name, rooms } = req.body;
  if (!Array.isArray(rooms) || rooms.length < 2) {
    return res.status(400).json({ error: 'A saved group needs at least 2 rooms' });
  }
  const group = sonos.addSavedGroup(name, rooms);
  res.json({ group });
}));

app.delete('/api/sonos/saved-groups/:id', asyncHandler(async (req, res) => {
  sonos.deleteSavedGroup(req.params.id);
  res.json({ ok: true });
}));

app.put('/api/sonos/saved-groups/:id', asyncHandler(async (req, res) => {
  const { name, rooms } = req.body;
  if (!Array.isArray(rooms) || rooms.length < 2) {
    return res.status(400).json({ error: 'A saved group needs at least 2 rooms' });
  }
  const group = sonos.updateSavedGroup(req.params.id, name, rooms);
  if (!group) return res.status(404).json({ error: 'Saved group not found' });
  res.json({ group });
}));

app.get('/api/sonos/room/:room/source-groups', asyncHandler(async (req, res) => {
  const groups = await sonos.getSourceGroups(req.params.room);
  // Local Music Library pinned to the very top when the index exists --
  // it's the panel's own content, above even the Sonos Music Library.
  if (localBrowse.available()) {
    groups.unshift({ id: 'locallibrary', title: 'Local Library', browsable: true, isLocalLibraryRoot: true });
  }
  res.json({ groups });
}));

app.get('/api/sonos/room/:room/favorites-by-group', asyncHandler(async (req, res) => {
  const group = req.query.group;
  if (!group) return res.status(400).json({ error: 'Missing required query param: group' });
  const items = await sonos.getFavoritesByGroup(req.params.room, group, req.query.sn);
  res.json({ items });
}));

// Panel-side names for service account serials -- shown as the user
// list when a service has multiple logins.
app.get('/api/sonos/account-names', (req, res) => {
  res.json({ names: sonos.loadAccountNames() });
});
app.put('/api/sonos/account-names', asyncHandler(async (req, res) => {
  const { sn, name } = req.body;
  if (sn === undefined) return res.status(400).json({ error: 'Missing sn' });
  res.json({ names: sonos.setAccountName(sn, name) });
}));

app.get('/api/sonos/room/:room/playlists', asyncHandler(async (req, res) => {
  const items = await sonos.getPlaylists(req.params.room);
  res.json({ items });
}));

app.get('/api/sonos/room/:room/browse-container', asyncHandler(async (req, res) => {
  const containerId = req.query.id;
  if (!containerId) return res.status(400).json({ error: 'Missing required query param: id' });
  // start is optional -- omitted means page 0, so existing callers
  // (playlist track lists) are unaffected. total lets the browsing UI
  // know whether there's another page worth offering.
  const start = parseInt(req.query.start, 10) || 0;
  const { items, total } = await sonos.getContainerPage(req.params.room, containerId, start);
  res.json({ items, total, start });
}));

// ---------------- Sonos Playlist management ----------------
// See the comment block above these functions in sonos.js for why this
// only applies to Sonos Playlists (SQ:) and not Imported Playlists.

app.post('/api/sonos/playlists', asyncHandler(async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'A playlist needs a name' });
  const playlist = await sonos.createSonosPlaylist(title);
  res.json({ playlist });
}));

// Rename a Sonos Playlist -- currentTitle rides along because Sonos's
// UpdateObject matches the existing tag value before applying the new.
app.put('/api/sonos/playlists/:id', asyncHandler(async (req, res) => {
  const newTitle = String(req.body.title || '').trim();
  const currentTitle = String(req.body.currentTitle || '').trim();
  if (!newTitle) return res.status(400).json({ error: 'A playlist needs a name' });
  await sonos.renameSonosPlaylist(req.params.id, currentTitle, newTitle);
  res.json({ ok: true });
}));

app.delete('/api/sonos/playlists/:id', asyncHandler(async (req, res) => {
  const ok = await sonos.deleteSonosPlaylist(req.params.id);
  res.json({ ok });
}));

// Accepts either a single track (uri) or a whole album/container
// (containerId) -- the UI offers "add to playlist" at both levels.
app.post('/api/sonos/playlists/:id/add', asyncHandler(async (req, res) => {
  const { uri, containerId, room, metadata } = req.body;
  if (containerId) {
    const result = await sonos.addContainerToPlaylist(room, req.params.id, containerId);
    return res.json(result);
  }
  if (!uri) return res.status(400).json({ error: 'Provide either uri or containerId' });
  const result = await sonos.addUriToPlaylist(req.params.id, uri, metadata);
  res.json(result);
}));

app.delete('/api/sonos/playlists/:id/track/:index', asyncHandler(async (req, res) => {
  const result = await sonos.removeTrackFromPlaylist(req.params.id, parseInt(req.params.index, 10));
  res.json(result);
}));

app.post('/api/sonos/room/:room/save-queue', asyncHandler(async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'A playlist needs a name' });
  const playlist = await sonos.saveQueueAsPlaylist(req.params.room, title);
  res.json({ playlist });
}));

app.get('/api/sonos/room/:room/music-library', asyncHandler(async (req, res) => {
  res.json({ categories: sonos.getMusicLibraryCategories() });
}));

app.get('/api/sonos/linein-rooms', asyncHandler(async (req, res) => {
  const rooms = await sonos.getLineInRooms();
  res.json({ rooms });
}));

app.post('/api/sonos/room/:room/play-item', asyncHandler(async (req, res) => {
  // Troubleshooting trail: the raw service name Sonos reports for
  // whatever just played, plus the normalized music_services.js key it
  // needs. If a source shows the wrong name/icon in the panel, this
  // line in the Docker log is the answer.
  const rawLabel = req.body.serviceLabel;
  const key = String(rawLabel || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  debugLog.info('sonos', `Play source: "${rawLabel || '(no service label)'}" | music_services.js key: "${key}" | uri scheme: ${String(req.body.uri || '').split(':')[0]}`);
  await sonos.playItem(req.params.room, req.body.uri, req.body.metadata);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/play-playlist-track', asyncHandler(async (req, res) => {
  const { playlistId, playlistTitle, uri } = req.body;
  if (!playlistId || !uri) {
    return res.status(400).json({ error: 'Missing required fields: playlistId, uri' });
  }
  await sonos.playPlaylistTrack(req.params.room, playlistId, playlistTitle, uri);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/play-linein', asyncHandler(async (req, res) => {
  // :room is the TARGET room (who starts playing -- the one you had
  // focused). sourceRoom is whose physical line-in input to relay; if
  // omitted, defaults to the target room itself (the simple "activate my
  // own line-in" case).
  const sourceRoom = req.body.sourceRoom || req.params.room;
  debugLog.info('server', `play-linein request: target=${req.params.room} body.sourceRoom=${req.body.sourceRoom} resolved sourceRoom=${sourceRoom}`);
  await sonos.playLineInFrom(req.params.room, sourceRoom);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/playmode', asyncHandler(async (req, res) => {
  await sonos.setPlayMode(req.params.room, req.body.mode);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

// Repeat cycle: off -> all -> one. Rides the same play-mode string as
// shuffle, so it's available exactly where shuffle is (queue-backed
// playback, which includes playlists).
app.post('/api/sonos/room/:room/repeat', asyncHandler(async (req, res) => {
  await sonos.setRepeat(req.params.room, req.body.mode);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/shuffle', asyncHandler(async (req, res) => {
  await sonos.setShuffle(req.params.room, req.body.enabled);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/crossfade', asyncHandler(async (req, res) => {
  await sonos.setCrossfade(req.params.room, req.body.enabled);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/sleeptimer', asyncHandler(async (req, res) => {
  await sonos.setSleepTimer(req.params.room, req.body.minutes);
  res.json({ ok: true });
}));

app.get('/api/sonos/room/:room/settings', asyncHandler(async (req, res) => {
  const settings = await sonos.getRoomSettings(req.params.room);
  res.json(settings);
}));

app.post('/api/sonos/room/:room/bass', asyncHandler(async (req, res) => {
  await sonos.setBass(req.params.room, req.body.value);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/treble', asyncHandler(async (req, res) => {
  await sonos.setTreble(req.params.room, req.body.value);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/loudness', asyncHandler(async (req, res) => {
  await sonos.setLoudness(req.params.room, req.body.enabled);
  res.json({ ok: true });
}));

// ---------------- Queue management ----------------
app.get('/api/sonos/room/:room/queue', asyncHandler(async (req, res) => {
  const start = parseInt(req.query.start, 10) || 0;
  res.json(await sonos.getQueue(req.params.room, start));
}));

// Add to queue: single track {uri, metadata} or a whole container
// {containerId} -- local L: albums, Sonos playlists, library albums all
// work, capped at 500 tracks. mode: 'now' (insert after current + jump,
// keeps the rest of the queue), 'next', or 'end' (default).
app.post('/api/sonos/room/:room/queue/add', asyncHandler(async (req, res) => {
  const { mode, uri, metadata, containerId } = req.body;
  const m = ['now', 'next', 'end'].includes(mode) ? mode : 'end';
  const result = containerId
    ? await sonos.addContainerToQueue(req.params.room, containerId, m)
    : await sonos.addTracksToQueue(req.params.room, [{ uri, metadata }], m);
  if (m === 'now') triggerSonosFastPoll([req.params.room]);
  res.json(result);
}));

app.post('/api/sonos/room/:room/queue/remove', asyncHandler(async (req, res) => {
  const trackNo = parseInt(req.body.trackNo, 10);
  if (!trackNo || trackNo < 1) return res.status(400).json({ error: 'trackNo (1-based) required' });
  await sonos.removeQueueTrack(req.params.room, trackNo);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/queue/move', asyncHandler(async (req, res) => {
  const from = parseInt(req.body.from, 10);
  const insertBefore = parseInt(req.body.insertBefore, 10);
  if (!from || !insertBefore) return res.status(400).json({ error: 'from and insertBefore (1-based) required' });
  await sonos.moveQueueTrack(req.params.room, from, insertBefore);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/queue/clear', asyncHandler(async (req, res) => {
  await sonos.clearQueue(req.params.room);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/queue/jump', asyncHandler(async (req, res) => {
  const trackNo = parseInt(req.body.trackNo, 10);
  if (!trackNo || trackNo < 1) return res.status(400).json({ error: 'trackNo (1-based) required' });
  await sonos.jumpToQueueTrack(req.params.room, trackNo);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true });
}));

// Called on group-slider grab so Sonos snapshots member ratios before
// the drag's SetGroupVolume stream (balance survives a trip to zero).
app.post('/api/sonos/room/:room/group-volume/snapshot', asyncHandler(async (req, res) => {
  await sonos.snapshotGroupVolume(req.params.room);
  res.json({ ok: true });
}));

// ---------------- Local Music Library (Phase 1: streaming) ----------------
// See server/localLibrary.js for the why. These four routes are the
// hardware-verification harness: prove real speakers will play, seek,
// and chain tracks served from here BEFORE building the scanner/index/
// browse UI on top. The /api/local/* shapes may still change; /stream/
// is intended to be the stable, permanent audio URL format.

app.get('/api/local/status', (req, res) => {
  const enabled = localLibrary.isEnabled();
  res.json({
    enabled,
    musicDir: localLibrary.MUSIC_DIR,
    streamBase: enabled ? localLibrary.getPublicBaseUrl() : null,
    publicBaseUrlSource: process.env.PUBLIC_BASE_URL ? 'env' : 'auto-detect',
    phase: 3,
    scanner: localScanner.getStatus()
  });
});

// Category roots for the Local Music Library browse UI -- same shape
// as the Sonos music-library categories endpoint the client already
// renders. Room-independent (the index lives on the panel).
app.get('/api/local/library-categories', (req, res) => {
  res.json({ categories: localBrowse.getCategories() });
});

// Kick off a rescan on demand. Returns immediately; watch progress via
// /api/local/status or the 'local:scan' WebSocket broadcasts.
app.post('/api/local/rescan', (req, res) => {
  const result = localScanner.startScan('manual');
  res.status(result.ok ? 200 : (result.alreadyScanning ? 409 : 503)).json(result);
});

// The incompatible list with reasons (the plain-text file in appdata
// has the paths only, one per line, as specified).
app.get('/api/local/incompatible', (req, res) => {
  if (!localScanner.isAvailable()) {
    return res.status(503).json({ error: 'Library index is not available' });
  }
  res.json({ files: localScanner.getIncompatibleList() });
});

// Browse the raw folder tree -- lets you find test file paths without
// shelling into the container. ?dir= is relative to the music root.
app.get('/api/local/ls', (req, res) => {
  if (!localLibrary.isEnabled()) {
    return res.status(503).json({ error: 'Local Music Library is not enabled (no Music Path mounted)' });
  }
  const listing = localLibrary.listDir(req.query.dir || '');
  if (!listing) return res.status(404).json({ error: 'Folder not found (or path not allowed)' });
  res.json(listing);
});

// The actual audio endpoint the SPEAKERS fetch from. res.sendFile
// handles HTTP Range requests (partial content) automatically, which
// Sonos requires for seeking within a track. Content-Type comes from
// our own explicit map (see localLibrary.js) rather than a generic
// mime lookup, passed via options.headers which Express applies last.
app.get('/stream/*', (req, res) => {
  if (!localLibrary.isEnabled()) {
    return res.status(503).json({ error: 'Local Music Library is not enabled' });
  }
  const rel = req.params[0] || '';
  const abs = localLibrary.resolveSafe(rel);
  if (!abs || !localLibrary.isAudioFile(abs)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(abs, {
    dotfiles: 'deny',
    headers: { 'Content-Type': localLibrary.contentTypeFor(abs) }
  }, (err) => {
    if (err && !res.headersSent) {
      res.status(err.statusCode === 404 || err.code === 'ENOENT' ? 404 : 500).end();
    }
  });
});

// Extracted embedded covers, cached by the scanner under appdata.
// Filenames are strictly <sha1>.<ext>, validated here, so there is no
// path to traverse. Effectively immutable (the hash is the album
// folder), hence the long cache lifetime.
app.get('/art/embedded/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9]{40}\.(jpg|jpeg|png|gif|webp)$/.test(file)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const abs = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'artcache', file);
  res.sendFile(abs, {
    dotfiles: 'deny',
    headers: { 'Cache-Control': 'public, max-age=604800' }
  }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Album art endpoint -- same path rules as /stream/ but images only,
// so the two routes can't be used to reach each other's file types.
// Art is fetched by the speakers/app repeatedly, hence the cache header.
app.get('/art/*', (req, res) => {
  if (!localLibrary.isEnabled()) {
    return res.status(503).json({ error: 'Local Music Library is not enabled' });
  }
  const abs = localLibrary.resolveSafe(req.params[0] || '');
  if (!abs || !localLibrary.isImageFile(abs)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(abs, {
    dotfiles: 'deny',
    headers: {
      'Content-Type': localLibrary.imageContentTypeFor(abs),
      'Cache-Control': 'public, max-age=86400'
    }
  }, (err) => {
    if (err && !res.headersSent) {
      res.status(err.statusCode === 404 || err.code === 'ENOENT' ? 404 : 500).end();
    }
  });
});

// Diagnostic: what does the SPEAKER say about the current session?
// Queue mode vs direct URI, transport state, and -- the key field --
// which transport actions the speaker will accept right now.
app.get('/api/local/room/:room/debug-transport', asyncHandler(async (req, res) => {
  res.json(await sonos.getTransportDebug(req.params.room));
}));

// TEST HARNESS: queue one or more local files on a room and play them.
// Body: { "paths": ["Artist/Album/01 Song.flac", ...] } -- paths
// relative to the music root. Builds full HTTP URIs + DIDL metadata and
// runs the same flush -> queue -> selectQueue -> play sequence the
// playlist playback path already uses, so what this verifies is exactly
// what the real feature will do. NOTE: replaces the room's current
// queue, deliberately -- it's a test endpoint, not the final UX.
app.post('/api/local/room/:room/test-play', asyncHandler(async (req, res) => {
  if (!localLibrary.isEnabled()) {
    return res.status(503).json({ error: 'Local Music Library is not enabled' });
  }
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  if (paths.length === 0 || paths.length > 50) {
    return res.status(400).json({ error: 'Provide 1-50 relative file paths in "paths"' });
  }
  if (!localLibrary.getPublicBaseUrl()) {
    return res.status(500).json({ error: 'No stream base URL -- set PUBLIC_BASE_URL' });
  }
  const tracks = [];
  for (const rel of paths) {
    const abs = localLibrary.resolveSafe(rel);
    if (!abs || !localLibrary.isAudioFile(abs) || !fs.existsSync(abs)) {
      return res.status(400).json({ error: `Not a playable file under the music root: ${rel}` });
    }
    const durationSeconds = await localLibrary.getTrackDurationSeconds(abs);
    tracks.push({ uri: localLibrary.buildStreamUri(rel), durationSeconds, ...localLibrary.describeTrack(rel) });
  }
  await sonos.playTracksAsQueue(req.params.room, tracks);
  triggerSonosFastPoll([req.params.room]);
  res.json({ ok: true, queued: tracks.map((t) => ({ title: t.title, uri: t.uri })) });
}));

// ---------------- Boot ----------------

async function main() {
  debugLog.info('server', 'Initializing Sonos...');
  await sonos.init();
  localLibrary.logStartupState();
  const scannerReady = localScanner.init({
    onProgress: (progress) => {
      // broadcast is defined a few lines down; guard for the tiny
      // window before it exists (init itself doesn't emit).
      if (typeof broadcastScan === 'function') broadcastScan(progress);
    }
  });

  const server = app.listen(PORT, () => {
    debugLog.info('server', `Sonos Panel v${PKG_VERSION} listening on http://localhost:${PORT}`);
    debugLog.info('server', `Sonos mock mode: ${sonos.isMock()}`);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', sonosMock: sonos.isMock() }));
  });

  function broadcast(payload) {
    const msg = JSON.stringify(payload);
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(msg);
    });
  }

  // Scanner progress -> clients. Sent per batch commit plus on scan
  // start/finish, so a library tab can show live scan progress.
  function broadcastScan(progress) {
    broadcast({ type: 'local:scan', ...progress });
  }
  // Startup rescan, per spec: every container boot re-syncs the index
  // with the folder. Incremental (unchanged files are stat-and-skip),
  // so on an already-indexed library this is quick. Runs AFTER the
  // server is listening so the panel is usable immediately.
  if (scannerReady) localScanner.startScan('startup');

  // Live change events -> clients: queue edits (from anywhere,
  // including the phone app) and favorites/playlists changes.
  sonos.setQueueChangedCallback((room) => broadcast({ type: 'queue:changed', room: room || null }));
  sonos.setLibraryChangedCallback((what) => broadcast({ type: 'library:changed', ...what }));

  // Real-time push updates from sonos.js (PlayState/Volume/Muted/topology
  // events) call this the instant something changes, independent of
  // the poll loop below.
  sonos.onLiveUpdate((rooms) => {
    broadcast({ type: 'sonos:rooms', rooms });
  });

  // Two lightweight signals -- these don't carry the changed data
  // themselves, they just tell the client "go re-fetch this if it's
  // relevant to what you're currently showing" (see the client-side
  // handling in app.js/sonosView.js for why -- reusing the client's
  // existing refresh logic rather than duplicating it here).
  sonos.onNowPlayingChanged((room) => {
    broadcast({ type: 'sonos:nowplaying-changed', room });
  });
  sonos.onGroupVolumeChanged(() => {
    broadcast({ type: 'sonos:groupvolume-changed' });
  });

  // Lets route handlers (see the optimistic patch in /api/sonos/group
  // and .../ungroup) push the current cached room list immediately,
  // rather than waiting for the next scheduled poll tick to pick it up.
  broadcastNow = () => {
    broadcast({ type: 'sonos:rooms', rooms: sonos.getLastKnownRooms() });
  };

  function scheduleSonosPoll() {
    const burstActive = Date.now() < sonosFastPollUntil;
    const useTargeted = burstActive && !sonosFastPollFullPoll && sonosFastPollTargets.size > 0;
    const useFullBurst = burstActive && sonosFastPollFullPoll;
    // Targeted bursts run at the tightened interval (they only touch 1-2
    // devices); full bursts (grouping/ungrouping) run at the more
    // conservative interval since they touch every device regardless of
    // how fast they're ticking.
    let interval = POLL_INTERVAL_MS;
    if (useTargeted) interval = SONOS_FAST_POLL_INTERVAL_MS;
    else if (useFullBurst) interval = SONOS_FULL_POLL_INTERVAL_MS;

    setTimeout(async () => {
      try {
        const rooms = useTargeted
          ? await sonos.getRoomsTargeted([...sonosFastPollTargets])
          : await sonos.getRooms();
        broadcast({ type: 'sonos:rooms', rooms });
      } catch (err) {
        debugLog.warn('server', `poll loop (sonos) error: ${err.message}`);
      }
      scheduleSonosPoll();
    }, interval);
  }
  scheduleSonosPoll();

  // Genuinely independent safety-net timer, decoupled entirely from the
  // burst/targeted scheduler above. The recursive scheduler can end up
  // staying in "targeted-only" mode indefinitely during active use --
  // any volume/play/group action extends the fast-poll burst window
  // another 5 seconds, so continuous normal usage can keep it from ever
  // falling back to a full untargeted poll for a long stretch. Since
  // only a FULL poll re-checks devices that aren't part of whatever's
  // currently targeted, that meant a reconnected room sitting outside
  // the active target set could go unnoticed indefinitely. This runs
  // on its own fixed cadence no matter what the other timer is doing,
  // guaranteeing every room gets a fresh reachability check regularly.
  setInterval(async () => {
    try {
      const rooms = await sonos.getRooms();
      broadcast({ type: 'sonos:rooms', rooms });
    } catch (err) {
      debugLog.warn('server', `safety-net full poll error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  debugLog.error('server', `Fatal startup error: ${err.message}`);
  process.exit(1);
});
