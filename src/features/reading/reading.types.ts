import type { ObjectId } from "mongodb";

export interface SessionVocabulary {
  id: string;
  german: string;
  spanish: string;
  forms: Record<string, string>;
  notes: string;
  failureIndex: number;
  difficultyScore?: number;
  cefrLevel?: string;
}
export interface StudySession {
  id: string;
  startedAt: Date;
  endedAt: Date;
  itemIds: ObjectId[];
  reviewCount: number;
}
export interface VocabularyUsage {
  wordId: string;
  surfaceForms: string[];
  example: string;
}
export interface ReadingPage {
  index: number;
  words: SessionVocabulary[];
  title: string;
  german: string;
  spanish: string;
  vocabulary: VocabularyUsage[];
  wordCount: number;
}
export type JobStatus = "GENERATING" | "CHECKING" | "READY" | "FAILED";
export interface ReadingLesson {
  _id: ObjectId;
  userId: ObjectId;
  sessionId: string;
  sessionStartedAt: Date;
  sessionEndedAt: Date;
  words: SessionVocabulary[];
  pageCount: number;
  pages: ReadingPage[];
  status: JobStatus;
  error?: string | null;
  generationToken?: string;
  lockedUntil?: Date;
  model: string;
  promptVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface TranslationFeedback {
  score: number;
  summary: string;
  correctedSpanish: string;
  corrections: { original: string; corrected: string; explanation: string; category: string }[];
  omissions: { german: string; explanation: string }[];
  vocabulary: { wordId: string; understood: boolean; feedback: string }[];
}
export interface TranslationAttempt {
  _id: ObjectId;
  userId: ObjectId;
  lessonId: ObjectId;
  pageIndex: number;
  requestId: string;
  translation: string;
  status: JobStatus;
  feedback?: TranslationFeedback;
  error?: string | null;
  generationToken?: string;
  lockedUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}
