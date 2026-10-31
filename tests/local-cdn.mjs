import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeLocalCdn, markLocalCdnTeardown } from './helpers/local-cdn.mjs';

test('only disposed responses during explicit teardown are tolerated', async () => {
  const previous = process.env.LOCAL_CDN_BRIDGE;
  process.env.LOCAL_CDN_BRIDGE = '1';
  try {
    const context = { async route(_pattern, handler) { this.handler = handler; } };
    assert.equal(await bridgeLocalCdn(context, 'http://127.0.0.1:1234'), true);
    let failure = Error('route.fulfill: Fetch response has been disposed');
    const route = {
      request: () => ({ method: () => 'GET' }),
      fetch: async () => ({ headers: () => ({}) }),
      fulfill: async () => { throw failure; },
    };
    await assert.rejects(context.handler(route), /Fetch response has been disposed/);
    markLocalCdnTeardown(context);
    await assert.doesNotReject(context.handler(route));
    failure = Error('Request context disposed');
    await assert.doesNotReject(context.handler(route));
    failure = Error('unexpected network failure');
    await assert.rejects(context.handler(route), /unexpected network failure/);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_CDN_BRIDGE;
    else process.env.LOCAL_CDN_BRIDGE = previous;
  }
});
