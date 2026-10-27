import { readFileSync, writeFileSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { pruneDeliveryFiles, digest } from './manifest.mjs';
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
  const catalog = JSON.parse(
    execFileSync('git', ['show', `${revision}:data/art.json`], {
      encoding: 'utf8',
      maxBuffer: 64_000_000,
    }),
  );
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
  // Keep the full checked build intact for rollback and whole-site audits.
  cpSync(source, target, { recursive: true, mode: 2 });
  const removed = pruneDeliveryFiles(target, manifest, revision);
  const raw = readFileSync(join(target, '_headers'), 'utf8');
  const pairs = (block) =>
    Object.fromEntries([...block.matchAll(/^  ([\w-]+): (.+)$/gm)].map((m) => [m[1], m[2]]));
  const pageHeaders = pairs(raw.split('/_astro/*')[0]);
  const editorBlock = raw.split('\n/edit/*\n')[1]?.split(/\n(?=\S)/)[0];
  if (!pageHeaders['Content-Security-Policy'] || !editorBlock)
    throw Error('Release security headers are incomplete');
  const editorHeaders = { ...pageHeaders, ...pairs(editorBlock) };
  const withdrawnIds = JSON.parse(
    execFileSync('git', ['show', `${revision}:data/retired-artwork.json`], { encoding: 'utf8' }),
  ).artworkIds;
  const options = { revision, ids, withdrawnIds, pageHeaders, editorHeaders };
  const css = readFileSync(join(root, 'src/styles/studio-next.css'), 'utf8'),
    styleVersion = digest(Buffer.from(css)).slice(0, 16);
  const renderedCss = execFileSync('git', ['show', `${revision}:src/styles/studio-next.css`], {
    encoding: 'utf8',
  });
  const needsStudioPatch = digest(Buffer.from(renderedCss)) !== digest(Buffer.from(css));
  const studioDeclaration = needsStudioPatch
    ? `studioStylePatch(${JSON.stringify(css)},${JSON.stringify(styleVersion)})`
    : 'async(q,r)=>r';
  const entry = `import original from ${JSON.stringify(join(source, '_worker.js'))};import {fetchAssetWithRetry} from './server/delivery/asset-retry.mjs';import {createPublicFileHandler} from './server/delivery/public-files.mjs';import {studioStylePatch,studioStyleRequest} from './server/delivery/studio-styles.mjs';const studio=${studioDeclaration};const delivery=createPublicFileHandler(${JSON.stringify(options)});export default {async fetch(request,env,context){const fallback={fetch:q=>original.fetch(q,{...env,ASSETS:{fetch:r=>fetchAssetWithRetry(r,env.ASSETS)}},context)};return studio(request,await delivery(studioStyleRequest(request),env,context,fallback));}};`;
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
