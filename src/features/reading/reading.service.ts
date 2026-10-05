import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import type { ReadingLesson, StudySession, SessionVocabulary, TranslationAttempt } from "./reading.types.js";
import { CORRECTION_INSTRUCTIONS, FEEDBACK_SCHEMA, GENERATION_INSTRUCTIONS, PAGE_SCHEMA, PROMPT_VERSION, READING_MODEL, WORDS_PER_PAGE, correctionInput, generationInput } from "./prompts.js";
import { isReadingConfigured, requestStructured } from "./openai.js";
import { validateFeedback, validatePage } from "./validation.js";

export const SESSION_BREAK_MS = 30 * 60000;
const LEASE_MS = 5 * 60000;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "This exercise could not be completed. Your work is saved; try again.";

/** Groups actual review activity; Undo does not undo having practiced a word. */
export async function lastCompletedSession(userId: ObjectId, now = new Date()): Promise<StudySession | null> {
  const cursor = getDb().reviewEvents.find({ userId }).sort({ reviewedAt: -1, _id: -1 });
  let current: StudySession | null = null;
  const eligible = () => current && current.itemIds.length && now.getTime() - current.endedAt.getTime() >= SESSION_BREAK_MS;
  try {
    for await (const event of cursor) {
      if (current && current.startedAt.getTime() - event.reviewedAt.getTime() > SESSION_BREAK_MS) {
        if (eligible()) return current;
        current = null;
      }
      if (!current) current = { id: event._id.toString(), startedAt: event.reviewedAt, endedAt: event.reviewedAt, itemIds: [], reviewCount: 0 };
      current.id = event._id.toString();
      current.startedAt = event.reviewedAt;
      current.reviewCount++;
      if (event.itemType === "WORD" && !current.itemIds.some(id => id.equals(event.itemId))) current.itemIds.push(event.itemId);
    }
    return eligible() ? current : null;
  } finally { await cursor.close(); }
}

async function sessionWords(userId: ObjectId, session: StudySession): Promise<SessionVocabulary[]> {
  const db = getDb();
  const progress = await db.progress.find({ userId, itemType: "WORD", itemId: { $in: session.itemIds } }).toArray();
  if (progress.length !== session.itemIds.length) throw new Error("Some words from this study session are unavailable. Restore the missing cards before generating the text.");
  const relationIds = [...new Map(progress.map(p => { const id = p.relationId ?? p.itemId; return [id.toString(), id] as const; })).values()];
  const relations = await db.relationsWordsEsDe.find({ _id: { $in: relationIds } }).toArray();
  const [german, spanish] = await Promise.all([
    db.wordsDE.find({ _id: { $in: relations.map(r => r.translated) } }).toArray(),
    db.wordsES.find({ _id: { $in: relations.map(r => r.main) } }).toArray(),
  ]);
  const words: SessionVocabulary[] = [];
  for (const relationId of relationIds.reverse()) {
    const relation = relations.find(r => r._id.equals(relationId));
    const de = german.find(w => w._id.equals(relation?.translated)), es = spanish.find(w => w._id.equals(relation?.main));
    if (!de?.word || !es?.word) throw new Error("A word from this session is missing its German or Spanish entry. No vocabulary has been omitted; repair the entry and retry.");
    words.push({ id: relationId.toString(), german: de.word, spanish: es.word,
      forms: Object.fromEntries(Object.entries(de.forms ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      notes: de.notes ?? "", failureIndex: progress.filter(p => (p.relationId ?? p.itemId).equals(relationId)).reduce((sum, p) => sum + (p.failureIndex ?? 0), 0) });
  }
  return words;
}

async function expireInterruptedWork(userId: ObjectId) {
  const now = new Date(), db = getDb();
  await Promise.all([
    db.readingLessons.updateMany({ userId, status: "GENERATING", lockedUntil: { $lte: now } }, { $set: { status: "FAILED", error: "Generation was interrupted. Your completed pages are saved; retry to continue.", updatedAt: now } }),
    db.translationAttempts.updateMany({ userId, status: "CHECKING", lockedUntil: { $lte: now } }, { $set: { status: "FAILED", error: "The check was interrupted. Your translation is saved; retry to continue.", updatedAt: now } }),
  ]);
}

export async function lessonForClient(lesson: ReadingLesson) {
  const attempts = await getDb().translationAttempts.find({ userId: lesson.userId, lessonId: lesson._id }).sort({ createdAt: -1, _id: -1 }).toArray();
  return { id: lesson._id.toString(), sessionId: lesson.sessionId, sessionStartedAt: lesson.sessionStartedAt.toISOString(), sessionEndedAt: lesson.sessionEndedAt.toISOString(),
    status: lesson.status, error: lesson.error ?? null, words: lesson.words, pageCount: lesson.pageCount, model: lesson.model,
    pages: lesson.pages.map(page => {
      const attempt = attempts.find(a => a.pageIndex === page.index);
      return { ...page, spanish: attempts.some(a => a.pageIndex === page.index && a.status === "READY") ? page.spanish : null,
        lastAttempt: attempt ? attemptForClient(attempt) : null };
    }) };
}
export const attemptForClient = (attempt: TranslationAttempt) => ({ id: attempt._id.toString(), requestId: attempt.requestId, pageIndex: attempt.pageIndex,
  translation: attempt.translation, status: attempt.status, error: attempt.error ?? null, feedback: attempt.feedback ?? null });

export async function readingPractice(userId: ObjectId) {
  await expireInterruptedWork(userId);
  const session = await lastCompletedSession(userId);
  const lesson = session ? await getDb().readingLessons.findOne({ userId, sessionId: session.id }) : null;
  const words = session ? lesson?.words ?? await sessionWords(userId, session) : [];
  return { configured: isReadingConfigured(), model: READING_MODEL,
    session: session ? { id: session.id, startedAt: session.startedAt.toISOString(), endedAt: session.endedAt.toISOString(), reviewCount: session.reviewCount, words } : null,
    lesson: lesson ? await lessonForClient(lesson) : null };
}

export async function getReadingLesson(userId: ObjectId, lessonId: ObjectId) {
  await expireInterruptedWork(userId);
  const lesson = await getDb().readingLessons.findOne({ _id: lessonId, userId });
  return lesson ? lessonForClient(lesson) : null;
}

export async function generateReadingLesson(userId: ObjectId, sessionId: string) {
  const db = getDb();
  let lesson = await db.readingLessons.findOne({ userId, sessionId });
  if (lesson?.status === "READY") return lessonForClient(lesson);
  if (!isReadingConfigured()) throw new Error("Reading practice needs OPENAI_API_KEY in the server environment.");
  if (!lesson) {
    const session = await lastCompletedSession(userId);
    if (!session || session.id !== sessionId) throw new Error("This study session is unavailable or still active. Refresh the page after your study break.");
    const words = await sessionWords(userId, session), now = new Date();
    const created: ReadingLesson = { _id: new ObjectId(), userId, sessionId, sessionStartedAt: session.startedAt, sessionEndedAt: session.endedAt,
      words, pageCount: Math.ceil(words.length / WORDS_PER_PAGE), pages: [], status: "FAILED", model: READING_MODEL, promptVersion: PROMPT_VERSION, createdAt: now, updatedAt: now };
    try { await db.readingLessons.updateOne({ userId, sessionId }, { $setOnInsert: created }, { upsert: true }); }
    catch (error: any) { if (error.code !== 11000) throw error; }
    lesson = await db.readingLessons.findOne({ userId, sessionId });
  }
  const now = new Date(), token = randomUUID();
  const claimed = await db.readingLessons.findOneAndUpdate({ _id: lesson._id, $or: [{ status: "FAILED" }, { status: "GENERATING", lockedUntil: { $lte: now } }] },
    { $set: { status: "GENERATING", error: null, generationToken: token, lockedUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now } }, { returnDocument: "after" });
  if (claimed) void generatePages(claimed, token).catch(() => console.error("Reading generation state could not be saved; its lease will expire."));
  return lessonForClient(claimed ?? await db.readingLessons.findOne({ _id: lesson._id, userId }));
}

async function generatePages(lesson: ReadingLesson, token: string) {
  const db = getDb(), filter = { _id: lesson._id, generationToken: token, status: "GENERATING" as const };
  try {
    for (let index = lesson.pages.length; index < lesson.pageCount; index++) {
      const renewed = await db.readingLessons.updateOne(filter, { $set: { lockedUntil: new Date(Date.now() + LEASE_MS), updatedAt: new Date() } });
      if (!renewed.matchedCount) return;
      const words = lesson.words.slice(index * WORDS_PER_PAGE, (index + 1) * WORDS_PER_PAGE);
      const value = await requestStructured(GENERATION_INSTRUCTIONS, generationInput(words, index, lesson.pageCount, lesson.pages.at(-1)), "reading_page", PAGE_SCHEMA);
      const page = validatePage(value, words, index);
      const saved = await db.readingLessons.updateOne(filter, { $push: { pages: page }, $set: { updatedAt: new Date() } });
      if (!saved.matchedCount) return;
      lesson.pages.push(page);
    }
    await db.readingLessons.updateOne(filter, { $set: { status: "READY", updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } });
  } catch (error) {
    await db.readingLessons.updateOne(filter, { $set: { status: "FAILED", error: errorMessage(error), updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } });
  }
}

export async function checkReadingTranslation(userId: ObjectId, lessonId: ObjectId, pageIndex: number, translation: string, requestId: string) {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new Error("Invalid translation request ID");
  if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error("Invalid page number");
  if (!translation.trim() || translation.length > 18000) throw new Error("Enter your Spanish translation (up to 18000 characters).");
  const db = getDb(), lesson = await db.readingLessons.findOne({ _id: lessonId, userId });
  const page = lesson?.pages.find(p => p.index === pageIndex);
  if (!page) throw new Error("Reading page not found");
  let attempt = await db.translationAttempts.findOne({ userId, requestId });
  if (attempt && (!attempt.lessonId.equals(lessonId) || attempt.pageIndex !== pageIndex || attempt.translation !== translation)) throw new Error("This translation request ID was already used for different work.");
  if (attempt?.status === "READY") return attemptForClient(attempt);
  if (!isReadingConfigured()) throw new Error("Translation checking needs OPENAI_API_KEY in the server environment.");
  if (!attempt) {
    const now = new Date();
    const created: TranslationAttempt = { _id: new ObjectId(), userId, lessonId, pageIndex, requestId, translation, status: "FAILED", createdAt: now, updatedAt: now };
    try { await db.translationAttempts.updateOne({ userId, requestId }, { $setOnInsert: created }, { upsert: true }); }
    catch (error: any) { if (error.code !== 11000) throw error; }
    attempt = await db.translationAttempts.findOne({ userId, requestId });
    if (!attempt.lessonId.equals(lessonId) || attempt.pageIndex !== pageIndex || attempt.translation !== translation) throw new Error("This translation request ID was already used for different work.");
  }
  const now = new Date(), token = randomUUID();
  const claimed = await db.translationAttempts.findOneAndUpdate({ _id: attempt._id, $or: [{ status: "FAILED" }, { status: "CHECKING", lockedUntil: { $lte: now } }] },
    { $set: { status: "CHECKING", error: null, generationToken: token, lockedUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now } }, { returnDocument: "after" });
  if (claimed) void checkTranslation(claimed, page, token).catch(() => console.error("Translation check state could not be saved; its lease will expire."));
  return attemptForClient(claimed ?? await db.translationAttempts.findOne({ _id: attempt._id, userId }));
}

async function checkTranslation(attempt: TranslationAttempt, page: ReadingLesson["pages"][number], token: string) {
  const db = getDb(), filter = { _id: attempt._id, generationToken: token, status: "CHECKING" as const };
  try {
    const value = await requestStructured(CORRECTION_INSTRUCTIONS, correctionInput(page, attempt.translation), "translation_feedback", FEEDBACK_SCHEMA);
    const feedback = validateFeedback(value, page, attempt.translation);
    await db.translationAttempts.updateOne(filter, { $set: { status: "READY", feedback, updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } });
  } catch (error) {
    await db.translationAttempts.updateOne(filter, { $set: { status: "FAILED", error: errorMessage(error), updatedAt: new Date() }, $unset: { generationToken: "", lockedUntil: "" } });
  }
}
