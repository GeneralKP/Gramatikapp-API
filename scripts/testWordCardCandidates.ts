import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSON, ObjectId } from "mongodb";
import { CEFR_LEVELS } from "../src/features/levels/levels.js";
import { WORD_CARD_PROMPT_VERSION } from "./lib/wordCardPrompt.js";
import type { WordCardManifest } from "./lib/wordCardMigration.js";
import { prepareWordCardAdditions, type ReviewedAggregate } from "./prepareWordCardAdditions.js";
import { CANDIDATE_HELPER_MODEL, EXPECTED_CATALOG_REVIEW_HASH, applyInsertionClassifications, buildCandidateReviewInputs, buildInsertionClassificationInputs, cefrBand, permitsConstructionCoverage, permitsRequestedSenseCoverage, validateCandidateAliases, validateCandidateDecisions, validateInsertionClassifications, writeCandidatePrivate, type CandidateDecision, type CandidateReviewInput, type CandidateRequestedSense } from "./reviewWordCardCandidates.js";

const hex = (number: number) => number.toString(16).padStart(24, "0");
const oid = (number: number) => new ObjectId(hex(number));
const now = new Date("2026-10-08T01:00:00.000Z");
const clone = <T>(value: T): T => structuredClone(value);
const forms = { gender: "der", plural: "Die Kiefer", perfect: "", past: "", imperativ: "", gramaticalCase: "", irregularConjugations: "" };
const intention = (senseKey: string, reason: string, evidence: Record<string, string> = {}): CandidateRequestedSense => ({ senseKey, reasons: [reason], forms: { gender: "", plural: "", perfect: "", past: "", imperativ: "", gramaticalCase: "", irregularConjugations: "", ...evidence }, notes: "", examples: [] });
const reviewed = (id: number, relationId: number, german: string, spanish: string, gender = "der") => ({ id: hex(id), german, category: "NOUN", forms: { ...forms, gender }, notes: "Die Kiefer", examples: ["Der Kiefer tut weh.", "Der Kiefer ist gebrochen."], translations: [{ relationId: hex(relationId), spanish, examples: ["Me duele la mandíbula.", "La mandíbula está rota."], variant: { german, category: "NOUN", forms: { ...forms, gender }, notes: "Die Kiefer", examples: ["Der Kiefer tut weh.", "Der Kiefer ist gebrochen."], confidence: "high", reviewReason: "" } }], issues: [], confidence: "high", reviewReason: "", studyEligible: true, relatedCandidates: [], userId: "private-owner", progressId: "private-progress" });
const review = { version: 1, stage: "independent_review", promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: EXPECTED_CATALOG_REVIEW_HASH, sourceHash: "a".repeat(64), offset: 0, selected: 1, completed: 1, pending: 0, entries: [reviewed(1, 2, "Der Kiefer", "la mandíbula")] };
const candidate = { candidateId: hex(10), german: "Der Kiefer", spanish: "la quijada", senseKey: "related:modern synonymous spanish cue", requestedSense: intention("related:modern synonymous spanish cue", "Modern synonymous Spanish cue"), reasons: ["Modern synonymous Spanish cue"], potentialMatchingStudyBackSenses: [{ wordId: hex(1), relationId: hex(2), german: "Der Kiefer", spanish: "la mandíbula", ready: true }], alternativeCandidateSenses: [], userId: "private-owner", sourceWordIds: ["private-source"], sourceRelationIds: ["private-source-relation"], relatedFrom: [{ userId: "private-owner" }] };
const ambiguous = { version: 1, stage: "offline_addition_candidates", sourceHash: review.sourceHash, reviewPromptHash: review.promptHash, partial: false, ambiguousCandidates: [candidate] };
const inputs = buildCandidateReviewInputs(ambiguous, review, 1);
assert.equal(inputs[0].potentialMatches[0].relationId, hex(2));
assert.ok(!JSON.stringify(inputs).includes("private-"), "Only whitelisted lexical fields cross the provider boundary");
assert.throws(() => buildCandidateReviewInputs(ambiguous, review), /Complete reviewed/);
assert.throws(() => buildCandidateReviewInputs({ ...ambiguous, sourceHash: "b".repeat(64) }, review, 1), /source scope/);
assert.throws(() => buildCandidateReviewInputs({ ...ambiguous, partial: true }, review, 1), /source scope/);
const wrongMatch = clone(ambiguous); wrongMatch.ambiguousCandidates[0].potentialMatchingStudyBackSenses[0].relationId = hex(999);
assert.throws(() => buildCandidateReviewInputs(wrongMatch, review, 1), /provided existing/);
const alteredMatch = clone(ambiguous); alteredMatch.ambiguousCandidates[0].potentialMatchingStudyBackSenses[0].spanish = "el pino";
assert.throws(() => buildCandidateReviewInputs(alteredMatch, review, 1), /differs/);
const idiomReview = clone(review); idiomReview.entries[0].category = "UNKNOWN"; idiomReview.entries[0].notes = "Redewendung"; idiomReview.entries[0].translations[0].variant.category = "UNKNOWN"; idiomReview.entries[0].translations[0].variant.notes = "Redewendung";
assert.equal(buildCandidateReviewInputs(ambiguous, idiomReview, 1)[0].potentialMatches[0].ready, true, "High-confidence explicitly marked idioms remain legitimate existing coverage");
idiomReview.entries[0].notes = "";
assert.equal(buildCandidateReviewInputs(ambiguous, idiomReview, 1)[0].potentialMatches[0].ready, false, "Unannotated unknown categories remain deferred");

const numeralReview = clone(review);
const emptyForms = intention("", "").forms;
Object.assign(numeralReview.entries[0], { german: "zwei", category: "UNKNOWN", notes: "", forms: { ...emptyForms } });
Object.assign(numeralReview.entries[0].translations[0], { spanish: "dos" });
Object.assign(numeralReview.entries[0].translations[0].variant, { german: "zwei", category: "UNKNOWN", notes: "", forms: { ...emptyForms } });
const numeralAmbiguity = clone(ambiguous);
Object.assign(numeralAmbiguity.ambiguousCandidates[0], { german: "zwei", spanish: "dos" });
Object.assign(numeralAmbiguity.ambiguousCandidates[0].potentialMatchingStudyBackSenses[0], { german: "zwei", spanish: "dos" });
const numeralInputs = buildCandidateReviewInputs(numeralAmbiguity, numeralReview, 1);
assert.equal(numeralInputs[0].potentialMatches[0].ready, true, "Source-checked cardinal coverage uses the shared readiness policy");
const numeralCovered: CandidateDecision = { candidateId: hex(10), decision: "covered", coveredByIDs: [hex(2)], coveredByCandidateIds: [], reason: "The existing reviewed cardinal zwei means dos." };
assert.deepEqual(validateCandidateDecisions({ entries: [numeralCovered] }, numeralInputs), [numeralCovered]);

const probabilityReview = clone(numeralReview);
probabilityReview.entries[0].german = "wohl";
Object.assign(probabilityReview.entries[0].translations[0], { spanish: "probablemente" });
probabilityReview.entries[0].translations[0].variant.german = "wohl";
const probabilityAmbiguity = clone(numeralAmbiguity);
Object.assign(probabilityAmbiguity.ambiguousCandidates[0], { german: "wohl", spanish: "probablemente" });
Object.assign(probabilityAmbiguity.ambiguousCandidates[0].potentialMatchingStudyBackSenses[0], { german: "wohl", spanish: "probablemente" });
const probabilityInputs = buildCandidateReviewInputs(probabilityAmbiguity, probabilityReview, 1);
assert.equal(probabilityInputs[0].potentialMatches[0].ready, true, "Semantic coverage receives the actual probability cue for each variant");
const probabilityCovered = { ...numeralCovered, reason: "The provided high reviewed particle already expresses this probability meaning." };
assert.deepEqual(validateCandidateDecisions({ entries: [probabilityCovered] }, probabilityInputs), [probabilityCovered]);
const unknownWellReview = clone(probabilityReview), unknownWellAmbiguity = clone(probabilityAmbiguity);
unknownWellReview.entries[0].translations[0].spanish = "bien";
unknownWellAmbiguity.ambiguousCandidates[0].potentialMatchingStudyBackSenses[0].spanish = "bien";
const unknownWellInputs = buildCandidateReviewInputs(unknownWellAmbiguity, unknownWellReview, 1);
assert.equal(unknownWellInputs[0].potentialMatches[0].ready, false, "A different wohl meaning cannot inherit probability readiness");
assert.throws(() => validateCandidateDecisions({ entries: [probabilityCovered] }, unknownWellInputs), /ready/);
const emphaticReview = clone(probabilityReview), emphaticAmbiguity = clone(probabilityAmbiguity);
emphaticReview.entries[0].german = "bloß";
Object.assign(emphaticReview.entries[0].translations[0], { spanish: "pero" });
emphaticReview.entries[0].translations[0].variant.german = "bloß";
Object.assign(emphaticAmbiguity.ambiguousCandidates[0], { german: "bloß", spanish: "pero" });
Object.assign(emphaticAmbiguity.ambiguousCandidates[0].potentialMatchingStudyBackSenses[0], { german: "bloß", spanish: "pero" });
const emphaticInputs = buildCandidateReviewInputs(emphaticAmbiguity, emphaticReview, 1);
assert.equal(emphaticInputs[0].potentialMatches[0].ready, true);
assert.deepEqual(validateCandidateDecisions({ entries: [probabilityCovered] }, emphaticInputs), [probabilityCovered]);
for (const invalidate of [
  (entry: any) => { entry.studyEligible = false; },
  (entry: any) => { entry.confidence = "needs_review"; },
  (entry: any) => { entry.translations[0].variant.confidence = "needs_review"; },
  (entry: any) => { delete entry.translations[0].variant.forms.gender; },
  (entry: any) => { entry.forms.perfect = "hat gezählt"; },
]) {
  const unreadyNumeralReview = clone(numeralReview); invalidate(unreadyNumeralReview.entries[0]);
  const unreadyNumeralInputs = buildCandidateReviewInputs(numeralAmbiguity, unreadyNumeralReview, 1);
  assert.equal(unreadyNumeralInputs[0].potentialMatches[0].ready, false, "Cardinal readiness never bypasses confidence, eligibility or actual empty-form evidence");
  assert.throws(() => validateCandidateDecisions({ entries: [numeralCovered] }, unreadyNumeralInputs), /ready/);
}

const covered: CandidateDecision = { candidateId: hex(10), decision: "covered", coveredByIDs: [hex(2)], coveredByCandidateIds: [], reason: "Quijada and mandíbula name the same jaw sense." };
assert.deepEqual(validateCandidateDecisions({ entries: [covered] }, inputs), [covered]);
assert.throws(() => validateCandidateDecisions({ entries: [] }, inputs), /every exact/);
assert.throws(() => validateCandidateDecisions({ entries: [{ ...covered, candidateId: hex(99) }] }, inputs), /identity/);
assert.throws(() => validateCandidateDecisions({ entries: [{ ...covered, coveredByIDs: [hex(1)] }] }, inputs), /provided existing relation/);
assert.throws(() => validateCandidateDecisions({ entries: [{ ...covered, coveredByIDs: [hex(2), hex(2)] }] }, inputs), /Duplicate/);
assert.throws(() => validateCandidateDecisions({ entries: [{ ...covered, decision: "missing" }] }, inputs), /agree/);
assert.throws(() => validateCandidateDecisions({ entries: [{ ...covered, userId: "private-owner" }] }, inputs), /fields/);
const unready = clone(inputs); unready[0].potentialMatches[0].ready = false;
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, unready), /ready/);
const otherGender = clone(inputs); otherGender[0].potentialMatches[0].german = "Die Kiefer";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, otherGender), /construction identity/);
assert.equal(permitsConstructionCoverage({ german: "Die Häuser" }, { german: "Das Haus" }), false, "A plural study identity is not silently merged into its singular");
assert.equal(permitsConstructionCoverage({ german: "mir" }, { german: "mich" }), false, "Dative and accusative pronouns remain separate");
assert.equal(permitsConstructionCoverage({ german: "sich etwas vorstellen" }, { german: "sich vorstellen" }), false);
assert.equal(permitsConstructionCoverage({ german: "jemandem vertrauen" }, { german: "jemanden vertrauen" }), false);
assert.equal(permitsConstructionCoverage({ german: "etwas waschen" }, { german: "sich waschen" }), false);
assert.equal(permitsConstructionCoverage({ german: "jemandem helfen" }, { german: "jemandem beistehen" }), false, "A separate German lexical construction is not covered merely by a broad shared translation");

// Same dative similarity construction: internal case prose is not another sense.
const similarInput = clone(inputs[0]);
Object.assign(similarInput, { german: "ähnlich", spanish: "parecido", requestedSense: intention("reviewed:similar", "Same dative similarity sense", { gramaticalCase: "Dativ" }), alternativeCandidates: [] });
Object.assign(similarInput.potentialMatches[0], { german: "ähnlich", spanish: "parecido", category: "ADJECTIVE", forms: { ...emptyForms, gramaticalCase: "Dativ in jemandem ähnlich" }, notes: "Komparativ: ähnlicher, am ähnlichsten", examples: ["Sie sehen sich ähnlich.", "Das ist ähnlich wie gestern."], spanishExamples: ["Se parecen.", "Eso es parecido a lo de ayer."] });
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [similarInput]), "A case label and its same-case construction explanation permit an actual semantic coverage decision");
const wrongSimilarCase = clone(similarInput); wrongSimilarCase.potentialMatches[0].forms.gramaticalCase = "Akkusativ in jemanden ähnlich";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [wrongSimilarCase]), /explicit requested forms/, "Actual case conflicts remain blocked");
const unrelatedCaseContext = clone(similarInput); unrelatedCaseContext.potentialMatches[0].forms.gramaticalCase = "Dativ in jemandem helfen";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [unrelatedCaseContext]), /explicit requested forms/, "Case prose naming another lexical construction is not normalized");
const wrongCasePronoun = clone(similarInput); wrongCasePronoun.potentialMatches[0].forms.gramaticalCase = "Dativ in jemanden ähnlich";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [wrongCasePronoun]), /explicit requested forms/, "An accusative person pronoun is not treated as a dative-case explanation");
const missingSimilarCase = clone(similarInput); missingSimilarCase.potentialMatches[0].forms.gramaticalCase = "";
assert.equal(permitsRequestedSenseCoverage(similarInput, missingSimilarCase.potentialMatches[0], true), false, "Final coverage still requires explicit requested case evidence");
const influenceInput = clone(inputs[0]);
Object.assign(influenceInput, { german: "Der Einfluss auf", spanish: "la influencia en", requestedSense: intention("reviewed:influence", "Target-directed influence", { gender: "der", plural: "Die Einflüsse", gramaticalCase: "auf + Akkusativ" }), alternativeCandidates: [] });
Object.assign(influenceInput.potentialMatches[0], { german: "Der Einfluss auf", spanish: "la influencia en", forms: { ...forms, plural: "Die Einflüsse", gramaticalCase: "auf: Akkusativ" } });
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [influenceInput]), "Colon and plus case separators preserve the same preposition and case evidence");
const influenceCaseConflict = clone(influenceInput); influenceCaseConflict.potentialMatches[0].forms.gramaticalCase = "auf: Dativ";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [influenceCaseConflict]), /explicit requested forms/);
const influencePrepositionConflict = clone(influenceInput); influencePrepositionConflict.potentialMatches[0].forms.gramaticalCase = "an: Akkusativ";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [influencePrepositionConflict]), /explicit requested forms/);
const explainingInput = clone(similarInput); explainingInput.german = "jemandem etwas erklären"; explainingInput.potentialMatches[0].german = "jemandem etwas erklären"; explainingInput.requestedSense.forms.gramaticalCase = "Dativ; Akkusativ"; explainingInput.potentialMatches[0].forms.gramaticalCase = "Dativ + Akkusativ";
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [explainingInput]), "Two exact ordered case labels separated by semicolon or plus retain both complement cases");
const alternativeExplainingCases = clone(explainingInput); alternativeExplainingCases.potentialMatches[0].forms.gramaticalCase = "Dativ oder Akkusativ";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [alternativeExplainingCases]), /explicit requested forms/);
const wrongExplainingCases = clone(explainingInput); wrongExplainingCases.potentialMatches[0].forms.gramaticalCase = "Dativ + Genitiv";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [wrongExplainingCases]), /explicit requested forms/);

// Actual source-bound optional-e imperative variants must not create duplicate cards.
const rejectInput = clone(inputs[0]);
Object.assign(rejectInput, { german: "etwas ablehnen", spanish: "algo rechazar", requestedSense: intention("reviewed:reject", "Rejecting an offer or proposal", { perfect: "hat abgelehnt", past: "ich lehnte ab", imperativ: "lehn ab!, lehnt ab!", gramaticalCase: "Akkusativ" }), alternativeCandidates: [] });
Object.assign(rejectInput.potentialMatches[0], { german: "etwas ablehnen", spanish: "algo rechazar", category: "VERB", forms: { ...emptyForms, perfect: "hat abgelehnt", past: "ich lehnte ab", imperativ: "lehne ab!, lehnt ab!", gramaticalCase: "Akkusativ" } });
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [rejectInput]), "Source-checked lehn/lehne ab share the same singular imperative for this exact construction");
const wrongRejectParticle = clone(rejectInput); wrongRejectParticle.potentialMatches[0].forms.imperativ = "lehne an!, lehnt an!";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [wrongRejectParticle]), /explicit requested forms/);
const wrongRejectPlural = clone(rejectInput); wrongRejectPlural.potentialMatches[0].forms.imperativ = "lehne ab!, lehnen ab!";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [wrongRejectPlural]), /explicit requested forms/);
const buildInput = clone(rejectInput); buildInput.german = "etwas bauen"; buildInput.requestedSense.forms = { ...emptyForms, perfect: "hat gebaut", past: "ich baute", imperativ: "bau!, baut!", gramaticalCase: "Akkusativ" };
Object.assign(buildInput.potentialMatches[0], { german: "etwas bauen", forms: { ...buildInput.requestedSense.forms, imperativ: "baue!, baut!" } });
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [buildInput]), "Source-checked bau/baue share the same singular imperative for this exact construction");
const unknownOptionalE = clone(rejectInput); unknownOptionalE.german = "etwas wissen"; unknownOptionalE.potentialMatches[0].german = "etwas wissen"; unknownOptionalE.requestedSense.forms.imperativ = "wiss!, wisst!"; unknownOptionalE.potentialMatches[0].forms.imperativ = "wisse!, wisst!";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [unknownOptionalE]), /explicit requested forms/, "No generic optional-e allowance admits unverified verb forms");

const ascertainInput = clone(rejectInput); ascertainInput.german = "etwas feststellen"; ascertainInput.potentialMatches[0].german = "etwas feststellen"; ascertainInput.requestedSense.forms.imperativ = "stelle fest!, stellt fest!"; ascertainInput.potentialMatches[0].forms.imperativ = "stell fest!, stellt fest!";
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [ascertainInput]), "The actual Duden-checked feststellen optional-e pair retains its plural and particle");
const capabilityInput = clone(rejectInput); capabilityInput.german = "etwas tun können"; capabilityInput.potentialMatches[0].german = "etwas tun können"; capabilityInput.requestedSense.forms = { ...emptyForms, perfect: "hat etwas tun können", past: "ich konnte", gramaticalCase: "Akkusativ", irregularConjugations: "du kannst, er kann" }; capabilityInput.potentialMatches[0].forms = { ...capabilityInput.requestedSense.forms, gramaticalCase: "Modalverb + Infinitiv" };
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [capabilityInput]), "Known tun-können object and modal infinitive descriptors concern complementary grammatical layers");
const wrongCapabilityCase = clone(capabilityInput); wrongCapabilityCase.potentialMatches[0].forms.gramaticalCase = "Dativ";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [wrongCapabilityCase]), /explicit requested forms/);
const otherModalConstruction = clone(capabilityInput); otherModalConstruction.german = "jemandem helfen können"; otherModalConstruction.potentialMatches[0].german = "jemandem helfen können";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [otherModalConstruction]), /explicit requested forms/, "The bounded descriptor rule cannot erase another modal construction's actual case");
const possessionInput = clone(rejectInput); possessionInput.german = "etwas haben"; possessionInput.potentialMatches[0].german = "etwas haben"; possessionInput.requestedSense.forms = { ...emptyForms, perfect: "hat gehabt", past: "ich hatte", gramaticalCase: "Akkusativ", irregularConjugations: "du hast, er hat" }; possessionInput.potentialMatches[0].forms = { ...possessionInput.requestedSense.forms, irregularConjugations: "ich habe, du hast, er hat" };
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [possessionInput]), "Additional first-person evidence preserves every explicitly requested irregular person form");
const wrongPossessionPerson = clone(possessionInput); wrongPossessionPerson.potentialMatches[0].forms.irregularConjugations = "ich habe, du hat, er hat";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [wrongPossessionPerson]), /explicit requested forms/);
const conflictingPossessionPerson = clone(possessionInput); conflictingPossessionPerson.potentialMatches[0].forms.irregularConjugations = "ich habe, du hast, du hat, er hat";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [conflictingPossessionPerson]), /explicit requested forms/);
const receivingInput = clone(possessionInput); receivingInput.german = "etwas erhalten"; receivingInput.potentialMatches[0].german = "etwas erhalten"; receivingInput.requestedSense.forms = { ...emptyForms, perfect: "hat erhalten", past: "ich erhielt", gramaticalCase: "Akkusativ", irregularConjugations: "du erhältst, er erhält" }; receivingInput.potentialMatches[0].forms = { ...receivingInput.requestedSense.forms, irregularConjugations: "du erhältst; er erhält" };
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [receivingInput]), "Comma and semicolon separators retain the exact required irregular person forms");
const conflictingReceivingPerson = clone(receivingInput); conflictingReceivingPerson.potentialMatches[0].forms.irregularConjugations = "du erhältst; du erhält; er erhält";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [conflictingReceivingPerson]), /explicit requested forms/);
const knowingInput = clone(receivingInput); knowingInput.german = "etwas wissen"; knowingInput.potentialMatches[0].german = "etwas wissen"; knowingInput.requestedSense.forms = { ...emptyForms, perfect: "hat gewusst", past: "ich wusste", gramaticalCase: "Akkusativ", irregularConjugations: "ich weiß, du weißt, er weiß" }; knowingInput.potentialMatches[0].forms = { ...knowingInput.requestedSense.forms, irregularConjugations: "ich weiß, du weißt, er/sie/es weiß" };
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [knowingInput]), "A slash-group explicitly contains the exact requested singular third-person form");
const conflictingKnowingPerson = clone(knowingInput); conflictingKnowingPerson.potentialMatches[0].forms.irregularConjugations = "ich weiß, du weißt, er/sie/es weiß, er weißt";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [conflictingKnowingPerson]), /explicit requested forms/);
const knowingContentClause = clone(knowingInput); knowingContentClause.potentialMatches[0].forms.gramaticalCase = "Akkusativ; Inhaltssatz";
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [knowingContentClause]), "Wissen's explicit accusative descriptor remains present alongside the documented content-clause complement");
const knowingWrongCase = clone(knowingContentClause); knowingWrongCase.potentialMatches[0].forms.gramaticalCase = "Dativ; Inhaltssatz";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [knowingWrongCase]), /explicit requested forms/);
const otherContentClause = clone(knowingContentClause); otherContentClause.german = "etwas behaupten"; otherContentClause.potentialMatches[0].german = "etwas behaupten";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [otherContentClause]), /explicit requested forms/);
const costingInput = clone(rejectInput); costingInput.german = "Geld kosten"; costingInput.potentialMatches[0].german = "Geld kosten"; costingInput.requestedSense.forms = { ...emptyForms, perfect: "hat gekostet", past: "ich kostete", gramaticalCase: "Akkusativ" }; costingInput.potentialMatches[0].forms = { ...costingInput.requestedSense.forms, gramaticalCase: "Akkusativ des Geldbetrags" };
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [costingInput]), "Exact monetary Geld kosten retains accusative evidence naming its money amount");
const costingWrongCase = clone(costingInput); costingWrongCase.potentialMatches[0].forms.gramaticalCase = "Dativ des Geldbetrags";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [costingWrongCase]), /explicit requested forms/);
const tastingInput = clone(costingInput); tastingInput.german = "etwas kosten"; tastingInput.potentialMatches[0].german = "etwas kosten";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [tastingInput]), /explicit requested forms/);
const achievingInput = clone(rejectInput); achievingInput.german = "etwas schaffen"; achievingInput.potentialMatches[0].german = "etwas schaffen"; achievingInput.requestedSense.forms = { ...emptyForms, perfect: "hat geschafft", past: "ich schaffte", gramaticalCase: "Akkusativ", imperativ: "schaff!, schafft!" }; achievingInput.potentialMatches[0].forms = { ...achievingInput.requestedSense.forms, imperativ: "schaffe!, schafft!" };
assert.doesNotThrow(() => validateCandidateDecisions({ entries: [covered] }, [achievingInput]), "Duden explicitly permits the optional-e singular for weak schaffen");
const creatingInput = clone(achievingInput); creatingInput.potentialMatches[0].forms.perfect = "hat geschaffen"; creatingInput.potentialMatches[0].forms.past = "ich schuf";
assert.throws(() => validateCandidateDecisions({ entries: [covered] }, [creatingInput]), /explicit requested forms/, "Shared imperative alternatives never erase strong/weak schaffen meaning evidence");

const peerEvidence = (number: number) => ({ candidateId: hex(number), german: "Der Kiefer", spanish: number === 20 ? "la mandíbula" : "la quijada", reasons: ["Jaw bone synonymous cue"], requestedSense: intention(`related:jaw:${number}`, "Jaw bone synonymous cue") });
const peers: CandidateReviewInput[] = [20, 21, 22].map(number => ({ ...peerEvidence(number), potentialMatches: [], alternativeCandidates: [20, 21, 22].filter(other => other !== number).map(peerEvidence) }));
const aliases: CandidateDecision[] = peers.map((peer, index) => ({ candidateId: peer.candidateId, decision: index === 0 ? "missing" : "covered", coveredByIDs: [], coveredByCandidateIds: index === 0 ? [] : [hex(20)], reason: index === 0 ? "Representative missing jaw sense" : "Same construction and meaning as the lower proposed representative" }));
validateCandidateAliases(aliases, peers);
assert.throws(() => validateCandidateDecisions({ entries: [{ ...aliases[0], decision: "covered", coveredByCandidateIds: [hex(21)] }] }, [peers[0]]), /lower/);
assert.throws(() => validateCandidateDecisions({ entries: [{ ...aliases[1], coveredByCandidateIds: [hex(999)] }] }, [peers[1]]), /lower/);
assert.throws(() => validateCandidateAliases([{ ...aliases[0], decision: "needs_review" }, ...aliases.slice(1)], peers), /terminate/);
assert.throws(() => validateCandidateAliases(aliases.slice(1), peers.slice(1)), /actual input record/);
const mixedCoverage = { ...inputs[0], alternativeCandidates: [{ ...peerEvidence(9), spanish: "la quijada" }] };
assert.throws(() => validateCandidateDecisions({ entries: [{ ...covered, coveredByCandidateIds: [hex(9)] }] }, [mixedCoverage]), /not both/);

// Identical bilingual text is insufficient: financial and seating Bank are separate senses.
const bankReview = { ...review, entries: [reviewed(30, 31, "Die Bank", "el banco", "die")] };
bankReview.entries[0].forms.plural = "Die Banken";
bankReview.entries[0].notes = "Die Banken";
bankReview.entries[0].translations[0].variant.forms.plural = "Die Banken";
bankReview.entries[0].translations[0].variant.notes = "Die Banken";
bankReview.entries[0].translations[0].variant.examples = ["Die Bank verwaltet Geld.", "Ich eröffne ein Konto bei der Bank."];
bankReview.entries[0].translations[0].examples = ["El banco administra dinero.", "Abro una cuenta en el banco."];
const seatingReason = "Distinct seating sense with plural Die Bänke, unlike the financial sense with Die Banken.";
const seatingSense = intention("reviewed:seating", seatingReason, { gender: "die", plural: "Die Bänke" });
const bankCandidate = { ...candidate, candidateId: hex(33), german: "Die Bank", spanish: "el banco", senseKey: seatingSense.senseKey, reasons: [seatingReason], requestedSense: seatingSense, potentialMatchingStudyBackSenses: [{ wordId: hex(30), relationId: hex(31), german: "Die Bank", spanish: "el banco", ready: true }] };
const bankInputs = buildCandidateReviewInputs({ ...ambiguous, ambiguousCandidates: [bankCandidate] }, bankReview, 1);
assert.equal(bankInputs[0].requestedSense.forms.plural, "Die Bänke");
assert.equal(bankInputs[0].potentialMatches[0].forms.plural, "Die Banken");
assert.equal(permitsRequestedSenseCoverage(bankInputs[0], bankInputs[0].potentialMatches[0]), false);
assert.throws(() => validateCandidateDecisions({ entries: [{ ...covered, candidateId: hex(33), coveredByIDs: [hex(31)], reason: "Identical Bank/el banco texts" }] }, bankInputs), /explicit requested forms/);
validateCandidateDecisions({ entries: [{ candidateId: hex(33), decision: "missing", coveredByIDs: [], coveredByCandidateIds: [], reason: "The seating Bänke construction is missing; the existing Banken relation teaches money." }] }, bankInputs);
const relatedBank = { ...bankCandidate, senseKey: "related:seating", requestedSense: { senseKey: "related:seating", reasons: [seatingReason] } };
const relatedBankInputs = buildCandidateReviewInputs({ ...ambiguous, ambiguousCandidates: [relatedBank] }, bankReview, 1);
assert.deepEqual(relatedBankInputs[0].requestedSense.forms, intention("", "").forms, "Related proposals never inherit the existing financial plural");
assert.ok(JSON.stringify(relatedBankInputs).includes(seatingReason), "The actual requested seating intention remains available for semantic provider review");

const financeReason = "Financial institution handling money; plural Die Banken.";
const financeSense = intention("reviewed:financial", financeReason, { gender: "die", plural: "Die Banken" });
const bankPeers: CandidateReviewInput[] = [
  { candidateId: hex(40), german: "Die Bank", spanish: "el banco", reasons: [financeReason], requestedSense: financeSense, potentialMatches: [], alternativeCandidates: [] },
  { candidateId: hex(41), german: "Die Bank", spanish: "el banco", reasons: [seatingReason], requestedSense: seatingSense, potentialMatches: [], alternativeCandidates: [] },
];
for (const input of bankPeers) input.alternativeCandidates = bankPeers.filter(peer => peer.candidateId !== input.candidateId).map(({ candidateId, german, spanish, reasons, requestedSense }) => ({ candidateId, german, spanish, reasons, requestedSense }));
const distinctBankDecisions: CandidateDecision[] = bankPeers.map(input => ({ candidateId: input.candidateId, decision: "missing", coveredByIDs: [], coveredByCandidateIds: [], reason: `${input.requestedSense.senseKey} is a separately missing sense.` }));
validateCandidateAliases(distinctBankDecisions, bankPeers);
assert.throws(() => validateCandidateDecisions({ entries: [{ ...distinctBankDecisions[1], decision: "covered", coveredByCandidateIds: [hex(40)], reason: "Same Bank/el banco strings" }] }, [bankPeers[1]]), /requested-sense evidence/);
const tamperedPeerInputs = clone(peers); tamperedPeerInputs[1].alternativeCandidates[0].requestedSense.reasons = ["Rewritten intended sense"];
assert.throws(() => validateCandidateAliases(aliases, tamperedPeerInputs), /actual input record/);
const rawPeer = (input: CandidateReviewInput) => ({ ...input, senseKey: input.requestedSense.senseKey, potentialMatchingStudyBackSenses: [], alternativeCandidateSenses: input.alternativeCandidates.map(peer => ({ ...peer, senseKey: peer.requestedSense.senseKey, sourceWordIds: ["private-source"] })) });
const bankPeerInputs = buildCandidateReviewInputs({ ...ambiguous, ambiguousCandidates: bankPeers.map(rawPeer) }, bankReview, 1);
assert.equal(bankPeerInputs.length, 2, "Distinct intentions survive even when both bilingual texts are identical");
assert.equal(bankPeerInputs[0].alternativeCandidates[0].requestedSense.forms.plural, "Die Bänke");
const forgedPeerSource = { ...ambiguous, ambiguousCandidates: bankPeers.map(rawPeer) };
forgedPeerSource.ambiguousCandidates[0].alternativeCandidateSenses[0].requestedSense = financeSense;
forgedPeerSource.ambiguousCandidates[0].alternativeCandidateSenses[0].senseKey = financeSense.senseKey;
forgedPeerSource.ambiguousCandidates[0].alternativeCandidateSenses[0].reasons = [financeReason];
assert.throws(() => buildCandidateReviewInputs(forgedPeerSource, bankReview, 1), /actual candidate record/);
assert.equal(permitsRequestedSenseCoverage(bankPeers[1], { german: "Die Bank", forms: {} }, true), false, "Final companion drafts must preserve every explicitly requested form");
assert.equal(permitsRequestedSenseCoverage(bankPeers[1], { german: "Die Bank", forms: { gender: "die", plural: "Die Bänke" } }, true), true);

// Integration: the actual preparer retains two Bank intentions with distinct stable IDs.
const bankEntry = { ...bankReview.entries[0], examples: [...bankReview.entries[0].translations[0].variant.examples], relatedCandidates: [{ german: "Die Bank", spanish: "el banco", reason: seatingReason }, { german: "Die Bank", spanish: "el banco", reason: financeReason }] };
delete bankEntry.userId; delete bankEntry.progressId;
const preparedBankReview = { ...bankReview, entries: [bankEntry] };
const preparedBank = prepareWordCardAdditions({ auditedAt: now.toISOString(), database: "synthetic_fixture", collections: {
  WORDS_DE: [{ _id: oid(30), word: "Bank", gramaticalCategories: ["NOUN"], forms: {}, notes: "", examples: [] }],
  WORDS_ES: [{ _id: oid(32), word: "el banco", examples: [] }],
  WORDS_ES_DE: [{ _id: oid(31), main: oid(32), translated: oid(30) }],
  userprogresses: [{ userId: "private-owner", card: { prompt: "private-progress" } }],
} }, preparedBankReview as unknown as ReviewedAggregate, { sourceHash: review.sourceHash, auditedAt: now.toISOString() });
const preparedBankInputs = buildCandidateReviewInputs({ ...preparedBank.summary, ambiguousCandidates: preparedBank.ambiguousCandidates }, preparedBankReview, 1);
assert.equal(preparedBankInputs.length, 2);
assert.notEqual(preparedBankInputs[0].candidateId, preparedBankInputs[1].candidateId);
assert.notEqual(preparedBankInputs[0].requestedSense.senseKey, preparedBankInputs[1].requestedSense.senseKey);
assert.ok(preparedBankInputs.some(input => input.requestedSense.reasons.includes(seatingReason)));
assert.ok(preparedBankInputs.some(input => input.requestedSense.reasons.includes(financeReason)));
for (const input of preparedBankInputs) assert.deepEqual(input.alternativeCandidates[0].requestedSense, preparedBankInputs.find(peer => peer.candidateId === input.alternativeCandidates[0].candidateId)!.requestedSense);
assert.ok(!JSON.stringify(preparedBankInputs).includes("private-"));

const word = (number: number, word: string) => ({ _id: oid(number), word, gramaticalCategories: ["VERB"], forms: {}, notes: "", examples: ["Wir lernen Deutsch."], contexts: ["general_vocabulary"], createdAt: now, userId: "private-owner" });
// The actual manifest validator forbids extras; fixture privacy checks use protected patches instead.
const cleanWord = (number: number, value: string) => { const result = word(number, value); delete result.userId; return result; };
const manifest: WordCardManifest = { version: 1, auditedAt: now.toISOString(), snapshotSHA256: "c".repeat(64), patches: [{ collection: "WORDS_DE", id: hex(500), set: { notes: "existing new note" }, before: { notes: "existing old note" }, unset: [], missingBefore: [] }], inserts: [
  { collection: "WORDS_DE", document: cleanWord(100, "jemandem helfen") },
  { collection: "WORDS_DE", document: cleanWord(101, "jemandem beistehen") },
  { collection: "WORDS_ES", document: cleanWord(200, "a alguien ayudar") },
  { collection: "WORDS_ES_DE", document: { _id: oid(300), main: oid(200), translated: oid(100), createdAt: now, study: { version: 1, german: "jemandem helfen", spanish: "a alguien ayudar", notes: "hat geholfen\nich half\nhilf!, helft!", examples: ["Ich helfe dir. (Te ayudo.)"], auditedAt: now } } },
  { collection: "WORDS_ES_DE", document: { _id: oid(301), main: oid(200), translated: oid(101), createdAt: now, study: { version: 1, german: "jemandem beistehen", spanish: "a alguien apoyar", notes: "hat beigestanden\nich stand bei\nsteh bei!, steht bei!", examples: ["Sie stand ihm bei. (Ella lo apoyó.)"], auditedAt: now } } },
] };
const classificationInputs = buildInsertionClassificationInputs(manifest);
assert.deepEqual(classificationInputs.map(entry => entry.id), [hex(100), hex(101)]);
assert.equal(classificationInputs[1].intendedSenses[0].spanish, "a alguien apoyar");
assert.ok(!JSON.stringify(classificationInputs).includes("existing old note"), "Existing patches never enter classification");
assert.ok(!JSON.stringify(classificationInputs).includes("private-"));
for (const level of CEFR_LEVELS) assert.equal(cefrBand(level), level.slice(0, 2));
assert.throws(() => cefrBand("B3.1"), /Invalid CEFR/);
assert.throws(() => validateInsertionClassifications({ entries: [{ id: hex(100), cefrLevel: "A1.1" }] }, classificationInputs), /every exact/);
assert.throws(() => validateInsertionClassifications({ entries: [{ id: hex(100), cefrLevel: "A1.1" }, { id: hex(100), cefrLevel: "B2.1" }] }, classificationInputs), /Invalid/);
assert.throws(() => validateInsertionClassifications({ entries: [{ id: hex(100), cefrLevel: "A1.1" }, { id: hex(999), cefrLevel: "B2.1" }] }, classificationInputs), /Invalid/);
assert.throws(() => validateInsertionClassifications({ entries: [{ id: hex(100), cefrLevel: "A1.1" }, { id: hex(101), cefrLevel: "C3.1" }] }, classificationInputs), /Invalid/);
assert.throws(() => validateInsertionClassifications({ entries: [{ id: hex(100), cefrLevel: "A1.1", model: "guessed" }, { id: hex(101), cefrLevel: "B2.1" }] }, classificationInputs), /Invalid/);
const missingRelation = { ...manifest, inserts: manifest.inserts.filter(insert => objectIdString(insert.document._id) !== hex(300)) };
assert.throws(() => buildInsertionClassificationInputs(missingRelation), /intended paired/);
const missingSpanish = { ...manifest, inserts: manifest.inserts.filter(insert => insert.collection !== "WORDS_ES") };
assert.throws(() => buildInsertionClassificationInputs(missingSpanish), /endpoints must resolve/);
const unpairedSpanish = { ...manifest, inserts: [...manifest.inserts, { collection: "WORDS_ES" as const, document: cleanWord(201, "huérfano") }] };
assert.throws(() => buildInsertionClassificationInputs(unpairedSpanish), /Every new Spanish/);
const before = BSON.EJSON.stringify(manifest, { relaxed: false });
const classified = applyInsertionClassifications(manifest, [
  { id: hex(100), cefrLevel: "A1.2", model: CANDIDATE_HELPER_MODEL, classifiedAt: "2026-10-08T01:01:00.000Z" },
  { id: hex(101), cefrLevel: "B2.1", model: CANDIDATE_HELPER_MODEL, classifiedAt: "2026-10-08T01:02:00.000Z" },
]);
assert.equal(BSON.EJSON.stringify(manifest, { relaxed: false }), before, "Source manifest stays unchanged");
assert.deepEqual(classified.manifest.patches, manifest.patches, "No existing metadata updates");
const de = classified.manifest.inserts.find(insert => insert.collection === "WORDS_DE" && insert.document._id.equals(oid(100)))!.document;
assert.equal(de.cefrLevel, "A1.2"); assert.equal(de.level, "A1"); assert.equal(de.cefrClassification.model, CANDIDATE_HELPER_MODEL); assert.ok(de.cefrClassification.classifiedAt instanceof Date);
const es = classified.manifest.inserts.find(insert => insert.collection === "WORDS_ES")!.document;
assert.equal(es.cefrLevel, "B2.1", "Shared Spanish entry takes the harder actual paired German estimate");
assert.equal(es.level, "B2"); assert.equal(es.cefrClassification.classifiedAt.toISOString(), "2026-10-08T01:02:00.000Z");
assert.equal(classified.sharedSpanishConflicts.length, 1);
assert.throws(() => applyInsertionClassifications(manifest, [{ id: hex(100), cefrLevel: "A1.2", model: "guessed-parent-level", classifiedAt: now.toISOString() }, { id: hex(101), cefrLevel: "B2.1", model: CANDIDATE_HELPER_MODEL, classifiedAt: now.toISOString() }]), /actual model/);

// Sense clones reuse an existing relation identity: neither endpoint is a relation INSERT.
const sourceDE = { ...cleanWord(400, "vorbeugen"), cefrLevel: "B1.2", level: "B1", cefrClassification: { level: "B1.2", model: "gpt-5.6-sol", version: 1, classifiedAt: new Date("2026-09-01T10:00:00.000Z") } };
const sourceES = cleanWord(401, "prevenir");
const sourceRelation = { _id: oid(402), main: oid(401), translated: oid(400) };
const snapshot = { collections: { WORDS_DE: [sourceDE], WORDS_ES: [sourceES], WORDS_ES_DE: [sourceRelation], userprogresses: [{ userId: "private-owner", card: { answer: "private-live" } }] } };
const study = { version: 1, german: "einer Krankheit vorbeugen", spanish: "prevenir una enfermedad", notes: "hat vorgebeugt\nich beugte vor\nbeug vor!, beugt vor!", examples: ["Sport beugt Krankheiten vor. (El deporte previene enfermedades.)"], auditedAt: now };
const cloneManifest: WordCardManifest = { version: 1, auditedAt: now.toISOString(), snapshotSHA256: "d".repeat(64), inserts: [
  { collection: "WORDS_DE", document: { ...cleanWord(410, "vorbeugen"), cefrLevel: "A1.1", level: "A1", cefrClassification: { level: "A1.1", model: "parent-estimate", version: 1, classifiedAt: now } } },
  { collection: "WORDS_ES", document: cleanWord(411, "prevenir una enfermedad") },
], patches: [{ collection: "WORDS_ES_DE", id: hex(402), set: { main: oid(411), translated: oid(410), study }, before: { main: oid(401), translated: oid(400) }, missingBefore: ["study"], unset: [] }] };
const cloneInputs = buildInsertionClassificationInputs(cloneManifest, snapshot);
assert.deepEqual(cloneInputs.map(input => input.id), [hex(410)], "All new DE clones are actually classified even with inherited levels");
assert.equal(cloneInputs[0].intendedSenses[0].german, study.german);
const emptyStudyManifest = BSON.EJSON.parse(BSON.EJSON.stringify(cloneManifest, { relaxed: false }), { relaxed: false }) as WordCardManifest;
emptyStudyManifest.inserts[0].document.notes = "legacy source notes";
emptyStudyManifest.inserts[0].document.examples = ["This belongs to the source record."];
emptyStudyManifest.patches[0].set.study = { ...study, notes: "", examples: [] };
const emptyStudySense = buildInsertionClassificationInputs(emptyStudyManifest, snapshot)[0].intendedSenses[0];
assert.equal(emptyStudySense.notes, "", "An intentionally empty reviewed note remains authoritative for classification");
assert.deepEqual(emptyStudySense.examples, [], "An intentionally empty reviewed example array cannot acquire source examples");
assert.ok(!JSON.stringify(cloneInputs).includes("private-") && !JSON.stringify(cloneInputs).includes("parent-estimate"));
const classifiedClone = applyInsertionClassifications(cloneManifest, [{ id: hex(410), cefrLevel: "B2.1", model: CANDIDATE_HELPER_MODEL, classifiedAt: now.toISOString() }], snapshot);
assert.deepEqual(classifiedClone.manifest.patches, cloneManifest.patches);
assert.equal(classifiedClone.manifest.inserts.find(insert => insert.collection === "WORDS_ES")!.document.cefrLevel, "B2.1");
assert.deepEqual(classifiedClone.classificationCoverage.pairedRelationIds, [hex(402)]);
assert.throws(() => buildInsertionClassificationInputs(cloneManifest, { collections: { ...snapshot.collections, WORDS_ES_DE: [] } }), /absent from/);

// A newly paired ES word can reuse a dated, classified original DE word.
const reuseManifest: WordCardManifest = { version: 1, auditedAt: now.toISOString(), snapshotSHA256: "d".repeat(64), patches: [...manifest.patches], inserts: [
  { collection: "WORDS_ES", document: cleanWord(420, "prevenir una enfermedad") },
  { collection: "WORDS_ES_DE", document: { _id: oid(421), main: oid(420), translated: oid(400), study, createdAt: now } },
] };
assert.throws(() => buildInsertionClassificationInputs(reuseManifest), /provide --snapshot/);
assert.deepEqual(buildInsertionClassificationInputs(reuseManifest, snapshot), []);
const inheritedResult = applyInsertionClassifications(reuseManifest, [], snapshot);
const inheritedES = inheritedResult.manifest.inserts.find(insert => insert.collection === "WORDS_ES")!.document;
assert.equal(inheritedES.cefrLevel, "B1.2");
assert.equal(inheritedES.cefrClassification.model, "parent-estimate", "Never claim a paid GPT request for an inherited estimate");
assert.equal(inheritedES.cefrClassification.classifiedAt.toISOString(), "2026-09-01T10:00:00.000Z", "Preserve the actual parent classification time");
assert.equal(inheritedResult.inheritedEstimates[0].sourceModel, "gpt-5.6-sol");
assert.deepEqual(inheritedResult.manifest.patches, reuseManifest.patches);

// Without original dated CEFR evidence, a supplemental actual request feeds new ES only.
const undatedSnapshot = { collections: { ...snapshot.collections, WORDS_DE: [{ ...sourceDE, cefrClassification: undefined }] } };
const supplemental = buildInsertionClassificationInputs(reuseManifest, undatedSnapshot);
assert.deepEqual(supplemental.map(input => input.id), [hex(400)]);
assert.equal(supplemental[0].german, study.german, "Classify the precise German study construction, independent of dictionary surface spelling");
assert.ok(!JSON.stringify(supplemental).includes("cefrLevel") && !JSON.stringify(supplemental).includes("private-"));
const undatedBefore = BSON.EJSON.stringify(undatedSnapshot, { relaxed: false });
const supplementalResult = applyInsertionClassifications(reuseManifest, [{ id: hex(400), cefrLevel: "B2.2", model: CANDIDATE_HELPER_MODEL, classifiedAt: now.toISOString() }], undatedSnapshot);
assert.equal(supplementalResult.manifest.inserts.find(insert => insert.collection === "WORDS_ES")!.document.cefrLevel, "B2.2");
assert.deepEqual(supplementalResult.classificationCoverage.supplementalExistingGermanClassifications, [hex(400)]);
assert.equal(BSON.EJSON.stringify(undatedSnapshot, { relaxed: false }), undatedBefore);
assert.deepEqual(supplementalResult.manifest.patches, reuseManifest.patches, "Never introduce existing DE CEFR metadata updates");

// A PATCH with unchanged DE endpoint resolves via snapshot or explicit immutable guards.
const reusedPatchManifest: WordCardManifest = { ...reuseManifest, inserts: reuseManifest.inserts.filter(insert => insert.collection === "WORDS_ES"), patches: [{ collection: "WORDS_ES_DE", id: hex(402), set: { main: oid(420), study }, before: { main: oid(401) }, missingBefore: ["study"], guards: { before: { translated: oid(400) }, missingBefore: [] }, unset: [] }] };
assert.deepEqual(buildInsertionClassificationInputs(reusedPatchManifest, snapshot), []);
assert.equal(applyInsertionClassifications(reusedPatchManifest, [], snapshot).manifest.inserts[0].document.cefrLevel, "B1.2");
// A new DE may pair with an existing ES; existing ES metadata must stay untouched.
const existingSpanishManifest: WordCardManifest = { ...cloneManifest, inserts: cloneManifest.inserts.filter(insert => insert.collection === "WORDS_DE"), patches: [{ collection: "WORDS_ES_DE", id: hex(402), set: { translated: oid(410), study }, before: { translated: oid(400) }, missingBefore: ["study"], guards: { before: { main: oid(401) }, missingBefore: [] }, unset: [] }] };
assert.deepEqual(buildInsertionClassificationInputs(existingSpanishManifest, snapshot).map(input => input.id), [hex(410)]);
assert.equal(applyInsertionClassifications(existingSpanishManifest, [{ id: hex(410), cefrLevel: "B2.1", model: CANDIDATE_HELPER_MODEL, classifiedAt: now.toISOString() }], snapshot).manifest.inserts.length, 1);

const directory = await mkdtemp(join(tmpdir(), "word-card-candidates-"));
try {
  const path = join(directory, "private", "projection.json");
  await writeCandidatePrivate(path, JSON.stringify(inputs));
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
  assert.equal(await readFile(path, "utf8"), JSON.stringify(inputs));
} finally { await rm(directory, { recursive: true, force: true }); }

function objectIdString(value: any) { return value.toHexString(); }
console.log("Candidate identity, semantic-alias guards, insertion CEFR propagation, privacy and private-file tests passed. No provider or database calls.");
