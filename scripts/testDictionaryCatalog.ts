import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { typeDefs } from '../src/graphql/schema.js';
import { catalogProjection } from '../src/features/levels/catalogProjection.js';
import { catalogPipeline } from '../src/features/levels/catalogQuery.js';

// A disposable loopback database only; this suite never uses production env.
const uri = process.env.TEST_DICTIONARY_URI ?? 'mongodb://127.0.0.1:27017';
assert.match(uri, /^mongodb:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/, 'Dictionary fixtures require loopback MongoDB');
const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }).connect();
const db = client.db(`dictionary_contract_tests_${process.pid}`);
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const baseline = (args: { limit?: number; offset?: number; search?: string; cefrLevel?: string }, field: 'word' | 'phrase') => {
  // Existing contract: full documents joined before selection and pagination.
  const match: Record<string, unknown> = {};
  if (args.search) {
    const regex = args.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    match.$or = ['mainDocs', 'translatedDocs'].map(side => ({[`${side}.${field}`]: {$regex: regex, $options: 'i'}}));
  }
  if (args.cefrLevel) match['translatedDocs.cefrLevel'] = args.cefrLevel;
  return [
    { $lookup: { from: 'es', localField: 'main', foreignField: '_id', as: 'mainDocs' } },
    { $lookup: { from: 'de', localField: 'translated', foreignField: '_id', as: 'translatedDocs' } },
    {$match: match}, {$sort: {[`translatedDocs.${field}`]: 1, _id: 1}},
    {$skip: args.offset ?? 0}, {$limit: args.limit ?? 100},
  ];
};
try {
  await db.collection('es').insertMany(Array.from({ length: 121 }, (_, n) => ({
    _id: id(1000 + n), word: `es-${n % 8}`, phrase: `Spanish ${n % 8}`,
    examples: [`example-${n}`], notes: 'e'.repeat(32000), contexts: ['work'],
  })));
  await db.collection('de').insertMany(Array.from({ length: 121 }, (_, n) => ({
    _id: id(2000 + n), word: n === 1 ? '^(.+)$' : `DE-${n % 9}`,
    phrase: n === 1 ? '^(.+)$' : `Deutsch ${n % 9}`,
    cefrLevel: n % 2 ? 'A1.1' : 'B2.2', forms: {gender: 'das',plural: `plural-${n}`},
    perWordExplanation: { token: { missing: `case-${n}` } }, notes: 'd'.repeat(32000),
  })));
  await db.collection('relations').insertMany(Array.from({ length: 123 }, (_, n) => ({
    _id: id(3000 + n), main: id(1000 + n), translated: id(2000 + n), createdAt: new Date(0),
  })));
  for (const field of ['word', 'phrase'] as const) {
    for (const args of [
      {limit: 61}, {limit: 61, offset: 60}, {limit: 1, offset: 120}, {limit: 10, search: 'es-'},
      {limit: 10, search: 'SPANISH'}, {limit: 10, search: 'de-'}, {limit: 10, search: 'Deutsch'},
      {limit: 10, search: '^(.+)$'}, {limit: 61, cefrLevel: 'A1.1'},
      {limit: 10, offset: 5, search: '1', cefrLevel: 'A1.1'}, {limit: 500, search: 'missing'},
    ]) {
      const original = await db.collection('relations').aggregate(baseline(args, field)).toArray();
      const optimized = await db.collection('relations').aggregate(catalogPipeline(args, 'es', 'de', field)).toArray();
      assert.deepEqual(optimized, original, `${field} exact full documents, missing references, stable ties, filter and page contract`);
    }

  }
  let projectSelected = false;
  let transferredBytes = 0;
  const load = async (_: unknown, args: Record<string, unknown>, _context: unknown, info: Parameters<typeof catalogProjection>[0]) => {
    const rows = await db.collection('relations').aggregate(catalogPipeline(args, 'es', 'de', info!.fieldName === 'wordRelations' ? 'word' : 'phrase', projectSelected ? catalogProjection(info) : undefined)).toArray();
    transferredBytes = Buffer.byteLength(JSON.stringify(rows));
    return rows;
  };
  const endpoint = (row: {mainDocs: Record<string, unknown>[]; translatedDocs: Record<string, unknown>[]}, side: 'mainDocs' | 'translatedDocs') => {
    const doc = row[side][0];
    if (!doc) return null;
    return {...doc, perWordExplanation: doc.perWordExplanation ? Object.entries(doc.perWordExplanation).map(([key,value]) => ({key,value})) : undefined};
  };
  const schema = makeExecutableSchema({typeDefs, resolvers: {
    Query: {wordRelations: load, phraseRelations: load},
    WordRelation: {id: row => String(row._id), main: row => endpoint(row,'mainDocs'), translated: row => endpoint(row,'translatedDocs')},
    PhraseRelation: {id: row => String(row._id), main: row => endpoint(row,'mainDocs'), translated: row => endpoint(row,'translatedDocs')},
    Word: {id: row => String(row._id), level: row => row.cefrLevel?.split('.')[0] ?? row.level ?? null},
    NewPhrase: {id: row => String(row._id), level: row => row.cefrLevel?.split('.')[0] ?? row.level ?? null},
  }});
  for (const source of [
    'query($details:Boolean!){words:wordRelations(limit:61,offset:2){id a:main{...Metadata notes @include(if:$details)} b:translated{id word level forms{gender plural} ... on Word{notes @skip(if:$details)}}}} fragment Metadata on Word{id word examples}',
    'query($details:Boolean!){phraseRelations(limit:61,offset:2){id main{id phrase} translated{phrase level cefrLevel perWordExplanation @include(if:$details){key value{missing}}}}}',
  ]) for(const details of [false,true]) {
    projectSelected = false;
    const full = await graphql({schema, source, variableValues:{details}});
    assert.equal(full.errors, undefined);
    const fullBytes = transferredBytes;
    projectSelected = true;
    const projected = await graphql({schema, source, variableValues:{details}});
    assert.equal(projected.errors, undefined);
    assert.deepEqual(projected,full,'actual GraphQL response parity with aliases, fragments, directives, derived CEFR level and rich fields');
    assert.ok(transferredBytes < fullBytes,'only requested stored fields cross the database connection');
  }
  console.log('PASS dictionary real MongoDB exact bilingual/filter/page/tie/missing-reference parity and selected GraphQL fields/aliases/fragments/directives');
} finally {
  await db.dropDatabase();
  await client.close();
}
