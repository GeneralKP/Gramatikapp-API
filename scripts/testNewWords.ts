import "dotenv/config";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { typeDefs, resolvers } from "../src/graphql/schema.js";
import { DEFAULT_OPTIONS, initialScheduler, scheduleReview, GRADES } from "../src/features/progress/scheduler.js";
import { nativeWordPair, ensureNativeWordPairs } from "../src/features/progress/nativeWordPairs.js";
import { GrammaticalCategory, type Word } from "../src/features/words/words.types.js";
import { selectStudyQueue } from "../src/features/progress/studyQueue.js";
import type { UserProgress } from "../src/features/progress/progress.types.js";

const now = new Date();
const userId = new ObjectId();
function card(direction: "DE_ES" | "ES_DE", note: string, position: number): UserProgress {
  const p: UserProgress = {
    _id: new ObjectId(), userId, itemId: new ObjectId(), itemType: "WORD", isNew: true,
    ease: 2.5, interval: 0, repetitions: 0, nextDueDate: now, lastReviewed: null, createdAt: now,
    anki: { type: 0, queue: 0, left: 0, reps: 0, did: 1, due: position },
    card: { source: "ANKI", sourceCardId: String(Date.now()), sourceNoteGuid: note, direction,
      prompt: direction === "DE_ES" ? "die Angst vor" : "miedo a", answer: direction === "DE_ES" ? "miedo a" : "die Angst vor",
      acceptedAnswers: direction === "DE_ES" ? ["miedo a"] : ["die Angst vor"], notes: "", examples: [], deck: "Test", tags: [] },
  };
  p.scheduler = initialScheduler(p, { ...DEFAULT_OPTIONS, newPerDay: 40, reviewsPerDay: 200 });
  return p;
}
const reading = card("DE_ES", "first", 2), typing = card("ES_DE", "first", 1);
const secondReading = card("DE_ES", "second", 3), secondTyping = card("ES_DE", "second", 4);
const review = card("ES_DE", "review", 0);
review.isNew = false;
review.scheduler = { ...review.scheduler!, phase: "REVIEW", queue: "DAY", interval: 10 };
const ids = (cards: UserProgress[]) => cards.map(p => p.itemId.toString());
const queue = selectStudyQueue([typing, review, secondTyping, reading, secondReading], new Map(), now, 50, 4);
assert.deepEqual(ids(queue.filter(p => p.scheduler!.phase === "NEW")), ids([reading, typing, secondReading, secondTyping]), "each unseen word is read before it is typed, regardless of card IDs or source positions");
assert.equal(queue.indexOf(typing), queue.indexOf(reading) + 1, "due reviews may mix between introductions, but cannot split a new word's two directions");
assert.equal(queue.indexOf(secondTyping), queue.indexOf(secondReading) + 1);
assert.ok(queue.includes(review), "the scheduled review remains available");
console.log("PASS new-word direction order and paired introductions mixed with due reviews");

assert.equal(selectStudyQueue([typing, reading], new Map(), now, 50, 1).length, 0, "an introduction is not cut in half by a fetch limit");
assert.equal(selectStudyQueue([typing, reading], new Map([["Test", { new: 39, review: 0 }]]), now, 50, 10).length, 0, "a pair cannot exceed the daily new-card limit");
assert.equal(selectStudyQueue([typing, { ...reading, buriedUntil: new Date(now.getTime() + 86400000) }], new Map(), now, 50, 10).length, 0, "burying recognition cannot put typing first");
assert.equal(selectStudyQueue([typing, { ...reading, suspended: true }], new Map(), now, 50, 10).length, 0);
const introduced = { ...reading, isNew: false, nextDueDate: new Date(now.getTime() + 86400000), scheduler: { ...reading.scheduler!, phase: "REVIEW" as const, queue: "DAY" as const } };
assert.deepEqual(ids(selectStudyQueue([typing, introduced], new Map(), now, 50, 1)), ids([typing]), "a previously introduced recognition card unlocks typing without resetting its schedule");
for (const newMix of [0, 1, 2]) {
  const cards = [review, reading, typing].map(p => ({ ...p, scheduler: { ...p.scheduler!, options: { ...p.scheduler!.options, newMix } } }));
  const mixed = selectStudyQueue(cards, new Map(), now, 50, 10);
  assert.equal(mixed.findIndex(p => p.card!.direction === "DE_ES") + 1, mixed.findIndex(p => p.itemId.equals(typing.itemId)));
}
console.log("PASS partial introductions, daily limits, buried recognition and all Anki mixing modes");

const nativeRelation = new ObjectId();
const nativeDE: Word = { _id: new ObjectId(), word: "Angst vor", gramaticalCategories: [GrammaticalCategory.NOUN], forms: { gender: "die" }, examples: [], contexts: [], createdAt: now };
const nativeES: Word = { ...nativeDE, _id: new ObjectId(), word: "miedo a", forms: {} };
const nativeOriginal: UserProgress = { ...card("ES_DE", "native", 0), card: undefined, anki: undefined, itemId: nativeRelation, failureIndex: 3 };
const [nativeReading, nativeTyping] = nativeWordPair(nativeOriginal, nativeES, nativeDE);
assert.equal(nativeReading.card!.prompt, "die Angst vor");
assert.equal(nativeTyping.card!.answer, "die Angst vor");
assert.equal(nativeTyping.itemId, nativeOriginal.itemId);
assert.equal(nativeTyping.failureIndex, 3);
assert.deepEqual(ids(selectStudyQueue([nativeTyping, nativeReading], new Map(), now, 0, 2)), ids([nativeReading, nativeTyping]));
for (const grade of GRADES) assert.deepEqual(scheduleReview(nativeTyping, grade, now), scheduleReview(nativeOriginal, grade, now), "adding recognition preserves every existing production scheduling calculation");
console.log("PASS native word introductions with full articles/prepositions and unchanged production scheduling");

const db = await connectDatabase();
const freshUserId = new ObjectId();
const schema = makeExecutableSchema({ typeDefs, resolvers });
const call = async (source: string, variables: Record<string, unknown>) => {
  const result = await graphql({ schema, source, variableValues: { userId: userId.toString(), ...variables }, contextValue: { user: { _id: userId } } });
  assert.equal(result.errors, undefined, result.errors?.map(e => e.message).join("; "));
  return result.data as any;
};
const rate = async (p: UserProgress, grade: string, reviewId: string, expectedVersion = 0) => (await call(`mutation($userId:ID!,$itemId:ID!,$grade:ReviewGrade!,$reviewId:String!,$expectedVersion:Int!) { reviewItem(userId:$userId,itemId:$itemId,itemType:"WORD",grade:$grade,reviewId:$reviewId,expectedVersion:$expectedVersion) { success error errorCode progress { schedulerPhase nextDueDate totalReviews } } }`, { itemId: p.itemId.toString(), grade, reviewId, expectedVersion })).reviewItem;
try {
  reading.scheduler!.options.buryNew = true;
  await db.progress.insertMany([reading, typing]);
  const premature = await rate(typing, "GOOD", randomUUID());
  assert.equal(premature.success, false, "the server rejects typing before recognition even from an old cached queue");
  assert.equal(premature.errorCode, "INTRODUCTION_REQUIRED");
  const recognitionReview = randomUUID();
  assert.equal((await rate(reading, "GOOD", recognitionReview)).success, true);
  const due = await call(`query($userId:ID!) { dueItems(userId:$userId,itemType:"WORD",dueLimit:0,newLimit:1) { itemId card { direction } } }`, {});
  assert.deepEqual(due.dueItems.map((p: any) => p.itemId), ids([typing]), "a reload keeps the production card available even with sibling burying enabled");
  const undone = await call(`mutation($userId:ID!,$reviewId:String!) { undoReview(userId:$userId,reviewId:$reviewId) { success } }`, { reviewId: recognitionReview });
  assert.equal(undone.undoReview.success, true);
  assert.equal((await rate(typing, "EASY", randomUUID())).success, false, "Undo restores recognition-first ordering");
  const extra = await call(`query($userId:ID!) { studyMoreItems(userId:$userId,itemType:"WORD",limit:2) { itemId card { direction } } }`, {});
  assert.deepEqual(extra.studyMoreItems.map((p: any) => p.itemId), ids([reading, typing]), "Study More also preserves paired direction order");
  assert.equal((await rate(reading, "EASY", randomUUID(), 2)).success, true);
  assert.equal((await rate(typing, "GOOD", randomUUID())).success, true);
  console.log("PASS GraphQL recognition prerequisite, reload, Undo, sibling burial and Study More");
  await db.wordsES.insertOne(nativeES);
  await db.wordsDE.insertOne(nativeDE);
  await db.relationsWordsEsDe.insertOne({ _id: nativeRelation, main: nativeES._id, translated: nativeDE._id, createdAt: now });
  await db.progress.insertOne(nativeOriginal);
  await Promise.all(Array.from({ length: 6 }, () => ensureNativeWordPairs([nativeOriginal])));
  assert.equal(await db.progress.countDocuments({ userId, relationId: nativeRelation }), 2, "concurrent introduction creation never duplicates cards");
  const nativeQueue = await call(`query($userId:ID!) { dueItems(userId:$userId,itemType:"WORD",dueLimit:0,newLimit:2) { itemId card { source direction prompt answer } } }`, {});
  assert.deepEqual(nativeQueue.dueItems.map((p: any) => p.card.direction), ["DE_ES", "ES_DE"]);
  assert.ok(nativeQueue.dueItems.every((p: any) => p.card.source === "APP"));
  assert.equal((await rate(nativeTyping, "GOOD", randomUUID())).errorCode, "INTRODUCTION_REQUIRED");
  assert.equal((await rate(nativeReading, "EASY", randomUUID())).success, true);
  assert.equal((await rate(nativeTyping, "GOOD", randomUUID())).success, true);
  assert.equal((await db.progress.findOne({ _id: nativeOriginal._id }))!.failureIndex, 3);
  console.log("PASS native word pair persistence, concurrent retries and server recognition prerequisite");
  const freshQueue = async () => {
    const result = await graphql({ schema, source: `query($userId:ID!) { dueItems(userId:$userId,itemType:"WORD",dueLimit:0,newLimit:2) { itemId relationId card { source direction } } }`, variableValues: { userId: freshUserId.toString() }, contextValue: { user: { _id: freshUserId } } });
    assert.equal(result.errors, undefined);
    return (result.data as any).dueItems;
  };
  const fresh = await freshQueue();
  assert.deepEqual(fresh.map((p: any) => p.card.direction), ["DE_ES", "ES_DE"], "fresh vocabulary automatically creates a whole introduction pair within the requested limit");
  assert.equal(fresh[0].relationId, fresh[1].relationId);
  assert.deepEqual(await freshQueue(), fresh, "reload keeps the same introduction instead of creating more cards");
  assert.equal(await db.progress.countDocuments({ userId: freshUserId }), 2);
  console.log("PASS automatically paired fresh vocabulary, two-card fetch limits and idempotent reload");
} finally {
  await db.reviewEvents.deleteMany({ userId });
  await db.progress.deleteMany({ userId });
  await db.schedulerProfiles.deleteOne({ _id: userId });
  await db.relationsWordsEsDe.deleteOne({ _id: nativeRelation });
  await db.wordsES.deleteOne({ _id: nativeES._id });
  await db.wordsDE.deleteOne({ _id: nativeDE._id });
  await db.progress.deleteMany({ userId: freshUserId });
  await closeDatabase();
}
