// Source-component regression with delayed fixture metadata, not a live catalog or pixel review.
import {build} from 'esbuild';
import {chromium,webkit,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('.'),out=resolve(process.env.EVIDENCE_DIR??'reports/studio-library-startup');mkdirSync(out,{recursive:true});
const asset=(id,title,topic,style,featured)=>({id,title,alt:title,topic,style,featured,width:32,height:32,thumb:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',webp:{url:'https://assets.ultraclipart.com/fixture/'+id+'.webp',bytes:1,sha256:'0'.repeat(64)},pdf:{url:'https://assets.ultraclipart.com/fixture/'+id+'.pdf',bytes:1,sha256:'0'.repeat(64)}});
const assets=[asset('fixture-robot','Robot','robot','Color',true),asset('fixture-sunflower','Sunflower','sunflower','Outline',false),asset('fixture-camera','Camera','camera','Color',false)];
const bundled=await build({stdin:{contents:`import {mountArtworkLibrary} from './src/editor/artwork-library.ts';window.__mount=mountArtworkLibrary(document.querySelector('main'),async()=>{}).catch(e=>{window.__startupError=e.message});`,resolveDir:root,loader:'ts'},bundle:true,format:'esm',platform:'browser',write:false,plugins:[{name:'fixture-only-delayed-library',setup(b){b.onLoad({filter:/src\/editor\/raster\.ts$/},()=>({contents:'export const featuredRasterCatalog=()=>window.__featured;export const rasterCatalog=async()=>window.__assets;',loader:'ts'}));b.onLoad({filter:/src\/editor\/studio-sources\.ts$/},()=>({contents:'export const lookupTopicAssets=async()=>window.__assets;export const pinRasterSnapshot=()=>{};export const unpinRasterSnapshot=()=>{};',loader:'ts'}))}}]});
const html=`<!doctype html><html><body><main><input data-artwork-search><select data-artwork-style><option value="">All styles</option><option>Outline</option><option>Color</option></select><select data-artwork-topic><option value="">All subjects</option><option value="sunflower">Sunflower</option></select><select data-artwork-sort><option value="featured">Featured</option><option value="title">Title</option></select><div data-artwork-grid></div><p data-artwork-count>Loading the artwork library…</p><button data-artwork-more>Next</button><button data-artwork-previous>Previous</button><span data-artwork-page></span><span data-featured-count></span><button data-artwork-scope="featured">Featured</button><button data-artwork-scope="all">All Artwork</button><button data-artwork-clear>Clear</button><button data-library-home>Categories</button><button data-library-parent>Parent</button><span data-library-current></span><input data-artwork-jump><script>window.__assets=${JSON.stringify(assets)};window.__featured=new Promise((resolve,reject)=>{window.__release=()=>resolve({items:window.__assets.slice(0,1),total:3,topics:['robot','sunflower','camera'],categories:[{id:'nature',title:'Nature',thumb:window.__assets[1].thumb,topics:[{id:'sunflower',title:'Sunflower',count:1,thumb:window.__assets[1].thumb}]}]});window.__reject=()=>reject(Error('Fixture load failed'));});</script><script type="module" src="/component.js"></script></main></body></html>`;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/component.js'?'text/javascript':'text/html');res.end(req.url==='/component.js'?bundled.outputFiles[0].text:html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const report={scope:'Actual mountArtworkLibrary source component with explicit synthetic deferred catalog; not production, full canvas, or artwork review',passed:false,cases:[],errors:[]};
try{for(const[engine,type]of Object.entries({chromium,webkit})){
 const browser=await type.launch(engine==='chromium'&&process.env.UC_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.UC_CHROMIUM_EXECUTABLE_PATH}:{});
 try{for(const scenario of ['query','style','topic','scope-all','latest-featured','clear','autofill','failed-load']){
  const page=await browser.newPage({viewport:{width:390,height:1000}});page.on('pageerror',e=>report.errors.push(e.message));await page.goto(base);await expect(page.locator('main')).toHaveAttribute('data-artwork-library-ready','loading');
  if(['query','latest-featured','clear'].includes(scenario))await page.locator('[data-artwork-search]').fill('sunflower');
  if(scenario==='style')await page.locator('[data-artwork-style]').selectOption('Outline');
  if(scenario==='topic')await page.locator('[data-artwork-topic]').selectOption('sunflower');
  if(scenario==='scope-all')await page.locator('[data-artwork-scope=all]').click();
  if(scenario==='latest-featured')await page.locator('[data-artwork-scope=featured]').click();
  if(scenario==='clear')await page.locator('[data-artwork-clear]').click();
  if(scenario==='autofill')await page.locator('[data-artwork-search]').evaluate(e=>e.value='sunflower');
  await page.evaluate(failed=>failed?window.__reject():window.__release(),scenario==='failed-load');
  if(scenario==='failed-load'){
   await expect(page.locator('main')).toHaveAttribute('data-artwork-library-ready','error');await expect(page.locator('[data-artwork-count]')).toContainText('Your canvas is preserved');await expect(page.locator('[data-artwork-grid]')).not.toHaveAttribute('aria-busy','true');
  }else{
   await expect(page.locator('main')).toHaveAttribute('data-artwork-library-ready','true');
   if(['query','style','topic','autofill'].includes(scenario))await expect(page.locator('[data-artwork="fixture-sunflower"]')).toHaveCount(1);
   if(scenario==='scope-all')await expect(page.locator('[data-artwork]')).toHaveCount(3);
   if(scenario==='latest-featured'){await expect(page.locator('[data-artwork]')).toHaveCount(0);await expect(page.locator('[data-artwork-count]')).toContainText('No matching artwork');await expect(page.locator('[data-artwork-scope=featured]')).toHaveAttribute('aria-pressed','true')}
   if(scenario==='clear'){await expect(page.locator('[data-artwork-search]')).toHaveValue('');await expect(page.locator('main')).toHaveAttribute('data-library-browse','categories');await expect(page.locator('.wb-category-tile')).toHaveCount(1)}
   // Following readiness, normal events still run exactly once.
   await page.locator('[data-artwork-clear]').click();await page.locator('[data-artwork-search]').fill('camera');await expect(page.locator('[data-artwork="fixture-camera"]')).toHaveCount(1);
  }
  report.cases.push({engine,scenario,passed:true});await page.close();
 }}finally{await browser.close()}
}assert.deepEqual(report.errors,[]);report.passed=true;}finally{await new Promise(r=>server.close(r));writeFileSync(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,errors:report.errors}))}
