import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { generateToken } from "../src/features/auth/auth.service.js";
import { defaultUserSettings, type User } from "../src/features/auth/auth.types.js";

const require = createRequire(new URL("../../german-gramatic-web/package.json", import.meta.url)), { chromium } = require("playwright");
const mainClause = "Der erfahrene Bürgermeister übernimmt trotz erheblicher Zweifel an der gemeinsamen Entscheidung persönlich die Verantwortung für eine gerechtere Zukunft unserer Stadt";
const subordinateClause = "weil das Vertrauen der Bürger in seine ehrlichen Versprechen nach den vergangenen schwierigen Monaten besonders stark gelitten hat";
const german = `${mainClause}, ${subordinateClause}.`, spanish = "El alcalde experimentado asume personalmente la responsabilidad de un futuro más justo para nuestra ciudad pese a sus considerables dudas sobre la decisión conjunta, porque la confianza de los ciudadanos en sus promesas sinceras ha sufrido especialmente tras los difíciles meses pasados.";
let checks = 0, hints = 0;
const provider = http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body), input = JSON.parse(request.input); let answer: any;
  assert.equal(request.model, "gpt-6-luna"); assert.equal(request.reasoning.effort, "high");
  if (request.text.format.name === "writing_feedback") {
    checks++; await new Promise(r => setTimeout(r, 2200));
    const correct = input.learnerTranslation === german;
    answer = { correct, score: correct ? 100 : 85, summary: correct ? "La traducción es correcta." : "Revisa la concordancia verbal.", correctedGerman: german,
      corrections: correct ? [] : [{ original: "übernehmen", corrected: "übernimmt", explanation: "El sujeto singular requiere la tercera persona singular.", category: "VERB_POSITION" }], alternatives: correct ? [{ german: german.replace("erfahrene", "routinierte"), mainClause: mainClause.replace("erfahrene", "routinierte"), subordinateClause, clauseOrder: "MAIN_FIRST", connector: "weil", finiteVerbs: { main: ["übernimmt"], subordinate: ["hat"] } }] : [] };
  } else { hints++; answer = { german: "die Verantwortung", explanation: "La responsabilidad asumida en esta situación." }; }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] }));
});
await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
const port = 4258, apiUrl = `http://127.0.0.1:${port}`;
const api = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "synthetic-writing-test-key", OPENAI_BASE_URL: `http://127.0.0.1:${(provider.address() as any).port}/v1` } });
let started = false; api.stdout.on("data", data => { if (data.toString().includes("Server ready")) started = true; }); api.stderr.on("data", () => undefined);
const db = await connectDatabase(), userId = new ObjectId(), otherId = new ObjectId(), exerciseId = new ObjectId();
const makeUser = (id: ObjectId): User => ({ _id: id, email: `writing-${id}@example.invalid`, authProvider: "email", createdAt: new Date(), settings: { ...defaultUserSettings, soundEnabled: false } });
const user = makeUser(userId), other = makeUser(otherId), token = generateToken(user), otherToken = generateToken(other);
let browser: any, closing = false;
const wait = async (check: () => Promise<boolean>) => { const until = Date.now() + 60000; while (Date.now() < until) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error("Writing browser operation timed out"); };
async function rest(body: any, auth = token) { return fetch(`${apiUrl}/api/translate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth ? `Bearer ${auth}` : "" }, body: JSON.stringify(body) }); }
try {
  await wait(async () => started); await db.users.insertMany([user, other]);
  await db.writingExercises.insertOne({ _id: exerciseId, userId, requestId: randomUUID(), level: "B2", status: "READY", model: "gpt-6-luna", promptVersion: 1, createdAt: new Date(), updatedAt: new Date(), words: [],
    sentence: { title: "Una decisión responsable", spanish, german, mainClause, subordinateClause, connector: "weil", clauseOrder: "MAIN_FIRST", finiteVerbs: { main: ["übernimmt"], subordinate: ["hat"] }, grammarExplanation: "El verbo conjugado va al final de la subordinada con weil.", vocabulary: [], spanishWordCount: 45, germanWordCount: 40 } });
  assert.equal((await fetch(`${apiUrl}/health`)).status, 200);
  assert.equal((await rest({ exerciseId: exerciseId.toString(), word: "responsabilidad" }, "")).status, 401);
  assert.equal((await rest({ exerciseId: "bad", word: "responsabilidad" })).status, 400);
  assert.equal((await rest({ exerciseId: exerciseId.toString(), word: "responsabilidad" }, otherToken)).status, 400);
  assert.equal((await rest({ exerciseId: exerciseId.toString(), word: "missing" })).status, 400);
  const hinted = await rest({ exerciseId: exerciseId.toString(), word: "responsabilidad" }); assert.equal(hinted.status, 200);
  await wait(async () => (await db.writingHints.findOne({ userId, exerciseId }))?.status === "READY");
  assert.equal((await (await rest({ exerciseId: exerciseId.toString(), word: "responsabilidad" })).json()).german, "die Verantwortung"); assert.equal(hints, 1);
  console.log("PASS real REST translation endpoint, authentication, ownership, word validation and persisted cache");
  browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US", hasTouch: true }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await context.addInitScript(({ token, user }: any) => { localStorage.setItem("german_gramatic_token", token); localStorage.setItem("german_gramatic_user", JSON.stringify(user)); localStorage.setItem("german_gramatic_settings", JSON.stringify(user.settings)); }, { token, user: { id: userId.toString(), email: user.email, authProvider: user.authProvider, settings: user.settings } });
  let lost = false;
  await page.route("**/graphql", async (route: any) => {
    try {
      const response = await route.fetch({ url: `${apiUrl}/graphql` });
      if (route.request().postDataJSON().operationName === "CheckWritingTranslation" && !lost) { lost = true; await route.fulfill({ status: 503, json: { errors: [{ message: "Lost response after saving" }] } }); }
      else await route.fulfill({ response });
    } catch { if (!closing) errors.push("Test API proxy failed"); }
  });
  await page.goto(`${process.env.TEST_APP_URL || "http://127.0.0.1:5173"}/writing/${exerciseId}`);
  const input = page.getByLabel("Your German translation"); await input.waitFor(); assert.equal(await page.getByTestId("german-keyboard").count(),0); assert.equal(await input.getAttribute("lang"),"de-DE");
  const wrong = german.replace("übernimmt", "übernehmen"); await input.fill(wrong); await page.reload(); await input.waitFor(); assert.equal(await input.inputValue(), wrong);
  await input.press("Enter"); await page.getByRole("alert").waitFor(); await page.reload();
  await page.getByRole("heading", { name: "A few things to revisit" }).waitFor({ timeout: 60000 }); assert.equal(checks, 1); assert.equal(await input.inputValue(), wrong);
  assert.equal(await db.writingAttempts.countDocuments({ userId }), 1);
  await input.fill(german); await input.press("Enter"); await page.getByRole("heading", { name: "Well expressed" }).waitFor({ timeout: 60000 }); await page.getByRole("heading", { name: "Other valid translations" }).waitFor(); assert.equal(checks, 2);
  const word = page.getByRole("button", { name: "Translate “responsabilidad”", exact: true });
  await word.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 10, clientY: 10 }); await page.waitForTimeout(550); await word.dispatchEvent("pointerup", { pointerType: "touch" }); await page.getByText("die Verantwortung", { exact: true }).waitFor(); assert.equal(hints, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); assert.deepEqual(errors, []);
  console.log("PASS mobile browser + real GraphQL/MongoDB: reload, lost assessment response, one saved job, correction/alternatives and touch-hold cached hint");
} finally {
  closing = true; if (browser) await browser.close();
  api.kill("SIGTERM"); if (api.exitCode === null) await once(api, "exit");
  await new Promise<void>(r => provider.close(() => r()));
  await db.writingHints.deleteMany({ userId }); await db.writingAttempts.deleteMany({ userId }); await db.writingExercises.deleteMany({ userId }); await db.progress.deleteMany({ userId: { $in: [userId, otherId] } }); await db.users.deleteMany({ _id: { $in: [userId, otherId] } }); await closeDatabase();
}
