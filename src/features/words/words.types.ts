import { ObjectId } from "mongodb";

export enum GrammaticalCategory {
  NOUN = "NOUN",
  VERB = "VERB",
  ADJECTIVE = "ADJECTIVE",
  ADVERB = "ADVERB",
  PRONOUN = "PRONOUN",
  PREPOSITION = "PREPOSITION",
  CONJUNCTION = "CONJUNCTION",
  INTERJECTION = "INTERJECTION",
  ARTICLE = "ARTICLE",
}

export interface WordForms {
  perfect?: string;
  past?: string;
  imperativ?: string;
  irregularConjugations?: string;
  plural?: string;
  gender?: string;
  gramaticalCase?: string; // e.g. 'dativ', 'akkusativ'
}

export interface RelatedWords {
  synonyms?: string[];
  antonyms?: string[];
  homophones?: string[];
  homonymous?: string[];
  paronyms?: string[];
  verbFamilies?: string[];
}

export enum WordLevel {
  A1 = "A1",
  A2 = "A2",
  B1 = "B1",
  B2 = "B2",
  C1 = "C1",
  C2 = "C2",
}

export interface Word {
  _id: ObjectId;
  word: string;
  gramaticalCategory: GrammaticalCategory;
  examples: string[];
  relatedWords?: RelatedWords;
  forms?: WordForms;
  context?: string;
  level?: WordLevel;
  notes?: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface WordRelation {
  _id: ObjectId;
  main: ObjectId; // Ref to WORDS_ES
  translated: ObjectId; // Ref to WORDS_DE
  createdAt: Date;
}
