import type { BankCategory } from './wordBankGrammar.js';

/** Manual review of the 11 October 2026 primary phrase catalog. Never calls a classifier. */
export const PHRASE_CATEGORY_REVIEW = {
  reviewedAt: '2026-10-11',
  sources: [
    'https://www.duden.de/sprachwissen/fuer-lernende/wortarten-numerale',
    'https://grammis.ids-mannheim.de/systematische-grammatik/279',
    'https://grammis.ids-mannheim.de/systematische-grammatik/563',
    'https://dle.rae.es/',
    'https://www.asale.org/damer/quiubo/',
  ],
  policy: 'Prefer stored phrase-linked senses. Retain legitimate multiple roles. Fill missing forms from this manual review; augment German particles. Proper names belong to NOUN. These are lexical roles, not a claim of syntactic parsing.',
} as const;

type Review = { word: string; categories: BankCategory[]; augment?: boolean };
const entries = (words: string, categories: BankCategory[], augment = false): Review[] =>
  words.split('|').map(word => ({ word, categories, ...(augment ? { augment: true } : {}) }));

export const REVIEWED_PHRASE_CATEGORIES: Record<'de' | 'es', Review[]> = {
  de: [
    ...entries('zehn|drei|vier|sechzig|zwei|acht|neunzig', ['NUMERAL']),
    ...entries('erster', ['ADJECTIVE', 'NUMERAL']),
    ...entries('tiefe|deutschen|moderne', ['ADJECTIVE']),
    ...entries('gefallen|fragen|treffen', ['VERB']),
    ...entries('Glauben', ['VERB', 'NOUN']),
    ...entries('Gorgias|Cialdini|Zajonc|Diomedes|Díaz|Anna|Freud|Milgram|Hamburg|Köln', ['NOUN']),
    // Separable verb component in "stellt ... dar"; not an independent preposition.
    ...entries('dar', ['PARTICLE']),
    ...entries('zu', ['PREPOSITION', 'ADVERB', 'PARTICLE'], true),
    ...entries('nicht|nur|auch|eben|schon|wohl|mal', ['ADVERB', 'PARTICLE'], true),
    ...entries('doch', ['CONJUNCTION', 'ADVERB', 'PARTICLE'], true),
    ...entries('denn', ['CONJUNCTION', 'PARTICLE'], true),
    ...entries('ja|nein', ['INTERJECTION', 'PARTICLE'], true),
    ...entries('halt', ['PARTICLE'], true),
  ],
  es: [
    ...entries('diez|tres|cuatro|sesenta|ciento|dos|ocho|cero|noventa', ['NUMERAL']),
    ...entries('cientos|millones', ['NOUN', 'NUMERAL']),
    ...entries('tarde', ['ADVERB', 'NOUN']),
    ...entries('aunque', ['CONJUNCTION']),
    ...entries('GPS|responsabilidad|sostenibilidad|salud|valor|Bahn|klingon|Gorgias|Cialdini|Zajonc|Diomedes|Díaz|Dunning-Kruger|Anna|Freud|Overton|Milgram|Hamburgo|Colonia', ['NOUN']),
    ...entries('presentes|político|paciente', ['NOUN', 'ADJECTIVE']),
    ...entries('hasta', ['PREPOSITION', 'ADVERB']),
    ...entries('sin|con', ['PREPOSITION']),
    ...entries('contra', ['PREPOSITION', 'NOUN']),
    ...entries('nota', ['VERB', 'NOUN']),
    ...entries('acusado', ['VERB', 'NOUN', 'ADJECTIVE']),
    ...entries('imposible|difícil|tecnológico|democrático|estable', ['ADJECTIVE']),
    ...entries('ignorar', ['VERB']),
    ...entries('cómo|probablemente', ['ADVERB']),
    ...entries('reservado|experimentado', ['VERB', 'ADJECTIVE']),
    ...entries('contigo|conmigo', ['PRONOUN']),
    ...entries('bajo', ['PREPOSITION', 'VERB', 'NOUN', 'ADJECTIVE', 'ADVERB']),
    ...entries('medida', ['VERB', 'NOUN', 'ADJECTIVE']),
    ...entries('extraña', ['VERB', 'NOUN', 'ADJECTIVE']),
    // A foreign company name in the Spanish sentence; preserve its German adjective role too.
    ...entries('Deutsche', ['NOUN', 'ADJECTIVE']),
    ...entries('quiubo', ['INTERJECTION']),
  ],
};
