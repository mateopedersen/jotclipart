import assert from 'node:assert/strict';
import { constants, cpSync, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { digest, merkle } from './manifest.mjs';
import { finalizeVerifiedDeliveryRelease, readCommittedCatalog } from './activate.mjs';

const headerSuffix = '\n/delivery-release.json\n  Cache-Control: no-store\n';
const routes = JSON.stringify({version:1, include:['/*'], exclude:[]}) + '\n';

function files(base) {
  const result=[];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const file=join(dir,entry), st=lstatSync(file);
      if (st.isSymbolicLink()) throw Error('Prepared release contains a symlink');
      if (st.isDirectory()) walk(file);
      else if (st.isFile()) result.push('/'+relative(base,file).split(sep).join('/'));
      else throw Error('Prepared release contains a non-regular file');
    }
  }
  walk(base); return result;
}

/** Check the failed pre-activation package against its sealed full build and
 * prior remote-byte-verified manifest, without re-reading all R2-backed files. */
export function verifyPreparedTarget({prepared, frozen, manifest, previous, expectedStaticFiles}) {
  assert.equal(manifest.schema,1); assert.equal(manifest.status,'remote-byte-verified');
  assert.equal(manifest.bucket,'ultraclipart-pages');
  assert.equal(manifest.verified,manifest.files.length);
  assert.equal(merkle(manifest.files).root,manifest.root);
  const marker=JSON.parse(readFileSync(join(frozen,'incremental-baseline.json'),'utf8'));
  assert.equal(marker.revision,manifest.revision); assert.equal(marker.root,manifest.root);
  assert.equal(previous.renderedRevision,manifest.revision);
  assert.equal(previous.controlRevision,manifest.revision);
  assert.equal(previous.verifiedRoot,manifest.root);
  assert.equal(previous.r2Files,manifest.verified);
  assert(Number.isSafeInteger(expectedStaticFiles) && expectedStaticFiles > 0);
  assert.equal(previous.directoryFiles,expectedStaticFiles+1);
  assert.equal(previous.pagesFiles,previous.directoryFiles-4);
  const paths=files(prepared), offloaded=new Set(manifest.files.map((x)=>x.path));
  assert.equal(offloaded.size,manifest.verified);
  assert.equal(paths.length,previous.directoryFiles);
  const required=new Set(['/_worker.js','/_headers','/_routes.json','/delivery-release.json']);
  for (const path of paths) {
    assert(!offloaded.has(path), `Remote delivery file is unexpectedly in Pages package: ${path}`);
    required.delete(path);
    const file=join(prepared,path), original=join(frozen,path);
    if (path==='/_worker.js') assert.equal(digest(readFileSync(file)),previous.workerSha256);
    else if (path==='/_headers')
      assert.equal(readFileSync(file,'utf8'),readFileSync(original,'utf8')+headerSuffix);
    else if (path==='/_routes.json') assert.equal(readFileSync(file,'utf8'),routes);
    else if (path==='/delivery-release.json') {
      const {directoryFiles,pagesFiles,...expected}=previous;
      assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),expected);
    } else {
      const st=lstatSync(original);
      assert(st.isFile() && !st.isSymbolicLink(), `Missing sealed static file: ${path}`);
      const a=readFileSync(file), b=readFileSync(original);
      assert.equal(a.length,b.length,`Static bytes changed: ${path}`);
      assert.equal(digest(a),digest(b),`Static digest changed: ${path}`);
    }
  }
  assert.equal(required.size,0,'Required prepared control file is missing');
  return {staticFiles:expectedStaticFiles, preparedFiles:paths.length, remoteManifestFiles:offloaded.size};
}

/** Resume only the same previously checked, pre-activation package, making a
 * separate output. It never uploads or alters the frozen source or old package. */
export async function resumePreparedDeliveryRelease({source, frozen, prepared, target, manifestPath,
    revision, controlRevision, expectedStaticFiles, root=process.cwd()}) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{40}$/.test(controlRevision) ||
      [source,frozen,prepared].includes(target) || existsSync(target))
    throw Error('Separate new output and full revisions are required');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const previous=JSON.parse(readFileSync(manifestPath.replace(/verified-manifest\.json$/,'prepared-release.json'),'utf8'));
  assert.equal(manifest.revision,revision);
  if (manifest.incrementalPlan?.shadowOnly) throw Error('A shadow release cannot be resumed');
  const proof=verifyPreparedTarget({prepared,frozen,manifest,previous,expectedStaticFiles});
  assert.equal(digest(readFileSync(join(source,'_worker.js'))),digest(readFileSync(join(frozen,'_worker.js'))));
  const catalog=readCommittedCatalog(revision);
  const ids=catalog.filter((a)=>a.published&&a.indexable).map((a)=>a.id).sort();
  const actual=manifest.files.filter((a)=>a.path.startsWith('/art/')).map((a)=>a.path.split('/')[2]).sort();
  assert.deepEqual(ids,actual);
  assert.equal(manifest.files.filter((a)=>a.path.startsWith('/edit/')).length,ids.length);
  cpSync(prepared,target,{recursive:true,mode:constants.COPYFILE_FICLONE});
  copyFileSync(join(frozen,'_headers'),join(target,'_headers'));
  rmSync(join(target,'delivery-release.json'));
  const release=await finalizeVerifiedDeliveryRelease({source:frozen,target,manifestPath,revision,
    controlRevision,root,manifest,catalog,ids,removed:manifest.verified});
  return {release,proof};
}
