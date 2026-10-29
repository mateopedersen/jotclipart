import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { testBuildUrl } from './support/build-directory.mjs';
import {
  cleanLegacyCopy,
  copyIssues,
  metadataSignature,
  readEditorialAudit,
  reviewContextSignature,
  resolveArtworkCopy,
  sourceSignature,
  validateEditorialReview,
  verifyEditorialCatalog,
} from '../scripts/artwork-editorial.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const catalog = read('data/art.json');
const baseline = read('data/editorial/legacy-baseline.json');
const registry = read('data/editorial/reviews.json');
const reviews = new Map(registry.artworks.map((record) => [record.id, record]));
const decode = (value) =>
  value.replace(/&#(?:x([\da-f]+)|(\d+));|&(amp|lt|gt|quot|apos);/gi, (_, hex, decimal, named) =>
    hex || decimal
      ? String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10))
      : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named],
  );

test('the complete catalog uses the same source-checked editorial resolver', () => {
  const report = readEditorialAudit(root.pathname);
  assert.equal(report.total, catalog.length);
  assert.equal(report.reviewed + report.awaitingImageReview, catalog.length);
  assert.equal(report.reviewed, reviews.size);
  assert(report.changed > 9000);
  const titles = new Set();
  const publishedTitles = new Map();
  const reviewedDescriptions = new Map();
  for (const item of catalog) {
    const copy = resolveArtworkCopy(item, reviews.get(item.id));
    assert(copy.description.trim(), item.id);
    assert.doesNotMatch(copy.description, /\bWebP\b/i, item.id);
    assert.doesNotMatch(copy.description, /Download the transparent.*digital layout/i, item.id);
    const key = `${item.topic}:${copy.title.toLowerCase()}`;
    assert(!titles.has(key), `Indistinguishable titles within topic: ${item.id}`);
    titles.add(key);
    if (item.published && item.indexable) {
      const globalTitle = copy.title.toLowerCase();
      assert(
        !publishedTitles.has(globalTitle),
        `Repeated artwork title: ${publishedTitles.get(globalTitle)} and ${item.id}`,
      );
      publishedTitles.set(globalTitle, item.id);
    }
    if (reviews.has(item.id)) {
      // These records have already passed the source-bound review validator.
      // A concise inspected description does not inherit the legacy length flag.
      assert.deepEqual(copyIssues(copy, { reviewed: true }), [], item.id);
      const description = copy.description.toLowerCase();
      assert(
        !reviewedDescriptions.has(description),
        `Repeated reviewed description: ${reviewedDescriptions.get(description)} and ${item.id}`,
      );
      reviewedDescriptions.set(description, item.id);
    }
  }
});

test('a concise reviewed description keeps all content checks without a legacy length requirement', () => {
  const copy = {
    title: 'Three Plush Polar Bear Zeros',
    alt: 'Three soft white zeros with rounded bear ears.',
    description: 'Rounded white ears sit above each plush zero.',
  };
  assert.deepEqual(copyIssues(copy), ['description:needs-detail-review']);
  assert.deepEqual(copyIssues(copy, { reviewed: true }), []);
  assert(
    copyIssues(
      { ...copy, description: 'Expert-approved human-created drawing.' },
      { reviewed: true },
    ).includes('description:unsupported-authorship'),
  );
  assert(
    copyIssues(
      {
        ...copy,
        description:
          'Download the transparent WebP for a digital layout, or choose the matching PDF for printing.',
      },
      { reviewed: true },
    ).includes('description:boilerplate'),
  );
});

test('cleanup deletes reviewed filler without adding claims or removing concept qualifications', () => {
  const item = {
    id: 'fixture',
    title: 'Decorative Map',
    alt: 'Decorative Map. A map with a red route.',
    description:
      'A decorative map with a red route. Download the transparent WebP for a digital layout, or choose the matching PDF for printing. This is not an official map. Download wording is part of the picture; no game or installer is included.',
  };
  assert.deepEqual(cleanLegacyCopy(item), {
    title: item.title,
    alt: 'A map with a red route.',
    description:
      'A decorative map with a red route. This is not an official map. Download wording is part of the picture; no game or installer is included.',
  });
  assert.equal(
    cleanLegacyCopy({ ...item, description: 'A dial marked 3.5 beside a U.S. flag.' }).description,
    'A dial marked 3.5 beside a U.S. flag.',
  );
});

test('new or changed artwork cannot inherit a legacy exemption', () => {
  const item = catalog.find((row) => baseline.records[row.id]);
  assert(item, 'a finite legacy fixture is required');
  const newItem = { ...item, id: 'new-unreviewed-picture' };
  assert.throws(
    () => verifyEditorialCatalog([newItem], baseline, { schema: 1, artworks: [] }),
    /new or changed/,
  );
  assert.throws(
    () =>
      verifyEditorialCatalog(
        [{ ...item, description: 'An unreviewed replacement description.' }],
        baseline,
        { schema: 1, artworks: [] },
      ),
    /new or changed/,
  );
  const changedImage = structuredClone(item);
  changedImage.files.webp.sha256 = 'a'.repeat(64);
  assert.throws(
    () => verifyEditorialCatalog([changedImage], baseline, { schema: 1, artworks: [] }),
    /new or changed/,
  );
});

test('reviews reject stale source pixels, metadata, missing evidence and generic replacement text', () => {
  const record = registry.artworks[0];
  const item = catalog.find((row) => row.id === record.id);
  assert.equal(sourceSignature(item), record.sourceSha256);
  assert.equal(metadataSignature(item), record.inputMetadataSha256);
  assert.equal(reviewContextSignature(item), record.inputContextSha256);
  assert.equal(
    reviewContextSignature(item),
    reviewContextSignature(Object.fromEntries(Object.entries(item).reverse())),
  );
  assert.throws(
    () => validateEditorialReview(item, { ...record, sourceSha256: 'a'.repeat(64) }),
    /image changed/,
  );
  assert.throws(
    () => validateEditorialReview(item, { ...record, imageSha256: 'a'.repeat(64) }),
    /image changed/,
  );
  assert.throws(
    () => validateEditorialReview({ ...item, title: 'Changed title' }, record),
    /metadata changed/,
  );
  assert.throws(
    () => validateEditorialReview({ ...item, topic: `${item.topic}-changed` }, record),
    /metadata changed/,
  );
  assert.throws(
    () =>
      validateEditorialReview(
        {
          ...item,
          productIdentity: {
            ...(item.productIdentity || {}),
            visibleFeatures: 'Unreviewed identity details',
          },
        },
        record,
      ),
    /metadata changed/,
  );
  assert.throws(
    () => validateEditorialReview(item, { ...record, observations: [] }),
    /visible evidence/,
  );
  assert.throws(
    () => validateEditorialReview(item, { ...record, inspectedImage: '/other.webp' }),
    /wrong inspected/,
  );
  assert.throws(
    () =>
      validateEditorialReview(item, {
        ...record,
        copy: {
          ...record.copy,
          description:
            'Illustration showing a bridge. Download the transparent WebP for a digital layout, or choose the matching PDF for printing.',
        },
      }),
    /filename-template|boilerplate/,
  );
  assert.throws(
    () =>
      verifyEditorialCatalog(catalog, baseline, {
        ...registry,
        artworks: [...registry.artworks, record],
      }),
    /Duplicate editorial/,
  );
});

test(
  'visible artwork copy, search data and image schema agree after a production build',
  {
    skip:
      !process.env.UC_TEST_BUILD_DIR &&
      !existsSync(new URL('art/new-york-clipart-central-park-bow-bridge/index.html', testBuildUrl)),
  },
  () => {
    if (process.env.UC_TEST_BUILD_REVISION)
      assert.ok(
        readFileSync(new URL('index.html', testBuildUrl), 'utf8').includes(
          `name="build-revision" content="${process.env.UC_TEST_BUILD_REVISION}"`,
        ),
        'Unexpected build revision',
      );
    const manifest = JSON.parse(
      readFileSync(new URL('search-data/manifest.json', testBuildUrl), 'utf8'),
    );
    const directory = new URL(`search-data/${manifest.version}/items/`, testBuildUrl);
    const cards = new Map(
      readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .flatMap((name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')))
        .map((item) => [item.id, item]),
    );
    assert.equal(cards.size, catalog.length);
    for (const item of catalog) {
      const expected = resolveArtworkCopy(item, reviews.get(item.id));
      const card = cards.get(item.id);
      assert.equal(card?.title, expected.title, item.id);
      assert.equal(card?.alt, expected.alt, item.id);
      assert.equal(card.download.files.webp.sha256, item.files.webp.sha256, item.id);
    }
    for (const record of registry.artworks) {
      const html = readFileSync(new URL(`art/${record.id}/index.html`, testBuildUrl), 'utf8');
      const schemas = [
        ...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
      ].map((match) => JSON.parse(match[1]));
      const schema = schemas.find((entry) => entry['@type'] === 'ImageObject');
      assert.equal(schema.name, record.copy.title, record.id);
      assert.equal(schema.description, record.copy.description, record.id);
      assert.equal(schema.encodingFormat, 'image/webp');
      assert.equal(
        decode(html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1] ?? ''),
        record.copy.title,
        record.id,
      );
      assert.equal(
        decode(html.match(/<meta property="og:image:alt" content="([^"]*)"/)?.[1] ?? ''),
        record.copy.alt,
        record.id,
      );
      assert.doesNotMatch(html, /Download the transparent WebP for a digital layout/);
    }
  },
);
