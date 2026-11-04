import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSingleFlight } from '../server/catalog-snapshot/render-single-flight.mjs';
const html = (text, headers = {}) =>
  new Response(text, { headers: { 'content-type': 'text/html', ...headers } });
test('simultaneous requests share only their exact captured renderer/root route', async () => {
  const cache = {},
    calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const render = async () => {
    calls.push('render');
    await gate;
    return html('verified original');
  };
  const a = renderSingleFlight(cache, 'renderer/root-a/art/one', render);
  const b = renderSingleFlight(cache, 'renderer/root-a/art/one', render);
  const c = renderSingleFlight(cache, 'renderer/root-b/art/one', render);
  const d = renderSingleFlight(cache, 'other-renderer/root-a/art/one', render);
  assert.equal(calls.length, 3);
  release();
  for (const response of await Promise.all([a, b, c, d]))
    assert.equal(await response.text(), 'verified original');
  assert.equal(calls.length, 3);
});
test('personalized, failed and non-HTML renders are never shared', async () => {
  for (const kind of ['personal', 'failed', 'json']) {
    let calls = 0,
      release;
    const gate = new Promise((r) => (release = r)),
      cache = {};
    const render = async () => {
      const n = ++calls;
      await gate;
      return kind === 'personal'
        ? html('visitor ' + n, { 'set-cookie': 'private=' + n })
        : new Response('result ' + n, {
            status: kind === 'failed' ? 503 : 200,
            headers: { 'content-type': kind === 'json' ? 'application/json' : 'text/html' },
          });
    };
    const one = renderSingleFlight(cache, 'same', render),
      two = renderSingleFlight(cache, 'same', render);
    release();
    const results = await Promise.all([one, two]);
    assert.equal(calls, 2);
    assert.notEqual(await results[0].text(), await results[1].text());
  }
});
test('render failure releases the pending slot and a later request can recover', async () => {
  const cache = {};
  let release;
  const gate = new Promise((r) => (release = r));
  const a = renderSingleFlight(cache, 'same', async () => {
    await gate;
    throw Error('read failed');
  });
  const b = renderSingleFlight(cache, 'same', () => html('must not run'));
  release();
  const results = await Promise.allSettled([a, b]);
  assert(results.every((r) => r.status === 'rejected'));
  assert.equal(
    await (await renderSingleFlight(cache, 'same', () => html('recovered'))).text(),
    'recovered',
  );
});
