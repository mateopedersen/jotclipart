import { artworkCatalogTitle, freeCatalogTitle } from './brand.mjs';
/** Presentation only: keep reviewed words, IDs, artwork and personal text intact. */
const spellings: Record<string, string> = {
  ultraclipart: 'UltraClipart',
  jotclipart: 'JotClipart',
  iphone: 'iPhone',
  ipad: 'iPad',
  ipod: 'iPod',
  imac: 'iMac',
  macbook: 'MacBook',
  macos: 'macOS',
  ios: 'iOS',
  chatgpt: 'ChatGPT',
  openai: 'OpenAI',
  webp: 'WebP',
  pdf: 'PDF',
  png: 'PNG',
  jpg: 'JPG',
  jpeg: 'JPEG',
  svg: 'SVG',
  docx: 'DOCX',
  ai: 'AI',
  usa: 'USA',
  '3d': '3D',
};
export function displayTitle(value: string): string {
  return value.replace(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu, (word) => {
    const known = spellings[word.toLowerCase()];
    if (known) return known;
    if (/[a-z][A-Z]/.test(word)) return word;
    return word[0].toLocaleUpperCase('en-US') + word.slice(1);
  });
}

export function displayCatalogTitle(value: string): string {
  return freeCatalogTitle(displayTitle(value));
}

export function displayArtworkTitle(value: string): string {
  return artworkCatalogTitle(displayTitle(value));
}

export function topicPageTitle(subject: string): string {
  const name = displayCatalogTitle(subject);
  return /\bClipart$/i.test(name) ? name : `${name} Clipart`;
}
