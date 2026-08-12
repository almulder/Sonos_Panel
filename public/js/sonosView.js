// sonosView.js

// Sonos offers a fixed set of Line-In "CurrentName" labels (set by the
// user in the official app) -- each has its own icon file in
// public/icons/ (see README-icons.txt). Falls back to the generic
// source-linein.png if a name doesn't match any of these.
const LINE_IN_ICON_FILES = {
  'Airplay Device': 'linein-airplay',
  'Audio Component': 'linein-audiocomponent',
  'CD Player': 'linein-cdplayer',
  Computer: 'linein-computer',
  'Home Theater': 'linein-hometheater',
  'Mac Computer': 'linein-maccomputer',
  'Portable Player': 'linein-portableplayer',
  Receiver: 'linein-receiver',
  'Satellite Receiver': 'linein-satellitereceiver',
  Turntable: 'linein-turntable'
};
function lineInIconFilename(name) {
  return LINE_IN_ICON_FILES[name] || 'source-linein';
}
// Clears and repopulates `el` with an icon + the device name -- used
// wherever a Line-In device name needs to display with its icon (Now
// Playing artist line, and the source-browsing sublabel).
function setLineInLabel(el, deviceName) {
  el.textContent = '';
  const img = document.createElement('img');
  img.className = 'lineinlabel__icon';
  img.src = `icons/${lineInIconFilename(deviceName)}.png`;
  img.alt = '';
  img.onerror = () => {
    img.onerror = null;
    img.src = 'icons/source-linein.png';
  };
  el.appendChild(img);
  el.appendChild(document.createTextNode(` ${deviceName}`));
}

// Real brand icons for streaming/audio services -- bundled locally in
// public/icons/ as PNG files (see public/icons/README-icons.txt for the
// full naming reference and status of each). Any service without an
// icon file here automatically falls back to icons/default.png -- no
// broken images, no code changes needed to add a new one later.
const SERVICE_ICON_FILES = {
  '7digital': '7digital',
  'Amazon Music': 'amazonmusic',
  Anghami: 'anghami',
  'Apple Music': 'applemusic',
  Audible: 'audible',
  'Audiobooks.com': 'audiobookscom',
  Bandcamp: 'bandcamp',
  'BBC Sounds': 'bbcsounds',
  Calm: 'calm',
  'CBC Listen': 'cbclisten',
  'Classical Archives': 'classicalarchives',
  Convoy: 'convoy',
  'Deep House Ibiza': 'deephouseibiza',
  Deezer: 'deezer',
  Endel: 'endel',
  FitRadio: 'fitradio',
  'Focus At Will': 'focusatwill',
  Gaana: 'gaana',
  'Global Player': 'globalplayer',
  'Hoopla Digital': 'hoopladigital',
  iHeartRadio: 'iheartradio',
  Idagio: 'idagio',
  JioSaavn: 'jiosaavn',
  'Last.fm': 'lastfm',
  'Last FM': 'lastfm',
  LiveOne: 'liveone',
  LivePhish: 'livephish',
  Mixcloud: 'mixcloud',
  'Mood Media': 'moodmedia',
  NPR: 'npr',
  'National Public Radio': 'npr',
  Netflix: 'netflix',
  'NTS Radio': 'ntsradio',
  'Nugs.net': 'nugsnet',
  'Open Audio': 'openaudio',
  Pandora: 'pandora',
  Plex: 'plex',
  'Pocket Casts': 'pocketcasts',
  Podbean: 'podbean',
  Qobuz: 'qobuz',
  'Radical.FM': 'radicalfm',
  'Radio.net': 'radionet',
  Radioplayer: 'radioplayer',
  'RTVE Audio': 'rtveaudio',
  Saavn: 'saavn',
  SoundCloud: 'soundcloud',
  Soundmachine: 'soundmachine',
  Spotify: 'spotify',
  Stitcher: 'stitcher',
  Sybel: 'sybel',
  TeleFormula: 'teleformula',
  Tidal: 'tidal',
  TuneIn: 'tuneinradio',
  'TuneIn Radio': 'tuneinradio',
  'Wynk Music': 'wynkmusic',
  'YouTube Music': 'youtubemusic'
};

function buildImgIconWithFallback(filename) {
  const img = document.createElement('img');
  img.className = 'sourcepanel__icon sourcepanel__icon--img';
  img.src = `icons/${filename}.png`;
  img.alt = '';
  img.onerror = () => {
    img.onerror = null;
    img.src = 'icons/default.png';
  };
  return img;
}

// Service resolution now lives in icons/music_services.js -- a plain
// user-editable directory (key: 'Display Name'). Keys are the stream's
// service name lowercased with punctuation stripped; a label MATCHES a
// key by prefix, so one 'pandora' entry covers "Pandora", "Pandora
// Playlist", "Pandora Station". Icon file = <key>.png in that folder.
// Unmapped services display their raw label -- which is exactly the
// key a user needs to add to the file.
const serviceKeysByLength = (typeof window !== 'undefined' && window.MUSIC_SERVICES)
  ? Object.keys(window.MUSIC_SERVICES).sort((a, b) => b.length - a.length)
  : [];

function normalizeServiceKey(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveService(label) {
  const n = normalizeServiceKey(label);
  if (!n) return null;
  for (const k of serviceKeysByLength) {
    if (n.startsWith(k)) return { key: k, display: window.MUSIC_SERVICES[k] };
  }
  // Reverse prefix: the stream's label can be SHORTER than the
  // directory key ("80s80s" vs 80s80sradio). Shortest matching key
  // wins; 4-char minimum keeps tiny labels from grabbing wrong keys.
  if (n.length >= 4) {
    let best = null;
    for (const k of serviceKeysByLength) {
      if (k.startsWith(n) && (!best || k.length < best.length)) best = k;
    }
    if (best) return { key: best, display: window.MUSIC_SERVICES[best] };
  }
  return null;
}

function displayService(label) {
  const r = resolveService(label);
  return r ? r.display : label;
}

function iconFilenameForService(serviceLabel) {
  const r = resolveService(serviceLabel);
  if (r) return r.key;
  return SERVICE_ICON_FILES[serviceLabel] || 'default';
}

function buildSourceIcon(group) {
  if (group.isLocalLibraryRoot) {
    // Dedicated icon if the asset exists; falls back to default.png
    // via buildImgIconWithFallback's onerror handler otherwise.
    return buildImgIconWithFallback('source-networklibrary');
  }
  if (group.isMusicLibraryRoot) {
    return buildImgIconWithFallback('source-sonoslibrary');
  }
  if (group.isLineInRoot) {
    return buildImgIconWithFallback('linein');
  }
  if (group.isPlaylistRoot) {
    return buildImgIconWithFallback('source-playlist');
  }
  return buildImgIconWithFallback(iconFilenameForService(group.title));
}

const SonosView = (() => {
  const roomListEl = document.getElementById('roomList');
  const roomlistPullIndicator = document.getElementById('roomlistPullIndicator');
  const sourceSearchWrap = document.getElementById('sourceSearchWrap');
  const sourceSearchInput = document.getElementById('sourceSearchInput');
  const sourceSearchClear = document.getElementById('sourceSearchClear');
  const roomlistPanel = document.getElementById('sonosRoomlist');
  const roomlistLabel = document.getElementById('roomlistLabel');
  const roomlistBackBtn = document.getElementById('roomlistBackBtn');
  const savedGroupsAddBtn = document.getElementById('savedGroupsAddBtn');
  const titleEl = document.getElementById('sonosTitle');
  const artistEl = document.getElementById('sonosArtist');
  const groupLabelEl = document.getElementById('sonosGroupLabel');
  const upNextEl = document.getElementById('sonosUpNext');

  function titleCase(str) {
    return String(str || '').replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  }
  const sourceLineEl = document.getElementById('sonosSourceLine');
  const artEl = document.getElementById('sonosArt');
  const playPauseBtn = document.getElementById('sonosPlayPause');
  const prevBtn = document.getElementById('sonosPrev');
  const nextBtn = document.getElementById('sonosNext');
  const shuffleBtn = document.getElementById('sonosShuffleBtn');
  const crossfadeBtn = document.getElementById('sonosCrossfadeBtn');
  const repeatBtn = document.getElementById('sonosRepeatBtn');
  const repeatDot = document.getElementById('sonosRepeatDot');
  const repeatOneEl = document.getElementById('sonosRepeatOne');
  if (repeatBtn) {
    repeatBtn.addEventListener('click', async () => {
      if (!focusedRoom || repeatBtn.disabled) return;
      const current = (lastNowPlayingTrack && lastNowPlayingTrack.repeatMode) || 'off';
      const next = current === 'off' ? 'all' : (current === 'all' ? 'one' : 'off');
      await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/repeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next })
      });
      await refreshNowPlaying();
    });
  }
  const sleepTimerBtn = document.getElementById('sonosSleepTimerBtn');
  const sleepTimerBadge = document.getElementById('sonosSleepTimerBadge');
  const sleepTimerMenu = document.getElementById('sonosSleepTimerMenu');
  const sleepTimerOverlay = document.getElementById('sonosSleepTimerOverlay');

  const sourcePanel = document.getElementById('sourcePanel');
  const sourcePanelTitle = document.getElementById('sourcePanelTitle');
  const sourcePanelItems = document.getElementById('sourcePanelItems');
  const sourceBackBtn = document.getElementById('sourceBackBtn');

  const progress = createProgressBar({
    elapsedEl: document.getElementById('sonosElapsed'),
    remainingEl: document.getElementById('sonosRemaining'),
    fillEl: document.getElementById('sonosProgressFill')
  });

  let rooms = [];
  let lastRoomsJson = '';
  let lastNowPlayingTrack = null; // persisted so the screensaver can read current state without duplicate polling
  let focusedRoom = null;
  let expandedCoordinators = new Set(); // coordinators currently showing their members
  let showingGroupsPanel = false; // true = room list is showing saved groups instead of rooms
  let savedGroupsCache = [];
  let currentlyPlaying = false;
  let sliderDragActive = false; // guards against a poll-triggered re-render wiping an in-progress volume drag

  async function api(path, options) {
    const res = await fetch(path, options);
    return res.json();
  }

  function withClientTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))
    ]);
  }

  function getTopLevelRooms() {
    return rooms.filter((r) => r.coordinator === r.name);
  }

  function getMembersOf(coordinatorName) {
    return rooms.filter((r) => r.coordinator === coordinatorName && r.name !== coordinatorName);
  }

  function measureTextWidth(text, font) {
    const canvas = measureTextWidth._canvas || (measureTextWidth._canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  function render() {
    // A volume slider drag rebuilds the DOM out from under itself if the
    // list re-renders mid-drag (innerHTML is fully rebuilt below) --
    // simplest fix is to just skip re-rendering while a drag is active
    // and catch up once it ends.
    if (sliderDragActive) return;

    if (showingGroupsPanel) {
      renderGroupsPanel();
      return;
    }
    roomlistLabel.textContent = 'Rooms';
    roomlistBackBtn.style.display = 'none';
    savedGroupsAddBtn.style.display = 'none';

    // Size the name column to the widest room name actually present,
    // instead of letting it flex-stretch to fill all remaining width
    // (which was pushing the volume control all the way to the row's
    // far edge, with a large empty gap in between on wide screens).
    const widest = rooms.reduce((max, r) => Math.max(max, measureTextWidth(r.name, '16px Inter, system-ui, sans-serif')), 0);
    roomListEl.style.setProperty('--name-col-width', `${Math.ceil(widest) + 28}px`);

    roomListEl.innerHTML = '';
    roomListEl.appendChild(buildGroupsEntryRow());
    getTopLevelRooms().forEach((room) => {
      const members = getMembersOf(room.name);
      roomListEl.appendChild(buildCoordinatorRow(room, members));
      if (members.length > 0 && expandedCoordinators.has(room.name)) {
        members.forEach((member) => roomListEl.appendChild(buildMemberRow(member)));
      }
    });
  }

  function buildVolumeControl(room) {
    const wrap = document.createElement('div');
    wrap.className = 'roomrow__volwrap';
    // Volume dragging is a distinct gesture from tapping the row itself
    // (which focuses/expands) -- stop it from bubbling into that.
    wrap.addEventListener('click', (e) => e.stopPropagation());

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(room.volume);
    slider.className = 'roomrow__volslider';
    slider.setAttribute('aria-label', `${room.name} volume`);

    const valueLabel = document.createElement('span');
    valueLabel.className = 'roomrow__volvalue';
    valueLabel.textContent = String(room.volume);

    slider.addEventListener('pointerdown', () => {
      sliderDragActive = true;
    });
    slider.addEventListener('input', () => {
      valueLabel.textContent = slider.value;
      if (room.name === focusedRoom && window.VolumeRail) {
        window.VolumeRail.setValue(Number(slider.value));
      }
    });
    slider.addEventListener('change', async () => {
      const newVolume = Number(slider.value);
      room.volume = newVolume; // keep local model in sync until the next poll
      await api(`/api/sonos/room/${encodeURIComponent(room.name)}/volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: newVolume })
      });
      sliderDragActive = false;
      // Adjusting one member's individual volume shifts the group's
      // average -- keep the main rail (which shows group volume when
      // focused room is grouped) in sync with that.
      await syncVolumeRailToFocusedRoom();
    });

    wrap.appendChild(slider);
    wrap.appendChild(valueLabel);

    // Top-level rows show this only when focused (keeps the list
    // quiet); grouped MEMBER rows show it always -- bass/treble/
    // loudness are per-speaker settings, and members are only visible
    // once their group is deliberately expanded, so each grouped room
    // stays individually tweakable without extra taps. (The original
    // focused-only rule technically covered members too, but member
    // rows had no way to BECOME focused, so their EQ was unreachable.)
    if (room.name === focusedRoom || room.coordinator !== room.name) {
      const eqBtn = document.createElement('button');
      eqBtn.className = 'roomrow__eqbtn';
      eqBtn.setAttribute('aria-label', `${room.name} sound settings`);
      const eqIcon = document.createElement('img');
      eqIcon.src = 'icons/eq-settings.png';
      eqIcon.alt = '';
      eqIcon.className = 'roomrow__eqicon';
      eqBtn.appendChild(eqIcon);
      eqBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRoomSettings(room.name);
      });
      wrap.appendChild(eqBtn);
    }

    return wrap;
  }

  function buildCoordinatorRow(room, members) {
    const li = document.createElement('li');
    li.className = 'roomrow';
    if (room.name === focusedRoom) li.classList.add('is-focused');

    // Group icon sits on the LEFT, in the slot the old checkboxes
    // occupied -- top-level rows only (members are managed from the
    // dialog of the room that anchors their group).
    const groupBtn = document.createElement('button');
    groupBtn.className = 'roomrow__groupbtn';
    groupBtn.setAttribute('aria-label', `Group rooms with ${room.name}`);
    const groupIcon = document.createElement('img');
    groupIcon.src = 'icons/group-rooms.png';
    groupIcon.alt = '';
    groupIcon.className = 'roomrow__groupicon';
    groupBtn.appendChild(groupIcon);
    if (room.reachable === false) {
      // Grouping a room that can't receive commands only produces a
      // failed join -- disabled (dimmed via CSS) until it's back.
      groupBtn.disabled = true;
    } else {
      groupBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.GroupDialog) window.GroupDialog.open(room.name);
      });
    }
    li.appendChild(groupBtn);

    const main = document.createElement('div');
    main.className = 'roomrow__main';
    main.addEventListener('click', async () => {
      await selectFocusedRoom(room.name);
      if (members.length > 0) toggleExpanded(room.name);
    });

    const nameLine = document.createElement('div');
    nameLine.className = 'roomrow__nameline';

    if (room.playing) {
      const dot = document.createElement('span');
      dot.className = 'roomrow__playing-dot';
      dot.setAttribute('aria-label', 'Playing');
      nameLine.appendChild(dot);
    }

    if (room.muted) {
      const muteIcon = document.createElement('span');
      muteIcon.className = 'roomrow__mute-icon';
      muteIcon.textContent = '\u{1F507}'; // muted speaker emoji
      muteIcon.setAttribute('aria-label', 'Muted');
      nameLine.appendChild(muteIcon);
    }

    const name = document.createElement('span');
    name.className = 'roomrow__name';
    name.textContent = room.reachable === false ? `${room.name} (disconnected)` : room.name;
    if (room.reachable === false) li.classList.add('is-disconnected');
    nameLine.appendChild(name);

    if (members.length > 0) {
      const chevron = document.createElement('span');
      chevron.className = 'roomrow__chevron';
      chevron.textContent = expandedCoordinators.has(room.name) ? '\u25BE' : '\u25B8';
      nameLine.appendChild(chevron);
    }

    main.appendChild(nameLine);

    if (members.length > 0) {
      const sub = document.createElement('div');
      sub.className = 'roomrow__sublabel';
      const memberLabels = members.map((m) => (m.reachable === false ? `${m.name} (disconnected)` : m.name));
      sub.textContent = `with ${memberLabels.join(', ')}`;
      main.appendChild(sub);
    }

    li.appendChild(main);
    li.appendChild(buildVolumeControl(room));
    return li;
  }

  function buildMemberRow(room) {
    const li = document.createElement('li');
    li.className = 'roomrow roomrow--member';

    const main = document.createElement('div');
    main.className = 'roomrow__main roomrow__main--member';
    // Members are focusable too -- the volume rail then targets that
    // one room's own volume instead of the group master.
    main.addEventListener('click', async () => {
      await selectFocusedRoom(room.name);
    });
    if (room.muted) {
      const muteIcon = document.createElement('span');
      muteIcon.className = 'roomrow__mute-icon';
      muteIcon.textContent = '\u{1F507}';
      muteIcon.setAttribute('aria-label', 'Muted');
      main.appendChild(muteIcon);
    }
    const name = document.createElement('span');
    name.className = 'roomrow__name';
    name.textContent = room.reachable === false ? `${room.name} (disconnected)` : room.name;
    if (room.reachable === false) li.classList.add('is-disconnected');
    main.appendChild(name);
    li.appendChild(main);

    li.appendChild(buildVolumeControl(room));
    return li;
  }

  function toggleExpanded(roomName) {
    if (expandedCoordinators.has(roomName)) expandedCoordinators.delete(roomName);
    else expandedCoordinators.add(roomName);
    render();
  }




  async function selectFocusedRoom(roomName) {
    focusedRoom = roomName;
    if (window.QueuePanel && window.QueuePanel.handleRoomFocused) {
      window.QueuePanel.handleRoomFocused(roomName);
    }
    await refreshNowPlaying();
    render();
    await syncVolumeRailToFocusedRoom();
  }

  async function refreshRooms() {
    const data = await api('/api/sonos/rooms');
    rooms = data.rooms;
    if (!focusedRoom && rooms.length > 0) {
      const topLevel = getTopLevelRooms();
      focusedRoom = topLevel.length > 0 ? topLevel[0].name : rooms[0].name;
      // Seed the queue tab's room knowledge at boot too -- the default
      // focus here doesn't go through selectFocusedRoom().
      if (window.QueuePanel && window.QueuePanel.handleRoomFocused) {
        window.QueuePanel.handleRoomFocused(focusedRoom);
      }
    }
    render();
  }

  // Pull-to-refresh -- forces a genuinely fresh live query (the same
  // one refreshRooms always does, which includes a real reachability
  // check per room), so a room that's been reconnected shows back up
  // without needing a full page reload. Touch-only: only fires when
  // the list is already scrolled to the very top and the person pulls
  // down past a small threshold, so it doesn't fight with normal
  // scrolling.
  (function setupPullToRefresh() {
    let startY = null;
    let pulling = false;
    const THRESHOLD = 60;

    roomListEl.addEventListener('touchstart', (e) => {
      startY = roomListEl.scrollTop <= 0 ? e.touches[0].clientY : null;
    }, { passive: true });

    roomListEl.addEventListener('touchmove', (e) => {
      if (startY === null) return;
      const delta = e.touches[0].clientY - startY;
      const wasPulling = pulling;
      pulling = delta > THRESHOLD && roomListEl.scrollTop <= 0;
      // Progressive feedback DURING the drag, not just after release --
      // otherwise there's no way to tell the gesture even registered
      // until you lift your finger.
      if (delta > 15 && roomListEl.scrollTop <= 0) {
        roomlistPullIndicator.classList.add('is-active');
        roomlistPullIndicator.textContent = pulling ? 'Release to refresh' : 'Pull to refresh';
      } else if (!wasPulling) {
        roomlistPullIndicator.classList.remove('is-active');
      }
    }, { passive: true });

    roomListEl.addEventListener('touchend', async () => {
      if (pulling) {
        pulling = false;
        roomlistPullIndicator.textContent = 'Refreshing\u2026';
        roomlistPullIndicator.classList.add('is-active');
        try {
          // Client-side safety net on top of the server-side timeout
          // fix -- if anything ever hangs regardless, this guarantees
          // the indicator doesn't get stuck forever.
          await withClientTimeout(
            (async () => {
              if (showingGroupsPanel) {
                await refreshRooms();
                await refreshSavedGroups();
              } else {
                await refreshRooms();
              }
            })(),
            8000
          );
        } catch (err) {
          // Swallow -- a failed/timed-out manual refresh just means
          // try again, not worth surfacing an error for.
        } finally {
          roomlistPullIndicator.classList.remove('is-active');
        }
      } else {
        roomlistPullIndicator.classList.remove('is-active');
      }
      startY = null;
    }, { passive: true });
  })();

  // ---------------- Saved group presets ----------------
  // Local equivalent of the official Sonos app's "Saved Groups" (that
  // feature turned out to be cloud-account-only, not reachable from
  // here). Shown as a "GROUPS" entry at the top of the room list --
  // tapping it drills into the list of saved groups (replacing the room
  // list content, same list element, with a back arrow to return).
  // Tapping a saved group applies it (same /api/sonos/group call manual
  // selection uses) and jumps back to the room list automatically.

  async function refreshSavedGroups() {
    const data = await api('/api/sonos/saved-groups');
    savedGroupsCache = data.groups || [];
    if (showingGroupsPanel) render();
  }

  function buildGroupsEntryRow() {
    const li = document.createElement('li');
    li.className = 'roomrow roomrow--groups-entry';
    const main = document.createElement('div');
    main.className = 'roomrow__main';
    main.addEventListener('click', () => {
      showingGroupsPanel = true;
      render();
    });
    const nameLine = document.createElement('div');
    nameLine.className = 'roomrow__nameline';
    const name = document.createElement('span');
    name.className = 'roomrow__name';
    name.textContent = 'Groups';
    nameLine.appendChild(name);
    const chevron = document.createElement('span');
    chevron.className = 'roomrow__chevron';
    chevron.textContent = '\u25B8';
    nameLine.appendChild(chevron);
    main.appendChild(nameLine);
    li.appendChild(main);
    return li;
  }

  function renderGroupsPanel() {
    roomlistLabel.textContent = 'Saved Groups';
    roomlistBackBtn.style.display = '';
    savedGroupsAddBtn.style.display = '';
    roomListEl.innerHTML = '';

    if (savedGroupsCache.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'roomlist__empty';
      empty.textContent = 'No saved groups yet -- tap + to create one.';
      roomListEl.appendChild(empty);
      return;
    }

    savedGroupsCache.forEach((group) => {
      const li = document.createElement('li');
      li.className = 'roomrow roomrow--group';

      const main = document.createElement('div');
      main.className = 'roomrow__main';
      main.addEventListener('click', async () => {
        const result = await api('/api/sonos/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rooms: group.rooms })
        });
        expandedCoordinators.add(group.rooms[0]);
        showingGroupsPanel = false;
        render();
        if (result && result.failed && result.failed.length > 0) {
          // Non-blocking heads-up rather than a hard error -- the rooms
          // that WERE reachable still grouped fine, this just flags
          // that one or more didn't join this time. The saved group
          // itself is untouched, so it'll just work again once that
          // room's back.
          showRoomUnreachableNotice(result.failed);
        }
      });
      const nameLine = document.createElement('div');
      nameLine.className = 'roomrow__nameline';
      const name = document.createElement('span');
      name.className = 'roomrow__name';
      name.textContent = group.name;
      nameLine.appendChild(name);
      main.appendChild(nameLine);
      const sub = document.createElement('div');
      sub.className = 'roomrow__sublabel';
      const liveByName = new Map(rooms.map((r) => [r.name, r]));
      const roomLabels = group.rooms.map((n) => {
        const live = liveByName.get(n);
        return (!live || live.reachable === false) ? `${n} (disconnected)` : n;
      });
      sub.textContent = roomLabels.join(', ');
      main.appendChild(sub);
      li.appendChild(main);

      const editBtn = document.createElement('button');
      editBtn.className = 'roomrow__editbtn';
      editBtn.setAttribute('aria-label', `Edit ${group.name}`);
      editBtn.textContent = '\u270E';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openGroupModal(group);
      });
      li.appendChild(editBtn);

      roomListEl.appendChild(li);
    });
  }

  // Small non-blocking status line reusing the artist label's existing
  // "temporary message" pattern (see the skip-track error handling
  // elsewhere) rather than introducing a whole new toast system for
  // one rare case.
  function showRoomUnreachableNotice(failedRooms) {
    const original = artistEl.textContent;
    artistEl.textContent = `Couldn't reach: ${failedRooms.join(', ')}`;
    setTimeout(() => { refreshNowPlaying(); }, 3000);
  }

  roomlistBackBtn.addEventListener('click', () => {
    showingGroupsPanel = false;
    render();
  });

  // Simple reusable yes/no confirm overlay -- built fresh each call
  // rather than cached, since it's rare enough (deleting a saved group)
  // that reuse isn't worth the extra bookkeeping.
  function showConfirm(message, onYes) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const box = document.createElement('div');
    box.className = 'confirm-box';
    const msg = document.createElement('p');
    msg.className = 'confirm-message';
    msg.textContent = message;
    box.appendChild(msg);
    const btnRow = document.createElement('div');
    btnRow.className = 'confirm-buttons';
    const noBtn = document.createElement('button');
    noBtn.className = 'confirm-btn confirm-btn--no';
    noBtn.textContent = 'No';
    noBtn.addEventListener('click', () => document.body.removeChild(overlay));
    const yesBtn = document.createElement('button');
    yesBtn.className = 'confirm-btn confirm-btn--yes';
    yesBtn.textContent = 'Yes';
    yesBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      onYes();
    });
    btnRow.appendChild(noBtn);
    btnRow.appendChild(yesBtn);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // Creation/edit modal -- one shared implementation for both, since
  // they're the same form (name + room checklist) with edit adding a
  // pre-filled state and a delete option. Deliberately keyboard-
  // optional: the name field auto-fills from whichever rooms are
  // checked, live, right up until the person actually types something
  // themselves -- the whole flow works with taps alone on a kiosk
  // tablet where the on-screen keyboard may not reliably appear.
  let groupModalEl = null;
  function buildGroupModal() {
    const overlay = document.createElement('div');
    overlay.className = 'roomsettings-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });

    const sheet = document.createElement('div');
    sheet.className = 'roomsettings-sheet';

    const header = document.createElement('div');
    header.className = 'roomsettings-sheet__header';
    const title = document.createElement('h3');
    title.className = 'roomsettings-sheet__title';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'roomsettings-sheet__close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
    header.appendChild(title);
    header.appendChild(closeBtn);
    sheet.appendChild(header);

    const checklist = document.createElement('div');
    checklist.className = 'savegroup-checklist';
    sheet.appendChild(checklist);

    const nameRow = document.createElement('div');
    nameRow.className = 'roomsettings-sheet__row';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'savegroup-nameinput';
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    sheet.appendChild(nameRow);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'savegroup-savebtn';
    sheet.appendChild(saveBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'savegroup-deletebtn';
    deleteBtn.innerHTML = '\u{1F5D1}\uFE0F Delete Group';
    sheet.appendChild(deleteBtn);

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    return { overlay, title, checklist, nameInput, saveBtn, deleteBtn };
  }

  async function openGroupModal(existingGroup) {
    if (!groupModalEl) groupModalEl = buildGroupModal();
    const { overlay, title, checklist, nameInput, saveBtn, deleteBtn } = groupModalEl;
    const isEdit = !!existingGroup;
    title.textContent = isEdit ? 'Edit Group' : 'Save a Group';
    saveBtn.textContent = isEdit ? 'Save Changes' : 'Save Group';
    deleteBtn.style.display = isEdit ? '' : 'none';
    overlay.style.display = 'flex';

    // Fresh reachability check right as the modal opens, rather than
    // trusting whatever the last poll happened to leave cached --
    // creating/editing a group is exactly when accurate "is this room
    // actually here right now" data matters most.
    checklist.innerHTML = '<div class="savegroup-checking">Checking rooms\u2026</div>';
    try {
      await withClientTimeout(refreshRooms(), 8000);
    } catch (err) {
      // If this somehow still times out, fall back to whatever's
      // already cached rather than leaving the modal stuck.
    }

    let nameEditedByUser = isEdit; // don't clobber an existing custom name
    nameInput.value = existingGroup ? existingGroup.name : '';
    nameInput.oninput = () => { nameEditedByUser = true; };

    function selectedRooms() {
      return [...checklist.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
    }
    function updateDefaultName() {
      if (nameEditedByUser) return;
      nameInput.value = selectedRooms().join(' + ');
    }

    // Every room ever discovered, not just current top-level ones --
    // plus, for editing, any room the saved group remembers that isn't
    // in the live list at all right now (never rediscovered since
    // startup). Currently-known-unreachable rooms (reachable === false)
    // and unknown-to-this-session ones both show clearly marked rather
    // than silently mixed in with normal rooms -- a saved group should
    // stay editable even with a room currently offline, in case you
    // want to remove it permanently rather than wait for it to
    // reconnect.
    checklist.innerHTML = '';
    const liveNames = new Set(rooms.map((r) => r.name));
    const extraOfflineNames = existingGroup
      ? existingGroup.rooms.filter((n) => !liveNames.has(n))
      : [];
    let allEntries = [
      ...rooms.map((r) => ({ name: r.name, disconnected: r.reachable === false })),
      ...extraOfflineNames.map((n) => ({ name: n, disconnected: true }))
    ];
    // Creating a brand new group: disconnected rooms simply don't show
    // up at all, since there's nothing to save them into yet. Editing
    // an existing group: keep showing them (clearly labeled) so a
    // disconnected member can still be seen and, if wanted, permanently
    // removed rather than waiting for it to reconnect.
    if (!existingGroup) {
      allEntries = allEntries.filter((entry) => !entry.disconnected);
    }

    allEntries.forEach((entry) => {
      const row = document.createElement('label');
      row.className = 'savegroup-checkrow';
      if (entry.disconnected) row.classList.add('is-disconnected');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = entry.name;
      if (existingGroup && existingGroup.rooms.includes(entry.name)) cb.checked = true;
      cb.addEventListener('change', updateDefaultName);
      const span = document.createElement('span');
      span.textContent = entry.disconnected ? `${entry.name} (disconnected)` : entry.name;
      row.appendChild(cb);
      row.appendChild(span);
      checklist.appendChild(row);
    });

    saveBtn.onclick = async () => {
      const selected = selectedRooms();
      if (selected.length < 2) return;
      const body = JSON.stringify({ name: nameInput.value, rooms: selected });
      if (isEdit) {
        await api(`/api/sonos/saved-groups/${encodeURIComponent(existingGroup.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body
        });
      } else {
        await api('/api/sonos/saved-groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        });
      }
      overlay.style.display = 'none';
      await refreshSavedGroups();
    };

    deleteBtn.onclick = () => {
      showConfirm(`Delete "${existingGroup.name}"?`, async () => {
        await api(`/api/sonos/saved-groups/${encodeURIComponent(existingGroup.id)}`, { method: 'DELETE' });
        overlay.style.display = 'none';
        await refreshSavedGroups();
      });
    };
  }

  savedGroupsAddBtn.addEventListener('click', () => openGroupModal(null));


  // Per-room sound settings sheet (bass/treble/loudness) -- built once
  // and reused/repopulated on each open rather than recreated every
  // time, since it's the same structure regardless of which room.
  let settingsSheetEl = null;
  function buildSettingsSheet() {
    const overlay = document.createElement('div');
    overlay.className = 'roomsettings-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });

    const sheet = document.createElement('div');
    sheet.className = 'roomsettings-sheet';

    const header = document.createElement('div');
    header.className = 'roomsettings-sheet__header';
    const title = document.createElement('h3');
    title.className = 'roomsettings-sheet__title';
    title.id = 'roomsettingsTitle';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'roomsettings-sheet__close';
    closeBtn.textContent = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
    header.appendChild(title);
    header.appendChild(closeBtn);
    sheet.appendChild(header);

    function makeSlider(labelText, min, max) {
      const row = document.createElement('div');
      row.className = 'roomsettings-sheet__row';
      const label = document.createElement('label');
      label.textContent = labelText;
      const valueEl = document.createElement('span');
      valueEl.className = 'roomsettings-sheet__value';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      const labelRow = document.createElement('div');
      labelRow.className = 'roomsettings-sheet__labelrow';
      labelRow.appendChild(label);
      labelRow.appendChild(valueEl);
      row.appendChild(labelRow);
      row.appendChild(slider);
      sheet.appendChild(row);
      return { slider, valueEl };
    }
    function makeToggleRow(labelText) {
      const row = document.createElement('div');
      row.className = 'roomsettings-sheet__row roomsettings-sheet__row--toggle';
      const label = document.createElement('label');
      label.textContent = labelText;
      const toggle = document.createElement('button');
      toggle.className = 'roomsettings-sheet__toggle';
      row.appendChild(label);
      row.appendChild(toggle);
      sheet.appendChild(row);
      return toggle;
    }

    const bass = makeSlider('Bass', -10, 10);
    const treble = makeSlider('Treble', -10, 10);
    const loudness = makeToggleRow('Loudness');

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    return { overlay, title, bass, treble, loudness };
  }

  async function openRoomSettings(roomName) {
    if (!settingsSheetEl) settingsSheetEl = buildSettingsSheet();
    const { overlay, title, bass, treble, loudness } = settingsSheetEl;
    title.textContent = `${roomName} Sound`;
    overlay.style.display = 'flex';

    const settings = await api(`/api/sonos/room/${encodeURIComponent(roomName)}/settings`);
    if (!settings) return;

    bass.slider.value = String(settings.bass);
    bass.valueEl.textContent = String(settings.bass);
    bass.slider.oninput = () => { bass.valueEl.textContent = bass.slider.value; };
    bass.slider.onchange = async () => {
      await api(`/api/sonos/room/${encodeURIComponent(roomName)}/bass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: Number(bass.slider.value) })
      });
    };

    treble.slider.value = String(settings.treble);
    treble.valueEl.textContent = String(settings.treble);
    treble.slider.oninput = () => { treble.valueEl.textContent = treble.slider.value; };
    treble.slider.onchange = async () => {
      await api(`/api/sonos/room/${encodeURIComponent(roomName)}/treble`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: Number(treble.slider.value) })
      });
    };

    let loudnessOn = !!settings.loudness;
    const renderLoudness = () => {
      loudness.classList.toggle('is-active', loudnessOn);
      loudness.textContent = loudnessOn ? 'On' : 'Off';
    };
    renderLoudness();
    loudness.onclick = async () => {
      loudnessOn = !loudnessOn;
      renderLoudness();
      await api(`/api/sonos/room/${encodeURIComponent(roomName)}/loudness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: loudnessOn })
      });
    };
  }

  async function refreshNowPlaying() {
    if (!focusedRoom) return;
    const track = await api(`/api/sonos/nowplaying/${encodeURIComponent(focusedRoom)}`);
    lastNowPlayingTrack = track;
    const members = getMembersOf(focusedRoom);
    groupLabelEl.textContent = titleCase(focusedRoom) + (members.length > 0 ? ` +${members.length}` : '');
    // "Up Next" only exists for queue-backed playback (playlists,
    // local albums, anything driving the queue) -- hidden otherwise.
    if (upNextEl) {
      if (track && track.nextTrack && track.nextTrack.title) {
        const n = track.nextTrack;
        upNextEl.textContent = `Up Next: ${n.artist ? `${n.artist} - ` : ''}${n.title}`;
        upNextEl.style.display = '';
      } else {
        upNextEl.style.display = 'none';
      }
    }
    if (track && track.title) {
      // Normal song/track playing -- small source line above, big title below.
      if (track.sourceLine) {
        sourceLineEl.textContent = track.sourceLine;
        sourceLineEl.style.display = '';
      } else {
        sourceLineEl.style.display = 'none';
      }
      titleEl.textContent = track.title;
    } else if (track && track.sourceLine) {
      // No song title (e.g. Line-In) -- show the source descriptor as
      // the main title instead of a generic "Nothing playing", and skip
      // the small source line since it would just repeat the same text.
      sourceLineEl.style.display = 'none';
      titleEl.textContent = track.sourceLine;
    } else {
      sourceLineEl.style.display = 'none';
      titleEl.textContent = 'Nothing playing';
    }
    if (track && track.lineInDeviceName) {
      setLineInLabel(artistEl, track.lineInDeviceName);
    } else {
      artistEl.textContent = track && track.artist ? track.artist : '\u00A0';
    }
    currentlyPlaying = !!(track && track.playing);
    playPauseBtn.textContent = currentlyPlaying ? '\u23F8' : '\u25B6';

    if (track && track.albumArtUrl) {
      artEl.style.backgroundImage = `url("${track.albumArtUrl}")`;
      artEl.style.backgroundSize = 'cover';
    } else {
      artEl.style.backgroundImage = '';
    }

    progress.update(track ? track.position : 0, track ? track.duration : 0, currentlyPlaying);

    updateShuffleCrossfadeUI(track);
    updateSleepTimerBadge(track ? track.sleepTimerRemainingSeconds : 0);
  }

  function updateShuffleCrossfadeUI(track) {
    const shuffleOn = !!(track && track.shuffleOn);
    const shuffleAvailable = !track || track.shuffleAvailable !== false;
    shuffleBtn.classList.toggle('is-active', shuffleOn);
    shuffleBtn.setAttribute('aria-pressed', String(shuffleOn));
    shuffleBtn.disabled = !shuffleAvailable;
    shuffleBtn.classList.toggle('is-disabled', !shuffleAvailable);
    shuffleBtn.title = shuffleAvailable ? 'Shuffle' : 'Shuffle unavailable on streams';

    // Repeat rides the same play-mode string, so it's available exactly
    // where shuffle is (queue-backed playback, playlists included).
    if (repeatBtn) {
      const mode = (track && track.repeatMode) || 'off';
      repeatBtn.classList.toggle('is-active', mode !== 'off');
      repeatBtn.setAttribute('aria-pressed', String(mode !== 'off'));
      repeatBtn.disabled = !shuffleAvailable;
      repeatBtn.classList.toggle('is-disabled', !shuffleAvailable);
      repeatBtn.title = shuffleAvailable
        ? (mode === 'one' ? 'Repeat: this track' : mode === 'all' ? 'Repeat: whole queue' : 'Repeat: off')
        : 'Repeat unavailable on streams';
      if (repeatDot) repeatDot.style.display = mode === 'all' ? '' : 'none';
      if (repeatOneEl) repeatOneEl.style.display = mode === 'one' ? '' : 'none';
    }

    const crossfadeOn = !!(track && track.crossfadeOn);
    crossfadeBtn.classList.toggle('is-active', crossfadeOn);
    crossfadeBtn.setAttribute('aria-pressed', String(crossfadeOn));
    crossfadeBtn.title = crossfadeOn ? 'Crossfade: on' : 'Crossfade: off';
  }

  function formatSleepTimerBadge(seconds) {
    if (seconds <= 0) return '';
    const mins = Math.ceil(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }

  function updateSleepTimerBadge(seconds) {
    const label = formatSleepTimerBadge(seconds || 0);
    if (label) {
      sleepTimerBadge.textContent = label;
      sleepTimerBadge.style.display = '';
      sleepTimerBtn.classList.add('is-active');
    } else {
      sleepTimerBadge.style.display = 'none';
      sleepTimerBtn.classList.remove('is-active');
    }
  }

  async function syncVolumeRailToFocusedRoom() {
    if (!focusedRoom || !window.VolumeRail) return;
    const members = getMembersOf(focusedRoom);
    if (members.length > 0) {
      const data = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/group-volume`);
      window.VolumeRail.setValue(data.volume);
    } else {
      const room = rooms.find((r) => r.name === focusedRoom);
      if (room) window.VolumeRail.setValue(room.volume);
    }
  }

  playPauseBtn.addEventListener('click', async () => {
    if (!focusedRoom) return;
    // Mirrors the prev/next handlers below: surface a failed
    // pause/play instead of silently swallowing it. Found the hard way
    // during Local Music Library testing -- a pause that the speaker
    // rejects (e.g. UPnP 701 because the focused room isn't actually
    // playing) previously showed NOTHING, making the button feel dead.
    const action = currentlyPlaying ? 'pause' : 'play';
    const result = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/${action}`, { method: 'POST' });
    if (result && result.error) {
      artistEl.textContent = currentlyPlaying ? "Can't pause right now" : "Can't play right now";
      setTimeout(refreshNowPlaying, 2000);
    } else {
      await refreshNowPlaying();
    }
  });

  prevBtn.addEventListener('click', async () => {
    if (!focusedRoom) return;
    const result = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/previous`, { method: 'POST' });
    if (result && result.error) {
      artistEl.textContent = "Can't skip back right now";
      setTimeout(refreshNowPlaying, 2000);
    } else {
      await refreshNowPlaying();
    }
  });
  nextBtn.addEventListener('click', async () => {
    if (!focusedRoom) return;
    const result = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/next`, { method: 'POST' });
    if (result && result.error) {
      artistEl.textContent = "Can't skip right now";
      setTimeout(refreshNowPlaying, 2000);
    } else {
      await refreshNowPlaying();
    }
  });

  shuffleBtn.addEventListener('click', async () => {
    if (!focusedRoom || shuffleBtn.disabled) return;
    const nowOn = !shuffleBtn.classList.contains('is-active');
    shuffleBtn.classList.toggle('is-active', nowOn); // optimistic, corrected by the next refresh either way
    await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/shuffle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nowOn })
    });
    await refreshNowPlaying();
    // S2 firmware physically reorders Q:0 when shuffle toggles (and
    // restores the original order on disable) -- refresh the queue tab
    // so the new order shows without tabbing away and back. The
    // QueueChanged event also fires when the speaker finishes the
    // reorder; the panel's debounce collapses the two into one fetch.
    if (window.QueuePanel && window.QueuePanel.refreshIfOpen) {
      window.QueuePanel.refreshIfOpen();
    }
  });

  crossfadeBtn.addEventListener('click', async () => {
    if (!focusedRoom) return;
    const nowOn = !crossfadeBtn.classList.contains('is-active');
    crossfadeBtn.classList.toggle('is-active', nowOn);
    await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/crossfade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nowOn })
    });
    await refreshNowPlaying();
  });

  // Sleep timer picker -- covers everything from 15 minutes up to 12
  // hours. Values are in minutes; the server converts to the H:MM:SS
  // string ConfigureSleepTimer expects.
  const SLEEP_TIMER_OPTIONS_MINUTES = [15, 30, 45, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360, 420, 480, 540, 600, 660, 720];
  function buildSleepTimerMenu() {
    sleepTimerMenu.innerHTML = '';
    const offItem = document.createElement('li');
    const offBtn = document.createElement('button');
    offBtn.textContent = 'Off';
    offBtn.addEventListener('click', async () => {
      sleepTimerOverlay.style.display = 'none';
      if (!focusedRoom) return;
      await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/sleeptimer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: 0 })
      });
      await refreshNowPlaying();
    });
    offItem.appendChild(offBtn);
    sleepTimerMenu.appendChild(offItem);

    SLEEP_TIMER_OPTIONS_MINUTES.forEach((mins) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = mins < 60 ? `${mins}m` : (mins % 60 === 0 ? `${mins / 60}h` : `${(mins / 60).toFixed(1)}h`);
      btn.addEventListener('click', async () => {
        sleepTimerOverlay.style.display = 'none';
        if (!focusedRoom) return;
        await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/sleeptimer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minutes: mins })
        });
        await refreshNowPlaying();
      });
      li.appendChild(btn);
      sleepTimerMenu.appendChild(li);
    });
  }
  buildSleepTimerMenu();

  sleepTimerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sleepTimerOverlay.style.display = sleepTimerOverlay.style.display === 'none' ? 'flex' : 'none';
  });
  // Overlay closes on backdrop tap or Escape (selecting a duration
  // already closes it in the option handlers above).
  sleepTimerOverlay.addEventListener('click', (e) => {
    if (e.target === sleepTimerOverlay) sleepTimerOverlay.style.display = 'none';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sleepTimerOverlay.style.display !== 'none') {
      sleepTimerOverlay.style.display = 'none';
    }
  });

  // ---------------- Source browsing (two levels: groups, then items) ----------------

  let currentGroup = null; // null = top-level groups list
  let previewMessageTimer = null;

  let backStack = []; // functions to call to go back one level, most recent last

  function updateBackButtonVisibility() {
    sourceBackBtn.style.visibility = backStack.length === 0 ? 'hidden' : 'visible';
  }

  async function openSourceGroups() {
    hideLibrarySearch();
    if (!focusedRoom) return;
    currentGroup = null;
    backStack = [];
    updateBackButtonVisibility();
    sourcePanelTitle.textContent = 'Select a Music Source';
    sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
    const data = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/source-groups`);
    renderTopLevel(data.groups || []);
    prefetchArtwork(data.groups || []); // fire-and-forget, doesn't block the UI
  }

  // The server now warms its own Favorites/Playlists metadata cache at
  // startup, but that only covers track names/services -- the actual
  // album art images are served directly by each Sonos speaker to the
  // browser, entirely outside anything the server caches. Confirmed via
  // testing: metadata was warm immediately, but art still only started
  // loading the moment a screen was actually opened. This prefetches the
  // real image bytes into the browser's own cache in the background, so
  // by the time someone actually taps into Favorites or Playlists, the
  // pictures are already sitting there instead of loading fresh.
  async function prefetchArtwork(groups) {
    for (const group of groups) {
      if (group.isLineInRoot) continue; // no artwork to prefetch
      // Music Library is browsed on demand and can be enormous -- never
      // prefetch it, that would mean walking a huge tree at startup.
      if (group.isMusicLibraryRoot || group.isLocalLibraryRoot) continue;
      try {
        let items = [];
        if (group.isPlaylistRoot) {
          const data = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/playlists`);
          const playlists = data.items || [];
          const trackLists = await Promise.all(
            playlists.map((pl) =>
              api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/browse-container?id=${encodeURIComponent(pl.id)}`)
                .then((d) => d.items || [])
                .catch(() => [])
            )
          );
          items = trackLists.flat();
        } else {
          const data = await api(
            `/api/sonos/room/${encodeURIComponent(focusedRoom)}/favorites-by-group?group=${encodeURIComponent(group.title)}`
          );
          items = data.items || [];
        }
        items.forEach((item) => {
          if (item.albumArtUrl) {
            const img = new Image();
            img.src = item.albumArtUrl;
          }
        });
      } catch (err) {
        // Best-effort per group -- one group failing (timeout, error,
        // etc) shouldn't stop every other group from being prefetched.
        // Confirmed via real testing: this was previously one try/catch
        // around the entire loop, so a single failing group silently
        // aborted everything after it, including Playlists depending on
        // ordering -- exactly matching "only loads when selecting the
        // playlist" (the prefetch never got that far).
      }
    }
  }

  async function openGroup(group) {
    hideLibrarySearch();
    backStack = [() => openSourceGroups()];
    updateBackButtonVisibility();

    if (group.isLineInRoot) {
      currentGroup = 'Line-In';
      sourcePanelTitle.textContent = 'Line-In';
      sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
      const data = await api('/api/sonos/linein-rooms');
      const items = (data.rooms || []).map((r) => ({
        title: r.title,
        roomName: r.roomName,
        currentName: r.currentName,
        browsable: false,
        isLineInLeaf: true
      }));
      renderLeafItems(items, 'No Line-In rooms detected. Check the DBG panel if this looks wrong.');
      return;
    }

    if (group.isLocalLibraryRoot) {
      currentGroup = 'Network Music Library';
      sourcePanelTitle.textContent = 'Network Music Library';
      sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
      const data = await api('/api/local/library-categories');
      renderLibraryCategories(data.categories || [], LOCAL_LIBRARY_GROUP);
      return;
    }

    if (group.isMusicLibraryRoot) {
      currentGroup = 'Sonos Music Library';
      sourcePanelTitle.textContent = 'Sonos Music Library';
      sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
      const data = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/music-library`);
      renderLibraryCategories(data.categories || []);
      return;
    }

    if (group.isPlaylistRoot) {
      currentGroup = 'Playlists';
      sourcePanelTitle.textContent = 'Playlists';
      sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
      const data = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/playlists`);
      renderPlaylistItems(data.items || [], 'No playlists found.');
      return;
    }

    currentGroup = group.title;
    sourcePanelTitle.textContent = group.id && String(group.id).startsWith('svc:') ? displayService(group.title) : group.title;
    sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
    const data = await api(
      `/api/sonos/room/${encodeURIComponent(focusedRoom)}/favorites-by-group?group=${encodeURIComponent(group.title)}`
    );
    renderLeafItems(data.items || [], 'Nothing here.');
  }

  // Each playlist shows the icon for whichever service its tracks
  // actually came from (determined server-side by peeking its first
  // track, since a playlist container itself carries no service label
  // -- confirmed via real data). Playlists themselves are containers
  // needing one more level of drill-down to their individual tracks.
  function renderPlaylistItems(items, emptyMessage) {
    sourcePanelItems.innerHTML = '';
    if (items.length === 0) {
      sourcePanelItems.innerHTML = `<li class="sourcepanel__loading">${emptyMessage}</li>`;
      return;
    }

    // Grouped by service with section headers, e.g. all Plex playlists
    // under one "PLEX" header -- a visual grouping within a single
    // scrollable list, not an extra navigation level (tapping a
    // playlist still drills straight to its tracks, same as before).
    const groups = new Map();
    items.forEach((item) => {
      const key = item.serviceLabel || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

    sortedKeys.forEach((serviceLabel) => {
      const header = document.createElement('li');
      header.className = 'sourcepanel__groupheader';
      header.appendChild(buildImgIconWithFallback(iconFilenameForService(serviceLabel)));
      const headerLabel = document.createElement('span');
      headerLabel.textContent = displayService(serviceLabel);
      header.appendChild(headerLabel);
      sourcePanelItems.appendChild(header);

      groups.get(serviceLabel).forEach((item) => {
        const li = document.createElement('li');
        li.className = 'sourcepanel__item sourcepanel__item--grouped';

        const labelBlock = document.createElement('div');
        labelBlock.className = 'sourcepanel__labelblock';
        const label = document.createElement('span');
        label.className = 'sourcepanel__label';
        label.textContent = item.title;
        labelBlock.appendChild(label);
        li.appendChild(labelBlock);

        const chevron = document.createElement('span');
        chevron.className = 'sourcepanel__chevron';
        chevron.textContent = '\u203A';
        li.appendChild(chevron);

        li.addEventListener('click', async () => {
          backStack.push(() => openGroup({ id: 'SQ:', title: 'Playlists', browsable: true, isPlaylistRoot: true }));
          updateBackButtonVisibility();
          sourcePanelTitle.textContent = item.title;
          sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
          const data = await api(
            `/api/sonos/room/${encodeURIComponent(focusedRoom)}/browse-container?id=${encodeURIComponent(item.id)}`
          );
          renderLeafItems(data.items || [], 'Nothing here.', item.id, item.title);
        });

        sourcePanelItems.appendChild(li);
      });
    });
  }

  function showPreviewMessage(text) {
    sourcePanelItems.insertAdjacentHTML(
      'afterbegin',
      `<li class="sourcepanel__loading" id="previewMsg">${text}</li>`
    );
    if (previewMessageTimer) clearTimeout(previewMessageTimer);
    previewMessageTimer = setTimeout(() => {
      const el = document.getElementById('previewMsg');
      if (el) el.remove();
    }, 3500);
  }

  function renderTopLevel(groups) {
    sourcePanelItems.innerHTML = '';
    if (groups.length === 0) {
      sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">No favorites found yet -- star some in the Sonos app.</li>';
      return;
    }
    groups.forEach((group) => {
      const li = document.createElement('li');
      li.className = 'sourcepanel__item';

      const icon = buildSourceIcon(group);
      li.appendChild(icon);

      const labelBlock = document.createElement('div');
      labelBlock.className = 'sourcepanel__labelblock';
      const label = document.createElement('span');
      label.className = 'sourcepanel__label';
      label.textContent = group.id && String(group.id).startsWith('svc:') ? displayService(group.title) : group.title;
      labelBlock.appendChild(label);
      li.appendChild(labelBlock);

      const chevron = document.createElement('span');
      chevron.className = 'sourcepanel__chevron';
      chevron.textContent = '\u203A';
      li.appendChild(chevron);

      li.addEventListener('click', () => openGroup(group));
      sourcePanelItems.appendChild(li);
    });
  }

  // ---------------- Add to playlist ----------------
  // Shared picker: lists existing Sonos Playlists plus a "New
  // playlist" option. Used from music library rows (a single track or
  // a whole album) -- the caller just hands over a payload describing
  // what to add.
  let playlistPickerEl = null;
  function buildPlaylistPicker() {
    const overlay = document.createElement('div');
    overlay.className = 'roomsettings-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
    const sheet = document.createElement('div');
    sheet.className = 'roomsettings-sheet';
    const header = document.createElement('div');
    header.className = 'roomsettings-sheet__header';
    const title = document.createElement('h3');
    title.className = 'roomsettings-sheet__title';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'roomsettings-sheet__close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
    header.appendChild(title);
    header.appendChild(closeBtn);
    sheet.appendChild(header);
    const list = document.createElement('div');
    list.className = 'savegroup-checklist';
    sheet.appendChild(list);
    const status = document.createElement('p');
    status.className = 'playlistpicker__status';
    sheet.appendChild(status);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    return { overlay, title, list, status };
  }

  async function openPlaylistPicker(label, payload) {
    if (!playlistPickerEl) playlistPickerEl = buildPlaylistPicker();
    const { overlay, title, list, status } = playlistPickerEl;
    title.textContent = `Add "${label}" to\u2026`;
    status.textContent = '';
    overlay.style.display = 'flex';
    list.innerHTML = '<div class="savegroup-checking">Loading playlists\u2026</div>';

    // NOTE: this route responds with { items }, not { playlists } --
    // reading the wrong key here was why the picker always showed an
    // empty list.
    const data = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/playlists`);
    const playlists = data.items || [];
    list.innerHTML = '';

    async function addTo(playlistId) {
      status.textContent = 'Adding\u2026';
      const result = await api(`/api/sonos/playlists/${encodeURIComponent(playlistId)}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, room: focusedRoom })
      });
      if (result && result.error) {
        status.textContent = `Couldn't add: ${result.error}`;
        return;
      }
      // A container add reports per-track results, since some tracks
      // can fail individually (see addContainerToPlaylist server-side).
      if (typeof result.failed !== 'undefined' && Array.isArray(result.failed) && result.failed.length > 0) {
        status.textContent = `Added ${result.added}, ${result.failed.length} failed`;
      } else {
        status.textContent = 'Added.';
      }
      setTimeout(() => { overlay.style.display = 'none'; }, 900);
    }

    const newRow = document.createElement('div');
    newRow.className = 'savegroup-checkrow playlistpicker__new';
    newRow.textContent = '+  New playlist\u2026';
    newRow.addEventListener('click', () => {
      list.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'roomsettings-sheet__row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'savegroup-nameinput';
      // Prefilled so this still works with taps alone on a kiosk
      // tablet where the on-screen keyboard may not appear.
      input.value = label;
      const go = document.createElement('button');
      go.className = 'savegroup-savebtn';
      go.textContent = 'Create and add';
      go.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        status.textContent = 'Creating\u2026';
        const created = await api('/api/sonos/playlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: name })
        });
        if (!created || !created.playlist) {
          status.textContent = "Couldn't create that playlist";
          return;
        }
        await addTo(created.playlist.id);
      });
      wrap.appendChild(input);
      wrap.appendChild(go);
      list.appendChild(wrap);
    });
    list.appendChild(newRow);

    playlists.forEach((pl) => {
      const row = document.createElement('div');
      row.className = 'savegroup-checkrow';
      row.textContent = pl.title;
      row.addEventListener('click', () => addTo(pl.id));
      list.appendChild(row);
    });
  }

  // The vertical-ellipsis button on browse rows: opens the Play Now /
  // Play Next / Add to Queue sheet (queuePanel.js) for a track or a
  // whole album/container.
  function buildQueueButton(label, payload) {
    const btn = document.createElement('button');
    btn.className = 'sourcepanel__queuebtn';
    btn.innerHTML = '&#8942;';
    btn.setAttribute('aria-label', `Queue options for ${label}`);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.QueuePanel && focusedRoom) {
        window.QueuePanel.showActions({ label, room: focusedRoom, ...payload });
      }
    });
    return btn;
  }

  function buildAddToPlaylistButton(label, payload) {
    const btn = document.createElement('button');
    btn.className = 'sourcepanel__addbtn';
    btn.textContent = '+';
    btn.setAttribute('aria-label', `Add ${label} to a playlist`);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPlaylistPicker(label, payload);
    });
    return btn;
  }

  // ---------------- Music Library browsing ----------------
  // The Music Library is genuinely recursive (Artists -> an artist ->
  // their albums -> tracks), which renderLeafItems can't express -- it
  // only plays leaf items and has no drill-in path for containers. So
  // this is its own small browser built on the same generic
  // ContentDirectory Browse the server already exposes, plus paging,
  // since a real library can run to tens of thousands of entries and
  // one Browse call only returns a slice.
  const MUSIC_LIBRARY_GROUP = { id: 'musiclibrary', title: 'Music Library', browsable: true, isMusicLibraryRoot: true };
  const LOCAL_LIBRARY_GROUP = { id: 'locallibrary', title: 'Local Library', browsable: true, isLocalLibraryRoot: true };

  function renderLibraryCategories(categories, backGroup = MUSIC_LIBRARY_GROUP) {
    hideLibrarySearch();
    sourcePanelItems.innerHTML = '';
    if (categories.length === 0) {
      sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">No music library found. Add a music share in the Sonos app first.</li>';
      return;
    }
    categories.forEach((cat) => {
      const li = document.createElement('li');
      li.className = 'sourcepanel__item';
      const labelBlock = document.createElement('div');
      labelBlock.className = 'sourcepanel__labelblock';
      const label = document.createElement('span');
      label.className = 'sourcepanel__label';
      label.textContent = cat.title;
      labelBlock.appendChild(label);
      li.appendChild(labelBlock);
      const chevron = document.createElement('span');
      chevron.className = 'sourcepanel__chevron';
      chevron.textContent = '\u203A';
      li.appendChild(chevron);
      li.addEventListener('click', () => {
        backStack.push(() => openGroup(backGroup));
        updateBackButtonVisibility();
        showLibraryContainer(cat.id, cat.title, cat.id);
      });
      sourcePanelItems.appendChild(li);
    });
  }

  // Search scope follows whichever category you're inside -- under
  // Artists it searches artists, under Songs it searches songs. Sonos
  // implements this as an ordinary Browse against "<category>:<term>",
  // so it reuses the exact same paging/render path as normal browsing.
  // Folders (S:) is excluded: that ObjectID is a filesystem path
  // namespace, not a searchable index, so appending a term there is
  // meaningless.
  let librarySearchRoot = null;   // category ObjectID, or null when search is off
  let librarySearchTitle = '';
  let librarySearchTimer = null;

  function isSearchableCategory(categoryId) {
    if (typeof categoryId !== 'string') return false;
    if (categoryId.startsWith('A:')) return categoryId !== 'A:PLAYLISTS';
    // Local Music Library categories search the same way (the server
    // treats "L:CATEGORY:term" as a search, mirroring Sonos's own
    // "<category>:<term>" browse convention). Folders is a path
    // namespace, not a searchable index -- same exclusion as S:.
    if (categoryId.startsWith('L:')) return categoryId !== 'L:FOLDERS';
    return false;
  }

  function hideLibrarySearch() {
    librarySearchRoot = null;
    if (librarySearchTimer) clearTimeout(librarySearchTimer);
    sourceSearchWrap.style.display = 'none';
    sourceSearchInput.value = '';
  }

  function showLibrarySearch(categoryId, categoryTitle) {
    librarySearchRoot = categoryId;
    librarySearchTitle = categoryTitle;
    sourceSearchInput.placeholder = `Search ${categoryTitle}`;
    sourceSearchWrap.style.display = '';
  }

  async function runLibrarySearch(term) {
    if (!librarySearchRoot) return;
    const trimmed = term.trim();
    if (trimmed === '') {
      // Empty box means "show the whole category again".
      await showLibraryContainer(librarySearchRoot, librarySearchTitle, librarySearchRoot, true);
      return;
    }
    sourcePanelTitle.textContent = `${librarySearchTitle}: ${trimmed}`;
    sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Searching\u2026</li>';
    const searchId = `${librarySearchRoot}:${encodeURIComponent(trimmed)}`;
    const state = { containerId: searchId, title: librarySearchTitle, categoryId: librarySearchRoot, items: [], total: 0, nextStart: 0 };
    await loadLibraryPage(state);
  }

  sourceSearchInput.addEventListener('input', () => {
    if (librarySearchTimer) clearTimeout(librarySearchTimer);
    const term = sourceSearchInput.value;
    // Debounced so typing doesn't fire a Browse per keystroke against a
    // large library.
    librarySearchTimer = setTimeout(() => runLibrarySearch(term), 400);
  });
  sourceSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (librarySearchTimer) clearTimeout(librarySearchTimer);
      runLibrarySearch(sourceSearchInput.value);
    }
  });
  sourceSearchClear.addEventListener('click', () => {
    sourceSearchInput.value = '';
    runLibrarySearch('');
  });

  async function showLibraryContainer(containerId, title, categoryId, keepSearchBox) {
    currentGroup = title;
    sourcePanelTitle.textContent = title;
    sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
    // The search box stays put at the category level and disappears once
    // you drill deeper (searching "albums by this artist" isn't a thing
    // Sonos exposes) -- keepSearchBox is set when re-showing a category
    // after clearing the box, so it isn't torn down mid-use.
    if (isSearchableCategory(categoryId) && containerId === categoryId) {
      if (!keepSearchBox) showLibrarySearch(categoryId, title);
    } else {
      hideLibrarySearch();
    }
    const state = { containerId, title, categoryId, items: [], total: 0, nextStart: 0 };
    await loadLibraryPage(state);
  }

  async function loadLibraryPage(state) {
    const data = await api(
      `/api/sonos/room/${encodeURIComponent(focusedRoom)}/browse-container?id=${encodeURIComponent(state.containerId)}&start=${state.nextStart}`
    );
    state.items = state.items.concat(data.items || []);
    state.total = typeof data.total === 'number' ? data.total : state.items.length;
    state.nextStart = state.items.length;
    renderLibraryItems(state);
  }

  const LOCAL_SEP = '\u001f';
  function isPlayableContainer(id) {
    const v = String(id || '');
    if (v.startsWith('SQ:') && v !== 'SQ:') return true;
    if (/^A:(ALBUM|ARTIST|GENRE|COMPOSER)\//.test(v)) return true;
    if (v.startsWith('L:')) {
      const token = v.slice(2).split(LOCAL_SEP)[0].split(':')[0];
      return ['ALBUM', 'ARTIST', 'ARTISTTRACKS', 'GENRE', 'GENRETRACKS', 'RECENT'].includes(token);
    }
    return false;
  }

  // Play / Shuffle header on any playable container (albums, artists,
  // genres, playlists, Recently Added) -- the same actions the \u22ee menu
  // offers, surfaced where every browsing session actually lands.
  function buildContainerActionsRow(state) {
    const li = document.createElement('li');
    li.className = 'sourcepanel__actions';
    const make = (label, primary) => {
      const btn = document.createElement('button');
      btn.className = 'sourcepanel__actionbtn' + (primary ? ' sourcepanel__actionbtn--primary' : '');
      btn.textContent = label;
      li.appendChild(btn);
      return btn;
    };
    const playBtn = make('\u25B6  Play', true);
    const shuffleBtn2 = make('\u{1F500}  Shuffle', false);
    const fire = async (withShuffle) => {
      playBtn.disabled = true; shuffleBtn2.disabled = true;
      await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/queue/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containerId: state.containerId, mode: 'now' })
      });
      if (withShuffle) {
        await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/shuffle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ on: true })
        });
      }
      playBtn.disabled = false; shuffleBtn2.disabled = false;
      await refreshNowPlaying();
    };
    playBtn.addEventListener('click', () => fire(false));
    shuffleBtn2.addEventListener('click', () => fire(true));
    return li;
  }

  function renderLibraryItems(state) {
    sourcePanelItems.innerHTML = '';
    // Category roots (Artists, Albums...) are navigational, not playable
    // -- except Recently Added, which is both a category and a direct
    // track list worth a Play/Shuffle of its own.
    if (isPlayableContainer(state.containerId) && (state.containerId !== state.categoryId || state.containerId === 'L:RECENT')) {
      sourcePanelItems.appendChild(buildContainerActionsRow(state));
    }
    if (state.items.length === 0) {
      sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Nothing here.</li>';
      return;
    }

    state.items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'sourcepanel__item';

      const art = document.createElement('div');
      art.className = 'sourcepanel__art';
      if (item.albumArtUrl) {
        art.style.backgroundImage = `url("${item.albumArtUrl}")`;
        art.style.backgroundSize = 'cover';
      } else {
        // Artists, composers, genres and folders have no artwork of
        // their own -- Sonos doesn't return any for those container
        // types, so rather than an empty tile these get a letter badge
        // in the theme accent. Albums and tracks fall through to real
        // artwork as normal.
        art.classList.add('sourcepanel__art--letter');
        const first = (item.title || '').trim().charAt(0).toUpperCase();
        art.textContent = /[A-Z0-9]/.test(first) ? first : '#';
      }
      li.appendChild(art);

      const labelBlock = document.createElement('div');
      labelBlock.className = 'sourcepanel__labelblock';
      const label = document.createElement('span');
      label.className = 'sourcepanel__label';
      label.textContent = item.title;
      labelBlock.appendChild(label);
      if (item.artist) {
        const sub = document.createElement('span');
        sub.className = 'sourcepanel__servicelabel';
        sub.textContent = item.artist;
        labelBlock.appendChild(sub);
      }
      li.appendChild(labelBlock);

      if (item.browsable) {
        const chevron = document.createElement('span');
        chevron.className = 'sourcepanel__chevron';
        chevron.textContent = '\u203A';
        li.appendChild(chevron);
        li.addEventListener('click', () => {
          backStack.push(() => showLibraryContainer(state.containerId, state.title, state.categoryId));
          updateBackButtonVisibility();
          showLibraryContainer(item.id, item.title, state.categoryId);
        });
        // Albums (and any container of tracks) can be added wholesale.
        // Skipped for the big index categories -- "add all of Artists"
        // isn't a meaningful action.
        if (state.categoryId !== state.containerId || state.categoryId === 'A:ALBUM') {
          li.appendChild(buildQueueButton(item.title, { containerId: item.id }));
          li.appendChild(buildAddToPlaylistButton(item.title, { containerId: item.id }));
        }
      } else if (item.uri) {
        li.addEventListener('click', async () => {
          // Playing a track from inside an album should queue the whole
          // album and jump to that track, not play it standalone with
          // nothing to skip to -- the same lesson already learned with
          // playlists. Guarded by size: doing this inside "Songs"
          // (potentially tens of thousands of tracks) would be absurd,
          // so anything larger than one page falls back to playing the
          // single track.
          const queueWholeContainer = state.total > 0 && state.total <= 200;
          if (queueWholeContainer) {
            await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/play-playlist-track`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ playlistId: state.containerId, playlistTitle: state.title, uri: item.uri })
            });
          } else {
            await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/play-item`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uri: item.uri, metadata: item.metadata })
            });
          }
          await openSourceGroups();
          setTimeout(refreshNowPlaying, 800);
        });
        li.appendChild(buildQueueButton(item.title, { uri: item.uri, metadata: item.metadata }));
        li.appendChild(buildAddToPlaylistButton(item.title, { uri: item.uri, metadata: item.metadata }));
      }

      sourcePanelItems.appendChild(li);
    });

    if (state.items.length < state.total) {
      const more = document.createElement('li');
      more.className = 'sourcepanel__item sourcepanel__loadmore';
      more.textContent = `Load more (${state.items.length} of ${state.total})`;
      more.addEventListener('click', async () => {
        more.textContent = 'Loading\u2026';
        await loadLibraryPage(state);
      });
      sourcePanelItems.appendChild(more);
    }
  }

  function renderLeafItems(items, emptyMessage, playlistContainerId, playlistTitle) {
    sourcePanelItems.innerHTML = '';
    if (items.length === 0) {
      sourcePanelItems.innerHTML = `<li class="sourcepanel__loading">${emptyMessage}</li>`;
      // Even an empty playlist should still be deletable.
      appendPlaylistDeleteRow(playlistContainerId, playlistTitle);
      return;
    }
    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'sourcepanel__item';

      // Account entry ("Albert's Playlists") -- the user list a
      // multi-login service opens to. Tapping drills to that account's
      // own favorites; the pencil renames it inline.
      if (item.isAccountEntry) {
        if (item.serviceLabel) li.appendChild(buildImgIconWithFallback(iconFilenameForService(item.serviceLabel)));
        const labelBlock = document.createElement('div');
        labelBlock.className = 'sourcepanel__labelblock';
        const label = document.createElement('span');
        label.className = 'sourcepanel__label';
        label.textContent = item.title;
        labelBlock.appendChild(label);
        const sub = document.createElement('span');
        sub.className = 'sourcepanel__servicelabel';
        sub.textContent = `${item.count} favorite${item.count === 1 ? '' : 's'}`;
        labelBlock.appendChild(sub);
        li.appendChild(labelBlock);

        const renameBtn = document.createElement('button');
        renameBtn.className = 'sourcepanel__removebtn';
        renameBtn.textContent = '\u270F\uFE0F';
        renameBtn.setAttribute('aria-label', `Rename ${item.title}`);
        renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          labelBlock.innerHTML = '';
          li.classList.add('sourcepanel__renamerow');
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'sourcepanel__renameinput';
          input.value = item.title.startsWith('Account ') ? '' : item.title;
          input.placeholder = "e.g. Albert's Playlists";
          input.addEventListener('click', (e2) => e2.stopPropagation());
          const save = document.createElement('button');
          save.className = 'sourcepanel__actionbtn sourcepanel__actionbtn--primary';
          save.textContent = 'Save';
          save.addEventListener('click', async (e2) => {
            e2.stopPropagation();
            save.textContent = '\u2026';
            await api('/api/sonos/account-names', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sn: item.sn, name: input.value.trim() })
            });
            const data = await api(
              `/api/sonos/room/${encodeURIComponent(focusedRoom)}/favorites-by-group?group=${encodeURIComponent(item.serviceLabel)}`
            );
            renderLeafItems(data.items || [], 'Nothing here.');
          });
          labelBlock.appendChild(input);
          labelBlock.appendChild(save);
          input.focus();
        });
        li.appendChild(renameBtn);

        const chevron = document.createElement('span');
        chevron.className = 'sourcepanel__chevron';
        chevron.textContent = '\u203A';
        li.appendChild(chevron);

        li.addEventListener('click', async () => {
          backStack.push(async () => {
            sourcePanelTitle.textContent = item.serviceLabel;
            const data = await api(
              `/api/sonos/room/${encodeURIComponent(focusedRoom)}/favorites-by-group?group=${encodeURIComponent(item.serviceLabel)}`
            );
            renderLeafItems(data.items || [], 'Nothing here.');
          });
          updateBackButtonVisibility();
          sourcePanelTitle.textContent = item.title;
          sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
          const data = await api(
            `/api/sonos/room/${encodeURIComponent(focusedRoom)}/favorites-by-group?group=${encodeURIComponent(item.serviceLabel)}&sn=${encodeURIComponent(item.sn)}`
          );
          renderLeafItems(data.items || [], 'Nothing here.');
        });

        sourcePanelItems.appendChild(li);
        return;
      }

      if (item.isLineInLeaf) {
        const icon = document.createElement('span');
        icon.className = 'sourcepanel__icon';
        icon.textContent = '\u{1F50C}';
        li.appendChild(icon);
      } else {
        if (item.serviceLabel || item.groupTitle) {
          // groupTitle is the sid-merged service name ("Pandora") --
          // raw serviceLabel varies per favorite type ("Pandora
          // Playlist") and misses the icon file, falling back to the
          // star. Prefer the merged name so every account's items
          // carry the same service icon.
          li.appendChild(buildImgIconWithFallback(iconFilenameForService(item.groupTitle || item.serviceLabel)));
        }
        const art = document.createElement('div');
        art.className = 'sourcepanel__art';
        if (item.albumArtUrl) {
          art.style.backgroundImage = `url("${item.albumArtUrl}")`;
          art.style.backgroundSize = 'cover';
        }
        li.appendChild(art);
      }

      const labelBlock = document.createElement('div');
      labelBlock.className = 'sourcepanel__labelblock';
      const label = document.createElement('span');
      label.className = 'sourcepanel__label';
      label.textContent = item.title;
      labelBlock.appendChild(label);
      if (item.isLineInLeaf && item.currentName) {
        const sub = document.createElement('span');
        sub.className = 'sourcepanel__servicelabel';
        setLineInLabel(sub, item.currentName);
        labelBlock.appendChild(sub);
      }
      li.appendChild(labelBlock);

      li.addEventListener('click', async () => {
        if (item.isLineInLeaf) {
          // focusedRoom is who starts playing; item.roomName is whose
          // physical line-in input gets relayed -- these can differ
          // (e.g. Storage Room playing what's plugged into Garage).
          await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/play-linein`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceRoom: item.roomName })
          });
          await openSourceGroups();
          setTimeout(refreshNowPlaying, 800);
        } else if (playlistContainerId && item.uri) {
          // A track within a playlist -- build the actual queue from
          // the whole playlist and jump to this track, rather than
          // playing it standalone with no next/previous context
          // (confirmed via real testing: that left Sonos with nothing
          // to skip to at all).
          await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/play-playlist-track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlistId: playlistContainerId, playlistTitle, uri: item.uri })
          });
          await openSourceGroups();
          setTimeout(refreshNowPlaying, 800);
        } else if (item.uri) {
          await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/play-item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri: item.uri, metadata: item.metadata })
          });
          await openSourceGroups();
          setTimeout(refreshNowPlaying, 800);
        } else {
          showPreviewMessage(`"${item.title}" doesn't have a playable link -- check DBG panel for details.`);
        }
      });

      // Sonos Playlists are editable; Imported Playlists (M3U files on
      // the share) are not, so the remove control only appears for SQ:.
      if (playlistContainerId && String(playlistContainerId).startsWith('SQ:')) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'sourcepanel__removebtn';
        removeBtn.textContent = '\u2715';
        removeBtn.setAttribute('aria-label', `Remove ${item.title} from ${playlistTitle}`);
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          removeBtn.textContent = '\u2026';
          await api(`/api/sonos/playlists/${encodeURIComponent(playlistContainerId)}/track/${index}`, { method: 'DELETE' });
          const data = await api(
            `/api/sonos/room/${encodeURIComponent(focusedRoom)}/browse-container?id=${encodeURIComponent(playlistContainerId)}`
          );
          renderLeafItems(data.items || [], 'This playlist is empty.', playlistContainerId, playlistTitle);
        });
        li.appendChild(removeBtn);
      }

      sourcePanelItems.appendChild(li);
    });

    appendPlaylistRenameRow(playlistContainerId, playlistTitle);
    appendPlaylistDeleteRow(playlistContainerId, playlistTitle);
  }

  function appendPlaylistRenameRow(playlistContainerId, playlistTitle) {
    if (!playlistContainerId || !String(playlistContainerId).startsWith('SQ:')) return;
    const li = document.createElement('li');
    li.className = 'sourcepanel__item sourcepanel__deleterow';
    li.textContent = `\u270F\uFE0F  Rename "${playlistTitle}"`;
    li.addEventListener('click', () => {
      // Inline swap: the row becomes an input + Save/Cancel, no overlay.
      li.textContent = '';
      li.classList.add('sourcepanel__renamerow');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = playlistTitle;
      input.className = 'sourcepanel__renameinput';
      const save = document.createElement('button');
      save.className = 'sourcepanel__actionbtn sourcepanel__actionbtn--primary';
      save.textContent = 'Save';
      save.addEventListener('click', async (e) => {
        e.stopPropagation();
        const next = input.value.trim();
        if (!next || next === playlistTitle) return;
        save.textContent = '\u2026';
        await api(`/api/sonos/playlists/${encodeURIComponent(playlistContainerId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: next, currentTitle: playlistTitle })
        });
        await openGroup({ id: 'SQ:', title: 'Playlists', browsable: true, isPlaylistRoot: true });
      });
      const cancel = document.createElement('button');
      cancel.className = 'sourcepanel__actionbtn';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', async (e) => {
        e.stopPropagation();
        const data = await api(
          `/api/sonos/room/${encodeURIComponent(focusedRoom)}/browse-container?id=${encodeURIComponent(playlistContainerId)}`
        );
        renderLeafItems(data.items || [], 'This playlist is empty.', playlistContainerId, playlistTitle);
      });
      li.appendChild(input);
      li.appendChild(save);
      li.appendChild(cancel);
      input.focus();
      input.select();
    });
    sourcePanelItems.appendChild(li);
  }

  function appendPlaylistDeleteRow(playlistContainerId, playlistTitle) {
    if (!playlistContainerId || !String(playlistContainerId).startsWith('SQ:')) return;
    const li = document.createElement('li');
    li.className = 'sourcepanel__item sourcepanel__deleterow';
    li.textContent = `\u{1F5D1}\uFE0F  Delete "${playlistTitle}"`;
    li.addEventListener('click', () => {
      showConfirm(`Delete the playlist "${playlistTitle}"?`, async () => {
        await api(`/api/sonos/playlists/${encodeURIComponent(playlistContainerId)}`, { method: 'DELETE' });
        // Back out to the Playlists list -- what we were looking at no
        // longer exists.
        await openGroup({ id: 'SQ:', title: 'Playlists', browsable: true, isPlaylistRoot: true });
      });
    });
    sourcePanelItems.appendChild(li);
  }

  sourceBackBtn.addEventListener('click', () => {
    const prev = backStack.pop();
    updateBackButtonVisibility();
    if (prev) {
      prev();
    } else {
      openSourceGroups();
    }
  });

  return {
    async init() {
      await refreshRooms();
      await refreshNowPlaying();
      await syncVolumeRailToFocusedRoom();
      await openSourceGroups();
      await refreshSavedGroups();
    },
    async refreshFromSocket(newRooms) {
      const newRoomsJson = JSON.stringify(newRooms);
      const changed = newRoomsJson !== lastRoomsJson;
      lastRoomsJson = newRoomsJson;
      rooms = newRooms;
      if (changed) render();
      await refreshNowPlaying();
      // Keeps the main rail's displayed level fresh if volume changed
      // externally (e.g. from the official Sonos app) or as a side
      // effect of a group-volume adjustment redistributing per-room
      // levels.
      await syncVolumeRailToFocusedRoom();
    },
    // Lightweight signals from the server (see server/sonos.js's
    // AVTransport/GroupRenderingControl event handling) -- these just
    // mean "something changed, go check" rather than carrying the new
    // data themselves, so this just re-runs the same refresh logic
    // already used after a normal user action. No-ops if the change
    // doesn't concern whatever's currently focused.
    async handleNowPlayingChanged(room) {
      if (room === focusedRoom) await refreshNowPlaying();
    },
    async handleGroupVolumeChanged() {
      await syncVolumeRailToFocusedRoom();
    },
    getFocusedRoom() {
      return focusedRoom;
    },
    getNowPlayingSnapshot() {
      return {
        title: lastNowPlayingTrack ? lastNowPlayingTrack.title : '',
        artist: lastNowPlayingTrack ? lastNowPlayingTrack.artist : '',
        albumArtUrl: lastNowPlayingTrack ? lastNowPlayingTrack.albumArtUrl : null,
        playing: !!(lastNowPlayingTrack && lastNowPlayingTrack.playing),
        roomName: focusedRoom
      };
    },
    async setFocusedRoomVolume(v) {
      if (!focusedRoom) return;
      const members = getMembersOf(focusedRoom);
      const endpoint = members.length > 0 ? 'group-volume' : 'volume';
      await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: v })
      });
    },
    async setFocusedRoomMute(muted) {
      if (!focusedRoom) return;
      const members = getMembersOf(focusedRoom);
      const endpoint = members.length > 0 ? 'group-mute' : 'mute';
      await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted })
      });
    }
  };
})();
