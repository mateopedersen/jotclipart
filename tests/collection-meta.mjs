import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionMetaDescription, validateCollectionMetaDescriptions } from '../src/lib/collection-meta.mjs';

test('uses a complete relevant sentence without changing the visible introduction', () => {
  const intro = 'Find carolers singing at doorsteps and sharing music outdoors. The collection also includes songbooks and independent black-and-white scenes.';
  assert.deepEqual(collectionMetaDescription(intro), {
    text: 'Find carolers singing at doorsteps and sharing music outdoors.',
    needsEditorialReview: false,
  });
  assert.match(intro, /black-and-white scenes/);
});

test('does not split after an abbreviation inside a descriptive sentence', () => {
  const intro = 'Several illustrations show Dr. Example reading a storybook. Additional designs feature props.';
  assert.equal(collectionMetaDescription(intro).text,
    'Several illustrations show Dr. Example reading a storybook.');
});

test('joins a very short first sentence with the next complete sentence', () => {
  assert.equal(collectionMetaDescription('Hello. Explore the lively brass instruments in this collection.').text,
    'Hello. Explore the lively brass instruments in this collection.');
});

test('preserves text and requests editorial attention when no whole sentence fits', () => {
  const intro = 'A very long reviewed description '.repeat(7).trim() + '. Another sentence follows.';
  assert.deepEqual(collectionMetaDescription(intro), { text: intro, needsEditorialReview: true });
  assert.deepEqual(collectionMetaDescription('Short.'), { text: 'Short.', needsEditorialReview: true });
  assert.throws(() => collectionMetaDescription('   '), /reviewed introduction/);
});

test('duplicate search descriptions fail and difficult sentence length is reported without truncation', () => {
  const first = 'Distinct illustrations depict a group of colorful dancers.';
  assert.throws(() => validateCollectionMetaDescriptions(new Map([
    ['dance', first], ['performers', first.toUpperCase()],
  ])), /Repeated collection search description/);
  const long = 'A carefully reviewed illustration '.repeat(6).trim() + '.';
  assert.deepEqual(validateCollectionMetaDescriptions(new Map([
    ['dance', first], ['other', long],
  ])), { topics: 2, needsEditorialReview: ['other'] });
});

test('decimal model versions and qualified concepts stay in complete sentences',()=>{
  const text='GPT-6.1 Sol appears beside a glowing sun. Additional illustrations use other motifs.';
  assert.equal(collectionMetaDescription(text).text,'GPT-6.1 Sol appears beside a glowing sun.');
  assert.equal(collectionMetaDescription('A concept flying taxi has raised doors and fictional wings. This is a speculative illustration.').text,'A concept flying taxi has raised doors and fictional wings.');
});
