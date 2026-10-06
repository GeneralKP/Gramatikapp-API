import type { SessionVocabulary } from "../reading/reading.types.js";
import type { WritingFeedback, WritingSentence } from "./writing.types.js";
export const normalizedText = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ");
export const sentenceWordCount = (value: string) => normalizedText(value).split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
const text = (value: unknown, maximum = 5000): value is string => typeof value === "string" && !!value.trim() && value.length <= maximum;
type WordBounds = readonly [number, number];
const lengthOk = (value: string, bounds: WordBounds = [15,30]) => sentenceWordCount(value) >= bounds[0] && sentenceWordCount(value) <= bounds[1];
const connectors = ["weil", "obwohl", "wenn", "während", "nachdem", "bevor", "damit", "falls"];
// Reject nested subordinate clauses inside either audited fragment. A fragment
// may still contain commas in adjective lists or other non-clausal phrases.
// Während and damit also have non-clausal uses; their verb audits distinguish
// clauses without rejecting a prepositional or participial parenthesis.
const nestedSubordinate = /[,;]\s*(?:weil|obwohl|wenn|nachdem|bevor|falls|dass|ob|sobald|solange|sofern|seitdem|indem|ehe|zumal|wenngleich)\b/iu;
export function validateClauseSentence(value: any, bounds: WordBounds = [15,30]) {
  if (!text(value?.german, 1500) || !lengthOk(value.german, bounds) || !text(value.mainClause, 1500) || !text(value.subordinateClause, 1500) ||
    !["MAIN_FIRST", "SUBORDINATE_FIRST"].includes(value.clauseOrder) || !connectors.includes(value.connector)) throw new Error("The sentence did not meet the 15–30 word or clause requirements. Retry generation.");
  const fragments = value.clauseOrder === "MAIN_FIRST" ? [value.mainClause, value.subordinateClause] : [value.subordinateClause, value.mainClause];
  if (normalizedText(value.german) !== normalizedText(`${fragments[0]}, ${fragments[1]}.`) || !value.subordinateClause.toLocaleLowerCase("de").startsWith(`${value.connector} `) ||
    sentenceWordCount(value.mainClause) < 5 || sentenceWordCount(value.subordinateClause) < 5 || nestedSubordinate.test(value.mainClause) || nestedSubordinate.test(value.subordinateClause)) throw new Error("The sentence must contain one main clause and one subordinate clause. Retry generation.");
  for (const [key, fragment] of [["main", value.mainClause], ["subordinate", value.subordinateClause]]) {
    const verbs = value.finiteVerbs?.[key];
    if (!Array.isArray(verbs) || verbs.length !== 1 || !text(verbs[0], 100) || !/^[\p{L}\p{M}]+$/u.test(verbs[0]) || !containsTerm(fragment, verbs[0])) throw new Error("Each clause must have one audited finite verb. Retry generation.");
  }
  return value as Pick<WritingSentence, "german" | "mainClause" | "subordinateClause" | "clauseOrder" | "connector" | "finiteVerbs">;
}
export const containsTerm = (sentence: string, word: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${normalizedText(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu").test(normalizedText(sentence));
export function validateSentence(value: any, words: SessionVocabulary[], bounds: WordBounds = [15,30]): WritingSentence {
  if (!text(value?.title, 180) || !text(value?.spanish, 1500) || !text(value?.german, 1500) || !lengthOk(value.spanish, bounds) || !lengthOk(value.german, bounds) ||
    !text(value.mainClause, 1500) || !text(value.subordinateClause, 1500) || !text(value.grammarExplanation, 2000) ||
    !["MAIN_FIRST", "SUBORDINATE_FIRST"].includes(value.clauseOrder) || !connectors.includes(value.connector)) throw new Error("The sentence did not meet the 15–30 word or clause requirements. Retry generation.");
  validateClauseSentence(value, bounds);
  if (!Array.isArray(value.vocabulary) || value.vocabulary.length !== words.length || new Set(value.vocabulary.map((v: any) => v.wordId)).size !== words.length) throw new Error("The sentence omitted target vocabulary. Retry generation.");
  for (const v of value.vocabulary) {
    if (!words.some(w => w.id === v.wordId) || !text(v.example, 1500) || normalizedText(v.example) !== normalizedText(value.german) || !Array.isArray(v.surfaceForms) || !v.surfaceForms.length || !v.surfaceForms.every((s: unknown) => text(s, 150) && containsTerm(value.german, s))) throw new Error("The vocabulary audit did not match the generated sentence. Retry generation.");
  }
  return { ...value, spanish: value.spanish.trim(), german: value.german.trim(), spanishWordCount: sentenceWordCount(value.spanish), germanWordCount: sentenceWordCount(value.german) };
}
export function validateWritingFeedback(value: any, translation: string, bounds: WordBounds = [15,30]): WritingFeedback {
  const excerpt = (v: unknown) => typeof v === "string" && v.length <= 3000;
  if (typeof value?.correct !== "boolean" || !Number.isInteger(value.score) || value.score < 0 || value.score > 100 || !text(value.summary, 3000) || !text(value.correctedGerman, 5000) || !Array.isArray(value.corrections) || value.corrections.length > 50 || !Array.isArray(value.alternatives) || value.alternatives.length > 2) throw new Error("Feedback was incomplete. Your translation is saved; retry the check.");
  if (value.correct ? value.corrections.length !== 0 || value.score < 95 || value.alternatives.length < 1 : value.corrections.length === 0 || value.score > 94 || value.alternatives.length !== 0) throw new Error("The correctness result contradicted its corrections. Your translation is saved; retry the check.");
  for (const correction of value.corrections) if (!excerpt(correction.original) || !excerpt(correction.corrected) || !(correction.original.trim() || correction.corrected.trim()) || !text(correction.explanation, 3000) || !["ARTICLE", "CASE", "VERB_POSITION", "TENSE", "WORD_CHOICE", "SPELLING", "MEANING", "OMISSION", "PUNCTUATION"].includes(correction.category) || correction.original && !normalizedText(translation).includes(normalizedText(correction.original))) throw new Error("A correction did not match your translation. Your work is saved; retry the check.");
  const alternatives = new Set<string>();
  for (const alternative of value.alternatives) {
    try { validateClauseSentence(alternative, bounds); }
    catch { throw new Error("An alternative did not contain one main clause and one subordinate clause. Your translation is saved; retry the check."); }
    if (normalizedText(alternative.german) === normalizedText(translation) || alternatives.has(normalizedText(alternative.german))) throw new Error("The alternative translations were invalid. Retry the check.");
    alternatives.add(normalizedText(alternative.german));
  }
  return { ...value, alternatives: value.alternatives.map((alternative: { german: string }) => alternative.german.trim()) };
}
