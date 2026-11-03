import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readReviewedImportCatalog } from './reviewed-imports.mjs';

export function collectionSourceSignature(items) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        items
          .map((item) => [item.id, item.title, item.alt, item.files.webp.sha256])
          .sort((a, b) => a[0].localeCompare(b[0], 'en')),
      ),
    )
    .digest('hex');
}

export function collectionParagraphSignature(items, summary) {
  return createHash('sha256')
    .update(JSON.stringify([collectionSourceSignature(items), summary]))
    .digest('hex');
}

export function collectionParagraphReviewSignature(record) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        record.paragraphSourceSha256,
        record.paragraphs,
        record.paragraphEvidence,
        record.paragraphsCheckedAt,
      ]),
    )
    .digest('hex');
}

/** Catalog-grounded writing approval, never a claim of fresh visual inspection. */
export function validateCollectionParagraphs(topic, items, record) {
  const fail = (reason) => {
    throw Error(`Collection ${topic}: ${reason}`);
  };
  if (record?.paragraphSourceSha256 !== collectionParagraphSignature(items, record?.intro))
    fail('missing or stale expanded introduction');
  if (
    !Array.isArray(record.paragraphs) ||
    record.paragraphs.length < 2 ||
    record.paragraphs.length > 3
  )
    fail('provide two or three short paragraphs');
  if (
    record.paragraphs.some(
      (text) => typeof text !== 'string' || text.trim().split(/\s+/).length < 10,
    )
  )
    fail('each paragraph must explain the collection');
  const text = record.paragraphs.join('\n\n');
  const words = text.trim().split(/\s+/).length;
  if (words < 50 || words > 200) fail('keep the introduction useful and concise (50–200 words)');
  if ((text.match(/\{\{artworkCount\}\}/g) ?? []).length !== 1)
    fail('use the live artwork count exactly once');
  if (
    /https?:|<[^>]+>|\b(?:cmyk|icc|gracol|dpi|ppi|E-E-A-T|handmade|expert-approved|human-created|guaranteed ranking)\b/i.test(
      text,
    )
  )
    fail('remove technical filler or unsupported claims');
  if (record.paragraphs.some((paragraph) => /[\r\n]/.test(paragraph)))
    fail('paragraphs must be plain text');
  if (!Number.isFinite(Date.parse(record.paragraphsCheckedAt)))
    fail('missing paragraph check date');
  if (
    !Array.isArray(record.paragraphEvidence) ||
    record.paragraphEvidence.length < Math.min(2, items.length)
  )
    fail('provide source-bound examples for expanded copy');
  const seen = new Set();
  for (const proof of record.paragraphEvidence) {
    const item = items.find((item) => item.id === proof.id);
    if (!item || seen.has(item.id) || item.files.webp.sha256 !== proof.imageSha256)
      fail('expanded introduction has stale or unrelated examples');
    seen.add(item.id);
  }
  if (record.paragraphReviewSha256 !== collectionParagraphReviewSignature(record))
    fail('expanded copy changed without a renewed catalog check');
  return record.paragraphs;
}

/** Detect topic-name substitution; this is not a visual or semantic review. */
export function collectionIntroductionTemplate(topic, text) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labels = [...new Set([topic, topic.replaceAll('-', ' ')])].sort(
    (a, b) => b.length - a.length,
  );
  const ownSubject = new RegExp(`\\b(?:${labels.map(escape).join('|')})s*\\b`, 'gi');
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(ownSubject, 'topicplaceholder')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function checkIntroductionTemplate(templates, topic, text) {
  const signature = collectionIntroductionTemplate(topic, text);
  const previous = templates.get(signature);
  if (previous)
    throw Error(`Topic-name-substituted collection introduction: ${previous} and ${topic}`);
  templates.set(signature, topic);
}

export function validateCollectionCopy(topic, items, record) {
  const fail = (reason) => {
    throw new Error(`Collection ${topic}: ${reason}`);
  };
  if (
    !record ||
    record.status !== 'checked-against-catalog' ||
    record.sourceSha256 !== collectionSourceSignature(items)
  )
    fail('missing or stale topic-specific editorial summary');
  if (
    typeof record.intro !== 'string' ||
    !record.intro.trim() ||
    record.intro.split(/\s+/).length > 80
  )
    fail('provide one concise, useful paragraph');
  if (/\b(?:webp|cmyk|icc|gracol|dpi|ppi|E-E-A-T)\b|https?:|\n|<[^>]+>/i.test(record.intro))
    fail('remove technical filler, links or markup from the introduction');
  if (/\b(?:handmade|expert-approved|human-created|guaranteed ranking)\b/i.test(record.intro))
    fail('unsupported authority or authorship claim');
  if (!Number.isFinite(Date.parse(record.checkedAt))) fail('missing editorial date');
  if (!Array.isArray(record.evidence) || record.evidence.length < Math.min(2, items.length))
    fail('identify the actual catalog examples');
  const ids = new Set();
  for (const proof of record.evidence) {
    const item = items.find((item) => item.id === proof.id);
    if (!item || ids.has(proof.id) || proof.imageSha256 !== item.files.webp.sha256)
      fail('invalid or replaced example');
    ids.add(proof.id);
  }
  return record.intro;
}

export function verifyCollectionEditorial(catalog, registry, resolvedCatalog = catalog) {
  if (registry?.schema !== 1) throw new Error('Unsupported collection editorial registry');
  const groups = new Map();
  for (const item of catalog.filter((item) => item.published && item.indexable)) {
    const group = groups.get(item.topic) ?? [];
    group.push(item);
    groups.set(item.topic, group);
  }
  const texts = new Set(),
    templates = new Map();
  for (const [topic, items] of groups) {
    const text = validateCollectionCopy(topic, items, registry.topics[topic]);
    if (texts.has(text.toLowerCase()))
      throw new Error(`Repeated collection introduction: ${topic}`);
    texts.add(text.toLowerCase());
    checkIntroductionTemplate(templates, topic, text);
  }
  for (const topic of Object.keys(registry.topics))
    if (!groups.has(topic))
      throw new Error(`No published artwork for collection summary: ${topic}`);
  const expanded = new Set();
  const publicById = new Map(resolvedCatalog.map((item) => [item.id, item]));
  for (const [topic, items] of groups) {
    const text = validateCollectionParagraphs(
      topic,
      items.map((item) => publicById.get(item.id)),
      registry.topics[topic],
    ).join('\n\n');
    if (expanded.has(text.toLowerCase()))
      throw Error('Repeated expanded collection introduction: ' + topic);
    expanded.add(text.toLowerCase());
  }
  return {
    topics: groups.size,
    uniqueIntroductions: texts.size,
    expandedIntroductions: expanded.size,
  };
}

export function readCollectionAudit(root) {
  const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const report = verifyCollectionEditorial(
    read('data/art.json'),
    readCollectionRegistries(root),
    readReviewedImportCatalog(root),
  );
  return {
    ...report,
    checkedIntroductions: report.uniqueIntroductions,
    legacyTopicsAwaitingIntroductionReview: report.topics - report.uniqueIntroductions,
  };
}

/** Every current and future published topic must carry checked collection writing. */
export function requiredCollectionIntroductions(catalog, registry, resolvedCatalog = catalog) {
  if (registry?.schema !== 1 || !registry.topics) throw Error('Invalid collection registry');
  const groups = new Map();
  for (const item of catalog.filter((item) => item.published && item.indexable)) {
    const group = groups.get(item.topic) ?? [];
    group.push(item);
    groups.set(item.topic, group);
  }
  const result = new Map(),
    texts = new Set(),
    templates = new Map();
  for (const [topic, items] of groups) {
    const record = registry.topics[topic];
    const text = validateCollectionCopy(topic, items, record);
    if (texts.has(text.toLowerCase())) throw Error('Repeated collection introduction: ' + topic);
    texts.add(text.toLowerCase());
    checkIntroductionTemplate(templates, topic, text);
    result.set(topic, text);
  }
  for (const topic of Object.keys(registry.topics))
    if (!groups.has(topic)) throw Error('Orphan collection review: ' + topic);
  const publicById = new Map(resolvedCatalog.map((item) => [item.id, item]));
  for (const [topic, items] of groups)
    validateCollectionParagraphs(
      topic,
      items.map((item) => publicById.get(item.id)),
      registry.topics[topic],
    );
  return result;
}

/** Read the committed per-collection records produced by concurrent importers. */
export function readCollectionRegistries(root = process.cwd()) {
  const directory = resolve(root, 'data/editorial'),
    topics = {};
  for (const name of readdirSync(directory)
    .filter((name) => name === 'collections.json' || /-collections?\.json$/.test(name))
    .sort()) {
    const registry = JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
    if (registry.schema !== 1 || !registry.topics)
      throw Error('Invalid collection review file: ' + name);
    for (const [topic, record] of Object.entries(registry.topics)) {
      if (topics[topic] && JSON.stringify(topics[topic]) !== JSON.stringify(record))
        throw Error('Conflicting collection reviews: ' + topic);
      topics[topic] = record;
    }
  }
  return { schema: 1, topics };
}

export function readRequiredCollectionIntroductions(
  catalog,
  root = process.cwd(),
  resolvedCatalog = catalog,
) {
  return requiredCollectionIntroductions(catalog, readCollectionRegistries(root), resolvedCatalog);
}

export function readRequiredCollectionParagraphs(
  catalog,
  root = process.cwd(),
  resolvedCatalog = catalog,
) {
  const registry = readCollectionRegistries(root);
  requiredCollectionIntroductions(catalog, registry, resolvedCatalog);
  return new Map(
    Object.entries(registry.topics).map(([topic, record]) => [topic, record.paragraphs]),
  );
}

export function readCollectionPresentation(catalog, resolvedCatalog, root = process.cwd()) {
  const registry = readCollectionRegistries(root);
  return {
    summaries: requiredCollectionIntroductions(catalog, registry, resolvedCatalog),
    paragraphs: new Map(
      Object.entries(registry.topics).map(([topic, record]) => [topic, record.paragraphs]),
    ),
  };
}
