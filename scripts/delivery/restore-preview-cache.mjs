// Restore only presentation previews already proven by the verified live release.
// This is a local build optimization; it neither publishes nor changes originals.
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync,
  statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateLocalAssetPath } from '../publication-policy.mjs';
import { authenticateLocalState, verifiedSourceCache, verifyLocalState } from '../verified-source-cache.mjs';
import { PREVIEW_WIDTHS, previewIdentity } from '../preview-assets.mjs';
import { merkle } from './manifest.mjs';
import { createIndependentCopier } from './independent-copy.mjs';

const MIN_FREE = 5n * 1024n * 1024n * 1024n;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const validHash = (value) => /^[a-f0-9]{64}$/.test(value ?? '');
const identity = (path) => {
  const s = statSync(path, { bigint: true });
  assert(s.isFile(), 'Expected regular file');
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
};
function safeDirectory(path) {
  const s = lstatSync(path);
  assert(s.isDirectory() && !s.isSymbolicLink() && realpathSync(path) === path,
    `Unsafe directory: ${path}`);
}
function safeFile(path) {
  const s = lstatSync(path);
  assert(s.isFile() && !s.isSymbolicLink() && realpathSync(path) === path,
    `Unsafe file: ${path}`);
}
function optionalFile(path) {
  try { safeFile(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function freeSpaceGuard(root, extra = 0n) {
  const s = statfsSync(root, { bigint: true });
  if (s.bavail * s.bsize < MIN_FREE + extra) throw Error('Preview restoration requires 5 GiB free after its writes');
}
function atomicJson(path, value, root) {
  const content = JSON.stringify(value);
  freeSpaceGuard(root, BigInt(Buffer.byteLength(content)));
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
function readLedger(root, file) {
  try {
    if (!optionalFile(file)) return {};
    const saved = readJson(file);
    if (saved.schema !== 1 || typeof saved.payload !== 'string' ||
        !verifyLocalState(root, saved.payload, saved.signature)) return {};
    const entries = JSON.parse(saved.payload);
    return entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
  } catch { return {}; }
}
function writeLedger(root, file, entries) {
  const payload = JSON.stringify(entries);
  atomicJson(file, { schema: 1, payload, signature: authenticateLocalState(root, payload) }, root);
}
function readBaseline(root, expectedRevision) {
  const reportPath = resolve(root, '../ultraclipart/work/remaining-cloudflare-production-report.json');
  if (!optionalFile(reportPath)) return null;
  const report = readJson(reportPath), revision = report.liveDelivery?.renderedRevision;
  assert.equal(report.status, 'PRODUCTION_VERIFIED');
  assert(/^[a-f0-9]{40}$/.test(revision ?? ''), 'Invalid verified production revision');
  if (expectedRevision) assert.equal(revision, expectedRevision, 'Production baseline changed');
  const directory = join(root, 'work/delivery', revision);
  const manifestPath = join(directory, 'verified-manifest.json');
  const frozen = join(directory, 'full-source');
  if (!existsSync(manifestPath) || !existsSync(frozen) || !existsSync(join(frozen, 'previews/p1'))) return null;
  for (const path of [join(root, 'work'), join(root, 'work/delivery'), directory, frozen,
    join(frozen, 'previews'), join(frozen, 'previews/p1')]) safeDirectory(path);
  safeFile(manifestPath);
  const markerPath = join(frozen, 'incremental-baseline.json'); safeFile(markerPath);
  const manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes), marker = readJson(markerPath);
  assert.equal(manifest.schema, 1); assert.equal(manifest.status, 'remote-byte-verified');
  assert.equal(manifest.bucket, 'ultraclipart-pages'); assert.equal(manifest.revision, revision);
  assert(Array.isArray(manifest.files) && manifest.files.length > 0);
  assert.equal(manifest.verified, manifest.files.length);
  assert.equal(report.liveDelivery.r2Files, manifest.files.length);
  assert.equal(merkle(manifest.files).root, manifest.root);
  assert.equal(report.liveDelivery.verifiedRoot, manifest.root);
  assert.equal(marker.revision, revision); assert.equal(marker.root, manifest.root);
  const previews = new Map();
  for (const file of manifest.files) {
    if (!file.path?.startsWith('/previews/p1/')) continue;
    assert(!previews.has(file.path), 'Duplicate baseline preview');
    if (!/^\/previews\/p1\/[a-f0-9]{24}-(96|220|320|440|640|960)\.webp$/.test(file.path) ||
        file.key !== `delivery${file.path}` || file.mime !== 'image/webp' ||
        !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 4_000_000 ||
        !validHash(file.sha256)) throw Error('Invalid baseline preview record');
    previews.set(file.path, file);
  }
  return { revision, root: manifest.root, manifestSha: sha(manifestBytes), reportPath, manifestPath,
    sourceRoot: join(frozen, 'previews/p1'), previews };
}

/** Uses fixed roots and verified evidence. No caller-supplied body/verification callback. */
export async function restorePreviewCacheAtRoot(projectRoot, { expectedRevision } = {}) {
  const root = realpathSync(resolve(projectRoot));
  assert.equal(root, resolve(projectRoot), 'Project root must be canonical');
  const base = readBaseline(root, expectedRevision);
  if (!base) return { status: 'NO_VERIFIED_FROZEN_BASELINE', restored: 0 };
  const publicRoot = join(root, 'public'), previewParent = join(publicRoot, 'previews'), targetRoot = join(previewParent, 'p1');
  safeDirectory(publicRoot);
  for (const path of [previewParent, targetRoot]) {
    if (!existsSync(path)) mkdirSync(path);
    safeDirectory(path);
  }
  const catalogPath = join(root, 'data/art.json'); safeFile(catalogPath);
  const catalogBytes = readFileSync(catalogPath), catalog = JSON.parse(catalogBytes);
  assert(Array.isArray(catalog));
  const unique = [...new Map(catalog.filter((a) => a.published && a.indexable)
    .map((a) => [previewIdentity(a), a])).entries()];
  const astroDir = join(root, '.astro');
  if (!existsSync(astroDir)) mkdirSync(astroDir, { mode: 0o700 });
  safeDirectory(astroDir);
  const indexPath = join(astroDir, 'preview-assets.json');
  let previous = {}, indexBefore = null;
  if (optionalFile(indexPath)) {
    indexBefore = identity(indexPath);
    try { previous = readJson(indexPath); } catch { previous = {}; }
    assert.equal(identity(indexPath), indexBefore, 'Preview cache changed during read');
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) previous = {};
  }
  // A local cache is only a hint. Retain unrelated current entries only after
  // independently reproducing their derivatives from their verified originals.
  const next = Object.create(null);
  const cache = verifiedSourceCache(root), ledgerDir = join(root, '.asset-integrity'); safeDirectory(ledgerDir);
  const ledgerPath = join(ledgerDir, 'preview-metadata.json');
  optionalFile(ledgerPath);
  const ledger = Object.assign(Object.create(null), readLedger(root, ledgerPath));
  const copier = createIndependentCopier({ sourceRoot: base.sourceRoot, destinationRoot: targetRoot,
    minFreeBytes: MIN_FREE, maxFallbackBytes: 0 });
  const observations = [], stats = { restored: 0, reused: 0, entries: 0, missingBaseline: 0,
    metadataReads: 0, metadataReused: 0, skippedUnknown: 0, independentlyReproduced: 0 };
  let sinceSave = 0;
  const verify = (path, expected) => { safeFile(path); return cache.verify(path, expected); };
  const saveSourceCache = () => {
    const index = join(ledgerDir, 'sources.json');
    const existing = optionalFile(index) ? BigInt(statSync(index).size) : 0n;
    // The shared cache creates an atomic JSON replacement. Bound temporary disk
    // use conservatively before handing control to that existing serializer.
    const growth = BigInt(cache.stats.hashed + cache.stats.reused) * 2048n + 1_048_576n;
    freeSpaceGuard(root, existing + growth); cache.save();
  };
  async function preserveUnmatchedExisting(key, item) {
    if (!previous[key] || typeof previous[key] !== 'object') return;
    const sources = {}, signatures = [];
    for (const kind of ['thumb', 'webp']) {
      const path = join(publicRoot, validateLocalAssetPath(item[kind])), expected = item.files[kind];
      const proof = verify(path, expected), bytes = readFileSync(path), s = statSync(path);
      assert.equal(bytes.length, expected.bytes); assert.equal(sha(bytes), expected.sha256);
      assert.equal(identity(path), proof, 'Original changed during cache reproduction');
      sources[kind] = bytes; signatures.push(`${s.size}:${s.mtimeMs}`); observations.push([path, proof]);
    }
    const files = {};
    for (const width of [...PREVIEW_WIDTHS, 320, 640]) {
      const target = join(targetRoot, `${key}-${width}.webp`);
      if (!optionalFile(target)) {
        if (PREVIEW_WIDTHS.includes(width)) return;
        continue;
      }
      const { data, info } = await sharp(width <= 440 ? sources.thumb : sources.webp)
        .rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, alphaQuality: 100, effort: 4 }).toBuffer({ resolveWithObject: true });
      const expected = { bytes: data.length, sha256: sha(data) };
      let proof;
      try { proof = verify(target, expected); } catch (error) {
        if (String(error.message).includes('Source changed after verification:')) return;
        throw error;
      }
      const s = statSync(target); assert.equal(identity(target), proof, 'Preview changed during cache reproduction');
      files[width] = { ...expected, mtime: s.mtimeMs, width: info.width, height: info.height };
      observations.push([target, proof]); stats.independentlyReproduced++;
    }
    if (PREVIEW_WIDTHS.every((width) => files[width])) {
      next[key] = { source: signatures.join('|'), files };
    }
  }
  for (const [key, item] of unique) {
    const records = PREVIEW_WIDTHS.map((width) => base.previews.get(`/previews/p1/${key}-${width}.webp`));
    if (records.some((r) => !r)) { stats.missingBaseline++; await preserveUnmatchedExisting(key, item); continue; }
    const originals = ['thumb', 'webp'].map((kind) => {
      const path = join(publicRoot, validateLocalAssetPath(item[kind])), expected = item.files[kind];
      assert(Number.isSafeInteger(expected.bytes) && expected.bytes > 0 && validHash(expected.sha256));
      const proof = verify(path, expected), s = statSync(path);
      assert.equal(identity(path), proof, 'Original changed while creating source signature');
      observations.push([path, proof]); return `${s.size}:${s.mtimeMs}`;
    });
    const files = {};
    let incomplete = false;
    for (const width of [...PREVIEW_WIDTHS, 320, 640]) {
      const record = base.previews.get(`/previews/p1/${key}-${width}.webp`);
      if (!record) continue;
      const name = record.path.split('/').at(-1), source = join(base.sourceRoot, name), target = join(targetRoot, name);
      if (!optionalFile(source)) { if (PREVIEW_WIDTHS.includes(width)) incomplete = true; continue; }
      const before = verify(source, record);
      if (!optionalFile(target)) {
        freeSpaceGuard(root);
        try { copier.copy(source, target, { expectedSourceIdentity: before, ownerWritable: true }); stats.restored++; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      let targetProof;
      try { targetProof = verify(target, record); }
      catch (error) {
        if (String(error.message).includes('Source changed after verification:')) {
          stats.skippedUnknown++; if (PREVIEW_WIDTHS.includes(width)) incomplete = true; continue;
        }
        throw error;
      }
      assert.equal(identity(source), before, 'Frozen preview changed');
      let metadata = ledger[target];
      if (metadata?.identity === targetProof && metadata.sha256 === record.sha256 &&
          metadata.bytes === record.bytes && Number.isInteger(metadata.width) && Number.isInteger(metadata.height)) {
        stats.metadataReused++;
      } else {
        const actual = await sharp(target, { limitInputPixels: 64_000_000 }).metadata();
        assert.equal(actual.format, 'webp');
        metadata = { identity: targetProof, sha256: record.sha256, bytes: record.bytes,
          width: actual.width, height: actual.height };
        stats.metadataReads++;
      }
      assert(Number.isInteger(metadata.width) && Number.isInteger(metadata.height) &&
        metadata.width > 0 && metadata.height > 0 && Math.max(metadata.width, metadata.height) <= width,
        'Invalid verified preview geometry');
      assert.equal(identity(target), targetProof, 'Preview changed while reading geometry');
      ledger[target] = metadata;
      const s = statSync(target); assert.equal(identity(target), targetProof, 'Preview changed while recording mtime');
      files[width] = { bytes: record.bytes, sha256: record.sha256, mtime: s.mtimeMs,
        width: metadata.width, height: metadata.height };
      observations.push([target, targetProof]); stats.reused++;
      if (++sinceSave >= 10000) { saveSourceCache(); writeLedger(root, ledgerPath, ledger); sinceSave = 0; }
    }
    if (!incomplete && PREVIEW_WIDTHS.every((width) => files[width])) {
      next[key] = { source: originals.join('|'), files }; stats.entries++;
    }
  }
  saveSourceCache(); writeLedger(root, ledgerPath, ledger);
  assert.equal(sha(readFileSync(catalogPath)), sha(catalogBytes), 'Catalog changed during preview restore');
  const current = readBaseline(root, expectedRevision);
  assert(current && current.revision === base.revision && current.root === base.root &&
    current.manifestSha === base.manifestSha, 'Verified baseline changed during preview restore');
  for (const [path, before] of observations) assert.equal(identity(path), before, 'Source changed before cache commit');
  if (indexBefore === null) assert(!existsSync(indexPath), 'Preview cache appeared during restore');
  else assert.equal(identity(indexPath), indexBefore, 'Preview cache changed during restore');
  atomicJson(indexPath, next, root);
  return { status: 'VERIFIED_LOCAL_PREVIEWS_READY_NOT_PUBLISHED', baselineRevision: base.revision,
    ...stats, sourceVerification: { ...cache.stats }, copier: copier.stats() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    assert.equal(process.argv.length, 2, 'Unexpected preview restoration arguments');
    console.log(JSON.stringify(await restorePreviewCacheAtRoot(root,
      { expectedRevision: process.env.UC_DELIVERY_EXPECTED_LIVE_REVISION })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
