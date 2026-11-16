/** Normalize only the new site's read requests. Preserve every path/query byte. */
export function canonicalPublicRedirect(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return undefined;
  const url = new URL(request.url);
  if (
    !['jotclipart.com', 'www.jotclipart.com'].includes(url.hostname) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.port ||
    (url.protocol === 'https:' && url.hostname === 'jotclipart.com')
  )
    return undefined;
  url.protocol = 'https:';
  url.hostname = 'jotclipart.com';
  return new Response(null, {
    status: 308,
    headers: {
      Location: url.href,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
