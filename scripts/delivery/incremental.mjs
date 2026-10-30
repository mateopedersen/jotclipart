import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  constants,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { digest, merkle } from './manifest.mjs';
import {
  verifiedSourceCache,
  authenticateLocalState,
  verifyLocalState,
} from '../verified-source-cache.mjs';
import { readPublication } from '../publication-policy.mjs';
import { relatedImpact } from './related-impact.mjs';

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const ordered = (v) =>
  Array.isArray(v)
    ? v.map(ordered)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, ordered(v[k])]),
        )
      : v;
const canonical = (v) => JSON.stringify(ordered(v));
const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128_000_000 });
const oldJson = (root, revision, path) => JSON.parse(git(root, ['show', `${revision}:${path}`]));
const infrastructure = (path) =>
  path.startsWith('scripts/delivery/') ||
  path.startsWith('server/delivery/') ||
  [
    'scripts/verified-source-cache.mjs',
    'scripts/deploy.mjs',
    'scripts/publication-policy.mjs',
    'scripts/restore-assets.mjs',
    'scripts/production-public-assets.mjs',
    'scripts/seo/indexnow-release.mjs',
    'scripts/performance/serve.mjs',
    'src/lib/delivery-build-scope.ts',
  ].includes(path);

// These exact server-only wrappers do not alter a rendered page. Any other
// template, style, runtime, dependency or server change requires a full build.
export function normalizeRendererSource(path, source) {
  if (['src/pages/art/[id].astro', 'src/pages/edit/[id].astro'].includes(path))
    return source
      .replace(
        /^import \{ renderArtworkScope \} from ['"]\.\.\/\.\.\/lib\/delivery-build-scope['"];\r?\n/m,
        '',
      )
      .replaceAll('renderArtworkScope(art).map', 'art.map');
  if (path === 'astro.config.mjs')
    return source
      .replace(
        /^import \{ incrementalInheritance \} from ['"]\.\/scripts\/delivery\/incremental.mjs['"];\r?\n/m,
        '',
      )
      .replace(/^    incrementalInheritance\(\),\r?\n/m, '');
  return source;
}

export function assertAppendOnlyCatalog(previous, current) {
  const next = new Map(current.map((item) => [item.id, item]));
  if (next.size !== current.length) throw Error('Duplicate current artwork');
  for (const item of previous)
    if (!next.has(item.id) || canonical(item) !== canonical(next.get(item.id)))
      throw Error(`Existing artwork changed; full publication required: ${item.id}`);
  const old = new Set(previous.map((item) => item.id));
  return current
    .filter((item) => !old.has(item.id) && item.published && item.indexable)
    .map((item) => item.id);
}

function isAppendOnly(before, after) {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return false;
    const rows = new Set(after.map(canonical));
    return before.every((v) => rows.has(canonical(v)));
  }
  if (before && typeof before === 'object')
    return (
      after &&
      typeof after === 'object' &&
      !Array.isArray(after) &&
      Object.keys(before).every((k) => Object.hasOwn(after, k) && isAppendOnly(before[k], after[k]))
    );
  return before === after;
}

function sourceState(root, baselineRevision) {
  const tree = git(root, ['ls-tree', '-rz', baselineRevision])
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf('\t');
      return [row.slice(tab + 1), row.slice(0, tab).split(' ')[2]];
    });
  const blobs = new Map(tree),
    paths = [...blobs.keys()];
  const current = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
  const relevant = (p) =>
    !infrastructure(p) &&
    (/^(src|server|scripts|public)\//.test(p) ||
      ['astro.config.mjs', 'package.json', 'pnpm-lock.yaml'].includes(p));
  const old = paths.filter(relevant).sort(),
    next = [...new Set(current.filter(relevant))].sort();
  if (canonical(old) !== canonical(next)) throw Error('Renderer source inventory changed');
  const hashes = [];
  for (const path of [...new Set(current.filter(infrastructure))].sort())
    hashes.push([path, digest(readFileSync(join(root, path)))]);
  for (const path of old) {
    const bytes = readFileSync(join(root, path));
    let same;
    if (
      ['astro.config.mjs', 'src/pages/art/[id].astro', 'src/pages/edit/[id].astro'].includes(path)
    )
      same =
        normalizeRendererSource(path, git(root, ['show', `${baselineRevision}:${path}`])) ===
        normalizeRendererSource(path, bytes.toString('utf8'));
    else
      same =
        createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') ===
        blobs.get(path);
    if (!same) throw Error(`Shared renderer changed; full publication required: ${path}`);
    hashes.push([path, digest(bytes)]);
  }
  // Global navigation/counts/search/collection pages are freshly rendered. The
  // old artwork copy, identity, source and licensing records must be unchanged.
  const globalData = new Set([
    'data/production-queue.json',
    'data/publication.json',
    'data/publication-approval.json',
    'data/art.json',
    'data/collection-copy.json',
    'data/editorial/collections.json',
    'data/topics.json',
    'data/extra-topics.json',
    'data/topic-relations.json',
    'data/browse-groups.json',
    'data/primary-topic-categories.json',
    'data/preview-cache-index.json',
  ]);
  const previousArtworkIds = new Set(
    oldJson(root, baselineRevision, 'data/art.json').map((item) => item.id),
  );
  const perArtwork = new Map([
    ['data/editorial/reviews.json', (data) => new Map(data.artworks.map((row) => [row.id, row]))],
    ['data/image-metadata-reviews.json', (data) => new Map(Object.entries(data.artwork))],
    ['data/artwork-notes.json', (data) => new Map(Object.entries(data))],
    ['data/artwork-card-summaries.json', (data) => new Map(Object.entries(data))],
  ]);
  for (const path of paths.filter((p) => p.startsWith('data/') && p.endsWith('.json'))) {
    const after = json(join(root, path)),
      before = oldJson(root, baselineRevision, path);
    const extract = perArtwork.get(path);
    if (extract) {
      const oldRows = extract(before),
        newRows = extract(after);
      for (const id of previousArtworkIds)
        if (canonical(oldRows.get(id)) !== canonical(newRows.get(id)))
          throw Error(`Existing editorial or dependency data changed: ${path}/${id}`);
      // New rules/schema cannot be introduced as an unrelated registry header.
      if (path === 'data/editorial/reviews.json' && before.schema !== after.schema)
        throw Error('Editorial schema changed');
    } else if (!globalData.has(path) && canonical(before) !== canonical(after))
      throw Error(`Existing editorial or dependency data changed: ${path}`);
    hashes.push([path, digest(Buffer.from(canonical(after)))]);
  }
  for (const path of ['data/topics.json', 'data/extra-topics.json'])
    if (!isAppendOnly(oldJson(root, baselineRevision, path), json(join(root, path))))
      throw Error('Existing topic identity changed');
  const beforePublication = oldJson(root, baselineRevision, 'data/publication.json');
  const publication = json(join(root, 'data/publication.json'));
  const assets = new Map(publication.files.map((f) => [`${f.assetId}/${f.kind}`, canonical(f)]));
  for (const file of beforePublication.files)
    if (assets.get(`${file.assetId}/${file.kind}`) !== canonical(file))
      throw Error('Previously published image or download changed');
  return digest(Buffer.from(canonical(hashes)));
}

export function validateIncrementalPlan(root, plan) {
  if (
    plan?.schema !== 1 ||
    plan.mode !== 'append-only-incremental' ||
    !/^[a-f0-9]{40}$/.test(plan.revision ?? '') ||
    !/^[a-f0-9]{40}$/.test(plan.baselineRevision ?? '') ||
    !Array.isArray(plan.artworkIds)
  )
    throw Error('Invalid incremental plan');
  const { signature, ...signed } = plan;
  if (!verifyLocalState(root, canonical(signed), signature))
    throw Error('Incremental plan authentication failed');
  const expected = assertAppendOnlyCatalog(
    oldJson(root, plan.baselineRevision, 'data/art.json'),
    json(join(root, 'data/art.json')),
  );
  if (
    canonical(oldJson(root, plan.revision, 'data/art.json')) !==
    canonical(json(join(root, 'data/art.json')))
  )
    throw Error('Incremental catalog must match its committed revision');
  const ids = new Set(
    json(join(root, 'data/art.json'))
      .filter((a) => a.published && a.indexable)
      .map((a) => a.id),
  );
  if (
    new Set(plan.artworkIds).size !== plan.artworkIds.length ||
    plan.artworkIds.some((id) => !ids.has(id)) ||
    expected.some((id) => !plan.artworkIds.includes(id)) ||
    !Array.isArray(plan.relatedAffectedArtworkIds) ||
    plan.relatedAffectedArtworkIds.some((id) => !plan.artworkIds.includes(id))
  )
    throw Error('Incomplete or foreign incremental scope');
  if (sourceState(root, plan.baselineRevision) !== plan.sourceState)
    throw Error('Incremental source changed after planning');
  const manifest = json(plan.baselineManifest);
  if (
    manifest.revision !== plan.baselineRevision ||
    manifest.status !== 'remote-byte-verified' ||
    manifest.bucket !== 'ultraclipart-pages' ||
    manifest.verified !== manifest.files.length ||
    merkle(manifest.files).root !== plan.baselineRoot ||
    manifest.root !== plan.baselineRoot
  )
    throw Error('Incremental baseline proof changed');
  const baseIds = oldJson(root, plan.baselineRevision, 'data/art.json')
    .filter((a) => a.published && a.indexable)
    .map((a) => a.id)
    .sort();
  for (const kind of ['art', 'edit']) {
    const covered = manifest.files
      .filter((f) => f.path.startsWith(`/${kind}/`))
      .map((f) => f.path.split('/')[2])
      .sort();
    if (canonical(baseIds) !== canonical(covered)) throw Error('Incomplete baseline catalog');
  }
  const project = realpathSync(root),
    source = realpathSync(plan.baselineSource);
  if (!source.startsWith(project + '/work/delivery/'))
    throw Error('Unsafe incremental baseline path');
  return manifest;
}

// Run once against the verified release. Subsequent uploads reuse its exact
// bytes via authenticated filesystem identities and copy-on-write inheritance.
export function sealIncrementalBaseline(root, manifestPath, source, { previousManifestPath } = {}) {
  const manifest = json(manifestPath),
    target = join(root, 'work/delivery', manifest.revision, 'full-source');
  if (manifest.status !== 'remote-byte-verified' || merkle(manifest.files).root !== manifest.root)
    throw Error('Cannot seal an unverified baseline');
  mkdirSync(target, { recursive: true });
  const marker = join(target, 'incremental-baseline.json');
  if (existsSync(marker)) {
    if (json(marker).root !== manifest.root) throw Error('Baseline marker differs');
    return target;
  }
  const cache = verifiedSourceCache(root),
    managed = new Set(manifest.files.map((f) => f.path));
  const predecessor = previousManifestPath ?? manifest.incrementalPlan?.baselineManifest;
  let previousFiles = new Map(),
    previousSource;
  if (predecessor) {
    const previous = json(predecessor);
    previousSource = join(root, 'work/delivery', previous.revision, 'full-source');
    if (
      previous.status !== 'remote-byte-verified' ||
      merkle(previous.files).root !== previous.root ||
      json(join(previousSource, 'incremental-baseline.json')).root !== previous.root
    )
      throw Error('Invalid frozen predecessor snapshot');
    previousFiles = new Map(previous.files.map((file) => [file.path, file]));
  }
  // Preserve the complete rollback build, including its Pages/static files.
  cpSync(source, target, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (path) =>
      !managed.has('/' + path.slice(resolve(source).length + 1).replaceAll('\\', '/')),
  });
  for (const file of manifest.files) {
    const from = join(source, file.path),
      to = join(target, file.path);
    mkdirSync(dirname(to), { recursive: true });
    if (existsSync(to)) cache.verify(to, file);
    else {
      const old = previousFiles.get(file.path);
      if (old && old.sha256 === file.sha256 && old.bytes === file.bytes && old.mime === file.mime)
        cache.linkFrozen(join(previousSource, file.path), to, file);
      else cache.copy(from, to, file);
    }
  }
  cache.save();
  writeFileSync(
    marker,
    JSON.stringify({ schema: 1, revision: manifest.revision, root: manifest.root }) + '\n',
  );
  return target;
}

export async function planIncrementalRelease(
  root,
  { shadowIds, allowEmpty = false, publication, relatedAnalysis, exhaustiveRelated = true } = {},
) {
  const production = json(
    resolve(root, '../ultraclipart/work/remaining-cloudflare-production-report.json'),
  );
  if (
    production.tests?.automatedFailed !== 0 ||
    !(production.tests.automatedPassed > 0) ||
    ['imageSeoErrors', 'linkErrors', 'coreSeoErrors'].some((key) => production.tests[key] !== 0)
  )
    throw Error('Successful baseline source, SEO, link and unit proof required');
  const baselineRevision = production.liveDelivery?.renderedRevision;
  if (!/^[a-f0-9]{40}$/.test(baselineRevision ?? ''))
    throw Error('Verified production baseline required');
  const revision = git(root, ['rev-parse', 'HEAD']).trim();
  const baselineManifest = join(root, 'work/delivery', baselineRevision, 'verified-manifest.json');
  const manifest = json(baselineManifest);
  if (manifest.root !== production.liveDelivery.verifiedRoot)
    throw Error('Production baseline root differs');
  const artworkIds = assertAppendOnlyCatalog(
    oldJson(root, baselineRevision, 'data/art.json'),
    json(join(root, 'data/art.json')),
  );
  if (!artworkIds.length && !allowEmpty)
    throw Error('No new artwork; normal full publication required');
  const state = sourceState(root, baselineRevision);
  const previousIds = oldJson(root, baselineRevision, 'data/art.json').map((item) => item.id);
  const analysis = relatedAnalysis
    ? await relatedAnalysis()
    : await relatedImpact(root, previousIds, publication ?? readPublication(root), {
        exhaustive: exhaustiveRelated,
        baselineRevision,
      });
  if (
    !analysis ||
    typeof analysis.version !== 'string' ||
    analysis.version.length > 256 ||
    !/^[a-zA-Z0-9_.:-]+$/.test(analysis.version) ||
    !Array.isArray(analysis.affectedArtworkIds)
  )
    throw Error('Invalid related dependency proof');
  const baselineSource = sealIncrementalBaseline(root, baselineManifest, join(root, 'dist'));
  const plan = {
    schema: 1,
    mode: 'append-only-incremental',
    revision,
    baselineRevision,
    baselineRoot: manifest.root,
    baselineManifest,
    baselineSource,
    sourceState: state,
    artworkIds: [...new Set([...artworkIds, ...analysis.affectedArtworkIds, ...(shadowIds ?? [])])],
    relatedAffectedArtworkIds: analysis.affectedArtworkIds,
    relatedVersion: analysis.version,
    relatedAnalysis: analysis,
    shadowOnly: Boolean(relatedAnalysis || allowEmpty || shadowIds),
  };
  plan.signature = authenticateLocalState(root, canonical(plan));
  validateIncrementalPlan(root, plan);
  return plan;
}

const plans = new Map();
export function readIncrementalPlan(root = process.cwd()) {
  const file = process.env.UC_DELIVERY_INCREMENTAL_PLAN;
  if (!file) return null;
  if (plans.has(file)) return plans.get(file);
  const plan = json(file);
  validateIncrementalPlan(root, plan);
  plans.set(file, plan);
  return plan;
}

export function materializeIncrementalSource(root, directory, plan) {
  const manifest = validateIncrementalPlan(root, plan),
    selected = new Set(plan.artworkIds);
  const cache = verifiedSourceCache(root);
  if (json(join(directory, 'related-release.json')).version !== plan.relatedVersion)
    throw Error('Related release differs from the dependency analysis');
  let inherited = 0;
  for (const file of manifest.files) {
    if (/^\/(art|edit)\//.test(file.path) && selected.has(file.path.split('/')[2])) continue;
    const target = join(directory, file.path);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    cache.copy(join(plan.baselineSource, file.path), target, file);
    inherited++;
  }
  cache.save();
  return { inherited };
}

export function incrementalCollectionOptions(root, plan) {
  if (!plan) return {};
  const manifest = validateIncrementalPlan(root, plan),
    selected = new Set(plan.artworkIds);
  return {
    root,
    inherited: new Map(
      manifest.files
        .filter(
          (file) => !/^\/(art|edit)\//.test(file.path) || !selected.has(file.path.split('/')[2]),
        )
        .map((file) => [file.path, file]),
    ),
  };
}

export function incrementalInheritance() {
  return {
    name: 'ultraclipart-incremental-inheritance',
    hooks: {
      'astro:build:done': ({ dir }) => {
        const root = resolve(import.meta.dirname, '../..'),
          plan = readIncrementalPlan(root);
        if (plan)
          console.log(
            'Verified incremental inheritance:',
            materializeIncrementalSource(root, new URL(dir).pathname, plan),
          );
      },
    },
  };
}
