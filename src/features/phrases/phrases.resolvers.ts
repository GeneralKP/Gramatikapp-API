import { ObjectId, Filter } from "mongodb";
import { getDb } from "../../lib/database.js";
import { Phrase } from "./phrases.types.js";
import { translate as translateText } from "./phrases.service.js";

interface PhraseFilter {
  tags?: string[];
  search?: string;
}

// Helper to convert MongoDB doc to GraphQL format
function toGraphQL(phrase: Phrase | null) {
  if (!phrase) return null;
  return {
    ...phrase,
    id: phrase._id.toString(),
    createdAt: phrase.createdAt.toISOString(),
  };
}

export const phrasesResolvers = {
  Query: {
    phrases: async (
      _: unknown,
      {
        filter,
        limit = 100,
        offset = 0,
      }: { filter?: PhraseFilter; limit?: number; offset?: number },
    ) => {
      const db = getDb();
      const query: Filter<Phrase> = {};

      if (filter?.tags && filter.tags.length > 0) {
        query.tags = { $in: filter.tags };
      }

      if (filter?.search) {
        query.$text = { $search: filter.search };
      }

      const phrases = await db.phrases
        .find(query)
        .skip(offset)
        .limit(limit)
        .sort({ createdAt: -1 })
        .toArray();

      return phrases.map((p) => toGraphQL(p));
    },

    phrase: async (_: unknown, { id }: { id: string }) => {
      const db = getDb();
      const phrase = await db.phrases.findOne({ _id: new ObjectId(id) });
      return toGraphQL(phrase);
    },

    phrasesCount: async (_: unknown, { filter }: { filter?: PhraseFilter }) => {
      const db = getDb();
      const query: Filter<Phrase> = {};

      if (filter?.tags && filter.tags.length > 0) {
        query.tags = { $in: filter.tags };
      }

      if (filter?.search) {
        query.$text = { $search: filter.search };
      }

      return db.phrases.countDocuments(query);
    },
  },

  Mutation: {
    addPhrase: async (
      _: unknown,
      {
        german,
        spanish,
        tags,
      }: { german: string; spanish: string; tags?: string[] },
    ) => {
      const db = getDb();
      const now = new Date();

      const newPhrase: Phrase = {
        _id: new ObjectId(),
        german,
        spanish,
        words: german.split(/\s+/),
        tags: tags || ["phrase"],
        createdAt: now,
      };

      await db.phrases.insertOne(newPhrase);
      return toGraphQL(newPhrase);
    },

    addBulkPhrases: async (_: unknown, { rawText }: { rawText: string }) => {
      const db = getDb();
      const lines = rawText.split("\n");
      const now = new Date();
      const newPhrases: Phrase[] = [];

      lines.forEach((line) => {
        if (line.includes("|")) {
          const [german, spanish] = line.split("|").map((s) => s.trim());
          if (german && spanish) {
            newPhrases.push({
              _id: new ObjectId(),
              german,
              spanish,
              words: german.split(/\s+/),
              tags: ["phrase"],
              createdAt: now,
            });
          }
        }
      });

      if (newPhrases.length === 0) {
        return [];
      }

      await db.phrases.insertMany(newPhrases);
      return newPhrases.map((p) => toGraphQL(p));
    },

    translate: async (
      _: unknown,
      { text, targetLang = "ES" }: { text: string; targetLang?: string },
    ) => {
      return translateText(text, targetLang);
    },
  },
};
