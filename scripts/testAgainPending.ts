import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';
import { rescheduleStudyCard, scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import { selectStudyQueue } from '../src/features/progress/studyQueue.js';
import { isDueStudyCandidate } from '../src/features/progress/studyCandidates.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

const now = new Date('2026-10-15T10:00:00Z');
const make = (itemType: UserProgress['itemType'], interval = 0): UserProgress => {
  const p: UserProgress = { _id: new ObjectId(), userId: new ObjectId(), itemId: new ObjectId(), itemType,
    ease: 2.5, interval, repetitions: interval ? 5 : 0, totalReviews: interval ? 8 : 0, lapses: 0,
    isNew: !interval, nextDueDate: now, lastReviewed: interval ? new Date(+now - interval * 86400000) : null,
    createdAt: new Date('2025-01-01T00:00:00Z'), scheduleVersion: 0 };
  p.scheduler = initialScheduler(p);
  return p;
};

for (const type of ['WORD', 'PHRASE'] as const) for (const interval of [0, 30]) {
  let card = make(type, interval);
  const initialOptions = studyReviewOptions(card, now);
  if (type === 'PHRASE' && !interval) assert.deepEqual(initialOptions.map(option => option.delaySeconds / 86400), [7, 30, 180, 365]);
  for (let repeat = 0; repeat < 4; repeat++) {
    const next = scheduleStudyReview(card, 'AGAIN', now);
    assert.equal(next.againPending, true, `${type} Again must keep an outstanding recall retry`);
    assert.ok(['LEARNING', 'RELEARNING'].includes(next.scheduler.phase), `${type} Again cannot graduate`);
    card = { ...card, ...next };
    assert.ok(card.nextDueDate > now, 'The scheduler still keeps its ordinary future due date');
    assert.deepEqual(selectStudyQueue([card], new Map(), now, 10, 0).map(row => row.itemId), [card.itemId], 'Outstanding recall returns without waiting for its due date');
    assert.equal(isDueStudyCandidate(card, now, null), true, 'A future phrase retry must survive the compact candidate view');
  }
  for (const grade of ['HARD', 'GOOD', 'EASY'] as const) {
    const next = scheduleStudyReview(card, grade, now);
    assert.equal(next.againPending, false, `${grade} resolves outstanding recall`);
    assert.equal(selectStudyQueue([{ ...card, ...next }], new Map(), now, 10, 0).length, 0, `${grade} resumes ordinary future scheduling`);
  }
  assert.equal(rescheduleStudyCard(card, new Date(+now + 86400000), now).againPending, false, 'Explicit date deferral resolves immediate retry');
  for (const unavailable of [{ suspended: true }, { supersededByAnki: true }, { buriedUntil: new Date(+now + 86400000) }]) {
    assert.equal(selectStudyQueue([{ ...card, ...unavailable }], new Map(), now, 10, 0).length, 0, 'Retry never bypasses availability constraints');
  }
}

for (const interval of [0, 30]) {
  const card = make('WORD', interval);
  card.scheduler!.options = { ...DEFAULT_OPTIONS, learningSteps: [], relearningSteps: [] };
  const next = scheduleStudyReview(card, 'AGAIN', now);
  assert.ok(['LEARNING', 'RELEARNING'].includes(next.scheduler.phase), 'Empty deck steps cannot graduate an app Again');
  assert.deepEqual(next.scheduler.options.learningSteps, [], 'Fallback does not rewrite deck options');
  assert.deepEqual(next.scheduler.options.relearningSteps, []);
}

const temporary = { ...make('WORD', 30), nextDueDate: new Date(+now + 30 * 86400000), temporaryDueDate: now };
const failedExtra = scheduleStudyReview(temporary, 'AGAIN', now);
assert.equal(failedExtra.scheduler.phase, 'RELEARNING', 'A failed temporary review must enter ordinary relearning');
assert.equal(failedExtra.againPending, true);
assert.equal(failedExtra.temporaryDueDate, undefined);
const known = { ...make('WORD', 30), ...scheduleStudyReview(make('WORD', 30), 'KNOWN', now) };
assert.equal(known.scheduler.knownInterval, 180);
for (const [grade, days] of [['HARD', 180], ['GOOD', 270], ['EASY', 365]] as const)
  assert.equal(scheduleStudyReview(known, grade, known.nextDueDate).interval, days, 'Known success keeps its mature formula');
const forgottenKnown = scheduleStudyReview(known, 'AGAIN', known.nextDueDate);
assert.equal(forgottenKnown.scheduler.knownInterval, undefined, 'Again discards the Known mature anchor');
assert.equal(forgottenKnown.scheduler.phase, 'RELEARNING');
assert.equal(forgottenKnown.againPending, true);
assert.equal(forgottenKnown.interval, 1);
assert.equal(forgottenKnown.delaySeconds, 600);
console.log('PASS outstanding Again retries for new/learning/due words and phrases, non-Again resolution, unchanged first choices, empty steps, temporary reviews, deferral, availability');
