// Real public pages and source-bound R2 media. No interception, alternate image sources or test uploads.
import {chromium,webkit,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const base=process.env.BASE_URL??'https://ultraclipart.com',topics=(process.env.UC_IMAGE_TOPICS??'netherlands-flag,qatar-flag,sunflower').split(','),out=resolve(process.env.EVIDENCE_DIR??'reports/topic-image-scroll');
mkdirSync(out,{recursive:true});
const report={base,scope:'Actual public gallery image decoding during scroll on Chromium/WebKit; not a physical iPhone or emulated LTE test',startedAt:new Date().toISOString(),passed:false,cases:[],errors:[],mediaHttpErrors:[],mediaRequestFailures:[]};
try{for(const[engine,type]of Object.entries({chromium,webkit}).filter(([engine])=>!(process.env.UC_IMAGE_ENGINES)||process.env.UC_IMAGE_ENGINES.split(',').includes(engine))){
 const browser=await type.launch(engine==='chromium'&&process.env.UC_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.UC_CHROMIUM_EXECUTABLE_PATH}:{});
 try{for(const width of(process.env.UC_IMAGE_WIDTHS??'390,1440').split(',').map(Number)){
  const context=await browser.newContext({viewport:{width,height:950},hasTouch:width===390,isMobile:width===390}),page=await context.newPage();
  page.on('pageerror',e=>report.errors.push({engine,width,message:e.message}));
  page.on('requestfailed',r=>{if(new URL(r.url()).hostname==='assets.ultraclipart.com')report.mediaRequestFailures.push({url:r.url(),failure:r.failure(),engine,width})});
  page.on('response',r=>{if(new URL(r.url()).hostname==='assets.ultraclipart.com'&&r.status()>=400)report.mediaHttpErrors.push({url:r.url(),status:r.status(),engine,width})});
  for(const topic of topics){
   const stats=page.waitForResponse(r=>new URL(r.url()).pathname==='/catalog-stats.json'),discovery=page.waitForResponse(r=>new URL(r.url()).pathname==='/surprise-picks.json');
   const response=await page.goto(base+'/clipart/'+topic+'/',{waitUntil:'domcontentloaded',timeout:60000});assert.equal(response.status(),200);
   for(const pending of[stats,discovery]){const resolved=await pending;assert.equal(resolved.status(),200);await resolved.json()}
   const cookie=page.locator('[data-cookie-choice=necessary]:visible');if(await cookie.count())await cookie.click();
   const images=page.locator('main > .gallery').first().locator('article[data-id] .art-picture img'),total=await images.count();assert(total>0);
   const positions=[...new Set([0,1,Math.floor(total/2),Math.max(0,total-2),total-1])];
   if(topic==='netherlands-flag')for(const i of[74,75,76,77])if(i<total&&!positions.includes(i))positions.push(i);
   const checks=[];
   for(const index of positions){
    const image=images.nth(index),source=await image.getAttribute('src');assert(source?.startsWith('https://assets.ultraclipart.com/'));
    report.currentStep={engine,width,topic,index,source};writeFileSync(out+'/report.json',JSON.stringify(report,null,2));
    await image.evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));
    await expect.poll(()=>image.evaluate(e=>{const r=e.getBoundingClientRect();return r.top<innerHeight&&r.bottom>0}),{timeout:10000}).toBe(true);
    try { await expect.poll(()=>image.evaluate(e=>({complete:e.complete,width:e.naturalWidth})),{timeout:45000,intervals:[100,300,1000]}).toMatchObject({complete:true}); } catch(error) {report.failedImage=await image.evaluate(e=>({src:e.src,currentSrc:e.currentSrc,loading:e.loading,fetchPriority:e.fetchPriority,complete:e.complete,naturalWidth:e.naturalWidth,box:e.getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight],scrollY}));await page.screenshot({path:out+'/failed-'+engine+'-'+width+'.png'});throw error;}
    await expect.poll(()=>image.evaluate(e=>e.naturalWidth),{timeout:45000,intervals:[100,300,1000]}).toBeGreaterThan(0);
    const decoded=await image.evaluate(async e=>{await e.decode();return{width:e.naturalWidth,height:e.naturalHeight,currentSrc:e.currentSrc,src:e.getAttribute('src'),alt:e.alt}});
    assert.equal(decoded.src,source);assert.equal(decoded.currentSrc,(await image.getAttribute('srcset'))||source);assert(decoded.alt.trim());checks.push({index,source,...decoded,passed:true});
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   report.cases.push({engine,width,topic,galleryImages:total,checks,passed:true});
   if(topic==='netherlands-flag')await page.screenshot({path:out+'/'+engine+'-netherlands-'+width+'.png'});
   writeFileSync(out+'/report.json',JSON.stringify(report,null,2));
  }
  await context.close();
 }}finally{await browser.close()}
}assert.deepEqual(report.errors,[]);report.passed=true;}catch(e){report.failure=e.stack;throw e}finally{report.finishedAt=new Date().toISOString();writeFileSync(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,decodedImages:report.cases.reduce((n,x)=>n+x.checks.length,0),pageErrors:report.errors,mediaHttpErrors:report.mediaHttpErrors,failure:report.failure}))}
