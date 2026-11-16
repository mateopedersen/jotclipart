import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createScopedContext } from '../server/catalog-snapshot/scoped-context.mjs';
import { writeScopedContext } from '../scripts/catalog-snapshot/compilers/scoped-context.mjs';
import ts from 'typescript';

const directory = (n) => ({
  total: n,
  collections: [{ slug: 'nature', count: n }],
  topics: [{ slug: 'camera', count: n, collections: ['nature'] }],
  kinds: [{ slug: 'line', count: n }],
});

test('object views preserve complete JSON seeds, spread, assignment and membership', () => {
  const { requestState, scoped } = createScopedContext(),
    view = scoped('directory'),
    value = directory(7);
  requestState.run({ directory: value }, () => {
    assert.equal(
      JSON.stringify({ version: 'release', directory: view, items: [] }),
      JSON.stringify({ version: 'release', directory: value, items: [] }),
    );
    assert.deepEqual(Object.keys(view), Object.keys(value));
    assert.deepEqual(Reflect.ownKeys(view), Reflect.ownKeys(value));
    assert.deepEqual({ ...view }, value);
    assert.deepEqual(Object.assign({}, view), value);
    assert.equal('kinds' in view, true);
    assert.equal('missing' in view, false);
    assert.equal(
      view.kinds.some((k) => k.slug === 'line'),
      true,
    );
    assert.equal(Reflect.set(view, 'total', 99), false);
    assert.equal(value.total, 7);
  });
  assert.throws(() => JSON.stringify(view), /isolated request snapshot/);
});

test('frozen source fields and symbols enumerate without violating empty target invariants', () => {
  const { requestState, scoped } = createScopedContext(),
    symbol = Symbol('visible'),
    value = { a: 1, [symbol]: 2 };
  Object.defineProperty(value, 'hidden', { value: 3, enumerable: false });
  Object.freeze(value);
  requestState.run({ value }, () => {
    const view = scoped('value');
    assert.deepEqual({ ...view }, { a: 1, [symbol]: 2 });
    assert.deepEqual(Reflect.ownKeys(view), Reflect.ownKeys(value));
    assert.equal(view.hidden, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(view)), { a: 1 });
    assert.equal(Reflect.defineProperty(view, 'extra', { value: 4 }), false);
    assert.equal(Reflect.deleteProperty(view, 'a'), false);
    assert.equal(Reflect.preventExtensions(view), false);
  });
});

test('array views retain array identity, length reflection, JSON, iteration and methods', () => {
  const { requestState, scoped } = createScopedContext(),
    view = scoped('items', []);
  for (const items of [[], [{ id: 'a' }, { id: 'b' }], Object.freeze(['frozen'])])
    requestState.run({ items }, () => {
      assert.equal(Array.isArray(view), true);
      assert.equal(view.length, items.length);
      assert.deepEqual(JSON.parse(JSON.stringify(view)), items);
      assert.deepEqual([...view], items);
      assert.deepEqual(
        view.map((x) => x),
        items,
      );
      assert.deepEqual(Object.keys(view), Object.keys(items));
      const length = Reflect.getOwnPropertyDescriptor(view, 'length');
      assert.equal(length.value, items.length);
      assert.equal(length.configurable, false);
    });
});

test('Map methods keep native receivers while each request resolves its own map', () => {
  const { requestState, scoped } = createScopedContext(),
    view = scoped('map', new Map());
  for (const id of ['first', 'second'])
    requestState.run({ map: new Map([[id, 3]]) }, () => {
      assert.equal(view.size, 1);
      assert.equal(view.get(id), 3);
      assert.deepEqual([...view], [[id, 3]]);
    });
});

test('concurrent asynchronous serializations never mix request states', async () => {
  const { requestState, current, scoped } = createScopedContext(),
    view = scoped('directory'),
    items = scoped('items', []);
  await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      requestState.run({ directory: directory(i), items: [i] }, async () => {
        await new Promise((r) => setTimeout(r, (15 - i) % 4));
        assert.equal(current().directory.total, i);
        assert.equal(JSON.parse(JSON.stringify(view)).total, i);
        assert.equal({ ...view }.total, i);
        assert.deepEqual([...items], [i]);
        await Promise.resolve();
        assert.equal(view.topics[0].count, i);
      }),
    ),
  );
  assert.throws(current, /isolated request snapshot/);
});

test('every compiler emits the shared implementation with isolated store instances', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url)),
    temporary = mkdtempSync(join(tmpdir(), 'uc-scoped-context-'));
  try {
    const contexts = [];
    for (const name of ['home', 'editor', 'shell', 'collection', 'art']) {
      const source = readFileSync(
        join(root, 'scripts/catalog-snapshot/compilers/' + name + '.mjs'),
        'utf8',
      );
      const ast = ts.createSourceFile(
        name + '.mjs',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      assert(
        ast.statements.some(
          (node) =>
            ts.isImportDeclaration(node) &&
            node.moduleSpecifier.text === './scoped-context.mjs' &&
            node.importClause?.namedBindings?.elements?.some(
              (e) => e.name.text === 'writeScopedContext',
            ),
        ),
        'Compiler must import the shared scoped context writer',
      );
      let sharedCall = false;
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'writeScopedContext'
        ) {
          const [target, sourceRoot] = node.arguments;
          sharedCall = !!(
            target &&
            ts.isCallExpression(target) &&
            ts.isIdentifier(target.expression) &&
            target.expression.text === 'join' &&
            target.arguments.length === 2 &&
            ts.isIdentifier(target.arguments[0]) &&
            target.arguments[0].text === 'here' &&
            ts.isStringLiteral(target.arguments[1]) &&
            target.arguments[1].text === 'context.mjs' &&
            sourceRoot &&
            ts.isIdentifier(sourceRoot) &&
            sourceRoot.text === 'root'
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      assert(sharedCall, 'Compiler must write its own context file from the shared implementation');
      assert(!source.includes('new AsyncLocalStorage'));
      const path = join(temporary, name + '.mjs');
      writeScopedContext(path, root);
      contexts.push(await import(pathToFileURL(path)));
    }
    assert.equal(new Set(contexts.map((c) => c.requestState)).size, 5);
    for (const [i, c] of contexts.entries())
      c.requestState.run({ directory: directory(i) }, () =>
        assert.equal(JSON.parse(JSON.stringify(c.scoped('directory'))).total, i),
      );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('missing and mismatched request objects fail explicitly', () => {
  const { requestState, scoped } = createScopedContext(),
    view = scoped('missing');
  requestState.run({}, () =>
    assert.throws(() => Object.keys(view), /Invalid request-scoped object/),
  );
  requestState.run({ items: {} }, () =>
    assert.throws(() => JSON.stringify(scoped('items', [])), /Invalid request-scoped object/),
  );
  assert.throws(() => scoped('', {}), /target is required/);
  assert.throws(() => scoped('x', Object.freeze({})), /target is required/);
});
