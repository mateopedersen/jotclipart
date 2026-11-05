const count = '{{artworkCount}}';
const processNotes = /\b(?:the copy (?:highlights|describes|mentions)|remain(?:s)? at family level|(?:the )?stylized (?:image|artwork) cannot distinguish|(?:metadata|editorial) (?:review|approval))\b/i;
const technicalFiller = /\b(?:webp|cmyk|icc|gracol|dpi|ppi)\b|\b(?:download|choose)\s+(?:the\s+)?(?:matching\s+)?pdf\b/i;

export function assertCollectionVisitorCopy(topic, record) {
  const { intro, paragraphs } = record ?? {};
  if (!Array.isArray(paragraphs) || paragraphs.length !== 2 || paragraphs.some(text => typeof text !== 'string') ||
      paragraphs[0].includes(count) || paragraphs[1].split(count).length !== 2) {
    throw Error(`Collection ${topic}: use two paragraphs and one live count in the second`);
  }
  if ([intro, ...paragraphs].some(text => typeof text !== 'string' ||
      processNotes.test(text) || technicalFiller.test(text))) {
    throw Error(`Collection ${topic}: replace editorial notes or download instructions with useful gallery copy`);
  }
}
