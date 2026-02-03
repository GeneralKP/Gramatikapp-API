import { ObjectId } from "mongodb";

export interface Phrase {
  _id: ObjectId;
  german: string;
  spanish: string;
  words?: string[];
  tags: string[];
  createdAt: Date;
  updatedAt?: Date;
}
