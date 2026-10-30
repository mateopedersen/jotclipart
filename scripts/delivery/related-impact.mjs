import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export async function relatedImpact(root, previousIds, publication, { exhaustive = false } = {}) {
  const directory = join(root, 'work/delivery-impact');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `analysis-${randomUUID()}.mjs`);
  try {
    await build({
      stdin: {
        resolveDir: root,
        sourcefile: 'exact-related-dependency-analysis.mjs',
        contents: `
        import {art} from './src/lib/catalog.ts';
        import {RelatedIndex} from './src/lib/related/engine.ts';
        import {companionSubjects} from './src/lib/related/taxonomy.ts';
        import {analyzeRelatedImpact} from './scripts/delivery/related-impact-core.mjs';
        const previousIds=${JSON.stringify(previousIds)}, prior=new Set(previousIds);
        const result=analyzeRelatedImpact(new RelatedIndex(art),
          new RelatedIndex(art.filter(a=>prior.has(a.id))),previousIds,companionSubjects,
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
  }
}
