/** Normalize only byte-verified, versioned files included in this software package. */
export function immutableSoftwareAssetResponse(request,response,immutableURLs){
 const url=new URL(request.url);
 if(!['GET','HEAD'].includes(request.method)||url.search||!immutableURLs.has(url.pathname)||![200,304].includes(response.status)||response.headers.has('set-cookie'))return response;
 const mime=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
 if(response.status!==304&&!['application/javascript','text/javascript','application/wasm','image/webp','image/svg+xml'].includes(mime))return response;
 const headers=new Headers(response.headers);
 // Pages combines global and path _headers. Duplicate max-age values make
 // freshness ambiguous, even when a later value says immutable.
 headers.set('Cache-Control','public, max-age=31536000, immutable');
 return new Response(request.method==='HEAD'||response.status===304?null:response.body,{status:response.status,statusText:response.statusText,headers});
}
