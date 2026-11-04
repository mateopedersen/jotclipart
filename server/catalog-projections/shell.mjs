import { readPages } from './pages.mjs';
export const shellFieldLimit = (name) =>
  [
    'staticIds',
    'colors',
    'styles',
    'clusters',
    'clustersData',
    'clusterPicks',
    'studioCompositionPreviews',
  ].includes(name)
    ? 128
    : name === 'directoryIds'
      ? 1000
      : 10000;
export async function readShellField(context, root, name) {
  if (
    root.schema !== 1 ||
    root.type !== 'discovery-shell-directory' ||
    !root.fields ||
    (root.paging !== undefined && root.paging !== 'stable-v2')
  )
    throw Error('Invalid discovery shell protocol');
  const store = { get: (d) => context.read('collections', d, { maxBytes: 65536 }) };
  return (
    await readPages(store, root.fields[name], 'discovery-shell-rows', {
      stable: root.paging === 'stable-v2',
      field: name,
      limit: shellFieldLimit(name),
    })
  ).entries;
}
