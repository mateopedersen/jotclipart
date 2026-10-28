// This module is used only by a private Wrangler remote-development session.
// A fixed Merkle root limits every write to the locally reviewed release.
const encode = new TextEncoder();
const hash = async (b) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
const hex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
function decodeBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const raw = atob(text),
    bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export function stagingWorker(job) {
  const inventoryPages = job.inventoryPages ?? 1;
  if (!Number.isInteger(inventoryPages) || inventoryPages < 1 || inventoryPages > 4)
    throw Error('Bounded inventory page count required');
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health')
        return json({ root: job.root, revision: job.revision });
      if (request.method !== 'POST' || !['/stage', '/inventory'].includes(url.pathname))
        return json({ error: 'Not found' }, 404);
      if (Number(request.headers.get('content-length')) > 12_000_000)
        return json({ error: 'Request too large' }, 413);
      let body, rawBlob;
      try {
        const metadata = request.headers.get('X-UC-Stage-Metadata');
        if (metadata && (url.pathname !== '/stage' || metadata.length > 16_000))
          throw Error('Invalid binary staging metadata');
        const stream =
          request.headers.get('X-UC-Body-Encoding') === 'gzip'
            ? request.body.pipeThrough(new DecompressionStream('gzip'))
            : request.body;
        const reader = stream.getReader(),
          parts = [];
        let count = 0;
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            count += item.value.byteLength;
            if (count > 12_000_000) {
              await reader.cancel();
              throw Error('Request byte bound exceeded');
            }
            parts.push(item.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(count);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        if (metadata) {
          body = JSON.parse(metadata);
          if (body.records?.length !== 1 || body.blobs) throw Error('One binary source required');
          rawBlob = bytes;
        } else body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
      if (url.pathname === '/inventory') {
        const command = body.command;
        if (
          !command ||
          command.action !== 'list' ||
          command.at > Date.now() ||
          Date.now() - command.at > 45_000
        )
          return json({ error: 'Fresh read request required' }, 409);
        const signingKey = await crypto.subtle.importKey(
          'raw',
          hex(job.secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify'],
        );
        if (
          !/^[a-f0-9]{64}$/.test(body.signature ?? '') ||
          !(await crypto.subtle.verify(
            'HMAC',
            signingKey,
            hex(body.signature),
            encode.encode(JSON.stringify(command)),
          ))
        )
          return json({ error: 'Invalid read signature' }, 403);
        const bound = job.inventoryBuckets?.find(
          (b) => b.bucket === command.bucket && b.jurisdiction === command.jurisdiction,
        );
        if (!bound || !env[bound.binding])
          return json({ error: 'Bucket is not bound to this inventory session' }, 404);
        let cursor = command.cursor,
          entries = [],
          truncated = false;
        const seen = new Set();
        for (let page = 0; page < inventoryPages; page++) {
          const result = await env[bound.binding].list({
            limit:
              Number.isInteger(command.limit) && command.limit >= 1 && command.limit <= 1000
                ? command.limit
                : 1000,
            ...(cursor ? { cursor } : command.startAfter ? { startAfter: command.startAfter } : {}),
          });
          if (
            typeof result.truncated !== 'boolean' ||
            !Array.isArray(result.objects) ||
            (result.delimitedPrefixes?.length ?? 0) > 0
          )
            throw Error('Incomplete bound bucket inventory');
          for (const object of result.objects) {
            if (
              typeof object.key !== 'string' ||
              !Number.isSafeInteger(object.size) ||
              object.size < 0
            )
              throw Error('Invalid inventory object');
            entries.push({ Key: object.key, Size: object.size });
          }
          truncated = result.truncated;
          cursor = truncated ? result.cursor : undefined;
          if (!truncated) break;
          if (!cursor || seen.has(cursor)) throw Error('Incomplete or looping bucket inventory');
          seen.add(cursor);
        }
        return json({ IsTruncated: truncated, NextContinuationToken: cursor, Contents: entries });
      }
      const lease = body.lease;
      if (
        !lease ||
        lease.root !== job.root ||
        lease.accountId !== job.accountId ||
        lease.bucket !== job.bucket ||
        !Number.isSafeInteger(lease.projectedBytes) ||
        lease.projectedBytes > 10_000_000_000_000 ||
        lease.observedAt > Date.now() ||
        Date.now() - lease.observedAt > 45_000
      )
        return json({ error: 'Fresh storage reservation required' }, 409);
      const key = await crypto.subtle.importKey(
        'raw',
        hex(job.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      if (
        !/^[a-f0-9]{64}$/.test(body.signature ?? '') ||
        !(await crypto.subtle.verify(
          'HMAC',
          key,
          hex(body.signature),
          encode.encode(JSON.stringify(lease)),
        ))
      )
        return json({ error: 'Invalid reservation' }, 403);
      // Workers Paid permits this bounded group. The per-record proof and
      // eight-megabyte total response bound below still apply to every file.
      if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 64)
        return json({ error: 'At most 64 files per invocation' }, 400);
      const checked = [];
      const proofHashes = new Map();
      async function proofHash(pair) {
        if (!proofHashes.has(pair)) proofHashes.set(pair, hash(hex(pair)));
        return proofHashes.get(pair);
      }
      let totalBytes = 0;
      for (const { record, proof } of body.records) {
        if (
          !record ||
          !Array.isArray(proof) ||
          proof.length > 24 ||
          !Number.isSafeInteger(record.bytes) ||
          record.bytes < 1 ||
          record.bytes > 8_000_000 ||
          !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')
        )
          return json({ error: 'Invalid source' }, 400);
        let node = await hash(encode.encode(JSON.stringify(record)));
        for (const p of proof) {
          if (!/^[a-f0-9]{64}$/.test(p.hash ?? '') || typeof p.left !== 'boolean')
            return json({ error: 'Invalid proof' }, 400);
          node = await proofHash(p.left ? p.hash + node : node + p.hash);
        }
        if (node !== job.root) return json({ error: 'Source outside reviewed manifest' }, 403);
        totalBytes += record.bytes;
        if (totalBytes > 8_000_000) return json({ error: 'Batch byte bound exceeded' }, 413);
        checked.push(record);
      }
      const results = await Promise.all(
        checked.map(async (record) => {
          let object = await env.TARGET.get(record.key);
          if (!object) {
            // Local bytes are mandatory for new releases. Initial migration may copy
            // the same checked bytes from the current site; a mismatch never writes.
            let bytes;
            if (rawBlob) bytes = rawBlob;
            else if (body.blobs?.[record.path]) bytes = decodeBase64(body.blobs[record.path]);
            else {
              const source = new URL(record.path.replace(/\/index\.html$/, '/'), job.sourceOrigin);
              let response;
              for (let attempt = 0; attempt < 3; attempt++) {
                response = await fetch(source, { redirect: 'manual' });
                if (![500, 502, 503, 504].includes(response.status) || attempt === 2) break;
                await response.body?.cancel();
              }
              if (!response.ok) throw Error(`Source unavailable: ${record.path}`);
              bytes = await response.arrayBuffer();
            }
            if (bytes.byteLength !== record.bytes || (await hash(bytes)) !== record.sha256)
              throw Error(`Source checksum mismatch: ${record.path}`);
            await env.TARGET.put(record.key, bytes, {
              onlyIf: { etagDoesNotMatch: '*' },
              httpMetadata: {
                contentType: record.mime,
                cacheControl: record.path.endsWith('.html')
                  ? 'public,max-age=0,must-revalidate'
                  : 'public,max-age=31536000,immutable',
              },
              customMetadata: { sha256: record.sha256, revision: job.revision },
            });
            object = await env.TARGET.get(record.key);
          }
          if (
            !object ||
            object.size !== record.bytes ||
            object.httpMetadata?.contentType !== record.mime ||
            (await hash(await object.arrayBuffer())) !== record.sha256
          )
            throw Error(`Remote checksum mismatch: ${record.path}`);
          return {
            path: record.path,
            key: record.key,
            sha256: record.sha256,
            bytes: record.bytes,
            etag: object.etag,
          };
        }),
      );
      return json({ root: job.root, verified: results });
    },
  };
}
