// A Lighthouse run can have no runtimeError while individual paint audits fail.
// Treat those runs as incomplete instead of reporting a misleading score.
export function assertUsableLighthouse(result) {
  if (result.runtimeError) throw new Error(JSON.stringify(result.runtimeError));
  for (const id of ['first-contentful-paint', 'largest-contentful-paint']) {
    const audit = result.audits?.[id];
    if (audit?.scoreDisplayMode === 'error' || !Number.isFinite(audit?.numericValue))
      throw new Error(`${id}: ${audit?.errorMessage || 'metric unavailable'}`);
  }
  if (!Number.isFinite(result.categories?.performance?.score))
    throw new Error('Performance score unavailable');
}

export function hasUsableSummary(row) {
  return (
    !row.error &&
    Number.isFinite(row.scores?.performance) &&
    Number.isFinite(row.metrics?.['first-contentful-paint']) &&
    Number.isFinite(row.metrics?.['largest-contentful-paint'])
  );
}
