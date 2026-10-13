import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { BSON, MongoClient, ObjectId } from 'mongodb';
import { studyAccountSummaryTarget } from './fixtures/studyAccountSummaryTarget.js';

const name = `study_account_summary_tests_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
for (const unsafe of ['mongodb+srv://example.invalid', 'mongodb://example.invalid', 'mongodb://127.0.0.1.example.invalid', 'mongodb://localhost', 'mongodb://user:password@127.0.0.1', 'mongodb://127.0.0.1/gramatikapp', 'mongodb://127.0.0.1/admin', 'mongodb://127.0.0.1/?directConnection=false', 'mongodb://127.0.0.1/?replicaSet=production', 'mongodb://127.0.0.1/?authSource=admin', 'mongodb://127.0.0.1/#fragment', ' mongodb://127.0.0.1']) {
  assert.throws(() => studyAccountSummaryTarget(unsafe, name));
}
assert.throws(() => studyAccountSummaryTarget('mongodb://127.0.0.1', 'gramatikapp'));
process.env.MONGODB_URI = studyAccountSummaryTarget(process.env.TEST_ACCOUNT_SUMMARY_URI ?? 'mongodb://127.0.0.1:27017', name);
console.log('PASS unsafe-target rejection before Mongo connection; unique fixture database and directConnection');
type Traffic = { requestBytes: number; replyBytes: number; batches: number; getMoreCommands: number; ms: number };
let active: Traffic | undefined;
const commands: { command: any; requestBytes: number; replyBytes: number; ms: number }[] = [];
const pending = new Map<number, typeof commands[number]>();
const originalDb = MongoClient.prototype.db, originalConnect = MongoClient.prototype.connect;
MongoClient.prototype.db = function (databaseName?: string, options?: any) {
  assert.ok(databaseName === undefined || databaseName === 'gramatikapp' || databaseName === name, 'Keep application reads inside the owned fixture');
  return originalDb.call(this, name, options);
};
MongoClient.prototype.connect = async function () {
  this.monitorCommands = true;
  this.on('commandStarted', event => {
    if (!active || !['find', 'aggregate', 'getMore'].includes(event.commandName)) return;
    assert.equal(event.databaseName, name);
    const row = { command: event.command, requestBytes: BSON.calculateObjectSize(event.command), replyBytes: 0, ms: 0 };
    commands.push(row); pending.set(event.requestId, row); active.requestBytes += row.requestBytes;
    if (event.commandName === 'getMore') active.getMoreCommands++;
  });
  this.on('commandSucceeded', event => {
    const row = pending.get(event.requestId);
    if (!row || !active) return;
    row.replyBytes = BSON.calculateObjectSize(event.reply); row.ms = event.duration;
    active.replyBytes += row.replyBytes; active.batches++; active.ms += event.duration; pending.delete(event.requestId);
  });
  return originalConnect.call(this);
};
const { connectDatabase, closeDatabase, getDatabaseClient } = await import('../src/lib/database.js');
const { DEFAULT_OPTIONS, initialScheduler } = await import('../src/features/progress/scheduler.js');
const { warmStudyCatalog, studyIdentities, summarizedStudyCounts } = await import('../src/features/progress/studyLoading.js');
const { accountCounterPipeline, accountCounterTotals, studyAccountCounterBuckets } = await import('../src/features/progress/studyAccountSummary.js');
const { identitySummaryPipeline, newItemIdentityPipeline, unpackStudyIdentities, unpackNewItemIdentities } = await import('../src/features/progress/studySummaries.js');
const { loadStudyQueueCounts } = await import('../src/features/progress/progress.resolvers.js');
const { progressResolvers } = await import('../src/features/progress/progress.resolvers.js');
const baseline = await import('./fixtures/accountSummaryBaseline.js');
const completionModule = new URL('../src/features/progress/studyCompletion.ts', import.meta.url);
const hasCompletion = existsSync(completionModule);
if (hasCompletion) {
  const completion = await import(completionModule.href);
  const scheduling = await import('../src/features/progress/studyScheduling.js');
  baseline.setAccountSummaryBaselineCompletion({ completeDueStudyCards: completion.completeDueStudyCards, isStudyCompleted: scheduling.isStudyCompleted });
}
const db = await connectDatabase();
assert.equal(db.progress.dbName, name);
assert.match((await originalDb.call(getDatabaseClient(), 'admin').command({ buildInfo: 1 })).version, /^8\./, 'Use MongoDB 8 for account-summary fixtures');
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const owner = id(1), now = new Date(), yesterday = new Date(+now - 86400000);
const user = { _id: owner, email: 'fixture@example.invalid', settings: { dailyNewCards: 0 } };
const logical = (rows: any[]) => rows.map(row => BSON.EJSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort();
const counterQuery = (userId: ObjectId, itemType?: string) => ({ userId, ...(itemType ? { itemType } : {}), $or: [
  { nextDueDate: { $lte: now } }, { temporaryDueDate: { $lte: now } }, { 'scheduler.phase': { $in: ['NEW', 'LEARNING', 'RELEARNING'] } }, { scheduler: null },
] });
async function measured<T>(work: () => Promise<T>) {
  assert.equal(active, undefined);
  const traffic: Traffic = { requestBytes: 0, replyBytes: 0, batches: 0, getMoreCommands: 0, ms: 0 }; const first = commands.length;
  active = traffic;
  const start = performance.now();
  try { return { result: await work(), traffic, commands: commands.slice(first), elapsedMs: performance.now() - start }; }
  finally { active = undefined; }
}
try {
  const count = 4000;
  await db.users.insertOne(user as never);
  const options = { ...DEFAULT_OPTIONS, reviewsPerDay: 5000 };
  await db.schedulerProfiles.insertOne({ _id: owner, defaultOptions: options, timeZone: 'Europe/Berlin', rollover: 4 } as never);
  await db.wordsES.insertOne({ _id: id(2), word: 'casa', contexts: ['university'], level: 'A1', cefrLevel: 'A1.1' } as never);
  await db.wordsDE.insertOne({ _id: id(3), word: 'Haus', forms: { gender: 'das' }, cefrLevel: 'A1.1' } as never);
  const relations = Array.from({ length: 6242 }, (_, i) => ({ _id: id(10000 + i), main: id(2), translated: id(3), createdAt: now }));
  await db.relationsWordsEsDe.insertMany(relations as never);
  const progress = Array.from({ length: count }, (_, i) => {
    const row = { _id: id(20000 + i), userId: owner, itemId: id(10000 + i), itemType: 'WORD' as const, isNew: false, interval: 7, ease: 2.5, repetitions: 2, totalReviews: 2, nextDueDate: yesterday, lastReviewed: yesterday, createdAt: yesterday };
    return { ...row, scheduler: initialScheduler(row, options) };
  });
  await db.progress.insertMany(progress);
  await warmStudyCatalog();
  const beforeDashboard = await measured(async () => {
    const context = { user } as never;
    const [counts, path] = await Promise.all([baseline.baselineLoadStudyQueueCounts({ userId: String(owner), itemType: 'WORD' }, context), baseline.baselineLearningPath(null, { userId: String(owner) }, context)]);
    return { counts, path };
  });
  const dashboard = await measured(async () => {
    const context = { user } as never;
    const [counts, path] = await Promise.all([loadStudyQueueCounts({ userId: String(owner), itemType: 'WORD' }, context), progressResolvers.Query.learningPath(null, { userId: String(owner) }, context)]);
    return { counts, path };
  });
  assert.deepEqual(dashboard.result, beforeDashboard.result, 'Complete dashboard counters/curriculum preserve frozen baseline');
  assert.deepEqual(dashboard.result.counts, { new: 0, learning: 0, review: count, total: 6242, learned: count });
  assert.equal(dashboard.result.path[0].wordsLearned, count);
  const identities = await measured(() => studyIdentities({}, owner));
  const oldIdentities = await db.progress.aggregate<{ known: any[]; legacy: any[] }>(baseline.identitySummaryPipeline({ userId: owner })).toArray();
  assert.deepEqual(logical(identities.result), logical([...oldIdentities[0].known, ...oldIdentities[0].legacy]));
  const known = dashboard.commands.find(row => row.command.aggregate === 'userprogresses' && row.command.pipeline[0].$match.$and?.[0]?.$nor);
  assert.ok(known, 'Dashboard must read fresh known-state counters');
  const knownSummary = await measured(() => studyAccountCounterBuckets({}, owner, now, 'WORD'));
  console.log(JSON.stringify({ operation: 'dashboard-4000', before: beforeDashboard.traffic, after: dashboard.traffic, beforeElapsedMs: Math.round(beforeDashboard.elapsedMs), afterElapsedMs: Math.round(dashboard.elapsedMs), knownRequestBytes: known.requestBytes, knownReplyBytes: knownSummary.traffic.replyBytes, identityReplyBytes: identities.traffic.replyBytes, knownSummary: knownSummary.traffic }));
  assert.ok(known.requestBytes < 3000, `Known summary must keep catalog IDs out of outgoing predicates (${known.requestBytes} bytes)`);
  assert.ok(knownSummary.traffic.replyBytes <= 80000, `Packed known-summary reply including getMore must fit 80KB (${knownSummary.traffic.replyBytes} bytes)`);
  assert.ok(identities.traffic.replyBytes <= 80000, `Packed identity reply must fit 80KB (${identities.traffic.replyBytes} bytes)`);
  assert.equal(dashboard.commands.filter(row => row.command.pipeline?.[1]?.$facet).length, 1, 'Dashboard/path share a fresh request-only mastery read');
  const oldAllocation = await measured(() => db.progress.aggregate(baseline.newItemIdentityPipeline({ userId: owner })).batchSize(5000).toArray());
  const allocation = await measured(async () => unpackNewItemIdentities(await db.progress.aggregate<any>(newItemIdentityPipeline({ userId: owner })).batchSize(5000).toArray()));
  assert.deepEqual(logical(allocation.result), logical(oldAllocation.result));
  assert.ok(allocation.traffic.replyBytes <= 80000, 'Packed allocation identities fit 80KB');
  console.log(JSON.stringify({ operation: 'allocation-4000', before: oldAllocation.traffic, after: allocation.traffic }));
  console.log('PASS exact large dashboard/identity outputs and compact request/reply budgets');

  // The original database predicates are the oracle, including BSON types and
  // the different catalog/category behavior of missing versus explicit null.
  const edgeOwner = id(4), phraseId = id(17000), collision = relations[0]._id;
  const catalog = { words: relations, phrases: [{ _id: phraseId }, ...relations.slice(0, 400)] };
  const rich = { source: 'ANKI', sourceCardId: 'fixture', sourceNoteGuid: 'fixture', direction: 'ES_DE', prompt: 'casa', answer: 'Haus', acceptedAnswers: ['Haus'], notes: '', examples: [], deck: 'App', tags: [] };
  let sequence = 0;
  const row = (type: string, relationId: any, extras: any = {}) => {
    const n = sequence++;
    const base: any = { _id: id(50000 + n), userId: edgeOwner, itemId: id(70000 + n), itemType: type, relationId, isNew: false, interval: 7, ease: 2.5, repetitions: 2, totalReviews: 2, nextDueDate: yesterday, lastReviewed: yesterday, createdAt: yesterday, ...extras };
    base.scheduler ??= initialScheduler(base, options);
    if (relationId === undefined) delete base.relationId;
    return base;
  };
  const arrayOwner = id(8), orphan = id(99999);
  const arrayCases = [
    { name: 'null-array/catalog itemId', relationId: [null], itemId: collision, review: 1 },
    { name: 'null-and-orphan/catalog itemId', relationId: [null, orphan], itemId: collision, review: 1 },
    { name: 'null-and-valid/orphan itemId', relationId: [null, collision], itemId: orphan, review: 1 },
    { name: 'null-and-valid/other itemId', relationId: [null, collision], itemId: phraseId, review: 1 },
    { name: 'null-and-orphan/direct itemId array', relationId: [null, orphan], itemId: [collision, id(99998)], review: 1 },
    { name: 'null-and-orphan/nested itemId array', relationId: [null, orphan], itemId: [[collision]], review: 0 },
    { name: 'direct valid relation', relationId: [collision], itemId: orphan, review: 1 },
    { name: 'nested valid relation', relationId: [[collision]], itemId: orphan, review: 0 },
    { name: 'orphan-and-nested relation', relationId: [orphan, [collision]], itemId: collision, review: 0 },
    { name: 'nested-null relation/catalog itemId', relationId: [[null], orphan], itemId: collision, review: 0 },
    { name: 'missing relation/direct itemId array', relationId: undefined, itemId: [collision], review: 1 },
    { name: 'missing relation/nested itemId array', relationId: undefined, itemId: [[collision]], review: 0 },
    { name: 'null relation/direct itemId array', relationId: null, itemId: [collision], review: 1 },
    { name: 'null relation/nested itemId array', relationId: null, itemId: [[collision]], review: 0 },
    { name: 'string relation/catalog itemId', relationId: [String(collision)], itemId: collision, review: 0 },
    { name: 'nested relation/rich category', relationId: [[collision]], itemId: orphan, card: rich, review: 1 },
  ];
  for (const test of arrayCases) {
    const sample = row('WORD', test.relationId, { userId: arrayOwner, itemId: test.itemId, ...('card' in test ? { card: test.card } : {}) });
    await db.progress.insertOne(sample);
    const query = counterQuery(arrayOwner);
    const buckets = await db.progress.aggregate<any>(accountCounterPipeline(query, now)).toArray();
    for (const category of [null, [], [collision], [orphan], [collision, orphan], [phraseId]]) {
      const old = await db.progress.aggregate<any>(baseline.counterSummaryPipeline(query, baseline.counterEligibility(now, category, catalog), now)).toArray();
      const expected = old[0] ? { review: old[0].review, learning: old[0].learning } : { review: 0, learning: 0 };
      if (category === null) assert.equal(expected.review, test.review, `Original isolated case ${test.name}`);
      assert.deepEqual(accountCounterTotals(buckets, catalog, category), expected, `Array Mongo predicate ${test.name}, category ${category?.map(String) ?? 'ALL'}`);
    }
    await db.progress.deleteOne({ _id: sample._id });
  }
  console.log('PASS isolated relation null-array fallback, direct-only relation/itemId arrays and category variants against original Mongo predicates');
  const edgeRows: any[] = [];
  for (const type of ['WORD', 'PHRASE']) for (const relationId of [undefined, null, collision, String(collision), id(99999)]) for (const card of [undefined, null, {}, false, '', [], [null], [false], rich]) {
    const extras: any = { itemId: relationId == null ? relations[sequence + 2]._id : id(70000 + sequence), ...(card === undefined ? {} : { card }) };
    edgeRows.push(row(type, relationId, extras));
  }
  edgeRows.push(
    row('WORD', collision, { card: rich, itemId: String(collision) }),
    row('WORD', undefined, { itemId: String(relations[502]._id) }),
    row('WORD', undefined, { itemId: collision }),
    row('WORD', collision, { suspended: true }), row('WORD', collision, { suspended: 'true' }),
    row('WORD', collision, { supersededByAnki: true }), row('WORD', collision, { buriedUntil: new Date(+now + 1) }),
    row('WORD', collision, { buriedUntil: now }), row('WORD', collision, { completedAt: yesterday }),
    row('WORD', collision, { temporaryDueDate: new Date(+now + 1) }),
    row('WORD', collision, { nextDueDate: new Date(+now + 1), temporaryDueDate: now }),
    row('WORD', collision, { nextDueDate: now }),
    row('PHRASE', phraseId, { scheduler: { ...progress[0].scheduler, phase: 'LEARNING' }, interval: 0 }),
    row('PHRASE', phraseId, { scheduler: { ...progress[0].scheduler, phase: 'RELEARNING' }, interval: 0 }),
    row('PHRASE', phraseId, { scheduler: { ...progress[0].scheduler, phase: 'LEARNING' }, interval: 0, nextDueDate: new Date(+now + 1) }),
    row('WORD', collision, { isNew: true, scheduler: { ...progress[0].scheduler, phase: 'NEW' }, interval: 0 }),
    row('WORD', collision, { interval: 0 }),
    row('WORD', collision, { userId: id(99), card: rich }),
  );
  const legacy = row('WORD', collision, { anki: { type: 2, reps: 3, queue: 2 }, interval: 8 }); delete legacy.scheduler; edgeRows.push(legacy);
  const unknown = row('PHRASE', phraseId, { scheduler: { ...progress[0].scheduler, phase: 'OLD' } }); edgeRows.push(unknown);
  await db.progress.insertMany(edgeRows);
  for (const type of [undefined, 'WORD', 'PHRASE']) {
    const query = counterQuery(edgeOwner, type);
    const buckets = await db.progress.aggregate<any>(accountCounterPipeline(query, now)).toArray();
    for (const category of [null, [], [collision], [phraseId], [collision, phraseId], [id(99999)]]) {
      const old = await db.progress.aggregate<any>(baseline.counterSummaryPipeline(query, baseline.counterEligibility(now, category, catalog), now)).toArray();
      assert.deepEqual(accountCounterTotals(buckets, catalog, category), old[0] ? { review: old[0].review, learning: old[0].learning } : { review: 0, learning: 0 }, `Exact Mongo predicates ${type ?? 'ALL'} category ${category?.map(String)}`);
    }
    const queryIdentity = { userId: edgeOwner, ...(type ? { itemType: type } : {}) };
    const old = await db.progress.aggregate<any>(baseline.identitySummaryPipeline(queryIdentity)).toArray();
    const current = unpackStudyIdentities(await db.progress.aggregate<any>(identitySummaryPipeline(queryIdentity)).toArray());
    assert.deepEqual(logical(current), logical([...old[0].known, ...old[0].legacy]), 'Packed mastery retains typed collisions and legacy fields');
    assert.deepEqual(logical(unpackNewItemIdentities(await db.progress.aggregate<any>(newItemIdentityPipeline(queryIdentity)).toArray())), logical(await db.progress.aggregate(baseline.newItemIdentityPipeline(queryIdentity)).toArray()), 'Packed allocation preserves exact BSON identity grouping');
  }
  // An already-selected catalog generation must win over newer relation writes.
  const buckets = await db.progress.aggregate<any>(accountCounterPipeline(counterQuery(edgeOwner), now)).toArray();
  const reducedCatalog = { words: [], phrases: [] };
  const oldReduced = await db.progress.aggregate<any>(baseline.counterSummaryPipeline(counterQuery(edgeOwner), baseline.counterEligibility(now, null, reducedCatalog), now)).toArray();
  assert.deepEqual(accountCounterTotals(buckets, reducedCatalog, null), { review: oldReduced[0].review, learning: oldReduced[0].learning });
  const shared = {}, first = studyAccountCounterBuckets(shared, edgeOwner, now);
  assert.equal(studyAccountCounterBuckets(shared, edgeOwner, now), first);
  const original = await first;
  await db.progress.insertOne(row('WORD', collision));
  assert.equal(await studyAccountCounterBuckets(shared, edgeOwner, now), original, 'Same request reuses its existing owner observation');
  assert.notDeepEqual(accountCounterTotals(await studyAccountCounterBuckets({}, edgeOwner, now), catalog, null), accountCounterTotals(original, catalog, null), 'New request re-reads fresh progress');
  const scopedIdentity = await studyIdentities({}, edgeOwner, [phraseId, collision]);
  assert.deepEqual(logical(scopedIdentity), logical(await baseline.baselineStudyIdentities({}, edgeOwner, [phraseId, collision])), 'Phrase identity scope keeps cross-type fallback predicates');
  const snapshot = await summarizedStudyCounts({}, edgeOwner, now, undefined, catalog, null);
  const compatibleBaseline = await baseline.baselineCountSnapshot({}, edgeOwner, now, undefined, baseline.counterEligibility(now, null, catalog));
  assert.deepEqual(logical(snapshot.progress), logical(compatibleBaseline.progress), 'Compatibility projection preserves the deployed baseline exactly');
  console.log('PASS old Mongo counters/allocation/mastery for typed IDs, null/missing/category/orphan/card flags, exact dates, legacy/NEW/zero intervals, fresh requests and phrase scopes');

  // Full resolver outputs use valid persisted shapes, while malformed typed
  // inputs above use the database predicate oracle rather than JS truthiness.
  const integrationOwner = id(5), integrationUser = { ...user, _id: integrationOwner, email: 'integration@example.invalid', settings: { dailyNewCards: 4 } };
  await db.users.insertOne(integrationUser as never);
  await db.schedulerProfiles.insertOne({ _id: integrationOwner, defaultOptions: options, timeZone: 'Europe/Berlin', rollover: 4 } as never);
  await db.phrasesES.insertOne({ _id: id(6), phrase: 'Hoy aprendo.', contexts: ['university'], level: 'A1', cefrLevel: 'A1.1' } as never);
  await db.phrasesDE.insertOne({ _id: id(7), phrase: 'Heute lerne ich.', contexts: ['university'], level: 'A1', cefrLevel: 'A1.1', words: [] } as never);
  await db.relationsPhrasesEsDe.insertMany([{ _id: phraseId, main: id(6), translated: id(7), createdAt: now }, { _id: collision, main: id(6), translated: id(7), createdAt: now }] as never);
  const { invalidateStudyCatalog } = await import('../src/features/progress/catalogSummaryCache.js'); invalidateStudyCatalog(db);
  const integrationRows = [
    row('WORD', collision, { userId: integrationOwner, card: rich }),
    row('WORD', collision, { userId: integrationOwner, interval: 0, scheduler: { ...progress[0].scheduler, phase: 'LEARNING' } }),
    row('PHRASE', phraseId, { userId: integrationOwner, interval: 0, scheduler: { ...progress[0].scheduler, phase: 'RELEARNING' } }),
    row('WORD', collision, { userId: integrationOwner, interval: 0 }),
    row('WORD', collision, { userId: integrationOwner, temporaryDueDate: new Date(+now + 90000) }),
    row('WORD', collision, { userId: integrationOwner, suspended: true }),
    row('PHRASE', phraseId, { userId: integrationOwner, buriedUntil: new Date(+now + 90000) }),
    row('WORD', collision, { userId: integrationOwner, ...(hasCompletion ? { completedAt: yesterday } : {}) }),
    row('PHRASE', collision, { userId: integrationOwner, card: rich }),
    row('WORD', relations[1]._id, { userId: integrationOwner, interval: 2000, scheduler: { ...progress[0].scheduler, interval: 2000 } }),
  ];
  const compatibility = row('PHRASE', phraseId, { userId: integrationOwner, interval: 7, anki: { type: 2, reps: 3, queue: 2, left: 0 } }); delete compatibility.scheduler; integrationRows.push(compatibility);
  integrationRows.push(row('PHRASE', relations[4]._id, { userId: integrationOwner, card: rich }));
  await db.progress.insertMany(integrationRows);
  for (const scope of [{}, { itemType: 'WORD' }, { itemType: 'PHRASE' }, { context: 'University' }, { itemType: 'PHRASE', context: 'University' }, { context: 'no_such_category' }]) {
    const args = { userId: String(integrationOwner), ...scope };
    const after = await loadStudyQueueCounts(args, { user: integrationUser } as never);
    const before = await baseline.baselineLoadStudyQueueCounts(args, { user: integrationUser } as never);
    assert.deepEqual(after, before, `Full baseline counts/curriculum ${JSON.stringify(scope)}`);
  }
  const learningPath = await progressResolvers.Query.learningPath(null, { userId: String(integrationOwner) }, { user: integrationUser } as never);
  assert.deepEqual(learningPath, await baseline.baselineLearningPath(null, { userId: String(integrationOwner) }, { user: integrationUser } as never), 'Full learning path preserves its type-agnostic learned-ID union');
  assert.equal(learningPath[0].wordsLearned, 3, 'A PHRASE mastery identity still marks its colliding WORD catalog relation learned');
  if (hasCompletion) assert.ok((await db.progress.findOne({ _id: integrationRows[9]._id }))?.completedAt, 'Read-time completion keeps complete scheduling inputs');
  console.log('PASS complete frozen-baseline mixed/type/category/empty dashboard counters/curriculum and read-time completion');
} finally {
  await originalDb.call(getDatabaseClient(), name).dropDatabase();
  await closeDatabase();
  MongoClient.prototype.db = originalDb; MongoClient.prototype.connect = originalConnect;
}
