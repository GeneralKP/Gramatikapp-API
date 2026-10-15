import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase, getDatabaseClient } from '../src/lib/database.js';
import { defaultUserSettings } from '../src/features/auth/auth.types.js';
import { initialScheduler } from '../src/features/progress/scheduler.js';
import { saveReview, undoReview, ReviewConflict } from '../src/features/progress/reviews.js';
import { loadCompactStudyQueue } from '../src/features/progress/studyTransport.js';
import { loadDueStudyProgress } from '../src/features/progress/progress.resolvers.js';
import { scheduleStudyReview } from '../src/features/progress/studyScheduling.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

// A dedicated disposable replica is mandatory. A different database name on an
// existing server is insufficient protection against synthetic production writes.
assert.match(process.env.MONGODB_URI ?? '', /^mongodb:\/\/127\.0\.0\.1:(?:27419|27019)\//,
  'Use the owned local replica on port 27419 or the isolated CI replica on port 27019.');
const originalDb = MongoClient.prototype.db, originalConnect = MongoClient.prototype.connect, databaseName = `practice_consistency_${process.pid}`;
MongoClient.prototype.db = function () { return originalDb.call(this, databaseName); };
MongoClient.prototype.connect = async function () { this.monitorCommands = true; return originalConnect.call(this); };
const start = new Date('2026-10-12T10:00:00Z');
mock.timers.enable({ apis: ['Date'], now: +start });
const db = await connectDatabase(), userId = new ObjectId();
const user = { _id: userId, email: `practice-${userId}@example.invalid`, authProvider: 'email' as const,
  settings: { ...defaultUserSettings, dailyNewCards: 20 }, createdAt: start };
const card = (fresh = true): UserProgress => {
  const itemId = new ObjectId();
  const p: UserProgress = { _id: new ObjectId(), userId, itemId, itemType: 'WORD', isNew: fresh,
    interval: fresh ? 0 : 30, ease: 2.5, repetitions: fresh ? 0 : 5, totalReviews: fresh ? 0 : 8,
    lapses: fresh ? 0 : 1, failureIndex: 3, scheduleVersion: 0, nextDueDate: start,
    lastReviewed: fresh ? null : new Date(+start - 30 * 86400000), createdAt: new Date(+start - 100 * 86400000),
    card: { source: 'APP', sourceCardId: BigInt(`0x${itemId}`).toString(), sourceNoteGuid: String(itemId), direction: 'DE_ES',
      prompt: 'das Haus', answer: 'casa', acceptedAnswers: ['casa'], notes: '', examples: [], deck: 'App', tags: [] } };
  p.scheduler = initialScheduler(p); return p;
};
const normalize = (value: any) => JSON.parse(JSON.stringify(value));
const automatic = async (itemType?: string) => {
  const args = { userId: String(userId), dueLimit: 50, newLimit: 0, itemType };
  const legacy = await loadDueStudyProgress(args, { user });
  const compact = await loadCompactStudyQueue(user, { ...args, includeCounts: true });
  return { ids: legacy.map(p => String(p.itemId)), compact };
};
try {
  await db.users.insertOne(user);
  for (const grade of ['AGAIN', 'HARD', 'GOOD'] as const) {
    mock.timers.setTime(+start);
    await db.progress.deleteMany({ userId });
    const fresh = card(); await db.progress.insertOne(fresh);
    const reviewId = randomUUID(), receipt = await saveReview(userId, fresh.itemId, 'WORD', grade, reviewId, 0);
    const saved = await db.progress.findOne({ _id: fresh._id });
    assert.ok(saved.nextDueDate > start);
    assert.equal(saved.againPending, grade === 'AGAIN');
    assert.deepEqual(normalize(receipt.progress), normalize({ ...saved, extraPractice: false }), 'Normal response equals the actual committed MongoDB row');
    assert.equal(saved.failureIndex, fresh.failureIndex);
    assert.equal((await db.reviewEvents.findOne({ userId, reviewId })).after.nextDueDate.toISOString(), saved.nextDueDate.toISOString());
    assert.deepEqual(normalize((await saveReview(userId, fresh.itemId, 'WORD', grade, reviewId, 0)).progress), normalize(receipt.progress), 'Lost ACK returns the same saved schedule');
    assert.equal(await db.reviewEvents.countDocuments({ userId, reviewId }), 1);
    await assert.rejects(saveReview(userId, fresh.itemId, 'WORD', 'EASY', randomUUID(), 0), error => error instanceof ReviewConflict && error.code === 'STALE_CARD');
    for (const time of [+start, +saved.nextDueDate - 1]) {
      mock.timers.setTime(time);
      for (const mode of ['WORD', undefined]) {
        const result = await automatic(mode);
        assert.deepEqual(result.ids, grade === 'AGAIN' ? [String(fresh.itemId)] : [], `${grade}: word-to-mixed selection retains unresolved Again while other ratings wait for the exact saved due instant`);
        assert.deepEqual(result.compact.items.map(p => p.id), result.ids);
        assert.deepEqual(result.compact.counts, { new: 0, learning: grade === 'AGAIN' ? 1 : 0, review: 0 });
      }
    }
    mock.timers.setTime(+saved.nextDueDate);
    for (const mode of ['WORD', undefined]) {
      const result = await automatic(mode);
      assert.deepEqual(result.ids, [String(fresh.itemId)], `${grade}: learning repetition is available at the saved due instant`);
      assert.deepEqual(result.compact.items.map(p => p.id), result.ids);
      assert.deepEqual(result.compact.counts, { new: 0, learning: 1, review: 0 });
    }
    const undone = await undoReview(userId, reviewId);
    assert.equal(undone.progress.nextDueDate.toISOString(), fresh.nextDueDate.toISOString());
    assert.equal(undone.progress.totalReviews ?? 0, 0);
    assert.equal(undone.progress.againPending, undefined, 'Undo restores the absent pre-review retry flag');
    assert.equal(undone.progress.failureIndex, fresh.failureIndex);
    assert.equal((await undoReview(userId, reviewId)).progress.scheduleVersion, undone.progress.scheduleVersion);
  }
  mock.timers.setTime(+start);
  const mature = card(false); await db.progress.insertOne(mature);
  scheduleStudyReview(mature, 'GOOD', start);
  const commands: string[] = [], listener = (event: any) => {
    if (['find', 'insert', 'update', 'aggregate'].includes(event.commandName)) commands.push(event.commandName);
  };
  const client = getDatabaseClient(); client.on('commandStarted', listener);
  const before = performance.now();
  const matureReceipt = await saveReview(userId, mature.itemId, 'WORD', 'GOOD', randomUUID(), 0);
  const elapsed = performance.now() - before;
  client.off('commandStarted', listener);
  const matureSaved = await db.progress.findOne({ _id: mature._id });
  assert.deepEqual(normalize(matureReceipt.progress), normalize({ ...matureSaved, extraPractice: false }));
  assert.deepEqual(commands, ['find', 'find', 'insert', 'update'], 'Real established review uses four sequential data commands');
  console.log(JSON.stringify({ establishedReviewDataCommands: commands.length, commands, loopbackReviewMs: Number(elapsed.toFixed(2)) }));
  console.log('PASS real isolated transactions: immediate Again and ordinary exact due across word/mixed counters, committed response, retry, stale version, Undo and failure preservation');
} finally {
  await originalDb.call(getDatabaseClient(), databaseName).dropDatabase();
  await closeDatabase();
  mock.timers.reset();
  MongoClient.prototype.db = originalDb;
  MongoClient.prototype.connect = originalConnect;
}
