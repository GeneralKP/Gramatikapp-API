import { ObjectId } from "mongodb";
import type { User } from "../auth/auth.types.js";
import { checkReadingTranslation, generateReadingLesson, getReadingLesson, readingPractice } from "./reading.service.js";

const owner = (context: { user: User | null }) => {
  if (!context.user) throw new Error("Unauthorized");
  return context.user._id;
};
export const readingResolvers = {
  Query: {
    readingPractice: (_: unknown, __: unknown, context: { user: User | null }) => readingPractice(owner(context)),
    readingLesson: (_: unknown, { id }: { id: string }, context: { user: User | null }) => getReadingLesson(owner(context), new ObjectId(id)),
  },
  Mutation: {
    generateReadingLesson: (_: unknown, { sessionId }: { sessionId: string }, context: { user: User | null }) => generateReadingLesson(owner(context), sessionId),
    checkReadingTranslation: (_: unknown, args: { lessonId: string; pageIndex: number; translation: string; requestId: string }, context: { user: User | null }) =>
      checkReadingTranslation(owner(context), new ObjectId(args.lessonId), args.pageIndex, args.translation, args.requestId),
  },
};
