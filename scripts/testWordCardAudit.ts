import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { BSON, MongoClient, ObjectId, type Db } from "mongodb";
import { FileWordCardJournal, deterministicWordCardId, patchStateFilter, readWordCardManifest, runWordCardMigration, sameWordCardBson, serializeWordCardEjson, validateWordCardManifest, wordCardSHA256, WORD_CARD_PROGRESS_IDENTITY_PATHS, type MigrationJournal, type WordCardManifest, type WordCardPatch } from "./lib/wordCardMigration.js";

const now = new Date("2026-10-08T10:00:00.000Z"), hash = "a".repeat(64);
const id = (key: string) => deterministicWordCardId(`test:${key}`);
const patch = (overrides: Partial<WordCardPatch> = {}): WordCardPatch => ({ collection: "WORDS_DE", id: id("existing").toHexString(), set: { notes: "hat gelernt\nlernte\nlern!", examples: ["Ich lerne Deutsch."] }, unset: [], before: { notes: "hat gelernt<br>lernte", examples: [] }, missingBefore: [], ...overrides });
const manifest = (patches: WordCardPatch[] = [patch()]): WordCardManifest => ({ version: 1, auditedAt: now.toISOString(), snapshotSHA256: hash, patches, inserts: [] });
const word = (key: string, text: string) => ({ _id: id(key), word: text, gramaticalCategories: ["NOUN"], contexts: ["general_vocabulary"], examples: [], notes: "", createdAt: now, cefrLevel: "A1.1", cefrClassification: { level: "A1.1", model: "reviewed", version: 1, classifiedAt: now } });
const rejected = (value: unknown, pattern: RegExp) => assert.throws(() => validateWordCardManifest(value), pattern);

validateWordCardManifest(manifest());
assert.equal(id("stable").toString(), id("stable").toString(), "IDs must be repeatable");
assert.notEqual(id("stable").toString(), id("distinct").toString());
assert.ok(serializeWordCardEjson({ ...manifest(), auditedAt: now }).includes("$date"));
assert.deepEqual(patchStateFilter(patch(), "before").$and?.at(-1), { $expr: { $eq: ["$examples", { $literal: [] }] } });
rejected({ ...manifest(), version: 2 }, /version/);
rejected({ ...manifest(), auditedAt: "today" }, /date/);
rejected({ ...manifest(), auditedAt: "2026-02-30T10:00:00Z" }, /date/);
rejected({ ...manifest(), snapshotSHA256: "short" }, /checksum/);
rejected({ ...manifest(), surprise: true }, /manifest fields/);
rejected(manifest([patch({ collection: "users" as any })]), /collection/);
rejected(manifest([patch({ id: "not-an-id" })]), /ObjectId/);
for (const path of ["scheduler.state", "failureIndex", "relationId", "card.source", "card.sourceCardId", "card.direction", "createdAt", "updatedAt", "card", "$where", "forms.__proto__", "forms.perfect.0"]) {
  rejected(manifest([patch({ collection: "userprogresses", set: { [path]: "bad" }, before: { [path]: "old" }, missingBefore: [] })]), /scope|Unsafe|identity|protected/);
}
rejected(manifest([patch({ set: { forms: {}, "forms.perfect": "hat gelernt" }, before: { forms: {}, "forms.perfect": "gelernt" } })]), /Overlapping/);
rejected(manifest([patch({ before: { notes: "old" } })]), /cover/);
rejected(manifest([patch({ missingBefore: ["notes"] })]), /cover/);
rejected(manifest([patch(), patch()]), /Duplicate/);
rejected(manifest([patch({ set: { notes: "<br>" }, before: { notes: "old" } })]), /plain-text/);
rejected(manifest([patch({ set: { notes: "&nbsp;" }, before: { notes: "old" } })]), /plain-text/);
rejected(manifest([patch({ set: { notes: "line\\nline" }, before: { notes: "old" } })]), /newline/);
rejected(manifest([patch({ set: { examples: ["1. Ich lerne Deutsch."] }, before: { examples: [] } })]), /numbering/);
rejected(manifest([patch({ set: { examples: "[]" }, before: { examples: [] } })]), /array/);
rejected(manifest([patch({ set: { word: " " }, before: { word: "Haus" } })]), /plain-text/);
rejected(manifest([patch({ set: {}, unset: ["word"], before: { word: "Haus" } })]), /required/);
rejected(manifest([patch({ set: { forms: { guessed: "form" } }, before: { forms: {} } })]), /forms fields/);
rejected(manifest([patch({ collection: "WORDS_ES_DE", set: { main: id("es").toHexString() }, before: { main: id("other") } })]), /BSON/);
rejected(manifest([patch({ collection: "userprogresses", set: { "card.acceptedAnswers": [] }, before: { "card.acceptedAnswers": ["Haus"] } })]), /array/);
const identity = { userId: id("owner"), itemId: id("item"), relationId: id("existing-relation"), itemType: "WORD", "card.direction": "ES_DE", "card.source": "ANKI", "card.sourceCardId": "42", "card.sourceNoteGuid": "original" };
const cardPatch = patch({ collection: "userprogresses", set: { "card.answer": "Das Haus" }, before: { "card.answer": "Haus" }, guards: { before: identity, missingBefore: [] } });
validateWordCardManifest(manifest([cardPatch]));
rejected(manifest([{ ...cardPatch, guards: undefined }]), /identity guards/);
rejected(manifest([{ ...cardPatch, guards: { before: { ...identity, "scheduler.phase": "REVIEW" }, missingBefore: [] } }]), /guard-only/);
rejected(manifest([{ ...cardPatch, guards: { before: identity, missingBefore: ["relationId"] } }]), /duplicate/);
const incompleteIdentity = { ...identity }; delete (incompleteIdentity as any)["card.direction"];
rejected(manifest([{ ...cardPatch, guards: { before: incompleteIdentity, missingBefore: [] } }]), /cover/);
rejected(manifest([{ ...cardPatch, guards: { before: { ...identity, relationId: id("existing-relation").toHexString() }, missingBefore: [] } }]), /ObjectIds/);
assert.ok(patchStateFilter(cardPatch, "after").$and?.some(clause => sameWordCardBson(clause, { $expr: { $eq: ["$card.direction", { $literal: "ES_DE" }] } })), "after/idempotence/rollback must also check the frozen identity");
assert.equal(WORD_CARD_PROGRESS_IDENTITY_PATHS.length, 8);
const insertion = manifest([]);
insertion.inserts = [{ collection: "WORDS_DE", document: word("new", "Haus") }];
validateWordCardManifest(insertion);
rejected({ ...insertion, inserts: [{ collection: "userprogresses", document: word("new", "Haus") }] }, /insert collection/);
rejected({ ...insertion, inserts: [{ collection: "WORDS_DE", document: { ...word("new", "Haus"), source: "ANKI" } }] }, /insert fields/);
rejected({ ...insertion, inserts: [{ collection: "WORDS_DE", document: { ...word("new", "Haus"), _id: id("new").toString() } }] }, /ObjectId/);
rejected({ ...insertion, inserts: [{ collection: "WORDS_DE", document: { ...word("new", "Haus"), createdAt: now.toISOString() } }] }, /date/);
const study = { version: 1, german: "Das Haus", spanish: "casa", notes: "Die Häuser", examples: ["Das Haus ist groß."], auditedAt: now };
validateWordCardManifest(manifest([patch({ collection: "WORDS_ES_DE", set: { study }, before: {}, missingBefore: ["study"] })]));
const pairedStudy = { ...study, germanExamples: ["Das Haus ist groß."], spanishExamples: ["La casa es grande."], examples: ["Das Haus ist groß. (La casa es grande.)"] };
validateWordCardManifest(manifest([patch({ collection: "WORDS_ES_DE", set: { study: pairedStudy }, before: {}, missingBefore: ["study"] })]));
rejected(manifest([patch({ collection: "WORDS_ES_DE", set: { study: { ...pairedStudy, germanExamples: ["<b>Das Haus</b>"] } }, before: {}, missingBefore: ["study"] })]), /plain-text/);
rejected(manifest([patch({ collection: "WORDS_ES_DE", set: { study: { ...pairedStudy, spanishExamples: [] } }, before: {}, missingBefore: ["study"] })]), /bilingual pairing/);
rejected(manifest([patch({ collection: "WORDS_ES_DE", set: { study: { ...pairedStudy, spanishExamples: ["Otra frase."] } }, before: {}, missingBefore: ["study"] })]), /bilingual pairing/);
validateWordCardManifest(manifest([patch({ collection: "WORDS_ES_DE", set: { study: { ...study, category: "NOUN", forms: { gender: "das", plural: "Die Häuser" } } }, before: {}, missingBefore: ["study"] })]));
rejected(manifest([patch({ collection: "WORDS_ES_DE", set: { study: { ...study, forms: { plural: "<b>Häuser</b>" } } }, before: {}, missingBefore: ["study"] })]), /plain-text/);
rejected(manifest([patch({ collection: "WORDS_ES_DE", set: { study: { ...study, category: "MADE_UP" } }, before: {}, missingBefore: ["study"] })]), /grammatical categories/);
rejected(manifest([patch({ collection: "WORDS_ES_DE", set: { study: { ...study, forms: { scheduler: "NEW" } } }, before: {}, missingBefore: ["study"] })]), /forms fields/);
rejected(manifest([patch({ collection: "WORDS_ES_DE", set: { study: { ...study, spanish: "" } }, before: {}, missingBefore: ["study"] })]), /plain-text/);
rejected(manifest([patch({ collection: "WORDS_ES_DE", set: { study: { ...study, scheduler: {} } }, before: {}, missingBefore: ["study"] })]), /study fields/);

// A caller assertion is required before rollback can inspect or delete inserts.
const rollbackAccess = { reads: 0, writes: 0 };
const rollbackProbe = { collection() { return {
  async findOne() { rollbackAccess.reads++; return null; },
  async updateOne() { rollbackAccess.writes++; return { matchedCount: 1 }; },
  async insertOne() { rollbackAccess.writes++; },
  async deleteOne() { rollbackAccess.writes++; return { deletedCount: 1 }; },
}; } } as unknown as Db;
for (const acknowledgement of [undefined, false] as const) {
  let refusal: unknown;
  try {
    await runWordCardMigration(rollbackProbe, insertion, { mode: "rollback", journal: { async record() {} }, ...(acknowledgement === undefined ? {} : { writersPausedForRollback: acknowledgement }) });
  } catch (error) { refusal = error; }
  assert.deepEqual(rollbackAccess, { reads: 0, writes: 0 }, "unacknowledged inserted-record rollback must refuse before any database access");
  assert.match((refusal as Error)?.message || "", /writers.*paused/iu);
}

// A late stale value must block every write even when preflight reads overlap.
const preflightManifest = manifest(Array.from({ length: 18 }, (_, index) => patch({
  id: id(`preflight-${index}`).toHexString(), set: { notes: "new" }, before: { notes: "old" },
})));
function delayedPreflightDb(conflicts: number[], failureIndex?: number) {
  let active = 0, maximumActive = 0, writes = 0;
  const positions = new Map(preflightManifest.patches.map((value, index) => [value.id, index]));
  const db = { collection() { return {
    async findOne(filter: Record<string, any>) {
      const documentId = filter._id ?? filter.$and.find((condition: any) => condition._id)?._id;
      const index = positions.get(documentId.toHexString())!;
      active++; maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 1 + (7 - index % 8)));
        if (index === failureIndex) throw new Error("simulated preflight read failure");
        const before = filter.$and.some((condition: any) => condition.$expr?.$eq?.[1]?.$literal === "old");
        return before && !conflicts.includes(index) ? { _id: documentId } : null;
      } finally { active--; }
    },
    async updateOne() { writes++; return { matchedCount: 1 }; },
    async insertOne() { writes++; },
    async deleteOne() { writes++; return { deletedCount: 1 }; },
  }; } } as unknown as Db;
  return { db, metrics: () => ({ active, maximumActive, writes }) };
}
for (const mode of ["dry-run", "apply"] as const) {
  const fixture = delayedPreflightDb([2, 17]);
  const conflictOrder: number[] = [];
  const result = await runWordCardMigration(fixture.db, preflightManifest, { mode, journal: { async record(event) { conflictOrder.push(event.index); } } });
  assert.equal(result.conflicts, 2); assert.equal(result.wouldChange, 16); assert.equal(result.complete, false);
  assert.deepEqual(conflictOrder, [2, 17], "journal order must follow manifest order, not read completion order");
  assert.equal(fixture.metrics().writes, 0, "a conflict in the final batch must prevent all writes");
  assert.equal(fixture.metrics().active, 0);
  assert.ok(fixture.metrics().maximumActive > 1 && fixture.metrics().maximumActive <= 8, "preflight reads must overlap within a bounded window");
}
const failedPreflight = delayedPreflightDb([], 0);
await assert.rejects(() => runWordCardMigration(failedPreflight.db, preflightManifest, { mode: "apply", journal: { async record() {} } }), /preflight read failure/);
assert.equal(failedPreflight.metrics().writes, 0);
assert.equal(failedPreflight.metrics().active, 0, "all in-flight reads must settle before the migration rejects and its caller closes MongoDB");

const directory = await mkdtemp(join(tmpdir(), "word-card-audit-"));
let client: MongoClient | undefined, server: ChildProcess | undefined;
try {
  const manifestPath = join(directory, "manifest.ejson");
  await writeFile(manifestPath, serializeWordCardEjson(insertion), { mode: 0o600 });
  const decoded = await readWordCardManifest(manifestPath);
  assert.ok(decoded.inserts[0].document._id instanceof ObjectId);
  assert.ok(decoded.inserts[0].document.createdAt instanceof Date);
  assert.ok(decoded.inserts[0].document.cefrClassification.classifiedAt instanceof Date);
  const privatePath = join(directory, "private.ejsonl");
  let journal = await FileWordCardJournal.open(privatePath, manifest(), hash);
  await assert.rejects(() => FileWordCardJournal.open(privatePath, manifest(), hash), /locked/);
  await journal.record({ mode: "apply", kind: "patch", collection: "WORDS_DE", index: 0, status: "started" });
  await journal.close();
  assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
  assert.equal((await readFile(privatePath, "utf8")).trim().split("\n").length, 2);
  await assert.rejects(() => FileWordCardJournal.open(privatePath, insertion, hash), /different manifest/);
  journal = await FileWordCardJournal.open(privatePath, manifest(), hash);
  await journal.close();
  const incompletePath = join(directory, "incomplete.ejsonl");
  await writeFile(incompletePath, (await readFile(privatePath, "utf8")).trimEnd(), { mode: 0o600 });
  await assert.rejects(() => FileWordCardJournal.open(incompletePath, manifest(), hash), /incomplete/);
  console.log("Word-card audit manifest and private-journal tests passed.");

  if (!process.argv.includes("--mongo")) {
    console.log("Run with --mongo to also test an isolated temporary MongoDB (TEST_WORD_CARD_MONGOD can specify its local binary).");
  } else {
    // Never load dotenv, app credentials, a supplied Mongo URI, or a running app database.
    const cache = join(homedir(), ".cache", "mongodb-binaries");
    const binary = process.env.TEST_WORD_CARD_MONGOD || join(cache, (await readdir(cache)).filter(name => /^mongod-/.test(name)).sort().at(-1) || "missing-mongod");
    const portServer = createServer();
    await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "127.0.0.1", resolve); });
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
    const dbPath = join(directory, "mongo");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dbPath);
    server = spawn(binary, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--logpath", join(directory, "mongod.log")], { stdio: "ignore" });
    let spawnError = false;
    server.on("error", () => { spawnError = true; });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (spawnError || server.exitCode !== null) throw new Error("Temporary MongoDB could not start");
      const candidate = new MongoClient(`mongodb://127.0.0.1:${port}/`, { serverSelectionTimeoutMS: 100, connectTimeoutMS: 100 });
      try { await candidate.connect(); client = candidate; break; }
      catch { await candidate.close(); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(client, "Temporary MongoDB must start within its test timeout");
    const db = client.db("word_card_audit_test");
    const oldWord = { ...word("existing", "Haus"), notes: "hat gelernt<br>lernte" };
    const spanish = word("existing-es", "casa");
    const relation = { _id: id("existing-relation"), main: spanish._id, translated: oldWord._id, createdAt: now };
    const ownerId = id("owner"), legacyId = id("legacy"), progressId = id("progress");
    const oldCard = { source: "ANKI", sourceCardId: "42", sourceNoteGuid: "original", direction: "ES_DE", prompt: "casa", answer: "Haus", acceptedAnswers: ["Haus"], notes: "old", examples: [], deck: "original", tags: ["source-tag"] };
    const schedule = { phase: "REVIEW", interval: 18, ease: 2.5 };
    const progress = { _id: progressId, userId: ownerId, itemId: id("item"), itemType: "WORD", relationId: relation._id, card: oldCard, scheduler: schedule, nextDueDate: now, failureIndex: 7, sourceFailureCount: 3, totalReviews: 9, updatedAt: now, createdAt: now };
    const legacy = { ...progress, _id: legacyId, itemId: relation._id };
    delete (legacy as any).card;
    await db.collection("WORDS_DE").insertOne(oldWord);
    await db.collection("WORDS_ES").insertOne(spanish);
    await db.collection("WORDS_ES_DE").insertOne(relation);
    await db.collection("userprogresses").insertMany([progress, legacy]);

    // Planned words satisfy preflight, but actual relation writes require live endpoints.
    for (const relationOperation of ["insert", "patch"] as const) {
      const endpointDE = word(`endpoint-${relationOperation}-de`, "Der Baum"), endpointES = word(`endpoint-${relationOperation}-es`, "el árbol");
      const endpointRelation = { _id: id(`endpoint-${relationOperation}-relation`), main: endpointES._id, translated: endpointDE._id, createdAt: now };
      const endpointAudit = manifest(relationOperation === "patch" ? [patch({ collection: "WORDS_ES_DE", id: relation._id.toHexString(), set: { main: endpointES._id, translated: endpointDE._id }, before: { main: relation.main, translated: relation.translated }, missingBefore: [] })] : []);
      endpointAudit.inserts = [{ collection: "WORDS_DE", document: endpointDE }, { collection: "WORDS_ES", document: endpointES }, ...(relationOperation === "insert" ? [{ collection: "WORDS_ES_DE" as const, document: endpointRelation }] : [])];
      const endpointPreflight = await runWordCardMigration(db, endpointAudit);
      assert.equal(endpointPreflight.complete, true, "planned missing endpoints must remain valid during preflight");
      assert.equal(endpointPreflight.wouldChange, 3);
      journal = await FileWordCardJournal.open(join(directory, `endpoint-${relationOperation}.ejsonl`), endpointAudit, hash);
      let removedEndpoint = false;
      const endpointJournal: MigrationJournal = { async record(event) {
        await journal.record(event);
        if (event.status === "applied" && event.kind === "insert" && event.collection === "WORDS_ES") {
          assert.equal((await db.collection("WORDS_DE").deleteOne({ _id: endpointDE._id })).deletedCount, 1);
          removedEndpoint = true;
        }
      } };
      const endpointResult = await runWordCardMigration(db, endpointAudit, { mode: "apply", journal: endpointJournal });
      assert.equal(removedEndpoint, true, "the deletion must happen after successful preflight and both planned word insertions");
      assert.equal(endpointResult.complete, false, "a vanished planned endpoint must block the actual relation operation");
      assert.equal(endpointResult.changed, 2); assert.equal(endpointResult.conflicts, 1);
      assert.equal(await db.collection("WORDS_ES_DE").findOne({ _id: endpointRelation._id }), null);
      assert.ok(sameWordCardBson(await db.collection("WORDS_ES_DE").findOne({ _id: relation._id }), relation), "a blocked endpoint patch must preserve the original relation");
      await journal.close();
      await db.collection("WORDS_ES").deleteOne({ _id: endpointES._id });
    }

    const nativeCard = { source: "APP", sourceCardId: BigInt(`0x${wordCardSHA256(legacy.itemId.toHexString()).slice(0, 15)}`).toString(), sourceNoteGuid: `app-word:${ownerId}:${relation._id}`, direction: "ES_DE", prompt: study.spanish, answer: study.german, acceptedAnswers: [study.german], notes: study.notes, examples: study.examples, deck: "App", tags: [] };
    const audit = manifest([
      patch(),
      patch({ collection: "WORDS_ES_DE", id: relation._id.toHexString(), set: { study }, before: {}, missingBefore: ["study"] }),
      patch({ collection: "userprogresses", id: progressId.toHexString(), set: { "card.answer": "Das Haus", "card.acceptedAnswers": ["Das Haus"] }, before: { "card.answer": "Haus", "card.acceptedAnswers": ["Haus"] }, guards: { before: identity, missingBefore: [] } }),
      patch({ collection: "userprogresses", id: legacyId.toHexString(), set: { card: nativeCard }, before: {}, missingBefore: ["card"] }),
    ]);
    const addedDE = word("added-de", "Baum"), addedES = word("added-es", "árbol");
    // Deliberately list the relation first to verify dependency ordering.
    audit.inserts = [{ collection: "WORDS_ES_DE", document: { _id: id("added-relation"), main: addedES._id, translated: addedDE._id, createdAt: now, study: { ...study, german: "Der Baum", spanish: "árbol" } } }, { collection: "WORDS_DE", document: addedDE }, { collection: "WORDS_ES", document: addedES }];
    validateWordCardManifest(audit);
    rejected(manifest([patch({ collection: "userprogresses", id: legacyId.toHexString(), set: { card: nativeCard }, before: { card: oldCard }, missingBefore: [] })]), /only be created/);
    await assert.rejects(() => runWordCardMigration(db, audit, { mode: "apply" }), /durable/);
    const nativeOnly = manifest([audit.patches[3]]);
    await db.collection("userprogresses").updateOne({ _id: legacyId }, { $set: { "scheduler.phase": "NEW" } });
    assert.equal((await runWordCardMigration(db, nativeOnly)).conflicts, 1, "unseen native words require the separate atomic pairing flow");
    await db.collection("userprogresses").updateOne({ _id: legacyId }, { $set: { "scheduler.phase": "REVIEW" } });
    journal = await FileWordCardJournal.open(join(directory, "native-guard.ejsonl"), nativeOnly, hash);
    const nativeRaceJournal: MigrationJournal = { async record(event) {
      await journal.record(event);
      if (event.status === "started") await db.collection("userprogresses").updateOne({ _id: legacyId }, { $set: { "scheduler.phase": "NEW" } });
    } };
    const guarded = await runWordCardMigration(db, nativeOnly, { mode: "apply", journal: nativeRaceJournal });
    assert.equal(guarded.changed, 0); assert.equal(guarded.conflicts, 1, "NEW exclusion must be part of atomic CAS");
    await journal.close();
    assert.equal(Object.hasOwn((await db.collection("userprogresses").findOne({ _id: legacyId }))!, "card"), false);
    await db.collection("userprogresses").updateOne({ _id: legacyId }, { $set: { "scheduler.phase": "REVIEW" } });
    const guardedExisting = manifest([audit.patches[2]]);
    for (const [field, next, original] of [["relationId", id("changed-relation"), relation._id], ["card.direction", "DE_ES", "ES_DE"]] as const) {
      await db.collection("userprogresses").updateOne({ _id: progressId }, { $set: { [field]: next } });
      assert.equal((await runWordCardMigration(db, guardedExisting)).conflicts, 1, "stale relationship/direction must fail before mutation");
      await db.collection("userprogresses").updateOne({ _id: progressId }, { $set: { [field]: original } });
    }
    journal = await FileWordCardJournal.open(join(directory, "identity-race.ejsonl"), guardedExisting, hash);
    const identityRaceJournal: MigrationJournal = { async record(event) { await journal.record(event); if (event.status === "started") await db.collection("userprogresses").updateOne({ _id: progressId }, { $set: { "card.direction": "DE_ES" } }); } };
    assert.equal((await runWordCardMigration(db, guardedExisting, { mode: "apply", journal: identityRaceJournal })).conflicts, 1, "identity guard belongs in atomic CAS, after preflight");
    assert.equal((await db.collection("userprogresses").findOne({ _id: progressId }))?.card.answer, "Haus");
    await journal.close();
    await db.collection("userprogresses").updateOne({ _id: progressId }, { $set: { "card.direction": "ES_DE" } });
    let result = await runWordCardMigration(db, audit);
    assert.equal(result.wouldChange, 7); assert.equal(result.complete, true);
    assert.equal(await db.collection("WORDS_DE").countDocuments(), 1, "dry-run must never insert or patch");
    journal = await FileWordCardJournal.open(join(directory, "audit.ejsonl"), audit, hash);
    const schedulingJournal: MigrationJournal = { async record(event) {
      await journal.record(event);
      if (event.status === "started" && event.kind === "patch" && event.index === 2) await db.collection("userprogresses").updateOne({ _id: progressId }, { $inc: { totalReviews: 1, failureIndex: 1 }, $set: { "scheduler.interval": 21, nextDueDate: new Date("2026-11-01T00:00:00Z") } });
    } };
    result = await runWordCardMigration(db, audit, { mode: "apply", journal: schedulingJournal });
    assert.equal(result.changed, 7); assert.equal(result.complete, true);
    const studied = await db.collection("userprogresses").findOne({ _id: progressId });
    assert.equal(studied?.totalReviews, 10); assert.equal(studied?.failureIndex, 8); assert.equal(studied?.scheduler.interval, 21);
    assert.equal(studied?.card.sourceCardId, "42"); assert.equal(studied?.card.direction, "ES_DE"); assert.deepEqual(studied?.card.tags, ["source-tag"]);
    result = await runWordCardMigration(db, audit, { mode: "apply", journal });
    assert.equal(result.changed, 0); assert.equal(result.already, 7);
    await db.collection("WORDS_DE").updateOne({ _id: addedDE._id }, { $set: { concurrentContent: "changed" } });
    result = await runWordCardMigration(db, audit, { mode: "rollback", journal, writersPausedForRollback: true });
    assert.equal(result.complete, false); assert.equal(result.changed, 0, "rollback preflight must refuse modified inserted content");
    await db.collection("WORDS_DE").updateOne({ _id: addedDE._id }, { $unset: { concurrentContent: "" } });
    const newProgressId = id("new-progress");
    await db.collection("userprogresses").insertOne({ _id: newProgressId, itemType: "WORD", relationId: id("added-relation") });
    result = await runWordCardMigration(db, audit, { mode: "rollback", journal, writersPausedForRollback: true });
    assert.equal(result.complete, false); assert.equal(result.changed, 0, "new vocabulary already studied cannot be deleted");
    await db.collection("userprogresses").deleteOne({ _id: newProgressId });
    result = await runWordCardMigration(db, audit, { mode: "rollback", journal, writersPausedForRollback: true });
    assert.equal(result.complete, true); assert.equal(result.changed, 7);
    assert.ok(sameWordCardBson(await db.collection("WORDS_DE").findOne({ _id: oldWord._id }), oldWord));
    assert.ok(sameWordCardBson(await db.collection("WORDS_ES_DE").findOne({ _id: relation._id }), relation));
    const restored = await db.collection("userprogresses").findOne({ _id: progressId });
    assert.ok(sameWordCardBson(restored?.card, oldCard)); assert.equal(restored?.totalReviews, 10); assert.equal(restored?.failureIndex, 8);
    assert.equal(Object.hasOwn((await db.collection("userprogresses").findOne({ _id: legacyId }))!, "card"), false);
    result = await runWordCardMigration(db, audit, { mode: "rollback", journal, writersPausedForRollback: true });
    assert.equal(result.already, 7); assert.equal(result.changed, 0);
    await journal.close();
    const events = (await readFile(join(directory, "audit.ejsonl"), "utf8")).trim().split("\n").map(line => BSON.EJSON.parse(line, { relaxed: true }));
    assert.deepEqual(events.filter(event => event.status === "rolledBack").map(event => [event.kind, event.index]), [["patch", 3], ["patch", 2], ["patch", 1], ["patch", 0], ["insert", 0], ["insert", 2], ["insert", 1]]);

    // Array/scalar query equality must not turn a stale record into a match.
    await db.collection("WORDS_DE").updateOne({ _id: oldWord._id }, { $set: { notes: [oldWord.notes] } });
    result = await runWordCardMigration(db, manifest());
    assert.equal(result.conflicts, 1);
    await db.collection("WORDS_DE").updateOne({ _id: oldWord._id }, { $set: { notes: oldWord.notes } });

    const other = { ...word("race-other", "Baum"), notes: "before" };
    await db.collection("WORDS_DE").insertOne(other);
    const partial = manifest([patch(), patch({ id: other._id.toHexString(), set: { notes: "after" }, before: { notes: "before" } })]);
    journal = await FileWordCardJournal.open(join(directory, "partial.ejsonl"), partial, hash);
    const racingJournal: MigrationJournal = { async record(event) {
      await journal.record(event);
      if (event.status === "started" && event.index === 1) await db.collection("WORDS_DE").updateOne({ _id: other._id }, { $set: { notes: "concurrent" } });
    } };
    result = await runWordCardMigration(db, partial, { mode: "apply", journal: racingJournal });
    assert.equal(result.changed, 1); assert.equal(result.conflicts, 1); assert.equal(result.complete, false);
    await journal.close();
    const partialEvents = (await readFile(join(directory, "partial.ejsonl"), "utf8")).trim().split("\n").map(line => BSON.EJSON.parse(line, { relaxed: true }));
    assert.ok(partialEvents.some(event => event.status === "applied" && event.index === 0));
    assert.ok(partialEvents.some(event => event.status === "conflict" && event.index === 1));
    await db.collection("WORDS_DE").updateOne({ _id: other._id }, { $set: { notes: "before" } });
    journal = await FileWordCardJournal.open(join(directory, "partial.ejsonl"), partial, hash);
    result = await runWordCardMigration(db, partial, { mode: "apply", journal });
    assert.equal(result.already, 1); assert.equal(result.changed, 1); assert.equal(result.complete, true);
    await journal.close();
    assert.deepEqual((await db.collection("userprogresses").listIndexes().toArray()).map(index => index.name), ["_id_"], "migration must never create app indexes");
    // Exercise the real CLI against this test process with an empty env file.
    const snapshotPath = join(directory, "snapshot.ejson"), cliManifestPath = join(directory, "cli.ejson"), envPath = join(directory, "empty.env");
    const snapshotText = serializeWordCardEjson({ fixture: "local-only", at: now });
    await writeFile(snapshotPath, snapshotText, { mode: 0o600 });
    await writeFile(envPath, "", { mode: 0o600 });
    const cliManifest = { ...partial, snapshotSHA256: wordCardSHA256(snapshotText) };
    await writeFile(cliManifestPath, serializeWordCardEjson(cliManifest), { mode: 0o600 });
    const runCLI = async (extra: string[], sourceManifest = cliManifestPath) => {
      const processForCLI = spawn(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/applyWordCardAudit.ts", "--manifest", sourceManifest, "--snapshot", snapshotPath, "--database", "word_card_audit_test", "--env-file", envPath, ...extra], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: `mongodb://127.0.0.1:${port}/` }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      processForCLI.stdout.on("data", chunk => { stdout += chunk.toString(); });
      processForCLI.stderr.on("data", chunk => { stderr += chunk.toString(); });
      const [code] = await once(processForCLI, "exit");
      return { code, stdout, stderr };
    };
    let cli = await runCLI([]);
    assert.equal(cli.code, 0); assert.equal(JSON.parse(cli.stdout).mode, "dry-run"); assert.equal(JSON.parse(cli.stdout).already, 2); assert.equal(cli.stderr, "");
    cli = await runCLI(["--apply"]);
    assert.equal(cli.code, 0); assert.equal(JSON.parse(cli.stdout).changed, 0);
    const cliInserted = word("cli-inserted", "Der Test"), cliInsertManifestPath = join(directory, "cli-inserts.ejson");
    await db.collection("WORDS_DE").insertOne(cliInserted);
    await writeFile(cliInsertManifestPath, serializeWordCardEjson({ ...cliManifest, inserts: [{ collection: "WORDS_DE", document: cliInserted }] }), { mode: 0o600 });
    const beforeCLIRefusal = await db.collection("WORDS_DE").find().sort({ _id: 1 }).toArray();
    cli = await runCLI(["--rollback"], cliInsertManifestPath);
    assert.equal(cli.code, 1); assert.match(cli.stderr, /writers.*paused/iu); assert.equal(cli.stdout, "");
    assert.ok(sameWordCardBson(await db.collection("WORDS_DE").find().sort({ _id: 1 }).toArray(), beforeCLIRefusal), "omitted rollback acknowledgement must preserve every owned fixture word");
    cli = await runCLI(["--rollback", "--writers-paused-for-rollback"], cliInsertManifestPath);
    assert.equal(cli.code, 0); assert.equal(JSON.parse(cli.stdout).changed, 3);
    assert.equal(await db.collection("WORDS_DE").findOne({ _id: cliInserted._id }), null);
    cli = await runCLI(["--rollback", "--writers-paused-for-rollback"]);
    assert.equal(cli.code, 0); assert.equal(JSON.parse(cli.stdout).already, 2); assert.equal(JSON.parse(cli.stdout).changed, 0);
    assert.equal((await stat(`${cliManifestPath}.journal.ejsonl`)).mode & 0o777, 0o600);
    await writeFile(snapshotPath, "wrong snapshot", { mode: 0o600 });
    cli = await runCLI([]);
    assert.equal(cli.code, 1); assert.match(cli.stderr, /checksum differs/); assert.equal(cli.stdout, "");
    console.log("Word-card audit temporary MongoDB tests passed: apply, idempotence, independent study updates, stale CAS, partial recovery, protected inserts and rollback.");
  }
} finally {
  await client?.close();
  if (server?.pid && server.exitCode === null && server.signalCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); await exited; }
  await rm(directory, { recursive: true, force: true });
}
