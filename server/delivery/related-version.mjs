const MAX_SNAPSHOT_CHARS = 512_000;
export function currentRelatedSnapshot(text, sourceId, version) {
  if (text.length > MAX_SNAPSHOT_CHARS)
    throw Error('Related snapshot exceeds representation bound');
  const snapshot = JSON.parse(text);
  if (
    snapshot?.sourceId !== sourceId ||
    typeof snapshot.version !== 'string' ||
    !['alternatives', 'companions', 'collection'].every((key) => Array.isArray(snapshot[key])) ||
    snapshot.alternatives.length + snapshot.companions.length + snapshot.collection.length > 64
  )
    throw Error('Related source differs from the verified artwork');
  // Cards/order were dependency-checked before inheritance. Only the global
  // release marker changes, so existing clients keep their valid controls.
  return JSON.stringify({ ...snapshot, version }).replaceAll('<', '\\u003c');
}

export function refreshRelatedRepresentation(response, sourceId, version) {
  if (typeof HTMLRewriter !== 'function')
    throw Error('Related representation renderer unavailable');
  let count = 0,
    text = '';
  return new HTMLRewriter()
    .on('script[data-related-snapshot]', {
      element() {
        if (++count > 1) throw Error('Duplicate related snapshot');
      },
      text(chunk) {
        text += chunk.text;
        if (text.length > MAX_SNAPSHOT_CHARS)
          throw Error('Related snapshot exceeds representation bound');
        if (chunk.lastInTextNode) {
          chunk.replace(currentRelatedSnapshot(text, sourceId, version), { html: true });
          text = '';
        } else chunk.remove();
      },
    })
    .transform(response);
}

// Local preview adapter for the same representation contract before HTTP gzip.
// Native workerd tests compare this with the actual streaming HTMLRewriter.
export function refreshRelatedPreview(html, sourceId, version) {
  let count = 0;
  return html.replace(
    /(<script\b[^>]*\bdata-related-snapshot(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?(?:\s[^>]*)?>)([\s\S]*?)(<\/script\s*>)/gi,
    (_, open, text, close) => {
      if (++count > 1) throw Error('Duplicate related snapshot');
      return open + currentRelatedSnapshot(text, sourceId, version) + close;
    },
  );
}
