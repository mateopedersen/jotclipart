// Read-only private rehearsal of unchanged signed artwork through the new
// publisher's actual native route validator. Never signs, stages or activates.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildRoot } from './build-root.mjs';
import { assertPublisherSoftware, assertPublisherTarget } from './publisher-target.mjs';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import { readArtwork } from '../../server/catalog-snapshot/artwork-facet-reader.mjs';
import { publicRouteForId } from '../../server/catalog-snapshot/public-artwork-routes.mjs';
import { verifyNativeContent } from '../catalog-snapshot/test-content-native.mjs';

const [buildArg, capturedArg, outputArg, id = '001-freightliner-classic-xl-cascades-chain-up'] =
  process.argv.slice(2);
assert(
  buildArg && capturedArg && outputArg,
  'Use release-build-root verified-captured-metadata new-work-output [existing-artwork-id]',
);
const software = resolve(buildRoot(buildArg)),
  captured = resolve(capturedArg),
  output = resolve(buildRoot(outputArg));
assert(!existsSync(output));
const config = JSON.parse(readFileSync('config/content-publisher-public.json'));
const origin = assertPublisherTarget(config),
  code = assertPublisherSoftware(
    JSON.parse(readFileSync(join(software, 'runtime/software-report.json'))),
    config,
  );
const snapshotBytes = readFileSync(join(captured, 'production-snapshot.json'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let reads = 0;
const bucket = {
  async get(key) {
    let bytes;
    if (key === config.activeKey) bytes = snapshotBytes;
    else {
      const found =
        /^catalog\/objects\/(?:artworks|collections|search|recent|related|counts|sitemaps)\/([a-f0-9]{64})\.json$/.exec(
          key,
        );
      assert(found, 'Unexpected private rehearsal key');
      bytes = readFileSync(join(captured, found[1] + '.json'));
      assert.equal(sha(bytes), found[1]);
    }
    reads++;
    return {
      size: bytes.length,
      arrayBuffer: async () => bytes,
      json: async () => JSON.parse(bytes),
    };
  },
};
const verifier = {
  ...config,
  abiSHA256: code.abiSHA256,
  publicKey: Uint8Array.from(Buffer.from(config.publicKeyHex, 'hex')),
};
const context = await captureProductionSnapshot(bucket, verifier),
  record = await readArtwork(context, id);
assert(record?.published && record?.indexable, 'Existing accepted artwork required');
const recordSHA256 = sha(Buffer.from(JSON.stringify(record)));
const canonicalSlug = await publicRouteForId(context, id);
const result = await verifyNativeContent({
  candidate: context.snapshot,
  created: new Map(),
  parentBucket: bucket,
  software,
  packet: {
    status: 'PRIVATE_UNCHANGED_RECORD_REHEARSAL',
    changes: [{ id, record }],
    topicChanges: [],
  },
  publicOrigin: origin,
});
assert.equal(result.productionWrites, 0);
if (canonicalSlug !== id)
  assert(
    result.routes.some(
      (route) =>
        route.status === 301 && route.expectedLocation === origin + '/art/' + canonicalSlug + '/',
    ),
  );
assert.equal(
  recordSHA256,
  sha(Buffer.from(JSON.stringify(record))),
  'Source record changed during rehearsal',
);
mkdirSync(output, { recursive: true, mode: 0o700 });
const report = {
  ...result,
  status: 'PRIVATE_UNCHANGED_RECORD_NEW_PUBLISHER_NATIVE_REHEARSAL_VERIFIED',
  at: new Date().toISOString(),
  sourceRoot: context.rootSHA256,
  softwareRevision: code.revision,
  recordId: id,
  canonicalSlug,
  stableIdAliasExpected: canonicalSlug !== id,
  sourceRecordSHA256: recordSHA256,
  metadataReads: reads,
  cloudRequests: 0,
  cloudWrites: 0,
  originalMediaReads: 0,
  claim:
    'Unchanged signed source, canonical alias, art/editor and existing core discovery routes only. No real new import, new pixel review, authority issuance or production publication is claimed.',
};
writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
console.log(JSON.stringify({ ...report, routes: report.routes.length }));
