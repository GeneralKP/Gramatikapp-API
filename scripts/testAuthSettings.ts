import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { closeDatabase, connectDatabase } from "../src/lib/database.js";
import { typeDefs } from "../src/graphql/schema.js";
import { authResolvers } from "../src/features/auth/auth.resolvers.js";
import { defaultUserSettings } from "../src/features/auth/auth.types.js";

// A truthy daily-limit fallback, validation before the account read, a missing
// ownership check, lost settings or an omitted reread must fail this suite.
const owner = new ObjectId("000000000000000000000001");
const other = new ObjectId("000000000000000000000002");
const createdAt = new Date("2026-10-15T12:00:00Z");
const originalUser = { _id: owner, email: "settings@example.invalid", authProvider: "email", createdAt, settings: { ...defaultUserSettings, selectSound: false } };
let stored: typeof originalUser | null = structuredClone(originalUser);
let profileLimit: number | undefined = 37;
let discardAfterUpdate = false;
let updateError: Error | undefined;
const reads: { collection: string; method: string; query: unknown; update?: unknown }[] = [];
const collection = (name: string) => ({
  async createIndex() {}, async dropIndex() {},
  async findOne(query: { _id: ObjectId }) {
    reads.push({ collection: name, method: "findOne", query });
    if (name === "schedulerprofiles") return profileLimit === undefined ? null : { _id: owner, defaultOptions: { newPerDay: profileLimit } };
    return stored ? { ...stored, settings: { ...stored.settings } } : null;
  },
  async updateOne(query: { _id: ObjectId }, update: { $set: { settings: typeof originalUser.settings; updatedAt: Date } }) {
    reads.push({ collection: name, method: "updateOne", query, update });
    if (updateError) throw updateError;
    if (stored) stored = { ...stored, ...update.$set };
    if (discardAfterUpdate) stored = null;
  },
});
const originalConnect = MongoClient.prototype.connect;
const originalDb = MongoClient.prototype.db;
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = function () { return { collection } as never; };
try { await connectDatabase(); } finally {
  MongoClient.prototype.connect = originalConnect;
  MongoClient.prototype.db = originalDb;
}
const schema = makeExecutableSchema({ typeDefs, resolvers: authResolvers });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const reset = () => {
  stored = { ...originalUser, settings: { ...originalUser.settings } };
  profileLimit = 37; discardAfterUpdate = false; updateError = undefined; reads.length = 0;
};
const context = () => ({ user: { ...originalUser, authProvider: "email" as const } });
const settingsFields = "soundEnabled selectSound successSound errorSound popSound darkMode dailyNewCards";
try {
  for (const unauthorized of [{ user: null }, context()]) {
    reset();
    await assert.rejects(authResolvers.Mutation.syncSettings(null, { userId: String(other), settings: { darkMode: true } }, unauthorized), /^Error: Unauthorized$/);
    assert.deepEqual(reads, [], "Unauthorized settings never read or update another account");
  }
  reset();
  const source = `mutation($id:ID!,$settings:UserSettingsInput!){syncSettings(userId:$id,settings:$settings){id settings{${settingsFields}}}}`;
  const result = await graphql({ schema, source, variableValues: { id: String(owner), settings: { darkMode: true, dailyNewCards: 0 } }, contextValue: context() });
  assert.equal(result.errors, undefined);
  assert.deepEqual(json(result.data), { syncSettings: { id: String(owner), settings: { ...defaultUserSettings, selectSound: false, darkMode: true, dailyNewCards: 0 } } });
  assert.deepEqual(reads.map(read => [read.collection, read.method]), [["users", "findOne"], ["users", "updateOne"], ["users", "findOne"]], "Mutation preserves read→write→reread and zero avoids profile fallback");
  assert.ok((reads[1].update as { $set: { updatedAt: Date } }).$set.updatedAt instanceof Date);
  for (const read of reads) assert.deepEqual(read.query, { _id: owner });

  for (const badLimit of [-1, 1001, 1.5, null, NaN]) {
    reset();
    await assert.rejects(authResolvers.Mutation.syncSettings(null, { userId: String(owner), settings: { dailyNewCards: badLimit } }, context()), /Choose a daily new-card limit from 0 to 1000\./);
    assert.deepEqual(reads, [{ collection: "users", method: "findOne", query: { _id: owner } }], "Existing user read precedes validation; invalid settings cannot write");
  }
  reset(); stored = null;
  await assert.rejects(authResolvers.Mutation.syncSettings(null, { userId: String(owner), settings: { dailyNewCards: -1 } }, context()), /^Error: User not found$/);
  assert.equal(reads.length, 1, "Deleted-user error wins over invalid settings");
  reset(); updateError = new Error("fixture write rejected");
  await assert.rejects(authResolvers.Mutation.syncSettings(null, { userId: String(owner), settings: {} }, context()), /fixture write rejected/);
  assert.deepEqual(reads.map(read => read.method), ["findOne", "updateOne"], "Write failures do not report success or reread");
  reset(); discardAfterUpdate = true;
  assert.equal(await authResolvers.Mutation.syncSettings(null, { userId: String(owner), settings: {} }, context()), null, "Post-write deletion retains nullable response contract");
  assert.deepEqual(reads.map(read => read.method), ["findOne", "updateOne", "findOne"]);

  for (const [settings, limit, expectedLimit, expectedReads] of [
    [{}, 37, 37, 1], [{ dailyNewCards: 0 }, 37, 0, 0], [{ dailyNewCards: null }, 37, 37, 1], [{}, undefined, 20, 1],
  ] as const) {
    reset(); profileLimit = limit;
    const result = await graphql({ schema, source: `query{me{settings{${settingsFields}}} user(id:"${owner}"){settings{dailyNewCards}}}`, contextValue: { user: { ...originalUser, settings } } });
    assert.equal(result.errors, undefined);
    assert.deepEqual(json(result.data), { me: { settings: { ...defaultUserSettings, dailyNewCards: expectedLimit } }, user: { settings: { dailyNewCards: expectedLimit } } });
    assert.equal(reads.filter(read => read.collection === "schedulerprofiles").length, expectedReads, "Aliases share one request-scoped profile fallback");
    assert.equal(reads.filter(read => read.collection === "users").length, 0, "Settings use the already authenticated account");
  }
  reset();
  const nullable = await graphql({ schema, source, variableValues: { id: String(owner), settings: { darkMode: null } }, contextValue: context() });
  assert.match(nullable.errors?.[0].message ?? "", /Cannot return null for non-nullable field UserSettings.darkMode/);
  assert.equal(json(stored).settings.darkMode, null, "Existing nullable input semantics are preserved rather than silently defaulted");
  assert.deepEqual(reads.slice(0, 3).map(read => read.method), ["findOne", "updateOne", "findOne"]);
  console.log("PASS auth settings ownership, read/validate/write/reread order, nullable errors, zero limits, defaults and request profile caching");
} finally { await closeDatabase(); }
