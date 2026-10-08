import type { Document } from 'mongodb';
import { initialScheduler } from '../../src/features/progress/scheduler.js';
import type { UserProgress } from '../../src/features/progress/progress.types.js';
import { dueSyncGuard } from './ankiDueSync.js';

/** Owner-confirmed repair of one unverifiable APP legacy schedule, never a bulk reset. */
export function planLegacyStudyRestart(before: UserProgress, receipts: Document[], now: Date) {
  if (before.card?.source !== 'APP' || before.anki || before.totalReviews !== undefined || !before.lastReviewed
    || before.scheduler?.phase !== 'REVIEW' || before.suspended || before.supersededByAnki)
    throw new Error('Only an active APP legacy card with unverifiable history can be restarted');
  if (receipts.some(e => !e.reversedAt)) throw new Error('An active modern review exists; inspect it before resetting');
  if (!Number.isSafeInteger(before.scheduleVersion ?? 0) || (before.scheduleVersion ?? 0) < 0 || !Number.isFinite(+now))
    throw new Error('Invalid schedule version or restart time');
  const current = before.scheduler;
  const reset = { ...before, interval: 0, repetitions: 0, totalReviews: 0, lapses: 0,
    ease: current.options.initialEase, lastReviewed: null, nextDueDate: now, isNew: true };
  const set = { interval: 0, repetitions: 0, totalReviews: 0, lapses: 0, ease: reset.ease,
    lastReviewed: null, nextDueDate: now, isNew: true, lastReviewId: null,
    scheduler: initialScheduler(reset, current.options, current.timeZone, current.rollover),
    scheduleVersion: (before.scheduleVersion ?? 0) + 1, updatedAt: now };
  return { filter: { ...dueSyncGuard(before), itemId: before.itemId, itemType: before.itemType },
    update: { $set: set, $unset: { temporaryDueDate: '', buriedUntil: '', leech: '' } },
    preserved: ['card identity and content', 'lifetime mistakes and lastFailedAt', 'undone review receipts'] };
}
