// tabs.js
//
// Builds the top tab bar. The Sonos tab always exists (it's the
// pre-built #view-sonos section already in index.html) -- this module
// adds a button for it, plus one button + one lazily-loaded iframe view
// per extra tab from config (Hubitat, Home Assistant, or any other local
// dashboard). Switching tabs just toggles which .view section has
// .is-active, matching the pattern index.html already sets up for the
// Sonos view.
//
// Iframes are lazy: the src attribute isn't set until a tab is opened
// for the first time, so tabs you never visit never load their target
// site. Once loaded, the iframe is left in place (not torn down) so
// switching back to it doesn't reload/reset that page's state.

const Tabs = (() => {
  const tabBarEl = document.getElementById('tabBar');
  const contentEl = document.getElementById('content');

  function makeTabButton({ id, title, color }) {
    const btn = document.createElement('button');
    btn.className = 'tabbar__btn';
    btn.dataset.viewId = id;
    btn.textContent = title;
    btn.style.setProperty('--tab-color', color);
    btn.addEventListener('click', () => activate(id));
    return btn;
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

  function init(tabs) {
    if (!tabBarEl) return;

    // Sonos tab always comes first and always exists in the DOM already.
    tabBarEl.appendChild(makeTabButton({ id: 'sonos', title: 'Sonos', color: 'var(--amber)' }));

    tabs.forEach((tab) => {
      tabBarEl.appendChild(makeTabButton(tab));
      contentEl.appendChild(makeIframeView(tab));
    });

    // Hide the tab bar entirely if there's nothing to switch between --
    // no point showing a single "Sonos" tab with nothing else to tap.
    if (tabs.length === 0) {
      tabBarEl.classList.add('is-hidden');
    }

    activate('sonos');
  }

  return { init };
})();
