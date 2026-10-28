import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { encodeLocalBatch } from '../scripts/delivery/local-batch.mjs';
import { stagingWorker } from '../scripts/delivery/staging-worker.mjs';
import { merkle, digest } from '../scripts/delivery/manifest.mjs';

test('local batch proves and independently reads back each of 64 exact files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-local-batch-'));
  try {
    mkdirSync(join(dir, 'art'));
    const contents = Array.from({ length: 64 }, (_, i) => Buffer.from(`reviewed ${i}`));
    const records = contents.map((bytes, i) => ({ path: `/art/${i}.html`, key: `release/${i}.html`, bytes: bytes.length, sha256: digest(bytes), mime: 'text/html' }));
    records.forEach((r, i) => writeFileSync(join(dir, r.path), contents[i]));
    const tree = merkle(records), secret = 'a'.repeat(64), accountId = 'b'.repeat(32), bucket = 'test';
    const lease = { root: tree.root, accountId, bucket, projectedBytes: 1000, observedAt: Date.now() };
    const body = { lease, signature: createHmac('sha256', Buffer.from(secret, 'hex')).update(JSON.stringify(lease)).digest('hex'), records: records.map((record, i) => ({ record, proof: tree.proof(i) })) };
    const encoded = encodeLocalBatch(dir, body), unpacked = JSON.parse(gunzipSync(encoded));
    assert.equal(Object.keys(unpacked.blobs).length, 64);
    const objects = new Map(); let puts = 0, reads = 0;
    const env = { TARGET: { get: async key => { reads++; const value = objects.get(key); return value && { size: value.length, httpMetadata: { contentType: 'text/html' }, etag: 'test', arrayBuffer: async () => value }; }, put: async (key, value, options) => { assert.equal(options.onlyIf.etagDoesNotMatch, '*'); puts++; objects.set(key, Buffer.from(value)); } } };
    const worker = stagingWorker({ root: tree.root, accountId, bucket, revision: 'c'.repeat(40), secret });
    const tampered = structuredClone(body);
    tampered.records[63].record.key = 'unreviewed/key';
    const badProof = new Request('https://private.example/stage', { method: 'POST', headers: { 'X-UC-Body-Encoding': 'gzip' }, body: encodeLocalBatch(dir, tampered) });
    assert.equal((await worker.fetch(badProof, env)).status, 403);
    assert.equal(puts, 0);
    const stale = { ...body, lease: { ...lease, observedAt: Date.now() - 46_000 } };
    const expired = new Request('https://private.example/stage', { method: 'POST', headers: { 'X-UC-Body-Encoding': 'gzip' }, body: encodeLocalBatch(dir, stale) });
    assert.equal((await worker.fetch(expired, env)).status, 409);
    assert.equal(puts, 0);
    const tooMany = new Request('https://private.example/stage', { method: 'POST', body: JSON.stringify({ ...body, records: [...body.records, body.records[0]] }) });
    assert.equal((await worker.fetch(tooMany, env)).status, 400);
    assert.equal(puts, 0);
    const req = new Request('https://private.example/stage', { method: 'POST', headers: { 'X-UC-Body-Encoding': 'gzip' }, body: encoded });
    const response = await worker.fetch(req, env); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.verified.length, 64); assert.equal(puts, 64); assert.equal(reads, 128);
    for (const record of records) assert.equal(digest(objects.get(record.key)), record.sha256);
    assert.throws(() => encodeLocalBatch(dir, { ...body, records: [...body.records, body.records[0]] }), /one to 64/);
    const duplicate = { ...body, records: [body.records[0], body.records[0]] };
    assert.throws(() => encodeLocalBatch(dir, duplicate), /duplicate/);
    writeFileSync(join(dir, records[0].path), 'changed');
    assert.throws(() => encodeLocalBatch(dir, body), /size changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
