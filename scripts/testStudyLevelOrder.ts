import 'dotenv/config';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { connectDatabase, closeDatabase, getDatabaseClient } from '../src/lib/database.js';
import { defaultUserSettings } from '../src/features/auth/auth.types.js';
import { CEFR_LEVELS } from '../src/features/levels/levels.js';
import { loadStudyQueueCounts, loadMoreStudyProgress, loadDueStudyProgress } from '../src/features/progress/progress.resolvers.js';
import { scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import { syncStudy } from '../src/features/progress/studySync.js';
import { newItemIdentityPipeline } from '../src/features/progress/studySummaries.js';
import { nativeWordPair } from '../src/features/progress/nativeWordPairs.js';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';
import { loadCompactStudyQueue, COMPACT_STUDY_SELECTION } from '../src/features/progress/studyTransport.js';
import { invalidateStudyCatalog } from '../src/features/progress/catalogSummaryCache.js';

assert.match(process.env.MONGODB_URI ?? '', /^mongodb:\/\/127\.0\.0\.1:27019\//, 'Use the isolated loopback replica set');
const databaseName = `study_level_tests_${process.pid}`, originalDb = MongoClient.prototype.db;
MongoClient.prototype.db = function () { return originalDb.call(this, databaseName); };
const db = await connectDatabase(), userId = new ObjectId(), now = new Date();
const user = { _id: userId, email: 'level-fixture@example.invalid', authProvider: 'email', settings: { ...defaultUserSettings, dailyNewCards: 1000 }, createdAt: now };
const rank = new Map<string, string>();
try {
  await db.users.insertOne(user as never);
  // Reverse insertion order exposes natural cursor ordering, independently of IDs.
  for (const type of ['WORD', 'PHRASE'] as const) for (const level of [...CEFR_LEVELS].reverse()) {
    const deId = new ObjectId(), esId = new ObjectId(), relationId = new ObjectId();
    const common = { contexts: ['general_vocabulary'], createdAt: now, level: level.slice(0, 2) };
    await (type === 'WORD' ? db.wordsDE : db.phrasesDE).insertOne({ ...common, _id: deId, cefrLevel: level, ...(type === 'WORD' ? { word: `Wort ${level}`, examples: [], gramaticalCategories: [], forms: {} } : { phrase: `Satz ${level}`, words: [], synonyms: [] }) } as never);
    await (type === 'WORD' ? db.wordsES : db.phrasesES).insertOne({ ...common, _id: esId, cefrLevel: 'C2.2', ...(type === 'WORD' ? { word: `palabra ${level}`, examples: [], gramaticalCategories: [] } : { phrase: `frase ${level}`, words: [], synonyms: [] }) } as never);
    await (type === 'WORD' ? db.relationsWordsEsDe : db.relationsPhrasesEsDe).insertOne({ _id: relationId, main: esId, translated: deId, createdAt: now });
    rank.set(String(relationId), level);
    if (level === 'C2.2') await db.progress.insertOne({ _id: new ObjectId(), userId, itemId: relationId, itemType: type, isNew: true,
      ease: 2.5, interval: 0, repetitions: 0, totalReviews: 0, failureIndex: 0, scheduleVersion: 0,
      nextDueDate: now, lastReviewed: null, createdAt: now } as never);
  }
  const danglingIds: ObjectId[] = [];
  for (const type of ['WORD', 'PHRASE'] as const) {
    const relationId = new ObjectId(); danglingIds.push(relationId);
    await (type === 'WORD' ? db.relationsWordsEsDe : db.relationsPhrasesEsDe).insertOne({ _id: relationId, main: new ObjectId(), translated: new ObjectId(), createdAt: now });
    await db.progress.insertOne({ _id: new ObjectId(), userId, itemId: relationId, itemType: type, isNew: true,
      ease: 2.5, interval: 0, repetitions: 0, nextDueDate: now, lastReviewed: null, createdAt: now } as never);
  }
  invalidateStudyCatalog(db);
  for (const type of ['WORD', 'PHRASE'] as const) {
    const introductions: string[] = [];
    for (let i = 0; i < CEFR_LEVELS.length; i++) {
      const queue = await loadDueStudyProgress({ userId: String(userId), itemType: type, dueLimit: 0, newLimit: type === 'WORD' ? 2 : 1 }, { user } as never);
      const levels = queue.map(p => rank.get(String(p.relationId ?? p.itemId)));
      assert.deepEqual(levels, Array(type === 'WORD' ? 2 : 1).fill(CEFR_LEVELS[i]), `${type}: ${CEFR_LEVELS[i]} must precede every later pending/unseen level (got ${levels.join(',')})`);
      if (type === 'WORD') assert.deepEqual(queue.map(p => p.card.direction), ['DE_ES', 'ES_DE']);
      introductions.push(levels[0]);
      for (const p of queue) {
        const preview = studyReviewOptions(p, now).find(o => o.grade === 'EASY')!;
        const result = await syncStudy(userId, [{ id: randomUUID(), kind: 'REVIEW', itemId: String(p.itemId), itemType: type, grade: 'EASY', expectedVersion: p.scheduleVersion ?? 0, occurredAt: now.toISOString(), sessionId: 'level-order-fixture' }]);
        assert.ok(result.results[0].success, JSON.stringify(result.results));
        const saved = await db.progress.findOne({ userId, itemId: p.itemId });
        assert.equal(saved.nextDueDate.toISOString(), preview.nextDueDate);
        assert.equal(saved.interval, scheduleStudyReview(p, 'EASY', now).interval);
      }
    }
    assert.deepEqual(introductions, CEFR_LEVELS);
    console.log(`PASS ${type}: all twelve levels, pending C2 versus unseen A1, German classification, recognition first and persisted preview dates`);
  }
  for (const type of ['WORD', 'PHRASE'] as const) {
    const counts = await loadStudyQueueCounts({ userId: String(userId), itemType: type }, { user } as never);
    assert.equal(counts.new, 0, `${type}: dangling bilingual endpoint must not advertise a new card after curriculum exhaustion`);
    assert.equal(counts.total, 12, `${type}: playable totals exclude dangling endpoints`);
    const envelope = await loadCompactStudyQueue(user as never, { itemType: type, dueLimit: 50, newLimit: 1000, includeCounts: true, cardLimit: 24 });
    assert.equal(envelope.items.length, 0); assert.equal(envelope.counts!.new, 0); assert.equal(envelope.counts!.review, 0, 'Completion counters must agree with an exhausted playable queue');
  }
  // Partial and blocked pending frontiers must count unseen eligible cards,
  // without allocating progress simply by asking for counters.
  await db.progress.deleteMany({ userId }); await db.reviewEvents.deleteMany({ userId });
  const counterUser = { ...user, settings: { ...user.settings, dailyNewCards: 20 } };
  await db.users.updateOne({ _id: userId }, { $set: { settings: counterUser.settings } });
  const pending = (relationId: ObjectId, itemType: 'WORD' | 'PHRASE') => ({ _id: new ObjectId(), userId, itemId: relationId, itemType,
    isNew: true, ease: 2.5, interval: 0, repetitions: 0, nextDueDate: now, lastReviewed: null, createdAt: now });
  const phrases = await db.relationsPhrasesEsDe.find({}).toArray();
  const latePhrase = phrases.find(r => rank.get(String(r._id)) === 'C2.2')!;
  await db.progress.insertOne(pending(latePhrase._id, 'PHRASE') as never);
  const beforeCounter = await db.progress.find({ userId }).toArray();
  const partialCount = await loadStudyQueueCounts({ userId: String(userId), itemType: 'PHRASE' }, { user: counterUser } as never);
  assert.equal(partialCount.new, 12, 'One later pending phrase cannot hide eleven earlier unseen phrases from counters');
  assert.deepEqual(await db.progress.find({ userId }).toArray(), beforeCounter, 'Counter reads never allocate or update progress');
  const partialPacket = await loadCompactStudyQueue(counterUser as never, { itemType: 'PHRASE', dueLimit: 0, newLimit: 20, includeCounts: true });
  assert.equal(partialPacket.items.length, partialCount.new); assert.equal(partialPacket.counts!.new, partialCount.new);
  assert.deepEqual(partialPacket.items.map(p => rank.get(p.id)), CEFR_LEVELS);
  for (const deferral of [{ suspended: true }, { buriedUntil: new Date(now.getTime() + 86400000) }]) {
    await db.progress.deleteMany({ userId });
    const relation = (await db.relationsWordsEsDe.find({}).toArray()).find(r => rank.get(String(r._id)) === 'A1.1')!;
    const de = await db.wordsDE.findOne({ _id: relation.translated }), es = await db.wordsES.findOne({ _id: relation.main });
    const [recognition, production] = nativeWordPair(pending(relation._id, 'WORD') as never, es!, de!);
    await db.progress.insertMany([{ ...recognition, ...deferral }, production]);
    const before = await db.progress.find({ userId }).toArray();
    const count = await loadStudyQueueCounts({ userId: String(userId), itemType: 'WORD' }, { user: counterUser } as never);
    assert.equal(count.new, 20, 'Blocked production must not hide twenty unseen eligible word cards');
    assert.deepEqual(await db.progress.find({ userId }).toArray(), before);
    const queue = await loadDueStudyProgress({ userId: String(userId), itemType: 'WORD', dueLimit: 0, newLimit: 20 }, { user: counterUser } as never);
    assert.equal(queue.length, count.new); assert.ok(queue.every(p => !p.relationId.equals(relation._id)));
  }
  await db.progress.deleteMany({ userId });
  const firstPhrase = phrases.find(r => rank.get(String(r._id)) === 'A1.1')!;
  await db.progress.insertOne({ ...pending(firstPhrase._id, 'WORD'), isNew: false, nextDueDate: new Date(now.getTime() + 86400000),
    card: { source: 'ANKI', sourceNoteGuid: 'cross-type-fixture', sourceCardId: 'cross-type-fixture', direction: 'DE_ES', deck: 'Other', prompt: 'import', answer: 'import', acceptedAnswers: ['import'], tags: [] } } as never);
  const typedCount = await loadStudyQueueCounts({ userId: String(userId), itemType: 'PHRASE' }, { user: counterUser } as never);
  assert.equal(typedCount.new, 12, 'A WORD identity collision cannot hide an unseen PHRASE relation');
  const typedQueue = await loadDueStudyProgress({ userId: String(userId), itemType: 'PHRASE', dueLimit: 0, newLimit: 20 }, { user: counterUser } as never);
  assert.equal(typedQueue.length, typedCount.new); assert.equal(rank.get(String(typedQueue[0].itemId)), 'A1.1');
  await db.progress.deleteMany({ userId });
  await db.progress.insertOne(pending(latePhrase._id, 'PHRASE') as never);
  const mixedCount = await loadStudyQueueCounts({ userId: String(userId) }, { user: counterUser } as never);
  const mixedQueue = await loadDueStudyProgress({ userId: String(userId), dueLimit: 0, newLimit: 20 }, { user: counterUser } as never);
  assert.equal(mixedCount.new, 20); assert.equal(mixedQueue.length, mixedCount.new);
  await db.progress.deleteMany({ userId });
  await db.schedulerProfiles.insertOne({ _id: userId, timeZone: 'Europe/Berlin', rollover: 4, defaultOptions: { ...DEFAULT_OPTIONS, reviewsPerDay: 2 } } as never);
  const imported = Array.from({ length: 20 }, (_, index) => {
    const p = pending(new ObjectId(), 'PHRASE') as any;
    p.card = { source: 'ANKI', sourceNoteGuid: `deck-fixture-${index}`, sourceCardId: `deck-fixture-${index}`, direction: 'ES_DE', deck: 'Other', prompt: 'import', answer: 'import', acceptedAnswers: ['import'], tags: [] };
    p.scheduler = initialScheduler(p, { ...DEFAULT_OPTIONS, reviewsPerDay: 100 });
    return p;
  });
  await db.progress.insertMany(imported);
  const cappedCount = await loadStudyQueueCounts({ userId: String(userId), itemType: 'PHRASE' }, { user: counterUser } as never);
  const cappedQueue = await loadDueStudyProgress({ userId: String(userId), itemType: 'PHRASE', dueLimit: 0, newLimit: 20 }, { user: counterUser } as never);
  assert.equal(cappedCount.new, cappedQueue.length, 'Counter and retrieval use the same curriculum allocation budget before custom deck ceilings');
  assert.equal(cappedQueue.length, 10); // Twelve earlier App phrases are planned first; its cap permits two, then eight imported slots remain.
  await db.schedulerProfiles.deleteMany({ _id: userId });
  await db.users.updateOne({ _id: userId }, { $set: { settings: user.settings } });
  console.log('PASS counters: partial pending, suspended/buried recognition, typed collisions, mixed daily budget and no writes');
  // Separate owners/state scenarios in the same disposable database.
  await db.progress.deleteMany({ userId }); await db.reviewEvents.deleteMany({ userId });
  for (const [id] of rank) await db.progress.insertOne({ _id: new ObjectId(), userId, itemId: new ObjectId(id),
    itemType: (await db.relationsWordsEsDe.findOne({ _id: new ObjectId(id) })) ? 'WORD' : 'PHRASE',
    isNew: true, ease: 2.5, interval: 0, repetitions: 0, totalReviews: 0, nextDueDate: now, lastReviewed: null, createdAt: now } as never);
  const identityOwner = new ObjectId(), sharedId = new ObjectId(), pairRelation = new ObjectId();
  const identityCases: any[] = [
    { itemType: 'WORD', itemId: new ObjectId(), relationId: pairRelation },
    { itemType: 'WORD', itemId: new ObjectId(), relationId: pairRelation },
    { itemType: 'WORD', itemId: sharedId, relationId: null },
    { itemType: 'PHRASE', itemId: sharedId },
    { itemType: 'WORD', itemId: new ObjectId(), suspended: true },
    { itemType: 'PHRASE', itemId: new ObjectId(), supersededByAnki: true },
  ].map(p => ({ ...p, _id: new ObjectId(), userId: identityOwner }));
  await db.progress.insertMany(identityCases);
  for (const type of [undefined, 'WORD', 'PHRASE']) {
    const actual = await db.progress.aggregate<any>(newItemIdentityPipeline({ userId: identityOwner, ...(type ? { itemType: type } : {}) })).toArray();
    const expected = identityCases.filter(p => !type || p.itemType === type);
    assert.deepEqual(new Set(actual.map(p => `${p.itemType}:${p.itemId}`)), new Set(expected.map(p => `${p.itemType}:${p.relationId ?? p.itemId}`)), 'Grouped exclusions retain null/missing relations, both directions, cross-type IDs, legacy and suspended/superseded state');
  }
  const rawIdentities = await db.progress.find({ userId }).project({ itemId: 1, relationId: 1, itemType: 1 }).toArray();
  const grouped = await db.progress.aggregate<any>(newItemIdentityPipeline({ userId })).toArray();
  assert.deepEqual(new Set(grouped.map(p => `${p.itemType}:${p.itemId}`)), new Set(rawIdentities.map(p => `${p.itemType}:${p.relationId ?? p.itemId}`)), 'Grouped fresh identities preserve typed allocation exclusions');
  const bounded = await loadDueStudyProgress({ userId: String(userId), itemType: 'WORD', dueLimit: 50, newLimit: 2 }, { user } as never, COMPACT_STUDY_SELECTION);
  assert.deepEqual(bounded.map(p => rank.get(String(p.relationId ?? p.itemId))), ['A1.1', 'A1.1']);
  assert.equal(await db.progress.countDocuments({ userId, itemType: 'WORD', card: { $ne: null } }), 2, 'A small queue converts only the selected legacy word, not all later levels');
  const staleRows = await db.progress.find({ userId }).project<any>(COMPACT_STUDY_SELECTION).toArray();
  await db.progress.updateOne({ userId, itemId: bounded[0].itemId }, { $set: { failureIndex: 99 } });
  const refreshed = await loadDueStudyProgress({ userId: String(userId), itemType: 'WORD', dueLimit: 50, newLimit: 2 }, { user } as never, COMPACT_STUDY_SELECTION, { now, candidates: Promise.resolve(staleRows) });
  assert.equal(refreshed.find(p => p.itemId.equals(bounded[0].itemId))!.failureIndex, 99, 'Fresh failure count wins even without a timestamp/version change');
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => loadDueStudyProgress({ userId: String(userId), itemType: 'WORD', dueLimit: 50, newLimit: 2 }, { user } as never, COMPACT_STUDY_SELECTION)));
  assert.ok(concurrent.every(q => q.map(p => String(p.itemId)).join() === bounded.map(p => String(p.itemId)).join()));
  assert.equal(await db.progress.countDocuments({ userId, itemType: 'WORD', card: { $ne: null } }), 2);
  await db.progress.deleteMany({ userId });
  const partialUser = { ...user, settings: { ...user.settings, dailyNewCards: 1 } };
  await db.users.updateOne({ _id: userId }, { $set: { settings: partialUser.settings } });
  const partial = await loadDueStudyProgress({ userId: String(userId), itemType: 'WORD', dueLimit: 0, newLimit: 1 }, { user: partialUser } as never);
  assert.equal(partial.length, 1); assert.equal(partial[0].card.direction, 'DE_ES');
  assert.equal(rank.get(String(partial[0].relationId)), 'A1.1');
  await db.progress.deleteMany({ userId }); await db.users.updateOne({ _id: userId }, { $set: { settings: user.settings } });
  const extra = await loadMoreStudyProgress({ userId: String(userId), itemType: 'PHRASE', limit: 12 }, { user } as never);
  assert.deepEqual(extra.map(p => rank.get(String(p.relationId ?? p.itemId))), CEFR_LEVELS, 'Study More preserves the full twelve-level curriculum');
  await db.progress.deleteMany({ userId });
  const mixed = await loadDueStudyProgress({ userId: String(userId), dueLimit: 0, newLimit: 36 }, { user } as never);
  const mixedRanks = mixed.map(p => CEFR_LEVELS.indexOf(rank.get(String(p.relationId ?? p.itemId)) as never));
  assert.equal(mixed.length, 36); assert.ok(mixedRanks.every((r, i) => !i || r >= mixedRanks[i - 1]));
  assert.ok(mixed.every(p => !danglingIds.some(id => id.equals(p.relationId ?? p.itemId))));
  console.log('PASS integration edges: persisted dangling WORD/PHRASE, bounded legacy allocation, concurrent projected reloads, quota one, Study More and mixed twelve-level selection');
} finally {
  await originalDb.call(getDatabaseClient(), databaseName).dropDatabase();
  await closeDatabase(); MongoClient.prototype.db = originalDb;
}
