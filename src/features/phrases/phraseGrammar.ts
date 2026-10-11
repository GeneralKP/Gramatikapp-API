import { cleanBankWord, orderedCategories, type WordCategories } from './wordBankGrammar.js';
import { REVIEWED_PHRASE_CATEGORIES } from './reviewedPhraseCategories.js';

interface GrammarWord { _id: unknown; word: string; gramaticalCategories?: string[] }
interface GrammarSurface { key: string; category?: string }

/** Build once per immutable catalog generation. Lookup is in memory, never per-token Mongo/AI. */
export function createPhraseGrammarIndex(words: readonly GrammarWord[], surfaces: readonly GrammarSurface[], language: 'de' | 'es' = 'de') {
  const byId = new Map(words.map(word => [String(word._id), word]));
  const bySpelling = new Map<string, GrammarWord[]>();
  const spelling = (word: GrammarWord) => language === 'de' ? word.word.replace(/^(der|die|das)\s+/iu, '') : word.word;
  for (const word of words) {
    const text = spelling(word);
    if (/\s/u.test(text)) continue;
    const key = cleanBankWord(text).toLowerCase();
    bySpelling.set(key, [...(bySpelling.get(key) ?? []), word]);
  }
  const cached = new Map(surfaces.map(surface => [surface.key, surface.category]));
  const reviewed = new Map(REVIEWED_PHRASE_CATEGORIES[language].map(entry => [entry.word.toLowerCase(), entry]));
  const known = (categories: readonly string[] = []) => orderedCategories(categories).filter(category => category !== 'UNKNOWN');
  const categoriesOf = (word: GrammarWord, token: string) => known(word.gramaticalCategories).filter(category =>
    !(language === 'de' && category === 'NOUN' && /^\p{Lu}/u.test(spelling(word)) && /^\p{Ll}/u.test(token)));
  return {
    forPhrase(phrase: string, wordIds: readonly unknown[] = [], firstOnly = false): WordCategories {
      const result: WordCategories = Object.create(null);
      const linked = wordIds.map(id => byId.get(String(id))).filter((word): word is GrammarWord => !!word);
      const linkedBySpelling = new Map<string, GrammarWord[]>();
      for (const word of linked) {
        const key = cleanBankWord(spelling(word)).toLowerCase();
        linkedBySpelling.set(key, [...(linkedBySpelling.get(key) ?? []), word]);
      }
      const tokens = phrase.trim().split(/\s+/u).filter(Boolean);
      for (const raw of firstOnly ? tokens.slice(0, 1) : tokens) {
        const token = cleanBankWord(raw), key = token.toLowerCase();
        if (!/[\p{L}\p{N}]/u.test(token) || Object.hasOwn(result, token)) continue;
        if (/^\d+(?:[.,]\d+)*$/u.test(token)) { result[token] = ['NUMERAL']; continue; }
        let categories = (linkedBySpelling.get(key) ?? []).flatMap(word => categoriesOf(word, token));
        if (!categories.length) categories = (bySpelling.get(key) ?? []).flatMap(word => categoriesOf(word, token));
        if (!categories.length) categories = known(cached.get(key) ? [cached.get(key)!] : []);
        const review = reviewed.get(key);
        if (review && (!categories.length || review.augment)) {
          const extras = known(review.categories).filter(category => !(language === 'de' && category === 'NOUN' && /^\p{Lu}/u.test(review.word) && /^\p{Ll}/u.test(token)));
          categories.push(...extras);
        }
        result[token] = orderedCategories(categories);
      }
      return { ...result };
    },
  };
}
