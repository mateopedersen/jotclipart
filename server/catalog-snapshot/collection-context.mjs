// Private bounded runtime reader. No imports of full catalog/count JSON.
import {SnapshotFault} from './fault.mjs';
import {validateSnapshot,snapshotDigest} from './release-pointer.mjs';
const slugOK=x=>typeof x==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x);
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
const frozen=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(frozen);Object.freeze(x)}return x};
const fail=m=>{throw new SnapshotFault(503,m)};
export async function openSevenFacetCollectionContext(bucket,{snapshot:provided,allowUnpublishableFixture=false}={}){
 let captured;
 if(provided)captured=structuredClone(provided);
 else{const pointerObject=await bucket.get('catalog/active.json');if(!pointerObject||pointerObject.size>65536)fail('Missing or oversized catalog pointer');try{captured=await pointerObject.json()}catch{fail('Invalid catalog pointer')}}
 let snapshot;try{snapshot=frozen(validateSnapshot(captured))}catch{fail('Invalid seven-facet snapshot')}
 if((snapshot.status==='PRIVATE_UNPUBLISHABLE'||snapshot.fixture===true)&&!allowUnpublishableFixture)fail('Fixture root is not publishable');
 const rootSHA256=await snapshotDigest(snapshot),reads=new Map();
 async function readScoped(descriptor,maxBytes=256*1024,facet='collections'){
  if(!descriptor||!/^[a-f0-9]{64}$/.test(descriptor.sha256??'')||!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>maxBytes||descriptor.key!==`catalog/objects/${facet}/${descriptor.sha256}.json`)fail('Invalid '+facet+' descriptor scope');
  if(reads.has(descriptor.key)&&reads.get(descriptor.key).bytes!==descriptor.bytes)fail('Conflicting snapshot byte length');
  if(!reads.has(descriptor.key))reads.set(descriptor.key,{bytes:descriptor.bytes,promise:(async()=>{const object=await bucket.get(descriptor.key);if(!object||object.size!==descriptor.bytes)fail('Missing snapshot object');const bytes=await object.arrayBuffer();if(bytes.byteLength!==descriptor.bytes||await hash(bytes)!==descriptor.sha256)fail('Snapshot bytes changed');try{return frozen(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))}catch{fail('Invalid snapshot JSON')}})()});
  return reads.get(descriptor.key).promise;
 }
 const read=(descriptor,maxBytes)=>readScoped(descriptor,maxBytes,'collections');
 const [collections,countsManifest]=await Promise.all([readScoped(snapshot.indexes.collections,65536,'collections'),readScoped(snapshot.indexes.counts,65536,'counts')]);
 if(collections.schema!==1||collections.type!=='collection-directory'||!['collection-context-v1','collection-references-v2'].includes(collections.viewProtocol)||countsManifest.schema!==1||countsManifest.type!=='catalog-count-directory'||collections.topicCount!==countsManifest.topicCount||collections.artworkCount!==countsManifest.artworkCount)fail('Inconsistent partitioned manifests');
 const global=await readScoped(countsManifest.global,65536,'counts');
 if(global.schema!==1||!/^[a-f0-9]{16}$/.test(global.version??'')||global.totals?.subjects!==collections.topicCount||global.totals?.artworks!==collections.artworkCount||!global.collections||Object.hasOwn(global,'topics'))fail('Invalid global-only counts');
 async function lookup(descriptor,kind,slug){
  if(!slugOK(slug))throw new SnapshotFault(404,'Unknown collection');
  const digest=await hash(new TextEncoder().encode(slug));let prefix='';
  for(let depth=0;depth<=64;depth++){
   const node=await readScoped(descriptor,65536,kind==='count'?'counts':'collections');
   if(node.schema!==1||node.kind!==kind||node.prefix!==prefix)fail('Invalid directory identity');
   if(node.type==='hashed-topic-leaf'){
    if(!Array.isArray(node.entries)||node.entries.length>4096||node.entries.some(e=>!slugOK(e.slug))||new Set(node.entries.map(e=>e.slug)).size!==node.entries.length)fail('Invalid directory leaf');
    const entry=node.entries.find(e=>e.slug===slug);if(entry&&!digest.startsWith(prefix))fail('Wrong directory leaf');return entry;
   }
   if(node.type!=='hashed-topic-branch'||!node.children||Array.isArray(node.children)||Object.keys(node.children).length>16||Object.keys(node.children).some(key=>!key.startsWith(prefix)||key.length!==prefix.length+1||!/^[a-f0-9]+$/.test(key)))fail('Invalid directory branch');
   prefix=digest.slice(0,prefix.length+1);descriptor=node.children[prefix];if(!descriptor)return undefined;
  }
  fail('Directory exceeds hash depth');
 }
 async function countsFor(slugs,{strict=false}={}){
  const keys=[...new Set(slugs)];if(keys.length>64||keys.some(k=>!slugOK(k)))throw new SnapshotFault(400,'Invalid visible topic keys');
  const rows=await Promise.all(keys.map(async slug=>{const row=await lookup(countsManifest.topics,'count',slug);if(row&&(!Number.isSafeInteger(row.count)||row.count<1))fail('Invalid topic count');if(strict&&!row)fail('Missing expected topic count');return[slug,row?.count??0]}));
  return{...global,topics:Object.fromEntries(rows)};
 }
 async function allLegacyCounts(){
  // Compatibility for existing clients while the actual catalog is small.
  // New page clients always request visible keys. Never materialize millions.
  if(collections.topicCount>4096)throw new SnapshotFault(503,'Legacy full counts requires a bounded client');
  const rows=[];
  async function visit(descriptor,prefix=''){
   const node=await readScoped(descriptor,65536,'counts');if(node.schema!==1||node.kind!=='count'||node.prefix!==prefix)fail('Invalid legacy count directory');
   if(node.type==='hashed-topic-leaf'){if(!Array.isArray(node.entries))fail('Invalid count leaf');rows.push(...node.entries);return}
   if(node.type!=='hashed-topic-branch'||!node.children||Object.keys(node.children).length>16)fail('Invalid count branch');
   await Promise.all(Object.entries(node.children).map(([key,d])=>visit(d,key)));
  }
  await visit(countsManifest.topics);if(rows.length!==collections.topicCount||new Set(rows.map(r=>r.slug)).size!==rows.length||rows.some(r=>!slugOK(r.slug)||!Number.isSafeInteger(r.count)||r.count<1))fail('Incomplete legacy count set');
  return{...global,topics:Object.fromEntries(rows.map(r=>[r.slug,r.count]))};
 }
 return{status:'COLLECTION_CONTEXT_ONLY_NOT_ACTIVATION_PROOF',publicationVerified:false,snapshot,revision:snapshot.revision,rootSHA256,root:{...snapshot.indexes,features:collections.sharedContext},read,global,collections,countsManifest,
  lookupCollection:slug=>lookup(collections.directory,'collection',slug),countsFor,allLegacyCounts,
  immutableObjectsRead:()=>reads.size,pointerReads:provided?0:1,totalR2Reads:()=>reads.size+(provided?0:1)};
}
