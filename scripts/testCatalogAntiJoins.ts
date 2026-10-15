import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BSON, MongoClient, MongoServerError, ObjectId } from "mongodb";
import { catalogAntiJoinTarget } from "./fixtures/catalogAntiJoinTarget.js";

const name = `catalog_anti_join_tests_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
for (const unsafe of [
  "mongodb+srv://example.invalid", "mongodb://example.invalid:27028", "mongodb://127.0.0.1.example.invalid:27028",
  "mongodb://localhost:27028", "mongodb://127.0.0.1:27029", "mongodb://user:password@127.0.0.1:27028",
  "mongodb://127.0.0.1:27028/gramatikapp", "mongodb://127.0.0.1:27028/admin",
  "mongodb://127.0.0.1:27028/?directConnection=false", "mongodb://127.0.0.1:27028/?replicaSet=production",
  "mongodb://127.0.0.1:27028/?authSource=admin", "mongodb://127.0.0.1:27028/#fragment", " mongodb://127.0.0.1:27028",
  "mongodb://127.0.0.1:27028,example.invalid:27028",
]) assert.throws(() => catalogAntiJoinTarget(unsafe, name));
assert.throws(() => catalogAntiJoinTarget("mongodb://127.0.0.1:27028", "gramatikapp"));
process.env.MONGODB_URI = catalogAntiJoinTarget(process.env.TEST_CATALOG_ANTI_JOIN_URI ?? "mongodb://127.0.0.1:27017", name);
console.log("PASS pre-import unsafe-target rejection; numeric loopback, unique database, directConnection");

type Read = { collection: string; pipeline: any[]; replyBytes: number; requestBytes: number };
let reads: Read[] | undefined;
const pending = new Map<number, Read>();
const originalDb = MongoClient.prototype.db, originalConnect = MongoClient.prototype.connect;
const clients = new Set<MongoClient>();
let fixtureClient: MongoClient | undefined;
let closeDatabase: (() => Promise<void>) | undefined;
try {
MongoClient.prototype.db = function (databaseName?: string, options?: any) {
  assert.ok(databaseName === undefined || databaseName === "gramatikapp" || databaseName === name, "Keep all application access inside the owned fixture");
  return originalDb.call(this, name, options);
};
MongoClient.prototype.connect = async function () {
  clients.add(this);
  this.monitorCommands = true;
  this.on("commandStarted", event => {
    if (!reads || !["aggregate", "getMore"].includes(event.commandName)) return;
    assert.equal(event.databaseName, name);
    const row = { collection: event.command.aggregate ?? "getMore", pipeline: event.command.pipeline ?? [], replyBytes: 0, requestBytes: BSON.calculateObjectSize(event.command) };
    reads.push(row); pending.set(event.requestId, row);
  });
  this.on("commandSucceeded", event => {
    const row = pending.get(event.requestId);
    if (row) { row.replyBytes = BSON.calculateObjectSize(event.reply); pending.delete(event.requestId); }
  });
  this.on("commandFailed", event => pending.delete(event.requestId));
  const connected = await originalConnect.call(this);
  fixtureClient = this;
  return connected;
};
// Only now may dotenv/application code load or a connection occur.
const databaseModule = await import("../src/lib/database.js");
closeDatabase = databaseModule.closeDatabase;
const { connectDatabase, getDatabaseClient } = databaseModule;
const { wordsResolvers: current } = await import("../src/features/words/words.resolvers.js");
const { wordsResolvers: baseline } = await import("./fixtures/catalogAntiJoinBaseline.js");
let db = await connectDatabase();
assert.equal(db.wordsES.dbName, name);
assert.match((await originalDb.call(getDatabaseClient(), "admin").command({ buildInfo: 1 })).version, /^8\./, "Use actual MongoDB 8");
const oid = (n: number) => new ObjectId(n.toString(16).padStart(24, "0"));
const now = new Date("2026-10-14T00:00:00.000Z");
const indexes = [
  { collection: "WORDS_ES_DE", key: { main: 1 }, name: "catalog_anti_join_main" },
  { collection: "WORDS_ES_DE", key: { translated: 1 }, name: "catalog_anti_join_translated" },
  { collection: "PHRASES_ES", key: { words: 1 }, name: "catalog_anti_join_words" },
  { collection: "PHRASES_DE", key: { words: 1 }, name: "catalog_anti_join_words" },
];
const fixtureDb = () => getDatabaseClient().db(name);
async function clearCatalog() {
  assert.equal(fixtureDb().databaseName, name);
  for (const collection of [db.wordsES, db.wordsDE, db.relationsWordsEsDe, db.phrasesES, db.phrasesDE]) await collection.deleteMany({});
}
async function removeFixtureIndexes() {
  assert.equal(fixtureDb().databaseName, name);
  for (const { collection, name: indexName } of indexes) {
    const coll = fixtureDb().collection(collection);
    if ((await coll.listIndexes().toArray()).some(index => index.name === indexName)) await coll.dropIndex(indexName);
  }
}
const word = (n: number, language: string) => ({ _id: oid((language === "ES" ? 10000 : 20000) + n), word: `${language}${n}`,
  notes: `Rich dictionary notes\n${"detail ".repeat(80)}`, forms: { gender: "das", plural: "Wörter", perfect: "gelernt" },
  examples: ["First exact example", "Second exact example"], contexts: ["fixture", "work"], relatedWords: { synonyms: ["other"] },
  gramaticalCategories: ["NOUN"], cefrLevel: "B1.2", createdAt: now, updatedAt: now });
const relation = (n: number, extra: any = {}) => ({ _id: oid(30000 + n), main: oid(10000 + n), translated: oid(20000 + n), createdAt: now,
  study: { version: 1, german: `das Reviewed ${n}`, spanish: `Reviewed ${n}`, notes: "Reviewed notes\nExact newlines", examples: ["Ein Beispiel.\nUn ejemplo."], germanExamples: ["Ein Beispiel."], spanishExamples: ["Un ejemplo."], category: "NOUN", forms: { gender: "das" }, auditedAt: now }, ...extra });
async function measured<T>(work: () => Promise<T>) {
  assert.equal(reads, undefined); const commands: Read[] = []; reads = commands;
  try { return { result: await work(), commands, replyBytes: commands.reduce((sum, row) => sum + row.replyBytes, 0), requestBytes: commands.reduce((sum, row) => sum + row.requestBytes, 0) }; }
  finally { reads = undefined; }
}
async function fieldResult(resolvers: any, parent: any, field: string) {
  try { return { value: await resolvers.WordRelation[field](parent) }; }
  catch (error) { return { error: { name: error.name, message: error.message } }; }
}
async function comparePublic(label: string, operation: string, args: any) {
  const before = await baseline.Query[operation](null, args), after = await current.Query[operation](null, args);
  assert.deepEqual(after, before, `${label}: full ordered resolver output including BSON types and rich content`);
  if (operation === "wordRelationsWithoutPhrases") {
    for (let i = 0; i < after.length; i++) {
      for (const field of ["main", "translated"]) assert.deepEqual(await fieldResult(current, after[i], field), await fieldResult(baseline, before[i], field), `${label}: ${field} public hydration`);
    }
  }
  return after;
}
function lookupStats(explain: any) {
  const classic = (explain.stages ?? []).filter((stage: any) => stage.$lookup).map((stage: any) => ({
    from: stage.$lookup.from, foreignField: stage.$lookup.foreignField, totalDocsExamined: Number(stage.totalDocsExamined ?? 0),
    totalKeysExamined: Number(stage.totalKeysExamined ?? 0), collectionScans: Number(stage.collectionScans ?? 0), indexesUsed: stage.indexesUsed ?? [],
  }));
  // Mongo 8 may absorb the first equality lookup into SBE's cursor. Count its
  // foreign scan leaves by query-plan node ID, without counting the local scan
  // or recursively summing cumulative parent execution counters twice.
  const cursor = explain.stages?.find((stage: any) => stage.$cursor)?.$cursor ?? explain;
  const nodes: any[] = [], plans: any[] = [];
  const walk = (node: any, result: any[]) => {
    if (!node || typeof node !== "object") return;
    if (node.stage) result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, result));
      else if (value && typeof value === "object") walk(value, result);
    }
  };
  walk(cursor.queryPlanner?.winningPlan?.queryPlan, plans);
  walk(cursor.executionStats?.executionStages, nodes);
  const sbe = plans.filter(plan => plan.stage === "EQ_LOOKUP").map(plan => {
    const scans = nodes.filter(node => node.planNodeId === plan.planNodeId && node.stage === "scan");
    return { from: plan.foreignCollection.split(".").at(-1), foreignField: plan.foreignField,
      totalDocsExamined: scans.reduce((sum, node) => sum + Number(node.numReads), 0), totalKeysExamined: 0,
      collectionScans: scans.reduce((sum, node) => sum + Number(node.opens), 0), indexesUsed: [], strategy: plan.strategy };
  });
  return [...sbe, ...classic];
}
async function explainRead(read: Read) {
  return fixtureDb().collection(read.collection).aggregate(read.pipeline).explain("executionStats");
}
const failures: string[] = [];
const budget = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const es = Array.from({ length: 240 }, (_, n) => word(n, "ES")), de = Array.from({ length: 240 }, (_, n) => word(n, "DE"));
  await db.wordsES.insertMany(es as any); await db.wordsDE.insertMany(de as any);
  await db.wordsES.insertOne({ ...es[121], _id: es[121]._id.toString(), word: "ES string identity" } as any);
  await db.wordsDE.insertOne({ ...de[121], _id: de[121]._id.toString(), word: "DE string identity" } as any);
  const regular = Array.from({ length: 120 }, (_, n) => relation(n));
  const edge = [relation(240, { main: null, translated: null }), relation(241, { main: undefined, translated: undefined }),
    relation(242, { main: es[121]._id.toString(), translated: de[121]._id.toString() }),
    relation(243, { main: [es[122]._id, es[123]._id], translated: [de[122]._id, de[123]._id] }),
    relation(244, { main: [], translated: [] }), relation(245, { main: oid(900001), translated: oid(900002) }),
    relation(246, { main: "invalid string", translated: "other invalid string" }),
    relation(247, { main: es[0]._id, translated: de[0]._id }), // duplicate endpoints
    relation(248, { main: es[124]._id, translated: de[124]._id }),
    relation(249, { main: [null, es[125]._id], translated: [de[125]._id] }),
    relation(250, { main: ["typed", es[126]._id], translated: ["typed", de[126]._id] })];
  delete edge[1].main; delete edge[1].translated;
  await db.relationsWordsEsDe.insertMany([...regular, ...edge] as any);
  for (const [collection, words] of [[db.phrasesES, es], [db.phrasesDE, de]] as const) {
    await collection.insertMany([
      ...Array.from({ length: 90 }, (_, n) => ({ _id: oid(40000 + n), words: [words[n]._id, words[n]._id], phrase: `phrase${n}` })),
      { _id: oid(40100), words: [] }, { _id: oid(40101) }, { _id: oid(40102), words: null },
      { _id: oid(40103), words: [null, words[122]._id] },
      { _id: oid(40104), words: [words[124]._id.toString()] }, // BSON string must not match ObjectId
      { _id: oid(40105), words: ["typed", words[126]._id] },
    ] as any);
  }
  for (const limit of [undefined, 1, 20, 100]) {
    for (const lang of ["ES", "DE", "es", "de"]) await comparePublic(`words ${lang}/${limit ?? "omitted"}`, "wordsWithoutTranslation", { lang, ...(limit === undefined ? {} : { limit }) });
    await comparePublic(`relations/${limit ?? "omitted"}`, "wordRelationsWithoutPhrases", limit === undefined ? {} : { limit });
  }
  for (const [operation, args] of [["wordsWithoutTranslation", { lang: "ES", limit: 0 }], ["wordsWithoutTranslation", { lang: "DE", limit: 0 }], ["wordRelationsWithoutPhrases", { limit: 0 }]] as const) {
    await assert.rejects(() => baseline.Query[operation](null, args as any), MongoServerError, "The baseline sends its invalid limit to MongoDB");
    reads = [];
    try {
      await assert.rejects(() => current.Query[operation](null, args as any), /Choose a catalog limit from 1 to 500/);
      assert.deepEqual(reads, [], "Invalid public bounds must be rejected before any MongoDB query");
    } finally { reads = undefined; }
  }
  const orphanWords = await current.Query.wordsWithoutTranslation(null, { lang: "ES", limit: 100 });
  assert.equal(orphanWords[0].id, es[120]._id.toString(), "Result limit must follow all earlier linked words");
  assert.ok(orphanWords.some(row => row.id === es[121]._id.toString()), "Typed endpoint strings must not match ObjectIds");
  assert.ok(!orphanWords.some(row => [122, 123, 125, 126].some(n => row.id === es[n]._id.toString())), "Array endpoint elements retain Mongo equality semantics");
  const orphanRelations = await current.Query.wordRelationsWithoutPhrases(null, { limit: 100 });
  assert.equal(orphanRelations[0].id, regular[90]._id.toString(), "Relation limit follows anti-join eligibility");
  assert.ok(orphanRelations.some(row => row.id === edge[8]._id.toString()), "Phrase string keys do not match ObjectId relation endpoints");
  assert.ok(!orphanRelations.some(row => [0, 1, 3, 9, 10].some(n => row.id === edge[n]._id.toString())), "Null, missing and array endpoints retain phrase equality semantics");
  console.log("PASS exact ordered ES/DE public results and hydration, duplicate/missing/null/typed/array endpoints, phrase arrays, valid limits omitted/1/20/100 and invalid zero rejected before MongoDB");

  // At least 6k word/relation/phrase rows expose real nested foreign COLLSCAN work.
  await clearCatalog();
  const count = 12000;
  await db.wordsES.insertMany(Array.from({ length: count }, (_, n) => word(n, "ES")) as any);
  await db.wordsDE.insertMany(Array.from({ length: count }, (_, n) => word(n, "DE")) as any);
  await db.relationsWordsEsDe.insertMany(Array.from({ length: count }, (_, n) => relation(n,
    n >= 200 && n < 400 ? { main: oid(100000 + n), translated: oid(200000 + n) }
      : n >= 100 && n < 200 ? { main: oid(700000 + n) } : {})) as any);
  await db.relationsWordsEsDe.insertMany(Array.from({ length: 2400 }, (_, n) => relation(count + n, { main: oid(10000 + n % 200), translated: oid(20000 + n % 200) })) as any);
  for (const [collection, offset] of [[db.phrasesES, 10000], [db.phrasesDE, 20000]] as const) {
    await collection.insertMany(Array.from({ length: count }, (_, n) => ({ _id: oid(40000 + n), words: [oid((n >= 200 && n < 400 ? 800000 : offset) + n)], phrase: `fixture${n}`, notes: "phrase details" })) as any);
    await collection.insertMany(Array.from({ length: 2400 }, (_, n) => ({ _id: oid(40000 + count + n), words: [oid(offset + n % 200)], phrase: `duplicate${n}` })) as any);
  }
  await removeFixtureIndexes();
  const operations = [
    { label: "words-ES", operation: "wordsWithoutTranslation", args: { lang: "ES", limit: 100 } },
    { label: "words-DE", operation: "wordsWithoutTranslation", args: { lang: "DE", limit: 100 } },
    { label: "relations", operation: "wordRelationsWithoutPhrases", args: { limit: 100 } },
  ];
  const before = [];
  for (const item of operations) {
    const measurement = await measured(() => baseline.Query[item.operation](null, item.args as any));
    before.push({ ...measurement, stats: lookupStats(await explainRead(measurement.commands[0])) });
  }
  // Test the real existing initializer, rather than installing indexes only in test code.
  await closeDatabase(); db = await connectDatabase();
  for (const index of indexes) {
    const found = (await fixtureDb().collection(index.collection).listIndexes().toArray()).find(row => row.name === index.name);
    budget(!!found && BSON.EJSON.stringify(found.key) === BSON.EJSON.stringify(index.key), `Initializer missing named ${index.collection}.${index.name}`);
    budget(!found?.unique && !found?.sparse && !found?.partialFilterExpression, `${index.name} must be additive full nonunique index`);
  }
  let totalBefore = 0, totalAfter = 0;
  for (let i = 0; i < operations.length; i++) {
    const item = operations[i], previous = before[i];
    const after = await measured(() => current.Query[item.operation](null, item.args as any));
    assert.deepEqual(after.result, previous.result, `${item.label}: representative full ordered output`);
    const stats = lookupStats(await explainRead(after.commands[0]));
    const foreign = stats.filter(row => ["WORDS_ES_DE", "PHRASES_ES", "PHRASES_DE"].includes(row.from));
    const previousForeign = previous.stats.filter(row => ["WORDS_ES_DE", "PHRASES_ES", "PHRASES_DE"].includes(row.from));
    totalBefore += previousForeign.reduce((sum, row) => sum + row.totalDocsExamined, 0);
    totalAfter += foreign.reduce((sum, row) => sum + row.totalDocsExamined, 0);
    budget(foreign.length === (i < 2 ? 1 : 2), `${item.label}: expected explain foreign stages`);
    for (const row of foreign) {
      const expected = row.from === "WORDS_ES_DE" ? `catalog_anti_join_${row.foreignField}` : "catalog_anti_join_words";
      budget(row.indexesUsed.includes(expected), `${item.label}: explain must use ${row.from}.${expected}`);
      budget(row.collectionScans === 0, `${item.label}: foreign collection scans must be eliminated`);
      budget(row.totalDocsExamined <= 500, `${item.label}: stop duplicate-rich existence probes after one match`);
    }
    console.log(JSON.stringify({ operation: item.label, rows: after.result.length,
      before: { foreign: previous.stats, requestBytes: previous.requestBytes, replyBytes: previous.replyBytes },
      after: { foreign: stats, requestBytes: after.requestBytes, replyBytes: after.replyBytes } }));
  }
  budget(totalBefore >= 2996640, `Representative baseline must demonstrate nested scan explosion; measured ${totalBefore}`);
  budget(totalAfter < 30000, `Foreign examined documents ${totalAfter} must remain below 30000`);
  console.log(JSON.stringify({ totalForeignDocsBefore: totalBefore, totalForeignDocsAfter: totalAfter, failures }));
  assert.deepEqual(failures, [], "Named initializer indexes and real foreign-index server-work budget");
  console.log("PASS additive initializer indexes, all four foreign index plans, exact public results, <30000 examined foreign documents");
} finally {
  try {
    if (fixtureClient) {
      const ownedDb = originalDb.call(fixtureClient, name);
      assert.equal(ownedDb.databaseName, name);
      await ownedDb.dropDatabase();
      console.log("Removed only the unique owned catalog anti-join fixture database");
    }
  } finally {
    try {
      await closeDatabase?.();
    } finally {
      try {
        await Promise.all([...clients].map(client => client.close()));
      } finally {
        MongoClient.prototype.db = originalDb; MongoClient.prototype.connect = originalConnect;
      }
    }
  }
}
