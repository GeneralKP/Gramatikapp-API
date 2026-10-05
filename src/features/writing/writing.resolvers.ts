import { ObjectId } from "mongodb";
import type { User } from "../auth/auth.types.js";
import { checkWritingTranslation, generateWritingExercise, translateWritingWord, writingExercise, writingPractice, writingWordHint } from "./writing.service.js";
const owner = (context: { user: User | null }) => { if (!context.user) throw new Error("Unauthorized"); return context.user._id; };
export const writingResolvers = {
  Query: {
    writingPractice: (_: unknown, __: unknown, context: { user: User | null }) => writingPractice(owner(context)),
    writingExercise: (_: unknown, { id }: { id: string }, context: { user: User | null }) => writingExercise(owner(context), new ObjectId(id)),
    writingWordHint: (_: unknown, args: { exerciseId: string; word: string }, context: { user: User | null }) => writingWordHint(owner(context), new ObjectId(args.exerciseId), args.word),
  },
  Mutation: {
    generateWritingExercise: (_: unknown, args: { level: string; requestId: string }, context: { user: User | null }) => generateWritingExercise(owner(context), args.level, args.requestId),
    checkWritingTranslation: (_: unknown, args: { exerciseId: string; translation: string; requestId: string }, context: { user: User | null }) => checkWritingTranslation(owner(context), new ObjectId(args.exerciseId), args.translation, args.requestId),
    translateWritingWord: (_: unknown, args: { exerciseId: string; word: string }, context: { user: User | null }) => translateWritingWord(owner(context), new ObjectId(args.exerciseId), args.word),
  },
};
