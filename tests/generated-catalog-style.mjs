import test from 'node:test';
import assert from 'node:assert/strict';
import {generatedCatalogStyle} from '../scripts/generated-catalog-style.mjs';
import {parseState} from '../src/lib/search.ts';
test('every generated style remains selectable through the public search contract',()=>{
  for (const input of ['Color','Cartoon','Illustration','Outline','Black & White','Watercolor','Silhouette']) {
    const style=generatedCatalogStyle(input).toLowerCase();
    assert.equal(parseState(new URLSearchParams({style})).style,style,input);
  }
});
test('unknown production labels fail closed instead of creating unreachable facets',()=>{
  assert.throws(()=>generatedCatalogStyle('Photorealistic cutout'),/Unsupported/);
});
