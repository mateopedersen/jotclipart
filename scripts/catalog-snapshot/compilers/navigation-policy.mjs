import { createHash } from 'node:crypto';
import { siteNavigationScript } from '../../../src/lib/site-navigation-inline.mjs';
// Only the exact repository-owned navigation controller. Existing cookie/legacy
// hashes and all non-script policy directives stay intact.
export function bindSiteNavigationPolicy(page) {
  const csp = page['Content-Security-Policy'],
    match = /(?:^|;\s*)script-src\s+([^;]+)/.exec(csp ?? '');
  if (
    !match ||
    !match[1].includes("'self'") ||
    match[1].includes("'unsafe-inline'") ||
    !siteNavigationScript.trim() ||
    siteNavigationScript.length > 12000 ||
    /<\/?script/i.test(siteNavigationScript)
  )
    throw Error('Exact reviewed navigation script policy required');
  const hash =
    "'sha256-" + createHash('sha256').update(siteNavigationScript).digest('base64') + "'";
  return {
    ...page,
    'Content-Security-Policy': match[1].split(/\s+/).includes(hash)
      ? csp
      : csp.replace(/(\bscript-src\s+[^;]+)/, '$1 ' + hash),
  };
}
