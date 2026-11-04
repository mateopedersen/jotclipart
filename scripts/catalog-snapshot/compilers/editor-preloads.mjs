// Preload only the requested editor entry and its static graph, never export tools.
export function editorCriticalPreloads(meta,revision){
 if(!/^[a-f0-9]{40}$/.test(revision??''))throw Error('Exact software revision required');
 const outputs=meta?.outputs??{},roots=Object.entries(outputs).filter(([,v])=>/(?:^|\/)src\/editor\/editor\.ts$/.test(v.entryPoint??''));
 if(roots.length!==1)throw Error('One exact editor entry required');
 const seen=new Set(),urls=[];let bytes=0;
 function visit(file){if(seen.has(file))return;const info=outputs[file];if(!info||!file.endsWith('.js'))throw Error('Unverified preload output');seen.add(file);bytes+=info.bytes;if(seen.size>64||bytes>2*1024*1024)throw Error('Critical editor preload budget');const name=file.split('/').at(-1);if(!/^[a-zA-Z0-9_-]+\.js$/.test(name))throw Error('Unsafe preload file');urls.push('/__ssr-client/'+revision+'/'+name);for(const dep of info.imports??[])if(!dep.external&&dep.kind==='import-statement')visit(dep.path)}
 visit(roots[0][0]);return{urls,bytes};
}
