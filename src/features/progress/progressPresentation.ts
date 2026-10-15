import type { UserProgress } from "./progress.types.js";
import { initialScheduler, schedulerSeed } from "./scheduler.js";
import { effectiveDueDate } from "./studyScheduling.js";

/** Format a response without saving legacy defaults into stored progress. */
export function toGraphQLProgress(progress: UserProgress | null) {
  if (!progress) return null;
  const scheduler = progress.scheduler ?? initialScheduler(progress);
  return {
    ...progress,
    id: progress._id.toString(),
    userId: progress.userId.toString(),
    itemId: progress.itemId.toString(),
    itemType: progress.itemType,
    relationId: progress.relationId?.toString(),
    failureIndex: progress.failureIndex ?? 0,
    totalReviews: progress.totalReviews ?? 0,
    scheduleVersion: progress.scheduleVersion ?? 0,
    studyState: JSON.stringify({
      itemId: String(progress.itemId),
      itemType: progress.itemType,
      ease: progress.ease,
      interval: progress.interval,
      repetitions: progress.repetitions,
      nextDueDate: progress.nextDueDate,
      temporaryDueDate: progress.temporaryDueDate,
      lastReviewed: progress.lastReviewed,
      createdAt: progress.createdAt,
      scheduler,
      totalReviews: progress.totalReviews ?? 0,
      lapses: progress.lapses ?? 0,
      isNew: progress.isNew,
      suspended: progress.suspended,
      buriedUntil: progress.buriedUntil,
      fuzzSeed: schedulerSeed(progress).toString(),
      card: progress.card ? {
        sourceCardId: progress.card.sourceCardId,
        sourceNoteGuid: progress.card.sourceNoteGuid,
        direction: progress.card.direction,
      } : undefined,
    }),
    schedulerPhase: scheduler.phase,
    learningQueue: scheduler.queue,
    learnAheadSeconds: scheduler.options.learnAheadSeconds,
    lapses: progress.lapses ?? 0,
    lastFailedAt: progress.lastFailedAt?.toISOString() ?? null,
    nextDueDate: effectiveDueDate(progress).toISOString(),
    regularDueDate: progress.nextDueDate.toISOString(),
    temporaryDueDate: progress.temporaryDueDate?.toISOString() ?? null,
    lastReviewed: progress.lastReviewed?.toISOString() || null,
  };
}
