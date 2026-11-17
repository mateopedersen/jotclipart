// Prepare only a committed source-bound normal content packet; no cloud writes.
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  constants,
} from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import { readArtwork } from '../../server/catalog-snapshot/artwork-facet-reader.mjs';
import { openSevenFacetCollectionContext } from '../../server/catalog-snapshot/collection-context.mjs';
import { validateTopicRecord } from '../../server/catalog-collections/writer.mjs';
import { canonical } from '../../server/catalog-search/store.mjs';
import {
  metadataSignature,
  reviewContextSignature,
  validateEditorialReview,
} from '../artwork-editorial.mjs';
import { createReviewedDeltaValidators } from '../catalog-snapshot/validate-delta-source.mjs';
import { verifySourceFile } from '../catalog-snapshot/source-files.mjs';
import { sharedContentBaseline } from '../catalog-snapshot/legacy-source-guard.mjs';
import { verifiedArrayMember } from '../catalog-snapshot/array-member-source.mjs';
import {
  incomingManifestSHA256,
  incomingMediaFiles,
} from '../catalog-snapshot/incoming-media-plan.mjs';

const [id, repairPDFArg, repairReceiptArg, outputArg, sourceImageArg] = process.argv.slice(2);
assert(
  id && repairPDFArg && repairReceiptArg && outputArg,
  'id verified-repair.pdf verified-repair.json new-work-directory',
);
const output = resolve(outputArg);
assert(output.startsWith(resolve('work') + '/') && !existsSync(output));
const sha = (b) => createHash('sha256').update(b).digest('hex'),
  hashRecord = (o) => sha(Buffer.from(JSON.stringify(canonical(o))));
const material = resolve('work/jotclipart-source-materialization'),
  manifest = JSON.parse(readFileSync(join(material, 'source-materialization-manifest.json')));
let historical;
for (const c of [...manifest.capsules].reverse()) {
  const bytes = gunzipSync(readFileSync(join(material, c.file)));
  assert.equal(sha(bytes), c.sha256);
  if (!bytes.includes(Buffer.from('"' + id + '"'))) continue;
  const capsule = JSON.parse(bytes);
  if (capsule.artworkRows.some((r) => r.id === id)) {
    historical = { capsule, source: c };
    break;
  }
}
assert(historical, 'Exact preserved source capsule required');
const oldRow = historical.capsule.artworkRows.find((r) => r.id === id),
  topic = oldRow.raw.topic;
const captured = resolve('../captured-catalog'),
  config = JSON.parse(readFileSync('config/content-publisher-public.json'));
const software = JSON.parse(readFileSync('config/content-publisher.json')).software;
const baselinePath = sharedContentBaseline(),
  accepted = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath)) : null;
const originalCapsules = new Set(
  manifest.capsules.map((c) => c.sourceCommit + ':' + c.path + ':' + c.sha256),
);
const acceptedRawOverrides = new Map(),
  objectDirectories = [];
let snapshotPath = join(captured, 'production-snapshot.json'),
  selectedRoot = manifest.root;
for (const entry of accepted?.capsules ?? []) {
  if (entry.liveReceipt && existsSync(entry.liveReceipt)) {
    const receipt = JSON.parse(readFileSync(entry.liveReceipt)),
      directory = dirname(resolve(entry.liveReceipt));
    if (
      existsSync(join(directory, 'production-snapshot.json')) &&
      existsSync(join(directory, 'objects'))
    ) {
      objectDirectories.unshift(join(directory, 'objects'));
      if (receipt.verifiedRoot === accepted.verifiedRoot) {
        snapshotPath = join(directory, 'production-snapshot.json');
        selectedRoot = accepted.verifiedRoot;
      }
    }
  }
  if (originalCapsules.has(entry.sourceCommit + ':' + entry.path + ':' + entry.sha256)) continue;
  assert(
    /^[a-f0-9]{40}$/.test(entry.sourceCommit) &&
      /^data\/catalog-batches\/[a-z0-9-]+\.json$/.test(entry.path),
  );
  const bytes = execFileSync('git', ['show', entry.sourceCommit + ':' + entry.path], {
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(sha(bytes), entry.sha256);
  for (const row of JSON.parse(bytes).artworkRows ?? [])
    if (row.raw) acceptedRawOverrides.set(row.id, row.raw);
}
if (accepted)
  assert.equal(
    selectedRoot,
    accepted.verifiedRoot,
    'Accepted signed source snapshot is unavailable; do not use an older parent',
  );
const bucket = {
  async get(key) {
    let bytes;
    if (key === config.activeKey) bytes = readFileSync(snapshotPath);
    else {
      const match =
        /^catalog\/objects\/(?:artworks|collections|search|recent|related|counts|sitemaps)\/([a-f0-9]{64})\.json$/.exec(
          key,
        );
      assert(match);
      const filename = match[1] + '.json',
        file =
          objectDirectories.map((d) => join(d, filename)).find(existsSync) ??
          join(captured, filename);
      bytes = readFileSync(file);
      assert.equal(sha(bytes), match[1]);
    }
    return {
      size: bytes.length,
      arrayBuffer: async () => bytes,
      json: async () => JSON.parse(bytes),
    };
  },
};
const context = await captureProductionSnapshot(bucket, {
  ...config,
  abiSHA256: software.abiSHA256,
  publicKey: Buffer.from(config.publicKeyHex, 'hex'),
});
assert.equal(context.rootSHA256, selectedRoot);
const oldRecord = await readArtwork(context, id);
assert(oldRecord);
assert.equal(oldRecord.files.webp.sha256, oldRow.raw.files.webp.sha256);
const collections = await openSevenFacetCollectionContext(bucket, { snapshot: context.snapshot });
const descriptor = await collections.lookupCollection(topic);
assert(descriptor);
const oldTopic = await collections.read(descriptor, 256 * 1024);
const topicIds = [];
for (const part of oldTopic.membership) {
  const body = await bucket.get(part.key);
  const bytes = Buffer.from(await body.arrayBuffer());
  assert.equal(sha(bytes), part.sha256);
  assert.equal(bytes.length, part.bytes);
  topicIds.push(...JSON.parse(bytes).artworkIds);
}
validateTopicRecord(oldTopic, topicIds);
const receipt = JSON.parse(readFileSync(repairReceiptArg)),
  repair = readFileSync(repairPDFArg);
assert.equal(sha(repair), receipt.sha256);
assert.equal(repair.length, receipt.bytes);
assert.equal(receipt.sourceSHA256, oldRecord.files.pdf.sha256);
assert(
  receipt.originalAlphaPreserved && receipt.fullResolutionPreserved && receipt.originalRetained,
);
assert(receipt.bytes <= 1000000 && receipt.sampleRMSE <= 1.8);
mkdirSync(join(output, 'native'), { recursive: true, mode: 0o700 });
const raw = structuredClone(oldRow.raw);
raw.files.pdf = { bytes: receipt.bytes, sha256: receipt.sha256 };
raw.pdfColorSpace = receipt.pdfColorSpace;
raw.revision = (raw.revision ?? 1) + 1;
const newRecord = {
  ...structuredClone(oldRecord),
  files: structuredClone(raw.files),
  pdfColorSpace: raw.pdfColorSpace,
  revision: raw.revision,
  pdf:
    'https://assets.jotclipart.com/' +
    topic +
    '/' +
    id +
    '.pdf.' +
    receipt.sha256.slice(0, 16) +
    '.pdf',
};
const sourceFiles = [],
  sourceMediaByURL = {},
  files = [];
for (const kind of ['webp', 'pdf', 'thumb']) {
  const path = raw[kind],
    native = join(output, 'native', basename(path)),
    facts = raw.files[kind];
  const oldURL = kind === 'thumb' ? oldRecord.originalThumb : oldRecord[kind];
  const url = (kind === 'pdf' ? newRecord.pdf : oldURL).replace(
    'https://assets.ultraclipart.com/',
    'https://assets.jotclipart.com/',
  );
  if (kind === 'pdf') copyFileSync(repairPDFArg, native, constants.COPYFILE_FICLONE);
  else if (kind === 'webp' && sourceImageArg) {
    await verifySourceFile({ path: resolve(sourceImageArg), ...facts });
    copyFileSync(sourceImageArg, native, constants.COPYFILE_FICLONE);
  } else {
    const response = await fetch(url, {
      headers: { Origin: config.publicOrigin },
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
    });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, facts.bytes);
    assert.equal(sha(bytes), facts.sha256);
    writeFileSync(native, bytes, { flag: 'wx', mode: 0o600 });
  }
  sourceFiles.push({ path: native, ...facts });
  sourceMediaByURL[url] = native;
  files.push({
    assetId: id,
    kind,
    sourceType: raw.sourceType,
    path,
    name: basename(path),
    url,
    ...facts,
    contentType: kind === 'pdf' ? 'application/pdf' : 'image/webp',
    expectedCorsOrigin: config.publicOrigin,
  });
}
const review = structuredClone(oldRow.review);
review.inputMetadataSha256 = metadataSignature(raw);
review.inputContextSha256 = reviewContextSignature(raw);
review.technicalRepair = {
  status: 'UNCHANGED_SOURCE_IMAGE_AND_COPY_RECONCILED_AFTER_PDF_CODEC_REPAIR',
  checkedAt: new Date().toISOString(),
  semanticReviewRetained: true,
  priorReviewSHA256: hashRecord(oldRow.review),
  sourceCapsuleSHA256: historical.source.sha256,
  repairReceiptSHA256: sha(readFileSync(repairReceiptArg)),
};
validateEditorialReview(raw, review);
if (oldRow.pairReceipt?.imageSHA256 !== raw.files.webp.sha256) {
  const pair = receipt.imagePair;
  assert.equal(
    pair?.status,
    'NUMERICAL_COMPOSITION_MATCH',
    'New exact image/PDF pixel evidence required',
  );
  assert.equal(pair.imageSHA256, raw.files.webp.sha256);
  assert.equal(pair.pdfSHA256, receipt.sha256);
  assert(
    pair.aspectRelativeError <= 0.01 &&
      pair.normalizedRGBRMSE <= 30 &&
      pair.normalizedRGBMeanAbsoluteError <= 20 &&
      pair.luminanceCorrelation >= 0.92,
  );
}
const pairReceipt = {
  ...structuredClone(oldRow.pairReceipt),
  status: 'REPAIRED_AND_MATCHED_SOURCE_PIXELS',
  imageSHA256: raw.files.webp.sha256,
  pdfSHA256: receipt.sha256,
  sourceOriginalPDFSHA256: receipt.sourceSHA256,
  technicalCompatibilityReceipt: receipt,
};
delete pairReceipt.receiptSHA256;
pairReceipt.receiptSHA256 = hashRecord(pairReceipt);
const artworkRow = {
  ...structuredClone(oldRow),
  expectedOldPublicSHA256: hashRecord(oldRecord),
  raw,
  review,
  pairReceipt,
};
const latestTopicsBytes = gunzipSync(readFileSync(join(material, manifest.topicRows.file)));
assert.equal(sha(latestTopicsBytes), manifest.topicRows.sha256);
const sourceTopic = verifiedArrayMember(latestTopicsBytes, 'slug', topic);
assert(sourceTopic);
const currentRawById = new Map(sourceTopic.rawItems.map((a) => [a.id, a]));
for (const [key, value] of acceptedRawOverrides)
  if (value.topic === topic) currentRawById.set(key, value);
currentRawById.set(id, raw);
sourceTopic.rawItems = topicIds.map((key) => {
  const value = currentRawById.get(key);
  assert(value, 'Accepted member source missing: ' + key);
  return value;
});
sourceTopic.resolvedItems = await Promise.all(
  sourceTopic.rawItems.map(async (a) => (a.id === id ? newRecord : readArtwork(context, a.id))),
);
sourceTopic.editorial = structuredClone(oldTopic.editorial);
const packet = {
  schema: 1,
  status: 'SOURCE_REVIEWED_CONTENT_BATCH',
  transportStatus: 'LOCAL_PLAN_ONLY_NOT_CDN_VERIFIED_NOT_LIVE',
  publicationIntent: 'OWNER_AUTHORIZED_CONFIRMED_PDF_REPAIR',
  campaign: 'jotclipart-native-pdf-compatibility-20261117',
  changes: [{ id, expectedPublicSHA256: hashRecord(oldRecord), record: newRecord }],
  topicChanges: [
    {
      slug: topic,
      expectedRecordSha256: hashRecord(oldTopic),
      record: oldTopic,
      artworkIds: topicIds,
    },
  ],
  artworkRows: [artworkRow],
  topicRows: [sourceTopic],
  sourceFiles,
  sourceMediaByURL,
  incomingMediaManifest: {
    schema: 2,
    status: 'PLANNED_INCOMING_MEDIA',
    plannedAt: new Date().toISOString(),
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    files,
  },
};
incomingMediaFiles(packet.incomingMediaManifest);
const validators = createReviewedDeltaValidators({
  ...packet,
  mediaPlanSHA256: incomingManifestSHA256(packet.incomingMediaManifest),
  phase: 'local-preflight',
});
await validators.validateSourceChange({ change: packet.changes[0], oldRecord });
await validators.validateSourceTopic({
  change: packet.topicChanges[0],
  oldRecord: oldTopic,
  resolveAfterArtwork: async (key) => (key === id ? newRecord : readArtwork(context, key)),
});
writeFileSync(join(output, 'packet-plan.json'), JSON.stringify(packet, null, 2) + '\n', {
  flag: 'wx',
});
writeFileSync(
  join(output, 'source-proof.json'),
  JSON.stringify(
    {
      source: historical.source,
      parentRoot: context.rootSHA256,
      repairReceipt: receipt,
      originalMetadataPreserved: true,
      originalWebPAndThumbnailPreserved: true,
      preparedNotPublished: true,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    output,
    parentRoot: context.rootSHA256,
    artworks: 1,
    topics: 1,
    pdfColorSpace: raw.pdfColorSpace,
    pdfBytes: receipt.bytes,
    status: 'LOCAL_SOURCE_GATES_PASSED_NOT_PUBLISHED',
  }),
);
