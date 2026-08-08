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

function iconFilenameForService(serviceLabel) {
  return SERVICE_ICON_FILES[serviceLabel] || 'default';
}

function buildSourceIcon(group) {
  if (group.isLineInRoot) {
    return buildImgIconWithFallback('source-linein');
  }
  if (group.isPlaylistRoot) {
    return buildImgIconWithFallback('source-playlist');
  }
  return buildImgIconWithFallback(iconFilenameForService(group.title));
}

const SonosView = (() => {
  const roomListEl = document.getElementById('roomList');
  const roomlistPanel = document.getElementById('sonosRoomlist');
  const titleEl = document.getElementById('sonosTitle');
  const artistEl = document.getElementById('sonosArtist');
  const groupLabelEl = document.getElementById('sonosGroupLabel');
  const sourceLineEl = document.getElementById('sonosSourceLine');
  const artEl = document.getElementById('sonosArt');
  const playPauseBtn = document.getElementById('sonosPlayPause');
  const prevBtn = document.getElementById('sonosPrev');
  const nextBtn = document.getElementById('sonosNext');
  const shuffleBtn = document.getElementById('sonosShuffleBtn');
  const crossfadeBtn = document.getElementById('sonosCrossfadeBtn');
  const sleepTimerBtn = document.getElementById('sonosSleepTimerBtn');
  const sleepTimerBadge = document.getElementById('sonosSleepTimerBadge');
  const sleepTimerMenu = document.getElementById('sonosSleepTimerMenu');

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
  let pendingGroupSelection = new Set(); // top-level rooms checked, building toward a new/merged group
  let expandedCoordinators = new Set(); // coordinators currently showing their members
  let currentlyPlaying = false;
  let sliderDragActive = false; // guards against a poll-triggered re-render wiping an in-progress volume drag

  async function api(path, options) {
    const res = await fetch(path, options);
    return res.json();
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

    // Size the name column to the widest room name actually present,
    // instead of letting it flex-stretch to fill all remaining width
    // (which was pushing the volume control all the way to the row's
    // far edge, with a large empty gap in between on wide screens).
    const widest = rooms.reduce((max, r) => Math.max(max, measureTextWidth(r.name, '16px Inter, system-ui, sans-serif')), 0);
    roomListEl.style.setProperty('--name-col-width', `${Math.ceil(widest) + 28}px`);

    roomListEl.innerHTML = '';
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

    // Only the focused room shows this -- with a group expanded, whichever
    // specific room (coordinator or member) is actually focused gets it,
    // not always the coordinator, so there's never more than one visible
    // at once.
    if (room.name === focusedRoom) {
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

    const checkbox = document.createElement('button');
    checkbox.className = 'roomrow__checkbox';
    checkbox.classList.toggle('is-checked', pendingGroupSelection.has(room.name));
    checkbox.setAttribute('aria-label', `Group ${room.name}`);
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGroupSelection(room.name);
    });
    li.appendChild(checkbox);

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
    name.textContent = room.name;
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
      sub.textContent = `with ${members.map((m) => m.name).join(', ')}`;
      main.appendChild(sub);
    }

    li.appendChild(main);
    li.appendChild(buildVolumeControl(room));
    return li;
  }

  function buildMemberRow(room) {
    const li = document.createElement('li');
    li.className = 'roomrow roomrow--member';

    const checkbox = document.createElement('button');
    checkbox.className = 'roomrow__checkbox is-checked';
    checkbox.setAttribute('aria-label', `Remove ${room.name} from group`);
    checkbox.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/sonos/room/${encodeURIComponent(room.name)}/ungroup`, { method: 'POST' });
      // Deliberately not calling refreshRooms() here -- that makes a
      // fresh live REST call straight to a Sonos device for current
      // topology, which can race against Sonos's own join/leave
      // settling time and come back reporting the OLD topology even
      // though our server (and the websocket broadcast that already
      // arrived) already has the correct, current picture. Just
      // re-render with whatever `rooms` already holds.
      render();
    });
    li.appendChild(checkbox);

    const main = document.createElement('div');
    main.className = 'roomrow__main roomrow__main--member';
    if (room.muted) {
      const muteIcon = document.createElement('span');
      muteIcon.className = 'roomrow__mute-icon';
      muteIcon.textContent = '\u{1F507}';
      muteIcon.setAttribute('aria-label', 'Muted');
      main.appendChild(muteIcon);
    }
    const name = document.createElement('span');
    name.className = 'roomrow__name';
    name.textContent = room.name;
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

  // Picks which selected room should become/stay the group coordinator.
  // Prefers a room that's ALREADY a coordinator with members (so merging
  // a standalone room into an existing group doesn't accidentally move
  // or dissolve that group), and among multiple existing groups, the one
  // with more members. Falls back to selection order when combining
  // standalone rooms only.
  function chooseGroupAnchor(selectedNames) {
    let best = null;
    let bestMemberCount = -1;
    selectedNames.forEach((n) => {
      const memberCount = getMembersOf(n).length;
      if (memberCount > bestMemberCount) {
        best = n;
        bestMemberCount = memberCount;
      }
    });
    return best || selectedNames[0];
  }

  async function toggleGroupSelection(roomName) {
    if (pendingGroupSelection.has(roomName)) {
      pendingGroupSelection.delete(roomName);
      render();
      return;
    }
    pendingGroupSelection.add(roomName);
    if (pendingGroupSelection.size >= 2) {
      const selected = Array.from(pendingGroupSelection);
      const anchor = chooseGroupAnchor(selected);
      const ordered = [anchor, ...selected.filter((n) => n !== anchor)];
      await api('/api/sonos/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rooms: ordered })
      });
      pendingGroupSelection.clear();
      expandedCoordinators.add(anchor);
      // Deliberately not calling refreshRooms() here -- see the same
      // reasoning in buildMemberRow's ungroup handler. The websocket
      // broadcast that fires right after the join (see the optimistic
      // patch server-side) already updates the shared `rooms` here,
      // so just re-render with that rather than racing a fresh live
      // topology fetch against Sonos's own settling time.
      render();
    } else {
      render();
    }
  }

  async function selectFocusedRoom(roomName) {
    focusedRoom = roomName;
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
    }
    render();
  }

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
    groupLabelEl.textContent = focusedRoom.toUpperCase() + (members.length > 0 ? ` +${members.length}` : '');
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
      artEl.style.backgroundImage = `url(${track.albumArtUrl})`;
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

    const crossfadeOn = !!(track && track.crossfadeOn);
    crossfadeBtn.classList.toggle('is-active', crossfadeOn);
    crossfadeBtn.setAttribute('aria-pressed', String(crossfadeOn));
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
    if (currentlyPlaying) {
      await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/pause`, { method: 'POST' });
    } else {
      await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/play`, { method: 'POST' });
    }
    await refreshNowPlaying();
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
      sleepTimerMenu.style.display = 'none';
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
        sleepTimerMenu.style.display = 'none';
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
    sleepTimerMenu.style.display = sleepTimerMenu.style.display === 'none' ? '' : 'none';
  });
  document.addEventListener('click', (e) => {
    if (!sleepTimerMenu.contains(e.target) && e.target !== sleepTimerBtn) {
      sleepTimerMenu.style.display = 'none';
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
    if (!focusedRoom) return;
    currentGroup = null;
    backStack = [];
    updateBackButtonVisibility();
    sourcePanelTitle.textContent = 'SELECT A MUSIC SOURCE';
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
    backStack = [() => openSourceGroups()];
    updateBackButtonVisibility();

    if (group.isLineInRoot) {
      currentGroup = 'Line-In';
      sourcePanelTitle.textContent = 'LINE-IN';
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

    if (group.isPlaylistRoot) {
      currentGroup = 'Playlists';
      sourcePanelTitle.textContent = 'PLAYLISTS';
      sourcePanelItems.innerHTML = '<li class="sourcepanel__loading">Loading\u2026</li>';
      const data = await api(`/api/sonos/room/${encodeURIComponent(focusedRoom)}/playlists`);
      renderPlaylistItems(data.items || [], 'No playlists found.');
      return;
    }

    currentGroup = group.title;
    sourcePanelTitle.textContent = group.title.toUpperCase();
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
      headerLabel.textContent = serviceLabel.toUpperCase();
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
          sourcePanelTitle.textContent = item.title.toUpperCase();
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
      label.textContent = group.title;
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

  function renderLeafItems(items, emptyMessage, playlistContainerId, playlistTitle) {
    sourcePanelItems.innerHTML = '';
    if (items.length === 0) {
      sourcePanelItems.innerHTML = `<li class="sourcepanel__loading">${emptyMessage}</li>`;
      return;
    }
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'sourcepanel__item';

      if (item.isLineInLeaf) {
        const icon = document.createElement('span');
        icon.className = 'sourcepanel__icon';
        icon.textContent = '\u{1F50C}';
        li.appendChild(icon);
      } else {
        if (item.serviceLabel) {
          li.appendChild(buildImgIconWithFallback(iconFilenameForService(item.serviceLabel)));
        }
        const art = document.createElement('div');
        art.className = 'sourcepanel__art';
        if (item.albumArtUrl) {
          art.style.backgroundImage = `url(${item.albumArtUrl})`;
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

      sourcePanelItems.appendChild(li);
    });
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
