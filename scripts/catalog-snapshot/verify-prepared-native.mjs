// Recover a completed immutable preparation after a local native-tool failure.
// This command never stages metadata, signs a snapshot or activates production.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateContentPacket } from './prepare-content.mjs';
import { validateMetadataManifest, readMetadataBytes } from './stage-manifest.mjs';
import { withCatalogReader } from './publish-content.mjs';
import { verifyNativeContent } from './test-content-native.mjs';
import { assertPublisherTarget, assertPublisherSoftware } from '../jotclipart/publisher-target.mjs';
const [outputArg, softwareArg, configArg] = process.argv.slice(2);
assert(outputArg && softwareArg && configArg);
const output = realpathSync(resolve(outputArg)),
  software = realpathSync(resolve(softwareArg));
assert(output.startsWith(realpathSync('work') + '/') && !existsSync(join(output, 'result.json')));
const directory = join(output, 'prepared'),
  read = (name) => JSON.parse(readFileSync(join(directory, name))),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const packetBytes = readFileSync(join(directory, 'packet.json')),
  packet = await validateContentPacket(JSON.parse(packetBytes));
assert.notEqual(packet.publicationIntent, 'PRIVATE_TEST_ONLY');
const sourceBytes = readFileSync(join(directory, 'source-receipt.json')),
  source = JSON.parse(sourceBytes),
  graph = read('graph-local-receipt.json');
assert.equal(source.packetSHA256, sha(packetBytes));
assert.equal(graph.sourceReceiptSHA256, sha(sourceBytes));
assert.equal(source.parentSnapshotSHA256, packet.parentSnapshotSHA256);
const manifest = validateMetadataManifest(read('manifest.json'));
assert.equal(manifest.root, graph.manifestRoot);
assert.equal(manifest.revision, packet.revision);
const created = new Map(manifest.records.map((r) => [r.key, readMetadataBytes(manifest, r)]));
const config = JSON.parse(readFileSync(configArg)),
  publicOrigin = assertPublisherTarget(config),
  code = assertPublisherSoftware(
    JSON.parse(readFileSync(join(software, 'runtime/software-report.json'))),
    config,
  );
const control = await (
  await fetch(publicOrigin + '/delivery-release.json', { cache: 'no-store' })
).json();
assert.equal(control.controlRevision, code.revision);
assert.equal(control.verifiedRoot, packet.parentSnapshotSHA256);
const verifier = {
    ...config,
    abiSHA256: code.abiSHA256,
    publicKey: Buffer.from(config.publicKeyHex, 'hex'),
  },
  candidate = read('snapshot-candidate.json');
assert.equal(candidate.revision, packet.revision);
const native = await withCatalogReader(
  {
    directory: join(output, 'recover-native-' + Date.now()),
    verifier,
    parentSnapshotSHA256: packet.parentSnapshotSHA256,
  },
  (bucket) =>
    verifyNativeContent({
      candidate,
      created,
      parentBucket: bucket,
      software,
      packet,
      preparedPresentation: read('prepared-presentation-receipt.json'),
      publicOrigin,
    }),
);
writeFileSync(
  join(directory, 'native-integration-report.json'),
  JSON.stringify(native, null, 2) + '\n',
);
console.log(
  JSON.stringify({ status: 'RECOVERED_PREPARED_NATIVE_VERIFIED_NOT_STAGED_NOT_LIVE', native }),
);
