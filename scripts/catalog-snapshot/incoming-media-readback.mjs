// Sequential pre-seal R2 verification, outside the catalog reader's shared lock.
// It uses the existing exact recovery branch: no PUT fallback, no old library scan.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageScopedFiles } from './stage-files.mjs';
import {
  isIncomingMediaPlan,
  incomingMediaFiles,
  incomingMediaStageScope,
  assertIncomingStageReceipt,
} from './incoming-media-plan.mjs';
export async function reverifyIncomingBeforeSeal({ directory, verifier }) {
  const packet = JSON.parse(readFileSync(join(directory, 'packet.json')));
  if (
    !isIncomingMediaPlan(packet.incomingMediaManifest) ||
    !incomingMediaFiles(packet.incomingMediaManifest).size
  )
    return null;
  const source = JSON.parse(readFileSync(join(directory, 'source-receipt.json'))),
    bytes = readFileSync(join(directory, 'incoming-media-stage-receipt.json')),
    receipt = JSON.parse(bytes);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    source.incomingMediaStageReceiptSHA256,
  );
  assertIncomingStageReceipt(packet, receipt, verifier);
  const fresh = await stageScopedFiles({
    ...incomingMediaStageScope(packet),
    revision: packet.revision,
    verifier: { ...verifier, bucketName: 'ultraclipart-media' },
    directory: join(directory, 'independent-incoming-media-' + Date.now()),
    reuseReceipt: receipt,
  });
  assertIncomingStageReceipt(packet, fresh, verifier);
  assert.equal(fresh.recoveryMode, 'FRESH_READ_ONLY_R2_FULL_BYTE_VERIFICATION_NO_UPLOAD');
  return fresh;
}
