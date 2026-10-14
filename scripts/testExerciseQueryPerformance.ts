import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { BSON, MongoClient, ObjectId, type CommandStartedEvent, type CommandSucceededEvent } from "mongodb";
import { exerciseQueryTarget } from "./fixtures/exerciseQueryTarget.js";
import type { ReadingLesson, TranslationAttempt } from "../src/features/reading/reading.types.js";

// Refuse unsafe targets BEFORE dotenv/application imports, connecting or dropping.
const name = `exercise_query_performance_tests_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
for (const unsafe of [
  "mongodb+srv://example.invalid", "mongodb://example.invalid", "mongodb://127.0.0.1.example.invalid",
  "mongodb://user:password@127.0.0.1:27017", "mongodb://127.0.0.1/gramatikapp", "mongodb://127.0.0.1/admin",
  "mongodb://127.0.0.1/?directConnection=false", "mongodb://127.0.0.1/?replicaSet=production",
  "mongodb://127.0.0.1/?authSource=admin", "mongodb://127.0.0.1/#fragment", " mongodb://127.0.0.1",
]) assert.throws(() => exerciseQueryTarget(unsafe, name), undefined, "unsafe targets must fail before connection");
assert.throws(() => exerciseQueryTarget("mongodb://127.0.0.1", "gramatikapp"));
const uri = exerciseQueryTarget(process.env.TEST_EXERCISE_URI ?? "mongodb://127.0.0.1:27017", name);
process.env.MONGODB_URI = uri;
console.log("PASS unsafe-target rejection before any Mongo connection; unique fixture database and directConnection");

type Traffic = { requestBytes: number; replyBytes: number; firstReplyBytes: number; readBatches: number; closeCommands: number; rows: number; sha256Calls: number };
const emptyTraffic = (): Traffic => ({ requestBytes: 0, replyBytes: 0, firstReplyBytes: 0, readBatches: 0, closeCommands: 0, rows: 0, sha256Calls: 0 });
let activeTraffic: Traffic | undefined;
const originalCreateHash = crypto.createHash;
crypto.createHash = function (...args: Parameters<typeof originalCreateHash>) {
  if (activeTraffic && args[0] === "sha256") activeTraffic.sha256Calls++;
  return originalCreateHash(...args);
};
syncBuiltinESMExports();
const originalDb = MongoClient.prototype.db;
MongoClient.prototype.db = function (databaseName?: string, options?: any) {
  assert.ok(databaseName === undefined || databaseName === "gramatikapp" || databaseName === name, "Application must stay inside the owned exercise-query fixture");
  return originalDb.call(this, name, options);
};
const originalConnect = MongoClient.prototype.connect;
MongoClient.prototype.connect = async function () {
  this.monitorCommands = true;
  this.on("commandStarted", (event: CommandStartedEvent) => {
    if (activeTraffic && ["find", "aggregate", "getMore", "killCursors"].includes(event.commandName)) {
      assert.equal(event.databaseName, name);
      activeTraffic.requestBytes += BSON.calculateObjectSize(event.command);
      if (event.commandName === "killCursors") activeTraffic.closeCommands++;
    }
  });
  this.on("commandSucceeded", (event: CommandSucceededEvent) => {
    if (activeTraffic && ["find", "aggregate", "getMore", "killCursors"].includes(event.commandName)) {
      const bytes = BSON.calculateObjectSize(event.reply);
      activeTraffic.replyBytes += bytes;
      if (["find", "aggregate", "getMore"].includes(event.commandName)) {
        activeTraffic.readBatches++;
        if (!activeTraffic.firstReplyBytes) activeTraffic.firstReplyBytes = bytes;
        const reply = event.reply as { cursor?: { firstBatch?: unknown[]; nextBatch?: unknown[] } };
        const batch = reply.cursor?.firstBatch ?? reply.cursor?.nextBatch ?? [];
        activeTraffic.rows += batch.length;
      }
    }
  });
  return originalConnect.call(this);
};
const { connectDatabase, closeDatabase, getDatabaseClient } = await import("../src/lib/database.js");
const { chooseWritingWords, difficultWritingWords } = await import("../src/features/writing/vocabulary.js");
const { lastCompletedSession, lessonForClient } = await import("../src/features/reading/reading.service.js");
const old = await import("./fixtures/exerciseQueryBaseline.js");
const db = await connectDatabase();
assert.equal(db.progress.dbName, name);
const oid = (n: number) => new ObjectId(n.toString(16).padStart(24, "0"));
const now = new Date("2026-10-13T12:00:00.000Z"), seed = oid(90), owner = oid(1), smallOwner = oid(2), zeroOwner = oid(3), sparseOwner = oid(4), unpracticedOwner = oid(5);
const levels = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
const failures: string[] = [];
const measurements: Record<string, { before: Traffic; after: Traffic; reduction: number }> = {};
async function measured<T>(work: () => Promise<T>) {
  assert.equal(activeTraffic, undefined);
  const traffic = emptyTraffic(); activeTraffic = traffic;
  try { return { result: await work(), traffic }; } finally { activeTraffic = undefined; }
}
async function same<T>(label: string, before: () => Promise<T>, after: () => Promise<T>) {
  const previous = await measured(before), current = await measured(after);
  assert.deepEqual(current.result, previous.result, label);
  return { result: current.result, before: previous.traffic, after: current.traffic };
}
function budget(condition: boolean, message: string) { if (!condition) failures.push(message); }
function record(label: string, before: Traffic, after: Traffic) {
  const reduction = 1 - (after.requestBytes + after.replyBytes) / (before.requestBytes + before.replyBytes);
  measurements[label] = { before, after, reduction };
  console.log(JSON.stringify({ operation: label, ...measurements[label] }));
  return reduction;
}

// A removed post-review usability check, altered seed ranking, early raw-row limit,
// CEFR switch to reviewed content, or shared-account query will fail these real reads.
async function vocabularyFixtures() {
  const wordsDE: any[] = [], wordsES: any[] = [], relations: any[] = [], progress: any[] = [];
  const baseForms = { gender: "das", plural: "Wörter", perfect: "gelernt", past: "lernte" };
  function pair(n: number, options: { german?: string; spanish?: string; level?: string; study?: any; missingDE?: boolean; missingES?: boolean } = {}) {
    const relationId = oid(10000 + n), de = oid(20000 + n), es = oid(30000 + n);
    if (!options.missingDE) wordsDE.push({ _id: de, word: options.german ?? `Wort${n}`, cefrLevel: options.level ?? "A1.1", forms: baseForms,
      notes: `Base ${"n".repeat(640)}`, examples: ["Ein Beispiel."], contexts: ["fixture"], gramaticalCategories: ["NOUN"], createdAt: now });
    if (!options.missingES) wordsES.push({ _id: es, word: options.spanish ?? `palabra${n}`, cefrLevel: "A1.1", forms: {}, notes: "", createdAt: now });
    relations.push({ _id: relationId, main: es, translated: de, createdAt: now, ...(options.study === undefined ? {} : { study: options.study }) });
    return relationId;
  }
  let progressNumber = 0;
  function practiced(userId: ObjectId, relationId: ObjectId, extras: any = {}) {
    const itemId = oid(50000 + progressNumber++);
    progress.push({ _id: itemId, userId, itemId, relationId, itemType: "WORD", ease: 2.5, interval: 7, repetitions: 2, lastReviewed: new Date(+now - 60000),
      nextDueDate: now, failureIndex: 1, writingReinforcementCredit: 0, createdAt: now, ...extras });
  }
  const reviewed = (n: number) => ({ version: 1, german: `Konstruktion${n}`, spanish: `pista${n}`, notes: `Reviewed ${"r".repeat(640)}`,
    forms: { gender: "die", plural: `Form${n}` }, category: "NOUN", germanExamples: ["Das ist ein Beispiel."], spanishExamples: ["Es un ejemplo."] });
  for (let n = 0; n < 2400; n++) {
    const relation = pair(n, { level: `${levels[n % 6]}.${n % 2 + 1}`, study: n % 2 ? reviewed(n) : undefined });
    practiced(owner, relation, { lastReviewed: new Date(+now - 60000 - n * 1000), failureIndex: 2401 - n, writingReinforcementCredit: n % 4 * .25 });
  }
  // Rejected rows come before 180 usable RECENT candidates. A raw-row limit fails.
  for (let n = 2400; n < 2650; n++) {
    const relation = pair(n, { german: "x".repeat(81), study: n % 2 ? { ...reviewed(n), german: "one two three four five six seven" } : undefined });
    practiced(owner, relation, { lastReviewed: now, failureIndex: 0 });
  }
  const variants = [
    {}, { german: "x".repeat(81), study: reviewed(2701) }, { study: { ...reviewed(2702), german: "x".repeat(81) } },
    { study: { ...reviewed(2703), german: "   " } }, { study: { ...reviewed(2704), spanish: " " } },
    { study: { ...reviewed(2705), version: 2 } }, { study: { ...reviewed(2706), notes: 3 } },
    { study: { ...reviewed(2707), german: "" } }, { study: { ...reviewed(2708), spanish: "" } },
    { study: { ...reviewed(2709), german: 12 } }, { study: { ...reviewed(2710), spanish: false } },
    { study: { ...reviewed(2711), forms: { plural: 7 }, category: "INVALID" } },
    { study: { ...reviewed(2712), forms: ["not an object"] } },
    { study: { ...reviewed(2713), forms: { unknown: "ignored" } } },
    { study: { ...reviewed(2714), forms: null } }, { study: null }, { study: "bad metadata" },
    { german: "one two three four five six seven" }, { spanish: " " }, { missingDE: true }, { missingES: true },
  ];
  variants.forEach((options, index) => {
    const relation = pair(2700 + index, { ...options, level: `${levels[index % 6]}.1` });
    practiced(smallOwner, relation, { failureIndex: index % 5, writingReinforcementCredit: index % 3 * .25, lastReviewed: new Date(+now - (index % 4) * 1000) });
    if (index === 0) {
      practiced(smallOwner, relation, { failureIndex: 6, writingReinforcementCredit: .25, completedAt: now });
      practiced(smallOwner, relation, { failureIndex: 500, suspended: true });
      practiced(smallOwner, relation, { failureIndex: 600, supersededByAnki: true });
      practiced(oid(6), relation, { failureIndex: 700 });
    }
  });
  // Both failure-only practice and exact zero difficulty remain automatic candidates.
  const zero = pair(2750); practiced(zeroOwner, zero, { failureIndex: 0, writingReinforcementCredit: 1 });
  const credited = pair(2751); practiced(zeroOwner, credited, { failureIndex: 2, writingReinforcementCredit: 3 });
  const failureOnly = pair(2752); practiced(zeroOwner, failureOnly, { failureIndex: 1, lastReviewed: null, writingReinforcementCredit: .25 });
  const unstudied = pair(2753); practiced(zeroOwner, unstudied, { failureIndex: 0, lastReviewed: null });
  practiced(sparseOwner, oid(12700), { failureIndex: 1 });
  // Legacy relation fallback is preserved; phrase progress cannot become a word.
  practiced(smallOwner, oid(12715), { itemId: oid(12715), relationId: undefined, failureIndex: 3 });
  practiced(smallOwner, oid(12716), { itemType: "PHRASE", failureIndex: 1000 });
  await db.wordsDE.insertMany(wordsDE); await db.wordsES.insertMany(wordsES); await db.relationsWordsEsDe.insertMany(relations); await db.progress.insertMany(progress);
  return { zero, credited, failureOnly, baseForms };
}

async function writingChecks() {
  const fixture = await vocabularyFixtures();
  for (const level of levels) {
    for (const focus of ["RECENT", "DIFFICULT"] as const) {
      await same(`full Writing ${level} ${focus}`, () => old.chooseWritingWords(smallOwner, seed, level, focus), () => chooseWritingWords(smallOwner, seed, level, focus));
      await same(`full fallback ${level} ${focus}`, () => old.chooseWritingWords(unpracticedOwner, seed, level, focus), () => chooseWritingWords(unpracticedOwner, seed, level, focus));
    }
    await same(`difficult ${level}`, () => old.difficultWritingWords(smallOwner, level, 6), () => difficultWritingWords(smallOwner, level, 6));
  }
  for (const focus of ["RECENT", "DIFFICULT"] as const) {
    const ids = [String(oid(12711)), String(oid(12700)), String(oid(12701))];
    const manual = await same(`manual supplied order ${focus}`, () => old.chooseWritingWords(smallOwner, seed, "C2", focus, ids), () => chooseWritingWords(smallOwner, seed, "C2", focus, ids));
    assert.deepEqual(manual.result.map(word => word.id), ids);
    assert.deepEqual(manual.result[0].forms, fixture.baseForms, "invalid reviewed forms preserve original forms");
    assert.equal(manual.result[2].german, "Konstruktion2701", "usable reviewed correction rescues rejected base text");
  }
  for (const selectedIds of [[String(oid(12702))], [String(oid(12703))], [String(oid(12704))], [String(oid(12719))], [String(oid(12720))], [String(oid(12399))]]) {
    for (const choose of [old.chooseWritingWords, chooseWritingWords]) await assert.rejects(() => choose(smallOwner, seed, "A1", "RECENT", selectedIds), /unavailable|above the chosen level/);
  }
  for (const choose of [old.chooseWritingWords, chooseWritingWords]) {
    await assert.rejects(() => choose(smallOwner, seed, "A1", "DIFFICULT", [String(oid(12700)), String(oid(12700))]), /different words/);
    await assert.rejects(() => choose(smallOwner, seed, "A1", "DIFFICULT", [String(oid(12700)), String(oid(12701)), String(oid(12705))]), /up to 2/);
    await assert.rejects(() => choose(smallOwner, seed, "C2", "DIFFICULT", ["invalid"]), /different words/);
  }
  const zeros = await same("automatic DIFFICULT retains practiced zero difficulty", () => old.chooseWritingWords(zeroOwner, seed, "C2", "DIFFICULT"), () => chooseWritingWords(zeroOwner, seed, "C2", "DIFFICULT"));
  assert.deepEqual(zeros.result.slice(0, 3).map(word => word.id), [String(fixture.failureOnly), String(fixture.credited), String(fixture.zero)]);
  const positive = await same("difficult list filters zero difficulty", () => old.difficultWritingWords(zeroOwner, "C2", 6), () => difficultWritingWords(zeroOwner, "C2", 6));
  assert.equal(positive.result.length, 1);
  for (const extraSeed of [oid(91), oid(92)]) await same("seeded RECENT first 180 usable pool", () => old.chooseWritingWords(owner, extraSeed, "C2", "RECENT"), () => chooseWritingWords(owner, extraSeed, "C2", "RECENT"));
  const difficult = await same("large difficult-six", () => old.difficultWritingWords(owner, "C2", 6), () => difficultWritingWords(owner, "C2", 6));
  record("difficult-six", difficult.before, difficult.after);
  budget(difficult.after.requestBytes + difficult.after.replyBytes < 20000, `difficult-six <20KB: observed ${difficult.after.requestBytes + difficult.after.replyBytes}`);
  budget(difficult.after.readBatches === 1 && difficult.after.closeCommands === 1, "difficult-six should use one read batch and close its remaining cursor");
  const recent = await same("large RECENT", () => old.chooseWritingWords(owner, seed, "C2", "RECENT"), () => chooseWritingWords(owner, seed, "C2", "RECENT"));
  budget(record("recent", recent.before, recent.after) >= .8, "RECENT request/reply payload reduction must be >=80%");
  budget(recent.after.readBatches <= 6, `RECENT must use <=6 read batches for 250 rejected +180 usable candidates: observed ${recent.after.readBatches}`);
  budget(recent.after.sha256Calls <= 180, `RECENT must compute each seed rank at most once: observed ${recent.after.sha256Calls} for <=180 candidates`);
  const fallback = await same("large fallback", () => old.chooseWritingWords(unpracticedOwner, seed, "C2", "RECENT"), () => chooseWritingWords(unpracticedOwner, seed, "C2", "RECENT"));
  budget(record("fallback", fallback.before, fallback.after) >= .8, "fallback request/reply payload reduction must be >=80%");
  budget(fallback.after.readBatches <= 4, `fallback must use <=4 read batches: observed ${fallback.after.readBatches}`);
  const catalogRows = await db.relationsWordsEsDe.countDocuments();
  budget(fallback.after.sha256Calls <= catalogRows, `fallback seed hashing must be linear in catalog size: observed ${fallback.after.sha256Calls} for ${catalogRows} relations`);
  await same("partial practice plus fallback exclusions", () => old.chooseWritingWords(sparseOwner, seed, "C2", "DIFFICULT"), () => chooseWritingWords(sparseOwner, seed, "C2", "DIFFICULT"));
  console.log("PASS complete Writing output differential: six CEFR bands, two focuses, three seeds, manual ordering, reviewed validity/forms, zero difficulty, suspension, supersession, completed cards, failures and fallback exclusions");
}

async function recentScoreSnapshotCheck() {
  const expected = await old.chooseWritingWords(owner, seed, "C2", "RECENT");
  const relationIds = expected.map(word => new ObjectId(word.id));
  const previous = await db.progress.find({ userId: owner, relationId: { $in: relationIds } }).toArray();
  const relations = db.relationsWordsEsDe, originalAggregate = relations.aggregate;
  let edited = false;
  relations.aggregate = function (...args: any[]) {
    const cursor = originalAggregate.apply(this, args), originalToArray = cursor.toArray;
    cursor.toArray = async function () {
      if (!edited) {
        edited = true;
        await db.progress.updateMany({ userId: owner, relationId: { $in: relationIds } }, { $set: { failureIndex: 7777, writingReinforcementCredit: 5000 } });
      }
      return originalToArray.call(this);
    };
    return cursor;
  } as typeof originalAggregate;
  try {
    assert.deepEqual(await chooseWritingWords(owner, seed, "C2", "RECENT"), expected, "RECENT preserves its first-read failure/difficulty scores through winner hydration");
    assert.ok(edited, "fixture edits scores after candidate discovery and before hydration");
  } finally {
    relations.aggregate = originalAggregate;
    await db.progress.bulkWrite(previous.map(row => ({ updateOne: { filter: { _id: row._id }, update: { $set: { failureIndex: row.failureIndex, writingReinforcementCredit: row.writingReinforcementCredit } } } })));
  }
  console.log("PASS RECENT preserves first-read scores during intervening progress edits");
}

async function readingChecks() {
  let eventNumber = 0;
  const event = (userId: ObjectId, reviewedAt: Date, itemId = oid(90000), itemType = "WORD", reversed = false) => ({ _id: oid(100000 + eventNumber++), userId, itemId, itemType,
    reviewId: `fixture_event_${eventNumber}`, grade: "REVISIT", reviewedAt, reversedAt: reversed ? now : null, before: { audit: "b".repeat(2000) }, after: { audit: "a".repeat(2000) },
    version: 1, deck: "Fixture", day: 20000, newCount: 0, reviewCount: 1, siblings: [], earlyReview: false });
  const users = [oid(20), oid(21), oid(22), oid(23), oid(24), oid(25)];
  const histories: any[] = [];
  // Equality joins one session; >30 minutes splits. Equality to now is complete.
  histories.push(event(users[0], new Date(+now - 30 * 60000), oid(90000), "WORD", true));
  histories.push(event(users[0], new Date(+now - 60 * 60000), oid(90001), "WORD"));
  histories.push(event(users[0], new Date(+now - 60 * 60000), oid(90000), "WORD"));
  histories.push(event(users[0], new Date(+now - 90 * 60000), oid(90002), "PHRASE"));
  histories.push(event(users[0], new Date(+now - 121 * 60000), oid(90003), "WORD"));
  // Active/latest sessions and phrase-only completed sessions cannot hide older qualifying words.
  for (let i = 0; i < 350; i++) histories.push(event(users[1], new Date(+now - i * 1000), oid(91000 + i % 3), i % 3 ? "PHRASE" : "WORD", i % 7 === 0));
  for (let i = 0; i < 130; i++) histories.push(event(users[1], new Date(+now - 40 * 60000 - i * 1000), oid(92000), "PHRASE"));
  for (let i = 0; i < 120; i++) histories.push(event(users[1], new Date(+now - 80 * 60000 - i * 1000), oid(93000 + i % 4), "WORD", i % 2 === 0));
  for (let i = 0; i < 120; i++) histories.push(event(users[1], new Date(+now - 125 * 60000 - i * 1000), oid(93500 + i % 2), "WORD"));
  histories.push(event(users[2], new Date(+now - 10 * 60000)));
  histories.push(event(users[3], new Date(+now - 50 * 60000), oid(94000), "PHRASE"));
  histories.push(event(users[4], new Date(+now - 30 * 60000 + 1)));
  await db.reviewEvents.insertMany(histories as never);
  for (const user of users) {
    const result = await same(`all session fields ${user}`, () => old.lastCompletedSession(user, now), () => lastCompletedSession(user, now));
    if (user.equals(users[0])) {
      assert.equal(result.result?.reviewCount, 4); assert.equal(result.result?.endedAt.toISOString(), "2026-10-13T11:30:00.000Z");
      assert.equal(result.result?.startedAt.toISOString(), "2026-10-13T10:30:00.000Z"); assert.equal(result.result?.id, String(oid(100003)));
      assert.deepEqual(result.result?.itemIds.map(String), [String(oid(90000)), String(oid(90001))]);
    }
    if (user.equals(users[1])) {
      assert.equal(result.result?.reviewCount, 120); assert.equal(result.result?.itemIds.length, 4);
      record("reading-discovery", result.before, result.after);
      budget(result.after.firstReplyBytes < 15000, `Reading discovery first batch <15KB: observed ${result.after.firstReplyBytes}`);
      budget(result.after.readBatches >= 3, `Reading discovery must retain >=3 cursor batches: observed ${result.after.readBatches}`);
      budget(result.after.closeCommands === 1, "Reading early-return discovery must close its live cursor");
    }
    if (users.slice(2).some(id => id.equals(user))) assert.equal(result.result, null);
  }
  console.log("PASS complete Reading sessions: >=3 cursor batches, 30-minute equality/gaps, active/latest vs old completed, phrases, repeated directions, reversed and equal timestamps, empty/account isolation");
}

async function attemptChecks() {
  const lesson: ReadingLesson = { _id: oid(200000), userId: owner, sessionId: String(oid(200001)), sessionStartedAt: new Date(+now - 7200000), sessionEndedAt: new Date(+now - 3600000),
    status: "READY", error: null, words: [], pageCount: 5, pages: Array.from({ length: 5 }, (_, index) => ({ index, title: `Page ${index}`, german: `Text ${index}`, spanish: `Referencia ${index}`,
      words: [], vocabulary: [], wordCount: 10 + index })), model: "fixture", promptVersion: 1, createdAt: now, updatedAt: now };
  const feedback = { score: 80, summary: "Saved feedback", correctedSpanish: "Referencia",
    corrections: [{ original: "original", corrected: "correction", explanation: "explanation", category: "grammar" }],
    omissions: [{ german: "ein Wort", explanation: "missing meaning" }], vocabulary: [{ wordId: "fixture-word", understood: true, feedback: "understood" }] };
  const attempts: TranslationAttempt[] = [];
  const attempt = (n: number, pageIndex: number, status: TranslationAttempt["status"], createdAt = now, extra: Partial<TranslationAttempt> = {}) => ({ _id: oid(210000 + n), userId: owner, lessonId: lesson._id, pageIndex,
    requestId: `fixture_request_${n}`, translation: `Translation ${n} ${"t".repeat(1500)}`, status, createdAt, updatedAt: now, ...(status === "READY" ? { feedback } : {}), ...extra });
  // Every public lastAttempt field and reference visibility are compared, not IDs alone.
  attempts.push(attempt(0, 0, "READY", new Date(+now - 1000)), attempt(1, 0, "FAILED", now, { error: "Failed newest attempt" }));
  attempts.push(attempt(2, 1, "READY"), attempt(3, 1, "CHECKING"));
  attempts.push(attempt(4, 2, "FAILED", now, { error: null }), attempt(5, 2, "READY"));
  attempts.push(attempt(6, 3, "FAILED", now));
  for (let n = 10; n < 510; n++) attempts.push(attempt(n, n % 3, n % 4 ? "FAILED" : "READY", new Date(+now - 10000 - n * 1000)));
  attempts.push(attempt(600, 4, "READY", now, { userId: oid(6) }), attempt(601, 4, "READY", now, { lessonId: oid(200002) }), attempt(602, 99, "READY"));
  await db.translationAttempts.insertMany(attempts);
  const compared = await same("full lessonForClient", () => old.lessonForClient(lesson), () => lessonForClient(lesson));
  assert.equal(compared.result.pages[0].spanish, "Referencia 0"); assert.equal(compared.result.pages[0].lastAttempt?.status, "FAILED");
  assert.equal(compared.result.pages[1].spanish, "Referencia 1"); assert.equal(compared.result.pages[1].lastAttempt?.status, "CHECKING");
  assert.equal(compared.result.pages[2].lastAttempt?.id, String(oid(210005)), "equal timestamps use descending ObjectId");
  assert.equal(compared.result.pages[3].spanish, null); assert.equal(compared.result.pages[4].spanish, null); assert.equal(compared.result.pages[4].lastAttempt, null);
  budget(record("lesson-attempts", compared.before, compared.after) >= .8, "lesson attempt payload reduction must be >=80%");
  await same("empty lesson pages", () => old.lessonForClient({ ...lesson, pages: [] }), () => lessonForClient({ ...lesson, pages: [] }));
  await same("unrelated lesson/account", () => old.lessonForClient({ ...lesson, _id: oid(200003), userId: oid(7) }), () => lessonForClient({ ...lesson, _id: oid(200003), userId: oid(7) }));
  console.log("PASS complete public lesson replies: older READY survives newer FAILED/CHECKING, per-page ties, all feedback/null fields, empty pages, unrelated account/lesson/page isolation");
}

async function unfilledChecks() {
  // After the large measurements, an isolated two-relation catalog proves short/empty selections.
  await db.progress.deleteMany({}); await db.relationsWordsEsDe.deleteMany({}); await db.wordsDE.deleteMany({}); await db.wordsES.deleteMany({});
  const relation = oid(300000), de = oid(300001), es = oid(300002);
  await db.wordsDE.insertOne({ _id: de, word: "Haus", cefrLevel: "A1.1", notes: "", forms: { gender: "das" } } as never);
  await db.wordsES.insertOne({ _id: es, word: "casa" } as never);
  await db.relationsWordsEsDe.insertOne({ _id: relation, main: es, translated: de, createdAt: now });
  const partial = await same("fewer-than-limit fallback", () => old.chooseWritingWords(unpracticedOwner, seed, "C2", "RECENT"), () => chooseWritingWords(unpracticedOwner, seed, "C2", "RECENT"));
  assert.equal(partial.result.length, 1); assert.equal(partial.result[0].difficultyScore, 0); assert.equal(partial.result[0].failureIndex, 0);
  await same("empty difficult list", () => old.difficultWritingWords(unpracticedOwner, "C2", 6), () => difficultWritingWords(unpracticedOwner, "C2", 6));
  await db.relationsWordsEsDe.deleteMany({});
  for (const choose of [old.chooseWritingWords, chooseWritingWords]) await assert.rejects(() => choose(unpracticedOwner, seed, "A1", "RECENT"), /No German-Spanish words/);
  console.log("PASS fewer-than-limit/empty selections and fallback zero failure/difficulty values");
}

async function fallbackContentChecks() {
  const relation = oid(300000), de = oid(300001), es = oid(300002), baseForms = { gender: "das", plural: "Häuser" };
  const valid = { version: 1, german: "das Haus", spanish: "la casa", notes: "Reviewed note", forms: { gender: "die", plural: "Häuser" } };
  const cases: { label: string; study?: any; baseGerman?: string; expected?: { german: string; spanish: string; notes: string; forms: any } }[] = [
    { label: "absent metadata" }, { label: "null metadata", study: null }, { label: "primitive metadata", study: "bad" },
    { label: "wrong version", study: { ...valid, version: 2 } }, { label: "empty German", study: { ...valid, german: "" } },
    { label: "empty Spanish", study: { ...valid, spanish: "" } }, { label: "nonstring German", study: { ...valid, german: 12 } },
    { label: "nonstring Spanish", study: { ...valid, spanish: false } }, { label: "nonstring notes", study: { ...valid, notes: 1 } },
    { label: "reviewed correction rescues unusable base", baseGerman: "x".repeat(81), study: valid, expected: valid },
    { label: "valid empty notes/forms", study: { ...valid, notes: "", forms: {} }, expected: { ...valid, notes: "", forms: {} } },
    ...[null, [], "bad", { plural: 3 }, { unknown: "invalid" }].map((forms, i) => ({ label: `malformed forms ${i}`, study: { ...valid, forms, category: "INVALID" }, expected: { ...valid, forms: baseForms } })),
    { label: "reviewed whitespace German", study: { ...valid, german: "   " }, expected: undefined },
    { label: "reviewed whitespace Spanish", study: { ...valid, spanish: " " }, expected: undefined },
    { label: "reviewed long German", study: { ...valid, german: "x".repeat(81) }, expected: undefined },
    { label: "reviewed seven tokens", study: { ...valid, german: "one two three four five six seven" }, expected: undefined },
  ];
  for (const entry of cases) {
    await db.wordsDE.replaceOne({ _id: de }, { _id: de, word: entry.baseGerman ?? "Haus", cefrLevel: "A1.1", notes: "Base note", forms: baseForms } as never, { upsert: true });
    await db.relationsWordsEsDe.replaceOne({ _id: relation }, { _id: relation, main: es, translated: de, createdAt: now, ...(entry.study === undefined ? {} : { study: entry.study }) } as never, { upsert: true });
    if (entry.label.startsWith("reviewed ") && !entry.expected && !entry.label.includes("correction")) {
      for (const choose of [old.chooseWritingWords, chooseWritingWords]) await assert.rejects(() => choose(unpracticedOwner, seed, "A1", "RECENT"), /No German-Spanish words/);
      continue;
    }
    const compared = await same(`fallback validity ${entry.label}`, () => old.chooseWritingWords(unpracticedOwner, seed, "A1", "RECENT"), () => chooseWritingWords(unpracticedOwner, seed, "A1", "RECENT"));
    const { german, spanish, notes, forms } = entry.expected ?? { german: "Haus", spanish: "casa", notes: "Base note", forms: baseForms };
    assert.deepEqual(compared.result, [{ id: String(relation), german, spanish, notes, forms, cefrLevel: "A1.1", failureIndex: 0, difficultyScore: 0 }]);
  }
  console.log("PASS minimal fallback labels match full reviewed validity; rich winners retain exact notes/forms validation");
}

async function interveningFallbackChecks() {
  const relations = db.relationsWordsEsDe, originalAggregate = relations.aggregate;
  for (const change of ["deleted relation", "missing endpoint", "higher CEFR", "unusable reviewed label"]) {
    await relations.deleteMany({}); await db.wordsDE.deleteMany({}); await db.wordsES.deleteMany({});
    const rows = Array.from({ length: 10 }, (_, n) => ({ _id: oid(310000 + n), main: oid(320000 + n), translated: oid(330000 + n), createdAt: now }));
    await relations.insertMany(rows);
    await db.wordsDE.insertMany(rows.map((row, n) => ({ _id: row.translated, word: `Wort${n}`, cefrLevel: "A1.1", notes: `Note ${n}`, forms: { gender: "das" } })) as never);
    await db.wordsES.insertMany(rows.map((row, n) => ({ _id: row.main, word: `palabra${n}` })) as never);
    const initial = await old.chooseWritingWords(unpracticedOwner, seed, "A1", "RECENT"), winner = rows.find(row => String(row._id) === initial[0].id)!;
    let edited = false;
    // Keep real Mongo queries; introduce the concurrent edit after minimal discovery
    // resolves and before the service can hydrate. No production-only testing seam.
    relations.aggregate = function (...args: any[]) {
      const cursor = originalAggregate.apply(this, args), originalToArray = cursor.toArray;
      cursor.toArray = async function () {
        const candidates = await originalToArray.call(this);
        if (!edited && candidates.length === 10 && candidates.every((row: any) => row.id && !Object.hasOwn(row, "forms"))) {
          edited = true;
          if (change === "deleted relation") await relations.deleteOne({ _id: winner._id });
          if (change === "missing endpoint") await db.wordsDE.deleteOne({ _id: winner.translated });
          if (change === "higher CEFR") await db.wordsDE.updateOne({ _id: winner.translated }, { $set: { cefrLevel: "C2.2" } });
          if (change === "unusable reviewed label") await relations.updateOne({ _id: winner._id }, { $set: { study: { version: 1, german: "x".repeat(81), spanish: "pista", notes: "" } as any } });
        }
        return candidates;
      };
      return cursor;
    } as typeof originalAggregate;
    try {
      const selected = await chooseWritingWords(unpracticedOwner, seed, "A1", "RECENT");
      assert.ok(edited, `fixture must introduce ${change} between discovery and hydration`);
      assert.equal(selected.length, 2, `fill the requested selection after ${change}`);
      assert.deepEqual(selected, await old.chooseWritingWords(unpracticedOwner, seed, "A1", "RECENT"), `full ranked output after ${change}`);
    } finally { relations.aggregate = originalAggregate; }
  }
  console.log("PASS fallback winners revalidated/refilled in seed order after relation/endpoint/CEFR/reviewed-label edits");
}

try {
  await writingChecks(); await recentScoreSnapshotCheck(); await readingChecks(); await attemptChecks(); await unfilledChecks(); await fallbackContentChecks(); await interveningFallbackChecks();
  assert.deepEqual(failures, [], `Mongo payload budgets failed:\n${failures.join("\n")}`);
  console.log("PASS exercise query output equivalence and BSON request/reply budgets (getMore and cursor close included)");
} finally {
  assert.equal(db.progress.dbName, name); assert.match(name, /^exercise_query_performance_tests_/);
  await originalDb.call(getDatabaseClient(), name).dropDatabase();
  await closeDatabase(); MongoClient.prototype.db = originalDb; MongoClient.prototype.connect = originalConnect;
  crypto.createHash = originalCreateHash; syncBuiltinESMExports();
}
