import test from 'node:test';import assert from 'node:assert/strict';
import {snapshotHTMLResponse} from '../../server/catalog-snapshot/snapshot-html-cache.mjs';
const rendererSHA256='a'.repeat(64),one={rootSHA256:'b'.repeat(64),snapshot:{revision:'1'.repeat(40)}},two={rootSHA256:'c'.repeat(64),snapshot:{revision:'2'.repeat(40)}},url='https://ultraclipart.com/art/example/';
function memory(){const values=new Map();return{values,match:async key=>values.get(key.url)?.clone(),put:async(key,response)=>values.set(key.url,response.clone())}}
const html=text=>new Response(`<html><title>${text}</title><h1>${text}</h1></html>`,{headers:{'content-type':'text/html; charset=utf-8'}});
test('new requests use current root while captured in-flight root remains stable',async()=>{
 const cache=memory();let renders=0;const render=()=>{renders++;return html('complete server HTML')};
 const first=await snapshotHTMLResponse({request:new Request(url),context:one,rendererSHA256,cache,render});assert.match(await first.text(),/<h1>complete server HTML/);const oldTag=first.headers.get('etag');
 const cached=await snapshotHTMLResponse({request:new Request(url),context:one,rendererSHA256,cache,render});assert.equal(cached.headers.get('etag'),oldTag);assert.equal(renders,1);
 const changed=await snapshotHTMLResponse({request:new Request(url,{headers:{'if-none-match':oldTag}}),context:two,rendererSHA256,cache,render:()=>html('new content')});assert.equal(changed.status,200);assert.match(await changed.text(),/new content/);assert.equal(changed.headers.get('cache-control'),'no-cache');
 const same=await snapshotHTMLResponse({request:new Request(url,{headers:{'if-none-match':changed.headers.get('etag')}}),context:two,rendererSHA256,cache,render});assert.equal(same.status,304);assert.equal(await same.text(),'');assert.equal(cache.values.size,2);
});
test('HEAD keeps representation metadata and failed render never enters cache',async()=>{
 const cache=memory(),options={context:one,rendererSHA256,cache,render:()=>html('head')};
 const head=await snapshotHTMLResponse({...options,request:new Request(url,{method:'HEAD'})});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const get=await snapshotHTMLResponse({...options,request:new Request(url)});assert.match(await get.text(),/<title>head/);
 const empty=memory();const fail=await snapshotHTMLResponse({...options,cache:empty,request:new Request(url),render:()=>new Response('broken',{status:503})});assert.equal(fail.status,503);assert.equal(empty.values.size,0);assert.equal(fail.headers.get('etag'),null);
});
test('cache rejects foreign origin, unsafe route and changed metadata binding',async()=>{
 const cache=memory(),options={context:one,rendererSHA256,cache,render:()=>html('safe')};
 await assert.rejects(snapshotHTMLResponse({...options,request:new Request('https://attacker.test/art/example/')}));await assert.rejects(snapshotHTMLResponse({...options,request:new Request('https://ultraclipart.com/admin/')}));
 await snapshotHTMLResponse({...options,request:new Request(url)});const [key,response]=[...cache.values][0];const headers=new Headers(response.headers);headers.set('x-uc-revision',two.snapshot.revision);cache.values.set(key,new Response('modified',{headers}));await assert.rejects(snapshotHTMLResponse({...options,request:new Request(url)}));
});
test('catalog shells share one root-bound cache representation across tracking queries',async()=>{const cache=memory();let renders=0;for(const path of['/','/new/','/search/','/black-and-white/','/categories/','/collections/','/library-index/','/create/','/favorites/','/collection/flags-countries/']){const options={context:one,rendererSHA256,cache,render:()=>{renders++;return html(path)}};await snapshotHTMLResponse({...options,request:new Request('https://ultraclipart.com'+path+'?utm_source=one')});await snapshotHTMLResponse({...options,request:new Request('https://ultraclipart.com'+path+'?q=second')})}assert.equal(renders,10);assert.equal(cache.values.size,10)});
test('real project preview origins render with the same root-bound representation',async()=>{const cache=memory();let renders=0;for(const origin of['https://ultraclipart.com','https://ultraclipart.pages.dev','https://31312903.ultraclipart.pages.dev','https://catalog-snapshot-ba3582a.ultraclipart.pages.dev']){const response=await snapshotHTMLResponse({context:one,rendererSHA256,cache,request:new Request(origin+'/clipart/qatar-flag/'),render:()=>{renders++;return html('Qatar Flag Clipart')}});assert.equal(response.status,200);assert.match(await response.text(),/Qatar Flag Clipart/)}assert.equal(renders,1);assert.equal(cache.values.size,1)});
test('preview allowance never admits another project, nested domain, port or plaintext',async()=>{for(const origin of['https://other.pages.dev','https://ultraclipart.pages.dev.attacker.test','https://nested.preview.ultraclipart.pages.dev','https://ultraclipart.com:444','http://ultraclipart.com','http://31312903.ultraclipart.pages.dev'])await assert.rejects(snapshotHTMLResponse({context:one,rendererSHA256,cache:memory(),request:new Request(origin+'/'),render:()=>html('forbidden')}),/Invalid cache route/)});
