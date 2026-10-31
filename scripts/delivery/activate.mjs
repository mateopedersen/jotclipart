import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { assertOriginalImageDelivery } from './original-image-gate.mjs';
import { copyVerifiedPrunedRelease, digest } from './manifest.mjs';
import { shardStudioCatalog } from './studio-catalog-shard.mjs';

/** Read the exact committed catalog without imposing a fixed catalog-size ceiling. */
export function readCommittedCatalog(revision, run = execFileSync) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Full source revision required');
  const object = `${revision}:data/art.json`;
  const raw = run('git', ['cat-file', '-s', object], { encoding: 'utf8', maxBuffer: 1024 }).trim();
  if (!/^\d+$/.test(raw)) throw Error('Invalid committed catalog size');
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 2 || size > Number.MAX_SAFE_INTEGER - 65_536)
    throw Error('Invalid committed catalog size');
  const text = run('git', ['show', object], { encoding: 'utf8', maxBuffer: size + 65_536 });
  if (Buffer.byteLength(text, 'utf8') !== size) throw Error('Committed catalog byte count differs');
  const catalog = JSON.parse(text);
  if (!Array.isArray(catalog)) throw Error('Committed catalog must be an array');
  return catalog;
}

export async function prepareDeliveryRelease({
  source,
  target,
  manifestPath,
  revision,
  controlRevision,
  root = process.cwd(),
}) {
  if (
    !/^[a-f0-9]{40}$/.test(revision) ||
    !/^[a-f0-9]{40}$/.test(controlRevision) ||
    source === target ||
    existsSync(target)
  )
    throw Error('Separate new output and full production revisions required');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.incrementalPlan?.shadowOnly)
    throw Error('A shadow/test plan cannot become a production release');
  const catalog = readCommittedCatalog(revision);
  const ids = catalog
    .filter((a) => a.published && a.indexable)
    .map((a) => a.id)
    .sort();
  const actual = manifest.files
    ?.filter((a) => a.path.startsWith('/art/'))
    .map((a) => a.path.split('/')[2])
    .sort();
  if (
    JSON.stringify(ids) !== JSON.stringify(actual) ||
    manifest.files.filter((a) => a.path.startsWith('/edit/')).length !== ids.length
  )
    throw Error('Delivery manifest does not cover the complete rendered catalog');
  assertOriginalImageDelivery(source);
  // Keep the full checked build intact for rollback and whole-site audits.
  const removed = copyVerifiedPrunedRelease(source, target, manifest, revision);
  return finalizeVerifiedDeliveryRelease({source, target, manifestPath, revision, controlRevision,
    root, manifest, catalog, ids, removed});
}

// Only called after the source's complete verified manifest was checked, or
// after a separately authenticated and fully compared prepared-target resume.
export async function finalizeVerifiedDeliveryRelease({source, target, manifestPath, revision,
    controlRevision, root = process.cwd(), manifest, catalog, ids, removed}) {
  const raw = readFileSync(join(target, '_headers'), 'utf8');
  const pairs = (block) =>
    Object.fromEntries([...block.matchAll(/^  ([\w-]+): (.+)$/gm)].map((m) => [m[1], m[2]]));
  const pageHeaders = pairs(raw.split('/_astro/*')[0]);
  const editorBlock = raw.split('\n/edit/*\n')[1]?.split(/\n(?=\S)/)[0];
  if (!pageHeaders['Content-Security-Policy'] || !editorBlock)
    throw Error('Release security headers are incomplete');
  const editorHeaders = { ...pageHeaders, ...pairs(editorBlock) };
  const studio = shardStudioCatalog(target, catalog
    .filter((a) => a.published && a.indexable && a.sourceType === 'raster')
    .map((a) => a.id));
  const withdrawnIds = JSON.parse(
    execFileSync('git', ['show', `${revision}:data/retired-artwork.json`], { encoding: 'utf8' }),
  ).artworkIds;
  const inherited = new Map(),
    byId = new Map();
  for (const file of manifest.files.filter((f) => /^\/(art|edit)\//.test(f.path))) {
    const parts = /^delivery\/([a-f0-9]{40})(\/(art|edit)\/([a-z0-9-]+)\/index\.html)$/.exec(
      file.key,
    );
    if (!parts || parts[2] !== file.path) throw Error('Invalid artifact revision mapping');
    const [, fileRevision, , , id] = parts;
    if (byId.has(id) && byId.get(id) !== fileRevision)
      throw Error('Artwork/editor inheritance differs');
    byId.set(id, fileRevision);
    if (fileRevision !== revision) {
      if (!manifest.incrementalPlan)
        throw Error('HTML inheritance requires a verified incremental plan');
      const members = inherited.get(fileRevision) ?? new Set();
      members.add(id);
      inherited.set(fileRevision, members);
    }
  }
  const htmlRevisions = [...inherited].map(([version, members]) => [version, [...members].sort()]);
  const options = { revision, ids, withdrawnIds, pageHeaders, editorHeaders, htmlRevisions,
    ...(manifest.incrementalPlan ? { relatedVersion: manifest.incrementalPlan.relatedVersion } : {}) };
  const entry = `import original from ${JSON.stringify(join(source, '_worker.js'))};import {fetchAssetWithRetry} from './server/delivery/asset-retry.mjs';import {createPublicFileHandler} from './server/delivery/public-files.mjs';import {createStudioCatalogHandler} from './server/delivery/studio-catalog.mjs';import {compressHtml} from './server/delivery/compress-html.mjs';const delivery=createPublicFileHandler(${JSON.stringify(options)});const studio=${studio ? `createStudioCatalogHandler(${JSON.stringify(studio)},${JSON.stringify(pageHeaders)})` : 'null'};export default {async fetch(request,env,context){if(studio){const result=await studio(request,env);if(result)return result;}const fallback={fetch:q=>original.fetch(q,{...env,ASSETS:{fetch:r=>fetchAssetWithRetry(r,env.ASSETS)}},context)};return compressHtml(request,await delivery(request,env,context,fallback));}};`;
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'verified-delivery-release.mjs' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    outfile: join(target, '_worker.js'),
  });
  writeFileSync(
    join(target, '_headers'),
    readFileSync(join(target, '_headers'), 'utf8') +
      '\n/delivery-release.json\n  Cache-Control: no-store\n',
  );
  writeFileSync(
    join(target, '_routes.json'),
    JSON.stringify({ version: 1, include: ['/*'], exclude: [] }) + '\n',
  );
  const release = {
    schema: 1,
    renderedRevision: revision,
    controlRevision,
    bucket: manifest.bucket,
    verifiedRoot: manifest.root,
    r2Files: removed,
    artworks: ids.length,
    ...(studio ? { studioCatalog: studio } : {}),
    ...(manifest.incrementalPlan
      ? {
          renderMode: 'append-only-incremental',
          inheritedArtworks: htmlRevisions.reduce((n, [, members]) => n + members.length, 0),
        }
      : {}),
    workerSha256: digest(readFileSync(join(target, '_worker.js'))),
  };
  writeFileSync(join(target, 'delivery-release.json'), JSON.stringify(release) + '\n');
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce(
      (sum, e) => sum + (e.isDirectory() ? files(join(dir, e.name)) : 1),
      0,
    );
  release.directoryFiles = files(target);
  release.pagesFiles = release.directoryFiles - 4;
  if (release.pagesFiles >= 85_000)
    throw Error('Verified migration did not provide adequate Pages headroom');
  writeFileSync(
    manifestPath.replace(/verified-manifest\.json$/, 'prepared-release.json'),
    JSON.stringify(release, null, 2) + '\n',
  );
  return release;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [source, target, manifestPath, revision, controlRevision] = process.argv.slice(2);
  if (!source || !target || !manifestPath)
    throw Error(
      'Usage: activate.mjs full-build new-output verified-manifest rendered-revision control-revision',
    );
  console.log(
    await prepareDeliveryRelease({
      source: resolve(source),
      target: resolve(target),
      manifestPath: resolve(manifestPath),
      revision,
      controlRevision,
    }),
  );
}
