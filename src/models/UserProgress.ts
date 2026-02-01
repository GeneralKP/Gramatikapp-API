import mongoose, { Schema, Document, Types } from "mongoose";

export interface IUserProgress extends Document {
  userId: Types.ObjectId;
  phraseId: Types.ObjectId;
  ease: number;
  interval: number;
  repetitions: number;
  nextDueDate: Date;
  lastReviewed: Date;
}

const userProgressSchema = new Schema<IUserProgress>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    phraseId: {
      type: Schema.Types.ObjectId,
      ref: "Phrase",
      required: true,
    },
    ease: {
      type: Number,
      default: 2.5,
      min: 1.3,
    },
    interval: {
      type: Number,
      default: 0,
    },
    repetitions: {
      type: Number,
      default: 0,
    },
    nextDueDate: {
      type: Date,
      default: Date.now,
    },
    lastReviewed: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient queries
userProgressSchema.index({ userId: 1, phraseId: 1 }, { unique: true });
userProgressSchema.index({ userId: 1, nextDueDate: 1 });

export const UserProgress = mongoose.model<IUserProgress>(
  "UserProgress",
  userProgressSchema,
);
