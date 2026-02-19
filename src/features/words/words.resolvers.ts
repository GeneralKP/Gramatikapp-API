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
        .find({})
        .skip(offset)
        .limit(limit)
        .toArray();
      return relations.map(toGraphQL);
    },
  },
  WordRelation: {
    main: async (parent: any) => {
      const db = getDb();
      const word = await db.wordsES.findOne({ _id: new ObjectId(parent.main) });
      return toGraphQL(word);
    },
    translated: async (parent: any) => {
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
