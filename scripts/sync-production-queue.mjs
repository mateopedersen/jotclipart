import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { originalGoalArtworkIds } from './original-goal-counts.mjs';
const root = resolve(import.meta.dirname, '..'),
  read = (path) => JSON.parse(readFileSync(join(root, path)));
const topics = read('data/topics.json').topics,
  art = read('data/art.json');
const prior = read('data/production-queue.json');
const approved = art.filter((a) => a.published);
const originalTopics = new Set(topics.map((t) => t.slug));
const originalArt = art.filter((a) => originalTopics.has(a.topic));
const allocation = read('data/original-goal-allocation.json');
const goalIds = originalGoalArtworkIds(art, topics, allocation);
const originalTargetArt = originalArt.filter(
  (a) => a.productionMethod === 'owner-supplied' || goalIds.has(a.id),
);
const originalTargetIds = new Set(originalTargetArt.map((a) => a.id));
const verifiedLive = prior.verifiedPublishedGeneratedArtworkCount ?? 0;
if (!Number.isSafeInteger(verifiedLive) || verifiedLive < 0 || verifiedLive > goalIds.size)
  throw Error('Invalid verified-live original count');
const queue = {
  version: 4,
  targetBasis: 'GENERATED_ARTWORKS_IN_ORIGINAL_110_TOPICS',
  productionPausedByOwner: prior.productionPausedByOwner ?? false,
  states: prior.states,
  targetArtworkCount: 5500,
  generatedArtworkCount: goalIds.size,
  suppliedArtworkCount: art.filter((a) => a.productionMethod === 'owner-supplied').length,
  originalTopicArtworkCount: originalTargetArt.length,
  supplementalArtworkCount: art.length - originalTargetArt.length,
  qualityApprovedArtworkCount: originalTargetArt.filter((a) => a.published).length,
  supplementalApprovedArtworkCount: approved.filter((a) => !originalTargetIds.has(a.id)).length,
  verifiedPublishedGeneratedArtworkCount: verifiedLive,
  acceptedAwaitingRelease: goalIds.size - verifiedLive,
  reviewerType: 'AI_AGENT_NOT_HUMAN',
  humanApprovedArtworkCount: 0,
  availableArtworkCount: art.length,
  remainingToDraw: 5500 - goalIds.size,
  nextAction: prior.productionPausedByOwner
    ? 'New image generation is paused until the owner explicitly resumes it. Import and publish supplied packages after verification.'
    : 'Develop distinct compositions for the remaining topic targets; export, visually review, verify all R2/CDN representations, then publish a complete wave.',
  topics: topics.map((t) => {
    const items = art.filter((a) => a.topic === t.slug);
    const generated = items.filter((a) => goalIds.has(a.id)).length;
    if (generated > 50) throw new Error('Topic target exceeded');
    const briefPath = `data/briefs/${t.slug}.json`;
    const brief = existsSync(join(root, briefPath)) ? read(briefPath) : null;
    const reviewed =
      brief?.rows?.length === (allocation.topics[t.slug]?.ownerApprovedTarget ?? 50) &&
      brief.rows.every((row) => row.briefReview === 'REVIEWED_FOR_DISTINCT_COMPOSITION');
    return {
      ...(prior.topics.find((item) => item.topic === t.slug) ?? {}),
      topic: t.slug,
      keyword: t.keyword,
      wave: t.wave,
      target: 50,
      generated,
      supplied: items.filter((a) => a.productionMethod === 'owner-supplied').length,
      available: items.length,
      approved: items.filter((a) => a.published).length,
      remainingToDraw: 50 - generated,
      briefStatus: reviewed
        ? brief.rows.length + '_COMPOSITIONS_REVIEWED'
        : brief
          ? 'DRAFT_ROWS_REQUIRE_REVIEW'
          : 'NOT_STARTED',
      briefPath: existsSync(join(root, briefPath)) ? briefPath : null,
    };
  }),
  generated: art.map((a) => ({
    id: a.id,
    topic: a.topic,
    state: a.published ? 'PUBLISHED' : 'ART_REVIEW',
    retryCount: 0,
    failReason: null,
    artReview: a.reviewStatus,
    humanReview: 'NOT_PERFORMED',
    publicationBlocked: !a.published,
    sha256: (a.files.svg ?? a.files.webp).sha256,
  })),
};
writeFileSync(join(root, 'data/production-queue.json'), JSON.stringify(queue, null, 2) + '\n');
console.log({
  drawn: queue.generatedArtworkCount,
  remaining: queue.remainingToDraw,
  reviewed: approved.length,
});
