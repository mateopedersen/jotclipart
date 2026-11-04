// Snapshot-only inputs for existing catalog shells; no full artwork catalog.
import {readArtwork} from './artwork-facet-reader.mjs';
import {readSharedArtwork} from './shared-artwork-context.mjs';
import {openSevenFacetCollectionContext} from './collection-context.mjs';
import {newestIDs,recentSubjectIDs} from './recent-ledger.mjs';
import {openSearch} from '../catalog-search/runtime.mjs';
import {makeStore} from '../catalog-search/store.mjs';
import {uiProviders} from '../catalog-search/ui-metadata.mjs';
import {latestSubjectCollections} from '../../src/lib/collection-discovery.ts';
import {defaults} from '../../src/lib/search.ts';
export async function readShellPageState(bucket,context,kind,{cluster,allowFixture=false,dataOnly=false}={}){
 const cc=await openSevenFacetCollectionContext(bucket,{snapshot:context.snapshot,allowUnpublishableFixture:allowFixture}),descriptor=cc.collections.shells;
 if(!descriptor)throw Error('Discovery context unavailable');const root=await context.read('collections',descriptor,{maxBytes:65536});if(root.schema!==1||root.type!=='discovery-shell-directory'||!root.fields)throw Error('Invalid discovery context');
 async function field(name,limit=10000){const pages=root.fields[name];if(!Array.isArray(pages)||pages.length>128)throw Error('Invalid discovery field');const result=[];for(const d of pages){const page=await context.read('collections',d,{maxBytes:65536});if(page.schema!==1||page.type!=='discovery-shell-rows'||page.field!==name||page.offset!==result.length||!Array.isArray(page.entries)||page.entries.length!==d.count)throw Error('Discovery part mismatch');result.push(...page.entries);if(result.length>limit)throw Error('Discovery budget exceeded')}return result}
 const [features,staticIds,clusters]=await Promise.all([dataOnly?{surprise:[],ids:[],artworks:[]}:cc.read(cc.root.features,256*1024),dataOnly?[]:field('staticIds',128),field('clusters',128)]),shared=await readSharedArtwork(context,features),byId=new Map(shared.map(a=>[a.id,a]));
 async function artwork(ids){if(ids.length>1500||new Set(ids).size!==ids.length)throw Error('Invalid shell artwork keys');let cursor=0;const rows=Array(ids.length);await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{while(cursor<ids.length){const i=cursor++,id=ids[i],a=byId.get(id)??await readArtwork(context,id);if(!a?.published||!a.indexable)throw Error('Shell references missing artwork');byId.set(id,a);rows[i]=a}}));return rows}
 const staticArt=await artwork(staticIds),state={art:staticArt,topics:[],clusters,counts:{...cc.global,topics:{}},surprise:features.surprise.map(p=>({id:p.id,topic:p.topic,...(Object.hasOwn(p,'fresh')?{fresh:p.fresh}:{})})),summaries:new Map(),paragraphs:new Map(),copy:{},relations:{},clusterNames:{},newestArt:[],blackAndWhiteArt:[],props:{},searchManifest:{version:context.rootSHA256}};
 const rs={get:d=>context.read('recent',d,{maxBytes:65536})},recent=await context.getFacet('recent');if(recent.type!=='recent-directory')throw Error('Invalid recent root');
 if(kind==='new'){state.newestArt=await artwork(await newestIDs(rs,recent.ledger,{limit:32}));state.props.snapshotTotal=cc.global.totals.artworks}
 if(kind==='search'||kind==='monochrome'){
  const engine=await openSearch(bucket,context.snapshot.indexes.search,{allowPrivateFixture:allowFixture}),data={engine,manifest:engine.manifest,store:makeStore(bucket,{cacheLimit:64,maxReads:4000,maxBytes:64*1024*1024})},ctx={snapshotSha256:context.rootSHA256},found=await engine.search(kind==='monochrome'?{...defaults,sort:'newest',size:24}:defaults,kind==='monochrome'?['print/monochrome']:[]),full=await artwork(found.items.map(a=>a.id));
  state.monochromeDirectory=(await uiProviders.readMonochromeDirectory(ctx,data)).value;if(state.monochromeDirectory.total!==cc.global.totals.printable)throw Error('Monochrome totals differ');
  if(kind==='search'){state.topics=await field('topics');state.props.snapshotSearch={version:context.rootSHA256,result:{...found,items:full},colors:await field('colors',128),styles:await field('styles',128)}}else{state.newestArt=full;state.blackAndWhiteArt=full}
 }
 if(['categories','collections','library','cluster'].includes(kind)){
  const [subjects,groups,topics,counts]=await Promise.all([field('subjects'),field('clustersData',128),field('topics'),cc.allLegacyCounts()]);state.counts=counts;state.topics=topics;state.clusterNames=Object.fromEntries(topics.map(t=>[t.slug,[t.cluster]]));
  const ids=dataOnly?[]:[...new Set([...(kind==='categories'?subjects.map(t=>t.sampleId):[]),...(['categories','collections'].includes(kind)?groups.flatMap(g=>g.previewIds):[])])];await artwork(ids);state.categorySubjects=subjects.map(({sampleId,...t})=>{if(t.count!==counts.topics[t.slug])throw Error('Stale discovery topic count');return{...t,sample:byId.get(sampleId)}});const bySlug=new Map(state.categorySubjects.map(t=>[t.slug,t]));state.categoryCollections=groups.map(({subjectSlugs,previewIds,...g})=>{if(g.count!==counts.collections[g.slug]?.artworks)throw Error('Stale discovery cluster count');return{...g,subjects:subjectSlugs.map(slug=>{const t=bySlug.get(slug);if(!t)throw Error('Missing subject');return t}),previews:previewIds.map(id=>byId.get(id))}});
  if(kind==='collections'){const latest=await artwork(await recentSubjectIDs(rs,recent.ledger,8));state.latestCollections=latestSubjectCollections(state.categorySubjects,latest);state.collectionFeed={version:context.rootSHA256,items:state.latestCollections}}
  if(kind==='cluster'){const picks=(await field('clusterPicks',128)).find(p=>p.cluster===cluster);if(!picks)return undefined;state.art=[...await artwork(picks.ids),...staticArt.filter(a=>!picks.ids.includes(a.id))];state.props.cluster=cluster}
  if(kind==='library')state.directoryArtwork=await artwork(await field('directoryIds',1000));
 }
 if(kind==='create'){const d=await context.read('collections',cc.collections.studioFeatured,{maxBytes:65536});if(d.type!=='studio-featured'||!Array.isArray(d.ids)||d.ids.length>500)throw Error('Invalid Studio initial set');state.featuredStudioArt=await artwork(d.ids);state.studioCompositionPreviews=await field('studioCompositionPreviews',128)}
 return state;
}
