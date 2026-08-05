// volumeRail.js
//
// Turns the .volrail__track element into a drag-to-set vertical fader.
// Pointer events (not separate mouse/touch handlers) so this works the
// same with a finger on the Pi panel and a mouse while developing on
// Windows.

const VolumeRail = (() => {
  const track = document.getElementById('volTrack');
  const fill = document.getElementById('volFill');
  const thumb = document.getElementById('volThumb');
  const valueLabel = document.getElementById('volValue');
  const muteBtn = document.getElementById('volMute');

  let value = 50; // 0-100
  let muted = false;
  let dragging = false;
  let onChangeCallback = null; // (value) => void, called on release
  let onMuteCallback = null; // (muted) => void

  function render() {
    const displayValue = muted ? 0 : value;
    fill.style.height = `${displayValue}%`;
    thumb.style.bottom = `${displayValue}%`;
    valueLabel.textContent = muted ? 'MUTE' : String(Math.round(value));
    muteBtn.classList.toggle('is-muted', muted);
  }

  function percentFromPointer(clientY) {
    const rect = track.getBoundingClientRect();
    const ratio = 1 - (clientY - rect.top) / rect.height;
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
  }

  function handlePointerDown(e) {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    if (muted) {
      muted = false;
      if (onMuteCallback) onMuteCallback(false);
    }
    value = percentFromPointer(e.clientY);
    render();
  }

  function handlePointerMove(e) {
    if (!dragging) return;
    value = percentFromPointer(e.clientY);
    render();
  }

  function handlePointerUp(e) {
    if (!dragging) return;
    dragging = false;
    track.releasePointerCapture(e.pointerId);
    if (onChangeCallback) onChangeCallback(value);
  }

  track.addEventListener('pointerdown', handlePointerDown);
  track.addEventListener('pointermove', handlePointerMove);
  track.addEventListener('pointerup', handlePointerUp);
  track.addEventListener('pointercancel', handlePointerUp);

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    render();
    if (onMuteCallback) onMuteCallback(muted);
  });

  return {
    // Set displayed value WITHOUT firing onChange (e.g. syncing from server)
    setValue(v) {
      if (dragging) return; // don't fight the user's finger
      value = Math.max(0, Math.min(100, v));
      render();
    },
    setMuted(m) {
      muted = m;
      render();
    },
    getValue() {
      return value;
    },
    onChange(cb) {
      onChangeCallback = cb;
    },
    onMute(cb) {
      onMuteCallback = cb;
    }
  };
})();
