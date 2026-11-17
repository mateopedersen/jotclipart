import { chromium, webkit } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
const engine = process.env.UC_BROWSER || 'chromium',
  base = process.env.BASE_URL || 'http://127.0.0.1:4323';
const browser = await { chromium, webkit }[engine].launch(),
  context = await browser.newContext(),
  page = await context.newPage();
const report = { engine, states: [], errors: [], status: 'running' };
try {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of [
      '/',
      '/collections/',
      '/collection/food-drink/',
      '/clipart/giorgio-armani/',
      '/clipart/fendi/',
      '/clipart/bmw/',
      '/categories/',
      '/library-index/',
      '/new/',
      '/black-and-white/',
      '/search/?q=flowers',
      '/for-teachers/',
      '/license/',
      '/privacy/',
      '/terms/',
      '/faq/',
      '/editorial-process/',
      '/ai-clipart-generator/',
      '/about/',
      '/favorites/',
      '/create/',
      '/print-size/',
      '/art/sunflower-straw-hat/',
      '/guides/webp-pdf-and-editable-projects/',
    ]) {
      const response = await page.goto(base + route);
      assert.equal(response.status(), 200, `Expected real page at ${route}`);
      await page.evaluate(() => document.fonts.ready);
      const labels = await page
        .locator(
          '.eyebrow,.collection-eyebrow,.discovery-eyebrow,.about-eyebrow,.boards-eyebrow,.related-eyebrow,.studio-kicker,.print-eyebrow,.creative-project-eyebrow,.home-benefits-eyebrow,.home-benefit-body,.home-benefit-link,.footer-nav-card nav a,.themed-collection-hero p,.themed-collection-inventory,.mobile-subject-picker summary,.site-surprise-link strong,.site-surprise-link > span > span',
        )
        .evaluateAll((nodes) =>
          nodes
            .filter(
              (n) =>
                !n.matches('.art-detail .eyebrow') &&
                n.getBoundingClientRect().width &&
                n.getBoundingClientRect().height,
            )
            .map((n) => ({
              text: n.textContent.trim(),
              color: getComputedStyle(n).color,
              size: getComputedStyle(n).fontSize,
            })),
        );
      assert(labels.length > 0, `Missing visible typography at ${route}`);
      const unexpectedGreen = await page.locator('body').evaluate((body) =>
        Array.from(body.querySelectorAll('*')).flatMap((el) => {
          if (
            el.closest(
              'svg, .home-showcase h1, .hero > .breadcrumb, main.container > .breadcrumb:has(+ .art-detail), .art-detail .eyebrow, [data-text-preset]',
            )
          )
            return [];
          const text = Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join(' ')
            .trim();
          if (!/[A-Za-z0-9]/.test(text)) return [];
          const rect = el.getBoundingClientRect(),
            style = getComputedStyle(el);
          if (
            !rect.width ||
            !rect.height ||
            style.visibility === 'hidden' ||
            el.closest('[hidden]')
          )
            return [];
          const rgb = style.color.match(/[\d.]+/g)?.map(Number) || [];
          if (rgb.length < 3 || !(rgb[1] > rgb[0] * 1.1 && rgb[1] > rgb[2] * 1.05)) return [];
          return [
            {
              text: text.slice(0, 120),
              color: style.color,
              tag: el.tagName,
              className: el.className,
            },
          ];
        }),
      );
      for (const green of unexpectedGreen)
        report.errors.push({ route, width, unexpectedGreen: green });
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `Horizontal overflow at ${route}`,
      );
      for (const label of labels)
        if (label.color !== 'rgb(0, 0, 0)') report.errors.push({ route, width, ...label });
      const cards = await page.locator('.card-title, .related-card-title').evaluateAll((ns) =>
        ns.map((n) => ({
          weight: Number(getComputedStyle(n).fontWeight),
          color: getComputedStyle(n).color,
        })),
      );
      for (const card of cards) {
        assert(card.weight >= 800, 'Artwork card titles must stand out from descriptions');
        assert.equal(card.color, 'rgb(0, 0, 0)');
      }
      if (route.startsWith('/art/')) {
        assert(
          await page
            .locator('.art-detail h1')
            .evaluate((n) => Number(getComputedStyle(n).fontWeight) >= 800),
          'The main artwork title must stand out from its description',
        );
        const detail = await page
          .locator('main.container > .breadcrumb, .art-detail .eyebrow')
          .evaluateAll((ns) =>
            ns.map((n) => ({
              color: getComputedStyle(n).color,
              weight: Number(getComputedStyle(n).fontWeight),
            })),
          );
        assert(detail.length >= 2, 'Artwork breadcrumb and collection label must exist');
        for (const item of detail) {
          assert.equal(item.color, 'rgb(33, 110, 78)');
          assert(item.weight >= 750);
        }
      }
      if (route.startsWith('/clipart/')) {
        const breadcrumb = await page.locator('.hero > .breadcrumb').evaluate((nav) =>
          [nav, ...nav.querySelectorAll('a')].map((el) => ({
            color: getComputedStyle(el).color,
            weight: Number(getComputedStyle(el).fontWeight),
            size: parseFloat(getComputedStyle(el).fontSize),
          })),
        );
        assert(breadcrumb.length >= 4, 'Topic breadcrumb and its links must exist');
        for (const item of breadcrumb) {
          assert.equal(item.color, 'rgb(33, 110, 78)');
          assert(item.weight >= 750, 'Topic breadcrumb must be bold');
          assert(item.size >= 15, 'Topic breadcrumb must be readable on mobile');
        }
      }
      if (route === '/') {
        const hero = await page.locator('.home-showcase h1').evaluate((heading) => {
          const brand = heading.querySelector('.home-title-brand'),
            project = heading.querySelector('.home-title-project'),
            underline = brand?.querySelector('.home-title-underline'),
            brandRect = brand?.getBoundingClientRect(),
            lineRect = underline?.getBoundingClientRect();
          return {
            text: heading.textContent.replace(/\s+/g, ' ').trim(),
            brand: brand && getComputedStyle(brand).color,
            project: project && getComputedStyle(project).color,
            weight: Number(getComputedStyle(heading).fontWeight),
            underline:
              !!underline &&
              underline.getAttribute('aria-hidden') === 'true' &&
              lineRect.width > 0 &&
              lineRect.height > 0 &&
              lineRect.left >= brandRect.left - 1 &&
              lineRect.right <= brandRect.right + 1 &&
              lineRect.bottom <= brandRect.bottom + 1,
          };
        });
        assert.equal(hero.text, 'Free Clipart for Every Project');
        assert.equal(hero.brand, 'rgb(33, 110, 78)');
        assert.equal(hero.project, 'rgb(0, 0, 0)');
        assert(hero.weight >= 900, 'Homepage headline must use the requested heavy font');
        assert(hero.underline, 'Decorative underline must sit inside Free Clipart only');
        const total = await page.locator('.home-collection-total').evaluate((el) => ({
          color: getComputedStyle(el).color,
          weight: Number(getComputedStyle(el).fontWeight),
        }));
        if (total.color !== 'rgb(0, 0, 0)' || total.weight < 700)
          report.errors.push({ route, width, total });
      }
      if (route === '/collections/') {
        const axe = await new AxeBuilder({ page })
          .setLegacyMode(engine === 'webkit')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        for (const violation of axe.violations)
          report.errors.push({
            route,
            width,
            id: violation.id,
            nodes: violation.nodes.map((n) => n.target),
          });
      }
      report.states.push({ route, width, labels: labels.length });
    }
  }
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} finally {
  mkdirSync('reports/categories-refresh', { recursive: true });
  writeFileSync(`reports/categories-refresh/brand-${engine}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(
  JSON.stringify({
    engine,
    states: report.states.length,
    errors: report.errors,
    status: report.status,
  }),
);
