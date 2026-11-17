/** Isolated CI previews cannot replace the shared preview or production alias. */
export function deploymentBranch(environment, explicit) {
  if (!['preview', 'production'].includes(environment))
    throw Error('Choose preview or production explicitly');
  if (explicit === undefined) return environment === 'production' ? 'main' : 'migration-preview';
  if (environment !== 'preview') throw Error('A custom branch is allowed only for preview');
  if (typeof explicit !== 'string' || !/^ci-[a-z0-9][a-z0-9-]{0,44}$/.test(explicit))
    throw Error('An isolated preview must use a short ci- branch label');
  return explicit;
}
