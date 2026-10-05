import assert from "node:assert/strict";
import { validateClauseSentence, validateWritingFeedback } from "../src/features/writing/validation.js";
const subordinateClause = "Obwohl die Geschäftsführerin nach monatelangen Gesprächen mit den Beschäftigten die Verantwortung für eine schwierige Entscheidung über die Zukunft des Unternehmens übernommen hatte";
const mainClause = "gewann sie das Vertrauen der Belegschaft nicht sofort, sondern erst durch regelmäßige, offene Gespräche über die geplanten Veränderungen";
const reference = `${subordinateClause}, ${mainClause}.`;
const main = mainClause.replace("nicht sofort", "nicht unmittelbar");
const valid = { german: `${subordinateClause}, ${main}.`, mainClause: main, subordinateClause, clauseOrder: "SUBORDINATE_FIRST", connector: "obwohl", finiteVerbs: { main: ["gewann"], subordinate: ["hatte"] } };
assert.equal(validateClauseSentence(valid).german, valid.german);
const feedback = { correct: true, score: 100, summary: "Correcto.", correctedGerman: reference, corrections: [], alternatives: [valid] };
assert.deepEqual(validateWritingFeedback(feedback, reference).alternatives, [valid.german]);
// A real Luna response added a second subordinate clause here, despite the
// requested single Hauptsatz + Nebensatz. It must not be shown as an example.
const nestedMain = "gewann sie das Vertrauen der Belegschaft nicht unmittelbar, sondern erst, nachdem sie regelmäßig und offen über die geplanten Veränderungen gesprochen hatte";
const invalid = { ...valid, mainClause: nestedMain, german: `${subordinateClause}, ${nestedMain}.` };
assert.throws(() => validateWritingFeedback({ ...feedback, alternatives: [invalid] }, reference), /one main clause and one subordinate clause/);
assert.throws(() => validateClauseSentence({ ...valid, german: "Zu kurz." }), /30–50/);
assert.throws(() => validateClauseSentence({ ...valid, german: reference }), /one main clause/);
assert.throws(() => validateWritingFeedback({ ...feedback, alternatives: [valid, valid] }, reference), /invalid/);
assert.throws(() => validateWritingFeedback({ ...feedback, alternatives: [valid.german] }, reference), /one main clause/);
assert.throws(() => validateClauseSentence({ ...valid, finiteVerbs: { main: ["gewann", "erläuterte"], subordinate: ["hatte"] } }), /one audited finite verb/);
assert.throws(() => validateClauseSentence({ ...valid, finiteVerbs: { main: ["erläuterte"], subordinate: ["hatte"] } }), /one audited finite verb/);
assert.throws(() => validateClauseSentence({ ...valid, finiteVerbs: { main: ["gewann"], subordinate: ["übernommen hatte"] } }), /one audited finite verb/);
console.log("PASS writing clause audits: valid adjective commas, unchanged public alternatives, exact fragment matching, word limits, duplicate rejection and real nested-clause regression");
