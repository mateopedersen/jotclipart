import {resolve} from 'node:path';
/** Only immutable, byte-verified, static ESM imports of the actual document. */
export function compiledModuleImports(meta,assets,revision){
 if(!/^[a-f0-9]{40}$/.test(revision??'')||!meta?.outputs)throw Error('Bound compiler graph required');
 const byFile=new Map(assets.map(a=>[resolve(a.file),a])),result={};
 for(const [file,output] of Object.entries(meta.outputs)){
  if(!file.endsWith('.js'))continue;
  const source=byFile.get(resolve(file));if(!source||source.bytes!==output.bytes)throw Error('Unverified module output');
  const dependencies=[];
  for(const item of output.imports??[]){
   if(item.kind!=='import-statement')continue;
   const target=byFile.get(resolve(item.path));
   if(item.external||!target||!item.path.endsWith('.js'))throw Error('Unverified static module import');
   if(!target.url.startsWith('/__ssr-client/'+revision+'/'))throw Error('Foreign module revision');
   dependencies.push(target.url);
  }
  if(!source.url.startsWith('/__ssr-client/'+revision+'/'))throw Error('Foreign entry revision');
  result[source.url]=[...new Set(dependencies)];
 }
 return result;
}
