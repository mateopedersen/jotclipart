import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brand } from '../../src/lib/brand.mjs';

const postcssPackage = readdirSync('node_modules/.pnpm').find((name) => name.startsWith('postcss@'));
const { default: postcss } = await import(
  pathToFileURL(resolve('node_modules/.pnpm', postcssPackage, 'node_modules/postcss/lib/postcss.js'))
);
const read = (file) => readFileSync(file, 'utf8');
function rules(file) {
  const text = read(file);
  const blocks = file.endsWith('.css')
    ? [text]
    : [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  return blocks.map((block) => postcss.parse(block));
}
function values(file, selector, property) {
  const output = [];
  for (const root of rules(file)) {
    root.walkRules((rule) => {
      if (rule.selector !== selector) return;
      rule.walkDecls(property, (declaration) => output.push(declaration.value));
    });
  }
  assert(output.length, `${file}: ${selector} ${property} must exist`);
  return output;
}
const isWhite = (value) => /^(?:#fff(?:fff)?|white|var\(--brand-(?:page|surface)\))$/i.test(value);
function white(file, selector, property = 'background') {
  for (const value of values(file, selector, property)) {
    assert(isWhite(value), `${file}: ${selector} must have a white ${property}, received ${value}`);
  }
}

test('page tokens remain white while approved action and logo accents remain green', () => {
  assert.equal(brand.background, '#FFFFFF');
  assert.equal(brand.surface, '#FFFFFF');
  assert.equal(brand.primary, '#52B788');
  assert.equal(brand.action, '#216E4E');
  assert(values('src/styles/global.css', ':root', '--brand-page').every(isWhite));
  assert(values('src/styles/global.css', ':root', '--sage').every(isWhite));
  white('src/styles/global.css', ':root');
});

test('broad catalog and footer backgrounds are white', () => {
  for (const [file, selector] of [
    ['src/styles/categories.css', '.discovery-hero'],
    ['src/styles/collection-directory.css', '.collection-directory-hero'],
    ['src/styles/site-footer.css', 'footer.site-footer'],
    ['src/styles/site-footer.css', '.footer-invitation'],
    ['src/styles/contact.css', '.contact-hero'],
    ['src/styles/trust-pages.css', '.trust-hero'],
    ['src/components/HomeBenefits.astro', '.home-benefits'],
    ['src/components/HomeBenefits.astro', '.home-benefit-art'],
  ]) white(file, selector);
});

test('Studio workspace and decorative invitation panels use white surfaces', () => {
  white('src/styles/studio-workspace.css', '.uc-editor.uc-editor');
  white('src/styles/studio-workspace.css', '.uc-editor .uc-stage', 'background-color');
  white('src/styles/studio-next.css', '.uc-editor.uc-next[data-work-mode]');
  white('src/styles/studio-next.css', '.uc-editor.uc-next[data-work-mode] .uc-stage');
  white('src/components/Editor.astro', '.uc-stage');
  white('src/components/Editor.astro', '.uc-stage.uc-paper-mode');
  white('src/components/CreateInvitation.astro', '.creative-studio-scene');
  for (const selector of ['.seasonal-scene', '.seasonal-autumn .seasonal-scene', '.seasonal-love .seasonal-scene']) {
    white('src/components/SeasonalShowcase.astro', selector);
  }
  white('src/components/AiInvitation.astro', '.ai-invitation-art');
  white('src/components/AiInvitation.astro', '.ai-invitation .ai-invitation-art');
});

test('soft green is not used as a broad page or section background', () => {
  const violations = [];
  const broad = /(?:^|[\s.>])(?:body|main)|(?:page|hero|section|workspace|panel|shell|container|dialog|inspector|scene|visual)(?:$|[\s.:_-])/i;
  const permittedSmall = /:hover|:focus|:active|::backdrop|aria-|button|btn|link|badge|icon|toggle|chip|swatch|check|notice|warning|status|alert|busy|error|canvas|skeleton|logo|shadow|paper|window|house|roof|pencil|ribbon|stamp|tag|dot|orb|mark|action/i;
  for (const directory of ['src/styles', 'src/components']) {
    for (const name of readdirSync(directory)) {
      if (!/\.(css|astro)$/.test(name)) continue;
      const file = `${directory}/${name}`;
      for (const root of rules(file)) root.walkDecls((declaration) => {
        const selector = declaration.parent.selector || '';
        if (/^background(?:-color|-image)?$/.test(declaration.prop) &&
            /var\(--brand-soft\)|#(?:f4faf6|d8f3dc)\b/i.test(declaration.value) &&
            broad.test(selector) && !permittedSmall.test(selector)) {
          violations.push(`${file}: ${selector}: ${declaration.value}`);
        }
      });
    }
  }
  assert.deepEqual(violations, []);
});

test('user canvas choices and warning/error visual distinction remain available', () => {
  const editor = read('src/components/Editor.astro');
  assert.match(editor, /data-bg="#e8f1fa" style="background:#e8f1fa"/);
  assert.match(editor, /data-bg="#edf1e7" style="background:#edf1e7"/);
  assert(values('src/components/Editor.astro', ".uc-notice[data-error='true']", 'background')
    .every((value) => value === '#fff0e9'));
  assert(values('src/components/Editor.astro', ".uc-notice[data-error='true']", 'color')
    .every((value) => value === '#792300'));
  assert.match(read('src/styles/studio-next.css'), /background-image:\s*\n?\s*linear-gradient\(45deg/);
});

test('the standalone transfer help page follows the white background policy', () => {
  const helper = read('public/move-your-work/index.html');
  assert.match(helper, /--page:#FFFFFF/);
  assert(!/--page:#F4FAF6/i.test(helper));
  assert.match(helper, /\.notice\{background:#(?:fff|ffffff)/i);
});
