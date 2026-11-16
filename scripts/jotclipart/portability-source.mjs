import { validateDocument } from '../../src/editor/model.ts';

export const POLICY = Object.freeze({
  format: 'jotclipart-browser-transfer-v1',
  rawLimit: 128 * 1024 * 1024,
  fileLimit: 192 * 1024 * 1024,
  maxRecords: 12000,
  maxNodes: 200000,
  maxBinary: 32 * 1024 * 1024,
  localExact: [
    'ultraclipart-favorites',
    'ultraclipart-favorite-boards-v1',
    'ultraclipart-favorites-view-v1',
    'ultraclipart:element-favorites:v1',
    'ultraclipart:palette',
    'ultraclipart:studio:workbench:v1',
  ],
  stores: [
    { name: 'ultraclipart-studio', store: 'projects', keyPath: null },
    { name: 'ultraclipart-ai-history', store: 'images', keyPath: 'id' },
  ],
  shareKey: 'uc-public-shares-v1',
  archiveDB: 'jotclipart-transfer-conflicts-v1',
});
const ID = '[a-z0-9]+(?:-[a-z0-9]+)*',
  UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const editor = new RegExp('^ultraclipart:editor:v1:(' + ID + ')(?:\\:ai:' + UUID + ')?$', 'i');
const checkpoints = new RegExp('^ultraclipart:studio:checkpoints:(' + ID + ')$', 'i');
const checkpointDocument = new RegExp(
  '^ultraclipart:studio:checkpoints:(' + ID + '):[a-f0-9-]{36}$',
  'i',
);
const hex = /^[a-f0-9]{64}$/;
const utf8 = new TextEncoder();
export const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
export const digest = async (value) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', typeof value === 'string' ? utf8.encode(value) : value),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const check = (condition, message) => {
  if (!condition) throw Error(message);
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const define = (o, k, value) =>
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });
export function allowedLocal(key, includeShares = false) {
  return (
    typeof key === 'string' &&
    key.length <= 500 &&
    (POLICY.localExact.includes(key) ||
      editor.test(key) ||
      checkpoints.test(key) ||
      (includeShares && key === POLICY.shareKey))
  );
}
export function allowedRecord(name, store, key) {
  return (
    typeof key === 'string' &&
    key.length <= 550 &&
    ((name === 'ultraclipart-studio' &&
      store === 'projects' &&
      (editor.test(key) || checkpointDocument.test(key))) ||
      (name === 'ultraclipart-ai-history' &&
        store === 'images' &&
        /^[^\u0000-\u001f\u007f]{1,200}$/.test(key)))
  );
}
function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
function unbase64(text) {
  check(
    typeof text === 'string' &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text),
    'Invalid binary encoding.',
  );
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
const typedNames = [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
];

/** Preserve graph identity, undefined, Blob/File, typed views, buffers and cycles. */
export async function encodeGraph(input) {
  const seen = new WeakMap(),
    nodes = [],
    binaries = [],
    hashes = new Map();
  let rawBytes = 0;
  const budget = (n) => {
    rawBytes += n;
    check(
      rawBytes <= POLICY.rawLimit,
      'Backup exceeds 128 MB. Export large projects separately from Studio; no record was skipped.',
    );
  };
  async function binary(buffer) {
    const bytes = new Uint8Array(buffer);
    check(
      bytes.length <= POLICY.maxBinary,
      'A binary item exceeds 32 MB. Export that project separately from Studio.',
    );
    const hash = await digest(bytes);
    if (!hashes.has(hash)) {
      hashes.set(hash, binaries.length);
      binaries.push({ sha256: hash, bytes: bytes.length, base64: base64(bytes) });
    }
    return hashes.get(hash);
  }
  async function pack(value) {
    if (value === undefined) return { kind: 'undefined' };
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
      return {
        kind: 'number',
        value: Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : String(value),
      };
    if (typeof value === 'bigint') return { kind: 'bigint', value: String(value) };
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      budget(utf8.encode(value).length);
      return value;
    }
    check(
      typeof value === 'object',
      'Unsupported saved value. Export the affected project separately.',
    );
    if (seen.has(value)) return { ref: seen.get(value) };
    const id = nodes.length;
    check(id < POLICY.maxNodes, 'Saved work has too many objects.');
    seen.set(value, id);
    nodes.push(null);
    let node;
    if (value instanceof ArrayBuffer) {
      budget(value.byteLength);
      node = { kind: 'buffer', binary: await binary(value) };
    } else if (ArrayBuffer.isView(value))
      node = {
        kind: 'view',
        name: value instanceof DataView ? 'DataView' : value.constructor.name,
        buffer: await pack(value.buffer),
        offset: value.byteOffset,
        length: value instanceof DataView ? value.byteLength : value.length,
      };
    else if (value instanceof Blob) {
      budget(value.size);
      node = {
        kind: typeof File !== 'undefined' && value instanceof File ? 'file' : 'blob',
        binary: await binary(await value.arrayBuffer()),
        mime: value.type,
        ...(typeof File !== 'undefined' && value instanceof File
          ? { name: value.name, lastModified: value.lastModified }
          : {}),
      };
    } else if (value instanceof Date) {
      check(Number.isFinite(value.getTime()), 'Invalid saved date.');
      node = { kind: 'date', value: value.toISOString() };
    } else if (value instanceof Map) {
      const entries = [];
      for (const [k, v] of value) entries.push([await pack(k), await pack(v)]);
      node = { kind: 'map', entries };
    } else if (value instanceof Set) {
      const entries = [];
      for (const v of value) entries.push(await pack(v));
      node = { kind: 'set', entries };
    } else if (Array.isArray(value)) {
      const entries = [];
      for (let i = 0; i < value.length; i++)
        if (own(value, i)) entries.push([i, await pack(value[i])]);
      node = { kind: 'array', length: value.length, entries };
    } else {
      const proto = Object.getPrototypeOf(value);
      check(proto === Object.prototype || proto === null, 'Unsupported saved object type.');
      const entries = [];
      for (const key of Object.keys(value).sort()) entries.push([key, await pack(value[key])]);
      node = { kind: 'object', nullPrototype: proto === null, entries };
    }
    nodes[id] = node;
    return { ref: id };
  }
  return { root: await pack(input), nodes, binaries };
}
export async function decodeGraph(graph) {
  check(
    graph &&
      Array.isArray(graph.nodes) &&
      Array.isArray(graph.binaries) &&
      graph.nodes.length <= POLICY.maxNodes,
    'Invalid backup object graph.',
  );
  const binaries = [];
  let bytes = 0;
  for (const b of graph.binaries) {
    check(
      b &&
        hex.test(b.sha256) &&
        Number.isSafeInteger(b.bytes) &&
        b.bytes >= 0 &&
        b.bytes <= POLICY.maxBinary,
      'Invalid binary record.',
    );
    check(b.base64.length <= Math.ceil(b.bytes / 3) * 4, 'Binary length mismatch.');
    const data = unbase64(b.base64);
    bytes += data.length;
    check(
      bytes <= POLICY.rawLimit && data.length === b.bytes && (await digest(data)) === b.sha256,
      'Binary checksum mismatch.',
    );
    binaries.push(data);
  }
  const values = Array(graph.nodes.length),
    ready = new Set(),
    building = new Set();
  let materialized = 0;
  const allocate = (n) => {
    materialized += n;
    check(materialized <= POLICY.rawLimit, 'Decoded saved data exceeds128MB.');
  };
  const getBinary = (id) => {
    check(Number.isSafeInteger(id) && id >= 0 && id < binaries.length, 'Unknown binary record.');
    return binaries[id];
  };
  function unpack(value) {
    if (typeof value === 'string') {
      allocate(utf8.encode(value).length);
      return value;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid encoded value.');
    if (value.kind === 'undefined') return undefined;
    if (value.kind === 'bigint') {
      check(/^-?\d+$/.test(value.value) && value.value.length < 1000, 'Invalid integer.');
      return BigInt(value.value);
    }
    if (value.kind === 'number') {
      check(['NaN', '-0', 'Infinity', '-Infinity'].includes(value.value), 'Invalid numeric value.');
      return value.value === '-0' ? -0 : Number(value.value);
    }
    const id = value.ref;
    check(
      Number.isSafeInteger(id) && id >= 0 && id < graph.nodes.length,
      'Unknown object reference.',
    );
    if (ready.has(id)) return values[id];
    check(!building.has(id), 'Invalid cyclic binary view.');
    building.add(id);
    const n = graph.nodes[id];
    check(n && typeof n.kind === 'string', 'Invalid object node.');
    let out;
    if (n.kind === 'buffer') {
      const data = getBinary(n.binary);
      allocate(data.length);
      out = Uint8Array.from(data).buffer;
    } else if (n.kind === 'blob' || n.kind === 'file') {
      check(typeof n.mime === 'string' && n.mime.length <= 200, 'Invalid Blob type.');
      const b = getBinary(n.binary);
      allocate(b.length);
      if (n.kind === 'file') {
        check(
          typeof File !== 'undefined' &&
            typeof n.name === 'string' &&
            n.name.length < 500 &&
            Number.isFinite(n.lastModified),
          'Invalid File metadata.',
        );
        out = new File([b], n.name, { type: n.mime, lastModified: n.lastModified });
      } else out = new Blob([b], { type: n.mime });
    } else if (n.kind === 'date') {
      out = new Date(n.value);
      check(Number.isFinite(out.getTime()), 'Invalid date.');
    } else if (n.kind === 'array') {
      check(
        Number.isSafeInteger(n.length) && n.length >= 0 && n.length <= POLICY.maxNodes,
        'Invalid array.',
      );
      out = Array(n.length);
    } else if (n.kind === 'map') out = new Map();
    else if (n.kind === 'set') out = new Set();
    else if (n.kind === 'object') out = n.nullPrototype ? Object.create(null) : {};
    else if (n.kind === 'view') {
      check(n.name === 'DataView' || typedNames.includes(n.name), 'Unsupported typed view.');
      const b = unpack(n.buffer);
      check(
        b instanceof ArrayBuffer &&
          Number.isSafeInteger(n.offset) &&
          n.offset >= 0 &&
          Number.isSafeInteger(n.length) &&
          n.length >= 0,
        'Invalid typed view bounds.',
      );
      out =
        n.name === 'DataView'
          ? new DataView(b, n.offset, n.length)
          : new globalThis[n.name](b, n.offset, n.length);
    } else throw Error('Unsupported object node.');
    values[id] = out;
    ready.add(id);
    building.delete(id);
    if (['array', 'object', 'map', 'set'].includes(n.kind)) {
      check(
        Array.isArray(n.entries) && n.entries.length <= POLICY.maxNodes,
        'Invalid object entries.',
      );
      for (const entry of n.entries) {
        if (n.kind === 'set') out.add(unpack(entry));
        else {
          check(Array.isArray(entry) && entry.length === 2, 'Invalid object property.');
          const [k, v] = entry;
          if (n.kind === 'map') out.set(unpack(k), unpack(v));
          else {
            check(
              n.kind === 'array'
                ? Number.isSafeInteger(k) && k >= 0 && k < n.length
                : typeof k === 'string' && k.length < 10000,
              'Invalid property name.',
            );
            define(out, k, unpack(v));
          }
        }
      }
    }
    return out;
  }
  return unpack(graph.root);
}
export async function fingerprint(value) {
  return digest(JSON.stringify(canonical(await encodeGraph(value))));
}
export async function makeBackup(records, { sourceOrigin, includeShares = false } = {}) {
  check(Array.isArray(records) && records.length <= POLICY.maxRecords, 'Too many saved records.');
  for (const r of records)
    check(
      r.kind === 'local'
        ? allowedLocal(r.key, includeShares)
        : r.kind === 'idb' && allowedRecord(r.name, r.store, r.key),
      'Backup scope is not allowed.',
    );
  const payload = await encodeGraph(records),
    body = {
      format: POLICY.format,
      createdAt: new Date().toISOString(),
      sourceOrigin,
      includesShareKeys: includeShares,
      payload,
    };
  const checksum = await digest(JSON.stringify(canonical(body)));
  const text = JSON.stringify({ ...body, checksum });
  check(
    utf8.encode(text).length <= POLICY.fileLimit,
    'Backup file exceeds 192 MB. Export large projects separately.',
  );
  return text;
}
export async function readBackup(text, { includeShares = false } = {}) {
  check(
    typeof text === 'string' && utf8.encode(text).length <= POLICY.fileLimit,
    'Backup file is too large.',
  );
  const envelope = JSON.parse(text),
    { checksum, ...body } = envelope;
  check(
    body.format === POLICY.format &&
      hex.test(checksum ?? '') &&
      (await digest(JSON.stringify(canonical(body)))) === checksum,
    'Backup checksum failed. No data was imported.',
  );
  check(
    typeof body.sourceOrigin === 'string' &&
      body.sourceOrigin.length < 200 &&
      Number.isFinite(Date.parse(body.createdAt)),
    'Invalid backup metadata.',
  );
  const records = await decodeGraph(body.payload);
  check(
    Array.isArray(records) && records.length <= POLICY.maxRecords,
    'Invalid backup record list.',
  );
  const seen = new Set();
  for (const r of records) {
    check(r && typeof r === 'object', 'Invalid backup record.');
    check(
      r.kind === 'local'
        ? allowedLocal(r.key, body.includesShareKeys === true)
        : r.kind === 'idb' && allowedRecord(r.name, r.store, r.key),
      'Backup contains an unsupported storage scope.',
    );
    const key = r.kind + '|' + (r.name ?? '') + '|' + (r.store ?? '') + '|' + r.key;
    check(!seen.has(key), 'Duplicate backup record.');
    seen.add(key);
  }
  return {
    metadata: {
      createdAt: body.createdAt,
      sourceOrigin: body.sourceOrigin,
      includesShareKeys: body.includesShareKeys,
    },
    records: records.filter(
      (r) => includeShares || r.kind !== 'local' || r.key !== POLICY.shareKey,
    ),
    excludedShareKeys:
      !includeShares && records.some((r) => r.kind === 'local' && r.key === POLICY.shareKey),
  };
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const identity = (v) => typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
function arrayJSON(value) {
  const a = JSON.parse(value);
  check(
    Array.isArray(a) &&
      a.length <= 10000 &&
      a.every((x) => typeof x === 'string' && x.length <= 200),
    'Invalid saved list.',
  );
  return a;
}
function boardJSON(value) {
  const b = JSON.parse(value);
  check(
    b?.schema === 1 &&
      Array.isArray(b.boards) &&
      b.boards.length <= 100 &&
      b.entries &&
      typeof b.entries === 'object' &&
      !Array.isArray(b.entries) &&
      Object.keys(b.entries).length <= 10000,
    'Invalid saved boards.',
  );
  for (const item of b.boards)
    check(
      item && identity(item.id) && typeof item.title === 'string' && item.title.length <= 80,
      'Invalid board identity.',
    );
  for (const [id, item] of Object.entries(b.entries))
    check(
      identity(id) &&
        item &&
        typeof item.note === 'string' &&
        item.note.length <= 10000 &&
        Array.isArray(item.boards) &&
        item.boards.every(identity),
      'Invalid board entry.',
    );
  return b;
}
function ownedShares(value) {
  const list = JSON.parse(value);
  check(Array.isArray(list) && list.length <= 1000, 'Invalid removal-key backup.');
  return list.map((r) => {
    check(
      r &&
        /^[a-f0-9]{32}$/.test(r.id) &&
        /^[A-Za-z0-9_-]{43}$/.test(r.deleteToken) &&
        typeof r.title === 'string' &&
        r.title.length <= 100 &&
        ['https://ultraclipart.com/share/', 'https://jotclipart.com/share/'].some(
          (origin) => r.url === origin + r.id + '/',
        ),
      'Invalid public share ownership record.',
    );
    return { ...r, url: 'https://jotclipart.com/share/' + r.id + '/' };
  });
}
export function mergeLocal(key, current, incoming) {
  check(
    typeof incoming === 'string' && utf8.encode(incoming).length <= 8 * 1024 * 1024,
    'Invalid local saved value.',
  );
  const conflicts = [];
  if (key === POLICY.shareKey) {
    const a = current ? ownedShares(current) : [],
      b = ownedShares(incoming),
      map = new Map(a.map((x) => [x.id, x]));
    for (const item of b) {
      if (!map.has(item.id)) map.set(item.id, item);
      else if (!same(map.get(item.id), item)) conflicts.push(item);
    }
    return { value: JSON.stringify([...map.values()]), conflicts };
  }
  if (['ultraclipart-favorites', 'ultraclipart:element-favorites:v1'].includes(key)) {
    const a = current ? arrayJSON(current) : [],
      b = arrayJSON(incoming);
    if (key === 'ultraclipart-favorites')
      check([...a, ...b].every(identity), 'Invalid artwork ID.');
    const result = [...new Set([...a, ...b])];
    check(result.length <= 10000, 'Saved list limit reached.');
    return { value: JSON.stringify(result), conflicts };
  }
  if (key === 'ultraclipart-favorite-boards-v1') {
    const a = current ? boardJSON(current) : { schema: 1, boards: [], entries: {} },
      b = boardJSON(incoming),
      out = clone(a),
      boards = new Map(out.boards.map((x) => [x.id, x])),
      bad = new Set();
    for (const item of b.boards)
      if (!boards.has(item.id)) {
        boards.set(item.id, item);
        out.boards.push(item);
      } else if (!same(boards.get(item.id), item)) {
        bad.add(item.id);
        conflicts.push({ board: item });
      }
    check(out.boards.length <= 100, 'Board limit reached.');
    for (const [id, item] of Object.entries(b.entries))
      if (
        item.boards.some((x) => bad.has(x)) ||
        (own(out.entries, id) && !same(out.entries[id], item))
      )
        conflicts.push({ id, entry: item });
      else if (!own(out.entries, id)) define(out.entries, id, item);
    return { value: JSON.stringify(out), conflicts };
  }
  if (checkpoints.test(key)) {
    const a = current ? JSON.parse(current) : [],
      b = JSON.parse(incoming);
    check(
      Array.isArray(a) && Array.isArray(b) && a.length <= 10 && b.length <= 10,
      'Invalid checkpoint list.',
    );
    const map = new Map(a.map((x) => [x.id, x]));
    for (const item of b) {
      check(
        item &&
          /^[a-f0-9-]{36}$/i.test(item.id) &&
          typeof item.name === 'string' &&
          typeof item.at === 'string',
        'Invalid checkpoint record.',
      );
      if (!map.has(item.id) && map.size < 10) map.set(item.id, item);
      else if (!same(map.get(item.id), item)) conflicts.push(item);
    }
    return { value: JSON.stringify([...map.values()]), conflicts };
  }
  if (editor.test(key)) {
    const doc = JSON.parse(incoming);
    check(
      validateDocument(doc, editor.exec(key)[1]),
      'Saved project does not pass the existing project validation.',
    );
  } else check(POLICY.localExact.includes(key), 'Unsupported local key.');
  if (current === null) return { value: incoming, conflicts };
  if (current === incoming) return { value: current, conflicts };
  return { value: current, conflicts: [incoming] };
}
function validIDB(record) {
  if (record.name === 'ultraclipart-studio') {
    const m = editor.exec(record.key) ?? checkpointDocument.exec(record.key);
    return !!m && validateDocument(record.value, m[1]);
  }
  const x = record.value;
  return (
    x &&
    x.id === record.key &&
    typeof x.prompt === 'string' &&
    x.prompt.length <= 2048 &&
    typeof x.createdAt === 'string' &&
    Number.isFinite(Date.parse(x.createdAt)) &&
    (x.original instanceof Blob || x.original instanceof ArrayBuffer) &&
    (!x.edited || x.edited instanceof Blob || x.edited instanceof ArrayBuffer)
  );
}
function openDB(name, { create = false, store, keyPath = null } = {}) {
  return new Promise((done, fail) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      fail(Error('Browser storage is busy. Close other editing tabs and retry.'));
    }, 5000);
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      if (!create) {
        request.transaction.abort();
        return;
      }
      request.result.createObjectStore(store, keyPath ? { keyPath } : undefined);
    };
    request.onerror = () => {
      clearTimeout(timer);
      if (!create && request.error?.name === 'AbortError') done(null);
      else fail(request.error);
    };
    request.onblocked = () => {
      clearTimeout(timer);
      fail(Error('Browser storage is busy.'));
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) {
        request.result.close();
        return;
      }
      done(request.result);
    };
  });
}
async function rowsFromDB(spec) {
  const db = await openDB(spec.name);
  if (!db) return [];
  try {
    check(
      db.objectStoreNames.contains(spec.store),
      'A saved-work database has an unexpected schema.',
    );
    return await new Promise((done, fail) => {
      const rows = [],
        tx = db.transaction(spec.store, 'readonly'),
        request = tx.objectStore(spec.store).openCursor();
      request.onsuccess = () => {
        const c = request.result;
        if (c) {
          if (!allowedRecord(spec.name, spec.store, c.key)) {
            tx.abort();
            return;
          }
          if (allowedRecord(spec.name, spec.store, c.key)) {
            rows.push({
              kind: 'idb',
              name: spec.name,
              store: spec.store,
              key: c.key,
              value: c.value,
            });
            if (rows.length > POLICY.maxRecords) {
              tx.abort();
              return;
            }
          }
          c.continue();
        }
      };
      tx.oncomplete = () => done(rows);
      tx.onerror = tx.onabort = () => fail(tx.error || Error('Could not read saved work.'));
    });
  } finally {
    db.close();
  }
}
export async function collectRecords({
  includeShares = false,
  local = localStorage,
  includeHistory = true,
} = {}) {
  const records = [];
  check(local.length <= 20000, 'Too many browser storage keys.');
  for (let i = 0; i < local.length; i++) {
    const key = local.key(i);
    if (allowedLocal(key, includeShares)) {
      const value = local.getItem(key);
      check(value !== null, 'Saved work changed while reading. Retry the backup.');
      records.push({ kind: 'local', key, value });
    }
  }
  for (const spec of POLICY.stores)
    if (includeHistory || spec.name !== 'ultraclipart-ai-history')
      records.push(...(await rowsFromDB(spec)));
  check(records.length <= POLICY.maxRecords, 'Too many saved records.');
  for (const r of records)
    if (r.kind === 'local')
      check(
        local.getItem(r.key) === r.value,
        'Saved work changed while reading. Retry after the current save finishes.',
      );
  return records;
}
async function archive(record, reason) {
  const hash = await fingerprint(record),
    key =
      record.kind +
      '|' +
      (record.name ?? '') +
      '|' +
      (record.store ?? '') +
      '|' +
      record.key +
      '|' +
      hash;
  const graph = await encodeGraph(record);
  const db = await openDB(POLICY.archiveDB, { create: true, store: 'records' });
  try {
    await new Promise((done, fail) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').put({ key, graph, reason, sha256: hash }, key);
      tx.oncomplete = done;
      tx.onerror = tx.onabort = () => fail(tx.error);
    });
    const saved = await new Promise((done, fail) => {
      const r = db.transaction('records', 'readonly').objectStore('records').get(key);
      r.onsuccess = () => done(r.result);
      r.onerror = () => fail(r.error);
    });
    check(
      saved?.sha256 === hash && (await fingerprint(await decodeGraph(saved.graph))) === hash,
      'Separate version read-back failed. Keep your original backup file.',
    );
    return key;
  } finally {
    db.close();
  }
}
async function importDB(record) {
  const spec = POLICY.stores.find((x) => x.name === record.name && x.store === record.store);
  const db = await openDB(spec.name, { create: true, store: spec.store, keyPath: spec.keyPath });
  try {
    check(db.objectStoreNames.contains(spec.store), 'Unexpected destination database schema.');
    check(
      db.transaction(spec.store, 'readonly').objectStore(spec.store).keyPath === spec.keyPath,
      'Unexpected destination storage key format.',
    );
    const existing = await new Promise((done, fail) => {
      const r = db.transaction(spec.store, 'readonly').objectStore(spec.store).get(record.key);
      r.onsuccess = () => done(r.result);
      r.onerror = () => fail(r.error);
    });
    if (existing !== undefined)
      return (await fingerprint(existing)) === (await fingerprint(record.value))
        ? 'duplicate'
        : 'conflict';
    const added = await new Promise((done, fail) => {
      const tx = db.transaction(spec.store, 'readwrite'),
        store = tx.objectStore(spec.store);
      let duplicate = false;
      const r = spec.keyPath ? store.add(record.value) : store.add(record.value, record.key);
      r.onerror = (e) => {
        if (r.error?.name === 'ConstraintError') {
          e.preventDefault();
          e.stopPropagation();
          duplicate = true;
        }
      };
      tx.oncomplete = () => done(duplicate ? 'conflict' : 'added');
      tx.onerror = tx.onabort = () => fail(tx.error);
    });
    if (added !== 'added') return added;
    const saved = await new Promise((done, fail) => {
      const r = db.transaction(spec.store, 'readonly').objectStore(spec.store).get(record.key);
      r.onsuccess = () => done(r.result);
      r.onerror = () => fail(r.error);
    });
    return (await fingerprint(saved)) === (await fingerprint(record.value)) ? 'added' : 'conflict';
  } finally {
    db.close();
  }
}
export async function importRecords(records, { local = localStorage, includeShares = false } = {}) {
  const result = { added: 0, merged: 0, duplicate: 0, conflicts: 0, quarantined: 0 };
  for (const record of records) {
    check(
      record.kind === 'local'
        ? allowedLocal(record.key, includeShares)
        : record.kind === 'idb' && allowedRecord(record.name, record.store, record.key),
      'Unsupported restore scope.',
    );
    if (record.kind === 'local') {
      const before = local.getItem(record.key);
      let plan;
      try {
        plan = mergeLocal(record.key, before, record.value);
      } catch (error) {
        await archive(
          record,
          'Invalid for current application; retained without writing application state.',
        );
        result.quarantined++;
        continue;
      }
      if (plan.conflicts.length) {
        await archive(
          record,
          'Existing destination data or metadata conflicts; neither version overwritten.',
        );
        result.conflicts++;
      }
      if (before === plan.value) {
        result.duplicate++;
        continue;
      }
      if (local.getItem(record.key) !== before) {
        await archive(record, 'Another tab changed this destination during import.');
        result.conflicts++;
        continue;
      }
      local.setItem(record.key, plan.value);
      check(
        local.getItem(record.key) === plan.value,
        'Local restore read-back failed. Keep your backup file.',
      );
      before === null ? result.added++ : result.merged++;
    } else {
      if (!validIDB(record)) {
        await archive(
          record,
          'Invalid for current application; raw saved record retained privately.',
        );
        result.quarantined++;
        continue;
      }
      const action = await importDB(record);
      if (action === 'conflict') {
        await archive(
          record,
          'Existing project/history version kept; incoming version retained separately.',
        );
        result.conflicts++;
      } else result[action]++;
    }
  }
  return result;
}
export async function exportConflicts() {
  const db = await openDB(POLICY.archiveDB);
  if (!db) return [];
  try {
    return await new Promise((done, fail) => {
      const r = db.transaction('records', 'readonly').objectStore('records').getAll();
      r.onsuccess = () => done(r.result);
      r.onerror = () => fail(r.error);
    });
  } finally {
    db.close();
  }
}
function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
async function mount() {
  const q = (id) => document.getElementById(id),
    status = q('status');
  let busy = false;
  const run = async (operation) => {
    if (busy) return;
    busy = true;
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    try {
      await operation();
    } catch (error) {
      status.textContent =
        'Stopped: ' +
        error.message +
        ' Existing work has not been removed. Keep your backup; some earlier records may already have been added.';
    } finally {
      busy = false;
      for (const button of document.querySelectorAll('button')) button.disabled = false;
      if (!destination) q('restore').disabled = true;
    }
  };
  const destination = ['jotclipart.com', 'localhost', '127.0.0.1'].includes(location.hostname);
  q('origin').textContent = location.origin;
  q('restore').disabled = !destination;
  q('export').addEventListener('click', () =>
    run(async () => {
      status.textContent = 'Reading only the saved-work locations listed below…';
      const includeShares = q('shares').checked;
      const records = await collectRecords({ includeShares, includeHistory: q('history').checked });
      const text = await makeBackup(records, { sourceOrigin: location.origin, includeShares });
      await readBackup(text, { includeShares });
      download(text, 'jotclipart-private-work-' + new Date().toISOString().slice(0, 10) + '.json');
      status.textContent = `Backup checked and saved: ${records.length} records, ${(utf8.encode(text).length / 1048576).toFixed(1)} MB. Nothing was deleted. Store this unencrypted file privately.`;
    }),
  );
  q('restore').addEventListener('click', () =>
    run(async () => {
      check(destination, 'Open this page on jotclipart.com to import.');
      const file = q('file').files[0];
      check(file && file.size <= POLICY.fileLimit, 'Choose a backup file up to 192 MB.');
      status.textContent = 'Checking the complete file and binary checksums before restoring…';
      const includeShares = q('shares').checked;
      const backup = await readBackup(await file.text(), { includeShares });
      const result = await importRecords(backup.records, { includeShares });
      status.textContent = `Restore checked: ${result.added} added, ${result.merged} merged, ${result.duplicate} already present, ${result.conflicts} conflicts retained separately, ${result.quarantined} unsupported records preserved separately.${backup.excludedShareKeys ? ' Removal keys were not imported because the optional box was not selected.' : ''} Open Favorites or Studio to check your work; keep the backup.`;
    }),
  );
  q('conflicts').addEventListener('click', () =>
    run(async () => {
      const rows = await exportConflicts();
      check(rows.length, 'No separate conflicting versions are stored on this origin.');
      const text = JSON.stringify({
        format: 'jotclipart-conflicting-versions-v1',
        createdAt: new Date().toISOString(),
        records: rows,
      });
      download(text, 'jotclipart-private-conflicting-versions.json');
      status.textContent = `Saved ${rows.length} separate versions. Existing application data was not changed.`;
    }),
  );
}
if (typeof document !== 'undefined' && document.getElementById('transfer-app')) mount();
