// Private cache adapter. Caller must capture and authenticate one snapshot first.
// The current revision is resolved before each cache lookup. Old namespaces are
// never used by new requests, so correctness does not rely on global cache.delete.
export async function snapshotHTMLResponse({request,context,rendererSHA256,cache,render}){
 if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{allow:'GET, HEAD','cache-control':'no-store'}});
 if(!/^[a-f0-9]{64}$/.test(rendererSHA256??'')||!/^[a-f0-9]{64}$/.test(context?.rootSHA256??'')||typeof render!=='function')throw Error('Captured snapshot and renderer binding required');
 const url=new URL(request.url),ownOrigin=url.protocol==='https:'&&!url.port&&(url.hostname==='ultraclipart.com'||url.hostname==='ultraclipart.pages.dev'||/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ultraclipart\.pages\.dev$/.test(url.hostname)),route=/^\/(?:art|edit|clipart|collection)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname)||['/','/new/','/search/','/black-and-white/','/categories/','/collections/','/library-index/','/create/','/favorites/','/ai-clipart-generator/'].includes(url.pathname);if(!ownOrigin||url.href.length>4096||!route)throw Error('Invalid cache route');
 // These shells render the same server representation for tracking/search
 // parameters; interactive search reads the URL on the client. Keep the URL
 // untouched for visitors while avoiding unbounded copies in the cache.
 url.search='';
 const routeSHA256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url.pathname+url.search)))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const key=new Request(`https://snapshot-cache.invalid/${rendererSHA256}/${context.rootSHA256}${url.pathname}${url.search}`),etag=`"uc-${rendererSHA256}-${context.rootSHA256}-${routeSHA256}"`;
 let response=cache?await cache.match(key):undefined;
 if(!response){response=await render();if(!(response instanceof Response))throw Error('Renderer response required');
  // A failed or personalized result is never shared or given a success ETag.
  if(response.status!==200||response.headers.has('set-cookie')||!response.headers.get('content-type')?.toLowerCase().startsWith('text/html')){const headers=new Headers(response.headers);headers.set('cache-control','no-store');return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers})}
  const storedHeaders=new Headers(response.headers);storedHeaders.set('cache-control','public, max-age=31536000, immutable');storedHeaders.set('etag',etag);storedHeaders.set('x-uc-revision',context.snapshot.revision);
  response=new Response(response.body,{status:200,headers:storedHeaders});if(cache)await cache.put(key,response.clone());
 }
 if(response.status!==200||response.headers.get('etag')!==etag||response.headers.get('x-uc-revision')!==context.snapshot.revision)throw Error('Cached snapshot binding changed');
 const headers=new Headers(response.headers);headers.set('cache-control','no-cache');headers.delete('age');
 const tags=(request.headers.get('if-none-match')??'').split(',').map(x=>x.trim().replace(/^W\//,''));
 if(tags.includes(etag)||tags.includes('*'))return new Response(null,{status:304,headers});
 return new Response(request.method==='HEAD'?null:response.body,{status:200,headers});
}
