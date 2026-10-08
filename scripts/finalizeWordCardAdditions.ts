import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BSON } from "mongodb";
import { buildWordCardCandidateSnapshot, prepareWordCardAdditions, type AdditionCandidate, type ReviewedAggregate } from "./prepareWordCardAdditions.js";
import { buildCandidateReviewInputs, CANDIDATE_DECISION_INSTRUCTIONS, CANDIDATE_DECISION_SCHEMA, CANDIDATE_HELPER_MODEL, CANDIDATE_HELPER_VERSION, validateCandidateAliases, validateCandidateDecisions, type CandidateDecision } from "./reviewWordCardCandidates.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => { throw new Error(message); };
const parse = (value: string, label: string): any => { try { return JSON.parse(value); } catch { return fail(`${label} is not a JSON artifact`); } };
const equal = (actual: unknown, expected: unknown, label: string) => { if (!isDeepStrictEqual(actual, expected)) fail(`${label} differs from its exact controlled source scope`); };

export interface AdditionFinalizationFiles {
  snapshotText: string;
  reviewText: string;
  preparedMapText: string;
  ambiguousText: string;
  decisionsText: string;
  decisionInputsText: string;
}

/** Offline proof intake only. No new family traversal, semantic inference or database insertion. */
export function finalizeWordCardAdditions(files: AdditionFinalizationFiles, finalizedAt = new Date().toISOString()) {
  if (!Number.isFinite(Date.parse(finalizedAt))) fail("finalizedAt must be a valid date");
  let snapshot: any;
  try { snapshot = BSON.EJSON.parse(files.snapshotText); } catch { return fail("Original snapshot is not valid BSON EJSON"); }
  const review = parse(files.reviewText, "Reviewed catalog") as ReviewedAggregate;
  const map = parse(files.preparedMapText, "Prepared candidate mapping");
  const ambiguous = parse(files.ambiguousText, "Prepared ambiguities");
  const decisions = parse(files.decisionsText, "Candidate decisions");
  const decisionInputs = parse(files.decisionInputsText, "Candidate decision inputs");
  if (map?.version !== 1 || map.intentVersion !== 2 || map.stage !== "offline_addition_candidates" || map.partial !== false || map.finalized === true) fail("Finalization requires a complete original sense-aware preparation, not a pilot or already-finalized map");
  const sourceHash = hash(files.snapshotText), reviewHash = hash(files.reviewText);
  const prepared = prepareWordCardAdditions(snapshot, review, { sourceHash, reviewHash, auditedAt: map.auditedAt });
  equal(map, { ...prepared.summary, candidates: prepared.candidates, coveredCandidates: prepared.coveredCandidates }, "Prepared candidate mapping");
  equal(ambiguous, { ...prepared.summary, ambiguousCandidates: prepared.ambiguousCandidates }, "Prepared ambiguities");
  const inputs = buildCandidateReviewInputs(ambiguous, review, snapshot.collections.WORDS_DE.length);
  const ambiguousHash = hash(files.ambiguousText);
  const decisionSourceHash = hash(JSON.stringify({ ambiguousHash, reviewHash }));
  const scopeHash = hash(JSON.stringify(inputs));
  const promptHash = hash(CANDIDATE_HELPER_VERSION + CANDIDATE_DECISION_INSTRUCTIONS + JSON.stringify(CANDIDATE_DECISION_SCHEMA));
  const expectedMetadata = { version: 1, helperVersion: CANDIDATE_HELPER_VERSION, mode: "dedup", sourceHash: decisionSourceHash, scopeHash, promptHash, model: CANDIDATE_HELPER_MODEL, reviewHash, totalScope: inputs.length, offset: 0, selected: inputs.length };
  for (const artifact of [decisionInputs, decisions]) for (const [key, expected] of Object.entries(expectedMetadata)) if (artifact?.[key] !== expected) fail("Candidate decision provenance must match the complete exact ambiguity/review bytes and current sense-aware helper");
  equal(decisionInputs.entries, inputs, "Candidate decision inputs");
  if (decisions.status !== "helper_complete" || decisions.fullScopeComplete !== true || decisions.completed !== inputs.length || decisions.pending !== 0 || !Array.isArray(decisions.aliasErrors) || decisions.aliasErrors.length) fail("Complete candidate decisions with a validated alias graph are required");
  const accepted = validateCandidateDecisions({ entries: decisions.entries }, inputs);
  validateCandidateAliases(accepted, inputs);
  const intentInputs = new Map(inputs.map(input => [input.candidateId, input]));
  const candidateAliases = accepted.filter(entry => entry.coveredByCandidateIds.length).map(entry => ({ candidateId: entry.candidateId, senseKey: intentInputs.get(entry.candidateId)!.requestedSense.senseKey, representativeCandidateId: entry.coveredByCandidateIds[0], representativeSenseKey: intentInputs.get(entry.coveredByCandidateIds[0])!.requestedSense.senseKey, reason: entry.reason }));
  equal(decisions.candidateAliases, candidateAliases, "Candidate alias proof");
  const decisionsById = new Map(accepted.map(decision => [decision.candidateId, decision]));
  const candidatesById = new Map(prepared.ambiguousCandidates.map(candidate => [candidate.candidateId, candidate]));
  const inputsById = new Map(inputs.map(input => [input.candidateId, input]));
  const terminal = (decision: CandidateDecision): CandidateDecision => {
    let current = decision;
    while (current.coveredByCandidateIds.length) current = decisionsById.get(current.coveredByCandidateIds[0])!;
    return current;
  };
  // Drop ambiguity lookup data from missing candidates; their original requested sense stays intact.
  const plainCandidate = (candidateId: string): AdditionCandidate => {
    const { ambiguity: _ambiguity, potentialMatchingStudyBackSenses: _matches, alternativeCandidateSenses: _peers, ...candidate } = candidatesById.get(candidateId)!;
    return candidate;
  };
  const semanticMissing = accepted.filter(decision => decision.decision === "missing").map(decision => plainCandidate(decision.candidateId));
  const candidates = [...prepared.candidates, ...semanticMissing].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const coveredCandidates = accepted.filter(decision => decision.decision === "covered").map(decision => {
    const representative = terminal(decision), representativeInput = inputsById.get(representative.candidateId)!;
    return { ...plainCandidate(decision.candidateId), decision: { ...decision }, terminalCandidateId: representative.candidateId,
      existingMatches: representative.coveredByIDs.map(relationId => representativeInput.potentialMatches.find(match => match.relationId === relationId)!) };
  });
  const deferredCandidates = accepted.filter(decision => decision.decision === "needs_review").map(decision => ({ ...plainCandidate(decision.candidateId), decision: { ...decision } }));
  const candidateSnapshot = buildWordCardCandidateSnapshot(candidates, typeof snapshot.database === "string" ? snapshot.database : "", map.auditedAt);
  const candidateSnapshotText = BSON.EJSON.stringify(candidateSnapshot, { relaxed: false }, 2) + "\n";
  const required = (values: { required: boolean }[]) => values.filter(value => value.required).length;
  const summary = { ...prepared.summary, finalized: true, finalizedAt, candidateSnapshotSHA256: hash(candidateSnapshotText),
    finalization: { version: 1, originalMapSHA256: hash(files.preparedMapText), ambiguousSHA256: ambiguousHash, decisionsSHA256: hash(files.decisionsText), decisionInputsSHA256: hash(files.decisionInputsText), reviewHash, decisionSourceHash, decisionScopeHash: scopeHash, decisionPromptHash: promptHash, helperVersion: CANDIDATE_HELPER_VERSION, initialScopeOnly: true },
    coverage: { ...prepared.summary.coverage, initialMissingCandidates: prepared.candidates.length, semanticMissingCandidates: semanticMissing.length, missingCandidates: candidates.length, coveredSemanticCandidates: coveredCandidates.length, deferredCandidates: deferredCandidates.length, ambiguousCandidates: deferredCandidates.length,
      requiredCompanions: { ...prepared.summary.coverage.requiredCompanions, missing: required(candidates), ambiguous: required(deferredCandidates), coveredSemantic: required(coveredCandidates) } },
    completeCandidateDecisionScope: true, completeCandidateSemanticScope: deferredCandidates.length === 0,
    notice: "Offline sense-bound candidate seeds only, not inserted or fully reviewed study cards. All missing candidates still require generation and independent review. Covered decisions/aliases remain source-bound proofs; needs_review intentions remain deferred. Only the original reviewed proposals are included; no recursive family expansion or database/provider calls." };
  return { summary, candidateSnapshot, candidateSnapshotText, candidates, coveredCandidates, deferredCandidates, reviewQueue: prepared.reviewQueue, excludedEntries: prepared.excludedEntries, ambiguous, decisions, decisionInputs };
}

async function writePrivate(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 }); await chmod(temporary, 0o600);
  await rename(temporary, path); await chmod(path, 0o600);
}

async function main() {
  const args = process.argv.slice(2), values = new Map<string, string>();
  const required = ["--snapshot", "--review", "--prepared", "--decisions", "--output"];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") { console.log("Offline only: --snapshot before.ejson --review review/drafts.json --prepared directory --decisions helper/decisions.json --output directory [--decision-inputs helper/inputs.json]"); return; }
    if (![...required, "--decision-inputs"].includes(arg) || !args[index + 1] || args[index + 1].startsWith("--") || values.has(arg)) fail("Expected offline snapshot/review/preparation/decision/output paths only");
    values.set(arg, args[++index]);
  }
  if (required.some(arg => !values.has(arg))) fail("--snapshot, --review, --prepared, --decisions and --output are required");
  const preparedDir = resolve(values.get("--prepared")!), decisionsPath = resolve(values.get("--decisions")!), output = resolve(values.get("--output")!);
  const paths = { snapshotText: resolve(values.get("--snapshot")!), reviewText: resolve(values.get("--review")!), preparedMapText: resolve(preparedDir, "candidates.json"), ambiguousText: resolve(preparedDir, "ambiguous-candidates.json"), decisionsText: decisionsPath, decisionInputsText: resolve(values.get("--decision-inputs") || resolve(dirname(decisionsPath), "inputs.json")) };
  const loaded = await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, "utf8")] as const));
  const files = Object.fromEntries(loaded) as unknown as AdditionFinalizationFiles;
  const result = finalizeWordCardAdditions(files);
  const outputs: [string, string][] = [
    ["candidate-before.ejson", result.candidateSnapshotText],
    ["candidates.json", JSON.stringify({ ...result.summary, candidates: result.candidates, coveredCandidates: result.coveredCandidates }, null, 2) + "\n"],
    ["ambiguous-candidates.json", files.ambiguousText], ["decisions.json", files.decisionsText], ["inputs.json", files.decisionInputsText],
    ["review-queue.json", JSON.stringify({ ...result.summary, reviewQueue: result.reviewQueue, excludedEntries: result.excludedEntries, deferredCandidates: result.deferredCandidates }, null, 2) + "\n"],
    ["summary.json", JSON.stringify(result.summary, null, 2) + "\n"],
  ];
  if (outputs.some(([name]) => Object.values(paths).includes(resolve(output, name)))) fail("Finalized artifacts must not overwrite any source input");
  for (const [name, contents] of outputs) await writePrivate(resolve(output, name), contents);
  console.log(JSON.stringify({ status: "offline_candidate_finalization_complete", finalizedAt: result.summary.finalizedAt, missing: result.candidates.length, covered: result.coveredCandidates.length, deferred: result.deferredCandidates.length, candidateSnapshotSHA256: result.summary.candidateSnapshotSHA256, completeCandidateSemanticScope: result.summary.completeCandidateSemanticScope }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : "Offline candidate finalization failed"); process.exitCode = 1; });
