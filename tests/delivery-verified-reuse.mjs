import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { merkle, digest } from '../scripts/delivery/manifest.mjs';
import { verifiedReuse } from '../scripts/delivery/verified-reuse.mjs';
import { stagingWorker } from '../scripts/delivery/staging-worker.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'uc-verified-reuse-')),
    revision = 'a'.repeat(40);
  const bytes = Buffer.from('accepted original preview');
  const record = {
    path: '/previews/p1/source.webp',
    key: 'delivery/previews/p1/source.webp',
    bytes: bytes.length,
    sha256: digest(bytes),
    mime: 'image/webp',
  };
  const tree = merkle([record]);
  const manifest = {
    schema: 1,
    revision,
    bucket: 'ultraclipart-pages',
    status: 'remote-byte-verified',
    files: [record],
    verified: 1,
    root: tree.root,
  };
  const production = { liveDelivery: { renderedRevision: revision, verifiedRoot: tree.root } };
  const directory = join(root, 'work/delivery', revision);
  mkdirSync(directory, { recursive: true });
  const write = (m = manifest, receipt = { ...record, root: tree.root, etag: 'accepted-etag' }) => {
    writeFileSync(join(directory, 'verified-manifest.json'), JSON.stringify(m));
    writeFileSync(join(directory, 'verified.jsonl'), JSON.stringify(receipt) + '\n');
  };
  write();
  return {
    root,
    bytes,
    record,
    tree,
    manifest,
    production,
    directory,
    write,
    records: [{ record, proof: tree.proof(0) }],
  };
}

test('only matching accepted immutable records with real prior receipts acquire reuse proofs', async () => {
  const f = fixture();
  try {
    const reuse = await verifiedReuse(f.root, f.records, f.production);
    assert.equal(reuse.count, 1);
    assert.equal(reuse.attach(f.records[0]).prior.etag, 'accepted-etag');
    for (const changes of [
      { sha256: '0'.repeat(64) },
      { bytes: 1 },
      { mime: 'text/plain' },
      { key: 'other/key' },
      { path: '/art/item/index.html' },
    ])
      assert.equal(
        (await verifiedReuse(f.root, [{ record: { ...f.record, ...changes } }], f.production))
          .count,
        0,
      );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('corrupt, incomplete, wrong-root and missing history falls back to fresh byte verification', async () => {
  const f = fixture();
  try {
    for (const changes of [
      { verified: 0 },
      { root: '0'.repeat(64) },
      { status: 'NOT_LIVE' },
      { files: [{ ...f.record, sha256: '0'.repeat(64) }] },
    ]) {
      f.write({ ...f.manifest, ...changes });
      assert.equal((await verifiedReuse(f.root, f.records, f.production)).count, 0);
    }
    f.write();
    rmSync(join(f.directory, 'verified.jsonl'));
    assert.equal((await verifiedReuse(f.root, f.records, f.production)).count, 0);
    f.write();
    writeFileSync(join(f.directory, 'verified.jsonl'), '{broken');
    assert.equal((await verifiedReuse(f.root, f.records, f.production)).count, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('the Worker reuses only an authorized prior validator and still checks current size and MIME', async () => {
  const f = fixture();
  try {
    const reuse = await verifiedReuse(f.root, f.records, f.production),
      secret = 'b'.repeat(64),
      accountId = 'c'.repeat(32),
      bucket = 'test';
    const worker = stagingWorker({
      root: f.tree.root,
      reuseRoot: reuse.root,
      accountId,
      bucket,
      secret,
      revision: 'd'.repeat(40),
    });
    let reads = 0,
      bodyReads = 0,
      puts = 0;
    let object = {
      size: f.bytes.length,
      etag: 'accepted-etag',
      httpMetadata: { contentType: 'image/webp' },
    };
    const env = {
      TARGET: {
        get: async (key, options) => {
          reads++;
          assert.equal(key, f.record.key);
          if (options?.onlyIf?.etagDoesNotMatch === object.etag) return object;
          return {
            ...object,
            arrayBuffer: async () => {
              bodyReads++;
              return f.bytes;
            },
          };
        },
        put: async () => {
          puts++;
          throw Error('No write permitted');
        },
      },
    };
    const send = (row = reuse.attach(f.records[0])) => {
      const command = { action: 'verify', root: f.tree.root, accountId, bucket, at: Date.now() };
      const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(JSON.stringify(command))
        .digest('hex');
      return worker.fetch(
        new Request('https://private.test/verify', {
          method: 'POST',
          body: JSON.stringify({ command, signature, records: [row] }),
        }),
        env,
      );
    };
    let response = await send();
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).verified[0].verification,
      'prior-byte-proof-and-current-etag',
    );
    assert.equal(bodyReads, 0);
    object = { ...object, etag: 'changed-etag' };
    response = await send();
    assert.equal(response.status, 200);
    assert.equal(bodyReads, 1);
    object = { ...object, etag: 'accepted-etag', size: 1 };
    assert.equal((await send()).status, 422);
    object = { ...object, size: f.bytes.length, httpMetadata: { contentType: 'text/plain' } };
    assert.equal((await send()).status, 422);
    const tampered = reuse.attach(f.records[0]);
    tampered.prior.etag = 'unverified';
    assert.equal((await send(tampered)).status, 403);
    assert.equal(reads, 4);
    assert.equal(puts, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('an unsigned conditional response cannot replace a byte proof', async () => {
  const f = fixture();
  try {
    const secret = 'b'.repeat(64),
      accountId = 'c'.repeat(32),
      bucket = 'test';
    const command = { action: 'verify', root: f.tree.root, accountId, bucket, at: Date.now() };
    const worker = stagingWorker({ root: f.tree.root, secret, accountId, bucket });
    const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(JSON.stringify(command))
      .digest('hex');
    const response = await worker.fetch(
      new Request('https://private.test/verify', {
        method: 'POST',
        body: JSON.stringify({ command, signature, records: f.records }),
      }),
      {
        TARGET: {
          get: async () => ({
            size: f.bytes.length,
            httpMetadata: { contentType: 'image/webp' },
            etag: 'arbitrary',
          }),
        },
      },
    );
    assert.equal(response.status, 422);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
