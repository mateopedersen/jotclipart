/** The immutable, signed directory owns the count. Resolving the complete
 * featured library belongs to its explicit library request, not each editor
 * document. The selected artwork still follows its complete source checks. */
export async function readStudioFeaturedCount(context, descriptor) {
  const studio = await context.read('collections', descriptor, { maxBytes: 65536 });
  if (!studio || studio.schema !== 1 || studio.type !== 'studio-featured' ||
      !Array.isArray(studio.ids) || studio.ids.length > 500 ||
      studio.ids.some(id => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) ||
      new Set(studio.ids).size !== studio.ids.length) throw Error('Invalid Studio features');
  return studio.ids.length;
}
