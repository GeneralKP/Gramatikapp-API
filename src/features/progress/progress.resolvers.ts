import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { UserProgress } from "./progress.types.js";
import { calculateNextReview } from "./progress.service.js";

function toGraphQL(progress: UserProgress | null) {
  if (!progress) return null;
  return {
    ...progress,
    id: progress._id.toString(),
    userId: progress.userId.toString(),
    itemId: progress.itemId.toString(),
    itemType: progress.itemType,
    nextDueDate: progress.nextDueDate.toISOString(),
    lastReviewed: progress.lastReviewed?.toISOString() || null,
  };
}

export const progressResolvers = {
  Query: {
    dueItems: async (
      _: unknown,
      {
        userId,
        limit = 20,
        itemType,
      }: { userId: string; limit?: number; itemType?: string },
    ) => {
      const db = getDb();
      const now = new Date();
      const userObjectId = new ObjectId(userId);

      const query: any = { userId: userObjectId, nextDueDate: { $lte: now } };
      if (itemType) query.itemType = itemType;

      let progressDocs = await db.progress.find(query).limit(limit).toArray();

      if (progressDocs.length < limit) {
        const reviewedQuery: any = { userId: userObjectId };
        if (itemType) reviewedQuery.itemType = itemType;

        const reviewedIds = await db.progress
          .find(reviewedQuery)
          .project({ itemId: 1 })
          .toArray();
        const reviewedSet = new Set(
          reviewedIds.map((p) => p.itemId.toString()),
        );

        const needed = limit - progressDocs.length;
        const newProgressDocs: UserProgress[] = [];

        if (!itemType || itemType === "WORD") {
          const neededWords =
            itemType === "WORD" ? needed : Math.ceil(needed / 2);
          const newWords = await db.relationsWordsEsDe
            .find({
              _id: { $nin: [...reviewedSet].map((id) => new ObjectId(id)) },
            })
            .limit(neededWords)
            .toArray();

          for (const w of newWords) {
            newProgressDocs.push({
              _id: new ObjectId(),
              userId: userObjectId,
              itemId: w._id,
              itemType: "WORD",
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
            itemType === "PHRASE" ? needed : Math.floor(needed / 2);
          const newPhrases = await db.relationsPhrasesEsDe
            .find({
              _id: { $nin: [...reviewedSet].map((id) => new ObjectId(id)) },
            })
            .limit(neededPhrases)
            .toArray();

          for (const p of newPhrases) {
            newProgressDocs.push({
              _id: new ObjectId(),
              userId: userObjectId,
              itemId: p._id,
              itemType: "PHRASE",
              ease: 2.5,
              interval: 0,
              repetitions: 0,
              nextDueDate: new Date(),
              lastReviewed: null,
              createdAt: new Date(),
            });
          }
        }

        if (newProgressDocs.length > 0) {
          const docsToAdd = newProgressDocs.slice(0, needed);
          await db.progress.insertMany(docsToAdd);
          progressDocs = [...progressDocs, ...docsToAdd];
        }
      }

      return progressDocs.map(toGraphQL);
    },

    userProgress: async (
      _: unknown,
      { userId, itemId }: { userId: string; itemId: string },
    ) => {
      const db = getDb();
      const progress = await db.progress.findOne({
        userId: new ObjectId(userId),
        itemId: new ObjectId(itemId),
      });
      return toGraphQL(progress);
    },

    allProgress: async (
      _: unknown,
      { userId, itemType }: { userId: string; itemType?: string },
    ) => {
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

    learningPath: async (_: unknown, { userId }: { userId: string }) => {
      const db = getDb();
      const userObjectId = new ObjectId(userId);

      // ── Fetch RELATIONS (same collections used by dueItems) ──
      // Progress.itemId stores the relation _id, so we must iterate
      // over relations and join to the main word/phrase for context/level.
      const wordRelations = await db.relationsWordsEsDe.find({}).toArray();
      const phraseRelations = await db.relationsPhrasesEsDe.find({}).toArray();

      // Build lookup maps: main word/phrase _id → { context, level }
      const mainWordIds = wordRelations.map((wr) => wr.main);
      const mainPhraseIds = phraseRelations.map((pr) => pr.main);

      const wordsLookup = await db.wordsES
        .find({ _id: { $in: mainWordIds } })
        .project({ _id: 1, context: 1, level: 1 })
        .toArray();
      const phrasesLookup = await db.phrasesES
        .find({ _id: { $in: mainPhraseIds } })
        .project({ _id: 1, context: 1, level: 1 })
        .toArray();

      const wordMeta = new Map(
        wordsLookup.map((w) => [
          w._id.toString(),
          { context: w.context, level: w.level },
        ]),
      );
      const phraseMeta = new Map(
        phrasesLookup.map((p) => [
          p._id.toString(),
          { context: p.context, level: p.level },
        ]),
      );

      // ── Fetch user progress (itemId = relation _id) ──
      const progresses = await db.progress
        .find({ userId: userObjectId })
        .toArray();
      const learnedSet = new Set(
        progresses
          .filter((p) => p.repetitions > 0)
          .map((p) => p.itemId.toString()),
      );

      const nodesMap: Record<string, any> = {};

      // ── Populate Word stats using relation IDs ──
      for (const wr of wordRelations) {
        const meta = wordMeta.get(wr.main.toString());
        if (!meta?.context) continue;
        const ctxId = meta.context;
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
        // Check the RELATION _id against progress (this is the correct ID)
        if (learnedSet.has(wr._id.toString())) {
          nodesMap[ctxId].wordsLearned += 1;
        }
      }

      // ── Populate Phrase stats using relation IDs ──
      for (const pr of phraseRelations) {
        const meta = phraseMeta.get(pr.main.toString());
        if (!meta?.context) continue;
        const ctxId = meta.context;
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
        if (learnedSet.has(pr._id.toString())) {
          nodesMap[ctxId].phrasesLearned += 1;
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
    reviewItem: async (
      _: unknown,
      {
        userId,
        itemId,
        itemType,
        rating,
      }: {
        userId: string;
        itemId: string;
        itemType: "WORD" | "PHRASE";
        rating: number;
      },
    ) => {
      try {
        const db = getDb();
        const userObjectId = new ObjectId(userId);
        const itemObjectId = new ObjectId(itemId);

        let progress = await db.progress.findOne({
          userId: userObjectId,
          itemId: itemObjectId,
        });

        const current = progress
          ? {
              ease: progress.ease,
              interval: progress.interval,
              repetitions: progress.repetitions,
            }
          : {};

        const srsResult = calculateNextReview(rating, current);

        if (progress) {
          await db.progress.updateOne(
            { _id: progress._id },
            {
              $set: {
                ...srsResult,
                lastReviewed: new Date(),
                updatedAt: new Date(),
              },
            },
          );
          progress = await db.progress.findOne({ _id: progress._id });
        } else {
          const newProgress: UserProgress = {
            _id: new ObjectId(),
            userId: userObjectId,
            itemId: itemObjectId,
            itemType: itemType,
            ...srsResult,
            lastReviewed: new Date(),
            createdAt: new Date(),
          };
          await db.progress.insertOne(newProgress);
          progress = newProgress;
        }

        return { success: true, progress: toGraphQL(progress) };
      } catch (error) {
        console.error("Review error:", error);
        return { success: false, progress: null };
      }
    },
  },

  UserProgress: {
    wordRelation: async (parent: { itemId: string; itemType: string }) => {
      if (parent.itemType !== "WORD") return null;
      const db = getDb();
      const rel = await db.relationsWordsEsDe.findOne({
        _id: new ObjectId(parent.itemId),
      });
      if (!rel) return null;
      return {
        ...rel,
        id: rel._id.toString(),
        createdAt: rel.createdAt?.toISOString(),
      };
    },
    phraseRelation: async (parent: { itemId: string; itemType: string }) => {
      if (parent.itemType !== "PHRASE") return null;
      const db = getDb();
      const rel = await db.relationsPhrasesEsDe.findOne({
        _id: new ObjectId(parent.itemId),
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
