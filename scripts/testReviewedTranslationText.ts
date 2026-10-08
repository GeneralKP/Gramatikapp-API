import assert from "node:assert/strict";
import { validateReviewedEntry, saveReviewedEntry } from "../src/features/translations/translations.service.js";

const flesh = { key: "fleisch", word: "Fleisch", translation: "carne", kind: "LEXEME", lemma: "Fleisch", category: "NOUN", form: "dictionary form", cefrLevel: "A1.2", notes: "", forms: { gender: "das", plural: "" }, target: { word: "carne", category: "NOUN", forms: { gender: "femenino", plural: "" }, cefrLevel: "A1.2", example: "La carne está hecha.", notes: "" } };
assert.equal(validateReviewedEntry(flesh, "de"), flesh, "mass nouns use empty plural fields, not negative labels");
const modal = { ...flesh, key: "können", word: "können", lemma: "können", category: "VERB", form: "infinitive", translation: "poder", notes: "hat gekonnt\nich konnte", forms: { perfect: "hat gekonnt", past: "ich konnte", imperativ: "" }, target: { ...flesh.target, word: "poder", category: "VERB", forms: { perfect: "he podido", past: "pude", imperativ: "" }, example: "Puedo ayudarte." } };
assert.equal(validateReviewedEntry(modal, "de"), modal, "unavailable modal imperatives can be empty");
assert.throws(() => validateReviewedEntry({ ...modal, forms: { ...modal.forms, past: "" } }, "de"), /past, perfect/i);
for (const entry of [
  { ...flesh, notes: "<p>Die Fleischsorten</p>" },
  { ...flesh, forms: { ...flesh.forms, plural: "Die <b>Fleischsorten</b>" } },
  { ...flesh, relatedWords: { synonyms: ["<i>Fleischwaren</i>"] } },
  { ...flesh, target: { ...flesh.target, example: "La carne&nbsp;está hecha." } },
  { ...flesh, notes: "<!-- a note -->" },
  { ...flesh, notes: "<!DOCTYPE html>" },
  { ...flesh, target: { ...flesh.target, example: "La carne est&aacute; hecha." } },
]) assert.throws(() => validateReviewedEntry(entry, "de"), /plain text/i, "nested catalog text is checked before persistence");
let openedSession = false;
await assert.rejects(() => saveReviewedEntry({} as any, { startSession: () => { openedSession = true; throw new Error("unexpected database access"); } } as any, flesh as any, "de", { origin: "MANUAL", examples: ["Fleisch<br>ist frisch."], contexts: [], phraseRefs: [] }), /plain text/i);
assert.equal(openedSession, false, "unsafe supplied examples are rejected before starting a write transaction");
console.log("PASS plain vocabulary persistence, empty unavailable forms and pre-write HTML rejection");
