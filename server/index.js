// server/index.js
//
// Run with: npm install && npm start
// Then open http://localhost:3000

const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const sonos = require('./sonos');
const debugLog = require('./debugLog');

const PORT = process.env.PORT || 3000;
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

const POLL_INTERVAL_MS = 2000;
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
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  await sonos.groupRooms(req.body.rooms);
  const [coordinatorName] = req.body.rooms;
  // Reflect the intended grouping immediately, rather than waiting on
  // Sonos's own join-settling time (which can genuinely take several
  // seconds) before the UI shows anything. The full poll triggered right
  // after corrects this if reality ends up differing.
  sonos.patchCoordinatorOptimistically(req.body.rooms, coordinatorName);
  if (broadcastNow) broadcastNow();
  // Topology itself changed -- other rooms' displayed "coordinator"
  // label can shift too, not just the ones just grouped, so this needs
  // a full untargeted poll rather than a scoped one.
  triggerSonosFastPoll();
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/ungroup', asyncHandler(async (req, res) => {
  await sonos.ungroupRoom(req.params.room);
  // Ungrouping makes a room its own coordinator again.
  sonos.patchCoordinatorOptimistically([req.params.room], req.params.room);
  if (broadcastNow) broadcastNow();
  // Same reasoning as /api/sonos/group above -- topology changed.
  triggerSonosFastPoll();
  res.json({ ok: true });
}));

app.get('/api/sonos/room/:room/source-groups', asyncHandler(async (req, res) => {
  const groups = await sonos.getSourceGroups(req.params.room);
  res.json({ groups });
}));

app.get('/api/sonos/room/:room/favorites-by-group', asyncHandler(async (req, res) => {
  const group = req.query.group;
  if (!group) return res.status(400).json({ error: 'Missing required query param: group' });
  const items = await sonos.getFavoritesByGroup(req.params.room, group);
  res.json({ items });
}));

app.get('/api/sonos/room/:room/playlists', asyncHandler(async (req, res) => {
  const items = await sonos.getPlaylists(req.params.room);
  res.json({ items });
}));

app.get('/api/sonos/room/:room/browse-container', asyncHandler(async (req, res) => {
  const containerId = req.query.id;
  if (!containerId) return res.status(400).json({ error: 'Missing required query param: id' });
  const items = await sonos.getCachedContainerItems(req.params.room, containerId);
  res.json({ items });
}));

app.get('/api/sonos/linein-rooms', asyncHandler(async (req, res) => {
  const rooms = await sonos.getLineInRooms();
  res.json({ rooms });
}));

app.post('/api/sonos/room/:room/play-item', asyncHandler(async (req, res) => {
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

// ---------------- Boot ----------------

async function main() {
  debugLog.info('server', 'Initializing Sonos...');
  await sonos.init();

  const server = app.listen(PORT, () => {
    debugLog.info('server', `Listening on http://localhost:${PORT}`);
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
}

main().catch((err) => {
  debugLog.error('server', `Fatal startup error: ${err.message}`);
  process.exit(1);
});
