// Compress only successful HTML documents. Images and byte-range downloads
// keep their original bytes and existing cache semantics.
function acceptsGzip(value) {
  let gzip, wildcard;
  for (const part of (value || '').toLowerCase().split(',')) {
    const [token, ...params] = part.trim().split(';');
    const name = token.trim();
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.find((p) => /^\s*q\s*=/.test(p));
    const quality = q ? Number(q.split('=')[1]) : 1;
    const allowed = Number.isFinite(quality) && quality > 0 && quality <= 1;
    if (name === 'gzip') gzip = allowed;
    else wildcard = allowed;
  }
  return gzip ?? wildcard ?? false;
}

export function compressHtml(request, response) {
  if (
    !['GET', 'HEAD'].includes(request.method) ||
    request.headers.has('Range') ||
    response.status !== 200 ||
    !/^text\/html(?:;|$)/i.test(response.headers.get('Content-Type') || '') ||
    response.headers.has('Content-Encoding')
  ) return response;

  return gzipResponse(request,response);
}

// Catalog JSON contains source-bound public artwork metadata. This is transport
// compression only; private/no-store query policy and original R2 bytes remain.
export function compressCatalogJson(request,response) {
  if (!['GET','HEAD','POST'].includes(request.method) || request.headers.has('Range') ||
      response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') || '') ||
      response.headers.has('Content-Encoding') || response.headers.has('Set-Cookie')) return response;
  return gzipResponse(request,response);
}

function gzipResponse(request,response) {
  const headers = new Headers(response.headers);
  const vary = headers.get('Vary');
  if (vary !== '*' && !vary?.split(',').some((v) => v.trim().toLowerCase() === 'accept-encoding'))
    headers.set('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');

  if (!acceptsGzip(request.headers.get('Accept-Encoding')))
    return new Response(response.body, { status: response.status, headers });

  // The encoded representation has a different byte sequence and length;
  // retain the origin's validators only for the uncompressed representation.
  headers.delete('Content-Length');
  headers.delete('ETag');
  headers.set('Content-Encoding', 'gzip');
  const body = request.method === 'HEAD' || !response.body
    ? null
    : response.body.pipeThrough(new CompressionStream('gzip'));
  return new Response(body, { status: response.status, headers, encodeBody: 'manual' });
}
