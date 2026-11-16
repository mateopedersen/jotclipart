// Synthetic local packaging fixtures. This does not deploy a renderer or prove
// Cloudflare privacy/health; actual provider/readback gates remain separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyOgBuild } from '../scripts/jotclipart/og-invariants.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jotclipart-og-package-')),
    buildDirectory = 'work/release',
    directory = join(root, buildDirectory, 'og-worker');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(directory, { recursive: true });
  const put = (file, bytes) => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  const sourceNames = [
    'node_modules/@resvg/resvg-wasm/index_bg.wasm',
    'node_modules/@jsquash/webp/codec/dec/webp_dec.wasm',
    'public/brand/jotclipart-mark-3d.png',
    'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff',
    'node_modules/@fontsource/inter/files/inter-latin-700-normal.woff',
    'server/jotclipart/og-image.mjs',
    'scripts/jotclipart/og-worker-build.mjs',
    'node_modules/@resvg/resvg-wasm/package.json',
    'node_modules/@jsquash/webp/package.json',
    'node_modules/pako/package.json',
  ];
  const sourceInputs = Object.fromEntries(
    sourceNames.map((file) => {
      const bytes = Buffer.from('Private synthetic bytes ' + file);
      put(file, bytes);
      return [file, sha(bytes)];
    }),
  );
  const identity = {
    rendererSHA256: sha(
      JSON.stringify({
        schema: 2,
        inputs: Object.fromEntries(Object.entries(sourceInputs).sort()),
      }),
    ),
    logoSHA256: sourceInputs[sourceNames[2]],
    fontSHA256: [sourceInputs[sourceNames[3]], sourceInputs[sourceNames[4]]],
  };
  const name = 'jotclipart-og-' + identity.rendererSHA256.slice(0, 16),
    base = {
      name: 'jotclipart',
      pages_build_output_dir: 'dist',
      r2_buckets: [{ binding: 'CATALOG', bucket_name: 'shared-metadata' }],
      d1_databases: [{ binding: 'AI_DB', database_id: 'private-fixture-id' }],
      ai: { binding: 'AI' },
      vars: { PUBLIC_ORIGIN: 'https://jotclipart.com' },
      env: {
        preview: {
          r2_buckets: [{ binding: 'CATALOG', bucket_name: 'shared-metadata' }],
          d1_databases: [{ binding: 'AI_DB', database_id: 'private-fixture-id' }],
          ai: { binding: 'AI' },
        },
      },
    };
  put('wrangler.jsonc', JSON.stringify(base));
  const pages = structuredClone(base),
    binding = { binding: 'OG_RENDERER', service: name };
  pages.services = [binding];
  pages.env.preview.services = [binding];
  pages.pages_build_output_dir = relative(directory, join(root, 'dist'));
  const worker = {
    name,
    main: 'worker.mjs',
    compatibility_date: '2026-10-23',
    workers_dev: false,
    preview_urls: false,
    limits: { cpu_ms: 5000 },
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }],
  };
  const bodies = {
    'worker.mjs': '// Private fixture worker ' + identity.rendererSHA256,
    'resvg.wasm': readFileSync(join(root, sourceNames[0])),
    'webp.wasm': readFileSync(join(root, sourceNames[1])),
    'entry.mjs': '// Private fixture entry',
    'wrangler.json': JSON.stringify(worker),
    'wrangler.pages.json': JSON.stringify(pages),
  };
  for (const [file, bytes] of Object.entries(bodies))
    put(buildDirectory + '/og-worker/' + file, bytes);
  const report = {
    schema: 1,
    status: 'BUILT_NOT_DEPLOYED',
    name,
    identity,
    directory,
    pagesConfig: join(directory, 'wrangler.pages.json'),
    workerConfig: join(directory, 'wrangler.json'),
    sourceInputs,
    outputFiles: [],
    originalsWritten: 0,
    r2Writes: 0,
    publicRoutes: [],
    workersDev: false,
  };
  const save = () => {
    report.outputFiles = Object.keys(bodies).map((file) => {
      const bytes = readFileSync(join(directory, file));
      return { file, bytes: bytes.length, sha256: sha(bytes) };
    });
    put(buildDirectory + '/og-worker/og-worker-report.json', JSON.stringify(report));
  };
  save();
  const update = (file, value) => {
    put(buildDirectory + '/og-worker/' + file, JSON.stringify(value));
    save();
  };
  const verify = () => verifyOgBuild({ root, buildDirectory, requireIndependentSources: true });
  return { root, directory, report, worker, pages, save, put, update, verify };
}
test('OG package identity verifies exact source/output hashes and retains all original Pages bindings', (t) => {
  const f = fixture(t),
    proof = f.verify();
  assert.equal(proof.configuredWorkersDev, false);
  assert.equal(proof.configuredPreviewURLs, false);
  assert.equal(proof.productionAndPreviewServicePinned, true);
  assert.equal(proof.originalsWritten, 0);
  assert.equal(proof.providerPrivacyAndHealthVerified, false);
});
test('a rehashed config still cannot expose the renderer or add a storage/service binding', (t) => {
  for (const patch of [
    { workers_dev: true },
    { preview_urls: true },
    { routes: ['https://public.invalid/*'] },
    { route: 'https://public.invalid/*' },
    { env: { production: { workers_dev: true } } },
    { r2_buckets: [{ binding: 'MEDIA', bucket_name: 'wrong' }] },
    { d1_databases: [{ binding: 'DB', database_id: 'wrong' }] },
    { services: [{ binding: 'UNEXPECTED', service: 'wrong' }] },
  ]) {
    const f = fixture(t);
    f.update('wrangler.json', { ...f.worker, ...patch });
    assert.throws(f.verify);
  }
});
test('a rehashed service config cannot drop production/preview R2 D1 AI or target another renderer', (t) => {
  for (const change of [
    (pages) => delete pages.r2_buckets,
    (pages) => delete pages.d1_databases,
    (pages) => delete pages.ai,
    (pages) => delete pages.env.preview.d1_databases,
    (pages) => (pages.services[0].service = 'wrong-worker'),
    (pages) => (pages.env.preview.services[0].service = 'wrong-worker'),
  ]) {
    const f = fixture(t),
      pages = structuredClone(f.pages);
    change(pages);
    f.update('wrangler.pages.json', pages);
    assert.throws(f.verify, /must preserve/);
  }
});
test('wrong output bytes and dependencies resolved outside the new checkout cannot pass independence', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'worker.mjs'), 'changed bytes');
  assert.throws(f.verify);
  const other = fixture(t),
    file = 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff',
    outside = mkdtempSync(join(tmpdir(), 'jotclipart-external-og-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const bytes = readFileSync(join(other.root, file));
  writeFileSync(join(outside, 'font.woff'), bytes);
  rmSync(join(other.root, file));
  symlinkSync(join(outside, 'font.woff'), join(other.root, file));
  assert.throws(other.verify, /another checkout/);
  const escaped = fixture(t),
    output = join(escaped.directory, 'worker.mjs'),
    externalWorker = join(outside, 'worker.mjs');
  writeFileSync(externalWorker, readFileSync(output));
  rmSync(output);
  symlinkSync(externalWorker, output);
  assert.throws(escaped.verify, /real local file/);
});
