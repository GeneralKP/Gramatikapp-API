import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createRequire } from 'node:module';
import { DEFAULT_OPTIONS, dateForStudyDay, initialScheduler, schedulerSeed, studyDay } from '../../src/features/progress/scheduler.js';
import { effectiveDueDate, scheduleStudyReview, studyReviewOptions, type StudyGrade } from '../../src/features/progress/studyScheduling.js';
import { reviewDelayLabels } from '../../src/features/progress/reviewPresentation.js';
import { scheduleStudyReview as browserSchedule, studyReviewOptions as browserOptions, type UserProgress as ClientProgress } from '../../../german-gramatic-web/src/core/generated/studyScheduler.js';
import type { UserProgress } from '../../src/features/progress/progress.types.js';
const { scheduleStudyReview: nativeSchedule, studyReviewOptions: nativeOptions } = createRequire(import.meta.url)('../../../german-gramatic-mobile/src/core/study/scheduler.ts') as typeof import('../../../german-gramatic-mobile/src/core/study/scheduler.js');

export type SimulationProfile = 'successful' | 'mixed' | 'hard';
export interface SimulatedReview { before: UserProgress; after: UserProgress; now: Date; grade: StudyGrade; preview: ReturnType<typeof studyReviewOptions>[number]; }
const start = new Date('2026-04-10T10:00:00Z'), end = new Date('2026-10-10T10:00:00Z');
export function simulationCards(userId: ObjectId, count = 1830): UserProgress[] {
  return Array.from({ length: count + 10 }, (_, index) => {
    const id = new ObjectId((index + 100).toString(16).padStart(24, '0'));
    const progress: UserProgress = {
      _id: id, itemId: id, userId, itemType: index < count ? 'WORD' : 'PHRASE',
      isNew: true, interval: 0, ease: 2.5, repetitions: 0, totalReviews: 0, lapses: 0,
      failureIndex: 0, scheduleVersion: 0, createdAt: start, lastReviewed: null, nextDueDate: start,
      card: { source: 'APP', sourceCardId: String(1790000000000 + index), sourceNoteGuid: `interval-fixture-${index}`,
        direction: 'ES_DE', prompt: index < count ? `palabra ${index}` : `frase ${index}`,
        answer: index < count ? `Wort ${index}` : `Ich lerne Satz ${index}.`, acceptedAnswers: [index < count ? `Wort ${index}` : `Ich lerne Satz ${index}.`],
        notes: '', examples: [], deck: 'Interval fixture', tags: [] },
    };
    progress.scheduler = initialScheduler(progress, { ...DEFAULT_OPTIONS, newPerDay: 10 });
    return progress;
  });
}
export async function simulateStudy(profile: SimulationProfile, onReview?: (event: SimulatedReview) => Promise<void>, cards = simulationCards(new ObjectId('000000000000000000000099')), limits = { WORD: 10, PHRASE: 3 }) {
  const firstDay = studyDay(start, 'Europe/Berlin', 4), finalDay = studyDay(end, 'Europe/Berlin', 4);
  const stats = { profile, days: finalDay - firstDay, sessions: 0, missedDays: 0, wordReviews: 0, phraseReviews: 0, previews: 0,
    allEqualOrdinaryRatings: 0, genuineTies: 0, hiddenDistinctLabels: 0, maxWordInterval: 0, goodTrace: [] as number[] };
  for (let day = 0; day < stats.days; day++) {
    if (profile === 'mixed' && day % 19 === 18) { stats.missedDays++; continue; }
    const sessionStart = new Date(+dateForStudyDay(firstDay + day, 'Europe/Berlin', 4) + 8 * 3600000);
    const due = cards.filter(p => p.scheduler.phase === 'NEW' || effectiveDueDate(p) <= sessionStart)
      .sort((a, b) => Number(a.scheduler.phase === 'NEW') - Number(b.scheduler.phase === 'NEW') || +effectiveDueDate(a) - +effectiveDueDate(b));
    const selected = [...due.filter(p => p.itemType === 'WORD').slice(0, limits.WORD), ...due.filter(p => p.itemType === 'PHRASE').slice(0, limits.PHRASE)];
    for (const type of ['WORD', 'PHRASE'] as const) if (cards.filter(p => p.itemType === type).length >= stats.days * limits[type]) {
      assert.equal(selected.filter(p => p.itemType === type).length, limits[type], `${limits[type]} distinct ${type} cards per active day`);
    }
    if (!selected.length) continue;
    stats.sessions++;
    const pending = new Set(selected.map(p => p.itemId.toString()));
    let clock = sessionStart;
    for (let attempt = 0; pending.size && attempt < 100; attempt++) {
      const p = selected.filter(p => pending.has(String(p.itemId))).sort((a, b) => +effectiveDueDate(a) - +effectiveDueDate(b))[0];
      if (p.scheduler.phase !== 'NEW') clock = new Date(Math.max(+clock, +effectiveDueDate(p)));
      if (+clock > +sessionStart + 2 * 3600000) break;
      const options = studyReviewOptions(p, clock), ordinary = options.filter(o => o.grade !== 'REVISIT');
      assert.ok(ordinary.every((o, i) => !i || o.delaySeconds >= ordinary[i - 1].delaySeconds), `${profile} day ${day}: descending ratings`);
      const labels = reviewDelayLabels(ordinary);
      for (let i = 1; i < ordinary.length; i++) {
        if (ordinary[i].delaySeconds === ordinary[i - 1].delaySeconds) stats.genuineTies++;
        if (ordinary[i].delaySeconds !== ordinary[i - 1].delaySeconds && labels[ordinary[i].grade] === labels[ordinary[i - 1].grade]) stats.hiddenDistinctLabels++;
      }
      if (ordinary.length > 1 && new Set(ordinary.map(o => o.delaySeconds)).size === 1) stats.allEqualOrdinaryRatings++;
      const client = { ...p, fuzzSeed: schedulerSeed(p).toString() } as unknown as ClientProgress;
      assert.deepEqual(browserOptions(client, clock), options, 'Web/API previews');
      assert.deepEqual(nativeOptions(client, clock), options, 'Native/API previews');
      const roll = (Number.parseInt(String(p.itemId).slice(-4), 16) * 7 + day * 13 + (p.totalReviews ?? 0) * 3) % 100;
      let grade: StudyGrade = profile === 'successful' ? 'GOOD'
        : p.scheduler.phase !== 'REVIEW' ? (attempt < selected.length && roll < 15 ? 'AGAIN' : 'GOOD')
        : profile === 'hard' ? (roll < 5 ? 'AGAIN' : 'HARD') : roll < 10 ? 'AGAIN' : roll < 30 ? 'HARD' : roll < 85 ? 'GOOD' : 'EASY';
      if (options.length === 1) grade = 'GOOD';
      const before = structuredClone(p);
      // structuredClone preserves dates; restore Mongo IDs for database callbacks.
      Object.assign(before, { _id: p._id, itemId: p.itemId, userId: p.userId });
      const preview = options.find(o => o.grade === grade)!;
      const next = scheduleStudyReview(p, grade, clock);
      if (p.itemType === 'WORD' && p.scheduler.phase === 'REVIEW' && grade !== 'AGAIN' && grade !== 'REVISIT') {
        assert.ok(next.interval > p.interval, 'Successful on-time/overdue word ratings grow the interval under default options');
      }
      assert.equal(effectiveDueDate({ ...p, ...next }).toISOString(), preview.nextDueDate);
      for (const schedule of [browserSchedule, nativeSchedule]) {
        const local = schedule(client, grade, clock);
        assert.equal(local.nextDueDate.toISOString(), next.nextDueDate.toISOString());
        assert.deepEqual(local.scheduler, next.scheduler);
      }
      const after = { ...p, ...next, scheduleVersion: (p.scheduleVersion ?? 0) + 1 };
      await onReview?.({ before, after, now: clock, grade, preview });
      Object.assign(p, after);
      stats.previews += options.length;
      if (p.itemType === 'WORD') { stats.wordReviews++; stats.maxWordInterval = Math.max(stats.maxWordInterval, p.interval); }
      else stats.phraseReviews++;
      if (p === cards[0] && p.scheduler.phase === 'REVIEW' && grade === 'GOOD') stats.goodTrace.push(p.interval);
      if (p.scheduler.queue === 'DAY' || effectiveDueDate(p) > new Date(+sessionStart + 2 * 3600000)) pending.delete(String(p.itemId));
    }
  }
  assert.equal(stats.allEqualOrdinaryRatings, 0);
  assert.equal(stats.hiddenDistinctLabels, 0);
  return { stats, cards };
}
