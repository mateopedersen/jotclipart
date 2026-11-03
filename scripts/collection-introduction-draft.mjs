import { createHash } from 'node:crypto';
import primary from '../data/primary-topic-categories.json' with { type: 'json' };
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readReviewedImportCatalog } from './reviewed-imports.mjs';
import { readCollectionRegistries, collectionParagraphSignature } from './collection-editorial.mjs';

const specificUses = [
  [
    /^(?:background|border|frame|frames|arrow|zigzag|line|shapes|icon|aesthetic|yellow|sets|bundle)$/,
    'Arrange the artwork around your own text in a personal page layout, an invitation or a classroom display, choosing shapes that frame rather than crowd the main message.',
  ],
  [
    /^(?:font|word|pencil|draw|cricut|coreldraw)$/,
    'Explore the lettering or making theme in a personal design notebook, an alphabet activity or a creative practice page, choosing details that complement your own words.',
  ],
  [
    /^(?:music|guitar|violin|xylophone|marching-band|microphone)$/,
    'Illustrate a personal music notebook, a rehearsal journal or a listening activity, matching the pictured instrument or performance theme to the music you are exploring.',
  ],
  [
    /^(?:brain|tooth|uterus|ear|eyes|mouth|nose|hand)$/,
    'Choose an illustration for a body vocabulary activity, a personal study notebook or an illustrated discussion, matching the visible subject to the concept you want to explain.',
  ],
  [
    /^(?:sunflower|maple|leaves|grass|vines|mushroom|rose|acorn|pinecone|holly|poinsettia)$/,
    'Build a plant observation page, a personal garden journal or a nature-themed greeting, comparing the visible plant details and arrangements before choosing your focal image.',
  ],
  [
    /^copyright$/,
    'Illustrate a classroom discussion about creative ownership, a personal writing notebook or a project about how images and words are credited.',
  ],
  [
    /^(?:ganesh|jesus|mundan|upanayanam|angel|nativity|caroling)$/,
    'Choose an illustration for a personal devotional page, a family celebration keepsake or a cultural learning activity, using your own text to explain its meaning respectfully.',
  ],
  [
    /^(?:chatgpt|openai|claude|anthropic|ai|generator)$/,
    'Use the illustrations in a personal technology journal, a classroom discussion about digital tools or a creative concept board, keeping the pictured scenes separate from product capability claims.',
  ],
  [
    /^(?:call|email|facebook|instagram|whatsapp|website|app|wifi-router)$/,
    'Illustrate a communication activity, a personal digital project or a technology vocabulary page, choosing a symbol or scene that makes the intended action clear.',
  ],
  [
    /^(?:bitcoin|bitcoin-cash|ethereum|bnb|cardano|chainlink|dogecoin|hyperliquid|monero|near-protocol|solana|stellar|tether|tron|unus-sed-leo|usd-coin|usds|whitebit-coin|xrp|zcash)$/,
    'Use the artwork in a digital currency vocabulary activity, a personal research notebook or an illustrated comparison of symbols, adding your own explanation of the topic.',
  ],
  [
    /^(?:\d+|1st|4th|zero)$/,
    'Choose a numeral treatment for a counting activity, a personal milestone page or a number-themed display, checking the digits and arrangement against the meaning of your own project.',
  ],
];

// These are suggested uses, not claims that a particular finished project exists.
// The inventory sentences and named examples come only from accepted catalog copy.
const uses = {
  Halloween:
    'Plan a personal Halloween invitation, a story prompt or a seasonal classroom display, choosing the character and mood that fit your activity.',
  'Thanksgiving & Autumn':
    'Build a seasonal journal page, a harvest activity or a personal gathering invitation around the food, plant or scene that matches your theme.',
  'Civic & Voting':
    'Use the drawings in a civics discussion, a personal commentary project or an illustrated comparison, keeping imagined scenes distinct from real events.',
  Diwali:
    'Bring these illustrations into a personal festival greeting, a celebration journal or a cultural learning activity that explains the chosen image in context.',
  Hanukkah:
    'Choose an illustration for a personal Hanukkah greeting, a family activity or a classroom discussion of the celebration and its traditions.',
  Kwanzaa:
    'Pair the artwork with your own words for a personal Kwanzaa greeting, a family reflection page or a cultural learning display.',
  'Christmas & Winter':
    'Choose a focal image for a personal seasonal card, a winter story page or a family craft, leaving room for your own message.',
  'New Year 2027':
    'Plan a personal New Year greeting, a dated journal cover or a celebration activity, checking that any year shown suits your project.',
  "Valentine's Day":
    'Create a personal greeting, a friendship activity or a keepsake page, selecting an arrangement that leaves space for the words you want to share.',
  Sports:
    'Illustrate a personal practice journal, a sports activity or a team-themed keepsake, choosing the pose or equipment that suits the story you are telling.',
  'Family & celebrations':
    'Make a personal greeting, an event scrapbook page or a family activity, matching the illustration to the occasion and the space for your message.',
  'Animals & nature':
    'Choose an image for an animal study, a nature journal or a personal story page, comparing the poses and surrounding details before you settle on a design.',
  'Food & drink':
    'Illustrate a personal recipe page, a food vocabulary activity or a kitchen journal, selecting a view that makes your chosen ingredient or dish easy to recognize.',
  'Technology & devices':
    'Use the illustrations in a digital literacy activity, a personal technology notebook or a device-themed layout, selecting the pictured equipment that fits your subject.',
  'Nature & elements':
    'Build a nature observation page, an illustrated setting or a classroom activity around the form and atmosphere that suit your subject.',
  'School & learning':
    'Create a classroom activity, a personal study page or a learning journal, choosing the illustration that supports the idea you want to explain.',
  'Business & money':
    'Use the drawings in a financial literacy activity, a personal planning page or an illustrated discussion; the artwork supplies visual context for your own explanation.',
  'Arts & entertainment':
    'Plan a personal creative notebook, a story activity or an entertainment-themed craft, matching the subject and composition to your own idea.',
  'People & activities':
    'Illustrate a story prompt, a personal journal entry or a classroom discussion, choosing the action and arrangement that make your intended meaning clear.',
  'Flags & countries':
    'Choose a clear flag view for a geography activity, compare country symbols in a classroom display or add an illustration to a personal travel journal.',
  'Places & travel':
    'Bring the illustrations into a personal travel journal, a place study or an imagined itinerary, choosing a viewpoint that supports the location you are describing.',
  'Transport & vehicles':
    'Build a personal vehicle notebook, a transport activity or an automotive mood board, comparing the pictured shapes and viewpoints without treating illustrations as technical specifications.',
  'Space & science':
    'Use the artwork in a personal science notebook, a classroom discussion or an imagined exploration story, keeping illustrative concepts distinct from factual diagrams.',
  'Clothing & accessories':
    'Plan a personal style board, a clothing vocabulary activity or a costume idea page, comparing the shapes and decorative details that suit your theme.',
  Shopping:
    'Use these illustrations in a personal shopping journal, a retail vocabulary activity or a classroom discussion about stores and everyday purchases.',
};

export function draftCollectionParagraphs(topic, items, record) {
  if (!record?.intro || !items.length)
    throw Error('A catalog-checked summary and inventory are required');
  const byId = new Map(items.map((item) => [item.id, item]));
  const candidates = (record.evidence ?? []).map((entry) => byId.get(entry.id)).filter(Boolean);
  if (candidates.length < Math.min(2, items.length))
    throw Error('Missing accepted inventory examples: ' + topic.slug);
  // Prefer a complementary example by its existing label; this does not inspect pixels.
  const words = (item) => new Set(item.title.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const first = candidates[0],
    firstWords = words(first);
  const rest = candidates.slice(1).sort((a, b) => {
    const distance = (item) => [...words(item)].filter((word) => !firstWords.has(word)).length;
    return distance(b) - distance(a) || a.id.localeCompare(b.id);
  });
  const selected = [first, ...rest.slice(0, 1)];
  const name = topic.keyword.replace(/\s+clipart\s*$/i, '').trim();
  const intro = record.intro.replace(/\s+/g, ' ').trim();
  const examples = selected.map((item) => `“${item.title}”`).join(' and ');
  const use =
    specificUses.find(([pattern]) => pattern.test(topic.slug))?.[1] ??
    uses[primary[topic.slug] ?? topic.browseCluster ?? topic.cluster];
  if (!use) throw Error('Provide topic-appropriate use guidance: ' + topic.slug);
  return {
    status: 'draft-for-catalog-review',
    paragraphs: [
      `Welcome to our ${name} clipart collection, with {{artworkCount}} illustrations to explore. ${intro}`,
      `The gallery includes ${examples} among its drawings. ${use}`,
    ],
    evidence: selected.map((item) => ({ id: item.id, imageSha256: item.files.webp.sha256 })),
    draftSha256: createHash('sha256')
      .update(JSON.stringify(selected.map((item) => [item.id, item.title, item.files.webp.sha256])))
      .digest('hex'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , flag, slug] = process.argv;
  if (flag !== '--topic' || !/^[a-z0-9-]+$/.test(slug ?? '') || process.argv.length !== 4)
    throw Error('Usage: node scripts/collection-introduction-draft.mjs --topic <registered-slug>');
  const root = resolve(import.meta.dirname, '..');
  const topics = [
    ...JSON.parse(readFileSync(resolve(root, 'data/topics.json'))).topics,
    ...JSON.parse(readFileSync(resolve(root, 'data/extra-topics.json'))),
  ];
  const topic = topics.find((entry) => entry.slug === slug);
  if (!topic) throw Error('Unknown topic: ' + slug);
  const items = readReviewedImportCatalog(root).filter(
    (entry) => entry.topic === slug && entry.published && entry.indexable,
  );
  const record = readCollectionRegistries(root).topics[slug];
  const draft = draftCollectionParagraphs(topic, items, record);
  const directory = resolve(root, 'work/collection-introduction-review');
  mkdirSync(directory, { recursive: true });
  const file = resolve(directory, slug + '.json');
  writeFileSync(
    file,
    JSON.stringify(
      {
        topic: slug,
        ...draft,
        currentCatalogSha256: collectionParagraphSignature(items, record.intro),
        checkedAt: null,
        note: 'Review wording, examples and uses before adding checked paragraphs to the collection registry. This file cannot approve or publish content.',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ draft: file, approved: false, published: false }));
}
