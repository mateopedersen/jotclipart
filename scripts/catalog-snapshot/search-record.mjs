// Operator-only source projection. Exact known same-brand query alias only.
// This neither normalizes names nor changes public copy or reviewed topic data.
import { downloadDetails } from '../../src/lib/download-data.ts';

export const searchRecord = (a, t) =>
  a
    ? {
        ...a,
        download: downloadDetails(a),
        cluster: t.primaryCluster,
        topicLabel: t.keyword,
        keywords:
          t.slug === 'jpmorgan-chase' && t.keyword === 'JPMorgan Chase clipart'
            ? [t.keyword, 'JPMorganChase']
            : [t.keyword],
        collections: t.clusters.map(
          (c) =>
            /^\/collection\/([^/]+)\/$/.exec(c.path)?.[1] ??
            (() => {
              throw Error('Invalid reviewed category');
            })(),
        ),
      }
    : null;
