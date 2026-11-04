// Short-lived operator-only metadata reader. No writes/listing/public fallback.
import { captureProductionSnapshot } from './signed-production-snapshot.mjs';
const enc = new TextEncoder(),
  hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16))),
  hash = async (b) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(''),
  base64 = (b) => {
    let out = '';
    for (let i = 0; i < b.length; i += 16384)
      out += String.fromCharCode(...b.subarray(i, i + 16384));
    return btoa(out);
  };
export function privateCatalogReader(job) {
  if (
    job?.mode !== 'PINNED_CATALOG_READ_ONLY' ||
    !/^[a-f0-9]{64}$/.test(job.secret ?? '') ||
    !/^[a-f0-9]{64}$/.test(job.parentSnapshotSHA256 ?? '')
  )
    throw Error('Pinned private reader required');
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/health')
        return Response.json({ mode: job.mode, parentSnapshotSHA256: job.parentSnapshotSHA256 });
      if (
        request.method !== 'POST' ||
        path !== '/read' ||
        Number(request.headers.get('content-length')) > 16384
      )
        return new Response('Not found', { status: 404 });
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Invalid request', { status: 400 });
      }
      const c = body.command;
      if (
        !c ||
        Object.keys(c).length !== 6 ||
        c.action !== 'read-pinned-catalog-metadata' ||
        c.parentSnapshotSHA256 !== job.parentSnapshotSHA256 ||
        c.accountId !== job.verifier.accountId ||
        c.bucket !== job.verifier.bucketName ||
        !Number.isSafeInteger(c.at) ||
        c.at > Date.now() ||
        Date.now() - c.at > 45000 ||
        !Array.isArray(c.keys) ||
        c.keys.length < 1 ||
        c.keys.length > 64 ||
        new Set(c.keys).size !== c.keys.length ||
        c.keys.some(
          (k) =>
            !/^catalog\/(?:active\.json|objects\/(?:artworks|collections|search|recent|related|counts|sitemaps)\/[a-f0-9]{64}\.json)$/.test(
              k,
            ),
        )
      )
        return new Response('Fresh exact read scope required', { status: 409 });
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
          enc.encode(JSON.stringify(c)),
        ))
      )
        return new Response('Invalid signature', { status: 403 });
      const context = await captureProductionSnapshot(env.TARGET, {
        ...job.verifier,
        publicKey: hex(job.verifier.publicKeyHex),
      });
      if (context.rootSHA256 !== job.parentSnapshotSHA256)
        return new Response('Production parent changed', { status: 409 });
      const rows = Array(c.keys.length);
      let next = 0,
        total = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < c.keys.length) {
            const i = next++,
              name = c.keys[i],
              o = await env.TARGET.get(name);
            if (!o) {
              rows[i] = { key: name, missing: true };
              continue;
            }
            if (o.size > 1048576 || (total += o.size) > 4000000)
              throw Error('Private read byte bound');
            const b = new Uint8Array(await o.arrayBuffer());
            if (b.length !== o.size) throw Error('Incomplete private metadata');
            const sha256 = await hash(b);
            if (name !== 'catalog/active.json' && name.split('/').at(-1) !== sha256 + '.json')
              throw Error('Corrupt content-addressed metadata');
            rows[i] = { key: name, bytes: b.length, sha256, body: base64(b), etag: o.etag };
          }
        }),
      );
      return Response.json(
        { parentSnapshotSHA256: context.rootSHA256, objects: rows },
        { headers: { 'cache-control': 'no-store' } },
      );
    },
  };
}
