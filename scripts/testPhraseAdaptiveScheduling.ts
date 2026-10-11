import assert from 'node:assert/strict';
import { phraseCard } from './lib/phraseSchedulingFixtures.js';
import { scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import { dateForStudyDay, initialScheduler, studyDay } from '../src/features/progress/scheduler.js';
import { reviewDelayLabels } from '../src/features/progress/reviewPresentation.js';
import { selectStudyQueue } from '../src/features/progress/studyQueue.js';

const fresh = phraseCard(0);
const firstOptions = studyReviewOptions(fresh, fresh.nextDueDate);
assert.deepEqual(firstOptions.map(option => option.delaySeconds), [7, 30, 180, 365].map(days => days * 86400), 'First phrase answers are exactly 7 days / 30 days / 6 months / 1 year');
assert.ok(firstOptions.every((option, i) => !i || option.delaySeconds > firstOptions[i - 1].delaySeconds), 'First phrase answer options ascend strictly');

let initialCases = 0;
for (const time of ['2026-03-28T03:01:00Z', '2026-10-24T02:01:00Z', '2026-10-25T02:59:59Z']) {
  for (const timeZone of ['Europe/Berlin', 'America/New_York']) for (const seed of ['1790000000001', '1790000000123', '1790000000999']) {
    const unstudied = phraseCard(0); unstudied.card.sourceCardId = seed;
    unstudied.scheduler = initialScheduler(unstudied, { ...unstudied.scheduler.options, graduatingGood: 500, graduatingEasy: 1000 }, timeZone, 4);
    // Untouched imported REVIEW snapshots must receive the same starting policy.
    unstudied.scheduler.phase = 'REVIEW'; unstudied.isNew = false;
    const now = new Date(time), options = studyReviewOptions(unstudied, now);
    assert.deepEqual(options.map(option => option.delaySeconds), [7, 30, 180, 365].map(days => days * 86400), 'Seeds, imported states, deck graduation settings and DST cannot change first intervals');
    assert.deepEqual(Object.values(reviewDelayLabels(options)), ['7d', '30d', '6mo', '1y']);
    for (const option of options) {
      const next = { ...unstudied, ...scheduleStudyReview(unstudied, option.grade, now) };
      assert.equal(next.nextDueDate.toISOString(), option.nextDueDate);
      assert.equal(option.nextDueDate, dateForStudyDay(studyDay(now, timeZone, 4) + option.delaySeconds / 86400, timeZone, 4).toISOString());
      assert.equal(next.scheduler.phase, ['AGAIN', 'HARD'].includes(option.grade) ? 'LEARNING' : 'REVIEW');
      assert.equal(next.totalReviews, 1); assert.equal(next.isNew, false);
      assert.deepEqual(next.scheduler.options, unstudied.scheduler.options);
      assert.equal(selectStudyQueue([next], new Map(), new Date(+next.nextDueDate - 1), 10, 0).length, 0);
      assert.equal(selectStudyQueue([next], new Map(), next.nextDueDate, 10, 0).length, 1);
      initialCases++;
    }
  }
}
for (const maximumInterval of [1, 7, 30, 180, 365]) {
  const limited = phraseCard(0); limited.scheduler.options.maximumInterval = maximumInterval;
  assert.deepEqual(studyReviewOptions(limited, limited.nextDueDate).map(option => option.delaySeconds), [7, 30, 180, 365].map(days => Math.min(days, maximumInterval) * 86400), 'Explicit interval caps remain authoritative');
}
let phrase = phraseCard(2);
const intervals: number[] = [];
for (let review = 0; review < 5; review++) {
  const before = phrase;
  phrase = { ...before, ...scheduleStudyReview(before, 'GOOD', before.nextDueDate) };
  assert.ok(phrase.interval > before.interval, `Successful phrase review ${review + 1} must grow its interval: ${before.interval} → ${phrase.interval}`);
  intervals.push(phrase.interval);
}
console.log(JSON.stringify({ repeatedGoodIntervals: intervals }));
let newPhrase = fresh;
const freshTrace: number[] = [];
for (let review = 0; review < 6; review++) {
  const before = newPhrase;
  newPhrase = { ...before, ...scheduleStudyReview(before, 'GOOD', before.nextDueDate) };
  assert.ok(newPhrase.interval > before.interval);
  freshTrace.push(newPhrase.interval);
}
assert.equal(freshTrace[0], 180);
console.log(JSON.stringify({ initialCases, freshPhraseGoodIntervals: freshTrace }));
console.log('PASS successful phrase reviews grow instead of reaching a fixed interval plateau');
