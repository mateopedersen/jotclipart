import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { staticNavigationPolicy } from '../server/catalog-snapshot/static-navigation-policy.mjs';
import { siteNavigationScript } from '../src/lib/site-navigation-inline.mjs';
const token = "'sha256-" + createHash('sha256').update(siteNavigationScript).digest('base64') + "'",
  policy =
    "default-src 'self'; script-src 'self' 'sha256-old'; style-src 'self' 'unsafe-inline'; connect-src 'self'";
test('legacy HTML gets only the compiled menu digest while all other headers and bytes survive', async () => {
  for (const status of [200, 404]) {
    const r = staticNavigationPolicy(
      new Response('<p>unchanged</p>', {
        status,
        headers: {
          'content-type': 'text/html;charset=utf-8',
          'content-security-policy': policy,
          etag: '"same"',
        },
      }),
      token,
    );
    assert.equal(r.status, status);
    assert.equal(await r.clone().text(), '<p>unchanged</p>');
    assert.equal(r.headers.get('etag'), '"same"');
    assert(r.headers.get('content-security-policy').includes(token));
    assert(
      r.headers
        .get('content-security-policy')
        .endsWith("; style-src 'self' 'unsafe-inline'; connect-src 'self'"),
    );
    const repeated = staticNavigationPolicy(r, token);
    assert.equal(repeated.headers.get('content-security-policy').split(token).length, 2);
  }
});
test('non-HTML/error responses are untouched and invalid/permissive policy is denied', () => {
  for (const [status, type] of [
    [200, 'application/javascript'],
    [503, 'text/html'],
  ]) {
    const r = new Response('', { status, headers: { 'content-type': type } });
    assert.equal(staticNavigationPolicy(r, token), r);
  }
  for (const csp of ['', "script-src 'self' 'unsafe-inline'"])
    assert.throws(() =>
      staticNavigationPolicy(
        new Response('', {
          headers: { 'content-type': 'text/html', 'content-security-policy': csp },
        }),
        token,
      ),
    );
  assert.throws(() =>
    staticNavigationPolicy(
      new Response('', {
        headers: { 'content-type': 'text/html', 'content-security-policy': policy },
      }),
      'unbound',
    ),
  );
});
