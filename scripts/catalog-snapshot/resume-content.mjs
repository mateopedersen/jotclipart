// Resume a completely byte-verified staged packet. Never repeat media uploads
// or admit an unverified packet; source replay, CAS and live checks still run.
import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { validateContentPacket } from './prepare-content.mjs';
import { withCatalogReader } from './publish-content.mjs';
import { sealCatalogContent } from './seal-content.mjs';
import { activateCatalogContent } from './activate-content.mjs';
import { verifyContentLive } from './verify-content-live.mjs';
import { sharedContentBaseline } from './legacy-source-guard.mjs';
import { reverifyIncomingBeforeSeal } from './incoming-media-readback.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export async function resumeStagedContent({ output, software, publicConfig, progress = () => {} }) {
  output = resolve(output);
  if (!realpathSync(output).startsWith(realpathSync('work') + '/'))
    throw Error('Protected staged packet directory required');
  if (existsSync(join(output, 'result.json'))) throw Error('Completed packet must not be repeated');
  const started = Date.now(),
    directory = join(output, 'prepared'),
    read = (n) => JSON.parse(readFileSync(join(directory, n))),
    packet = await validateContentPacket(read('packet.json'));
  if (packet.publicationIntent === 'PRIVATE_TEST_ONLY')
    throw Error('Private test packet cannot resume production');
  const code = JSON.parse(readFileSync(join(software, 'runtime/software-report.json'))),
    verifier = {
      ...publicConfig,
      abiSHA256: code.abiSHA256,
      publicKey: Uint8Array.from(Buffer.from(publicConfig.publicKeyHex, 'hex')),
    };
  const control = await (
    await fetch('https://ultraclipart.com/delivery-release.json', { cache: 'no-store' })
  ).json();
  assert.equal(control.controlRevision, code.revision, 'Installed software changed');
  assert.equal(control.verifiedRoot, packet.parentSnapshotSHA256, 'Production parent changed');
  const remote = read('remote-receipt.json');
  assert.equal(remote.status, 'REMOTE_METADATA_BYTES_SHA_MIME_VERIFIED_NOT_ACTIVATED');
  progress({
    phase: 'resume-verified-staged-packet',
    sourceFiles: packet.sourceFiles.length,
    metadataObjects: remote.objects,
    mediaUploadsRepeated: 0,
  });
  const finalMediaReadback = await reverifyIncomingBeforeSeal({ directory, verifier });
  const sealed = await withCatalogReader(
    {
      directory: join(output, 'resume-seal-' + started),
      verifier,
      parentSnapshotSHA256: packet.parentSnapshotSHA256,
    },
    (bucket) =>
      sealCatalogContent({
        directory,
        parentBucket: bucket,
        verifier,
        software,
        finalMediaReadback,
      }),
  );
  const before = await (
    await fetch('https://ultraclipart.com/delivery-release.json', { cache: 'no-store' })
  ).json();
  assert.equal(before.controlRevision, code.revision);
  assert.equal(before.verifiedRoot, packet.parentSnapshotSHA256);
  await activateCatalogContent({ directory, sealed, verifier });
  await verifyContentLive({ directory, packet, sealed, progress });
  const log = join(output, '..', 'publish.log'),
    firstStarted = existsSync(log) ? statSync(log).birthtimeMs : started;
  const result = {
    status: 'CONTENT_ONLY_PRODUCTION_LIVE_VERIFIED',
    revision: packet.revision,
    root: sealed.verifiedRoot,
    artworks: packet.changes.length,
    topics: packet.topicChanges.length,
    seconds: (Date.now() - firstStarted) / 1000,
    resumeSeconds: (Date.now() - started) / 1000,
    timingBasis:
      'First publish log creation through public verification; includes earlier transient read failure and recovery.',
    mediaUploadsRepeated: 0,
    fullCatalogPagesBuilt: 0,
    oldCatalogScans: 0,
    liveReceiptSHA256: hash(readFileSync(join(directory, 'live-verification.json'))),
  };
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  const baseline = sharedContentBaseline(),
    old = existsSync(baseline) ? JSON.parse(readFileSync(baseline)) : null;
  writeFileSync(
    baseline,
    JSON.stringify(
      {
        status: 'DATA_ONLY_CONTENT_PUBLICATION_LIVE_VERIFIED',
        revision: packet.revision,
        sourceCommit: packet.sourceCommit,
        verifiedRoot: sealed.verifiedRoot,
        capsules: [
          ...(old?.capsules ?? []),
          {
            sourceCommit: packet.sourceCommit,
            path: packet.sourceCapsule.path,
            sha256: packet.sourceCapsule.sha256,
            liveReceipt: join(directory, 'live-verification.json'),
          },
        ],
        requiresSourceMaterialization: true,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, software, config] = process.argv.slice(2);
  if (!config) throw Error('Use protected-staged-output installed-software public-config');
  console.log(
    JSON.stringify(
      await resumeStagedContent({
        output,
        software: resolve(software),
        publicConfig: JSON.parse(readFileSync(config)),
        progress: (r) => console.log(JSON.stringify(r)),
      }),
    ),
  );
}
