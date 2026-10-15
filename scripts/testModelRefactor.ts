import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { typeDefs } from '../src/graphql/schema.js';
import { phrasesResolvers } from '../src/features/phrases/phrases.resolvers.js';
import { wordsResolvers } from '../src/features/words/words.resolvers.js';
import { WordLevel } from '../src/features/words/words.types.js';
import { PhraseLevel } from '../src/features/phrases/phrases.types.js';
import { initialScheduler } from '../src/features/progress/scheduler.js';
import { applyDailyLimit, introducedToday } from '../src/features/progress/dailyLimit.js';

const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const date = new Date('2026-10-15T10:30:00.000Z');
const words = [{ _id: id(1), word: 'casa', createdAt: date }, { _id: id(2), word: 'Haus', createdAt: date }];
const phrases: any[] = [
  { _id: id(10), phrase: 'Ein Haus.', synonyms: ['Das Haus.'], words: [id(2), id(99), id(1), id(2)], contexts: ['work'], createdAt: date,
    perWordExplanation: { Haus: { missing: 'Article', misplaced: 'Position' }, Ein: { misspelled: 'Capital' } }, level: 'B2', cefrLevel: 'A1.2' },
  { _id: id(11), phrase: 'Absent.', contexts: [], createdAt: date },
  { _id: id(12), phrase: 'Null.', words: null, contexts: [], perWordExplanation: null, createdAt: date },
  { _id: id(13), phrase: 'Empty.', words: [], contexts: [], perWordExplanation: {}, createdAt: date },
  { _id: id(14), phrase: 'No timestamp.', words: [], contexts: [] },
];
const reads: { name: string; id?: string }[] = [];
const collection = (name: string) => ({
  async createIndex() {}, async dropIndex() {},
  find() { reads.push({ name }); return { skip() { return this; }, limit() { return this; }, async toArray() { return phrases.slice(0, 4); } }; },
  async findOne(query: any) {
    reads.push({ name, id: String(query._id) });
    const source = name === 'WORDS_ES' ? [words[0]] : name === 'WORDS_DE' ? [words[1]] : phrases;
    return source.find(row => String(row._id) === String(query._id)) ?? null;
  },
});
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = function () { return { collection } as any; };
const schema = makeExecutableSchema({ typeDefs, resolvers: {
  Query: phrasesResolvers.Query, NewPhrase: phrasesResolvers.NewPhrase, PhraseRelation: phrasesResolvers.PhraseRelation, Word: wordsResolvers.Word,
} });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const fields = 'id phrase synonyms createdAt level cefrLevel perWordExplanation{key value{missing misplaced misspelled}} words{id word}';
try {
  await connectDatabase();
  const result = await graphql({ schema, source: `query{newPhrases(lang:"DE"){${fields}}}` });
  assert.equal(result.errors, undefined);
  const empty = { synonyms: null, createdAt: date.toISOString(), level: null, cefrLevel: null, perWordExplanation: [], words: [] };
  assert.deepEqual(json(result.data), { newPhrases: [
    { id: String(id(10)), phrase: 'Ein Haus.', synonyms: ['Das Haus.'], createdAt: date.toISOString(), level: 'A1', cefrLevel: 'A1.2',
      perWordExplanation: [{ key: 'Haus', value: { missing: 'Article', misplaced: 'Position', misspelled: null } }, { key: 'Ein', value: { missing: null, misplaced: null, misspelled: 'Capital' } }],
      words: [{ id: String(id(2)), word: 'Haus' }, { id: String(id(1)), word: 'casa' }, { id: String(id(2)), word: 'Haus' }] },
    { id: String(id(11)), phrase: 'Absent.', ...empty },
    { id: String(id(12)), phrase: 'Null.', ...empty },
    { id: String(id(13)), phrase: 'Empty.', ...empty },
  ] });
  assert.deepEqual(reads.filter(read => read.name.startsWith('WORDS')).map(read => [read.name, read.id]), [
    ['WORDS_ES', String(id(2))], ['WORDS_DE', String(id(2))], ['WORDS_ES', String(id(99))], ['WORDS_DE', String(id(99))], ['WORDS_ES', String(id(1))], ['WORDS_ES', String(id(2))], ['WORDS_DE', String(id(2))],
  ], 'Phrase words preserve original order, duplicate occurrences, Spanish preference and missing-reference behavior');
  for (const value of phrases.slice(0, 4)) {
    const single = await graphql({ schema, source: `query{newPhrase(lang:"ES",id:"${value._id}"){${fields}}}` });
    assert.equal(single.errors, undefined);
    assert.deepEqual(json(single.data).newPhrase, json(result.data).newPhrases[phrases.indexOf(value)]);
    for (const [field, slot] of [['main', 'mainDoc'], ['translated', 'translatedDoc']] as const) {
      reads.length = 0;
      const resolver = phrasesResolvers.PhraseRelation[field];
      const cached = await resolver({ [slot]: value });
      assert.equal(reads.length, 0, 'Joined documents do not requery MongoDB');
      const loaded = await resolver({ [field]: value._id });
      assert.deepEqual(cached, loaded, 'Joined and separately hydrated phrase serialization stays identical');
      assert.equal(cached.createdAt, date.toISOString());
    }
  }
  for (const slot of ['mainDoc', 'translatedDoc']) {
    reads.length = 0;
    const resolver = phrasesResolvers.PhraseRelation[slot === 'mainDoc' ? 'main' : 'translated'];
    assert.equal(await resolver({ [slot]: null }), null);
    assert.equal(await resolver({ [slot]: undefined }), null);
    assert.equal(reads.length, 0, 'Explicitly missing joined reference must not trigger a second query');
  }
  const absent = await graphql({ schema, source: `query{newPhrase(lang:"DE",id:"${id(99)}"){id}}` });
  assert.deepEqual(json(absent.data), { newPhrase: null });
  const noDate = await graphql({ schema, source: `query{newPhrase(lang:"DE",id:"${id(14)}"){id createdAt}}` });
  assert.deepEqual(json(noDate.data), { newPhrase: null });
  assert.match(noDate.errors?.[0].message ?? '', /Cannot return null for non-nullable field NewPhrase.createdAt/);

  const current: any = { _id: id(20), userId: id(21), itemId: id(22), itemType: 'WORD', ease: 2.5, interval: 0, repetitions: 0, isNew: true, nextDueDate: date, lastReviewed: null, createdAt: date };
  current.scheduler = initialScheduler(current);
  const original = json(current);
  const limited = applyDailyLimit([current], 0);
  assert.equal(limited[0].scheduler.options.newPerDay, 0);
  assert.deepEqual(json(current), original, 'Account quota projection does not mutate persisted card state');
  assert.equal(introducedToday(new Map([['App', { new: 2, review: 3 }], ['App::Words', { new: 2, review: 3 }], ['Other', { new: 1, review: 0 }]])), 3, 'Child deck introductions are counted once');
  assert.deepEqual(Object.values(WordLevel), ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  assert.deepEqual(Object.values(PhraseLevel), Object.values(WordLevel), 'Retain import and old-client level enums');
  console.log('PASS exact GraphQL phrase serialization, bilingual words, nullable/missing fields, joined hydration, legacy levels and quota projection');
} finally { await closeDatabase(); }
