// Publisher-side source derivation. Reuses installed renderers; never compiles Astro,
// opens native media, uploads files, changes credentials or activates a snapshot.
import {gzipSync} from 'node:zlib';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {prepareHTMLRecord,preparedSourceBinding} from '../../server/catalog-snapshot/prepared-html.mjs';
import {prepareStudioInfoRecord} from '../../server/catalog-snapshot/prepared-studio.mjs';
import {studioInfo} from '../../server/catalog-search/ui-metadata.mjs';
import {openSearch} from '../../server/catalog-search/runtime.mjs';
import {makeStore} from '../../server/catalog-search/store.mjs';
import {openSevenFacetCollectionContext} from '../../server/catalog-snapshot/collection-context.mjs';
import {readHomePageState} from '../../server/catalog-snapshot/home-page-data.mjs';
import {readArtworkPageState} from '../../server/catalog-snapshot/art-page-data.mjs';
import {readShellPageState} from '../../server/catalog-snapshot/shell-page-data.mjs';
import {readCollectionReferences} from '../../server/catalog-collections/reader.mjs';
import {readArtwork} from '../../server/catalog-snapshot/artwork-facet-reader.mjs';
import {readSurprisePicks} from '../../server/catalog-snapshot/surprise-picks.mjs';
import {readShellField} from '../../server/catalog-projections/shell.mjs';
import {activeCuratedCollections} from '../../src/lib/curated-collection-policy.mjs';
import {canonical} from '../../server/catalog-search/store.mjs';
import {buildHashedRecordDirectory} from '../../server/catalog-snapshot/hashed-record-directory-build.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const CORE=[['/','home'],['/new/','new'],['/categories/','categories'],['/collections/','collections'],['/search/','search'],
 ['/black-and-white/','monochrome'],['/library-index/','library'],['/create/','create'],['/favorites/','favorites'],['/ai-clipart-generator/','ai']];
export async function loadPresentationSoftware(software,verifier){
 const directory=realpathSync(resolve(software)),code=JSON.parse(readFileSync(join(directory,'runtime/software-report.json')));
 if(code.abiSHA256!==verifier.abiSHA256)throw Error('Presentation software differs from the authenticated issuer');
 if(!code.presentation)return null; // Historical installed packages retain the canonical path.
 if(code.presentation.version!==1||code.presentation.file!=='runtime/presentation-renderers.mjs')throw Error('Unsupported installed presentation contract');
 const source=join(directory,code.presentation.file),info=lstatSync(source);
 if(info.isSymbolicLink()||!info.isFile()||!realpathSync(source).startsWith(directory+'/')||info.size!==code.presentation.bytes||info.size>32*1024*1024)throw Error('Protected installed presentation bundle required');
 const bundle=readFileSync(source);
 if(sha(bundle)!==code.presentation.sha256||code.sourceInputs?.[code.presentation.sourceInput]!==code.presentation.sha256||
  sha(Buffer.from(JSON.stringify(Object.entries(code.sourceInputs).sort(([a],[b])=>a.localeCompare(b,'en')))))!==code.abiSHA256)
  throw Error('Presentation bundle is not bound by the installed software ABI');
 const {renderers}=await import(pathToFileURL(source).href+'?sha256='+code.presentation.sha256);
 if(!renderers?.home?.render||!renderers?.collection?.render||!renderers?.shells||!renderers?.shellScripts)throw Error('Installed canonical renderers unavailable');
 return{renderers,rendererSHA256:code.abiSHA256,bundleSHA256:code.presentation.sha256};
}
export async function stagePresentationViews({context,bucket,renderers,rendererSHA256,allowFixture=false,
 maxRoutes=1536,maxOutputBytes=128*1024*1024,progress=()=>{}}){
 if(!context||!bucket?.put||!renderers||!Number.isSafeInteger(maxRoutes)||maxRoutes<10||maxRoutes>1536||
  !Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1048576||maxOutputBytes>128*1024*1024)throw Error('Bounded presentation stage required');
 const cc=await openSevenFacetCollectionContext(bucket,{snapshot:context.snapshot,allowUnpublishableFixture:allowFixture}),
  counts=await cc.allLegacyCounts(),collections=await context.getFacet('collections'),
  shells=await context.read('collections',collections.shells,{maxBytes:65536}),groups=await readShellField(context,shells,'clusters');
 const plans=new Map(CORE.map(([path,kind])=>[path,{path,kind}]));
 for(const cluster of groups){const slug=cluster.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');plans.set('/collection/'+slug+'/',{path:'/collection/'+slug+'/',kind:'cluster',cluster});}
 for(const g of activeCuratedCollections(counts.topics))plans.set('/collection/'+g.slug+'/',{path:'/collection/'+g.slug+'/',kind:'cluster',cluster:g.slug});
 for(const slug of Object.keys(counts.topics).sort())plans.set('/clipart/'+slug+'/',{path:'/clipart/'+slug+'/',kind:'collection',topic:slug});
 // Cover the exact current signed roster used by Surprise Me, including the
 // post-load JSON refresh pool. This is bounded metadata rendering, not a full
 // artwork/editor build and never changes an original artwork or download.
 for(const pick of await readSurprisePicks(context,{limit:512}))plans.set('/art/'+pick.id+'/',{path:'/art/'+pick.id+'/',kind:'art',id:pick.id});
 const created=new Map(),entries=[],receipts=[];let bytes=0;
 const put=async value=>{const body=Buffer.from(JSON.stringify(canonical(value))),sha256=sha(body),key='catalog/objects/collections/'+sha256+'.json';
  if(body.length>262144)throw Error('Prepared metadata object bound');
  if(!created.has(key)){created.set(key,body);bytes+=body.length;await bucket.put(key,body);}
  return{key,sha256,bytes:body.length};
 };
 let studio;
 // A publisher-only cache avoids rereading the same authenticated search map
 // branches. Public request budgets and the canonical 500-item contract remain.
 const engine=await openSearch(bucket,context.snapshot.indexes.search,{allowPrivateFixture:allowFixture}),
  data={engine,manifest:engine.manifest,store:makeStore(bucket,{cacheLimit:2048,maxReads:4000,maxBytes:64*1024*1024})},
  info=await studioInfo({...context,snapshotSha256:context.rootSHA256},data);
 if(info.total!==engine.manifest.total)throw Error('Canonical Studio total differs');
 studio=await prepareStudioInfoRecord({context,info,rendererSHA256,compress:b=>gzipSync(b,{level:9}),put});
 let skipped=0,inputBudgetExhausted=false,visited=0;
 for(const plan of plans.values()){
  visited++;
  // Optional acceleration limits must never turn catalog growth into a publish limit.
  // A full route still uses the normal canonical reader when omitted here.
  if(entries.length>=maxRoutes||bytes+2*1024*1024>maxOutputBytes){skipped++;continue;}
  const {path,kind}=plan;let state,render,result;
  try{
  if(kind==='home'){
   state=await readHomePageState(bucket,context,{allowFixture});
   render=s=>renderers.home.render(s,'https://ultraclipart.com'+path,renderers.home.css,renderers.home.scripts);
  }else if(kind==='art'){
   state=await readArtworkPageState(bucket,context,plan.id,{allowFixture});
   render=s=>renderers.art.render(s,'https://ultraclipart.com'+path,renderers.art.css,renderers.art.scripts);
  }else if(kind==='collection'){
   state=(await readCollectionReferences(context,plan.topic,{
    resolveArtwork:async(id,ctx)=>({rootSHA256:ctx.rootSHA256,artwork:await readArtwork(ctx,id)}),
    resolveSurprise:async ctx=>({rootSHA256:ctx.rootSHA256,items:await readSurprisePicks(ctx,{limit:48})})})).state;
   render=s=>renderers.collection.render(s,'https://ultraclipart.com'+path,renderers.collection.css,renderers.collection.scripts);
  }else{
   state=await readShellPageState(bucket,context,kind,{allowFixture,...(plan.cluster?{cluster:plan.cluster}:{})});
   const [fn,css]=renderers.shells[kind];render=s=>fn(s,'https://ultraclipart.com'+path,css,renderers.shellScripts);
  }
  if(!state)throw Error('Canonical presentation route disappeared: '+path);
  result=await prepareHTMLRecord({context,path,state,rendererSHA256,render,compress:b=>gzipSync(b,{level:9}),put});}
  catch(error){
   // An oversized optional document retains the ordinary canonical render path.
   // Authentication, source equivalence and integrity errors still fail closed.
   if(['Prepared HTML expansion bound','Prepared HTML compressed bound'].includes(error?.message)){skipped++;continue;}
   if(['Snapshot read budget exceeded','Changed-batch parent read budget exceeded'].includes(error?.message)){
    skipped+=plans.size-visited+1;inputBudgetExhausted=true;break;
   }
   throw error;
  }
  entries.push({name:path,value:result.descriptor});receipts.push(result.receipt);
  if(entries.length%50===0)progress({phase:'canonical-presentation-only',prepared:entries.length,total:plans.size,bytes});
 }
 const directory=entries.length?buildHashedRecordDirectory('collections',entries):{created:new Map()};
 for(const [key,body]of directory.created){await bucket.put(key,body);created.set(key,body);bytes+=body.length;}
 const plain={...collections};delete plain.preparedHTML;delete plain.preparedArtworkPaths;delete plain.preparedStudio;
 const root=entries.length?await put({schema:1,type:'prepared-html-directory-v1',rendererSHA256,
  sourceBinding:await preparedSourceBinding(context),routeCount:entries.length,directory:directory.root}):null;
 const artworkPaths=receipts.filter(r=>r.path.startsWith('/art/')).map(r=>r.path);
 const next=await put({...plain,...(root?{preparedHTML:root,...(artworkPaths.length?{preparedArtworkPaths:artworkPaths}:{})}:{}),preparedStudio:studio.descriptor});
 if(bytes>maxOutputBytes)throw Error('Prepared output exceeded its declared ceiling');
 return{collections:next,created,receipt:{status:'CANONICAL_DISCOVERY_HTML_DERIVED_NOT_LIVE',
  rendererSHA256,sourceRevision:context.snapshot.revision,canonicalDocumentsPrepared:entries.length,
  optionalRoutesSkipped:skipped,inputBudgetExhausted,discoveryDocumentsPrepared:entries.length-artworkPaths.length,
  artworkDocumentsPrepared:artworkPaths.length,editorDocumentsPrepared:0,originalMediaRead:0,artworksChanged:0,
  objects:created.size,bytes,canonicalDoubleRender:true,studio:studio.receipt,receipts}};
}
