import { studioManifest } from '../lib/studio-catalog-data';
export const prerender = true;
export function GET() {
  return new Response(JSON.stringify(studioManifest), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, must-revalidate' },
  });
}
