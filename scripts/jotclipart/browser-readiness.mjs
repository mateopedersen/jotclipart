/** Finish a page's optional index before an artificial direct-URL test jump.
 * Real pointer/keyboard link navigation is tested without this wait. WebKit
 * can report a caught fetch from an outgoing, inactive document as a runtime
 * error. Keep every page-error assertion; do not hide or filter those events.
 */
const catalogRequests = new WeakMap();

export function observeCatalogRequests(page, origin) {
  if (catalogRequests.has(page)) return;
  const requests = new Set();
  catalogRequests.set(page, requests);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      (/^\/(?:catalog-search|catalog-stats|surprise-picks|studio-assets)\.json$/.test(
        url.pathname,
      ) ||
        url.pathname.startsWith('/search-data/'))
    )
      requests.add(request);
  });
  const finished = (request) => requests.delete(request);
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
  const pending = catalogRequests.get(page);
  if (!pending) return;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (!pending.size) {
      // A completed response may queue a dependent metadata read while its JSON
      // is parsed. Flush render tasks, then check the observed requests again.
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      if (!pending.size) return;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw Error(
    'Catalog requests did not finish before artificial navigation: ' +
      [...pending].map((request) => new URL(request.url()).pathname).join(', '),
  );
}
