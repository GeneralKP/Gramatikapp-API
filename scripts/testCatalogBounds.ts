import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { typeDefs } from '../src/graphql/schema.js';
import { wordsResolvers } from '../src/features/words/words.resolvers.js';
import { phrasesResolvers } from '../src/features/phrases/phrases.resolvers.js';

// Only the MongoDB boundary is replaced. No network or real database is used.
const reads: { name: string; method: string; limit?: number; offset?: number }[] = [];
const word = { _id: new ObjectId('000000000000000000000001'), word: 'Haus', createdAt: new Date('2026-10-15T00:00:00Z') };
const phrase = { _id: new ObjectId('000000000000000000000002'), phrase: 'Das ist ein Haus.', words: [], createdAt: word.createdAt };
const collection = (name: string) => ({
  async createIndex() {}, async dropIndex() {},
  find() {
    const read = { name, method: 'find', limit: undefined as number | undefined, offset: undefined as number | undefined };
    reads.push(read);
    return {
      skip(value: number) { read.offset = value; return this; },
      limit(value: number) { read.limit = value; return this; },
      async toArray() { return [name.startsWith('PHRASES') ? phrase : word]; },
    };
  },
  aggregate(pipeline: any[]) {
    reads.push({ name, method: 'aggregate', limit: pipeline.find(stage => stage.$limit !== undefined)?.$limit });
    return { async toArray() { return []; } };
  },
});
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = function () { return { collection } as any; };
const schema = makeExecutableSchema({ typeDefs, resolvers: {
  Query: { ...wordsResolvers.Query, ...phrasesResolvers.Query },
  Word: wordsResolvers.Word, NewPhrase: phrasesResolvers.NewPhrase,
  WordRelation: wordsResolvers.WordRelation, PhraseRelation: phrasesResolvers.PhraseRelation,
} });
const operations = [
  { field: 'words', args: 'lang:"DE",', defaultLimit: 100, offset: true },
  { field: 'newPhrases', args: 'lang:"DE",', defaultLimit: 100, offset: true },
  { field: 'wordsWithoutTranslation', args: 'lang:"DE",', defaultLimit: 100, offset: false },
  { field: 'wordRelationsWithoutPhrases', args: '', defaultLimit: 20, offset: false },
];
const execute = (source: string, variableValues?: Record<string, unknown>) => graphql({ schema, source, variableValues });
try {
  await connectDatabase();
  for (const operation of operations) {
    reads.length = 0;
    const args = operation.args.replace(/,$/, '');
    const result = await execute(`query { ${operation.field}${args ? `(${args})` : ''} { id } }`);
    assert.equal(result.errors, undefined, `${operation.field} default response`);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].limit, operation.defaultLimit);
    for (const limit of [1, 100, 500]) {
      reads.length = 0;
      const result = await execute(`query($limit:Int!){${operation.field}(${operation.args}limit:$limit${operation.offset ? ',offset:3' : ''}){id}}`, { limit });
      assert.equal(result.errors, undefined, `${operation.field} valid limit ${limit}`);
      assert.equal(reads.length, 1);
      assert.equal(reads[0].limit, limit);
      if (operation.offset) assert.equal(reads[0].offset, 3);
    }
  }
  console.log('PASS direct catalog default and valid GraphQL pagination contracts');

  const failures: string[] = [];
  const rejected = async (label: string, source: string, variables?: Record<string, unknown>) => {
    reads.length = 0;
    const result = await execute(source, variables);
    if (!result.errors?.length || reads.length) failures.push(`${label}: errors=${result.errors?.map(error => error.message).join(';') ?? 'none'}, database reads=${reads.length}`);
  };
  for (const operation of operations) {
    for (const limit of [0, -1, 501, 2147483647]) {
      await rejected(`${operation.field} variable ${limit}`, `query($limit:Int!){${operation.field}(${operation.args}limit:$limit){id}}`, { limit });
      await rejected(`${operation.field} literal ${limit}`, `query{${operation.field}(${operation.args}limit:${limit}){id}}`);
    }
    for (const limit of [null, 1.5, '100', 2147483648]) {
      await rejected(`${operation.field} malformed variable ${String(limit)}`, `query($limit:Int){${operation.field}(${operation.args}limit:$limit){id}}`, { limit });
    }
    if (operation.offset) {
      for (const offset of [-1, null, 1.5, '1', 2147483648]) {
        await rejected(`${operation.field} invalid offset ${String(offset)}`, `query($offset:Int){${operation.field}(${operation.args}limit:1,offset:$offset){id}}`, { offset });
      }
      await rejected(`${operation.field} literal negative offset`, `query{${operation.field}(${operation.args}limit:1,offset:-1){id}}`);
    }
  }
  assert.deepEqual(failures, [], 'Invalid list bounds must fail before any database operation');
  console.log('PASS public catalog literal/variable bounds and malformed pagination rejected before MongoDB');

  // These joined catalog operations have an existing clamping contract.
  for (const field of ['wordRelations', 'phraseRelations']) for (const [limit, offset, expected] of [[0, -2, 1], [501, 3, 500]]) {
    reads.length = 0;
    const result = await execute(`query($limit:Int,$offset:Int){${field}(limit:$limit,offset:$offset){id}}`, { limit, offset });
    assert.equal(result.errors, undefined);
    assert.equal(reads[0].limit, expected, 'Existing joined catalog clamping remains supported');
  }
  console.log('PASS joined catalog clamping compatibility');
} finally { await closeDatabase(); }
