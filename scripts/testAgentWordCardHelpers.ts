import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BSON, ObjectId } from "mongodb";
import { helperContext, ingestHelperJob, makeHelperJob, validateHelperCheckpoint, validateHelperJob, type HelperContext } from "./agentWordCardHelpers.js";
import { ANSWER_REVIEW_INSTRUCTIONS, ANSWER_REVIEW_PROMPT_HASH, ANSWER_REVIEW_SCHEMA, ANSWER_REVIEW_VERSION, validateAnswerReviewCheckpoint } from "./reviewWordCardAnswers.js";
import { CANDIDATE_DECISION_INSTRUCTIONS, CANDIDATE_DECISION_SCHEMA, CANDIDATE_HELPER_VERSION, EXPECTED_CATALOG_REVIEW_HASH } from "./reviewWordCardCandidates.js";
import { WORD_CARD_PROMPT_VERSION } from "./lib/wordCardPrompt.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = (number: number) => number.toString(16).padStart(24, "0"), oid = (number: number) => new ObjectId(hex(number));
const directory = await mkdtemp(join(tmpdir(), "word-agent-helpers-"));
const provenance = { agent: "/root/word_semantic_audit", effort: "xhigh", jobSHA256: hash("actual-job"), resultSHA256: hash("actual-result") };
const forms = { gender: "das", plural: "Die Autos", perfect: "", past: "", imperativ: "", gramaticalCase: "", irregularConjugations: "" };
const variant = { german: "Das Auto", category: "NOUN", forms, notes: "Die Autos", examples: ["Das Auto ist neu.", "Ich fahre mit dem Auto."], confidence: "high", reviewReason: "" };
const snapshot = { collections: { WORDS_DE: [{ _id: oid(1), word: "Auto" }], WORDS_ES: [{ _id: oid(2), word: "coche" }], WORDS_ES_DE: [{ _id: oid(3), main: oid(2), translated: oid(1) }], userprogresses: [{ itemType: "WORD", relationId: oid(3), userId: "private-owner", card: { direction: "DE_ES", prompt: "Das Auto", answer: "el coche", acceptedAnswers: ["el coche", "el automóvil"] } }] } };
try {
  const sourcePath = join(directory, "before.ejson"), reviewPath = join(directory, "review.json");
  const sourceText = BSON.EJSON.stringify(snapshot, { relaxed: false }); await writeFile(sourcePath, sourceText);
  const review = { version: 1, stage: "independent_review", promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: EXPECTED_CATALOG_REVIEW_HASH, sourceHash: hash(sourceText), offset: 0, selected: 1, completed: 1, pending: 0, entries: [{ id: hex(1), translations: [{ relationId: hex(3), spanish: "el coche", examples: ["El coche es nuevo.", "Voy en coche."], variant }], confidence: "high", studyEligible: true }] };
  await writeFile(reviewPath, JSON.stringify(review));
  const answers = await helperContext("answers", { snapshot: sourcePath, review: reviewPath }, join(directory, "answers"));
  assert.equal(answers.inputs.length, 1); assert.ok(!JSON.stringify(answers.inputs).includes("private-owner"));
  assert.equal(answers.instructions, ANSWER_REVIEW_INSTRUCTIONS); assert.deepEqual(answers.schema, ANSWER_REVIEW_SCHEMA); assert.equal(answers.metadata.helperVersion, ANSWER_REVIEW_VERSION); assert.equal(answers.metadata.promptHash, ANSWER_REVIEW_PROMPT_HASH);
  const job = makeHelperJob(answers, answers.inputs), decision = { id: answers.inputs[0].id, retainedAnswers: ["el coche", "el automóvil"], reason: "Same vehicle meaning in Spanish", confidence: "high", reviewReason: "" };
  assert.deepEqual(validateHelperJob(job, answers), answers.inputs);
  assert.throws(() => validateHelperJob({ ...job, entries: [{ ...answers.inputs[0], originalAcceptedAnswers: ["invented"] }] }, answers), /inputs changed/u);
  assert.throws(() => validateHelperJob({ ...job, metadata: { ...job.metadata, sourceHash: hash("another-source") } }, answers), /exact controlled/u);
  await assert.rejects(ingestHelperJob(job, { entries: [decision] }, answers, { ...provenance, effort: "low" }), /high\/xhigh/u);
  await assert.rejects(ingestHelperJob(job, { entries: [{ ...decision, retainedAnswers: ["invented"] }] }, answers, provenance), /exact valid original/u);
  await assert.rejects(ingestHelperJob(job, { entries: [{ ...decision, userId: "forged" }] }, answers, provenance), /exact schema/u);
  const result = await ingestHelperJob(job, { entries: [decision] }, answers, provenance); assert.equal(result.added, 1);
  const savedPath = join(answers.output, "entries", `${decision.id}.json`), savedText = await readFile(savedPath, "utf8"), saved = JSON.parse(savedText);
  assert.equal((await stat(savedPath)).mode & 0o777, 0o600); assert.equal((await stat(join(answers.output, "entries"))).mode & 0o777, 0o700);
  assert.equal(saved.execution.agent, provenance.agent); assert.equal(saved.execution.kind, "codex-agent");
  assert.deepEqual(validateHelperCheckpoint(saved, answers.inputs[0], answers), decision);
  assert.deepEqual(validateAnswerReviewCheckpoint(saved, answers.inputs[0], answers.metadata as any), decision, "Existing helper accepts the exact source-bound offline checkpoint");
  await ingestHelperJob(job, { entries: [{ ...decision, retainedAnswers: [] }] }, answers, provenance);
  assert.equal(await readFile(savedPath, "utf8"), savedText, "Completed semantic decisions remain immutable");
  await assert.rejects(ingestHelperJob(job, { entries: [decision] }, { ...answers, metadata: { ...answers.metadata, reviewHash: hash("stale") } }, provenance), /exact controlled/u);
  const malformedSaved = { ...saved, inputHash: hash("stale-input") }; await writeFile(savedPath, JSON.stringify(malformedSaved));
  await assert.rejects(ingestHelperJob(job, { entries: [decision] }, answers, provenance), /refusing overwrite/u);

  const candidateInput = { candidateId: hex(10), german: "Das Auto", spanish: "el automóvil", reasons: ["same vehicle sense"], requestedSense: { senseKey: "vehicle", reasons: ["same vehicle sense"], forms, notes: "Die Autos", examples: variant.examples }, potentialMatches: [{ relationId: hex(3), wordId: hex(1), german: "Das Auto", spanish: "el coche", category: "NOUN", forms, notes: "Die Autos", examples: variant.examples, spanishExamples: ["El coche es nuevo.", "Voy en coche."], ready: true }], alternativeCandidates: [] };
  // This stage requires the real audit's full catalog count even in an offline fixture.
  const fullReview = { ...review, selected: 3988, completed: 3988, entries: [review.entries[0], ...Array.from({ length: 3987 }, (_, index) => ({ id: hex(index + 2), translations: [] }))] };
  const fullReviewPath = join(directory, "full-review.json"), ambiguityPath = join(directory, "ambiguous.json"), fullReviewText = JSON.stringify(fullReview);
  await writeFile(fullReviewPath, fullReviewText);
  const ambiguous = { version: 1, stage: "offline_addition_candidates", sourceHash: review.sourceHash, reviewHash: hash(fullReviewText), reviewPromptHash: review.promptHash, partial: false, ambiguousCandidates: [{ candidateId: candidateInput.candidateId, german: candidateInput.german, spanish: candidateInput.spanish, reasons: candidateInput.reasons, senseKey: candidateInput.requestedSense.senseKey, requestedSense: candidateInput.requestedSense, potentialMatchingStudyBackSenses: candidateInput.potentialMatches, alternativeCandidateSenses: [] }] };
  await writeFile(ambiguityPath, JSON.stringify(ambiguous));
  const dedupContext = await helperContext("dedup", { ambiguous: ambiguityPath, review: fullReviewPath }, join(directory, "real-dedup-context"));
  assert.equal(dedupContext.inputs.length, 1); assert.equal(dedupContext.metadata.reviewHash, hash(fullReviewText));
  const helperCLI = ["--import", "tsx", fileURLToPath(new URL("./reviewWordCardCandidates.ts", import.meta.url)), "--prepare-only", "--ambiguous", ambiguityPath, "--review", fullReviewPath, "--outputdir", join(directory, "dedup-cli")];
  const preparedCLI = spawnSync(process.execPath, helperCLI, { encoding: "utf8" });
  assert.equal(preparedCLI.status, 0); assert.match(preparedCLI.stdout, /offline_inputs_prepared/u);
  await writeFile(fullReviewPath, fullReviewText + "\n");
  await assert.rejects(helperContext("dedup", { ambiguous: ambiguityPath, review: fullReviewPath }, dedupContext.output), /exact final review bytes/u, "A changed aggregate timestamp or serialization invalidates its old proposals");
  const staleCLI = spawnSync(process.execPath, helperCLI, { encoding: "utf8" });
  assert.equal(staleCLI.status, 1); assert.match(staleCLI.stderr, /exact final review bytes/u);
  const candidates: HelperContext = { mode: "dedup", metadata: { version: 1, helperVersion: CANDIDATE_HELPER_VERSION, mode: "dedup", sourceHash: hash("dedup-source"), scopeHash: hash(JSON.stringify([candidateInput])), promptHash: hash(CANDIDATE_HELPER_VERSION + CANDIDATE_DECISION_INSTRUCTIONS + JSON.stringify(CANDIDATE_DECISION_SCHEMA)), model: "gpt-6.1-sol", reviewHash: hash("dedup-review"), totalScope: 1, offset: 0, selected: 1 }, inputs: [candidateInput], schema: CANDIDATE_DECISION_SCHEMA, instructions: CANDIDATE_DECISION_INSTRUCTIONS, output: join(directory, "dedup"), protectedPaths: [] };
  const candidateDecision = { candidateId: hex(10), decision: "covered", coveredByIDs: [hex(3)], coveredByCandidateIds: [], reason: "Automóvil and coche describe the same vehicle sense" };
  assert.equal((await ingestHelperJob(makeHelperJob(candidates, candidates.inputs), { entries: [candidateDecision] }, candidates, provenance)).added, 1);
  await assert.rejects(ingestHelperJob(makeHelperJob(candidates, candidates.inputs), { entries: [{ ...candidateDecision, coveredByIDs: [hex(999)] }] }, candidates, provenance), /provided existing/u);

  const manifestPath = join(directory, "manifest.ejson");
  const manifest = { version: 1, auditedAt: new Date().toISOString(), snapshotSHA256: hash(sourceText), patches: [], inserts: [
    { collection: "WORDS_DE", document: { _id: oid(20), word: "Das Fahrrad", gramaticalCategories: ["NOUN"], forms: { ...forms, plural: "Die Fahrräder" }, notes: "Die Fahrräder", examples: ["Das Fahrrad ist neu.", "Ich fahre mit dem Fahrrad."], contexts: ["general_vocabulary"], createdAt: new Date() } },
    { collection: "WORDS_ES", document: { _id: oid(21), word: "la bicicleta", gramaticalCategories: ["NOUN"], forms: {}, notes: "", examples: ["La bicicleta es nueva.", "Voy en bicicleta."], contexts: ["general_vocabulary"], createdAt: new Date() } },
    { collection: "WORDS_ES_DE", document: { _id: oid(22), main: oid(21), translated: oid(20), createdAt: new Date(), study: { version: 1, german: "Das Fahrrad", spanish: "la bicicleta", notes: "Die Fahrräder", examples: ["Das Fahrrad ist neu. (La bicicleta es nueva.)", "Ich fahre mit dem Fahrrad. (Voy en bicicleta.)"], auditedAt: new Date() } } }
  ] };
  await writeFile(manifestPath, BSON.EJSON.stringify(manifest, { relaxed: false }));
  const classification = await helperContext("classify", { manifest: manifestPath, snapshot: sourcePath }, join(directory, "classification"));
  assert.equal(classification.inputs.length, 1); assert.equal(classification.inputs[0].german, "Das Fahrrad");
  const classifyJob = makeHelperJob(classification, classification.inputs);
  const invalid = { entries: [{ id: hex(20), cefrLevel: "GUESS" }] };
  await assert.rejects(ingestHelperJob(classifyJob, invalid, classification, provenance), /schema value/u);
  // Select a supported point from the controlled schema, testing provenance rather than a linguistic claim.
  const level = classification.schema.properties.entries.items.properties.cefrLevel.enum[0];
  assert.equal((await ingestHelperJob(classifyJob, { entries: [{ id: hex(20), cefrLevel: level }] }, classification, provenance)).added, 1);
  await writeFile(sourcePath, sourceText + "\n");
  await assert.rejects(helperContext("classify", { manifest: manifestPath, snapshot: sourcePath }, classification.output), /exact original snapshot/u);
  await assert.rejects(helperContext("answers", { snapshot: sourcePath, review: reviewPath }, answers.output), /exact original snapshot/u);
  console.log("PASS offline helper source/schema binding, actual-agent provenance, semantic guards, private immutable checkpoints and helper compatibility; no API/DB calls");
} finally { await rm(directory, { recursive: true, force: true }); }
