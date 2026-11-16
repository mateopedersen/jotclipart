import test from 'node:test';
import assert from 'node:assert/strict';
import {brand,freeCatalogTitle,pageDisplayTitle,publicBrandURL} from '../src/lib/brand.mjs';
import {presentationState} from '../server/catalog-snapshot/brand-presentation.mjs';

test('catalog display title is idempotent without changing source identity',()=>{
  const source={id:'versace-purple-barocco-jumpsuit',title:'Versace Purple Barocco Jumpsuit Clipart',description:'Visible original description.'};
  const before=JSON.stringify(source);
  assert.equal(freeCatalogTitle(source.title),'Free Versace Purple Barocco Jumpsuit Clipart');
  assert.equal(freeCatalogTitle(freeCatalogTitle(source.title)),freeCatalogTitle(source.title));
  assert.equal(freeCatalogTitle('Free Free Baby Elephant Clipart Clipart'),'Free Baby Elephant Clipart');
  assert.equal(freeCatalogTitle('Ford F-150 Clipart'),'Free Ford F-150 Clipart');
  assert.equal(JSON.stringify(source),before);
});
test('Free is limited to catalog page families',()=>{
  assert.equal(pageDisplayTitle('Privacy Policy','/privacy/'),'Privacy Policy');
  assert.equal(pageDisplayTitle('Contact JotClipart','/contact/'),'Contact JotClipart');
  assert.equal(pageDisplayTitle('Baby Elephant Clipart','/clipart/baby-elephant/'),'Free Baby Elephant Clipart');
});
test('public asset mapping preserves query, path and private/third-party identifiers',()=>{
  assert.equal(publicBrandURL('https://assets.ultraclipart.com/originals/A%20B.webp?v=2'),'https://assets.jotclipart.com/originals/A%20B.webp?v=2');
  assert.equal(publicBrandURL('https://ultraclipart.com/art/baby-elephant/'),'https://jotclipart.com/art/baby-elephant/');
  for(const value of ['originals/ultraclipart.webp','https://example.com/ultraclipart.com','https://ultraclipart.com.evil.test/a','https://assets.ultraclipart.com:444/a'])assert.equal(publicBrandURL(value),value);
});
const rgb=c=>c.slice(1).match(/../g).map(n=>parseInt(n,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
const luminance=c=>rgb(c).reduce((s,v,i)=>s+v*[0.2126,0.7152,0.0722][i],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+0.05)/(Math.min(luminance(a),luminance(b))+0.05);
test('approved text/action pairs satisfy measured WCAG normal-text contrast',()=>{
  assert.equal(brand.primary,'#52B788');
  assert(contrast(brand.ink,brand.primary)>=4.5);
  assert(contrast(brand.surface,brand.action)>=4.5);
  assert(contrast(brand.ink,brand.background)>=4.5);
  assert(contrast(brand.action,brand.surface)>=4.5);
});
test('signed source presentation maps public URLs without changing source fields or function-backed previews',async()=>{
  const item=Object.freeze({id:'same-id',title:'Reviewed source title',description:'Literal source description',sha256:'a'.repeat(64),url:'https://assets.ultraclipart.com/original/a.webp'});
  const state={item,art:[item],summaries:new Map([['topic','Original introduction']]),collectionPreview:async()=>[item]};
  const view=presentationState(state);
  assert.equal(view.item.url,'https://assets.jotclipart.com/original/a.webp');
  assert.equal((await view.collectionPreview())[0].url,view.item.url);
  assert.equal(view.item.id,item.id);assert.equal(view.item.sha256,item.sha256);
  assert.equal(view.item.description,item.description);assert.equal(view.item.title,item.title);
  assert.equal(item.url,'https://assets.ultraclipart.com/original/a.webp');
});
