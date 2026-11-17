import {
  normalizeQuery,
  oneEditAway,
  queryTerms,
  termVariants,
  relevanceScore,
  type TermMatch,
} from './search-language.ts';
export type SiteSearchKind = 'topic' | 'collection' | 'guide' | 'tool' | 'page' | 'studio';
export interface SiteSearchEntry {
  id: string;
  kind: SiteSearchKind;
  title: string;
  description: string;
  href: string;
  text: string;
}
export const searchKindLabels: Record<string, string> = {
  all: 'All Results',
  artwork: 'Artwork',
  topic: 'Subjects',
  collection: 'Collections',
  guide: 'Guides',
  tool: 'Tools',
  page: 'Site Pages',
  studio: 'Studio Elements',
};
// The source directory is reused across keystrokes. Prepare public text once,
// without retaining queries or trusting stale fields after a metadata change.
const preparedEntries = new WeakMap<
  SiteSearchEntry,
  {
    titleSource: string;
    descriptionSource: string;
    textSource: string;
    kindSource: string;
    hrefSource: string;
    title: string[];
    body: Set<string>;
  }
>();
export function preparedSiteEntry(entry: SiteSearchEntry) {
  const old = preparedEntries.get(entry);
  if (
    old &&
    old.titleSource === entry.title &&
    old.descriptionSource === entry.description &&
    old.textSource === entry.text &&
    old.kindSource === entry.kind &&
    old.hrefSource === entry.href
  )
    return old;
  // This is the real public navigation label for the same tool whose SEO title
  // uses Generator. Do not treat incidental policy or example copy as a name.
  const navigationAlias =
    entry.kind === 'tool' && entry.href === '/ai-clipart-generator/' ? 'AI Clipart Builder' : '';
  const value = {
    titleSource: entry.title,
    descriptionSource: entry.description,
    textSource: entry.text,
    kindSource: entry.kind,
    hrefSource: entry.href,
    title: normalizeQuery(`${entry.title} ${navigationAlias}`),
    body: new Set(
      normalizeQuery(
        `${entry.title} ${navigationAlias} ${entry.description} ${entry.text} ${searchKindLabels[entry.kind]}`,
      ),
    ),
  };
  preparedEntries.set(entry, value);
  return value;
}
export function searchSiteEntries(
  entries: SiteSearchEntry[],
  query: string,
  kind = 'all',
  navigationOnly = false,
) {
  const plan = queryTerms(query),
    tokens = [...plan.tokens];
  if (plan.wantsOutline) tokens.push('outline');
  if (plan.wantsMonochrome) tokens.push('black', 'white');
  if (plan.wantsTransparent) tokens.push('transparent');
  const candidates = entries.filter((entry) => kind === 'all' || entry.kind === kind);
  const exact: { entry: SiteSearchEntry; score: number; fuzzy: boolean }[] = [],
    close: typeof exact = [];
  for (const entry of candidates) {
    const prepared = preparedSiteEntry(entry),
      title = prepared.title,
      body = navigationOnly ? new Set(title) : prepared.body;
    if (plan.excluded.some((word) => termVariants(word).some((term) => body.has(term)))) continue;
    const matches: TermMatch[] = [];
    for (const [i, token] of tokens.entries()) {
      let words = termVariants(token).filter((word) => body.has(word)),
        fuzzy = false;
      if (!words.length) {
        // A final typed fragment is a prefix, not a misspelling. Keep two-letter
        // subject navigation usable while the full artwork request continues.
        if (i === tokens.length - 1 && token.length >= 2)
          words = [...body].filter((word) => word.startsWith(token));
      }
      if (!words.length) {
        words = [...body].filter((word) => token.length >= 4 && oneEditAway(token, word));
        fuzzy = !!words.length;
      }
      if (!words.length) break;
      const positions = title.flatMap((word, i) => (words.includes(word) ? [i] : []));
      matches.push({ weight: positions.length ? 7 : 2, positions, fuzzy });
    }
    if (matches.length !== tokens.length) continue;
    const fuzzy = matches.some((m) => m.fuzzy),
      score =
        relevanceScore(matches) +
        (tokens.length === title.length && matches.every((m) => m.positions.length) ? 12 : 0);
    (fuzzy ? close : exact).push({ entry, score, fuzzy });
  }
  return (exact.length ? exact : close).sort(
    (a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, 'en'),
  );
}

/** Autocomplete navigates named subjects and collections, not incidental words in policy copy. */
export function searchNavigationEntries(entries: SiteSearchEntry[], query: string) {
  return searchSiteEntries(entries, query, 'all', true);
}
