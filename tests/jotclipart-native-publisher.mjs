// Private native-verifier fixtures. No issuer, pointer update or live metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { nativeCandidateCaptureSource } from '../scripts/catalog-snapshot/test-content-native.mjs';
import { openSnapshot } from '../server/catalog-snapshot/snapshot-context.mjs';
import { snapshotDigest } from '../server/catalog-snapshot/release-pointer.mjs';
import {
  captureProductionSnapshot,
  productionSnapshotMessage,
} from '../server/catalog-snapshot/signed-production-snapshot.mjs';

const pair = generateKeyPairSync('ed25519'),
  publicKeyHex = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString(
    'hex',
  ),
  metadata = new TextEncoder().encode('{}'),
  metadataSHA = createHash('sha256').update(metadata).digest('hex'),
  report = {
    accountId: 'a'.repeat(32),
    bucketName: 'private-publisher-fixture',
    keyId: 'fixture-key',
    abiSHA256: 'b'.repeat(64),
    publicKeyHex,
  };
function unsigned() {
  return {
    schema: 1,
    status: 'SOURCE_MEDIA_GRAPH_VERIFIED',
    revision: 'a'.repeat(40),
    parentRevision: 'b'.repeat(40),
    indexes: Object.fromEntries(
      ['artworks', 'collections', 'search', 'recent', 'related', 'counts', 'sitemaps'].map(
        (name) => [
          name,
          {
            key: `catalog/objects/${name}/${metadataSHA}.json`,
            sha256: metadataSHA,
            bytes: metadata.length,
          },
        ],
      ),
    ),
    authorization: {
      policy: 'source-media-graph-ed25519-v1',
      accountId: report.accountId,
      bucket: report.bucketName,
      keyId: report.keyId,
      abiSHA256: report.abiSHA256,
      sourceReceiptSHA256: '1'.repeat(64),
      mediaReceiptSHA256: '2'.repeat(64),
      graphReceiptSHA256: '3'.repeat(64),
      manifestRoot: '4'.repeat(64),
      parentSnapshotSHA256: '5'.repeat(64),
      issuedAt: Date.now() - 1000,
    },
  };
}
function signed(value = unsigned()) {
  return {
    ...value,
    authorization: {
      ...value.authorization,
      signature: sign(null, productionSnapshotMessage(value), pair.privateKey).toString('hex'),
    },
  };
}
async function capture(snapshot, software = report, activeKey = 'catalog/jotclipart/active.json') {
  const reads = [],
    scoped = {
      async get(key) {
        assert.match(
          key,
          /^catalog\/objects\//,
          'The native test must never read a live active pointer',
        );
        reads.push(key);
        return { size: metadata.length, arrayBuffer: async () => metadata.buffer };
      },
    };
  const code = nativeCandidateCaptureSource(snapshot, software, { activeKey });
  const execute = new Function(
    'snapshot',
    'scoped',
    'openSnapshot',
    'captureProductionSnapshot',
    code + ';return captureNativeCandidate(scoped)',
  );
  return {
    context: await execute(snapshot, scoped, openSnapshot, captureProductionSnapshot),
    reads,
  };
}
test('a genuine signed candidate authenticates in its virtual namespace, with no live pointer reads or source mutation', async () => {
  for (const activeKey of ['catalog/active.json', 'catalog/jotclipart/active.json']) {
    const snapshot = signed(),
      before = JSON.stringify(snapshot),
      result = await capture(snapshot, report, activeKey);
    assert.equal(result.context.authorizationVerified, true);
    assert.equal(result.context.authorizationKind, 'SIGNED_SOURCE_MEDIA_GRAPH_SNAPSHOT');
    assert.equal(result.context.publicationVerified, false);
    assert.equal(result.reads.length, 0);
    assert.deepEqual(await result.context.getFacet('counts'), {});
    assert.equal(result.reads.length, 1);
    assert.equal(JSON.stringify(snapshot), before);
  }
});
test('only explicit private preparations use the unauthenticated reader and never gain publication authority', async () => {
  for (const patch of [{ fixture: true }, { status: 'PRIVATE_UNPUBLISHABLE' }]) {
    const snapshot = { ...unsigned(), ...patch };
    delete snapshot.authorization;
    const { context } = await capture(snapshot, {});
    assert.notEqual(context.authorizationVerified, true);
    assert.equal(context.publicationVerified, false);
    assert.equal(
      context.snapshot.fixture === true || context.snapshot.status === 'PRIVATE_UNPUBLISHABLE',
      true,
    );
  }
});
test('missing or changed signatures receipts authority and unsupported snapshot status remain hard failures', async () => {
  for (const change of [
    (value) => delete value.authorization,
    (value) => delete value.authorization.signature,
    (value) => (value.authorization.signature = '0'.repeat(128)),
    (value) => (value.authorization.mediaReceiptSHA256 = '0'.repeat(64)),
    (value) => (value.authorization.accountId = 'f'.repeat(32)),
    (value) => (value.status = 'UNKNOWN'),
  ]) {
    const snapshot = signed();
    change(snapshot);
    await assert.rejects(capture(snapshot));
  }
  const future = unsigned();
  future.authorization.issuedAt = Date.now() + 3600000;
  await assert.rejects(capture(signed(future)), /scope mismatch/);
  assert.throws(() =>
    nativeCandidateCaptureSource(signed(), report, { activeKey: 'other/active.json' }),
  );
});
test('software transition permits one exact signed predecessor and rejects a different validly signed old root', async () => {
  const snapshot = signed(),
    next = {
      ...report,
      abiSHA256: 'e'.repeat(64),
      acceptedPredecessor: {
        abiSHA256: report.abiSHA256,
        rootSHA256: await snapshotDigest(snapshot),
      },
    };
  assert.equal((await capture(snapshot, next)).context.authorizationABI, report.abiSHA256);
  assert.equal((await capture(snapshot, next)).context.runtimeABI, next.abiSHA256);
  const other = unsigned();
  other.authorization.graphReceiptSHA256 = 'f'.repeat(64);
  await assert.rejects(capture(signed(other), next), /scope mismatch/);
  await assert.rejects(
    capture(snapshot, {
      ...next,
      acceptedPredecessor: { ...next.acceptedPredecessor, rootSHA256: '0'.repeat(64) },
    }),
    /scope mismatch/,
  );
});
test('actual workerd runs strict signed capture and rejects tampering while private mode stays explicitly unauthenticated', async () => {
  const snapshot = signed(),
    tampered = structuredClone(snapshot);
  tampered.authorization.signature = '0'.repeat(128);
  const privateSnapshot = { ...unsigned(), status: 'PRIVATE_UNPUBLISHABLE' };
  delete privateSnapshot.authorization;
  const cases = Object.entries({ signed: snapshot, tampered, private: privateSnapshot }).map(
    ([name, value]) =>
      `${JSON.stringify('/' + name)}:async()=>{const snapshot=${JSON.stringify(value)};${nativeCandidateCaptureSource(value, report, { activeKey: 'catalog/jotclipart/active.json' })};return captureNativeCandidate({get(){throw Error('Unexpected external read')}})}`,
  );
  const code = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import{openSnapshot}from'./server/catalog-snapshot/snapshot-context.mjs';import{captureProductionSnapshot}from'./server/catalog-snapshot/signed-production-snapshot.mjs';const cases={${cases.join(',')}};export default{async fetch(request){try{const context=await cases[new URL(request.url).pathname]();return Response.json({authorizationVerified:context.authorizationVerified===true,publicationVerified:context.publicationVerified})}catch(error){return new Response(String(error),{status:503})}}};`,
    },
    write: false,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });
  const require = createRequire(import.meta.resolve('wrangler')),
    { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: 'strict-native-publisher-fixture',
          script: code.outputFiles[0].text,
          modules: true,
          compatibilityDate: '2026-10-23',
        },
      ],
      host: '127.0.0.1',
      port: 0,
    }),
  );
  try {
    const accepted = await mf.dispatchFetch('https://private-native.invalid/signed');
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      authorizationVerified: true,
      publicationVerified: false,
    });
    assert.equal((await mf.dispatchFetch('https://private-native.invalid/tampered')).status, 503);
    const privateResult = await mf.dispatchFetch('https://private-native.invalid/private');
    assert.equal(privateResult.status, 200);
    assert.deepEqual(await privateResult.json(), {
      authorizationVerified: false,
      publicationVerified: false,
    });
  } finally {
    await mf.dispose();
  }
});
