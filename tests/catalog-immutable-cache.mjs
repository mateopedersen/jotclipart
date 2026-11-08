import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{immutableMetadataCache}from'../server/catalog-snapshot/immutable-cache.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),key=b=>'catalog/objects/artworks/'+sha(b)+'.json',object=b=>({size:b.byteLength,etag:sha(b),arrayBuffer:async()=>Uint8Array.from(b).buffer});
test('completed immutable bytes are shared; pending reads stay independent and control stays fresh',async()=>{const cache=immutableMetadataCache(),b=Buffer.from('{"value":1}');let reads=0,pointers=0;const bucket={get:async k=>{if(k==='catalog/active.json'){pointers++;return object(Buffer.from(String(pointers)))}reads++;await new Promise(r=>setTimeout(r,5));return object(b)}};const[a,c]=await Promise.all([cache.get(bucket,key(b)),cache.get(bucket,key(b))]);assert.equal(reads,2);new Uint8Array(await a.arrayBuffer())[0]=0;assert.equal(Buffer.from(await c.arrayBuffer()).toString(),b.toString());assert.equal(await(await cache.get(bucket,key(b))).json().then(x=>x.value),1);await cache.get(bucket,'catalog/active.json');await cache.get(bucket,'catalog/active.json');assert.equal(pointers,2);assert.equal(cache.metrics().objects,1)});
test('corrupt or missing objects never poison a cache; errors do not strand pending readers',async()=>{const cache=immutableMetadataCache(),b=Buffer.from('valid'),bad={get:async()=>object(Buffer.from('other'))};await assert.rejects(cache.get(bad,key(b)),/hash mismatch/);assert.equal(cache.metrics().objects,0);assert.equal(cache.metrics().pending,0);const empty={get:async()=>null};assert.deepEqual(await Promise.all([cache.get(empty,key(b)),cache.get(empty,key(b))]),[null,null]);assert.equal(cache.metrics().objects,0);assert.equal(Buffer.from(await(await cache.get({get:async()=>object(b)},key(b))).arrayBuffer()).toString(),'valid')});
test('LRU eviction and entry byte caps bound retained bytes without changing results',async()=>{const cache=immutableMetadataCache({maxBytes:6,maxObjects:2,maxEntryBytes:4}),values=['one','two','three'].map(x=>Buffer.from(x)),bucket={get:async k=>object(values.find(b=>key(b)===k))};for(const b of values)assert.equal(Buffer.from(await(await cache.get(bucket,key(b))).arrayBuffer()).toString(),b.toString());assert.equal(cache.metrics().objects,2);assert.equal(cache.metrics().bytes,6);const d=Buffer.from('four');assert.equal(Buffer.from(await(await cache.get({get:async()=>object(d)},key(d))).arrayBuffer()).toString(),'four');assert.equal(cache.metrics().objects,1);assert.equal(cache.metrics().bytes,4);assert.throws(()=>immutableMetadataCache({maxBytes:17*1024*1024}));assert.throws(()=>immutableMetadataCache({maxObjects:99999}))});

test('an unfinished request cannot block another request for the same immutable key',async()=>{
 const cache=immutableMetadataCache(),b=Buffer.from('{"value":1}');let release;
 const gate=new Promise(r=>release=r);
 const first=cache.get({get:async()=>{await gate;return object(b)}},key(b));
 let secondCompleted=false;
 const second=cache.get({get:async()=>object(b)},key(b)).then(x=>{secondCompleted=true;return x});
 try {await new Promise(r=>setTimeout(r,20));assert.equal(secondCompleted,true)}finally{release();await first}
 assert.equal((await(await second).json()).value,1);
 assert.equal(cache.metrics().bytes,b.length);
 assert.equal(cache.metrics().objects,1);
 assert.equal(cache.metrics().pending,0);
});
