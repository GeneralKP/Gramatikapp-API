import assert from "node:assert/strict";
import { BSON, ObjectId } from "mongodb";
import type { Database } from "../src/lib/database.js";
import { processSeedData, type SeedDataInput } from "../src/features/phrases/seedService.js";
import { catalogSummaryCache } from "../src/features/progress/catalogSummaryCache.js";

type Row = Record<string, any> & { _id: ObjectId };
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, "0"));
const archivedAt = new Date("2024-01-01T00:00:00.000Z");
const json = (value: unknown) => BSON.EJSON.stringify(value, { relaxed: false });
function fixture(failAt?: string) {
  const rows: Record<string, Row[]> = {
    wordsDE: [{ _id: id(1), word: "alt", notes: "Keep original", createdAt: archivedAt }],
    wordsES: [{ _id: id(2), word: "viejo", notes: "Keep original", createdAt: archivedAt }],
    phrasesDE: [{ _id: id(3), phrase: "Alt.", words: [id(1)], createdAt: archivedAt }],
    phrasesES: [{ _id: id(4), phrase: "Viejo.", words: [id(2)], createdAt: archivedAt }],
    relationsWordsEsDe: [{ _id: id(5), main: id(2), translated: id(1), createdAt: archivedAt }],
    relationsPhrasesEsDe: [{ _id: id(6), main: id(4), translated: id(3), createdAt: archivedAt }],
  };
  const original = Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values.map(json)]));
  const calls: string[] = [];
  let loads = 0;
  const db = {} as Database;
  const readCatalog = () => catalogSummaryCache.read(db, "wordTextDe", async () => {
    loads++;
    return rows.wordsDE.map(row => ({ word: row.word }));
  });
  let firstRead = true;
  for (const [name, documents] of Object.entries(rows)) {
    (db as any)[name] = {
      async findOne(query: Record<string, unknown>) {
        const value = query.word ?? query.phrase ?? `${query.main}:${query.translated}`;
        calls.push(`${name}.find:${value}`);
        if (firstRead) {
          firstRead = false;
          await readCatalog();
          assert.equal(loads, 2, "The old catalog must be invalidated before the first seed read");
        }
        if (`${name}:${value}` === failAt) throw new Error("Seed fixture insertion interrupted");
        return documents.find(row => Object.entries(query).every(([key, expected]) => String(row[key]) === String(expected))) ?? null;
      },
      async insertOne(document: Row) {
        calls.push(`${name}.insert:${document.word ?? document.phrase ?? "relation"}`);
        documents.push(document);
        return { insertedId: document._id };
      },
    };
  }
  return { db, rows, original, calls, readCatalog, loads: () => loads };
}

const word = (tempId: string, text: string) => ({ tempId, word: text, gramaticalCategories: ["NOUN"], examples: [`${text} example`],
  relatedWords: { synonyms: ["synonym"] }, forms: { gender: "das", plural: "Häuser" }, contexts: ["work"], level: "A2", notes: "New note" });
const input: SeedDataInput = {
  words_de: [word("shared", "alt"), word("de", "Haus"), word("de-repeat", "Haus")],
  words_es: [word("shared", "viejo"), { ...word("es", "casa"), examples: undefined! }],
  word_relations: [{ main: "shared", translated: "de" }, { main: "shared", translated: "de" },
    { main: "missing", translated: "de" }, { main: "shared", translated: "missing" }],
  phrases_de: [{ tempId: "old-phrase-de", phrase: "Alt.", contexts: [] },
    { tempId: "de-phrase", phrase: "Ein Haus.", wordRefs: ["de", "missing", "shared", "de"],
      synonyms: ["Das Haus."], perWordExplanation: { Haus: { missing: "article" } }, level: "B1", contexts: ["work"] }],
  phrases_es: [{ tempId: "old-phrase-es", phrase: "Viejo.", contexts: [] },
    { tempId: "es-phrase", phrase: "Una casa.", wordRefs: ["es"], contexts: [] }],
  phrase_relations: [{ main: "es-phrase", translated: "de-phrase" }, { main: "es-phrase", translated: "de-phrase" },
    { main: "old-phrase-es", translated: "old-phrase-de" }, { main: "missing", translated: "de-phrase" }],
};

const f = fixture();
await f.readCatalog();
const beforeInput = json(input);
const warnings: string[] = [];
const warn = console.warn;
console.warn = (...values) => { warnings.push(values.join(" ")); };
let result: Awaited<ReturnType<typeof processSeedData>>;
try { result = await processSeedData(f.db, input); }
finally { console.warn = warn; }
assert.deepEqual(result!, { wordsCreated: 2, wordsSkipped: 3, phrasesCreated: 2, phrasesSkipped: 2, relationsCreated: 2,
  details: { wordsCreatedList: ["[DE] Haus", "[ES] casa"], wordsSkippedList: ["[DE] alt", "[DE] Haus", "[ES] viejo"],
    phrasesCreatedList: ["[DE] Ein Haus.", "[ES] Una casa."], phrasesSkippedList: ["[DE] Alt.", "[ES] Viejo."] } });
assert.deepEqual(warnings, [
  "⚠ Word relation skipped — unresolved tempIds: main=missing, translated=de",
  "⚠ Word relation skipped — unresolved tempIds: main=shared, translated=missing",
  "⚠ Phrase relation skipped — unresolved tempIds: main=missing, translated=de-phrase",
]);
assert.equal(json(input), beforeInput, "Seeding does not rewrite the supplied input");
for (const [name, originals] of Object.entries(f.original)) {
  assert.deepEqual(f.rows[name].slice(0, originals.length).map(json), originals, `${name} existing documents stay untouched`);
}
const haus = f.rows.wordsDE[1], casa = f.rows.wordsES[1];
assert.deepEqual({ ...haus, _id: undefined, createdAt: undefined }, {
  _id: undefined, createdAt: undefined, word: "Haus", gramaticalCategories: ["NOUN"], examples: ["Haus example"],
  relatedWords: { synonyms: ["synonym"] }, forms: { gender: "das", plural: "Häuser" }, contexts: ["work"], level: "A2", notes: "New note",
});
assert.deepEqual(casa.examples, [], "Missing examples retain the importer's empty-array fallback");
assert.deepEqual(f.rows.phrasesDE[1].words.map(String), [String(haus._id), String(id(2)), String(haus._id)],
  "Last duplicate tempId wins across languages; unresolved refs are dropped without reordering or deduplication");
assert.deepEqual(f.rows.phrasesDE[1].perWordExplanation, { Haus: { missing: "article" } });
assert.deepEqual(f.rows.phrasesES[1].synonyms, []);
assert.deepEqual(f.rows.relationsWordsEsDe[1].main, id(2));
assert.deepEqual(f.rows.relationsWordsEsDe[1].translated, haus._id);
assert.deepEqual(f.rows.relationsPhrasesEsDe[1].main, f.rows.phrasesES[1]._id);
assert.deepEqual(f.rows.relationsPhrasesEsDe[1].translated, f.rows.phrasesDE[1]._id);
assert.ok(Object.values(f.rows).flat().every(row => row.createdAt instanceof Date));
assert.deepEqual(f.calls, [
  "wordsDE.find:alt", "wordsDE.find:Haus", "wordsDE.insert:Haus", "wordsDE.find:Haus",
  "wordsES.find:viejo", "wordsES.find:casa", "wordsES.insert:casa",
  `relationsWordsEsDe.find:${id(2)}:${haus._id}`, "relationsWordsEsDe.insert:relation", `relationsWordsEsDe.find:${id(2)}:${haus._id}`,
  "phrasesDE.find:Alt.", "phrasesDE.find:Ein Haus.", "phrasesDE.insert:Ein Haus.",
  "phrasesES.find:Viejo.", "phrasesES.find:Una casa.", "phrasesES.insert:Una casa.",
  `relationsPhrasesEsDe.find:${f.rows.phrasesES[1]._id}:${f.rows.phrasesDE[1]._id}`, "relationsPhrasesEsDe.insert:relation",
  `relationsPhrasesEsDe.find:${f.rows.phrasesES[1]._id}:${f.rows.phrasesDE[1]._id}`, `relationsPhrasesEsDe.find:${id(4)}:${id(3)}`,
], "Preserve sequential writes and cross-stage reference visibility");
assert.deepEqual(await f.readCatalog(), [{ word: "alt" }, { word: "Haus" }]);
assert.equal(f.loads(), 3, "Successful insertion invalidates the in-flight catalog generation");

const storedBeforeRetry = json(f.rows), callsBeforeRetry = f.calls.length;
console.warn = () => undefined;
let retried: Awaited<ReturnType<typeof processSeedData>>;
try { retried = await processSeedData(f.db, input); }
finally { console.warn = warn; }
assert.deepEqual(retried!, { wordsCreated: 0, wordsSkipped: 5, phrasesCreated: 0, phrasesSkipped: 4, relationsCreated: 0,
  details: { wordsCreatedList: [], phrasesCreatedList: [],
    wordsSkippedList: ["[DE] alt", "[DE] Haus", "[DE] Haus", "[ES] viejo", "[ES] casa"],
    phrasesSkippedList: ["[DE] Alt.", "[DE] Ein Haus.", "[ES] Viejo.", "[ES] Una casa."] } });
assert.equal(json(f.rows), storedBeforeRetry, "Retrying an import preserves every existing document, ID and timestamp");
assert.ok(f.calls.slice(callsBeforeRetry).every(call => !call.includes(".insert:")), "Existing word and phrase relations are reused on retry");

const partial = fixture("wordsES:stop");
await partial.readCatalog();
await assert.rejects(processSeedData(partial.db, { words_de: [word("new", "Neu")], words_es: [word("stop", "stop")] } as SeedDataInput), /interrupted/);
assert.deepEqual(partial.calls, ["wordsDE.find:Neu", "wordsDE.insert:Neu", "wordsES.find:stop"]);
assert.equal(partial.rows.wordsDE[1].word, "Neu", "Earlier committed inserts survive a later failure");
assert.deepEqual(await partial.readCatalog(), [{ word: "alt" }, { word: "Neu" }]);
assert.equal(partial.loads(), 3, "Partial failures invalidate stale catalog state in finally");

const empty = fixture();
await empty.readCatalog();
const emptyResult = await processSeedData(empty.db, {} as SeedDataInput);
assert.deepEqual(emptyResult, { wordsCreated: 0, wordsSkipped: 0, phrasesCreated: 0, phrasesSkipped: 0, relationsCreated: 0,
  details: { wordsCreatedList: [], wordsSkippedList: [], phrasesCreatedList: [], phrasesSkippedList: [] } });
assert.deepEqual(empty.calls, [], "Missing optional JSON sections remain an empty import");
await empty.readCatalog();
assert.equal(empty.loads(), 2);
console.log("PASS bilingual seed results, document/reference fidelity, duplicate identities, ordered stages, warnings and success/partial-failure cache freshness");
