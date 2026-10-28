import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detailPreviewImage } from '../scripts/seo/detail-preview.mjs';

test('finds the image within an anchor or a picture-wrapped preview', () => {
  const img = '<img alt="Cat" title="Cat">';
  assert.equal(detailPreviewImage(`<a id="art-preview">${img}</a>`), img);
  assert.equal(detailPreviewImage(`<div id="art-preview"><picture>${img}</picture></div>`), img);
});

test('does not substitute a later unrelated image for an empty or missing preview', () => {
  assert.equal(detailPreviewImage('<a id="art-preview"></a><img alt="unrelated">'), '');
  assert.equal(detailPreviewImage('<img alt="unrelated">'), '');
});
