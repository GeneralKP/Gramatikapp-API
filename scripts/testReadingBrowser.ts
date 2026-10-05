import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { ObjectId } from "mongodb";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { generateToken } from "../src/features/auth/auth.service.js";
import { defaultUserSettings, type User } from "../src/features/auth/auth.types.js";

const require = createRequire(new URL("../../german-gramatic-web/package.json", import.meta.url));
const { chromium } = require("playwright");
let generationCount = 0, correctionCount = 0;
const provider = http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body), payload = JSON.parse(request.input);
  assert.equal(request.model, "gpt-6-luna"); assert.equal(request.reasoning.effort, "high");
  let answer: any;
  if (request.text.format.name === "reading_page") {
    generationCount++;
    const examples = payload.vocabulary.map((w: any) => `Die ${w.german} beschäftigte sie an diesem Abend.`);
    const prose = "Als Clara an jenem Abend das vertraute Haus betrat, bemerkte sie, wie wenig die äußere Ordnung über die Unruhe seiner Bewohner verriet. Der Regen zeichnete feine Linien auf die Fensterscheiben, während im Nebenraum ein Gespräch verstummte, das offenbar schon seit Stunden um dieselbe Frage kreiste. Sie blieb einen Augenblick an der Tür stehen, als könnte sie durch bloßes Warten verhindern, dass die Entscheidung auch zu ihrer eigenen wurde. Dennoch wusste sie, dass Schweigen hier längst keine neutrale Haltung mehr war. Wer nichts sagte, ließ die anderen über eine Zukunft bestimmen, die alle gemeinsam tragen müssten. ";
    let german = examples.join(" ") + " " + prose;
    while (german.split(/\s+/).length < 450) german += prose;
    answer = { title: "Was zwischen den Zeilen bleibt", german: german.trim(), spanish: "Cuando Clara entró aquella noche en la casa familiar, comprendió que el silencio también era una decisión. ".repeat(25).trim(),
      vocabulary: payload.vocabulary.map((w: any, i: number) => ({ wordId: w.id, surfaceForms: [w.german], example: examples[i] })) };
  } else {
    correctionCount++;
    await new Promise(resolve => setTimeout(resolve, 3000));
    answer = { score: 84, summary: "Has entendido la escena y su tensión. Revisa la concordancia del verbo para mantener el sentido del original.",
      correctedSpanish: payload.learnerTranslation.replace("Ella estaban", "Ella estaba").replace(" Una nueva versión.", ""),
      corrections: [{ original: "Ella estaban", corrected: "Ella estaba", explanation: "El sujeto singular «ella» requiere «estaba»; el original se refiere a una sola persona.", category: "GRAMMAR" }], omissions: [],
      vocabulary: payload.vocabulary.map((w: any) => ({ wordId: w.id, understood: true, feedback: "La idea está expresada de forma adecuada en este contexto." })) };
    if (payload.learnerTranslation.includes("Una nueva versión.")) answer.corrections.push({ original: "Una nueva versión.", corrected: "", explanation: "El original no contiene esta frase añadida.", category: "MEANING" });
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] }));
});
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
// Separate API process: the regular development server never receives test credentials.
const port = 4247;
const api = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "synthetic-reading-test-key", OPENAI_BASE_URL: `http://127.0.0.1:${(provider.address() as any).port}/v1` } });
let startup = "";
api.stdout.on("data", data => { startup += data.toString(); });
api.stderr.on("data", () => undefined);
const db = await connectDatabase(), userId = new ObjectId(), ids: ObjectId[] = [], relations: ObjectId[] = [];
const user: User = { _id: userId, email: `reading-test-${userId}@example.invalid`, authProvider: "email", createdAt: new Date(), settings: { ...defaultUserSettings, soundEnabled: false } };
let browser: any, testPage: any, closing = false;
async function waitFor(check: () => Promise<boolean>, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("Reading browser check timed out");
}
try {
  await waitFor(async () => startup.includes("Server ready"));
  await db.users.insertOne(user);
  for (const [i, word] of ["Entscheidung", "Verantwortung", "Erinnerung"].entries()) {
    const de = new ObjectId(), es = new ObjectId(), relation = new ObjectId(), itemId = new ObjectId();
    ids.push(de, es); relations.push(relation);
    await db.wordsDE.insertOne({ _id: de, word, gramaticalCategories: [], examples: [], contexts: [], createdAt: new Date() } as any);
    await db.wordsES.insertOne({ _id: es, word: ["decisión", "responsabilidad", "recuerdo"][i], gramaticalCategories: [], examples: [], contexts: [], createdAt: new Date() } as any);
    await db.relationsWordsEsDe.insertOne({ _id: relation, main: es, translated: de, createdAt: new Date() });
    await db.progress.insertOne({ _id: new ObjectId(), userId, itemId, relationId: relation, itemType: "WORD", failureIndex: i, interval: 1, ease: 2.5, repetitions: 1, nextDueDate: new Date(Date.now() + 86400000), lastReviewed: new Date(), createdAt: new Date() });
    await db.reviewEvents.insertOne({ _id: new ObjectId(), userId, itemId, itemType: "WORD", reviewId: randomUUID(), reviewedAt: new Date(Date.now() - 3 * 3600000 + i * 60000), reversedAt: null } as any);
  }
  browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: "en-US" }), page = await context.newPage(), errors: string[] = [];
  testPage = page;
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await context.addInitScript(({ token, user }: any) => {
    localStorage.setItem("german_gramatic_user", JSON.stringify(user)); localStorage.setItem("german_gramatic_token", token);
    localStorage.setItem("german_gramatic_settings", JSON.stringify(user.settings)); localStorage.setItem("i18nextLng", "en");
  }, { token: generateToken(user), user: { id: userId.toString(), email: user.email, authProvider: user.authProvider, settings: user.settings } });
  // All browser GraphQL calls use the real API; only the external AI is a fixture.
  let loseCorrectionResponse = true;
  await page.route("**/graphql", async (route: any) => {
    try {
    const response = await route.fetch({ url: `http://127.0.0.1:${port}/graphql` });
    const operation = route.request().postDataJSON().operationName;
    if (operation === "CheckReadingTranslation" && loseCorrectionResponse) {
      loseCorrectionResponse = false;
      await route.fulfill({ status: 503, json: { errors: [{ message: "Synthetic lost response after saved submission" }] } });
    } else await route.fulfill({ response });
    } catch {
      if (!closing) errors.push("A browser test proxy request failed.");
    }
  });
  const appUrl = process.env.TEST_APP_URL || "http://127.0.0.1:5173";
  await page.goto(`${appUrl}/dashboard`);
  await page.getByRole("link", { name: /Your words have a story|Your story is taking shape/ }).waitFor({ timeout: 60000 });
  await page.getByRole("link", { name: /Your words have a story|Your story is taking shape/ }).click();
  await page.getByTestId("german-reading-text").waitFor({ timeout: 60000 });
  assert.equal(generationCount, 1, "dashboard automatically generates one lesson and navigation reuses it");
  assert.equal(await page.getByTestId("spanish-reference").count(), 0);
  const input = page.getByRole("textbox", { name: "Your translation", exact: true });
  const translation = "Ella estaban junto a la ventana, pensando en una decisión que exigía responsabilidad y despertaba un recuerdo de su infancia.";
  await input.fill(translation);
  await page.reload();
  await input.waitFor();
  assert.equal(await input.inputValue(), translation, "draft survives reload");
  assert.equal(generationCount, 1);
  await page.getByRole("button", { name: "Check my translation", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "How your meaning came across", exact: true }).waitFor({ timeout: 60000 });
  assert.equal(correctionCount, 1, "lost response/reload still produces only one AI check");
  await page.getByText("One possible Spanish translation", { exact: true }).click();
  assert.ok((await page.getByTestId("spanish-reference").innerText()).includes("Cuando Clara"));
  assert.ok((await page.locator("main").innerText()).includes("Ella estaba"));
  assert.equal(await input.inputValue(), translation, "feedback does not overwrite the learner's draft");
  await input.fill(translation + " Una nueva versión.");
  await page.getByText(/You have edited your draft/).waitFor();
  await page.getByRole("button", { name: "Check my translation", exact: true }).click();
  await waitFor(async () => correctionCount === 2);
  await waitFor(async () => await page.getByRole("button", { name: "Check my translation", exact: true }).count() === 1 && await page.getByText(/You have edited your draft/).count() === 0);
  await page.getByText("Remove this text", { exact: true }).waitFor();
  const originalUrl = page.url(), originalText = await page.getByTestId("german-reading-text").innerText();
  const firstCard = await db.progress.findOne({ userId, relationId: { $exists: true } });
  await db.reviewEvents.insertOne({ _id: new ObjectId(), userId, itemId: firstCard.itemId, itemType: "WORD", reviewId: randomUUID(), reviewedAt: new Date(Date.now() - 80 * 60000), reversedAt: null } as any);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitFor(async () => generationCount === 2);
  assert.equal(page.url(), originalUrl, "a newer session cannot change the current exercise URL");
  assert.equal(await page.getByTestId("german-reading-text").innerText(), originalText);
  assert.equal(await input.inputValue(), translation + " Una nueva versión.", "new-session preparation cannot erase a translation being edited");
  await waitFor(async () => await db.readingLessons.countDocuments({ userId, status: "READY" }) === 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile has no horizontal overflow");
  await page.setViewportSize({ width: 1280, height: 960 });
  await mkdir("../.local/reading-tests", { recursive: true, mode: 0o700 });
  await page.screenshot({ path: "../.local/reading-tests/reading-exercise.png", fullPage: true });
  await db.reviewEvents.insertOne({ _id: new ObjectId(), userId, itemId: firstCard.itemId, itemType: "WORD", reviewId: randomUUID(), reviewedAt: new Date(Date.now() - 40 * 60000), reversedAt: null } as any);
  await page.getByRole("link", { name: "Back to dashboard", exact: true }).click();
  await waitFor(async () => generationCount === 3);
  await waitFor(async () => await db.readingLessons.countDocuments({ userId, status: "READY" }) === 3);
  console.log("PASS returning to the dashboard in the same tab discovers the next completed session");
  assert.deepEqual(errors, []);
  console.log("PASS real Chrome/GraphQL/Mongo: automatic exercise, hidden reference, draft reload, lost response, revisions, stable text during newer sessions and mobile layout (AI fixture)");
} catch (error) {
  if (testPage && !testPage.isClosed()) {
    await mkdir("../.local/reading-tests", { recursive: true, mode: 0o700 });
    await testPage.screenshot({ path: "../.local/reading-tests/failure.png", fullPage: true }).catch(() => undefined);
    console.log("Browser state:", (await testPage.locator("main").innerText().catch(() => "unavailable")).slice(-5000));
  }
  throw error;
} finally {
  closing = true;
  await testPage?.unrouteAll({ behavior: "wait" });
  await browser?.close();
  api.kill("SIGTERM"); await once(api, "exit").catch(() => undefined);
  await db.translationAttempts.deleteMany({ userId }); await db.readingLessons.deleteMany({ userId });
  await db.reviewEvents.deleteMany({ userId }); await db.progress.deleteMany({ userId }); await db.users.deleteOne({ _id: userId });
  await db.relationsWordsEsDe.deleteMany({ _id: { $in: relations } });
  await db.wordsDE.deleteMany({ _id: { $in: ids } }); await db.wordsES.deleteMany({ _id: { $in: ids } });
  await closeDatabase(); await new Promise<void>(resolve => provider.close(() => resolve()));
}
