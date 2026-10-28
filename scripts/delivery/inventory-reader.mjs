// Complete lexicographic ranges, not guessed filename prefixes. Boundaries affect
// concurrency only: every possible object key belongs to exactly one range.
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function inventoryBoundaries(objects, stride = 4000) {
  const keys = objects.map((o) => o.key).sort(compare);
  if (new Set(keys).size !== keys.length) throw Error('Duplicate inventory object');
  const bounds = [];
  for (let i = stride - 1; i < keys.length - 1; i += stride) bounds.push(keys[i]);
  return bounds;
}
// Read disjoint complete key ranges in parallel so the account census can
// finish within the unchanged 45-second freshness window. This path is read-only.
export function createBoundInventoryReader({ buckets, fetchPage, concurrency = 16 }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
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
    await Promise.all(
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
                entry.Size < 0 ||
                (previous !== undefined && compare(previous, entry.Key) >= 0)
              )
                throw Error('Invalid or unordered bound inventory object');
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
    const Contents = parts.flat();
    for (let i = 1; i < Contents.length; i++)
      if (compare(Contents[i - 1].Key, Contents[i].Key) >= 0)
        throw Error('Overlapping bound inventory ranges');
    return { IsTruncated: false, Contents };
  };
}
