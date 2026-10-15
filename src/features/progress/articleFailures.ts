import type { ObjectId } from 'mongodb';
import type { Database } from '../../lib/database.js';
import { GrammaticalCategory } from '../words/words.types.js';

/** Article difficulty is independent of word recall and all scheduler snapshots. */
export async function recordArticleFailure(
  db: Pick<Database, 'progress' | 'relationsWordsEsDe' | 'wordsDE'>,
  userId: ObjectId, itemId: ObjectId, attemptId: string, occurredAt = new Date(),
) {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(attemptId)) throw new Error('Invalid article attempt ID');
  const current = await db.progress.findOne({ userId, itemId, itemType: 'WORD', supersededByAnki: { $ne: true } });
  if (!current) throw new Error('Study noun not found');
  // A lost acknowledgement remains a success even if the catalog changed later.
  if (current.articleFailureAttemptIds?.includes(attemptId)) return;
  const relation = await db.relationsWordsEsDe.findOne({ _id: current.relationId ?? current.itemId }, { projection: { translated: 1 } });
  const noun = relation && await db.wordsDE.findOne({ _id: relation.translated }, { projection: { gramaticalCategories: 1, 'forms.gender': 1 } });
  if (!noun?.gramaticalCategories?.includes(GrammaticalCategory.NOUN) || !noun.forms?.gender?.trim()) {
    throw new Error('Article difficulty is available only for nouns with a stored article. Reload this card.');
  }
  // Increment and retry identity commit atomically, including concurrent devices.
  // No scheduling version, general failure, reinforcement or review field changes.
  await db.progress.updateOne(
    { _id: current._id, userId, articleFailureAttemptIds: { $ne: attemptId } },
    { $inc: { articleFailureIndex: 1 }, $addToSet: { articleFailureAttemptIds: attemptId },
      $max: { lastArticleFailedAt: occurredAt }, $set: { updatedAt: new Date() } },
  );
}
