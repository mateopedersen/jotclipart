import { realpathSync } from 'node:fs';
import { resolve, dirname, basename, isAbsolute } from 'node:path';

// Installed packages retain their original ABI-bound compiled dependencies.
// Relative source-input names belong to that package's source checkout, never
// to whichever other checkout launches a content-only operation.
export function installedSourceRoot(software) {
  const directory = realpathSync(resolve(software));
  return basename(dirname(directory)) === 'work' ? dirname(dirname(directory)) : process.cwd();
}
export function installedSourcePath(software, file) {
  if (typeof file !== 'string' || !file || file.split('/').includes('..'))
    throw Error('Canonical installed source input required');
  return isAbsolute(file) ? file : resolve(installedSourceRoot(software), file);
}
