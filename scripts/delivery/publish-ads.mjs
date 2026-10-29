// Owner-authorized one-path publication. Does not rebuild or replace Pages/R2.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {configuredToken} from '../r2/cloudflare-api.mjs';
import {acquireAccountWriter} from './account-lock.mjs';
const root=path.resolve(import.meta.dirname,'../..'),dir=path.join(root,'work/ads-txt-20261029');
const account='48c779c8eaa80234e0bb9d57f96e588b',name='ultraclipart-adstxt-20261029',pattern='ultraclipart.com/ads.txt',site='https://ultraclipart.com';
const body=fs.readFileSync(path.join(root,'public/ads.txt'),'utf8');
assert.equal(body,'google.com, pub-2597035827677267, DIRECT, f08c47fec0942fa0\n');
const baseline=JSON.parse(fs.readFileSync(path.join(dir,'baseline.json'))),token=configuredToken();
const save=(file,value)=>fs.writeFileSync(path.join(dir,file),JSON.stringify(value,null,2)+'\n');
async function api(p,options={}) {
 const r=await fetch('https://api.cloudflare.com/client/v4'+p,{...options,headers:{Authorization:'Bearer '+token,...options.headers},redirect:'error',signal:AbortSignal.timeout(30000)}),j=await r.json();
 if(!r.ok||!j.success)throw Error('Scoped ads.txt request failed HTTP '+r.status+' '+JSON.stringify(j.errors?.map(e=>({code:e.code,message:e.message}))));
 return j.result;
}
const source=`const body=${JSON.stringify(body)};export default{fetch(request){const url=new URL(request.url);if(url.hostname!=='ultraclipart.com'||url.pathname!=='/ads.txt')return new Response('Not found\\n',{status:404});if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed\\n',{status:405,headers:{Allow:'GET, HEAD'}});return new Response(request.method==='HEAD'?null:body,{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff','Content-Length':String(new TextEncoder().encode(body).length)}})}};`;
const handler=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
assert.equal(await handler.fetch(new Request(site+'/ads.txt')).text(),body);assert.equal((await handler.fetch(new Request(site+'/ads.txt',{method:'HEAD'}))).body,null);assert.equal(handler.fetch(new Request(site+'/')).status,404);assert.equal(handler.fetch(new Request(site+'/ads.txt',{method:'POST'})).status,405);
const unlock=acquireAccountWriter();
try {
 const project=await api('/accounts/'+account+'/pages/projects/ultraclipart');assert.equal(project.canonical_deployment.id,baseline.project.deployment);
 const before=await fetch(site+'/delivery-release.json',{cache:'no-store',signal:AbortSignal.timeout(30000)});assert.deepEqual(await before.json(),baseline.delivery);
 const routes=await api('/zones/'+baseline.zone.id+'/workers/routes');assert(!routes.some(r=>r.pattern===pattern),'Existing exact route requires review');
 const scripts=await api('/accounts/'+account+'/workers/scripts');assert(!scripts.some(s=>s.id===name),'Existing Worker must not be overwritten');
 const data=new FormData();data.set('metadata',JSON.stringify({main_module:'ads.mjs',compatibility_date:'2026-10-29'}));data.set('ads.mjs',new File([source],'ads.mjs',{type:'application/javascript+module'}));
 const uploaded=await api('/accounts/'+account+'/workers/scripts/'+name,{method:'PUT',body:data});
 const route=await api('/zones/'+baseline.zone.id+'/workers/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pattern,script:name})});
 save('activation.json',{sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),worker:name,workerSha256:createHash('sha256').update(source).digest('hex'),workerDeployment:uploaded.deployment_id??uploaded.version?.id??null,route,baselineDelivery:baseline.delivery,activatedAt:new Date().toISOString()});
 let response,text;
 for(let n=0;n<12;n++){response=await fetch(site+'/ads.txt',{redirect:'error',cache:'no-store',headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});text=await response.text();if(response.status===200&&text===body)break;await new Promise(r=>setTimeout(r,2000));}
 assert.equal(response.status,200);assert.equal(text,body);assert.match(response.headers.get('content-type')??'',/^text\/plain/);
 const head=await fetch(site+'/ads.txt',{method:'HEAD',redirect:'error',headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const after=await fetch(site+'/delivery-release.json',{cache:'no-store',signal:AbortSignal.timeout(30000)});assert.deepEqual(await after.json(),baseline.delivery);
 const home=await fetch(site+'/',{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});assert.equal(home.status,200);assert((await home.text()).includes('name="build-revision" content="'+baseline.delivery.renderedRevision+'"'));
 const afterProject=await api('/accounts/'+account+'/pages/projects/ultraclipart');assert.equal(afterProject.canonical_deployment.id,baseline.project.deployment);
 const report={status:'ADS_TXT_LIVE_VERIFIED',url:site+'/ads.txt',body:text,httpStatus:response.status,headStatus:head.status,contentType:response.headers.get('content-type'),worker:name,routeId:route.id,sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),pagesDeploymentUnchanged:baseline.project.deployment,deliveryRootUnchanged:baseline.delivery.verifiedRoot,homepageStatus:home.status,githubUsed:false,verifiedAt:new Date().toISOString()};save('production-report.json',report);console.log(report);
}finally{unlock();}
