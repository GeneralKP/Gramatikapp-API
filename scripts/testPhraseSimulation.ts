import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createRequire } from 'node:module';
import { phraseCard, phraseStart } from './lib/phraseSchedulingFixtures.js';
import { simulateStudy, simulationCards } from './lib/studyIntervalSimulation.js';
import { scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import { scheduleStudyReview as webSchedule, studyReviewOptions as webOptions, type UserProgress as ClientProgress } from '../../german-gramatic-web/src/core/generated/studyScheduler.js';
const { scheduleStudyReview: nativeSchedule, studyReviewOptions: nativeOptions } = createRequire(import.meta.url)('../../german-gramatic-mobile/src/core/study/scheduler.ts') as typeof import('../../german-gramatic-mobile/src/core/study/scheduler.js');

for (const profile of ['successful', 'mixed', 'hard'] as const) {
  const cards = simulationCards(new ObjectId('000000000000000000000099')).slice(0, 1830).map(p => ({ ...p, itemType: 'PHRASE' as const,
    card: { ...p.card, prompt: `frase ${p.card.sourceCardId}`, answer: `Ich lerne Satz ${p.card.sourceCardId}.`, acceptedAnswers: [`Ich lerne Satz ${p.card.sourceCardId}.`] } }));
  const establishedRatings = { AGAIN: 0, HARD: 0, GOOD: 0, EASY: 0 };
  const { stats } = await simulateStudy(profile, async ({ before, after, grade }) => {
    assert.equal(before.itemType, 'PHRASE');
    if (before.scheduler.phase === 'REVIEW') {
      assert.notEqual(grade, 'REVISIT');
      const ordinaryGrade = grade as keyof typeof establishedRatings;
      establishedRatings[ordinaryGrade]++;
      if (grade === 'AGAIN') {
        assert.equal(after.scheduler.phase, 'RELEARNING'); assert.ok(after.interval <= Math.max(before.interval, 21));
        assert.ok(after.ease <= before.ease);
      } else {
        assert.equal(after.scheduler.phase, 'REVIEW');
        assert.ok(after.interval > before.interval || before.interval === before.scheduler.options.maximumInterval && after.interval === before.interval, 'Successful due phrase reviews grow until the cap');
      }
      assert.deepEqual(after.scheduler.options, before.scheduler.options, 'Repeated reviews retain unscaled preset settings');
    }
  }, cards, { WORD: 0, PHRASE: 10 });
  assert.equal(stats.sessions, profile === 'mixed' ? 174 : 183);
  assert.equal(stats.wordReviews, 0);
  assert.ok(stats.phraseReviews >= stats.sessions * 10);
  assert.ok(establishedRatings.GOOD > 0 || establishedRatings.HARD > 0);
  if (profile === 'mixed') assert.ok(Object.values(establishedRatings).every(count => count > 0), 'Mixed phrase history exercises all four established grades');
  console.log(JSON.stringify({ ...stats, establishedRatings }));
}
const stale = { ...phraseCard(), temporaryDueDate: new Date(+phraseStart - 1) };
const client = { ...stale, fuzzSeed: stale.card.sourceCardId } as unknown as ClientProgress;
for (const options of [webOptions, nativeOptions]) assert.deepEqual(options(client, phraseStart), studyReviewOptions(stale, phraseStart), 'Expired phrase temporary-date previews agree across clients');
for (const grade of ['AGAIN', 'HARD', 'GOOD', 'EASY'] as const) {
  const expected = scheduleStudyReview(stale, grade, phraseStart);
  for (const schedule of [webSchedule, nativeSchedule]) {
    const actual = schedule(client, grade, phraseStart);
    assert.equal(actual.temporaryDueDate, undefined);
    assert.equal(actual.nextDueDate.toISOString(), expected.nextDueDate.toISOString());
  }
}
console.log('PASS six-month phrase-only students: ten distinct phrases/day, all grades, skipped days, API/web/native predictions, ordered options and distinct labels.');
