import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { ObjectId } from "mongodb";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { typeDefs, resolvers } from "../src/graphql/schema.js";
import { validateSentence, validateWritingFeedback, sentenceWordCount } from "../src/features/writing/validation.js";

const live = process.argv.includes("--live"), requests: any[] = [];
let invalidSentence = false, invalidFeedback = false;
const mainClause = "Der erfahrene Bürgermeister übernimmt trotz erheblicher Zweifel an der gemeinsamen Entscheidung persönlich die Verantwortung für eine gerechtere Zukunft unserer Stadt";
const subordinateClause = "weil das Vertrauen der Bürger in seine ehrlichen Versprechen nach den vergangenen schwierigen Monaten besonders stark gelitten hat";
const german = `${mainClause}, ${subordinateClause}.`;
const spanish = "El alcalde experimentado asume personalmente la responsabilidad de un futuro más justo para nuestra ciudad pese a sus considerables dudas sobre la decisión conjunta, porque la confianza de los ciudadanos en sus promesas sinceras ha sufrido especialmente tras los difíciles meses pasados.";
const provider = live ? null : http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body), input = JSON.parse(request.input); requests.push(request);
  assert.equal(request.model, "gpt-6-luna"); assert.equal(request.reasoning.effort, "high"); assert.equal(request.store, false); assert.equal(request.text.format.strict, true);
  let result: any;
  if (request.text.format.name === "writing_sentence") {
    result = { title: "Una decisión responsable", spanish, german, mainClause, subordinateClause, clauseOrder: "MAIN_FIRST", connector: "weil", grammarExplanation: "Weil introduce una causa; el verbo conjugado se coloca al final del Nebensatz.",
      vocabulary: input.vocabulary.map((w: any) => ({ wordId: w.id, surfaceForms: [w.german], example: german })) };
    if (invalidSentence) result.german = "Zu kurz.";
  } else if (request.text.format.name === "writing_feedback") {
    const correct = input.learnerTranslation === input.germanReference;
    result = { correct, score: correct ? 100 : 85, summary: correct ? "La traducción es correcta." : "Revisa la concordancia verbal.", correctedGerman: input.germanReference,
      corrections: correct ? [] : [{ original: invalidFeedback ? "invented words" : "übernehmen", corrected: "übernimmt", explanation: "El sujeto singular requiere la tercera persona singular.", category: "VERB_POSITION" }],
      alternatives: correct ? [input.germanReference.replace("erfahrene Bürgermeister", "routinierte Bürgermeister")] : [] };
  } else result = { german: "die Verantwortung", explanation: "La responsabilidad asumida por el alcalde." };
  await new Promise(r => setTimeout(r, 50));
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] }));
});
if (provider) {
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(provider.address() as any).port}/v1`;
} else assert.ok(process.env.OPENAI_API_KEY && (!process.env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL === "https://api.openai.com/v1"));
const db = await connectDatabase(), userId = new ObjectId(), otherId = new ObjectId(), wordIds: ObjectId[] = [], relationIds: ObjectId[] = [];
const schema = makeExecutableSchema({ typeDefs, resolvers }), owner = { _id: userId };
const fields = `id requestId level status error sentence { title spanish german mainClause subordinateClause connector grammarExplanation spanishWordCount germanWordCount } words { id german spanish } lastAttempt { id requestId translation status error feedback { correct score summary correctedGerman corrections { original corrected explanation category } alternatives } }`;
async function call(source: string, variables: any = {}, user: any = owner) {
  const result = await graphql({ schema, source, variableValues: variables, contextValue: { user } });
  if (result.errors) throw new Error(result.errors.map(e => e.message).join("; "));
  return result.data as any;
}
const generate = async (requestId: string, level = "C1") => (await call(`mutation($requestId: String!, $level: String!) { generateWritingExercise(requestId: $requestId, level: $level) { ${fields} } }`, { requestId, level })).generateWritingExercise;
const get = async (id: string, user: any = owner) => (await call(`query($id: ID!) { writingExercise(id: $id) { ${fields} } }`, { id }, user)).writingExercise;
const check = async (exerciseId: string, translation: string, requestId: string, user: any = owner) => (await call(`mutation($exerciseId: ID!, $translation: String!, $requestId: String!) { checkWritingTranslation(exerciseId: $exerciseId, translation: $translation, requestId: $requestId) { id status } }`, { exerciseId, translation, requestId }, user)).checkWritingTranslation;
const hint = async (exerciseId: string, word: string, user: any = owner) => (await call(`mutation($exerciseId: ID!, $word: String!) { translateWritingWord(exerciseId: $exerciseId, word: $word) { word status error german explanation } }`, { exerciseId, word }, user)).translateWritingWord;
async function waitFor(fetch: () => Promise<any>, checking = false, failed = false) {
  const start = Date.now();
  while (Date.now() - start < (live ? 300000 : 30000)) {
    const result = await fetch(), job = checking ? result.lastAttempt : result;
    if (job?.status === (failed ? "FAILED" : "READY")) return result;
    if (!failed && job?.status === "FAILED") throw new Error(job.error);
    await new Promise(r => setTimeout(r, live ? 2000 : 100));
  }
  throw new Error("Writing operation timed out");
}
try {
  for (const [deWord, esWord] of [["Entscheidung", "decisión"], ["Verantwortung", "responsabilidad"], ["Vertrauen", "confianza"], ["Zukunft", "futuro"]]) {
    const de = new ObjectId(), es = new ObjectId(), relation = new ObjectId(); wordIds.push(de, es); relationIds.push(relation);
    const data = { gramaticalCategories: [], examples: [], contexts: [], createdAt: new Date() };
    await db.wordsDE.insertOne({ ...data, _id: de, word: deWord }); await db.wordsES.insertOne({ ...data, _id: es, word: esWord });
    await db.relationsWordsEsDe.insertOne({ _id: relation, main: es, translated: de, createdAt: new Date() });
    await db.progress.insertOne({ _id: new ObjectId(), userId, itemId: relation, itemType: "WORD", failureIndex: 2, interval: 5, ease: 2.5, repetitions: 3, nextDueDate: new Date(), lastReviewed: new Date(), createdAt: new Date() });
  }
  const cardsBefore = await db.progress.find({ userId }).toArray();
  const requestId = randomUUID(), starts = await Promise.all(Array.from({ length: 4 }, () => generate(requestId)));
  assert.equal(new Set(starts.map(s => s.id)).size, 1);
  const ready = await waitFor(() => get(starts[0].id)), id = ready.id;
  assert.ok(ready.sentence.spanishWordCount >= 30 && ready.sentence.spanishWordCount <= 50);
  assert.ok(ready.sentence.germanWordCount >= 30 && ready.sentence.germanWordCount <= 50);
  assert.equal(ready.sentence.german, null); assert.equal(ready.sentence.grammarExplanation, null);
  const stored = await db.writingExercises.findOne({ _id: new ObjectId(id) });
  validateSentence(stored!.sentence, stored!.words); assert.equal(stored!.words.length, 4);
  await generate(requestId); if (!live) assert.equal(requests.length, 1);
  assert.equal(await get(id, { _id: otherId }), null); await assert.rejects(() => get(id, null), /Unauthorized/);
  await assert.rejects(() => generate(requestId, "B2"), /different difficulty/);
  await assert.rejects(() => generate(randomUUID(), "A1"), /B2 or C1/);
  console.log(`PASS ${live ? "live Luna 6/high" : "fixture"} sentence: both languages 30–50 words, complete vocabulary, persisted/idempotent generation, hidden solution, account protection`);
  const answer = stored!.sentence!.german, attemptId = randomUUID();
  const submissions = await Promise.all(Array.from({ length: 4 }, () => check(id, answer, attemptId)));
  assert.equal(new Set(submissions.map(s => s.id)).size, 1);
  const correct = await waitFor(() => get(id), true);
  assert.equal(correct.lastAttempt.feedback.correct, true); assert.equal(correct.lastAttempt.feedback.corrections.length, 0);
  assert.ok(correct.lastAttempt.feedback.alternatives.length >= 1 && correct.lastAttempt.feedback.alternatives.length <= 2);
  assert.equal(correct.sentence.german, answer);
  await check(id, answer, attemptId); if (!live) assert.equal(requests.length, 2);
  await assert.rejects(() => check(id, answer + " altered", attemptId), /different translation/);
  await assert.rejects(() => check(id, answer, randomUUID(), { _id: otherId }), /not found/);
  await assert.rejects(() => check(id, " ", randomUUID()), /Enter your German/);
  console.log("PASS faithful German accepted, 1–2 alternatives, durable feedback, repeated submissions reuse one assessment");
  const badAnswer = live ? "Der Bürgermeister übernehmen kein Verantwortung. Alles ist einfach, weil gibt es kein Problem und jeder ist froh." : answer.replace("übernimmt", "übernehmen");
  await check(id, badAnswer, randomUUID()); const incorrect = await waitFor(() => get(id), true);
  assert.equal(incorrect.lastAttempt.feedback.correct, false); assert.ok(incorrect.lastAttempt.feedback.corrections.length); assert.equal(incorrect.lastAttempt.feedback.alternatives.length, 0);
  validateWritingFeedback(incorrect.lastAttempt.feedback, badAnswer);
  const spanishWord = live ? stored!.sentence!.spanish.split(/\s+/u).find(w => /responsabilidad/iu.test(w))! : "responsabilidad";
  assert.ok(spanishWord, "The target noun appears in the Spanish source");
  await Promise.all(Array.from({ length: 4 }, () => hint(id, spanishWord)));
  const translated = await waitFor(() => hint(id, spanishWord)); assert.ok(translated.german); assert.ok(translated.explanation);
  await hint(id, spanishWord); if (!live) assert.equal(requests.length, 4);
  await assert.rejects(() => hint(id, "a_word_missing_from_the_source"), /Select a Spanish word/);
  await assert.rejects(() => hint(id, spanishWord, { _id: otherId }), /not found/);
  assert.deepEqual(await db.progress.find({ userId }).toArray(), cardsBefore);
  console.log("PASS mistakes explained in Spanish, contextual noun hint cached across retries, original SRS and failure counts preserved");
  if (!live) {
    invalidSentence = true;
    const badRequest = randomUUID(), started = await generate(badRequest);
    await waitFor(() => get(started.id), false, true); invalidSentence = false; await generate(badRequest); await waitFor(() => get(started.id));
    invalidFeedback = true; const retryId = randomUUID(); await check(id, badAnswer, retryId); await waitFor(() => get(id), true, true);
    invalidFeedback = false; await check(id, badAnswer, retryId); await waitFor(() => get(id), true);
    const expired = new ObjectId(); await db.writingAttempts.insertOne({ _id: expired, userId, exerciseId: new ObjectId(id), requestId: randomUUID(), translation: answer, status: "CHECKING", lockedUntil: new Date(0), createdAt: new Date(), updatedAt: new Date() });
    assert.equal((await get(id)).lastAttempt.status, "FAILED");
    delete process.env.OPENAI_API_KEY; assert.equal((await generate(requestId)).status, "READY"); assert.equal((await hint(id, spanishWord)).status, "READY");
    console.log("PASS malformed AI output rejected, retries preserve jobs, interrupted assessments expire, saved work available without provider key");
  } else {
    await mkdir("../.local/writing-tests", { recursive: true, mode: 0o700 });
    await writeFile("../.local/writing-tests/live-writing.json", JSON.stringify({ model: "gpt-6-luna", effort: "high", verifiedAt: new Date().toISOString(), words: stored!.words, sentence: stored!.sentence, correctFeedback: correct.lastAttempt.feedback, incorrectTranslation: badAnswer, incorrectFeedback: incorrect.lastAttempt.feedback, hint: translated }, null, 2), { mode: 0o600 });
    console.log(`PASS live sample saved privately (${sentenceWordCount(answer)} German words)`);
  }
} finally {
  await db.writingHints.deleteMany({ userId }); await db.writingAttempts.deleteMany({ userId }); await db.writingExercises.deleteMany({ userId }); await db.progress.deleteMany({ userId });
  await db.relationsWordsEsDe.deleteMany({ _id: { $in: relationIds } }); await db.wordsDE.deleteMany({ _id: { $in: wordIds } }); await db.wordsES.deleteMany({ _id: { $in: wordIds } });
  await closeDatabase(); if (provider) await new Promise<void>(r => provider.close(() => r()));
}
