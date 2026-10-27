import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { prepareDeliveryRelease } from './delivery/activate.mjs';
import { assertReleaseBudgets } from './delivery/budgets.mjs';
import { resolve } from 'node:path';
import { readPublication } from './publication-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const env = {
  ...process.env,
  CF_PAGES: '1',
  ASTRO_TELEMETRY_DISABLED: '1',
  PAGES_WRANGLER_MAJOR_VERSION: '4',
  UC_DELIVERY_PREPARE: '1',
  // The owner activated Workers Paid on 2026-10-27. These project-scoped
  // bounds reduce transfer latency without changing the request count or proofs.
  UC_DELIVERY_ACTORS: process.env.UC_DELIVERY_ACTORS ?? '16',
  UC_DELIVERY_INVENTORY_PAGES: process.env.UC_DELIVERY_INVENTORY_PAGES ?? '4',
};
// Each release stages and verifies its own catalog before atomic activation.
// A pilot selector cannot silently change the reviewed release scope.
delete env.CATALOG_OFFLOAD_COLLECTION;
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Manual publication has the same gates as Git-driven publication. Never deploy
// a previously generated local dist: it may contain stale or unverified media.
run('scripts/restore-assets.mjs');
readPublication(root);
run('scripts/verify-social-images.mjs');
run('node_modules/astro/bin/astro.mjs', ['check']);
run('node_modules/astro/bin/astro.mjs', ['build']);
// Every artwork/editor HTML file remains with this build's asset bundle.
run('scripts/security-headers.mjs');
run(
  '--test',
  readdirSync(resolve(root, 'tests'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `tests/${name}`),
);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
run('scripts/delivery/stage.mjs', ['dist']);
const target = resolve(root, 'work/delivery', revision, `pages-release-${Date.now()}`);
const manifestPath = resolve(root, 'work/delivery', revision, 'verified-manifest.json');
const release = await prepareDeliveryRelease({
  source: resolve(root, 'dist'),
  target,
  manifestPath,
  revision,
  controlRevision: revision,
});
const budgets = assertReleaseBudgets(target);
writeFileSync(
  resolve(root, 'work/delivery', revision, 'release-budget.json'),
  JSON.stringify(budgets, null, 2) + '\n',
);
// Use the process-local pinned uploader: proactive token renewal and durable
// checkpoints. No dependency file or reviewed content is modified.
run('--require', [
  './scripts/delivery/pages-upload-preload.cjs',
  'node_modules/wrangler/wrangler-dist/cli.js',
  'pages',
  'deploy',
  target,
  '--project-name',
  'ultraclipart',
  '--branch',
  'main',
  '--commit-hash',
  revision,
]);
console.log(JSON.stringify({ prepared: release, receiptRequired: true }));
