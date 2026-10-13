import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { CEFR_LEVELS } from "../levels/levels.js";
import type { UserProgress } from "../progress/progress.types.js";
import { WRITING_LEVELS, type WritingFocus, type WritingLevel, type WritingVocabulary } from "./writing.types.js";
import { dictionaryWord, reviewedWordContentExpression } from "../words/reviewedWordContent.js";

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
const usable = (word: Pick<WritingVocabulary, "german" | "spanish">) => !!word.german?.trim() && !!word.spanish?.trim() && word.german.length <= 80 && word.german.trim().split(/\s+/u).length <= 6;
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
type VocabularyCandidate = Pick<WritingVocabulary, "id" | "german" | "spanish"> & Partial<Pick<WritingVocabulary, "cefrLevel" | "failureIndex" | "difficultyScore">>;
const effectiveLabels = {
  german: { $cond: [reviewedWordContentExpression, "$study.german", "$german.word"] },
  spanish: { $cond: [reviewedWordContentExpression, "$study.spanish", "$spanish.word"] },
};

function practicedWords(userId: ObjectId, level: WritingLevel, focus: WritingFocus, limit: number, ids?: string[], positiveDifficulty?: boolean): Promise<WritingVocabulary[]>;
function practicedWords(userId: ObjectId, level: WritingLevel, focus: WritingFocus, limit: number, ids: string[] | undefined, positiveDifficulty: boolean, minimal: true): Promise<VocabularyCandidate[]>;
async function practicedWords(userId: ObjectId, level: WritingLevel, focus: WritingFocus, limit: number, ids?: string[], positiveDifficulty = false, minimal = false): Promise<VocabularyCandidate[]> {
  const cursor = getDb().progress.aggregate<WritingVocabulary & { study?: unknown }>([
    { $match: { userId, itemType: "WORD", suspended: { $ne: true }, supersededByAnki: { $ne: true },
      $or: [{ lastReviewed: { $ne: null } }, { failureIndex: { $gt: 0 } }] } },
    { $set: { relationKey: { $ifNull: ["$relationId", "$itemId"] } } },
    ...(ids ? [{ $match: { relationKey: { $in: ids.map(id => new ObjectId(id)) } } }] : []),
    { $group: { _id: "$relationKey", failureIndex: { $sum: { $ifNull: ["$failureIndex", 0] } },
      difficultyScore: { $sum: { $max: [0, { $subtract: [{ $ifNull: ["$failureIndex", 0] }, { $ifNull: ["$writingReinforcementCredit", 0] }] }] } }, lastReviewed: { $max: "$lastReviewed" } } },
    ...(positiveDifficulty ? [{ $match: { difficultyScore: { $gt: 0 } } }] : []),
    // All ordering keys are grouped progress fields; filtering joins keep that order.
    { $sort: focus === "DIFFICULT" ? { difficultyScore: -1, failureIndex: -1, lastReviewed: -1, _id: 1 } : { lastReviewed: -1, failureIndex: -1, _id: 1 } },
    ...joinVocabulary, { $match: { "german.cefrLevel": { $in: allowedLevels(level) } } },
    ...(minimal ? [
      { $set: { study: "$relation.study" } },
      { $project: { _id: 0, id: { $toString: "$_id" }, ...effectiveLabels, cefrLevel: "$german.cefrLevel",
        failureIndex: vocabularyFields.failureIndex, difficultyScore: vocabularyFields.difficultyScore } },
    ] : [{ $project: vocabularyFields }]),
  ]).batchSize(minimal ? 100 : limit);
  const words: VocabularyCandidate[] = [];
  try {
    for await (const row of cursor) {
      const word = minimal ? row : reviewedVocabulary(row);
      if (usable(word)) words.push(word);
      // A raw-row limit could discard usable reviewed corrections or underfill a selection.
      if (words.length === limit) break;
    }
    return words;
  } finally { await cursor.close(); }
}

async function hydrateVocabulary(ranked: VocabularyCandidate[], level: WritingLevel, limit: number, preserveScores = false): Promise<WritingVocabulary[]> {
  const chosen: WritingVocabulary[] = [];
  // Hydrate only winners in rank order, with the full reviewed forms/notes reader.
  // If an edit makes a winner unavailable between reads, continue with the remaining ranks.
  for (let offset = 0; chosen.length < limit && offset < ranked.length;) {
    const candidates = ranked.slice(offset, offset + limit - chosen.length);
    offset += candidates.length;
    const rows = await getDb().relationsWordsEsDe.aggregate<WritingVocabulary & { study?: unknown }>([
      { $match: { _id: { $in: candidates.map(word => new ObjectId(word.id)) } } },
      ...joinVocabulary, { $match: { "german.cefrLevel": { $in: allowedLevels(level) } } },
      { $project: vocabularyFields },
    ]).toArray();
    const hydrated = new Map(rows.map(row => { const word = reviewedVocabulary(row); return [word.id, word] as const; }));
    for (const candidate of candidates) {
      const word = hydrated.get(candidate.id);
      if (word && usable(word)) chosen.push(preserveScores ? { ...word, failureIndex: candidate.failureIndex!, difficultyScore: candidate.difficultyScore! } : word);
    }
  }
  return chosen;
}
export async function difficultWritingWords(userId: ObjectId, levelValue: string, limit = 8) {
  const level = writingLevel(levelValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Choose between 1 and 50 words");
  return practicedWords(userId, level, "DIFFICULT", limit, undefined, true);
}
export async function chooseWritingWords(userId: ObjectId, seed: ObjectId, level: WritingLevel, focus: WritingFocus, selectedIds: string[] = []) {
  const maximum = level === "A1" ? 2 : 4;
  if (selectedIds.length > maximum || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !ObjectId.isValid(id)))
    throw new Error(`Choose up to ${maximum} different words for this level`);
  if (selectedIds.length) {
    const practiced = await practicedWords(userId, level, focus, selectedIds.length, selectedIds);
    if (practiced.length !== selectedIds.length) throw new Error("A selected word is unavailable or above the chosen level. Refresh the list.");
    return selectedIds.map(id => practiced.find(word => word.id === id)!);
  }
  const rank = (word: Pick<WritingVocabulary, "id">) => createHash("sha256").update(`${seed}:${word.id}`).digest("hex");
  // RECENT ranks the same first 180 usable words, without transferring their rich content.
  const chosen = focus === "RECENT"
    ? await hydrateVocabulary((await practicedWords(userId, level, focus, 180, undefined, false, true)).sort((a, b) => rank(a).localeCompare(rank(b))), level, maximum, true)
    : await practicedWords(userId, level, focus, maximum);
  if (chosen.length < maximum) {
    const fallback = await getDb().relationsWordsEsDe.aggregate<Pick<WritingVocabulary, "id" | "german" | "spanish">>([
      ...joinVocabulary, { $match: { "german.cefrLevel": { $in: allowedLevels(level) }, _id: { $nin: chosen.map(word => new ObjectId(word.id)) } } },
      { $set: { study: "$relation.study" } },
      { $project: { _id: 0, id: { $toString: "$_id" }, ...effectiveLabels } },
    ]).toArray();
    const ranked = fallback.filter(usable).sort((a, b) => rank(a).localeCompare(rank(b)));
    chosen.push(...await hydrateVocabulary(ranked, level, maximum - chosen.length));
  }
  if (!chosen.length) throw new Error("No German-Spanish words are available at this level. Add vocabulary or choose a higher level.");
  return chosen;
}
