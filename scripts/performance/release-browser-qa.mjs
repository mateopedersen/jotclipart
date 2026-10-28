import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const port = '4339';
const env = { ...process.env, BASE_URL: `http://127.0.0.1:${port}`, LOCAL_CDN_BRIDGE: '1' };
const server = spawn(process.execPath, ['scripts/performance/serve.mjs'], {
  cwd: root,
  env: { ...env, PORT: port, PERFORMANCE_BUILD_DIR: 'dist' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const report = {
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim(),
  startedAt: new Date().toISOString(),
  checks: [],
};
const out = resolve(root, 'reports/performance/release-browser-qa.json');
mkdirSync(resolve(root, 'reports/performance'), { recursive: true });
try {
  await new Promise((done, fail) => {
    const timeout = setTimeout(() => fail(Error('Release preview did not start')), 15000);
    server.stdout.on('data', (data) => {
      if (String(data).includes('Local production preview:')) {
        clearTimeout(timeout);
        done();
      }
    });
    server.once('error', (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timeout);
      fail(Error(`Release preview exited (${code})`));
    });
  });
  const checks = [
    ['tests/e2e/site-speed-pages.mjs', {}],
    ['tests/e2e/editor-source-loading.mjs', {}],
    ['tests/e2e/performance-regressions.mjs', {}],
    ['tests/e2e/catalog-delivery.mjs', {}],
    ['tests/e2e/studio-compositions.mjs', { UC_BROWSER: 'chromium' }],
    ['tests/e2e/studio-compositions.mjs', { UC_BROWSER: 'webkit' }],
    ['tests/e2e/studio-export-formats.mjs', { UC_BROWSER: 'chromium' }],
    ['tests/e2e/studio-export-formats.mjs', { UC_BROWSER: 'webkit' }],
  ];
  for (const [script, extra] of checks) {
    const code = await new Promise((done, fail) => {
      const child = spawn(process.execPath, [script], {
        cwd: root,
        env: { ...env, ...extra },
        stdio: 'inherit',
      });
      child.once('error', fail);
      child.once('exit', done);
    });
    report.checks.push({ script, browser: extra.UC_BROWSER ?? 'chromium,webkit', code });
    writeFileSync(out, JSON.stringify(report, null, 2));
    if (code !== 0) throw Error(`Release browser check failed: ${script}`);
  }
  report.passed = true;
} finally {
  report.completedAt = new Date().toISOString();
  writeFileSync(out, JSON.stringify(report, null, 2));
  server.kill('SIGTERM');
}
