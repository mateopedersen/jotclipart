import assert from 'node:assert/strict';
import test from 'node:test';
import registry from '../data/jotclipart-topic-resources.json' with { type: 'json' };
import { editorialParagraphParts } from '../src/lib/editorial-links.mjs';
import { topicEditorialResources } from '../src/lib/topic-editorial-resources.mjs';

test('reviewed topic resources use distinct canonical paths and readable anchors', () => {
  const entries = Object.entries(registry.topics);
  assert.ok(entries.length >= 864);
  const segment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  for (const [slug, { related, sources }] of entries) {
    assert.match(slug, segment);
    assert.ok(related.length >= 1 && related.length <= 3, slug);
    assert.ok(sources.length <= 2, slug);
    const keys = new Set();
    for (const link of [...related, ...sources]) {
      assert.ok(link.text.trim() && !keys.has(link.href), slug);
      keys.add(link.href);
    }
    for (const { href } of related) {
      const [, type, target] = /^\/(clipart|collection)\/([a-z0-9-]+)\/$/.exec(href) ?? [];
      assert.ok(type && href !== `/clipart/${slug}/`, href);
      if (type === 'clipart') assert.ok(Object.hasOwn(registry.topics, target), href);
    }
    for (const { href } of sources) {
      const url = new URL(href);
      assert.equal(url.protocol, 'https:');
      assert.ok(!url.username && !url.password && url.hostname !== 'jotclipart.com', href);
    }
  }
  assert.deepEqual(topicEditorialResources('__proto__'), { related: [], sources: [] });
});

test('Crab prose is preserved and anchors match the exact surrounding subject', () => {
  const paragraphs = [
    'A blue crab and a red crab with raised claws show distinct silhouettes in this crab clipart. Natural shell shapes sit alongside playful costumes and characters with bigger expressions.',
    'Pick from {{artworkCount}} for a personal beach journal or a classroom tide pool activity. A front view with open claws helps students identify the main parts.',
  ];
  const parts = editorialParagraphParts('/clipart/crab/', paragraphs);
  assert.deepEqual(
    parts.map((paragraph) => paragraph.map(({ text }) => text).join('')),
    paragraphs,
  );
  assert.deepEqual(
    parts
      .flat()
      .filter(({ href }) => href)
      .map(({ text, href }) => [text, href]),
    [
      ['blue crab', 'https://www.chesapeakebay.net/discover/field-guide/entry/blue-crab'],
      ['beach', '/clipart/beach/'],
      ['tide pool', 'https://oceanservice.noaa.gov/facts/tide-pool.html'],
    ],
  );
  assert.ok(
    topicEditorialResources('crab').related.some(({ href }) => href === '/clipart/lobster/'),
  );
});
