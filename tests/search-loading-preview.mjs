import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardMetadata } from '../src/lib/search-index.ts';
import { searchPreviewFromPinnedAsset } from '../src/scripts/search-previews.ts';

const webp = 'https://assets.ultraclipart.com/airbus/original.1.webp';
const thumb = 'https://assets.ultraclipart.com/airbus/thumb.2.webp';
const file = { sha256: 'a'.repeat(64), bytes: 472000 };
const item = {
  id: 'airbus-1',
  title: 'Aircraft',
  alt: 'Side view of an aircraft',
  webp,
  thumb: webp,
  originalThumb: thumb,
  files: { webp: file, thumb: { sha256: 'b'.repeat(64) } },
  download: { files: { webp: file } },
};
const asset = { id: item.id, webp: { url: webp, ...file }, thumb };

test('new search projections include verified thumbnails while preserving the original', () => {
  const card = cardMetadata(item);
  assert.equal(card.webp, webp);
  assert.equal(card.thumb, webp);
  assert.deepEqual(card.loadingPreview, { source: webp, url: thumb });
  assert.equal(cardMetadata({ ...item, files: { webp: file } }).loadingPreview, undefined);
  assert.equal(cardMetadata({ ...item, originalThumb: webp }).loadingPreview, undefined);
});

test('legacy search previews require the same identity, source URL, byte count and SHA', () => {
  assert.deepEqual(searchPreviewFromPinnedAsset(item, asset), { source: webp, url: thumb });
  for (const candidate of [
    null,
    { ...asset, id: 'airbus-2' },
    { ...asset, webp: { ...asset.webp, bytes: 12 } },
    { ...asset, webp: { ...asset.webp, sha256: 'b'.repeat(64) } },
    { ...asset, webp: { ...asset.webp, url: thumb } },
    { ...asset, thumb: 'https://another.example/thumb.webp' },
    { ...asset, thumb: webp },
  ]) {
    assert.equal(searchPreviewFromPinnedAsset(item, candidate), undefined);
  }
});
