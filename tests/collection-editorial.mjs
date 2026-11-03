import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { testBuildUrl } from './support/build-directory.mjs';
import { collectionCountParts } from '../src/lib/collection-count-tokens.mjs';
import { formatCatalogCount } from '../src/lib/catalog-counts.ts';
import {
  readCollectionAudit,
  readCollectionRegistries,
  validateCollectionCopy,
  verifyCollectionEditorial,
} from '../scripts/collection-editorial.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const catalog = read('data/art.json');
const registry = readCollectionRegistries(root.pathname);

test('every published subject has its own concise introduction tied to the actual catalog', () => {
  const report = readCollectionAudit(root.pathname);
  const expected = new Set(
    catalog.filter((item) => item.published && item.indexable).map((item) => item.topic),
  ).size;
  assert.equal(report.topics, expected);
  assert.equal(report.uniqueIntroductions, expected);
  assert.match(registry.topics.sunflower.intro, /seed studies/);
  assert.doesNotMatch(registry.topics.sunflower.intro, /CMYK|WebP|Every design includes/);
});

test('new topics, changed pictures, duplicated prose and stale example IDs cannot bypass curation', () => {
  const items = catalog.filter((item) => item.topic === 'sunflower');
  const record = registry.topics.sunflower;
  assert.throws(() => validateCollectionCopy('sunflower', items, undefined), /missing or stale/);
  const replaced = structuredClone(items);
  replaced[0].files.webp.sha256 = 'a'.repeat(64);
  assert.throws(() => validateCollectionCopy('sunflower', replaced, record), /missing or stale/);
  assert.throws(
    () =>
      validateCollectionCopy('sunflower', items, {
        ...record,
        evidence: [
          { id: 'not-published', imageSha256: 'a'.repeat(64) },
          ...record.evidence.slice(1),
        ],
      }),
    /invalid or replaced/,
  );
  assert.throws(
    () =>
      validateCollectionCopy('sunflower', items, {
        ...record,
        intro: 'Every design includes a transparent WebP and matching CMYK PDF.',
      }),
    /technical filler/,
  );
  const duplicate = structuredClone(registry);
  duplicate.topics.sunflower.intro = duplicate.topics.wheat.intro;
  assert.throws(() => verifyCollectionEditorial(catalog, duplicate), /Repeated collection/);
});

test(
  'all built subject pages render checked paragraphs, current counts and matching concise schema',
  {
    skip:
      !process.env.UC_TEST_BUILD_DIR &&
      !existsSync(new URL('clipart/sunflower/index.html', testBuildUrl)),
  },
  () => {
    if (process.env.UC_TEST_BUILD_REVISION)
      assert.ok(
        readFileSync(new URL('index.html', testBuildUrl), 'utf8').includes(
          `name="build-revision" content="${process.env.UC_TEST_BUILD_REVISION}"`,
        ),
        'Unexpected build revision',
      );
    for (const [topic, record] of Object.entries(registry.topics)) {
      const html = readFileSync(new URL(`clipart/${topic}/index.html`, testBuildUrl), 'utf8');
      const schema = [
        ...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
      ]
        .map((match) => JSON.parse(match[1]))
        .find((entry) => entry['@type'] === 'CollectionPage');
      const published = catalog.filter(
        (item) => item.topic === topic && item.published && item.indexable,
      );
      if (published.length > 0) {
        assert.ok(schema, `Missing collection schema: ${topic}`);
        assert.equal(schema.description, record.intro, topic);
      } else {
        assert.equal(schema, undefined, `Empty collection must not expose schema: ${topic}`);
        assert.match(html, /<meta name="robots" content="noindex/, topic);
      }
      assert(html.includes('data-collection-summary'), topic);
      const panel = html.match(/<div[^>]*data-collection-summary[^>]*>([\s\S]*?)<\/div>/)?.[1];
      assert.ok(panel, `Missing paragraph panel: ${topic}`);
      const paragraphs = [...panel.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)];
      assert.equal(paragraphs.length, record.paragraphs.length, topic);
      const decode = (value) =>
        value
          .replace(/<[^>]+>/g, '')
          .replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, num, name) =>
            hex
              ? String.fromCodePoint(parseInt(hex, 16))
              : num
                ? String.fromCodePoint(Number(num))
                : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()],
          )
          .replace(/\s+/g, ' ')
          .trim();
      for (let i = 0; i < paragraphs.length; i++)
        assert.equal(
          decode(paragraphs[i][1]),
          collectionCountParts(record.paragraphs[i])
            .map((part) =>
              typeof part === 'string' ? part : formatCatalogCount(published.length, part.unit),
            )
            .join(''),
          `${topic}/${i}`,
        );
      assert.doesNotMatch(panel, /\{\{artworkCount\}\}/, topic);
      assert.doesNotMatch(
        html,
        /Keep the transparent WebP over|From screen to paper|Find a sunflower image with the right purpose and shape/,
      );
      assert.doesNotMatch(html, /https?:\/\/(?:127\.0\.0\.1|localhost)/);
      assert(html.includes('aria-label="Artwork help"'), topic);
    }
  },
);
