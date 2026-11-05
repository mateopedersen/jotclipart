/** Preload essential entries and leave optional modules for the post-load loader. */
export function preloadDocumentModules(html,revision,moduleImports={},nonBlockingModules=[]){
 if(!/^[a-f0-9]{40}$/.test(revision??''))throw Error('Exact installed source revision required');
 const prefix='/__ssr-client/'+revision+'/',seen=new Set();
 for(const m of html.matchAll(/<link\b([^>]*)>/g)){const a=Object.fromEntries([...m[1].matchAll(/([a-z-]+)="([^"]*)"/g)].map(v=>[v[1],v[2]]));if(a.rel==='modulepreload')seen.add(a.href)}
 const links=[],entries=[],optional=new Set(nonBlockingModules);
 html=html.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/g,(tag,attributes)=>{
  const a=Object.fromEntries([...attributes.matchAll(/([a-z-]+)="([^"]*)"/g)].map(v=>[v[1],v[2]]));
  if(a.type!=='module'||!a.src?.startsWith(prefix)||!/^[a-zA-Z0-9_-]+\.js$/.test(a.src.slice(prefix.length)))return tag;
  if(optional.has(a.src))
   return '<script type="application/json" data-uc-later-module="'+a.src+'"></script>';
  entries.push(a.src);
  return tag;
 });
 const visited=new Set();
 for(let i=0;i<entries.length;i++){
  const url=entries[i];if(visited.has(url))continue;visited.add(url);
  if(visited.size>32)throw Error('Document module budget exceeded');
  if(!url.startsWith(prefix)||!/^[a-zA-Z0-9_-]+\.js$/.test(url.slice(prefix.length)))throw Error('Unbound module import');
  if(!seen.has(url)){seen.add(url);links.push('<link rel="modulepreload" href="'+url+'">')}
  const dependencies=moduleImports[url];if(dependencies===undefined)continue;
  if(!Array.isArray(dependencies)||dependencies.length>32)throw Error('Invalid module imports');
  entries.push(...dependencies);
 }
 return links.length?html.replace('</head>',links.join('')+'</head>'):html;
}
