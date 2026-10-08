// app.js
//
// Top-level glue: opens the WebSocket for live updates, routes the
// persistent volume rail to the currently focused Sonos room, and
// handles the now-playing fullscreen toggle.

(function () {
  // ---------------- Fullscreen now-playing ----------------
  // Hides the room list / chrome and enlarges the now-playing view.
  // Tapping anywhere on the enlarged card's background (not on the
  // transport buttons) exits back to the normal layout -- there was
  // previously no way back out once fullscreen was entered.

  const sonosFullscreenBtn = document.getElementById('sonosFullscreenBtn');
  const sonosSonostop = document.getElementById('sonosSonostop');
  const appEl = document.querySelector('.app');

  function enterFullscreen() {
    appEl.classList.add('is-fullscreen');
    sonosSonostop.classList.add('sonostop--stage');
  }
  function exitFullscreen() {
    appEl.classList.remove('is-fullscreen');
    sonosSonostop.classList.remove('sonostop--stage');
  }

  sonosFullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    enterFullscreen();
  });

  // Any tap inside the stage while fullscreen is active exits, unless
  // it landed on an actual control (transport buttons) -- those need to
  // keep working normally without also kicking you out of fullscreen.
  sonosSonostop.addEventListener('click', (e) => {
    if (!appEl.classList.contains('is-fullscreen')) return;
    if (e.target.closest('.transport__btn')) return;
    exitFullscreen();
  });

  // ---------------- Volume rail routing ----------------
  // SonosView already syncs the rail whenever a room is focused, so
  // nothing extra is needed here beyond wiring the rail's own
  // change/mute events through to it.

  VolumeRail.onDragStart(() => {
    // Lock in group member volume ratios before the drag's stream of
    // SetGroupVolume calls -- balance survives a trip to zero. Server
    // no-ops harmlessly for ungrouped rooms.
    const room = SonosView.getFocusedRoom && SonosView.getFocusedRoom();
    if (!room) return;
    fetch(`/api/sonos/room/${encodeURIComponent(room)}/group-volume/snapshot`, { method: 'POST' })
      .catch(() => {});
  });
  VolumeRail.onChange(async (value) => {
    await SonosView.setFocusedRoomVolume(value);
  });

  VolumeRail.onMute(async (muted) => {
    await SonosView.setFocusedRoomMute(muted);
  });

  // ---------------- New-version banner ----------------
  // The server reports its version each time a screen (re)connects. A
  // container update drops every socket, so an already-open screen sees
  // the new number on reconnect and offers a reload. Never reloads by
  // itself -- that could wipe what someone is in the middle of.
  let firstSeenVersion = null;

  function showUpdateBanner(version) {
    if (document.getElementById('updateBanner')) return;
    const bar = document.createElement('button');
    bar.id = 'updateBanner';
    bar.className = 'update-banner';
    bar.type = 'button';
    bar.textContent = `A new version (v${version}) is available \u2014 tap to reload`;
    bar.addEventListener('click', async () => {
      bar.textContent = 'Reloading\u2026';
      // Same effect as Shift+F5: re-download every file the page uses
      // (bypassing the browser cache), then reload.
      try {
        const urls = [window.location.href, ...[...document.querySelectorAll('script[src], link[href]')]
          .map((el) => el.src || el.href)];
        await Promise.all(urls.map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
      } catch (err) { /* reload anyway */ }
      window.location.reload();
    });
    document.body.appendChild(bar);
  }

  function handleHelloVersion(version) {
    if (!version) return;
    if (firstSeenVersion === null) firstSeenVersion = version;
    else if (version !== firstSeenVersion) showUpdateBanner(version);
  }

  // ---------------- WebSocket live updates ----------------

  function connectSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);

    ws.addEventListener('close', () => {
      setTimeout(connectSocket, 2000);
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'hello') {
        handleHelloVersion(msg.version);
      } else if (msg.type === 'sonos:rooms') {
        SonosView.refreshFromSocket(msg.rooms);
      } else if (msg.type === 'sonos:nowplaying-changed') {
        SonosView.handleNowPlayingChanged(msg.room);
        if (window.QueuePanel) window.QueuePanel.handleNowPlayingChanged(msg.room);
      } else if (msg.type === 'sonos:sources-inuse') {
        SonosView.handleSourcesInUse(msg.items);
      } else if (msg.type === 'sonos:groupvolume-changed') {
        SonosView.handleGroupVolumeChanged();
      } else if (msg.type === 'queue:changed') {
        if (window.QueuePanel) window.QueuePanel.handleQueueChanged(msg.room);
      }
    });
  }

  // ---------------- Boot ----------------

  async function init() {
    const config = await AppConfig.load();
    Theme.apply(config.color);
    Tabs.init(config.tabs, config.color);

    await SonosView.init();
    connectSocket();
    Screensaver.init(config.screensaverTimeoutMs);
  }

  init();
})();
