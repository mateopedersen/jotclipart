// Read/verify an already activated packet after a post-activation tool failure.
// No upload, re-signing, activation or rollback occurs in this recovery path.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateContentPacket } from './prepare-content.mjs';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import { verifyContentLive } from './verify-content-live.mjs';
import { assertPublisherTarget, assertPublisherSoftware } from '../jotclipart/publisher-target.mjs';
import { sharedContentBaseline } from './legacy-source-guard.mjs';
const [outputArg, softwareArg, configArg] = process.argv.slice(2);
assert(outputArg && softwareArg && configArg);
const output = realpathSync(resolve(outputArg)),
  software = realpathSync(resolve(softwareArg));
assert(output.startsWith(realpathSync('work') + '/') && !existsSync(join(output, 'result.json')));
const directory = join(output, 'prepared'),
  read = (n) => JSON.parse(readFileSync(join(directory, n))),
  packet = await validateContentPacket(read('packet.json'));
assert.notEqual(packet.publicationIntent, 'PRIVATE_TEST_ONLY');
const config = JSON.parse(readFileSync(configArg)),
  origin = assertPublisherTarget(config),
  code = assertPublisherSoftware(
    JSON.parse(readFileSync(join(software, 'runtime/software-report.json'))),
    config,
  ),
  bytes = readFileSync(join(directory, 'production-snapshot.json'));
const checked = await captureProductionSnapshot(
  { get: async () => ({ size: bytes.length, json: async () => JSON.parse(bytes) }) },
  { ...config, abiSHA256: code.abiSHA256, publicKey: Buffer.from(config.publicKeyHex, 'hex') },
);
assert.equal(read('activation-receipt.json').verifiedRoot, checked.rootSHA256);
assert.equal(checked.snapshot.revision, packet.revision);
const control = await (
  await fetch(origin + '/delivery-release.json', { cache: 'no-store' })
).json();
assert.equal(control.controlRevision, code.revision);
assert.equal(control.verifiedRoot, checked.rootSHA256);
const sealed = { snapshot: checked.snapshot, verifiedRoot: checked.rootSHA256 };
const live = await verifyContentLive({
  directory,
  packet,
  sealed,
  publicOrigin: origin,
  progress: (r) => console.log(JSON.stringify(r)),
});
const baseline = sharedContentBaseline(),
  old = existsSync(baseline) ? JSON.parse(readFileSync(baseline)) : null;
if (old)
  assert(
    [packet.parentSnapshotSHA256, checked.rootSHA256].includes(old.verifiedRoot),
    'Accepted source baseline moved; preserve and reconcile',
  );
const capsules = [...(old?.capsules ?? [])];
if (
  !capsules.some(
    (c) =>
      c.sourceCommit === packet.sourceCommit &&
      c.path === packet.sourceCapsule.path &&
      c.sha256 === packet.sourceCapsule.sha256,
  )
)
  capsules.push({
    sourceCommit: packet.sourceCommit,
    path: packet.sourceCapsule.path,
    sha256: packet.sourceCapsule.sha256,
    liveReceipt: join(directory, 'live-verification.json'),
  });
writeFileSync(
  baseline,
  JSON.stringify(
    {
      status: 'DATA_ONLY_CONTENT_PUBLICATION_LIVE_VERIFIED',
      revision: packet.revision,
      sourceCommit: packet.sourceCommit,
      verifiedRoot: checked.rootSHA256,
      capsules,
      requiresSourceMaterialization: true,
      at: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
const result = {
  status: 'CONTENT_ONLY_PRODUCTION_LIVE_VERIFIED',
  recovery: 'ALREADY_ACTIVE_VERIFIED_WITHOUT_REACTIVATION',
  revision: packet.revision,
  root: checked.rootSHA256,
  artworks: packet.changes.length,
  topics: packet.topicChanges.length,
  livePages: live.pages.length,
  liveMedia: live.media.files.length,
  liveReceiptSHA256: createHash('sha256')
    .update(readFileSync(join(directory, 'live-verification.json')))
    .digest('hex'),
};
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
