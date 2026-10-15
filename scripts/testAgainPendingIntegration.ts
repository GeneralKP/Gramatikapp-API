import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { initialScheduler } from '../src/features/progress/scheduler.js';
import { syncStudy, type StudyOperation } from '../src/features/progress/studySync.js';
import { progressResolvers } from '../src/features/progress/progress.resolvers.js';
import { loadCompactStudyCards, loadCompactStudyQueue } from '../src/features/progress/studyTransport.js';
import { accountCounterPipeline, accountCounterTotals } from '../src/features/progress/studyAccountSummary.js';
import { loadDueStudyProgress, loadStudyQueueCounts } from '../src/features/progress/studySelection.js';
import { combinedStudyCandidateFilter, isDueStudyCandidate } from '../src/features/progress/studyCandidates.js';
import { invalidateStudyCatalog } from '../src/features/progress/catalogSummaryCache.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';
import type { User } from '../src/features/auth/auth.types.js';

if (!process.env.MONGODB_URI?.startsWith('mongodb://127.0.0.1:27043/')) throw new Error('Use the disposable Again fixture on loopback port 27043.');
const db = await connectDatabase(), userId = new ObjectId(), otherId = new ObjectId(), now = new Date();
const user = { _id: userId, email: `again-${userId}@example.invalid`, authProvider: 'email', settings: { dailyNewCards: 1000 }, createdAt: now } as User;
const sessionId = randomUUID(), cards: UserProgress[] = [];
const catalog = { words: [], phrases: [] };
const make = async (itemType: UserProgress['itemType'], interval: number, extra: Partial<UserProgress> = {}) => {
  const card: UserProgress = { _id: new ObjectId(), userId, itemId: new ObjectId(), itemType,
    ease: 2.5, interval, repetitions: interval ? 5 : 0, totalReviews: interval ? 8 : 0, lapses: 0,
    isNew: !interval, failureIndex: 2, nextDueDate: now, lastReviewed: interval ? new Date(+now - interval * 86400000) : null,
    createdAt: new Date('2025-01-01T00:00:00Z'), scheduleVersion: 0,
    card: { source: 'ANKI', sourceCardId: String(1800000000000 + cards.length), sourceNoteGuid: randomUUID(), direction: 'DE_ES',
      prompt: 'Haus', answer: 'casa', acceptedAnswers: ['casa'], notes: '', examples: [], deck: 'Again fixture', tags: [] }, ...extra };
  card.scheduler = initialScheduler(card);
  cards.push(card);
  await db.progress.insertOne(card);
  return card;
};
const operation = (card: UserProgress, fields: Partial<StudyOperation> = {}): StudyOperation => ({
  id: randomUUID(), kind: 'REVIEW', itemId: String(card.itemId), itemType: card.itemType, grade: 'AGAIN', expectedVersion: 0,
  occurredAt: now.toISOString(), sessionId, ...fields,
});
const stored = (card: UserProgress) => db.progress.findOne({ _id: card._id });
const totals = async () => {
  const query = { userId };
  const raw = await loadStudyQueueCounts({ userId: String(userId), newLimit: 0, dueLimit: 100 }, { user }, { now, progress: db.progress.find(query).toArray(), countersOnly: true });
  const packed = accountCounterTotals(await db.progress.aggregate(accountCounterPipeline(query, now)).toArray() as never, catalog, null);
  assert.deepEqual(packed, { learning: raw.learning, review: raw.review }, 'Mongo account summaries and full-state counters agree');
  return packed;
};
try {
  await db.users.insertOne(user);
  for (const type of ['WORD', 'PHRASE'] as const) for (const interval of [0, 30]) await make(type, interval);
  const commands = cards.map(card => operation(card));
  assert.ok((await syncStudy(userId, commands)).results.every(result => result.success));
  const first = await db.progress.find({ userId }).toArray();
  assert.ok(first.every(card => card.againPending && ['LEARNING', 'RELEARNING'].includes(card.scheduler.phase) && card.nextDueDate > now));
  assert.ok((await syncStudy(userId, commands)).results.every(result => result.success));
  assert.deepEqual(await db.progress.find({ userId }).toArray(), first, 'Lost ACK replay never repeats a review');
  assert.equal(await db.reviewEvents.countDocuments({ userId }), 4);
  assert.deepEqual(await totals(), { learning: 4, review: 0 });
  const candidates = await db.progress.find(combinedStudyCandidateFilter(userId, undefined, now)).toArray();
  assert.equal(candidates.filter(card => isDueStudyCandidate(card, now, null)).length, 4, 'Future DAY phrases survive compact candidate filtering');
  const requested = { userId: String(userId), newLimit: 0, dueLimit: 100 };
  assert.equal((await loadDueStudyProgress(requested, { user })).length, 4);
  assert.deepEqual(await loadStudyQueueCounts(requested, { user }, { now, progress: Promise.resolve(first), countersOnly: true }), { new: 0, learning: 4, review: 0 });
  const compact = await loadCompactStudyQueue(user, { newLimit: 0, dueLimit: 100, includeCounts: true, cardLimit: 1 });
  assert.equal(compact.manifest.length, 4);
  assert.ok(compact.manifest.every(card => card.schedule.state.againPending === true));
  assert.deepEqual(compact.counts, { new: 0, learning: 4, review: 0 });
  const hydration = await loadCompactStudyCards(user, { itemIds: [String(cards[2].itemId)] });
  assert.equal(hydration.items[0].schedule.state.againPending, true);
  const gql = await progressResolvers.Query.userProgress(null, { userId: String(userId), itemId: String(cards[0].itemId) }, { user });
  assert.equal(JSON.parse(gql.studyState).againPending, true);

  const card = cards[3], repeated = operation(card, { expectedVersion: 1 });
  assert.equal((await syncStudy(userId, [repeated])).results[0].success, true);
  assert.equal((await stored(card)).againPending, true);
  assert.equal((await stored(card)).scheduler.phase, 'RELEARNING');
  const hard = operation(card, { grade: 'HARD', expectedVersion: 2 });
  assert.equal((await syncStudy(userId, [hard])).results[0].success, true);
  assert.equal((await stored(card)).againPending, false);
  assert.deepEqual(await totals(), { learning: 3, review: 0 });
  const undo = operation(card, { kind: 'UNDO', reviewId: hard.id });
  assert.equal((await syncStudy(userId, [undo])).results[0].success, true);
  assert.equal((await stored(card)).againPending, true, 'Undo restores outstanding recall');
  assert.deepEqual(await totals(), { learning: 4, review: 0 });
  assert.equal((await stored(card)).failureIndex, 2, 'Retry intent never changes lifetime mistakes');
  assert.equal((await syncStudy(otherId, [operation(card)])).results[0].success, false);

  await db.progress.updateOne({ _id: cards[0]._id }, { $set: { suspended: true } });
  await db.progress.updateOne({ _id: cards[1]._id }, { $set: { buriedUntil: new Date(+now + 86400000) } });
  await db.progress.updateOne({ _id: cards[2]._id }, { $set: { supersededByAnki: true } });
  assert.deepEqual(await totals(), { learning: 1, review: 0 });
  assert.equal((await loadDueStudyProgress(requested, { user })).length, 1, 'Immediate retry honors suspension, burial and superseded cards');
  await db.relationsPhrasesEsDe.insertOne({ _id: card.itemId, main: new ObjectId(), translated: new ObjectId(), createdAt: now });
  const defer = operation(card, { kind: 'EDIT', grade: undefined, expectedVersion: 4,
    edit: { relationId: String(card.itemId), expectedContentVersion: 0, nextDueDate: new Date(+now + 30 * 86400000).toISOString() } });
  assert.equal((await syncStudy(userId, [defer])).results[0].success, true);
  assert.equal((await stored(card)).againPending, false, 'A persisted manual deferral overrides outstanding recall');
  assert.equal((await syncStudy(userId, [defer])).results[0].success, true);
  assert.deepEqual(await totals(), { learning: 0, review: 0 });
  assert.equal((await loadDueStudyProgress(requested, { user })).length, 0);
  const undoIntroduction = operation(cards[0], { kind: 'UNDO', grade: undefined, reviewId: commands[0].id });
  assert.equal((await syncStudy(userId, [undoIntroduction])).results[0].success, true);
  assert.equal((await stored(cards[0])).againPending, undefined, 'Undo unsets retry intent absent from the original snapshot');
  assert.equal((await stored(cards[0])).scheduler.phase, 'NEW');
  console.log('PASS durable Again retries, exact sync replay, Undo, general-mistake isolation, owner isolation, compact/hydration/GraphQL flags, real queue selection and both Mongo count paths');
} finally {
  await db.progress.deleteMany({ userId });
  await db.reviewEvents.deleteMany({ userId });
  await db.cardEditEvents.deleteMany({ userId });
  await db.relationsPhrasesEsDe.deleteMany({ _id: { $in: cards.map(card => card.itemId) } });
  await db.users.deleteOne({ _id: userId });
  invalidateStudyCatalog();
  await closeDatabase();
}
