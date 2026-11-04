import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withPrivateCatalogSession } from './operator-session.mjs';
export async function activateCatalogContent({ directory, sealed, verifier }) {
  directory = resolve(directory);
  const job = {
    mode: 'VERIFIED_CONTENT_DELTA_ACTIVATION',
    parentSnapshotSHA256: sealed.snapshot.authorization.parentSnapshotSHA256,
    snapshot: sealed.snapshot,
    snapshotSHA256: sealed.snapshotSHA256,
    verifier,
  };
  return withPrivateCatalogSession(
    { directory: join(directory, 'activate-session'), kind: 'publisher', job },
    async ({ secret }) => {
      const command = {
          action: 'activate-verified-catalog-delta',
          snapshotSHA256: job.snapshotSHA256,
          parentSnapshotSHA256: job.parentSnapshotSHA256,
          accountId: verifier.accountId,
          bucket: verifier.bucketName,
          at: Date.now() - 1000,
        },
        signature = createHmac('sha256', Buffer.from(secret, 'hex'))
          .update(JSON.stringify(command))
          .digest('hex'),
        r = await fetch('http://127.0.0.1:8899/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command, signature }),
          signal: AbortSignal.timeout(90000),
        });
      if (!r.ok) throw Error('Conditional catalog activation HTTP ' + r.status);
      const result = await r.json();
      if (
        !['VERIFIED_CONTENT_DELTA_POINTER_ACTIVE', 'EXACT_DELTA_ALREADY_ACTIVE'].includes(
          result.status,
        ) ||
        result.snapshotSHA256 !== sealed.snapshotSHA256 ||
        result.verifiedRoot !== sealed.verifiedRoot
      )
        throw Error('Activation readback differs');
      writeFileSync(
        join(directory, 'activation-receipt.json'),
        JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2),
      );
      return result;
    },
  );
}
