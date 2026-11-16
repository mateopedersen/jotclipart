import {clientWorkers} from './client-workers.mjs';
import{editorCriticalPreloads}from'./editor-preloads.mjs';
// Private local SSR experiment. Does not read credentials, upload or activate.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {writeScopedContext} from './scoped-context.mjs';
const root = process.cwd(), here = resolve(process.env.UC_SNAPSHOT_BUILD_ROOT ?? 'work/catalog-snapshot/build', 'editor-ssr'), out = join(here, 'compiled');
mkdirSync(out, { recursive: true });
writeScopedContext(join(here,'context.mjs'),root);
const compiler = createRequire(import.meta.resolve('astro/package.json'))('@astrojs/compiler-rs');
const context = join(here, 'context.mjs');
const revision = process.env.UC_SNAPSHOT_CODE_REVISION;if(!/^[a-f0-9]{40}$/.test(revision))throw Error('Full source revision required');
const scripts = new Map(), diagnostics = [];
const cookieScripts=await import(pathToFileURL(join(root,'scripts/cookie-startup.mjs')));
const aliases = new Map([
  [join(root,'scripts/cookie-startup.mjs'),`export const cookieStartupScript=${JSON.stringify(cookieScripts.cookieStartupScript)};export const cookieMountScript=${JSON.stringify(cookieScripts.cookieMountScript)};`],
  [join(root, 'src/lib/catalog.ts'), `import {current,scoped} from ${JSON.stringify(context)};
    export const art=scoped('art',[]),publishedArt=scoped('art',[]),availableTopics=scoped('topics',[]),topics=scoped('topics',[]);
    export const reviewedCollectionIntroductions=scoped('summaries',new Map()),reviewedCollectionParagraphs=scoped('paragraphs',new Map());
    export const topicArt=slug=>current().art.filter(a=>a.topic===slug);
    export const slugify=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    export const clustersForTopic=topic=>current().clusterNames[topic.slug];`],
  [join(root, 'src/lib/related/service.ts'), `import {current} from ${JSON.stringify(context)};export const relatedIndex={snapshot:id=>{if(current().related.sourceId!==id)throw Error('Wrong related source');return current().related}};`],
  [join(root, 'src/lib/collection-preview.ts'), `import {current} from ${JSON.stringify(context)};export const collectionPreview=(topic,sourceId)=>current().collectionPreview(topic,sourceId);`],
  [join(root, 'src/lib/editor-screen.ts'), `import {current} from ${JSON.stringify(context)};export const editorScreen=item=>{if(current().editorItem.id!==item.id)throw Error('Wrong editor source');return current().editorItem};`],
  [join(root, 'src/lib/studio-artwork.ts'), `import {current,scoped} from ${JSON.stringify(context)};export const FEATURED_ARTWORK_LIMIT=500;export const featuredStudioArt=scoped('featuredStudioArt',[]);export const getFeaturedStudioCount=()=>current().featuredStudioCount??current().featuredStudioArt.length;`],
  [join(root, 'src/lib/delivery-build-scope.ts'), `export const renderArtworkScope=items=>items;`],
  [join(root, 'src/lib/catalog-statistics.ts'), `import {scoped} from ${JSON.stringify(context)};export const catalogStatistics=scoped('counts');`],
  [join(root, 'src/lib/surprise-catalog.ts'), `import {scoped} from ${JSON.stringify(context)};export const cuteSurpriseIndex=scoped('surprise',[]);`],
  [join(root, 'data/collection-copy.json'), `import {scoped} from ${JSON.stringify(context)};export default scoped('copy');`],
  [join(root, 'data/topic-relations.json'), `import {scoped} from ${JSON.stringify(context)};export default scoped('relations');`],
]);
const plugin = {
  name: 'private-snapshot-astro-renderer',
  setup(builder) {
    builder.onResolve({ filter: /\.snapshot\.css$/ }, args => ({path:args.path,namespace:'snapshot-css'}));
    builder.onResolve({ filter: /^\// }, args => args.kind === 'url-token' ? {path:args.path,external:true} : null);
    builder.onResolve({ filter: /^\.\.?\// }, args => {
      const base = resolve(args.resolveDir, args.path);
      const alias = aliases.has(base) ? base : aliases.has(base + '.ts') ? base + '.ts' : null;
      if (alias) return { path: alias, namespace: 'snapshot-alias' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'snapshot-alias' }, args => ({ contents: aliases.get(args.path), loader: 'ts', resolveDir: dirname(args.path) }));
    builder.onLoad({ filter: /\.astro$/ }, async args => {
      const transformed = await compiler.transform(readFileSync(args.path, 'utf8'), { filename: args.path, normalizedFilename: args.path.slice(root.length), renderScript: true, internalURL: 'astro/compiler-runtime', resultScopedSlot: true, compact: true, resolvePath: specifier => specifier });
      diagnostics.push(...transformed.diagnostics);
      if (transformed.diagnostics.some(x => x.severity === 1)) throw Error('Astro compiler error');
      transformed.scripts.forEach((script, index) => {
        if (script.type !== 'inline') throw Error('External compiler script requires explicit review');
        scripts.set(`${args.path}?astro&type=script&index=${index}&lang.ts`, { code: script.code, directory: dirname(args.path) });
      });
      const cssPath = args.path + '.snapshot.css';
      css.set(cssPath, transformed.css.join('\n'));
      const contents = transformed.code.replace(/import\s+"[^"]+\?astro&type=style[^"\n]*";/g, `import ${JSON.stringify(cssPath)};`);
      if(contents.includes('createMetadata'))throw Error('Missing Astro compiler path-resolver contract');
      return { contents, loader: 'ts', resolveDir: dirname(args.path) };
    });
    builder.onLoad({ filter: /.*/, namespace: 'snapshot-css' }, args => ({ contents: css.get(args.path), loader: 'css', resolveDir: dirname(args.path) }));
  },
};
const css = new Map();
const entry = join(here, 'entry.mjs');
writeFileSync(entry, `import {experimental_AstroContainer} from 'astro/container';
import Page from ${JSON.stringify(join(root, 'src/pages/edit/[id].astro'))};
import {requestState,current} from './context.mjs';
export async function renderEditor(state,url,styles,scriptUrls,preloads=[]){
 return requestState.run(state,async()=>{
  const container=await experimental_AstroContainer.create({resolve:id=>scriptUrls[id]??(()=>{throw Error('Unresolved script '+id)})()});
  const html=await container.renderToString(Page,{props:{item:current().item},request:new Request(url),partial:false});
  return html.replace('</head>',preloads.map(url=>'<link rel="modulepreload" href="'+url+'">').join('')+'<style>'+styles+'</style></head>');
 });
}
`);
const server = await build({ entryPoints: [entry], outfile: join(out, 'renderer.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022', minify: false, metafile: true, plugins: [plugin], external: ['node:*'], loader: { '.woff2': 'file' }, define: { 'import.meta.env.PUBLIC_RELEASE_REVISION': JSON.stringify(revision), 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.BASE_URL': '"/"' }, logLevel: 'warning' });
const inputNames = Object.keys(server.metafile.inputs);
if (inputNames.some(name => /(?:data\/art\.json|editorial\/reviews\.json|preview-assets|monochrome-catalog|collection-editorial\.mjs)$/.test(name))) throw Error('Full catalog or build-only code embedded in renderer');
const virtualEntries = [...scripts.keys()].map((id, index) => [`script-${index}`, id]);
const workerAssets=clientWorkers({root,outdir:join(out,'client'),revision});
const client = await build({ entryPoints: Object.fromEntries(virtualEntries), outdir: join(out, 'client'), publicPath:`/__ssr-client/${revision}/`, entryNames:'[name]-[hash]', chunkNames:'chunk-[hash]', loader:{'.wasm':'file'}, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, metafile: true, plugins: [workerAssets.plugin,{ name: 'private-client-scripts', setup(b) {
  b.onResolve({filter:/\?astro&type=script/}, args=>({path:args.path,namespace:'astro-script'}));
  b.onLoad({filter:/.*/,namespace:'astro-script'},args=>({contents:scripts.get(args.path).code,loader:'ts',resolveDir:scripts.get(args.path).directory}));
} }], define: { 'import.meta.env.PUBLIC_RELEASE_REVISION': JSON.stringify(revision), 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.BASE_URL': '"/"' }, logLevel: 'warning' });
workerAssets.merge(client.metafile);
const scriptUrls = Object.fromEntries(virtualEntries.map(([name, id])=>{
 const match=Object.entries(client.metafile.outputs).find(([,info])=>info.entryPoint===`astro-script:${id}`);
 if(!match)throw Error(`Missing content-versioned browser entry ${name}`);
 return [id,`/__ssr-client/${revision}/${match[0].split('/').at(-1)}`];
}));
writeFileSync(join(out,'script-urls.json'),JSON.stringify(scriptUrls));
writeFileSync(join(out,'server-metafile.json'),JSON.stringify(server.metafile));
writeFileSync(join(out,'client-metafile.json'),JSON.stringify(client.metafile));
const byteReport = meta=>Object.entries(meta.outputs).map(([file,info])=>({file,bytes:info.bytes,gzipBytes:gzipSync(readFileSync(file)).length,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}));
const critical=editorCriticalPreloads(client.metafile,revision);
const report={criticalModulePreloads:critical.urls,criticalModulePreloadBytes:critical.bytes,scope:'PRIVATE_EDITOR_COMPILER_AND_REQUEST_RENDER_ONLY_NOT_DEPLOYED',revision,astro:'7.4.2',legacyCompilerMetadataRemoved:false,productionAdapterVerified:false,server:byteReport(server.metafile),client:byteReport(client.metafile),astroComponents:[...css.keys()].length,compilerDiagnostics:diagnostics,fullCatalogEmbedded:false,inputNames};
writeFileSync(join(here,'build-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,inputNames:undefined,client:{files:report.client.length,bytes:report.client.reduce((n,x)=>n+x.bytes,0)}}));
