// The build embeds the exact repository script digest. No visitor input enters
// this adapter. Retain all legacy CSP directives and hashes; never unsafe-inline.
const scriptDirectives = new Set([
  'default-src', 'script-src', 'script-src-elem', 'script-src-attr',
]);
function scriptlessPolicy(csp) {
  if (!csp || csp.includes(',')) return false;
  const directives = new Map();
  for (const item of csp.split(';')) {
    const parts = item.trim().split(/\s+/);
    if (!parts[0]) continue;
    const name = parts.shift().toLowerCase();
    if (!scriptDirectives.has(name)) continue;
    if (directives.has(name)) return false;
    directives.set(name, parts);
  }
  const base = directives.get('script-src') ?? directives.get('default-src');
  const none = (values) => values?.length === 1 && values[0] === "'none'";
  // Keep the base deny-all too: element/attribute overrides must not disguise
  // other script execution permissions (for example unsafe-eval in script-src).
  return none(base) &&
    none(directives.get('script-src-elem') ?? base) &&
    none(directives.get('script-src-attr') ?? base);
}
export function staticNavigationPolicy(response, scriptToken) {
  if (
    ![200, 404].includes(response.status) ||
    !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')
  )
    return response;
  if (!/^'sha256-[A-Za-z0-9+/]{43}='$/.test(scriptToken ?? ''))
    throw Error('Exact compiled navigation script digest required');
  const headers = new Headers(response.headers),
    csp = headers.get('content-security-policy');
  // Intentionally scriptless responses (such as public shares) need no menu
  // script. Preserve their stricter policy, bytes and encoding contract exactly.
  // Refuse to infer browser precedence for duplicate or combined policies.
  if (scriptlessPolicy(csp)) return response;
  const match = /(?:^|;\s*)script-src\s+([^;]+)/.exec(csp ?? '');
  if (!match || !match[1].includes("'self'") || match[1].includes("'unsafe-inline'"))
    throw Error('Reviewed legacy script policy required');
  if (!match[1].split(/\s+/).includes(scriptToken))
    headers.set(
      'content-security-policy',
      csp.replace(/(\bscript-src\s+[^;]+)/, '$1 ' + scriptToken),
    );
  return new Response(response.body, {
    status: response.status,
    headers,
    // The retained worker already emitted encoded bytes. Keep its manual body
    // contract when adding a CSP hash, otherwise Workers can gzip them again.
    ...(headers.has('content-encoding') ? { encodeBody: 'manual' } : {}),
  });
}
