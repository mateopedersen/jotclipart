import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  chmodSync,
  openSync,
  closeSync,
  unlinkSync,
  createWriteStream,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync, createGzip } from 'node:zlib';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Read-only official Cloudflare REST inventory. No Worker, R2 writes, private
// session, new token, bucket changes, PUT, DELETE or object-body download.
const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const n = s.indexOf('=');
    if (n < 0 || !s.startsWith('--')) throw Error('Use --name=value');
    return [s.slice(2, n), s.slice(n + 1)];
  }),
);
const task = resolve('../../..'),
  reports = resolve(args.reports ?? join(task, 'reports/jotclipart-migration'));
const output = resolve(args.output ?? 'work/jotclipart-media-inventory-rest');
const account = '48c779c8eaa80234e0bb9d57f96e588b',
  bucket = 'ultraclipart-media';
const api =
  'https://api.cloudflare.com/client/v4/accounts/' + account + '/r2/buckets/' + bucket + '/objects';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const assert = (v, message) => {
  if (!v) throw Error(message);
};
const readJSON = (p) => JSON.parse(readFileSync(p));
const audit = readJSON(join(reports, 'catalog-audit.json'));
assert(
  audit.status === 'OFFLINE_SIGNED_CONTENT_URL_ASSET_IDENTITY_AUDIT_PASSED',
  'Signed source inventory required',
);
const mapName = 'catalog-r2-object-map.jsonl.gz',
  mapBytes = readFileSync(join(reports, mapName));
const mapProof = audit.outputChecksums.find((x) => x.file === mapName);
assert(
  mapProof && mapProof.bytes === mapBytes.length && mapProof.sha256 === sha(mapBytes),
  'Expected media manifest bytes changed',
);
function loadExpected() {
  const map = new Map();
  for (const line of gunzipSync(mapBytes).toString('utf8').trim().split('\n')) {
    const row = JSON.parse(line);
    assert(
      row.bucket === bucket && typeof row.objectKey === 'string' && !map.has(row.objectKey),
      'Expected object identity differs',
    );
    assert(
      Number.isSafeInteger(row.bytes) && row.bytes > 0 && /^[a-f0-9]{64}$/.test(row.sha256),
      'Expected source metadata incomplete',
    );
    map.set(row.objectKey, row);
  }
  return map;
}
const expected = loadExpected();
assert(expected.size === audit.identity.uniqueR2Objects, 'Expected object count differs');
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);
mkdirSync(join(output, 'pages'), { recursive: true, mode: 0o700 });
mkdirSync(reports, { recursive: true });
const nonce = randomBytes(16).toString('hex'),
  lock = join(output, 'runner-active.json');
let lockFD;
try {
  lockFD = openSync(lock, 'wx', 0o600);
  writeFileSync(
    lockFD,
    JSON.stringify({
      pid: process.pid,
      nonce,
      at: new Date().toISOString(),
      purpose: 'read-only-media-rest-inventory',
    }),
  );
  closeSync(lockFD);
} catch {
  throw Error(
    'A media inventory runner lock already exists; inspect it rather than overlapping jobs',
  );
}
let interrupted = false;
process.once('SIGINT', () => {
  interrupted = true;
});
process.once('SIGTERM', () => {
  interrupted = true;
});
const statePath = join(output, 'checkpoint.json');
const atomic = (p, b) => {
  const tmp = p + '.' + process.pid + '.tmp';
  writeFileSync(tmp, b, { mode: 0o600 });
  renameSync(tmp, p);
};
const saveState = (state) => atomic(statePath, JSON.stringify(state, null, 2));
function token() {
  const text = readFileSync(
      join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
      'utf8',
    ),
    m = /^oauth_token\s*=\s*"([^"]+)"/m.exec(text);
  assert(m && m[1].length > 20, 'Existing Wrangler OAuth unavailable');
  return m[1];
}
async function apiPage(cursor, { startAfter, limit = 1000 } = {}) {
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'Invalid listing page limit');
  const url = new URL(api);
  url.searchParams.set('per_page', String(limit));
  if (cursor) url.searchParams.set('cursor', cursor);
  if (startAfter !== undefined) url.searchParams.set('start_after', startAfter);
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token() },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      if (attempt < 2) {
        await delay(500 * (attempt + 1));
        continue;
      }
      throw Error('Cloudflare listing transport unavailable');
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      await delay(1000 * (attempt + 1));
      continue;
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw Error(
        'Existing OAuth expired or unauthorized; refresh it separately and resume this checkpoint',
      );
    }
    assert(response.ok, 'Cloudflare listing HTTP ' + response.status);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert(size <= 32 * 1024 * 1024, 'Listing page exceeded bounded byte budget');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks),
      data = JSON.parse(body);
    assert(
      data.success === true && Array.isArray(data.result) && data.result.length <= 1000,
      'Unexpected official listing response',
    );
    const info = data.result_info ?? {},
      hasCursor = typeof info.cursor === 'string' && info.cursor.length > 0;
    assert(
      info.is_truncated === undefined || typeof info.is_truncated === 'boolean',
      'Invalid pagination completion marker',
    );
    if (info.is_truncated === true) assert(hasCursor, 'Truncated listing lacks next cursor');
    if (hasCursor) assert(info.cursor !== cursor, 'Non-progressing pagination cursor');
    // Official fields are optional. This API omits false and the cursor on its
    // last page; that terminal candidate is additionally boundary-probed below.
    const complete = info.is_truncated === false || !hasCursor;
    return {
      body,
      data,
      complete,
      nextCursor: complete ? null : info.cursor,
      terminalSignal:
        info.is_truncated === false ? 'explicit-false' : !hasCursor ? 'no-next-cursor' : null,
    };
  }
  throw Error('Cloudflare listing retry budget exceeded');
}
const mime = (s) => (typeof s === 'string' ? s.toLowerCase().split(';')[0].trim() : null);
function metadataSHA(custom) {
  const found = [];
  for (const [k, v] of Object.entries(custom ?? {})) {
    if (
      [
        'sha256',
        'sha-256',
        'sha_256',
        'contentsha256',
        'content-sha256',
        'content_sha256',
        'checksumsha256',
        'checksum-sha256',
      ].includes(k.toLowerCase()) &&
      typeof v === 'string' &&
      /^[a-f0-9]{64}$/i.test(v)
    )
      found.push({ field: k, sha256: v.toLowerCase() });
  }
  return found;
}
async function writeGzipRows(path, rows) {
  const stream = createGzip({ level: 9 }),
    file = createWriteStream(path + '.tmp', { mode: 0o600 });
  stream.pipe(file);
  for (const row of rows)
    if (!stream.write(JSON.stringify(row) + '\n')) await once(stream, 'drain');
  stream.end();
  await finished(file);
  renameSync(path + '.tmp', path);
}
async function headMissing(row) {
  assert(
    row.newURL.startsWith('https://assets.jotclipart.com/'),
    'Unexpected missing-object HEAD origin',
  );
  const response = await fetch(row.newURL, {
    method: 'HEAD',
    headers: { 'Cache-Control': 'no-cache' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  const length = response.headers.get('content-length');
  return {
    key: row.objectKey,
    status: response.status,
    contentType: mime(response.headers.get('content-type')),
    contentLength: length !== null ? Number(length) : null,
    etag: response.headers.get('etag'),
    cfCacheStatus: response.headers.get('cf-cache-status'),
    location: response.headers.get('location'),
    statusMeaning:
      response.status === 404
        ? 'MISSING_IN_LIST_AND_PUBLIC_HEAD_404'
        : response.ok
          ? 'PUBLIC_HEAD_PRESENT_BUT_FRESH_LIST_IDENTITY_UNRESOLVED'
          : 'MISSING_IN_LIST_PUBLIC_HEAD_UNRESOLVED',
    bodyBytesRead: 0,
  };
}
try {
  let state = existsSync(statePath)
    ? readJSON(statePath)
    : {
        schema: 1,
        transport: 'official-cloudflare-rest-read-only',
        account,
        bucket,
        sourceRoot: audit.root,
        expectedManifestSHA256: mapProof.sha256,
        startedAt: new Date().toISOString(),
        pages: [],
        complete: false,
      };
  assert(
    state.schema === 1 &&
      state.account === account &&
      state.bucket === bucket &&
      state.sourceRoot === audit.root &&
      state.expectedManifestSHA256 === mapProof.sha256,
    'Checkpoint belongs to another media inventory',
  );
  const observed = new Map(),
    allKeys = new Set();
  let metadataBytes = 0,
    listed = 0;
  function consume(data) {
    for (const row of data.result) {
      assert(
        typeof row.key === 'string' && Number.isSafeInteger(row.size) && row.size >= 0,
        'Invalid R2 object metadata',
      );
      assert(!allKeys.has(row.key), 'Duplicate object across inventory pages');
      allKeys.add(row.key);
      listed++;
      if (expected.has(row.key)) observed.set(row.key, row);
    }
  }
  for (const page of state.pages) {
    const compressed = readFileSync(join(output, page.file));
    assert(
      compressed.length === page.bytes && sha(compressed) === page.sha256,
      'Saved listing page bytes differ',
    );
    const body = gunzipSync(compressed);
    metadataBytes += body.length;
    consume(JSON.parse(body));
  }
  let cursor = state.pages.at(-1)?.nextCursor ?? null;
  while (!state.complete) {
    if (interrupted) throw Error('Read-only inventory interrupted at a saved checkpoint');
    assert(
      state.pages.length < 2000 && listed < 1000000 && metadataBytes < 512 * 1024 * 1024,
      'Full bucket inventory bounded budget exceeded',
    );
    const { body, data, complete, nextCursor, terminalSignal } = await apiPage(cursor);
    if (complete) {
      const lastKey = data.result.at(-1)?.key ?? state.lastKey;
      if (lastKey !== undefined) {
        const probe = await apiPage(null, { startAfter: lastKey, limit: 1 });
        assert(
          probe.complete && probe.data.result.length === 0,
          'Terminal boundary changed; resume the preserved tail checkpoint',
        );
        state.terminalBoundaryProbe = {
          at: new Date().toISOString(),
          terminalSignal,
          rowsAfterLastKey: 0,
        };
      } else assert(listed === 0, 'Empty terminal response lacks boundary key');
    }
    const compressed = gzipSync(body, { level: 6 }),
      file = 'pages/' + String(state.pages.length + 1).padStart(6, '0') + '.json.gz';
    atomic(join(output, file), compressed);
    consume(data);
    metadataBytes += body.length;
    state.pages.push({
      file,
      requestCursor: cursor,
      nextCursor,
      rows: data.result.length,
      bytes: compressed.length,
      sha256: sha(compressed),
      readAt: new Date().toISOString(),
    });
    state.lastKey = data.result.at(-1)?.key ?? state.lastKey;
    state.complete = complete;
    state.completedAt = state.complete ? new Date().toISOString() : null;
    saveState(state);
    cursor = nextCursor;
    if (state.pages.length === 1 || state.pages.length % 25 === 0 || state.complete)
      console.log(
        JSON.stringify({
          phase: 'read-only-R2-metadata-inventory',
          pages: state.pages.length,
          bucketObjects: listed,
          expectedMatched: observed.size,
          expected: expected.size,
          complete: state.complete,
        }),
      );
  }
  const rows = [],
    missing = [],
    mismatches = [];
  let matched = 0,
    storedSHAMatched = 0,
    noStoredSHA = 0,
    byteMatches = 0,
    mimeMatches = 0;
  for (const [key, want] of expected) {
    const actual = observed.get(key);
    if (!actual) {
      missing.push(want);
      continue;
    }
    const stored = metadataSHA(actual.custom_metadata),
      actualMime = mime(actual.http_metadata?.contentType),
      sizeMatch = actual.size === want.bytes,
      mimeMatch = actualMime === mime(want.mime),
      hashMatch = stored.length ? stored.every((x) => x.sha256 === want.sha256) : null;
    byteMatches += Number(sizeMatch);
    mimeMatches += Number(mimeMatch);
    storedSHAMatched += Number(hashMatch === true);
    noStoredSHA += Number(hashMatch === null);
    const differences = [];
    if (!sizeMatch) differences.push('byte-length');
    if (!mimeMatch) differences.push('MIME');
    if (hashMatch === false) differences.push('stored-full-SHA256');
    const row = {
      bucket,
      key,
      expectedBytes: want.bytes,
      observedBytes: actual.size,
      expectedMIME: want.mime,
      observedMIME: actualMime,
      expectedSHA256: want.sha256,
      storedSHA256: stored,
      byteLengthMatched: sizeMatch,
      mimeMatched: mimeMatch,
      storedFullSHA256Matched: hashMatch,
      etag: actual.etag ?? null,
      lastModified: actual.last_modified ?? null,
      originalBodyBytesRead: 0,
      originalBodySHA256Computed: false,
      status: differences.length
        ? 'METADATA_DIFFERENCE'
        : 'FRESH_R2_OBJECT_IDENTITY_METADATA_MATCHED',
      differences,
    };
    rows.push(row);
    if (differences.length)
      mismatches.push({
        key,
        differences,
        expectedBytes: want.bytes,
        observedBytes: actual.size,
        expectedMIME: want.mime,
        observedMIME: actualMime,
      });
    else matched++;
  }
  const missingHeads = [];
  assert(
    missing.length <= 200,
    'Too many absent expected objects; preserve inventory and investigate before individual HEADs',
  );
  for (const row of missing) {
    try {
      missingHeads.push(await headMissing(row));
    } catch {
      missingHeads.push({
        key: row.objectKey,
        status: null,
        statusMeaning: 'MISSING_IN_LIST_PUBLIC_HEAD_TRANSPORT_UNAVAILABLE',
        bodyBytesRead: 0,
      });
    }
  }
  const evidencePath = join(reports, 'catalog-media-object-evidence.jsonl.gz');
  await writeGzipRows(evidencePath, rows);
  const evidence = readFileSync(evidencePath),
    summary = {
      status:
        missing.length || mismatches.length
          ? 'MEDIA_INVENTORY_RECONCILIATION_BLOCKED'
          : 'FULL_FRESH_R2_IDENTITY_METADATA_RECONCILIATION_PASSED',
      at: new Date().toISOString(),
      sourceRoot: audit.root,
      account,
      bucket,
      officialListingReference:
        'https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/',
      transport: state.transport,
      readStartedAt: state.startedAt,
      readCompletedAt: state.completedAt,
      pages: state.pages.length,
      terminalBoundaryProbe: state.terminalBoundaryProbe,
      bucketObjectsListed: listed,
      expectedPublishedObjects: expected.size,
      expectedObjectsPresent: observed.size,
      identityMetadataMatched: matched,
      byteLengthMatches: byteMatches,
      mimeMatches,
      storedFullSHA256Matched: storedSHAMatched,
      objectsWithoutStoredFullSHA256: noStoredSHA,
      missingExpectedObjects: missing.length,
      metadataDifferences: mismatches.length,
      unexpectedBucketObjectsPreserved: listed - observed.size,
      originalBodyBytesRead: 0,
      originalBodySHA256Computed: 0,
      ETagTreatedAsMD5: false,
      newRemoteWorkerOrAccountLockCreated: false,
      localRunnerGuardCreated: true,
      cloudMutations: 0,
      fullByteHashClaim:
        'No original object bodies were downloaded. Stored full-SHA metadata equality is separate from recomputing SHA-256 over original bytes.',
      nonAtomicInventoryNote:
        'R2 list pages are not a transaction snapshot. Content-addressed expected objects were reconciled against a pinned signed source root; final live root synchronization is still required.',
      evidence: {
        file: 'catalog-media-object-evidence.jsonl.gz',
        bytes: evidence.length,
        sha256: sha(evidence),
      },
      privateCheckpoint: statePath,
      missingHeads,
      mismatches,
    };
  atomic(join(reports, 'catalog-media-inventory.json'), JSON.stringify(summary, null, 2));
  atomic(
    join(reports, 'catalog-media-inventory-progress.json'),
    JSON.stringify(
      {
        status: 'COMPLETE',
        at: summary.at,
        sourceRoot: summary.sourceRoot,
        result: 'catalog-media-inventory.json',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ...summary, missingHeads: undefined, mismatches: undefined }));
  if (missing.length || mismatches.length) process.exitCode = 2;
} catch (error) {
  atomic(
    join(reports, 'catalog-media-inventory-progress.json'),
    JSON.stringify(
      {
        status: 'INVENTORY_INCOMPLETE_RESUMABLE',
        at: new Date().toISOString(),
        sourceRoot: audit.root,
        error: error.message,
        checkpoint: statePath,
        cloudMutations: 0,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: 'INVENTORY_INCOMPLETE_RESUMABLE', error: error.message }));
  process.exitCode = 2;
} finally {
  try {
    const own = readJSON(lock);
    if (own.pid === process.pid && own.nonce === nonce) unlinkSync(lock);
  } catch {}
}
