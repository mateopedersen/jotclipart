import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export async function relatedImpact(
  root,
  previousIds,
  publication,
  { exhaustive = true, baselineRevision } = {},
) {
  const directory = join(root, 'work/delivery-impact');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `analysis-${randomUUID()}.mjs`);
  const oldFile = join(directory, `previous-${randomUUID()}.mjs`);
  try {
    if (baselineRevision) {
      if (!/^[a-f0-9]{40}$/.test(baselineRevision))
        throw Error('Invalid related baseline revision');
      await build({
        stdin: {
          resolveDir: root,
          contents: `export {RelatedIndex} from './src/lib/related/engine.ts';`,
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        packages: 'external',
        outfile: oldFile,
        plugins: [
          {
            name: 'verified-previous-related-data',
            setup(plugin) {
              plugin.onLoad({ filter: /\/data\/.*\.json$/ }, ({ path }) => ({
                contents: execFileSync(
                  'git',
                  ['show', `${baselineRevision}:${relative(root, path)}`],
                  { cwd: root, encoding: 'utf8', maxBuffer: 128_000_000 },
                ),
                loader: 'json',
              }));
            },
          },
        ],
      });
    }
    await build({
      stdin: {
        resolveDir: root,
        sourcefile: 'exact-related-dependency-analysis.mjs',
        contents: `
        import {art} from './src/lib/catalog.ts';
        import {RelatedIndex} from './src/lib/related/engine.ts';
        import {companionSubjects} from './src/lib/related/taxonomy.ts';
        import {analyzeRelatedImpact} from './scripts/delivery/related-impact-core.mjs';
        ${baselineRevision ? `import {RelatedIndex as PreviousIndex} from ${JSON.stringify(oldFile)};` : 'const PreviousIndex=RelatedIndex;'}
        const previousIds=${JSON.stringify(previousIds)}, prior=new Set(previousIds);
        const result=analyzeRelatedImpact(new RelatedIndex(art),
          new PreviousIndex(art.filter(a=>prior.has(a.id))),previousIds,companionSubjects,
          {exhaustive:${JSON.stringify(exhaustive)}});
        console.log('UC_RELATED_IMPACT_RESULT='+JSON.stringify(result));
      `,
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      packages: 'external',
      define: { 'import.meta.env.PUBLIC_ASSET_URLS': JSON.stringify(publication.assetUrls) },
      outfile: file,
    });
    // Import rather than execute the bundle as argv[1]: imported modules' CLI
    // guards must stay false, and all real build defaults use the project cwd.
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'await import(process.argv[2])',
        'uc-related-impact',
        pathToFileURL(file).href,
      ],
      {
        cwd: root,
        env: { ...process.env, CF_PAGES: '1', ASTRO_TELEMETRY_DISABLED: '1' },
        encoding: 'utf8',
        maxBuffer: 32_000_000,
        timeout: 180_000,
      },
    );
    const line = output.split('\n').find((row) => row.startsWith('UC_RELATED_IMPACT_RESULT='));
    if (!line) throw Error('Missing exact related dependency result');
    return JSON.parse(line.slice('UC_RELATED_IMPACT_RESULT='.length));
  } finally {
    rmSync(file, { force: true });
    rmSync(oldFile, { force: true });
  }
}
