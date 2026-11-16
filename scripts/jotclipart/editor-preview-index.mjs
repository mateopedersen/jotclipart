import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  readFileSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const EDITOR_PREVIEW_SOURCE = 'data/jotclipart-editor-previews.jsonl.gz';
export const EDITOR_PREVIEW_CONFIG = 'config/jotclipart-editor-previews.json';
const SCRIPT = 'scripts/jotclipart/editor-preview-index.mjs';
const HEX = /^[a-f0-9]{64}$/;
const PREFIXES = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, '0'));
const FIELDS = ['id', 'sourceSHA256', 'path', 'sha256', 'bytes', 'width', 'height'];
const REVIEWED = Object.freeze({
  catalogRoot: '7c311351a6c725394ca7473cbcc1025868a281d17449cc817776452f0f3f6753',
  manifestRoot: 'e6886e4510c865c7132ae85a50d8768009c93194b5f1b3981fb87067b8deef07',
  manifestSHA256: '873b6c3602ac891b531962566b321f88fed74fa34d1d2c00cc097e212862b72f',
  manifestBytes: 59838570,
  records: 35709,
  totalPreviewBytes: 4334635064,
  maxPreviewBytes: 528444,
});
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (message) => {
  throw Error(message);
};
const must = (value, message) => {
  if (!value) fail(message);
};
function keys(value, fields, label) {
  must(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === [...fields].sort().join(','),
    label + ' fields differ',
  );
}
export function canonicalEditorPreviewJSON(value) {
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return JSON.stringify(canonical(value));
}
export function compileEditorPreviewRows(rows) {
  must(Array.isArray(rows) && rows.length > 0 && rows.length <= 50000, 'Preview row count bound');
  const ids = new Set(),
    paths = new Set(),
    groups = new Map(PREFIXES.map((p) => [p, []]));
  let totalPreviewBytes = 0,
    maxPreviewBytes = 0;
  for (const row of rows) {
    keys(row, FIELDS, 'Preview row');
    must(
      typeof row.id === 'string' &&
        row.id.length <= 180 &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id),
      'Invalid preview artwork ID',
    );
    const match =
      typeof row.path === 'string' && /^\/previews\/p1\/([a-f0-9]{24})-960\.webp$/.exec(row.path);
    must(match, 'Invalid editor preview path');
    must(
      HEX.test(row.sourceSHA256 ?? '') && HEX.test(row.sha256 ?? ''),
      'Invalid preview source/body SHA',
    );
    must(
      Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 1024 * 1024,
      'Preview byte bound',
    );
    must(
      Number.isSafeInteger(row.width) &&
        Number.isSafeInteger(row.height) &&
        row.width > 0 &&
        row.height > 0 &&
        row.width <= 960 &&
        row.height <= 960,
      'Preview dimension bound',
    );
    must(!ids.has(row.id) && !paths.has(row.path), 'Duplicate preview ID/path');
    ids.add(row.id);
    paths.add(row.path);
    totalPreviewBytes += row.bytes;
    maxPreviewBytes = Math.max(maxPreviewBytes, row.bytes);
    groups.get(match[1].slice(0, 2)).push({ ...row });
  }
  const shards = {},
    bodies = new Map();
  for (const prefix of PREFIXES) {
    const files = groups
      .get(prefix)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const body = Buffer.from(canonicalEditorPreviewJSON({ schema: 1, files }));
    must(body.length <= 128 * 1024, 'Editor preview shard exceeds128KiB');
    bodies.set(prefix, body);
    shards[prefix] = { sha256: sha(body), bytes: body.length, records: files.length };
  }
  return { records: rows.length, totalPreviewBytes, maxPreviewBytes, shards, bodies };
}
function sourceFile(root, path) {
  const realRoot = realpathSync(root),
    file = join(realRoot, path);
  must(relative(realRoot, file) === path.split('/').join(sep), 'Preview input path escape');
  let current = realRoot;
  for (const component of path.split('/')) {
    current = join(current, component);
    must(!lstatSync(current).isSymbolicLink(), 'Preview input symlink forbidden');
  }
  must(
    lstatSync(file).isFile() && realpathSync(file) === file,
    'Preview input must be a normal repo file',
  );
  return readFileSync(file);
}
export function checkEditorPreviewIndex({ root = process.cwd(), buildRoot } = {}) {
  root = realpathSync(resolve(root));
  const configBytes = sourceFile(root, EDITOR_PREVIEW_CONFIG);
  must(configBytes.length <= 128 * 1024, 'Preview config byte bound');
  const config = JSON.parse(configBytes);
  keys(
    config,
    ['schema', 'source', 'records', 'totalPreviewBytes', 'maxPreviewBytes', 'rootSHA256', 'shards'],
    'Preview config',
  );
  must(
    config.schema === 1 && HEX.test(config.rootSHA256 ?? ''),
    'Invalid preview config schema/root',
  );
  keys(
    config.source,
    ['file', 'sha256', 'bytes', 'catalogRoot', 'manifestRoot', 'manifestSHA256', 'manifestBytes'],
    'Preview source',
  );
  must(
    config.source.file === EDITOR_PREVIEW_SOURCE,
    'Preview source must be the reviewed repo file',
  );
  for (const key of ['catalogRoot', 'manifestRoot', 'manifestSHA256', 'manifestBytes'])
    must(config.source[key] === REVIEWED[key], 'Preview provenance differs: ' + key);
  for (const key of ['records', 'totalPreviewBytes', 'maxPreviewBytes'])
    must(config[key] === REVIEWED[key], 'Reviewed preview inventory differs: ' + key);
  must(
    HEX.test(config.source.sha256 ?? '') &&
      Number.isSafeInteger(config.source.bytes) &&
      config.source.bytes > 0 &&
      config.source.bytes <= 16 * 1024 * 1024,
    'Invalid preview compressed source pin',
  );
  const compressed = sourceFile(root, EDITOR_PREVIEW_SOURCE);
  must(
    compressed.length === config.source.bytes && sha(compressed) === config.source.sha256,
    'Preview compressed source pin differs',
  );
  must(
    compressed[0] === 31 &&
      compressed[1] === 139 &&
      compressed[2] === 8 &&
      compressed[3] === 0 &&
      compressed.subarray(4, 8).every((b) => b === 0) &&
      compressed[9] === 255,
    'Preview gzip must be deterministic',
  );
  const source = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const text = source.toString('utf8');
  must(
    Buffer.from(text).equals(source) && text.endsWith('\n') && !text.includes('\r'),
    'Preview source must be exact UTF8 JSONL',
  );
  const rows = text
    .slice(0, -1)
    .split('\n')
    .map((line) => {
      must(line.length > 0 && Buffer.byteLength(line) <= 2048, 'Preview JSONL row bound');
      const row = JSON.parse(line);
      must(canonicalEditorPreviewJSON(row) === line, 'Preview source rows must be canonical JSON');
      return row;
    });
  must(
    rows.every((r, i) => i === 0 || rows[i - 1].path < r.path),
    'Preview source paths must be strictly sorted',
  );
  const compiled = compileEditorPreviewRows(rows);
  for (const key of ['records', 'totalPreviewBytes', 'maxPreviewBytes'])
    must(compiled[key] === config[key], 'Preview source totals differ: ' + key);
  keys(config.shards, PREFIXES, 'Preview shard directory');
  for (const prefix of PREFIXES) {
    keys(config.shards[prefix], ['sha256', 'bytes', 'records'], 'Preview shard');
    must(
      canonicalEditorPreviewJSON(config.shards[prefix]) ===
        canonicalEditorPreviewJSON(compiled.shards[prefix]),
      'Preview shard pin differs: ' + prefix,
    );
  }
  const rootSHA256 = sha(
    Buffer.from(
      canonicalEditorPreviewJSON({
        schema: 1,
        sourceSHA256: config.source.sha256,
        shards: compiled.shards,
      }),
    ),
  );
  must(rootSHA256 === config.rootSHA256, 'Preview index root differs');
  const script = sourceFile(root, SCRIPT);
  must(
    sha(script) === sha(readFileSync(fileURLToPath(import.meta.url))),
    'Preview build script identity differs',
  );
  const sourceInputs = {
    [EDITOR_PREVIEW_SOURCE]: sha(compressed),
    [EDITOR_PREVIEW_CONFIG]: sha(configBytes),
    [SCRIPT]: sha(script),
  };
  if (buildRoot !== undefined) {
    const base = join(
      resolve(buildRoot),
      'editor-previews/public/__editor-preview-index',
      rootSHA256,
    );
    must(!lstatSync(base).isSymbolicLink(), 'Preview output symlink forbidden');
    const names = readdirSync(base).sort();
    must(
      names.join(',') === PREFIXES.map((p) => p + '.json').join(','),
      'Preview output shard set differs',
    );
    for (const prefix of PREFIXES) {
      const file = join(base, prefix + '.json');
      must(
        lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(),
        'Preview output must be a normal file',
      );
      const body = readFileSync(file),
        pin = compiled.shards[prefix];
      must(
        body.length === pin.bytes && sha(body) === pin.sha256,
        'Generated preview shard pin differs: ' + prefix,
      );
    }
  }
  return {
    rootSHA256,
    records: compiled.records,
    sourceInputs,
    config,
    rows,
    compiled,
    generatedShardsVerified: buildRoot !== undefined,
  };
}
export function buildEditorPreviewIndex({ root = process.cwd(), buildRoot } = {}) {
  must(
    typeof buildRoot === 'string' && buildRoot.length > 0,
    'Explicit preview buildRoot required',
  );
  const checked = checkEditorPreviewIndex({ root });
  const base = join(resolve(buildRoot), 'editor-previews/public');
  const outputs = [];
  for (const [prefix, body] of checked.compiled.bodies) {
    const path = `/__editor-preview-index/${checked.rootSHA256}/${prefix}.json`,
      file = join(base, path);
    mkdirSync(dirname(file), { recursive: true });
    must(!lstatSync(dirname(file)).isSymbolicLink(), 'Preview output symlink forbidden');
    try {
      must(!lstatSync(file).isSymbolicLink(), 'Preview output symlink forbidden');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = file + '.' + process.pid + '.tmp';
    writeFileSync(temporary, body, { flag: 'wx' });
    renameSync(temporary, file);
    outputs.push({ file, path, bytes: body.length, sha256: sha(body) });
  }
  checkEditorPreviewIndex({ root, buildRoot });
  const report = {
    rootSHA256: checked.rootSHA256,
    records: checked.records,
    sourceInputs: checked.sourceInputs,
    outputs,
    originalBodiesCopied: 0,
    previewBodiesCopied: 0,
    r2Writes: 0,
  };
  const reportPath = join(resolve(buildRoot), 'editor-previews/report.json');
  const temporary = reportPath + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, reportPath);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      'build-root': { type: 'string' },
      check: { type: 'boolean' },
    },
  });
  if (values.check) {
    const result = checkEditorPreviewIndex({ root: values.root, buildRoot: values['build-root'] });
    console.log(
      JSON.stringify({
        status: 'EDITOR_PREVIEW_INDEX_VERIFIED',
        rootSHA256: result.rootSHA256,
        records: result.records,
        sourceInputs: result.sourceInputs,
        generatedShardsVerified: result.generatedShardsVerified,
        cloudReads: 0,
        r2Writes: 0,
      }),
    );
  } else {
    const result = buildEditorPreviewIndex({ root: values.root, buildRoot: values['build-root'] });
    console.log(JSON.stringify({ ...result, outputs: result.outputs.length }));
  }
}
