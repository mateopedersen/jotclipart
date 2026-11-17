import { adoptCatalogSnapshot } from '../lib/catalog-snapshot-client';
import { defaults } from '../lib/search';
import { SearchRepository } from '../lib/search-remote';
import type { SearchCard } from '../lib/search-index';
import { renderCard } from './search-card';

type LatestSeed = { version: string; total: number; items: SearchCard[] };

const root = document.querySelector<HTMLElement>('[data-new-artwork]');
if (root) {
  const gallery = root.querySelector<HTMLElement>('.gallery')!;
  const more = root.querySelector<HTMLButtonElement>('[data-new-more]')!;
  const refreshButton = root.querySelector<HTMLButtonElement>('[data-new-refresh]')!;
  const status = root.querySelector<HTMLElement>('[data-new-status]')!;
  const seed = JSON.parse(root.querySelector('[data-new-seed]')!.textContent!) as LatestSeed;
  let repository = new SearchRepository();
  repository.seed(seed.version, seed.items);
  let version = seed.version,
    page = 0,
    total = seed.total,
    busy = false;
  let controller: AbortController | undefined;
  more.hidden = gallery.children.length >= total;
  refreshButton.hidden = false;
  root.dataset.ready = 'true';
  const state = (number: number) => ({
    ...defaults,
    type: 'artwork',
    sort: 'newest',
    size: 32,
    page: number,
  });
  function describe() {
    status.textContent = `Showing ${gallery.children.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} illustrations.`;
    more.hidden = gallery.children.length >= total;
  }
  async function refresh(expectedVersion: string, signal: AbortSignal) {
    const response = await fetch('/new/', { cache: 'no-store', signal });
    if (!response.ok) throw Error('Latest clipart request failed');
    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    const latest = JSON.parse(
      document.querySelector('[data-new-seed]')!.textContent!,
    ) as LatestSeed;
    if (latest.version !== expectedVersion) throw Error('Latest clipart snapshot is out of date');
    gallery.replaceChildren(...latest.items.map(renderCard));
    repository = new SearchRepository();
    repository.seed(latest.version, latest.items);
    version = latest.version;
    total = latest.total;
    page = 0;
  }
  async function update(append: boolean, explicit = false) {
    if (busy || (document.hidden && !explicit)) return;
    busy = true;
    more.disabled = refreshButton.disabled = true;
    controller = new AbortController();
    const timeout = window.setTimeout(() => controller?.abort(), 15000);
    try {
      if (!append) {
        const candidate = new SearchRepository();
        const manifest = await candidate.manifest(controller.signal);
        if (manifest.version === version) {
          if (explicit) describe();
          return;
        }
        await refresh(manifest.version, controller.signal);
      } else {
        const existing = new Set(
          [...gallery.children].map((node) => (node as HTMLElement).dataset.id),
        );
        // The mixed seed can already contain all of the first chronological page.
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await repository.search(state(page + 1), controller.signal);
          if (result.manifest.version !== version) {
            await refresh(result.manifest.version, controller.signal);
            break;
          }
          const unseen = result.items.filter((item) => !existing.has(item.id));
          gallery.append(...unseen.map(renderCard));
          page = result.page;
          total = result.total;
          if (unseen.length || result.page >= result.pages) break;
        }
      }
      describe();
      root!.dataset.catalogVersion = version;
      adoptCatalogSnapshot(version);
    } catch {
      status.textContent =
        'The latest clipart could not be refreshed. Your current results are still available. Try Refresh latest.';
    } finally {
      clearTimeout(timeout);
      busy = false;
      more.disabled = refreshButton.disabled = false;
    }
  }
  more.addEventListener('click', () => void update(true, true));
  refreshButton.addEventListener('click', () => void update(false, true));
  for (const event of ['focus', 'pageshow'])
    window.addEventListener(event, () => void update(false));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void update(false);
  });
  window.addEventListener('pagehide', () => controller?.abort());
  window.setInterval(() => void update(false), 30000);
  void update(false);
}
