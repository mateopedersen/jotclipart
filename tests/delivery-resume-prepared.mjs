import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, merkle } from '../scripts/delivery/manifest.mjs';
import { verifyPreparedTarget } from '../scripts/delivery/resume-prepared.mjs';

const revision='a'.repeat(40), headers='/*\n  Content-Security-Policy: default-src self\n';
const suffix='\n/delivery-release.json\n  Cache-Control: no-store\n';
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'uc-resume-prepared-'));
  const frozen=join(root,'frozen'), prepared=join(root,'prepared');
  mkdirSync(frozen); mkdirSync(prepared);
  const files=[{path:'/art/a/index.html',key:`delivery/${revision}/art/a/index.html`,bytes:4,sha256:'b'.repeat(64),mime:'text/html'}];
  const manifest={schema:1,status:'remote-byte-verified',bucket:'ultraclipart-pages',revision,
    verified:files.length,files,root:merkle(files).root};
  const worker='export default {}', routes=JSON.stringify({version:1,include:['/*'],exclude:[]})+'\n';
  const release={schema:1,renderedRevision:revision,controlRevision:revision,bucket:manifest.bucket,
    verifiedRoot:manifest.root,r2Files:1,artworks:1,workerSha256:digest(Buffer.from(worker))};
  const previous={...release,directoryFiles:6,pagesFiles:2};
  for (const dir of [frozen,prepared]) {
    writeFileSync(join(dir,'_worker.js'),worker);
    writeFileSync(join(dir,'_headers'),headers+(dir===prepared?suffix:''));
    writeFileSync(join(dir,'_routes.json'),routes);
    writeFileSync(join(dir,'_redirects'),'');
    writeFileSync(join(dir,'index.html'),'reviewed page');
  }
  writeFileSync(join(frozen,'incremental-baseline.json'),JSON.stringify({revision,root:manifest.root}));
  writeFileSync(join(prepared,'delivery-release.json'),JSON.stringify(release)+'\n');
  return {root,frozen,prepared,manifest,previous,expectedStaticFiles:5};
}
test('a sealed, byte-matching prepared package resumes without re-reading R2 objects',()=>{
  const f=fixture();
  try { assert.deepEqual(verifyPreparedTarget(f),{staticFiles:5,preparedFiles:6,remoteManifestFiles:1}); }
  finally { rmSync(f.root,{recursive:true,force:true}); }
});
test('resume rejects altered static bytes, control bytes, missing files and changed manifests',()=>{
  for (const mutate of [
    f=>writeFileSync(join(f.prepared,'index.html'),'changed'),
    f=>writeFileSync(join(f.prepared,'_worker.js'),'changed'),
    f=>writeFileSync(join(f.prepared,'_headers'),headers),
    f=>unlinkSync(join(f.prepared,'index.html')),
    f=>writeFileSync(join(f.prepared,'extra.html'),'extra'),
    f=>{f.manifest.root='c'.repeat(64)},
    f=>{f.manifest.status='upload-started'},
    f=>{f.previous.controlRevision='d'.repeat(40)},
  ]) {
    const f=fixture();
    try { mutate(f); assert.throws(()=>verifyPreparedTarget(f)); }
    finally { rmSync(f.root,{recursive:true,force:true}); }
  }
});
