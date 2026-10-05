import "dotenv/config";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { generateToken } from "../src/features/auth/auth.service.js";
import { defaultUserSettings, User } from "../src/features/auth/auth.types.js";
import { DEFAULT_OPTIONS, initialScheduler, studyDay } from "../src/features/progress/scheduler.js";
import type { UserProgress } from "../src/features/progress/progress.types.js";

const require = createRequire(new URL("../../german-gramatic-web/package.json", import.meta.url));
const { chromium } = require("playwright");
const db = await connectDatabase(), userId = new ObjectId();
const user: User = { _id: userId, email: `scheduler-test-${userId}@example.invalid`, authProvider: "email", createdAt: new Date(),
  settings: Object.fromEntries(Object.keys(defaultUserSettings).map(k => [k, false])) as any };
const options = { ...DEFAULT_OPTIONS, newPerDay: 2, reviewsPerDay: 100 };
let browser: any;
try {
  await db.users.insertOne(user);
  await db.schedulerProfiles.insertOne({ _id: userId, timeZone: "Europe/Berlin", rollover: 4, defaultOptions: options, createdAt: new Date(),
    baselines: [{ day: studyDay(new Date(), "Europe/Berlin", 4), deck: "App", new: 2, review: 0 }] });
  const cards: UserProgress[] = [ ["casa", "Das Haus"], ["perro", "Der Hund"] ].map(([prompt, answer], i) => {
    const id = new ObjectId();
    const p: UserProgress = { _id: id, userId, itemId: id, itemType: "WORD", isNew: true, failureIndex: 0, totalReviews: 0,
      ease: 2.5, interval: 0, repetitions: 0, nextDueDate: new Date(Date.now() - 1000), lastReviewed: null, createdAt: new Date(),
      card: { source: "ANKI", sourceCardId: String(1790000000000 + i), sourceNoteGuid: randomUUID(), direction: "ES_DE", prompt, answer, acceptedAnswers: [answer], notes: "Synthetic integration test", examples: [], deck: "Synthetic integration", tags: [] } };
    p.scheduler = initialScheduler(p, options);
    return p;
  });
  await db.progress.insertMany(cards);
  browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await context.addInitScript(({ user, token }: any) => {
    localStorage.setItem("german_gramatic_user", JSON.stringify(user));
    localStorage.setItem("german_gramatic_token", token);
    localStorage.setItem("german_gramatic_settings", JSON.stringify(user.settings));
    localStorage.setItem("i18nextLng", "en");
  }, { user: { id: userId.toString(), email: user.email, authProvider: "email", settings: user.settings }, token: generateToken(user) });
  // No GraphQL routes are mocked: the page uses the running API and MongoDB.
  await page.goto(process.env.TEST_APP_URL || "http://127.0.0.1:5173/learn/words");
  const heading = (prompt: string) => page.getByRole("heading", { name: prompt, exact: true }).waitFor();
  const answer = async (text: string, grade: string) => {
    await page.locator('input[type="text"]').fill(text);
    await page.locator('input[type="text"]').press("Enter");
    await page.getByRole("button", { name: grade, exact: true }).click();
  };
  await heading("casa");
  await answer("wrong", "Again");
  await heading("perro");
  await answer("Der Hund", "Good");
  await heading("casa");
  assert.equal(await page.getByTestId("failure-index").innerText(), "Mistakes: 1");
  await answer("Das Haus", "Easy");
  await heading("perro");
  await answer("Der Hund", "Easy");
  await heading("Session Complete!");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Good", exact: true }).waitFor();
  const undone = await db.progress.findOne({ _id: cards[1]._id });
  assert.equal(undone.scheduler.phase, "LEARNING");
  assert.equal(undone.totalReviews, 1);
  assert.equal((await db.progress.findOne({ _id: cards[0]._id })).failureIndex, 1);
  await page.reload();
  await heading("perro");
  await answer("Der Hund", "Easy");
  await heading("Session Complete!");
  const events = await db.reviewEvents.find({ userId }).toArray();
  assert.equal(events.length, 5);
  assert.equal(events.filter(e => e.reversedAt).length, 1);
  assert.equal((await db.progress.findOne({ _id: cards[1]._id })).scheduler.phase, "REVIEW");
  await page.getByRole("button", { name: "Study 10 more", exact: true }).click();
  await page.getByRole("heading", { name: /^(casa|perro)$/ }).waitFor();
  const prompt = await page.locator("main h1").innerText();
  const practiced = cards.find(p => p.card.prompt === prompt);
  const oldState = await db.progress.findOne({ _id: practiced._id });
  await answer(practiced.card.answer, "Hard");
  const deadline = Date.now() + 5000;
  let extra;
  do { extra = await db.reviewEvents.findOne({ userId, earlyReview: true }); if (!extra) await page.waitForTimeout(50); } while (!extra && Date.now() < deadline);
  assert.ok(extra, "Study More must send the early-review context");
  assert.ok((await db.progress.findOne({ _id: practiced._id })).interval < oldState.interval, "early Hard should use the filtered-deck interval");
  assert.deepEqual(errors, []);
  console.log("PASS real Chrome → GraphQL → Mongo: learning reappearance, previews, durable mistakes, server Undo, reload and early Study More");
} finally {
  await browser?.close();
  await db.reviewEvents.deleteMany({ userId });
  await db.progress.deleteMany({ userId });
  await db.schedulerProfiles.deleteOne({ _id: userId });
  await db.users.deleteOne({ _id: userId });
  await closeDatabase();
}
