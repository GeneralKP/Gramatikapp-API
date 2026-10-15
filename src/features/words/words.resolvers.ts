import { catalogPipeline, type CatalogArgs } from "../levels/catalogQuery.js";
import { catalogProjection } from "../levels/catalogProjection.js";
import { catalogListBounds } from "../levels/catalogBounds.js";
import {
  toGraphQLDocument,
  toGraphQLRelation,
  type JoinedCatalogDocuments,
  type ProjectedCatalogDocument,
} from "../levels/catalogGraphQL.js";
import type { GraphQLResolveInfo } from "graphql";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import type { Word, WordRelation } from "./words.types.js";
import { requireUserId, type AuthContext } from "../auth/auth.context.js";
import { invalidateStudyCatalog } from "../progress/catalogSummaryCache.js";
import { dictionaryWord } from "./reviewedWordContent.js";

type WordDocument = ProjectedCatalogDocument<Word>;
type WordParent = Omit<Partial<Word>, "createdAt"> & { id?: string; createdAt?: Date | string };
type WordRelationDocument = ProjectedCatalogDocument<WordRelation> & JoinedCatalogDocuments<WordDocument>;
type WordRelationParent = Partial<Pick<WordRelation, "main" | "translated">> & {
  mainDoc?: WordDocument | null;
  translatedDoc?: WordDocument | null;
  study?: unknown;
};

export const wordsResolvers = {
  Word: {
    level: (parent: WordParent) => parent.cefrLevel?.split(".")[0] ?? parent.level ?? null,
    failureIndex: async (parent: WordParent, _: unknown, context: AuthContext) => {
      if (!context.user) return 0;
      const db = getDb();
      const wordId = new ObjectId(parent.id || parent._id);
      const relations = await db.relationsWordsEsDe
        .find({ $or: [{ main: wordId }, { translated: wordId }] })
        .project({ _id: 1 })
        .toArray();
      const ids = relations.map(r => r._id);
      const rows = await db.progress.aggregate<{ failureIndex: number }>([
        { $match: {
          userId: context.user._id,
          $or: [{ relationId: { $in: ids } }, { itemId: { $in: ids } }],
        } },
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
        limit: requestedLimit,
        offset: requestedOffset,
      }: { lang: string; limit?: number; offset?: number },
    ) => {
      const { limit, offset } = catalogListBounds({ limit: requestedLimit, offset: requestedOffset });
      const db = getDb();
      const collection = lang.toUpperCase() === "DE" ? db.wordsDE : db.wordsES;
      const words = await collection
        .find({})
        .skip(offset)
        .limit(limit)
        .toArray();
      return words.map(toGraphQLDocument);
    },
    word: async (_: unknown, { lang, id }: { lang: string; id: string }) => {
      const db = getDb();
      const collection = lang.toUpperCase() === "DE" ? db.wordsDE : db.wordsES;
      const word = await collection.findOne({ _id: new ObjectId(id) });
      return toGraphQLDocument(word);
    },
    wordRelations: async (
      _: unknown,
      args: CatalogArgs,
      _context: unknown,
      info?: GraphQLResolveInfo,
    ) => {
      const db = getDb();
      const relations = await db.relationsWordsEsDe
        .aggregate<WordRelationDocument>(catalogPipeline(args, "WORDS_ES", "WORDS_DE", "word", catalogProjection(info, true)))
        .toArray();

      return relations.map(toGraphQLRelation);
    },
    wordsWithoutTranslation: async (
      _: unknown,
      { lang, limit: requestedLimit }: { lang: string; limit?: number },
    ) => {
      const { limit } = catalogListBounds({ limit: requestedLimit });
      const db = getDb();
      const isDE = lang.toUpperCase() === "DE";
      const collection = isDE ? db.wordsDE : db.wordsES;
      const relationField = isDE ? "translated" : "main";

      const orphans = await collection
        .aggregate<WordDocument>([
          {
            $lookup: {
              from: "WORDS_ES_DE",
              localField: "_id",
              foreignField: relationField,
              pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }],
              as: "relations",
            },
          },
          { $match: { "relations.0": { $exists: false } } },
          { $project: { relations: 0 } },
          { $limit: limit },
        ])
        .toArray();

      return orphans.map(toGraphQLDocument);
    },
    wordRelationsWithoutPhrases: async (
      _: unknown,
      { limit: requestedLimit }: { limit?: number },
    ) => {
      const { limit } = catalogListBounds({ limit: requestedLimit }, 20);
      const db = getDb();
      const relations = await db.relationsWordsEsDe
        .aggregate<WordRelationDocument>([
          {
            $lookup: {
              from: "PHRASES_ES",
              localField: "main",
              foreignField: "words",
              pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }],
              as: "phrasesEs",
            },
          },
          {
            $lookup: {
              from: "PHRASES_DE",
              localField: "translated",
              foreignField: "words",
              pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }],
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

      return relations.map(toGraphQLRelation);
    },
  },
  WordRelation: {
    main: async (parent: WordRelationParent) => {
      if ("mainDoc" in parent) {
        return toGraphQLDocument(dictionaryWord(parent.mainDoc, parent.study, "ES"));
      }
      const db = getDb();
      const word = await db.wordsES.findOne({ _id: new ObjectId(parent.main) });
      return toGraphQLDocument(dictionaryWord(word, parent.study, "ES"));
    },
    translated: async (parent: WordRelationParent) => {
      if ("translatedDoc" in parent) {
        return toGraphQLDocument(dictionaryWord(parent.translatedDoc, parent.study, "DE"));
      }
      const db = getDb();
      const word = await db.wordsDE.findOne({
        _id: new ObjectId(parent.translated),
      });
      return toGraphQLDocument(dictionaryWord(word, parent.study, "DE"));
    },
  },
  Mutation: {
    addWordRelation: async (
      _: unknown,
      { mainId, translatedId }: { mainId: string; translatedId: string },
      context: AuthContext,
    ) => {
      requireUserId(context);
      const db = getDb();
      const newRelation: WordRelation = {
        _id: new ObjectId(),
        main: new ObjectId(mainId),
        translated: new ObjectId(translatedId),
        createdAt: new Date(),
      };
      try {
        await db.relationsWordsEsDe.insertOne(newRelation);
        return toGraphQLDocument(newRelation);
      } finally {
        // A network error can follow a committed insert.
        invalidateStudyCatalog(db);
      }
    },
  },
};
