import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex } from '../src/lib/search-index.ts';
import { SearchRepository, SearchHttpError } from '../src/lib/search-remote.ts';
import { defaults } from '../src/lib/search.ts';

const id = 'apple-and-dried-rings-crayon-clipart';
const item = {
  id,
  topic: 'apple',
  topicLabel: 'Apple',
  title: 'Apples with Dried Rings',
  alt: 'Red-and-yellow apples sit behind several dried apple rings.',
  description: 'Red-and-yellow apples sit behind several dried apple rings.',
  cluster: 'Food',
  style: 'Color',
  color: 'Red',
  orientation: 'Square',
  formats: ['WEBP', 'PDF'],
  alpha: true,
  published: true,
  thumb: '/catalog/apple/apple-and-dried-rings-crayon-clipart-thumb.webp',
  webp: '/catalog/apple/apple-and-dried-rings-crayon-clipart.webp',
  pdf: '/catalog/apple/apple-and-dried-rings-crayon-clipart.pdf',
};
const topics = [
  { slug: 'apple', keyword: 'Apple clipart' },
  { slug: 'golden-snitch', keyword: 'Golden Snitch clipart' },
];
const build = buildSearchIndex([item], topics, 'test-version');
const repo = new SearchRepository(async (path) => {
  const key = path.replace(/^\/search-data\//, '').replace(/\.json$/, '');
  if (!build.files.has(key)) throw new SearchHttpError(404);
  return structuredClone(build.files.get(key));
});
const search = (q) => repo.search({ ...defaults, q });

test('one word of an unrelated multiword topic does not suppress labeled partial artwork', async () => {
  const result = await search('golden red apple dried rings');
  assert.equal(result.items.length, 0);
  assert.equal(result.relatedItems[0]?.id, id);
  assert.deepEqual(result.relatedMissing[id], ['golden']);
});
test('an exact long-tail match remains in the exact results', async () => {
  const result = await search('red apple dried rings');
  assert.equal(result.items[0]?.id, id);
});
test('complete topic phrases and excluded subjects remain mandatory in partial results', async () => {
  const fullTopic = await search('golden snitch apple rings');
  assert.ok(!fullTopic.relatedItems?.some((card) => card.id === id));
  const excluded = await search('golden red apple dried rings without apple');
  assert.equal(excluded.items.length, 0);
  assert.equal(excluded.relatedItems?.length ?? 0, 0);
});
