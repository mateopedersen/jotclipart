// One-time software/catalog migration only; never the content-only upload path.
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
const root = process.cwd(),
  output = resolve('work/catalog-snapshot/bootstrap-command.mjs');
if (process.argv.length !== 6)
  throw Error(
    'Usage: run-bootstrap prepared-source-dir source-audit search-reconstruction output-dir',
  );
mkdirSync(dirname(output), { recursive: true });
await build({
  entryPoints: ['scripts/catalog-snapshot/prepare-bootstrap.mjs'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  plugins: [
    {
      name: 'retain-native-operator-module-identity',
      setup(b) {
        b.onResolve({ filter: /\.mjs$/ }, (args) => {
          if (args.kind === 'entry-point' || !args.path.startsWith('.')) return;
          const target = resolve(args.resolveDir, args.path);
          if (target.startsWith(resolve(root, 'scripts') + '/'))
            return { path: target, external: true };
        });
      },
    },
  ],
});
await import(pathToFileURL(output));
