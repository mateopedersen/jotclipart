import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, createHmac, randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { metadataDiskCache } from '../scripts/catalog-snapshot/metadata-disk-cache.mjs';
import { remoteCatalogBucket } from '../scripts/catalog-snapshot/remote-reader.mjs';
import { sealCatalogContent } from '../scripts/catalog-snapshot/seal-content.mjs';
import { productionSnapshotMessage } from '../server/catalog-snapshot/signed-production-snapshot.mjs';
import { snapshotDigest } from '../server/catalog-snapshot/release-pointer.mjs';
import { merkle } from '../scripts/delivery/manifest.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const source = (n) => {
  const b = Buffer.from(JSON.stringify({ schema: 1, n, pad: 'x'.repeat(96) }));
  return { b, key: 'catalog/objects/collections/' + sha(b) + '.json' };
};
async function fixture() {
  const directory = resolve(
      'work/imports/owner-brands-8-20261104/private-seal-cache-policy/test-' +
        randomBytes(6).toString('hex'),
    ),
    rows = Array.from({ length: 10 }, (_, i) => source(i)),
    options = {
      directory: join(directory, 'disk'),
      accountId: 'a'.repeat(32),
      bucketName: 'private-seal-cache',
      maxObjects: 4,
      maxBytes: rows[0].b.length * 4,
    },
    data = new Map(rows.map((r) => [r.key, r.b]));
  const keys = generateKeyPairSync('ed25519'),
    publicKeyHex = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString(
      'hex',
    ),
    verifier = {
      accountId: options.accountId,
      bucketName: options.bucketName,
      keyId: 'private-seal-fixture',
      publicKey: new Uint8Array(Buffer.from(publicKeyHex, 'hex')),
      publicKeyHex,
      abiSHA256: 'b'.repeat(64),
      now: 1000,
    };
  const indexes = Object.fromEntries(
    ['artworks', 'collections', 'search', 'recent', 'related', 'counts', 'sitemaps'].map((f) => [
      f,
      {
        key: 'catalog/objects/' + f + '/' + 'c'.repeat(64) + '.json',
        sha256: 'c'.repeat(64),
        bytes: 2,
      },
    ]),
  );
  const parent = {
    schema: 1,
    status: 'SOURCE_MEDIA_GRAPH_VERIFIED',
    revision: 'a'.repeat(40),
    parentRevision: 'b'.repeat(40),
    indexes,
    authorization: {
      policy: 'source-media-graph-ed25519-v1',
      accountId: options.accountId,
      bucket: options.bucketName,
      keyId: verifier.keyId,
      abiSHA256: verifier.abiSHA256,
      sourceReceiptSHA256: '1'.repeat(64),
      mediaReceiptSHA256: '2'.repeat(64),
      graphReceiptSHA256: '3'.repeat(64),
      manifestRoot: '4'.repeat(64),
      parentSnapshotSHA256: '5'.repeat(64),
      issuedAt: 500,
    },
  };
  parent.authorization.signature = sign(
    null,
    productionSnapshotMessage(parent),
    keys.privateKey,
  ).toString('hex');
  const parentRoot = await snapshotDigest(parent);
  data.set('catalog/active.json', Buffer.from(JSON.stringify(parent)));
  let disk = metadataDiskCache(options),
    immutableReads = 0,
    activeReads = 0,
    corrupt = null,
    wrongRoot = false;
  const makeReader = () =>
    remoteCatalogBucket({
      secret: 'd'.repeat(64),
      parentSnapshotSHA256: parentRoot,
      accountId: options.accountId,
      bucket: options.bucketName,
      cacheEntries: 1,
      diskCache: disk,
      fetcher: async (endpoint, init) => {
        assert.equal(endpoint, 'http://127.0.0.1:8899/read');
        const { command, signature } = JSON.parse(init.body);
        assert.equal(
          signature,
          createHmac('sha256', Buffer.from('d'.repeat(64), 'hex'))
            .update(JSON.stringify(command))
            .digest('hex'),
        );
        assert.equal(command.parentSnapshotSHA256, parentRoot);
        assert.equal(command.accountId, options.accountId);
        assert.equal(command.bucket, options.bucketName);
        assert(Date.now() - command.at < 45000);
        return Response.json({
          parentSnapshotSHA256: wrongRoot ? 'f'.repeat(64) : parentRoot,
          objects: command.keys.map((key) => {
            if (key === 'catalog/active.json') activeReads++;
            else immutableReads++;
            const b = data.get(key);
            assert(b, 'Known fixture source required');
            return {
              key,
              body: (key === corrupt ? Buffer.from('wrong source bytes') : b).toString('base64'),
              bytes: b.length,
              sha256: sha(b),
              etag: 'private-exact',
            };
          }),
        });
      },
    });
  const sequence = async (reader, which = rows.slice(0, 8)) => {
    const bodies = [];
    for (const r of which) {
      const b = Buffer.from(await (await reader.get(r.key)).arrayBuffer());
      assert.deepEqual(b, r.b);
      assert.equal(sha(b), r.key.split('/').at(-1).slice(0, 64));
      bodies.push(b);
      assert(disk.metrics().objects <= 4 && disk.metrics().bytes <= options.maxBytes);
    }
    return bodies;
  };
  return {
    directory,
    rows,
    options,
    get disk() {
      return disk;
    },
    restart() {
      disk.close();
      disk = metadataDiskCache(options);
      return disk;
    },
    data,
    verifier,
    parent,
    parentRoot,
    makeReader,
    sequence,
    reads: () => immutableReads,
    activeReads: () => activeReads,
    setCorrupt: (key) => (corrupt = key),
    setWrongRoot: (v) => (wrongRoot = v),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('real bounded disk cache forward replay exceeds capacity: normal admissions thrash8 versus scoped minimal4 misses', async () => {
  const results = [];
  for (const paused of [false, true]) {
    const f = await fixture();
    try {
      const first = await f.sequence(f.makeReader());
      assert.equal(f.reads(), 8);
      assert.deepEqual(f.disk.metrics(), {
        objects: 4,
        bytes: f.options.maxBytes,
        maxBytes: f.options.maxBytes,
        maxObjects: 4,
      });
      // Real cache restart retains only the actual suffix, not an artificial all-hit warm set.
      const restarted = f.restart();
      for (const r of f.rows.slice(4, 8)) assert.deepEqual(restarted.get(r.key), r.b);
      restarted.close();
      const reader = f.makeReader(),
        before = f.reads(),
        repeated = paused
          ? await reader.withoutDiskCacheAdmissions(() => f.sequence(reader))
          : await f.sequence(reader);
      assert.deepEqual(repeated, first);
      const misses = f.reads() - before;
      assert.equal(misses, paused ? 4 : 8);
      assert.equal(f.disk.metrics().maxObjects, 4);
      assert.equal(f.disk.metrics().maxBytes, f.options.maxBytes);
      results.push(misses);
    } finally {
      f.cleanup();
    }
  }
  assert.deepEqual(results, [8, 4]);
});

test('suppressed admissions retain cache-hit hash checks and LRU touches, and corrupt hits refetch full bytes', async () => {
  const f = await fixture();
  try {
    await f.sequence(f.makeReader());
    const reader = f.makeReader(),
      warm = f.rows.slice(4, 8);
    await reader.withoutDiskCacheAdmissions(() => f.sequence(reader, [warm[0]]));
    assert.equal(f.reads(), 8);
    await f.sequence(reader, [f.rows[8]]);
    assert.deepEqual(f.disk.get(warm[0].key), warm[0].b);
    assert.equal(
      f.disk.get(warm[1].key),
      null,
      'untouched oldest entry evicted; paused hit still touched LRU',
    );
    writeFileSync(join(f.options.directory, warm[0].key.replaceAll('/', '_')), 'corrupt disk');
    const fresh = f.makeReader(),
      before = f.reads();
    await fresh.withoutDiskCacheAdmissions(() => f.sequence(fresh, [warm[0]]));
    assert.equal(f.reads() - before, 1);
    assert.equal(
      f.disk.get(warm[0].key),
      null,
      'corrupt hit removed and recovery not re-admitted within scope',
    );
  } finally {
    f.cleanup();
  }
});

test('corrupt remote bytes and mismatched parent still reject inside scope with no retry or cache admission', async () => {
  for (const mode of ['bytes', 'root']) {
    const f = await fixture();
    try {
      const reader = f.makeReader();
      if (mode === 'bytes') f.setCorrupt(f.rows[0].key);
      else f.setWrongRoot(true);
      await assert.rejects(
        () => reader.withoutDiskCacheAdmissions(() => reader.get(f.rows[0].key)),
        mode === 'bytes' ? /bytes differ/ : /root or cardinality/,
      );
      assert.equal(f.reads(), 1);
      assert.equal(f.disk.metrics().objects, 0);
    } finally {
      f.cleanup();
    }
  }
});

test('successful, failing and nested admission scopes restore normal verified admissions', async () => {
  const f = await fixture();
  try {
    const r = f.makeReader();
    await r.withoutDiskCacheAdmissions(() => f.sequence(r, [f.rows[0]]));
    assert.equal(f.disk.get(f.rows[0].key), null);
    await assert.rejects(
      () =>
        r.withoutDiskCacheAdmissions(async () => {
          await r.withoutDiskCacheAdmissions(() => f.sequence(r, [f.rows[1]]));
          throw Error('replay failed');
        }),
      /replay failed/,
    );
    assert.equal(f.disk.get(f.rows[1].key), null);
    await f.sequence(r, [f.rows[2]]);
    assert.deepEqual(f.disk.get(f.rows[2].key), f.rows[2].b);
  } finally {
    f.cleanup();
  }
});

async function sealFixture(
  f,
  {
    supported = true,
    changeCandidate = false,
    changeSource = false,
    changeObject = false,
    throwReplay = false,
  } = {},
) {
  const directory = join(f.directory, 'seal'),
    software = join(f.directory, 'software');
  mkdirSync(join(software, 'runtime'), { recursive: true });
  mkdirSync(directory, { recursive: true });
  const worker = Buffer.from('private worker fixture, never deployed'),
    code = {
      workerSHA256: sha(worker),
      abiSHA256: f.verifier.abiSHA256,
      publicKeyHex: f.verifier.publicKeyHex,
    };
  writeFileSync(join(software, 'runtime/worker.mjs'), worker);
  writeFileSync(join(software, 'runtime/software-report.json'), JSON.stringify(code));
  const packet = {
      schema: 1,
      incomingMediaManifest: {
        schema: 2,
        status: 'PLANNED_INCOMING_MEDIA',
        plannedAt: '2026-11-04T00:00:00Z',
        files: [],
        bytes: 0,
      },
    },
    packetBytes = Buffer.from(JSON.stringify(packet)),
    source = {
      status: 'CURRENT_SOURCE_AND_EDITORIAL_VERIFIED_NOT_A_DEPLOYMENT',
      packetSHA256: sha(packetBytes),
      parentSnapshotSHA256: f.parentRoot,
    },
    sourceBytes = Buffer.from(JSON.stringify(source)),
    candidate = {
      schema: 1,
      revision: 'd'.repeat(40),
      parentRevision: f.parent.revision,
      indexes: f.parent.indexes,
    };
  const b = Buffer.from('{"schema":1,"type":"private-replay-equality-test"}'),
    key = 'catalog/objects/collections/' + sha(b) + '.json',
    file = join(directory, 'metadata.json'),
    record = {
      key,
      sha256: sha(b),
      bytes: b.length,
      path: '/catalog-snapshot/' + key.slice('catalog/objects/'.length),
      mime: 'application/json',
    };
  writeFileSync(file, b);
  const manifest = {
    schema: 1,
    status: 'REVIEWED_METADATA_REQUIRES_REMOTE_READBACK',
    revision: candidate.revision,
    records: [record],
    sourceByKey: { [key]: file },
    root: merkle([record]).root,
  };
  for (const [name, value] of Object.entries({
    'packet.json': packet,
    'source-receipt.json': source,
    'snapshot-candidate.json': candidate,
    'manifest.json': manifest,
    'remote-receipt.json': { status: 'TEST_STOP_AFTER_REPLAY_BYTE_EQUALITY' },
    'native-integration-report.json': { status: 'TEST_NEVER_SIGN' },
  }))
    writeFileSync(join(directory, name), JSON.stringify(value));
  const real = f.makeReader(),
    parentBucket = supported ? real : { get: real.get };
  let callbackCalls = 0,
    callbackBodies;
  const replay = async ({ output, parentBucket: reader, packetBytes: actual }) => {
    callbackCalls++;
    assert.deepEqual(actual, packetBytes);
    callbackBodies = await f.sequence(reader);
    mkdirSync(output, { recursive: true });
    if (throwReplay) throw Error('test replay exception');
    writeFileSync(
      join(output, 'source-receipt.json'),
      changeSource ? Buffer.from('changed source') : sourceBytes,
    );
    const objectFile = join(output, 'metadata.json');
    writeFileSync(objectFile, changeObject ? Buffer.from('changed object') : b);
    return {
      result: {
        candidate: changeCandidate ? { ...candidate, revision: 'e'.repeat(40) } : candidate,
      },
      manifest: { ...manifest, sourceByKey: { [key]: objectFile } },
    };
  };
  return {
    directory,
    software,
    parentBucket,
    replay,
    callbackCalls: () => callbackCalls,
    callbackBodies: () => callbackBodies,
  };
}

test('actual seal wrapper scopes only replay and preserves byte equality; absent feature follows same replay fallback', async () => {
  for (const supported of [true, false]) {
    const f = await fixture();
    try {
      const first = await f.sequence(f.makeReader()),
        before = f.reads(),
        s = await sealFixture(f, { supported });
      let error;
      try {
        await sealCatalogContent({ ...s, verifier: f.verifier });
      } catch (e) {
        error = e;
      }
      assert(error);
      assert.equal(
        error.actual,
        'TEST_STOP_AFTER_REPLAY_BYTE_EQUALITY',
        'candidate/source/manifest/all-object byte equality completed before unchanged remote receipt guard',
      );
      assert.equal(s.callbackCalls(), 1);
      assert.deepEqual(s.callbackBodies(), first);
      assert.equal(f.reads() - before, supported ? 4 : 8);
      assert(!existsSync(join(s.directory, 'independent-replay')));
      assert(!existsSync(join(s.directory, 'production-snapshot.json')));
      assert(!existsSync(join(s.directory, 'graph-verified-receipt.json')));
      await f.sequence(s.parentBucket, [f.rows[9]]);
      assert.deepEqual(
        f.disk.get(f.rows[9].key),
        f.rows[9].b,
        'admissions restored after seal rejection',
      );
    } finally {
      f.cleanup();
    }
  }
});

test('actual seal retains independent candidate/source/object mismatch refusal and scope cleanup on errors', async () => {
  for (const mode of ['changeCandidate', 'changeSource', 'changeObject', 'throwReplay']) {
    const f = await fixture();
    try {
      await f.sequence(f.makeReader());
      const s = await sealFixture(f, { [mode]: true });
      await assert.rejects(
        () => sealCatalogContent({ ...s, verifier: f.verifier }),
        mode === 'changeCandidate'
          ? /Independent source\/graph replay differs/
          : mode === 'changeObject'
            ? /Metadata source changed/
            : mode === 'throwReplay'
              ? /test replay exception/
              : /Expected values to be strictly equal/,
      );
      assert.equal(s.callbackCalls(), 1);
      assert(!existsSync(join(s.directory, 'independent-replay')));
      await f.sequence(s.parentBucket, [f.rows[9]]);
      assert.deepEqual(f.disk.get(f.rows[9].key), f.rows[9].b);
      assert(!existsSync(join(s.directory, 'production-snapshot.json')));
    } finally {
      f.cleanup();
    }
  }
});
