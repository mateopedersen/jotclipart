// Preserve the existing directory codec's exact immutable bytes. No active pointer.
import { digest } from '../catalog-collections/store.mjs';
export async function stageDirectoryBytes(bucket, key, body) {
  const match = /^catalog\/objects\/collections\/([a-f0-9]{64})\.json$/.exec(key);
  if (
    !match ||
    !(body instanceof Uint8Array) ||
    body.byteLength < 1 ||
    body.byteLength > 65536 ||
    (await digest(body)) !== match[1]
  )
    throw Error('Invalid directory immutable bytes');
  const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(body));
  if (value.schema !== 1 || !['record-leaf', 'record-branch'].includes(value.type))
    throw Error('Invalid directory node');
  const same = async (object) =>
    object &&
    object.size === body.byteLength &&
    (await digest(await object.arrayBuffer())) === match[1];
  const old = await bucket.get(key);
  if (old) {
    if (!(await same(old))) throw Error('Existing directory differs');
  } else {
    const result = await bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: 'public,max-age=31536000,immutable',
      },
    });
    if (!result && !(await same(await bucket.get(key))))
      throw Error('Conditional directory creation failed');
  }
  if (!(await same(await bucket.get(key)))) throw Error('Directory readback differs');
  return { key, bytes: body.byteLength, sha256: match[1] };
}
