// Private, ephemeral local-operator control only. NEVER route this publicly.
import { captureProductionSnapshot } from './signed-production-snapshot.mjs';
import { catalogPointerKey } from './release-pointer.mjs';
const digest = async (bytes) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(''),
  hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16))),
  encoder = new TextEncoder();
export function privateSnapshotInstaller(job) {
  if (
    job?.mode !== 'INITIAL_SOURCE_VERIFIED_INSTALL' ||
    !/^[a-f0-9]{64}$/.test(job.secret ?? '') ||
    !/^[a-f0-9]{64}$/.test(job.snapshotSHA256 ?? '') ||
    !job.snapshot
  )
    throw Error('Exact reviewed initial installation required');
  if (!job.verifier || typeof job.verifier !== 'object' || Array.isArray(job.verifier))
    throw Error('Exact verifier scope required');
  const pointerKey = catalogPointerKey(job.verifier);
  const namespaceRequired = job.verifier.activeKey !== undefined;
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health')
        return Response.json({
          snapshotSHA256: job.snapshotSHA256,
          ...(namespaceRequired ? { pointerKey } : {}),
        });
      if (
        request.method !== 'POST' ||
        url.pathname !== '/install' ||
        Number(request.headers.get('content-length')) > 4096
      )
        return new Response('Not found', { status: 404 });
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Invalid request', { status: 400 });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return new Response('Invalid request', { status: 400 });
      const c = body.command;
      const hasPointer = c && typeof c === 'object' && Object.hasOwn(c, 'pointerKey');
      if (
        !c ||
        typeof c !== 'object' ||
        Array.isArray(c) ||
        Object.keys(c).length !==
          (job.previous ? 6 : 5) + (namespaceRequired || hasPointer ? 1 : 0) ||
        (namespaceRequired && !hasPointer) ||
        (hasPointer && c.pointerKey !== pointerKey) ||
        (job.previous?.pointerKey !== undefined && job.previous.pointerKey !== pointerKey) ||
        (job.previous && c.previousSnapshotSHA256 !== job.previous.snapshotSHA256) ||
        c.action !== 'install-initial-snapshot' ||
        c.snapshotSHA256 !== job.snapshotSHA256 ||
        c.accountId !== job.verifier.accountId ||
        c.bucket !== job.verifier.bucketName ||
        !Number.isSafeInteger(c.at) ||
        c.at > Date.now() ||
        Date.now() - c.at > 45000
      )
        return new Response('Fresh scoped authorization required', { status: 409 });
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
          encoder.encode(JSON.stringify(c)),
        ))
      )
        return new Response('Invalid signature', { status: 403 });
      const snapshotBytes = encoder.encode(JSON.stringify(job.snapshot));
      if ((await digest(snapshotBytes)) !== job.snapshotSHA256)
        throw Error('Installation bytes changed');
      const verifier = { ...job.verifier, publicKey: hex(job.verifier.publicKeyHex) };
      if (catalogPointerKey(verifier) !== pointerKey) throw Error('Verifier pointer scope changed');
      await captureProductionSnapshot(
        {
          get: async (key) => {
            if (key !== pointerKey) throw Error('Snapshot verifier pointer scope differs');
            return {
              size: snapshotBytes.length,
              json: async () => structuredClone(job.snapshot),
            };
          },
        },
        verifier,
      );
      const existing = await env.TARGET.get(pointerKey);
      if (existing) {
        const bytes = await existing.arrayBuffer();
        if ((await digest(bytes)) === job.snapshotSHA256)
          return Response.json({
            status: 'ALREADY_EXACT_INITIAL_SNAPSHOT',
            snapshotSHA256: job.snapshotSHA256,
            etag: existing.etag,
            ...(namespaceRequired || hasPointer ? { pointerKey } : {}),
          });
        if (
          !job.previous ||
          existing.etag !== job.previous.etag ||
          (await digest(bytes)) !== job.previous.snapshotSHA256
        )
          return new Response(
            'Existing pointer differs; use separate conditional update workflow',
            { status: 409 },
          );
        const old = JSON.parse(new TextDecoder().decode(bytes));
        await captureProductionSnapshot(
          {
            get: async (key) => {
              if (key !== pointerKey) throw Error('Snapshot verifier pointer scope differs');
              return { size: bytes.byteLength, json: async () => old };
            },
          },
          { ...verifier, abiSHA256: job.previous.abiSHA256 },
        );
        const scope = (s) =>
          JSON.stringify({
            schema: s.schema,
            status: s.status,
            revision: s.revision,
            parentRevision: s.parentRevision,
            indexes: s.indexes,
            policy: s.authorization.policy,
            accountId: s.authorization.accountId,
            bucket: s.authorization.bucket,
            keyId: s.authorization.keyId,
            sourceReceiptSHA256: s.authorization.sourceReceiptSHA256,
            mediaReceiptSHA256: s.authorization.mediaReceiptSHA256,
            manifestRoot: s.authorization.manifestRoot,
            parentSnapshotSHA256: s.authorization.parentSnapshotSHA256,
          });
        if (scope(old) !== scope(job.snapshot))
          return new Response('Software rebind must preserve exact catalog and source scope', {
            status: 409,
          });
        const put = await env.TARGET.put(pointerKey, snapshotBytes, {
          onlyIf: { etagMatches: existing.etag },
          sha256: job.snapshotSHA256,
          httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
        });
        if (!put) return new Response('Concurrent software rebind rejected', { status: 409 });
        const after = await env.TARGET.get(pointerKey);
        if (
          !after ||
          after.size !== snapshotBytes.length ||
          (await digest(await after.arrayBuffer())) !== job.snapshotSHA256 ||
          after.httpMetadata?.contentType !== 'application/json'
        )
          throw Error('Rebound pointer readback failed');
        return Response.json({
          status: 'INITIAL_SNAPSHOT_SOFTWARE_REBOUND_NOT_A_WEBSITE_DEPLOYMENT',
          snapshotSHA256: job.snapshotSHA256,
          previousSnapshotSHA256: job.previous.snapshotSHA256,
          etag: after.etag,
          ...(namespaceRequired || hasPointer ? { pointerKey } : {}),
        });
      }
      const put = await env.TARGET.put(pointerKey, snapshotBytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        sha256: job.snapshotSHA256,
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      });
      if (!put) return new Response('Concurrent pointer installation', { status: 409 });
      const readback = await env.TARGET.get(pointerKey);
      if (
        !readback ||
        readback.size !== snapshotBytes.length ||
        (await digest(await readback.arrayBuffer())) !== job.snapshotSHA256 ||
        readback.httpMetadata?.contentType !== 'application/json'
      )
        throw Error('Pointer readback failed');
      return Response.json({
        status: 'INITIAL_SNAPSHOT_BYTES_INSTALLED_NOT_A_WEBSITE_DEPLOYMENT',
        snapshotSHA256: job.snapshotSHA256,
        etag: readback.etag,
        ...(namespaceRequired || hasPointer ? { pointerKey } : {}),
      });
    },
  };
}
