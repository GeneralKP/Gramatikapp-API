import assert from 'node:assert/strict';
import { ObjectId, type Document } from 'mongodb';
import { planAnkiDueSync, dueSyncGuard } from './lib/ankiDueSync.js';
import { DEFAULT_OPTIONS } from '../src/features/progress/scheduler.js';

const now = new Date('2026-10-08T12:00:00Z');
const card = (id: number, ord: number, type = 2, queue = 2, due = 883) => ({ id, nid: 1, ord, type, queue, due, left: 1001, odid: 0 });
const source = (cards: ReturnType<typeof card>[]) => ({ tables: { cards, notes: [{ id: 1, guid: 'shared-note' }],
  config: [{ KEY: 'creationOffset', val: { base64: Buffer.from('300').toString('base64') } }], col: [{ crt: 1715158800 }] } });
const progress = (c: ReturnType<typeof card>) => ({ _id: new ObjectId(), userId: new ObjectId(),
  card: { source: 'ANKI', sourceCardId: String(c.id), sourceNoteGuid: 'shared-note', direction: c.ord ? 'ES_DE' : 'DE_ES' },
  anki: { ord: c.ord }, nextDueDate: new Date('2020-01-01Z'), scheduleVersion: 3, isNew: false, failureIndex: 99, lastReviewId: 'old-review',
  scheduler: { version: 1, phase: 'REVIEW', queue: 'DAY', interval: 90, ease: 2.3, lapses: 10,
    remainingSteps: 0, scheduledSeconds: 0, timeZone: 'Europe/Berlin', rollover: 4, options: DEFAULT_OPTIONS } });
const plan = (s: ReturnType<typeof source>, p: Document[], status = false) => planAnkiDueSync(s, p, 'Europe/Berlin', 4, status, now);
const a = card(100, 0), b = card(101, 1, 1, 1, 1791398171), fresh = card(102, 2, 0, 0, 999);
const rows = [progress(a), progress(b), progress(fresh)];
const originals = structuredClone(rows);
const result = plan(source([a, b, fresh]), rows, true);
assert.equal(result.summary.matched, 3);
assert.equal(result.summary.newCardsWithoutDueDate, 1);
assert.equal(result.changes.length, 2);
assert.equal(result.changes[0].set.nextDueDate.toISOString(), '2026-10-08T02:00:00.000Z');
assert.equal(result.changes[1].set.nextDueDate.toISOString(), new Date(b.due * 1000).toISOString());
assert.equal(result.changes[1].set.scheduler.queue, 'MINUTE');
assert.equal(result.changes[1].set.scheduler.phase, 'LEARNING');
assert.equal(result.changes[1].set.scheduler.remainingSteps, 1);
assert.equal(result.changes[1].set.scheduler.interval, rows[1].scheduler.interval);
assert.equal(result.changes[0].set.lastReviewId, null, 'An old Undo must not restore the pre-sync schedule');
assert.ok(result.changes.every(c => !('failureIndex' in c.set) && !('anki' in c.set) && c.set.scheduleVersion === 4));
assert.deepEqual(structuredClone(rows), originals);
assert.ok(!('scheduler' in plan(source([b]), [rows[1]]).changes[0].set));
assert.throws(() => plan(source([a, a]), [rows[0]]), /Duplicate|duplicate/);
assert.throws(() => plan(source([a]), [rows[0], rows[0]]), /Duplicate database/);
assert.throws(() => plan(source([a]), [{ ...rows[0], card: { ...rows[0].card, sourceNoteGuid: 'wrong' } }]), /identity mismatch/);
assert.throws(() => plan(source([{ ...a, odid: 1 }]), [rows[0]]), /Unsupported/);
assert.throws(() => plan(source([{ ...a, queue: -1 }]), [rows[0]]), /Unsupported/);
assert.throws(() => plan(source([{ ...a, due: NaN }]), [rows[0]]), /Invalid source/);
const applied = result.changes.map(c => ({ ...c.before, ...c.set }));
assert.equal(plan(source([a, b]), applied, true).changes.length, 0, 'Rerun must not increment versions');
const guard = dueSyncGuard(rows[0]);
assert.deepEqual(guard.temporaryDueDate, { $exists: false });
assert.equal(guard.scheduleVersion, 3);
assert.ok(!('failureIndex' in guard), 'Additive concurrent failures are preserved by field patches');
// Calendar dates retain the 04:00 rollover through the October DST change.
const dst = card(103, 3, 2, 2, 900);
assert.equal(plan(source([dst]), [progress(dst)]).changes[0].set.nextDueDate.toISOString(), '2026-10-25T03:00:00.000Z');
console.log('PASS Anki due reconciliation: identities/directions, calendar/DST/minute queues, new-card positions, status opt-in, preserved counters, guards and idempotence');
