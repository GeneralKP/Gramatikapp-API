import type { UserProgress } from './progress.types.js';
import { dateForStudyDay, GRADES, scheduleReview, studyDay, type Grade } from './scheduler.js';
export type StudyGrade = Grade | 'REVISIT';
export const effectiveDueDate = (progress: UserProgress) => progress.temporaryDueDate ?? progress.nextDueDate;
export function scheduleStudyReview(progress: UserProgress, grade: StudyGrade, now: Date, earlyReview = false) {
  const temporaryDueDate = new Date(now.getTime() + 86400000);
  if (grade === 'REVISIT') {
    if (progress.itemType !== 'WORD' || progress.scheduler.phase !== 'REVIEW') throw new Error('Revisit is available for established word cards.');
    // A future card keeps its schedule. A due card receives its ordinary Good
    // review first, so completing the extra review cannot restore a past due date.
    const regular = progress.nextDueDate > now ? {} : scheduleReview(progress, 'GOOD', now, earlyReview);
    const regularDue = 'nextDueDate' in regular ? regular.nextDueDate : progress.nextDueDate;
    if (regularDue <= temporaryDueDate) throw new Error('The regular review is already due sooner than tomorrow. Choose an ordinary rating.');
    return { ...progress, ...regular, temporaryDueDate, totalReviews: (progress.totalReviews ?? 0) + 1, delaySeconds: 86400 };
  }
  if (progress.temporaryDueDate && progress.nextDueDate > now) {
    // Completing the extra practice leaves interval, ease and regular due intact.
    return { ...progress, temporaryDueDate: undefined, totalReviews: (progress.totalReviews ?? 0) + 1, delaySeconds: Math.max(0, (progress.nextDueDate.getTime() - now.getTime()) / 1000) };
  }
  if (progress.itemType === 'PHRASE') {
    const interval = [7, 30, 180, 365][GRADES.indexOf(grade)];
    const scheduler = { ...progress.scheduler, phase: 'REVIEW' as const, queue: 'DAY' as const, remainingSteps: 0, scheduledSeconds: 0, interval, lapses: (progress.lapses ?? 0) + (grade === 'AGAIN' ? 1 : 0) };
    return { scheduler, interval, ease: progress.ease, repetitions: grade === 'AGAIN' ? 0 : progress.repetitions + 1,
      lapses: (progress.lapses ?? 0) + (grade === 'AGAIN' ? 1 : 0), totalReviews: (progress.totalReviews ?? 0) + 1, isNew: false,
      lastReviewed: now, nextDueDate: dateForStudyDay(studyDay(now, scheduler.timeZone, scheduler.rollover) + interval, scheduler.timeZone, scheduler.rollover), delaySeconds: interval * 86400 };
  }
  return { ...scheduleReview(progress, grade, now, earlyReview), temporaryDueDate: undefined };
}
export function studyReviewOptions(progress: UserProgress, now = new Date(), earlyReview = false) {
  const grades: StudyGrade[] = [...GRADES, ...(progress.itemType === 'WORD' && progress.scheduler.phase === 'REVIEW' && (progress.nextDueDate > now ? progress.nextDueDate : scheduleReview(progress, 'GOOD', now, earlyReview).nextDueDate).getTime() > now.getTime() + 86400000 ? ['REVISIT' as const] : [])];
  return grades.map(grade => { const next = scheduleStudyReview(progress, grade, now, earlyReview); return { grade, delaySeconds: next.delaySeconds, nextDueDate: effectiveDueDate({ ...progress, ...next }).toISOString(), phase: next.scheduler.phase }; });
}
