export type ArtworkStartupIntent =
  | { type: 'filter' }
  | { type: 'scope'; scope: string }
  | { type: 'clear' | 'home' | 'parent' };

/** Keep the latest user intent while the initial, verified directory is loading. */
export function beginArtworkLibraryStartup(root: HTMLElement) {
  const search = root.querySelector<HTMLInputElement>('[data-artwork-search]')!;
  const style = root.querySelector<HTMLSelectElement>('[data-artwork-style]')!;
  const topic = root.querySelector<HTMLSelectElement>('[data-artwork-topic]')!;
  const sort = root.querySelector<HTMLSelectElement>('[data-artwork-sort]')!;
  const list = root.querySelector<HTMLElement>('[data-artwork-grid]')!;
  const count = root.querySelector<HTMLElement>('[data-artwork-count]')!;
  let intent: ArtworkStartupIntent | undefined;
  root.dataset.artworkLibraryReady = 'loading';
  list.setAttribute('aria-busy', 'true');
  const filter = (event: Event) => {
    if (event.target === search || event.target === style || event.target === topic)
      intent = { type: 'filter' };
  };
  const click = (event: Event) => {
    const control = event.target instanceof Element ? event.target.closest<HTMLElement>(
      '[data-artwork-scope],[data-artwork-clear],[data-library-home],[data-library-parent]',
    ) : null;
    if (!control || !root.contains(control)) return;
    if (control.dataset.artworkScope !== undefined) {
      intent = { type: 'scope', scope: control.dataset.artworkScope };
    } else if (control.hasAttribute('data-artwork-clear')) {
      search.value = style.value = topic.value = '';
      sort.value = 'featured';
      intent = { type: 'clear' };
    } else if (control.hasAttribute('data-library-home')) {
      search.value = topic.value = '';
      intent = { type: 'home' };
    } else intent = { type: 'parent' };
  };
  root.addEventListener('input', filter, true);
  root.addEventListener('change', filter, true);
  root.addEventListener('click', click, true);
  const detach = () => {
    root.removeEventListener('input', filter, true);
    root.removeEventListener('change', filter, true);
    root.removeEventListener('click', click, true);
    list.removeAttribute('aria-busy');
  };
  return {
    ready(): ArtworkStartupIntent | undefined {
      detach();
      root.dataset.artworkLibraryReady = 'true';
      return intent ?? (search.value.trim() || style.value || topic.value
        ? { type: 'filter' } : undefined);
    },
    fail() {
      detach();
      root.dataset.artworkLibraryReady = 'error';
      count.textContent = 'The artwork library could not load. Reload this page to retry. Your canvas is preserved.';
    },
  };
}
