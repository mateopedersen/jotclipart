// Directly retained source-only assertions from tests/catalog.mjs (first four)
// and tests/publication.mjs (first five). The original four static release files
// remain unchanged; their physical full-library/package checks have separate
// signed R2/native live equivalents and are not claimed as local-file passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  statfsSync,
  mkdtempSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validateEditorialReview } from '../scripts/artwork-editorial.mjs';
import { shardStudioCatalog } from '../scripts/delivery/studio-catalog-shard.mjs';
import { assertReleaseBudgets } from '../scripts/delivery/budgets.mjs';
import { validatePublication, readPublication } from '../scripts/publication-policy.mjs';
import { artwork, manifestFor } from './fixtures/publication.mjs';
const root = resolve(import.meta.dirname, '..');
const topics = JSON.parse(readFileSync(join(root, 'data/topics.json'))).topics;
const arts = JSON.parse(readFileSync(join(root, 'data/art.json')));
const digest = (b) => createHash('sha256').update(b).digest('hex');
const fixture = () => {
  const bodies = new Map(),
    item = artwork('drawing-one', bodies);
  return {
    manifest: manifestFor([item]),
    catalog: [item],
    read: (path) => bodies.get(path),
    bodies,
  };
};
function assertCatalogText(art) {
  for (const field of ['title', 'alt', 'description'])
    assert.ok(typeof art[field] === 'string' && art[field].trim(), `missing ${field}: ${art.id}`);
}

function verifyStudioPreparation(file, expectedIds, options) {
  const scratch = mkdtempSync(join(tmpdir(), 'uc-studio-preflight-'));
  try {
    const input = readFileSync(file);
    const volume = statfsSync(scratch, { bigint: true });
    assert.ok(
      volume.bavail * volume.bsize >= 5n * 1024n ** 3n + 2n * BigInt(input.length),
      'Studio preflight would breach the five-GiB free-space reserve',
    );
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
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
  assert.throws(
    () =>
      validateEditorialReview(
        {
          ...sample,
          files: { ...sample.files, webp: { ...sample.files.webp, sha256: '0'.repeat(64) } },
        },
        review,
      ),
    /image changed/,
  );
});

test('Studio preflight rejects a mismatched reviewed ID set without changing its source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-studio-source-'));
  try {
    const source = join(dir, 'input.json'),
      original = Buffer.from('[{"id":"first"},{"id":"second"}]');
    writeFileSync(source, original);
    assert.throws(
      () => verifyStudioPreparation(source, ['first'], { triggerBytes: 1, partBytes: 9 }),
      /match/,
    );
    assert.deepEqual(readFileSync(source), original);
    assert.ok(
      verifyStudioPreparation(source, ['second', 'first'], { triggerBytes: 1, partBytes: 9 }) > 1,
    );
    assert.deepEqual(readFileSync(source), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production requires a complete byte-identical per-file CDN release', () => {
  const f = fixture(),
    release = validatePublication(f.manifest, f.catalog, f.read);
  assert.equal(release.files, 4);
  assert.equal(release.bytes, f.manifest.bytes);
  assert.deepEqual(
    release.localPaths,
    Object.keys(f.catalog[0].files).map((kind) => f.catalog[0][kind]),
  );
  assert.deepEqual(
    release.urls,
    f.manifest.files.map((file) => file.url),
  );
  for (const file of f.manifest.files)
    assert.equal(release.assetUrls[file.assetId][file.kind], file.url);
  f.bodies.set('/pilot/drawing-one.svg', Buffer.from('changed after verification'));
  assert.throws(() => validatePublication(f.manifest, f.catalog, f.read), /Source changed/);
});

test('unverified, missing, duplicated or mismatched publication records fail closed', () => {
  for (const mutate of [
    (m) => (m.status = 'pending'),
    (m) => (m.schema = 1),
    (m) => m.files.pop(),
    (m) => m.files.push(m.files[0]),
    (m) => (m.files[0].sha256 = 'b'.repeat(64)),
    (m) => m.bytes++,
    (m) => (m.files[0].contentType = 'text/plain'),
    (m) => (m.files[0].corsOrigin = 'https://other.example'),
    (m) => (m.files[0].verification = 'uploaded-only'),
  ]) {
    const f = fixture();
    mutate(f.manifest);
    assert.throws(() => validatePublication(f.manifest, f.catalog, f.read));
  }
});

test('wrong-origin, mutable, ambiguous and query-bearing URLs are forbidden', () => {
  for (const url of [
    'http://assets.ultraclipart.com/pilot-123456abcdef/drawing-one.svg',
    'https://evil.example/pilot-123456abcdef/drawing-one.svg',
    'https://assets.ultraclipart.com/drawing-one.svg',
    'https://assets.ultraclipart.com/pilot-123456abcdef/drawing-one.svg?q=1',
    'https://assets.ultraclipart.com/pilot-123456abcdef/drawing-one.svg#fragment',
    'https://user@assets.ultraclipart.com/pilot-123456abcdef/drawing-one.svg',
    'https://assets.ultraclipart.com/pilot-123456abcdef/%2E%2E/drawing-one.svg',
    'https://assets.ultraclipart.com:443/pilot-123456abcdef/drawing-one.svg',
  ]) {
    const f = fixture();
    f.manifest.files[0].url = url;
    assert.throws(() => validatePublication(f.manifest, f.catalog, f.read));
  }
});

test('source paths must remain normalized under public', () => {
  for (const path of [
    '/../secret.svg',
    '/pilot//drawing-one.svg',
    '/pilot/%2e%2e/file.svg',
    '/pilot/drawing-one.svg?raw=1',
    'pilot/drawing-one.svg',
  ]) {
    const f = fixture();
    f.manifest.files[0].path = path;
    f.catalog[0].svg = path;
    assert.throws(() => validatePublication(f.manifest, f.catalog, f.read), /path|filename/);
  }
});

test('production refuses a source symlink outside public even when its bytes match', () => {
  const f = fixture(),
    root = mkdtempSync(join(tmpdir(), 'ultraclipart-publication-'));
  try {
    mkdirSync(join(root, 'data'));
    mkdirSync(join(root, 'public/pilot'), { recursive: true });
    writeFileSync(join(root, 'data/art.json'), JSON.stringify(f.catalog));
    writeFileSync(join(root, 'data/publication.json'), JSON.stringify(f.manifest));
    for (const [path, body] of f.bodies) writeFileSync(join(root, 'public', path), body);
    const source = join(root, 'public', f.catalog[0].svg),
      outside = join(root, 'private-source.svg');
    writeFileSync(outside, f.bodies.get(f.catalog[0].svg));
    rmSync(source);
    symlinkSync(outside, source);
    assert.throws(() => readPublication(root), /symlink escapes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
