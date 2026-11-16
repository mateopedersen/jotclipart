import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const components = ['CreateInvitation', 'HomeBenefitVisual'];
const source = Object.fromEntries(
  components.map((name) => [name, readFileSync(`src/components/${name}.astro`, 'utf8')]),
);
const imageTags = (text) => [...text.matchAll(/<img\b[\s\S]*?\/>/g)].map(([tag]) => tag);

test('all four catalog originals in below-fold home compositions use the existing admission policy', () => {
  for (const name of components) {
    const originals = imageTags(source[name]).filter((tag) => /src=\{\w+\.thumb\}/.test(tag));
    assert.equal(originals.length, 2, `${name}: both reviewed catalog originals remain present`);
    for (const tag of originals) {
      assert.match(tag, /data-original-deferred="pending"/);
      assert.match(tag, /srcset=\{\w+\.thumbSrcSet\}/);
      assert.match(tag, /loading="lazy"/);
      assert.match(tag, /decoding="async"/);
      assert.match(tag, /width="\d+"/);
      assert.match(tag, /height="\d+"/);
      assert.doesNotMatch(tag, /data-original-src|data-src|fetchpriority=/);
    }
  }
});

test('small generated interface previews keep their independent native loading', () => {
  const previews = imageTags(source.HomeBenefitVisual).filter((tag) =>
    /src=\{uiImage\d\.src\}/.test(tag),
  );
  assert.equal(previews.length, 3);
  for (const tag of previews) assert.doesNotMatch(tag, /data-original-deferred/);
});

test('deferred images retain ordinary original src in the no-JavaScript fallback', () => {
  const css = readFileSync('src/styles/original-image-loading.css', 'utf8');
  assert.match(
    css,
    /html\[data-original-scheduling=['"]active['"]\]\s+img\[data-original-deferred=['"]pending['"]\]\s*\{\s*display:\s*none\s*!important\s*;/,
  );
  assert.doesNotMatch(
    source.CreateInvitation + source.HomeBenefitVisual,
    /<noscript|data-original-src/,
  );
});
