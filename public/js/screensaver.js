// screensaver.js
//
// Activates after a period of no touch/click interaction anywhere on
// the page. Reads current state directly from SonosView (which is
// already tracking it from the regular polling) rather than polling
// independently -- this module just decides what to show and animates
// it.
//
// Content modes:
//   - "bounce": something's actually playing -- DVD-logo-style
//     bouncing album art/title/artist.
//   - "rings": nothing playing -- a calmer ambient rings animation
//     instead of a static screen.

const Screensaver = (() => {
  // Overridden by whatever's passed into init() (from SCREENSAVER_TIMEOUT_SECONDS
  // via config.js) -- this is only the fallback if init() is called with
  // nothing.
  let INACTIVITY_MS = 600 * 1000;
  const CONTENT_REFRESH_MS = 1000;

  const overlay = document.getElementById('screensaverOverlay');
  const bounceEl = document.getElementById('screensaverBounce');
  const artEl = document.getElementById('screensaverArt');
  const titleEl = document.getElementById('screensaverTitle');
  const artistEl = document.getElementById('screensaverArtist');
  const ringsLabelEl = document.getElementById('screensaverRingsLabel');

  let inactivityTimer = null;
  let active = false;
  let rafId = null;
  let contentInterval = null;

  // Bounce physics state (position + velocity, in px/frame).
  let x = 40;
  let y = 40;
  let vx = 1.3;
  let vy = 1.05;

  // Figures out what should currently be shown: bouncing album
  // art/title/artist if something's playing, or the calm rings
  // animation if nothing is.
  function computeDesiredContent() {
    const snap = SonosView.getNowPlayingSnapshot();
    if (snap.playing && snap.title) {
      return { mode: 'bounce', title: snap.title, artist: snap.artist, art: snap.albumArtUrl };
    }
    return { mode: 'rings', label: '' };
  }

  function applyContent() {
    const content = computeDesiredContent();

    if (content.mode === 'bounce') {
      overlay.classList.add('is-bouncing');
      overlay.classList.remove('is-rings');
      titleEl.textContent = content.title || '';
      artistEl.textContent = content.artist || '';
      if (content.art) {
        artEl.style.backgroundImage = `url(${content.art})`;
        artEl.style.display = '';
      } else {
        artEl.style.backgroundImage = '';
        artEl.style.display = 'none';
      }
    } else {
      overlay.classList.add('is-rings');
      overlay.classList.remove('is-bouncing');
      ringsLabelEl.textContent = content.label || '';
    }
  }

  function bounceTick() {
    if (!active) return;

    const rect = bounceEl.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);

    x += vx;
    y += vy;

    if (x <= 0 || x >= maxX) {
      vx = -vx;
      x = Math.max(0, Math.min(x, maxX));
    }
    if (y <= 0 || y >= maxY) {
      vy = -vy;
      y = Math.max(0, Math.min(y, maxY));
    }

    bounceEl.style.left = `${x}px`;
    bounceEl.style.top = `${y}px`;

    rafId = requestAnimationFrame(bounceTick);
  }

  function activate() {
    if (active) return;
    active = true;
    applyContent();
    overlay.classList.add('is-active');

    const startMaxX = Math.max(0, window.innerWidth - 320);
    const startMaxY = Math.max(0, window.innerHeight - 200);
    x = Math.random() * startMaxX;
    y = Math.random() * startMaxY;

    rafId = requestAnimationFrame(bounceTick);
    // Keeps track/artist current while showing, and lets it switch
    // between bounce/rings if playback starts or stops mid-screensaver.
    contentInterval = setInterval(applyContent, CONTENT_REFRESH_MS);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    overlay.classList.remove('is-active', 'is-bouncing', 'is-rings');
    if (rafId) cancelAnimationFrame(rafId);
    if (contentInterval) clearInterval(contentInterval);
  }

  function resetTimer() {
    if (active) deactivate();
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(activate, INACTIVITY_MS);
  }

  ['touchstart', 'mousedown', 'click'].forEach((evt) => {
    document.addEventListener(evt, resetTimer, { passive: true });
  });

  return {
    init(timeoutMs) {
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        INACTIVITY_MS = timeoutMs;
      }
      resetTimer();
    }
  };
})();
