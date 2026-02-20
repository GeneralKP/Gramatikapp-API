import { ObjectId } from "mongodb";

export enum LearningContext {
  TRAVEL_CAR = "travel_car",
  TRAVEL_TRAIN = "travel_train",
  TRAVEL_BOAT = "travel_boat",
  TRAVEL_PLANE = "travel_plane",
  TRAVEL_WALKING = "travel_walking",
  HOSPITAL = "hospital",
  SURGERY = "surgery",
  PRAXIS = "praxis",
  PARTY = "party",
  LANG_PARTY = "lang_party",
  CHURCH = "church",
  WORSHIP = "worship",
  ADVENTIST = "adventist",
  FLIRTING = "flirting",
  MOVING = "moving",
  ROBBERY = "robbery",
  COLOMBIAN = "colombian",
  COLOMBIAN_COMPLIMENTS = "colombian_compliments",
  DEBATE = "debate",
  UNIVERSITY = "university",
  COURT = "court",
  IMMIGRATION = "immigration",
  CHINA = "china",
  BEGGING = "begging",
  RAFFLES = "raffles",
  CARTOON_CONVENTION = "cartoon_convention",
}

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
  UNKNOWN = "UNKNOWN",
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
  gramaticalCategories: GrammaticalCategory[];
  examples: string[];
  relatedWords?: RelatedWords;
  forms?: WordForms;
  contexts: LearningContext[];
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
