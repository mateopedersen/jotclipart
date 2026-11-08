import { createSurpriseWarmer } from '../lib/surprise-navigation';
import {
  pickCute,
  validCuteIndex,
  SURPRISE_INDEX_VERSION,
  type CutePick,
} from '../lib/cute-discovery';
const key = 'ultraclipart-surprise-recent-v2';
export function initCuteSurprise() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-surprise-art]')];
  if (!links.length || document.documentElement.dataset.surpriseNavigation === 'ready') return;
  document.documentElement.dataset.surpriseNavigation = 'ready';
  let departing = false,
    lifecycle = 0,
    indexController: AbortController | undefined,
    preparationTimer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !departing;
  const warm = createSurpriseWarmer(active);
  let pool: CutePick[] = [];
  try {
    pool = validCuteIndex(
      JSON.parse(links.find((link) => link.dataset.surpriseArt)?.dataset.surpriseArt || '[]'),
    );
  } catch {
    /* Keep the genuine fallback href. */
  }
  let recent: string[] = [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || '[]');
    if (Array.isArray(saved))
      recent = saved.filter((x) => typeof x === 'string' && /^[a-z0-9-]+$/.test(x)).slice(0, 24);
  } catch {
    /* Storage is optional. */
  }
  let loading: Promise<boolean> | undefined;
  const load = () => {
    if (!active()) return Promise.resolve(false);
    return (loading ??= (async () => {
      const generation = lifecycle,
        controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), 3000);
      indexController = controller;
      try {
        const source = links.find((link) => link.dataset.surpriseSource)?.dataset.surpriseSource;
        if (!source) return false;
        const response = await fetch(source, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) return false;
        const data = await response.json();
        if (
          !active() ||
          generation !== lifecycle ||
          controller.signal.aborted ||
          data.version !== SURPRISE_INDEX_VERSION
        )
          return false;
        const loaded = validCuteIndex(data.items);
        if (!loaded.length) return false;
        pool = loaded;
        return true;
      } catch {
        /* Offline visits keep the verified embedded pool. */
        return false;
      } finally {
        clearTimeout(timeout);
        if (indexController === controller) indexController = undefined;
      }
    })());
  };
  const current = location.pathname.match(/^\/art\/([a-z0-9-]+)\/$/)?.[1] || '';
  let chosen = links[0].pathname.match(/^\/art\/([a-z0-9-]+)\/$/)?.[1] || '';
  let committed = false,
    prepared = false;
  const random = () => {
    try {
      return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
    } catch {
      return Math.random();
    }
  };
  const choose = () => {
    const next = pickCute(pool, recent, current, random);
    if (next) chosen = next.id;
    for (const link of links) link.href = `/art/${chosen}/`;
  };
  const prepare = () => {
    if (!active()) return;
    if (committed) {
      committed = false;
      choose();
    }
    prepared = true;
    if (chosen) warm(`/art/${chosen}/`);
    void load();
  };
  const remember = () => {
    if (!chosen) return;
    recent = [chosen, ...recent.filter((x) => x !== chosen)].slice(0, 24);
    try {
      sessionStorage.setItem(key, JSON.stringify(recent));
    } catch {
      /* In-memory state still works. */
    }
  };
  for (const link of links) {
    link.addEventListener('pointerenter', prepare);
    link.addEventListener('focus', prepare);
    link.addEventListener('pointerdown', prepare, { passive: true });
    link.addEventListener('click', () => {
      if (committed) {
        committed = false;
        choose();
      }
      if (!chosen) choose();
      prepared = true;
      committed = true;
      remember();
      // Native navigation starts now; no index, document or image await.
    });
    link.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        prepared = true;
        committed = true;
        remember();
      }
    });
  }
  choose();
  const prepareAfterPageLoad = () => {
    if (!active()) return;
    const generation = lifecycle;
    preparationTimer = setTimeout(
      () =>
        void load().then((loaded) => {
          if (!loaded || !active() || generation !== lifecycle || prepared || committed) return;
          choose();
          if (location.pathname === '/') prepare();
        }),
      250,
    );
  };
  const suspend = () => {
    departing = true;
    lifecycle++;
    clearTimeout(preparationTimer);
    indexController?.abort();
    indexController = undefined;
    loading = undefined;
    warm.cancel();
  };
  // Stop optional work as soon as a genuine same-tab anchor starts leaving.
  // pagehide alone is too late while the replacement document is still loading.
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self'))
        return;
      let url: URL;
      try {
        url = new URL(link.href, location.href);
      } catch {
        return;
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.href === location.href ||
        (url.origin === location.origin &&
          url.pathname === location.pathname &&
          url.search === location.search)
      )
        return;
      suspend();
    },
    { passive: true },
  );
  window.addEventListener('pagehide', suspend);
  // Optional preparation must not contend with the page's initial modules,
  // fonts and eager artwork. Real pointer/focus intent remains immediate.
  if (document.readyState === 'complete') prepareAfterPageLoad();
  else window.addEventListener('load', prepareAfterPageLoad, { once: true });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    departing = false;
    committed = false;
    prepared = false;
    choose();
  });
}
