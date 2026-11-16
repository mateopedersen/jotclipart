export type ShareOptions = {
  trigger?: HTMLElement;
  kind: 'catalog' | 'creation';
  title: string;
  url?: string;
  imageUrl?: string;
  blob?: Blob;
  sourceUrl?: string;
};
export const SITE = 'https://jotclipart.com';
export type OwnedShare = { id: string; title: string; url: string; deleteToken: string };

// Read compatible removal keys without changing their stored bytes. Only the
// exact historical host and matching share identity may acquire a new UI URL.
export function normalizeOwnedShare(value: unknown): OwnedShare | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Partial<OwnedShare>;
  if (
    typeof item.id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(item.id) ||
    typeof item.deleteToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(item.deleteToken) ||
    typeof item.title !== 'string' ||
    !item.title.trim() ||
    item.title.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(item.title) ||
    ![`${SITE}/share/${item.id}/`, `https://ultraclipart.com/share/${item.id}/`].includes(
      item.url ?? '',
    )
  )
    return;
  return { ...item, url: `${SITE}/share/${item.id}/` } as OwnedShare;
}

export function mergeOwnedShares(existing: OwnedShare[], incoming: unknown[]): OwnedShare[] {
  if (!incoming.length || incoming.length > 1000)
    throw new Error(
      'This is not a valid JotClipart removal-key backup. Your saved keys are unchanged.',
    );
  const merged = new Map(existing.map((record) => [record.id, record]));
  for (const value of incoming) {
    const record = normalizeOwnedShare(value);
    if (!record)
      throw new Error(
        'This is not a valid JotClipart removal-key backup. Your saved keys are unchanged.',
      );
    const previous = merged.get(record.id);
    if (previous && previous.deleteToken !== record.deleteToken)
      throw new Error(
        'A different removal key already exists for this link. Keep both backup files; your saved keys are unchanged.',
      );
    if (!previous) merged.set(record.id, record);
  }
  if (merged.size > 1000) throw new Error('This device already has too many saved removal keys.');
  return [...merged.values()];
}

export const captionAndLink = (text: string, url: string) => `${text}\n${url}`;

export function publicMediaUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value, SITE);
    if (![SITE, 'https://assets.jotclipart.com'].includes(url.origin)) return;
    if (!/\.(?:webp|png|jpe?g)$/i.test(url.pathname)) return;
    return url.origin + url.pathname;
  } catch {
    return;
  }
}
export function artworkUrl(value: string): string {
  const url = new URL(value, SITE);
  if (url.origin !== SITE || !/^\/(?:art\/[a-z0-9-]+|share\/[a-zA-Z0-9_-]+)\/$/.test(url.pathname))
    throw new Error('Invalid artwork link');
  return SITE + url.pathname;
}
export function caption(kind: ShareOptions['kind'], title: string): string {
  const name = title.trim().replace(/\s+/g, ' ').slice(0, 120) || 'My clipart';
  return kind === 'catalog'
    ? `I found “${name}” on JotClipart. A little inspiration for your next creative project!`
    : `I created “${name}” with JotClipart. Make something of your own with Clipart Studio or AI Clipart Builder!`;
}
export function socialLinks(url: string, text: string, imageUrl?: string) {
  const link = artworkUrl(url);
  const media = publicMediaUrl(imageUrl);
  const truncate = (value: string, count: number) =>
    Array.from(value).slice(0, Math.max(0, count)).join('');
  const make = (base: string, params: Record<string, string>) =>
    `${base}?${new URLSearchParams(params)}`;
  return [
    {
      id: 'pinterest-p',
      name: 'Pinterest',
      color: '#bd081c',
      href: make('https://www.pinterest.com/pin/create/button/', {
        url: link,
        ...(media ? { media } : {}),
        description: text.slice(0, 500),
      }),
    },
    {
      id: 'facebook-f',
      name: 'Facebook',
      color: '#1877f2',
      href: make('https://www.facebook.com/sharer/sharer.php', { u: link }),
    },
    {
      id: 'whatsapp',
      name: 'WhatsApp',
      color: '#087b45',
      href: make('https://wa.me/', { text: `${text}\n${link}` }),
    },
    {
      id: 'x-twitter',
      name: 'X',
      color: '#111827',
      href: make('https://x.com/intent/post', { text: truncate(text, 120), url: link }),
    },
    {
      id: 'telegram',
      name: 'Telegram',
      color: '#1684b5',
      href: make('https://t.me/share/url', { url: link, text }),
    },
    {
      id: 'linkedin-in',
      name: 'LinkedIn',
      color: '#0a66c2',
      href: make('https://www.linkedin.com/sharing/share-offsite/', { url: link }),
    },
    {
      id: 'reddit-alien',
      name: 'Reddit',
      color: '#d63b00',
      href: make('https://www.reddit.com/submit', { url: link, title: text.slice(0, 250) }),
    },
    {
      id: 'bluesky',
      name: 'Bluesky',
      color: '#0875e9',
      href: make('https://bsky.app/intent/compose', {
        text: `${truncate(text, 299 - Array.from(link).length)}\n${link}`,
      }),
    },
    {
      id: 'threads',
      name: 'Threads',
      color: '#111827',
      href: make('https://www.threads.net/intent/post', {
        text: `${truncate(text, 499 - Array.from(link).length)}\n${link}`,
      }),
    },
  ];
}
