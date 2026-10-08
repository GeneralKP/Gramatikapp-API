import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSON, ObjectId, type Document } from "mongodb";
import { buildWordCardAudit, cleanGenericGermanSourceNotes, cleanSpanishWordNotes, cleanImportedCardExampleNumbering, type BuildWordCardAuditOptions } from "./buildWordCardAudit.js";
import { WORD_CARD_FORM_KEYS, WORD_CARD_PROMPT_VERSION, WORD_CARD_REVIEW_INSTRUCTIONS, WORD_CARD_REVIEW_SCHEMA, type WordCardDraft, type WordCardVariant } from "./lib/wordCardPrompt.js";
import { deterministicWordCardId, sameWordCardBson, serializeWordCardEjson, validateWordCardManifest, wordCardSHA256 } from "./lib/wordCardMigration.js";
import { additionId, buildWordCardCandidateSnapshot, prepareWordCardAdditions, type AdditionCandidate } from "./prepareWordCardAdditions.js";
import { buildCandidateReviewInputs, CANDIDATE_HELPER_MODEL, CANDIDATE_HELPER_VERSION, CANDIDATE_DECISION_INSTRUCTIONS, CANDIDATE_DECISION_SCHEMA, type CandidateDecision } from "./reviewWordCardCandidates.js";
import { ANSWER_REVIEW_MODEL, ANSWER_REVIEW_PROMPT_HASH, ANSWER_REVIEW_VERSION, buildAnswerReviewInputs } from "./reviewWordCardAnswers.js";
import { finalizeWordCardAdditions } from "./finalizeWordCardAdditions.js";
import { buildFinalCandidateInputs, FINAL_CANDIDATE_VERSION, FINAL_CANDIDATE_MODEL, FINAL_CANDIDATE_PROMPT_HASH } from "./reviewFinalWordCardCandidates.js";

const now = new Date("2026-10-08T10:00:00Z"), id = (key: string) => deterministicWordCardId(`builder-test:${key}`);
const forms = (values: Partial<Record<typeof WORD_CARD_FORM_KEYS[number], string>> = {}) => ({ ...Object.fromEntries(WORD_CARD_FORM_KEYS.map(key => [key, ""])), ...values }) as WordCardVariant["forms"];
const noun = (german: string, plural: string, examples: string[]): WordCardVariant => ({ german, category: "NOUN", forms: forms({ gender: german.startsWith("Der") ? "der" : german.startsWith("Die") ? "die" : "das", plural }), notes: plural, examples, confidence: "high", reviewReason: "" });
const movement: WordCardVariant = { german: "fahren", category: "VERB", forms: forms({ perfect: "ist gefahren", past: "ich fuhr", imperativ: "fahr!, fahrt!" }), notes: "ist gefahren\nich fuhr\nfahr!, fahrt!", examples: ["Ich fahre nach Berlin.", "Wir sind nach Hause gefahren."], confidence: "high", reviewReason: "" };
const steering: WordCardVariant = { ...movement, german: "Ein Auto fahren", forms: forms({ perfect: "hat gefahren", past: "ich fuhr", imperativ: "fahr!, fahrt!", gramaticalCase: "Akkusativ" }), notes: "hat gefahren\nich fuhr\nfahr!, fahrt!", examples: ["Ich fahre ein Auto.", "Sie hat den Wagen gefahren."] };
const house = noun("Das Haus", "Die Häuser", ["Das Haus ist groß.", "Ich wohne in einem Haus."]);
const building = noun("Das Gebäude", "Die Gebäude", ["Das Gebäude ist alt.", "Ich arbeite in diesem Gebäude."]);
const word = (key: string, text: string): Document => ({ _id: id(key), word: text, gramaticalCategories: ["UNKNOWN"], notes: "auto-generated seed", examples: [], contexts: ["general_vocabulary"], cefrLevel: "A2.1", cefrClassification: { level: "A2.1", model: "old-model", version: 1, classifiedAt: now }, createdAt: now });
const relation = (key: string, de: Document, es: Document): Document => ({ _id: id(key), main: es._id, translated: de._id, createdAt: now });
const draft = (de: Document, primary: WordCardVariant, translations: { relation: Document | null; spanish: string; examples: string[]; variant: WordCardVariant }[]): WordCardDraft => ({ id: de._id.toHexString(), ...primary, translations: translations.map(item => ({ relationId: item.relation?._id.toHexString() || "", spanish: item.spanish, examples: item.examples, variant: item.variant })), issues: [], confidence: "high", reviewReason: "", studyEligible: true, relatedCandidates: [] });
const reviewFor = (entries: WordCardDraft[], hash: string) => ({ version: 1, stage: "independent_review", promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: wordCardSHA256(WORD_CARD_PROMPT_VERSION + WORD_CARD_REVIEW_INSTRUCTIONS + JSON.stringify(WORD_CARD_REVIEW_SCHEMA)), sourceHash: hash, auditedAt: now.toISOString(), offset: 0, selected: entries.length, completed: entries.length, pending: 0, entries });
function optionsFor(snapshot: any, entries: WordCardDraft[]): BuildWordCardAuditOptions {
  const text = serializeWordCardEjson(snapshot);
  const decoded = BSON.EJSON.parse(text, { relaxed: false });
  const review = reviewFor(entries, wordCardSHA256(text));
  return { snapshot: decoded, snapshotSHA256: wordCardSHA256(text), review, reviewSHA256: wordCardSHA256(JSON.stringify(review)) };
}
const deDrive = word("drive", "fahren"), deHouse = word("house", "Haus"), deBuilding = word("building", "Gebäude"), deSurface = word("surface", "geht"), deUncertain: Document = { ...word("uncertain", "Kunde"), notes: "Dictionary metadata generated from imported seed.\nDie Kunden\nUseful unresolved sense note." };
const esMove = word("move-es", "ir"), esDrive = word("drive-es", "conducir"), esShared = word("shared-es", "casa"), esUncertain = word("uncertain-es", "noticia");
const esUnlinked: Document = { ...word("unlinked-es", "luz"), notes: "Dictionary form reviewed against source seed.\nSustantivo femenino.\nRegular conjugation: unchanged." };
const rMove = relation("move-relation", deDrive, esMove), rDrive = relation("drive-relation", deDrive, esDrive), rHouse = relation("house-relation", deHouse, esShared), rBuilding = relation("building-relation", deBuilding, esShared), rUncertain = relation("uncertain-relation", deUncertain, esUncertain);
const card = (direction: string) => ({ source: "ANKI", sourceCardId: "123", sourceNoteGuid: "archived-guid", direction, prompt: "old", answer: "old", acceptedAnswers: ["old"], notes: "old<br>", examples: [], deck: "original", tags: ["archived"], rawIdentity: { fixed: true } });
const progress = (key: string, rel: Document, direction?: string): Document => ({ _id: id(key), userId: id("owner"), itemId: direction ? id(`${key}-item`) : rel._id, ...(direction ? { relationId: rel._id, card: card(direction) } : {}), itemType: "WORD", scheduler: { version: 1, phase: "REVIEW", interval: 18, options: { newPerDay: 17 } }, scheduleVersion: 8, failureIndex: 7, totalReviews: 21, nextDueDate: now, updatedAt: now, createdAt: now });
const pProduction = progress("production", rMove, "ES_DE"), pRecognition = progress("recognition", rMove, "DE_ES"), pLegacy = progress("legacy", rDrive), pNew: Document = { ...progress("new", rHouse), scheduler: { version: 1, phase: "NEW" }, isNew: false }, pDangling = progress("dangling", { _id: id("missing-relation") });
const snapshot = { auditedAt: now, collections: { WORDS_DE: [deDrive, deHouse, deBuilding, deSurface, deUncertain], WORDS_ES: [esMove, esDrive, esShared, esUncertain, esUnlinked], WORDS_ES_DE: [rMove, rDrive, rHouse, rBuilding, rUncertain], userprogresses: [pProduction, pRecognition, pLegacy, pNew, pDangling] } };
const driveDraft = draft(deDrive, movement, [{ relation: rMove, spanish: "ir", examples: ["Voy a Berlín.", "Fuimos a casa."], variant: movement }, { relation: rDrive, spanish: "un auto conducir", examples: ["Conduzco un auto.", "Ella condujo el coche."], variant: steering }]);
const houseDraft = draft(deHouse, house, [{ relation: rHouse, spanish: "la casa", examples: ["La casa es grande.", "Vivo en una casa."], variant: house }]);
const buildingDraft = draft(deBuilding, building, [{ relation: rBuilding, spanish: "el edificio", examples: ["El edificio es antiguo.", "Trabajo en este edificio."], variant: building }]);
const surfaceDraft = draft(deSurface, { ...movement, german: "gehen", forms: forms({ perfect: "ist gegangen", past: "ich ging", imperativ: "geh!, geht!" }), notes: "ist gegangen\nich ging\ngeh!, geht!", examples: ["Ich gehe nach Hause.", "Wir sind zum Bahnhof gegangen."] }, [{ relation: null, spanish: "ir", examples: ["Voy a casa.", "Fuimos a la estación."], variant: { ...movement, german: "gehen", forms: forms({ perfect: "ist gegangen", past: "ich ging", imperativ: "geh!, geht!" }), notes: "ist gegangen\nich ging\ngeh!, geht!", examples: ["Ich gehe nach Hause.", "Wir sind zum Bahnhof gegangen."] } }]);
const uncertain = draft(deUncertain, noun("Die Kunde", "", ["Die Kunde ist unklar.", "Ich habe die Kunde gehört."]), [{ relation: rUncertain, spanish: "la noticia", examples: ["La noticia no está clara.", "He oído la noticia."], variant: { ...noun("Die Kunde", "", ["Die Kunde ist unklar.", "Ich habe die Kunde gehört."]), confidence: "needs_review", reviewReason: "Obsolete sense requires selection review" } }]);
uncertain.confidence = "needs_review"; uncertain.reviewReason = "Obsolete sense requires selection review";
const entries = [driveDraft, houseDraft, buildingDraft, surfaceDraft, uncertain], options = optionsFor(snapshot, entries);
const result = buildWordCardAudit(options);
validateWordCardManifest(result.manifest);
const findPatch = (collection: string, key: ObjectId) => result.manifest.patches.find(patch => patch.collection === collection && patch.id === key.toHexString());
assert.equal(findPatch("WORDS_DE", deDrive._id)?.set.notes, movement.notes);
assert.ok(!result.manifest.patches.some(patch => Object.keys(patch.set).some(key => ["word", "createdAt", "updatedAt", "cefrLevel", "cefrClassification", "scheduler", "failureIndex", "relationId"].includes(key))), "existing lookup, metadata and study state are protected");
assert.ok(findPatch("WORDS_DE", deHouse._id)?.missingBefore.includes("forms"), "absent whole form container must be reversible");
assert.equal(result.manifest.inserts.filter(insert => insert.collection === "WORDS_DE").length, 1, "secondary construction needs its own coherent German catalog record");
const clonedDE = result.manifest.inserts.find(insert => insert.collection === "WORDS_DE")!.document;
assert.equal(clonedDE.word, deDrive.word, "same-lemma construction clones remain available to exact fahren phrase lookup"); assert.equal(clonedDE.forms.perfect, "hat gefahren"); assert.equal(clonedDE.cefrClassification.model, "parent-estimate");
assert.equal((findPatch("WORDS_ES_DE", rDrive._id)?.set.study as Document).german, steering.german, "the full study construction belongs to reviewed pair content");
assert.equal(result.manifest.inserts.filter(insert => insert.collection === "WORDS_ES").length, 1, "shared Spanish word needs separate distinct bilingual examples");
const clonedES = result.manifest.inserts.find(insert => insert.collection === "WORDS_ES")!.document;
assert.equal(clonedES.word, "casa"); assert.equal(clonedES.notes, "");
for (const rel of [rMove, rDrive, rHouse, rBuilding]) {
  const patch = findPatch("WORDS_ES_DE", rel._id)!;
  assert.ok(patch.set.main instanceof ObjectId); assert.ok(patch.set.translated instanceof ObjectId);
  assert.ok(sameWordCardBson(patch.before.main, rel.main)); assert.ok(sameWordCardBson(patch.before.translated, rel.translated));
}
assert.equal(findPatch("userprogresses", pProduction._id)?.set["card.prompt"], "ir"); assert.equal(findPatch("userprogresses", pProduction._id)?.set["card.answer"], "fahren");
assert.equal(findPatch("userprogresses", pRecognition._id)?.set["card.prompt"], "fahren"); assert.equal(findPatch("userprogresses", pRecognition._id)?.set["card.answer"], "ir");
assert.deepEqual(findPatch("userprogresses", pProduction._id)?.set["card.acceptedAnswers"], ["fahren"]);
assert.equal(findPatch("userprogresses", pProduction._id)?.guards?.before["card.direction"], "ES_DE");
assert.ok(sameWordCardBson(findPatch("userprogresses", pProduction._id)?.guards?.before.relationId, rMove._id));
assert.deepEqual(findPatch("userprogresses", pLegacy._id)?.guards?.missingBefore, ["relationId"]);
assert.equal(findPatch("WORDS_ES", esUnlinked._id)?.set.notes, "Sustantivo femenino.");
assert.equal(findPatch("WORDS_ES", esUncertain._id)?.set.notes, "", "generic Spanish notes cleanup also covers deferred senses");
assert.equal(cleanSpanishWordNotes("seed data\nDictionary form reviewed for import.\nUso coloquial.\nNo plural"), "Uso coloquial.");
const native = findPatch("userprogresses", pLegacy._id)?.set.card as Document;
assert.equal(native.sourceCardId, BigInt(`0x${wordCardSHA256(pLegacy.itemId.toHexString()).slice(0, 15)}`).toString()); assert.equal(native.sourceNoteGuid, `app-word:${pLegacy.userId}:${rDrive._id}`); assert.equal(native.direction, "ES_DE");
assert.equal(findPatch("userprogresses", pNew._id), undefined); assert.ok(result.report.newLegacyPairingIds.includes(pNew._id.toHexString()));

// Imported directions supersede legacy parents; inactive NEW parents must stay untouched.
const inactiveNewParents: Document[] = [
  { ...progress("superseded-new", rHouse), scheduler: { version: 1, phase: "NEW" }, supersededByAnki: true },
  { ...progress("suspended-new", rHouse), scheduler: { version: 1, phase: "NEW" }, suspended: true },
  { ...progress("superseded-suspended-new", rHouse), scheduler: { version: 1, phase: "NEW" }, supersededByAnki: true, suspended: true },
];
const activeNewParent: Document = { ...progress("eligible-new", rHouse), scheduler: { version: 1, phase: "NEW" }, isNew: false };
const importedPair = [progress("imported-house-production", rHouse, "ES_DE"), progress("imported-house-recognition", rHouse, "DE_ES")];
const inactiveNewSnapshot = { auditedAt: now, collections: { WORDS_DE: [deHouse], WORDS_ES: [esShared], WORDS_ES_DE: [rHouse], userprogresses: [...inactiveNewParents, activeNewParent, ...importedPair] } };
const inactiveNewSnapshotBefore = serializeWordCardEjson(inactiveNewSnapshot);
const inactiveNewResult = buildWordCardAudit(optionsFor(inactiveNewSnapshot, [houseDraft]));
assert.deepEqual(inactiveNewResult.report.newLegacyPairingIds, [activeNewParent._id.toHexString()], "only an active NEW legacy parent requires native pairing");
for (const parent of inactiveNewParents) {
  assert.ok(!inactiveNewResult.reviewQueue.items.some(item => item.kind === "new_legacy_pairing_required" && item.progressId === parent._id.toHexString()), "superseded or suspended parents are not active pairing work");
  assert.ok(!inactiveNewResult.manifest.patches.some(patch => patch.collection === "userprogresses" && patch.id === parent._id.toHexString()), "inactive NEW parents must not receive a partial or full card");
}
assert.ok(inactiveNewResult.reviewQueue.items.some(item => item.kind === "new_legacy_pairing_required" && item.progressId === activeNewParent._id.toHexString()), "eligible NEW words still require both directions together");
assert.ok(!inactiveNewResult.manifest.patches.some(patch => patch.collection === "userprogresses" && patch.id === activeNewParent._id.toHexString()), "the main content audit must not bypass atomic NEW pairing");
for (const imported of importedPair) {
  const patch = inactiveNewResult.manifest.patches.find(patch => patch.collection === "userprogresses" && patch.id === imported._id.toHexString())!;
  assert.deepEqual(Object.keys(patch.set).sort(), ["card.acceptedAnswers", "card.answer", "card.examples", "card.notes", "card.prompt"], "existing imported directions still receive only reviewed lexical changes");
  assert.equal(patch.set["card.prompt"], imported.card.direction === "ES_DE" ? "la casa" : "Das Haus");
  assert.equal(patch.set["card.answer"], imported.card.direction === "ES_DE" ? "Das Haus" : "la casa");
}
validateWordCardManifest(inactiveNewResult.manifest);
assert.equal(serializeWordCardEjson(inactiveNewSnapshot), inactiveNewSnapshotBefore, "reporting does not mutate original parents or imported-card state");
assert.ok(result.reviewQueue.items.some(item => item.kind === "dangling_progress_relation" && item.progressId === pDangling._id.toHexString()));
assert.deepEqual(findPatch("WORDS_DE", deUncertain._id)?.set, { notes: "Die Kunden\nUseful unresolved sense note." }); assert.equal(findPatch("WORDS_ES_DE", rUncertain._id), undefined);
assert.equal(cleanGenericGermanSourceNotes("Autogenerated note.\nhat gelernt\nlernte\nlern!\nRegular conjugation."), "hat gelernt\nlernte\nlern!\nRegular conjugation.", "deferred German grammatical content must be preserved");
assert.ok(findPatch("WORDS_DE", deSurface._id)); assert.equal(result.manifest.inserts.filter(insert => insert.collection === "WORDS_ES_DE").length, 0, "unlinked inflected tokens must not acquire infinitive relations implicitly");
assert.ok(sameWordCardBson(result.manifest, buildWordCardAudit(options).manifest), "offline output must be deterministic for the same review");

// A resolution's prose can name an old blocker without retaining that blocker.
const resolutionIssues = [
  "resolved_incompatible_senses: replaced the earlier cannot_auto_apply issue with reviewed relation-specific variants",
  "obsolete_blocker_removed: se retira incompatible_senses: cannot_auto_apply porque las variantes conservan ambos sentidos",
  "Independent review resolves the earlier cannot_auto_apply conflict through exact relation-specific variants.",
];
const resolvedDrive = buildWordCardAudit(optionsFor(snapshot, [{ ...driveDraft, issues: resolutionIssues }, ...entries.slice(1)]));
assert.ok(resolvedDrive.manifest.patches.some(patch => patch.collection === "WORDS_ES_DE" && patch.id === rDrive._id.toHexString()), "resolved prose must not prevent independently reviewed relation variants");
for (const marker of ["incompatible_senses: cannot_auto_apply", "ambiguous_function: cannot_auto_apply — the intended sense is unresolved", "cannot_auto_apply: unresolved construction"]) {
  const blocked = buildWordCardAudit(optionsFor(snapshot, [{ ...driveDraft, issues: [...resolutionIssues, marker] }, ...entries.slice(1)]));
  assert.ok(blocked.reviewQueue.items.some(item => item.kind === "unresolved_incompatible_senses" && item.entryId === driveDraft.id), "an explicit active marker remains blocking even alongside resolution prose");
  assert.ok(!blocked.manifest.patches.some(patch => patch.collection === "WORDS_ES_DE" && patch.id === rDrive._id.toHexString()));
}
assert.deepEqual(cleanImportedCardExampleNumbering(["1) Die Kunde ist unklar. (La noticia no está clara.)", "2) Ich habe die Kunde gehört. (He oído la noticia.)"]), ["Die Kunde ist unklar. (La noticia no está clara.)", "Ich habe die Kunde gehört. (He oído la noticia.)"]);
for (const unchanged of [["1. Januar ist ein Feiertag."], ["2) Zweiter Satz.", "1) Erster Satz."], ["1) Erster Satz.", "Zweiter Satz."], ["1)Erster Satz."], [], null]) assert.deepEqual(cleanImportedCardExampleNumbering(unchanged), unchanged, "dates, reordered/mixed arrays and unproven numbering remain unchanged");
const heldNumberedProgress = progress("held-numbered", rUncertain, "ES_DE");
heldNumberedProgress.card.examples = ["1) Die Kunde ist unklar. (La noticia no está clara.)", "2) Ich habe die Kunde gehört. (He oído la noticia.)"];
const heldNumberedResult = buildWordCardAudit(optionsFor({ auditedAt: now, collections: { WORDS_DE: [deUncertain], WORDS_ES: [esUncertain], WORDS_ES_DE: [rUncertain], userprogresses: [heldNumberedProgress] } }, [uncertain]));
const heldNumberedPatch = heldNumberedResult.manifest.patches.find(patch => patch.collection === "userprogresses")!;
assert.deepEqual(Object.keys(heldNumberedPatch.set), ["card.examples"], "format cleanup does not resolve held meanings or alter any other card/progress field");
assert.deepEqual(heldNumberedPatch.before["card.examples"], heldNumberedProgress.card.examples, "the exact original numbering remains rollback data");
assert.ok(heldNumberedResult.reviewQueue.items.some(item => item.kind === "needs_review" && item.entryId === uncertain.id));

// Corrected music terminology must not turn feminine Bindung lookup metadata into masculine Haltebogen grammar.
const rawBinding: Document = { ...word("raw-binding", "Bindung"), forms: { gender: "die", plural: "Bindungen" }, notes: "Die Bindungen", examples: ["Diese Bindung verlängert den Ton."], gramaticalCategories: ["NOUN"] };
const tieSpanish = word("tie-spanish", "la ligadura"), tieRelation = relation("tie-relation", rawBinding, tieSpanish), tieProgress = progress("tie-progress", tieRelation, "ES_DE");
const tieVariant = noun("Der Haltebogen", "Die Haltebögen", ["Dieser Haltebogen verlängert den Ton.", "Der Haltebogen verbindet zwei Noten mit gleicher Tonhöhe."]);
const tieDraft = draft(rawBinding, tieVariant, [{ relation: tieRelation, spanish: "la ligadura de prolongación", examples: ["Esta ligadura de prolongación prolonga la nota.", "La ligadura de prolongación une dos notas de la misma altura."], variant: tieVariant }]);
const accessDE = word("access", "Zugriff"), accessES = word("access-es", "acceso"), accessRelation = relation("access-relation", accessDE, accessES);
const accessVariant = noun("Der direkte Zugriff auf", "Die Zugriffe", ["Ich habe direkten Zugriff auf die Daten.", "Der direkte Zugriff auf diese Datei ist gesperrt."]);
const accessDraft = draft(accessDE, accessVariant, [{ relation: accessRelation, spanish: "el acceso directo a", examples: ["Tengo acceso directo a los datos.", "El acceso directo a este archivo está bloqueado."], variant: accessVariant }]);
const pluralHouseDE = word("plural-house", "Häuser"), pluralHouseES = word("plural-house-es", "casa"), pluralHouseRelation = relation("plural-house-relation", pluralHouseDE, pluralHouseES);
const pluralHouseDraft = draft(pluralHouseDE, house, [{ relation: pluralHouseRelation, spanish: "la casa", examples: ["La casa es grande.", "Vivo en una casa."], variant: house }]);
const nounCorrectionOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [rawBinding, accessDE, pluralHouseDE], WORDS_ES: [tieSpanish, accessES, pluralHouseES], WORDS_ES_DE: [tieRelation, accessRelation, pluralHouseRelation], userprogresses: [tieProgress] } }, [tieDraft, accessDraft, pluralHouseDraft]);
const nounCorrection = buildWordCardAudit(nounCorrectionOptions);
assert.equal(nounCorrection.manifest.patches.find(patch => patch.collection === "WORDS_DE" && patch.id === rawBinding._id.toHexString()), undefined, "Bindung retains its own word, forms, examples and notes for phrase lookup");
const correctedTieRelation = nounCorrection.manifest.patches.find(patch => patch.collection === "WORDS_ES_DE" && patch.id === tieRelation._id.toHexString())!;
assert.ok(sameWordCardBson(correctedTieRelation.set.translated, rawBinding._id), "the primary relation stays available to exact Bindung phrase lookup");
assert.ok(sameWordCardBson(correctedTieRelation.before.translated, rawBinding._id));
const tieStudy = correctedTieRelation.set.study as Document;
assert.equal(tieStudy.german, "Der Haltebogen"); assert.equal(tieStudy.forms.gender, "der"); assert.equal(tieStudy.forms.plural, "Die Haltebögen"); assert.equal(tieStudy.category, "NOUN");
assert.deepEqual(tieStudy.germanExamples, tieVariant.examples, "corrected primary heads supply their own dictionary examples without rewriting raw lookup examples");
assert.deepEqual(tieStudy.spanishExamples, tieDraft.translations[0].examples);
const correctedTieProgress = nounCorrection.manifest.patches.find(patch => patch.collection === "userprogresses")!;
assert.equal(correctedTieProgress.set["card.answer"], "Der Haltebogen");
assert.ok(Object.keys(correctedTieProgress.set).every(path => path.startsWith("card.")), "canonical noun corrections preserve card identity, schedules and mistakes");
assert.equal(nounCorrection.manifest.inserts.filter(insert => insert.collection === "WORDS_DE").length, 0, "primary corrections, governed noun complements and explicitly reviewed same-lemma plurals preserve catalog translation links");
assert.ok(nounCorrection.manifest.patches.some(patch => patch.id === accessDE._id.toHexString() && sameWordCardBson(patch.set.forms, accessVariant.forms)));
assert.ok(nounCorrection.manifest.patches.some(patch => patch.id === pluralHouseDE._id.toHexString() && patch.set.notes === "Die Häuser"));
assert.ok(sameWordCardBson(nounCorrection.manifest, buildWordCardAudit(nounCorrectionOptions).manifest));
validateWordCardManifest(nounCorrection.manifest);
for (const original of options.snapshot.collections.userprogresses) {
  const patch = findPatch("userprogresses", original._id), after = BSON.EJSON.parse(serializeWordCardEjson(original), { relaxed: false });
  if (patch) for (const [path, value] of Object.entries(patch.set)) { const pieces = path.split("."); let at = after; for (const piece of pieces.slice(0, -1)) at = at[piece] ??= {}; at[pieces.at(-1)!] = value; }
  const oldRest = { ...original }, newRest = { ...after }; delete oldRest.card; delete newRest.card;
  assert.equal(serializeWordCardEjson(oldRest), serializeWordCardEjson(newRest), "all original progress fields outside card must stay byte-equal");
}
assert.throws(() => buildWordCardAudit({ ...options, review: { ...options.review, sourceHash: "b".repeat(64) } }), /provenance/);
assert.throws(() => buildWordCardAudit({ ...options, review: { ...options.review, stage: "draft" } }), /provenance/);
assert.throws(() => buildWordCardAudit({ ...options, review: { ...options.review, promptHash: "d".repeat(64) } }), /provenance/);
assert.throws(() => buildWordCardAudit({ ...options, review: { ...options.review, entries: entries.slice(0, 1) } }), /Full snapshot review/);
const partial = buildWordCardAudit({ ...options, allowPartial: true, review: { ...options.review, entries: entries.slice(0, 1) } }); assert.equal(partial.report.coverage.missingReview, 4); assert.equal(partial.report.completeApplicationScope, false);

// One ambiguous relation can narrow only once its second current homograph sense exists.
const jaw = word("jaw", "Kiefer"), combined = word("combined-es", "mandíbula / pino"), combinedRelation = relation("combined-relation", jaw, combined);
const jawVariant = noun("Der Kiefer", "Die Kiefer", ["Mein Kiefer tut weh.", "Der Zahnarzt untersucht meinen Kiefer."]);
const treeVariant = noun("Die Kiefer", "Die Kiefern", ["Die Kiefer wächst im Wald.", "Wir pflanzen eine Kiefer."]);
const conditional = draft(jaw, jawVariant, [{ relation: combinedRelation, spanish: "la mandíbula", examples: ["Me duele la mandíbula.", "El dentista examina mi mandíbula."], variant: jawVariant }]);
conditional.issues = ["split_requires_companion_card", ...resolutionIssues]; conditional.relatedCandidates = [{ german: treeVariant.german, spanish: "el pino", reason: "split_existing_sense: preserve the existing tree meaning" }];
const splitOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [jaw], WORDS_ES: [combined], WORDS_ES_DE: [combinedRelation], userprogresses: [] } }, [conditional]);
assert.ok(buildWordCardAudit(splitOptions).manifest.patches.every(patch => ["WORDS_DE", "WORDS_ES"].includes(patch.collection) && Object.keys(patch.set).every(path => path === "notes")), "a missing companion must prevent primary scope narrowing; independent generic note cleanup remains permitted");
assert.ok(buildWordCardAudit(splitOptions).reviewQueue.items.some(item => item.kind === "missing_split_companion"), "resolved blocker prose does not waive the required companion proof");
const splitPrepared = prepareWordCardAdditions(splitOptions.snapshot, splitOptions.review as any, { sourceHash: splitOptions.snapshotSHA256, reviewHash: splitOptions.reviewSHA256 });
const treeCandidate = { ...splitPrepared.candidates[0], originalDEReuseId: jaw._id.toHexString() };
const treeBefore = buildWordCardCandidateSnapshot([treeCandidate], "builder-test-candidates", now.toISOString());
const candidateDE = treeBefore.collections.WORDS_DE[0], candidateES = treeBefore.collections.WORDS_ES[0], candidateRelation = treeBefore.collections.WORDS_ES_DE[0];
const additionEntry = draft(candidateDE, treeVariant, [{ relation: candidateRelation, spanish: "el pino", examples: ["El pino crece en el bosque.", "Plantamos un pino."], variant: treeVariant }]);
const additionOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [candidateDE], WORDS_ES: [candidateES], WORDS_ES_DE: [candidateRelation], userprogresses: [] } }, [additionEntry]);
const additions = { snapshot: additionOptions.snapshot, snapshotSHA256: additionOptions.snapshotSHA256, review: additionOptions.review, map: { ...splitPrepared.summary, candidates: [treeCandidate] } };
const withCompanion = buildWordCardAudit({ ...splitOptions, additions });
assert.ok(withCompanion.manifest.patches.some(patch => patch.collection === "WORDS_ES_DE" && patch.id === combinedRelation._id.toHexString()));
assert.equal(withCompanion.manifest.inserts.length, 3); assert.ok(withCompanion.report.classifications.every(item => item.status === "offline_classification_required"));
for (const insert of withCompanion.manifest.inserts.filter(insert => insert.collection !== "WORDS_ES_DE")) assert.deepEqual(insert.document.contexts, ["general_vocabulary"], "New reviewed companions must be reachable through the existing category filter");
assert.ok(!withCompanion.reviewQueue.items.some(item => item.kind === "missing_split_companion"));
assert.ok(withCompanion.reviewQueue.items.some(item => item.kind === "invalid_reuse_hint"), "different gender/sense must not reuse the original lookup record");
const uncertainAddition = { ...additions, review: { ...additions.review, entries: [{ ...additionEntry, confidence: "needs_review" as const, reviewReason: "Tree gender needs checking", translations: additionEntry.translations.map(translation => ({ ...translation, variant: { ...translation.variant!, confidence: "needs_review" as const, reviewReason: "Tree gender needs checking" } })) }] } };
assert.ok(buildWordCardAudit({ ...splitOptions, additions: uncertainAddition }).manifest.patches.every(patch => ["WORDS_DE", "WORDS_ES"].includes(patch.collection) && Object.keys(patch.set).every(path => path === "notes")));
assert.throws(() => buildWordCardAudit({ ...splitOptions, additions: { ...additions, snapshotSHA256: "c".repeat(64) } }), /provenance/);

// A reviewed unlinked noun can reuse its unchanged dictionary identity when the sense agrees.
const unlinkedHouse: Document = { ...word("unlinked-house", "Haus"), examples: house.examples };
const originalHouseDraft = draft(unlinkedHouse, { ...house, examples: ["Das Haus hat einen Garten.", "Unser Haus ist neu."] }, [{ relation: null, spanish: "la casa", examples: ["La casa tiene un jardín.", "Nuestra casa es nueva."], variant: { ...house, examples: ["Das Haus hat einen Garten.", "Unser Haus ist neu."] } }]);
const unlinkedOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [unlinkedHouse], WORDS_ES: [], WORDS_ES_DE: [], userprogresses: [] } }, [originalHouseDraft]);
const unlinkedPrepared = prepareWordCardAdditions(unlinkedOptions.snapshot, unlinkedOptions.review as any, { sourceHash: unlinkedOptions.snapshotSHA256, reviewHash: unlinkedOptions.reviewSHA256 });
const unlinkedCandidate = unlinkedPrepared.candidates[0], houseBefore = buildWordCardCandidateSnapshot([unlinkedCandidate], "builder-test-candidates", now.toISOString());
const houseCandidate = houseBefore.collections.WORDS_DE[0], houseSpanish = houseBefore.collections.WORDS_ES[0], houseRelation = houseBefore.collections.WORDS_ES_DE[0];
const houseAdditionDraft = draft(houseCandidate, house, [{ relation: houseRelation, spanish: "la casa", examples: ["La casa es grande.", "Vivo en una casa."], variant: house }]);
const houseAdditionOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [houseCandidate], WORDS_ES: [houseSpanish], WORDS_ES_DE: [houseRelation], userprogresses: [] } }, [houseAdditionDraft]);
const reused = buildWordCardAudit({ ...unlinkedOptions, additions: { snapshot: houseAdditionOptions.snapshot, snapshotSHA256: houseAdditionOptions.snapshotSHA256, review: houseAdditionOptions.review, map: { ...unlinkedPrepared.summary, candidates: [unlinkedCandidate] } } });
assert.equal(reused.manifest.inserts.filter(insert => insert.collection === "WORDS_DE").length, 0);
assert.ok(reused.manifest.inserts.find(insert => insert.collection === "WORDS_ES_DE")?.document.translated.equals(unlinkedHouse._id));
assert.equal(reused.manifest.patches.find(patch => patch.collection === "WORDS_DE")?.set.examples, undefined, "when final reviewed examples equal the original, an earlier draft patch must be removed");

// Exact source/review-bound semantic proofs can cover synonymous companion wording.
function decisionsFor(source: BuildWordCardAuditOptions, ambiguities: any, entries: CandidateDecision[]) {
  const inputs = buildCandidateReviewInputs(ambiguities, source.review, source.snapshot.collections.WORDS_DE.length), ambiguitiesSHA256 = wordCardSHA256(JSON.stringify(ambiguities));
  const metadata = { version: 1, helperVersion: CANDIDATE_HELPER_VERSION, mode: "dedup", model: CANDIDATE_HELPER_MODEL, sourceHash: wordCardSHA256(JSON.stringify({ ambiguousHash: ambiguitiesSHA256, reviewHash: source.reviewSHA256 })), reviewHash: source.reviewSHA256, scopeHash: wordCardSHA256(JSON.stringify(inputs)), promptHash: wordCardSHA256(CANDIDATE_HELPER_VERSION + CANDIDATE_DECISION_INSTRUCTIONS + JSON.stringify(CANDIDATE_DECISION_SCHEMA)), offset: 0, selected: inputs.length, totalScope: inputs.length };
  const candidateAliases = entries.filter(entry => entry.coveredByCandidateIds.length).map(entry => ({ candidateId: entry.candidateId, senseKey: inputs.find(input => input.candidateId === entry.candidateId)!.requestedSense.senseKey, representativeCandidateId: entry.coveredByCandidateIds[0], representativeSenseKey: inputs.find(input => input.candidateId === entry.coveredByCandidateIds[0])!.requestedSense.senseKey, reason: entry.reason }));
  return { ambiguities, ambiguitiesSHA256, inputs: { ...metadata, entries: inputs }, decisions: { ...metadata, status: "helper_complete", fullScopeComplete: true, completed: inputs.length, pending: 0, aliasErrors: [], candidateAliases, entries } };
}
function reviewedAdditionsFor(source: BuildWordCardAuditOptions, candidates: AdditionCandidate[], content: (candidate: AdditionCandidate) => { variant: WordCardVariant; spanishExamples: string[] }) {
  const snapshot = buildWordCardCandidateSnapshot(candidates, "builder-test-candidates", now.toISOString());
  const entries = candidates.map(candidate => { const words = content(candidate), de = snapshot.collections.WORDS_DE.find(word => word._id.toHexString() === candidate.id)!, relation = snapshot.collections.WORDS_ES_DE.find(relation => relation._id.toHexString() === candidate.candidateId)!; return draft(de, words.variant, [{ relation, spanish: candidate.spanish, examples: words.spanishExamples, variant: words.variant }]); });
  const reviewed = optionsFor(snapshot, entries), prepared = prepareWordCardAdditions(source.snapshot, source.review as any, { sourceHash: source.snapshotSHA256, reviewHash: source.reviewSHA256 });
  return { snapshot: reviewed.snapshot, snapshotSHA256: reviewed.snapshotSHA256, review: reviewed.review, map: { ...prepared.summary, candidates } };
}
const aliasConditional: WordCardDraft = { ...conditional, relatedCandidates: ["el pino", "el árbol de pino", "la conífera de pino"].map(spanish => ({ german: "Die Kiefer", spanish, reason: "split_existing_sense: preserve the existing tree meaning" })) };
const aliasOptions = optionsFor(splitOptions.snapshot, [aliasConditional]);
const preparedAliases = prepareWordCardAdditions(aliasOptions.snapshot, aliasOptions.review as any, { sourceHash: aliasOptions.snapshotSHA256 });
const ambiguity = { ...preparedAliases.summary, ambiguousCandidates: preparedAliases.ambiguousCandidates };
const sortedAliases = [...preparedAliases.ambiguousCandidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId)); assert.equal(sortedAliases.length, 3);
const aliasEntries: CandidateDecision[] = sortedAliases.map((candidate, index) => ({ candidateId: candidate.candidateId, decision: index ? "covered" : "missing", coveredByIDs: [], coveredByCandidateIds: index ? [sortedAliases[index - 1].candidateId] : [], reason: index ? "Same reviewed pine sense with synonymous Spanish wording" : "No original pine pair exists" }));
const aliasProof = decisionsFor(aliasOptions, ambiguity, aliasEntries);
const representative = sortedAliases[0], repBefore = buildWordCardCandidateSnapshot([representative], "builder-test-candidates", now.toISOString()), repDE = repBefore.collections.WORDS_DE[0], repES = repBefore.collections.WORDS_ES[0], repRelation = repBefore.collections.WORDS_ES_DE[0];
const repOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [repDE], WORDS_ES: [repES], WORDS_ES_DE: [repRelation], userprogresses: [] } }, [draft(repDE, treeVariant, [{ relation: repRelation, spanish: representative.spanish, examples: ["El pino crece en el bosque.", "Plantamos un pino."], variant: treeVariant }])]);
const aliasAdditions = { snapshot: repOptions.snapshot, snapshotSHA256: repOptions.snapshotSHA256, review: repOptions.review, map: { ...preparedAliases.summary, candidates: [representative] } };
const aliasResult = buildWordCardAudit({ ...aliasOptions, candidateDecisions: aliasProof, additions: aliasAdditions });
assert.ok(aliasResult.manifest.patches.some(patch => patch.collection === "WORDS_ES_DE" && patch.id === combinedRelation._id.toHexString()), "valid lower-ID chained aliases end in an actually inserted high-reviewed companion");
assert.equal(aliasResult.manifest.inserts.filter(insert => insert.collection === "WORDS_ES_DE").length, 1);
assert.ok(!aliasResult.reviewQueue.items.some(item => ["missing_split_companion", "related_candidate_pending"].includes(item.kind)));
const finalizedAliasFiles = { snapshotText: serializeWordCardEjson(aliasOptions.snapshot), reviewText: JSON.stringify(aliasOptions.review), preparedMapText: JSON.stringify({ ...preparedAliases.summary, candidates: preparedAliases.candidates, coveredCandidates: preparedAliases.coveredCandidates }), ambiguousText: JSON.stringify(ambiguity), decisionsText: JSON.stringify(aliasProof.decisions), decisionInputsText: JSON.stringify(aliasProof.inputs) };
const finalizedAliases = finalizeWordCardAdditions(finalizedAliasFiles, now.toISOString());
assert.equal(finalizedAliases.candidates.length, 1); assert.equal(finalizedAliases.coveredCandidates.length, 2);
const finalizedAliasSnapshot = BSON.EJSON.parse(finalizedAliases.candidateSnapshotText, { relaxed: false }), finalizedAliasHash = wordCardSHA256(finalizedAliases.candidateSnapshotText);
const finalizedAliasProof = { ...aliasProof, decisionsSHA256: wordCardSHA256(finalizedAliasFiles.decisionsText), inputsSHA256: wordCardSHA256(finalizedAliasFiles.decisionInputsText) };
const finalizedAliasSource: BuildWordCardAuditOptions = { ...aliasOptions, candidateDecisions: finalizedAliasProof, additions: { snapshot: finalizedAliasSnapshot, snapshotSHA256: finalizedAliasHash, review: reviewFor(repOptions.review.entries, finalizedAliasHash), map: { ...finalizedAliases.summary, candidates: finalizedAliases.candidates, coveredCandidates: finalizedAliases.coveredCandidates } } };
const finalizedAliasOptions: BuildWordCardAuditOptions = {...finalizedAliasSource,finalCandidateProof:finalProofFor(finalizedAliasSource,input=>({candidateId:input.candidateId,intention:"preserved",decision:"missing",coveredByIDs:[],coveredByCandidateIds:[],reason:"Controlled fixture: same pine intention across all source aliases and no existing ready pine relation."}))};
const finalizedAliasResult = buildWordCardAudit(finalizedAliasOptions);
assert.throws(()=>buildWordCardAudit({...finalizedAliasOptions,requireFinalCandidateEvidence:true}),/ordinary proof cannot downgrade/,"Caller evidence policy cannot be removed by deleting the proof's composition field");
assert.throws(()=>buildWordCardAudit({...finalizedAliasOptions,requireFinalCandidateEvidence:true,finalCandidateProof:{...finalizedAliasOptions.finalCandidateProof!,decisions:{...finalizedAliasOptions.finalCandidateProof!.decisions,composition:{version:1,components:[]}},evidence:{} as any}}),/spoofed/);
assert.ok(sameWordCardBson(finalizedAliasResult.manifest, aliasResult.manifest), "the strict finalizer's representative and copied alias proofs produce the same reviewed manifest");
assert.throws(() => buildWordCardAudit({ ...finalizedAliasOptions, additions: { ...finalizedAliasOptions.additions!, map: { ...finalizedAliasOptions.additions!.map, candidateSnapshotSHA256: "e".repeat(64) } } }), /Finalized addition mapping/);
assert.throws(() => buildWordCardAudit({ ...finalizedAliasOptions, candidateDecisions: { ...finalizedAliasProof, inputsSHA256: "e".repeat(64) } }), /Finalized addition mapping/);
assert.throws(() => buildWordCardAudit({ ...finalizedAliasOptions, candidateDecisions: { ...finalizedAliasProof, decisionsSHA256: "e".repeat(64) } }), /Finalized addition mapping/);
assert.ok(buildWordCardAudit({ ...aliasOptions, candidateDecisions: aliasProof }).reviewQueue.items.some(item => item.kind === "missing_split_companion"), "a semantic alias without an included reviewed representative cannot narrow the old pair");
assert.throws(() => buildWordCardAudit({ ...aliasOptions, candidateDecisions: decisionsFor(aliasOptions, { ...ambiguity, ambiguousCandidates: sortedAliases.slice(1) }, aliasEntries.slice(1)) }), /actual candidate record|full ambiguity scope/);
const uncertainChain = decisionsFor(aliasOptions, ambiguity, [{ ...aliasEntries[0], decision: "needs_review" }, ...aliasEntries.slice(1)]);
assert.throws(() => buildWordCardAudit({ ...aliasOptions, candidateDecisions: uncertainChain }), /terminate/);
assert.throws(() => buildWordCardAudit({ ...aliasOptions, candidateDecisions: { ...aliasProof, decisions: { ...aliasProof.decisions, reviewHash: "e".repeat(64) } } }), /provenance/);
assert.throws(() => buildWordCardAudit({ ...aliasOptions, candidateDecisions: { ...aliasProof, inputs: { ...aliasProof.inputs, entries: [] } } }), /reconstructed/);
const unsafeAmbiguity = { ...ambiguity, ambiguousCandidates: [{ ...representative, potentialMatchingStudyBackSenses: [{ german: jawVariant.german, spanish: "la mandíbula", wordId: jaw._id.toHexString(), relationId: combinedRelation._id.toHexString(), ready: true }], alternativeCandidateSenses: [] }] };
const unsafeProof = decisionsFor(aliasOptions, unsafeAmbiguity, [{ candidateId: representative.candidateId, decision: "covered", coveredByIDs: [combinedRelation._id.toHexString()], coveredByCandidateIds: [], reason: "Unsafe homograph claim" }]);
assert.throws(() => buildWordCardAudit({ ...aliasOptions, candidateDecisions: unsafeProof }), /compatible construction/);
assert.equal(representative.candidateId, additionId("relation", representative.german, representative.spanish, representative.senseKey));
const pineDE = word("existing-pine", "Kiefer"), pineES = word("existing-pine-es", "el pino"), pineRelation = relation("existing-pine-relation", pineDE, pineES);
const pineDraft = draft(pineDE, treeVariant, [{ relation: pineRelation, spanish: "el pino", examples: ["El pino crece en el bosque.", "Plantamos un pino."], variant: treeVariant }]);
const synonymConditional: WordCardDraft = { ...conditional, relatedCandidates: [{ german: "Die Kiefer", spanish: "el árbol de pino", reason: "split_existing_sense: preserve the existing tree meaning" }] };
const existingOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [jaw, pineDE], WORDS_ES: [combined, pineES], WORDS_ES_DE: [combinedRelation, pineRelation], userprogresses: [] } }, [synonymConditional, pineDraft]);
const existingPrepared = prepareWordCardAdditions(existingOptions.snapshot, existingOptions.review as any, { sourceHash: existingOptions.snapshotSHA256 });
const existingAmbiguity = { ...existingPrepared.summary, ambiguousCandidates: existingPrepared.ambiguousCandidates };
const existingProof = decisionsFor(existingOptions, existingAmbiguity, existingPrepared.ambiguousCandidates.map(candidate => ({ candidateId: candidate.candidateId, decision: "covered", coveredByIDs: [pineRelation._id.toHexString()], coveredByCandidateIds: [], reason: "Same pine noun and sense; synonymous Spanish wording" })));
assert.ok(buildWordCardAudit({ ...existingOptions, candidateDecisions: existingProof }).manifest.patches.some(patch => patch.id === combinedRelation._id.toHexString()), "a ready reviewed existing relation can prove synonymous companion coverage");
const uncertainExistingOptions = optionsFor(existingOptions.snapshot, [synonymConditional, { ...pineDraft, confidence: "needs_review", reviewReason: "Gender requires verification" }]);
const uncertainExistingPrepared = prepareWordCardAdditions(uncertainExistingOptions.snapshot, uncertainExistingOptions.review as any, { sourceHash: uncertainExistingOptions.snapshotSHA256 });
const uncertainExistingProof = decisionsFor(uncertainExistingOptions, { ...uncertainExistingPrepared.summary, ambiguousCandidates: uncertainExistingPrepared.ambiguousCandidates }, existingProof.decisions.entries);
assert.throws(() => buildWordCardAudit({ ...uncertainExistingOptions, candidateDecisions: uncertainExistingProof }), /ready provided existing/);

// Identical fronts cannot merge a financial bank and a seating bench.
const financialBank = noun("Die Bank", "Die Banken", ["Die Bank verleiht Geld.", "Ich habe ein Konto bei dieser Bank."]);
const seatingBench = noun("Die Bank", "Die Bänke", ["Die Bank steht im Park.", "Wir sitzen auf einer Bank."]);
const financialSpanish = ["El banco presta dinero.", "Tengo una cuenta en este banco."], benchSpanish = ["El banco está en el parque.", "Nos sentamos en un banco."];
const bankDE = word("financial-bank", "Bank"), bankES = word("financial-bank-es", "el banco"), bankRelation = relation("financial-bank-relation", bankDE, bankES);
const bankDraft = draft(bankDE, financialBank, [{ relation: bankRelation, spanish: "el banco", examples: financialSpanish, variant: financialBank }]);
bankDraft.issues = ["split_requires_companion_card"]; bankDraft.relatedCandidates = [{ german: "Die Bank", spanish: "el banco", reason: "split_existing_sense: seating bench with plural Die Bänke" }];
const bankOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [bankDE], WORDS_ES: [bankES], WORDS_ES_DE: [bankRelation], userprogresses: [] } }, [bankDraft]);
const bankPrepared = prepareWordCardAdditions(bankOptions.snapshot, bankOptions.review as any, { sourceHash: bankOptions.snapshotSHA256, reviewHash: bankOptions.reviewSHA256 }), bankCandidate = bankPrepared.ambiguousCandidates[0];
assert.equal(bankPrepared.ambiguousCandidates.length, 1, "even identical back text requires a semantic same-front decision");
assert.ok(!buildWordCardAudit(bankOptions).manifest.patches.some(patch => patch.id === bankRelation._id.toHexString()), "the original primary pair cannot satisfy its own requested second sense by matching text");
const bankProof = decisionsFor(bankOptions, { ...bankPrepared.summary, ambiguousCandidates: bankPrepared.ambiguousCandidates }, [{ candidateId: bankCandidate.candidateId, decision: "missing", coveredByIDs: [], coveredByCandidateIds: [], reason: "Financial Banken does not teach a seating bench with Bänke" }]);
const benchAdditions = reviewedAdditionsFor(bankOptions, [bankCandidate], () => ({ variant: seatingBench, spanishExamples: benchSpanish }));
const bankResult = buildWordCardAudit({ ...bankOptions, candidateDecisions: bankProof, additions: benchAdditions });
assert.equal(bankResult.manifest.inserts.length, 3, "high-reviewed bench must be inserted despite identical existing financial fronts");
assert.equal(bankResult.manifest.inserts.find(insert => insert.collection === "WORDS_DE")?.document.forms.plural, "Die Bänke");
assert.equal((bankResult.manifest.patches.find(patch => patch.id === bankRelation._id.toHexString())!.set.study as any).notes, "Die Banken");
assert.equal(bankResult.manifest.inserts.find(insert => insert.collection === "WORDS_ES_DE")?.document.study.notes, "Die Bänke");
assert.ok(!bankResult.reviewQueue.items.some(item => ["missing_split_companion", "related_candidate_pending"].includes(item.kind)));
const finalizedBankFiles = { snapshotText: serializeWordCardEjson(bankOptions.snapshot), reviewText: JSON.stringify(bankOptions.review), preparedMapText: JSON.stringify({ ...bankPrepared.summary, candidates: bankPrepared.candidates, coveredCandidates: bankPrepared.coveredCandidates }), ambiguousText: JSON.stringify(bankProof.ambiguities), decisionsText: JSON.stringify(bankProof.decisions), decisionInputsText: JSON.stringify(bankProof.inputs) };
const finalizedBank = finalizeWordCardAdditions(finalizedBankFiles, now.toISOString()), finalizedBankHash = wordCardSHA256(finalizedBank.candidateSnapshotText);
const finalizedBankOptions = { ...bankOptions, candidateDecisions: { ...bankProof, decisionsSHA256: wordCardSHA256(finalizedBankFiles.decisionsText), inputsSHA256: wordCardSHA256(finalizedBankFiles.decisionInputsText) }, additions: { snapshot: BSON.EJSON.parse(finalizedBank.candidateSnapshotText, { relaxed: false }), snapshotSHA256: finalizedBankHash, review: reviewFor(benchAdditions.review.entries, finalizedBankHash), map: { ...finalizedBank.summary, candidates: finalizedBank.candidates, coveredCandidates: finalizedBank.coveredCandidates } } };
assert.throws(()=>buildWordCardAudit(finalizedBankOptions),/canonical coverage proof/,"Finalized additions cannot bypass actual final semantic coverage even when their seed stayed unchanged");
const finalizedBankResult = buildWordCardAudit({...finalizedBankOptions,finalCandidateProof:finalProofFor(finalizedBankOptions,input=>({candidateId:input.candidateId,intention:"preserved",decision:"missing",coveredByIDs:[],coveredByCandidateIds:[],reason:"Controlled fixture: seating Bänke is a distinct absent meaning from ready financial Banken despite the identical front."}))});
assert.ok(sameWordCardBson(finalizedBankResult.manifest, bankResult.manifest), "finalization must retain the seating intention despite identical financial dictionary fronts");
const wrongIntention = { ...benchAdditions, map: { ...benchAdditions.map, candidates: [{ ...bankCandidate, relatedFrom: bankCandidate.relatedFrom.map(source => ({ ...source, reason: "financial institution instead of the requested bench" })) }] } };
assert.throws(() => buildWordCardAudit({ ...bankOptions, candidateDecisions: bankProof, additions: wrongIntention }), /requested intention/);
assert.ok(buildWordCardAudit({ ...bankOptions, additions: benchAdditions }).reviewQueue.items.some(item => item.kind === "candidate_dedup_review_required"), "same-front reviewed additions require a resolved semantic duplicate decision");
const mistakenBenchProof = decisionsFor(bankOptions, { ...bankPrepared.summary, ambiguousCandidates: bankPrepared.ambiguousCandidates }, [{ candidateId: bankCandidate.candidateId, decision: "covered", coveredByIDs: [bankRelation._id.toHexString()], coveredByCandidateIds: [], reason: "An incorrect duplicate claim based on front text" }]);
const contradictedCoverage = buildWordCardAudit({ ...bankOptions, candidateDecisions: mistakenBenchProof, additions: benchAdditions });
assert.ok(!contradictedCoverage.manifest.patches.some(patch => patch.id === bankRelation._id.toHexString())); assert.ok(contradictedCoverage.reviewQueue.items.some(item => item.kind === "candidate_existing_coverage_deferred"), "final reviewed Bänke evidence must reject a financial Banken coverage claim");

const financeDraft: WordCardDraft = { ...bankDraft, issues: [], relatedCandidates: [{ german: "Die Bank", spanish: "el banco", reason: "Current financial institution with plural Die Banken" }] };
const financeOptions = optionsFor(bankOptions.snapshot, [financeDraft]), financePrepared = prepareWordCardAdditions(financeOptions.snapshot, financeOptions.review as any, { sourceHash: financeOptions.snapshotSHA256, reviewHash: financeOptions.reviewSHA256 });
const financeCandidate = financePrepared.ambiguousCandidates[0], financeProof = decisionsFor(financeOptions, { ...financePrepared.summary, ambiguousCandidates: financePrepared.ambiguousCandidates }, [{ candidateId: financeCandidate.candidateId, decision: "covered", coveredByIDs: [bankRelation._id.toHexString()], coveredByCandidateIds: [], reason: "Same singular financial bank, plural Banken, and money examples" }]);
const coveredFinanceAddition = reviewedAdditionsFor(financeOptions, [financeCandidate], () => ({ variant: financialBank, spanishExamples: financialSpanish }));
const financeResult = buildWordCardAudit({ ...financeOptions, candidateDecisions: financeProof, additions: coveredFinanceAddition });
assert.equal(financeResult.manifest.inserts.length, 0); assert.equal(financeResult.report.additions[0].status, "covered_by_validated_semantic_existing_relation", "a fully validated same-sense existing relation is the only existing-text insertion skip");
// A vague intermediate peer cannot erase an alias origin's independently reviewed plural.
const ownBenchDE = word("own-unlinked-bench", "Bank"), ownBenchDraft = draft(ownBenchDE, seatingBench, [{ relation: null, spanish: "el banco", examples: benchSpanish, variant: seatingBench }]);
let explicitAliasOptions!: BuildWordCardAuditOptions, explicitAliasPrepared!: ReturnType<typeof prepareWordCardAdditions>, vagueTarget!: AdditionCandidate, explicitOrigin!: AdditionCandidate;
for (let attempt = 0; attempt < 64; attempt++) {
  const requestedFinance: WordCardDraft = { ...financeDraft, relatedCandidates: [{ german: "Die Bank", spanish: "el banco", reason: `Financial singular requested independently ${attempt}` }] };
  explicitAliasOptions = optionsFor({ ...bankOptions.snapshot, collections: { ...bankOptions.snapshot.collections, WORDS_DE: [...bankOptions.snapshot.collections.WORDS_DE, ownBenchDE] } }, [requestedFinance, ownBenchDraft]);
  explicitAliasPrepared = prepareWordCardAdditions(explicitAliasOptions.snapshot, explicitAliasOptions.review as any, { sourceHash: explicitAliasOptions.snapshotSHA256, reviewHash: explicitAliasOptions.reviewSHA256 });
  vagueTarget = explicitAliasPrepared.ambiguousCandidates.find(candidate => candidate.sources.some(source => source.kind === "related"))!;
  explicitOrigin = explicitAliasPrepared.ambiguousCandidates.find(candidate => candidate.sources.some(source => source.kind === "unlinked"))!;
  if (vagueTarget.candidateId < explicitOrigin.candidateId) break;
}
assert.ok(vagueTarget.candidateId < explicitOrigin.candidateId, "fixture requires the controlled lower-ID alias ordering");
const explicitAliasProof = decisionsFor(explicitAliasOptions, { ...explicitAliasPrepared.summary, ambiguousCandidates: explicitAliasPrepared.ambiguousCandidates }, [{ candidateId: vagueTarget.candidateId, decision: "missing", coveredByIDs: [], coveredByCandidateIds: [], reason: "Mock terminal unresolved grammar until final independent review" }, { candidateId: explicitOrigin.candidateId, decision: "covered", coveredByIDs: [], coveredByCandidateIds: [vagueTarget.candidateId], reason: "Mock mistaken same-front alias with a vague intermediate grammar scope" }]);
const explicitAliasResult = buildWordCardAudit({ ...explicitAliasOptions, candidateDecisions: explicitAliasProof, additions: reviewedAdditionsFor(explicitAliasOptions, [vagueTarget], () => ({ variant: financialBank, spanishExamples: financialSpanish })) });
assert.equal(explicitAliasResult.manifest.inserts.length, 0); assert.ok(explicitAliasResult.reviewQueue.items.some(item => item.kind === "candidate_review_changed_intention"), "final representative Banken cannot cover an alias origin explicitly reviewed as Bänke");

const pluralBank = noun("Die Banken", "", ["Die Banken finanzieren Unternehmen.", "Viele Banken bieten Kredite an."]); pluralBank.forms.gender = "";
const pluralDE = word("plural-bank", "Banken"), pluralES = word("plural-bank-es", "los bancos"), pluralRelation = relation("plural-bank-relation", pluralDE, pluralES);
const pluralDraft = draft(pluralDE, pluralBank, [{ relation: pluralRelation, spanish: "los bancos", examples: ["Los bancos financian empresas.", "Muchos bancos ofrecen créditos."], variant: pluralBank }]);
pluralDraft.issues = ["split_requires_companion_card"]; pluralDraft.relatedCandidates = [{ german: "Die Bank", spanish: "el banco", reason: "split_existing_sense: financial institution singular with plural Die Banken" }, { german: "Die Bank", spanish: "el banco", reason: "split_existing_sense: seating bench singular with plural Die Bänke" }];
const pluralOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [pluralDE], WORDS_ES: [pluralES], WORDS_ES_DE: [pluralRelation], userprogresses: [] } }, [pluralDraft]);
const pluralPrepared = prepareWordCardAdditions(pluralOptions.snapshot, pluralOptions.review as any, { sourceHash: pluralOptions.snapshotSHA256, reviewHash: pluralOptions.reviewSHA256 });
assert.equal(pluralPrepared.ambiguousCandidates.length, 2); assert.notEqual(pluralPrepared.ambiguousCandidates[0].candidateId, pluralPrepared.ambiguousCandidates[1].candidateId);
const pluralProof = decisionsFor(pluralOptions, { ...pluralPrepared.summary, ambiguousCandidates: pluralPrepared.ambiguousCandidates }, pluralPrepared.ambiguousCandidates.map(candidate => ({ candidateId: candidate.candidateId, decision: "missing", coveredByIDs: [], coveredByCandidateIds: [], reason: "Requested singular sense is absent from the plural financial card" })));
const pluralAdditions = reviewedAdditionsFor(pluralOptions, pluralPrepared.ambiguousCandidates, candidate => candidate.requestedSense.reasons.some(reason => reason.includes("seating")) ? { variant: seatingBench, spanishExamples: benchSpanish } : { variant: financialBank, spanishExamples: financialSpanish });
const pluralResult = buildWordCardAudit({ ...pluralOptions, candidateDecisions: pluralProof, additions: pluralAdditions });
assert.equal(pluralResult.manifest.inserts.length, 6, "two genuinely missing senses with the same text retain separate IDs and both pairs");
assert.deepEqual(pluralResult.manifest.inserts.filter(insert => insert.collection === "WORDS_DE").map(insert => insert.document.forms.plural).sort(), ["Die Banken", "Die Bänke"].sort());
assert.ok(!pluralResult.reviewQueue.items.some(item => ["missing_split_companion", "related_candidate_pending"].includes(item.kind)));
const financeOnly = reviewedAdditionsFor(pluralOptions, pluralPrepared.ambiguousCandidates.filter(candidate => candidate.requestedSense.reasons.some(reason => reason.includes("financial"))), () => ({ variant: financialBank, spanishExamples: financialSpanish }));
assert.ok(!buildWordCardAudit({ ...pluralOptions, candidateDecisions: pluralProof, additions: financeOnly }).manifest.patches.some(patch => patch.id === pluralRelation._id.toHexString()), "one same-text financial addition cannot fulfill the requested bench intention");

const idiomDE = word("idiom", "hin und wieder"), idiomES = word("idiom-es", "de vez en cuando"), idiomRelation = relation("idiom-relation", idiomDE, idiomES);
const idiom: WordCardVariant = { german: "hin und wieder", category: "UNKNOWN", forms: forms(), notes: "Redewendung", examples: ["Hin und wieder gehe ich spazieren.", "Wir sehen uns hin und wieder."], confidence: "high", reviewReason: "" };
const idiomOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [idiomDE], WORDS_ES: [idiomES], WORDS_ES_DE: [idiomRelation], userprogresses: [] } }, [draft(idiomDE, idiom, [{ relation: idiomRelation, spanish: "de vez en cuando", examples: ["De vez en cuando salgo a pasear.", "Nos vemos de vez en cuando."], variant: idiom }])]);
assert.ok(buildWordCardAudit(idiomOptions).manifest.patches.some(patch => patch.id === idiomRelation._id.toHexString()), "explicit high-reviewed Redewendung idioms remain eligible with UNKNOWN internal category");
const itselfDE = word("itself", "selbst"), itselfES = word("itself-es", "mismo"), itselfRelation = relation("itself-relation", itselfDE, itselfES);
const itselfVariant: WordCardVariant = { german: "selbst", category: "UNKNOWN", forms: forms(), notes: "", examples: ["Das Fundament selbst wurde nicht beschädigt.", "Der Text selbst enthält die Antwort."], confidence: "high", reviewReason: "" };
const itselfSpanish = ["El fundamento mismo no sufrió daños.", "El texto mismo contiene la respuesta."];
const itselfSnapshot = { auditedAt: now, collections: { WORDS_DE: [itselfDE], WORDS_ES: [itselfES], WORDS_ES_DE: [itselfRelation], userprogresses: [] } };
const itselfDraft = draft(itselfDE, itselfVariant, [{ relation: itselfRelation, spanish: "mismo", examples: itselfSpanish, variant: itselfVariant }]);
assert.ok(buildWordCardAudit(optionsFor(itselfSnapshot, [itselfDraft])).manifest.patches.some(patch => patch.id === itselfRelation._id.toHexString()), "a high-reviewed exact emphasis pair may retain UNKNOWN metadata");
const heldItself = { ...itselfDraft, confidence: "needs_review" as const, reviewReason: "Actual independent content review remains pending" };
const heldItselfResult = buildWordCardAudit(optionsFor(itselfSnapshot, [heldItself]));
assert.ok(!heldItselfResult.manifest.patches.some(patch => patch.id === itselfRelation._id.toHexString()), "category readiness cannot promote a held candidate into a correction");
assert.ok(heldItselfResult.reviewQueue.items.some(item => item.kind === "needs_review"));
const unmarkedIdiom = { ...idiom, notes: "" };
assert.ok(buildWordCardAudit({ ...idiomOptions, review: { ...idiomOptions.review, entries: [draft(idiomDE, unmarkedIdiom, [{ relation: idiomRelation, spanish: "de vez en cuando", examples: ["De vez en cuando salgo a pasear.", "Nos vemos de vez en cuando."], variant: unmarkedIdiom }])] } }).reviewQueue.items.some(item => item.kind === "needs_review"));
for (const [german, expected] of [["zehn", true], ["Zehn", false], ["10", false], ["zehnte", false]] as const) {
  const de = word(`cardinal-${german}`, german), es = word(`cardinal-es-${german}`, "diez"), rel = relation(`cardinal-rel-${german}`, de, es);
  const variant: WordCardVariant = { german, category: "UNKNOWN", forms: forms(), notes: "", examples: ["Wir sind zehn Personen.", "Ich brauche zehn Euro."], confidence: "high", reviewReason: "" };
  const result = buildWordCardAudit(optionsFor({ auditedAt: now, collections: { WORDS_DE: [de], WORDS_ES: [es], WORDS_ES_DE: [rel], userprogresses: [] } }, [draft(de, variant, [{ relation: rel, spanish: "diez", examples: ["Somos diez personas.", "Necesito diez euros."], variant }])]));
  assert.equal(result.manifest.patches.some(patch => patch.id === rel._id.toHexString()), expected, "only the explicitly approved exact lowercase cardinal seed is eligible");
}
const abbreviationDE = word("abbreviation", "usw."), abbreviationES = word("abbreviation-es", "y así sucesivamente"), abbreviationRelation = relation("abbreviation-rel", abbreviationDE, abbreviationES);
const abbreviation: WordCardVariant = { german: "usw.", category: "UNKNOWN", forms: forms(), notes: "", examples: ["Sie bringt Obst, Gemüse, Milch usw. mit.", "Er nannte Länder wie Spanien, Frankreich, Italien usw."], confidence: "high", reviewReason: "" };
const abbreviationSpanish = ["Ella trae fruta, verdura, leche y así sucesivamente.", "Él mencionó países como España, Francia, Italia, etc."];
const abbreviationSnapshot = { auditedAt: now, collections: { WORDS_DE: [abbreviationDE], WORDS_ES: [abbreviationES], WORDS_ES_DE: [abbreviationRelation], userprogresses: [] } };
assert.ok(buildWordCardAudit(optionsFor(abbreviationSnapshot, [draft(abbreviationDE, abbreviation, [{ relation: abbreviationRelation, spanish: abbreviationES.word, examples: abbreviationSpanish, variant: abbreviation }])])).manifest.patches.some(patch => patch.id === abbreviationRelation._id.toHexString()), "source-checked usw. reaches the reviewed pair without a false part-of-speech category");
const uncheckedAbbreviation = { ...abbreviation, german: "etc." };
assert.ok(buildWordCardAudit(optionsFor(abbreviationSnapshot, [draft(abbreviationDE, abbreviation, [{ relation: abbreviationRelation, spanish: abbreviationES.word, examples: abbreviationSpanish, variant: uncheckedAbbreviation }])])).reviewQueue.items.some(item => item.kind === "needs_review"), "an allowed primary front cannot admit an unchecked UNKNOWN relation variant");
const sieveDE = word("unknown-sieve", "sieben"), sieveES = word("unknown-sieve-es", "tamizar"), sieveRelation = relation("unknown-sieve-rel", sieveDE, sieveES);
const sieve: WordCardVariant = { german: "sieben", category: "UNKNOWN", forms: forms({ perfect: "hat gesiebt", past: "ich siebte", imperativ: "sieb!, siebt!" }), notes: "hat gesiebt\nich siebte\nsieb!, siebt!", examples: ["Ich siebe das Mehl.", "Sie hat das Mehl gesiebt."], confidence: "high", reviewReason: "" };
assert.throws(() => buildWordCardAudit(optionsFor({ auditedAt: now, collections: { WORDS_DE: [sieveDE], WORDS_ES: [sieveES], WORDS_ES_DE: [sieveRelation], userprogresses: [] } }, [draft(sieveDE, sieve, [{ relation: sieveRelation, spanish: "tamizar", examples: ["Tamizo la harina.", "Ella ha tamizado la harina."], variant: sieve }])])), /structural validation/, "the numeral exception cannot admit an UNKNOWN verb homograph with morphology");

// Controlled fixtures prove that a third reviewer can approve a grammatical seed correction.
const correctedSeedDraft: WordCardDraft = { ...houseDraft, issues:["split_requires_companion_card: fixture companion must be included"], relatedCandidates:[{german:"Ein Baum",spanish:"el árbol",reason:"split_existing_sense: preserve the tree meaning in this controlled fixture"}] };
const correctedSeedSource = optionsFor({auditedAt:now,collections:{WORDS_DE:[deHouse],WORDS_ES:[esShared],WORDS_ES_DE:[rHouse],userprogresses:[]}},[correctedSeedDraft]);
const correctedSeedPrepared = prepareWordCardAdditions(correctedSeedSource.snapshot, correctedSeedSource.review as any, {sourceHash:correctedSeedSource.snapshotSHA256,reviewHash:correctedSeedSource.reviewSHA256});
const correctedSeedDedup = decisionsFor(correctedSeedSource, {...correctedSeedPrepared.summary,ambiguousCandidates:correctedSeedPrepared.ambiguousCandidates}, []);
const correctedSeedFiles = {snapshotText:serializeWordCardEjson(correctedSeedSource.snapshot),reviewText:JSON.stringify(correctedSeedSource.review),preparedMapText:JSON.stringify({...correctedSeedPrepared.summary,candidates:correctedSeedPrepared.candidates,coveredCandidates:correctedSeedPrepared.coveredCandidates}),ambiguousText:JSON.stringify(correctedSeedDedup.ambiguities),decisionsText:JSON.stringify(correctedSeedDedup.decisions),decisionInputsText:JSON.stringify(correctedSeedDedup.inputs)};
const correctedSeedFinalized = finalizeWordCardAdditions(correctedSeedFiles,now.toISOString());
assert.equal(correctedSeedFinalized.candidates.length,1);
const correctedSeedVariant = noun("Der Baum","Die Bäume",["Der Baum steht im Garten.","Wir pflanzen einen Baum."]);
const correctedSeedReviewed = reviewedAdditionsFor(correctedSeedSource,correctedSeedFinalized.candidates,()=>({variant:correctedSeedVariant,spanishExamples:["El árbol está en el jardín.","Plantamos un árbol."]}));
const correctedSeedHash = wordCardSHA256(correctedSeedFinalized.candidateSnapshotText);
const correctedSeedOptions: BuildWordCardAuditOptions = {...correctedSeedSource,candidateDecisions:{...correctedSeedDedup,decisionsSHA256:wordCardSHA256(correctedSeedFiles.decisionsText),inputsSHA256:wordCardSHA256(correctedSeedFiles.decisionInputsText)},additions:{snapshot:BSON.EJSON.parse(correctedSeedFinalized.candidateSnapshotText,{relaxed:false}),snapshotSHA256:correctedSeedHash,review:reviewFor(correctedSeedReviewed.review.entries,correctedSeedHash),map:{...correctedSeedFinalized.summary,candidates:correctedSeedFinalized.candidates,coveredCandidates:correctedSeedFinalized.coveredCandidates}}};
const unchangedCorrectionInputs = JSON.stringify(correctedSeedOptions);
assert.throws(()=>buildWordCardAudit(correctedSeedOptions),/canonical coverage proof/,"A finalized changed seed cannot compile without independent final approval");
function finalProofFor(source: BuildWordCardAuditOptions, decision: (input:any)=>any) {
  const additionReviewSHA256=wordCardSHA256(JSON.stringify(source.additions!.review)), candidateMapSHA256=wordCardSHA256(JSON.stringify(source.additions!.map));
  const provenance={snapshotSHA256:source.additions!.snapshotSHA256,reviewSHA256:additionReviewSHA256,entries:source.additions!.review.entries.map(entry=>({id:entry.id,draftAgent:"/root/fixture_draft",reviewAgent:"/root/fixture_review",model:FINAL_CANDIDATE_MODEL,draftEffort:"xhigh",reviewEffort:"high",draftCheckpointSHA256:"a".repeat(64),reviewCheckpointSHA256:"b".repeat(64)}))};
  const provenanceSHA256=wordCardSHA256(JSON.stringify(provenance)), bindings={catalogReviewSHA256:source.reviewSHA256!,additionReviewSHA256,candidateMapSHA256,provenanceSHA256};
  const inputs=buildFinalCandidateInputs(source.review,source.additions!.review,source.additions!.map,provenance,source.snapshot.collections.WORDS_DE.length);
  const decisions={helperVersion:FINAL_CANDIDATE_VERSION,model:FINAL_CANDIDATE_MODEL,sourceHash:wordCardSHA256(JSON.stringify(bindings)),fullScopeComplete:true,totalScope:inputs.length,completed:inputs.length,pending:0,scopeHash:wordCardSHA256(JSON.stringify(inputs)),promptHash:FINAL_CANDIDATE_PROMPT_HASH,bindings,entries:inputs.map(decision),executions:inputs.map(input=>({candidateId:input.candidateId,kind:"codex-agent",agent:"/root/fixture_third",reasoningEffort:"xhigh",completedAt:now.toISOString(),jobSHA256:"c".repeat(64),resultSHA256:"d".repeat(64)}))};
  return {decisions,provenance,additionReviewSHA256,candidateMapSHA256,provenanceSHA256};
}
const correctedSeedApproval=finalProofFor(correctedSeedOptions,input=>({candidateId:input.candidateId,intention:"preserved",decision:"missing",coveredByIDs:[],coveredByCandidateIds:[],reason:"Controlled fixture: definite article fixes the noun front without changing the tree meaning; no supplied duplicate exists."}));
const correctedSeedResult=buildWordCardAudit({...correctedSeedOptions,finalCandidateProof:correctedSeedApproval});
assert.equal(correctedSeedResult.manifest.inserts.length,3,"verified same-intention noun correction should include its complete pair");
assert.ok(correctedSeedResult.manifest.patches.some(patch=>patch.collection==="WORDS_ES_DE"&&patch.id===rHouse._id.toHexString()),"verified companion permits the required source revision");
assert.ok(!correctedSeedResult.reviewQueue.items.some(item=>["missing_split_companion","related_candidate_pending"].includes(item.kind)));
assert.equal(JSON.stringify(correctedSeedOptions),unchangedCorrectionInputs,"frozen proposals, reviews and dedup proofs remain unchanged");
const heldSeedApproval=finalProofFor(correctedSeedOptions,input=>({candidateId:input.candidateId,intention:"needs_review",decision:"needs_review",coveredByIDs:[],coveredByCandidateIds:[],reason:"Controlled fixture: unresolved correction"}));
const heldSeedResult=buildWordCardAudit({...correctedSeedOptions,finalCandidateProof:heldSeedApproval});
assert.equal(heldSeedResult.manifest.inserts.length,0);
assert.ok(heldSeedResult.reviewQueue.items.some(item=>item.kind==="missing_split_companion"));
assert.throws(()=>buildWordCardAudit({...correctedSeedOptions,finalCandidateProof:{...correctedSeedApproval,additionReviewSHA256:"f".repeat(64)}}),/Final candidate/);
assert.throws(()=>buildWordCardAudit({...correctedSeedOptions,finalCandidateProof:{...correctedSeedApproval,decisions:{...correctedSeedApproval.decisions,executions:correctedSeedApproval.decisions.executions.map(row=>({...row,agent:"/root/fixture_review"}))}}}),/different third reviewer/);

// Final corrected fronts can collide even when their frozen seeds did not.
function finalizeCorrectedFixture(source:BuildWordCardAuditOptions, choose:(candidate:AdditionCandidate)=>{variant:WordCardVariant;spanishExamples:string[]} = ()=>({variant:correctedSeedVariant,spanishExamples:["El árbol está en el jardín.","Plantamos un árbol."]})) {
  const prepared=prepareWordCardAdditions(source.snapshot,source.review as any,{sourceHash:source.snapshotSHA256,reviewHash:source.reviewSHA256});
  const dedup=decisionsFor(source,{...prepared.summary,ambiguousCandidates:prepared.ambiguousCandidates},prepared.ambiguousCandidates.map(candidate=>({candidateId:candidate.candidateId,decision:"missing",coveredByIDs:[],coveredByCandidateIds:[],reason:"Controlled fixture: frozen seed does not match the ready canonical front"})));
  const files={snapshotText:serializeWordCardEjson(source.snapshot),reviewText:JSON.stringify(source.review),preparedMapText:JSON.stringify({...prepared.summary,candidates:prepared.candidates,coveredCandidates:prepared.coveredCandidates}),ambiguousText:JSON.stringify(dedup.ambiguities),decisionsText:JSON.stringify(dedup.decisions),decisionInputsText:JSON.stringify(dedup.inputs)};
  const finalized=finalizeWordCardAdditions(files,now.toISOString()), hash=wordCardSHA256(finalized.candidateSnapshotText);
  const reviewed=reviewedAdditionsFor(source,finalized.candidates,choose);
  return {...source,candidateDecisions:{...dedup,decisionsSHA256:wordCardSHA256(files.decisionsText),inputsSHA256:wordCardSHA256(files.decisionInputsText)},additions:{snapshot:BSON.EJSON.parse(finalized.candidateSnapshotText,{relaxed:false}),snapshotSHA256:hash,review:reviewFor(reviewed.review.entries,hash),map:{...finalized.summary,candidates:finalized.candidates,coveredCandidates:finalized.coveredCandidates}}} as BuildWordCardAuditOptions;
}
const peerCorrectedSource=optionsFor(correctedSeedSource.snapshot,[{...correctedSeedDraft,relatedCandidates:[...correctedSeedDraft.relatedCandidates,{german:"Der Baum",spanish:"el árbol",reason:"split_existing_sense: same tree meaning from a separate controlled proposal"}]}]);
const peerCorrectedOptions=finalizeCorrectedFixture(peerCorrectedSource);
assert.equal(peerCorrectedOptions.additions!.map.candidates.length,2);
const lowerPeer=[...peerCorrectedOptions.additions!.map.candidates].sort((a,b)=>a.candidateId.localeCompare(b.candidateId))[0].candidateId;
const peerCorrectionProof=finalProofFor(peerCorrectedOptions,input=>({candidateId:input.candidateId,intention:"preserved",decision:input.candidateId===lowerPeer?"missing":"covered",coveredByIDs:[],coveredByCandidateIds:input.candidateId===lowerPeer?[]:[lowerPeer],reason:"Controlled fixture: same tree head, gender, plural, meaning and both example languages; one lower representative."}));
assert.equal(peerCorrectionProof.decisions.totalScope,2,"unchanged canonical-front peers are included in the correction review");
const peerCorrectedResult=buildWordCardAudit({...peerCorrectedOptions,finalCandidateProof:peerCorrectionProof});
assert.equal(peerCorrectedResult.manifest.inserts.filter(insert=>insert.collection==="WORDS_ES_DE").length,1,"final-front aliases do not create duplicate pairs");
assert.ok(peerCorrectedResult.report.additions.some((item:any)=>item.status==="covered_by_final_canonical_candidate"));
assert.ok(!peerCorrectedResult.reviewQueue.items.some(item=>["missing_split_companion","related_candidate_pending"].includes(item.kind)),"both frozen intentions resolve to the included final representative");
const mirrorDE=word("mirror-case-fixture","widerspiegeln"),mirrorES=word("mirror-case-fixture-es","reflejar"),mirrorRelation=relation("mirror-case-fixture-rel",mirrorDE,mirrorES);
const transitiveMirror:WordCardVariant={german:"etwas widerspiegeln",category:"VERB",forms:forms({perfect:"hat widergespiegelt",past:"es spiegelte wider",gramaticalCase:"Akkusativ"}),notes:"hat widergespiegelt\nes spiegelte wider",examples:["Der Roman spiegelt die Verhältnisse wider.","Seine Augen spiegelten seine Freude wider."],confidence:"high",reviewReason:""};
const mirrorDraft=draft(mirrorDE,transitiveMirror,[{relation:mirrorRelation,spanish:"algo reflejar",examples:["La novela refleja las circunstancias.","Sus ojos reflejaban su alegría."],variant:transitiveMirror}]);
mirrorDraft.issues=["split_requires_companion_card: controlled fixture preserves reflexive manifestation too"];
mirrorDraft.relatedCandidates=[
  {german:"sich in einem Werk widerspiegeln",spanish:"en una obra reflejarse",reason:"split_existing_sense: controlled manifestation construction with a case-visible example noun"},
  {german:"sich in einem Text widerspiegeln",spanish:"en un texto reflejarse",reason:"split_existing_sense: controlled same manifestation construction with another case-visible example noun"},
];
const mirrorOptions=finalizeCorrectedFixture(optionsFor({auditedAt:now,collections:{WORDS_DE:[mirrorDE],WORDS_ES:[mirrorES],WORDS_ES_DE:[mirrorRelation],userprogresses:[]}},[mirrorDraft]),candidate=>({variant:{german:candidate.german,category:"VERB",forms:forms({perfect:"hat sich widergespiegelt",past:"es spiegelte sich wider",gramaticalCase:"reflexive:Akkusativ; in + Dativ"}),notes:"hat sich widergespiegelt\nes spiegelte sich wider",examples:[candidate.german.includes("Werk")?"Das Erlebnis spiegelt sich in ihrem Werk wider.":"Das Erlebnis spiegelt sich in ihrem Text wider.","Seine Sorgen spiegelten sich in seinem Werk wider."],confidence:"high",reviewReason:""},spanishExamples:[candidate.german.includes("Werk")?"La experiencia se refleja en su obra.":"La experiencia se refleja en su texto.","Sus preocupaciones se reflejaban en su obra."]}));
const mirrorFrozenBytes=JSON.stringify({review:mirrorOptions.review,additions:mirrorOptions.additions});
const mirrorLower=[...mirrorOptions.additions!.map.candidates].sort((a,b)=>a.candidateId.localeCompare(b.candidateId))[0].candidateId;
const mirrorProof=finalProofFor(mirrorOptions,input=>({candidateId:input.candidateId,intention:"preserved",decision:input.candidateId===mirrorLower?"missing":"covered",coveredByIDs:[],coveredByCandidateIds:input.candidateId===mirrorLower?[]:[mirrorLower],reason:"Controlled actual-third fixture: both examples express reflexive manifestation, while Werk/Text only illustrates the same in+Dativ complement."}));
assert.equal(mirrorProof.decisions.totalScope,2,"Both otherwise unchanged case-example cards must enter the third-review scope");
const mirrorResult=buildWordCardAudit({...mirrorOptions,finalCandidateProof:mirrorProof});
assert.equal(mirrorResult.manifest.inserts.filter(insert=>insert.collection==="WORDS_ES_DE").length,1,"Actual approved illustrative-noun duplicates create only one pair");
assert.ok(!mirrorResult.reviewQueue.items.some(item=>["missing_split_companion","related_candidate_pending"].includes(item.kind)),"Both original requests resolve to the included representative");
assert.equal(JSON.stringify({review:mirrorOptions.review,additions:mirrorOptions.additions}),mirrorFrozenBytes,"Compiling aliases never edits frozen seeds or lexical review contents");
const badMirrorProof=structuredClone(mirrorProof);
badMirrorProof.decisions.entries.find(row=>row.candidateId!==mirrorLower)!.coveredByCandidateIds=[id("invented-final-case-alias").toHexString()];
assert.throws(()=>buildWordCardAudit({...mirrorOptions,finalCandidateProof:badMirrorProof}),/provided lower/);
const existingTreeDE=word("existing-tree","Baum"),existingTreeES=word("existing-tree-es","árbol"),existingTreeRelation=relation("existing-tree-rel",existingTreeDE,existingTreeES);
const existingTreeDraft=draft(existingTreeDE,correctedSeedVariant,[{relation:existingTreeRelation,spanish:"el árbol",examples:["El árbol está en el jardín.","Plantamos un árbol."],variant:correctedSeedVariant}]);
const existingCorrectionSource=optionsFor({auditedAt:now,collections:{WORDS_DE:[deHouse,existingTreeDE],WORDS_ES:[esShared,existingTreeES],WORDS_ES_DE:[rHouse,existingTreeRelation],userprogresses:[]}},[correctedSeedDraft,existingTreeDraft]);
const existingCorrectionOptions=finalizeCorrectedFixture(existingCorrectionSource);
const existingCorrectionProof=finalProofFor(existingCorrectionOptions,input=>({candidateId:input.candidateId,intention:"preserved",decision:"covered",coveredByIDs:[existingTreeRelation._id.toHexString()],coveredByCandidateIds:[],reason:"Controlled fixture: canonical same-meaning tree is already a ready relation."}));
const existingCorrectionResult=buildWordCardAudit({...existingCorrectionOptions,finalCandidateProof:existingCorrectionProof});
assert.equal(existingCorrectionResult.manifest.inserts.length,0,"the corrected front's existing semantic duplicate prevents insertion");
assert.ok(existingCorrectionResult.report.additions.some((item:any)=>item.status==="covered_by_validated_semantic_existing_relation"));
assert.ok(!existingCorrectionResult.reviewQueue.items.some(item=>["missing_split_companion","related_candidate_pending"].includes(item.kind)));
assert.throws(()=>buildWordCardAudit({...existingCorrectionOptions,finalCandidateProof:{...existingCorrectionProof,decisions:{...existingCorrectionProof.decisions,entries:existingCorrectionProof.decisions.entries.map(row=>({...row,coveredByIDs:[rHouse._id.toHexString()]}))}}}),/provided ready exact canonical front/);
const blockedTreeProgress=progress("blocked-tree-progress",existingTreeRelation,"DE_ES"); blockedTreeProgress.card.acceptedAnswers=["árbol","planta"];
const blockedExistingCorrectionOptions=finalizeCorrectedFixture(optionsFor({...existingCorrectionSource.snapshot,collections:{...existingCorrectionSource.snapshot.collections,userprogresses:[blockedTreeProgress]}},existingCorrectionSource.review.entries));
const blockedExistingCorrectionProof=finalProofFor(blockedExistingCorrectionOptions,input=>({candidateId:input.candidateId,intention:"preserved",decision:"covered",coveredByIDs:[existingTreeRelation._id.toHexString()],coveredByCandidateIds:[],reason:"Controlled fixture: lexical duplicate exists but its old answer alternatives remain unresolved."}));
const blockedExistingCorrectionResult=buildWordCardAudit({...blockedExistingCorrectionOptions,finalCandidateProof:blockedExistingCorrectionProof});
assert.ok(blockedExistingCorrectionResult.reviewQueue.items.some(item=>item.kind==="candidate_existing_coverage_deferred"));
assert.ok(blockedExistingCorrectionResult.reviewQueue.items.some(item=>item.kind==="missing_split_companion"));
assert.ok(!blockedExistingCorrectionResult.manifest.patches.some(patch=>patch.collection==="WORDS_ES_DE"&&patch.id===rHouse._id.toHexString()),"a lexical final approval does not bypass downstream source eligibility");

// Reviewed answer alternatives retain valid synonyms and discard mixed constructions.
const multipleSnapshot = { ...snapshot, collections: { ...snapshot.collections, userprogresses: snapshot.collections.userprogresses.map(p => p._id.equals(pProduction._id) ? { ...p, card: { ...p.card, acceptedAnswers: ["fahren", "ein Auto fahren"] } } : p._id.equals(pRecognition._id) ? { ...p, card: { ...p.card, acceptedAnswers: ["ir", "desplazarse", "conducir"] } } : p) } };
const multipleOptions = optionsFor(multipleSnapshot, entries), answerInputs = buildAnswerReviewInputs(multipleOptions.snapshot, multipleOptions.review);
const answered = { version: 1, stage: "word_card_answer_review", helperVersion: ANSWER_REVIEW_VERSION, sourceHash: multipleOptions.snapshotSHA256, reviewHash: multipleOptions.reviewSHA256, inputsHash: wordCardSHA256(JSON.stringify(answerInputs.inputs)), promptHash: ANSWER_REVIEW_PROMPT_HASH, model: ANSWER_REVIEW_MODEL, coverage: answerInputs.coverage, selected: answerInputs.inputs.length, completed: answerInputs.inputs.length, pending: 0, auditedAt: now.toISOString(), excludedGroups: answerInputs.excludedGroups, entries: answerInputs.inputs.map(input => ({ id: input.id, retainedAnswers: input.direction === "DE_ES" ? ["ir", "desplazarse"] : ["fahren"], reason: "Retain same-sense choices; remove driving construction", confidence: "high", reviewReason: "" })) };
const answersResult = buildWordCardAudit({ ...multipleOptions, answerReview: answered });
assert.deepEqual(answersResult.manifest.patches.find(patch => patch.id === pRecognition._id.toHexString())?.set["card.acceptedAnswers"], ["ir", "desplazarse"]);
assert.deepEqual(answersResult.manifest.patches.find(patch => patch.id === pProduction._id.toHexString())?.set["card.acceptedAnswers"], ["fahren"]);
const noAnswers = buildWordCardAudit(multipleOptions); assert.ok(noAnswers.reviewQueue.items.some(item => item.kind === "answer_review_required")); assert.ok(!noAnswers.manifest.patches.some(patch => [rMove._id, rDrive._id, pProduction._id, pRecognition._id].some(value => patch.id === value.toHexString())));
const uncertainAnswers = { ...answered, entries: answered.entries.map((entry, index) => index ? entry : { ...entry, confidence: "needs_review", reviewReason: "Alternative meaning needs checking" }) };
assert.ok(buildWordCardAudit({ ...multipleOptions, answerReview: uncertainAnswers }).reviewQueue.items.some(item => item.kind === "answer_review_required"));
assert.throws(() => buildWordCardAudit({ ...multipleOptions, answerReview: { ...answered, reviewHash: "f".repeat(64) } }), /provenance/);
assert.throws(() => buildWordCardAudit({ ...multipleOptions, answerReview: { ...answered, entries: answered.entries.slice(1) } }), /every exact grouped/);
const formalCard = progress("formal-recognition", rHouse, "DE_ES");
const formalOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [deHouse], WORDS_ES: [esShared], WORDS_ES_DE: [rHouse], userprogresses: [formalCard] } }, [draft(deHouse, house, [{ relation: rHouse, spanish: "la vivienda (formal)", examples: ["La vivienda es grande.", "Vivo en una vivienda."], variant: house }])]);
const formalResult = buildWordCardAudit(formalOptions);
assert.equal(formalResult.manifest.patches.find(patch => patch.id === formalCard._id.toHexString())?.set["card.answer"], "la vivienda (formal)");
assert.deepEqual(formalResult.manifest.patches.find(patch => patch.id === formalCard._id.toHexString())?.set["card.acceptedAnswers"], ["la vivienda"], "display annotations are not required typed answer text");
const stableCardProgress: Document = { ...pRecognition, card: { ...pRecognition.card, prompt: "fahren", answer: "ir", acceptedAnswers: ["ir"], notes: "outdated note", examples: movement.examples.map((example, index) => `${example} (${driveDraft.translations.find(translation => translation.relationId === rMove._id.toHexString())!.examples[index]})`) } };
const stableCardOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [deDrive], WORDS_ES: [esMove, esDrive], WORDS_ES_DE: [rMove, rDrive], userprogresses: [stableCardProgress] } }, [driveDraft]);
assert.deepEqual(Object.keys(buildWordCardAudit(stableCardOptions).manifest.patches.find(patch => patch.id === pRecognition._id.toHexString())!.set).sort(), ["card.acceptedAnswers", "card.answer", "card.examples", "card.notes", "card.prompt"], "any card-content revision atomically checks all five lexical fields, including unchanged reviewed alternatives");

// Key order and Int32/Date EJSON representation must not invent a study-content change.
const stableES = { ...esMove, examples: ["Voy a Berlín.", "Fuimos a casa."], notes: "" };
const stableStudy = { auditedAt: now, category: movement.category, forms: movement.forms, germanExamples: movement.examples, spanishExamples: stableES.examples, examples: movement.examples.map((example, index) => `${example} (${stableES.examples[index]})`), notes: movement.notes, spanish: "ir", german: "fahren", version: new BSON.Int32(1) };
const stableRelation = { ...rMove, study: stableStudy };
const stableOptions = optionsFor({ auditedAt: now, collections: { WORDS_DE: [deDrive], WORDS_ES: [stableES], WORDS_ES_DE: [stableRelation], userprogresses: [] } }, [draft(deDrive, movement, [{ relation: stableRelation, spanish: "ir", examples: stableES.examples, variant: movement }])]);
const stable = buildWordCardAudit(stableOptions);
assert.equal(stable.manifest.patches.find(patch => patch.collection === "WORDS_ES_DE")?.set.study, undefined);

// Reserved Spanish endpoints belonging to unresolved entries must remain untouched.
const reservedSnapshot = { ...snapshot, collections: { ...snapshot.collections, WORDS_ES_DE: [...snapshot.collections.WORDS_ES_DE.map(rel => rel._id.equals(rUncertain._id) ? { ...rel, main: esShared._id } : rel)] } };
const reserved = buildWordCardAudit(optionsFor(reservedSnapshot, entries));
assert.deepEqual(reserved.manifest.patches.find(patch => patch.collection === "WORDS_ES" && patch.id === esShared._id.toHexString())?.set, { notes: "" });
assert.equal(reserved.manifest.inserts.filter(insert => insert.collection === "WORDS_ES").length, 2, "reviewed relations must clone instead of changing an unresolved relation's shared examples");

const directory = await mkdtemp(join(tmpdir(), "build-word-card-audit-"));
try {
  const runCLI = async (args: string[]) => {
    const child = spawn(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/buildWordCardAudit.ts", ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk.toString(); }); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const [code] = await once(child, "exit"); return { code, stdout, stderr };
  };
  const snapshotPath = join(directory, "before.ejson"), reviewPath = join(directory, "review.json"), output = join(directory, "manifest.ejson");
  await writeFile(snapshotPath, serializeWordCardEjson(snapshot), { mode: 0o600 }); await writeFile(reviewPath, JSON.stringify(options.review), { mode: 0o600 });
  let cli = await runCLI(["--snapshot", snapshotPath, "--review", reviewPath, "--output", output]); assert.equal(cli.code, 0); assert.equal(cli.stderr, ""); assert.equal(JSON.parse(cli.stdout).sourceVerified, false);
  for (const path of [output, `${output}.report.json`, `${output}.review-queue.json`]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const manifest = BSON.EJSON.parse(await readFile(output, "utf8"), { relaxed: false }); validateWordCardManifest(manifest); assert.ok(sameWordCardBson(manifest, result.manifest));
  cli = await runCLI(["--snapshot", snapshotPath, "--review", reviewPath, "--output", snapshotPath]); assert.equal(cli.code, 1); assert.match(cli.stderr, /overwrite/); assert.equal(wordCardSHA256(await readFile(snapshotPath)), options.snapshotSHA256);
  const aliasSnapshotPath = join(directory, "alias-before.ejson"), aliasReviewPath = join(directory, "alias-review.json"), repSnapshotPath = join(directory, "candidate-before.ejson"), repReviewPath = join(directory, "candidate-review.json"), mapPath = join(directory, "candidates.json"), decisionsPath = join(directory, "decisions.json"), aliasOutput = join(directory, "alias-manifest.ejson");
  for (const [path, text] of [[aliasSnapshotPath, serializeWordCardEjson(aliasOptions.snapshot)], [aliasReviewPath, JSON.stringify(aliasOptions.review)], [repSnapshotPath, serializeWordCardEjson(repOptions.snapshot)], [repReviewPath, JSON.stringify(repOptions.review)], [mapPath, JSON.stringify(aliasAdditions.map)], [decisionsPath, JSON.stringify(aliasProof.decisions)], [join(directory, "inputs.json"), JSON.stringify(aliasProof.inputs)], [join(directory, "ambiguous-candidates.json"), JSON.stringify(ambiguity)]]) await writeFile(path, text, { mode: 0o600 });
  cli = await runCLI(["--snapshot", aliasSnapshotPath, "--review", aliasReviewPath, "--output", aliasOutput, "--additions-snapshot", repSnapshotPath, "--additions-review", repReviewPath, "--additions-map", mapPath, "--candidate-decisions", decisionsPath]); assert.equal(cli.code, 0, cli.stderr); assert.ok(sameWordCardBson(BSON.EJSON.parse(await readFile(aliasOutput, "utf8"), { relaxed: false }), aliasResult.manifest));
  const finalSnapshotPath = join(directory, "final-candidate-before.ejson"), finalReviewPath = join(directory, "final-candidate-review.json"), finalMapPath = join(directory, "final-candidates.json"), finalOutput = join(directory, "final-manifest.ejson");
  for (const [path, text] of [[finalSnapshotPath, finalizedAliases.candidateSnapshotText], [finalReviewPath, JSON.stringify(finalizedAliasOptions.additions!.review)], [finalMapPath, JSON.stringify(finalizedAliasOptions.additions!.map)]]) await writeFile(path, text, { mode: 0o600 });
  const finalDecisionPath=join(directory,"final-coverage.json"),finalProvenancePath=join(directory,"final-provenance.json");
  await writeFile(finalDecisionPath,JSON.stringify(finalizedAliasOptions.finalCandidateProof!.decisions),{mode:0o600});
  await writeFile(finalProvenancePath,JSON.stringify(finalizedAliasOptions.finalCandidateProof!.provenance),{mode:0o600});
  const finalArgs = ["--snapshot", aliasSnapshotPath, "--review", aliasReviewPath, "--output", finalOutput, "--additions-snapshot", finalSnapshotPath, "--additions-review", finalReviewPath, "--additions-map", finalMapPath, "--candidate-decisions", decisionsPath,"--final-candidate-decisions",finalDecisionPath,"--candidate-provenance",finalProvenancePath];
  cli = await runCLI(finalArgs); assert.equal(cli.code, 0, cli.stderr); assert.ok(sameWordCardBson(BSON.EJSON.parse(await readFile(finalOutput, "utf8"), { relaxed: false }), finalizedAliasResult.manifest));
  const originalFinalManifest = await readFile(finalOutput, "utf8");
  cli = await runCLI(finalArgs.slice(0,-4)); assert.equal(cli.code,1); assert.match(cli.stderr,/canonical coverage proof/); assert.equal(await readFile(finalOutput,"utf8"),originalFinalManifest,"Omitting required final coverage cannot replace an existing reviewed output");
  await writeFile(join(directory, "inputs.json"), finalizedAliasFiles.decisionInputsText + "\n", { mode: 0o600 });
  cli = await runCLI(finalArgs); assert.equal(cli.code, 1); assert.match(cli.stderr, /Finalized addition mapping/); assert.equal(await readFile(finalOutput, "utf8"), originalFinalManifest, "even semantically identical proof whitespace changes invalidate a byte-bound finalized artifact before output");
  const correctionDirectory=join(directory,"correction"); await mkdir(correctionDirectory,{mode:0o700});
  const correctionFiles={before:serializeWordCardEjson(correctedSeedOptions.snapshot),review:JSON.stringify(correctedSeedOptions.review),candidate:correctedSeedFinalized.candidateSnapshotText,additionReview:JSON.stringify(correctedSeedOptions.additions!.review),map:JSON.stringify(correctedSeedOptions.additions!.map),dedup:correctedSeedFiles.decisionsText,inputs:correctedSeedFiles.decisionInputsText,ambiguities:correctedSeedFiles.ambiguousText,provenance:JSON.stringify(correctedSeedApproval.provenance),final:JSON.stringify(correctedSeedApproval.decisions)};
  for (const [name,text] of Object.entries(correctionFiles)) await writeFile(join(correctionDirectory,`${name}.json`),text,{mode:0o600});
  const correctionOutput=join(correctionDirectory,"manifest.ejson");
  const correctionArgs=["--snapshot",join(correctionDirectory,"before.json"),"--review",join(correctionDirectory,"review.json"),"--additions-snapshot",join(correctionDirectory,"candidate.json"),"--additions-review",join(correctionDirectory,"additionReview.json"),"--additions-map",join(correctionDirectory,"map.json"),"--candidate-decisions",join(correctionDirectory,"dedup.json"),"--candidate-ambiguities",join(correctionDirectory,"ambiguities.json"),"--final-candidate-decisions",join(correctionDirectory,"final.json"),"--candidate-provenance",join(correctionDirectory,"provenance.json"),"--output",correctionOutput];
  cli=await runCLI(correctionArgs); assert.equal(cli.code,0,cli.stderr);
  assert.ok(sameWordCardBson(BSON.EJSON.parse(await readFile(correctionOutput,"utf8"),{relaxed:false}),correctedSeedResult.manifest));
  assert.equal((await stat(correctionOutput)).mode&0o777,0o600);
  const originalCorrectionOutput=await readFile(correctionOutput,"utf8");
  await writeFile(join(correctionDirectory,"additionReview.json"),correctionFiles.additionReview+"\n",{mode:0o600});
  cli=await runCLI(correctionArgs); assert.equal(cli.code,1); assert.equal(await readFile(correctionOutput,"utf8"),originalCorrectionOutput,"exact final approval rejects review-byte changes before writing output");
  const multiSnapshotPath = join(directory, "multiple-before.ejson"), multiReviewPath = join(directory, "multiple-review.json"), answerPath = join(directory, "answers.json"), answersOutput = join(directory, "answers-manifest.ejson");
  for (const [path, text] of [[multiSnapshotPath, serializeWordCardEjson(multipleOptions.snapshot)], [multiReviewPath, JSON.stringify(multipleOptions.review)], [answerPath, JSON.stringify(answered)]]) await writeFile(path, text, { mode: 0o600 });
  cli = await runCLI(["--snapshot", multiSnapshotPath, "--review", multiReviewPath, "--output", answersOutput, "--answer-review", answerPath]); assert.equal(cli.code, 0, cli.stderr); assert.ok(sameWordCardBson(BSON.EJSON.parse(await readFile(answersOutput, "utf8"), { relaxed: false }), answersResult.manifest));
  console.log("Offline word-card manifest tests passed: paired clones, source guards, protected study state, generic cleanup, intention-bound homographs/aliases, exact finalizer handoff, retained synonym review/deferral, idioms/cardinal guards, complete coverage and private CLI output.");
} finally { await rm(directory, { recursive: true, force: true }); }
