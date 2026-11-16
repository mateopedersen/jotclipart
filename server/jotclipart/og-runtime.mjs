import { prepareOgDescriptor, ogImageResponse, OG_LIMITS, ogSHA256 } from './og-image.mjs';
const approvedOrigin = (u) =>
  u.protocol === 'https:' &&
  !u.port &&
  (['jotclipart.com', 'preview.jotclipart.com'].includes(u.hostname) ||
    /^(?:[a-z0-9-]+\.)?jotclipart\.pages\.dev$/.test(u.hostname));
/** Metadata does not initialize Wasm. Only uncached PNG requests do. */
export function createCatalogOgService({ identity, render }) {
  if (typeof render !== 'function') throw Error('Reviewed OG renderer required');
  return Object.freeze({
    descriptor: (source) => prepareOgDescriptor(source, identity),
    async image(request, source, { cache, defer } = {}) {
      const url = new URL(request.url);
      if (!approvedOrigin(url)) return new Response('Not found', { status: 404 });
      const descriptor = await prepareOgDescriptor(source, identity);
      if (url.pathname !== descriptor.path || url.search)
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      const key = new Request(`${url.origin}/__jotclipart-og-cache/v1/${descriptor.digest}`);
      let response = cache ? await cache.match(key) : undefined;
      if (response) {
        if (
          response.status !== 200 ||
          response.headers.get('content-type') !== 'image/png' ||
          response.headers.get('x-jotclipart-og') !== descriptor.digest
        )
          throw Error('Invalid cached OG identity');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const etag = '"' + (await ogSHA256(bytes)) + '"';
        if (
          bytes.length < 100 ||
          bytes.length > OG_LIMITS.outputBytes ||
          ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) ||
          response.headers.get('etag') !== etag
        )
          throw Error('Invalid cached OG bytes');
        response = new Response(bytes, { status: 200, headers: response.headers });
      } else {
        const result = await render(source);
        if (result.descriptor.digest !== descriptor.digest)
          throw Error('OG render/source identity changed');
        response = ogImageResponse(result);
        if (cache) {
          const put = cache.put(key, response.clone());
          if (defer) defer(put);
          else await put;
        }
      }
      const headers = new Headers(response.headers);
      headers.set('X-Robots-Tag', 'noindex');
      if (request.headers.get('if-none-match') === response.headers.get('etag')) {
        headers.delete('content-length');
        return new Response(null, { status: 304, headers });
      }
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: 200,
        headers,
      });
    },
  });
}

export async function fetchOgRenderService(binding, source, identity) {
  if (!binding?.fetch) throw Error('Bound private OG service required');
  const descriptor = await prepareOgDescriptor(source, identity);
  const response = await binding.fetch('https://jotclipart-og.internal/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(source),
  });
  if (
    response.status !== 200 ||
    response.headers.get('content-type') !== 'image/png' ||
    response.headers.get('x-jotclipart-og-renderer') !== identity.rendererSHA256 ||
    response.headers.get('x-jotclipart-og') !== descriptor.digest
  )
    throw Error('Private OG service identity mismatch');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > OG_LIMITS.outputBytes) {
      await reader.cancel();
      throw Error('Private OG output bound exceeded');
    }
    chunks.push(value);
  }
  const png = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    png.set(chunk, at);
    at += chunk.length;
  }
  if (length < 100 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => png[i] === n))
    throw Error('Private OG output is not PNG');
  const dimensions = new DataView(png.buffer);
  if (dimensions.getUint32(16) !== 1200 || dimensions.getUint32(20) !== 630)
    throw Error('Private OG output dimensions differ');
  const digest = await ogSHA256(png),
    etag = '"' + digest + '"';
  if (
    response.headers.get('etag') !== etag ||
    Number(response.headers.get('content-length')) !== length
  )
    throw Error('Private OG output byte identity differs');
  return { png, width: 1200, height: 630, sha256: digest, etag, descriptor };
}
