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

  VolumeRail.onChange(async (value) => {
    await SonosView.setFocusedRoomVolume(value);
  });

  VolumeRail.onMute(async (muted) => {
    await SonosView.setFocusedRoomMute(muted);
  });

  // ---------------- WebSocket live updates ----------------

  function connectSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);

    ws.addEventListener('close', () => {
      setTimeout(connectSocket, 2000);
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'sonos:rooms') {
        SonosView.refreshFromSocket(msg.rooms);
      }
    });
  }

  // ---------------- Boot ----------------

  async function init() {
    const config = await AppConfig.load();
    Theme.apply(config.color);
    Tabs.init(config.tabs);

    await SonosView.init();
    connectSocket();
    Screensaver.init(config.screensaverTimeoutMs);
  }

  init();
})();
