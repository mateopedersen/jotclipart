import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const encoded = (b) =>
  `Uint8Array.from(atob(${JSON.stringify(b.toString('base64'))}),c=>c.charCodeAt(0))`;
export async function buildOgWorker({ root = process.cwd(), buildRoot }) {
  const directory = resolve(root, buildRoot, 'og-worker');
  mkdirSync(directory, { recursive: true });
  const files = {
    resvg: 'node_modules/@resvg/resvg-wasm/index_bg.wasm',
    webp: 'node_modules/@jsquash/webp/codec/dec/webp_dec.wasm',
    logo: 'public/brand/jotclipart-mark-3d.png',
    font400: 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff',
    font700: 'node_modules/@fontsource/inter/files/inter-latin-700-normal.woff',
  };
  const resources = Object.fromEntries(
    Object.entries(files).map(([k, p]) => [k, readFileSync(resolve(root, p))]),
  );
  const inputs = {};
  for (const p of Object.values(files)) inputs[p] = sha(readFileSync(resolve(root, p)));
  for (const p of [
    'server/jotclipart/og-image.mjs',
    'scripts/jotclipart/og-worker-build.mjs',
    'node_modules/@resvg/resvg-wasm/package.json',
    'node_modules/@jsquash/webp/package.json',
    'node_modules/pako/package.json',
  ])
    inputs[p] = sha(readFileSync(resolve(root, p)));
  const identity = {
    rendererSHA256: sha(
      Buffer.from(
        JSON.stringify({ schema: 1, inputs: Object.fromEntries(Object.entries(inputs).sort()) }),
      ),
    ),
    logoSHA256: sha(resources.logo),
    fontSHA256: [sha(resources.font400), sha(resources.font700)],
  };
  const entry = `import resvgModule from './resvg.wasm';import webpModule from './webp.wasm';import{createOgRenderer,ogImageResponse}from${JSON.stringify(resolve(root, 'server/jotclipart/og-image.mjs'))};\nconst identity=${JSON.stringify(identity)},fonts=[${encoded(resources.font400)},${encoded(resources.font700)}],logo=${encoded(resources.logo)};let engine;\nexport default{async fetch(request){if(request.method!=='POST'||new URL(request.url).pathname!=='/render')return new Response('Not found',{status:404});try{const reader=request.body?.getReader();if(!reader)return new Response('Bad request',{status:400});let total=0,chunks=[];for(;;){let{done,value}=await reader.read();if(done)break;total+=value.length;if(total>16384){await reader.cancel();return new Response('Too large',{status:413});}chunks.push(value);}const body=new Uint8Array(total);let pos=0;for(const c of chunks){body.set(c,pos);pos+=c.length;}const source=JSON.parse(new TextDecoder().decode(body));engine??=createOgRenderer({resvgModule,webpModule,fonts,logo,identity});const result=await(await engine).render(source);const response=ogImageResponse(result);response.headers.set('x-jotclipart-og-renderer',identity.rendererSHA256);return response;}catch(error){return new Response('OG image unavailable',{status:503,headers:{'cache-control':'no-store'}});}}};`;
  const entryPath = join(directory, 'entry.mjs');
  writeFileSync(entryPath, entry);
  const bundled = await build({
    entryPoints: [entryPath],
    outfile: join(directory, 'worker.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    metafile: true,
    external: ['./resvg.wasm', './webp.wasm'],
    logLevel: 'warning',
  });
  // The identity covers every actual JS dependency as well as both Wasm modules.
  const graph = { ...inputs };
  for (const p of Object.keys(bundled.metafile.inputs)) {
    if (resolve(root, p) === entryPath) continue;
    graph[p] = sha(readFileSync(resolve(root, p)));
  }
  const graphIdentity = sha(
    Buffer.from(
      JSON.stringify({ schema: 2, inputs: Object.fromEntries(Object.entries(graph).sort()) }),
    ),
  );
  const finalIdentity = { ...identity, rendererSHA256: graphIdentity };
  const finalName = 'jotclipart-og-' + graphIdentity.slice(0, 16);
  writeFileSync(entryPath, entry.replace(JSON.stringify(identity), JSON.stringify(finalIdentity)));
  await build({
    entryPoints: [entryPath],
    outfile: join(directory, 'worker.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    external: ['./resvg.wasm', './webp.wasm'],
    logLevel: 'warning',
  });
  copyFileSync(resolve(root, files.resvg), join(directory, 'resvg.wasm'));
  copyFileSync(resolve(root, files.webp), join(directory, 'webp.wasm'));
  const wrangler = {
    name: finalName,
    main: 'worker.mjs',
    compatibility_date: '2026-10-23',
    workers_dev: false,
    preview_urls: false,
    limits: { cpu_ms: 5000 },
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }],
  };
  writeFileSync(join(directory, 'wrangler.json'), JSON.stringify(wrangler, null, 2) + '\n');
  const base = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc')));
  const binding = { binding: 'OG_RENDERER', service: finalName };
  base.services = [...(base.services ?? []).filter((b) => b.binding !== 'OG_RENDERER'), binding];
  base.env.preview.services = [
    ...(base.env.preview.services ?? []).filter((b) => b.binding !== 'OG_RENDERER'),
    binding,
  ];
  base.pages_build_output_dir = relative(directory, resolve(root, 'dist')).split('\\').join('/');
  const pagesConfig = join(directory, 'wrangler.pages.json');
  writeFileSync(pagesConfig, JSON.stringify(base, null, 2) + '\n');
  const outputFiles = [
    'worker.mjs',
    'resvg.wasm',
    'webp.wasm',
    'entry.mjs',
    'wrangler.json',
    'wrangler.pages.json',
  ].map((file) => {
    const b = readFileSync(join(directory, file));
    return { file, bytes: b.length, sha256: sha(b) };
  });
  const result = {
    schema: 1,
    status: 'BUILT_NOT_DEPLOYED',
    name: finalName,
    identity: finalIdentity,
    directory,
    pagesConfig,
    workerConfig: join(directory, 'wrangler.json'),
    sourceInputs: graph,
    outputFiles,
    originalsWritten: 0,
    r2Writes: 0,
    publicRoutes: [],
    workersDev: false,
  };
  writeFileSync(join(directory, 'og-worker-report.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
