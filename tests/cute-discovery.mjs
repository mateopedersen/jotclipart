import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTypescript } from './helpers/typescript.mjs';
const { cuteConfidence, buildCuteIndex, pickCute, validCuteIndex } = await loadTypescript(
  'src/lib/cute-discovery.ts',
);
const art = JSON.parse(readFileSync('data/art.json', 'utf8'));
const sample = {
  id: 'smiling-new-fruit',
  topic: 'new-fruit',
  title: 'Smiling new fruit',
  alt: 'A smiling fruit character with bright eyes, small hands and feet.',
  discovery: { cute: true },
  style: 'Color',
  published: true,
  indexable: true,
};

test('real catalog recognition includes fruit and animals, excludes monochrome and ordinary artwork', () => {
  const index = buildCuteIndex(art);
  assert.ok(index.length > 100 && index.length <= 512);
  assert.ok(index.some((x) => x.topic === 'apple'));
  assert.ok(index.some((x) => x.topic === 'rabbit'));
  for (const pick of index) {
    const source = art.find((x) => x.id === pick.id);
    assert.ok(cuteConfidence(source) >= 68);
    assert.doesNotMatch(source.style, /Black|Outline|Silhouette/);
  }
  assert.equal(
    cuteConfidence({
      ...sample,
      id: 'plain-photo',
      title: 'A red apple',
      alt: 'A plain red apple',
      discovery: undefined,
    }),
    0,
  );
  assert.ok(
    cuteConfidence({
      ...sample,
      id: 'happy-future-robot',
      topic: 'robot',
      title: 'Happy robot',
    }) > 0,
  );
});
test('decorative materials alone do not make ordinary objects cheerful subjects', () => {
  for (const [id, title, alt, topic] of [
    ['mandarin-knitted', 'Knitted mandarin', 'A mandarin made of orange yarn', 'mandarin'],
    ['apple-crochet', 'Crochet apple', 'An apple made of red yarn with a green leaf', 'apple'],
    ['pear-felt', 'Felt pear', 'A felt pear with a stitched leaf', 'pear'],
    ['phone', 'Mobile phone', 'A mobile phone with a blank screen', 'mobile-phone'],
  ]) {
    assert.equal(cuteConfidence({ ...sample, id, title, alt, topic }), 0, id);
  }
  assert.ok(
    cuteConfidence({
      ...sample,
      id: 'fox-waving',
      topic: 'fox',
      title: 'Waving fox in a knitted scarf',
      alt: 'A cheerful fox waving while wearing a knitted scarf',
    }) > 0,
  );
  assert.ok(
    cuteConfidence({
      ...sample,
      id: 'mom-baby-hug',
      topic: 'mom',
      title: 'Mother hugging her baby',
      alt: 'A mother cuddling her baby',
    }) > 0,
  );
});
test('explicit review cannot override monochrome or frightening subject exclusions', () => {
  for (const id of [
    'cute-black-and-white-rabbit',
    'baby-outline-fox',
    'smiling-skeleton',
    'cute-angry-robot',
    'not-cute-fruit',
  ])
    assert.equal(cuteConfidence({ ...sample, id, discovery: { cute: true } }), 0, id);
  assert(cuteConfidence({ ...sample, discovery: { cute: false } }) > 0);
  assert.equal(cuteConfidence({ ...sample, discovery: { exclude: true } }), 0);
  assert.equal(
    cuteConfidence({
      ...sample,
      files: { webp: { sha256: 'a'.repeat(64) } },
      discovery: { cute: false, reviewedSourceSha256: 'a'.repeat(64) },
    }),
    0,
  );
  assert(
    cuteConfidence({
      ...sample,
      files: { webp: { sha256: 'b'.repeat(64) } },
      discovery: { cute: false, reviewedSourceSha256: 'a'.repeat(64) },
    }) > 0,
  );
  assert.equal(cuteConfidence({ ...sample, published: false }), 0);
  assert.equal(cuteConfidence({ ...sample, indexable: false }), 0);
  assert.equal(cuteConfidence({ ...sample, style: 'Black & White', discovery: { cute: true } }), 0);
  assert.equal(cuteConfidence({ ...sample, style: 'Grayscale' }), 0);
  assert.equal(
    cuteConfidence({ ...sample, alt: 'A fierce angry character', discovery: { cute: true } }),
    0,
  );
});
test('streaming reservoir stays bounded and deterministically rotates across seed versions', () => {
  function* stream() {
    for (let i = 0; i < 10000; i++)
      yield { ...sample, id: `smiling-fruit-${i}`, topic: `subject-${i % 20}` };
  }
  const a = buildCuteIndex(stream(), 64, 'release-a'),
    b = buildCuteIndex(stream(), 64, 'release-b');
  assert.equal(a.length, 64);
  assert.equal(new Set(a.map((x) => x.id)).size, 64);
  assert.deepEqual(a, buildCuteIndex(stream(), 64, 'release-a'));
  assert.notDeepEqual(a, b);
});
test('selection avoids recent IDs, the current page and consecutive subjects; sparse pools stay safe', () => {
  const pool = [
    { id: 'apple-a', topic: 'apple' },
    { id: 'apple-b', topic: 'apple' },
    { id: 'rabbit-a', topic: 'rabbit' },
    { id: 'robot-a', topic: 'robot' },
  ];
  assert.equal(pickCute(pool, ['apple-a'], 'rabbit-a', () => 0).id, 'robot-a');
  assert.equal(
    pickCute(pool, ['apple-a', 'apple-b', 'rabbit-a', 'robot-a'], 'rabbit-a', () => 0).id,
    'robot-a',
  );
  assert.equal(pickCute([], []), null);
  assert.equal(pickCute([pool[0]], [], 'apple-a'), null);
  assert.deepEqual(
    validCuteIndex([{ id: 'javascript:alert(1)', topic: 'apple' }, pool[0], pool[0]]),
    [pool[0]],
  );
  assert.deepEqual(validCuteIndex(new Array(513).fill(pool[0])), []);
});
test('topic balancing treats cheerful subjects equally instead of privileging animals', () => {
  const pool = [
    { id: 'fox-wave', topic: 'fox' },
    { id: 'apple-smile', topic: 'apple' },
  ];
  let animals = 0,
    fruit = 0;
  for (let i = 0; i < 100; i++) {
    let call = 0;
    const result = pickCute(pool, [], '', () => (call++ === 0 ? (i + 0.5) / 100 : 0));
    if (result.topic === 'fox') animals++;
    else fruit++;
  }
  assert.equal(animals, 50);
  assert.equal(fruit, 50);
});

test('unknown future subjects qualify from visible expressive evidence, never from a slug or actual monochrome pixels', () => {
  for (const topic of ['quokka', 'donut', 'robot', 'tesla', 'iphone', 'future-cloud-toy'])
    assert(
      cuteConfidence({
        ...sample,
        topic,
        discovery: undefined,
        title: 'A smiling character',
        alt: 'A cheerful character with bright eyes',
      }) > 0,
    );
  assert.equal(
    cuteConfidence({
      ...sample,
      id: 'smiling-donut',
      discovery: undefined,
      title: 'Glazed doughnut',
      alt: 'A glazed doughnut with sprinkles',
    }),
    0,
  );
  assert.equal(cuteConfidence({ ...sample, monochrome: true }), 0);
  assert.equal(
    cuteConfidence({ ...sample, title: 'Not smiling', alt: 'A character without a smile' }),
    0,
  );
});

test('new additions enter a bounded recent lane and large categories cannot crowd every other subject out', () => {
  function* stream() {
    for (let i = 0; i < 10000; i++) yield { ...sample, id: `old-fruit-${i}`, topic: 'apple' };
    for (let i = 0; i < 20; i++) yield { ...sample, id: `new-donut-${i}`, topic: 'donut' };
    for (let i = 0; i < 20; i++) yield { ...sample, id: `new-quokka-${i}`, topic: 'quokka' };
  }
  const index = buildCuteIndex(stream(), 64, 'fresh-lane');
  assert(index.length <= 64);
  assert(index.some((item) => item.fresh && item.topic === 'donut'));
  assert(index.some((item) => item.fresh && item.topic === 'quokka'));
  assert(index.filter((item) => item.topic === 'apple').length <= 5);
  assert.equal(new Set(index.map((item) => item.id)).size, index.length);
  assert.deepEqual(validCuteIndex(index), index);
  assert(pickCute(index, [], '', () => Number.NaN));
});

test('real new donut and fish characters are not blocked by obsolete importer defaults', async () => {
  const { readReviewedImportCatalog } = await import('../scripts/reviewed-imports.mjs');
  const actual = readReviewedImportCatalog(process.cwd());
  const donut = actual.find((item) => item.id === 'donut-astronaut-donut-clipart');
  assert.equal(donut.discovery.cute, false);
  assert(cuteConfidence(donut) > 0);
  assert(
    actual.some(
      (item) => item.sourceCollection === 'owner-fish-15-2026-10-30' && cuteConfidence(item) > 0,
    ),
  );
  const { withDiscoveryReview } = await loadTypescript('src/lib/discovery-reviews.ts');
  const gta = actual.find((item) => item.sourceCollection === 'owner-gta-six-2026-10-26');
  const reviewed = withDiscoveryReview(gta);
  assert.equal(reviewed.discovery.reviewedSourceSha256, gta.files.webp.sha256);
  assert.equal(cuteConfidence(reviewed), 0);
  const replaced = {
    ...gta,
    files: { ...gta.files, webp: { ...gta.files.webp, sha256: 'b'.repeat(64) } },
  };
  assert.equal(withDiscoveryReview(replaced), replaced);
});

test('a smile alone does not admit ordinary adult portraits, clinical closeups or plain natural objects', () => {
  for (const [title, alt] of [
    ['Photographer with a camera', 'A smiling photographer holds a camera at his side.'],
    ['Smiling Mouth With Braces', 'Coral lips reveal white teeth and colored brackets.'],
    ['Fish resting in rocks', 'A smiling fish rests in a rocky nook beside a golden light.'],
  ])
    assert.equal(cuteConfidence({ ...sample, title, alt, discovery: undefined }), 0, title);
  assert(
    cuteConfidence({
      ...sample,
      topic: 'future-device',
      title: 'Friendly device',
      alt: 'A smiling device character with bright eyes and tiny arms.',
    }) > 0,
  );
});
