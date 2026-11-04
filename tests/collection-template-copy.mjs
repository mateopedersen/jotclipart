import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionSourceSignature,
  collectionParagraphSignature,
  collectionParagraphReviewSignature,
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
        paragraphs: [
          `${introductions[item.topic]} Explore the available drawings and compare their subjects before choosing a composition for your own project.`,
          `The ${item.topic} collection contains {{artworkCount}} illustrations and can support a personal journal, a learning activity or a creative composition. Match an individual illustration to the meaning of your own page and leave room for the words you want to add.`,
        ],
        paragraphSourceSha256: collectionParagraphSignature([item], introductions[item.topic]),
        paragraphsCheckedAt: '2026-11-03T00:00:00Z',
        paragraphEvidence: [{ id: item.id, imageSha256: item.files.webp.sha256 }],
      },
    ]),
  );
  for (const record of Object.values(topics))
    record.paragraphReviewSha256 = collectionParagraphReviewSignature(record);
  return [catalog, { schema: 1, topics }];
}

test('both collection gates reject the Dinner paragraph with a substituted topic name', () => {
  const template = (subject) =>
    `Family suppers, ${subject}s with friends and Christmas and Thanksgiving tables sit alongside individual meals and Santa enjoying a roast ${subject}. Choose colorful cartoon scenes or black and white drawings, with different characters, foods and table settings.`;
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
