import { stagingWorker } from '../delivery/staging-worker.mjs';

// Expose inventory only. Preserve the actual R2 ETag so the caller may reuse a
// previously byte-verified hash only while the exact object version matches.
export function nativeInventoryWorker(job) {
  const worker = stagingWorker(job);
  return {
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (path !== '/health' && path !== '/inventory') return new Response(null, { status: 404 });
      if (path === '/health') return worker.fetch(request, env, ctx);
      const versions = new Map(),
        wrapped = { ...env };
      for (const bucket of job.inventoryBuckets) {
        if (!env[bucket.binding]) continue;
        wrapped[bucket.binding] = {
          list: async (options) => {
            const page = await env[bucket.binding].list(options);
            for (const object of page.objects ?? []) versions.set(object.key, object.etag);
            return page;
          },
        };
      }
      const response = await worker.fetch(request, wrapped, ctx);
      if (!response.ok) return response;
      const result = await response.json();
      result.Contents = result.Contents.map((entry) => ({
        ...entry,
        ETag: versions.get(entry.Key),
      }));
      return Response.json(result);
    },
  };
}
