import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { BSON, MongoClient, ObjectId } from 'mongodb';
import type { UserProgress } from '../src/features/progress/progress.types.js';
import { planLegacyStudyRestart } from './lib/legacyStudyRestart.js';

const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const id = option('--progress-id'), envPath = option('--env-file'), output = option('--output');
if (!id || !ObjectId.isValid(id) || !envPath || !output) throw new Error('Usage: restartLegacyStudyCard.ts --progress-id ID --env-file private.env --output private/directory [--apply --confirmed-unstudied --expected-version N]');
const apply = args.includes('--apply');
if (apply && (!args.includes('--confirmed-unstudied') || !/^\d+$/.test(option('--expected-version') ?? '')))
  throw new Error('Apply requires owner confirmation that this card was never studied and its reviewed schedule version');
const env = dotenv.parse(await readFile(envPath));
const uri = env.MONGODB_URI || `mongodb+srv://${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(env.DB_USER_PASSWORD)}@${env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10000 }).connect();
try {
  const db = client.db('gramatikapp'), progress = db.collection<UserProgress>('userprogresses');
  const before = await progress.findOne({ _id: new ObjectId(id) });
  assert.ok(before, 'Card progress missing');
  const receipts = await db.collection('reviewevents').find({ userId: before.userId, itemId: before.itemId }).toArray();
  const now = new Date(), plan = planLegacyStudyRestart(before, receipts, now);
  const folder = resolve(output), run = `${apply ? 'apply' : 'dry-run'}-${now.getTime()}`;
  await mkdir(folder, { recursive: true, mode: 0o700 });
  // Private, exclusive, lossless backup precedes a possible write.
  await writeFile(resolve(folder, `${run}-before.ejson`), BSON.EJSON.stringify({ progress: before, receipts }, { relaxed: false }), { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(folder, `${run}-plan.ejson`), BSON.EJSON.stringify(plan, { relaxed: false }), { mode: 0o600, flag: 'wx' });
  if (apply) {
    assert.equal(before.scheduleVersion ?? 0, Number(option('--expected-version')), 'Schedule changed since the approved dry run');
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await progress.findOne(plan.filter, { session });
        assert.ok(current, 'Concurrent schedule or card change; restart aborted');
        const freshReceipts = await db.collection('reviewevents').find({ userId: current.userId, itemId: current.itemId }, { session }).toArray();
        planLegacyStudyRestart(current, freshReceipts, now);
        const result = await progress.updateOne(plan.filter, plan.update, { session });
        assert.equal(result.matchedCount, 1, 'Concurrent schedule change; restart aborted');
        const after = await progress.findOne({ _id: before._id }, { session });
        assert.ok(after);
        assert.equal(after.scheduler?.phase, 'NEW');
        assert.equal(after.failureIndex, current.failureIndex);
        assert.deepEqual(after.failureAttemptIds, current.failureAttemptIds);
        assert.deepEqual(after.lastFailedAt, current.lastFailedAt);
        assert.deepEqual(after.card, current.card);
      });
    } finally { await session.endSession(); }
  }
  console.log(JSON.stringify({ status: apply ? 'one confirmed card restarted' : 'dry run; no database writes',
    scheduleVersion: before.scheduleVersion ?? 0, from: { phase: before.scheduler?.phase, nextDueDate: before.nextDueDate, lastReviewed: before.lastReviewed },
    to: { phase: 'NEW', nextDueDate: now, lastReviewed: null, totalReviews: 0 }, preserved: plan.preserved, privateBackupDirectory: folder }, null, 2));
} finally { await client.close(); }
