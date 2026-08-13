# Debian-based "slim" rather than Alpine -- avoids any potential
# musl-libc compatibility issues with native dependencies in the
# package tree, at the cost of a somewhat larger image. Worth it for a
# home-server deployment where reliability matters more than a few
# extra MB.
FROM node:22-slim

# tzdata so the TZ env actually works -- the Local Music Library's
# scheduled rescans (RESCAN_SCHEDULE) are evaluated in local time, and
# without zoneinfo files "daily@03:30" would silently mean 03:30 UTC.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (separately from copying the rest of the
# source) so Docker can cache this layer -- rebuilds after a code-only
# change don't need to re-run npm install.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server/ ./server/
COPY public/ ./public/
COPY data/ ./data/

ENV PORT=3000
# Accent color (hex) used throughout the UI and the idle screensaver's
# color-cycle animation. Override to customize -- see README.md.
ENV THEME_COLOR="#e8a33d"
# Seconds of no touch/click before the screensaver activates.
ENV SCREENSAVER_TIMEOUT_SECONDS=600
# Up to three extra tabs, each embedding another local dashboard
# (Hubitat, Home Assistant, etc.) in an iframe alongside the Sonos tab.
# A tab only appears if its _URL is set -- _TITLE, _COLOR, and _ICON
# are all optional.
ENV TAB2_TITLE=""
ENV TAB2_COLOR=""
ENV TAB2_ICON=""
ENV TAB2_URL=""
ENV TAB3_TITLE=""
ENV TAB3_COLOR=""
ENV TAB3_ICON=""
ENV TAB3_URL=""
ENV TAB4_TITLE=""
ENV TAB4_COLOR=""
ENV TAB4_ICON=""
ENV TAB4_URL=""
# Where config.json (the optional Line-In room override) lives.
# Defaults to ./data inside the image, but should be volume-mounted to
# a host path (see docker-compose.yml / the Unraid template) so it
# survives container recreation/updates rather than resetting.
ENV DATA_DIR=/app/data
# Local Music Library (optional): MUSIC_DIR is where the container
# expects the music volume-mount (fixed at /music by the template /
# compose file -- override only for local development). PUBLIC_BASE_URL
# is the address the SPEAKERS fetch audio from; blank = auto-detect the
# container's LAN IP, which is correct on ipvlan/host networking.
ENV MUSIC_DIR=/music
ENV PUBLIC_BASE_URL=""
# Scheduled library rescans: "daily@HH:MM" or "weekly@DAY@HH:MM"
# (days mon-sun), evaluated in TZ. Blank = rescan only at container
# start (which always happens when a Music Path is mounted).
ENV RESCAN_SCHEDULE=""
EXPOSE 3000

CMD ["node", "server/index.js"]
