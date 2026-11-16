import { createHash } from 'node:crypto';
import { studioWorkspaceStartupScript } from '../../../src/lib/studio-workspace-startup.mjs';

/** Permit only the exact reviewed parser-time Studio presentation seed. */
export function bindStudioWorkspaceStartupPolicy(page) {
  const csp = page['Content-Security-Policy'],
    matches = [...(csp ?? '').matchAll(/(?:^|;\s*)script-src\s+([^;]+)/gi)];
  if (
    matches.length !== 1 ||
    csp.includes(',') ||
    /(?:^|;\s*)script-src-elem\b/i.test(csp) ||
    !matches[0][1].split(/\s+/).includes("'self'") ||
    matches[0][1].includes("'unsafe-inline'") ||
    !studioWorkspaceStartupScript.trim() ||
    studioWorkspaceStartupScript.length > 1024 ||
    /<\/?script/i.test(studioWorkspaceStartupScript)
  )
    throw Error('Exact reviewed Studio startup policy required');
  const token =
    "'sha256-" + createHash('sha256').update(studioWorkspaceStartupScript).digest('base64') + "'";
  return {
    ...page,
    'Content-Security-Policy': matches[0][1].split(/\s+/).includes(token)
      ? csp
      : csp.replace(/(\bscript-src\s+[^;]+)/i, '$1 ' + token),
  };
}
