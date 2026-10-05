import type { ReadingPage, SessionVocabulary, TranslationFeedback } from "./reading.types.js";

const text = (value: unknown, maximum = 18000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const normalized = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();
const contains = (haystack: string, needle: string) => normalized(haystack).includes(normalized(needle));
const containsWord = (sentence: string, form: string) => {
  const escaped = normalized(form).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(normalized(sentence));
};
const articleFamilies = [
  ["der", "die", "das", "den", "dem", "des"],
  ["ein", "eine", "einer", "eines", "einem", "einen"],
  ["kein", "keine", "keiner", "keines", "keinem", "keinen"],
];
/** An audit can copy the dictionary article; retain only a literal source form. */
function sourceForm(example: string, form: string): string | null {
  if (containsWord(example, form)) return form;
  const parts = /^(\p{L}+)\s+(.+)$/u.exec(normalized(form));
  const family = parts && articleFamilies.find(forms => forms.includes(parts[1].toLowerCase()));
  if (!family || !parts) return null;
  const articles = family.map(article => `[${article[0].toLowerCase()}${article[0].toUpperCase()}]${article.slice(1)}`).join("|");
  const remainder = parts[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])((?:${articles})\\s+${remainder})(?=$|[^\\p{L}\\p{N}])`, "u").exec(normalized(example));
  return match?.[1] ?? null;
}
function validWordIds(entries: any[], words: SessionVocabulary[]) {
  return Array.isArray(entries) && entries.length === words.length && entries.every(w => w && typeof w.wordId === "string" && words.some(target => target.id === w.wordId)) && new Set(entries.map(w => w.wordId)).size === words.length;
}

export function validatePage(value: any, words: SessionVocabulary[], index: number): ReadingPage {
  const wordCount = typeof value?.german === "string" ? value.german.trim().split(/\s+/u).length : 0;
  const spanishCount = typeof value?.spanish === "string" ? value.spanish.trim().split(/\s+/u).length : 0;
  if (!text(value?.title, 180) || !text(value?.german) || !text(value?.spanish) || wordCount < 350 || wordCount > 650 || spanishCount < wordCount * 0.6 || !validWordIds(value?.vocabulary, words)) {
    throw new Error("The generated page did not meet the length or vocabulary requirements. Retry this exercise.");
  }
  const vocabulary = value.vocabulary.map((usage: any) => {
    if (!text(usage.example, 3000) || !contains(value.german, usage.example) || !Array.isArray(usage.surfaceForms) || !usage.surfaceForms.length ||
      !usage.surfaceForms.every((form: unknown) => text(form, 300))) {
      throw new Error("The generated vocabulary audit did not match the German text. Retry this exercise.");
    }
    const surfaceForms = usage.surfaceForms.map((form: string) => sourceForm(usage.example, form));
    if (!surfaceForms.every((form: unknown) => text(form, 300))) throw new Error("The generated vocabulary audit did not match the German text. Retry this exercise.");
    return { ...usage, surfaceForms };
  });
  return { index, words, title: value.title.trim(), german: value.german.trim(), spanish: value.spanish.trim(), vocabulary, wordCount };
}

export function validateFeedback(value: any, page: ReadingPage, translation: string): TranslationFeedback {
  const allowEmpty = (v: unknown) => typeof v === "string" && v.length <= 10000;
  if (!Number.isInteger(value?.score) || value.score < 0 || value.score > 100 || !text(value?.summary, 4000) || !text(value?.correctedSpanish) ||
    !Array.isArray(value.corrections) || value.corrections.length > 150 || !Array.isArray(value.omissions) || value.omissions.length > 100 || !validWordIds(value.vocabulary, page.words)) {
    throw new Error("The translation feedback was incomplete. Your translation is saved; retry the check.");
  }
  for (const correction of value.corrections) {
    if (!allowEmpty(correction.original) || !allowEmpty(correction.corrected) || !(correction.original.trim() || correction.corrected.trim()) || !text(correction.explanation, 3000) ||
      !["MEANING", "GRAMMAR", "VOCABULARY", "STYLE"].includes(correction.category) || correction.original && !contains(translation, correction.original)) {
      throw new Error("A correction did not match your translation. Your translation is saved; retry the check.");
    }
  }
  if (!value.omissions.every((v: any) => text(v.german, 10000) && contains(page.german, v.german) && text(v.explanation, 3000)) ||
    !value.vocabulary.every((v: any) => typeof v.understood === "boolean" && text(v.feedback, 3000))) {
    throw new Error("The translation feedback did not match this page. Your translation is saved; retry the check.");
  }
  return value;
}
