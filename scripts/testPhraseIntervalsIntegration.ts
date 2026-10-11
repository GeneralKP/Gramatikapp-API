import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { mock } from 'node:test';
import { connectDatabase, closeDatabase, getDatabaseClient } from '../src/lib/database.js';
import { defaultUserSettings } from '../src/features/auth/auth.types.js';
import { GRADES } from '../src/features/progress/scheduler.js';
import { syncStudy } from '../src/features/progress/studySync.js';
import { undoReview } from '../src/features/progress/reviews.js';
import { scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import { selectStudyQueue } from '../src/features/progress/studyQueue.js';
import { phraseCard, phraseStart } from './lib/phraseSchedulingFixtures.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

// connectDatabase selects a fixed DB name. Require a separate local instance,
// rather than trusting a database-name suffix to protect production.
if (!process.env.MONGODB_URI?.startsWith('mongodb://127.0.0.1:27019/')) throw new Error('Use the disposable loopback replica set on port 27019.');
const originalDb = MongoClient.prototype.db, databaseName = `phrase_adaptive_tests_${process.pid}`;
MongoClient.prototype.db = function () { return originalDb.call(this, databaseName); };
mock.timers.enable({ apis: ['Date'], now: +phraseStart });
const db = await connectDatabase(), userId = new ObjectId(), sessionId = randomUUID();
let persistedReviews = 0;
const insert = async (phrase: UserProgress) => {
  phrase.userId = userId;
  await db.progress.insertOne(phrase);
  return phrase;
};
const review = async (before: UserProgress, grade: typeof GRADES[number], now: Date, earlyReview = false, failedAnswer = false) => {
  mock.timers.setTime(+now);
  const preview = studyReviewOptions(before, now, earlyReview).find(o => o.grade === grade)!;
  const predicted = scheduleStudyReview(before, grade, now, earlyReview);
  const command = { id: randomUUID(), kind: 'REVIEW', itemId: String(before.itemId), itemType: 'PHRASE', grade,
    expectedVersion: before.scheduleVersion, earlyReview, occurredAt: now.toISOString(), sessionId };
  const commands = failedAnswer ? [{ ...command, id: randomUUID(), kind: 'FAILURE' }, command] : [command];
  const result = await syncStudy(userId, commands);
  assert.ok(result.results.every(r => r.success), JSON.stringify(result.results));
  const saved = await db.progress.findOne({ _id: before._id });
  assert.equal(saved.nextDueDate.toISOString(), preview.nextDueDate, 'Preview → actual transaction due date');
  for (const key of ['interval', 'ease', 'repetitions', 'totalReviews', 'lapses', 'isNew'] as const) assert.equal(saved[key], predicted[key], key);
  assert.deepEqual(saved.scheduler, predicted.scheduler);
  assert.equal(saved.scheduleVersion, before.scheduleVersion + 1);
  assert.equal(saved.failureIndex, before.failureIndex + Number(failedAnswer));
  assert.equal(saved.temporaryDueDate, undefined, 'Ordinary phrase reviews clear expired temporary scheduling');
  const receipt = await db.reviewEvents.findOne({ userId, reviewId: command.id });
  assert.equal(receipt.itemType, 'PHRASE'); assert.equal(receipt.grade, grade);
  assert.equal(receipt.reviewedAt.toISOString(), now.toISOString());
  assert.equal(receipt.after.nextDueDate.toISOString(), preview.nextDueDate);
  assert.equal(receipt.earlyReview, earlyReview);
  assert.equal(receipt.studySessionId, sessionId);
  assert.ok((await syncStudy(userId, commands)).results.every(r => r.success), 'Lost acknowledgement replay');
  assert.equal(await db.reviewEvents.countDocuments({ userId, reviewId: command.id }), 1);
  const replayed = await db.progress.findOne({ _id: before._id });
  assert.equal(replayed.scheduleVersion, saved.scheduleVersion);
  assert.equal(replayed.totalReviews, saved.totalReviews);
  assert.equal(replayed.failureIndex, saved.failureIndex, 'FAILURE retry must not count a second mistake');
  persistedReviews++;
  return { saved, command };
};
try {
  await db.users.insertOne({ _id: userId, email: `phrase-${userId}@example.invalid`, authProvider: 'email',
    settings: { ...defaultUserSettings, dailyNewCards: 10 }, createdAt: phraseStart });
  // Both DST boundaries are in the past; occurrence-time validation stays real.
  for (const now of [phraseStart, new Date('2026-03-28T03:00:00Z'), new Date('2025-10-25T02:00:00Z')]) {
    for (const timing of ['early', 'due', 'overdue'] as const) for (const grade of GRADES) {
      const before = phraseCard(180);
      before.lapses = 7; before.scheduler.lapses = 7;
      before.nextDueDate = new Date(+now + (timing === 'early' ? 30 : timing === 'overdue' ? -30 : 0) * 86400000);
      await insert(before);
      const { saved, command } = await review(before, grade, now, timing === 'early', grade === 'AGAIN');
      assert.equal(saved.scheduler.phase, grade === 'AGAIN' ? 'RELEARNING' : 'REVIEW');
      assert.deepEqual(saved.scheduler.options, before.scheduler.options, 'The longer preset never compounds stored settings');
      const strict = { ...saved, scheduler: { ...saved.scheduler, options: { ...saved.scheduler.options, learnAheadSeconds: 0 } } };
      assert.equal(selectStudyQueue([strict], new Map(), new Date(+saved.nextDueDate - 1), 10, 0).length, 0, 'Exact due eligibility with optional learn-ahead disabled');
      assert.equal(selectStudyQueue([strict], new Map(), saved.nextDueDate, 10, 0).length, 1);
      if (grade === 'AGAIN') assert.equal(saved.leech, true, 'Shared leech accounting survives the phrase-specific lapse transition');
      await undoReview(userId, command.id);
      const undone = await db.progress.findOne({ _id: before._id });
      assert.equal(undone.nextDueDate.toISOString(), before.nextDueDate.toISOString());
      assert.deepEqual(undone.scheduler, before.scheduler);
      assert.equal(undone.totalReviews, before.totalReviews);
      assert.equal(undone.lapses, before.lapses);
      assert.equal(undone.failureIndex, saved.failureIndex, 'Undo preserves the lifetime mistake');
      assert.equal(undone.scheduleVersion, saved.scheduleVersion + 1);
      assert.ok((await db.reviewEvents.findOne({ userId, reviewId: command.id })).reversedAt);
      assert.ok(!(await syncStudy(userId, [{ ...command, id: randomUUID() }])).results[0].success, 'Stale phrase version cannot overwrite Undo');
    }
  }
  for (const grade of GRADES) {
    const limited = phraseCard(10);
    limited.scheduler.options = { ...limited.scheduler.options, maximumInterval: 10 };
    limited.nextDueDate = new Date(+phraseStart + 30 * 86400000);
    await insert(limited);
    const previews = studyReviewOptions(limited, phraseStart, true);
    assert.ok(previews.every((option, i) => !i || option.delaySeconds >= previews[i - 1].delaySeconds));
    const { saved } = await review(limited, grade, phraseStart, true);
    assert.ok(saved.interval <= 10);
    assert.ok(saved.nextDueDate > phraseStart);
    assert.equal(saved.scheduler.options.maximumInterval, 10);
  }
  // Repeated successful due reviews persist adaptive growth, including future
  // dates on the isolated API clock. Receipt retries never apply growth twice.
  const traces: Record<string, number[]> = {};
  for (const grade of ['HARD', 'GOOD', 'EASY'] as const) {
    let phrase = phraseCard(2); await insert(phrase);
    traces[grade] = [];
    for (let i = 0; i < 6; i++) {
      const previous = phrase;
      phrase = (await review(phrase, grade, phrase.nextDueDate)).saved;
      assert.ok(phrase.interval > previous.interval || previous.interval === phrase.scheduler.options.maximumInterval && phrase.interval === previous.interval, 'Persisted successful interval grows until its configured cap');
      assert.deepEqual(phrase.scheduler.options, previous.scheduler.options);
      traces[grade].push(phrase.interval);
    }
    assert.equal(phrase.totalReviews, 18); assert.equal(phrase.scheduleVersion, 6);
  }
  console.log(JSON.stringify({ persistedGrowth: traces }));
  let forgotten = await insert(phraseCard(30));
  forgotten = (await review(forgotten, 'AGAIN', forgotten.nextDueDate)).saved;
  assert.equal(forgotten.scheduler.phase, 'RELEARNING'); assert.ok(forgotten.interval < 30);
  forgotten = (await review(forgotten, 'GOOD', forgotten.nextDueDate)).saved;
  assert.equal(forgotten.scheduler.phase, 'RELEARNING');
  forgotten = (await review(forgotten, 'GOOD', forgotten.nextDueDate)).saved;
  assert.equal(forgotten.scheduler.phase, 'REVIEW');
  const recovered = (await review(forgotten, 'GOOD', forgotten.nextDueDate)).saved;
  assert.ok(recovered.interval > forgotten.interval, 'Successful recall resumes adaptive growth after relearning');
  for (const grade of GRADES) {
    const fresh = await insert(phraseCard(0));
    assert.deepEqual(studyReviewOptions(fresh, phraseStart).map(o => o.delaySeconds), [7, 30, 180, 365].map(days => days * 86400));
    const { saved } = await review(fresh, grade, phraseStart);
    assert.equal(saved.scheduler.phase, grade === 'AGAIN' || grade === 'HARD' ? 'LEARNING' : 'REVIEW');
  }
  let learning = await insert(phraseCard(0));
  learning = (await review(learning, 'HARD', phraseStart)).saved;
  learning = (await review(learning, 'GOOD', learning.nextDueDate)).saved;
  assert.equal(learning.scheduler.phase, 'LEARNING');
  learning = (await review(learning, 'GOOD', learning.nextDueDate)).saved;
  assert.equal(learning.scheduler.phase, 'REVIEW'); assert.ok(learning.interval >= 170 && learning.interval <= 190);
  let phrase = await insert(phraseCard(0));
  phrase = (await review(phrase, 'GOOD', phraseStart)).saved;
  assert.equal(phrase.scheduler.phase, 'REVIEW'); assert.equal(phrase.interval, 180);
  const initialInterval = phrase.interval;
  phrase = (await review(phrase, 'GOOD', phrase.nextDueDate)).saved;
  assert.ok(phrase.interval > initialInterval, 'Persisted first Good enters adaptive review without a fixed 180-day plateau');
  const unavailable = await syncStudy(userId, [{ id: randomUUID(), kind: 'REVIEW', itemId: String(phrase.itemId), itemType: 'PHRASE', grade: 'REVISIT',
    expectedVersion: phrase.scheduleVersion, occurredAt: phraseStart.toISOString(), sessionId }]);
  assert.ok(!unavailable.results[0].success, 'Phrase Revisit is rejected by the real service');
  assert.equal((await db.progress.findOne({ _id: phrase._id })).scheduleVersion, phrase.scheduleVersion);
  for (const grade of GRADES) {
    const stale = phraseCard(); stale.temporaryDueDate = new Date(+phraseStart - 1);
    await insert(stale);
    const { saved, command } = await review(stale, grade, phraseStart);
    assert.ok(saved.nextDueDate > phraseStart);
    await undoReview(userId, command.id);
    const undone = await db.progress.findOne({ _id: stale._id });
    assert.equal(undone.temporaryDueDate.toISOString(), stale.temporaryDueDate.toISOString(), 'Undo restores the legacy snapshot without losing history');
  }
  console.log(JSON.stringify({ persistedReviews, allGrades: true, timingContexts: ['early', 'due', 'overdue'], dstBoundaries: 2 }));
  console.log('PASS actual phrase transactions, all grades, original occurrence times, retries, failures, leeches, Undo, stale versions, exact queue eligibility, adaptive interval growth, relearning, stable presets and graduation.');
} finally {
  await db.reviewEvents.deleteMany({ userId });
  await db.progress.deleteMany({ userId });
  await db.users.deleteOne({ _id: userId });
  await originalDb.call(getDatabaseClient(), databaseName).dropDatabase();
  await closeDatabase(); MongoClient.prototype.db = originalDb; mock.timers.reset();
}
