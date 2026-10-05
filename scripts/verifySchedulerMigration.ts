import "dotenv/config";
import assert from "node:assert/strict";
import { BSON } from "mongodb";
import { readFile } from "node:fs/promises";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { scheduleReview, GRADES, CardState } from "../src/features/progress/scheduler.js";

const [email, referencePath, backupPath] = process.argv.slice(2);
if (!email || !referencePath || !backupPath) throw new Error("Usage: verifySchedulerMigration.ts ACCOUNT private/Anki-states.json private/backup.ejson");
const reference = JSON.parse(await readFile(referencePath, "utf8")), backup = BSON.EJSON.parse(await readFile(backupPath, "utf8"));
const normalized = (state: any): CardState => {
  const phase = Object.keys(state.normal)[0], data = state.normal[phase];
  const review = phase === "relearning" ? data.review : phase === "review" ? data : {};
  const learning = phase === "relearning" ? data.learning : phase === "learning" ? data : {};
  return { phase: phase.toUpperCase() as any, remainingSteps: learning.remaining_steps ?? 0, scheduledSeconds: learning.scheduled_secs ?? 0,
    interval: review.scheduled_days ?? 0, ease: review.ease_factor ?? 2.5, lapses: review.lapses ?? 0 };
};
const db = await connectDatabase();
try {
  const user = await db.users.findOne({ email }, { projection: { _id: 1 } });
  assert.ok(user);
  const progress = await db.progress.find({ userId: user._id }).toArray(), byId = new Map(progress.map(p => [p._id.toString(), p]));
  for (const before of backup.progress) {
    const after = byId.get(before._id.toString());
    assert.ok(after?.scheduler);
    if ((after.scheduleVersion ?? 0) === (before.scheduleVersion ?? 0)) assert.equal(after.nextDueDate.getTime(), before.nextDueDate.getTime());
    assert.ok((after.failureIndex ?? 0) >= (before.failureIndex ?? 0));
  }
  const imported = new Map(progress.filter(p => p.card?.source === "ANKI").map(p => [p.card.sourceCardId, p]));
  let comparisons = 0;
  for (const entry of reference.cases) {
    const card = imported.get(entry.cardId);
    assert.ok(card, "Source card missing");
    const current = normalized(entry.states.current);
    assert.equal(card.scheduler.phase, current.phase);
    for (let i = 0; i < GRADES.length; i++) {
      const actual = scheduleReview(card, GRADES[i], new Date(reference.now)).scheduler;
      const expected = normalized(entry.states[["again", "hard", "good", "easy"][i]]);
      const observed: CardState = { phase: actual.phase, remainingSteps: actual.remainingSteps, scheduledSeconds: actual.scheduledSeconds,
        interval: actual.interval, ease: actual.ease, lapses: actual.lapses };
      assert.ok(Math.abs(observed.ease - expected.ease) < 0.00001, `Ease mismatch for source card ${entry.cardId}`);
      assert.deepEqual({ ...observed, ease: expected.ease }, expected, `Source card ${entry.cardId}, ${GRADES[i]}`);
      comparisons++;
    }
  }
  console.log(`PASS ${comparisons} official Anki answers for all ${reference.cases.length} imported cards`);
  console.log(`PASS migration preserved dates and failures for all ${backup.progress.length} existing progress records`);
} finally { await closeDatabase(); }
