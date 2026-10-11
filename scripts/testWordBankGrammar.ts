import assert from 'node:assert/strict';
import { BANK_CATEGORIES, availableBankCategories, orderedBankTiles, categoriesForTile, orderedCategories } from '../src/features/phrases/wordBankGrammar.js';

assert.deepEqual(BANK_CATEGORIES.slice(0, 8), ['ARTICLE', 'PREPOSITION', 'PRONOUN', 'PARTICLE', 'CONJUNCTION', 'VERB', 'NOUN', 'ADJECTIVE'], 'the owner’s requested grammar order is shared by both clients');
const tiles = [
  { id: 'verb', word: 'lerne', categories: ['VERB'] },
  { id: 'article-b', word: 'die', categories: ['ARTICLE', 'PRONOUN'] },
  { id: 'noun-b', word: 'Zug.', categories: ['NOUN'] },
  { id: 'article-a', word: 'die', categories: ['PRONOUN', 'ARTICLE'] },
  { id: 'noun-a', word: 'Haus', categories: ['NOUN'] },
  { id: 'comma', word: ',' },
  { id: 'preposition', word: 'mit', categories: ['PREPOSITION'] },
  { id: 'particle', word: 'doch', categories: ['ADVERB', 'PARTICLE'] },
];
const ordered = orderedBankTiles(tiles);
assert.deepEqual(ordered.map(tile => tile.id), ['article-b', 'article-a', 'preposition', 'particle', 'verb', 'noun-a', 'noun-b', 'comma']);
assert.equal(ordered.length, tiles.length, 'multiple roles never duplicate an occurrence');
assert.deepEqual(orderedBankTiles(tiles, 'PRONOUN').map(tile => tile.id), ['article-b', 'article-a'], 'a multi-role tile is available under every matching filter');
assert.deepEqual(orderedBankTiles(tiles, 'ADVERB').map(tile => tile.id), ['particle']);
assert.deepEqual(availableBankCategories(tiles), ['ARTICLE', 'PREPOSITION', 'PRONOUN', 'PARTICLE', 'VERB', 'NOUN', 'ADVERB', 'PUNCTUATION']);
assert.equal(tiles[0].id, 'verb', 'presentation sorting does not mutate the bank or identities');
assert.deepEqual(orderedBankTiles(BANK_CATEGORIES.toReversed().map(category => ({id: category, word: category === 'PUNCTUATION' ? ',' : category, categories: [category]}))).map(tile => tile.id), [...BANK_CATEGORIES], 'remaining categories follow the same deterministic order');
assert.deepEqual(categoriesForTile('Zug.', { Zug: ['NOUN'] }), ['NOUN'], 'attached punctuation does not lose metadata');
assert.deepEqual(categoriesForTile(',', {}), ['PUNCTUATION']);
assert.deepEqual(categoriesForTile('19', {}), ['NUMERAL']);
assert.deepEqual(categoriesForTile('unbekannt', {}), ['UNKNOWN'], 'unseen personal text remains usable without classification calls');
assert.deepEqual(categoriesForTile('Haus', { Haus: null } as never), ['UNKNOWN'], 'invalid cached metadata stays usable');
assert.deepEqual(orderedBankTiles([
  { id: 'lower', word: 'die', categories: ['ARTICLE'] },
  { id: 'upper', word: 'Die', categories: ['ARTICLE'] },
]).map(tile => tile.word), ['Die', 'die'], 'case ties are deterministic despite the initial shuffle');
assert.deepEqual(orderedCategories(['UNKNOWN', 'VERB', 'VERB', 'BAD']), ['VERB']);
console.log('PASS flat grammatical bank: owner order, alphabetical ties, all-role filters, duplicate identity, punctuation, numbers and safe fallback');
