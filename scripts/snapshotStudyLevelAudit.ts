import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { BSON, MongoClient } from 'mongodb';
import { parse } from 'dotenv';
import { wordCardSnapshotConnection } from './snapshotWordCardAudit.js';
import { CEFR_LEVELS } from '../src/features/levels/levels.js';

// Raw reads only: never call application connectDatabase (it creates indexes).
// Credentials are private inputs and are excluded from both snapshot and output.
const privateValues = parse(readFileSync('/Users/kevin/Desktop/key.env'));
assert.equal(privateValues.test_user_email, 'kevin.tester@gmail.com');
const connection = wordCardSnapshotConnection(process.env);
const client = new MongoClient(connection.uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 60000 });
try {
  await client.connect();
  console.log('Read-only snapshot connected.');
  const db = client.db(connection.database), session = client.startSession({ snapshot: true });
  try {
    const user = await db.collection('users').findOne({ email: privateValues.test_user_email }, { session, maxTimeMS: 30000, projection: { _id: 1, settings: 1, createdAt: 1 } });
    assert.ok(user, 'The designated existing test account must exist');
    const collections: Record<string, unknown[]> = {};
    for (const name of ['WORDS_DE', 'WORDS_ES', 'WORDS_ES_DE', 'PHRASES_DE', 'PHRASES_ES', 'PHRASES_ES_DE']) {
      collections[name] = await db.collection(name).find({}, { session, maxTimeMS: 30000 }).sort({ _id: 1 }).batchSize(1000).toArray();
      console.log(JSON.stringify({ stage: 'catalog-captured', collection: name, rows: collections[name].length }));
    }
    for (const name of ['userprogresses', 'reviewevents', 'cardedits']) collections[name] = await db.collection(name).find({ userId: user._id }, { session }).sort({ _id: 1 }).toArray();
    collections.schedulerprofiles = await db.collection('schedulerprofiles').find({ _id: user._id }, { session }).toArray();
    const snapshot = { auditedAt: new Date().toISOString(), user, collections };
    await mkdir('.local/study-level-audit', { recursive: true, mode: 0o700 });
    await writeFile('.local/study-level-audit/source.bson', BSON.serialize(snapshot), { mode: 0o600 });
    const levels = Object.fromEntries(['WORDS_DE', 'PHRASES_DE'].map(name => [name, Object.fromEntries([...CEFR_LEVELS, 'UNCLASSIFIED'].map(level => [level, collections[name].filter((row: any) => level === 'UNCLASSIFIED' ? !CEFR_LEVELS.includes(row.cefrLevel) : row.cefrLevel === level).length]))]));
    console.log(JSON.stringify({ auditedAt: snapshot.auditedAt, counts: Object.fromEntries(Object.entries(collections).map(([name, rows]) => [name, rows.length])), germanLevels: levels }));
  } finally { await session.endSession(); }
} catch {
  console.error('Study level snapshot failed; private connection details suppressed.');
  process.exitCode = 1;
} finally { await client.close(); }
