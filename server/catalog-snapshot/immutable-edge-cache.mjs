// Only checksum-addressed catalog bytes. Never publication control or user input.
const pattern=/^catalog\/objects\/(?:artworks|collections|search|recent|related|counts|sitemaps)\/([a-f0-9]{64})\.json$/;
const hash=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(n=>n.toString(16).padStart(2,'0')).join('');
const encode=x=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(x))));
const decode=x=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Uint8Array.from(atob(x),c=>c.charCodeAt(0))));
const object=(body,metadata)=>({...metadata,size:body.byteLength,arrayBuffer:async()=>body.slice(0)});
export function immutableEdgeMetadata(cache){
 const stats={hits:0,misses:0,repairs:0,unavailable:0};
 const later=(promise,execution)=>{const task=promise.catch(()=>{stats.unavailable++});if(execution?.waitUntil)execution.waitUntil(task);return task};
 return{async get(bucket,key,execution){
  const match=pattern.exec(key);if(!cache||!match)return bucket.get(key);
  const request=new Request('https://snapshot-metadata-cache.invalid/v1/'+key);
  try{const saved=await cache.match(request);if(saved){const size=Number(saved.headers.get('content-length'));if(saved.status!==200||saved.headers.has('set-cookie')||!Number.isSafeInteger(size)||size<1||size>262144)throw Error('Invalid cached metadata envelope');const body=await saved.arrayBuffer();if(body.byteLength!==size||await hash(body)!==match[1])throw Error('Invalid cached metadata digest');const metadata=decode(saved.headers.get('x-uc-object-metadata')??'');stats.hits++;return object(body,metadata)}}catch{stats.repairs++;await later(cache.delete(request),execution)}
  stats.misses++;const source=await bucket.get(key);if(!source)return null;
  if(!Number.isSafeInteger(source.size)||source.size<1||source.size>1048576)throw Error('Oversized immutable edge source');
  const body=await source.arrayBuffer();if(body.byteLength!==source.size||await hash(body)!==match[1])throw Error('Immutable edge source hash mismatch');
  const metadata={etag:source.etag,httpMetadata:source.httpMetadata,customMetadata:source.customMetadata};
  if(body.byteLength<=262144){const saved=new Response(body.slice(0),{headers:{'content-type':'application/json','content-length':String(body.byteLength),'cache-control':'public, max-age=31536000, immutable','x-uc-object-metadata':encode(metadata)}});const pending=later(cache.put(request,saved),execution);if(!execution?.waitUntil)await pending}
  return object(body,metadata);
 },metrics:()=>({...stats})};
}
