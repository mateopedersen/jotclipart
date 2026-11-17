import test from 'node:test';
import assert from 'node:assert/strict';
import { contentPresentationOptions } from '../scripts/catalog-snapshot/content-presentation-options.mjs';
const packet = {
  changes: [
    { id: 'kept', record: {} },
    { id: 'withdrawn', record: null },
  ],
  topicChanges: [
    { slug: 'kept-topic', record: {} },
    { slug: 'empty-topic', record: null },
  ],
};
test('historical capsules retain their complete default preparation policy', () =>
  assert.deepEqual(contentPresentationOptions(packet), {}));
test('bounded preparation prioritizes only real changed eligible records', () =>
  assert.deepEqual(
    contentPresentationOptions({
      ...packet,
      presentationPreparation: { maxRoutes: 64, maxOutputBytes: 16 * 1024 * 1024 },
    }),
    {
      maxRoutes: 64,
      maxOutputBytes: 16 * 1024 * 1024,
      priorityArtworkIDs: ['kept'],
      priorityTopics: ['kept-topic'],
    },
  ));
test('preparation bounds cannot disable core coverage, expand limits or inject routes', () => {
  for (const options of [
    null,
    { maxRoutes: 0, maxOutputBytes: 1048576 },
    { maxRoutes: 9, maxOutputBytes: 1048576 },
    { maxRoutes: 1537, maxOutputBytes: 1048576 },
    { maxRoutes: 64, maxOutputBytes: 128 * 1024 * 1024 + 1 },
    { maxRoutes: 64, maxOutputBytes: 1048575 },
    { maxRoutes: 64, maxOutputBytes: 1048576, priorityArtworkIDs: ['foreign'] },
  ])
    assert.throws(
      () => contentPresentationOptions({ ...packet, presentationPreparation: options }),
      /bounded presentation/,
    );
});
