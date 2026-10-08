import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BSON, ObjectId, type Document } from "mongodb";
import { CEFR_LEVELS } from "../src/features/levels/levels.js";
import { LearningContext, WordLevel } from "../src/features/words/words.types.js";
import { WORD_CARD_FORM_KEYS, WORD_CARD_PROMPT_VERSION, WORD_CARD_REVIEW_INSTRUCTIONS, WORD_CARD_REVIEW_SCHEMA, validateReviewedWordCards, type AuditWordInput, type WordCardDraft, type WordCardVariant } from "./lib/wordCardPrompt.js";
import { deterministicWordCardId, sameWordCardBson, serializeWordCardEjson, validateWordCardManifest, wordCardSHA256, WordCardMigrationError, WORD_CARD_PROGRESS_IDENTITY_PATHS, type WordCardCollection, type WordCardManifest, type WordCardPatch } from "./lib/wordCardMigration.js";
import { buildCandidateReviewInputs, CandidateInputError, CANDIDATE_HELPER_MODEL, CANDIDATE_HELPER_VERSION, CANDIDATE_DECISION_INSTRUCTIONS, CANDIDATE_DECISION_SCHEMA, permitsRequestedSenseCoverage, validateCandidateAliases, validateCandidateDecisions } from "./reviewWordCardCandidates.js";
import { ANSWER_REVIEW_MODEL, ANSWER_REVIEW_PROMPT_HASH, ANSWER_REVIEW_VERSION, answerReviewGroupId, AnswerReviewError, buildAnswerReviewInputs, validateAnswerReviewDecisions, type AnswerReviewDecision } from "./reviewWordCardAnswers.js";
import { additionId, relatedAdditionSenseKey, reviewedWordCardCategoryReady, unlinkedAdditionSenseKey } from "./prepareWordCardAdditions.js";
import { buildFinalCandidateInputs, validateFinalCandidateProof, type FinalCandidateDecision } from "./reviewFinalWordCardCandidates.js";
import { loadFinalCandidateProofEvidence, type FinalCandidateProofEvidence } from "./lib/finalCandidateProofEvidence.js";

type Snapshot = { auditedAt: unknown; collections: Record<WordCardCollection, Document[]> };
type Review = { version: number; stage: string; promptVersion: string; promptHash: string; sourceHash: string; auditedAt: string; entries: WordCardDraft[]; offset?: number; selected?: number; completed?: number; pending?: number };
type Candidate = { id: string; candidateId: string; german: string; spanish: string; senseKey: string; requestedSense: { senseKey: string; reasons: string[]; forms?: Record<string, string>; notes?: string; examples?: string[] }; ids: { german: string; spanish: string; relation: string }; originalDEReuseId?: string | null; naturalSpanish?: string; relatedFrom: { entryId: string; german: string; spanish: string; reason: string }[]; sources?: { kind: string; wordId: string; reason: string }[] };
type CandidateMap = { version: number; intentVersion: number; stage: string; sourceHash: string; reviewHash: string; reviewPromptHash: string; partial?: boolean; finalized?: boolean; candidateSnapshotSHA256?: string; finalization?: any; candidates: Candidate[]; coveredCandidates?: any[] };
export interface BuildWordCardAuditOptions { snapshot: Snapshot; snapshotSHA256: string; review: Review; reviewSHA256?: string; allowPartial?: boolean; requireFinalCandidateEvidence?: boolean; additions?: { snapshot: Snapshot; snapshotSHA256: string; review: Review; map: CandidateMap }; candidateDecisions?: { decisions: any; inputs: any; ambiguities: any; ambiguitiesSHA256: string; decisionsSHA256?: string; inputsSHA256?: string }; finalCandidateProof?: { decisions: any; provenance: any; additionReviewSHA256: string; candidateMapSHA256: string; provenanceSHA256: string; evidence?: FinalCandidateProofEvidence }; answerReview?: any }
type QueueItem = { kind: string; entryId?: string; progressId?: string; relationId?: string; reason: string; [key: string]: unknown };
type Source = { entry: WordCardDraft; original: Document; addition?: Candidate; auditedAt: Date };
type PairPlan = { relation: Document; german: ObjectId; spanishSource: Document; variant: WordCardVariant; spanish: string; spanishExamples: string[]; auditedAt: Date; entryId: string };
const collections: WordCardCollection[] = ["WORDS_DE", "WORDS_ES", "WORDS_ES_DE", "userprogresses"];
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (message: string): never => { throw new WordCardMigrationError(message); };
const oid = (value: unknown) => value instanceof ObjectId ? value.toHexString() : typeof value === "string" && /^[a-f\d]{24}$/i.test(value) ? value.toLowerCase() : fail("Snapshot or mapping has an invalid ObjectId");
const front = (text: string) => text.normalize("NFC").trim().replace(/\s+/gu, " ");
const pairKey = (german: string, spanish: string) => `${front(german)}\u0000${front(spanish)}`;
const candidateKey = (german: string, spanish: string) => pairKey(german, spanish).toLowerCase();
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && Object.getPrototypeOf(value) === Object.prototype ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const signature = (value: unknown) => wordCardSHA256(serializeWordCardEjson(canonical(value)));
const lexical = (variant: Pick<WordCardVariant, "german" | "category" | "forms" | "notes" | "examples">) => ({ german: variant.german, category: variant.category, forms: variant.forms, notes: variant.notes, examples: variant.examples });
const topVariant = (entry: WordCardDraft): WordCardVariant => ({ ...lexical(entry), confidence: entry.confidence, reviewReason: entry.reviewReason });
const emptyRelated = () => Object.fromEntries(["synonyms", "antonyms", "homophones", "homonymous", "paronyms", "verbFamilies"].map(key => [key, []]));
const isNew = (progress: Document) => progress.scheduler ? progress.scheduler.phase === "NEW" : !!progress.isNew;
const stripArticle = (word: string) => front(word).replace(/^(?:der|die|das)\s+/iu, "");
const plainCanonicalAnswer = (text: string) => front(text.replace(/\s*\((?:formal|rflxv\.?)\)/giu, ""));

/** A different noun head cannot supply the grammar of a preserved phrase-lookup token. */
function primaryRetainsNounLookup(word: string, variant: WordCardVariant) {
  if (variant.category !== "NOUN") return true;
  const head = (text: string) => {
    const words = stripArticle(text).split(/\s/u);
    return (words.find(token => /^[A-ZÄÖÜ]/u.test(token)) || words[0]).toLocaleLowerCase("de");
  };
  const sourceHead = head(word), canonicalHead = head(variant.german);
  return sourceHead === canonicalHead || (!!variant.forms.plural && sourceHead === head(variant.forms.plural));
}

function variantLookupWord(word: string, variant: WordCardVariant) {
  if (variant.category === "NOUN") return primaryRetainsNounLookup(word, variant) ? word : variant.german;
  const bare = (text: string) => plainCanonicalAnswer(text).toLocaleLowerCase("de");
  if (variant.category === "VERB" && bare(word).split(/\s/u).at(-1) === bare(variant.german).split(/\s/u).at(-1)) return word;
  return bare(word) === bare(variant.german) ? word : variant.german;
}

function validateCandidateSource(candidate: Candidate, review: Review) {
  if (!candidate || typeof candidate.german !== "string" || !candidate.german.trim() || typeof candidate.spanish !== "string" || !candidate.spanish.trim() || typeof candidate.senseKey !== "string" || !candidate.senseKey.trim() || candidate.requestedSense?.senseKey !== candidate.senseKey || !Array.isArray(candidate.requestedSense.reasons) || !candidate.requestedSense.reasons.length || candidate.requestedSense.reasons.some(reason => typeof reason !== "string" || !reason.trim()) || !Array.isArray(candidate.relatedFrom) || !candidate.relatedFrom.length) fail("Candidate requires an explicit requested sense and original proposal mapping");
  if (candidate.relatedFrom.some(source => typeof source.entryId !== "string" || typeof source.german !== "string" || typeof source.spanish !== "string" || typeof source.reason !== "string") || new Set(candidate.requestedSense.reasons).size !== candidate.requestedSense.reasons.length || !sameWordCardBson([...candidate.requestedSense.reasons].sort(), [...new Set(candidate.relatedFrom.map(source => source.reason))].sort())) fail("Candidate requested intention reasons must exactly cover its original sources");
  if (candidate.id !== additionId("DE", candidate.german, candidate.spanish, candidate.senseKey) || candidate.candidateId !== additionId("relation", candidate.german, candidate.spanish, candidate.senseKey) || candidate.ids.german !== candidate.id || candidate.ids.relation !== candidate.candidateId || candidate.ids.spanish !== additionId("ES", candidate.german, candidate.spanish, candidate.senseKey)) fail("Candidate deterministic identity does not preserve its requested sense");
  for (const source of candidate.relatedFrom) {
    const entry = review.entries.find(entry => entry.id === source.entryId), sourcePair = candidateKey(source.german, source.spanish);
    const related = entry?.relatedCandidates.some(related => candidateKey(related.german, related.spanish) === sourcePair && related.reason === source.reason);
    const unlinked = candidate.sources?.some(origin => origin.kind === "unlinked" && origin.wordId === source.entryId && origin.reason === source.reason) && entry?.translations.every(translation => !translation.relationId) && entry?.translations.some(translation => candidateKey(translation.variant!.german, translation.spanish) === sourcePair);
    if (!(related || unlinked) || sourcePair !== candidateKey(candidate.german, candidate.spanish) || !candidate.requestedSense.reasons.includes(source.reason)) fail("Candidate source mapping is not an exact reviewed requested intention");
    if (related) {
      if (candidate.senseKey !== relatedAdditionSenseKey(source.reason) || Object.values(candidate.requestedSense.forms ?? {}).some(Boolean) || candidate.requestedSense.notes || candidate.requestedSense.examples?.length) fail("Related candidate intention must preserve its reason without inheriting another sense's lexical evidence");
    } else {
      const translation = entry!.translations.find(translation => candidateKey(translation.variant!.german, translation.spanish) === sourcePair)!;
      if (candidate.senseKey !== unlinkedAdditionSenseKey(translation.variant!, translation.spanish, translation.examples) || !sameWordCardBson(candidate.requestedSense.forms, translation.variant!.forms) || candidate.requestedSense.notes !== translation.variant!.notes || !sameWordCardBson(candidate.requestedSense.examples, translation.variant!.examples)) fail("Unlinked candidate intention must preserve its complete own reviewed lexical evidence");
    }
  }
}
const matchesProposal = (candidate: Candidate, entryId: string, proposal: { german: string; spanish: string; reason: string }) => candidate.relatedFrom.some(source => source.entryId === entryId && candidateKey(source.german, source.spanish) === candidateKey(proposal.german, proposal.spanish) && source.reason === proposal.reason);

function candidateProof(options: BuildWordCardAuditOptions, expectedCount: number) {
  if (!options.candidateDecisions) return undefined;
  const proof = options.candidateDecisions, inputs = buildCandidateReviewInputs(proof.ambiguities, options.review, expectedCount);
  if (!/^[a-f\d]{64}$/u.test(options.reviewSHA256 || "") || !/^[a-f\d]{64}$/u.test(proof.ambiguitiesSHA256)) fail("Candidate proof requires exact review and ambiguity-file checksums");
  const sourceHash = wordCardSHA256(JSON.stringify({ ambiguousHash: proof.ambiguitiesSHA256, reviewHash: options.reviewSHA256 })), scopeHash = wordCardSHA256(JSON.stringify(inputs));
  const promptHash = wordCardSHA256(CANDIDATE_HELPER_VERSION + CANDIDATE_DECISION_INSTRUCTIONS + JSON.stringify(CANDIDATE_DECISION_SCHEMA));
  for (const artifact of [proof.inputs, proof.decisions]) {
    if (artifact?.version !== 1 || artifact.helperVersion !== CANDIDATE_HELPER_VERSION || artifact.mode !== "dedup" || artifact.sourceHash !== sourceHash || artifact.reviewHash !== options.reviewSHA256 || artifact.scopeHash !== scopeHash || artifact.promptHash !== promptHash || artifact.model !== CANDIDATE_HELPER_MODEL || artifact.offset !== 0 || artifact.selected !== inputs.length || artifact.totalScope !== inputs.length) fail("Candidate decision/input provenance does not match the complete exact reviewed source scope");
  }
  if (!sameWordCardBson(proof.inputs.entries, inputs) || proof.decisions.status !== "helper_complete" || proof.decisions.fullScopeComplete !== true || proof.decisions.completed !== inputs.length || proof.decisions.pending !== 0 || !Array.isArray(proof.decisions.aliasErrors) || proof.decisions.aliasErrors.length) fail("Candidate decisions require complete reconstructed inputs and successful alias validation");
  const decisions = validateCandidateDecisions(proof.decisions, inputs); validateCandidateAliases(decisions, inputs);
  const inputsById = new Map(inputs.map(input => [input.candidateId, input]));
  for (const decision of decisions) {
    const input = inputsById.get(decision.candidateId)!;
    if (decision.coveredByIDs.some(relationId => front(input.german).toLowerCase() !== front(input.potentialMatches.find(match => match.relationId === relationId)!.german).toLowerCase())) fail("Existing candidate coverage must preserve the entire German construction front");
    if (decision.coveredByCandidateIds.some(candidateId => {
      const peer = input.alternativeCandidates.find(peer => peer.candidateId === candidateId)!, actual = inputsById.get(candidateId);
      return !actual || candidateKey(peer.german, peer.spanish) !== candidateKey(actual.german, actual.spanish);
    })) fail("Candidate alias target differs from the completed representative input");
  }
  const candidates = new Map<string, any>();
  for (const candidate of proof.ambiguities.ambiguousCandidates) {
    validateCandidateSource(candidate, options.review);
    candidates.set(candidate.candidateId, candidate);
  }
  return { inputs: new Map(inputs.map(input => [input.candidateId, input])), decisions: new Map(decisions.map(decision => [decision.candidateId, decision])), candidates };
}

function answerProof(options: BuildWordCardAuditOptions) {
  if (!options.answerReview) return new Map<string, AnswerReviewDecision>();
  const proof = options.answerReview, prepared = buildAnswerReviewInputs(options.snapshot, options.review);
  if (!/^[a-f\d]{64}$/u.test(options.reviewSHA256 || "") || proof?.version !== 1 || proof.stage !== "word_card_answer_review" || proof.helperVersion !== ANSWER_REVIEW_VERSION || proof.sourceHash !== options.snapshotSHA256 || proof.reviewHash !== options.reviewSHA256 || proof.inputsHash !== wordCardSHA256(JSON.stringify(prepared.inputs)) || proof.promptHash !== ANSWER_REVIEW_PROMPT_HASH || proof.model !== ANSWER_REVIEW_MODEL || proof.selected !== prepared.inputs.length || proof.completed !== prepared.inputs.length || proof.pending !== 0 || !sameWordCardBson(proof.coverage, prepared.coverage) || !sameWordCardBson(proof.excludedGroups, prepared.excludedGroups) || !Number.isFinite(Date.parse(proof.auditedAt))) fail("Answer review provenance or complete frozen-source coverage is invalid");
  return new Map(validateAnswerReviewDecisions(proof, prepared.inputs).map(decision => [decision.id, decision]));
}

function snapshotMaps(snapshot: Snapshot) {
  const maps = Object.fromEntries(collections.map(collection => {
    if (!Array.isArray(snapshot.collections?.[collection])) fail(`Snapshot is missing ${collection}`);
    const entries = snapshot.collections[collection].map(doc => [oid(doc._id), doc] as const);
    if (new Set(entries.map(([id]) => id)).size !== entries.length) fail(`Snapshot contains duplicate ${collection} IDs`);
    return [collection, new Map(entries)];
  })) as Record<WordCardCollection, Map<string, Document>>;
  for (const relation of maps.WORDS_ES_DE.values()) if (!maps.WORDS_DE.has(oid(relation.translated)) || !maps.WORDS_ES.has(oid(relation.main))) fail("Snapshot has a dangling catalog relation");
  return maps;
}
function auditInputs(snapshot: Snapshot, maps: ReturnType<typeof snapshotMaps>): AuditWordInput[] {
  return snapshot.collections.WORDS_DE.map(word => {
    const relations = [...maps.WORDS_ES_DE.values()].filter(relation => oid(relation.translated) === oid(word._id));
    const relationIds = new Set(relations.map(relation => oid(relation._id)));
    const cards = snapshot.collections.userprogresses.filter(p => p.itemType === "WORD" && p.card && relationIds.has(oid(p.relationId ?? p.itemId))).map(p => ({ direction: p.card.direction, prompt: p.card.prompt, answer: p.card.answer, notes: p.card.notes ?? "", examples: p.card.examples ?? [] }));
    return { id: oid(word._id), german: { word: word.word ?? "", categories: word.gramaticalCategories ?? [], forms: Object.fromEntries(Object.entries(word.forms ?? {}).filter(([, value]) => typeof value === "string")) as Record<string, string>, notes: word.notes ?? "", examples: word.examples ?? [] },
      translations: relations.sort((a, b) => oid(a._id).localeCompare(oid(b._id))).map(relation => { const spanish = maps.WORDS_ES.get(oid(relation.main))!; return { relationId: oid(relation._id), spanish: { id: oid(spanish._id), word: spanish.word, examples: spanish.examples ?? [] } }; }), distinctLiveCards: cards,
    };
  });
}
function checkReview(snapshot: Snapshot, snapshotHash: string, review: Review, allowPartial: boolean) {
  const promptHash = wordCardSHA256(WORD_CARD_PROMPT_VERSION + WORD_CARD_REVIEW_INSTRUCTIONS + JSON.stringify(WORD_CARD_REVIEW_SCHEMA));
  if (!/^[a-f\d]{64}$/i.test(snapshotHash) || review?.sourceHash !== snapshotHash || review.stage !== "independent_review" || review.promptVersion !== WORD_CARD_PROMPT_VERSION || review.promptHash !== promptHash || Number(review.version) !== 1 || !Array.isArray(review.entries)) fail("Review provenance, stage, prompt, version or exact snapshot checksum is invalid");
  const maps = snapshotMaps(snapshot), inputs = auditInputs(snapshot, maps), expected = new Map(inputs.map(input => [input.id, input]));
  const ids = review.entries.map(entry => entry.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !expected.has(id))) fail("Review has duplicate or out-of-scope German IDs");
  if (!allowPartial && ids.length !== inputs.length) fail("Full snapshot review coverage is required; --allow-partial is only for a pilot preview");
  const errors = validateReviewedWordCards({ entries: review.entries }, ids.map(id => expected.get(id)!));
  if (errors.length) fail(`Reviewed draft structural validation failed (${errors.length} errors)`);
  const auditedAt = new Date(review.auditedAt);
  if (!Number.isFinite(auditedAt.getTime())) fail("Review has an invalid audit timestamp");
  return { maps, inputs, auditedAt, missing: inputs.filter(input => !ids.includes(input.id)).map(input => input.id) };
}
function formattedSourceNotes(value: unknown) {
  if (typeof value !== "string") return "";
  return value.replace(/<br\s*\/?\s*>/giu, "\n").replace(/<[^>]*>/gu, "").replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/&lt;/giu, "‹").replace(/&gt;/giu, "›").replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'").replace(/\r\n?/gu, "\n").replace(/\\n/gu, "\n").trim();
}
/** Conservative provenance cleanup for German entries whose semantic revision is deferred. */
export function cleanGenericGermanSourceNotes(value: unknown) {
  return formattedSourceNotes(value).split("\n").filter(line => !/^(?:auto[- ]?generated\b|dictionary metadata generated\b|dictionary form reviewed\b)/iu.test(line.trim())).join("\n").trim();
}
/** Spanish source notes receive a format/generic-seed cleanup, never copied German notes. */
export function cleanSpanishWordNotes(value: unknown) {
  const clean = formattedSourceNotes(value);
  const generic = /^(?:auto[- ]?generated|automatically generated|generated (?:word|from)|seed(?:ed)?\b|imported from|dictionary metadata generated\b|dictionary form reviewed\b|regular conjugation|no plural|kein plural)/iu;
  return clean.split("\n").filter(line => !generic.test(line.trim())).join("\n").trim();
}
/** Remove only the original Anki array's complete ordered 1) / 2) / 3) markers. */
export function cleanImportedCardExampleNumbering(value: unknown) {
  if (!Array.isArray(value) || !value.length || !value.every((example, index) => typeof example === "string" && new RegExp(`^\\s*${index + 1}\\)\\s+`, "u").test(example))) return value;
  return value.map((example, index) => example.replace(new RegExp(`^\\s*${index + 1}\\)\\s+`, "u"), ""));
}
function cloneMetadata(source: Document, auditedAt: Date) {
  const metadata: Document = { contexts: Array.isArray(source.contexts) ? source.contexts.filter(context => Object.values(LearningContext).includes(context)) : [], relatedWords: emptyRelated() };
  if (Object.values(WordLevel).includes(source.level)) metadata.level = source.level;
  if (CEFR_LEVELS.includes(source.cefrLevel)) {
    metadata.cefrLevel = source.cefrLevel;
    metadata.cefrClassification = { level: source.cefrLevel, model: "parent-estimate", version: 1, classifiedAt: auditedAt };
  }
  return metadata;
}

/** Offline compilation only. Review confidence is never presented as dictionary-source verification. */
export function buildWordCardAudit(options: BuildWordCardAuditOptions) {
  const checked = checkReview(options.snapshot, options.snapshotSHA256, options.review, !!options.allowPartial), maps = checked.maps;
  const decisionProof = candidateProof(options, checked.inputs.length), answerDecisions = answerProof(options);
  const queue: QueueItem[] = checked.missing.map(entryId => ({ kind: "missing_review", entryId, reason: "No independent review for this snapshot entry" }));
  const report: any = { version: 1, auditedAt: checked.auditedAt.toISOString(), snapshotSHA256: options.snapshotSHA256, snapshotAuditedAt: options.snapshot.auditedAt, sourceVerified: false,
    notice: "Independent model review and structural checks are linguistic proposals, not per-record dictionary/corpus-source verification. This offline tool makes no database writes.",
    coverage: { snapshotGerman: checked.inputs.length, snapshotSpanish: maps.WORDS_ES.size, snapshotRelations: maps.WORDS_ES_DE.size, snapshotWordProgress: options.snapshot.collections.userprogresses.filter(progress => progress.itemType === "WORD").length, independentlyReviewed: options.review.entries.length, missingReview: checked.missing.length, partialPreview: !!options.allowPartial, completeReviewCoverage: !checked.missing.length },
    entries: [] as any[], clones: [] as any[], additions: [] as any[], newLegacyPairingIds: [] as string[], classifications: [] as any[],
  };
  const manifest: WordCardManifest = { version: 1, auditedAt: checked.auditedAt.toISOString(), snapshotSHA256: options.snapshotSHA256, patches: [], inserts: [] };
  const patches = new Map<string, WordCardPatch>(), inserts = new Map<string, Document>();
  const patchDocument = (collection: WordCardCollection, original: Document, next: Document, forcedPaths: string[] = []) => {
    const key = `${collection}:${oid(original._id)}`;
    let patch = patches.get(key);
    for (const [path, value] of Object.entries(next)) {
      const segments = path.split("."); let previous: any = original, present = true;
      for (const segment of segments) { if (previous === null || typeof previous !== "object" || !own(previous, segment)) { present = false; break; } previous = previous[segment]; }
      if (!forcedPaths.includes(path) && present && sameWordCardBson(previous, value)) {
        if (patch) { delete patch.set[path]; delete patch.before[path]; patch.missingBefore = patch.missingBefore.filter(missing => missing !== path); }
        continue;
      }
      if (!patch) { patch = { collection, id: oid(original._id), set: {}, unset: [], before: {}, missingBefore: [] }; patches.set(key, patch); }
      if (!own(patch.set, path)) { if (present) patch.before[path] = previous; else patch.missingBefore.push(path); }
      patch.set[path] = value;
    }
    if (patch && !Object.keys(patch.set).length) patches.delete(key);
    else if (patch && (collection === "userprogresses" || collection === "WORDS_DE" || collection === "WORDS_ES")) {
      patch.guards = { before: {}, missingBefore: [] };
      const guardPaths = collection === "userprogresses" ? own(patch.set, "card") ? WORD_CARD_PROGRESS_IDENTITY_PATHS.slice(0, 4) : WORD_CARD_PROGRESS_IDENTITY_PATHS : ["word"];
      for (const path of guardPaths) {
        let previous: any = original, present = true;
        for (const segment of path.split(".")) { if (!previous || typeof previous !== "object" || !own(previous, segment)) { present = false; break; } previous = previous[segment]; }
        if (present) patch.guards.before[path] = previous; else patch.guards.missingBefore.push(path);
      }
    }
  };
  const addInsert = (collection: "WORDS_DE" | "WORDS_ES" | "WORDS_ES_DE", document: Document) => {
    const key = `${collection}:${oid(document._id)}`, existing = inserts.get(key);
    if (maps[collection].has(oid(document._id))) fail("A deterministic insert ID conflicts with a snapshot record");
    if (existing && !sameWordCardBson(existing, document)) fail("Conflicting deterministic insert contents");
    if (!existing) { inserts.set(key, document); manifest.inserts.push({ collection, document }); }
    return document._id as ObjectId;
  };
  const sources: Source[] = options.review.entries.map(entry => ({ entry, original: maps.WORDS_DE.get(entry.id)!, auditedAt: checked.auditedAt }));
  if (options.additions) {
    const additional = options.additions;
    const additions = checkReview(additional.snapshot, additional.snapshotSHA256, additional.review, false);
    if (Number(additional.map.version) !== 1 || additional.map.intentVersion !== 2 || additional.map.stage !== "offline_addition_candidates" || additional.map.sourceHash !== options.snapshotSHA256 || additional.map.reviewHash !== options.reviewSHA256 || additional.map.reviewPromptHash !== options.review.promptHash || !Array.isArray(additional.map.candidates) || (additional.map.partial && !options.allowPartial)) fail("Addition mapping does not match the exact original review, requested intentions or complete source scope");
    if (additional.map.finalized) {
      const proof = options.candidateDecisions, finalization = additional.map.finalization;
      if (!decisionProof || !proof || !/^[a-f\d]{64}$/u.test(proof.decisionsSHA256 || "") || !/^[a-f\d]{64}$/u.test(proof.inputsSHA256 || "") || additional.map.candidateSnapshotSHA256 !== additional.snapshotSHA256 || finalization?.version !== 1 || finalization.ambiguousSHA256 !== proof.ambiguitiesSHA256 || finalization.decisionsSHA256 !== proof.decisionsSHA256 || finalization.decisionInputsSHA256 !== proof.inputsSHA256 || finalization.reviewHash !== options.reviewSHA256 || finalization.decisionSourceHash !== proof.decisions.sourceHash || finalization.decisionScopeHash !== proof.decisions.scopeHash || finalization.decisionPromptHash !== proof.decisions.promptHash || finalization.helperVersion !== CANDIDATE_HELPER_VERSION || finalization.initialScopeOnly !== true) fail("Finalized addition mapping must preserve its exact candidate snapshot and copied decision/input checksums");
      if (!options.finalCandidateProof) fail("Finalized additions require a complete source-bound final canonical coverage proof");
    }
    for (const candidate of additional.map.candidates) {
      validateCandidateSource(candidate, options.review);
      const beforeDedup = decisionProof?.candidates.get(candidate.candidateId);
      if (beforeDedup && !sameWordCardBson({ german: candidate.german, spanish: candidate.spanish, senseKey: candidate.senseKey, requestedSense: candidate.requestedSense, relatedFrom: candidate.relatedFrom }, { german: beforeDedup.german, spanish: beforeDedup.spanish, senseKey: beforeDedup.senseKey, requestedSense: beforeDedup.requestedSense, relatedFrom: beforeDedup.relatedFrom })) fail("Reviewed addition intention differs from the exact semantic deduplication input");
    }
    const candidateMap = new Map(additional.map.candidates.map(candidate => [candidate.id, candidate]));
    if (candidateMap.size !== additional.map.candidates.length || candidateMap.size !== additional.review.entries.length) fail("Addition mapping must cover every independently reviewed candidate exactly once");
    for (const entry of additional.review.entries) {
      const candidate = candidateMap.get(entry.id);
      if (!candidate || oid(candidate.ids.german) !== entry.id || oid(candidate.ids.relation) !== candidate.candidateId || entry.translations.length !== 1 || entry.translations[0].relationId !== candidate.candidateId) fail("Addition candidate synthetic identity or relation mapping is invalid");
      const relation = additions.maps.WORDS_ES_DE.get(candidate.candidateId);
      if (!relation || oid(relation.main) !== oid(candidate.ids.spanish) || oid(relation.translated) !== entry.id) fail("Addition snapshot endpoints disagree with candidate mapping");
      sources.push({ entry, original: additions.maps.WORDS_DE.get(entry.id)!, addition: candidate, auditedAt: additions.auditedAt });
    }
    report.additionCoverage = { snapshotGerman: additions.inputs.length, independentlyReviewed: additional.review.entries.length, completeReviewCoverage: true, originalCandidateScopePartial: !!additional.map.partial, snapshotSHA256: additional.snapshotSHA256 };
  }
  const finalDecisions = new Map<string, FinalCandidateDecision>();
  if (options.requireFinalCandidateEvidence && (!options.finalCandidateProof?.decisions?.composition || !options.finalCandidateProof.evidence)) fail("Required final candidate artifact evidence is missing; an ordinary proof cannot downgrade this compilation");
  if (options.finalCandidateProof) {
    const proof = options.finalCandidateProof, additional = options.additions;
    if (!additional || !options.reviewSHA256 || proof.provenance.reviewSHA256 !== proof.additionReviewSHA256 || ![proof.additionReviewSHA256, proof.candidateMapSHA256, proof.provenanceSHA256].every(hash => /^[a-f\d]{64}$/u.test(hash))) fail("Final candidate decisions require exact addition reviews, finalized mapping and authorship");
    const inputs = buildFinalCandidateInputs(options.review, additional.review, additional.map, proof.provenance, checked.inputs.length);
    const bindings = { catalogReviewSHA256: options.reviewSHA256, additionReviewSHA256: proof.additionReviewSHA256, candidateMapSHA256: proof.candidateMapSHA256, provenanceSHA256: proof.provenanceSHA256 };
    for (const decision of validateFinalCandidateProof(proof.decisions, inputs, bindings, proof.evidence)) finalDecisions.set(decision.candidateId, decision);
  }
  const eligible = new Set<string>();
  for (const source of sources) {
    const entry = source.entry;
    // Issues encode an active blocker as its own marker, optionally after an issue key.
    // Resolution prose may quote an old marker; mentioning it does not reactivate it.
    const activeBlocker = entry.issues.some(issue => /^(?:[a-z_]+:\s*)?cannot_auto_apply\b/u.test(issue.trim()));
    const reason = entry.confidence !== "high" || entry.translations.some(translation => translation.variant?.confidence !== "high") || (entry.studyEligible && (!reviewedWordCardCategoryReady(entry) || entry.translations.some(translation => !reviewedWordCardCategoryReady(translation.variant!, translation.spanish)))) ? "needs_review" : !entry.studyEligible ? "excluded_by_selection" : activeBlocker ? "unresolved_incompatible_senses" : "";
    if (reason) queue.push({ kind: reason, entryId: entry.id, reason: entry.reviewReason || reason, issues: entry.issues, addition: !!source.addition });
    else eligible.add(entry.id);
  }
  for (const source of sources.filter(source => source.addition)) {
    const decision = finalDecisions.get(source.addition!.candidateId);
    if (decision && (decision.intention !== "preserved" || decision.decision === "needs_review")) {
      eligible.delete(source.entry.id);
      queue.push({ kind: "candidate_final_review_held", entryId: source.entry.id, candidateId: decision.candidateId, reason: decision.reason });
    }
  }
  // Defer the source's related catalog revisions together if old answer scope is uncertain.
  for (const progress of options.snapshot.collections.userprogresses) {
    if (progress.itemType !== "WORD" || !progress.card || !Array.isArray(progress.card.acceptedAnswers) || progress.card.acceptedAnswers.length < 2) continue;
    const relationId = oid(progress.relationId ?? progress.itemId), relation = maps.WORDS_ES_DE.get(relationId);
    if (!relation || !eligible.has(oid(relation.translated))) continue;
    const result = answerDecisions.get(answerReviewGroupId(relationId, progress.card.direction, progress.card.acceptedAnswers));
    if (!result || result.confidence !== "high") {
      const entryId = oid(relation.translated); eligible.delete(entryId);
      queue.push({ kind: "answer_review_required", entryId, relationId, reason: result?.reviewReason || "Existing multiple-answer choices require a complete high-confidence same-sense review before revising this source and its cards" });
    }
  }
  const additionsById = new Map(sources.filter(source => source.addition).map(source => [source.addition!.candidateId, source]));
  const decisionAt = (candidateId: string) => finalDecisions.get(candidateId) ?? decisionProof?.decisions.get(candidateId) ?? (additionsById.has(candidateId) ? { candidateId, decision: "missing", coveredByIDs: [], coveredByCandidateIds: [] } : undefined);
  const correctionApproved = (candidateId: string) => finalDecisions.get(candidateId)?.intention === "preserved" && finalDecisions.get(candidateId)?.decision !== "needs_review";
  const terminalDecision = (candidateId: string) => {
    let current = decisionAt(candidateId);
    const seen = new Set<string>();
    while (current?.coveredByCandidateIds.length) {
      if (seen.has(current.candidateId)) fail("Candidate coverage contains a cycle");
      seen.add(current.candidateId); current = decisionAt(current.coveredByCandidateIds[0]);
    }
    return current;
  };
  const intentionsByTerminal = new Map<string, Candidate[]>();
  for (const origin of decisionProof?.candidates.values() ?? []) {
    const terminalId = terminalDecision(origin.candidateId)?.candidateId;
    if (terminalId) intentionsByTerminal.set(terminalId, [...(intentionsByTerminal.get(terminalId) ?? []), origin]);
  }
  const coveredExistingIds = (candidateId: string) => {
    const decision = terminalDecision(candidateId);
    const generated = sources.find(source => source.addition?.candidateId === candidateId);
    const origin = decisionProof?.candidates.get(candidateId);
    return decision?.decision === "covered" ? decision.coveredByIDs.filter(relationId => {
      const relation = maps.WORDS_ES_DE.get(relationId);
      if (!relation || !eligible.has(oid(relation.translated))) return false;
      const target = sources.find(source => !source.addition && source.entry.id === oid(relation.translated))!.entry.translations.find(translation => translation.relationId === relationId)!.variant!;
      return correctionApproved(decision.candidateId) || (!origin || permitsRequestedSenseCoverage(origin, target, true)) && (!generated || generated.entry.translations.every(translation => permitsRequestedSenseCoverage({ german: translation.variant!.german, requestedSense: { forms: translation.variant!.forms } }, target, true)));
    }) : [];
  };
  const compatibleAddition = (source: Source) => !!source.addition && eligible.has(source.entry.id) && (correctionApproved(source.addition.candidateId) || source.entry.translations.every(translation => permitsRequestedSenseCoverage(source.addition!, translation.variant!, true) && (intentionsByTerminal.get(source.addition!.candidateId) ?? []).every(origin => permitsRequestedSenseCoverage(origin, translation.variant!, true))));
  for (const source of sources.filter(source => source.addition && eligible.has(source.entry.id))) {
    const candidate = source.addition!, decision = finalDecisions.get(candidate.candidateId) ?? decisionProof?.decisions.get(candidate.candidateId);
    const existingFront = sources.some(other => !other.addition && other.entry.translations.some(translation => translation.relationId && front(translation.variant!.german).toLowerCase() === front(candidate.german).toLowerCase()));
    const peerFront = sources.some(other => other !== source && other.addition && front(other.addition.german).toLowerCase() === front(candidate.german).toLowerCase());
    const reason = !compatibleAddition(source) ? "candidate_review_changed_intention" : decision?.coveredByCandidateIds.length && !correctionApproved(candidate.candidateId) ? "candidate_alias_requires_finalized_representative_map" : decision?.decision === "needs_review" || (!decision && (existingFront || peerFront)) ? "candidate_dedup_review_required" : "";
    if (reason) { eligible.delete(source.entry.id); queue.push({ kind: reason, entryId: source.entry.id, candidateId: candidate.candidateId, senseKey: candidate.senseKey, reason: "Requested candidate meaning must be preserved and semantic duplicate decisions must be resolved before insertion" }); }
  }
  const provenCoverage = (entryId: string, proposal: { german: string; spanish: string; reason: string }) => {
    const origins = [...(decisionProof?.candidates.values() ?? [])].filter(candidate => matchesProposal(candidate, entryId, proposal));
    if (origins.length > 1) fail("One original requested intention maps to conflicting candidate identities");
    const origin = origins[0];
    if (origin) {
      const decision = terminalDecision(origin.candidateId);
      if (decision?.decision === "covered") return coveredExistingIds(origin.candidateId).length > 0;
      if (decision?.decision !== "missing") return false;
      const representative = sources.find(source => source.addition?.candidateId === decision.candidateId);
      return !!representative && compatibleAddition(representative);
    }
    const additions = sources.filter(source => source.addition && matchesProposal(source.addition, entryId, proposal));
    if (additions.length > 1) fail("One original requested intention maps to conflicting reviewed additions");
    if (!additions[0]) return false;
    const decision = terminalDecision(additions[0].addition!.candidateId);
    if (decision?.decision === "covered") return coveredExistingIds(additions[0].addition!.candidateId).length > 0;
    const representative = decision?.decision === "missing" && additionsById.get(decision.candidateId);
    return !!representative && compatibleAddition(representative);
  };
  // Remove blocked sources until companion availability is stable.
  let removed = true;
  while (removed) {
    removed = false;
    for (const source of sources.filter(source => source.addition && eligible.has(source.entry.id))) {
      const decision = terminalDecision(source.addition!.candidateId);
      if (decision?.decision === "covered" && !coveredExistingIds(source.addition!.candidateId).length) { eligible.delete(source.entry.id); removed = true; queue.push({ kind: "candidate_existing_coverage_deferred", entryId: source.entry.id, candidateId: source.addition!.candidateId, reason: "The semantic existing-relation proof is unavailable in the final eligible revision scope" }); }
      else if (decision?.decision === "missing" && decision.candidateId !== source.addition!.candidateId && !compatibleAddition(additionsById.get(decision.candidateId)!)) { eligible.delete(source.entry.id); removed = true; queue.push({ kind: "candidate_final_alias_deferred", entryId: source.entry.id, candidateId: source.addition!.candidateId, reason: "The final canonical representative is not included in the eligible migration" }); }
    }
    for (const source of sources.filter(source => eligible.has(source.entry.id))) {
      if (!source.entry.issues.some(issue => issue.includes("split_requires_companion_card"))) continue;
      const required = source.entry.relatedCandidates.filter(candidate => candidate.reason.startsWith("split_existing_sense"));
      const missing = required.filter(candidate => !provenCoverage(source.entry.id, candidate));
      if (!required.length || missing.length) { eligible.delete(source.entry.id); removed = true; queue.push({ kind: "missing_split_companion", entryId: source.entry.id, reason: "Primary relation must retain its original scope until every required sense companion is fully reviewed and included", missing }); }
    }
  }
  const pairPlans: PairPlan[] = [], studyByRelation = new Map<string, Document>();
  report.genericNoteCleanup = { germanRecordsExamined: maps.WORDS_DE.size, spanishRecordsExamined: maps.WORDS_ES.size,
    germanSourceNotesChangedByCleanup: [...maps.WORDS_DE.values()].filter(source => typeof source.notes === "string" && cleanGenericGermanSourceNotes(source.notes) !== source.notes).length,
    spanishSourceNotesChangedByCleanup: [...maps.WORDS_ES.values()].filter(source => typeof source.notes === "string" && cleanSpanishWordNotes(source.notes) !== source.notes).length,
  };
  // Apply only generic source cleanup first; included canonical notes take precedence below.
  for (const source of maps.WORDS_DE.values()) if (typeof source.notes === "string") patchDocument("WORDS_DE", source, { notes: cleanGenericGermanSourceNotes(source.notes) });
  for (const progress of options.snapshot.collections.userprogresses) {
    if (progress.itemType === "WORD" && progress.card && Array.isArray(progress.card.examples)) patchDocument("userprogresses", progress, { "card.examples": cleanImportedCardExampleNumbering(progress.card.examples) });
  }
  for (const source of sources) {
    const entry = source.entry;
    if (!eligible.has(entry.id)) { report.entries.push({ id: entry.id, status: "deferred", addition: !!source.addition }); continue; }
    const translations = [...entry.translations].sort((a, b) => a.relationId.localeCompare(b.relationId));
    const primary = translations.map(translation => translation.variant!).find(variant => sameWordCardBson(lexical(variant), lexical(entry))) || translations[0]?.variant || topVariant(entry);
    const baseLexical = { forms: primary.forms, notes: primary.notes, examples: primary.examples, gramaticalCategories: [primary.category] };
    if (source.addition) {
      const translation = translations[0], variant = translation.variant!, candidate = source.addition;
      const existingCoverage = coveredExistingIds(candidate.candidateId);
      if (existingCoverage.length) { report.additions.push({ id: entry.id, candidateId: candidate.candidateId, senseKey: candidate.senseKey, status: "covered_by_validated_semantic_existing_relation", relationIds: existingCoverage }); continue; }
      const terminal = terminalDecision(candidate.candidateId);
      if (terminal?.decision === "missing" && terminal.candidateId !== candidate.candidateId) { report.additions.push({ id: entry.id, candidateId: candidate.candidateId, senseKey: candidate.senseKey, status: "covered_by_final_canonical_candidate", representativeCandidateId: terminal.candidateId }); continue; }
      let germanId: ObjectId | undefined;
      const reuseId = candidate.originalDEReuseId, reuse = reuseId && maps.WORDS_DE.get(oid(reuseId));
      const reviewedReuse = reuseId && sources.find(other => !other.addition && other.entry.id === oid(reuseId) && eligible.has(other.entry.id));
      const reuseVariant = reviewedReuse?.entry.translations.find(other => front(other.variant!.german) === front(variant.german) && front(other.spanish) === front(translation.spanish))?.variant;
      if (reuse && reviewedReuse && ![...maps.WORDS_ES_DE.values()].some(relation => oid(relation.translated) === oid(reuse._id)) && stripArticle(reuse.word) === stripArticle(variant.german) && reuseVariant && sameWordCardBson({ ...lexical(reuseVariant), examples: [] }, { ...lexical(variant), examples: [] })) {
        germanId = reuse._id; patchDocument("WORDS_DE", reuse, { forms: variant.forms, notes: variant.notes, examples: variant.examples, gramaticalCategories: [variant.category] });
      } else if (reuseId) queue.push({ kind: "invalid_reuse_hint", entryId: entry.id, reason: "Reuse requires a reviewed identical sense on an unlinked original lookup spelling; a fresh canonical record is used" });
      const contexts = [variant.notes === "Redewendung" ? LearningContext.IDIOMS : variant.category === "PREPOSITION" ? LearningContext.PREPOSITIONS : LearningContext.GENERAL_VOCABULARY];
      if (!germanId) germanId = addInsert("WORDS_DE", { _id: new ObjectId(candidate.ids.german), word: variant.german, ...baseLexical, contexts, relatedWords: emptyRelated(), createdAt: source.auditedAt });
      const spanishId = addInsert("WORDS_ES", { _id: new ObjectId(candidate.ids.spanish), word: candidate.naturalSpanish || translation.spanish, notes: "", examples: translation.examples, gramaticalCategories: [variant.category], forms: {}, contexts: [...contexts], relatedWords: emptyRelated(), createdAt: source.auditedAt });
      const study = { version: 1, german: variant.german, spanish: translation.spanish, notes: variant.notes, forms: variant.forms, category: variant.category, germanExamples: variant.examples, spanishExamples: translation.examples, examples: variant.examples.map((example, index) => `${example} (${translation.examples[index]})`), auditedAt: source.auditedAt };
      addInsert("WORDS_ES_DE", { _id: new ObjectId(candidate.ids.relation), main: spanishId, translated: germanId, study, createdAt: source.auditedAt });
      report.additions.push({ id: entry.id, candidateId: candidate.candidateId, senseKey: candidate.senseKey, status: "included", germanId: oid(germanId), reusedOriginalGerman: !!reuse && germanId.equals(reuse._id), spanishId: oid(spanishId), relationId: candidate.ids.relation });
      report.entries.push({ id: entry.id, status: "addition_included" });
      continue;
    }
    const retainsLookup = primaryRetainsNounLookup(source.original.word, primary);
    if (retainsLookup) patchDocument("WORDS_DE", source.original, baseLexical);
    else queue.push({ kind: "corrected_noun_lookup_preserved", entryId: entry.id, reason: "The reviewed noun has a different lexical head; preserve original phrase-lookup grammar and translation links while the pair study content holds canonical grammar" });
    for (const translation of translations) {
      if (!translation.relationId) continue;
      const relation = maps.WORDS_ES_DE.get(translation.relationId)!;
      const variant = translation.variant!;
      let germanId = source.original._id as ObjectId;
      if (!sameWordCardBson(lexical(variant), lexical(primary))) {
        germanId = deterministicWordCardId(`sense-clone:DE:${entry.id}:${signature(lexical(variant))}`);
        addInsert("WORDS_DE", { _id: germanId, word: variantLookupWord(source.original.word, variant), forms: variant.forms, notes: variant.notes, examples: variant.examples, gramaticalCategories: [variant.category], ...cloneMetadata(source.original, source.auditedAt), createdAt: source.auditedAt });
        report.clones.push({ collection: "WORDS_DE", id: oid(germanId), parentId: entry.id, relationId: translation.relationId, reason: "relation-specific coherent German variant", classification: "parent-estimate" });
      }
      pairPlans.push({ relation, german: germanId, spanishSource: maps.WORDS_ES.get(oid(relation.main))!, variant, spanish: translation.spanish, spanishExamples: translation.examples, auditedAt: source.auditedAt, entryId: entry.id });
    }
    report.entries.push({ id: entry.id, status: translations.some(t => t.relationId) ? "reviewed_content_included" : "reviewed_unlinked_metadata_only", primaryGerman: primary.german, primaryFromTopLevel: sameWordCardBson(lexical(primary), lexical(entry)) });
    if (!translations.some(t => t.relationId)) queue.push({ kind: "unlinked_metadata_only", entryId: entry.id, reason: "Original surface lookup spelling is preserved; new study pairs require deduplicated, fully reviewed additions" });
  }
  const selectedRelations = new Set(pairPlans.map(plan => oid(plan.relation._id)));
  // Generic source notes are independent of whether a Spanish record has a reviewed pair.
  for (const source of maps.WORDS_ES.values()) if (typeof source.notes === "string") patchDocument("WORDS_ES", source, { notes: cleanSpanishWordNotes(source.notes) });
  const spanishGroups = new Map<string, PairPlan[]>();
  for (const plan of pairPlans) { const id = oid(plan.spanishSource._id); spanishGroups.set(id, [...(spanishGroups.get(id) || []), plan]); }
  for (const [spanishId, plans] of spanishGroups) {
    const source = maps.WORDS_ES.get(spanishId)!;
    const reserved = [...maps.WORDS_ES_DE.values()].some(relation => oid(relation.main) === spanishId && !selectedRelations.has(oid(relation._id)));
    const groups = new Map<string, PairPlan[]>();
    for (const plan of plans.sort((a, b) => oid(a.relation._id).localeCompare(oid(b.relation._id)))) { const key = signature({ german: plan.variant.examples, spanish: plan.spanishExamples }); groups.set(key, [...(groups.get(key) || []), plan]); }
    let originalUsed = false;
    for (const [groupKey, group] of groups) {
      const first = group[0];
      const useOriginal = !originalUsed && (!reserved || sameWordCardBson(source.examples ?? [], first.spanishExamples));
      let main = source._id as ObjectId;
      if (useOriginal) { originalUsed = true; patchDocument("WORDS_ES", source, { examples: first.spanishExamples, notes: cleanSpanishWordNotes(source.notes) }); }
      else {
        main = deterministicWordCardId(`paired-examples-clone:ES:${spanishId}:${groupKey}`);
        const forms = Object.fromEntries(WORD_CARD_FORM_KEYS.filter(key => typeof source.forms?.[key] === "string").map(key => [key, cleanSpanishWordNotes(source.forms[key])]));
        addInsert("WORDS_ES", { _id: main, word: source.word, forms, notes: cleanSpanishWordNotes(source.notes), examples: first.spanishExamples, gramaticalCategories: Array.isArray(source.gramaticalCategories) && source.gramaticalCategories.length ? source.gramaticalCategories : [first.variant.category], ...cloneMetadata(source, first.auditedAt), createdAt: first.auditedAt });
        report.clones.push({ collection: "WORDS_ES", id: oid(main), parentId: spanishId, relationIds: group.map(plan => oid(plan.relation._id)), reason: "distinct reviewed bilingual example pairing", classification: "parent-estimate" });
      }
      for (const plan of group) {
        const study = { version: 1, german: plan.variant.german, spanish: plan.spanish, notes: plan.variant.notes, forms: plan.variant.forms, category: plan.variant.category, germanExamples: plan.variant.examples, spanishExamples: plan.spanishExamples, examples: plan.variant.examples.map((example, index) => `${example} (${plan.spanishExamples[index]})`), auditedAt: plan.auditedAt };
        patchDocument("WORDS_ES_DE", plan.relation, { main, translated: plan.german, study }, ["main", "translated"]);
        studyByRelation.set(oid(plan.relation._id), study);
      }
    }
  }
  for (const progress of options.snapshot.collections.userprogresses) {
    if (progress.itemType !== "WORD") continue;
    const relationId = oid(progress.relationId ?? progress.itemId), relation = maps.WORDS_ES_DE.get(relationId), study = studyByRelation.get(relationId);
    if (!relation) { queue.push({ kind: "dangling_progress_relation", progressId: oid(progress._id), relationId, reason: "Catalog relation is missing; no card content is invented" }); continue; }
    if (!study) continue;
    if (!progress.card && own(progress, "card")) { queue.push({ kind: "malformed_legacy_card", progressId: oid(progress._id), relationId, reason: "A present empty/null card requires explicit repair; missing-card creation is refused" }); continue; }
    if (progress.card && !["ES_DE", "DE_ES"].includes(progress.card.direction)) { queue.push({ kind: "unsupported_card_direction", progressId: oid(progress._id), relationId, reason: "Card construction is outside this directional word-card correction" }); continue; }
    if (!progress.card && isNew(progress)) {
      if (!progress.supersededByAnki && !progress.suspended) {
        report.newLegacyPairingIds.push(oid(progress._id));
        queue.push({ kind: "new_legacy_pairing_required", progressId: oid(progress._id), relationId, reason: "Both native study directions must be created together by the dedicated transaction tool" });
      }
      // Inactive parents stay untouched; imported cards already represent superseded words.
      continue;
    }
    const direction = progress.card?.direction || "ES_DE", answer = direction === "DE_ES" ? study.spanish : study.german, prompt = direction === "DE_ES" ? study.german : study.spanish;
    const retained = progress.card?.acceptedAnswers?.length > 1 ? answerDecisions.get(answerReviewGroupId(relationId, direction, progress.card.acceptedAnswers))?.retainedAnswers ?? [] : [];
    const content = { prompt, answer, acceptedAnswers: [...new Set([plainCanonicalAnswer(answer), ...retained])], notes: study.notes, examples: study.examples };
    if (progress.card) {
      const next = Object.fromEntries(Object.entries(content).map(([key, value]) => [`card.${key}`, value]));
      if (Object.entries(content).some(([key, value]) => !own(progress.card, key) || !sameWordCardBson(progress.card[key], value))) patchDocument("userprogresses", progress, next, Object.keys(next));
    }
    else {
      if (!(progress.userId instanceof ObjectId) || !(progress.itemId instanceof ObjectId)) fail("Legacy card source identity is malformed");
      const card = { source: "APP", sourceCardId: BigInt(`0x${wordCardSHA256(progress.itemId.toHexString()).slice(0, 15)}`).toString(), sourceNoteGuid: `app-word:${progress.userId}:${relationId}`, direction: "ES_DE", ...content, deck: "App", tags: [] };
      patchDocument("userprogresses", progress, { card });
    }
  }
  manifest.patches = [...patches.values()];
  validateWordCardManifest(manifest);
  for (const source of sources.filter(source => !source.addition && eligible.has(source.entry.id))) for (const candidate of source.entry.relatedCandidates) {
    if (!provenCoverage(source.entry.id, candidate)) queue.push({ kind: "related_candidate_pending", entryId: source.entry.id, german: candidate.german, spanish: candidate.spanish, reason: candidate.reason });
  }
  report.classifications = manifest.inserts.filter(insert => insert.collection !== "WORDS_ES_DE").map(insert => ({ collection: insert.collection, id: oid(insert.document._id), status: insert.document.cefrLevel ? "inherited_parent_estimate" : "offline_classification_required", level: insert.document.cefrLevel || null }));
  report.counts = { patches: manifest.patches.length, inserts: manifest.inserts.length, eligibleReviewedEntries: eligible.size, deferredEntries: sources.length - eligible.size, queueItems: queue.length, newLegacyPairsRequired: report.newLegacyPairingIds.length };
  report.proofs = { candidateDecisionScope: decisionProof?.inputs.size ?? 0, finalCandidateDecisionScope: finalDecisions.size, answerReviewGroups: answerDecisions.size, reviewSHA256: options.reviewSHA256 || null };
  report.completeApplicationScope = !checked.missing.length && !report.classifications.some(item => item.status === "offline_classification_required") && !queue.some(item => item.kind.startsWith("candidate_") || ["needs_review", "answer_review_required", "missing_split_companion", "unresolved_incompatible_senses", "dangling_progress_relation", "unsupported_card_direction", "malformed_legacy_card", "new_legacy_pairing_required", "related_candidate_pending"].includes(item.kind));
  return { manifest, report, reviewQueue: { version: 1, snapshotSHA256: options.snapshotSHA256, items: queue } };
}

async function writePrivate(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path); await chmod(path, 0o600);
}
async function main() {
  try {
    const values: Record<string, string> = {}; let allowPartial = false, requireFinalCandidateEvidence = false;
    const args = process.argv.slice(2), allowed = ["--snapshot", "--review", "--output", "--additions-snapshot", "--additions-review", "--additions-map", "--candidate-decisions", "--candidate-ambiguities", "--final-candidate-decisions", "--candidate-provenance", "--answer-review"];
    for (let i = 0; i < args.length; i++) { const key = args[i]; if (key === "--allow-partial" && !allowPartial) allowPartial = true; else if (key === "--require-final-candidate-evidence" && !requireFinalCandidateEvidence) requireFinalCandidateEvidence = true; else if (allowed.includes(key) && !values[key] && args[i + 1] && !args[i + 1].startsWith("--")) values[key] = args[++i]; else fail("Invalid offline manifest builder arguments"); }
    if (!["--snapshot", "--review", "--output"].every(key => values[key]) || ["--additions-snapshot", "--additions-review", "--additions-map"].filter(key => values[key]).length % 3 || (values["--candidate-ambiguities"] && !values["--candidate-decisions"]) || (values["--candidate-decisions"] && !values["--candidate-ambiguities"] && !values["--additions-map"])) fail("Use --snapshot PATH --review PATH --output PRIVATE.ejson [--allow-partial] [--additions-snapshot PATH --additions-review PATH --additions-map PATH] [--candidate-decisions PATH --candidate-ambiguities PATH] [--answer-review PATH]");
    const [snapshotText, reviewText] = await Promise.all([readFile(resolve(values["--snapshot"]), "utf8"), readFile(resolve(values["--review"]), "utf8")]);
    const options: BuildWordCardAuditOptions = { snapshot: BSON.EJSON.parse(snapshotText, { relaxed: false }), snapshotSHA256: wordCardSHA256(snapshotText), review: JSON.parse(reviewText), reviewSHA256: wordCardSHA256(reviewText), allowPartial, requireFinalCandidateEvidence };
    if (!!values["--final-candidate-decisions"] !== !!values["--candidate-provenance"] || values["--final-candidate-decisions"] && !values["--additions-snapshot"]) fail("Final candidate decisions require finalized additions and --candidate-provenance");
    if (values["--additions-snapshot"]) { const text = await readFile(resolve(values["--additions-snapshot"]), "utf8"); options.additions = { snapshot: BSON.EJSON.parse(text, { relaxed: false }), snapshotSHA256: wordCardSHA256(text), review: JSON.parse(await readFile(resolve(values["--additions-review"]), "utf8")), map: JSON.parse(await readFile(resolve(values["--additions-map"]), "utf8")) }; }
    if (values["--candidate-decisions"]) {
      const ambiguityPath = resolve(values["--candidate-ambiguities"] || resolve(dirname(values["--additions-map"]), "ambiguous-candidates.json")), decisionsPath = resolve(values["--candidate-decisions"]);
      const [ambiguitiesText, decisionsText, inputsText] = await Promise.all([readFile(ambiguityPath, "utf8"), readFile(decisionsPath, "utf8"), readFile(resolve(dirname(decisionsPath), "inputs.json"), "utf8")]);
      options.candidateDecisions = { ambiguities: JSON.parse(ambiguitiesText), ambiguitiesSHA256: wordCardSHA256(ambiguitiesText), decisions: JSON.parse(decisionsText), decisionsSHA256: wordCardSHA256(decisionsText), inputs: JSON.parse(inputsText), inputsSHA256: wordCardSHA256(inputsText) };
      values["--candidate-ambiguities"] = ambiguityPath; values["--candidate-inputs"] = resolve(dirname(decisionsPath), "inputs.json");
    }
    if (values["--answer-review"]) options.answerReview = JSON.parse(await readFile(resolve(values["--answer-review"]), "utf8"));
    if (values["--final-candidate-decisions"]) {
      const [decisionsText, provenanceText, additionReviewText, mapText] = await Promise.all([readFile(resolve(values["--final-candidate-decisions"]), "utf8"), readFile(resolve(values["--candidate-provenance"]), "utf8"), readFile(resolve(values["--additions-review"]), "utf8"), readFile(resolve(values["--additions-map"]), "utf8")]);
      options.finalCandidateProof = { decisions: JSON.parse(decisionsText), provenance: JSON.parse(provenanceText), additionReviewSHA256: wordCardSHA256(additionReviewText), candidateMapSHA256: wordCardSHA256(mapText), provenanceSHA256: wordCardSHA256(provenanceText) };
      options.finalCandidateProof.evidence = await loadFinalCandidateProofEvidence(options.finalCandidateProof.decisions, dirname(resolve(values["--snapshot"])));
    }
    const result = buildWordCardAudit(options), output = resolve(values["--output"]);
    if ([output, `${output}.report.json`, `${output}.review-queue.json`].some(path => Object.entries(values).some(([key, input]) => key !== "--output" && path === resolve(input)))) fail("Offline manifest output must not overwrite a frozen source or review file");
    await writePrivate(output, `${serializeWordCardEjson(result.manifest)}\n`);
    await writePrivate(`${output}.report.json`, `${JSON.stringify(result.report, null, 2)}\n`);
    await writePrivate(`${output}.review-queue.json`, `${JSON.stringify(result.reviewQueue, null, 2)}\n`);
    console.log(JSON.stringify({ status: "offline_manifest_prepared", coverage: result.report.coverage, counts: result.report.counts, completeApplicationScope: result.report.completeApplicationScope, sourceVerified: false }));
  } catch (error) { console.error(error instanceof WordCardMigrationError || error instanceof CandidateInputError || error instanceof AnswerReviewError ? error.message : "Offline word-card manifest preparation failed; inspect private input files"); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
