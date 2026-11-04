const publicPaths = [
  '/',
  '/new/',
  '/collections/',
  '/categories/',
  '/art/*/',
  '/clipart/*/',
  '/collection/*/',
];
export const navigationSpeculationRules = {
  prerender: [
    {
      source: 'document',
      where: {
        and: [
          { or: publicPaths.map((href_matches) => ({ href_matches })) },
          {
            not: {
              selector_matches:
                '[download], [target]:not([target="_self"]), [rel~="nofollow"], [data-no-prefetch]',
            },
          },
        ],
      },
      eagerness: 'moderate',
    },
  ],
};
export function navigationRulesResponse(request) {
  if (new URL(request.url).pathname !== '/navigation-rules.json') return undefined;
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  return new Response(
    request.method === 'HEAD' ? null : JSON.stringify(navigationSpeculationRules),
    {
      headers: {
        'content-type': 'application/speculationrules+json',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex',
      },
    },
  );
}
export function publicNavigationDocument(path) {
  return (
    [
      '/',
      '/new/',
      '/collections/',
      '/categories/',
      '/search/',
      '/black-and-white/',
      '/library-index/',
    ].includes(path) || /^\/(?:art|clipart|collection)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path)
  );
}
