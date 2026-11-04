// Private editor state. Original source identity remains authoritative.
import {readArtwork} from './artwork-facet-reader.mjs';
import {lookupHashedRecord} from './hashed-record-directory.mjs';
import {readSharedArtwork} from './shared-artwork-context.mjs';
import {openSevenFacetCollectionContext} from './collection-context.mjs';
export async function readEditorPageState(bucket,context,id,{allowFixture=false}={}){
 const item=await readArtwork(context,id);if(!item)return undefined;
 const collections=await openSevenFacetCollectionContext(bucket,{snapshot:context.snapshot,allowUnpublishableFixture:allowFixture});
 const [artRoot,features,studio]=await Promise.all([context.getFacet('artworks'),collections.read(collections.root.features,256*1024),context.read('collections',collections.collections.studioFeatured,{maxBytes:65536})]);
 if(studio.schema!==1||studio.type!=='studio-featured'||!Array.isArray(studio.ids)||studio.ids.length>500||new Set(studio.ids).size!==studio.ids.length)throw Error('Invalid Studio features');
 const featuredStudioArt=[];let cursor=0;const output=Array(studio.ids.length);await Promise.all(Array.from({length:Math.min(16,studio.ids.length)},async()=>{while(cursor<studio.ids.length){const i=cursor++,a=await readArtwork(context,studio.ids[i]);if(!a||a.sourceType!=='raster')throw Error('Missing Studio artwork');output[i]=a}}));featuredStudioArt.push(...output);
 let editorItem=item;
 if(item.sourceType==='raster'){
  const decision=await lookupHashedRecord(context,'artworks',artRoot.editorPreviews,id);if(!decision)throw Error('Missing editor source decision');
  if(decision.schema!==1||decision.type!=='editor-source'||decision.id!==id||decision.sourceSHA256!==item.files?.webp?.sha256)throw Error('Stale editor source decision');
  if(decision.preview){if(!/^\/previews\/p1\/[a-f0-9]{24}-960\.webp$/.test(decision.preview)||!Number.isSafeInteger(decision.width)||decision.width<1||!Number.isSafeInteger(decision.height)||decision.height<1||Math.max(decision.width,decision.height)>960)throw Error('Invalid editor preview');editorItem={...item,preview:decision.preview,previewWidth:decision.width,previewHeight:decision.height}}
 }
 if(!Array.isArray(features.artworks)||!Array.isArray(features.surprise)||features.artworks.length>500||features.surprise.length>500)throw Error('Invalid shared editor context');
 const surprise=features.surprise.map(p=>({id:p.id,topic:p.topic,...(Object.hasOwn(p,'fresh')?{fresh:p.fresh}:{})}));
 const shared=await readSharedArtwork(context,features);
 return{item,editorItem,featuredStudioArt,art:[item,...shared],topics:[],counts:{...collections.global,topics:{}},surprise,summaries:new Map(),paragraphs:new Map(),copy:{},relations:{},clusterNames:{}};
}
