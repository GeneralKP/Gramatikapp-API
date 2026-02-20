import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { Word, WordRelation } from "./words.types.js";

function toGraphQL(doc: any) {
  if (!doc) return null;
  return {
    ...doc,
    id: doc._id.toString(),
    createdAt: doc.createdAt?.toISOString(),
  };
}

export const wordsResolvers = {
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
    wordRelations: async (
      _: unknown,
      { limit = 100, offset = 0 }: { limit?: number; offset?: number },
    ) => {
      const db = getDb();
      const relations = await db.relationsWordsEsDe
        .aggregate([
          { $skip: offset },
          { $limit: limit },
          {
            $lookup: {
              from: "wordsES",
              localField: "main",
              foreignField: "_id",
              as: "mainDocs",
            },
          },
          {
            $lookup: {
              from: "wordsDE",
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
      if (parent.mainDoc) return toGraphQL(parent.mainDoc);
      const db = getDb();
      const word = await db.wordsES.findOne({ _id: new ObjectId(parent.main) });
      return toGraphQL(word);
    },
    translated: async (parent: any) => {
      if (parent.translatedDoc) return toGraphQL(parent.translatedDoc);
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
    ) => {
      const db = getDb();
      const newRelation: WordRelation = {
        _id: new ObjectId(),
        main: new ObjectId(mainId),
        translated: new ObjectId(translatedId),
        createdAt: new Date(),
      };
      await db.relationsWordsEsDe.insertOne(newRelation);
      return toGraphQL(newRelation);
    },
  },
};
