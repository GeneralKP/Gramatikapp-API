import 'dotenv/config';
import assert from 'node:assert/strict';
import { BSON, MongoClient, ObjectId } from 'mongodb';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { connectDatabase, closeDatabase, getDatabaseClient } from '../src/lib/database.js';
import { loadDueStudyProgress } from '../src/features/progress/progress.resolvers.js';
import { studyCurriculum } from '../src/features/progress/studyCurriculum.js';
import { nativeWordPair } from '../src/features/progress/nativeWordPairs.js';
import { COMPACT_STUDY_SELECTION } from '../src/features/progress/studyTransport.js';
import { newItemIdentityPipeline } from '../src/features/progress/studySummaries.js';
import { initialScheduler, DEFAULT_OPTIONS } from '../src/features/progress/scheduler.js';

assert.match(process.env.MONGODB_URI ?? '', /^mongodb:\/\/127\.0\.0\.1:27019\//);
const source = BSON.deserialize(await readFile('.local/study-level-audit/source.bson')) as any;
const name = `study_level_benchmark_${process.pid}`, original = MongoClient.prototype.db;
MongoClient.prototype.db = function () { return original.call(this, name); };
const originalConnect = MongoClient.prototype.connect;
MongoClient.prototype.connect = function () { this.monitorCommands = true; return originalConnect.call(this); };
const db = await connectDatabase(), client = getDatabaseClient(), raw = original.call(client, name), now = new Date();
let active = false, records: any[] = [], commands = new Map<number, any>();
client.monitorCommands = true;
client.on('commandStarted', e => { if (!active) return; const row = { name: e.commandName, collection: e.command.find ?? e.command.aggregate, commandBytes: BSON.calculateObjectSize(e.command), responseBytes: 0, rows: 0, filter: e.command.filter, pipeline: e.command.pipeline }; records.push(row); commands.set(e.requestId, row); });
client.on('commandSucceeded', e => { const row = commands.get(e.requestId); if (!row) return; row.responseBytes = BSON.calculateObjectSize(e.reply); row.rows = (e.reply.cursor?.firstBatch ?? e.reply.cursor?.nextBatch ?? []).length; commands.delete(e.requestId); });
try {
  for (const [collection, values] of Object.entries(source.collections) as [string, any[]][]) if (collection === 'schedulerprofiles' || ['userprogresses', 'reviewevents', 'cardedits'].includes(collection)) continue; else if (values.length) await raw.collection(collection).insertMany(values);
  const user = { ...source.user, settings: { ...source.user.settings, dailyNewCards: 1000 } }, userId = user._id;
  await db.users.insertOne(user);
  const options = { ...DEFAULT_OPTIONS, newPerDay: 1000, reviewsPerDay: 100000 };
  await db.schedulerProfiles.insertOne({ _id: userId, timeZone: 'Europe/Berlin', rollover: 4, defaultOptions: options } as never);
  const curriculum = await studyCurriculum({});
  const es = new Map(source.collections.WORDS_ES.map((w: any) => [String(w._id), w])), de = new Map(source.collections.WORDS_DE.map((w: any) => [String(w._id), w]));
  const cards = curriculum.entries.flatMap(entry => {
    const p: any = { _id: new ObjectId(), userId, itemId: entry.relation._id, itemType: entry.type, isNew: true, ease: 2.5, interval: 0, repetitions: 0, totalReviews: 0, nextDueDate: now, lastReviewed: null, createdAt: now };
    p.scheduler = initialScheduler(p, options);
    return entry.type === 'WORD' ? nativeWordPair(p, es.get(String(entry.relation.main)) as any, de.get(String(entry.relation.translated)) as any) : [p];
  });
  const report: any[] = [];
  for (const type of ['WORD', 'PHRASE', undefined] as const) for (const requestedPending of [100, 500, 1000]) {
    await db.progress.deleteMany({ userId });
    const relevant = cards.filter(p => !type || p.itemType === type), pending = new Set(relevant.slice(0, requestedPending).map(p => String(p.itemId)));
    const rows = cards.map(p => pending.has(String(p.itemId)) ? p : { ...p, isNew: false, interval: 365, repetitions: 10, totalReviews: 10, lastReviewed: now,
      nextDueDate: new Date(+now + 365 * 86400000), scheduler: { ...p.scheduler, phase: 'REVIEW', queue: 'DAY', interval: 365 } });
    await db.progress.insertMany(rows);
    await loadDueStudyProgress({ userId: String(userId), itemType: type, dueLimit: 50, newLimit: 20 }, { user }, COMPACT_STUDY_SELECTION);
    const samples: any[] = [];
    for (let i = 0; i < 7; i++) {
      await studyCurriculum({}); records = []; active = true;
      const begin = performance.now(), cpu = process.cpuUsage();
      const queue = await loadDueStudyProgress({ userId: String(userId), itemType: type, dueLimit: 50, newLimit: 20 }, { user }, COMPACT_STUDY_SELECTION);
      const usage = process.cpuUsage(cpu); active = false;
      assert.equal(queue.length, 20); assert.ok(records.length > 0, 'Command monitoring must be enabled before connecting');
      const catalog = records.filter(r => ['WORDS_DE', 'WORDS_ES', 'WORDS_ES_DE', 'PHRASES_DE', 'PHRASES_ES', 'PHRASES_ES_DE'].includes(r.collection));
      assert.equal(catalog.length, 0, 'Warm paired retrieval must issue zero catalog reads');
      assert.ok(records.every(r => !r.pipeline || !JSON.stringify(r.pipeline).includes('$lookup')));
      samples.push({ ms: +(performance.now() - begin).toFixed(2), cpuMs: (usage.user + usage.system) / 1000, commands: records.length, rowsRead: records.reduce((a, r) => a + r.rows, 0), responseBytes: records.reduce((a, r) => a + r.responseBytes, 0), commandBytes: records.reduce((a, r) => a + r.commandBytes, 0), catalogReads: catalog.length });
    }
    const sorted = samples.map(s => s.ms).sort((a, b) => a - b);
    report.push({ type: type ?? 'MIXED', ownerCards: cards.length, pendingCards: pending.size, p50Ms: sorted[3], p95Ms: sorted[6], samples });
    console.log(JSON.stringify({ type: type ?? 'MIXED', ownerCards: cards.length, pendingCards: pending.size, p50Ms: sorted[3], p95Ms: sorted[6], commands: samples[3].commands, rowsRead: samples[3].rowsRead, responseBytes: samples[3].responseBytes, catalogReads: samples[3].catalogReads }));
  }
  const explains = await Promise.all([
    db.progress.aggregate(newItemIdentityPipeline({ userId })).explain('executionStats'),
    db.progress.find({ userId, itemType: 'WORD', isNew: true, suspended: { $ne: true }, supersededByAnki: { $ne: true }, $or: [{ buriedUntil: null }, { buriedUntil: { $lte: now } }] }).explain('executionStats'),
    db.relationsWordsEsDe.find({ _id: { $in: curriculum.entries.filter(e => e.type === 'WORD').slice(0, 20).map(e => e.relation._id) } }).explain('executionStats'),
  ]);
  const queryPlans = explains.map(e => { const cursor = e.executionStats ? e : e.stages?.find(stage => stage.$cursor)?.$cursor; assert.ok(cursor); return { returned: cursor.executionStats.nReturned, documentsExamined: cursor.executionStats.totalDocsExamined, keysExamined: cursor.executionStats.totalKeysExamined, executionTimeMs: cursor.executionStats.executionTimeMillis, plan: cursor.queryPlanner.winningPlan, groupStages: e.stages?.filter(stage => stage.$group).map(stage => ({ returned: stage.nReturned, usedDisk: stage.usedDisk, spills: stage.spills })) ?? [] }; });
  assert.ok(queryPlans.every(p => !JSON.stringify(p.plan).includes('COLLSCAN') && !JSON.stringify(p.plan).includes('"stage":"SORT"') && p.groupStages.every(g => !g.usedDisk && !g.spills)));
  await mkdir('docs/study-level-audit', { recursive: true });
  await writeFile('docs/study-level-audit/performance.json', JSON.stringify({ environment: 'isolated loopback Mongo replica set; actual catalog; same owner ID; synthetic late-course progress; seven samples after one warmup, p95 is sample maximum, concurrent simulation may contend', queryPlans, report }, null, 2));
} finally { await raw.dropDatabase(); await closeDatabase(); MongoClient.prototype.db = original; MongoClient.prototype.connect = originalConnect; }
