import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,rmSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';

// The established Astro native-template / signed R2 catalog architecture.
// No catalog prerender, media duplication, old deployment or old checkout input.
const root=process.cwd(), buildRoot='work/jotclipart-build', out=resolve('dist');
const run=(script,...args)=>execFileSync(process.execPath,[script,...args],{stdio:'inherit',cwd:root});
const sha=b=>createHash('sha256').update(b).digest('hex');
run('scripts/build-site-icons.mjs');
run('scripts/verify-social-images.mjs');
run('scripts/catalog-snapshot/compile-renderers.mjs',buildRoot);
run('scripts/catalog-snapshot/build-runtime.mjs',buildRoot,'config/catalog-snapshot-public.json');
const code=JSON.parse(readFileSync(join(buildRoot,'runtime/software-report.json')));
if(existsSync(out))rmSync(out,{recursive:true});mkdirSync(out,{recursive:true});
function copy(source,path,proof){
  const bytes=readFileSync(source);
  if(proof&&(sha(bytes)!==proof.sha256||bytes.length!==proof.bytes))throw Error('Changed software asset '+path);
  const target=join(out,path);if(!target.startsWith(out+'/'))throw Error('Invalid output path');
  if(existsSync(target)){if(sha(readFileSync(target))!==sha(bytes))throw Error('Output collision '+path);return;}
  mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target);
}
const tracked=execFileSync('git',['ls-files','-z','public'],{encoding:'utf8'}).split('\0').filter(Boolean);
for(const file of tracked){
  if(file.startsWith('public/catalog/')||file.startsWith('public/art/')||file==='public/_headers'||file==='public/_redirects')continue;
  if(!existsSync(file))throw Error('Missing tracked interface input '+file);
  copy(file,file.slice(7));
}
for(const a of code.clientAssets)copy(a.file,a.url.replace(/^\//,''),a);
copy(join(buildRoot,'runtime/worker.mjs'),'_worker.js',{sha256:code.workerSHA256,bytes:code.workerBytes});
writeFileSync(join(out,'_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:[]}));
writeFileSync(join(out,'_headers'),'/*\n  X-Content-Type-Options: nosniff\n/__ssr-client/*\n  Cache-Control: public, max-age=31536000, immutable\n');
writeFileSync(join(out,'404.html'),'<!doctype html><html lang="en"><head><meta name="robots" content="noindex"><title>Page Not Found | JotClipart</title></head><body><h1>Page Not Found</h1><a href="/">JotClipart</a></body></html>');
const inventory=[];
function walk(dir){for(const name of readdirSync(dir)){const file=join(dir,name),st=lstatSync(file);if(st.isSymbolicLink())throw Error('Output symlink forbidden');if(st.isDirectory())walk(file);else{const b=readFileSync(file);inventory.push({path:relative(out,file),bytes:b.length,sha256:sha(b)})}}}walk(out);
const assets=inventory.filter(f=>!f.path.startsWith('_worker.'));
if(assets.length>20000)throw Error('Verified Free Pages file entitlement exceeded');
if(assets.some(f=>f.bytes>25*1024*1024))throw Error('Pages static asset size exceeded');
const workerGzipBytes=gzipSync(readFileSync(join(out,'_worker.js'))).length;
if(workerGzipBytes>10*1024*1024)throw Error('Workers Paid compressed script limit exceeded');
const report={status:'BUILT_NOT_DEPLOYED',sourceRevision:code.revision,abiSHA256:code.abiSHA256,
  staticFiles:assets.length,staticFileLimit:20000,proRequiredForFileCount:false,
  workerBytes:code.workerBytes,workerGzipBytes,bytes:inventory.reduce((n,f)=>n+f.bytes,0),
  fullCatalogPagesBuilt:0,mediaFilesCopied:0,inventory};
mkdirSync('work/jotclipart-build',{recursive:true});writeFileSync('work/jotclipart-build/package-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,inventory:undefined}));
