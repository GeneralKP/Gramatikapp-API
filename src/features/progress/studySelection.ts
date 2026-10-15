import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { requireUserId, type AuthContext } from "../auth/auth.context.js";
import type { UserProgress } from "./progress.types.js";
import { summarizedStudyCounts, studyIdentities, studyDailyCounts, studyCatalog, studyMetadata, insertNewProgress, STUDY_CONTENT_BATCH_SIZE, STUDY_SUMMARY_BATCH_SIZE } from "./studyLoading.js";
import { isGraduatedStudyIdentity, newItemIdentityPipeline, unpackNewItemIdentities, type PackedNewItemIdentity } from "./studySummaries.js";
import { withScheduler, dailyCounts } from "./reviews.js";
import { effectiveDueDate, isAgainPending } from "./studyScheduling.js";
import { categoryRelations, categoryProgressFilter } from "./categories.js";
import { DEFAULT_OPTIONS, initialScheduler, studyDay } from "./scheduler.js";
import { selectStudyQueue } from "./studyQueue.js";
import { isNewCard, newCardGroups } from "./newWordOrder.js";
import { nativeWordPair, ensureNativeWordPairs } from "./nativeWordPairs.js";
import { introducedToday, applyDailyLimit } from "./dailyLimit.js";
import { studyTextCatalog } from "./studyTextCatalog.js";
import { studyCurriculum, planCurriculumIntroductions } from "./studyCurriculum.js";
import { AGAIN_PENDING_FILTER, isDueStudyCandidate, hasStudyReference, studyReferenceIds } from "./studyCandidates.js";
import { readPackedStudyCandidates } from "./studyCandidatePacking.js";

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
    siblings = missing.length < 2 ? missing : await readPackedStudyCandidates(db.progress, query, projection, STUDY_CONTENT_BATCH_SIZE);
  } else {
    siblings = await db.progress.find(query).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray();
  }
  const seen = new Set(progress.map(p => p.itemId.toString()));
  return [...progress, ...siblings.filter(p => !seen.has(p.itemId.toString()))];
}

async function freshPendingRows(db: ReturnType<typeof getDb>, query: object, projection?: Record<string, number>, existing?: UserProgress[]) {
  if (!projection || !existing) return projection
    ? readPackedStudyCandidates(db.progress, query, projection, STUDY_CONTENT_BATCH_SIZE)
    : db.progress.find(query).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray();
  // A compact freshness probe avoids transferring scheduling/content twice in
  // starter/full queues. Identity, versions and update/deferral state must match;
  // missing or changed cards fall back to a complete fresh pending read.
  const rows = await db.progress.find(query).project<UserProgress>({ _id: 0, itemId: 1, itemType: 1, relationId: 1,
    scheduleVersion: 1, failureVersion: 1, failureIndex: 1, articleFailureIndex: 1, articleFailureAttemptIds: 1, againPending: 1, updatedAt: 1, buriedUntil: 1, suspended: 1, supersededByAnki: 1, isNew: 1,
    "card.sourceCardId": 1, "card.sourceNoteGuid": 1, "card.direction": 1 }).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray();
  const byId = new Map(existing.map(p => [String(p.itemId), p]));
  const same = (a: unknown, b: unknown) => a instanceof Date && b instanceof Date ? +a === +b : String(a) === String(b);
  const keys = ['itemType', 'relationId', 'scheduleVersion', 'failureVersion', 'failureIndex', 'articleFailureIndex', 'articleFailureAttemptIds', 'againPending', 'updatedAt', 'buriedUntil', 'suspended', 'supersededByAnki', 'isNew'] as const;
  if (rows.every(row => {
    const previous = byId.get(String(row.itemId));
    return previous && keys.every(key => same(row[key], previous[key])) && !!row.card === !!previous.card
      && (['sourceCardId', 'sourceNoteGuid', 'direction'] as const).every(key => same(row.card?.[key], previous.card?.[key]));
  })) return rows.map(row => byId.get(String(row.itemId))!);
  return readPackedStudyCandidates(db.progress, query, projection, STUDY_CONTENT_BATCH_SIZE);
}

async function fetchNewItems(
  db: ReturnType<typeof getDb>, userObjectId: ObjectId, needed: number,
  itemType?: string, category?: string, allowPartialIntroduction = false,
  selectedCategoryIds?: ObjectId[] | null, existingProgress?: UserProgress[],
  projection?: Record<string, number>,
): Promise<UserProgress[]> {
  const categoryIds = selectedCategoryIds === undefined ? await categoryRelations(category, itemType) : selectedCategoryIds;
  const categorySet = categoryIds === null ? null : new Set(categoryIds.map(String));
  const pendingQuery: any = { ...categoryProgressFilter(categoryIds), userId: userObjectId, isNew: true,
    suspended: { $ne: true }, supersededByAnki: { $ne: true },
    $or: [{ buriedUntil: null }, { buriedUntil: { $lte: new Date() } }] };
  const identityQuery: any = { userId: userObjectId };
  if (itemType) { pendingQuery.itemType = itemType; identityQuery.itemType = itemType; }
  // Only immutable catalog order is cached. Read owner identities and pending
  // state afresh so another device, a deferral or an import cannot skip a level.
  const [curriculum, identities, pendingRows] = await Promise.all([
    studyCurriculum({}, itemType),
    db.progress.aggregate<PackedNewItemIdentity>(newItemIdentityPipeline(identityQuery)).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray().then(unpackNewItemIdentities),
    freshPendingRows(db, pendingQuery, projection, existingProgress),
  ]);
  const seen = new Set(identities.map(p => `${p.itemType}:${p.relationId ?? p.itemId}`));
  const valid = new Set(curriculum.entries.map(entry => `${entry.type}:${entry.relation._id}`));
  const candidates = pendingRows.filter(p => p.card || valid.has(`${p.itemType}:${p.relationId ?? p.itemId}`));
  const complete = await withNewWordSiblings(db, userObjectId, candidates, projection);
  const groups = newCardGroups(complete, candidates, curriculum.compare);
  const unseen = curriculum.entries.filter(entry => !seen.has(`${entry.type}:${entry.relation._id}`)
    && (!categorySet || categorySet.has(String(entry.relation._id))));
  const plan = planCurriculumIntroductions(groups, unseen, needed, allowPartialIntroduction, curriculum.rank);
  const pending = plan.pending;
  const allocated: UserProgress[] = plan.entries.map(entry => ({ _id: new ObjectId(), userId: userObjectId, itemId: entry.relation._id,
    itemType: entry.type, failureIndex: 0, isNew: true, ease: 2.5, interval: 0,
    repetitions: 0, nextDueDate: new Date(), lastReviewed: null, createdAt: new Date() }));
  // Selected IDs are already validated bilingual relations. Bounded indexed
  // hydration replaces request-time catalog joins, sorts and growing $nin lists.
  const persisted: UserProgress[] = [];
  if (allocated.length) {
    await insertNewProgress(allocated, db);
    persisted.push(...await db.progress.find({ userId: userObjectId, itemId: { $in: allocated.map(p => p.itemId) } }).toArray());
  }
  // Pair only selected legacy introductions, rather than converting every
  // later-level pending word while a small starter queue is being requested.
  const paired = await ensureNativeWordPairs([...pending, ...persisted]);
  return newCardGroups([...complete, ...paired], paired, curriculum.compare).flat();
}

export interface DueStudyRequest { userId: string; dueLimit?: number; newLimit?: number; itemType?: string; context?: string; includeLearningAhead?: boolean; }
/** Shared selection: transport hydration never changes allowances, ordering or pairing. */
export async function loadDueStudyProgress(
  { userId, dueLimit = 50, newLimit = 1000, itemType, context: category, includeLearningAhead = false }: DueStudyRequest,
  context: AuthContext, projection?: Record<string, number>,
  prepared?: { now: Date; candidates?: Promise<UserProgress[]>; beforeNewItems?: Promise<unknown> },
): Promise<UserProgress[]> {
  requireUserId(context, userId);
  const db = getDb();
  const now = prepared?.now ?? new Date();
  const userObjectId = new ObjectId(userId);

  if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
  dueLimit = Math.max(0, Math.min(5000, dueLimit));
  newLimit = Math.max(0, Math.min(1000, newLimit));
  if (!dueLimit && !newLimit) return [];
  const categoryRequest = dueLimit ? categoryRelations(category, itemType, context) : Promise.resolve(null);
  const readDue = (categoryIds: ObjectId[] | null) => {
    if (prepared?.candidates) {
      const categorySet = categoryIds === null ? null : new Set(categoryIds.map(String));
      return prepared.candidates.then(rows => rows.filter(p => isDueStudyCandidate(p, now, categorySet)));
    }
    const query: any = { ...categoryProgressFilter(categoryIds), userId: userObjectId, suspended: { $ne: true }, supersededByAnki: { $ne: true },
      $or: [AGAIN_PENDING_FILTER, { temporaryDueDate: { $lte: now } }, { temporaryDueDate: null, nextDueDate: { $lte: new Date(now.getTime() + 1200000) } }, { isNew: true }] };
    if (itemType) query.itemType = itemType;
    return projection ? readPackedStudyCandidates(db.progress, query, projection, STUDY_SUMMARY_BATCH_SIZE)
      : db.progress.find(query).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray();
  };
  const [{limit, profile}, counts, selectedCategoryIds, existing, catalog, curriculum] = await Promise.all([
    studyMetadata(context,userObjectId), studyDailyCounts(context,userObjectId,now), categoryRequest,
    dueLimit ? categoryRequest.then(readDue) : null,
    studyCatalog(context, itemType, false), studyCurriculum(context, itemType),
  ]);
  newLimit = Math.max(0, Math.min(1000, newLimit, limit - introducedToday(counts)));
  if (!dueLimit && !newLimit) return [];
  const categoryIds = dueLimit ? selectedCategoryIds : await categoryRelations(category, itemType, context);
  const references = studyReferenceIds(catalog);
  let docs = (existing ?? await readDue(categoryIds)).filter(p => hasStudyReference(p, references) && (p.card || curriculum.has(p)));
  if (newLimit > 0) {
    // Combined counters capture unseen identities before this request can
    // allocate progress. Existing pending/late sibling checks remain fresh.
    if (prepared?.beforeNewItems) await prepared.beforeNewItems;
    const fresh = await fetchNewItems(db, userObjectId, newLimit, itemType, category, newLimit >= limit - introducedToday(counts), categoryIds, docs, projection);
    // Pending NEW state was revalidated above. Replace the earlier snapshot
    // instead of keeping a stale card introduced/deferred by another device.
    docs = docs.filter(p => !isNewCard(p));
    const seen = new Set(docs.map(p => p.itemId.toString()));
    docs.push(...fresh.filter(p => !seen.has(p.itemId.toString())));
  }
  docs = await Promise.all((await withNewWordSiblings(db, userObjectId, await ensureNativeWordPairs(docs), projection)).map(p => withScheduler(p, profile)));
  const selected = selectStudyQueue(applyDailyLimit(docs, limit), counts, now, dueLimit, newLimit, newLimit >= limit - introducedToday(counts), curriculum?.compare);
  const selectedIds = new Set(selected.map(p=>String(p.itemId)));
  const ahead = includeLearningAhead ? docs.filter(p=>!selectedIds.has(String(p.itemId)) && !p.suspended && (!p.buriedUntil || p.buriedUntil<=now) && p.scheduler.queue === "MINUTE" && p.nextDueDate>now && p.nextDueDate.getTime()<=now.getTime()+p.scheduler.options.learnAheadSeconds*1000) : [];
  return [...selected,...ahead];
}

export async function loadMoreStudyProgress(
  { userId, limit = 20, itemType, context: category }: { userId: string; limit?: number; itemType?: string; context?: string },
  context: AuthContext, projection?: Record<string, number>,
): Promise<UserProgress[]> {
  requireUserId(context, userId);
  if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
  limit = Math.max(0, Math.min(500, limit));
  if (!limit) return [];
  const db = getDb();
  const now = new Date();
  const userObjectId = new ObjectId(userId);

  const [{profile, limit: limitNew}, categoryIds, catalog, curriculum] = await Promise.all([
    studyMetadata(context,userObjectId), categoryRelations(category,itemType,context),
    studyCatalog(context, itemType, false), studyCurriculum(context, itemType),
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
    ...([['WORD', curriculum.entries.filter(e => e.type === 'WORD').map(e => e.relation)], ['PHRASE', curriculum.entries.filter(e => e.type === 'PHRASE').map(e => e.relation)]] as const).map(([type, rows]) => ({
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
  return [...(await Promise.all(futureDocs.map(p => withScheduler(p, profile)))).map(p => ({ ...p, extraPractice: true })), ...selectStudyQueue(applyDailyLimit(newCards, limitNew), counts, now, 0, available, available >= limitNew - introducedToday(counts), curriculum?.compare)];
}

export interface StudyQueueCounts { new: number; learning: number; review: number; total?: number; learned?: number; }
export async function loadStudyQueueCounts(
  { userId, itemType, context: category }: { userId: string; itemType?: string; context?: string },
  context: AuthContext,
  prepared?: { now: Date; progress: Promise<UserProgress[]>; countersOnly?: boolean },
): Promise<StudyQueueCounts> {
  requireUserId(context, userId);
  if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
  const db = getDb(), id = new ObjectId(userId), now = prepared?.now ?? new Date();
  const curriculumRequest = studyCurriculum(context, itemType);
  const catalogRequest = curriculumRequest.then(curriculum => ({
    words: curriculum.entries.filter(e => e.type === "WORD").map(e => e.relation),
    phrases: curriculum.entries.filter(e => e.type === "PHRASE").map(e => e.relation),
  }));
  const readIdentities = () => itemType === "PHRASE"
    ? catalogRequest.then(catalog => studyIdentities(context,id,catalog.phrases.map(relation=>relation._id)))
    : studyIdentities(context,id);
  const categoryRequest = categoryRelations(category,itemType,context);
  const snapshotRequest = prepared
    ? Promise.all([studyMetadata(context,id),prepared.progress]).then(([account,progress])=>({...account,progress,summary:{review:0,learning:0}}))
    : Promise.all([catalogRequest,categoryRequest]).then(([catalog,categoryIds])=>summarizedStudyCounts(context,id,now,itemType as UserProgress['itemType'] | undefined,catalog,categoryIds,category));
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
  const progress = await Promise.all([...docs,...siblings].map(p=>withScheduler(p,profile)));
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
    const identities = initialSeen ?? await db.progress.aggregate<PackedNewItemIdentity>(newItemIdentityPipeline({ userId: id, ...(itemType ? { itemType } : {}) })).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray().then(unpackNewItemIdentities);
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
    learning: ready.learning + progress.filter(p=>!p.suspended && (!p.buriedUntil || p.buriedUntil<=now)).filter(p=>["LEARNING","RELEARNING"].includes(p.scheduler.phase) && (isAgainPending(p) || effectiveDueDate(p) <= now)).length,
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
