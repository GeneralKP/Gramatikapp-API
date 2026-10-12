import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mock } from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { initialScheduler } from '../src/features/progress/scheduler.js';
import { saveReview, undoReview, ReviewConflict } from '../src/features/progress/reviews.js';
import { syncStudy } from '../src/features/progress/studySync.js';
import { scheduleStudyReview } from '../src/features/progress/studyScheduling.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

// No connection is opened: the real transaction callback is driven through
// isolated Mongo fixtures. Counts measure sequential data round trips, not live
// production latency. Optional latency models a remote round trip explicitly.
const latency = Number(process.env.REVIEW_FIXTURE_LATENCY_MS ?? 0);
const baseline = process.argv.includes('--baseline');
const now = new Date('2026-10-12T10:00:00Z'), userId = new ObjectId();
mock.timers.enable({ apis: ['Date'], now: +now });
const rows: Record<string, any[]> = { users: [], schedulerprofiles: [], userprogresses: [], reviewevents: [] };
let calls: string[] = [];
const dataCall = async (label: string) => {
  calls.push(label);
  if (latency) await new Promise(resolve => setTimeout(resolve, latency));
};
const equal = (a: any, b: any) => a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b)
  : a instanceof Date || b instanceof Date ? +a === +b : a === b;
const matches = (row: any, query: any) => Object.entries(query).every(([key, expected]: [string, any]) => {
  const value = key.split('.').reduce((target, part) => target?.[part], row);
  if (expected && typeof expected === 'object' && '$ne' in expected) return Array.isArray(value)
    ? !value.some(entry => equal(entry, expected.$ne)) : !equal(value, expected.$ne);
  return equal(value, expected);
});
const originals = { connect: MongoClient.prototype.connect, db: MongoClient.prototype.db, startSession: MongoClient.prototype.startSession };
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = function () { return { collection(name: string) {
  rows[name] ??= [];
  return {
    async createIndex() {}, async dropIndex() {},
    async findOne(query: any) { await dataCall(`${name}.findOne`); const found = rows[name].find(row => matches(row, query)); return found ? { ...found } : null; },
    async insertOne(doc: any) { await dataCall(`${name}.insertOne`); rows[name].push({ ...doc }); },
    async updateOne(query: any, update: any) {
      await dataCall(`${name}.updateOne`);
      const found = rows[name].find(row => matches(row, query));
      if (!found) return { matchedCount: 0 };
      Object.assign(found, update.$set);
      for (const key of Object.keys(update.$unset ?? {})) delete found[key];
      for (const [key, amount] of Object.entries(update.$inc ?? {}) as [string, number][]) found[key] = (found[key] ?? 0) + amount;
      for (const [key, entry] of Object.entries(update.$addToSet ?? {})) if (!found[key]?.includes(entry)) found[key] = [...(found[key] ?? []), entry];
      for (const [key, entry] of Object.entries(update.$max ?? {}) as [string, any][]) if (found[key] == null || found[key] < entry) found[key] = entry;
      return { matchedCount: 1 };
    },
    find(query: any) { return { async toArray() { await dataCall(`${name}.find`); return rows[name].filter(row => matches(row, query)); } }; },
    aggregate() { return { async toArray() { await dataCall(`${name}.aggregate`); return []; } }; },
  };
} } as any; };
MongoClient.prototype.startSession = function () { return { async withTransaction(work: any) { return work(); }, async endSession() {} } as any; };

const makeCard = () => {
  const card: UserProgress = { _id: new ObjectId(), userId, itemId: new ObjectId(), itemType: 'WORD', isNew: false,
    interval: 30, ease: 2.5, repetitions: 5, totalReviews: 8, lapses: 1, failureIndex: 3,
    nextDueDate: now, lastReviewed: new Date(+now - 30 * 86400000), createdAt: new Date(+now - 100 * 86400000),
    scheduleVersion: 0, failureAttemptIds: [randomUUID()] };
  card.scheduler = initialScheduler(card); rows.userprogresses.push(card); return card;
};
const normalize = (value: any) => JSON.parse(JSON.stringify(value));
try {
  await connectDatabase();
  const card = makeCard(), reviewId = randomUUID();
  // Warm Intl/scheduling code so the timing doesn't measure first-use setup.
  scheduleStudyReview(card, 'GOOD', now);
  calls = [];
  const started = performance.now();
  const result = await saveReview(userId, card.itemId, 'WORD', 'GOOD', reviewId, 0, false, undefined,
    { reviewedAt: now, studySessionId: randomUUID() });
  const duration = performance.now() - started, firstCalls = [...calls];
  const saved = rows.userprogresses.find(row => row._id.equals(card._id));
  assert.deepEqual(normalize(result.progress), normalize({ ...saved, extraPractice: false }), 'Review response must equal committed progress including failures and dates');
  assert.equal(saved.scheduleVersion, 1); assert.equal(saved.totalReviews, 9); assert.equal(saved.failureIndex, 3);
  assert.equal(rows.reviewevents[0].after.nextDueDate.toISOString(), saved.nextDueDate.toISOString());
  if (!baseline) {
    assert.equal(firstCalls.filter(call => call === 'schedulerprofiles.findOne').length, 0, 'Initialized established reviews need no profile read');
    assert.equal(firstCalls.filter(call => call === 'userprogresses.findOne').length, 1, 'A normal review needs one progress read, no read after its own write');
  }
  assert.deepEqual(normalize((await saveReview(userId, card.itemId, 'WORD', 'GOOD', reviewId, 0)).progress), normalize({ ...saved, extraPractice: false }), 'Lost ACK returns the current saved state');
  assert.equal(rows.reviewevents.length, 1, 'Retry cannot create another receipt');
  await assert.rejects(saveReview(userId, card.itemId, 'WORD', 'HARD', randomUUID(), 0), error => error instanceof ReviewConflict && error.code === 'STALE_CARD');
  const undone = await undoReview(userId, reviewId);
  assert.equal(undone.progress.totalReviews, 8); assert.equal(undone.progress.failureIndex, 3);
  const revisitCard = makeCard(); revisitCard.nextDueDate = new Date(+now + 100 * 86400000);
  const revisitId = randomUUID(), operation = { id: revisitId, kind: 'REVIEW', itemId: String(revisitCard.itemId), itemType: 'WORD', grade: 'REVISIT',
    expectedVersion: 0, occurredAt: now.toISOString(), sessionId: randomUUID() };
  assert.equal((await syncStudy(userId, [operation])).results[0].success, true);
  assert.equal((await syncStudy(userId, [operation])).results[0].success, true);
  const revisited = rows.userprogresses.find(row => row._id.equals(revisitCard._id));
  assert.equal(revisited.failureIndex, 4, 'Revisit failure is recorded once across pre-write and lost-ACK retry');
  assert.equal(revisited.nextDueDate.toISOString(), revisitCard.nextDueDate.toISOString());
  const legacy = makeCard(); delete legacy.scheduler;
  calls = [];
  await saveReview(userId, legacy.itemId, 'WORD', 'GOOD', randomUUID(), 0);
  assert.equal(calls.filter(call => call === 'schedulerprofiles.findOne').length, 1, 'Legacy initialization retains its profile read');
  const fresh = makeCard();
  Object.assign(fresh, { isNew: true, interval: 0, repetitions: 0, totalReviews: 0, lapses: 0, lastReviewed: null });
  fresh.scheduler = initialScheduler(fresh);
  rows.users.push({ _id: userId, settings: { dailyNewCards: 20 } });
  calls = [];
  await saveReview(userId, fresh.itemId, 'WORD', 'AGAIN', randomUUID(), 0);
  assert.equal(calls.filter(call => call === 'schedulerprofiles.findOne').length, 1, 'New introductions retain profile baselines');
  assert.ok(calls.includes('users.updateOne') && calls.includes('reviewevents.aggregate'), 'New quota checks still serialize and read durable receipts');
  console.log(JSON.stringify({ establishedReviewDataCalls: firstCalls.length, calls: firstCalls, fixtureRoundTripMs: latency, injectedWaitTotalMs: firstCalls.length * latency, measuredFixtureDurationMs: Number(duration.toFixed(2)) }));
  console.log('PASS review response matches committed state, version/receipt guards, lost ACK, Undo and monotonic Revisit mistakes');
} finally {
  await closeDatabase();
  mock.timers.reset();
  Object.assign(MongoClient.prototype, originals);
}
