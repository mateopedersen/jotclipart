import type { APIRoute } from 'astro';
import { art, topics } from '../lib/catalog';
import { sitemapDocuments } from '../lib/sitemaps';
export const GET: APIRoute = () => {
  const xml = sitemapDocuments(art, topics).find((d) => d.kind === 'collections')?.xml;
  return new Response(xml ?? 'Not found', {
    status: xml ? 200 : 404,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
