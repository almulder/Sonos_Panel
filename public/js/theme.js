// theme.js
//
// Applies a chosen accent color (hex) in two places. Call Theme.apply(hex)
// once app.js has loaded config from config.js -- this module doesn't
// fetch anything itself.
//   1. Overrides the --amber / --amber-dim CSS custom properties on :root.
//      The rest of style.css already builds --accent/--accent-dim from
//      these (`--accent: var(--amber);`), so every button, highlight, and
//      border in the app picks up the new color automatically -- no other
//      CSS changes needed.
//   2. Regenerates the screensaver's idle "rings" color-cycle animation.
//      The original was six hand-picked warm/cool hex stops; this derives
//      an equivalent six-stop sweep (three variations near the chosen
//      color, three near its complement) from whatever color is set, so
//      the ambient screensaver matches instead of staying hardcoded to
//      amber.
//
// Falls back to the original amber (#e8a33d) if an invalid/missing value
// is passed in.

const Theme = (() => {
  const DEFAULT_COLOR = '#e8a33d';

  function hexToHsl(hex) {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60;
    }
    return { h, s: s * 100, l: l * 100 };
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60) { [r, g, b] = [c, x, 0]; }
    else if (h < 120) { [r, g, b] = [x, c, 0]; }
    else if (h < 180) { [r, g, b] = [0, c, x]; }
    else if (h < 240) { [r, g, b] = [0, x, c]; }
    else if (h < 300) { [r, g, b] = [x, 0, c]; }
    else { [r, g, b] = [c, 0, x]; }
    const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function isValidHex(hex) {
    return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex);
  }

  function applyAccent(hex) {
    const { h, s, l } = hexToHsl(hex);
    document.documentElement.style.setProperty('--amber', hex);
    // Dimmer variant for hover/inactive states -- same hue, pulled back on
    // saturation and lightness, matching the relationship the original
    // hand-picked --amber-dim had to --amber.
    document.documentElement.style.setProperty('--amber-dim', hslToHex(h, s * 0.6, l * 0.5));
  }

  function applyScreensaverCycle(hex) {
    const { h, s, l } = hexToHsl(hex);
    const warm = [
      hslToHex(h - 15, s, l * 0.55),
      hslToHex(h, s, l * 0.8),
      hslToHex(h + 18, s * 0.9, Math.min(l * 1.15, 70))
    ];
    const cool = [
      hslToHex(h + 165, s * 0.75, l * 0.55),
      hslToHex(h + 180, s * 0.8, l * 0.7),
      hslToHex(h + 195, s * 0.6, l * 0.4)
    ];
    const stops = [...warm, ...cool];

    const css = `@keyframes screensaver-colorcycle {
      0%, 14% { stroke: ${stops[0]}; }
      17%, 31% { stroke: ${stops[1]}; }
      34%, 48% { stroke: ${stops[2]}; }
      51%, 65% { stroke: ${stops[3]}; }
      68%, 82% { stroke: ${stops[4]}; }
      85%, 99% { stroke: ${stops[5]}; }
      100% { stroke: ${stops[0]}; }
    }`;

    let styleEl = document.getElementById('themeColorCycle');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'themeColorCycle';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
  }

  function apply(hex) {
    const color = isValidHex(hex) ? hex : DEFAULT_COLOR;
    applyAccent(color);
    applyScreensaverCycle(color);
  }

  return { apply };
})();
