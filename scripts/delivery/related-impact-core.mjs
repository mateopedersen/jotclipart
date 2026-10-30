const semantic = ({ version: _version, ...snapshot }) => JSON.stringify(snapshot);

/** Metadata dependency analysis over the actual existing related index. No
 * images, generated prompts or inferred prose enter this calculation. */
export function analyzeRelatedImpact(
  current,
  previous,
  previousIds,
  companionSubjects,
  { exhaustive = false } = {},
) {
  const oldIds = new Set(previousIds),
    subjects = new Set(),
    topics = new Set();
  for (const [id, profile] of current.profiles) {
    if (oldIds.has(id)) continue;
    if (profile.subject) subjects.add(profile.subject.id);
    if (profile.item.published && profile.item.topic) topics.add(profile.item.topic);
  }
  const affected = [],
    missing = [];
  let compared = 0,
    existing = 0;
  for (const id of oldIds) {
    const source = current.profiles.get(id);
    if (!source || !source.item.published || !source.item.indexable) continue;
    existing++;
    const candidate =
      topics.has(source.item.topic) ||
      (source.subject &&
        (subjects.has(source.subject.id) ||
          topics.has(source.subject.topic) ||
          companionSubjects(source.subject).some((partner) => subjects.has(partner.id))));
    if (!candidate && !exhaustive) continue;
    const changed = semantic(previous.snapshot(id)) !== semantic(current.snapshot(id));
    if (candidate) {
      compared++;
      if (changed) affected.push(id);
    } else if (changed) missing.push(id);
  }
  if (missing.length)
    throw Error(`Incomplete related dependency coverage: ${missing.slice(0, 8).join(', ')}`);
  return {
    version: current.version,
    previousVersion: previous.version,
    affectedArtworkIds: affected.sort(),
    existingSources: existing,
    compared,
    exhaustiveVerified: exhaustive,
  };
}
