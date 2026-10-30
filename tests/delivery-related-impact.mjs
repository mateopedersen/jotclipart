import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadTypescript } from './helpers/typescript.mjs';
import { analyzeRelatedImpact } from '../scripts/delivery/related-impact-core.mjs';
import {
  currentRelatedSnapshot,
  refreshRelatedPreview,
} from '../server/delivery/related-version.mjs';
const { RelatedIndex } = await loadTypescript('src/lib/related/engine.ts');
const { companionSubjects } = await loadTypescript('src/lib/related/taxonomy.ts');
const catalog = JSON.parse(readFileSync('data/art.json'));
function item(id, topic, overrides = {}) {
  const seed =
    catalog.find((a) => a.topic === topic && /crayon/i.test(a.title)) ??
    catalog.find((a) => a.topic === topic);
  assert(seed, `Fixture subject missing: ${topic}`);
  return {
    ...seed,
    id,
    revision: 1,
    createdAt: '2026-10-20T00:00:00Z',
    webp: `/catalog/fixture/${id}.webp`,
    thumb: `/catalog/fixture/${id}-thumb.webp`,
    pdf: `/catalog/fixture/${id}.pdf`,
    ...(seed.svg ? { svg: `/catalog/fixture/${id}.svg` } : {}),
    files: Object.fromEntries(
      Object.keys(seed.files).map((kind) => [
        kind,
        {
          bytes: 100,
          sha256: createHash('sha256')
            .update(id + kind)
            .digest('hex'),
        },
      ]),
    ),
    ...overrides,
  };
}
const analyze = (before, added, exhaustive = true) =>
  analyzeRelatedImpact(
    new RelatedIndex([...before, ...added]),
    new RelatedIndex(before),
    before.map((a) => a.id),
    companionSubjects,
    { exhaustive },
  );

test('unrelated additions change the global marker without needlessly rerendering valid old recommendations', () => {
  const before = [item('apple-one', 'apple'), item('apple-two', 'apple')];
  const result = analyze(before, [item('new-cat', 'cat')]);
  assert.notEqual(result.version, result.previousVersion);
  assert.equal(result.affectedArtworkIds.length, 0);
  assert.equal(result.exhaustiveVerified, true);
});

test('same-subject additions, saturated candidate buckets and ordering changes invalidate every affected source', () => {
  const before = Array.from({ length: 110 }, (_, n) => item(`old-cat-${n}`, 'cat'));
  const added = Array.from({ length: 12 }, (_, n) =>
    item(`new-cat-${n}`, 'cat', { createdAt: '2026-10-30T00:00:00Z' }),
  );
  const result = analyze(before, added);
  assert.equal(result.compared, before.length);
  assert(result.affectedArtworkIds.includes('old-cat-0'));
  assert.equal(result.exhaustiveVerified, true);
});

test('explicit fruit companions, registered collections and new canonical subject topics retain complete dependency coverage', () => {
  const before = ['apple', 'pear', 'strawberry', 'cat', 'winter'].flatMap((topic) =>
    Array.from({ length: 3 }, (_, n) => item(`${topic}-old-${n}`, topic)),
  );
  const result = analyze(before, [item('pear-new', 'pear'), item('winter-new', 'winter')]);
  assert(result.compared >= 6);
  const alternateTopic = [item('old-feline', 'cat', { topic: 'winter' })];
  const canonical = analyze(alternateTopic, [item('new-canonical-cat', 'cat')]);
  assert(canonical.affectedArtworkIds.includes('old-feline'));
});

test('the local adapter changes only the marker, handles quoted attributes and rejects foreign/oversized snapshots', () => {
  const snapshot = {
    sourceId: 'source',
    version: 'before',
    alternatives: [{ id: 'a', title: 'A & B < C' }],
    companions: [],
    collection: [],
  };
  for (const attribute of ['data-related-snapshot', 'data-related-snapshot=""']) {
    const html = `<h1>Original title</h1><script type="application/json" ${attribute}>${JSON.stringify(snapshot).replaceAll('<', '\\u003c')}</script>`;
    const after = refreshRelatedPreview(html, 'source', 'after');
    const parsed = JSON.parse(
      after.slice(after.indexOf('>', after.indexOf('<script')) + 1, after.indexOf('</script>')),
    );
    assert.equal(parsed.version, 'after');
    assert.deepEqual(parsed.alternatives, snapshot.alternatives);
    assert(after.startsWith('<h1>Original title</h1>'));
  }
  assert.throws(
    () => currentRelatedSnapshot(JSON.stringify(snapshot), 'other', 'after'),
    /source differs/,
  );
  assert.throws(() => currentRelatedSnapshot(' '.repeat(512_001), 'source', 'after'), /bound/);
});
