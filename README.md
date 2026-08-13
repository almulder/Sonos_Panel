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
3. Optionally set **Music Path** and the other template fields (see
   [Settings](#settings) below for what each one does), Apply, then
   open `http://<the-ip-you-chose>/`


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
This is the engine the panel runs on. Node 20 or newer is required.

To check it worked, open Command Prompt and run `node -v` -- it
should print a version number like `v22.11.0` or higher.

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

In `C:\Sonos_Panel`, create a new text file named `start-panel.bat`.
Copy everything below into it.

If you're updating an existing `start-panel.bat`, **delete everything
already in the file first.** The last line, `node server\index.js`,
is what actually starts the panel -- anything pasted below it never
runs, so a file with that line in the middle will silently ignore
every setting after it.

Lines starting with `rem` are notes and are ignored -- to switch a
setting on, delete the `rem ` from the front of its line and fill in
your value. Everything except the first four lines is optional.

```bat
@echo off
rem ===== Basic settings (leave these as they are unless noted) =====
set PORT=8080
set DATA_DIR=C:\Sonos_Panel\data
set TZ=America/Denver
rem Use s1 instead of s2 if you have a legacy Sonos system:
set SONOS_SYSTEM=s2

rem ===== Your music folder (optional) =====
rem Point this at your music to enable the Network Music Library.
rem Delete this line entirely if you don't have a music folder.
set MUSIC_DIR=D:\Music

rem ===== Passcode lock (optional) =====
rem Any 4 digits. Stops guests deleting playlists or changing groups.
rem Playback and the queue stay open to everyone.
rem set PASSCODE=1234

rem ===== Screensaver (optional) =====
rem Seconds of no touch before the screensaver starts. Default 600.
rem set SCREENSAVER_TIMEOUT_SECONDS=600

rem ===== Extra tab 2 (optional) =====
rem Embeds another page on your network as a second tab, such as a
rem Home Assistant or Hubitat dashboard. Only the URL is required --
rem the other three lines just change how the tab looks.
rem set TAB2_URL=http://192.168.1.50:8123
rem set TAB2_TITLE=Home
rem set TAB2_COLOR=#41bdf5
rem set TAB2_ICON=http://192.168.1.50:8123/static/icons/favicon-192x192.png

rem ===== Extra tab 3 (optional) =====
rem set TAB3_URL=http://192.168.1.60/dashboard
rem set TAB3_TITLE=Cameras
rem set TAB3_COLOR=#7ac943
rem set TAB3_ICON=

rem ===== Extra tab 4 (optional) =====
rem set TAB4_URL=http://192.168.1.70/hubitat/dashboard/1
rem set TAB4_TITLE=Lights
rem set TAB4_COLOR=
rem set TAB4_ICON=

node server\index.js
```

Things worth knowing:

- **Change `MUSIC_DIR`** to wherever your music actually lives, or
  delete that line if you don't have a music folder.
- **Change `TZ`** to your timezone if you're not in Mountain time
  (for example `America/New_York`, `America/Chicago`,
  `America/Los_Angeles`, `Europe/London`).
- **For the extra tabs, the `_URL` line is the only one that
  matters.** A tab appears as soon as its URL is set, and won't
  appear at all without it. Title, colour, and icon are optional
  decoration -- you can leave them commented out.
- **Don't put spaces around the `=`**, and don't add a trailing
  space after a value. `set PORT=8080` works; `set PORT = 8080`
  does not.
- **`node server\index.js` must be the last line, and appear only
  once.** It starts the panel; any `set` line below it is ignored.
- **Changes only take effect on restart.** After editing this file,
  close the panel's black window and double-click the file again.

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

**`npm install` fails with a long error mentioning
`better-sqlite3`, `node-gyp`, or Visual Studio.** The panel uses one
component that ships as a prebuilt binary; if npm can't download the
right one, it tries to build it from source and fails without
Microsoft's C++ build tools installed.

First, run `node -v`. If it prints anything below `v20`, install a
current Node.js and try again.

Otherwise it's usually a failed download (the error contains
`socket hang up` or `ECONNRESET`). Try:

```
npm cache clean --force
npm install --omit=dev
```

Antivirus or VPN software sometimes blocks the binary download -- if
it keeps failing, pause that briefly and retry. As a last resort you
can install the "Desktop development with C++" workload from the
[Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/),
which lets it compile locally, but that's a large download and is
rarely necessary.

**Music files don't appear.** First check the panel can actually
read the folder: paste the `MUSIC_DIR` path into File Explorer's
address bar. If it doesn't open there, it won't work in the panel
either -- see
[Where your music can live](#where-your-music-can-live), especially
if your music is on another computer or a NAS. If the folder does
open, the files may be over the format limits -- those are skipped on
purpose and listed with reasons in `incompatible-files.txt` inside
your `DATA_DIR` folder.

**Music is indexed but won't play through the speakers.** The
speakers fetch audio from the panel over the network, so they need to
be able to reach it. Confirm Node.js is allowed through Windows
Firewall on **Private** networks (step 5), and that the PC and the
speakers are on the same network. If it still fails, set
`PUBLIC_BASE_URL` explicitly, for example
`set PUBLIC_BASE_URL=http://192.168.1.25:8080`, using the PC's own
LAN address.


## Settings

All settings are optional except the music path (and only if you want
the Network Music Library). On Unraid these are template fields; on
Windows they are `set NAME=value` lines in `start-panel.bat`. The
name in the first column is the environment variable in both cases.

| Setting | Default | What it does |
| --- | --- | --- |
| `SONOS_SYSTEM` | `s2` | Which Sonos generation this instance controls: `s2` or `s1`. One per instance -- run two to cover both |
| `MUSIC_DIR` | (blank) | Folder of music files enabling the Network Music Library. On Unraid this is the **Music Path** field, mapped read-only |
| `PASSCODE` | (blank) | 4-digit code enabling the passcode lock. Blank = everything unlocked |
| `SCREENSAVER_TIMEOUT_SECONDS` | `600` | Idle seconds before the screensaver starts |
| `RESCAN_SCHEDULE` | (blank) | `daily@HH:MM` or `weekly@DAY@HH:MM` library rescans (a quick incremental scan always runs at startup) |
| `TZ` | `America/Denver` | Timezone for the rescan schedule |
| `PORT` | `3000` | Port the panel listens on (the Unraid template uses `80`) |
| `PUBLIC_BASE_URL` | auto | URL the speakers use to stream from the panel. Auto-detected; only set it if local files won't play |
| `DATA_DIR` | `./data` | Where the library index, artwork cache, and saved settings live |
| `TAB2_URL`, `TAB3_URL`, `TAB4_URL` | (blank) | Each adds an extra tab embedding that URL. Optional `TAB2_TITLE` / `_ICON` / `_COLOR` etc. style them -- see [Extra tabs](#extra-tabs) |

### The passcode lock

Set `PASSCODE` to any 4 digits and the panel asks for it before
anything structural: deleting or renaming playlists, adding or
removing playlist tracks, editing account names, and creating or
changing room groups. Playback, volume, and the queue stay open, so
guests can play whatever they like without rearranging your setup. An
onscreen keypad appears -- no keyboard needed on a tablet. Once
entered, the panel stays unlocked while it's being used and re-locks
after 60 seconds of no touches. Leave it blank to disable the lock
entirely.

### The screensaver

`SCREENSAVER_TIMEOUT_SECONDS` sets how long the panel waits before
going ambient (default 600 = 10 minutes). While music is playing it
shows a slowly drifting now-playing display with album art; when idle
it shows animated colour-cycling rings. Touching the screen anywhere
brings the panel straight back.

### Extra tabs

The panel can show up to three extra tabs beside the Sonos one, each
embedding another page on your network -- a Home Assistant dashboard,
a Hubitat dashboard, a camera view, anything with a URL. This turns a
single wall tablet into a whole-house control panel instead of just a
music remote.

There are twelve variables in total: four for each of the three tabs,
named **TAB2_**, **TAB3_**, and **TAB4_** (there is no "Tab 1" -- that
slot is always Sonos itself).

| Variable | Required? | What it does |
| --- | --- | --- |
| `TAB2_URL` | **Required** | Full URL of the page to embed. **Tab 2 only appears if this is set** |
| `TAB2_TITLE` | Optional | Name on the tab. Defaults to "Tab 2" |
| `TAB2_ICON` | Optional | An emoji, or a full image URL, shown before the title |
| `TAB2_COLOR` | Optional | Hex colour for the tab's underline, e.g. `#41bdf5` |
| `TAB3_URL` | **Required** | Full URL to embed. **Tab 3 only appears if this is set** |
| `TAB3_TITLE` | Optional | Name on the tab. Defaults to "Tab 3" |
| `TAB3_ICON` | Optional | Emoji or image URL |
| `TAB3_COLOR` | Optional | Hex colour for the underline |
| `TAB4_URL` | **Required** | Full URL to embed. **Tab 4 only appears if this is set** |
| `TAB4_TITLE` | Optional | Name on the tab. Defaults to "Tab 4" |
| `TAB4_ICON` | Optional | Emoji or image URL |
| `TAB4_COLOR` | Optional | Hex colour for the underline |

**The URL is the only one that matters.** Set just `TAB2_URL` and you
get a working tab called "Tab 2" in the default colour with no icon.
The other three fields are pure decoration -- fill in the ones you
care about and leave the rest blank. You do not need to populate all
four fields for a tab to work.

Tabs also don't have to be used in order. Configuring only `TAB3_URL`
works fine, and leaving `TAB2_URL` blank simply means one fewer tab.

#### Example: one tab

```bat
set TAB2_TITLE=Home
set TAB2_URL=http://192.168.1.50:8123
```

#### Example: three tabs, with decoration

```bat
set TAB2_TITLE=Home
set TAB2_URL=http://192.168.1.50:8123
set TAB2_COLOR=#41bdf5
set TAB2_ICON=https://192.168.1.50:8123/static/icons/favicon-192x192.png

set TAB3_TITLE=Cameras
set TAB3_URL=http://192.168.1.60/dashboard
set TAB3_COLOR=#7ac943

set TAB4_TITLE=Lights
set TAB4_URL=http://192.168.1.70/hubitat/dashboard/1
```

A single emoji works as an icon too, and is the easiest option in the
Unraid template fields. In a Windows `.bat` file, though, emoji often
get mangled by the console's character encoding -- use an image URL
there instead, as above.

On Unraid, enter these same values in the **Tab 2 Title / Tab 2 URL /
Tab 2 Icon / Tab 2 Color** template fields. Tab 3 and Tab 4 live under
**Show more settings** in the container's edit screen.

#### If a tab doesn't appear

- **Nothing shows up at all.** The tab's `_URL` variable is almost
  certainly missing or empty -- that's the one field that creates the
  tab. Check for typos: it's `TAB2_URL`, not `TAB_2_URL` or `TAB2URL`.
- **You changed a setting and nothing happened.** On Windows, check
  that `node server\index.js` is the very last line of
  `start-panel.bat` and appears only once -- settings below it never
  run. Otherwise: the panel reads these once at startup. On Windows, close the black window and
  double-click `start-panel.bat` again. On Unraid, hit Apply on the
  container. Then refresh the browser.
- **On Unraid, the fields aren't in the container's edit screen.**
  Variables added to the template don't appear on a container that was
  created earlier. Remove the container (keeping appdata) and re-add
  it from the template, or use **Add another Path, Port, Variable**
  to add the variable by name manually.
- **The tab appears but the page inside is blank.** The site is
  refusing to be embedded. Most public websites (Google, and anything
  with strict security headers) block this deliberately and there's no
  way around it from this end. Home Assistant does it too by default:
  the fix is on the Home Assistant side, adding
  `use_x_frame_options: false` under `http:` in its `configuration.yaml`
  and restarting it. Hubitat dashboards embed without changes.


## Network Music Library

Point the Music Path at your files and the panel indexes them into a
local SQLite database and streams them straight to the speakers over
HTTP -- sidestepping the Sonos music-library index limit entirely.
Playlists, queueing, artwork, search, and shuffle/repeat all work
against local files exactly as they do for streaming sources.

### Where your music can live

The panel reads your music files itself and serves them to the
speakers over HTTP. The speakers never open your files directly, so
your music folder does **not** need to be shared for Sonos's benefit
-- but the panel does need to be able to read it.

**Music on the same machine as the panel.** Point `MUSIC_DIR` (or
Unraid's Music Path) straight at the folder and you're done. No
sharing, no permissions, nothing else to set up.

```bat
set MUSIC_DIR=D:\Music
```

**Music on another computer or a NAS.** The panel can only read it if
that folder is shared on the network and reachable from the machine
running the panel. Use the full network path rather than a mapped
drive letter:

```bat
set MUSIC_DIR=\\TOWER\Music
```

Mapped drive letters like `X:\` are tied to your logged-in Windows
session. They work while you're signed in, but disappear when the
panel runs as a service or starts at boot before you log in -- the
library then scans as empty with no obvious explanation. A full
`\\SERVER\Share` path always works.

On Unraid, mount the remote share on the **host** first (Unassigned
Devices plugin, giving you `/mnt/remotes/...`) and point Music Path
there.

#### Sharing a folder on Windows

Do this on the computer that holds the music, not the one running the
panel:

1. Right-click the music folder and choose **Properties**.
2. Open the **Sharing** tab and click **Advanced Sharing**.
3. Tick **Share this folder**. Note the **Share name** -- this
   becomes part of the path.
4. Click **Permissions** and make sure **Read** is allowed for the
   account you'll use (or **Everyone**, if it's a trusted home
   network).
5. Click **OK**, then **Apply**.
6. The Sharing tab now shows the **Network Path**, something like
   `\\DESKTOP-ABC\Music`. That's what goes in `MUSIC_DIR`.

Then, on the machine running the panel, paste that same path into
File Explorer's address bar and press Enter. If your music appears,
the panel can read it too. If Windows asks for credentials, tick
**Remember my credentials** so the panel isn't blocked later.

If the path doesn't open, check on the machine holding the music that
its network profile is set to **Private** (not Public), under
Settings > Network & internet, and that network discovery and file
sharing are turned on under **Advanced sharing settings**.

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
