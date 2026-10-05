import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { UserProgress } from "./progress.types.js";
import { recordFailure } from "./failures.js";
import { User } from "../auth/auth.types.js";
import { randomUUID } from "node:crypto";
import { saveReview, undoReview, withScheduler, dailyCounts, ReviewConflict } from "./reviews.js";
import { initialScheduler, reviewOptions, studyDay, Grade } from "./scheduler.js";
import { selectStudyQueue } from "./studyQueue.js";
import { isNewCard, newCardGroups } from "./newWordOrder.js";
import { ensureNativeWordPairs } from "./nativeWordPairs.js";

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
    schedulerPhase: (progress.scheduler ?? initialScheduler(progress)).phase,
    learningQueue: (progress.scheduler ?? initialScheduler(progress)).queue,
    learnAheadSeconds: (progress.scheduler ?? initialScheduler(progress)).options.learnAheadSeconds,
    lapses: progress.lapses ?? 0,
    lastFailedAt: progress.lastFailedAt?.toISOString() ?? null,
    nextDueDate: progress.nextDueDate.toISOString(),
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
): Promise<UserProgress[]> {
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
    _id: { $nin: [...reviewedSet].map((id) => new ObjectId(id)) },
  };

  const pendingQuery: any = { userId: userObjectId, isNew: true, suspended: { $ne: true }, supersededByAnki: { $ne: true }, $or: [{ buriedUntil: null }, { buriedUntil: { $lte: new Date() } }] };
  if (itemType) pendingQuery.itemType = itemType;
  const candidates = await ensureNativeWordPairs(await db.progress.find(pendingQuery).sort({ "anki.due": 1 }).toArray());
  const complete = await withNewWordSiblings(db, userObjectId, candidates);
  const pending: UserProgress[] = [];
  for (const group of newCardGroups(complete, candidates)) if (pending.length + group.length <= needed) pending.push(...group);
  if (candidates.length >= needed) return pending;
  needed -= pending.length;
  if (needed <= 0) return pending;
  const newProgressDocs: UserProgress[] = [];

  if (!itemType || itemType === "WORD") {
    const neededWords = Math.floor((itemType === "WORD" ? needed : Math.ceil(needed / 2)) / 2);
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
      itemType === "PHRASE" ? needed : needed - newProgressDocs.length * 2;
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
    for (const doc of docsToAdd) {
      try { await db.progress.updateOne({ userId: doc.userId, itemId: doc.itemId, itemType: doc.itemType }, { $setOnInsert: doc }, { upsert: true }); }
      catch (error: any) { if (error.code !== 11000) throw error; }
    }
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
    dueItems: async (
      _: unknown,
      {
        userId,
        dueLimit = 50,
        newLimit = 10,
        itemType,
      }: { userId: string; dueLimit?: number; newLimit?: number; itemType?: string },
      context: { user: User | null },
    ) => {
      requireOwner(context, userId);
      const db = getDb();
      const now = new Date();
      const userObjectId = new ObjectId(userId);

      if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
      dueLimit = Math.max(0, Math.min(500, dueLimit));
      newLimit = Math.max(0, Math.min(100, newLimit));
      if (!dueLimit && !newLimit) return [];
      const profile = await db.schedulerProfiles.findOne({ _id: userObjectId });
      const query: any = { userId: userObjectId, suspended: { $ne: true }, supersededByAnki: { $ne: true },
        $or: [{ nextDueDate: { $lte: new Date(now.getTime() + 1200000) } }, { isNew: true }] };
      if (itemType) query.itemType = itemType;
      let docs = await db.progress.find(query).toArray();
      if (newLimit > 0) {
        const fresh = await fetchNewItems(db, userObjectId, newLimit, itemType);
        const seen = new Set(docs.map(p => p.itemId.toString()));
        docs.push(...fresh.filter(p => !seen.has(p.itemId.toString())));
      }
      docs = await Promise.all((await withNewWordSiblings(db, userObjectId, await ensureNativeWordPairs(docs))).map(p => withScheduler(p, profile)));
      const counts = await dailyCounts(userObjectId, studyDay(now, profile?.timeZone ?? "Europe/Berlin", profile?.rollover ?? 4), profile);
      return selectStudyQueue(docs, counts, now, dueLimit, newLimit).map(toGraphQL);
    },

    studyMoreItems: async (
      _: unknown,
      {
        userId,
        limit = 20,
        itemType,
      }: { userId: string; limit?: number; itemType?: string },
      context: { user: User | null },
    ) => {
      requireOwner(context, userId);
      if (itemType && !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid card type");
      limit = Math.max(0, Math.min(500, limit));
      if (!limit) return [];
      const db = getDb();
      const now = new Date();
      const userObjectId = new ObjectId(userId);

      // 1) Fetch future-due items (nextDueDate > now), closest first
      const futureQuery: any = {
        userId: userObjectId,
        nextDueDate: { $gt: now },
        isNew: { $ne: true }, suspended: { $ne: true }, supersededByAnki: { $ne: true },
        $or: [{ buriedUntil: null }, { buriedUntil: { $lte: now } }],
      };
      if (itemType) futureQuery.itemType = itemType;

      const futureDueLimit = Math.ceil(limit * 0.7);

      const futureDocs = await db.progress
        .find(futureQuery)
        .sort({ nextDueDate: 1 })
        .limit(futureDueLimit)
        .toArray();

      // 2) Fill remaining with new unseen items
      const remaining = limit - futureDocs.length;
      let newDocs: UserProgress[] = [];
      if (remaining > 0) {
        newDocs = await fetchNewItems(db, userObjectId, remaining, itemType);
      }

      const profile = await db.schedulerProfiles.findOne({ _id: userObjectId });
      return (await Promise.all([...futureDocs, ...newDocs].map(p => withScheduler(p, profile)))).map(p => ({ ...toGraphQL(p), extraPractice: true }));
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
      const db = getDb();
      const userObjectId = new ObjectId(userId);

      // ── Fetch RELATIONS (same collections used by dueItems) ──
      // Progress.itemId stores the relation _id, so we must iterate
      // over relations and join to the main word/phrase for context/level.
      const wordRelations = await db.relationsWordsEsDe.find({}).toArray();
      const phraseRelations = await db.relationsPhrasesEsDe.find({}).toArray();

      // Build lookup maps: main word/phrase _id → { contexts[], level }
      const mainWordIds = wordRelations.map((wr) => wr.main);
      const mainPhraseIds = phraseRelations.map((pr) => pr.main);

      const wordsLookup = await db.wordsES
        .find({ _id: { $in: mainWordIds } })
        .project({ _id: 1, contexts: 1, level: 1 })
        .toArray();
      const phrasesLookup = await db.phrasesES
        .find({ _id: { $in: mainPhraseIds } })
        .project({ _id: 1, contexts: 1, level: 1 })
        .toArray();

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

      // ── Fetch user progress (itemId = relation _id) ──
      const progresses = await db.progress
        .find({ userId: userObjectId })
        .toArray();
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
    reviewItem: async (_: unknown, args: { userId: string; itemId: string; itemType: string; rating?: number; grade?: Grade; reviewId?: string; expectedVersion?: number; earlyReview?: boolean }, context: { user: User | null }) => {
      requireOwner(context, args.userId);
      try {
        // Old clients retain their 2..5 scale during rollout; new clients use
        // named grades and a persistent retry ID so the scales cannot mix.
        if (args.grade && (args.rating !== undefined && args.rating !== null || !args.reviewId || args.expectedVersion === undefined)) throw new Error("Named grades require a review ID and schedule version");
        const grade = args.grade ?? ({ 2: "AGAIN", 3: "HARD", 4: "GOOD", 5: "EASY" } as Record<number, Grade>)[args.rating];
        const result = await saveReview(new ObjectId(args.userId), new ObjectId(args.itemId), args.itemType, grade, args.reviewId ?? randomUUID(), args.expectedVersion, args.earlyReview ?? false);
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
      const progress = await withScheduler({ ...parent, userId: new ObjectId(parent.userId), itemId: new ObjectId(parent.itemId), nextDueDate: new Date(parent.nextDueDate), lastReviewed: parent.lastReviewed ? new Date(parent.lastReviewed) : null });
      return reviewOptions(progress, new Date(), !!parent.extraPractice);
    },
    wordRelation: async (parent: { itemId: string; relationId?: string; itemType: string }) => {
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
    phraseRelation: async (parent: { itemId: string; relationId?: string; itemType: string }) => {
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
