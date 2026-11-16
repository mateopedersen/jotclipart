import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {captureProductionSnapshot} from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import {readArtwork} from '../../server/catalog-snapshot/artwork-facet-reader.mjs';
import {recentSubjectIDs} from '../../server/catalog-snapshot/recent-ledger.mjs';
import {publicBrandURL} from '../../src/lib/brand.mjs';

// Source inventory preparation, not publication. No R2 writes or inference.
const root=process.cwd(),metadata=resolve(process.argv[2]??'../captured-catalog');
const snapshotBytes=await readFile(resolve(metadata,'production-snapshot.json'));
const snapshot=JSON.parse(snapshotBytes),cfg=JSON.parse(await readFile('config/catalog-snapshot-public.json'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const bucket={async get(key){const file=key===cfg.activeKey?resolve(metadata,'production-snapshot.json'):/^catalog\/objects\/(?:artworks|collections|search|recent|related|counts|sitemaps)\/[a-f0-9]{64}\.json$/.test(key)?resolve(metadata,key.split('/').at(-1)):null;if(!file)throw Error('Source inventory read scope rejected');const b=await readFile(file);return {size:b.length,arrayBuffer:async()=>Uint8Array.from(b).buffer,json:async()=>JSON.parse(b)}}};
const ctx=await captureProductionSnapshot(bucket,{...cfg,publicKey:Buffer.from(cfg.publicKeyHex,'hex'),abiSHA256:snapshot.authorization.abiSHA256});
const source=JSON.parse(await readFile('data/art.json'));
const byPath=new Map(source.map(item=>['public'+item.webp,item]));
try{const prior=JSON.parse(await readFile('data/social-source-artworks.json'));for(const item of prior.items)if(!byPath.has(item.localPath))byPath.set(item.localPath,{id:item.id,files:{webp:{sha256:item.sha256,bytes:item.bytes}},webp:item.localPath.slice(6)});}catch(error){if(error.code!=='ENOENT')throw error;}
const previous=JSON.parse(await readFile('data/social-image-provenance.json'));
const paths=[...new Set(Object.values(previous.pages).flatMap(page=>page.sources.map(s=>s.path)))].filter(p=>p.startsWith('public/catalog/')).sort();
const items=[];
const currentSampleIDs=[];
const recent=await ctx.getFacet('recent');
const newest=await recentSubjectIDs({get:d=>ctx.read('recent',d,{maxBytes:65536})},recent.ledger,6);
const topics=new Set();
for(const id of newest){const item=await readArtwork(ctx,id);if(!item?.published||!item.indexable)throw Error('Recent social sample is not published');if(topics.has(item.topic))continue;topics.add(item.topic);currentSampleIDs.push(id);if(currentSampleIDs.length===6)break;}
if(currentSampleIDs.length!==6)throw Error('Current social samples incomplete');
for(const localPath of paths){
 const old=byPath.get(localPath);if(!old)throw Error('Original social source identity missing');
 const item=await readArtwork(ctx,old.id);
 if(!item?.published||!item.indexable)throw Error('Social source is no longer published');
 if(old.files.webp.sha256!==item.files.webp.sha256||old.files.webp.bytes!==item.files.webp.bytes)throw Error('Approved social artwork bytes changed; review required');
 const url=publicBrandURL(item.webp);
 if(!url.startsWith('https://assets.jotclipart.com/')||!url.endsWith('.webp'))throw Error('Unreviewed public source origin');
 items.push({id:item.id,localPath,url,bytes:item.files.webp.bytes,sha256:item.files.webp.sha256,mime:'image/webp',sourceRecordSHA256:sha(JSON.stringify(item)),...(!source.some(row=>row.id===item.id)?{catalogRecord:{...item,webp:localPath.slice(6)}}:{})});
}
for(const id of currentSampleIDs){
 if(items.some(item=>item.id===id))continue;
 const item=await readArtwork(ctx,id);
 const old=source.find(row=>row.id===id);
 const localPath=old?'public'+old.webp:'public/catalog/social-approved/'+id+'.webp';
 const url=publicBrandURL(item.webp);
 if(!url.startsWith('https://assets.jotclipart.com/')||!url.endsWith('.webp'))throw Error('Unreviewed recent social source origin');
 items.push({id,localPath,url,bytes:item.files.webp.bytes,sha256:item.files.webp.sha256,mime:'image/webp',sourceRecordSHA256:sha(JSON.stringify(item)),catalogRecord:{...item,webp:localPath.slice(6)}});
}
const manifest={version:1,policy:'signed-catalog-bound-reviewed-social-originals-v1',
 signedCatalogRoot:ctx.rootSHA256,catalogRevision:ctx.snapshot.revision,signatureVerified:true,
 accountId:cfg.accountId,bucketName:cfg.bucketName,keyId:cfg.keyId,publicKeyHex:cfg.publicKeyHex,
 sourceSnapshotSHA256:sha(snapshotBytes),productionSnapshot:ctx.snapshot,currentSampleIDs,items};
await writeFile('data/social-source-artworks.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:'SOCIAL_ORIGINAL_REFERENCES_SIGNED_AND_HASH_BOUND',artworks:items.length,bytes:items.reduce((n,x)=>n+x.bytes,0),root:ctx.rootSHA256}));
