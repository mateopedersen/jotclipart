import { fetchAssetWithRetry } from './asset-retry.mjs';

/** Serve the exact legacy Studio catalog by streaming verified static parts.
 * Existing open tabs and clients retain the original URL and JSON shape. */
export function createStudioCatalogHandler(manifest, baseHeaders = {}) {
  if (!manifest || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 ||
      !Array.isArray(manifest.parts) || !manifest.parts.length)
    throw Error('A verified Studio shard manifest is required');
  let total = 0;
  for (const [index, part] of manifest.parts.entries()) {
    const path = `/studio-catalog-parts/${manifest.sha256}/${String(index).padStart(5, '0')}.bin`;
    if (part.path !== path || !Number.isSafeInteger(part.bytes) || part.bytes < 1 ||
        part.bytes > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(part.sha256 ?? ''))
      throw Error('Invalid Studio shard manifest');
    total += part.bytes;
  }
  if (total !== manifest.bytes || !Number.isSafeInteger(total))
    throw Error('Studio shard byte count differs');
  const etag = `"sha256-${manifest.sha256}"`;
  const temporary = () => new Response('Studio catalog temporarily unavailable', {
    status: 503, headers: { 'Cache-Control': 'no-store' },
  });
  return async function handleStudioCatalog(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/studio-catalog.json') return null;
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    const headers = new Headers(baseHeaders);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Content-Length', String(manifest.bytes));
    headers.set('Cache-Control', 'no-cache, must-revalidate');
    headers.set('ETag', etag);
    if (request.headers.get('If-None-Match') === etag) {
      headers.delete('Content-Length');
      return new Response(null, { status: 304, headers });
    }
    if (!env?.ASSETS?.fetch) return temporary();
    const attempts = await Promise.allSettled(manifest.parts.map((part) =>
        fetchAssetWithRetry(new Request(new URL(part.path, url), {
          method: request.method, signal: request.signal,
        }), env.ASSETS),
      ));
    const responses = attempts.filter((a) => a.status === 'fulfilled').map((a) => a.value);
    if (attempts.some((a) => a.status === 'rejected') || responses.some((response) =>
      response.status !== 200 || (request.method === 'GET' && !response.body))) {
      await Promise.all(responses.map((r) => r.body?.cancel().catch(() => {})));
      return temporary();
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    let index = 0, reader, readBytes = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (index < responses.length) {
            reader ??= responses[index].body.getReader();
            const result = await reader.read();
            if (!result.done) {
              readBytes += result.value.byteLength;
              if (readBytes > manifest.parts[index].bytes) throw Error('Studio shard is too large');
              controller.enqueue(result.value);
              return;
            }
            if (readBytes !== manifest.parts[index].bytes) throw Error('Studio shard is incomplete');
            reader.releaseLock(); reader = undefined; readBytes = 0; index++;
          }
          controller.close();
        } catch (error) {
          controller.error(error);
          if (reader) await reader.cancel(error).catch(() => {});
          await Promise.all(responses.slice(index + (reader ? 1 : 0)).map((r) =>
            r.body?.cancel(error).catch(() => {}),
          ));
        }
      },
      async cancel(reason) {
        if (reader) await reader.cancel(reason).catch(() => {});
        await Promise.all(responses.slice(index + (reader ? 1 : 0)).map((r) =>
          r.body?.cancel(reason).catch(() => {}),
        ));
      },
    });
    return new Response(stream, { status: 200, headers });
  };
}
