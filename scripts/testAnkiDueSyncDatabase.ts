import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { DEFAULT_OPTIONS } from '../src/features/progress/scheduler.js';
import { dueSyncGuard, planAnkiDueSync } from './lib/ankiDueSync.js';

// Only the isolated replica set started for this task may run this test.
const uri = 'mongodb://127.0.0.1:27021/?directConnection=true';
const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10000 }).connect();
const userId = new ObjectId(), otherId = new ObjectId();
const output = await mkdtemp(join(tmpdir(), 'anki-due-sync-test-'));
try {
  const db = client.db('gramatikapp'), progress = db.collection('userprogresses');
  const source = { sourceHash: 'synthetic', tables: { col: [{ crt: 1715158800 }], notes: [{ id: 1, guid: 'synthetic-note' }],
    config: [{ KEY: 'creationOffset', val: { base64: Buffer.from('300').toString('base64') } }],
    cards: [0, 1, 2].map(ord => ({ id: 100 + ord, nid: 1, ord, type: ord === 2 ? 0 : 2, queue: ord === 2 ? 0 : 2, due: ord === 2 ? 999 : 883, left: 0, odid: 0 })) } };
  const rows = source.tables.cards.map(c => ({ _id: new ObjectId(), userId, itemId: new ObjectId(), itemType: 'WORD',
    card: { source: 'ANKI', sourceCardId: String(c.id), sourceNoteGuid: 'synthetic-note', direction: c.ord ? 'ES_DE' : 'DE_ES' },
    anki: c, nextDueDate: new Date('2020-01-01Z'), failureIndex: 7, failureAttemptIds: ['retained'], interval: 10,
    ease: 2.3, repetitions: 3, totalReviews: 9, lastReviewed: new Date('2026-01-01Z'), lastReviewId: 'old-review', scheduleVersion: 2, isNew: true,
    scheduler: { version: 1, phase: 'NEW', queue: 'NEW', remainingSteps: 0, scheduledSeconds: 0,
      interval: 10, ease: 2.3, lapses: 1, timeZone: 'Europe/Berlin', rollover: 4, options: DEFAULT_OPTIONS } }));
  const other = { ...rows[0], _id: new ObjectId(), userId: otherId };
  await db.collection('users').insertOne({ _id: userId });
  await db.collection('ANKI_IMPORTS').insertOne({ userId, status: 'complete' });
  await db.collection('schedulerprofiles').insertOne({ _id: userId, timeZone: 'Europe/Berlin', rollover: 4 });
  await progress.insertMany([...rows, other]);
  const path = join(output, 'export.json'); await writeFile(path, JSON.stringify(source));
  const call = (apply: boolean) => JSON.parse(execFileSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/syncAnkiDueDates.ts',
    '--export', path, '--user-id', String(userId), '--output', output, '--align-status', ...(apply ? ['--apply'] : [])],
  { env: { ...process.env, MONGODB_URI: uri }, encoding: 'utf8' }));
  const dry = call(false); assert.equal(dry.changedCards, 2);
  assert.deepEqual(await progress.findOne({ _id: rows[0]._id }), rows[0], 'Dry run wrote data');
  const applied = call(true); assert.equal(applied.changedCards, 2);
  const backup = await readFile(applied.backup, 'utf8'); assert.ok(backup.includes('synthetic'));
  for (const row of rows.slice(0, 2)) {
    const after = await progress.findOne({ _id: row._id });
    assert.equal(after.nextDueDate.toISOString(), '2026-10-08T02:00:00.000Z');
    assert.equal(after.scheduler.phase, 'REVIEW'); assert.equal(after.scheduleVersion, 3);
    assert.equal(after.lastReviewId, null, 'Old Undo pointer survived rescheduling');
    for (const key of ['failureIndex', 'failureAttemptIds', 'interval', 'ease', 'totalReviews', 'lastReviewed', 'anki', 'card'])
      assert.deepEqual(after[key], row[key], `Protected ${key} changed`);
  }
  assert.deepEqual(await progress.findOne({ _id: rows[2]._id }), rows[2], 'New card changed');
  assert.deepEqual(await progress.findOne({ _id: other._id }), other, 'Other account changed');
  assert.equal(call(true).changedCards, 0, 'Idempotent apply rewrote dates');
  // Simulate a stale second card: the first write must roll back with it.
  const current = await progress.find({ userId }).toArray();
  const moved = structuredClone(source); moved.tables.cards[0].due++; moved.tables.cards[1].due++;
  const plan = planAnkiDueSync(moved, current, 'Europe/Berlin', 4, true, new Date());
  await progress.updateOne({ _id: plan.changes[1].before._id }, { $inc: { scheduleVersion: 1, failureIndex: 1 } });
  const session = client.startSession();
  try {
    await assert.rejects(session.withTransaction(async () => {
      for (const c of plan.changes) {
        const result = await progress.updateOne(dueSyncGuard(c.before), { $set: c.set }, { session });
        assert.equal(result.matchedCount, 1, 'Stale schedule');
      }
    }), /Stale schedule/);
  } finally { await session.endSession(); }
  assert.deepEqual(await progress.findOne({ _id: plan.changes[0].before._id }), plan.changes[0].before, 'Partial transaction committed');
  assert.equal((await progress.findOne({ _id: plan.changes[1].before._id })).failureIndex, 8, 'Concurrent failure lost');
  console.log('PASS disposable MongoDB: CLI dry/apply/idempotence, exact date/status changes, protected history/accounts/new cards and all-or-nothing stale-review rollback');
} finally {
  const db = client.db('gramatikapp');
  await db.collection('userprogresses').deleteMany({ userId: { $in: [userId, otherId] } });
  await db.collection('users').deleteOne({ _id: userId });
  await db.collection('ANKI_IMPORTS').deleteMany({ userId });
  await db.collection('schedulerprofiles').deleteOne({ _id: userId });
  await client.close();
}
