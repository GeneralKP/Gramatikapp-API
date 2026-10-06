import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { ObjectId } from "mongodb";
import { closeDatabase, connectDatabase } from "../src/lib/database.js";
import { checkWritingTranslation, generateWritingExercise, writingExercise } from "../src/features/writing/writing.service.js";
import { validateSentence } from "../src/features/writing/validation.js";

assert.match(process.env.MONGODB_URI ?? "", /^mongodb:\/\/127\.0\.0\.1:27019\//, "Live smoke tests require the temporary local test database");
assert.ok(process.env.OPENAI_API_KEY, "Configure the provider key before this optional paid test");
const db = await connectDatabase(), userId = new ObjectId(), wordIds: ObjectId[] = [], relationIds: ObjectId[] = [], report: any[] = [];
const vocabulary = [["Brot", "pan", "A1.1"], ["Milch", "leche", "A1.1"], ["schweigen", "guardar silencio, callar", "B2.1"],
  ["etwas mit etwas vergleichen", "comparar algo con algo", "A2.1"], ["feststellen", "constatar", "B1.2"], ["damit", "para que", "A2.1"]] as const;
async function wait(id: string, assessment = false) {
  const until = Date.now() + 300000;
  while (Date.now() < until) {
    const exercise = await writingExercise(userId, new ObjectId(id)), job = assessment ? exercise.lastAttempt : exercise;
    if (job?.status === "READY") return exercise;
    if (job?.status === "FAILED") throw new Error(job.error);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Live exercise timed out");
}
try {
  for (const [german, spanish, cefrLevel] of vocabulary) {
    const de = new ObjectId(), es = new ObjectId(), relation = new ObjectId(); wordIds.push(de, es); relationIds.push(relation);
    const data = { gramaticalCategories: [], examples: [], contexts: [], cefrLevel, createdAt: new Date() };
    await db.wordsDE.insertOne({ ...data, _id: de, word: german }); await db.wordsES.insertOne({ ...data, _id: es, word: spanish });
    await db.relationsWordsEsDe.insertOne({ _id: relation, main: es, translated: de, createdAt: new Date() });
    await db.progress.insertOne({ _id: new ObjectId(), userId, itemId: relation, itemType: "WORD", failureIndex: 2, ease: 2.5, interval: 10, repetitions: 4, nextDueDate: new Date(), lastReviewed: new Date(), createdAt: new Date() });
  }
  const levels = process.argv.includes("--c2-only") ? ["C2"] : ["A1", "A2", "C2"];
  for (const level of levels) {
    const ids = (level === "C2" ? relationIds.slice(2) : relationIds.slice(0, 2)).map(String);
    const started = await generateWritingExercise(userId, level, randomUUID(), "DIFFICULT", ids);
    await wait(started.id);
    const stored = await db.writingExercises.findOne({ _id: new ObjectId(started.id) });
    validateSentence(stored.sentence, stored.words, [15,30], level === "A1");
    report.push({ level, model: stored.model, words: stored.words, sentence: stored.sentence });
    console.log(JSON.stringify({ status: "PASS live generation", level, germanWords: stored.sentence.germanWordCount, spanishWords: stored.sentence.spanishWordCount, clauseOrder: stored.sentence.clauseOrder, targets: stored.words.length }));
    if (level === "A1" || level === "C2") {
      await checkWritingTranslation(userId, stored._id, stored.sentence.german, randomUUID());
      const checked = await wait(started.id, true);
      report.at(-1).feedback = checked.lastAttempt.feedback;
      assert.equal(checked.lastAttempt.feedback.correct, true); assert.equal(checked.reinforced, true);
      console.log(`PASS live ${level} assessment and durable reinforcement`);
    }
  }
} finally {
  await mkdir("../.local/writing-tests", { recursive: true, mode: 0o700 });
  await writeFile(`../.local/writing-tests/a1-a2-c2-live-${Date.now()}.json`, JSON.stringify({ checkedAt: new Date().toISOString(), report, attempts: await db.writingAttempts.find({ userId }).toArray() }, null, 2), { mode: 0o600 });
  await db.writingAttempts.deleteMany({ userId }); await db.writingExercises.deleteMany({ userId }); await db.progress.deleteMany({ userId });
  await db.relationsWordsEsDe.deleteMany({ _id: { $in: relationIds } }); await db.wordsDE.deleteMany({ _id: { $in: wordIds } }); await db.wordsES.deleteMany({ _id: { $in: wordIds } }); await closeDatabase();
}
