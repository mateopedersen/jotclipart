import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const native = readFileSync('.github/workflows/jotclipart-native.yml', 'utf8');
const legacy = readFileSync('.github/workflows/ci.yml', 'utf8');
test('legacy static checks are preserved on their explicit backend, while native CI is automatic', () => {
  const scripts = JSON.parse(readFileSync('package.json')).scripts;
  assert.equal(scripts['test:release'], 'node scripts/jotclipart/ci-native.mjs release');
  assert.equal(
    scripts['test:release:legacy'],
    'node --test --test-concurrency=2 tests/catalog.mjs tests/csp.mjs tests/publication.mjs tests/retired-routes.mjs',
  );
  const events = legacy.slice(legacy.indexOf('\non:') + 4, legacy.indexOf('\npermissions:'));
  assert.match(events, /workflow_dispatch:/);
  assert.doesNotMatch(events, /push:|pull_request:/);
  assert.equal((legacy.match(/- run: pnpm build:legacy-static\n/g) ?? []).length, 3);
  assert.match(native, /push:\n\s+branches: \[main, 'migration\/\*\*'\]/);
  assert.match(native, /pull_request:/);
  assert.match(native, /contents: read/);
  assert.doesNotMatch(native, /contents: write|secrets\.|CLOUDFLARE_API_TOKEN|GH_TOKEN/);
});
test('every engine and viewport runs actual core and full feature flows after a matching preview pin', () => {
  assert.match(native, /engine: \[chromium, firefox, webkit\]/);
  assert.match(native, /width: \[320, 390, 768, 1440\]/);
  assert.match(native, /max-parallel: 3/);
  assert.match(native, /fail-fast: false/);
  assert.match(
    native,
    /image: mcr\.microsoft\.com\/playwright:v1\.64\.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea/,
  );
  assert.match(native, /native-browser:\n\s+needs: preview-pin/);
  assert.match(native, /PLAYWRIGHT_SKIP_BROWSER_GC: '1'/);
  assert.match(native, /id: basic\n\s+run: node scripts\/jotclipart\/ci-browser\.mjs browser/);
  assert.match(
    native,
    /if: \$\{\{ !cancelled\(\) && steps\.basic\.outcome != 'skipped' \}\}\n\s+run: node scripts\/jotclipart\/feature-browser\.mjs/,
  );
  for (const command of [
    'node scripts/jotclipart/ci-browser.mjs browser',
    'node scripts/jotclipart/feature-browser.mjs',
  ])
    assert.equal(native.split('run: ' + command + '\n').length - 1, 1);
  assert(
    native.indexOf('run: node scripts/jotclipart/ci-browser.mjs browser') <
      native.indexOf('run: node scripts/jotclipart/feature-browser.mjs'),
  );
  for (const command of [
    'node scripts/jotclipart/ci-native.mjs format',
    'node scripts/jotclipart/ci-native.mjs source',
    'pnpm build',
    'node scripts/jotclipart/ci-native.mjs package',
    'node scripts/jotclipart/verify-independent.mjs',
    'python -m unittest discover',
  ])
    assert(native.includes('run: ' + command));
});
test('native final release fails for every failed, cancelled or skipped mandatory stage', () => {
  const block = native.slice(native.indexOf('\n  native-release:'));
  assert.match(block, /needs: \[native-source-and-package, art, preview-pin, native-browser\]/);
  const script = block
    .split('run: |\n')[1]
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .join('\n');
  const results = ['success', 'failure', 'cancelled', 'skipped'];
  for (const source of results)
    for (const art of results)
      for (const preview of results)
        for (const browser of results) {
          const result = spawnSync('bash', ['-e', '-c', script], {
            env: {
              ...process.env,
              SOURCE_RESULT: source,
              ART_RESULT: art,
              PREVIEW_RESULT: preview,
              BROWSER_RESULT: browser,
            },
          });
          assert.equal(
            result.status === 0,
            [source, art, preview, browser].every((value) => value === 'success'),
          );
        }
});
