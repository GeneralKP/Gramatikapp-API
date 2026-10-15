import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { UserProgress } from "../src/features/progress/progress.types.js";
import { initialScheduler } from "../src/features/progress/scheduler.js";
import { scheduleStudyReview } from "../src/features/progress/studyScheduling.js";

const now = new Date("2026-10-05T19:01:30.000Z");
const imported: UserProgress = {
  _id: new ObjectId("000000000000000000000001"),
  userId: new ObjectId("000000000000000000000002"),
  itemId: new ObjectId("000000000000000000000001"),
  itemType: "WORD", ease: 2.95, interval: 942, repetitions: 5,
  totalReviews: 47, lapses: 2, isNew: false,
  nextDueDate: new Date("2026-10-05T02:00:00.000Z"),
  lastReviewed: new Date("2024-03-07T10:00:00.000Z"), createdAt: now,
  anki: { type: 2, queue: 2, left: 0, reps: 47, did: 1, due: 942 },
  card: { source: "ANKI", sourceCardId: "1790000000000", sourceNoteGuid: "imported-mature",
    direction: "DE_ES", prompt: "Haus", answer: "casa", acceptedAnswers: ["casa"],
    notes: "", examples: [], deck: "Anki", tags: [] },
};

// These literal results come from the independently generated Anki 26.9.3
// fuzz fixture: REVIEW, interval=942, ease=2.95, cardId=1790000000000, reps=47.
// Exercise the real import initialization + application review boundary rather
// than preserving an unrelated legacy scheduler merely because a test calls it.
const expected = [
  { grade: "AGAIN", phase: "RELEARNING", queue: "MINUTE", interval: 1, ease: 2.75, lapses: 3, due: "2026-10-05T19:13:20.000Z" },
  { grade: "HARD", phase: "REVIEW", queue: "DAY", interval: 1158, ease: 2.8, lapses: 2, due: "2029-12-06T03:00:00.000Z" },
  { grade: "GOOD", phase: "REVIEW", queue: "DAY", interval: 2846, ease: 2.95, lapses: 2, due: "2034-07-21T02:00:00.000Z" },
  { grade: "EASY", phase: "REVIEW", queue: "DAY", interval: 3699, ease: 3.1000001, lapses: 2, due: "2036-11-20T03:00:00.000Z" },
] as const;
const original = structuredClone(imported);
const initialized = initialScheduler(imported);
assert.equal(initialized.phase, "REVIEW");
assert.equal(initialized.interval, 942, "Imported long intervals are not capped to one year");
assert.equal(initialized.ease, 2.95, "Imported ease is not capped at the legacy SM-2 default");
for (const answer of expected) {
  const next = scheduleStudyReview({ ...imported, scheduler: initialized }, answer.grade, now);
  assert.deepEqual({ phase: next.scheduler.phase, queue: next.scheduler.queue, interval: next.interval,
    lapses: next.lapses, due: next.nextDueDate.toISOString(), totalReviews: next.totalReviews,
    repetitions: next.repetitions, lastReviewed: next.lastReviewed?.toISOString() },
  { phase: answer.phase, queue: answer.queue, interval: answer.interval, lapses: answer.lapses,
    due: answer.due, totalReviews: 48, repetitions: answer.grade === "AGAIN" ? 0 : 6, lastReviewed: now.toISOString() });
  assert.ok(Math.abs(next.ease - answer.ease) < 0.00001, `${answer.grade} retains Anki's ease calculation`);
}
assert.deepEqual(structuredClone(imported), original, "Review previews leave source/import history untouched");

for (const [type, queue, left, phase, expectedQueue, remaining, seconds] of [
  [0, 0, 2002, "NEW", "NEW", 2, 60],
  [1, 1, 1001, "LEARNING", "MINUTE", 1, 600],
  [2, 2, 0, "REVIEW", "DAY", 0, 600],
  [3, 3, 1001, "RELEARNING", "DAY", 1, 600],
] as const) {
  const state = initialScheduler({ ...imported, anki: { ...imported.anki!, type, queue, left } });
  assert.deepEqual({ phase: state.phase, queue: state.queue, remaining: state.remainingSteps, seconds: state.scheduledSeconds },
    { phase, queue: expectedQueue, remaining, seconds });
}
const reviewedAfterImport = { ...imported, interval: 1234, ease: 3.1, totalReviews: 48,
  lastReviewed: new Date("2026-10-06T12:00:00.000Z"), updatedAt: new Date("2026-10-06T12:00:00.000Z"),
  anki: { ...imported.anki!, type: 0, queue: 0 } };
const current = initialScheduler(reviewedAfterImport);
assert.deepEqual({ phase: current.phase, interval: current.interval, ease: current.ease },
  { phase: "REVIEW", interval: 1234, ease: 3.1 }, "Stale raw import state cannot reset later application reviews");
console.log("PASS imported Anki initialization, four literal official mature answers, long intervals/ease and later-review preservation");
