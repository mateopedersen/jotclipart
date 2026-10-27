import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function deliveryKey(path, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('A committed production revision is required');
  if (/^\/(art|edit)\/[a-z0-9]+(?:-[a-z0-9]+)*\/index\.html$/.test(path))
    return `delivery/${revision}${path}`;
  if (/^\/previews\/p1\/[a-f0-9]{24}-(96|220|320|440|640|960)\.webp$/.test(path))
    return `delivery${path}`;
  if (/^\/_astro\/[A-Za-z0-9_.-]+$/.test(path)) return `delivery/assets${path}`;
  throw Error(`Unsupported delivery path: ${path}`);
}
export function collectDeliveryFiles(dist, revision) {
  const entries = [];
  for (const base of ['art', 'edit', 'previews/p1', '_astro']) {
    function walk(dir) {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name),
          st = lstatSync(file);
        if (st.isSymbolicLink()) throw Error('Delivery sources cannot be symlinks');
        if (st.isDirectory()) walk(file);
        else {
          const path = '/' + relative(dist, file).replaceAll('\\', '/');
          const key = deliveryKey(path, revision),
            bytes = readFileSync(file);
          if (!bytes.length || bytes.length > 8_000_000)
            throw Error(`Invalid delivery size: ${path}`);
          if (
            path.endsWith('.html') &&
            !bytes.toString('utf8').includes(`name="build-revision" content="${revision}"`)
          )
            throw Error(`Mixed HTML release: ${path}`);
          entries.push({
            path,
            key,
            bytes: bytes.length,
            sha256: digest(bytes),
            mime: path.endsWith('.html')
              ? 'text/html; charset=utf-8'
              : path.endsWith('.webp')
                ? 'image/webp'
                : path.endsWith('.js')
                  ? 'application/javascript'
                  : path.endsWith('.css')
                    ? 'text/css'
                    : path.endsWith('.woff2')
                      ? 'font/woff2'
                      : path.endsWith('.wasm')
                        ? 'application/wasm'
                        : null,
          });
          if (!entries.at(-1).mime) throw Error(`Unsupported delivery MIME: ${path}`);
        }
      }
    }
    walk(join(dist, base));
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export const leaf = (record) => digest(Buffer.from(JSON.stringify(record)));
const parent = (a, b) => digest(Buffer.from(a + b, 'hex'));
export function merkle(records) {
  if (!records.length) throw Error('Empty delivery manifest');
  const levels = [records.map(leaf)];
  while (levels.at(-1).length > 1) {
    const last = levels.at(-1),
      next = [];
    for (let i = 0; i < last.length; i += 2) next.push(parent(last[i], last[i + 1] ?? last[i]));
    levels.push(next);
  }
  return {
    root: levels.at(-1)[0],
    proof(index) {
      const proof = [];
      for (let n = 0; n < levels.length - 1; n++) {
        const row = levels[n];
        proof.push({ hash: row[index ^ 1] ?? row[index], left: !!(index % 2) });
        index = Math.floor(index / 2);
      }
      return proof;
    },
  };
}
export function verifyDeliveryManifest(dist, manifest, revision) {
  if (
    manifest?.schema !== 1 ||
    manifest.status !== 'remote-byte-verified' ||
    manifest.revision !== revision ||
    manifest.bucket !== 'ultraclipart-pages'
  )
    throw Error('Delivery publication requires a verified manifest for this revision');
  const actual = collectDeliveryFiles(dist, revision);
  if (
    JSON.stringify(actual) !== JSON.stringify(manifest.files) ||
    merkle(actual).root !== manifest.root ||
    manifest.verified !== actual.length
  )
    throw Error('Delivery files changed or verification is incomplete');
  return actual;
}
export function pruneDeliveryFiles(dist, manifest, revision) {
  const files = verifyDeliveryManifest(dist, manifest, revision);
  for (const file of files) rmSync(join(dist, file.path));
  return files.length;
}
