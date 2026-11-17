import registry from '../../data/jotclipart-editorial-links.json' with { type: 'json' };

/** Attach reviewed links only while the exact surrounding source phrase is present. */
export function editorialParagraphParts(path, paragraphs) {
  const approved = registry.pages[path] ?? [];
  const used = new Set();
  return paragraphs.map((paragraph) => {
    const matches = approved.flatMap((rule) => {
      const contextStart = paragraph.indexOf(rule.in);
      if (
        contextStart < 0 ||
        paragraph.indexOf(rule.in, contextStart + 1) >= 0 ||
        used.has(rule.href)
      )
        return [];
      const start = contextStart + rule.in.indexOf(rule.text);
      return [{ start, end: start + rule.text.length, href: rule.href }];
    });
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let cursor = 0;
    const parts = [];
    for (const match of matches) {
      if (match.start < cursor || used.has(match.href)) continue;
      if (match.start > cursor) parts.push({ text: paragraph.slice(cursor, match.start) });
      parts.push({ text: paragraph.slice(match.start, match.end), href: match.href });
      used.add(match.href);
      cursor = match.end;
    }
    if (cursor < paragraph.length) parts.push({ text: paragraph.slice(cursor) });
    return parts;
  });
}
