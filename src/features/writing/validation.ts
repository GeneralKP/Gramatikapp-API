import type { SessionVocabulary } from "../reading/reading.types.js";
import type { WritingFeedback, WritingSentence } from "./writing.types.js";
export const normalizedText = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ");
export const sentenceWordCount = (value: string) => normalizedText(value).split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
const text = (value: unknown, maximum = 5000): value is string => typeof value === "string" && !!value.trim() && value.length <= maximum;
const lengthOk = (value: string) => sentenceWordCount(value) >= 30 && sentenceWordCount(value) <= 50;
export const containsTerm = (sentence: string, word: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${normalizedText(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu").test(normalizedText(sentence));
export function validateSentence(value: any, words: SessionVocabulary[]): WritingSentence {
  if (!text(value?.title, 180) || !text(value?.spanish, 1500) || !text(value?.german, 1500) || !lengthOk(value.spanish) || !lengthOk(value.german) ||
    !text(value.mainClause, 1500) || !text(value.subordinateClause, 1500) || !text(value.grammarExplanation, 2000) ||
    !["MAIN_FIRST", "SUBORDINATE_FIRST"].includes(value.clauseOrder) || !["weil", "obwohl", "wenn", "während", "nachdem", "bevor", "damit", "falls"].includes(value.connector)) throw new Error("The sentence did not meet the 30–50 word or clause requirements. Retry generation.");
  const clauses = value.clauseOrder === "MAIN_FIRST" ? [value.mainClause, value.subordinateClause] : [value.subordinateClause, value.mainClause];
  if (normalizedText(value.german) !== normalizedText(`${clauses[0]}, ${clauses[1]}.`) || !value.subordinateClause.toLocaleLowerCase("de").startsWith(`${value.connector} `) || sentenceWordCount(value.mainClause) < 5 || sentenceWordCount(value.subordinateClause) < 5) throw new Error("The sentence's main and subordinate clauses were inconsistent. Retry generation.");
  if (!Array.isArray(value.vocabulary) || value.vocabulary.length !== words.length || new Set(value.vocabulary.map((v: any) => v.wordId)).size !== words.length) throw new Error("The sentence omitted target vocabulary. Retry generation.");
  for (const v of value.vocabulary) {
    if (!words.some(w => w.id === v.wordId) || !text(v.example, 1500) || normalizedText(v.example) !== normalizedText(value.german) || !Array.isArray(v.surfaceForms) || !v.surfaceForms.length || !v.surfaceForms.every((s: unknown) => text(s, 150) && containsTerm(value.german, s))) throw new Error("The vocabulary audit did not match the generated sentence. Retry generation.");
  }
  return { ...value, spanish: value.spanish.trim(), german: value.german.trim(), spanishWordCount: sentenceWordCount(value.spanish), germanWordCount: sentenceWordCount(value.german) };
}
export function validateWritingFeedback(value: any, translation: string): WritingFeedback {
  const excerpt = (v: unknown) => typeof v === "string" && v.length <= 3000;
  if (typeof value?.correct !== "boolean" || !Number.isInteger(value.score) || value.score < 0 || value.score > 100 || !text(value.summary, 3000) || !text(value.correctedGerman, 5000) || !Array.isArray(value.corrections) || value.corrections.length > 50 || !Array.isArray(value.alternatives) || value.alternatives.length > 2) throw new Error("Feedback was incomplete. Your translation is saved; retry the check.");
  if (value.correct ? value.corrections.length !== 0 || value.score < 95 || value.alternatives.length < 1 : value.corrections.length === 0 || value.score > 94 || value.alternatives.length !== 0) throw new Error("The correctness result contradicted its corrections. Your translation is saved; retry the check.");
  for (const correction of value.corrections) if (!excerpt(correction.original) || !excerpt(correction.corrected) || !(correction.original.trim() || correction.corrected.trim()) || !text(correction.explanation, 3000) || !["ARTICLE", "CASE", "VERB_POSITION", "TENSE", "WORD_CHOICE", "SPELLING", "MEANING", "OMISSION", "PUNCTUATION"].includes(correction.category) || correction.original && !normalizedText(translation).includes(normalizedText(correction.original))) throw new Error("A correction did not match your translation. Your work is saved; retry the check.");
  const alternatives = new Set<string>();
  for (const alternative of value.alternatives) {
    if (!text(alternative, 1500) || !lengthOk(alternative) || normalizedText(alternative) === normalizedText(translation) || alternatives.has(normalizedText(alternative))) throw new Error("The alternative translations were invalid. Retry the check.");
    alternatives.add(normalizedText(alternative));
  }
  return value;
}
