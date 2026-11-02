import test from 'node:test';
import { HARD_CAP } from '../scripts/r2/plan.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, unlinkSync,
  utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { preparePublication, preparePublicationWaves, publicationSourceCacheStats } from '../scripts/r2/prepare-publication.mjs';
import {
  ASSET_ORIGIN,
  MIME_TYPES,
  SITE_ORIGIN,
  validatePublication,
  verifyCatalogSourcesAtRoot,
} from '../scripts/publication-policy.mjs';
import { artwork, manifestFor, waveFor, date } from './fixtures/publication.mjs';
import { releaseFixture } from './fixtures/publication-release.mjs';
import { completeReleaseMediaWaveJournals } from '../scripts/r2/binding-waves.mjs';
function environment(items, bodies, wave, overrides = {}) {
  const calls = [];
  return {
    calls,
    options: {
      catalog: items,
      ...wave,
      readAsset: (path) => bodies.get(path),
      now: () => Date.parse(date),
      fetcher: async (url, options) => {
        calls.push(url);
        assert.equal(options.headers.Origin, SITE_ORIGIN);
        assert.equal(options.redirect, 'error');
        const object = wave.batch.find((x) => `${ASSET_ORIGIN}/${x.key}` === url);
        assert.ok(object, 'Only newly uploaded URLs may be fetched');
        const kind = object.kind === 'thumbnail' ? 'thumb' : object.kind;
        const item = items.find((x) => x.id === object.assetId);
        return new Response(overrides.body ?? bodies.get(item[kind]), {
          status: overrides.status ?? 200,
          headers: {
            'content-type': MIME_TYPES[kind],
            'access-control-allow-origin': SITE_ORIGIN,
            ...overrides.headers,
          },
        });
      },
    },
  };
}

function diskFixture(bodies) {
  const root = mkdtempSync(join(tmpdir(), 'uc-publication-source-'));
  mkdirSync(join(root, 'public'), { recursive: true });
  for (const [path, body] of bodies) {
    const target = join(root, 'public', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return { root, source: (path) => join(root, 'public', path), close: () => rmSync(root, { recursive: true, force: true }) };
}
test('two sequential waves retain old URLs and verify only new CDN files', async () => {
  const bodies = new Map(),
    a = artwork('first-artwork', bodies),
    b = artwork('second-artwork', bodies);
  const one = environment([a], bodies, waveFor([a]));
  const first = await preparePublication({ prior: null, ...one.options });
  assert.equal(publicationSourceCacheStats(first), null);
  assert.equal(one.calls.length, 4);
  const two = environment([a, b], bodies, waveFor([b]));
  const second = await preparePublication({ prior: first, ...two.options });
  assert.equal(two.calls.length, 4);
  assert.equal(second.files.length, 8);
  assert.deepEqual(
    second.files.filter((x) => x.assetId === a.id),
    first.files,
  );
  assert.ok(
    second.files
      .filter((x) => x.assetId === b.id)
      .every((x) => x.url.includes(x.sha256.slice(0, 16))),
  );
  assert.equal(validatePublication(second, [a, b], (path) => bodies.get(path)).files, 8);
});
test('existing flat pilot URLs survive adding a content-addressed production wave', async () => {
  const bodies = new Map(),
    a = artwork('existing-pilot', bodies),
    b = artwork('next-artwork', bodies),
    prior = manifestFor([a]);
  const e = environment([a, b], bodies, waveFor([b]));
  const result = await preparePublication({ prior, ...e.options });
  assert.deepEqual(
    result.files.filter((x) => x.assetId === a.id),
    prior.files,
  );
  assert.equal(e.calls.length, 4);
});
test('incomplete or unverified journals cannot produce a publication manifest', async () => {
  for (const mutate of [
    (j) => (j.status = 'uploading'),
    (j) => (j.batchSha256 = 'b'.repeat(64)),
    (j) => j.verifiedObjects.pop(),
    (j) => (j.verifiedArtworkIds = []),
    (j) => (j.verifiedObjects[0].sha256 = 'c'.repeat(64)),
    (j) => j.inventoryScope.jurisdictions.pop(),
    (j) => (j.aggregateBytes = HARD_CAP + 1),
  ]) {
    const bodies = new Map(),
      a = artwork('drawing-one', bodies),
      wave = waveFor([a]);
    mutate(wave.journal);
    const e = environment([a], bodies, wave);
    await assert.rejects(preparePublication({ prior: null, ...e.options }));
    assert.equal(e.calls.length, 0);
  }
});
test('an incomplete next catalog or mismatched local content fails before network reads', async () => {
  const bodies = new Map(),
    a = artwork('drawing-one', bodies),
    b = artwork('drawing-two', bodies),
    wave = waveFor([a]);
  const e = environment([a, b], bodies, wave);
  await assert.rejects(
    preparePublication({ prior: null, ...e.options }),
    /Incomplete next publication/,
  );
  assert.equal(e.calls.length, 0);
  bodies.set(a.svg, Buffer.from('modified'));
  const changed = environment([a], bodies, wave);
  await assert.rejects(
    preparePublication({ prior: null, ...changed.options }),
    /Local source differs/,
  );
  assert.equal(changed.calls.length, 0);
});
test('CDN MIME, CORS, status and full-byte checks all gate verification', async () => {
  for (const overrides of [
    { headers: { 'content-type': 'text/plain' } },
    { headers: { 'access-control-allow-origin': 'https://wrong.example' } },
    { status: 404 },
    { body: Buffer.from('wrong bytes') },
  ]) {
    const bodies = new Map(),
      a = artwork('drawing-one', bodies),
      e = environment([a], bodies, waveFor([a]), overrides);
    await assert.rejects(preparePublication({ prior: null, ...e.options }), /CDN/);
  }
});
test('changed artwork requires its new complete upload journal and refreshes only changed files', async () => {
  const bodies = new Map(),
    a = artwork('drawing-one', bodies),
    prior = manifestFor([a]);
  const { digest } = await import('./fixtures/publication.mjs');
  const body = Buffer.from('new original svg revision');
  bodies.set(a.svg, body);
  a.files.svg = { bytes: body.length, sha256: digest(body) };
  const e = environment([a], bodies, waveFor([a]));
  const result = await preparePublication({ prior, ...e.options });
  assert.equal(e.calls.length, 1);
  assert.notEqual(
    result.files.find((x) => x.kind === 'svg').url,
    prior.files.find((x) => x.kind === 'svg').url,
  );
  for (const kind of ['pdf', 'webp', 'thumb'])
    assert.equal(
      result.files.find((x) => x.kind === kind).url,
      prior.files.find((x) => x.kind === kind).url,
    );
});

test('transient CDN failures retry at most three fresh reads and preserve byte verification', async () => {
  for (const failure of ['network', 'timeout', 'http', 'stream']) {
    const bodies = new Map(),
      a = artwork('drawing-one', bodies),
      e = environment([a], bodies, waveFor([a])),
      fetcher = e.options.fetcher,
      attempts = new Map(),
      delays = [];
    const result = await preparePublication({
      prior: null,
      ...e.options,
      retryWait: async (ms) => delays.push(ms),
      fetcher: async (url, options) => {
        const attempt = (attempts.get(url) ?? 0) + 1;
        attempts.set(url, attempt);
        const response = await fetcher(url, options);
        if (attempt === 3) return response;
        if (failure === 'network') throw new TypeError('fetch failed');
        if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError');
        if (failure === 'http') return new Response(null, { status: attempt === 1 ? 503 : 429 });
        const body = new Uint8Array(await response.arrayBuffer());
        let first = true;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (first) {
                first = false;
                controller.enqueue(body.slice(0, Math.max(1, Math.floor(body.length / 2))));
              } else controller.error(new TypeError('terminated'));
            },
          }),
          { headers: response.headers },
        );
      },
    });
    assert.equal(e.calls.length, 12, failure);
    assert.deepEqual([...attempts.values()], [3, 3, 3, 3], failure);
    assert.deepEqual(
      delays.sort((a, b) => a - b),
      [250, 250, 250, 250, 1000, 1000, 1000, 1000],
    );
    assert.equal(validatePublication(result, [a], (path) => bodies.get(path)).files, 4);
  }
});

test('persistent transport failures stop after the third attempt', async () => {
  const bodies = new Map(),
    a = artwork('drawing-one', bodies),
    e = environment([a], bodies, waveFor([a])),
    fetcher = e.options.fetcher;
  await assert.rejects(
    preparePublication({
      prior: null,
      ...e.options,
      retryWait: async () => {},
      fetcher: async (url, options) => {
        await fetcher(url, options);
        throw new TypeError('fetch failed');
      },
    }),
    /CDN verification could not fetch/,
  );
  assert.equal(e.calls.length, 12);
});

test('integrity, MIME, CORS, missing files and redirects fail without retries', async () => {
  for (const overrides of [
    { headers: { 'content-type': 'text/plain' } },
    { headers: { 'access-control-allow-origin': 'https://wrong.example' } },
    { status: 404 },
    { body: Buffer.from('same-size-corruption') },
    { redirect: true },
  ]) {
    const bodies = new Map(),
      a = artwork('drawing-one', bodies),
      e = environment([a], bodies, waveFor([a]), overrides),
      fetcher = e.options.fetcher;
    await assert.rejects(
      preparePublication({
        prior: null,
        ...e.options,
        retryWait: async () => assert.fail('Integrity failures cannot be retried'),
        fetcher: async (url, options) => {
          const response = await fetcher(url, options);
          if (overrides.redirect)
            throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
          return response;
        },
      }),
      /CDN/,
    );
    assert.equal(e.calls.length, 4);
  }
});

test('verified bounded waves share one full source pass and retain unchanged prior URLs', async () => {
  const bodies = new Map(),
    old = artwork('old-scene', bodies),
    a = artwork('first-wave', bodies),
    b = artwork('second-wave', bodies),
    one = waveFor([a]),
    two = waveFor([b]),
    prior = manifestFor([old]),
    reads = new Map();
  const env = environment([old, a, b], bodies, { batch: [...one.batch, ...two.batch] });
  const result = await preparePublicationWaves({
    prior,
    ...env.options,
    waves: [one, two],
    readAsset: (p) => {
      reads.set(p, (reads.get(p) ?? 0) + 1);
      return bodies.get(p);
    },
  });
  assert.equal(result.files.length, 12);
  assert.equal(env.calls.length, 8);
  assert.deepEqual(
    result.files.filter((f) => f.assetId === old.id),
    prior.files,
  );
  assert.equal(reads.get(old.webp), 2);
});
test('any invalid multi-wave receipt or duplicate artwork stops all CDN reads', async () => {
  for (const mode of ['stale', 'coverage', 'duplicate', 'oversized']) {
    const bodies = new Map(),
      a = artwork('wave-first', bodies),
      b = artwork('wave-next', bodies);
    let items = [a, b],
      waves = [waveFor([a]), waveFor([b])];
    if (mode === 'stale') waves[1].journal.status = 'uploading';
    if (mode === 'coverage') waves[1].journal.inventoryScope.jurisdictions.pop();
    if (mode === 'duplicate') waves = [waves[0], waves[0]];
    if (mode === 'oversized') {
      items = Array.from({ length: 51 }, (_, i) => artwork('large-wave-' + i, bodies));
      waves = [waveFor(items)];
    }
    let calls = 0;
    await assert.rejects(
      preparePublicationWaves({
        prior: null,
        catalog: items,
        waves,
        readAsset: (p) => bodies.get(p),
        fetcher: async () => {
          calls++;
          throw Error('must not fetch');
        },
      }),
    );
    assert.equal(calls, 0);
  }
});

test('release-scoped journals prepare a complete multi-wave catalog and verify actual CDN bytes', async () => {
  const bodies = new Map(),
    a = artwork('release-first', bodies),
    b = artwork('release-second', bodies);
  const f = releaseFixture([[a], [b]]),
    journals = completeReleaseMediaWaveJournals(f);
  const waves = f.waves.map((wave, i) => ({ ...wave, journal: journals[i] }));
  const env = environment([a, b], bodies, { batch: waves.flatMap((wave) => wave.batch) });
  const result = await preparePublicationWaves({ prior: null, ...env.options, waves });
  assert.equal(result.files.length, 8);
  assert.equal(env.calls.length, 8);
  assert.equal(validatePublication(result, [a, b], (path) => bodies.get(path)).files, 8);
});

test('schema 3 fails before CDN on modified proof, scope, byte sums or fake account usage', async () => {
  const variants = [
    (waves) => (waves[0].journal.root = 'c'.repeat(64)),
    (waves) => (waves[0].journal.revision = 'c'.repeat(40)),
    (waves) => (waves[0].journal.accountId = 'c'.repeat(32)),
    (waves) => waves[0].journal.authorizedBytes++,
    (waves) => waves[0].journal.waveBytes++,
    (waves) => (waves[0].journal.accountUsageMeasured = true),
    (waves) => (waves[0].journal.aggregateBytes = 0),
    (waves) => (waves[0].journal.inventoryScope = {}),
    (waves) => (waves[0].journal.verifiedObjects[0].releaseProof[0].hash = 'c'.repeat(64)),
    (waves) => waves[0].journal.verifiedObjects[0].releaseRecord.wave++,
    (waves) => (waves[0].journal.verifiedObjects[0].releaseRecord.assetId = 'unrelated'),
    (waves) => (waves[0].journal.verifiedObjects[0].bucket = 'other-bucket'),
    (waves) => (waves[0].journal.verifiedObjects[0].jurisdiction = 'eu'),
    (waves) => (waves[0].journal.verifiedArtworkIds = []),
    (waves) => waves[0].journal.verifiedObjects.pop(),
    (waves) => (waves[0].journal.publishApproved = true),
    (waves) => waves.pop(),
    (waves) => (waves[0].journal = waveFor([waves[0].item]).journal),
  ];
  for (const mutate of variants) {
    const bodies = new Map(),
      a = artwork('release-first', bodies),
      b = artwork('release-second', bodies);
    const f = releaseFixture([[a], [b]]),
      journals = completeReleaseMediaWaveJournals(f);
    const waves = f.waves.map((wave, i) => ({ ...wave, item: [a, b][i], journal: journals[i] }));
    mutate(waves);
    const env = environment([a, b], bodies, { batch: f.waves.flatMap((wave) => wave.batch) });
    await assert.rejects(preparePublicationWaves({ prior: null, ...env.options, waves }));
    assert.equal(env.calls.length, 0);
  }
});

test('one publication accepts two independently verified complete release cohorts', async () => {
  const bodies = new Map();
  const a = artwork('cohort-a1', bodies),
    b = artwork('cohort-a2', bodies),
    c = artwork('cohort-b1', bodies);
  const first = releaseFixture([[a], [b]]),
    second = releaseFixture([[c]]);
  assert.notEqual(first.job.root, second.job.root);
  const cohortWaves = (f) => {
    const journals = completeReleaseMediaWaveJournals(f);
    return f.waves.map((wave, i) => ({ ...wave, journal: journals[i] }));
  };
  const waves = [...cohortWaves(first), ...cohortWaves(second)];
  const env = environment([a, b, c], bodies, { batch: waves.flatMap((w) => w.batch) });
  const result = await preparePublicationWaves({ prior: null, ...env.options, waves });
  assert.equal(result.files.length, 12);
  assert.equal(env.calls.length, 12);
});

test('multi-cohort preparation rejects a partial cohort or an inconsistent shared root before CDN', async () => {
  for (const mode of ['partial', 'root-revision', 'root-bytes', 'cross-cohort-artwork']) {
    const bodies = new Map();
    const a = artwork('cohort-a1', bodies),
      b = artwork('cohort-a2', bodies),
      c = artwork('cohort-b1', bodies);
    const first = releaseFixture([[a], [b]]);
    const second = releaseFixture(mode === 'cross-cohort-artwork' ? [[a], [c]] : [[c]]);
    const build = (f) => {
      const journals = completeReleaseMediaWaveJournals(f);
      return f.waves.map((wave, i) => ({ ...wave, journal: journals[i] }));
    };
    const one = build(first),
      two = build(second),
      waves = [...one, ...two];
    if (mode === 'partial') waves.splice(1, 1);
    if (mode === 'root-revision') one[1].journal.revision = 'd'.repeat(40);
    if (mode === 'root-bytes') one[1].journal.authorizedBytes++;
    const env = environment([a, b, c], bodies, { batch: waves.flatMap((w) => w.batch) });
    await assert.rejects(preparePublicationWaves({ prior: null, ...env.options, waves }));
    assert.equal(env.calls.length, 0);
  }
});

test('single-wave publication cannot silently accept part of a multi-wave release cohort', async () => {
  const bodies = new Map(),
    a = artwork('cohort-a1', bodies),
    b = artwork('cohort-a2', bodies);
  const f = releaseFixture([[a], [b]]),
    journals = completeReleaseMediaWaveJournals(f);
  const wave = { ...f.waves[0], journal: journals[0] };
  const env = environment([a], bodies, wave);
  await assert.rejects(
    preparePublication({ prior: null, ...env.options }),
    /complete release cohort/,
  );
  assert.equal(env.calls.length, 0);
  const complete = releaseFixture([[a]]),
    [journal] = completeReleaseMediaWaveJournals(complete);
  const fullEnv = environment([a], bodies, { ...complete.waves[0], journal });
  const result = await preparePublication({ prior: null, ...fullEnv.options });
  assert.equal(result.files.length, 4);
});

test('root-bound multi-wave preparation reuses old source proofs and hashes only new bytes', async () => {
  const bodies = new Map(), old = artwork('cached-old', bodies), fresh = artwork('cached-fresh', bodies);
  const f = diskFixture(bodies), wave = waveFor([fresh]), prior = manifestFor([old]);
  try {
    const warm = verifyCatalogSourcesAtRoot(f.root, [old]);
    assert.deepEqual({ files: warm.files, hashed: warm.hashed, reused: warm.reused }, { files: 4, hashed: 4, reused: 0 });
    const env = environment([old, fresh], bodies, wave);
    const result = await preparePublicationWaves({ prior, ...env.options, readAsset: undefined,
      sourceRoot: f.root, waves: [wave] });
    const sourceCacheStats = publicationSourceCacheStats(result);
    assert.equal(env.calls.length, 4, 'only new CDN objects are read');
    assert.equal(result.files.length, 8);
    assert.deepEqual(result.files.filter((x) => x.assetId === old.id), prior.files);
    assert.equal(sourceCacheStats.preflight.hashed, 4);
    assert.equal(sourceCacheStats.preflight.reused, 4);
    assert.equal(sourceCacheStats.preflight.hashedBytes,
      Object.values(fresh.files).reduce((sum, file) => sum + file.bytes, 0));
    assert.equal(sourceCacheStats.final.hashed, 0);
    assert.equal(sourceCacheStats.final.reused, 8);
    assert.equal(sourceCacheStats.final.hashedBytes, 0);
    assert(!JSON.stringify(result).includes('sourceCacheStats'), 'diagnostics are not publication metadata');
    sourceCacheStats.preflight.hashed = 999;
    assert.equal(publicationSourceCacheStats(result).preflight.hashed, 4, 'diagnostics cannot mutate internal state');
  } finally { f.close(); }
});

test('tampered or corrupt source-cache signatures trigger real byte hashing, never approval', () => {
  const bodies = new Map(), old = artwork('cache-corruption', bodies), f = diskFixture(bodies);
  try {
    verifyCatalogSourcesAtRoot(f.root, [old]);
    const indexPath = join(f.root, '.asset-integrity/sources.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const path = Object.keys(index.entries)[0];
    index.entries[path].signature = '0'.repeat(64);
    writeFileSync(indexPath, JSON.stringify(index));
    const tampered = verifyCatalogSourcesAtRoot(f.root, [old]);
    assert.equal(tampered.hashed, 1);
    assert.equal(tampered.reused, 3);
    writeFileSync(indexPath, '{invalid json');
    const corrupt = verifyCatalogSourcesAtRoot(f.root, [old]);
    assert.equal(corrupt.hashed, 4);
    assert.equal(corrupt.reused, 0);
  } finally { f.close(); }
});

test('same-length edit with restored mtime invalidates local proof before CDN reads', async () => {
  const bodies = new Map(), old = artwork('mtime-old', bodies), fresh = artwork('mtime-new', bodies);
  const f = diskFixture(bodies), wave = waveFor([fresh]);
  try {
    verifyCatalogSourcesAtRoot(f.root, [old]);
    const file = f.source(old.webp), before = statSync(file), identity = statSync(file, { bigint: true });
    const changed = Buffer.from(readFileSync(file)); changed[0] ^= 1; writeFileSync(file, changed);
    utimesSync(file, before.atime, before.mtime);
    assert.notEqual(statSync(file, { bigint: true }).ctimeNs, identity.ctimeNs);
    assert.equal(statSync(file).size, before.size);
    assert(Math.abs(statSync(file).mtimeMs - before.mtimeMs) < 1);
    const env = environment([old, fresh], bodies, wave);
    await assert.rejects(preparePublicationWaves({ prior: manifestFor([old]), ...env.options,
      readAsset: undefined, sourceRoot: f.root, waves: [wave] }), /Source changed/);
    assert.equal(env.calls.length, 0);
  } finally { f.close(); }
});

test('missing, escaped and ambiguous source roots fail before any CDN read', async () => {
  for (const mode of ['missing', 'escaped', 'public-root-symlink', 'relative', 'ambiguous']) {
    const bodies = new Map(), old = artwork('unsafe-old', bodies), fresh = artwork('unsafe-new', bodies);
    const f = diskFixture(bodies), wave = waveFor([fresh]), env = environment([old, fresh], bodies, wave);
    const outside = mkdtempSync(join(tmpdir(), 'uc-outside-'));
    try {
      let sourceRoot = f.root, readAsset;
      if (mode === 'missing') unlinkSync(f.source(old.webp));
      if (mode === 'escaped') {
        const external = join(outside, 'outside.webp'); writeFileSync(external, bodies.get(old.webp));
        unlinkSync(f.source(old.webp)); symlinkSync(external, f.source(old.webp));
      }
      if (mode === 'public-root-symlink') {
        rmSync(join(f.root, 'public'), { recursive: true });
        symlinkSync(outside, join(f.root, 'public'));
      }
      if (mode === 'relative') sourceRoot = '.';
      if (mode === 'ambiguous') readAsset = () => Buffer.from('fake');
      await assert.rejects(preparePublicationWaves({ prior: manifestFor([old]), ...env.options,
        readAsset, sourceRoot, waves: [wave] }));
      assert.equal(env.calls.length, 0, mode);
    } finally { f.close(); rmSync(outside, { recursive: true, force: true }); }
  }
});

test('a local source changed during CDN checks is rejected by the final root-bound validation', async () => {
  const bodies = new Map(), old = artwork('race-old', bodies), fresh = artwork('race-new', bodies);
  const f = diskFixture(bodies), wave = waveFor([fresh]), env = environment([old, fresh], bodies, wave);
  try {
    verifyCatalogSourcesAtRoot(f.root, [old]);
    const fetcher = env.options.fetcher;
    let changed = false;
    await assert.rejects(preparePublicationWaves({ prior: manifestFor([old]), ...env.options,
      readAsset: undefined, sourceRoot: f.root, waves: [wave], fetcher: async (...args) => {
        if (!changed) {
          changed = true;
          const path = f.source(old.webp), bytes = Buffer.from(readFileSync(path));
          bytes[0] ^= 1; writeFileSync(path, bytes);
        }
        return fetcher(...args);
      } }), /Source changed/);
    assert.equal(env.calls.length, 4);
  } finally { f.close(); }
});

test('root-bound cache never bypasses CDN bytes or format checks', async () => {
  const bodies = new Map(), old = artwork('cdn-old', bodies), fresh = artwork('cdn-new', bodies);
  const f = diskFixture(bodies), wave = waveFor([fresh]);
  try {
    verifyCatalogSourcesAtRoot(f.root, [old, fresh]);
    const env = environment([old, fresh], bodies, wave, { headers: { 'content-type': 'text/plain' } });
    await assert.rejects(preparePublicationWaves({ prior: manifestFor([old]), ...env.options,
      readAsset: undefined, sourceRoot: f.root, waves: [wave] }), /CDN MIME/);
    assert.equal(env.calls.length, 4);
    const checksum = environment([old, fresh], bodies, wave), fetcher = checksum.options.fetcher;
    await assert.rejects(preparePublicationWaves({ prior: manifestFor([old]), ...checksum.options,
      readAsset: undefined, sourceRoot: f.root, waves: [wave], fetcher: async (...args) => {
        const response = await fetcher(...args), bytes = Buffer.from(await response.arrayBuffer());
        bytes[0] ^= 1;
        return new Response(bytes, { status: 200, headers: response.headers });
      } }), /CDN checksum/);
    assert.equal(checksum.calls.length, 4);
  } finally { f.close(); }
});

test('root-bound preflight rejects altered new sources and invalid retained URLs before CDN', async () => {
  for (const mode of ['fresh-source', 'old-url']) {
    const bodies = new Map(), old = artwork('preflight-old', bodies), fresh = artwork('preflight-new', bodies);
    const f = diskFixture(bodies), wave = waveFor([fresh]), prior = manifestFor([old]);
    const env = environment([old, fresh], bodies, wave);
    try {
      verifyCatalogSourcesAtRoot(f.root, [old]);
      if (mode === 'fresh-source') {
        const path = f.source(fresh.webp), bytes = Buffer.from(readFileSync(path));
        bytes[0] ^= 1; writeFileSync(path, bytes);
      } else prior.files[0].url = `${ASSET_ORIGIN}/mutable.svg`;
      await assert.rejects(preparePublicationWaves({ prior, ...env.options,
        readAsset: undefined, sourceRoot: f.root, waves: [wave] }));
      assert.equal(env.calls.length, 0, mode);
    } finally { f.close(); }
  }
});

test('CDN concurrency is bounded with a default of 16 and configurable 1..32', async () => {
  for (const configured of [undefined, 1, 3, 32]) {
    const bodies = new Map(), items = Array.from({ length: 6 }, (_, n) => artwork(`bounded-${n}`, bodies));
    const wave = waveFor(items), env = environment(items, bodies, wave), fetcher = env.options.fetcher;
    let active = 0, maximum = 0, started = 0, release;
    const gate = new Promise((resolve) => { release = resolve; });
    const task = preparePublication({ prior: null, ...env.options, readConcurrency: configured,
      fetcher: async (...args) => {
        active++; started++; maximum = Math.max(maximum, active);
        await gate;
        try { return await fetcher(...args); } finally { active--; }
      } });
    const expected = Math.min(configured ?? 16, 24);
    for (let i = 0; i < 100 && started < expected; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(started, expected);
    assert.equal(maximum, expected);
    release();
    const result = await task;
    assert.equal(result.files.length, 24);
    assert.equal(env.calls.length, 24);
    assert(maximum <= expected);
  }
  for (const readConcurrency of [0, -1, 33, 1.5, NaN, '16']) {
    const bodies = new Map(), a = artwork('invalid-concurrency', bodies), wave = waveFor([a]);
    const env = environment([a], bodies, wave);
    await assert.rejects(preparePublication({ prior: null, ...env.options, readConcurrency }), /concurrency/);
    assert.equal(env.calls.length, 0);
    await assert.rejects(preparePublicationWaves({ prior: null, ...env.options, waves: [wave], readConcurrency }), /concurrency/);
    assert.equal(env.calls.length, 0);
  }
});

test('failed concurrent CDN verification waits for other in-flight workers', async () => {
  const bodies = new Map(), item = artwork('settled-check', bodies), wave = waveFor([item]);
  const env = environment([item], bodies, wave), fetcher = env.options.fetcher;
  let started = 0, release, settled = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const task = preparePublication({ prior: null, ...env.options, readConcurrency: 2,
    fetcher: async (...args) => {
      started++;
      if (started === 1) throw Error('terminal verification failure');
      await gate;
      return fetcher(...args);
    } });
  task.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 100 && started < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(started, 2);
  assert.equal(settled, false);
  release();
  await assert.rejects(task, /CDN verification could not fetch/);
  assert.equal(settled, true);
});

test('root-bound multi-wave schema-3 verifies exact cohort paths, source bytes and CDN receipts', async () => {
  const bodies = new Map(), old = artwork('root-scope-old', bodies), a = artwork('root-scope-a', bodies),
    b = artwork('root-scope-b', bodies), f = diskFixture(bodies);
  try {
    verifyCatalogSourcesAtRoot(f.root, [old]);
    const release = releaseFixture([[a], [b]]), journals = completeReleaseMediaWaveJournals(release);
    const waves = release.waves.map((wave, i) => ({ ...wave, journal: journals[i] }));
    const env = environment([old, a, b], bodies, { batch: waves.flatMap((wave) => wave.batch) });
    const result = await preparePublicationWaves({ prior: manifestFor([old]), ...env.options,
      readAsset: undefined, sourceRoot: f.root, waves });
    const stats = publicationSourceCacheStats(result);
    assert.equal(result.files.length, 12);
    assert.equal(env.calls.length, 8);
    assert.equal(stats.preflight.hashed, 8);
    assert.equal(stats.preflight.reused, 4);
    assert.equal(stats.final.reused, 12);
    const altered = structuredClone(waves);
    altered[0].batch[0].path = join(tmpdir(), 'unrelated', altered[0].batch[0].path);
    const rejected = environment([old, a, b], bodies, { batch: altered.flatMap((wave) => wave.batch) });
    await assert.rejects(preparePublicationWaves({ prior: manifestFor([old]), ...rejected.options,
      readAsset: undefined, sourceRoot: f.root, waves: altered }), /scope|path/);
    assert.equal(rejected.calls.length, 0);
  } finally { f.close(); }
});
