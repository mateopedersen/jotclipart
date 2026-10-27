import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { htmlElements } from '../seo/image-seo.mjs';
/** A rollback snapshot with small public previews cannot be accidentally promoted
 * after the owner's explicit original-image restoration decision. */
export function assertOriginalImageDelivery(directory) {
  let checked = 0;
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  for (const path of walk(directory).filter((p) => p.endsWith('.html'))) {
    const elements = htmlElements(readFileSync(path, 'utf8'));
    if (
      elements.some(
        (e) =>
          e.name === 'meta' &&
          e.attributes.name === 'robots' &&
          /noindex/i.test(e.attributes.content ?? ''),
      )
    )
      continue;
    for (const element of elements) {
      if (!['img', 'source', 'link'].includes(element.name)) continue;
      for (const attr of ['src', 'srcset', 'imagesrcset', 'href']) {
        if (element.name === 'link' && element.attributes.as !== 'image') continue;
        if (/(?:^|[\s,])(?:https?:\/\/[^/]+)?\/previews\/p1\//.test(element.attributes[attr] ?? ''))
          throw Error(`Public page still selects a small catalog preview: ${path}`);
      }
    }
    checked++;
  }
  return checked;
}
