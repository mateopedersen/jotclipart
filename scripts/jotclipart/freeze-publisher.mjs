// Local preservation and read-only live control checks. No R2 write or deployment.
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { buildRoot } from './build-root.mjs';
import { verifyOgBuild } from './og-invariants.mjs';
import {
  assertPublisherTarget,
  assertPublisherSoftware,
  publisherRuntimeIdentity,
} from './publisher-target.mjs';

const [releaseArg, outputArg, recordFlag] = process.argv.slice(2);
assert.equal(typeof releaseArg, 'string');
assert.equal(typeof outputArg, 'string');
assert([undefined, '--record-installed'].includes(recordFlag));
const software = resolve(buildRoot(releaseArg)),
  output = resolve(buildRoot(outputArg)),
  root = realpathSync(process.cwd());
assert(!existsSync(output), 'New publisher preservation evidence output required');
assert(
  !output.startsWith(software + sep) && output !== software,
  'Preservation evidence must be outside the frozen compiled tree',
);
const config = JSON.parse(readFileSync('config/content-publisher-public.json'));
const origin = assertPublisherTarget(config),
  code = assertPublisherSoftware(
    JSON.parse(readFileSync(join(software, 'runtime/software-report.json'))),
    config,
  );
const og = verifyOgBuild({ root, buildDirectory: releaseArg, requireIndependentSources: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baseline = JSON.parse(readFileSync('config/jotclipart-migration-baseline.json'));
async function control() {
  const response = await fetch(origin + '/delivery-release.json', {
    redirect: 'error',
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  const value = await response.json();
  assert.equal(value.controlRevision, code.revision);
  assert(/^[a-f0-9]{64}$/.test(value.verifiedRoot));
  assert.equal(response.headers.get('x-uc-snapshot'), value.verifiedRoot);
  assert(value.artworks >= baseline.artworks && value.subjects >= baseline.topics);
  return value;
}
const before = await control(),
  files = new Map();
function include(file, expected) {
  const absolute = realpathSync(file),
    info = lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink());
  assert(
    absolute.startsWith(root + sep),
    'New installed publisher must not depend on another checkout',
  );
  const bytes = readFileSync(file),
    digest = sha(bytes);
  if (expected) assert.equal(digest, expected);
  files.set(absolute, { path: absolute, bytes: bytes.length, sha256: digest });
}
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name),
      info = lstatSync(file);
    assert(!info.isSymbolicLink());
    if (info.isDirectory()) walk(file);
    else include(file);
  }
}
walk(software);
for (const [file, digest] of Object.entries(code.sourceInputs))
  if (!['trusted-public-config', 'http-policy'].includes(file)) include(resolve(file), digest);
for (const asset of code.clientAssets) include(resolve(asset.file), asset.sha256);
include(join(software, 'runtime/worker.mjs'), code.workerSHA256);
include('pnpm-lock.yaml');
include('package.json');
include('config/content-publisher-public.json');
const after = await control();
assert.deepEqual(after, before, 'Live catalog or software changed during publisher preservation');
mkdirSync(output, { recursive: true, mode: 0o700 });
const inventory = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
const manifest = {
  schema: 1,
  status: 'JOTCLIPART_INSTALLED_SOFTWARE_BYTES_AND_TARGET_VERIFIED',
  at: new Date().toISOString(),
  publicOrigin: origin,
  activeKey: config.activeKey,
  software: { ...publisherRuntimeIdentity(code), directory: software },
  og,
  catalog: {
    revision: before.renderedRevision,
    root: before.verifiedRoot,
    artworks: before.artworks,
    topics: before.subjects,
  },
  files: inventory,
  bytes: inventory.reduce((n, file) => n + file.bytes, 0),
  remoteMutations: 0,
  scope:
    'Actual production control/root read twice and exact ABI/source/worker/client bytes. Feature, model, full HTTP and R2 inventory gates remain separate release evidence.',
};
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(output, 'manifest.json'), bytes, { mode: 0o600, flag: 'wx' });
writeFileSync(join(output, 'config.json'), JSON.stringify(config, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
const current = JSON.parse(readFileSync('config/content-publisher.json'));
const installation = {
  ...current,
  status: 'INSTALLED_LIVE_VERIFIED',
  software: manifest.software,
  publicConfig: join(output, 'config.json'),
  lastVerifiedData: manifest.catalog,
  proof: join(output, 'manifest.json'),
  installedRuntimePreservation: join(output, 'manifest.json'),
  preservationManifestSHA256: sha(bytes),
  measurementsScope: manifest.scope,
};
writeFileSync(
  join(output, 'content-publisher-installation.json'),
  JSON.stringify(installation, null, 2) + '\n',
  { mode: 0o600, flag: 'wx' },
);
if (recordFlag)
  writeFileSync('config/content-publisher.json', JSON.stringify(installation, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: manifest.status,
    revision: code.revision,
    abiSHA256: code.abiSHA256,
    workerSHA256: code.workerSHA256,
    catalog: manifest.catalog,
    preservedFiles: inventory.length,
    recordInstalled: !!recordFlag,
    remoteMutations: 0,
  }),
);
