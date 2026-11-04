// Private request-scoped reader. It verifies immutable bytes, not authority to publish.
import {validateSnapshot,snapshotDigest} from './release-pointer.mjs';
const names=new Set(['artworks','collections','search','recent','related','counts','sitemaps']);
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const value of Object.values(x))freeze(value);Object.freeze(x)}return x};
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
export async function openSnapshot(bucket,{provided,allowFixture=false,maxConcurrentReads=4,maxReadObjects=10000,maxReadBytes=256*1024*1024}={}){
 if(!Number.isInteger(maxConcurrentReads)||maxConcurrentReads<1||maxConcurrentReads>16||!Number.isSafeInteger(maxReadObjects)||maxReadObjects<1||!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw Error('Invalid snapshot read budget');
 let data;if(provided)data=structuredClone(provided);else{const pointer=await bucket.get('catalog/active.json');if(!pointer||pointer.size>65536)throw Error('Missing or oversized active pointer');data=await pointer.json()}
 const snapshot=freeze(validateSnapshot(data));
 if((snapshot.fixture===true||snapshot.status==='PRIVATE_UNPUBLISHABLE')&&!allowFixture)throw Error('Private fixture denied');
 const digest=await snapshotDigest(snapshot),cache=new Map(),waiting=[];let active=0,peak=0,requestedBytes=0;
 async function permit(){if(active<maxConcurrentReads){active++;peak=Math.max(peak,active);return}await new Promise(resolve=>waiting.push(resolve))}
 function release(){const next=waiting.shift();if(next)next();else active--}
 // Child descriptors are valid only when obtained from a previously verified
 // parent. This function alone does not prove graph closure or authorization.
 async function read(facet,d,{maxBytes=1024*1024}={}){
  if(!names.has(facet)||!d||!/^[a-f0-9]{64}$/.test(d.sha256??'')||d.key!==`catalog/objects/${facet}/${d.sha256}.json`||!Number.isSafeInteger(d.bytes)||d.bytes<1||d.bytes>maxBytes)throw Error('Invalid immutable descriptor');
  if(cache.has(d.key)&&cache.get(d.key).bytes!==d.bytes)throw Error('Conflicting object length');
  if(!cache.has(d.key)){
   if(cache.size>=maxReadObjects||requestedBytes+d.bytes>maxReadBytes)throw Error('Snapshot read budget exceeded');requestedBytes+=d.bytes;
   cache.set(d.key,{bytes:d.bytes,promise:(async()=>{await permit();try{const object=await bucket.get(d.key);if(!object||object.size!==d.bytes)throw Error('Missing immutable object');const bytes=await object.arrayBuffer();if(bytes.byteLength!==d.bytes||await hash(bytes)!==d.sha256)throw Error('Immutable bytes changed');return freeze(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))}finally{release()}})()});
  }
  return cache.get(d.key).promise;
 }
 return {snapshot,rootSHA256:digest,read,getFacet:name=>{if(!names.has(name))throw Error('Invalid facet');return read(name,snapshot.indexes[name])},objectsRead:()=>cache.size,readMetrics:()=>({objects:cache.size,bytes:requestedBytes,peakPending:peak}),publicationVerified:false};
}
