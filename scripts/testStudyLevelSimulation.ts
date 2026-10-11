import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { BSON, MongoClient, ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { connectDatabase, closeDatabase, getDatabaseClient } from '../src/lib/database.js';
import { loadDueStudyProgress } from '../src/features/progress/progress.resolvers.js';
import { studyCurriculum } from '../src/features/progress/studyCurriculum.js';
import { studyReviewOptions, effectiveDueDate } from '../src/features/progress/studyScheduling.js';
import { syncStudy } from '../src/features/progress/studySync.js';
import { newItemIdentityPipeline } from '../src/features/progress/studySummaries.js';
import { COMPACT_STUDY_SELECTION } from '../src/features/progress/studyTransport.js';
import { DEFAULT_OPTIONS } from '../src/features/progress/scheduler.js';
import { invalidateStudyCatalog } from '../src/features/progress/catalogSummaryCache.js';
import { CEFR_LEVELS } from '../src/features/levels/levels.js';

assert.match(process.env.MONGODB_URI ?? '', /^mongodb:\/\/127\.0\.0\.1:27019\//, 'Use the isolated loopback replica set');
const source = BSON.deserialize(await readFile('.local/study-level-audit/source.bson')) as any;
const name = `study_level_simulation_${process.pid}`, originalDb = MongoClient.prototype.db;
MongoClient.prototype.db = function () { return originalDb.call(this, name); };
const originalConnect = MongoClient.prototype.connect;
MongoClient.prototype.connect = function () { this.monitorCommands = true; return originalConnect.call(this); };
const db = await connectDatabase(), client = getDatabaseClient(), raw = originalDb.call(client, name);
const start = new Date('2026-10-11T10:00:00Z'), days = 183, dayMs = 86400000;
const userId = source.user._id, options = { ...DEFAULT_OPTIONS, newPerDay: 1000, reviewsPerDay: 100000 };
const rows: any[] = [], daily: any[] = [], benchmarks: any[] = [];
const known = new Set(source.collections.userprogresses.map((p: any) => `${p.itemType}:${p.relationId ?? p.itemId}`));
const introducedThisRun = new Set<string>();
const introductions = { WORD: [] as string[], PHRASE: [] as string[] };
let commands: any[] = [], collecting = false;
client.monitorCommands = true;
client.on('commandStarted', e => { if (collecting) commands.push({ name: e.commandName, collection: e.command.find ?? e.command.aggregate ?? e.command.update ?? e.command.insert, bytes: BSON.calculateObjectSize(e.command), command: e.command }); });
try {
  for (const [collection, values] of Object.entries(source.collections) as [string, any[]][]) if (values.length) await raw.collection(collection).insertMany(values);
  const user = { ...source.user, settings: { ...source.user.settings, dailyNewCards: 1000 } };
  await db.users.insertOne(user);
  // Only the isolated clone receives large allowances. Preserve every source
  // progress identity, due date, review count and suspension/deferral.
  await db.schedulerProfiles.updateOne({ _id: userId }, { $set: { timeZone: 'Europe/Berlin', rollover: 4, defaultOptions: options } }, { upsert: true });
  await db.progress.updateMany({ userId, scheduler: { $ne: null } }, { $set: { 'scheduler.options.newPerDay': 1000, 'scheduler.options.reviewsPerDay': 100000 } });
  mock.timers.enable({ apis: ['Date'], now: +start });
  invalidateStudyCatalog(db);
  const curriculum = await studyCurriculum({});
  const byKey = new Map(curriculum.entries.map(e => [`${e.type}:${e.relation._id}`, e]));
  const words = new Map(source.collections.WORDS_DE.map((v: any) => [String(v._id), v]));
  const phrases = new Map(source.collections.PHRASES_DE.map((v: any) => [String(v._id), v]));
  const eligible = Object.fromEntries(['WORD', 'PHRASE'].map(type => [type, Object.fromEntries(CEFR_LEVELS.map(level => [level, curriculum.entries.filter(e => e.type === type && e.level === level).length]))]));
  console.log(JSON.stringify({ stage: 'simulation-start', days, catalog: eligible, originalProgress: source.collections.userprogresses.length }));
  const out = 'docs/study-level-audit'; await mkdir(out, { recursive: true });
  await writeFile(`${out}/registry.jsonl`, '');
  for (let day = 0; day < days; day++) {
    const dayRowStart = rows.length;
    const now = new Date(+start + day * dayMs); mock.timers.setTime(+now);
    const dayStats: any = { day: day + 1, date: now.toISOString(), WORD: { newRelations: 0, ratings: 0 }, PHRASE: { newRelations: 0, ratings: 0 } };
    for (const type of ['WORD', 'PHRASE'] as const) {
      const shouldCollect = day < 2 || day === 32 || day === days - 1; collecting = false;
      if (shouldCollect) await studyCurriculum({});
      commands = []; collecting = shouldCollect;
      const begin = performance.now(), cpu = process.cpuUsage();
      const queue = await loadDueStudyProgress({ userId: String(userId), itemType: type, dueLimit: 5000, newLimit: type === 'WORD' ? 400 : 100 }, { user }, COMPACT_STUDY_SELECTION);
      if (collecting) benchmarks.push({ day: day + 1, type, ms: +(performance.now() - begin).toFixed(2), cpuMs: (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000, commands: commands.length, bytes: commands.reduce((a, c) => a + c.bytes, 0), byCommand: Object.fromEntries([...new Set(commands.map(c => c.name))].map(name => [name, commands.filter(c => c.name === name).length])), catalogReads: commands.filter(c => ['WORDS_DE', 'WORDS_ES', 'WORDS_ES_DE', 'PHRASES_DE', 'PHRASES_ES', 'PHRASES_ES_DE'].includes(c.collection)).map(c => ({ collection: c.collection, ids: c.command.filter?._id?.$in?.length ?? null })) });
      if (collecting) assert.ok(commands.filter(c => ['WORDS_DE', 'WORDS_ES', 'WORDS_ES_DE', 'PHRASES_DE', 'PHRASES_ES', 'PHRASES_ES_DE'].includes(c.collection)).every(c => Array.isArray(c.command.filter?._id?.$in)), 'Warm catalog reads must be bounded selected-ID hydration');
      collecting = false;
      if (day < 2) {
        await studyCurriculum({}); commands = []; collecting = true;
        const reloadStart = performance.now();
        const reload = await loadDueStudyProgress({ userId: String(userId), itemType: type, dueLimit: 5000, newLimit: type === 'WORD' ? 400 : 100 }, { user }, COMPACT_STUDY_SELECTION);
        benchmarks.push({ day: day + 1, type, scenario: 'warm-pending-reload', ms: +(performance.now() - reloadStart).toFixed(2), commands: commands.length, bytes: commands.reduce((a, c) => a + c.bytes, 0), catalogReads: commands.filter(c => ['WORDS_DE', 'WORDS_ES', 'WORDS_ES_DE', 'PHRASES_DE', 'PHRASES_ES', 'PHRASES_ES_DE'].includes(c.collection)).length });
        collecting = false;
        assert.deepEqual(reload.map(p => String(p.itemId)), queue.map(p => String(p.itemId)), 'Warm reload must retain curriculum and pair order');
        assert.equal(benchmarks.at(-1).catalogReads, 0, 'Warm pending reload performs zero catalog queries');
      }
      const operations: any[] = [], audited: any[] = [];
      for (const p of queue) {
        const key = `${p.itemType}:${p.relationId ?? p.itemId}`, entry = byKey.get(key);
        const level = entry?.level ?? 'UNCLASSIFIED', phase = p.scheduler.phase;
        const newToSnapshot = !known.has(key);
        const isIntroduction = phase === 'NEW' && !introducedThisRun.has(key);
        if (isIntroduction) { introducedThisRun.add(key); known.add(key); if (entry?.level) introductions[type].push(level); dayStats[type].newRelations++; }
        const priorDue = effectiveDueDate(p), early = phase !== 'NEW' && priorDue > now;
        assert.ok(!early || p.scheduler.queue === 'MINUTE' && +priorDue - +now <= p.scheduler.options.learnAheadSeconds * 1000, `Early ${type} review ${p.itemId}`);
        const preview = studyReviewOptions(p, now);
        const standard = preview.filter(o => ['AGAIN', 'HARD', 'GOOD', 'EASY'].includes(o.grade));
        assert.ok(standard.every((o, i) => i === 0 || o.delaySeconds > standard[i - 1].delaySeconds), `Non-ascending choices ${type} ${p.itemId}`);
        const grade = phase === 'NEW' || phase !== 'REVIEW' ? 'EASY' : type === 'PHRASE' ? 'HARD' : (p.totalReviews ?? 0) % 3 === 0 ? 'GOOD' : 'EASY';
        const choice = preview.find(o => o.grade === grade)!; assert.ok(choice);
        const text: any = entry && (type === 'WORD' ? words : phrases).get(String(entry.relation.translated));
        const operation = { id: randomUUID(), kind: 'REVIEW', itemId: String(p.itemId), itemType: type, grade, expectedVersion: p.scheduleVersion ?? 0, occurredAt: now.toISOString(), sessionId: `level_simulation_day_${day + 1}` };
        operations.push(operation);
        audited.push({ day: day + 1, date: now.toISOString().slice(0, 10), type, relationId: String(p.relationId ?? p.itemId), cardId: String(p.itemId), german: text?.word ?? text?.phrase ?? p.card?.prompt ?? '', level, phase, direction: p.card?.direction ?? 'PHRASE', introduction: isIntroduction, newToSnapshot: isIntroduction && newToSnapshot, totalReviewsBefore: p.totalReviews ?? 0, grade, priorDue: priorDue.toISOString(), earlyLearning: early, options: preview.map(o => ({ grade: o.grade, delaySeconds: o.delaySeconds, due: o.nextDueDate })), previewDue: choice.nextDueDate, reviewId: operation.id });
      }
      for (let i = 0; i < operations.length; i += 100) {
        const result = await syncStudy(userId, operations.slice(i, i + 100));
        assert.ok(result.results.every(r => r.success), JSON.stringify(result.results.filter(r => !r.success)));
      }
      if (operations.length) {
        const saved = await db.reviewEvents.find({ userId, reviewId: { $in: operations.map(o => o.id) } }).toArray();
        const receipts = new Map(saved.map(e => [e.reviewId, e]));
        for (const row of audited) {
          const receipt = receipts.get(row.reviewId)!; assert.ok(receipt);
          row.persistedDue = receipt.after.nextDueDate.toISOString(); row.intervalDays = receipt.after.interval;
          row.intervalRespected = row.persistedDue === row.previewDue;
          assert.ok(row.intervalRespected, `${type} persisted date differs from preview`);
          delete row.reviewId; rows.push(row);
        }
      }
      dayStats[type].ratings = operations.length;
    }
    daily.push(dayStats);
    await appendFile(`${out}/registry.jsonl`, rows.slice(dayRowStart).map(row => JSON.stringify(row)).join('\n') + (rows.length > dayRowStart ? '\n' : ''));
    if (day < 3 || (day + 1) % 15 === 0 || day === days - 1) console.log(JSON.stringify({ stage: 'daily-progress', ...dayStats, totalRatings: rows.length }));
  }
  for (const type of ['WORD', 'PHRASE'] as const) {
    const ranks = introductions[type].map(level => CEFR_LEVELS.indexOf(level as never));
    assert.ok(ranks.every((rank, i) => rank >= 0 && (!i || rank >= ranks[i - 1])), `${type} level introduction regressed`);
    assert.deepEqual([...new Set(introductions[type])], CEFR_LEVELS, `${type} must traverse ALL twelve catalog levels`);
    assert.equal(curriculum.entries.filter(e => e.type === type && !known.has(`${type}:${e.relation._id}`)).length, 0, `${type} catalog not exhausted`);
  }
  const explains = await Promise.all([
    db.progress.aggregate(newItemIdentityPipeline({ userId })).explain('executionStats'),
    db.progress.find({ userId, isNew: true, suspended: { $ne: true } }).explain('executionStats'),
    db.relationsWordsEsDe.find({ _id: { $in: curriculum.entries.filter(e => e.type === 'WORD').slice(0, 200).map(e => e.relation._id) } }).explain('executionStats'),
  ]);
  const queryPlans = explains.map(e => { const cursor = e.executionStats ? e : e.stages?.find(stage => stage.$cursor)?.$cursor; assert.ok(cursor); return { returned: cursor.executionStats.nReturned, documentsExamined: cursor.executionStats.totalDocsExamined, keysExamined: cursor.executionStats.totalKeysExamined, plan: cursor.queryPlanner.winningPlan, groupStages: e.stages?.filter(stage => stage.$group).map(stage => ({ returned: stage.nReturned, usedDisk: stage.usedDisk, spills: stage.spills })) ?? [] }; });
  assert.ok(queryPlans.every(p => !JSON.stringify(p.plan).includes('COLLSCAN') && !JSON.stringify(p.plan).includes('"stage":"SORT"')));
  const summary = { sourceAuditedAt: source.auditedAt, isolated: true, start: start.toISOString(), days, wordRelationsPerDay: 200, phraseRelationsPerDay: 100, ratings: rows.length, existingUnclassifiedIntroductions: rows.filter(row => row.introduction && row.level === 'UNCLASSIFIED').length, originalProgress: source.collections.userprogresses.length, newRelations: Object.fromEntries(Object.entries(introductions).map(([type, levels]) => [type, levels.length])), levelTransitions: Object.fromEntries(Object.entries(introductions).map(([type, levels]) => [type, [...new Set(levels)]])), eligible, daily, benchmarks, queryPlans, violations: { levelOrder: 0, earlyReview: 0, intervalMismatch: 0, nonAscendingOptions: 0 } };
  await writeFile(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  await writeFile(`${out}/registry.jsonl`, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const columns = ['day', 'date', 'type', 'german', 'level', 'introduction', 'newToSnapshot', 'phase', 'direction', 'totalReviewsBefore', 'grade', 'priorDue', 'previewDue', 'persistedDue', 'intervalDays', 'earlyLearning', 'intervalRespected', 'relationId', 'cardId'];
  const csv = (v: unknown) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  await writeFile(`${out}/registry.csv`, columns.join(',') + '\n' + rows.map(row => columns.map(c => csv(row[c])).join(',')).join('\n') + '\n');
  console.log(JSON.stringify({ stage: 'PASS', days, ratings: rows.length, newRelations: summary.newRelations, levels: summary.levelTransitions, violations: summary.violations }));
} finally {
  mock.timers.reset(); await raw.dropDatabase(); await closeDatabase(); MongoClient.prototype.db = originalDb; MongoClient.prototype.connect = originalConnect;
}
