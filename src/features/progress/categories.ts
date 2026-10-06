import { ObjectId } from 'mongodb';
import { getDb } from '../../lib/database.js';
export const normalizeContext = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');
export async function categoryRelations(context?: string, itemType?: string) {
  if (!context) return null;
  const db = getDb(), selected = normalizeContext(context);
  if (!/^[a-z0-9_]{1,100}$/.test(selected)) throw new Error('Invalid study category');
  const ids: ObjectId[] = [];
  for (const kind of ['WORD', 'PHRASE']) {
    if (itemType && itemType !== kind) continue;
    const es = kind === 'WORD' ? db.wordsES : db.phrasesES;
    const de = kind === 'WORD' ? db.wordsDE : db.phrasesDE;
    const relations = kind === 'WORD' ? db.relationsWordsEsDe : db.relationsPhrasesEsDe;
    const [main, translated] = await Promise.all([es.find({contexts: selected}).project({_id:1}).toArray(), de.find({contexts:selected}).project({_id:1}).toArray()]);
    ids.push(...(await relations.find({ $or: [{main:{$in:main.map(x=>x._id)}},{translated:{$in:translated.map(x=>x._id)}}] }).project({_id:1}).toArray()).map(x=>x._id));
  }
  return ids;
}
export const categoryProgressFilter = (ids: ObjectId[] | null) => ids === null ? {} : { $and: [{ $or: [{relationId:{$in:ids}},{relationId:{$exists:false},itemId:{$in:ids}}] }] };
