// Controlled network-fault source-component tests. Fake media is explicit, never a live-R2 proof.
import {build} from 'esbuild';
import sharp from 'sharp';
import {createServer} from 'node:http';
import {chromium,webkit,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const out=resolve(process.env.EVIDENCE_DIR??'reports/original-image-loading');mkdirSync(out,{recursive:true});
const bytes=await sharp({create:{width:8,height:8,channels:4,background:'#1464d4'}}).webp().toBuffer();
const built=await build({stdin:{contents:`import{initOriginalImageLoading}from'./src/scripts/original-image-loading.ts';initOriginalImageLoading(document,{retryDelays:[20,40],stallMs:200});`,resolveDir:resolve('.'),loader:'ts'},bundle:true,format:'esm',write:false});
const html='<!doctype html><html><body><a class="art-picture" href="/art/fixture/"><img width="80" height="80" alt="Explicit fixture image" loading="lazy" fetchpriority="low" src="https://assets.ultraclipart.com/fixture/original.webp"></a><script type="module" src="/component.js"></script></body></html>';
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/component.js'?'text/javascript':'text/html');res.end(req.url==='/component.js'?built.outputFiles[0].text:html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const report={scope:'Source module with explicitly synthetic media and network fault injection; 20/40ms retry and200ms watchdog are test overrides, production is800/2400ms and45000ms',passed:false,cases:[],errors:[]};
try{for(const[engine,type]of Object.entries({chromium,webkit})){
 const browser=await type.launch(engine==='chromium'&&process.env.UC_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.UC_CHROMIUM_EXECUTABLE_PATH}:{});
 try{for(const scenario of ['healthy','transient','permanent','stall','dynamic','offline','non-r2','queued']){
  const context=await browser.newContext({viewport:{width:390,height:900}}),page=await context.newPage();let requests=0,offlineFault=false;page.on('pageerror',e=>report.errors.push({engine,scenario,message:e.message}));
  await context.route('https://assets.ultraclipart.com/**',async route=>{
   requests++;const n=requests;if(offlineFault){await route.abort('internetdisconnected');return}
   if(scenario==='permanent'||(scenario==='transient'&&n===1)||(scenario==='dynamic'&&n===2)){await route.fulfill({status:503,headers:{'Cache-Control':'no-store'},body:'Explicit fixture failure'});return}
   if(scenario==='stall'&&n===1)await new Promise(r=>setTimeout(r,800));
   if(scenario==='queued'&&n>1)await new Promise(r=>setTimeout(r,100));
   try{await route.fulfill({status:200,headers:{'Content-Type':'image/webp','Cache-Control':'no-store'},body:bytes})}catch(e){if(!(scenario==='stall'&&n===1))throw e}
  });
  await page.addInitScript(()=>{window.__imageTransitions=[];window.__maxImagePromotions=0;new MutationObserver(records=>{for(const r of records)if(r.target instanceof HTMLImageElement){window.__imageTransitions.push(r.target.getAttribute('data-original-image-state'));window.__maxImagePromotions=Math.max(window.__maxImagePromotions,document.querySelectorAll('img[data-original-image-state=loading]').length)}}).observe(document,{subtree:true,attributes:true,attributeFilter:['data-original-image-state']})});
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'domcontentloaded'});
  const image=page.locator('.art-picture img').first();
  await expect(page.locator('html')).toHaveAttribute('data-original-image-loading','ready');
  if(scenario==='permanent'){
   await expect(image).toHaveAttribute('data-original-image-state','error');await expect(page.locator('.original-image-status')).toHaveText('Image unavailable. Open artwork.');
   await page.waitForTimeout(150);assert.equal(requests,3);
  }else{
   await expect(image).toHaveAttribute('data-original-image-state','loaded');assert.equal(await image.getAttribute('src'),'https://assets.ultraclipart.com/fixture/original.webp');assert.equal(await image.getAttribute('alt'),'Explicit fixture image');
   if(scenario==='transient')assert.equal(requests,2);
   if(scenario==='stall'){assert.equal(requests,1,'A slow original transfer must not be restarted');assert((await page.evaluate(()=>window.__imageTransitions)).includes('slow'),'Watchdog reports a long transfer without discarding progress');}
   if(scenario==='healthy')assert.equal(requests,1);
   if(scenario==='dynamic'||scenario==='offline'){
    if(scenario==='offline'){offlineFault=true;await context.setOffline(true);}
    await page.locator('body').evaluate(body=>{const frame=document.createElement('a');frame.className='art-picture';frame.href='/art/second/';const img=document.createElement('img');img.src='https://assets.ultraclipart.com/fixture/dynamic.webp';img.alt='Explicit second fixture';img.width=img.height=80;frame.append(img);body.append(frame)});
    const second=page.locator('.art-picture img').nth(1);
    if(scenario==='offline'){await expect(second).toHaveAttribute('data-original-image-state','error');offlineFault=false;await context.setOffline(false)}
    await expect(second).toHaveAttribute('data-original-image-state','loaded');assert.equal(await second.getAttribute('src'),'https://assets.ultraclipart.com/fixture/dynamic.webp');
   }
   if(scenario==='queued'){
    await page.locator('body').evaluate(body=>{for(let i=0;i<10;i++){const img=document.createElement('img');img.src='https://assets.ultraclipart.com/fixture/queue-'+i+'.webp';img.width=img.height=50;img.alt='Explicit queued fixture';body.append(img)}});
    await expect(page.locator('img[data-original-image-state=loaded]')).toHaveCount(11);assert.equal(await page.evaluate(()=>window.__maxImagePromotions),4);
   }
   if(scenario==='non-r2'){
    await page.locator('body').evaluate((body,data)=>{const img=document.createElement('img');img.src=data;img.alt='Explicit data fixture';body.append(img)},'data:image/webp;base64,'+bytes.toString('base64'));
    const other=page.locator('body > img');await expect(other).not.toHaveAttribute('data-original-image-state',/.+/);assert((await other.getAttribute('src')).startsWith('data:image/webp;'));
   }
  }
  report.cases.push({engine,scenario,requests,maxPromoted:await page.evaluate(()=>window.__maxImagePromotions),transitions:await page.evaluate(()=>window.__imageTransitions),passed:true});await context.close();
 }}finally{await browser.close()}
}assert.deepEqual(report.errors,[]);report.passed=true;}finally{await new Promise(r=>server.close(r));writeFileSync(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,errors:report.errors}))}
