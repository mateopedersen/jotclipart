// Canonical read-only validation after the existing guarded pointer activation.
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { snapshotDigest } from '../../server/catalog-snapshot/release-pointer.mjs';
import { openSnapshot } from '../../server/catalog-snapshot/snapshot-context.mjs';
import { readPreparedStudioInfo } from '../../server/catalog-snapshot/prepared-studio.mjs';
import { presentationState } from '../../server/catalog-snapshot/brand-presentation.mjs';
import { brand } from '../../src/lib/brand.mjs';
import { catalogPublicOrigin } from './batch-media.mjs';
import { validateMetadataManifest, readMetadataBytes } from './stage-manifest.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Verify the original prepared bytes before deriving the public URL projection. */
export async function verifiedPublicStudioSHA256({ directory, candidate, softwareABI, receipt }) {
  const manifest = validateMetadataManifest(
    JSON.parse(fs.readFileSync(join(directory, 'manifest.json'))),
  );
  const records = new Map(manifest.records.map((record) => [record.key, record]));
  const context = await openSnapshot(
    {
      get: async (key) => {
        const record = records.get(key);
        if (!record) throw Error('Prepared Studio source absent from verified local manifest');
        const bytes = readMetadataBytes(manifest, record);
        return { size: bytes.length, arrayBuffer: async () => bytes };
      },
    },
    { provided: candidate, allowFixture: true },
  );
  const source = await readPreparedStudioInfo(context, softwareABI);
  assert.notEqual(source, null, 'Prepared Studio source/code binding differs');
  const normalized = source.split(context.rootSHA256).join(receipt.sourceRoot);
  assert.equal(
    sha(Buffer.from(normalized)),
    receipt.sourceBodySHA256,
    'Original prepared Studio bytes differ before public projection',
  );
  const info = JSON.parse(normalized);
  assert.equal(info.items.length, receipt.entries);
  return sha(Buffer.from(JSON.stringify(presentationState(info))));
}

export async function verifyPresentationLive({
  directory,
  sealed,
  software,
  progress = () => {},
  publicOrigin = brand.origin,
  fetcher = fetch,
}) {
  const origin = catalogPublicOrigin(publicOrigin);
  const read = (n) => JSON.parse(fs.readFileSync(join(directory, n))),
    candidate = read('snapshot-candidate.json'),
    native = read('native-integration-report.json'),
    prepared = read('prepared-presentation-receipt.json'),
    bridge = read('presentation-bridge.json'),
    code = JSON.parse(fs.readFileSync(join(software, 'runtime/software-report.json'))),
    privateRoot = await snapshotDigest(candidate),
    expected = new Map(
      native.routes.filter((r) => r.source === 'prepared').map((r) => [r.path, r.sha256]),
    ),
    root = sealed.verifiedRoot;
  assert.equal(native.softwareABI, code.abiSHA256);
  assert.equal(expected.size, prepared.receipts.length);
  assert.equal(native.candidateSHA256, sha(Buffer.from(JSON.stringify(candidate))));
  assert.deepEqual(candidate.indexes, sealed.snapshot.indexes);
  assert.equal(candidate.revision, sealed.snapshot.revision);
  assert(
    bridge.canonicalArtworkDirectoriesUnchanged && bridge.protectedCollectionDirectoryUnchanged,
  );
  if (
    [
      'OWNER_AUTHORIZED_PUBLIC_URL_AND_SITEMAP_MIGRATION',
      'OWNER_AUTHORIZED_PUBLIC_URL_AND_SITEMAP_REPAIR',
    ].includes(bridge.kind)
  )
    assert(
      (bridge.kind === 'OWNER_AUTHORIZED_PUBLIC_URL_AND_SITEMAP_REPAIR'
        ? bridge.publicRoutesRepaired && bridge.historicalReservationsRemoved === 0
        : bridge.publicRoutesAdded) &&
        Number.isSafeInteger(bridge.sourceRecordChecks) &&
        bridge.sourceRecordChecks > 0,
    );
  else assert(bridge.artworkEnvelopeRevisionOnly);
  assert.equal(bridge.mediaBytesChanged, 0);
  assert.equal(bridge.canonicalArtworkRecordsChanged, 0);
  const publicStudioSHA256 = prepared.studio
    ? await verifiedPublicStudioSHA256({
        directory,
        candidate,
        softwareABI: code.abiSHA256,
        receipt: prepared.studio,
      })
    : null;
  const get = async (path, headers) => {
    const start = performance.now(),
      r = await fetcher(origin + path, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      }),
      ttfbMs = performance.now() - start,
      text = await r.text();
    return { r, text, ttfbMs, totalMs: performance.now() - start };
  };
  const control = await get('/delivery-release.json');
  assert.equal(control.r.status, 200);
  const identity = JSON.parse(control.text);
  assert.equal(identity.verifiedRoot, root);
  assert.equal(identity.renderedRevision, candidate.revision);
  assert.equal(identity.controlRevision, code.revision);
  const rows = [],
    done = new Set();
  async function verify(path, phase) {
    const { r, text, ttfbMs, totalMs } = await get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('x-uc-snapshot'), root, path);
    assert.equal(r.headers.get('x-uc-html-source'), 'prepared', path);
    assert(!r.headers.has('set-cookie'), path);
    assert(text.includes(brand.origin + path), path + ' canonical');
    assert.equal(
      sha(Buffer.from(text.split(root).join(privateRoot))),
      expected.get(path),
      path + ' native/public exact HTML after root normalization',
    );
    const row = {
      path,
      phase,
      status: r.status,
      bytes: Buffer.byteLength(text),
      sha256: sha(Buffer.from(text)),
      ttfbMs,
      totalMs,
      cache: r.headers.get('x-uc-html-cache'),
      source: r.headers.get('x-uc-html-source'),
      serverTiming: r.headers.get('server-timing'),
      ray: r.headers.get('cf-ray'),
    };
    rows.push(row);
    done.add(path);
    progress({
      phase,
      verified: rows.length,
      total: expected.size,
      ...(phase === 'first-canonical-request' ? row : { path }),
    });
  }
  // This pass intentionally precedes any warming/route sweep. No query busting,
  // purge, no-cache override or invented MISS label is used.
  for (const path of ['/', '/collections/', '/categories/', '/clipart/qatar-flag/'])
    if (expected.has(path)) await verify(path, 'first-canonical-request');
  const studioRows = [];
  if (prepared.studio)
    for (const path of ['/studio-featured.json', '/studio-catalog.json']) {
      const { r, text, ttfbMs, totalMs } = await get(path, {
          'x-uc-catalog-protocol': 'snapshot-search-v1',
        }),
        info = JSON.parse(text);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get('x-uc-data-source'), 'prepared');
      assert.equal(r.headers.get('x-uc-snapshot'), root);
      assert.equal(info.transport.snapshot, root);
      assert.equal(info.items.length, prepared.studio.entries);
      assert(!r.headers.has('set-cookie'));
      assert.equal(
        sha(Buffer.from(text.split(root).join(prepared.studio.sourceRoot))),
        publicStudioSHA256,
        path + ' exact source-verified public Studio JSON',
      );
      assert.match(r.headers.get('cache-control') ?? '', /no-store/);
      assert.match(r.headers.get('vary') ?? '', /X-UC-Catalog-Protocol/i);
      studioRows.push({
        path,
        status: r.status,
        entries: info.items.length,
        bytes: Buffer.byteLength(text),
        sha256: sha(Buffer.from(text)),
        sourceBodySHA256: prepared.studio.sourceBodySHA256,
        projectedBodySHA256: publicStudioSHA256,
        ttfbMs,
        totalMs,
        serverTiming: r.headers.get('server-timing'),
      });
    }
  const remaining = [...expected.keys()].filter((p) => !done.has(p));
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < remaining.length)
        await verify(remaining[next++], 'canonical-route-verification');
    }),
  );
  const after = await get('/delivery-release.json');
  assert.equal(JSON.parse(after.text).verifiedRoot, root, 'Production changed during verification');
  const report = {
    status: 'PREPARED_PRESENTATION_CANONICAL_HTML_LIVE_VERIFIED',
    publicOrigin: origin,
    revision: candidate.revision,
    softwareRevision: code.revision,
    root,
    parentRevision: bridge.parentRevision,
    documents: rows.length,
    coldObserved: rows.filter((r) => r.phase === 'first-canonical-request' && r.cache === 'MISS')
      .length,
    canonicalArtworksChanged: 0,
    mediaUploads: 0,
    nativePublicHTMLExactAfterRootNormalization: true,
    scope:
      'Canonical HTML verification. Separate real-browser original-image decode, navigation, editor and media byte checks are still required.',
    bridge,
    rows,
    studio: studioRows,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(
    join(directory, 'presentation-live-verification.json'),
    JSON.stringify(report, null, 2),
  );
  return report;
}
