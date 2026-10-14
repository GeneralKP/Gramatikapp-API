// Frozen pre-Task 2 physical source snapshot, copied 14 October 2026.
// Copied before service edits; preserve these algorithms for differential regression.
import type { ReadingLesson, StudySession, TranslationAttempt } from "../../src/features/reading/reading.types.js";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "../../src/lib/database.js";
import { CEFR_LEVELS } from "../../src/features/levels/levels.js";
import type { UserProgress } from "../../src/features/progress/progress.types.js";
import { WRITING_LEVELS, type WritingFocus, type WritingLevel, type WritingVocabulary } from "../../src/features/writing/writing.types.js";
import { dictionaryWord } from "../../src/features/words/reviewedWordContent.js";

export const REINFORCEMENT_CREDIT = 0.25;
export const activeDifficulty = (card: Pick<UserProgress, "failureIndex" | "writingReinforcementCredit">) =>
  Math.max(0, (card.failureIndex ?? 0) - (card.writingReinforcementCredit ?? 0));
export function writingLevel(value: string): WritingLevel {
  if (!(WRITING_LEVELS as readonly string[]).includes(value)) throw new Error("Choose a level from A1 to C2");
  return value as WritingLevel;
}
export function writingFocus(value: string): WritingFocus {
  if (value !== "RECENT" && value !== "DIFFICULT") throw new Error("Choose recent practice or difficult words");
  return value;
}
const allowedLevels = (level: WritingLevel) => CEFR_LEVELS.filter(entry => WRITING_LEVELS.indexOf(entry.split(".")[0] as WritingLevel) <= WRITING_LEVELS.indexOf(level));
const usable = (word: WritingVocabulary) => !!word.german?.trim() && !!word.spanish?.trim() && word.german.length <= 80 && word.german.trim().split(/\s+/u).length <= 6;
const joinVocabulary = [
  { $lookup: { from: "WORDS_ES_DE", localField: "_id", foreignField: "_id", as: "relation" } }, { $unwind: "$relation" },
  { $lookup: { from: "WORDS_DE", localField: "relation.translated", foreignField: "_id", as: "german" } }, { $unwind: "$german" },
  { $lookup: { from: "WORDS_ES", localField: "relation.main", foreignField: "_id", as: "spanish" } }, { $unwind: "$spanish" },
];
const vocabularyFields = { _id: 0, id: { $toString: "$_id" }, german: "$german.word", spanish: "$spanish.word", forms: { $ifNull: ["$german.forms", {}] },
  notes: { $ifNull: ["$german.notes", ""] }, study: "$relation.study", cefrLevel: "$german.cefrLevel", failureIndex: { $ifNull: ["$failureIndex", 0] }, difficultyScore: { $ifNull: ["$difficultyScore", 0] } };
function reviewedVocabulary({ study, ...word }: WritingVocabulary & { study?: unknown }): WritingVocabulary {
  const de = dictionaryWord({ word: word.german, notes: word.notes, forms: word.forms }, study, "DE")!;
  const es = dictionaryWord({ word: word.spanish }, study, "ES")!;
  return { ...word, german: de.word, spanish: es.word, forms: de.forms, notes: de.notes };
}

async function practicedWords(userId: ObjectId, level: WritingLevel, focus: WritingFocus, ids?: string[]) {
  const rows = await getDb().progress.aggregate<WritingVocabulary & { study?: unknown }>([
    { $match: { userId, itemType: "WORD", suspended: { $ne: true }, supersededByAnki: { $ne: true },
      $or: [{ lastReviewed: { $ne: null } }, { failureIndex: { $gt: 0 } }] } },
    { $set: { relationKey: { $ifNull: ["$relationId", "$itemId"] } } },
    ...(ids ? [{ $match: { relationKey: { $in: ids.map(id => new ObjectId(id)) } } }] : []),
    { $group: { _id: "$relationKey", failureIndex: { $sum: { $ifNull: ["$failureIndex", 0] } },
      difficultyScore: { $sum: { $max: [0, { $subtract: [{ $ifNull: ["$failureIndex", 0] }, { $ifNull: ["$writingReinforcementCredit", 0] }] }] } }, lastReviewed: { $max: "$lastReviewed" } } },
    ...joinVocabulary, { $match: { "german.cefrLevel": { $in: allowedLevels(level) } } },
    { $sort: focus === "DIFFICULT" ? { difficultyScore: -1, failureIndex: -1, lastReviewed: -1, _id: 1 } : { lastReviewed: -1, failureIndex: -1, _id: 1 } },
    { $project: vocabularyFields },
  ]).toArray();
  return rows.map(reviewedVocabulary).filter(usable);
}
export async function difficultWritingWords(userId: ObjectId, levelValue: string, limit = 8) {
  const level = writingLevel(levelValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Choose between 1 and 50 words");
  return (await practicedWords(userId, level, "DIFFICULT")).filter(word => word.difficultyScore > 0).slice(0, limit);
}
export async function chooseWritingWords(userId: ObjectId, seed: ObjectId, level: WritingLevel, focus: WritingFocus, selectedIds: string[] = []) {
  const maximum = level === "A1" ? 2 : 4;
  if (selectedIds.length > maximum || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !ObjectId.isValid(id)))
    throw new Error(`Choose up to ${maximum} different words for this level`);
  const practiced = await practicedWords(userId, level, focus, selectedIds.length ? selectedIds : undefined);
  if (selectedIds.length) {
    if (practiced.length !== selectedIds.length) throw new Error("A selected word is unavailable or above the chosen level. Refresh the list.");
    return selectedIds.map(id => practiced.find(word => word.id === id)!);
  }
  const rank = (word: WritingVocabulary) => createHash("sha256").update(`${seed}:${word.id}`).digest("hex");
  if (focus === "RECENT") practiced.splice(0, practiced.length, ...practiced.slice(0, 180).sort((a, b) => rank(a).localeCompare(rank(b))));
  const chosen = practiced.slice(0, maximum);
  if (chosen.length < maximum) {
    const fallback = await getDb().relationsWordsEsDe.aggregate<WritingVocabulary & { study?: unknown }>([
      ...joinVocabulary, { $match: { "german.cefrLevel": { $in: allowedLevels(level) }, _id: { $nin: chosen.map(word => new ObjectId(word.id)) } } },
      { $project: vocabularyFields },
    ]).toArray();
    chosen.push(...fallback.map(reviewedVocabulary).filter(usable).sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, maximum - chosen.length));
  }
  if (!chosen.length) throw new Error("No German-Spanish words are available at this level. Add vocabulary or choose a higher level.");
  return chosen;
}

export const SESSION_BREAK_MS = 30 * 60000;
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
