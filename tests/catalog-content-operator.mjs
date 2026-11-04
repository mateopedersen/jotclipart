import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { intakeArchive } from '../scripts/catalog-snapshot/intake-archive.mjs';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import {
  verifySourceFile,
  verifySourceCapsule,
} from '../scripts/catalog-snapshot/source-files.mjs';
import { privateBenchmarkWorker } from '../server/catalog-snapshot/private-benchmark-worker.mjs';
import {
  createReleaseWriteAuthorization,
  OWNER_MANAGED_STORAGE_POLICY,
} from '../scripts/delivery/release-write-authorization.mjs';
import { merkle } from '../scripts/delivery/manifest.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
test('streamed batch sources reject replaced bytes, directories, symlinks and escapes', async () => {
  const dir = resolve('work/test-source-' + randomBytes(8).toString('hex'));
  mkdirSync(dir, { recursive: true });
  try {
    const file = dir + '/source.bin',
      bytes = Buffer.alloc(3 * 1024 * 1024, 31);
    writeFileSync(file, bytes);
    const row = { path: file, bytes: bytes.length, sha256: hash(bytes) };
    assert.equal(await verifySourceFile(row), file);
    await assert.rejects(() => verifySourceFile({ ...row, sha256: 'f'.repeat(64) }));
    await assert.rejects(() => verifySourceFile({ ...row, path: dir }));
    symlinkSync(file, dir + '/link.bin');
    await assert.rejects(() => verifySourceFile({ ...row, path: dir + '/link.bin' }));
    await assert.rejects(() => verifySourceFile({ ...row, path: resolve('AGENTS.md') }));
    writeFileSync(file, Buffer.alloc(bytes.length, 32));
    await assert.rejects(() => verifySourceFile(row));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('production packet cannot claim an uncommitted or outside source capsule', () => {
  for (const packet of [
    {},
    {
      sourceCommit: 'a'.repeat(40),
      sourceCapsule: { path: '../foreign.json', sha256: 'b'.repeat(64) },
    },
  ])
    assert.throws(() => verifySourceCapsule(packet), /capsule/);
});
test('private benchmark cannot affect production keys; fresh exact readback is required before cleanup', async () => {
  const bytes = Buffer.from('%PDF-1.7 private exact test'),
    prefix = 'private-benchmark/' + randomBytes(16).toString('hex') + '/',
    record = {
      path: '/private-test.pdf',
      key: prefix + hash(bytes) + '.pdf',
      bytes: bytes.length,
      sha256: hash(bytes),
      mime: 'application/pdf',
    },
    tree = merkle([record]),
    secret = randomBytes(32).toString('hex'),
    job = {
      benchmark: true,
      testPrefix: prefix,
      root: tree.root,
      revision: 'a'.repeat(40),
      accountId: 'a'.repeat(32),
      bucket: 'private-unit-test',
      secret,
      sourceOrigin: 'https://ultraclipart.com',
      media: true,
      storagePolicy: OWNER_MANAGED_STORAGE_POLICY,
      authorizedBytes: bytes.length,
    },
    worker = privateBenchmarkWorker(job),
    objects = new Map();
  let writes = 0,
    deletes = 0;
  const env = {
      TARGET: {
        get: async (key) => {
          const r = objects.get(key);
          if (!r) return null;
          return {
            size: r.bytes.length,
            httpMetadata: r.metadata,
            etag: 'exact-etag',
            arrayBuffer: async () => r.bytes,
          };
        },
        put: async (key, body, options) => {
          assert(key.startsWith(prefix));
          assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
          objects.set(key, { bytes: Buffer.from(body), metadata: options.httpMetadata });
          writes++;
          return { etag: 'exact-etag' };
        },
        delete: async (keys) => {
          for (const key of keys) {
            assert(key.startsWith(prefix));
            objects.delete(key);
            deletes++;
          }
        },
      },
    },
    batch = [{ record, proof: tree.proof(0) }],
    lease = createReleaseWriteAuthorization(job, Date.now() - 1000),
    signature = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(JSON.stringify(lease))
      .digest('hex');
  let r = await worker.fetch(
    new Request('http://localhost/stage', {
      method: 'POST',
      headers: {
        'x-uc-stage-metadata': JSON.stringify({ records: batch }),
        'x-uc-stage-authorization': JSON.stringify({ lease, signature }),
      },
      body: bytes,
    }),
    env,
  );
  assert.equal(r.status, 200, await r.text());
  assert.equal(writes, 1);
  const command = {
      action: 'verify',
      root: tree.root,
      accountId: job.accountId,
      bucket: job.bucket,
      at: Date.now() - 1000,
    },
    sig = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(JSON.stringify(command))
      .digest('hex');
  r = await worker.fetch(
    new Request('http://localhost/cleanup', {
      method: 'POST',
      body: JSON.stringify({ command, signature: '0'.repeat(64), records: batch }),
    }),
    env,
  );
  assert.equal(r.status, 403);
  assert.equal(deletes, 0);
  r = await worker.fetch(
    new Request('http://localhost/cleanup', {
      method: 'POST',
      body: JSON.stringify({
        command,
        signature: sig,
        records: [{ record: { ...record, key: 'catalog/active.json' }, proof: batch[0].proof }],
      }),
    }),
    env,
  );
  assert.equal(r.status, 403);
  assert.equal(deletes, 0);
  r = await worker.fetch(
    new Request('http://localhost/cleanup', {
      method: 'POST',
      body: JSON.stringify({ command, signature: sig, records: batch }),
    }),
    env,
  );
  assert.equal(r.status, 200, await r.text());
  assert.equal(deletes, 1);
  assert.equal(objects.size, 0);
});

test('archive intake preserves a verified independent container and rejects traversal ZIP members', async () => {
  const dir = resolve('work/test-intake-' + randomBytes(8).toString('hex'));
  mkdirSync(dir, { recursive: true });
  try {
    for (const bad of [false, true]) {
      const source = dir + (bad ? '/bad.zip' : '/good.zip');
      execFileSync('python3', [
        '-c',
        "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr(sys.argv[2],b'private crc fixture'); z.close()",
        source,
        bad ? '../escape.webp' : 'images/one.webp',
      ]);
      if (bad) await assert.rejects(() => intakeArchive(source, dir + '/bad'));
      else {
        const r = await intakeArchive(source, dir + '/good');
        assert.equal(r.inventory.files, 1);
        assert.equal(r.inventory.crc, 'ALL_MEMBERS_READ_AND_CRC_VERIFIED');
        assert.notEqual(r.archive, source);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
