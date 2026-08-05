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

No other configuration needed -- Sonos speakers are auto-discovered on
the local network at startup.

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

**Polling:** room state polls every 2 seconds normally; any
volume/grouping action triggers a 5-second burst of faster (500ms)
polling right after, so the room list visibly catches up quickly
without polling speakers aggressively all the time (which risks
overloading the hardware on some setups).

## Contributing

Issues and PRs welcome. This was built for one specific house's setup
(9 rooms, mixed S1/S2 hardware excluding the S1 device, Plex/SoundCloud
playlists, Pandora/iHeartRadio favorites) -- if something doesn't work
with a different Sonos setup, please open an issue with your topology
details.

## License

MIT
