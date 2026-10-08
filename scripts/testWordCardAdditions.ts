import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BSON } from "mongodb";
import { additionId, buildWordCardCandidateSnapshot, normalizeStudyText, prepareWordCardAdditions, reviewedWordCardCategoryReady, type ReviewedAggregate } from "./prepareWordCardAdditions.js";
import { WORD_CARD_FORM_KEYS, WORD_CARD_PROMPT_VERSION, WORD_CARD_REVIEW_INSTRUCTIONS, WORD_CARD_REVIEW_SCHEMA, type WordCardDraft, type WordCardForms } from "./lib/wordCardPrompt.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const oid = (key: string) => new BSON.ObjectId(hash(`word-addition-test:${key}`).slice(0, 24));
const now = "2026-10-08T10:00:00.000Z";
const sourceHash = "a".repeat(64);
const forms = (overrides: Partial<WordCardForms> = {}): WordCardForms => ({ ...Object.fromEntries(WORD_CARD_FORM_KEYS.map(key => [key, ""])), ...overrides }) as WordCardForms;
const noun = (key: string, german: string, spanish: string): WordCardDraft => {
  const nounForms = forms({ gender: /^Der /u.test(german) ? "der" : /^Das /u.test(german) ? "das" : "die" });
  const variant = { german, category: "NOUN" as const, forms: nounForms, notes: "", examples: ["Das ist ein Beispiel.", "Hier steht ein weiteres Beispiel."], confidence: "high" as const, reviewReason: "" };
  return { id: oid(key).toHexString(), ...variant, translations: [{ relationId: oid(`relation:${key}`).toHexString(), spanish, examples: ["Este es un ejemplo.", "Aquí hay otro ejemplo."], variant }], issues: [], studyEligible: true, relatedCandidates: [] };
};
const verb = (key: string, german: string, spanish: string, unlinked = false): WordCardDraft => {
  const verbForms = forms({ perfect: "hat gelernt", past: "ich lernte", imperativ: "lern!, lernt!" });
  const variant = { german, category: "VERB" as const, forms: verbForms, notes: "hat gelernt\nich lernte\nlern!, lernt!", examples: ["Ich lerne Deutsch.", "Du lernst jeden Tag."], confidence: "high" as const, reviewReason: "" };
  return { id: oid(key).toHexString(), ...variant, translations: [{ relationId: unlinked ? "" : oid(`relation:${key}`).toHexString(), spanish, examples: ["Aprendo alemán.", "Aprendes todos los días."], variant }], issues: [], studyEligible: true, relatedCandidates: [] };
};
const aggregate = (entries: WordCardDraft[]): ReviewedAggregate => ({ version: 1, stage: "independent_review", promptVersion: WORD_CARD_PROMPT_VERSION, promptHash: hash(WORD_CARD_PROMPT_VERSION + WORD_CARD_REVIEW_INSTRUCTIONS + JSON.stringify(WORD_CARD_REVIEW_SCHEMA)), sourceHash, selected: entries.length, completed: entries.length, pending: 0, offset: 0, entries });
const word = (key: string, lexicalWord: string) => ({ _id: oid(key), word: lexicalWord, gramaticalCategories: ["UNKNOWN"], forms: {}, notes: "", examples: [], contexts: [] });
function fixture(entries: WordCardDraft[], originals: Record<string, string> = {}) {
  const WORDS_DE = entries.map(entry => {
    const key = Object.keys(originals).find(key => oid(key).toHexString() === entry.id);
    return { ...word("placeholder", key ? originals[key] : entry.german), _id: new BSON.ObjectId(entry.id) };
  });
  const WORDS_ES: any[] = [], WORDS_ES_DE: any[] = [];
  for (const entry of entries) for (const translation of entry.translations) {
    if (!translation.relationId) continue;
    const spanish = word(`es:${translation.relationId}`, translation.spanish);
    WORDS_ES.push(spanish);
    WORDS_ES_DE.push({ _id: new BSON.ObjectId(translation.relationId), main: spanish._id, translated: new BSON.ObjectId(entry.id) });
  }
  return { auditedAt: now, database: "synthetic_fixture", collections: { WORDS_DE, WORDS_ES, WORDS_ES_DE, userprogresses: [{ _id: oid("private-progress"), userId: oid("private-owner"), scheduler: { phase: "REVIEW" }, card: { sourceNoteGuid: "PRIVATE_OWNER_SOURCE", prompt: "PRIVATE_LIVE_PROMPT" } }] } };
}

const band = noun("band", "Der Band", "el tomo");
band.relatedCandidates = [
  { german: "Der Band", spanish: "el tomo", reason: "Existing same noun sense" },
  { german: "Die Band", spanish: "la banda", reason: "Different current noun gender/sense" },
  { german: "Das Band", spanish: "la cinta", reason: "Different current noun gender/sense" },
];
const cafe = noun("cafe", "Das Café", "el café");
cafe.relatedCandidates = [
  { german: "  DAS   Cafe\u0301  ", spanish: " EL  CAFE\u0301 ", reason: "Canonical equivalent must be covered" },
  { german: "Der Baum", spanish: "el árbol", reason: "A real related missing noun" },
];
const treeSource = noun("tree-source", "Das Blatt", "la hoja");
treeSource.relatedCandidates = [{ german: " DER   BAUM ", spanish: "EL A\u0301RBOL", reason: " A REAL related MISSING noun " }];
const warten = verb("warten", "auf jemanden warten", "a alguien esperar");
warten.relatedCandidates = [{ german: "auf jemanden warten", spanish: "a alguien aguardar", reason: "Potential synonym, not proven distinct meaning" }];
const gehen = verb("gehen", "gehen", "ir", true);
const geht = verb("geht", "gehen", "ir", true);
const fuhr = verb("fuhr", "fahren", "viajar", true);
const name = noun("name", "Die Kevin", "Kevin");
name.german = "Kevin"; name.category = "UNKNOWN"; name.forms = forms(); name.examples = []; name.studyEligible = false;
name.translations = [{ relationId: "", spanish: "Kevin", examples: [], variant: { german: "Kevin", category: "UNKNOWN", forms: forms(), notes: "", examples: [], confidence: "high", reviewReason: "" } }];
name.relatedCandidates = [{ german: "Der Kevin", spanish: "Kevin", reason: "Never multiply an excluded personal name" }];
const unknown = verb("unknown", "zweifelhaft", "dudoso", true);
unknown.category = "UNKNOWN"; unknown.forms = forms(); unknown.notes = "";
unknown.translations[0].variant = { ...unknown.translations[0].variant!, category: "UNKNOWN", forms: forms(), notes: "" };
unknown.relatedCandidates = [{ german: "Das Phantom", spanish: "el fantasma", reason: "Unknown entry must wait for review" }];
const uncertain = verb("uncertain", "unsicher sein", "estar inseguro", true);
uncertain.confidence = "needs_review"; uncertain.reviewReason = "Construction remains uncertain";
uncertain.translations[0].variant = { ...uncertain.translations[0].variant!, confidence: "needs_review", reviewReason: "Construction remains uncertain" };
uncertain.relatedCandidates = [{ german: "etwas vermuten", spanish: "algo suponer", reason: "split_existing_sense: uncertain companion" }];
const passieren = verb("passieren", "passieren", "ocurrir");
passieren.issues.push("split_requires_companion_card");
passieren.relatedCandidates = [
  { german: "etwas passieren", spanish: "algo colar", reason: "split_existing_sense: preserve straining-food sense" },
  { german: "Der Band", spanish: "el tomo", reason: "split_existing_sense: fixture of an already covered companion" },
  { german: "auf jemanden warten", spanish: "a alguien aguardar", reason: "split_existing_sense: fixture of an ambiguous companion" },
];
const entries = [band, cafe, treeSource, warten, gehen, geht, fuhr, name, unknown, uncertain, passieren];
const snapshot = fixture(entries, { band: "Band", cafe: "Café", "tree-source": "Blatt", warten: "warten", gehen: "gehen", geht: "geht", fuhr: "fuhr", name: "Kevin" });
// Proper names are unlinked, even though noun() originally creates a relation.
const before = BSON.EJSON.stringify(snapshot, { relaxed: false });
const review = aggregate(entries);
const result = prepareWordCardAdditions(snapshot, review, { sourceHash, auditedAt: now });
assert.equal(BSON.EJSON.stringify(snapshot, { relaxed: false }), before, "source snapshot must be immutable");
assert.deepEqual(result.candidates.map(candidate => candidate.german).sort(), ["Das Band", "Der Baum", "Die Band", "etwas passieren", "fahren", "gehen"].sort());
assert.equal(result.coveredCandidates.length, 0, "Identical front text cannot prove coverage of a requested meaning");
assert.equal(result.ambiguousCandidates.length, 5, "Existing exact fronts and different requested intentions must reach semantic deduplication");
const ambiguousWait = result.ambiguousCandidates.find(candidate => candidate.german === "auf jemanden warten" && candidate.required)!;
assert.equal(ambiguousWait.potentialMatchingStudyBackSenses[0].spanish, "a alguien esperar");
assert.equal(result.candidates.find(candidate => candidate.german === "gehen")!.originalDEReuseId, gehen.id);
assert.deepEqual(result.candidates.find(candidate => candidate.german === "gehen")!.sourceWordIds.sort(), [geht.id, gehen.id].sort(), "Inflected seeds collapse into one canonical construction/sense");
assert.equal(result.candidates.find(candidate => candidate.german === "fahren")!.originalDEReuseId, null, "Finite fuhr must never be relinked to infinitive fahren");
assert.equal(result.candidates.find(candidate => candidate.german === "Der Baum")!.sources.length, 2, "NFC/case/spacing duplicate proposals must merge");
assert.equal(result.candidates.find(candidate => candidate.german === "etwas passieren")!.required, true);
assert.deepEqual(result.summary.coverage.requiredCompanions, { coveredExact: 0, missing: 1, ambiguous: 2, excludedPendingReview: 1, excludedNonStudy: 0 });
assert.equal(result.reviewQueue.length, 2);
assert.equal(result.excludedEntries.length, 1);
assert.equal(result.summary.coverage.snapshotGermanEntries, entries.length);
assert.equal(result.summary.coverage.exactDuplicateProposals, 2);
assert.equal(result.candidateSnapshot.collections.userprogresses.length, 0);
assert.equal(normalizeStudyText(" DAS  Cafe\u0301 "), normalizeStudyText("Das Café"));
assert.notEqual(normalizeStudyText("Der Band"), normalizeStudyText("Die Band"));
assert.notEqual(additionId("DE", "Der Band", "el tomo"), additionId("DE", "Das Band", "la cinta"));
assert.equal(additionId("DE", "Das Café", "el café"), additionId("DE", " DAS Cafe\u0301 ", "EL CAFE\u0301"));
assert.notEqual(additionId("DE", "Das Band", "la cinta"), additionId("ES", "Das Band", "la cinta"));
for (const candidate of result.candidates) {
  assert.match(candidate.candidateId, /^[\da-f]{24}$/u);
  assert.ok(candidate.ids.german !== candidate.ids.spanish && candidate.ids.german !== candidate.ids.relation);
  assert.ok(!entries.some(entry => entry.id === candidate.ids.german));
}
for (const word of result.candidateSnapshot.collections.WORDS_DE) {
  assert.deepEqual(word.gramaticalCategories, ["UNKNOWN"]); assert.deepEqual(word.forms, {});
  assert.match(word.notes, /^Requested study sense:\n/u); assert.deepEqual(word.examples, []);
}
const providerPayload = BSON.EJSON.stringify(result.candidateSnapshot, { relaxed: false });
for (const forbidden of ["userId", "scheduler", "PRIVATE_OWNER_SOURCE", "PRIVATE_LIVE_PROMPT", oid("private-owner").toHexString(), oid("private-progress").toHexString(), ...entries.map(entry => entry.id), ...snapshot.collections.WORDS_ES_DE.map(relation => relation._id.toHexString())]) assert.ok(!providerPayload.includes(forbidden), `Provider snapshot must exclude private/original identity ${forbidden}`);
assert.deepEqual(prepareWordCardAdditions(snapshot, { ...review, entries: [...entries].reverse() }, { sourceHash, auditedAt: now }).candidates, result.candidates, "Order changes must not change IDs/mappings");
assert.throws(() => prepareWordCardAdditions(snapshot, { ...review, sourceHash: "b".repeat(64) }, { sourceHash }), /sourceHash/);
assert.throws(() => prepareWordCardAdditions(snapshot, { ...review, stage: "draft" }, { sourceHash }), /independent_review/);
assert.throws(() => prepareWordCardAdditions(snapshot, { ...review, promptHash: "b".repeat(64) }, { sourceHash }), /current word-card prompt/);
assert.throws(() => prepareWordCardAdditions(snapshot, { ...review, pending: 1 }, { sourceHash }), /pending/);
const partial = aggregate([band]);
assert.throws(() => prepareWordCardAdditions(snapshot, partial, { sourceHash }), /Complete catalog review required/);
assert.equal(prepareWordCardAdditions(snapshot, partial, { sourceHash, allowPartial: true }).summary.partial, true);
assert.throws(() => prepareWordCardAdditions(snapshot, { ...partial, entries: [band, band], selected: 2, completed: 2 }, { sourceHash, allowPartial: true }), /duplicate/);
assert.throws(() => prepareWordCardAdditions(snapshot, { ...partial, entries: [{ ...band, translations: [{ ...band.translations[0], relationId: "wrong" }] }] }, { sourceHash, allowPartial: true }), /structural/);

// Two proposed cues for a new German front both need semantic deduplication.
const two = [noun("one", "Das Haus", "la casa"), noun("two", "Die Wohnung", "el piso")];
two[0].relatedCandidates = [{ german: "Der Ort", spanish: "el lugar", reason: "Potential place sense" }];
two[1].relatedCandidates = [{ german: "Der Ort", spanish: "el sitio", reason: "Potential wording synonym" }];
const wordingCollision = prepareWordCardAdditions(fixture(two), aggregate(two), { sourceHash });
assert.equal(wordingCollision.candidates.length, 0); assert.equal(wordingCollision.ambiguousCandidates.length, 2);
assert.equal(wordingCollision.ambiguousCandidates[0].alternativeCandidateSenses.length, 1);

// A same-front/same-back homograph remains a separate requested meaning, not a covered pair.
const financialBank = noun("financial-bank", "Die Bank", "el banco");
financialBank.forms.plural = "Die Banken"; financialBank.notes = "Die Banken";
financialBank.translations[0].variant = { ...financialBank.translations[0].variant!, forms: { ...financialBank.forms }, notes: financialBank.notes, examples: ["Ich eröffne ein Konto bei der Bank.", "Die Bank hat geschlossen."] };
financialBank.relatedCandidates = [
  { german: "Die Bank", spanish: "el banco", reason: "Distinct seating sense with plural Die Bänke" },
  { german: "Die Bank", spanish: "el banco", reason: "Financial institution with plural Die Banken" },
];
const bankResult = prepareWordCardAdditions(fixture([financialBank]), aggregate([financialBank]), { sourceHash, auditedAt: now });
assert.equal(bankResult.candidates.length, 0); assert.equal(bankResult.coveredCandidates.length, 0); assert.equal(bankResult.ambiguousCandidates.length, 2);
const [bankA, bankB] = bankResult.ambiguousCandidates;
assert.notEqual(bankA.candidateId, bankB.candidateId, "A different intention changes synthetic identities even when both fronts match");
assert.equal(bankA.alternativeCandidateSenses[0].candidateId, bankB.candidateId);
assert.deepEqual(bankA.alternativeCandidateSenses[0].requestedSense, bankB.requestedSense);
const bench = bankResult.ambiguousCandidates.find(candidate => candidate.reasons[0].includes("seating"))!;
assert.equal(bench.originalDEReuseId, null, "A related request cannot reuse a different parent sense merely because its bare lemma matches");
assert.equal(bench.requestedSense.forms, undefined, "Related proposals cannot inherit the parent's financial plural");
const benchSeed = buildWordCardCandidateSnapshot([bench], "fixture", now).collections.WORDS_DE[0];
assert.match(benchSeed.notes, /seating sense with plural Die Bänke/u); assert.ok(!benchSeed.notes.includes("Die Banken"));
assert.equal(additionId("DE", bench.german, bench.spanish, bench.senseKey), bench.id);
assert.notEqual(additionId("DE", bench.german, bench.spanish, bench.senseKey), additionId("DE", bench.german, bench.spanish));
assert.equal(additionId("DE", "Das Café", "el café", " Other  MEANING "), additionId("DE", " DAS Cafe\u0301 ", "EL CAFE\u0301", "other meaning"));
assert.throws(() => buildWordCardCandidateSnapshot([{ ...bench, senseKey: "tampered" }], "fixture", now), /requested sense/);

// Different own canonical examples also remain evidence rather than blindly equating a pair.
const unlinkedBank = { ...financialBank, id: oid("unlinked-bank").toHexString(), relatedCandidates: [], translations: [{ ...financialBank.translations[0], relationId: "", variant: { ...financialBank.translations[0].variant!, forms: forms({ gender: "die", plural: "Die Bänke" }), notes: "Die Bänke", examples: ["Ich sitze auf einer Bank.", "Die Bank ist aus Holz."] } }] };
const unlinkedBankResult = prepareWordCardAdditions(fixture([financialBank, unlinkedBank]), aggregate([financialBank, unlinkedBank]), { sourceHash });
assert.equal(unlinkedBankResult.coveredCandidates.length, 0);
const ownBench = unlinkedBankResult.ambiguousCandidates.find(candidate => candidate.sources.some(source => source.kind === "unlinked"))!;
assert.equal(ownBench.requestedSense.forms!.plural, "Die Bänke");

// An unlinked canonical pair already covered by a linked entry is never generated again.
const linked = verb("linked", "gehen", "ir"), seed = verb("seed", "gehen", "ir", true);
assert.equal(prepareWordCardAdditions(fixture([linked, seed], { seed: "geht" }), aggregate([linked, seed]), { sourceHash }).candidates.length, 0);
// Exact words permit article-only normalization for a safe reusable unlinked noun.
const reusableNoun = noun("reusable-noun", "Das Haus", "la casa"); reusableNoun.translations[0].relationId = "";
assert.equal(prepareWordCardAdditions(fixture([reusableNoun], { "reusable-noun": "Haus" }), aggregate([reusableNoun]), { sourceHash }).candidates[0].originalDEReuseId, reusableNoun.id);

const idiom = verb("idiom", "ins Gras beißen", "estirar la pata", true);
idiom.category = "UNKNOWN"; idiom.forms = forms(); idiom.notes = "Redewendung";
idiom.translations[0].variant = { ...idiom.translations[0].variant!, category: "UNKNOWN", forms: forms(), notes: "Redewendung" };
const idiomResult = prepareWordCardAdditions(fixture([idiom]), aggregate([idiom]), { sourceHash });
assert.equal(idiomResult.candidates.length, 1, "UNKNOWN is a legitimate internal category for a confidently reviewed idiom");
assert.equal(idiomResult.reviewQueue.length, 0);
assert.equal(idiomResult.candidates[0].originalDEReuseId, idiom.id);
const knownIdiom = { ...idiom, id: oid("known-idiom").toHexString(), translations: [{ ...idiom.translations[0], relationId: oid("relation:known-idiom").toHexString() }] };
assert.equal(prepareWordCardAdditions(fixture([knownIdiom, idiom]), aggregate([knownIdiom, idiom]), { sourceHash }).ambiguousCandidates.length, 1, "Even an exact unlinked idiom carries its own reviewed evidence to semantic coverage review");
const uncertainIdiom = { ...idiom, confidence: "needs_review" as const, reviewReason: "Idiom sense remains uncertain" };
assert.equal(prepareWordCardAdditions(fixture([uncertainIdiom]), aggregate([uncertainIdiom]), { sourceHash }).candidates.length, 0, "An idiom annotation never overrides an unresolved semantic review");
const unannotatedVariant = { ...idiom, translations: [{ ...idiom.translations[0], variant: { ...idiom.translations[0].variant!, notes: "" } }] };
assert.equal(prepareWordCardAdditions(fixture([unannotatedVariant]), aggregate([unannotatedVariant]), { sourceHash }).reviewQueue.length, 1, "Every UNKNOWN relation variant needs its own reviewed idiom annotation");
assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", notes: "" }), false, "Unannotated UNKNOWN entries without lexical evidence remain unresolved");

// Only the nine individually source-checked lowercase cardinals may retain UNKNOWN.
for (const german of ["zehn", "drei", "fünf", "vier", "sechzig", "zwei", "acht", "sieben", "neunzig", "  fu\u0308nf  "]) {
  assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", german, notes: "", forms: forms() }), true, `Allow the reviewed cardinal ${german}`);
}
for (const german of ["Zehn", "Drei", "Fünf", "Acht", "Die Acht", "10", "zehnte", "zweier", "ein", "eins", "null", "elf", "neunundneunzig", "zehn Euro", "sieben sieben", "sechszig", "siebenzig"]) {
  assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", german, notes: "", forms: forms() }), false, `Do not infer a numeral policy for ${german}`);
}
assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", german: "zehn", notes: " ", forms: forms() }), false);
assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", german: "zehn", notes: "", forms: {} }), false, "Missing fields do not mean reviewed empty forms");
assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", german: "zehn", notes: "", forms: { ...forms(), unexpected: "" } }), false);
for (const key of WORD_CARD_FORM_KEYS) {
  const incomplete = { ...forms() } as Partial<WordCardForms>;
  delete incomplete[key];
  assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", german: "zehn", notes: "", forms: incomplete }), false, `Require actual ${key} presence`);
  assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", german: "zehn", notes: "", forms: forms({ [key]: "uncertain form" }) }), false, `Require empty ${key}`);
}
const numeral = verb("unlinked-numeral", "sieben", "siete", true);
numeral.category = "UNKNOWN"; numeral.forms = forms(); numeral.notes = "";
numeral.examples = ["Ich habe sieben Bücher.", "Der Zug fährt um sieben Uhr."];
numeral.translations[0] = { relationId: "", spanish: "siete", examples: ["Tengo siete libros.", "El tren sale a las siete."], variant: { german: numeral.german, category: "UNKNOWN", forms: forms(), notes: "", examples: [...numeral.examples], confidence: "high", reviewReason: "" } };
const numeralResult = prepareWordCardAdditions(fixture([numeral]), aggregate([numeral]), { sourceHash });
assert.equal(numeralResult.candidates.length, 1, "A high independently reviewed unlinked cardinal remains eligible despite the missing NUMERAL enum");
assert.equal(numeralResult.candidates[0].originalDEReuseId, numeral.id);
assert.equal(numeralResult.reviewQueue.length, 0);
assert.equal(numeralResult.candidates[0].requestedSense.notes, "");
assert.deepEqual(numeralResult.candidateSnapshot.collections.WORDS_DE[0].gramaticalCategories, ["UNKNOWN"]);
assert.equal(numeral.category, "UNKNOWN", "Readiness does not rewrite category metadata");
const ambiguousSieben = { ...numeral, confidence: "needs_review" as const, reviewReason: "Numeral or verb meaning sift remains unresolved" };
assert.equal(prepareWordCardAdditions(fixture([ambiguousSieben]), aggregate([ambiguousSieben]), { sourceHash }).reviewQueue.length, 1, "The cardinal spelling never overrides uncertain sense confidence");
const uncertainNumeralVariant = { ...numeral, translations: [{ ...numeral.translations[0], variant: { ...numeral.translations[0].variant!, confidence: "needs_review" as const, reviewReason: "Spanish number cue requires review" } }] };
assert.throws(() => prepareWordCardAdditions(fixture([uncertainNumeralVariant]), aggregate([uncertainNumeralVariant]), { sourceHash }), /unresolved variant requires overall review/u, "A high numeral entry cannot override an uncertain relation variant");
const sievingEvidence = { ...numeral, forms: forms({ perfect: "hat gesiebt", past: "ich siebte", imperativ: "sieb!, siebt!" }) };
assert.equal(reviewedWordCardCategoryReady(sievingEvidence), false, "Ambiguous sieben with actual verb forms cannot enter through the cardinal allowance");
assert.equal(prepareWordCardAdditions(fixture([sievingEvidence]), aggregate([sievingEvidence]), { sourceHash }).candidates.length, 0);
const sievingVariant = { ...numeral, translations: [{ ...numeral.translations[0], variant: { ...numeral.translations[0].variant!, forms: sievingEvidence.forms } }] };
assert.equal(prepareWordCardAdditions(fixture([sievingVariant]), aggregate([sievingVariant]), { sourceHash }).reviewQueue.length, 1, "Each relation variant must independently satisfy the cardinal readiness shape");
const excludedNumeral = { ...numeral, studyEligible: false };
assert.equal(prepareWordCardAdditions(fixture([excludedNumeral]), aggregate([excludedNumeral]), { sourceHash }).excludedEntries.length, 1, "The numeral allowance never overrides studyEligible=false");

// The current enum lacks ABBREVIATION; keep the independently reviewed usw. seed.
const abbreviation = verb("unlinked-abbreviation", "usw.", "y así sucesivamente", true);
abbreviation.category = "UNKNOWN"; abbreviation.forms = forms(); abbreviation.notes = "";
abbreviation.examples = ["Sie bringt Obst, Gemüse, Milch usw. mit.", "Er nannte Länder wie Spanien, Frankreich, Italien usw."];
abbreviation.translations[0] = { relationId: "", spanish: "y así sucesivamente", examples: ["Ella trae fruta, verdura, leche y así sucesivamente.", "Él mencionó países como España, Francia, Italia, etc."], variant: { german: abbreviation.german, category: "UNKNOWN", forms: forms(), notes: "", examples: [...abbreviation.examples], confidence: "high", reviewReason: "" } };
const abbreviationResult = prepareWordCardAdditions(fixture([abbreviation]), aggregate([abbreviation]), { sourceHash });
assert.equal(abbreviationResult.candidates.length, 1);
assert.equal(abbreviationResult.reviewQueue.length, 0);
assert.equal(abbreviationResult.candidates[0].originalDEReuseId, abbreviation.id);
for (const german of ["usw", "Usw.", "etc.", "z. B.", "und so weiter", "Kannst du mir bitte helfen?"]) {
  assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", german, notes: "", forms: forms() }), false, `No unchecked abbreviation or sentence allowance for ${german}`);
}
for (const key of WORD_CARD_FORM_KEYS) {
  assert.equal(reviewedWordCardCategoryReady({ category: "UNKNOWN", german: "usw.", notes: "", forms: forms({ [key]: "unverified form" }) }), false);
}
const heldAbbreviation = { ...abbreviation, confidence: "needs_review" as const, reviewReason: "Translation remains uncertain" };
assert.equal(prepareWordCardAdditions(fixture([heldAbbreviation]), aggregate([heldAbbreviation]), { sourceHash }).candidates.length, 0);
const uncheckedAbbreviationVariant = { ...abbreviation, translations: [{ ...abbreviation.translations[0], variant: { ...abbreviation.translations[0].variant!, german: "etc." } }] };
assert.equal(prepareWordCardAdditions(fixture([uncheckedAbbreviationVariant]), aggregate([uncheckedAbbreviationVariant]), { sourceHash }).reviewQueue.length, 1);

// The probability particle is supported without inventing an ADVERB category.
const probability = verb("unlinked-probability", "wohl", "probablemente", true);
probability.category = "UNKNOWN"; probability.forms = forms(); probability.notes = "";
probability.examples = ["Er ist wohl zu Hause.", "Das ist wohl die beste Lösung."];
probability.translations[0] = { relationId: "", spanish: "probablemente", examples: ["Probablemente esté en casa.", "Probablemente sea la mejor solución."], variant: { german: "wohl", category: "UNKNOWN", forms: forms(), notes: "", examples: [...probability.examples], confidence: "high", reviewReason: "" } };
const probabilityResult = prepareWordCardAdditions(fixture([probability]), aggregate([probability]), { sourceHash });
assert.equal(probabilityResult.candidates.length, 1);
assert.equal(probabilityResult.reviewQueue.length, 0);
assert.equal(probabilityResult.candidates[0].originalDEReuseId, probability.id);
assert.deepEqual(probabilityResult.candidateSnapshot.collections.WORDS_DE[0].gramaticalCategories, ["UNKNOWN"]);
assert.equal(reviewedWordCardCategoryReady(probability), true);
assert.equal(reviewedWordCardCategoryReady(probability.translations[0].variant!, "probablemente"), true);
assert.equal(reviewedWordCardCategoryReady(probability.translations[0].variant!), false, "The spelling alone is not evidence of the probability meaning");
for (const cue of ["bien", "sin duda", "seguramente; bien", ""]) {
  assert.equal(reviewedWordCardCategoryReady(probability.translations[0].variant!, cue), false, `No homographic particle allowance for ${cue}`);
}
for (const german of ["Wohl", "bloß", "eben", "wohl sein"]) {
  assert.equal(reviewedWordCardCategoryReady({ ...probability.translations[0].variant!, german }, "probablemente"), false);
}
for (const key of WORD_CARD_FORM_KEYS) {
  assert.equal(reviewedWordCardCategoryReady({ ...probability, forms: forms({ [key]: "unverified form" }) }), false);
}
assert.equal(reviewedWordCardCategoryReady({ ...probability, forms: {} }), false);
assert.equal(reviewedWordCardCategoryReady({ ...probability, notes: " " }), false);
assert.equal(prepareWordCardAdditions(fixture([{ ...probability, confidence: "needs_review", reviewReason: "Meaning needs review" }]), aggregate([{ ...probability, confidence: "needs_review", reviewReason: "Meaning needs review" }]), { sourceHash }).candidates.length, 0);
const wellVariant = { ...probability, translations: [{ ...probability.translations[0], spanish: "bien" }] };
assert.equal(prepareWordCardAdditions(fixture([wellVariant]), aggregate([wellVariant]), { sourceHash }).reviewQueue.length, 1);

const emphaticExamples = ["Was soll ich bloß tun?", "Warum ist er bloß gegangen?"];
const emphatic = { ...probability, german: "bloß", examples: emphaticExamples, translations: [{ ...probability.translations[0], spanish: "pero", examples: ["Pero ¿qué voy a hacer?", "Pero ¿por qué se ha ido?"], variant: { ...probability.translations[0].variant!, german: "bloß", examples: emphaticExamples } }] };
assert.equal(reviewedWordCardCategoryReady(emphatic), true, "The independently reviewed emphatic-question particle can retain UNKNOWN");
assert.equal(reviewedWordCardCategoryReady(emphatic.translations[0].variant!, "pero"), true);
assert.equal(prepareWordCardAdditions(fixture([emphatic]), aggregate([emphatic]), { sourceHash }).candidates.length, 1);
for (const spanish of ["meramente", "desnudo", "mero", "solamente", "probablemente", ""]) {
  assert.equal(reviewedWordCardCategoryReady(emphatic.translations[0].variant!, spanish), false, "Other bloß meanings require their own actual category");
}
assert.equal(reviewedWordCardCategoryReady({ ...emphatic, forms: {} }), false);
assert.equal(reviewedWordCardCategoryReady({ ...emphatic, notes: " ", forms: forms() }), false);
assert.equal(reviewedWordCardCategoryReady({ ...emphatic, forms: forms({ perfect: "unverified form" }) }), false);
const uncertainEmphatic = { ...emphatic, confidence: "needs_review" as const, reviewReason: "Uncertain question meaning" };
assert.equal(prepareWordCardAdditions(fixture([uncertainEmphatic]), aggregate([uncertainEmphatic]), { sourceHash }).candidates.length, 0);

const itselfExamples = ["Das Fundament selbst wurde nicht beschädigt.", "Der Text selbst enthält die Antwort."];
const itself = { ...probability, german: "selbst", examples: itselfExamples, translations: [{ ...probability.translations[0], spanish: "mismo", examples: ["El fundamento mismo no sufrió daños.", "El texto mismo contiene la respuesta."], variant: { ...probability.translations[0].variant!, german: "selbst", examples: itselfExamples } }] };
assert.equal(reviewedWordCardCategoryReady(itself), true, "The precisely reviewed itself particle does not need a false adverb label");
assert.equal(reviewedWordCardCategoryReady(itself.translations[0].variant!, "mismo"), true);
assert.equal(prepareWordCardAdditions(fixture([itself]), aggregate([itself]), { sourceHash }).candidates.length, 1);
for (const cue of ["incluso", "hasta", "igual", "el yo", "por sí mismo", ""]) assert.equal(reviewedWordCardCategoryReady(itself.translations[0].variant!, cue), false, "The emphasis-particle allowance does not admit other meanings");
for (const german of ["Selbst", "Das Selbst", "selber", "selbe"]) assert.equal(reviewedWordCardCategoryReady({ ...itself, german }), false);
assert.equal(reviewedWordCardCategoryReady(itself.translations[0].variant!), false, "The actual Spanish cue is required");
assert.equal(reviewedWordCardCategoryReady({ ...itself, notes: "Partikel" }), false, "Internal category evidence is not a permitted visible note");
assert.equal(reviewedWordCardCategoryReady({ ...itself, forms: {} }), false);
for (const key of WORD_CARD_FORM_KEYS) assert.equal(reviewedWordCardCategoryReady({ ...itself, forms: forms({ [key]: "unverified morphology" }) }), false);
const uncertainItself = { ...itself, confidence: "needs_review" as const, reviewReason: "Emphasis requires independent review" };
assert.equal(prepareWordCardAdditions(fixture([uncertainItself]), aggregate([uncertainItself]), { sourceHash }).candidates.length, 0, "Category readiness cannot promote an uncertain semantic review");

const correctiveExamples=["Das ist doch mein Platz!","Du hast doch den Schlüssel!"];
const correctiveParticle={...probability,german:"doch",examples:correctiveExamples,translations:[{...probability.translations[0],spanish:"pero si",examples:["¡Pero si ese es mi sitio!","¡Pero si tú tienes la llave!"],variant:{...probability.translations[0].variant!,german:"doch",examples:correctiveExamples}}]};
assert.equal(reviewedWordCardCategoryReady(correctiveParticle),true,"The precisely source-checked corrective-assertion particle can retain UNKNOWN");
assert.equal(reviewedWordCardCategoryReady(correctiveParticle.translations[0].variant!,"pero si"),true);
assert.equal(prepareWordCardAdditions(fixture([correctiveParticle]),aggregate([correctiveParticle]),{sourceHash}).candidates.length,1);
for(const cue of ["pero","sí","sin embargo","todavía","probablemente",""]) assert.equal(reviewedWordCardCategoryReady(correctiveParticle.translations[0].variant!,cue),false,"Different doch homographs and particle meanings remain outside this cue policy");
for(const german of ["Doch","aber","doch noch"]) assert.equal(reviewedWordCardCategoryReady({...correctiveParticle,german}),false);
assert.equal(reviewedWordCardCategoryReady(correctiveParticle.translations[0].variant!),false);
assert.equal(reviewedWordCardCategoryReady({...correctiveParticle,notes:"Partikel"}),false);
assert.equal(reviewedWordCardCategoryReady({...correctiveParticle,forms:{}}),false);
for(const key of WORD_CARD_FORM_KEYS) assert.equal(reviewedWordCardCategoryReady({...correctiveParticle,forms:forms({[key]:"unverified morphology"})}),false);
const heldCorrectiveParticle={...correctiveParticle,confidence:"needs_review" as const,reviewReason:"Controlled fixture still needs semantic review"};
assert.equal(prepareWordCardAdditions(fixture([heldCorrectiveParticle]),aggregate([heldCorrectiveParticle]),{sourceHash}).candidates.length,0,"Readiness never upgrades semantic confidence");

const focusExamples=["Gerade diese Frage interessiert mich.","Warum fragst du gerade mich?"];
const focusParticle={...probability,german:"gerade",examples:focusExamples,translations:[{...probability.translations[0],spanish:"justamente",examples:["Justamente esta pregunta me interesa.","¿Por qué me preguntas justamente a mí?"],variant:{...probability.translations[0].variant!,german:"gerade",examples:focusExamples}}]};
assert.equal(reviewedWordCardCategoryReady(focusParticle),true,"The independently reviewed focus-particle meaning can retain its true category without inventing an ADVERB label");
assert.equal(reviewedWordCardCategoryReady(focusParticle.translations[0].variant!,"justamente"),true);
assert.equal(prepareWordCardAdditions(fixture([focusParticle]),aggregate([focusParticle]),{sourceHash}).candidates.length,1);
for(const cue of ["recto","par","ahora mismo","especialmente","justo",""]) assert.equal(reviewedWordCardCategoryReady(focusParticle.translations[0].variant!,cue),false,"Other gerade meanings remain outside the exact focus cue");
assert.equal(reviewedWordCardCategoryReady({...focusParticle,german:"Gerade"}),false,"A capitalized noun is a separate meaning");
assert.equal(reviewedWordCardCategoryReady({...focusParticle,notes:"Partikel"}),false);
assert.equal(reviewedWordCardCategoryReady({...focusParticle,forms:{}}),false);
assert.equal(reviewedWordCardCategoryReady({...focusParticle,forms:forms({plural:"Die Geraden"})}),false);
const heldFocusParticle={...focusParticle,confidence:"needs_review" as const,reviewReason:"The intended emphatic sense still requires semantic review"};
assert.equal(prepareWordCardAdditions(fixture([heldFocusParticle]),aggregate([heldFocusParticle]),{sourceHash}).candidates.length,0);

const directory = await mkdtemp(join(tmpdir(), "word-card-additions-"));
try {
  const snapshotPath = join(directory, "before.ejson"), reviewPath = join(directory, "review.json"), output = join(directory, "output");
  await writeFile(snapshotPath, before, { mode: 0o600 });
  await writeFile(reviewPath, JSON.stringify({ ...review, sourceHash: hash(before) }), { mode: 0o600 });
  const script = join(dirname(fileURLToPath(import.meta.url)), "prepareWordCardAdditions.ts");
  const cli = spawnSync(process.execPath, ["--import", "tsx", script, "--snapshot", snapshotPath, "--review", reviewPath, "--output", output], { encoding: "utf8", env: { PATH: dirname(process.execPath) } });
  assert.equal(cli.status, 0, cli.stderr);
  for (const filename of ["candidate-before.ejson", "candidates.json", "ambiguous-candidates.json", "review-queue.json", "summary.json"]) assert.equal((await stat(join(output, filename))).mode & 0o777, 0o600);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  const generated = BSON.EJSON.parse(await readFile(join(output, "candidate-before.ejson"), "utf8"));
  assert.ok(generated.collections.WORDS_DE[0]._id instanceof BSON.ObjectId);
  assert.equal(generated.collections.WORDS_DE.length, result.candidates.length);
  assert.deepEqual(generated.collections.userprogresses, []);
  const summary = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
  assert.equal(summary.sourceHash, hash(before)); assert.equal(summary.partial, false);
  const broken = spawnSync(process.execPath, ["--import", "tsx", script, "--snapshot", snapshotPath, "--review", reviewPath, "--output", output, "--mongo"], { encoding: "utf8", env: { PATH: dirname(process.execPath) } });
  assert.equal(broken.status, 1, "Database/provider options must never be accepted");
} finally { await rm(directory, { recursive: true, force: true }); }
console.log("Offline word-card addition tests passed: sense dedup, gender/NFC, safe seed reuse, bounded cardinal/idiom readiness, exclusions, privacy, complete-review guards and private CLI artifacts.");
