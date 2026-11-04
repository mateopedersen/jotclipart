import type { APIRoute } from 'astro';
import { catalogStatistics } from '../lib/catalog-statistics';
import { curatedSitemap } from '../lib/curated-collection-policy.mjs';
export const GET: APIRoute = () => {
  const xml = curatedSitemap(catalogStatistics.topics);
  return new Response(xml ?? 'Not found', {
    status: xml ? 200 : 404,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
