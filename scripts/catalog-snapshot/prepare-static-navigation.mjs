import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { siteNavigationScript } from '../../src/lib/site-navigation-inline.mjs';
import { bindSiteNavigationPolicy } from './compilers/navigation-policy.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
export function rewriteStaticNavigationHTML(bytes, binding, oldURL, shareURL) {
  if (bytes.length !== binding.bytes || sha(bytes) !== binding.sha256)
    throw Error('Static source no longer matches its verified package');
  if (!/^\/__ssr-client\/[a-f0-9]{40}\/[a-zA-Z0-9_-]+\.js$/.test(shareURL))
    throw Error('Versioned share module required');
  const html = new TextDecoder('utf8', { fatal: true }).decode(bytes),
    boundary = '</header><main id="main"';
  if (
    html.split(oldURL).length !== 2 ||
    html.split(boundary).length !== 2 ||
    html.split('data-site-header').length !== 2
  )
    throw Error('Ambiguous legacy header source');
  return html
    .replace(oldURL, shareURL)
    .replace(boundary, '</header><script>' + siteNavigationScript + '</script><main id="main"');
}
// Apply only to a NEW small package. Atomic replacement preserves hardlinked or
// cloned prior packages and rollback sources. Old immutable URLs remain untouched.
export function prepareStaticNavigation({ packageDir, software, code }) {
  const bindings = JSON.parse(
    readFileSync(new URL('../../data/static-navigation-bindings.json', import.meta.url)),
  );
  if (bindings.schema !== 1 || bindings.files.length !== 17)
    throw Error('Exact retained static source bindings required');
  const urls = JSON.parse(readFileSync(join(software, 'home-ssr/compiled/script-urls.json')));
  const matches = Object.entries(urls).filter(([key, url]) => {
    if (!key.includes('/src/layouts/Layout.astro?')) return false;
    const asset = code.clientAssets.find((a) => a.url === url);
    if (!asset) throw Error('Unbound current module');
    const bytes = readFileSync(asset.file);
    if (bytes.length !== asset.bytes || sha(bytes) !== asset.sha256)
      throw Error('Current module bytes changed');
    return bytes.includes('[data-share-art]') && !bytes.includes('[data-site-header]');
  });
  if (matches.length !== 1) throw Error('Exactly one current share-only header module required');
  const shareURL = matches[0][1],
    files = [];
  for (const file of bindings.files) {
    if (!/^\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/.test(file.path))
      throw Error('Bound static path required');
    const target = join(packageDir, file.path),
      bytes = readFileSync(target),
      html = rewriteStaticNavigationHTML(bytes, file, bindings.oldNavigationScript.url, shareURL),
      body = Buffer.from(html),
      temp = target + '.navigation-tmp';
    if (!resolve(target).startsWith(resolve(packageDir) + '/'))
      throw Error('Package source escape');
    writeFileSync(temp, body);
    renameSync(temp, target);
    files.push({
      path: file.path,
      beforeSHA256: file.sha256,
      afterSHA256: sha(body),
      beforeBytes: bytes.length,
      afterBytes: body.length,
    });
  }
  const headersPath = join(packageDir, '_headers'),
    headers = readFileSync(headersPath, 'utf8');
  let policies = 0;
  const rewritten = headers.replace(/^(  Content-Security-Policy: )(.*)$/gm, (_, prefix, csp) => {
    policies++;
    return (
      prefix +
      bindSiteNavigationPolicy({ 'Content-Security-Policy': csp })['Content-Security-Policy']
    );
  });
  if (!policies) throw Error('No retained static CSP policy');
  const temp = headersPath + '.navigation-tmp';
  writeFileSync(temp, rewritten);
  renameSync(temp, headersPath);
  return {
    status: 'BOUNDED_RETAINED_STATIC_NAVIGATION_PREPARED_NOT_DEPLOYED',
    files,
    shareURL,
    criticalInlineSHA256: sha(Buffer.from(siteNavigationScript)),
    headersBeforeSHA256: sha(Buffer.from(headers)),
    headersAfterSHA256: sha(Buffer.from(rewritten)),
    oldImmutableScript: bindings.oldNavigationScript,
    oldImmutableBytesChanged: false,
    policies,
  };
}
