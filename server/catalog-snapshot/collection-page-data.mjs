import{validatePageArtwork as artwork}from'./legacy-artwork-validation.mjs';import{SnapshotFault}from'./fault.mjs';const slugOK=x=>typeof x==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x);const fail=m=>{throw new SnapshotFault(503,m)};
export async function collectionStateFromContext(ctx,slug){
 if(!slugOK(slug))throw new SnapshotFault(404,'Unknown collection');
 const entry=await ctx.lookupCollection(slug);
 if(!entry)throw new SnapshotFault(404,'Unknown collection');
 const record=await ctx.read(entry,256*1024);
 if(record.schema!==1||record.type!=='collection-topic'||record.slug!==slug||record.path!==`/clipart/${slug}/`||record.canonical!==`https://ultraclipart.com/clipart/${slug}/`||!Array.isArray(record.paragraphs)||record.paragraphs.length<2||record.paragraphs.length>3||record.paragraphs.some(p=>typeof p!=='string')||!Array.isArray(record.membership)||!Array.isArray(record.pageBlocks)||!Array.isArray(record.related)||record.related.length>6||!Array.isArray(record.relatedContext)||record.relatedContext.length!==record.related.length)fail('Invalid partitioned page record');
 const counts=await ctx.countsFor([slug,...record.related.map(r=>r.slug)],{strict:true});
 if(record.artworkCount!==counts.topics[slug]||record.artworkCount!==entry.artworkCount)fail('Page count differs from topic count piece');
 const ids=[];let offset=0;
 for(const d of record.membership){const part=await ctx.read(d,256*1024);if(part.schema!==1||part.type!=='collection-members'||part.slug!==slug||part.offset!==offset||d.offset!==offset||!Array.isArray(part.artworkIds)||part.artworkIds.length!==d.count||d.count<1||d.count>256)fail('Invalid partitioned membership');ids.push(...part.artworkIds);offset+=d.count}
 if(ids.length!==record.artworkCount||new Set(ids).size!==ids.length||ids[0]!==record.coverArtworkId||ids.some(id=>!slugOK(id)))fail('Invalid ordered page IDs');
 const gallery=[];offset=0;
 for(const d of record.pageBlocks){const block=await ctx.read(d,256*1024);if(block.schema!==1||block.type!=='collection-page-artworks'||block.slug!==slug||block.offset!==offset||d.offset!==offset||!Array.isArray(block.artworks)||block.artworks.length!==d.count||d.count<1||d.count>32)fail('Invalid partitioned artwork block');gallery.push(...block.artworks.map(artwork));offset+=d.count}
 if(gallery.length!==ids.length||gallery.some((a,i)=>a.id!==ids[i]||a.topic!==slug))fail('Page artwork order differs from membership');
 const related=record.relatedContext.map((target,i)=>{const expected=record.related[i];if(!slugOK(target.slug)||target.slug!==expected.slug||target.slug===slug||typeof target.keyword!=='string'||typeof target.primaryCluster!=='string'||typeof target.sourceCluster!=='string'||target.artworkCount!==counts.topics[target.slug]||target.artworkCount!==expected.artworkCount)fail('Invalid related topic context');const cover=artwork(target.cover);if(cover.id!==expected.coverArtworkId||cover.topic!==target.slug)fail('Invalid related cover');return target});
 const features=await ctx.read(ctx.root.features,256*1024);if(!Array.isArray(features.ids)||!Array.isArray(features.artworks)||!Array.isArray(features.surprise)||features.ids.length!==features.artworks.length||features.ids.some((id,i)=>id!==features.artworks[i].id))fail('Invalid shared artwork context');
 const art=new Map();for(const a of [...gallery,...features.artworks.map(artwork),...related.map(r=>r.cover)]){if(art.has(a.id)&&JSON.stringify(art.get(a.id))!==JSON.stringify(a))fail('Conflicting reviewed page artwork');art.set(a.id,a)}
 const topic=r=>({slug:r.slug,keyword:r.keyword,cluster:r.primaryCluster,sourceCluster:r.sourceCluster});
 return{revision:ctx.revision,rootSHA256:ctx.rootSHA256,objectsRead:ctx.immutableObjectsRead(),pointerReads:ctx.pointerReads,totalR2Reads:ctx.totalR2Reads(),topicCountsRead:Object.keys(counts.topics).length,record,state:{
  topic:topic(record),art:[...art.values()],topics:[topic(record),...related.map(topic)],counts,
  surprise:features.surprise.map(p=>({id:p.id,topic:p.topic,...(Object.hasOwn(p,'fresh')?{fresh:p.fresh}:{})})),
  summaries:new Map([[slug,record.summary]]),paragraphs:new Map([[slug,record.paragraphs]]),
  copy:Object.fromEntries([[slug,{featured:ids}],...record.related.map(r=>[r.slug,{featured:[r.coverArtworkId]}])]),
  relations:{[slug]:record.related.map(r=>r.slug)},clusterNames:{[slug]:record.clusters.map(c=>c.name)},
 }};
}
