import { ObjectId } from "mongodb";

export interface UserProgress {
  _id: ObjectId;
  userId: ObjectId;
  itemId: ObjectId;
  itemType: "WORD" | "PHRASE";
  ease: number;
  interval: number;
  repetitions: number;
  nextDueDate: Date;
  lastReviewed: Date | null;
  createdAt: Date;
  updatedAt?: Date;
}
