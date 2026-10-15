import { ObjectId } from "mongodb";
import { requireUserId, type AuthContext } from "../auth/auth.context.js";
import {
  checkReadingTranslation,
  generateReadingLesson,
  getReadingLesson,
  readingPractice,
} from "./reading.service.js";

export const readingResolvers = {
  Query: {
    readingPractice: (_: unknown, __: unknown, context: AuthContext) =>
      readingPractice(requireUserId(context)),
    readingLesson: (_: unknown, { id }: { id: string }, context: AuthContext) =>
      getReadingLesson(requireUserId(context), new ObjectId(id)),
  },
  Mutation: {
    generateReadingLesson: (_: unknown, { sessionId }: { sessionId: string }, context: AuthContext) =>
      generateReadingLesson(requireUserId(context), sessionId),
    checkReadingTranslation: (
      _: unknown,
      args: { lessonId: string; pageIndex: number; translation: string; requestId: string },
      context: AuthContext,
    ) => checkReadingTranslation(
      requireUserId(context),
      new ObjectId(args.lessonId),
      args.pageIndex,
      args.translation,
      args.requestId,
    ),
  },
};
