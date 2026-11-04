import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readReviewedImportCatalog } from '../scripts/reviewed-imports.mjs';
import {
  curatedRegistry,
  curatedDefinitions,
  activeCuratedCollections,
  resolveReviewedCover,
  withCuratedCollectionCounts,
  balancedCollectionIDs,
  curatedSitemap,
  validateCuratedRegistry,
  reviewedPrimaryCopy,
} from '../src/lib/curated-collection-policy.mjs';
import {
  curatedStatistics,
  readCuratedGallery,
  readCuratedViews,
} from '../server/catalog-snapshot/curated-collections.mjs';
import { sitemapIndex } from '../src/lib/sitemaps.ts';
import {
  readCollectionRegistries,
  verifyCollectionOpenings,
  collectionOpening,
} from '../scripts/collection-editorial.mjs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const accepted = new Map(
  readReviewedImportCatalog(process.cwd())
    .filter((a) => a.published && a.indexable)
    .map((a) => [a.id, a]),
);
const sourceTopics = [...read('data/topics.json').topics, ...read('data/extra-topics.json')];
// The current immutable snapshot includes these two reviewed live capsules.
// Overlay their actual records without rewriting the older source catalog.
for (const name of ['owner-lesotho-20261104', 'lesotho-additional-20-20261104']) {
  const path = 'data/catalog-batches/' + name + '.json';
  if (!existsSync(path)) continue;
  const capsule = read(path);
  for (const change of capsule.changes)
    if (!accepted.has(change.id)) accepted.set(change.id, change.record);
  for (const change of capsule.topicChanges) {
    const i = sourceTopics.findIndex((t) => t.slug === change.slug);
    const topic = {
      slug: change.slug,
      keyword: change.record.keyword,
      cluster: change.record.primaryCluster,
    };
    if (i < 0) sourceTopics.push(topic);
    else sourceTopics[i] = topic;
  }
}
const art = [...accepted.values()];
const byId = new Map(art.map((a) => [a.id, a])),
  byTopic = new Map();
for (const item of art) byTopic.set(item.topic, [...(byTopic.get(item.topic) ?? []), item.id]);
const topics = Object.fromEntries([...byTopic].map(([t, ids]) => [t, ids.length]));
const primary = read('data/primary-topic-categories.json');
const collections = {};
for (const [slug, count] of Object.entries(topics)) {
  const topic = sourceTopics.find((t) => t.slug === slug),
    label = primary[slug] ?? topic.browseCluster ?? topic.cluster,
    key = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const group = (collections[key] ??= { artworks: 0, subjects: 0 });
  group.artworks += count;
  group.subjects++;
}
const base = {
  schema: 1,
  version: '0123456789abcdef',
  totals: {
    artworks: art.length,
    subjects: byTopic.size,
    collections: Object.keys(collections).length,
    printable: 123,
  },
  topics,
  collections,
};
const group = (slug) => curatedDefinitions.find((g) => g.slug === slug);

test('all 76 curated groups and all 25 primary covers match accepted metadata and source hashes', () => {
  const { version, ...body } = curatedRegistry;
  assert.equal(createHash('sha256').update(JSON.stringify(body)).digest('hex'), version);
  assert.equal(curatedDefinitions.length, 76);
  assert.equal(curatedRegistry.primaryCovers.length, 25);
  assert.equal(activeCuratedCollections(topics).length, 76);
  assert.equal(new Set(art.map((a) => a.id)).size, art.length);
  const oldSlugs = Object.keys(base.collections).sort();
  assert.deepEqual(curatedRegistry.primaryCovers.map((g) => g.slug).sort(), oldSlugs);
  for (const g of [...curatedDefinitions, ...curatedRegistry.primaryCovers]) {
    const cover = resolveReviewedCover(g.slug, byId);
    assert.equal(cover.length, 3);
    if (g.topicSlugs) assert(cover.every((a) => g.topicSlugs.includes(a.topic)));
    else
      for (const a of cover) {
        const t = sourceTopics.find((t) => t.slug === a.topic),
          label = primary[t.slug] ?? t.browseCluster ?? t.cluster;
        assert.equal(
          label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, ''),
          g.slug,
        );
      }
  }
});
test('new group memberships do not duplicate artworks, change primary categories or inflate the catalog', () => {
  const before = structuredClone(base),
    result = withCuratedCollectionCounts(base);
  assert.equal(result.totals.collections, 101);
  assert.equal(result.totals.artworks, art.length);
  assert.equal(result.totals.subjects, byTopic.size);
  assert.equal(result.totals.printable, 123);
  assert.deepEqual(base, before);
  for (const [slug, value] of Object.entries(collections))
    assert.deepEqual(result.collections[slug], value);
  for (const g of curatedDefinitions) {
    const ids = art.filter((a) => g.topicSlugs.includes(a.topic)).map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(result.collections[g.slug].artworks, ids.length);
  }
  const primaryMemberships = new Set(
    Object.keys(collections).map((slug) =>
      sourceTopics
        .filter(
          (t) =>
            topics[t.slug] &&
            (primary[t.slug] ?? t.browseCluster ?? t.cluster)
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '') === slug,
        )
        .map((t) => t.slug)
        .sort()
        .join('|'),
    ),
  );
  for (const g of curatedDefinitions)
    assert(
      !primaryMemberships.has([...g.topicSlugs].sort().join('|')),
      'Duplicate primary category: ' + g.slug,
    );
});
test('ambiguous topic names use the intended subject instead of substring matching', () => {
  assert(group('wild-cats').topicSlugs.includes('jaguar'));
  assert(!group('cars-vehicle-brands').topicSlugs.includes('jaguar'));
  assert(group('birds').topicSlugs.includes('kiwi'));
  assert(!group('tropical-fruit').topicSlugs.includes('kiwi'));
  assert(group('pets').topicSlugs.includes('mouse'));
  assert(!group('pets').topicSlugs.includes('computer-mouse'));
  assert(group('computers-accessories').topicSlugs.includes('computer-mouse'));
  assert(!group('computers-accessories').topicSlugs.includes('mouse'));
  assert(!group('woodland-animals').topicSlugs.includes('bear'));
  assert(group('fish').topicSlugs.includes('clownfish'));
  assert(group('fish').topicSlugs.includes('trout'));
  assert(group('numbers-counting').topicSlugs.includes('06'));
  assert(!group('numbers-counting').topicSlugs.includes('007'));
  assert(!group('numbers-counting').topicSlugs.includes('911'));
  assert(group('bears').topicSlugs.includes('polar-bear'));
  for (const slug of ['koala', 'red-panda']) assert(!group('bears').topicSlugs.includes(slug));
  for (const slug of ['rabbit', 'hedgehog', 'armadillo'])
    assert(!group('rodents').topicSlugs.includes(slug));
  assert.deepEqual([...group('lettering-typography').topicSlugs].sort(), ['font', 'word']);
  assert(!group('computers-accessories').topicSlugs.includes('word'));
  assert(!group('harry-potter').topicSlugs.includes('magic-spell'));
  assert(!group('avengers-doctor-doom').topicSlugs.includes('superhero'));
  assert(!group('plants-botanical-details').topicSlugs.includes('mushroom'));
});
test('all 52 country flag subjects have one correct regional membership; the broader USA topic stays separate', () => {
  const regional = curatedDefinitions.filter((g) => g.section === 'Flags');
  assert.equal(regional.length, 5);
  const members = regional.flatMap((g) => g.topicSlugs);
  assert.equal(members.length, 52);
  assert.equal(new Set(members).size, 52);
  assert(!members.includes('usa'));
  const expected = sourceTopics
    .filter(
      (t) =>
        topics[t.slug] &&
        (primary[t.slug] ?? t.browseCluster ?? t.cluster).toLowerCase() === 'flags & countries' &&
        t.slug !== 'usa',
    )
    .map((t) => t.slug)
    .sort();
  assert.deepEqual([...members].sort(), expected);
  assert(group('asian-flags').topicSlugs.includes('kazakhstan-flag'));
  assert(group('african-flags').topicSlugs.includes('lesotho-flag'));
  assert(group('oceania-flags').topicSlugs.includes('australia-flag'));
});
test('new introductions have distinct openings, including against existing subject introductions', () => {
  const reviewed = [...curatedDefinitions, ...curatedRegistry.primaryCovers];
  const result = verifyCollectionOpenings({
    topics: Object.fromEntries(reviewed.map((g) => [g.slug, g])),
  });
  assert.equal(result.uniqueOpeningTemplates, 101);
  const current = readCollectionRegistries();
  for (const name of ['owner-lesotho-20261104', 'lesotho-additional-20-20261104']) {
    const path = 'data/catalog-batches/' + name + '.json';
    if (!existsSync(path)) continue;
    for (const change of read(path).topicChanges)
      current.topics[change.slug] = change.record.editorial;
  }
  const existingOpenings = new Set(
    Object.values(current.topics).map((r) => collectionOpening(r.paragraphs[0]).toLowerCase()),
  );
  for (const g of reviewed) {
    assert(
      !existingOpenings.has(collectionOpening(g.paragraphs[0]).toLowerCase()),
      g.slug + ' repeats existing subject copy',
    );
    assert.doesNotMatch(g.summary, /[-\u2010-\u2015]/u, g.slug);
    if (curatedRegistry.primaryCovers.includes(g))
      assert.deepEqual(reviewedPrimaryCopy(g.slug), {
        description: g.summary,
        paragraphs: g.paragraphs,
      });
  }
  assert.deepEqual(reviewedPrimaryCopy('not-reviewed'), {});
});
test('repeated topic sets and unobserved covers cannot create additional collections', () => {
  const duplicate = structuredClone(curatedRegistry);
  duplicate.collections[1].topicSlugs = [...duplicate.collections[0].topicSlugs].reverse();
  duplicate.collections[1].cover = structuredClone(duplicate.collections[0].cover);
  assert.throws(() => validateCuratedRegistry(duplicate), /Duplicate curated membership/);
  const unobserved = structuredClone(curatedRegistry);
  unobserved.primaryCovers[0].review.observations = [];
  assert.throws(() => validateCuratedRegistry(unobserved), /unreviewed collection cover/);
});
test('image or public metadata replacement invalidates its selected cover review', () => {
  const g = group('farm-animals'),
    id = g.cover[0].id,
    original = byId.get(id);
  for (const replacement of [
    { ...original, title: original.title + ' revised' },
    { ...original, alt: 'Different image' },
    {
      ...original,
      files: { ...original.files, webp: { ...original.files.webp, sha256: 'f'.repeat(64) } },
    },
    { ...original, published: false },
  ]) {
    const changed = new Map(byId);
    changed.set(id, replacement);
    assert.throws(() => resolveReviewedCover(g.slug, changed), /Stale collection cover review/);
  }
});
test('dynamic additions update only matching themed counts and incomplete groups are not exposed', () => {
  const changed = { ...topics, cow: topics.cow + 1 };
  assert.equal(
    withCuratedCollectionCounts(base, changed).collections['farm-animals'].artworks,
    base.topics.cow +
      1 +
      group('farm-animals')
        .topicSlugs.filter((t) => t !== 'cow')
        .reduce((n, t) => n + topics[t], 0),
  );
  const missing = { ...topics, cow: 0 };
  assert(!activeCuratedCollections(missing).some((g) => g.slug === 'farm-animals'));
  assert(!curatedSitemap(missing).includes('/collection/farm-animals/'));
  const bad = structuredClone(curatedRegistry);
  bad.collections[0].topicSlugs.push('cow');
  assert.throws(() => validateCuratedRegistry(bad), /membership/);
});
test('visible count API derives themed counts from bounded captured keys, without a full catalog or signed-count mutation', async () => {
  const requests = [],
    visible = { ...base, topics: { cow: topics.cow } };
  const cc = {
    countsFor: async (keys) => {
      requests.push(keys);
      assert(keys.length <= 64);
      return { ...base, topics: Object.fromEntries(keys.map((k) => [k, topics[k] ?? 0])) };
    },
  };
  const result = await curatedStatistics(cc, visible);
  assert.equal(result.totals.collections, 101);
  assert.deepEqual(result.topics, { cow: topics.cow });
  assert(
    requests.length <=
      Math.ceil(new Set(curatedDefinitions.flatMap((g) => g.topicSlugs)).size / 64),
  );
  assert.equal(result.collections['farm-animals'].artworks, 650);
  assert.equal(base.totals.collections, 25);
});
test('balanced previews resolve current source IDs and reject a captured member pointing at an unrelated topic', async () => {
  const g = group('primates'),
    all = new Map(),
    records = new Map();
  for (const slug of g.topicSlugs) {
    const ids = byTopic.get(slug).slice(0, 32),
      page = { type: 'collection-page-ids', slug, offset: 0, artworkIds: ids },
      d = { slug, part: 'page', offset: 0, count: ids.length };
    records.set(slug, {
      type: 'collection-topic-references',
      slug,
      path: `/clipart/${slug}/`,
      artworkCount: topics[slug],
      pageBlocks: [d],
    });
    all.set(slug, page);
  }
  const cc = {
    lookupCollection: async (slug) => ({ slug, part: 'record', artworkCount: topics[slug] }),
    read: async (d) => (d.part === 'record' ? records.get(d.slug) : all.get(d.slug)),
  };
  const artwork = async (ids) => ids.map((id) => byId.get(id));
  const items = await readCuratedGallery({ group: g, cc, counts: base, artwork });
  assert.equal(items.length, 32);
  assert.equal(new Set(items.map((a) => a.id)).size, 32);
  assert.equal(new Set(items.map((a) => a.topic)).size, 3);
  const bad = async (ids) =>
    (await artwork(ids)).map((a, i) => (i === 3 ? { ...a, topic: 'computer-mouse' } : a));
  await assert.rejects(
    () => readCuratedGallery({ group: g, cc, counts: base, artwork: bad }),
    /unrelated artwork/,
  );
  records.get('gorilla').artworkCount++;
  await assert.rejects(
    () => readCuratedGallery({ group: g, cc, counts: base, artwork }),
    /count or identity differs/,
  );
});
test('the sitemap adds 76 real themed routes while retaining the original page and image documents', () => {
  const xml = curatedSitemap(topics),
    urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(urls.length, 76);
  assert.equal(new Set(urls).size, 76);
  for (const g of curatedDefinitions)
    assert(urls.includes(`https://ultraclipart.com/collection/${g.slug}/`));
  const index = sitemapIndex(art, sourceTopics);
  assert(index.includes('/sitemap-pages.xml'));
  assert(index.includes('/sitemap-images.xml'));
  assert(index.includes('/sitemap-collections.xml'));
});
