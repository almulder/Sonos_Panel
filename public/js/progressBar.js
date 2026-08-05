// progressBar.js
//
// Small factory used by the Sonos now-playing view to render a
// progress bar (elapsed time / track / remaining time), ticking locally
// between server polls so it doesn't visibly jump every 2 seconds.

function createProgressBar({ elapsedEl, remainingEl, fillEl }) {
  let position = 0;
  let duration = 0;
  let playing = false;
  let tickTimer = null;

  function formatTime(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function render() {
    elapsedEl.textContent = formatTime(position);
    remainingEl.textContent = duration > 0 ? `-${formatTime(duration - position)}` : '-0:00';
    const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
    fillEl.style.width = `${pct}%`;
  }

  function startTicking() {
    stopTicking();
    tickTimer = setInterval(() => {
      if (playing && duration > 0 && position < duration) {
        position += 1;
        render();
      }
    }, 1000);
  }

  function stopTicking() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  return {
    // Called whenever fresh data arrives from the server -- resyncs the
    // displayed position so local ticking doesn't drift.
    update(newPosition, newDuration, newPlaying) {
      position = newPosition || 0;
      duration = newDuration || 0;
      playing = !!newPlaying;
      render();
      if (playing) startTicking();
      else stopTicking();
    }
  };
}
