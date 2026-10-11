/** Shared presentation contract. Generated into both clients; no provider or database dependencies. */
export const BANK_CATEGORIES = [
  'ARTICLE',
  'PREPOSITION',
  'PRONOUN',
  'PARTICLE',
  'CONJUNCTION',
  'VERB',
  'NOUN',
  'ADJECTIVE',
  'ADVERB',
  'NUMERAL',
  'INTERJECTION',
  'PUNCTUATION',
  'UNKNOWN',
] as const;
export type BankCategory = (typeof BANK_CATEGORIES)[number];
export type WordCategories = Record<string, string[]>;
const categoryOrder = new Map<string, number>(
  BANK_CATEGORIES.map((category, index) => [category, index]),
);
const collator = new Intl.Collator('de', {
  sensitivity: 'base',
  numeric: true,
});
const tieCollator = new Intl.Collator('de', {
  sensitivity: 'variant',
  caseFirst: 'upper',
  numeric: true,
});

export function cleanBankWord(word: string): string {
  return word
    .normalize('NFC')
    .trim()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
}
export function orderedCategories(categories: readonly string[] = []): BankCategory[] {
  const known = [...new Set(Array.isArray(categories) ? categories : [])].filter(
    (category) => categoryOrder.has(category) && category !== 'UNKNOWN',
  );
  return (known.length ? known : ['UNKNOWN']).sort(
    (a, b) => categoryOrder.get(a)! - categoryOrder.get(b)!,
  ) as BankCategory[];
}
export function categoriesForTile(word: string, metadata: WordCategories = {}): BankCategory[] {
  if (!/[\p{L}\p{N}]/u.test(word)) return ['PUNCTUATION'];
  const clean = cleanBankWord(word);
  if (/^\d+(?:[.,]\d+)*$/u.test(clean)) return ['NUMERAL'];
  return orderedCategories(Object.hasOwn(metadata, clean) ? metadata[clean] : []);
}
type CategorizedTile = { id: string; word: string; categories?: string[] };
function tileCategories(tile: CategorizedTile): BankCategory[] {
  return !/[\p{L}\p{N}]/u.test(tile.word) ? ['PUNCTUATION'] : orderedCategories(tile.categories);
}
export function availableBankCategories(tiles: readonly CategorizedTile[]): BankCategory[] {
  const present = new Set(tiles.flatMap(tileCategories));
  return BANK_CATEGORIES.filter((category) => present.has(category));
}
/** One flat bank: earliest matching role, then German alphabetical order.
 * Filters match every valid role and alphabetize the resulting list. */
export function orderedBankTiles<T extends CategorizedTile>(
  tiles: readonly T[],
  category?: BankCategory | null,
): T[] {
  return tiles
    .map((tile) => ({ tile, categories: tileCategories(tile) }))
    .filter((entry) => !category || entry.categories.includes(category))
    .sort((a, b) => {
      const priority = category
        ? 0
        : categoryOrder.get(a.categories[0])! - categoryOrder.get(b.categories[0])!;
      const left = cleanBankWord(a.tile.word),
        right = cleanBankWord(b.tile.word);
      return priority || collator.compare(left, right) || tieCollator.compare(left, right);
    })
    .map((entry) => entry.tile);
}
