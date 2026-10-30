import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function publicationSoftwareHash(root) {
  const paths = [
    'scripts/deploy.mjs',
    'scripts/verified-source-cache.mjs',
    'scripts/publication-policy.mjs',
    'scripts/restore-assets.mjs',
    'scripts/production-public-assets.mjs',
    'scripts/seo/indexnow-release.mjs',
    'scripts/seo/image-seo.mjs',
    'scripts/seo/build-image-seo.mjs',
    'scripts/performance/serve.mjs',
    'src/lib/delivery-build-scope.ts',
    'src/pages/art/[id].astro',
    'src/pages/edit/[id].astro',
    'astro.config.mjs',
    'package.json',
    'pnpm-lock.yaml',
    ...['scripts/delivery', 'server/delivery'].flatMap((dir) =>
      readdirSync(join(root, dir))
        .filter((name) => /\.(mjs|cjs)$/.test(name))
        .map((name) => `${dir}/${name}`),
    ),
  ].sort();
  const hash = createHash('sha256');
  for (const path of paths)
    hash
      .update(path + '\0')
      .update(readFileSync(join(root, path)))
      .update('\0');
  return hash.digest('hex');
}

export function incrementalInstalled(root) {
  try {
    const certificate = JSON.parse(
      readFileSync(join(root, 'config/incremental-publisher.json'), 'utf8'),
    );
    return (
      certificate.schema === 1 &&
      certificate.enabled === true &&
      certificate.softwareHash === publicationSoftwareHash(root) &&
      certificate.checks?.unitFailed === 0 &&
      certificate.checks.unitPassed > 0 &&
      certificate.checks.shadowBuildVerified === true &&
      certificate.checks.relatedNativeVerified === true
    );
  } catch {
    return false;
  }
}
