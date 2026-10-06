import { ObjectId } from 'mongodb';
import { getDb } from '../../lib/database.js';
export const normalizeContext = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');
const requests = new WeakMap<object, Map<string, Promise<ObjectId[]>>>();
export async function categoryRelations(context?: string, itemType?: string, request?: object) {
  if (!context) return null;
  const selected = normalizeContext(context);
  if (!/^[a-z0-9_]{1,100}$/.test(selected)) throw new Error('Invalid study category');
  let cache = request && requests.get(request);
  if (request && !cache) requests.set(request, cache = new Map());
  const key = `${itemType ?? 'MIXED'}:${selected}`;
  let result = cache?.get(key);
  if (!result) {
    result = Promise.all(['WORD', 'PHRASE'].filter(kind => !itemType || itemType === kind).map(async kind => {
      const db = getDb();
      const es = kind === 'WORD' ? db.wordsES : db.phrasesES;
      const de = kind === 'WORD' ? db.wordsDE : db.phrasesDE;
      const relations = kind === 'WORD' ? db.relationsWordsEsDe : db.relationsPhrasesEsDe;
      const [main, translated] = await Promise.all([
        es.find({contexts: selected}).project({_id:1}).toArray(),
        de.find({contexts:selected}).project({_id:1}).toArray(),
      ]);
      return (await relations.find({ $or: [{main:{$in:main.map(x=>x._id)}},{translated:{$in:translated.map(x=>x._id)}}] }).project({_id:1}).toArray()).map(x=>x._id as ObjectId);
    })).then(groups => groups.flat());
    cache?.set(key, result);
  }
  return result;
}
export const categoryProgressFilter = (ids: ObjectId[] | null) => ids === null ? {} : { $and: [{ $or: [{relationId:{$in:ids}},{relationId:{$exists:false},itemId:{$in:ids}}] }] };
