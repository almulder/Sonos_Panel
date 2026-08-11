// queuePanel.js
//
// The "Up Next" queue panel (v0.7.0) plus the Play Now / Play Next /
// Add to Queue action sheet used by browse rows. Kept as its own module
// (same pattern as volumeRail/progressBar) so sonosView stays focused
// on sources/now-playing; sonosView opens this via window.QueuePanel.
//
// Everything talks to the /api/sonos/room/:room/queue* endpoints, which
// resolve the room's GROUP COORDINATOR server-side -- so opening the
// queue for a grouped member shows the group's real queue.

const QueuePanel = (() => {
  // v0.7.1: the queue lives INSIDE the source panel as a sibling tab
  // (SOURCES | QUEUE) instead of a full-screen modal -- it no longer
  // covers now-playing, it follows the focused room, and the corner
  // buttons stay uncluttered. Switching tabs preserves whatever browse
  // state the sources list was showing (it's hidden, not reset).
  const sourcePanelEl = document.getElementById('sourcePanel');
  const tabSources = document.getElementById('srcTabSources');
  const tabQueue = document.getElementById('srcTabQueue');
  const panel = document.getElementById('queueView');
  const titleEl = document.getElementById('queuePanelTitle');
  const itemsEl = document.getElementById('queuePanelItems');
  const saveBtn = document.getElementById('queueSaveBtn');
  const clearBtn = document.getElementById('queueClearBtn');
  const actions = document.getElementById('queueActions');
  const actionsLabel = document.getElementById('queueActionsLabel');
  const actionsCancel = document.getElementById('queueActionsCancel');

  let room = null;          // room the panel was opened for
  let lastKnownRoom = null; // last focus sonosView pushed to us (survives tab switches)
  let state = null;         // last /queue response
  let actionsPayload = null; // pending Play Now/Next/Add payload
  let refreshTimer = null;

  function titleCase(str) {
    return String(str || '').replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  }

  async function qapi(path, options) {
    try {
      const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options
      });
      return await res.json();
    } catch (err) {
      return { error: err.message };
    }
  }

  function roomPath(suffix) {
    return `/api/sonos/room/${encodeURIComponent(room)}${suffix}`;
  }

  function isOpen() {
    return !!(sourcePanelEl && sourcePanelEl.classList.contains('sourcepanel--queue'));
  }

  function currentFocusedRoom() {
    // SonosView is a top-level `const` in a classic script -- a LEXICAL
    // global, not a window property. window.SonosView is therefore
    // always undefined (the v0.7.1 bug: every tab activation concluded
    // "no room focused"). Bare-identifier access reaches the lexical
    // global; try/catch guards the pre-load window, and lastKnownRoom
    // (pushed by sonosView on every focus change, including the boot
    // default) is the fallback of last resort.
    let r = null;
    try {
      // eslint-disable-next-line no-undef
      if (typeof SonosView !== 'undefined' && SonosView && SonosView.getFocusedRoom) {
        r = SonosView.getFocusedRoom();
      } else if (window.SonosView && window.SonosView.getFocusedRoom) {
        r = window.SonosView.getFocusedRoom();
      }
    } catch (err) { /* fall through to lastKnownRoom */ }
    if (typeof r === 'string' && r) return r;
    return lastKnownRoom;
  }

  function activateQueueTab() {
    sourcePanelEl.classList.add('sourcepanel--queue');
    tabQueue.classList.add('is-active');
    tabSources.classList.remove('is-active');
    const r = currentFocusedRoom();
    if (!r) {
      room = null;
      state = null;
      if (titleEl) titleEl.textContent = 'Up Next';
      itemsEl.innerHTML = '<li class="queuepanel__empty">Select a room to see its queue</li>';
      return;
    }
    room = r;
    itemsEl.innerHTML = '<li class="queuepanel__empty">Loading\u2026</li>';
    refresh();
  }

  function activateSourcesTab() {
    sourcePanelEl.classList.remove('sourcepanel--queue');
    tabSources.classList.add('is-active');
    tabQueue.classList.remove('is-active');
  }

  // Called by sonosView whenever room focus changes -- if the queue tab
  // is showing, it follows the newly focused room/group.
  function handleRoomFocused(newRoom) {
    if (newRoom) lastKnownRoom = newRoom; // record even when the tab is hidden
    if (!isOpen()) return;
    if (!newRoom) {
      room = null;
      state = null;
      itemsEl.innerHTML = '<li class="queuepanel__empty">Select a room to see its queue</li>';
      return;
    }
    if (newRoom === room) return;
    room = newRoom;
    itemsEl.innerHTML = '<li class="queuepanel__empty">Loading\u2026</li>';
    refresh();
  }

  // ---------------- Up Next panel ----------------

  function rowEl(item, trackNo) {
    const li = document.createElement('li');
    li.className = 'queuepanel__item';
    li.dataset.trackNo = String(trackNo);
    if (state && trackNo === state.currentTrackNo) li.classList.add('is-current');

    // Drag handle -- pointer-based so it works on the wall tablets.
    // Drop ABOVE a row inserts before it (the inset highlight marks
    // the landing line); the up/down arrows remain as the precise
    // fallback.
    const grip = document.createElement('span');
    grip.className = 'queuepanel__grip';
    grip.textContent = '\u2016';
    grip.setAttribute('aria-label', 'Drag to reorder');
    grip.addEventListener('pointerdown', (e) => beginDrag(e, li, trackNo));
    li.appendChild(grip);

    const art = document.createElement('div');
    art.className = 'queuepanel__art';
    if (item.albumArtUrl) art.style.backgroundImage = `url("${item.albumArtUrl}")`;
    else art.textContent = (item.title || '?').charAt(0).toUpperCase();
    li.appendChild(art);

    const labels = document.createElement('div');
    labels.className = 'queuepanel__labels';
    const t = document.createElement('span');
    t.className = 'queuepanel__tracktitle';
    t.textContent = `${trackNo}. ${item.title || 'Unknown'}`;
    labels.appendChild(t);
    if (item.artist) {
      const a = document.createElement('span');
      a.className = 'queuepanel__trackartist';
      a.textContent = item.artist;
      labels.appendChild(a);
    }
    li.appendChild(labels);
    labels.addEventListener('click', async () => {
      await qapi(roomPath('/queue/jump'), { method: 'POST', body: JSON.stringify({ trackNo }) });
      setTimeout(refresh, 600);
    });

    const controls = document.createElement('div');
    controls.className = 'queuepanel__rowbtns';
    const mk = (label, aria, fn) => {
      const b = document.createElement('button');
      b.className = 'queuepanel__rowbtn';
      b.innerHTML = label;
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fn();
        await refresh();
      });
      return b;
    };
    if (trackNo > 1) {
      controls.appendChild(mk('&#8593;', 'Move up', () =>
        qapi(roomPath('/queue/move'), { method: 'POST', body: JSON.stringify({ from: trackNo, insertBefore: trackNo - 1 }) })));
    }
    if (state && trackNo < state.total) {
      controls.appendChild(mk('&#8595;', 'Move down', () =>
        qapi(roomPath('/queue/move'), { method: 'POST', body: JSON.stringify({ from: trackNo, insertBefore: trackNo + 2 }) })));
    }
    controls.appendChild(mk('&#10005;', 'Remove from queue', () =>
      qapi(roomPath('/queue/remove'), { method: 'POST', body: JSON.stringify({ trackNo }) })));
    li.appendChild(controls);
    return li;
  }

  function render() {
    itemsEl.innerHTML = '';
    if (!state || state.error) {
      const li = document.createElement('li');
      li.className = 'queuepanel__empty';
      li.textContent = state && state.error ? `Couldn't load the queue (${state.error})` : 'Nothing here';
      itemsEl.appendChild(li);
      return;
    }
    if (state.items.length === 0) {
      const li = document.createElement('li');
      li.className = 'queuepanel__empty';
      li.textContent = 'The queue is empty';
      itemsEl.appendChild(li);
      return;
    }
    state.items.forEach((item, idx) => itemsEl.appendChild(rowEl(item, state.start + idx + 1)));
    if (state.start + state.items.length < state.total) {
      const more = document.createElement('li');
      more.className = 'queuepanel__empty queuepanel__more';
      more.textContent = `Load more (${state.start + state.items.length} of ${state.total})`;
      more.addEventListener('click', async () => {
        more.textContent = 'Loading\u2026';
        const next = await qapi(roomPath(`/queue?start=${state.start + state.items.length}`));
        if (!next.error) {
          next.items = state.items.concat(next.items);
          next.start = state.start;
          state = next;
          render();
        }
      });
      itemsEl.appendChild(more);
    }
  }

  async function refresh() {
    if (!room) return;
    // Extent-preserving: a live-event refresh keeps as many pages
    // loaded as the user had expanded to via Load More, instead of
    // collapsing back to the first 200.
    const keep = state && state.items ? Math.max(200, state.items.length) : 200;
    let next = await qapi(roomPath('/queue'));
    while (!next.error && next.items && next.items.length < Math.min(keep, next.total)) {
      const more = await qapi(roomPath(`/queue?start=${next.items.length}`));
      if (more.error || !more.items || more.items.length === 0) break;
      next.items = next.items.concat(more.items);
    }
    state = next;
    if (titleEl) {
      const where = state && state.coordinator && state.coordinator !== room
        ? `${titleCase(room)} (Group: ${titleCase(state.coordinator)})`
        : titleCase(room);
      // Hardware-observed on S2: enabling shuffle physically reorders
      // Q:0 into the play order (and disabling restores the original
      // order), so the list below IS the play order. The label marks
      // the mode either way.
      const shuffleTag = state && state.shuffleOn ? ' \u00b7 Shuffle On' : '';
      titleEl.textContent = `Up Next on ${where}${shuffleTag}`;
    }
    render();
  }

  // Kept for compatibility with anything still calling open()/close().
  function open() { activateQueueTab(); }
  function close() { activateSourcesTab(); }

  // ---------------- Drag reorder ----------------
  let dragState = null; // { fromTrackNo, li, hoverLi, hoverTrackNo }

  function clearDragVisuals() {
    if (!dragState) return;
    dragState.li.classList.remove('is-dragging');
    if (dragState.hoverLi) dragState.hoverLi.classList.remove('is-drop-target');
  }

  function beginDrag(e, li, trackNo) {
    e.preventDefault();
    e.stopPropagation();
    dragState = { fromTrackNo: trackNo, li, hoverLi: null, hoverTrackNo: null };
    li.classList.add('is-dragging');
    const onMove = (ev) => {
      if (!dragState) return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = el && el.closest ? el.closest('.queuepanel__item') : null;
      if (dragState.hoverLi && dragState.hoverLi !== target) {
        dragState.hoverLi.classList.remove('is-drop-target');
        dragState.hoverLi = null;
        dragState.hoverTrackNo = null;
      }
      if (target && target !== dragState.li) {
        dragState.hoverLi = target;
        dragState.hoverTrackNo = parseInt(target.dataset.trackNo, 10) || null;
        target.classList.add('is-drop-target');
      }
    };
    const onUp = async () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const drop = dragState && dragState.hoverTrackNo;
      const from = dragState && dragState.fromTrackNo;
      clearDragVisuals();
      dragState = null;
      // insertBefore uses original (pre-removal) indexing, same as the
      // arrows; dropping onto yourself or the row right below you is a
      // no-op.
      if (drop && from && drop !== from && drop !== from + 1) {
        await qapi(roomPath('/queue/move'), {
          method: 'POST',
          body: JSON.stringify({ from, insertBefore: drop })
        });
        await refresh();
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  // Debounced external refresh -- queue events can arrive in bursts
  // (one per track during an album add).
  function scheduleRefresh() {
    if (!isOpen()) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 400);
  }

  function handleQueueChanged() { scheduleRefresh(); }
  function handleNowPlayingChanged() { scheduleRefresh(); }

  // ---------------- Play Now / Next / Add action sheet ----------------

  function showActions(payload) {
    actionsPayload = payload;
    actionsLabel.textContent = payload.label || '';
    actions.style.display = 'flex';
  }

  function hideActions() {
    actions.style.display = 'none';
    actionsPayload = null;
  }

  async function runAction(mode) {
    if (!actionsPayload) return;
    const { room: r, uri, metadata, containerId } = actionsPayload;
    actionsLabel.textContent = 'Working\u2026';
    const result = await qapi(`/api/sonos/room/${encodeURIComponent(r)}/queue/add`, {
      method: 'POST',
      body: JSON.stringify({ mode, uri, metadata, containerId })
    });
    actionsLabel.textContent = result.error
      ? `Couldn't queue that (${result.error})`
      : `Queued ${result.queued} track${result.queued === 1 ? '' : 's'} \u2713`;
    setTimeout(hideActions, result.error ? 2200 : 700);
    if (isOpen()) scheduleRefresh();
  }

  // ---------------- Wiring ----------------

  if (tabQueue) tabQueue.addEventListener('click', activateQueueTab);
  if (tabSources) tabSources.addEventListener('click', activateSourcesTab);
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!window.confirm('Clear the whole queue?')) return;
      await qapi(roomPath('/queue/clear'), { method: 'POST' });
      await refresh();
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const title = window.prompt('Save queue as playlist named:');
      if (!title || !title.trim()) return;
      const result = await qapi(roomPath('/save-queue'), {
        method: 'POST',
        body: JSON.stringify({ title: title.trim() })
      });
      window.alert(result.error ? `Couldn't save: ${result.error}` : `Saved "${title.trim()}"`);
    });
  }
  if (actions) {
    actions.addEventListener('click', (e) => { if (e.target === actions) hideActions(); });
    actions.querySelectorAll('.queueactions__btn[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => runAction(btn.getAttribute('data-mode')));
    });
  }
  if (actionsCancel) actionsCancel.addEventListener('click', hideActions);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && actions && actions.style.display !== 'none') hideActions();
  });

  return { open, close, refreshIfOpen: scheduleRefresh, handleQueueChanged, handleNowPlayingChanged, handleRoomFocused, showActions };
})();

window.QueuePanel = QueuePanel;
