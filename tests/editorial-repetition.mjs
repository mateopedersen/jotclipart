import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedSentences } from '../src/lib/editorial-repetition.mjs';

test('repeated sentences are reported once per artwork without rewriting content', () => {
  const repeated = 'A detailed drawing appears beside the basket.';
  const source = [
    { id: 'a', description: `${repeated} ${repeated}` },
    { id: 'b', description: repeated },
    { id: 'c', description: repeated },
  ];
  assert.deepEqual(repeatedSentences(source), [
    { sentence: repeated, count: 3, ids: ['a', 'b', 'c'] },
  ]);
  assert.equal(source[0].description, `${repeated} ${repeated}`);
  assert.deepEqual(repeatedSentences(source, 4), []);
  assert.throws(() => repeatedSentences(source, 1));
});
