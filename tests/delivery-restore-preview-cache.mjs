import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync,
  symlinkSync, unlinkSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { registerHooks } from 'node:module';
import { previewIdentity } from '../scripts/preview-assets.mjs';
import { merkle } from '../scripts/delivery/manifest.mjs';
import { restorePreviewCacheAtRoot } from '../scripts/delivery/restore-preview-cache.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = 'a'.repeat(40), widths = [96, 220, 440, 960];
const save = (file, bytes) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); };
const json = (file, value) => save(file, JSON.stringify(value));

async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'uc-cache-recovery-'))), root = join(base, 'site');
  mkdirSync(join(root, 'public/catalog'), { recursive: true });
  mkdirSync(join(root, 'work/delivery', revision, 'full-source/previews/p1'), { recursive: true });
  const image = await sharp({ create: { width: 36, height: 24, channels: 4,
    background: { r: 60, g: 130, b: 190, alpha: 0.8 } } }).webp().toBuffer();
  const thumb = join(root, 'public/catalog/thumb.webp'), webp = join(root, 'public/catalog/original.webp');
  save(thumb, image); save(webp, image);
  const item = { id: 'fixture-art', published: true, indexable: true,
    thumb: '/catalog/thumb.webp', webp: '/catalog/original.webp',
    files: { thumb: { bytes: image.length, sha256: hash(image) },
      webp: { bytes: image.length, sha256: hash(image) } } };
  const key = previewIdentity(item), frozen = join(root, 'work/delivery', revision, 'full-source');
  const records = [];
  for (const width of widths) {
    const preview = await sharp(image).resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
    const path = `/previews/p1/${key}-${width}.webp`;
    save(join(frozen, path), preview);
    records.push({ path, key: `delivery${path}`, bytes: preview.length, sha256: hash(preview), mime: 'image/webp' });
  }
  const rootHash = merkle(records).root;
  const manifest = { schema: 1, status: 'remote-byte-verified', bucket: 'ultraclipart-pages',
    revision, verified: records.length, files: records, root: rootHash };
  json(join(root, 'data/art.json'), [item]);
  json(join(root, 'work/delivery', revision, 'verified-manifest.json'), manifest);
  json(join(frozen, 'incremental-baseline.json'), { revision, root: rootHash });
  json(join(base, 'ultraclipart/work/remaining-cloudflare-production-report.json'), {
    status: 'PRODUCTION_VERIFIED', liveDelivery: { renderedRevision: revision, verifiedRoot: rootHash, r2Files: records.length },
  });
  return { base, root, key, item, thumb, webp, frozen, records, image,
    close: () => rmSync(base, { recursive: true, force: true }) };
}

test('cold index is rebuilt from verified originals and actual WebP pixels, warm run reuses authenticated proofs', async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Unexpected network access'); };
  try {
    const first = await restorePreviewCacheAtRoot(f.root, { expectedRevision: revision });
    assert.equal(first.restored, 4); assert.equal(first.entries, 1); assert.equal(first.metadataReads, 4);
    const saved = JSON.parse(readFileSync(join(f.root, '.astro/preview-assets.json')))[f.key];
    assert.equal(saved.files['96'].width, 36); assert.equal(saved.files['96'].height, 24);
    for (const record of f.records) assert.equal(hash(readFileSync(join(f.root, 'public', record.path))), record.sha256);
    assert.deepEqual(readFileSync(f.thumb), f.image); assert.deepEqual(readFileSync(f.webp), f.image);
    const second = await restorePreviewCacheAtRoot(f.root, { expectedRevision: revision });
    assert.equal(second.restored, 0); assert.equal(second.sourceVerification.hashed, 0);
    assert.equal(second.metadataReads, 0); assert.equal(second.metadataReused, 4);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('a tampered signed geometry ledger is ignored and actual WebP metadata is reread', async () => {
  const f = await fixture(); try {
    await restorePreviewCacheAtRoot(f.root);
    const ledger = join(f.root, '.asset-integrity/preview-metadata.json');
    const saved = JSON.parse(readFileSync(ledger)); saved.payload = saved.payload.replace('"width":36', '"width":12');
    json(ledger, saved);
    const report = await restorePreviewCacheAtRoot(f.root);
    assert.equal(report.metadataReads, 4); assert.equal(report.metadataReused, 0);
    const index = JSON.parse(readFileSync(join(f.root, '.astro/preview-assets.json')));
    assert.equal(index[f.key].files['96'].width, 36);
  } finally { f.close(); }
});

test('fabricated local hint is replaced by manifest hashes and actual geometry; unknown entry is not trusted', async () => {
  const f = await fixture(); try {
    json(join(f.root, '.astro/preview-assets.json'), {
      [f.key]: { source: 'invented', files: { '96': { bytes: 7, sha256: 'b'.repeat(64), width: 1, height: 1 } } },
      unrelated: { source: 'preserve-me', files: {} },
    });
    await restorePreviewCacheAtRoot(f.root);
    const entries = JSON.parse(readFileSync(join(f.root, '.astro/preview-assets.json')));
    assert.equal(entries[f.key].files['96'].sha256, f.records[0].sha256);
    assert.equal(entries[f.key].files['96'].width, 36);
    assert.equal(entries.unrelated, undefined);
  } finally { f.close(); }
});

test('current non-baseline previews are retained only when reproduced from verified originals', async () => {
  const f = await fixture(); try {
    const newer = await sharp({ create: { width: 30, height: 20, channels: 4,
      background: { r: 210, g: 45, b: 90, alpha: 1 } } }).webp().toBuffer();
    save(join(f.root, 'public/catalog/new.webp'), newer);
    const item = { id: 'new-art', published: true, indexable: true,
      thumb: '/catalog/new.webp', webp: '/catalog/new.webp',
      files: { thumb: { bytes: newer.length, sha256: hash(newer) },
        webp: { bytes: newer.length, sha256: hash(newer) } } };
    const key = previewIdentity(item); json(join(f.root, 'data/art.json'), [f.item, item]);
    for (const width of widths) {
      const bytes = await sharp(newer).rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, alphaQuality: 100, effort: 4 }).toBuffer();
      save(join(f.root, `public/previews/p1/${key}-${width}.webp`), bytes);
    }
    json(join(f.root, '.astro/preview-assets.json'), { [key]: { source: 'not trusted', files: {} } });
    const report = await restorePreviewCacheAtRoot(f.root);
    const next = JSON.parse(readFileSync(join(f.root, '.astro/preview-assets.json')));
    assert.equal(report.independentlyReproduced, 4); assert.equal(next[key].files['96'].width, 30);
    assert.notEqual(next[key].source, 'not trusted');
    const indexPath = join(f.root, '.astro/preview-assets.json'), before = readFileSync(indexPath);
    const target = join(f.root, `public/previews/p1/${key}-96.webp`), bad = Buffer.from(readFileSync(target));
    bad[bad.length - 1] ^= 1; save(target, bad);
    await assert.rejects(restorePreviewCacheAtRoot(f.root), /Source changed/);
    assert.deepEqual(readFileSync(target), bad); assert.deepEqual(readFileSync(indexPath), before);
  } finally { f.close(); }
});

test('missing sealed source never creates a complete cache entry or modifies existing previews', async () => {
  const f = await fixture(); try {
    unlinkSync(join(f.frozen, f.records[0].path));
    const first = await restorePreviewCacheAtRoot(f.root);
    assert.equal(first.entries, 0);
    assert.equal(JSON.parse(readFileSync(join(f.root, '.astro/preview-assets.json')))[f.key], undefined);
    assert.deepEqual(readFileSync(f.thumb), f.image);
  } finally { f.close(); }
});

test('changed original with restored mtime and corrupted target cannot acquire a trusted entry', async () => {
  const f = await fixture(); try {
    await restorePreviewCacheAtRoot(f.root);
    const before = statSync(f.webp), altered = Buffer.from(f.image); altered[altered.length - 1] ^= 1;
    save(f.webp, altered); utimesSync(f.webp, before.atime, before.mtime);
    await assert.rejects(restorePreviewCacheAtRoot(f.root), /Source changed/);
    save(f.webp, f.image);
    const dest = join(f.root, 'public', f.records[0].path), bad = Buffer.from(readFileSync(dest)); bad[bad.length - 1] ^= 1;
    save(dest, bad);
    const indexBefore = readFileSync(join(f.root, '.astro/preview-assets.json'));
    await assert.rejects(restorePreviewCacheAtRoot(f.root), /Source changed/);
    assert.deepEqual(readFileSync(dest), bad);
    assert.deepEqual(readFileSync(join(f.root, '.astro/preview-assets.json')), indexBefore);
  } finally { f.close(); }
});

test('only an unsupported COW operation with no created target skips the optimization and makes no cache claim', async () => {
  const f = await fixture();
  // Test-only module hook substitutes the platform copy failure, not the
  // verifier or the helper's filesystem, metadata or attestation checks.
  const stub = `export function createIndependentCopier() { return {
    copy(source, target) { const spec = globalThis.__ucPreviewCopyFailure;
      if (spec.create) requireCreate(target, 'partial');
      const cause = Object.assign(new Error('clone failed'), spec.cause);
      throw new Error('Physical fallback exceeds its cumulative byte budget', {cause});
    }, stats() { return {}; } }; }
    import { writeFileSync as requireCreate } from 'node:fs';`;
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('restore-preview-cache.mjs?unsupported-test') &&
        specifier === './independent-copy.mjs')
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  try {
    const helper = await import('../scripts/delivery/restore-preview-cache.mjs?unsupported-test');
    const indexPath = join(f.root, '.astro/preview-assets.json');
    json(indexPath, { unchanged: { source: 'existing' } });
    const before = readFileSync(indexPath), dest = join(f.root, 'public', f.records[0].path);
    globalThis.__ucPreviewCopyFailure = { cause: { code: 'ENOTSUP', syscall: 'fclonefileat', created: false } };
    const skipped = await helper.restorePreviewCacheAtRoot(f.root);
    assert.deepEqual(skipped, { status: 'SKIPPED_OPTIMIZATION', reason: 'COW_UNSUPPORTED_NO_TARGET_CREATED' });
    assert.throws(() => statSync(dest), { code: 'ENOENT' });
    assert.deepEqual(readFileSync(indexPath), before); assert.deepEqual(readFileSync(f.webp), f.image);
    globalThis.__ucPreviewCopyFailure = { cause: { code: 'EXDEV', cloneOperation: 'linux-ficlone', created: false } };
    assert.deepEqual(await helper.restorePreviewCacheAtRoot(f.root), skipped);
    assert.deepEqual(readFileSync(indexPath), before);
    globalThis.__ucPreviewCopyFailure = { cause: { code: 'EIO', syscall: 'fclonefileat', created: false } };
    await assert.rejects(helper.restorePreviewCacheAtRoot(f.root), /fallback exceeds/);
    assert.deepEqual(readFileSync(indexPath), before);
    globalThis.__ucPreviewCopyFailure = { cause: { code: 'ENOTSUP', syscall: 'fclonefileat', created: true } };
    await assert.rejects(helper.restorePreviewCacheAtRoot(f.root), /fallback exceeds/);
    assert.deepEqual(readFileSync(indexPath), before);
    globalThis.__ucPreviewCopyFailure = { create: true,
      cause: { code: 'ENOTSUP', syscall: 'fclonefileat', created: false } };
    await assert.rejects(helper.restorePreviewCacheAtRoot(f.root), /fallback exceeds/);
    assert.deepEqual(readFileSync(indexPath), before);
  } finally { delete globalThis.__ucPreviewCopyFailure; hook.deregister(); f.close(); }
});

test('source symlink escape and mismatched Merkle production proof fail closed', async () => {
  const f = await fixture(); try {
    const source = join(f.frozen, f.records[0].path); unlinkSync(source); symlinkSync(f.webp, source);
    await assert.rejects(restorePreviewCacheAtRoot(f.root), /Unsafe file/);
    unlinkSync(source); save(source, f.image);
    const manifestPath = join(f.root, 'work/delivery', revision, 'verified-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath)); manifest.files[0].sha256 = 'f'.repeat(64); json(manifestPath, manifest);
    await assert.rejects(restorePreviewCacheAtRoot(f.root), /strictly equal/);
  } finally { f.close(); }
});
