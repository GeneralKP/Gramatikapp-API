import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';
import { planLegacyStudyRestart } from './lib/legacyStudyRestart.js';
const now = new Date('2026-10-08T20:00:00Z');
const before: UserProgress = { _id: new ObjectId(), userId: new ObjectId(), itemId: new ObjectId(), itemType: 'WORD',
  card: { source: 'APP', sourceCardId: '1', sourceNoteGuid: 'legacy', direction: 'ES_DE', prompt: 'casa', answer: 'Haus', acceptedAnswers: ['Haus'], notes: '', examples: [], tags: [], deck: 'App' },
  interval: 1, repetitions: 1, ease: 2.36, lastReviewed: new Date('2026-02-27Z'), nextDueDate: new Date('2026-02-28Z'), createdAt: new Date('2026-02-19Z'),
  failureIndex: 1, failureAttemptIds: ['today-mistake'], lastFailedAt: now, scheduleVersion: 2 };
before.scheduler = initialScheduler(before, DEFAULT_OPTIONS);
const plan = planLegacyStudyRestart(before, [{ reversedAt: now }], now);
assert.equal(plan.update.$set.scheduler.phase, 'NEW');
assert.equal(plan.update.$set.scheduler.interval, 0);
assert.equal(plan.update.$set.scheduler.ease, DEFAULT_OPTIONS.initialEase);
assert.equal(plan.update.$set.totalReviews, 0);
assert.equal(plan.update.$set.scheduleVersion, 3);
assert.equal(plan.update.$set.lastReviewed, null);
assert.ok(!('failureIndex' in plan.update.$set));
assert.ok(!('failureAttemptIds' in plan.update.$set));
assert.ok(!('lastFailedAt' in plan.update.$set));
assert.ok(!('failureIndex' in plan.filter));
assert.equal(plan.filter.scheduleVersion, 2);
assert.equal(before.interval, 1, 'Planning never mutates original history');
assert.throws(() => planLegacyStudyRestart(before, [{ reversedAt: null }], now), /active modern/);
for (const patch of [{ totalReviews: 1 }, { card: { ...before.card!, source: 'ANKI' as const } }, { anki: { type: 2, queue: 2, left: 0, reps: 1, did: 1, due: 1 } }, { suspended: true }])
  assert.throws(() => planLegacyStudyRestart({ ...before, ...patch }, [], now), /Only an active APP legacy/);
console.log('PASS targeted legacy restart: verified/Anki history refused, NEW state, concurrency guard and retained mistakes/content');
