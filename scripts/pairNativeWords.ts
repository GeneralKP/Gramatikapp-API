import "dotenv/config";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { BSON } from "mongodb";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { withScheduler } from "../src/features/progress/reviews.js";
import { ensureNativeWordPairs } from "../src/features/progress/nativeWordPairs.js";

const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const email = option("--email"), apply = args.includes("--apply");
if (!email) throw new Error("Usage: tsx scripts/pairNativeWords.ts --email ACCOUNT [--apply] [--output private-directory]");
const output = resolve(option("--output") ?? "../.local/anki-import");
const db = await connectDatabase();
try {
  const user = await db.users.findOne({ email });
  assert.ok(user, "account exists");
  const stored = await db.progress.find({ userId: user._id, itemType: "WORD", card: { $exists: false }, suspended: { $ne: true }, supersededByAnki: { $ne: true } }).toArray();
  const candidates = [];
  for (const p of stored) if ((await withScheduler(p)).scheduler!.phase === "NEW") candidates.push(p);
  if (!apply) console.log(JSON.stringify({ status: "dry run", unseenNativeWords: candidates.length, existingProductionRecordsRetained: true }));
  else {
    await mkdir(output, { recursive: true });
    if (candidates.length) await writeFile(resolve(output, `native-word-pairs-before-${Date.now()}.ejson`), BSON.EJSON.stringify(candidates, { relaxed: false }), { mode: 0o600 });
    await ensureNativeWordPairs(candidates);
    const preserved = ["failureIndex", "failureAttemptIds", "lastFailedAt", "ease", "interval", "repetitions", "totalReviews", "lapses", "nextDueDate", "lastReviewed", "scheduler", "scheduleVersion", "lastReviewId"] as const;
    let paired = 0, concurrentlyReviewed = 0;
    for (const before of candidates) {
      const after = await db.progress.findOne({ _id: before._id });
      if ((after!.scheduleVersion ?? 0) !== (before.scheduleVersion ?? 0)) { concurrentlyReviewed++; continue; }
      for (const field of preserved) assert.equal(BSON.EJSON.stringify({ value: after![field] }), BSON.EJSON.stringify({ value: before[field] }), `existing ${field} preserved`);
      if (after!.card?.source === "APP") paired++;
    }
    const report = { status: "paired", account: email, newRecognitionCards: paired, existingProductionRecordsRetained: paired,
      schedulesAndFailuresPreserved: true, concurrentlyReviewed };
    await writeFile(resolve(output, "native-word-pairs-result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  }
} finally { await closeDatabase(); }
