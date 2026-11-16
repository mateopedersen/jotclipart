// Synthetic, locally signed protocol fixtures. No live HTTP or Cloudflare use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { hostname } from 'node:os';
import {
  AuditFault,
  auditOrigin,
  loadHttpAuditInputs,
  inspectDocument,
  validateCanonicalHTML,
  fetchBounded,
  createRateLimiter,
  runHttpAudit,
} from '../scripts/jotclipart/audit-http.mjs';
import { productionSnapshotMessage } from '../server/catalog-snapshot/signed-production-snapshot.mjs';
import { snapshotDigest } from '../server/catalog-snapshot/release-pointer.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const primary = 'https://jotclipart.com',
  preview = 'https://migration-preview.jotclipart.pages.dev';
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const scriptJSON = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');
async function fixture({ additionalPages = 0 } = {}) {
  mkdirSync(resolve('work'), { recursive: true });
  const directory = mkdtempSync(join(resolve('work'), 'jot-http-test-'));
  const pair = generateKeyPairSync('ed25519');
  const config = {
    accountId: 'a'.repeat(32),
    bucketName: 'private-http-audit',
    keyId: 'private-fixture',
    publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString(
      'hex',
    ),
    activeKey: 'catalog/jotclipart/active.json',
  };
  const snapshot = {
    schema: 1,
    status: 'SOURCE_MEDIA_GRAPH_VERIFIED',
    revision: 'b'.repeat(40),
    parentRevision: 'c'.repeat(40),
    indexes: Object.fromEntries(
      ['artworks', 'collections', 'search', 'recent', 'related', 'counts', 'sitemaps'].map(
        (facet) => [
          facet,
          {
            key: `catalog/objects/${facet}/${'d'.repeat(64)}.json`,
            bytes: 2,
            sha256: 'd'.repeat(64),
          },
        ],
      ),
    ),
    authorization: {
      policy: 'source-media-graph-ed25519-v1',
      accountId: config.accountId,
      bucket: config.bucketName,
      keyId: config.keyId,
      abiSHA256: 'e'.repeat(64),
      sourceReceiptSHA256: '1'.repeat(64),
      mediaReceiptSHA256: '2'.repeat(64),
      graphReceiptSHA256: '3'.repeat(64),
      manifestRoot: '4'.repeat(64),
      parentSnapshotSHA256: '5'.repeat(64),
      issuedAt: Date.now() - 1000,
    },
  };
  snapshot.authorization.signature = sign(
    null,
    productionSnapshotMessage(snapshot),
    pair.privateKey,
  ).toString('hex');
  const root = await snapshotDigest(snapshot),
    revision = snapshot.revision,
    controlRevision = 'f'.repeat(40);
  const description = 'A baby elephant stands beside green leaves & flowers.';
  const alt = 'An elephant & two leaves beside a flower.';
  const art = {
    kind: 'art',
    id: 'stable-internal-id',
    newCanonical: primary + '/art/elephant-and-leaves/',
    sourceCanonical: 'https://ultraclipart.com/art/elephant-and-leaves/',
    legacyPaths: ['/art/stable-internal-id/'],
    sourceTitle: 'Elephant And Leaves Clipart',
    displayTitle: 'Free Elephant And Leaves Clipart',
    descriptionSHA256: sha(description),
    newDescriptionSHA256: sha(description),
    altSHA256: sha(alt),
    newAltSHA256: sha(alt),
    sourceRecordSHA256: '6'.repeat(64),
    published: true,
    indexable: true,
    validation: 'OFFLINE_SIGNED_METADATA_IDENTITY_VERIFIED',
    assets: [
      {
        role: 'webp',
        objectKey: 'private/elephant leaves.webp',
        mime: 'image/webp',
        bytes: 51,
        sha256: '7'.repeat(64),
      },
      {
        role: 'pdf',
        objectKey: 'private/elephant.pdf',
        mime: 'application/pdf',
        bytes: 65,
        sha256: '8'.repeat(64),
      },
      {
        role: 'thumb',
        objectKey: 'private/elephant leaves.webp',
        mime: 'image/webp',
        bytes: 51,
        sha256: '7'.repeat(64),
      },
    ],
  };
  const topic = {
    kind: 'topic',
    id: 'elephant',
    path: '/clipart/elephant/',
    newCanonical: primary + '/clipart/elephant/',
    sourceTitle: 'Elephant Clipart',
    displayTitle: 'Free Elephant Clipart',
    descriptionSHA256: sha(description),
    artworkCount: 1,
    descriptionUnchanged: true,
  };
  const collection = {
    kind: 'collection',
    id: 'elephants',
    path: '/collection/elephants/',
    newCanonical: primary + '/collection/elephants/',
    sourceTitle: 'Elephants',
    displayTitle: 'Free Elephants',
    descriptionSHA256: sha(description),
    descriptionUnchanged: true,
  };
  const page = { kind: 'page', path: '/about/', newCanonical: primary + '/about/' };
  const extraPages = Array.from({ length: additionalPages }, (_, i) => ({
    kind: 'page',
    path: `/fixture-page-${i}/`,
    newCanonical: primary + `/fixture-page-${i}/`,
  }));
  const paths = [
    new URL(art.newCanonical).pathname,
    topic.path,
    collection.path,
    page.path,
    ...extraPages.map((item) => item.path),
  ];
  const outputChecksums = [];
  async function write(name, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    await fs.writeFile(join(directory, name), bytes);
    outputChecksums.push({ file: name, bytes: bytes.length, sha256: sha(bytes) });
  }
  for (const [name, rows] of [
    ['catalog-content-map.jsonl.gz', [art]],
    ['catalog-topic-map.jsonl.gz', [topic]],
    ['catalog-collection-map.jsonl.gz', [collection]],
  ])
    await write(name, gzipSync(rows.map((row) => JSON.stringify(row) + '\n').join('')));
  await write('catalog-canonical-paths.txt', paths.join('\n') + '\n');
  await write('catalog-legacy-artwork-paths.txt', art.legacyPaths[0] + '\t' + paths[0] + '\n');
  await write(
    'catalog-legacy-topic-paths.txt',
    '/clipart/old-elephant/\t' + topic.path + '\t301\n',
  );
  await write(
    'catalog-legacy-topic-and-download-map.json',
    JSON.stringify({
      rules: [
        { sourcePath: '/clipart/old-elephant/', targetPath: topic.path, status: 301 },
        { sourcePath: '/download/*', targetPath: '/art/:splat', status: 301 },
      ],
    }),
  );
  const report = {
    status: 'OFFLINE_SIGNED_CONTENT_URL_ASSET_IDENTITY_AUDIT_PASSED',
    signatureVerified: true,
    root,
    revision,
    identity: {
      artworks: 1,
      topics: 1,
      collections: 1,
      otherPages: 1 + additionalPages,
      canonicalPages: 4 + additionalPages,
      legacyArtworkPaths: 1,
      unreconciledAssetReferences: 0,
    },
    declaredLegacyTopicAliases: 1,
    outputChecksums,
  };
  const reportBytes = Buffer.from(JSON.stringify(report));
  await fs.writeFile(join(directory, 'catalog-audit.json'), reportBytes);
  await fs.writeFile(join(directory, 'production-snapshot.json'), JSON.stringify(snapshot));
  await fs.writeFile(join(directory, 'verifier.json'), JSON.stringify(config));
  const options = {
    auditReport: join(directory, 'catalog-audit.json'),
    auditSHA256: sha(reportBytes),
    snapshot: join(directory, 'production-snapshot.json'),
    verifier: join(directory, 'verifier.json'),
    expectedRoot: root,
    expectedControlRevision: controlRevision,
    origin: preview,
    output: join(directory, 'output'),
    delay: async () => {},
    handleSignals: false,
  };
  const documents = new Map([
    [paths[0], { ...art, path: paths[0] }],
    [topic.path, topic],
    [collection.path, collection],
    [page.path, page],
    ...extraPages.map((item) => [item.path, item]),
  ]);
  function html(path) {
    const record = documents.get(path),
      display = record.displayTitle ?? 'About JotClipart';
    const coverTitle =
      display +
      (record.kind === 'collection'
        ? (/\bClipart$/i.test(display) ? '' : ' Clipart') + ' Collection'
        : '');
    const title = coverTitle + ' | JotClipart';
    const ogURL =
      record.kind === 'page'
        ? primary + '/og/about-private-fixture.png'
        : `${primary}/og/catalog/${record.kind}/${record.id}/${'9'.repeat(64)}.png`;
    const ogAlt = coverTitle + ' — JotClipart';
    const raw =
      "const apparent = '<meta name=robots content=noindex><link rel=canonical href=https://wrong.example>';";
    const common = `<html><head><meta name="build-revision" content="${revision}"><title>${escape(title)}</title><link rel="canonical" href="${record.newCanonical}"><meta name="description" content="${escape(description)}"><meta property="og:description" content="${escape(description)}"><meta name="twitter:description" content="${escape(description)}"><meta property="og:title" content="${escape(title)}"><meta name="twitter:title" content="${escape(title)}"><meta property="og:site_name" content="JotClipart"><meta property="og:image" content="${ogURL}"><meta property="og:image:secure_url" content="${ogURL}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="${ogURL}"><meta property="og:image:alt" content="${escape(ogAlt)}"><meta name="twitter:image:alt" content="${escape(ogAlt)}"><script>${raw}</script></head><body><h1>${escape(display)}</h1><svg><title>Decoration</title></svg><template><title>Inert title</title><h1>Inert heading</h1><script type="application/ld+json">invalid inert JSON</script></template>`;
    const assetURL = (role) =>
      'https://assets.jotclipart.com/' +
      art.assets
        .find((asset) => asset.role === role)
        .objectKey.split('/')
        .map(encodeURIComponent)
        .join('/');
    let body = '';
    if (record.kind === 'art') {
      const image = {
        '@context': 'https://schema.org',
        '@type': 'ImageObject',
        '@id': record.newCanonical + '#image',
        name: display,
        description,
        caption: alt,
        url: record.newCanonical,
        mainEntityOfPage: record.newCanonical,
        representativeOfPage: true,
        contentUrl: assetURL('webp'),
        thumbnailUrl: assetURL('thumb'),
      };
      const download = {
        id: art.id,
        title: art.sourceTitle,
        alt,
        webp: assetURL('webp'),
        pdf: assetURL('pdf'),
        download: {
          files: Object.fromEntries(
            ['webp', 'pdf'].map((role) => {
              const asset = art.assets.find((asset) => asset.role === role);
              return [role, { bytes: asset.bytes, sha256: asset.sha256 }];
            }),
          ),
        },
      };
      body = `<script type="application/ld+json">${scriptJSON(image)}</script><div id="art-preview"><img src="${assetURL('webp')}" alt="${escape(alt)}"></div><a href="${assetURL('webp')}">Image</a><a href="${assetURL('pdf')}">PDF</a><script type="application/json" data-download-record data-download-id="${art.id}">${scriptJSON(download)}</script>`;
    } else if (record.kind !== 'page')
      body = `<script type="application/ld+json">${scriptJSON({ '@type': 'CollectionPage', url: record.newCanonical, name: display, description, mainEntity: { numberOfItems: 1 } })}</script>`;
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'x-uc-snapshot': root,
      'x-uc-revision': revision,
      'content-security-policy':
        "default-src 'self'; script-src 'self' 'sha256-" +
        createHash('sha256').update(raw).digest('base64') +
        "';",
    };
    return { html: common + body + '</body></html>', headers };
  }
  function transport({
    legacyFault,
    metadataFault,
    changedAfter = false,
    transportOrigin = preview,
  } = {}) {
    const calls = [],
      counts = new Map();
    let controls = 0;
    const fetcher = async (value, init) => {
      const url = new URL(value);
      calls.push(url.href);
      counts.set(url.href, (counts.get(url.href) ?? 0) + 1);
      assert.equal(url.origin, transportOrigin);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      if (url.pathname === '/delivery-release.json') {
        controls++;
        return Response.json({
          verifiedRoot: root,
          renderedRevision: revision,
          controlRevision: changedAfter && controls === 2 ? '0'.repeat(40) : controlRevision,
        });
      }
      const legacyTarget =
        url.pathname === art.legacyPaths[0]
          ? paths[0]
          : url.pathname === '/clipart/old-elephant/'
            ? topic.path
            : null;
      if (legacyTarget) {
        const target = legacyFault === 'loop' ? url.pathname : legacyTarget;
        const location =
          (legacyFault === 'foreign' ? 'https://ultraclipart.com' : transportOrigin) +
          target +
          (legacyFault === 'query' ? '' : url.search);
        return new Response(null, { status: 301, headers: { location } });
      }
      if (documents.has(url.pathname)) {
        if (legacyFault === 'chain' && url.search)
          return new Response(null, {
            status: 301,
            headers: { location: transportOrigin + url.pathname },
          });
        let { html: body, headers } = html(url.pathname);
        if (metadataFault === 'CSP')
          headers = { ...headers, 'content-security-policy': "script-src 'self'" };
        if (metadataFault === 'noindex') headers = { ...headers, 'x-robots-tag': 'noindex' };
        return new Response(body, { headers });
      }
      return new Response('<html><body>Unknown</body></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    };
    return { fetcher, calls, counts };
  }
  return {
    directory,
    options,
    art,
    topic,
    collection,
    description,
    alt,
    paths,
    documents,
    html,
    transport,
    report,
  };
}
async function withFixture(run, options) {
  const f = await fixture(options);
  try {
    return await run(f);
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true });
  }
}

test('input loading verifies actual signed root and every frozen output pin without HTTP', () =>
  withFixture(async (f) => {
    const input = await loadHttpAuditInputs(f.options);
    assert.equal(input.root, f.options.expectedRoot);
    assert.equal(input.expected.size, 4);
    assert.equal(input.legacy.length, 2);
    const result = await runHttpAudit({ ...f.options, dryRun: true });
    assert.equal(result.planned, 11);
    assert.equal(result.liveHTTPVerified, false);
    for (const origin of [
      'https://ultraclipart.com',
      'https://jotclipart.com.evil.test',
      'http://jotclipart.com',
      'https://jotclipart.com:444',
      'https://user@jotclipart.com',
      'https://jotclipart.com/path',
    ])
      assert.throws(() => auditOrigin(origin));
  }));
test('tampered report, output bytes and publisher signatures fail before network execution', () =>
  withFixture(async (f) => {
    await assert.rejects(
      loadHttpAuditInputs({ ...f.options, auditSHA256: '0'.repeat(64) }),
      /AUDIT_REPORT_SHA/,
    );
    const verifier = JSON.parse(await fs.readFile(f.options.verifier));
    verifier.publicKeyHex = '0'.repeat(64);
    await fs.writeFile(f.options.verifier, JSON.stringify(verifier));
    await assert.rejects(loadHttpAuditInputs(f.options));
    await fs.writeFile(join(f.directory, 'catalog-canonical-paths.txt'), 'changed');
    // A valid verifier still cannot accept a changed path inventory.
    const fresh = await fixture();
    try {
      await fs.writeFile(join(fresh.directory, 'catalog-canonical-paths.txt'), 'changed');
      await assert.rejects(loadHttpAuditInputs(fresh.options), /MANIFEST_SHA_MISMATCH/);
    } finally {
      await fs.rm(fresh.directory, { recursive: true, force: true });
    }
  }));
test('HTML inspection ignores fake tags in scripts, SVG titles and inert templates', () =>
  withFixture(async (f) => {
    const input = await loadHttpAuditInputs(f.options),
      page = f.html(f.paths[0]),
      doc = inspectDocument(page.html);
    assert.equal(doc.titles.length, 1);
    assert.equal(doc.h1.length, 1);
    const checked = validateCanonicalHTML({
      html: page.html,
      headers: new Headers(page.headers),
      expected: input.expected.get(f.paths[0]),
      origin: preview,
      root: input.root,
      revision: input.revision,
    });
    assert(checked.checks.includes('download-SHA-and-bytes'));
  }));
test('raw-text boundaries preserve Unicode character offsets and decoded entity text', () => {
  const source =
    '<html><head><title>İzmir &amp; Leaves</title><script type="application/ld+json">{"name":"İstanbul"}</script></head><body><h1>İstanbul &amp; Flowers</h1></body></html>';
  const parsed = inspectDocument(source);
  assert.deepEqual(parsed.titles, ['İzmir & Leaves']);
  assert.deepEqual(parsed.h1, ['İstanbul & Flowers']);
  assert.equal(JSON.parse(parsed.scripts[0].text).name, 'İstanbul');
});
test('only the exact owned custom preview origin is admitted; production cannot borrow preview indexability policy', () =>
  withFixture(async (f) => {
    assert.equal(auditOrigin('https://preview.jotclipart.com'), 'https://preview.jotclipart.com');
    for (const origin of [
      'https://foreign.preview.jotclipart.com',
      'http://preview.jotclipart.com',
      'https://preview.jotclipart.com:444',
      'https://preview.jotclipart.com.evil.test',
    ])
      assert.throws(() => auditOrigin(origin));
    await assert.rejects(
      runHttpAudit({ ...f.options, origin: primary, mode: 'preview', dryRun: true }),
      /INVALID_PREVIEW_POLICY_ORIGIN/,
    );
    await assert.rejects(
      runHttpAudit({ ...f.options, mode: 'skip-indexability', dryRun: true }),
      /INVALID_INDEXABILITY_MODE/,
    );
  }));
test('preview policy permits only its transport noindex header, never catalog noindex metadata', () =>
  withFixture(async (f) => {
    const input = await loadHttpAuditInputs(f.options),
      page = f.html(f.paths[0]);
    const configuration = {
      html: page.html,
      headers: new Headers({ ...page.headers, 'x-robots-tag': 'noindex, nofollow' }),
      expected: input.expected.get(f.paths[0]),
      origin: 'https://preview.jotclipart.com',
      root: input.root,
      revision: input.revision,
    };
    assert.throws(() => validateCanonicalHTML(configuration), /INDEXABLE_PAGE_NOINDEX/);
    assert(
      validateCanonicalHTML({ ...configuration, mode: 'preview' }).checks.includes(
        'preview-transport-noindex',
      ),
    );
    for (const robot of ['robots', 'googlebot', 'bingbot'])
      assert.throws(
        () =>
          validateCanonicalHTML({
            ...configuration,
            mode: 'preview',
            html: page.html.replace('</head>', `<meta name="${robot}" content="noindex"></head>`),
          }),
        /INDEXABLE_PAGE_NOINDEX/,
      );
    assert.throws(
      () => validateCanonicalHTML({ ...configuration, origin: primary, mode: 'preview' }),
      /INVALID_PREVIEW_POLICY_ORIGIN/,
    );
  }));
test('custom preview runs carry their policy in the resume contract and cannot become a production pass', () =>
  withFixture(async (f) => {
    const origin = 'https://preview.jotclipart.com',
      t = f.transport({ metadataFault: 'noindex', transportOrigin: origin });
    const result = await runHttpAudit({
      ...f.options,
      origin,
      mode: 'preview',
      fetcher: t.fetcher,
    });
    assert.equal(result.status, 'HTTP_AUDIT_PASSED');
    assert.equal(result.mode, 'preview');
    assert.equal(result.productionHTTPIndexabilityVerified, false);
    assert.equal(result.previewTransportNoindexAllowed, true);
    assert(t.calls.every((url) => new URL(url).origin === origin));
    await assert.rejects(
      runHttpAudit({ ...f.options, origin, mode: 'production', fetcher: t.fetcher }),
      /RESUME_CONTRACT_DIFFERS/,
    );
  }));
test('catalog OG metadata has the correct new ID, PNG size, secure/Twitter URL and derived caption', () =>
  withFixture(async (f) => {
    const input = await loadHttpAuditInputs(f.options);
    for (const path of [f.paths[0], f.topic.path, f.collection.path]) {
      const page = f.html(path),
        expected = input.expected.get(path);
      const validate = (html) =>
        validateCanonicalHTML({
          html,
          headers: new Headers(page.headers),
          expected,
          origin: preview,
          root: input.root,
          revision: input.revision,
        });
      assert.equal(validate(page.html).og.id, expected.id);
      const image = inspectDocument(page.html).meta.find((m) => m.property === 'og:image').content;
      const changes = [
        [
          page.html.replace(
            `property="og:image" content="${image}"`,
            'property="og:image" content="https://assets.jotclipart.com/private/old-original.webp"',
          ),
          'CATALOG_OG_IDENTITY_DIFFERS',
        ],
        [
          page.html.replace(
            `property="og:image" content="${image}"`,
            `property="og:image" content="${image.replace('/' + expected.id + '/', '/wrong-identity/')}"`,
          ),
          'CATALOG_OG_IDENTITY_DIFFERS',
        ],
        [
          page.html.replace(
            `property="og:image:secure_url" content="${image}"`,
            'property="og:image:secure_url" content="https://assets.ultraclipart.com/old.webp"',
          ),
          'CATALOG_OG_URL_DIFFERS',
        ],
        [
          page.html.replace(
            `name="twitter:image" content="${image}"`,
            `name="twitter:image" content="${image.replace('9'.repeat(64), '8'.repeat(64))}"`,
          ),
          'CATALOG_OG_URL_DIFFERS',
        ],
        [
          page.html.replace(
            'property="og:image:type" content="image/png"',
            'property="og:image:type" content="image/webp"',
          ),
          'CATALOG_OG_FORMAT_DIFFERS',
        ],
        [
          page.html.replace(
            'property="og:image:width" content="1200"',
            'property="og:image:width" content="500"',
          ),
          'CATALOG_OG_SIZE_DIFFERS',
        ],
        [
          page.html.replace(
            'property="og:image:height" content="630"',
            'property="og:image:height" content="500"',
          ),
          'CATALOG_OG_SIZE_DIFFERS',
        ],
        [
          page.html.replace(
            /(property="og:image:alt" content=")[^"]*(")/,
            '$1' + escape(f.alt) + '$2',
          ),
          'CATALOG_OG_ALT_DIFFERS',
        ],
        [
          page.html.replace(
            /(name="twitter:image:alt" content=")[^"]*(")/,
            '$1' + escape(f.alt) + '$2',
          ),
          'CATALOG_OG_ALT_DIFFERS',
        ],
        [
          page.html.replace(
            '</head>',
            `<meta property="og:image:secure_url" content="${image}"></head>`,
          ),
          'METADATA_CARDINALITY',
        ],
      ];
      for (const [html, code] of changes)
        assert.throws(
          () => validate(html),
          (error) => error instanceof AuditFault && error.code === code,
        );
    }
  }));
test('collection titles already ending Clipart keep exactly one suffix in SEO and OG while source ALT remains protected', () =>
  withFixture(async (f) => {
    const input = await loadHttpAuditInputs(f.options),
      expected = {
        ...input.expected.get(f.collection.path),
        displayTitle: 'Free Elephants Clipart',
      };
    f.collection.displayTitle = expected.displayTitle;
    const page = f.html(f.collection.path),
      checked = validateCanonicalHTML({
        html: page.html,
        headers: new Headers(page.headers),
        expected,
        origin: preview,
        root: input.root,
        revision: input.revision,
      });
    assert(checked.checks.includes('new-branded-OG-identity'));
    assert(!inspectDocument(page.html).titles[0].includes('Clipart Clipart'));
    const art = f.html(f.paths[0]);
    assert.throws(
      () =>
        validateCanonicalHTML({
          html: art.html.replace(
            '"caption":' + JSON.stringify(f.alt),
            '"caption":"changed source"',
          ),
          headers: new Headers(art.headers),
          expected: input.expected.get(f.paths[0]),
          origin: preview,
          root: input.root,
          revision: input.revision,
        }),
      /ALT_DIFFERS/,
    );
  }));
test('source H1, description, ALT, ID, object key, download digest and JSON-LD mismatches are rejected', () =>
  withFixture(async (f) => {
    const input = await loadHttpAuditInputs(f.options),
      page = f.html(f.paths[0]);
    const changes = [
      [
        page.html.replace('<h1>' + escape(f.art.displayTitle) + '</h1>', '<h1>Wrong</h1>'),
        'H1_DIFFERS',
      ],
      [
        page.html.replace(
          'name="description" content="' + escape(f.description) + '"',
          'name="description" content="changed"',
        ),
        'DESCRIPTION_DIFFERS',
      ],
      [page.html.replace('alt="' + escape(f.alt) + '"', 'alt="changed"'), 'ALT_DIFFERS'],
      [page.html.replace('"id":"' + f.art.id + '"', '"id":"wrong-id"'), 'ARTWORK_ID_DIFFERS'],
      [
        page.html.replace(
          'id="art-preview"><img src="https://assets.jotclipart.com/private/elephant%20leaves.webp"',
          'id="art-preview"><img src="https://assets.jotclipart.com/private/thumb.webp"',
        ),
        'PUBLIC_ASSET_KEY_DIFFERS',
      ],
      [
        page.html.replace('"sha256":"' + '7'.repeat(64) + '"', '"sha256":"' + '9'.repeat(64) + '"'),
        'DOWNLOAD_SHA_DIFFERS',
      ],
      [
        page.html.replace('type="application/ld+json">{', 'type="application/ld+json">invalid{'),
        'INVALID_JSONLD',
      ],
    ];
    for (const [html, issue] of changes)
      assert.throws(
        () =>
          validateCanonicalHTML({
            html,
            headers: new Headers(page.headers),
            expected: input.expected.get(f.paths[0]),
            origin: preview,
            root: input.root,
            revision: input.revision,
          }),
        (error) => error instanceof AuditFault && error.code === issue,
      );
  }));
test('GET retries transient statuses only within three attempts and reads decompressed size bounds', async () => {
  let attempts = 0;
  const result = await fetchBounded(preview + '/', {
    delay: async () => {},
    fetcher: async () =>
      ++attempts < 3 ? new Response(null, { status: 503 }) : new Response('ready'),
  });
  assert.equal(result.attempts, 3);
  let reads = 0;
  await assert.rejects(
    fetchBounded(preview + '/', {
      maxBodyBytes: 64,
      delay: async () => {},
      fetcher: async () => {
        reads++;
        return new Response('x'.repeat(65), {
          headers: { 'content-length': '1', 'content-encoding': 'gzip' },
        });
      },
    }),
    (error) => error.code === 'BODY_TOO_LARGE',
  );
  assert.equal(reads, 1);
});
test('rate reservations cap one shared request stream at forty per second', async () => {
  const waits = [];
  const throttle = createRateLimiter({
    requestsPerSecond: 40,
    now: () => 0,
    delay: async (ms) => waits.push(ms),
  });
  await Promise.all(Array.from({ length: 9 }, () => throttle()));
  assert.deepEqual(waits, [25, 50, 75, 100, 125, 150, 175, 200]);
  assert.throws(() => createRateLimiter({ requestsPerSecond: 41 }));
});
test('resumable evidence skips only verified completed jobs and never stores raw HTML', () =>
  withFixture(async (f) => {
    const t = f.transport();
    const first = await runHttpAudit({ ...f.options, fetcher: t.fetcher, maxJobs: 2 });
    assert.equal(first.status, 'HTTP_AUDIT_PARTIAL');
    assert.equal(first.completed, 2);
    const second = await runHttpAudit({ ...f.options, fetcher: t.fetcher });
    assert.equal(second.status, 'HTTP_AUDIT_PASSED');
    assert.equal(second.completed, 11);
    assert.equal(second.attemptedThisRun, 9);
    assert.equal(second.liveHTTPVerified, false);
    const evidence = await fs.readFile(join(f.options.output, 'evidence.jsonl'), 'utf8');
    assert.equal(evidence.trim().split('\n').length, 11);
    assert(!evidence.includes('<html>'));
    assert(!evidence.includes(f.description));
    assert.equal(
      (await fs.readFile(join(f.options.output, 'control-events.jsonl'), 'utf8')).trim().split('\n')
        .length,
      4,
    );
  }));
for (const concurrency of [undefined, 16])
  test(
    'network work preserves the default eight jobs and explicitly bounds sixteen requested jobs: ' +
      concurrency,
    () =>
      withFixture(
        async (f) => {
          const t = f.transport();
          let active = 0,
            peak = 0;
          const fetcher = async (...args) => {
            active++;
            peak = Math.max(peak, active);
            try {
              await new Promise((done) => setTimeout(done, 2));
              return await t.fetcher(...args);
            } finally {
              active--;
            }
          };
          const result = await runHttpAudit({
            ...f.options,
            fetcher,
            ...(concurrency ? { concurrency } : {}),
          });
          assert.equal(result.status, 'HTTP_AUDIT_PASSED');
          assert.equal(peak, concurrency ?? 8);
          assert.equal(result.concurrency, concurrency ?? 8);
          assert.equal(result.completed, 27);
          await assert.rejects(
            runHttpAudit({ ...f.options, fetcher, concurrency: 17 }),
            /CONCURRENCY_BOUND/,
          );
        },
        { additionalPages: 16 },
      ),
  );
test('invalid pool/rate choices fail before any network request and the actual twenty-per-second reservation stays shared', () =>
  withFixture(async (f) => {
    const t = f.transport();
    for (const concurrency of [0, -1, 1.5, NaN, Infinity])
      await assert.rejects(
        runHttpAudit({ ...f.options, fetcher: t.fetcher, concurrency }),
        /CONCURRENCY_BOUND/,
      );
    for (const requestsPerSecond of [0, -1, 1.5, NaN, Infinity, 41])
      await assert.rejects(
        runHttpAudit({ ...f.options, fetcher: t.fetcher, requestsPerSecond }),
        /RATE_BOUND/,
      );
    assert.equal(t.calls.length, 0);
    const waits = [];
    const throttle = createRateLimiter({
      requestsPerSecond: 20,
      now: () => 0,
      delay: async (ms) => waits.push(ms),
    });
    await Promise.all(Array.from({ length: 16 }, () => throttle()));
    assert.deepEqual(
      waits,
      Array.from({ length: 15 }, (_, i) => (i + 1) * 50),
    );
    let attempts = 0,
      cancelled = 0,
      reservations = 0;
    await assert.rejects(
      fetchBounded(preview + '/', {
        throttle: async () => {
          reservations++;
          await throttle();
        },
        delay: async () => {},
        fetcher: async () => {
          attempts++;
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            { status: 429, headers: { 'retry-after': '99' } },
          );
        },
      }),
      /TRANSIENT_HTTP_EXHAUSTED/,
    );
    assert.equal(attempts, 3);
    assert.equal(cancelled, 3);
    assert.equal(reservations, 3);
  }));
test('a torn last record is archived and rechecked; intact ledger corruption is rejected', () =>
  withFixture(async (f) => {
    const t = f.transport();
    await runHttpAudit({ ...f.options, fetcher: t.fetcher, maxJobs: 1 });
    const file = join(f.options.output, 'evidence.jsonl');
    await fs.appendFile(file, '{"unfinished":');
    const result = await runHttpAudit({ ...f.options, fetcher: t.fetcher });
    assert(result.repairedPartialBytes > 0);
    assert((await fs.readdir(f.options.output)).some((name) => name.includes('.incomplete.')));
    const rows = (await fs.readFile(file, 'utf8')).trim().split('\n');
    const row = JSON.parse(rows[0]);
    row.ok = false;
    rows[0] = JSON.stringify(row);
    await fs.writeFile(file, rows.join('\n') + '\n');
    await assert.rejects(runHttpAudit({ ...f.options, fetcher: t.fetcher }), /LEDGER_INTEGRITY/);
    assert.equal(
      JSON.parse(await fs.readFile(join(f.options.output, 'summary.json'))).status,
      'HTTP_AUDIT_STOPPED',
    );
  }));
for (const fault of ['query', 'foreign', 'loop', 'chain'])
  test('legacy ' + fault + ' cannot pass, follow an old host or create a second hop', () =>
    withFixture(async (f) => {
      const t = f.transport({ legacyFault: fault }),
        result = await runHttpAudit({ ...f.options, fetcher: t.fetcher });
      assert.equal(result.status, 'HTTP_AUDIT_FAILED');
      assert.equal(result.failed, 2);
      assert(t.calls.every((url) => new URL(url).origin === preview));
    }),
  );
for (const fault of ['CSP', 'noindex'])
  test(fault + ' errors are recorded without data-error retries or success substitution', () =>
    withFixture(async (f) => {
      const t = f.transport({ metadataFault: fault }),
        result = await runHttpAudit({ ...f.options, fetcher: t.fetcher });
      assert.equal(result.status, 'HTTP_AUDIT_FAILED');
      for (const [url, count] of t.counts)
        if (!url.includes('/delivery-release.json')) assert.equal(count, 1);
    }),
  );
test('a changed after-control invalidates the epoch and cannot become a resumed pass', () =>
  withFixture(async (f) => {
    const t = f.transport({ changedAfter: true });
    await assert.rejects(
      runHttpAudit({ ...f.options, fetcher: t.fetcher }),
      /CONTROL_IDENTITY_CHANGED/,
    );
    assert.equal(
      JSON.parse(await fs.readFile(join(f.options.output, 'summary.json'))).status,
      'HTTP_AUDIT_STOPPED',
    );
    await assert.rejects(
      runHttpAudit({ ...f.options, fetcher: f.transport().fetcher }),
      /CONTROL_EPOCH_INVALIDATED/,
    );
  }));
test('an active audit output lock and an altered source/control contract cannot be bypassed', () =>
  withFixture(async (f) => {
    const t = f.transport();
    await runHttpAudit({ ...f.options, fetcher: t.fetcher, maxJobs: 1 });
    await assert.rejects(
      runHttpAudit({ ...f.options, fetcher: t.fetcher, expectedControlRevision: '0'.repeat(40) }),
      /RESUME_CONTRACT_DIFFERS/,
    );
    await fs.writeFile(
      join(f.options.output, 'audit.lock'),
      JSON.stringify({ pid: process.pid, host: hostname(), contract: 'unused' }),
    );
    await assert.rejects(
      runHttpAudit({ ...f.options, fetcher: t.fetcher }),
      /AUDIT_ALREADY_LOCKED/,
    );
  }));
