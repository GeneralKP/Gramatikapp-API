import { loadStudyRelations, studyCountSnapshot, studyIdentities, studyDailyCounts, studyCatalog, studyMetadata, insertNewProgress, STUDY_CONTENT_BATCH_SIZE } from "./studyLoading.js";
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

async function withNewWordSiblings(db: ReturnType<typeof getDb>, userId: ObjectId, progress: UserProgress[]) {
  const guids = [...new Set(progress.filter(p => p.itemType === "WORD" && p.card && isNewCard(p)).map(p => p.card!.sourceNoteGuid))];
  if (!guids.length) return progress;
  // Include recognition even when it is buried or scheduled in the future: it
  // supplies prerequisite state, without making it due or changing its schedule.
  const siblings = await db.progress.find({ userId, itemType: "WORD", "card.sourceNoteGuid": { $in: guids }, supersededByAnki: { $ne: true } }).toArray();
  const seen = new Set(progress.map(p => p.itemId.toString()));
  return [...progress, ...siblings.filter(p => !seen.has(p.itemId.toString()))];
}

async function fetchNewItems(
  db: ReturnType<typeof getDb>,
  userObjectId: ObjectId,
  needed: number,
  itemType?: string,
  category?: string,
  allowPartialIntroduction = false,
  selectedCategoryIds?: ObjectId[] | null,
  phraseProgress?: UserProgress[],
): Promise<UserProgress[]> {
  const categoryIds = selectedCategoryIds === undefined ? await categoryRelations(category, itemType) : selectedCategoryIds;
  const pendingQuery: any = { ...categoryProgressFilter(categoryIds), userId: userObjectId, isNew: true, suspended: { $ne: true }, supersededByAnki: { $ne: true }, $or: [{ buriedUntil: null }, { buriedUntil: { $lte: new Date() } }] };
  if (itemType) pendingQuery.itemType = itemType;
  // The phrase due query already includes every pending phrase, including future
  // ones. Reuse it without allocating, dropping or reordering any new-card group.
  const candidates = itemType === "PHRASE" && phraseProgress
    ? phraseProgress.filter(p => p.isNew === true && !p.suspended && !p.supersededByAnki && (!p.buriedUntil || p.buriedUntil <= new Date()))
    : await ensureNativeWordPairs(await db.progress.find(pendingQuery).sort({ "anki.due": 1 }).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray());
  const complete = await withNewWordSiblings(db, userObjectId, candidates);
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
    studyQueueCounts: async (_: unknown, {userId, itemType, context: category}: {userId: string; itemType?: string; context?: string}, context: {user: User | null}) => {
      requireOwner(context, userId);
      if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
      const db = getDb(), id = new ObjectId(userId), now = new Date();
      const catalogRequest = studyCatalog(context,itemType,false);
      const identityRequest = itemType === "PHRASE"
        ? catalogRequest.then(catalog => studyIdentities(context,id,catalog.phrases.map(relation=>relation._id)))
        : studyIdentities(context,id);
      const [{profile, progress: scoped, limit}, allSeen, catalog, categoryIds, counts] = await Promise.all([
        studyCountSnapshot(context,id,now,itemType as UserProgress["itemType"] | undefined), identityRequest, catalogRequest, categoryRelations(category,itemType,context), studyDailyCounts(context,id,now),
      ]);
      const categorySet = categoryIds === null ? null : new Set(categoryIds.map(String));
      const docs = scoped.filter(p => !p.suspended && !p.supersededByAnki && (!p.buriedUntil || p.buriedUntil<=now)
        && (!itemType || p.itemType===itemType) && (!categorySet || categorySet.has(String(p.relationId)) || p.relationId === undefined && categorySet.has(String(p.itemId))));
      const guids = new Set(docs.filter(p=>p.itemType==="WORD" && p.card && isNewCard(p)).map(p=>p.card!.sourceNoteGuid));
      const present = new Set(docs.map(p=>String(p.itemId)));
      const siblings = scoped.filter(p=>p.itemType==="WORD" && !p.supersededByAnki && guids.has(p.card?.sourceNoteGuid) && !present.has(String(p.itemId)));
      const progress = await Promise.all([...docs,...siblings].map(p=>withScheduler(p,profile)));
      // Count unseen catalogue cards without creating progress merely by opening
      // the dashboard. Native words count both recognition and production.
      const seen = new Set(allSeen.map(p=>String(p.relationId ?? p.itemId)));
      const hasPendingNew = docs.some(isNewCard);
      const candidates = [...progress];
      const makeNew = (relationId: ObjectId, type: "WORD" | "PHRASE"): UserProgress => {
        const p: UserProgress = {_id:relationId,userId:id,itemId:relationId,itemType:type,isNew:true,ease:2.5,interval:0,repetitions:0,nextDueDate:now,lastReviewed:null,createdAt:now};
        p.scheduler=initialScheduler(p,profile?.defaultOptions ?? DEFAULT_OPTIONS,profile?.timeZone ?? "Europe/Berlin",profile?.rollover ?? 4);return p;
      };
      if (!itemType || itemType === "WORD") {
        const relations=catalog.words.filter(r=>!categorySet || categorySet.has(String(r._id)));
        const pending=progress.filter(p=>p.itemType==="WORD" && !p.card && isNewCard(p));
        const needed=relations.filter(r=>!hasPendingNew && !seen.has(String(r._id)) || pending.some(p=>String(p.relationId??p.itemId)===String(r._id)));
        const [es,de]=await Promise.all([needed.length ? db.wordsES.find({_id:{$in:needed.map(r=>r.main)}}).toArray() : [],needed.length ? db.wordsDE.find({_id:{$in:needed.map(r=>r.translated)}}).toArray() : []]);
        const esMap=new Map(es.map(w=>[String(w._id),w] as const)),deMap=new Map(de.map(w=>[String(w._id),w] as const));
        for(const r of needed){const a=esMap.get(String(r.main)),b=deMap.get(String(r.translated));if(!a||!b)continue;const existing=pending.find(p=>String(p.relationId??p.itemId)===String(r._id));if(existing)candidates.splice(candidates.indexOf(existing),1);candidates.push(...nativeWordPair(existing??makeNew(r._id,"WORD"),a,b));}
      }
      if ((!itemType || itemType === "PHRASE") && !hasPendingNew) {
        const relations=catalog.phrases.filter(r=>!categorySet || categorySet.has(String(r._id)));
        candidates.push(...relations.filter(r=>!seen.has(String(r._id))).map(r=>makeNew(r._id,"PHRASE")));
      }
      const newCards = selectStudyQueue(applyDailyLimit(candidates, limit), counts, now, 0, Math.max(0, limit - introducedToday(counts)), true).filter(p=>p.scheduler.phase === "NEW").length;
      const catalogIds: ObjectId[] = [];
      for (const type of ["WORD","PHRASE"]) if (!itemType || itemType === type) {
        const relations=type === "WORD" ? catalog.words : catalog.phrases;
        catalogIds.push(...relations.filter(r=>!categorySet || categorySet.has(String(r._id))).map(row=>row._id));
      }
      const learnedIds=new Set(allSeen.filter(p=>p.repetitions>0 && (!itemType || p.itemType===itemType)).map(p=>String(p.relationId ?? p.itemId)));
      return { total: catalogIds.length, learned: catalogIds.filter(id=>learnedIds.has(String(id))).length, new: newCards,
        learning: progress.filter(p=>!p.suspended && (!p.buriedUntil || p.buriedUntil<=now)).filter(p=>["LEARNING","RELEARNING"].includes(p.scheduler.phase) && p.nextDueDate.getTime() <= now.getTime() + (p.scheduler.queue === "MINUTE" ? p.scheduler.options.learnAheadSeconds * 1000 : 0)).length,
        review: progress.filter(p=>!p.suspended && (!p.buriedUntil || p.buriedUntil<=now)).filter(p=>p.scheduler.phase === "REVIEW" && effectiveDueDate(p) <= now).length };
    },
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
      requireOwner(context, userId);
      const db = getDb();
      const now = new Date();
      const userObjectId = new ObjectId(userId);

      if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
      dueLimit = Math.max(0, Math.min(5000, dueLimit));
      const categoryRequest = dueLimit ? categoryRelations(category, itemType, context) : Promise.resolve(null);
      const readDue = (categoryIds: ObjectId[] | null) => {
        const query: any = { ...categoryProgressFilter(categoryIds), userId: userObjectId, suspended: { $ne: true }, supersededByAnki: { $ne: true },
          $or: [{ temporaryDueDate: { $lte: now } }, { temporaryDueDate: null, nextDueDate: { $lte: new Date(now.getTime() + 1200000) } }, { isNew: true }] };
        if (itemType) query.itemType = itemType;
        return db.progress.find(query).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray();
      };
      const [{limit, profile}, counts, selectedCategoryIds, existing] = await Promise.all([
        studyMetadata(context,userObjectId), studyDailyCounts(context,userObjectId,now), categoryRequest,
        dueLimit ? categoryRequest.then(readDue) : null,
      ]);
      newLimit = Math.max(0, Math.min(1000, newLimit, limit - introducedToday(counts)));
      if (!dueLimit && !newLimit) return [];
      const categoryIds = dueLimit ? selectedCategoryIds : await categoryRelations(category, itemType, context);
      let docs = existing ?? await readDue(categoryIds);
      if (newLimit > 0) {
        const fresh = await fetchNewItems(db, userObjectId, newLimit, itemType, category, newLimit >= limit - introducedToday(counts), categoryIds, itemType === "PHRASE" ? docs : undefined);
        const seen = new Set(docs.map(p => p.itemId.toString()));
        docs.push(...fresh.filter(p => !seen.has(p.itemId.toString())));
      }
      docs = await Promise.all((await withNewWordSiblings(db, userObjectId, await ensureNativeWordPairs(docs))).map(p => withScheduler(p, profile)));
      const selected = selectStudyQueue(applyDailyLimit(docs, limit), counts, now, dueLimit, newLimit, newLimit >= limit - introducedToday(counts));
      const selectedIds = new Set(selected.map(p=>String(p.itemId)));
      const ahead = includeLearningAhead ? docs.filter(p=>!selectedIds.has(String(p.itemId)) && !p.suspended && (!p.buriedUntil || p.buriedUntil<=now) && p.scheduler.queue === "MINUTE" && p.nextDueDate>now && p.nextDueDate.getTime()<=now.getTime()+p.scheduler.options.learnAheadSeconds*1000) : [];
      return loadStudyRelations([...selected,...ahead].map(toGraphQL));
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
      requireOwner(context, userId);
      if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
      limit = Math.max(0, Math.min(500, limit));
      if (!limit) return [];
      const db = getDb();
      const now = new Date();
      const userObjectId = new ObjectId(userId);

      const [{profile, limit: limitNew}, categoryIds] = await Promise.all([
        studyMetadata(context,userObjectId), categoryRelations(category,itemType,context),
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

      const futureDueLimit = Math.ceil(limit * 0.7);

      const [futureDocs, counts] = await Promise.all([
        db.progress.find(futureQuery).sort({ nextDueDate: 1 }).limit(futureDueLimit).toArray(),
        countsPromise,
      ]);

      // Extra practice never bypasses the account's daily new-card allowance.
      const remaining = limit - futureDocs.length;
      let newDocs: UserProgress[] = [];
      const available = Math.max(0, Math.min(remaining, limitNew - introducedToday(counts)));
      if (available > 0) newDocs = await fetchNewItems(db, userObjectId, available, itemType, category, available >= limitNew - introducedToday(counts), categoryIds);
      const newCards = await Promise.all((await withNewWordSiblings(db, userObjectId, newDocs)).map(p => withScheduler(p, profile)));
      return loadStudyRelations([...(await Promise.all(futureDocs.map(p => withScheduler(p, profile)))).map(p => ({ ...toGraphQL(p), extraPractice: true })), ...selectStudyQueue(applyDailyLimit(newCards, limitNew), counts, now, 0, available, available >= limitNew - introducedToday(counts)).map(toGraphQL)]);
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
      { userId, itemType }: { userId: string; itemType?: string },
      context: { user: User | null },
    ) => {
      requireOwner(context, userId);
      const db = getDb();
      const query: any = { userId: new ObjectId(userId) };
      if (itemType) query.itemType = itemType;

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
          .filter((p) => p.repetitions > 0)
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
