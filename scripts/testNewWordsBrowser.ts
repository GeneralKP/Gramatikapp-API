import "dotenv/config";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { generateToken } from "../src/features/auth/auth.service.js";
import { defaultUserSettings, type User } from "../src/features/auth/auth.types.js";
import { DEFAULT_OPTIONS, initialScheduler } from "../src/features/progress/scheduler.js";
import type { UserProgress } from "../src/features/progress/progress.types.js";
import { ensureNativeWordPairs } from "../src/features/progress/nativeWordPairs.js";
import { GrammaticalCategory, type Word } from "../src/features/words/words.types.js";

const require = createRequire(new URL("../../german-gramatic-web/package.json", import.meta.url));
const { chromium } = require("playwright");
const db = await connectDatabase(), userId = new ObjectId(), guid = randomUUID();
const user: User = { _id: userId, email: `new-word-test-${userId}@example.invalid`, authProvider: "email", createdAt: new Date(),
  settings: Object.fromEntries(Object.keys(defaultUserSettings).map(k => [k, false])) as any };
const options = { ...DEFAULT_OPTIONS, newPerDay: 2, reviewsPerDay: 100, newMix: 1, buryNew: true };
const make = (direction: "DE_ES" | "ES_DE", note = guid): UserProgress => {
  const id = new ObjectId();
  const p: UserProgress = { _id: id, userId, itemId: id, itemType: "WORD", isNew: true, failureIndex: 0, totalReviews: 0,
    ease: 2.5, interval: 0, repetitions: 0, nextDueDate: new Date(Date.now() - 1000), lastReviewed: null, createdAt: new Date(),
    card: { source: "ANKI", sourceCardId: String(Date.now()), sourceNoteGuid: note, direction,
      prompt: direction === "DE_ES" ? "die Angst vor" : "miedo a", answer: direction === "DE_ES" ? "miedo a" : "die Angst vor",
      acceptedAnswers: direction === "DE_ES" ? ["miedo a"] : ["die Angst vor"], notes: "", examples: [], deck: "New-word browser test", tags: [] },
    anki: { type: 0, queue: 0, left: 0, reps: 0, did: 1, due: direction === "ES_DE" ? 1 : 2 } };
  p.scheduler = initialScheduler(p, options);
  return p;
};
let reading = make("DE_ES"), typing = make("ES_DE");
const due = make("ES_DE", randomUUID());
const nativeMode = process.env.TEST_NATIVE_WORDS === "1", nativeRelation = new ObjectId();
const nativeDE: Word = { _id: new ObjectId(), word: "Angst vor", forms: { gender: "die" }, gramaticalCategories: [GrammaticalCategory.NOUN], examples: [], contexts: [], createdAt: new Date() };
const nativeES: Word = { ...nativeDE, _id: new ObjectId(), word: "miedo a", forms: {} };
due.isNew = false; due.interval = 10; due.repetitions = 2; due.totalReviews = 3;
due.lastReviewed = new Date(Date.now() - 10 * 86400000);
due.card!.prompt = "casa"; due.card!.answer = "das Haus"; due.card!.acceptedAnswers = ["das Haus"];
due.scheduler = initialScheduler(due, options);
let browser: any;
let page: any;
const queries: unknown[] = [];
try {
  await db.users.insertOne(user);
  // Prevent the globally shared native-word catalog from entering this fixture.
  await db.schedulerProfiles.insertOne({ _id: userId, timeZone: "Europe/Berlin", rollover: 4, defaultOptions: { ...options, newPerDay: 0 }, createdAt: new Date() });
  if (nativeMode) {
    await db.wordsES.insertOne(nativeES);
    await db.wordsDE.insertOne(nativeDE);
    await db.relationsWordsEsDe.insertOne({ _id: nativeRelation, main: nativeES._id, translated: nativeDE._id, createdAt: new Date() });
    const original = { ...typing, itemId: nativeRelation, relationId: nativeRelation, card: undefined, anki: undefined };
    await db.progress.insertMany([original, due]);
    const pair = await ensureNativeWordPairs([original]);
    reading = pair.find(p => p.card!.direction === "DE_ES")!;
    typing = pair.find(p => p.card!.direction === "ES_DE")!;
  } else await db.progress.insertMany([typing, due, reading]);
  browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  const errors: string[] = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("response", async (response: any) => {
    if (response.url().endsWith("/graphql") && response.request().postDataJSON()?.operationName === "DueItems") {
      const data = await response.json().catch(() => null);
      queries.push(data?.data?.dueItems?.map((p: any) => ({ prompt: p.card?.prompt, phase: p.schedulerPhase, queue: p.learningQueue })) ?? data?.errors);
    }
  });
  await context.addInitScript(({ user, token }: any) => {
    localStorage.setItem("german_gramatic_user", JSON.stringify(user));
    localStorage.setItem("german_gramatic_token", token);
    localStorage.setItem("german_gramatic_settings", JSON.stringify(user.settings));
    localStorage.setItem("i18nextLng", "en");
  }, { user: { id: userId.toString(), email: user.email, authProvider: "email", settings: user.settings }, token: generateToken(user) });
  // Study queries and mutations use the real API. Disable unrelated AI generation.
  await page.route("**/graphql", async (route: any) => {
    if (route.request().postDataJSON().operationName === "ReadingPractice") {
      await route.fulfill({ json: { data: { readingPractice: { configured: false, model: "gpt-6-luna", session: null, lesson: null } } } });
    } else await route.continue();
  });
  const heading = (name: string) => page.getByRole("heading", { name, exact: true }).waitFor();
  const type = async (answer: string, grade: string) => {
    await page.locator('input[type="text"]').fill(answer);
    await page.locator('input[type="text"]').press("Enter");
    await page.getByRole("button", { name: grade, exact: true }).click();
  };
  await page.goto(process.env.TEST_APP_URL || "http://127.0.0.1:5173/learn/words");
  await heading("casa");
  await type("das Haus", "Easy");
  await heading("die Angst vor");
  assert.equal(await page.locator('input[type="text"]').count(), 0);
  await page.getByRole("button", { name: "Show Spanish translation", exact: true }).click();
  await page.getByText("miedo a", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Good", exact: true }).click();
  await heading("miedo a");
  await page.reload();
  await heading("miedo a");
  assert.equal(await page.locator('input[type="text"]').count(), 1);
  assert.ok(!(await db.progress.findOne({ _id: typing._id }))!.buriedUntil, "the new production card is not buried after reading");
  await type("die Angst", "Good");
  await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await heading("miedo a");
  await page.getByRole("button", { name: "Good", exact: true }).waitFor();
  assert.equal(await page.getByTestId("failure-index").innerText(), "Mistakes: 1");
  assert.equal(await page.locator('input[type="text"]').inputValue(), "die Angst");
  const restored = await db.progress.findOne({ _id: typing._id });
  assert.equal(restored!.scheduler!.phase, "NEW");
  assert.equal(restored!.failureIndex, 1);
  assert.equal((await db.progress.findOne({ _id: reading._id }))!.scheduler!.phase, "LEARNING", "typing Undo does not reset recognition");
  await page.reload();
  await heading("miedo a");
  await type("die Angst vor", "Easy");
  await heading("die Angst vor");
  assert.equal(await page.locator('input[type="text"]').count(), 0);
  await page.getByRole("button", { name: "Show Spanish translation", exact: true }).click();
  await page.getByRole("button", { name: "Easy", exact: true }).click();
  await heading("Session Complete!");
  const events = await db.reviewEvents.find({ userId }).sort({ reviewedAt: 1 }).toArray();
  assert.deepEqual(events.map(e => e.itemId.toString()), [due, reading, typing, typing, reading].map(p => p.itemId.toString()));
  assert.equal(events.filter(e => e.reversedAt).length, 1);
  assert.equal((await db.progress.findOne({ _id: typing._id }))!.failureIndex, 1);
  assert.deepEqual(errors, []);
  console.log(`PASS real Chrome → GraphQL → Mongo (${nativeMode ? "native" : "Anki"}): due review, German reading, Spanish typing, reload, independent schedules and Undo with durable article/preposition mistakes`);
} catch (error) {
  console.error(JSON.stringify({ heading: await page?.locator("main h1").allTextContents(), queries,
    states: (await db.progress.find({ userId, "card.source": "ANKI" }).toArray()).map(p => ({ prompt: p.card!.prompt, phase: p.scheduler!.phase, due: p.nextDueDate, buried: p.buriedUntil })) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await db.reviewEvents.deleteMany({ userId });
  await db.progress.deleteMany({ userId });
  await db.schedulerProfiles.deleteOne({ _id: userId });
  await db.users.deleteOne({ _id: userId });
  await db.readingLessons.deleteMany({ userId });
  await db.translationAttempts.deleteMany({ userId });
  await db.relationsWordsEsDe.deleteOne({ _id: nativeRelation });
  await db.wordsES.deleteOne({ _id: nativeES._id });
  await db.wordsDE.deleteOne({ _id: nativeDE._id });
  await closeDatabase();
}
