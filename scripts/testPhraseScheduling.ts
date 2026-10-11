import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, GRADES, dateForStudyDay, initialScheduler, scheduleReview, studyDay } from '../src/features/progress/scheduler.js';
import { effectiveDueDate, PHRASE_SCHEDULING_PRESET, scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import { reviewDelayLabels } from '../src/features/progress/reviewPresentation.js';
import { selectStudyQueue } from '../src/features/progress/studyQueue.js';
import { phraseCard, phraseStart as now } from './lib/phraseSchedulingFixtures.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

// Differential oracle: the independently audited word engine, given the phrase
// week-sized preset. Successful-history growth below uses behavioral assertions as well.
const wordReference = (phrase: UserProgress, grade: typeof GRADES[number], time: Date, early = false) => {
  const options = phrase.scheduler.options;
  const cap = Math.max(1, options.maximumInterval), floor = Math.min(cap, Math.max(options.minimumLapseInterval, 21));
  const interval = ['REVIEW', 'RELEARNING'].includes(phrase.scheduler.phase) ? Math.min(cap, Math.max(floor, phrase.scheduler.interval)) : phrase.scheduler.interval;
  const word = { ...phrase, interval, itemType: 'WORD' as const, scheduler: { ...phrase.scheduler, interval, options: { ...options,
    learningSteps: [7, 53].map(days => Math.min(days, cap) * 1440), relearningSteps: [7, 14].map(days => Math.min(days, cap) * 1440),
    graduatingGood: Math.max(options.graduatingGood, 180), graduatingEasy: Math.max(options.graduatingEasy, 365, options.graduatingGood + 1), minimumLapseInterval: floor } } };
  const next = scheduleReview(word, grade, time, early);
  if (grade === 'AGAIN' && ['REVIEW', 'RELEARNING'].includes(phrase.scheduler.phase) && next.interval > interval) {
    next.interval = interval; next.scheduler.interval = interval;
  }
  if (next.scheduler.phase !== 'REVIEW') {
    const days = Math.min(cap, Math.round(next.scheduler.scheduledSeconds / 86400));
    next.scheduler.queue = 'DAY'; next.delaySeconds = days * 86400;
    next.nextDueDate = dateForStudyDay(studyDay(time, word.scheduler.timeZone, word.scheduler.rollover) + days, word.scheduler.timeZone, word.scheduler.rollover);
  }
  const bounded = Math.min(cap, Math.max(Math.min(cap, 7), next.interval));
  if (next.scheduler.phase === 'REVIEW' && next.interval !== bounded) {
    next.interval = bounded; next.scheduler.interval = bounded; next.delaySeconds = bounded * 86400;
    next.nextDueDate = dateForStudyDay(studyDay(time, word.scheduler.timeZone, word.scheduler.rollover) + bounded, word.scheduler.timeZone, word.scheduler.rollover);
  }
  return { ...next, scheduler: { ...next.scheduler, options }, temporaryDueDate: undefined };
};
assert.deepEqual(PHRASE_SCHEDULING_PRESET.learningSteps, [10080, 76320]);
const ordinary = (progress: UserProgress, time = now, early = false) => studyReviewOptions(progress, time, early).filter(o => o.grade !== 'REVISIT');
let sharedLearningCases = 0, establishedCases = 0;
for (const options of [DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, learningSteps: [2, 25], relearningSteps: [5, 20], graduatingGood: 3, graduatingEasy: 8 }]) {
  const fresh = phraseCard(0); fresh.scheduler = initialScheduler(fresh, options);
  const learning = { ...fresh, ...scheduleStudyReview(fresh, 'AGAIN', now) };
  const relearning = phraseCard(30); relearning.lapses = 2;
  relearning.scheduler = { ...initialScheduler(relearning, options), phase: 'RELEARNING', queue: 'MINUTE', remainingSteps: options.relearningSteps.length, scheduledSeconds: options.relearningSteps[0] * 60 };
  for (const phrase of [learning, relearning]) for (const time of [now, new Date('2026-10-11T01:59:50Z')]) for (const grade of GRADES) {
    assert.deepEqual(scheduleStudyReview(phrase, grade, time), wordReference(phrase, grade, time), `${phrase.scheduler.phase} ${grade}: same learning/relearning engine with longer graduation`);
    sharedLearningCases++;
  }
}
const fresh = phraseCard(0), graduated = { ...fresh, ...scheduleStudyReview(fresh, 'GOOD', now) };
assert.equal(graduated.scheduler.phase, 'REVIEW'); assert.equal(graduated.interval, 180);
assert.ok(scheduleStudyReview(graduated, 'GOOD', graduated.nextDueDate).interval > graduated.interval, 'Graduation continues into adaptive review growth');
for (const grade of ['AGAIN', 'HARD'] as const) {
  let learning = { ...fresh, ...scheduleStudyReview(fresh, grade, now) };
  assert.equal(learning.scheduler.phase, 'LEARNING');
  learning = { ...learning, ...scheduleStudyReview(learning, 'GOOD', learning.nextDueDate) };
  assert.equal(learning.scheduler.phase, 'LEARNING');
  assert.equal(learning.scheduler.scheduledSeconds, 53 * 86400);
  learning = { ...learning, ...scheduleStudyReview(learning, 'GOOD', learning.nextDueDate) };
  assert.equal(learning.scheduler.phase, 'REVIEW');
  assert.ok(learning.interval >= 170 && learning.interval <= 190);
}

for (const interval of [1, 30, 180, 365, 1000]) for (const totalReviews of [1, 10, 100, 1000]) for (const ease of [1.3, 2.5, 3.5]) {
  for (const [timeZone, rollover] of [['Europe/Berlin', 4], ['America/New_York', 0]] as const) for (const timing of ['early', 'due', 'overdue'] as const) {
    const phrase = phraseCard(interval); phrase.totalReviews = totalReviews; phrase.ease = ease;
    phrase.scheduler = initialScheduler(phrase, DEFAULT_OPTIONS, timeZone, rollover);
    phrase.nextDueDate = new Date(+now + (timing === 'early' ? 30 : timing === 'overdue' ? -30 : 0) * 86400000);
    const previews = ordinary(phrase, now, timing === 'early');
    assert.deepEqual(previews.map(o => o.grade), GRADES, 'Phrases retain four recall ratings and no Revisit');
    assert.ok(previews.every((o, i) => !i || o.delaySeconds >= previews[i - 1].delaySeconds), 'Ordinary phrase choices ascend');
    assert.equal(new Set(Object.values(reviewDelayLabels(previews))).size, new Set(previews.map(o => o.delaySeconds)).size, 'Distinct intervals have distinct labels');
    for (const preview of previews) {
      const grade = preview.grade as typeof GRADES[number];
      const next = scheduleStudyReview(phrase, grade, now, timing === 'early');
      assert.deepEqual(next, wordReference(phrase, grade, now, timing === 'early'), 'History, ease, overdue/early credit, lapses and fuzz use the word engine');
      assert.equal(next.nextDueDate.toISOString(), preview.nextDueDate);
      assert.equal(next.scheduler.interval, next.interval);
      assert.equal(next.totalReviews, totalReviews + 1); assert.equal(next.lastReviewed, now); assert.equal(next.isNew, false);
      assert.deepEqual(next.scheduler.options, phrase.scheduler.options, 'Preset is never written into stored options');
      if (next.scheduler.queue === 'DAY') assert.equal(studyDay(next.nextDueDate, timeZone, rollover) - studyDay(now, timeZone, rollover), next.delaySeconds / 86400);
      establishedCases++;
    }
    assert.throws(() => scheduleStudyReview(phrase, 'REVISIT', now), /established word/);
  }
}
for (const time of [new Date('2026-03-28T03:00:00Z'), new Date('2026-10-24T02:00:00Z')]) for (const grade of ['HARD', 'GOOD', 'EASY'] as const) {
  const phrase = phraseCard(), next = { ...phrase, ...scheduleStudyReview(phrase, grade, time) };
  assert.equal(next.nextDueDate.toISOString(), dateForStudyDay(studyDay(time, 'Europe/Berlin', 4) + next.interval, 'Europe/Berlin', 4).toISOString());
  assert.equal(selectStudyQueue([next], new Map(), new Date(+next.nextDueDate - 1), 10, 0).length, 0);
  assert.equal(selectStudyQueue([next], new Map(), next.nextDueDate, 10, 0).length, 1);
}
const mature = phraseCard(30), word = { ...mature, itemType: 'WORD' as const };
for (const grade of ['HARD', 'GOOD', 'EASY'] as const) assert.equal(scheduleStudyReview(mature, grade, now).interval, scheduleStudyReview(word, grade, now).interval, `${grade}: identical adaptive growth for identical mature state`);
for (const grade of GRADES) assert.ok(scheduleStudyReview(fresh, grade, now).delaySeconds > scheduleStudyReview({ ...fresh, itemType: 'WORD' }, grade, now).delaySeconds, `${grade}: first phrase interval is much longer than first word interval`);
const lapse = scheduleStudyReview(mature, 'AGAIN', now);
assert.equal(lapse.scheduler.phase, 'RELEARNING'); assert.equal(lapse.scheduler.queue, 'DAY');
assert.ok(lapse.ease < mature.ease); assert.equal(lapse.lapses, mature.lapses + 1);
assert.ok(lapse.interval < mature.interval, 'Forgetting reduces the interval instead of rewarding lifetime review count');
const custom = phraseCard(); custom.scheduler.options = { ...DEFAULT_OPTIONS, maximumInterval: 10, intervalMultiplier: 1.5 };
for (const grade of ['HARD', 'GOOD', 'EASY'] as const) assert.equal(scheduleStudyReview(custom, grade, now).interval, 10, 'Phrase preset respects the configured maximum');
assert.equal(custom.scheduler.options.intervalMultiplier, 1.5);
const lowerEase = phraseCard(30); lowerEase.ease = 1.3; lowerEase.scheduler.ease = 1.3;
assert.ok(scheduleStudyReview(mature, 'GOOD', now).interval > scheduleStudyReview(lowerEase, 'GOOD', now).interval, 'Ease affects phrase growth');
const overdue = { ...mature, nextDueDate: new Date(+now - 30 * 86400000) };
assert.ok(scheduleStudyReview(overdue, 'GOOD', now).interval > scheduleStudyReview(mature, 'GOOD', now).interval, 'Late recall earns the shared overdue bonus');
const staleTemporary = { ...phraseCard(), temporaryDueDate: new Date(+now - 1) };
const restoredOptions = ordinary(staleTemporary);
assert.equal(new Set(restoredOptions.map(o => o.nextDueDate)).size, 4);
for (const option of restoredOptions) {
  const next = { ...staleTemporary, ...scheduleStudyReview(staleTemporary, option.grade, now) };
  assert.equal(next.temporaryDueDate, undefined); assert.equal(effectiveDueDate(next).toISOString(), option.nextDueDate); assert.ok(effectiveDueDate(next) > now);
}
const traces = Object.fromEntries((['HARD', 'GOOD', 'EASY'] as const).map(grade => {
  let phrase = phraseCard(2); const intervals: number[] = [];
  for (let review = 0; review < 6; review++) {
    const previous = phrase; phrase = { ...phrase, ...scheduleStudyReview(phrase, grade, phrase.nextDueDate) };
    assert.ok(phrase.interval > previous.interval || previous.interval === DEFAULT_OPTIONS.maximumInterval && phrase.interval === previous.interval, `${grade}: repeated due reviews grow until the cap`);
    assert.deepEqual(phrase.scheduler.options, DEFAULT_OPTIONS, 'Longer preset must not multiply stored settings again on the next review');
    intervals.push(phrase.interval);
  }
  return [grade, intervals];
}));
for (const cap of [1, 5, 7, 10, 21]) {
  let limited = phraseCard(30); limited.scheduler.options = { ...DEFAULT_OPTIONS, maximumInterval: cap };
  limited.nextDueDate = new Date(+now + 30 * 86400000);
  const early = ordinary(limited, now, true);
  assert.ok(early.every((option, i) => !i || option.delaySeconds >= early[i - 1].delaySeconds), 'Explicit caps must not reverse early phrase choices');
  limited = { ...limited, ...scheduleStudyReview(limited, 'AGAIN', now) };
  for (const grade of GRADES) {
    const next = scheduleStudyReview(limited, grade, limited.nextDueDate);
    assert.ok(next.interval <= cap && next.delaySeconds <= cap * 86400, 'Relearning also respects small explicit caps');
  }
}
console.log(JSON.stringify({ sharedLearningCases, establishedCases, repeatedPhraseIntervals: traces }));
console.log('PASS adaptive phrase/word-engine equivalence, longer intervals, repeated growth, relearning, ease, elapsed time, caps, immutable presets, dates and exact eligibility');
