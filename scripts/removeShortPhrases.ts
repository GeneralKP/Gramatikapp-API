import 'dotenv/config';
import { BSON, MongoClient, type ClientSession, type Document } from 'mongodb';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Audit by default. --apply removes short bilingual pairs and their live references.
const apply = process.argv.includes('--apply');
const uri = process.env.MONGODB_URI || (process.env.DB_USER && process.env.DB_USER_PASSWORD && process.env.DB_CLUSTER
  ? `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_USER_PASSWORD)}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`
  : 'mongodb://localhost:27017');
const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 }).connect();
const db = client.db('gramatikapp');
const wordCount = (phrase: string) => phrase.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
const isShort = (phrase: Document) => { const count = wordCount(phrase.phrase); return count >= 1 && count <= 3; };
const key = (value: unknown) => String(value);

async function plan(session?: ClientSession) {
  const options = session ? { session } : {};
  // MongoDB transactions require sequential operations on their session.
  const es = await db.collection('PHRASES_ES').find({}, options).toArray();
  const de = await db.collection('PHRASES_DE').find({}, options).toArray();
  const relations = await db.collection('PHRASES_ES_DE').find({}, options).toArray();
  const shortES = es.filter(isShort), shortDE = de.filter(isShort);
  const shortESIds = new Set(shortES.map(p => key(p._id))), shortDEIds = new Set(shortDE.map(p => key(p._id)));
  const removedRelations = relations.filter(r => shortESIds.has(key(r.main)) || shortDEIds.has(key(r.translated)));
  const removedIds = new Set(removedRelations.map(r => key(r._id)));
  const keptRelations = relations.filter(r => !removedIds.has(key(r._id)));
  const referencedES = new Set(keptRelations.map(r => key(r.main))), referencedDE = new Set(keptRelations.map(r => key(r.translated)));
  const affectedES = new Set(removedRelations.map(r => key(r.main))), affectedDE = new Set(removedRelations.map(r => key(r.translated)));
  const removedES = es.filter(p => shortESIds.has(key(p._id)) || affectedES.has(key(p._id)) && !referencedES.has(key(p._id)));
  const removedDE = de.filter(p => shortDEIds.has(key(p._id)) || affectedDE.has(key(p._id)) && !referencedDE.has(key(p._id)));
  const relationIds = removedRelations.map(r => r._id), phraseIds = [...removedES, ...removedDE].map(p => p._id);
  const progressFilter = { itemType: 'PHRASE', $or: [{ relationId: { $in: relationIds } }, { itemId: { $in: [...relationIds, ...phraseIds] } }] };
  const progress = await db.collection('userprogresses').find(progressFilter, options).toArray();
  const reviewFilter = { itemType: 'PHRASE', itemId: { $in: [...relationIds, ...phraseIds, ...progress.map(p => p.itemId)] } };
  const reviews = await db.collection('reviewevents').find(reviewFilter, options).toArray();
  const translations = await db.collection('TRANSLATIONS_ES_DE').find({ 'phraseRefs.phraseId': { $in: phraseIds } }, options).toArray();
  return { removedES, removedDE, removedRelations, progress, reviews, translations, phraseIds };
}

function summary(p: Awaited<ReturnType<typeof plan>>) {
  return { spanishPhrases: p.removedES.length, germanPhrases: p.removedDE.length, pairs: p.removedRelations.length,
    studyCards: p.progress.length, reviews: p.reviews.length, translationReferencesUpdated: p.translations.length };
}

try {
  if (!apply) {
    const p = await plan();
    console.log(JSON.stringify({ mode: 'audit', ...summary(p), phrases: p.removedRelations.map(r => ({
      german: p.removedDE.find(p => key(p._id) === key(r.translated))?.phrase,
      spanish: p.removedES.find(p => key(p._id) === key(r.main))?.phrase,
    })) }, null, 2));
  } else {
    const directory = resolve('.local/audit');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const session = client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const p = await plan(session);
        if (!p.phraseIds.length) return { ...summary(p), backup: null };
        const backup = resolve(directory, `short-phrases-before-${Date.now()}.ejson`);
        await writeFile(backup, BSON.EJSON.stringify({ database: db.databaseName, auditedAt: new Date(), ...p }, null, 2), { mode: 0o600, flag: 'wx' });
        for (const [name, docs] of [
          ['reviewevents', p.reviews], ['userprogresses', p.progress], ['PHRASES_ES_DE', p.removedRelations],
          ['PHRASES_ES', p.removedES], ['PHRASES_DE', p.removedDE],
        ] as const) {
          if (!docs.length) continue;
          const deleted = await db.collection(name).deleteMany({ _id: { $in: docs.map(d => d._id) } }, { session });
          if (deleted.deletedCount !== docs.length) throw new Error(`Unexpected deletion count for ${name}; aborting.`);
        }
        // Surface translations are shared vocabulary; remove only deleted phrase provenance.
        await db.collection('TRANSLATIONS_ES_DE').updateMany({ 'phraseRefs.phraseId': { $in: p.phraseIds } },
          { $pull: { phraseRefs: { phraseId: { $in: p.phraseIds } } } } as Document, { session });
        const remaining = await plan(session);
        if (remaining.phraseIds.length) throw new Error('Short phrases remain; aborting.');
        if (await db.collection('TRANSLATIONS_ES_DE').countDocuments({ 'phraseRefs.phraseId': { $in: p.phraseIds } }, { session })) throw new Error('Deleted phrase references remain; aborting.');
        return { ...summary(p), backup };
      });
      console.log(JSON.stringify({ mode: 'applied', ...result }, null, 2));
    } finally { await session.endSession(); }
  }
} finally { await client.close(); }
