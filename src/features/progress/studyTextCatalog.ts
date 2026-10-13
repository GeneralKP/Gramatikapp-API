import { getDb, type Database } from "../../lib/database.js";
import type { Word } from "../words/words.types.js";
import type { Phrase } from "../phrases/phrases.types.js";
import { readCatalogPart } from "./catalogPartSource.js";

export function studyGermanWords(db: Database, refresh = false): Promise<Word[]> {
  return readCatalogPart<Word>(db, "wordTextDe", refresh);
}
export function studySpanishWords(db: Database, refresh = false): Promise<Word[]> {
  return readCatalogPart<Word>(db, "wordMeta", refresh);
}
export function studySpanishPhrases(db: Database, refresh = false): Promise<Phrase[]> {
  return readCatalogPart<Phrase>(db, "phraseMeta", refresh);
}

/** Shared catalog text/display/legacy feedback uses one bounded immutable
 * snapshot. Per-card content and account/progress state stay outside it. */
export async function studyTextCatalog(itemType?: string, db: Database = getDb(), refresh = false) {
  const [wordsES, wordsDE, phrasesES, phrasesDE] = await Promise.all([
    itemType !== "PHRASE" ? studySpanishWords(db, refresh) : [] as Word[],
    itemType !== "PHRASE" ? studyGermanWords(db, refresh) : [] as Word[],
    itemType !== "WORD" ? studySpanishPhrases(db, refresh) : [] as Phrase[],
    itemType !== "WORD" ? readCatalogPart<Phrase>(db, "phraseTextDe", refresh) : [] as Phrase[],
  ]);
  return { wordsES, wordsDE, phrasesES, phrasesDE };
}
