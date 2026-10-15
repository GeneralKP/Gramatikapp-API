import { ObjectId } from "mongodb";
import { requireUserId, type AuthContext } from "../auth/auth.context.js";
import {
  checkWritingTranslation,
  generateWritingExercise,
  translateWritingWord,
  writingExercise,
  writingPractice,
  writingWordHint,
} from "./writing.service.js";
import { difficultWritingWords } from "./vocabulary.js";

export const writingResolvers = {
  Query: {
    difficultWritingWords: (_: unknown, args: { level: string; limit?: number }, context: AuthContext) =>
      difficultWritingWords(requireUserId(context), args.level, args.limit),
    writingPractice: (_: unknown, __: unknown, context: AuthContext) =>
      writingPractice(requireUserId(context)),
    writingExercise: (_: unknown, { id }: { id: string }, context: AuthContext) =>
      writingExercise(requireUserId(context), new ObjectId(id)),
    writingWordHint: (_: unknown, args: { exerciseId: string; word: string }, context: AuthContext) =>
      writingWordHint(requireUserId(context), new ObjectId(args.exerciseId), args.word),
  },
  Mutation: {
    generateWritingExercise: (
      _: unknown,
      args: { level: string; requestId: string; focus?: string; wordIds?: string[] },
      context: AuthContext,
    ) => generateWritingExercise(
      requireUserId(context),
      args.level,
      args.requestId,
      args.focus ?? "RECENT",
      args.wordIds ?? [],
    ),
    checkWritingTranslation: (
      _: unknown,
      args: { exerciseId: string; translation: string; requestId: string },
      context: AuthContext,
    ) => checkWritingTranslation(
      requireUserId(context),
      new ObjectId(args.exerciseId),
      args.translation,
      args.requestId,
    ),
    translateWritingWord: (_: unknown, args: { exerciseId: string; word: string }, context: AuthContext) =>
      translateWritingWord(requireUserId(context), new ObjectId(args.exerciseId), args.word),
  },
};
