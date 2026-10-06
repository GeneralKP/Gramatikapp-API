import { Collection, ObjectId } from "mongodb";
import { UserProgress } from "./progress.types.js";

// The counter and retry key change in a single atomic document update.
// Ordinary ratings and undo never write these fields; Revisit records its own failure.
export async function recordFailure(
  progress: Collection<UserProgress>, userId: ObjectId, itemId: ObjectId, attemptId: string,
): Promise<UserProgress> {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(attemptId)) throw new Error("Invalid attempt ID");
  await progress.updateOne(
    { userId, itemId, failureAttemptIds: { $ne: attemptId } },
    { $inc: { failureIndex: 1 }, $addToSet: { failureAttemptIds: attemptId },
      $set: { lastFailedAt: new Date(), updatedAt: new Date() } },
  );
  const result = await progress.findOne({ userId, itemId });
  if (!result) throw new Error("Study card not found");
  return result;
}
