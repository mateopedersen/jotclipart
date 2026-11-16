import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const phase = process.argv[2] ?? 'source';
if (!['source', 'package', 'format'].includes(phase))
  throw Error('Choose source, package or format');
const out = resolve('reports/jotclipart-native-ci');
mkdirSync(out, { recursive: true });
const report = {
  phase,
  startedAt: new Date().toISOString(),
  node: process.versions.node,
  checks: [],
  status: 'RUNNING',
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
function command(name, args) {
  const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    }),
    log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(out, name + '.log'), log);
  if (result.error || result.status !== 0) {
    process.stderr.write(log.slice(-16000));
    throw Error(name + ' failed; inspect the saved CI log');
  }
  report.checks.push({ name, status: 'PASS', log: name + '.log' });
  return log;
}
try {
  if (process.versions.node !== '24.22.2') throw Error('This source is pinned to Node 24.22.2');
  const pkg = JSON.parse(readFileSync('package.json'));
  if (pkg.packageManager !== 'pnpm@11.25.0') throw Error('Package manager pin changed');
  if (phase === 'format') {
    const base = '8e64574778082302cf4332a4eea9a7f4dc9bfc64';
    execFileSync('git', ['cat-file', '-e', base + '^{commit}']);
    const files = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(
        (f) =>
          f &&
          existsSync(f) &&
          /^(?:src\/|server\/|scripts\/|tests\/|\.github\/workflows\/|astro\.config\.mjs$|package\.json$)/.test(
            f,
          ) &&
          /\.(?:mjs|cjs|js|ts|astro|css|yml|yaml|json)$/.test(f) &&
          !f.startsWith('tests/fixtures/'),
      );
    if (files.length)
      command('changed-code-format', [
        'node_modules/prettier/bin/prettier.cjs',
        '--check',
        ...files,
      ]);
    report.formatScope = { base, files };
  }
  if (phase === 'source') {
    command('source-catalog-policy', ['scripts/seo/check-catalog.mjs']);
    command('signed-social-source-policy', ['scripts/verify-social-images.mjs']);
    const snapshot = readdirSync('tests/catalog-snapshot')
      .filter((f) => f.endsWith('.mjs'))
      .sort()
      .map((f) => 'tests/catalog-snapshot/' + f);
    if (snapshot.length < 18) throw Error('Required snapshot adversarial test files missing');
    const required = [
      'catalog-content-operator',
      'catalog-delta-source',
      'catalog-delta-store',
      'catalog-private-publisher',
      'collection-prose-delta',
      'jotclipart-live-adapters',
      'planned-incoming-media',
      'catalog-private-reader',
      'catalog-private-installer',
      'catalog-remote-reader',
      'catalog-remote-reader-window',
      'catalog-native-cache-admission',
      'catalog-seal-cache-admission',
      'catalog-metadata-cache',
    ];
    const extra = [
      'r2-binding-media',
      'catalog-stage-manifest',
      'catalog-response-policy',
      'catalog-inline-policy',
      'catalog-scoped-context',
      'catalog-worker-request-isolation',
      'catalog-protocol',
      'snapshot-search-transport',
      'snapshot-pinned-search',
      'catalog-snapshot-api',
      'catalog-snapshot-client',
      'catalog-software-asset-cache',
      'catalog-edge-metadata',
      'catalog-json-compression',
      'catalog-module-preloads',
      'catalog-render-single-flight',
      'catalog-static-navigation-scriptless',
      'verified-fetch',
      'social-images',
      'jotclipart-brand',
      'page-seo',
    ];
    const tests = [
      ...snapshot,
      ...required.map((n) => 'tests/' + n + '.mjs'),
      ...extra.map((n) => 'tests/' + n + '.mjs'),
    ];
    for (const file of tests)
      if (!existsSync(file)) throw Error('Required native invariant missing: ' + file);
    const tap = command('native-invariants', [
      '--import',
      './scripts/catalog-snapshot/register-ts.mjs',
      '--test',
      '--test-concurrency=2',
      '--test-reporter=tap',
      ...tests,
    ]);
    const count = Number([...tap.matchAll(/^# tests (\d+)$/gm)].at(-1)?.[1]),
      failed = Number([...tap.matchAll(/^# fail (\d+)$/gm)].at(-1)?.[1]),
      skipped = Number([...tap.matchAll(/^# skipped (\d+)$/gm)].at(-1)?.[1]);
    if (!(count >= 162) || failed !== 0 || skipped !== 0)
      throw Error('The mandatory invariant aggregate is incomplete, failed or skipped');
    report.invariants = {
      files: tests,
      tests: count,
      failed,
      skipped,
      snapshotFiles: snapshot.length,
      fixtureScope: true,
      freshProductionReadbackClaim: false,
    };
    const pin = JSON.parse(readFileSync('config/jotclipart-migration-baseline.json'));
    const bytes = readFileSync('config/' + pin.file);
    if (bytes.length !== pin.bytes || sha(bytes) !== pin.sha256)
      throw Error('Public baseline artifact pin changed');
    const rows = gunzipSync(bytes)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (rows.length !== pin.artworks || new Set(rows.map((r) => r.id)).size !== rows.length)
      throw Error('Public baseline identity coverage differs');
    for (const r of rows) {
      if (
        !r.published ||
        !r.indexable ||
        !/^\/art\/[a-z0-9-]+\/$/.test(r.canonicalPath) ||
        !r.displayTitle.startsWith('Free ') ||
        /^Free Free /i.test(r.displayTitle)
      )
        throw Error('Invalid baseline source identity or derived title');
    }
    report.baseline = {
      root: pin.sourceRoot,
      sha256: pin.sha256,
      artworks: rows.length,
      privateFieldsIncluded: false,
    };
  }
  if (phase === 'package')
    command('exact-built-package', [
      '--test',
      'tests/jotclipart-brand.mjs',
      'tests/jotclipart-release.mjs',
    ]);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = error.message;
  process.exitCode = 1;
}
report.completedAt = new Date().toISOString();
writeFileSync(join(out, phase + '.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
