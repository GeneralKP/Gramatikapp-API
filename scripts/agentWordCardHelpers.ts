/** Offline, source-bound lexical jobs for candidate, answer and CEFR decisions. */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BSON } from "mongodb";
import { strictAgentSchema } from "./agentWordCardAudit.js";
import { ANSWER_REVIEW_INSTRUCTIONS, ANSWER_REVIEW_MODEL, ANSWER_REVIEW_PROMPT_HASH, ANSWER_REVIEW_SCHEMA, ANSWER_REVIEW_VERSION, buildAnswerReviewInputs, validateAnswerReviewDecisions } from "./reviewWordCardAnswers.js";
import { CANDIDATE_DECISION_INSTRUCTIONS, CANDIDATE_DECISION_SCHEMA, CANDIDATE_HELPER_MODEL, CANDIDATE_HELPER_VERSION, INSERTION_CLASSIFICATION_INSTRUCTIONS, INSERTION_CLASSIFICATION_SCHEMA, buildCandidateReviewInputs, buildInsertionClassificationInputs, validateCandidateDecisions, validateInsertionClassifications } from "./reviewWordCardCandidates.js";
import { buildFinalCandidateInputs, FINAL_CANDIDATE_VERSION, FINAL_CANDIDATE_MODEL, FINAL_CANDIDATE_INSTRUCTIONS, FINAL_CANDIDATE_SCHEMA, FINAL_CANDIDATE_PROMPT_HASH, validateFinalCandidateDecisions, validateFinalCandidateProof } from "./reviewFinalWordCardCandidates.js";

export type HelperMode = "dedup" | "answers" | "classify" | "final";
export interface HelperContext {
  mode: HelperMode;
  metadata: Record<string, any>;
  inputs: any[];
  instructions: string;
  schema: any;
  output: string;
  protectedPaths: string[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => { throw new Error(message); };
const key = (input: any): string => input.candidateId || input.id;
const validators = { dedup: validateCandidateDecisions, answers: validateAnswerReviewDecisions, classify: validateInsertionClassifications, final: validateFinalCandidateDecisions };

export async function helperContext(mode: HelperMode, sources: { snapshot?: string; review?: string; ambiguous?: string; manifest?: string; additionsReview?: string; additionsMap?: string; provenance?: string }, output: string): Promise<HelperContext> {
  const required = mode === "dedup" ? ["ambiguous", "review"] : mode === "answers" ? ["snapshot", "review"] : mode === "final" ? ["review", "additionsReview", "additionsMap", "provenance"] : ["manifest", "snapshot"];
  if (required.some(name => !(sources as any)[name])) fail("Supply the exact complete source files required by this helper stage");
  const raws = Object.fromEntries(await Promise.all(required.map(async name => [name, await readFile((sources as any)[name], "utf8")])));
  let inputs: any[], metadata: Record<string, any>, instructions: string, schema: any;
  if (mode === "final") {
    const catalog = JSON.parse(raws.review), additions = JSON.parse(raws.additionsReview), map = JSON.parse(raws.additionsMap), provenance = JSON.parse(raws.provenance);
    if (map.reviewHash !== hash(raws.review) || provenance.reviewSHA256 !== hash(raws.additionsReview)) fail("Final seed approval must bind exact catalog/addition review bytes");
    inputs = buildFinalCandidateInputs(catalog, additions, map, provenance);
    const bindings = { catalogReviewSHA256: hash(raws.review), additionReviewSHA256: hash(raws.additionsReview), candidateMapSHA256: hash(raws.additionsMap), provenanceSHA256: hash(raws.provenance) };
    instructions = FINAL_CANDIDATE_INSTRUCTIONS; schema = FINAL_CANDIDATE_SCHEMA;
    metadata = {version:1, helperVersion:FINAL_CANDIDATE_VERSION, mode, sourceHash:hash(JSON.stringify(bindings)), scopeHash:hash(JSON.stringify(inputs)), promptHash:FINAL_CANDIDATE_PROMPT_HASH, model:FINAL_CANDIDATE_MODEL, bindings, totalScope:inputs.length, offset:0, selected:inputs.length};
  } else if (mode === "answers") {
    const sourceHash = hash(raws.snapshot), reviewHash = hash(raws.review), review = JSON.parse(raws.review);
    if (review.sourceHash !== sourceHash) fail("Answer review must match the exact original snapshot bytes");
    const prepared = buildAnswerReviewInputs(BSON.EJSON.parse(raws.snapshot), review);
    inputs = prepared.inputs; instructions = ANSWER_REVIEW_INSTRUCTIONS; schema = ANSWER_REVIEW_SCHEMA;
    metadata = { version: 1, stage: "word_card_answer_review", helperVersion: ANSWER_REVIEW_VERSION, sourceHash, reviewHash, inputsHash: hash(JSON.stringify(inputs)), promptHash: ANSWER_REVIEW_PROMPT_HASH, model: ANSWER_REVIEW_MODEL, coverage: prepared.coverage };
  } else {
    let sourceHash: string, bindings: Record<string, string>;
    if (mode === "dedup") {
      const ambiguous = JSON.parse(raws.ambiguous), reviewHash = hash(raws.review);
      if (ambiguous.reviewHash !== reviewHash) fail("Candidate proposals must match the exact final review bytes");
      inputs = buildCandidateReviewInputs(ambiguous, JSON.parse(raws.review));
      bindings = { reviewHash };
      sourceHash = hash(JSON.stringify({ ambiguousHash: hash(raws.ambiguous), reviewHash }));
      instructions = CANDIDATE_DECISION_INSTRUCTIONS; schema = CANDIDATE_DECISION_SCHEMA;
    } else {
      const manifest = BSON.EJSON.parse(raws.manifest), manifestHash = hash(raws.manifest), snapshotHash = hash(raws.snapshot);
      if (manifest.snapshotSHA256 !== snapshotHash) fail("Classification manifest must match the exact original snapshot bytes");
      inputs = buildInsertionClassificationInputs(manifest, BSON.EJSON.parse(raws.snapshot));
      bindings = { manifestHash, snapshotHash }; sourceHash = hash(JSON.stringify(bindings));
      instructions = INSERTION_CLASSIFICATION_INSTRUCTIONS; schema = INSERTION_CLASSIFICATION_SCHEMA;
    }
    metadata = { version: 1, helperVersion: CANDIDATE_HELPER_VERSION, mode, sourceHash, scopeHash: hash(JSON.stringify(inputs)), promptHash: hash(CANDIDATE_HELPER_VERSION + instructions + JSON.stringify(schema)), model: CANDIDATE_HELPER_MODEL, ...bindings, totalScope: inputs.length, offset: 0, selected: inputs.length };
  }
  if (inputs.some(input => !/^[a-f\d]{24}$/u.test(key(input))) || new Set(inputs.map(key)).size !== inputs.length) fail("Controlled lexical helper identities must be unique safe ObjectIds");
  return { mode, metadata, inputs, instructions, schema, output: resolve(output), protectedPaths: Object.values(sources).filter((path): path is string => !!path).map(path => resolve(path)) };
}

async function privateWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await chmod(temporary, 0o600);
  await rename(temporary, path); await chmod(path, 0o600);
}
async function readCheckpoint(path: string) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
}
export function validateHelperCheckpoint(saved: any, input: any, controlled: HelperContext) {
  const bindingKeys = ["version", "stage", "helperVersion", "mode", "sourceHash", "scopeHash", "inputsHash", "reviewHash", "manifestHash", "snapshotHash", "promptHash", "model"];
  if (!saved || bindingKeys.some(name => saved[name] !== controlled.metadata[name]) || saved.inputHash !== hash(JSON.stringify(input)) || !Number.isFinite(Date.parse(saved.completedAt))) fail("Helper checkpoint source, prompt, model or lexical input is stale");
  if (controlled.mode === "final" && (saved.execution?.kind !== "codex-agent" || !/^\/root\/[a-z\d_]+$/u.test(saved.execution.agent) || [input.authors.draftAgent, input.authors.reviewAgent].includes(saved.execution.agent) || !["high", "xhigh"].includes(saved.execution.reasoningEffort))) fail("Final seed approval requires an actual distinct third reviewer");
  strictAgentSchema({ entries: [saved.entry] }, controlled.schema);
  return validators[controlled.mode]({ entries: [saved.entry] }, [input] as any)[0];
}
export function makeHelperJob(controlled: HelperContext, entries: any[]) {
  return { version: 1, execution: "codex-agent", mode: controlled.mode, metadata: controlled.metadata, instructions: controlled.instructions, schema: controlled.schema, entries };
}
export function validateHelperJob(job: any, controlled: HelperContext) {
  if (job?.version !== 1 || job.execution !== "codex-agent" || job.mode !== controlled.mode || !isDeepStrictEqual(job.metadata, controlled.metadata) || job.instructions !== controlled.instructions || !isDeepStrictEqual(job.schema, controlled.schema) || !Array.isArray(job.entries) || !job.entries.length || job.entries.length > 40) fail("Helper job must match the exact controlled full source, schema, prompt and actual model");
  const originals = new Map(controlled.inputs.map(input => [key(input), input])), seen = new Set<string>();
  for (const input of job.entries) {
    if (!isDeepStrictEqual(input, originals.get(key(input))) || seen.has(key(input))) fail("Helper job lexical inputs changed or duplicated");
    seen.add(key(input));
  }
  return job.entries;
}
export async function ingestHelperJob(job: any, result: unknown, controlled: HelperContext, provenance: { agent: string; effort: string; jobSHA256: string; resultSHA256: string }) {
  if (!/^\/root\/[a-z\d_]+$/u.test(provenance.agent) || !["high", "xhigh"].includes(provenance.effort) || ![provenance.jobSHA256, provenance.resultSHA256].every(value => /^[a-f\d]{64}$/u.test(value))) fail("Record the actual GPT-6.1 agent and high/xhigh reasoning effort");
  const inputs = validateHelperJob(job, controlled); strictAgentSchema(result, controlled.schema);
  if (controlled.mode === "final" && inputs.some(input => [input.authors.draftAgent, input.authors.reviewAgent].includes(provenance.agent))) fail("Final seed reviewer must differ from both previous authors");
  const entries = validators[controlled.mode](result, inputs as any);
  const completedAt = new Date().toISOString(), execution = { kind: "codex-agent", agent: provenance.agent, reasoningEffort: provenance.effort, jobSHA256: provenance.jobSHA256, resultSHA256: provenance.resultSHA256 };
  let added = 0, preserved = 0;
  // All entries validate before the first local checkpoint is written.
  for (const entry of entries) {
    const input = inputs.find((input: any) => key(input) === key(entry))!, target = resolve(controlled.output, "entries", `${key(entry)}.json`);
    if (controlled.protectedPaths.includes(target)) fail("A checkpoint must not overwrite a source");
    const saved = await readCheckpoint(target);
    if (saved) {
      try { validateHelperCheckpoint(saved, input, controlled); preserved++; continue; } catch { fail("Existing helper checkpoint needs explicit stale-artifact handling; refusing overwrite"); }
    }
    await privateWrite(target, { ...controlled.metadata, inputHash: hash(JSON.stringify(input)), completedAt, execution, entry }); added++;
  }
  return { status: "agent_helper_checkpointed", mode: controlled.mode, accepted: entries.length, added, preserved, networkRequests: 0 };
}

async function main() {
  const args = process.argv.slice(2), flags = new Set<string>(), values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]; if (["--prepare", "--ingest", "--aggregate"].includes(name)) { flags.add(name); continue; }
    if (!["--mode", "--snapshot", "--review", "--ambiguous", "--manifest", "--additions-review", "--additions-map", "--candidate-provenance", "--output", "--job", "--result", "--agent", "--effort", "--limit", "--partition", "--partitions"].includes(name) || values.has(name) || !args[index + 1] || args[index + 1].startsWith("--")) fail("Invalid offline helper arguments");
    values.set(name, args[++index]);
  }
  const mode = values.get("--mode") as HelperMode;
  if (!["dedup", "answers", "classify", "final"].includes(mode) || flags.size !== 1 || !values.has("--output") || (!flags.has("--aggregate") && !values.has("--job")) || flags.has("--aggregate") && mode !== "final") fail("Choose helper mode, output and exactly one prepare/ingest operation, or final-only aggregate");
  const sources = Object.fromEntries(["snapshot", "review", "ambiguous", "manifest"].filter(name => values.has(`--${name}`)).map(name => [name, resolve(values.get(`--${name}`)!)]));
  for (const [flag, key] of [["--additions-review", "additionsReview"], ["--additions-map", "additionsMap"], ["--candidate-provenance", "provenance"]]) if (values.has(flag)) sources[key] = resolve(values.get(flag)!);
  const controlled = await helperContext(mode, sources, values.get("--output")!);
  if (flags.has("--aggregate")) {
    const checkpoints = await Promise.all(controlled.inputs.map(async input => {
      const saved = await readCheckpoint(resolve(controlled.output, "entries", `${key(input)}.json`));
      validateHelperCheckpoint(saved, input, controlled); return saved;
    }));
    const proof = { ...controlled.metadata, completed:checkpoints.length, pending:0, fullScopeComplete:true, entries:checkpoints.map(saved => saved.entry), executions:checkpoints.map(saved => ({candidateId:key(saved.entry), ...saved.execution, completedAt:saved.completedAt})) };
    validateFinalCandidateProof(proof, controlled.inputs, controlled.metadata.bindings);
    if (["inputs.json", "decisions.json"].some(name => controlled.protectedPaths.includes(resolve(controlled.output, name)))) fail("Final aggregate must not overwrite a source");
    await privateWrite(resolve(controlled.output, "inputs.json"), { ...controlled.metadata, entries:controlled.inputs });
    await privateWrite(resolve(controlled.output, "decisions.json"), proof);
    console.log(JSON.stringify({status:"final_candidate_proof_complete", completed:checkpoints.length, networkRequests:0})); return;
  }
  const jobPath = resolve(values.get("--job")!);
  if (flags.has("--prepare")) {
    const number = (name: string, fallback: number, max: number) => { const value = Number(values.get(name) ?? fallback); if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`Invalid ${name}`); return value; };
    const partitions = number("--partitions", 1, 16), partition = number("--partition", 0, 15), limit = number("--limit", 12, 40);
    if (!partitions || partition >= partitions || !limit) fail("Invalid helper partition or batch limit");
    if (controlled.protectedPaths.includes(jobPath) || jobPath.startsWith(`${controlled.output}/`)) fail("Job files must stay separate from sources and helper checkpoint artifacts");
    if (mode === "final" && !/^\/root\/[a-z\d_]+$/u.test(values.get("--agent") || "")) fail("Final preparation requires the assigned actual third agent");
    const scope = controlled.inputs.filter((input, index) => index % partitions === partition && (mode !== "final" || ![input.authors.draftAgent, input.authors.reviewAgent].includes(values.get("--agent")))), pending: any[] = [];
    for (const input of scope) {
      const saved = await readCheckpoint(resolve(controlled.output, "entries", `${key(input)}.json`));
      if (!saved) pending.push(input); else validateHelperCheckpoint(saved, input, controlled);
    }
    if (pending.length) await privateWrite(jobPath, makeHelperJob(controlled, pending.slice(0, limit)));
    console.log(JSON.stringify({ status: pending.length ? "agent_helper_prepared" : "agent_helper_partition_complete", mode, totalScope: controlled.inputs.length, partitionTotal: scope.length, completed: scope.length - pending.length, pending: pending.length, selected: Math.min(limit, pending.length), networkRequests: 0 }));
  } else {
    if (!["--result", "--agent", "--effort"].every(name => values.has(name))) fail("Ingestion requires the actual result, agent and reasoning effort");
    const [jobText, resultText] = await Promise.all([readFile(jobPath, "utf8"), readFile(resolve(values.get("--result")!), "utf8")]);
    console.log(JSON.stringify(await ingestHelperJob(JSON.parse(jobText), JSON.parse(resultText), controlled, { agent: values.get("--agent")!, effort: values.get("--effort")!, jobSHA256: hash(jobText), resultSHA256: hash(resultText) })));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Offline helper failed; inspect controlled local inputs and validation fixtures. No provider or database request was made."); process.exitCode = 1; });
