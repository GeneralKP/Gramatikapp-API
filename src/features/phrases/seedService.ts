import { ObjectId } from "mongodb";
import type { Database } from "../../lib/database.js";
import type { RelatedWords, Word, WordForms } from "../words/words.types.js";
import type { PerWordExplanation, Phrase } from "./phrases.types.js";
import { invalidateStudyCatalog } from "../progress/catalogSummaryCache.js";

// ─── Input JSON shape ────────────────────────────────────────────────
export interface SeedWordInput {
  tempId: string;
  word: string;
  gramaticalCategories: string[];
  examples: string[];
  relatedWords?: RelatedWords;
  forms?: WordForms;
  contexts: string[];
  level?: string;
  notes?: string;
}

export interface SeedPhraseInput {
  tempId: string;
  phrase: string;
  synonyms?: string[];
  wordRefs?: string[]; // tempIds pointing to words
  perWordExplanation?: Record<string, PerWordExplanation>;
  level?: string;
  contexts: string[];
}

export interface SeedRelationInput {
  main: string; // tempId of ES item
  translated: string; // tempId of DE item
}

export interface SeedDataInput {
  words_de: SeedWordInput[];
  words_es: SeedWordInput[];
  word_relations: SeedRelationInput[];
  phrases_de: SeedPhraseInput[];
  phrases_es: SeedPhraseInput[];
  phrase_relations: SeedRelationInput[];
}

export interface ImportResult {
  wordsCreated: number;
  wordsSkipped: number;
  phrasesCreated: number;
  phrasesSkipped: number;
  relationsCreated: number;
  details: {
    wordsCreatedList: string[];
    wordsSkippedList: string[];
    phrasesCreatedList: string[];
    phrasesSkippedList: string[];
  };
}

// ─── Core processing function ────────────────────────────────────────
export async function processSeedData(
  db: Database,
  data: SeedDataInput,
): Promise<ImportResult> {
  invalidateStudyCatalog(db);
  try {
    return await insertSeedData(db, data);
  } finally {
    // Failed imports can have committed earlier inserts; never retain their
    // previous summary after either successful or partially failed imports.
    invalidateStudyCatalog(db);
  }
}

async function insertSeedData(db: Database, data: SeedDataInput): Promise<ImportResult> {
  const result: ImportResult = {
    wordsCreated: 0,
    wordsSkipped: 0,
    phrasesCreated: 0,
    phrasesSkipped: 0,
    relationsCreated: 0,
    details: {
      wordsCreatedList: [],
      wordsSkippedList: [],
      phrasesCreatedList: [],
      phrasesSkippedList: [],
    },
  };

  // Shared across languages so later duplicate tempIds retain their original
  // last-write behavior, including cross-language references.
  const wordIds = new Map<string, ObjectId>();
  const phraseIds = new Map<string, ObjectId>();

  async function insertWords(entries: SeedWordInput[], language: "DE" | "ES") {
    const collection = language === "DE" ? db.wordsDE : db.wordsES;
    for (const input of entries || []) {
      const existing = await collection.findOne({ word: input.word });
      if (existing) {
        wordIds.set(input.tempId, existing._id);
        result.wordsSkipped++;
        result.details.wordsSkippedList.push(`[${language}] ${input.word}`);
        continue;
      }
      const document: Word = {
        _id: new ObjectId(),
        word: input.word,
        gramaticalCategories: input.gramaticalCategories as Word["gramaticalCategories"],
        examples: input.examples || [],
        relatedWords: input.relatedWords,
        forms: input.forms,
        contexts: input.contexts,
        level: input.level as Word["level"],
        notes: input.notes,
        createdAt: new Date(),
      };
      await collection.insertOne(document);
      wordIds.set(input.tempId, document._id);
      result.wordsCreated++;
      result.details.wordsCreatedList.push(`[${language}] ${input.word}`);
    }
  }

  async function insertPhrases(entries: SeedPhraseInput[], language: "DE" | "ES") {
    const collection = language === "DE" ? db.phrasesDE : db.phrasesES;
    for (const input of entries || []) {
      const existing = await collection.findOne({ phrase: input.phrase });
      if (existing) {
        phraseIds.set(input.tempId, existing._id);
        result.phrasesSkipped++;
        result.details.phrasesSkippedList.push(`[${language}] ${input.phrase}`);
        continue;
      }
      const document: Phrase = {
        _id: new ObjectId(),
        phrase: input.phrase,
        synonyms: input.synonyms || [],
        words: (input.wordRefs || []).map(ref => wordIds.get(ref)).filter(Boolean) as ObjectId[],
        perWordExplanation: input.perWordExplanation,
        level: input.level as Phrase["level"],
        contexts: input.contexts,
        createdAt: new Date(),
      };
      await collection.insertOne(document);
      phraseIds.set(input.tempId, document._id);
      result.phrasesCreated++;
      result.details.phrasesCreatedList.push(`[${language}] ${input.phrase}`);
    }
  }

  async function insertRelations(entries: SeedRelationInput[], ids: Map<string, ObjectId>, kind: "Word" | "Phrase") {
    const collection = kind === "Word" ? db.relationsWordsEsDe : db.relationsPhrasesEsDe;
    for (const input of entries || []) {
      const main = ids.get(input.main), translated = ids.get(input.translated);
      if (!main || !translated) {
        console.warn(`⚠ ${kind} relation skipped — unresolved tempIds: main=${input.main}, translated=${input.translated}`);
        continue;
      }
      if (!await collection.findOne({ main, translated })) {
        await collection.insertOne({ _id: new ObjectId(), main, translated, createdAt: new Date() });
        result.relationsCreated++;
      }
    }
  }

  // Preserve sequential stage order: phrases can reference every inserted word,
  // and a later failure must not erase inserts completed by an earlier stage.
  await insertWords(data.words_de, "DE");
  await insertWords(data.words_es, "ES");
  await insertRelations(data.word_relations, wordIds, "Word");
  await insertPhrases(data.phrases_de, "DE");
  await insertPhrases(data.phrases_es, "ES");
  await insertRelations(data.phrase_relations, phraseIds, "Phrase");
  return result;
}
