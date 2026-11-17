import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedArrayMember } from '../scripts/catalog-snapshot/array-member-source.mjs';
test('selecting one verified topic preserves nested JSON, escaped quotes and original source bytes', () => {
  const rows = [
    {
      slug: 'first',
      rawItems: [{ description: 'Braces } and { in strings, escaped quote " and backslash \\' }],
    },
    {
      slug: 'wanted',
      nested: [{ slug: 'other', value: [{}, ['x']] }],
      rawItems: [{ text: 'A \\" } { pattern' }],
    },
  ];
  for (const spacing of [undefined, 2]) {
    const bytes = Buffer.from(JSON.stringify(rows, null, spacing)),
      copy = Buffer.from(bytes);
    assert.deepEqual(verifiedArrayMember(bytes, 'slug', 'wanted'), rows[1]);
    assert(bytes.equals(copy));
  }
  assert.throws(
    () => verifiedArrayMember(Buffer.from(JSON.stringify(rows)), 'slug', 'absent'),
    /absent/,
  );
});
