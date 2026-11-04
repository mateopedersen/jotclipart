import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** All five compilers use this exact implementation, bundled into each renderer. */
export function writeScopedContext(destination, root) {
  const helper = join(root, 'server/catalog-snapshot/scoped-context.mjs');
  writeFileSync(destination, `import {createScopedContext} from ${JSON.stringify(helper)};\nexport const {requestState,current,scoped}=createScopedContext();\n`);
}
