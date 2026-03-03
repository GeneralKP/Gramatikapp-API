import { ObjectId, Filter } from "mongodb";
import { getDb } from "../../lib/database.js";
import { translate as translateText } from "./phrases.service.js";
import { processSeedData, SeedDataInput } from "./seedService.js";

export const phrasesResolvers = {
  Query: {
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
        .aggregate([
          { $skip: offset },
          { $limit: limit },
          {
            $lookup: {
              from: "PHRASES_ES",
              localField: "main",
              foreignField: "_id",
              as: "mainDocs",
            },
          },
          {
            $lookup: {
              from: "PHRASES_DE",
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
        return {
          ...doc,
          id: doc._id.toString(),
          createdAt: doc.createdAt?.toISOString(),
        };
      });
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
      let phrase = parent.mainDoc;
      if (!phrase) {
        const db = getDb();
        phrase = await db.phrasesES.findOne({
          _id: new ObjectId(parent.main),
        });
      }
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
      let phrase = parent.translatedDoc;
      if (!phrase) {
        const db = getDb();
        phrase = await db.phrasesDE.findOne({
          _id: new ObjectId(parent.translated),
        });
      }
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
    translate: async (
      _: unknown,
      { text, targetLang = "ES" }: { text: string; targetLang?: string },
    ) => {
      return translateText(text, targetLang);
    },

    importSeedData: async (_: unknown, { jsonData }: { jsonData: string }) => {
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
