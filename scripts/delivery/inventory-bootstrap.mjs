import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readOnlyRangeHints } from './inventory-reader.mjs';
import { authenticateLocalState, verifyLocalState } from '../verified-source-cache.mjs';
import {
  JURISDICTIONS,
  endpointFor,
  SCOPE_VERSION,
  validateInventoryScope,
} from '../r2/inventory.mjs';
import {
  configuredToken,
  cloudflareTransport,
  refreshConfiguredLogin,
} from '../r2/cloudflare-api.mjs';
const cacheFile = (root) => join(root, 'work/delivery/inventory-range-hints.json');
const domain = (data) => 'uc-read-only-inventory-hints-v1\0' + JSON.stringify(data);

export function cachedBootstrapHints(root, accountId, bucket) {
  try {
    const { data, signature } = JSON.parse(readFileSync(cacheFile(root), 'utf8'));
    if (data.schema !== 1 || !verifyLocalState(root, domain(data), signature)) return null;
    return readOnlyRangeHints(data, accountId, bucket);
  } catch {
    return null;
  }
}

export function saveBootstrapHints(root, accountId, bucket, roster) {
  const buckets = readOnlyRangeHints(
    { hintOnly: true, accountId, buckets: roster },
    accountId,
    bucket,
  );
  // No object totals, measured bytes, timestamps or write leases enter this cache.
  const data = { schema: 1, hintOnly: true, accountId, buckets };
  const target = cacheFile(root),
    temporary = target + '.' + randomUUID() + '.tmp';
  mkdirSync(join(root, 'work/delivery'), { recursive: true });
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ data, signature: authenticateLocalState(root, domain(data)) }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Enumerate only actual bucket names. This cannot return a reservation or an
// occupancy estimate. The normal fresh complete census still runs before PUT.
export async function liveBootstrapBindings(accountId, bucket, hints, transport) {
  const old = new Map(
    readOnlyRangeHints({ hintOnly: true, accountId, buckets: hints }, accountId, bucket).map(
      (b) => [b.jurisdiction + '/' + b.bucket, b],
    ),
  );
  const observedAt = Date.now();
  const scopes = await Promise.allSettled(
    JURISDICTIONS.map(async (jurisdiction) => {
      const names = [],
        seen = new Set(),
        tokens = new Set();
      let cursor,
        expected,
        proof = { source: 'cloudflare-api-list-buckets' };
      try {
        do {
          const page = await transport.aws(
            'list-buckets',
            ['--no-paginate', ...(cursor ? ['--continuation-token', cursor] : [])],
            endpointFor(accountId, jurisdiction),
          );
          if (
            !Array.isArray(page.Buckets) ||
            !Number.isSafeInteger(page.TotalCount) ||
            page.TotalCount < 0 ||
            (expected !== undefined && expected !== page.TotalCount)
          )
            throw Error('Invalid bootstrap bucket roster');
          expected = page.TotalCount;
          for (const row of page.Buckets) {
            if (typeof row.Name !== 'string' || !row.Name || seen.has(row.Name))
              throw Error('Duplicate bootstrap bucket');
            seen.add(row.Name);
            names.push(row.Name);
          }
          cursor = page.ContinuationToken ?? page.NextContinuationToken;
          if (
            (page.IsTruncated === true && !cursor) ||
            (cursor && (typeof cursor !== 'string' || tokens.has(cursor)))
          )
            throw Error('Incomplete bootstrap bucket enumeration');
          if (cursor) tokens.add(cursor);
        } while (cursor);
        if (names.length !== expected) throw Error('Incomplete bootstrap bucket roster');
      } catch (error) {
        if (names.length || !transport.proveAbsent) throw error;
        proof = await transport.proveAbsent(accountId, jurisdiction);
        if (
          !proof ||
          proof.accountId !== accountId ||
          proof.jurisdiction !== jurisdiction ||
          !['cloudflare-api-empty', 'cloudflare-entitlement-disabled'].includes(proof.source) ||
          (proof.source === 'cloudflare-api-empty' && proof.totalCount !== 0)
        )
          throw Error('Unknown bootstrap jurisdiction');
      }
      return {
        jurisdiction,
        endpoint: endpointFor(accountId, jurisdiction),
        complete: true,
        buckets: names,
        proof,
      };
    }),
  );
  const bad = scopes.find((s) => s.status === 'rejected');
  if (bad) throw bad.reason;
  const jurisdictions = scopes.map((s) => {
      if (s.status === 'rejected') throw s.reason;
      return s.value;
    }),
    roster = jurisdictions.flatMap((s) =>
      s.buckets.map((name) => ({ name, jurisdiction: s.jurisdiction })),
    );
  // Scope evidence only: there is deliberately no complete=true or objects
  // inventory here, so this structure cannot grant a storage reservation.
  validateInventoryScope({
    schemaVersion: 2,
    scopeVersion: SCOPE_VERSION,
    accountId,
    observedAt,
    jurisdictions,
    buckets: roster,
  });
  return readOnlyRangeHints(
    {
      hintOnly: true,
      accountId,
      buckets: roster.map((b) => ({
        bucket: b.name,
        jurisdiction: b.jurisdiction,
        bounds: old.get(b.jurisdiction + '/' + b.name)?.bounds ?? [],
      })),
    },
    accountId,
    bucket,
  );
}

export async function loadBootstrapBindings(root, accountId, bucket, transport) {
  const hints = cachedBootstrapHints(root, accountId, bucket);
  if (!hints) return null;
  if (!transport) {
    let token;
    try {
      token = configuredToken();
    } catch (error) {
      if (!process.env.WRANGLER_AUTH_FILE) throw error;
      token = await refreshConfiguredLogin({
        refresh: async () =>
          execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'whoami'], {
            stdio: 'ignore',
            timeout: 60000,
          }),
        expiry: () =>
          Date.parse(
            readFileSync(process.env.WRANGLER_AUTH_FILE, 'utf8').match(
              /^expiration_time\s*=\s*"([^"]+)"/m,
            )?.[1] ?? '',
          ),
      });
    }
    transport = cloudflareTransport({ accountId, token, requestIntervalMs: 300 });
  }
  return liveBootstrapBindings(accountId, bucket, hints, transport);
}
