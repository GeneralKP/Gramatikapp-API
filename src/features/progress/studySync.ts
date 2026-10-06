import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { recordFailure } from "./failures.js";
import { saveReview, undoReview, ReviewConflict } from "./reviews.js";
import type { StudyGrade } from "./studyScheduling.js";

export interface StudyOperation {
  id: string; kind: "FAILURE" | "REVIEW" | "UNDO"; itemId: string;
  occurredAt: string; sessionId: string; itemType?: "WORD" | "PHRASE";
  grade?: StudyGrade; expectedVersion?: number; earlyReview?: boolean; reviewId?: string;
}
const validId = (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(id);
export function validateStudyOperations(input: unknown): StudyOperation[] {
  if (!Array.isArray(input) || input.length > 100 || !input.length) throw new Error("Send 1–100 study operations per batch.");
  for (const job of input) {
    if (!job || !validId(job.id) || !validId(job.sessionId) || !ObjectId.isValid(job.itemId) || !["FAILURE", "REVIEW", "UNDO"].includes(job.kind)) throw new Error("Invalid study operation.");
    const time = Date.parse(job.occurredAt);
    if (!Number.isFinite(time) || time < Date.UTC(2000, 0, 1) || time > Date.now() + 300000) throw new Error("Invalid study time. Check your device clock.");
    if (job.kind === "REVIEW" && (!["WORD", "PHRASE"].includes(job.itemType) || !["AGAIN", "HARD", "GOOD", "EASY", "REVISIT"].includes(job.grade) || !Number.isInteger(job.expectedVersion) || job.expectedVersion < 0 || (job.earlyReview !== undefined && typeof job.earlyReview !== "boolean"))) throw new Error("Invalid review operation.");
    if (job.kind === "UNDO" && !validId(job.reviewId)) throw new Error("Invalid undo operation.");
  }
  return input;
}
// Each command commits independently. Only acknowledged IDs may leave the
// device outbox; a lost/partial response can replay the exact same batch safely.
export async function syncStudy(userId: ObjectId, input: unknown) {
  const operations = validateStudyOperations(input), results: { id: string; success: boolean; error?: string; code?: string }[] = [];
  const blocked = new Set<string>();
  for (const job of operations) {
    if (blocked.has(job.itemId) && job.kind !== "FAILURE") { results.push({ id: job.id, success: false, code: "DEPENDENCY_CONFLICT", error: "Resolve the earlier conflicting card before this operation." }); continue; }
    try {
      const itemId = new ObjectId(job.itemId);
      if (job.kind === "FAILURE") await recordFailure(getDb().progress, userId, itemId, job.id, new Date(job.occurredAt));
      else if (job.kind === "REVIEW") {
        // Forgotten recall remains a mistake even if a competing schedule wins.
        // saveReview uses this same key, so a successful Revisit adds it only once.
        if (job.grade === "REVISIT") await recordFailure(getDb().progress, userId, itemId, `revisit_${job.id}`, new Date(job.occurredAt));
        await saveReview(userId, itemId, job.itemType, job.grade, job.id, job.expectedVersion, job.earlyReview ?? false, undefined, { reviewedAt: new Date(job.occurredAt), studySessionId: job.sessionId });
      }
      else {
        const event = await getDb().reviewEvents.findOne({ userId, reviewId: job.reviewId });
        if (!event || !event.itemId.equals(itemId)) throw new Error("Review not found.");
        const card = await getDb().progress.findOne({userId,itemId});
        if (!event.reversedAt && card?.lastReviewId !== job.reviewId) throw new ReviewConflict("A newer review exists for this card. Its server schedule has been kept.",card,"STALE_CARD");
        await undoReview(userId, job.reviewId);
      }
      results.push({ id: job.id, success: true });
    } catch (error) {
      if (error instanceof ReviewConflict && error.code === "REVIEW_UNDONE") {
        // The command did commit previously; a later Undo must stay in place.
        // saveReview checked that this ID still represents the exact same review.
        results.push({id:job.id,success:true});continue;
      }
      const conflict = error instanceof ReviewConflict;
      const code = conflict ? error.code : "STUDY_SYNC_FAILED";
      if (job.kind !== "FAILURE") blocked.add(job.itemId);
      results.push({ id: job.id, success: false, code, error: conflict ? error.message : "This operation could not be synchronized. Your device copy has been retained." });
    }
  }
  return { results };
}
