import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionSourceSignature,
  collectionIntroductionTemplate,
  verifyCollectionEditorial,
  requiredCollectionIntroductions,
} from '../scripts/collection-editorial.mjs';

function fixture(introductions) {
  const catalog = Object.keys(introductions).map((topic) => ({
    id: `fixture-${topic}`,
    topic,
    title: `Fixture ${topic}`,
    alt: `Fixture ${topic}`,
    published: true,
    indexable: true,
    files: { webp: { sha256: 'a'.repeat(64) } },
  }));
  const topics = Object.fromEntries(
    catalog.map((item) => [
      item.topic,
      {
        status: 'checked-against-catalog',
        sourceSha256: collectionSourceSignature([item]),
        checkedAt: '2026-10-29T00:00:00Z',
        intro: introductions[item.topic],
        evidence: [{ id: item.id, imageSha256: item.files.webp.sha256 }],
      },
    ]),
  );
  return [catalog, { schema: 1, topics }];
}

test('both collection gates reject the Dinner paragraph with a substituted topic name', () => {
  const template = (subject) =>
    `Family suppers, ${subject}s with friends and Christmas and Thanksgiving tables sit alongside individual meals and Santa enjoying a roast ${subject}. Choose colorful cartoon scenes or black-and-white drawings, with different characters, foods and table settings.`;
  const args = fixture({ dinner: template('dinner'), maccabees: template('maccabees') });
  for (const gate of [verifyCollectionEditorial, requiredCollectionIntroductions])
    assert.throws(() => gate(...args), /Topic-name-substituted.*dinner and maccabees/);
});

test('real subject-specific introductions remain distinct', () => {
  const args = fixture({
    dinner:
      'Families and friends gather around holiday tables, beside individual meals and a roast for Santa.',
    maccabees:
      'Scouts, scroll readers and oil lamps appear alongside children sharing a storybook and paper puppets.',
  });
  assert.equal(verifyCollectionEditorial(...args).uniqueIntroductions, 2);
  assert.equal(requiredCollectionIntroductions(...args).size, 2);
});

test('multiword subjects, plural substitution, case and punctuation do not hide a reused template', () => {
  assert.equal(
    collectionIntroductionTemplate(
      'pumpkin-pie',
      'Pumpkin pies sit on plates; pumpkin pie slices are shown.',
    ),
    collectionIntroductionTemplate(
      'apple-pie',
      'APPLE PIES sit on plates, apple pie slices are shown!',
    ),
  );
});
