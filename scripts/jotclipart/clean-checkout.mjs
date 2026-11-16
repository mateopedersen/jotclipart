// Run only after the release owner pushes and approves the exact candidate SHA.
// This never deploys, changes R2 or reuses an old checkout/node_modules directory.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRoot } from './build-root.mjs';

const [revision, destination] = process.argv.slice(2);
assert(/^[a-f0-9]{40}$/.test(revision ?? ''), 'An approved exact candidate SHA is required');
assert.equal(typeof destination, 'string', 'An explicit fresh relative work directory is required');
const target = resolve(buildRoot(destination));
assert(!existsSync(target), 'Fresh independent checkout destination must not exist');
assert.equal(process.versions.node, '24.22.2');
mkdirSync(dirname(target), { recursive: true });
const evidence = target + '-evidence';
assert(!existsSync(evidence));
mkdirSync(evidence, { mode: 0o700 });
const env = {
  ...process.env,
  PATH: dirname(process.execPath) + ':' + process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  ASTRO_TELEMETRY_DISABLED: '1',
  PLAYWRIGHT_SKIP_BROWSER_GC: '1',
  EXPECT_REVISION: revision,
  JOTCLIPART_BUILD_ROOT: 'work/jotclipart-release-' + revision.slice(0, 12),
};
for (const key of Object.keys(env))
  if (/(?:TOKEN|SECRET|PASSWORD|CLOUDFLARE|^CF_)/i.test(key)) delete env[key];
function run(name, exe, args, cwd = target) {
  const fd = openSync(join(evidence, name + '.log'), 'wx', 0o600);
  try {
    const r = spawnSync(exe, args, { cwd, env, stdio: ['ignore', fd, fd] });
    if (r.error || r.status !== 0)
      throw Error(name + ' failed; inspect private clean-checkout evidence');
  } finally {
    closeSync(fd);
  }
}
run(
  'new-github-clone',
  'git',
  [
    'clone',
    '--filter=blob:none',
    '--no-checkout',
    '--origin',
    'origin',
    'https://github.com/mateopedersen/jotclipart.git',
    target,
  ],
  process.cwd(),
);
run('exact-candidate', 'git', ['checkout', '--detach', revision]);
const pnpm = spawnSync('pnpm', ['--version'], { cwd: target, env, encoding: 'utf8' });
assert.equal(pnpm.status, 0);
assert.equal(pnpm.stdout.trim(), '11.25.0');
run('frozen-clean-install', 'pnpm', [
  'install',
  '--frozen-lockfile',
  '--store-dir',
  join(target, '.pnpm-store'),
]);
run('changed-code-format', process.execPath, ['scripts/jotclipart/ci-native.mjs', 'format']);
run('source-and-invariants', process.execPath, ['scripts/jotclipart/ci-native.mjs', 'source']);
run('independent-native-build', 'pnpm', ['build']);
run('exact-package-gates', process.execPath, ['scripts/jotclipart/ci-native.mjs', 'package']);
run('independence-proof', process.execPath, ['scripts/jotclipart/verify-independent.mjs']);
const proof = JSON.parse(
  readFileSync(join(target, 'reports/jotclipart-native-ci/independence.json')),
);
const result = {
  status: 'NEW_GITHUB_CHECKOUT_INSTALL_BUILD_VERIFIED_NOT_DEPLOYED',
  revision,
  repository: proof.repository,
  buildRoot: env.JOTCLIPART_BUILD_ROOT,
  workerSHA256: proof.workerSHA256,
  abiSHA256: proof.abiSHA256,
  sourceTests: JSON.parse(readFileSync(join(target, 'reports/jotclipart-native-ci/source.json')))
    .invariants.tests,
  liveDeploymentVerified: false,
  at: new Date().toISOString(),
};
writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', {
  mode: 0o600,
});
console.log(JSON.stringify(result));
