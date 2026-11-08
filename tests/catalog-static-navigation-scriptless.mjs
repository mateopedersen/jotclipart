// Additive proposal only. Parent/publisher runs against the finalized source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { staticNavigationPolicy } from '../server/catalog-snapshot/static-navigation-policy.mjs';
const token = "'sha256-" + 'A'.repeat(43) + "='";
const sharePolicy = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const html = (csp, status = 200, body = '<p>exact bytes</p>', extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html;charset=utf-8',
    'content-security-policy': csp, 'cache-control': 'private, no-store',
    etag: '"unchanged"', ...extra } });
test('intentionally scriptless policy returns the SAME response and adds no permission', async () => {
  for (const csp of [sharePolicy, "script-src 'none'",
    "default-src 'self'; script-src 'none'; script-src-elem 'none'; script-src-attr 'none'",
    "default-src 'none'; script-src-elem 'none'; script-src-attr 'none'"])
    for (const status of [200, 404]) {
      const original = html(csp, status);
      const output = staticNavigationPolicy(original, token);
      assert.equal(output, original);
      assert.equal(output.headers.get('content-security-policy'), csp);
      assert.equal(output.headers.get('cache-control'), 'private, no-store');
      assert.equal(output.headers.get('etag'), '"unchanged"');
      assert.equal(await output.text(), '<p>exact bytes</p>');
    }
  const head = html(sharePolicy, 200, null);
  assert.equal(staticNavigationPolicy(head, token), head);
  assert.equal(await head.text(), '');
  const encoded = html(sharePolicy, 200, new Uint8Array([31,139,8,0]),
    { 'content-encoding': 'gzip', 'content-length': '4' });
  assert.equal(staticNavigationPolicy(encoded, token), encoded);
  assert.deepEqual(new Uint8Array(await encoded.arrayBuffer()), new Uint8Array([31,139,8,0]));
  assert.equal(encoded.headers.get('content-encoding'), 'gzip');
  assert.equal(encoded.headers.get('content-length'), '4');
});
test('missing, executable, duplicate and multi-policy cases never enter scriptless bypass', () => {
  for (const csp of ['', "default-src *", "default-src 'none'; script-src-elem https:",
    "default-src 'none'; script-src-attr 'unsafe-inline'",
    "script-src 'unsafe-eval'; script-src-elem 'none'; script-src-attr 'none'",
    "default-src 'none'; default-src *",
    "script-src 'none'; script-src *",
    "script-src 'none', script-src *",
    "default-src 'none'; SCRIPT-SRC-ATTR 'unsafe-inline'"])
    assert.throws(() => staticNavigationPolicy(html(csp), token), /Reviewed legacy script policy required/);
  assert.throws(() => staticNavigationPolicy(html(sharePolicy), 'bad'), /Exact compiled navigation script digest required/);
});
test('reviewed legacy self policy still gets exact single hash; permissive/missing policy still fails', async () => {
  const csp = "default-src 'self'; script-src 'self' 'sha256-old'; style-src 'self' 'unsafe-inline'";
  const original = html(csp);
  const output = staticNavigationPolicy(original, token);
  assert.notEqual(output, original);
  assert.equal(output.headers.get('content-security-policy'),
    csp.replace("script-src 'self' 'sha256-old'", "script-src 'self' 'sha256-old' " + token));
  assert.equal(await output.clone().text(), '<p>exact bytes</p>');
  const repeated = staticNavigationPolicy(output, token);
  assert.equal(repeated.headers.get('content-security-policy').split(token).length, 2);
  assert.throws(() => staticNavigationPolicy(html("script-src 'self' 'unsafe-inline'"), token));
});

