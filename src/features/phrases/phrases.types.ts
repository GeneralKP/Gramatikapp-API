import { ObjectId } from "mongodb";
import { LearningContext } from "../words/words.types.js";

export interface LegacyPhrase {
  _id: ObjectId;
  german: string;
  spanish: string;
  words?: string[];
  tags: string[];
  createdAt: Date;
  updatedAt?: Date;
}

export enum PhraseLevel {
  A1 = "A1",
  A2 = "A2",
  B1 = "B1",
  B2 = "B2",
  C1 = "C1",
  C2 = "C2",
}

export interface PerWordExplanation {
  missing?: string;
  misplaced?: string;
  misspelled?: string;
}

export interface Phrase {
  _id: ObjectId;
  phrase: string;
  synonyms: string[]; // actually other equivalent phrases
  words: ObjectId[]; // references to WORDS_[LANGUAGE]
  perWordExplanation?: Record<string, PerWordExplanation>;
  level?: PhraseLevel;
  contexts: LearningContext[];
  createdAt: Date;
  updatedAt?: Date;
}

export interface PhraseRelation {
  _id: ObjectId;
  main: ObjectId; // Ref to PHRASES_ES
  translated: ObjectId; // Ref to PHRASES_DE
  createdAt: Date;
}
