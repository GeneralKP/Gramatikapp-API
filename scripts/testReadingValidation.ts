import assert from "node:assert/strict";
import { validateFeedback, validatePage } from "../src/features/reading/validation.js";
import type { SessionVocabulary } from "../src/features/reading/reading.types.js";

const word: SessionVocabulary = { id: "misunderstanding", german: "das Missverständnis", spanish: "el malentendido", forms: {}, notes: "", failureIndex: 0 };
// Minimized from a real Luna response: the noun was present, but its audit
// copied a nominative article instead of the dative article in the prose.
const sentence = "Eine falsche Beschriftung hatte zu einem Missverständnis geführt.";
const filler = "Die Anwesenden prüften die Unterlagen sorgfältig und diskutierten mögliche Folgen für ihre gemeinsame Entscheidung. ";
const input = (example = sentence, form = "ein Missverständnis") => ({
  title: "Eine Entscheidung", german: sentence + " " + filler.repeat(28),
  spanish: "Los participantes examinaron los documentos y discutieron las consecuencias de la decisión. ".repeat(40),
  vocabulary: [{ wordId: word.id, surfaceForms: [form], example }],
});

const page = validatePage(input(), [word], 0);
assert.deepEqual(page.vocabulary[0].surfaceForms, ["einem Missverständnis"]);
assert.equal(page.german, input().german.trim(), "canonicalizing an audit cannot rewrite the story");
assert.equal(page.vocabulary[0].example, sentence);
assert.deepEqual(validatePage(input(sentence, "Missverständnis"), [word], 0).vocabulary[0].surfaceForms, ["Missverständnis"]);
assert.throws(() => validatePage(input(sentence, "kein Missverständnis"), [word], 0), /audit did not match/, "never change negation to repair an audit");
assert.throws(() => validatePage(input(sentence, "ein Verständnis"), [word], 0), /audit did not match/, "a different noun is still rejected");
assert.throws(() => validatePage(input(sentence, "ein Missverständnisse"), [word], 0), /audit did not match/, "never guess a noun inflection");
assert.throws(() => validatePage(input(sentence.replace("einem", "eines")), [word], 0), /audit did not match/, "invented examples remain rejected");
assert.throws(() => validatePage({ ...input(), vocabulary: [] }, [word], 0), /vocabulary requirements/, "missing vocabulary remains rejected");
assert.throws(() => validatePage({ ...input(), german: input().german.replace("Missverständnis", "Missverständnisse") }, [word], 0), /audit did not match/, "word boundaries cannot accept a partial noun");
console.log("PASS real article-case mismatch, unchanged prose, literal noun coverage, negation and invented/missing audit rejection");

const translation = "Todos estaban felices y no había ningún problema.";
const deletion = { score: 0, summary: "Se añadió una idea que no aparece en el original.", correctedSpanish: "Una inscripción incorrecta había provocado un malentendido.",
  corrections: [{ original: translation, corrected: "", explanation: "Elimina esta idea inventada.", category: "MEANING" }],
  omissions: [{ german: sentence, explanation: "Falta el significado de la primera frase." }],
  vocabulary: [{ wordId: word.id, understood: false, feedback: "Falta la idea del malentendido." }] };
assert.doesNotThrow(() => validateFeedback(deletion, page, translation), "deleting invented content is a valid correction");
assert.doesNotThrow(() => validateFeedback({ ...deletion, corrections: [{ ...deletion.corrections[0], original: "", corrected: deletion.correctedSpanish }] }, page, translation), "inserting wholly missing content remains valid");
assert.throws(() => validateFeedback({ ...deletion, corrections: [{ ...deletion.corrections[0], original: "" }] }, page, translation), /correction did not match/, "an empty correction is never an edit");
assert.throws(() => validateFeedback({ ...deletion, corrections: [{ ...deletion.corrections[0], original: "Una frase que el alumno no escribió." }] }, page, translation), /correction did not match/, "deletions still need a real learner excerpt");
console.log("PASS deletion/insertion corrections, empty-edit rejection and exact learner excerpt protection");
