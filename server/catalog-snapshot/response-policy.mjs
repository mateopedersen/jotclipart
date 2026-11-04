// Use the accepted site's exact CSP; never add unsafe-inline script permissions.
const hex=bytes=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
export async function validateInlineScripts(html,allowedHashes){
 if(!Array.isArray(allowedHashes)||!allowedHashes.length)throw Error('Reviewed script policy required');
 for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(/\bsrc\s*=/.test(m[1])||/type="application\/(?:ld\+)?json"/.test(m[1])||!m[2].trim())continue;
  const digest=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(m[2])));
  if(!allowedHashes.includes(digest))throw Error('Unexpected inline executable script');
 }
}
export function applyCatalogHeaders(response,path,policy){
 const headers=new Headers(response.headers),base=path==='/create/'||path==='/ai-clipart-generator/'||path.startsWith('/edit/')?policy.editor:policy.page;
 for(const[k,v]of Object.entries(base)){if(k.toLowerCase()==='cache-control')continue;headers.set(k,v)}
 if(['/search-data/manifest.json','/studio-manifest.json','/studio-featured.json','/studio-catalog.json'].includes(path))headers.set('Vary','X-UC-Catalog-Protocol');
 return new Response(response.body,{status:response.status,headers});
}
