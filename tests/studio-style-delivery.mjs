import test from 'node:test';
import assert from 'node:assert/strict';
import { studioStylePatch, studioStyleRequest } from '../server/delivery/studio-styles.mjs';
const css = '.uc-editor {overflow-y:auto}',
  version = 'a'.repeat(16),
  patch = studioStylePatch(css, version);
class Rewriter {
  on(selector, handler) {
    assert.equal(selector, 'head');
    this.handler = handler;
    return this;
  }
  async transform(response) {
    let insert = '';
    this.handler.element({
      append(s, options) {
        assert.equal(options.html, true);
        insert = s;
      },
    });
    return new Response((await response.text()).replace('</head>', insert + '</head>'), {
      status: response.status,
      headers: response.headers,
    });
  }
}
const request = (path, init) => new Request('https://ultraclipart.com' + path, init);
const response = () =>
  new Response('<head><script src="/kept.js"></script></head><h1>Scene</h1>', {
    headers: {
      'Content-Type': 'text/html',
      'Content-Length': '123',
      ETag: '"original"',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
    },
  });
test('only successful Studio HTML receives source-bound styles; source scripts and headings are preserved', async () => {
  for (const path of ['/create/', '/edit/test-scene/']) {
    const r = await patch(request(path), response(), Rewriter);
    const html = await r.text();
    assert(html.includes(css));
    assert(html.includes('<h1>Scene</h1>'));
    assert(html.includes('src="/kept.js"'));
    assert.equal(r.headers.get('Content-Length'), null);
    assert.equal(r.headers.get('X-UC-Studio-Style'), version);
    assert.equal(
      r.headers.get('Content-Security-Policy'),
      "default-src 'self'; style-src 'self' 'unsafe-inline'",
    );
  }
});
test('API, other pages, failures and non-HTML responses are untouched', async () => {
  for (const path of ['/art/test/', '/api/ai/run', '/search/']) {
    const original = response();
    assert.equal(await patch(request(path), original, Rewriter), original);
  }
  const failure = new Response('outage', { status: 503 });
  assert.equal(await patch(request('/create/'), failure, Rewriter), failure);
  const json = Response.json({ status: 'ok' });
  assert.equal(await patch(request('/create/'), json, Rewriter), json);
});
test('new representation ETag prevents stale pre-patch HTML surviving a 304', async () => {
  const original = request('/create/', {
      headers: {
        'If-None-Match': '"original"',
        'If-Modified-Since': 'yesterday',
        Cookie: 'keep=1',
      },
    }),
    normalized = studioStyleRequest(original);
  assert.equal(normalized.headers.get('If-None-Match'), null);
  assert.equal(normalized.headers.get('If-Modified-Since'), null);
  assert.equal(normalized.headers.get('Cookie'), 'keep=1');
  const first = await patch(original, response(), Rewriter);
  assert.equal(first.status, 200);
  const etag = first.headers.get('ETag');
  assert.notEqual(etag, '"original"');
  const cached = await patch(
    request('/create/', { headers: { 'If-None-Match': etag } }),
    response(),
    Rewriter,
  );
  assert.equal(cached.status, 304);
  const head = await patch(request('/create/', { method: 'HEAD' }), response(), Rewriter);
  assert.equal(head.headers.get('Content-Length'), null);
  assert.equal(await head.text(), '');
  const api = request('/api/ai/run', { headers: { 'If-None-Match': 'keep' } });
  assert.equal(studioStyleRequest(api), api);
});
