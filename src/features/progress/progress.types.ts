import { ObjectId } from "mongodb";

export interface UserProgress {
  _id: ObjectId;
  userId: ObjectId;
  phraseId: ObjectId;
  ease: number;
  interval: number;
  repetitions: number;
  nextDueDate: Date;
  lastReviewed: Date | null;
  createdAt: Date;
  updatedAt?: Date;
}
