import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createIndependentCopier } from '../scripts/delivery/independent-copy.mjs';
import { loadPinnedNative } from '../scripts/delivery/native-clone/attested-native-loader.mjs';

const mac = process.platform === 'darwin' && process.arch === 'arm64';
const linux = process.platform === 'linux' && fs.existsSync('/proc/self/fd');
const macTest = mac ? test : () => {};
const linuxTest = linux ? test : () => {};
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'uc-independent-copy-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');

linuxTest('Linux attempts reflink, bounds real unsupported fallback and never overwrites by default', () => {
  const root = tmp();
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'target');
    fs.mkdirSync(source); fs.mkdirSync(target);
    const src = path.join(source, 'file'), dst = path.join(target, 'file');
    fs.writeFileSync(src, 'source bytes');
    const copier = createIndependentCopier({ sourceRoot: source, destinationRoot: target, minFreeBytes: 0 });
    const result = copier.copy(src, dst);
    assert(['linux-ficlone', 'bounded-physical-copy'].includes(result.method));
    assert.equal(fs.readFileSync(dst, 'utf8'), 'source bytes');
    assert.notEqual(fs.statSync(src).ino, fs.statSync(dst).ino);
    assert.throws(() => copier.copy(src, dst), (e) => e.code === 'EEXIST');
    fs.writeFileSync(dst, 'old');
    copier.copy(src, dst, { replaceExisting: true });
    fs.writeFileSync(dst, 'new');
    assert.equal(fs.readFileSync(src, 'utf8'), 'source bytes');
    assert(copier.stats().fallbackBytes <= copier.stats().maxFallbackBytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

macTest('independent clone uses a distinct inode and explicit overwrite is atomic and scoped', () => {
  const root = tmp();
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'target');
    fs.mkdirSync(source); fs.mkdirSync(target);
    const bytes = randomBytes(128 * 1024), src = path.join(source, 'Türkçe-🖼️.html'), dst = path.join(target, 'copy.html');
    fs.writeFileSync(src, bytes);
    const copier = createIndependentCopier({ sourceRoot: source, destinationRoot: target, minFreeBytes: 0 });
    const expectedSourceIdentity = identity(fs.statSync(src, { bigint: true }));
    assert.equal(copier.copy(src, dst, { expectedSourceIdentity }).method, 'darwin-fclonefileat');
    assert.notEqual(fs.statSync(src).ino, fs.statSync(dst).ino);
    assert.deepEqual(fs.readFileSync(dst), bytes);
    assert.throws(() => copier.copy(src, dst), (e) => e.code === 'EEXIST');
    fs.writeFileSync(dst, 'old build output');
    assert.equal(copier.copy(src, dst, { replaceExisting: true, ownerWritable: true }).method, 'darwin-fclonefileat');
    assert.deepEqual(fs.readFileSync(dst), bytes);
    fs.writeFileSync(dst, 'new build output');
    assert.deepEqual(fs.readFileSync(src), bytes);
    assert.equal(copier.stats().clones, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

macTest('scope, symlinks, source identity and reserve fail closed before creating output', () => {
  const root = tmp();
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'target'), outside = path.join(root, 'outside');
    for (const d of [source, target, outside]) fs.mkdirSync(d);
    const src = path.join(source, 'one'), dst = path.join(target, 'one'); fs.writeFileSync(src, 'source');
    const copier = createIndependentCopier({ sourceRoot: source, destinationRoot: target, minFreeBytes: 0 });
    assert.throws(() => copier.copy(src, dst, { expectedSourceIdentity: 'changed' }), /identity/);
    assert(!fs.existsSync(dst));
    fs.symlinkSync(src, path.join(source, 'link'));
    assert.throws(() => copier.copy(path.join(source, 'link'), dst), /symlink/);
    fs.symlinkSync(outside, path.join(target, 'dir-link'));
    assert.throws(() => copier.copy(src, path.join(target, 'dir-link', 'bad')), /symlink/);
    assert.throws(() => copier.copy(src, path.join(outside, 'bad')), /outside/);
    const link = path.join(target, 'existing-link'); fs.symlinkSync(src, link);
    assert.throws(() => copier.copy(src, link, { replaceExisting: true }), /independent regular/);
    const low = createIndependentCopier({ sourceRoot: source, destinationRoot: target, minFreeBytes: Number.MAX_SAFE_INTEGER });
    assert.throws(() => low.copy(src, dst), /reserve/);
    assert(!fs.existsSync(dst)); assert.equal(fs.readFileSync(src, 'utf8'), 'source');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

macTest('actual cross-volume fallback is explicit and bounded across the copier lifetime', () => {
  const root = tmp(), source = '/System/Library/CoreServices/SystemVersion.plist';
  try {
    const n = fs.statSync(source).size;
    const limited = createIndependentCopier({ sourceRoot: path.dirname(source), destinationRoot: root, minFreeBytes: 0, maxFallbackBytes: n - 1 });
    assert.throws(() => limited.copy(source, path.join(root, 'denied')), /budget/);
    assert(!fs.existsSync(path.join(root, 'denied')));
    const copier = createIndependentCopier({ sourceRoot: path.dirname(source), destinationRoot: root, minFreeBytes: 0, maxFallbackBytes: n });
    assert.equal(copier.copy(source, path.join(root, 'one')).method, 'bounded-physical-copy');
    assert.deepEqual(fs.readFileSync(path.join(root, 'one')), fs.readFileSync(source));
    assert.equal(fs.statSync(path.join(root, 'one')).mode & 0o777, fs.statSync(source).mode & 0o777);
    assert.throws(() => copier.copy(source, path.join(root, 'two')), /budget/);
    assert(!fs.existsSync(path.join(root, 'two')));
    assert.equal(copier.stats().fallbackBytes, n);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

macTest('native fd arguments and pinned inode identities prevent path redirection', () => {
  const root = tmp();
  try {
    const srcDir = path.join(root, 'src'), dstDir = path.join(root, 'dst'), outside = path.join(root, 'outside');
    for (const d of [srcDir, dstDir, outside]) fs.mkdirSync(d);
    const source = path.join(srcDir, 'source'), moved = dstDir + '-moved'; fs.writeFileSync(source, 'source bytes');
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const dirFd = fs.openSync(dstDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW), n = loadPinnedNative();
    try {
      for (const bad of ['', '.', '..', '../escape', 'a/b', 'a\0b', 'a\ud800', 'a\udc00'])
        assert.throws(() => n.cloneFd(sourceFd, dirFd, bad));
      assert.throws(() => n.cloneFd(sourceFd, dirFd, 'a', 'extra'));
      assert.throws(() => n.cloneFd(-1, dirFd, 'a'));
      fs.renameSync(dstDir, moved); fs.symlinkSync(outside, dstDir);
      const targetFd = n.cloneFd(sourceFd, dirFd, 'anchored'); fs.closeSync(targetFd);
      assert.equal(fs.readFileSync(path.join(moved, 'anchored'), 'utf8'), 'source bytes');
      assert(!fs.existsSync(path.join(outside, 'anchored')));
    } finally { fs.closeSync(sourceFd); fs.closeSync(dirFd); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

macTest('native files and reproducible build reject source, header and binary changes', () => {
  const root = tmp(), original = path.resolve('scripts/delivery/native-clone'), source = path.join(root, 'native'), out = path.join(root, 'out');
  try {
    fs.cpSync(original, source, { recursive: true }); fs.mkdirSync(out);
    const build = () => spawnSync('/bin/sh', [path.join(source, 'build-private.sh'), out], { encoding: 'utf8' });
    const r = build(); assert.equal(r.status, 0, r.stderr);
    const expected = sha(fs.readFileSync(path.join(original, 'clonefile.node')));
    assert.equal(sha(fs.readFileSync(path.join(out, 'clonefile.node'))), expected);
    assert.notEqual(build().status, 0);
    for (const name of ['clonefile.node', 'clonefile.c', 'node-api-headers/node_api.h']) {
      const copy = path.join(root, name.replaceAll('/', '-') + '-fixture');
      fs.cpSync(original, copy, { recursive: true }); fs.appendFileSync(path.join(copy, name), 'changed');
      const code = `import(${JSON.stringify(new URL('file://' + path.join(copy, 'attested-native-loader.mjs')).href)}).then(m=>m.loadPinnedNative()).then(()=>process.exit(1)).catch(()=>process.exit(0))`;
      assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code]).status, 0);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const compressedTest = mac && process.env.UC_ALLOW_HFS_COMPRESSION_FIXTURE === '1' ? test : () => {};
compressedTest('macOS compressed HTML remains compressed after an independent clone', () => {
  const root = tmp();
  try {
    const input = path.join(root, 'input'), source = path.join(root, 'compressed'), target = path.join(root, 'target');
    fs.mkdirSync(input); fs.mkdirSync(target);
    const body = Buffer.from('<html>' + 'UltraClipart compressed fixture '.repeat(16000) + '</html>');
    fs.writeFileSync(path.join(input, 'one.html'), body);
    execFileSync('/usr/bin/ditto', ['--hfsCompression', '--noclone', input, source]);
    const src = path.join(source, 'one.html'), dst = path.join(target, 'one.html');
    const flags = (p) => Number(execFileSync('/usr/bin/python3', ['-c', 'import os,sys; print(os.stat(sys.argv[1]).st_flags)', p], { encoding: 'utf8' }).trim());
    assert(flags(src) & 0x20);
    const copier = createIndependentCopier({ sourceRoot: source, destinationRoot: target, minFreeBytes: 0 });
    assert.equal(copier.copy(src, dst, { ownerWritable: true }).method, 'darwin-fclonefileat');
    assert(flags(dst) & 0x20); assert.notEqual(fs.statSync(src).ino, fs.statSync(dst).ino);
    assert.equal(sha(fs.readFileSync(src)), sha(body)); assert.equal(sha(fs.readFileSync(dst)), sha(body));
    fs.writeFileSync(dst, 'changed'); assert.equal(sha(fs.readFileSync(src)), sha(body)); assert(flags(src) & 0x20);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
