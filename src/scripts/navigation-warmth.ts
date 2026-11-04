/** Optional public-page warming. Genuine links always navigate without awaiting it. */
export function initNavigationWarmth() {
  if (document.documentElement.dataset.navigationWarmth === 'ready') return;
  document.documentElement.dataset.navigationWarmth = 'ready';
  // The response-header rules are CSP-compatible. Do not duplicate Chrome's
  // native prerenders with manual HTML requests; unsupported browsers fall back.
  if (
    document.querySelector('meta[name="uc-navigation-rules"]') &&
    typeof HTMLScriptElement.supports === 'function' &&
    HTMLScriptElement.supports('speculationrules')
  )
    return;
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  const allowed = () =>
    !document.hidden &&
    navigator.onLine &&
    !connection?.saveData &&
    !['2g', 'slow-2g'].includes(connection?.effectiveType ?? '');
  const attempted = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const target = (node: EventTarget | null) => {
    const link = node instanceof Element ? node.closest<HTMLAnchorElement>('a[href]') : null;
    if (
      !link ||
      link.matches('[download],[data-surprise-art]') ||
      (link.target && link.target !== '_self') ||
      link.relList.contains('nofollow')
    )
      return;
    const url = new URL(link.href, location.href);
    if (
      url.origin !== location.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.href === location.href ||
      url.href.length > 2048
    )
      return;
    if (
      !/^\/(?:art|clipart|collection)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname) &&
      ![
        '/',
        '/new/',
        '/collections/',
        '/categories/',
        '/search/',
        '/black-and-white/',
        '/library-index/',
      ].includes(url.pathname)
    )
      return;
    return url.href;
  };
  const prepare = (event: Event) => {
    clearTimeout(timer);
    const url = target(event.target);
    if (!url || !allowed() || attempted.has(url) || attempted.size >= 2) return;
    timer = setTimeout(() => {
      if (!allowed()) return;
      attempted.add(url);
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), 5000);
      void fetch(url, {
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'default',
        headers: { Accept: 'text/html' },
      })
        .then((response) => response.body?.cancel())
        .catch(() => {})
        .finally(() => clearTimeout(timeout));
    }, 100);
  };
  document.addEventListener('pointerover', prepare, { passive: true });
  document.addEventListener('focusin', prepare);
  document.addEventListener('pointerout', () => clearTimeout(timer), { passive: true });
  document.addEventListener('focusout', () => clearTimeout(timer));
}
