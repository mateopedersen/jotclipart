import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { metadataSignature, validateEditorialReview } from './artwork-editorial.mjs';
import { mergeEditorialBatch } from './apply-editorial-review.mjs';
import { reviewedImportCatalog } from './reviewed-imports.mjs';
import { collectionSourceSignature, validateCollectionCopy } from './collection-editorial.mjs';
import { validateBatch } from './r2/plan.mjs';

const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, 'work/imports/wizard-football-2026-10-27');
export const collection = 'owner-wizard-football-500-2026-10-27';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const read = (p) => JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8'));
const save = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(p + '.tmp', p);
};
const baselineBytes = fs.readFileSync(path.join(root, 'data/art.json')),
  baseline = JSON.parse(baselineBytes);
const reviewed = read(path.join(stage, 'visual-copy-review.json'));
assert.equal(reviewed.status, 'VISUAL_AND_COPY_REVIEWED_NOT_UPLOADED');
assert.equal(reviewed.count, 500);
assert.equal(reviewed.sourceImagesViewed, 500);
assert.equal(reviewed.pdfRendersViewed, 500);
assert.equal(
  reviewed.baselineCatalogSha256,
  sha(baselineBytes),
  'Reconcile accepted catalog additions first',
);
assert(!baseline.some((a) => a.sourceCollection === collection), 'Do not import a batch twice');
const similarity = read(path.join(stage, 'similarity-review.json'));
assert.equal(similarity.status, 'PASS');
assert.equal(similarity.decisions.length, similarity.candidates.length);
assert.equal(
  reviewed.similarityReviewSha256,
  sha(fs.readFileSync(path.join(stage, 'similarity-review.json'))),
);
for (const sheet of reviewed.sheets) {
  assert(sheet.reviewedFromPixels);
  assert.equal(sha(fs.readFileSync(path.join(stage, sheet.file))), sheet.sha256);
}
for (const d of similarity.decisions) {
  assert.equal(d.status, 'DISTINCT_COMPOSITION');
  assert(d.reviewedFromActualPairSheet && d.observedDifference);
  assert.deepEqual(d.sourceSha256s, similarity.candidates[d.index].sourceSha256s);
}
const format = read(path.join(stage, 'source-audit.json')),
  pdf = read(path.join(stage, 'pdf-pair-audit.json'));
assert.equal(format.count, 500);
assert.deepEqual(format.errors, []);
assert.deepEqual(pdf.issues, []);
const contexts = read('scripts/wizard-football-contexts.json'),
  baseTopics = read('data/topics.json').topics;
const existingExtra = read('data/extra-topics.json');
const knownIds = new Set(baseline.map((a) => a.id)),
  knownTopics = new Set([...baseTopics, ...existingExtra].map((a) => a.slug));
const items = [],
  editorial = [],
  objects = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (cursor < reviewed.items.length) {
      const row = reviewed.items[cursor++],
        target = path.join(root, 'public/catalog', row.topic);
      assert(!knownIds.has(row.id), 'Existing artwork ID: ' + row.id);
      assert(contexts[row.topic]);
      fs.mkdirSync(target, { recursive: true });
      for (const kind of ['webp', 'pdf']) {
        const source = path.join(root, row[kind]),
          dest = path.join(target, row.id + '.' + kind),
          bytes = fs.readFileSync(source);
        assert.equal(sha(bytes), row[kind + 'Sha256']);
        assert.equal(bytes.length, row[kind + 'Bytes']);
        if (fs.existsSync(dest)) assert.equal(sha(fs.readFileSync(dest)), sha(bytes));
        else fs.copyFileSync(source, dest, fs.constants.COPYFILE_FICLONE);
      }
      const thumb = path.join(target, row.id + '-thumb.webp');
      if (!fs.existsSync(thumb)) {
        await sharp(path.join(target, row.id + '.webp'))
          .resize(440, 440, { fit: 'inside', withoutEnlargement: true })
          .toColourspace('srgb')
          .webp({ quality: 94, alphaQuality: 100, effort: 6 })
          .toFile(thumb + '.tmp');
        fs.renameSync(thumb + '.tmp', thumb);
      }
    }
  }),
);
for (const row of reviewed.items) {
  const original = path.join(root, row.webp),
    proof = pdf.rows.find((p) => p.number === row.number);
  assert.equal(proof.pdfRenderSha256 ?? proof.renderSha256, row.pdfRenderSha256);
  assert.equal(sha(fs.readFileSync(path.join(root, proof.pdfRender))), proof.renderSha256);
  const pair = format.rows.find((p) => p.sourceName === row.sourceName && p.pack === row.pack);
  assert(
    pair &&
      pair.pages === 1 &&
      pair.pdfSha256 === row.pdfSha256 &&
      pair.webpSha256 === row.webpSha256,
  );
  const print = proof.printEdition;
  assert(print.alphaMask && print.components === 4 && print.ppi >= 150 && print.ppi <= 600);
  const item = {
    id: row.id,
    title: row.title,
    alt: row.alt,
    description: row.description,
    topic: row.topic,
    sourceType: 'raster',
    svg: null,
    sourceCollection: collection,
    sourceArchiveTopic: row.pack,
    provenance: 'Owner-supplied collection; original PDF and WebP bytes preserved.',
    productionMethod: 'owner-supplied',
    licenseStatus: 'OWNER_APPROVED_PERSONAL_EDUCATIONAL_ONLY',
    license:
      'Free personal and educational use. Commercial use and resale as clipart are prohibited.',
    licenseApprovedAt: '2026-10-27',
    reviewStatus: 'FORMAT_AND_PAIR_REVIEW_PASSED',
    published: true,
    indexable: true,
    createdAt: reviewed.checkedAt,
    revision: 1,
    formats: ['WEBP', 'PDF'],
    width: row.width,
    height: row.height,
    alpha: true,
    orientation:
      row.width === row.height ? 'Square' : row.width > row.height ? 'Landscape' : 'Portrait',
    printProfile: print.profile,
    pdfColorSpace: print.colorSpace,
    pdfPage: print.pagePoints.map((n) => (n / 72).toFixed(3)).join(' × ') + ' in',
    pdfPrint: {
      width: print.width,
      height: print.height,
      ppi: print.ppi,
      pagePoints: print.pagePoints,
    },
    discovery: { cute: false },
    files: {},
  };
  const { data } = await sharp(original)
    .resize(96, 96, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let visible = 0,
    chromatic = 0;
  const palette = {};
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] < 128) continue;
    const [r, g, b] = data.subarray(p, p + 3),
      hi = Math.max(r, g, b),
      lo = Math.min(r, g, b);
    visible++;
    if (hi - lo > 12) chromatic++;
    const color =
      hi - lo < 22
        ? hi > 225
          ? 'White'
          : hi < 65
            ? 'Black'
            : 'Gray'
        : r > g * 1.15 && r > b * 1.15
          ? g > 110
            ? 'Orange'
            : 'Red'
          : g > r * 1.1 && g > b * 1.1
            ? 'Green'
            : b > r * 1.1 && b > g * 1.1
              ? 'Blue'
              : r > 150 && g > 135 && b < 125
                ? 'Yellow'
                : b > 100 && r > 100
                  ? 'Purple'
                  : 'Brown';
    palette[color] = (palette[color] ?? 0) + 1;
  }
  assert(visible > 0);
  item.style = chromatic / visible < 0.005 ? 'Black & White' : 'Color';
  item.visualStyle =
    item.style === 'Color' ? 'Full-color illustration' : 'Black-and-white illustration';
  item.color = Object.entries(palette).sort((a, b) => b[1] - a[1])[0][0];
  for (const kind of ['webp', 'pdf', 'thumb']) {
    const name = row.id + (kind === 'thumb' ? '-thumb.webp' : '.' + kind),
      relative = `/catalog/${row.topic}/${name}`;
    const body = fs.readFileSync(path.join(root, 'public', relative)),
      hash = sha(body);
    item[kind] = relative;
    item.files[kind] = { bytes: body.length, sha256: hash };
    const representation = kind === 'thumb' ? 'thumbnail' : kind;
    objects.push({
      assetId: item.id,
      sourceType: 'raster',
      kind: representation,
      bucket: 'ultraclipart-media',
      jurisdiction: 'default',
      key: `${row.topic}/${row.id}.${representation}.${hash.slice(0, 16)}.${kind === 'pdf' ? 'pdf' : 'webp'}`,
      path: 'public' + relative,
      bytes: body.length,
      sha256: hash,
    });
  }
  const review = {
    id: item.id,
    status: 'reviewed-from-image',
    sourceSha256: item.files.webp.sha256,
    imageSha256: item.files.webp.sha256,
    inputMetadataSha256: metadataSignature(item),
    inspectedImage: item.webp,
    reviewedAt: row.reviewedAt,
    observations: row.observations,
    references: row.references,
    copy: { title: item.title, alt: item.alt, description: item.description },
  };
  validateEditorialReview(item, review);
  editorial.push(review);
  items.push(item);
}
assert.equal(items.length, 500);
assert.equal(objects.length, 1500);
const next = [...baseline, ...items],
  registry = mergeEditorialBatch(next, read('data/editorial/reviews.json'), {
    schema: 1,
    artworks: editorial,
  });
reviewedImportCatalog(next, registry);
const extra = structuredClone(existingExtra),
  copy = read('data/collection-copy.json'),
  clusters = read('data/topic-clusters.json'),
  relations = read('data/topic-relations.json');
let nextId = Math.max(...baseTopics.map((t) => t.id), ...extra.map((t) => t.id)) + 1;
const summaries = { schema: 1, topics: {} };
const allTopics = new Set([...knownTopics, ...Object.keys(contexts)]);
for (const [topic, context] of Object.entries(contexts)) {
  assert(!knownTopics.has(topic), 'New topic collided with an existing subject');
  const group = items.filter((a) => a.topic === topic);
  assert(group.length > 0);
  assert(
    context.related.length <= 6 && context.related.every((t) => t !== topic && allTopics.has(t)),
  );
  extra.push({
    id: nextId++,
    keyword: context.label + ' clipart',
    slug: topic,
    cluster: context.cluster,
    wave: 'OWNER_COLLECTION',
    target_original_artworks: group.length,
    focus_note: context.intro,
    supplemental: true,
  });
  copy[topic] = {
    description: context.intro,
    lead: context.intro,
    intro: context.intro,
    featured: group
      .filter((a) => a.style === 'Color')
      .slice(0, 5)
      .map((a) => a.id),
    chips: [],
    heading: context.label + ' illustrations',
    paragraphs: [],
    print: '',
    related: context.related,
  };
  clusters[topic] = [];
  relations[topic] = context.related;
  const record = {
    status: 'checked-against-catalog',
    sourceSha256: collectionSourceSignature(group),
    intro: context.intro,
    checkedAt: reviewed.checkedAt,
    evidence: group.slice(0, 3).map((a) => ({ id: a.id, imageSha256: a.files.webp.sha256 })),
  };
  validateCollectionCopy(topic, group, record);
  summaries.topics[topic] = record;
}
save(path.join(stage, 'art.next.json'), next);
save(path.join(stage, 'extra-topics.next.json'), extra);
save(path.join(stage, 'collection-copy.next.json'), copy);
save(path.join(stage, 'topic-clusters.next.json'), clusters);
save(path.join(stage, 'topic-relations.next.json'), relations);
save(path.join(stage, 'editorial-batch.json'), { schema: 1, artworks: editorial });
save(path.join(stage, 'collection-editorial.next.json'), summaries);
save(path.join(stage, 'batch.r2-batch.json'), objects);
for (let wave = 0; wave < 10; wave++) {
  const ids = new Set(items.slice(wave * 50, (wave + 1) * 50).map((a) => a.id)),
    batch = objects.filter((o) => ids.has(o.assetId));
  validateBatch(batch);
  assert.equal(batch.length, 150);
  const file = path.join(stage, `wave-${wave + 1}.r2-batch.json`);
  if (fs.existsSync(file)) assert.deepEqual(read(file), batch, 'Prepared immutable wave changed');
  save(file, batch);
}
save(path.join(stage, 'review.next.json'), {
  schema: 1,
  status: 'PREPARED_NOT_UPLOADED',
  collection,
  count: 500,
  baselineCatalogSha256: sha(baselineBytes),
  sourceReviewSha256: sha(fs.readFileSync(path.join(stage, 'visual-copy-review.json'))),
  items,
  originalWebPsPreserved: 500,
  originalPdfsPreserved: 500,
  repairedPdfs: 0,
  generated: 0,
});
console.log(
  JSON.stringify({
    status: 'PREPARED_NOT_UPLOADED',
    artworks: 500,
    objects: 1500,
    topics: reviewed.topics,
    baseline: baseline.length,
    total: next.length,
  }),
);
