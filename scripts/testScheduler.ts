import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { readFile } from "node:fs/promises";
import { nextStates, DEFAULT_OPTIONS, fuzzFactor, studyDay, dateForStudyDay, scheduleReview } from "../src/features/progress/scheduler.js";

for (const filename of ["anki-classic.json", "anki-classic-fuzz.json"]) {
  const fixture = JSON.parse(await readFile(new URL(`fixtures/${filename}`, import.meta.url), "utf8"));
  for (const entry of fixture.cases) {
    const actual = nextStates(entry.input, { ...DEFAULT_OPTIONS, ...entry.options }, fixture.fuzz ? fuzzFactor(BigInt(entry.cardId) + BigInt(entry.reps)) : null);
    actual.forEach((state, index) => {
      const expected = entry.expected[index];
      assert.ok(Math.abs(state.ease - expected.ease) < 0.00001, `${filename} ease: ${JSON.stringify(entry)}`);
      assert.deepEqual({ ...state, ease: expected.ease }, expected, `${filename} answer ${index + 1}: ${JSON.stringify(entry.input)} ${JSON.stringify(entry.options)}`);
    });
  }
  if (fixture.fuzz) for (const entry of fixture.cases) entry.applied.forEach((expected: any, index: number) => {
    const now = new Date(expected.now), today = studyDay(now, "Europe/Berlin", 4);
    const state = { ...entry.input, version: 1, queue: entry.input.phase === "NEW" ? "NEW" : "DAY", options: { ...DEFAULT_OPTIONS, ...entry.options }, timeZone: "Europe/Berlin", rollover: 4 };
    const due = dateForStudyDay(today + entry.input.interval - entry.input.elapsedDays, "Europe/Berlin", 4);
    const p: any = { _id: new ObjectId(), itemId: new ObjectId(), userId: new ObjectId(), itemType: "WORD", scheduler: state,
      nextDueDate: due, repetitions: 5, totalReviews: entry.reps, card: { sourceCardId: entry.cardId } };
    const result = scheduleReview(p, ["AGAIN", "HARD", "GOOD", "EASY"][index] as any, now, entry.earlyReview ?? false);
    assert.equal(result.scheduler.queue, expected.queue === 1 ? "MINUTE" : "DAY");
    assert.equal(result.totalReviews, expected.reps);
    assert.equal(result.scheduler.remainingSteps, expected.remainingSteps);
    assert.equal(result.lapses, expected.lapses);
    if (expected.queue === 1) assert.ok(Math.abs(result.nextDueDate.getTime() - expected.due * 1000) <= expected.tolerance * 1000, `intraday jitter mismatch: ${JSON.stringify(entry.input)} answer ${index}`);
    else assert.equal(studyDay(result.nextDueDate, "Europe/Berlin", 4) - today, expected.due - expected.today, `day conversion mismatch: ${JSON.stringify(entry.input)} answer ${index}`);
  });

  console.log(`PASS ${fixture.cases.length * 4} official Anki ${fixture.ankiVersion} answers, fuzz=${fixture.fuzz}`);
  if (fixture.fuzz) console.log(`PASS ${fixture.cases.length * 4} applied-card queue/date checks`);
}
// The study day changes at the configured local rollover, including DST.
assert.equal(studyDay(new Date("2026-03-29T01:30:00Z"), "Europe/Berlin", 4), studyDay(new Date("2026-03-28T12:00:00Z"), "Europe/Berlin", 4));
assert.equal(dateForStudyDay(studyDay(new Date("2026-03-29T04:00:00Z"), "Europe/Berlin", 4), "Europe/Berlin", 4).toISOString(), "2026-03-29T02:00:00.000Z");
assert.equal(dateForStudyDay(studyDay(new Date("2026-10-25T04:00:00Z"), "Europe/Berlin", 4), "Europe/Berlin", 4).toISOString(), "2026-10-25T03:00:00.000Z");
console.log("PASS local rollover and both DST boundaries");
