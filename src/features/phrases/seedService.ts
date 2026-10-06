import { ObjectId } from "mongodb";
import { Database } from "../../lib/database.js";
import { Word } from "../words/words.types.js";
import { Phrase } from "./phrases.types.js";
import { invalidateStudyCatalog } from "../progress/catalogSummaryCache.js";

// ─── Input JSON shape ────────────────────────────────────────────────
export interface SeedWordInput {
  tempId: string;
  word: string;
  gramaticalCategories: string[];
  examples: string[];
  relatedWords?: {
    synonyms?: string[];
    antonyms?: string[];
    homophones?: string[];
    homonymous?: string[];
    paronyms?: string[];
    verbFamilies?: string[];
  };
  forms?: {
    perfect?: string;
    past?: string;
    imperativ?: string;
    irregularConjugations?: string;
    plural?: string;
    gender?: string;
    gramaticalCase?: string;
  };
  contexts: string[];
  level?: string;
  notes?: string;
}

export interface SeedPhraseInput {
  tempId: string;
  phrase: string;
  synonyms?: string[];
  wordRefs?: string[]; // tempIds pointing to words
  perWordExplanation?: Record<
    string,
    { missing?: string; misplaced?: string; misspelled?: string }
  >;
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

  // Maps: tempId → real ObjectId
  const wordIdMap = new Map<string, ObjectId>();

  // ── 1. Process German words ──────────────────────────────────────
  for (const w of data.words_de || []) {
    const existing = await db.wordsDE.findOne({ word: w.word });
    if (existing) {
      wordIdMap.set(w.tempId, existing._id);
      result.wordsSkipped++;
      result.details.wordsSkippedList.push(`[DE] ${w.word}`);
    } else {
      const newId = new ObjectId();
      const doc: Word = {
        _id: newId,
        word: w.word,
        gramaticalCategories: w.gramaticalCategories as any[],
        examples: w.examples || [],
        relatedWords: w.relatedWords as any,
        forms: w.forms as any,
        contexts: w.contexts as any[],
        level: w.level as any,
        notes: w.notes,
        createdAt: new Date(),
      };
      await db.wordsDE.insertOne(doc);
      wordIdMap.set(w.tempId, newId);
      result.wordsCreated++;
      result.details.wordsCreatedList.push(`[DE] ${w.word}`);
    }
  }

  // ── 2. Process Spanish words ─────────────────────────────────────
  for (const w of data.words_es || []) {
    const existing = await db.wordsES.findOne({ word: w.word });
    if (existing) {
      wordIdMap.set(w.tempId, existing._id);
      result.wordsSkipped++;
      result.details.wordsSkippedList.push(`[ES] ${w.word}`);
    } else {
      const newId = new ObjectId();
      const doc: Word = {
        _id: newId,
        word: w.word,
        gramaticalCategories: w.gramaticalCategories as any[],
        examples: w.examples || [],
        relatedWords: w.relatedWords as any,
        forms: w.forms as any,
        contexts: w.contexts as any[],
        level: w.level as any,
        notes: w.notes,
        createdAt: new Date(),
      };
      await db.wordsES.insertOne(doc);
      wordIdMap.set(w.tempId, newId);
      result.wordsCreated++;
      result.details.wordsCreatedList.push(`[ES] ${w.word}`);
    }
  }

  // ── 3. Create word relations ─────────────────────────────────────
  for (const rel of data.word_relations || []) {
    const mainId = wordIdMap.get(rel.main);
    const translatedId = wordIdMap.get(rel.translated);
    if (!mainId || !translatedId) {
      console.warn(
        `⚠ Word relation skipped — unresolved tempIds: main=${rel.main}, translated=${rel.translated}`,
      );
      continue;
    }
    // Check for existing relation
    const existingRel = await db.relationsWordsEsDe.findOne({
      main: mainId,
      translated: translatedId,
    });
    if (!existingRel) {
      await db.relationsWordsEsDe.insertOne({
        _id: new ObjectId(),
        main: mainId,
        translated: translatedId,
        createdAt: new Date(),
      });
      result.relationsCreated++;
    }
  }

  // Maps: phrase tempId → real ObjectId
  const phraseIdMap = new Map<string, ObjectId>();

  // ── 4. Process German phrases ────────────────────────────────────
  for (const p of data.phrases_de || []) {
    const existing = await db.phrasesDE.findOne({ phrase: p.phrase });
    if (existing) {
      phraseIdMap.set(p.tempId, existing._id);
      result.phrasesSkipped++;
      result.details.phrasesSkippedList.push(`[DE] ${p.phrase}`);
    } else {
      const newId = new ObjectId();
      const resolvedWords = (p.wordRefs || [])
        .map((ref) => wordIdMap.get(ref))
        .filter(Boolean) as ObjectId[];
      const doc: Phrase = {
        _id: newId,
        phrase: p.phrase,
        synonyms: p.synonyms || [],
        words: resolvedWords,
        perWordExplanation: p.perWordExplanation as any,
        level: p.level as any,
        contexts: p.contexts as any[],
        createdAt: new Date(),
      };
      await db.phrasesDE.insertOne(doc);
      phraseIdMap.set(p.tempId, newId);
      result.phrasesCreated++;
      result.details.phrasesCreatedList.push(`[DE] ${p.phrase}`);
    }
  }

  // ── 5. Process Spanish phrases ───────────────────────────────────
  for (const p of data.phrases_es || []) {
    const existing = await db.phrasesES.findOne({ phrase: p.phrase });
    if (existing) {
      phraseIdMap.set(p.tempId, existing._id);
      result.phrasesSkipped++;
      result.details.phrasesSkippedList.push(`[ES] ${p.phrase}`);
    } else {
      const newId = new ObjectId();
      const resolvedWords = (p.wordRefs || [])
        .map((ref) => wordIdMap.get(ref))
        .filter(Boolean) as ObjectId[];
      const doc: Phrase = {
        _id: newId,
        phrase: p.phrase,
        synonyms: p.synonyms || [],
        words: resolvedWords,
        perWordExplanation: p.perWordExplanation as any,
        level: p.level as any,
        contexts: p.contexts as any[],
        createdAt: new Date(),
      };
      await db.phrasesES.insertOne(doc);
      phraseIdMap.set(p.tempId, newId);
      result.phrasesCreated++;
      result.details.phrasesCreatedList.push(`[ES] ${p.phrase}`);
    }
  }

  // ── 6. Create phrase relations ───────────────────────────────────
  for (const rel of data.phrase_relations || []) {
    const mainId = phraseIdMap.get(rel.main);
    const translatedId = phraseIdMap.get(rel.translated);
    if (!mainId || !translatedId) {
      console.warn(
        `⚠ Phrase relation skipped — unresolved tempIds: main=${rel.main}, translated=${rel.translated}`,
      );
      continue;
    }
    const existingRel = await db.relationsPhrasesEsDe.findOne({
      main: mainId,
      translated: translatedId,
    });
    if (!existingRel) {
      await db.relationsPhrasesEsDe.insertOne({
        _id: new ObjectId(),
        main: mainId,
        translated: translatedId,
        createdAt: new Date(),
      });
      result.relationsCreated++;
    }
  }

  return result;
}
