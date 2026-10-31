import test from 'node:test';
import assert from 'node:assert/strict';
import { diverseRecentArtwork } from '../src/lib/recent-artwork.ts';
import { newestFirst } from '../src/lib/publication-order.ts';

test('newest subjects remain ahead of older category variety and use publication dates', () => {
  const source = [
    { topic: 'old-food', createdAt: '2026-10-28T00:00:00Z' },
    { topic: 'new-one', createdAt: '2020-01-01', firstPublishedAt: '2026-10-29T10:00:00Z' },
    { topic: 'new-two', createdAt: '2020-01-01', firstPublishedAt: '2026-10-29T11:00:00Z' },
    { topic: 'new-one', createdAt: '2026-10-29T09:00:00Z' },
    { topic: 'draft', createdAt: '2026-10-30', published: false },
    { topic: 'hidden', createdAt: '2026-10-30', indexable: false },
  ];
  const items = diverseRecentArtwork(newestFirst(source), () => 'same-category', 2);
  assert.deepEqual(
    items.map((item) => item.topic),
    ['new-two', 'new-one'],
  );
  assert.equal(items[1].firstPublishedAt, '2026-10-29T10:00:00Z');
});

test('same-time releases keep the catalog tie-breaker and never repeat a subject', () => {
  const source = ['a', 'b', 'a', 'c'].map((topic) => ({ topic, createdAt: '2026-10-29' }));
  assert.deepEqual(
    diverseRecentArtwork(newestFirst(source), () => '', 15).map((x) => x.topic),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    diverseRecentArtwork(source, () => '', 0),
    [],
  );
  assert.throws(() => diverseRecentArtwork(source, () => '', -1));
});

test('recent rows alternate audited color and monochrome designs from unique recent subjects', () => {
  const source = [];
  for (const topic of ['newest', 'next', 'third', 'fourth']) {
    for (let variant = 1; variant <= 4; variant++) {
      source.push({
        id: `${topic}-${variant}`,
        topic,
        style: variant <= 2 ? 'Color' : 'Black & White',
        monochrome: variant > 2,
        createdAt: '2026-10-31T06:16:02.724Z',
      });
    }
  }
  const picks = diverseRecentArtwork(newestFirst(source), () => undefined, 4);
  assert.equal(new Set(picks.map((item) => item.topic)).size, 4);
  assert.deepEqual(
    picks.map((item) => item.monochrome),
    [true, false, true, false],
  );
  assert.deepEqual(
    picks.map((item) => item.id),
    ['fourth-4', 'third-2', 'next-4', 'newest-2'],
  );
});

test('one-style catalogs keep their real newest order and topics without inventing variety', () => {
  const source = [
    { id: 'b', topic: 'second', monochrome: true, createdAt: '2026-10-31' },
    { id: 'a', topic: 'first', monochrome: true, createdAt: '2026-10-30' },
  ];
  assert.deepEqual(
    diverseRecentArtwork(newestFirst(source), () => undefined, 2).map((item) => item.id),
    ['b', 'a'],
  );
});
