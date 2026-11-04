// Prevent an old full-build checkout from erasing accepted data-only imports.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
export function sharedContentBaseline(root = process.cwd()) {
  const common = realpathSync(
    resolve(
      root,
      execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
        encoding: 'utf8',
      }).trim(),
    ),
  );
  return join(dirname(common), 'work/catalog-snapshot-content-baseline.json');
}
export function assertLegacySourceMaterialized(root = process.cwd()) {
  const file = sharedContentBaseline(root);
  if (!existsSync(file)) return;
  const state = JSON.parse(readFileSync(file));
  if (state.requiresSourceMaterialization === true)
    throw Error(
      'Verified data-only imports are newer than the static source catalog. Use content:publish or materialize the accepted source capsules before a full legacy deployment.',
    );
}
