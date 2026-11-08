const asset = (value: string | null, origin: string) => {
  try {
    const url = new URL(value ?? '', origin);
    return url.protocol === 'https:' &&
      url.hostname === 'assets.ultraclipart.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

/** Read inert, same-page hints. Never insert or execute prefetched document HTML. */
export function surpriseWarmImages(html: string, path: string, origin = location.origin) {
  if (!/^\/art\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path) || html.length > 1024 * 1024) return [];
  const template = document.createElement('template');
  template.innerHTML = html;
  const content = template.content,
    canonical = 'https://ultraclipart.com' + path;
  if (content.querySelector('link[rel="canonical"]')?.getAttribute('href') !== canonical) return [];
  const image = content.querySelector('#art-preview img');
  const original = asset(image?.getAttribute('src') ?? null, origin);
  if (!original) return [];
  let bound = false;
  const visit = (value: unknown, depth = 0) => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const item = value as Record<string, unknown>;
    if (
      item['@type'] === 'ImageObject' &&
      item.contentUrl === original &&
      item.url === canonical &&
      item.mainEntityOfPage === canonical
    )
      bound = true;
    if (item['@graph']) visit(item['@graph'], depth + 1);
  };
  for (const script of content.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.textContent ?? ''));
    } catch {
      /* No trusted image hint. */
    }
  }
  if (!bound) return [];
  const thumbnail =
    image?.getAttribute('data-original-placeholder-for') === original
      ? asset(image.getAttribute('data-original-placeholder'), origin)
      : undefined;
  return [...new Set([...(thumbnail ? [thumbnail] : []), original])];
}

export function createSurpriseWarmer(isActive: () => boolean = () => true) {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  const allowed = () =>
    isActive() &&
    !document.hidden &&
    navigator.onLine &&
    !connection?.saveData &&
    !['slow-2g', '2g'].includes(connection?.effectiveType ?? '');
  let path = '',
    controller: AbortController | undefined,
    attempts = 0;
  const hints: HTMLLinkElement[] = [];
  const cancel = () => {
    controller?.abort();
    controller = undefined;
    while (hints.length) hints.pop()!.remove();
  };
  const warm = (next: string) => {
    if (
      !allowed() ||
      path === next ||
      attempts >= 2 ||
      !/^\/art\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(next)
    )
      return;
    path = next;
    attempts++;
    controller?.abort();
    while (hints.length) hints.pop()!.remove();
    controller = new AbortController();
    const ownController = controller;
    const signal = ownController.signal,
      timeout = setTimeout(() => ownController.abort(), 5000);
    void (async () => {
      try {
        const response = await fetch(next, {
          signal,
          credentials: 'same-origin',
          cache: 'default',
          headers: { Accept: 'text/html' },
        });
        if (
          !response.ok ||
          response.redirected ||
          response.url !== new URL(next, location.origin).href ||
          !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')
        )
          return;
        const images = surpriseWarmImages(await response.text(), next);
        if (signal.aborted || path !== next || !allowed()) return;
        for (const url of images) {
          const hint = document.createElement('link');
          hint.rel = 'preload';
          hint.as = 'image';
          hint.href = url;
          hint.fetchPriority = 'low';
          hint.dataset.surpriseWarm = next;
          document.head.append(hint);
          hints.push(hint);
        }
      } catch {
        /* Warming is optional; the genuine link never waits for it. */
      } finally {
        clearTimeout(timeout);
      }
    })();
  };
  return Object.assign(warm, { cancel });
}
