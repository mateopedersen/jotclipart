import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({
  entryPoints: ['src/editor/studio-sources.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const bucketBuild = await build({
  entryPoints: ['src/editor/studio-bucket.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const dataUrl = (text) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const { studioBucket } = await import(dataUrl(bucketBuild.outputFiles[0].text));
let sequence = 0;
const fresh = () => import(dataUrl(result.outputFiles[0].text) + '#' + sequence++);
const source = (id) => ({
  id,
  width: 100,
  height: 100,
  webp: { url: '/original.webp', bytes: 10, sha256: 'a'.repeat(64) },
  pdf: { url: '/original.pdf', bytes: 20, sha256: 'b'.repeat(64) },
});
const json = (value) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('an opened project fetches only its source buckets and retains verification facts', async () => {
  const original = globalThis.fetch,
    calls = [],
    item = source('test-robot');
  const bucket = studioBucket(item.id),
    url = `/studio-data/${bucket}.json`;
  globalThis.fetch = async (path) => {
    calls.push(path);
    return json(
      path === '/studio-manifest.json' ? { schema: 1, buckets: { [bucket]: url } } : [item],
    );
  };
  try {
    const { lookupRasterAssets } = await fresh();
    assert.deepEqual(await lookupRasterAssets([item.id, item.id]), [item, item]);
    assert.deepEqual(await lookupRasterAssets([item.id]), [item]);
    assert.deepEqual(calls, ['/studio-manifest.json', url]);
  } finally {
    globalThis.fetch = original;
  }
});

test('cross-wired chunks fail closed and can be retried without a poisoned cache', async () => {
  const original = globalThis.fetch,
    item = source('test-robot'),
    bucket = studioBucket(item.id);
  const wrong = source('unrelated-apple');
  assert.notEqual(studioBucket(wrong.id), bucket);
  let attempts = 0;
  globalThis.fetch = async (path) =>
    json(
      path === '/studio-manifest.json'
        ? { schema: 1, buckets: { [bucket]: `/studio-data/${bucket}.json` } }
        : [++attempts === 1 ? wrong : item],
    );
  try {
    const { lookupRasterAssets } = await fresh();
    await assert.rejects(lookupRasterAssets([item.id]), /chunk is invalid/);
    assert.deepEqual(await lookupRasterAssets([item.id]), [item]);
  } finally {
    globalThis.fetch = original;
  }
});

test('untrusted source URLs and missing IDs cannot substitute another artwork', async () => {
  const original = globalThis.fetch,
    bucket = studioBucket('test-robot');
  try {
    globalThis.fetch = async () =>
      json({ schema: 1, buckets: { [bucket]: 'https://example.com/sources.json' } });
    await assert.rejects((await fresh()).lookupRasterAssets(['test-robot']), /unavailable/);
    globalThis.fetch = async (path) =>
      json(
        path === '/studio-manifest.json'
          ? { schema: 1, buckets: { [bucket]: `/studio-data/${bucket}.json` } }
          : [],
      );
    await assert.rejects((await fresh()).lookupRasterAssets(['test-robot']), /unavailable/);
  } finally {
    globalThis.fetch = original;
  }
});

test('failed directory requests remain retryable and invalid IDs never reach the network', async () => {
  const original = globalThis.fetch,
    calls = [];
  globalThis.fetch = async (path) => {
    calls.push(path);
    return new Response('', { status: 503 });
  };
  try {
    const { lookupRasterAssets } = await fresh();
    assert.deepEqual(await lookupRasterAssets([]), []);
    await assert.rejects(lookupRasterAssets(['../not-an-artwork']), /Invalid/);
    assert.equal(calls.length, 0);
    await assert.rejects(lookupRasterAssets(['test-robot']), /could not load/);
    await assert.rejects(lookupRasterAssets(['test-robot']), /could not load/);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('subject browsing loads one small subject, rejects mixed records, and reuses successful data', async () => {
  const original = globalThis.fetch,
    calls = [];
  const item = { ...source('test-robot'), topic: 'robot' };
  let wrong = true;
  globalThis.fetch = async (path) => {
    calls.push(path);
    return json(
      path === '/studio-manifest.json'
        ? { schema: 1, buckets: {}, topics: { robot: '/studio-topics/robot.json' } }
        : [{ ...item, topic: wrong ? 'apple' : 'robot' }],
    );
  };
  try {
    const { lookupTopicAssets } = await fresh();
    await assert.rejects(lookupTopicAssets('../invalid'), /Invalid/);
    assert.equal(calls.length, 0);
    await assert.rejects(lookupTopicAssets('robot'), /chunk is invalid/);
    wrong = false;
    assert.deepEqual(await lookupTopicAssets('robot'), [item]);
    assert.deepEqual(await lookupTopicAssets('robot'), [item]);
    assert.deepEqual(calls, [
      '/studio-manifest.json',
      '/studio-topics/robot.json',
      '/studio-topics/robot.json',
    ]);
    await assert.rejects(lookupTopicAssets('unknown'), /unavailable/);
  } finally {
    globalThis.fetch = original;
  }
});
