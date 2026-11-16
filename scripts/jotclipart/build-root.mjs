import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

/** A release keeps its original ABI-bound compiled inputs at this exact path. */
export function buildRoot(value = process.env.JOTCLIPART_BUILD_ROOT, root = process.cwd()) {
  const input = value ?? 'work/jotclipart-build';
  if (
    typeof input !== 'string' ||
    !/^work\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(input)
  )
    throw Error('JOTCLIPART_BUILD_ROOT must name a separate relative work descendant');
  const base = realpathSync(root),
    target = resolve(base, input);
  if (!target.startsWith(resolve(base, 'work') + sep))
    throw Error('Build output must remain under this checkout work directory');
  let current = base;
  for (const part of input.split('/')) {
    current = resolve(current, part);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        !realpathSync(current).startsWith(base + sep)
      )
        throw Error('Build output cannot follow a symlink or non-directory');
    }
  }
  return relative(base, target).split(sep).join('/');
}
