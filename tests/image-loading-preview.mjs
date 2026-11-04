import test from 'node:test';
import assert from 'node:assert/strict';
import { imageLoadingPreview, loadingPreviewStyle } from '../src/lib/image-loading-preview.ts';
const item = {
  webp: 'https://assets.ultraclipart.com/subject/original.aaa.webp',
  originalThumb: 'https://assets.ultraclipart.com/subject/thumb.bbb.webp',
  files: { webp: { sha256: 'a'.repeat(64) }, thumb: { sha256: 'b'.repeat(64) } },
};
test('a source-bound temporary background keeps the original distinct from its thumbnail', () => {
  assert.deepEqual(imageLoadingPreview(item), { source: item.webp, url: item.originalThumb });
  assert.equal(
    loadingPreviewStyle(imageLoadingPreview(item)),
    '--original-loading-preview:url("' + item.originalThumb + '")',
  );
  assert.equal(loadingPreviewStyle(undefined), undefined);
});
test('missing proof, a different original, credentials and unrelated hosts cannot become a placeholder', () => {
  assert.equal(imageLoadingPreview(item, 'https://assets.ultraclipart.com/other.svg'), undefined);
  for (const originalThumb of [
    undefined,
    item.webp,
    '/local.webp',
    'data:image/webp;base64,AAAA',
    'https://example.com/thumb.webp',
    'https://user:secret@assets.ultraclipart.com/thumb.webp',
    'https://assets.ultraclipart.com:8443/thumb.webp',
  ])
    assert.equal(imageLoadingPreview({ ...item, originalThumb }), undefined);
  assert.equal(imageLoadingPreview({ ...item, files: { webp: item.files.webp } }), undefined);
  assert.equal(imageLoadingPreview({ ...item, files: { thumb: item.files.thumb } }), undefined);
});
