import { GrammaticalCategory, type WordForms, type WordStudyContent } from "./words.types.js";

type DictionaryContent = Pick<WordStudyContent, "version" | "german" | "spanish" | "notes" | "forms" | "category" | "germanExamples" | "spanishExamples">;

// The dictionary projects selected display metadata and language-specific examples.
export function reviewedWordContent(value: unknown): DictionaryContent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const content = value as Partial<DictionaryContent>;
  if (content.version !== 1 || typeof content.german !== "string" || !content.german.length ||
      typeof content.spanish !== "string" || !content.spanish.length || typeof content.notes !== "string") return undefined;
  return content as DictionaryContent;
}

// Keep the aggregation's search/sort validity identical to the response reader.
export const reviewedWordContentExpression = {
  $and: [
    { $eq: ["$study.version", 1] },
    ...["german", "spanish", "notes"].map(field => ({ $eq: [{ $type: `$study.${field}` }, "string"] })),
    { $ne: ["$study.german", ""] },
    { $ne: ["$study.spanish", ""] },
  ],
};

export function dictionaryWord<T extends { word?: string; notes?: string }>(word: T | null | undefined, study: unknown, language: "DE" | "ES"): T | null | undefined {
  const content = reviewedWordContent(study);
  if (!word || !content) return word;
  const formKeys = ["perfect", "past", "imperativ", "irregularConjugations", "plural", "gender", "gramaticalCase"];
  const validForms = content.forms && typeof content.forms === "object" && Object.getPrototypeOf(content.forms) === Object.prototype &&
    Object.entries(content.forms).every(([key, value]) => formKeys.includes(key) && typeof value === "string");
  const validCategory = Object.values(GrammaticalCategory).includes(content.category!);
  const examples = language === "DE" ? content.germanExamples : content.spanishExamples;
  const validExamples = Array.isArray(examples) && examples.every(example => typeof example === "string");
  return {
    ...word,
    word: language === "DE" ? content.german : content.spanish,
    ...(validExamples ? { examples: [...examples!] } : {}),
    ...(language === "DE" ? { notes: content.notes,
      ...(validForms ? { forms: content.forms as WordForms } : {}),
      ...(validCategory ? { gramaticalCategories: [content.category!] } : {}),
    } : {}),
  };
}
