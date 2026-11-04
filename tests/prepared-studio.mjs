import test from 'node:test';import assert from 'node:assert/strict';import{gzipSync}from'node:zlib';import{randomBytes,createHash}from'node:crypto';
import{prepareStudioInfoRecord,readPreparedStudioInfo}from'../server/catalog-snapshot/prepared-studio.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),abi='a'.repeat(64),root='b'.repeat(64),results=[];
for(const large of [false,true])test('canonical Studio '+(large?'chunked':'inline')+' keeps exact data and rejects stale source, bad hashes and excessive expansion',async()=>{
 const objects=new Map(),collections={schema:1,test:'canonical'},snapshot={indexes:Object.fromEntries(['artworks','search','recent','related','counts','sitemaps'].map((x,i)=>[x,{sha256:String(i).repeat(64)}]))};
 const put=async v=>{const b=JSON.stringify(v),sha256=hash(b),key=sha256;objects.set(key,b);return{key,sha256,bytes:Buffer.byteLength(b)}};
 let reads=[];const context={rootSHA256:root,snapshot,getFacet:async()=>collections,read:async(_f,d)=>{reads.push(d.key);const b=objects.get(d.key);assert.equal(hash(b),d.sha256);return JSON.parse(b)}};
 const info={items:Array.from({length:500},(_,i)=>({id:'item-'+i,description:large?randomBytes(700).toString('hex'):'Test '+i})),total:39008,topics:[],transport:{snapshot:root,protocol:'snapshot-search-v1',endpoint:'/catalog-search.json'}};
 const result=await prepareStudioInfoRecord({context,info,rendererSHA256:abi,compress:b=>gzipSync(b),put});collections.preparedStudio=result.descriptor;
 const text=await readPreparedStudioInfo(context,abi);assert.equal(text,JSON.stringify(info));
 const index=JSON.parse(objects.get(result.descriptor.key)),page=JSON.parse(objects.get(index.page.key));assert.equal(Boolean(page.chunks),large);
 reads=[];assert.equal(await readPreparedStudioInfo(context,'c'.repeat(64)),null);assert.equal(reads.length,1);
 for(const facet of Object.keys(snapshot.indexes)){const old=snapshot.indexes[facet].sha256;snapshot.indexes[facet].sha256='d'.repeat(64);reads=[];assert.equal(await readPreparedStudioInfo(context,abi),null);assert.equal(reads.length,1);snapshot.indexes[facet].sha256=old;}
 collections.test='changed';assert.equal(await readPreparedStudioInfo(context,abi),null);collections.test='canonical';
 const newRoot='e'.repeat(64);assert.equal(JSON.parse(await readPreparedStudioInfo({...context,rootSHA256:newRoot},abi)).transport.snapshot,newRoot);
 const corrupt=structuredClone(page);corrupt.decodedSHA256='f'.repeat(64);const badPage=await put(corrupt),badIndex=await put({...index,page:badPage});collections.preparedStudio=badIndex;await assert.rejects(readPreparedStudioInfo(context,abi),/digest differs/);collections.preparedStudio=result.descriptor;
 if(!large){const bomb=await put({...page,body:gzipSync(Buffer.alloc(1024*1024,65)).toString('base64'),compressedBytes:gzipSync(Buffer.alloc(1024*1024,65)).length,decodedBytes:100});collections.preparedStudio=await put({...index,page:bomb});await assert.rejects(readPreparedStudioInfo(context,abi),/expansion/);}
 results.push({encoding:large?'chunked':'inline',entries:500,exactSourceJSON:true,softwareAndSixFacetFallback:true,collectionFallback:true,rootHydration:true,corruptDigestRejected:true,compressedBytes:page.compressedBytes});
});
