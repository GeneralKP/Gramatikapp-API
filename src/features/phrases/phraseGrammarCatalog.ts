import { getDb, type Database } from '../../lib/database.js';
import { readCatalogPart } from '../progress/catalogPartSource.js';
import { studyGermanWords } from '../progress/studyTextCatalog.js';
import { createPhraseGrammarIndex } from './phraseGrammar.js';

const generations = new WeakMap<object, WeakMap<object, ReturnType<typeof createPhraseGrammarIndex>>>();
export async function phraseGrammarCatalog(db: Database = getDb(), refresh = false) {
  const [words, surfaces] = await Promise.all([
    studyGermanWords(db, refresh),
    readCatalogPart<{ key: string; category?: string }>(db, 'grammarSurfaceDe', refresh),
  ]);
  let snapshots = generations.get(words);
  if (!snapshots) { snapshots = new WeakMap(); generations.set(words, snapshots); }
  let index = snapshots.get(surfaces);
  if (!index) { index = createPhraseGrammarIndex(words, surfaces); snapshots.set(surfaces, index); }
  return index;
}
