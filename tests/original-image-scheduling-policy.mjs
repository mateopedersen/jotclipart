import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { siteNavigationScript } from '../src/lib/site-navigation-inline.mjs';
import { originalImageSchedulingScript } from '../src/lib/original-image-scheduling-inline.mjs';
import { bindSiteNavigationPolicy } from '../scripts/catalog-snapshot/compilers/navigation-policy.mjs';
import { createHash } from 'node:crypto';
test('critical original scheduling bytes stay identical through both compiler modes', async () => {
  for (const minify of [false, true]) {
    const result = await build({
      stdin: {
        contents: 'export{siteNavigationScript}from"./src/lib/site-navigation-inline.mjs"',
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: 'esm',
      minify,
    });
    const imported = await import(
      'data:text/javascript;base64,' +
        Buffer.from(result.outputFiles[0].contents).toString('base64')
    );
    assert.equal(imported.siteNavigationScript, siteNavigationScript);
  }
  assert(!originalImageSchedulingScript.includes('toString()'));
  assert(siteNavigationScript.length < 12000);
});
test('the same exact hash authorizes the head scheduler and the menu without policy widening', () => {
  const before =
    "default-src 'self'; script-src 'self' 'sha256-existing'; connect-src 'self'; style-src 'self' 'unsafe-inline'";
  const after = bindSiteNavigationPolicy({ 'Content-Security-Policy': before })[
    'Content-Security-Policy'
  ];
  const expected =
    "'sha256-" + createHash('sha256').update(siteNavigationScript).digest('base64') + "'";
  assert(after.includes(expected));
  assert(after.includes("'sha256-existing'"));
  assert(!/script-src[^;]*(?:unsafe-inline|unsafe-eval)/.test(after));
  assert.equal(after.replace(' ' + expected, ''), before);
});
