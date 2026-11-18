import { topicPageTitle } from '../../src/lib/display-title.ts';

/** The accepted topic template renders keyword; title is separate SEO/source copy.
 * Keep both source fields and validate the exact heading, without fallback titles.
 */
export function topicHeadingEvidence(record) {
  if (
    typeof record?.title !== 'string' ||
    !record.title.trim() ||
    typeof record.keyword !== 'string' ||
    !record.keyword.trim()
  )
    throw new Error('Signed topic title and native heading keyword are required');
  return {
    sourceTitle: record.title,
    headingSource: record.keyword,
    displayTitle: topicPageTitle(record.keyword),
  };
}
