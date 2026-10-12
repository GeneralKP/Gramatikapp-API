import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { schedulerSeed } from '../src/features/progress/scheduler.js';
import { effectiveDueDate, scheduleStudyReview, studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

const path = new URL('../../german-gramatic-web/scripts/fixtures/study-previews.json', import.meta.url);
const fixtures = JSON.parse(await readFile(path, 'utf8'));
for (const fixture of fixtures) {
  const original = JSON.stringify({ options: fixture.options, outcomes: fixture.outcomes });
  const raw = JSON.parse(fixture.item.info.studyState);
  const progress = { ...raw, itemId: new ObjectId(raw.itemId) } as UserProgress;
  for (const field of ['nextDueDate', 'temporaryDueDate', 'lastReviewed', 'createdAt'] as const) if (raw[field]) progress[field] = new Date(raw[field]);
  assert.equal(schedulerSeed(progress).toString(), raw.fuzzSeed, 'Server seed must match the supplied client seed');
  const now = new Date(fixture.now), early = fixture.item.info.extraPractice ?? false;
  fixture.options = studyReviewOptions(progress, now, early);
  fixture.outcomes = Object.fromEntries(fixture.options.map((option: { grade: Parameters<typeof scheduleStudyReview>[1] }) => {
    const next = scheduleStudyReview(progress, option.grade, now, early);
    const options = progress.scheduler.options, threshold = options.leechThreshold;
    const leech = next.lapses > (progress.lapses ?? 0) && threshold > 0 && next.lapses >= threshold
      && (next.lapses - threshold) % Math.max(1, Math.ceil(threshold / 2)) === 0 && options.leechSuspend;
    return [option.grade, { ease: next.ease, interval: next.interval, repetitions: next.repetitions,
      nextDueDate: effectiveDueDate({ ...progress, ...next }).toISOString(), scheduleVersion: (fixture.item.info.scheduleVersion ?? 0) + 1,
      schedulerPhase: next.scheduler.phase, learningQueue: next.scheduler.queue, suspended: !!progress.suspended || leech }];
  }));
  const correctedReminder = !!progress.temporaryDueDate && progress.nextDueDate > now;
  if (progress.itemType === 'WORD' && !correctedReminder)
    assert.equal(JSON.stringify({ options: fixture.options, outcomes: fixture.outcomes }), original, 'Ordinary word golden outcomes must stay unchanged');
  if (correctedReminder)
    assert.deepEqual(fixture.options.slice(0, 4).map((option: { grade: string }) => option.grade), ['AGAIN', 'HARD', 'GOOD', 'EASY']);
}
await writeFile(path, JSON.stringify(fixtures, null, 2) + '\n');
console.log(`Generated ${fixtures.length} authoritative API preview fixtures; ordinary word outcomes unchanged, temporary reminders retain all grades`);
