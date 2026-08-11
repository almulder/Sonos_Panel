// groupDialog.js
//
// The "Group Rooms" dialog (v0.8.0), mimicking the official Sonos
// desktop app's layout in the panel's own dark theme: left pane shows
// what the clicked room is playing (that's what the group will hear),
// right pane is a checkbox list of every room, plus Party Mode.
//
// The room whose icon was tapped is ALWAYS the group coordinator --
// checked rooms join IT (POST /api/sonos/room/<anchor>/group-members),
// which replaces the old checkbox flow where the anchor was
// effectively an alphabetical lottery. Rooms living in other groups
// that aren't touched here stay exactly where they are.

const GroupDialog = (() => {
  const overlay = document.getElementById('groupDialog');
  const titleEl = document.getElementById('groupDialogTitle');
  const closeBtn = document.getElementById('groupDialogClose');
  const artEl = document.getElementById('groupDialogArt');
  const trackEl = document.getElementById('groupDialogTrack');
  const artistEl = document.getElementById('groupDialogArtist');
  const listEl = document.getElementById('groupDialogRooms');
  const partyBtn = document.getElementById('groupDialogParty');
  const doneBtn = document.getElementById('groupDialogDone');
  const cancelBtn = document.getElementById('groupDialogCancel');

  let anchor = null;   // the clicked room -- always the coordinator
  let busy = false;

  function titleCase(s) {
    return String(s || '').replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  }

  async function gapi(path, options) {
    try {
      const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
      return await res.json();
    } catch (err) {
      return { error: err.message };
    }
  }

  function isOpen() {
    return overlay && overlay.style.display !== 'none';
  }

  function renderRoomRow(room, checked, disabled) {
    const li = document.createElement('li');
    li.className = 'groupdialog__roomrow';
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.disabled = disabled;
    box.dataset.room = room.name;
    const name = document.createElement('span');
    name.textContent = titleCase(room.name) + (room.reachable === false ? ' (disconnected)' : '');
    label.appendChild(box);
    label.appendChild(name);
    li.appendChild(label);
    return li;
  }

  async function open(roomName) {
    if (!roomName) return;
    anchor = roomName;
    busy = false;
    titleEl.textContent = 'Group Rooms';
    trackEl.textContent = '\u2026';
    artistEl.textContent = '';
    artEl.style.backgroundImage = '';
    artEl.textContent = '';
    listEl.innerHTML = '<li class="groupdialog__loading">Loading\u2026</li>';
    overlay.style.display = 'flex';

    // Left pane: what the group will play = the anchor's session.
    gapi(`/api/sonos/nowplaying/${encodeURIComponent(roomName)}`).then((np) => {
      if (!isOpen() || anchor !== roomName) return;
      if (np && np.title) {
        trackEl.textContent = np.title;
        artistEl.textContent = np.artist || '';
        if (np.albumArtUrl) artEl.style.backgroundImage = `url("${np.albumArtUrl}")`;
        else artEl.textContent = np.title.charAt(0).toUpperCase();
      } else {
        trackEl.textContent = 'Nothing playing';
        artistEl.textContent = '';
        artEl.textContent = '\u266B';
      }
    });

    // Right pane: every room; anchor pinned first, checked and locked;
    // its current members pre-checked.
    const data = await gapi('/api/sonos/rooms');
    if (!isOpen() || anchor !== roomName) return;
    const rooms = (data && data.rooms) || [];
    listEl.innerHTML = '';
    const anchorRoom = rooms.find((r) => r.name === roomName);
    if (anchorRoom) listEl.appendChild(renderRoomRow(anchorRoom, true, true));
    rooms
      .filter((r) => r.name !== roomName)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((r) => listEl.appendChild(renderRoomRow(r, r.coordinator === roomName, false)));
  }

  function close() {
    overlay.style.display = 'none';
    anchor = null;
  }

  async function applyDone() {
    if (busy || !anchor) return;
    busy = true;
    doneBtn.textContent = 'Working\u2026';
    const members = [...listEl.querySelectorAll('input[type=checkbox]:checked')]
      .map((box) => box.dataset.room)
      .filter((n) => n && n !== anchor);
    const result = await gapi(`/api/sonos/room/${encodeURIComponent(anchor)}/group-members`, {
      method: 'POST',
      body: JSON.stringify({ members })
    });
    doneBtn.textContent = 'Done';
    busy = false;
    if (result.error) {
      trackEl.textContent = `Couldn't apply: ${result.error}`;
      return;
    }
    if (result.failed && result.failed.length > 0) {
      trackEl.textContent = `Didn't join: ${result.failed.map(titleCase).join(', ')}`;
      setTimeout(close, 1800);
      return;
    }
    close();
  }

  if (closeBtn) closeBtn.addEventListener('click', close);
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  if (partyBtn) {
    partyBtn.addEventListener('click', () => {
      listEl.querySelectorAll('input[type=checkbox]').forEach((box) => { box.checked = true; });
    });
  }
  if (doneBtn) doneBtn.addEventListener('click', applyDone);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });

  return { open, close };
})();

window.GroupDialog = GroupDialog;
