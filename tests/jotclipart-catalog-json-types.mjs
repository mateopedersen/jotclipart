import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { buildSync } from 'esbuild';
import {
  catalogJsonDeclaration,
  catalogJsonSources,
  checkCatalogJsonTypes,
} from '../scripts/jotclipart/catalog-json-types.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jot-catalog-json-types-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), value);
  };
  put(
    'data/art.json',
    JSON.stringify([{ id: 'existing-art', title: 'Accepted source', width: 12 }]),
  );
  put('data/editorial/reviews.json', JSON.stringify({ schema: 1, artworks: [] }));
  await checkCatalogJsonTypes({ root, write: true });
  return { root, put };
}
test('the exact two declarations bind every source byte and cannot hide a stale or weaker shape', async (t) => {
  const f = await fixture(t);
  assert.equal((await checkCatalogJsonTypes({ root: f.root })).sources.length, 2);
  f.put(
    'data/art.json',
    JSON.stringify([{ id: 'existing-art', title: 'Changed source', width: 12 }]),
  );
  await assert.rejects(() => checkCatalogJsonTypes({ root: f.root }), /stale or changed/);
  await checkCatalogJsonTypes({ root: f.root, write: true });
  f.put('data/art.d.json.ts', 'declare const source: unknown; export default source;\n');
  await assert.rejects(() => checkCatalogJsonTypes({ root: f.root }), /stale or changed/);
});
test('structural types retain every optional field, array item, nullable and primitive type', async () => {
  const declaration = await catalogJsonDeclaration(
    Buffer.from(
      JSON.stringify([
        { a: 1, nested: { active: true }, tags: ['a'] },
        { a: null, tags: [2] },
      ]),
    ),
    'data/art.json',
  );
  assert.match(declaration, /a: null \| number/);
  assert.match(declaration, /nested\?:/);
  assert.match(declaration, /active: boolean/);
  assert.match(declaration, /tags: Array<number \| string>/);
  assert.doesNotMatch(declaration, /\bany\b|@ts-(?:ignore|nocheck)|declare module/);
  await assert.rejects(
    () => catalogJsonDeclaration(Buffer.from('{}'), 'data/other.json'),
    /Explicit/,
  );
  await assert.rejects(
    () => catalogJsonDeclaration(Buffer.from('{"n":1e999}'), 'data/art.json'),
    /Non-finite/,
  );
});
test('the pinned TypeScript resolver checks consumers without loading either JSON literal graph', async (t) => {
  const f = await fixture(t);
  f.put(
    'main.ts',
    "import art from './data/art.json'; import reviews from './data/editorial/reviews.json';\n" +
      'const correct: string = art[0].title;\n' +
      'const incorrect: number = art[0].title;\n' +
      'const schema: number = reviews.schema;\n',
  );
  const options = {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolveJsonModule: true,
      allowArbitraryExtensions: true,
      skipLibCheck: true,
      types: [],
    },
    host = ts.createCompilerHost(options),
    read = host.readFile.bind(host);
  host.readFile = (file) => {
    assert(!catalogJsonSources.some((name) => file === join(f.root, name)), 'JSON AST was loaded');
    return read(file);
  };
  const program = ts.createProgram([join(f.root, 'main.ts')], options, host),
    diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 2322, 'Consumer type errors must remain hard errors');
  for (const file of catalogJsonSources) {
    assert(
      program
        .getSourceFiles()
        .some((source) => source.fileName === join(f.root, file.replace(/\.json$/, '.d.json.ts'))),
    );
    assert(!program.getSourceFiles().some((source) => source.fileName === join(f.root, file)));
  }
});
test('runtime bundling still reads the original JSON bytes instead of the declaration', async (t) => {
  const f = await fixture(t);
  f.put('runtime.mjs', "import art from './data/art.json';console.log(JSON.stringify(art));\n");
  const compiled = buildSync({
    entryPoints: [join(f.root, 'runtime.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  }).outputFiles[0].text;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', compiled], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    JSON.parse(readFileSync(join(f.root, 'data/art.json'))),
  );
});
test('all Astro/TypeScript source roots and strict checks are preserved', () => {
  const config = JSON.parse(readFileSync('tsconfig.json'));
  assert.equal(config.extends, 'astro/tsconfigs/strict');
  assert.equal(config.compilerOptions.allowArbitraryExtensions, true);
  assert.deepEqual(config.include, ['.astro/types.d.ts', '**/*']);
  assert.deepEqual(config.exclude, ['dist', 'work', 'reports', '.venv-art', 'node_modules']);
  const runner = readFileSync('scripts/jotclipart/ci-native.mjs', 'utf8');
  assert.match(runner, /exact-catalog-json-types/);
  assert(
    runner.indexOf("command('exact-catalog-json-types'") <
      runner.indexOf("command('astro-typescript-diagnostics'"),
  );
  assert.match(runner, /astro-check\.js/);
  assert.match(runner, /minimumFailingSeverity/);
});
