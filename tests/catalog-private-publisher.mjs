import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHmac, createHash } from 'node:crypto';
import { privateSnapshotPublisher } from '../server/catalog-snapshot/private-publish-worker.mjs';
import { productionSnapshotMessage } from '../server/catalog-snapshot/signed-production-snapshot.mjs';
import { snapshotDigest } from '../server/catalog-snapshot/release-pointer.mjs';
const rawHash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function fixture() {
  const pair = generateKeyPairSync('ed25519'),
    verifier = {
      accountId: 'a'.repeat(32),
      bucketName: 'private-local-test',
      keyId: 'private-test',
      abiSHA256: 'b'.repeat(64),
      publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString(
        'hex',
      ),
    },
    make = (revision, parentRevision, parentSnapshotSHA256) => {
      const value = {
        schema: 1,
        status: 'SOURCE_MEDIA_GRAPH_VERIFIED',
        revision,
        parentRevision,
        indexes: Object.fromEntries(
          ['artworks', 'collections', 'search', 'recent', 'related', 'counts', 'sitemaps'].map(
            (f) => [
              f,
              {
                key: `catalog/objects/${f}/${'c'.repeat(64)}.json`,
                bytes: 2,
                sha256: 'c'.repeat(64),
              },
            ],
          ),
        ),
        authorization: {
          policy: 'source-media-graph-ed25519-v1',
          accountId: verifier.accountId,
          bucket: verifier.bucketName,
          keyId: verifier.keyId,
          abiSHA256: verifier.abiSHA256,
          sourceReceiptSHA256: '1'.repeat(64),
          mediaReceiptSHA256: '2'.repeat(64),
          graphReceiptSHA256: '3'.repeat(64),
          manifestRoot: '4'.repeat(64),
          parentSnapshotSHA256,
          issuedAt: Date.now() - 1000,
        },
      };
      value.authorization.signature = sign(
        null,
        productionSnapshotMessage(value),
        pair.privateKey,
      ).toString('hex');
      return value;
    },
    parent = make('a'.repeat(40), 'b'.repeat(40), '5'.repeat(64)),
    parentDigest = await snapshotDigest(parent),
    snapshot = make('c'.repeat(40), parent.revision, parentDigest),
    job = {
      mode: 'VERIFIED_CONTENT_DELTA_ACTIVATION',
      secret: 'd'.repeat(64),
      parentSnapshotSHA256: parentDigest,
      snapshotSHA256: rawHash(snapshot),
      snapshot,
      verifier,
    };
  let value = structuredClone(parent),
    puts = 0,
    gets = 0,
    collision = false;
  const bucket = {
      get: async () => {
        gets++;
        return {
          size: JSON.stringify(value).length,
          etag: rawHash(value),
          httpMetadata: { contentType: 'application/json' },
          json: async () => structuredClone(value),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(value)).buffer,
        };
      },
      put: async (key, bytes, options) => {
        assert.equal(key, 'catalog/active.json');
        assert.equal(options.onlyIf.etagMatches, rawHash(value));
        puts++;
        if (collision) return null;
        value = JSON.parse(new TextDecoder().decode(bytes));
        return { etag: rawHash(value) };
      },
    },
    request = (extra = {}, wrong = false) => {
      const command = {
          action: 'activate-verified-catalog-delta',
          snapshotSHA256: job.snapshotSHA256,
          parentSnapshotSHA256: job.parentSnapshotSHA256,
          accountId: verifier.accountId,
          bucket: verifier.bucketName,
          at: Date.now() - 1000,
          ...extra,
        },
        signature = wrong
          ? '0'.repeat(64)
          : createHmac('sha256', Buffer.from(job.secret, 'hex'))
              .update(JSON.stringify(command))
              .digest('hex');
      return new Request('http://private.invalid/activate', {
        method: 'POST',
        body: JSON.stringify({ command, signature }),
      });
    };
  return {
    job,
    worker: privateSnapshotPublisher(job),
    bucket,
    request,
    puts: () => puts,
    gets: () => gets,
    collision: () => (collision = true),
    changeParent: () => (value = make('d'.repeat(40), 'e'.repeat(40), 'f'.repeat(64))),
  };
}
test('content-only atomic activation preserves parent and rejects unauthenticated or stale scope', async () => {
  const f = await fixture();
  assert.equal(
    (await f.worker.fetch(f.request({ at: Date.now() - 46000 }), { TARGET: f.bucket })).status,
    409,
  );
  assert.equal((await f.worker.fetch(f.request({}, true), { TARGET: f.bucket })).status, 403);
  assert.equal(f.puts(), 0);
  assert.equal(f.gets(), 0);
  const r = await f.worker.fetch(f.request(), { TARGET: f.bucket });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'VERIFIED_CONTENT_DELTA_POINTER_ACTIVE');
  assert.equal(f.puts(), 1);
  assert.equal((await f.worker.fetch(f.request(), { TARGET: f.bucket })).status, 200);
  assert.equal(f.puts(), 1);
});
test('concurrent predecessor and failed conditional swap cannot report a successful publication', async () => {
  const f = await fixture();
  f.changeParent();
  assert.equal((await f.worker.fetch(f.request(), { TARGET: f.bucket })).status, 409);
  assert.equal(f.puts(), 0);
  const g = await fixture();
  g.collision();
  assert.equal((await g.worker.fetch(g.request(), { TARGET: g.bucket })).status, 409);
  assert.equal(g.puts(), 1);
});

test('activation bounds actual streamed bytes with absent or understated Content-Length', async () => {
  for (const declared of [undefined, '1', '4096']) {
    const f = await fixture();
    let pulls = 0;
    let cancelled = 0;
    const chunks = [new Uint8Array(1024), new Uint8Array(1024), new Uint8Array(2049)];
    const stream = new ReadableStream(
      {
        pull(controller) {
          assert.ok(pulls < chunks.length, 'must stop reading as soon as 4096 bytes are exceeded');
          controller.enqueue(chunks[pulls++]);
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request('http://private.invalid/activate', {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: declared === undefined ? {} : { 'Content-Length': declared },
    });
    const response = await f.worker.fetch(request, { TARGET: f.bucket });
    assert.equal(response.status, 413);
    assert.equal(pulls, 3);
    assert.equal(cancelled, 1);
    assert.equal(f.gets(), 0);
    assert.equal(f.puts(), 0);
  }
});

test('an oversized declared body is rejected and cancelled before it is read', async () => {
  const f = await fixture();
  let pulls = 0;
  let cancelled = 0;
  const stream = new ReadableStream(
    {
      pull() {
        pulls++;
        throw Error('declared oversize body must not be read');
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  const response = await f.worker.fetch(
    new Request('http://private.invalid/activate', {
      method: 'POST',
      headers: { 'Content-Length': '4097' },
      body: stream,
      duplex: 'half',
    }),
    { TARGET: f.bucket },
  );
  assert.equal(response.status, 413);
  assert.equal(pulls, 0);
  assert.equal(cancelled, 1);
  assert.equal(f.gets(), 0);
  assert.equal(f.puts(), 0);
});

test('malformed JSON, null, array and scalar envelopes return 400 without touching R2', async () => {
  for (const body of ['{', '', 'null', '[]', '1', '"text"']) {
    const f = await fixture();
    const response = await f.worker.fetch(
      new Request('http://private.invalid/activate', {
        method: 'POST',
        body,
      }),
      { TARGET: f.bucket },
    );
    assert.equal(response.status, 400);
    assert.equal(f.gets(), 0);
    assert.equal(f.puts(), 0);
  }
});

test('invalid command or signature cannot read or write the production pointer', async () => {
  for (const command of [null, [], 'text', 1]) {
    const f = await fixture();
    const response = await f.worker.fetch(
      new Request('http://private.invalid/activate', {
        method: 'POST',
        body: JSON.stringify({ command, signature: '0'.repeat(64) }),
      }),
      { TARGET: f.bucket },
    );
    assert.equal(response.status, 409);
    assert.equal(f.gets(), 0);
    assert.equal(f.puts(), 0);
  }
  for (const signature of ['', null, {}, ['0'.repeat(64)], '0'.repeat(64)]) {
    const f = await fixture();
    const body = await f.request().json();
    body.signature = signature;
    const response = await f.worker.fetch(
      new Request('http://private.invalid/activate', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { TARGET: f.bucket },
    );
    assert.equal(response.status, 403);
    assert.equal(f.gets(), 0);
    assert.equal(f.puts(), 0);
  }
});

test('an exact 4096-byte valid envelope activates once and supports signed replay', async () => {
  const f = await fixture();
  const payload = await f.request().text();
  const padded = payload + ' '.repeat(4096 - new TextEncoder().encode(payload).length);
  assert.equal(new TextEncoder().encode(padded).length, 4096);
  const response = await f.worker.fetch(
    new Request('http://private.invalid/activate', {
      method: 'POST',
      body: padded,
    }),
    { TARGET: f.bucket },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'VERIFIED_CONTENT_DELTA_POINTER_ACTIVE');
  assert.equal(f.puts(), 1);
  const replay = await f.worker.fetch(f.request(), { TARGET: f.bucket });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).status, 'EXACT_DELTA_ALREADY_ACTIVE');
  assert.equal(f.puts(), 1);
});

async function namespacedFixture() {
  const f = await fixture();
  const parent = await (await f.bucket.get()).json();
  const oldKey = 'catalog/active.json',
    newKey = 'catalog/jotclipart/active.json';
  const values = new Map([
    [oldKey, structuredClone(parent)],
    [newKey, structuredClone(parent)],
  ]);
  const reads = [],
    writes = [];
  const bucket = {
    get: async (key) => {
      reads.push(key);
      const value = values.get(key);
      if (!value) return null;
      const bytes = Buffer.from(JSON.stringify(value));
      return {
        size: bytes.length,
        etag: rawHash(value),
        httpMetadata: { contentType: 'application/json' },
        json: async () => structuredClone(value),
        arrayBuffer: async () => bytes,
      };
    },
    put: async (key, bytes, options) => {
      assert(values.has(key));
      assert.equal(options.onlyIf.etagMatches, rawHash(values.get(key)));
      writes.push(key);
      values.set(key, JSON.parse(new TextDecoder().decode(bytes)));
      return { etag: rawHash(values.get(key)) };
    },
  };
  const job = { ...f.job, verifier: { ...f.job.verifier, activeKey: newKey } };
  return {
    ...f,
    job,
    worker: privateSnapshotPublisher(job),
    bucket,
    values,
    reads,
    writes,
    oldKey,
    newKey,
  };
}
test('same-root projects still publish and read back only the explicitly scoped new pointer', async () => {
  const f = await namespacedFixture(),
    before = rawHash(f.values.get(f.oldKey));
  assert.equal(rawHash(f.values.get(f.newKey)), before);
  const response = await f.worker.fetch(f.request({ pointerKey: f.newKey }), { TARGET: f.bucket });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pointerKey, f.newKey);
  assert.equal(rawHash(f.values.get(f.oldKey)), before);
  assert.equal(rawHash(f.values.get(f.newKey)), f.job.snapshotSHA256);
  assert.deepEqual(f.writes, [f.newKey]);
  assert(f.reads.every((key) => key === f.newKey));
  const replay = await f.worker.fetch(f.request({ pointerKey: f.newKey }), { TARGET: f.bucket });
  assert.equal((await replay.json()).status, 'EXACT_DELTA_ALREADY_ACTIVE');
  assert.deepEqual(f.writes, [f.newKey]);
});
test('new namespace refuses old/unscoped commands and wrong verifier before any target read', async () => {
  const f = await namespacedFixture();
  for (const request of [f.request(), f.request({ pointerKey: f.oldKey })])
    assert.equal((await f.worker.fetch(request, { TARGET: f.bucket })).status, 409);
  const oldWorker = privateSnapshotPublisher({
    ...f.job,
    verifier: { ...f.job.verifier, activeKey: f.oldKey },
  });
  assert.equal(
    (await oldWorker.fetch(f.request({ pointerKey: f.newKey }), { TARGET: f.bucket })).status,
    409,
  );
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
  for (const activeKey of [
    null,
    '',
    'catalog/other/active.json',
    'catalog/jotclipart/../active.json',
  ])
    assert.throws(
      () => privateSnapshotPublisher({ ...f.job, verifier: { ...f.job.verifier, activeKey } }),
      /pointer scope/,
    );
});
test('changing a signed pointer field cannot retarget an activation authorization', async () => {
  const f = await namespacedFixture();
  const envelope = await f.request({ pointerKey: f.oldKey }).json();
  envelope.command.pointerKey = f.newKey;
  const request = new Request('http://private.invalid/activate', {
    method: 'POST',
    body: JSON.stringify(envelope),
  });
  assert.equal((await f.worker.fetch(request, { TARGET: f.bucket })).status, 403);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});
