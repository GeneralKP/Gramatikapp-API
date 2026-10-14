import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { defaultUserSettings } from '../src/features/auth/auth.types.js';
import { syncStudy } from '../src/features/progress/studySync.js';
import { undoReview } from '../src/features/progress/reviews.js';
import { scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import { selectStudyQueue } from '../src/features/progress/studyQueue.js';
import { simulateStudy, simulationCards } from './lib/studyIntervalSimulation.js';

// The API fixes the database name internally: a separate loopback instance is
// mandatory. A different database name on a production URI is NOT isolation.
if (!process.env.MONGODB_URI?.startsWith('mongodb://127.0.0.1:27019/')) throw new Error('Use the disposable loopback replica set on port 27019.');
const db = await connectDatabase(), userId = new ObjectId(), sessionId = randomUUID();
const cards = simulationCards(userId, 50);
let reviews = 0;
try {
  await db.users.insertOne({ _id: userId, email: `interval-${userId}@example.invalid`, authProvider: 'email',
    settings: { ...defaultUserSettings, dailyNewCards: 13 }, createdAt: cards[0].createdAt });
  await db.progress.insertMany(cards);
  const { stats } = await simulateStudy('mixed', async event => {
    const review = { id: randomUUID(), kind: 'REVIEW', itemId: String(event.before.itemId), itemType: event.before.itemType,
      grade: event.grade, expectedVersion: event.before.scheduleVersion, occurredAt: event.now.toISOString(), sessionId };
    const jobs = event.grade === 'AGAIN' ? [{ ...review, id: randomUUID(), kind: 'FAILURE' }, review] : [review];
    const result = await syncStudy(userId, jobs);
    assert.ok(result.results.every(r => r.success), JSON.stringify(result.results));
    const saved = await db.progress.findOne({ userId, itemId: event.before.itemId });
    assert.equal(saved.nextDueDate.toISOString(), event.preview.nextDueDate, 'Original occurrence time, preview and Mongo due date agree');
    for (const key of ['interval', 'ease', 'repetitions', 'totalReviews', 'lapses', 'scheduleVersion'] as const) assert.equal(saved[key], event.after[key], key);
    assert.deepEqual(saved.scheduler, event.after.scheduler);
    const receipt = await db.reviewEvents.findOne({ userId, reviewId: review.id });
    assert.equal(receipt.reviewedAt.toISOString(), event.now.toISOString());
    if (++reviews % 50 === 0) {
      assert.ok((await syncStudy(userId, jobs)).results.every(r => r.success), 'Lost acknowledgement replay succeeds');
      assert.equal(await db.reviewEvents.countDocuments({ userId, reviewId: review.id }), 1);
      assert.equal((await db.progress.findOne({ _id: saved._id })).scheduleVersion, saved.scheduleVersion);
    }
  }, cards);
  console.log(JSON.stringify({ ...stats, persistedReviews: reviews }));

  const card = await db.progress.findOne({ userId, itemType: 'WORD', 'scheduler.phase': 'REVIEW', interval: { $gt: 5 } });
  const id = randomUUID();
  const revisit = { id, kind: 'REVIEW', itemId: String(card.itemId), itemType: 'WORD', grade: 'REVISIT', expectedVersion: card.scheduleVersion, occurredAt: new Date('2026-10-09T10:00:00Z').toISOString(), sessionId };
  // Use a past review time so validation remains deterministic on real clocks.
  const time = new Date(revisit.occurredAt), predicted = scheduleStudyReview(card, 'REVISIT', time);
  assert.ok((await syncStudy(userId, [revisit])).results[0].success);
  const saved = await db.progress.findOne({ _id: card._id });
  assert.equal(saved.temporaryDueDate.toISOString(), predicted.temporaryDueDate.toISOString());
  const tomorrow = saved.temporaryDueDate;
  assert.equal(selectStudyQueue([saved], new Map(), new Date(+tomorrow - 1), 10, 0).length, 0, 'Revisit is unavailable before its exact due instant');
  assert.equal(selectStudyQueue([saved], new Map(), tomorrow, 10, 0).length, 1);
  assert.deepEqual(studyReviewOptions(saved, tomorrow).filter(o => o.grade !== 'REVISIT' && o.grade !== 'KNOWN').map(o => o.grade), ['AGAIN', 'HARD', 'GOOD', 'EASY']);
  const completeId = randomUUID();
  const completion = { ...revisit, id: completeId, grade: 'GOOD', expectedVersion: saved.scheduleVersion, occurredAt: tomorrow.toISOString() };
  assert.ok((await syncStudy(userId, [completion])).results[0].success);
  assert.ok((await syncStudy(userId, [completion])).results[0].success);
  const completed = await db.progress.findOne({ _id: saved._id });
  const expectedCompletion = scheduleStudyReview(saved, 'GOOD', tomorrow);
  assert.equal(completed.nextDueDate.toISOString(), expectedCompletion.nextDueDate.toISOString());
  assert.equal(completed.interval, expectedCompletion.interval);
  assert.equal(completed.temporaryDueDate, undefined);
  assert.ok((await undoReview(userId, completeId)).progress.temporaryDueDate);
  assert.equal((await db.progress.findOne({ _id: saved._id })).failureIndex, saved.failureIndex, 'Undo preserves lifetime mistakes');
  assert.ok(!(await syncStudy(userId, [{ ...completion, id: randomUUID() }])).results[0].success, 'An obsolete schedule version is rejected');
  console.log('PASS actual sync/transactions/history, six-month replay, lost acknowledgements, exact Revisit eligibility, completion, Undo and stale versions');
} finally {
  await db.reviewEvents.deleteMany({ userId });
  await db.progress.deleteMany({ userId });
  await db.users.deleteOne({ _id: userId });
  await closeDatabase();
}
