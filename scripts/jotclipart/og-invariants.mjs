import assert from 'node:assert/strict';
import { readFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Exact local build/config proof. Provider privacy/health is a separate gate. */
export function verifyOgBuild({
  root = process.cwd(),
  buildDirectory,
  requireIndependentSources = false,
}) {
  root = realpathSync(root);
  const directory = realpathSync(resolve(root, buildDirectory, 'og-worker'));
  assert(directory.startsWith(root + sep));
  for (const name of ['wrangler.json', 'wrangler.toml'])
    assert(
      !existsSync(join(directory, name)),
      'A competing default Wrangler config could shadow the reviewed Pages configuration',
    );
  const reportPath = join(directory, 'og-worker-report.json'),
    report = JSON.parse(readFileSync(reportPath));
  assert(lstatSync(reportPath).isFile() && !lstatSync(reportPath).isSymbolicLink());
  assert.equal(report.schema, 1);
  assert.equal(report.status, 'BUILT_NOT_DEPLOYED');
  assert.equal(realpathSync(report.directory), directory);
  const rendererSHA = sha(
    Buffer.from(
      JSON.stringify({
        schema: 2,
        inputs: Object.fromEntries(Object.entries(report.sourceInputs).sort()),
      }),
    ),
  );
  assert.equal(report.identity.rendererSHA256, rendererSHA);
  assert.equal(report.name, 'jotclipart-og-' + rendererSHA.slice(0, 16));
  for (const file of [
    'server/jotclipart/og-image.mjs',
    'scripts/jotclipart/og-worker-build.mjs',
    'node_modules/@resvg/resvg-wasm/package.json',
    'node_modules/@jsquash/webp/package.json',
    'node_modules/pako/package.json',
  ])
    assert(
      /^[a-f0-9]{64}$/.test(report.sourceInputs[file] ?? ''),
      'OG renderer source coverage is incomplete',
    );
  for (const [file, digest] of Object.entries(report.sourceInputs)) {
    assert(/^[a-f0-9]{64}$/.test(digest));
    const absolute = realpathSync(resolve(root, file));
    if (requireIndependentSources)
      assert(absolute.startsWith(root + sep), 'OG input depends on another checkout: ' + file);
    assert.equal(sha(readFileSync(absolute)), digest, 'OG source bytes changed: ' + file);
  }
  const files = new Map();
  for (const file of report.outputFiles) {
    assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(file.file));
    assert(!files.has(file.file));
    const path = join(directory, file.file),
      stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'OG output must be a real local file');
    assert.equal(realpathSync(path), path);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, file.bytes);
    assert.equal(sha(bytes), file.sha256);
    files.set(file.file, file);
  }
  assert.deepEqual(
    [...files.keys()].sort(),
    [
      'worker.mjs',
      'resvg.wasm',
      'webp.wasm',
      'entry.mjs',
      'wrangler.worker.json',
      'wrangler.jsonc',
    ].sort(),
  );
  assert.equal(
    files.get('resvg.wasm').sha256,
    report.sourceInputs['node_modules/@resvg/resvg-wasm/index_bg.wasm'],
  );
  assert.equal(
    files.get('webp.wasm').sha256,
    report.sourceInputs['node_modules/@jsquash/webp/codec/dec/webp_dec.wasm'],
  );
  assert.equal(
    report.identity.logoSHA256,
    report.sourceInputs['public/brand/jotclipart-mark-3d.png'],
  );
  assert.deepEqual(report.identity.fontSHA256, [
    report.sourceInputs['node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'],
    report.sourceInputs['node_modules/@fontsource/inter/files/inter-latin-700-normal.woff'],
  ]);
  assert.equal(realpathSync(report.workerConfig), join(directory, 'wrangler.worker.json'));
  const worker = JSON.parse(readFileSync(join(directory, 'wrangler.worker.json')));
  assert.deepEqual(
    worker,
    {
      name: report.name,
      main: 'worker.mjs',
      compatibility_date: '2026-10-23',
      workers_dev: false,
      preview_urls: false,
      limits: { cpu_ms: 5000 },
      rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }],
    },
    'Private renderer must retain the exact reviewed configuration without any routes or bindings',
  );
  assert.equal(report.originalsWritten, 0);
  assert.equal(report.r2Writes, 0);
  assert.equal(report.workersDev, false);
  assert.deepEqual(report.publicRoutes, []);
  const original = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'))),
    binding = { binding: 'OG_RENDERER', service: report.name };
  const expected = structuredClone(original);
  expected.services = [
    ...(expected.services ?? []).filter((b) => b.binding !== 'OG_RENDERER'),
    binding,
  ];
  expected.env.preview.services = [
    ...(expected.env.preview.services ?? []).filter((b) => b.binding !== 'OG_RENDERER'),
    binding,
  ];
  expected.pages_build_output_dir = relative(directory, resolve(root, 'dist')).split(sep).join('/');
  assert.equal(realpathSync(report.pagesConfig), join(directory, 'wrangler.jsonc'));
  assert.deepEqual(
    JSON.parse(readFileSync(report.pagesConfig)),
    expected,
    'OG service binding must preserve every existing Pages R2/D1/AI/variable setting',
  );
  return {
    status: 'LOCAL_OG_BYTES_IDENTITY_AND_PRIVATE_CONFIGURATION_VERIFIED',
    name: report.name,
    rendererSHA256: rendererSHA,
    workerSHA256: files.get('worker.mjs').sha256,
    wasmSHA256: { resvg: files.get('resvg.wasm').sha256, webp: files.get('webp.wasm').sha256 },
    sourceFiles: Object.keys(report.sourceInputs).length,
    outputFiles: files.size,
    configuredWorkersDev: false,
    configuredPreviewURLs: false,
    configuredRoutes: 0,
    configuredStorageBindings: 0,
    productionAndPreviewServicePinned: true,
    originalsWritten: 0,
    providerPrivacyAndHealthVerified: false,
  };
}
