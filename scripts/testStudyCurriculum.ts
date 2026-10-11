import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { CEFR_LEVELS } from '../src/features/levels/levels.js';
import { curriculumIndex, planCurriculumIntroductions } from '../src/features/progress/studyCurriculum.js';
import { newCardGroups } from '../src/features/progress/newWordOrder.js';
import { selectStudyQueue } from '../src/features/progress/studyQueue.js';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';

for (const type of ['WORD', 'PHRASE'] as const) {
  const german: any[] = [], spanish: any[] = [], relations: any[] = [];
  for (const level of [...CEFR_LEVELS].reverse()) {
    const main = new ObjectId(), translated = new ObjectId();
    spanish.push({ _id: main, cefrLevel: 'C2.2' }); german.push({ _id: translated, cefrLevel: level });
    relations.push({ _id: new ObjectId(), main, translated });
  }
  for (const cefrLevel of [undefined, 'INVALID']) {
    const main = new ObjectId(), translated = new ObjectId();
    spanish.push({ _id: main }); german.push({ _id: translated, cefrLevel, level: 'A1' });
    relations.push({ _id: new ObjectId(), main, translated });
  }
  relations.unshift({ _id: new ObjectId(), main: spanish[0]._id, translated: new ObjectId() });
  relations.unshift({ _id: new ObjectId(), main: new ObjectId(), translated: german[0]._id });
  const index = curriculumIndex(type, relations, german, spanish);
  assert.deepEqual(index.entries.slice(0, 12).map(e => e.level), CEFR_LEVELS);
  assert.deepEqual(index.entries.slice(12).map(e => e.rank), [12, 12]);
  assert.equal(index.entries.length, 14, 'Both dangling endpoint variants are excluded before selection');
  assert.equal(curriculumIndex(type, relations, german, spanish), index, 'Warm catalog reuses sorted generation');
  const changed = german.map(row => ({ ...row, cefrLevel: row.cefrLevel === 'C2.2' ? 'A1.1' : row.cefrLevel }));
  assert.notEqual(curriculumIndex(type, relations, changed, spanish), index, 'A new catalog generation rebuilds ranking');
  console.log(`PASS ${type} curriculum unit: twelve reversed levels, German rank, unknown last, dangling endpoints, cached generation and invalidation`);
}
const now = new Date(), userId = new ObjectId();
const make = (level: number, direction: string) => {
  const p: any = { _id: new ObjectId(), userId, itemId: new ObjectId(), itemType: 'WORD', isNew: true,
    ease: 2.5, interval: 0, repetitions: 0, nextDueDate: now, lastReviewed: null, createdAt: now,
    rank: level, anki: { due: 12 - level, type: 0, queue: 0, reps: 0, left: 0, did: 1 }, card: { direction, sourceNoteGuid: `level-${level}`, deck: 'App' } };
  p.scheduler = initialScheduler(p, { ...DEFAULT_OPTIONS, newPerDay: 1000, reviewsPerDay: 100000 }); return p;
};
const pending = [...Array(12)].flatMap((_, i) => [make(i, 'ES_DE'), make(i, 'DE_ES')]).reverse();
const compare = (a: any, b: any) => a.rank - b.rank;
assert.deepEqual(newCardGroups(pending, pending, compare).map(group => group[0].rank), Array.from({ length: 12 }, (_, i) => i));
const sorted = selectStudyQueue(pending, new Map(), now, 0, 24, false, compare);
assert.deepEqual(sorted.map(p => p.card.direction), Array.from({ length: 12 }, () => ['DE_ES', 'ES_DE']).flat());
assert.deepEqual(sorted.map((p: any) => p.rank), Array.from({ length: 12 }, (_, i) => [i, i]).flat());
assert.deepEqual(selectStudyQueue(pending, new Map(), now, 0, 1, true, compare).map(p => p.card.direction), ['DE_ES']);
console.log('PASS new-group/final-queue unit: CEFR beats conflicting Anki positions; all twelve recognition pairs; one-card quota');
const unseen: any[] = [0, 1].map(rank => ({ type: 'WORD', rank, relation: { _id: new ObjectId() } }));
const late = newCardGroups(pending, pending.filter((p: any) => p.rank === 11), compare);
const rankOf = (p: any) => p.rank;
const earlyPlan = planCurriculumIntroductions(late, unseen, 2, false, rankOf);
assert.deepEqual(earlyPlan.entries, unseen.slice(0, 1)); assert.deepEqual(earlyPlan.pending, []);
const equalRank = planCurriculumIntroductions(late, [{ ...unseen[0], rank: 11 }], 2, false, rankOf);
assert.deepEqual(equalRank.pending, late[0]); assert.deepEqual(equalRank.entries, []);
const oddPlan = planCurriculumIntroductions(late, [], 1, true, rankOf);
assert.deepEqual(oddPlan.pending, late[0], 'Planner retains complete pair so final selection can check recognition prerequisites');
assert.deepEqual(selectStudyQueue(oddPlan.pending, new Map(), now, 0, 1, true, compare).map(p => p.card.direction), ['DE_ES']);
const bare = { ...late[0][1], card: undefined };
assert.equal(planCurriculumIntroductions([[bare]], [], 1, false, rankOf).pending.length, 0, 'Bare words consume two introduction slots');
assert.equal(planCurriculumIntroductions([[bare]], [], 1, true, rankOf).pending.length, 1);
const filled = planCurriculumIntroductions(late, unseen, 5, true, rankOf);
assert.equal(filled.entries.length, 2); assert.equal(filled.pending.length, 2, 'A final single allowance retains the pending pair for recognition-only selection');
console.log('PASS shared planner: earlier unseen, pending ties, native/bare pair costs and odd prerequisite retention');
