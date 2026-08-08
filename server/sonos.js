// server/sonos.js
//
// Wraps the `sonos` npm package for discovery + control, with a mock
// fallback when no real devices are found.
//
// SOURCE BROWSING ARCHITECTURE (read this before touching browse-related
// code): Sonos speakers themselves proxy browsing into linked services
// (Spotify, Pandora, Amazon Music, etc.) over UPnP -- the ContentDirectory
// service's generic Browse action works the same way regardless of what
// you're browsing, you just need the right ObjectID. This module
// implements a GENERIC recursive browser (browseContainer) built on that
// primitive, which is what lets Favorites/Playlists/Radio support real
// nested folders exactly like the app, rather than a flat one-level list.
//
// What's solid and verified-by-reading-the-library-source:
//   - FV:2   = Sonos Favorites
//   - SQ:    = Sonos Playlists
//   - R:0/0  = Sonos Radio
//   - browseContainer() generically recurses into whatever containers
//     these (or their children) return
//
// What's honestly NOT supported: browsing into a specific third-party
// service (Amazon Music, Pandora, Spotify, etc.) the way the official app
// does. Sonos's local ListAvailableServices call was tried and confirmed
// (against a real household) to return the ENTIRE global catalog of
// 100+ possible services, not the handful actually linked to this
// account -- there's no reliable local-only way to filter that down.
// The official app's clean list comes from Sonos's cloud account data,
// which is a separate integration (registered developer app + OAuth).
// See the note above getSourceCategories() for the full story.

const { Sonos, AsyncDeviceDiscovery, Helpers, Services, Listener } = require('sonos');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const debugLog = require('./debugLog');

// Manual overrides that are more reliable than guessing at UPnP fields --
// see getLineInRooms() for why this exists. Missing/invalid config.json
// just means every override defaults to off, not a startup failure.
// DATA_DIR is configurable (defaults to ./data) specifically so this can
// be cleanly volume-mounted in Docker without also exposing the rest of
// the app's own code as a mount target.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let config = {};
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  config = require(path.join(dataDir, 'config.json'));
} catch (err) {
  config = {};
}

const DISCOVERY_TIMEOUT_MS = 8000;

// Saved room-group presets -- the equivalent of the official Sonos app's
// "Saved Groups" feature, which turned out to be a cloud-account-only
// feature (nothing in the local UPnP API exposes it, confirmed against
// SoCo's fairly exhaustive feature set). This reimplements the same
// practical outcome locally: a name plus a list of room names, stored
// as a JSON file in dataDir so it survives container updates the same
// way config.json does. Applying one just calls the existing groupRooms
// with its stored room list -- no new grouping logic needed.
const savedGroupsPath = path.join(dataDir, 'saved-groups.json');
function loadSavedGroups() {
  try {
    return JSON.parse(fs.readFileSync(savedGroupsPath, 'utf8'));
  } catch (err) {
    return [];
  }
}
function writeSavedGroups(groups) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(savedGroupsPath, JSON.stringify(groups, null, 2));
}
function getSavedGroups() {
  return loadSavedGroups();
}
function addSavedGroup(name, roomNames) {
  const groups = loadSavedGroups();
  const group = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (name || '').trim() || roomNames.join(' + '),
    rooms: roomNames
  };
  groups.push(group);
  writeSavedGroups(groups);
  return group;
}
function deleteSavedGroup(id) {
  writeSavedGroups(loadSavedGroups().filter((g) => g.id !== id));
}
function updateSavedGroup(id, name, roomNames) {
  const groups = loadSavedGroups();
  const group = groups.find((g) => g.id === id);
  if (!group) return null;
  group.name = (name || '').trim() || roomNames.join(' + ');
  group.rooms = roomNames;
  writeSavedGroups(groups);
  return group;
}

let usingMock = true;
let devicesByName = new Map();
let displayNameByKey = new Map();
let mockState = buildMockState();

// Cache of the last full getRooms() result, keyed by room name, plus the
// last known topology (roomName -> coordinatorName). Targeted polling
// (see getRoomsTargeted) reads/writes this so it can return a complete
// room list while only actually querying the devices that changed --
// everyone else's entry is just whatever the last full poll saw.
let lastRoomsByName = new Map();
let lastCoordinatorMap = {};

// Real-time push updates (see attachDeviceEventListeners/attachTopologyListener
// below) call this instead of waiting for the next poll tick to notice a
// change. index.js registers a callback here once at boot that broadcasts
// straight to connected clients.
let liveUpdateCallback = null;
function onLiveUpdate(callback) {
  liveUpdateCallback = callback;
}
function notifyLiveUpdate() {
  if (liveUpdateCallback) liveUpdateCallback(getLastKnownRooms());
}

// Two more lightweight signals, separate from the room-list update above --
// these don't carry new data themselves, they just tell index.js "go tell
// the client to re-fetch this," reusing the client's own existing
// refreshNowPlaying()/syncVolumeRailToFocusedRoom() rather than us trying
// to reconstruct their already-fairly-involved logic (source-line
// detection, Line-In relay lookups, etc.) a second time from a raw event
// payload. Cheap and safe even if the room isn't the one currently
// focused in the browser -- the client just checks and no-ops otherwise.
let nowPlayingChangedCallback = null;
function onNowPlayingChanged(callback) {
  nowPlayingChangedCallback = callback;
}
let groupVolumeChangedCallback = null;
function onGroupVolumeChanged(callback) {
  groupVolumeChangedCallback = callback;
}

function buildMockState() {
  return {
    rooms: [
      { name: 'Living Room', volume: 34, playing: true, muted: false, reachable: true, coordinator: 'Living Room' },
      { name: 'Kitchen', volume: 28, playing: true, muted: false, reachable: true, coordinator: 'Living Room' },
      { name: 'Patio', volume: 45, playing: false, muted: false, reachable: true, coordinator: 'Patio' },
      { name: 'Office', volume: 20, playing: false, muted: false, reachable: true, coordinator: 'Office' }
    ],
    nowPlaying: {
      'Living Room': {
        title: 'Nightswimmer', artist: 'Fixture Artist', album: 'Sample Sessions Radio',
        albumArtUrl: null, playing: true, position: 48, duration: 213, playMode: 'NORMAL',
        sourceLine: 'Pandora - Sample Sessions Radio'
      },
      Patio: {
        title: '', artist: 'CD Player', album: '', albumArtUrl: null, playing: true, position: 0, duration: 0, playMode: 'NORMAL',
        sourceLine: 'Line-In - Living Room', lineInDeviceName: 'CD Player'
      },
      Office: { title: '', artist: '', album: '', albumArtUrl: null, playing: false, position: 0, duration: 0, playMode: 'NORMAL', sourceLine: null }
    },
    // Mock browse tree, keyed by container id, so the UI's recursive
    // navigation is exercisable without real hardware.
    browse: {
      'FV:2': [
        { id: 'FV:2/mock-1', title: 'Morning Jazz (mock favorite)', albumArtUrl: null, browsable: false, uri: 'mock://fav1', serviceLabel: 'Pandora' },
        { id: 'FV:2/mock-2', title: 'Classic Rock Radio (mock favorite)', albumArtUrl: null, browsable: false, uri: 'mock://fav2', serviceLabel: 'iHeartRadio' }
      ],
      'SQ:': [
        { id: 'SQ:mock-1', title: 'Road Trip Mix (mock playlist)', albumArtUrl: null, browsable: true, uri: null, serviceLabel: null }
      ],
      'SQ:mock-1': [
        { id: 'SQ:mock-1/t1', title: 'Mock Track One', albumArtUrl: null, browsable: false, uri: 'mock://track1', serviceLabel: 'Plex' }
      ],
      'R:0/0': [
        { id: 'R:0/0/mock-1', title: 'By Genre (mock)', albumArtUrl: null, browsable: true },
        { id: 'R:0/0/mock-2', title: '80s Hits Radio (mock)', albumArtUrl: null, browsable: false, uri: 'mock://radio1', serviceLabel: 'Sonos Radio' }
      ],
      'R:0/0/mock-1': [
        { id: 'R:0/0/mock-1/a', title: 'Rock (mock)', albumArtUrl: null, browsable: false, uri: 'mock://genre-rock', serviceLabel: 'Sonos Radio' }
      ]
    }
  };
}

async function getSoftwareGeneration(device) {
  try {
    const res = await axios.get(`http://${device.host}:1400/status/zp`, { timeout: 4000 });
    const match = String(res.data).match(/<SWGen>(\d+)<\/SWGen>/i);
    return match ? parseInt(match[1], 10) : null; // null = couldn't determine
  } catch (err) {
    debugLog.warn('sonos', `Could not determine software generation for ${device.host}: ${err.message}`);
    return null;
  }
}

async function init() {
  try {
    const discovery = new AsyncDeviceDiscovery();
    const found = await discovery.discoverMultiple({ timeout: DISCOVERY_TIMEOUT_MS });
    if (!found || found.length === 0) throw new Error('No Sonos devices found on network');

    // This app is intentionally S2-only: a mix of legacy "S1" and current
    // "S2" Sonos hardware on the same network runs as two entirely
    // separate, non-merging local systems, and here the S1 device is
    // dedicated to a home alarm system that should never be listed or
    // touched by this app. Filter S1 devices out via the community-
    // documented /status/zp SWGen field BEFORE building the room list --
    // note this defaults to INCLUDING a device if its generation can't be
    // determined (network hiccup, unexpected response format), since a
    // silently-missing S2 room is the same class of bug just fixed
    // elsewhere. If the alarm-system Sonos still shows up after this,
    // that means detection failed for it specifically -- flag it and the
    // default can flip to exclude-when-uncertain instead.
    const s2Seeds = [];
    for (const device of found) {
      const gen = await getSoftwareGeneration(device);
      if (gen === 1) {
        debugLog.info('sonos', `Excluding S1 device at ${device.host} (SWGen=1) -- treated as non-S2 hardware, not added to room list`);
        continue;
      }
      debugLog.info('sonos', `Including device at ${device.host} as S2 seed (SWGen=${gen === null ? 'unknown, defaulting to include' : gen})`);
      s2Seeds.push(device);
    }

    if (s2Seeds.length === 0) throw new Error('No S2 Sonos devices found (only S1 device(s) responded, or generation could not be determined for any)');

    // Ask EVERY S2 seed for its own topology and merge all of them --
    // still needed for reliability, since which speaker happens to
    // answer SSDP first can vary.
    devicesByName = new Map();
    displayNameByKey = new Map();
    for (const seedDevice of s2Seeds) {
      try {
        const groups = await seedDevice.getAllGroups();
        for (const zone of groups) {
          for (const member of zone.ZoneGroupMember) {
            const key = member.ZoneName.toLowerCase();
            if (devicesByName.has(key)) continue;
            try {
              const uri = new URL(member.Location);
              devicesByName.set(key, new Sonos(uri.hostname, parseInt(uri.port, 10)));
              displayNameByKey.set(key, member.ZoneName);
            } catch (err) {
              debugLog.warn('sonos', `Could not construct device for zone member ${member.ZoneName}: ${err.message}`);
            }
          }
        }
      } catch (err) {
        debugLog.warn('sonos', `getAllGroups() failed for an S2 seed device: ${err.message}`);
      }
    }

    if (devicesByName.size === 0) throw new Error('Zone topology returned no usable devices');

    usingMock = false;
    debugLog.info('sonos', `Found ${devicesByName.size} S2 device(s) via merged topology: ${[...devicesByName.keys()].join(', ')}`);

    // Real-time push updates for play state, volume, and topology --
    // see the comment above attachDeviceEventListeners for the full
    // reasoning. Attaching the first device's listener also triggers
    // the library's global ZoneGroupTopology subscription automatically.
    devicesByName.forEach((device, key) => {
      const name = displayNameByKey.get(key) || key;
      attachDeviceEventListeners(name, device);
    });
    attachTopologyListener();

    // Warm the Favorites and Playlists caches in the background so the
    // first real visit to Sources doesn't eat a fresh-fetch delay --
    // fire-and-forget, doesn't block startup or affect the
    // fallback-to-mock logic below.
    const anyRoomName = displayNameByKey.values().next().value;
    if (anyRoomName) {
      getFavorites(anyRoomName).catch((err) => {
        debugLog.warn('sonos', `Startup favorites warm-up failed (will retry on first real request): ${err.message}`);
      });
      getPlaylists(anyRoomName).catch((err) => {
        debugLog.warn('sonos', `Startup playlists warm-up failed (will retry on first real request): ${err.message}`);
      });
    }
  } catch (err) {
    usingMock = true;
    debugLog.warn('sonos', `Falling back to MOCK data: ${err.message}`);
  }
}

function findDevice(roomName) {
  return devicesByName.get((roomName || '').toLowerCase()) || null;
}

// Real-time updates, in addition to (not instead of) the polling below --
// see the big comment block above SONOS_FAST_POLL_BURST_MS-equivalent
// constants in index.js for the full reasoning. Short version: the
// `sonos` npm package already maintains its own UPnP event subscriptions
// per device once you attach a listener (it auto-subscribes on first
// .on() call, and auto-renews every 25 min internally) -- attaching to
// PlayState/Volume gets push notifications the instant a speaker's own
// state changes, no polling interval to tune at all for those two. This
// updates the cache directly from the event payload (no extra network
// call needed, unlike a poll) and pushes it out immediately.
//
// Known gap, from reading the library's own source: if a subscription
// renewal fails for any reason other than one specific network error
// code, the library stops retrying that device's renewal permanently,
// with no automatic recovery. That's exactly why polling stays in place
// as a safety net (see POLL_INTERVAL_MS in index.js) rather than this
// being the only source of truth -- a silently-dead subscription would
// otherwise mean that room's live updates just stop forever until a
// restart, with nothing to notice or self-heal it.
function attachDeviceEventListeners(name, device) {
  device.on('PlayState', (state) => {
    try {
      const playing = state === 'playing';
      const existing = lastRoomsByName.get(name) || { name, volume: 0, playing: false, muted: false, reachable: true, coordinator: name };
      lastRoomsByName.set(name, { ...existing, playing });
      notifyLiveUpdate();
    } catch (err) {
      debugLog.warn('sonos', `Error handling PlayState event for ${name}: ${err.message}`);
    }
  });

  device.on('Volume', (volume) => {
    try {
      const existing = lastRoomsByName.get(name) || { name, volume: 0, playing: false, muted: false, reachable: true, coordinator: name };
      lastRoomsByName.set(name, { ...existing, volume });
      notifyLiveUpdate();
    } catch (err) {
      debugLog.warn('sonos', `Error handling Volume event for ${name}: ${err.message}`);
    }
  });

  device.on('Muted', (muted) => {
    try {
      const existing = lastRoomsByName.get(name) || { name, volume: 0, playing: false, muted: false, reachable: true, coordinator: name };
      lastRoomsByName.set(name, { ...existing, muted });
      notifyLiveUpdate();
    } catch (err) {
      debugLog.warn('sonos', `Error handling Muted event for ${name}: ${err.message}`);
    }
  });

  // Raw AVTransport covers more than just play/pause (which PlayState
  // above already handles) -- it also fires on track changes and on
  // shuffle/repeat (CurrentPlayMode) changes. Rather than trying to
  // reconstruct the full now-playing picture from this raw payload
  // (title/artist/art/source-line detection is already fairly involved
  // logic that getNowPlaying() owns), this just signals "something
  // changed for this room" and lets the client re-run its own existing
  // refreshNowPlaying() if that room happens to be the focused one --
  // cheap, safe, and avoids duplicating that logic a second time here.
  device.on('AVTransport', () => {
    try {
      if (nowPlayingChangedCallback) nowPlayingChangedCallback(name);
    } catch (err) {
      debugLog.warn('sonos', `Error handling AVTransport event for ${name}: ${err.message}`);
    }
  });

  // Group volume (the synced slider across a bonded group) is a
  // separate concept from each speaker's own individual volume above.
  // Same lightweight-signal approach as AVTransport -- let the client
  // re-run its existing syncVolumeRailToFocusedRoom() rather than us
  // hand-parsing the raw GroupRenderingControl payload (which the
  // library doesn't parse into clean fields the way it does for plain
  // RenderingControl).
  device.on('GroupRenderingControl', () => {
    try {
      if (groupVolumeChangedCallback) groupVolumeChangedCallback();
    } catch (err) {
      debugLog.warn('sonos', `Error handling GroupRenderingControl event for ${name}: ${err.message}`);
    }
  });
}

// Attached once, globally -- not per-device. The library subscribes to
// the household-wide ZoneGroupTopology service automatically the first
// time ANY device gets a .on() call (see attachDeviceEventListeners),
// so this doesn't need its own separate subscription step, just a
// listener for the event it produces.
let topologyListenerAttached = false;
function attachTopologyListener() {
  if (topologyListenerAttached) return;
  topologyListenerAttached = true;
  Listener.on('ZonesChanged', (zones) => {
    // The library emits 'ZonesChanged' for every ZoneGroupTopology
    // notification, not just ones that actually carry zone data (some
    // are about other topology-related things entirely) -- guard
    // against that rather than assuming zones is always a populated
    // array.
    if (!Array.isArray(zones) || zones.length === 0) return;
    try {
      const map = {};
      zones.forEach((zone) => {
        // zone.Name has a "+N" suffix for multi-member groups (e.g.
        // "Living Room + 2") -- not usable as the coordinator's actual
        // room name, which is what the rest of this app compares
        // against. Resolve the real name via matching the coordinator's
        // host/port against the member list instead.
        const coordinatorMember = zone.Members.find(
          (m) => m.host === zone.Coordinator.host && String(m.port) === String(zone.Coordinator.port)
        );
        const coordinatorName = coordinatorMember ? coordinatorMember.name : null;
        if (!coordinatorName) return;
        zone.Members.forEach((member) => {
          map[member.name] = coordinatorName;
        });
      });
      if (Object.keys(map).length === 0) return;

      lastCoordinatorMap = map;
      lastRoomsByName.forEach((room, name) => {
        if (map[name]) lastRoomsByName.set(name, { ...room, coordinator: map[name] });
      });
      notifyLiveUpdate();
    } catch (err) {
      debugLog.warn('sonos', `Error handling ZonesChanged event: ${err.message}`);
    }
  });
}

async function guarded(actionLabel, fn) {
  try {
    return await fn();
  } catch (err) {
    const message = (err && err.message) || String(err);
    debugLog.error('sonos', `${actionLabel} failed: ${message}`);
    throw new Error(`${actionLabel} failed: ${message}`);
  }
}

async function getCoordinatorMap() {
  const anyDevice = devicesByName.values().next().value;
  if (!anyDevice) return {};
  const groups = await anyDevice.getAllGroups();
  const map = {};
  groups.forEach((zone) => {
    const coordinatorMember = zone.ZoneGroupMember.find((m) => m.UUID === zone.Coordinator);
    const coordinatorName = coordinatorMember ? coordinatorMember.ZoneName : null;
    zone.ZoneGroupMember.forEach((member) => {
      map[member.ZoneName] = coordinatorName || member.ZoneName;
    });
  });
  lastCoordinatorMap = map;
  return map;
}

// Every room name currently sharing a coordinator with roomName
// (including roomName itself) -- i.e. its whole bonded group. Used to
// decide which devices a group-volume/group-mute action needs to
// re-poll, without an extra topology fetch (reads the cached map from
// the last real getCoordinatorMap() call).
function getGroupMemberNames(roomName) {
  const coordinator = lastCoordinatorMap[roomName];
  if (!coordinator) return [roomName];
  return Object.keys(lastCoordinatorMap).filter((name) => lastCoordinatorMap[name] === coordinator);
}

async function getDeviceUUID(roomName) {
  const anyDevice = devicesByName.values().next().value;
  if (!anyDevice) return null;
  const groups = await anyDevice.getAllGroups();
  for (const zone of groups) {
    const member = zone.ZoneGroupMember.find((m) => m.ZoneName.toLowerCase() === roomName.toLowerCase());
    if (member) return member.UUID;
  }
  return null;
}

async function getRoomNameByUUID(uuid) {
  const anyDevice = devicesByName.values().next().value;
  if (!anyDevice) return null;
  const groups = await anyDevice.getAllGroups();
  for (const zone of groups) {
    const member = zone.ZoneGroupMember.find((m) => m.UUID === uuid);
    if (member) return member.ZoneName;
  }
  return null;
}

async function getRooms() {
  if (usingMock) return [...mockState.rooms].sort((a, b) => a.name.localeCompare(b.name));
  return guarded('getRooms', async () => {
    const coordinatorMap = await getCoordinatorMap();
    // Two fixes here: devicesByName is already keyed by name, so calling
    // device.getName() per device was an entirely unnecessary network
    // round-trip every poll tick (names don't change mid-session).
    // Fetching every device's volume/state also now happens in parallel
    // instead of one-at-a-time -- on a 9-room system this was up to 18
    // sequential network calls per tick; now it's just whichever single
    // device responds slowest.
    const rooms = await Promise.all(
      [...devicesByName.entries()].map(async ([key, device]) => {
        const name = displayNameByKey.get(key) || key;
        let volume = 0;
        let playing = false;
        let muted = false;
        let reachable = true;
        try {
          volume = await device.getVolume();
        } catch (err) {
          debugLog.warn('sonos', `getVolume() failed for ${name}: ${err.message}`);
          reachable = false;
        }
        try {
          const state = await device.getCurrentState();
          playing = state === 'playing';
        } catch (err) {
          debugLog.warn('sonos', `getCurrentState() failed for ${name}: ${err.message}`);
        }
        try {
          muted = await device.getMuted();
        } catch (err) {
          debugLog.warn('sonos', `getMuted() failed for ${name}: ${err.message}`);
        }
        return { name, volume, playing, muted, reachable, coordinator: coordinatorMap[name] || name };
      })
    );
    rooms.sort((a, b) => a.name.localeCompare(b.name));
    lastRoomsByName = new Map(rooms.map((r) => [r.name, r]));
    return rooms;
  });
}

// Fast-poll-burst variant: only re-queries the devices in targetRoomNames
// (typically just the room you touched, or its whole group for a
// group-volume/group-mute action) and merges the fresh results into the
// last known full snapshot for everyone else. This is what makes it safe
// to run the burst interval much faster than the normal cadence without
// multiplying request load across every speaker -- a single-room volume
// tweak on a 9-room system now touches 1 device instead of 9, regardless
// of how short the burst interval is.
//
// Falls back to a full getRooms() if the cache is empty (e.g. right after
// startup, before any normal-cadence poll has populated it yet) so a
// burst can never return stale/incomplete data for rooms it's never
// actually seen.
async function getRoomsTargeted(targetRoomNames) {
  if (usingMock) return getRooms();
  if (lastRoomsByName.size === 0) return getRooms();

  return guarded('getRoomsTargeted', async () => {
    const targets = new Set(targetRoomNames);
    const updates = await Promise.all(
      [...devicesByName.entries()]
        .filter(([key]) => targets.has(displayNameByKey.get(key) || key))
        .map(async ([key, device]) => {
          const name = displayNameByKey.get(key) || key;
          let volume = 0;
          let playing = false;
          let muted = false;
          let reachable = true;
          try {
            volume = await device.getVolume();
          } catch (err) {
            debugLog.warn('sonos', `getVolume() failed for ${name}: ${err.message}`);
            reachable = false;
          }
          try {
            const state = await device.getCurrentState();
            playing = state === 'playing';
          } catch (err) {
            debugLog.warn('sonos', `getCurrentState() failed for ${name}: ${err.message}`);
          }
          try {
            muted = await device.getMuted();
          } catch (err) {
            debugLog.warn('sonos', `getMuted() failed for ${name}: ${err.message}`);
          }
          const coordinator = lastCoordinatorMap[name] || name;
          return { name, volume, playing, muted, reachable, coordinator };
        })
    );

    updates.forEach((room) => lastRoomsByName.set(room.name, room));
    return [...lastRoomsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
}

// Group volume: the real mechanism the official app uses for a group's
// "master" slider -- GetGroupVolume/SetGroupVolume operate on the whole
// bonded group via the coordinator, and Sonos itself handles scaling
// each member's individual volume proportionally. Must be called against
// the group's coordinator device (group state lives there).
async function getGroupVolume(roomName) {
  if (usingMock) {
    const room = mockState.rooms.find((r) => r.name === roomName);
    return room ? room.volume : 0;
  }
  const device = findDevice(roomName);
  if (!device) return 0;
  return guarded(`getGroupVolume(${roomName})`, async () => {
    const groupRendering = new Services.GroupRenderingControl(device.host, device.port);
    return groupRendering.GetGroupVolume();
  });
}

async function setGroupVolume(roomName, volume) {
  const clamped = Math.max(0, Math.min(100, Math.round(volume)));
  if (usingMock) {
    const room = mockState.rooms.find((r) => r.name === roomName);
    if (room) room.volume = clamped;
    return;
  }
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`setGroupVolume(${roomName})`, async () => {
    const groupRendering = new Services.GroupRenderingControl(device.host, device.port);
    await groupRendering.SetGroupVolume(clamped);
  });
}

// Tracks which playlist (if any) is currently active per room, so
// getNowPlaying can label the source as "Playlist - <name> - <service>"
// instead of just the track's own service. Cleared whenever a
// different kind of playback starts in that room.
const roomPlaylistContext = new Map();

// Cached briefly (30s) since this gets checked on every now-playing
// poll (every 1-2s) while a playlist plays -- same reasoning as the
// Favorites cache above. Shared/general-purpose: also used directly by
// the browse-container route, so drilling into a playlist right after
// we peeked it (to determine its service) reuses that same fetch
// instead of asking Sonos for the identical data twice.
const CONTAINER_ITEMS_CACHE_MS = 30000;
const containerItemsCache = new Map(); // containerId -> { items, at }

async function getCachedContainerItems(roomName, containerId) {
  const now = Date.now();
  const cached = containerItemsCache.get(containerId);
  if (cached && now - cached.at < CONTAINER_ITEMS_CACHE_MS) {
    return cached.items;
  }
  const items = await browseContainer(roomName, containerId);
  containerItemsCache.set(containerId, { items, at: now });
  return items;
}

async function getCachedPlaylistTrackByUri(roomName, playlistId, uri) {
  try {
    const items = await getCachedContainerItems(roomName, playlistId);
    return items.find((t) => t.uri === uri) || null;
  } catch (err) {
    debugLog.warn('sonos', `getCachedPlaylistTrackByUri: could not browse ${playlistId}: ${err.message}`);
    return null;
  }
}

// Streams/radio (Favorites playing a station, internet radio, etc.) don't
// support shuffle -- there's no queue to shuffle, just a continuous
// stream. Detected via URI scheme rather than gambling on a specific
// field name in Sonos's event data that isn't verified against this
// library's actual behavior. Defaults to "shuffle available" for
// anything unrecognized, since a wrongly-enabled button is a much
// smaller problem than a wrongly-greyed-out one on legitimate content.
// Shuffle only makes sense for actual queue-based playback (a playlist
// or the local library queue) -- a Favorite playing a continuous
// stream/radio station has no queue to shuffle at all. Rather than
// trying to maintain a denylist of every streaming service's URI
// scheme (there are dozens, and an unrecognized one would incorrectly
// leave shuffle enabled), this checks for POSITIVE confirmation
// instead: either we know for certain this room is mid-playlist
// (roomPlaylistContext, set by our own playPlaylistTrack) or the
// current URI is a direct queue reference (x-rincon-queue:, used for
// local library/queue playback). Anything else defaults to
// unavailable -- a rare false negative (shuffle disabled on some
// pre-existing queue playback we didn't initiate) is a much smaller
// problem than the reported bug (shuffle wrongly enabled on a stream).
function isShuffleAvailable(uri, roomName) {
  if (roomPlaylistContext.has(roomName)) return true;
  return !!(uri && uri.startsWith('x-rincon-queue:'));
}

// Sonos combines shuffle+repeat into one enum rather than two
// independent flags -- decompose/compose so the UI can treat shuffle as
// a simple on/off toggle without silently discarding whatever repeat
// mode was already set.
function decomposePlayMode(mode) {
  switch (mode) {
    case 'SHUFFLE': return { shuffle: true, repeat: 'all' };
    case 'SHUFFLE_NOREPEAT': return { shuffle: true, repeat: 'none' };
    case 'SHUFFLE_REPEAT_ONE': return { shuffle: true, repeat: 'one' };
    case 'REPEAT_ALL': return { shuffle: false, repeat: 'all' };
    case 'REPEAT_ONE': return { shuffle: false, repeat: 'one' };
    default: return { shuffle: false, repeat: 'none' };
  }
}
function composePlayMode(shuffle, repeat) {
  if (shuffle) {
    if (repeat === 'all') return 'SHUFFLE';
    if (repeat === 'one') return 'SHUFFLE_REPEAT_ONE';
    return 'SHUFFLE_NOREPEAT';
  }
  if (repeat === 'all') return 'REPEAT_ALL';
  if (repeat === 'one') return 'REPEAT_ONE';
  return 'NORMAL';
}

function parseHmsToSeconds(hms) {
  if (!hms || typeof hms !== 'string') return 0;
  const parts = hms.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  return h * 3600 + m * 60 + s;
}
function secondsToHms(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

async function getNowPlaying(roomName) {
  if (usingMock) {
    return (
      mockState.nowPlaying[roomName] || {
        title: '', artist: '', album: '', albumArtUrl: null, playing: false, position: 0, duration: 0, playMode: 'NORMAL', sourceLine: null,
        shuffleOn: false, shuffleAvailable: true, crossfadeOn: false, sleepTimerRemainingSeconds: 0
      }
    );
  }
  const device = findDevice(roomName);
  if (!device) return null;
  try {
    const [track, state, playMode, crossfadeOn, sleepTimerRemainingSeconds] = await Promise.all([
      device.currentTrack(),
      device.getCurrentState(),
      device.getPlayMode().catch((err) => {
        debugLog.warn('sonos', `getPlayMode() failed for ${roomName}: ${err.message}`);
        return 'NORMAL';
      }),
      device.avTransportService().GetCrossfadeMode().then((r) => Boolean(Number(r.CrossfadeMode))).catch((err) => {
        debugLog.warn('sonos', `GetCrossfadeMode() failed for ${roomName}: ${err.message}`);
        return false;
      }),
      device.avTransportService().GetRemainingSleepTimerDuration().then((r) => parseHmsToSeconds(r.RemainingSleepTimerDuration)).catch((err) => {
        debugLog.warn('sonos', `GetRemainingSleepTimerDuration() failed for ${roomName}: ${err.message}`);
        return 0;
      })
    ]);
    const { shuffle: shuffleOn } = decomposePlayMode(playMode);

    // Source line: identifies WHERE the audio is coming from, since
    // title/artist alone don't cover this -- confirmed useful in
    // practice (a room playing Line-In shows blank title/artist with no
    // other indication anything is even playing). TrackURI reliably
    // carries either a sid= service ID (same pattern as Favorites) or,
    // for Line-In, the UUID of whichever room's input is the actual
    // source (not necessarily this room -- Line-In can be relayed from
    // elsewhere).
    let sourceLine = null;
    let lineInDeviceName = null;
    const playlistContext = roomPlaylistContext.get(roomName);
    if (track.uri) {
      if (track.uri.startsWith('x-rincon-stream:')) {
        const uuid = track.uri.replace('x-rincon-stream:', '').split('?')[0].replace(/:\d+$/, '');
        const originRoom = await getRoomNameByUUID(uuid);
        sourceLine = originRoom ? `Line-In - ${originRoom}` : 'Line-In';
        if (originRoom) lineInDeviceName = await getLineInCurrentName(originRoom);
      } else if (playlistContext) {
        const serviceMap = await loadServiceNameMap();
        const trackServiceLabel = deriveServiceLabel(null, track.uri, serviceMap);
        sourceLine = `Playlist - ${playlistContext.title}${trackServiceLabel ? ` - ${trackServiceLabel}` : ''}`;
      } else {
        const serviceMap = await loadServiceNameMap();
        const serviceLabel = deriveServiceLabel(track, track.uri, serviceMap);
        if (serviceLabel) {
          const stationToken = extractStationToken(track.uri);
          const stationName = await findStationNameFromFavorites(roomName, stationToken);
          sourceLine = stationName ? `${serviceLabel} - ${stationName}` : serviceLabel;
        }
      }
    }

    // Confirmed via real testing: Sonos returns genuinely empty
    // TrackMetaData for queue-based playback (unlike direct-stream
    // playback used everywhere else in this app), even though we sent
    // real metadata when building the queue. track.uri survives even
    // without it, so cross-referencing against the playlist's own
    // track list (which we already fetched to build the queue) recovers
    // the real title/artist/album/art.
    if (playlistContext && !track.title && track.uri) {
      const playlistTrack = await getCachedPlaylistTrackByUri(roomName, playlistContext.id, track.uri);
      if (playlistTrack) {
        track.title = playlistTrack.title;
        track.artist = playlistTrack.artist;
        track.album = playlistTrack.album;
        track.albumArtURL = playlistTrack.albumArtUrl;
      }
    }

    return {
      title: track.title || '',
      artist: lineInDeviceName || track.artist || '',
      lineInDeviceName,
      album: track.album || '',
      albumArtUrl: track.albumArtURL || null,
      playing: state === 'playing',
      position: track.position || 0,
      duration: track.duration || 0,
      playMode,
      shuffleOn,
      shuffleAvailable: isShuffleAvailable(track.uri, roomName),
      crossfadeOn,
      sleepTimerRemainingSeconds,
      sourceLine
    };
  } catch (err) {
    debugLog.warn('sonos', `getNowPlaying(${roomName}) failed: ${err.message}`);
    return null;
  }
}

async function play(roomName) {
  if (usingMock) {
    mockState.nowPlaying[roomName] = mockState.nowPlaying[roomName] || {};
    mockState.nowPlaying[roomName].playing = true;
    return;
  }
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`play(${roomName})`, () => device.play());
}

async function pause(roomName) {
  if (usingMock) {
    mockState.nowPlaying[roomName] = mockState.nowPlaying[roomName] || {};
    mockState.nowPlaying[roomName].playing = false;
    return;
  }
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`pause(${roomName})`, () => device.pause());
}

async function next(roomName) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`next(${roomName})`, () => device.next());
}

async function previous(roomName) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`previous(${roomName})`, () => device.previous());
}

async function setVolume(roomName, vol) {
  const clamped = Math.max(0, Math.min(100, Math.round(vol)));
  if (usingMock) {
    const room = mockState.rooms.find((r) => r.name === roomName);
    if (room) room.volume = clamped;
    return;
  }
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`setVolume(${roomName})`, () => device.setVolume(clamped));
  debugLog.info('sonos', `setVolume(${roomName}) -> ${clamped} (individual room, not group)`);
}

// Real mute (SetMute), not just setting volume to 0 -- preserves the
// underlying volume level so unmuting restores it, matching how the
// mute button is expected to behave. Mirrors the existing
// solo-room-vs-group volume pattern exactly.
async function setMute(roomName, muted) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`setMute(${roomName})`, () => device.setMuted(muted));
}

async function setGroupMute(roomName, muted) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`setGroupMute(${roomName})`, async () => {
    const groupRendering = new Services.GroupRenderingControl(device.host, device.port);
    await groupRendering.SetGroupMute(muted);
  });
}

async function setPlayMode(roomName, mode) {
  if (usingMock) {
    if (mockState.nowPlaying[roomName]) mockState.nowPlaying[roomName].playMode = mode;
    return;
  }
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`setPlayMode(${roomName}, ${mode})`, () => device.setPlayMode(mode));
}

// Shuffle is exposed as a simple on/off toggle in the UI, but Sonos
// combines it with repeat into one enum (see decomposePlayMode/
// composePlayMode above) -- so toggling it needs to read the CURRENT
// mode first and preserve whatever repeat setting was already active,
// rather than always resetting to a fixed mode.
async function setShuffle(roomName, enabled) {
  if (usingMock) {
    if (mockState.nowPlaying[roomName]) {
      const { repeat } = decomposePlayMode(mockState.nowPlaying[roomName].playMode || 'NORMAL');
      mockState.nowPlaying[roomName].playMode = composePlayMode(enabled, repeat);
    }
    return;
  }
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`setShuffle(${roomName})`, async () => {
    const currentMode = await device.getPlayMode();
    const { repeat } = decomposePlayMode(currentMode);
    await device.setPlayMode(composePlayMode(enabled, repeat));
  });
}

async function setCrossfade(roomName, enabled) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`setCrossfade(${roomName})`, () =>
    device.avTransportService().SetCrossfadeMode({ InstanceID: 0, CrossfadeMode: enabled ? '1' : '0' })
  );
}

// minutes <= 0 cancels the timer (empty string per the UPnP spec for
// this action). Otherwise converts to the "H:MM:SS" duration string
// ConfigureSleepTimer expects.
async function setSleepTimer(roomName, minutes) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  const duration = minutes > 0 ? secondsToHms(minutes * 60) : '';
  await guarded(`setSleepTimer(${roomName})`, () => device.configureSleepTimer(duration));
}

// Bass/treble range -10 to +10 per the UPnP spec, clamped defensively
// here rather than trusting whatever the client sent.
async function getRoomSettings(roomName) {
  if (usingMock) return { bass: 0, treble: 0, loudness: true, crossfade: false };
  const device = findDevice(roomName);
  if (!device) return null;
  const [bass, treble, loudness, crossfade] = await Promise.all([
    device.renderingControlService().GetBass().catch(() => 0),
    device.renderingControlService().GetTreble().catch(() => 0),
    device.renderingControlService().GetLoudness().catch(() => true),
    device.avTransportService().GetCrossfadeMode().then((r) => Boolean(Number(r.CrossfadeMode))).catch(() => false)
  ]);
  return { bass, treble, loudness: Boolean(loudness), crossfade };
}

async function setBass(roomName, value) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  const clamped = Math.max(-10, Math.min(10, Math.round(value)));
  await guarded(`setBass(${roomName})`, () => device.renderingControlService().SetBass(clamped));
}

async function setTreble(roomName, value) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  const clamped = Math.max(-10, Math.min(10, Math.round(value)));
  await guarded(`setTreble(${roomName})`, () => device.renderingControlService().SetTreble(clamped));
}

async function setLoudness(roomName, enabled) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`setLoudness(${roomName})`, () => device.renderingControlService().SetLoudness(enabled));
}

// Before creating a new grouping, fully dissolve any EXISTING group
// that shares at least one room with the target set -- rather than
// relying on Sonos's own per-device "leave old group, join new one"
// behavior when a room moves between groups, which didn't reliably
// leave a clean result in practice. This is a deliberate
// simplification: touching any member of a conflicting group tears
// the WHOLE thing down first, then the new group gets created fresh,
// so there's never a leftover partial/orphaned group hanging around.
async function resolveGroupConflicts(targetRoomNames) {
  if (usingMock) return [];
  const targets = new Set(targetRoomNames);

  // Every coordinator whose CURRENT group includes at least one target
  // room -- whether that target room is a plain member, or is itself
  // the coordinator of a group that has other members not in the
  // target set.
  const coordinatorsToDissolve = new Set();
  Object.keys(lastCoordinatorMap).forEach((name) => {
    const coord = lastCoordinatorMap[name];
    if (coord === name) return; // not actually grouped with anyone
    if (targets.has(name) || targets.has(coord)) coordinatorsToDissolve.add(coord);
  });
  if (coordinatorsToDissolve.size === 0) return [];

  const membersToUngroup = Object.keys(lastCoordinatorMap).filter(
    (name) => coordinatorsToDissolve.has(lastCoordinatorMap[name]) && name !== lastCoordinatorMap[name]
  );
  await Promise.allSettled(membersToUngroup.map((name) => ungroupRoom(name)));
  // Rooms that are about to join the NEW target group don't need to be
  // reported as "dissolved to standalone" -- they're getting a real
  // coordinator patch moments later anyway from the join itself.
  return membersToUngroup.filter((name) => !targets.has(name));
}

async function groupRooms(roomNames) {
  if (!roomNames || roomNames.length < 2) return { succeeded: [], failed: [], dissolved: [] };
  if (usingMock) {
    const [coordinatorName, ...members] = roomNames;
    members.forEach((name) => {
      const room = mockState.rooms.find((r) => r.name === name);
      if (room) room.coordinator = coordinatorName;
    });
    return { succeeded: members, failed: [], dissolved: [] };
  }
  const dissolved = await resolveGroupConflicts(roomNames);
  const [coordinatorName, ...members] = roomNames;
  // Promise.allSettled, not Promise.all: a saved group with one
  // unreachable room (unplugged, rebooting, Wi-Fi hiccup) shouldn't
  // block the OTHER rooms from grouping. Promise.all fails fast on the
  // first rejection and would abort the whole batch even though most
  // of the rooms might have joined fine. This reports back exactly
  // which rooms actually joined vs which didn't, so the caller can
  // reflect reality accurately rather than an all-or-nothing result.
  //
  // Deliberately does NOT modify any stored saved-group definition on
  // failure -- a room that's temporarily unreachable should still be
  // part of the group next time, once it's back. Skipping it here is
  // purely for this one attempt, not a permanent removal.
  const results = await Promise.allSettled(
    members.map((memberName) => {
      const member = findDevice(memberName);
      if (!member) return Promise.reject(new Error(`${memberName} not found`));
      return guarded(`groupRooms(${memberName} -> ${coordinatorName})`, () => member.joinGroup(coordinatorName));
    })
  );
  const succeeded = [];
  const failed = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') succeeded.push(members[i]);
    else {
      failed.push(members[i]);
      debugLog.warn('sonos', `groupRooms: ${members[i]} did not join -- ${result.reason && result.reason.message}`);
    }
  });
  return { succeeded, failed, dissolved };
}

// Immediately reflects an intended topology change in the cache, ahead
// of the real poll confirming it -- Sonos's own join/leave settling can
// take anywhere from under a second to (per Sonos's own community
// reports) upwards of 15-30 seconds on a slow/congested network, which
// is outside our control. Patching the cache now means the room list
// visually updates the instant the action is requested rather than
// waiting on that settling time; the full poll that follows (triggered
// right after, in index.js) then corrects this if reality ends up
// differing (e.g. a join actually failed).
function patchCoordinatorOptimistically(roomNames, newCoordinatorName) {
  if (usingMock) {
    roomNames.forEach((name) => {
      const room = mockState.rooms.find((r) => r.name === name);
      if (room) room.coordinator = newCoordinatorName;
    });
    return;
  }
  roomNames.forEach((name) => {
    lastCoordinatorMap[name] = newCoordinatorName;
    const existing = lastRoomsByName.get(name);
    if (existing) lastRoomsByName.set(name, { ...existing, coordinator: newCoordinatorName });
  });
}

// Synchronous, no network calls -- just whatever the cache currently
// holds. Used for the immediate broadcast right after an optimistic
// patch (see patchCoordinatorOptimistically), not for anything that
// needs genuinely fresh data.
function getLastKnownRooms() {
  if (usingMock) return [...mockState.rooms].sort((a, b) => a.name.localeCompare(b.name));
  return [...lastRoomsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function ungroupRoom(roomName) {
  if (usingMock) {
    const room = mockState.rooms.find((r) => r.name === roomName);
    if (room) room.coordinator = roomName;
    return { reachable: true };
  }
  const device = findDevice(roomName);
  if (!device) return { reachable: true };
  try {
    await device.leaveGroup();
    return { reachable: true };
  } catch (err) {
    // Deliberately NOT re-throwing -- a device that's unreachable
    // (unplugged, Wi-Fi dropped) can't actually receive this command,
    // but that shouldn't block the panel from reflecting "ungrouped"
    // locally. Letting this throw was the actual bug: it aborted the
    // route handler before the optimistic UI patch ever ran, leaving
    // the room stuck showing as grouped with no way to remove it.
    debugLog.warn('sonos', `ungroupRoom(${roomName}) failed, likely unreachable: ${err.message}`);
    return { reachable: false };
  }
}

// ---------------------------------------------------------------------
// Generic recursive source browsing
// ---------------------------------------------------------------------

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// Lazy-loaded cache mapping Sonos's numeric service IDs (the `sid=`
// parameter embedded in favorite/track URIs) to human-readable names --
// e.g. sid=236 -> "Pandora". Built from the same ListAvailableServices
// catalog call tried earlier for browsing (which didn't work out for
// that purpose since it returns Sonos's whole global catalog, not just
// linked services) -- repurposed here since for LABELING, the global
// catalog is exactly what's needed: it's just a lookup table from
// number to name, and every sid in a real favorite's URI will be in it
// regardless of whether that service happens to be linked to this
// household.
let serviceNameById = null;

async function loadServiceNameMap() {
  if (serviceNameById) return serviceNameById;
  serviceNameById = {};
  const device = devicesByName.values().next().value;
  if (!device) return serviceNameById;
  try {
    const musicServices = new Services.MusicServices(device.host, device.port);
    const raw = await musicServices.ListAvailableServices({});
    const parsed = await Helpers.ParseXml(raw.AvailableServiceDescriptorList);
    const servicesNode = parsed && parsed.Services && parsed.Services.Service;
    const list = toArray(servicesNode);
    list.forEach((svc) => {
      if (svc.Id && svc.Name) serviceNameById[svc.Id] = svc.Name;
    });
    debugLog.info('sonos', `Loaded ${Object.keys(serviceNameById).length} service ID->name mappings for favorite/track labeling`);
  } catch (err) {
    debugLog.warn('sonos', `Could not load service name map for labeling: ${err.message}`);
  }
  return serviceNameById;
}

// Sonos embeds a station's unique token (e.g. "ST:95833435624461523") in
// BOTH a Favorite's stream URI and the currently-playing track's own
// URI -- confirmed via real playback data showing the identical token
// number in both places for the same station. Extracting it lets us
// cross-reference "what's playing right now" against Favorites to find
// its real name, since GetMediaInfo (tried first) came back with an
// empty CurrentURIMetaData and wasn't usable for this.
function extractStationToken(uri) {
  if (!uri) return null;
  const match = String(uri).match(/ST(?:%3a|:)+(\d+)/i);
  return match ? match[1] : null;
}

// Stale-while-revalidate, same pattern as getPlaylists() below: instant
// from cache (even if a bit stale) while refreshing in the background,
// rather than blocking on a fresh fetch every time. This one function is
// now shared by everything that needs the Favorites list -- previously
// getSourceGroups(), getFavoritesByGroup(), and
// findStationNameFromFavorites() each fetched FV:2 independently with no
// sharing between them at all, plus this specific cache never got a
// startup warm-up. Both fixed now, mirroring the Playlists cache.
const FAVORITES_CACHE_MS = 30000;
let favoritesCache = { items: null, at: 0, refreshing: false };

async function refreshFavoritesCache(roomName) {
  if (favoritesCache.refreshing) return favoritesCache.items || [];
  favoritesCache.refreshing = true;
  try {
    const items = await browseContainer(roomName, 'FV:2');
    favoritesCache = { items, at: Date.now(), refreshing: false };
    return items;
  } catch (err) {
    favoritesCache.refreshing = false;
    debugLog.warn('sonos', `refreshFavoritesCache failed: ${err.message}`);
    return favoritesCache.items || [];
  }
}

async function getFavorites(roomName) {
  if (!favoritesCache.items) return refreshFavoritesCache(roomName);
  const isStale = Date.now() - favoritesCache.at > FAVORITES_CACHE_MS;
  if (isStale) refreshFavoritesCache(roomName); // serve stale, refresh quietly
  return favoritesCache.items;
}

async function findStationNameFromFavorites(roomName, stationToken) {
  if (!stationToken) return null;
  try {
    const items = await getFavorites(roomName);
    const match = items.find((f) => f.uri && extractStationToken(f.uri) === stationToken);
    return match ? match.title : null;
  } catch (err) {
    debugLog.warn('sonos', `findStationNameFromFavorites(${roomName}) failed: ${err.message}`);
    return null;
  }
}
// description field when present (confirmed real-world example: "Pandora
// Station"), otherwise falls back to pulling the sid= service ID out of
// a stream URI and looking it up in the catalog map. Used both when
// browsing Favorites and when labeling the currently-playing track --
// both carry the same sid= pattern in their URIs.
function deriveServiceLabel(node, uri, serviceMap) {
  let serviceLabel = (node && node['r:description']) || null;
  if (!serviceLabel && uri && serviceMap) {
    const sidMatch = String(uri).match(/[?&]sid=(\d+)/);
    if (sidMatch && serviceMap[sidMatch[1]]) {
      serviceLabel = serviceMap[sidMatch[1]];
    }
  }
  // Real data showed this can come back as "Pandora Station" rather than
  // plain "Pandora" -- normalizing keeps grouping consistent regardless
  // of which exact wording a given item happens to carry, and gives the
  // frontend a clean, predictable name to match against for icons.
  if (serviceLabel) {
    serviceLabel = serviceLabel.replace(/\s+Station$/i, '').trim();
  }
  return serviceLabel;
}

function mapDidlNode(device, node, browsable, serviceMap) {
  const resUri = node.res && (node.res._ !== undefined ? node.res._ : node.res);
  const parsedItem = Helpers.ParseDIDLItem(node, device.host, device.port, resUri);
  const serviceLabel = deriveServiceLabel(node, resUri, serviceMap);

  return {
    id: node.id,
    title: parsedItem.title || node['dc:title'] || 'Untitled',
    artist: parsedItem.artist || null,
    album: parsedItem.album || null,
    albumArtUrl: parsedItem.albumArtURI || null,
    browsable,
    uri: browsable ? null : parsedItem.uri || resUri || null,
    // Sonos embeds this item's own exact playback metadata (service auth
    // reference included) in r:resMD -- passing it through to
    // setAVTransportURI is what actually lets Sonos route the request to
    // the right backend service correctly, versus letting the library
    // auto-generate generic fallback metadata from a bare URI, which
    // failed with a UPnP 501 error in real testing.
    metadata: browsable ? null : node['r:resMD'] || null,
    serviceLabel
  };
}

async function browseContainer(roomName, containerId) {
  if (usingMock) {
    return mockState.browse[containerId] || [];
  }
  const device = findDevice(roomName) || devicesByName.values().next().value;
  if (!device) return [];

  return guarded(`browseContainer(${containerId})`, async () => {
    const serviceMap = await loadServiceNameMap();
    const raw = await device.contentDirectoryService().Browse({
      ObjectID: containerId,
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: '0',
      RequestedCount: '200',
      SortCriteria: ''
    });
    const parsed = await Helpers.ParseXml(raw.Result);
    const didl = parsed['DIDL-Lite'] || {};
    const rawContainers = toArray(didl.container);
    const rawItems = toArray(didl.item);
    const containers = rawContainers.map((c) => mapDidlNode(device, c, true, serviceMap));
    const leafItems = rawItems.map((it) => mapDidlNode(device, it, false, serviceMap));

    // Sonos injects non-playable promotional tiles into Favorites (e.g.
    // "Discover Sonos Radio", "Trending Now") that have no playable uri
    // and no sub-items -- confirmed via raw diagnostic dump against a
    // real household. These are guaranteed dead ends in this app (no
    // official-app-style "open the browsing UI" fallback exists for us
    // to replicate), so they're filtered out entirely rather than shown
    // as rows that do nothing when tapped.
    const result = [...containers, ...leafItems].filter((it) => it.browsable || it.uri);

    if (result.length === 0) {
      debugLog.warn('sonos', `browseContainer(${containerId}) returned 0 items -- either genuinely empty, or this ObjectID isn't valid for your system`);
    } else {
      debugLog.info(
        'sonos',
        `browseContainer(${containerId}) -> ${result.length} item(s): ` +
          result.map((r) => `[${r.browsable ? 'container' : 'item'} "${r.title}" service=${r.serviceLabel || 'unknown'} uri=${r.uri || 'none'}]`).join(', ')
      );
    }
    return result;
  });
}

async function playItem(roomName, uri, metadata) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  roomPlaylistContext.delete(roomName);
  debugLog.info('sonos', `playItem(${roomName}): ${metadata ? 'using item metadata' : 'no metadata available, falling back to bare URI'}`);
  await guarded(`playItem(${roomName})`, async () => {
    // Confirmed via real testing: calling setAVTransportURI right after
    // a room was actively playing from a queue (e.g. a playlist) can
    // itself get rejected as "transition not available" -- not just the
    // follow-up Play call below. A bare pause() alone wasn't enough
    // (still failed in under 450ms in testing); adding a settling delay
    // after it, plus a retry on setAVTransportURI itself, matching the
    // same pattern already used for the Play call below.
    await device.pause().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    const setUri = () => (metadata ? device.setAVTransportURI({ uri, metadata }) : device.setAVTransportURI(uri));
    try {
      await setUri();
    } catch (err) {
      debugLog.warn('sonos', `playItem(${roomName}): setAVTransportURI failed (${err.message}), retrying once after a longer pause`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      await setUri();
    }
    // setAVTransportURI alone doesn't guarantee playback actually
    // starts -- confirmed in practice (selecting a favorite did
    // nothing until Play was pressed manually). A brief pause before
    // the follow-up Play call avoids hitting the device while it's
    // still processing the URI change, which otherwise risks a
    // "Transition not available" error -- and if it still happens,
    // one retry after a longer pause covers the common transient case.
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      await device.play();
    } catch (err) {
      debugLog.warn('sonos', `playItem(${roomName}): initial Play failed (${err.message}), retrying once after a longer pause`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      await device.play();
    }
  });
}

// Confirmed the actual bug via real logs: tapping a track within a
// playlist was calling playItem() on that ONE track alone, with no
// queue context -- so Sonos had no "next" or "previous" track to go to
// at all (hence 711 errors on both). The fix: build the FULL playlist
// as an actual Sonos queue (matching what the official app does when
// you tap a song inside a playlist), then jump to the specific track
// that was tapped.
// The sonos library's own metadata auto-generation doesn't recognize
// our track URI format (x-sonos-http:...) and falls back to something
// with no real title/artist/album -- confirmed via testing: playlist
// tracks queued this way played fine but showed no metadata at all.
// Building real DIDL-Lite metadata ourselves, from the title/artist/
// album/art we already have from browsing, fixes that.
function buildTrackMetadata(track) {
  const title = Helpers.EncodeXml(track.title || 'Unknown');
  const artistTag = track.artist ? `<dc:creator>${Helpers.EncodeXml(track.artist)}</dc:creator>` : '';
  const albumTag = track.album ? `<upnp:album>${Helpers.EncodeXml(track.album)}</upnp:album>` : '';
  const artTag = track.albumArtUrl ? `<upnp:albumArtURI>${Helpers.EncodeXml(track.albumArtUrl)}</upnp:albumArtURI>` : '';
  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="-1" parentID="-1" restricted="true"><dc:title>${title}</dc:title>${artistTag}${albumTag}${artTag}` +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class></item></DIDL-Lite>'
  );
}

async function playPlaylistTrack(roomName, playlistContainerId, playlistTitle, trackUri) {
  if (usingMock) return;
  const device = findDevice(roomName);
  if (!device) return;
  await guarded(`playPlaylistTrack(${roomName})`, async () => {
    const tracks = await browseContainer(roomName, playlistContainerId);
    const playableTracks = tracks.filter((t) => t.uri);
    const targetIndex = playableTracks.findIndex((t) => t.uri === trackUri);

    await device.flush();
    for (const track of playableTracks) {
      await device.queue({ uri: track.uri, metadata: track.metadata || buildTrackMetadata(track) });
    }
    await device.selectQueue();
    await device.selectTrack(targetIndex >= 0 ? targetIndex + 1 : 1);
    await device.play();
    roomPlaylistContext.set(roomName, { id: playlistContainerId, title: playlistTitle || 'Playlist' });
  });
}

// targetRoomName = the room that will start playing (the one you had
// focused when you opened Sources)
// sourceRoomName = whose physical line-in input to relay (what you
// picked from the Line-In list -- may be the same room, or a different
// one entirely)
async function playLineInFrom(targetRoomName, sourceRoomName) {
  if (usingMock) return;
  const targetDevice = findDevice(targetRoomName);
  if (!targetDevice) return;
  roomPlaylistContext.delete(targetRoomName);
  await guarded(`playLineInFrom(${targetRoomName} <- ${sourceRoomName})`, async () => {
    const uuid = await getDeviceUUID(sourceRoomName);
    debugLog.info('sonos', `playLineInFrom: resolved sourceRoomName="${sourceRoomName}" -> uuid=${uuid}`);
    if (!uuid) throw new Error(`Could not resolve device UUID for ${sourceRoomName}`);
    await targetDevice.setAVTransportURI(`x-rincon-stream:${uuid}`);
  });
}

// Line-In detection has a confirmed real limit, not a guess: tested
// against a real household with GetAudioInputAttributes(), and every
// room that has line-in HARDWARE returned byte-for-byte identical data
// ({"CurrentName":"Audio Component","CurrentIcon":"AudioComponent"}),
// with no field distinguishing "something is actually plugged in" from
// "this model has the port." That data plainly isn't exposed by this
// call. Rather than keep guessing at other fields, config.json supports
// a direct override: set "lineInRoom" to the exact room name (matching
// what shows in the room list) and that becomes the only Line-In entry
// shown, skipping the unreliable hardware probe entirely. Leave it null
// to fall back to showing every hardware-capable room (still useful --
// narrows 9 rooms down to just the ones physically able to do this at
// all, even without knowing which one really has it wired up).
// The friendly label (e.g. "CD Player", "TV") assigned to a room's
// line-in input in the official Sonos app -- comes back as CurrentName
// from the same AudioIn query already used for hardware-capability
// detection. Cached since it essentially never changes mid-session and
// this can now get checked on every now-playing poll while a Line-In
// source is active.
const LINE_IN_NAME_CACHE_MS = 60000;
let lineInNameCache = {}; // roomName (lowercase) -> { name, at }

async function getLineInCurrentName(roomName) {
  const key = (roomName || '').toLowerCase();
  const cached = lineInNameCache[key];
  const now = Date.now();
  if (cached && now - cached.at < LINE_IN_NAME_CACHE_MS) return cached.name;

  const device = findDevice(roomName);
  if (!device) return null;
  try {
    const audioIn = new Services.AudioIn(device.host, device.port);
    const attrs = await audioIn.GetAudioInputAttributes({});
    const name = attrs.CurrentName || null;
    lineInNameCache[key] = { name, at: now };
    return name;
  } catch (err) {
    lineInNameCache[key] = { name: null, at: now };
    return null;
  }
}

async function getLineInRooms() {
  if (usingMock) {
    return [{ roomName: 'Living Room', title: 'Living Room', currentName: 'CD Player' }];
  }

  if (config.lineInRoom) {
    const device = findDevice(config.lineInRoom);
    if (device) {
      debugLog.info('sonos', `Using config.json lineInRoom override: "${config.lineInRoom}"`);
      const currentName = await getLineInCurrentName(config.lineInRoom);
      return [{ roomName: config.lineInRoom, title: config.lineInRoom, currentName }];
    }
    debugLog.warn(
      'sonos',
      `config.json lineInRoom "${config.lineInRoom}" doesn't match any known room name exactly -- falling back to hardware-capability detection`
    );
  }

  const results = await Promise.all(
    [...devicesByName.entries()].map(async ([key, device]) => {
      const name = displayNameByKey.get(key) || key;
      try {
        const audioIn = new Services.AudioIn(device.host, device.port);
        const attrs = await audioIn.GetAudioInputAttributes({});
        debugLog.info('sonos', `Line-In RAW diagnostic for ${name}: ${JSON.stringify(attrs)}`);
        lineInNameCache[name.toLowerCase()] = { name: attrs.CurrentName || null, at: Date.now() };
        return { roomName: name, title: name, currentName: attrs.CurrentName || null };
      } catch (err) {
        debugLog.info('sonos', `Line-In RAW diagnostic for ${name}: query failed (${err.message}) -- likely no line-in hardware on this model`);
        return null;
      }
    })
  );
  const filtered = results.filter((r) => r !== null);
  filtered.sort((a, b) => a.title.localeCompare(b.title));
  return filtered;
}

// Actually tests each hardware-capable Line-In candidate for a real
// signal, rather than just listing "has the port" -- confirmed possible
// because a genuinely connected input echoes back a populated stream URI
// when queried right after switching to it, while an unconnected one
// (has the port, nothing plugged in) reports back empty/null. There's no
// passive way to check this -- it requires actually switching sources,
// which means:
//   - This BRIEFLY interrupts whatever targetRoomName is currently
//     playing, once per candidate (~2s each).
//   - It attempts to restore targetRoomName's exact previous source
//     afterward (snapshotted via GetMediaInfo before testing), but this
//     is best-effort -- some sources (e.g. certain radio stations) may
//     not resume perfectly cleanly.


// NOTE ON THIRD-PARTY SERVICES (Amazon Music, Pandora, Spotify, etc.):
// ListAvailableServices() was tried here and confirmed (via a real
// household's debug log) to return Sonos's ENTIRE global catalog of
// 100+ possible services -- not the handful actually linked to a given
// account. Random unrelated services like "Radio Javan" or "storePlay"
// came back alongside real ones, with no reliable local field to tell
// "linked to this household" apart from "exists in Sonos's worldwide
// catalog." The official app's clean, short list comes from Sonos's
// cloud account data instead, which needs a registered Sonos developer
// app + OAuth to access -- a genuinely separate integration from
// anything else in this file. That same catalog IS reused, though, as a
// sid -> name lookup table for labeling favorites by source (see
// loadServiceNameMap / mapDidlNode above) -- repurposed for a job it's
// actually well suited to.
//
// Source browsing is now: Favorites, grouped by the service each one
// came from (via the same labeling logic used for display), plus
// Line-In. Sonos Playlists and Sonos Radio were dropped from the
// top-level list per updated direction -- browseContainer() still
// supports browsing them generically if that changes again later.

function groupLabelFor(item) {
  return item.serviceLabel || 'Other';
}

async function getSourceGroups(roomName) {
  const favorites = await getFavorites(roomName);
  const labels = new Set();
  favorites.forEach((item) => labels.add(groupLabelFor(item)));

  const groups = Array.from(labels).map((label) => ({
    id: `svc:${label}`,
    title: label,
    browsable: true
  }));
  groups.sort((a, b) => a.title.localeCompare(b.title));
  groups.push({ id: 'linein', title: 'Line-In', browsable: true, isLineInRoot: true });

  // Playlists only shown when they actually exist, and pinned to the
  // very front rather than sorted in alphabetically -- per request.
  // Goes through the same cache getPlaylists() uses, so this doesn't
  // duplicate the fetch.
  let playlistCount = 0;
  try {
    playlistCount = (await getPlaylists(roomName)).length;
  } catch (err) {
    debugLog.warn('sonos', `getSourceGroups: could not check for playlists: ${err.message}`);
  }
  if (playlistCount > 0) {
    groups.unshift({ id: 'SQ:', title: 'Playlists', browsable: true, isPlaylistRoot: true });
  }

  return groups;
}

// Sonos Playlists -- reuses the same generic browseContainer already
// proven working for Favorites. Honest unknown: whether a playlist here
// comes back as a directly-playable item or a container you need to open
// to see individual tracks -- the frontend handles either case rather
// than assuming, since this hasn't been tested against a real household.
// Confirmed via real data: a playlist container itself has no service
// label (Sonos reports it as unknown) -- only its individual tracks do.
// So determining "what service is this playlist from" means peeking at
// its first track. One extra browseContainer call per playlist; fine at
// the scale of a personal playlist collection.
// Cached with stale-while-revalidate: the first-ever call has to fetch
// for real, but every call after that returns instantly from cache
// (even if a bit stale) while a background refresh quietly updates it
// for next time. Combined with the startup warm-up call in init(), this
// means Playlists should already be warm by the time it's actually
// opened, rather than eating the "peek every playlist's first track"
// delay on first visit.
const PLAYLISTS_CACHE_MS = 60000;
let playlistsCache = { items: null, at: 0, refreshing: false };

async function fetchPlaylistsFresh(roomName) {
  const items = await browseContainer(roomName, 'SQ:');
  const withService = await Promise.all(
    items.map(async (item) => {
      try {
        const tracks = await getCachedContainerItems(roomName, item.id);
        const serviceLabel = tracks.length > 0 ? tracks[0].serviceLabel : null;
        return { ...item, serviceLabel };
      } catch (err) {
        debugLog.warn('sonos', `getPlaylists: could not peek into "${item.title}" to determine its service: ${err.message}`);
        return { ...item, serviceLabel: null };
      }
    })
  );
  withService.sort((a, b) => a.title.localeCompare(b.title));
  return withService;
}

async function refreshPlaylistsCache(roomName) {
  if (playlistsCache.refreshing) return playlistsCache.items || [];
  playlistsCache.refreshing = true;
  try {
    const items = await fetchPlaylistsFresh(roomName);
    playlistsCache = { items, at: Date.now(), refreshing: false };
    return items;
  } catch (err) {
    playlistsCache.refreshing = false;
    debugLog.warn('sonos', `refreshPlaylistsCache failed: ${err.message}`);
    return playlistsCache.items || [];
  }
}

async function getPlaylists(roomName) {
  const now = Date.now();
  const isStale = !playlistsCache.items || now - playlistsCache.at > PLAYLISTS_CACHE_MS;
  if (!playlistsCache.items) {
    // Nothing cached yet at all (shouldn't normally happen given the
    // startup warm-up, but covers a cold cache gracefully) -- this one
    // call has to actually wait for real data.
    return refreshPlaylistsCache(roomName);
  }
  if (isStale) {
    // Serve what we have immediately; refresh quietly for next time.
    refreshPlaylistsCache(roomName);
  }
  return playlistsCache.items;
}

async function getFavoritesByGroup(roomName, groupLabel) {
  const favorites = await getFavorites(roomName);
  const filtered = favorites.filter((item) => groupLabelFor(item) === groupLabel);
  filtered.sort((a, b) => a.title.localeCompare(b.title));
  return filtered;
}

function isMock() {
  return usingMock;
}

module.exports = {
  init,
  getRooms,
  getRoomsTargeted,
  getGroupMemberNames,
  patchCoordinatorOptimistically,
  getSavedGroups,
  addSavedGroup,
  deleteSavedGroup,
  updateSavedGroup,
  getLastKnownRooms,
  onLiveUpdate,
  onNowPlayingChanged,
  onGroupVolumeChanged,
  getNowPlaying,
  play,
  pause,
  next,
  previous,
  setVolume,
  setMute,
  getGroupVolume,
  setGroupVolume,
  setGroupMute,
  setPlayMode,
  setShuffle,
  setCrossfade,
  setSleepTimer,
  getRoomSettings,
  setBass,
  setTreble,
  setLoudness,
  groupRooms,
  ungroupRoom,
  getSourceGroups,
  getFavoritesByGroup,
  getPlaylists,
  getLineInRooms,
  browseContainer,
  getCachedContainerItems,
  playItem,
  playPlaylistTrack,
  playLineInFrom,
  isMock
};
