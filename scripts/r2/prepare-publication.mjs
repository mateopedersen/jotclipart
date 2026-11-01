#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceTypeOf } from '../asset-representations.mjs';
import { validateBatch, HARD_CAP } from './plan.mjs';
import { objectIdentity, validateInventoryScope } from './inventory.mjs';
import { leaf } from '../delivery/manifest.mjs';
import {
  OWNER_MANAGED_STORAGE_POLICY,
  createReleaseWriteAuthorization,
  validateReleaseWriteAuthorization,
} from '../delivery/release-write-authorization.mjs';
import {
  ASSET_ORIGIN,
  SITE_ORIGIN,
  MIME_TYPES,
  assetIdentity,
  catalogFiles,
  validateAssetUrl,
  validateManifest,
  validatePublication,
  validateLocalAssetPath,
} from '../publication-policy.mjs';
const sha = (body) => createHash('sha256').update(body).digest('hex');
const kindOf = (kind) => (kind === 'thumbnail' ? 'thumb' : kind);

function validateJournal(journal, batch, batchSha256) {
  if (
    !/^[a-f0-9]{64}$/.test(batchSha256 ?? '') ||
    ![2, 3].includes(journal?.schemaVersion) ||
    journal.status !== 'uploaded-and-byte-verified' ||
    journal.batchSha256 !== batchSha256 ||
    !Number.isFinite(Date.parse(journal.completedAt)) ||
    !Array.isArray(journal.verifiedObjects) ||
    !Array.isArray(journal.verifiedArtworkIds)
  )
    throw new Error('A successful matching upload journal is required');
  const batchBytes = batch.reduce((sum, object) => sum + object.bytes, 0);
  if (!Number.isSafeInteger(batchBytes)) throw new Error('Unsafe wave byte sum');
  if (journal.schemaVersion === 2) {
    if (
      !Number.isSafeInteger(journal.aggregateBytes) ||
      journal.aggregateBytes > HARD_CAP ||
      journal.aggregateBytes < batchBytes
    )
      throw new Error('Historical upload journal aggregate is invalid');
    const scope = journal.inventoryScope;
    if (!scope || !Array.isArray(scope.jurisdictions))
      throw new Error('Upload journal is missing its inventory scope');
    validateInventoryScope({
      schemaVersion: 2,
      ...scope,
      buckets: scope.jurisdictions.flatMap((j) =>
        j.buckets.map((name) => ({ name, jurisdiction: j.jurisdiction })),
      ),
    });
  } else {
    if (
      journal.storagePolicy !== OWNER_MANAGED_STORAGE_POLICY ||
      journal.accountUsageMeasured !== false ||
      journal.aggregateBytes !== null ||
      journal.inventoryScope !== null ||
      journal.publishApproved !== false ||
      !Number.isSafeInteger(journal.waveNumber) ||
      journal.waveNumber < 1 ||
      journal.waveBytes !== batchBytes ||
      journal.authorizedBytes < batchBytes ||
      typeof journal.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(journal.startedAt)) ||
      Date.parse(journal.startedAt) > Date.parse(journal.completedAt) ||
      ![
        'private-r2-binding-conditional-create-and-independent-get-sha256',
        'private-r2-binding-existing-independent-get-sha256',
      ].includes(journal.transport)
    )
      throw new Error('Invalid release-scoped upload journal');
    const job = {
      storagePolicy: journal.storagePolicy,
      accountId: journal.accountId,
      bucket: journal.bucket,
      root: journal.root,
      revision: journal.revision,
      authorizedBytes: journal.authorizedBytes,
    };
    // Validate the persisted scope's shape; this does not fabricate a historical
    // authorization or claim that any account-wide storage was measured.
    const scope = createReleaseWriteAuthorization(job, 0);
    validateReleaseWriteAuthorization(scope, job, 0);
  }
  const verified = new Map(
    journal.verifiedObjects.map((object) => [objectIdentity(object), object]),
  );
  const artworkIds = [...new Set(batch.map((object) => object.assetId))].sort();
  if (
    verified.size !== batch.length ||
    verified.size !== journal.verifiedObjects.length ||
    JSON.stringify([...journal.verifiedArtworkIds].sort()) !== JSON.stringify(artworkIds)
  )
    throw new Error('Incomplete or duplicated upload journal');
  for (const object of batch) {
    const entry = verified.get(objectIdentity(object));
    if (!entry || entry.bytes !== object.bytes || entry.sha256 !== object.sha256)
      throw new Error('Upload journal checksum or size differs from the batch');
    if (journal.schemaVersion === 3) {
      const record = entry.releaseRecord,
        proof = entry.releaseProof;
      if (
        entry.bucket !== journal.bucket ||
        entry.jurisdiction !== 'default' ||
        object.bucket !== journal.bucket ||
        (object.jurisdiction ?? 'default') !== 'default' ||
        !record ||
        typeof record.path !== 'string' ||
        !record.path.startsWith('/') ||
        record.path.split('/').includes('..') ||
        typeof object.path !== 'string' ||
        resolve(object.path) !== resolve('public' + record.path) ||
        record.wave !== journal.waveNumber ||
        record.assetId !== object.assetId ||
        record.kind !== object.kind ||
        record.key !== object.key ||
        record.bytes !== object.bytes ||
        record.sha256 !== object.sha256 ||
        !Array.isArray(proof) ||
        proof.length > 64
      )
        throw new Error('Release object scope or reviewed record differs from the batch');
      let digest = leaf(record);
      for (const step of proof) {
        if (!step || typeof step.left !== 'boolean' || !/^[a-f0-9]{64}$/.test(step.hash ?? ''))
          throw new Error('Invalid release object proof');
        digest = sha(Buffer.from(step.left ? step.hash + digest : digest + step.hash, 'hex'));
      }
      if (digest !== journal.root) throw new Error('Release object proof differs from the root');
    }
  }
}

class CdnTransportError extends Error {}

const transientTransport = (error) =>
  ['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name) &&
  !/redirect/i.test(String(error?.cause?.message ?? error?.message ?? ''));
const waitForRetry = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function verifiedCdnAttempt(file, fetcher, now) {
  let response;
  try {
    response = await fetcher(file.url, {
      headers: { Origin: SITE_ORIGIN, 'Cache-Control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    const Failure = transientTransport(error) ? CdnTransportError : Error;
    throw new Failure(`CDN verification could not fetch ${file.assetId}/${file.kind}`, {
      cause: error,
    });
  }
  if ([408, 429].includes(response.status) || response.status >= 500) {
    await response.body?.cancel();
    throw new CdnTransportError(`CDN temporarily returned ${response.status}`);
  }
  if (response.status !== 200 || (response.url && response.url !== file.url))
    throw new Error(`CDN returned a redirect or non-200 response for ${file.assetId}/${file.kind}`);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const corsOrigin = response.headers.get('access-control-allow-origin');
  if (contentType !== MIME_TYPES[file.kind] || ![SITE_ORIGIN, '*'].includes(corsOrigin))
    throw new Error(`CDN MIME or CORS mismatch for ${file.assetId}/${file.kind}`);
  const digest = createHash('sha256');
  let bytes = 0;
  if (!response.body) throw new Error('CDN returned an empty response body');
  const reader = response.body.getReader();
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        const Failure = transientTransport(error) ? CdnTransportError : Error;
        throw new Failure(`CDN response interrupted for ${file.assetId}/${file.kind}`, {
          cause: error,
        });
      }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > file.bytes) {
        await reader.cancel();
        throw new Error(`CDN byte count exceeds catalog for ${file.assetId}/${file.kind}`);
      }
      digest.update(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (bytes !== file.bytes || digest.digest('hex') !== file.sha256)
    throw new Error(`CDN checksum or size mismatch for ${file.assetId}/${file.kind}`);
  return {
    ...file,
    contentType,
    corsOrigin,
    verifiedAt: new Date(now()).toISOString(),
    verification: 'cdn-get-sha256',
  };
}

async function verifiedCdnFile(file, fetcher, now, retryWait) {
  validateAssetUrl(file);
  for (let attempt = 0; ; attempt++) {
    try {
      // Each attempt starts a new stream and hash; partial responses are never accepted.
      return await verifiedCdnAttempt(file, fetcher, now);
    } catch (error) {
      if (!(error instanceof CdnTransportError) || attempt === 2) throw error;
      await retryWait([250, 1000][attempt]);
    }
  }
}

/** Read-only publication preparation. Existing verified URLs are retained; only new bytes are fetched. */
export async function preparePublication({
  prior,
  catalog,
  batch,
  journal,
  batchSha256,
  readAsset,
  fetcher = fetch,
  now = Date.now,
  retryWait = waitForRetry,
}) {
  validateBatch(batch);
  if (new Set(batch.map((object) => object.assetId)).size > 50)
    throw new Error('At most 50 artworks per reviewed production wave');
  validateJournal(journal, batch, batchSha256);
  if (journal.schemaVersion === 3 && journal.waveBytes !== journal.authorizedBytes)
    throw new Error('A single-wave publication must cover its complete release cohort');
  return prepareVerifiedFiles({ prior, catalog, batch, readAsset, fetcher, now, retryWait });
}

/** Validate each <=50-artwork receipt separately; hash retained local sources once. */
export async function preparePublicationWaves({
  prior,
  catalog,
  waves,
  readAsset,
  fetcher = fetch,
  now = Date.now,
  retryWait = waitForRetry,
}) {
  if (!Array.isArray(waves) || !waves.length)
    throw Error('At least one independently verified wave is required');
  const ids = new Set(),
    batch = [];
  let journalVersion = null;
  const cohorts = new Map();
  for (const wave of waves) {
    validateBatch(wave.batch);
    const group = [...new Set(wave.batch.map((o) => o.assetId))];
    if (group.length > 50) throw Error('At most 50 artworks per reviewed production wave');
    validateJournal(wave.journal, wave.batch, wave.batchSha256);
    if (journalVersion !== null && journalVersion !== wave.journal.schemaVersion)
      throw Error('Historical and release-scoped waves cannot be mixed');
    journalVersion = wave.journal.schemaVersion;
    if (wave.journal.schemaVersion === 3) {
      const j = wave.journal;
      const scope = JSON.stringify([
        j.accountId,
        j.bucket,
        j.root,
        j.revision,
        j.storagePolicy,
        j.authorizedBytes,
      ]);
      let cohort = cohorts.get(j.root);
      if (cohort && cohort.scope !== scope)
        throw Error('The same release root has inconsistent scope');
      if (!cohort) {
        cohort = { scope, authorizedBytes: j.authorizedBytes, bytes: 0, numbers: new Set() };
        cohorts.set(j.root, cohort);
      }
      if (cohort.numbers.has(j.waveNumber)) throw Error('Duplicate wave within a release cohort');
      cohort.numbers.add(j.waveNumber);
      cohort.bytes += j.waveBytes;
      if (!Number.isSafeInteger(cohort.bytes)) throw Error('Unsafe release byte sum');
    }
    for (const id of group) {
      if (ids.has(id)) throw Error('Artwork duplicated across verified waves');
      ids.add(id);
    }
    batch.push(...wave.batch);
  }
  for (const cohort of cohorts.values())
    if (cohort.bytes !== cohort.authorizedBytes)
      throw Error('Verified waves do not cover a complete release cohort');
  return prepareVerifiedFiles({ prior, catalog, batch, readAsset, fetcher, now, retryWait });
}

async function prepareVerifiedFiles({ prior, catalog, batch, readAsset, fetcher, now, retryWait }) {
  const previous = prior ? validateManifest(prior) : new Map();
  const expected = catalogFiles(catalog),
    expectedById = new Map(expected.map((file) => [assetIdentity(file.assetId, file.kind), file]));
  const uploaded = new Map();
  for (const object of batch) {
    const id = assetIdentity(object.assetId, kindOf(object.kind)),
      file = expectedById.get(id);
    if (
      !file ||
      sourceTypeOf(object) !== sourceTypeOf(file) ||
      object.bytes !== file.bytes ||
      object.sha256 !== file.sha256 ||
      uploaded.has(id)
    )
      throw new Error('Batch contains an unknown or mismatched catalog representation');
    uploaded.set(id, object);
  }
  // Preflight the full next catalog and all missing representations before any CDN request.
  const candidates = expected.map((file) => {
    const body = readAsset(file.path);
    if (body.length !== file.bytes || sha(body) !== file.sha256)
      throw new Error(`Local source differs from catalog: ${file.path}`);
    const id = assetIdentity(file.assetId, file.kind),
      old = previous.get(id);
    if (
      old &&
      sourceTypeOf(old) === sourceTypeOf(file) &&
      old.path === file.path &&
      old.name === file.name &&
      old.bytes === file.bytes &&
      old.sha256 === file.sha256
    )
      return { retained: old };
    const object = uploaded.get(id);
    if (!object)
      throw new Error(
        `Incomplete next publication: ${id} has no verified prior URL or uploaded representation`,
      );
    return { fresh: { ...file, url: `${ASSET_ORIGIN}/${object.key}` } };
  });
  const files = new Array(candidates.length);
  let cursor = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(8, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const index = cursor++,
          candidate = candidates[index];
        files[index] =
          candidate.retained ?? (await verifiedCdnFile(candidate.fresh, fetcher, now, retryWait));
      }
    }),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const manifest = {
    schema: 2,
    status: 'verified',
    verifiedAt: new Date(now()).toISOString(),
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  validatePublication(manifest, catalog, readAsset);
  return manifest;
}

async function main() {
  const root = resolve(import.meta.dirname, '../..'),
    args = process.argv.slice(2);
  const usage =
    'node scripts/r2/prepare-publication.mjs --batch work/r2-batch.json --journal r2-ingest-journal.json [--catalog work/art.next.json] [--prior data/publication.json | --initial] [--output work/publication.next.json]';
  if (args.includes('--help')) {
    console.log(usage);
    return;
  }
  const options = {
    catalog: resolve(root, 'data/art.json'),
    prior: resolve(root, 'data/publication.json'),
    output: resolve(root, 'work/publication.next.json'),
  };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--initial') options.prior = null;
    else if (
      ['--batch', '--journal', '--catalog', '--prior', '--output'].includes(flag) &&
      args[0] &&
      !args[0].startsWith('--')
    )
      options[flag.slice(2)] = resolve(args.shift());
    else throw new Error(usage);
  }
  if (!options.batch || !options.journal) throw new Error(usage);
  if (
    [options.batch, options.journal, options.prior, options.catalog]
      .filter(Boolean)
      .includes(options.output)
  )
    throw new Error('Write a separate reviewable next manifest; do not overwrite an input');
  const rawBatch = readFileSync(options.batch),
    readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const publicRoot = realpathSync(join(root, 'public'));
  const manifest = await preparePublication({
    prior: options.prior ? readJson(options.prior) : null,
    catalog: readJson(options.catalog),
    batch: JSON.parse(rawBatch),
    journal: readJson(options.journal),
    batchSha256: sha(rawBatch),
    readAsset: (path) => {
      const file = realpathSync(join(publicRoot, validateLocalAssetPath(path)));
      if (!file.startsWith(`${publicRoot}/`)) throw new Error('Source symlink escapes public/');
      return readFileSync(file);
    },
  });
  mkdirSync(dirname(options.output), { recursive: true });
  const temp = `${options.output}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, options.output);
  console.log(
    JSON.stringify(
      {
        output: options.output,
        files: manifest.files.length,
        bytes: manifest.bytes,
        artworks: new Set(manifest.files.map((file) => file.assetId)).size,
        remoteWrites: 0,
        editorialApproval: 'unchanged; requires separate review',
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
