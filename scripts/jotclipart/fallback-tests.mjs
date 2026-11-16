import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fallbackFetch,transferCSP} from '../../server/jotclipart/fallback.mjs';
import {staticNavigationPolicy} from '../../server/catalog-snapshot/static-navigation-policy.mjs';
import {siteNavigationScript} from '../../src/lib/site-navigation-inline.mjs';
const page=JSON.parse(readFileSync('config/jotclipart-http-policy.json')).page;
const token="'sha256-"+createHash('sha256').update(siteNavigationScript).digest('base64')+"'";
const env=(status=200,headers={},body='<!doctype html><h1>Saved work</h1>')=>({ASSETS:{fetch:async()=>new Response(body,{status,headers:{'content-type':'text/html;charset=utf-8',...headers}})}});
const req=(path,method='GET')=>new Request('https://jotclipart.com'+path,{method});
test('standalone transfer HTML is private, noindex, script-self and usable by navigation policy',async()=>{
 const response=await fallbackFetch(req('/move-your-work/'),env(200,{'cache-control':'public, max-age=86400'}),{},page);
 assert.equal(response.status,200);assert.equal(response.headers.get('content-security-policy'),transferCSP);
 assert.match(response.headers.get('cache-control'),/private, no-store/);assert.equal(response.headers.get('cdn-cache-control'),'no-store');assert.equal(response.headers.get('cloudflare-cdn-cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow, noarchive');
 const guarded=staticNavigationPolicy(response,token);assert.equal(guarded.status,200);assert(!/script-src[^;]*unsafe-inline/.test(guarded.headers.get('content-security-policy')));assert.match(guarded.headers.get('content-security-policy'),/connect-src 'none'/);assert.equal(await guarded.text(),'<!doctype html><h1>Saved work</h1>');
});
test('generic HTML404 receives the reviewed policy without changing status or body',async()=>{
 const response=await fallbackFetch(req('/genuinely-missing/'),env(404,{'cache-control':'public, max-age=0'}),{},page);
 assert.equal(response.status,404);assert.equal(response.headers.get('content-security-policy'),page['Content-Security-Policy']);assert.equal(response.headers.get('cache-control'),'public, max-age=0');assert.equal(response.headers.get('x-robots-tag'),'noindex');
 assert.equal(staticNavigationPolicy(response,token).status,404);assert.equal(await response.text(),'<!doctype html><h1>Saved work</h1>');
});
test('non-HTML JavaScript and image MIME/cache/ETag/bytes are retained',async()=>{
 for(const [type,path]of [['text/javascript','/move-your-work/transfer.js'],['image/png','/og/cover.png']]){
  const bytes=new Uint8Array([0,1,2,255]),response=await fallbackFetch(req(path),env(200,{'content-type':type,'cache-control':'public,max-age=31536000,immutable',etag:'"source"'},bytes),{},page);
  assert.equal(response.headers.get('content-type'),type);assert.equal(response.headers.get('cache-control'),'public,max-age=31536000,immutable');assert.equal(response.headers.get('etag'),'"source"');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
 }
});
test('HTML authorization statuses are preserved, including HEAD body suppression',async()=>{
 for(const status of [401,403,404])for(const path of ['/move-your-work/','/other/']){
  const response=await fallbackFetch(req(path,'HEAD'),env(status,{'cache-control':'private,no-store','content-length':'99'}),{},page);
  assert.equal(response.status,status);assert.equal((await response.arrayBuffer()).byteLength,0);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('content-length'),'99');
 }
});
test('non-HTML HEAD suppresses an accidental asset body and retains metadata',async()=>{
 const response=await fallbackFetch(req('/move-your-work/transfer.js','HEAD'),env(200,{'content-type':'text/javascript','cache-control':'max-age=90'},'example'),{},page);
 assert.equal(response.headers.get('content-type'),'text/javascript');assert.equal(response.headers.get('cache-control'),'max-age=90');assert.equal((await response.arrayBuffer()).byteLength,0);
});
test('HTML fallback refuses missing or unsafe script policy rather than weakening CSP',async()=>{
 await assert.rejects(fallbackFetch(req('/other/'),env(),{},undefined),/Reviewed fallback page policy/);
 await assert.rejects(fallbackFetch(req('/other/'),env(),{},{'Content-Security-Policy':"script-src 'self' 'unsafe-inline'"}),/Reviewed fallback page policy/);
});
test('cookie-region edge semantics and unsupported methods remain unchanged',async()=>{
 const request=req('/api/cookie-region.json');Object.defineProperty(request,'cf',{value:{country:'US'}});const cookie=await fallbackFetch(request,{},null,page);assert.deepEqual(await cookie.json(),{showNotice:false});
 const post=await fallbackFetch(req('/move-your-work/','POST'),{},null,page);assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET, HEAD');
});
