import { ObjectId } from 'mongodb';
import type { UserProgress } from './progress.types.js';
import { STUDY_STATUS_PROJECTION, isGraduatedStudyCard, type StudyStatusSnapshot } from './studyStatus.js';

// Unknown/legacy schedulers and zero-interval reviews retain the original JS
// compatibility path. Known learning/review totals can be counted in MongoDB.
export const counterFallback = { $or: [
  { 'scheduler.phase': { $nin: ['LEARNING', 'RELEARNING', 'REVIEW'] } },
  { 'scheduler.phase': 'REVIEW', interval: 0 },
] };

export function counterSummaryPipeline(query: object, eligible: object, now: Date) {
  const phase = '$scheduler.phase';
  const due = { $ifNull: ['$temporaryDueDate', '$nextDueDate'] };
  const learningCutoff = { $cond: [
    { $eq: ['$scheduler.queue', 'MINUTE'] },
    { $add: [now, { $multiply: [{ $ifNull: ['$scheduler.options.learnAheadSeconds', 0] }, 1000] }] }, now,
  ] };
  return [
    { $match: { ...query, $and: [{ $nor: [counterFallback] }, eligible] } },
    { $group: { _id: null,
      review: { $sum: { $cond: [{ $and: [{ $eq: [phase, 'REVIEW'] }, { $lte: [due, now] }] }, 1, 0] } },
      learning: { $sum: { $cond: [{ $and: [{ $in: [phase, ['LEARNING', 'RELEARNING']] }, { $lte: ['$nextDueDate', learningCutoff] }] }, 1, 0] } },
    } },
  ];
}

export type StudyIdentity = Pick<UserProgress, 'itemId' | 'relationId' | 'itemType'> & (StudyStatusSnapshot | { graduated: boolean });
export function isGraduatedStudyIdentity(row: StudyIdentity) {
  return 'graduated' in row ? row.graduated : isGraduatedStudyCard(row);
}

/** Fold known directional duplicates in the database; legacy phase inference
 * still uses the scheduler's existing code after transfer. No state is saved. */
export function identitySummaryPipeline(query: object) {
  return [
    { $match: query },
    { $facet: {
      known: [
        { $match: { 'scheduler.phase': { $in: ['NEW', 'LEARNING', 'RELEARNING', 'REVIEW'] } } },
        { $group: { _id: { itemId: { $ifNull: ['$relationId', '$itemId'] }, itemType: '$itemType' },
          interval: { $max: { $cond: [{ $and: [{ $eq: ['$scheduler.phase', 'REVIEW'] }, { $gte: ['$interval', 1] }] }, 1, 0] } },
        } },
        { $project: { _id: 0, itemId: '$_id.itemId', itemType: '$_id.itemType', graduated: { $gt: ['$interval', 0] } } },
      ],
      legacy: [
        { $match: { 'scheduler.phase': { $nin: ['NEW', 'LEARNING', 'RELEARNING', 'REVIEW'] } } },
        { $project: { _id: 0, itemId: 1, relationId: 1, itemType: 1, ...STUDY_STATUS_PROJECTION } },
      ],
    } },
  ];
}

export function counterEligibility(now: Date, categoryIds: ObjectId[] | null, catalog: { words: { _id: ObjectId }[]; phrases: { _id: ObjectId }[] }) {
  return { suspended: { $ne: true }, supersededByAnki: { $ne: true },
    $and: [
      { $or: [{ buriedUntil: null }, { buriedUntil: { $lte: now } }] },
      { $or: [
        { card: { $ne: null } },
        ...([['WORD', catalog.words], ['PHRASE', catalog.phrases]] as const).map(([itemType, rows]) => ({ itemType, $or: [
          { relationId: { $in: rows.map(row => row._id) } },
          { relationId: null, itemId: { $in: rows.map(row => row._id) } },
        ] })),
      ] },
      ...(categoryIds === null ? [] : [{ $or: [{ relationId: { $in: categoryIds } }, { relationId: { $exists: false }, itemId: { $in: categoryIds } }] }]),
    ],
  };
}
