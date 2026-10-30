import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Only release-independent assets are probed. HTML keeps its existing exact
// revision prefix and follows the normal, freshly reserved write path.
export function splitVerificationPhase(records, revision) {
  const existingCandidates = [],
    writes = [];
  for (const row of records) {
    if (
      row.record.path.startsWith('/previews/p1/') ||
      row.record.path.startsWith('/_astro/') ||
      (revision &&
        /^delivery\/[a-f0-9]{40}\/(art|edit)\//.test(row.record.key) &&
        !row.record.key.startsWith(`delivery/${revision}/`))
    )
      existingCandidates.push(row);
    else writes.push(row);
  }
  return { existingCandidates, writes };
}

export function validateVerificationReceipt(result, batch, root, allowMissing = false) {
  if (
    result?.root !== root ||
    !Array.isArray(result.verified) ||
    (allowMissing && !Array.isArray(result.missing))
  )
    throw Error('Invalid verification receipt');
  const expected = new Map(batch.map(({ record }) => [record.path, record]));
  if (expected.size !== batch.length) throw Error('Duplicate verification source');
  const seen = new Set();
  for (const row of [...result.verified, ...(allowMissing ? result.missing : [])]) {
    const record = expected.get(row?.path);
    if (
      !record ||
      seen.has(row.path) ||
      row.key !== record.key ||
      row.bytes !== record.bytes ||
      row.sha256 !== record.sha256
    )
      throw Error('Remote verification receipt differs');
    seen.add(row.path);
  }
  if (seen.size !== expected.size) throw Error('Incomplete verification receipt');
  return result;
}

// This endpoint can GET and hash existing objects, but cannot PUT, delete, fetch
// a public source or grant a storage lease. A missing object needs normal staging.
export async function verifyExistingBatch(
  batch,
  { root, accountId, bucket, secret, fetcher = fetch, now = Date.now, wait = delay },
) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const command = { action: 'verify', root, accountId, bucket, at: now() };
    const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(JSON.stringify(command))
      .digest('hex');
    try {
      const response = await fetcher('http://127.0.0.1:8899/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, signature, records: batch }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = Error(`Read-only verification refused: ${response.status}`);
        // Corrupt bytes, bad proofs and invalid scope must stop, never silently
        // fall through to overwriting or treating a failure as a missing object.
        error.permanent = ![408, 409, 429, 500, 502, 503, 504].includes(response.status);
        throw error;
      }
      const result = await response.json();
      return validateVerificationReceipt(result, batch, root, true);
    } catch (error) {
      if (error.permanent || /receipt/.test(error.message)) throw error;
      last = error;
      if (attempt < 2) await wait(1000 * (attempt + 1));
    }
  }
  throw last;
}

export async function verifyExistingFiles(
  records,
  { actors, onVerified, attachPrior = (row) => row, ...options },
) {
  if (!Number.isInteger(actors) || actors < 1 || actors > 16)
    throw Error('Bounded verification concurrency required');
  let cursor = 0,
    failed = false;
  const missing = new Set();
  const results = await Promise.allSettled(
    Array.from({ length: actors }, async () => {
      while (cursor < records.length && !failed) {
        const batch = [];
        let bytes = 0;
        while (
          cursor < records.length &&
          batch.length < 64 &&
          (!batch.length || bytes + records[cursor].record.bytes <= 4_000_000)
        ) {
          const row = records[cursor++];
          batch.push(attachPrior(row));
          bytes += row.record.bytes;
        }
        try {
          const result = await verifyExistingBatch(batch, options);
          // Validate the whole batch before persisting even its first receipt.
          for (const row of result.verified) onVerified(row);
          for (const row of result.missing) missing.add(row.path);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const bad = results.find((result) => result.status === 'rejected');
  if (bad) throw bad.reason;
  return records.filter(({ record }) => missing.has(record.path));
}
