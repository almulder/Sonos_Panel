// config.js
//
// Fetches app-wide config from the server once at boot (accent color,
// screensaver timeout, extra tabs) and caches it. Other modules
// (theme.js, tabs.js, screensaver.js) read from here rather than each
// making their own request -- one network round-trip instead of several,
// and one place to fall back to sane defaults if the request fails.

const AppConfig = (() => {
  const DEFAULTS = {
    color: '#e8a33d',
    screensaverTimeoutMs: 600000,
    tabs: []
  };

  let cached = null;

  async function load() {
    if (cached) return cached;
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      // Quiet attribution + version in the lower-left corner.
      const buildTag = document.getElementById('buildTag');
      if (buildTag && data.version) buildTag.textContent = `Created by almulder \u00b7 v${data.version}`;
      cached = {
        color: typeof data.color === 'string' ? data.color : DEFAULTS.color,
        screensaverTimeoutMs: Number(data.screensaverTimeoutMs) || DEFAULTS.screensaverTimeoutMs,
        tabs: Array.isArray(data.tabs) ? data.tabs : DEFAULTS.tabs
      };
    } catch (err) {
      // Config fetch failing shouldn't break the app -- fall back to
      // sane defaults and carry on with just the Sonos tab.
      cached = { ...DEFAULTS };
    }
    return cached;
  }

  return { load };
})();
