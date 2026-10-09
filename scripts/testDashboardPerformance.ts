import assert from 'node:assert/strict';
import { BSON, MongoClient, ObjectId } from 'mongodb';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { typeDefs, resolvers } from '../src/graphql/schema.js';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';
import { warmStudyCatalog } from '../src/features/progress/studyLoading.js';
import { loadStudyQueueCounts } from '../src/features/progress/progress.resolvers.js';
import { isCountStudyCandidate } from '../src/features/progress/studyCandidates.js';
import { studyTransportRouter } from '../src/features/progress/studyTransport.http.js';
import express from 'express';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

// Use only an owned disposable database, even when .env contains production credentials.
const uri = process.env.TEST_DASHBOARD_URI ?? 'mongodb://127.0.0.1:27017';
assert.match(uri, /^mongodb:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/);
process.env.MONGODB_URI = uri;
const name = `dashboard_performance_tests_${process.pid}`;
const originalDb = MongoClient.prototype.db;
MongoClient.prototype.db = function () { return originalDb.call(this, name); };
let bytes = 0;
const originalConnect = MongoClient.prototype.connect;
MongoClient.prototype.connect = async function () {
  this.monitorCommands = true;
  this.on('commandSucceeded', event => {
    if (['find', 'aggregate', 'getMore'].includes(event.commandName)) bytes += BSON.calculateObjectSize(event.reply);
  });
  return originalConnect.call(this);
};
const db = await connectDatabase();
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const owner = id(1), now = new Date(), yesterday = new Date(now.getTime() - 86400000);
const user = { _id: owner, email: 'fixture@example.invalid', settings: { dailyNewCards: 20 } };
try {
  await db.users.insertOne(user as never);
  const options = { ...DEFAULT_OPTIONS, reviewsPerDay: 5000 };
  await db.schedulerProfiles.insertOne({ _id: owner, defaultOptions: options, timeZone: 'Europe/Berlin', rollover: 4 } as never);
  const count = 4000;
  await db.wordsES.insertOne({ _id: id(2), word: 'casa', contexts: ['university'], level: 'A1' } as never);
  await db.wordsDE.insertOne({ _id: id(3), word: 'Haus', forms: { gender: 'das' } } as never);
  await db.relationsWordsEsDe.insertMany(Array.from({ length: count }, (_, i) => ({ _id: id(10000 + i), main: id(2), translated: id(3), createdAt: now })) as never);
  const progress = Array.from({ length: count }, (_, i) => {
    const row = { _id: id(20000 + i), userId: owner, itemId: id(10000 + i), itemType: 'WORD' as const, isNew: false, interval: 7, ease: 2.5, repetitions: 2, totalReviews: 2, nextDueDate: yesterday, lastReviewed: yesterday, createdAt: yesterday };
    return { ...row, scheduler: initialScheduler(row, options) };
  });
  await db.progress.insertMany(progress);
  await warmStudyCatalog();
  bytes = 0;
  const started = performance.now();
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const result = await graphql({ schema, source: 'query($userId:ID!){studyQueueCounts(userId:$userId,itemType:"WORD"){new learning review total learned}learningPath(userId:$userId){id wordsTotal wordsLearned}}', variableValues: { userId: String(owner) }, contextValue: { user } });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), { studyQueueCounts: { new: 0, learning: 0, review: count, total: count, learned: count }, learningPath: [{ id: 'university', wordsTotal: count, wordsLearned: count }] });
  console.log(JSON.stringify({ operation: 'dashboard-4000-cards', ms: Math.round(performance.now() - started), databaseBytes: bytes }));
  assert.ok(bytes < 350000, `dashboard totals must not transfer per-card scheduling histories (${bytes} bytes)`);
  // Compare the optimized read with the old per-card scheduling path, including
  // legacy Anki, quota, custom learning-ahead, burial and temporary dates.
  const variants = Array.from({ length: 36 }, (_, i) => {
    const base = { ...progress[i], _id: id(30000 + i), itemId: id(40000 + i), relationId: progress[i].itemId,
      card: { source: 'ANKI' as const, sourceCardId: String(i + 1), sourceNoteGuid: `fixture-${i}`, direction: 'ES_DE' as const, prompt: 'casa', answer: 'Haus', acceptedAnswers: ['Haus'], notes: '', examples: [], deck: 'App', tags: [] } };
    const phases = ['NEW', 'LEARNING', 'RELEARNING', 'REVIEW'] as const;
    const phase = phases[i % 4];
    const row = { ...base, isNew: phase === 'NEW', nextDueDate: new Date(now.getTime() + (i % 3 - 1) * 90000),
      scheduler: { ...base.scheduler, phase, queue: phase === 'NEW' ? 'NEW' as const : i % 2 ? 'MINUTE' as const : 'DAY' as const,
        options: { ...DEFAULT_OPTIONS, learnAheadSeconds: i % 2 ? 100 : 0 } },
      ...(i % 7 === 0 ? { buriedUntil: new Date(now.getTime() + 86400000) } : {}),
      ...(i % 11 === 0 ? { suspended: true } : {}),
      ...(i % 5 === 0 ? { temporaryDueDate: yesterday } : {}),
    };
    if (i >= 28) { delete (row as Partial<typeof row>).scheduler; Object.assign(row, { anki: { type: i % 4, reps: 2, queue: i % 2, left: 1001 }, updatedAt: yesterday }); }
    return row;
  });
  await db.progress.insertMany(variants);
  const all = [...progress, ...variants];
  for (const scope of [{}, { itemType: 'WORD' }, { context: 'University' }, { itemType: 'PHRASE' }, { context: 'no_such_context' }]) {
    const args = { userId: String(owner), ...scope };
    const before = await loadStudyQueueCounts(args, { user } as never, { now, progress: Promise.resolve(all.filter(row => (!scope.itemType || row.itemType === scope.itemType) && isCountStudyCandidate(row, now))) });
    const after = await loadStudyQueueCounts(args, { user } as never);
    assert.deepEqual(after, before, `fresh summary preserves ${JSON.stringify(scope)}`);
  }
  console.log('PASS summary/full-read counters agree for mixed/scoped/custom/legacy/temporary/buried schedules');

  const app = express(); app.use(express.json()); app.use(studyTransportRouter({ authenticate: async () => user as never }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const packet = (encoding: string, cardLimit?: number) => new Promise<{ headers: http.IncomingHttpHeaders; data: Buffer }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/study/queue', method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': encoding } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ headers: response.headers, data: Buffer.concat(chunks) }));
    }); request.on('error', reject); request.end(JSON.stringify({ dueLimit: 5000, newLimit: 0, includeCounts: true, cardLimit }));
  });
  try {
    const plain = await packet('identity'), compressed = await packet('gzip'), starter = await packet('gzip', 24);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.match(String(compressed.headers.vary), /Accept-Encoding/);
    assert.equal(compressed.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(gunzipSync(compressed.data).toString()), JSON.parse(plain.data.toString()), 'compression preserves every schedule/card/flag/counter');
    const decoded = JSON.parse(gunzipSync(starter.data).toString());
    assert.equal(decoded.items.length, 24); assert.equal(decoded.manifest.length, JSON.parse(plain.data.toString()).items.length);
    assert.ok(compressed.data.length < plain.data.length / 4);
    console.log(JSON.stringify({ operation: 'mixed-wire', fullBytes: plain.data.length, gzipBytes: compressed.data.length, starterGzipBytes: starter.data.length }));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
} finally {
  await originalDb.call((await import('../src/lib/database.js')).getDatabaseClient(), name).dropDatabase();
  await closeDatabase();
  MongoClient.prototype.db = originalDb;
  MongoClient.prototype.connect = originalConnect;
}
