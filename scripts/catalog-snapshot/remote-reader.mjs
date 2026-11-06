// Memory-bounded coalesced point reads. Never lists/scans the parent catalogue.
import { createHmac } from 'node:crypto';
import { setTimeout as backoff } from 'node:timers/promises';
import { sha256 } from './stage-manifest.mjs';
const transientBodyTransportCodes = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);
function isTransientBodyTransportError(error) {
  const code = error?.cause?.code ?? error?.code;
  return error instanceof TypeError && transientBodyTransportCodes.has(code);
}
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
    receivedBytes = 0,
    diskAdmissionHolds = 0;
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
    // Fill the already declared four-request window when an initial pending
    // queue contains more than one bounded batch. Previously the next batch
    // waited for this request to finish even while capacity was available.
    if (active < 4 && !queued && [...pending.values()].some((p) => !p.started)) {
      queued = true;
      queueMicrotask(flush);
    }
    const keys = batch.map(([k]) => k);
    try {
      let response, result;
      // Only idempotent pinned reads retry transient transport failures. Every
      // attempt receives fresh authority for the same exact parent and keys.
      // Stale parents, authorization and corrupt returned bytes fail closed.
      for (let attempt = 0; attempt < 3; attempt++) {
        const command = {
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
        requests++;
        try {
          response = await fetcher(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ command, signature }),
            signal: AbortSignal.timeout(90000),
          });
        } catch (error) {
          if (attempt === 2) throw error;
          await backoff(200 * 2 ** attempt);
          continue;
        }
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
          await response.body?.cancel();
          await backoff(200 * 2 ** attempt);
          continue;
        }
        if (!response.ok) throw Error('Pinned catalog read HTTP ' + response.status);
        try {
          // Include body consumption in the retry boundary. A remote preview can
          // close a streamed JSON response after headers without rejecting fetch().
          result = await response.json();
          break;
        } catch (error) {
          if (!isTransientBodyTransportError(error) || attempt === 2) throw error;
          await response.body?.cancel().catch(() => {});
          await backoff(200 * 2 ** attempt);
        }
      }
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
          // Capture admission intent when the request starts, so a late native
          // response cannot pollute disk after its scoped check has finished.
          if (p.admitDisk) diskCache?.put(key, r.body);
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
    async withoutDiskCacheAdmissions(operate) {
      if (typeof operate !== 'function') throw Error('Scoped native cache operation required');
      diskAdmissionHolds++;
      try {
        return await operate();
      } finally {
        diskAdmissionHolds--;
      }
    },
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
      pending.set(key, {
        resolve,
        reject,
        promise,
        started: false,
        admitDisk: diskAdmissionHolds === 0,
      });
      if (!queued) {
        queued = true;
        queueMicrotask(flush);
      }
      return promise;
    },
    metrics: () => ({ requests, receivedBytes, cacheEntries: cache.size, catalogScans: 0 }),
  };
}
