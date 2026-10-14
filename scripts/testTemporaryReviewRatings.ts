import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { DEFAULT_OPTIONS, initialScheduler, GRADES } from '../src/features/progress/scheduler.js';
import { studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import { syncStudy, type StudyOperation } from '../src/features/progress/studySync.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

// No dotenv fallback: synthetic identities must never reach a live database.
if (!process.env.MONGODB_URI?.startsWith('mongodb://127.0.0.1:27019/'))
  throw new Error('Use the isolated loopback replica set on port 27019.');
const db = await connectDatabase(), userId = new ObjectId();
const now = new Date('2026-10-12T10:00:00Z'), sessionId = randomUUID();
const command = (p: UserProgress, grade: typeof GRADES[number]): StudyOperation => ({
  id: randomUUID(), kind: 'REVIEW', itemId: String(p.itemId), itemType: p.itemType,
  grade, expectedVersion: 0, occurredAt: now.toISOString(), sessionId,
});
try {
  for (const itemType of ['WORD', 'PHRASE'] as const) {
    for (const regularDue of ['2026-10-31T03:00:00Z', '2026-10-12T02:00:00Z']) {
      for (const grade of GRADES) {
        const p: UserProgress = {
          _id: new ObjectId(), userId, itemId: new ObjectId(), itemType,
          isNew: false, failureIndex: 7, interval: 30, ease: 2.5, repetitions: 8,
          totalReviews: 10, lapses: 0, nextDueDate: new Date(regularDue),
          temporaryDueDate: new Date('2026-10-11T10:00:00Z'),
          lastReviewed: new Date('2026-10-01T10:00:00Z'), createdAt: new Date('2026-04-01T10:00:00Z'),
          card: { source: 'APP', sourceCardId: '1790000000000', sourceNoteGuid: randomUUID(),
            direction: 'ES_DE', prompt: 'fixture', answer: 'fixture', acceptedAnswers: ['fixture'],
            notes: '', examples: [], deck: 'Fixture', tags: [] },
        };
        p.scheduler = initialScheduler(p, { ...DEFAULT_OPTIONS, leechSuspend: false });
        const options = studyReviewOptions(p, now);
        assert.deepEqual(options.slice(0, 4).map(option => option.grade), GRADES);
        assert.equal(options.length, itemType === 'WORD' ? 6 : 4);
        const preview = options.find(option => option.grade === grade)!;
        await db.progress.insertOne(p);
        const job = command(p, grade);
        const response = await syncStudy(userId, [job]);
        assert.equal(response.results[0].success, true, JSON.stringify(response));
        const stored = await db.progress.findOne({ _id: p._id });
        assert.equal(stored.nextDueDate.toISOString(), preview.nextDueDate, `${itemType} ${grade}: persisted date matches visible choice`);
        assert.equal(stored.scheduler.phase, preview.phase);
        assert.equal(stored.temporaryDueDate, undefined);
        assert.equal(stored.lastReviewed.toISOString(), now.toISOString());
        assert.equal(stored.totalReviews, 11);
        assert.equal(stored.scheduleVersion, 1);
        assert.equal(stored.failureIndex, 7);
        assert.equal((await syncStudy(userId, [job])).results[0].success, true);
        assert.deepEqual(await db.progress.findOne({ _id: p._id }), stored, 'lost ACK retries do not reapply the grade');
        assert.equal(await db.reviewEvents.countDocuments({ userId, reviewId: job.id }), 1);
        const event = await db.reviewEvents.findOne({ userId, reviewId: job.id });
        assert.equal(event.grade, grade);
        assert.equal(event.reviewedAt.toISOString(), now.toISOString());
        const stale = await syncStudy(userId, [{ ...job, id: randomUUID() }]);
        assert.equal(stale.results[0].code, 'STALE_CARD');
        const undo = { ...job, id: randomUUID(), kind: 'UNDO' as const, reviewId: job.id };
        assert.equal((await syncStudy(userId, [undo])).results[0].success, true);
        const restored = await db.progress.findOne({ _id: p._id });
        for (const field of ['nextDueDate', 'temporaryDueDate', 'lastReviewed'] as const)
          assert.equal(restored[field].toISOString(), p[field]!.toISOString());
        assert.equal(restored.interval, p.interval);
        assert.equal(restored.totalReviews, p.totalReviews);
        assert.equal(restored.failureIndex, 7);
        assert.equal(restored.scheduleVersion, 2);
      }
    }
  }
  console.log('PASS 16 real temporary word/phrase reviews: four choices, exact persisted previews, original times, single receipts, lost ACK, stale versions and Undo');
} finally {
  await db.reviewEvents.deleteMany({ userId });
  await db.progress.deleteMany({ userId });
  await closeDatabase();
}
