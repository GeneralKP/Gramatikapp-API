/** Offline lexical jobs and validated checkpoint intake for the actual Codex team. */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BSON } from "mongodb";
import { buildAuditInputs, salvageWordCardBatch } from "./auditWordCards.js";
import { WORD_CARD_AUDIT_INSTRUCTIONS, WORD_CARD_AUDIT_SCHEMA, WORD_CARD_PROMPT_VERSION, WORD_CARD_REVIEW_INSTRUCTIONS, WORD_CARD_REVIEW_SCHEMA, validateWordCardDrafts, validateReviewedWordCards, type AuditWordInput, type WordCardDraft } from "./lib/wordCardPrompt.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const model = "gpt-6.1-sol";
const fail = (message: string): never => { throw new Error(message); };
const stageHash = (review: boolean) => hash(WORD_CARD_PROMPT_VERSION + (review ? WORD_CARD_REVIEW_INSTRUCTIONS : WORD_CARD_AUDIT_INSTRUCTIONS) + JSON.stringify(review ? WORD_CARD_REVIEW_SCHEMA : WORD_CARD_AUDIT_SCHEMA));
const inputHash = (entry: AuditWordInput) => hash(JSON.stringify(entry));
const stageInputHash = (entry: AuditWordInput, draft?: WordCardDraft) => draft ? hash(JSON.stringify({ entry, draft })) : inputHash(entry);
const plainRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

export function strictAgentSchema(value: unknown, schema: any, path = "response"): void {
  if (schema.type === "object") {
    if (!plainRecord(value) || Object.keys(value).some(key => !(key in schema.properties)) || schema.required.some((key: string) => !(key in value))) fail(`${path}: exact schema fields required`);
    for (const [key, child] of Object.entries(value)) strictAgentSchema(child, schema.properties[key], `${path}.${key}`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail(`${path}: schema array required`);
    for (const [index, child] of (value as unknown[]).entries()) strictAgentSchema(child, schema.items, `${path}[${index}]`);
  } else if (typeof value !== schema.type || (schema.enum && !schema.enum.includes(value))) fail(`${path}: schema value required`);
}

async function privateWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
}

async function checkpoint(path: string) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
}

interface Context {
  sourceHash: string;
  inputs: AuditWordInput[];
  firstPass: Map<string, any>;
  stage: "draft" | "independent_review";
  stagePromptHash: string;
  directory: string;
}
async function context(snapshot: string, output: string, review: boolean): Promise<Context> {
  const source = await readFile(snapshot, "utf8"), sourceHash = hash(source), inputs = buildAuditInputs(BSON.EJSON.parse(source));
  if (inputs.some(input => !/^[a-f\d]{24}$/u.test(input.id))) fail("Controlled catalog requires safe BSON ObjectId checkpoint names");
  const firstPass = new Map<string, any>();
  if (review) for (const input of inputs) {
    const saved = await checkpoint(resolve(output, "entries", `${input.id}.json`));
    if (saved?.stage === "draft" && saved.model === model && saved.sourceHash === sourceHash && saved.promptHash === stageHash(false) && saved.inputHash === inputHash(input) && !validateWordCardDrafts({ entries: [saved.draft] }, [input]).length) firstPass.set(input.id, saved);
  }
  return { sourceHash, inputs, firstPass, stage: review ? "independent_review" : "draft", stagePromptHash: stageHash(review), directory: review ? resolve(output, "review") : output };
}

export function validateAgentJob(job: any, controlled: Context) {
  const review = controlled.stage === "independent_review";
  if (!plainRecord(job) || job.version !== 1 || job.execution !== "codex-agent" || job.stage !== controlled.stage || job.sourceHash !== controlled.sourceHash || job.promptVersion !== WORD_CARD_PROMPT_VERSION || job.promptHash !== controlled.stagePromptHash || job.model !== model || job.instructions !== (review ? WORD_CARD_REVIEW_INSTRUCTIONS : WORD_CARD_AUDIT_INSTRUCTIONS) || !isDeepStrictEqual(job.schema, review ? WORD_CARD_REVIEW_SCHEMA : WORD_CARD_AUDIT_SCHEMA) || !Array.isArray(job.entries) || !job.entries.length || job.entries.length > 20) fail("Agent job must match the exact controlled source, prompt, schema and model");
  const originals = new Map(controlled.inputs.map(input => [input.id, input])), seen = new Set<string>();
  const inputs: AuditWordInput[] = [];
  for (const entry of job.entries) {
    const original = originals.get(entry?.id), draft = controlled.firstPass.get(entry?.id)?.draft;
    if (!original || seen.has(entry.id) || (review && !draft) || !isDeepStrictEqual(entry, review ? { ...original, draft } : original)) fail("Agent job lexical inputs or fallible first-pass draft changed");
    seen.add(entry.id); inputs.push(original);
  }
  return inputs;
}

export async function ingestAgentWordCards(job: any, result: unknown, controlled: Context, provenance: { agent: string; effort: string; jobSHA256: string; resultSHA256: string }) {
  if (!/^\/root\/[a-z\d_]+$/u.test(provenance.agent) || !["high", "xhigh"].includes(provenance.effort) || !/^[a-f\d]{64}$/u.test(provenance.jobSHA256) || !/^[a-f\d]{64}$/u.test(provenance.resultSHA256)) fail("Record the actual authorized GPT-6.1 agent and high/xhigh effort");
  const inputs = validateAgentJob(job, controlled), review = controlled.stage === "independent_review";
  if (review && inputs.some(input => controlled.firstPass.get(input.id)?.execution?.agent === provenance.agent)) fail("Independent review must use a different actual agent from the first-pass author");
  strictAgentSchema(result, review ? WORD_CARD_REVIEW_SCHEMA : WORD_CARD_AUDIT_SCHEMA);
  const salvaged = salvageWordCardBatch(result, inputs, review);
  const auditedAt = new Date().toISOString(), execution = { kind: "codex-agent", agent: provenance.agent, reasoningEffort: provenance.effort, jobSHA256: provenance.jobSHA256, resultSHA256: provenance.resultSHA256 };
  for (const draft of salvaged.entries) {
    const input = inputs.find(entry => entry.id === draft.id)!;
    const hashOfInput = stageInputHash(input, controlled.firstPass.get(input.id)?.draft);
    const target = resolve(controlled.directory, "entries", `${draft.id}.json`), prior = await checkpoint(target);
    if (prior?.sourceHash === controlled.sourceHash && prior.promptHash === controlled.stagePromptHash && prior.inputHash === hashOfInput && prior.model === model && !(review ? validateReviewedWordCards : validateWordCardDrafts)({ entries: [prior.draft] }, [input]).length) continue;
    await privateWrite(target, { version: 1, stage: controlled.stage, promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: controlled.stagePromptHash, sourceHash: controlled.sourceHash, inputHash: hashOfInput, model, auditedAt, execution, draft });
  }
  return { status: salvaged.remaining.length ? "agent_batch_partial" : "agent_batch_checkpointed", stage: controlled.stage, accepted: salvaged.entries.length, remainingIds: salvaged.remaining.map(input => input.id), errors: salvaged.errors };
}

/** Explicit final reconsideration; ordinary intake continues to preserve valid checkpoints. */
export async function reconsiderAgentWordCards(job: any, result: unknown, controlled: Context, provenance: Parameters<typeof ingestAgentWordCards>[3]) {
  const inputs = validateAgentJob(job, controlled), binding = job.reconsideration;
  if (controlled.stage !== "independent_review" || binding?.version !== 1 || !Array.isArray(binding.priorCheckpoints) || binding.priorCheckpoints.length !== inputs.length || !Array.isArray(binding.sourceChecks) || !binding.sourceChecks.length || typeof binding.policy !== "string" || !binding.policy.trim()) fail("Explicit reconsideration requires the prior review hashes, source checks and final policy");
  if (!/^\/root\/[a-z\d_]+$/u.test(provenance.agent) || !["high", "xhigh"].includes(provenance.effort) || ![provenance.jobSHA256, provenance.resultSHA256].every(value => /^[a-f\d]{64}$/u.test(value))) fail("Record the actual authorized GPT-6.1 final reviewer and high/xhigh effort");
  strictAgentSchema(result, WORD_CARD_REVIEW_SCHEMA);
  if (validateReviewedWordCards(result, inputs).length) fail("Every final reconsideration result must validate before reopening any checkpoint");
  const planText = await readFile(resolve(binding.planPath), "utf8"), plan = JSON.parse(planText);
  if (hash(planText) !== binding.planSHA256 || plan.stage !== "planned_final_lexical_reconsideration" || plan.sourceHash !== controlled.sourceHash || plan.formPolicy !== binding.policy || !Array.isArray(plan.entries) || inputs.some(input => !plan.entries.some((entry: any) => entry.id === input.id))) fail("Reconsideration must match the exact explicit source-bound plan");
  if (typeof plan.finalReviewPath !== "string" || !plan.finalReviewPath.trim()) fail("The reconsideration plan must identify its future frozen aggregate");
  try { await stat(resolve(plan.finalReviewPath)); fail("Final review is already frozen; reopening its source checkpoints is refused"); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const seenSources = new Set<string>();
  for (const source of binding.sourceChecks) {
    if (typeof source?.path !== "string" || seenSources.has(source.path) || !plan.sourceCheckFiles?.includes(source.path) || hash(await readFile(resolve(source.path), "utf8")) !== source.sha256) fail("Reconsideration evidence is absent, duplicated or changed");
    seenSources.add(source.path);
  }
  const seen = new Set<string>(), originals: { id: string; path: string; bytes: string; sha256: string; archive: string }[] = [];
  for (const prior of binding.priorCheckpoints) {
    const input = inputs.find(entry => entry.id === prior?.id), first = input && controlled.firstPass.get(input.id);
    if (!input || seen.has(input.id) || !/^[a-f\d]{64}$/u.test(prior.sha256)) fail("Reconsideration prior checkpoints must cover the exact job IDs once");
    seen.add(input.id);
    const path = resolve(controlled.directory, "entries", `${input.id}.json`), bytes = await readFile(path, "utf8"), saved = JSON.parse(bytes);
    if (hash(bytes) !== prior.sha256 || saved.stage !== controlled.stage || saved.sourceHash !== controlled.sourceHash || saved.promptHash !== controlled.stagePromptHash || saved.model !== model || saved.inputHash !== stageInputHash(input, first?.draft) || validateReviewedWordCards({ entries: [saved.draft] }, [input]).length) fail("Prior reconsideration checkpoint is stale or invalid");
    if (first?.execution?.agent === provenance.agent || saved.execution?.agent === provenance.agent) fail("Final reconsideration must use a different actual agent from both earlier authors");
    originals.push({ id: input.id, path, bytes, sha256: prior.sha256, archive: resolve(controlled.directory, "reconsideration-history", input.id, `${prior.sha256}.json`) });
  }
  // Validate the whole result and all bindings before any checkpoint changes.
  for (const original of originals) {
    await mkdir(dirname(original.archive), { recursive: true, mode: 0o700 }); await chmod(dirname(original.archive), 0o700);
    try { await writeFile(original.archive, original.bytes, { mode: 0o600, flag: "wx" }); }
    catch (error: any) { if (error?.code !== "EEXIST" || await readFile(original.archive, "utf8") !== original.bytes) throw error; }
    await chmod(original.archive, 0o600);
  }
  const journalPath = resolve(controlled.directory, "reconsideration-history", "jobs", `${provenance.jobSHA256}.json`);
  const journal = { version: 1, sourceHash: controlled.sourceHash, jobSHA256: provenance.jobSHA256, resultSHA256: provenance.resultSHA256, agent: provenance.agent, effort: provenance.effort, planSHA256: binding.planSHA256, priorCheckpoints: binding.priorCheckpoints, preparedAt: new Date().toISOString() };
  await privateWrite(journalPath, { ...journal, status: "prior_reviews_preserved" });
  try {
    for (const original of originals) {
      if (hash(await readFile(original.path, "utf8")) !== original.sha256) fail("Prior review changed during explicit reconsideration");
      await unlink(original.path);
    }
    const accepted = await ingestAgentWordCards(job, result, controlled, provenance);
    if (accepted.remainingIds.length || accepted.accepted !== inputs.length) fail("Final reconsideration intake did not preserve complete validated coverage");
    await privateWrite(journalPath, { ...journal, status: "reconsidered", completedAt: new Date().toISOString() });
    return { ...accepted, status: "agent_reconsideration_checkpointed", priorReviewsPreserved: originals.length };
  } catch (error) {
    // Restore only absent files; never overwrite a new result or concurrent review.
    for (const original of originals) {
      try { await writeFile(original.path, original.bytes, { flag: "wx", mode: 0o600 }); }
      catch (restore: any) { if (restore?.code !== "EEXIST") throw restore; }
    }
    await privateWrite(journalPath, { ...journal, status: "interrupted_inspect_saved_reviews" });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2), flags = new Set<string>(), values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (["--prepare", "--ingest", "--review", "--reconsider"].includes(key)) { flags.add(key); continue; }
    if (!["--snapshot", "--output", "--partition", "--partitions", "--limit", "--job", "--result", "--agent", "--effort"].includes(key) || values.has(key) || !args[index + 1] || args[index + 1].startsWith("--")) fail("Use --prepare or --ingest with --job PATH, optional --review and controlled partition/result metadata");
    values.set(key, args[++index]);
  }
  if (flags.has("--prepare") === flags.has("--ingest") || !values.has("--job")) fail("Choose exactly one offline --prepare or --ingest mode and a job path");
  if (flags.has("--reconsider") && (!flags.has("--ingest") || !flags.has("--review"))) fail("Explicit reconsideration is only available for final independent review intake");
  const number = (key: string, fallback: number, max: number) => { const value = Number(values.get(key) ?? fallback); if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`Invalid ${key}`); return value; };
  const snapshot = resolve(values.get("--snapshot") || ".local/word-prompt-audit/2026-10-08/before.ejson"), output = resolve(values.get("--output") || resolve(dirname(snapshot), "semantic-drafts"));
  const controlled = await context(snapshot, output, flags.has("--review")), jobPath = resolve(values.get("--job")!);
  if (flags.has("--prepare")) {
    const partitions = number("--partitions", 3, 16), partition = number("--partition", 0, 15), limit = number("--limit", 12, 20);
    if (!partitions || partition >= partitions || !limit) fail("Invalid controlled partition or batch limit");
    const scope = controlled.inputs.filter((_, index) => index % partitions === partition), available: AuditWordInput[] = [];
    let done = 0, waiting = 0;
    for (const input of scope) {
      const first = controlled.firstPass.get(input.id);
      if (flags.has("--review") && !first) { waiting++; continue; }
      const saved = await checkpoint(resolve(controlled.directory, "entries", `${input.id}.json`));
      if (saved?.stage === controlled.stage && saved.model === model && saved.sourceHash === controlled.sourceHash && saved.promptHash === controlled.stagePromptHash && saved.inputHash === stageInputHash(input, first?.draft) && !(flags.has("--review") ? validateReviewedWordCards : validateWordCardDrafts)({ entries: [saved.draft] }, [input]).length) done++;
      else available.push(input);
    }
    if (!available.length) { console.log(JSON.stringify({ status: waiting ? "agent_partition_waiting" : "agent_partition_complete", stage: controlled.stage, partition, total: scope.length, completed: done, waitingFirstPass: waiting })); return; }
    const selected = available.slice(0, limit);
    const job = { version: 1, execution: "codex-agent", stage: controlled.stage, sourceHash: controlled.sourceHash, promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: controlled.stagePromptHash, model, preparedAt: new Date().toISOString(), instructions: flags.has("--review") ? WORD_CARD_REVIEW_INSTRUCTIONS : WORD_CARD_AUDIT_INSTRUCTIONS, schema: flags.has("--review") ? WORD_CARD_REVIEW_SCHEMA : WORD_CARD_AUDIT_SCHEMA, entries: selected.map(input => flags.has("--review") ? { ...input, draft: controlled.firstPass.get(input.id)!.draft } : input) };
    if (jobPath === snapshot || jobPath.startsWith(`${output}/`)) fail("Agent jobs must stay separate from source and checkpoint artifacts");
    await privateWrite(jobPath, job);
    console.log(JSON.stringify({ status: "agent_batch_prepared", stage: controlled.stage, partition, selected: selected.length, completed: done, total: scope.length, pendingAvailable: available.length, waitingFirstPass: waiting, job: jobPath }));
  } else {
    if (!values.has("--result") || !values.has("--agent") || !values.has("--effort")) fail("Ingestion requires the actual result, agent and reasoning effort");
    const [jobText, resultText] = await Promise.all([readFile(jobPath, "utf8"), readFile(resolve(values.get("--result")!), "utf8")]);
    const ingest = flags.has("--reconsider") ? reconsiderAgentWordCards : ingestAgentWordCards;
    console.log(JSON.stringify(await ingest(JSON.parse(jobText), JSON.parse(resultText), controlled, { agent: values.get("--agent")!, effort: values.get("--effort")!, jobSHA256: hash(jobText), resultSHA256: hash(resultText) })));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : "Offline agent checkpoint operation failed"); process.exitCode = 1; });
