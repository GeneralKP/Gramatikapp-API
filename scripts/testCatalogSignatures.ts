import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BSON, Decimal128, Long, MongoClient, ObjectId } from 'mongodb';
import type { Database } from '../src/lib/database.js';
import { CATALOG_PART_DESCRIPTORS, createCatalogPartSource, readCatalogPart } from '../src/features/progress/catalogPartSource.js';
import { catalogSummaryCache, type CatalogPart } from '../src/features/progress/catalogSummaryCache.js';
import { phraseGrammarCatalog } from '../src/features/phrases/phraseGrammarCatalog.js';

// Do not read application database configuration. Validate before connecting or
// dropping anything, and force a direct connection to the guarded local host.
const uri = process.env.TEST_CATALOG_URI ?? 'mongodb://127.0.0.1:27017';
const parsed = new URL(uri);
assert.equal(parsed.protocol, 'mongodb:', 'Catalog fixtures require mongodb:// loopback');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'Catalog fixtures require a single loopback host');
assert.equal(parsed.username, '', 'Catalog fixture URIs must not contain credentials');
assert.equal(parsed.password, '', 'Catalog fixture URIs must not contain credentials');
const uriDatabase = decodeURIComponent(parsed.pathname.slice(1));
const databaseName = process.env.TEST_CATALOG_DB ?? (uriDatabase || `gramatik_catalog_signature_fixture_${process.pid}`);
assert.match(databaseName, /^gramatik_catalog_signature_fixture(?:_[a-zA-Z0-9_]+)?$/, 'Catalog fixtures require a dedicated fixture database');
if (uriDatabase) assert.equal(uriDatabase, databaseName, 'URI database must be the guarded fixture');
const client = new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 5000, monitorCommands: true });
const traffic: { command: any; requestBytes: number; replyBytes: number; durationMs: number }[] = [];
const pending = new Map<number, typeof traffic[number]>();
client.on('commandStarted', event => {
  if (!['aggregate', 'getMore', 'find'].includes(event.commandName)) return;
  const measurement = { command: event.command, requestBytes: BSON.calculateObjectSize(event.command), replyBytes: 0, durationMs: 0 };
  traffic.push(measurement); pending.set(event.requestId, measurement);
});
client.on('commandSucceeded', event => {
  const measurement = pending.get(event.requestId);
  if (measurement) { measurement.replyBytes = BSON.calculateObjectSize(event.reply); measurement.durationMs = event.duration; pending.delete(event.requestId); }
});
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const definitions: Record<CatalogPart, { collection: string; filter: any; projection: any; field: string }> = {
  words: { collection: 'WORDS_ES_DE', filter: {}, projection: { _id: 1, main: 1, translated: 1 }, field: 'main' },
  phrases: { collection: 'PHRASES_ES_DE', filter: {}, projection: { _id: 1, main: 1, translated: 1 }, field: 'translated' },
  wordMeta: { collection: 'WORDS_ES', filter: {}, projection: { _id: 1, word: 1, contexts: 1, level: 1, examples: 1 }, field: 'word' },
  phraseMeta: { collection: 'PHRASES_ES', filter: {}, projection: { _id: 1, phrase: 1, contexts: 1, level: 1 }, field: 'phrase' },
  wordTextDe: { collection: 'WORDS_DE', filter: {}, projection: { _id: 1, word: 1, cefrLevel: 1, gramaticalCategories: 1, 'forms.gender': 1, 'forms.past': 1, 'forms.perfect': 1, 'forms.imperativ': 1, notes: 1, examples: 1 }, field: 'word' },
  phraseTextDe: { collection: 'PHRASES_DE', filter: {}, projection: { _id: 1, phrase: 1, cefrLevel: 1, synonyms: 1, words: 1 }, field: 'phrase' },
  grammarSurfaceDe: { collection: 'TRANSLATIONS_ES_DE', filter: { sourceLanguage: 'de', targetLanguage: 'es', status: 'READY' }, projection: { _id: 0, key: 1, category: 1 }, field: 'category' },
};
await client.connect();
const mongo = client.db(databaseName);
const collectionNames = { relationsWordsEsDe: 'WORDS_ES_DE', relationsPhrasesEsDe: 'PHRASES_ES_DE', wordsES: 'WORDS_ES', phrasesES: 'PHRASES_ES', wordsDE: 'WORDS_DE', phrasesDE: 'PHRASES_DE', translationsEsDe: 'TRANSLATIONS_ES_DE' };
const db = Object.fromEntries(Object.entries(collectionNames).map(([name, collection]) => [name, mongo.collection(collection)])) as unknown as Database;
for (const privatePart of ['users', 'progress', 'schedulerProfiles', 'reviewEvents']) Object.defineProperty(db, privatePart, { get() { throw new Error('Private state entered the static catalog'); } });
try {
  const build = await client.db('admin').command({ buildInfo: 1 });
  assert.match(build.version, /^8\./, 'Signature fixtures require MongoDB 8');
  await mongo.dropDatabase();
  for (const [part, definition] of Object.entries(definitions) as [CatalogPart, typeof definitions[CatalogPart]][]) {
    assert.deepEqual(CATALOG_PART_DESCRIPTORS[part].filter, definition.filter);
    assert.deepEqual(CATALOG_PART_DESCRIPTORS[part].projection, definition.projection, `${part} preserves the current projection exactly`);
    const collection = mongo.collection(definition.collection), source = createCatalogPartSource<any>(db, part);
    const empty = await source.loadSnapshot();
    assert.deepEqual(empty.rows, []); assert.equal(empty.signature, '["0","0","0"]'); assert.equal(await source.readSignature(), empty.signature);
    const row = { _id: id(1), main: id(10), translated: id(11), word: 'Haus', phrase: 'Heute lerne ich Deutsch.', contexts: ['university', 'work'], level: 'A1', examples: ['Das Haus ist groß.'], cefrLevel: 'A1.2', gramaticalCategories: ['NOUN'], forms: { gender: 'das', past: 'ging', perfect: 'gegangen', imperativ: 'geh', plural: 'ignored' }, notes: 'shared note', synonyms: ['Heute übe ich Deutsch.'], words: [id(10), 'lernen'], key: 'lernte', category: 'VERB', sourceLanguage: 'de', targetLanguage: 'es', status: 'READY', userId: 'ignored-private', scheduler: { ignored: true } };
    await collection.insertOne(row);
    const loaded = await source.loadSnapshot();
    assert.deepEqual(loaded.rows, await collection.find(definition.filter).project(definition.projection).toArray(), `${part}: wrappers are stripped and exact Mongo projections survive`);
    assert.equal(loaded.signature, await source.readSignature(), `${part}: loaded-row/probe signatures agree`);
    assert.equal((loaded.rows[0] as any).userId, undefined); assert.equal((loaded.rows[0] as any).scheduler, undefined);
    await collection.updateOne({ _id: id(1) }, { $set: { unprojected: 'ignored edit', userId: 'ignored edit', 'forms.plural': 'ignored plural' } });
    assert.equal(await source.readSignature(), loaded.signature, `${part}: unprojected edits do not invalidate`);
    const changedValue = part === 'words' || part === 'phrases' ? id(12) : 'changed projected value';
    await collection.updateOne({ _id: id(1) }, { $set: { [definition.field]: changedValue } });
    let previous = await source.readSignature();
    assert.notEqual(previous, loaded.signature, `${part}: projected edit detected`);
    assert.equal((await source.loadSnapshot()).signature, previous);
    await collection.insertOne({ ...row, _id: id(2) });
    const inserted = await source.readSignature(); assert.notEqual(inserted, previous, `${part}: insert detected`);
    assert.equal((await source.loadSnapshot()).signature, inserted);
    await collection.deleteOne({ _id: id(2) });
    assert.equal(await source.readSignature(), previous, `${part}: delete detected`);
    // Missing/null and numeric values share a path but must not share a hash.
    for (const value of [undefined, null, 2.2, 2.9, '2.9', new Long('2'), Decimal128.fromString('2.9'), id(77), String(id(77))]) {
      await collection.updateOne({ _id: id(1) }, value === undefined ? { $unset: { [definition.field]: '' } } : { $set: { [definition.field]: value } });
      const next = await source.readSignature(); assert.notEqual(next, previous, `${part}: projected leaf type/value change detected`);
      assert.equal((await source.loadSnapshot()).signature, next); previous = next;
    }
    await collection.deleteMany({});
    assert.equal(await source.readSignature(), empty.signature);
  }

  const words = mongo.collection('WORDS_DE'), wordSource = createCatalogPartSource<any>(db, 'wordTextDe');
  await words.insertOne({ _id: id(1), word: 'Haus', forms: { past: 2.2 }, examples: [2.2, 'a'] });
  let signature = await wordSource.readSignature();
  for (const update of [{ 'forms.past': 2.9 }, { 'forms.past': '2.9' }, { examples: [2.9, 'a'] }, { examples: ['a', 2.9] }, { examples: [] }, { examples: null }, { forms: {} }, { forms: null }]) {
    await words.updateOne({ _id: id(1) }, { $set: update });
    const next = await wordSource.readSignature(); assert.notEqual(next, signature, 'forms/arrays/null mutations change signatures');
    assert.equal((await wordSource.loadSnapshot()).signature, next); signature = next;
  }
  await words.updateOne({ _id: id(1) }, { $unset: { forms: '', examples: '' } });
  assert.notEqual(await wordSource.readSignature(), signature, 'missing differs from projected null');
  // BSON types retained inside arrays, and one extra object/array nesting.
  for (const examples of [[id(90)], [String(id(90))], [[2.2]], [[2.9]], [{ value: 2.2 }], [{ value: 2.9 }]]) {
    signature = await wordSource.readSignature();
    await words.updateOne({ _id: id(1) }, { $set: { examples } });
    assert.notEqual(await wordSource.readSignature(), signature);
    assert.equal((await wordSource.loadSnapshot()).signature, await wordSource.readSignature());
  }

  const surfaces = mongo.collection('TRANSLATIONS_ES_DE'), surfaceSource = createCatalogPartSource<any>(db, 'grammarSurfaceDe');
  const surface = { _id: id(1), key: 'lernte', category: 'VERB', sourceLanguage: 'de', targetLanguage: 'es', status: 'READY' };
  await surfaces.insertOne(surface);
  const ready = await surfaceSource.readSignature();
  for (const [field, outside] of [['sourceLanguage', 'es'], ['targetLanguage', 'de'], ['status', 'FAILED']] as const) {
    await surfaces.updateOne({ _id: id(1) }, { $set: { [field]: outside } });
    assert.equal(await surfaceSource.readSignature(), '["0","0","0"]', `grammar ${field} filter exclusion`);
    await surfaces.updateOne({ _id: id(1) }, { $set: { [field]: surface[field] } });
    assert.equal(await surfaceSource.readSignature(), ready, `grammar ${field} filter re-entry`);
  }
  // Unchanged parts preserve their index identity; a relevant surface edit
  // replaces only that immutable part and the grammar index derived from it.
  await words.deleteMany({}); await words.insertOne({ _id: id(1), word: 'lernen', gramaticalCategories: ['VERB'], forms: { past: 'lernte' } });
  catalogSummaryCache.invalidate(db);
  const firstRows = await readCatalogPart<any>(db, 'wordTextDe'), firstIndex = await phraseGrammarCatalog(db);
  const sameIndex = await phraseGrammarCatalog(db, true);
  assert.equal(sameIndex, firstIndex); assert.equal(await readCatalogPart(db, 'wordTextDe', true), firstRows);
  await surfaces.updateOne({ _id: id(1) }, { $set: { category: 'NOUN' } });
  assert.notEqual(await phraseGrammarCatalog(db, true), firstIndex);
  assert.equal(await readCatalogPart(db, 'wordTextDe'), firstRows, 'changing a surface does not reload German words');

  // Measure loaded and unchanged validation wire traffic with a useful catalog,
  // rather than infer savings from static pipeline text or tiny row fixtures.
  await words.deleteMany({});
  await words.insertMany(Array.from({ length: 1200 }, (_, index) => ({ _id: id(index + 100), word: `lernen ${index}`, cefrLevel: 'A1.2', gramaticalCategories: ['VERB'], forms: { past: 'lernte', perfect: 'gelernt', imperativ: 'Lerne!' }, notes: 'shared catalog explanation '.repeat(8), examples: ['Ich lerne Deutsch.', 'Wir lernen jeden Tag.'] })));
  for (const [part, definition] of Object.entries(definitions) as [CatalogPart, typeof definitions[CatalogPart]][]) {
    if (part === 'wordTextDe') continue;
    const collection = mongo.collection(definition.collection);
    await collection.deleteMany({});
    await collection.insertMany(Array.from({ length: 1200 }, (_, index) => ({
      _id: id(index + 100), main: id(index + 1000), translated: id(index + 3000),
      word: `casa ${index}`, phrase: `Hoy estudio alemán ${index}.`,
      contexts: ['university', 'work'], level: 'A1', cefrLevel: 'A1.2',
      examples: ['Estudio alemán todos los días.'], synonyms: ['Ich lerne heute Deutsch.'], words: [id(index + 1000)],
      key: `lernte ${index}`, category: 'VERB', sourceLanguage: 'de', targetLanguage: 'es', status: 'READY',
    })));
  }
  const measurements: any[] = [];
  for (const part of Object.keys(definitions) as CatalogPart[]) {
    catalogSummaryCache.invalidate(db, part); traffic.length = 0;
    const started = performance.now(); const rows = await readCatalogPart(db, part);
    const loadMs = performance.now() - started;
    const loadReplyBytes = traffic.reduce((sum, request) => sum + request.replyBytes, 0);
    traffic.length = 0; const validationStarted = performance.now();
    assert.equal(await readCatalogPart(db, part, true), rows);
    const validationMs = performance.now() - validationStarted;
    assert.equal(traffic.length, 1, `${part}: unchanged validation sends exactly one compact aggregate`);
    assert.ok(traffic.every(request => request.command.pipeline?.some((stage: any) => stage.$group)), `${part}: no full catalog reads during unchanged validation`);
    const replyBytes = traffic.reduce((sum, request) => sum + request.replyBytes, 0);
    assert.ok(replyBytes <= 1024, `${part}: unchanged validation reply exceeds 1KB`);
    measurements.push({ part, rowCount: rows.length, loadMs: Number(loadMs.toFixed(2)), loadReplyBytes, validationMs: Number(validationMs.toFixed(2)), validationRequestBytes: traffic[0].requestBytes, validationReplyBytes: replyBytes, fullCatalogReads: 0 });
  }
  console.log(JSON.stringify({ mongoVersion: build.version, measurements }));
  console.log('PASS Mongo8 seven catalog descriptors, exact projections, row/probe baselines, edits/inserts/deletes, ignored fields, grammar membership, BSON types, missing/null, arrays/forms, fractional numerics and compact unchanged validation');
} finally {
  catalogSummaryCache.invalidate(db);
  await mongo.dropDatabase();
  await client.close();
}
