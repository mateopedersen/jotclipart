import { validateVerificationReceipt } from '../delivery/verification-batch.mjs';

// This is only permission to use the fresh read-only verification path.
// No historical receipt substitutes for current R2 or public CDN byte checks.
export function assertReusableIncomingReceipt(receipt, records, root, verifier) {
  if (receipt?.status !== 'EXACT_INCOMING_FILES_REMOTE_BYTES_SHA_MIME_VERIFIED' ||
      receipt.root !== root || receipt.accountId !== verifier.accountId ||
      receipt.bucket !== verifier.bucketName ||
      receipt.bytes !== records.reduce((n, r) => n + r.bytes, 0))
    throw Error('Prior incoming receipt does not match this exact media scope');
  validateVerificationReceipt(
    { root: receipt.root, verified: receipt.files },
    records.map((record) => ({ record })), root,
  );
}
