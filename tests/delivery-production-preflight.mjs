import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRODUCTION_ACCOUNT_ID,
  pinProductionAccountEnvironment,
  verifyProductionConfig,
  verifyLiveBaseline,
} from '../scripts/delivery/production-preflight.mjs';

test('Pages account is pinned to preflight; conflicting caller values fail closed', () => {
  assert.equal(PRODUCTION_ACCOUNT_ID, '48c779c8eaa80234e0bb9d57f96e588b');
  const source = { OTHER_VARIABLE: 'retained' };
  const bound = pinProductionAccountEnvironment(source);
  assert.equal(bound.CLOUDFLARE_ACCOUNT_ID, PRODUCTION_ACCOUNT_ID);
  assert.equal(bound.OTHER_VARIABLE, 'retained');
  assert.equal(source.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.equal(
    pinProductionAccountEnvironment({ CLOUDFLARE_ACCOUNT_ID: PRODUCTION_ACCOUNT_ID })
      .CLOUDFLARE_ACCOUNT_ID,
    PRODUCTION_ACCOUNT_ID,
  );
  for (const wrong of ['f'.repeat(32), '', null])
    assert.throws(
      () => pinProductionAccountEnvironment({ CLOUDFLARE_ACCOUNT_ID: wrong }),
      /conflicts/,
    );
  for (const bad of [undefined, null, 'env', []])
    assert.throws(() => pinProductionAccountEnvironment(bad), /environment/);
});

test('a conflicting account stops the real publisher entry before its writer lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-account-lock-fixture-'));
  try {
    const noWriterPath = join(dir, 'not-a-directory');
    writeFileSync(noWriterPath, 'fixture');
    const entry = new URL('../scripts/deploy.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [entry.pathname], {
      env: { CLOUDFLARE_ACCOUNT_ID: 'f'.repeat(32), UC_R2_LOCK_ROOT: noWriterPath },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cloudflare account conflicts with the approved production account/);
    assert.doesNotMatch(result.stderr, /ENOTDIR|ENOENT/);
    assert.equal(existsSync(join(noWriterPath, '.ultraclipart-publication')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruned production release fails closed unless the account settings are safe', () => {
  const base = {
    source: { config: { production_deployments_enabled: false } },
    deployment_configs: {
      production: {
        fail_open: false,
        r2_buckets: { CATALOG_PAGES: { name: 'ultraclipart-pages' } },
      },
    },
  };
  assert.equal(verifyProductionConfig(base).productionFailClosed, true);
  const failOpen = structuredClone(base);
  failOpen.deployment_configs.production.fail_open = true;
  assert.throws(() => verifyProductionConfig(failOpen), /fail closed/);
  const automatic = structuredClone(base);
  automatic.source.config.production_deployments_enabled = true;
  assert.throws(() => verifyProductionConfig(automatic), /paused/);
  const noBucket = structuredClone(base);
  delete noBucket.deployment_configs.production.r2_buckets.CATALOG_PAGES;
  assert.throws(() => verifyProductionConfig(noBucket), /binding/);
  assert.throws(() => verifyProductionConfig({}), /paused/);
});

test('a concurrent content release or control hotfix cannot be overwritten by an older preparation', () => {
  const expected = 'a'.repeat(40),
    next = 'b'.repeat(40);
  assert.equal(
    verifyLiveBaseline({ renderedRevision: expected, controlRevision: expected }, expected)
      .liveBaselineVerified,
    expected,
  );
  for (const live of [
    { renderedRevision: next, controlRevision: next },
    { renderedRevision: expected, controlRevision: next },
    {},
    null,
  ])
    assert.throws(() => verifyLiveBaseline(live, expected), /Production changed/);
  assert.throws(() => verifyLiveBaseline({}, 'unverified'), /Invalid expected/);
  assert.equal(verifyLiveBaseline({ renderedRevision: expected, controlRevision: next }, expected, next)
    .liveControlBaselineVerified, next);
  assert.throws(() => verifyLiveBaseline({ renderedRevision: expected, controlRevision: expected }, expected, next), /Production changed/);
  assert.throws(() => verifyLiveBaseline({}, expected, 'unverified'), /Invalid expected/);
});
