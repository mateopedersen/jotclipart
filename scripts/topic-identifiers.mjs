// Stable topic slugs are public identities. Allocate missing internal numeric
// ordinals without allowing undefined/null/NaN to poison the next allocation.
export function assignMissingTopicIdentifiers(primary, extra) {
  if (!Array.isArray(primary) || !Array.isArray(extra)) throw Error('Topic inventories required');
  const used = new Set(),
    slugs = new Set();
  let next = 0;
  for (const t of [...primary, ...extra]) {
    if (typeof t.slug !== 'string' || slugs.has(t.slug)) throw Error('Duplicate topic slug');
    slugs.add(t.slug);
    if (Number.isSafeInteger(t.id) && t.id > 0) {
      if (used.has(t.id)) throw Error('Duplicate accepted numeric topic identity');
      used.add(t.id);
      next = Math.max(next, t.id);
    }
  }
  const changes = [],
    result = extra.map((t) => {
      if (Number.isSafeInteger(t.id) && t.id > 0) return structuredClone(t);
      if (next === Number.MAX_SAFE_INTEGER) throw Error('Topic identifier overflow');
      const id = ++next;
      changes.push({ slug: t.slug, before: t.id ?? null, after: id });
      return { ...structuredClone(t), id };
    });
  for (const t of primary)
    if (!Number.isSafeInteger(t.id) || t.id < 1)
      throw Error('Accepted primary topic identity missing');
  return { extra: result, nextId: next + 1, changes };
}
