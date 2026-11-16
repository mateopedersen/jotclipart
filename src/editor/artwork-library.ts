import { displayTitle, displayCatalogTitle } from '../lib/display-title.ts';
import { beginArtworkLibraryStartup } from './library-startup';
import { rasterCatalog, featuredRasterCatalog, type RasterAsset } from './raster';
import { lookupTopicAssets, pinRasterSnapshot, unpinRasterSnapshot } from './studio-sources';
import { SearchRepository } from '../lib/search-remote';
import { defaults } from '../lib/search';
import type { SnapshotTransport } from '../lib/snapshot-studio';
interface LibraryAsset extends RasterAsset {
  title: string;
  alt?: string;
  topic: string;
  style: string;
  thumb: string;
  thumbSrcSet?: string;
  featured?: boolean;
  createdAt?: string;
  monochrome?: boolean;
}
export async function mountArtworkLibrary(root: HTMLElement, add: (id: string) => Promise<void>) {
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const search = q<HTMLInputElement>('[data-artwork-search]');
  const style = q<HTMLSelectElement>('[data-artwork-style]');
  const topic = q<HTMLSelectElement>('[data-artwork-topic]');
  const sort = q<HTMLSelectElement>('[data-artwork-sort]');
  const list = q<HTMLElement>('[data-artwork-grid]');
  const count = q<HTMLElement>('[data-artwork-count]');
  const next = q<HTMLButtonElement>('[data-artwork-more]');
  const previous = q<HTMLButtonElement>('[data-artwork-previous]');
  const position = q<HTMLElement>('[data-artwork-page]');
  const startup = beginArtworkLibraryStartup(root);
  const initial = await featuredRasterCatalog().catch((error) => {
    startup.fail();
    throw error;
  });
  const remote = !!initial.transport,
    repository = new SearchRepository();
  let remoteRequest: AbortController | undefined,
    remoteSequence = 0;
  let assets = initial.items as LibraryAsset[];
  let fullAssets: LibraryAsset[] | undefined;
  let loadedKey = 'featured';
  let filterRevision = 0;
  const ensureFull = async (revision: number, subject = topic.value) => {
    if (remote) return;
    const key = fullAssets ? '*' : subject || '*';
    if (loadedKey === key) {
      list.removeAttribute('aria-busy');
      return;
    }
    count.textContent = subject ? 'Loading this subject…' : 'Loading the full artwork library…';
    list.setAttribute('aria-busy', 'true');
    try {
      const found = (fullAssets ??
        (await (subject ? lookupTopicAssets(subject) : rasterCatalog()))) as LibraryAsset[];
      if (key === '*') fullAssets = found;
      if (revision !== filterRevision) return;
      assets = found;
      loadedKey = key;
    } finally {
      if (revision === filterRevision) list.removeAttribute('aria-busy');
    }
  };
  let browseMode: 'categories' | 'topics' | 'artwork' = initial.categories?.length
    ? 'categories'
    : 'artwork';
  let categoryId = '';
  const directory = initial.categories || [];
  let page = 1,
    scope = 'featured',
    busy = false;
  const pageSize = window.innerHeight < 800 ? 4 : 6;
  const featured = assets.filter((item) => item.featured);
  q('[data-featured-count]').textContent = featured.length.toLocaleString('en-US');
  const all = q<HTMLButtonElement>('[data-artwork-scope="all"]');
  all.textContent = `All Artwork (${initial.total.toLocaleString('en-US')})`;
  for (const slug of initial.topics) {
    topic.append(
      new Option(
        slug.replaceAll('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        slug,
      ),
    );
  }
  function renderDirectory() {
    const category = directory.find((item) => item.id === categoryId);
    const entries =
      browseMode === 'categories'
        ? directory.map((item) => ({
            id: item.id,
            title: item.title,
            thumb: item.thumb,
            detail: `${item.topics.length} ${item.topics.length === 1 ? 'subject' : 'subjects'}`,
          }))
        : (category?.topics || []).map((item) => ({
            ...item,
            detail: `${item.count} ${item.count === 1 ? 'illustration' : 'illustrations'}`,
          }));
    const pages = Math.max(1, Math.ceil(entries.length / pageSize));
    page = Math.max(1, Math.min(page, pages));
    list.replaceChildren();
    for (const entry of entries.slice((page - 1) * pageSize, page * pageSize)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wb-category-tile';
      button.title = displayCatalogTitle(entry.title);
      const image = document.createElement('img');
      image.src = entry.thumb;
      image.alt = '';
      image.loading = 'lazy';
      image.width = 96;
      image.height = 72;
      const title = document.createElement('strong');
      title.textContent = displayCatalogTitle(entry.title);
      const detail = document.createElement('small');
      detail.textContent = entry.detail;
      button.append(image, title, detail);
      button.addEventListener('click', () => {
        const revision = ++filterRevision;
        void (async () => {
          page = 1;
          if (browseMode === 'categories') {
            categoryId = entry.id;
            browseMode = 'topics';
            render();
          } else {
            topic.value = entry.id;
            browseMode = 'artwork';
            scope = 'all';
            await ensureFull(revision);
            if (revision === filterRevision) render();
          }
        })().catch(() => {
          if (revision !== filterRevision) return;
          count.textContent = 'This category could not load. Select it again to retry.';
        });
      });
      list.append(button);
    }
    count.textContent =
      browseMode === 'categories'
        ? `${entries.length} categories — choose one to see its subjects`
        : `${entries.length} ${entries.length === 1 ? 'subject' : 'subjects'} in ${category?.title || 'this category'}`;
    previous.disabled = page <= 1;
    next.disabled = page >= pages;
    next.hidden = false;
    position.textContent = `Page ${page} of ${pages}`;
    const jump = q<HTMLInputElement>('[data-artwork-jump]');
    jump.max = String(pages);
    jump.value = String(page);
  }
  function drawCards(
    windowItems: LibraryAsset[],
    total: number,
    pages: number,
    transport?: SnapshotTransport,
  ) {
    list.replaceChildren();
    for (const asset of windowItems) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'uc-artwork-card';
      button.dataset.artwork = asset.id;
      button.disabled = busy;
      button.title = asset.title;
      button.setAttribute('aria-label', `Add ${asset.title}`);
      const preview = document.createElement('span');
      preview.className = 'uc-artwork-preview';
      const img = document.createElement('img');
      img.src = asset.thumb;
      if (asset.thumbSrcSet) {
        img.srcset = asset.thumbSrcSet;
        img.sizes = '160px';
      }
      img.alt = asset.alt || asset.title;
      img.title = asset.title;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 256;
      img.height = 200;
      preview.append(img);
      const name = document.createElement('strong');
      name.textContent = displayCatalogTitle(asset.title);
      const detail = document.createElement('span');
      detail.className = 'uc-artwork-dimensions';
      detail.textContent = `${asset.width.toLocaleString()} × ${asset.height.toLocaleString()} px`;
      const action = document.createElement('span');
      action.className = 'uc-artwork-add';
      action.textContent = '+ Add to Canvas';
      button.append(preview, name, detail, action);
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        for (const card of list.querySelectorAll<HTMLButtonElement>('button')) card.disabled = true;
        button.setAttribute('aria-busy', 'true');
        action.textContent = 'Adding…';
        count.textContent = `Adding ${asset.title}…`;
        try {
          if (transport) pinRasterSnapshot(asset.id, transport);
          await add(asset.id);
          count.textContent = `${asset.title} added to your canvas.`;
          action.textContent = '✓ Added · Add Again';
        } catch (error) {
          count.textContent =
            error instanceof Error ? error.message : 'This artwork could not be added. Try again.';
          action.textContent = '+ Add to Canvas';
        } finally {
          if (transport) unpinRasterSnapshot(asset.id);
          busy = false;
          button.removeAttribute('aria-busy');
          for (const card of list.querySelectorAll<HTMLButtonElement>('button'))
            card.disabled = false;
        }
      });
      list.append(button);
    }
    const first = total ? (page - 1) * pageSize + 1 : 0;
    count.textContent = total
      ? `${first}–${Math.min(page * pageSize, total)} of ${total.toLocaleString('en-US')} artworks`
      : 'No matching artwork. Clear filters or search the full catalog.';
    previous.disabled = page <= 1;
    next.disabled = page >= pages;
    next.hidden = false;
    position.textContent = `Page ${page} of ${pages}`;
    const jump = q<HTMLInputElement>('[data-artwork-jump]');
    jump.max = String(pages);
    jump.value = String(page);
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-artwork-scope]'))
      button.setAttribute('aria-pressed', String(button.dataset.artworkScope === scope));
  }
  async function renderRemote() {
    remoteRequest?.abort();
    const controller = new AbortController(),
      sequence = ++remoteSequence,
      revision = filterRevision;
    remoteRequest = controller;
    list.setAttribute('aria-busy', 'true');
    count.textContent = 'Searching the artwork library…';
    const scopes = ['source/raster'];
    if (topic.value) scopes.push('topic/' + topic.value);
    else if (categoryId) scopes.push('collection/' + categoryId);
    if (style.value)
      scopes.push(
        style.value === 'Black & White'
          ? 'print/monochrome'
          : 'studio-style/' + style.value.toLowerCase(),
      );
    try {
      const result = await repository.studioSearch(
        {
          ...defaults,
          q: search.value.trim(),
          page: Math.min(10000, Math.max(1, page)),
          size: pageSize,
          sort: sort.value === 'featured' ? 'relevance' : sort.value,
        },
        controller.signal,
        scopes,
      );
      if (controller.signal.aborted || sequence !== remoteSequence || revision !== filterRevision)
        return;
      page = result.page;
      drawCards(
        result.studioItems as LibraryAsset[],
        result.total,
        result.pages,
        result.manifest.transport,
      );
    } catch (error) {
      if (controller.signal.aborted || sequence !== remoteSequence || revision !== filterRevision)
        return;
      count.textContent =
        'The artwork search could not load. Change a filter or retry All Artwork. Your canvas is preserved.';
    } finally {
      if (sequence === remoteSequence) list.removeAttribute('aria-busy');
    }
  }
  function render() {
    root.dataset.libraryBrowse = browseMode;
    if (browseMode !== 'artwork')
      for (const button of root.querySelectorAll('[data-artwork-scope]'))
        button.setAttribute('aria-pressed', 'false');
    const category = directory.find((item) => item.id === categoryId);
    const parent = q<HTMLButtonElement>('[data-library-parent]');
    parent.hidden = !category;
    parent.textContent = category?.title || '';
    q('[data-library-current]').textContent = topic.value
      ? topic.selectedOptions[0]?.textContent || ''
      : browseMode === 'categories'
        ? 'Choose a Category'
        : browseMode === 'topics'
          ? 'Choose a Subject'
          : '';
    if (browseMode !== 'artwork' && !search.value.trim()) {
      remoteRequest?.abort();
      remoteSequence++;
      renderDirectory();
      return;
    }
    if (remote && scope === 'all') {
      void renderRemote();
      return;
    }
    const words = search.value.trim().toLowerCase().split(/\s+/);
    const matched = (scope === 'featured' ? featured : assets).filter(
      (a) =>
        (!topic.value || topic.value === a.topic) &&
        (!category || category.topics.some((subject) => subject.id === a.topic)) &&
        (!style.value ||
          (style.value === 'realistic'
            ? a.id.includes('realistic')
            : style.value === 'Black & White'
              ? a.monochrome
              : a.style === style.value)) &&
        words.every((word) => `${a.title} ${a.topic} ${a.style}`.toLowerCase().includes(word)),
    );
    matched.sort((a, b) =>
      sort.value === 'title'
        ? a.title.localeCompare(b.title, 'en')
        : sort.value === 'newest'
          ? (b.createdAt || '').localeCompare(a.createdAt || '') ||
            a.title.localeCompare(b.title, 'en')
          : Number(!!b.featured) - Number(!!a.featured) || a.title.localeCompare(b.title, 'en'),
    );
    const pages = Math.max(1, Math.ceil(matched.length / pageSize));
    page = Math.min(page, pages);
    drawCards(
      matched.slice((page - 1) * pageSize, page * pageSize),
      matched.length,
      pages,
      remote ? initial.transport : undefined,
    );
  }

  const reset = () => {
    page = 1;
    render();
  };
  const filter = async () => {
    const revision = ++filterRevision;
    try {
      if (search.value.trim() || topic.value || style.value) await ensureFull(revision);
      if (revision !== filterRevision) return;
      if (search.value.trim() || topic.value || style.value) {
        scope = 'all';
        browseMode = 'artwork';
      }
      reset();
    } catch {
      if (revision !== filterRevision) return;
      count.textContent = 'The full library could not load. Change a filter to retry.';
    }
  };
  search.addEventListener('input', filter);
  style.addEventListener('change', filter);
  topic.addEventListener('change', filter);
  sort.addEventListener('change', reset);
  const clearFilters = () => {
    filterRevision++;
    list.removeAttribute('aria-busy');
    search.value = '';
    style.value = '';
    topic.value = '';
    sort.value = 'featured';
    scope = 'featured';
    browseMode = 'categories';
    categoryId = '';
    reset();
  };
  q('[data-artwork-clear]').addEventListener('click', clearFilters);
  const chooseScope = async (value: string) => {
    const revision = ++filterRevision;
    try {
      if (value === 'all') await ensureFull(revision, '');
      else list.removeAttribute('aria-busy');
      if (revision !== filterRevision) return;
      scope = value;
      browseMode = 'artwork';
      categoryId = '';
      topic.value = '';
      reset();
    } catch {
      if (revision !== filterRevision) return;
      count.textContent = 'The full library could not load. Select All Artwork to retry.';
    }
  };
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-artwork-scope]'))
    button.addEventListener('click', () => {
      void chooseScope(button.dataset.artworkScope!);
    });
  const goHome = () => {
    filterRevision++;
    list.removeAttribute('aria-busy');
    browseMode = 'categories';
    categoryId = '';
    topic.value = '';
    search.value = '';
    page = 1;
    render();
  };
  q('[data-library-home]').addEventListener('click', goHome);
  const goParent = () => {
    filterRevision++;
    list.removeAttribute('aria-busy');
    browseMode = 'topics';
    topic.value = '';
    search.value = '';
    page = 1;
    render();
  };
  q('[data-library-parent]').addEventListener('click', goParent);
  const turn = (delta: number) => {
    page += delta;
    render();
    list.scrollTop = 0;
  };
  q<HTMLInputElement>('[data-artwork-jump]').addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    const requested = Number(target.value);
    if (Number.isInteger(requested) && requested >= 1) {
      page = requested;
      render();
      list.scrollTop = 0;
    }
  });
  next.addEventListener('click', () => turn(1));
  previous.addEventListener('click', () => turn(-1));
  const intent = startup.ready();
  if (intent?.type === 'filter') await filter();
  else if (intent?.type === 'scope') await chooseScope(intent.scope);
  else if (intent?.type === 'clear') clearFilters();
  else if (intent?.type === 'home') goHome();
  else if (intent?.type === 'parent') goParent();
  else render();
}
