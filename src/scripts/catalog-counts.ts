import {pageCatalogSnapshot,catalogCountsMatchPage} from '../lib/catalog-snapshot-client';
import { catalogCountValue, formatCatalogCount, isCatalogCounts } from '../lib/catalog-counts';
import type { CatalogCountKind, CatalogCountUnit } from '../lib/catalog-counts';

const elements = [...document.querySelectorAll<HTMLElement>('[data-catalog-count]')];
if (elements.length) {
  let pending = false;
  let refreshQueued = false;
  let lastRequest = 0;
  let controller: AbortController | undefined;

  async function refresh() {
    if (pending || document.hidden || Date.now() - lastRequest < 5_000) return;
    pending = true;
    lastRequest = Date.now();
    controller = new AbortController();
    const active = controller;
    const timeout = window.setTimeout(() => active.abort(), 8_000);
    try {
      const expectedRoot = pageCatalogSnapshot();
      const keys = [...new Set(elements.filter(e => e.dataset.catalogCount === 'topic')
        .map(e => e.dataset.catalogKey).filter((key): key is string => !!key))];
      const groups = keys.length ? Array.from({length: Math.ceil(keys.length / 64)}, (_, i) => keys.slice(i * 64, (i + 1) * 64)) : [[]];
      const partial: { counts: import('../lib/catalog-counts').CatalogCounts; root: string | null }[] = [];
      let next = 0;
      await Promise.all(Array.from({length: Math.min(3, groups.length)}, async () => {
        while (next < groups.length) {
          const group = groups[next++];
          const response = await fetch('/catalog-stats.json?scope=visible' + group.map(key => '&topic=' + encodeURIComponent(key)).join(''), {cache:'no-store', credentials:'same-origin', signal:active.signal});
          if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw Error('Counts unavailable');
          const data: unknown = await response.json(), root = response.headers.get('x-uc-snapshot');
          if (!isCatalogCounts(data) || group.some(key => !Object.hasOwn(data.topics, key)) || !catalogCountsMatchPage(expectedRoot, root)) throw Error('Count snapshot differs');
          partial.push({counts:data, root});
        }
      }));
      const first = partial[0];
      if (!first || active.signal.aborted || pageCatalogSnapshot() !== expectedRoot || partial.some(p => p.root !== first.root || p.counts.version !== first.counts.version)) return;
      const counts = {...first.counts, topics:Object.assign({}, ...partial.map(p => p.counts.topics))};
      let changed = false;
      for (const element of elements) {
        if (!element.isConnected || element.dataset.catalogVersion === counts.version) continue;
        const kind = element.dataset.catalogCount as CatalogCountKind;
        const value = catalogCountValue(counts, kind, element.dataset.catalogKey);
        const unit = element.dataset.catalogUnit as CatalogCountUnit | undefined;
        const text = formatCatalogCount(value, unit);
        if (element.textContent !== text) {
          element.textContent = text;
          changed = true;
        }
        element.dataset.catalogVersion = counts.version;
        // Keep the directory's count-based sorting aligned with its visible labels.
        const subject = element.closest<HTMLElement>('.discovery-subject');
        if (kind === 'topic' && subject) subject.dataset.count = String(value);
      }
      if (changed)
        document.dispatchEvent(
          new CustomEvent('ultraclipart:catalog-counts', {
            detail: { version: counts.version },
          }),
        );
    } catch {
      // The complete build-time counts remain usable offline and without JavaScript.
    } finally {
      window.clearTimeout(timeout);
      if (controller === active) controller = undefined;
      pending = false;
      if (refreshQueued) {
        refreshQueued = false;
        lastRequest = 0;
        void refresh();
      }
    }
  }

  void refresh();
  // Recheck visible pages after a publication; hidden tabs send no polling requests.
  window.setInterval(() => void refresh(), 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  window.addEventListener('focus', () => void refresh());
  window.addEventListener('pageshow', () => void refresh());
  document.addEventListener('ultraclipart:catalog-snapshot', () => {
    controller?.abort();
    lastRequest = 0;
    if (pending) refreshQueued = true;
    else void refresh();
  });
  window.addEventListener('pagehide', () => controller?.abort());
}
