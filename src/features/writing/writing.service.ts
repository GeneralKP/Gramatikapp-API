import { createHash, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { isReadingConfigured, requestStructured } from "../reading/openai.js";
import { READING_MODEL } from "../reading/prompts.js";
import type { SessionVocabulary } from "../reading/reading.types.js";
import type { WritingAttempt, WritingExercise, WritingHint } from "./writing.types.js";
import { HINT_INSTRUCTIONS, HINT_SCHEMA, SENTENCE_INSTRUCTIONS, SENTENCE_SCHEMA, WRITING_FEEDBACK_INSTRUCTIONS, WRITING_FEEDBACK_SCHEMA, WRITING_PROMPT_VERSION } from "./prompts.js";
import { containsTerm, normalizedText, validateSentence, validateWritingFeedback } from "./validation.js";

const LEASE_MS = 5 * 60000;
const commandId = (id: string) => { if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw new Error("Invalid request ID"); };
const message = (error: unknown) => error instanceof Error ? error.message : "This exercise could not be completed. Your work is saved; retry.";
const requireConfiguration = () => { if (!isReadingConfigured()) throw new Error("Writing practice needs OPENAI_API_KEY in the server environment."); };
async function expire(userId: ObjectId) {
  const db = getDb(), now = new Date();
  for (const [collection, status] of [[db.writingExercises, "GENERATING"], [db.writingAttempts, "CHECKING"], [db.writingHints, "GENERATING"]] as const) {
    await collection.updateMany({ userId, status, lockedUntil: { $lte: now } }, { $set: { status: "FAILED", error: "The request was interrupted. Your work is saved; retry.", updatedAt: now } });
  }
}
export const writingAttemptForClient = (attempt: WritingAttempt) => ({ id: attempt._id.toString(), requestId: attempt.requestId, translation: attempt.translation,
  status: attempt.status, error: attempt.error ?? null, feedback: attempt.feedback ?? null });
export async function writingExerciseForClient(exercise: WritingExercise) {
  const db = getDb(), filter = { userId: exercise.userId, exerciseId: exercise._id };
  const [lastAttempt, completed] = await Promise.all([
    db.writingAttempts.findOne(filter, { sort: { createdAt: -1, _id: -1 } }),
    db.writingAttempts.findOne({ ...filter, status: "READY" }, { projection: { _id: 1 } }),
  ]);
  const unlocked = !!completed;
  return { id: exercise._id.toString(), requestId: exercise.requestId, level: exercise.level, model: exercise.model, status: exercise.status, error: exercise.error ?? null,
    words: exercise.words, createdAt: exercise.createdAt.toISOString(), lastAttempt: lastAttempt ? writingAttemptForClient(lastAttempt) : null,
    sentence: exercise.sentence ? { ...exercise.sentence, german: unlocked ? exercise.sentence.german : null,
      mainClause: unlocked ? exercise.sentence.mainClause : null, subordinateClause: unlocked ? exercise.sentence.subordinateClause : null,
      grammarExplanation: unlocked ? exercise.sentence.grammarExplanation : null, vocabulary: unlocked ? exercise.sentence.vocabulary : [] } : null };
}
export async function writingPractice(userId: ObjectId) {
  await expire(userId);
  const exercise = await getDb().writingExercises.findOne({ userId }, { sort: { createdAt: -1, _id: -1 } });
  return { configured: isReadingConfigured(), exercise: exercise ? await writingExerciseForClient(exercise) : null };
}
export async function writingExercise(userId: ObjectId, id: ObjectId) {
  await expire(userId);
  const exercise = await getDb().writingExercises.findOne({ _id: id, userId });
  return exercise ? writingExerciseForClient(exercise) : null;
}
async function chooseWords(userId: ObjectId, seed: ObjectId): Promise<SessionVocabulary[]> {
  const db = getDb();
  const progress = await db.progress.find({ userId, itemType: "WORD", suspended: { $ne: true }, supersededByAnki: { $ne: true }, lastReviewed: { $ne: null } }).sort({ lastReviewed: -1, failureIndex: -1 }).limit(180).toArray();
  const relationIds = [...new Map(progress.map(p => { const id = p.relationId ?? p.itemId; return [id.toString(), id] as const; })).values()];
  let relations = relationIds.length ? await db.relationsWordsEsDe.find({ _id: { $in: relationIds } }).toArray() : [];
  if (relations.length < 4) relations = await db.relationsWordsEsDe.aggregate<any>([{ $sample: { size: 80 } }]).toArray();
  const [german, spanish] = await Promise.all([
    db.wordsDE.find({ _id: { $in: relations.map(r => r.translated) } }).toArray(), db.wordsES.find({ _id: { $in: relations.map(r => r.main) } }).toArray(),
  ]);
  const words: SessionVocabulary[] = [];
  for (const relation of relations) {
    const de = german.find(w => w._id.equals(relation.translated)), es = spanish.find(w => w._id.equals(relation.main));
    if (!de?.word || !es?.word || de.word.length > 80 || de.word.trim().split(/\s+/u).length > 6) continue;
    words.push({ id: relation._id.toString(), german: de.word, spanish: es.word,
      forms: Object.fromEntries(Object.entries(de.forms ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")), notes: de.notes ?? "",
      failureIndex: progress.filter(p => (p.relationId ?? p.itemId).equals(relation._id)).reduce((sum, p) => sum + (p.failureIndex ?? 0), 0) });
  }
  if (words.length < 3) throw new Error("Add at least three German-Spanish vocabulary entries before generating a sentence.");
  const rank = (w: SessionVocabulary) => createHash("sha256").update(`${seed}:${w.id}`).digest("hex");
  return words.sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, Math.min(4, words.length));
}
export async function generateWritingExercise(userId: ObjectId, level: string, requestId: string) {
  commandId(requestId);
  if (!["B2", "C1"].includes(level)) throw new Error("Choose B2 or C1");
  const db = getDb();
  let exercise = await db.writingExercises.findOne({ userId, requestId });
  if (exercise && exercise.level !== level) throw new Error("This request ID belongs to a different difficulty.");
  if (exercise?.status === "READY") return writingExerciseForClient(exercise);
  requireConfiguration();
  if (!exercise) {
    const now = new Date(), id = new ObjectId();
    const created: WritingExercise = { _id: id, userId, requestId, level: level as "B2" | "C1", words: await chooseWords(userId, id), status: "FAILED",
      model: READING_MODEL, promptVersion: WRITING_PROMPT_VERSION, createdAt: now, updatedAt: now };
    try { await db.writingExercises.updateOne({ userId, requestId }, { $setOnInsert: created }, { upsert: true }); }
    catch (error: any) { if (error.code !== 11000) throw error; }
    exercise = await db.writingExercises.findOne({ userId, requestId });
    if (exercise.level !== level) throw new Error("This request ID belongs to a different difficulty.");
  }
  const now = new Date(), token = randomUUID();
  const claimed = await db.writingExercises.findOneAndUpdate({ _id: exercise._id, $or: [{ status: "FAILED" }, { status: "GENERATING", lockedUntil: { $lte: now } }] },
    { $set: { status: "GENERATING", error: null, generationToken: token, lockedUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now } }, { returnDocument: "after" });
  if (claimed) void generateSentence(claimed, token).catch(() => console.error("Writing generation state could not be saved; its lease will expire."));
  return writingExerciseForClient(claimed ?? exercise);
}
async function generateSentence(exercise: WritingExercise, token: string) {
  const db = getDb(), filter = { _id: exercise._id, generationToken: token, status: "GENERATING" as const };
  try {
    const value = await requestStructured(SENTENCE_INSTRUCTIONS, JSON.stringify({ level: exercise.level, vocabulary: exercise.words }), "writing_sentence", SENTENCE_SCHEMA);
    const sentence = validateSentence(value, exercise.words);
    await db.writingExercises.updateOne(filter, { $set: { sentence, status: "READY", updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } });
  } catch (error) { await db.writingExercises.updateOne(filter, { $set: { status: "FAILED", error: message(error), updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } }); }
}
export async function checkWritingTranslation(userId: ObjectId, exerciseId: ObjectId, translation: string, requestId: string) {
  commandId(requestId);
  if (!translation.trim() || translation.length > 5000) throw new Error("Enter your German translation (up to 5000 characters).");
  const db = getDb(), exercise = await db.writingExercises.findOne({ _id: exerciseId, userId, status: "READY" });
  if (!exercise?.sentence) throw new Error("Writing exercise not found or not ready");
  let attempt = await db.writingAttempts.findOne({ userId, requestId });
  const matches = (a: WritingAttempt) => a.exerciseId.equals(exerciseId) && a.translation === translation;
  if (attempt && !matches(attempt)) throw new Error("This request ID belongs to a different translation.");
  if (attempt?.status === "READY") return writingAttemptForClient(attempt);
  requireConfiguration();
  if (!attempt) {
    const now = new Date(), created: WritingAttempt = { _id: new ObjectId(), userId, exerciseId, requestId, translation, status: "FAILED", createdAt: now, updatedAt: now };
    try { await db.writingAttempts.updateOne({ userId, requestId }, { $setOnInsert: created }, { upsert: true }); }
    catch (error: any) { if (error.code !== 11000) throw error; }
    attempt = await db.writingAttempts.findOne({ userId, requestId });
    if (!matches(attempt)) throw new Error("This request ID belongs to a different translation.");
  }
  const now = new Date(), token = randomUUID();
  const claimed = await db.writingAttempts.findOneAndUpdate({ _id: attempt._id, $or: [{ status: "FAILED" }, { status: "CHECKING", lockedUntil: { $lte: now } }] },
    { $set: { status: "CHECKING", error: null, generationToken: token, lockedUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now } }, { returnDocument: "after" });
  if (claimed) void checkTranslation(claimed, exercise, token).catch(() => console.error("Writing feedback could not be saved; its lease will expire."));
  return writingAttemptForClient(claimed ?? attempt);
}
async function checkTranslation(attempt: WritingAttempt, exercise: WritingExercise, token: string) {
  const db = getDb(), filter = { _id: attempt._id, generationToken: token, status: "CHECKING" as const };
  try {
    const value = await requestStructured(exercise.promptVersion < 3 ? WRITING_FEEDBACK_INSTRUCTIONS.replaceAll("15–30", "30–50") : WRITING_FEEDBACK_INSTRUCTIONS, JSON.stringify({ level: exercise.level, spanishOriginal: exercise.sentence!.spanish, germanReference: exercise.sentence!.german, learnerTranslation: attempt.translation }), "writing_feedback", WRITING_FEEDBACK_SCHEMA);
    const feedback = validateWritingFeedback(value, attempt.translation, exercise.promptVersion < 3 ? [30,50] : [15,30]);
    await db.writingAttempts.updateOne(filter, { $set: { status: "READY", feedback, updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } });
  } catch (error) { await db.writingAttempts.updateOne(filter, { $set: { status: "FAILED", error: message(error), updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } }); }
}
const hintForClient = (hint: WritingHint) => ({ word: hint.word, status: hint.status, german: hint.german ?? null, explanation: hint.explanation ?? null, error: hint.error ?? null });
async function hintContext(userId: ObjectId, exerciseId: ObjectId, rawWord: string) {
  const exercise = await getDb().writingExercises.findOne({ _id: exerciseId, userId, status: "READY" });
  if (!exercise?.sentence) throw new Error("Writing exercise not found or not ready");
  const word = normalizedText(rawWord).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLocaleLowerCase("es");
  if (!word || word.length > 100 || !containsTerm(exercise.sentence.spanish, word)) throw new Error("Select a Spanish word from this exercise.");
  return { word, exercise };
}
export async function writingWordHint(userId: ObjectId, exerciseId: ObjectId, word: string) {
  const context = await hintContext(userId, exerciseId, word);
  await expire(userId);
  const hint = await getDb().writingHints.findOne({ userId, exerciseId, word: context.word });
  return hint ? hintForClient(hint) : null;
}
export async function translateWritingWord(userId: ObjectId, exerciseId: ObjectId, rawWord: string) {
  const { word, exercise } = await hintContext(userId, exerciseId, rawWord), db = getDb();
  let hint = await db.writingHints.findOne({ userId, exerciseId, word });
  if (hint?.status === "READY") return hintForClient(hint);
  requireConfiguration();
  if (!hint) {
    const now = new Date(), created: WritingHint = { _id: new ObjectId(), userId, exerciseId, word, status: "FAILED", createdAt: now, updatedAt: now };
    try { await db.writingHints.updateOne({ userId, exerciseId, word }, { $setOnInsert: created }, { upsert: true }); }
    catch (error: any) { if (error.code !== 11000) throw error; }
    hint = await db.writingHints.findOne({ userId, exerciseId, word });
  }
  const now = new Date(), token = randomUUID();
  const claimed = await db.writingHints.findOneAndUpdate({ _id: hint._id, $or: [{ status: "FAILED" }, { status: "GENERATING", lockedUntil: { $lte: now } }] },
    { $set: { status: "GENERATING", error: null, generationToken: token, lockedUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now } }, { returnDocument: "after" });
  if (claimed) void generateHint(claimed, exercise, token).catch(() => console.error("A word hint could not be saved; its lease will expire."));
  return hintForClient(claimed ?? hint);
}
async function generateHint(hint: WritingHint, exercise: WritingExercise, token: string) {
  const db = getDb(), filter = { _id: hint._id, generationToken: token, status: "GENERATING" as const };
  try {
    const value = await requestStructured(HINT_INSTRUCTIONS, JSON.stringify({ spanishSentence: exercise.sentence!.spanish, selectedWord: hint.word }), "writing_word_hint", HINT_SCHEMA) as any;
    if (typeof value?.german !== "string" || !value.german.trim() || value.german.length > 200 || typeof value.explanation !== "string" || !value.explanation.trim() || value.explanation.length > 1500) throw new Error("The word hint was incomplete. Retry the lookup.");
    await db.writingHints.updateOne(filter, { $set: { german: value.german.trim(), explanation: value.explanation.trim(), status: "READY", updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } });
  } catch (error) { await db.writingHints.updateOne(filter, { $set: { status: "FAILED", error: message(error), updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } }); }
}
