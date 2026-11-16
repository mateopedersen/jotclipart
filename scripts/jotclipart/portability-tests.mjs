import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY,
  allowedLocal,
  allowedRecord,
  encodeGraph,
  decodeGraph,
  makeBackup,
  readBackup,
  mergeLocal,
  canonical,
  digest,
  fingerprint,
} from '../../public/move-your-work/transfer.js';
const UUID = '2d1c4ef7-3a90-4d1a-a1f6-71d92cb05b24';
const project = (title = 'Unnumbered project') => ({
  version: 2,
  artId: 'test-art',
  title,
  width: 100,
  height: 100,
  background: 'transparent',
  crop: null,
  print: { paper: 'a4', orientation: 'portrait', margin: 0.2, scale: 'fit' },
  layers: [
    {
      id: 'layer-a',
      kind: 'raster',
      label: 'Original image',
      visible: true,
      locked: false,
      opacity: 1,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      assetId: 'source-art',
      sourceSha256: 'a'.repeat(64),
      width: 100,
      height: 100,
    },
  ],
});
const state = (note = 'Original note') => ({
  schema: 1,
  boards: [
    {
      id: 'classroom',
      title: 'Classroom',
      description: 'Original description',
      color: 'sage',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    },
  ],
  entries: {
    'test-art': {
      note,
      boards: ['classroom'],
      tags: ['Learning'],
      savedAt: '2026-11-01T00:00:00Z',
    },
  },
});
test('scope is explicit, excluding cookies, sessions, unrelated keys and temporary handoffs', () => {
  for (const k of POLICY.localExact) assert(allowedLocal(k));
  assert(allowedLocal('ultraclipart:editor:v1:test-art'));
  assert(allowedLocal('ultraclipart:editor:v1:test-art:ai:' + UUID));
  assert(allowedLocal('ultraclipart:studio:checkpoints:test-art'));
  for (const k of [
    'cookie',
    'ultraclipart-session',
    'AI_SESSION_SECRET',
    'ultraclipart-other-app',
    '__Host-uc_share',
    'uc-public-shares-v1',
  ])
    assert(!allowedLocal(k));
  assert(allowedLocal(POLICY.shareKey, true));
  assert(allowedRecord('ultraclipart-studio', 'projects', 'ultraclipart:editor:v1:test-art'));
  assert(allowedRecord('ultraclipart-ai-history', 'images', UUID));
  assert(!allowedRecord('ultraclipart-ai-transfer', 'handoffs', UUID));
  assert(!allowedRecord('other-app', 'projects', 'ultraclipart:editor:v1:test-art'));
});
test('typed graph preserves cycles, sparse arrays, special values and shared buffer identity', async () => {
  const buffer = new Uint8Array([1, 2, 3, 4]).buffer,
    object = {
      buffer,
      view: new Uint16Array(buffer),
      dataView: new DataView(buffer, 1, 2),
      undefinedValue: undefined,
      big: 12345678901234567890n,
      nan: NaN,
      minusZero: -0,
      infinity: Infinity,
      date: new Date('2026-11-16T00:00:00Z'),
      sparse: Array(3),
    };
  object.sparse[2] = 'last';
  object.self = object;
  object.map = new Map([[object, 'self']]);
  object.set = new Set([object]);
  const cloned = await decodeGraph(await encodeGraph(object));
  assert.equal(cloned.self, cloned);
  assert.equal(cloned.map.get(cloned), 'self');
  assert(cloned.set.has(cloned));
  assert.equal(cloned.view.buffer, cloned.buffer);
  assert.equal(cloned.dataView.buffer, cloned.buffer);
  assert.equal(cloned.dataView.byteOffset, 1);
  assert(Object.is(cloned.minusZero, -0));
  assert(Number.isNaN(cloned.nan));
  assert.equal(cloned.big, object.big);
  assert.equal(cloned.date.toISOString(), object.date.toISOString());
  assert(!Object.hasOwn(cloned.sparse, 0));
  assert.equal(cloned.sparse[2], 'last');
});
test('same bytes deduplicate in file without aliasing independent buffers on restore', async () => {
  const a = new Uint8Array([8, 9]).buffer,
    b = new Uint8Array([8, 9]).buffer,
    encoded = await encodeGraph({ a, b });
  assert.equal(encoded.binaries.length, 1);
  const decoded = await decodeGraph(encoded);
  assert.notEqual(decoded.a, decoded.b);
  new Uint8Array(decoded.a)[0] = 0;
  assert.equal(new Uint8Array(decoded.b)[0], 8);
});
test('Blob and File bytes, MIME, name and lastModified are lossless', async () => {
  const value = {
    blob: new Blob([new Uint8Array([0, 255, 16])], { type: 'image/webp' }),
    file: new File(['sample'], 'saved.png', { type: 'image/png', lastModified: 1234 }),
  };
  const out = await decodeGraph(await encodeGraph(value));
  assert.equal(out.blob.type, 'image/webp');
  assert.deepEqual(new Uint8Array(await out.blob.arrayBuffer()), new Uint8Array([0, 255, 16]));
  assert.equal(out.file.name, 'saved.png');
  assert.equal(out.file.lastModified, 1234);
  assert.equal(out.file.type, 'image/png');
  assert.equal(await out.file.text(), 'sample');
});
test('notes, layers, artwork identity and source SHA survive checked backup bytes exactly', async () => {
  const doc = project(),
    records = [
      { kind: 'local', key: 'ultraclipart:editor:v1:test-art', value: JSON.stringify(doc) },
      { kind: 'local', key: 'ultraclipart-favorite-boards-v1', value: JSON.stringify(state()) },
      {
        kind: 'idb',
        name: 'ultraclipart-ai-history',
        store: 'images',
        key: UUID,
        value: {
          id: UUID,
          prompt: 'Private prompt',
          createdAt: '2026-11-16T00:00:00Z',
          original: new Uint8Array([4, 5, 6]).buffer,
          originalType: 'image/png',
        },
      },
    ];
  const text = await makeBackup(records, { sourceOrigin: 'https://ultraclipart.com' }),
    restored = await readBackup(text);
  assert.equal(restored.records[0].value, records[0].value);
  assert.equal(restored.records[1].value, records[1].value);
  assert.deepEqual(new Uint8Array(restored.records[2].value.original), new Uint8Array([4, 5, 6]));
  assert.equal(await fingerprint(records), await fingerprint(restored.records));
});
test('outer file edits fail before any restore action', async () => {
  const text = await makeBackup(
    [{ kind: 'local', key: 'ultraclipart-favorites', value: '["test-art"]' }],
    { sourceOrigin: 'https://ultraclipart.com' },
  );
  await assert.rejects(
    readBackup(text.replace('https://ultraclipart.com', 'https://changed.example')),
    /checksum failed/,
  );
});
test('binary edits fail even when an attacker recalculates the outer checksum', async () => {
  const text = await makeBackup(
    [
      {
        kind: 'idb',
        name: 'ultraclipart-ai-history',
        store: 'images',
        key: UUID,
        value: { id: UUID, original: new Uint8Array([1, 2, 3]).buffer },
      },
    ],
    { sourceOrigin: 'https://ultraclipart.com' },
  );
  const bad = JSON.parse(text);
  bad.payload.binaries[0].base64 = 'AAAA';
  const { checksum, ...body } = bad;
  bad.checksum = await digest(JSON.stringify(canonical(body)));
  await assert.rejects(readBackup(JSON.stringify(bad)), /Binary checksum mismatch/);
});
test('object properties cannot change JavaScript prototypes', async () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal"}');
  const restored = await decodeGraph(await encodeGraph(value));
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert(Object.hasOwn(restored, '__proto__'));
  assert.equal(restored.constructor, 'literal');
});
test('favorites merge preserves destination order and deduplicates stable IDs', () => {
  assert.deepEqual(
    JSON.parse(
      mergeLocal('ultraclipart-favorites', '["old-art","same-art"]', '["same-art","new-art"]')
        .value,
    ),
    ['old-art', 'same-art', 'new-art'],
  );
});
test('board notes are literal and distinct source/destination versions are both retained', () => {
  const current = state('Destination note'),
    incoming = state('Source note'),
    a = JSON.stringify(current),
    b = JSON.stringify(incoming),
    result = mergeLocal('ultraclipart-favorite-boards-v1', a, b);
  assert.equal(JSON.parse(result.value).entries['test-art'].note, 'Destination note');
  assert.equal(result.conflicts[0].entry.note, 'Source note');
  assert.equal(JSON.stringify(current), a);
  assert.equal(JSON.stringify(incoming), b);
});
test('conflicting board identities cannot silently attach entries to another board meaning', () => {
  const a = state();
  a.boards[0].title = 'Destination meaning';
  delete a.entries['test-art'];
  const b = state('Source meaning');
  const plan = mergeLocal('ultraclipart-favorite-boards-v1', JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.parse(plan.value).boards[0].title, 'Destination meaning');
  assert(!JSON.parse(plan.value).entries['test-art']);
  assert(plan.conflicts.some((c) => c.board?.title === 'Classroom'));
  assert(plan.conflicts.some((c) => c.entry?.note === 'Source meaning'));
});
test('existing projects are never overwritten and source IDs/layers remain literal in conflicts', () => {
  const a = JSON.stringify(project('Destination title')),
    b = JSON.stringify(project('Source title')),
    plan = mergeLocal('ultraclipart:editor:v1:test-art', a, b);
  assert.equal(plan.value, a);
  assert.equal(plan.conflicts[0], b);
  assert.equal(JSON.parse(plan.conflicts[0]).layers[0].sourceSha256, 'a'.repeat(64));
  assert.equal(mergeLocal('ultraclipart:editor:v1:test-art', null, b).value, b);
});
test('a project for another artwork cannot be injected under an allowed recovery key', () => {
  assert.throws(
    () => mergeLocal('ultraclipart:editor:v1:another-art', null, JSON.stringify(project())),
    /existing project validation/,
  );
});
test('public removal capabilities require both export and restore opt-in', async () => {
  const value = JSON.stringify([
      {
        id: 'b'.repeat(32),
        title: 'Literal title',
        url: 'https://ultraclipart.com/share/' + 'b'.repeat(32) + '/',
        deleteToken: 'X'.repeat(43),
      },
    ]),
    record = { kind: 'local', key: POLICY.shareKey, value };
  await assert.rejects(makeBackup([record], { sourceOrigin: 'https://ultraclipart.com' }), /scope/);
  const text = await makeBackup([record], {
    sourceOrigin: 'https://ultraclipart.com',
    includeShares: true,
  });
  const closed = await readBackup(text);
  assert.equal(closed.records.length, 0);
  assert(closed.excludedShareKeys);
  const open = await readBackup(text, { includeShares: true });
  assert.equal(open.records.length, 1);
  const result = JSON.parse(mergeLocal(POLICY.shareKey, null, value).value)[0];
  assert.equal(result.title, 'Literal title');
  assert.equal(result.deleteToken, 'X'.repeat(43));
  assert.equal(result.url, 'https://jotclipart.com/share/' + 'b'.repeat(32) + '/');
});
test('different removal capabilities for the same ID preserve destination and incoming versions', () => {
  const row = {
      id: 'c'.repeat(32),
      title: 'Original title',
      url: 'https://jotclipart.com/share/' + 'c'.repeat(32) + '/',
      deleteToken: 'A'.repeat(43),
    },
    incoming = { ...row, deleteToken: 'B'.repeat(43) };
  const result = mergeLocal(POLICY.shareKey, JSON.stringify([row]), JSON.stringify([incoming]));
  assert.equal(JSON.parse(result.value)[0].deleteToken, 'A'.repeat(43));
  assert.equal(result.conflicts[0].deleteToken, 'B'.repeat(43));
});
test('unsupported storage never enters a backup, including named session-like keys', async () => {
  await assert.rejects(
    makeBackup([{ kind: 'local', key: 'AI_SESSION_SECRET', value: 'not-exportable' }], {
      sourceOrigin: 'https://ultraclipart.com',
    }),
    /scope/,
  );
  await assert.rejects(
    makeBackup(
      [{ kind: 'idb', name: 'ultraclipart-ai-transfer', store: 'handoffs', key: UUID, value: {} }],
      { sourceOrigin: 'https://ultraclipart.com' },
    ),
    /scope/,
  );
});
