// Actual GET/hash/MIME/CORS for incoming files only; never lists old R2 objects.
import { createHash } from 'node:crypto';
import { brand, publicBrandURL } from '../../src/lib/brand.mjs';
import { SITE_ORIGIN } from '../publication-policy.mjs';
import {
  incomingMediaFiles,
  isIncomingMediaPlan,
  incomingManifestSHA256,
} from './incoming-media-plan.mjs';
export function catalogPublicOrigin(value = brand.origin) {
  const url = new URL(value);
  const ownHost =
    url.hostname === 'jotclipart.com' ||
    url.hostname === 'jotclipart.pages.dev' ||
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.jotclipart\.pages\.dev$/.test(url.hostname);
  if (url.protocol !== 'https:' || url.origin !== value || url.port || !ownHost)
    throw Error('Reviewed catalog public origin required');
  return url.origin;
}

export async function verifyIncomingMedia(
  manifest,
  { fetcher = fetch, progress = () => {}, publicOrigin } = {},
) {
  // Historical source-receipt replay keeps its byte-identical legacy contract.
  // New-site live callers explicitly pass their reviewed public origin.
  const projected = publicOrigin !== undefined;
  const origin = projected ? catalogPublicOrigin(publicOrigin) : SITE_ORIGIN;
  const rows = [...incomingMediaFiles(manifest).values()],
    planned = isIncomingMediaPlan(manifest);
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
            const publicUrl = projected ? publicBrandURL(f.url) : f.url;
            const r = await fetcher(publicUrl, {
              redirect: 'error',
              headers: { Origin: origin },
              signal: AbortSignal.timeout(90000),
            });
            if (r.status !== 200) throw Error('Incoming media HTTP ' + r.status);
            if (
              r.headers.get('content-type')?.split(';')[0].trim() !== f.contentType ||
              !['*', origin].includes(r.headers.get('access-control-allow-origin')) ||
              (planned &&
                r.headers.get('access-control-allow-origin') !==
                  (projected && f.expectedCorsOrigin !== '*'
                    ? new URL(publicBrandURL(f.expectedCorsOrigin)).origin
                    : f.expectedCorsOrigin))
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
              ...(projected ? { publicUrl } : {}),
              assetId: f.assetId,
              kind: f.kind,
              bytes,
              sha256: f.sha256,
              contentType: f.contentType,
              ...(planned ? { corsOrigin: r.headers.get('access-control-allow-origin') } : {}),
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
    ...(projected ? { publicOrigin: origin } : {}),
    ...(planned ? { manifestSHA256: incomingManifestSHA256(manifest) } : {}),
    files: verified.sort((a, b) =>
      (a.assetId + '/' + a.kind).localeCompare(b.assetId + '/' + b.kind),
    ),
    oldCatalogScans: 0,
  };
}
