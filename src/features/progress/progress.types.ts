import { ObjectId } from "mongodb";
import type { SchedulerState } from "./scheduler.js";

export interface UserProgress {
  _id: ObjectId;
  userId: ObjectId;
  itemId: ObjectId;
  itemType: "WORD" | "PHRASE";
  relationId?: ObjectId;
  failureIndex?: number;
  /** Advances only for manual counter adjustments; ordinary failures remain additive. */
  failureVersion?: number;
  writingReinforcementCredit?: number;
  lastWritingReinforcedAt?: Date;
  failureAttemptIds?: string[];
  lastFailedAt?: Date;
  sourceFailureCount?: number;
  isNew?: boolean;
  suspended?: boolean;
  supersededByAnki?: boolean;
  totalReviews?: number;
  lapses?: number;
  card?: StudyCard;
  anki?: { type: number; queue: number; left: number; reps: number; did: number; odid?: number; due: number };
  scheduler?: SchedulerState;
  scheduleVersion?: number;
  lastReviewId?: string | null;
  buriedUntil?: Date | null;
  leech?: boolean;
  ease: number;
  interval: number;
  repetitions: number;
  nextDueDate: Date;
  temporaryDueDate?: Date;
  lastReviewed: Date | null;
  createdAt: Date;
  updatedAt?: Date;
}

export interface StudyCard {
  source: "ANKI" | "APP";
  sourceCardId: string;
  sourceNoteGuid: string;
  direction: "ES_DE" | "DE_ES" | "CLOZE";
  prompt: string;
  answer: string;
  acceptedAnswers: string[];
  notes: string;
  examples: string[];
  deck: string;
  tags: string[];
}
