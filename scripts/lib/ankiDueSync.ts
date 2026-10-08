import { isDeepStrictEqual } from 'node:util';
import type { Document } from 'mongodb';
import { collectionConfig, dueDate } from './anki.js';

export interface DueSyncChange { before: Document; set: Document; sourceCardId: string }

/** Identity-only reconciliation. Source notes/templates are never evaluated. */
export function planAnkiDueSync(source: Document, progress: Document[], timeZone: string, rollover: number, alignStatus: boolean, now: Date) {
  const tables = source.tables, config = { ...collectionConfig(tables.config), rollover };
  if (!tables.col?.[0]) throw new Error('Missing Anki collection');
  const cards = new Map<string, Document>(), notes = new Map<number, Document>();
  for (const note of tables.notes) {
    if (notes.has(note.id)) throw new Error('Duplicate source note');
    notes.set(note.id, note);
  }
  for (const card of tables.cards) {
    if (!Number.isSafeInteger(card.id) || cards.has(String(card.id))) throw new Error('Invalid/duplicate source card');
    cards.set(String(card.id), card);
  }
  const seen = new Set<string>(), changes: DueSyncChange[] = [];
  let matched = 0, newCards = 0, scheduled = 0, equalDates = 0, statusChanges = 0;
  for (const p of progress) {
    if (p.card?.source !== 'ANKI') continue;
    const card = cards.get(p.card.sourceCardId);
    if (!card) continue;
    if (seen.has(p.card.sourceCardId)) throw new Error('Duplicate database source card');
    seen.add(p.card.sourceCardId);
    if (notes.get(card.nid)?.guid !== p.card.sourceNoteGuid || p.anki?.ord !== card.ord)
      throw new Error(`Source identity mismatch: ${card.id}`);
    matched++;
    // New-card due values are positions, not timestamps. Do not invent a date.
    if (card.type === 0 && card.queue === 0) { newCards++; continue; }
    if (![1, 2, 3].includes(card.type) || ![1, 2, 3].includes(card.queue) || card.odid)
      throw new Error('Unsupported suspended/buried/filtered scheduling; inspect before reconciliation');
    if (!Number.isSafeInteger(card.due) || card.due < 0 || (card.queue === 1 && card.due < 1_000_000_000))
      throw new Error('Invalid source due value');
    if (!p.scheduler || p.scheduler.timeZone !== timeZone || p.scheduler.rollover !== rollover)
      throw new Error('Missing/incompatible live scheduler profile');
    const due = dueDate(card, tables.col[0], config, timeZone, now);
    if (!Number.isFinite(+due)) throw new Error('Invalid converted due date');
    scheduled++;
    const set: Document = {};
    if (+p.nextDueDate !== +due) set.nextDueDate = due; else equalDates++;
    if (p.temporaryDueDate) set.temporaryDueDate = null;
    if (p.buriedUntil) set.buriedUntil = null;
    if (alignStatus) {
      const phase = ['', 'LEARNING', 'REVIEW', 'RELEARNING'][card.type];
      const queue = card.queue === 1 ? 'MINUTE' : 'DAY';
      const remainingSteps = phase === 'REVIEW' ? 0 : card.left % 1000;
      const steps = phase === 'RELEARNING' ? p.scheduler.options.relearningSteps : p.scheduler.options.learningSteps;
      const scheduledSeconds = phase === 'REVIEW' || !steps.length ? 0 : Math.trunc((steps[Math.min(Math.max(0, steps.length - remainingSteps), steps.length - 1)] || 0) * 60);
      // Review cards do not consume learning steps; retain those inert legacy
      // fields when already in REVIEW rather than rewriting every reviewed card.
      const stepsState = phase === 'REVIEW' && p.scheduler.phase === 'REVIEW' ? {} : { remainingSteps, scheduledSeconds };
      const scheduler = { ...p.scheduler, phase, queue, ...stepsState };
      if (!isDeepStrictEqual(scheduler, p.scheduler)) { set.scheduler = scheduler; statusChanges++; }
      if (p.isNew !== false) set.isNew = false;
    }
    if (Object.keys(set).length) {
      if (!Number.isSafeInteger(p.scheduleVersion ?? 0) || (p.scheduleVersion ?? 0) < 0) throw new Error('Invalid schedule version');
      set.scheduleVersion = (p.scheduleVersion ?? 0) + 1;
      set.updatedAt = now;
      // Keep review receipts, but invalidate Undo's pointer to the old schedule.
      if (p.lastReviewId) set.lastReviewId = null;
      changes.push({ before: p, set, sourceCardId: String(card.id) });
    }
  }
  return { changes, summary: { sourceCards: cards.size, matched, unmatchedSource: cards.size - matched,
    newCardsWithoutDueDate: newCards, scheduled, equalDates, dateChanges: scheduled - equalDates,
    statusChanges, changedCards: changes.length, alignStatus, timeZone, rollover } };
}

/** A concurrent review/edit must abort the transaction, never silently lose. */
export function dueSyncGuard(before: Document): Document {
  return Object.fromEntries(['_id', 'userId', 'card', 'anki', 'scheduler', 'scheduleVersion', 'nextDueDate',
    'temporaryDueDate', 'buriedUntil', 'lastReviewed', 'lastReviewId', 'updatedAt', 'totalReviews',
    'ease', 'interval', 'repetitions', 'lapses', 'isNew', 'suspended', 'supersededByAnki']
    .map(key => [key, before[key] === undefined ? { $exists: false } : before[key]]));
}
