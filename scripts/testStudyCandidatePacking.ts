import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mock } from 'node:test';
import { BSON, Collection, MongoClient, MongoServerError, ObjectId } from 'mongodb';
import { studyCandidatePackingTarget } from './fixtures/studyCandidatePackingTarget.js';

const name = `study_candidate_packing_tests_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
for (const unsafe of ['mongodb+srv://example.invalid', 'mongodb://example.invalid', 'mongodb://127.0.0.1.example.invalid', 'mongodb://localhost', 'mongodb://user:password@127.0.0.1', 'mongodb://127.0.0.1/gramatikapp', 'mongodb://127.0.0.1/admin', 'mongodb://127.0.0.1/?directConnection=false', 'mongodb://127.0.0.1/?replicaSet=production', 'mongodb://127.0.0.1/?authSource=admin', 'mongodb://127.0.0.1/#fragment', ' mongodb://127.0.0.1']) {
  assert.throws(() => studyCandidatePackingTarget(unsafe, name));
}
assert.throws(() => studyCandidatePackingTarget('mongodb://127.0.0.1', 'gramatikapp'));
process.env.MONGODB_URI = studyCandidatePackingTarget(process.env.TEST_STUDY_PACKING_URI ?? 'mongodb://127.0.0.1:27017', name);
console.log('PASS unsafe-target rejection before connection; unique loopback fixture and directConnection');
const now = new Date('2026-10-14T10:00:00.000Z');
mock.timers.enable({ apis: ['Date'], now: +now });
type Read = { commandName: string; command: any; replyBytes: number; reply?: any; failure?: any };
let active: Read[] | undefined;
const pending = new Map<number, Read>();
const originalDb = MongoClient.prototype.db, originalConnect = MongoClient.prototype.connect;
MongoClient.prototype.db = function (databaseName?: string, options?: any) {
  assert.ok(databaseName === undefined || databaseName === 'gramatikapp' || databaseName === name, 'Keep application access inside the owned fixture');
  return originalDb.call(this, name, options);
};
MongoClient.prototype.connect = async function () {
  this.monitorCommands = true;
  this.on('commandStarted', event => {
    if (!active || !['find', 'aggregate', 'getMore'].includes(event.commandName)) return;
    assert.equal(event.databaseName, name);
    const row = { commandName: event.commandName, command: event.command, replyBytes: 0 };
    active.push(row); pending.set(event.requestId, row);
  });
  this.on('commandSucceeded', event => {
    const row = pending.get(event.requestId); if (!row) return;
    row.reply = event.reply; row.replyBytes = BSON.calculateObjectSize(event.reply); pending.delete(event.requestId);
  });
  this.on('commandFailed', event => {
    const row = pending.get(event.requestId); if (!row) return;
    row.failure = event.failure; pending.delete(event.requestId);
  });
  return originalConnect.call(this);
};
const { connectDatabase, closeDatabase, getDatabaseClient } = await import('../src/lib/database.js');
const { DEFAULT_OPTIONS, initialScheduler, studyDay } = await import('../src/features/progress/scheduler.js');
const { combinedStudyCandidates, combinedStudyCandidateFilter } = await import('../src/features/progress/studyCandidates.js');
const { COMPACT_STUDY_SELECTION, COMPLETE_STUDY_SELECTION, loadCompactStudyQueue, loadCompactStudyCards, loadCompactStudyMore } = await import('../src/features/progress/studyTransport.js');
const { withScheduler } = await import('../src/features/progress/reviews.js');
const { selectStudyQueue } = await import('../src/features/progress/studyQueue.js');
const { studyReviewOptions } = await import('../src/features/progress/studyScheduling.js');
const { invalidateStudyCatalog } = await import('../src/features/progress/catalogSummaryCache.js');
const { categoryProgressFilter } = await import('../src/features/progress/categories.js');
// The original read provides a valid red baseline before the helper exists.
const moduleUrl = new URL('../src/features/progress/studyCandidatePacking.ts', import.meta.url);
const packing: any = existsSync(moduleUrl) ? await import(moduleUrl.href) : undefined;
const readPacked: (collection: Collection<any>, filter: any, projection: any, batchSize?: number) => Promise<any[]> = packing?.readPackedStudyCandidates ?? ((collection: any, filter: any, projection: any, batchSize = 5000) => collection.find(filter).project(projection).batchSize(batchSize).toArray());
const db = await connectDatabase(), client = getDatabaseClient();
assert.equal(db.progress.dbName, name);
assert.match((await originalDb.call(client, 'admin').command({ buildInfo: 1 })).version, /^8\./, 'Use actual MongoDB 8');
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const owner = id(1), other = id(2), yesterday = new Date(+now - 86400000);
const options = { ...DEFAULT_OPTIONS, reviewsPerDay: 5000, newPerDay: 1000 };
const profile: any = { _id: owner, timeZone: 'Europe/Berlin', rollover: 4, defaultOptions: { ...options, reviewsPerDay: 5000 },
  baselines: [{ day: studyDay(now, 'Europe/Berlin', 4), deck: 'Parent', new: 3, review: 8 }], createdAt: yesterday };
const user: any = { _id: owner, email: 'packing-fixture@example.invalid', authProvider: 'email', settings: { dailyNewCards: 1000 }, createdAt: yesterday };
const row = (n: number, extra: any = {}) => {
  const p: any = { _id: id(10000 + n), userId: owner, itemId: id(20000 + n), relationId: id(30000 + n), itemType: n % 3 ? 'WORD' : 'PHRASE',
    isNew: false, interval: 30, ease: 2.5, repetitions: 4, totalReviews: 6, lapses: 1, failureIndex: n % 9, failureVersion: n % 2, scheduleVersion: n % 3,
    nextDueDate: new Date(+now - (n % 3) * 1000), temporaryDueDate: null, lastReviewed: yesterday, createdAt: yesterday, updatedAt: yesterday,
    card: { source: 'ANKI', sourceCardId: String(100000 + n), sourceNoteGuid: `note-${Math.floor(n / 2)}`, direction: n % 2 ? 'ES_DE' : 'DE_ES',
      deck: n % 8 === 0 ? 'Parent::Child' : 'Other', prompt: 'das Haus', answer: 'la casa', acceptedAnswers: ['la casa'], notes: 'Imported note', examples: ['Das Haus ist groß.'], tags: [] },
    anki: { type: 2, queue: 2, left: 0, reps: 6, did: '1', odid: '0', due: 20000 }, ...extra };
  p.scheduler = initialScheduler(p, n % 5 === 0 ? { ...options, easyMultiplier: 1.61, learningSteps: [2, 19], reviewsPerDay: 73 } : options);
  Object.assign(p, extra); return p;
};
async function measured<T>(work: () => Promise<T>) {
  assert.equal(active, undefined); const reads: Read[] = []; active = reads;
  try { return { result: await work(), reads, replyBytes: reads.reduce((sum, row) => sum + row.replyBytes, 0) }; }
  finally { active = undefined; }
}
const originalRead = (filter: any, projection: any, batchSize = 5000) => db.progress.find(filter).project<any>(projection).batchSize(batchSize).toArray();
const canonical = (value: any) => BSON.EJSON.stringify(value, { relaxed: false });
function exactRows(actual: any[], expected: any[], label: string) {
  assert.deepEqual(actual, expected, `${label}: every projected field, Date/ObjectId, null/missing and input order`);
  assert.deepEqual(actual.map(p => canonical(p.scheduler?.options)), expected.map(p => canonical(p.scheduler?.options)), `${label}: exact raw option key/array order and BSON types`);
}
try {
  await db.users.insertOne(user); await db.schedulerProfiles.insertOne(profile);
  const mixed = Array.from({ length: 700 }, (_, i) => row(i));
  await db.progress.insertMany(mixed);
  await db.progress.insertMany(Array.from({ length: 3515 }, (_, i) => row(20000 + i, { nextDueDate: new Date(+now + 30 * 86400000) })));
  const filter = combinedStudyCandidateFilter(owner, undefined, now);
  const before = await measured(() => originalRead(filter, COMPACT_STUDY_SELECTION));
  const after = await measured(() => combinedStudyCandidates(owner, undefined, now, COMPACT_STUDY_SELECTION));
  exactRows(after.result, before.result, 'Hot combined read');
  assert.deepEqual(after.reads.map(r => r.commandName), ['aggregate'], 'Hot combined read must pack all options in one normal-path Mongo read');
  assert.ok(after.replyBytes <= 650000, `Mixed packed reply ${after.replyBytes} exceeds 650KB`);
  const rawOptionsBytes = before.result.reduce((sum, p) => sum + BSON.calculateObjectSize({ options: p.scheduler.options }), 0);
  const packedOptions = after.reads[0].reply.cursor.firstBatch[0].options;
  const uniqueOptionBytes = packedOptions.reduce((sum: number, group: any) => sum + BSON.calculateObjectSize({ options: group.options }), 0);
  assert.ok(uniqueOptionBytes <= rawOptionsBytes * 0.1, 'At least 90% fewer repeated option bytes');
  console.log(JSON.stringify({ operation: 'mixed-700', beforeReplyBytes: before.replyBytes, packedReplyBytes: after.replyBytes, rawOptionsBytes, uniqueOptionBytes, optionReductionPercent: +(100 * (1 - uniqueOptionBytes / rawOptionsBytes)).toFixed(2), reads: after.reads.map(r => r.commandName) }));
  const completeMixed = await measured(() => combinedStudyCandidates(owner, undefined, now, COMPLETE_STUDY_SELECTION));
  exactRows(completeMixed.result, await originalRead(filter, COMPLETE_STUDY_SELECTION), 'Complete hot combined read');
  assert.ok(completeMixed.replyBytes <= 650000, `Mixed COMPLETE packed reply ${completeMixed.replyBytes} exceeds 650KB`);
  assert.deepEqual(completeMixed.reads.map(r => r.commandName), ['aggregate']);
  console.log(JSON.stringify({ operation: 'complete-mixed-700-of-4215', packedReplyBytes: completeMixed.replyBytes, reads: completeMixed.reads.map(r => r.commandName) }));

  // Distinct Mongo primary keys can have the same JavaScript String value.
  // The first two keys differ by BSON type; document keys also distinguish
  // contents and field order. They must retain their own stored option group.
  const primaryOwner = id(90), primaryHex = '00000000000000000000aabb';
  const primaryRows = [
    row(760, { _id: new ObjectId(primaryHex), userId: primaryOwner, nextDueDate: now }),
    row(761, { _id: primaryHex, userId: primaryOwner, nextDueDate: now }),
    row(762, { _id: { kind: 'key', slot: 1 }, userId: primaryOwner, nextDueDate: now }),
    row(763, { _id: { kind: 'key', slot: 2 }, userId: primaryOwner, nextDueDate: now }),
    row(764, { _id: { slot: 1, kind: 'key' }, userId: primaryOwner, nextDueDate: now }),
  ];
  for (let i = 0; i < primaryRows.length; i++) primaryRows[i].scheduler.options = { ...options, maximumInterval: i === 1 || i === 4 ? 31000 : 30000, learningSteps: [2, 19] };
  await db.progress.insertMany(primaryRows);
  for (const projection of [COMPACT_STUDY_SELECTION, COMPLETE_STUDY_SELECTION]) {
    const query = { userId: primaryOwner }, expected = await originalRead(query, projection);
    const actual = await measured(() => readPacked(db.progress, query, projection));
    const objectIdRow = actual.result.find(p => p._id instanceof ObjectId && p._id.equals(new ObjectId(primaryHex)));
    assert.equal(objectIdRow.scheduler?.options?.maximumInterval, 30000, 'ObjectId primary ID must retain its options beside an equal-text string primary ID');
    exactRows(actual.result, expected, 'BSON/type/document primary-ID collision');
    assert.deepEqual(actual.reads.map(r => r.commandName), ['aggregate']);
    const firstDocument = actual.result.find(p => !(p._id instanceof ObjectId) && p._id.kind === 'key' && p._id.slot === 1);
    const secondDocument = actual.result.find(p => !(p._id instanceof ObjectId) && p._id.kind === 'key' && p._id.slot === 2);
    assert.notEqual(firstDocument.scheduler.options, secondDocument.scheduler.options, 'Document-key members own independent options');
    firstDocument.scheduler.options.learningSteps.push(999);
    assert.ok(!secondDocument.scheduler.options.learningSteps.includes(999), 'Document-key members own independent nested options');
  }
  console.log('PASS BSON/type/document primary-ID collision: ObjectId versus equal-text string, distinct/reordered documents, exact fields/order and independent options');

  const quirky = [row(701, { itemId: id(20700), itemType: 'WORD' }), row(702, { itemId: id(20700), itemType: 'PHRASE' }),
    row(703, { scheduler: null }), row(704, { scheduler: undefined }), row(705, { scheduler: { phase: 'REVIEW', queue: 'DAY', customState: { preserved: [1, null, 'x'] } } }),
    row(706), row(707), row(708), row(709), row(710), row(711), row(712)];
  quirky[5].scheduler.options = null;
  quirky[6].scheduler.options = { ...options, extra: BSON.Decimal128.fromString('1') };
  quirky[7].scheduler.options = { ...options, extra: 1 };
  quirky[8].scheduler.options = { ...options, nestedExtra: { v: BSON.Decimal128.fromString('1'), when: now, id: owner, arrays: [null, [1, 2]] } };
  quirky[9].scheduler.options = { ...options, extra: new BSON.Double(-0) };
  quirky[10].scheduler.options = { ...options, extra: 0 };
  quirky[11].scheduler = { ...quirky[11].scheduler, extraRaw: { text: 'keep', dates: [now], ids: [owner] } };
  delete quirky[3].scheduler;
  await db.progress.insertMany(quirky);
  for (const type of [undefined, 'WORD', 'PHRASE'] as const) for (const projection of [COMPACT_STUDY_SELECTION, COMPLETE_STUDY_SELECTION]) {
    const query = combinedStudyCandidateFilter(owner, type, now);
    const expected = await originalRead(query, projection);
    const actual = await readPacked(db.progress, query, projection);
    exactRows(actual, expected, `${type ?? 'mixed'} raw state`);
    const equivalent = actual.filter((p: any) => p.scheduler?.options && p.scheduler.options.extra === undefined && p.scheduler.options.nestedExtra === undefined);
    const sameOptions = equivalent.find((p: any) => p.scheduler.options.easyMultiplier === options.easyMultiplier);
    const secondOptions = equivalent.find((p: any) => p !== sameOptions && p.scheduler.options.easyMultiplier === options.easyMultiplier);
    assert.notEqual(sameOptions.scheduler.options, secondOptions.scheduler.options, 'Rows must not share mutable options objects');
    assert.notEqual(sameOptions.scheduler.options.learningSteps, secondOptions.scheduler.options.learningSteps, 'Nested option arrays must not alias');
    sameOptions.scheduler.options.learningSteps.push(999);
    assert.ok(!secondOptions.scheduler.options.learningSteps.includes(999));
    const sanitizedActual = actual.filter((p: any) => p !== sameOptions && p.scheduler?.options && p.scheduler.options.extra === undefined && p.scheduler.options.nestedExtra === undefined);
    const sanitizedExpected = expected.filter(p => String(p._id) !== String(sameOptions._id) && p.scheduler?.options && (p.scheduler.options as any).extra === undefined && (p.scheduler.options as any).nestedExtra === undefined);
    const normalizedA = await Promise.all(sanitizedActual.map((p: any) => withScheduler(p, profile)));
    const normalizedB = await Promise.all(sanitizedExpected.map(p => withScheduler(p, profile)));
    const counts = new Map([['Other', { review: 12, new: 3 }], ['Parent', { review: 4980, new: 2 }]]);
    exactRows(selectStudyQueue(normalizedA, counts as any, now, 5000, 1000), selectStudyQueue(normalizedB, counts as any, now, 5000, 1000), 'Queue/options/deck ancestors/allowances');
    assert.deepEqual(normalizedA.map((p: any) => studyReviewOptions(p, now)), normalizedB.map(p => studyReviewOptions(p, now)), 'Rating/completion predictions preserve the stored custom options');
  }
  console.log('PASS exact raw fields/order, typed ID collisions, missing/null scheduler/options, custom/Decimal128/nested/negative-zero options and independent mutable rows');
  const collated: Collection<any> = originalDb.call(client, name).collection('collated_options');
  await originalDb.call(client, name).createCollection('collated_options', { collation: { locale: 'en', strength: 1 } });
  const unusual = [
    row(750), row(751), row(752), row(753), row(754), row(755), row(756), row(757), row(758),
  ];
  unusual[0].scheduler.options = { ...options, marker: 'custom' };
  unusual[1].scheduler.options = { ...options, marker: 'CUSTOM' };
  unusual[2].scheduler.options = { ...options, marker: BSON.Long.fromString('9007199254740993') };
  unusual[3].scheduler.options = { ...options, marker: Infinity };
  unusual[4].scheduler.options = { ...options, marker: NaN };
  unusual[5].scheduler.options = { ...options, learningSteps: [BSON.Decimal128.fromString('1'), 2] };
  unusual[6].scheduler.options = { ...options, nestedExtra: { ordered: ['b', 'a'] } };
  unusual[7].scheduler.options = ['raw', null, { preserved: now }];
  unusual[8].scheduler.options = {};
  await collated.insertMany(unusual);
  const collatedBefore = await collated.find({ userId: owner }).project(COMPLETE_STUDY_SELECTION).batchSize(5000).toArray();
  const collatedAfter = await measured(() => readPacked(collated, { userId: owner }, COMPLETE_STUDY_SELECTION));
  exactRows(collatedAfter.result, collatedBefore, 'Non-simple collation and uncommon raw options');
  assert.deepEqual(collatedAfter.reads.map(r => r.commandName), ['aggregate']);
  console.log('PASS unchanged string case under non-simple collation, large Long, nonfinite numbers, Decimal128 arrays, nested extras, raw array and empty options');

  const selectionQueries = [
    { userId: owner, completedAt: null, suspended: { $ne: true }, supersededByAnki: { $ne: true }, $or: [{ temporaryDueDate: { $lte: now } }, { temporaryDueDate: null, nextDueDate: { $lte: new Date(+now + 1200000) } }, { isNew: true }] },
    { ...categoryProgressFilter(mixed.slice(0, 120).map(p => p.relationId)), userId: owner, itemType: 'WORD', completedAt: null, $or: [{ nextDueDate: { $lte: now } }, { isNew: true }] },
    { userId: owner, $or: [{ nextDueDate: { $lte: now } }, { temporaryDueDate: { $lte: now } }] },
    { userId: owner, itemType: 'WORD', 'card.sourceNoteGuid': { $in: mixed.slice(0, 100).map(p => p.card.sourceNoteGuid) }, supersededByAnki: { $ne: true } },
    { userId: owner, itemId: { $in: mixed.slice(0, 60).map(p => p.itemId) }, supersededByAnki: { $ne: true } },
    { userId: owner, isNew: true, completedAt: null }, { userId: other },
  ];
  for (const query of [filter, ...selectionQueries]) {
    const expected = await originalRead(query, COMPLETE_STUDY_SELECTION);
    exactRows(await readPacked(db.progress, query, COMPLETE_STUDY_SELECTION), expected, 'Selection query');
    const findPlan: any = await db.progress.find(query as any).project(COMPLETE_STUDY_SELECTION).explain('queryPlanner');
    const aggregatePlan: any = await db.progress.aggregate(packing.studyCandidatePackingPipeline(query, COMPLETE_STUDY_SELECTION)).explain('queryPlanner');
    const cursor = aggregatePlan.stages?.find((s: any) => s.$cursor)?.$cursor;
    assert.ok(cursor, 'Aggregate retains upstream original query cursor');
    const classic = (plan: any) => plan.queryPlan ?? plan;
    // Mongo explains find's dotted projection as numeric paths, and the
    // equivalent aggregate projection as nested booleans. Exact output above
    // verifies projection; compare access/order plans independently of that
    // representation and the incidental cache/planner node identifiers.
    const withoutIds = (plan: any): any => Array.isArray(plan) ? plan.map(withoutIds) : plan && typeof plan === 'object' ? Object.fromEntries(Object.entries(plan).filter(([key]) => !['planNodeId', 'isCached', 'transformBy'].includes(key)).map(([key, value]) => [key, withoutIds(value)])) : plan;
    assert.deepEqual(withoutIds(classic(cursor.queryPlanner.winningPlan)), withoutIds(classic(findPlan.queryPlanner.winningPlan)), 'Original match/projection retains the same winning plan');
    if (JSON.stringify(findPlan.queryPlanner.winningPlan).includes('"stage":"OR"')) console.log('PASS exact find/aggregate OR access-plan and tied-date input order');
  }
  console.log('PASS Mongo8 original find and upstream aggregate plan/content/input-order parity for combined, due/category/sibling/hydration/pending/empty queries');

  // Derive the reference transport from the original physical find boundary.
  // Queue/envelope logic is shared unchanged; only packed aggregate reads are
  // replaced with the old projected cursor, without emulating Mongo scheduling.
  const originalAggregate = Collection.prototype.aggregate;
  const referenceEnvelope = async (work: () => Promise<any>) => {
    Collection.prototype.aggregate = function (pipeline: any[], options?: any): any {
      if (!pipeline.some(s => s.$facet?.states && s.$facet?.options)) return originalAggregate.call(this, pipeline, options);
      const cursor: any = this.find(pipeline[0].$match).project(pipeline[1].$project).batchSize(5000);
      return { batchSize() { return this; }, async toArray() { return [{ states: await cursor.toArray(), options: [] }]; } };
    };
    try { return await work(); } finally { Collection.prototype.aggregate = originalAggregate; }
  };
  await db.progress.deleteMany({ userId: owner });
  const transportRows = Array.from({ length: 60 }, (_, i) => row(800 + i));
  // Tied regular and temporary due, future/learn-ahead, blocked and completed
  // rows, duplicate directional siblings and independent stored deck options.
  transportRows[0].temporaryDueDate = now; transportRows[0].nextDueDate = new Date(+now + 86400000);
  transportRows[1].suspended = true; transportRows[2].buriedUntil = new Date(+now + 86400000);
  transportRows[3].completedAt = yesterday; transportRows[4].supersededByAnki = true;
  transportRows[5].nextDueDate = new Date(+now + 30 * 86400000);
  transportRows[6].scheduler.phase = 'LEARNING'; transportRows[6].scheduler.queue = 'MINUTE'; transportRows[6].nextDueDate = new Date(+now + 60 * 1000);
  transportRows[7].interval = 1825; transportRows[7].scheduler.interval = 1825; transportRows[7].scheduler.options.maximumInterval = 1825;
  transportRows[8].interval = 36500; transportRows[8].scheduler.interval = 36500;
  for (const p of transportRows.slice(10, 16)) { p.isNew = true; p.interval = 0; p.repetitions = 0; p.totalReviews = 0; p.lapses = 0; p.lastReviewed = null; p.scheduler = initialScheduler(p, options); }
  transportRows[12].card.direction = 'DE_ES'; transportRows[12].card.sourceNoteGuid = transportRows[10].card.sourceNoteGuid;
  await db.reviewEvents.insertOne({ userId: owner, reviewId: randomUUID(), itemId: transportRows[20].itemId, itemType: 'WORD', day: studyDay(now, 'Europe/Berlin', 4), deck: 'Parent::Child', newCount: 3, reviewCount: 26, reversedAt: null, reviewedAt: now } as any);
  const restore = async () => { await db.progress.deleteMany({ userId: owner }); await db.progress.insertMany(transportRows); invalidateStudyCatalog(db); };
  for (const input of [{ includeCounts: true, newLimit: 0, cardLimit: 24 }, { includeCounts: true, newLimit: 0 }, { includeCounts: true, itemType: 'WORD', newLimit: 0, cardLimit: 3 }, { includeCounts: true, itemType: 'PHRASE', newLimit: 0 }, { newLimit: 0, cardLimit: 24 }, { newLimit: 0 }, { context: 'general_vocabulary', newLimit: 0, includeCounts: true }]) {
    await restore(); const expected = await referenceEnvelope(() => loadCompactStudyQueue(user, input));
    await restore(); const actual = await measured(() => loadCompactStudyQueue(user, input));
    assert.deepEqual(actual.result, expected, `Complete starter/full envelope, profiles, counters, order and manifest: ${JSON.stringify(input)}`);
    assert.ok(!actual.reads.some(r => r.commandName === 'find' && r.command.projection?.failureVersion && r.command.projection?.scheduler && !r.command.limit && !r.command.sort), 'Unsorted projected due/pending/sibling selection reads must pack scheduler options');
  }
  await restore(); const ids = transportRows.slice(0, 8).filter(p => !p.supersededByAnki).map(p => String(p.itemId)).reverse();
  const expectedCards = await referenceEnvelope(() => loadCompactStudyCards(user, { itemIds: ids }));
  const hydrated = await measured(() => loadCompactStudyCards(user, { itemIds: ids }));
  assert.deepEqual(hydrated.result, expectedCards, 'Requested ordered full hydration content/state/profiles');
  assert.ok(!hydrated.reads.some(r => r.commandName === 'find' && r.command.projection?.failureVersion && r.command.projection?.scheduler), 'Projected hydration states must pack scheduler options');
  await restore(); const expectedMore = await referenceEnvelope(() => loadCompactStudyMore(user, { limit: 12 }));
  await restore(); assert.deepEqual(await loadCompactStudyMore(user, { limit: 12 }), expectedMore, 'Extra practice preserves original sorted future cursor, predictions, profiles and queue');
  console.log('PASS original-find differential complete starter/full envelopes, counts/profiles, temporary due, future manifests, learning ahead, daily/deck allowances, burial/suspension, duplicate siblings, five-year completion boundaries, hydration and extra practice');

  await db.progress.deleteMany({});
  const large = Array.from({ length: 5101 }, (_, i) => row(1000 + i));
  await db.progress.insertMany(large);
  const many = await measured(() => readPacked(db.progress, filter, COMPACT_STUDY_SELECTION));
  assert.equal(many.result.length, 5101, 'No early candidate limit');
  exactRows(many.result, await originalRead(filter, COMPACT_STUDY_SELECTION), 'More than 5000 candidates');
  assert.deepEqual(many.reads.map(r => r.commandName), ['aggregate']);
  console.log('PASS all 5101 matched states before queue limits; normal packed path has one read and no getMore');

  await db.progress.deleteMany({});
  const oversized = Array.from({ length: 19 }, (_, i) => row(7000 + i));
  oversized.forEach(p => { p.card.notes = 'x'.repeat(1024 * 1024); });
  await db.progress.insertMany(oversized);
  const completeBefore = await originalRead(filter, COMPLETE_STUDY_SELECTION);
  const completeBytes = completeBefore.reduce((sum, p) => sum + BSON.calculateObjectSize(p), 0);
  assert.ok(completeBytes > 16 * 1024 * 1024);
  const fallback = await measured(() => readPacked(db.progress, filter, COMPLETE_STUDY_SELECTION));
  exactRows(fallback.result, completeBefore, 'Real >16MiB complete payload fallback');
  assert.equal(fallback.reads[0].commandName, 'aggregate');
  assert.equal(fallback.reads[0].failure?.code, 10334, 'Real Mongo BSON result overflow');
  assert.equal(fallback.reads[1].commandName, 'find');
  assert.deepEqual(fallback.reads[1].command.filter, filter);
  assert.deepEqual(fallback.reads[1].command.projection, COMPLETE_STUDY_SELECTION);
  assert.equal(fallback.reads[1].command.batchSize, 5000);
  console.log(JSON.stringify({ operation: 'complete-overflow', completeBytes, failureCode: fallback.reads[0].failure.code, commands: fallback.reads.map(r => r.commandName), exactRows: fallback.result.length }));

  // A deliberately large complete payload also proves facet memory handling
  // against the server rather than merely throwing a fake oversized exception.
  await db.progress.deleteMany({});
  const huge = Array.from({ length: 110 }, (_, i) => row(8000 + i));
  huge.forEach(p => { p.card.notes = 'y'.repeat(1024 * 1024); });
  await db.progress.insertMany(huge);
  const memoryBefore = await originalRead(filter, COMPLETE_STUDY_SELECTION);
  const memoryFallback = await measured(() => readPacked(db.progress, filter, COMPLETE_STUDY_SELECTION));
  exactRows(memoryFallback.result, memoryBefore, 'Real facet-memory fallback');
  assert.ok([146, 4031700].includes(memoryFallback.reads[0].failure?.code),
    `Real Mongo facet/accumulator memory overflow must use code 146 or 4031700; received ${memoryFallback.reads[0].failure?.code}`);
  assert.equal(memoryFallback.reads[1].commandName, 'find');
  console.log(JSON.stringify({ operation: 'facet-memory-overflow', failureCode: memoryFallback.reads[0].failure.code, commands: memoryFallback.reads.map(r => r.commandName), exactRows: memoryFallback.result.length }));

  // Limit exceptions are whitelisted; syntax/auth/network errors must surface.
  for (const code of [13, 18, 9, 168, 6, 50]) {
    const error = new MongoServerError({ message: 'fixture non-limit failure', code }); let findCalls = 0;
    const boundary: any = { aggregate() { return { batchSize() { return this; }, async toArray() { throw error; } }; }, find() { findCalls++; throw new Error('Unexpected fallback'); } };
    await assert.rejects(readPacked(boundary, filter, COMPLETE_STUDY_SELECTION), candidate => candidate === error);
    assert.equal(findCalls, 0, `Non-limit code ${code} cannot use a read fallback`);
  }
  for (const code of [146, 292]) {
    const error = new MongoServerError({ message: 'fixture identified memory limit', code }); let findCalls = 0;
    const boundary: any = { aggregate() { return { batchSize() { return this; }, async toArray() { throw error; } }; }, find(query: any) {
      assert.deepEqual(query, filter); findCalls++;
      return { project(projection: any) { assert.deepEqual(projection, COMPLETE_STUDY_SELECTION); return this; }, batchSize(size: number) { assert.equal(size, 5000); return this; }, async toArray() { return completeBefore; } };
    } };
    exactRows(await readPacked(boundary, filter, COMPLETE_STUDY_SELECTION), completeBefore, `Identified memory code ${code}`);
    assert.equal(findCalls, 1);
  }
  const nonServerLimit = Object.assign(new Error('fixture non-server exception'), { code: 10334 });
  const nonServerBoundary: any = { aggregate() { return { batchSize() { return this; }, async toArray() { throw nonServerLimit; } }; }, find() { throw new Error('Unexpected fallback'); } };
  await assert.rejects(readPacked(nonServerBoundary, filter, COMPLETE_STUDY_SELECTION), candidate => candidate === nonServerLimit);
  console.log('PASS real BSON/facet-memory compatible fallback and propagation of syntax/auth/network/time-limit failures');
} finally {
  await originalDb.call(client, name).dropDatabase();
  await closeDatabase(); mock.timers.reset();
  MongoClient.prototype.db = originalDb; MongoClient.prototype.connect = originalConnect;
}
