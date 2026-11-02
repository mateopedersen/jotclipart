import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  statSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  copyPublicInterfaceAssets,
  productionPublicAssets,
} from '../scripts/production-public-assets.mjs';

test('production copies exact UI bytes without copying or traversing catalog originals and drafts', () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-public-assets-'));
  try {
    const source = join(root, 'public'),
      output = join(root, 'dist'),
      originals = join(root, 'originals');
    mkdirSync(join(source, 'fonts'), { recursive: true });
    mkdirSync(originals);
    mkdirSync(output);
    writeFileSync(join(originals, 'pending.webp'), 'unpublished source');
    symlinkSync(originals, join(source, 'catalog'), 'dir');
    const font = Buffer.from([0, 17, 255, 61]);
    writeFileSync(join(source, 'fonts', 'reader.woff2'), font);
    writeFileSync(join(source, '_headers'), 'exact headers');
    writeFileSync(join(output, 'generated.html'), 'keep generated page');
    const result = copyPublicInterfaceAssets(source, output);
    assert.deepEqual(result, { files: 2, bytes: font.length + Buffer.byteLength('exact headers') });
    assert.deepEqual(readFileSync(join(output, 'fonts', 'reader.woff2')), font);
    assert.equal(readFileSync(join(output, '_headers'), 'utf8'), 'exact headers');
    assert.equal(existsSync(join(output, 'catalog')), false);
    assert.equal(readFileSync(join(originals, 'pending.webp'), 'utf8'), 'unpublished source');
    assert.equal(readFileSync(join(output, 'generated.html'), 'utf8'), 'keep generated page');
    // A build output is writable and independent; it must never hard-link a
    // mutable source or damage originals when the output is changed/removed.
    writeFileSync(join(output, 'fonts', 'reader.woff2'), 'changed build output');
    assert.deepEqual(readFileSync(join(source, 'fonts', 'reader.woff2')), font);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing build files are replaced independently while symlink targets are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-public-overwrite-'));
  try {
    const source = join(root, 'public'), output = join(root, 'dist');
    mkdirSync(source); mkdirSync(output);
    writeFileSync(join(source, 'logo.svg'), 'source logo');
    writeFileSync(join(output, 'logo.svg'), 'stale build logo');
    writeFileSync(join(output, 'unrelated.html'), 'keep');
    copyPublicInterfaceAssets(source, output);
    assert.equal(readFileSync(join(output, 'logo.svg'), 'utf8'), 'source logo');
    assert.notEqual(statSync(join(output, 'logo.svg')).ino, statSync(join(source, 'logo.svg')).ino);
    assert.equal(readFileSync(join(output, 'unrelated.html'), 'utf8'), 'keep');
    assert(!readdirSync(output).some((name) => name.startsWith('.uc-copy-')));
    rmSync(join(output, 'logo.svg'));
    symlinkSync(join(source, 'logo.svg'), join(output, 'logo.svg'));
    assert.throws(() => copyPublicInterfaceAssets(source, output), /independent regular/);
    assert.equal(readFileSync(join(source, 'logo.svg'), 'utf8'), 'source logo');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public copying never creates files through an existing output directory symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-public-output-link-'));
  try {
    const source = join(root, 'public'), output = join(root, 'dist'), outside = join(root, 'outside');
    mkdirSync(join(source, 'icons', 'nested'), { recursive: true });
    mkdirSync(output); mkdirSync(outside);
    writeFileSync(join(source, 'icons', 'nested', 'one.svg'), 'source');
    symlinkSync(outside, join(output, 'icons'));
    assert.throws(() => copyPublicInterfaceAssets(source, output), /output directory must not be a symlink/);
    assert.equal(existsSync(join(outside, 'nested')), false);
    assert.equal(readFileSync(join(source, 'icons', 'nested', 'one.svg'), 'utf8'), 'source');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the production hook disables the actual Astro client copy while local builds retain their normal behavior', () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-public-hook-'));
  try {
    const source = join(root, 'public'),
      output = join(root, 'dist');
    mkdirSync(source);
    writeFileSync(join(source, 'logo.svg'), '<svg/>');
    const local = productionPublicAssets(false);
    local.hooks['astro:build:setup']({ updateConfig: () => assert.fail('local config changed') });
    assert.equal(existsSync(output), false);
    const integration = productionPublicAssets(true);
    let update;
    integration.hooks['astro:config:done']({ config: { publicDir: pathToFileURL(source + '/') } });
    integration.hooks['astro:build:setup']({
      vite: { environments: { client: { build: { outDir: output } } } },
      updateConfig: (value) => {
        update = value;
      },
    });
    assert.deepEqual(update.environments.client.build, {
      copyPublicDir: false,
      emptyOutDir: false,
    });
    assert.equal(readFileSync(join(output, 'logo.svg'), 'utf8'), '<svg/>');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('public interface copying rejects symlinks instead of exposing external files', () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-public-link-'));
  try {
    const source = join(root, 'public'),
      output = join(root, 'dist');
    mkdirSync(source);
    writeFileSync(join(root, 'private.txt'), 'do not publish');
    symlinkSync(join(root, 'private.txt'), join(source, 'leak.txt'));
    assert.throws(() => copyPublicInterfaceAssets(source, output), /must not be symlinks/);
    assert.equal(existsSync(join(output, 'leak.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unexpected client output and recursive public output fail before copying', () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-public-boundary-'));
  try {
    const source = join(root, 'public');
    mkdirSync(source);
    assert.throws(() => copyPublicInterfaceAssets(source, source), /outside public/);
    assert.throws(
      () => copyPublicInterfaceAssets(source, join(source, 'nested')),
      /outside public/,
    );
    assert.throws(
      () => copyPublicInterfaceAssets(source, join(source, '..nested')),
      /outside public/,
    );
    const integration = productionPublicAssets(true);
    integration.hooks['astro:config:done']({ config: { publicDir: pathToFileURL(source + '/') } });
    assert.throws(
      () => integration.hooks['astro:build:setup']({ vite: {}, updateConfig() {} }),
      /client output directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
