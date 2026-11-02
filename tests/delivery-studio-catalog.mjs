import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { shardStudioCatalog } from '../scripts/delivery/studio-catalog-shard.mjs';
import { createStudioCatalogHandler } from '../server/delivery/studio-catalog.mjs';
import { assertReleaseBudgets, PAGES_MAX_FILE_BYTES } from '../scripts/delivery/budgets.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const target = mkdtempSync(join(tmpdir(), 'uc-studio-parts-'));
  const original = Buffer.from(JSON.stringify([
    { id:'first', title:'Étoile 🦊', webp:{url:'https://example.test/a.webp', sha256:'abc'} },
    { id:'second', title:'Another image', width:300, height:400 },
  ]));
  writeFileSync(join(target, 'studio-catalog.json'), original);
  return { target, original };
}
function assetBinding(target, { badPath, truncatePath } = {}) {
  return { fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === badPath) return new Response('unavailable', {status:404});
    const bytes = readFileSync(join(target, path));
    if (request.method === 'HEAD') return new Response(null, {status:200});
    return new Response(path === truncatePath ? bytes.subarray(0, bytes.length - 1) : bytes);
  }};
}

test('large Studio JSON becomes bounded byte-identical shards and fits Pages budgets', () => {
  const { target, original } = fixture();
  try {
    const info = shardStudioCatalog(target, ['second','first'], {triggerBytes:1, partBytes:9});
    assert.equal(info.bytes, original.length); assert.equal(info.sha256, sha(original));
    assert(info.parts.length > 2); assert(info.parts.every((part) => part.bytes <= 9));
    const joined = Buffer.concat(info.parts.map((part) => {
      const bytes = readFileSync(join(target, part.path));
      assert.equal(sha(bytes), part.sha256); return bytes;
    }));
    assert.deepEqual(joined, original); assert(!existsSync(join(target, 'studio-catalog.json')));
    writeFileSync(join(target, '_routes.json'), JSON.stringify({include:['/*'],exclude:[]}));
    writeFileSync(join(target, '_worker.js'), 'export default {}');
    assert.equal(assertReleaseBudgets(target).pagesFiles, info.parts.length);
  } finally { rmSync(target, {recursive:true, force:true}); }
});

test('small catalogs remain unchanged and mismatched or duplicate IDs fail closed', () => {
  const { target, original } = fixture();
  try {
    assert.equal(shardStudioCatalog(target, ['first','second']), null);
    assert.deepEqual(readFileSync(join(target, 'studio-catalog.json')), original);
    assert.throws(() => shardStudioCatalog(target, ['first'], {triggerBytes:1,partBytes:10}), /match/);
    assert.deepEqual(readFileSync(join(target, 'studio-catalog.json')), original);
    assert(!existsSync(join(target, 'studio-catalog-parts')));
    writeFileSync(join(target, 'studio-catalog.json'), '[{"id":"first"},{"id":"first"}]');
    assert.throws(() => shardStudioCatalog(target, ['first','first'], {triggerBytes:1,partBytes:10}), /match/);
    assert.throws(() => shardStudioCatalog(target, [], {triggerBytes:1,partBytes:0}), /size/);
    assert.throws(() => shardStudioCatalog(target, [], {triggerBytes:1,partBytes:8 * 1024 * 1024 + 1}), /size/);
  } finally { rmSync(target, {recursive:true, force:true}); }
});

test('a final Studio shard over the provider file limit remains a hard failure', () => {
  const { target } = fixture();
  try {
    writeFileSync(join(target, '_routes.json'), JSON.stringify({include:['/*'],exclude:[]}));
    writeFileSync(join(target, '_worker.js'), 'export default {}');
    const folder = join(target, 'studio-catalog-parts', 'a'.repeat(64));
    mkdirSync(folder, {recursive:true});
    const part = join(folder, '00000.bin');
    writeFileSync(part, '');
    truncateSync(part, PAGES_MAX_FILE_BYTES + 1);
    assert.throws(() => assertReleaseBudgets(target), /Pages asset exceeds 25 MiB/);
  } finally { rmSync(target, {recursive:true, force:true}); }
});

test('legacy Studio URL streams exact JSON, supports HEAD and validators, and leaves other routes alone', async () => {
  const { target, original } = fixture();
  try {
    const info = shardStudioCatalog(target, ['first','second'], {triggerBytes:1,partBytes:9});
    const handle = createStudioCatalogHandler(info, {'X-Content-Type-Options':'nosniff'});
    const env = {ASSETS:assetBinding(target)};
    assert.equal(await handle(new Request('https://example.test/not-the-catalog'), env), null);
    const response = await handle(new Request('https://example.test/studio-catalog.json?old-tab=1'), env);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('content-length'), String(original.length));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    const head = await handle(new Request('https://example.test/studio-catalog.json', {method:'HEAD'}), env);
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(original.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const etag = response.headers.get('etag');
    const cached = await handle(new Request('https://example.test/studio-catalog.json', {headers:{'If-None-Match':etag}}), env);
    assert.equal(cached.status, 304);
    assert.equal((await handle(new Request('https://example.test/studio-catalog.json', {method:'POST'}), env)).status, 405);
  } finally { rmSync(target, {recursive:true, force:true}); }
});

test('invalid manifests, missing parts and truncated bodies fail closed', async () => {
  const { target } = fixture();
  try {
    const info = shardStudioCatalog(target, ['first','second'], {triggerBytes:1,partBytes:9});
    assert.throws(() => createStudioCatalogHandler({...info, bytes:info.bytes + 1}), /byte count/);
    assert.throws(() => createStudioCatalogHandler({...info, parts:[{...info.parts[0], path:'/other'}]}), /manifest/);
    const handle = createStudioCatalogHandler(info);
    const missing = await handle(new Request('https://example.test/studio-catalog.json'),
      {ASSETS:assetBinding(target, {badPath:info.parts[1].path})});
    assert.equal(missing.status, 503); assert.equal(missing.headers.get('cache-control'), 'no-store');
    const truncated = await handle(new Request('https://example.test/studio-catalog.json'),
      {ASSETS:assetBinding(target, {truncatePath:info.parts[1].path})});
    assert.equal(truncated.status, 200);
    await assert.rejects(truncated.arrayBuffer(), /incomplete/);
    assert.equal((await handle(new Request('https://example.test/studio-catalog.json'), {})).status, 503);
  } finally { rmSync(target, {recursive:true, force:true}); }
});
