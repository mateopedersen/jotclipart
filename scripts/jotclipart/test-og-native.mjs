// Local workerd proof only. No cloud deployment, R2 writes or network requests.
// The proof input is the separately verified new-host thumbnail and descriptor.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import sharp from 'sharp';
const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare } = require('miniflare');
const root = process.cwd(),
  proof = resolve(process.argv[2] ?? '../og-research');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const source = JSON.parse(await readFile(join(proof, 'verified-sample.json')));
const thumb = await readFile(join(proof, 'verified-thumb.webp'));
assert.equal(source.images.length, 1);
assert.equal(sha(thumb), source.images[0].sha256);
assert.equal(thumb.length, source.images[0].bytes);
const resvgPath = resolve('node_modules/@resvg/resvg-wasm/index_bg.wasm');
const webpPath = resolve('node_modules/@jsquash/webp/codec/dec/webp_dec.wasm');
const resvg = await readFile(resvgPath),
  webp = await readFile(webpPath);
const logo = await readFile(resolve('public/brand/jotclipart-mark-3d.png'));
const fonts = await Promise.all(
  [400, 700].map((n) =>
    readFile(resolve(`node_modules/@fontsource/inter/files/inter-latin-${n}-normal.woff`)),
  ),
);
const code = await readFile(resolve('server/jotclipart/og-image.mjs'));
const identity = { rendererSHA256: sha(code), logoSHA256: sha(logo), fontSHA256: fonts.map(sha) };
const encoded = (b) =>
  `Uint8Array.from(atob(${JSON.stringify(b.toString('base64'))}),c=>c.charCodeAt(0))`;
const sourceURL =
  'https://assets.jotclipart.com/' +
  source.images[0].objectKey.split('/').map(encodeURIComponent).join('/');
const entry = `
import resvgModule from './resvg.wasm';
import webpModule from './webp.wasm';
import {createOgRenderer,ogImageResponse} from ${JSON.stringify(resolve('server/jotclipart/og-image.mjs'))};
const SOURCE=${JSON.stringify(source)}, IDENTITY=${JSON.stringify(identity)};
const LOGO=${encoded(logo)}, FONTS=[${fonts.map(encoded).join(',')}], THUMB=${encoded(thumb)};
let renderer, reserve, memory=[];
export default {async fetch(request){
 const url=new URL(request.url);
 const wanted=Number(url.searchParams.get('reserve')??0);
 if(wanted&&!reserve){reserve=new Uint8Array(wanted);for(let i=0;i<reserve.length;i+=4096)reserve[i]=(i/4096)%251;}
 if(!renderer){
  const instantiate=WebAssembly.instantiate, Instance=WebAssembly.Instance;
  WebAssembly.instantiate=async(...args)=>{const out=await instantiate(...args);const inst=out.instance??out;for(const v of Object.values(inst.exports))if(v instanceof WebAssembly.Memory)memory.push(v);return out;};
  WebAssembly.Instance=new Proxy(Instance,{construct(target,args){const inst=Reflect.construct(target,args);for(const v of Object.values(inst.exports))if(v instanceof WebAssembly.Memory)memory.push(v);return inst;}});
  try{renderer=await createOgRenderer({resvgModule,webpModule,fonts:FONTS,logo:LOGO,identity:IDENTITY,fetcher:async(url,options)=>{if(url!==${JSON.stringify(sourceURL)}||options.redirect!=='manual')throw Error('Proof unexpected media request');return new Response(THUMB,{headers:{'content-type':'image/webp','content-length':String(THUMB.length)}});}});}
  finally{WebAssembly.instantiate=instantiate;WebAssembly.Instance=Instance;}
 }
 const start=Date.now(),result=await renderer.render(SOURCE),response=ogImageResponse(result);
 response.headers.set('x-local-og-proof',JSON.stringify({ms:Date.now()-start,wasm:memory.map(m=>m.buffer.byteLength),reserved:reserve?.length??0,reservedProbe:reserve?.[4096]??0,digest:result.descriptor.digest,pngSHA256:result.sha256}));
 return response;
}};`;
const output = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'og-native-proof.mjs' },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  write: false,
  external: ['./resvg.wasm', './webp.wasm'],
  logLevel: 'silent',
});
const bundle = output.outputFiles[0].contents;
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'jotclipart-og-native-proof',
        compatibilityDate: '2026-10-23',
        compatibilityFlags: [],
        manifest: {
          mainModule: 'og-native-proof.mjs',
          modulesRoot: '/',
          modules: {
            'og-native-proof.mjs': { type: 'esm', contents: bundle },
            'resvg.wasm': { type: 'wasm', contents: resvg },
            'webp.wasm': { type: 'wasm', contents: webp },
          },
        },
      },
      dev: { rootPath: root },
    },
  ],
  host: '127.0.0.1',
  port: 0,
  telemetry: { enabled: false },
});
try {
  const checks = [];
  for (const reserve of [0, 64 * 1024 * 1024, 64 * 1024 * 1024]) {
    const response = await mf.dispatchFetch('https://local-og-proof.invalid/?reserve=' + reserve);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status !== 200)
      throw Error(
        'Native proof response ' +
          response.status +
          ': ' +
          new TextDecoder().decode(bytes).slice(0, 600),
      );
    const metric = JSON.parse(response.headers.get('x-local-og-proof'));
    assert.equal(sha(bytes), metric.pngSHA256);
    const image = await sharp(bytes).metadata();
    assert.equal(image.width, 1200);
    assert.equal(image.height, 630);
    assert.equal(image.format, 'png');
    assert(metric.wasm.length >= 2);
    assert(metric.wasm.reduce((n, v) => n + v, 0) < 48 * 1024 * 1024);
    if (reserve) assert.equal(metric.reservedProbe, 1);
    checks.push({ ...metric, pngBytes: bytes.length, status: response.status });
    await writeFile(join(proof, 'native-proof-' + checks.length + '.png'), bytes);
  }
  assert.equal(new Set(checks.map((c) => c.pngSHA256)).size, 1);
  const report = {
    status: 'LOCAL_WORKERD_STATIC_WASM_REAL_VERIFIED_WEBP_RENDER_PASSED',
    at: new Date().toISOString(),
    source,
    identity,
    checks,
    resources: {
      resvgSHA256: sha(resvg),
      resvgBytes: resvg.length,
      resvgGzipBytes: gzipSync(resvg).length,
      decoderSHA256: sha(webp),
      decoderBytes: webp.length,
      decoderGzipBytes: gzipSync(webp).length,
      proofBundleBytes: bundle.length,
      proofBundleGzipBytes: gzipSync(bundle).length,
    },
    cloudWrites: 0,
    requestsToCloud: 0,
    fullCatalogRendered: false,
    limitation:
      'Actual local workerd and static CompiledWasm modules with64MiB reserved JS memory; not provider production CPU/startup or final combined catalog Worker measurement.',
  };
  await mkdir(proof, { recursive: true });
  await writeFile(join(proof, 'native-proof.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await mf.dispose();
}
