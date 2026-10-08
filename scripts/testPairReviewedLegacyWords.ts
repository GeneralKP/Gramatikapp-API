import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BSON, MongoClient, ObjectId } from "mongodb";
import { DEFAULT_OPTIONS, initialScheduler } from "../src/features/progress/scheduler.js";
import { FileWordCardJournal, deterministicWordCardId, sameWordCardBson, serializeWordCardEjson, wordCardSHA256, type MigrationJournal } from "./lib/wordCardMigration.js";
import { planReviewedLegacyPair, prepareReviewedLegacyPairs, readReviewedLegacyBackup, reviewedLegacyJournalManifest, runReviewedLegacyPairs, validateReviewedLegacyBackup, writeReviewedLegacyBackup } from "./pairReviewedLegacyWords.js";

const now = new Date("2026-10-08T10:00:00Z"), id = (key: string) => deterministicWordCardId(`legacy-pair-test:${key}`), target = "a".repeat(64);
const de = { _id: id("de"), word: "Haus", forms: { gender: "das" }, notes: "old", examples: [], contexts: [], gramaticalCategories: ["NOUN"], createdAt: now };
const es = { ...de, _id: id("es"), word: "casa", forms: {} };
const relation = { _id: id("relation"), main: es._id, translated: de._id, createdAt: now, study: { version: 1, german: "Das Haus", spanish: "casa", notes: "Die Häuser", examples: ["Das Haus ist groß. (La casa es grande.)"], auditedAt: now } };
const parent: any = { _id: id("parent"), userId: id("owner"), itemId: relation._id, itemType: "WORD", ease: 2.6, interval: 0, repetitions: 0, nextDueDate: now, lastReviewed: null, createdAt: now, updatedAt: now, isNew: false, failureIndex: 7, failureAttemptIds: ["existing"], totalReviews: 0, scheduleVersion: 4 };
parent.scheduler = initialScheduler({ ...parent, isNew: true }, { ...DEFAULT_OPTIONS, initialEase: 2.7, newPerDay: 17 }, "Europe/Berlin", 5);
const pair = await planReviewedLegacyPair(parent, relation, es, de, now);
assert.equal(pair.parentCard.answer, "Das Haus"); assert.equal(pair.parentCard.direction, "ES_DE");
assert.equal(pair.recognition.card.prompt, "Das Haus"); assert.equal(pair.recognition.card.direction, "DE_ES");
assert.equal(pair.recognition.scheduler.options.newPerDay, 17); assert.equal(pair.recognition.scheduler.timeZone, "Europe/Berlin"); assert.equal(pair.recognition.scheduler.rollover, 5);
assert.ok(sameWordCardBson(pair.parentBefore, parent)); assert.equal(pair.parentBefore.isNew, false);
assert.equal(pair.recognition._id.toHexString(), wordCardSHA256(`word-recognition:${parent.userId}:${relation._id}`).slice(0, 24));
assert.equal(Object.hasOwn(pair.parentBefore, "relationId"), false, "legacy item identity must remain absent rather than being rewritten");
const backup = { version: 1 as const, preparedAt: now, targetSHA256: target, pairs: [pair] };
validateReviewedLegacyBackup(backup);
const annotatedPair = await planReviewedLegacyPair(parent, { ...relation, study: { ...relation.study, german: "sich unterhalten", spanish: "conversar (rflxv.) (formal)", notes: "hat sich unterhalten\nich unterhielt mich\nunterhalte dich!, unterhaltet euch!" } }, es, de, now);
assert.equal(annotatedPair.recognition.card.answer, "conversar (rflxv.) (formal)", "Display annotations remain visible");
assert.deepEqual(annotatedPair.recognition.card.acceptedAnswers, ["conversar"], "Typed recognition answers omit display-only annotations consistently with nativeWordPair");
validateReviewedLegacyBackup({ ...backup, pairs: [annotatedPair] });
await assert.rejects(() => planReviewedLegacyPair({ ...parent, card: {} }, relation, es, de, now), /eligible/);
await assert.rejects(() => planReviewedLegacyPair({ ...parent, scheduler: { ...parent.scheduler, phase: "REVIEW" } }, relation, es, de, now), /NEW/);
await assert.rejects(() => planReviewedLegacyPair({ ...parent, scheduler: { ...parent.scheduler, options: { initialEase: 2.5 } } }, relation, es, de, now), /incomplete/);
await assert.rejects(() => planReviewedLegacyPair(parent, { ...relation, study: { ...relation.study, german: "<b>Haus</b>" } }, es, de, now), /plain-text/);
await assert.rejects(() => planReviewedLegacyPair(parent, { ...relation, translated: id("missing") }, es, de, now), /endpoints/);
assert.throws(() => validateReviewedLegacyBackup({ ...backup, pairs: [{ ...pair, recognition: { ...pair.recognition, failureIndex: 9 } }] }), /initial schedule/);
assert.throws(() => validateReviewedLegacyBackup({ ...backup, pairs: [{ ...pair, parentCard: { ...pair.parentCard, sourceNoteGuid: `app-word:${id("wrong")}:${relation._id}` } }] }), /source identity/);
assert.throws(() => validateReviewedLegacyBackup({ ...backup, pairs: [pair, pair] }), /Duplicate/);

const directory = await mkdtemp(join(tmpdir(), "reviewed-legacy-pair-"));
let client: MongoClient | undefined, server: ChildProcess | undefined;
try {
  const backupPath = join(directory, "backup.ejson");
  await writeReviewedLegacyBackup(backupPath, backup);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  const decoded = await readReviewedLegacyBackup(backupPath);
  assert.ok(decoded.pairs[0].parentBefore._id instanceof ObjectId);
  assert.ok(decoded.pairs[0].parentBefore.nextDueDate instanceof Date);
  assert.ok(sameWordCardBson(decoded, backup));
  await assert.rejects(() => writeReviewedLegacyBackup(backupPath, backup), /never overwrite/);
  console.log("Reviewed legacy pair content, scheduler, identity and private-backup tests passed.");
  if (!process.argv.includes("--mongo")) console.log("Use --mongo for isolated temporary replica-set transaction tests.");
  else {
    const cache = join(homedir(), ".cache", "mongodb-binaries");
    const binary = process.env.TEST_WORD_CARD_MONGOD || join(cache, (await readdir(cache)).filter(name => /^mongod-/.test(name)).sort().at(-1) || "missing-mongod");
    const portServer = createServer();
    await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "127.0.0.1", resolve); });
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => portServer.close(failure => failure ? reject(failure) : resolve()));
    const dbPath = join(directory, "mongo"); await mkdir(dbPath);
    server = spawn(binary, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--replSet", "reviewed_pair_tests", "--logpath", join(directory, "mongod.log")], { stdio: "ignore" });
    let spawnError = false; server.on("error", () => { spawnError = true; });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (spawnError || server.exitCode !== null) throw new Error("Temporary replica-set MongoDB could not start");
      const candidate = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 100 });
      try { await candidate.connect(); client = candidate; break; } catch { await candidate.close(); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(client);
    await client.db("admin").command({ replSetInitiate: { _id: "reviewed_pair_tests", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await client.db("admin").command({ hello: 1 })).isWritablePrimary) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await client.db("admin").command({ hello: 1 })).isWritablePrimary, true);
    const db = client.db("reviewed_legacy_pair_test");
    await db.collection("WORDS_ES").insertOne(es); await db.collection("WORDS_DE").insertOne(de); await db.collection("WORDS_ES_DE").insertOne(relation); await db.collection("userprogresses").insertOne(parent);
    const planned = await prepareReviewedLegacyPairs(db, [parent._id], target);
    const applyBackupPath = join(directory, "apply-backup.ejson"); await writeReviewedLegacyBackup(applyBackupPath, planned);
    const storedBackup = await readReviewedLegacyBackup(applyBackupPath);
    const journalPath = join(directory, "pairs.ejsonl");
    let journal = await FileWordCardJournal.open(journalPath, reviewedLegacyJournalManifest(storedBackup, wordCardSHA256(await readFile(applyBackupPath))), target);
    let result = await runReviewedLegacyPairs(client, db, storedBackup);
    assert.equal(result.complete, true); assert.equal(await db.collection("userprogresses").countDocuments(), 1);
    await assert.rejects(() => runReviewedLegacyPairs(client!, db, storedBackup, { mode: "apply" }), /durable/);
    // Change a protected schedule field after the journal starts; the transaction must make no partial writes.
    const racedJournal: MigrationJournal = { async record(event) { await journal.record(event); if (event.status === "started") await db.collection("userprogresses").updateOne({ _id: parent._id }, { $inc: { scheduleVersion: 1 } }); } };
    result = await runReviewedLegacyPairs(client, db, storedBackup, { mode: "apply", journal: racedJournal });
    assert.equal(result.complete, false); assert.equal(result.changed, 0); assert.equal(await db.collection("userprogresses").countDocuments(), 1);
    assert.equal(Object.hasOwn((await db.collection("userprogresses").findOne({ _id: parent._id }))!, "card"), false);
    await db.collection("userprogresses").updateOne({ _id: parent._id }, { $set: { scheduleVersion: parent.scheduleVersion } });
    // A changed canonical source also refuses creation before any parent/sibling write.
    await db.collection("WORDS_ES_DE").updateOne({ _id: relation._id }, { $set: { "study.notes": "changed after review" } });
    result = await runReviewedLegacyPairs(client, db, storedBackup, { mode: "apply", journal });
    assert.equal(result.complete, false); assert.equal(result.changed, 0);
    await db.collection("WORDS_ES_DE").updateOne({ _id: relation._id }, { $set: { study: relation.study } });
    result = await runReviewedLegacyPairs(client, db, storedBackup, { mode: "apply", journal });
    assert.equal(result.complete, true); assert.equal(result.changed, 1);
    const currentParent = await db.collection("userprogresses").findOne({ _id: parent._id });
    const rest = { ...currentParent }; delete rest.card;
    assert.ok(sameWordCardBson(rest, parent)); assert.equal(currentParent?.isNew, false); assert.equal(Object.hasOwn(currentParent!, "relationId"), false);
    assert.ok(sameWordCardBson(await db.collection("userprogresses").findOne({ _id: storedBackup.pairs[0].recognition._id }), storedBackup.pairs[0].recognition));
    result = await runReviewedLegacyPairs(client, db, storedBackup, { mode: "apply", journal });
    assert.equal(result.already, 1); assert.equal(result.changed, 0);
    await db.collection("userprogresses").updateOne({ _id: parent._id }, { $inc: { failureIndex: 1 } });
    result = await runReviewedLegacyPairs(client, db, storedBackup, { mode: "rollback", journal });
    assert.equal(result.complete, false); assert.equal(result.changed, 0);
    await db.collection("userprogresses").updateOne({ _id: parent._id }, { $set: { failureIndex: parent.failureIndex } });
    await db.collection("reviewevents").insertOne({ _id: id("review"), userId: parent.userId, itemId: storedBackup.pairs[0].recognition.itemId });
    result = await runReviewedLegacyPairs(client, db, storedBackup, { mode: "rollback", journal });
    assert.equal(result.complete, false);
    await db.collection("reviewevents").deleteOne({ _id: id("review") });
    result = await runReviewedLegacyPairs(client, db, storedBackup, { mode: "rollback", journal });
    assert.equal(result.complete, true); assert.equal(result.changed, 1);
    assert.ok(sameWordCardBson(await db.collection("userprogresses").findOne({ _id: parent._id }), parent)); assert.equal(await db.collection("userprogresses").countDocuments(), 1);
    result = await runReviewedLegacyPairs(client, db, storedBackup, { mode: "rollback", journal });
    assert.equal(result.already, 1);
    await journal.close();
    await db.collection("userprogresses").insertOne({ _id: storedBackup.pairs[0].recognition._id, userId: id("other-user"), itemId: id("other-item") });
    await assert.rejects(() => prepareReviewedLegacyPairs(db, [parent._id], target), /collision/);
    await db.collection("userprogresses").deleteOne({ _id: storedBackup.pairs[0].recognition._id });
    assert.deepEqual((await db.collection("userprogresses").listIndexes().toArray()).map(index => index.name), ["_id_"]);

    // Verify the actual CLI against only this temporary replica set.
    const envPath = join(directory, "empty.env"), cliBackup = join(directory, "cli-backup.ejson"); await writeFile(envPath, "", { mode: 0o600 });
    const runCLI = async (extra: string[]) => {
      const child = spawn(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/pairReviewedLegacyWords.ts", "--ids", parent._id.toHexString(), "--backup", cliBackup, "--database", "reviewed_legacy_pair_test", "--env-file", envPath, ...extra], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: `mongodb://127.0.0.1:${port}/?directConnection=true` }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk.toString(); }); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      const [code] = await once(child, "exit"); return { code, stdout, stderr };
    };
    let cli = await runCLI([]); assert.equal(cli.code, 0); assert.equal(JSON.parse(cli.stdout).mode, "dry-run"); assert.equal(cli.stderr, "");
    cli = await runCLI(["--apply"]); assert.equal(cli.code, 0); assert.equal(JSON.parse(cli.stdout).changed, 1);
    cli = await runCLI(["--apply"]); assert.equal(cli.code, 0); assert.equal(JSON.parse(cli.stdout).already, 1);
    cli = await runCLI(["--rollback"]); assert.equal(cli.code, 0); assert.equal(JSON.parse(cli.stdout).changed, 1);
    assert.ok(sameWordCardBson(await db.collection("userprogresses").findOne({ _id: parent._id }), parent));
    console.log("Reviewed legacy pair temporary MongoDB transaction and CLI tests passed.");
  }
} finally {
  await client?.close();
  if (server?.pid && server.exitCode === null && server.signalCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); await exited; }
  await rm(directory, { recursive: true, force: true });
}
