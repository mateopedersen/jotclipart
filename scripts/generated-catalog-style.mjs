// Production briefs may describe an illustration technique more precisely than
// the public search facets. Normalize at import; never add an unsearchable facet.
const styles = new Map([
  ['Color', 'Color'], ['Cartoon', 'Color'], ['Illustration', 'Color'],
  ['Outline', 'Outline'], ['Black & White', 'Black & White'],
  ['Watercolor', 'Watercolor'], ['Silhouette', 'Silhouette'],
]);
export function generatedCatalogStyle(value) {
  const style = styles.get(value);
  if (!style) throw new Error(`Unsupported generated artwork style: ${value}`);
  return style;
}
