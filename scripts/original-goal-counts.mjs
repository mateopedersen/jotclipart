import assert from 'node:assert/strict';

/** Stable artwork IDs allocate an approved topic expansion without inflating the original goal. */
export function originalGoalArtworkIds(catalog, topics, registry = { schema: 1, topics: {} }) {
  assert.equal(registry.schema, 1);
  const targets = new Map(topics.map((t) => [t.slug, t.target_original_artworks]));
  const seen = new Set(),
    eligible = new Map(),
    result = new Set();
  for (const item of catalog) {
    assert(!seen.has(item.id), 'Duplicate catalog artwork ID');
    seen.add(item.id);
    if (!targets.has(item.topic) || item.productionMethod === 'owner-supplied') continue;
    const group = eligible.get(item.topic) ?? [];
    group.push(item);
    eligible.set(item.topic, group);
  }
  for (const [topic, group] of eligible) {
    const target = targets.get(topic),
      allocation = registry.topics[topic];
    if (!allocation) {
      assert(group.length <= target, 'Unallocated original topic expansion: ' + topic);
      for (const a of group) result.add(a.id);
      continue;
    }
    assert.equal(allocation.ownerApprovedTarget, 100);
    assert.equal(allocation.original110Allocation, target);
    const primary = new Set(allocation.originalGoalArtworkIds),
      extra = new Set(allocation.supplementalArtworkIds);
    assert.equal(primary.size, target);
    assert.equal(extra.size, 100 - target);
    assert.equal(primary.size, allocation.originalGoalArtworkIds.length);
    assert.equal(extra.size, allocation.supplementalArtworkIds.length);
    assert(
      ![...primary].some((id) => extra.has(id)),
      'An artwork cannot have two goal allocations',
    );
    for (const a of group) {
      assert(primary.has(a.id) || extra.has(a.id), 'Unplanned expanded artwork: ' + a.id);
      if (primary.has(a.id)) result.add(a.id);
    }
    assert(
      [...primary, ...extra].every(
        (id) => !catalog.some((a) => a.id === id && a.productionMethod === 'owner-supplied'),
      ),
      'Owner-supplied art cannot receive an original allocation',
    );
  }
  return result;
}
