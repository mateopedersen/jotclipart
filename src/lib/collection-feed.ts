import { categorySubjects } from './category-directory';
import { newestArt } from './catalog';
import { latestSubjectCollections } from './collection-discovery';
import { fingerprint } from './cache-fingerprint';
const items = latestSubjectCollections(categorySubjects, newestArt);
const byID = new Map(newestArt.map((a) => [a.id, a]));
// The page needs complete canonical facts for its image schema; the feed stays compact.
export const latestCollections = items.map((item) => ({
  ...item,
  artwork: byID.get(item.latestArtworkId)!,
}));
export const collectionFeed = { version: fingerprint(items), items };
