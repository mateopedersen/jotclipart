import { siteNavigationScript } from '../../src/lib/site-navigation-inline.mjs';
import { bindSiteNavigationPolicy } from './compilers/navigation-policy.mjs';
// Build the small software control layer, reusing the verified static fallback.
// No catalogue pages, media exports, uploads, pointer changes or activation.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build, transform } from 'esbuild';
import {
  originalImageSchedulingSource,
  originalImageSchedulingScript,
} from '../../src/lib/original-image-scheduling-inline.mjs';
import { compiledModuleImports } from './module-imports.mjs';
import { bindCookieScriptPolicy } from './compilers/inline-policy.mjs';
import { cookieStartupScript, cookieMountScript } from '../cookie-startup.mjs';
const [buildArg, configArg] = process.argv.slice(2);
if (!configArg) throw Error('Usage: build-runtime compiled-template-dir trusted-public-config');
const schedulingLiteral = (
  await transform(originalImageSchedulingSource, {
    loader: 'js',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
  })
).code.trim();
if (schedulingLiteral !== originalImageSchedulingScript)
  throw Error('Reviewed original-image scheduling source and frozen CSP literal differ');
const root = process.cwd(),
  dir = resolve(buildArg),
  cfg = JSON.parse(readFileSync(configArg)),
  compiled = JSON.parse(readFileSync(join(dir, 'compilers.json'))),
  revision = compiled.revision,
  sha = (b) => createHash('sha256').update(b).digest('hex');
if (
  !dir.startsWith(resolve('work') + '/') ||
  compiled.status !== 'SOFTWARE_TEMPLATE_COMPILE_ONLY_NOT_PUBLISHED' ||
  !/^[a-f0-9]{40}$/.test(revision) ||
  !/^[a-f0-9]{64}$/.test(cfg.publicKeyHex ?? '') ||
  cfg.accountId !== '48c779c8eaa80234e0bb9d57f96e588b' ||
  cfg.bucketName !== 'ultraclipart-pages' ||
  !/^[a-z0-9-]+$/.test(cfg.keyId ?? '')
)
  throw Error('Reviewed compiled software and public key configuration required');
const baselinePolicy = JSON.parse(readFileSync('config/jotclipart-http-policy.json'));
const page = bindSiteNavigationPolicy(
  bindCookieScriptPolicy(baselinePolicy.page, [cookieStartupScript, cookieMountScript]),
);
const scheduleHash =
  "'sha256-" + createHash('sha256').update(originalImageSchedulingScript).digest('base64') + "'";
if (!page['Content-Security-Policy'].includes(scheduleHash))
  page['Content-Security-Policy'] = page['Content-Security-Policy'].replace(
    /(\bscript-src\s+[^;]+)/,
    '$1 ' + scheduleHash,
  );
const editor = {
  ...page,
  'Content-Security-Policy':
    page['Content-Security-Policy']
      .replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com")
      .replace("connect-src 'self'", "connect-src 'self' https://challenges.cloudflare.com") +
    "; frame-src https://challenges.cloudflare.com; worker-src 'self'",
};
const inlineSHA256 = [...page['Content-Security-Policy'].matchAll(/'sha256-([^']+)'/g)].map((m) =>
  Buffer.from(m[1], 'base64').toString('hex'),
);
if (!inlineSHA256.length) throw Error('Missing accepted script hashes');
const policy = { page, editor, inlineSHA256 },
  clientAssets = new Map(),
  softwareInputs = new Map(),
  imports = [],
  definitions = [],
  moduleImports = {};
for (const file of [
  'src/lib/original-image-frame.mjs',
  'src/lib/original-image-scheduling-inline.mjs',
  'server/jotclipart/fallback.mjs',
])
  softwareInputs.set(file, sha(readFileSync(file)));
for (const kind of ['art', 'editor', 'home', 'collection', 'shell']) {
  const folder = join(dir, kind + '-ssr'),
    report = JSON.parse(readFileSync(join(folder, 'build-report.json')));
  if (
    report.revision !== revision ||
    report.fullCatalogEmbedded !== false ||
    report.compilerDiagnostics.some((d) => d.severity === 1)
  )
    throw Error('Compiled source differs');
  for (const item of [...report.server, ...report.client]) {
    const b = readFileSync(item.file);
    if (b.length !== item.bytes || sha(b) !== item.sha256) throw Error('Compiled bytes changed');
    softwareInputs.set(item.file, item.sha256);
  }
  for (const item of report.client) {
    const name = item.file.split('/').at(-1),
      url = `/__ssr-client/${revision}/${name}`,
      old = clientAssets.get(url);
    if (old && old.sha256 !== item.sha256) throw Error('Public software URL collision');
    clientAssets.set(url, { url, file: item.file, sha256: item.sha256, bytes: item.bytes });
  }
  for (const item of [...(report.uiAssets ?? []), ...(report.screenProofs ?? [])]) {
    const file = item.path ?? item.file,
      b = readFileSync(file);
    if (sha(b) !== item.sha256 || b.length !== item.bytes)
      throw Error('Static visual source differs');
    const url = item.url ?? `/__ssr-client/${revision}/home-ui/${item.sha256}.webp`;
    clientAssets.set(url, { url, file, sha256: item.sha256, bytes: item.bytes });
  }
  for (const url of report.criticalModulePreloads ?? [])
    if (kind !== 'editor' || !clientAssets.has(url))
      throw Error('Unverified critical module preload');
  const folderPath = join(folder, 'compiled'),
    scripts = JSON.parse(readFileSync(join(folderPath, 'script-urls.json')));
  const metaFile = join(folderPath, 'client-metafile.json'),
    metaBytes = readFileSync(metaFile),
    graph = compiledModuleImports(JSON.parse(metaBytes), [...clientAssets.values()], revision);
  softwareInputs.set(metaFile, sha(metaBytes));
  for (const [url, dependencies] of Object.entries(graph)) {
    if (moduleImports[url] && JSON.stringify(moduleImports[url]) !== JSON.stringify(dependencies))
      throw Error('Module import graph collision');
    moduleImports[url] = dependencies;
  }
  if (kind === 'shell') {
    const pages = Object.keys(
      JSON.parse(readFileSync(join(folderPath, 'script-page-templates.json'))),
    );
    for (const name of pages) {
      imports.push(
        `import{renderPage as render_${name}}from${JSON.stringify(join(folderPath, name + '.js'))};`,
      );
      definitions.push(
        `${JSON.stringify(name)}:[render_${name},${JSON.stringify(readFileSync(join(folderPath, name + '.css'), 'utf8'))}]`,
      );
    }
    imports.push(
      `const shells={${definitions.join(',')}},shellScripts=${JSON.stringify(scripts)};`,
    );
  } else {
    const name = {
      art: 'renderArtwork',
      editor: 'renderEditor',
      home: 'renderHome',
      collection: 'renderCollection',
    }[kind];
    imports.push(
      `import{${name}}from${JSON.stringify(join(folderPath, 'renderer.mjs'))};const ${kind}={render:${name},css:${JSON.stringify(readFileSync(join(folderPath, 'renderer.css'), 'utf8'))},scripts:${JSON.stringify(scripts)},preloads:${JSON.stringify(report.criticalModulePreloads ?? [])}};`,
    );
  }
}
// Studio's retained self-contained composition previews are versioned SVGs.
for (const item of JSON.parse(readFileSync('config/jotclipart-ui-assets.json'))) {
  const file = item.path,
    b = readFileSync(file);
  if (sha(b) !== item.sha256 || b.length !== item.bytes)
    throw Error('Retained interface preview differs');
  clientAssets.set('/' + file.replace(/^public\//, ''), {
    url: '/' + file.replace(/^public\//, ''),
    file,
    sha256: item.sha256,
    bytes: b.length,
  });
  softwareInputs.set(file, item.sha256);
}
const fontURL = '/fonts/inter/inter-latin-wght-3100e775e861-cache-v2.woff2',
  fontFile = 'public/fonts/inter/inter-latin-wght-3100e775e861.woff2',
  fontBytes = readFileSync(fontFile),
  fontSHA = sha(fontBytes);
if (fontSHA !== '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62')
  throw Error('Retained interface font differs');
softwareInputs.set(fontFile, fontSHA);
clientAssets.set(fontURL, {
  url: fontURL,
  file: fontFile,
  bytes: fontBytes.length,
  sha256: fontSHA,
});
const shared = `${imports.join('\n')}\nconst renderers={art,editor,home,collection,shells,shellScripts,moduleImports:${JSON.stringify(moduleImports)}};\n`,
  runtimeImport =
    `import{handleShare}from${JSON.stringify(join(root, 'server/share/handler.mjs'))};import{handleAi}from${JSON.stringify(join(root, 'server/ai/handler.mjs'))};import{createSnapshotRuntime}from${JSON.stringify(join(root, 'server/catalog-snapshot/runtime.mjs'))};` +
    `import{immutableSoftwareAssetResponse}from${JSON.stringify(join(root, 'server/catalog-snapshot/software-assets.mjs'))};import{staticNavigationPolicy}from${JSON.stringify(join(root, 'server/catalog-snapshot/static-navigation-policy.mjs'))};`,
  config = JSON.stringify({ ...cfg, publicKey: undefined });
// The installed publisher reuses this checksum-bound Node bundle. No template
// build or unbound worktree import is needed for later content transactions.
const presentationFile = join(dir, 'runtime/presentation-renderers.mjs');
mkdirSync(join(dir, 'runtime'), { recursive: true });
await build({
  stdin: { resolveDir: root, contents: shared + 'export{renderers};' },
  outfile: presentationFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  minify: true,
  external: ['node:*'],
  loader: { '.css': 'text' },
  define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' },
  logLevel: 'warning',
});
const presentationBytes = readFileSync(presentationFile),
  presentationSHA256 = sha(presentationBytes);
softwareInputs.set(presentationFile, presentationSHA256);
const presentation = {
  version: 1,
  file: 'runtime/presentation-renderers.mjs',
  sourceInput: presentationFile,
  sha256: presentationSHA256,
  bytes: presentationBytes.length,
};
const ogWorkerReportPath = join(dir, 'og-worker/og-worker-report.json');
const ogWorker = existsSync(ogWorkerReportPath)
  ? JSON.parse(readFileSync(ogWorkerReportPath))
  : undefined;
if (ogWorker) {
  for (const [file, digest] of Object.entries(ogWorker.sourceInputs)) {
    const actual = sha(readFileSync(resolve(root, file)));
    if (actual !== digest) throw Error('OG source changed after renderer build');
    softwareInputs.set(file, digest);
  }
  softwareInputs.set(ogWorkerReportPath, sha(readFileSync(ogWorkerReportPath)));
}
// Hash the actual dependency graph before injecting its own ABI identity.
const probe = await build({
  stdin: {
    resolveDir: root,
    contents:
      runtimeImport +
      shared +
      'export{handleAi,handleShare,renderers,immutableSoftwareAssetResponse,staticNavigationPolicy};',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  metafile: true,
  external: ['node:*'],
  loader: { '.css': 'text' },
  define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' },
  logLevel: 'warning',
});
for (const f of Object.keys(probe.metafile.inputs)) {
  if (f === '<stdin>') continue;
  softwareInputs.set(f, sha(readFileSync(f)));
}
softwareInputs.set('trusted-public-config', sha(Buffer.from(config)));
softwareInputs.set('http-policy', sha(Buffer.from(JSON.stringify(policy))));
const abiSHA256 = sha(
  Buffer.from(JSON.stringify([...softwareInputs].sort(([a], [b]) => a.localeCompare(b, 'en')))),
);
const out = join(dir, 'runtime');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'renderers-entry.mjs'), shared + 'export{renderers};');
const entry = join(out, 'entry.mjs');
writeFileSync(
  entry,
  `${runtimeImport}\nimport{fallbackFetch}from${JSON.stringify(resolve('server/jotclipart/fallback.mjs'))};\n${shared}\nconst verifier={...${config},publicKey:Uint8Array.from(${JSON.stringify([...Buffer.from(cfg.publicKeyHex, 'hex')])}),abiSHA256:${JSON.stringify(abiSHA256)}};const catalog=createSnapshotRuntime({renderers,verifier,softwareRevision:${JSON.stringify(revision)},ogIdentity:${JSON.stringify(ogWorker?.identity)},policy:${JSON.stringify(policy)},redirects:${JSON.stringify(JSON.parse(readFileSync('config/jotclipart-legacy-routes.json')))}});const immutableURLs=new Set(${JSON.stringify([...clientAssets.keys()])});export default{async fetch(request,env,ctx){const path=new URL(request.url).pathname;if(path.startsWith('/api/ai/'))return handleAi(request,env,ctx);if(path.startsWith('/api/share')||path.startsWith('/share/'))return handleShare(request,env,ctx);const response=await catalog(request,env,ctx);return response??immutableSoftwareAssetResponse(request,staticNavigationPolicy(await fallbackFetch(request,env,ctx,${JSON.stringify(policy.page)}),${JSON.stringify("'sha256-" + createHash('sha256').update(siteNavigationScript).digest('base64') + "'")}),immutableURLs)}};`,
);
const bundled = await build({
  entryPoints: [entry],
  outfile: join(out, 'worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  metafile: true,
  external: ['node:*'],
  loader: { '.css': 'text' },
  define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' },
  logLevel: 'warning',
});
const worker = readFileSync(join(out, 'worker.mjs'));
if (worker.length > 64000000) throw Error('Worker platform size exceeded');
writeFileSync(
  join(out, 'software-report.json'),
  JSON.stringify(
    {
      schema: 1,
      status: 'SOFTWARE_COMPILED_NOT_INSTALLED',
      revision,
      abiSHA256,
      accountId: cfg.accountId,
      bucketName: cfg.bucketName,
      keyId: cfg.keyId,
      publicKeyHex: cfg.publicKeyHex,
      ...(cfg.acceptedPredecessor ? { acceptedPredecessor: cfg.acceptedPredecessor } : {}),
      workerSHA256: sha(worker),
      workerBytes: worker.length,
      presentation,
      ...(ogWorker
        ? {
            ogWorker: {
              name: ogWorker.name,
              identity: ogWorker.identity,
              directory: ogWorker.directory,
              outputFiles: ogWorker.outputFiles,
            },
          }
        : {}),
      sourceInputs: Object.fromEntries(softwareInputs),
      clientAssets: [...clientAssets.values()],
      policy,
      fullCatalogPagesBuilt: 0,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    status: 'SOFTWARE_COMPILED_NOT_INSTALLED',
    revision,
    abiSHA256,
    workerBytes: worker.length,
    assets: clientAssets.size,
    fullCatalogPagesBuilt: 0,
  }),
);
