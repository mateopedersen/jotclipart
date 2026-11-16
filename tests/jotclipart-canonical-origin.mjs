import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalPublicRedirect } from '../server/jotclipart/canonical-origin.mjs';

test('new HTTP and www read requests reach the HTTPS apex in one hop without losing queries', async () => {
  for (const origin of [
    'http://jotclipart.com',
    'http://www.jotclipart.com',
    'https://www.jotclipart.com',
  ])
    for (const method of ['GET', 'HEAD']) {
      const response = canonicalPublicRedirect(
        new Request(origin + '/search/?q=rose%20heart&page=2&tag=a%2Fb&utm_source=test', {
          method,
        }),
      );
      assert.equal(response.status, 308);
      assert.equal(
        response.headers.get('location'),
        'https://jotclipart.com/search/?q=rose%20heart&page=2&tag=a%2Fb&utm_source=test',
      );
      assert.equal((await response.arrayBuffer()).byteLength, 0);
      assert.equal(
        canonicalPublicRedirect(new Request(response.headers.get('location'), { method })),
        undefined,
      );
    }
});
test('already canonical reads, non-read API methods and foreign or old origins retain their own handler', () => {
  for (const origin of [
    'https://jotclipart.com',
    'https://preview.jotclipart.com',
    'https://jotclipart.pages.dev',
    'https://migration-preview.jotclipart.pages.dev',
    'https://ultraclipart.com',
    'https://assets.ultraclipart.com',
    'https://www.ultraclipart.com',
    'https://jotclipart.com.evil.test',
    'https://www.jotclipart.com:444',
    'http://127.0.0.1:8797',
  ])
    assert.equal(canonicalPublicRedirect(new Request(origin + '/art/example/')), undefined);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    for (const origin of ['http://jotclipart.com', 'https://www.jotclipart.com'])
      assert.equal(
        canonicalPublicRedirect(new Request(origin + '/api/share', { method })),
        undefined,
      );
});
test('compiled dispatch checks the new public origin before every page/API branch and binds its source', () => {
  const source = readFileSync('scripts/catalog-snapshot/build-runtime.mjs', 'utf8');
  assert(source.includes("'server/jotclipart/canonical-origin.mjs'"));
  assert(source.includes('canonicalPublicRedirect(request)'));
  const call = source.indexOf('const canonical=canonicalPublicRedirect(request)');
  assert(call > 0 && call < source.indexOf("if(path.startsWith('/api/ai/'))"));
  assert(source.includes('if(canonical)return canonical;'));
});
