import type { UserProgress } from './progress.types.js';
import { GRADES, dateForStudyDay, initialScheduler, normalizeUnstudiedProgress, scheduleReview, studyDay, type Grade } from './scheduler.js';
export type StudyGrade = Grade | 'REVISIT' | 'KNOWN';
export const PHRASE_FIRST_INTERVALS = { AGAIN: 7, HARD: 30, GOOD: 180, EASY: 365 };
// Minutes for learning steps; days for graduation and the lapse interval.
export const PHRASE_SCHEDULING_PRESET = {
  // Anki averages the first two steps for Hard: (7 + 53) / 2 = 30 days.
  learningSteps: [7 * 1440, 53 * 1440], relearningSteps: [7 * 1440, 14 * 1440],
  graduatingGood: 180, graduatingEasy: 365, minimumLapseInterval: 21,
};
export const effectiveDueDate = (progress: UserProgress) => progress.temporaryDueDate ?? progress.nextDueDate;
/** Manual date changes preserve phase, interval, repetitions and review history. */
export function rescheduleStudyCard(progress: UserProgress, due: Date, now = new Date()) {
  if (!Number.isFinite(+due)) throw new Error('Invalid due date.');
  return { nextDueDate: due, temporaryDueDate: null, buriedUntil: progress.scheduler.phase === 'NEW' && due > now ? due : null };
}
/** An unintroduced production card cannot precede its manually deferred recognition card. */
export function isRescheduleFollower(progress: UserProgress, sibling: UserProgress): boolean {
  return progress.itemType === 'WORD' && progress.scheduler.phase === 'NEW' && progress.card?.direction === 'DE_ES'
    && !!progress.card.sourceNoteGuid && sibling.itemType === 'WORD' && sibling.scheduler.phase === 'NEW'
    && sibling.card?.direction === 'ES_DE' && sibling.card.sourceNoteGuid === progress.card.sourceNoteGuid;
}
export function scheduleStudyReview(progress: UserProgress, grade: StudyGrade, now: Date, earlyReview = false): Omit<ReturnType<typeof scheduleReview>, "lastReviewed"> & { lastReviewed: Date | null; temporaryDueDate?: Date; buriedUntil?: Date | null } {
  progress = normalizeUnstudiedProgress(progress, now);
  if (grade === 'KNOWN' || progress.itemType === 'WORD' && progress.scheduler.knownInterval) {
    if (grade === 'KNOWN' && (progress.itemType !== 'WORD' || progress.card?.direction === 'CLOZE')) throw new Error('Known is available for word cards.');
    if (grade !== 'REVISIT') {
      const current = progress.scheduler;
      const maximum = Math.max(1, current.options.maximumInterval);
      const anchor = grade === 'KNOWN' ? Math.min(180, maximum) : current.knownInterval!;
      const days = Math.min(maximum, Math.max(1, Math.round(grade === 'AGAIN' ? 1 : grade === 'KNOWN' || grade === 'HARD' ? anchor : grade === 'GOOD' ? anchor * 1.5 : anchor * 365 / 180)));
      const lapses = (progress.lapses ?? current.lapses) + (grade === 'AGAIN' ? 1 : 0);
      const ease = Math.max(1.3, current.ease + (grade === 'AGAIN' ? -0.2 : grade === 'HARD' ? -0.15 : grade === 'EASY' ? 0.15 : 0));
      return { ...progress, scheduler: { ...current, phase: 'REVIEW' as const, queue: 'DAY' as const,
        remainingSteps: 0, scheduledSeconds: 0, interval: days, knownInterval: grade === 'AGAIN' ? anchor : days, ease, lapses },
        interval: days, ease, lapses, repetitions: grade === 'AGAIN' ? 0 : progress.repetitions + 1,
        totalReviews: (progress.totalReviews ?? 0) + 1, isNew: false, lastReviewed: now,
        nextDueDate: dateForStudyDay(studyDay(now, current.timeZone, current.rollover) + days, current.timeZone, current.rollover),
        temporaryDueDate: undefined, buriedUntil: null, delaySeconds: days * 86400 };
    }
  }
  const temporaryDueDate = new Date(now.getTime() + 86400000);
  if (grade === 'REVISIT') {
    if (progress.itemType !== 'WORD' || progress.scheduler.phase !== 'REVIEW') throw new Error('Revisit is available for established word cards.');
    // A future card keeps its schedule. A due card receives its ordinary Good
    // review first, so completing the extra review cannot restore a past due date.
    const regular: Partial<ReturnType<typeof scheduleStudyReview>> = progress.nextDueDate > now ? {} : scheduleStudyReview(progress, 'GOOD', now, earlyReview);
    const regularDue = regular.nextDueDate ?? progress.nextDueDate;
    if (regularDue <= temporaryDueDate) throw new Error('The regular review is already due sooner than tomorrow. Choose an ordinary rating.');
    return { ...progress, scheduler: progress.scheduler!, lapses: progress.lapses ?? progress.scheduler.lapses,
      isNew: progress.isNew ?? false, ...regular, temporaryDueDate, totalReviews: (progress.totalReviews ?? 0) + 1, delaySeconds: 86400 };
  }
  // A temporary reminder never replaces the learner's recall rating. Review
  // the regular schedule with the shared early-review rules, then clear it.
  earlyReview ||= !!progress.temporaryDueDate && progress.nextDueDate > now;
  if (progress.itemType === 'PHRASE') {
    const current = progress.scheduler ?? initialScheduler(progress);
    const options = current.options;
    const maximum = Math.max(1, options.maximumInterval);
    const minimum = Math.min(maximum, Math.max(options.minimumLapseInterval, PHRASE_SCHEDULING_PRESET.minimumLapseInterval));
    // The same adaptive engine starts phrases on week-sized steps. Stored deck
    // settings stay intact; applying this preset never compounds a multiplier.
    const effective = { ...options, ...PHRASE_SCHEDULING_PRESET,
      learningSteps: PHRASE_SCHEDULING_PRESET.learningSteps.map(minutes => Math.min(minutes, maximum * 1440)),
      relearningSteps: PHRASE_SCHEDULING_PRESET.relearningSteps.map(minutes => Math.min(minutes, maximum * 1440)),
      graduatingGood: Math.max(options.graduatingGood, PHRASE_SCHEDULING_PRESET.graduatingGood),
      graduatingEasy: Math.max(options.graduatingEasy, PHRASE_SCHEDULING_PRESET.graduatingEasy, options.graduatingGood + 1),
      minimumLapseInterval: minimum };
    // Legacy short review intervals need a floor so a 7-day Again step cannot
    // follow a shorter Hard/Good choice. Preserve history, ease and repetitions.
    const interval = current.phase === 'REVIEW' || current.phase === 'RELEARNING'
      ? Math.min(maximum, Math.max(current.interval, minimum)) : current.interval;
    // Successful first recall seeds mature review directly. Again/Hard keep
    // the ordinary learning state; later ratings use the shared adaptive engine.
    const firstReview = current.phase === 'NEW';
    const schedulingOptions = firstReview && grade === 'GOOD' ? { ...effective, learningSteps: [] } : effective;
    const next = scheduleReview({ ...progress, interval, scheduler: { ...current, interval, options: schedulingOptions } }, grade, now, earlyReview);
    if (grade === 'AGAIN' && current.phase !== 'NEW' && current.phase !== 'LEARNING' && next.interval > interval) {
      // Fuzz around the lapse floor must never reward forgetting with growth.
      next.interval = interval; next.scheduler.interval = interval;
    }
    // Week-sized steps are calendar-day steps. DST can make the engine's
    // elapsed-second rollover conversion one day short; use the shared calendar
    // conversion with the nominal step instead.
    if (next.scheduler.phase !== 'REVIEW') {
      const days = Math.min(maximum, Math.round(next.scheduler.scheduledSeconds / 86400));
      next.scheduler.queue = 'DAY'; next.delaySeconds = days * 86400;
      next.nextDueDate = dateForStudyDay(studyDay(now, current.timeZone, current.rollover) + days, current.timeZone, current.rollover);
    }
    // Early recall with small caps can put Hard before the first Again step;
    // relearning Easy can add a day above the cap. Apply the preset's bounds.
    const bounded = Math.min(maximum, Math.max(Math.min(maximum, 7), next.interval));
    if (next.scheduler.phase === 'REVIEW' && next.interval !== bounded) {
      next.interval = bounded; next.scheduler.interval = bounded; next.delaySeconds = bounded * 86400;
      next.nextDueDate = dateForStudyDay(studyDay(now, current.timeZone, current.rollover) + bounded, current.timeZone, current.rollover);
    }
    if (firstReview) {
      // Exact owner-selected starting intervals are not fuzzed. Six months and
      // one year mean 180/365 study days, consistent with interval labels.
      const days = Math.min(maximum, PHRASE_FIRST_INTERVALS[grade]);
      next.delaySeconds = days * 86400;
      next.nextDueDate = dateForStudyDay(studyDay(now, current.timeZone, current.rollover) + days, current.timeZone, current.rollover);
      next.scheduler.queue = 'DAY';
      if (next.scheduler.phase === 'REVIEW') {
        next.interval = days; next.scheduler.interval = days;
      } else next.scheduler.scheduledSeconds = days * 86400;
    }
    return { ...next, scheduler: { ...next.scheduler, options }, temporaryDueDate: undefined };
  }
  return { ...scheduleReview(progress, grade, now, earlyReview), temporaryDueDate: undefined };
}
export function studyReviewOptions(progress: UserProgress, now = new Date(), earlyReview = false) {
  progress = normalizeUnstudiedProgress(progress, now);
  const revisit: StudyGrade[] = progress.itemType === 'WORD' && progress.scheduler.phase === 'REVIEW' && (progress.nextDueDate > now ? progress.nextDueDate : scheduleStudyReview(progress, 'GOOD', now, earlyReview).nextDueDate).getTime() > now.getTime() + 86400000 ? ['REVISIT'] : [];
  const grades: StudyGrade[] = [...GRADES, ...revisit, ...(progress.itemType === 'WORD' && progress.card?.direction !== 'CLOZE' ? ['KNOWN' as const] : [])];
  return grades.map(grade => { const next = scheduleStudyReview(progress, grade, now, earlyReview); return { grade, delaySeconds: next.delaySeconds, nextDueDate: effectiveDueDate({ ...progress, ...next }).toISOString(), phase: next.scheduler.phase }; });
}
