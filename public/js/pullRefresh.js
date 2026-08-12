// pullRefresh.js
//
// Pull-down-to-refresh for kiosk browsers with no visible chrome
// (v0.15.0). Deliberately arms ONLY when the touch starts in the top
// strip of the screen (the tab-bar zone) so it can never fight the
// scrolling room/source/queue lists below; drag down past the
// threshold and the page reloads. Touch-only by design -- desktop
// browsers have F5.
(() => {
  const el = document.getElementById('pullRefresh');
  const ARM_ZONE_PX = 56;
  const THRESHOLD_PX = 90;
  let armed = false;
  let startY = null;
  let pulled = 0;

  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t && t.clientY <= ARM_ZONE_PX) {
      armed = true;
      startY = t.clientY;
      pulled = 0;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!armed || !e.touches[0]) return;
    pulled = Math.max(0, e.touches[0].clientY - startY);
    if (el && pulled > 8) {
      el.style.display = 'flex';
      el.style.transform = `translateX(-50%) translateY(${Math.min(pulled * 0.5, 72)}px)`;
      el.classList.toggle('is-ready', pulled >= THRESHOLD_PX);
    }
  }, { passive: true });

  function finish() {
    if (!armed) return;
    if (pulled >= THRESHOLD_PX) {
      if (el) el.classList.add('is-loading');
      window.location.reload();
    } else if (el) {
      el.style.display = 'none';
      el.style.transform = '';
      el.classList.remove('is-ready');
    }
    armed = false;
    startY = null;
    pulled = 0;
  }
  document.addEventListener('touchend', finish);
  document.addEventListener('touchcancel', finish);
})();
