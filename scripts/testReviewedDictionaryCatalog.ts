import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { typeDefs } from '../src/graphql/schema.js';
import { wordsResolvers } from '../src/features/words/words.resolvers.js';
import { connectDatabase, getDb } from '../src/lib/database.js';
import { dictionaryWord } from '../src/features/words/reviewedWordContent.js';
import { lookupCatalogTranslation } from '../src/features/translations/translations.service.js';

const uri = process.env.TEST_DICTIONARY_URI ?? 'mongodb://127.0.0.1:27017';
assert.match(uri, /^mongodb:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/, 'Reviewed dictionary fixtures require loopback MongoDB');
const client = await new MongoClient(uri, {serverSelectionTimeoutMS: 5000}).connect();
const db = client.db(`reviewed_dictionary_tests_${process.pid}`);
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const createdAt = new Date(0);
const study = {version: 1, german: 'Die kindliche Pietät', spanish: 'la piedad filial', notes: '', forms: {gender: 'die', plural: ''}, category: 'NOUN', germanExamples: ['Sie zeigt ihren Eltern kindliche Pietät.'], spanishExamples: ['Ella muestra piedad filial hacia sus padres.'], examples: ['Sie zeigt ihren Eltern kindliche Pietät. (Ella muestra piedad filial hacia sus padres.)'], auditedAt: createdAt};
const rawDE = {_id: id(1), word: 'Frömmigkeit', notes: 'old note', examples: ['German example.'], contexts: ['general_vocabulary'], gramaticalCategories: ['UNKNOWN'], cefrLevel: 'B2.2', forms: {gender: 'der', plural: 'incorrect old plural'}, createdAt};
const rawES = {_id: id(2), word: 'piedad', notes: 'Spanish note', examples: ['Ejemplo español.'], contexts: ['general_vocabulary'], gramaticalCategories: ['NOUN'], createdAt};
const relation = {_id: id(3), main: rawES._id, translated: rawDE._id, study, createdAt};

// Initialize the real resolver's database handle with only this disposable DB.
// The production URI is never connected, even if dotenv has loaded it.
const originalConnect = MongoClient.prototype.connect;
const originalDb = MongoClient.prototype.db;
try {
  MongoClient.prototype.connect = async function() { return this; };
  MongoClient.prototype.db = function() { return db; };
  await connectDatabase();
} finally {
  MongoClient.prototype.connect = originalConnect;
  MongoClient.prototype.db = originalDb;
}

try {
  await db.collection('WORDS_DE').insertMany([rawDE, {...rawDE, _id: id(11), word: 'Aal', cefrLevel: 'A1.1'}, {...rawDE, _id: id(21), word: '^(.+)$'}]);
  await db.collection('WORDS_ES').insertMany([rawES, {...rawES, _id: id(12), word: 'anguila'}, {...rawES, _id: id(22), word: 'literal'}]);
  await db.collection('WORDS_ES_DE').insertMany([
    relation,
    {...relation, _id: id(4)}, // same visible title: paginate deterministically by ID
    {_id: id(13), main: id(12), translated: id(11), createdAt},
    {_id: id(23), main: id(22), translated: id(21), study: {...study, version: 2, german: 'invalid hidden title'}, createdAt},
  ]);
  let fallbackReads = 0;
  for (const collection of [getDb().wordsDE, getDb().wordsES]) {
    const original = collection.findOne.bind(collection);
    collection.findOne = ((...args: any[]) => { fallbackReads++; return (original as any)(...args); }) as typeof collection.findOne;
  }
  const schema = makeExecutableSchema({typeDefs, resolvers: wordsResolvers});
  const source = 'query($search:String,$cefrLevel:String,$limit:Int,$offset:Int,$details:Boolean!){items:wordRelations(search:$search,cefrLevel:$cefrLevel,limit:$limit,offset:$offset){id left:main{...Label notes examples} right:translated{...Label notes @include(if:$details) examples forms{gender plural} gramaticalCategories level}}} fragment Label on Word{id word}';
  const run = async (variables: Record<string, unknown> = {}) => {
    fallbackReads = 0;
    const result = await graphql({schema, source, variableValues: {details: true, limit: 500, ...variables}});
    assert.equal(result.errors, undefined);
    assert.equal(fallbackReads, 0, 'joined dictionary pages do not add per-word queries');
    return JSON.parse(JSON.stringify(result.data)).items as any[];
  };
  for (const search of ['kindliche', 'FILIAL', 'Frömmigkeit', 'piedad']) {
    const rows = await run({search, cefrLevel: 'B2.2'});
    assert.deepEqual(rows.map(row => row.id), [String(id(3)), String(id(4))], 'reviewed labels and original lookup spellings find the same valid filtered pairs');
    assert.equal(rows[0].right.word, study.german);
    assert.equal(rows[0].left.word, study.spanish);
    assert.equal(rows[0].right.notes, '', 'intentionally empty reviewed German notes are authoritative');
    assert.deepEqual(rows[0].right.forms, study.forms, 'canonical grammar belongs to the visible study construction');
    assert.deepEqual(rows[0].right.gramaticalCategories, [study.category]);
    assert.equal(rows[0].left.notes, rawES.notes, 'German study notes never leak into Spanish notes');
    assert.deepEqual(rows[0].right.examples, study.germanExamples, 'canonical German construction uses its own language-specific examples');
    assert.deepEqual(rows[0].left.examples, study.spanishExamples, 'Spanish examples remain aligned with the reviewed meaning without bilingual wrappers');
    assert.equal(rows[0].right.id, String(rawDE._id));
    assert.equal(rows[0].right.level, 'B2');
  }
  assert.deepEqual((await run({search: 'kindliche', cefrLevel: 'A1.1'})), []);
  assert.deepEqual((await run({search: 'invalid hidden title'})), [], 'unknown study versions do not enter search');
  const literal = await run({search: '^(.+)$'});
  assert.equal(literal.length, 1, 'search remains literal, not executable regex syntax');
  assert.equal(literal[0].right.word, '^(.+)$', 'legacy or invalid content falls back to stored spelling');
  const page = await run({search: 'kindliche', limit: 1, offset: 1});
  assert.equal(page[0].id, String(id(4)), 'canonical title ties paginate deterministically by relation ID');
  assert.deepEqual(await run({search: 'kindliche', limit: 1, offset: 2}), []);
  assert.deepEqual((await run()).map(row => row.id), [13, 3, 4, 23].map(n => String(id(n))), 'canonical titles sort together with legacy spellings');
  const filteredPage = await run({search: 'kindliche', cefrLevel: 'B2.2', limit: 1, offset: 1, details: false});
  assert.equal(filteredPage[0].id, String(id(4)));
  assert.equal(filteredPage[0].right.word, study.german, 'aliases/fragments and omitted notes retain canonical label dependencies');
  assert.equal('notes' in filteredPage[0].right, false);
  const onlyNotes = await graphql({schema, source: '{wordRelations(search:"kindliche"){translated{notes}}}'});
  assert.equal(onlyNotes.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(onlyNotes.data)), {wordRelations: [{translated: {notes: ''}}, {translated: {notes: ''}}]}, 'notes-only selections retain the validity dependencies');
  const onlyGrammar = await graphql({schema, source: '{wordRelations(search:"kindliche"){translated{forms{gender plural} gramaticalCategories}}}'});
  assert.equal(onlyGrammar.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(onlyGrammar.data)), {wordRelations: [1, 2].map(() => ({translated: {forms: study.forms, gramaticalCategories: [study.category]}}))}, 'grammar-only selections project their independent reviewed dependencies');
  const onlyExamples = await graphql({schema, source: '{wordRelations(search:"kindliche"){main{examples} translated{examples}}}'});
  assert.equal(onlyExamples.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(onlyExamples.data)), {wordRelations: [1, 2].map(() => ({main: {examples: study.spanishExamples}, translated: {examples: study.germanExamples}}))}, 'examples-only selections project the selected language and reviewed validity dependencies');
  const rawQuery = await graphql({schema, source: '{word(lang:"DE",id:"000000000000000000000001"){word notes}}'});
  assert.equal(rawQuery.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(rawQuery.data)), {word: {word: rawDE.word, notes: rawDE.notes}}, 'direct lookup continues to expose exact stored spellings');
  assert.deepEqual(await db.collection('WORDS_DE').findOne({_id: rawDE._id}), rawDE, 'dictionary reads never rewrite raw lookup data');
  const fallbackDE = await wordsResolvers.WordRelation.translated(relation);
  const fallbackES = await wordsResolvers.WordRelation.main(relation);
  assert.equal(fallbackDE.word, study.german, 'non-joined relation reader uses the same content');
  assert.deepEqual(fallbackDE.forms, study.forms);
  assert.deepEqual(fallbackDE.examples, study.germanExamples);
  assert.deepEqual(fallbackES.examples, study.spanishExamples);
  assert.equal(fallbackES.word, study.spanish);
  assert.equal((await lookupCatalogTranslation(getDb(), rawDE.word, 'de'))?.translation, rawES.word, 'corrected study heads preserve exact raw phrase-translation links without provider work');
  const legacyStudy = {...study, forms: undefined, category: undefined, germanExamples: undefined, spanishExamples: undefined};
  assert.deepEqual(dictionaryWord(rawDE, legacyStudy, 'DE')?.forms, rawDE.forms, 'older version-1 study content retains source grammar fallback');
  assert.deepEqual(dictionaryWord(rawDE, legacyStudy, 'DE')?.examples, rawDE.examples, 'older study content retains source examples');
  assert.deepEqual(dictionaryWord(rawDE, {...study, germanExamples: []}, 'DE')?.examples, [], 'intentionally empty reviewed examples remain empty');
  assert.deepEqual(dictionaryWord(rawDE, {...study, germanExamples: [5]}, 'DE')?.examples, rawDE.examples, 'malformed optional examples retain source fallback');
  assert.deepEqual(dictionaryWord(rawDE, {...study, forms: {gender: 5}, category: 'INVALID'}, 'DE')?.forms, rawDE.forms, 'malformed optional grammar does not replace source forms');
  for (const malformed of [null, {...study, version: 2}, {...study, german: ''}, {...study, spanish: 4}, {...study, notes: null}]) {
    assert.equal(dictionaryWord(rawDE, malformed, 'DE'), rawDE);
  }
  for (const [index, malformed] of [{...study, german: ''}, {...study, spanish: 4}, {...study, notes: null}].entries()) {
    await db.collection('WORDS_ES_DE').insertOne({...relation, _id: id(40 + index), study: {...malformed, german: index === 0 ? '' : `invalid-${index}`}});
    assert.deepEqual(await run({search: `invalid-${index}`}), [], 'malformed projected metadata cannot enter canonical search');
  }
  const missingRelation = {...relation, _id: id(33), translated: id(99)};
  assert.equal(await wordsResolvers.WordRelation.translated(missingRelation), null, 'reviewed text cannot fabricate an absent referenced word');
  await db.collection('WORDS_ES_DE').insertOne(missingRelation);
  const missing = await graphql({schema, source: '{wordRelations(search:"kindliche"){translated{word}}}'});
  assert.match(missing.errors?.[0].message ?? '', /Cannot return null for non-nullable field WordRelation.translated/, 'existing non-null GraphQL contract remains intact for broken references');
  await db.collection('WORDS_DE').insertMany([70, 71].map(n => ({...rawDE, _id: id(n), word: 'fahren', gramaticalCategories: ['VERB']})));
  await db.collection('WORDS_ES').insertMany([{...rawES, _id: id(72), word: 'ir'}, {...rawES, _id: id(73), word: 'conducir'}]);
  await db.collection('WORDS_ES_DE').insertMany([{_id: id(74), main: id(72), translated: id(70), createdAt}, {_id: id(75), main: id(73), translated: id(71), study: {...study, german: 'Ein Auto fahren', spanish: 'un auto conducir', category: 'VERB'}, createdAt}]);
  assert.equal((await lookupCatalogTranslation(getDb(), 'fahren', 'de'))?.translation, 'ir / conducir', 'secondary construction records retain all exact same-lemma phrase translations');
  console.log('PASS real reviewed dictionary GraphQL labels/notes, literal bilingual alias search, CEFR, stable pages, projections, raw lookup and legacy/missing-reference fallback');
} finally {
  await db.dropDatabase();
  await client.close();
}
