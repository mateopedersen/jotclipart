import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { buildRoot } from './build-root.mjs';
import { verifyOgBuild } from './og-invariants.mjs';
import { verifyEditorPreviewBuild } from './editor-preview-invariants.mjs';

const root = realpathSync(process.cwd());
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const revision = process.env.EXPECT_REVISION ?? process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD');
assert(/^[a-f0-9]{40}$/.test(revision));
assert.equal(git('rev-parse', 'HEAD'), revision);
assert(
  /^https:\/\/github\.com\/mateopedersen\/jotclipart(?:\.git)?$/.test(
    git('remote', 'get-url', 'origin'),
  ),
  'The origin must be the independent new GitHub repository',
);
assert.deepEqual(git('remote').split('\n'), ['origin'], 'No old repository remote may be required');
assert.equal(
  realpathSync(resolve(git('rev-parse', '--git-common-dir'))),
  join(root, '.git'),
  'Use a real independent clone, not an old linked worktree',
);
assert(
  !existsSync(join(root, '.git/objects/info/alternates')),
  'Git object alternates are forbidden',
);
assert(!existsSync('.gitmodules'), 'Unreviewed external submodules are forbidden');
assert.equal(
  git('status', '--porcelain', '--untracked-files=no'),
  '',
  'Tracked source changed during clean build',
);
const tracked = execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
assert(
  !tracked.some((line) => line.startsWith('120000 ')),
  'Tracked source symlinks are forbidden',
);
const pkg = JSON.parse(readFileSync('package.json'));
assert.equal(process.versions.node, '24.22.2');
assert.equal(pkg.packageManager, 'pnpm@11.25.0');
for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies])
  for (const value of Object.values(deps ?? {}))
    assert(
      !/^(?:file:|link:|workspace:|\.{1,2}\/|\/)/.test(value),
      'Local dependency escaped the new repository',
    );
const code = JSON.parse(readFileSync(join(buildRoot(), 'runtime/software-report.json')));
const pack = JSON.parse(readFileSync(join(buildRoot(), 'package-report.json')));
const og = verifyOgBuild({ root, buildDirectory: buildRoot(), requireIndependentSources: true });
const editorPreviews = verifyEditorPreviewBuild({ root, buildDirectory: buildRoot() });
assert.equal(code.revision, revision);
assert.equal(pack.sourceRevision, revision);
let sourceFiles = 0;
for (const [file, digest] of Object.entries(code.sourceInputs)) {
  if (['trusted-public-config', 'http-policy'].includes(file)) continue;
  const absolute = realpathSync(resolve(file));
  assert(absolute.startsWith(root + sep), 'Compiled input depends on another checkout: ' + file);
  assert.equal(sha(readFileSync(absolute)), digest, 'Compiled input changed');
  sourceFiles++;
}
for (const asset of code.clientAssets) {
  assert(realpathSync(resolve(asset.file)).startsWith(root + sep));
  const bytes = readFileSync(asset.file);
  assert.equal(bytes.length, asset.bytes);
  assert.equal(sha(bytes), asset.sha256);
}
assert.equal(sha(readFileSync(join(buildRoot(), 'runtime/worker.mjs'))), code.workerSHA256);
assert.equal(pack.mediaFilesCopied, 0);
assert.equal(pack.fullCatalogPagesBuilt, 0);
for (const entry of pack.inventory) {
  assert(!/^catalog\//.test(entry.path), 'Original archive must remain in the shared R2 bucket');
  const bytes = readFileSync(join('dist', entry.path));
  assert.equal(bytes.length, entry.bytes);
  assert.equal(sha(bytes), entry.sha256);
}
const report = {
  status: 'NEW_REPOSITORY_CLEAN_BUILD_INDEPENDENCE_VERIFIED',
  at: new Date().toISOString(),
  repository: 'https://github.com/mateopedersen/jotclipart',
  revision,
  node: process.versions.node,
  pnpm: pkg.packageManager,
  lockSHA256: sha(readFileSync('pnpm-lock.yaml')),
  compiledSourceFiles: sourceFiles,
  clientAssets: code.clientAssets.length,
  workerSHA256: code.workerSHA256,
  abiSHA256: code.abiSHA256,
  staticFiles: pack.staticFiles,
  oldRepositoryRemotes: 0,
  gitAlternates: 0,
  externalCompiledInputs: 0,
  originalsCopied: 0,
  og,
  editorPreviews,
  liveDeploymentVerified: false,
};
mkdirSync('reports/jotclipart-native-ci', { recursive: true });
writeFileSync(
  'reports/jotclipart-native-ci/independence.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report));
