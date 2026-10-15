import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { closeDatabase, connectDatabase } from "../src/lib/database.js";
import { typeDefs } from "../src/graphql/schema.js";
import { wordsResolvers } from "../src/features/words/words.resolvers.js";
import { phrasesResolvers } from "../src/features/phrases/phrases.resolvers.js";
import { catalogPipeline } from "../src/features/levels/catalogQuery.js";

// Exercise the production resolvers; only the external MongoDB boundary is replaced.
// A nullish cached-slot check, unconditional hydration, lost reviewed metadata,
// reordered phrase words or altered catalog query must fail these characterizations.
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, "0"));
const createdAt = new Date("2026-10-15T12:00:00.000Z");
const es = { _id: id(1), word: "casa", notes: "Spanish note", createdAt };
const de = { _id: id(2), word: "Haus", notes: "German note", examples: ["Old example"], createdAt };
const phrase = { _id: id(3), phrase: "Das Haus.", words: [id(2), id(1), id(2), id(99)], contexts: [], createdAt };
const reads: { collection: string; method: string; query: unknown }[] = [];
let aggregateRows: Record<string, unknown[]> = {};
const collection = (name: string) => ({
  async createIndex() {}, async dropIndex() {},
  async findOne(query: { _id: ObjectId }) {
    reads.push({ collection: name, method: "findOne", query });
    const rows = name === "WORDS_ES" ? [es] : name === "WORDS_DE" ? [de, { ...de, _id: es._id, word: "German shadow" }] : [phrase];
    return rows.find(row => row._id.equals(query._id)) ?? null;
  },
  find(query: unknown) {
    reads.push({ collection: name, method: "find", query });
    return { project() { return this; }, async toArray() { return [{ _id: id(4) }, { _id: id(5) }]; } };
  },
  aggregate(query: unknown) {
    reads.push({ collection: name, method: "aggregate", query });
    return { async toArray() { return aggregateRows[name] ?? []; } };
  },
});
const originalConnect = MongoClient.prototype.connect;
const originalDb = MongoClient.prototype.db;
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = function () { return { collection } as never; };
try { await connectDatabase(); } finally {
  MongoClient.prototype.connect = originalConnect;
  MongoClient.prototype.db = originalDb;
}
const schema = makeExecutableSchema({ typeDefs, resolvers: {
  Query: { ...wordsResolvers.Query, ...phrasesResolvers.Query },
  Word: wordsResolvers.Word, WordRelation: wordsResolvers.WordRelation,
  NewPhrase: phrasesResolvers.NewPhrase, PhraseRelation: phrasesResolvers.PhraseRelation,
} });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

try {
  const base = { _id: id(4), main: id(1), translated: id(2), createdAt, retained: "metadata" };
  const hydrationCases = [
    { row: { ...base, mainDocs: [es, de], translatedDocs: [de, es] }, want: { mainDoc: es, translatedDoc: de } },
    { row: { ...base, mainDocs: [], translatedDocs: [] }, want: {} },
    { row: { ...base, mainDocs: [], translatedDocs: [], mainDoc: es, translatedDoc: null }, want: { mainDoc: es, translatedDoc: null } },
    { row: { ...base, mainDoc: undefined, translatedDoc: de }, want: { mainDoc: undefined, translatedDoc: de } },
    { row: { ...base, mainDocs: null, translatedDocs: undefined }, want: {} },
  ];
  const callers = [
    { collection: "WORDS_ES_DE", run: () => wordsResolvers.Query.wordRelations(null, {}, null) },
    { collection: "WORDS_ES_DE", run: () => wordsResolvers.Query.wordRelationsWithoutPhrases(null, {}) },
    { collection: "PHRASES_ES_DE", run: () => phrasesResolvers.Query.phraseRelations(null, {}, null) },
  ];
  for (const caller of callers) {
    const input = hydrationCases.map(({ row }) => row);
    const before = json(input);
    aggregateRows = { [caller.collection]: input };
    reads.length = 0;
    const result = await caller.run();
    assert.equal(reads.length, 1, "Hydration must not introduce additional database requests");
    assert.deepEqual(json(input), before, "Hydration must not mutate aggregate results");
    for (const [index, { row, want }] of hydrationCases.entries()) {
      assert.deepEqual(result[index], { ...row, ...want, id: String(id(4)), createdAt: createdAt.toISOString() });
      for (const slot of ["mainDoc", "translatedDoc"]) {
        assert.equal(slot in result[index], slot in row || slot in want, "Empty joins must preserve missing versus explicitly undefined cached slots");
      }
    }
  }

  for (const resolvers of [wordsResolvers.WordRelation, phrasesResolvers.PhraseRelation]) {
    for (const [field, slot, sourceId, expectedCollection] of [
      ["main", "mainDoc", id(1), resolvers === wordsResolvers.WordRelation ? "WORDS_ES" : "PHRASES_ES"],
      ["translated", "translatedDoc", id(2), resolvers === wordsResolvers.WordRelation ? "WORDS_DE" : "PHRASES_DE"],
    ] as const) {
      const resolve = resolvers[field];
      for (const value of [null, undefined]) {
        reads.length = 0;
        assert.equal(await resolve({ [slot]: value } as never), null);
        assert.equal(reads.length, 0, "Explicit null/undefined joined references suppress fallback reads");
        assert.equal(await resolve(Object.create({ [slot]: value })), null, "Inherited cached slots retain property-presence semantics");
        assert.equal(reads.length, 0);
      }
      reads.length = 0;
      await resolve({ [field]: sourceId } as never);
      assert.deepEqual(reads, [{ collection: expectedCollection, method: "findOne", query: { _id: sourceId } }]);
    }
  }

  const study = { version: 1, german: "Das Zuhause", spanish: "el hogar", notes: "", forms: { gender: "das" }, category: "NOUN", germanExamples: ["Mein Zuhause."], spanishExamples: [] };
  const reviewed = { ...base, study, mainDoc: es, translatedDoc: de };
  reads.length = 0;
  const german = await wordsResolvers.WordRelation.translated(reviewed as never);
  const spanish = await wordsResolvers.WordRelation.main(reviewed as never);
  assert.equal(reads.length, 0);
  assert.deepEqual(json(german), { ...json(de), id: String(de._id), word: "Das Zuhause", notes: "", examples: ["Mein Zuhause."], forms: { gender: "das" }, gramaticalCategories: ["NOUN"] });
  assert.deepEqual(json(spanish), { ...json(es), id: String(es._id), word: "el hogar", examples: [] });
  assert.equal((await wordsResolvers.Query.word(null, { lang: "de", id: String(de._id) }))?.word, "Haus", "Direct word lookup retains raw dictionary spelling");

  reads.length = 0;
  const phraseWords = await phrasesResolvers.NewPhrase.words(phrase as never);
  assert.deepEqual(phraseWords.map(word => word.word), ["Haus", "casa", "Haus"], "Phrase words retain original order, duplicates and missing-reference skipping");
  assert.deepEqual(reads.map(read => read.collection), ["WORDS_ES", "WORDS_DE", "WORDS_ES", "WORDS_ES", "WORDS_DE", "WORDS_ES", "WORDS_DE"]);
  for (const words of [undefined, null, []]) assert.deepEqual(await phrasesResolvers.NewPhrase.words({ words } as never), []);
  for (const value of [wordsResolvers.Word.level, phrasesResolvers.NewPhrase.level]) {
    assert.equal(value({ cefrLevel: "B1.2", level: "C2" } as never), "B1");
    assert.equal(value({ level: "A2" } as never), "A2");
    assert.equal(value({} as never), null);
  }

  reads.length = 0;
  assert.equal(await wordsResolvers.Word.failureIndex({ id: String(de._id) } as never, null, { user: null }), 0);
  assert.equal(reads.length, 0, "Anonymous failure counts do not query MongoDB");
  aggregateRows = { userprogresses: [{ failureIndex: 7 }] };
  assert.equal(await wordsResolvers.Word.failureIndex({ id: String(de._id) } as never, null, { user: { _id: id(8) } } as never), 7);
  assert.deepEqual(reads, [
    { collection: "WORDS_ES_DE", method: "find", query: { $or: [{ main: id(2) }, { translated: id(2) }] } },
    { collection: "userprogresses", method: "aggregate", query: [
      { $match: { userId: id(8), $or: [{ relationId: { $in: [id(4), id(5)] } }, { itemId: { $in: [id(4), id(5)] } }] } },
      { $group: { _id: null, failureIndex: { $sum: { $ifNull: ["$failureIndex", 0] } } } },
    ] },
  ]);

  // Boundary pipeline expectations are hand-derived: the production helper does
  // not calculate its own expected projection, regex, page or ordering.
  const phrasePipeline = catalogPipeline({ search: "  a.*[b]  ", cefrLevel: "A1.2", limit: 0, offset: -1 }, "PHRASES_ES", "PHRASES_DE", "phrase", { _id: 1 });
  assert.deepEqual(phrasePipeline, [
    { $lookup: { from: "PHRASES_ES", localField: "main", foreignField: "_id", as: "mainDocs" } },
    { $lookup: { from: "PHRASES_DE", localField: "translated", foreignField: "_id", as: "translatedDocs" } },
    { $match: { $or: [{ "mainDocs.phrase": { $regex: "a\\.\\*\\[b\\]", $options: "i" } }, { "translatedDocs.phrase": { $regex: "a\\.\\*\\[b\\]", $options: "i" } }], "translatedDocs.cefrLevel": "A1.2" } },
    { $sort: { "translatedDocs.phrase": 1, _id: 1 } }, { $skip: 0 }, { $limit: 1 }, { $project: { _id: 1 } },
  ]);
  const wordPipeline = catalogPipeline({ search: "a+b", limit: 501, offset: 3 }, "WORDS_ES", "WORDS_DE", "word");
  assert.deepEqual(wordPipeline.map(stage => Object.keys(stage)[0]), ["$lookup", "$lookup", "$set", "$match", "$sort", "$skip", "$limit", "$unset"]);
  assert.deepEqual(wordPipeline[3], { $match: { $or: [
    { "mainDocs.word": { $regex: "a\\+b", $options: "i" } }, { "translatedDocs.word": { $regex: "a\\+b", $options: "i" } },
    { __catalogGerman: { $regex: "a\\+b", $options: "i" } }, { __catalogSpanish: { $regex: "a\\+b", $options: "i" } },
  ] } });
  assert.deepEqual(wordPipeline.slice(4), [{ $sort: { __catalogGerman: 1, _id: 1 } }, { $skip: 3 }, { $limit: 500 }, { $unset: ["__catalogGerman", "__catalogSpanish"] }]);
  assert.throws(() => catalogPipeline({ cefrLevel: "A1" }, "es", "de", "word"), /Invalid CEFR level/);
  assert.throws(() => catalogPipeline({ search: "a".repeat(201) }, "es", "de", "word"), /Search must be 200 characters or fewer/);

  aggregateRows = { WORDS_ES_DE: [{ ...base, study, mainDocs: [es], translatedDocs: [de] }] };
  reads.length = 0;
  const response = await graphql({ schema, source: "query($details:Boolean!){wordRelations{key:id main{word examples} translated{word notes @include(if:$details) forms{gender} gramaticalCategories}}}", variableValues: { details: true } });
  assert.equal(response.errors, undefined);
  assert.deepEqual(json(response.data), { wordRelations: [{ key: String(id(4)), main: { word: "el hogar", examples: [] }, translated: { word: "Das Zuhause", notes: "", forms: { gender: "das" }, gramaticalCategories: ["NOUN"] } }] });
  assert.equal(reads.length, 1, "Selected joined fields must not perform per-word fallback reads");
  const pipeline = reads[0].query as Record<string, unknown>[];
  assert.deepEqual(pipeline.at(-1), { $project: {
    _id: 1, main: 1, translated: 1, "mainDocs._id": 1, "study.version": 1, "study.german": 1, "study.spanish": 1, "study.notes": 1,
    "mainDocs.word": 1, "study.spanishExamples": 1, "mainDocs.examples": 1, "translatedDocs._id": 1, "translatedDocs.word": 1,
    "translatedDocs.notes": 1, "study.forms": 1, "translatedDocs.forms": 1, "study.category": 1, "translatedDocs.gramaticalCategories": 1,
  } });
  console.log("PASS catalog resolver cached slots, three hydration callers, projected documents, reviewed content, phrase order, failure ownership and exact query contracts");
} finally { await closeDatabase(); }
