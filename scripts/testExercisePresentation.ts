import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { typeDefs, resolvers } from "../src/graphql/schema.js";
import { getReadingLesson, generateReadingLesson } from "../src/features/reading/reading.service.js";
import { writingExercise, generateWritingExercise, translateWritingWord } from "../src/features/writing/writing.service.js";

// This adapter cannot open MongoDB or invoke a provider. Every expected read and
// expiry write is handled in memory; unexpected database operations fail closed.
const originalConnect = MongoClient.prototype.connect;
const originalDb = MongoClient.prototype.db;
const originalFetch = globalThis.fetch;
const originalUri = process.env.MONGODB_URI;
const originalKey = process.env.OPENAI_API_KEY;
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/exercise_presentation_fixture";
delete process.env.OPENAI_API_KEY;
let providerCalls = 0;
globalThis.fetch = async () => { providerCalls++; throw new Error("Provider calls are forbidden in this fixture"); };

const id = (value: number) => new ObjectId(value.toString(16).padStart(24, "0"));
const now = new Date("2026-10-15T12:00:00.000Z");
const owner = id(1), stranger = id(2), lessonId = id(10), exerciseId = id(20);
const requestId = "exercise_request_123456";
const feedback = { correct: true, score: 100, summary: "Bien", correctedGerman: "Antwort", corrections: [], alternatives: ["Alternative"] };
const latestAttempt: any = { _id: id(21), userId: owner, exerciseId, requestId: "attempt_request_123456", translation: "My saved answer", status: "FAILED", createdAt: now, updatedAt: now };
const sentence = { title: "Title", spanish: "Spanish prompt", german: "German answer", mainClause: "Main answer", subordinateClause: "Subordinate answer",
  clauseOrder: "MAIN_FIRST", connector: "weil", grammarExplanation: "Saved grammar", finiteVerbs: { main: ["ist"], subordinate: ["hat"] },
  spanishWordCount: 20, germanWordCount: 22, vocabulary: [{ wordId: "word", surfaceForms: ["Haus"], example: "Ein Haus." }] };
const exercise: any = { _id: exerciseId, userId: owner, requestId, level: "A1", words: [], sentence, status: "READY", model: "fixture-model", promptVersion: 4, createdAt: now, updatedAt: now };
const lesson: any = { _id: lessonId, userId: owner, sessionId: "saved-session", sessionStartedAt: now, sessionEndedAt: now, words: [], pageCount: 3,
  pages: [0, 1, 2].map(index => ({ index, words: [], title: `Page ${index}`, german: `German ${index}`, spanish: `Spanish ${index}`, vocabulary: [], wordCount: 400 })),
  status: "READY", model: "fixture-model", promptVersion: 2, createdAt: now, updatedAt: now };
const readingAttempt = (value: number, status: string, extra = {}) => ({ _id: id(30 + value), requestId: `reading_attempt_${value}`, pageIndex: value,
  translation: `Translation ${value}`, status, ...extra });
let readingAttempts: any[] = [
  { pageIndex: 0, attempt: readingAttempt(0, "FAILED"), hasReady: 1 },
  { pageIndex: 1, attempt: readingAttempt(1, "CHECKING", { error: null }), hasReady: 0 },
];
let completed = false;
let savedHint: any = null;
const reads: { name: string; filter: any; options?: any }[] = [];
const mutations: string[] = [];
const sameId = (left: unknown, right: unknown) => String(left) === String(right);
const owns = (filter: any) => sameId(filter.userId, owner);
const collection = (name: string) => ({
  async createIndex() {},
  async dropIndex() {},
  async updateMany(filter: any) {
    assert.ok([owner, stranger].some(userId => sameId(filter.userId, userId)), `${name}: expiry updates retain an explicit authenticated owner`);
    assert.deepEqual(Object.keys(filter).sort(), ["lockedUntil", "status", "userId"]);
    mutations.push(name);
    return { matchedCount: 0, modifiedCount: 0 };
  },
  async findOne(filter: any, options?: any) {
    reads.push({ name, filter, options });
    if (!owns(filter)) return null;
    if (name === "readinglessons") return (filter._id === undefined || sameId(filter._id, lessonId)) &&
      (filter.sessionId === undefined || filter.sessionId === lesson.sessionId) ? lesson : null;
    if (name === "writingexercises") return (filter._id === undefined || sameId(filter._id, exerciseId)) &&
      (filter.requestId === undefined || filter.requestId === requestId) ? exercise : null;
    if (name === "writingattempts") {
      assert.ok(sameId(filter.exerciseId, exerciseId));
      if (filter.status === "READY") { assert.deepEqual(options, { projection: { _id: 1 } }); return completed ? { _id: id(22) } : null; }
      assert.deepEqual(options, { sort: { createdAt: -1, _id: -1 } });
      return latestAttempt;
    }
    if (name === "writinghints") return savedHint;
    throw new Error(`Unexpected fixture read: ${name}`);
  },
  aggregate(pipeline: any[]) {
    assert.equal(name, "translationattempts");
    assert.deepEqual(pipeline[0], { $match: { userId: owner, lessonId, pageIndex: { $in: lesson.pages.map((page: any) => page.index) } } });
    assert.deepEqual(pipeline[1], { $sort: { createdAt: -1, _id: -1 } });
    assert.deepEqual(pipeline[2].$group.hasReady, { $max: { $cond: [{ $eq: ["$status", "READY"] }, 1, 0] } });
    return { async toArray() { return readingAttempts; } };
  },
});
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = function () { return { collection } as any; };

const schema = makeExecutableSchema({ typeDefs, resolvers });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
try {
  await connectDatabase();
  const operations = [
    "query { readingPractice { configured } }",
    'query { readingLesson(id:"invalid") { id } }',
    'mutation { generateReadingLesson(sessionId:"invalid") { id } }',
    'mutation { checkReadingTranslation(lessonId:"invalid",pageIndex:0,translation:"x",requestId:"invalid") { id } }',
    'query { difficultWritingWords(level:"invalid") { id } }',
    "query { writingPractice { configured } }",
    'query { writingExercise(id:"invalid") { id } }',
    'query { writingWordHint(exerciseId:"invalid",word:"x") { word } }',
    'mutation { generateWritingExercise(level:"invalid",requestId:"invalid") { id } }',
    'mutation { checkWritingTranslation(exerciseId:"invalid",translation:"x",requestId:"invalid") { id } }',
    'mutation { translateWritingWord(exerciseId:"invalid",word:"x") { word } }',
  ];
  for (const source of operations) {
    const before = reads.length + mutations.length;
    const result = await graphql({ schema, source, contextValue: { user: null } });
    assert.deepEqual(result.errors?.map(error => error.message), ["Unauthorized"], source);
    assert.equal(reads.length + mutations.length, before, "Unauthenticated calls fail before ID validation, Mongo reads or writes");
  }
  console.log("PASS all 11 exercise GraphQL operations authenticate before ID/argument validation or database work");

  const reading = await getReadingLesson(owner, lessonId);
  assert.equal(reading!.id, String(lessonId));
  assert.equal(reading!.sessionStartedAt, now.toISOString());
  assert.equal(reading!.sessionEndedAt, now.toISOString());
  assert.equal(reading!.error, null);
  assert.equal(reading!.pages[0].spanish, "Spanish 0", "A prior READY attempt keeps the reference visible after a newer FAILED attempt");
  assert.deepEqual(json(reading!.pages[0].lastAttempt), { id: String(id(30)), requestId: "reading_attempt_0", pageIndex: 0, translation: "Translation 0", status: "FAILED", error: null, feedback: null });
  assert.equal(reading!.pages[1].spanish, null, "CHECKING alone must not unlock a reference");
  assert.equal(reading!.pages[1].lastAttempt!.status, "CHECKING");
  assert.equal(reading!.pages[2].spanish, null);
  assert.equal(reading!.pages[2].lastAttempt, null);
  assert.equal(await getReadingLesson(stranger, lessonId), null);
  assert.equal((await generateReadingLesson(owner, lesson.sessionId)).status, "READY", "Saved lessons reopen without provider configuration");
  const readingFeedback = { score: 90, summary: "Saved", correctedSpanish: "Saved answer", corrections: [], omissions: [], vocabulary: [] };
  readingAttempts = [{ pageIndex: 0, attempt: readingAttempt(0, "READY", { feedback: readingFeedback, error: "Saved error" }), hasReady: 1 }];
  const assessed = await getReadingLesson(owner, lessonId);
  assert.deepEqual(assessed!.pages[0].lastAttempt!.feedback, readingFeedback);
  assert.equal(assessed!.pages[0].lastAttempt!.error, "Saved error");
  const originalPages = lesson.pages;
  lesson.pages = [];
  assert.deepEqual((await getReadingLesson(owner, lessonId))!.pages, []);
  lesson.pages = originalPages;
  console.log("PASS Reading projected attempts, null/default/status fields, older READY reference visibility, empty pages and owner isolation");

  const locked = await writingExercise(owner, exerciseId);
  assert.equal(locked!.id, String(exerciseId));
  assert.equal(locked!.createdAt, now.toISOString());
  assert.equal(locked!.error, null);
  assert.equal(locked!.focus, "RECENT");
  assert.deepEqual(locked!.selectedWordIds, []);
  assert.equal(locked!.reinforced, false);
  assert.deepEqual(json(locked!.lastAttempt), { id: String(latestAttempt._id), requestId: latestAttempt.requestId, translation: latestAttempt.translation, status: "FAILED", error: null, feedback: null });
  assert.deepEqual(locked!.sentence, { ...sentence, german: null, mainClause: null, subordinateClause: null, grammarExplanation: null, vocabulary: [] });
  assert.deepEqual(exercise.sentence, sentence, "Masking cannot mutate the persisted sentence snapshot");
  assert.notEqual(locked!.sentence, exercise.sentence);
  completed = true;
  Object.assign(exercise, { focus: "DIFFICULT", selectedWordIds: ["word"], reinforcedWords: [{ id: "word", progressId: id(40), credit: 0.25 }] });
  Object.assign(latestAttempt, { error: "Saved failure", feedback });
  const unlocked = await writingExercise(owner, exerciseId);
  assert.deepEqual(unlocked!.sentence, sentence, "Any prior READY assessment unlocks all answer fields even with a newer failed attempt");
  assert.equal(unlocked!.lastAttempt!.status, "FAILED");
  assert.equal(unlocked!.lastAttempt!.error, "Saved failure");
  assert.deepEqual(unlocked!.lastAttempt!.feedback, feedback);
  assert.equal(unlocked!.reinforced, true);
  assert.equal(unlocked!.focus, "DIFFICULT");
  assert.deepEqual(unlocked!.selectedWordIds, ["word"]);
  assert.equal(await writingExercise(stranger, exerciseId), null);
  assert.equal((await generateWritingExercise(owner, "A1", requestId, "DIFFICULT", ["word"])).status, "READY");
  savedHint = { word: "spanish", status: "READY", german: "Deutsch", explanation: "Saved hint" };
  assert.deepEqual(await translateWritingWord(owner, exerciseId, "Spanish"), { ...savedHint, error: null });
  const originalSentence = exercise.sentence;
  exercise.sentence = undefined;
  assert.equal((await writingExercise(owner, exerciseId))!.sentence, null);
  exercise.sentence = originalSentence;
  assert.equal(providerCalls, 0, "Reads and cached READY retries must never spend a provider request");
  console.log("PASS Writing masks/defaults, older READY reveal, unchanged snapshot, owner isolation and zero provider calls for saved READY work");
} finally {
  await closeDatabase();
  MongoClient.prototype.connect = originalConnect;
  MongoClient.prototype.db = originalDb;
  globalThis.fetch = originalFetch;
  if (originalUri === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = originalUri;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
}
