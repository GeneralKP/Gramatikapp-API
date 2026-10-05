import "dotenv/config";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { recordFailure } from "../src/features/progress/failures.js";
import { UserProgress } from "../src/features/progress/progress.types.js";
import { progressResolvers } from "../src/features/progress/progress.resolvers.js";
const uri = process.env.MONGODB_URI || (process.env.DB_CLUSTER ? `mongodb+srv://${process.env.DB_USER}:${process.env.DB_USER_PASSWORD}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority` : "mongodb://localhost:27017");
const client = await new MongoClient(uri).connect();
const collection = client.db("gramatikapp").collection<UserProgress>(`test_failures_${new ObjectId()}`);
const userId = new ObjectId(), itemId = new ObjectId();
try {
  await collection.insertOne({ _id: new ObjectId(), userId, itemId, itemType: "WORD", failureIndex: 17, ease: 2.5, interval: 20, repetitions: 10, nextDueDate: new Date(), lastReviewed: null, createdAt: new Date() });
  await Promise.all(Array.from({ length: 30 }, () => recordFailure(collection, userId, itemId, "same_attempt_0001")));
  assert.equal((await collection.findOne({ itemId }))!.failureIndex, 18);
  await Promise.all(["new_attempt_00001", "new_attempt_00002", "new_attempt_00003"].map(id => recordFailure(collection, userId, itemId, id)));
  assert.equal((await collection.findOne({ itemId }))!.failureIndex, 21);
  await assert.rejects(recordFailure(collection, new ObjectId(), itemId, "another_attempt_001"), /not found/);
  await assert.rejects(recordFailure(collection, userId, itemId, "bad"), /Invalid/);
  // A schedule/undo write cannot lower or reset failure tracking.
  await collection.updateOne({ itemId }, { $set: { repetitions: 0, interval: 0 } });
  await recordFailure(collection, userId, itemId, "same_attempt_0001");
  const final = await collection.findOne({ itemId });
  assert.equal(final!.failureIndex, 21);
  assert.equal(final!.failureAttemptIds!.length, 4);
  await assert.rejects(progressResolvers.Mutation.recordFailure(null, { userId: userId.toString(), itemId: itemId.toString(), attemptId: "another_attempt_001" }, { user: { _id: new ObjectId() } as any }), /Unauthorized/);
  await collection.updateOne({ itemId }, { $unset: { failureIndex: "" } });
  await recordFailure(collection, userId, itemId, "old_card_attempt_01");
  assert.equal((await collection.findOne({ itemId }))!.failureIndex, 1, "legacy cards without a counter must remain compatible");
  console.log("PASS Mongo atomic increments, concurrent retry deduplication, ownership and independent schedule writes");
} finally { await collection.drop(); await client.close(); }
