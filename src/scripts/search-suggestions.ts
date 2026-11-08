import { defaults } from '../lib/search';
import { SearchRepository, type RemoteResults } from '../lib/search-remote';
import { LatestRequest } from '../lib/search-request';
import { alignSearchDirectory } from '../lib/search-directory';
import { searchNavigationEntries as searchSiteEntries } from '../lib/site-search';
import {
  searchSuggestions,
  isDirectSearchMatch,
  type SearchSuggestion,
} from '../lib/search-suggestions';
export function initSearchSuggestions() {
  const repository = new SearchRepository();
  const navigationRepository: Pick<SearchRepository, 'siteEntries'> = {
    siteEntries: (manifest, signal) => manifest.transport?.directory === 'source-bound-site-v1'
      ? repository.sourceDirectory(manifest.version, signal, true)
      : repository.siteEntries(manifest, signal),
  };
  for (const form of document.querySelectorAll<HTMLFormElement>('form[action="/search/"]')) {
    if (form.id === 'catalog-search' || form.dataset.suggestionsReady) continue;
    const found = form.querySelector<HTMLInputElement>('input[name="q"]');
    if (!found) continue;
    const input: HTMLInputElement = found;
    form.dataset.suggestionsReady = 'true';
    input.maxLength = 320;
    input.removeAttribute('list');
    const panel = document.createElement('div');
    panel.className = 'search-suggestions';
    panel.id = `suggestions-${crypto.randomUUID()}`;
    panel.hidden = true;
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', 'Search suggestions');
    form.append(panel);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', panel.id);
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    const requests = new LatestRequest();
    let timer: ReturnType<typeof setTimeout> | undefined,
      active = -1,
      selecting = false,
      queued: SearchSuggestion[] | undefined,
      composing = false;
    let pageRoot = document.querySelector<HTMLMetaElement>(
      'meta[name="catalog-snapshot"]',
    )?.content;
    if (!/^[a-f0-9]{64}$/.test(pageRoot ?? '')) pageRoot = undefined;
    let earlyDirectory: ReturnType<SearchRepository['sourceDirectory']> | undefined;
    let availableDirectory: Awaited<ReturnType<SearchRepository['sourceDirectory']>> | undefined;
    const primeDirectory = () => {
      if (pageRoot && !earlyDirectory) {
        const root = pageRoot;
        const loading = repository.sourceDirectory(root, undefined, true);
        earlyDirectory = loading;
        void loading.then(
          (entries) => {
            if (pageRoot === root && earlyDirectory === loading) availableDirectory = entries;
          },
          () => { if (earlyDirectory === loading) earlyDirectory = undefined; },
        );
        // This contains public source metadata only, with no visitor query.
        void earlyDirectory.catch(() => {});
      }
      return earlyDirectory;
    };
    // Begin public metadata ahead of typing; immutable roots stay valid until
    // the authenticated server reports a newer catalog. No visitor query is sent.
    primeDirectory();
    const close = () => {
      clearTimeout(timer);
      requests.cancel();
      panel.hidden = true;
      panel.setAttribute('aria-busy', 'false');
      active = -1;
      selecting = false;
      queued = undefined;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
    function show(options: SearchSuggestion[]) {
      // An exact subject can arrive before artwork. Never remove the native
      // link under an ongoing touch/mouse press or keyboard selection.
      if (selecting || active >= 0) {
        queued = options;
        return;
      }
      queued = undefined;
      panel.replaceChildren(
        ...options.map((option, i) => {
          const link = document.createElement('a');
          link.id = `${panel.id}-${i}`;
          link.href = option.href;
          link.setAttribute('role', 'option');
          link.setAttribute('aria-selected', 'false');
          if (option.kind === 'Search') link.className = 'search-suggestion-all';
          if (option.thumb) {
            const image = document.createElement('img');
            image.src = option.thumb;
            if (option.thumbSrcSet) {
              image.srcset = option.thumbSrcSet;
              image.sizes = '48px';
            }
            image.alt = option.alt || '';
            image.title = option.title;
            image.width = image.height = 44;
            link.append(image);
          }
          const text = document.createElement('span'),
            label = document.createElement('span'),
            kind = document.createElement('small');
          label.textContent = option.title;
          kind.textContent = option.kind;
          text.append(label, kind);
          link.append(text);
          return link;
        }),
      );
      panel.setAttribute('aria-busy', 'false');
      active = -1;
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      input.removeAttribute('aria-activedescendant');
    }
    function suggest() {
      clearTimeout(timer);
      requests.cancel();
      panel.hidden = true;
      active = -1;
      selecting = false;
      queued = undefined;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      const query = input.value.trim();
      if (composing || query.length < 2) {
        close();
        return;
      }
      const direct = availableDirectory ? searchSiteEntries(availableDirectory, query) : [];
      const directShown = direct.some(
        ({ entry, fuzzy }) => !fuzzy && isDirectSearchMatch(entry, query),
      );
      if (directShown) show(searchSuggestions(query, [], direct));
      timer = setTimeout(() => {
        if (!directShown) {
          const loading = document.createElement('p');
          loading.textContent = 'Searching…';
          panel.replaceChildren(loading);
          panel.hidden = false;
          panel.setAttribute('aria-busy', 'true');
          input.setAttribute('aria-expanded', 'true');
        }
        void requests.run<{
          artwork: Parameters<typeof searchSuggestions>[1];
          site: ReturnType<typeof searchSiteEntries>;
        }>(
          async (signal, emit) => {
            const queryRoot = pageRoot;
            let readyArtwork: RemoteResults | undefined;
            const early = primeDirectory();
            const showDirect = (
              entries: Awaited<ReturnType<SearchRepository['sourceDirectory']>>,
            ) => {
              if (readyArtwork && readyArtwork.manifest.version !== queryRoot) return entries;
              const matches = searchSiteEntries(entries, query);
              if (readyArtwork?.items.length || matches.some(({ entry, fuzzy }) => !fuzzy && isDirectSearchMatch(entry, query)))
                emit({ artwork: readyArtwork?.items ?? [], site: matches });
              return entries;
            };
            // The page already pins its verified root. A direct topic does not
            // wait for the separate full artwork/monochrome manifest round trip.
            if (early) void early.then(showDirect, () => {});
            // The page already pins the source root. Start the authenticated
            // search directly; do not serialize it behind the full UI manifest.
            const siteEntries =
              early && queryRoot
                ? early.then((entries) => ({ version: queryRoot, entries }))
                : repository.manifest(signal).then(async (manifest) => ({
                    version: manifest.version,
                    entries: await navigationRepository.siteEntries(manifest, signal),
                  }));
            const artworkRead = async () => {
              if (queryRoot) return repository.searchAtSnapshot(queryRoot, { ...defaults, q: query, size: 8 }, signal, [], true);
              const manifest = await repository.manifest(signal);
              return manifest.transport
                ? repository.searchAtSnapshot(manifest.version, { ...defaults, q: query, size: 8 }, signal, [], true)
                : repository.search({ ...defaults, q: query, size: 8 }, signal);
            };
            const artworkPromise = artworkRead().then((result) => {
              readyArtwork = result;
              // Validated artwork is usable even while navigation metadata is slow.
              // Never attach an old directory to a refreshed artwork generation.
              const sameDirectory = result.manifest.version === queryRoot ? availableDirectory : undefined;
              emit({ artwork: result.items, site: searchSiteEntries(sameDirectory ?? [], query) });
              return result;
            });
            const [art, entries] = await Promise.allSettled([artworkPromise, siteEntries]);
            if (art.status === 'rejected' && entries.status === 'rejected') throw art.reason;
            const directory = {
              version: entries.status === 'fulfilled' ? entries.value.version : (queryRoot ?? ''),
              entries: entries.status === 'fulfilled' ? entries.value.entries : null,
              siteError: entries.status !== 'fulfilled',
            };
            const aligned =
              art.status === 'fulfilled'
                ? await alignSearchDirectory(navigationRepository, art.value.manifest, directory, signal)
                : directory;
            if (
              !signal.aborted &&
              art.status === 'fulfilled' &&
              /^[a-f0-9]{64}$/.test(art.value.manifest.version) &&
              art.value.manifest.version !== queryRoot
            ) {
              // Advance only from a validated successful response, never relabel
              // old directory entries with the refreshed artwork root.
              pageRoot = art.value.manifest.version;
              availableDirectory =
                aligned.version === pageRoot ? (aligned.entries ?? undefined) : undefined;
              earlyDirectory = availableDirectory ? Promise.resolve(availableDirectory) : undefined;
            }
            return {
              artwork: art.status === 'fulfilled' ? art.value.items : [],
              site: searchSiteEntries(aligned.entries ?? [], query),
            };
          },
          ({ artwork, site }) => show(searchSuggestions(query, artwork, site)),
          () => {
            // Keep a usable native destination even if the suggestion data is offline.
            show(searchSuggestions(query, [], []));
          },
        );
      }, 80);
    }
    input.addEventListener('input', suggest);
    input.addEventListener('focus', () => {
      primeDirectory();
      suggest();
    });
    input.addEventListener('compositionstart', () => {
      composing = true;
      close();
    });
    input.addEventListener('compositionend', () => {
      composing = false;
      suggest();
    });
    panel.addEventListener('pointerdown', (event) => {
      if ((event.target as Element)?.closest('[role="option"]')) selecting = true;
    });
    panel.addEventListener('pointercancel', () => {
      selecting = false;
      if (queued && active < 0) show(queued);
    });
    input.addEventListener('keydown', (event) => {
      if (panel.hidden) return;
      const links = [...panel.querySelectorAll<HTMLAnchorElement>('[role="option"]')];
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        if (!links.length) return;
        event.preventDefault();
        active =
          active < 0
            ? event.key === 'ArrowDown'
              ? 0
              : links.length - 1
            : (active + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
        links.forEach((link, i) => link.setAttribute('aria-selected', String(i === active)));
        input.setAttribute('aria-activedescendant', links[active].id);
        links[active].scrollIntoView({ block: 'nearest' });
      }
      if (event.key === 'Enter' && active >= 0) {
        event.preventDefault();
        location.assign(links[active].href);
      }
    });
    form.addEventListener('submit', close);
    form.addEventListener('focusout', (event) => {
      // Safari sends relatedTarget=null when a finger focuses a link. Hiding
      // it here removes the target before the ensuing native click can navigate.
      if (event.relatedTarget instanceof Node && !form.contains(event.relatedTarget)) close();
    });
    document.addEventListener('focusin', (event) => {
      if (!form.contains(event.target as Node)) close();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!form.contains(event.target as Node)) close();
    });
    // Initial pageshow can arrive after a visitor starts typing while large
    // original images finish loading. Only a restored BFCache page needs reset.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        pageRoot = undefined;
        earlyDirectory = undefined;
        availableDirectory = undefined;
        repository.clear();
        close();
      }
    });
    if (document.activeElement === input && input.value.trim()) suggest();
  }
}
