import type { UserProgress } from './progress.types.js';
import { initialScheduler, type Phase } from './scheduler.js';

/** Inputs needed by initialScheduler's compatibility phase normalization. */
export type StudyStatusSnapshot = Pick<UserProgress,
  'interval' | 'scheduler' | 'anki' | 'isNew' | 'lastReviewed' | 'createdAt' | 'updatedAt' | 'totalReviews'>;

export const STUDY_STATUS_PROJECTION = {
  interval: 1, 'scheduler.phase': 1, isNew: 1, lastReviewed: 1,
  createdAt: 1, updatedAt: 1, totalReviews: 1, 'anki.type': 1, 'anki.reps': 1,
};

export function normalizedStudyPhase(progress: StudyStatusSnapshot): Phase {
  // The compatibility scheduler uses only these snapshot fields to choose its
  // phase. Its remaining fields are irrelevant to this read-only status.
  return progress.scheduler?.phase ?? initialScheduler(progress as UserProgress).phase;
}

export function isGraduatedStudyCard(progress: StudyStatusSnapshot): boolean {
  return normalizedStudyPhase(progress) === 'REVIEW' && progress.interval >= 1;
}
