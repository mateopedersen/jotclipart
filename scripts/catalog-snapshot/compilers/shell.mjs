// Private local SSR experiment. Does not read credentials, upload or activate.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {writeScopedContext} from './scoped-context.mjs';
const root = process.cwd(), here = resolve(process.env.UC_SNAPSHOT_BUILD_ROOT ?? 'work/catalog-snapshot/build', 'shell-ssr'), out = join(here, 'compiled');
mkdirSync(out, { recursive: true });
writeScopedContext(join(here,'context.mjs'),root);
const compiler = createRequire(import.meta.resolve('astro/package.json'))('@astrojs/compiler-rs');
const context = join(here, 'context.mjs');
const revision = process.env.UC_SNAPSHOT_CODE_REVISION; if(!/^[a-f0-9]{40}$/.test(revision??''))throw Error('Canonical compiler source revision required');
const pages={new:'new.astro',search:'search.astro',monochrome:'black-and-white.astro',categories:'categories.astro',collections:'collections.astro',cluster:'collection/[slug].astro',library:'library-index.astro',create:'create.astro',favorites:'favorites.astro'};
const scripts = new Map(), diagnostics = [];
const cookieScripts=await import(pathToFileURL(join(root,'scripts/cookie-startup.mjs')));
const screenModule=join(here,'screen-preview-run.mjs');await build({entryPoints:[join(root,'src/lib/screen-preview.ts')],outfile:screenModule,bundle:true,platform:'node',format:'esm',packages:'external'});const {screenPreview}=await import(pathToFileURL(screenModule));const screenUrls={},screenProofs=[];for(const match of readFileSync(join(root,'src/components/StudioWalkthrough.astro'),'utf8').matchAll(/capture:\s*\{[^}]*?src:\s*'([^']+)'[^}]*?crop:\s*\[([\d,\s]+)\]/g)){const source=match[1],crop=match[2].split(',').map(Number),url=await screenPreview(source,crop),bytes=readFileSync(join(root,'public',url));screenUrls[source+'|'+crop.join(',')]=url;screenProofs.push({source,sourceSHA256:createHash('sha256').update(readFileSync(join(root,'public',source))).digest('hex'),crop,path:join(root,'public',url),url,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length})}if(screenProofs.length!==3)throw Error('Complete Studio screenshot crops required');
const aliases = new Map([
[join(root,'src/lib/screen-preview.ts'),`const sources=${JSON.stringify(screenUrls)};export async function screenPreview(source,crop){const url=sources[source+'|'+crop.join(',')];if(!url)throw Error('Unbound Studio screenshot');return url;}`],

[join(root,'src/lib/studio-composition-previews.ts'),`import {scoped} from ${JSON.stringify(context)};export const studioCompositionPreviews=scoped('studioCompositionPreviews',[]);`],

[join(root,'src/lib/search-build.ts'),`import {current} from ${JSON.stringify(context)};export async function getSearchBuild(){return {manifest:current().searchManifest}}`],
[join(root,'src/lib/category-directory.ts'),`import {scoped} from ${JSON.stringify(context)};export const categorySubjects=scoped('categorySubjects',[]),categoryCollections=scoped('categoryCollections',[]);`],
[join(root,'src/lib/collection-feed.ts'),`import {scoped} from ${JSON.stringify(context)};export const latestCollections=scoped('latestCollections',[]),collectionFeed=scoped('collectionFeed');`],
[join(root,'src/lib/category-search-index.ts'),`export const categorySearchUrl='/category-search/current.json';`],
[join(root,'src/lib/monochrome-library.ts'),`import {scoped} from ${JSON.stringify(context)};export const monochromeDirectory=scoped('monochromeDirectory');`],
[join(root,'src/lib/studio-artwork.ts'),`import {current,scoped} from ${JSON.stringify(context)};export const FEATURED_ARTWORK_LIMIT=500,featuredStudioArt=scoped('featuredStudioArt',[]);export const getFeaturedStudioCount=()=>current().featuredStudioCount??current().featuredStudioArt.length;`],
[join(root,'src/lib/sitemaps.ts'),`import {current} from ${JSON.stringify(context)};export const indexableTopics=()=>current().topics;export const directoryArtwork=()=>current().directoryArtwork??[];`],

  [join(root,'scripts/cookie-startup.mjs'),`export const cookieStartupScript=${JSON.stringify(cookieScripts.cookieStartupScript)};export const cookieMountScript=${JSON.stringify(cookieScripts.cookieMountScript)};`],
  [join(root, 'src/lib/catalog.ts'), `import {current,scoped} from ${JSON.stringify(context)};
    export const art=scoped('art',[]),publishedArt=scoped('art',[]),availableTopics=scoped('topics',[]),topics=scoped('topics',[]),newestArt=scoped('newestArt',[]),blackAndWhiteArt=scoped('blackAndWhiteArt',[]),availableClusters=scoped('clusters',[]);export const topicInCluster=(topic,cluster)=>topic.cluster===cluster;
    export const reviewedCollectionIntroductions=scoped('summaries',new Map()),reviewedCollectionParagraphs=scoped('paragraphs',new Map());
    export const topicArt=slug=>current().art.filter(a=>a.topic===slug);
    export const slugify=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    export const clustersForTopic=topic=>current().clusterNames[topic.slug];`],
  [join(root, 'src/lib/related/service.ts'), `import {current} from ${JSON.stringify(context)};export const relatedIndex={snapshot:id=>{if(current().related.sourceId!==id)throw Error('Wrong related source');return current().related}};`],
  [join(root, 'src/lib/collection-preview.ts'), `import {current} from ${JSON.stringify(context)};export const collectionPreview=(topic,sourceId)=>current().collectionPreview(topic,sourceId);`],
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
const entries={};
for(const [name,page] of Object.entries(pages)){
 const entry=join(here,name+'-entry.mjs');entries[name]=entry;
 writeFileSync(entry,`import {experimental_AstroContainer} from 'astro/container';import Page from ${JSON.stringify(join(root,'src/pages',page))};import {requestState} from './context.mjs';export async function renderPage(state,url,styles,scriptUrls){return requestState.run(state,async()=>{const container=await experimental_AstroContainer.create({resolve:id=>scriptUrls[id]??(()=>{throw Error('Unresolved script '+id)})()});const html=await container.renderToString(Page,{props:state.props??{},request:new Request(url),partial:false});return html.replace('</head>','<style>'+styles+'</style></head>');});}`);
}
const server=await build({entryPoints:entries,outdir:out,bundle:true,splitting:true,format:'esm',platform:'node',target:'es2022',minify:true,metafile:true,plugins:[plugin],external:['node:*'],loader:{'.woff2':'file'},define:{'import.meta.env.PUBLIC_RELEASE_REVISION':JSON.stringify(revision),'import.meta.env.DEV':'false','import.meta.env.PROD':'true','import.meta.env.BASE_URL':'"/"'},logLevel:'warning'});
const inputNames = Object.keys(server.metafile.inputs);
if (inputNames.some(name => /(?:data\/art\.json|editorial\/reviews\.json|preview-assets|monochrome-catalog|collection-editorial\.mjs)$/.test(name))) throw Error('Full catalog or build-only code embedded in renderer: '+inputNames.filter(name => /(?:data\/art\.json|editorial\/reviews\.json|preview-assets|monochrome-catalog|collection-editorial\.mjs)$/.test(name)).join(','));
const virtualEntries = [...scripts.keys()].map((id, index) => [`script-${index}`, id]);
const client = await build({ entryPoints: Object.fromEntries(virtualEntries), outdir: join(out, 'client'), publicPath:`/__ssr-client/${revision}/`, entryNames:'[name]-[hash]', chunkNames:'chunk-[hash]', loader:{'.wasm':'file'}, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, metafile: true, plugins: [{ name: 'private-client-scripts', setup(b) {
  b.onResolve({filter:/\?astro&type=script/}, args=>({path:args.path,namespace:'astro-script'}));
  b.onLoad({filter:/.*/,namespace:'astro-script'},args=>({contents:scripts.get(args.path).code,loader:'ts',resolveDir:scripts.get(args.path).directory}));
} }], define: { 'import.meta.env.PUBLIC_RELEASE_REVISION': JSON.stringify(revision), 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.BASE_URL': '"/"' }, logLevel: 'warning' });
const scriptUrls = Object.fromEntries(virtualEntries.map(([name, id])=>{
 const match=Object.entries(client.metafile.outputs).find(([,info])=>info.entryPoint===`astro-script:${id}`);
 if(!match)throw Error(`Missing content-versioned browser entry ${name}`);
 return [id,`/__ssr-client/${revision}/${match[0].split('/').at(-1)}`];
}));
writeFileSync(join(out,'script-urls.json'),JSON.stringify(scriptUrls));
writeFileSync(join(out,'server-metafile.json'),JSON.stringify(server.metafile));
writeFileSync(join(out,'client-metafile.json'),JSON.stringify(client.metafile));
const byteReport = meta=>Object.entries(meta.outputs).map(([file,info])=>({file,bytes:info.bytes,gzipBytes:gzipSync(readFileSync(file)).length,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}));
const report={scope:'SOURCE_TEMPLATE_COMPILE_ONLY_NOT_PUBLISHED',revision,astro:'7.4.2',legacyCompilerMetadataRemoved:false,productionAdapterVerified:false,server:byteReport(server.metafile),client:byteReport(client.metafile),astroComponents:[...css.keys()].length,compilerDiagnostics:diagnostics,screenProofs,fullCatalogEmbedded:false,inputNames};
writeFileSync(join(here,'build-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,inputNames:undefined,client:{files:report.client.length,bytes:report.client.reduce((n,x)=>n+x.bytes,0)}}));
