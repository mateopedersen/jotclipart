import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildRoot } from './build-root.mjs';
import { acquireAccountWriter } from '../delivery/account-lock.mjs';
import { verifyOgBuild } from './og-invariants.mjs';

const environment = process.argv[2];
if (!['preview', 'production'].includes(environment))
  throw Error('Choose preview or production explicitly');
execFileSync('git', ['diff', '--quiet']);
execFileSync('git', ['diff', '--cached', '--quiet']);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const config = JSON.parse(readFileSync('config/catalog-snapshot-public.json'));
const report = JSON.parse(readFileSync(buildRoot() + '/package-report.json'));
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const distribution = resolve('dist');
if (
  config.accountId !== '48c779c8eaa80234e0bb9d57f96e588b' ||
  config.activeKey !== 'catalog/jotclipart/active.json' ||
  report.sourceRevision !== revision
)
  throw Error('Independent project, namespace and committed build required');
for (const item of report.inventory) {
  const b = readFileSync('dist/' + item.path);
  if (b.length !== item.bytes || createHash('sha256').update(b).digest('hex') !== item.sha256)
    throw Error('Build changed after verification');
}
if (!report.ogWorker?.workerConfig || !report.ogWorker?.pagesConfig)
  throw Error('Pinned OG binding and private renderer artifact required');
for (const asset of report.ogWorker.outputFiles) {
  const b = readFileSync(report.ogWorker.directory + '/' + asset.file);
  if (b.length !== asset.bytes || createHash('sha256').update(b).digest('hex') !== asset.sha256)
    throw Error('OG worker changed after build');
}
verifyOgBuild({ buildDirectory: buildRoot(), requireIndependentSources: true });
mkdirSync('work/jotclipart-deployment', { recursive: true });
const releaseAccountWriter = acquireAccountWriter();
try {
  const ogOutput = execFileSync(
    process.execPath,
    [wrangler, 'deploy', '--config', report.ogWorker.workerConfig],
    {
      encoding: 'utf8',
      maxBuffer: 2000000,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.accountId },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  writeFileSync('work/jotclipart-deployment/' + environment + '-og.log', ogOutput, { mode: 0o600 });
  const output = execFileSync(
    process.execPath,
    [
      wrangler,
      'pages',
      'deploy',
      distribution,
      '--project-name',
      'jotclipart',
      '--branch',
      environment === 'production' ? 'main' : 'migration-preview',
      '--commit-hash',
      revision,
      '--commit-message',
      'JotClipart independent native software ' + revision,
      '--commit-dirty=false',
    ],
    {
      encoding: 'utf8',
      cwd: report.ogWorker.directory,
      maxBuffer: 2000000,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.accountId },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  writeFileSync('work/jotclipart-deployment/' + environment + '.log', output, { mode: 0o600 });
  const urls = [...output.matchAll(/https:\/\/[a-z0-9-]+\.jotclipart\.pages\.dev\/?/g)].map(
    (m) => m[0],
  );
  if (!urls.length)
    throw Error(
      'Deployment command returned no independent project URL; inspect private log before retrying',
    );
  const result = {
    status: 'DEPLOYED_AWAITING_LIVE_VERIFICATION',
    environment,
    revision,
    project: 'jotclipart',
    ogWorker: report.ogWorker.name,
    ogRendererSHA256: report.ogWorker.identity.rendererSHA256,
    accountId: config.accountId,
    activeKey: config.activeKey,
    url: urls.at(-1),
    staticFiles: report.staticFiles,
    at: new Date().toISOString(),
  };
  writeFileSync(
    'work/jotclipart-deployment/' + environment + '.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  releaseAccountWriter();
}
