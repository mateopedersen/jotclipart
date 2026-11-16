import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
test('independent package stays within actual Free Pages and paid Worker limits',()=>{
 const report=JSON.parse(readFileSync('work/jotclipart-build/package-report.json'));
 assert.equal(report.proRequiredForFileCount,false);assert(report.staticFiles<20000);
 assert(report.workerGzipBytes<=10*1024*1024);assert.equal(report.mediaFilesCopied,0);
 for(const f of report.inventory){const b=readFileSync('dist/'+f.path);assert.equal(b.length,f.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),f.sha256)}
});
test('independent runtime and pointer contain no old project fallback',()=>{
 const cfg=JSON.parse(readFileSync('config/catalog-snapshot-public.json'));
 assert.equal(cfg.activeKey,'catalog/jotclipart/active.json');
 const source=readFileSync('scripts/catalog-snapshot/build-runtime.mjs','utf8');
 assert(!source.includes('work/delivery/'));assert(!source.includes('fallback.fetch'));
 assert(!source.includes('ultraclipart.pages.dev'));assert(existsSync('dist/_worker.js'));
});
