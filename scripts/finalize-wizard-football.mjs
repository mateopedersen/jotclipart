import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mergeReviewedContent } from './merge-reviewed-content.mjs';
import { validatePublication } from './publication-policy.mjs';
import { mergeEditorialBatch } from './apply-editorial-review.mjs';
import { reviewedImportCatalog } from './reviewed-imports.mjs';
import { validateCollectionCopy } from './collection-editorial.mjs';
const root = path.resolve(import.meta.dirname, '..'),
  stage = path.join(root, 'work/imports/wizard-football-2026-10-27');
const read = (p) => JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const baselineBytes = fs.readFileSync(path.join(root, 'data/art.json')),
  baseline = JSON.parse(baselineBytes),
  report = read(path.join(stage, 'review.next.json'));
assert.equal(report.status, 'PREPARED_NOT_UPLOADED');
assert.equal(report.count, 500);
assert.equal(report.items.length, 500);
assert.equal(
  report.baselineCatalogSha256,
  sha(baselineBytes),
  'Reconcile the current accepted catalog first',
);
assert.equal(
  report.sourceReviewSha256,
  sha(fs.readFileSync(path.join(stage, 'visual-copy-review.json'))),
);
const visual = read(path.join(stage, 'visual-copy-review.json'));
assert.equal(visual.status, 'VISUAL_AND_COPY_REVIEWED_NOT_UPLOADED');
for (const sheet of visual.sheets) {
  assert(sheet.reviewedFromPixels);
  assert.equal(sheet.sha256, sha(fs.readFileSync(path.join(stage, sheet.file))));
}
assert.equal(
  visual.similarityReviewSha256,
  sha(fs.readFileSync(path.join(stage, 'similarity-review.json'))),
);
const similarity = read(path.join(stage, 'similarity-review.json'));
assert.equal(similarity.status, 'PASS');
assert.equal(similarity.candidates.length, similarity.decisions.length);
for (let wave = 1; wave <= 10; wave++) {
  const file = path.join(stage, `wave-${wave}.r2-batch.json`),
    batch = read(file),
    journal = read(path.join(stage, `wave-${wave}.upload-journal.json`));
  assert.equal(batch.length, 150);
  assert.equal(journal.status, 'uploaded-and-byte-verified');
  assert.equal(journal.batchSha256, sha(fs.readFileSync(file)));
  assert.equal(journal.verifiedArtworkIds.length, 50);
  assert.equal(journal.verifiedObjects.length, 150);
  for (const object of batch) {
    const bytes = fs.readFileSync(path.join(root, object.path));
    assert.equal(bytes.length, object.bytes);
    assert.equal(sha(bytes), object.sha256);
    assert(journal.verifiedObjects.some((x) => x.key === object.key && x.sha256 === object.sha256));
  }
}
const merged = mergeReviewedContent({
  baseline,
  added: report.items,
  currentPublication: read('data/publication.json'),
  stagedPublication: read(path.join(stage, 'wave-10.publication.next.json')),
  baseTopics: read('data/topics.json').topics,
  currentExtra: read('data/extra-topics.json'),
  stagedExtra: read(path.join(stage, 'extra-topics.next.json')),
  currentCopy: read('data/collection-copy.json'),
  stagedCopy: read(path.join(stage, 'collection-copy.next.json')),
  currentClusters: read('data/topic-clusters.json'),
  stagedClusters: read(path.join(stage, 'topic-clusters.next.json')),
});
validatePublication(merged.publication, merged.art, (p) =>
  fs.readFileSync(path.join(root, 'public', p)),
);
const registry = mergeEditorialBatch(
  merged.art,
  read('data/editorial/reviews.json'),
  read(path.join(stage, 'editorial-batch.json')),
);
reviewedImportCatalog(merged.art, registry);
const summaries = read(path.join(stage, 'collection-editorial.next.json'));
for (const [topic, record] of Object.entries(summaries.topics))
  validateCollectionCopy(
    topic,
    merged.art.filter((x) => x.topic === topic),
    record,
  );
const relations = read('data/topic-relations.json'),
  stagedRelations = read(path.join(stage, 'topic-relations.next.json'));
for (const topic of Object.keys(summaries.topics)) relations[topic] = stagedRelations[topic];
const changes = [
  ['data/art.json', merged.art],
  ['data/publication.json', merged.publication],
  ['data/extra-topics.json', merged.extra],
  ['data/collection-copy.json', merged.copy],
  ['data/topic-clusters.json', merged.clusters],
  ['data/topic-relations.json', relations],
  ['data/editorial/reviews.json', registry],
  ['data/editorial/wizard-football-collections.json', summaries],
];
// Validate the whole scope before any accepted catalog file changes. Existing
// unrelated topic copy and source-bound reviews survive the merge.
for (const [file, value] of changes)
  fs.writeFileSync(path.join(root, file + '.tmp'), JSON.stringify(value, null, 2) + '\n');
for (const [file] of changes) fs.renameSync(path.join(root, file + '.tmp'), path.join(root, file));
let redirects = fs.readFileSync(path.join(root, 'public/_redirects'), 'utf8');
for (const suffix of ['', '/']) {
  const line = `/clipart/valentine-football${suffix} /clipart/football-valentine/ 301`;
  if (!redirects.includes(line)) redirects += '\n' + line + '\n';
}
fs.writeFileSync(path.join(root, 'public/_redirects'), redirects);
fs.writeFileSync(
  path.join(root, 'data/wizard-football-collection-review.json'),
  JSON.stringify({ ...report, status: 'CDN_VERIFIED_READY_FOR_DEPLOYMENT' }, null, 2) + '\n',
);
execFileSync(process.execPath, [path.join(root, 'scripts/sync-production-queue.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
console.log(
  JSON.stringify({
    status: 'PROMOTED_NOT_DEPLOYED',
    added: 500,
    total: merged.art.length,
    reviewed: registry.artworks.length,
  }),
);
