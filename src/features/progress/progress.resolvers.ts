import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { UserProgress } from "./progress.types.js";
import { calculateNextReview } from "./progress.service.js";

// Helper to convert MongoDB doc to GraphQL format
function toGraphQL(progress: UserProgress | null, phrase?: unknown) {
  if (!progress) return null;
  return {
    ...progress,
    id: progress._id.toString(),
    userId: progress.userId.toString(),
    phraseId: progress.phraseId.toString(),
    nextDueDate: progress.nextDueDate.toISOString(),
    lastReviewed: progress.lastReviewed?.toISOString() || null,
    phrase: phrase || null,
  };
}

function phraseToGraphQL(
  phrase: {
    _id: ObjectId;
    german: string;
    spanish: string;
    words?: string[];
    tags: string[];
    createdAt: Date;
  } | null,
) {
  if (!phrase) return null;
  return {
    ...phrase,
    id: phrase._id.toString(),
    createdAt: phrase.createdAt.toISOString(),
  };
}

export const progressResolvers = {
  Query: {
    duePhrases: async (
      _: unknown,
      { userId, limit = 20 }: { userId: string; limit?: number },
    ) => {
      const db = getDb();
      const now = new Date();
      const userObjectId = new ObjectId(userId);

      // Find due progress entries
      let progressDocs = await db.progress
        .find({
          userId: userObjectId,
          nextDueDate: { $lte: now },
        })
        .limit(limit)
        .toArray();

      // Get phrase details for existing progress
      const phraseIds = progressDocs.map((p) => p.phraseId);
      const phrases = await db.phrases
        .find({ _id: { $in: phraseIds } })
        .toArray();
      const phraseMap = new Map(phrases.map((p) => [p._id.toString(), p]));

      // If not enough, assign new phrases
      if (progressDocs.length < limit) {
        const reviewedPhraseIds = await db.progress
          .find({ userId: userObjectId })
          .project({ phraseId: 1 })
          .toArray();
        const reviewedSet = new Set(
          reviewedPhraseIds.map((p) => p.phraseId.toString()),
        );

        const newPhrases = await db.phrases
          .find({
            _id: { $nin: [...reviewedSet].map((id) => new ObjectId(id)) },
          })
          .limit(limit - progressDocs.length)
          .toArray();

        // Create progress entries for new phrases
        if (newPhrases.length > 0) {
          const newProgressDocs: UserProgress[] = newPhrases.map((phrase) => ({
            _id: new ObjectId(),
            userId: userObjectId,
            phraseId: phrase._id,
            ease: 2.5,
            interval: 0,
            repetitions: 0,
            nextDueDate: new Date(),
            lastReviewed: null,
            createdAt: new Date(),
          }));

          await db.progress.insertMany(newProgressDocs);

          // Add to phraseMap for response
          newPhrases.forEach((p) => phraseMap.set(p._id.toString(), p));
          progressDocs = [...progressDocs, ...newProgressDocs];
        }
      }

      return progressDocs.map((p) =>
        toGraphQL(
          p,
          phraseToGraphQL(phraseMap.get(p.phraseId.toString()) || null),
        ),
      );
    },

    userProgress: async (
      _: unknown,
      { userId, phraseId }: { userId: string; phraseId: string },
    ) => {
      const db = getDb();
      const progress = await db.progress.findOne({
        userId: new ObjectId(userId),
        phraseId: new ObjectId(phraseId),
      });

      if (!progress) return null;

      const phrase = await db.phrases.findOne({ _id: new ObjectId(phraseId) });
      return toGraphQL(progress, phraseToGraphQL(phrase));
    },

    allProgress: async (_: unknown, { userId }: { userId: string }) => {
      const db = getDb();
      const progress = await db.progress
        .find({ userId: new ObjectId(userId) })
        .toArray();

      const phraseIds = progress.map((p) => p.phraseId);
      const phrases = await db.phrases
        .find({ _id: { $in: phraseIds } })
        .toArray();
      const phraseMap = new Map(phrases.map((p) => [p._id.toString(), p]));

      return progress.map((p) =>
        toGraphQL(
          p,
          phraseToGraphQL(phraseMap.get(p.phraseId.toString()) || null),
        ),
      );
    },
  },

  Mutation: {
    reviewPhrase: async (
      _: unknown,
      {
        userId,
        phraseId,
        rating,
      }: { userId: string; phraseId: string; rating: number },
    ) => {
      try {
        const db = getDb();
        const userObjectId = new ObjectId(userId);
        const phraseObjectId = new ObjectId(phraseId);

        let progress = await db.progress.findOne({
          userId: userObjectId,
          phraseId: phraseObjectId,
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
                ease: srsResult.ease,
                interval: srsResult.interval,
                repetitions: srsResult.repetitions,
                nextDueDate: srsResult.nextDueDate,
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
            phraseId: phraseObjectId,
            ease: srsResult.ease,
            interval: srsResult.interval,
            repetitions: srsResult.repetitions,
            nextDueDate: srsResult.nextDueDate,
            lastReviewed: new Date(),
            createdAt: new Date(),
          };
          await db.progress.insertOne(newProgress);
          progress = newProgress;
        }

        const phrase = await db.phrases.findOne({ _id: phraseObjectId });

        return {
          success: true,
          progress: toGraphQL(progress, phraseToGraphQL(phrase)),
        };
      } catch (error) {
        console.error("Review error:", error);
        return { success: false, progress: null };
      }
    },
  },

  UserProgress: {
    phrase: async (parent: { phraseId: string }) => {
      const db = getDb();
      const phrase = await db.phrases.findOne({
        _id: new ObjectId(parent.phraseId),
      });
      return phraseToGraphQL(phrase);
    },
  },
};
