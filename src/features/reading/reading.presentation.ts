import type { ReadingLesson, TranslationAttempt } from "./reading.types.js";

// The latest-per-page aggregate deliberately omits ownership and job metadata.
// Keep its input type aligned with the fields selected from MongoDB.
type ReadingAttemptSnapshot = Pick<TranslationAttempt,
  "_id" | "requestId" | "pageIndex" | "translation" | "status" | "error" | "feedback"
>;

export interface ReadingPageAttempt {
  pageIndex: number;
  attempt: ReadingAttemptSnapshot;
  hasReady: number;
}

export function presentReadingAttempt(attempt: ReadingAttemptSnapshot) {
  return {
    id: attempt._id.toString(),
    requestId: attempt.requestId,
    pageIndex: attempt.pageIndex,
    translation: attempt.translation,
    status: attempt.status,
    error: attempt.error ?? null,
    feedback: attempt.feedback ?? null,
  };
}

export function presentReadingLesson(lesson: ReadingLesson, attempts: ReadingPageAttempt[]) {
  return {
    id: lesson._id.toString(),
    sessionId: lesson.sessionId,
    sessionStartedAt: lesson.sessionStartedAt.toISOString(),
    sessionEndedAt: lesson.sessionEndedAt.toISOString(),
    status: lesson.status,
    error: lesson.error ?? null,
    words: lesson.words,
    pageCount: lesson.pageCount,
    model: lesson.model,
    pages: lesson.pages.map(page => {
      const pageAttempt = attempts.find(attempt => attempt.pageIndex === page.index);
      return {
        ...page,
        // A completed check keeps the reference visible after a failed retry.
        spanish: pageAttempt?.hasReady ? page.spanish : null,
        lastAttempt: pageAttempt ? presentReadingAttempt(pageAttempt.attempt) : null,
      };
    }),
  };
}
