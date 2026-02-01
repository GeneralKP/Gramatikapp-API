import { Phrase, UserProgress, User, IUser } from "../models/index.js";
import { calculateNextReview } from "../services/srsService.js";
import { translate as translateText } from "../services/translationService.js";
import { registerWithEmail, loginWithEmail } from "../services/authService.js";
import { Types } from "mongoose";

// Context type from Apollo Server
export interface GraphQLContext {
  user: IUser | null;
}

// Helper to convert Mongoose doc to plain object with id
function toGraphQL<T extends { _id: Types.ObjectId }>(
  doc: T | null,
): (Omit<T, "_id"> & { id: string }) | null {
  if (!doc) return null;
  const obj = (doc as any).toObject ? (doc as any).toObject() : doc;
  return { ...obj, id: obj._id.toString() };
}

interface PhraseFilter {
  tags?: string[];
  search?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const resolvers: Record<string, any> = {
  Query: {
    // Auth - get current user from context
    me: async (_: unknown, __: unknown, context: GraphQLContext) => {
      if (!context.user) return null;
      return toGraphQL(context.user);
    },

    // Phrase queries
    phrases: async (
      _: unknown,
      {
        filter,
        limit = 100,
        offset = 0,
      }: { filter?: PhraseFilter; limit?: number; offset?: number },
    ) => {
      const query: Record<string, unknown> = {};

      if (filter?.tags && filter.tags.length > 0) {
        query.tags = { $in: filter.tags };
      }

      if (filter?.search) {
        query.$text = { $search: filter.search };
      }

      const phrases = await Phrase.find(query)
        .skip(offset)
        .limit(limit)
        .sort({ createdAt: -1 });

      return phrases.map((p) => toGraphQL(p));
    },

    phrase: async (_: unknown, { id }: { id: string }) => {
      const phrase = await Phrase.findById(id);
      return toGraphQL(phrase);
    },

    phrasesCount: async (_: unknown, { filter }: { filter?: PhraseFilter }) => {
      const query: Record<string, unknown> = {};

      if (filter?.tags && filter.tags.length > 0) {
        query.tags = { $in: filter.tags };
      }

      if (filter?.search) {
        query.$text = { $search: filter.search };
      }

      return Phrase.countDocuments(query);
    },

    // Due phrases for SRS review
    duePhrases: async (
      _: unknown,
      { userId, limit = 20 }: { userId: string; limit?: number },
    ) => {
      const now = new Date();

      // Find all progress entries that are due
      let progressDocs = await UserProgress.find({
        userId: new Types.ObjectId(userId),
        nextDueDate: { $lte: now },
      })
        .limit(limit)
        .populate("phraseId");

      // If we have fewer than limit, get new phrases (no progress yet)
      if (progressDocs.length < limit) {
        const reviewedPhraseIds = await UserProgress.find({
          userId: new Types.ObjectId(userId),
        }).distinct("phraseId");

        const newPhrases = await Phrase.find({
          _id: { $nin: reviewedPhraseIds },
        }).limit(limit - progressDocs.length);

        // Create progress entries for new phrases
        const newProgressDocs = newPhrases.map((phrase) => ({
          userId: new Types.ObjectId(userId),
          phraseId: phrase._id,
          ease: 2.5,
          interval: 0,
          repetitions: 0,
          nextDueDate: new Date(),
          phrase: phrase,
        }));

        progressDocs = [
          ...progressDocs,
          ...(newProgressDocs as unknown as typeof progressDocs),
        ];
      }

      return progressDocs.map((p) => ({
        ...toGraphQL(p),
        phrase: toGraphQL((p as any).phraseId || (p as any).phrase),
      }));
    },

    // User queries
    user: async (_: unknown, { id }: { id: string }) => {
      const user = await User.findById(id);
      return toGraphQL(user);
    },

    userByEmail: async (_: unknown, { email }: { email: string }) => {
      const user = await User.findOne({ email: email.toLowerCase() });
      return toGraphQL(user);
    },

    // Progress queries
    userProgress: async (
      _: unknown,
      { userId, phraseId }: { userId: string; phraseId: string },
    ) => {
      const progress = await UserProgress.findOne({
        userId: new Types.ObjectId(userId),
        phraseId: new Types.ObjectId(phraseId),
      }).populate("phraseId");

      if (!progress) return null;

      return {
        ...toGraphQL(progress),
        phrase: toGraphQL(progress.phraseId as any),
      };
    },

    allProgress: async (_: unknown, { userId }: { userId: string }) => {
      const progress = await UserProgress.find({
        userId: new Types.ObjectId(userId),
      }).populate("phraseId");

      return progress.map((p) => ({
        ...toGraphQL(p),
        phrase: toGraphQL(p.phraseId as any),
      }));
    },
  },

  Mutation: {
    // Authentication
    register: async (
      _: unknown,
      { email, password }: { email: string; password: string },
    ) => {
      const result = await registerWithEmail(email, password);
      return {
        token: result.token,
        user: toGraphQL(result.user),
      };
    },

    login: async (
      _: unknown,
      { email, password }: { email: string; password: string },
    ) => {
      const result = await loginWithEmail(email, password);
      return {
        token: result.token,
        user: toGraphQL(result.user),
      };
    },

    // Review a phrase using SRS
    reviewPhrase: async (
      _: unknown,
      {
        userId,
        phraseId,
        rating,
      }: { userId: string; phraseId: string; rating: number },
    ) => {
      try {
        // Find or create progress entry
        let progress = await UserProgress.findOne({
          userId: new Types.ObjectId(userId),
          phraseId: new Types.ObjectId(phraseId),
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
          progress.ease = srsResult.ease;
          progress.interval = srsResult.interval;
          progress.repetitions = srsResult.repetitions;
          progress.nextDueDate = srsResult.nextDueDate;
          progress.lastReviewed = new Date();
          await progress.save();
        } else {
          progress = await UserProgress.create({
            userId: new Types.ObjectId(userId),
            phraseId: new Types.ObjectId(phraseId),
            ease: srsResult.ease,
            interval: srsResult.interval,
            repetitions: srsResult.repetitions,
            nextDueDate: srsResult.nextDueDate,
            lastReviewed: new Date(),
          });
        }

        await progress.populate("phraseId");

        return {
          success: true,
          progress: {
            ...toGraphQL(progress),
            phrase: toGraphQL(progress.phraseId as any),
          },
        };
      } catch (error) {
        console.error("Review error:", error);
        return { success: false, progress: null };
      }
    },

    // Translate text
    translate: async (
      _: unknown,
      { text, targetLang = "ES" }: { text: string; targetLang?: string },
    ) => {
      return translateText(text, targetLang);
    },

    syncSettings: async (
      _: unknown,
      {
        userId,
        settings,
      }: {
        userId: string;
        settings: { soundEnabled?: boolean; darkMode?: boolean };
      },
    ) => {
      const user = await User.findByIdAndUpdate(
        userId,
        { $set: { settings } },
        { new: true },
      );
      return toGraphQL(user);
    },

    // Phrase management
    addPhrase: async (
      _: unknown,
      {
        german,
        spanish,
        tags,
      }: { german: string; spanish: string; tags?: string[] },
    ) => {
      const phrase = await Phrase.create({
        german,
        spanish,
        tags: tags || ["phrase"],
        words: german.split(/\s+/),
      });
      return toGraphQL(phrase);
    },

    addBulkPhrases: async (_: unknown, { rawText }: { rawText: string }) => {
      const lines = rawText.split("\n");
      const newPhrases: Array<{
        german: string;
        spanish: string;
        words: string[];
        tags: string[];
      }> = [];

      lines.forEach((line) => {
        if (line.includes("|")) {
          const [german, spanish] = line.split("|").map((s) => s.trim());
          if (german && spanish) {
            newPhrases.push({
              german,
              spanish,
              words: german.split(/\s+/),
              tags: ["phrase"],
            });
          }
        }
      });

      if (newPhrases.length === 0) {
        return [];
      }

      const created = await Phrase.insertMany(newPhrases);
      return created.map((p) => toGraphQL(p));
    },
  },

  // Field resolvers
  UserProgress: {
    phrase: async (parent: { phraseId: string | Types.ObjectId }) => {
      if (typeof parent.phraseId === "object" && "german" in parent.phraseId) {
        return toGraphQL(parent.phraseId as any);
      }
      const phrase = await Phrase.findById(parent.phraseId);
      return toGraphQL(phrase);
    },
  },
};
