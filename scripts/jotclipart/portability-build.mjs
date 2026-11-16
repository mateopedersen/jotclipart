import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// The old-origin helper remains standalone: its reviewed logo is embedded rather
// than fetched from either origin. This does not read browser or user data.
const logo = await readFile('public/brand/jotclipart-logo-3d.webp');
const metadata = await sharp(logo).metadata();
if (metadata.format !== 'webp' || metadata.width !== 1200 || metadata.height !== 314)
  throw new Error('Expected reviewed 1200 by 314 JotClipart wordmark');
const logoSHA = createHash('sha256').update(logo).digest('hex');
const htmlPath = 'public/move-your-work/index.html';
const html = await readFile(htmlPath, 'utf8');
const header = `<header><a href="https://jotclipart.com/" aria-label="JotClipart home"><img src="data:image/webp;base64,${logo.toString('base64')}" alt="JotClipart" width="1200" height="314" data-logo-sha256="${logoSHA}"></a></header>`;
if ((html.match(/<header>[\s\S]*?<\/header>/g) || []).length !== 1)
  throw new Error('Expected one standalone transfer helper header');
await writeFile(htmlPath, html.replace(/<header>[\s\S]*?<\/header>/, header)
  .replace('header svg{width:34px;height:38px}', 'header img{display:block;width:min(236px,70vw);height:auto}'));

await build({
  entryPoints: ['scripts/jotclipart/portability-source.mjs'],
  outfile: 'public/move-your-work/transfer.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  legalComments: 'none',
});
