// Source-capsule-bound optional HTML acceleration. Canonical renderers, source
// gates, native checks, byte budgets and independent sealing remain mandatory.
// Omitted routes use the existing authenticated canonical rendering path.
export function contentPresentationOptions(packet) {
  const options = packet.presentationPreparation;
  if (options === undefined) return {};
  if (
    !options ||
    Array.isArray(options) ||
    Object.keys(options).some((k) => !['maxRoutes', 'maxOutputBytes'].includes(k)) ||
    !Number.isInteger(options.maxRoutes) ||
    options.maxRoutes < 10 ||
    options.maxRoutes > 1536 ||
    !Number.isInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 1048576 ||
    options.maxOutputBytes > 128 * 1024 * 1024
  )
    throw Error('Existing bounded presentation preparation limits required');
  return {
    ...options,
    priorityArtworkIDs: packet.changes.filter((c) => c.record).map((c) => c.id),
    priorityTopics: packet.topicChanges.filter((c) => c.record).map((c) => c.slug),
  };
}
