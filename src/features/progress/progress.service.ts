/**
 * SM-2 Algorithm Implementation (Spaced Repetition)
 * Based on SuperMemo-2
 */

export interface SRSResult {
  ease: number;
  interval: number;
  repetitions: number;
  nextDueDate: Date;
}

export interface SRSInput {
  ease?: number;
  interval?: number;
  repetitions?: number;
}

/**
 * Calculate the next review date based on a rating
 * @param rating - User rating from 0-5
 * @param current - Current SRS state
 * @returns New SRS state with next due date
 */
export function calculateNextReview(
  rating: number,
  current: SRSInput = {},
): SRSResult {
  let ease = current.ease ?? 2.5;
  let interval = current.interval ?? 0;
  let repetitions = current.repetitions ?? 0;

  if (rating >= 3) {
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * ease);
    }
    repetitions++;
  } else {
    // Incorrect - reset
    repetitions = 0;
    interval = 1;
  }

  // Update ease factor using SM-2 formula
  ease = ease + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02));
  if (ease < 1.3) ease = 1.3;

  const nextDueDate = new Date();
  nextDueDate.setDate(nextDueDate.getDate() + interval);

  return {
    ease,
    interval,
    repetitions,
    nextDueDate,
  };
}

/**
 * Check if a phrase is due for review
 */
export function isDue(nextDueDate: Date | null | undefined): boolean {
  if (!nextDueDate) return true;
  return new Date(nextDueDate) <= new Date();
}
