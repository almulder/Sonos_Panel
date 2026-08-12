// passcodeLock.js
//
// PIN protection for structural actions (v0.14.0): deleting/renaming
// playlists and account names, adding tracks to playlists, and any
// group add/edit/apply. Queue and playback stay open -- guests can
// play music, not rearrange the furniture.
//
// The code itself lives ONLY in the container's PASSCODE variable;
// the client submits attempts to /api/panel/verify-passcode and never
// sees the code. Auto-submits at the 4th digit (no Enter), with Clear
// and backspace keys so the OS keyboard never needs to appear. After a
// correct entry the panel stays unlocked while it's being touched;
// 60 seconds without any interaction locks it back down.

const PasscodeLock = (() => {
  const overlay = document.getElementById('pinpad');
  const dotsEl = document.getElementById('pinpadDots');
  const msgEl = document.getElementById('pinpadMsg');
  const keysEl = document.getElementById('pinpadKeys');
  const closeBtn = document.getElementById('pinpadClose');

  let enabled = false;
  let unlocked = false;
  let lastActivity = Date.now();
  let pending = null;
  let entry = '';
  let verifying = false;

  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => { enabled = !!cfg.passcodeEnabled; })
    .catch(() => {});

  function bump() { lastActivity = Date.now(); }
  document.addEventListener('pointerdown', bump, true);
  document.addEventListener('keydown', bump, true);
  setInterval(() => {
    if (unlocked && Date.now() - lastActivity > 60000) unlocked = false;
  }, 5000);

  function renderDots() {
    [...dotsEl.children].forEach((dot, i) => {
      dot.classList.toggle('is-filled', i < entry.length);
    });
  }

  function open() {
    entry = '';
    msgEl.textContent = 'Enter passcode';
    msgEl.classList.remove('is-error');
    renderDots();
    overlay.style.display = 'flex';
  }

  function close() {
    overlay.style.display = 'none';
    pending = null;
    entry = '';
  }

  async function submit() {
    if (verifying) return;
    verifying = true;
    msgEl.textContent = '\u2026';
    try {
      const res = await fetch('/api/panel/verify-passcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: entry })
      });
      const data = await res.json();
      if (data.ok) {
        unlocked = true;
        bump();
        const fn = pending;
        close();
        if (fn) fn();
      } else {
        entry = '';
        renderDots();
        msgEl.textContent = 'Wrong code \u2014 try again';
        msgEl.classList.add('is-error');
      }
    } catch (err) {
      entry = '';
      renderDots();
      msgEl.textContent = 'Could not verify \u2014 try again';
      msgEl.classList.add('is-error');
    }
    verifying = false;
  }

  function press(key) {
    msgEl.classList.remove('is-error');
    if (key === 'clear') {
      entry = '';
    } else if (key === 'del') {
      entry = entry.slice(0, -1);
    } else if (/^[0-9]$/.test(key) && entry.length < 4) {
      entry += key;
    }
    renderDots();
    if (entry.length === 4) submit();
    else if (msgEl.textContent !== 'Enter passcode') msgEl.textContent = 'Enter passcode';
  }

  // Keypad: 1-9, then Clear / 0 / backspace.
  ['1','2','3','4','5','6','7','8','9','clear','0','del'].forEach((key) => {
    const btn = document.createElement('button');
    btn.className = 'pinpad__key' + (key === 'clear' || key === 'del' ? ' pinpad__key--fn' : '');
    btn.textContent = key === 'clear' ? 'Clear' : (key === 'del' ? '\u232B' : key);
    btn.addEventListener('click', () => press(key));
    keysEl.appendChild(btn);
  });

  if (closeBtn) closeBtn.addEventListener('click', close);
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // The one entry point: PasscodeLock.require(() => doProtectedThing())
  function requireUnlock(fn) {
    if (!enabled || unlocked) {
      bump();
      fn();
      return;
    }
    pending = fn;
    open();
  }

  return { require: requireUnlock };
})();

window.PasscodeLock = PasscodeLock;
