// Synthetic credentials only; no network, login or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runURLRepairCLI } from '../../scripts/catalog-snapshot/publish-url-repair.mjs';

async function fixture(operate) {
  const directory = mkdtempSync(join(tmpdir(), 'uc-url-auth-'));
  const previous = Object.fromEntries(['CLOUDFLARE_API_TOKEN', 'WRANGLER_AUTH_FILE'].map(k => [k, process.env[k]]));
  try {
    delete process.env.CLOUDFLARE_API_TOKEN;
    process.env.WRANGLER_AUTH_FILE = join(directory, 'auth.toml');
    writeFileSync(join(directory, 'config.json'), '{}');
    const save = (token, expiry = Date.now() + 3600000) => writeFileSync(
      process.env.WRANGLER_AUTH_FILE,
      `oauth_token = "${token}"\nexpiration_time = "${new Date(expiry).toISOString()}"\n`,
      { mode: 0o600 },
    );
    const invoke = publish => runURLRepairCLI({
      argv: ['prepare', directory, join(directory, 'config.json'), join(directory, 'output')], publish,
    });
    await operate({ save, invoke });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

test('URL repair preserves renewable OAuth credentials across long-running child sessions', async () => {
  await fixture(async ({ save, invoke }) => {
    save('synthetic-before-renewal');
    const result = await invoke(async () => {
      assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
      // Model Wrangler updating its saved access token after a preview renewal.
      save('synthetic-after-renewal');
      const module = resolve('scripts/r2/cloudflare-api.mjs');
      const child = execFileSync(process.execPath, ['--input-type=module', '-e',
        `import {configuredToken} from ${JSON.stringify(module)};process.stdout.write(configuredToken());`],
      { env: { ...process.env }, encoding: 'utf8' });
      assert.equal(child, 'synthetic-after-renewal');
      return { status: 'fixture-complete' };
    });
    assert.equal(result.status, 'fixture-complete');
    assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
  });
});

test('URL repair retains an explicitly configured API token without requiring OAuth', async () => {
  await fixture(async ({ invoke }) => {
    process.env.CLOUDFLARE_API_TOKEN = 'synthetic-explicit-api-token';
    await invoke(async () => {
      assert.equal(process.env.CLOUDFLARE_API_TOKEN, 'synthetic-explicit-api-token');
      return {};
    });
  });
});

test('URL repair rejects expired OAuth before starting preparation', async () => {
  await fixture(async ({ save, invoke }) => {
    save('synthetic-expired-token', Date.now() - 1000);
    let called = false;
    await assert.rejects(invoke(async () => { called = true; }), /expires soon/);
    assert.equal(called, false);
    assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
  });
});
