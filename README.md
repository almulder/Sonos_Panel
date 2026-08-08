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

1. **Docker tab → Add Container**, or use `unraid-template.xml` from
   this repo directly (Docker tab → Add Container → Template →
   select it, or place the file in
   `/boot/config/plugins/dockerMan/templates-user/`)
2. Confirm **Network Type is set to Host** -- same SSDP requirement as
   above, this is not optional
3. Apply, then open `http://<unraid-ip>:3000`

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

## How it's built

```
server/
  index.js       Express app, all HTTP routes, WebSocket broadcast, poll loop
  sonos.js       All Sonos/UPnP logic: discovery, control, browsing, caching
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

**Polling:** room state polls every 2 seconds normally. Any playback,
volume, or grouping action triggers a 5-second burst of faster (150ms)
polling right after, so changes visibly catch up quickly. The burst is
scoped to just the room(s) actually involved (or the whole bonded
group, for a group-volume/group-mute action) rather than re-polling
every speaker at the faster rate -- a single-room volume tweak on a
9-room system only re-queries that one device, regardless of the
faster interval, which is what makes a short interval safe rather than
risking overloading the hardware. Grouping/ungrouping is the one
exception: since it changes the topology itself (which can affect how
other rooms display their group label), that burst does a full,
untargeted poll instead.

## Contributing

Issues and PRs welcome. This was built for one specific house's setup
(9 rooms, mixed S1/S2 hardware excluding the S1 device, Plex/SoundCloud
playlists, Pandora/iHeartRadio favorites) -- if something doesn't work
with a different Sonos setup, please open an issue with your topology
details.

## License

MIT
