import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compiledModuleImports} from '../scripts/catalog-snapshot/module-imports.mjs';
import {preloadDocumentModules} from '../server/catalog-snapshot/module-preloads.mjs';
const revision='a'.repeat(40),prefix='/__ssr-client/'+revision+'/';
const assets=['entry','shared','utility','optional'].map(name=>({file:'private/'+name+'.js',url:prefix+name+'.js',bytes:10}));
const fixture=()=>({outputs:Object.fromEntries(assets.map(a=>[a.file,{bytes:a.bytes,imports:[]}]))});
const html='<html><head></head><body><script type="module" src="'+prefix+'entry.js"></script></body></html>';
test('Static transitive dependencies start with their actual document, optional editor code stays deferred',()=>{
 const m=fixture();m.outputs['private/entry.js'].imports=[{kind:'import-statement',path:'private/shared.js'},{kind:'dynamic-import',path:'private/optional.js'}];m.outputs['private/shared.js'].imports=[{kind:'import-statement',path:'private/utility.js'}];
 const graph=compiledModuleImports(m,assets,revision),result=preloadDocumentModules(html,revision,graph);
 assert(result.includes('href="'+prefix+'shared.js"'));assert(result.includes('href="'+prefix+'utility.js"'));assert(!result.includes('optional.js'));assert.equal((result.match(/rel="modulepreload"/g)||[]).length,3);
});
test('Unknown, external and changed-byte compiler outputs fail closed',()=>{
 const m=fixture();m.outputs['private/entry.js'].imports=[{kind:'import-statement',path:'private/missing.js'}];assert.throws(()=>compiledModuleImports(m,assets,revision),/Unverified/);
 m.outputs['private/entry.js'].imports=[{kind:'import-statement',path:'private/shared.js',external:true}];assert.throws(()=>compiledModuleImports(m,assets,revision),/Unverified/);
 m.outputs['private/entry.js'].imports=[];m.outputs['private/shared.js'].bytes=11;assert.throws(()=>compiledModuleImports(m,assets,revision),/Unverified/);
});
test('Existing editor preloads are traversed without duplication; cycles are bounded',()=>{
 const document=html.replace('</head>','<link rel="modulepreload" href="'+prefix+'entry.js"></head>');
 const graph={[prefix+'entry.js']:[prefix+'shared.js'],[prefix+'shared.js']:[prefix+'entry.js']};
 const result=preloadDocumentModules(document,revision,graph);assert.equal((result.match(/rel="modulepreload"/g)||[]).length,2);
});
test('Old tabs, cross-origin URLs, traversal and oversized dependency sets are never preloaded',()=>{
 assert.equal(preloadDocumentModules(html.replaceAll(revision,'b'.repeat(40)),revision,{}),html.replaceAll(revision,'b'.repeat(40)));
 for(const bad of ['https://external.invalid/a.js',prefix+'../bad.js','/__ssr-client/'+('b'.repeat(40))+'/a.js'])assert.throws(()=>preloadDocumentModules(html,revision,{[prefix+'entry.js']:[bad]}),/Unbound/);
 assert.throws(()=>preloadDocumentModules(html,revision,{[prefix+'entry.js']:Array.from({length:33},(_,i)=>prefix+i+'.js')}),/Invalid/);
});
