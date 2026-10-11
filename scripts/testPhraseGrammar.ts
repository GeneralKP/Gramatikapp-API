import assert from 'node:assert/strict';
import { createPhraseGrammarIndex } from '../src/features/phrases/phraseGrammar.js';

const words = [
  { _id: 'a', word: 'die', gramaticalCategories: ['ARTICLE', 'PRONOUN'] },
  { _id: 'n', word: 'Glauben', gramaticalCategories: ['NOUN'] },
  { _id: 'v', word: 'glauben', gramaticalCategories: ['VERB'] },
  { _id: 'h', word: 'Haus', gramaticalCategories: ['NOUN'] },
];
const index = createPhraseGrammarIndex(words, [{ key: 'lernt', category: 'VERB' }], 'de');
assert.deepEqual(index.forPhrase('Die lernt zehn Wörter, glauben an Glauben.', ['a']), {
  Die: ['ARTICLE', 'PRONOUN'], lernt: ['VERB'], zehn: ['NUMERAL'], Wörter: ['UNKNOWN'],
  glauben: ['VERB'], an: ['UNKNOWN'], Glauben: ['VERB', 'NOUN'],
});
assert.deepEqual(index.forPhrase('Cialdini stellt dar.', []), { Cialdini: ['NOUN'], stellt: ['UNKNOWN'], dar: ['PARTICLE'] });
assert.deepEqual(index.forPhrase('die die', ['a']), { die: ['ARTICLE', 'PRONOUN'] });
assert.deepEqual(index.forPhrase('neues Wort', [], true), { neues: ['UNKNOWN'] }, 'pending shells need only their first distractor token');
console.log('PASS phrase metadata: dictionary/surface/manual categories, German noun case, multiple roles and compact distractor hints');
