import test from 'node:test';
import { PAGES_FILE_LIMIT } from '../src/lib/pages-limits.ts';
import assert from 'node:assert/strict';
import { readFileSync, statSync, statfsSync, readdirSync, existsSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { representationKinds } from '../scripts/asset-representations.mjs';
import { readPublication } from '../scripts/publication-policy.mjs';
import { collectDeliveryFiles } from '../scripts/delivery/manifest.mjs';
import { releaseRevision } from '../scripts/release-revision.mjs';
import { validateEditorialReview } from '../scripts/artwork-editorial.mjs';
import { shardStudioCatalog } from '../scripts/delivery/studio-catalog-shard.mjs';
import { assertReleaseBudgets } from '../scripts/delivery/budgets.mjs';
import { testBuildDirectory } from './support/build-directory.mjs';

const root = resolve(import.meta.dirname, '..');
const topics = JSON.parse(readFileSync(join(root, 'data/topics.json'))).topics;
const arts = JSON.parse(readFileSync(join(root, 'data/art.json')));
const digest = (b) => createHash('sha256').update(b).digest('hex');
function assertCatalogText(art) {
  for (const field of ['title', 'alt', 'description'])
    assert.ok(typeof art[field] === 'string' && art[field].trim(), `missing ${field}: ${art.id}`);
}

// Exercise the same sharder as final activation on a disposable copy. This is
// preparation validation, not a substitute for the final artifact budget gate.
function verifyStudioPreparation(file, expectedIds, options) {
  const scratch = mkdtempSync(join(tmpdir(), 'uc-studio-preflight-'));
  try {
    const input = readFileSync(file);
    const volume = statfsSync(scratch, { bigint: true });
    assert.ok(volume.bavail * volume.bsize >= 5n * 1024n ** 3n + 2n * BigInt(input.length),
      'Studio preflight would breach the five-GiB free-space reserve');
    copyFileSync(file, join(scratch, 'studio-catalog.json'));
    const result = shardStudioCatalog(scratch, expectedIds, options);
    assert.ok(result, 'Studio catalog should have been split for final delivery');
    assert.equal(result.bytes, input.length);
    assert.equal(result.sha256, digest(input));
    const parts = result.parts.map((part) => readFileSync(join(scratch, part.path)));
    assert.deepEqual(Buffer.concat(parts), input, 'Studio shards do not reconstruct the source');
    writeFileSync(join(scratch, '_worker.js'), 'export default {}');
    writeFileSync(join(scratch, '_routes.json'), JSON.stringify({ include: ['/*'], exclude: [] }));
    assert.equal(assertReleaseBudgets(scratch).pagesFiles, result.parts.length);
    return result.parts.length;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if (char === '\n' && !quoted) {
      row.push(value.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else value += char;
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }
  assert.equal(quoted, false, 'unclosed CSV quote');
  const keys = rows.shift();
  return rows
    .filter((row) => row.some(Boolean))
    .map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i]])));
}

test('all 110 keyword records exactly match CSV identities and have collision-free routes', () => {
  const csv = parseCsv(readFileSync(join(root, 'data/topics.csv'), 'utf8'));
  assert.equal(topics.length, 110);
  assert.equal(csv.length, 110);
  assert.equal(new Set(topics.map((x) => x.id)).size, 110);
  assert.equal(new Set(topics.map((x) => x.slug)).size, 110);
  assert.equal(new Set(topics.map((x) => x.keyword)).size, 110);
  for (const topic of topics) {
    const source = csv.find((row) => Number(row.id) === topic.id);
    assert.ok(source, `missing source keyword ${topic.id}`);
    for (const field of ['keyword', 'slug', 'cluster', 'wave', 'focus_note'])
      assert.equal(topic[field], source[field]);
    assert.equal(topic.target_original_artworks, 50);
    assert.match(topic.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
  assert.equal(
    topics.reduce((n, topic) => n + topic.target_original_artworks, 0),
    5500,
  );
});

test('art identities, topic assignment, provenance and review states remain honest', () => {
  assert.equal(new Set(arts.map((a) => a.id)).size, arts.length);
  const extras = JSON.parse(readFileSync(join(root, 'data/extra-topics.json')));
  const validTopics = new Set([...topics, ...extras].map((t) => t.slug));
  for (const art of arts) {
    assert.ok(validTopics.has(art.topic), `unauthorized topic: ${art.topic}`);
    assert.match(art.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    // A source-reviewed description may be concise; length is not visual proof.
    // The independent editorial gate validates every new or changed review.
    assertCatalogText(art);
    assert.ok(art.provenance && art.productionMethod, `missing provenance: ${art.id}`);
    assert.equal(typeof art.published, 'boolean');
    assert.equal(typeof art.indexable, 'boolean');
    if (art.indexable) assert.equal(art.published, true);
    if (art.published) {
      assert.doesNotMatch(art.reviewStatus, /REQUIRED|PENDING|DRAFT/i);
      assert.doesNotMatch(art.licenseStatus, /REQUIRED|PENDING|UNKNOWN/i);
    }
  }
  for (const topic of topics) {
    const generated = arts.filter(
      (a) => a.topic === topic.slug && a.published && a.productionMethod !== 'owner-supplied',
    );
    if (generated.length <= 50) continue;
    const brief = JSON.parse(readFileSync(join(root, 'data/briefs', topic.slug + '.json')));
    assert.equal(
      brief.ownerApprovedTarget,
      100,
      'Expanded collection needs recorded owner approval',
    );
    assert.equal(brief.target, 100);
    assert.equal(brief.original110Allocation, 50);
    assert.equal(brief.additionalOwnerPriorityArtworks, 50);
    const planned = new Set(brief.rows.map((row) => row.artId));
    assert.equal(planned.size, 100);
    assert.ok(generated.length <= 100);
    assert.ok(generated.every((item) => planned.has(item.id)));
  }
});

test('concise text still needs nonempty fields and the existing source-bound review', () => {
  const registry = JSON.parse(readFileSync(join(root, 'data/editorial/reviews.json')));
  const reviewById = new Map(registry.artworks.map((row) => [row.id, row]));
  const sample = arts.find((art) => reviewById.has(art.id));
  const review = sample && reviewById.get(sample.id);
  assert.ok(sample && review);
  const concise = { ...sample, title: 'Car', alt: 'A car.', description: 'Fine lines.' };
  assert.doesNotThrow(() => assertCatalogText(concise));
  assert.doesNotThrow(() => validateEditorialReview(sample, review));
  assert.throws(() => validateEditorialReview(concise, review), /metadata changed/);
  for (const field of ['title', 'alt', 'description'])
    assert.throws(() => assertCatalogText({ ...sample, [field]: ' ' }), /missing/);
  assert.throws(() => validateEditorialReview(sample, undefined), /actual image review required/);
  assert.throws(() => validateEditorialReview({ ...sample, files: { ...sample.files,
    webp: { ...sample.files.webp, sha256: '0'.repeat(64) } } }, review), /image changed/);
});

test('Studio preflight rejects a mismatched reviewed ID set without changing its source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-studio-source-'));
  try {
    const source = join(dir, 'input.json'), original = Buffer.from('[{"id":"first"},{"id":"second"}]');
    writeFileSync(source, original);
    assert.throws(() => verifyStudioPreparation(source, ['first'], { triggerBytes: 1, partBytes: 9 }), /match/);
    assert.deepEqual(readFileSync(source), original);
    assert.ok(verifyStudioPreparation(source, ['second', 'first'], { triggerBytes: 1, partBytes: 9 }) > 1);
    assert.deepEqual(readFileSync(source), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every artwork has its declared real, correctly typed, paired and hashed representations', () => {
  const paths = new Set();
  const svgHashes = new Set();
  for (const art of arts) {
    for (const kind of representationKinds(art)) {
      assert.ok(/^\/(?:pilot|catalog\/[a-z0-9_-]+)\//.test(art[kind]) && !art[kind].includes('..'));
      assert.ok(art[kind].includes(art.id), `cross-wired ${kind}: ${art.id}`);
      assert.ok(!paths.has(art[kind]), `shared file: ${art[kind]}`);
      paths.add(art[kind]);
      const path = join(root, 'public', art[kind]);
      const bytes = readFileSync(path);
      assert.ok(bytes.length > 0);
      assert.equal(art.files?.[kind]?.bytes, bytes.length, `wrong recorded byte size: ${path}`);
      assert.equal(art.files?.[kind]?.sha256, digest(bytes), `wrong SHA256: ${path}`);
      if (kind === 'pdf') {
        assert.equal(bytes.toString('ascii', 0, 5), '%PDF-');
        assert.ok(bytes.length <= 1_000_000, `PDF exceeds hard cap: ${art.id}`);
      } else if (kind === 'svg') {
        const text = bytes.toString('utf8');
        assert.match(text, /<svg[\s>]/);
        assert.doesNotMatch(
          text,
          /<script|foreignObject|\son[a-z]+\s*=|javascript:|<!DOCTYPE|<!ENTITY/i,
        );
        const groups = [...text.matchAll(/<g\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
        assert.ok(groups.length >= 2, `source is not layered: ${art.id}`);
        assert.equal(new Set(groups).size, groups.length, `duplicate layer IDs: ${art.id}`);
        assert.ok(!svgHashes.has(digest(bytes)), `exact duplicated artwork: ${art.id}`);
        svgHashes.add(digest(bytes));
      } else {
        assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
        assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      }
    }
  }
});

test(
  'built static payload fits Workers Free file and individual size limits',
  { skip: !existsSync(testBuildDirectory) },
  () => {
    function files(dir) {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    }
    const dist = testBuildDirectory;
    // Development bundles local masters for offline editing. Production removes
    // catalog staging and the byte-verified R2 representations before upload.
    // CF_PAGES checks the actual output with no exclusions.
    const localMedia =
      process.env.CF_PAGES === '1' ? new Set() : new Set(readPublication(root).localPaths);
    const output = files(dist).filter((file) => {
      const path = '/' + relative(dist, file);
      return (
        process.env.CF_PAGES === '1' || (!path.startsWith('/catalog/') && !localMedia.has(path))
      );
    });
    // Preparation output is never uploaded. Its reviewed delivery files are
    // verified in R2 and removed from a separate final artifact; that artifact
    // receives an independent exact count and size check before deployment.
    const preparing = process.env.CF_PAGES === '1' && process.env.UC_DELIVERY_PREPARE === '1';
    let studioParts = 0;
    const studio = resolve(dist, 'studio-catalog.json');
    if (preparing && existsSync(studio) && statSync(studio).size > 20 * 1024 * 1024) {
      studioParts = verifyStudioPreparation(studio, arts
        .filter((art) => art.published && art.indexable && art.sourceType === 'raster')
        .map((art) => art.id));
    }
    if (preparing) {
      const delivery = collectDeliveryFiles(dist, releaseRevision());
      assert.ok(delivery.length > 0, 'delivery preparation has no verified-file candidates');
      assert.ok(
        output.length - delivery.length + (studioParts ? studioParts - 1 : 0) <= PAGES_FILE_LIMIT,
        `prepared output still exceeds Pages limit after sharding`,
      );
    } else {
      assert.ok(output.length <= PAGES_FILE_LIMIT, `too many static assets: ${output.length}`);
    }
    for (const file of output) {
      // Only the exact preflight-verified source is omitted from this preparatory
      // check. Activation removes it; the final release has its own 25 MiB gate.
      if (studioParts && resolve(file) === studio) continue;
      assert.ok(statSync(file).size <= 25 * 1024 * 1024, `oversized static asset: ${file}`);
    }
  },
);
