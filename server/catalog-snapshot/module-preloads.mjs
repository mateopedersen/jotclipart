/** Start downloading only the module entries already present in this document. */
export function preloadDocumentModules(html,revision){
 if(!/^[a-f0-9]{40}$/.test(revision??''))throw Error('Exact installed source revision required');
 const prefix='/__ssr-client/'+revision+'/',seen=new Set();
 for(const m of html.matchAll(/<link\b([^>]*)>/g)){const a=Object.fromEntries([...m[1].matchAll(/([a-z-]+)="([^"]*)"/g)].map(v=>[v[1],v[2]]));if(a.rel==='modulepreload')seen.add(a.href)}
 const links=[];for(const m of html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script>/g)){
  const a=Object.fromEntries([...m[1].matchAll(/([a-z-]+)="([^"]*)"/g)].map(v=>[v[1],v[2]]));
  if(a.type!=='module'||!a.src?.startsWith(prefix)||!/^[a-zA-Z0-9_-]+\.js$/.test(a.src.slice(prefix.length))||seen.has(a.src))continue;
  seen.add(a.src);links.push('<link rel="modulepreload" href="'+a.src+'">');
  if(links.length>32)throw Error('Document module budget exceeded');
 }
 return links.length?html.replace('</head>',links.join('')+'</head>'):html;
}
