// tabs.js
//
// Builds the top tab bar as a fixed 4-slot grid: Sonos always occupies
// the first slot, and up to 3 extra tabs (from config) fill the rest.
// Each slot always takes exactly 1/4 of the bar's width, whether or not
// it's actually populated -- an unconfigured slot renders as blank,
// non-interactive space rather than letting Sonos (or other tabs) grow
// to fill the gap. Switching tabs toggles which .view section has
// .is-active, matching the pattern index.html already sets up for the
// Sonos view.
//
// Iframes are lazy: the src attribute isn't set until a tab is opened
// for the first time, so tabs you never visit never load their target
// site. Once loaded, the iframe is left in place (not torn down) so
// switching back to it doesn't reload/reset that page's state.

const Tabs = (() => {
  const TOTAL_SLOTS = 4;

  const tabBarEl = document.getElementById('tabBar');
  const contentEl = document.getElementById('content');

  // Real hex color per tab id -- used by the screensaver to recolor
  // itself to match whichever tab is active when it kicks in. Keyed
  // separately from the --tab-color CSS custom property (which can
  // hold a var() reference like "var(--amber)" for Sonos, not usable
  // directly in the hex math the screensaver's color-cycle needs).
  const colorMap = {};
  let activeId = 'sonos';

  function isImageUrl(icon) {
    return /^(https?:)?\/\//.test(icon) || icon.startsWith('data:') || /\.(png|jpe?g|gif|svg|webp)(\?.*)?$/i.test(icon);
  }

  function makeTabButton({ id, title, color, icon }) {
    const btn = document.createElement('button');
    btn.className = 'tabbar__btn';
    btn.dataset.viewId = id;
    btn.style.setProperty('--tab-color', color);

    if (icon) {
      if (isImageUrl(icon)) {
        const img = document.createElement('img');
        img.className = 'tabbar__icon tabbar__icon--img';
        img.src = icon;
        img.alt = '';
        btn.appendChild(img);
      } else {
        const span = document.createElement('span');
        span.className = 'tabbar__icon';
        span.textContent = icon;
        btn.appendChild(span);
      }
    }

    const label = document.createElement('span');
    label.className = 'tabbar__label';
    label.textContent = title;
    btn.appendChild(label);

    btn.addEventListener('click', () => activate(id));
    return btn;
  }

  // Reserves a slot's width without showing anything or being
  // clickable -- keeps the 4-way split exact even when a tab isn't
  // configured.
  function makeEmptySlot() {
    const el = document.createElement('div');
    el.className = 'tabbar__btn tabbar__btn--empty';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function makeIframeView({ id, url }) {
    const section = document.createElement('section');
    section.className = 'view view--iframe';
    section.id = `view-${id}`;
    section.setAttribute('aria-hidden', 'true');

    const iframe = document.createElement('iframe');
    iframe.className = 'view--iframe__frame';
    iframe.dataset.src = url;
    iframe.setAttribute('title', id);
    // Reasonably permissive sandbox -- these are trusted local-network
    // dashboards (Hubitat, Home Assistant, etc.), not arbitrary
    // third-party sites, so scripts/forms/same-origin are all expected
    // to be needed for the embedded app to actually function.
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'
    );

    section.appendChild(iframe);
    return section;
  }

  function activate(id) {
    activeId = id;
    document.querySelectorAll('.view').forEach((el) => {
      const isTarget = el.id === `view-${id}`;
      el.classList.toggle('is-active', isTarget);
      el.setAttribute('aria-hidden', String(!isTarget));
    });
    document.querySelectorAll('.tabbar__btn').forEach((el) => {
      el.classList.toggle('is-active', el.dataset.viewId === id);
    });

    // Lazy-load: only assign the iframe's real src the first time its
    // tab is opened.
    const view = document.getElementById(`view-${id}`);
    if (view) {
      const iframe = view.querySelector('iframe[data-src]');
      if (iframe) {
        iframe.src = iframe.dataset.src;
        iframe.removeAttribute('data-src');
      }
    }
  }

  function init(tabs, sonosColor) {
    if (!tabBarEl) return;

    colorMap.sonos = sonosColor;

    // Slot 1 is always Sonos -- it's the pre-built #view-sonos section
    // already in index.html.
    tabBarEl.appendChild(makeTabButton({
      id: 'sonos',
      title: 'Sonos',
      color: 'var(--amber)',
      icon: 'icons/tab-icon-sonos.svg'
    }));

    // Slots 2-4: fill with configured tabs, pad the rest with blank
    // reserved slots so the grid always has exactly 4 equal quarters.
    for (let i = 0; i < TOTAL_SLOTS - 1; i += 1) {
      const tab = tabs[i];
      if (tab) {
        colorMap[tab.id] = tab.color;
        tabBarEl.appendChild(makeTabButton(tab));
        contentEl.appendChild(makeIframeView(tab));
      } else {
        tabBarEl.appendChild(makeEmptySlot());
      }
    }

    activate('sonos');
  }

  return {
    init,
    getActiveColor: () => colorMap[activeId] || colorMap.sonos
  };
})();
