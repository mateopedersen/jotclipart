import { studioShards } from '../../lib/studio-catalog-data';
import type { APIRoute } from 'astro';
export const prerender = true;
export function getStaticPaths() {
  return studioShards.map((s) => ({
    params: { file: s.file.replace(/\.json$/, '') },
    props: { body: s.body },
  }));
}
export const GET: APIRoute = ({ props }) =>
  new Response(props.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, must-revalidate',
    },
  });
