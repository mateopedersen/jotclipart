/** Finish a page's optional index before an artificial direct-URL test jump.
 * Real pointer/keyboard link navigation is tested without this wait. WebKit
 * can report a caught fetch from an outgoing, inactive document as a runtime
 * error. Keep every page-error assertion; do not hide or filter those events.
 */
export async function settleBeforeDirectNavigation(page) {
  const active = await page.evaluate(
    () => document.documentElement?.dataset.surpriseNavigation === 'ready',
  );
  if (!active) return;
  await page.waitForLoadState('load', { timeout: 30000 });
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
