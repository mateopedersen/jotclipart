import { SnapshotFault } from './fault.mjs';
const validSlug = (x) => typeof x === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x);
const fail = (m) => {
  throw new SnapshotFault(503, m);
};
function artwork(a) {
  if (
    !a ||
    !validSlug(a.id) ||
    !validSlug(a.topic) ||
    a.published !== true ||
    a.indexable !== true ||
    typeof a.title !== 'string' ||
    typeof a.alt !== 'string' ||
    typeof a.description !== 'string' ||
    !Number.isSafeInteger(a.width) ||
    a.width < 1 ||
    !Number.isSafeInteger(a.height) ||
    a.height < 1
  )
    fail('Invalid reviewed page artwork');
  for (const kind of ['webp', 'pdf']) {
    let u;
    try {
      u = new URL(a[kind]);
    } catch {
      fail('Missing original page media');
    }
    if (
      !['https://assets.ultraclipart.com', 'https://assets.jotclipart.com'].includes(u.origin) ||
      u.search ||
      u.hash ||
      u.username ||
      u.password ||
      !/^[a-f0-9]{64}$/.test(a.files?.[kind]?.sha256 ?? '')
    )
      fail('Invalid original page media');
  }
  if (a.thumb !== a.webp) fail('Original page image changed');
  return a;
}
export { artwork as validatePageArtwork };
