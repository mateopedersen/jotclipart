import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readIndexNowPolicy(root = resolve(import.meta.dirname, '../..')) {
  return JSON.parse(readFileSync(resolve(root, 'config/indexnow.json'), 'utf8'));
}

export function indexNowSubmissionEnabled(policy) {
  return (
    policy?.submissionEnabled === true && policy.submissionStatus !== 'OWNER_DEFERRED_2026_11_16'
  );
}

export function assertIndexNowSubmissionEnabled(policy) {
  if (!indexNowSubmissionEnabled(policy))
    throw Error(
      'OWNER_DEFERRED_2026_11_16: JotClipart search submissions are disabled; no sender or ledger update is allowed',
    );
}
