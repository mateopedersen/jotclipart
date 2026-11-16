import { publicBrandURL } from '../../src/lib/brand.mjs';

// These are public address slots, never editorial text, IDs, proof or user text.
const addressFields = new Set([
  'url',
  'src',
  'href',
  'canonical',
  'webp',
  'pdf',
  'thumb',
  'preview',
  'originalThumb',
  'suggestionThumb',
  'contentUrl',
  'thumbnailUrl',
  'embedUrl',
]);

/** Called only after signed catalog/hash validation. Never changes stored JSON or source hashes. */
export function presentationState(input, seen = new WeakMap(), field = '', parent = '') {
  if (typeof input === 'string')
    return addressFields.has(field) || (field === 'source' && parent === 'preview')
      ? publicBrandURL(input)
      : input;
  if (typeof input === 'function')
    return function (...args) {
      const result = input.apply(this, args);
      return result && typeof result.then === 'function'
        ? result.then((value) => presentationState(value, new WeakMap(), field))
        : presentationState(result, new WeakMap(), field);
    };
  if (!input || typeof input !== 'object') return input;
  if (seen.has(input)) return seen.get(input);
  if (input instanceof Map) {
    const out = new Map();
    seen.set(input, out);
    for (const [key, value] of input) out.set(key, presentationState(value, seen, field));
    return out;
  }
  if (input instanceof Set) return new Set(input);
  if (Object.getPrototypeOf(input) !== Object.prototype && !Array.isArray(input))
    throw Error('Unreviewed catalog presentation type');
  const out = Array.isArray(input) ? [] : {};
  seen.set(input, out);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) continue;
    if (!descriptor.enumerable) {
      Object.defineProperty(out, key, descriptor);
      continue;
    }
    const nextField = Array.isArray(input) ? field : key;
    if ('value' in descriptor) {
      Object.defineProperty(out, key, {
        ...descriptor,
        value: presentationState(descriptor.value, seen, nextField, field),
      });
    } else {
      Object.defineProperty(out, key, {
        ...descriptor,
        get: descriptor.get
          ? () => presentationState(descriptor.get.call(input), seen, nextField, field)
          : undefined,
      });
    }
  }
  return out;
}

export function presentationSitemap(xml) {
  return xml.replace(
    /(<(?:loc|image:loc)>)([^<]+)(<\/(?:loc|image:loc)>)/g,
    (_, start, url, end) => start + publicBrandURL(url) + end,
  );
}

/** Project only authenticated public response DTOs, after all source checks. */
export async function presentationResponse(response) {
  const type = response.headers.get('content-type') || '';
  if (!response.body || !/^(?:application\/json|application\/xml)/i.test(type)) return response;
  const body = type.startsWith('application/json')
    ? JSON.stringify(presentationState(await response.json()))
    : presentationSitemap(await response.text());
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
