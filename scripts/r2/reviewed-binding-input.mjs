import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateBatch } from './plan.mjs';
import { mergeEditorialBatch } from '../apply-editorial-review.mjs';
import { reviewedImportCatalog } from '../reviewed-imports.mjs';
const read = (p) => JSON.parse(fs.readFileSync(p)),
  sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
/** Keep format and active-content protections identical to the original ingest path. */
export function validateBindingBytes(object, bytes) {
  assert(Buffer.isBuffer(bytes));
  assert.equal(bytes.length, object.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), object.sha256);
  assert(bytes.length > 0 && bytes.length <= 8_000_000);
  if (object.kind === 'pdf') {
    assert(
      bytes.length <= 1_000_000 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-')),
      'Invalid PDF signature or size',
    );
  } else if (['webp', 'thumbnail'].includes(object.kind)) {
    assert(
      bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
      'Invalid WebP signature',
    );
  } else if (object.kind === 'svg') {
    const text = bytes.toString('utf8');
    assert(
      /<svg[\s>]/.test(text) &&
        !/<\s*(script|foreignObject|iframe)\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["'](?:https?:|data:|javascript:)|<!DOCTYPE|<!ENTITY/i.test(
          text,
        ),
      'Unsafe SVG',
    );
  } else throw Error('Unsupported source representation');
}
/** A private binding transport changes throughput, never source or editorial approval. */
export function reviewedBindingInput(file, root = process.cwd()) {
  file = path.resolve(root, file);
  assert(file.startsWith(path.resolve(root) + '/'));
  const descriptor = read(file),
    resolve = (p) => {
      const f = path.resolve(root, p);
      assert(f.startsWith(path.resolve(root) + '/'));
      return f;
    };
  assert.equal(descriptor.schema, 1);
  assert.equal(descriptor.status, 'REVIEWED_READY_NOT_LIVE');
  assert.equal(descriptor.baselineCatalogSha256, sha(resolve('data/art.json')));
  const base = read(resolve('data/art.json')),
    catalog = read(resolve(descriptor.catalog)),
    ids = new Set(base.map((a) => a.id)),
    added = catalog.filter((a) => !ids.has(a.id));
  assert.equal(added.length, descriptor.addedArtworks);
  assert.deepEqual(
    catalog.filter((a) => ids.has(a.id)),
    base,
    'Accepted catalog must be preserved',
  );
  const reg = mergeEditorialBatch(
    catalog,
    read(resolve('data/editorial/reviews.json')),
    read(resolve(descriptor.editorial)),
  );
  reviewedImportCatalog(catalog, reg);
  const byId = new Map(added.map((a) => [a.id, a])),
    seen = new Set(),
    waves = [];
  for (const [index, name] of descriptor.batches.entries()) {
    const batchPath = resolve(name),
      batch = validateBatch(read(batchPath)),
      assetIds = [...new Set(batch.map((o) => o.assetId))];
    assert(assetIds.length <= 50 && assetIds.length > 0);
    for (const id of assetIds) {
      assert(byId.has(id), 'Unknown incoming asset');
      assert(!seen.has(id), 'Artwork split or duplicated across waves');
      seen.add(id);
    }
    for (const o of batch) {
      assert.equal(o.bucket, 'ultraclipart-media');
      assert.equal(o.jurisdiction ?? 'default', 'default');
      const a = byId.get(o.assetId),
        kind = o.kind === 'thumbnail' ? 'thumb' : o.kind,
        p = fs.realpathSync(resolve(o.path));
      assert(p.startsWith(fs.realpathSync(resolve('public')) + '/'));
      assert.equal('/' + path.relative(resolve('public'), p).replaceAll('\\', '/'), a[kind]);
      assert.equal(fs.statSync(p).size, o.bytes);
      validateBindingBytes(o, fs.readFileSync(p));
      assert.equal(a.files[kind].sha256, o.sha256);
      assert.equal(a.files[kind].bytes, o.bytes);
      assert(o.bytes <= 8_000_000);
      if (o.kind === 'pdf') assert(o.bytes <= 1_000_000);
    }
    waves.push({ number: index + 1, batchPath, batch, batchSha256: sha(batchPath) });
  }
  assert.equal(seen.size, added.length, 'Every incoming artwork needs its complete bounded batch');
  const records = waves.flatMap((w) =>
    w.batch.map((o) => ({
      path: '/' + path.relative(resolve('public'), resolve(o.path)).replaceAll('\\', '/'),
      key: o.key,
      bytes: o.bytes,
      sha256: o.sha256,
      mime:
        o.kind === 'pdf' ? 'application/pdf' : o.kind === 'svg' ? 'image/svg+xml' : 'image/webp',
      ...(o.kind === 'pdf'
        ? { contentDisposition: `attachment; filename="${o.assetId}.pdf"` }
        : {}),
      assetId: o.assetId,
      kind: o.kind,
      wave: w.number,
    })),
  );
  assert.equal(new Set(records.map((r) => r.path)).size, records.length);
  assert.equal(new Set(records.map((r) => r.key)).size, records.length);
  return { descriptor, waves, records, catalog, added };
}
