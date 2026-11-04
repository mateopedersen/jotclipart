// Literal spelling protection for four explicitly reviewed topic policies.
// No name splitting, copy rewriting, identity inference or visual approval.
const policies = Object.freeze({
  'jpmorgan-chase': { label: 'JPMorgan Chase', pattern: /\bjpmorgan\s*chase\b/gi },
  'usb-flash-drive': { label: 'USB', pattern: /\busb\b/gi },
  'vr-headset': { label: 'VR', pattern: /\bvr\b/gi },
  '100th-day-of-school': { label: '100th', pattern: /\b100th\b/gi },
});
const publicFields = ['title', 'alt', 'description', 'keyword', 'summary', 'metaDescription', 'paragraphs', 'intro'];

export function assertKnownTopicDisplaySpelling(topic, fields, context = 'changed public copy') {
  const policy = Object.hasOwn(policies, topic) ? policies[topic] : null;
  if (!policy || !fields) return;
  for (const key of publicFields) {
    const values = Array.isArray(fields[key]) ? fields[key] : [fields[key]];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      // A literal URL is a protected address, even if embedded in prose.
      // Removing it from this temporary check never changes the supplied copy.
      const text = value.replace(/\bhttps?:\/\/[^\s<>"']+/gi, '');
      const pattern = new RegExp(policy.pattern.source, policy.pattern.flags);
      for (const match of text.matchAll(pattern)) {
        if (match[0] !== policy.label)
          throw Error(`${context}: ${topic} ${key} uses ${JSON.stringify(match[0])}; reviewed display spelling is ${JSON.stringify(policy.label)}`);
      }
    }
  }
}
