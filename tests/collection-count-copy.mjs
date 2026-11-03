import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionCountParts } from '../src/lib/collection-count-tokens.mjs';
import { formatCatalogCount } from '../src/lib/catalog-counts.ts';
const render = (text, count) =>
  collectionCountParts(text)
    .map((part) => (typeof part === 'string' ? part : formatCatalogCount(count, part.unit)))
    .join('');
test('live collection counts preserve prose and use correct singular/plural nouns', () => {
  for (const [count, result] of [
    [1, '1 illustration'],
    [2, '2 illustrations'],
    [1050, '1,050 illustrations'],
  ])
    assert.equal(
      render('Browse {{artworkCount}} illustrations in this collection.', count),
      `Browse ${result} in this collection.`,
    );
  assert.equal(render('There are {{artworkCount}} choices.', 23), 'There are 23 choices.');
  assert.equal(
    render('Words and <untrusted> text stay literal.', 3),
    'Words and <untrusted> text stay literal.',
  );
});
