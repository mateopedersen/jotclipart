// Source-derived Studio JSON. The publisher runs the existing canonical UI
// provider; requests authenticate the current graph before using this descriptor.
import {canonical,digest} from '../catalog-search/store.mjs';
import {preparedSourceBinding,boundedGunzip} from './prepared-html.mjs';
const HEX=/^[a-f0-9]{64}$/;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function valid(info,snapshot){
 return info&&Array.isArray(info.items)&&info.items.length<=500&&Number.isSafeInteger(info.total)&&info.total>=info.items.length&&
  Array.isArray(info.topics)&&info.topics.length<=10000&&info.transport?.snapshot===snapshot&&
  info.transport.protocol==='snapshot-search-v1'&&info.transport.endpoint==='/catalog-search.json';
}
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
export async function prepareStudioInfoRecord({context,info,rendererSHA256,compress,put}){
 if(!HEX.test(rendererSHA256)||!valid(info,context.rootSHA256))throw Error('Canonical Studio source required');
 const baseline=JSON.stringify(info),placeholder=await digest('uc-prepared-studio-slot-v1:'+rendererSHA256),isolated=structuredClone(info);
 if(baseline.includes(placeholder))throw Error('Studio root-slot collision');
 isolated.transport.snapshot=placeholder;const text=JSON.stringify(isolated);
 if(text.includes(context.rootSHA256)||text.split(placeholder).join(context.rootSHA256)!==baseline)throw Error('Studio root-slot equivalence differs');
 const bytes=new TextEncoder().encode(text);if(bytes.length>8*1024*1024)throw Error('Prepared Studio expansion bound');
 const compressed=await compress(bytes);if(!(compressed instanceof Uint8Array)||!compressed.length||compressed.length>1048576)throw Error('Prepared Studio compressed bound');
 const inline=compressed.length<=147456,chunks=[];
 if(!inline)for(let offset=0;offset<compressed.length;offset+=98304){const b=compressed.subarray(offset,offset+98304);chunks.push({offset,count:b.length,...await put({schema:1,type:'prepared-studio-chunk-v1',offset,body:base64(b)})});}
 const page=await put({schema:1,type:'prepared-studio-info-v1',placeholder,decodedBytes:bytes.length,decodedSHA256:await digest(bytes),compressedBytes:compressed.length,
  ...(inline?{body:base64(compressed)}:{chunks})});
 const descriptor=await put({schema:1,type:'prepared-studio-index-v1',rendererSHA256,sourceBinding:await preparedSourceBinding(context),page});
 return{descriptor,receipt:{status:'CANONICAL_STUDIO_INFO_DERIVED_NOT_LIVE',entries:info.items.length,sourceRoot:context.rootSHA256,sourceBodySHA256:await digest(baseline),decodedBytes:bytes.length,compressedBytes:compressed.length}};
}
export async function readPreparedStudioInfo(context,rendererSHA256,{decompress=boundedGunzip}={}){
 const collections=await context.getFacet('collections');if(!collections.preparedStudio)return null;
 if(!HEX.test(rendererSHA256))throw Error('Studio renderer binding required');
 const index=await context.read('collections',collections.preparedStudio,{maxBytes:65536});
 if(index.schema!==1||index.type!=='prepared-studio-index-v1'||!HEX.test(index.rendererSHA256))throw Error('Invalid prepared Studio index');
 if(index.rendererSHA256!==rendererSHA256||!same(index.sourceBinding,await preparedSourceBinding(context)))return null;
 const r=await context.read('collections',index.page,{maxBytes:262144});
 if(r.schema!==1||r.type!=='prepared-studio-info-v1'||r.placeholder!==await digest('uc-prepared-studio-slot-v1:'+rendererSHA256)||!HEX.test(r.decodedSHA256)||
  !Number.isSafeInteger(r.decodedBytes)||r.decodedBytes<1||r.decodedBytes>8*1024*1024||!Number.isSafeInteger(r.compressedBytes)||r.compressedBytes<1||r.compressedBytes>1048576||
  (Object.hasOwn(r,'body')===Object.hasOwn(r,'chunks')))throw Error('Invalid prepared Studio page');
 let compressed;
 if(Object.hasOwn(r,'body')){
  if(typeof r.body!=='string'||r.body.length>196608)throw Error('Invalid inline Studio page');compressed=Uint8Array.from(atob(r.body),c=>c.charCodeAt(0));
 }else{
  if(!Array.isArray(r.chunks)||!r.chunks.length||r.chunks.length>11)throw Error('Studio chunk count bound');
  let offset=0;for(const d of r.chunks){if(d.offset!==offset||!Number.isSafeInteger(d.count)||d.count<1||d.count>98304)throw Error('Studio chunk offset differs');offset+=d.count;}
  if(offset!==r.compressedBytes)throw Error('Studio chunk total differs');compressed=new Uint8Array(offset);let next=0;
  await Promise.all(Array.from({length:Math.min(4,r.chunks.length)},async()=>{while(next<r.chunks.length){const d=r.chunks[next++],part=await context.read('collections',d,{maxBytes:262144});
   if(part.schema!==1||part.type!=='prepared-studio-chunk-v1'||part.offset!==d.offset||typeof part.body!=='string'||part.body.length>131072)throw Error('Invalid Studio chunk');
   const b=Uint8Array.from(atob(part.body),c=>c.charCodeAt(0));if(b.length!==d.count)throw Error('Studio chunk length differs');compressed.set(b,d.offset);
  }}));
 }
 if(compressed.length!==r.compressedBytes)throw Error('Studio compressed length differs');const bytes=await decompress(compressed,r.decodedBytes);
 if(bytes.length!==r.decodedBytes||await digest(bytes)!==r.decodedSHA256)throw Error('Studio decoded digest differs');
 const text=new TextDecoder('utf8',{fatal:true}).decode(bytes),info=JSON.parse(text);if(!valid(info,r.placeholder))throw Error('Studio decoded contract differs');
 return text.split(r.placeholder).join(context.rootSHA256);
}
