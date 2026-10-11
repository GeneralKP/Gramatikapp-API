import { getDb, type Database } from '../../lib/database.js';
import { catalogSummaryCache } from '../progress/catalogSummaryCache.js';
import { studyGermanWords } from '../progress/studyTextCatalog.js';
import { createPhraseGrammarIndex } from './phraseGrammar.js';

const generations = new WeakMap<object, WeakMap<object, ReturnType<typeof createPhraseGrammarIndex>>>();
export async function phraseGrammarCatalog(db: Database = getDb(), refresh = false) {
  const [words, surfaces] = await Promise.all([
    studyGermanWords(db, refresh),
    catalogSummaryCache[refresh ? 'refresh' : 'read'](db, 'grammarSurfaceDe', () => db.translationsEsDe
      .find({ sourceLanguage: 'de', targetLanguage: 'es', status: 'READY' })
      .project<{ key: string; category?: string }>({ _id: 0, key: 1, category: 1 }).batchSize(5000).toArray()),
  ]);
  let snapshots = generations.get(words);
  if (!snapshots) { snapshots = new WeakMap(); generations.set(words, snapshots); }
  let index = snapshots.get(surfaces);
  if (!index) { index = createPhraseGrammarIndex(words, surfaces); snapshots.set(surfaces, index); }
  return index;
}
