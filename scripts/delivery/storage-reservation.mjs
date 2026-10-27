import { measureAccount, validateInventoryScope } from '../r2/inventory.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  cloudflareTransport,
  configuredToken,
  refreshConfiguredLogin,
} from '../r2/cloudflare-api.mjs';
import { inventoryBoundaries } from './inventory-reader.mjs';
import { HARD_CAP, enforceStorageBudget } from '../r2/plan.mjs';
// An expired census may supply partition hints for a read-only session. It is
// never a storage reservation; the complete account must be measured again.
export function inventoryHints(inventory) {
  validateInventoryScope(inventory);
  if (inventory.complete !== true) throw Error('Incomplete inventory cannot supply hints');
  return inventory.buckets.map((b) => {
    if (b.complete !== true) throw Error('Incomplete bucket cannot supply hints');
    return {
      bucket: b.name,
      jurisdiction: b.jurisdiction,
      bounds: inventoryBoundaries(b.objects),
    };
  });
}
export function reserveInventory(inventory, bytes, now = Date.now()) {
  validateInventoryScope(inventory);
  if (
    inventory.complete !== true ||
    !Number.isFinite(inventory.observedAt) ||
    inventory.observedAt > now ||
    now - inventory.observedAt > 45_000
  )
    throw Error('Fresh complete account inventory required');
  const measured = inventory.buckets.reduce((sum, bucket) => {
    if (bucket.complete !== true) throw Error('Incomplete bucket');
    return (
      sum +
      bucket.objects.reduce((n, o) => {
        if (!Number.isSafeInteger(o.bytes) || o.bytes < 0) throw Error('Invalid object size');
        return n + o.bytes;
      }, 0)
    );
  }, 0);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid release reservation');
  enforceStorageBudget({ projectedBytes: measured + bytes }, HARD_CAP);
  return {
    accountId: inventory.accountId,
    observedAt: inventory.observedAt,
    measuredBytes: measured,
    additionalBytes: bytes,
    projectedBytes: measured + bytes,
  };
}
export async function measureReservation(accountId, remainingBytes, listObjects) {
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
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
  const transport = cloudflareTransport({ accountId, token, requestIntervalMs: 300 });
  const inventory = await measureAccount({
    endpoint,
    batch: [],
    aws: (command, args, endpoint) => {
      if (command === 'list-objects-v2' && listObjects) {
        const value = (name) => args[args.indexOf(name) + 1];
        return listObjects(
          {
            bucket: value('--bucket'),
            jurisdiction:
              new URL(endpoint).hostname.split('.')[1] === 'r2'
                ? 'default'
                : new URL(endpoint).hostname.split('.')[1],
            cursor: args.includes('--continuation-token')
              ? value('--continuation-token')
              : undefined,
          },
          () => transport.aws(command, args, endpoint),
        );
      }
      return transport.aws(command, args, endpoint);
    },
    proveAbsent: transport.proveAbsent,
    enumerationSource: transport.enumerationSource,
  });
  const roster = inventoryHints(inventory);
  try {
    return { ...reserveInventory(inventory, remainingBytes), roster };
  } catch (error) {
    if (error.message === 'Fresh complete account inventory required')
      error.readOnlyInventoryHints = roster;
    throw error;
  }
}
