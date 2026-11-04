import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypescript} from './helpers/typescript.mjs';
const {createCatalogHandler}=await loadTypescript('server/catalog-snapshot/handler.mjs');
const {catalogMetadataHeaders}=await loadTypescript('src/lib/catalog-protocol.ts');
test('metadata protocol is negotiated only on exact local manifest paths',()=>{
 for(const path of ['/search-data/manifest.json','/studio-manifest.json','/studio-featured.json','/studio-catalog.json']) assert.equal(catalogMetadataHeaders(path).get('x-uc-catalog-protocol'),'snapshot-search-v1');
 for(const path of ['https://assets.ultraclipart.com/a.webp','https://other.invalid/studio-manifest.json','//other.invalid/studio-manifest.json','/catalog-search.json']) assert.equal(catalogMetadataHeaders(path).get('x-uc-catalog-protocol'),null);
 assert.equal(catalogMetadataHeaders('/studio-manifest.json',{'X-Other':'retained'}).get('x-other'),'retained');
});
test('old open clients retain legacy manifests without reading a new snapshot',async()=>{
 let reads=0;const stub={render:()=>'',css:'',scripts:{}},handler=createCatalogHandler({bucket:{get(){}},capture:()=>{reads++;throw Error('No snapshot')},renderers:{art:stub,editor:stub,home:stub,collection:stub,shells:{},shellScripts:{}}});
 for(const path of ['/search-data/manifest.json','/studio-manifest.json','/studio-featured.json','/studio-catalog.json'])assert.equal(await handler(new Request('https://ultraclipart.com'+path)),null);
 assert.equal(reads,0);
 assert.equal((await handler(new Request('https://ultraclipart.com/studio-manifest.json',{headers:{'x-uc-catalog-protocol':'snapshot-search-v1'}}))).status,503);
 assert.equal(reads,1);
});
