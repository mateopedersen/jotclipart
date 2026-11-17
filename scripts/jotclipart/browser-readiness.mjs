/** Finish a page's optional index before an artificial direct-URL test jump.
 * Real pointer/keyboard link navigation is tested without this wait. WebKit
 * can report a caught fetch from an outgoing, inactive document as a runtime
 * error. Keep every page-error assertion; do not hide or filter those events.
 */
const catalogRequests = new WeakMap();

export function observeCatalogRequests(page, origin) {
  if (catalogRequests.has(page)) return;
  const state = { pending: new Set(), lastActivity: 0 };
  catalogRequests.set(page, state);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      (/^\/(?:catalog-search|catalog-stats|surprise-picks|studio-assets)\.json$/.test(
        url.pathname,
      ) ||
        url.pathname.startsWith('/search-data/'))
    ) {
      state.pending.add(request);
      state.lastActivity = Date.now();
    }
  });
  const finished = (request) => {
    if (state.pending.delete(request)) state.lastActivity = Date.now();
  };
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
}

export async function settleBeforeDirectNavigation(page) {
  const active = await page.evaluate(
    () => document.documentElement?.dataset.surpriseNavigation === 'ready',
  );
  if (active) {
    await page.waitForLoadState('load', { timeout: 60000 });
    await page.waitForFunction(
      () =>
        performance.getEntriesByType('resource').some((entry) => {
          const url = new URL(entry.name);
          return (
            url.origin === location.origin &&
            url.pathname === '/surprise-picks.json' &&
            entry.responseEnd > 0
          );
        }),
      null,
      { timeout: 7000 },
    );
  }
  const state = catalogRequests.get(page);
  if (!state?.lastActivity) return;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    // A completed response may enqueue a dependent metadata read while JSON is
    // parsed. Only observed catalog activity needs a short quiet interval.
    // Use the test runner's clock: disabled JavaScript and background pages do
    // not promise animation frames, and must never hang the navigation helper.
    if (!state.pending.size && Date.now() - state.lastActivity >= 100) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw Error(
    'Catalog requests did not finish before artificial navigation: ' +
      [...state.pending].map((request) => new URL(request.url()).pathname).join(', '),
  );
}
