import test from 'node:test';
import assert from 'node:assert/strict';
import { readCommittedCatalog } from '../scripts/delivery/activate.mjs';

const revision = 'a'.repeat(40);

test('activation reads a committed catalog larger than the former fixed 64 MB limit', () => {
  const text = ' '.repeat(64_000_001) + '[{"id":"sample"}]';
  const size = Buffer.byteLength(text);
  let calls = 0;
  const run = (program, args, options) => {
    assert.equal(program, 'git');
    assert.equal(args.at(-1), revision + ':data/art.json');
    calls++;
    if (args[0] === 'cat-file') return String(size) + '\n';
    assert.equal(args[0], 'show');
    assert(options.maxBuffer >= size);
    assert(options.maxBuffer > 64_000_000);
    return text;
  };
  assert.deepEqual(readCommittedCatalog(revision, run), [{ id: 'sample' }]);
  assert.equal(calls, 2);
});

test('activation fails closed on invalid size, changed bytes, invalid revision or non-array JSON', () => {
  assert.throws(() => readCommittedCatalog('bad', () => ''), /revision/);
  assert.throws(() => readCommittedCatalog(revision, () => 'not-a-size'), /size/);
  assert.throws(() => readCommittedCatalog(revision, (_p, args) => args[0] === 'cat-file' ? '3' : '[]'), /byte count/);
  assert.throws(() => readCommittedCatalog(revision, (_p, args) => args[0] === 'cat-file' ? '2' : '{}'), /array/);
});
