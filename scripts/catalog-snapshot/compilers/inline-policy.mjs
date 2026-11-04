import { createHash } from 'node:crypto';
// Add only the exact two repository-owned cookie bundles compiled into the page.
// Retain existing hashes for the verified legacy fallback; never add unsafe-inline.
export function bindCookieScriptPolicy(page, scripts) {
  const policy = { ...page }, csp = policy['Content-Security-Policy'];
  const match = /(?:^|;\s*)script-src\s+([^;]+)/.exec(csp || '');
  if (!match || !match[1].includes("'self'") || match[1].includes("'unsafe-inline'") || scripts.length !== 2)
    throw Error('Reviewed script policy and exact cookie bundles required');
  const additions = scripts.map(script => {
    if (typeof script !== 'string' || !script.trim() || script.length > 20000 || /<\/?script/i.test(script))
      throw Error('Invalid repository cookie bundle');
    return "'sha256-" + createHash('sha256').update(script).digest('base64') + "'";
  }).filter(value => !match[1].split(/\s+/).includes(value));
  if (additions.length) policy['Content-Security-Policy'] = csp.replace(/(\bscript-src\s+[^;]+)/, '$1 ' + additions.join(' '));
  return policy;
}
