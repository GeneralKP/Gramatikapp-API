import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { MongoClient, ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { typeDefs, resolvers } from '../src/graphql/schema.js';
import { initialScheduler } from '../src/features/progress/scheduler.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

// No socket, production environment or provider is involved. The real GraphQL
// schema observes only the external Mongo boundary replaced below.
const RealDate = Date;
const now = new RealDate('2026-10-06T10:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(value?: string | number | Date) { super(value === undefined ? +now : value); }
  static now() { return +now; }
} as DateConstructor;
const id = (value: number) => new ObjectId(value.toString(16).padStart(24, '0'));
const user = { _id: id(1), settings: { dailyNewCards: 0 } };
const base: UserProgress = {
  _id: id(10), userId: user._id, itemId: id(20), relationId: id(30), itemType: 'WORD',
  ease: 2.7, interval: 30, repetitions: 4, nextDueDate: new Date('2026-10-09T02:00:00Z'),
  lastReviewed: new Date('2026-09-09T08:00:00Z'), createdAt: new Date('2026-01-01T00:00:00Z'),
};
const legacy = { ...base };
const temporary = { ...base, _id: id(11), itemId: id(21), itemType: 'PHRASE' as const,
  failureIndex: 0, totalReviews: 0, lapses: 0, scheduleVersion: 0,
  temporaryDueDate: new Date('2026-10-06T09:30:00Z'),
  lastFailedAt: new Date('2026-10-01T11:00:00Z'), buriedUntil: null,
};
temporary.scheduler = initialScheduler(temporary);
const known = { ...base, _id: id(12), itemId: id(22), relationId: undefined,
  failureIndex: 7, totalReviews: 9, lapses: 2, scheduleVersion: 4,
  card: { source: 'APP' as const, sourceCardId: '1790000000000', sourceNoteGuid: 'fixture-pair',
    direction: 'DE_ES' as const, prompt: 'Haus', answer: 'casa', acceptedAnswers: ['casa'],
    notes: '', examples: [], deck: 'Fixture', tags: [] },
};
known.scheduler = { ...initialScheduler(known), knownInterval: 180 };
const rows = [legacy, temporary, known];
let reads = 0;
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = function () { return { collection: (name: string) => ({
  async createIndex() {}, async dropIndex() {},
  find(query: object) {
    reads++;
    assert.equal(name, 'userprogresses');
    assert.deepEqual(query, { userId: user._id });
    return { async toArray() { return rows; } };
  },
}) } as never; };
await connectDatabase();
const schema = makeExecutableSchema({ typeDefs, resolvers });
const fields = 'id userId itemId itemType relationId failureIndex totalReviews scheduleVersion studyState schedulerPhase learningQueue learnAheadSeconds lapses lastFailedAt nextDueDate regularDueDate temporaryDueDate lastReviewed';
const execute = (source: string, contextValue: object) => graphql({ schema, source, contextValue });
try {
  const result = await execute(`query { allProgress(userId:"${user._id}") { ${fields} } }`, { user });
  assert.equal(result.errors, undefined);
  const actual = JSON.parse(JSON.stringify(result.data));
  const fixture = new URL('./fixtures/progress-presentation.json', import.meta.url);
  if (process.argv.includes('--record-baseline')) writeFileSync(fixture, JSON.stringify(actual, null, 2) + '\n');
  else assert.deepEqual(actual, JSON.parse(readFileSync(fixture, 'utf8')), 'Complete legacy/current/temporary/Known GraphQL serialization must retain its baseline');
  assert.equal(reads, 1);
  assert.equal(legacy.scheduler, undefined, 'Reading legacy progress must not save a derived scheduler');
  assert.equal(legacy.failureIndex, undefined, 'Response defaults must not mutate stored fields');
  const operations = [
    'query{studyQueueCounts(userId:"bad-id"){new}}',
    'query{dueItems(userId:"bad-id"){id}}',
    'query{studyMoreItems(userId:"bad-id"){id}}',
    'query{userProgress(userId:"bad-id",itemId:"bad-id"){id}}',
    'query{allProgress(userId:"bad-id"){id}}',
    'query{learningPath(userId:"bad-id"){id}}',
    'query{reviewHistory(userId:"bad-id"){reviewId}}',
    'query{mostFailedWords(userId:"bad-id"){failureIndex}}',
    'mutation{recordFailure(userId:"bad-id",itemId:"bad-id",attemptId:"fixture"){id}}',
    'mutation{reviewItem(userId:"bad-id",itemId:"bad-id",itemType:"WORD",rating:4){success}}',
    'mutation{undoReview(userId:"bad-id",reviewId:"fixture"){success}}',
  ];
  for (const source of operations) for (const context of [{ user: null }, { user }]) {
    reads = 0;
    const rejected = await execute(source, context);
    assert.deepEqual(rejected.errors?.map(error => error.message), ['Unauthorized'], source);
    assert.equal(reads, 0, 'Ownership rejection must precede ID conversion and database work');
  }
  console.log('PASS complete progress response baseline, read-only defaults, and 22 authentication/ownership-before-ID cases');
} finally { await closeDatabase(); globalThis.Date = RealDate; }
