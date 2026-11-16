import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brand } from '../../src/lib/brand.mjs';
import { createHash } from 'node:crypto';

const trusted = JSON.parse(
  readFileSync(new URL('../../config/catalog-snapshot-public.json', import.meta.url)),
);

/** Validate before a publisher can read live control state or stage any bytes. */
export function assertPublisherTarget(config) {
  assert(config && config.schema === 1, 'Explicit JotClipart publisher configuration required');
  assert.equal(config.publicOrigin, brand.origin, 'Publisher must target JotClipart production');
  assert.equal(
    config.activeKey,
    'catalog/jotclipart/active.json',
    'Publisher namespace must be explicit',
  );
  for (const key of ['accountId', 'bucketName', 'keyId', 'publicKeyHex'])
    assert.equal(config[key], trusted[key], 'Publisher authority differs: ' + key);
  return config.publicOrigin;
}

export function publisherRuntimeIdentity(code) {
  assert(/^[a-f0-9]{40}$/.test(code?.revision ?? ''), 'Installed software revision required');
  assert(/^[a-f0-9]{64}$/.test(code?.abiSHA256 ?? ''), 'Installed software ABI required');
  assert(/^[a-f0-9]{64}$/.test(code?.workerSHA256 ?? ''), 'Installed Worker hash required');
  return { revision: code.revision, abiSHA256: code.abiSHA256, workerSHA256: code.workerSHA256 };
}

export function assertPublisherSoftware(code, config) {
  assertPublisherTarget(config);
  publisherRuntimeIdentity(code);
  for (const key of ['accountId', 'bucketName', 'keyId', 'publicKeyHex'])
    assert.equal(code[key], config[key], 'Installed publisher authority differs: ' + key);
  const expected = createHash('sha256')
    .update(JSON.stringify({ ...trusted, publicKey: undefined }))
    .digest('hex');
  assert.equal(
    code.sourceInputs?.['trusted-public-config'],
    expected,
    'Installed publisher software is not bound to the independent new namespace',
  );
  return code;
}
