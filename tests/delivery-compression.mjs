import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { compressHtml } from '../server/delivery/compress-html.mjs';

const html = '<!doctype html><p>UltraClipart &amp; ideas</p>'.repeat(2000);
const source = (headers = {}) => new Response(html, {
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(Buffer.byteLength(html)), ETag: '"original"', 'Cache-Control': 'no-transform', ...headers },
});
const req = (headers = {}, method = 'GET') => new Request('https://example.com/', { method, headers });

test('gzip HTML preserves the decoded bytes and safety headers', async () => {
  const result = compressHtml(req({ 'Accept-Encoding': 'br, gzip' }), source());
  assert.equal(result.headers.get('Content-Encoding'), 'gzip');
  assert.equal(result.headers.get('Vary'), 'Accept-Encoding');
  assert.equal(result.headers.get('Cache-Control'), 'no-transform');
  assert.equal(result.headers.get('Content-Length'), null);
  assert.equal(result.headers.get('ETag'), null);
  const bytes = Buffer.from(await result.arrayBuffer());
  assert.equal(gunzipSync(bytes).toString(), html);
  assert.ok(bytes.length < Buffer.byteLength(html) / 5);
});
test('identity and explicitly disabled gzip preserve uncompressed data and validators', async () => {
  for (const value of ['', 'gzip;q=0, *;q=1', 'br']) {
    const result = compressHtml(req({ 'Accept-Encoding': value }), source({ Vary: 'Origin' }));
    assert.equal(await result.text(), html);
    assert.equal(result.headers.get('ETag'), '"original"');
    assert.equal(result.headers.get('Vary'), 'Origin, Accept-Encoding');
    assert.equal(result.headers.get('Content-Encoding'), null);
  }
});
test('HEAD advertises the encoded representation without a body', async () => {
  const result = compressHtml(req({ 'Accept-Encoding': 'gzip' }, 'HEAD'), source());
  assert.equal(result.headers.get('Content-Encoding'), 'gzip');
  assert.equal(await result.text(), '');
});
test('ranges, already encoded responses, images and non-success responses are untouched', () => {
  for (const [request, response] of [
    [req({ Range: 'bytes=0-10', 'Accept-Encoding': 'gzip' }), source()],
    [req({ 'Accept-Encoding': 'gzip' }), source({ 'Content-Encoding': 'br' })],
    [req({ 'Accept-Encoding': 'gzip' }), new Response('image', { headers: { 'Content-Type': 'image/webp' } })],
    [req({ 'Accept-Encoding': 'gzip' }), new Response('missing', { status: 404, headers: { 'Content-Type': 'text/html' } })],
  ]) assert.equal(compressHtml(request, response), response);
});
