// Ephemeral operator-only content activation. Never include in the public Worker.
import { captureProductionSnapshot } from './signed-production-snapshot.mjs';
import { snapshotDigest } from './release-pointer.mjs';
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16))),
  enc = new TextEncoder(),
  rawHash = async (b) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
export function privateSnapshotPublisher(job) {
  if (
    job?.mode !== 'VERIFIED_CONTENT_DELTA_ACTIVATION' ||
    !/^[a-f0-9]{64}$/.test(job.secret ?? '') ||
    !/^[a-f0-9]{64}$/.test(job.parentSnapshotSHA256 ?? '') ||
    !job.snapshot ||
    job.snapshot.authorization?.parentSnapshotSHA256 !== job.parentSnapshotSHA256
  )
    throw Error('Exact signed delta and predecessor required');
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/health')
        return Response.json({
          snapshotSHA256: job.snapshotSHA256,
          parentSnapshotSHA256: job.parentSnapshotSHA256,
        });
      if (request.method !== 'POST' || path !== '/activate')
        return new Response('Not found', { status: 404 });
      if (Number(request.headers.get('content-length')) > 4096) {
        if (request.body) await request.body.cancel().catch(() => {});
        return new Response('Request too large', { status: 413 });
      }
      let body;
      try {
        if (!request.body) return new Response('Invalid request', { status: 400 });
        const reader = request.body.getReader();
        const bytes = new Uint8Array(4096);
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (size + value.byteLength > bytes.length) {
              await reader.cancel().catch(() => {});
              return new Response('Request too large', { status: 413 });
            }
            bytes.set(value, size);
            size += value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
        body = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
        );
      } catch {
        return new Response('Invalid request', { status: 400 });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return new Response('Invalid request', { status: 400 });
      const c = body.command;
      if (
        !c ||
        typeof c !== 'object' ||
        Array.isArray(c) ||
        Object.keys(c).length !== 6 ||
        c.action !== 'activate-verified-catalog-delta' ||
        c.snapshotSHA256 !== job.snapshotSHA256 ||
        c.parentSnapshotSHA256 !== job.parentSnapshotSHA256 ||
        c.accountId !== job.verifier.accountId ||
        c.bucket !== job.verifier.bucketName ||
        !Number.isSafeInteger(c.at) ||
        c.at > Date.now() ||
        Date.now() - c.at > 45000
      )
        return new Response('Fresh exact delta authorization required', { status: 409 });
      const key = await crypto.subtle.importKey(
        'raw',
        hex(job.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      if (
        typeof body.signature !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.signature) ||
        !(await crypto.subtle.verify(
          'HMAC',
          key,
          hex(body.signature),
          enc.encode(JSON.stringify(c)),
        ))
      )
        return new Response('Invalid signature', { status: 403 });
      const bytes = enc.encode(JSON.stringify(job.snapshot));
      if ((await rawHash(bytes)) !== job.snapshotSHA256) throw Error('Delta pointer bytes changed');
      const trusted = { ...job.verifier, publicKey: hex(job.verifier.publicKeyHex) },
        verified = await captureProductionSnapshot(
          {
            get: async () => ({
              size: bytes.length,
              json: async () => structuredClone(job.snapshot),
            }),
          },
          trusted,
        ),
        old = await env.TARGET.get('catalog/active.json');
      if (!old?.etag) return new Response('Existing production pointer required', { status: 409 });
      const oldSnapshot = await old.json(),
        oldDigest = await snapshotDigest(oldSnapshot);
      if (oldDigest === verified.rootSHA256)
        return Response.json({
          status: 'EXACT_DELTA_ALREADY_ACTIVE',
          snapshotSHA256: job.snapshotSHA256,
          verifiedRoot: verified.rootSHA256,
          etag: old.etag,
        });
      if (
        oldDigest !== job.parentSnapshotSHA256 ||
        oldSnapshot.revision !== job.snapshot.parentRevision
      )
        return new Response('Production predecessor changed', { status: 409 });
      await captureProductionSnapshot(
        {
          get: async () => ({
            size: JSON.stringify(oldSnapshot).length,
            json: async () => oldSnapshot,
          }),
        },
        trusted,
      );
      const updated = await env.TARGET.put('catalog/active.json', bytes, {
        onlyIf: { etagMatches: old.etag },
        sha256: job.snapshotSHA256,
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      });
      if (!updated) return new Response('Concurrent activation rejected', { status: 409 });
      const after = await env.TARGET.get('catalog/active.json');
      if (
        !after ||
        after.size !== bytes.length ||
        (await rawHash(await after.arrayBuffer())) !== job.snapshotSHA256 ||
        after.httpMetadata?.contentType !== 'application/json'
      )
        throw Error('Delta readback failed');
      return Response.json({
        status: 'VERIFIED_CONTENT_DELTA_POINTER_ACTIVE',
        snapshotSHA256: job.snapshotSHA256,
        verifiedRoot: verified.rootSHA256,
        etag: after.etag,
      });
    },
  };
}
