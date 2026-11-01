import { JURISDICTIONS } from '../r2/inventory.mjs';
import { createPrefixInventoryReader } from './prefix-inventory.mjs';
// Complete lexicographic ranges, not guessed filename prefixes. Boundaries affect
// concurrency only: every possible object key belongs to exactly one range.
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function inventoryBoundaries(objects, stride = 4000) {
  const keys = objects.map((o) => o.key);
  if (keys.some((key) => typeof key !== 'string' || !key))
    throw Error('Invalid inventory object key');
  // UTF-16 and UTF-8 order agree for BMP-only strings. Most R2 keys have no
  // surrogate code units, so use the native comparison without allocating
  // buffers on every sort comparison. Retain byte order for all other keys.
  const hasSurrogate = keys.some((key) => /[\uD800-\uDFFF]/.test(key));
  keys.sort(hasSurrogate ? compare : (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (new Set(keys).size !== keys.length) throw Error('Duplicate inventory object');
  const bounds = [];
  for (let i = stride - 1; i < keys.length - 1; i += stride) bounds.push(keys[i]);
  return bounds;
}
/** Old ranges are partition hints only; they never carry counts or grant write permission. */
export function readOnlyRangeHints(hints, accountId, targetBucket) {
  if (hints?.hintOnly !== true || hints.accountId !== accountId || !Array.isArray(hints.buckets))
    throw Error('Read-only inventory hints for this account required');
  const seen = new Set(),
    result = hints.buckets.map((b) => {
      const jurisdiction = b.jurisdiction ?? 'default',
        id = jurisdiction + '/' + b.bucket;
      if (
        !JURISDICTIONS.includes(jurisdiction) ||
        !/^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])$/.test(b.bucket ?? '') ||
        seen.has(id) ||
        !Array.isArray(b.bounds) ||
        b.bounds.some(
          (k, i) => typeof k !== 'string' || !k || (i && compare(b.bounds[i - 1], k) >= 0),
        )
      )
        throw Error('Invalid inventory range hints');
      seen.add(id);
      return { bucket: b.bucket, jurisdiction, bounds: [...b.bounds] };
    });
  if (!result.some((b) => b.bucket === targetBucket && b.jurisdiction === 'default'))
    throw Error('Target bucket missing from read-only hints');
  return result;
}
// Read disjoint complete key ranges in parallel so the account census can
// finish within the unchanged 45-second freshness window. This path is read-only.
export function createBoundInventoryReader({ buckets, fetchPage, concurrency = 32 }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw Error('Bounded inventory concurrency required');
  return async function read(command, fallback) {
    const bucket = buckets.find(
      (b) => b.bucket === command.bucket && b.jurisdiction === command.jurisdiction,
    );
    if (!bucket) return fallback();
    const bounds = bucket.bounds ?? [];
    if (bounds.some((s, i) => typeof s !== 'string' || !s || (i && compare(bounds[i - 1], s) >= 0)))
      throw Error('Invalid inventory range boundaries');
    const ranges = [...bounds, undefined].map((upper, i) => ({
      lower: i ? bounds[i - 1] : undefined,
      upper,
    }));
    const parts = new Array(ranges.length);
    let next = 0;
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, ranges.length) }, async () => {
        while (next < ranges.length) {
          const index = next++,
            { lower, upper } = ranges[index];
          let cursor,
            previous = lower,
            finished = false;
          const seen = new Set(),
            entries = [];
          do {
            const page = await fetchPage({
              ...command,
              cursor,
              startAfter: cursor ? undefined : lower,
            });
            if (typeof page.IsTruncated !== 'boolean' || !Array.isArray(page.Contents))
              throw Error('Incomplete bound inventory page');
            for (const entry of page.Contents) {
              if (
                typeof entry.Key !== 'string' ||
                !entry.Key ||
                !Number.isSafeInteger(entry.Size) ||
                entry.Size < 0
              )
                throw Error('Invalid bound inventory object');
              if (previous !== undefined && compare(previous, entry.Key) >= 0)
                throw Object.assign(Error('unordered bound inventory object'), {
                  code: 'INVENTORY_UNORDERED',
                });
              previous = entry.Key;
              if (upper !== undefined && compare(entry.Key, upper) > 0) {
                finished = true;
                break;
              }
              entries.push(entry);
              if (entry.Key === upper) {
                finished = true;
                break;
              }
            }
            if (finished || !page.IsTruncated) break;
            const token = page.NextContinuationToken;
            if (typeof token !== 'string' || !token || seen.has(token))
              throw Error('Incomplete or looping bound inventory');
            seen.add(token);
            cursor = token;
          } while (true);
          parts[index] = entries;
        }
      }),
    );
    const failed = workers.find((worker) => worker.status === 'rejected');
    if (failed) throw failed.reason;
    const Contents = parts.flat();
    for (let i = 1; i < Contents.length; i++)
      if (compare(Contents[i - 1].Key, Contents[i].Key) >= 0)
        throw Object.assign(Error('Overlapping bound inventory ranges'), {
          code: 'INVENTORY_UNORDERED',
        });
    return { IsTruncated: false, Contents };
  };
}

// Some R2 listings have returned prefix-related keys in a different order from
// the documented byte ordering. Retry such a bucket from its root using full,
// disjoint prefix reads; malformed data and incomplete pagination still fail.
// The set is a per-session performance hint, never a storage reservation.
export function createResilientInventoryReader({
  buckets,
  fetchPage,
  unorderedBuckets = new Set(),
  preferPrefix = true,
}) {
  // Up to eight buckets may be measured at once; sixteen range reads per
  // bucket retain the earlier overall ceiling of 128 concurrent reads.
  const ranges = createBoundInventoryReader({ buckets, fetchPage, concurrency: 16 });
  const prefix = createPrefixInventoryReader({ fetchPage });
  return async function read(command, fallback) {
    const bound = buckets.some(
      (b) => b.bucket === command.bucket && b.jurisdiction === command.jurisdiction,
    );
    if (!bound) return fallback();
    const id = `${command.jurisdiction}/${command.bucket}`;
    if (preferPrefix || unorderedBuckets.has(id)) return prefix(command);
    try {
      return await ranges(command, fallback);
    } catch (error) {
      if (error?.code !== 'INVENTORY_UNORDERED') throw error;
      unorderedBuckets.add(id);
      return prefix(command);
    }
  };
}
