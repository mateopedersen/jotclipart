import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const testBuildDirectory = process.env.UC_TEST_BUILD_DIR
  ? resolve(process.env.UC_TEST_BUILD_DIR)
  : fileURLToPath(new URL('../../dist/', import.meta.url));
export const testBuildUrl = pathToFileURL(testBuildDirectory + sep);
