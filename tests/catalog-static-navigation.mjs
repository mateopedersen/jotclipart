import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rewriteStaticNavigationHTML } from '../scripts/catalog-snapshot/prepare-static-navigation.mjs';
import { siteNavigationScript } from '../src/lib/site-navigation-inline.mjs';
const old = '/_astro/reviewed-legacy.js',
  share = '/__ssr-client/' + 'a'.repeat(40) + '/share.js';
const html =
  '<header data-site-header></header><main id="main"><article><header>Unchanged article</header></article></main><script type="module" src="' +
  old +
  '"></script>';
const bytes = Buffer.from(html),
  binding = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
test('a bound static header receives only the exact controller and new share-only URL', () => {
  const result = rewriteStaticNavigationHTML(bytes, binding, old, share);
  assert(result.includes('</header><script>' + siteNavigationScript + '</script><main id="main"'));
  assert(result.includes('<header>Unchanged article</header>'));
  assert(result.includes('src="' + share + '"'));
  assert(!result.includes(old));
  assert.equal(bytes.toString(), html);
});
test('changed bytes, duplicate header markers and nonversioned share assets fail closed', () => {
  assert.throws(() => rewriteStaticNavigationHTML(Buffer.from(html + ' '), binding, old, share));
  assert.throws(() =>
    rewriteStaticNavigationHTML(bytes, binding, old, 'https://outside.invalid/share.js'),
  );
  const duplicate = Buffer.from(html.replace('Unchanged article', 'data-site-header'));
  const b = {
    bytes: duplicate.length,
    sha256: createHash('sha256').update(duplicate).digest('hex'),
  };
  assert.throws(() => rewriteStaticNavigationHTML(duplicate, b, old, share));
});
