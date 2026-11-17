import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { topicHeadingEvidence } from '../scripts/jotclipart/topic-heading.mjs';

test('signed topic audit preserves raw source titles and follows the unchanged native heading field', () => {
  const template = readFileSync('src/pages/clipart/[slug].astro', 'utf8');
  assert.match(template, /const title = displayCatalogTitle\(topic\.keyword\)/);
  for (const [title, keyword, heading] of [
    ['Darts Clipart', 'Dart Clipart', 'Free Dart Clipart'],
    ['Ice Hockey Clipart', 'Hockey Clipart', 'Free Hockey Clipart'],
    ['HUGO BOSS Group Clipart', 'Hugo Boss Group Clipart', 'Free Hugo Boss Group Clipart'],
  ]) {
    const source = { title, keyword };
    assert.deepEqual(topicHeadingEvidence(source), {
      sourceTitle: title,
      headingSource: keyword,
      displayTitle: heading,
    });
    assert.deepEqual(source, { title, keyword });
  }
});
test('a missing signed keyword cannot silently borrow the different SEO title', () => {
  for (const source of [
    { title: 'Darts Clipart' },
    { title: 'Darts Clipart', keyword: '' },
    { keyword: 'Dart Clipart' },
  ])
    assert.throws(() => topicHeadingEvidence(source), /required/);
});
