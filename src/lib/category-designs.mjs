// Shared catalog category presentation; no catalog or artwork imports.
import categoryPreviewPicks from '../../data/category-preview-picks.json' with { type: 'json' };
import ownerCollectionContexts from '../../scripts/remaining-thirty-one-contexts.json' with { type: 'json' };
export const collectionStyle = {
  'Animals & nature': {
    title: 'Animals & nature',
    description: 'Wild animals, pets, farm animals and insects.',
    color: 'sage',
    subjects: ['fox', 'butterfly', 'baby-elephant'],
  },
  Halloween: {
    title: 'Halloween',
    description: 'Pumpkins, ghosts, costumes and Halloween activities.',
    color: 'peach',
    subjects: ['halloween', 'pumpkin', 'ghost'],
  },
  'Family & celebrations': {
    title: 'Family & celebrations',
    description: 'Babies, parents and family activities.',
    color: 'rose',
    subjects: ['baby', 'dad'],
  },
  'Christmas & Winter': {
    title: 'Christmas & Winter',
    description: 'Snowy scenes, winter clothing and seasonal characters.',
    color: 'ice',
    subjects: ['winter', 'penguin'],
  },
  "Valentine's Day": {
    title: 'Hearts & love',
    description: 'Hearts, flowers, cards and caring gestures.',
    color: 'rose',
    subjects: ['heart'],
  },
  Sports: {
    title: 'Sports & play',
    description: 'Sports equipment, players and team activities.',
    color: 'lavender',
    subjects: ['volleyball', 'basketball'],
  },
  'Thanksgiving & Autumn': {
    title: 'Autumn & gratitude',
    description: 'Autumn leaves, harvest decorations and Thanksgiving scenes.',
    color: 'sand',
    subjects: ['thanksgiving', 'squirrel'],
  },
  'Food & drink': {
    title: 'Food & Drink',
    description: 'Fruit, baked treats and other food illustrations.',
    color: 'peach',
    subjects: ['apple', 'pizza', 'cookie'],
  },
  'Nature & elements': {
    title: 'Nature & elements',
    description: 'Earth, leaves, beaches and natural elements.',
    color: 'sage',
    subjects: ['leaves', 'earth', 'beach'],
  },
  'School & learning': {
    title: 'School & learning',
    description: 'School supplies, classrooms, books and reading scenes.',
    color: 'ice',
    subjects: ['school', 'book', 'question-mark'],
  },
  'People & activities': {
    title: 'People & Activities',
    description: 'People reading, playing, working and taking part in everyday activities.',
    color: 'lavender',
    subjects: ['boy', 'girl', 'hat'],
  },
  'Arts & entertainment': {
    title: 'Arts & entertainment',
    description: 'Music, movies, games and character-inspired illustrations.',
    color: 'rose',
    subjects: ['music', 'movie'],
  },
  'Business & money': {
    title: 'Money & Saving',
    description: 'Coins, banknotes and saving illustrations for classroom activities.',
    color: 'sand',
    subjects: ['money'],
  },
  'Flags & countries': {
    title: 'Flags & countries',
    description: 'National colors, flag designs and country-themed details.',
    color: 'ice',
    subjects: ['american-flag', 'france-flag', 'mexico-flag'],
  },
  'Places & travel': {
    title: 'Places & travel',
    description: 'Landmarks, local food and little memories from a journey.',
    color: 'sand',
    subjects: ['paris', 'new-york', 'spain'],
  },
  'Transport & vehicles': {
    title: 'Transport & vehicles',
    description: 'Railway journeys, aircraft and electric-vehicle ideas.',
    color: 'ice',
    subjects: ['train', 'airplane', 'tesla'],
  },
  'Clothing & accessories': {
    title: 'Clothing & accessories',
    description: 'Everyday footwear, seasonal handwear and outfit details.',
    color: 'peach',
    subjects: ['shoe', 'glove', 'hat'],
  },
  'Space & science': {
    title: 'Space & science',
    description: 'Lunar details, red-planet exploration and imagined space scenes.',
    color: 'lavender',
    subjects: ['moon', 'mars', 'earth'],
  },
  'Technology & devices': {
    title: 'Technology & devices',
    description: 'Phones, household devices and familiar connected objects.',
    color: 'ice',
    subjects: ['iphone', 'samsung', 'smartphone'],
  },
};
export const preferred = {
  ...categoryPreviewPicks,
  ...Object.fromEntries(
    Object.entries(ownerCollectionContexts).map(([topic, context]) => [topic, context.cover]),
  ),
};
