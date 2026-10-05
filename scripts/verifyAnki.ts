import "dotenv/config";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { typeDefs, resolvers } from "../src/graphql/schema.js";
import { noteContent, germanLexemeKey, studyCard } from "./lib/anki.js";
const [exportPath, email] = process.argv.slice(2);
if (!exportPath || !email) throw new Error("Usage: verifyAnki.ts export.json email");
const source = JSON.parse(await readFile(exportPath, "utf8"));
const uri = process.env.MONGODB_URI || `mongodb+srv://${process.env.DB_USER}:${process.env.DB_USER_PASSWORD}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
const client = await new MongoClient(uri).connect();
try {
  const db = client.db("gramatikapp"), app = await connectDatabase();
  const user = await app.users.findOne({ email });
  assert.ok(user);
  const digest = (rows: any[]) => createHash("sha256").update(JSON.stringify(rows.sort((a, b) => a.id - b.id))).digest("hex");
  for (const [table, name] of [["notes", "ANKI_NOTES"], ["cards", "ANKI_CARDS"], ["revlog", "ANKI_REVIEWS"]]) {
    const actual = await db.collection(name).find({ userId: user._id }).toArray();
    assert.equal(actual.length, source.tables[table].length);
    assert.equal(digest(actual.map(doc => doc.raw)), digest(source.tables[table]), `${table} must preserve every source field`);
    console.log(`PASS ${actual.length} ${table} rows preserved exactly`);
  }
  const progress = await app.progress.find({ userId: user._id, "card.source": "ANKI" }).toArray();
  assert.equal(progress.length, source.tables.cards.length);
  const sourceNotes = new Map(source.tables.notes.map((note: any) => [note.id, note]));
  const sourceCards = new Map(source.tables.cards.map((card: any) => [String(card.id), card]));
  for (const card of progress) {
    const raw: any = sourceCards.get(card.card.sourceCardId), note: any = sourceNotes.get(raw.nid);
    assert.deepEqual(card.card, studyCard(raw, note, source.tables, noteContent(note, source.tables)), `Study content mismatch for ${card.card.sourceCardId}`);
  }
  console.log("PASS every imported card prompt, answer, notes, examples, direction and deck mapping");
  assert.equal(progress.reduce((sum, p) => sum + p.sourceFailureCount, 0), source.tables.revlog.filter((r: any) => r.ease === 1).length);
  assert.equal(await app.progress.countDocuments({ failureIndex: { $exists: false } }), 0);
  const danglingWords = await app.progress.aggregate([
    { $match: { userId: user._id, "card.source": "ANKI", itemType: "WORD" } },
    { $lookup: { from: "WORDS_ES_DE", localField: "relationId", foreignField: "_id", as: "relation" } },
    { $match: { relation: { $size: 0 } } },
  ]).toArray();
  assert.equal(danglingWords.length, 0);
  const wordRelations = await app.relationsWordsEsDe.find({ _id: { $in: progress.filter(p => p.itemType === "WORD").map(p => p.relationId) } }).toArray();
  const germanWords = await app.wordsDE.find({ _id: { $in: wordRelations.map(r => r.translated) } }).toArray();
  const byRelation = new Map(wordRelations.map(r => [r._id.toString(), r]));
  const byWord = new Map(germanWords.map(w => [w._id.toString(), w]));
  for (const note of source.tables.notes) {
    const content = noteContent(note, source.tables);
    if (content.isCloze) continue;
    const card = progress.find(p => p.card.sourceNoteGuid === note.guid);
    const word = byWord.get(byRelation.get(card.relationId.toString()).translated.toString());
    assert.equal(germanLexemeKey(word.word, word.forms, word.gramaticalCategories), germanLexemeKey(content.german, content.forms, content.categories), `German identity/gender mismatch for ${content.german}`);
  }
  console.log("PASS all German word identities and noun genders, including noun/verb lookalikes");
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const importedWord = progress.find(p => p.itemType === "WORD")!;
  const importedCloze = progress.find(p => p.card.direction === "CLOZE")!;
  const importedCardQuery = await graphql({ schema,
    source: `query($userId: ID!, $wordId: ID!, $clozeId: ID!) {
      wordCard: userProgress(userId: $userId, itemId: $wordId) { card { source direction prompt answer notes examples } wordRelation { translated { word forms { perfect past plural gender } } } }
      clozeCard: userProgress(userId: $userId, itemId: $clozeId) { card { direction prompt answer notes } phraseRelation { translated { phrase } } }
    }`,
    variableValues: { userId: user._id.toString(), wordId: importedWord.itemId.toString(), clozeId: importedCloze.itemId.toString() }, contextValue: { user } });
  assert.equal(importedCardQuery.errors, undefined);
  assert.ok((importedCardQuery.data as any).wordCard.wordRelation.translated.word);
  assert.equal((importedCardQuery.data as any).wordCard.card.source, "ANKI");
  assert.equal((importedCardQuery.data as any).clozeCard.card.direction, "CLOZE");
  assert.ok((importedCardQuery.data as any).clozeCard.phraseRelation.translated.phrase);
  const query = `query($userId: ID!) {
    dueItems(userId: $userId, dueLimit: 5, newLimit: 0) { itemId failureIndex card { direction prompt answer notes } wordRelation { main { word } translated { word forms { gender perfect past plural } } } }
    mostFailedWords(userId: $userId, limit: 5) { failureIndex wordRelation { translated { word failureIndex } } cards { itemId failureIndex } }
  }`;
  const result = await graphql({ schema, source: query, variableValues: { userId: user._id.toString() }, contextValue: { user } });
  assert.equal(result.errors, undefined, result.errors?.map(e => e.message).join("; "));
  const ranked = (result.data as any).mostFailedWords;
  assert.equal(ranked.length, 5);
  assert.equal(ranked[0].failureIndex, ranked[0].cards.reduce((sum: number, c: any) => sum + c.failureIndex, 0));
  assert.ok(ranked.every((r: any, i: number) => !i || ranked[i - 1].failureIndex >= r.failureIndex));
  const unauthorized = await graphql({ schema, source: query, variableValues: { userId: user._id.toString() }, contextValue: { user: null } });
  assert.ok(unauthorized.errors?.some(e => e.message === "Unauthorized"));
  const testUserId = new ObjectId(), testItemId = new ObjectId();
  const sample = progress.find(p => p.itemType === "WORD")!;
  try {
    await app.progress.insertOne({ _id: new ObjectId(), userId: testUserId, itemId: testItemId, relationId: sample.relationId, itemType: "WORD", failureIndex: 0,
      ease: 2.5, interval: 0, repetitions: 0, nextDueDate: new Date(), lastReviewed: null, createdAt: new Date() });
    const contextValue = { user: { ...user, _id: testUserId } };
    const variables = { userId: testUserId.toString(), itemId: testItemId.toString(), attemptId: "graphql_attempt_001" };
    const mutation = `mutation($userId: ID!, $itemId: ID!, $attemptId: String!) { recordFailure(userId: $userId, itemId: $itemId, attemptId: $attemptId) { failureIndex } }`;
    const first = await graphql({ schema, source: mutation, variableValues: variables, contextValue });
    assert.equal(first.errors, undefined);
    assert.equal((first.data as any).recordFailure.failureIndex, 1);
    const rating = await graphql({ schema, source: `mutation($userId: ID!, $itemId: ID!) { reviewItem(userId: $userId, itemId: $itemId, itemType: "WORD", rating: 5) { success progress { failureIndex totalReviews } } }`, variableValues: variables, contextValue });
    assert.equal(rating.errors, undefined);
    assert.equal((rating.data as any).reviewItem.success, true);
    assert.equal((rating.data as any).reviewItem.progress.failureIndex, 1, "Easy rating after an error must retain the failure");
    const retry = await graphql({ schema, source: mutation, variableValues: variables, contextValue });
    assert.equal((retry.data as any).recordFailure.failureIndex, 1);
    const second = await graphql({ schema, source: mutation, variableValues: { ...variables, attemptId: "graphql_attempt_002" }, contextValue });
    assert.equal((second.data as any).recordFailure.failureIndex, 2);
    console.log("PASS real GraphQL failure mutation, rating independence and retry deduplication (temporary records removed)");
  } finally { await app.reviewEvents.deleteMany({ userId: testUserId }); await app.progress.deleteMany({ userId: testUserId }); }
  console.log("PASS production GraphQL due cards, forms, failure ranking, word totals, authenticated access and legacy counter backfill");
  console.log(JSON.stringify({ importedCards: progress.length, failureBaseline: progress.reduce((s, p) => s + p.sourceFailureCount, 0), mostFailed: ranked.map((r: any) => ({ word: r.wordRelation.translated.word, failures: r.failureIndex })) }, null, 2));
} finally { await client.close(); await closeDatabase(); }
