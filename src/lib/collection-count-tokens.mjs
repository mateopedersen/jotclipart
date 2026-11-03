/** Preserve plain text; let the shared counter own singular/plural display too. */
/** @returns {(string | { unit?: 'illustration' })[]} */
export function collectionCountParts(text) {
  return text
    .split(/(\{\{artworkCount\}\}(?: illustrations?\b)?)/g)
    .map((part) =>
      part.startsWith('{{artworkCount}}')
        ? { unit: / illustrations?$/.test(part) ? 'illustration' : undefined }
        : part,
    );
}
