import test from 'node:test';
import assert from 'node:assert/strict';
import { originalGoalArtworkIds } from '../scripts/original-goal-counts.mjs';
const topics = [{ slug: 'year', target_original_artworks: 50 }],
  art = Array.from({ length: 100 }, (_, i) => ({
    id: 'year-' + i,
    topic: 'year',
    productionMethod: 'generated-raster',
  }));
const allocation = {
  schema: 1,
  topics: {
    year: {
      ownerApprovedTarget: 100,
      original110Allocation: 50,
      originalGoalArtworkIds: art.slice(0, 50).map((a) => a.id),
      supplementalArtworkIds: art.slice(50).map((a) => a.id),
    },
  },
};
test('approved one-hundred collection contributes fifty stable IDs to the original target', () => {
  const ids = originalGoalArtworkIds(art, topics, allocation);
  assert.equal(ids.size, 50);
  assert(ids.has('year-49'));
  assert(!ids.has('year-50'));
  assert.deepEqual(
    [...originalGoalArtworkIds([...art].reverse(), topics, allocation)].sort(),
    [...ids].sort(),
  );
});
test('repairs retaining IDs, partial publication and owner-supplied content cannot inflate the goal', () => {
  const partial = art.slice(0, 12).map((a) => ({ ...a, revision: 2 }));
  assert.equal(originalGoalArtworkIds(partial, topics, allocation).size, 12);
  assert.equal(
    originalGoalArtworkIds(
      [...partial, { id: 'owner-x', topic: 'year', productionMethod: 'owner-supplied' }],
      topics,
      allocation,
    ).size,
    12,
  );
  assert.throws(
    () => originalGoalArtworkIds([...partial, partial[0]], topics, allocation),
    /Duplicate/,
  );
});
test('unapproved expansion, overlapping allocations and unrelated IDs are rejected', () => {
  assert.throws(() => originalGoalArtworkIds(art, topics), /Unallocated/);
  const overlap = structuredClone(allocation);
  overlap.topics.year.supplementalArtworkIds[0] = 'year-0';
  assert.throws(() => originalGoalArtworkIds(art, topics, overlap), /two goal allocations/);
  assert.throws(
    () =>
      originalGoalArtworkIds(
        [...art, { id: 'year-unplanned', topic: 'year', productionMethod: 'generated-raster' }],
        topics,
        allocation,
      ),
    /Unplanned/,
  );
  const supplied = structuredClone(art);
  supplied[0].productionMethod = 'owner-supplied';
  assert.throws(() => originalGoalArtworkIds(supplied, topics, allocation), /Owner-supplied/);
});
