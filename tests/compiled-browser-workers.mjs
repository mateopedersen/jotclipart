import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { clientWorkers } from '../scripts/catalog-snapshot/compilers/client-workers.mjs';

test('native client compiler emits all three real source-bound worker programs', async () => {
  const outdir = mkdtempSync(join(tmpdir(), 'uc-worker-contract-'));
  try {
    const revision = 'a'.repeat(40), workers = clientWorkers({ root: process.cwd(), outdir, revision });
    const result = await build({ entryPoints: ['src/scripts/category-directory.ts',
      'src/editor/smart/processor.ts', 'src/ai/client.ts'], outdir, bundle: true,
      format: 'esm', platform: 'browser', write: false, metafile: true,
      loader: { '.wasm': 'file' }, plugins: [workers.plugin], logLevel: 'silent' });
    const files = workers.merge(result.metafile);
    assert.equal(files.length, 3);
    for (const file of files) {
      assert.match(file, /worker-[a-f0-9]{24}\.js$/);
      const bytes = readFileSync(file);
      assert(bytes.length > 0);
      assert(file.endsWith('worker-' + createHash('sha256').update(bytes).digest('hex').slice(0, 24) + '.js'));
      assert(bytes.toString().includes('postMessage'));
    }
    const scripts = result.outputFiles.filter(file => file.path.endsWith('.js')).map(file => file.text).join('\n');
    const workerUrls = [...scripts.matchAll(/new Worker\(new URL\("([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(workerUrls).size, 3);
    assert(workerUrls.every(url => url.startsWith('/__ssr-client/' + revision + '/worker-')));
    assert(!/new Worker\(new URL\(['"][^'"]+\.ts/.test(scripts));
    for (const file of files) assert(scripts.includes('/__ssr-client/' + revision + '/' + file.split('/').at(-1)));
  } finally { rmSync(outdir, { recursive: true, force: true }); }
});
