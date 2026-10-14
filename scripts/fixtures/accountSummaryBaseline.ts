import { ObjectId } from 'mongodb';
// Frozen Task 3 physical baseline; preserve Mongo predicates for differential fixtures.
import type { UserProgress } from '../../src/features/progress/progress.types.js';
import { STUDY_STATUS_PROJECTION, isGraduatedStudyCard, type StudyStatusSnapshot } from '../../src/features/progress/studyStatus.js';

// Unknown/legacy schedulers and zero-interval reviews retain the original JS
// compatibility path. Known learning/review totals can be counted in MongoDB.
export const counterFallback = { $or: [
  { 'scheduler.phase': { $nin: ['LEARNING', 'RELEARNING', 'REVIEW'] } },
  { 'scheduler.phase': 'REVIEW', interval: 0 },
] };

export function counterSummaryPipeline(query: object, eligible: object, now: Date) {
  const phase = '$scheduler.phase';
  const due = { $ifNull: ['$temporaryDueDate', '$nextDueDate'] };
  return [
    { $match: { ...query, $and: [{ $nor: [counterFallback] }, eligible] } },
    { $group: { _id: null,
      review: { $sum: { $cond: [{ $and: [{ $eq: [phase, 'REVIEW'] }, { $lte: [due, now] }] }, 1, 0] } },
      learning: { $sum: { $cond: [{ $and: [{ $in: [phase, ['LEARNING', 'RELEARNING']] }, { $lte: [due, now] }] }, 1, 0] } },
    } },
  ];
}

export type StudyIdentity = Pick<UserProgress, 'itemId' | 'relationId' | 'itemType'> & (StudyStatusSnapshot | { graduated: boolean });
export function isGraduatedStudyIdentity(row: StudyIdentity) {
  return 'graduated' in row ? row.graduated : isGraduatedStudyCard(row);
}

/** Fresh allocation exclusions need one typed relation identity, not both
 * directional schedules. Hash grouping keeps legacy/null relation fallbacks. */
export function newItemIdentityPipeline(query: object) {
  return [
    { $match: query },
    { $group: { _id: { itemType: '$itemType', itemId: { $ifNull: ['$relationId', '$itemId'] } } } },
    { $project: { _id: 0, itemType: '$_id.itemType', itemId: '$_id.itemId' } },
  ];
}

/** Fold directional mastery identities; legacy phases retain code inference. */
export function identitySummaryPipeline(query: object) {
  return [
    { $match: query },
    { $facet: {
      known: [
        { $match: { 'scheduler.phase': { $in: ['NEW', 'LEARNING', 'RELEARNING', 'REVIEW'] } } },
        { $group: { _id: { itemId: { $ifNull: ['$relationId', '$itemId'] }, itemType: '$itemType' },
          interval: { $max: { $cond: [{ $and: [{ $eq: ['$scheduler.phase', 'REVIEW'] }, { $gte: ['$interval', 1] }] }, 1, 0] } },
        } },
        { $project: { _id: 0, itemId: '$_id.itemId', itemType: '$_id.itemType', graduated: { $gt: ['$interval', 0] } } },
      ],
      legacy: [
        { $match: { 'scheduler.phase': { $nin: ['NEW', 'LEARNING', 'RELEARNING', 'REVIEW'] } } },
        { $project: { _id: 0, itemId: 1, relationId: 1, itemType: 1, ...STUDY_STATUS_PROJECTION } },
      ],
    } },
  ];
}

export function counterEligibility(now: Date, categoryIds: ObjectId[] | null, catalog: { words: { _id: ObjectId }[]; phrases: { _id: ObjectId }[] }) {
  return { suspended: { $ne: true }, supersededByAnki: { $ne: true },
    $and: [
      { $or: [{ buriedUntil: null }, { buriedUntil: { $lte: now } }] },
      { $or: [
        { card: { $ne: null } },
        ...([['WORD', catalog.words], ['PHRASE', catalog.phrases]] as const).map(([itemType, rows]) => ({ itemType, $or: [
          { relationId: { $in: rows.map(row => row._id) } },
          { relationId: null, itemId: { $in: rows.map(row => row._id) } },
        ] })),
      ] },
      ...(categoryIds === null ? [] : [{ $or: [{ relationId: { $in: categoryIds } }, { relationId: { $exists: false }, itemId: { $in: categoryIds } }] }]),
    ],
  };
}

import { getDb } from '../../src/lib/database.js';
import type { User } from '../../src/features/auth/auth.types.js';
import { studyMetadata, studyDailyCounts, studyCatalog, STUDY_SUMMARY_BATCH_SIZE } from '../../src/features/progress/studyLoading.js';
import { categoryRelations } from '../../src/features/progress/categories.js';
import { studyCurriculum, planCurriculumIntroductions } from '../../src/features/progress/studyCurriculum.js';
import { studyReferenceIds, hasStudyReference } from '../../src/features/progress/studyCandidates.js';
import { withScheduler } from '../../src/features/progress/reviews.js';
import { DEFAULT_OPTIONS, initialScheduler } from '../../src/features/progress/scheduler.js';
import { newCardGroups, isNewCard } from '../../src/features/progress/newWordOrder.js';
import { introducedToday, applyDailyLimit } from '../../src/features/progress/dailyLimit.js';
import { studyTextCatalog } from '../../src/features/progress/studyTextCatalog.js';
import { nativeWordPair } from '../../src/features/progress/nativeWordPairs.js';
import { selectStudyQueue } from '../../src/features/progress/studyQueue.js';
import { effectiveDueDate } from '../../src/features/progress/studyScheduling.js';

// The physical baseline includes an unreleased completion feature. The guarded
// test supplies its actual hooks when present; a deployed-feature checkout can
// compare its own baseline without importing/publishing that feature.
let completion: {
  completeDueStudyCards: (context: object, userId: ObjectId, now: Date, profile: any) => Promise<void>;
  isStudyCompleted: (progress: UserProgress, now: Date) => boolean;
} | undefined;
export function setAccountSummaryBaselineCompletion(hooks: typeof completion) { completion = hooks; }


function requireOwner(context: { user: User | null }, userId: string) {
  if (!context?.user || context.user._id.toString() !== userId) throw new Error('Unauthorized');
}
function baselineSummarizedStudyCounts(context: object, userId: ObjectId, now: Date, itemType: UserProgress['itemType'] | undefined, eligible: object, _category?: string) {
  return baselineCountSnapshot(context, userId, now, itemType, eligible);
}
const identityRequests = new WeakMap<object, Map<string, Promise<StudyIdentity[]>>>();
export function baselineStudyIdentities(context: object, userId: ObjectId, phraseRelationIds?: ObjectId[]) {
  let requests = identityRequests.get(context);
  if (!requests) identityRequests.set(context, requests = new Map());
  const key = `${userId}:${phraseRelationIds ? 'PHRASE_CATALOG' : 'ALL'}`;
  const scope = phraseRelationIds ? { $or: [
    { relationId: { $in: phraseRelationIds } },
    { relationId: null, itemId: { $in: phraseRelationIds } },
  ] } : {};
  let result = requests.get(key);
  if (!result) requests.set(key, result = getDb().progress.aggregate<{ known: StudyIdentity[]; legacy: StudyIdentity[] }>(identitySummaryPipeline({ userId, ...scope })).toArray().then(rows => [...(rows[0]?.known ?? []), ...(rows[0]?.legacy ?? [])]));
  return result;
}

export async function baselineCountSnapshot(context: object, userId: ObjectId, now: Date, itemType?: UserProgress["itemType"], eligible?: object) {
  const db = getDb();
  const query = { userId, ...(itemType ? { itemType } : {}), $or: [
    { nextDueDate: { $lte: now } }, { temporaryDueDate: { $lte: now } },
    { "scheduler.phase": { $in: ["NEW", "LEARNING", "RELEARNING"] } }, { scheduler: null },
  ] };
  const [account, progress, summary] = await Promise.all([
    studyMetadata(context, userId),
    db.progress.find({ ...query, ...(eligible ? { $and: [counterFallback] } : {}) }).project<UserProgress>({
      _id: 1, userId: 1, itemId: 1, itemType: 1, relationId: 1,
      isNew: 1, suspended: 1, supersededByAnki: 1, buriedUntil: 1,
      // Only counter/selection inputs, never a serialized or persisted scheduler.
      "scheduler.phase": 1, "scheduler.queue": 1, "scheduler.timeZone": 1, "scheduler.rollover": 1,
      "scheduler.options.newPerDay": 1, "scheduler.options.reviewsPerDay": 1,
      "scheduler.options.learnAheadSeconds": 1, "scheduler.options.newMix": 1, "scheduler.options.interdayMix": 1,
      "scheduler.options.initialEase": 1, "scheduler.options.learningSteps": 1, "scheduler.options.relearningSteps": 1,
      nextDueDate: 1, temporaryDueDate: 1, lastReviewed: 1,
      ease: 1, interval: 1, repetitions: 1, totalReviews: 1, lapses: 1, createdAt: 1, updatedAt: 1,
      "anki.type": 1, "anki.queue": 1, "anki.left": 1, "anki.reps": 1,
      "anki.did": 1, "anki.odid": 1, "anki.due": 1,
      "card.direction": 1, "card.sourceNoteGuid": 1,
      "card.sourceCardId": 1, "card.deck": 1,
    }).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray(),
    eligible ? db.progress.aggregate<{ review: number; learning: number }>(counterSummaryPipeline(query, eligible, now)).toArray() : [],
  ]);
  return { ...account, progress, summary: summary[0] ?? { review: 0, learning: 0 } };
}

export interface StudyQueueCounts { new: number; learning: number; review: number; total?: number; learned?: number; }
export async function baselineLoadStudyQueueCounts(
  { userId, itemType, context: category }: { userId: string; itemType?: string; context?: string },
  context: { user: User | null },
  prepared?: { now: Date; progress: Promise<UserProgress[]>; countersOnly?: boolean },
): Promise<StudyQueueCounts> {
  requireOwner(context, userId);
  if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
  const db = getDb(), id = new ObjectId(userId), now = prepared?.now ?? new Date();
  await completion?.completeDueStudyCards(context, id, now, (await studyMetadata(context,id)).profile);
  const curriculumRequest = studyCurriculum(context, itemType);
  const catalogRequest = curriculumRequest.then(curriculum => ({
    words: curriculum.entries.filter(e => e.type === "WORD").map(e => e.relation),
    phrases: curriculum.entries.filter(e => e.type === "PHRASE").map(e => e.relation),
  }));
  const readIdentities = () => itemType === "PHRASE"
    ? catalogRequest.then(catalog => baselineStudyIdentities(context,id,catalog.phrases.map(relation=>relation._id)))
    : baselineStudyIdentities(context,id);
  const categoryRequest = categoryRelations(category,itemType,context);
  const snapshotRequest = prepared
    ? Promise.all([studyMetadata(context,id),prepared.progress]).then(([account,progress])=>({...account,progress,summary:{review:0,learning:0}}))
    : Promise.all([catalogRequest,categoryRequest]).then(([catalog,categoryIds])=>baselineSummarizedStudyCounts(context,id,now,itemType as UserProgress['itemType'] | undefined,counterEligibility(now,categoryIds,catalog),category));
  const [{profile, progress: scoped, limit, summary: ready}, initialSeen, catalog, categoryIds, counts, curriculum] = await Promise.all([
    snapshotRequest, prepared?.countersOnly ? undefined : readIdentities(), catalogRequest, categoryRequest, studyDailyCounts(context,id,now), curriculumRequest,
  ]);
  const categorySet = categoryIds === null ? null : new Set(categoryIds.map(String));
  const references = studyReferenceIds(catalog);
  const docs = scoped.filter(p => !p.suspended && !p.supersededByAnki && (!p.buriedUntil || p.buriedUntil<=now)
    && hasStudyReference(p, references)
    && (!itemType || p.itemType===itemType) && (!categorySet || categorySet.has(String(p.relationId)) || p.relationId === undefined && categorySet.has(String(p.itemId))));
  const guids = new Set(docs.filter(p=>p.itemType==="WORD" && p.card && isNewCard(p)).map(p=>p.card!.sourceNoteGuid));
  const present = new Set(docs.map(p=>String(p.itemId)));
  const siblings = scoped.filter(p=>p.itemType==="WORD" && !p.supersededByAnki && guids.has(p.card?.sourceNoteGuid) && !present.has(String(p.itemId)));
  const progress = (await Promise.all([...docs,...siblings].map(p=>withScheduler(p,profile)))).filter(p=>!completion?.isStudyCompleted(p,now));
  // Count unseen catalogue cards without creating progress merely by opening
  // the dashboard. Native words count both recognition and production.
  const allSeen = initialSeen ?? [];
  const availableNew = Math.max(0, limit - introducedToday(counts));
  const makeNew = (relationId: ObjectId, type: "WORD" | "PHRASE"): UserProgress => {
    const p: UserProgress = {_id:relationId,userId:id,itemId:relationId,itemType:type,isNew:true,ease:2.5,interval:0,repetitions:0,nextDueDate:now,lastReviewed:null,createdAt:now};
    p.scheduler=initialScheduler(p,profile?.defaultOptions ?? DEFAULT_OPTIONS,profile?.timeZone ?? "Europe/Berlin",profile?.rollover ?? 4);return p;
  };
  let newCards = 0;
  if (availableNew) {
    // Match retrieval's rank/allocation budget before applying deck ceilings.
    // A few blocked/later pending cards must not hide earlier unseen cards.
    // Typed exclusions are fresh; only selected virtual pairs are constructed.
    const identities = initialSeen ?? await db.progress.aggregate<{ itemId: ObjectId; itemType: string; relationId?: ObjectId }>(newItemIdentityPipeline({ userId: id, ...(itemType ? { itemType } : {}) })).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray();
    const seen = new Set(identities.map(p => `${p.itemType}:${p.relationId ?? p.itemId}`));
    const available = progress.filter(p => !p.suspended && !p.supersededByAnki && (!p.buriedUntil || p.buriedUntil <= now));
    const groups = newCardGroups(progress, available, curriculum.compare);
    const unseen = curriculum.entries.filter(entry => !seen.has(`${entry.type}:${entry.relation._id}`)
      && (!categorySet || categorySet.has(String(entry.relation._id))));
    const plan = planCurriculumIntroductions(groups, unseen, availableNew, true, curriculum.rank);
    const pending = [...plan.pending, ...plan.entries.map(entry => makeNew(entry.relation._id, entry.type))];
    const relations = new Map(catalog.words.map(r => [String(r._id), r]));
    const needsPairs = pending.some(p => p.itemType === "WORD" && !p.card && isNewCard(p));
    const text = needsPairs ? await studyTextCatalog("WORD", db) : undefined;
    const es = new Map(text?.wordsES.map(w => [String(w._id), w])), de = new Map(text?.wordsDE.map(w => [String(w._id), w]));
    const candidates = [...progress.filter(p => !isNewCard(p)), ...pending.flatMap(p => {
      if (p.itemType !== "WORD" || p.card || !isNewCard(p)) return [p];
      const relation = relations.get(String(p.relationId ?? p.itemId))!;
      return nativeWordPair(p, es.get(String(relation.main))!, de.get(String(relation.translated))!);
    })];
    newCards = selectStudyQueue(applyDailyLimit(candidates, limit), counts, now, 0, availableNew, true, curriculum.compare).filter(p=>p.scheduler.phase === "NEW").length;
  }
  const summary = { new: newCards,
    learning: ready.learning + progress.filter(p=>!p.suspended && (!p.buriedUntil || p.buriedUntil<=now)).filter(p=>["LEARNING","RELEARNING"].includes(p.scheduler.phase) && effectiveDueDate(p) <= now).length,
    review: ready.review + progress.filter(p=>!p.suspended && (!p.buriedUntil || p.buriedUntil<=now)).filter(p=>p.scheduler.phase === "REVIEW" && effectiveDueDate(p) <= now).length };
  if (prepared?.countersOnly) return summary;
  const catalogIds: ObjectId[] = [];
  for (const type of ["WORD","PHRASE"]) if (!itemType || itemType === type) {
    const relations=type === "WORD" ? catalog.words : catalog.phrases;
    catalogIds.push(...relations.filter(r=>!categorySet || categorySet.has(String(r._id))).map(row=>row._id));
  }
  const learnedIds=new Set(allSeen.filter(p=>isGraduatedStudyIdentity(p) && (!itemType || p.itemType===itemType)).map(p=>String(p.relationId ?? p.itemId)));
  return { total: catalogIds.length, learned: catalogIds.filter(id=>learnedIds.has(String(id))).length, ...summary };
}

export const baselineLearningPath = async (_: unknown, { userId }: { userId: string }, context: { user: User | null }) => {
      requireOwner(context, userId);
      const userObjectId = new ObjectId(userId);

      const [progresses, catalog] = await Promise.all([
        baselineStudyIdentities(context,userObjectId), studyCatalog(context),
      ]);
      const wordRelations = catalog.words, phraseRelations = catalog.phrases;
      const wordsLookup = catalog.wordMeta, phrasesLookup = catalog.phraseMeta;

      const wordMeta = new Map(
        wordsLookup.map((w) => [
          w._id.toString(),
          { contexts: w.contexts || [], level: w.level },
        ]),
      );
      const phraseMeta = new Map(
        phrasesLookup.map((p) => [
          p._id.toString(),
          { contexts: p.contexts || [], level: p.level },
        ]),
      );

      const learnedSet = new Set(
        progresses
          .filter(isGraduatedStudyIdentity)
          .map((p) => (p.relationId || p.itemId).toString()),
      );

      const nodesMap: Record<string, any> = {};

      // ── Populate Word stats using relation IDs ──
      for (const wr of wordRelations) {
        const meta = wordMeta.get(wr.main.toString());
        if (!meta?.contexts?.length) continue;
        const isLearned = learnedSet.has(wr._id.toString());
        for (const ctxId of meta.contexts) {
          if (!nodesMap[ctxId]) {
            nodesMap[ctxId] = {
              id: ctxId,
              name: ctxId
                .replace(/_/g, " ")
                .replace(/\b\w/g, (l: string) => l.toUpperCase()),
              level: meta.level || "A1",
              isUnlocked: false,
              wordsTotal: 0,
              wordsLearned: 0,
              phrasesTotal: 0,
              phrasesLearned: 0,
            };
          }
          nodesMap[ctxId].wordsTotal += 1;
          if (isLearned) {
            nodesMap[ctxId].wordsLearned += 1;
          }
        }
      }

      // ── Populate Phrase stats using relation IDs ──
      for (const pr of phraseRelations) {
        const meta = phraseMeta.get(pr.main.toString());
        if (!meta?.contexts?.length) continue;
        const isLearned = learnedSet.has(pr._id.toString());
        for (const ctxId of meta.contexts) {
          if (!nodesMap[ctxId]) {
            nodesMap[ctxId] = {
              id: ctxId,
              name: ctxId
                .replace(/_/g, " ")
                .replace(/\b\w/g, (l: string) => l.toUpperCase()),
              level: meta.level || "A1",
              isUnlocked: false,
              wordsTotal: 0,
              wordsLearned: 0,
              phrasesTotal: 0,
              phrasesLearned: 0,
            };
          }
          nodesMap[ctxId].phrasesTotal += 1;
          if (isLearned) {
            nodesMap[ctxId].phrasesLearned += 1;
          }
        }
      }

      const nodes = Object.values(nodesMap);

      // Calculate unlock cascade
      const levels = ["A1", "A2", "B1", "B2", "C1", "C2"];

      // Calculate overall mastery per level
      const masteryPerLevel: Record<string, number> = {};
      for (const lvl of levels) {
        const lvlNodes = nodes.filter((n) => n.level === lvl);
        if (lvlNodes.length === 0) {
          masteryPerLevel[lvl] = 100; // Auto-pass empty levels
          continue;
        }
        const totalItems = lvlNodes.reduce(
          (acc, n) => acc + n.wordsTotal + n.phrasesTotal,
          0,
        );
        const totalLearned = lvlNodes.reduce(
          (acc, n) => acc + n.wordsLearned + n.phrasesLearned,
          0,
        );
        masteryPerLevel[lvl] =
          totalItems > 0 ? (totalLearned / totalItems) * 100 : 0;
      }

      // Unlock logic: A1 is always unlocked. Next level unlocked if previous level > 50% mastery
      for (const node of nodes) {
        const lvlIdx = levels.indexOf(node.level);
        if (lvlIdx === 0) {
          node.isUnlocked = true;
        } else {
          const prevLvl = levels[lvlIdx - 1];
          node.isUnlocked = masteryPerLevel[prevLvl] >= 50;
        }

        // Minor clean up on DB names
        if (node.id === "lang_party") node.name = "Language Party";
        if (node.id === "colombian_compliments")
          node.name = "Colombian Compliments";
      }

      return nodes.sort((a, b) => {
        const lvlDiff = levels.indexOf(a.level) - levels.indexOf(b.level);
        if (lvlDiff !== 0) return lvlDiff;
        return a.id.localeCompare(b.id);
      });
    };
