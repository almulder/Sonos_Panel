# Sonos Panel

A touchscreen-friendly web app for controlling a whole-house Sonos
system. Runs as a single Docker container, and installs as a
fullscreen app on Android/iOS home screens (PWA) -- point any number
of cheap tablets at it and use them as wall-mounted control panels
around the house.

## Features

- Shows every room in the system, tap one to control it
- Play/pause/skip, volume (individual room or synced across a group)
- Group and ungroup rooms by selecting several and confirming
- Browse and play Favorites, Playlists, and Line-In sources
- Local Music Library: browse (Artists / Albums / Songs / Composers /
  Genres / Folders, with real search) and stream your own music files
  straight from the server to the speakers -- no Sonos 65,000-song
  index limit
- Album art, track/artist, and source info while playing
- An ambient screensaver after a period of inactivity -- bouncing
  now-playing display while something's playing, a slow color-cycling
  "sound wave rings" animation when idle
- 3 extra tabs alongside Sonos, each embedding another local
  dashboard (Hubitat, Home Assistant, or anything else on your LAN)

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

## Running on Unraid

Full walkthrough in [`UNRAID_SETUP.md`](UNRAID_SETUP.md). The short
version:

1. **Docker tab → Add Container**, using `my-Sonos_Panel.xml` from this
   repo (place it in
   `/boot/config/plugins/dockerMan/templates-user/`, or paste its
   fields manually)
2. **Network Type: Custom (br0)** with a **fixed IP** on the same
   subnet as your speakers. The panel needs its own LAN address both
   for SSDP discovery/eventing and so speakers can stream Local Music
   Library audio back from it. (Host networking also works but shares
   the Unraid IP; bridge mode does not work.)
3. Optionally set **Music Path** (Local Music Library) and the other
   template fields, Apply, then open `http://<the-ip-you-chose>/` --
   the template serves the panel on port 80, no port number needed

## Installing as an app (Android/iOS)

Since this is a PWA (Progressive Web App), it can be added to a
phone/tablet's home screen and opens fullscreen with no browser
address bar, exactly like a native app:

**Android (Chrome):** open the URL → tap the **⋮** menu → **Add to
Home screen** (or **Install app**, wording varies by Chrome version)

**iOS (Safari):** open the URL → tap the **Share** icon → **Add to
Home Screen**

Once added, tapping the home screen icon opens it fullscreen directly
-- this is what makes a cheap Android tablet usable as a dedicated
wall panel without any special kiosk software.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the app listens on |
| `THEME_COLOR` | `#e8a33d` | Accent color (hex). Drives buttons/highlights and the idle screensaver's color-cycle animation -- variations are derived automatically from whatever color you set. |
| `SCREENSAVER_TIMEOUT_SECONDS` | `600` | Seconds of no touch/click before the screensaver activates. |
| `TAB2_TITLE`, `TAB2_COLOR`, `TAB2_ICON`, `TAB2_URL` | *(unset)* | An extra tab embedding another local dashboard in an iframe. Only `_URL` is required -- `_TITLE` falls back to "Tab 2", `_COLOR` falls back to `THEME_COLOR`, and `_ICON` (emoji or image URL, shown at the start of the tab) is simply omitted if blank. Leave `_URL` unset to not show this tab at all. |
| `TAB3_TITLE`, `TAB3_COLOR`, `TAB3_ICON`, `TAB3_URL` | *(unset)* | Same as above, for a third tab. |
| `TAB4_TITLE`, `TAB4_COLOR`, `TAB4_ICON`, `TAB4_URL` | *(unset)* | Same as above, for a fourth tab. |
| `MUSIC_DIR` | `/music` | Container-side path of the Local Music Library mount. Leave as-is and just volume-mount your music folder to `/music` (the Unraid template's **Music Path** field does exactly this). |
| `PUBLIC_BASE_URL` | *(unset = auto-detect)* | Local Music Library only: the URL the **speakers** use to fetch audio from the panel. Auto-detection uses the container's own LAN IP, which is correct on ipvlan (`br0`) or host networking. Set explicitly (e.g. `http://10.1.10.25:3000`) only if local files fail to play. |
| `RESCAN_SCHEDULE` | *(unset)* | Local Music Library only: automatic rescan schedule -- `daily@HH:MM` (e.g. `daily@03:30`) or `weekly@DAY@HH:MM` (e.g. `weekly@sun@04:00`, days `mon`-`sun`), in the container's `TZ`. Blank = no scheduled rescans; a rescan still always runs at container start. |
| `TZ` | *(unset = UTC)* | Timezone the `RESCAN_SCHEDULE` times are interpreted in (IANA name, e.g. `America/Denver`). |

No other configuration needed -- Sonos speakers are auto-discovered on
the local network at startup.

### Extra tabs

The Sonos tab is always present and always first. Setting `TAB2_URL`
(and optionally `TAB2_TITLE`/`TAB2_COLOR`/`TAB2_ICON`) adds a second
tab that embeds that URL in an iframe -- useful for a Hubitat
dashboard, a Home Assistant dashboard, or any other page on your local
network you want reachable from the same wall panel. `TAB3_*`/`TAB4_*`
work the same way for a third and fourth tab. The screensaver
activates over whichever tab is currently open and covers the whole
screen regardless of which tab you're on.

The tab bar is a fixed 4-slot grid -- Sonos plus up to 3 extra tabs --
and every slot always takes up exactly 1/4 of the bar's width, whether
or not it's actually configured. An unconfigured slot (no `_URL` set)
renders as blank, non-interactive space rather than letting Sonos or
the other tabs stretch to fill the gap, so the layout stays consistent
whether you've set up 0, 1, 2, or all 3 extra tabs.

Each tab's `_COLOR` sets the color of its underline in the tab bar --
purely cosmetic, just makes it easier to tell tabs apart at a glance.
`_ICON` is also optional and shows at the start of the tab, before the
title -- either an emoji (e.g. 🏠) or a full image URL both work.

Since embedded pages load in an iframe, sites that explicitly block
being framed (via an `X-Frame-Options` or `Content-Security-Policy`
header) won't display -- this is essentially never an issue for
self-hosted local dashboards like Hubitat or Home Assistant, which
don't set those headers by default.

## Local Music Library (preview)

Sonos's built-in Music Library caps out at roughly **65,000 tracks** --
a hard limit, because the index is stored in the speakers' own limited
memory. If your collection is bigger than that, Sonos simply refuses to
index the rest.

This feature sidesteps the limit entirely by inverting who does the
work: the **panel** (which runs on a real server with real storage)
owns the library, and the speakers just play plain HTTP audio streams
served by the panel. The speakers never index anything, so there is no
track limit anywhere -- 200,000 songs is just a bigger database file on
the server.

### Setup

Mount a folder of music files at `/music` (read-only). On Unraid,
that's the template's **Music Path** field -- click it, browse to your
music share (e.g. `/mnt/user/Media/Music`), done. With docker compose,
uncomment the `/music` volume line in `docker-compose.yml`. No mount =
feature silently disabled; nothing else about the panel changes.

Note that the path must be the **Linux path on the server itself**
(`/mnt/user/Media/Music`), not a Windows-style UNC path
(`\\SERVER\Media\Music`). Those are two views of the same folder --
the UNC path is just how Windows sees it through Samba -- and since the
container runs *on* the server, it reads the disks directly rather than
looping through SMB. UNC paths don't work inside a Linux container at
all.

**If the music lives on a different machine:** the answer still isn't
SMB-in-the-container. Mount the remote share on the Unraid **host**
with the Unassigned Devices plugin (it shows up under
`/mnt/remotes/...`) and point that same single Music Path field at it.
Host handles the mounting; container stays dumb and fast.

`PUBLIC_BASE_URL` usually needs no attention: the panel auto-detects
its own LAN address, which is correct on ipvlan (`br0`, the recommended
Unraid setup) and host networking, and logs what it picked at startup.
It exists as an override for unusual network setups where the speakers
need a different address to reach the panel than the auto-detected one.

Heads-up on trust: anything that can reach the panel on your LAN can
also fetch these streams -- same open-on-the-LAN model as the panel
itself, just now including your music files. The mount is read-only,
so nothing can be modified either way.

### Current status: Phase 3 of 5

This is being built foundation-first, verified on real hardware at each
step:

1. **Streaming -- DONE, hardware-verified:** the `/stream/` endpoint
   serves audio with HTTP Range support (seeking works), correct
   content-types, folder album art (`cover.jpg` etc.), real track
   durations, and queue-based playback with full transport control.
2. **Indexing -- DONE:** the background scanner described below.
3. **Browsing -- DONE:** a "Local Library" source,
   pinned to the top of the Sources list, with Artists / Albums /
   Songs / Composers / Genres / Folders -- presented through the exact
   same browser as the Sonos Music Library. Big indexes split into A-Z
   letter buckets automatically (tune with `LOCAL_BUCKET_THRESHOLD`,
   default 300); every category except Folders has search, and it's
   real substring search against the index rather than Sonos's
   prefix-only trick. Tapping a track inside an album queues the whole
   album and jumps to that track (same behavior as the Sonos library),
   now-playing shows "Local Library - <album>", and Folders shows only
   indexed, Sonos-playable files -- never something that would error
   when tapped. **Artwork is fully resolved at scan time (v0.6.0):**
   a folder image (`cover.jpg` etc.) wins; otherwise the cover embedded
   in the files is extracted once per album folder into
   `<appdata>/artcache` and served from there -- so albums with only
   embedded art get covers everywhere (browse, playlists, playback),
   and browse pages render faster because no filesystem lookups happen
   per row. Art is fully SELF-HEALING as of v0.10.0: every scan
   re-verifies each folder -- a later-added cover image is picked up
   and outranks the extracted one, a deleted cover downgrades cleanly
   to the embedded extraction (or none), a wiped art cache regenerates
   itself, and replacing the cover embedded in the files refreshes the
   cache the moment the retagged files are re-scanned. Browsing got
   smarter at scale too (v0.10.0): a unified Search category queries
   artists, albums, and songs together; Recently Added surfaces the
   newest files first; multi-value tags split properly ("Electronic;
   Ambient" lists under both genres, "Lennon; McCartney" under both
   composers); letter buckets strip leading articles and fold accents
   ("The Beatles" under B, "Exito" under E); and every artist opens
   with an All Songs entry -- artists and genres are directly
   queueable from their menus.
4. **Queue management -- DONE (this release):** an "Up Next" view
   (a QUEUE tab beside SOURCES in the source panel, v0.7.1) showing the
   focused room's group queue with the current track highlighted -- tap a track
   to jump, per-row move up/down and remove, Clear, and Save-as-playlist.
   Every browse row (tracks AND albums, local or Sonos library) gains a
   vertical-ellipsis button opening **Play Now / Play Next / Add to
   Queue** -- Play Now inserts after the current track and jumps,
   preserving the rest of the queue instead of replacing the world.
   Favorites, playlists, and the queue now also refresh live via
   ContentDirectory/Queue events when edited from anywhere (including
   the phone app), and grabbing the group volume slider snapshots
   member ratios first so balance survives a drag to zero. v0.10.0
   added a REPEAT button beside shuffle (off / all / repeat-one,
   riding the same play mode -- so it works for playlists too, since
   they play through the queue), drag-to-reorder in the queue list
   (arrows remain for precision), live refreshes that keep however
   many pages you'd loaded, and rooms shown as disconnected get their
   group icon disabled until they're back. (A separate
   panel-native playlist system was originally planned here, but Sonos
   playlists store local tracks with full metadata since v0.5.2 -- only
   worth building if Sonos-side limits ever bite.)
5. **Transcoding (planned), two flavors:** a transparent
   transcode-on-play path with an on-disk cache, so hi-res files play
   on Sonos without ever modifying the originals -- and a separate
   batch convert-and-replace maintenance tool for permanently
   downsampling originals in place, for collections where hi-res files
   cause problems in other players too.

The `/api/local/*` endpoints are still settling and may change; the
`/stream/` URL format is intended to be permanent.

### The scanner & index (Phase 2)

A background scanner walks the music folder, reads each file's embedded
tags, and builds a SQLite index at `<appdata>/library.db` -- so the
index survives container updates and there is no track-count limit
anywhere. It commits in **batches of 500**, so a first scan of a huge
library becomes browsable/playable while still in progress. Rescans are
**incremental**: files whose modified-time and size are unchanged are
skipped without re-reading, which makes every scan after the first one
fast.

**When scans run:** always once at container start (so the index can't
drift after a reboot), on demand via `POST /api/local/rescan`, and
optionally on a schedule via the `RESCAN_SCHEDULE` variable --
`daily@HH:MM` or `weekly@DAY@HH:MM` (days `mon`-`sun`), evaluated in
the container's `TZ`. There is deliberately no live file-watching:
inotify does not propagate reliably through Unraid's `/mnt/user` fuse
layer, so scheduled + startup + manual scans are the honest design.

**Sonos compatibility filtering:** only files Sonos can actually play
are indexed. The enforced limits are Sonos's published ones -- lossy:
MP3/MP4/M4A/AAC/OGG up to 320 kbps, WMA up to 355 kbps; lossless:
FLAC/ALAC up to 24-bit, AIFF/WAV up to 16-bit, and all lossless capped
at a 48 kHz sample rate (that cap is Sonos's own footnote to the
bit-depth table, and it is exactly what a real S2 speaker rejected
during Phase 1 testing with a hi-res FLAC). Files that don't qualify
are written to **`<appdata>/incompatible-files.txt`** -- full path, one
per line -- and `GET /api/local/incompatible` returns the same list
with the *reason* each file was rejected (e.g. "FLAC 24-bit exceeds
Sonos limit" or "Opus codec is not supported by Sonos"). When a
measurement can't be read from a file, the scanner errs toward
indexing it rather than hiding playable music.

Scan progress streams over the panel's existing WebSocket as
`local:scan` messages (per batch, plus start/finish), and
`GET /api/local/status` shows live scanner state, library counts, the
last scan's summary, and the active schedule.

Known constraints worth knowing up front: Sonos S2 plays FLAC up to
24-bit/48kHz (hi-res 24/96+ files would need a transcoding step --
possible later, not in scope yet), and gapless playback of HTTP-queued
tracks is exactly what Phase 1's hardware test exists to measure. Local
tracks also stream *through the panel*, so unlike Sonos's own library
(where speakers read the SMB share directly), the container needs to be
running for local music to play -- on an always-on server this is
usually academic, but it's a real difference.

## How it's built

```
server/
  index.js       Express app, all HTTP routes, WebSocket broadcast, poll loop
  sonos.js       All Sonos/UPnP logic: discovery, control, browsing, caching
  localLibrary.js  Local Music Library: safe path handling + HTTP audio/art streaming
  localScanner.js  Local Music Library: background scanner, SQLite index, compatibility filter, rescan scheduling
  localBrowse.js   Local Music Library: virtual L: container tree (browse/search/paging) served from the index
  debugLog.js    Lightweight in-memory log buffer (feeds console/docker logs)

public/
  index.html          The app shell
  manifest.json        PWA manifest (enables the Android/iOS home-screen install)
  css/style.css        All styling -- dark theme, amber accent
  icons/                App icon (SVG source + generated PNGs)
  js/
    config.js            Fetches /api/config once at boot (color, screensaver timeout, tabs)
    theme.js              Applies the chosen accent color + derives the screensaver's color-cycle palette from it
    tabs.js               Builds the tab bar + extra iframe tabs, handles tab switching
    app.js              WebSocket client, volume rail routing, fullscreen toggle
    sonosView.js        Room list, now-playing, source browsing, grouping UI
    screensaver.js       Inactivity timer + bounce/rings animation logic
    volumeRail.js        The vertical volume slider component
    progressBar.js       The playback progress bar component
```

No build step -- plain `<script>` tags loaded in order, no bundler, no
frontend npm packages at all.

### How it actually talks to the speakers

Uses the [`sonos`](https://www.npmjs.com/package/sonos) npm package,
which speaks UPnP/SOAP directly to each speaker over the local network
-- no cloud, no Sonos account involved. On startup, discovers every
speaker via SSDP, then merges each speaker's own view of the group
topology (`getAllGroups()`) to build a complete picture, since asking
only one speaker can miss speakers living in a different topology
"zone."

**Caching:** Favorites and Playlists are cached with a
stale-while-revalidate pattern and proactively warmed at startup, so
the first visit to Sources feels instant rather than eating a
multi-second fetch delay. Album art is also prefetched into the
browser's cache in the background per source group, independently, so
one slow/failing group can't block the others from loading.

**Real-time updates:** playback state, volume, and group topology all
push live updates via Sonos's own UPnP eventing (the `sonos` npm
package auto-subscribes once a listener is attached) rather than
relying on polling to notice changes -- a speaker reports a volume
change or a group join the instant it happens, no interval to tune.

Polling still runs underneath this, but as a safety net rather than
the primary mechanism: a slow 15-second background poll catches
anything an event might have missed (the underlying library's
subscription renewal isn't fully self-healing if it fails for an
unusual reason), and any playback/volume/grouping action still
triggers a brief 5-second burst of faster (150ms) polling right after,
scoped to just the room(s) actually involved so it doesn't add load to
speakers that aren't part of the action. Grouping/ungrouping also gets
an immediate optimistic update (the UI reflects the intended change
right away, corrected by the following poll/event if reality differs)
since Sonos's own group-join settling time can genuinely take a few
seconds regardless of how fast anything here polls.

## Contributing

Issues and PRs welcome. This was built for one specific house's setup
(9 rooms, mixed S1/S2 hardware excluding the S1 device, Plex/SoundCloud
playlists, Pandora/iHeartRadio favorites) -- if something doesn't work
with a different Sonos setup, please open an issue with your topology
details.

## License

MIT
