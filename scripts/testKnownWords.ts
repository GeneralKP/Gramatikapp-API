import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { initialScheduler, studyDay, dateForStudyDay } from '../src/features/progress/scheduler.js';
import { scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import { saveReview, undoReview, dailyCounts } from '../src/features/progress/reviews.js';
import { introducedToday } from '../src/features/progress/dailyLimit.js';
import { syncStudy } from '../src/features/progress/studySync.js';
import { loadDueStudyProgress } from '../src/features/progress/progress.resolvers.js';
import { invalidateStudyCatalog } from '../src/features/progress/catalogSummaryCache.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

assert.match(process.env.GRAMATIK_ISOLATED_FIXTURE ?? '', /^known_fixture_\d+_[a-f0-9]{12}$/, 'Run only through the isolated fixture runner');
const endpoint = new URL(process.env.MONGODB_URI!);
assert.equal(endpoint.hostname, '127.0.0.1');
assert.ok(['27935', '27019', '27043'].includes(endpoint.port));
const userId = new ObjectId(), now = new Date('2026-10-14T12:00:00Z');
function card(direction: 'DE_ES' | 'ES_DE' = 'DE_ES', note = randomUUID()): UserProgress {
  const p: UserProgress = { _id: new ObjectId(), userId, itemId: new ObjectId(), itemType: 'WORD',
    failureIndex: 7, isNew: true, ease: 2.5, interval: 0, repetitions: 0, totalReviews: 0,
    nextDueDate: now, lastReviewed: null, createdAt: now,
    card: { source: 'APP', sourceCardId: direction === 'DE_ES' ? '1790000000000' : '1790000000001', sourceNoteGuid: note,
      direction, prompt: 'Haus', answer: 'casa', acceptedAnswers: ['casa'], notes: '', examples: [], deck: 'Known fixture', tags: [] } };
  p.scheduler = initialScheduler(p); return p;
}
for (const date of ['2026-10-15T12:00:00Z', '2026-03-28T23:30:00Z', '2026-10-24T23:30:00Z', '2028-02-29T12:00:00Z']) {
  const at = new Date(date), p = card();
  const known = { ...p, ...scheduleStudyReview(p, 'KNOWN', at) };
  assert.equal(known.interval, 180); assert.equal(known.isNew, false);
  assert.equal(+known.nextDueDate, +dateForStudyDay(studyDay(at, 'Europe/Berlin', 4) + 180, 'Europe/Berlin', 4));
  const due = known.nextDueDate;
  const options = studyReviewOptions(known, due);
  for (const [grade, days] of [['HARD', 180], ['GOOD', 270], ['EASY', 365]] as const) {
    const next = scheduleStudyReview(known, grade, due);
    assert.equal(next.delaySeconds, days * 86400);
    assert.equal(options.find(option => option.grade === grade)?.nextDueDate, next.nextDueDate.toISOString());
    assert.equal(+next.nextDueDate, +dateForStudyDay(studyDay(due, 'Europe/Berlin', 4) + days, 'Europe/Berlin', 4));
  }
  const again = { ...known, ...scheduleStudyReview(known, 'AGAIN', due) };
  assert.equal(again.scheduler.knownInterval, undefined); assert.equal(again.lapses, 1);
  assert.equal(again.againPending, true); assert.equal(again.scheduler.phase, 'RELEARNING'); assert.equal(again.delaySeconds, 600);
  assert.equal(scheduleStudyReview(again, 'HARD', again.nextDueDate).interval, 1);
  assert.equal(scheduleStudyReview(again, 'HARD', again.nextDueDate).againPending, false);
  const good = { ...known, ...scheduleStudyReview(known, 'GOOD', due) };
  assert.equal(scheduleStudyReview(good, 'GOOD', good.nextDueDate).interval, 405);
  const easy = { ...known, ...scheduleStudyReview(known, 'EASY', due) };
  assert.equal(scheduleStudyReview(easy, 'HARD', easy.nextDueDate).interval, 365);
  const temporary = { ...known, ...scheduleStudyReview(known, 'REVISIT', due) };
  assert.equal(temporary.scheduler.knownInterval, 270);
  assert.equal(scheduleStudyReview(temporary, 'AGAIN', temporary.temporaryDueDate!).interval, 1);
}
assert.throws(() => scheduleStudyReview({ ...card(), itemType: 'PHRASE' }, 'KNOWN', now));
const ordinary = card(); assert.equal(scheduleStudyReview(ordinary, 'EASY', now).scheduler.knownInterval, undefined);
console.log('PASS future due-date simulations, DST/rollover/leap dates, exact previews, forgotten-anchor reset, growth, Revisit and ordinary-card isolation');

const db = await connectDatabase();
try {
  const note = randomUUID(), primary = card('DE_ES', note), sibling = card('ES_DE', note);
  const other = { ...card('ES_DE', note), userId: new ObjectId() };
  await db.users.insertOne({ _id: userId, email: `fixture-${randomUUID()}@example.test`, password: 'fixture', settings: { dailyNewCards: 0 } } as never);
  await db.progress.insertMany([primary, sibling, other]);
  const id = randomUUID(), timing = { reviewedAt: now, studySessionId: randomUUID() };
  await Promise.all(Array.from({ length: 5 }, () => saveReview(userId, primary.itemId, 'WORD', 'KNOWN', id, 0, false, undefined, timing)));
  for (const p of [primary, sibling]) {
    const saved = await db.progress.findOne({ _id: p._id });
    assert.equal(saved.scheduler.knownInterval, 180); assert.equal(saved.scheduleVersion, 1);
    assert.equal(saved.failureIndex, 7); assert.equal(saved.lastReviewId, id);
  }
  assert.equal((await db.progress.findOne({ _id: other._id })).isNew, true);
  assert.equal(await db.reviewEvents.countDocuments({ userId, reviewId: id }), 1);
  assert.equal(introducedToday(await dailyCounts(userId, studyDay(now, 'Europe/Berlin', 4))), 0);
  await undoReview(userId, id); await undoReview(userId, id);
  for (const p of [primary, sibling]) {
    const saved = await db.progress.findOne({ _id: p._id });
    assert.equal(saved.scheduler.phase, 'NEW'); assert.equal(saved.scheduler.knownInterval, undefined);
    assert.equal(saved.scheduleVersion, 2); assert.equal(saved.failureIndex, 7);
  }
  // Ordered offline commands retain their original dates and survive a lost ACK.
  const operation = { id: randomUUID(), kind: 'REVIEW' as const, itemId: String(primary.itemId), itemType: 'WORD' as const,
    grade: 'KNOWN' as const, expectedVersion: 2, occurredAt: now.toISOString(), sessionId: randomUUID() };
  assert.ok((await syncStudy(userId, [operation])).results[0].success);
  assert.ok((await syncStudy(userId, [operation])).results[0].success);
  assert.equal((await db.reviewEvents.findOne({ userId, reviewId: operation.id })).newCount, 0);
  await saveReview(userId, sibling.itemId, 'WORD', 'HARD', randomUUID(), 3, false, undefined, timing);
  await assert.rejects(undoReview(userId, operation.id), /direction of this word changed/);
  assert.equal((await db.progress.findOne({ _id: primary._id })).scheduler.knownInterval, 180);
  console.log('PASS transactional two-direction Known, zero quota including paused budget, idempotency, owner isolation, paired Undo, offline ACK retry and concurrent-review protection');
  await db.users.updateOne({ _id: userId }, { $set: { 'settings.dailyNewCards': 2 } });
  for (let i = 0; i < 4; i++) {
    const de = new ObjectId(), es = new ObjectId();
    const common = { contexts: ['general_vocabulary'], createdAt: now, cefrLevel: 'A1.1', level: 'A1', examples: [], gramaticalCategories: [], forms: {} };
    await db.wordsDE.insertOne({ ...common, _id: de, word: `Wort ${i}` } as never);
    await db.wordsES.insertOne({ ...common, _id: es, word: `palabra ${i}` } as never);
    await db.relationsWordsEsDe.insertOne({ _id: new ObjectId(), main: es, translated: de, createdAt: now });
  }
  invalidateStudyCatalog(db);
  const nextWord = async () => loadDueStudyProgress({ userId: String(userId), itemType: 'WORD', dueLimit: 0, newLimit: 2 }, { user: await db.users.findOne({ _id: userId }) });
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const queue = await nextWord();
    assert.equal(queue.length, 2, 'Every unmetered Known releases two places for a fresh word');
    assert.deepEqual(queue.map(p => p.card.direction), ['DE_ES', 'ES_DE']);
    const relation = String(queue[0].relationId); assert.ok(!seen.has(relation)); seen.add(relation);
    await saveReview(userId, queue[0].itemId, 'WORD', 'KNOWN', randomUUID(), queue[0].scheduleVersion ?? 0);
    assert.equal(introducedToday(await dailyCounts(userId, studyDay(new Date(), 'Europe/Berlin', 4))), 0);
  }
  assert.equal((await nextWord()).length, 0, 'A finite catalog stops honestly when every word is known');
  console.log('PASS actual catalog allocation/refill: four consecutive Known words, recognition order, fresh identities, full new allowance and catalog exhaustion');
} finally { await closeDatabase(); }
