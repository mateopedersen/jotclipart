// Private complete art-page state from one captured metadata snapshot.
import {readArtwork} from './artwork-facet-reader.mjs';
import {readBoundedRelated} from './related-bounded-reader.mjs';
import {lookupHashedRecord} from './hashed-record-directory.mjs';
import {readSharedArtwork} from './shared-artwork-context.mjs';
import {openSevenFacetCollectionContext} from './collection-context.mjs';
export async function readArtworkPageState(bucket,context,id,{allowFixture=false}={}){
 const item=await readArtwork(context,id);if(!item)return undefined;
 const collections=await openSevenFacetCollectionContext(bucket,{snapshot:context.snapshot,allowUnpublishableFixture:allowFixture});
 const related=await readBoundedRelated(context,id,{hasTopic:async slug=>!!await collections.lookupCollection(slug),topicFor:async slug=>{const d=await collections.lookupCollection(slug);return d?collections.read(d,256*1024):undefined}});
 const ownEntry=await collections.lookupCollection(item.topic);if(!ownEntry)throw Error('Artwork collection missing');
 const record=await collections.read(ownEntry,256*1024);if(record.slug!==item.topic)throw Error('Wrong artwork collection');
 const category=/^\/clipart\/([a-z0-9-]+)\/$/.exec(related.category)?.[1];if(!category)throw Error('Invalid collection preview route');
 const descriptor=await lookupHashedRecord(context,'collections',collections.collections.catalogPreviewDirectory,category);if(!descriptor)throw Error('Collection preview missing');
 const roster=await context.read('collections',descriptor,{maxBytes:256*1024});
 // Explicit bound until a positional-tree extension is verified. This handles
 // many topics without a full-catalog read; no claim of unbounded topic size.
 if(roster.schema!==1||roster.type!=='catalog-order-preview'||roster.topic!==category||!Array.isArray(roster.ids)||roster.ids.length>4096||new Set(roster.ids).size!==roster.ids.length)throw Error('Invalid collection preview');
 const others=roster.ids.filter(x=>x!==item.id),choices=others.length?others:roster.ids,ids=choices.length<=3?choices:[choices[0],choices[Math.floor(choices.length/3)],choices[Math.floor(2*choices.length/3)]];
 const previews=await Promise.all(ids.map(async target=>{const a=await readArtwork(context,target);if(!a||a.topic!==category)throw Error('Preview references wrong collection');return a}));
 const [features,counts]=await Promise.all([collections.read(collections.root.features,256*1024),collections.countsFor([item.topic,category],{strict:true})]);
 if(!Array.isArray(features.artworks)||!Array.isArray(features.surprise)||features.artworks.length>500||features.surprise.length>500)throw Error('Invalid shared page context');
 const topic={slug:record.slug,keyword:record.keyword,cluster:record.primaryCluster,sourceCluster:record.sourceCluster};
 const surprise=features.surprise.map(p=>({id:p.id,topic:p.topic,...(Object.hasOwn(p,'fresh')?{fresh:p.fresh}:{})})),shared=await readSharedArtwork(context,features);
 return{item,related,collectionPreview:(slug,sourceId)=>{if(slug!==category||sourceId!==item.id)throw Error('Wrong preview source');return previews},art:[item,...shared],topics:[topic],counts,surprise,summaries:new Map(),paragraphs:new Map(),copy:{},relations:{},clusterNames:{[topic.slug]:[]}};
}
