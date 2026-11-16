import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const types = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain;charset=utf-8',
  '.wasm': 'application/wasm',
};

// An isolated, bounded local substitute for the edge Cache API, for warm/cold
// request testing. It never persists or uploads catalog/user data.
export function localCache(maxBytes = 64 * 1024 * 1024) {
  const entries = new Map();
  let size = 0;
  return {
    async match(request) {
      const k = request.url ?? String(request),
        v = entries.get(k);
      if (!v) return undefined;
      entries.delete(k);
      entries.set(k, v);
      return new Response(v.body.slice(0), { status: v.status, headers: v.headers });
    },
    async put(request, response) {
      const k = request.url ?? String(request),
        body = await response.arrayBuffer();
      if (body.byteLength > maxBytes) return;
      const old = entries.get(k);
      if (old) {
        size -= old.body.byteLength;
        entries.delete(k);
      }
      while (entries.size && size + body.byteLength > maxBytes) {
        const [first, v] = entries.entries().next().value;
        entries.delete(first);
        size -= v.body.byteLength;
      }
      entries.set(k, { body, status: response.status, headers: [...response.headers] });
      size += body.byteLength;
    },
    async delete(request) {
      const k = request.url ?? String(request),
        v = entries.get(k);
      if (!v) return false;
      entries.delete(k);
      size -= v.body.byteLength;
      return true;
    },
    stats: () => ({ entries: entries.size, bytes: size, maxBytes }),
  };
}

export async function createLocalPreview({
  root = process.cwd(),
  metadata = resolve(root, '../captured-catalog'),
  cache = true,
  workerPath,
  ogBinding,
} = {}) {
  if (ogBinding && typeof ogBinding.fetch !== 'function')
    throw Error('Explicit local OG service adapter required');
  root = resolve(root);
  metadata = resolve(metadata);
  const output = await realpath(resolve(root, 'dist'));
  const metrics = { reads: 0, bytes: 0, missing: new Map() };
  const cacheApi = localCache();
  if (cache) globalThis.caches = { default: cacheApi };
  else delete globalThis.caches;
  const workerFile = workerPath ? resolve(root, workerPath) : resolve(output, '_worker.js'),
    mtime = (await stat(workerFile)).mtimeMs;
  const { default: worker } = await import(
    pathToFileURL(workerFile).href + '?local-preview=' + mtime
  );
  const env = {
    ...(ogBinding ? { OG_RENDERER: ogBinding } : {}),
    CATALOG_PAGES: {
      async get(key) {
        metrics.reads++;
        const pointer = key === 'catalog/jotclipart/active.json';
        const match =
          /^catalog\/objects\/(?:artworks|collections|search|recent|related|counts|sitemaps)\/([a-f0-9]{64})\.json$/.exec(
            key,
          );
        if (!pointer && !match) throw Error('Local catalog scope rejected');
        const file = pointer
          ? resolve(metadata, 'production-snapshot.json')
          : resolve(metadata, match[1] + '.json');
        let body;
        try {
          body = await readFile(file);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          metrics.missing.set(key, (metrics.missing.get(key) ?? 0) + 1);
          return null;
        }
        if (!pointer && createHash('sha256').update(body).digest('hex') !== match[1])
          throw Error('Local catalog checksum mismatch');
        metrics.bytes += body.length;
        const bytes = Uint8Array.from(body).buffer;
        return {
          size: body.length,
          etag: createHash('sha256').update(body).digest('hex'),
          httpMetadata: { contentType: 'application/json' },
          customMetadata: {},
          arrayBuffer: async () => bytes.slice(0),
          json: async () => JSON.parse(body),
          text: async () => body.toString('utf8'),
        };
      },
    },
    ASSETS: {
      async fetch(request) {
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
        const url = new URL(request.url);
        let path;
        try {
          path = decodeURIComponent(url.pathname);
        } catch {
          return new Response('Not found', { status: 404 });
        }
        if (path.includes('\0') || path.includes('\\'))
          return new Response('Not found', { status: 404 });
        const candidate = resolve(output, '.' + path);
        if (candidate !== output && !candidate.startsWith(output + sep))
          return new Response('Not found', { status: 404 });
        let file = candidate;
        try {
          if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
          const real = await realpath(file);
          if (!real.startsWith(output + sep)) throw Error('Unsafe static file');
          const b = await readFile(real);
          return new Response(request.method === 'HEAD' ? null : b, {
            headers: { 'content-type': types[extname(real)] ?? 'application/octet-stream' },
          });
        } catch {
          return new Response(request.method === 'HEAD' ? null : 'Not found', {
            status: 404,
            headers: { 'content-type': 'text/plain;charset=utf-8' },
          });
        }
      },
    },
    // Deliberately no AI/D1/secrets. A local preview cannot generate, alter quotas
    // or write share data. Real production binding tests are separate gates.
  };
  const pending = new Set();
  const context = {
    waitUntil(p) {
      pending.add(p);
      p.finally(() => pending.delete(p));
    },
  };
  async function handle(input, init = {}) {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(input, 'https://jotclipart.com'), init);
    Object.defineProperty(request, 'cf', { value: { country: 'US' }, configurable: true });
    return worker.fetch(request, env, context);
  }
  return {
    handle,
    metrics,
    cacheStats: cacheApi.stats,
    async settled() {
      await Promise.allSettled([...pending]);
    },
    summary: () => ({
      r2Reads: metrics.reads,
      r2Bytes: metrics.bytes,
      missingObjects: [...metrics.missing].map(([key, requests]) => ({ key, requests })),
      cache: cacheApi.stats(),
    }),
  };
}

export async function serveLocal({ port = 8797, ...options } = {}) {
  const preview = await createLocalPreview(options);
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers(req.headers);
      // Browser-local same-origin API calls exercise the production handler under
      // its real public origin. Foreign origins are never rewritten. This proxy
      // mapping is local QA only; production origin guards remain byte-for-byte.
      const localPort = server.address().port;
      const localOrigins = [`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`];
      if (localOrigins.includes(headers.get('origin')))
        headers.set('origin', 'https://jotclipart.com');
      const init = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method)) init.body = Buffer.concat(chunks);
      const response = await preview.handle(
        new Request(new URL(req.url, 'https://jotclipart.com'), init),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Local preview error');
      console.error(error.stack);
    }
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  return { server, preview, url: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const { url } = await serveLocal({ port: Number(process.env.JOTCLIPART_PREVIEW_PORT ?? 8797) });
    console.log(
      JSON.stringify({
        status: 'LOCAL_READ_ONLY_PREVIEW_READY',
        url,
        metadata: 'captured signed R2 metadata; no remote write bindings',
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'LOCAL_PREVIEW_BLOCKED',
        error: error.message,
        stack: error.stack?.split('\n').slice(1, 4),
      }),
    );
    process.exitCode = 1;
  }
}
