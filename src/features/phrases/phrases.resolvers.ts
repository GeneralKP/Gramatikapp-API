import { catalogPipeline, type CatalogArgs } from "../levels/catalogQuery.js";
import { catalogProjection } from "../levels/catalogProjection.js";
import { catalogListBounds } from "../levels/catalogBounds.js";
import {
  toGraphQLDocument,
  toGraphQLRelation,
  type GraphQLCatalogDocument,
  type JoinedCatalogDocuments,
  type ProjectedCatalogDocument,
} from "../levels/catalogGraphQL.js";
import type { GraphQLResolveInfo } from "graphql";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { translate as translateText } from "./phrases.service.js";
import { processSeedData, type SeedDataInput } from "./seedService.js";
import type { Phrase, PhraseRelation } from "./phrases.types.js";
import type { Word } from "../words/words.types.js";
import { requireUserId, type AuthContext } from "../auth/auth.context.js";

type PhraseDocument = ProjectedCatalogDocument<Phrase>;
type PhraseParent = Omit<Partial<Phrase>, "createdAt" | "perWordExplanation"> & { createdAt?: Date | string };
type PhraseRelationDocument = ProjectedCatalogDocument<PhraseRelation> & JoinedCatalogDocuments<PhraseDocument>;
type PhraseRelationParent = Partial<Pick<PhraseRelation, "main" | "translated">> & {
  mainDoc?: PhraseDocument | null;
  translatedDoc?: PhraseDocument | null;
};

function toGraphQLPhrase(phrase: PhraseDocument | null | undefined) {
  if (!phrase) return null;
  return {
    ...toGraphQLDocument(phrase),
    perWordExplanation: Object.entries(phrase.perWordExplanation ?? {})
      .map(([key, value]) => ({ key, value })),
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

    phraseRelations: async (
      _: unknown,
      args: CatalogArgs,
      _context: unknown,
      info?: GraphQLResolveInfo,
    ) => {
      const db = getDb();
      const relations = await db.relationsPhrasesEsDe
        .aggregate<PhraseRelationDocument>(catalogPipeline(args, "PHRASES_ES", "PHRASES_DE", "phrase", catalogProjection(info)))
        .toArray();

      return relations.map(toGraphQLRelation);
    },
  },

  NewPhrase: {
    level: (parent: PhraseParent) => parent.cefrLevel?.split(".")[0] ?? parent.level ?? null,
    words: async (parent: PhraseParent) => {
      const db = getDb();
      // Keep phrase order and duplicates, preferring Spanish when an ID exists in both languages.
      const wordIds: ObjectId[] = parent.words || [];
      const words: GraphQLCatalogDocument<Word>[] = [];
      for (const wid of wordIds) {
        let w = await db.wordsES.findOne({ _id: wid });
        if (!w) w = await db.wordsDE.findOne({ _id: wid });
        if (w) words.push(toGraphQLDocument(w));
      }
      return words;
    },
  },

  PhraseRelation: {
    main: async (parent: PhraseRelationParent) => {
      let phrase = parent.mainDoc;
      if (!("mainDoc" in parent)) {
        const db = getDb();
        phrase = await db.phrasesES.findOne({
          _id: new ObjectId(parent.main),
        });
      }
      return toGraphQLPhrase(phrase);
    },
    translated: async (parent: PhraseRelationParent) => {
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
      context: AuthContext,
    ) => {
      requireUserId(context);
      return translateText(text, targetLang);
    },

    importSeedData: async (
      _: unknown,
      { jsonData }: { jsonData: string },
      context: AuthContext,
    ) => {
      requireUserId(context);
      const db = getDb();
      let data: SeedDataInput;
      try {
        data = JSON.parse(jsonData);
      } catch (error) {
        throw new Error(`Invalid JSON: ${(error as SyntaxError).message}`);
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
