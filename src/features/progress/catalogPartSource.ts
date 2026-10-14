import type { Document } from 'mongodb';
import type { Database } from '../../lib/database.js';
import { catalogSummaryCache, type CatalogPart, type CatalogSource } from './catalogSummaryCache.js';

// One public-only descriptor per part. Snapshot and compact validation always
// use these same filters/projections; private card/progress data is excluded.
export const CATALOG_PART_DESCRIPTORS = {
  words: { collection: 'relationsWordsEsDe', filter: {}, projection: { _id: 1, main: 1, translated: 1 } },
  phrases: { collection: 'relationsPhrasesEsDe', filter: {}, projection: { _id: 1, main: 1, translated: 1 } },
  wordMeta: { collection: 'wordsES', filter: {}, projection: { _id: 1, word: 1, contexts: 1, level: 1, examples: 1 } },
  phraseMeta: { collection: 'phrasesES', filter: {}, projection: { _id: 1, phrase: 1, contexts: 1, level: 1 } },
  wordTextDe: { collection: 'wordsDE', filter: {}, projection: { _id: 1, word: 1, cefrLevel: 1, gramaticalCategories: 1, 'forms.gender': 1, 'forms.past': 1, 'forms.perfect': 1, 'forms.imperativ': 1, notes: 1, examples: 1 } },
  phraseTextDe: { collection: 'phrasesDE', filter: {}, projection: { _id: 1, phrase: 1, cefrLevel: 1, synonyms: 1, words: 1 } },
  grammarSurfaceDe: { collection: 'translationsEsDe', filter: { sourceLanguage: 'de', targetLanguage: 'es', status: 'READY' }, projection: { _id: 0, key: 1, category: 1 } },
} as const;
const CATALOG_BATCH_SIZE = 5000;

function normalized(value: string, depth: number): Document {
  const type = { $type: value };
  const branches: Document[] = [{ case: { $in: [type, ['int', 'long', 'double', 'decimal']] }, then: { $toString: value } }];
  if (depth > 0) {
    branches.push({ case: { $eq: [type, 'array'] }, then: { $map: { input: value, as: `item${depth}`, in: normalized(`$$item${depth}`, depth - 1) } } });
    branches.push({ case: { $eq: [type, 'object'] }, then: { $map: { input: { $objectToArray: value }, as: `field${depth}`, in: { key: `$$field${depth}.k`, value: normalized(`$$field${depth}.v`, depth - 1) } } } });
  }
  return { type, value: { $switch: { branches, default: { $ifNull: [value, null] } } } };
}

// The projected schema is scalars, scalar arrays and forms scalar leaves. The
// extra level also covers one nested array/object. Wrapping numeric leaves with
// BSON type/string prevents hashed-index floating-point truncation; missing
// fields remain absent and ObjectIds keep their BSON type. Both reads hash the
// projected BSON in Mongo, never reconstructed JavaScript rows.
const normalizedRow = normalized('$$ROOT', 3);
function hashPipeline(part: CatalogPart): Document[] {
  const { filter, projection } = CATALOG_PART_DESCRIPTORS[part];
  return [
    { $match: filter }, { $project: projection },
    { $replaceWith: { $let: { vars: { normalized: normalizedRow }, in: {
      row: '$$ROOT',
      hashA: { $toHashedIndexKey: ['catalog-summary:a:v1', '$$normalized'] },
      hashB: { $toHashedIndexKey: ['catalog-summary:b:v1', '$$normalized'] },
    } } } },
  ];
}
function signature(count: string, checksumA: string, checksumB: string): string { return JSON.stringify([count, checksumA, checksumB]); }

export function createCatalogPartSource<T>(db: Database, part: CatalogPart): CatalogSource<T> {
  const collection = db[CATALOG_PART_DESCRIPTORS[part].collection];
  return {
    async loadSnapshot() {
      const wrapped = await collection.aggregate<{ row: T; hashA: string; hashB: string }>([
        ...hashPipeline(part), { $project: { _id: 0, row: 1, hashA: { $toString: '$hashA' }, hashB: { $toString: '$hashB' } } },
      ]).batchSize(CATALOG_BATCH_SIZE).toArray();
      let checksumA = 0n, checksumB = 0n;
      for (const row of wrapped) { checksumA += BigInt(row.hashA); checksumB += BigInt(row.hashB); }
      return { rows: wrapped.map(row => row.row), signature: signature(String(wrapped.length), String(checksumA), String(checksumB)) };
    },
    async readSignature() {
      const rows = await collection.aggregate<{ count: string; checksumA: string; checksumB: string }>([
        ...hashPipeline(part),
        { $group: { _id: null, count: { $sum: 1 }, checksumA: { $sum: { $toDecimal: '$hashA' } }, checksumB: { $sum: { $toDecimal: '$hashB' } } } },
        { $project: { _id: 0, count: { $toString: '$count' }, checksumA: { $toString: '$checksumA' }, checksumB: { $toString: '$checksumB' } } },
      ]).toArray();
      const row = rows[0];
      return row ? signature(row.count, row.checksumA, row.checksumB) : signature('0', '0', '0');
    },
  };
}

export function readCatalogPart<T>(db: Database, part: CatalogPart, refresh = false): Promise<T[]> {
  return catalogSummaryCache[refresh ? 'refresh' : 'read'](db, part, createCatalogPartSource<T>(db, part));
}
