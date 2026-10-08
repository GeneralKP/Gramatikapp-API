import { ObjectId, type ClientSession } from 'mongodb';
import { getDb, getDatabaseClient, type Database } from '../../lib/database.js';
import { withScheduler } from './reviews.js';
import { isRescheduleFollower, rescheduleStudyCard } from './studyScheduling.js';
import type { StudyOperation } from './studySync.js';
import type { CardEdit } from './cardEdits.types.js';

export class CardEditConflict extends Error {
  constructor(message: string, public code: string) { super(message); }
}
export async function readCardEdits(userId: ObjectId, itemType: 'WORD' | 'PHRASE' | undefined, relationIds: ObjectId[], db = getDb()): Promise<CardEdit[]> {
  if (!relationIds.length) return [];
  return db.cardEdits.find({ userId, ...(itemType ? { itemType } : {}), relationId: { $in: relationIds } }).toArray();
}

/** All changes and their retry receipt commit together; a lost response cannot apply a delta twice. */
export async function applyCardEdit(db: Database, userId: ObjectId, job: StudyOperation, session: ClientSession) {
  const edit = job.edit!;
  const itemId = new ObjectId(job.itemId), relationId = new ObjectId(edit.relationId);
  const payload = JSON.stringify({ itemId: job.itemId, itemType: job.itemType, edit, expectedVersion: job.expectedVersion });
  const previous = await db.cardEditEvents.findOne({ userId, commandId: job.id }, { session });
  if (previous) {
    if (previous.payload !== payload) throw new CardEditConflict('This edit identity was already used for different changes.', 'EDIT_ID_REUSED');
    return;
  }
  const type = job.itemType!;
  const relation = await (type === 'WORD' ? db.relationsWordsEsDe : db.relationsPhrasesEsDe).findOne({ _id: relationId }, { session });
  if (!relation) throw new CardEditConflict('The dictionary entry is no longer available. Your edit remains saved on this device.', 'EDIT_TARGET_UNAVAILABLE');
  const key = { userId, relationId, itemType: type };
  const storedEdit = await db.cardEdits.findOne(key, { session });
  const changesContent = edit.content !== undefined || edit.flag !== undefined;
  if (changesContent && (storedEdit?.version ?? 0) !== edit.expectedContentVersion) throw new CardEditConflict('This entry was edited on another device. Your device edit has been retained.', 'STALE_CONTENT');
  if (edit.failureDelta !== undefined || edit.nextDueDate !== undefined) {
    const stored = await db.progress.findOne({ userId, itemId, itemType: type }, { session });
    if (!stored || String(stored.relationId ?? stored.itemId) !== String(relationId) || stored.supersededByAnki) throw new CardEditConflict('The study card is no longer available. Your edit remains saved on this device.', 'EDIT_TARGET_UNAVAILABLE');
    if (edit.nextDueDate !== undefined && (stored.scheduleVersion ?? 0) !== job.expectedVersion) throw new CardEditConflict('This card was rescheduled on another device. Your due-date edit has been retained.', 'STALE_CARD');
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (edit.failureDelta !== undefined) {
      update.failureIndex = Math.max(0, (stored.failureIndex ?? 0) + edit.failureDelta);
      update.failureVersion = (stored.failureVersion ?? 0) + 1;
    }
    if (edit.nextDueDate !== undefined) {
      const profile = await db.schedulerProfiles.findOne({ _id: userId }, { session });
      const current = await withScheduler(stored, profile), due = new Date(edit.nextDueDate), now = new Date(job.occurredAt);
      Object.assign(update, rescheduleStudyCard(current, due, now));
      if (due > now && current.itemType === 'WORD' && current.scheduler.phase === 'NEW' && current.card?.direction === 'DE_ES') {
        const siblings = await db.progress.find({ userId, itemType: 'WORD', 'card.sourceNoteGuid': current.card.sourceNoteGuid, 'card.direction': 'ES_DE', supersededByAnki: { $ne: true } }, { session }).toArray();
        for (const sibling of siblings) if (isRescheduleFollower(current, await withScheduler(sibling, profile)) && (!sibling.buriedUntil || sibling.buriedUntil < due)) {
          await db.progress.updateOne({ _id: sibling._id, userId }, { $set: { buriedUntil: due } }, { session });
        }
      }
      update.scheduleVersion = (stored.scheduleVersion ?? 0) + 1;
      // A rating's Undo must never restore a schedule over a manual reschedule.
      update.lastReviewId = null;
    }
    await db.progress.updateOne({ _id: stored._id, userId }, { $set: update }, { session });
  }
  if (changesContent) {
    const next: CardEdit = { _id: storedEdit?._id ?? new ObjectId(), ...key, version: (storedEdit?.version ?? 0) + 1, flag: edit.flag === undefined ? storedEdit?.flag ?? null : edit.flag,
      ...(edit.content !== undefined ? { content: edit.content } : storedEdit?.content ? { content: storedEdit.content } : {}), updatedAt: new Date() };
    await db.cardEdits.replaceOne(key, next, { upsert: true, session });
  }
  await db.cardEditEvents.insertOne({ _id: new ObjectId(), userId, commandId: job.id, payload, appliedAt: new Date() }, { session });
}
export async function saveCardEdit(userId: ObjectId, job: StudyOperation) {
  const session = getDatabaseClient().startSession();
  try { await session.withTransaction(() => applyCardEdit(getDb(), userId, job, session)); }
  finally { await session.endSession(); }
}
