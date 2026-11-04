import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  chmodSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';

// Owner-requested local preservation. Never publish, remove sources or copy
// credential directories. An interrupted snapshot is never marked complete.
const root = resolve(import.meta.dirname, '../..');
const destination = resolve(process.argv[2] ?? '');
if (process.argv.length !== 3 || destination === root || destination.startsWith(root + '/'))
  throw Error('Supply an independent backup directory outside the repository.');
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = git('rev-parse', 'HEAD').trim();
const branch = git('symbolic-ref', '--short', 'HEAD').trim();
const trackedPatch = git('diff', '--binary', 'HEAD');
const common = realpathSync(resolve(root, git('rev-parse', '--git-common-dir').trim()));
const primary = dirname(common);
const reportPath = join(primary, 'work/remaining-cloudflare-production-report.json');
const reportBytes = readFileSync(reportPath);
const report = JSON.parse(reportBytes);
const liveRevision = report.revision ?? report.sourceRevision ?? report.renderedRevision;
if (!/^[a-f0-9]{40}$/.test(liveRevision ?? ''))
  throw Error('A verified production revision is required.');
// Content revisions are signed data epochs; sourceCommit is the Git restoration
// anchor when the build-free publisher generated the public revision.
const liveSourceCommit = report.catalogSourceCommit ?? report.sourceCommit ?? liveRevision;
git('cat-file', '-e', `${liveSourceCommit}^{commit}`);
mkdirSync(destination, { recursive: true, mode: 0o700 });
if (realpathSync(destination).startsWith(realpathSync(root) + '/'))
  throw Error('Backup destination resolves inside the working repository.');
const id =
  new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + revision.slice(0, 12);
const pending = join(destination, id + '.incomplete');
const final = join(destination, id);
mkdirSync(pending, { mode: 0o700 });
const files = [];
function record(name, bytes, mode = 0o600) {
  const target = join(pending, name);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, bytes, { flag: 'wx', mode });
  files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
}
function copy(source, name, executable = false) {
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Expected a regular file: ${name}`);
  const bytes = readFileSync(source);
  record(name, bytes, executable ? 0o700 : 0o600);
  if (!readFileSync(source).equals(bytes)) throw Error(`Source changed during backup: ${name}`);
}
function tree(source, target) {
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error('Unexpected link in preserved state.');
    if (entry.isDirectory()) tree(join(source, entry.name), target + '/' + entry.name);
    else copy(join(source, entry.name), target + '/' + entry.name);
  }
}

const bundle = join(pending, 'publisher.bundle');
execFileSync('git', ['-C', root, 'bundle', 'create', bundle, `refs/heads/${branch}`], {
  stdio: 'pipe',
});
execFileSync('git', ['-C', root, 'bundle', 'verify', bundle], { stdio: 'pipe' });
for (const [name, args] of [['source.tar.gz', ['archive', '--format=tar.gz', revision]]]) {
  record(name, execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024 }));
}
chmodSync(bundle, 0o600);
const bundleBytes = readFileSync(bundle);
files.push({ path: 'publisher.bundle', bytes: bundleBytes.length, sha256: sha(bundleBytes) });
record('pending-tracked-changes.patch', Buffer.from(trackedPatch));
copy(process.execPath, 'runtime/node', true);
copy(join(root, 'scripts/delivery/backup.mjs'), 'backup-tool-source.mjs');
record('evidence/production-report.json', reportBytes);
for (const name of ['production-pages-latest.json']) {
  if (existsSync(join(primary, 'work', name)))
    copy(join(primary, 'work', name), 'evidence/' + name);
}
for (const name of [
  'verified-manifest.json',
  'verified.jsonl',
  'prepared-release.json',
  'indexnow-snapshot.json',
  'indexnow-notification.json',
  'release-budget.json',
]) {
  const source = join(root, 'work/delivery', liveRevision, name);
  if (existsSync(source)) copy(source, 'evidence/delivery/' + liveRevision + '/' + name);
}
tree(join(primary, '.indexnow'), 'state/indexnow');
for (const name of [
  'continuation.md',
  'critical-tests.log',
  'workerd-local.log',
  'public-local.log',
  'astro-check.log',
]) {
  const source = join(root, 'work/delivery-speedup-20261030', name);
  if (existsSync(source)) copy(source, 'pending/' + name);
}
const preserve = `# UltraClipart publisher — DO NOT DELETE\n\nThis independent local backup is application source, not a disposable Codex build.\nSource: ${revision}\nBranch: ${branch}\nRecorded verified live source: ${liveRevision}\nIncremental installer: inspect config/incremental-publisher.json; a saved candidate is not proof of live installation.\n\nDo not delete this directory during chat deletion, Codex cleanup, cache cleanup or build cleanup.\nThe source, standalone runtime, catalog, editorial reviews and restore evidence are included.\nNative binary originals and the complete rollback build remain in the accepted repository; this compact software backup does not replace them.\nCloudflare credentials and signing keys are deliberately absent. This is not a cloud/off-device backup.\n\nVerification (no publication):\n  ./runtime/node verify.mjs\n\nRestore into a NEW directory, never over an active publisher:\n  git clone --branch ${branch} publisher.bundle /absolute/path/to/new-ultraclipart\nThen compare git rev-parse HEAD with the source above.\nThe source.tar.gz is an independent source export if Git is temporarily unavailable.\nReview pending-tracked-changes.patch before applying it with git apply; it may contain unrelated owner work.\nRestore state/indexnow as .indexnow under the NEW repository's actual Git common directory parent; preserve existing state rather than overwrite it.\nKeep evidence/delivery receipts and production records; their paths may need deliberate relocation after restoring.\nUse runtime/node for Node; restore pinned dependencies with package.json's packageManager and pnpm-lock.yaml. Dependencies may require network access.\nRead AGENTS.md, docs/catalog-scale.md, docs/delivery-incremental.md and docs/publisher-preservation.md.\nCheck the actual live release and account/publication writer locks before any new build or activation.\nReauthenticate locally when needed; never copy credentials into this directory.\nOriginal public asset restoration uses scripts/restore-assets.mjs and exact checksum verification.\nRestoring never authorizes or triggers publication.\n`;
record('RESTORE-DO-NOT-DELETE.md', Buffer.from(preserve));
const verifier = `import {readFileSync,lstatSync} from 'node:fs';\nimport {resolve,sep} from 'node:path';\nimport {createHash} from 'node:crypto';\nconst root=import.meta.dirname; const manifest=JSON.parse(readFileSync(resolve(root,'backup-manifest.json')));\nlet count=0; for(const file of manifest.files){const path=resolve(root,file.path); if(!path.startsWith(root+sep)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()) throw Error('Unsafe backup member'); const bytes=readFileSync(path);if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Backup checksum mismatch: '+file.path);count++;}\nconsole.log(JSON.stringify({verified:true,files:count,revision:manifest.revision,liveRevision:manifest.liveRevision}));\n`;
record('verify.mjs', Buffer.from(verifier));
if (
  git('rev-parse', 'HEAD').trim() !== revision ||
  git('diff', '--binary', 'HEAD') !== trackedPatch ||
  !readFileSync(reportPath).equals(reportBytes)
)
  throw Error('Repository or production record changed; retain incomplete backup and retry.');
const ledgerSource = join(primary, '.indexnow/accepted.json');
if (
  existsSync(ledgerSource) &&
  !readFileSync(ledgerSource).equals(readFileSync(join(pending, 'state/indexnow/accepted.json')))
)
  throw Error('IndexNow accepted state changed during backup; retry.');
writeFileSync(
  join(pending, 'backup-manifest.json'),
  JSON.stringify(
    { schema: 1, createdAt: new Date().toISOString(), revision, liveRevision, branch, files },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
execFileSync(join(pending, 'runtime/node'), [join(pending, 'verify.mjs')], { stdio: 'pipe' });
renameSync(pending, final);
// Completed versioned snapshots remain readable/restorable, but ordinary Mac
// cleanup cannot unlink them without explicitly clearing the owner lock.
if (process.platform === 'darwin')
  execFileSync('/usr/bin/chflags', ['-R', 'uchg', final], { stdio: 'pipe' });
writeFileSync(
  join(destination, 'LATEST.json'),
  JSON.stringify(
    {
      snapshot: id,
      revision,
      liveRevision,
      manifestSha256: sha(readFileSync(join(final, 'backup-manifest.json'))),
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
writeFileSync(
  join(destination, 'DO-NOT-DELETE.md'),
  `# KEEP — UltraClipart publisher\n\nOwner-protected independent software backup. Do not delete during Codex/chat/build/cache cleanup.\nRead LATEST.json, then the snapshot's RESTORE-DO-NOT-DELETE.md.\nLocal backup; no credentials, no automatic publication, no off-device protection.\n`,
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    backup: final,
    revision,
    liveRevision,
    verified: true,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
  }),
);
