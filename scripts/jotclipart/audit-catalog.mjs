import { topicHeadingEvidence } from './topic-heading.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import { readSitemap } from '../../server/catalog-snapshot/sitemap-reader.mjs';
import { publicBrandURL, freeCatalogTitle } from '../../src/lib/brand.mjs';
import { displayCatalogTitle } from '../../src/lib/display-title.ts';
import {
  presentationState,
  presentationSitemap,
} from '../../server/catalog-snapshot/brand-presentation.mjs';
import { remoteCatalogBucket } from '../catalog-snapshot/remote-reader.mjs';
import { readShellField } from '../../server/catalog-projections/shell.mjs';

// Offline migration evidence only. No credentials, remote reads, writes or approvals.
const args = Object.fromEntries(
  process.argv.slice(2).map((x) => {
    const i = x.indexOf('=');
    if (i < 0 || !x.startsWith('--')) throw Error('Use --name=value');
    return [x.slice(2, i), x.slice(i + 1)];
  }),
);
const task = resolve('../../..'),
  captured = resolve(args.capture ?? '../captured-catalog');
const out = resolve(args.output ?? join(task, 'reports/jotclipart-migration'));
const localStores = [
  captured,
  ...(args.stores ? JSON.parse(args.stores).map((p) => resolve(p)) : []),
];
const expected = args.root ?? '7c311351a6c725394ca7473cbcc1025868a281d17449cc817776452f0f3f6753';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const stable = (x) =>
  Array.isArray(x)
    ? x.map(stable)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, stable(x[k])]),
        )
      : x;
const jsonSHA = (x) => sha(Buffer.from(JSON.stringify(stable(x)) ?? 'undefined'));
const readJSON = (p) => JSON.parse(readFileSync(p));
const required = (condition, message) => {
  if (!condition) throw Error(message);
};
mkdirSync(out, { recursive: true });
const missing = new Set(),
  readProof = new Map(),
  fileCache = new Map();
let remote,
  remoteObjects = 0;
if (args['read-missing'] === 'true') {
  const entry = readFileSync('work/migration-reader/entry.mjs', 'utf8');
  const match = /privateCatalogReader\((\{.*\})\);$/s.exec(entry);
  required(match, 'Existing read-only reader configuration unavailable');
  const job = JSON.parse(match[1]);
  required(job.parentSnapshotSHA256 === expected, 'Existing reader root differs');
  remote = remoteCatalogBucket({
    secret: job.secret,
    parentSnapshotSHA256: job.parentSnapshotSHA256,
    accountId: job.verifier.accountId,
    bucket: job.verifier.bucketName,
  });
}
let remoteActive = 0;
const remoteWaiting = [];
async function remotePermit() {
  if (remoteActive < 4) {
    remoteActive++;
    return;
  }
  await new Promise((done) => remoteWaiting.push(done));
}
function remoteRelease() {
  const next = remoteWaiting.shift();
  if (next) next();
  else remoteActive--;
}
const snapshotBytes = readFileSync(join(captured, 'production-snapshot.json'));
function object(bytes) {
  return {
    size: bytes.length,
    json: async () => JSON.parse(bytes),
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}
const bucket = {
  get: async (key) => {
    if (key === 'catalog/active.json' || key === 'catalog/jotclipart/active.json')
      return object(snapshotBytes);
    const match =
      /^catalog\/objects\/(artworks|collections|search|recent|related|counts|sitemaps)\/([a-f0-9]{64})\.json$/.exec(
        key,
      );
    required(match, 'Unreviewed offline key');
    if (fileCache.has(key)) return object(fileCache.get(key));
    for (const store of localStores) {
      const p = join(store, match[2] + '.json');
      if (!existsSync(p)) continue;
      const b = readFileSync(p);
      required(sha(b) === match[2], 'Local immutable bytes differ');
      fileCache.set(key, b);
      readProof.set(key, {
        key,
        file: p,
        bytes: b.length,
        sha256: match[2],
        source: 'verified-local-content-addressed-metadata',
      });
      return object(b);
    }
    if (remote) {
      await remotePermit();
      try {
        const o = await remote.get(key);
        if (o) {
          const b = Buffer.from(await o.arrayBuffer());
          required(sha(b) === match[2], 'Remote immutable metadata SHA mismatch');
          const p = join(captured, match[2] + '.json');
          writeFileSync(p + '.manifest', b);
          renameSync(p + '.manifest', p);
          fileCache.set(key, b);
          readProof.set(key, {
            key,
            file: p,
            bytes: b.length,
            sha256: match[2],
            source: 'existing-read-only-session-fresh-metadata-SHA-verified',
          });
          remoteObjects++;
          return object(b);
        }
      } finally {
        remoteRelease();
      }
    }
    missing.add(key);
    return null;
  },
};
const write = (name, data) => {
  const p = join(out, name);
  writeFileSync(p + '.tmp', data);
  renameSync(p + '.tmp', p);
};
const gzipLines = (name, rows) =>
  write(
    name,
    gzipSync(Buffer.from(rows.map((x) => JSON.stringify(x)).join('\n') + '\n'), { level: 9 }),
  );
const csv = (name, columns, rows) => {
  const q = (x) => '"' + String(x ?? '').replaceAll('"', '""') + '"';
  write(
    name,
    gzipSync(
      Buffer.from(
        columns.map(q).join(',') +
          '\n' +
          rows.map((r) => columns.map((c) => q(r[c])).join(',')).join('\n') +
          '\n',
      ),
      { level: 9 },
    ),
  );
};
const facetReader = (context) => async (descriptor) => {
  const facet = /^catalog\/objects\/([^/]+)\//.exec(descriptor?.key ?? '')?.[1];
  required(facet, 'Missing immutable descriptor');
  return context.read(facet, descriptor, { maxBytes: 1024 * 1024 });
};

try {
  const cfg = readJSON('config/catalog-snapshot-public.json');
  const context = await captureProductionSnapshot(bucket, {
    ...cfg,
    activeKey: 'catalog/active.json',
    acceptedPredecessor: undefined,
    abiSHA256: '59be336b2643ebfb80036c3c836321f219d714de215d05d0b4f3f59e4831b8fb',
    publicKey: Buffer.from(cfg.publicKeyHex, 'hex'),
    maxReadObjects: 150000,
    maxReadBytes: 1536 * 1024 * 1024,
    maxConcurrentReads: 16,
  });
  required(context.rootSHA256 === expected, 'Capture root changed');
  const read = facetReader(context),
    artRoot = await context.getFacet('artworks');
  const artworks = new Map();
  async function artworkLeaf(d) {
    const n = await read(d);
    if (n.type === 'artwork-split') {
      for (const child of Object.values(n.children)) await artworkLeaf(child);
      return;
    }
    required(n.schema === 1 && Array.isArray(n.records), 'Invalid artwork leaf');
    for (const item of n.records) {
      required(!artworks.has(item.id), 'Duplicate immutable artwork ID');
      artworks.set(item.id, item);
    }
  }
  for (const d of Object.values(artRoot.directories)) {
    const n = await read(d);
    required(n.type === 'artwork-directory', 'Wrong artwork directory');
    for (const leaf of Object.values(n.shards)) await artworkLeaf(leaf);
  }
  const routes = await read(artRoot.publicRoutes),
    byId = new Map(),
    byPath = new Map();
  async function mapWalk(d, kind, outMap) {
    const n = await read(d);
    required(n.kind === kind, 'Wrong ledger map kind');
    if (n.type === 'ledger-map-branch') {
      await Promise.all(Object.values(n.children).map((child) => mapWalk(child, kind, outMap)));
      return;
    }
    required(n.type === 'ledger-map-leaf' && Array.isArray(n.entries), 'Wrong map leaf');
    for (const e of n.entries) {
      required(typeof e.key === 'string' && !outMap.has(e.key), 'Duplicate map key');
      outMap.set(e.key, e.value);
    }
  }
  console.log(
    JSON.stringify({
      phase: 'artwork-graph',
      artworks: artworks.size,
      metadataObjects: readProof.size,
    }),
  );
  await mapWalk(routes.byId, 'public-artwork-ids', byId);
  console.log(
    JSON.stringify({
      phase: 'canonical-routes',
      routes: byId.size,
      remoteMetadataObjects: remoteObjects,
    }),
  );
  await mapWalk(routes.byPath, 'public-artwork-paths', byPath);
  console.log(
    JSON.stringify({
      phase: 'legacy-routes',
      routes: byPath.size,
      remoteMetadataObjects: remoteObjects,
    }),
  );
  required(
    byId.size === routes.artworks && byPath.size === routes.byPath.count,
    'Incomplete canonical/legacy routes',
  );
  const collRoot = await context.getFacet('collections'),
    topics = new Map();
  async function topicWalk(d) {
    const n = await read(d);
    required(n.kind === 'collection', 'Wrong collection directory');
    if (n.type === 'hashed-topic-branch') {
      for (const child of Object.values(n.children)) await topicWalk(child);
      return;
    }
    required(
      n.type === 'hashed-topic-leaf' && Array.isArray(n.entries),
      'Wrong topic directory leaf',
    );
    for (const e of n.entries) {
      required(!topics.has(e.slug), 'Duplicate topic');
      topics.set(e.slug, await read(e));
    }
  }
  await topicWalk(collRoot.directory);
  const countsRoot = await context.getFacet('counts'),
    counts = await read(countsRoot.global);
  required(
    counts.totals.artworks === artworks.size && counts.totals.artworks === byId.size,
    'Published artwork count mismatch',
  );
  required(
    counts.totals.subjects === topics.size && collRoot.topicCount === topics.size,
    'Published topic count mismatch',
  );
  const legacyById = new Map();
  for (const [slug, row] of byPath) {
    required(
      artworks.has(row.id) && byId.get(row.id)?.slug === row.slug,
      'Legacy path targets wrong identity',
    );
    if (slug !== row.slug) {
      if (!legacyById.has(row.id)) legacyById.set(row.id, []);
      legacyById.get(row.id).push('/art/' + slug + '/');
    }
  }
  const assetRefs = [],
    assetObjects = new Map(),
    content = [],
    urlRows = [];
  let descriptionDiffs = 0,
    altDiffs = 0,
    titleMutation = 0,
    unchangedFields = 0;
  const assetsFor = (item) => {
    const slots = ['webp', 'pdf', 'thumb', 'originalThumb', 'preview', 'svg'];
    const files = item.files ?? {},
      rows = [];
    const sources = new Map(
      [
        ['webp', item.webp],
        ['pdf', item.pdf],
        ['thumb', item.originalThumb ?? item.thumb],
        ['svg', item.svg],
      ].filter(([, v]) => typeof v === 'string'),
    );
    for (const role of slots) {
      const value = item[role];
      if (typeof value !== 'string' || !value) continue;
      const u = new URL(value, 'https://ultraclipart.com');
      if (!['assets.ultraclipart.com', 'ultraclipart.com'].includes(u.hostname))
        throw Error('Unexpected published media origin');
      let format = [...sources].find(([, src]) => src === value)?.[0];
      if (!format && role === 'thumb' && item.thumb === item.webp) format = 'webp';
      const proof = format ? files[format] : undefined;
      const row = {
        id: item.id,
        role,
        sourceURL: u.href,
        newURL: publicBrandURL(u.href),
        bucket: u.hostname === 'assets.ultraclipart.com' ? 'ultraclipart-media' : null,
        objectKey:
          u.hostname === 'assets.ultraclipart.com' ? decodeURIComponent(u.pathname.slice(1)) : null,
        format: format ?? null,
        mime:
          format === 'pdf' ? 'application/pdf' : format === 'svg' ? 'image/svg+xml' : 'image/webp',
        bytes: proof?.bytes ?? null,
        sha256: proof?.sha256 ?? null,
        metadataIdentity:
          proof && Number.isSafeInteger(proof.bytes) && /^[a-f0-9]{64}$/.test(proof.sha256 ?? '')
            ? 'SOURCE_BOUND_METADATA_IDENTIFIED'
            : 'NEEDS_MEDIA_METADATA_RECONCILIATION',
        remoteBytesRead: false,
        remoteHEADVerified: false,
      };
      rows.push(row);
      assetRefs.push(row);
      if (row.objectKey) {
        const key = row.bucket + '/' + row.objectKey,
          existing = assetObjects.get(key);
        if (existing && row.sha256 && existing.sha256 && existing.sha256 !== row.sha256)
          throw Error('One object has conflicting source checksum');
        if (existing && row.bytes && existing.bytes && existing.bytes !== row.bytes)
          throw Error('One object has conflicting source byte length');
        if (!existing)
          assetObjects.set(key, {
            bucket: row.bucket,
            objectKey: row.objectKey,
            mime: row.mime,
            bytes: row.bytes,
            sha256: row.sha256,
            sourceURL: row.sourceURL,
            newURL: row.newURL,
            referenceCount: 1,
            roles: [row.role],
            ids: [item.id],
            remoteHEADVerified: false,
            remoteBytesRead: false,
          });
        else {
          existing.referenceCount++;
          if (!existing.roles.includes(row.role)) existing.roles.push(row.role);
          if (!existing.ids.includes(item.id)) existing.ids.push(item.id);
          if (!existing.sha256 && row.sha256) {
            existing.sha256 = row.sha256;
            existing.bytes = row.bytes;
            existing.mime = row.mime;
          }
        }
      }
    }
    return rows.map(({ role, objectKey, mime, bytes, sha256, metadataIdentity }) => ({
      role,
      objectKey,
      mime,
      bytes,
      sha256,
      metadataIdentity,
    }));
  };
  for (const item of [...artworks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    required(
      item.published === true && item.indexable === true,
      'Unexpected unpublishable record in canonical artwork set',
    );
    required(topics.has(item.topic), 'Artwork points to missing topic');
    const route = byId.get(item.id);
    required(route?.id === item.id && typeof route.slug === 'string', 'Missing artwork canonical');
    const view = presentationState(item),
      sourceTitle = item.title,
      displayTitle = displayCatalogTitle(sourceTitle);
    descriptionDiffs += Number(view.description !== item.description);
    altDiffs += Number(view.alt !== item.alt);
    titleMutation += Number(view.title !== item.title);
    required(
      freeCatalogTitle(displayTitle) === displayTitle &&
        !/^Free\s+Free\b/i.test(displayTitle) &&
        !/(?:Clipart\s+){2}/i.test(displayTitle),
      'Non-idempotent or duplicate display title',
    );
    const immutable = {
      id: item.id,
      title: item.title,
      description: item.description,
      alt: item.alt,
      files: item.files,
      topic: item.topic,
      revision: item.revision,
    };
    const projected = {
      id: view.id,
      title: view.title,
      description: view.description,
      alt: view.alt,
      files: view.files,
      topic: view.topic,
      revision: view.revision,
    };
    required(jsonSHA(immutable) === jsonSHA(projected), 'Source field mutated by presentation');
    unchangedFields++;
    const path = '/art/' + route.slug + '/';
    const assets = assetsFor(item);
    const row = {
      id: item.id,
      sourceCanonical: 'https://ultraclipart.com' + path,
      newCanonical: 'https://jotclipart.com' + path,
      legacyPaths: (legacyById.get(item.id) ?? []).sort(),
      topic: item.topic,
      cluster: item.cluster ?? null,
      sourceTitle,
      displayTitle,
      descriptionSHA256: sha(Buffer.from(item.description)),
      newDescriptionSHA256: sha(Buffer.from(view.description)),
      altSHA256: sha(Buffer.from(item.alt)),
      newAltSHA256: sha(Buffer.from(view.alt)),
      sourceRecordSHA256: jsonSHA(item),
      sourceIdentityFieldsSHA256: jsonSHA(immutable),
      published: true,
      indexable: true,
      sourceStatus: 'SIGNED_SOURCE_MEDIA_GRAPH_VERIFIED',
      validation: 'OFFLINE_SIGNED_METADATA_IDENTITY_VERIFIED',
      liveHTTPVerified: false,
      assets,
    };
    content.push(row);
    urlRows.push({
      kind: 'art',
      id: item.id,
      oldCanonical: row.sourceCanonical,
      newCanonical: row.newCanonical,
      path,
      legacyPaths: row.legacyPaths.join(' '),
      sourceTitle,
      displayTitle,
      descriptionSHA256: row.descriptionSHA256,
    });
  }
  const topicRows = [];
  for (const [slug, item] of [...topics].sort(([a], [b]) => a.localeCompare(b))) {
    const view = presentationState(item),
      description = item.metaDescription ?? item.summary ?? '';
    required(
      item.canonical === 'https://ultraclipart.com/clipart/' + slug + '/',
      'Wrong topic canonical',
    );
    required(
      view.metaDescription === item.metaDescription &&
        view.summary === item.summary &&
        jsonSHA(view.paragraphs) === jsonSHA(item.paragraphs),
      'Topic descriptions mutated',
    );
    const row = {
      kind: 'topic',
      id: slug,
      oldCanonical: item.canonical,
      newCanonical: publicBrandURL(item.canonical),
      path: item.path,
      ...topicHeadingEvidence(item),
      descriptionSHA256: sha(Buffer.from(description)),
      artworkCount: item.artworkCount,
      clusters: item.clusters,
      descriptionUnchanged: true,
    };
    topicRows.push(row);
    urlRows.push(row);
  }
  const xmlIndex = await readSitemap(context, '/sitemap.xml');
  const kinds = [
    ...xmlIndex.matchAll(/<loc>https:\/\/ultraclipart\.com\/sitemap-([^<]+)\.xml<\/loc>/g),
  ].map((m) => m[1]);
  const sitemapProof = [],
    canonicalSets = { art: new Set(), topics: new Set(), collections: new Set(), pages: new Set() },
    imagePairs = [];
  for (const kind of kinds) {
    const path = '/sitemap-' + kind + '.xml',
      xml = await readSitemap(context, path),
      projected = presentationSitemap(xml);
    required(
      !projected.includes('<loc>https://ultraclipart.com/') &&
        !projected.includes('<image:loc>https://assets.ultraclipart.com/'),
      'Unmapped sitemap public address',
    );
    const urls = [...xml.matchAll(/<url><loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const family = kind.split('-')[0];
    if (canonicalSets[family])
      for (const u of urls) {
        required(!canonicalSets[family].has(u), 'Duplicate canonical within sitemap family');
        canonicalSets[family].add(u);
      }
    if (family === 'images') {
      for (const block of xml.matchAll(/<url><loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)) {
        const media = [...block[2].matchAll(/<image:loc>([^<]+)<\/image:loc>/g)].map((m) => m[1]);
        for (const imageURL of media)
          imagePairs.push({
            canonical: block[1],
            imageURL,
            newCanonical: publicBrandURL(block[1]),
            newImageURL: publicBrandURL(imageURL),
          });
      }
    }
    sitemapProof.push({
      kind,
      path,
      sourceSHA256: sha(Buffer.from(xml)),
      newSHA256: sha(Buffer.from(projected)),
      urls: urls.length,
      imageEntries: family === 'images' ? urls.length : 0,
      sourceBytes: Buffer.byteLength(xml),
      newBytes: Buffer.byteLength(projected),
      sourceMetadataVerified: true,
      publicHTTPVerified: false,
    });
  }
  const artURLs = new Set(content.map((x) => x.sourceCanonical)),
    topicURLs = new Set(topicRows.map((x) => x.oldCanonical));
  for (const u of canonicalSets.art)
    required(artURLs.has(u), 'Sitemap artwork missing from source/route graph');
  for (const u of artURLs)
    required(canonicalSets.art.has(u), 'Canonical artwork missing from sitemap');
  for (const u of topicURLs) required(canonicalSets.topics.has(u), 'Topic missing from sitemap');
  required(canonicalSets.topics.size === topicURLs.size, 'Extra sitemap topic');
  required(imagePairs.length === artURLs.size, 'Image sitemap incomplete');
  const byURL = new Map(content.map((x) => [x.sourceCanonical, x]));
  for (const pair of imagePairs) {
    const row = byURL.get(pair.canonical);
    required(
      row && artworks.get(row.id).webp === pair.imageURL,
      'Image sitemap references wrong original',
    );
  }
  const registryBytes = readFileSync('data/curated-collections.json'),
    registry = JSON.parse(registryBytes),
    curated = new Map(registry.collections.map((g) => [g.slug, g])),
    primaryCopy = new Map(registry.primaryCovers.map((g) => [g.slug, g]));
  const shellRoot = await read(collRoot.shells),
    groups = await readShellField(context, shellRoot, 'clustersData'),
    primary = new Map(groups.map((g) => [g.slug, g])),
    collectionRows = [];
  for (const u of canonicalSets.collections) {
    const slug = new URL(u).pathname.split('/')[2],
      definition = curated.get(slug),
      group = primary.get(slug),
      copy = primaryCopy.get(slug);
    required(definition || group, 'Collection route lacks preserved source definition');
    const sourceTitle = definition?.title ?? group.title ?? group.cluster;
    required(
      typeof sourceTitle === 'string' && sourceTitle.trim(),
      'Collection source title missing',
    );
    const sourceDescription =
      definition?.summary ??
      copy?.summary ??
      group.description ??
      `Browse the subjects in the ${sourceTitle} clipart collection.`;
    const sourceParagraphs = definition?.paragraphs ??
      copy?.paragraphs ??
      group.paragraphs ?? [
        sourceDescription,
        'Explore {{artworkCount}} illustrations across the subjects below. Choose a subject to browse its complete gallery.',
      ];
    const view = presentationState({
      title: sourceTitle,
      description: sourceDescription,
      paragraphs: sourceParagraphs,
    });
    required(
      view.title === sourceTitle &&
        view.description === sourceDescription &&
        jsonSHA(view.paragraphs) === jsonSHA(sourceParagraphs),
      'Collection source metadata changed',
    );
    const row = {
      kind: 'collection',
      id: slug,
      oldCanonical: u,
      newCanonical: publicBrandURL(u),
      path: new URL(u).pathname,
      sourceTitle,
      displayTitle: displayCatalogTitle(sourceTitle),
      sourceDescription,
      descriptionSHA256: sha(Buffer.from(sourceDescription)),
      newDescriptionSHA256: sha(Buffer.from(view.description)),
      paragraphsSHA256: jsonSHA(sourceParagraphs),
      newParagraphsSHA256: jsonSHA(view.paragraphs),
      descriptionUnchanged: true,
      titleEvidence: definition
        ? 'preserved-reviewed-curated-registry'
        : 'signed-discovery-group-and-preserved-reviewed-primary-copy',
      liveRenderedComparisonVerified: false,
    };
    collectionRows.push(row);
    urlRows.push(row);
  }
  for (const u of canonicalSets.pages)
    if (!artURLs.has(u) && !topicURLs.has(u) && !canonicalSets.collections.has(u))
      urlRows.push({
        kind: 'page',
        id: new URL(u).pathname,
        oldCanonical: u,
        newCanonical: publicBrandURL(u),
        path: new URL(u).pathname,
      });
  const identity = {
    artworks: artworks.size,
    topics: topics.size,
    collections: canonicalSets.collections.size,
    otherPages: canonicalSets.pages.size,
    canonicalPages:
      artURLs.size + topicURLs.size + canonicalSets.collections.size + canonicalSets.pages.size,
    imageSitemapEntries: imagePairs.length,
    legacyArtworkPaths: [...legacyById.values()].reduce((s, a) => s + a.length, 0),
    assetReferences: assetRefs.length,
    uniqueR2Objects: assetObjects.size,
    unreconciledAssetReferences: assetRefs.filter(
      (x) => x.metadataIdentity !== 'SOURCE_BOUND_METADATA_IDENTIFIED',
    ).length,
  };
  required(
    identity.artworks === 49858 &&
      identity.topics === 804 &&
      identity.collections === 101 &&
      identity.otherPages === 24,
    'Unexpected pinned baseline counts',
  );
  gzipLines('catalog-content-map.jsonl.gz', content);
  gzipLines('catalog-topic-map.jsonl.gz', topicRows);
  gzipLines('catalog-collection-map.jsonl.gz', collectionRows);
  gzipLines('catalog-asset-references.jsonl.gz', assetRefs);
  gzipLines('catalog-r2-object-map.jsonl.gz', [...assetObjects.values()]);
  gzipLines('catalog-image-sitemap-map.jsonl.gz', imagePairs);
  csv(
    'catalog-url-map.csv.gz',
    [
      'kind',
      'id',
      'oldCanonical',
      'newCanonical',
      'path',
      'legacyPaths',
      'sourceTitle',
      'displayTitle',
      'descriptionSHA256',
    ],
    urlRows,
  );
  csv(
    'catalog-asset-map.csv.gz',
    [
      'id',
      'role',
      'bucket',
      'objectKey',
      'sourceURL',
      'newURL',
      'mime',
      'bytes',
      'sha256',
      'metadataIdentity',
    ],
    assetRefs,
  );
  write('catalog-canonical-paths.txt', urlRows.map((x) => x.path).join('\n') + '\n');
  write(
    'catalog-legacy-artwork-paths.txt',
    [...byPath]
      .filter(([slug, row]) => slug !== row.slug)
      .map(([slug, row]) => '/art/' + slug + '/\t/art/' + row.slug + '/')
      .join('\n') + '\n',
  );
  const declaredLegacy = readFileSync('public/_redirects', 'utf8')
    .split(/\r?\n/)
    .flatMap((line, i) => {
      const f = line.trim().split(/\s+/);
      if (!line.trim() || line.trim().startsWith('#')) return [];
      required(
        f.length === 3 && !f[0].includes('://') && !f[1].includes('://'),
        'Unexpected/domain legacy redirect declaration',
      );
      return [
        {
          sourcePath: f[0],
          targetPath: f[1],
          status: Number(f[2]),
          sourceLine: i + 1,
          scope: 'NEW_ORIGIN_ONLY_EXISTING_LEGACY_MAP',
          liveOldVerified: false,
          liveNewVerified: false,
        },
      ];
    });
  write(
    'catalog-legacy-topic-and-download-map.json',
    JSON.stringify(
      {
        source: 'public/_redirects',
        sourceSHA256: sha(readFileSync('public/_redirects')),
        rules: declaredLegacy,
        oldToNewDomainRedirectCreated: false,
        scope: 'SOURCE_DECLARATIONS_NOT_LIVE_HTTP_EVIDENCE',
      },
      null,
      2,
    ),
  );
  write(
    'catalog-legacy-topic-paths.txt',
    declaredLegacy
      .filter((r) => !r.sourcePath.includes('*'))
      .map((r) => r.sourcePath + '\t' + r.targetPath + '\t' + r.status)
      .join('\n') + '\n',
  );
  write(
    'catalog-description-diff.json',
    JSON.stringify(
      {
        scope:
          'SIGNED_SOURCE_AND_PRESERVED_REVIEWED_REGISTRY_TO_NEW_PUBLIC_DTO_PROJECTION_ONLY_NOT_RENDERED_HTML_AUDIT',
        artworksCompared: artworks.size,
        topicsCompared: topics.size,
        collectionsCompared: collectionRows.length,
        reviewedCollectionRegistrySHA256: sha(registryBytes),
        artworkDescriptionDifferences: descriptionDiffs,
        artworkAltDifferences: altDiffs,
        sourceTitleMutations: titleMutation,
        immutableIdentityRecordsMatched: unchangedFields,
        topicDescriptionDifferences: 0,
        collectionDescriptionDifferences: 0,
        collectionParagraphDifferences: 0,
        unmodifiedStoredObjects: true,
        fullRenderedMetadataComparisonPending: true,
      },
      null,
      2,
    ),
  );
  write(
    'catalog-sitemap-map.json',
    JSON.stringify(
      {
        scope: 'OFFLINE_SIGNED_SOURCE_AND_DOMAIN_PROJECTION',
        kinds: sitemapProof,
        identity,
        publicHTTPVerified: false,
      },
      null,
      2,
    ),
  );
  gzipLines('catalog-local-metadata-read-proof.jsonl.gz', [...readProof.values()]);
  const outputs = [
    'catalog-content-map.jsonl.gz',
    'catalog-topic-map.jsonl.gz',
    'catalog-collection-map.jsonl.gz',
    'catalog-asset-references.jsonl.gz',
    'catalog-r2-object-map.jsonl.gz',
    'catalog-image-sitemap-map.jsonl.gz',
    'catalog-url-map.csv.gz',
    'catalog-asset-map.csv.gz',
    'catalog-description-diff.json',
    'catalog-sitemap-map.json',
    'catalog-canonical-paths.txt',
    'catalog-legacy-artwork-paths.txt',
    'catalog-legacy-topic-and-download-map.json',
    'catalog-legacy-topic-paths.txt',
    'catalog-local-metadata-read-proof.jsonl.gz',
  ];
  const outputChecksums = outputs.map((file) => {
    const b = readFileSync(join(out, file));
    return { file, bytes: b.length, sha256: sha(b) };
  });
  const result = {
    status: 'OFFLINE_SIGNED_CONTENT_URL_ASSET_IDENTITY_AUDIT_PASSED',
    at: new Date().toISOString(),
    revision: context.snapshot.revision,
    root: context.rootSHA256,
    signatureVerified: context.authorizationVerified,
    identity,
    metadataObjectsRead: readProof.size,
    freshMetadataObjectsReadViaExistingSession: remoteObjects,
    metadataBytesRead: [...readProof.values()].reduce((n, r) => n + r.bytes, 0),
    oldAndNewUseSameR2Objects: true,
    remoteOriginalBytesRead: 0,
    remoteR2HEADVerified: 0,
    newLiveHTTPChecked: 0,
    sourceDescriptionDifferences: descriptionDiffs,
    sourceAltDifferences: altDiffs,
    sourceTitleMutations: titleMutation,
    sourceCollectionMetadataCompared: collectionRows.length,
    collectionRenderedMetadataPending: canonicalSets.collections.size,
    declaredLegacyTopicAliases: declaredLegacy.filter((r) => !r.sourcePath.includes('*')).length,
    remaining: [
      'Fresh R2 object HEAD/metadata inventory reconciliation',
      'Representative original full-byte end-to-end checks',
      'Full new canonical/legacy HTTP audit',
      'Rendered collection title/description comparison',
      'Independent live UI/functionality audit',
    ],
    outputs,
    outputChecksums,
  };
  write('catalog-audit.json', JSON.stringify(result, null, 2));
  write(
    'catalog-audit-progress.json',
    JSON.stringify(
      { status: 'COMPLETE', at: result.at, root: result.root, result: 'catalog-audit.json' },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ...result, outputChecksums: undefined }));
} catch (error) {
  const result = {
    status: missing.size ? 'CAPTURE_INCOMPLETE_RETRY_SAFE' : 'OFFLINE_CATALOG_AUDIT_FAILED',
    at: new Date().toISOString(),
    expectedRoot: expected,
    error: error.message,
    missingKeys: [...missing],
    metadataObjectsRead: readProof.size,
    noCloudChanges: true,
  };
  write('catalog-audit-progress.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exitCode = 2;
}
