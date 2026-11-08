// Actual workerd lifecycle regression: a departed invocation cannot strand
// a later invocation waiting for the same immutable object or HTML render.
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {dirname} from 'node:path';
const bytes=Buffer.from('{"safe":"immutable"}'),key='catalog/objects/artworks/'+createHash('sha256').update(bytes).digest('hex')+'.json';
const before=process.env.UC_ISOLATION_BEFORE==='1';
const plugins=before?[{name:'verified-prior-cache-source',setup(b){b.onLoad({filter:/server\/catalog-snapshot\/(immutable-cache|render-single-flight)\.mjs$/},args=>({contents:execFileSync('git',['show','b2392e580cd20c62fc121e24e196cc4c0d58d678:'+args.path.slice(process.cwd().length+1)],{encoding:'utf8'}),loader:'js'}))}}]:[];
const code=await build({stdin:{resolveDir:process.cwd(),contents:`import{immutableMetadataCache}from'./server/catalog-snapshot/immutable-cache.mjs';import{renderSingleFlight}from'./server/catalog-snapshot/render-single-flight.mjs';const cache=immutableMetadataCache();export default{async fetch(request){const q=new URL(request.url).searchParams,kind=q.get('kind');const source={async get(){const r=await fetch('https://read.invalid/object');const body=await r.arrayBuffer();return{size:body.byteLength,arrayBuffer:async()=>body}}};const read=()=>kind==='metadata'?cache.get(source,${JSON.stringify(key)}).then(async r=>new Response(await r.arrayBuffer())):renderSingleFlight(caches.default,'same-route',async()=>{const r=await fetch('https://read.invalid/render');return new Response(await r.text(),{headers:{'content-type':'text/html'}})});if(q.has('depart')){read().catch(()=>{});return new Response('departed')}return read()}}`},plugins,bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
const require=createRequire(import.meta.resolve('wrangler')),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),rows=[];
for(const kind of ['metadata','render']){
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:'request-isolation',script:code.outputFiles[0].text,modules:true,compatibilityDate:'2026-10-23',outboundService:async()=>{await new Promise(r=>setTimeout(r,60));return new Response(bytes)}}]}));
 try{
  const early=await mf.dispatchFetch('https://site.invalid/?kind='+kind+'&depart=1');assert.equal(await early.text(),'departed');
  const started=Date.now();
  let timer;
  try {
   const outcome=await Promise.race([mf.dispatchFetch('https://site.invalid/?kind='+kind).then(async response=>({status:response.status,body:(await response.text()).slice(0,400)})),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native request did not settle within 3000ms')),3000)})]);
   rows.push({kind,...outcome,ms:Date.now()-started,passed:outcome.status===200});
  } catch(error) { rows.push({kind,status:null,error:String(error),ms:Date.now()-started,passed:false}) } finally {clearTimeout(timer)}
 }finally{await mf.dispose()}
}
const report={passed:rows.every(r=>r.passed),source:before?'b2392e580cd20c62fc121e24e196cc4c0d58d678':'current-working-source',cases:rows};
const output=process.env.EVIDENCE_FILE??'reports/url-migration/native-request-isolation-after.json';mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(!before)assert.equal(report.passed,true);
