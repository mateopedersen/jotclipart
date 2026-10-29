import { studioCatalog } from '../lib/studio-catalog-data';
export const prerender = true;
export function GET() {
  return new Response(JSON.stringify(studioCatalog), {
    headers: { 'Content-Type': 'application/json' },
  });
}
