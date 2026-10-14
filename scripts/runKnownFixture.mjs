import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const name = `known_fixture_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const port = process.env.KNOWN_FIXTURE_PORT ?? '27935';
assert.ok(['27935', '27019'].includes(port));
const uri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
process.env.GRAMATIK_ISOLATED_FIXTURE = name;
process.env.MONGODB_URI = uri; process.env.NODE_ENV = 'test';
const original = MongoClient.prototype.db;
MongoClient.prototype.db = function(database, options) {
  assert.ok(database === undefined || database === 'gramatikapp' || database === name);
  return original.call(this, name, options);
};
const client = await new MongoClient(uri).connect();
try {
  const hello = await original.call(client, 'admin').command({ hello: 1 });
  assert.ok(['gramatik-rank-fixture-rs', 'temporaryReviews'].includes(hello.setName)); assert.ok(hello.isWritablePrimary);
  const target = process.argv[2] ?? 'testKnownWords.ts';
  assert.ok(['testKnownWords.ts', 'testReviews.ts'].includes(target));
  await import(pathToFileURL(resolve('scripts', target)).href);
} finally {
  await original.call(client, name).dropDatabase(); await client.close(); MongoClient.prototype.db = original;
}
