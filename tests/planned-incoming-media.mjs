// Private protocol fixtures only. They are not production artwork or review approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { validateManifest, MIME_TYPES } from '../scripts/publication-policy.mjs';
import {
  incomingMediaFiles,
  incomingManifestSHA256,
  verifyIncomingPlanSources,
  incomingMediaStageScope,
  assertIncomingStageReceipt,
  assertIncomingCDNReceipt,
} from '../scripts/catalog-snapshot/incoming-media-plan.mjs';
import { verifyIncomingMedia } from '../scripts/catalog-snapshot/batch-media.mjs';
import { createReviewedDeltaValidators } from '../scripts/catalog-snapshot/validate-delta-source.mjs';
import { merkle } from '../scripts/delivery/manifest.mjs';
import { PDFDocument } from 'pdf-lib';
const protocolPDF = await PDFDocument.create();
protocolPDF.addPage([72, 72]).drawRectangle({ x: 12, y: 12, width: 24, height: 24 });
const validProtocolPDFBytes = Buffer.from(await protocolPDF.save());
const sha = (b) => createHash('sha256').update(b).digest('hex');
const canonical = (x) =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
const digest = (x) => sha(JSON.stringify(canonical(x)));
const sourceFixture = JSON.parse(readFileSync(resolve('tests/fixtures/catalog-delta-source.json')));
function planOf(verified) {
  const p = structuredClone(verified);
  p.status = 'PLANNED_INCOMING_MEDIA';
  p.plannedAt = p.verifiedAt;
  delete p.verifiedAt;
  for (const f of p.files) {
    f.expectedCorsOrigin = f.corsOrigin;
    delete f.corsOrigin;
    delete f.verification;
    delete f.verifiedAt;
  }
  return p;
}
function mediaFixture() {
  const bodies = new Map(),
    files = ['webp', 'pdf', 'thumb'].map((kind) => {
      const body =
          kind === 'pdf'
            ? validProtocolPDFBytes
            : Buffer.from('PRIVATE_SYNTHETIC_PROTOCOL_BYTES_' + kind),
        hash = sha(body),
        extension = kind === 'thumb' ? 'webp' : kind,
        path = '/catalog/private/' + kind + '.' + extension,
        url =
          'https://assets.ultraclipart.com/private/' +
          kind +
          '.' +
          hash.slice(0, 16) +
          '.' +
          extension;
      bodies.set(url, body);
      return {
        assetId: 'private-synthetic-only',
        sourceType: 'raster',
        kind,
        path,
        name: path.split('/').at(-1),
        url,
        bytes: body.length,
        sha256: hash,
        contentType: MIME_TYPES[kind],
        expectedCorsOrigin: 'https://ultraclipart.com',
      };
    });
  const manifest = {
    schema: 2,
    status: 'PLANNED_INCOMING_MEDIA',
    plannedAt: '2026-11-04T00:00:00Z',
    files,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
  };
  let gets = 0;
  const fetcher = async (url, init) => {
    gets++;
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Origin, 'https://ultraclipart.com');
    const f = files.find((f) => f.url === url);
    assert(f);
    return new Response(bodies.get(url), {
      headers: {
        'content-type': f.contentType,
        'access-control-allow-origin': f.expectedCorsOrigin,
      },
    });
  };
  return { manifest, bodies, fetcher, count: () => gets };
}
function editorialOptions() {
  const f = structuredClone(sourceFixture),
    manifest = planOf(f.media),
    row = {
      id: f.raw.id,
      raw: f.raw,
      review: f.review,
      expectedOldPublicSHA256: null,
      monochromeReceipt: {
        sourceSHA256: f.raw.files.thumb.sha256,
        monochrome: f.record.monochrome,
        kind: f.record.monochromeKind,
        receiptSHA256: '1'.repeat(64),
      },
      pairReceipt: {
        status: 'MATCHED_SOURCE_PIXELS',
        imageSHA256: f.raw.files.webp.sha256,
        pdfSHA256: f.raw.files.pdf.sha256,
        receiptSHA256: '2'.repeat(64),
      },
    },
    options = { artworkRows: [row], topicRows: [], incomingMediaManifest: manifest },
    change = { id: f.raw.id, expectedPublicSHA256: null, record: f.record };
  return { f, row, manifest, options, change, oldRecord: null };
}
function testCDNReceipt(manifest) {
  return {
    status: 'INCOMING_MEDIA_CDN_GET_BYTES_SHA_MIME_CORS_VERIFIED',
    manifestSHA256: incomingManifestSHA256(manifest),
    files: manifest.files.map((f) =>
      Object.fromEntries(
        ['url', 'assetId', 'kind', 'bytes', 'sha256', 'contentType']
          .map((k) => [k, f[k]])
          .concat([['corsOrigin', f.expectedCorsOrigin]]),
      ),
    ),
    oldCatalogScans: 0,
  };
}
test('strict verified validator is unchanged and refuses every planned manifest', () => {
  const original = structuredClone(sourceFixture.media),
    planned = planOf(original);
  assert.equal(validateManifest(original).size, 3);
  assert.throws(() => validateManifest(planned), /verified/);
  assert.equal(incomingMediaFiles(planned).size, 3);
  assert.deepEqual(original, sourceFixture.media);
  assert(!Object.hasOwn(planned, 'verifiedAt'));
  assert(
    planned.files.every(
      (f) =>
        !Object.hasOwn(f, 'verification') &&
        !Object.hasOwn(f, 'verifiedAt') &&
        !Object.hasOwn(f, 'corsOrigin'),
    ),
  );
});
test('planned metadata refuses premature CDN claims and malformed scoped identities', () => {
  const mutations = [
    (m) => (m.verifiedAt = m.plannedAt),
    (m) => (m.files[0].verification = 'cdn-get-sha256'),
    (m) => (m.files[0].verifiedAt = m.plannedAt),
    (m) => (m.files[0].corsOrigin = '*'),
    (m) => (m.files[0].expectedCorsOrigin = 'https://foreign.invalid'),
    (m) => (m.files[0].url = m.files[0].url.replace('assets.ultraclipart.com', 'foreign.invalid')),
    (m) => (m.files[0].url += '?mutable=1'),
    (m) => (m.files[0].sha256 = 'f'.repeat(64)),
    (m) => (m.files[0].contentType = 'application/octet-stream'),
    (m) => (m.files[0].path = '/catalog/../escape.webp'),
    (m) => (m.files[0].name = 'wrong.webp'),
    (m) => (m.files[0].kind = 'pdf'),
    (m) => (m.files[0].bytes = 0),
    (m) => (m.files[1].bytes = 1_000_001),
    (m) => (m.files[0].sourceType = 'layered'),
    (m) => m.files.pop(),
    (m) => m.files.push(m.files[0]),
    (m) => m.bytes++,
    (m) => (m.files = Array(1025).fill(m.files[0])),
  ];
  for (const mutate of mutations) {
    const { manifest } = mediaFixture();
    mutate(manifest);
    assert.throws(() => incomingMediaFiles(manifest));
  }
});
test('plans bind every URL to freshly checked protected native bytes before transport', async () => {
  const { manifest, bodies } = mediaFixture(),
    dir = resolve(
      'work/imports/owner-brands-8-20261104/operator-plan-fix/native-fixture-' +
        randomBytes(6).toString('hex'),
    );
  mkdirSync(dir, { recursive: true });
  try {
    const sourceFiles = manifest.files.map((f) => {
        const path = join(dir, f.name);
        writeFileSync(path, bodies.get(f.url));
        return { path, bytes: f.bytes, sha256: f.sha256 };
      }),
      packet = {
        incomingMediaManifest: manifest,
        sourceFiles,
        sourceMediaByURL: Object.fromEntries(
          manifest.files.map((f, i) => [f.url, sourceFiles[i].path]),
        ),
      };
    const proof = await verifyIncomingPlanSources(packet);
    assert.equal(proof.status, 'PLANNED_INCOMING_MEDIA_LOCAL_SOURCE_VERIFIED_NOT_REMOTE');
    const changedMap = structuredClone(packet);
    changedMap.sourceMediaByURL[manifest.files[0].url] = resolve('AGENTS.md');
    await assert.rejects(() => verifyIncomingPlanSources(changedMap));
    const missing = structuredClone(packet);
    delete missing.sourceMediaByURL[manifest.files[0].url];
    await assert.rejects(() => verifyIncomingPlanSources(missing));
    const extra = structuredClone(packet);
    extra.sourceMediaByURL['https://foreign.invalid/a.webp'] = sourceFiles[0].path;
    await assert.rejects(() => verifyIncomingPlanSources(extra));
    writeFileSync(sourceFiles[0].path, Buffer.alloc(sourceFiles[0].bytes, 99));
    await assert.rejects(() => verifyIncomingPlanSources(packet), /source changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('source preflight validates reviewed identity and pair evidence without remote receipt claims', async () => {
  const x = editorialOptions(),
    options = {
      ...x.options,
      phase: 'local-preflight',
      mediaPlanSHA256: incomingManifestSHA256(x.manifest),
    },
    v = createReviewedDeltaValidators(options),
    r = await v.validateSourceChange(x);
  assert.equal(r.mediaPlanSHA256, incomingManifestSHA256(x.manifest));
  assert.equal(r.mediaReceiptSHA256, undefined);
  assert.throws(
    () => createReviewedDeltaValidators({ ...options, mediaReceiptSHA256: 'a'.repeat(64) }),
    /never a remote receipt/,
  );
  assert.throws(
    () => createReviewedDeltaValidators({ ...options, mediaPlanSHA256: 'a'.repeat(64) }),
    /exact media plan/,
  );
  x.change.record.description += ' Unsupported changed copy.';
  await assert.rejects(() => v.validateSourceChange(x));
  const y = editorialOptions();
  y.row.pairReceipt.pdfSHA256 = 'f'.repeat(64);
  await assert.rejects(
    () =>
      createReviewedDeltaValidators({
        ...y.options,
        phase: 'local-preflight',
        mediaPlanSHA256: incomingManifestSHA256(y.manifest),
      }).validateSourceChange(y),
    /composition/,
  );
});
test('planned final source validation needs the complete exact actual CDN receipt, not its plan hash', async () => {
  const x = editorialOptions();
  assert.throws(
    () =>
      createReviewedDeltaValidators({
        ...x.options,
        mediaReceiptSHA256: incomingManifestSHA256(x.manifest),
      }),
    /fresh incoming CDN receipt/,
  );
  const proof = testCDNReceipt(x.manifest),
    options = {
      ...x.options,
      mediaReceipt: proof,
      mediaReceiptSHA256: incomingManifestSHA256(proof),
    };
  const result = await createReviewedDeltaValidators(options).validateSourceChange(x);
  assert.equal(result.mediaReceiptSHA256, incomingManifestSHA256(proof));
  assert.equal(result.mediaPlanSHA256, undefined);
  const mutations = [
    (r) => r.files.pop(),
    (r) => r.files.push(r.files[0]),
    (r) => (r.files[0].sha256 = 'f'.repeat(64)),
    (r) => r.files[0].bytes++,
    (r) => (r.files[0].contentType = 'text/plain'),
    (r) => (r.files[0].corsOrigin = '*'),
    (r) => (r.files[0].url += '?bad'),
    (r) => (r.manifestSHA256 = 'f'.repeat(64)),
    (r) => (r.status = 'PLANNED_INCOMING_MEDIA'),
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(proof);
    mutate(bad);
    assert.throws(() => assertIncomingCDNReceipt(x.manifest, bad, incomingManifestSHA256(bad)));
  }
  assert.throws(() => assertIncomingCDNReceipt(x.manifest, proof, 'f'.repeat(64)));
});
test('actual streamed planned CDN GETs produce deterministic proof with observed CORS only after success', async () => {
  const x = mediaFixture(),
    before = structuredClone(x.manifest),
    first = await verifyIncomingMedia(x.manifest, { fetcher: x.fetcher }),
    second = await verifyIncomingMedia(x.manifest, { fetcher: x.fetcher });
  assert.equal(x.count(), 6);
  assert.deepEqual(first, second);
  assert.deepEqual(x.manifest, before);
  assertIncomingCDNReceipt(x.manifest, first, incomingManifestSHA256(first));
});
for (const fault of ['http', 'mime', 'cors', 'short', 'long', 'hash'])
  test('failed actual CDN ' + fault + ' cannot become a receipt', async () => {
    const x = mediaFixture();
    await assert.rejects(() =>
      verifyIncomingMedia(x.manifest, {
        fetcher: async (url) => {
          const f = x.manifest.files.find((f) => f.url === url),
            original = x.bodies.get(url),
            body =
              fault === 'short'
                ? original.subarray(1)
                : fault === 'long'
                  ? Buffer.concat([original, Buffer.from('extra')])
                  : fault === 'hash'
                    ? Buffer.alloc(original.length, 99)
                    : original;
          return new Response(body, {
            status: fault === 'http' ? 404 : 200,
            headers: {
              'content-type': fault === 'mime' ? 'text/plain' : f.contentType,
              'access-control-allow-origin': fault === 'cors' ? '*' : f.expectedCorsOrigin,
            },
          });
        },
      }),
    );
  });
test('legacy actual CDN receipt stays byte compatible with independent historical replay', async () => {
  const x = mediaFixture(),
    legacy = structuredClone(x.manifest);
  legacy.status = 'verified';
  legacy.verifiedAt = legacy.plannedAt;
  delete legacy.plannedAt;
  for (const f of legacy.files) {
    f.corsOrigin = f.expectedCorsOrigin;
    delete f.expectedCorsOrigin;
    f.verifiedAt = legacy.verifiedAt;
    f.verification = 'cdn-get-sha256';
  }
  const proof = await verifyIncomingMedia(legacy, { fetcher: x.fetcher });
  assert.equal(proof.manifestSHA256, undefined);
  assert(proof.files.every((f) => f.corsOrigin === undefined));
  assert.deepEqual(Object.keys(proof), ['status', 'files', 'oldCatalogScans']);
});
test('R2 proof binds exact revision, media bucket, scope, bytes, hashes and full readback', () => {
  const { manifest } = mediaFixture(),
    packet = { incomingMediaManifest: manifest, revision: 'b'.repeat(40) },
    { records } = incomingMediaStageScope(packet),
    verifier = { accountId: 'owner', bucketName: 'ultraclipart-pages' },
    receipt = {
      status: 'EXACT_INCOMING_FILES_REMOTE_BYTES_SHA_MIME_VERIFIED',
      revision: packet.revision,
      root: merkle(records).root,
      accountId: verifier.accountId,
      bucket: 'ultraclipart-media',
      bytes: manifest.bytes,
      files: records.map(({ path, key, bytes, sha256 }) => ({
        path,
        key,
        bytes,
        sha256,
        etag: 'actual-fixture-etag',
      })),
    };
  assertIncomingStageReceipt(packet, receipt, verifier);
  const mutations = [
    (r) => (r.revision = 'c'.repeat(40)),
    (r) => (r.root = 'f'.repeat(64)),
    (r) => (r.accountId = 'foreign'),
    (r) => (r.bucket = 'ultraclipart-pages'),
    (r) => r.bytes++,
    (r) => r.files.pop(),
    (r) => r.files.push(r.files[0]),
    (r) => (r.files[0].sha256 = 'f'.repeat(64)),
    (r) => (r.files[0].etag = null),
    (r) => (r.files[0].verification = 'prior-byte-proof-and-current-etag'),
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(receipt);
    mutate(bad);
    assert.throws(() => assertIncomingStageReceipt(packet, bad, verifier));
  }
  assert.throws(() => assertIncomingStageReceipt(packet, null, verifier));
});
