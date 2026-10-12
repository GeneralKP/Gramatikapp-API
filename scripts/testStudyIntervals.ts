import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { DEFAULT_OPTIONS, initialScheduler, studyDay, scheduleReview, GRADES } from '../src/features/progress/scheduler.js';
import { effectiveDueDate, scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';
import { reviewDelayLabels } from '../src/features/progress/reviewPresentation.js';
import { selectStudyQueue } from '../src/features/progress/studyQueue.js';

const now = new Date('2026-10-10T10:00:00Z');
function card(itemType: 'WORD' | 'PHRASE' = 'WORD', interval = 30): UserProgress {
  const progress: UserProgress = {
    _id: new ObjectId('000000000000000000000001'), userId: new ObjectId('000000000000000000000002'),
    itemId: new ObjectId('000000000000000000000003'), itemType, interval, ease: 2.5,
    repetitions: interval ? 5 : 0, totalReviews: interval ? 12 : 0, lapses: 0, isNew: !interval,
    nextDueDate: now, lastReviewed: interval ? new Date(+now - interval * 86400000) : null,
    createdAt: new Date('2026-04-10T10:00:00Z'),
  };
  progress.scheduler = initialScheduler(progress, DEFAULT_OPTIONS);
  return progress;
}

for (const type of ['WORD', 'PHRASE'] as const) {
  for (const interval of [0, 1, 2, 5, 30, 100, 365, 36500]) {
    const p = card(type, interval);
    const options = studyReviewOptions(p, now);
    const ratings = options.filter(option => option.grade !== 'REVISIT');
    assert.ok(ratings.every((option, i) => !i || option.delaySeconds >= ratings[i - 1].delaySeconds), `${type} ${interval}: rating order`);
    for (const option of options) {
      const saved = { ...p, ...scheduleStudyReview(p, option.grade, now) };
      assert.equal(effectiveDueDate(saved).toISOString(), option.nextDueDate, `${type} ${interval} ${option.grade}: preview/date equality`);
      if (saved.scheduler.queue === 'DAY' && option.grade !== 'REVISIT') {
        assert.equal(studyDay(effectiveDueDate(saved), 'Europe/Berlin', 4) - studyDay(now, 'Europe/Berlin', 4), option.delaySeconds / 86400);
      }
    }
  }
}
console.log('PASS word/phrase phases, ascending ordinary ratings, maximum interval and preview/applied date agreement');

const revisited = { ...card(), ...scheduleStudyReview(card(), 'REVISIT', now) };
const tomorrow = revisited.temporaryDueDate!;
const completion = studyReviewOptions(revisited, tomorrow);
assert.deepEqual(completion.filter(option => option.grade !== 'REVISIT').map(option => option.grade), GRADES, 'Temporary reviews retain all ordinary recall choices');
assert.ok(completion.some(option => option.grade === 'REVISIT'), 'Repeat extra practice tomorrow remains available when it precedes the regular review');
const completed = { ...revisited, ...scheduleStudyReview(revisited, 'GOOD', tomorrow) };
const earlyGood = scheduleReview(revisited, 'GOOD', tomorrow, true);
assert.equal(completed.nextDueDate.toISOString(), earlyGood.nextDueDate.toISOString());
assert.equal(completed.interval, earlyGood.interval);
assert.equal(completed.ease, earlyGood.ease);
assert.equal(completed.temporaryDueDate, undefined);
assert.equal(completed.totalReviews, revisited.totalReviews! + 1);
const expired = { ...revisited, nextDueDate: tomorrow };
assert.equal(studyReviewOptions(expired, tomorrow).filter(option => option.grade !== 'REVISIT').length, 4, 'An overdue regular review must use ordinary ratings');
console.log('PASS all temporary-review ratings, shared early-review scheduling and expired-regular-review fallback');

for (const delays of [[361, 365, 366, 370], [32, 33, 34], [36500, 36500]]) {
  const options = delays.map((days, index) => ({ grade: String(index), delaySeconds: days * 86400 }));
  const labels = reviewDelayLabels(options);
  assert.equal(new Set(Object.values(labels)).size, new Set(delays).size, 'Compact labels must distinguish genuinely different day intervals');
}
const minuteLabels = reviewDelayLabels([{ grade: 'AGAIN', delaySeconds: 60 }, { grade: 'HARD', delaySeconds: 75 }]);
assert.notEqual(minuteLabels.AGAIN, minuteLabels.HARD);
console.log('PASS month/year/minute label collisions and honest equal-interval labels');

const rolloverTime = new Date('2026-10-10T01:59:50Z');
const rolloverOptions = studyReviewOptions(card('WORD', 0), rolloverTime);
assert.equal(new Set(rolloverOptions.slice(0, 3).map(o => o.nextDueDate)).size, 1, 'Learning steps crossing rollover legitimately share the next study day');
const capped = card(); capped.scheduler.options = { ...DEFAULT_OPTIONS, maximumInterval: 1 };
assert.equal(new Set(studyReviewOptions(capped, now).filter(o => o.grade !== 'AGAIN').map(o => o.delaySeconds)).size, 1, 'A configured cap must not be bypassed to manufacture distinct choices');
const future = { ...card(), nextDueDate: new Date(+now + 30 * 86400000) };
assert.equal(scheduleStudyReview(future, 'GOOD', now, true).interval, future.interval, 'Early Good practice need not grow the regular interval');
const overdue = { ...card(), nextDueDate: new Date(+now - 30 * 86400000) };
assert.ok(scheduleStudyReview(overdue, 'GOOD', now).interval > scheduleStudyReview(card(), 'GOOD', now).interval, 'Late Good recall earns the overdue bonus');
const learning = { ...card('WORD', 0), ...scheduleStudyReview(card('WORD', 0), 'GOOD', now) };
const nominal = studyReviewOptions(card('WORD', 0), now).find(o => o.grade === 'GOOD')!;
assert.ok(+learning.nextDueDate >= +now + nominal.delaySeconds * 1000 && +learning.nextDueDate < +now + nominal.delaySeconds * 1250, 'Intraday jitter stays inside the Anki bound');
assert.equal(selectStudyQueue([learning], new Map(), now, 10, 0).length, 0, 'Automatic practice honors the due date despite configured learn-ahead');
for (const time of [new Date('2026-03-28T22:00:00Z'), new Date('2026-10-24T22:00:00Z')]) {
  const p = card();
  for (const option of studyReviewOptions(p, time)) {
    const next = scheduleStudyReview(p, option.grade, time);
    assert.equal(effectiveDueDate({ ...p, ...next }).toISOString(), option.nextDueDate, 'DST preview/date agreement');
  }
}
const matchedWord = card('WORD', 0), longerPhrase = card('PHRASE', 0);
assert.ok(scheduleStudyReview(longerPhrase, 'GOOD', now).delaySeconds > scheduleStudyReview(matchedWord, 'GOOD', now).delaySeconds, 'Phrases use a longer adaptive preset');
console.log('PASS rollover ties, configured caps, early/late recall, exact due boundaries, minute jitter, DST and adaptive phrase scheduling');
