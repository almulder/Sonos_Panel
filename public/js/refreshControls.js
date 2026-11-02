// refreshControls.js
//
// The two refresh buttons: one on the room list's "Groups" row (re-check
// which speakers are in the household) and one beside the Sources/Queue
// tabs (re-read Sonos Favorites and Playlists, and rescan the Local
// Library if one is mounted). Both work without restarting the container.
//
// While a refresh runs, its section gets an overlay so it can't be
// started twice or used half-updated; when it's done a popup in the
// middle of the screen says what changed. A library rescan can take a
// few minutes on a big collection, so its progress is shown in the
// overlay (polled from /api/local/status -- simpler and sturdier than
// following the websocket, which may reconnect mid-scan).

const RefreshControls = (() => {
  const SCAN_POLL_MS = 2000;
  const DONE_POPUP_MS = 7000;
  const REQUEST_TIMEOUT_MS = 60 * 1000;
  // Past this the overlay comes down and the scan just carries on in the
  // background (a big library on a slow share can take this long).
  const SCAN_WAIT_MAX_MS = 20 * 60 * 1000;
  // A scan we asked for that hasn't shown any sign of running by now isn't
  // going to.
  const SCAN_START_WAIT_MS = 30 * 1000;

  let speakersBusy = false;
  let sourcesBusy = false;
  let onSpeakersDone = null;
  let onSourcesDone = null;

  // A request that never answers mustn't leave a panel covered for good.
  async function postJson(url) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetch(url, { method: 'POST', signal: ctl ? ctl.signal : undefined });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'The server took too long to answer' : err.message);
    } finally {
      clearTimeout(timer);
    }
    let body = {};
    try { body = await res.json(); } catch (err) { /* empty body */ }
    return { status: res.status, body };
  }

  // ---------------- Overlays ----------------

  function showOverlay(sectionEl, text) {
    let overlay = sectionEl.querySelector('.refreshoverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'refreshoverlay';
      overlay.innerHTML = '<div class="refreshoverlay__spinner"></div><p class="refreshoverlay__text"></p>';
      // Swallow taps so nothing underneath runs mid-refresh.
      overlay.addEventListener('click', (e) => e.stopPropagation());
      sectionEl.appendChild(overlay);
    }
    overlay.querySelector('.refreshoverlay__text').textContent = text;
  }

  function hideOverlay(sectionEl) {
    const overlay = sectionEl.querySelector('.refreshoverlay');
    if (overlay) overlay.remove();
  }

  let popupTimer = null;
  function showDonePopup(title, lines) {
    let popup = document.getElementById('refreshDone');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'refreshDone';
      popup.className = 'refreshdone';
      popup.innerHTML = '<div class="refreshdone__sheet"><p class="refreshdone__title"></p><ul class="refreshdone__lines"></ul></div>';
      popup.addEventListener('click', () => { popup.style.display = 'none'; });
      document.body.appendChild(popup);
    }
    popup.querySelector('.refreshdone__title').textContent = title;
    const list = popup.querySelector('.refreshdone__lines');
    list.innerHTML = '';
    lines.forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    });
    popup.style.display = '';
    clearTimeout(popupTimer);
    popupTimer = setTimeout(() => { popup.style.display = 'none'; }, DONE_POPUP_MS);
  }

  // ---------------- Speakers ----------------

  async function refreshSpeakers() {
    if (speakersBusy) return;
    speakersBusy = true;
    const section = document.getElementById('sonosRoomlist');
    showOverlay(section, 'Checking speakers…');
    const lines = [];
    let title = 'Refresh done';
    try {
      const { status, body } = await postJson('/api/sonos/rescan-speakers');
      if (status !== 200 || !body.ok) {
        title = 'Speaker check failed';
        lines.push(body.error || `The server answered ${status}`);
      } else {
        if (body.leftDemo) lines.push(`Found ${body.total} speaker${plural(body.total)} (the panel had started without any)`);
        else lines.push(`${body.total} speaker${plural(body.total)} in the system`);
        if (!body.leftDemo && body.added.length) lines.push(`New: ${body.added.join(', ')}`);
        const notResponding = body.notResponding || [];
        if (notResponding.length) lines.push(`Not responding: ${notResponding.join(', ')} (refresh again to remove ${notResponding.length === 1 ? 'it' : 'them'} if gone for good)`);
        if (body.removed.length) lines.push(`Removed: ${body.removed.join(', ')}`);
        if (!body.leftDemo && !body.added.length && !body.removed.length && !notResponding.length) lines.push('No speakers added or removed');
      }
      // Coming off demo data, every room on screen (and the focused one)
      // is fake: start the page over rather than patch it, and show the
      // result once it's back.
      if (body.leftDemo) {
        try { sessionStorage.setItem('refreshDone', JSON.stringify({ title, lines })); } catch (err) { /* private mode */ }
        window.location.reload();
        return;
      }
      if (body.rooms && onSpeakersDone) await onSpeakersDone(body.rooms);
    } catch (err) {
      title = 'Speaker check failed';
      lines.push(err.message);
    } finally {
      hideOverlay(section);
      speakersBusy = false;
    }
    showDonePopup(title, lines);
  }

  // ---------------- Music sources ----------------

  async function refreshSources() {
    if (sourcesBusy) return;
    sourcesBusy = true;
    const section = document.getElementById('sourcePanel');
    showOverlay(section, 'Refreshing Favorites and Playlists…');
    const lines = [];
    let failed = false;
    try {
      const [sonosResult, libraryResult] = await Promise.all([
        postJson('/api/sonos/refresh-sources'),
        rescanLibrary((text) => showOverlay(section, text))
      ]);
      if (sonosResult.status === 200) {
        lines.push(describeList('Favorites', sonosResult.body.favorites));
        lines.push(describeList('Playlists', sonosResult.body.playlists));
      } else {
        failed = true;
        lines.push(`Favorites and Playlists: failed (${sonosResult.body.error || sonosResult.status})`);
      }
      if (libraryResult) {
        if (libraryResult.error) failed = true;
        lines.push(libraryResult.line);
      }
      if (onSourcesDone) await onSourcesDone();
    } catch (err) {
      failed = true;
      lines.push(err.message);
    } finally {
      hideOverlay(section);
      sourcesBusy = false;
    }
    showDonePopup(failed ? 'Refresh finished with problems' : 'Refresh done', lines);
  }

  function describeList(label, d) {
    if (!d) return `${label}: --`;
    if (d.added === null) return `${label}: ${d.total}`;
    if (!d.added && !d.removed) return `${label}: no changes (${d.total})`;
    const parts = [];
    if (d.added) parts.push(`${d.added} added`);
    if (d.removed) parts.push(`${d.removed} removed`);
    return `${label}: ${parts.join(', ')} (${d.total} now)`;
  }

  // Resolves null when there's no Local Library, otherwise { line, error? }
  // once the scan (ours, or one already running) has finished.
  async function rescanLibrary(onProgress) {
    let status;
    try {
      status = await (await fetch('/api/local/status')).json();
    } catch (err) {
      return null;
    }
    if (!status.enabled || !status.scanner || !status.scanner.available) return null;
    const previousFinish = status.scanner.lastScan ? status.scanner.lastScan.finishedAt : null;
    const start = await postJson('/api/local/rescan');
    if (start.status !== 200 && start.status !== 409) {
      return { line: `Local Library: could not start a scan (${start.body.error || start.status})`, error: true };
    }
    const startedWaiting = Date.now();
    let sawRunning = start.status === 409;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_MS));
      if (Date.now() - startedWaiting > SCAN_WAIT_MAX_MS) {
        return { line: 'Local Library: still scanning -- it carries on in the background' };
      }
      let s;
      try {
        s = (await (await fetch('/api/local/status')).json()).scanner;
      } catch (err) {
        continue; // server restarting or a blip -- keep waiting (bounded above)
      }
      if (!s || !s.available) return { line: 'Local Library: the library index is not available', error: true };
      if (s.state !== 'idle') sawRunning = true;
      if (s.state === 'idle') {
        const last = s.lastScan;
        const finishedNew = last && last.finishedAt !== previousFinish;
        if (!finishedNew) {
          // Starting a scan clears lastError, so after our 200 any error is
          // this scan's -- even one that failed before the first poll.
          if ((sawRunning || start.status === 200) && s.lastError) return { line: `Local Library: scan failed (${s.lastError})`, error: true };
          if (!sawRunning && Date.now() - startedWaiting > SCAN_START_WAIT_MS) {
            return { line: 'Local Library: the scan did not start', error: true };
          }
          continue;
        }
        const total = last.totalTracksInLibrary.toLocaleString();
        if (!last.tracksAdded && !last.tracksRemoved) return { line: `Local Library: no changes (${total} tracks)` };
        const parts = [];
        if (last.tracksAdded) parts.push(`${last.tracksAdded.toLocaleString()} added`);
        if (last.tracksRemoved) parts.push(`${last.tracksRemoved.toLocaleString()} removed`);
        return { line: `Local Library: ${parts.join(', ')} (${total} tracks)` };
      }
      if (s.state === 'enumerating') onProgress('Looking for music files…');
      else if (s.total) onProgress(`Checking music files… ${Math.round((s.processed / s.total) * 100)}%`);
    }
  }

  function plural(n) {
    return n === 1 ? '' : 's';
  }

  // ---------------- Buttons ----------------

  function makeButton(label, onClick) {
    const btn = document.createElement('button');
    btn.className = 'refreshbtn';
    btn.setAttribute('aria-label', label);
    btn.textContent = '↻';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  return {
    init(options) {
      onSpeakersDone = options.onSpeakersDone || null;
      onSourcesDone = options.onSourcesDone || null;
      const tabs = document.querySelector('.sourcepanel__tabs');
      if (tabs) tabs.appendChild(makeButton('Refresh music sources', refreshSources));
      let pending = null;
      try {
        pending = JSON.parse(sessionStorage.getItem('refreshDone') || 'null');
        sessionStorage.removeItem('refreshDone');
      } catch (err) { /* private mode or bad JSON */ }
      if (pending) showDonePopup(pending.title, pending.lines);
    },
    // The Groups row is rebuilt on every room-list render, so it asks for
    // a fresh button each time.
    makeSpeakerButton: () => makeButton('Refresh speakers', refreshSpeakers)
  };
})();
