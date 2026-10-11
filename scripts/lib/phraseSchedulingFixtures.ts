import { ObjectId } from 'mongodb';
import { DEFAULT_OPTIONS, initialScheduler } from '../../src/features/progress/scheduler.js';
import type { UserProgress } from '../../src/features/progress/progress.types.js';

export const phraseStart = new Date('2026-04-10T10:00:00Z');

export function phraseCard(interval = 30): UserProgress {
  const itemId = new ObjectId();
  const progress: UserProgress = {
    _id: itemId, itemId, userId: new ObjectId(), itemType: 'PHRASE',
    interval, ease: 2.5, repetitions: interval ? 5 : 0, totalReviews: interval ? 12 : 0,
    lapses: 0, failureIndex: 0, scheduleVersion: 0, isNew: !interval,
    createdAt: phraseStart, lastReviewed: interval ? new Date(+phraseStart - interval * 86400000) : null,
    nextDueDate: phraseStart,
    card: { source: 'APP', sourceCardId: '1790000000123', sourceNoteGuid: `phrase-fixture-${itemId}`,
      direction: 'ES_DE', prompt: 'Aprendo una frase.', answer: 'Ich lerne einen Satz.',
      acceptedAnswers: ['Ich lerne einen Satz.'], notes: '', examples: [], deck: 'Phrase fixture', tags: [] },
  };
  progress.scheduler = initialScheduler(progress, DEFAULT_OPTIONS);
  return progress;
}
