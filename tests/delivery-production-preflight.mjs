import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyProductionConfig,
  verifyLiveBaseline,
} from '../scripts/delivery/production-preflight.mjs';

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
