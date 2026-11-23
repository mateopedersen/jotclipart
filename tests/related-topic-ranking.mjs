import assert from 'node:assert/strict';
import test from 'node:test';
import geography from '../data/flag-geography.json' with { type: 'json' };
import {
  findRelatedTopics,
  geographicFlagCandidates,
} from '../server/catalog-collections/related-topics.mjs';

const flags = 'Flags & countries';
const record = (slug, primaryCluster, related = []) => ({
  slug,
  primaryCluster,
  related: related.map((target) => ({ slug: target })),
});

test('flag candidates prefer land neighbors, then the nearest flags in their region', () => {
  const lithuania = geographicFlagCandidates('lithuania-flag');
  assert.deepEqual(
    new Set(lithuania.slice(0, 4)),
    new Set(['latvia-flag', 'poland-flag', 'belarus-flag', 'russia-flag']),
  );
  assert(lithuania.indexOf('estonia-flag') < lithuania.indexOf('italy-flag'));
  assert(!lithuania.includes('jamaica-flag'));
  assert.deepEqual(geographicFlagCandidates('fiji-flag').slice(0, 3), [
    'vanuatu-flag',
    'new-caledonia-flag',
    'solomon-islands-flag',
  ]);
  assert(
    geographicFlagCandidates('jamaica-flag')
      .slice(0, 6)
      .every((slug) => geography[slug][2] === 'Caribbean'),
  );
  assert.equal(geographicFlagCandidates('united-kingdom-flag')[0], 'ireland-flag');
  assert(!geographicFlagCandidates('france-flag').slice(0, 10).includes('brazil-flag'));
});

test('suggestions skip unpublished flags and backfill with nearby eligible flags', async () => {
  const available = new Map([
    ['latvia-flag', flags],
    ['poland-flag', flags],
    ['belarus-flag', flags],
    ['estonia-flag', flags],
    ['finland-flag', flags],
    ['sweden-flag', flags],
    ['russia-flag', 'Wrong category'],
    ['jamaica-flag', flags],
  ]);
  const find = async (slug) =>
    available.has(slug) ? { record: record(slug, available.get(slug)) } : null;
  const rows = await findRelatedTopics(record('lithuania-flag', flags, ['jamaica-flag']), find);
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((row) => row.record.slug),
    geographicFlagCandidates('lithuania-flag').filter((slug) => available.get(slug) === flags),
  );
});

test('ordinary subjects retain reviewed links and use reviewed references before broad categories', async () => {
  const sources = new Map([
    ['apple', 'Food & drinks'],
    ['pear', 'Food & drinks'],
    ['green-apple', 'Food & drinks'],
    ['airplane', 'Travel & places'],
  ]);
  const found = await findRelatedTopics(
    record('apple', sources.get('apple'), ['green-apple']),
    async (slug) => (sources.has(slug) ? { record: record(slug, sources.get(slug)) } : null),
  );
  assert.deepEqual(
    found.map((row) => row.record.slug),
    ['green-apple', 'pear'],
  );
});
