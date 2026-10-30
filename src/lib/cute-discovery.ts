/** Publisher metadata recognition, not a claim of pixel-based image recognition. */
export interface DiscoveryArtwork {
  id: string;
  topic: string;
  title: string;
  alt?: string;
  style: string;
  monochrome?: boolean;
  published?: boolean;
  indexable?: boolean;
  tags?: string[];
  discovery?: { cute?: boolean; exclude?: boolean };
}
export interface CutePick {
  id: string;
  topic: string;
  fresh?: boolean;
}
const mono =
  /black[\s&-]*(?:and[\s&-]*)?white|b\s*&\s*w|gr[ae]yscale|monochrome|outline|silhouette|coloring|charcoal|engraving|linocut|line[\s-]*art|dotwork|stipple/i;
export const SURPRISE_INDEX_VERSION = 3;
const unsuitable =
  /\b(halloween|horror|spooky|scary|frighten(?:ed|ing)?|vampire|skeleton|zombie|witch|angry|aggressive|growling|roaring|fierce|fangs|weapon|skull|crying|sad|unhappy|grief|lonely|political|election|military|gun|sword|blood)\b/i;
const animalTopics = new Set(
  'baby-elephant bat bear bee butterfly camel cat chicken cow crab crocodile deer dog dolphin duck eagle elephant flamingo fox frog giraffe goat hedgehog hippo horse kangaroo kiwi koala lamb lion lobster monkey octopus owl panda parrot peacock penguin pig rabbit raccoon rhino shark sheep snake spider squirrel tiger turkey turtle whale wolf zebra'.split(
    ' ',
  ),
);
const familyTopics = new Set(['baby', 'boy', 'girl', 'mom', 'dad']);
const emotion =
  /\b(smiling|smile|grinning|cheerful|happy|joyful|laughing|giggling|playful|waving|dancing|celebrating|delighted)\b/i;
const affection =
  /\b(cuddling|cuddle|hugging|hug|snuggling|snuggle|affectionate|tender|loving|cradling|reading together)\b/i;
const juvenile =
  /\b(baby|newborn|nursery|calf|cub|chick|kitten|puppy|fawn|joey|owlet|eaglet|toddler)\b/i;
const cuteStyle = /\b(kawaii|chibi|cute|adorable)\b/i;
const face = /\b(face|eyes|eyed|character|mascot|arms|legs|hands|feet)\b/i;
const craftedObject =
  /\b(knit|knitted|knitting|crochet|crocheted|amigurumi|embroidery|embroidered|felt|origami|papercut|paper cut)\b/i;

export function cuteConfidence(item: DiscoveryArtwork): number {
  if (!/^[a-z0-9-]+$/.test(item.id) || !/^[a-z0-9-]+$/.test(item.topic)) return 0;
  if (
    item.published === false ||
    item.indexable === false ||
    item.discovery?.exclude ||
    item.discovery?.cute === false
  )
    return 0;
  const tags = (Array.isArray(item.tags) ? item.tags : [])
    .filter((value) => typeof value === 'string')
    .join(' ');
  const text = `${item.title} ${item.alt ?? ''} ${tags}`.toLowerCase().replace(/-/g, ' ');
  if (
    item.monochrome === true ||
    mono.test(`${item.style} ${item.id.replace(/-/g, ' ')} ${text}`) ||
    unsuitable.test(`${item.id.replace(/-/g, ' ')} ${text}`)
  )
    return 0;
  if (
    /\b(not cute|non cute|not smiling|no smile|without a smile)\b/.test(
      `${item.id.replace(/-/g, ' ')} ${text}`,
    )
  )
    return 0;
  // Positive evidence comes from the visible-subject copy, never from a slug.
  const visible = `${item.title} ${item.alt ?? ''}`.toLowerCase();
  const expressive = /\b(smiling|smile|grinning|laughing|giggling|beaming)\b/i;
  if (expressive.test(visible) && !/\b(lettering|typography|word art|text only)\b/i.test(visible))
    return item.discovery?.cute === true ? 100 : 94;
  const animate =
    animalTopics.has(item.topic) ||
    familyTopics.has(item.topic) ||
    /\b(character|mascot|robot|child|mother|father|family|puppy|kitten|cub|chick|baby animal)\b/i.test(
      visible,
    );
  if (craftedObject.test(visible) && !animate && !face.test(visible)) return 0;
  if (affection.test(visible) && (animate || face.test(visible))) return 96;
  if (emotion.test(visible) && (animate || face.test(visible))) return 88;
  if (juvenile.test(visible) && animate) return 84;
  if (cuteStyle.test(visible) && (animate || face.test(visible))) return 80;
  return 0;
}

function hash(value: string) {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619);
  n ^= n >>> 16;
  n = Math.imul(n, 0x85ebca6b);
  n ^= n >>> 13;
  return (n ^ (n >>> 16)) >>> 0;
}
type Ranked = CutePick & { priority: number };
class Reservoir<T extends { priority: number }> {
  rows: T[] = [];
  constructor(readonly capacity: number) {}
  add(row: T): T | undefined {
    const heap = this.rows;
    let removed: T | undefined;
    if (heap.length < this.capacity) heap.push(row);
    else {
      if (row.priority >= heap[0].priority) return row;
      removed = heap[0];
      heap[0] = row;
      let index = 0;
      while (true) {
        const left = index * 2 + 1,
          right = left + 1;
        let worst = index;
        if (left < heap.length && heap[left].priority > heap[worst].priority) worst = left;
        if (right < heap.length && heap[right].priority > heap[worst].priority) worst = right;
        if (worst === index) break;
        [heap[index], heap[worst]] = [heap[worst], heap[index]];
        index = worst;
      }
      return removed;
    }
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (heap[parent].priority >= heap[index].priority) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return removed;
  }
}

/** Bounded, topic-stratified streaming sample. Recent eligible additions have a
 * reserved lane. No catalog scan or visual inference runs when someone clicks. */
export function buildCuteIndex(
  items: Iterable<DiscoveryArtwork>,
  capacity = 512,
  seed = 'ultraclipart',
) {
  const limit = Math.max(1, Math.min(512, Math.floor(capacity) || 1));
  const perTopic = Math.max(4, Math.ceil(limit / 16));
  type Topic = { topic: string; priority: number; sample: Reservoir<Ranked>; ids: Set<string> };
  const topics = new Map<string, Topic>(),
    topicHeap = new Reservoir<Topic>(limit);
  type Recent = { pick: CutePick; previous?: Recent; next?: Recent };
  let first: Recent | undefined, last: Recent | undefined;
  const recent = new Map<string, Recent>(),
    recentTopics = new Map<string, Recent[]>();
  const freshLimit = Math.min(128, Math.max(1, Math.ceil(limit / 4))),
    freshPerTopic = Math.max(1, Math.ceil(freshLimit / 16));
  function remove(node: Recent) {
    if (node.previous) node.previous.next = node.next;
    else first = node.next;
    if (node.next) node.next.previous = node.previous;
    else last = node.previous;
    recent.delete(node.pick.id);
    const group = recentTopics.get(node.pick.topic)!;
    group.splice(group.indexOf(node), 1);
    if (!group.length) recentTopics.delete(node.pick.topic);
  }
  for (const item of items) {
    const score = cuteConfidence(item);
    if (!score) continue;
    let topic = topics.get(item.topic);
    if (!topic) {
      const candidate: Topic = {
        topic: item.topic,
        priority: hash(`${seed}:topic:${item.topic}`),
        sample: new Reservoir(perTopic),
        ids: new Set(),
      };
      const evicted = topicHeap.add(candidate);
      if (evicted !== candidate) {
        if (evicted) topics.delete(evicted.topic);
        topics.set(item.topic, candidate);
        topic = candidate;
      }
    }
    if (topic && !topic.ids.has(item.id)) {
      const candidate = {
        id: item.id,
        topic: item.topic,
        priority: -Math.log((hash(`${seed}:${item.id}`) + 0.5) / 4294967296) / score,
      };
      const evicted = topic.sample.add(candidate);
      if (evicted !== candidate) {
        if (evicted) topic.ids.delete(evicted.id);
        topic.ids.add(item.id);
      }
    }
    if (!recent.has(item.id)) {
      const node: Recent = {
        pick: { id: item.id, topic: item.topic, fresh: true },
        previous: last,
      };
      if (last) last.next = node;
      else first = node;
      last = node;
      recent.set(item.id, node);
      const group = recentTopics.get(item.topic) ?? [];
      group.push(node);
      recentTopics.set(item.topic, group);
      if (group.length > freshPerTopic) remove(group[0]);
      while (recent.size > freshLimit) remove(first!);
    }
  }
  // Importers preserve accepted positions and append new records. Recency is
  // catalog addition order, not an invented creation date or repeated drawing.
  const fresh = [...recent.values()].reverse().map((node) => node.pick);
  const used = new Set(fresh.map((pick) => pick.id));
  const groups = [...topics.values()]
    .sort((a, b) => a.priority - b.priority)
    .map((topic) =>
      topic.sample.rows
        .sort((a, b) => a.priority - b.priority)
        .filter((pick) => !used.has(pick.id)),
    );
  const archive: CutePick[] = [];
  for (let depth = 0; depth < perTopic && archive.length < limit - fresh.length; depth++)
    for (const group of groups) {
      const pick = group[depth];
      if (pick && archive.length < limit - fresh.length)
        archive.push({ id: pick.id, topic: pick.topic });
    }
  const result: CutePick[] = [];
  while (result.length < limit && (fresh.length || archive.length)) {
    if (fresh.length && (result.length % 4 === 0 || !archive.length)) result.push(fresh.shift()!);
    else if (archive.length) result.push(archive.shift()!);
    else result.push(fresh.shift()!);
  }
  return result;
}

export function validCuteIndex(value: unknown): CutePick[] {
  if (!Array.isArray(value) || value.length > 512) return [];
  const seen = new Set<string>();
  return value
    .filter((item): item is CutePick => {
      if (
        !item ||
        typeof item.id !== 'string' ||
        typeof item.topic !== 'string' ||
        !/^[a-z0-9-]+$/.test(item.id) ||
        !/^[a-z0-9-]+$/.test(item.topic) ||
        seen.has(item.id)
      )
        return false;
      seen.add(item.id);
      return true;
    })
    .map(({ id, topic, fresh }) => ({ id, topic, ...(fresh === true ? { fresh: true } : {}) }));
}

export function pickCute(
  items: readonly CutePick[],
  recent: readonly string[],
  current = '',
  random = Math.random,
) {
  const currentSafe = items.filter((x) => x.id !== current);
  let available = currentSafe.filter((x) => !recent.includes(x.id));
  if (!available.length) available = currentSafe.filter((x) => x.id !== recent[0]);
  if (!available.length) available = currentSafe;
  if (!available.length) return null;
  const lastTopic = items.find((x) => x.id === recent[0])?.topic;
  const recentTopics = new Set(
    recent.slice(0, 3).flatMap((id) => items.find((item) => item.id === id)?.topic ?? []),
  );
  const varied = available.filter((x) => !recentTopics.has(x.topic));
  const differentLast = available.filter((x) => x.topic !== lastTopic);
  if (varied.length) available = varied;
  else if (differentLast.length) available = differentLast;
  const unit = () => {
    const value = random();
    return Number.isFinite(value) ? Math.max(0, Math.min(0.9999999999999999, value)) : 0;
  };
  const fresh = available.filter((item) => item.fresh),
    archive = available.filter((item) => !item.fresh);
  if (fresh.length && archive.length) available = unit() < 0.35 ? fresh : archive;
  const eligibleGroups = new Map<string, CutePick[]>();
  for (const item of available) {
    const group = eligibleGroups.get(item.topic) ?? [];
    group.push(item);
    eligibleGroups.set(item.topic, group);
  }
  const grouped = [...eligibleGroups.values()];
  const group = grouped[Math.floor(unit() * grouped.length)];
  return group[Math.floor(unit() * group.length)];
}
