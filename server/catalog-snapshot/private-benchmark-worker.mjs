// Private transport test only. It cannot write or remove production metadata.
import { stagingWorker } from '../../scripts/delivery/staging-worker.mjs';
export function privateBenchmarkWorker(job) {
  if (job?.benchmark !== true || !/^private-benchmark\/[a-f0-9]{32}\/$/.test(job.testPrefix ?? ''))
    throw Error('Random isolated benchmark prefix required');
  const inner = stagingWorker(job);
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path !== '/cleanup')
        return inner.fetch(request, {
          TARGET: {
            get: (key) => {
              if (!key.startsWith(job.testPrefix)) throw Error('Benchmark read escaped');
              return env.TARGET.get(key);
            },
            put: (key, b, o) => {
              if (!key.startsWith(job.testPrefix)) throw Error('Benchmark write escaped');
              return env.TARGET.put(key, b, o);
            },
          },
        });
      if (request.method !== 'POST') return new Response('Not found', { status: 404 });
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 64000) return new Response('Too large', { status: 413 });
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (
        !Array.isArray(body.records) ||
        body.records.length > 64 ||
        body.records.some((r) => !r.record?.key?.startsWith(job.testPrefix))
      )
        return new Response('Invalid cleanup scope', { status: 403 });
      const response = await inner.fetch(
        new Request(new URL('/verify', request.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: bytes,
        }),
        env,
      );
      if (!response.ok) return response;
      const proof = await response.json();
      if (proof.missing?.length || proof.verified.length !== body.records.length)
        return new Response('Missing exact test objects', { status: 409 });
      await env.TARGET.delete(proof.verified.map((r) => r.key));
      return Response.json({ root: job.root, deleted: proof.verified.map((r) => r.key) });
    },
  };
}
