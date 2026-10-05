import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ObjectId } from "mongodb";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { generateToken } from "../src/features/auth/auth.service.js";
import { defaultUserSettings } from "../src/features/auth/auth.types.js";
import { PROMPT_VERSION } from "../src/features/reading/prompts.js";
import { validatePage } from "../src/features/reading/validation.js";

// Optional paid smoke test. Only temporary records are written to the database.
assert.ok(process.env.OPENAI_API_KEY?.trim(), "Configure the server's OPENAI_API_KEY first.");
assert.ok(!process.env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL === "https://api.openai.com/v1", "This test requires the real OpenAI provider.");
const api = process.env.READING_TEST_API_URL || "http://localhost:4000/graphql";
const db = await connectDatabase(), userId = new ObjectId();
const vocabularyIds: ObjectId[] = [], relationIds: ObjectId[] = [];
const user = { _id: userId, email: `reading-live-${randomUUID()}@example.invalid`, authProvider: "email" as const, settings: { ...defaultUserSettings }, createdAt: new Date() };
const token = generateToken(user);
const fields = `id status error model words { id german spanish } pages { index title german spanish wordCount vocabulary { wordId surfaceForms example } lastAttempt { status error translation feedback { score summary correctedSpanish corrections { original corrected explanation category } omissions { german explanation } vocabulary { wordId understood feedback } } } }`;
async function call(query: string, variables = {}) {
  const response = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
  if (!response.ok) throw new Error(`Local reading API returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.errors) throw new Error(result.errors.map((error: any) => error.message).join("; "));
  return result.data;
}
async function waitForLesson(id: string, checking = false) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const lesson = (await call(`query($id: ID!) { readingLesson(id: $id) { ${fields} } }`, { id })).readingLesson;
    assert.ok(lesson, "Saved lesson must belong to the temporary account.");
    const job = checking ? lesson.pages[0]?.lastAttempt : lesson;
    if (job?.status === "FAILED") throw new Error(job.error || "The live reading operation failed.");
    if (job?.status === "READY") return lesson;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error("Timed out waiting for the live reading operation.");
}
function agreementError(text: string) {
  const plural = text.replace(/(\b(?:los|las)\s+[\p{L}\p{M}]+\s+)(estaban|esperaban|habían|tenían|eran|querían|podían|hacían|sabían|miraban|decían|vivían|llegaban|hablaban|guardaban)\b/iu, (_match, subject, verb) => subject + verb.slice(0, -1));
  if (plural !== text) return plural;
  const singular = text.replace(/(\b(?:el|la)\s+[\p{L}\p{M}]+\s+)(estaba|esperaba|había|tenía|era|quería|podía|hacía|sabía|miraba|decía|vivía|llegaba|hablaba|guardaba|seguía)\b/iu, (_match, subject, verb) => subject + verb + "n");
  assert.notEqual(singular, text, "The live fixture needs a separate, unambiguous agreement error.");
  return singular;
}
try {
  await db.users.insertOne(user);
  const terms = [
    ["schweigen", "callar", "Präteritum: schwieg; Perfekt: hat geschwiegen"],
    ["etwas mit etwas vergleichen", "comparar algo con algo", "Verglich; hat verglichen. Keep the comparison construction."],
    ["feststellen", "constatar", "Separable verb: stellte fest; hat festgestellt"],
    ["entfernen", "retirar", "Use the sense of removing something, not distance."],
    ["die Verantwortung", "la responsabilidad", "Feminine noun"],
    ["die Voraussetzung", "el requisito", "Feminine noun; plural Voraussetzungen"],
    ["das Missverständnis", "el malentendido", "Neuter noun; plural Missverständnisse"],
    ["die Zuversicht", "la confianza en un resultado favorable", "Optimistic confidence rather than trust in a person."],
    ["in Kauf nehmen", "aceptar un inconveniente", "Idiomatic expression; nahm in Kauf; hat in Kauf genommen"],
    ["angesichts", "ante", "Preposition with genitive"],
    ["nachvollziehbar", "comprensible", "A reason or decision can be nachvollziehbar."],
    ["sich mit etwas auseinandersetzen", "abordar un tema en profundidad", "Separable reflexive verb with mit + dative"],
  ];
  for (const [index, [german, spanish, notes]] of terms.entries()) {
    const de = new ObjectId(), es = new ObjectId(), relation = new ObjectId(), itemId = new ObjectId();
    vocabularyIds.push(de, es); relationIds.push(relation);
    const word = { gramaticalCategories: [], examples: [], contexts: [], createdAt: new Date() };
    await db.wordsDE.insertOne({ ...word, _id: de, word: german, notes });
    await db.wordsES.insertOne({ ...word, _id: es, word: spanish });
    await db.relationsWordsEsDe.insertOne({ _id: relation, main: es, translated: de, createdAt: new Date() });
    await db.progress.insertOne({ _id: new ObjectId(), userId, itemId, relationId: relation, itemType: "WORD", failureIndex: index % 4, interval: 1, ease: 2.5, repetitions: 1, nextDueDate: new Date(), lastReviewed: new Date(), createdAt: new Date() });
    await db.reviewEvents.insertOne({ _id: new ObjectId(), userId, itemId, itemType: "WORD", reviewId: randomUUID(), reviewedAt: new Date(Date.now() - 3 * 3600000 + index * 60000), reversedAt: null } as any);
  }
  const practice = (await call(`query { readingPractice { configured model session { id startedAt endedAt words { id german spanish failureIndex } } } }`)).readingPractice;
  assert.equal(practice.configured, true);
  assert.equal(practice.model, "gpt-6-luna");
  assert.equal(practice.session.words.length, terms.length);
  if (process.argv.includes("--reuse-generation")) {
    const cached = JSON.parse(await readFile("../.local/reading-tests/live-generation-replay.json", "utf8"));
    const targetIds = new Map(cached.words.map((word: any) => [word.id, practice.session.words.find((target: any) => target.german === word.german && target.spanish === word.spanish)?.id]));
    const value = { ...cached.value, vocabulary: cached.value.vocabulary.map((usage: any) => ({ ...usage, wordId: targetIds.get(usage.wordId) })) };
    const page = validatePage(value, practice.session.words, 0), now = new Date();
    await db.readingLessons.insertOne({ _id: new ObjectId(), userId, sessionId: practice.session.id,
      sessionStartedAt: new Date(practice.session.startedAt), sessionEndedAt: new Date(practice.session.endedAt), words: practice.session.words,
      pageCount: 1, pages: [page], status: "READY", model: "gpt-6-luna", promptVersion: PROMPT_VERSION, createdAt: now, updatedAt: now });
    console.log("LIVE reusing and validating the captured real Luna generation; no new generation charge…");
  } else console.log(`LIVE generating a C1 page with all ${terms.length} words using Luna 6 / high…`);
  const started = (await call(`mutation($sessionId: ID!) { generateReadingLesson(sessionId: $sessionId) { id status } }`, { sessionId: practice.session.id })).generateReadingLesson;
  const ready = await waitForLesson(started.id), stored = await db.readingLessons.findOne({ _id: new ObjectId(started.id), userId });
  assert.equal(ready.model, "gpt-6-luna");
  assert.equal(ready.pages[0].spanish, null, "Reference must be hidden before checking.");
  assert.equal(ready.pages[0].vocabulary.length, terms.length);
  const page = stored!.pages[0];
  const firstSentenceEnd = page.spanish.search(/[.!?](?:\s|$)/u);
  assert.ok(firstSentenceEnd > 0, "The generated reference needs complete sentences.");
  // Deliberately replace the opening proposition and introduce Spanish agreement errors.
  const translation = agreementError("Los protagonista fueron feliz porque no ocurrió ningún problema y todo era fácil." + page.spanish.slice(firstSentenceEnd + 1));
  console.log(`LIVE generation passed (${page.wordCount} German words); checking a translation with deliberate mistakes…`);
  await call(`mutation($lessonId: ID!, $translation: String!, $requestId: String!) { checkReadingTranslation(lessonId: $lessonId, pageIndex: 0, translation: $translation, requestId: $requestId) { status } }`, { lessonId: started.id, translation, requestId: randomUUID() });
  const checked = await waitForLesson(started.id, true), feedback = checked.pages[0].lastAttempt.feedback;
  assert.equal(checked.pages[0].lastAttempt.translation, translation, "Feedback must preserve the user's draft.");
  assert.equal(checked.pages[0].spanish, page.spanish, "Successful feedback unlocks the stored reference.");
  assert.ok(feedback.score < 100, "Deliberately wrong work must not receive a perfect score.");
  assert.ok(feedback.corrections.some((correction: any) => correction.category === "GRAMMAR" || /concord|concuerd|plural/iu.test(correction.explanation)), "Spanish agreement errors should be identified, including when grouped with a meaning correction.");
  assert.ok(feedback.corrections.some((correction: any) => correction.category === "MEANING") || feedback.omissions.length > 0, "Invented opening meaning should be identified.");
  const alternatives = [
    ["Sin embargo,", "No obstante,"], ["sin embargo,", "no obstante,"],
    ["Por primera vez", "Por vez primera"], ["por primera vez", "por vez primera"],
    ["de inmediato", "inmediatamente"], ["en lugar de", "en vez de"],
    ["tal vez", "quizá"], ["a pesar de", "pese a"], ["de repente", "de pronto"],
  ];
  const faithfulTranslation = alternatives.reduce((text, [original, alternative]) => text.replace(original, alternative), page.spanish);
  console.log("LIVE checking faithful Spanish with equivalent wording…");
  await call(`mutation($lessonId: ID!, $translation: String!, $requestId: String!) { checkReadingTranslation(lessonId: $lessonId, pageIndex: 0, translation: $translation, requestId: $requestId) { status } }`, { lessonId: started.id, translation: faithfulTranslation, requestId: randomUUID() });
  const faithful = await waitForLesson(started.id, true), faithfulFeedback = faithful.pages[0].lastAttempt.feedback;
  assert.equal(faithful.pages[0].lastAttempt.translation, faithfulTranslation);
  assert.ok(faithfulFeedback.score >= 95, `Faithful Spanish should score at least 95; got ${faithfulFeedback.score}.`);
  const directory = resolve("../.local/reading-tests");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifact = resolve(directory, "live-luna-reading.json");
  await writeFile(artifact, JSON.stringify({ model: ready.model, effort: "high", promptVersion: PROMPT_VERSION, generationReused: process.argv.includes("--reuse-generation"), verifiedAt: new Date().toISOString(), words: stored!.words, page, submittedTranslation: translation, feedback, faithfulTranslation, faithfulFeedback }, null, 2) + "\n", { mode: 0o600 });
  console.log(`PASS live generation and corrections: ${terms.length}/${terms.length} vocabulary entries, ${page.wordCount} German words, ${feedback.corrections.length} corrections, score ${feedback.score}/100.`);
  console.log(`PASS faithful Spanish ${faithfulTranslation !== page.spanish ? "paraphrase" : "reference"}: ${faithfulFeedback.score}/100.`);
  console.log(`Review sample saved to ${artifact}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Live reading test failed.");
  process.exitCode = 1;
} finally {
  await db.translationAttempts.deleteMany({ userId });
  await db.readingLessons.deleteMany({ userId });
  await db.reviewEvents.deleteMany({ userId });
  await db.progress.deleteMany({ userId });
  await db.relationsWordsEsDe.deleteMany({ _id: { $in: relationIds } });
  await db.wordsDE.deleteMany({ _id: { $in: vocabularyIds } });
  await db.wordsES.deleteMany({ _id: { $in: vocabularyIds } });
  await db.users.deleteOne({ _id: userId });
  await closeDatabase();
}
