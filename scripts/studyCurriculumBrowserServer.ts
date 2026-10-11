import 'dotenv/config';
import assert from 'node:assert/strict';
import { BSON, MongoClient } from 'mongodb';
import { readFile } from 'node:fs/promises';
import { connectDatabase, getDatabaseClient } from '../src/lib/database.js';
import { CEFR_LEVELS } from '../src/features/levels/levels.js';
import { defaultUserSettings } from '../src/features/auth/auth.types.js';
assert.match(process.env.MONGODB_URI ?? '', /^mongodb:\/\/127\.0\.0\.1:27019\//);
assert.equal(process.env.STUDY_CURRICULUM_BROWSER_DB, 'study_curriculum_browser_fixture');
const original = MongoClient.prototype.db;
MongoClient.prototype.db = function () { return original.call(this, process.env.STUDY_CURRICULUM_BROWSER_DB); };
const db = await connectDatabase(), raw = original.call(getDatabaseClient(), process.env.STUDY_CURRICULUM_BROWSER_DB);
const source = BSON.deserialize(await readFile('.local/study-level-audit/source.bson')) as any;
// A twelve-checkpoint subset of the real catalog exercises both clients' order
// using the designated owner's identity in this disposable database only.
for (const type of ['WORD', 'PHRASE'] as const) {
  const deName = type === 'WORD' ? 'WORDS_DE' : 'PHRASES_DE', esName = type === 'WORD' ? 'WORDS_ES' : 'PHRASES_ES', relName = type === 'WORD' ? 'WORDS_ES_DE' : 'PHRASES_ES_DE';
  const de = new Map(source.collections[deName].map((r: any) => [String(r._id), r]));
  const selected = CEFR_LEVELS.map(level => source.collections[relName].find((r: any) => (de.get(String(r.translated)) as any)?.cefrLevel === level));
  assert.ok(selected.every(Boolean));
  await raw.collection(relName).insertMany(selected);
  await raw.collection(deName).insertMany(source.collections[deName].filter((r: any) => selected.some((rel: any) => rel.translated.equals(r._id))));
  await raw.collection(esName).insertMany(source.collections[esName].filter((r: any) => selected.some((rel: any) => rel.main.equals(r._id))));
}
await db.users.insertOne({ ...source.user, email: 'curriculum-browser@example.invalid', authProvider: 'email', settings: { ...defaultUserSettings, soundEnabled: false, dailyNewCards: 1000 } });
await import('../src/index.js');
