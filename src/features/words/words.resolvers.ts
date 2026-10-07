import { catalogPipeline, type CatalogArgs } from "../levels/catalogQuery.js";
import { catalogProjection } from "../levels/catalogProjection.js";
import type { GraphQLResolveInfo } from "graphql";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { Word, WordRelation } from "./words.types.js";
import { invalidateStudyCatalog } from "../progress/catalogSummaryCache.js";

function toGraphQL(doc: any) {
  if (!doc) return null;
  return {
    ...doc,
    id: doc._id.toString(),
    createdAt: doc.createdAt?.toISOString(),
  };
}

export const wordsResolvers = {
  Word: {
    level: (parent: any) => parent.cefrLevel?.split(".")[0] ?? parent.level ?? null,
    failureIndex: async (parent: any, _: unknown, context: any) => {
      if (!context.user) return 0;
      const db = getDb();
      const wordId = new ObjectId(parent.id || parent._id);
      const relations = await db.relationsWordsEsDe.find({ $or: [{ main: wordId }, { translated: wordId }] }).project({ _id: 1 }).toArray();
      const ids = relations.map(r => r._id);
      const rows = await db.progress.aggregate([
        { $match: { userId: context.user._id, $or: [{ relationId: { $in: ids } }, { itemId: { $in: ids } }] } },
        { $group: { _id: null, failureIndex: { $sum: { $ifNull: ["$failureIndex", 0] } } } },
      ]).toArray();
      return rows[0]?.failureIndex ?? 0;
    },
  },
  Query: {
    words: async (
      _: unknown,
      {
        lang,
        limit = 100,
        offset = 0,
      }: { lang: string; limit?: number; offset?: number },
    ) => {
      const db = getDb();
      const collection = lang.toUpperCase() === "DE" ? db.wordsDE : db.wordsES;
      const words = await collection
        .find({})
        .skip(offset)
        .limit(limit)
        .toArray();
      return words.map(toGraphQL);
    },
    word: async (_: unknown, { lang, id }: { lang: string; id: string }) => {
      const db = getDb();
      const collection = lang.toUpperCase() === "DE" ? db.wordsDE : db.wordsES;
      const word = await collection.findOne({ _id: new ObjectId(id) });
      return toGraphQL(word);
    },
    wordRelations: async (_: unknown, args: CatalogArgs, _context: unknown, info?: GraphQLResolveInfo) => {
      const db = getDb();
      const relations = await db.relationsWordsEsDe
        .aggregate(catalogPipeline(args, "WORDS_ES", "WORDS_DE", "word", catalogProjection(info)))
        .toArray();

      return relations.map((r) => {
        const doc: any = { ...r };
        if (r.mainDocs && r.mainDocs.length > 0) doc.mainDoc = r.mainDocs[0];
        if (r.translatedDocs && r.translatedDocs.length > 0)
          doc.translatedDoc = r.translatedDocs[0];
        return toGraphQL(doc);
      });
    },
    wordsWithoutTranslation: async (
      _: unknown,
      { lang, limit = 100 }: { lang: string; limit?: number },
    ) => {
      const db = getDb();
      const isDE = lang.toUpperCase() === "DE";
      const collection = isDE ? db.wordsDE : db.wordsES;
      const relationField = isDE ? "translated" : "main";

      const orphans = await collection
        .aggregate([
          {
            $lookup: {
              from: "WORDS_ES_DE",
              localField: "_id",
              foreignField: relationField,
              as: "relations",
            },
          },
          { $match: { "relations.0": { $exists: false } } },
          { $project: { relations: 0 } },
          { $limit: limit },
        ])
        .toArray();

      return orphans.map(toGraphQL);
    },
    wordRelationsWithoutPhrases: async (
      _: unknown,
      { limit = 20 }: { limit?: number },
    ) => {
      const db = getDb();
      const relations = await db.relationsWordsEsDe
        .aggregate([
          {
            $lookup: {
              from: "PHRASES_ES",
              localField: "main",
              foreignField: "words",
              as: "phrasesEs",
            },
          },
          {
            $lookup: {
              from: "PHRASES_DE",
              localField: "translated",
              foreignField: "words",
              as: "phrasesDe",
            },
          },
          {
            $match: {
              $and: [
                { "phrasesEs.0": { $exists: false } },
                { "phrasesDe.0": { $exists: false } },
              ],
            },
          },
          { $limit: limit },
          {
            $lookup: {
              from: "WORDS_ES",
              localField: "main",
              foreignField: "_id",
              as: "mainDocs",
            },
          },
          {
            $lookup: {
              from: "WORDS_DE",
              localField: "translated",
              foreignField: "_id",
              as: "translatedDocs",
            },
          },
        ])
        .toArray();

      return relations.map((r) => {
        const doc: any = { ...r };
        if (r.mainDocs && r.mainDocs.length > 0) doc.mainDoc = r.mainDocs[0];
        if (r.translatedDocs && r.translatedDocs.length > 0)
          doc.translatedDoc = r.translatedDocs[0];
        return toGraphQL(doc);
      });
    },
  },
  WordRelation: {
    main: async (parent: any) => {
      if ("mainDoc" in parent) return toGraphQL(parent.mainDoc);
      const db = getDb();
      const word = await db.wordsES.findOne({ _id: new ObjectId(parent.main) });
      return toGraphQL(word);
    },
    translated: async (parent: any) => {
      if ("translatedDoc" in parent) return toGraphQL(parent.translatedDoc);
      const db = getDb();
      const word = await db.wordsDE.findOne({
        _id: new ObjectId(parent.translated),
      });
      return toGraphQL(word);
    },
  },
  Mutation: {
    addWordRelation: async (
      _: unknown,
      { mainId, translatedId }: { mainId: string; translatedId: string },
      context: { user: unknown },
    ) => {
      if (!context.user) throw new Error("Unauthorized");
      const db = getDb();
      const newRelation: WordRelation = {
        _id: new ObjectId(),
        main: new ObjectId(mainId),
        translated: new ObjectId(translatedId),
        createdAt: new Date(),
      };
      try {
        await db.relationsWordsEsDe.insertOne(newRelation);
        return toGraphQL(newRelation);
      } finally {
        // A network error can follow a committed insert.
        invalidateStudyCatalog(db);
      }
    },
  },
};
