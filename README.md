# Sonos Panel

A touchscreen-friendly web app for controlling a whole-house Sonos
system. Runs as a single Docker container -- built Docker-first and
geared toward **Unraid** (a ready-made template is included), though
any Docker host works. No server? It also runs directly on an
always-on Windows PC -- see
[Running on Windows](#running-on-windows-no-docker-no-server-needed). Installs as a fullscreen app on Android/iOS
home screens (PWA): point any number of cheap tablets at it and use
them as wall-mounted control panels around the house.

Built and battle-tested against a real 9-room household with a
160,000-track music library.

## S1 and S2 support

The panel works with **both Sonos generations** -- current **S2**
systems and legacy **S1** (firmware 11.x) systems -- but **one
container controls one generation, never both**. S1 and S2 hardware
on the same network run as two entirely separate Sonos households
that cannot group or play together; that is a Sonos platform rule,
not a panel limitation.

- The **Sonos System** template variable (`SONOS_SYSTEM`) picks the
  generation: `s2` (default) or `s1`. Devices of the other generation
  on the same LAN are detected (via each speaker's reported software
  generation) and excluded from the room list automatically.
- **Want to control both systems?** Install the container **twice**
  -- separate fixed IPs, separate appdata paths, one set to `s2` and
  one to `s1`. Two panels, two households, no crosstalk.
- Differences in what each generation can play are handled by the
  Local Music Library scanner automatically -- see the format table
  below.
- On S1, the "Up Next" line under the progress bar is disabled: it
  relies on S2-verified queue behavior under shuffle that S1 firmware
  has not been confirmed to share. Everything else works identically.

## Features

- Every room in the system, tap to control; grouped rooms expand
  under their group head
- **Group Rooms dialog** mimicking the official app: tap the group
  icon on any room, check who joins -- the tapped room is always the
  group coordinator. Party Mode included. Saved group presets for
  one-tap recall
- Play/pause/skip, seek, volume (per-room or ratio-preserving group
  master), per-speaker EQ (bass/treble/loudness), sleep timers
- **Shuffle, Repeat (off / all / one), and Crossfade** buttons
- **Full queue management**: view, jump, remove, drag-to-reorder,
  clear, and save the queue as a playlist; live-updating via speaker
  events
- Browse and play **Favorites** (grouped by service with proper
  logos), **Sonos Playlists** (create, rename, delete, add/remove
  tracks), and **Line-In** sources
- **Multi-account services**: households with several logins of one
  service (three Pandora accounts, say) get a user list per service
  ("Albert's Playlists", "Family's Playlists" -- names editable on
  the panel), so nobody interrupts anyone else's stream by grabbing a
  station from the wrong login
- **Music service directory** (`public/icons/music_services.js`): all
  134 Sonos-supported services with display names and icons, fully
  user-editable -- no code changes needed to add or rename a service
  (see "Adding a music service" below)
- **Network Music Library**: browse and stream your own music files
  straight from the server to the speakers -- no Sonos 65,000-song
  index limit. Artists / Albums / Songs / Genres / Composers /
  Folders / Recently Added, unified search across everything,
  letter buckets that ignore "The" and accents, artist "All Songs",
  fully self-healing album art
- "Up Next" line under the progress bar during queue/playlist
  playback (S2 systems)
- **Passcode lock** (optional): a 4-digit code gates structural
  changes -- deleting/renaming playlists, editing account names,
  adding tracks to playlists, and any group add/edit/apply -- behind
  an onscreen keypad. Playback and queue stay open for guests.
  Unlocked panels re-lock after 60 seconds without a touch
- **Pull down to refresh**: drag down from the top edge of the screen
  to reload the panel -- no browser chrome needed on kiosk tablets
- Album art, track/artist, and source info while playing; ambient
  screensaver (bouncing now-playing, or color-cycling rings when
  idle)
- Up to 3 extra tabs alongside Sonos, each embedding another local
  dashboard (Hubitat, Home Assistant, anything on your LAN)

## Quick start (Docker)

```bash
git clone https://github.com/almulder/Sonos_Panel.git
cd Sonos_Panel
docker compose up -d
```

Then open `http://<your-server-ip>:3000`.

**Important:** this only works with host networking (already set in
`docker-compose.yml`). Sonos discovery uses SSDP (UDP multicast) to
find speakers on the local network, which Docker's default bridge
network silently blocks -- the app will start fine and just never
find any speakers, with no obvious error pointing at why. Don't
switch this to bridge networking.

## Running on Unraid (recommended)

Full walkthrough in [`UNRAID_SETUP.md`](UNRAID_SETUP.md). The short
version:

1. **Docker tab -> Add Container**, using
   [`templates/sonos-panel.xml`](templates/sonos-panel.xml) from this
   repo (place it in
   `/boot/config/plugins/dockerMan/templates-user/`, or paste its
   fields manually)
2. **Network Type: Custom (br0)** with a **fixed IP** on the same
   subnet as your speakers (set br0 to **ipvlan** in Docker
   settings). The panel needs its own LAN address both for SSDP
   discovery/eventing and so speakers can stream Network Music
   Library audio back from it
3. Optionally set **Music Path** and the other template fields,
   Apply, then open `http://<the-ip-you-chose>/`

### Template variables

| Variable | Default | What it does |
| --- | --- | --- |
| `SONOS_SYSTEM` | `s2` | Which Sonos generation this container controls: `s2` or `s1`. One per container -- run two containers to cover both |
| `PASSCODE` | (blank) | Optional 4-digit code enabling the passcode lock. Blank = everything unlocked |
| Music Path | (blank) | Read-only folder of music files enabling the Network Music Library |
| `PUBLIC_BASE_URL` | auto | URL speakers use to stream from the panel; auto-detected on br0/host networking |
| `RESCAN_SCHEDULE` | (blank) | `daily@HH:MM` or `weekly@DAY@HH:MM` library rescans (a quick incremental scan always runs at startup) |
| `TZ` | America/Denver | Timezone for the rescan schedule |
| `SCREENSAVER_TIMEOUT_SECONDS` | 600 | Idle time before the screensaver |
| `TAB2_*` / `TAB3_*` / `TAB4_*` | (blank) | Extra embedded-dashboard tabs (title, color, icon, URL) |

## Running on Windows (no Docker, no server needed)

If you don't have a NAS or home server, Sonos Panel runs directly on
any always-on Windows PC -- a cheap mini PC tucked behind the TV is
perfect. No Docker, no Unraid, no networking setup.

**Don't use Docker Desktop for this.** On Windows it runs containers
inside a virtual machine behind NAT, which blocks the speaker
discovery this app depends on. Running it directly, as below, avoids
the problem entirely.

### 1. Install Node.js

Download the **LTS** installer from
[nodejs.org](https://nodejs.org) and run it, accepting the defaults.
This is the engine the panel runs on.

### 2. Download Sonos Panel

Download this repository as a ZIP (green **Code** button at the top
of the GitHub page, then **Download ZIP**) and extract it to
`C:\Sonos_Panel`.

### 3. Install its components

Open the Start menu, type `cmd`, and open **Command Prompt**. Then
run these two lines:

```
cd C:\Sonos_Panel
npm install --omit=dev
```

This takes a minute or two and prints a lot of text. That's normal.

### 4. Create the start file

In `C:\Sonos_Panel`, create a new text file named `start-panel.bat`
containing:

```bat
@echo off
set PORT=8080
set DATA_DIR=C:\Sonos_Panel\data
set SONOS_SYSTEM=s2
set TZ=America/Denver
rem Optional -- point this at your music folder to enable the
rem Network Music Library, or delete the line if you don't have one:
set MUSIC_DIR=D:\Music
node server\index.js
```

Adjust `MUSIC_DIR` to wherever your music actually lives, set
`SONOS_SYSTEM` to `s1` if you have a legacy Sonos system, and change
`TZ` to your timezone.

### 5. Start it

Double-click `start-panel.bat`. A black window opens and stays open
-- that's the panel running; closing it stops the panel.

**The first time you run it, Windows will ask whether to allow
Node.js through the firewall. You must click Allow, with "Private
networks" checked.** If you miss this prompt, the panel will find
zero speakers. To fix it later, go to Windows Security > Firewall &
network protection > Allow an app through firewall, and make sure
Node.js is checked for Private.

Now open a browser to **http://localhost:8080** on that PC, or
`http://<that-pc's-IP>:8080` from a tablet or phone on the same
network.

### 6. Keep it running

Two settings matter on an always-on machine:

- **Stop it sleeping.** Settings > System > Power > Screen and sleep:
  set sleep to **Never**. A sleeping PC takes your wall panels down
  with it.
- **Start it automatically.** Press `Win+R`, type `shell:startup`,
  and put a shortcut to `start-panel.bat` in the folder that opens.
  The panel then starts whenever the PC boots. (For a tidier setup
  that runs invisibly in the background, install
  [NSSM](https://nssm.cc) and run `nssm install SonosPanel`.)

### Windows troubleshooting

**No speakers found.** Almost always the firewall prompt from step 5.
Confirm Node.js is allowed on Private networks. Also make sure the PC
is on the same network as the speakers, not a guest or IoT VLAN.

**Port 8080 already in use.** Change `set PORT=8080` in the .bat file
to another number, such as `8081`, and use that in the browser
address instead.

**`npm install` fails.** Make sure Node.js installed correctly by
running `node -v` -- it should print a version number of 18 or
higher. If not, reinstall Node.js and reopen Command Prompt.

**Music files don't appear.** Check `MUSIC_DIR` points at a real
folder, and see the format limits below -- files the speakers can't
play are skipped on purpose and listed in `incompatible-files.txt`
inside your `DATA_DIR` folder.


## Network Music Library

Point the Music Path at your files and the panel indexes them into a
local SQLite database and streams them straight to the speakers over
HTTP -- sidestepping the Sonos music-library index limit entirely.
Playlists, queueing, artwork, search, and shuffle/repeat all work
against local files exactly as they do for streaming sources.

### What each system can play

The scanner checks every file against the limits of the generation
set in `SONOS_SYSTEM` and only indexes what the speakers can actually
play:

| Format | S2 limit | S1 limit |
| --- | --- | --- |
| MP3 / AAC / M4A / OGG | up to 320 kbps | up to 320 kbps |
| WMA | up to 355 kbps (no WMA Lossless) | up to 355 kbps (no WMA Lossless) |
| FLAC / ALAC | up to **24-bit** | up to **16-bit** |
| AIFF / WAV | up to 16-bit | up to 16-bit |
| All lossless | max 48 kHz sample rate | max 48 kHz sample rate |

Files over the limits (hi-res 88.2/96/192 kHz FLAC is the common
case) are **skipped, not added** -- each is listed with its reason in
`incompatible-files.txt` in the appdata folder, also viewable at
`/api/local/incompatible`. The panel does **not** convert files;
transcoding hi-res libraries is out of scope here (a separate
project). Re-encode those files yourself to 48 kHz / 16- or 24-bit
and the next scan picks them up.

### The scanner

- First scan of a large library takes minutes (171k files indexed in
  ~17 at reference); every scan after that is incremental --
  unchanged files are skipped, so rescans take seconds
- Album art comes from folder images (`cover.jpg` etc.) or embedded
  tags, extracted once and cached. Art is fully **self-healing**:
  every scan re-verifies each folder -- added covers upgrade, deleted
  covers fall back, a wiped art cache regenerates, and re-tagged
  embedded covers refresh automatically

## Adding a music service

Service names and icons live in one user-editable file:
`public/icons/music_services.js`, shipped with all 134 services Sonos
supports. Each entry is `key: 'Display Name'` -- the key is the
service's stream name lowercased with punctuation removed, and its
icon is simply `<key>.png` in the same folder. Matching is by prefix,
so one `pandora` entry covers "Pandora", "Pandora Playlist", and
"Pandora Station".

If a service ever shows up unmapped, the panel displays its **raw
stream name -- which is exactly the key you need to add**. The Docker
log also prints the raw name and ready-made key every time a source
plays (`Play source: ...`), and dumps every favorite's raw label at
startup. Add the line, drop in a PNG, refresh the browser. Done -- no
code, no rebuild. `Download-ServiceLogos.ps1` fetches all the
official logos from Sonos's support site in one run.

## What it deliberately doesn't do

- **Browse streaming-service catalogs** (Spotify/Apple Music/Pandora
  search etc.) -- per-service cloud APIs, each with its own auth.
  Favorite things in the official app once; the panel plays all
  favorites, on the right account, forever after
- Alarms, TruePlay tuning, stereo-pair/surround setup, firmware
  updates, voice -- system-administration jobs for the official app
- Convert incompatible files (see above -- separate project)
- Mix S1 and S2 in one container (two containers covers it)

## How it's built

Node.js + Express, one container, no cloud: everything is local
UPnP/SOAP against the speakers themselves (AVTransport,
RenderingControl, ContentDirectory, ZoneGroupTopology) with GENA
event subscriptions pushing real-time state to the browser over
WebSockets -- controls react instantly, whichever app made the
change. The web UI is plain HTML/CSS/JS, no framework, tuned for
touch.

Version and attribution appear in the lower-left corner of the panel.

## Contributing

Issues and PRs welcome at
[github.com/almulder/Sonos_Panel](https://github.com/almulder/Sonos_Panel).

## License

MIT
