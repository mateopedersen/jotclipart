// The build embeds the exact repository script digest. No visitor input enters
// this adapter. Retain all legacy CSP directives and hashes; never unsafe-inline.
export function staticNavigationPolicy(response, scriptToken) {
  if (
    ![200, 404].includes(response.status) ||
    !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')
  )
    return response;
  if (!/^'sha256-[A-Za-z0-9+/]{43}='$/.test(scriptToken ?? ''))
    throw Error('Exact compiled navigation script digest required');
  const headers = new Headers(response.headers),
    csp = headers.get('content-security-policy'),
    match = /(?:^|;\s*)script-src\s+([^;]+)/.exec(csp ?? '');
  if (!match || !match[1].includes("'self'") || match[1].includes("'unsafe-inline'"))
    throw Error('Reviewed legacy script policy required');
  if (!match[1].split(/\s+/).includes(scriptToken))
    headers.set(
      'content-security-policy',
      csp.replace(/(\bscript-src\s+[^;]+)/, '$1 ' + scriptToken),
    );
  return new Response(response.body, { status: response.status, headers });
}
