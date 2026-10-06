import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { closeDatabase, connectDatabase } from "../src/lib/database.js";
import { typeDefs, resolvers } from "../src/graphql/schema.js";
import { activeDifficulty, chooseWritingWords, difficultWritingWords, writingLevel } from "../src/features/writing/vocabulary.js";
import { recordFailure } from "../src/features/progress/failures.js";

for (const level of ["A1", "A2", "B1", "B2", "C1", "C2"]) assert.equal(writingLevel(level), level);
assert.throws(() => writingLevel("C3"), /A1 to C2/);
assert.equal(activeDifficulty({ failureIndex: 2, writingReinforcementCredit: .25 }), 1.75);
assert.equal(activeDifficulty({ failureIndex: 0, writingReinforcementCredit: 1 }), 0);
if (!process.argv.includes("--unit")) {
  const db = await connectDatabase(), userId = new ObjectId(), otherId = new ObjectId(), ids: ObjectId[] = [], words: ObjectId[] = [];
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  try {
    for (let i = 0; i < 5; i++) {
      const relation = new ObjectId(), de = new ObjectId(), es = new ObjectId(); ids.push(relation); words.push(de, es);
      const data = { gramaticalCategories: [], examples: [], contexts: [], cefrLevel: i === 4 ? "C2.1" as const : "A1.1" as const, createdAt: new Date() };
      await db.wordsDE.insertOne({ ...data, _id: de, word: `Testwort${i}` }); await db.wordsES.insertOne({ ...data, _id: es, word: `palabra${i}` });
      await db.relationsWordsEsDe.insertOne({ _id: relation, main: es, translated: de, createdAt: new Date() });
      const base = { userId, relationId: relation, itemType: "WORD" as const, ease: 2.5, interval: 12, repetitions: 6, nextDueDate: new Date(), lastReviewed: new Date(i ? Date.now() : 0), createdAt: new Date() };
      const id = new ObjectId();
      await db.progress.insertOne({ ...base, _id: id, itemId: id, failureIndex: i === 0 ? 9 : i + 1, writingReinforcementCredit: i === 0 ? .25 : 0 });
      if (i === 0) for (const extra of [{ failureIndex: 4 }, { failureIndex: 100, suspended: true }, { failureIndex: 100, supersededByAnki: true }, { failureIndex: 999, userId: otherId }]) {
        const id = new ObjectId(); await db.progress.insertOne({ ...base, _id: id, itemId: id, ...extra });
      }
    }
    const top = await difficultWritingWords(userId, "B2");
    assert.equal(top[0].id, ids[0].toString()); assert.equal(top[0].failureIndex, 13); assert.equal(top[0].difficultyScore, 12.75);
    assert.equal(top.length, 4, "higher-level words do not appear in a beginner/intermediate list");
    const picked = await chooseWritingWords(userId, new ObjectId(), "B2", "DIFFICULT");
    assert.equal(picked[0].id, ids[0].toString(), "old high-failure words outrank recent easy words");
    assert.equal((await chooseWritingWords(userId, new ObjectId(), "A1", "DIFFICULT")).length, 2);
    const selection = [ids[2].toString(), ids[0].toString()];
    assert.deepEqual((await chooseWritingWords(userId, new ObjectId(), "C2", "DIFFICULT", selection)).map(word => word.id), selection);
    await assert.rejects(() => chooseWritingWords(userId, new ObjectId(), "A1", "DIFFICULT", [ids[4].toString()]), /above the chosen level/);
    await assert.rejects(() => chooseWritingWords(userId, new ObjectId(), "A1", "DIFFICULT", ids.slice(0, 3).map(String)), /up to 2/);
    await assert.rejects(() => chooseWritingWords(userId, new ObjectId(), "B2", "DIFFICULT", [selection[0], selection[0]]), /different words/);
    const first = await db.progress.findOne({ userId, relationId: ids[0], failureIndex: 9 });
    const failed = await recordFailure(db.progress, userId, first.itemId, randomUUID());
    assert.equal(failed.failureIndex, 10); assert.equal(activeDifficulty(failed), 9.75, "new mistakes raise active difficulty without erasing earned credit");
    assert.equal(failed.nextDueDate.getTime(), first.nextDueDate.getTime());
    const source = 'query { difficultWritingWords(level: "C2") { id failureIndex difficultyScore } }';
    const anonymous = await graphql({ schema, source, contextValue: { user: null } }); assert.match(anonymous.errors?.[0]?.message ?? "", /Unauthorized/);
    const own = await graphql({ schema, source, contextValue: { user: { _id: userId } } }); assert.ok(!own.errors);
    const other = await graphql({ schema, source, contextValue: { user: { _id: otherId } } }); assert.ok(!other.errors);
    assert.equal((other.data as any).difficultWritingWords[0].failureIndex, 999);
    console.log("PASS difficult vocabulary combines both directions, prioritizes old failures, filters CEFR/suspended/superseded cards, protects accounts and honors manual selection");
  } finally {
    await db.progress.deleteMany({ userId: { $in: [userId, otherId] } }); await db.relationsWordsEsDe.deleteMany({ _id: { $in: ids } });
    await db.wordsDE.deleteMany({ _id: { $in: words } }); await db.wordsES.deleteMany({ _id: { $in: words } }); await closeDatabase();
  }
}
console.log("PASS all six writing levels and active-difficulty floor");
