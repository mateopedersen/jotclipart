import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertAppendOnlyCatalog,
  normalizeRendererSource,
  planIncrementalRelease,
  validateIncrementalPlan,
  materializeIncrementalSource,
  incrementalCollectionOptions,
} from '../scripts/delivery/incremental.mjs';
import { collectDeliveryFiles, merkle, digest } from '../scripts/delivery/manifest.mjs';
import { createPublicFileHandler } from '../server/delivery/public-files.mjs';

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'uc-incremental-')),
    root = join(temporary, 'work/ultraclipart-gta');
  mkdirSync(root, { recursive: true });
  const put = (path, value) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const old = { id: 'old', title: 'Old image', published: true, indexable: true, topic: 'old' };
  put('.gitignore', 'work/\ndist/\n.asset-integrity/\n');
  put('data/art.json', [old]);
  put('data/publication.json', { files: [] });
  put('data/topics.json', { topics: [{ slug: 'old', keyword: 'Old clipart' }] });
  put('data/extra-topics.json', []);
  put('data/retired-artwork.json', { artworkIds: [] });
  put('data/editorial/reviews.json', {
    schema: 1,
    artworks: [{ id: 'old', copy: 'Old reviewed copy' }],
  });
  put('src/pages/art/[id].astro', 'export function getStaticPaths() { return art.map(a => a); }\n');
  put(
    'src/pages/edit/[id].astro',
    'export function getStaticPaths() { return art.map(a => a); }\n',
  );
  put('src/layouts/Layout.astro', '<html>unchanged shared layout</html>');
  put('astro.config.mjs', 'export default {};\n');
  put('server/api.mjs', 'export const fixed = true;\n');
  put('package.json', { name: 'fixture', private: true });
  git('init', '--quiet');
  git('add', '.');
  const commit = () => {
    git('add', 'data');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  const base = commit();
  for (const kind of ['art', 'edit'])
    put(
      `dist/${kind}/old/index.html`,
      `<meta name="build-revision" content="${base}"><h1>Old image</h1>`,
    );
  put(`dist/previews/p1/${'b'.repeat(24)}-440.webp`, 'verified preview bytes');
  put('dist/_astro/runtime.123.js', 'console.log("fixed")');
  put('dist/index.html', 'complete rollback homepage');
  const files = collectDeliveryFiles(join(root, 'dist'), base),
    tree = merkle(files);
  put(`work/delivery/${base}/verified-manifest.json`, {
    schema: 1,
    status: 'remote-byte-verified',
    revision: base,
    bucket: 'ultraclipart-pages',
    root: tree.root,
    files,
    verified: files.length,
  });
  const report = join(
    temporary,
    'work/ultraclipart/work/remaining-cloudflare-production-report.json',
  );
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(
    report,
    JSON.stringify({
      liveDelivery: { renderedRevision: base, verifiedRoot: tree.root },
      tests: {
        automatedPassed: 1,
        automatedFailed: 0,
        imageSeoErrors: 0,
        linkErrors: 0,
        coreSeoErrors: 0,
      },
    }),
  );
  const append = () => {
    put('data/art.json', [old, { ...old, id: 'new', title: 'New reviewed image' }]);
    return commit();
  };
  const plan = () =>
    planIncrementalRelease(root, {
      relatedAnalysis: async () => ({ version: 'fixture-related-v1', affectedArtworkIds: [] }),
    });
  return {
    temporary,
    root,
    put,
    git,
    old,
    commit,
    append,
    base,
    files,
    plan,
    close: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

test('append-only analysis permits new records but never edits, removes or duplicates an accepted artwork', () => {
  const old = [{ id: 'old', title: 'Accepted', files: { sha256: 'source' } }];
  assert.deepEqual(
    assertAppendOnlyCatalog(old, [...old, { id: 'new', published: true, indexable: true }]),
    ['new'],
  );
  for (const after of [[], [{ ...old[0], title: 'Changed' }], [old[0], old[0]]])
    assert.throws(() => assertAppendOnlyCatalog(old, after));
});

test('only exact server-build wrappers normalize; real template edits remain visible', () => {
  const path = 'src/pages/art/[id].astro',
    original = 'return art.map(a => a);\n';
  const wrapped =
    "import { renderArtworkScope } from '../../lib/delivery-build-scope';\nreturn renderArtworkScope(art).map(a => a);\n";
  assert.equal(normalizeRendererSource(path, wrapped), original);
  assert.notEqual(normalizeRendererSource(path, wrapped + '<h1>New UI</h1>'), original);
});

test('a verified append builds only new pairs and inherits exact old bytes without modifying rollback files', async () => {
  const f = fixture();
  try {
    const next = f.append(),
      plan = await f.plan();
    assert.equal(plan.revision, next);
    assert.deepEqual(plan.artworkIds, ['new']);
    validateIncrementalPlan(f.root, plan);
    const output = join(f.root, 'next');
    mkdirSync(output);
    f.put('next/related-release.json', { version: plan.relatedVersion });
    for (const kind of ['art', 'edit'])
      f.put(
        `next/${kind}/new/index.html`,
        `<meta name="build-revision" content="${next}"><h1>New reviewed image</h1>`,
      );
    const before = readFileSync(join(plan.baselineSource, 'art/old/index.html'));
    assert.equal(materializeIncrementalSource(f.root, output, plan).inherited, f.files.length);
    const files = collectDeliveryFiles(output, next, incrementalCollectionOptions(f.root, plan));
    assert.equal(files.length, f.files.length + 2);
    assert.equal(
      files.find((file) => file.path === '/art/old/index.html').key,
      `delivery/${f.base}/art/old/index.html`,
    );
    assert.equal(
      files.find((file) => file.path === '/art/new/index.html').key,
      `delivery/${next}/art/new/index.html`,
    );
    writeFileSync(join(output, 'art/old/index.html'), 'mutated candidate');
    assert.deepEqual(readFileSync(join(plan.baselineSource, 'art/old/index.html')), before);
    assert.throws(
      () => collectDeliveryFiles(output, next, incrementalCollectionOptions(f.root, plan)),
      /Source changed/,
    );
  } finally {
    f.close();
  }
});

test('template, source, identity and stale plan changes force a full release instead of unsafe inheritance', async () => {
  const f = fixture();
  try {
    f.append();
    const plan = await f.plan();
    assert.throws(
      () => validateIncrementalPlan(f.root, { ...plan, artworkIds: [] }),
      /authentication/,
    );
    f.put('src/layouts/Layout.astro', '<html>new shared renderer</html>');
    assert.throws(() => validateIncrementalPlan(f.root, plan), /renderer changed/);
    f.put('src/layouts/Layout.astro', '<html>unchanged shared layout</html>');
    f.put('data/topics.json', { topics: [{ slug: 'old', keyword: 'Incorrect renamed identity' }] });
    assert.throws(() => validateIncrementalPlan(f.root, plan), /topic identity/);
    f.put('data/topics.json', { topics: [{ slug: 'old', keyword: 'Old clipart' }] });
    f.put('data/art.json', [{ ...f.old, title: 'Changed existing metadata' }]);
    assert.throws(() => validateIncrementalPlan(f.root, plan), /Existing artwork changed/);
  } finally {
    f.close();
  }
});

test('incomplete or changed baseline content cannot acquire an incremental plan', async () => {
  const f = fixture();
  try {
    f.append();
    f.put('dist/art/old/index.html', 'tampered original');
    await assert.rejects(f.plan(), /Source changed/);
  } finally {
    f.close();
  }
});

test('new reviews for new IDs are safe but old-ID approvals and new shared copy rules require full publication', async () => {
  const f = fixture();
  try {
    f.append();
    f.put('data/editorial/reviews.json', {
      schema: 1,
      artworks: [
        { id: 'old', copy: 'Old reviewed copy' },
        { id: 'new', copy: 'New source-bound copy' },
      ],
    });
    f.commit();
    await f.plan();
    f.put('data/editorial/reviews.json', {
      schema: 1,
      artworks: [
        { id: 'old', copy: 'Changed existing copy' },
        { id: 'new', copy: 'New source-bound copy' },
      ],
    });
    await assert.rejects(f.plan(), /Existing editorial/);
    f.put('data/editorial/reviews.json', {
      schema: 1,
      artworks: [
        { id: 'old', copy: 'Old reviewed copy' },
        { id: 'new', copy: 'New source-bound copy' },
      ],
    });
    f.put('data/retired-artwork.json', { artworkIds: ['old'] });
    await assert.rejects(f.plan(), /Existing editorial/);
  } finally {
    f.close();
  }
});

test('atomic routing isolates old/new HTML keys while preserving withdrawals and cache versioning', async () => {
  const old = 'a'.repeat(40),
    next = 'b'.repeat(40),
    keys = [],
    cacheKeys = [];
  const handle = createPublicFileHandler({
    revision: next,
    ids: ['old', 'new', 'held'],
    withdrawnIds: ['held'],
    htmlRevisions: [[old, ['old']]],
    pageHeaders: { 'Content-Security-Policy': 'checked' },
    editorHeaders: { 'X-Robots-Tag': 'noindex' },
  });
  const env = {
    CATALOG_PAGES: {
      get: async (key) => {
        keys.push(key);
        return {
          size: 7,
          body: 'checked',
          httpEtag: 'etag',
          httpMetadata: { contentType: 'text/html' },
        };
      },
    },
  };
  const fallback = { fetch: () => new Response('missing', { status: 404 }) };
  const cache = {
    match: async (request) => {
      cacheKeys.push(request.url);
      return null;
    },
  };
  const before = await handle(
    new Request('https://example.test/art/old/'),
    env,
    null,
    fallback,
    cache,
  );
  const after = await handle(
    new Request('https://example.test/art/new/'),
    env,
    null,
    fallback,
    cache,
  );
  assert.equal(before.headers.get('X-UC-Delivery'), `r2; html=${old}`);
  assert.equal(after.headers.get('X-UC-Delivery'), `r2; html=${next}`);
  assert.deepEqual(keys, [
    `delivery/${old}/art/old/index.html`,
    `delivery/${next}/art/new/index.html`,
  ]);
  assert(cacheKeys.every((key) => key.includes(next)));
  assert.equal(
    (await handle(new Request('https://example.test/art/held/'), env, null, fallback)).status,
    404,
  );
  assert.throws(
    () =>
      createPublicFileHandler({
        revision: next,
        ids: ['old'],
        htmlRevisions: [[old, ['foreign']]],
      }),
    /Foreign/,
  );
});
