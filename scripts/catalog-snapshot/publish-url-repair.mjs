// Operator-only repair through the existing immutable stage/replay/sign/CAS lifecycle.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { configuredToken } from '../r2/cloudflare-api.mjs';
import { withCatalogReader } from './publish-content.mjs';
import { prepareURLRepair, URL_REPAIR_SOURCE_FILES } from './prepare-url-repair.mjs';
import { verifyNativeContent } from './test-content-native.mjs';
import { sealCatalogContent } from './seal-content.mjs';
import { activateCatalogContent } from './activate-content.mjs';
import { finalizePresentationOnly } from './publish-presentation.mjs';
import { sharedContentBaseline } from './legacy-source-guard.mjs';
import { snapshotDigest } from '../../server/catalog-snapshot/release-pointer.mjs';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
export async function publishURLRepair({
  mode,
  software,
  publicConfig,
  output,
  progress = () => {},
}) {
  assert(['prepare', 'seal', 'activate', 'finalize'].includes(mode));
  output = resolve(output);
  assert(output.startsWith(resolve('work') + '/'));
  const code = JSON.parse(readFileSync(join(software, 'runtime/software-report.json'))),
    verifier = {
      ...publicConfig,
      abiSHA256: code.abiSHA256,
      publicKey: Uint8Array.from(Buffer.from(code.publicKeyHex, 'hex')),
    },
    baselinePath = sharedContentBaseline(),
    prepared = join(output, 'prepared'),
    read = (n) => JSON.parse(readFileSync(join(output, n))),
    write = (n, v) => writeFileSync(join(output, n), JSON.stringify(v, null, 2), { flag: 'wx' }),
    control = async () => {
      const r = await fetch('https://ultraclipart.com/delivery-release.json', {
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
  if (mode === 'prepare') {
    assert(!existsSync(output), 'Use a new protected output');
    mkdirSync(output, { recursive: true });
    const expected = await control(),
      head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      plan = JSON.parse(readFileSync('data/routes/artwork-public-url-repair-20261109.json')),
      baselineBytes = readFileSync(baselinePath);
    assert.equal(expected.controlRevision, code.revision);
    assert.equal(plan.parentRoot, expected.verifiedRoot);
    assert.equal(plan.total, expected.artworks);
    assert.equal(JSON.parse(baselineBytes).verifiedRoot, expected.verifiedRoot);
    const packet = {
      schema: 1,
      status: 'SOURCE_DERIVED_URL_REPAIR_BATCH',
      publicationIntent: 'OWNER_AUTHORIZED_URL_REPAIR',
      sourceCommit: head,
      revision: head,
      parentSnapshotSHA256: expected.verifiedRoot,
      softwareABI: code.abiSHA256,
      presentationBundleSHA256: code.presentation.sha256,
      sourceHashes: Object.fromEntries(
        URL_REPAIR_SOURCE_FILES.map((f) => [f, sha(readFileSync(f))]),
      ),
    };
    write('live-before.json', expected);
    write('config.json', publicConfig);
    writeFileSync(join(output, 'baseline-before-presentation.json'), baselineBytes, { flag: 'wx' });
    const result = await withCatalogReader(
      {
        directory: join(output, 'compose-reader'),
        verifier,
        parentSnapshotSHA256: expected.verifiedRoot,
      },
      async (parentBucket) => {
        const result = await prepareURLRepair({
          packetBytes: Buffer.from(JSON.stringify(packet)),
          parentBucket,
          verifier,
          output: prepared,
          software,
          progress,
        });
        const native = await verifyNativeContent({
          candidate: result.result.candidate,
          created: result.result.created,
          parentBucket,
          software,
          packet,
          preparedPresentation: result.result.presentationReceipt,
        });
        writeFileSync(
          join(prepared, 'native-integration-report.json'),
          JSON.stringify(native, null, 2),
          { flag: 'wx' },
        );
        return result;
      },
    );
    const receipt = {
      status: 'URL_REPAIR_PREPARED_NATIVE_VERIFIED_NOT_LIVE',
      directory: prepared,
      revision: packet.revision,
      parentRoot: expected.verifiedRoot,
      redirects: result.result.bridge.redirects,
      documents: result.result.preparedDiscoveryDocuments,
    };
    write('prepare-result.json', receipt);
    return receipt;
  }
  const expected = read('live-before.json'),
    packet = read('prepared/packet.json');
  assert.equal(packet.status, 'SOURCE_DERIVED_URL_REPAIR_BATCH');
  assert.equal(
    packet.sourceCommit,
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  );
  if (mode === 'seal') {
    assert.deepEqual(await control(), expected);
    assert.equal(
      sha(readFileSync(baselinePath)),
      sha(readFileSync(join(output, 'baseline-before-presentation.json'))),
    );
    if (!existsSync(join(prepared, 'remote-receipt.json')))
      execFileSync(process.execPath, ['scripts/catalog-snapshot/stage.mjs', prepared], {
        stdio: 'inherit',
      });
    const sealed = await withCatalogReader(
      {
        directory: join(output, 'seal-reader'),
        verifier,
        parentSnapshotSHA256: expected.verifiedRoot,
      },
      (parentBucket) =>
        sealCatalogContent({
          directory: prepared,
          parentBucket,
          verifier,
          software,
          replay: prepareURLRepair,
        }),
    );
    const proof = {
      status: 'URL_REPAIR_REPLAY_REMOTE_READBACK_AND_SIGNATURE_VERIFIED_NOT_LIVE',
      root: sealed.verifiedRoot,
      snapshotSHA256: sealed.snapshotSHA256,
      revision: sealed.snapshot.revision,
    };
    write('seal-proof.json', proof);
    return proof;
  }
  if (mode === 'activate') {
    assert.deepEqual(await control(), expected);
    const baselineBytes = readFileSync(baselinePath);
    assert.equal(
      sha(baselineBytes),
      sha(readFileSync(join(output, 'baseline-before-presentation.json'))),
    );
    const seal = read('seal-proof.json'),
      bytes = readFileSync(join(prepared, 'production-snapshot.json')),
      snapshot = JSON.parse(bytes),
      root = await snapshotDigest(snapshot);
    assert.equal(root, seal.root);
    assert.equal(sha(bytes), seal.snapshotSHA256);
    assert.equal(snapshot.revision, packet.revision);
    assert.equal(snapshot.authorization.parentSnapshotSHA256, expected.verifiedRoot);
    await captureProductionSnapshot(
      { get: async () => ({ size: bytes.length, json: async () => snapshot }) },
      verifier,
    );
    const receipt = {
      status: 'PRESENTATION_POINTER_ACTIVE_LIVE_VALIDATION_PENDING',
      revision: packet.revision,
      root,
      parentRevision: snapshot.parentRevision,
      parentRoot: expected.verifiedRoot,
      softwareRevision: code.revision,
      softwareABI: code.abiSHA256,
      sourceCommit: packet.sourceCommit,
      preparedDirectory: prepared,
      baselinePath,
      baselineSHA256: sha(baselineBytes),
      canonicalArtworksChanged: 0,
      mediaUploads: 0,
      documents: read('prepared/prepared-presentation-receipt.json').canonicalDocumentsPrepared,
      bridge: join(prepared, 'presentation-bridge.json'),
      at: new Date().toISOString(),
    };
    write('activation-intent.json', {
      ...receipt,
      status: 'PRESENTATION_ACTIVATION_INTENT_NOT_LIVE',
    });
    await activateCatalogContent({
      directory: prepared,
      sealed: { snapshot, snapshotSHA256: seal.snapshotSHA256, verifiedRoot: root },
      verifier,
    });
    write('activation-result.json', receipt);
  }
  return finalizePresentationOnly({ software, publicConfig, output, progress });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, software, config, output] = process.argv.slice(2);
  if (!output)
    throw Error(
      'Use prepare|seal|activate|finalize installed-software public-config new-work-output',
    );
  process.env.CLOUDFLARE_API_TOKEN = configuredToken();
  const result = await publishURLRepair({
    mode,
    software: resolve(software),
    publicConfig: JSON.parse(readFileSync(config)),
    output,
    progress: (row) => console.log(JSON.stringify(row)),
  });
  console.log(JSON.stringify(result));
}
