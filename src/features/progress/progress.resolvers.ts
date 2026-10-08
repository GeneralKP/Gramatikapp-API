import { loadStudyRelations, studyCountSnapshot, studyIdentities, studyDailyCounts, studyCatalog, studyMetadata, insertNewProgress, STUDY_CONTENT_BATCH_SIZE, STUDY_SUMMARY_BATCH_SIZE } from "./studyLoading.js";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { UserProgress } from "./progress.types.js";
import { recordFailure } from "./failures.js";
import { User } from "../auth/auth.types.js";
import { randomUUID } from "node:crypto";
import { saveReview, undoReview, withScheduler, dailyCounts, ReviewConflict } from "./reviews.js";
import { effectiveDueDate, studyReviewOptions, type StudyGrade } from "./studyScheduling.js";
import { categoryRelations, categoryProgressFilter } from "./categories.js";
import { DEFAULT_OPTIONS, initialScheduler, studyDay, Grade, schedulerSeed } from "./scheduler.js";
import { selectStudyQueue } from "./studyQueue.js";
import { isNewCard, newCardGroups } from "./newWordOrder.js";
import { nativeWordPair, ensureNativeWordPairs } from "./nativeWordPairs.js";
import { introducedToday, applyDailyLimit } from "./dailyLimit.js";
import { studyTextCatalog } from "./studyTextCatalog.js";
import { isDueStudyCandidate, hasStudyReference, studyReferenceIds } from "./studyCandidates.js";
import { selectedFields } from "../levels/catalogProjection.js";
import { isGraduatedStudyCard, normalizedStudyPhase, STUDY_STATUS_PROJECTION } from "./studyStatus.js";
import type { GraphQLResolveInfo } from "graphql";

function requireOwner(context: { user: User | null }, userId: string) {
  if (!context?.user || context.user._id.toString() !== userId) throw new Error("Unauthorized");
}

function toGraphQL(progress: UserProgress | null) {
  if (!progress) return null;
  return {
    ...progress,
    id: progress._id.toString(),
    userId: progress.userId.toString(),
    itemId: progress.itemId.toString(),
    itemType: progress.itemType,
    relationId: progress.relationId?.toString(),
    failureIndex: progress.failureIndex ?? 0,
    totalReviews: progress.totalReviews ?? 0,
    scheduleVersion: progress.scheduleVersion ?? 0,
    studyState: JSON.stringify({ itemId: String(progress.itemId), itemType: progress.itemType, ease: progress.ease, interval: progress.interval, repetitions: progress.repetitions,
      nextDueDate: progress.nextDueDate, temporaryDueDate: progress.temporaryDueDate, lastReviewed: progress.lastReviewed, createdAt: progress.createdAt,
      scheduler: progress.scheduler ?? initialScheduler(progress), totalReviews: progress.totalReviews ?? 0, lapses: progress.lapses ?? 0, isNew: progress.isNew, suspended: progress.suspended, buriedUntil: progress.buriedUntil,
      fuzzSeed: schedulerSeed(progress).toString(), card: progress.card ? { sourceCardId: progress.card.sourceCardId, sourceNoteGuid: progress.card.sourceNoteGuid, direction: progress.card.direction } : undefined }),
    schedulerPhase: (progress.scheduler ?? initialScheduler(progress)).phase,
    learningQueue: (progress.scheduler ?? initialScheduler(progress)).queue,
    learnAheadSeconds: (progress.scheduler ?? initialScheduler(progress)).options.learnAheadSeconds,
    lapses: progress.lapses ?? 0,
    lastFailedAt: progress.lastFailedAt?.toISOString() ?? null,
    nextDueDate: effectiveDueDate(progress).toISOString(),
    regularDueDate: progress.nextDueDate.toISOString(),
    temporaryDueDate: progress.temporaryDueDate?.toISOString() ?? null,
    lastReviewed: progress.lastReviewed?.toISOString() || null,
  };
}

async function withNewWordSiblings(db: ReturnType<typeof getDb>, userId: ObjectId, progress: UserProgress[], projection?: Record<string, number>) {
  const guids = [...new Set(progress.filter(p => p.itemType === "WORD" && p.card && isNewCard(p)).map(p => p.card!.sourceNoteGuid))];
  if (!guids.length) return progress;
  // Include recognition even when it is buried or scheduled in the future: it
  // supplies prerequisite state, without making it due or changing its schedule.
  const query = { userId, itemType: "WORD" as const, "card.sourceNoteGuid": { $in: guids }, supersededByAnki: { $ne: true } };
  let siblings: UserProgress[];
  if (projection) {
    // The postfilter already discards loaded IDs. Transfer only missing state
    // when its order is trivial. Two or more missing siblings can include
    // duplicate directions or learning-ahead cards: retain the original query
    // in that case so a changed Mongo plan cannot change their first-row order.
    const selectedGuids = new Set(guids);
    const loadedIds = progress.filter(p => p.card && selectedGuids.has(p.card.sourceNoteGuid)).map(p => p.itemId);
    const missing = await db.progress.find({ ...query, itemId: { $nin: loadedIds } })
      .project<UserProgress>(projection).limit(2).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray();
    siblings = missing.length < 2 ? missing : await db.progress.find(query).project<UserProgress>(projection).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray();
  } else {
    siblings = await db.progress.find(query).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray();
  }
  const seen = new Set(progress.map(p => p.itemId.toString()));
  return [...progress, ...siblings.filter(p => !seen.has(p.itemId.toString()))];
}

function coveredPendingCards(candidates: UserProgress[], existing: UserProgress[], needed: number) {
  if (candidates.length < needed) return false;
  const byId = new Map(existing.map(p => [String(p.itemId), p]));
  return candidates.every(p => {
    const previous = byId.get(String(p.itemId));
    if (!previous || previous.itemType !== p.itemType || String(previous.relationId) !== String(p.relationId)) return false;
    // Native legacy words still need their existing transactional pairing path.
    if (p.itemType === "WORD" && !p.card) return false;
    return !!previous.card === !!p.card && (["sourceCardId", "sourceNoteGuid", "direction"] as const).every(key => previous.card?.[key] === p.card?.[key]);
  });
}

async function fetchNewItems(
  db: ReturnType<typeof getDb>,
  userObjectId: ObjectId,
  needed: number,
  itemType?: string,
  category?: string,
  allowPartialIntroduction = false,
  selectedCategoryIds?: ObjectId[] | null,
  existingProgress?: UserProgress[],
  projection?: Record<string, number>,
): Promise<UserProgress[]> {
  const categoryIds = selectedCategoryIds === undefined ? await categoryRelations(category, itemType) : selectedCategoryIds;
  const pendingQuery: any = { ...categoryProgressFilter(categoryIds), userId: userObjectId, isNew: true, suspended: { $ne: true }, supersededByAnki: { $ne: true }, $or: [{ buriedUntil: null }, { buriedUntil: { $lte: new Date() } }] };
  if (itemType) pendingQuery.itemType = itemType;
  if (projection && existingProgress && itemType !== "PHRASE") {
    // Re-read identities from the database: another device can introduce a new
    // pending card after the initial due snapshot. Covered, unchanged native/
    // Anki cards need no repeated scheduler/options payload. Unknown IDs, changed
    // card identity and legacy words fall through to the complete fresh read.
    const identities = await db.progress.find(pendingQuery).project<UserProgress>({
      _id: 0, itemId: 1, itemType: 1, relationId: 1,
      "card.sourceCardId": 1, "card.sourceNoteGuid": 1, "card.direction": 1,
    }).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray();
    if (coveredPendingCards(identities, existingProgress, needed)) return [];
  }
  // The phrase due query already includes every pending phrase, including future
  // ones. Reuse it without allocating, dropping or reordering any new-card group.
  const references = studyReferenceIds(await studyCatalog({}, itemType, false));
  const candidates = (itemType === "PHRASE" && existingProgress
    ? existingProgress.filter(p => p.isNew === true && !p.suspended && !p.supersededByAnki && (!p.buriedUntil || p.buriedUntil <= new Date()))
    : await ensureNativeWordPairs(await (projection ? db.progress.find(pendingQuery).project<UserProgress>(projection) : db.progress.find(pendingQuery)).sort({ "anki.due": 1 }).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray())).filter(p => hasStudyReference(p, references));
  // Enough pending candidates prevent allocation even if their eligible groups
  // are blocked/too large. When all their IDs are already in the outer snapshot,
  // that caller discards every returned pending ID. Keep its later sibling read
  // fresh instead of performing an earlier lookup whose result cannot be used.
  if (projection && existingProgress && itemType !== "PHRASE" && coveredPendingCards(candidates, existingProgress, needed)) return [];
  const complete = await withNewWordSiblings(db, userObjectId, candidates, projection);
  const pending: UserProgress[] = [];
  for (const original of newCardGroups(complete, candidates)) {
    const group = allowPartialIntroduction && needed - pending.length === 1 && original.length === 2 && original[0].card?.direction === "DE_ES" ? original.slice(0,1) : original;
    if (pending.length + group.length <= needed) pending.push(...group);
  }
  if (candidates.length >= needed) return pending;
  needed -= pending.length;
  if (needed <= 0) return pending;
  const reviewedQuery: any = { userId: userObjectId };
  if (itemType) reviewedQuery.itemType = itemType;

  const reviewedIds = await db.progress
    .find(reviewedQuery)
    .project({ itemId: 1, relationId: 1 })
    .toArray();
  const reviewedSet = new Set(
    reviewedIds.map((p) => (p.relationId || p.itemId).toString()),
  );

  const excludeFilter = {
    _id: { $nin: [...reviewedSet].map((id) => new ObjectId(id)), ...(categoryIds !== null ? { $in: categoryIds } : {}) },
  };

  const newProgressDocs: UserProgress[] = [];

  if (!itemType || itemType === "WORD") {
    const neededWords = (allowPartialIntroduction ? Math.ceil : Math.floor)((itemType === "WORD" ? needed : Math.ceil(needed / 2)) / 2);
    const newWords = neededWords ? await db.relationsWordsEsDe
      .find(excludeFilter)
      .limit(neededWords)
      .toArray() : [];

    for (const w of newWords) {
      newProgressDocs.push({
        _id: new ObjectId(),
        userId: userObjectId,
        itemId: w._id,
        itemType: "WORD",
        failureIndex: 0,
        isNew: true,
        ease: 2.5,
        interval: 0,
        repetitions: 0,
        nextDueDate: new Date(),
        lastReviewed: null,
        createdAt: new Date(),
      });
    }
  }

  if (!itemType || itemType === "PHRASE") {
    const neededPhrases =
      itemType === "PHRASE" ? needed : Math.max(0, needed - newProgressDocs.length * 2);
    const newPhrases = neededPhrases ? await db.relationsPhrasesEsDe
      .find(excludeFilter)
      .limit(neededPhrases)
      .toArray() : [];

    for (const p of newPhrases) {
      newProgressDocs.push({
        _id: new ObjectId(),
        userId: userObjectId,
        itemId: p._id,
        itemType: "PHRASE",
        failureIndex: 0,
        isNew: true,
        ease: 2.5,
        interval: 0,
        repetitions: 0,
        nextDueDate: new Date(),
        lastReviewed: null,
        createdAt: new Date(),
      });
    }
  }

  const docsToAdd = newProgressDocs.slice(0, needed);
  if (docsToAdd.length > 0) {
    await insertNewProgress(docsToAdd, db);
    const persisted = await db.progress.find({ userId: userObjectId, itemId: { $in: docsToAdd.map(p => p.itemId) } }).toArray();
    const paired = await ensureNativeWordPairs(persisted);
    return [...pending, ...newCardGroups(paired, paired).flat()];
  }
  return [...pending, ...docsToAdd];
}

export interface DueStudyRequest { userId: string; dueLimit?: number; newLimit?: number; itemType?: string; context?: string; includeLearningAhead?: boolean; }
/** Shared selection: transport hydration never changes allowances, ordering or pairing. */
export async function loadDueStudyProgress(
  { userId, dueLimit = 50, newLimit = 1000, itemType, context: category, includeLearningAhead = false }: DueStudyRequest,
  context: { user: User | null }, projection?: Record<string, number>,
  prepared?: { now: Date; candidates?: Promise<UserProgress[]>; beforeNewItems?: Promise<unknown> },
): Promise<UserProgress[]> {
  requireOwner(context, userId);
  const db = getDb();
  const now = prepared?.now ?? new Date();
  const userObjectId = new ObjectId(userId);

  if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
  dueLimit = Math.max(0, Math.min(5000, dueLimit));
  const categoryRequest = dueLimit ? categoryRelations(category, itemType, context) : Promise.resolve(null);
  const readDue = (categoryIds: ObjectId[] | null) => {
    if (prepared?.candidates) {
      const categorySet = categoryIds === null ? null : new Set(categoryIds.map(String));
      return prepared.candidates.then(rows => rows.filter(p => isDueStudyCandidate(p, now, categorySet)));
    }
    const query: any = { ...categoryProgressFilter(categoryIds), userId: userObjectId, suspended: { $ne: true }, supersededByAnki: { $ne: true },
      $or: [{ temporaryDueDate: { $lte: now } }, { temporaryDueDate: null, nextDueDate: { $lte: new Date(now.getTime() + 1200000) } }, { isNew: true }] };
    if (itemType) query.itemType = itemType;
    const read = db.progress.find(query);
    return (projection ? read.project<UserProgress>(projection) : read).batchSize(projection ? STUDY_SUMMARY_BATCH_SIZE : STUDY_CONTENT_BATCH_SIZE).toArray();
  };
  const [{limit, profile}, counts, selectedCategoryIds, existing, catalog] = await Promise.all([
    studyMetadata(context,userObjectId), studyDailyCounts(context,userObjectId,now), categoryRequest,
    dueLimit ? categoryRequest.then(readDue) : null,
    studyCatalog(context, itemType, false),
  ]);
  newLimit = Math.max(0, Math.min(1000, newLimit, limit - introducedToday(counts)));
  if (!dueLimit && !newLimit) return [];
  const categoryIds = dueLimit ? selectedCategoryIds : await categoryRelations(category, itemType, context);
  const references = studyReferenceIds(catalog);
  let docs = (existing ?? await readDue(categoryIds)).filter(p => hasStudyReference(p, references));
  if (newLimit > 0) {
    // Combined counters capture unseen identities before this request can
    // allocate progress. Existing pending/late sibling checks remain fresh.
    if (prepared?.beforeNewItems) await prepared.beforeNewItems;
    const fresh = await fetchNewItems(db, userObjectId, newLimit, itemType, category, newLimit >= limit - introducedToday(counts), categoryIds, docs, projection);
    const seen = new Set(docs.map(p => p.itemId.toString()));
    docs.push(...fresh.filter(p => !seen.has(p.itemId.toString())));
  }
  docs = await Promise.all((await withNewWordSiblings(db, userObjectId, await ensureNativeWordPairs(docs), projection)).map(p => withScheduler(p, profile)));
  const selected = selectStudyQueue(applyDailyLimit(docs, limit), counts, now, dueLimit, newLimit, newLimit >= limit - introducedToday(counts));
  const selectedIds = new Set(selected.map(p=>String(p.itemId)));
  const ahead = includeLearningAhead ? docs.filter(p=>!selectedIds.has(String(p.itemId)) && !p.suspended && (!p.buriedUntil || p.buriedUntil<=now) && p.scheduler.queue === "MINUTE" && p.nextDueDate>now && p.nextDueDate.getTime()<=now.getTime()+p.scheduler.options.learnAheadSeconds*1000) : [];
  return [...selected,...ahead];
}

export async function loadMoreStudyProgress(
  { userId, limit = 20, itemType, context: category }: { userId: string; limit?: number; itemType?: string; context?: string },
  context: { user: User | null }, projection?: Record<string, number>,
): Promise<UserProgress[]> {
  requireOwner(context, userId);
  if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
  limit = Math.max(0, Math.min(500, limit));
  if (!limit) return [];
  const db = getDb();
  const now = new Date();
  const userObjectId = new ObjectId(userId);

  const [{profile, limit: limitNew}, categoryIds, catalog] = await Promise.all([
    studyMetadata(context,userObjectId), categoryRelations(category,itemType,context),
    studyCatalog(context, itemType, false),
  ]);
  const countsPromise = dailyCounts(userObjectId, studyDay(now, profile?.timeZone ?? "Europe/Berlin", profile?.rollover ?? 4), profile);
  // 1) Fetch future-due items (nextDueDate > now), closest first
  const futureQuery: any = {
    ...categoryProgressFilter(categoryIds),
    userId: userObjectId,
    nextDueDate: { $gt: now }, temporaryDueDate: null,
    isNew: { $ne: true }, suspended: { $ne: true }, supersededByAnki: { $ne: true },
    $or: [{ buriedUntil: null }, { buriedUntil: { $lte: now } }],
  };
  if (itemType) futureQuery.itemType = itemType;

  // Exclude orphan references before LIMIT so they cannot hide valid later cards.
  futureQuery.$and = [...(futureQuery.$and ?? []), { $or: [
    { card: { $ne: null } },
    ...([['WORD', catalog.words], ['PHRASE', catalog.phrases]] as const).map(([type, rows]) => ({
      itemType: type, $or: [
        { relationId: { $in: rows.map(row => row._id) } },
        { relationId: null, itemId: { $in: rows.map(row => row._id) } },
      ],
    })),
  ] }];

  const futureDueLimit = Math.ceil(limit * 0.7);

  const [futureCandidates, counts] = await Promise.all([
    (projection ? db.progress.find(futureQuery).project<UserProgress>(projection) : db.progress.find(futureQuery)).sort({ nextDueDate: 1 }).limit(futureDueLimit).toArray(),
    countsPromise,
  ]);
  const references = studyReferenceIds(catalog);
  const futureDocs = futureCandidates.filter(p => hasStudyReference(p, references));

  // Extra practice never bypasses the account's daily new-card allowance.
  const remaining = limit - futureDocs.length;
  let newDocs: UserProgress[] = [];
  const available = Math.max(0, Math.min(remaining, limitNew - introducedToday(counts)));
  if (available > 0) newDocs = await fetchNewItems(db, userObjectId, available, itemType, category, available >= limitNew - introducedToday(counts), categoryIds, undefined, projection);
  const newCards = await Promise.all((await withNewWordSiblings(db, userObjectId, newDocs, projection)).map(p => withScheduler(p, profile)));
  return [...(await Promise.all(futureDocs.map(p => withScheduler(p, profile)))).map(p => ({ ...p, extraPractice: true })), ...selectStudyQueue(applyDailyLimit(newCards, limitNew), counts, now, 0, available, available >= limitNew - introducedToday(counts))];
}

export interface StudyQueueCounts { new: number; learning: number; review: number; total?: number; learned?: number; }
export async function loadStudyQueueCounts(
  { userId, itemType, context: category }: { userId: string; itemType?: string; context?: string },
  context: { user: User | null },
  prepared?: { now: Date; progress: Promise<UserProgress[]>; countersOnly?: boolean },
): Promise<StudyQueueCounts> {
  requireOwner(context, userId);
  if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
  const db = getDb(), id = new ObjectId(userId), now = prepared?.now ?? new Date();
  const catalogRequest = studyCatalog(context,itemType,false);
  const readIdentities = () => itemType === "PHRASE"
    ? catalogRequest.then(catalog => studyIdentities(context,id,catalog.phrases.map(relation=>relation._id)))
    : studyIdentities(context,id);
  const snapshotRequest = prepared
    ? Promise.all([studyMetadata(context,id),prepared.progress]).then(([account,progress])=>({...account,progress}))
    : studyCountSnapshot(context,id,now,itemType as UserProgress["itemType"] | undefined);
  const [{profile, progress: scoped, limit}, initialSeen, catalog, categoryIds, counts] = await Promise.all([
    snapshotRequest, prepared?.countersOnly ? undefined : readIdentities(), catalogRequest, categoryRelations(category,itemType,context), studyDailyCounts(context,id,now),
  ]);
  const categorySet = categoryIds === null ? null : new Set(categoryIds.map(String));
  const references = studyReferenceIds(catalog);
  const docs = scoped.filter(p => !p.suspended && !p.supersededByAnki && (!p.buriedUntil || p.buriedUntil<=now)
    && hasStudyReference(p, references)
    && (!itemType || p.itemType===itemType) && (!categorySet || categorySet.has(String(p.relationId)) || p.relationId === undefined && categorySet.has(String(p.itemId))));
  const guids = new Set(docs.filter(p=>p.itemType==="WORD" && p.card && isNewCard(p)).map(p=>p.card!.sourceNoteGuid));
  const present = new Set(docs.map(p=>String(p.itemId)));
  const siblings = scoped.filter(p=>p.itemType==="WORD" && !p.supersededByAnki && guids.has(p.card?.sourceNoteGuid) && !present.has(String(p.itemId)));
  const progress = await Promise.all([...docs,...siblings].map(p=>withScheduler(p,profile)));
  // Count unseen catalogue cards without creating progress merely by opening
  // the dashboard. Native words count both recognition and production.
  const hasPendingNew = docs.some(isNewCard);
  // Three entry counters need seen identities only when synthesizing unseen
  // catalog cards. Full GraphQL counts retain their mastery/total contract.
  const allSeen = initialSeen ?? (hasPendingNew ? [] : await readIdentities());
  const seen = new Set(allSeen.map(p=>String(p.relationId ?? p.itemId)));
  const candidates = [...progress];
  const makeNew = (relationId: ObjectId, type: "WORD" | "PHRASE"): UserProgress => {
    const p: UserProgress = {_id:relationId,userId:id,itemId:relationId,itemType:type,isNew:true,ease:2.5,interval:0,repetitions:0,nextDueDate:now,lastReviewed:null,createdAt:now};
    p.scheduler=initialScheduler(p,profile?.defaultOptions ?? DEFAULT_OPTIONS,profile?.timeZone ?? "Europe/Berlin",profile?.rollover ?? 4);return p;
  };
  if (!itemType || itemType === "WORD") {
    const relations=catalog.words.filter(r=>!categorySet || categorySet.has(String(r._id)));
    const pending=progress.filter(p=>p.itemType==="WORD" && !p.card && isNewCard(p));
    const needed=relations.filter(r=>!hasPendingNew && !seen.has(String(r._id)) || pending.some(p=>String(p.relationId??p.itemId)===String(r._id)));
    // Native introduction counts need endpoint existence and pair identity,
    // never the notes/examples returned later by actual study-card queries.
    const {wordsES:es,wordsDE:de}=needed.length ? await studyTextCatalog("WORD",db) : {wordsES:[],wordsDE:[]};
    const esMap=new Map(es.map(w=>[String(w._id),w] as const)),deMap=new Map(de.map(w=>[String(w._id),w] as const));
    for(const r of needed){const a=esMap.get(String(r.main)),b=deMap.get(String(r.translated));if(!a||!b)continue;const existing=pending.find(p=>String(p.relationId??p.itemId)===String(r._id));if(existing)candidates.splice(candidates.indexOf(existing),1);candidates.push(...nativeWordPair(existing??makeNew(r._id,"WORD"),a,b));}
  }
  if ((!itemType || itemType === "PHRASE") && !hasPendingNew) {
    const relations=catalog.phrases.filter(r=>!categorySet || categorySet.has(String(r._id)));
    candidates.push(...relations.filter(r=>!seen.has(String(r._id))).map(r=>makeNew(r._id,"PHRASE")));
  }
  const newCards = selectStudyQueue(applyDailyLimit(candidates, limit), counts, now, 0, Math.max(0, limit - introducedToday(counts)), true).filter(p=>p.scheduler.phase === "NEW").length;
  const summary = { new: newCards,
    learning: progress.filter(p=>!p.suspended && (!p.buriedUntil || p.buriedUntil<=now)).filter(p=>["LEARNING","RELEARNING"].includes(p.scheduler.phase) && p.nextDueDate.getTime() <= now.getTime() + (p.scheduler.queue === "MINUTE" ? p.scheduler.options.learnAheadSeconds * 1000 : 0)).length,
    review: progress.filter(p=>!p.suspended && (!p.buriedUntil || p.buriedUntil<=now)).filter(p=>p.scheduler.phase === "REVIEW" && effectiveDueDate(p) <= now).length };
  if (prepared?.countersOnly) return summary;
  const catalogIds: ObjectId[] = [];
  for (const type of ["WORD","PHRASE"]) if (!itemType || itemType === type) {
    const relations=type === "WORD" ? catalog.words : catalog.phrases;
    catalogIds.push(...relations.filter(r=>!categorySet || categorySet.has(String(r._id))).map(row=>row._id));
  }
  const learnedIds=new Set(allSeen.filter(p=>isGraduatedStudyCard(p) && (!itemType || p.itemType===itemType)).map(p=>String(p.relationId ?? p.itemId)));
  return { total: catalogIds.length, learned: catalogIds.filter(id=>learnedIds.has(String(id))).length, ...summary };
}

export const progressResolvers = {
  Query: {
    reviewHistory: async (_: unknown, { userId, itemId, limit = 50 }: { userId: string; itemId?: string; limit?: number }, context: { user: User | null }) => {
      requireOwner(context, userId);
      const query: any = { userId: new ObjectId(userId) };
      if (itemId) query.itemId = new ObjectId(itemId);
      const events = await getDb().reviewEvents.find(query).sort({ reviewedAt: -1 }).limit(Math.max(1, Math.min(500, limit))).toArray();
      return events.map(e => ({ reviewId: e.reviewId, itemId: e.itemId.toString(), grade: e.grade, reviewedAt: e.reviewedAt.toISOString(), reversedAt: e.reversedAt?.toISOString(), previousDueDate: e.before.nextDueDate.toISOString(), nextDueDate: e.after.nextDueDate.toISOString() }));
    },
    mostFailedWords: async (_: unknown, { userId, limit = 20, minFailures = 1 }: { userId: string; limit?: number; minFailures?: number }, context: { user: User | null }) => {
      requireOwner(context, userId);
      const db = getDb();
      const ranked = await db.progress.aggregate([
        { $match: { userId: new ObjectId(userId), itemType: "WORD" } },
        { $group: { _id: { $ifNull: ["$relationId", "$itemId"] }, failureIndex: { $sum: { $ifNull: ["$failureIndex", 0] } }, cards: { $push: "$$ROOT" } } },
        { $match: { failureIndex: { $gte: Math.max(1, minFailures) } } },
        { $sort: { failureIndex: -1, _id: 1 } },
        { $limit: Math.max(1, Math.min(500, limit)) },
      ]).toArray();
      const results = await Promise.all(ranked.map(async (row) => {
        const relation = await db.relationsWordsEsDe.findOne({ _id: row._id });
        return relation ? { wordRelation: { ...relation, id: relation._id.toString(), createdAt: relation.createdAt?.toISOString() }, failureIndex: row.failureIndex, cards: row.cards.map(toGraphQL) } : null;
      }));
      return results.filter(Boolean);
    },
    studyQueueCounts: async (_: unknown, args: {userId: string; itemType?: string; context?: string}, context: {user: User | null}) => loadStudyQueueCounts(args, context),

    dueItems: async (
      _: unknown,
      {
        userId,
        dueLimit = 50,
        newLimit = 1000,
        itemType, context: category,
        includeLearningAhead = false,
      }: { userId: string; dueLimit?: number; newLimit?: number; itemType?: string; context?: string; includeLearningAhead?: boolean },
      context: { user: User | null },
    ) => {
      return loadStudyRelations((await loadDueStudyProgress({ userId, dueLimit, newLimit, itemType, context: category, includeLearningAhead }, context)).map(toGraphQL));
    },

    studyMoreItems: async (
      _: unknown,
      {
        userId,
        limit = 20,
        itemType, context: category,
      }: { userId: string; limit?: number; itemType?: string; context?: string },
      context: { user: User | null },
    ) => {
      return loadStudyRelations((await loadMoreStudyProgress({ userId, limit, itemType, context: category }, context)).map(toGraphQL));
    },

    userProgress: async (
      _: unknown,
      { userId, itemId }: { userId: string; itemId: string },
      context: { user: User | null },
    ) => {
      requireOwner(context, userId);
      const db = getDb();
      const progress = await db.progress.findOne({
        userId: new ObjectId(userId),
        itemId: new ObjectId(itemId),
      });
      return toGraphQL(progress ? await withScheduler(progress) : null);
    },

    allProgress: async (
      _: unknown,
      { userId, itemType, relationIds }: { userId: string; itemType?: string; relationIds?: string[] | null },
      context: { user: User | null },
      info?: GraphQLResolveInfo,
    ) => {
      requireOwner(context, userId);
      if (relationIds != null) {
        if (relationIds.length > 500) throw new Error("At most 500 relation IDs may be requested");
        if (relationIds.some(id => !ObjectId.isValid(id))) throw new Error("Invalid relation ID");
        if (!relationIds.length) return [];
      }
      const db = getDb();
      const query: any = { userId: new ObjectId(userId) };
      if (itemType) query.itemType = itemType;
      if (relationIds != null) {
        const ids = [...new Set(relationIds)].map(id => new ObjectId(id));
        query.$or = [{ relationId: { $in: ids } }, { itemId: { $in: ids } }];
      }

      const summaryFields = new Set(['id','userId','itemId','relationId','itemType','ease','interval','repetitions','nextDueDate','lastReviewed','schedulerPhase','__typename']);
      const summary = info && [...selectedFields(info).values()].every(nodes => summaryFields.has(nodes[0].name.value));
      if (summary) {
        const includePhase = [...selectedFields(info).values()].some(nodes => nodes[0].name.value === 'schedulerPhase');
        const progress = await db.progress.find(query).project<UserProgress>({
          _id: 1, userId: 1, itemId: 1, relationId: 1, itemType: 1,
          ease: 1, interval: 1, repetitions: 1, nextDueDate: 1, temporaryDueDate: 1, lastReviewed: 1,
          ...(includePhase ? STUDY_STATUS_PROJECTION : {}),
        }).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray();
        return progress.map(row => ({...row, id: String(row._id), userId: String(row.userId),
          itemId: String(row.itemId), relationId: row.relationId?.toString(),
          ...(includePhase ? { schedulerPhase: normalizedStudyPhase(row) } : {}),
          nextDueDate: effectiveDueDate(row).toISOString(), lastReviewed: row.lastReviewed?.toISOString() ?? null}));
      }
      const progress = await db.progress.find(query).toArray();
      return progress.map(toGraphQL);
    },

    itemsCount: async (_: unknown, { itemType }: { itemType: string }) => {
      const db = getDb();
      if (itemType === "WORD") {
        return await db.relationsWordsEsDe.countDocuments();
      } else if (itemType === "PHRASE") {
        return await db.relationsPhrasesEsDe.countDocuments();
      }
      return 0;
    },

    learningPath: async (_: unknown, { userId }: { userId: string }, context: { user: User | null }) => {
      requireOwner(context, userId);
      const userObjectId = new ObjectId(userId);

      const [progresses, catalog] = await Promise.all([
        studyIdentities(context,userObjectId), studyCatalog(context),
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
          .filter(isGraduatedStudyCard)
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
    },
  },

  Mutation: {
    recordFailure: async (_: unknown, { userId, itemId, attemptId }: { userId: string; itemId: string; attemptId: string }, context: { user: User | null }) => {
      requireOwner(context, userId);
      return toGraphQL(await recordFailure(getDb().progress, new ObjectId(userId), new ObjectId(itemId), attemptId));
    },
    reviewItem: async (_: unknown, args: { userId: string; itemId: string; itemType: string; rating?: number; grade?: StudyGrade; failureAttemptId?: string; reviewId?: string; expectedVersion?: number; earlyReview?: boolean }, context: { user: User | null }) => {
      requireOwner(context, args.userId);
      try {
        // Old clients retain their 2..5 scale during rollout; new clients use
        // named grades and a persistent retry ID so the scales cannot mix.
        if (args.grade && (args.rating !== undefined && args.rating !== null || !args.reviewId || args.expectedVersion === undefined)) throw new Error("Named grades require a review ID and schedule version");
        const grade = args.grade ?? ({ 2: "AGAIN", 3: "HARD", 4: "GOOD", 5: "EASY" } as Record<number, Grade>)[args.rating];
        const result = await saveReview(new ObjectId(args.userId), new ObjectId(args.itemId), args.itemType, grade, args.reviewId ?? randomUUID(), args.expectedVersion, args.earlyReview ?? false, args.failureAttemptId);
        return { success: true, reviewId: result.reviewId, progress: toGraphQL(result.progress) };
      } catch (error) { return { success: false, progress: error instanceof ReviewConflict ? toGraphQL(error.progress) : null, errorCode: error instanceof ReviewConflict ? error.code : null, error: error instanceof Error ? error.message : "Review save failed" }; }
    },
    undoReview: async (_: unknown, { userId, reviewId }: { userId: string; reviewId: string }, context: { user: User | null }) => {
      requireOwner(context, userId);
      try {
        const result = await undoReview(new ObjectId(userId), reviewId);
        return { success: true, reviewId, progress: toGraphQL(result.progress) };
      } catch (error) { return { success: false, progress: null, error: error instanceof Error ? error.message : "Undo failed" }; }
    },
  },

  UserProgress: {
    reviewOptions: async (parent: any) => {
      const progress = await withScheduler({ ...parent, userId: new ObjectId(parent.userId), itemId: new ObjectId(parent.itemId), nextDueDate: new Date(parent.regularDueDate || parent.nextDueDate), temporaryDueDate: parent.temporaryDueDate ? new Date(parent.temporaryDueDate) : undefined, lastReviewed: parent.lastReviewed ? new Date(parent.lastReviewed) : null });
      return studyReviewOptions(progress, new Date(), !!parent.extraPractice);
    },
    wordRelation: async (parent: { itemId: string; relationId?: string; itemType: string; loadedWordRelation?: any }) => {
      if ("loadedWordRelation" in parent) return parent.loadedWordRelation;
      if (parent.itemType !== "WORD") return null;
      const db = getDb();
      const rel = await db.relationsWordsEsDe.findOne({
        _id: new ObjectId(parent.relationId || parent.itemId),
      });
      if (!rel) return null;
      return {
        ...rel,
        id: rel._id.toString(),
        createdAt: rel.createdAt?.toISOString(),
      };
    },
    phraseRelation: async (parent: { itemId: string; relationId?: string; itemType: string; loadedPhraseRelation?: any }) => {
      if ("loadedPhraseRelation" in parent) return parent.loadedPhraseRelation;
      if (parent.itemType !== "PHRASE") return null;
      const db = getDb();
      const rel = await db.relationsPhrasesEsDe.findOne({
        _id: new ObjectId(parent.relationId || parent.itemId),
      });
      if (!rel) return null;
      return {
        ...rel,
        id: rel._id.toString(),
        createdAt: rel.createdAt?.toISOString(),
      };
    },
  },
};
