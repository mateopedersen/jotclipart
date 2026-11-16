import { artworkPath } from './artwork-route.mjs';
import { displayTitle, displayCatalogTitle } from './display-title.ts';
import { normalizeQuery, queryTerms, termVariants } from './search-language.ts';
import { preparedSiteEntry, type SiteSearchEntry, type SiteSearchKind } from './site-search.ts';
import type { SearchCard } from './search-index.ts';

export interface SearchSuggestion {
  title: string;
  href: string;
  kind: string;
  thumb?: string;
  thumbSrcSet?: string;
  alt?: string;
}

// A suggestion names its destination, while the full search tabs use plural
// category labels. Keep these separate so a subject set is not confused with
// one downloadable illustration or a broader collection.
const suggestionKindLabels: Record<SiteSearchKind, string> = {
  topic: 'Clipart Set',
  collection: 'Collection',
  guide: 'Guide',
  tool: 'Tool',
  page: 'Site Page',
  studio: 'Studio Element',
};

/** Promote deliberate subject/tool navigation, not incidental matches in page copy. */
export function isDirectSearchMatch(entry: SiteSearchEntry, query: string) {
  const plan = queryTerms(query);
  const words = [...plan.tokens];
  if (plan.wantsOutline) words.push('outline');
  if (plan.wantsMonochrome) words.push('black', 'white');
  if (plan.wantsTransparent) words.push('transparent');
  const title = preparedSiteEntry(entry).title;
  return (
    words.length > 0 &&
    words.every((word, index) =>
      termVariants(word).some(
        (term) =>
          title.includes(term) ||
          (index === words.length - 1 &&
            term.length >= 2 &&
            title.some((part) => part.startsWith(term))),
      ),
    )
  );
}

export function searchSuggestions(
  query: string,
  artwork: SearchCard[],
  matches: { entry: SiteSearchEntry; fuzzy: boolean }[],
): SearchSuggestion[] {
  const direct = matches.filter((match) => !match.fuzzy && isDirectSearchMatch(match.entry, query));
  const toSuggestion = ({ entry }: { entry: SiteSearchEntry }): SearchSuggestion => ({
    title: ['topic', 'collection'].includes(entry.kind)
      ? displayCatalogTitle(entry.title)
      : displayTitle(entry.title),
    href: entry.href,
    kind: suggestionKindLabels[entry.kind],
  });
  const candidates = [
    ...direct.slice(0, 2).map(toSuggestion),
    ...artwork.slice(0, 4).map((item) => ({
      title: displayCatalogTitle(item.title),
      href: artworkPath(item),
      kind: 'Individual Clipart',
      thumb: item.suggestionThumb ?? item.thumb,
      ...(!item.suggestionThumb && item.thumbSrcSet ? { thumbSrcSet: item.thumbSrcSet } : {}),
      alt: item.alt,
    })),
    ...matches.map(toSuggestion),
  ];
  const seen = new Set<string>();
  return [
    ...candidates.filter(({ href }) => !seen.has(href) && !!seen.add(href)).slice(0, 7),
    {
      title: `See all results for “${query}”`,
      href: `/search/?q=${encodeURIComponent(query)}`,
      kind: 'Search',
    },
  ];
}
