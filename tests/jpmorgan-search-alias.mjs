// In-memory synthetic search metadata only; no source artwork approval or network.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {searchRecord} from '../scripts/catalog-snapshot/search-record.mjs';
import {normalizeQuery} from '../src/lib/search-language.ts';
import {defaults} from '../src/lib/search.ts';
import {makeStore,canonical} from '../server/catalog-search/store.mjs';
import {bootstrapSearch} from '../server/catalog-search/index.mjs';
import {openSearch} from '../server/catalog-search/runtime.mjs';
import {assertCompleteTopicSearchDelta} from '../scripts/catalog-snapshot/topic-search-preflight.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/catalog-delta-source.json',import.meta.url))).record;
const topic={slug:'jpmorgan-chase',keyword:'JPMorgan Chase clipart',primaryCluster:'Business & money',clusters:[{name:'Business & money',path:'/collection/business-money/'}]};
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
test('legacy parent projection retains its independently captured canonical SHA',()=>{
 const old={...topic,keyword:'JPMorganChase clipart'};
 assert.equal(hash(searchRecord(fixture,old)), 'dca0a7c448c1c52ab143505133d13bb283689b3f43dc8e52a0414aba0591b5ff');
 assert.deepEqual(searchRecord(fixture,old).keywords,['JPMorganChase clipart']);
 assert.equal(searchRecord(null,topic),null);
});
test('alias is exact-topic/exact-new-keyword only and mutates no source or topic copy',()=>{
 const a=structuredClone(fixture),t=structuredClone(topic),beforeA=structuredClone(a),beforeT=structuredClone(t),projected=searchRecord(a,t);
 assert.deepEqual(projected.keywords,['JPMorgan Chase clipart','JPMorganChase']);assert.deepEqual(a,beforeA);assert.deepEqual(t,beforeT);
 for(const k of ['title','alt','description','productIdentity','files','webp','pdf'])assert.deepEqual(projected[k],a[k]);
 for(const t of [{...topic,slug:'unrelated'},{...topic,keyword:'Different reviewed wording'},{...topic,keyword:'JPMorgan Chase Clipart'}])assert.deepEqual(searchRecord(a,t).keywords,[t.keyword]);
});
test('other seventeen brand keyword projections remain byte exact',()=>{
 const brands=['Johnson & Johnson','Amazon','Coca-Cola','AMD','ExxonMobil','Cisco','SpaceX','Oracle','AbbVie','Walmart','Alphabet and Google','Chevron','Palantir','Eli Lilly','Visa','Micron Technology','NVIDIA'];
 for(const brand of brands){const t={...topic,slug:brand.toLowerCase().replace(/[^a-z0-9]+/g,'-'),keyword:brand+' clipart'};assert.equal(JSON.stringify(searchRecord(fixture,t).keywords),JSON.stringify([t.keyword]));}
 for(const brand of ['SpaceX','ExxonMobil','AbbVie','ChatGPT','OpenAI']){const a={...fixture,title:brand+' scene',alt:brand+' illustration'};assert.equal(searchRecord(a,{...topic,slug:'other',keyword:brand+' clipart'}).title,a.title);}
});
test('both unchanged runtime query forms find exactly the same fifty IDs',async()=>{
 assert.deepEqual(normalizeQuery('JPMorgan Chase'),['jpmorgan','chase']);assert.deepEqual(normalizeQuery('JPMorganChase'),['jpmorganchase']);
 const base={published:true,indexable:true,sourceType:'vector',style:'Color',color:'Blue',formats:['WEBP'],thumb:'/fixture.webp',webp:'/fixture.webp',createdAt:'2026-01-01',monochrome:false};
 const sources=Array.from({length:50},(_,i)=>({...base,id:'jpmorgan-chase-fixture-'+String(i+1).padStart(3,'0'),topic:topic.slug,title:'JPMorgan Chase object '+i,alt:'An illustrated object beside a small box.',description:'A person holds the object beside a desk.'}));
 const originals=structuredClone(sources),records=sources.map(a=>searchRecord(a,topic));
 records.push({...base,id:'unrelated-spacex-fixture',topic:'spacex',title:'SpaceX capsule',alt:'An illustrated capsule.',description:'A capsule rests on a stand.',keywords:['SpaceX clipart']});
 const memory=new Map(),bucket={get:async key=>{const b=memory.get(key);return b?{size:b.length,arrayBuffer:async()=>b.slice().buffer}:null;},put:async(key,body)=>{memory.set(key,new Uint8Array(body));return{etag:'private-fixture'};}};
 const built=await bootstrapSearch(makeStore(bucket,{writable:true}),records,[{slug:topic.slug,keyword:topic.keyword},{slug:'spacex',keyword:'SpaceX clipart'}],{revision:'a'.repeat(40),publicSourceSha256:'b'.repeat(64)});
 const sets=[];for(const q of ['JPMorgan Chase','JPMorganChase']){const engine=await openSearch(bucket,built.descriptor,{allowPrivateFixture:true}),ids=[];for(let page=1;page<=7;page++){const result=await engine.search({...defaults,q,page,size:8});assert.equal(result.total,50);assert.equal(result.hasFuzzyMatches,false);ids.push(...result.items.map(a=>a.id));}assert.equal(new Set(ids).size,50);sets.push([...new Set(ids)].sort());}
 assert.deepEqual(sets[0],sets[1]);assert.deepEqual(sets[0],sources.map(a=>a.id).sort());assert.deepEqual(sources,originals);
 assert(sources.every(a=>!a.title.includes('JPMorganChase')&&!a.alt.includes('JPMorganChase')&&!a.description.includes('JPMorganChase')));
});
test('keyword/category identity still requires every member in the source delta',()=>{
 const old={...topic,keyword:'JPMorganChase clipart'},ids=Array.from({length:50},(_,i)=>'member-'+i),change={slug:topic.slug,record:topic,artworkIds:ids};
 assert.throws(()=>assertCompleteTopicSearchDelta(old,change,new Set(ids.slice(1))),/complete scoped member delta/);
 assert.doesNotThrow(()=>assertCompleteTopicSearchDelta(old,change,new Set(ids)));
 const categories={...topic,clusters:[]};assert.throws(()=>assertCompleteTopicSearchDelta(topic,{...change,record:categories},new Set(ids.slice(1))),/complete scoped member delta/);
});
