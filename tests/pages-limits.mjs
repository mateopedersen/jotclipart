import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPagesFileCount, PAGES_FILE_LIMIT } from '../src/lib/pages-limits.ts';

test('the verified Pages Free entitlement rejects overflow without treating R2 routes as files', () => {
  assert.equal(PAGES_FILE_LIMIT, 20_000);
  for (const count of [0, 1, 19_999, 20_000])
    assert.doesNotThrow(() => assertPagesFileCount(count));
  for (const count of [20_001, 99_999, 100_000, 100_001])
    assert.throws(() => assertPagesFileCount(count), /Pages Free file limit exceeded/);
});

test('an invalid count cannot bypass the file ceiling', () => {
  for (const count of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => assertPagesFileCount(count), /safe integer/);
});
