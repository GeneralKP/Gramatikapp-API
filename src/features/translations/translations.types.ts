import type { ObjectId } from "mongodb";
import type { CefrLevel } from "../levels/levels.js";
import type { GrammaticalCategory, RelatedWords, WordForms } from "../words/words.types.js";

export type TranslationLanguage = "de" | "es";
export interface PhraseReference { language: TranslationLanguage; phraseId: ObjectId }
export interface ReviewedTranslation {
  key: string; word: string; translation: string; kind: "LEXEME" | "SURFACE";
  lemma: string; category: GrammaticalCategory; form: string; cefrLevel: CefrLevel;
  notes?: string; forms?: WordForms; relatedWords?: RelatedWords; example?: string; contexts?: string[];
  target?: { word: string; category: GrammaticalCategory; forms?: WordForms; relatedWords?: RelatedWords; cefrLevel: CefrLevel; example: string; notes?: string };
}
export interface WordTranslation {
  _id: ObjectId; key: string; word: string;
  sourceLanguage: TranslationLanguage; targetLanguage: TranslationLanguage;
  status: "PENDING" | "READY" | "FAILED";
  kind?: "SURFACE"; translation?: string;
  lemma?: string; lemmaWordIds?: ObjectId[]; category?: GrammaticalCategory;
  form?: string; cefrLevel?: CefrLevel; notes?: string;
  examples?: string[]; contexts?: string[]; phraseRefs?: PhraseReference[];
  origin: "MANUAL" | "GPT"; model?: string;
  leaseToken?: string; leaseUntil?: Date;
  createdAt: Date; updatedAt: Date;
}
