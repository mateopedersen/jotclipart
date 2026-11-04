// Real shared Astro counter SSR: caller punctuation must not acquire whitespace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd(),
  compiler = createRequire(import.meta.resolve('astro/package.json'))('@astrojs/compiler-rs');
test('singular, plural and thousands counts preserve following commas, periods and parentheses in actual SSR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-count-punctuation-')),
    entry = join(root, 'work', dir.split('/').at(-1) + '-entry.mjs');
  try {
    const counter = resolve('src/components/CatalogCount.astro'),
      fixture = join(dir, 'Punctuation.astro');
    writeFileSync(
      fixture,
      `---\nimport Counter from ${JSON.stringify(counter)};\nconst {topic}=Astro.props;\n---\n<p>Choose <Counter kind="topic" countKey={topic} unit="illustration"/>, including examples. (<Counter kind="topic" countKey={topic}/>).</p>`,
    );
    const plugin = {
      name: 'actual-counter-SSR',
      setup(b) {
        b.onResolve({ filter: /^astro(?:\/|$)/ }, (args) => ({
          path: createRequire(resolve('package.json')).resolve(args.path),
        }));
        b.onLoad({ filter: /catalog-statistics\.ts$/ }, () => ({
          contents: `export const catalogStatistics={version:'explicit-punctuation-fixture',totals:{artworks:1285,subjects:3,printable:0,collections:1},topics:{single:1,many:50,thousand:1234},collections:{}};`,
          loader: 'ts',
        }));
        b.onLoad({ filter: /\.astro$/ }, async (args) => {
          const input =
              args.path === counter && process.env.UC_COUNT_TEMPLATE_FILE
                ? readFileSync(process.env.UC_COUNT_TEMPLATE_FILE, 'utf8')
                : readFileSync(args.path, 'utf8'),
            r = await compiler.transform(input, {
              filename: args.path,
              renderScript: true,
              internalURL: 'astro/compiler-runtime',
              compact: true,
              resolvePath: (s) => s,
            });
          assert(!r.diagnostics.some((d) => d.severity === 1));
          return {
            contents: r.code,
            loader: 'ts',
            resolveDir: args.path === fixture ? root : dirname(args.path),
          };
        });
      },
    };
    writeFileSync(
      entry,
      `import{experimental_AstroContainer}from'astro/container';import Page from ${JSON.stringify(fixture)};export async function render(topic){const c=await experimental_AstroContainer.create({resolve:()=>'/explicit-fixture.js'});return c.renderToString(Page,{props:{topic},partial:true})}`,
    );
    const output = join(dir, 'compiled.mjs');
    await build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      plugins: [plugin],
      external: ['node:*'],
      define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' },
      logLevel: 'silent',
    });
    const { render } = await import(pathToFileURL(output));
    for (const [topic, wanted] of [
      ['single', 'Choose 1 illustration, including examples. (1).'],
      ['many', 'Choose 50 illustrations, including examples. (50).'],
      ['thousand', 'Choose 1,234 illustrations, including examples. (1,234).'],
    ]) {
      const html = await render(topic),
        text = html
          .match(/<p>([\s\S]*?)<\/p>/)?.[1]
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      assert.equal(text, wanted);
    }
  } finally {
    rmSync(entry, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
