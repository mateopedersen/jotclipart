import test from 'node:test';
import assert from 'node:assert/strict';
import { assignMissingTopicIdentifiers } from '../scripts/topic-identifiers.mjs';
test('missing and JSON-null imported IDs cannot poison future numeric allocation', () => {
  const base = [{ slug: 'base', id: 20 }],
    incoming = [
      { slug: 'accepted', id: 82 },
      { slug: 'missing' },
      { slug: 'null', id: null },
      { slug: 'placeholder', id: 0 },
    ],
    before = JSON.stringify(incoming),
    r = assignMissingTopicIdentifiers(base, incoming);
  assert.deepEqual(
    r.extra.map((t) => t.id),
    [82, 83, 84, 85],
  );
  assert.equal(r.nextId, 86);
  assert.equal(JSON.stringify(incoming), before);
  assert.deepEqual(assignMissingTopicIdentifiers(base, r.extra).changes, []);
});
test('accepted identity collisions and duplicate public slugs require reconciliation', () => {
  assert.throws(
    () => assignMissingTopicIdentifiers([{ slug: 'a', id: 1 }], [{ slug: 'b', id: 1 }]),
    /Duplicate accepted/,
  );
  assert.throws(
    () => assignMissingTopicIdentifiers([{ slug: 'a', id: 1 }], [{ slug: 'a' }]),
    /Duplicate topic/,
  );
  assert.throws(() => assignMissingTopicIdentifiers([{ slug: 'a' }], []), /primary/);
});
