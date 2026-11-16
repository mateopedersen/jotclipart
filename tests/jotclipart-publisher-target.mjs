import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  assertPublisherTarget,
  assertPublisherSoftware,
} from '../scripts/jotclipart/publisher-target.mjs';
import { publishReviewedCapsule } from '../scripts/catalog-snapshot/publish-content.mjs';
import { publishPresentationOnly } from '../scripts/catalog-snapshot/publish-presentation.mjs';
import { publishURLRepair } from '../scripts/catalog-snapshot/publish-url-repair.mjs';

const trusted = JSON.parse(readFileSync('config/catalog-snapshot-public.json'));
const config = { ...trusted, publicOrigin: 'https://jotclipart.com' };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const software = () => ({
  ...trusted,
  revision: 'a'.repeat(40),
  abiSHA256: 'b'.repeat(64),
  workerSHA256: 'c'.repeat(64),
  sourceInputs: {
    'trusted-public-config': digest(JSON.stringify({ ...trusted, publicKey: undefined })),
  },
});
test('publisher target requires the new production origin, explicit pointer and exact shared authority', () => {
  assert.equal(assertPublisherTarget(config), 'https://jotclipart.com');
  for (const changed of [
    undefined,
    {},
    { ...config, publicOrigin: 'https://ultraclipart.com' },
    { ...config, publicOrigin: 'https://preview.jotclipart.com' },
    { ...config, activeKey: undefined },
    { ...config, activeKey: 'catalog/active.json' },
    { ...config, bucketName: 'foreign-bucket' },
    { ...config, accountId: 'f'.repeat(32) },
    { ...config, keyId: 'foreign-key' },
    { ...config, publicKeyHex: '0'.repeat(64) },
  ])
    assert.throws(() => assertPublisherTarget(changed));
});
test('installed software must be cryptographically bound to the new namespace before any live work', () => {
  const code = software();
  assert.equal(assertPublisherSoftware(code, config), code);
  for (const changed of [
    { ...code, revision: 'old' },
    { ...code, abiSHA256: 'wrong' },
    { ...code, workerSHA256: 'wrong' },
    { ...code, bucketName: 'foreign' },
    { ...code, sourceInputs: { 'trusted-public-config': '0'.repeat(64) } },
  ])
    assert.throws(() => assertPublisherSoftware(changed, config));
  const legacy = { ...trusted };
  delete legacy.activeKey;
  assert.throws(
    () =>
      assertPublisherSoftware(
        { ...code, sourceInputs: { 'trusted-public-config': digest(JSON.stringify(legacy)) } },
        config,
      ),
    /independent new namespace/,
  );
});
test('normal content, presentation and URL publishers refuse old targets before git, file, network or staging access', async () => {
  for (const operation of [publishReviewedCapsule, publishPresentationOnly, publishURLRepair])
    for (const target of [
      {},
      { ...config, activeKey: 'catalog/active.json' },
      { ...config, publicOrigin: 'https://ultraclipart.com' },
    ])
      await assert.rejects(
        operation({
          publicConfig: target,
          software: 'does-not-exist',
          capsulePath: 'does-not-exist',
          output: 'does-not-exist',
          mode: 'prepare',
        }),
        /publisher|Publisher/,
      );
});
