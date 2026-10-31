import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewedProductMetadata } from '../scripts/product-identity.mjs';
import { packageMetadata } from '../scripts/remaining-thirty-one-copy.mjs';
const reviews = JSON.parse(
  readFileSync(new URL('../scripts/remaining-product-identities.json', import.meta.url)),
);
test('all 150 branded images have source-bound visual reviews and manufacturer references', () => {
  assert.equal(Object.keys(reviews).length, 150);
  for (const [id, record] of Object.entries(reviews)) {
    const result = packageMetadata(id.split('-clipart-')[0], id, record.sourceSha256);
    assert.equal(result.alt, record.caption);
    assert.equal(result.title, record.subject + ' Clipart');
    assert.deepEqual(result.productIdentity, reviewedProductMetadata(record).productIdentity);
    assert.throws(() => packageMetadata(id.split('-clipart-')[0], id, '0'.repeat(64)), /changed/);
  }
});
test('unknown models, changed images and invented production concepts fail closed', () => {
  const model = reviews['tesla-clipart-model-x-falcon-doors'];
  assert.equal(model.model, 'Model X');
  assert.throws(() => reviewedProductMetadata(null), /review/);
  assert.throws(
    () => reviewedProductMetadata({ ...model, sourcePath: undefined }),
    /source image path/,
  );
  assert.throws(() => packageMetadata('tesla', 'tesla-clipart-unreviewed-flying-car'), /review/);
  assert.throws(() => reviewedProductMetadata({ ...model, reviewedFromPixels: false }), /review/);
  assert.throws(
    () => reviewedProductMetadata({ ...model, reference: 'https://rumors.example/car' }),
    /manufacturer/,
  );
  assert.throws(
    () => reviewedProductMetadata({ ...model, kind: 'imagined-concept' }),
    /exact production model/,
  );
  const flying = packageMetadata('tesla', 'tesla-clipart-roadster-rocket-vertical-liftoff');
  assert.equal(flying.productIdentity.model, null);
  assert.equal(flying.productIdentity.kind, 'imagined-concept');
  assert.match(flying.title, /Flying Sports Car Concept/);
  assert.match(flying.description, /fictional flight/);
  const orange = packageMetadata('iphone', 'iphone-clipart-iphone-17-pro-max-cosmic-orange-gimbal');
  assert.equal(orange.productIdentity.model, null);
  assert.doesNotMatch(orange.title, /17|Pro Max/);
  assert.match(
    packageMetadata('tesla', 'tesla-clipart-first-roadster-open-top').title,
    /First-generation Tesla Roadster/,
  );
});

test('a model downgrade cannot retain an unreviewed generation from a draft', () => {
  const model = reviews['tesla-clipart-model-x-falcon-doors'];
  assert.throws(
    () => reviewedProductMetadata({ ...model, generation: 'Second generation' }),
    /Generation needs its own source-bound review/,
  );
  assert.throws(
    () => reviewedProductMetadata({ ...model, model: null, kind: 'product-family', generation: 'F90' }),
    /Generation needs its own source-bound review/,
  );
});

test('a partial chassis code is not evidence for a different generation', () => {
  const model = reviews['tesla-clipart-model-x-falcon-doors'];
  assert.throws(
    () =>
      reviewedProductMetadata({
        ...model,
        generation: 'E3',
        subject: 'Vehicle E30',
        caption: 'The E30 body is shown from the side.',
        evidence: 'E30 body geometry and the visible lamps were compared.',
      }),
    /Generation needs its own source-bound review/,
  );
});

test('explicit generation evidence is bound to the same pixels and manufacturer', () => {
  const original = reviews['tesla-clipart-first-roadster-open-top'];
  const record = {
    ...original,
    subject: 'Tesla Roadster with an Open Roof',
    caption: 'A green Tesla Roadster with its two-seat cabin open.',
    generationReview: {
      generation: original.generation,
      sourceSha256: original.sourceSha256,
      reviewedFromPixels: true,
      visibleFeatures: 'Compact original Roadster body, rounded headlamps and open two-seat cabin.',
      reference: original.reference,
      checkedAt: original.checkedAt,
    },
  };
  assert.equal(reviewedProductMetadata(record).productIdentity.generation, 'First generation');
  for (const patch of [
    { sourceSha256: '0'.repeat(64) },
    { generation: 'Second generation' },
    { reviewedFromPixels: false },
    { checkedAt: 'not a date' },
    { reference: 'https://unverified.example/car' },
  ])
    assert.throws(
      () => reviewedProductMetadata({ ...record, generationReview: { ...record.generationReview, ...patch } }),
      /Generation review/,
    );
});
