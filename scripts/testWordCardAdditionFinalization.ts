import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BSON } from "mongodb";
import { finalizeWordCardAdditions, type AdditionFinalizationFiles } from "./finalizeWordCardAdditions.js";
import { prepareWordCardAdditions, type ReviewedAggregate } from "./prepareWordCardAdditions.js";
import { buildCandidateReviewInputs, CANDIDATE_DECISION_INSTRUCTIONS, CANDIDATE_DECISION_SCHEMA, CANDIDATE_HELPER_MODEL, CANDIDATE_HELPER_VERSION, type CandidateDecision } from "./reviewWordCardCandidates.js";
import { WORD_CARD_FORM_KEYS, WORD_CARD_PROMPT_VERSION, WORD_CARD_REVIEW_INSTRUCTIONS, WORD_CARD_REVIEW_SCHEMA, type WordCardDraft, type WordCardForms } from "./lib/wordCardPrompt.js";

globalThis.fetch = async () => { throw new Error("Offline tests must never call a network/provider"); };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const oid = (key: string) => new BSON.ObjectId(sha(`addition-finalization-fixture:${key}`).slice(0, 24));
const now = "2026-10-08T10:00:00.000Z";
const forms = (values: Partial<WordCardForms> = {}) => ({ ...Object.fromEntries(WORD_CARD_FORM_KEYS.map(key => [key, ""])), ...values }) as WordCardForms;
const noun = (key: string, german: string, spanish: string, plural: string, examples: string[]): WordCardDraft => {
  const variant = { german, category: "NOUN" as const, forms: forms({ gender: "die", plural }), notes: plural, examples, confidence: "high" as const, reviewReason: "" };
  return { id: oid(key).toHexString(), ...variant, translations: [{ relationId: oid(`relation:${key}`).toHexString(), spanish, examples: ["Este es un ejemplo.", "Aquí hay otro ejemplo."], variant }], issues: [], studyEligible: true, relatedCandidates: [] };
};
const bank = noun("bank", "Die Bank", "el banco", "Die Banken", ["Ich eröffne ein Konto bei der Bank.", "Die Bank hat geschlossen."]);
bank.relatedCandidates = [
  { german: "Die Bank", spanish: "el banco", reason: "split_existing_sense: preserve the seating sense, plural Die Bänke" },
  { german: "Die Bank", spanish: "el banco", reason: "Bench seating sense with plural Die Bänke" },
  { german: "Die Bank", spanish: "el banco", reason: "Financial institution, plural Die Banken" },
  { german: "Der Baum", spanish: "el árbol", reason: "A real missing noun within the initial proposal scope" },
];
const mouse = noun("mouse", "Die Maus", "el ratón", "Die Mäuse", ["Ich klicke mit der Maus.", "Die Maus ist mit dem Computer verbunden."]);
mouse.relatedCandidates = [{ german: "Die Maus", spanish: "el ratón", reason: "Animal sense rather than a computer peripheral" }];
const ownVariant = { german: "fahren", category: "VERB" as const, forms: forms({ perfect: "ist gefahren", past: "ich fuhr", imperativ: "fahr!, fahrt!" }), notes: "ist gefahren\nich fuhr\nfahr!, fahrt!", examples: ["Ich fahre morgen nach Berlin.", "Du bist gestern nach Hause gefahren."], confidence: "high" as const, reviewReason: "" };
const seed: WordCardDraft = { id: oid("finite-seed").toHexString(), ...ownVariant, translations: [{ relationId: "", spanish: "viajar", examples: ["Mañana viajo a Berlín.", "Ayer viajaste a casa."], variant: ownVariant }], issues: [], studyEligible: true, relatedCandidates: [] };
const entries = [bank, mouse, seed];
const snapshot = { auditedAt: now, database: "offline_fixture", collections: {
  WORDS_DE: entries.map(entry => ({ _id: new BSON.ObjectId(entry.id), word: entry.id === seed.id ? "fuhr" : entry.german, gramaticalCategories: ["UNKNOWN"], forms: {}, notes: "", examples: [], contexts: [] })),
  WORDS_ES: [bank, mouse].map(entry => ({ _id: oid(`es:${entry.id}`), word: entry.translations[0].spanish, examples: [] })),
  WORDS_ES_DE: [bank, mouse].map(entry => ({ _id: new BSON.ObjectId(entry.translations[0].relationId), main: oid(`es:${entry.id}`), translated: new BSON.ObjectId(entry.id) })),
  userprogresses: [{ _id: oid("private-progress"), userId: oid("private-owner"), card: { sourceNoteGuid: "PRIVATE_OWNER_SOURCE" } }],
} };
const snapshotText = BSON.EJSON.stringify(snapshot, { relaxed: false }, 2) + "\n";
const review: ReviewedAggregate = { version: 1, stage: "independent_review", promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: sha(WORD_CARD_PROMPT_VERSION + WORD_CARD_REVIEW_INSTRUCTIONS + JSON.stringify(WORD_CARD_REVIEW_SCHEMA)), sourceHash: sha(snapshotText), selected: entries.length, completed: entries.length, pending: 0, offset: 0, entries };
const reviewText = JSON.stringify(review, null, 2) + "\n";
const prepared = prepareWordCardAdditions(snapshot, review, { sourceHash: sha(snapshotText), reviewHash: sha(reviewText), auditedAt: now });
const preparedMapText = JSON.stringify({ ...prepared.summary, candidates: prepared.candidates, coveredCandidates: prepared.coveredCandidates }, null, 2) + "\n";
const ambiguousText = JSON.stringify({ ...prepared.summary, ambiguousCandidates: prepared.ambiguousCandidates }, null, 2) + "\n";
const projected = buildCandidateReviewInputs(JSON.parse(ambiguousText), review, entries.length);
const benches = projected.filter(input => input.german === "Die Bank" && input.reasons[0].includes("Bänke")).sort((a, b) => a.candidateId.localeCompare(b.candidateId));
assert.equal(benches.length, 2);
const financial = projected.find(input => input.reasons[0].includes("Financial"))!;
const animal = projected.find(input => input.german === "Die Maus")!;
const missing: CandidateDecision = { candidateId: benches[0].candidateId, decision: "missing", coveredByIDs: [], coveredByCandidateIds: [], reason: "Financial Bank is not a seating bench" };
const alias: CandidateDecision = { candidateId: benches[1].candidateId, decision: "covered", coveredByIDs: [], coveredByCandidateIds: [benches[0].candidateId], reason: "Both requests teach the same bench meaning and plural" };
const existing: CandidateDecision = { candidateId: financial.candidateId, decision: "covered", coveredByIDs: [bank.translations[0].relationId], coveredByCandidateIds: [], reason: "The existing relation already teaches this financial meaning" };
const uncertain: CandidateDecision = { candidateId: animal.candidateId, decision: "needs_review", coveredByIDs: [], coveredByCandidateIds: [], reason: "Fixture deliberately defers this semantic comparison" };
const ordered = projected.map(input => [missing, alias, existing, uncertain].find(entry => entry.candidateId === input.candidateId)!);
const metadata = { version: 1, helperVersion: CANDIDATE_HELPER_VERSION, mode: "dedup", sourceHash: sha(JSON.stringify({ ambiguousHash: sha(ambiguousText), reviewHash: sha(reviewText) })), scopeHash: sha(JSON.stringify(projected)), promptHash: sha(CANDIDATE_HELPER_VERSION + CANDIDATE_DECISION_INSTRUCTIONS + JSON.stringify(CANDIDATE_DECISION_SCHEMA)), model: CANDIDATE_HELPER_MODEL, reviewHash: sha(reviewText), totalScope: projected.length, offset: 0, selected: projected.length };
const inputArtifact = { ...metadata, entries: projected };
const decisionArtifact = { ...metadata, status: "helper_complete", fullScopeComplete: true, completed: projected.length, pending: 0, aliasErrors: [], entries: ordered,
  candidateAliases: [{ candidateId: alias.candidateId, senseKey: benches[1].requestedSense.senseKey, representativeCandidateId: missing.candidateId, representativeSenseKey: benches[0].requestedSense.senseKey, reason: alias.reason }] };
const files: AdditionFinalizationFiles = { snapshotText, reviewText, preparedMapText, ambiguousText, decisionsText: JSON.stringify(decisionArtifact, null, 2) + "\n", decisionInputsText: JSON.stringify(inputArtifact, null, 2) + "\n" };
const result = finalizeWordCardAdditions(files, now);
assert.equal(result.candidates.length, 3, "Initial Baum/finite seed plus the missing bench representative must be included");
assert.equal(result.coveredCandidates.length, 2, "Financial coverage and bench alias remain separate proofs");
assert.equal(result.deferredCandidates.length, 1); assert.equal(result.summary.completeCandidateSemanticScope, false);
assert.equal(result.summary.coverage.requiredCompanions.missing + result.summary.coverage.requiredCompanions.coveredSemantic, 1, "The required bench request survives either as representative or proven alias");
assert.equal(result.candidates.find(candidate => candidate.german === "fahren")!.originalDEReuseId, null, "A finite dictionary seed cannot become the reused infinitive record");
assert.equal(result.candidates.filter(candidate => candidate.german === "Die Bank").length, 1, "No text dedup may suppress the semantically missing bench");
const benchSeed = result.candidateSnapshot.collections.WORDS_DE.find(word => word.word === "Die Bank")!;
assert.match(benchSeed.notes, /Bänke/u); assert.ok(!benchSeed.notes.includes("Die Banken"), "Financial parent grammar must not enter the requested bench generation input");
assert.equal(result.coveredCandidates.find(candidate => candidate.candidateId === alias.candidateId)!.terminalCandidateId, missing.candidateId);
assert.deepEqual(result.coveredCandidates.find(candidate => candidate.candidateId === alias.candidateId)!.existingMatches, [], "An alias to a new representative is not existing database coverage");
assert.equal(result.summary.candidateSnapshotSHA256, sha(result.candidateSnapshotText));
assert.deepEqual(result.candidateSnapshot.collections.userprogresses, []);
for (const secret of ["userId", "PRIVATE_OWNER_SOURCE", oid("private-owner").toHexString(), oid("private-progress").toHexString(), ...entries.map(entry => entry.id)]) assert.ok(!result.candidateSnapshotText.includes(secret));
assert.deepEqual(finalizeWordCardAdditions(files, now), result, "The same exact proof scope finalizes deterministically");

function modify(key: keyof AdditionFinalizationFiles, mutate: (value: any) => void) {
  const value = JSON.parse(files[key]); mutate(value); return { ...files, [key]: JSON.stringify(value) };
}
assert.throws(() => finalizeWordCardAdditions({ ...files, reviewText: files.reviewText + " " }), /controlled source scope|provenance/, "Exact review bytes bind helper decisions");
assert.throws(() => finalizeWordCardAdditions(modify("preparedMapText", value => { value.candidates.pop(); })), /controlled source scope/);
assert.throws(() => finalizeWordCardAdditions(modify("ambiguousText", value => { value.ambiguousCandidates[0].requestedSense.reasons = ["Wrong parent sense"]; })), /controlled source scope/);
assert.throws(() => finalizeWordCardAdditions(modify("preparedMapText", value => { value.partial = true; })), /complete original/);
assert.throws(() => finalizeWordCardAdditions(modify("decisionsText", value => { value.helperVersion = "old-pair-only"; })), /provenance/);
assert.throws(() => finalizeWordCardAdditions(modify("decisionInputsText", value => { value.entries[0].requestedSense.reasons = ["Inherited financial sense"]; })), /controlled source scope/);
assert.throws(() => finalizeWordCardAdditions(modify("decisionsText", value => { value.pending = 1; })), /Complete candidate decisions/);
assert.throws(() => finalizeWordCardAdditions(modify("decisionsText", value => { value.entries.pop(); })), /cover every/);
assert.throws(() => finalizeWordCardAdditions(modify("decisionsText", value => { value.entries.find((entry: any) => entry.candidateId === existing.candidateId).coveredByIDs = [oid("unprovided").toHexString()]; })), /ready provided/);
assert.throws(() => finalizeWordCardAdditions(modify("decisionsText", value => { const entry = value.entries.find((entry: any) => entry.candidateId === missing.candidateId); entry.decision = "covered"; entry.coveredByCandidateIds = [alias.candidateId]; })), /lower|cycle/);
assert.throws(() => finalizeWordCardAdditions(modify("decisionsText", value => { value.entries.find((entry: any) => entry.candidateId === missing.candidateId).decision = "needs_review"; })), /terminate/, "An alias cannot claim a deferred representative covers it");
assert.throws(() => finalizeWordCardAdditions(modify("decisionsText", value => { value.candidateAliases[0].representativeSenseKey = "wrong"; })), /alias proof/);

// A fully resolved graph can finalize while keeping both distinct same-pair senses separate.
const resolvedArtifact = { ...decisionArtifact, entries: ordered.map(entry => entry.candidateId === uncertain.candidateId ? { ...entry, decision: "missing" } : entry) };
const resolved = finalizeWordCardAdditions({ ...files, decisionsText: JSON.stringify(resolvedArtifact) }, now);
assert.equal(resolved.summary.completeCandidateSemanticScope, true); assert.equal(resolved.candidates.length, 4);
assert.equal(resolved.candidates.some(candidate => candidate.german === "Die Maus"), true);

const directory = await mkdtemp(join(tmpdir(), "addition-finalizer-"));
try {
  const original = join(directory, "original"), helper = join(directory, "helper"), output = join(directory, "final");
  await mkdir(original); await mkdir(helper);
  const snapshotPath = join(directory, "before.ejson"), reviewPath = join(directory, "review.json");
  await writeFile(snapshotPath, files.snapshotText, { mode: 0o600 }); await writeFile(reviewPath, files.reviewText, { mode: 0o600 });
  await writeFile(join(original, "candidates.json"), files.preparedMapText, { mode: 0o600 }); await writeFile(join(original, "ambiguous-candidates.json"), files.ambiguousText, { mode: 0o600 });
  await writeFile(join(helper, "decisions.json"), files.decisionsText, { mode: 0o600 }); await writeFile(join(helper, "inputs.json"), files.decisionInputsText, { mode: 0o600 });
  const script = join(dirname(fileURLToPath(import.meta.url)), "finalizeWordCardAdditions.ts");
  const args = ["--import", "tsx", script, "--snapshot", snapshotPath, "--review", reviewPath, "--prepared", original, "--decisions", join(helper, "decisions.json"), "--output", output];
  const cli = spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: dirname(process.execPath) } });
  assert.equal(cli.status, 0, cli.stderr); assert.ok(!cli.stdout.includes("Bänke") && !cli.stdout.includes(bank.id), "Terminal output contains counts, not source content");
  for (const name of ["candidate-before.ejson", "candidates.json", "ambiguous-candidates.json", "decisions.json", "inputs.json", "review-queue.json", "summary.json"]) assert.equal((await stat(join(output, name))).mode & 0o777, 0o600);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  for (const [name, expected] of [["ambiguous-candidates.json", files.ambiguousText], ["decisions.json", files.decisionsText], ["inputs.json", files.decisionInputsText]]) assert.equal(await readFile(join(output, name), "utf8"), expected, "Proof source bytes must be copied exactly");
  const finalMap = JSON.parse(await readFile(join(output, "candidates.json"), "utf8"));
  assert.equal(finalMap.candidates.length, 3); assert.equal(finalMap.coveredCandidates.length, 2);
  assert.equal(finalMap.candidateSnapshotSHA256, sha(await readFile(join(output, "candidate-before.ejson"), "utf8")));
  const overwrite = spawnSync(process.execPath, [...args.slice(0, -1), original], { encoding: "utf8", env: { PATH: dirname(process.execPath) } });
  assert.equal(overwrite.status, 1); assert.match(overwrite.stderr, /overwrite any source/);
  const network = spawnSync(process.execPath, [...args, "--mongo"], { encoding: "utf8", env: { PATH: dirname(process.execPath) } }); assert.equal(network.status, 1);
} finally { await rm(directory, { recursive: true, force: true }); }
console.log("Offline addition finalization tests passed: sense-bound exact-pair homographs, controlled source/decision provenance, missing/covered/deferred scope, alias closure, seed evidence/privacy, immutable inputs and private CLI artifacts.");
