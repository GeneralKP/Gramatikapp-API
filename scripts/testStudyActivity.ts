import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { ApolloServer } from '@apollo/server';
import { MongoClient, ObjectId } from 'mongodb';
import { loadStudyActivity, studyActivityWindow, summarizeStudyActivity } from '../src/features/progress/studyActivity.js';
import { progressResolvers } from '../src/features/progress/progress.resolvers.js';
import type { ReviewEvent } from '../src/features/progress/reviews.js';
import type { User } from '../src/features/auth/auth.types.js';

const DAY = 86_400_000;
const now = new Date('2026-10-15T12:00:00.000Z');
const owner = new ObjectId(), other = new ObjectId();
const user = { _id: owner } as User;
const activityArgs = { userId: String(owner), timezone: 'Europe/Berlin' };

// Ownership failures must happen without an initialized database, even with a
// malformed timezone or ObjectId belonging to a different account.
await assert.rejects(progressResolvers.Query.studyActivity(null, activityArgs, { user: null }), /Unauthorized/);
await assert.rejects(progressResolvers.Query.studyActivity(null, activityArgs, { user: { _id: other } as User }), /Unauthorized/);
await assert.rejects(progressResolvers.Query.studyActivity(null, { userId: 'malformed', timezone: 'invalid' }, { user }), /Unauthorized/);
await assert.rejects(progressResolvers.Query.studyActivity(null, { ...activityArgs, timezone: 'Not/A_Timezone' }, { user }), /Invalid timezone/);
for (const invalid of ['', ' ', '+01:00', 'Not/A_Timezone', 'x'.repeat(101), '$timezone']) {
  assert.throws(() => studyActivityWindow(invalid, now), /Invalid timezone/);
}
const utc = studyActivityWindow('UTC', now);
assert.equal(utc.startDate, '2025-10-16');
assert.equal(utc.endDate, '2026-10-15');
assert.equal(utc.days.length, 365);
for (let index = 1; index < utc.days.length; index += 1) {
  assert.equal(Date.parse(utc.days[index].date) - Date.parse(utc.days[index - 1].date), DAY);
}
const leap = studyActivityWindow('Europe/Berlin', new Date('2024-03-01T12:00:00Z'));
assert.equal(leap.startDate, '2023-03-03');
assert.equal(leap.days.filter(day => day.date === '2024-02-29').length, 1);
assert.equal(studyActivityWindow('America/Los_Angeles', new Date('2026-10-15T00:30:00Z')).endDate, '2026-10-14');
assert.equal(studyActivityWindow('Pacific/Kiritimati', new Date('2026-10-14T10:30:00Z')).endDate, '2026-10-15');
assert.equal(studyActivityWindow('US/Eastern', now).timezone, 'America/New_York');

const summary = (counts: number[]) => summarizeStudyActivity(counts.map((count, index) => ({ date: `day-${index}`, count })));
assert.deepEqual([summary([1, 2, 0, 4, 3, 0]).currentStreak, summary([1, 2, 0, 4, 3, 0]).longestStreak], [2, 2]);
assert.equal(summary([1, 2, 0, 0]).currentStreak, 0);
assert.equal(summary([0, 1, 2, 3]).currentStreak, 3);
assert.equal(summary([0, 0]).longestStreak, 0);
assert.equal(summary([1, 2, 0, 4]).dailyAverage, 1.75);
console.log('PASS owner checks before database access, timezone validation, 365 dense dates, leap day, date-line offsets and streak grace');

// Only a numeric loopback host and this run's unique disposable database are
// allowed. No app/production database can be selected or dropped by this test.
const databaseName = `study_activity_tests_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
function fixtureTarget(uri: string) {
  assert.equal(uri, uri.trim());
  const target = new URL(uri);
  assert.equal(target.protocol, 'mongodb:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.ok(!target.username && !target.password && !target.hash);
  assert.ok(target.pathname === '' || target.pathname === '/');
  assert.equal([...target.searchParams].length, 0);
  target.pathname = `/${databaseName}`;
  target.searchParams.set('directConnection', 'true');
  return target.toString();
}
for (const unsafe of ['mongodb+srv://example.invalid', 'mongodb://example.invalid', 'mongodb://127.0.0.1.example.invalid', 'mongodb://localhost', 'mongodb://user:password@127.0.0.1', 'mongodb://127.0.0.1/gramatikapp', 'mongodb://127.0.0.1/admin', 'mongodb://127.0.0.1/?replicaSet=production', 'mongodb://127.0.0.1/#fragment', ' mongodb://127.0.0.1']) {
  assert.throws(() => fixtureTarget(unsafe));
}
process.env.MONGODB_URI = fixtureTarget(process.env.TEST_STUDY_ACTIVITY_URI ?? 'mongodb://127.0.0.1:27017');
const originalDb = MongoClient.prototype.db;
MongoClient.prototype.db = function (name?: string, options?: any) {
  assert.ok(name === undefined || name === 'gramatikapp' || name === databaseName);
  return originalDb.call(this, databaseName, options);
};
const { connectDatabase, closeDatabase, getDatabaseClient } = await import('../src/lib/database.js');
const { typeDefs, resolvers } = await import('../src/graphql/schema.js');
let connected = false;
const server = new ApolloServer<{ user: User | null }>({ typeDefs, resolvers });
const query = `query Activity($userId: ID!, $timezone: String!) {
  studyActivity(userId: $userId, timezone: $timezone) {
    startDate endDate days { date count } totalReviews activeDays currentStreak longestStreak dailyAverage
  }
}`;
try {
  const db = await connectDatabase(); connected = true;
  const fixtureDb = originalDb.call(getDatabaseClient(), databaseName);
  const before = await fixtureDb.listCollections().toArray();
  const event = (reviewedAt: string, extra: Partial<ReviewEvent> = {}): ReviewEvent => ({
    _id: new ObjectId(), userId: owner, itemId: new ObjectId(), itemType: 'WORD', reviewId: randomUUID(), grade: 'GOOD',
    reviewedAt: new Date(reviewedAt), reversedAt: null, earlyReview: false, before: {}, after: {}, version: 1,
    deck: 'Fixture', day: 0, newCount: 0, reviewCount: 0, siblings: [], ...extra,
  });
  const read = (zone = 'UTC', at = now) => loadStudyActivity(owner, zone, at, db);
  const count = (result: Awaited<ReturnType<typeof read>>, date: string) => result.days.find(day => day.date === date)?.count;
  const empty = await read();
  assert.equal(empty.days.length, 365);
  assert.equal(empty.totalReviews, 0);
  assert.equal(empty.activeDays, 0);
  assert.equal(empty.currentStreak, 0);
  assert.equal(empty.longestStreak, 0);

  const events = [
    event('2025-10-15T23:59:59.999Z'), // Immediately before first UTC date.
    event('2025-10-16T00:00:00.000Z'),
    event('2026-10-10T12:00:00.000Z'),
    event('2026-10-11T12:00:00.000Z', { itemType: 'PHRASE', grade: 'AGAIN' }),
    event('2026-10-12T12:00:00.000Z', { grade: 'REVISIT', earlyReview: true }),
    event('2026-10-14T22:30:00.000Z'), // Today in Berlin, yesterday in UTC.
    event('2026-10-14T22:30:00.000Z', { grade: 'HARD' }),
    event('2026-10-14T23:00:00.000Z', { reversedAt: now }),
    event('2026-10-14T23:30:00.000Z', { userId: other }),
    event('2026-10-15T12:00:00.001Z'), // Future timestamps never count early.
    event('2026-10-15T10:00:00.000Z', { itemType: 'READING' }),
  ];
  await db.reviewEvents.insertMany(events);
  const populated = await read();
  assert.equal(populated.totalReviews, 6);
  assert.equal(populated.activeDays, 5);
  assert.equal(populated.currentStreak, 1, 'Yesterday remains an active streak before today is studied');
  assert.equal(populated.longestStreak, 3);
  assert.equal(populated.dailyAverage, 6 / 365);
  assert.equal(count(populated, '2025-10-16'), 1);
  assert.equal(count(populated, '2026-10-14'), 2, 'Repeated actual reviews count separately');
  assert.equal(count(populated, '2026-10-15'), 0);
  const berlin = await read('Europe/Berlin');
  assert.equal(berlin.totalReviews, 7, 'The first local date includes its preceding UTC evening');
  assert.equal(count(berlin, '2026-10-15'), 2);
  assert.equal(berlin.currentStreak, 1);
  await db.reviewEvents.updateOne({ _id: events[6]._id }, { $set: { reversedAt: now } });
  assert.equal(count(await read('Europe/Berlin'), '2026-10-15'), 1, 'Undo removes only its receipt from history');
  await assert.rejects(db.reviewEvents.insertOne({ ...events[1], _id: new ObjectId() }), (error: any) => error.code === 11000);
  assert.equal((await read()).totalReviews, 5, 'An idempotent review identity cannot inflate activity');
  const scan = await db.reviewEvents.find({}).toArray();
  const repeat = await read();
  assert.deepEqual(await db.reviewEvents.find({}).toArray(), scan, 'Activity queries never modify receipts');
  assert.equal(repeat.totalReviews, 5);
  console.log('PASS real Mongo aggregation, inclusive local/UTC boundaries, owner isolation, all accepted grades, Undo, retries, future exclusion and read-only refresh');

  await db.reviewEvents.deleteMany({});
  await db.reviewEvents.insertMany([
    event('2026-03-28T23:00:00.000Z'), event('2026-03-29T00:30:00.000Z'),
    event('2026-03-29T01:30:00.000Z'), event('2026-03-29T21:59:59.999Z'),
    event('2026-03-29T22:00:00.000Z'),
    event('2026-10-24T22:00:00.000Z'), event('2026-10-25T00:30:00.000Z'),
    event('2026-10-25T01:30:00.000Z'), event('2026-10-25T22:59:59.999Z'),
    event('2026-10-25T23:00:00.000Z'),
    event('2024-02-28T23:00:00.000Z'), event('2024-02-29T22:59:59.999Z'),
    event('2024-02-29T23:00:00.000Z'),
  ]);
  const spring = await read('Europe/Berlin', new Date('2026-03-30T12:00:00.000Z'));
  assert.equal(count(spring, '2026-03-29'), 4, '23-hour spring day includes both sides of the DST jump');
  assert.equal(count(spring, '2026-03-30'), 1);
  const fall = await read('Europe/Berlin', new Date('2026-10-26T12:00:00.000Z'));
  assert.equal(count(fall, '2026-10-25'), 4, '25-hour fall day includes both repeated local 02:30 reviews');
  assert.equal(count(fall, '2026-10-26'), 1);
  const leapResult = await read('Europe/Berlin', new Date('2024-03-01T12:00:00.000Z'));
  assert.equal(count(leapResult, '2024-02-29'), 2);
  assert.equal(count(leapResult, '2024-03-01'), 1);
  assert.equal(leapResult.totalReviews, 3);

  await db.reviewEvents.deleteMany({});
  await db.reviewEvents.insertOne(event('2026-10-15T10:00:00.000Z'));
  mock.timers.enable({ apis: ['Date'], now: +now });
  const gql = await server.executeOperation({ query, variables: activityArgs }, { contextValue: { user } });
  assert.equal(gql.body.kind, 'single');
  if (gql.body.kind !== 'single') throw new Error('Expected single response');
  assert.equal(gql.body.singleResult.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(gql.body.singleResult.data.studyActivity)), await read('Europe/Berlin'));
  for (const contextValue of [{ user: null }, { user: { _id: other } as User }]) {
    const denied = await server.executeOperation({ query, variables: activityArgs }, { contextValue });
    assert.equal(denied.body.kind, 'single');
    if (denied.body.kind !== 'single') throw new Error('Expected single response');
    assert.match(denied.body.singleResult.errors[0].message, /Unauthorized/);
  }
  const invalid = await server.executeOperation({ query, variables: { ...activityArgs, timezone: 'Not/A_Timezone' } }, { contextValue: { user } });
  assert.equal(invalid.body.kind, 'single');
  if (invalid.body.kind !== 'single') throw new Error('Expected single response');
  assert.match(invalid.body.singleResult.errors[0].message, /Invalid timezone/);
  assert.deepEqual((await fixtureDb.listCollections().toArray()).map(item => item.name).sort(), before.map(item => item.name).sort(), 'No new tracking collection');
  console.log('PASS real DST and leap-day counts, complete GraphQL response contract, authenticated owner boundary and invalid-timezone rejection');
} finally {
  mock.timers.reset();
  await server.stop();
  if (connected) await originalDb.call(getDatabaseClient(), databaseName).dropDatabase();
  await closeDatabase();
  MongoClient.prototype.db = originalDb;
}
