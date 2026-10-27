import { cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
const source = resolve(process.argv[2] ?? ''),
  target = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3] || source === target || existsSync(target))
  throw Error('Provide the verified live artifact and a new output directory');
const css = readFileSync('src/styles/studio-next.css', 'utf8');
const styleVersion = createHash('sha256').update(css).digest('hex').slice(0, 16);
const original = readFileSync(join(source, '_worker.js'));
if (
  createHash('sha256').update(original).digest('hex') !==
  '2e332fa3055db9870ca24754bd39a840cadc05c2e8c7e7d07495986bc747f2c9'
)
  throw Error('This emergency wrapper is limited to the verified 7ff19d7 live Worker');
cpSync(source, target, { recursive: true, mode: 2 });
writeFileSync(
  join(target, '_routes.json'),
  JSON.stringify({ version: 1, include: ['/*'], exclude: [] }) + '\n',
);
await build({
  stdin: {
    contents: `import original from ${JSON.stringify(join(source, '_worker.js'))};import {fetchAssetWithRetry} from './server/delivery/asset-retry.mjs';import {studioStylePatch,studioStyleRequest} from './server/delivery/studio-styles.mjs';const studio=studioStylePatch(${JSON.stringify(css)},${JSON.stringify(styleVersion)});export default {async fetch(request,env,context){const response=await original.fetch(studioStyleRequest(request),{...env,ASSETS:{fetch:q=>fetchAssetWithRetry(q,env.ASSETS)}},context);return studio(request,response);}};`,
    resolveDir: process.cwd(),
    sourcefile: 'asset-origin-hotfix.mjs',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  outfile: join(target, '_worker.js'),
});
writeFileSync(
  join(target, '../asset-hotfix-proof.json'),
  JSON.stringify(
    {
      source,
      output: target,
      htmlRevision: '7ff19d7c7b88071855d500b49d719d0e28ff65db',
      change:
        'Verified native files unchanged; Worker retries transient reads and adds the current committed shared Studio CSS only to successful Studio HTML responses',
      styleVersion,
      workerSha256: createHash('sha256')
        .update(readFileSync(join(target, '_worker.js')))
        .digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
console.log('Prepared read-only static retry wrapper for the verified live artifact');
