// Freeze the reviewed critical controller into one CSP-stable literal. Website
// builds validate this result; they never silently rewrite committed source.
import { readFileSync, writeFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { originalImageSchedulingSource, originalImageSchedulingScript } from '../src/lib/original-image-scheduling-inline.mjs';
const code = (await transform(originalImageSchedulingSource, { loader: 'js', target: 'es2022', minify: true, legalComments: 'none' })).code.trim();
if (process.argv.includes('--check')) {
  if (code !== originalImageSchedulingScript) throw Error('Run scripts/compile-original-image-scheduling.mjs and commit the exact generated literal');
} else {
  const file = 'src/lib/original-image-scheduling-inline.mjs';
  const text = readFileSync(file, 'utf8');
  const marker = '\nexport const originalImageSchedulingScript = ';
  const at = text.lastIndexOf(marker);
  if (at < 0 || !text.slice(at).trimEnd().endsWith(';')) throw Error('Expected a single final generated controller literal');
  writeFileSync(file, text.slice(0, at) + marker + JSON.stringify(code) + ';\n');
}
console.log(JSON.stringify({ verified: true, bytes: Buffer.byteLength(code), wroteSource: !process.argv.includes('--check') }));
