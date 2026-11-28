import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  validateInlineScripts,
  applyCatalogHeaders,
} from '../server/catalog-snapshot/response-policy.mjs';
test('only reviewed executable inline source hashes are allowed', async () => {
  const source = 'window.example=1',
    h = createHash('sha256').update(source).digest('hex');
  await validateInlineScripts(
    `<script>${source}</script><script type="application/ld+json">{"x":1}</script><script src="/source.js"></script>`,
    [h],
  );
  await assert.rejects(() => validateInlineScripts('<script>alert(1)</script>', [h]), /Unexpected/);
  await assert.rejects(() => validateInlineScripts('', []), /Reviewed/);
});
test('inline policy checks browser-recognized mixed-case and whitespace closing tags', async () => {
  const source = 'window.example=1',
    hash = createHash('sha256').update(source).digest('hex');
  for (const end of ['</script >', '</ScRiPt\t\n bar>', '</script/>']) {
    await validateInlineScripts(`<SCRIPT>${source}${end}`, [hash]);
    await assert.rejects(
      () => validateInlineScripts(`<SCRIPT>window.unreviewed=1${end}`, [hash]),
      /Unexpected/,
    );
  }
});
test('site security policy preserves dynamic response caching and editor rules', () => {
  const p = {
      page: { 'Content-Security-Policy': "script-src 'self'", 'Cache-Control': 'wrong' },
      editor: { 'Content-Security-Policy': "script-src 'self' https://challenges.cloudflare.com" },
    },
    r = new Response('x', { headers: { 'cache-control': 'no-cache', 'x-uc-snapshot': 'a' } });
  assert.equal(
    applyCatalogHeaders(r.clone(), '/search/', p).headers.get('cache-control'),
    'no-cache',
  );
  assert.match(
    applyCatalogHeaders(r.clone(), '/edit/test/', p).headers.get('content-security-policy'),
    /challenges/,
  );
  assert.equal(
    applyCatalogHeaders(r.clone(), '/studio-manifest.json', p).headers.get('vary'),
    'X-UC-Catalog-Protocol',
  );
});

test('actual contact runtime permits only the Google Forms frame without changing other page controls', () => {
  const p = JSON.parse(readFileSync('config/jotclipart-http-policy.json'));
  const response = new Response('<h1>Contact</h1>', {
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'cache-control': 'private, no-store',
      'x-uc-snapshot': 'same',
    },
  });
  const contact = applyCatalogHeaders(response.clone(), '/contact/', p);
  const ordinary = applyCatalogHeaders(response.clone(), '/art/example/', p);
  const original = p.page['Content-Security-Policy'];
  assert(
    contact.headers.get('content-security-policy').endsWith('frame-src https://docs.google.com'),
  );
  assert.equal(ordinary.headers.get('content-security-policy'), original);
  for (const name of [
    'script-src',
    'connect-src',
    'form-action',
    'object-src',
    'frame-ancestors',
  ]) {
    const directive = original
      .split(';')
      .find((x) => x.trim().startsWith(name + ' '))
      .trim();
    assert(contact.headers.get('content-security-policy').includes(directive));
  }
  assert.equal(contact.headers.get('cache-control'), 'private, no-store');
  assert.equal(contact.headers.get('x-uc-snapshot'), 'same');
  assert(!contact.headers.get('content-security-policy').includes('*.google.com'));
});
