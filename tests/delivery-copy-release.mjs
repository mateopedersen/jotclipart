import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectDeliveryFiles, merkle, copyVerifiedPrunedRelease } from '../scripts/delivery/manifest.mjs';

test('verified R2 files are excluded without duplicating or modifying the source build', () => {
  const root=mkdtempSync(join(tmpdir(),'uc-release-copy-')), source=join(root,'source'), target=join(root,'target');
  const revision='a'.repeat(40);
  try {
    for(const path of ['art/item','edit/item','previews/p1','_astro','clipart/item'])
      mkdirSync(join(source,path),{recursive:true});
    const html=`<meta name="build-revision" content="${revision}">`;
    writeFileSync(join(source,'art/item/index.html'),html);
    writeFileSync(join(source,'edit/item/index.html'),html);
    writeFileSync(join(source,'_astro/site.css'),'body { color: navy; }');
    writeFileSync(join(source,'index.html'),'homepage');
    writeFileSync(join(source,'clipart/item/index.html'),'collection');
    const files=collectDeliveryFiles(source,revision);
    const manifest={schema:1,status:'remote-byte-verified',revision,bucket:'ultraclipart-pages',files,verified:files.length,root:merkle(files).root};
    assert.equal(copyVerifiedPrunedRelease(source,target,manifest,revision),3);
    assert.equal(readFileSync(join(target,'index.html'),'utf8'),'homepage');
    assert.equal(readFileSync(join(target,'clipart/item/index.html'),'utf8'),'collection');
    assert.equal(existsSync(join(target,'art/item/index.html')),false);
    assert.equal(existsSync(join(target,'edit/item/index.html')),false);
    assert.equal(existsSync(join(target,'_astro/site.css')),false);
    assert.equal(readFileSync(join(source,'art/item/index.html'),'utf8'),html);
    writeFileSync(join(source,'art/item/index.html'),html+' changed');
    assert.throws(()=>copyVerifiedPrunedRelease(source,join(root,'bad'),manifest,revision),/changed or verification is incomplete/);
    assert.equal(existsSync(join(root,'bad')),false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
