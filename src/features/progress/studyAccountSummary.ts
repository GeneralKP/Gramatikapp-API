import { ObjectId } from 'mongodb';
import { getDb, type Database } from '../../lib/database.js';
import type { UserProgress } from './progress.types.js';
import { counterFallback } from './studySummaries.js';

export interface AccountCounterBucket {
  _id: { t: string; c: boolean; r: 'missing' | 'null' | 'null-array' | 'value'; v: number; a: number };
  ids: unknown[];
}
export interface CounterCatalog {
  words: { _id: ObjectId }[];
  phrases: { _id: ObjectId }[];
}

/** Count fresh owned state without sending the request's catalog generation to
 * MongoDB. Fold identical counts/flags a second time to avoid per-card metadata. */
export function accountCounterPipeline(query: object, now: Date) {
  const due = { $ifNull: ['$temporaryDueDate', '$nextDueDate'] };
  const nullRelationArray = { $cond: [{ $isArray: '$relationId' }, { $in: [null, '$relationId'] }, false] };
  const hasCard = { $and: [
    { $ne: [{ $ifNull: ['$card', null] }, null] },
    { $not: [{ $cond: [{ $isArray: '$card' }, { $in: [null, '$card'] }, false] }] },
  ] };
  return [
    { $match: { ...query, suspended: { $ne: true }, supersededByAnki: { $ne: true },
      $and: [{ $nor: [counterFallback] }, { $or: [{ buriedUntil: null }, { buriedUntil: { $lte: now } }] }],
    } },
    { $group: { _id: {
      t: '$itemType', i: { $cond: [nullRelationArray,
        // Only these malformed arrays need both original predicate operands.
        { r: '$relationId', i: '$itemId' }, { $ifNull: ['$relationId', '$itemId'] },
      ] }, c: hasCard,
      r: { $switch: { branches: [
        { case: { $eq: [{ $type: '$relationId' }, 'missing'] }, then: 'missing' },
        { case: { $eq: ['$relationId', null] }, then: 'null' },
        { case: nullRelationArray, then: 'null-array' },
      ], default: 'value' } },
    },
    v: { $sum: { $cond: [{ $and: [{ $eq: ['$scheduler.phase', 'REVIEW'] }, { $lte: [due, now] }] }, 1, 0] } },
    a: { $sum: { $cond: [{ $and: [{ $in: ['$scheduler.phase', ['LEARNING', 'RELEARNING']] }, { $lte: [due, now] }] }, 1, 0] } },
    } },
    { $match: { $or: [{ v: { $gt: 0 } }, { a: { $gt: 0 } }] } },
    { $group: { _id: { t: '$_id.t', c: '$_id.c', r: '$_id.r', v: '$v', a: '$a' }, ids: { $push: '$_id.i' } } },
  ];
}

// Mongo's ObjectId $in predicate does not match a string with the same spelling.
// Scalar ObjectId predicates match only direct array elements, never nested IDs.
const matchesIds = (id: unknown, ids: Set<string>): boolean => id instanceof ObjectId ? ids.has(String(id))
  : Array.isArray(id) && id.some(value => value instanceof ObjectId && ids.has(String(value)));
export function accountCounterTotals(buckets: AccountCounterBucket[], catalog: CounterCatalog, categoryIds: ObjectId[] | null) {
  const words = new Set(catalog.words.map(row => String(row._id))), phrases = new Set(catalog.phrases.map(row => String(row._id)));
  const category = categoryIds === null ? null : new Set(categoryIds.map(String));
  let review = 0, learning = 0;
  for (const { _id: flags, ids } of buckets) {
    const references = flags.t === 'WORD' ? words : flags.t === 'PHRASE' ? phrases : undefined;
    for (const id of ids) {
      const relationArray = flags.r === 'null-array' ? id as { r: unknown; i: unknown } : undefined;
      const primary = relationArray ? relationArray.r : id;
      if (!flags.c && (!references || !(matchesIds(primary, references) || relationArray && matchesIds(relationArray.i, references)))) continue;
      // Catalog fallback includes direct null array elements. Category fallback
      // remains missing-only, so it must use the original relation array here.
      if (category && (flags.r === 'null' || !matchesIds(primary, category))) continue;
      review += flags.v; learning += flags.a;
    }
  }
  return { review, learning };
}

const requests = new WeakMap<object, Map<string, Promise<AccountCounterBucket[]>>>();
/** Reuse owned state only inside this request; catalogs/categories are applied
 * separately so a later database catalog generation cannot alter this result. */
export function studyAccountCounterBuckets(context: object, userId: ObjectId, now: Date, itemType?: UserProgress['itemType'], db: Database = getDb()) {
  let owners = requests.get(context);
  if (!owners) requests.set(context, owners = new Map());
  const key = `${userId}:${itemType ?? 'ALL'}`;
  let result = owners.get(key);
  if (!result) {
    const query = { userId, ...(itemType ? { itemType } : {}), $or: [
      { nextDueDate: { $lte: now } }, { temporaryDueDate: { $lte: now } },
      { 'scheduler.phase': { $in: ['NEW', 'LEARNING', 'RELEARNING'] } }, { scheduler: null },
    ] };
    owners.set(key, result = db.progress.aggregate<AccountCounterBucket>(accountCounterPipeline(query, now)).toArray());
  }
  return result;
}
