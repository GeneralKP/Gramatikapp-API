import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BSON } from "mongodb";
import { WORD_CARD_FORM_KEYS, WORD_CARD_PROMPT_VERSION, WORD_CARD_REVIEW_INSTRUCTIONS, WORD_CARD_REVIEW_SCHEMA, validateReviewedWordCards, type AuditWordInput, type WordCardDraft } from "./lib/wordCardPrompt.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const currentReviewHash = hash(WORD_CARD_PROMPT_VERSION + WORD_CARD_REVIEW_INSTRUCTIONS + JSON.stringify(WORD_CARD_REVIEW_SCHEMA));
const id = (value: any): string => typeof value === "string" ? value : value?.toHexString?.() || value?.$oid || "";
const strings = (value: any): string[] => Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
const text = (value: any): string => typeof value === "string" ? value : "";
const unique = (values: string[]) => [...new Set(values)].sort();

/** Keep the article: Der Band, Die Band and Das Band are different fronts. */
export const normalizeStudyText = (value: string): string => value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
const reviewedSeedCardinals = new Set(["zehn", "drei", "fünf", "vier", "sechzig", "zwei", "acht", "sieben", "neunzig"]);
const reviewedSeedAbbreviations = new Set(["usw."]);
const reviewedSeedParticleCues = new Map([["wohl", "probablemente"], ["bloß", "pero"], ["selbst", "mismo"], ["doch", "pero si"], ["gerade", "justamente"]]);
/** UNKNOWN also represents reviewed idioms and these explicitly source-checked seeds. */
export function reviewedWordCardCategoryReady(value: { category: string; notes: string; german?: string; forms?: unknown; translations?: Array<{ spanish: string }> }, spanish?: string): boolean {
  if (value.category !== "UNKNOWN" || value.notes === "Redewendung") return true;
  if (value.notes !== "" || typeof value.german !== "string") return false;
  const german = value.german.normalize("NFC").trim();
  // These source-checked particle meanings have no PARTICLE enum member. Other
  // meanings and other particles are not admitted through this allowance.
  const cues = spanish === undefined ? value.translations?.map(translation => translation.spanish) : [spanish];
  const particleCue = reviewedSeedParticleCues.get(german);
  const reviewedParticle = particleCue !== undefined && !!cues?.length && cues.every(cue => cue.normalize("NFC").trim() === particleCue);
  if (!reviewedSeedCardinals.has(german) && !reviewedSeedAbbreviations.has(german) && !reviewedParticle) return false;
  if (!value.forms || typeof value.forms !== "object" || Array.isArray(value.forms)) return false;
  const actualForms = value.forms as Record<string, unknown>;
  return Object.keys(actualForms).length === WORD_CARD_FORM_KEYS.length && WORD_CARD_FORM_KEYS.every(key => Object.hasOwn(actualForms, key) && actualForms[key] === "");
}
const displayText = (value: string): string => value.normalize("NFC").trim().replace(/\s+/gu, " ");
const displayRank = (german: string, spanish: string): [number, string] => [(german + spanish).match(/\p{Lu}/gu)?.length || 0, JSON.stringify([german, spanish])];
const bareNoun = (value: string): string => normalizeStudyText(value).replace(/^(?:der|die|das)\s+/u, "");
const pairKey = (german: string, spanish: string) => JSON.stringify([normalizeStudyText(german), normalizeStudyText(spanish)]);
export const additionId = (kind: "DE" | "ES" | "relation", german: string, spanish: string, senseKey?: string): string => hash(`word-prompt-audit:${kind}:${pairKey(german, spanish)}${senseKey === undefined ? "" : `:${normalizeStudyText(senseKey)}`}`).slice(0, 24);
export const relatedAdditionSenseKey = (reason: string): string => `related:${normalizeStudyText(reason)}`;
export interface RequestedAdditionSense {
  senseKey: string;
  reasons: string[];
  forms?: Record<string, string>;
  notes?: string;
  examples?: string[];
}
/** Full own reviewed evidence distinguishes homographs, while exact seed evidence can merge. */
export function unlinkedAdditionSenseKey(variant: NonNullable<WordCardDraft["translations"][number]["variant"]>, spanish: string, spanishExamples: string[]): string {
  const normalForms = Object.fromEntries(WORD_CARD_FORM_KEYS.map(key => [key, normalizeStudyText(variant.forms[key])]));
  return `reviewed:${hash(JSON.stringify({ german: normalizeStudyText(variant.german), spanish: normalizeStudyText(spanish), category: variant.category, forms: normalForms, notes: normalizeStudyText(variant.notes), examples: variant.examples.map(normalizeStudyText), spanishExamples: spanishExamples.map(normalizeStudyText) }))}`;
}

export interface AdditionSource {
  kind: "related" | "unlinked";
  wordId: string;
  relationIds: string[];
  reason: string;
  required: boolean;
}
export interface AdditionCandidate {
  id: string;
  candidateId: string;
  german: string;
  spanish: string;
  senseKey: string;
  requestedSense: RequestedAdditionSense;
  required: boolean;
  reasons: string[];
  sourceWordIds: string[];
  sourceRelationIds: string[];
  sources: AdditionSource[];
  relatedFrom: { entryId: string; german: string; spanish: string; reason: string; required: boolean }[];
  ids: { german: string; spanish: string; relation: string };
  originalDEReuseId: string | null;
  originalDEReuseHints: string[];
}
export interface ExistingStudyPair {
  german: string;
  spanish: string;
  wordId: string;
  relationId: string;
  ready: boolean;
}
export interface ReviewedAggregate {
  version: number;
  stage: string;
  promptVersion: string;
  promptHash: string;
  sourceHash: string;
  selected: number;
  completed: number;
  pending: number;
  offset: number;
  entries: WordCardDraft[];
}
interface Options { sourceHash: string; reviewHash?: string; allowPartial?: boolean; auditedAt?: string }

/** Lexical input only. Importing the paid runner would also load dotenv/config. */
function catalogInputs(snapshot: any): AuditWordInput[] {
  const collections = snapshot?.collections;
  for (const name of ["WORDS_DE", "WORDS_ES", "WORDS_ES_DE", "userprogresses"]) if (!Array.isArray(collections?.[name])) throw new Error(`Snapshot is missing ${name}`);
  const germanIds = new Set<string>();
  const spanish = new Map<string, any>();
  for (const word of collections.WORDS_DE) {
    const wordId = id(word._id);
    if (!wordId || germanIds.has(wordId)) throw new Error("Snapshot has missing/duplicate German catalog IDs");
    germanIds.add(wordId);
  }
  for (const word of collections.WORDS_ES) {
    const wordId = id(word._id);
    if (!wordId || spanish.has(wordId)) throw new Error("Snapshot has missing/duplicate Spanish catalog IDs");
    spanish.set(wordId, word);
  }
  const relations = new Map<string, AuditWordInput["translations"]>();
  const relationIds = new Set<string>();
  for (const relation of collections.WORDS_ES_DE) {
    const wordId = id(relation.translated), relationId = id(relation._id), spanishWord = spanish.get(id(relation.main));
    if (!relationId || relationIds.has(relationId)) throw new Error("Snapshot has missing/duplicate relation IDs");
    if (!germanIds.has(wordId) || !spanishWord) throw new Error("Snapshot has a dangling lexical relation");
    relationIds.add(relationId);
    const existing = relations.get(wordId) || [];
    existing.push({ relationId, spanish: { id: id(spanishWord._id), word: text(spanishWord.word), examples: strings(spanishWord.examples) } });
    relations.set(wordId, existing);
  }
  return collections.WORDS_DE.map((word: any): AuditWordInput => ({
    id: id(word._id), german: { word: text(word.word), categories: strings(word.gramaticalCategories), forms: Object.fromEntries(Object.entries(word.forms || {}).filter(([, value]) => typeof value === "string")) as Record<string, string>, notes: text(word.notes), examples: strings(word.examples) },
    translations: (relations.get(id(word._id)) || []).sort((a, b) => a.relationId.localeCompare(b.relationId)),
    distinctLiveCards: [],
  }));
}

function validateAggregate(review: ReviewedAggregate, inputs: AuditWordInput[], options: Options) {
  if (review?.version !== 1 || review.stage !== "independent_review") throw new Error("A second-pass independent_review aggregate is required");
  if (review.promptVersion !== WORD_CARD_PROMPT_VERSION || review.promptHash !== currentReviewHash) throw new Error("Review does not match the current word-card prompt");
  if (!/^[\da-f]{64}$/u.test(options.sourceHash) || review.sourceHash !== options.sourceHash) throw new Error("Review sourceHash does not match the exact current snapshot bytes");
  if (!Array.isArray(review.entries) || !Number.isSafeInteger(review.selected) || !Number.isSafeInteger(review.completed) || review.selected < 0 || review.completed < 0 || review.completed !== review.entries.length || review.selected !== review.completed || review.pending !== 0) throw new Error("Review aggregate must have completed === selected === entries.length and pending === 0");
  if (!Number.isSafeInteger(review.offset) || review.offset < 0) throw new Error("Review aggregate has an invalid offset");
  if (!options.allowPartial && (review.offset !== 0 || review.selected !== inputs.length)) throw new Error(`Complete catalog review required: expected ${inputs.length} reviewed German entries; --allow-partial is for explicit offline fixtures/pilots only`);
  const sourceById = new Map(inputs.map(input => [input.id, input]));
  const selected = review.entries.map(entry => sourceById.get(entry?.id));
  if (selected.some(input => !input) || new Set(review.entries.map(entry => entry?.id)).size !== review.entries.length) throw new Error("Review contains missing, unexpected or duplicate source IDs");
  const errors = validateReviewedWordCards({ entries: review.entries }, selected as AuditWordInput[]);
  if (errors.length) throw new Error(`Review structural validation failed: ${errors.slice(0, 8).join("; ")}`);
}

/** Plain input evidence, not final card notes and never inherited from a different same-front sense. */
export function buildWordCardCandidateSnapshot(candidates: AdditionCandidate[], database: string, auditedAt: string) {
  if (!Number.isFinite(Date.parse(auditedAt))) throw new Error("auditedAt must be a valid date");
  const known = new Set<string>();
  const makeWord = (wordId: string, word: string, notes = "") => ({ _id: new BSON.ObjectId(wordId), word, gramaticalCategories: ["UNKNOWN"], forms: {}, notes, examples: [], contexts: [] });
  const requestedNotes = (candidate: AdditionCandidate) => [
    "Requested study sense:", ...candidate.requestedSense.reasons,
    `Requested Spanish sense cue: ${candidate.spanish}`,
    ...(candidate.requestedSense.forms ? WORD_CARD_FORM_KEYS.filter(key => candidate.requestedSense.forms![key]).map(key => `Own independently reviewed ${key}: ${candidate.requestedSense.forms![key]}`) : []),
    ...(candidate.requestedSense.notes ? [`Own independently reviewed notes: ${candidate.requestedSense.notes}`] : []),
    ...(candidate.requestedSense.examples?.length ? ["Own independently reviewed German examples:", ...candidate.requestedSense.examples] : []),
  ].join("\n");
  for (const candidate of candidates) {
    if (!candidate.senseKey || candidate.requestedSense?.senseKey !== candidate.senseKey || !candidate.requestedSense.reasons.length || candidate.requestedSense.reasons.some(reason => typeof reason !== "string" || !reason.trim())) throw new Error("A candidate must preserve its explicit requested sense");
    if (candidate.id !== candidate.ids.german || candidate.candidateId !== candidate.ids.relation || ["DE", "ES", "relation"].some((kind, index) => additionId(kind as "DE" | "ES" | "relation", candidate.german, candidate.spanish, candidate.senseKey) !== [candidate.ids.german, candidate.ids.spanish, candidate.ids.relation][index])) throw new Error("Candidate synthetic identities must bind the requested sense");
    for (const value of Object.values(candidate.ids)) { if (known.has(value)) throw new Error("Candidate snapshot contains colliding synthetic IDs"); known.add(value); }
  }
  return { auditedAt, database: database || "offline-word-card-candidates", collections: {
    WORDS_DE: candidates.map(candidate => makeWord(candidate.ids.german, candidate.german, requestedNotes(candidate))),
    WORDS_ES: candidates.map(candidate => makeWord(candidate.ids.spanish, candidate.spanish)),
    WORDS_ES_DE: candidates.map(candidate => ({ _id: new BSON.ObjectId(candidate.ids.relation), main: new BSON.ObjectId(candidate.ids.spanish), translated: new BSON.ObjectId(candidate.ids.german) })),
    userprogresses: [],
  } };
}

/** Builds proposals, never insertion documents or fabricated semantic checkpoints. */
export function prepareWordCardAdditions(snapshot: any, review: ReviewedAggregate, options: Options) {
  const inputs = catalogInputs(snapshot);
  validateAggregate(review, inputs, options);
  const auditedAt = options.auditedAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(auditedAt))) throw new Error("auditedAt must be a valid date");
  const inputById = new Map(inputs.map(input => [input.id, input]));
  const inputsByBare = new Map<string, AuditWordInput[]>();
  for (const input of inputs) {
    const bare = bareNoun(input.german.word);
    inputsByBare.set(bare, [...(inputsByBare.get(bare) || []), input]);
  }
  const draftById = new Map(review.entries.map(draft => [draft.id, draft]));
  const existingPairs = new Map<string, ExistingStudyPair[]>();
  const existingFronts = new Map<string, ExistingStudyPair[]>();
  const reviewQueue: { wordId: string; category: string; reasons: string[]; relatedCandidatesExcluded: number; requiredCompanionsExcluded: number }[] = [];
  const excludedEntries: { wordId: string; reason: string; relatedCandidatesExcluded: number }[] = [];
  const proposed = new Map<string, { german: string; spanish: string; senseKey: string; requestedSense: RequestedAdditionSense; sources: AdditionSource[] }>();
  let initialProposals = 0;
  const add = (german: string, spanish: string, source: AdditionSource, requestedSense: RequestedAdditionSense) => {
    if (!german.trim() || !spanish.trim()) throw new Error("Candidate fronts must be nonempty");
    initialProposals++;
    const key = JSON.stringify([pairKey(german, spanish), requestedSense.senseKey]), existing = proposed.get(key);
    const front = displayText(german), back = displayText(spanish);
    if (existing) {
      existing.sources.push(source);
      // Choose a deterministic display spelling among case-equivalent proposals.
      const current = displayRank(existing.german, existing.spanish), alternative = displayRank(front, back);
      if (alternative[0] < current[0] || (alternative[0] === current[0] && alternative[1] < current[1])) { existing.german = front; existing.spanish = back; }
    } else proposed.set(key, { german: front, spanish: back, senseKey: requestedSense.senseKey, requestedSense, sources: [source] });
  };
  for (const draft of [...review.entries].sort((a, b) => a.id.localeCompare(b.id))) {
    const source = inputById.get(draft.id)!;
    const unsupportedCategory = !reviewedWordCardCategoryReady(draft) || draft.translations.some(translation => !reviewedWordCardCategoryReady(translation.variant!, translation.spanish));
    const unresolved = draft.confidence !== "high" || unsupportedCategory || draft.translations.some(translation => translation.variant!.confidence !== "high");
    if (!draft.studyEligible) excludedEntries.push({ wordId: draft.id, reason: "studyEligible=false", relatedCandidatesExcluded: draft.relatedCandidates.length });
    else if (unresolved) reviewQueue.push({ wordId: draft.id, category: draft.category, reasons: unique([draft.reviewReason, ...draft.translations.map(translation => translation.variant!.reviewReason), ...(unsupportedCategory ? ["UNKNOWN category without a reviewed idiom annotation or an explicitly source-checked invariant seed with empty notes/forms"] : [])].filter(Boolean)), relatedCandidatesExcluded: draft.relatedCandidates.length, requiredCompanionsExcluded: draft.relatedCandidates.filter(candidate => candidate.reason.startsWith("split_existing_sense")).length });
    for (const translation of draft.translations) {
      if (!translation.relationId) continue;
      const variant = translation.variant!;
      // Even uncertain/excluded existing senses prevent an automatic new-pair claim.
      const pair = { german: variant.german, spanish: translation.spanish, wordId: draft.id, relationId: translation.relationId, ready: draft.studyEligible && !unresolved };
      const key = pairKey(pair.german, pair.spanish), front = normalizeStudyText(pair.german);
      existingPairs.set(key, [...(existingPairs.get(key) || []), pair]);
      existingFronts.set(front, [...(existingFronts.get(front) || []), pair]);
    }
    if (!draft.studyEligible || unresolved) continue;
    for (const candidate of draft.relatedCandidates) add(candidate.german, candidate.spanish, { kind: "related", wordId: draft.id, relationIds: source.translations.map(translation => translation.relationId), reason: candidate.reason, required: candidate.reason.startsWith("split_existing_sense") }, { senseKey: relatedAdditionSenseKey(candidate.reason), reasons: [candidate.reason] });
    if (!source.translations.length) {
      const translation = draft.translations[0];
      const variant = translation.variant!, reason = "Reviewed study-eligible German entry has no existing translation relation";
      add(variant.german, translation.spanish, { kind: "unlinked", wordId: draft.id, relationIds: [], reason, required: false }, { senseKey: unlinkedAdditionSenseKey(variant, translation.spanish, translation.examples), reasons: [reason], forms: { ...variant.forms }, notes: variant.notes, examples: [...variant.examples] });
    }
  }
  const proposedFronts = new Map<string, string[]>();
  for (const [key, proposal] of proposed) {
    const front = normalizeStudyText(proposal.german);
    proposedFronts.set(front, [...(proposedFronts.get(front) || []), key]);
  }
  const candidates: AdditionCandidate[] = [];
  const coveredCandidates: (AdditionCandidate & { existingMatches: ExistingStudyPair[] })[] = [];
  const ambiguousCandidates: (AdditionCandidate & { ambiguity: string; potentialMatchingStudyBackSenses: ExistingStudyPair[]; alternativeCandidateSenses: { candidateId: string; german: string; spanish: string; senseKey: string; reasons: string[]; requestedSense: RequestedAdditionSense; sourceWordIds: string[] }[] })[] = [];
  for (const [key, proposal] of [...proposed].sort(([a], [b]) => a.localeCompare(b))) {
    const sources = proposal.sources.sort((a, b) => a.wordId.localeCompare(b.wordId) || a.kind.localeCompare(b.kind) || a.reason.localeCompare(b.reason));
    // Reuse is a mapping hint, never an ID that enters the synthetic provider snapshot.
    const reuseHints = (inputsByBare.get(bareNoun(proposal.german)) || []).filter(input => {
      const originalArticle = /^(der|die|das)\s/u.exec(normalizeStudyText(input.german.word))?.[1];
      const candidateArticle = /^(der|die|das)\s/u.exec(normalizeStudyText(proposal.german))?.[1];
      if (originalArticle && originalArticle !== candidateArticle) return false;
      const draft = draftById.get(input.id);
      return proposal.sources.some(source => source.kind === "unlinked" && source.wordId === input.id) && draft?.studyEligible && draft.confidence === "high" && reviewedWordCardCategoryReady(draft) && draft.translations.some(translation => translation.variant?.confidence === "high" && reviewedWordCardCategoryReady(translation.variant, translation.spanish) && pairKey(translation.variant.german, translation.spanish) === pairKey(proposal.german, proposal.spanish) && unlinkedAdditionSenseKey(translation.variant, translation.spanish, translation.examples) === proposal.senseKey);
    }).map(input => input.id).sort();
    const reasons = unique(sources.map(source => source.reason));
    const candidate: AdditionCandidate = { id: additionId("DE", proposal.german, proposal.spanish, proposal.senseKey), candidateId: additionId("relation", proposal.german, proposal.spanish, proposal.senseKey), german: proposal.german, spanish: proposal.spanish, senseKey: proposal.senseKey, requestedSense: { ...proposal.requestedSense, reasons }, required: sources.some(source => source.required), reasons, sourceWordIds: unique(sources.map(source => source.wordId)), sourceRelationIds: unique(sources.flatMap(source => source.relationIds)), sources, relatedFrom: sources.map(source => ({ entryId: source.wordId, german: proposal.german, spanish: proposal.spanish, reason: source.reason, required: source.required })),
      ids: { german: additionId("DE", proposal.german, proposal.spanish, proposal.senseKey), spanish: additionId("ES", proposal.german, proposal.spanish, proposal.senseKey), relation: additionId("relation", proposal.german, proposal.spanish, proposal.senseKey) }, originalDEReuseId: reuseHints.length === 1 ? reuseHints[0] : null, originalDEReuseHints: reuseHints };
    const exact = existingPairs.get(pairKey(proposal.german, proposal.spanish)) || [];
    const matching = existingFronts.get(normalizeStudyText(proposal.german)) || [];
    const alternatives = (proposedFronts.get(normalizeStudyText(proposal.german)) || []).filter(otherKey => otherKey !== key).map(otherKey => proposed.get(otherKey)!);
    if (matching.length || alternatives.length) {
      ambiguousCandidates.push({ ...candidate, ambiguity: exact.length ? "Identical front pair is not a sense identity; semantic deduplication required" : "Same German front has other existing or proposed sense evidence; semantic deduplication required", potentialMatchingStudyBackSenses: matching, alternativeCandidateSenses: alternatives.map(other => {
        const otherReasons = unique(other.sources.map(source => source.reason));
        return { candidateId: additionId("relation", other.german, other.spanish, other.senseKey), german: other.german, spanish: other.spanish, senseKey: other.senseKey, reasons: otherReasons, requestedSense: { ...other.requestedSense, reasons: otherReasons }, sourceWordIds: unique(other.sources.map(source => source.wordId)) };
      }).sort((a, b) => a.candidateId.localeCompare(b.candidateId)) });
    } else candidates.push(candidate);
  }
  const candidateSnapshot = buildWordCardCandidateSnapshot(candidates, text(snapshot.database), auditedAt);
  const required = (items: { required: boolean }[]) => items.filter(item => item.required).length;
  const summary = { version: 1, intentVersion: 2, stage: "offline_addition_candidates", auditedAt, sourceHash: options.sourceHash, reviewHash: options.reviewHash || hash(JSON.stringify(review)), reviewPromptHash: review.promptHash, partial: !!options.allowPartial, coverage: {
    snapshotGermanEntries: inputs.length, reviewedEntries: review.entries.length, eligibleReviewedEntries: review.entries.length - excludedEntries.length - reviewQueue.length, excludedNonStudyEntries: excludedEntries.length, unresolvedEntries: reviewQueue.length,
    existingStudyPairs: existingPairs.size, initialProposals, uniqueProposals: proposed.size, exactDuplicateProposals: initialProposals - proposed.size, coveredExactCandidates: coveredCandidates.length, missingCandidates: candidates.length, ambiguousCandidates: ambiguousCandidates.length,
    requiredCompanions: { coveredExact: required(coveredCandidates), missing: required(candidates), ambiguous: required(ambiguousCandidates), excludedPendingReview: reviewQueue.reduce((sum, item) => sum + item.requiredCompanionsExcluded, 0), excludedNonStudy: excludedEntries.reduce((sum, item) => sum + (draftById.get(item.wordId)?.relatedCandidates.filter(candidate => candidate.reason.startsWith("split_existing_sense")).length ?? 0), 0) },
  }, notice: "Offline proposals only. Synthetic IDs bind the requested sense and are not inserted database documents. Front-pair text never proves sense coverage. No owners/progress records, provider calls, or database mutations. Companion generation and independent review remain required; same-front proposals require semantic deduplication. Only the initial reviewed scope contributes candidates." };
  return { summary, candidateSnapshot, candidates, coveredCandidates, ambiguousCandidates, reviewQueue, excludedEntries };
}

async function writePrivate(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function main() {
  const args = process.argv.slice(2), values = new Map<string, string>();
  let allowPartial = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--allow-partial") { allowPartial = true; continue; }
    if (arg === "--help") { console.log("Offline only: --snapshot before.ejson --review review/drafts.json --output directory [--allow-partial for fixtures/pilots]"); return; }
    if (!["--snapshot", "--review", "--output"].includes(arg) || !args[index + 1] || args[index + 1].startsWith("--") || values.has(arg)) throw new Error("Expected --snapshot, --review and --output paths; optional --allow-partial is offline-only");
    values.set(arg, args[++index]);
  }
  if (!["--snapshot", "--review", "--output"].every(arg => values.has(arg))) throw new Error("--snapshot, --review and --output are required");
  const snapshotPath = resolve(values.get("--snapshot")!), reviewPath = resolve(values.get("--review")!), output = resolve(values.get("--output")!);
  const [sourceText, reviewText] = await Promise.all([readFile(snapshotPath, "utf8"), readFile(reviewPath, "utf8")]);
  const result = prepareWordCardAdditions(BSON.EJSON.parse(sourceText), JSON.parse(reviewText), { sourceHash: hash(sourceText), reviewHash: hash(reviewText), allowPartial });
  const outputs: [string, string][] = [
    ["candidate-before.ejson", BSON.EJSON.stringify(result.candidateSnapshot, { relaxed: false }, 2) + "\n"],
    ["candidates.json", JSON.stringify({ ...result.summary, candidates: result.candidates, coveredCandidates: result.coveredCandidates }, null, 2) + "\n"],
    ["ambiguous-candidates.json", JSON.stringify({ ...result.summary, ambiguousCandidates: result.ambiguousCandidates }, null, 2) + "\n"],
    ["review-queue.json", JSON.stringify({ ...result.summary, reviewQueue: result.reviewQueue, excludedEntries: result.excludedEntries }, null, 2) + "\n"],
    ["summary.json", JSON.stringify(result.summary, null, 2) + "\n"],
  ];
  if (outputs.some(([name]) => [snapshotPath, reviewPath].includes(resolve(output, name)))) throw new Error("Output must not overwrite either source input");
  for (const [name, contents] of outputs) await writePrivate(resolve(output, name), contents);
  console.log(JSON.stringify(result.summary));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : "Offline candidate preparation failed"); process.exitCode = 1; });
