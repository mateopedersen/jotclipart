// Operator-only incoming intent. This is never a verified publication manifest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import {
  ASSET_KINDS,
  MIME_TYPES,
  SITE_ORIGIN,
  assetIdentity,
  validateAssetUrl,
  validateLocalAssetPath,
  validateManifest,
} from '../publication-policy.mjs';
import { sourceTypeOf, representationKinds } from '../asset-representations.mjs';
import { verifySourceFile } from './source-files.mjs';
import { merkle } from '../delivery/manifest.mjs';
import { assertReusableIncomingReceipt } from './incoming-reuse.mjs';
import { brand, publicBrandURL } from '../../src/lib/brand.mjs';
import { readFileSync } from 'node:fs';
import { assertNoCMYKJPX } from '../pdf-compatibility-gate.mjs';
export const incomingManifestSHA256 = (manifest) =>
  createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
export const isIncomingMediaPlan = (manifest) => manifest?.status === 'PLANNED_INCOMING_MEDIA';

export function incomingMediaFiles(manifest) {
  if (!isIncomingMediaPlan(manifest)) return validateManifest(manifest);
  if (
    manifest.schema !== 2 ||
    !Number.isFinite(Date.parse(manifest.plannedAt)) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 1024 ||
    ['verifiedAt', 'verification'].some((k) => Object.hasOwn(manifest, k))
  )
    throw Error('Bounded planned incoming media without remote claims required');
  const files = new Map(),
    paths = new Set(),
    urls = new Set(),
    groups = new Map();
  let bytes = 0;
  for (const f of manifest.files) {
    if (
      !/^[a-z0-9][a-z0-9-]+$/.test(f.assetId ?? '') ||
      !ASSET_KINDS.includes(f.kind) ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes < 1 ||
      f.bytes > 8_000_000 ||
      !/^[a-f0-9]{64}$/.test(f.sha256 ?? '') ||
      ['verifiedAt', 'verification', 'corsOrigin'].some((k) => Object.hasOwn(f, k))
    )
      throw Error('Invalid planned media identity, bytes, checksum or premature remote claim');
    validateLocalAssetPath(f.path);
    if (
      f.name !== basename(f.path) ||
      !f.path.endsWith('.' + (f.kind === 'thumb' ? 'webp' : f.kind)) ||
      f.contentType !== MIME_TYPES[f.kind] ||
      ![SITE_ORIGIN, brand.origin, '*'].includes(f.expectedCorsOrigin)
    )
      throw Error('Planned media filename, extension, MIME or expected CORS differs');
    // New plans may name the new public host. Reuse the strict existing path,
    // extension and hash validator on a temporary descriptor only. Source plan
    // URLs and hashes are never rewritten, and legacy verified receipts retain
    // their original validator and signed bytes.
    const legacyContractURL =
      typeof f.url === 'string' && f.url.startsWith(brand.assetsOrigin + '/')
        ? 'https://assets.ultraclipart.com' + f.url.slice(brand.assetsOrigin.length)
        : f.url;
    validateAssetUrl({ ...f, url: legacyContractURL });
    const keyHash = /\.([a-f0-9]{12,64})\.[a-z]+$/.exec(new URL(f.url).pathname)?.[1];
    if (!keyHash || !f.sha256.startsWith(keyHash))
      throw Error('New incoming media must use its reviewed content hash');
    const id = assetIdentity(f.assetId, f.kind);
    if (files.has(id) || paths.has(f.path) || urls.has(f.url))
      throw Error('Duplicate planned media identity, path or URL');
    if (f.kind === 'pdf' && f.bytes > 1_000_000)
      throw Error('Standard PDF exceeds its byte ceiling');
    const sourceType = sourceTypeOf(f),
      group = groups.get(f.assetId) ?? { sourceType, kinds: [] };
    if (group.sourceType !== sourceType) throw Error('Mixed source types within planned artwork');
    group.kinds.push(f.kind);
    groups.set(f.assetId, group);
    files.set(id, f);
    paths.add(f.path);
    urls.add(f.url);
    bytes += f.bytes;
  }
  if (
    [...groups.values()].some(
      (g) => [...g.kinds].sort().join(',') !== representationKinds(g).sort().join(','),
    )
  )
    throw Error('Planned media contains an incomplete artwork');
  if (!Number.isSafeInteger(bytes) || manifest.bytes !== bytes)
    throw Error('Planned byte total differs');
  return files;
}

// Plans prove local facts and the protected source map before even a reader starts.
export async function verifyIncomingPlanSources(packet) {
  const files = [...incomingMediaFiles(packet.incomingMediaManifest).values()];
  if (!isIncomingMediaPlan(packet.incomingMediaManifest)) return;
  const native = new Map(packet.sourceFiles.map((f) => [resolve(f.path), f]));
  const byURL = packet.sourceMediaByURL ?? {};
  assert.deepEqual(
    Object.keys(byURL).sort(),
    files.map((f) => f.url).sort(),
    'Exact planned native URL map required',
  );
  for (const f of files) {
    if (typeof byURL[f.url] !== 'string') throw Error('Protected incoming media source required');
    const path = resolve(byURL[f.url]),
      source = native.get(path);
    if (!source || source.bytes !== f.bytes || source.sha256 !== f.sha256)
      throw Error('Planned media must match an exact protected native source');
    await verifySourceFile({ path, bytes: f.bytes, sha256: f.sha256 });
    if (f.kind === 'pdf') await assertNoCMYKJPX(readFileSync(path));
  }
  return {
    status: 'PLANNED_INCOMING_MEDIA_LOCAL_SOURCE_VERIFIED_NOT_REMOTE',
    manifestSHA256: incomingManifestSHA256(packet.incomingMediaManifest),
    files: files.length,
  };
}

export function incomingMediaStageScope(packet) {
  const files = [...incomingMediaFiles(packet.incomingMediaManifest).values()];
  return {
    records: files.map((f) => ({
      key: new URL(f.url).pathname.slice(1),
      path: f.path,
      bytes: f.bytes,
      sha256: f.sha256,
      mime: f.contentType,
      ...(f.kind === 'pdf'
        ? { contentDisposition: 'attachment; filename="' + f.assetId + '.pdf"' }
        : {}),
    })),
    sourceByKey: Object.fromEntries(
      files.map((f) => [new URL(f.url).pathname.slice(1), packet.sourceMediaByURL?.[f.url]]),
    ),
  };
}
export function assertIncomingStageReceipt(packet, receipt, verifier) {
  const { records } = incomingMediaStageScope(packet);
  if (!records.length) {
    assert.equal(receipt, null);
    return;
  }
  assert.equal(receipt?.revision, packet.revision, 'Incoming R2 revision differs');
  assertReusableIncomingReceipt(receipt, records, merkle(records).root, {
    ...verifier,
    bucketName: 'ultraclipart-media',
  });
  if (receipt.files.some((f) => !f.etag || f.verification === 'prior-byte-proof-and-current-etag'))
    throw Error('Full incoming R2 bytes and MIME readback required');
}

// The object must be the exact fresh GET result, not a plan hash labeled proof.
// prepare-content always obtains it by verifyIncomingMedia, including independent replay.
export function assertIncomingCDNReceipt(manifest, receipt, receiptSHA256) {
  const files = incomingMediaFiles(manifest);
  if (
    receipt?.status !== 'INCOMING_MEDIA_CDN_GET_BYTES_SHA_MIME_CORS_VERIFIED' ||
    receipt.manifestSHA256 !== incomingManifestSHA256(manifest) ||
    incomingManifestSHA256(receipt) !== receiptSHA256 ||
    !Array.isArray(receipt.files) ||
    receipt.files.length !== files.size
  )
    throw Error('Exact fresh incoming CDN receipt required');
  const projected = receipt.publicOrigin !== undefined;
  if (projected && receipt.publicOrigin !== brand.origin)
    throw Error('Incoming CDN receipt has an unreviewed public origin');
  const seen = new Set();
  for (const row of receipt.files) {
    const id = assetIdentity(row.assetId, row.kind),
      expected = files.get(id);
    if (!expected || seen.has(id)) throw Error('Unknown or duplicate incoming CDN proof');
    for (const key of ['url', 'assetId', 'kind', 'bytes', 'sha256', 'contentType'])
      assert.equal(row[key], expected[key], 'Incoming CDN ' + key + ' differs');
    if (projected)
      assert.equal(
        row.publicUrl,
        publicBrandURL(expected.url),
        'Incoming public media URL differs',
      );
    const corsOrigin =
      projected && expected.expectedCorsOrigin !== '*'
        ? new URL(publicBrandURL(expected.expectedCorsOrigin)).origin
        : expected.expectedCorsOrigin;
    assert.equal(row.corsOrigin, corsOrigin, 'Incoming CDN CORS differs');
    seen.add(id);
  }
}
