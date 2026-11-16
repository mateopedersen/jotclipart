import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { studioWorkspaceStartupScript } from '../src/lib/studio-workspace-startup.mjs';
import { bindStudioWorkspaceStartupPolicy } from '../scripts/catalog-snapshot/compilers/workspace-startup-policy.mjs';
import { validateInlineScripts } from '../server/catalog-snapshot/response-policy.mjs';

function seed(url, { creator = true, focus, noScript = false } = {}) {
  const dataset = { creator: String(creator), unrelated: 'preserved' };
  if (focus !== undefined) dataset.wbFocus = focus;
  const root = {
    dataset,
    matches(selector) {
      assert.equal(selector, '.uc-editor[data-creator="true"]');
      return creator;
    },
  };
  const scope = {
    document: { currentScript: noScript ? null : { parentElement: root } },
    location: new URL(url),
    URLSearchParams,
  };
  for (const name of [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'fetch',
    'XMLHttpRequest',
    'focus',
    'scrollTo',
  ])
    Object.defineProperty(scope, name, {
      get() {
        throw Error('Early startup must not access ' + name);
      },
    });
  vm.runInNewContext(studioWorkspaceStartupScript, scope, { timeout: 50 });
  return dataset;
}
test('parser-time startup changes presentation only for the explicit creator workspace deep link', () => {
  for (const path of [
    '/create/?view=workspace',
    '/create/?other=1&view=workspace#canvas',
    '/create/?view=workspace&view=normal',
  ])
    assert.deepEqual(seed('https://jotclipart.com' + path), {
      creator: 'true',
      unrelated: 'preserved',
      wbFocus: 'true',
      wbStartup: 'workspace',
    });
  assert(studioWorkspaceStartupScript.length < 1024);
  assert.doesNotMatch(studioWorkspaceStartupScript, /<\/?script/i);
});
test('normal no-JS-equivalent noncreator other-route and previously exited views are left alone', () => {
  for (const path of [
    '/create/',
    '/create/?view=normal',
    '/create/?view=Workspace',
    '/create/?view=workspace-later',
    '/create/?view=normal&view=workspace',
    '/edit/test/?view=workspace',
    '/?view=workspace',
  ])
    assert.deepEqual(seed('https://jotclipart.com' + path), {
      creator: 'true',
      unrelated: 'preserved',
    });
  assert.deepEqual(seed('https://jotclipart.com/create/?view=workspace', { creator: false }), {
    creator: 'false',
    unrelated: 'preserved',
  });
  assert.deepEqual(seed('https://jotclipart.com/create/?view=workspace', { focus: 'false' }), {
    creator: 'true',
    unrelated: 'preserved',
    wbFocus: 'false',
  });
  assert.deepEqual(seed('https://jotclipart.com/create/?view=workspace', { noScript: true }), {
    creator: 'true',
    unrelated: 'preserved',
  });
});
test('the exact startup script hash is added once while every other CSP directive remains intact', async () => {
  const original = {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'sha256-existing'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    },
    before = structuredClone(original),
    result = bindStudioWorkspaceStartupPolicy(original),
    base64 = createHash('sha256').update(studioWorkspaceStartupScript).digest('base64'),
    hex = createHash('sha256').update(studioWorkspaceStartupScript).digest('hex');
  assert.equal(
    result['Content-Security-Policy'],
    original['Content-Security-Policy'].replace(
      "script-src 'self' 'sha256-existing'",
      "script-src 'self' 'sha256-existing' 'sha256-" + base64 + "'",
    ),
  );
  assert.deepEqual(original, before);
  assert.deepEqual(bindStudioWorkspaceStartupPolicy(result), result);
  assert.equal(result['X-Frame-Options'], 'DENY');
  await validateInlineScripts('<script>' + studioWorkspaceStartupScript + '</script>', [hex]);
  await assert.rejects(
    validateInlineScripts('<script>' + studioWorkspaceStartupScript + ' ' + '</script>', [hex]),
    /Unexpected inline/,
  );
});
test('missing permissive duplicate or overriding script policies cannot silently admit the new startup code', () => {
  for (const csp of [
    '',
    "default-src 'none'",
    'script-src *',
    "script-src 'self' 'unsafe-inline'",
    "script-src 'self'; script-src *",
    "script-src 'self'; SCRIPT-SRC *",
    "script-src 'self', script-src *",
    "script-src 'self'; script-src-elem 'none'",
  ])
    assert.throws(
      () => bindStudioWorkspaceStartupPolicy({ 'Content-Security-Policy': csp }),
      /Exact reviewed/,
    );
});
test('the seed is emitted before the creator canvas without making cached HTML depend on request query', () => {
  const source = readFileSync('src/components/Editor.astro', 'utf8'),
    builder = readFileSync('scripts/catalog-snapshot/build-runtime.mjs', 'utf8');
  assert(
    source.indexOf('set:html={studioWorkspaceStartupScript}') <
      source.indexOf('<div class="uc-command">'),
  );
  assert.match(source, /creator && <script is:inline set:html=\{studioWorkspaceStartupScript\}/);
  assert.doesNotMatch(source, /Astro\.url\.(?:search|searchParams)/);
  assert.match(source, /class="uc-startup-back" href="\/create\/"/);
  assert.match(builder, /const page = bindStudioWorkspaceStartupPolicy\(/);
  assert.match(builder, /bindSiteNavigationPolicy\(/);
});
