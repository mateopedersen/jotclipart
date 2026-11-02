import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { publicationSoftwareHash, incrementalInstalled, incrementalFocusedTestPaths, incrementalRuntimeIdentity } from '../scripts/delivery/installer.mjs';
import { OWNER_MANAGED_STORAGE_POLICY } from '../scripts/delivery/release-write-authorization.mjs';
import { awaitPublicationWriter } from '../scripts/delivery/publication-lock.mjs';
import { acquireAccountWriter } from '../scripts/delivery/account-lock.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const nativeInputs = [
  'clonefile.c', 'clonefile.node', 'attested-native-loader.mjs', 'build-private.sh',
  'node-api-headers/node_api.h', 'node-api-headers/node_api_types.h',
  'node-api-headers/js_native_api.h', 'node-api-headers/js_native_api_types.h',
  'node-api-headers/LICENSE', 'node-api-headers/SHA256SUMS',
].map((p) => `scripts/delivery/native-clone/${p}`);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'uc-installer-'));
  const put = (path, text) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const paths = [
    'scripts/deploy.mjs', 'scripts/verified-source-cache.mjs', 'scripts/publication-policy.mjs',
    'scripts/asset-representations.mjs',
    'scripts/restore-assets.mjs', 'scripts/production-public-assets.mjs', 'scripts/seo/indexnow-release.mjs',
    'scripts/seo/image-seo.mjs', 'scripts/seo/build-image-seo.mjs', 'scripts/performance/serve.mjs',
    'src/lib/delivery-build-scope.ts', 'src/pages/art/[id].astro', 'src/pages/edit/[id].astro',
    'astro.config.mjs', 'package.json', 'pnpm-lock.yaml', 'scripts/delivery/installer.mjs',
    'scripts/delivery/release-write-authorization.mjs', 'scripts/delivery/staging-worker.mjs',
    'scripts/r2/prepare-publication.mjs', 'scripts/r2/reviewed-binding-input.mjs',
    'scripts/r2/binding-ingest.mjs', 'server/r2/private-ingest.mjs',
    'server/delivery/public-files.mjs', 'tests/delivery-incremental.mjs', 'tests/delivery-independent-copy.mjs',
    'tests/delivery-release-staging.mjs', 'tests/delivery-release-write-authorization.mjs',
    'tests/r2-binding-media.mjs', 'tests/r2-binding-waves.mjs', 'tests/r2-ingestion.mjs',
    'tests/publication.mjs', 'tests/publication-preparation.mjs',
    'tests/raster-publication.mjs', 'tests/compiled-publication.mjs',
    'tests/category-ingestion.mjs', 'tests/studio-style-delivery.mjs', 'tests/verified-source-cache.mjs',
    'tests/e2e/delivery-public-local.mjs', 'tests/e2e/delivery-staging-local.mjs', ...nativeInputs,
  ];
  for (const path of paths) put(path, `fixture ${path}`);
  const softwareHash = publicationSoftwareHash(root), runtimeIdentity = incrementalRuntimeIdentity(root), baselineRevision = 'a'.repeat(40),
    shadowRevision = 'b'.repeat(40), baselineRoot = 'c'.repeat(64);
  const browserChecks = [];
  for (const engine of ['chromium', 'webkit']) for (const width of [390, 1440])
    for (const kind of ['newly-rendered', 'inherited']) browserChecks.push({engine, width, kind,
      id:kind === 'inherited' ? 'old-sample' : 'selected-sample', relatedReady:true,
      relatedExpanded:kind === 'inherited', editorNoindex:true, noHorizontalOverflow:true, localOriginalImageVerified:true,
      actualArtifactRevision:kind === 'inherited' ? baselineRevision : shadowRevision});
  const evidence = {schema:2, status:'LOCAL_INCREMENTAL_PUBLISHER_REVALIDATED',
    storagePolicy:OWNER_MANAGED_STORAGE_POLICY, softwareHash, runtimeIdentity, baselineRevision, baselineRoot, shadowRevision,
    notWebsitePublication:true, testPublicationBlocked:true, remoteTestWrites:0,
    shadow:{status:'PRIVATE_REAL_CATALOG_INCREMENTAL_SHADOW_VERIFIED_NOT_LIVE', baselineRevision,
      baselineRoot, revision:shadowRevision, softwareHash, shadowOnly:true, productionPublishingBlocked:true,
      productionWrites:0, artworks:100, selectedArtworks:50, renderedHtml:100, inheritedHtml:100,
      auditPages:201, imageSeoErrors:0, linkErrors:0, coreSeoErrors:0},
    nativeCopyProbe:{status:'PASS_LOCAL_INDEPENDENT_COPY',copyBackend:runtimeIdentity.copyBackend,
      independentInode:true,sourceUnaffectedByTargetMutation:true,
      compressedRoundTrip:runtimeIdentity.platform==='darwin'?true:null,
      testSourceSha256:sha(readFileSync(join(root,'tests/delivery-independent-copy.mjs')))},
    focusedUnitChecks:{tests:200, pass:200, fail:0, skipped:0,
      testSources:incrementalFocusedTestPaths(root).map(path=>({path,sha256:sha(readFileSync(join(root,path)))}))},
    nativeWorkers:{public:{status:'PASS_LOCAL_PUBLIC_WORKER',relatedRemainsCurrent:true,cardsAndCopyUnchanged:true,
      nativeRepresentationMatchesPreview:true,noReferrerRequired:true,sourceBytesUnchanged:true,
      headAndConditionalCacheValid:true,testSourceSha256:sha(readFileSync(join(root,'tests/e2e/delivery-public-local.mjs')))},
     staging:{status:'PASS_LOCAL_WORKERD_R2',independentlyVerified:128,reusedWithoutReadingBody:128,
      missingStagedWithFreshReleaseAuthorization:1,nativeSha256Verified:true,
      candidateResumeDeletionAndCorruptionRejected:true,externalRequests:0,
      workerSourceSha256:sha(readFileSync(join(root,'scripts/delivery/staging-worker.mjs'))),
      testSourceSha256:sha(readFileSync(join(root,'tests/e2e/delivery-staging-local.mjs')))}},
    browser:{status:'PASS_PRIVATE_REAL_CATALOG_BROWSER_NOT_LIVE',shadowOnly:true,productionWrites:0,
      networkRequestsOutsideLoopback:0,localCdnFixture:true,showMoreClicks:4,checks:browserChecks},
  };
  const install = (value = evidence, overrides = {}) => {
    const bytes=JSON.stringify(value),evidencePath='docs/delivery-incremental-verification-fixture.json';
    put(evidencePath,bytes);
    const cert={schema:2,enabled:true,storagePolicy:OWNER_MANAGED_STORAGE_POLICY,softwareHash,runtimeIdentity,
      evidence:evidencePath,evidenceSha256:sha(bytes),...overrides};
    put('config/incremental-publisher.json',JSON.stringify(cert));
  };
  return {root,put,evidence,install,close:()=>rmSync(root,{recursive:true,force:true})};
}

test('all native clone sources, binary, recipe and headers invalidate stale certification', () => {
  const f = fixture();
  try {
    f.install();
    const before = publicationSoftwareHash(f.root);
    for (const path of nativeInputs) {
      f.put(path, 'changed native component');
      assert.notEqual(publicationSoftwareHash(f.root), before, path);
      assert.equal(incrementalInstalled(f.root), false, path);
      f.put(path, `fixture ${path}`);
      assert.equal(incrementalInstalled(f.root), true, path);
    }
    const binary = join(f.root, nativeInputs[1]);
    unlinkSync(binary);
    symlinkSync('clonefile.c', binary);
    assert.throws(() => publicationSoftwareHash(f.root), /Unsafe software source/);
    assert.equal(incrementalInstalled(f.root), false);
  } finally { f.close(); }
});

test('incremental proof is bound to the tested platform, architecture, Node-API and copy backend', () => {
  const f = fixture();
  try {
    f.install(); assert.equal(incrementalInstalled(f.root), true);
    const changes = [
      r => { r.platform = 'other-platform'; },
      r => { r.arch = 'other-arch'; },
      r => { r.nodeApiVersion++; },
      r => { r.copyBackend = 'other-backend'; },
      r => { r.nativeBinarySha256 = '0'.repeat(64); },
    ];
    for (const change of changes) {
      const wrong = structuredClone(f.evidence.runtimeIdentity); change(wrong);
      f.install(f.evidence, { runtimeIdentity: wrong });
      assert.equal(incrementalInstalled(f.root), false);
      const evidence = structuredClone(f.evidence); evidence.runtimeIdentity = wrong;
      f.install(evidence); assert.equal(incrementalInstalled(f.root), false);
    }
    for (const key of ['independentInode', 'sourceUnaffectedByTargetMutation']) {
      const evidence = structuredClone(f.evidence); evidence.nativeCopyProbe[key] = false;
      f.install(evidence); assert.equal(incrementalInstalled(f.root), false);
    }
    if (process.platform === 'darwin') {
      const evidence = structuredClone(f.evidence); evidence.nativeCopyProbe.compressedRoundTrip = false;
      f.install(evidence); assert.equal(incrementalInstalled(f.root), false);
    }
  } finally { f.close(); }
});

test('only matching full-source, fresh-authorization and browser evidence enables incremental use', () => {
  const f=fixture();try {
    assert.equal(incrementalInstalled(f.root),false);
    f.install();assert.equal(incrementalInstalled(f.root),true);
    f.put('scripts/deploy.mjs','changed software');assert.equal(incrementalInstalled(f.root),false);
    f.put('scripts/deploy.mjs','fixture scripts/deploy.mjs');assert.equal(incrementalInstalled(f.root),true);
    f.install(f.evidence,{enabled:false});assert.equal(incrementalInstalled(f.root),false);
    f.install(f.evidence,{schema:1});assert.equal(incrementalInstalled(f.root),false);
    f.install(f.evidence,{storagePolicy:'legacy-quota'});assert.equal(incrementalInstalled(f.root),false);
    f.install(f.evidence,{evidence:'../outside.json'});assert.equal(incrementalInstalled(f.root),false);
    f.install();f.put('docs/delivery-incremental-verification-fixture.json','{}');assert.equal(incrementalInstalled(f.root),false);
    f.install();const evidencePath=join(f.root,'docs/delivery-incremental-verification-fixture.json');
    f.put('docs/other.json',readFileSync(evidencePath));unlinkSync(evidencePath);symlinkSync('other.json',evidencePath);
    assert.equal(incrementalInstalled(f.root),false);
  } finally {f.close();}
});

test('legacy lease field, fake source hash, wrong policy or skipped checks never certify the new Worker', () => {
  const f=fixture();try {
    const variants=[
      x=>{delete x.nativeWorkers.staging.missingStagedWithFreshReleaseAuthorization;x.nativeWorkers.staging.missingStagedWithFreshLease=1;},
      x=>{x.nativeWorkers.staging.workerSourceSha256='0'.repeat(64);},
      x=>{x.nativeWorkers.staging.testSourceSha256='0'.repeat(64);},
      x=>{x.nativeWorkers.staging.externalRequests=1;},
      x=>{x.nativeWorkers.staging.candidateResumeDeletionAndCorruptionRejected=false;},
      x=>{x.nativeWorkers.public.relatedRemainsCurrent=false;},
      x=>{x.storagePolicy='legacy-quota';},
      x=>{x.focusedUnitChecks.skipped=1;},
      x=>{x.focusedUnitChecks.testSources=x.focusedUnitChecks.testSources.filter(r=>r.path!=='tests/r2-binding-waves.mjs');},
    ];
    for(const change of variants){const x=structuredClone(f.evidence);change(x);f.install(x);assert.equal(incrementalInstalled(f.root),false);}
    f.install();f.put('tests/r2-binding-media.mjs','changed test source');assert.equal(incrementalInstalled(f.root),false);
  }finally{f.close();}
});

test('every R2 preparation module and publication test source invalidates stale certification', () => {
  const f=fixture();try {
    f.install();assert.equal(incrementalInstalled(f.root),true);
    const before=publicationSoftwareHash(f.root);
    f.put('scripts/r2/prepare-publication.mjs','changed preparation only');
    assert.notEqual(publicationSoftwareHash(f.root),before);
    assert.equal(incrementalInstalled(f.root),false);
    f.put('scripts/r2/prepare-publication.mjs','fixture scripts/r2/prepare-publication.mjs');
    assert.equal(incrementalInstalled(f.root),true);
    f.put('scripts/r2/new-reader.mjs','new critical transport');
    assert.notEqual(publicationSoftwareHash(f.root),before);
    assert.equal(incrementalInstalled(f.root),false);
    rmSync(join(f.root,'scripts/r2/new-reader.mjs'));
    assert.equal(incrementalInstalled(f.root),true);
    symlinkSync('binding-ingest.mjs',join(f.root,'scripts/r2/new-reader.mjs'));
    assert.throws(()=>publicationSoftwareHash(f.root),/Unsafe software source/);
    assert.equal(incrementalInstalled(f.root),false);
    unlinkSync(join(f.root,'scripts/r2/new-reader.mjs'));
    assert.equal(incrementalInstalled(f.root),true);
    f.put('server/r2/private-ingest.mjs','changed server transport');
    assert.notEqual(publicationSoftwareHash(f.root),before);
    assert.equal(incrementalInstalled(f.root),false);
    f.put('server/r2/private-ingest.mjs','fixture server/r2/private-ingest.mjs');
    assert.equal(incrementalInstalled(f.root),true);
    f.put('scripts/asset-representations.mjs','changed asset validation');
    assert.notEqual(publicationSoftwareHash(f.root),before);
    assert.equal(incrementalInstalled(f.root),false);
    f.put('scripts/asset-representations.mjs','fixture scripts/asset-representations.mjs');
    assert.equal(incrementalInstalled(f.root),true);
    f.put('tests/publication-preparation.mjs','changed publication preparation tests');
    assert.equal(incrementalInstalled(f.root),false);
  }finally{f.close();}
});

test('shadow coverage, real browser cases and no production writes are required', () => {
  const f=fixture();try {
    const variants=[
      x=>{x.shadow.selectedArtworks=49;}, x=>{x.shadow.inheritedHtml--;},x=>{x.shadow.linkErrors=1;},
      x=>{x.shadow.productionPublishingBlocked=false;},x=>{x.remoteTestWrites=1;},
      x=>{x.browser.checks[0]=structuredClone(x.browser.checks[1]);},
      x=>{x.browser.showMoreClicks=0;},x=>{x.browser.networkRequestsOutsideLoopback=1;},
      x=>{x.browser.checks[0].localOriginalImageVerified=false;},
      x=>{for(const row of x.browser.checks)row.relatedExpanded=false;},
    ];
    for(const change of variants){const x=structuredClone(f.evidence);change(x);f.install(x);assert.equal(incrementalInstalled(f.root),false);}
  }finally{f.close();}
});

test('whole-publication serialization does not deadlock the child R2 writer or remove another publisher lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uc-publisher-lock-')),
    env = { UC_R2_LOCK_ROOT: directory };
  let first, r2;
  try {
    first = await awaitPublicationWriter(env);
    r2 = acquireAccountWriter(env);
    const publicationLock = join(
      directory,
      '.ultraclipart-publication/.ultraclipart-r2-writer.lock',
    );
    const before = readFileSync(publicationLock, 'utf8');
    await assert.rejects(awaitPublicationWriter(env, { timeoutMs: 10, pollMs: 1 }), /preserved/);
    assert.equal(readFileSync(publicationLock, 'utf8'), before);
    r2();
    r2 = null;
    first();
    first = null;
    const next = await awaitPublicationWriter(env, { timeoutMs: 100, pollMs: 1 });
    next();
    assert.equal(existsSync(publicationLock), false);
  } finally {
    r2?.();
    first?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
