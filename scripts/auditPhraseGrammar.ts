import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPhraseGrammarIndex } from '../src/features/phrases/phraseGrammar.js';
import { PHRASE_CATEGORY_REVIEW, REVIEWED_PHRASE_CATEGORIES } from '../src/features/phrases/reviewedPhraseCategories.js';

// Explicit catalog-only snapshot input. No database/provider client, user or progress writes.
const path = process.argv[2];
if (!path) throw new Error('Supply a read-only catalog snapshot JSON file.');
const snapshot = JSON.parse(readFileSync(path, 'utf8'));
const report = { snapshotAt: snapshot.auditedAt, verifiedAt: new Date().toISOString(), review: PHRASE_CATEGORY_REVIEW, languages: {} as Record<string, unknown> };
for (const language of ['de', 'es'] as const) {
  const words = snapshot.collections[language === 'de' ? 'WORDS_DE' : 'WORDS_ES'];
  const phrases = snapshot.collections[language === 'de' ? 'PHRASES_DE' : 'PHRASES_ES'];
  const surfaces = snapshot.collections.TRANSLATIONS_ES_DE.filter((surface: any) => surface.sourceLanguage === language && surface.status === 'READY');
  const index = createPhraseGrammarIndex(words, surfaces, language);
  const unresolved: unknown[] = [], combinations: Record<string, number> = {};
  let occurrences = 0;
  for (const phrase of phrases) {
    const metadata = index.forPhrase(phrase.phrase, phrase.words);
    for (const word of phrase.phrase.trim().split(/\s+/u).filter(Boolean)) {
      if (!/[\p{L}\p{N}]/u.test(word)) continue;
      occurrences++;
    }
    for (const [word, categories] of Object.entries(metadata)) {
      if (categories.includes('UNKNOWN')) unresolved.push({ phraseId: phrase._id, word, phrase: phrase.phrase });
      const combination = categories.join('+'); combinations[combination] = (combinations[combination] ?? 0) + 1;
    }
  }
  report.languages[language] = { phrases: phrases.length, tokenOccurrences: occurrences, unresolved, combinations, reviewedEntries: REVIEWED_PHRASE_CATEGORIES[language] };
  console.log(`${language}: ${phrases.length} phrases, ${occurrences} word occurrences, ${unresolved.length} unclassified spellings after manual review`);
  assert.equal(unresolved.length, 0, JSON.stringify(unresolved));
}
const output = 'docs/phrase-word-bank/coverage.json';
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('PASS complete primary phrase catalog classification using only stored/manual metadata. Saved ' + output);
