// Public addresses are a projection. Favorites, editing, media and review IDs
// retain the immutable source ID even when the human-readable URL changes.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function artworkPath(item) {
  const slug = item?.publicSlug ?? item?.id;
  if (!SLUG.test(slug ?? '')) throw Error('Invalid artwork route');
  return `/art/${slug}/`;
}
export function artworkURL(item) {
  return `https://ultraclipart.com${artworkPath(item)}`;
}
export function readableArtworkSlug(title) {
  if (typeof title !== 'string') throw Error('A source title is required');
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-clipart$/, '');
  const bounded = slug.length <= 150 ? slug : slug.slice(0, 151).replace(/-[^-]*$/, '');
  if (!SLUG.test(bounded)) throw Error('Source title has no readable URL');
  return bounded;
}
export function needsReadableArtworkSlug(id, topic) {
  return (
    /(?:^|-)20\d{6}(?:-|$)/.test(id) ||
    /(?:^|-)clipart-\d{2,4}(?:-|$)/.test(id) ||
    (id.startsWith(topic + '-') && /^\d{2,4}$/.test(id.slice(topic.length + 1)))
  );
}
