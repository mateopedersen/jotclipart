// Per-installed-runtime bounded cache of authenticated, content-addressed bytes.
// Mutable publication control is NEVER cached. In-flight reads are coalesced.
const pattern=/^catalog\/objects\/(?:artworks|collections|search|recent|related|counts|sitemaps)\/([a-f0-9]{64})\.json$/;
export function immutableMetadataCache({maxBytes=16*1024*1024,maxObjects=1536,maxEntryBytes=262144}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024||!Number.isSafeInteger(maxObjects)||maxObjects<1||maxObjects>1536||!Number.isSafeInteger(maxEntryBytes)||maxEntryBytes<1||maxEntryBytes>262144)throw Error('Bounded immutable cache required');
 const entries=new Map(),inflight=new Map();let bytes=0,hits=0,misses=0;
 const object=r=>({size:r.body.byteLength,etag:r.etag,httpMetadata:r.httpMetadata,customMetadata:r.customMetadata,arrayBuffer:async()=>r.body.slice(0),json:async()=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(r.body))});
 return{async get(bucket,key){const match=pattern.exec(key);if(!match)return bucket.get(key);const old=entries.get(key);if(old){entries.delete(key);entries.set(key,old);hits++;return object(old)}if(inflight.has(key)){hits++;const shared=await inflight.get(key);return shared?object(shared):null}misses++;
  const pending=(async()=>{const r=await bucket.get(key);if(!r)return null;if(r.size>1048576)throw Error('Oversized immutable cache source');const body=await r.arrayBuffer();if(body.byteLength!==r.size)throw Error('Incomplete immutable cached bytes');const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',body))].map(x=>x.toString(16).padStart(2,'0')).join('');if(hash!==match[1])throw Error('Immutable cache hash mismatch');const row={body,etag:r.etag,httpMetadata:r.httpMetadata,customMetadata:r.customMetadata};if(body.byteLength<=maxEntryBytes&&body.byteLength<=maxBytes){while(entries.size>=maxObjects||bytes+body.byteLength>maxBytes){const[k,v]=entries.entries().next().value;entries.delete(k);bytes-=v.body.byteLength}entries.set(key,row);bytes+=body.byteLength}return row})();
  inflight.set(key,pending);try{const r=await pending;return r?object(r):null}finally{inflight.delete(key)}
 },metrics:()=>({objects:entries.size,bytes,hits,misses,pending:inflight.size,maxBytes,maxObjects})};
}
