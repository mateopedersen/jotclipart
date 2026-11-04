// Memory-bounded coalesced point reads. Never lists/scans the parent catalogue.
import { createHmac } from 'node:crypto';
import { sha256 } from './stage-manifest.mjs';
export function remoteCatalogBucket({
  endpoint = 'http://127.0.0.1:8899/read',
  secret,
  parentSnapshotSHA256,
  accountId,
  bucket,
  fetcher = fetch,
  cacheEntries = 512,
  diskCache,
}) {
  if (
    endpoint !== 'http://127.0.0.1:8899/read' ||
    !/^[a-f0-9]{64}$/.test(secret ?? '') ||
    !/^[a-f0-9]{64}$/.test(parentSnapshotSHA256 ?? '') ||
    !Number.isSafeInteger(cacheEntries) ||
    cacheEntries < 1 ||
    cacheEntries > 512
  )
    throw Error('Private pinned reader configuration required');
  const cache = new Map(),
    pending = new Map();
  const hints = new Map();
  let queued = false,
    active = 0,
    requests = 0,
    receivedBytes = 0;
  const object = (key, r) => ({
    size: r.body.length,
    etag: r.etag,
    arrayBuffer: async () =>
      r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength),
    json: async () => JSON.parse(r.body),
  });
  async function flush() {
    queued = false;
    if (active >= 4) return;
    const batch = [];
    let estimated = 0;
    for (const row of pending) {
      if (row[1].started) continue;
      const size = hints.get(row[0]) ?? 1048576;
      if (batch.length >= 16 || estimated + size > 3000000) break;
      batch.push(row);
      estimated += size;
    }
    if (!batch.length) return;
    active++;
    for (const [, r] of batch) r.started = true;
    if (!batch.length) return;
    const keys = batch.map(([k]) => k),
      command = {
        action: 'read-pinned-catalog-metadata',
        parentSnapshotSHA256,
        accountId,
        bucket,
        at: Date.now() - 1000,
        keys,
      },
      signature = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(JSON.stringify(command))
        .digest('hex');
    try {
      requests++;
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, signature }),
        signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) throw Error('Pinned catalog read HTTP ' + response.status);
      const result = await response.json();
      if (
        result.parentSnapshotSHA256 !== parentSnapshotSHA256 ||
        !Array.isArray(result.objects) ||
        result.objects.length !== keys.length
      )
        throw Error('Private read root or cardinality differs');
      const byKey = new Map(result.objects.map((r) => [r.key, r]));
      if (byKey.size !== keys.length) throw Error('Duplicate private read result');
      const verified = keys.map((key) => {
        const r = byKey.get(key);
        if (!r) throw Error('Missing private read result');
        if (r.missing === true) return null;
        const body = Buffer.from(r.body, 'base64');
        if (
          r.bytes !== body.length ||
          sha256(body) !== r.sha256 ||
          (key !== 'catalog/active.json' && key.split('/').at(-1) !== r.sha256 + '.json')
        )
          throw Error('Private read bytes differ');
        receivedBytes += body.length;
        return { ...r, body };
      });
      for (let i = 0; i < batch.length; i++) {
        const [key, p] = batch[i],
          r = verified[i];
        pending.delete(key);
        if (r && key !== 'catalog/active.json') {
          diskCache?.put(key, r.body);
          cache.set(key, r);
          while (cache.size > cacheEntries) cache.delete(cache.keys().next().value);
        }
        p.resolve(r ? object(key, r) : null);
      }
    } catch (error) {
      for (const [key, p] of batch) {
        pending.delete(key);
        p.reject(error);
      }
    } finally {
      active--;
      if ([...pending.values()].some((p) => !p.started) && !queued) {
        queued = true;
        queueMicrotask(flush);
      }
    }
  }
  return {
    hint: (d) => {
      if (
        !d ||
        !/^[a-f0-9]{64}$/.test(d.sha256 ?? '') ||
        !Number.isSafeInteger(d.bytes) ||
        d.bytes < 1 ||
        d.bytes > 1048576 ||
        !d.key.endsWith('/' + d.sha256 + '.json')
      )
        throw Error('Invalid immutable read hint');
      hints.set(d.key, d.bytes);
      while (hints.size > 512) hints.delete(hints.keys().next().value);
    },
    get: async (key) => {
      if (
        !/^catalog\/(?:active\.json|objects\/(?:artworks|collections|search|recent|related|counts|sitemaps)\/[a-f0-9]{64}\.json)$/.test(
          key,
        )
      )
        throw Error('Invalid private metadata key');
      const onDisk = key !== 'catalog/active.json' ? diskCache?.get(key) : null;
      if (onDisk) return object(key, { body: onDisk, etag: sha256(onDisk) });
      const old = key === 'catalog/active.json' ? null : cache.get(key);
      if (old) {
        cache.delete(key);
        cache.set(key, old);
        return object(key, old);
      }
      if (pending.has(key)) return pending.get(key).promise;
      let resolve, reject;
      const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      pending.set(key, { resolve, reject, promise, started: false });
      if (!queued) {
        queued = true;
        queueMicrotask(flush);
      }
      return promise;
    },
    metrics: () => ({ requests, receivedBytes, cacheEntries: cache.size, catalogScans: 0 }),
  };
}
