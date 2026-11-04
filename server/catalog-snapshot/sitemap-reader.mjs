// Private snapshot-scoped sitemap delivery. Writer/source approval is separate.
import {lookupHashedRecord} from './hashed-record-directory.mjs';
import {mapGet} from '../catalog-search/store.mjs';
const XML='<?xml version="1.0" encoding="UTF-8"?>',NS='http://www.sitemaps.org/schemas/sitemap/0.9',MAX=24*1024**2;
const size=s=>new TextEncoder().encode(s).length;
const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
export async function readSitemap(context,pathname){
 const kind=pathname==='/sitemap.xml'?null:/^\/sitemap-(pages|images)(-\d+)?\.xml$/.exec(pathname)?.slice(1).join('');if(kind===undefined)return undefined;
 const root=await context.getFacet('sitemaps');if(root.schema!==1||root.type!=='sitemap-directory')throw Error('Invalid sitemap root');
 if(kind===null){const index=await context.read('sitemaps',root.index,{maxBytes:8*1024*1024});if(index.schema!==1||index.type!=='sitemap-index'||!Array.isArray(index.kinds)||index.kinds.length>50000||new Set(index.kinds).size!==index.kinds.length||index.kinds.some(x=>!/^(?:pages|images)(?:-\d+)?$/.test(x)))throw Error('Invalid sitemap index');return`${XML}<sitemapindex xmlns="${NS}">${index.kinds.map(k=>`<sitemap><loc>https://ultraclipart.com/sitemap-${k}.xml</loc></sitemap>`).join('')}</sitemapindex>`}
 const ledger=root.protocol==='ledger-slots-v2',descriptor=ledger?await mapGet({get:d=>context.read('sitemaps',d,{maxBytes:65536})},root.documents,'sitemap-documents',kind):await lookupHashedRecord(context,'sitemaps',root.documents,kind);if(!descriptor)return undefined;
 const document=await context.read('sitemaps',descriptor,{maxBytes:65536});if(ledger&&document.urls===0)return undefined;if(document.schema!==1||document.type!=='sitemap-document'||document.kind!==kind||(ledger&&document.protocol!=='slot-parts-v2')||!Number.isSafeInteger(document.urls)||document.urls<1||document.urls>50000||!Number.isSafeInteger(document.xmlBytes)||document.xmlBytes>MAX||!Array.isArray(document.parts)||document.parts.length>256)throw Error('Invalid sitemap document');
 const parts=Array(document.parts.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(8,parts.length)},async()=>{
  while(cursor<parts.length){
   const index=cursor++,d=document.parts[index],part=await context.read('sitemaps',d,{maxBytes:512*1024});
   if(part.schema!==1||part.type!=='sitemap-entries'||part.kind!==kind||part.part!==index||!Array.isArray(part.entries)||part.entries.length<1||part.entries.length>500||part.entries.some(x=>ledger&&x===null?false:typeof x!=='string'||!x.startsWith('<url><loc>https://ultraclipart.com/')||!x.endsWith('</url>')))throw Error('Invalid sitemap part');
   const active=part.entries.filter(x=>x!==null);if(ledger&&(part.protocol!=='slot-parts-v2'||d.slots!==part.entries.length||d.count!==active.length||d.xmlBytes!==active.reduce((n,x)=>n+size(x),0)))throw Error('Sitemap part summary mismatch');
   parts[index]=active;
  }
 }));
 if(parts.reduce((n,p)=>n+p.length,0)!==document.urls)throw Error('Sitemap count mismatch');
 const xml=`${XML}<urlset xmlns="${NS}"${kind.startsWith('images')?' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"':''}>${parts.flat().join('')}</urlset>`;
 if(size(xml)!==document.xmlBytes||size(xml)>MAX||(!ledger&&await hash(xml)!==document.xmlSHA256))throw Error('Sitemap representation changed');return xml;
}
