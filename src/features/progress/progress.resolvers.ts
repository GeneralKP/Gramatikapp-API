import { ObjectId } from "mongodb";
import type { GraphQLResolveInfo } from "graphql";
import { randomUUID } from "node:crypto";
import { getDb } from "../../lib/database.js";
import { requireUserId, type AuthContext } from "../auth/auth.context.js";
import type { UserProgress } from "./progress.types.js";
import { recordFailure } from "./failures.js";
import { saveReview, undoReview, withScheduler, ReviewConflict } from "./reviews.js";
import { effectiveDueDate, studyReviewOptions, type StudyGrade } from "./studyScheduling.js";
import type { Grade } from "./scheduler.js";
import { loadStudyRelations, studyIdentities, studyCatalog, STUDY_SUMMARY_BATCH_SIZE } from "./studyLoading.js";
import { selectedFields } from "../levels/catalogProjection.js";
import { normalizedStudyPhase, STUDY_STATUS_PROJECTION } from "./studyStatus.js";
import { toGraphQLProgress } from "./progressPresentation.js";
import { buildLearningPath } from "./learningPath.js";
import { loadDueStudyProgress, loadMoreStudyProgress, loadStudyQueueCounts } from "./studySelection.js";

// Retain module compatibility for existing scripts; transports use the service.
export { loadDueStudyProgress, loadMoreStudyProgress, loadStudyQueueCounts } from "./studySelection.js";
export type { DueStudyRequest, StudyQueueCounts } from "./studySelection.js";

export const progressResolvers = {
  Query: {
    reviewHistory: async (_: unknown, { userId, itemId, limit = 50 }: { userId: string; itemId?: string; limit?: number }, context: AuthContext) => {
      requireUserId(context, userId);
      const query: any = { userId: new ObjectId(userId) };
      if (itemId) query.itemId = new ObjectId(itemId);
      const events = await getDb().reviewEvents.find(query).sort({ reviewedAt: -1 }).limit(Math.max(1, Math.min(500, limit))).toArray();
      return events.map(e => ({ reviewId: e.reviewId, itemId: e.itemId.toString(), grade: e.grade, reviewedAt: e.reviewedAt.toISOString(), reversedAt: e.reversedAt?.toISOString(), previousDueDate: e.before.nextDueDate.toISOString(), nextDueDate: e.after.nextDueDate.toISOString() }));
    },
    mostFailedWords: async (_: unknown, { userId, limit = 20, minFailures = 1 }: { userId: string; limit?: number; minFailures?: number }, context: AuthContext) => {
      requireUserId(context, userId);
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
        return relation ? { wordRelation: { ...relation, id: relation._id.toString(), createdAt: relation.createdAt?.toISOString() }, failureIndex: row.failureIndex, cards: row.cards.map(toGraphQLProgress) } : null;
      }));
      return results.filter(Boolean);
    },
    studyQueueCounts: async (_: unknown, args: {userId: string; itemType?: string; context?: string}, context: AuthContext) => loadStudyQueueCounts(args, context),

    dueItems: async (
      _: unknown,
      {
        userId,
        dueLimit = 50,
        newLimit = 1000,
        itemType, context: category,
        includeLearningAhead = false,
      }: { userId: string; dueLimit?: number; newLimit?: number; itemType?: string; context?: string; includeLearningAhead?: boolean },
      context: AuthContext,
    ) => {
      return loadStudyRelations((await loadDueStudyProgress({ userId, dueLimit, newLimit, itemType, context: category, includeLearningAhead }, context)).map(toGraphQLProgress));
    },

    studyMoreItems: async (
      _: unknown,
      {
        userId,
        limit = 20,
        itemType, context: category,
      }: { userId: string; limit?: number; itemType?: string; context?: string },
      context: AuthContext,
    ) => {
      return loadStudyRelations((await loadMoreStudyProgress({ userId, limit, itemType, context: category }, context)).map(toGraphQLProgress));
    },

    userProgress: async (
      _: unknown,
      { userId, itemId }: { userId: string; itemId: string },
      context: AuthContext,
    ) => {
      requireUserId(context, userId);
      const db = getDb();
      const progress = await db.progress.findOne({
        userId: new ObjectId(userId),
        itemId: new ObjectId(itemId),
      });
      return toGraphQLProgress(progress ? await withScheduler(progress) : null);
    },

    allProgress: async (
      _: unknown,
      { userId, itemType, relationIds }: { userId: string; itemType?: string; relationIds?: string[] | null },
      context: AuthContext,
      info?: GraphQLResolveInfo,
    ) => {
      requireUserId(context, userId);
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
      return progress.map(toGraphQLProgress);
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

    learningPath: async (_: unknown, { userId }: { userId: string }, context: AuthContext) => {
      requireUserId(context, userId);
      const userObjectId = new ObjectId(userId);

      const [progresses, catalog] = await Promise.all([
        studyIdentities(context,userObjectId), studyCatalog(context),
      ]);
      return buildLearningPath(progresses, catalog);
    },
  },

  Mutation: {
    recordFailure: async (_: unknown, { userId, itemId, attemptId }: { userId: string; itemId: string; attemptId: string }, context: AuthContext) => {
      requireUserId(context, userId);
      return toGraphQLProgress(await recordFailure(getDb().progress, new ObjectId(userId), new ObjectId(itemId), attemptId));
    },
    reviewItem: async (_: unknown, args: { userId: string; itemId: string; itemType: string; rating?: number; grade?: StudyGrade; failureAttemptId?: string; reviewId?: string; expectedVersion?: number; earlyReview?: boolean }, context: AuthContext) => {
      requireUserId(context, args.userId);
      try {
        // Old clients retain their 2..5 scale during rollout; new clients use
        // named grades and a persistent retry ID so the scales cannot mix.
        if (args.grade && (args.rating !== undefined && args.rating !== null || !args.reviewId || args.expectedVersion === undefined)) throw new Error("Named grades require a review ID and schedule version");
        const grade = args.grade ?? ({ 2: "AGAIN", 3: "HARD", 4: "GOOD", 5: "EASY" } as Record<number, Grade>)[args.rating];
        const result = await saveReview(new ObjectId(args.userId), new ObjectId(args.itemId), args.itemType, grade, args.reviewId ?? randomUUID(), args.expectedVersion, args.earlyReview ?? false, args.failureAttemptId);
        return { success: true, reviewId: result.reviewId, progress: toGraphQLProgress(result.progress) };
      } catch (error) { return { success: false, progress: error instanceof ReviewConflict ? toGraphQLProgress(error.progress) : null, errorCode: error instanceof ReviewConflict ? error.code : null, error: error instanceof Error ? error.message : "Review save failed" }; }
    },
    undoReview: async (_: unknown, { userId, reviewId }: { userId: string; reviewId: string }, context: AuthContext) => {
      requireUserId(context, userId);
      try {
        const result = await undoReview(new ObjectId(userId), reviewId);
        return { success: true, reviewId, progress: toGraphQLProgress(result.progress) };
      } catch (error) { return { success: false, progress: null, error: error instanceof Error ? error.message : "Undo failed" }; }
    },
  },

  UserProgress: {
    reviewOptions: async (parent: any) => {
      const progress = await withScheduler({
        ...parent,
        userId: new ObjectId(parent.userId),
        itemId: new ObjectId(parent.itemId),
        nextDueDate: new Date(parent.regularDueDate || parent.nextDueDate),
        temporaryDueDate: parent.temporaryDueDate ? new Date(parent.temporaryDueDate) : undefined,
        lastReviewed: parent.lastReviewed ? new Date(parent.lastReviewed) : null,
      });
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
