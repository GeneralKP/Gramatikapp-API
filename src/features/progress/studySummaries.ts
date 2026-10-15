import { ObjectId } from 'mongodb';
import type { UserProgress } from './progress.types.js';
import { STUDY_STATUS_PROJECTION, isGraduatedStudyCard, type StudyStatusSnapshot } from './studyStatus.js';

// Unknown/legacy schedulers and zero-interval reviews retain the original JS
// compatibility path. Known learning/review totals can be counted in MongoDB.
export const counterFallback = { $or: [
  { 'scheduler.phase': { $nin: ['LEARNING', 'RELEARNING', 'REVIEW'] } },
  { 'scheduler.phase': 'REVIEW', interval: 0 },
] };

export type StudyIdentity = Pick<UserProgress, 'itemId' | 'relationId' | 'itemType'> & (StudyStatusSnapshot | { graduated: boolean });
export function isGraduatedStudyIdentity(row: StudyIdentity) {
  return 'graduated' in row ? row.graduated : isGraduatedStudyCard(row);
}

/** Fresh allocation exclusions need one typed relation identity, not both
 * directional schedules. Hash grouping keeps legacy/null relation fallbacks. */
export function newItemIdentityPipeline(query: object) {
  return [
    { $match: query },
    { $group: { _id: { itemType: '$itemType', itemId: { $ifNull: ['$relationId', '$itemId'] } } } },
    { $group: { _id: '$_id.itemType', itemIds: { $push: '$_id.itemId' } } },
  ];
}

/** Fold directional mastery identities; legacy phases retain code inference. */
export function identitySummaryPipeline(query: object) {
  return [
    { $match: query },
    { $facet: {
      known: [
        { $match: { 'scheduler.phase': { $in: ['NEW', 'LEARNING', 'RELEARNING', 'REVIEW'] } } },
        { $group: { _id: { itemId: { $ifNull: ['$relationId', '$itemId'] }, itemType: '$itemType' },
          interval: { $max: { $cond: [{ $and: [{ $eq: ['$scheduler.phase', 'REVIEW'] }, { $gte: ['$interval', 1] }] }, 1, 0] } },
        } },
        { $group: { _id: { itemType: '$_id.itemType', graduated: { $gt: ['$interval', 0] } }, itemIds: { $push: '$_id.itemId' } } },
      ],
      legacy: [
        { $match: { 'scheduler.phase': { $nin: ['NEW', 'LEARNING', 'RELEARNING', 'REVIEW'] } } },
        { $project: { _id: 0, itemId: 1, relationId: 1, itemType: 1, ...STUDY_STATUS_PROJECTION } },
      ],
    } },
  ];
}

export interface PackedNewItemIdentity { _id: UserProgress['itemType']; itemIds: ObjectId[]; }
export function unpackNewItemIdentities(rows: PackedNewItemIdentity[]): Pick<UserProgress, 'itemType' | 'itemId' | 'relationId'>[] {
  return rows.flatMap(row => row.itemIds.map(itemId => ({ itemType: row._id, itemId })));
}
export interface PackedStudyIdentities {
  known: { _id: { itemType: UserProgress['itemType']; graduated: boolean }; itemIds: ObjectId[] }[];
  legacy: StudyIdentity[];
}
export function unpackStudyIdentities(rows: PackedStudyIdentities[]): StudyIdentity[] {
  return [...(rows[0]?.known ?? []).flatMap(row => row.itemIds.map(itemId => ({ ...row._id, itemId }))), ...(rows[0]?.legacy ?? [])];
}
