import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchRepository, SearchHttpError } from '../src/lib/search-remote.ts';
import { defaults } from '../src/lib/search.ts';
const A='a'.repeat(64),B='b'.repeat(64);
const manifest=snapshot=>({schema:1,version:snapshot,total:400,pageChunk:256,tokenBuckets:256,lexiconLengths:[],facets:[],topics:[],site:'site',ranking:2,transport:{protocol:'snapshot-search-v1',endpoint:'/catalog-search.json',snapshot}});
const card=id=>({id,title:id,alt:id,thumb:'https://assets.ultraclipart.com/a.webp',webp:'https://assets.ultraclipart.com/a.webp'});
const envelope=(snapshot,result)=>({schema:1,snapshot,result});
const results=(snapshot,state)=>({manifest:manifest(snapshot),items:[card('camera')],total:1,pages:1,page:1,hasFuzzyMatches:false});

test('snapshot search keeps exact caller page size/scope and uses uncached POST',async()=>{
 const posts=[];const repo=new SearchRepository(async(path,signal,init)=>{if(path.endsWith('/manifest.json'))return manifest(A);assert.equal(path,'/catalog-search.json');posts.push(init);const body=JSON.parse(init.body);return envelope(A,results(A,body.state))});
 for(const size of[4,6,24,32]){const value=await repo.search({...defaults,q:'camera',size},undefined,['print/monochrome','topic/camera']);assert.equal(value.total,1);const init=posts.at(-1),body=JSON.parse(init.body);assert.equal(init.method,'POST');assert.equal(init.cache,'no-store');assert.equal(body.snapshot,A);assert.equal(body.state.size,size);assert.deepEqual(body.scope,['print/monochrome','topic/camera'])}
});
test('a changed snapshot refreshes exactly once and never mixes the response generation',async()=>{
 let loads=0,posts=0;const repo=new SearchRepository(async(path,signal,init)=>{if(path.endsWith('/manifest.json'))return manifest(++loads===1?A:B);posts++;const body=JSON.parse(init.body);if(body.snapshot===A)throw new SearchHttpError(409);return envelope(B,results(B,body.state))});
 const value=await repo.search({...defaults,q:'camera'});assert.equal(value.manifest.version,B);assert.equal(loads,2);assert.equal(posts,2);
 const failing=new SearchRepository(async(path)=>{if(path.endsWith('/manifest.json'))return manifest(A);throw new SearchHttpError(409)});await assert.rejects(()=>failing.search(defaults),e=>e.status===409);
});
test('wrong response root and unrecognized transport fail instead of falling back to legacy shards',async()=>{
 const repo=new SearchRepository(async(path)=>path.endsWith('/manifest.json')?manifest(A):envelope(B,results(B,defaults)));
 await assert.rejects(()=>repo.search(defaults),/snapshot changed/);
 let posts=0;const bad=new SearchRepository(async()=>{posts++;return{...manifest(A),transport:{...manifest(A).transport,endpoint:'https://evil.invalid/catalog-search.json'}}});
 await assert.rejects(()=>bad.search(defaults),/refreshed/);assert.equal(posts,1);
});
test('favorite IDs use bounded private batches and preserve null/order across the entire result',async()=>{
 const ids=Array.from({length:310},(_,i)=>'saved-'+i),batches=[];const repo=new SearchRepository(async(path,signal,init)=>{if(path.endsWith('/manifest.json'))return manifest(A);const body=JSON.parse(init.body);assert.equal(body.operation,'items');assert(!path.includes('saved-'));batches.push(body.ids);return envelope(A,body.ids.map(id=>id==='saved-4'?null:card(id)))});
 const values=await repo.favoriteItems(ids);assert.deepEqual(batches.map(b=>b.length),[128,128,54]);assert.equal(values.length,310);assert.equal(values[4],null);assert.deepEqual(values.map((v,i)=>v?.id??ids[i]),ids);
});
test('a favorite generation race discards whole old batches and reloads IDs once',async()=>{
 let manifests=0;const snapshots=[];const repo=new SearchRepository(async(path,signal,init)=>{if(path.endsWith('/manifest.json'))return manifest(++manifests===1?A:B);const body=JSON.parse(init.body);snapshots.push(body.snapshot);if(body.snapshot===A)throw new SearchHttpError(409);return envelope(B,body.ids.map(card))});
 assert.deepEqual((await repo.favoriteItems(['camera','sunflower'])).map(v=>v.id),['camera','sunflower']);assert.deepEqual(snapshots,[A,B]);assert.equal(manifests,2);
});
test('late or cancelled RPC responses cannot cross clear/generation boundaries',async()=>{
 let finish;const repo=new SearchRepository(async(path)=>path.endsWith('/manifest.json')?manifest(A):new Promise(resolve=>{finish=()=>resolve(envelope(A,results(A,defaults)))}));
 const pending=repo.search(defaults);while(!finish)await new Promise(resolve=>setTimeout(resolve,0));repo.clear();finish();await assert.rejects(()=>pending,e=>e.name==='AbortError');
 const aborted=new AbortController();aborted.abort();await assert.rejects(()=>repo.search(defaults,aborted.signal),e=>e.name==='AbortError');
});
test('site entries stay pinned to the caller manifest rather than switching snapshots silently',async()=>{
 let manifestReads=0;const repo=new SearchRepository(async(path)=>{if(path.endsWith('/manifest.json')){manifestReads++;return manifest(A)}throw new SearchHttpError(409)});const current=await repo.manifest();await assert.rejects(()=>repo.siteEntries(current),e=>e.status===409);assert.equal(manifestReads,1);
});
test('bad item order and backend failure are not relabeled as removed favorites',async()=>{
 const wrong=new SearchRepository(async(path)=>path.endsWith('/manifest.json')?manifest(A):envelope(A,[card('wrong-id')]));await assert.rejects(()=>wrong.favoriteItems(['camera']),/invalid/);
 const unavailable=new SearchRepository(async(path)=>{if(path.endsWith('/manifest.json'))return manifest(A);throw new SearchHttpError(503)});await assert.rejects(()=>unavailable.favoriteItems(['camera']),e=>e.status===503);
});
