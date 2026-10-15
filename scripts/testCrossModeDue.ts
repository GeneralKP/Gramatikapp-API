import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';
import { scheduleStudyReview } from '../src/features/progress/studyScheduling.js';
import { selectStudyQueue } from '../src/features/progress/studyQueue.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

// Actual word rating -> shared queue selection, with no database or real clock.
const now = new Date('2026-10-12T10:00:00Z');
const word: UserProgress = {
  _id: new ObjectId('000000000000000000000001'), userId: new ObjectId('000000000000000000000002'),
  itemId: new ObjectId('000000000000000000000003'), itemType: 'WORD',
  isNew: true, interval: 0, ease: 2.5, repetitions: 0, totalReviews: 0, lapses: 0,
  nextDueDate: now, lastReviewed: null, createdAt: now,
};
word.scheduler = initialScheduler(word, { ...DEFAULT_OPTIONS, newPerDay: 20, reviewsPerDay: 200 });

for (const grade of ['AGAIN', 'HARD', 'GOOD'] as const) {
  const reviewed = { ...word, ...scheduleStudyReview(word, grade, now) };
  assert.ok(reviewed.nextDueDate > now, `${grade} must schedule a future learning step`);
  assert.equal(selectStudyQueue([reviewed], new Map(), now, 50, 0).length, grade === 'AGAIN' ? 1 : 0,
    `${grade}: a word reviewed in word practice must not immediately reappear in mixed practice before its saved due date`);
  assert.equal(selectStudyQueue([reviewed], new Map(), new Date(+reviewed.nextDueDate - 1), 50, 0).length, grade === 'AGAIN' ? 1 : 0,
    `${grade}: eligibility begins at the exact saved due instant`);
  assert.equal(selectStudyQueue([reviewed], new Map(), reviewed.nextDueDate, 50, 0)[0]?.itemId, word.itemId,
    `${grade}: the same card becomes available when due`);
}
const temporarilyDeferred = { ...word, ...scheduleStudyReview(word, 'HARD', now), nextDueDate: new Date(+now - 1), temporaryDueDate: new Date(+now + 60_000) };
assert.equal(selectStudyQueue([temporarilyDeferred], new Map(), now, 50, 0).length, 0,
  'A future temporary due date must govern even when the ordinary minute step is overdue');
assert.equal(selectStudyQueue([temporarilyDeferred], new Map(), temporarilyDeferred.temporaryDueDate, 50, 0).length, 1,
  'A temporary minute card appears once at its effective due instant');
console.log('PASS word-to-mixed: Again stays available across modes; successful learning honors its due instant');
