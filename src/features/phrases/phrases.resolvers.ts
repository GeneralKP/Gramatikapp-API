import { ObjectId, Filter } from "mongodb";
import { getDb } from "../../lib/database.js";
import { LegacyPhrase } from "./phrases.types.js";
import { translate as translateText } from "./phrases.service.js";

interface PhraseFilter {
  tags?: string[];
  search?: string;
}

// Helper to convert MongoDB doc to GraphQL format
function toGraphQL(phrase: LegacyPhrase | null) {
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
      const query: Filter<LegacyPhrase> = {};

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
      const query: Filter<LegacyPhrase> = {};

      if (filter?.tags && filter.tags.length > 0) {
        query.tags = { $in: filter.tags };
      }

      if (filter?.search) {
        query.$text = { $search: filter.search };
      }

      return db.phrases.countDocuments(query);
    },

    newPhrases: async (
      _: unknown,
      {
        lang,
        limit = 100,
        offset = 0,
      }: { lang: string; limit?: number; offset?: number },
    ) => {
      const db = getDb();
      const collection =
        lang.toUpperCase() === "DE" ? db.phrasesDE : db.phrasesES;
      const phrases = await collection
        .find({})
        .skip(offset)
        .limit(limit)
        .toArray();
      return phrases.map((p) => {
        // Convert perWordExplanation Map into array
        const perWordArr: { key: string; value: any }[] = [];
        if (p.perWordExplanation) {
          for (const [k, v] of Object.entries(p.perWordExplanation)) {
            perWordArr.push({ key: k, value: v });
          }
        }
        return {
          ...p,
          id: p._id.toString(),
          perWordExplanation: perWordArr,
          createdAt: p.createdAt?.toISOString(),
        };
      });
    },

    newPhrase: async (
      _: unknown,
      { lang, id }: { lang: string; id: string },
    ) => {
      const db = getDb();
      const collection =
        lang.toUpperCase() === "DE" ? db.phrasesDE : db.phrasesES;
      const phrase = await collection.findOne({ _id: new ObjectId(id) });
      if (!phrase) return null;

      const perWordArr: { key: string; value: any }[] = [];
      if (phrase.perWordExplanation) {
        for (const [k, v] of Object.entries(phrase.perWordExplanation)) {
          perWordArr.push({ key: k, value: v });
        }
      }
      return {
        ...phrase,
        id: phrase._id.toString(),
        perWordExplanation: perWordArr,
        createdAt: phrase.createdAt?.toISOString(),
      };
    },

    phraseRelations: async (
      _: unknown,
      { limit = 100, offset = 0 }: { limit?: number; offset?: number },
    ) => {
      const db = getDb();
      const relations = await db.relationsPhrasesEsDe
        .find({})
        .skip(offset)
        .limit(limit)
        .toArray();
      return relations.map((r) => ({
        ...r,
        id: r._id.toString(),
        createdAt: r.createdAt?.toISOString(),
      }));
    },
  },

  NewPhrase: {
    words: async (parent: any, _: unknown, context: any, info: any) => {
      const db = getDb();
      // Since a phrase might be from DE or ES, we'll try to find the words in both or one collection.
      // But we know 'lang' from the query or by matching `_id`. Actually, we can just search wordsES and wordsDE.
      const wordIds: ObjectId[] = parent.words || [];
      const res = [];
      for (const wid of wordIds) {
        let w = await db.wordsES.findOne({ _id: wid });
        if (!w) w = await db.wordsDE.findOne({ _id: wid });
        if (w)
          res.push({
            ...w,
            id: w._id.toString(),
            createdAt: w.createdAt?.toISOString(),
          });
      }
      return res;
    },
  },

  PhraseRelation: {
    main: async (parent: any) => {
      const db = getDb();
      const phrase = await db.phrasesES.findOne({
        _id: new ObjectId(parent.main),
      });
      if (!phrase) return null;

      const perWordArr: { key: string; value: any }[] = [];
      if (phrase.perWordExplanation) {
        for (const [k, v] of Object.entries(phrase.perWordExplanation)) {
          perWordArr.push({ key: k, value: v });
        }
      }
      return {
        ...phrase,
        id: phrase._id.toString(),
        perWordExplanation: perWordArr,
        createdAt: phrase.createdAt?.toISOString(),
      };
    },
    translated: async (parent: any) => {
      const db = getDb();
      const phrase = await db.phrasesDE.findOne({
        _id: new ObjectId(parent.translated),
      });
      if (!phrase) return null;

      const perWordArr: { key: string; value: any }[] = [];
      if (phrase.perWordExplanation) {
        for (const [k, v] of Object.entries(phrase.perWordExplanation)) {
          perWordArr.push({ key: k, value: v });
        }
      }
      return {
        ...phrase,
        id: phrase._id.toString(),
        perWordExplanation: perWordArr,
        createdAt: phrase.createdAt?.toISOString(),
      };
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

      const newPhrase: LegacyPhrase = {
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
      const newPhrases: LegacyPhrase[] = [];

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
