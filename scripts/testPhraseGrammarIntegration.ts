import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase, getDatabaseClient } from '../src/lib/database.js';
import { defaultUserSettings } from '../src/features/auth/auth.types.js';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';
import { studyTransportRouter } from '../src/features/progress/studyTransport.http.js';
import { warmStudyCatalog } from '../src/features/progress/studyLoading.js';
import { invalidateStudyCatalog } from '../src/features/progress/catalogSummaryCache.js';

if (!process.env.MONGODB_URI?.startsWith('mongodb://127.0.0.1:27037/')) throw new Error('Use only the disposable loopback Mongo fixture on port 27037.');
const originalDb = MongoClient.prototype.db, name = `phrase_grammar_tests_${process.pid}`;
MongoClient.prototype.db = function () { return originalDb.call(this, name); };
const db = await connectDatabase(), now = new Date();
const user = { _id: new ObjectId(), email: 'grammar-fixture@example.invalid', settings: { ...defaultUserSettings, dailyNewCards: 20 }, createdAt: now };
const article = new ObjectId(), noun = new ObjectId(), esIds = [new ObjectId(), new ObjectId()], deIds = [new ObjectId(), new ObjectId()], relations = [new ObjectId(), new ObjectId()];
const word = (id: ObjectId, text: string, categories: string[]) => ({ _id: id, word: text, gramaticalCategories: categories, examples: [], contexts: ['general_vocabulary'], createdAt: now });
const phrase = (id: ObjectId, text: string, words: ObjectId[] = []) => ({ _id: id, phrase: text, words, synonyms: [], contexts: ['general_vocabulary'], createdAt: now });
const app = express(); app.use(express.json()); app.use(studyTransportRouter({ authenticate: async () => user as never }));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
const post = async (path: string, body: object) => {
  const response = await fetch(origin + '/api/study/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
try {
  await db.users.insertOne(user as never);
  await db.wordsDE.insertMany([word(article, 'die', ['ARTICLE', 'PRONOUN']), word(noun, 'Haus', ['NOUN'])] as never);
  await db.phrasesES.insertMany([phrase(esIds[0], 'Las casas cuestan diez euros.'), phrase(esIds[1], 'Yo aprendo.')]);
  await db.phrasesDE.insertMany([phrase(deIds[0], 'Die Die Haus zehn kostet, Haus.', [article, noun]), phrase(deIds[1], 'Ich lerne.', [])]);
  await db.relationsPhrasesEsDe.insertMany(relations.map((id, index) => ({ _id: id, main: esIds[index], translated: deIds[index], createdAt: now })));
  await db.translationsEsDe.insertMany(['kostet', 'fragt'].map(key => ({ _id: new ObjectId(), key, word: key, sourceLanguage: 'de', targetLanguage: 'es', category: 'VERB', status: 'READY', origin: 'MANUAL', createdAt: now, updatedAt: now })) as never);
  const progress = relations.map(itemId => {
    const p = { _id: new ObjectId(), userId: user._id, itemId, relationId: itemId, itemType: 'PHRASE', isNew: false, ease: 2.5, interval: 30, repetitions: 3, totalReviews: 3, lapses: 0, nextDueDate: new Date(now.getTime() - 86400000), lastReviewed: new Date(now.getTime() - 31 * 86400000), createdAt: now, scheduleVersion: 2 };
    return { ...p, scheduler: initialScheduler(p as never, DEFAULT_OPTIONS) };
  });
  await db.progress.insertMany(progress as never);
  await db.cardEdits.insertOne({ _id: new ObjectId(), userId: user._id, itemType: 'PHRASE', relationId: relations[1], version: 1, flag: null, content: { german: 'Die Anna fragt nicht.', spanish: 'Anna no pregunta.', notes: '', examples: [] }, updatedAt: now });
  const before = await db.progress.find({}).toArray();
  let wordSnapshotReads = 0, surfaceSnapshotReads = 0, wordFinds = 0, surfaceFinds = 0;
  const originalWords = db.wordsDE.aggregate.bind(db.wordsDE), originalSurfaces = db.translationsEsDe.aggregate.bind(db.translationsEsDe);
  const originalWordFind = db.wordsDE.find.bind(db.wordsDE), originalSurfaceFind = db.translationsEsDe.find.bind(db.translationsEsDe);
  // Catalog snapshots now hash their projected rows in Mongo. Count the real
  // aggregate loads, and keep find counters to catch per-word lookup regressions.
  db.wordsDE.aggregate = ((...args: any[]) => {
    assert.equal(args[0].at(-1)?.$project?.row, 1, 'word catalog read loads a row snapshot');
    wordSnapshotReads++; return originalWords(...args as [any]);
  }) as typeof db.wordsDE.aggregate;
  db.translationsEsDe.aggregate = ((...args: any[]) => {
    assert.equal(args[0].at(-1)?.$project?.row, 1, 'grammar surface read loads a row snapshot');
    surfaceSnapshotReads++; return originalSurfaces(...args as [any]);
  }) as typeof db.translationsEsDe.aggregate;
  db.wordsDE.find = ((...args: any[]) => { wordFinds++; return originalWordFind(...args as [any]); }) as typeof db.wordsDE.find;
  db.translationsEsDe.find = ((...args: any[]) => { surfaceFinds++; return originalSurfaceFind(...args as [any]); }) as typeof db.translationsEsDe.find;
  await warmStudyCatalog();
  assert.equal(wordSnapshotReads, 1); assert.equal(surfaceSnapshotReads, 1, 'warmup coalesces the category projection');
  assert.equal(wordFinds, 0); assert.equal(surfaceFinds, 0, 'warmup uses shared aggregate snapshots');
  const packet = await post('cards', { itemIds: relations.map(String) });
  assert.equal(packet.status, 200);
  assert.deepEqual(packet.body.items[0].wordCategories, { Die: ['ARTICLE', 'PRONOUN'], Haus: ['NOUN'], zehn: ['NUMERAL'], kostet: ['VERB'] });
  assert.deepEqual(packet.body.items[1].wordCategories, { Die: ['ARTICLE', 'PRONOUN'], Anna: ['NOUN'], fragt: ['VERB'], nicht: ['PARTICLE', 'ADVERB'] }, 'metadata describes the edited phrase, not stale original text');
  assert.equal(packet.body.items[1].german, 'Die Anna fragt nicht.');
  const starter = await post('queue', { itemType: 'PHRASE', dueLimit: 10, newLimit: 0, cardLimit: 1 });
  assert.equal(starter.status, 200); assert.equal(starter.body.items.length, 1);
  assert.equal(Object.keys(starter.body.manifest[1].wordCategories).length, 1, 'pending distractors only carry one-token category metadata');
  assert.equal(wordSnapshotReads, 1); assert.equal(surfaceSnapshotReads, 1, 'warmed queue/card reads reuse shared snapshots');
  assert.equal(wordFinds, 0); assert.equal(surfaceFinds, 0, 'warmed queue/card reads add no per-word catalog queries');
  await db.wordsDE.updateOne({ _id: article }, { $set: { gramaticalCategories: ['ARTICLE'] } } as never);
  invalidateStudyCatalog(db);
  const refreshed = await post('cards', { itemIds: [String(relations[0])] });
  assert.deepEqual(refreshed.body.items[0].wordCategories.Die, ['ARTICLE']);
  assert.equal(wordSnapshotReads, 2); assert.equal(surfaceSnapshotReads, 2, 'one invalidated generation reloads each required source once');
  assert.equal(wordFinds, 0); assert.equal(surfaceFinds, 0, 'invalidation adds no per-word catalog queries');
  assert.deepEqual(await db.progress.find({}).toArray(), before, 'category reads do not alter schedules or mistakes');
  console.log('PASS HTTP→Mongo phrase categories, manual gaps, multiple roles, edited text, pending distractors, warmed reads/invalidation and unchanged progress');
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await getDatabaseClient().db().dropDatabase(); await closeDatabase(); MongoClient.prototype.db = originalDb;
}
