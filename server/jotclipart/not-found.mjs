import art from '../../data/jotclipart-not-found.json' with { type: 'json' };

const shortcuts = [
  {
    title: 'Browse collections',
    description: 'Find clipart by theme.',
    href: '/collections/',
    icon: '◫',
  },
  {
    title: 'See new clipart',
    description: 'Find the latest illustrations.',
    href: '/new/',
    icon: '✦',
  },
  {
    title: 'Open Clipart Studio',
    description: 'Make something of your own.',
    href: '/create/',
    icon: '✎',
  },
];

// Reuse the same progressive search enhancement shipped by the site layout.
export function notFoundSearchScript(scripts = {}) {
  const entry = Object.entries(scripts).find(([name]) =>
    name.endsWith('/layouts/Layout.astro?astro&type=script&index=3&lang.ts'),
  );
  return entry?.[1];
}

export function notFoundHTML(searchScript) {
  if (searchScript && !/^\/__ssr-client\/[a-f0-9]{40}\/[A-Za-z0-9_-]+\.js$/.test(searchScript))
    throw Error('Invalid error-page search asset');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#f7faf7">
  <title>Page not found | JotClipart</title>
  <link rel="icon" href="/favicon.ico">
  <link rel="stylesheet" href="/styles/jotclipart-not-found-v1.css">
</head>
<body class="error-page">
  <header class="error-header">
    <div class="error-width">
      <a class="error-brand" href="/" aria-label="JotClipart home">
        <img src="/brand/jotclipart-logo-3d-320.webp" width="143" height="34" alt="JotClipart">
      </a>
      <a class="error-home" href="/"><span aria-hidden="true">←</span> Back to home</a>
    </div>
  </header>
  <main class="error-width" id="main">
    <section class="error-hero" aria-labelledby="error-title">
      <div class="error-copy">
        <p class="error-status">404</p>
        <h1 id="error-title">We couldn't find that page.</h1>
        <p class="error-description">The link may have changed. Find what you were looking for in the clipart library.</p>
        <form class="error-search" role="search" action="/search/" method="get">
          <label for="nf-query">Search the library</label>
          <div class="error-field">
            <input id="nf-query" name="q" type="search" maxlength="320" autocomplete="off" placeholder="Try “botanical leaves”" required>
            <button type="submit">Search <span aria-hidden="true">↗</span></button>
          </div>
        </form>
      </div>
      <div class="error-visual">
        <img src="${art.src}" srcset="${art.srcset}" sizes="(max-width: 760px) min(78vw, 450px), 48vw"
          width="${art.width}" height="${art.height}" alt="${art.alt}" fetchpriority="high" decoding="async">
      </div>
    </section>
    <nav class="error-shortcuts" aria-label="Explore JotClipart">
      ${shortcuts
        .map(
          ({ title, description, href, icon }) => `
      <a href="${href}">
        <span class="error-shortcut-icon" aria-hidden="true">${icon}</span>
        <span><strong>${title}</strong><small>${description}</small></span>
        <span class="error-arrow" aria-hidden="true">↗</span>
      </a>`,
        )
        .join('')}
    </nav>
  </main>
  <footer class="error-width error-footer">
    <a href="/"><strong>JotClipart</strong></a>
    <a href="/contact/">Report a broken link</a>
  </footer>
  ${searchScript ? `<script src="${searchScript}" type="module"></script>` : ''}
</body>
</html>`;
}

export function notFoundResponse(request, searchScript) {
  return new Response(request.method === 'HEAD' ? null : notFoundHTML(searchScript), {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
