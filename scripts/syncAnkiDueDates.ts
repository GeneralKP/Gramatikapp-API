import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BSON, MongoClient, ObjectId } from 'mongodb';
import { planAnkiDueSync, dueSyncGuard } from './lib/ankiDueSync.js';

const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const exportPath = option('--export'), user = option('--user-id'), outputPath = option('--output');
if (!exportPath || !user || !ObjectId.isValid(user) || !outputPath)
  throw new Error('Usage: syncAnkiDueDates.ts --export export.json --user-id ID --output private/directory [--align-status] [--reference official-due-dates.json] [--apply]');
const uri = process.env.MONGODB_URI || (process.env.DB_CLUSTER && process.env.DB_USER && process.env.DB_USER_PASSWORD
  ? `mongodb+srv://${process.env.DB_USER}:${process.env.DB_USER_PASSWORD}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority` : undefined);
if (!uri) throw new Error('Explicit database configuration required');
const source = JSON.parse(await readFile(resolve(exportPath), 'utf8'));
const referencePath = option('--reference');
const reference = referencePath ? JSON.parse(await readFile(resolve(referencePath), 'utf8')) : undefined;
const apply = args.includes('--apply'), alignStatus = args.includes('--align-status');
const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10000 }).connect();
try {
  const db = client.db('gramatikapp'), userId = new ObjectId(user), progress = db.collection('userprogresses');
  assert.ok(await db.collection('users').findOne({ _id: userId }, { projection: { _id: 1 } }), 'Account missing');
  assert.ok(await db.collection('ANKI_IMPORTS').findOne({ userId, status: 'complete' }), 'No completed Anki import');
  const profile = await db.collection('schedulerprofiles').findOne({ _id: userId });
  assert.ok(profile, 'Scheduler profile missing');
  const now = new Date(), before = await progress.find({ userId }).toArray();
  const plan = planAnkiDueSync(source, before, profile.timeZone, profile.rollover, alignStatus, now);
  // Verify all scheduled matches, including already equal dates, against Anki.
  if (reference) {
    const dates = new Map(plan.changes.map(c => [c.sourceCardId, c.set.nextDueDate ?? c.before.nextDueDate]));
    let verified = 0;
    for (const p of before) if (p.card?.source === 'ANKI' && reference[p.card.sourceCardId]) {
      assert.equal((dates.get(p.card.sourceCardId) ?? p.nextDueDate).toISOString(), reference[p.card.sourceCardId], 'Official Anki due date mismatch');
      verified++;
    }
    assert.equal(verified, plan.summary.scheduled, 'Incomplete official reference coverage');
  }
  const output = resolve(outputPath);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const run = `${apply ? 'apply' : 'dry-run'}-${now.getTime()}`;
  // An exclusive private BSON snapshot and exact patch plan precede all writes.
  await writeFile(resolve(output, `${run}-before.ejson`), BSON.EJSON.stringify({ userId, profile, progress: before, sourceHash: source.sourceHash }, { relaxed: false }), { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(output, `${run}-plan.ejson`), BSON.EJSON.stringify(plan, { relaxed: false }), { mode: 0o600, flag: 'wx' });
  if (apply && plan.changes.length) {
    const session = client.startSession();
    let after;
    try {
      after = await session.withTransaction(async () => {
        const current = await progress.find({ userId }, { session }).toArray();
        assert.deepEqual(await db.collection('schedulerprofiles').findOne({ _id: userId }, { session }), profile, 'Scheduler profile changed; rerun dry run');
        const original = new Map(before.map(p => [String(p._id), p]));
        const sourceIds = new Set(source.tables.cards.map(c => String(c.id)));
        for (const p of current) if (p.card?.source === 'ANKI' && sourceIds.has(p.card.sourceCardId)) {
          const saved = original.get(String(p._id));
          assert.ok(saved, 'Matched card was added concurrently');
          assert.deepEqual(dueSyncGuard(p), dueSyncGuard(saved), 'Concurrent schedule change; rerun dry run');
        }
        const freshPlan = planAnkiDueSync(source, current, profile.timeZone, profile.rollover, alignStatus, now);
        assert.deepEqual(freshPlan.summary, plan.summary, 'Matched cards changed concurrently');
        for (let offset = 0; offset < plan.changes.length; offset += 250) {
          const changes = plan.changes.slice(offset, offset + 250);
          const result = await progress.bulkWrite(changes.map(c => ({ updateOne: { filter: dueSyncGuard(c.before), update: { $set: c.set } } })), { session, ordered: true });
          assert.equal(result.matchedCount, changes.length, 'Concurrent schedule change; entire transaction aborted');
        }
        const actual = await progress.find({ userId }, { session }).toArray();
        const patches = new Map(plan.changes.map(c => [String(c.before._id), c.set]));
        const byId = new Map(actual.map(p => [String(p._id), p]));
        assert.equal(actual.length, current.length, 'Unexpected card insertion/removal');
        // Exact full-document verification preserves counters, lexical changes,
        // original Anki archive fields and every unmatched/new card.
        for (const p of current) assert.deepEqual(byId.get(String(p._id)), { ...p, ...patches.get(String(p._id)) });
        return actual;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
    await writeFile(resolve(output, `${run}-after.ejson`), BSON.EJSON.stringify({ progress: after }, { relaxed: false }), { mode: 0o600, flag: 'wx' });
  }
  const summary = { status: apply ? 'applied and verified' : 'dry run; no database writes', sourceHash: source.sourceHash,
    ...plan.summary, officialReferenceVerified: !!reference, backup: resolve(output, `${run}-before.ejson`) };
  await writeFile(resolve(output, `${run}-result.json`), JSON.stringify(summary, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2));
} finally { await client.close(); }
