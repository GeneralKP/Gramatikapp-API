import type { ObjectId } from "mongodb";
import type { JobStatus, SessionVocabulary, VocabularyUsage } from "../reading/reading.types.js";
export interface WritingSentence {
  title: string; spanish: string; german: string; mainClause: string; subordinateClause: string;
  clauseOrder: "MAIN_FIRST" | "SUBORDINATE_FIRST"; connector: string; grammarExplanation: string;
  spanishWordCount: number; germanWordCount: number; vocabulary: VocabularyUsage[];
}
export interface WritingExercise {
  _id: ObjectId; userId: ObjectId; requestId: string; level: "B2" | "C1"; words: SessionVocabulary[];
  sentence?: WritingSentence; status: JobStatus; error?: string | null; generationToken?: string; lockedUntil?: Date;
  model: string; promptVersion: number; createdAt: Date; updatedAt: Date;
}
export interface WritingFeedback {
  correct: boolean; score: number; summary: string; correctedGerman: string;
  corrections: { original: string; corrected: string; explanation: string; category: string }[];
  alternatives: string[];
}
export interface WritingAttempt {
  _id: ObjectId; userId: ObjectId; exerciseId: ObjectId; requestId: string; translation: string;
  status: JobStatus; feedback?: WritingFeedback; error?: string | null; generationToken?: string; lockedUntil?: Date;
  createdAt: Date; updatedAt: Date;
}
export interface WritingHint {
  _id: ObjectId; userId: ObjectId; exerciseId: ObjectId; word: string; status: JobStatus;
  german?: string; explanation?: string; error?: string | null; generationToken?: string; lockedUntil?: Date;
  createdAt: Date; updatedAt: Date;
}
