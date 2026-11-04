// Content-only operator CLI. No Astro, full catalogue build, account list or CI.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { withPrivateCatalogSession } from './operator-session.mjs';
import { remoteCatalogBucket } from './remote-reader.mjs';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import { prepareCatalogContent, validateContentPacket } from './prepare-content.mjs';
import { createReviewedDeltaValidators } from './validate-delta-source.mjs';
import { readArtwork } from '../../server/catalog-snapshot/artwork-facet-reader.mjs';
import { stageScopedFiles } from './stage-files.mjs';
import { verifyNativeContent } from './test-content-native.mjs';
import { sealCatalogContent } from './seal-content.mjs';
import { activateCatalogContent } from './activate-content.mjs';
import { verifyContentLive } from './verify-content-live.mjs';
import { validateManifest } from '../publication-policy.mjs';
import { sharedContentBaseline } from './legacy-source-guard.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export async function withCatalogReader({ directory, verifier, parentSnapshotSHA256 }, operate) {
  return withPrivateCatalogSession(
    { directory, kind: 'reader', job: { parentSnapshotSHA256, verifier } },
    async ({ secret }) =>
      operate(
        remoteCatalogBucket({
          secret,
          parentSnapshotSHA256,
          accountId: verifier.accountId,
          bucket: verifier.bucketName,
        }),
      ),
  );
}
export async function publishReviewedCapsule({
  capsulePath,
  software,
  publicConfig,
  output,
  activate = false,
  progress = () => {},
}) {
  const started = Date.now(),
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    capsuleBytes = execFileSync('git', ['show', sourceCommit + ':' + capsulePath], {
      maxBuffer: 32 * 1024 * 1024,
    }),
    fields = JSON.parse(capsuleBytes),
    code = JSON.parse(readFileSync(join(software, 'runtime/software-report.json'))),
    verifier = {
      ...publicConfig,
      abiSHA256: code.abiSHA256,
      publicKey: Uint8Array.from(Buffer.from(publicConfig.publicKeyHex, 'hex')),
    },
    control = await (
      await fetch('https://ultraclipart.com/delivery-release.json', { cache: 'no-store' })
    ).json(),
    parentSnapshotSHA256 = control.verifiedRoot;
  if (!/^[a-f0-9]{64}$/.test(parentSnapshotSHA256 ?? '')) throw Error('Live catalog root required');
  const revision = hash(
      Buffer.from(
        'catalog-content-v1\n' +
          sourceCommit +
          '\n' +
          hash(capsuleBytes) +
          '\n' +
          parentSnapshotSHA256,
      ),
    ).slice(0, 40),
    packet = {
      ...fields,
      sourceCommit,
      sourceCapsule: { path: capsulePath, sha256: hash(capsuleBytes) },
      revision,
      parentSnapshotSHA256,
    };
  await validateContentPacket(packet);
  output = resolve(output);
  if (!output.startsWith(resolve('work') + '/') || existsSync(output))
    throw Error('New protected batch work directory required');
  mkdirSync(output, { recursive: true });
  // Review source and exact old records BEFORE permitting binary writes.
  await withCatalogReader(
    { directory: join(output, 'preflight-reader'), verifier, parentSnapshotSHA256 },
    async (bucket) => {
      const parent = await captureProductionSnapshot(bucket, verifier),
        validators = createReviewedDeltaValidators({
          artworkRows: packet.artworkRows,
          topicRows: packet.topicRows,
          incomingMediaManifest: packet.incomingMediaManifest,
          mediaReceiptSHA256: hash(Buffer.from(JSON.stringify(packet.incomingMediaManifest))),
        });
      for (const change of packet.changes)
        await validators.validateSourceChange({
          change,
          oldRecord: await readArtwork(parent, change.id),
        });
    },
  );
  const files = [...validateManifest(packet.incomingMediaManifest).values()];
  if (files.length) {
    const records = files.map((f) => ({
        key: new URL(f.url).pathname.slice(1),
        path: f.path,
        bytes: f.bytes,
        sha256: f.sha256,
        mime: f.contentType,
        ...(f.kind === 'pdf'
          ? { contentDisposition: 'attachment; filename="' + f.assetId + '.pdf"' }
          : {}),
      })),
      sourceByKey = Object.fromEntries(
        files.map((f) => [new URL(f.url).pathname.slice(1), packet.sourceMediaByURL?.[f.url]]),
      );
    await stageScopedFiles({
      records,
      sourceByKey,
      revision,
      verifier: { ...verifier, bucketName: 'ultraclipart-media' },
      directory: join(output, 'incoming-media'),
      progress,
    });
  }
  const prepared = await withCatalogReader(
    { directory: join(output, 'compose-reader'), verifier, parentSnapshotSHA256 },
    async (bucket) => {
      const result = await prepareCatalogContent({
        packetBytes: Buffer.from(JSON.stringify(packet)),
        parentBucket: bucket,
        verifier,
        output: join(output, 'prepared'),
        progress,
      });
      const native = await verifyNativeContent({
        candidate: result.result.candidate,
        created: result.result.created,
        parentBucket: bucket,
        software,
        packet,
      });
      writeFileSync(
        join(result.output, 'native-integration-report.json'),
        JSON.stringify(native, null, 2),
      );
      return result;
    },
  );
  if (!activate) {
    const result = {
      status: 'PREPARED_NATIVE_TESTED_NOT_LIVE',
      revision,
      prepared: prepared.output,
      seconds: (Date.now() - started) / 1000,
    };
    writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  }
  execFileSync(process.execPath, ['scripts/catalog-snapshot/stage.mjs', prepared.output], {
    stdio: 'inherit',
  });
  const sealed = await withCatalogReader(
    { directory: join(output, 'seal-reader'), verifier, parentSnapshotSHA256 },
    (bucket) =>
      sealCatalogContent({ directory: prepared.output, parentBucket: bucket, verifier, software }),
  );
  await activateCatalogContent({ directory: prepared.output, sealed, verifier });
  const live = await verifyContentLive({ directory: prepared.output, packet, sealed, progress }),
    result = {
      status: 'CONTENT_ONLY_PRODUCTION_LIVE_VERIFIED',
      revision,
      root: sealed.verifiedRoot,
      artworks: packet.changes.length,
      topics: packet.topicChanges.length,
      seconds: (Date.now() - started) / 1000,
      fullCatalogPagesBuilt: 0,
      oldCatalogScans: 0,
      liveReceiptSHA256: hash(readFileSync(join(prepared.output, 'live-verification.json'))),
    };
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  const baselinePath = sharedContentBaseline();
  const old = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath)) : null;
  writeFileSync(
    baselinePath,
    JSON.stringify(
      {
        status: 'DATA_ONLY_CONTENT_PUBLICATION_LIVE_VERIFIED',
        revision,
        sourceCommit,
        verifiedRoot: sealed.verifiedRoot,
        capsules: [
          ...(old?.capsules ?? []),
          {
            sourceCommit,
            path: capsulePath,
            sha256: hash(capsuleBytes),
            liveReceipt: join(prepared.output, 'live-verification.json'),
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
  const [mode, capsulePath, software, config, output] = process.argv.slice(2);
  if (!['prepare', 'publish'].includes(mode) || !output)
    throw Error(
      'Use prepare|publish committed-capsule-path installed-software public-config new-work-directory',
    );
  console.log(
    JSON.stringify(
      await publishReviewedCapsule({
        capsulePath,
        software: resolve(software),
        publicConfig: JSON.parse(readFileSync(config)),
        output,
        activate: mode === 'publish',
        progress: (r) => console.log(JSON.stringify(r)),
      }),
    ),
  );
}
