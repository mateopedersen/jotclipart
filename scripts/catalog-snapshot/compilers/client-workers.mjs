// Vite normally compiles new Worker(new URL(...)) for Astro. The small native
// template compiler uses esbuild, so give it the same source-bound contract.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

export function clientWorkers({ root, outdir, revision }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Exact worker revision required');
  const sourceRoot = realpathSync(join(root, 'src'));
  mkdirSync(outdir, { recursive: true });
  const jobs = new Map(), outputs = {};
  async function compile(file) {
    const source = realpathSync(file);
    if (!source.startsWith(sourceRoot + '/') || !source.endsWith('.ts'))
      throw Error('Worker must be a local TypeScript source');
    if (!jobs.has(source)) jobs.set(source, (async () => {
      const result = await build({ entryPoints: [source], outfile: join(outdir, 'worker.js'),
        bundle: true, splitting: false, format: 'esm', platform: 'browser', target: 'es2022',
        minify: true, write: false, metafile: true, logLevel: 'warning' });
      if (result.outputFiles.length !== 1) throw Error('One self contained worker required');
      const bytes = result.outputFiles[0].contents;
      const name = 'worker-' + createHash('sha256').update(bytes).digest('hex').slice(0, 24) + '.js';
      const file = join(outdir, name);
      writeFileSync(file, bytes);
      const info = Object.values(result.metafile.outputs)[0];
      outputs[relative(process.cwd(), file)] = { ...info, bytes: bytes.length };
      return '/__ssr-client/' + revision + '/' + name;
    })());
    return jobs.get(source);
  }
  return {
    plugin: { name: 'source-bound-browser-workers', setup(builder) {
      builder.onLoad({ filter: /\.ts$/, namespace: 'file' }, async args => {
        const text = readFileSync(args.path, 'utf8');
        const pattern = /new\s+Worker\(\s*new\s+URL\(\s*(['"])([^'"]+\.ts)\1\s*,\s*import\.meta\.url\s*\)/g;
        const matches = [...text.matchAll(pattern)];
        if (!matches.length) return;
        let contents = '', start = 0;
        for (const match of matches) {
          const url = await compile(resolve(dirname(args.path), match[2]));
          contents += text.slice(start, match.index) + 'new Worker(new URL(' + JSON.stringify(url) + ', import.meta.url)';
          start = match.index + match[0].length;
        }
        return { contents: contents + text.slice(start), loader: 'ts', resolveDir: dirname(args.path) };
      });
    } },
    merge(meta) { Object.assign(meta.outputs, outputs); return Object.keys(outputs); },
  };
}
