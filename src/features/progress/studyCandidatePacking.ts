import { BSON, MongoServerError, type Collection, type Document, type Filter, type ObjectId } from 'mongodb';
import type { UserProgress } from './progress.types.js';

export interface PackedStudyCandidates {
  states: UserProgress[];
  options: { options: NonNullable<UserProgress['scheduler']>['options']; members: ObjectId[] }[];
}

// Ordinary deck options contain booleans, numbers and flat numeric arrays.
// Mongo groups numeric BSON types by value and strings using the collection's
// collation. Keep uncommon BSON/nested/string options intact in their state:
// grouping Decimal128/Long, negative zero or nested extras could lose the exact
// original decoded value. Integer/double equal finite values both decode
// to Number, so deduplicating them preserves the original driver contract.
function ordinaryOptionNumber(value: string): Document {
  return { $or: [
    { $eq: [{ $type: value }, 'int'] },
    { $and: [
      { $eq: [{ $type: value }, 'double'] },
      { $ne: [value, 0] },
      { $not: [{ $in: [{ $convert: { input: value, to: 'string', onError: 'unsupported', onNull: 'unsupported' } }, ['NaN', 'Infinity', '-Infinity']] }] },
    ] },
  ] };
}

const ordinaryOptions: Document = { $cond: [
  { $eq: [{ $type: '$scheduler.options' }, 'object'] },
  { $allElementsTrue: [{ $map: {
    input: { $objectToArray: '$scheduler.options' }, as: 'field',
    in: { $or: [
      { $eq: [{ $type: '$$field.v' }, 'bool'] },
      ordinaryOptionNumber('$$field.v'),
      { $cond: [
        { $isArray: '$$field.v' },
        { $allElementsTrue: [{ $map: { input: '$$field.v', as: 'number', in: ordinaryOptionNumber('$$number') } }] },
        false,
      ] },
    ] },
  } }] },
  false,
] };

/** Preserve the original match/projection cursor before the order-preserving
 * state facet. Never flatten profile groups or limit candidates before queue
 * selection; membership uses progress _id, not colliding typed itemId values. */
export function studyCandidatePackingPipeline(filter: object, projection: Record<string, number>): Document[] {
  return [
    { $match: filter },
    { $project: projection },
    { $replaceWith: { state: '$$ROOT', packed: ordinaryOptions } },
    { $facet: {
      states: [{ $replaceWith: { $cond: [
        '$packed',
        { $mergeObjects: ['$state', { scheduler: { $arrayToObject: { $filter: {
          input: { $objectToArray: '$state.scheduler' }, as: 'field', cond: { $ne: ['$$field.k', 'options'] },
        } } } }] },
        '$state',
      ] } }],
      options: [
        { $match: { packed: true } },
        { $group: { _id: '$state.scheduler.options', members: { $push: '$state._id' } } },
        { $project: { _id: 0, options: '$_id', members: 1 } },
      ],
    } },
  ];
}

/** Reattach before normalization, predictions and queue selection. Each row
 * owns its options (including nested arrays), as on the original find cursor. */
export function unpackStudyCandidates(packed: PackedStudyCandidates): UserProgress[] {
  // Mongo permits distinct BSON primary keys with equal String values,
  // including ObjectId/string pairs and document-valued identities.
  const primaryIdKey = (id: unknown) => Buffer.from(BSON.serialize({ _id: id })).toString('base64');
  const byId = new Map(packed.states.map(state => [primaryIdKey(state._id), state]));
  for (const group of packed.options) {
    const encoded = BSON.serialize({ options: group.options });
    for (const id of group.members) {
      const state = byId.get(primaryIdKey(id));
      if (!state?.scheduler) throw new Error('Invalid packed study candidate membership');
      state.scheduler.options = BSON.deserialize(encoded).options;
    }
  }
  return packed.states;
}

// BSONObjectTooLarge; ExceededMemoryLimit; no-disk-use group memory; facet
// output memory; $push accumulator memory. Do not hide auth, syntax, timeout
// or network errors behind another read. $facet itself cannot spill to disk.
const PACKING_LIMIT_CODES = new Set([10334, 146, 292, 4031700]);

/** One fresh owner-scoped Mongo read normally; an identified aggregate limit
 * retries the exact original compatible find/projection/batch-size cursor. */
export async function readPackedStudyCandidates(
  collection: Collection<UserProgress>, filter: object, projection: Record<string, number>, batchSize = 5000,
): Promise<UserProgress[]> {
  let rows: PackedStudyCandidates[];
  try {
    rows = await collection.aggregate<PackedStudyCandidates>(studyCandidatePackingPipeline(filter, projection))
      .batchSize(batchSize).toArray();
  } catch (error) {
    if (!(error instanceof MongoServerError) || !PACKING_LIMIT_CODES.has(error.code as number)) throw error;
    return collection.find(filter as Filter<UserProgress>).project<UserProgress>(projection).batchSize(batchSize).toArray();
  }
  return unpackStudyCandidates(rows[0] ?? { states: [], options: [] });
}
