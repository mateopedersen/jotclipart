import test from 'node:test';
import assert from 'node:assert/strict';
import {
  m,
  same,
  memory,
  read,
  put,
  artwork,
  topic,
  context,
  sourceTopic,
  bindContext,
  fixture,
  batch,
  inspect,
} from './fixtures/discovery-projections.mjs';
test('stable pages reuse exact legacy children after insertion, update and deletion', async () => {
  const b = memory(),
    s = m.search.makeStore(b, { writable: true }),
    rows = Array.from({ length: 9 }, (_, i) => ({ id: `r-${i}`, text: 'source ' + i })),
    old = [];
  for (let i = 0; i < 9; i += 3)
    old.push({
      offset: i,
      count: 3,
      ...(await s.put({ type: 'test-rows', offset: i, entries: rows.slice(i, i + 3) })),
    });
  const inserted = [{ id: 'new', text: 'new' }, ...rows],
    one = await m.pages.reconcilePages(s, old, 'test-rows', inserted, { key: (r) => r.id });
  assert.equal(one.metrics.reusedPages, 3);
  assert.equal(one.metrics.stagedPages, 1);
  same((await m.pages.readPages(s, one.pages, 'test-rows', { stable: true })).entries, inserted);
  await assert.rejects(m.pages.readPages(s, one.pages, 'test-rows'));
  const edited = inserted.map((r) => (r.id === 'r-4' ? { ...r, text: 'edited' } : r)),
    two = await m.pages.reconcilePages(s, one.pages, 'test-rows', edited, {
      stable: true,
      key: (r) => r.id,
    });
  assert.equal(two.metrics.reusedPages, 3);
  same((await m.pages.readPages(s, two.pages, 'test-rows', { stable: true })).entries, edited);
  const three = await m.pages.reconcilePages(s, two.pages, 'test-rows', rows, {
    stable: true,
    key: (r) => r.id,
  });
  same((await m.pages.readPages(s, three.pages, 'test-rows', { stable: true })).entries, rows);
  await assert.rejects(
    m.pages.reconcilePages(s, old, 'test-rows', [rows[0], rows[0]], { key: (r) => r.id }),
  );
  await assert.rejects(m.pages.readPages(s, [old[1]], 'test-rows'));
  const malformed = await s.put({ type: 'test-rows-stable-v2', offset: 0, entries: [rows[0]] });
  await assert.rejects(
    m.pages.readPages(s, [{ count: 1, ...malformed }], 'test-rows', { stable: true }),
  );
});

test('changed-topic discovery refresh updates new, edited, moved and withdrawn source records', async () => {
  let f = await fixture();
  const sequence = [
    {
      changes: [
        {
          id: 'new-one',
          record: artwork('new-one', 'new-subject', {
            monochrome: true,
            monochromeKind: 'silhouette',
            style: 'Silhouette',
          }),
        },
      ],
      slugs: ['new-subject'],
      options: { groups: { 'new-subject': 'New Fixture' } },
    },
    {
      changes: [
        {
          id: 'b-one',
          record: artwork('b-one', 'subject-b', {
            title: 'Private changed title',
            style: 'Outline',
            monochrome: true,
            monochromeKind: 'outline',
            originalThumb: 'https://assets.ultraclipart.com/private-fixture/changed.webp',
          }),
        },
      ],
      slugs: ['subject-b'],
      options: { rename: { 'subject-b': 'Renamed fixture clipart' } },
    },
    {
      changes: [{ id: 'b-two', record: artwork('b-two', 'new-subject') }],
      slugs: ['subject-b', 'new-subject'],
      options: { groups: { 'new-subject': 'New Fixture' } },
    },
    { changes: [{ id: 'b-one', record: null }], slugs: ['subject-b'] },
    {
      changes: [
        { id: 'new-one', record: null },
        { id: 'b-two', record: null },
      ],
      slugs: ['new-subject'],
    },
  ];
  for (const step of sequence) {
    const p = await batch(f, step.changes, step.slugs, step.options),
      result = await m.refresh.refreshDiscoveryViews(p.args),
      out = await inspect(f, result, p.indexes);
    assert.equal(result.publicationVerified, false);
    assert.equal(result.metrics.peakArtworkLookups <= 4, true);
    assert(p.calls.every((id) => step.slugs.includes(p.records.get(id).topic)));
    assert.equal(result.metrics.artworkLookups, p.calls.length);
    const eligible = [...p.records.values()];
    assert.equal(
      out.fields.subjects.reduce((n, t) => n + t.count, 0),
      eligible.length,
    );
    assert.equal(
      out.mono.reduce((n, t) => n + t.count, 0),
      eligible.filter((a) => a.monochrome).length,
    );
    assert.deepEqual(
      out.fields.subjects.map((t) => t.slug).sort(),
      [...new Set(eligible.map((a) => a.topic))].sort(),
    );
    for (const subject of out.fields.subjects) {
      const group = eligible.filter((a) => a.topic === subject.slug);
      assert.equal(subject.count, group.length);
      assert(group.some((a) => a.id === subject.sampleId));
      const cat = out.categories.flatMap((c) => c.topics).find((t) => t.id === subject.slug);
      assert.equal(cat.count, group.length);
      assert.equal(cat.title, subject.name);
      const rosterD = await m.lookup.lookupHashedRecord(
        out.context,
        'collections',
        out.root.catalogPreviewDirectory,
        subject.slug,
      );
      const roster = await out.context.read('collections', rosterD);
      assert.deepEqual(
        roster.ids,
        [...group].sort((a, b) => eligible.indexOf(a) - eligible.indexOf(b)).map((a) => a.id),
      );
    }
    if (step.options?.rename) {
      const s = out.fields.subjects.find((s) => s.slug === 'subject-b');
      assert.equal(s.name, 'Renamed fixture');
      assert.match(out.site.find((s) => s.id === 'topic:subject-b').title, /Renamed fixture/);
      assert(!s.searchKeywords.includes('deliberately stale'));
    }
    f = {
      ...f,
      records: p.records,
      indexes: { ...p.indexes, collections: result.collections, search: result.search },
      context: out.context,
    };
  }
});

test('source mismatch, missing bootstrap, omitted moves and static withdrawal fail before staging', async () => {
  const f = await fixture(),
    p = await batch(
      f,
      [
        {
          id: 'b-one',
          record: artwork('b-one', 'subject-b', { title: 'Updated private fixture' }),
        },
      ],
      ['subject-b'],
    );
  for (const bad of [
    {
      ...p.args,
      readArtwork: async (id) => ({ rootSHA256: '0'.repeat(64), artwork: p.records.get(id) }),
    },
    {
      ...p.args,
      readArtwork: async (id) => ({ ...p.records.get(id), title: 'unbound forged title' }),
    },
    {
      ...p.args,
      topicChanges: p.args.topicChanges.map((t) => ({
        ...t,
        expectedRecordSha256: '0'.repeat(64),
      })),
    },
    {
      ...p.args,
      changes: [
        { id: 'a-two', oldRecord: f.records.get('a-two'), record: artwork('a-two', 'subject-b') },
      ],
    },
    { ...p.args, changes: [{ id: 'a-one', oldRecord: f.records.get('a-one'), record: null }] },
  ]) {
    const before = f.bucket.calls.put.length;
    await assert.rejects(m.refresh.refreshDiscoveryViews(bad));
    assert.equal(f.bucket.calls.put.length, before);
  }
  const old = await f.context.getFacet('collections'),
    noLedger = { ...old };
  delete noLedger.discoveryProjection;
  const missing = await f.cs.put('collections', noLedger),
    before = f.bucket.calls.put.length,
    ctx = await bindContext(f.bucket, { ...f.indexes, collections: missing });
  await assert.rejects(
    m.refresh.refreshDiscoveryViews({ ...p.args, parentContext: ctx }),
    /bootstrap/,
  );
  assert.equal(f.bucket.calls.put.length, before);
});

test('cover and Studio reserves refill from the affected topic beyond the first 500 items', () => {
  const rows = Array.from({ length: 502 }, (_, n) => ({
      n,
      artwork: artwork(`reserve-${n}`, 'reserve-subject', {
        title: `Reserve ${String(n).padStart(4, '0')}`,
        createdAt: '2026-01-01',
      }),
    })),
    t = {
      slug: 'reserve-subject',
      keyword: 'Reserve clipart',
      cluster: 'Fixture',
      sourceCluster: 'Fixture',
    },
    before = m.facts.topicFacts(t, rows),
    after = m.facts.topicFacts(t, rows.slice(1));
  assert.equal(before.studio.length, 500);
  assert.equal(after.studio.length, 500);
  assert(before.studio.includes('reserve-499'));
  assert(!before.studio.includes('reserve-500'));
  assert(after.studio.includes('reserve-500'));
  assert(!after.studio.includes('reserve-0'));
  assert.equal(after.coverId, 'reserve-1');
  const preferred = m.facts.topicFacts(t, rows, { preferredId: 'reserve-501' });
  assert.equal(preferred.coverId, 'reserve-501');
  assert.deepEqual(
    before.first.map((a) => a.n),
    Array.from({ length: 32 }, (_, i) => i),
  );
});

test('canonical topic substitution and conflicting recent totals never stage projection objects', async () => {
  const f = await fixture(),
    p = await batch(
      f,
      [{ id: 'b-one', record: artwork('b-one', 'subject-b', { title: 'Updated source only' }) }],
      ['subject-b'],
    );
  const original = p.args.afterTopic;
  let before = f.bucket.calls.put.length;
  await assert.rejects(
    m.refresh.refreshDiscoveryViews({
      ...p.args,
      afterTopic: async (slug) => ({
        ...(await original(slug)),
        title: 'Substituted unbound title',
      }),
    }),
    /source differs/,
  );
  assert.equal(f.bucket.calls.put.length, before);
  const recent = await p.after.getFacet('recent'),
    ledger = await f.rs.get(recent.ledger),
    wrongLedger = await f.rs.put({ ...ledger, total: ledger.total + 1 }),
    wrongRecent = await f.rs.put({ ...recent, ledger: wrongLedger }),
    wrong = await bindContext(f.bucket, { ...p.indexes, recent: wrongRecent });
  before = f.bucket.calls.put.length;
  await assert.rejects(
    m.refresh.refreshDiscoveryViews({
      ...p.args,
      context: wrong,
      readArtwork: async (id) => ({ rootSHA256: wrong.rootSHA256, artwork: p.records.get(id) }),
    }),
    /recent totals differ/,
  );
  assert.equal(f.bucket.calls.put.length, before);
});
