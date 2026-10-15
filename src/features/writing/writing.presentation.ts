import type { WritingAttempt, WritingExercise, WritingHint } from "./writing.types.js";

export function presentWritingAttempt(attempt: WritingAttempt) {
  return {
    id: attempt._id.toString(),
    requestId: attempt.requestId,
    translation: attempt.translation,
    status: attempt.status,
    error: attempt.error ?? null,
    feedback: attempt.feedback ?? null,
  };
}

export function presentWritingExercise(exercise: WritingExercise, lastAttempt: WritingAttempt | null, hasCompletedAttempt: boolean) {
  return {
    id: exercise._id.toString(),
    requestId: exercise.requestId,
    level: exercise.level,
    focus: exercise.focus ?? "RECENT",
    model: exercise.model,
    status: exercise.status,
    error: exercise.error ?? null,
    reinforced: !!exercise.reinforcedWords?.length,
    selectedWordIds: exercise.selectedWordIds ?? [],
    words: exercise.words,
    createdAt: exercise.createdAt.toISOString(),
    lastAttempt: lastAttempt ? presentWritingAttempt(lastAttempt) : null,
    // Any completed assessment unlocks the answer, even if a newer retry fails.
    sentence: exercise.sentence ? {
      ...exercise.sentence,
      german: hasCompletedAttempt ? exercise.sentence.german : null,
      mainClause: hasCompletedAttempt ? exercise.sentence.mainClause : null,
      subordinateClause: hasCompletedAttempt ? exercise.sentence.subordinateClause : null,
      grammarExplanation: hasCompletedAttempt ? exercise.sentence.grammarExplanation : null,
      vocabulary: hasCompletedAttempt ? exercise.sentence.vocabulary : [],
    } : null,
  };
}

export function presentWritingHint(hint: WritingHint) {
  return {
    word: hint.word,
    status: hint.status,
    german: hint.german ?? null,
    explanation: hint.explanation ?? null,
    error: hint.error ?? null,
  };
}
