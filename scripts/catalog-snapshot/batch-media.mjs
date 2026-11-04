// Actual GET/hash/MIME/CORS for incoming files only; never lists old R2 objects.
import { createHash } from 'node:crypto';
import { validateManifest } from '../publication-policy.mjs';
export async function verifyIncomingMedia(manifest, { fetcher = fetch, progress = () => {} } = {}) {
  const rows = [...validateManifest(manifest).values()];
  if (rows.length > 1024) throw Error('Incoming media batch exceeds 1,024 files');
  let next = 0;
  const verified = [];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < rows.length) {
        const f = rows[next++];
        let last;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await fetcher(f.url, {
              redirect: 'error',
              headers: { Origin: 'https://ultraclipart.com' },
              signal: AbortSignal.timeout(90000),
            });
            if (r.status !== 200) throw Error('Incoming media HTTP ' + r.status);
            if (
              r.headers.get('content-type')?.split(';')[0].trim() !== f.contentType ||
              !['*', 'https://ultraclipart.com'].includes(
                r.headers.get('access-control-allow-origin'),
              )
            )
              throw Error('Incoming media MIME/CORS mismatch');
            const hash = createHash('sha256');
            let bytes = 0;
            for await (const chunk of r.body) {
              bytes += chunk.length;
              if (bytes > f.bytes) throw Error('Incoming media exceeds reviewed bytes');
              hash.update(chunk);
            }
            if (bytes !== f.bytes || hash.digest('hex') !== f.sha256)
              throw Error('Incoming media bytes/hash mismatch');
            verified.push({
              url: f.url,
              assetId: f.assetId,
              kind: f.kind,
              bytes,
              sha256: f.sha256,
              contentType: f.contentType,
            });
            progress({ verified: verified.length, total: rows.length });
            last = null;
            break;
          } catch (e) {
            last = e;
          }
        }
        if (last) throw last;
      }
    }),
  );
  return {
    status: 'INCOMING_MEDIA_CDN_GET_BYTES_SHA_MIME_CORS_VERIFIED',
    files: verified.sort((a, b) =>
      (a.assetId + '/' + a.kind).localeCompare(b.assetId + '/' + b.kind),
    ),
    oldCatalogScans: 0,
  };
}
