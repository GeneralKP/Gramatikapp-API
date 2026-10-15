import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { recordArticleFailure } from '../src/features/progress/articleFailures.js';
import { initialScheduler } from '../src/features/progress/scheduler.js';
import { syncStudy, validateStudyOperations, type StudyOperation } from '../src/features/progress/studySync.js';
import { loadCompactStudyCards } from '../src/features/progress/studyTransport.js';
import { progressResolvers } from '../src/features/progress/progress.resolvers.js';
import { invalidateStudyCatalog } from '../src/features/progress/catalogSummaryCache.js';
import { GrammaticalCategory } from '../src/features/words/words.types.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';
import type { User } from '../src/features/auth/auth.types.js';

// This test owns a disposable loopback replica set, never the app database.
if (!process.env.MONGODB_URI?.startsWith('mongodb://127.0.0.1:27043/')) throw new Error('Use the isolated article fixture on port 27043.');
const db = await connectDatabase(), userId = new ObjectId(), otherId = new ObjectId(), now = new Date();
const relationIds: ObjectId[] = [], wordIds: ObjectId[] = [];
const make = async (categories = [GrammaticalCategory.NOUN], gender: string | undefined = 'der', type: 'WORD' | 'PHRASE' = 'WORD') => {
  const relationId = new ObjectId(), esId = new ObjectId(), deId = new ObjectId();
  relationIds.push(relationId); wordIds.push(esId, deId);
  const common = { examples: [], contexts: [], createdAt: now };
  await db.wordsES.insertOne({ _id: esId, word: 'árbol', gramaticalCategories: categories, ...common });
  await db.wordsDE.insertOne({ _id: deId, word: 'Baum', gramaticalCategories: categories, forms: { gender }, ...common });
  await db.relationsWordsEsDe.insertOne({ _id: relationId, main: esId, translated: deId, createdAt: now });
  const card: UserProgress = { _id: new ObjectId(), userId, itemId: new ObjectId(), relationId, itemType: type,
    failureIndex: 7, ease: 2.5, interval: 30, repetitions: 5, totalReviews: 10, lapses: 1, isNew: false,
    nextDueDate: new Date(+now + 90 * 86400000), lastReviewed: new Date(+now - 30 * 86400000), createdAt: now, scheduleVersion: 0 };
  card.scheduler = initialScheduler(card);
  await db.progress.insertOne(card);
  return card;
};
const operation = (card: UserProgress, fields: Partial<StudyOperation> = {}): StudyOperation => ({
  id: randomUUID(), kind: 'ARTICLE_FAILURE', itemId: String(card.itemId), itemType: 'WORD',
  occurredAt: now.toISOString(), sessionId: randomUUID(), ...fields,
});
const saved = (card: UserProgress) => db.progress.findOne({ _id: card._id });
try {
  const card = await make(), id = randomUUID();
  const before = await saved(card);
  await Promise.all(Array.from({ length: 20 }, () => recordArticleFailure(db, userId, card.itemId, id, now)));
  let after = await saved(card);
  assert.equal(after.articleFailureIndex, 1, 'Concurrent retries record one article mistake');
  assert.deepEqual(after.articleFailureAttemptIds, [id]);
  const { articleFailureIndex, articleFailureAttemptIds, lastArticleFailedAt, updatedAt, ...unchanged } = after;
  assert.deepEqual(unchanged, before, 'Article-only persistence never changes schedule or general mistakes');
  await Promise.all([randomUUID(), randomUUID()].map(attempt => recordArticleFailure(db, userId, card.itemId, attempt, new Date(+now - 86400000))));
  after = await saved(card);
  assert.equal(after.articleFailureIndex, 3);
  assert.equal(+after.lastArticleFailedAt, +now, 'Delayed offline commands never move the last article mistake backwards');
  await assert.rejects(recordArticleFailure(db, otherId, card.itemId, randomUUID()), /not found/);
  await assert.rejects(recordArticleFailure(db, userId, card.itemId, 'bad'), /Invalid/);
  const missingArticle = await make();
  const missingRelation = await db.relationsWordsEsDe.findOne({ _id: missingArticle.relationId });
  await db.wordsDE.updateOne({ _id: missingRelation.translated }, { $unset: { 'forms.gender': '' } });
  for (const invalid of [await make([GrammaticalCategory.VERB]), await make(undefined, ''), await make(undefined, '   '), missingArticle, await make(undefined, undefined, 'PHRASE')]) {
    assert.equal((await syncStudy(userId, [operation(invalid)])).results[0].success, false, 'Only nouns with stored articles qualify');
    assert.equal((await saved(invalid)).articleFailureIndex, undefined);
  }
  const article = operation(card), hard = operation(card, { kind: 'REVIEW', grade: 'HARD', expectedVersion: 0 });
  assert.ok((await syncStudy(userId, [article, hard])).results.every(result => result.success));
  const hardState = await saved(card);
  assert.equal(hardState.articleFailureIndex, 4);
  assert.equal(hardState.failureIndex, 7);
  assert.equal(hardState.scheduleVersion, 1, 'Hard article applies one ordinary Hard review');
  assert.ok((await syncStudy(userId, [article, hard])).results.every(result => result.success));
  assert.deepEqual(await saved(card), hardState, 'Lost acknowledgement retries neither increment nor grade twice');
  const undo = operation(card, { kind: 'UNDO', reviewId: hard.id });
  assert.equal((await syncStudy(userId, [undo])).results[0].success, true);
  assert.equal((await saved(card)).articleFailureIndex, 4, 'Undo restores schedule while retaining article mistakes');
  const revisit = operation(card, { kind: 'REVIEW', grade: 'REVISIT', expectedVersion: 2 }), articleRevisit = operation(card);
  assert.ok((await syncStudy(userId, [articleRevisit, revisit])).results.every(result => result.success));
  const revisited = await saved(card);
  assert.equal(revisited.articleFailureIndex, 5);
  assert.equal(revisited.failureIndex, 8, 'Ordinary Revisit still records its own general failure');
  assert.equal(+revisited.nextDueDate, +card.nextDueDate, 'Revisit article retains the regular future due date');
  assert.equal(+revisited.temporaryDueDate, +now + 86400000);
  assert.ok((await syncStudy(userId, [articleRevisit, revisit])).results.every(result => result.success));
  assert.equal((await saved(card)).articleFailureIndex, 5);
  const stale = operation(card, { kind: 'REVIEW', grade: 'GOOD', expectedVersion: 0 }), independent = operation(card);
  const conflict = await syncStudy(userId, [stale, independent]);
  assert.equal(conflict.results[0].code, 'STALE_CARD');
  assert.equal(conflict.results[1].success, true, 'Article difficulty survives an independent schedule conflict');
  assert.equal((await saved(card)).articleFailureIndex, 6);
  await db.wordsDE.updateMany({ _id: { $in: wordIds } }, { $set: { gramaticalCategories: [GrammaticalCategory.VERB] } });
  assert.equal((await syncStudy(userId, [independent])).results[0].success, true, 'An acknowledged article command stays idempotent after catalog edits');
  await db.wordsDE.updateMany({ _id: { $in: wordIds } }, { $set: { gramaticalCategories: [GrammaticalCategory.NOUN] } });
  invalidateStudyCatalog();
  const packet = await loadCompactStudyCards({ _id: userId } as User, { itemIds: [String(card.itemId)] });
  assert.equal(packet.items[0].articleFailureIndex, 6, 'Fresh study transport includes the separate article counter');
  assert.ok(packet.items[0].articleFailureAttemptIds.includes(independent.id), 'Applied article IDs prevent double projection while acknowledgements are delayed');
  assert.equal(packet.items[0].articleFailureAttemptIds.length, 6);
  const noMistakes = await make();
  invalidateStudyCatalog();
  const defaults = await loadCompactStudyCards({ _id: userId } as User, { itemIds: [String(noMistakes.itemId)] });
  assert.equal(defaults.items[0].articleFailureIndex, 0, 'Existing progress needs no data migration');
  assert.deepEqual(defaults.items[0].articleFailureAttemptIds, []);
  const gql = await progressResolvers.Query.userProgress(null, { userId: String(userId), itemId: String(card.itemId) }, { user: { _id: userId } as User });
  assert.equal(gql.articleFailureIndex, 6);
  assert.ok(gql.articleFailureAttemptIds.includes(independent.id));
  assert.equal(validateStudyOperations([operation(card)]).length, 1);
  assert.throws(() => validateStudyOperations([operation(card, { itemType: 'PHRASE' })]));
  console.log('PASS noun/article eligibility, owner isolation, concurrent atomic deduplication, independent counters, Hard/Revisit/Undo, retries/conflicts, and fresh REST/GraphQL reads');
} finally {
  await db.progress.deleteMany({ userId });
  await db.reviewEvents.deleteMany({ userId });
  await db.relationsWordsEsDe.deleteMany({ _id: { $in: relationIds } });
  await db.wordsES.deleteMany({ _id: { $in: wordIds } });
  await db.wordsDE.deleteMany({ _id: { $in: wordIds } });
  await closeDatabase();
}
