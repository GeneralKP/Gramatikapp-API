import { catalogPipeline, type CatalogArgs } from "../levels/catalogQuery.js";
import { catalogProjection } from "../levels/catalogProjection.js";
import { catalogListBounds } from "../levels/catalogBounds.js";
import type { GraphQLResolveInfo } from "graphql";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { translate as translateText } from "./phrases.service.js";
import { processSeedData } from "./seedService.js";

function toGraphQLPhrase(phrase: any) {
  if (!phrase) return null;
  return {
    ...phrase,
    id: phrase._id.toString(),
    perWordExplanation: Object.entries(phrase.perWordExplanation ?? {}).map(([key, value]) => ({ key, value })),
    createdAt: phrase.createdAt?.toISOString(),
  };
}

export const phrasesResolvers = {
  Query: {
    newPhrases: async (
      _: unknown,
      {
        lang,
        limit: requestedLimit,
        offset: requestedOffset,
      }: { lang: string; limit?: number; offset?: number },
    ) => {
      const { limit, offset } = catalogListBounds({ limit: requestedLimit, offset: requestedOffset });
      const db = getDb();
      const collection =
        lang.toUpperCase() === "DE" ? db.phrasesDE : db.phrasesES;
      const phrases = await collection
        .find({})
        .skip(offset)
        .limit(limit)
        .toArray();
      return phrases.map(toGraphQLPhrase);
    },

    newPhrase: async (
      _: unknown,
      { lang, id }: { lang: string; id: string },
    ) => {
      const db = getDb();
      const collection =
        lang.toUpperCase() === "DE" ? db.phrasesDE : db.phrasesES;
      const phrase = await collection.findOne({ _id: new ObjectId(id) });
      return toGraphQLPhrase(phrase);
    },

    phraseRelations: async (_: unknown, args: CatalogArgs, _context: unknown, info?: GraphQLResolveInfo) => {
      const db = getDb();
      const relations = await db.relationsPhrasesEsDe
        .aggregate(catalogPipeline(args, "PHRASES_ES", "PHRASES_DE", "phrase", catalogProjection(info)))
        .toArray();

      return relations.map((r) => {
        const doc: any = { ...r };
        if (r.mainDocs && r.mainDocs.length > 0) doc.mainDoc = r.mainDocs[0];
        if (r.translatedDocs && r.translatedDocs.length > 0)
          doc.translatedDoc = r.translatedDocs[0];
        return {
          ...doc,
          id: doc._id.toString(),
          createdAt: doc.createdAt?.toISOString(),
        };
      });
    },
  },

  NewPhrase: {
    level: (parent: any) => parent.cefrLevel?.split(".")[0] ?? parent.level ?? null,
    words: async (parent: any) => {
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
      let phrase = parent.mainDoc;
      if (!("mainDoc" in parent)) {
        const db = getDb();
        phrase = await db.phrasesES.findOne({
          _id: new ObjectId(parent.main),
        });
      }
      return toGraphQLPhrase(phrase);
    },
    translated: async (parent: any) => {
      let phrase = parent.translatedDoc;
      if (!("translatedDoc" in parent)) {
        const db = getDb();
        phrase = await db.phrasesDE.findOne({
          _id: new ObjectId(parent.translated),
        });
      }
      return toGraphQLPhrase(phrase);
    },
  },

  Mutation: {
    translate: async (
      _: unknown,
      { text, targetLang = "ES" }: { text: string; targetLang?: string },
      context: { user: unknown },
    ) => {
      if (!context.user) throw new Error("Unauthorized");
      return translateText(text, targetLang);
    },

    importSeedData: async (_: unknown, { jsonData }: { jsonData: string }, context: { user: unknown }) => {
      if (!context.user) throw new Error("Unauthorized");
      const db = getDb();
      let data: any;
      try {
        data = JSON.parse(jsonData);
      } catch (err: any) {
        throw new Error(`Invalid JSON: ${err.message}`);
      }
      const result = await processSeedData(db, data);
      return {
        wordsCreated: result.wordsCreated,
        wordsSkipped: result.wordsSkipped,
        phrasesCreated: result.phrasesCreated,
        phrasesSkipped: result.phrasesSkipped,
        relationsCreated: result.relationsCreated,
      };
    },
  },
};
