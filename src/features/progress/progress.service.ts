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
  preserveAnkiLimits?: boolean;
}

/**
 * Calculate the next review date based on a rating
 * @param rating - User rating from 0-5
 * @param current - Current SRS state
 * @param itemType - "WORD" or "PHRASE"
 * @returns New SRS state with next due date
 */
export function calculateNextReview(
  rating: number,
  current: SRSInput = {},
  itemType: "WORD" | "PHRASE" = "WORD",
): SRSResult {
  let ease = current.ease ?? 2.5;
  let interval = current.interval ?? 0;
  let repetitions = current.repetitions ?? 0;

  // Phrases use longer minimum intervals to avoid becoming too frequent
  const isPhrase = itemType === "PHRASE";
  const PHRASE_MIN_INTERVAL = 2;

  // Rating: 0-5
  if (rating >= 3) {
    if (repetitions === 0) {
      interval = isPhrase ? PHRASE_MIN_INTERVAL : 1;
    } else if (repetitions === 1) {
      interval = isPhrase ? 8 : 6;
    } else {
      // Modify interval with an ease multiplier, capped to avoid runaway intervals
      const easeModifier =
        rating === 5 ? ease + 0.15 : rating === 4 ? ease : ease - 0.15;
      interval = Math.round(interval * easeModifier);
      if (!current.preserveAnkiLimits) interval = Math.min(interval, 365); // Max interval of 1 year
    }
    repetitions++;
  } else {
    // Incorrect - reset to learning phase but keep some ease
    repetitions = 0;
    interval = isPhrase ? PHRASE_MIN_INTERVAL : 1;
  }

  // Enforce minimum interval for phrases
  if (isPhrase && interval < PHRASE_MIN_INTERVAL) {
    interval = PHRASE_MIN_INTERVAL;
  }

  // Update ease factor using SM-2 formula
  ease = ease + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02));
  // Keep ease within bounds
  if (ease < 1.3) ease = 1.3;
  if (!current.preserveAnkiLimits && ease > 2.5) ease = 2.5;

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
