import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OWNER_MANAGED_STORAGE_POLICY } from './release-write-authorization.mjs';

export function publicationSoftwareHash(root) {
  const directories = ['scripts/delivery', 'server/delivery', 'scripts/r2'];
  try {
    lstatSync(join(root, 'server/r2'));
    directories.push('server/r2');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const modules = directories.flatMap((dir) => {
    const stat = lstatSync(join(root, dir));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`Unsafe software directory: ${dir}`);
    return readdirSync(join(root, dir))
      .filter((name) => /\.(mjs|cjs)$/.test(name))
      .map((name) => {
        const source = `${dir}/${name}`, file = lstatSync(join(root, source));
        if (!file.isFile() || file.isSymbolicLink()) throw Error(`Unsafe software source: ${source}`);
        return source;
      });
  });
  const paths = [
    'scripts/deploy.mjs',
    'scripts/verified-source-cache.mjs',
    'scripts/publication-policy.mjs',
    'scripts/asset-representations.mjs',
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
    ...modules,
  ].sort();
  const hash = createHash('sha256');
  for (const path of paths)
    hash
      .update(path + '\0')
      .update(readFileSync(join(root, path)))
      .update('\0');
  return hash.digest('hex');
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const hex40 = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hex64 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Tests affecting the full delivery chain must not silently drop out of recertification. */
export function incrementalFocusedTestPaths(root) {
  const names = readdirSync(join(root, 'tests'))
    .filter((name) => /^(?:delivery-|r2-|publication).*\.mjs$/.test(name));
  for (const name of ['category-ingestion.mjs', 'studio-style-delivery.mjs', 'verified-source-cache.mjs',
    'raster-publication.mjs', 'compiled-publication.mjs'])
    if (!names.includes(name)) names.push(name);
  const paths = names.map((name) => `tests/${name}`).sort();
  for (const required of [
    'tests/delivery-incremental.mjs',
    'tests/delivery-release-staging.mjs',
    'tests/delivery-release-write-authorization.mjs',
    'tests/r2-binding-media.mjs',
    'tests/r2-binding-waves.mjs',
    'tests/r2-ingestion.mjs',
    'tests/publication.mjs',
    'tests/publication-preparation.mjs',
    'tests/raster-publication.mjs',
    'tests/compiled-publication.mjs',
  ]) if (!paths.includes(required)) throw Error(`Missing incremental test: ${required}`);
  return paths;
}

/**
 * Only the new source-bound native/R2 and full-catalog shadow evidence can
 * enable this software. Missing/old/changed proof selects the full path.
 * This is not production activation or an assertion of provider capacity.
 */
export function incrementalEvidenceMatches(root, certificate, evidenceBytes) {
  try {
    if (
      certificate.schema !== 2 ||
      certificate.enabled !== true ||
      certificate.storagePolicy !== OWNER_MANAGED_STORAGE_POLICY ||
      !hex64(certificate.softwareHash) ||
      certificate.softwareHash !== publicationSoftwareHash(root) ||
      typeof certificate.evidence !== 'string' ||
      !/^docs\/delivery-incremental-verification-[a-z0-9-]+\.json$/.test(certificate.evidence) ||
      !hex64(certificate.evidenceSha256)
    ) return false;
    if (sha256(evidenceBytes) !== certificate.evidenceSha256) return false;
    const evidence = JSON.parse(evidenceBytes), shadow = evidence.shadow, browser = evidence.browser,
      unit = evidence.focusedUnitChecks, stage = evidence.nativeWorkers?.staging,
      publicWorker = evidence.nativeWorkers?.public;
    if (
      evidence.schema !== 2 || evidence.status !== 'LOCAL_INCREMENTAL_PUBLISHER_REVALIDATED' ||
      evidence.storagePolicy !== OWNER_MANAGED_STORAGE_POLICY ||
      evidence.softwareHash !== certificate.softwareHash ||
      evidence.notWebsitePublication !== true || evidence.testPublicationBlocked !== true ||
      evidence.remoteTestWrites !== 0 || !hex40(evidence.baselineRevision) ||
      !hex64(evidence.baselineRoot) || !hex40(evidence.shadowRevision) ||
      evidence.baselineRevision === evidence.shadowRevision ||
      shadow?.status !== 'PRIVATE_REAL_CATALOG_INCREMENTAL_SHADOW_VERIFIED_NOT_LIVE' ||
      shadow.baselineRevision !== evidence.baselineRevision || shadow.baselineRoot !== evidence.baselineRoot ||
      shadow.revision !== evidence.shadowRevision || shadow.softwareHash !== evidence.softwareHash ||
      shadow.shadowOnly !== true || shadow.productionPublishingBlocked !== true || shadow.productionWrites !== 0 ||
      !positiveInteger(shadow.artworks) || shadow.artworks <= 50 || shadow.selectedArtworks !== 50 ||
      shadow.renderedHtml !== 100 || shadow.inheritedHtml !== (shadow.artworks - 50) * 2 ||
      !Number.isSafeInteger(shadow.auditPages) || shadow.auditPages < shadow.artworks * 2 ||
      shadow.imageSeoErrors !== 0 || shadow.linkErrors !== 0 || shadow.coreSeoErrors !== 0 ||
      !positiveInteger(unit?.tests) || unit.pass !== unit.tests || unit.fail !== 0 || unit.skipped !== 0 ||
      !Array.isArray(unit.testSources)
    ) return false;
    const expectedTests = incrementalFocusedTestPaths(root), actualTests = unit.testSources;
    if (actualTests.length !== expectedTests.length || unit.tests < expectedTests.length) return false;
    for (let i = 0; i < expectedTests.length; i++)
      if (actualTests[i]?.path !== expectedTests[i] ||
          actualTests[i].sha256 !== sha256(readFileSync(join(root, expectedTests[i])))) return false;
    if (
      stage?.status !== 'PASS_LOCAL_WORKERD_R2' || stage.externalRequests !== 0 ||
      stage.independentlyVerified !== 128 || stage.reusedWithoutReadingBody !== 128 ||
      stage.missingStagedWithFreshReleaseAuthorization !== 1 || stage.nativeSha256Verified !== true ||
      stage.candidateResumeDeletionAndCorruptionRejected !== true ||
      stage.workerSourceSha256 !== sha256(readFileSync(join(root, 'scripts/delivery/staging-worker.mjs'))) ||
      stage.testSourceSha256 !== sha256(readFileSync(join(root, 'tests/e2e/delivery-staging-local.mjs'))) ||
      publicWorker?.status !== 'PASS_LOCAL_PUBLIC_WORKER' ||
      publicWorker.testSourceSha256 !== sha256(readFileSync(join(root, 'tests/e2e/delivery-public-local.mjs'))) ||
      ['relatedRemainsCurrent', 'cardsAndCopyUnchanged', 'nativeRepresentationMatchesPreview',
        'noReferrerRequired', 'sourceBytesUnchanged', 'headAndConditionalCacheValid']
        .some((key) => publicWorker[key] !== true)
    ) return false;
    if (
      browser?.status !== 'PASS_PRIVATE_REAL_CATALOG_BROWSER_NOT_LIVE' ||
      browser.shadowOnly !== true || browser.productionWrites !== 0 ||
      browser.networkRequestsOutsideLoopback !== 0 || browser.localCdnFixture !== true ||
      !Array.isArray(browser.checks) || browser.checks.length !== 8 ||
      !positiveInteger(browser.showMoreClicks)
    ) return false;
    const cases = new Set(), sampleIds = new Map();
    for (const row of browser.checks) {
      if (!['chromium', 'webkit'].includes(row.engine) || ![390, 1440].includes(row.width) ||
          !['newly-rendered', 'inherited'].includes(row.kind) || row.relatedReady !== true ||
          row.editorNoindex !== true || row.noHorizontalOverflow !== true ||
          row.localOriginalImageVerified !== true || typeof row.id !== 'string' || !row.id ||
          row.actualArtifactRevision !== (row.kind === 'newly-rendered' ? evidence.shadowRevision : evidence.baselineRevision))
        return false;
      if (sampleIds.has(row.kind) && sampleIds.get(row.kind) !== row.id) return false;
      sampleIds.set(row.kind, row.id);
      cases.add(`${row.engine}/${row.width}/${row.kind}`);
    }
    return cases.size === 8 && sampleIds.size === 2 &&
      sampleIds.get('newly-rendered') !== sampleIds.get('inherited') &&
      browser.checks.some((row) => row.relatedExpanded === true);
  } catch {
    return false;
  }
}

export function incrementalInstalled(root) {
  try {
    const canonicalRoot = realpathSync(root), config = join(canonicalRoot, 'config/incremental-publisher.json');
    if (lstatSync(config).isSymbolicLink() ||
        !realpathSync(config).startsWith(canonicalRoot + '/config/')) return false;
    const certificate = JSON.parse(readFileSync(config, 'utf8'));
    if (typeof certificate.evidence !== 'string' ||
        !/^docs\/delivery-incremental-verification-[a-z0-9-]+\.json$/.test(certificate.evidence))
      return false;
    const evidenceFile = join(canonicalRoot, certificate.evidence);
    if (lstatSync(evidenceFile).isSymbolicLink() ||
        !realpathSync(evidenceFile).startsWith(canonicalRoot + '/docs/')) return false;
    return incrementalEvidenceMatches(canonicalRoot, certificate, readFileSync(evidenceFile));
  } catch {
    return false;
  }
}
