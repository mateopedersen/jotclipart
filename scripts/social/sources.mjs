import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');

export async function socialSources(root) {
 const manifest=JSON.parse(await readFile(join(root,'data/social-source-artworks.json')));
 if(manifest.version!==1||manifest.policy!=='signed-catalog-bound-reviewed-social-originals-v1'||manifest.signatureVerified!==true||!/^[a-f0-9]{64}$/.test(manifest.signedCatalogRoot))throw Error('Verified social source manifest required');
 const items=new Map(manifest.items.map(item=>[item.localPath,item]));
 if(items.size!==manifest.items.length)throw Error('Duplicate social source path');
 const cache=join(root,'.astro/social-images/originals');await mkdir(cache,{recursive:true});
 const receipts=new Map();
 function check(item,bytes){
  if(bytes.length!==item.bytes||sha(bytes)!==item.sha256||item.mime!=='image/webp'||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP')throw Error('Social artwork original bytes/hash/format differ: '+item.id);
  return bytes;
 }
 async function read(path){
  const absolute=resolve(root,path);if(!absolute.startsWith(resolve(root)+'/'))throw Error('Social input escapes checkout');
  const item=items.get(path);
  if(!item){if(path.startsWith('public/catalog/'))throw Error('Unreviewed social artwork input');return readFile(absolute)}
  if(!/^https:\/\/assets\.jotclipart\.com\/[a-zA-Z0-9_./-]+\.webp$/.test(item.url)||!Number.isSafeInteger(item.bytes)||item.bytes<12||item.bytes>16000000||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('Invalid bound social source');
  try{return check(item,await readFile(absolute))}catch(error){if(error.code!=='ENOENT')throw error}
  const file=join(cache,item.sha256+'.webp');
  try{return check(item,await readFile(file))}catch(error){if(error.code!=='ENOENT')throw error}
  let bytes;
  for(let attempt=0;attempt<3;attempt++)try {
    const response=await fetch(item.url,{redirect:'error',signal:AbortSignal.timeout(60000)});
    if(response.status===429||response.status>=500)throw Object.assign(Error('Temporary source HTTP status '+response.status),{retriable:true});
    if(!response.ok||!/^image\/webp(?:;|$)/i.test(response.headers.get('content-type')??''))throw Error('Original social source HTTP/MIME failed: '+item.id);
    const announced=Number(response.headers.get('content-length'));if(announced&&announced!==item.bytes)throw Error('Original social source HTTP size differs');
    const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>item.bytes)throw Error('Original social source exceeded bound size');chunks.push(chunk)}
    bytes=check(item,Buffer.concat(chunks));break;
  } catch(error) {
    const transient=error.retriable||error.message==='fetch failed'||['ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(error.cause?.code)||['AbortError','TimeoutError'].includes(error.name);
    if(!transient||attempt===2)throw error;
    await new Promise(done=>setTimeout(done,800*(attempt+1)));
  }
  const temporary=file+'.'+process.pid+'.tmp';await writeFile(temporary,bytes,{flag:'wx'});await rename(temporary,file);
  receipts.set(item.id,{id:item.id,url:item.url,bytes:bytes.length,sha256:item.sha256,mime:item.mime,checkedAt:new Date().toISOString()});
  return bytes;
 }
 return {read,manifest,receipts:()=>[...receipts.values()]};
}
