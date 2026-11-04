// Source-bound acceleration. Immutable source-derived HTML; no mutable pointer caching.
import {canonical,digest} from '../catalog-search/store.mjs';
import {lookupHashedRecord} from './hashed-record-directory.mjs';
const HEX=/^[a-f0-9]{64}$/;
const CORE=new Set(['/','/new/','/search/','/black-and-white/','/categories/','/collections/','/library-index/','/create/','/favorites/','/ai-clipart-generator/']);
export const preparedRoute=path=>typeof path==='string'&&(CORE.has(path)||/^\/(?:clipart|collection|art)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path));
const ROOT_PATHS=[['searchManifest','version'],['props','snapshotSearch','version'],['collectionFeed','version']];
function rootSlots(state,root){
 for(const path of ROOT_PATHS){let o=state;for(const k of path.slice(0,-1))o=o?.[k];if(o&&Object.hasOwn(o,path.at(-1)))o[path.at(-1)]=root;}
}
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export async function preparedSourceBinding(context){
 const collections=structuredClone(await context.getFacet('collections'));
 delete collections.preparedHTML;
 delete collections.preparedArtworkPaths;
 delete collections.preparedStudio;
 return{collectionsSHA256:await digest(JSON.stringify(canonical(collections))),
  facets:Object.fromEntries(Object.entries(context.snapshot.indexes).filter(([k])=>k!=='collections').map(([k,d])=>[k,d.sha256]))};
}
function base64(bytes){
 let text='';for(let n=0;n<bytes.length;n+=8192)text+=String.fromCharCode(...bytes.subarray(n,n+8192));return btoa(text);
}
export async function prepareHTMLRecord({context,path,state,rendererSHA256,render,compress,put}){
 if(!preparedRoute(path)||!HEX.test(rendererSHA256)||typeof render!=='function'||typeof compress!=='function'||typeof put!=='function')throw Error('Bounded canonical presentation required');
 const baseline=await render(state),placeholder=await digest('uc-prepared-root-slot-v1:'+rendererSHA256+':'+path);
 if(typeof baseline!=='string'||!baseline.startsWith('<!DOCTYPE html>')||baseline.includes(placeholder))throw Error('Invalid source HTML or root-slot collision');
 // The canonical detail renderer carries one guarded preview resolver closure.
 // Preserve that same read-only function while cloning all data/root slots;
 // arbitrary functions and hidden state are not admitted to the codec.
 const {collectionPreview,...data}=state;
 if(collectionPreview!==undefined&&(typeof collectionPreview!=='function'||!path.startsWith('/art/')))throw Error('Unexpected canonical presentation resolver');
 const isolated=structuredClone(data);
 if(collectionPreview!==undefined)isolated.collectionPreview=collectionPreview;
 rootSlots(isolated,placeholder);
 const html=await render(isolated);
 if(html.includes(context.rootSHA256)||html.split(placeholder).join(context.rootSHA256)!==baseline)throw Error('Canonical HTML/root-slot equivalence differs');
 const bytes=new TextEncoder().encode(html);
 if(bytes.length>8*1024*1024)throw Error('Prepared HTML expansion bound');
 const compressed=await compress(bytes);
 if(!(compressed instanceof Uint8Array)||!compressed.length||compressed.length>1048576)throw Error('Prepared HTML compressed bound');
 const parts=[];
 // Preflight all byte bounds before immutable staging. No media transformation.
 for(let offset=0;offset<compressed.length;offset+=98304){const b=compressed.subarray(offset,offset+98304);
  const record={schema:1,type:'prepared-html-chunk-v1',offset,body:base64(b)};
  parts.push({record,offset,count:b.length});
 }
 const chunks=[];
 // Small pages stay inline: one body object rather than another network round trip.
 const inline=compressed.length<=147456;
 if(!inline)for(const part of parts)chunks.push({offset:part.offset,count:part.count,...await put(part.record)});
 const record={schema:1,type:'prepared-html-page-v1',path,placeholder,
  decodedBytes:bytes.length,decodedSHA256:await digest(bytes),compressedBytes:compressed.length,
  ...(inline?{body:base64(compressed)}:{chunks})};
 const descriptor=await put(record);
 return{descriptor,receipt:{path,sourceHTMLSHA256:await digest(baseline),decodedBytes:bytes.length,
  compressedBytes:compressed.length,sourceRoot:context.rootSHA256,rootSlots:html.split(placeholder).length-1}};
}
export async function boundedGunzip(compressed,expectedBytes){
 if(!Number.isSafeInteger(expectedBytes)||expectedBytes<1||expectedBytes>8*1024*1024)throw Error('Prepared HTML expansion bound');
 const reader=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
 const parts=[];let length=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;
   if(length>expectedBytes){await reader.cancel('Declared HTML expansion exceeded');throw Error('Prepared HTML expansion exceeded');}parts.push(value);}}
 finally{reader.releaseLock();}
 if(length!==expectedBytes)throw Error('Prepared HTML expansion length differs');
 const output=new Uint8Array(length);let at=0;for(const b of parts){output.set(b,at);at+=b.length;}return output;
}
export async function readPreparedHTML(context,path,rendererSHA256,{decompress=boundedGunzip}={}){
 if(!preparedRoute(path))return null;
 if(!HEX.test(rendererSHA256))throw Error('Prepared renderer binding required');
 const collections=await context.getFacet('collections');
 // Only the current source-derived Surprise roster gets optional artwork HTML.
 // Unselected detail pages keep the canonical reader without directory/body I/O.
 if(path.startsWith('/art/')){
  const paths=collections.preparedArtworkPaths;
  if(paths===undefined)return null;
  if(!Array.isArray(paths)||paths.length>512||new Set(paths).size!==paths.length||paths.some(p=>typeof p!=='string'||!/^\/art\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(p)))throw Error('Invalid prepared artwork roster');
  if(!paths.includes(path))return null;
 }
 if(!collections.preparedHTML)return null;
 const root=await context.read('collections',collections.preparedHTML,{maxBytes:65536});
 if(root.schema!==1||root.type!=='prepared-html-directory-v1'||!HEX.test(root.rendererSHA256)||
   !Number.isSafeInteger(root.routeCount)||root.routeCount<1||root.routeCount>1536)throw Error('Invalid prepared HTML directory');
 // Check current authenticated source and code BEFORE reading a page body.
 if(root.rendererSHA256!==rendererSHA256||!equal(root.sourceBinding,await preparedSourceBinding(context)))return null;
 const descriptor=await lookupHashedRecord(context,'collections',root.directory,path);
 if(!descriptor)return null;
 const r=await context.read('collections',descriptor,{maxBytes:262144});
 if(r.schema!==1||r.type!=='prepared-html-page-v1'||r.path!==path||!HEX.test(r.placeholder)||!HEX.test(r.decodedSHA256)||
  !Number.isSafeInteger(r.decodedBytes)||r.decodedBytes<1||r.decodedBytes>8*1024*1024||
  !Number.isSafeInteger(r.compressedBytes)||r.compressedBytes<1||r.compressedBytes>1048576||
  (Object.hasOwn(r,'body')===Object.hasOwn(r,'chunks')))throw Error('Invalid prepared HTML page');
 if(r.placeholder!==await digest('uc-prepared-root-slot-v1:'+rendererSHA256+':'+path))throw Error('Prepared root-slot binding differs');
 let compressed;
 if(Object.hasOwn(r,'body')){
  if(typeof r.body!=='string'||r.body.length>196608)throw Error('Invalid inline prepared HTML');
  compressed=Uint8Array.from(atob(r.body),c=>c.charCodeAt(0));
 }else{
  if(!Array.isArray(r.chunks)||!r.chunks.length||r.chunks.length>11)throw Error('Prepared chunk count bound');
  let offset=0;for(const d of r.chunks){if(d.offset!==offset||!Number.isSafeInteger(d.count)||d.count<1||d.count>98304)throw Error('Prepared chunk descriptor differs');offset+=d.count;}
  if(offset!==r.compressedBytes)throw Error('Prepared chunk total differs');
  compressed=new Uint8Array(r.compressedBytes);let next=0;
  await Promise.all(Array.from({length:Math.min(4,r.chunks.length)},async()=>{
   while(next<r.chunks.length){const d=r.chunks[next++],part=await context.read('collections',d,{maxBytes:262144});
    if(part.schema!==1||part.type!=='prepared-html-chunk-v1'||part.offset!==d.offset||typeof part.body!=='string'||part.body.length>131072)throw Error('Invalid prepared chunk');
    const b=Uint8Array.from(atob(part.body),c=>c.charCodeAt(0));if(b.length!==d.count)throw Error('Prepared chunk bytes differ');compressed.set(b,d.offset);
   }
  }));
 }
 if(compressed.length!==r.compressedBytes)throw Error('Prepared compressed length differs');
 const bytes=await decompress(compressed,r.decodedBytes);
 if(bytes.length!==r.decodedBytes||await digest(bytes)!==r.decodedSHA256)throw Error('Prepared HTML digest differs');
 const html=new TextDecoder('utf8',{fatal:true}).decode(bytes);
 if(!html.startsWith('<!DOCTYPE html>'))throw Error('Prepared HTML document differs');
 return html.split(r.placeholder).join(context.rootSHA256);
}
