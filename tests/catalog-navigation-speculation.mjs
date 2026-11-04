import test from 'node:test';
import assert from 'node:assert/strict';
import {
  navigationRulesResponse,
  publicNavigationDocument,
  navigationSpeculationRules,
} from '../server/catalog-snapshot/navigation-speculation.mjs';
import { loadTypescript } from './helpers/typescript.mjs';
test('same-origin public intent rules exclude editing, downloads and active tools', async () => {
  const response = navigationRulesResponse(
    new Request('https://ultraclipart.com/navigation-rules.json'),
  );
  assert.equal(response.headers.get('content-type'), 'application/speculationrules+json');
  assert.deepEqual(await response.json(), navigationSpeculationRules);
  assert.equal(navigationSpeculationRules.prerender[0].eagerness, 'moderate');
  for (const p of ['/', '/art/cat/', '/clipart/cat/', '/collection/pets/'])
    assert(publicNavigationDocument(p));
  for (const p of [
    '/edit/cat/',
    '/download/cat/',
    '/create/',
    '/favorites/',
    'https://external.invalid/art/cat/',
  ])
    assert(!publicNavigationDocument(p));
  assert.equal(
    navigationRulesResponse(
      new Request('https://ultraclipart.com/navigation-rules.json', { method: 'POST' }),
    ).status,
    405,
  );
});
test('the rules endpoint requires no snapshot or R2 read and never weakens script CSP', async () => {
  const { createCatalogHandler } = await loadTypescript('server/catalog-snapshot/handler.mjs');
  const renderer = { render: () => '', css: '', scripts: {} };
  let reads = 0;
  const handler = createCatalogHandler({
    bucket: {
      get() {
        reads++;
        throw Error('R2 must not be read');
      },
    },
    capture() {
      throw Error('Snapshot must not be read');
    },
    renderers: {
      art: renderer,
      editor: renderer,
      home: renderer,
      collection: renderer,
      shells: {},
      shellScripts: {},
    },
  });
  const response = await handler(new Request('https://ultraclipart.com/navigation-rules.json'));
  assert.equal(response.status, 200);
  assert.equal(reads, 0);
  assert(!response.headers.has('Content-Security-Policy'));
});
