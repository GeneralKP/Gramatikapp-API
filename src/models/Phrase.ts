import mongoose, { Schema, Document } from "mongoose";

export interface IPhrase extends Document {
  german: string;
  spanish: string;
  words?: string[];
  tags: string[];
  createdAt: Date;
}

const phraseSchema = new Schema<IPhrase>(
  {
    german: {
      type: String,
      required: true,
      trim: true,
    },
    spanish: {
      type: String,
      required: true,
      trim: true,
    },
    words: {
      type: [String],
      default: [],
    },
    tags: {
      type: [String],
      default: ["phrase"],
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

// Index for searching
phraseSchema.index({ german: "text", spanish: "text" });
phraseSchema.index({ tags: 1 });

export const Phrase = mongoose.model<IPhrase>("Phrase", phraseSchema);
