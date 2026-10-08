import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BSON } from "mongodb";
import { WORD_CARD_AUDIT_INSTRUCTIONS, WORD_CARD_AUDIT_SCHEMA, WORD_CARD_FORM_KEYS, WORD_CARD_PROMPT_VERSION, WORD_CARD_REVIEW_INSTRUCTIONS, WORD_CARD_REVIEW_SCHEMA, validateWordCardDrafts, validateReviewedWordCards, type AuditWordInput, type WordCardDraft } from "./lib/wordCardPrompt.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const id = (value: any): string => typeof value === "string" ? value : value?.toHexString?.() || value?.$oid || value?.toString?.() || "";
const strings = (value: any): string[] => Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
const text = (value: any): string => typeof value === "string" ? value : "";
const inputHash = (entry: AuditWordInput) => hash(JSON.stringify(entry));
const promptHash = hash(WORD_CARD_PROMPT_VERSION + WORD_CARD_AUDIT_INSTRUCTIONS + JSON.stringify(WORD_CARD_AUDIT_SCHEMA));

/** Only catalog fields and deduplicated card text cross the provider boundary. */
export function buildAuditInputs(snapshot: any): AuditWordInput[] {
  const collections = snapshot.collections;
  for (const name of ["WORDS_DE", "WORDS_ES", "WORDS_ES_DE", "userprogresses"]) if (!Array.isArray(collections?.[name])) throw new Error(`Snapshot is missing ${name}`);
  const spanish = new Map<string, any>(collections.WORDS_ES.map((word: any) => [id(word._id), word]));
  const relations = new Map<string, any[]>();
  const relationGerman = new Map<string, string>();
  for (const relation of collections.WORDS_ES_DE) {
    const germanId = id(relation.translated), spanishWord = spanish.get(id(relation.main));
    if (!spanishWord) throw new Error("Snapshot has a dangling Spanish word relation; repair snapshot scope first");
    const existing = relations.get(germanId) || [];
    existing.push({ relationId: id(relation._id), spanish: { id: id(spanishWord._id), word: text(spanishWord.word), examples: strings(spanishWord.examples) } });
    relations.set(germanId, existing); relationGerman.set(id(relation._id), germanId);
  }
  const liveCards = new Map<string, Map<string, AuditWordInput["distinctLiveCards"][number]>>();
  for (const progress of collections.userprogresses) {
    if (progress.itemType !== "WORD" || !progress.card) continue;
    const germanId = relationGerman.get(id(progress.relationId)) || relationGerman.get(id(progress.itemId));
    if (!germanId) continue;
    const card = { direction: text(progress.card.direction), prompt: text(progress.card.prompt), answer: text(progress.card.answer), notes: text(progress.card.notes), examples: strings(progress.card.examples) };
    const cards = liveCards.get(germanId) || new Map(); cards.set(JSON.stringify(card), card); liveCards.set(germanId, cards);
  }
  const entries = collections.WORDS_DE.map((word: any): AuditWordInput => ({
    id: id(word._id), german: { word: text(word.word), categories: strings(word.gramaticalCategories), forms: Object.fromEntries(Object.entries(word.forms || {}).filter(([, value]) => typeof value === "string")) as Record<string, string>, notes: text(word.notes), examples: strings(word.examples) },
    translations: (relations.get(id(word._id)) || []).sort((a, b) => a.relationId.localeCompare(b.relationId)),
    distinctLiveCards: [...(liveCards.get(id(word._id))?.values() || [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  }));
  if (entries.some(entry => !entry.id) || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("Snapshot has missing/duplicate German catalog IDs");
  const germanIds = new Set(entries.map(entry => entry.id));
  if ([...relations.keys()].some(relationId => !germanIds.has(relationId))) throw new Error("Snapshot has a dangling German word relation");
  return entries;
}

async function writePrivate(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
}
class ProviderFailure extends Error {
  constructor(public kind: string, public retryable = false, public quota = false, public retryAfterMs = 0) { super(`Word audit provider failure: ${kind}`); }
}
const pause = (ms: number) => new Promise<void>(resolvePause => setTimeout(resolvePause, ms));
function usageOf(value: any) { return Object.fromEntries(["input_tokens", "output_tokens", "total_tokens"].filter(key => Number.isFinite(value?.[key])).map(key => [key, value[key]])); }

/** Only uniquely identified, individually valid source entries can be checkpointed. */
export function salvageWordCardBatch(value: unknown, inputs: AuditWordInput[], review = false): { entries: WordCardDraft[]; remaining: AuditWordInput[]; errors: string[] } {
  const expected = new Map(inputs.map(entry => [entry.id, entry]));
  if (expected.size !== inputs.length) throw new Error("Duplicate controlled input IDs");
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as any).entries)) return { entries: [], remaining: [...inputs], errors: ["response: expected entries array"] };
  const rawEntries = (value as any).entries as unknown[];
  const counts = new Map<string, number>();
  for (const raw of rawEntries) if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as any).id === "string") counts.set((raw as any).id, (counts.get((raw as any).id) || 0) + 1);
  const accepted = new Map<string, WordCardDraft>(), errors: string[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as any).id !== "string") { errors.push("entry: expected object with source id"); continue; }
    const entryId = (raw as any).id as string, input = expected.get(entryId);
    if (!input) { errors.push("entry: unexpected source id rejected"); continue; }
    if (counts.get(entryId)! > 1) { errors.push(`${entryId}: duplicate response id; all copies rejected`); continue; }
    const entryErrors = (review ? validateReviewedWordCards : validateWordCardDrafts)({ entries: [raw] }, [input]);
    if (entryErrors.length) errors.push(...entryErrors);
    else accepted.set(entryId, raw as WordCardDraft);
  }
  const remaining = inputs.filter(input => !accepted.has(input.id));
  for (const input of remaining) if (!counts.has(input.id)) errors.push(`${input.id}: missing entry`);
  return { entries: inputs.map(input => accepted.get(input.id)).filter(Boolean) as WordCardDraft[], remaining, errors: [...new Set(errors)] };
}
interface BatchResponse { entries: WordCardDraft[]; remaining: AuditWordInput[]; errors: string[]; usage: Record<string, number>; invalidDraft?: unknown }
interface CheckpointContext { options: Options; stage: string; stagePromptHash: string; sourceHash: string; stageInputHash: (entry: AuditWordInput) => string; completed: Map<string, WordCardDraft> }
async function saveSalvagedEntries(response: BatchResponse, inputs: AuditWordInput[], context: CheckpointContext, auditedAt: string) {
  const sources = new Map(inputs.map(entry => [entry.id, entry]));
  for (const draft of response.entries) {
    const sourceEntry = sources.get(draft.id);
    if (!sourceEntry) throw new Error("Unexpected checkpoint source ID");
    await writePrivate(resolve(context.options.output, "entries", `${draft.id}.json`), { version: 1, stage: context.stage, promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: context.stagePromptHash, sourceHash: context.sourceHash, inputHash: context.stageInputHash(sourceEntry), model: context.options.model, auditedAt, draft });
    context.completed.set(draft.id, draft);
  }
}

async function requestBatch(inputs: AuditWordInput[], options: Options, feedback: string[], controller: AbortController): Promise<BatchResponse> {
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl.replace(/\/$/u, "")}/responses`, { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: options.model, reasoning: { effort: "high" }, store: false, max_output_tokens: options.maxOutputTokens,
        instructions: options.review ? WORD_CARD_REVIEW_INSTRUCTIONS : WORD_CARD_AUDIT_INSTRUCTIONS, input: JSON.stringify({ promptVersion: WORD_CARD_PROMPT_VERSION, stage: options.review ? "independent_review" : "draft", entries: options.review ? inputs.map(entry => ({ ...entry, draft: options.firstPassDrafts!.get(entry.id) })) : inputs, ...(feedback.length ? { previousValidationErrors: feedback } : {}) }),
        text: { format: { type: "json_schema", name: options.review ? "word_card_semantic_review" : "word_card_audit", strict: true, schema: options.review ? WORD_CARD_REVIEW_SCHEMA : WORD_CARD_AUDIT_SCHEMA } } }),
    });
    let payload: any;
    try { payload = JSON.parse(await response.text()); } catch { throw new ProviderFailure(`HTTP_${response.status}_invalid_json`, response.status >= 500); }
    if (!response.ok) {
      // Provider bodies may echo input or configuration: inspect classification privately, never print them.
      const code = String(payload?.error?.code || payload?.error?.type || "");
      const quota = /insufficient_quota|billing_hard_limit|billing_not_active|usage_limit_reached|credit_balance_exhausted|spend_limit(?:s|_reached|_exceeded)?|budget_exceeded/iu.test(code);
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ProviderFailure(quota ? "quota_exhausted" : `HTTP_${response.status}`, !quota && [408, 409, 429, 500, 502, 503, 504].includes(response.status), quota, Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 20_000) : 0);
    }
    if (payload.status !== "completed") throw new ProviderFailure(payload.status === "incomplete" ? "incomplete_output" : "response_not_completed", true);
    const content = (payload.output || []).flatMap((item: any) => item.type === "message" ? item.content || [] : []);
    if (content.some((item: any) => item.type === "refusal")) throw new ProviderFailure("refused");
    const output = content.filter((item: any) => item.type === "output_text").map((item: any) => item.text).join("");
    let parsed: any; try { parsed = JSON.parse(output); } catch { throw new ProviderFailure("invalid_structured_output", true); }
    const partial = salvageWordCardBatch(parsed, inputs, options.review);
    feedback.splice(0, feedback.length, ...partial.errors.slice(0, 40));
    return { ...partial, usage: usageOf(payload.usage), ...(partial.errors.length ? { invalidDraft: parsed } : {}) };
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure(controller.signal.aborted ? "request_aborted_or_timed_out" : "transport_error", true);
  } finally { clearTimeout(timeout); }
}

interface Options { snapshot: string; output: string; offset: number; limit: number; batchSize: number; concurrency: number; model: string; timeoutMs: number; maxOutputTokens: number; attempts: number; apiKey: string; baseUrl: string; validateOnly: boolean; review: boolean; firstPassDrafts?: Map<string, WordCardDraft> }
function argumentsOf(): Options {
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (["--validate-only", "--self-test", "--review"].includes(argument)) { flags.add(argument); continue; }
    if (!argument.startsWith("--") || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error("Use --snapshot PATH --output DIR [--offset N --limit N --batch-size N --concurrency N --validate-only]");
    if (!["--snapshot", "--output", "--offset", "--limit", "--batch-size", "--concurrency", "--model", "--timeout-ms", "--max-output-tokens", "--attempts"].includes(argument)) throw new Error(`Unknown option ${argument}`);
    values.set(argument, process.argv[++index]);
  }
  const number = (name: string, fallback: number, min: number, max: number) => { const value = values.has(name) ? Number(values.get(name)) : fallback; if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`); return value; };
  const snapshot = resolve(values.get("--snapshot") || ".local/word-prompt-audit/2026-10-08/before.ejson");
  return { snapshot, output: resolve(values.get("--output") || `${dirname(snapshot)}/semantic-drafts`), offset: number("--offset", 0, 0, 100_000), limit: number("--limit", 100_000, 1, 100_000), batchSize: number("--batch-size", 16, 1, 20), concurrency: number("--concurrency", 3, 1, 3), model: values.get("--model") || "gpt-6.1-sol", timeoutMs: number("--timeout-ms", 240_000, 1000, 300_000), maxOutputTokens: number("--max-output-tokens", 24_000, 1000, 48_000), attempts: number("--attempts", 3, 1, 4), apiKey: process.env.OPENAI_API_KEY?.trim() || "", baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1", validateOnly: flags.has("--validate-only"), review: flags.has("--review") };
}

async function selfTest() {
  const snapshot = { collections: { WORDS_DE: [{ _id: "de", word: "Haus", forms: { gender: "das" }, gramaticalCategories: ["NOUN"] }], WORDS_ES: [{ _id: "es", word: "la casa" }], WORDS_ES_DE: [{ _id: "relation", translated: "de", main: "es" }], userprogresses: [1, 2].map(number => ({ _id: `private-progress-${number}`, userId: "private-owner", itemType: "WORD", relationId: "relation", card: { direction: "DE_ES", prompt: "Das Haus", answer: "la casa", notes: "Die Häuser", examples: ["Das Haus ist alt."] } })) } };
  const inputs = buildAuditInputs(snapshot);
  assert.equal(inputs[0].distinctLiveCards.length, 1, "identical card content is deduplicated across owners");
  assert.ok(!JSON.stringify(inputs).includes("private-"), "owner and progress identities do not cross provider boundary");
  const forms = Object.fromEntries(WORD_CARD_FORM_KEYS.map(key => [key, ""]));
  const entry = { id: "de", german: "Das Haus", category: "NOUN", forms: { ...forms, gender: "das", plural: "Die Häuser" }, notes: "Die Häuser", examples: ["Das Haus ist alt.", "Wir kaufen ein Haus."], translations: [{ relationId: "relation", spanish: "la casa", examples: ["La casa es vieja.", "Compramos una casa."] }], issues: [], confidence: "high", reviewReason: "", studyEligible: true, relatedCandidates: [] };
  assert.deepEqual(validateWordCardDrafts({ entries: [entry] }, inputs), []);
  assert.ok(validateWordCardDrafts({ entries: [{ ...entry, id: "wrong" }] }, inputs).some(error => error.includes("id")));
  assert.ok(validateWordCardDrafts({ entries: [{ ...entry, notes: "Die Häuser<br>" }] }, inputs).some(error => error.includes("HTML")));
  for (const notes of ["<!-- hidden -->", "<!DOCTYPE html>", "Die H&auml;user"]) assert.ok(validateWordCardDrafts({ entries: [{ ...entry, notes }] }, inputs).some(error => error.includes("HTML")), "Comments, doctypes and entities cannot become stored vocabulary text");
  for (const key of ["gramaticalCase", "irregularConjugations"]) assert.ok(validateWordCardDrafts({ entries: [{ ...entry, forms: { ...entry.forms, [key]: "metadata<br>" } }] }, inputs).some(error => error.includes("HTML")), "Internal linguistic metadata must also remain plain text");
  assert.ok(validateWordCardDrafts({ entries: [{ ...entry, german: "Das Haus (Nomen)" }] }, inputs).length, "German fronts cannot carry display annotations");
  for (const spanish of ["la casa (sustantivo)", "la casa (formal) (rflxv.)", "la casa (formal) (formal)"]) assert.ok(validateWordCardDrafts({ entries: [{ ...entry, translations: [{ ...entry.translations[0], spanish }] }] }, inputs).length, "Only ordered, unique trailing Spanish markers are accepted");
  assert.ok(validateWordCardDrafts({ entries: [{ ...entry, translations: [] }] }, inputs).some(error => error.includes("identities")));
  assert.ok(validateWordCardDrafts({ entries: [{ ...entry, translations: [{ ...entry.translations[0], examples: [] }] }] }, inputs).some(error => error.includes("unaligned")));
  assert.deepEqual(validateWordCardDrafts({ entries: [{ ...entry, german: "Die Häuser", forms: { ...forms, gender: "das" }, notes: "" }] }, inputs), [], "plural Die is not feminine singular evidence");
  assert.ok(validateWordCardDrafts({ entries: [{ ...entry, forms: { ...entry.forms, gender: "der" } }] }, inputs).some(error => error.includes("article/gender")));
  const reviewed = { ...entry, translations: [{ ...entry.translations[0], variant: { german: entry.german, category: entry.category, forms: entry.forms, notes: entry.notes, examples: entry.examples, confidence: entry.confidence, reviewReason: entry.reviewReason } }] };
  assert.deepEqual(validateReviewedWordCards({ entries: [reviewed] }, inputs), []);
  assert.ok(validateReviewedWordCards({ entries: [entry] }, inputs).some(error => error.includes("variant required")));
  assert.ok(validateReviewedWordCards({ entries: [{ ...reviewed, translations: [{ ...reviewed.translations[0], examples: [] }] }] }, inputs).some(error => error.includes("unaligned")));
  const batchInputs: AuditWordInput[] = Array.from({ length: 8 }, (_, index) => ({ ...inputs[0], id: `batch-${index}`, translations: [{ ...inputs[0].translations[0], relationId: `relation-${index}`, spanish: { ...inputs[0].translations[0].spanish, id: `es-${index}` } }], distinctLiveCards: [] }));
  const validEntries = batchInputs.map((input, index) => ({ ...entry, id: input.id, translations: [{ ...entry.translations[0], relationId: input.translations[0].relationId }], ...(index === 1 ? { confidence: "needs_review", reviewReason: "Lexical sense still requires semantic review" } : {}) }));
  const partialEntries = validEntries.map((draft, index) => index < 6 ? draft : { ...draft, translations: [{ ...draft.translations[0], spanish: "la casa / el hogar" }] });
  const partial = salvageWordCardBatch({ entries: partialEntries }, batchInputs);
  assert.equal(partial.entries.length, 6, "Six good entries survive two invalid Spanish slash alternatives");
  assert.deepEqual(partial.remaining.map(input => input.id), ["batch-6", "batch-7"]);
  assert.equal(partial.entries[1].confidence, "needs_review", "Structural acceptance does not upgrade semantic confidence");
  assert.deepEqual(salvageWordCardBatch({ entries: validEntries.slice(6) }, partial.remaining).remaining, []);
  const duplicate = salvageWordCardBatch({ entries: [validEntries[0], validEntries[0], ...validEntries.slice(1, 6)] }, batchInputs);
  assert.equal(duplicate.entries.length, 5);
  assert.deepEqual(duplicate.remaining.map(input => input.id), ["batch-0", "batch-6", "batch-7"], "Neither duplicate copy may be arbitrarily accepted");
  assert.ok(duplicate.errors.some(error => error.includes("missing entry")));
  const unexpected = salvageWordCardBatch({ entries: [...validEntries, { ...validEntries[0], id: "unexpected-provider-id" }] }, batchInputs);
  assert.equal(unexpected.entries.length, 8, "Unexpected IDs do not discard independently valid source entries");
  assert.ok(unexpected.errors.some(error => error.includes("unexpected source id")));
  assert.deepEqual(unexpected.remaining, []);
  assert.deepEqual(salvageWordCardBatch({ wrong: [] }, batchInputs).remaining, batchInputs);
  const reviewEntries = validEntries.map(draft => ({ ...draft, translations: [{ ...draft.translations[0], variant: { german: draft.german, category: draft.category, forms: draft.forms, notes: draft.notes, examples: draft.examples, confidence: draft.confidence, reviewReason: draft.reviewReason } }] }));
  reviewEntries[7] = { ...reviewEntries[7], translations: [{ ...reviewEntries[7].translations[0], variant: { ...reviewEntries[7].translations[0].variant, notes: "Die Häuser<br>" } }] };
  assert.equal(salvageWordCardBatch({ entries: reviewEntries }, batchInputs, true).entries.length, 7, "Independent review validates each relation variant against its own input");

  // Exercise the actual runner with a fake provider and private synthetic files.
  // This fixture has no app credentials, production connection, or network requests.
  const directory = await mkdtemp(resolve(tmpdir(), "word-card-partial-salvage-"));
  const originalArgv = process.argv, originalFetch = globalThis.fetch, originalExitCode = process.exitCode;
  const originalKey = process.env.OPENAI_API_KEY, originalBase = process.env.OPENAI_BASE_URL;
  try {
    const snapshotPath = resolve(directory, "before.ejson"), output = resolve(directory, "success"), quotaOutput = resolve(directory, "quota");
    const fixtureSnapshot = { auditedAt: "2026-10-08T10:00:00.000Z", database: "offline_self_test", collections: {
      WORDS_DE: batchInputs.map(input => ({ _id: input.id, word: input.german.word, gramaticalCategories: input.german.categories, forms: input.german.forms, notes: input.german.notes, examples: input.german.examples })),
      WORDS_ES: batchInputs.map(input => ({ _id: input.translations[0].spanish.id, word: input.translations[0].spanish.word, examples: input.translations[0].spanish.examples })),
      WORDS_ES_DE: batchInputs.map(input => ({ _id: input.translations[0].relationId, translated: input.id, main: input.translations[0].spanish.id })), userprogresses: [],
    } };
    const fixtureText = BSON.EJSON.stringify(fixtureSnapshot, { relaxed: false });
    await writeFile(snapshotPath, fixtureText, { mode: 0o600 });
    process.env.OPENAI_API_KEY = "offline-fixture-key"; process.env.OPENAI_BASE_URL = "https://offline-fixture.invalid/v1";
    const setArguments = (target: string, validateOnly = false) => { process.argv = [originalArgv[0], originalArgv[1], "--snapshot", snapshotPath, "--output", target, "--batch-size", "8", "--concurrency", "1", "--attempts", "3", "--model", "offline-fixture-model", ...(validateOnly ? ["--validate-only"] : [])]; };
    const payload = (drafts: unknown[], usage: Record<string, number>) => new Response(JSON.stringify({ status: "completed", usage, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ entries: drafts }) }] }] }), { status: 200 });
    let requests = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://offline-fixture.invalid/v1/responses");
      const body = JSON.parse(String(init?.body)), request = JSON.parse(body.input);
      requests++;
      if (requests === 1) { assert.equal(request.entries.length, 8); return payload(partialEntries, { input_tokens: 80, output_tokens: 160, total_tokens: 240 }); }
      assert.equal(requests, 2, "Only one narrowed retry is needed");
      assert.deepEqual(request.entries.map((input: any) => input.id), ["batch-6", "batch-7"]);
      assert.ok(request.previousValidationErrors.some((error: string) => error.includes("slash alternatives")));
      const saved = JSON.parse(await readFile(resolve(output, "entries", "batch-1.json"), "utf8"));
      assert.equal(saved.draft.confidence, "needs_review", "Valid checkpoints are saved before retry starts");
      assert.equal(saved.inputHash, inputHash(batchInputs[1]));
      return payload(validEntries.slice(6), { input_tokens: 20, output_tokens: 40, total_tokens: 60 });
    };
    setArguments(output); await main();
    const summary = JSON.parse(await readFile(resolve(output, "summary.json"), "utf8"));
    assert.equal(summary.selected, 8); assert.equal(summary.completed, 8); assert.equal(summary.pending, 0); assert.equal(summary.batchesFinished, 1);
    assert.equal(summary.needsReview, 1); assert.equal(summary.status, "drafts_complete");
    const metadata = JSON.parse(await readFile(resolve(output, "batches", `${hash(JSON.stringify(batchInputs)).slice(0, 20)}.json`), "utf8"));
    assert.deepEqual(metadata.usage, { input_tokens: 100, output_tokens: 200, total_tokens: 300 });
    assert.deepEqual(metadata.responses.map((response: any) => response.inputIds.length), [8, 2]);
    assert.equal(metadata.drafts.length, 8); assert.equal(metadata.pending, 0);
    assert.equal((await stat(resolve(output, "entries", "batch-0.json"))).mode & 0o777, 0o600);
    const { readdir } = await import("node:fs/promises");
    const invalidNames = await readdir(resolve(output, "invalid"));
    assert.equal(invalidNames.length, 1); assert.equal((await stat(resolve(output, "invalid", invalidNames[0]))).mode & 0o777, 0o600);
    const invalidRecord = JSON.parse(await readFile(resolve(output, "invalid", invalidNames[0]), "utf8"));
    assert.equal(invalidRecord.draft.entries.length, 8); assert.ok(!("providerBody" in invalidRecord));

    requests = 0;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(JSON.parse(String(init?.body)).input); requests++;
      assert.ok(request.entries.every((input: any) => input.draft?.id === input.id), "Review retries retain the original first-pass cache");
      if (requests === 1) return payload(reviewEntries, { total_tokens: 240 });
      assert.deepEqual(request.entries.map((input: any) => input.id), ["batch-7"]);
      return payload([{ ...reviewEntries[7], translations: [{ ...reviewEntries[7].translations[0], variant: { ...reviewEntries[7].translations[0].variant, notes: entry.notes } }] }], { total_tokens: 30 });
    };
    setArguments(output); process.argv.push("--review"); await main();
    const reviewSummary = JSON.parse(await readFile(resolve(output, "review", "summary.json"), "utf8"));
    assert.equal(reviewSummary.stage, "independent_review"); assert.equal(reviewSummary.completed, 8); assert.equal(reviewSummary.batchesFinished, 1);
    const reviewCheckpoint = JSON.parse(await readFile(resolve(output, "review", "entries", "batch-7.json"), "utf8"));
    assert.equal(reviewCheckpoint.inputHash, hash(JSON.stringify({ entry: batchInputs[7], draft: validEntries[7] })), "Review checkpoints retain their individual source-plus-first-pass hash");

    requests = 0;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(JSON.parse(String(init?.body)).input); requests++;
      if (requests === 1) return payload(partialEntries, { total_tokens: 240 });
      assert.deepEqual(request.entries.map((input: any) => input.id), ["batch-6", "batch-7"]);
      return new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "PRIVATE_PROVIDER_ERROR_MUST_NOT_BE_WRITTEN" } }), { status: 429 });
    };
    setArguments(quotaOutput); await main();
    const stopped = JSON.parse(await readFile(resolve(quotaOutput, "summary.json"), "utf8"));
    assert.equal(stopped.completed, 6); assert.equal(stopped.pending, 2); assert.equal(stopped.batchesFinished, 0); assert.equal(stopped.failureKind, "quota_exhausted");
    assert.equal((await readdir(resolve(quotaOutput, "entries"))).length, 6, "Quota failure keeps all six valid checkpoints");
    assert.equal((await readdir(resolve(quotaOutput, "invalid"))).length, 1, "Raw provider error bodies must not become invalid draft records");
    const quotaInvalid = await readFile(resolve(quotaOutput, "invalid", (await readdir(resolve(quotaOutput, "invalid")))[0]), "utf8");
    assert.ok(!quotaInvalid.includes("PRIVATE_PROVIDER_ERROR_MUST_NOT_BE_WRITTEN"));
    setArguments(quotaOutput, true); await main();
    assert.equal(requests, 2, "Checkpoint validation never calls the provider");
    const resumed = JSON.parse(await readFile(resolve(quotaOutput, "summary.json"), "utf8"));
    assert.equal(resumed.resumed, 6); assert.equal(resumed.pending, 2); assert.equal(resumed.sourceHash, hash(fixtureText));
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(JSON.parse(String(init?.body)).input);
      assert.deepEqual(request.entries.map((input: any) => input.id), ["batch-6", "batch-7"]);
      return payload(validEntries.slice(6), { total_tokens: 60 });
    };
    setArguments(quotaOutput); await main();
    const finished = JSON.parse(await readFile(resolve(quotaOutput, "summary.json"), "utf8"));
    assert.equal(finished.resumed, 6); assert.equal(finished.completed, 8); assert.equal(finished.selected, 8); assert.equal(finished.pending, 0);
  } finally {
    process.argv = originalArgv; globalThis.fetch = originalFetch; process.exitCode = originalExitCode;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = originalBase;
    await rm(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: "self_test_passed", checks: ["plain-text structural validation", "relation review variants", "six-valid two-invalid salvage", "duplicate and missing ID rejection", "unexpected ID isolation", "narrowed retries and cumulative usage", "private immediate checkpoints", "quota stop and safe resume", "semantic confidence preserved"] }));
}

async function main() {
  if (process.argv.includes("--self-test")) { await selfTest(); return; }
  const options = argumentsOf();
  const sourceText = await readFile(options.snapshot, "utf8"), sourceHash = hash(sourceText);
  const inputs = buildAuditInputs(BSON.EJSON.parse(sourceText));
  const selected = inputs.slice(options.offset, options.offset + options.limit);
  if (!selected.length) throw new Error("No entries selected; check --offset and --limit");
  const stage = options.review ? "independent_review" : "draft";
  const stagePromptHash = options.review ? hash(WORD_CARD_PROMPT_VERSION + WORD_CARD_REVIEW_INSTRUCTIONS + JSON.stringify(WORD_CARD_REVIEW_SCHEMA)) : promptHash;
  if (options.review) {
    options.firstPassDrafts = new Map();
    for (const entry of selected) {
      let checkpoint: any;
      try { checkpoint = JSON.parse(await readFile(resolve(options.output, "entries", `${entry.id}.json`), "utf8")); } catch { throw new Error("Snapshot review requires complete valid first-pass checkpoints for the selected scope"); }
      if (checkpoint.sourceHash !== sourceHash || checkpoint.promptHash !== promptHash || checkpoint.inputHash !== inputHash(entry) || validateWordCardDrafts({ entries: [checkpoint.draft] }, [entry]).length) throw new Error("Snapshot review requires complete valid first-pass checkpoints for the selected scope");
      options.firstPassDrafts.set(entry.id, checkpoint.draft);
    }
    options.output = resolve(options.output, "review");
  }
  const stageInputHash = (entry: AuditWordInput) => options.review ? hash(JSON.stringify({ entry, draft: options.firstPassDrafts!.get(entry.id) })) : inputHash(entry);
  await mkdir(options.output, { recursive: true, mode: 0o700 }); await chmod(options.output, 0o700);
  const completed = new Map<string, WordCardDraft>(), pending: AuditWordInput[] = [], invalid: string[] = [];
  for (const entry of selected) {
    try {
      const checkpoint = JSON.parse(await readFile(resolve(options.output, "entries", `${entry.id}.json`), "utf8"));
      if (checkpoint.sourceHash !== sourceHash || checkpoint.promptHash !== stagePromptHash || checkpoint.inputHash !== stageInputHash(entry) || checkpoint.model !== options.model || (options.review ? validateReviewedWordCards : validateWordCardDrafts)({ entries: [checkpoint.draft] }, [entry]).length) { invalid.push(entry.id); pending.push(entry); }
      else completed.set(entry.id, checkpoint.draft);
    } catch (error: any) { if (error?.code !== "ENOENT") invalid.push(entry.id); pending.push(entry); }
  }
  const resumed = completed.size;
  console.log(JSON.stringify({ status: options.validateOnly ? "validating_checkpoints" : "audit_started", stage, selected: selected.length, resumed, pending: pending.length, invalidCheckpoints: invalid.length, batchSize: options.batchSize, concurrency: options.concurrency, model: options.model }));
  if (!options.validateOnly && pending.length && !options.apiKey) throw new Error("OPENAI_API_KEY is required; no database connection is used");
  let stopped = false, failureKind = "", nextBatch = 0, batchesFinished = 0;
  const controllers = new Set<AbortController>();
  const batches: AuditWordInput[][] = [];
  for (let index = 0; index < pending.length; index += options.batchSize) batches.push(pending.slice(index, index + options.batchSize));
  if (!options.validateOnly) await Promise.all(Array.from({ length: Math.min(options.concurrency, batches.length) }, async () => {
    while (!stopped) {
      const batchIndex = nextBatch++; if (batchIndex >= batches.length) return;
      const batch = batches[batchIndex], feedback: string[] = [], batchHash = hash(JSON.stringify(batch));
      const responses: { attempt: number; inputIds: string[]; validIds: string[]; validationErrors: number; usage: Record<string, number>; auditedAt: string }[] = [];
      const cumulativeUsage: Record<string, number> = {};
      for (let attempt = 1; attempt <= options.attempts && !stopped; attempt++) {
        const remaining = batch.filter(entry => !completed.has(entry.id));
        const controller = new AbortController(); controllers.add(controller);
        try {
          const response = await requestBatch(remaining, options, feedback, controller);
          const auditedAt = new Date().toISOString();
          // Persist paid, individually valid work before reports or another provider request.
          await saveSalvagedEntries(response, remaining, { options, stage, stagePromptHash, sourceHash, stageInputHash, completed }, auditedAt);
          responses.push({ attempt, inputIds: remaining.map(entry => entry.id), validIds: response.entries.map(entry => entry.id), validationErrors: response.errors.length, usage: response.usage, auditedAt });
          for (const [key, value] of Object.entries(response.usage)) cumulativeUsage[key] = (cumulativeUsage[key] || 0) + value;
          const batchDrafts = batch.map(entry => completed.get(entry.id)).filter(Boolean) as WordCardDraft[];
          await writePrivate(resolve(options.output, "batches", `${batchHash.slice(0, 20)}.json`), { version: 1, stage, promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: stagePromptHash, sourceHash, model: options.model, auditedAt, inputIds: batch.map(entry => entry.id), inputHash: batchHash, usage: cumulativeUsage, responses, completed: batchDrafts.length, pending: batch.length - batchDrafts.length, drafts: batchDrafts });
          if (response.errors.length) await writePrivate(resolve(options.output, "invalid", `${batchHash.slice(0, 20)}-${Date.now()}-${attempt}.json`), { stage, inputIds: remaining.map(entry => entry.id), errors: response.errors, draft: response.invalidDraft });
          if (response.remaining.length) {
            console.log(JSON.stringify({ status: "batch_partial", batch: batchIndex + 1, batches: batches.length, attempt, entries: response.entries.length, batchEntries: batch.length, remaining: response.remaining.length, completed: completed.size, selected: selected.length, validationErrors: response.errors.length, usage: response.usage }));
            throw new ProviderFailure("validation_failed", true);
          }
          batchesFinished++;
          console.log(JSON.stringify({ status: "batch_completed", batch: batchIndex + 1, batches: batches.length, entries: batch.length, completed: completed.size, selected: selected.length, needsReview: batchDrafts.filter(entry => entry.confidence === "needs_review").length, validationErrors: response.errors.length, usage: response.usage, cumulativeUsage }));
          break;
        } catch (error) {
          const failure = error instanceof ProviderFailure ? error : new ProviderFailure("checkpoint_write_failed");
          if (stopped) break;
          console.log(JSON.stringify({ status: "batch_attempt_failed", batch: batchIndex + 1, attempt, kind: failure.kind, validationErrors: feedback.length, remaining: batch.filter(entry => !completed.has(entry.id)).length }));
          if (failure.quota || !failure.retryable || attempt === options.attempts) {
            stopped = true; failureKind = failure.kind; for (const active of controllers) active.abort(); break;
          }
          await pause(Math.max(failure.retryAfterMs, Math.min(1000 * 3 ** (attempt - 1), 15_000)));
        } finally { controllers.delete(controller); }
      }
    }
  }));
  const drafts = selected.map(entry => completed.get(entry.id)).filter(Boolean) as WordCardDraft[];
  const summary = { version: 1, stage, promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: stagePromptHash, sourceHash, snapshotAuditedAt: BSON.EJSON.parse(sourceText).auditedAt, auditedAt: new Date().toISOString(), model: options.model, offset: options.offset, selected: selected.length, completed: drafts.length, resumed, invalidCheckpoints: invalid.length, pending: selected.length - drafts.length, batchesFinished, status: options.validateOnly ? (drafts.length === selected.length ? "checkpoints_valid" : "checkpoints_incomplete") : stopped ? "stopped" : "drafts_complete", ...(failureKind ? { failureKind } : {}), highConfidence: drafts.filter(entry => entry.confidence === "high").length, needsReview: drafts.filter(entry => entry.confidence === "needs_review").length, studyEligible: drafts.filter(entry => entry.studyEligible).length, relatedCandidateCount: drafts.reduce((sum, entry) => sum + entry.relatedCandidates.length, 0), notice: "Linguistic drafts and structural validation do not prove source-verified correctness. No database mutations performed." };
  await writePrivate(resolve(options.output, "summary.json"), summary);
  await writePrivate(resolve(options.output, "drafts.json"), { ...summary, entries: drafts });
  console.log(JSON.stringify(summary));
  if (stopped || (options.validateOnly && drafts.length !== selected.length)) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("auditWordCards.ts") || process.argv[1]?.endsWith("auditWordCards.js")) main().catch(error => {
  // Avoid raw provider/transport errors or their possible credentials/input echoes.
  console.error(JSON.stringify({ status: "failed", reason: error instanceof ProviderFailure ? error.kind : error?.code === "ENOENT" ? "snapshot_or_file_missing" : error instanceof Error && /^(?:Snapshot |No entries|OPENAI_API_KEY|Invalid --|Unknown option|Use --)/u.test(error.message) ? error.message : "local_audit_failed" }));
  process.exitCode = 1;
});
