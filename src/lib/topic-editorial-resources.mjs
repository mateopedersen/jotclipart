import registry from '../../data/jotclipart-topic-resources.json' with { type: 'json' };

/** @typedef {{ text: string, href: string }} EditorialLink */
/** @typedef {{ related: readonly EditorialLink[], sources: readonly EditorialLink[] }} TopicResources */

/** @type {Readonly<Record<string, TopicResources>>} */
const topics = registry.topics;
/** @type {TopicResources} */
const noLinks = Object.freeze({ related: [], sources: [] });

/**
 * Return the explicitly reviewed resources for the canonical topic only.
 * @param {string} slug
 * @returns {TopicResources}
 */
export function topicEditorialResources(slug) {
  return Object.hasOwn(topics, slug) ? topics[slug] : noLinks;
}
