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
const POLL_INTERVAL_MS = 2000;
const SONOS_FAST_POLL_INTERVAL_MS = 500;

// Brief burst of faster Sonos polling right after a room/volume/group
// action, then back to the normal 2s cadence -- per request, room
// grouping/ungrouping and volume changes felt slow to reflect. Kept
// short and only triggered by actual user actions (rather than just
// always polling faster) specifically to avoid hammering 9+ physical
// speakers continuously -- this project already hit a real
// "excessive hub load" style problem once before on different
// hardware from polling too aggressively, so this stays deliberately
// bounded rather than a blanket speedup.
const SONOS_FAST_POLL_BURST_MS = 5000;
let sonosFastPollUntil = 0;
function triggerSonosFastPoll() {
  sonosFastPollUntil = Date.now() + SONOS_FAST_POLL_BURST_MS;
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

// ---------------- Theme ----------------

app.get('/api/theme', (req, res) => {
  res.json({ color: THEME_COLOR });
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
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/pause', asyncHandler(async (req, res) => {
  await sonos.pause(req.params.room);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/next', asyncHandler(async (req, res) => {
  await sonos.next(req.params.room);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/previous', asyncHandler(async (req, res) => {
  await sonos.previous(req.params.room);
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/volume', asyncHandler(async (req, res) => {
  await sonos.setVolume(req.params.room, req.body.volume);
  triggerSonosFastPoll();
  res.json({ ok: true });
}));

app.get('/api/sonos/room/:room/group-volume', asyncHandler(async (req, res) => {
  const volume = await sonos.getGroupVolume(req.params.room);
  res.json({ volume });
}));

app.post('/api/sonos/room/:room/group-volume', asyncHandler(async (req, res) => {
  await sonos.setGroupVolume(req.params.room, req.body.volume);
  triggerSonosFastPoll();
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/mute', asyncHandler(async (req, res) => {
  await sonos.setMute(req.params.room, req.body.muted);
  triggerSonosFastPoll();
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/group-mute', asyncHandler(async (req, res) => {
  await sonos.setGroupMute(req.params.room, req.body.muted);
  triggerSonosFastPoll();
  res.json({ ok: true });
}));

app.post('/api/sonos/group', asyncHandler(async (req, res) => {
  await sonos.groupRooms(req.body.rooms);
  triggerSonosFastPoll();
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/ungroup', asyncHandler(async (req, res) => {
  await sonos.ungroupRoom(req.params.room);
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
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/play-playlist-track', asyncHandler(async (req, res) => {
  const { playlistId, playlistTitle, uri } = req.body;
  if (!playlistId || !uri) {
    return res.status(400).json({ error: 'Missing required fields: playlistId, uri' });
  }
  await sonos.playPlaylistTrack(req.params.room, playlistId, playlistTitle, uri);
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
  res.json({ ok: true });
}));

app.post('/api/sonos/room/:room/playmode', asyncHandler(async (req, res) => {
  await sonos.setPlayMode(req.params.room, req.body.mode);
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

  function scheduleSonosPoll() {
    const interval = Date.now() < sonosFastPollUntil ? SONOS_FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    setTimeout(async () => {
      try {
        const rooms = await sonos.getRooms();
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
