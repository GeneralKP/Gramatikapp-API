import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { CEFR_LEVELS } from "../levels/levels.js";
import type { UserProgress } from "../progress/progress.types.js";
import { WRITING_LEVELS, type WritingFocus, type WritingLevel, type WritingVocabulary } from "./writing.types.js";
import { dictionaryWord } from "../words/reviewedWordContent.js";

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
