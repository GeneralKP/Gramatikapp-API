import assert from "node:assert/strict";
import { clozeText, dueDate, plainText, normalizeWord, germanLexemeKey, templateFormats, collectionConfig } from "./lib/anki.js";
import { readFile } from "node:fs/promises";
import { noteContent, studyCard } from "./lib/anki.js";
import { calculateNextReview } from "../src/features/progress/progress.service.js";
const configRows = [
  { KEY: "creationOffset", val: { base64: Buffer.from("300").toString("base64") } },
  { key: "rollover", val: { base64: Buffer.from("6").toString("base64") } },
];
const decodedConfig = collectionConfig(configRows);
assert.deepEqual(decodedConfig, { creationOffset: 300, rollover: 6 });
assert.throws(() => collectionConfig([{ val: { base64: "MA==" } }]), /has no key/);
assert.equal(dueDate({ queue: 2, due: 0 }, { crt: Date.parse("2024-05-08T02:00:00Z") / 1000 }, decodedConfig, "Europe/Berlin", new Date()).toISOString(), "2024-05-07T04:00:00.000Z");
assert.equal(plainText('hat gemacht<br>ich machte<script>alert(1)</script>&nbsp;'), "hat gemacht\nich machte");
assert.equal(normalizeWord("Der Vorname", true), normalizeWord("Vorname", true));
assert.notEqual(germanLexemeKey("arm"), germanLexemeKey("Der Arm"));
assert.notEqual(germanLexemeKey("Der Jugendliche"), germanLexemeKey("Die Jugendliche"));
assert.notEqual(germanLexemeKey("unternehmen", {}, ["VERB"]), germanLexemeKey("Unternehmen", {}, ["UNKNOWN"]));
assert.equal(germanLexemeKey("Das Haus"), germanLexemeKey("Haus", { gender: "das" }, ["NOUN"]));
assert.deepEqual(clozeText("Er geht {{c1::mit::compañía}} mir {{c1::in}} die Stadt {{c2::morgen}}.", 0),
  { prompt: "Er geht [compañía] mir […] die Stadt morgen.", answer: "mit in", full: "Er geht mit mir in die Stadt morgen." });
assert.equal(dueDate({ queue: 2, due: 0 }, { crt: 1715158800 }, { creationOffset: 300 }, "Europe/Berlin", new Date()).toISOString(), "2024-05-08T02:00:00.000Z");
assert.equal(dueDate({ queue: 3, due: 0 }, { crt: 1715158800 }, { creationOffset: 300 }, "America/Bogota", new Date()).toISOString(), "2024-05-08T09:00:00.000Z");
assert.equal(dueDate({ queue: 1, due: 1791222000 }, {}, {}, "Europe/Berlin", new Date()).getTime(), 1791222000000);
const now = new Date();
assert.equal(dueDate({ queue: 0, due: 99 }, {}, {}, "Europe/Berlin", now), now);
assert.deepEqual(templateFormats({ base64: Buffer.from([10, 3, 65, 66, 67, 18, 1, 68]).toString("base64") }), { question: "ABC", answer: "D" });
console.log("PASS safe Anki parsing, cloze ordinals, directions and timezone-aware scheduling");
const imported = calculateNextReview(4, { ease: 2.95, interval: 942, repetitions: 5, preserveAnkiLimits: true });
assert.equal(imported.ease, 2.95);
assert.ok(imported.interval > 942, "imported intervals must not be silently clamped to one year");
if (process.argv[2]) {
  const { tables } = JSON.parse(await readFile(process.argv[2], "utf8"));
  const sourceConfig = collectionConfig(tables.config);
  for (const entry of tables.config) {
    assert.deepEqual(sourceConfig[entry.KEY ?? entry.key], JSON.parse(Buffer.from(entry.val.base64, "base64").toString("utf8")));
  }
  let changedDates = 0;
  for (const card of tables.cards) {
    if (dueDate(card, tables.col[0], {}, "Europe/Berlin", now).getTime() !== dueDate(card, tables.col[0], sourceConfig, "Europe/Berlin", now).getTime()) changedDates++;
  }
  console.log(`Source configuration check: ${changedDates} dates differ from default conversion`);
  const notes = new Map(tables.notes.map((note: any) => [note.id, note]));
  const directions: Record<string, number> = {};
  for (const card of tables.cards) {
    const note: any = notes.get(card.nid), content = noteContent(note, tables);
    const mapped = studyCard(card, note, tables, content);
    assert.ok(mapped.prompt && mapped.answer && mapped.acceptedAnswers.length);
    directions[mapped.direction] = (directions[mapped.direction] || 0) + 1;
  }
  console.log(`PASS all ${tables.cards.length} source cards supported: ${JSON.stringify(directions)}`);
}
