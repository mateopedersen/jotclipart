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

test('public resolution keeps exact approved raw definitions and corrects only a known copied note', async () => {
  const { publicTopicDefinitions } = await import('../scripts/topic-identifiers.mjs');
  const primary = [{ id: 1, slug: 'accepted' }],
    extra = [
      { slug: 'italy-flag', focus_note: 'Nepal flag displays and community illustrations.' },
      { slug: 'nepal-flag', focus_note: 'Nepal flag displays and community illustrations.' },
    ],
    before = JSON.stringify(extra),
    summary = 'Catalog checked Italian flag summary.';
  const rows = publicTopicDefinitions(primary, extra, new Map([['italy-flag', summary]]));
  assert.equal(rows.find((t) => t.slug === 'italy-flag').focus_note, summary);
  assert.equal(rows.find((t) => t.slug === 'nepal-flag').focus_note, extra[1].focus_note);
  assert.equal(new Set(rows.map((t) => t.id)).size, 3);
  assert.equal(JSON.stringify(extra), before);
});
