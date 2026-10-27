import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
export const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024,
  WORKER_MAX_BYTES = 64 * 1024 * 1024;
export function assertReleaseBudgets(directory) {
  let count = 0;
  const biggest = [];
  const controls = new Set(['_worker.js', '_headers', '_redirects', '_routes.json']);
  function walk(path) {
    for (const entry of readdirSync(path)) {
      const file = join(path, entry),
        stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw Error('A release must not contain symlinks');
      if (stat.isDirectory()) walk(file);
      else {
        const name = relative(directory, file);
        if (!controls.has(name)) {
          count++;
          if (stat.size > PAGES_MAX_FILE_BYTES)
            throw Error(`Pages asset exceeds 25 MiB: ${name}; shard it before publication`);
        } else if (name === '_worker.js' && stat.size > WORKER_MAX_BYTES)
          throw Error('Worker exceeds the reviewed 64 MiB uncompressed limit');
        if (name === 'studio-catalog.json' && stat.size > 20 * 1024 * 1024)
          throw Error(
            'Studio catalog exceeds its 20 MiB growth budget; shard metadata before publishing',
          );
        biggest.push({ path: name, bytes: stat.size });
      }
    }
  }
  walk(directory);
  if (count >= 85_000)
    throw Error(`Release has ${count} Pages files; migrate growing files before publishing`);
  const routes = JSON.parse(readFileSync(join(directory, '_routes.json'), 'utf8'));
  if (routes.include.length + routes.exclude.length > 100)
    throw Error('Pages route budget exceeded');
  return { pagesFiles: count, biggest: biggest.sort((a, b) => b.bytes - a.bytes).slice(0, 8) };
}
