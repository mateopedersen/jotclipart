import test from 'node:test';
import assert from 'node:assert/strict';
import { homeImageCandidates } from '../src/lib/home-image-candidates.ts';
const item = {
  webp: 'https://assets.ultraclipart.com/art/full.webp',
  originalThumb: 'https://assets.ultraclipart.com/art/small.webp',
  files: { webp: { sha256: 'a'.repeat(64) }, thumb: { sha256: 'b'.repeat(64) } },
};
test('homepage opts into existing R2 density sources without mutating originals', () => {
  const before = structuredClone(item);
  assert.equal(homeImageCandidates(item), `${item.originalThumb} 1x, ${item.webp} 2x`);
  assert.deepEqual(item, before);
});
test('missing source proof and external candidate fall back to original-only markup', () => {
  for (const bad of [
    { ...item, files: undefined },
    { ...item, originalThumb: 'https://other.example/small.webp' },
    { ...item, originalThumb: item.webp },
    { ...item, originalThumb: 'https://user:pass@assets.ultraclipart.com/small.webp' },
  ])
    assert.equal(homeImageCandidates(bad), undefined);
});
