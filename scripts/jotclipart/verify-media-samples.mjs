import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const reports = resolve('../../../reports/jotclipart-migration'),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const assert = (x, m) => {
  if (!x) throw Error(m);
};
const readJSON = (p) => JSON.parse(readFileSync(p));
const audit = readJSON(join(reports, 'catalog-audit.json')),
  inventory = readJSON(join(reports, 'catalog-media-inventory.json'));
assert(
  audit.root === inventory.sourceRoot &&
    inventory.status === 'FULL_FRESH_R2_IDENTITY_METADATA_RECONCILIATION_PASSED',
  'Complete matching source and fresh R2 inventory required',
);
function sourceLines(name) {
  const b = readFileSync(join(reports, name)),
    p = audit.outputChecksums.find((x) => x.file === name);
  assert(p && p.sha256 === sha(b) && p.bytes === b.length, 'Source manifest proof mismatch');
  return gunzipSync(b)
    .toString('utf8')
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x));
}
const contents = new Map(sourceLines('catalog-content-map.jsonl.gz').map((x) => [x.id, x])),
  objects = sourceLines('catalog-r2-object-map.jsonl.gz');
const evidenceBytes = readFileSync(join(reports, inventory.evidence.file));
assert(
  sha(evidenceBytes) === inventory.evidence.sha256 &&
    evidenceBytes.length === inventory.evidence.bytes,
  'Fresh metadata evidence bytes changed',
);
const withoutSHA = new Map(
  gunzipSync(evidenceBytes)
    .toString('utf8')
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x))
    .filter((x) => x.storedFullSHA256Matched === null)
    .map((x) => [x.key, x]),
);
assert(
  withoutSHA.size === inventory.objectsWithoutStoredFullSHA256,
  'No-stored-SHA evidence cardinality differs',
);
const byId = new Map();
for (const row of objects) {
  if (!withoutSHA.has(row.objectKey)) continue;
  const role =
    row.mime === 'application/pdf'
      ? 'pdf'
      : row.roles.includes('webp')
        ? 'webp'
        : row.roles.includes('originalThumb')
          ? 'thumbnail'
          : null;
  if (!role) continue;
  for (const id of row.ids) {
    if (!byId.has(id)) byId.set(id, {});
    byId.get(id)[role] = row;
  }
}
const byTopic = new Map();
for (const [id, roles] of byId) {
  if (!roles.pdf || !roles.webp || !roles.thumbnail) continue;
  const content = contents.get(id);
  assert(content, 'Sample source identity absent');
  const bytes = roles.pdf.bytes + roles.webp.bytes + roles.thumbnail.bytes;
  if (bytes > 10 * 1024 * 1024) continue;
  const newest = Math.max(
    ...Object.values(roles).map((r) => Date.parse(withoutSHA.get(r.objectKey).lastModified)),
  );
  if (!byTopic.has(content.topic)) byTopic.set(content.topic, []);
  byTopic.get(content.topic).push({ id, topic: content.topic, roles, bytes, age: newest });
}
const topicCandidates = [...byTopic]
  .map(([topic, rows]) => ({
    topic,
    rows: rows.sort((a, b) => a.age - b.age || a.id.localeCompare(b.id)),
    age: rows.reduce((n, r) => n + r.age, 0) / rows.length,
  }))
  .sort((a, b) => a.age - b.age || a.topic.localeCompare(b.topic));
assert(topicCandidates.length >= 20, 'At least 20 complete topic/format groups required');
const chosenTopics = Array.from(
  { length: 20 },
  (_, i) => topicCandidates[Math.round((i * (topicCandidates.length - 1)) / 19)],
);
assert(new Set(chosenTopics.map((x) => x.topic)).size === 20, 'Repeated topic selection');
const selected = [];
for (const [i, topic] of chosenTopics.entries()) {
  const item = topic.rows[Math.round((i / 19) * (topic.rows.length - 1))];
  for (const role of ['webp', 'pdf', 'thumbnail']) {
    const row = item.roles[role];
    assert(row.newURL.startsWith('https://assets.jotclipart.com/'), 'Unexpected sample origin');
    selected.push({
      ...row,
      id: item.id,
      topic: item.topic,
      role,
      lastModified: withoutSHA.get(row.objectKey).lastModified,
      storedFullSHA256Present: false,
    });
  }
}
const plannedBytes = selected.reduce((n, r) => n + r.bytes, 0),
  BUDGET = 250_000_000;
assert(selected.length === 60 && plannedBytes + 6 * 32 <= BUDGET, 'Sample byte budget exceeded');
let fetchedBytes = 0,
  cursor = 0;
const results = Array(selected.length),
  prefixes = new Map(),
  startedAt = new Date().toISOString();
const normalizeMime = (x) => (typeof x === 'string' ? x.toLowerCase().split(';')[0].trim() : null);
async function full(row) {
  const result = {
    id: row.id,
    topic: row.topic,
    role: row.role,
    key: row.objectKey,
    url: row.newURL,
    lastModified: row.lastModified,
    expectedBytes: row.bytes,
    expectedSHA256: row.sha256,
    expectedMIME: row.mime,
    storedFullSHA256Present: false,
    browserDownloadTest: false,
  };
  try {
    const response = await fetch(row.newURL, {
      method: 'GET',
      redirect: 'manual',
      headers: { Origin: 'https://jotclipart.com' },
      signal: AbortSignal.timeout(60000),
    });
    result.status = response.status;
    result.actualMIME = normalizeMime(response.headers.get('content-type'));
    result.cors = response.headers.get('access-control-allow-origin');
    result.contentLength = response.headers.get('content-length');
    result.etag = response.headers.get('etag');
    result.cfCacheStatus = response.headers.get('cf-cache-status');
    assert(response.status === 200, 'Original GET did not return 200');
    const hash = createHash('sha256'),
      prefix = [];
    let bytes = 0,
      prefixLength = 0;
    for await (const chunk of response.body) {
      fetchedBytes += chunk.length;
      bytes += chunk.length;
      assert(fetchedBytes <= BUDGET, 'Global sample streamed byte budget exceeded');
      assert(bytes <= row.bytes, 'Original body exceeds source byte count');
      hash.update(chunk);
      if (prefixLength < 64) {
        const part = Buffer.from(chunk).subarray(0, 64 - prefixLength);
        prefix.push(part);
        prefixLength += part.length;
      }
    }
    const head = Buffer.concat(prefix),
      digest = hash.digest('hex');
    prefixes.set(row.objectKey, head);
    const magic =
      row.mime === 'application/pdf'
        ? head.subarray(0, 5).toString('ascii') === '%PDF-'
        : head.subarray(0, 4).toString('ascii') === 'RIFF' &&
          head.subarray(8, 12).toString('ascii') === 'WEBP' &&
          head.readUInt32LE(4) + 8 === bytes;
    Object.assign(result, {
      actualBytes: bytes,
      actualSHA256: digest,
      bytesMatched: bytes === row.bytes,
      sha256Matched: digest === row.sha256,
      mimeMatched: result.actualMIME === row.mime,
      magicMatched: magic,
      corsMatched: result.cors === 'https://jotclipart.com',
      memoryOnlyStream: true,
    });
    result.passed =
      result.bytesMatched &&
      result.sha256Matched &&
      result.mimeMatched &&
      result.magicMatched &&
      result.corsMatched;
    if (!result.passed) result.error = 'Original bytes/hash/MIME/magic/CORS mismatch';
  } catch (error) {
    result.passed = false;
    result.error = error.message;
  }
  return result;
}
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (cursor < selected.length) {
      const i = cursor++;
      results[i] = await full(selected[i]);
      if ((i + 1) % 15 === 0)
        console.log(
          JSON.stringify({
            phase: 'actual-original-byte-check',
            completed: results.filter(Boolean).length,
            selected: selected.length,
            fetchedBytes,
          }),
        );
    }
  }),
);
const supplemental = [];
for (const index of [0, 10, 20, 30, 40, 50]) {
  const row = selected[index],
    entry = {
      id: row.id,
      topic: row.topic,
      role: row.role,
      key: row.objectKey,
      url: row.newURL,
      expectedBytes: row.bytes,
    };
  try {
    const head = await fetch(row.newURL, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { Origin: 'https://jotclipart.com' },
      signal: AbortSignal.timeout(30000),
    });
    entry.head = {
      status: head.status,
      bytes: Number(head.headers.get('content-length')),
      mime: normalizeMime(head.headers.get('content-type')),
      cors: head.headers.get('access-control-allow-origin'),
      acceptRanges: head.headers.get('accept-ranges'),
    };
    entry.head.passed =
      head.status === 200 &&
      entry.head.bytes === row.bytes &&
      entry.head.mime === row.mime &&
      entry.head.cors === 'https://jotclipart.com';
    const range = await fetch(row.newURL, {
      method: 'GET',
      redirect: 'manual',
      headers: { Origin: 'https://jotclipart.com', Range: 'bytes=0-31' },
      signal: AbortSignal.timeout(30000),
    });
    entry.range = {
      status: range.status,
      contentRange: range.headers.get('content-range'),
      mime: normalizeMime(range.headers.get('content-type')),
      cors: range.headers.get('access-control-allow-origin'),
    };
    assert(range.status === 206, 'Range GET did not return 206');
    const chunks = [];
    let bytes = 0;
    for await (const b of range.body) {
      bytes += b.length;
      fetchedBytes += b.length;
      assert(bytes <= 32 && fetchedBytes <= BUDGET, 'Bounded range response exceeded budget');
      chunks.push(b);
    }
    entry.range.actualBytes = bytes;
    entry.range.passed =
      bytes === 32 &&
      entry.range.contentRange === `bytes 0-31/${row.bytes}` &&
      entry.range.mime === row.mime &&
      entry.range.cors === 'https://jotclipart.com' &&
      Buffer.concat(chunks).equals(prefixes.get(row.objectKey)?.subarray(0, 32));
    entry.passed = entry.head.passed && entry.range.passed;
  } catch (error) {
    entry.passed = false;
    entry.error = error.message;
  }
  supplemental.push(entry);
}
const result = {
  status:
    results.every((r) => r.passed) && supplemental.every((r) => r.passed)
      ? 'REPRESENTATIVE_ACTUAL_ORIGINAL_BYTES_AND_TRANSPORT_PASSED'
      : 'REPRESENTATIVE_ACTUAL_ORIGINAL_BYTE_OR_TRANSPORT_FAILURE',
  sourceRoot: audit.root,
  startedAt,
  completedAt: new Date().toISOString(),
  selectionScope:
    'Only objects with no stored full SHA-256 in fresh R2 metadata; complete WebP/PDF/thumbnail sets across 20 topics, spread over available R2 upload ages.',
  ageBasis:
    'R2 last_modified; this is storage modification age, not an inferred artwork creation date.',
  availableNoStoredSHAObjects: withoutSHA.size,
  eligibleTopics: topicCandidates.length,
  selectedTopics: chosenTopics.map((t) => t.topic),
  selectedObjects: selected.length,
  formats: { webp: 20, pdf: 20, thumbnail: 20 },
  actualFullBytePasses: results.filter((r) => r.passed).length,
  HEADChecks: supplemental.length,
  rangeChecks: supplemental.length,
  HEADAndRangePasses: supplemental.filter((r) => r.passed).length,
  fullGETOriginalBytesPlanned: plannedBytes,
  totalNetworkBodyBytesRead: fetchedBytes,
  maximumNetworkBodyBytes: BUDGET,
  maxConcurrentFullGET: 4,
  originalFilesWritten: 0,
  cloudMutations: 0,
  browserDownloadsTested: 0,
  results,
  supplemental,
};
const out = join(reports, 'catalog-media-byte-samples.json');
writeFileSync(out + '.tmp', JSON.stringify(result, null, 2));
renameSync(out + '.tmp', out);
console.log(JSON.stringify({ ...result, results: undefined, supplemental: undefined }));
if (result.status !== 'REPRESENTATIVE_ACTUAL_ORIGINAL_BYTES_AND_TRANSPORT_PASSED')
  process.exitCode = 2;
