import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { createTranslationService, validateReviewedEntry, saveReviewedEntry } from "../src/features/translations/translations.service.js";
import type { Database } from "../src/lib/database.js";
import express from "express";
import { createServer } from "node:http";
import { wordTranslationRouter } from "../src/features/translations/translations.http.js";

// Dedicated local replica set only: this test never uses the app's credentials.
const client = await new MongoClient(process.env.TEST_TRANSLATION_URI || "mongodb://127.0.0.1:27028/?replicaSet=translation_tests", { serverSelectionTimeoutMS: 5000 }).connect();
const database = client.db(`translation_test_${new ObjectId()}`);
const db = Object.fromEntries(Object.entries({ wordsES: "WORDS_ES", wordsDE: "WORDS_DE", relationsWordsEsDe: "WORDS_ES_DE", phrasesES: "PHRASES_ES", phrasesDE: "PHRASES_DE", translationsEsDe: "TRANSLATIONS_ES_DE" }).map(([key, name]) => [key, database.collection(name)])) as unknown as Database;
const now = new Date();
const word = (text: string, category: string, forms = {}) => ({ _id: new ObjectId(), word: text, gramaticalCategories: [category], forms, examples: [], contexts: [], createdAt: now });
const source = word("der Hund", "NOUN", { gender: "der", plural: "Hunde" }), target = word("perro", "NOUN", { gender: "masculino", plural: "perros" });
const surface = { key: "hunden", word: "Hunden", translation: "perros (dativo plural)", kind: "SURFACE", lemma: "Hund", category: "NOUN", form: "dative plural", cefrLevel: "A1.1", example: "Ich spiele mit den Hunden.", contexts: [] };
const lexeme = { key: "lernen", word: "lernen", translation: "aprender", kind: "LEXEME", lemma: "lernen", category: "VERB", form: "infinitive", cefrLevel: "A1.1", forms: { past: "lernte", perfect: "gelernt", imperativ: "Lerne!", irregularConjugations: "regular" }, target: { word: "aprender", category: "VERB", forms: { past: "aprendió", perfect: "aprendido", imperativ: "aprende", irregularConjugations: "regular" }, cefrLevel: "A1.1", example: "Quiero aprender alemán." } };
try {
  assert.throws(() => validateReviewedEntry({ ...lexeme, word: " lernen " }, "de"), /spelling/i, "reviewed dictionary spelling must be canonical before persistence");
  assert.throws(() => validateReviewedEntry({ ...lexeme, target: { ...lexeme.target, word: "aprender!" } }, "de"), /spelling/i, "target spelling must remain findable by exact lookup");
  assert.throws(() => validateReviewedEntry({ ...lexeme, word: "gingen", key: "gingen", lemma: "gingen", form: "past plural" }, "de"), /morphology|dictionary/i, "explicit finite morphology must never be promoted to vocabulary");
  assert.throws(() => validateReviewedEntry({ ...lexeme, word: "baum", key: "baum", lemma: "baum", category: "NOUN", form: "dictionary form", forms: { gender: "der", plural: "Bäume" } }, "de"), /capital/i, "German study nouns require dictionary capitalization");
  await db.translationsEsDe.createIndex({ sourceLanguage: 1, targetLanguage: 1, key: 1 }, { unique: true });
  await db.wordsDE.insertOne(source as any); await db.wordsES.insertOne(target as any);
  await db.relationsWordsEsDe.insertOne({ _id: new ObjectId(), main: target._id, translated: source._id, createdAt: now });
  let generations = 0;
  const service = createTranslationService({ db, client, emergency: true, generate: async (word, source, context) => {
    generations++; assert.equal(word, "Hunden"); assert.equal(source, "de"); assert.equal(context, "Ich spiele mit den Hunden."); return surface;
  } });
  assert.equal((await service.lookup({ word: "Hund!", sourceLanguage: "de", targetLanguage: "es" })).translation, "perro");
  assert.equal((await service.lookup({ word: "perro", sourceLanguage: "es", targetLanguage: "de" })).translation, "der Hund");
  assert.equal(generations, 0, "dictionary hits must never contact GPT");
  await assert.rejects(() => service.lookup({ word: ",", sourceLanguage: "de", targetLanguage: "es" }));
  await assert.rejects(() => service.lookup({ word: "Hund", sourceLanguage: "en", targetLanguage: "es" }));
  const result = await service.lookup({ word: "Hunden.", sourceLanguage: "de", targetLanguage: "es", context: "Ich spiele mit den Hunden." });
  assert.equal(result.translation, "perros (dativo plural)");
  assert.equal(await db.wordsDE.countDocuments({ word: "Hunden" }), 0, "inflections must never enter the vocabulary catalog");
  const savedSurface = await db.translationsEsDe.findOne({ key: "hunden" });
  assert.equal(savedSurface?.status, "READY"); assert.equal(savedSurface?.origin, "GPT");
  assert.equal(Object.hasOwn(savedSurface!, "machineTranslation"), false, "GPT results need no intermediate provider text");
  assert.equal((await service.lookup({ word: "Hunden", sourceLanguage: "de", targetLanguage: "es" })).source, "TRANSLATIONS");
  assert.equal(generations, 1, "a miss makes one GPT call and a saved hit makes none");
  const merit = word("der Verdienst", "NOUN", { gender: "der", plural: "Verdienste" }), meritES = word("mérito", "NOUN", { gender: "masculino", plural: "méritos" });
  await db.wordsDE.insertOne(merit as any); await db.wordsES.insertOne(meritES as any);
  await db.relationsWordsEsDe.insertOne({ _id: new ObjectId(), main: meritES._id, translated: merit._id, createdAt: now });
  await saveReviewedEntry(db, client, { ...surface, word: "verdienst", key: "verdienst", lemma: "verdienen", category: "VERB", form: "second-person singular present", translation: "mereces" } as any, "de", { origin: "MANUAL", examples: ["Du verdienst Respekt."], contexts: [], phraseRefs: [] });
  assert.equal((await service.lookup({ word: "verdienst", sourceLanguage: "de", targetLanguage: "es" })).translation, "mereces", "lowercase verbs must not reuse a different capitalized noun meaning");
  assert.equal((await service.lookup({ word: "Verdienst", sourceLanguage: "de", targetLanguage: "es" })).translation, "mérito");
  assert.throws(() => validateReviewedEntry({ ...surface, kind: "LEXEME", target: lexeme.target }, "de"), /lemma|dictionary/i);
  const legacyLearning = word("lernen", "UNKNOWN");
  await db.wordsDE.insertOne(legacyLearning as any);
  await saveReviewedEntry(db, client, lexeme as any, "de", { origin: "MANUAL", examples: ["Ich möchte Deutsch lernen."], contexts: ["university"], phraseRefs: [] });
  assert.equal((await service.lookup({ word: "lernen", sourceLanguage: "de", targetLanguage: "es" })).translation, "aprender");
  assert.equal((await service.lookup({ word: "aprender", sourceLanguage: "es", targetLanguage: "de" })).translation, "lernen");
  const learned = await db.wordsDE.findOne({ word: "lernen" });
  assert.equal(learned?.forms?.perfect, "gelernt"); assert.equal(learned?.cefrLevel, "A1.1");
  assert.equal(learned?.notes, "", "seeding a dictionary record without notes does not add provenance boilerplate");
  assert.deepEqual(learned?.relatedWords?.homophones, [], "reused legacy words receive absent metadata containers without invented relations");
  await saveReviewedEntry(db, client, lexeme as any, "de", { origin: "MANUAL", examples: ["Ich möchte Deutsch lernen."], contexts: ["university"], phraseRefs: [] });
  assert.equal(await db.wordsDE.countDocuments({ word: "lernen" }), 1);
  assert.equal(await db.relationsWordsEsDe.countDocuments({ translated: learned!._id }), 1, "repeating a seed must not duplicate its relation");
  const legacy = { ...word("das Spielen", "NOUN", { gender: "das", plural: "kein Plural" }), gramaticalCategories: ["NOUN", "UNKNOWN"] };
  await db.wordsDE.insertOne(legacy as any);
  const playing = { ...lexeme, word: "spielen", key: "spielen", lemma: "spielen", translation: "jugar", forms: { past: "spielte", perfect: "gespielt", imperativ: "Spiel!" }, target: { ...lexeme.target, word: "jugar", forms: { past: "jugó", perfect: "jugado", imperativ: "juega" }, example: "Quiero jugar." } };
  await saveReviewedEntry(db, client, playing as any, "de", { origin: "MANUAL", examples: ["Wir spielen Karten."], contexts: [], phraseRefs: [] });
  assert.deepEqual((await db.wordsDE.findOne({ _id: legacy._id }))?.gramaticalCategories, ["NOUN", "UNKNOWN"], "a mixed UNKNOWN tag must not erase a known category");
  assert.equal((await db.wordsDE.findOne({ word: "spielen" }))?.gramaticalCategories[0], "VERB");
  const car = (source: string, german: string) => ({ word: source, key: source, lemma: source, translation: german, kind: "LEXEME", category: "NOUN", form: "dictionary form", cefrLevel: "A1.2", forms: { gender: "masculino", plural: `${source}s` }, target: { word: german, category: "NOUN", cefrLevel: "A1.2", forms: { gender: "das", plural: "Autos" }, example: "Das Auto steht hier." } });
  await Promise.all([saveReviewedEntry(db, client, car("auto", "Auto") as any, "es", { origin: "MANUAL", examples: ["El auto está aquí."], contexts: [], phraseRefs: [] }), saveReviewedEntry(db, client, car("coche", "das Auto") as any, "es", { origin: "MANUAL", examples: ["El coche está aquí."], contexts: [], phraseRefs: [] })]);
  assert.equal(await db.wordsDE.countDocuments({ word: /^(?:das )?Auto$/ }), 1, "concurrent German noun article variants must share one dictionary identity");
  let retryCalls = 0;
  const broken = createTranslationService({ db, client, emergency: true, generate: async () => {
    retryCalls++; return { ...lexeme, word: "gingen", key: "gingen", lemma: "gingen", form: "past plural", example: "Wir gingen nach Hause.", contexts: [] } as any;
  } });
  await assert.rejects(() => broken.lookup({ word: "gingen", sourceLanguage: "de", targetLanguage: "es" }));
  const failed = await db.translationsEsDe.findOne({ key: "gingen" });
  assert.equal(failed?.status, "FAILED"); assert.equal(failed?.origin, "GPT");
  assert.equal(failed?.leaseToken, undefined); assert.equal(failed?.translation, undefined);
  assert.equal(await db.wordsDE.countDocuments({ word: "gingen" }), 0);
  const retried = createTranslationService({ db, client, emergency: true, generate: async () => {
    retryCalls++; return { ...surface, key: "gingen", word: "gingen", translation: "iban / fueron", lemma: "gehen", category: "VERB", form: "past plural" } as any;
  } });
  assert.equal((await retried.lookup({ word: "gingen", sourceLanguage: "de", targetLanguage: "es" })).translation, "iban / fueron");
  assert.equal((await retried.lookup({ word: "gingen", sourceLanguage: "de", targetLanguage: "es" })).translation, "iban / fueron");
  assert.equal(retryCalls, 2, "invalid GPT metadata is retried once; a validated saved result is reused");
  const localOnly = createTranslationService({ db, client, emergency: false });
  await assert.rejects(() => localOnly.lookup({ word: "ungesehen", sourceLanguage: "de", targetLanguage: "es" }), /production/i);
  let release: (() => void) | undefined, concurrentCalls = 0;
  const concurrent = createTranslationService({ db, client, emergency: true, generate: async () => {
    concurrentCalls++; await new Promise<void>(resolve => { release = resolve; });
    return { ...surface, key: "hunde", word: "Hunde", translation: "perros", form: "plural" } as any;
  } });
  const first = concurrent.lookup({ word: "Hunde", sourceLanguage: "de", targetLanguage: "es" });
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  const second = await concurrent.lookup({ word: "Hunde", sourceLanguage: "de", targetLanguage: "es" });
  assert.equal(second.status, "PENDING", "concurrent misses share the same provider work");
  release!(); await first; assert.equal(concurrentCalls, 1);
  assert.equal(await db.translationsEsDe.countDocuments({ key: "hunde" }), 1);
  const jumping = { ...lexeme, word: "springen", key: "springen", lemma: "springen", translation: "brincar", example: "Wir wollen springen.", contexts: [], forms: { past: "sprang", perfect: "gesprungen", imperativ: "Spring!" }, target: { ...lexeme.target, word: "brincar", example: "Quiero brincar.", forms: { past: "brincó", perfect: "brincado", imperativ: "brinca" } } };
  let jumpCalls = 0;
  const dictionaryEmergency = createTranslationService({ db, client, emergency: true, generate: async () => { jumpCalls++; return jumping as any; } });
  assert.equal((await dictionaryEmergency.lookup({ word: "springen", sourceLanguage: "de", targetLanguage: "es" })).source, "WORDS");
  assert.equal(await db.translationsEsDe.countDocuments({ key: "springen" }), 0, "a dictionary miss completes into vocabulary, removing its temporary claim");
  assert.equal((await dictionaryEmergency.lookup({ word: "brincar", sourceLanguage: "es", targetLanguage: "de" })).translation, "springen");
  assert.equal(jumpCalls, 1);
  const dancing = { ...jumping, word: "tanzen", key: "tanzen", lemma: "tanzen", translation: "bailar", example: "Wir wollen tanzen.", forms: { past: "tanzte", perfect: "getanzt", imperativ: "Tanze!" }, target: { ...jumping.target, word: "bailar", example: "Quiero bailar.", forms: { past: "bailó", perfect: "bailado", imperativ: "baila" } } };
  // Create a real dictionary pair at the narrow race boundary, after initial reads.
  const claim = db.translationsEsDe.findOneAndUpdate.bind(db.translationsEsDe);
  db.translationsEsDe.findOneAndUpdate = (async (...args: any[]) => {
    const result = await (claim as any)(...args);
    if (args[0].key === "tanzen") await saveReviewedEntry(db, client, dancing as any, "de", { origin: "MANUAL", examples: [dancing.example], contexts: [], phraseRefs: [] });
    return result;
  }) as any;
  try {
    const raced = createTranslationService({ db, client, emergency: true, generate: async () => { throw new Error("Dictionary arrived before GPT call"); } });
    assert.equal((await raced.lookup({ word: "tanzen", sourceLanguage: "de", targetLanguage: "es" })).translation, "bailar");
    assert.equal(await db.translationsEsDe.countDocuments({ key: "tanzen" }), 0);
  } finally { db.translationsEsDe.findOneAndUpdate = claim as any; }
  const app = express(); app.use(express.json());
  app.use(wordTranslationRouter({ authenticate: async token => token === "translation-test" ? { _id: new ObjectId() } as any : null, lookup: service.lookup }));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/api/word-translations`;
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ word: "Hund", sourceLanguage: "de", targetLanguage: "es" }) })).status, 401);
    const headers = { "Content-Type": "application/json", Authorization: "Bearer translation-test" };
    const translated = await fetch(url, { method: "POST", headers, body: JSON.stringify({ word: "Hund!", sourceLanguage: "de", targetLanguage: "es" }) });
    assert.equal(translated.status, 200); assert.equal((await translated.json()).translation, "perro");
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ word: ",", sourceLanguage: "de", targetLanguage: "es" }) })).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  const providerCalls: string[] = [];
  const generated = [
    { input: { word: "neuesten", sourceLanguage: "de", targetLanguage: "es", phraseContext: "Ich lese die neuesten Nachrichten." }, output: { ...surface, word: "neuesten", key: "neuesten", lemma: "neu", category: "ADJECTIVE", form: "declined superlative", translation: "más recientes", example: "Ich lese die neuesten Nachrichten." } },
    { input: { word: "leyeron", sourceLanguage: "es", targetLanguage: "de", phraseContext: "Ellos leyeron el libro." }, output: { ...surface, word: "leyeron", key: "leyeron", lemma: "leer", category: "VERB", form: "third-person plural preterite", translation: "sie lasen", example: "Ellos leyeron el libro." } },
  ];
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); providerCalls.push(req.url!);
    res.setHeader("Content-Type", "application/json");
    assert.equal(req.url, "/responses"); assert.equal(body.store, false); assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    const fixture = generated[providerCalls.length - 1];
    assert.deepEqual(JSON.parse(body.input), fixture.input);
    assert.match(body.instructions, /untrusted data/); assert.match(body.instructions, /These entries become study exercises/);
    res.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(fixture.output) }] }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const environment = Object.fromEntries(["NODE_ENV", "OPENAI_BASE_URL", "OPENAI_API_KEY"].map(key => [key, process.env[key]]));
  try {
    const base = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    process.env.OPENAI_BASE_URL = base; process.env.OPENAI_API_KEY = "test-only-key";
    const realClients = createTranslationService({ db, client });
    process.env.NODE_ENV = "development";
    await assert.rejects(() => realClients.lookup({ word: "neuesten", sourceLanguage: "de", targetLanguage: "es" }), /production/i);
    assert.equal(providerCalls.length, 0, "development misses must not call GPT");
    process.env.NODE_ENV = "production";
    assert.equal((await realClients.lookup({ word: "neuesten!", sourceLanguage: "de", targetLanguage: "es", context: "Ich lese die neuesten Nachrichten." })).translation, "más recientes");
    assert.equal((await realClients.lookup({ word: "neuesten", sourceLanguage: "de", targetLanguage: "es" })).translation, "más recientes");
    assert.equal((await realClients.lookup({ word: "leyeron", sourceLanguage: "es", targetLanguage: "de", context: "Ellos leyeron el libro." })).translation, "sie lasen");
    assert.equal((await realClients.lookup({ word: "leyeron", sourceLanguage: "es", targetLanguage: "de" })).translation, "sie lasen");
    assert.deepEqual(providerCalls, ["/responses", "/responses"], "each direction makes one GPT call for its miss; subsequent hits use MongoDB");
  } finally {
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
  console.log("PASS word translations: direct GPT in both directions, production-only misses, noun articles, inflection isolation, provider-free hits, atomic saves, idempotent seeding, retry and concurrent misses");
} finally { await database.dropDatabase(); await client.close(); }
