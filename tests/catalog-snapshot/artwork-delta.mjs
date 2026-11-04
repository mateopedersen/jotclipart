import test from 'node:test';import assert from 'node:assert/strict';
import {canonical,digest} from '../../server/catalog-search/store.mjs';
import {applyArtworkBatch} from '../../server/catalog-snapshot/artwork-delta.mjs';import {readArtwork} from '../../server/catalog-snapshot/artwork-facet-reader.mjs';
import {buildHashedRecordDirectory} from '../../server/catalog-snapshot/hashed-record-directory-build.mjs';import {lookupHashedRecord} from '../../server/catalog-snapshot/hashed-record-directory.mjs';
const bytes=x=>new TextEncoder().encode(JSON.stringify(canonical(x))),sha=x=>digest(bytes(x)),revision='a'.repeat(40),nextRevision='b'.repeat(40);
async function setup(rows){
 const objects=new Map(),put=async x=>{const b=bytes(x),sha256=await digest(b),d={key:`catalog/objects/artworks/${sha256}.json`,sha256,bytes:b.length};objects.set(d.key,b);return d},groups=new Map(),directories={};
 for(const row of rows){const p=(await digest(row.id)).slice(0,3);if(!groups.has(p))groups.set(p,[]);groups.get(p).push(row)}
 for(const [p,records] of groups){const prefix=p.slice(0,2);directories[prefix]??={type:'artwork-directory',prefix,shards:{}};directories[prefix].shards[p]=await put({schema:1,shard:p,records})}
 for(const p of Object.keys(directories))directories[p]=await put(directories[p]);
 const preview=buildHashedRecordDirectory('artworks',rows.filter(x=>x.sourceType==='raster').map(x=>({name:x.id,value:{schema:1,type:'editor-source',id:x.id,sourceSHA256:x.files.webp.sha256}})));for(const [k,b] of preview.created)objects.set(k,b);
 const root=await put({type:'artwork-root',revision,directories,editorPreviews:preview.root});let reads=0;
 const context=(d=root,r=revision)=>({snapshot:{revision:r},getFacet:async()=>read('artworks',d),read});async function read(f,d){reads++;assert.equal(f,'artworks');const b=objects.get(d.key);assert(b);assert.equal(b.length,d.bytes);assert.equal(await digest(b),d.sha256);return JSON.parse(new TextDecoder().decode(b))}
 return{objects,context,put,reads:()=>reads,install:result=>{for(const [k,b] of result.created)objects.set(k,b);return context(result.root,nextRevision)}};
}
const row=(id,extra={})=>({id,topic:'test-topic',published:true,indexable:true,title:`Title ${id}`,sourceType:'raster',files:{webp:{sha256:'1'.repeat(64)}},...extra});
test('changed artwork paths preserve old roots, source decisions, withdrawals and reinsertion',async()=>{
 const rows=Array.from({length:300},(_,i)=>row(`art-${i}`)),s=await setup(rows),replacement={...rows[3],title:'Corrected visible subject'},added=row('new-art'),result=await applyArtworkBatch(s.context(),[{id:rows[3].id,expectedPublicSHA256:await sha(rows[3]),record:replacement},{id:added.id,expectedPublicSHA256:null,record:added},{id:rows[5].id,expectedPublicSHA256:await sha(rows[5]),record:null}],{revision:nextRevision}),next=s.install(result);
 assert.equal((await readArtwork(next,rows[3].id)).title,replacement.title);assert.deepEqual(await readArtwork(next,added.id),added);assert.equal(await readArtwork(next,rows[5].id),undefined);assert.deepEqual(await readArtwork(s.context(),rows[3].id),rows[3]);assert.deepEqual(await readArtwork(s.context(),rows[5].id),rows[5]);assert(result.created.size<30);assert(s.reads()<80);
 const root=await next.getFacet('artworks');assert.equal((await lookupHashedRecord(next,'artworks',root.editorPreviews,added.id)).sourceSHA256,added.files.webp.sha256);assert.equal(await lookupHashedRecord(next,'artworks',root.editorPreviews,rows[5].id),undefined);
 const restored=await applyArtworkBatch(next,[{id:rows[5].id,expectedPublicSHA256:null,record:rows[5]}],{revision:nextRevision});assert.deepEqual(await readArtwork(s.install(restored),rows[5].id),rows[5]);
 await assert.rejects(applyArtworkBatch(next,[{id:rows[3].id,expectedPublicSHA256:await sha(rows[3]),record:replacement}],{revision:nextRevision}),/Stale/);
});
test('large hash leaves split and later updates keep bounded reads',async()=>{
 const colliders=[];for(let i=0;colliders.length<8;i++){const id=`collision-${i}`;if((await digest(id)).startsWith('abc'))colliders.push(row(id,{description:'x'.repeat(900)}))}const s=await setup(colliders.slice(0,4)),added=colliders.slice(4).map(record=>({id:record.id,record,expectedPublicSHA256:null})),result=await applyArtworkBatch(s.context(),added,{revision:nextRevision,leafBytes:2000}),next=s.install(result);
 for(const a of colliders)assert.deepEqual(await readArtwork(next,a.id),a);assert([...result.created.values()].every(b=>b.length<=65536));const edited={...colliders[0],title:'Second title'},again=await applyArtworkBatch(next,[{id:edited.id,record:edited,expectedPublicSHA256:await sha(colliders[0])}],{revision:nextRevision,leafBytes:2000});assert.deepEqual(await readArtwork(s.install(again),edited.id),edited);assert.deepEqual(await readArtwork(next,edited.id),colliders[0]);
});
test('replacement image invalidates old editor decision and stale or malformed inputs fail',async()=>{
 const a=row('example-art'),s=await setup([a]),replacement={...a,files:{webp:{sha256:'2'.repeat(64)}}};await assert.rejects(applyArtworkBatch(s.context(),[{id:a.id,record:replacement,expectedPublicSHA256:await sha(a),previewDecision:{schema:1,type:'editor-source',id:a.id,sourceSHA256:a.files.webp.sha256}}],{revision:nextRevision}),/editor decision/);
 const next=s.install(await applyArtworkBatch(s.context(),[{id:a.id,record:replacement,expectedPublicSHA256:await sha(a)}],{revision:nextRevision})),root=await next.getFacet('artworks');assert.deepEqual(await lookupHashedRecord(next,'artworks',root.editorPreviews,a.id),{schema:1,type:'editor-source',id:a.id,sourceSHA256:replacement.files.webp.sha256});
 await assert.rejects(applyArtworkBatch(next,[{id:'absent',record:null,expectedPublicSHA256:null}],{revision:nextRevision}));await assert.rejects(applyArtworkBatch(next,[{id:a.id,record:{...replacement,published:false},expectedPublicSHA256:await sha(replacement)}],{revision:nextRevision}));
 const bad=await s.put({schema:1,shard:(await digest(a.id)).slice(0,3),records:[row('wrong-hash')]}),prefix=(await digest(a.id)).slice(0,2),directory=await s.put({type:'artwork-directory',prefix,shards:{[(await digest(a.id)).slice(0,3)]:bad}}),badRoot=await s.put({...root,directories:{[prefix]:directory}});await assert.rejects(readArtwork(s.context(badRoot,nextRevision),a.id),/wrong leaf/);
});
