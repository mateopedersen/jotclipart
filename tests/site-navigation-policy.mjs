import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bindSiteNavigationPolicy } from '../scripts/catalog-snapshot/compilers/navigation-policy.mjs';
import { siteNavigationScript } from '../src/lib/site-navigation-inline.mjs';
test('only the exact critical menu script hash is added, preserving all other directives', () => {
  const original = {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'sha256-existing'; connect-src 'self'; style-src 'self' 'unsafe-inline'",
    'X-Frame-Options': 'DENY',
  };
  const next = bindSiteNavigationPolicy(original);
  const hash = createHash('sha256').update(siteNavigationScript).digest('base64');
  assert(next['Content-Security-Policy'].includes("'sha256-" + hash + "'"));
  assert(
    next['Content-Security-Policy'].endsWith(
      "; connect-src 'self'; style-src 'self' 'unsafe-inline'",
    ),
  );
  assert.equal(next['X-Frame-Options'], 'DENY');
  assert.deepEqual(bindSiteNavigationPolicy(next), next);
  assert(!original['Content-Security-Policy'].includes(hash));
  assert(siteNavigationScript.length < 12000);
});
test('missing or permissive script policy is refused', () => {
  for (const csp of [
    "default-src 'self'",
    "script-src 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
  ])
    assert.throws(() => bindSiteNavigationPolicy({ 'Content-Security-Policy': csp }));
});
