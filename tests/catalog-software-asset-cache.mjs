import {test} from 'node:test';
import assert from 'node:assert/strict';
import {immutableSoftwareAssetResponse as normalize} from '../server/catalog-snapshot/software-assets.mjs';
const path='/__ssr-client/'+('a'.repeat(40))+'/shared-HASH.js',known=new Set([path]);
const request=(suffix='',method='GET')=>new Request('https://ultraclipart.com'+path+suffix,{method});
const response=(headers={})=>new Response('exact original JS bytes',{headers:{'content-type':'application/javascript','cache-control':'public, max-age=0, must-revalidate, no-transform, public, max-age=31536000, immutable','etag':'"original"',...headers}});
test('Conflicting Pages freshness directives become one immutable policy without changing bytes or validators',async()=>{
 const r=normalize(request(),response(),known);assert.equal(r.headers.get('cache-control'),'public, max-age=31536000, immutable');assert.equal(r.headers.get('etag'),'"original"');assert.equal(await r.text(),'exact original JS bytes');
});
test('304 and HEAD preserve representation metadata and never acquire a response body',()=>{
 const r=normalize(request('', 'HEAD'),response(),known);assert.equal(r.body,null);assert.equal(r.headers.get('etag'),'"original"');
 const notModified=new Response(null,{status:304,headers:{etag:'"original"'}});assert.equal(normalize(request(),notModified,known).headers.get('cache-control'),'public, max-age=31536000, immutable');
});
test('HTML, errors, personalized replies, unknown versions, queries and unsafe methods retain existing policy',()=>{
 for(const [req,r,urls] of [[request(),response({'content-type':'text/html'}),known],[request(),new Response('missing',{status:404}),known],[request(),response({'set-cookie':'private=1'}),known],[request(),response(),new Set()],[request('?q=x'),response(),known],[request('','POST'),response(),known]])assert.equal(normalize(req,r,urls),r);
});
