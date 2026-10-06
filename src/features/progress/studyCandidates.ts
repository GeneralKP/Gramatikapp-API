import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import type { UserProgress } from "./progress.types.js";
import { STUDY_SUMMARY_BATCH_SIZE } from "./studyLoading.js";

const atOrBefore = (value: Date | undefined, cutoff: Date) => value != null && typeof value.getTime === "function" && value.getTime() <= cutoff.getTime();

/** These predicates mirror the existing Mongo views before any scheduling/pairing. */
export function isCountStudyCandidate(progress: UserProgress, now: Date) {
  return atOrBefore(progress.nextDueDate, now) || atOrBefore(progress.temporaryDueDate, now)
    || ["NEW", "LEARNING", "RELEARNING"].includes(progress.scheduler?.phase) || progress.scheduler == null;
}

export function isDueStudyCandidate(progress: UserProgress, now: Date, categoryIds: ReadonlySet<string> | null) {
  if (progress.suspended === true || progress.supersededByAnki === true) return false;
  if (categoryIds !== null && !(progress.relationId instanceof ObjectId && categoryIds.has(String(progress.relationId))
    || progress.relationId === undefined && progress.itemId instanceof ObjectId && categoryIds.has(String(progress.itemId)))) return false;
  return atOrBefore(progress.temporaryDueDate, now)
    || progress.temporaryDueDate == null && atOrBefore(progress.nextDueDate, new Date(now.getTime() + 1_200_000))
    || progress.isNew === true;
}

export function combinedStudyCandidateFilter(userId: ObjectId, itemType: UserProgress["itemType"] | undefined, now: Date) {
  return { userId, ...(itemType ? { itemType } : {}), $or: [
    { suspended: { $ne: true }, supersededByAnki: { $ne: true }, $or: [
      { temporaryDueDate: { $lte: now } },
      { temporaryDueDate: null, nextDueDate: { $lte: new Date(now.getTime() + 1_200_000) } },
      { isNew: true },
    ] },
    { $or: [
      { nextDueDate: { $lte: now } }, { temporaryDueDate: { $lte: now } },
      { "scheduler.phase": { $in: ["NEW", "LEARNING", "RELEARNING"] } },
      { scheduler: null },
    ] },
  ] };
}

/** One fresh owner-scoped read; each consumer still applies its original view. */
export async function combinedStudyCandidates(userId: ObjectId, itemType: UserProgress["itemType"] | undefined, now: Date, projection: Record<string, number>) {
  return getDb().progress.find(combinedStudyCandidateFilter(userId, itemType, now)).project<UserProgress>(projection).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray();
}
