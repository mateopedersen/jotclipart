import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProductionConfig } from '../scripts/delivery/production-preflight.mjs';

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
