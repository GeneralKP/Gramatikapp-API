import { getDb, type Database } from "../../lib/database.js";
import type { Word } from "../words/words.types.js";
import type { Phrase } from "../phrases/phrases.types.js";
import { catalogSummaryCache } from "./catalogSummaryCache.js";

const TEXT_BATCH_SIZE = 5000;
export function studySpanishWords(db: Database, refresh = false): Promise<Word[]> {
  return catalogSummaryCache[refresh ? "refresh" : "read"](db, "wordMeta", () => db.wordsES.find({})
    .project<Word>({ _id: 1, word: 1, contexts: 1, level: 1, examples: 1 }).batchSize(TEXT_BATCH_SIZE).toArray());
}
export function studySpanishPhrases(db: Database, refresh = false): Promise<Phrase[]> {
  return catalogSummaryCache[refresh ? "refresh" : "read"](db, "phraseMeta", () => db.phrasesES.find({})
    .project<Phrase>({ _id: 1, phrase: 1, contexts: 1, level: 1 }).batchSize(TEXT_BATCH_SIZE).toArray());
}

/** Shared catalog text/display/legacy feedback uses one bounded immutable
 * snapshot. Per-card content and account/progress state stay outside it. */
export async function studyTextCatalog(itemType?: string, db: Database = getDb(), refresh = false) {
  const [wordsES, wordsDE, phrasesES, phrasesDE] = await Promise.all([
    itemType !== "PHRASE" ? studySpanishWords(db, refresh) : [] as Word[],
    itemType !== "PHRASE" ? catalogSummaryCache[refresh ? "refresh" : "read"](db, "wordTextDe", () => db.wordsDE.find({})
      .project<Word>({ _id: 1, word: 1, gramaticalCategories: 1, "forms.gender": 1,
        "forms.past": 1, "forms.perfect": 1, "forms.imperativ": 1, notes: 1, examples: 1 }).batchSize(TEXT_BATCH_SIZE).toArray()) : [] as Word[],
    itemType !== "WORD" ? studySpanishPhrases(db, refresh) : [] as Phrase[],
    itemType !== "WORD" ? catalogSummaryCache[refresh ? "refresh" : "read"](db, "phraseTextDe", () => db.phrasesDE.find({})
      .project<Phrase>({ _id: 1, phrase: 1, synonyms: 1 }).batchSize(TEXT_BATCH_SIZE).toArray()) : [] as Phrase[],
  ]);
  return { wordsES, wordsDE, phrasesES, phrasesDE };
}
