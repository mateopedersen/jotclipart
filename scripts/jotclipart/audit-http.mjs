// Read-only HTTP acceptance audit. No publication, source mutation or old-host requests.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { resolve, dirname, join, basename } from 'node:path';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brand } from '../../src/lib/brand.mjs';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';

const { decodeHTML, decodeHTMLAttribute } = createRequire(
  import.meta.resolve('astro/package.json'),
)('entities');
const TOOL_FILE = fileURLToPath(import.meta.url);
const HEX = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const MAX_BODY = 2 * 1024 * 1024;
const REQUIRED = [
  'catalog-content-map.jsonl.gz',
  'catalog-topic-map.jsonl.gz',
  'catalog-collection-map.jsonl.gz',
  'catalog-canonical-paths.txt',
  'catalog-legacy-artwork-paths.txt',
  'catalog-legacy-topic-paths.txt',
  'catalog-legacy-topic-and-download-map.json',
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const textHash = (value) => {
  must(typeof value === 'string', 'MISSING_TEXT_VALUE');
  return sha(Buffer.from(value));
};
const canonicalJSON = (value) => JSON.stringify(value);
export class AuditFault extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'AuditFault';
    this.code = code;
    this.details = details;
  }
}
function must(condition, code, details) {
  if (!condition) throw new AuditFault(code, details);
}
function equalText(actual, expected, code, field) {
  must(actual === expected, code, {
    field,
    expectedSHA256: textHash(String(expected)),
    actualSHA256: textHash(String(actual)),
  });
}
export function auditOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AuditFault('INVALID_AUDIT_ORIGIN');
  }
  const host = url.hostname;
  must(
    url.origin === value &&
      url.protocol === 'https:' &&
      !url.port &&
      (host === 'jotclipart.com' ||
        host === 'preview.jotclipart.com' ||
        host === 'jotclipart.pages.dev' ||
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.jotclipart\.pages\.dev$/.test(host)),
    'INVALID_AUDIT_ORIGIN',
  );
  return url.origin;
}
function auditMode(origin, mode = 'production') {
  must(['production', 'preview'].includes(mode), 'INVALID_INDEXABILITY_MODE');
  auditOrigin(origin);
  must(mode !== 'preview' || origin !== brand.origin, 'INVALID_PREVIEW_POLICY_ORIGIN');
  return mode;
}
function normalizedPath(value) {
  must(
    typeof value === 'string' &&
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !/[\s?#\\]/.test(value) &&
      !value.includes('..') &&
      !value.includes('*'),
    'INVALID_MANIFEST_PATH',
  );
  const url = new URL(value, brand.origin);
  must(url.origin === brand.origin && url.pathname === value, 'NONCANONICAL_MANIFEST_PATH');
  return value;
}
async function fileDigest(file) {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    bytes += chunk.length;
    digest.update(chunk);
  }
  return { sha256: digest.digest('hex'), bytes };
}
async function jsonLines(file, consume) {
  const stream = fs.createReadStream(file).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let rows = 0,
    bytes = 0;
  for await (const line of lines) {
    bytes += Buffer.byteLength(line);
    must(line.length <= 1024 * 1024 && bytes <= 512 * 1024 * 1024, 'MANIFEST_EXPANSION_BOUND');
    if (line) {
      consume(JSON.parse(line));
      rows++;
    }
  }
  return rows;
}
function primaryCanonical(value) {
  const url = new URL(value);
  must(
    url.origin === brand.origin &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !url.port,
    'INVALID_NEW_CANONICAL',
  );
  return normalizedPath(url.pathname);
}

/** All source files are hash-pinned before any network request is possible. */
export async function loadHttpAuditInputs({
  auditReport,
  auditSHA256,
  snapshot,
  verifier,
  expectedRoot,
}) {
  must(HEX.test(auditSHA256 ?? '') && HEX.test(expectedRoot ?? ''), 'REQUIRED_SOURCE_PINS');
  const reportPath = resolve(auditReport),
    reportBytes = await fsp.readFile(reportPath);
  equalText(sha(reportBytes), auditSHA256, 'AUDIT_REPORT_SHA_MISMATCH', 'auditReport');
  const report = JSON.parse(reportBytes),
    directory = dirname(reportPath);
  must(
    report.status === 'OFFLINE_SIGNED_CONTENT_URL_ASSET_IDENTITY_AUDIT_PASSED' &&
      report.signatureVerified === true &&
      report.root === expectedRoot &&
      report.identity?.unreconciledAssetReferences === 0,
    'UNVERIFIED_SOURCE_AUDIT',
  );
  const snapshotBytes = await fsp.readFile(resolve(snapshot));
  const signed = JSON.parse(snapshotBytes),
    configBytes = await fsp.readFile(resolve(verifier));
  const config = JSON.parse(configBytes),
    selected = config.activeKey ?? 'catalog/active.json';
  must(
    HEX.test(config.publicKeyHex ?? '') && HEX.test(signed.authorization?.abiSHA256 ?? ''),
    'INVALID_SOURCE_VERIFIER',
  );
  const verified = await captureProductionSnapshot(
    {
      get: async (key) => {
        must(key === selected, 'UNEXPECTED_SOURCE_POINTER');
        return { size: snapshotBytes.length, json: async () => JSON.parse(snapshotBytes) };
      },
    },
    {
      ...config,
      publicKey: Buffer.from(config.publicKeyHex, 'hex'),
      abiSHA256: signed.authorization.abiSHA256,
    },
  );
  must(
    verified.authorizationVerified &&
      verified.rootSHA256 === expectedRoot &&
      signed.revision === report.revision,
    'SIGNED_ROOT_DIFFERS',
  );
  const pins = new Map();
  must(Array.isArray(report.outputChecksums), 'MISSING_OUTPUT_PINS');
  for (const entry of report.outputChecksums) {
    must(
      /^[a-zA-Z0-9._-]+$/.test(entry.file) &&
        !pins.has(entry.file) &&
        HEX.test(entry.sha256) &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes > 0,
      'INVALID_OUTPUT_PIN',
    );
    const file = join(directory, entry.file),
      stat = await fsp.lstat(file);
    must(stat.isFile() && !stat.isSymbolicLink(), 'INVALID_MANIFEST_FILE');
    const actual = await fileDigest(file);
    must(actual.bytes === entry.bytes && actual.sha256 === entry.sha256, 'MANIFEST_SHA_MISMATCH', {
      file: entry.file,
    });
    pins.set(entry.file, { ...entry, path: file });
  }
  for (const file of REQUIRED) must(pins.has(file), 'REQUIRED_MANIFEST_ABSENT', { file });
  const canonicalPaths = (await fsp.readFile(pins.get('catalog-canonical-paths.txt').path, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizedPath);
  const canonicalSet = new Set(canonicalPaths);
  must(
    canonicalSet.size === canonicalPaths.length &&
      canonicalSet.size === report.identity.canonicalPages,
    'CANONICAL_INVENTORY_COUNT',
  );
  const expected = new Map();
  const add = (record) => {
    const path = primaryCanonical(record.newCanonical);
    must(canonicalSet.has(path) && !expected.has(path), 'CANONICAL_METADATA_COLLISION', { path });
    must(
      typeof record.displayTitle === 'string' &&
        /^Free\s+\S/.test(record.displayTitle) &&
        !/^Free\s+Free\b/i.test(record.displayTitle) &&
        !/\bClipart\s+Clipart\b/i.test(record.displayTitle) &&
        HEX.test(record.descriptionSHA256 ?? ''),
      'INVALID_CATALOG_EXPECTATION',
      { path },
    );
    expected.set(path, { ...record, path });
  };
  const counts = { art: 0, topic: 0, collection: 0 };
  const ids = new Set(),
    declaredLegacy = new Map();
  await jsonLines(pins.get('catalog-content-map.jsonl.gz').path, (record) => {
    must(
      typeof record.id === 'string' &&
        !ids.has(record.id) &&
        record.published &&
        record.indexable &&
        HEX.test(record.altSHA256 ?? '') &&
        HEX.test(record.sourceRecordSHA256 ?? '') &&
        record.validation === 'OFFLINE_SIGNED_METADATA_IDENTITY_VERIFIED',
      'INVALID_ARTWORK_EXPECTATION',
    );
    must(
      (record.newDescriptionSHA256 ?? record.descriptionSHA256) === record.descriptionSHA256 &&
        (record.newAltSHA256 ?? record.altSHA256) === record.altSHA256,
      'SOURCE_COPY_CHANGED',
    );
    const assets = new Map();
    for (const asset of record.assets ?? []) {
      must(!assets.has(asset.role), 'DUPLICATE_ASSET_ROLE');
      assets.set(asset.role, asset);
    }
    for (const role of ['webp', 'pdf']) {
      const asset = assets.get(role);
      must(
        asset &&
          typeof asset.objectKey === 'string' &&
          asset.objectKey &&
          HEX.test(asset.sha256 ?? '') &&
          Number.isSafeInteger(asset.bytes) &&
          asset.bytes > 0,
        'UNVERIFIED_PRIMARY_ASSET',
        { id: record.id, role },
      );
    }
    const path = primaryCanonical(record.newCanonical);
    for (const legacy of record.legacyPaths ?? []) {
      normalizedPath(legacy);
      must(!declaredLegacy.has(legacy) && legacy !== path, 'LEGACY_SOURCE_COLLISION');
      declaredLegacy.set(legacy, path);
    }
    ids.add(record.id);
    counts.art++;
    add({
      kind: 'art',
      id: record.id,
      newCanonical: record.newCanonical,
      sourceTitle: record.sourceTitle,
      displayTitle: record.displayTitle,
      descriptionSHA256: record.descriptionSHA256,
      altSHA256: record.altSHA256,
      sourceRecordSHA256: record.sourceRecordSHA256,
      assets: Object.fromEntries(
        [...assets].filter(([role]) => ['webp', 'pdf', 'thumb'].includes(role)),
      ),
    });
  });
  for (const [kind, file] of [
    ['topic', 'catalog-topic-map.jsonl.gz'],
    ['collection', 'catalog-collection-map.jsonl.gz'],
  ])
    await jsonLines(pins.get(file).path, (record) => {
      must(record.kind === kind && record.descriptionUnchanged, 'INVALID_COLLECTION_EXPECTATION');
      add(record);
      counts[kind]++;
    });
  must(
    counts.art === report.identity.artworks &&
      counts.topic === report.identity.topics &&
      counts.collection === report.identity.collections,
    'SOURCE_FAMILY_COUNTS',
  );
  for (const path of canonicalPaths)
    if (!expected.has(path))
      expected.set(path, { kind: 'page', path, newCanonical: brand.origin + path });
  must(
    canonicalPaths.length - counts.art - counts.topic - counts.collection ===
      report.identity.otherPages,
    'AUXILIARY_PAGE_COUNT',
  );
  const legacy = [],
    legacySet = new Set();
  for (const [family, file, declaredCount] of [
    ['art', 'catalog-legacy-artwork-paths.txt', report.identity.legacyArtworkPaths],
    ['topic', 'catalog-legacy-topic-paths.txt', report.declaredLegacyTopicAliases],
  ]) {
    const lines = (await fsp.readFile(pins.get(file).path, 'utf8')).split(/\r?\n/).filter(Boolean);
    must(lines.length === declaredCount, 'LEGACY_INVENTORY_COUNT', { family });
    for (const line of lines) {
      const [source, target, code] = line.split('\t');
      normalizedPath(source);
      normalizedPath(target);
      must(
        !legacySet.has(source) && !canonicalSet.has(source) && canonicalSet.has(target),
        'LEGACY_MAPPING_CONFLICT',
      );
      if (family === 'art')
        must(declaredLegacy.get(source) === target, 'LEGACY_SOURCE_RECORD_DIFFERS');
      const status = code === undefined ? 301 : Number(code);
      must([301, 302, 307, 308].includes(status), 'INVALID_LEGACY_STATUS');
      legacy.push({ kind: 'legacy', family, path: source, target, status });
      legacySet.add(source);
    }
  }
  must(declaredLegacy.size === report.identity.legacyArtworkPaths, 'LEGACY_SOURCE_RECORD_COUNT');
  const rules = JSON.parse(
    await fsp.readFile(pins.get('catalog-legacy-topic-and-download-map.json').path),
  );
  for (const item of legacy.filter((item) => item.family === 'topic'))
    must(
      rules.rules?.some(
        (rule) =>
          rule.sourcePath === item.path &&
          rule.targetPath === item.target &&
          rule.status === item.status,
      ),
      'LEGACY_RULE_DIFFERS',
    );
  return {
    report,
    auditSHA256,
    root: verified.rootSHA256,
    revision: signed.revision,
    snapshotSHA256: sha(snapshotBytes),
    verifierSHA256: sha(configBytes),
    pins,
    expected,
    canonicalPaths,
    legacy,
    declaredDownloadRule: rules.rules?.find((rule) => rule.sourcePath === '/download/*') ?? null,
  };
}

// A bounded tokenizer, not a browser renderer. Raw script/style/title content is
// consumed separately so apparent HTML inside JavaScript cannot spoof metadata.
export function inspectDocument(html) {
  const doc = {
    titles: [],
    h1: [],
    meta: [],
    links: [],
    images: [],
    anchors: [],
    scripts: [],
    resources: [],
  };
  const stack = [];
  let position = 0,
    tags = 0,
    heading = null;
  const voidTags = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  const addText = (text) => {
    if (heading !== null) heading += decodeHTML(text);
  };
  while (position < html.length) {
    const open = html.indexOf('<', position);
    if (open < 0) {
      addText(html.slice(position));
      break;
    }
    addText(html.slice(position, open));
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      must(end >= 0, 'MALFORMED_HTML_COMMENT');
      position = end + 3;
      continue;
    }
    let end = open + 1,
      quote = '';
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    must(end < html.length, 'MALFORMED_HTML_TAG');
    const token = html.slice(open + 1, end);
    position = end + 1;
    if (/^[!?]/.test(token)) continue;
    const match = /^\s*(\/)?\s*([a-zA-Z][\w:-]*)/.exec(token);
    if (!match) {
      addText('<');
      position = open + 1;
      continue;
    }
    const name = match[2].toLowerCase();
    must(++tags <= 100000, 'HTML_TAG_BOUND');
    if (match[1]) {
      if (name === 'h1' && heading !== null) {
        doc.h1.push(heading);
        heading = null;
      }
      const index = stack.findLastIndex((entry) => entry.name === name);
      if (index >= 0) stack.length = index;
      continue;
    }
    const attrs = {};
    const rest = token.slice(match[0].length);
    const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const attr of rest.matchAll(attrPattern)) {
      const key = attr[1].toLowerCase();
      must(!Object.hasOwn(attrs, key), 'DUPLICATE_HTML_ATTRIBUTE');
      attrs[key] = decodeHTMLAttribute(attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const inHead = stack.some((entry) => entry.name === 'head');
    const inert = stack.some((entry) => entry.name === 'template');
    if (['script', 'style', 'title', 'textarea'].includes(name)) {
      const closePattern = new RegExp('</' + name + '\\s*>', 'gi');
      closePattern.lastIndex = position;
      const close = closePattern.exec(html);
      must(close, 'UNCLOSED_RAW_HTML_ELEMENT', { field: name });
      const text = html.slice(position, close.index);
      position = close.index + close[0].length;
      if (name === 'title' && inHead && !inert) doc.titles.push(decodeHTML(text));
      if (name === 'script' && !inert) {
        doc.scripts.push({ attrs, text });
        if (attrs.src) doc.resources.push(attrs.src);
      }
      continue;
    }
    if (name === 'h1' && !inert) {
      must(heading === null, 'NESTED_H1');
      heading = '';
    }
    if (name === 'meta' && inHead && !inert) doc.meta.push(attrs);
    if (name === 'link' && !inert) {
      if (inHead) doc.links.push(attrs);
      if (/\b(?:stylesheet|preload|modulepreload)\b/.test(attrs.rel ?? '') && attrs.href)
        doc.resources.push(attrs.href);
    }
    if (name === 'img' && !inert) {
      doc.images.push({ attrs, ancestorIDs: stack.map((entry) => entry.attrs.id).filter(Boolean) });
      if (attrs.src) doc.resources.push(attrs.src);
    }
    if (name === 'a' && !inert) doc.anchors.push(attrs);
    if (!voidTags.has(name) && !/\/\s*$/.test(token)) stack.push({ name, attrs });
  }
  must(heading === null, 'UNCLOSED_H1');
  return doc;
}
const headingText = (text) => text.replace(/\s+/g, ' ').trim();
function oneMeta(doc, key, property = false) {
  const found = doc.meta.filter(
    (attrs) => (property ? attrs.property : attrs.name)?.toLowerCase() === key,
  );
  must(found.length === 1 && typeof found[0].content === 'string', 'METADATA_CARDINALITY', {
    field: key,
  });
  return found[0].content;
}
function schemaNodes(doc) {
  const nodes = [];
  let count = 0;
  const visit = (value, depth = 0) => {
    must(depth <= 32 && ++count <= 100000, 'SCHEMA_EXPANSION_BOUND');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (value['@type']) nodes.push(value);
    for (const child of Object.values(value))
      if (child && typeof child === 'object') visit(child, depth + 1);
  };
  for (const script of doc.scripts)
    if (script.attrs.type?.toLowerCase() === 'application/ld+json') {
      let parsed;
      try {
        parsed = JSON.parse(script.text);
      } catch {
        throw new AuditFault('INVALID_JSONLD');
      }
      visit(parsed);
    }
  return nodes;
}
const hasType = (node, kind) =>
  node['@type'] === kind || (Array.isArray(node['@type']) && node['@type'].includes(kind));
function exactAsset(value, asset, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AuditFault('INVALID_PUBLIC_ASSET', { field });
  }
  let key;
  try {
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new AuditFault('INVALID_ASSET_ENCODING', { field });
  }
  must(
    url.origin === brand.assetsOrigin &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      key === asset.objectKey,
    'PUBLIC_ASSET_KEY_DIFFERS',
    { field, expectedKeySHA256: textHash(asset.objectKey), actualKeySHA256: textHash(key) },
  );
}
function validateCSP(doc, headers) {
  const policy = headers.get('content-security-policy');
  must(policy, 'MISSING_CSP');
  const script = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => /^script-src\s/i.test(part));
  must(script && !script.includes("'unsafe-inline'"), 'UNSAFE_SCRIPT_CSP');
  const authorized = new Set(script.split(/\s+/).slice(1));
  for (const entry of doc.scripts) {
    if (
      Object.hasOwn(entry.attrs, 'src') ||
      !entry.text.trim() ||
      /^application\/(?:ld\+)?json$/i.test(entry.attrs.type ?? '')
    )
      continue;
    const digest = createHash('sha256').update(entry.text).digest('base64');
    must(authorized.has("'sha256-" + digest + "'"), 'INLINE_CSP_HASH_DIFFERS');
  }
}
function catalogHeading(expected) {
  return (
    expected.displayTitle +
    (expected.kind === 'collection'
      ? (/\bClipart$/i.test(expected.displayTitle) ? '' : ' Clipart') + ' Collection'
      : '')
  );
}
function validateCatalogOG(doc, expected) {
  const image = oneMeta(doc, 'og:image', true);
  let url;
  try {
    url = new URL(image);
  } catch {
    throw new AuditFault('INVALID_CATALOG_OG_URL');
  }
  const prefix = `/og/catalog/${expected.kind}/${encodeURIComponent(expected.id)}/`;
  must(
    url.origin === brand.origin &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === image &&
      url.pathname.startsWith(prefix) &&
      /^[a-f0-9]{64}\.png$/.test(url.pathname.slice(prefix.length)),
    'CATALOG_OG_IDENTITY_DIFFERS',
  );
  equalText(
    oneMeta(doc, 'og:image:secure_url', true),
    image,
    'CATALOG_OG_URL_DIFFERS',
    'og:image:secure_url',
  );
  equalText(oneMeta(doc, 'twitter:image'), image, 'CATALOG_OG_URL_DIFFERS', 'twitter:image');
  equalText(
    oneMeta(doc, 'og:image:type', true),
    'image/png',
    'CATALOG_OG_FORMAT_DIFFERS',
    'og:image:type',
  );
  equalText(
    oneMeta(doc, 'og:image:width', true),
    '1200',
    'CATALOG_OG_SIZE_DIFFERS',
    'og:image:width',
  );
  equalText(
    oneMeta(doc, 'og:image:height', true),
    '630',
    'CATALOG_OG_SIZE_DIFFERS',
    'og:image:height',
  );
  const alt = catalogHeading(expected) + ' — JotClipart';
  for (const field of ['og:image:alt', 'twitter:image:alt'])
    equalText(oneMeta(doc, field, field.startsWith('og:')), alt, 'CATALOG_OG_ALT_DIFFERS', field);
  return { kind: expected.kind, id: expected.id, digest: url.pathname.slice(prefix.length, -4) };
}
export function validateCanonicalHTML({
  html,
  headers,
  expected,
  origin,
  root,
  revision,
  mode = 'production',
}) {
  mode = auditMode(origin, mode);
  must(
    headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/html',
    'WRONG_HTML_MIME',
  );
  equalText(headers.get('x-uc-snapshot'), root, 'PAGE_ROOT_DIFFERS', 'x-uc-snapshot');
  equalText(headers.get('x-uc-revision'), revision, 'PAGE_REVISION_DIFFERS', 'x-uc-revision');
  const doc = inspectDocument(html),
    canonical = doc.links.filter((item) =>
      item.rel?.toLowerCase().split(/\s+/).includes('canonical'),
    );
  must(canonical.length === 1, 'CANONICAL_CARDINALITY');
  equalText(canonical[0].href, expected.newCanonical, 'CANONICAL_DIFFERS', 'canonical');
  equalText(oneMeta(doc, 'build-revision'), revision, 'PAGE_REVISION_DIFFERS', 'build-revision');
  const robots = [
    ...doc.meta
      .filter((item) => ['robots', 'googlebot', 'bingbot'].includes(item.name?.toLowerCase()))
      .map((item) => item.content ?? ''),
  ];
  must(
    robots.every((value) => !/\b(?:noindex|none)\b/i.test(value)) &&
      (mode === 'preview' || !/\b(?:noindex|none)\b/i.test(headers.get('x-robots-tag') ?? '')),
    'INDEXABLE_PAGE_NOINDEX',
  );
  validateCSP(doc, headers);
  equalText(oneMeta(doc, 'og:site_name', true), brand.name, 'SITE_BRAND_DIFFERS', 'og:site_name');
  for (const value of doc.resources) {
    const url = new URL(value, origin);
    must(
      ![
        'ultraclipart.com',
        'www.ultraclipart.com',
        'assets.ultraclipart.com',
        'ultraclipart.pages.dev',
      ].includes(url.hostname) && !url.hostname.endsWith('.ultraclipart.pages.dev'),
      'OLD_RESOURCE_DEPENDENCY',
    );
  }
  const checks = [
    'canonical',
    'indexability',
    'snapshot',
    'revision',
    'CSP',
    'site-brand',
    'resource-origins',
  ];
  if (mode === 'preview' && /\b(?:noindex|none)\b/i.test(headers.get('x-robots-tag') ?? ''))
    checks.push('preview-transport-noindex');
  if (expected.kind === 'page') return { checks };
  must(doc.h1.length === 1 && doc.titles.length === 1, 'TITLE_CARDINALITY');
  equalText(headingText(doc.h1[0]), headingText(expected.displayTitle), 'H1_DIFFERS', 'h1');
  const title = catalogHeading(expected) + ' | JotClipart';
  for (const [field, value] of [
    ['title', doc.titles[0]],
    ['og:title', oneMeta(doc, 'og:title', true)],
    ['twitter:title', oneMeta(doc, 'twitter:title')],
  ]) {
    equalText(headingText(value), headingText(title), 'SEO_TITLE_DIFFERS', field);
    must(
      /^Free\s+\S/.test(value) &&
        !/^Free\s+Free\b/i.test(value) &&
        !/\bClipart\s+Clipart\b/i.test(value),
      'TITLE_PREFIX_DUPLICATION',
      { field },
    );
  }
  for (const [field, value] of [
    ['description', oneMeta(doc, 'description')],
    ['og:description', oneMeta(doc, 'og:description', true)],
    ['twitter:description', oneMeta(doc, 'twitter:description')],
  ])
    equalText(textHash(value), expected.descriptionSHA256, 'DESCRIPTION_DIFFERS', field);
  checks.push('Free-H1', 'SEO-titles', 'source-description');
  const og = validateCatalogOG(doc, expected);
  checks.push('new-branded-OG-identity', 'OG-PNG1200x630', 'OG-secure-Twitter-URL', 'OG-title-ALT');
  const nodes = schemaNodes(doc);
  for (const node of nodes.filter((node) => hasType(node, 'BreadcrumbList'))) {
    for (const item of node.itemListElement ?? [])
      if (typeof item.item === 'string' && item.item.startsWith('http'))
        must(new URL(item.item).origin === brand.origin, 'BREADCRUMB_ORIGIN_DIFFERS');
  }
  if (expected.kind === 'art') {
    const image = nodes.filter(
      (node) =>
        hasType(node, 'ImageObject') &&
        node.representativeOfPage === true &&
        node['@id'] === expected.newCanonical + '#image',
    );
    must(image.length === 1, 'PRIMARY_IMAGE_SCHEMA_CARDINALITY');
    const primary = image[0];
    equalText(primary.name, expected.displayTitle, 'SCHEMA_NAME_DIFFERS', 'ImageObject.name');
    equalText(primary.url, expected.newCanonical, 'SCHEMA_CANONICAL_DIFFERS', 'ImageObject.url');
    equalText(
      primary.mainEntityOfPage,
      expected.newCanonical,
      'SCHEMA_CANONICAL_DIFFERS',
      'mainEntityOfPage',
    );
    equalText(
      textHash(primary.description),
      expected.descriptionSHA256,
      'DESCRIPTION_DIFFERS',
      'ImageObject.description',
    );
    equalText(textHash(primary.caption), expected.altSHA256, 'ALT_DIFFERS', 'ImageObject.caption');
    exactAsset(primary.contentUrl, expected.assets.webp, 'ImageObject.contentUrl');
    exactAsset(
      primary.thumbnailUrl,
      expected.assets.thumb ?? expected.assets.webp,
      'ImageObject.thumbnailUrl',
    );
    const hero = doc.images.filter((image) => image.ancestorIDs.includes('art-preview'));
    must(hero.length === 1, 'PRIMARY_IMAGE_CARDINALITY');
    exactAsset(hero[0].attrs.src, expected.assets.webp, 'primary-image-src');
    equalText(textHash(hero[0].attrs.alt), expected.altSHA256, 'ALT_DIFFERS', 'primary-image-alt');
    for (const role of ['webp', 'pdf'])
      must(
        doc.anchors.some((link) => {
          try {
            exactAsset(link.href, expected.assets[role], role);
            return true;
          } catch {
            return false;
          }
        }),
        'ORIGINAL_DOWNLOAD_LINK_ABSENT',
        { role },
      );
    const records = doc.scripts.filter(
      (script) =>
        script.attrs.type === 'application/json' &&
        Object.hasOwn(script.attrs, 'data-download-record'),
    );
    must(records.length === 1, 'DOWNLOAD_RECORD_CARDINALITY');
    let record;
    try {
      record = JSON.parse(records[0].text);
    } catch {
      throw new AuditFault('INVALID_DOWNLOAD_RECORD');
    }
    equalText(record.id, expected.id, 'ARTWORK_ID_DIFFERS', 'download.id');
    equalText(
      records[0].attrs['data-download-id'],
      expected.id,
      'ARTWORK_ID_DIFFERS',
      'data-download-id',
    );
    equalText(record.title, expected.sourceTitle, 'SOURCE_TITLE_MUTATED', 'download.title');
    equalText(textHash(record.alt), expected.altSHA256, 'ALT_DIFFERS', 'download.alt');
    for (const role of ['webp', 'pdf']) {
      exactAsset(record[role], expected.assets[role], 'download.' + role);
      equalText(
        record.download?.files?.[role]?.sha256,
        expected.assets[role].sha256,
        'DOWNLOAD_SHA_DIFFERS',
        role,
      );
      must(
        record.download?.files?.[role]?.bytes === expected.assets[role].bytes,
        'DOWNLOAD_BYTE_COUNT_DIFFERS',
        { role },
      );
    }
    checks.push(
      'artwork-ID',
      'original-object-keys',
      'download-SHA-and-bytes',
      'source-ALT',
      'primary-ImageObject',
    );
  } else {
    const schemas = nodes.filter(
      (node) => hasType(node, 'CollectionPage') && node.url === expected.newCanonical,
    );
    if (expected.kind === 'topic') {
      must(schemas.length === 1, 'TOPIC_SCHEMA_CARDINALITY');
      equalText(
        schemas[0].name,
        expected.displayTitle,
        'SCHEMA_NAME_DIFFERS',
        'CollectionPage.name',
      );
      must(
        schemas[0].mainEntity?.numberOfItems === expected.artworkCount,
        'TOPIC_ARTWORK_COUNT_DIFFERS',
      );
      checks.push('topic-schema-ID-name-count');
    } else if (schemas.length) {
      must(schemas.length === 1, 'COLLECTION_SCHEMA_CARDINALITY');
      equalText(
        schemas[0].name,
        expected.displayTitle,
        'SCHEMA_NAME_DIFFERS',
        'CollectionPage.name',
      );
      checks.push('collection-schema-name');
    }
  }
  return { checks, og };
}

export function createRateLimiter({
  requestsPerSecond = 40,
  now = () => performance.now(),
  delay = sleep,
} = {}) {
  must(
    Number.isInteger(requestsPerSecond) && requestsPerSecond >= 1 && requestsPerSecond <= 40,
    'RATE_BOUND',
  );
  let next = 0;
  return async () => {
    const current = now(),
      slot = Math.max(current, next);
    next = slot + 1000 / requestsPerSecond;
    if (slot > current) await delay(slot - current);
  };
}
async function boundedBody(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel('HTTP audit body bound');
        throw new AuditFault('BODY_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}
export async function fetchBounded(
  url,
  {
    fetcher = fetch,
    throttle = async () => {},
    delay = sleep,
    maxBodyBytes = MAX_BODY,
    readBody = true,
    accept = 'text/html',
    attempts = 3,
  } = {},
) {
  must(
    Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0 && maxBodyBytes <= MAX_BODY,
    'BODY_LIMIT_BOUND',
  );
  must(Number.isInteger(attempts) && attempts >= 1 && attempts <= 3, 'RETRY_BOUND');
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await throttle();
    const start = performance.now();
    try {
      const response = await fetcher(url, {
        redirect: 'manual',
        method: 'GET',
        headers: { Accept: accept, 'User-Agent': 'JotClipart-ReadOnly-Migration-Audit/1' },
        signal: AbortSignal.timeout(30000),
      });
      const ttfbMs = Math.round(performance.now() - start);
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        last = new AuditFault('TRANSIENT_HTTP_EXHAUSTED', { status: response.status });
        if (attempt < attempts) {
          const declared = Number(response.headers.get('retry-after'));
          await delay(
            Math.min(
              5000,
              Number.isFinite(declared) && declared > 0
                ? declared * 1000
                : 200 * 2 ** (attempt - 1),
            ),
          );
          continue;
        }
        throw last;
      }
      let body = Buffer.alloc(0);
      if (readBody) body = await boundedBody(response, maxBodyBytes);
      else await response.body?.cancel();
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      } catch {
        throw new AuditFault('INVALID_HTTP_UTF8');
      }
      return {
        status: response.status,
        headers: response.headers,
        text,
        bytes: body.length,
        sha256: sha(body),
        attempts: attempt,
        ttfbMs,
        totalMs: Math.round(performance.now() - start),
      };
    } catch (error) {
      if (error instanceof AuditFault) throw error;
      last = new AuditFault('TRANSPORT_EXHAUSTED', { errorClass: error.name ?? 'Error' });
      if (attempt === attempts) throw last;
      await delay(200 * 2 ** (attempt - 1));
    }
  }
  throw last;
}

function summaryCounts(results, jobs) {
  const counts = {
    planned: jobs.length,
    completed: results.size,
    passed: 0,
    failed: 0,
    canonical: 0,
    legacy: 0,
    negative: 0,
  };
  for (const value of results.values()) {
    counts[value.ok ? 'passed' : 'failed']++;
    counts[value.kind]++;
  }
  return counts;
}
async function atomicJSON(file, value) {
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  await fsp.rename(temporary, file);
}
async function protectedOutput(directory) {
  const work = resolve('work');
  await fsp.mkdir(work, { recursive: true });
  const realWork = await fsp.realpath(work),
    target = resolve(directory);
  must(target.startsWith(work + '/'), 'OUTPUT_OUTSIDE_WORK');
  await fsp.mkdir(target, { recursive: true });
  must((await fsp.realpath(target)).startsWith(realWork + '/'), 'OUTPUT_SYMLINK_ESCAPE');
  return target;
}
async function outputLock(directory, contract) {
  const file = join(directory, 'audit.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fsp.open(file, 'wx', 0o600);
      const bytes = JSON.stringify({ pid: process.pid, host: hostname(), contract });
      await handle.writeFile(bytes);
      await handle.close();
      return async () => {
        equalText(await fsp.readFile(file, 'utf8'), bytes, 'AUDIT_LOCK_CHANGED', 'lock');
        await fsp.unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = JSON.parse(await fsp.readFile(file, 'utf8'));
      let alive = true;
      if (old.host === hostname() && Number.isSafeInteger(old.pid)) {
        try {
          process.kill(old.pid, 0);
        } catch (reason) {
          if (reason.code === 'ESRCH') alive = false;
        }
      }
      must(!alive && old.contract === contract && attempt === 0, 'AUDIT_ALREADY_LOCKED');
      await fsp.rename(file, file + '.stale.' + randomUUID());
    }
  }
  throw new AuditFault('AUDIT_ALREADY_LOCKED');
}
async function restoreLedger(file, contract, jobs) {
  const results = new Map();
  let chain = contract,
    repairedBytes = 0,
    exists = true;
  try {
    await fsp.access(file);
  } catch (error) {
    if (error.code === 'ENOENT') exists = false;
    else throw error;
  }
  if (!exists) return { results, chain, repairedBytes };
  const stat = await fsp.stat(file);
  if (stat.size) {
    const handle = await fsp.open(file, 'r+');
    try {
      const tail = Buffer.alloc(Math.min(65536, stat.size));
      await handle.read(tail, 0, tail.length, stat.size - tail.length);
      if (tail.at(-1) !== 10) {
        const boundary = tail.lastIndexOf(10),
          partial = tail.subarray(boundary + 1);
        must(boundary >= 0 || stat.size === tail.length, 'LEDGER_ROW_BOUND');
        await fsp.writeFile(file + '.incomplete.' + randomUUID(), partial, { mode: 0o600 });
        repairedBytes = partial.length;
        await handle.truncate(stat.size - partial.length);
      }
    } finally {
      await handle.close();
    }
  }
  const lines = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    must(line.length <= 8192, 'LEDGER_ROW_BOUND');
    const row = JSON.parse(line),
      { hash, ...signed } = row;
    must(
      row.contract === contract &&
        row.prev === chain &&
        hash === sha(Buffer.from(canonicalJSON(signed))),
      'LEDGER_INTEGRITY',
    );
    must(
      Number.isSafeInteger(row.seq) &&
        jobs[row.seq]?.path === row.path &&
        jobs[row.seq]?.kind === row.kind &&
        typeof row.ok === 'boolean',
      'LEDGER_JOB_DIFFERS',
    );
    results.set(row.seq, row);
    chain = hash;
  }
  return { results, chain, repairedBytes };
}

/** Default use is the CLI dry run. Actual network execution requires --run. */
export async function runHttpAudit(options) {
  const origin = auditOrigin(options.origin);
  const mode = auditMode(origin, options.mode);
  must(SHA1.test(options.expectedControlRevision ?? ''), 'EXPECTED_CONTROL_REVISION_REQUIRED');
  const input = await loadHttpAuditInputs(options);
  const concurrency = options.concurrency ?? 8;
  must(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8, 'CONCURRENCY_BOUND');
  const rps = options.requestsPerSecond ?? 40;
  must(Number.isInteger(rps) && rps >= 1 && rps <= 40, 'RATE_BOUND');
  const policy = {
    version: 'jotclipart-http-acceptance-v2',
    toolSHA256: sha(await fsp.readFile(TOOL_FILE)),
    origin,
    mode,
    previewTransportNoindexAllowed: mode === 'preview',
    auditSHA256: input.auditSHA256,
    root: input.root,
    revision: input.revision,
    snapshotSHA256: input.snapshotSHA256,
    verifierSHA256: input.verifierSHA256,
    expectedControlRevision: options.expectedControlRevision,
    maximumBodyBytes: MAX_BODY,
  };
  const contract = sha(Buffer.from(JSON.stringify(policy)));
  const jobs = input.canonicalPaths
    .map((path) => ({ kind: 'canonical', path }))
    .concat(input.legacy);
  for (const prefix of ['/art/', '/clipart/', '/collection/', '/edit/', '/download/']) {
    const path = prefix + 'migration-audit-unknown-' + contract.slice(0, 16) + '/';
    must(
      !input.expected.has(path) && !input.legacy.some((item) => item.path === path),
      'NEGATIVE_ROUTE_COLLISION',
    );
    jobs.push({ kind: 'negative', path });
  }
  if (options.dryRun)
    return {
      status: 'HTTP_AUDIT_DRY_RUN_NO_REQUESTS',
      ...policy,
      contract,
      canonical: input.canonicalPaths.length,
      legacy: input.legacy.length,
      negative: 5,
      planned: jobs.length,
      liveHTTPVerified: false,
      declaredDownloadWildcardEnumerated: false,
    };
  const maximumJobs = options.maxJobs ?? Infinity;
  must(
    maximumJobs === Infinity || (Number.isSafeInteger(maximumJobs) && maximumJobs > 0),
    'JOB_LIMIT_BOUND',
  );
  const directory = await protectedOutput(options.output),
    release = await outputLock(directory, contract);
  let networkRequests = 0;
  const transport = options.fetcher ?? fetch;
  const fetcher = (...args) => {
    networkRequests++;
    return transport(...args);
  };
  const delay = options.delay ?? sleep;
  const throttle = createRateLimiter({ requestsPerSecond: rps, delay });
  const request = (path, configuration = {}) =>
    fetchBounded(origin + path, { fetcher, throttle, delay, ...configuration });
  const started = Date.now(),
    ledgerFile = join(directory, 'evidence.jsonl');
  let timer,
    writer = Promise.resolve(),
    log,
    claimed = 0,
    cursor = 0,
    halted = false,
    latestControl,
    controlBefore;
  const runID = randomUUID();
  const interrupt = () => {
    halted = true;
  };
  const progress = options.onProgress ?? (() => {});
  let state,
    chain,
    lastCheckpoint = 0;
  async function control() {
    const response = await request('/delivery-release.json', {
      accept: 'application/json',
      maxBodyBytes: 65536,
    });
    must(response.status === 200, 'CONTROL_HTTP_STATUS', { status: response.status });
    must(
      response.headers.get('content-type')?.split(';')[0].trim() === 'application/json',
      'CONTROL_MIME',
    );
    let identity;
    try {
      identity = JSON.parse(response.text);
    } catch {
      throw new AuditFault('CONTROL_INVALID_JSON');
    }
    must(
      identity.verifiedRoot === input.root &&
        identity.controlRevision === options.expectedControlRevision &&
        identity.renderedRevision === input.revision,
      'CONTROL_IDENTITY_CHANGED',
    );
    return {
      root: identity.verifiedRoot,
      controlRevision: identity.controlRevision,
      renderedRevision: identity.renderedRevision,
      sha256: response.sha256,
      at: new Date().toISOString(),
    };
  }
  async function checkpoint(force = false) {
    if (!force && state.results.size % 25 && Date.now() - lastCheckpoint < 2000) return;
    lastCheckpoint = Date.now();
    await atomicJSON(join(directory, 'checkpoint.json'), {
      contract,
      policy,
      ...summaryCounts(state.results, jobs),
      chain,
      latestControl,
      repairedPartialBytes: state.repairedBytes,
      at: new Date().toISOString(),
    });
  }
  function evidence(seq, result) {
    writer = writer.then(async () => {
      const row = {
        contract,
        seq,
        kind: jobs[seq].kind,
        path: jobs[seq].path,
        ...result,
        at: new Date().toISOString(),
        prev: chain,
      };
      const hash = sha(Buffer.from(JSON.stringify(row)));
      await log.writeFile(JSON.stringify({ ...row, hash }) + '\n');
      chain = hash;
      state.results.set(seq, { ...row, hash });
      await checkpoint();
    });
    return writer;
  }
  async function inspect(job) {
    if (job.kind === 'canonical') {
      const response = await request(job.path);
      must(response.status === 200, 'CANONICAL_HTTP_STATUS', { status: response.status });
      const checked = validateCanonicalHTML({
        html: response.text,
        headers: response.headers,
        expected: input.expected.get(job.path),
        origin,
        root: input.root,
        revision: input.revision,
        mode,
      });
      return {
        ok: true,
        status: response.status,
        bytes: response.bytes,
        sha256: response.sha256,
        attempts: response.attempts,
        ttfbMs: response.ttfbMs,
        totalMs: response.totalMs,
        cache: response.headers.get('x-uc-html-cache'),
        checks: checked.checks,
        ...(checked.og ? { og: checked.og } : {}),
      };
    }
    if (job.kind === 'negative') {
      const response = await request(job.path);
      must(response.status === 404, 'UNKNOWN_ROUTE_NOT_404', { status: response.status });
      return {
        ok: true,
        status: response.status,
        bytes: response.bytes,
        sha256: response.sha256,
        attempts: response.attempts,
      };
    }
    const query = '?audit_check=' + contract.slice(0, 12) + '&audit_value=a%20b&audit_value=c';
    const response = await request(job.path + query, { readBody: false });
    must(response.status === job.status, 'LEGACY_HTTP_STATUS', {
      status: response.status,
      expectedStatus: job.status,
    });
    const location = response.headers.get('location');
    must(location, 'LEGACY_LOCATION_ABSENT');
    const target = new URL(location, origin + job.path + query);
    must(
      target.origin === origin &&
        !target.username &&
        !target.password &&
        !target.port &&
        !target.hash,
      'LEGACY_FOREIGN_REDIRECT',
    );
    must(target.pathname === job.target && target.pathname !== job.path, 'LEGACY_TARGET_OR_LOOP');
    equalText(target.search, query, 'LEGACY_QUERY_DROPPED', 'redirect query');
    const followed = await request(target.pathname + target.search);
    must(followed.status === 200, 'LEGACY_CHAIN_OR_TARGET_STATUS', { status: followed.status });
    const checked = validateCanonicalHTML({
      html: followed.text,
      headers: followed.headers,
      expected: input.expected.get(job.target),
      origin,
      root: input.root,
      revision: input.revision,
      mode,
    });
    return {
      ok: true,
      status: response.status,
      target: job.target,
      targetStatus: followed.status,
      hops: 1,
      queryPreserved: true,
      bytes: followed.bytes,
      sha256: followed.sha256,
      attempts: response.attempts + followed.attempts,
      checks: checked.checks,
      ...(checked.og ? { og: checked.og } : {}),
    };
  }
  try {
    const contractFile = join(directory, 'contract.json');
    if (fs.existsSync(contractFile))
      equalText(
        await fsp.readFile(contractFile, 'utf8'),
        JSON.stringify(policy) + '\n',
        'RESUME_CONTRACT_DIFFERS',
        'contract',
      );
    else await atomicJSON(contractFile, policy);
    must(!fs.existsSync(join(directory, 'invalidated-control.json')), 'CONTROL_EPOCH_INVALIDATED');
    state = await restoreLedger(ledgerFile, contract, jobs);
    chain = state.chain;
    log = await fsp.open(ledgerFile, 'a', 0o600);
    latestControl = controlBefore = await control();
    await fsp.appendFile(
      join(directory, 'control-events.jsonl'),
      JSON.stringify({ runID, contract, phase: 'before', ...controlBefore }) + '\n',
      { mode: 0o600 },
    );
    progress({ phase: 'start', ...summaryCounts(state.results, jobs), root: input.root, origin });
    timer = setInterval(() => {
      progress({
        phase: 'running',
        ...summaryCounts(state.results, jobs),
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
      });
    }, 30000);
    timer.unref();
    if (options.handleSignals !== false) {
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', interrupt);
    }
    const pending = jobs
      .map((job, seq) => seq)
      .filter(
        (seq) => !state.results.has(seq) || (options.retryFailures && !state.results.get(seq).ok),
      );
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (!halted && claimed < maximumJobs && cursor < pending.length) {
          const seq = pending[cursor++];
          claimed++;
          let result;
          try {
            result = await inspect(jobs[seq]);
          } catch (error) {
            if (!(error instanceof AuditFault))
              error = new AuditFault('UNEXPECTED_AUDIT_ERROR', {
                errorClass: error.name ?? 'Error',
              });
            result = { ok: false, issue: error.code, details: error.details };
          }
          await evidence(seq, result);
        }
      }),
    );
    await writer;
    latestControl = await control();
    await fsp.appendFile(
      join(directory, 'control-events.jsonl'),
      JSON.stringify({
        runID,
        contract,
        phase: 'after',
        ...latestControl,
        httpRequestsThisRun: networkRequests,
      }) + '\n',
      { mode: 0o600 },
    );
    await checkpoint(true);
    await log.sync();
    const counts = summaryCounts(state.results, jobs);
    const status = counts.failed
      ? 'HTTP_AUDIT_FAILED'
      : counts.completed === counts.planned
        ? 'HTTP_AUDIT_PASSED'
        : 'HTTP_AUDIT_PARTIAL';
    const summary = {
      status,
      ...policy,
      contract,
      ...counts,
      liveHTTPVerified: options.fetcher === undefined,
      transport: options.fetcher ? 'INJECTED_TEST_TRANSPORT' : 'NODE_FETCH_DEFAULT_TLS',
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      attemptedThisRun: claimed,
      httpRequestsThisRun: networkRequests,
      chain,
      repairedPartialBytes: state.repairedBytes,
      controlBefore,
      controlAfter: latestControl,
      sourceDescriptionScope: {
        art: 'exact meta/schema source hash',
        topic: 'exact meta hash; full schema summary not separately pinned',
        collection: 'exact source meta hash',
      },
      declaredDownloadWildcardEnumerated: false,
      mediaBodiesDownloaded: 0,
      ogImageBodiesDownloaded: 0,
      productionHTTPIndexabilityVerified:
        mode === 'production' &&
        origin === brand.origin &&
        status === 'HTTP_AUDIT_PASSED' &&
        options.fetcher === undefined,
      scope:
        'Pinned canonical HTML, concrete legacy paths with query preservation and one-hop target validation, and five unknown-route negatives. Separate browser and full asset acceptance gates remain.',
      at: new Date().toISOString(),
    };
    await atomicJSON(join(directory, 'summary.json'), summary);
    progress({ phase: 'finished', ...counts, status });
    return summary;
  } catch (error) {
    if (error.code === 'CONTROL_IDENTITY_CHANGED' && controlBefore)
      await atomicJSON(join(directory, 'invalidated-control.json'), {
        contract,
        runID,
        issue: error.code,
        at: new Date().toISOString(),
      });
    await atomicJSON(join(directory, 'summary.json'), {
      status: 'HTTP_AUDIT_STOPPED',
      contract,
      policy,
      issue: error.code ?? error.name,
      ...(state ? summaryCounts(state.results, jobs) : {}),
      at: new Date().toISOString(),
    });
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    try {
      await writer;
    } finally {
      try {
        if (log) {
          try {
            await log.sync();
          } finally {
            await log.close();
          }
        }
      } finally {
        await release();
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      'audit-report': { type: 'string' },
      'audit-sha256': { type: 'string' },
      snapshot: { type: 'string' },
      verifier: { type: 'string' },
      'expected-root': { type: 'string' },
      'expected-control-revision': { type: 'string' },
      origin: { type: 'string' },
      mode: { type: 'string' },
      output: { type: 'string' },
      run: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'max-jobs': { type: 'string' },
      concurrency: { type: 'string' },
      'requests-per-second': { type: 'string' },
      'retry-failures': { type: 'boolean' },
    },
  });
  const options = {
    auditReport: values['audit-report'],
    auditSHA256: values['audit-sha256'],
    snapshot: values.snapshot,
    verifier: values.verifier,
    expectedRoot: values['expected-root'],
    expectedControlRevision: values['expected-control-revision'],
    origin: values.origin,
    mode: values.mode,
    output: values.output,
    dryRun: !values.run || values['dry-run'],
    maxJobs: values['max-jobs'] === undefined ? Infinity : Number(values['max-jobs']),
    concurrency: values.concurrency === undefined ? 8 : Number(values.concurrency),
    requestsPerSecond:
      values['requests-per-second'] === undefined ? 40 : Number(values['requests-per-second']),
    retryFailures: Boolean(values['retry-failures']),
    onProgress: (value) => console.log(JSON.stringify(value)),
  };
  try {
    const result = await runHttpAudit(options);
    console.log(JSON.stringify(result));
    if (result.status === 'HTTP_AUDIT_FAILED') process.exitCode = 1;
    if (result.status === 'HTTP_AUDIT_PARTIAL') process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'HTTP_AUDIT_STOPPED',
        issue: error.code ?? error.name,
        details: error instanceof AuditFault ? error.details : {},
      }),
    );
    process.exitCode = 1;
  }
}
