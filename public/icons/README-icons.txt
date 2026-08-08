SOURCE ICON FILES -- naming reference
======================================

All icons live in this folder (public/icons/) as PNG files. To add or
replace an icon, just save a PNG with the EXACT filename listed below
(lowercase, no spaces/punctuation) into this folder -- no code changes
needed. Recommended size: 128x128, transparent background.

If a service's icon file is missing, the app automatically falls back
to default.png. Nothing breaks -- it just shows the generic icon until
you add the real one.

STATUS KEY: [x] = icon already included   [ ] = needs to be added

Special files (not a streaming service):
[x] default.png            -- fallback icon used when a service's icon is missing
[x] source-playlist.png    -- used for the "Playlists" category itself
[x] source-linein.png      -- generic Line-In category icon, and the
                               fallback used by any Line-In device name
                               below that doesn't match a specific icon
[x] app-icon.png           -- shared icon for the Sonos tab, the app's
                               browser favicon, and the Docker/Unraid
                               template icon (all three intentionally
                               use this same file)
[x] icon-192.png           -- PWA manifest icon, 192x192 (same design
                               as app-icon.png, resized -- required by
                               the manifest spec as its own file)
[x] icon-512.png           -- PWA manifest icon, 512x512 (same design
                               as app-icon.png)
[x] sleep-timer.png        -- sleep timer icon (fullscreen now-playing view)
[x] eq-settings.png        -- per-room EQ/settings icon (room list)

Line-In device icons (shown next to the device name wherever it
appears -- Now Playing artist line, and the Sources browsing panel):
[x] linein-airplay.png           -- "Airplay Device"
[x] linein-audiocomponent.png    -- "Audio Component"
[x] linein-cdplayer.png          -- "CD Player"
[x] linein-computer.png          -- "Computer"
[x] linein-hometheater.png       -- "Home Theater"
[x] linein-maccomputer.png       -- "Mac Computer"
[x] linein-portableplayer.png    -- "Portable Player"
[x] linein-receiver.png          -- "Receiver"
[x] linein-satellitereceiver.png -- "Satellite Receiver"
[x] linein-turntable.png         -- "Turntable"
Falls back to source-linein.png if a Line-In device reports a name
that doesn't match any of the above.

All of the [x] icons above marked as new are simple placeholder
line-art generated programmatically, not final artwork -- replace any
of them by saving a PNG with the exact same filename into this folder.

Streaming / audio services (your requested list):
[ ] 7digital.png              -- 7digital
[ ] amazonmusic.png           -- Amazon Music
[ ] anghami.png               -- Anghami
[x] applemusic.png            -- Apple Music
[x] audible.png               -- Audible
[ ] audiobookscom.png         -- Audiobooks.com
[x] bandcamp.png              -- Bandcamp
[ ] bbcsounds.png             -- BBC Sounds
[ ] calm.png                  -- Calm
[ ] cbclisten.png             -- CBC Listen
[ ] classicalarchives.png     -- Classical Archives
[ ] convoy.png                -- Convoy
[ ] deephouseibiza.png        -- Deep House Ibiza
[x] deezer.png                -- Deezer
[ ] endel.png                 -- Endel
[ ] fitradio.png               -- FitRadio
[ ] focusatwill.png           -- Focus At Will
[ ] gaana.png                 -- Gaana
[ ] globalplayer.png          -- Global Player
[ ] hoopladigital.png         -- Hoopla Digital
[x] iheartradio.png           -- iHeartRadio
[ ] idagio.png                -- Idagio
[ ] jiosaavn.png              -- JioSaavn
[x] lastfm.png                -- Last.fm
[ ] liveone.png                -- LiveOne
[ ] livephish.png             -- LivePhish
[x] mixcloud.png              -- Mixcloud
[ ] moodmedia.png             -- Mood Media
[ ] npr.png                   -- National Public Radio (NPR)
[x] netflix.png               -- Netflix (via TV setup)
[ ] ntsradio.png              -- NTS Radio
[ ] nugsnet.png               -- Nugs.net
[ ] openaudio.png             -- Open Audio
[x] pandora.png               -- Pandora
[x] plex.png                  -- Plex
[x] pocketcasts.png           -- Pocket Casts
[ ] podbean.png                -- Podbean
[ ] qobuz.png                 -- Qobuz
[ ] radicalfm.png             -- Radical.FM
[ ] radionet.png              -- Radio.net
[ ] radioplayer.png           -- Radioplayer
[ ] rtveaudio.png             -- RTVE Audio
[ ] saavn.png                  -- Saavn
[x] soundcloud.png            -- Soundcloud
[ ] soundmachine.png          -- Soundmachine
[x] spotify.png               -- Spotify
[ ] stitcher.png              -- Stitcher
[ ] sybel.png                  -- Sybel
[ ] teleformula.png           -- TeleFormula
[x] tidal.png                 -- Tidal
[ ] tuneinradio.png           -- TuneIn Radio
[ ] wynkmusic.png             -- Wynk Music
[x] youtubemusic.png          -- YouTube Music

Notes on the [x] ones:
- These came from Simple Icons (simpleicons.org), a free CC0-licensed
  icon set, converted from SVG to colored PNG.
- Colors used are best-effort brand-color approximations, not
  independently verified against each brand's current style guide --
  if any look off, just drop in a replacement PNG with the same
  filename.

Notes on the [ ] ones:
- These simply don't exist in the icon set used to build the [x] ones.
  As you use each service and want its real icon, save a PNG using the
  filename above (matching exactly, lowercase) into this folder, and it
  will start showing up automatically -- no code changes needed.
