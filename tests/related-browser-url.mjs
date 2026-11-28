import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './helpers/typescript.mjs';
const { relatedCardURL } = await loadTypescript('src/lib/related/browser-url.ts');
test('related navigation preserves owned canonical pages and exact original media', () => {
  assert.equal(
    relatedCardURL('/art/little-fox/', 'detail'),
    'https://jotclipart.com/art/little-fox/',
  );
  assert.equal(
    relatedCardURL('https://ultraclipart.com/art/little-fox/', 'detail'),
    'https://jotclipart.com/art/little-fox/',
  );
  for (const path of ['fox/repaired.pdf.1234abcd.pdf', 'fox/source.webp'])
    assert.equal(
      relatedCardURL('https://assets.jotclipart.com/' + path, 'media'),
      'https://assets.jotclipart.com/' + path,
    );
  assert.equal(
    relatedCardURL('/catalog/fox/original.webp', 'media'),
    'https://jotclipart.com/catalog/fox/original.webp',
  );
});
test('related cards reject active schemes, unowned origins and misleading hostname prefixes', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,test',
    '//evil.invalid/a.webp',
    'https://assets.jotclipart.com.evil.invalid/a.webp',
    'https://assets.jotclipart.com@evil.invalid/a.webp',
    'https://assets.jotclipart.com:444/a.webp',
    'https://assets.jotclipart.com/a.webp?redirect=evil',
    'https://assets.jotclipart.com/a.svg',
    'https:\\evil.invalid/a.webp',
  ])
    assert.throws(() => relatedCardURL(value, 'media'), value);
  for (const value of [
    '//evil.invalid/art/fox/',
    '/art/fox/?redirect=evil',
    '/edit/fox/',
    '/art/fox/#script',
  ])
    assert.throws(() => relatedCardURL(value, 'detail'), value);
});
