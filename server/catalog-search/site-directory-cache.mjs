import { digest } from './store.mjs';
const ROOT=/^[a-f0-9]{64}$/;
/** Shared PUBLIC source directory, never a query, search result or visitor state. */
export async function publicSiteDirectory({request,root,cache,defer,read,validate}){
 const url=new URL(request.url),path=/^\/search-data\/([a-f0-9]{64})\/site\.json$/.exec(url.pathname);
 if(!ROOT.test(root)||!path||path[1]!==root||url.search||!['GET','HEAD'].includes(request.method))throw Object.assign(Error('Invalid directory request'),{status:400});
 const key=new Request('https://snapshot-directory-cache.invalid/v1/'+root+'/site.json');
 let body,signature,cached=false;
 try{const saved=await cache?.match(key);if(saved){if(saved.status!==200||saved.headers.has('set-cookie')||saved.headers.get('x-uc-snapshot')!==root)throw Error('Cached directory binding differs');body=await saved.text();if(new TextEncoder().encode(body).length>8*1024*1024)throw Error('Directory budget exceeded');signature=await digest(body);if(saved.headers.get('x-uc-directory-digest')!==signature)throw Error('Cached directory digest differs');const data=JSON.parse(body);if(data.schema!==1||data.snapshot!==root)throw Error('Cached directory snapshot differs');validate(data.result);cached=true}}catch{body=undefined;signature=undefined;try{await cache?.delete(key)}catch{}}
 if(body===undefined){const value=validate(await read());body=JSON.stringify({schema:1,snapshot:root,result:value});if(new TextEncoder().encode(body).length>8*1024*1024)throw Error('Directory budget exceeded');signature=await digest(body)}
 const headers={'content-type':'application/json;charset=utf-8','cache-control':'public, max-age=31536000, immutable','etag':'"uc-site-'+root+'-'+signature+'"','x-uc-snapshot':root,'x-uc-directory-digest':signature,'x-content-type-options':'nosniff','x-uc-directory-cache':cached?'HIT':'MISS'};
 const response=new Response(body,{headers});
 if(cache&&!cached){const save=cache.put(key,response.clone()).catch(()=>{});if(defer)defer(save);else await save}
 if(request.headers.get('if-none-match')===headers.etag)return new Response(null,{status:304,headers});
 return request.method==='HEAD'?new Response(null,{headers}):response;
}
