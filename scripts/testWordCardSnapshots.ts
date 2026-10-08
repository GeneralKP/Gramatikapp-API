import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BSON, type Db, type Document } from "mongodb";
import { DEFAULT_OPTIONS, initialScheduler } from "../src/features/progress/scheduler.js";
import type { UserProgress } from "../src/features/progress/progress.types.js";
import { WORD_CARD_PROGRESS_IDENTITY_PATHS, deterministicWordCardId, sameWordCardBson, serializeWordCardEjson, wordCardSHA256, type WordCardManifest, type WordCardPatch } from "./lib/wordCardMigration.js";
import { captureWordCardSnapshot, wordCardSnapshotConnection, writeWordCardSnapshotFiles, type WordCardSnapshot } from "./snapshotWordCardAudit.js";
import { verifyWordCardAudit, writeWordCardVerificationReport } from "./verifyWordCardAudit.js";
import { validateReviewedLegacyBackup, type ReviewedLegacyBackup } from "./pairReviewedLegacyWords.js";

const now = new Date("2026-10-08T10:00:00.000Z"), target = "f".repeat(64);
const oid = (key: string) => deterministicWordCardId(`snapshot-verifier-fixture:${key}`);
const copy = <T>(value: T): T => BSON.EJSON.parse(serializeWordCardEjson(value), { relaxed: false });
const word = (key: string, text: string) => ({ _id: oid(key), word: text, forms: {}, notes: "", examples: [], gramaticalCategories: ["NOUN"], contexts: ["general_vocabulary"], cefrLevel: "A1.1", cefrClassification: { level: "A1.1", model: "fixture-classifier", version: 1, classifiedAt: now }, createdAt: now });
const de = { ...word("de", "Haus"), forms: { gender: "das" }, notes: "<b>old</b>", examples: ["1. Altes Beispiel."] }, es = { ...word("es", "casa"), notes: "<br>old" };
const relation = { _id: oid("relation"), main: es._id, translated: de._id, createdAt: now };
const study = { version: 1, german: "Das Haus", spanish: "la casa", notes: "Die Häuser", forms: { gender: "das", plural: "Die Häuser", perfect: "" }, category: "NOUN", germanExamples: ["Das Haus ist groß.", "Wir kaufen ein Haus."], spanishExamples: ["La casa es grande.", "Compramos una casa."], examples: ["Das Haus ist groß. (La casa es grande.)", "Wir kaufen ein Haus. (Compramos una casa.)"], auditedAt: now };
function progress(key: string, direction: string): Document {
  const document: Document = { _id: oid(key), userId: oid("private-owner"), itemId: oid(`item:${key}`), itemType: "WORD", relationId: relation._id, failureIndex: 4, failureAttemptIds: ["PRIVATE_FAILURE"], totalReviews: 7, ease: 2.5, interval: 12, repetitions: 7, nextDueDate: now, lastReviewed: now, updatedAt: now, createdAt: now, scheduleVersion: 4, suspended: false,
    card: { source: "ANKI", sourceCardId: key === "production" ? "123" : "124", sourceNoteGuid: "<br>PRIVATE_SOURCE_GUID", direction, prompt: direction === "ES_DE" ? "casa" : "Haus", answer: direction === "ES_DE" ? "Haus" : "casa", acceptedAnswers: [direction === "ES_DE" ? "Haus" : "casa"], notes: "<b>old</b>", examples: ["1. Old."], deck: "Original", tags: ["<b>PRIVATE_SOURCE_TAG"] },
  };
  document.scheduler = initialScheduler(document as UserProgress, DEFAULT_OPTIONS, "Europe/Berlin", 4); document.scheduler.phase = "REVIEW";
  return document;
}
const production = progress("production", "ES_DE"), recognition = progress("recognition", "DE_ES");
const before: WordCardSnapshot = { auditedAt: now.toISOString(), database: "offline_fixture", targetSHA256: target, collections: { WORDS_DE: [de], WORDS_ES: [es], WORDS_ES_DE: [relation], userprogresses: [production, recognition] } };
const beforeText = serializeWordCardEjson(before), beforeSHA256 = wordCardSHA256(beforeText);
const at = (document: Document, path: string): unknown => path.split(".").reduce((value: any, key) => value?.[key], document);
function patch(collection: WordCardPatch["collection"], document: Document, set: Record<string, unknown>): WordCardPatch {
  const fields = Object.keys(set), existing = fields.filter(path => at(document, path) !== undefined);
  const result: WordCardPatch = { collection, id: document._id.toHexString(), set, unset: [], before: Object.fromEntries(existing.map(path => [path, at(document, path)])), missingBefore: fields.filter(path => !existing.includes(path)) };
  if (collection === "userprogresses") {
    const guardPaths = Object.hasOwn(set, "card") ? WORD_CARD_PROGRESS_IDENTITY_PATHS.slice(0, 4) : WORD_CARD_PROGRESS_IDENTITY_PATHS;
    result.guards = { before: Object.fromEntries(guardPaths.filter(path => at(document, path) !== undefined).map(path => [path, at(document, path)])), missingBefore: guardPaths.filter(path => at(document, path) === undefined) };
  }
  return result;
}
const cardContent = (direction: string) => ({ prompt: direction === "ES_DE" ? study.spanish : study.german, answer: direction === "ES_DE" ? study.german : study.spanish, acceptedAnswers: [direction === "ES_DE" ? study.german : study.spanish], notes: study.notes, examples: study.examples });
const treeDE = word("tree-de", "Baum"), treeES = word("tree-es", "árbol");
const treeRelation = { _id: oid("tree-relation"), main: treeES._id, translated: treeDE._id, createdAt: now, study: { ...study, german: "Der Baum", spanish: "el árbol" } };
const manifest: WordCardManifest = { version: 1, auditedAt: now, snapshotSHA256: beforeSHA256, patches: [
  patch("WORDS_DE", de, { notes: "Die Häuser", "forms.plural": "Die Häuser", examples: ["Das Haus ist groß.", "Wir kaufen ein Haus."] }),
  patch("WORDS_ES", es, { notes: "", examples: ["La casa es grande.", "Compramos una casa."] }),
  patch("WORDS_ES_DE", relation, { study }),
  ...[production, recognition].map(document => patch("userprogresses", document, Object.fromEntries(Object.entries(cardContent(document.card.direction)).map(([key, value]) => [`card.${key}`, value])))),
], inserts: [{ collection: "WORDS_DE", document: treeDE }, { collection: "WORDS_ES", document: treeES }, { collection: "WORDS_ES_DE", document: treeRelation }] };
const after = copy(before); after.auditedAt = "2026-10-08T10:01:00.000Z";
for (const operation of manifest.patches) {
  const document = after.collections[operation.collection].find(document => document._id.equals(new BSON.ObjectId(operation.id)))!;
  for (const [path, value] of Object.entries(operation.set)) {
    const parts = path.split("."); let parent = document;
    for (const key of parts.slice(0, -1)) parent = parent[key] ??= {};
    parent[parts.at(-1)!] = copy(value);
  }
}
for (const insert of manifest.inserts) after.collections[insert.collection].push(copy(insert.document));
const verify = (current = after, audit = manifest, original = before, backups?: ReviewedLegacyBackup[]) => verifyWordCardAudit(original, current, audit, { beforeSHA256: audit.snapshotSHA256, pairingBackups: backups, verifiedAt: now.toISOString() });
const report = verify();
assert.equal(report.status, "verified", JSON.stringify(report.anomalies));
assert.equal(report.counts.verifiedPatches, 5); assert.equal(report.counts.verifiedInserts, 3); assert.equal(report.counts.canonicalCardsChecked, 2);
assert.ok(!report.anomalies.some(item => item.code.includes("html")), "HTML-like source GUIDs/tags are outside visible lexical fields");
assert.equal(serializeWordCardEjson(before), beforeText, "Verification never mutates the before snapshot");
const mutated = (fn: (snapshot: WordCardSnapshot) => void) => { const snapshot = copy(after); fn(snapshot); return verify(snapshot); };
assert.ok(mutated(snapshot => { snapshot.collections.WORDS_DE = snapshot.collections.WORDS_DE.filter(word => !word._id.equals(de._id)); }).anomalies.some(item => item.code === "original_id_missing"));
assert.ok(mutated(snapshot => { snapshot.collections.WORDS_DE[0].word = "Das Haus"; }).anomalies.some(item => item.code === "unplanned_lexical_change"), "Dictionary word outside planned patches remains untouched");
const scheduled = mutated(snapshot => { snapshot.collections.userprogresses[0].scheduler.interval = 14; snapshot.collections.userprogresses[0].failureIndex = 5; });
assert.equal(scheduled.status, "unverified"); assert.equal(scheduled.counts.errors, 0);
assert.ok(scheduled.anomalies.some(item => item.code === "protected_progress_changed"));
const contextChange = mutated(snapshot => { snapshot.collections.WORDS_DE[0].contexts = ["changed"]; snapshot.collections.WORDS_DE[0].cefrLevel = "B2"; });
assert.equal(contextChange.status, "unverified"); assert.ok(contextChange.anomalies.some(item => item.code === "protected_catalog_changed"));
assert.equal(mutated(snapshot => { snapshot.collections.userprogresses[0].card.deck = "Changed archive/source deck"; }).status, "unverified", "Archival/source fields are protected");
assert.ok(mutated(snapshot => { snapshot.collections.userprogresses[0].card.answer = "Haus"; }).anomalies.some(item => item.code === "directional_card_not_canonical"));
assert.ok(mutated(snapshot => { snapshot.collections.WORDS_DE[1].examples = ["1. Der Baum ist groß."]; }).anomalies.some(item => item.code === "numbered_example" && item.severity === "error"));
assert.ok(mutated(snapshot => { snapshot.collections.WORDS_ES[1].notes = "<b>nuevo</b>"; }).anomalies.some(item => item.code === "html_in_lexical_field" && item.severity === "error"));
assert.ok(mutated(snapshot => { snapshot.collections.WORDS_ES_DE[0].study.forms.plural = "<b>Häuser</b>"; }).anomalies.some(item => item.code === "html_in_lexical_field" && item.severity === "error"), "fresh verification also checks optional canonical study grammar for markup");
assert.ok(mutated(snapshot => { snapshot.collections.WORDS_ES_DE[0].study.spanishExamples[0] = "<b>Casa</b>"; }).anomalies.some(item => item.code === "html_in_lexical_field" && item.severity === "error"), "fresh verification checks language-specific pair examples for markup");
assert.ok(mutated(snapshot => { snapshot.collections.WORDS_ES_DE[1].main = oid("missing"); }).anomalies.some(item => item.code === "dangling_relation_endpoint" && item.severity === "error"));
assert.ok(mutated(snapshot => { delete snapshot.collections.WORDS_DE[1].cefrClassification; }).anomalies.some(item => item.code === "insert_classifier_metadata_missing_or_estimated"));
const inheritedManifest = copy(manifest), inheritedAfter = copy(after);
inheritedManifest.inserts = inheritedManifest.inserts.filter(insert => insert.collection !== "WORDS_DE");
inheritedAfter.collections.WORDS_DE = inheritedAfter.collections.WORDS_DE.filter(document => document._id.equals(de._id));
for (const relation of inheritedManifest.inserts.filter(insert => insert.collection === "WORDS_ES_DE")) relation.document.translated = de._id;
inheritedAfter.collections.WORDS_ES_DE[1].translated = de._id;
inheritedManifest.inserts.find(insert => insert.collection === "WORDS_ES")!.document.cefrClassification.model = "parent-estimate";
inheritedAfter.collections.WORDS_ES[1].cefrClassification.model = "parent-estimate";
assert.equal(verify(inheritedAfter, inheritedManifest).status, "verified", "New Spanish may inherit its paired existing German's actual dated classification");
for (const damage of ["date", "level", "undated-parent"] as const) {
  const damagedManifest = copy(inheritedManifest), damagedAfter = copy(inheritedAfter), damagedBefore = copy(before);
  if (damage === "undated-parent") delete damagedBefore.collections.WORDS_DE[0].cefrClassification.classifiedAt;
  else for (const document of [damagedManifest.inserts.find(insert => insert.collection === "WORDS_ES")!.document, damagedAfter.collections.WORDS_ES[1]]) {
    if (damage === "date") document.cefrClassification.classifiedAt = new Date(now.getTime() + 1);
    else { document.cefrLevel = "B2.1"; document.cefrClassification.level = "B2.1"; }
  }
  damagedManifest.snapshotSHA256 = wordCardSHA256(serializeWordCardEjson(damagedBefore));
  assert.ok(verify(damagedAfter, damagedManifest, damagedBefore).anomalies.some(item => item.code === "insert_classifier_metadata_missing_or_estimated"), `Inherited Spanish requires exact ${damage} evidence from the original paired German`);
}
assert.ok(mutated(snapshot => { snapshot.collections.WORDS_DE[1].cefrClassification.model = "parent-estimate"; }).anomalies.some(item => item.code === "insert_classifier_metadata_missing_or_estimated"), "New German may never bypass actual classification by inheriting a level");
assert.ok(mutated(snapshot => { snapshot.collections.WORDS_ES[1].cefrClassification.model = "parent-estimate"; }).anomalies.some(item => item.code === "insert_classifier_metadata_missing_or_estimated"), "A new German endpoint cannot supply original classification evidence for inherited Spanish");
const stale = copy(manifest); stale.patches[0].before.notes = "wrong baseline";
assert.ok(verify(after, stale).anomalies.some(item => item.code === "manifest_before_values_mismatch"));
assert.throws(() => verifyWordCardAudit(before, after, manifest, { beforeSHA256: "0".repeat(64) }), /checksum/);
const forbidden = copy(manifest); forbidden.patches[3].set["scheduler.phase"] = "NEW";
assert.throws(() => verify(after, forbidden), /scope|guard|cover/u);
const aliasManifest = copy(manifest), aliasAfter = copy(after);
aliasManifest.patches[3].set["card.acceptedAnswers"] = ["Das Haus", "das Haus"];
aliasAfter.collections.userprogresses[0].card.acceptedAnswers = ["Das Haus", "das Haus"];
assert.equal(verify(aliasAfter, aliasManifest).status, "verified", "Manifest-bound reviewed aliases do not invalidate the canonical primary answer");
const formalManifest = copy(manifest), formalAfter = copy(after);
formalAfter.collections.WORDS_ES_DE[0].study.spanish = "la casa (formal)";
(formalManifest.patches[2].set.study as Document).spanish = "la casa (formal)";
formalAfter.collections.userprogresses[0].card.prompt = "la casa (formal)"; formalManifest.patches[3].set["card.prompt"] = "la casa (formal)";
formalAfter.collections.userprogresses[1].card.answer = "la casa (formal)"; formalManifest.patches[4].set["card.answer"] = "la casa (formal)";
assert.equal(verify(formalAfter, formalManifest).status, "verified", "Spanish display annotations can be omitted from the canonical accepted answer");

const legacy = copy(production); legacy._id = oid("legacy-reviewed"); delete legacy.card;
const legacyBefore = copy(before); legacyBefore.collections.userprogresses.push(legacy);
const nativeCard = { source: "APP", sourceCardId: BigInt(`0x${wordCardSHA256(legacy.itemId.toHexString()).slice(0, 15)}`).toString(), sourceNoteGuid: `app-word:${legacy.userId}:${relation._id}`, direction: "ES_DE", ...cardContent("ES_DE"), deck: "App", tags: [] };
const legacyManifest = { ...manifest, snapshotSHA256: wordCardSHA256(serializeWordCardEjson(legacyBefore)), patches: [...manifest.patches, patch("userprogresses", legacy, { card: nativeCard })] };
const legacyAfter = copy(after); legacyAfter.collections.userprogresses.push({ ...legacy, card: nativeCard });
assert.equal(verify(legacyAfter, legacyManifest, legacyBefore).status, "verified", "A reviewed legacy card can be created without changing its protected parent state");
const forbiddenNewBefore = copy(legacyBefore); forbiddenNewBefore.collections.userprogresses.at(-1)!.scheduler.phase = "NEW";
const forbiddenNewManifest = { ...legacyManifest, snapshotSHA256: wordCardSHA256(serializeWordCardEjson(forbiddenNewBefore)) };
assert.ok(verify(legacyAfter, forbiddenNewManifest, forbiddenNewBefore).anomalies.some(item => item.code === "generic_card_creation_for_new_parent"), "A NEW parent requires dedicated atomic pair backup");

// Construct a complete native-pair backup using only the pure scheduler contract.
const parent: Document = { _id: oid("new-parent"), userId: oid("pair-owner"), itemId: relation._id, itemType: "WORD", isNew: true, failureIndex: 7, failureAttemptIds: ["KEEP"], totalReviews: 0, lapses: 0, ease: 2.5, interval: 0, repetitions: 0, nextDueDate: now, lastReviewed: null, createdAt: now, updatedAt: now, scheduleVersion: 4 };
parent.scheduler = initialScheduler(parent as UserProgress, DEFAULT_OPTIONS, "Europe/Berlin", 4);
const seed = (value: BSON.ObjectId) => BigInt(`0x${wordCardSHA256(value.toHexString()).slice(0, 15)}`).toString();
const parentCard = { source: "APP", sourceCardId: seed(parent.itemId), sourceNoteGuid: `app-word:${parent.userId}:${relation._id}`, direction: "ES_DE", ...cardContent("ES_DE"), deck: "App", tags: [] };
const readingId = new BSON.ObjectId(wordCardSHA256(`word-recognition:${parent.userId}:${relation._id}`).slice(0, 24));
const reading: Document = { _id: readingId, userId: parent.userId, itemId: readingId, itemType: "WORD", relationId: relation._id, card: { ...parentCard, sourceCardId: seed(readingId), direction: "DE_ES", ...cardContent("DE_ES") }, failureIndex: 0, totalReviews: 0, lapses: 0, isNew: true, ease: DEFAULT_OPTIONS.initialEase, interval: 0, repetitions: 0, nextDueDate: parent.nextDueDate, lastReviewed: null, createdAt: now };
reading.scheduler = initialScheduler(reading as UserProgress, parent.scheduler.options, parent.scheduler.timeZone, parent.scheduler.rollover);
const pairingBackup: ReviewedLegacyBackup = { version: 1, preparedAt: now, targetSHA256: target, pairs: [{ parentBefore: parent, parentCard, recognition: reading, sourceRelation: { ...relation, study } as any, parentRestSHA256: wordCardSHA256(serializeWordCardEjson(parent)) }] };
delete (pairingBackup.pairs[0].sourceRelation as any).createdAt;
validateReviewedLegacyBackup(pairingBackup);
const pairBefore = copy(before); pairBefore.collections.userprogresses.push(parent);
const pairAfter = copy(after); pairAfter.collections.userprogresses.push({ ...parent, card: parentCard }, reading);
const pairManifest = { ...manifest, snapshotSHA256: wordCardSHA256(serializeWordCardEjson(pairBefore)) };
const pairReport = verify(pairAfter, pairManifest, pairBefore, [pairingBackup]);
assert.equal(pairReport.status, "verified", JSON.stringify(pairReport.anomalies));
assert.equal(pairReport.counts.verifiedPairParents, 1); assert.equal(pairReport.counts.verifiedRecognition, 1);
const changedParent = copy(pairAfter); changedParent.collections.userprogresses.find(document => document._id.equals(parent._id))!.failureIndex = 8;
assert.equal(verify(changedParent, pairManifest, pairBefore, [pairingBackup]).status, "unverified");
const changedReading = copy(pairAfter); changedReading.collections.userprogresses.find(document => document._id.equals(readingId))!.totalReviews = 1;
assert.ok(verify(changedReading, pairManifest, pairBefore, [pairingBackup]).anomalies.some(item => item.code === "recognition_protected_state_changed"));
const missingReading = copy(pairAfter); missingReading.collections.userprogresses = missingReading.collections.userprogresses.filter(document => !document._id.equals(readingId));
assert.ok(verify(missingReading, pairManifest, pairBefore, [pairingBackup]).anomalies.some(item => item.code === "recognition_insert_missing"));
assert.ok(verify(pairAfter, pairManifest, pairBefore).anomalies.some(item => item.code === "unplanned_new_record"), "New recognition creation requires its exact dedicated backup");
const pairTamper = copy(pairingBackup); pairTamper.pairs[0].recognition.card.answer = "wrong";
assert.throws(() => verify(pairAfter, pairManifest, pairBefore, [pairTamper]), /recognition|initial schedule/u);

// Read-only snapshot adapter: only find/sort/toArray exist in the fixture.
const queries: { name: string; filter: unknown; order?: unknown }[] = [];
const raw = { ...before.collections, userprogresses: [...before.collections.userprogresses, { _id: oid("phrase"), itemType: "PHRASE", userId: oid("private-owner") }] };
const fakeDb = { collection(name: keyof typeof raw) { return { find(filter: any) { const query = { name, filter, order: undefined as unknown }; queries.push(query); return { sort(order: unknown) { query.order = order; return { async toArray() { return raw[name].filter(document => !filter.itemType || document.itemType === filter.itemType); } }; } }; } }; } } as unknown as Pick<Db, "collection">;
const snapshot = await captureWordCardSnapshot(fakeDb, "offline_fixture", { clock: () => now, targetSHA256: target });
assert.deepEqual(queries.map(query => query.name), ["WORDS_DE", "WORDS_ES", "WORDS_ES_DE", "userprogresses"]);
assert.deepEqual(queries[3].filter, { itemType: "WORD" }); assert.ok(queries.every(query => sameWordCardBson(query.order, { _id: 1 })));
assert.equal(snapshot.collections.userprogresses.length, 2);
const configured = wordCardSnapshotConnection({ DB_USER: "fixture@user", DB_USER_PASSWORD: "p/@word", DB_CLUSTER: "fixture", DB_NAME: "fixture_db" });
assert.ok(configured.uri.includes("fixture%40user:p%2F%40word@fixture.mongodb.net")); assert.match(configured.targetSHA256, /^[\da-f]{64}$/u);
assert.throws(() => wordCardSnapshotConnection({ MONGODB_URI: "http://invalid" }), /configuration/);
assert.throws(() => wordCardSnapshotConnection({ MONGODB_URI: "mongodb://localhost", DB_NAME: "bad/name" }), /configuration/);

const directory = await mkdtemp(join(tmpdir(), "word-card-snapshot-fixture-"));
try {
  const snapshotPath = join(directory, "snapshot.ejson"), summaryPath = join(directory, "summary.json");
  const summary = await writeWordCardSnapshotFiles(snapshot, snapshotPath, summaryPath);
  const saved = await readFile(snapshotPath, "utf8"); assert.equal(summary.snapshotSHA256, wordCardSHA256(saved)); assert.equal(summary.bytes, Buffer.byteLength(saved));
  assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600); assert.equal((await stat(summaryPath)).mode & 0o777, 0o600);
  assert.ok(BSON.EJSON.parse(saved, { relaxed: false }).collections.WORDS_DE[0]._id instanceof BSON.ObjectId);
  assert.ok(!JSON.stringify(summary).includes("PRIVATE_"));
  await assert.rejects(() => writeWordCardSnapshotFiles(snapshot, snapshotPath, summaryPath), /EEXIST/);
  assert.equal(await readFile(snapshotPath, "utf8"), saved);
  const exclusive = join(directory, "new-snapshot.ejson");
  await assert.rejects(() => writeWordCardSnapshotFiles(snapshot, exclusive, summaryPath), /EEXIST/);
  await assert.rejects(() => stat(exclusive), /ENOENT/, "A failed sidecar reservation cannot leave a misleading empty snapshot");
  const reportPath = join(directory, "report.json"); await writeWordCardVerificationReport(reportPath, report);
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600); await assert.rejects(() => writeWordCardVerificationReport(reportPath, report), /EEXIST/);
  const beforePath = join(directory, "before.ejson"), afterPath = join(directory, "after.ejson"), manifestPath = join(directory, "manifest.ejson"), cliOutput = join(directory, "cli.json");
  await writeFile(beforePath, beforeText, { mode: 0o600 }); await writeFile(afterPath, serializeWordCardEjson(after), { mode: 0o600 }); await writeFile(manifestPath, serializeWordCardEjson(manifest), { mode: 0o600 });
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const cli = spawnSync(process.execPath, ["--import", "tsx", join(scriptDirectory, "verifyWordCardAudit.ts"), "--before", beforePath, "--after", afterPath, "--manifest", manifestPath, "--output", cliOutput], { encoding: "utf8", env: { PATH: dirname(process.execPath) } });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).status, "verified");
  assert.ok(!cli.stdout.includes("PRIVATE_") && !cli.stdout.includes("Haus"), "Terminal output contains counts/status only");
  const help = spawnSync(process.execPath, ["--import", "tsx", join(scriptDirectory, "snapshotWordCardAudit.ts"), "--help"], { encoding: "utf8", env: { PATH: dirname(process.execPath) } });
  assert.equal(help.status, 0, help.stderr);
  const existing = spawnSync(process.execPath, ["--import", "tsx", join(scriptDirectory, "snapshotWordCardAudit.ts"), "--output", snapshotPath], { encoding: "utf8", env: { PATH: dirname(process.execPath) } });
  assert.equal(existing.status, 1); assert.equal(JSON.parse(existing.stderr).status, "snapshot_failed");
  assert.equal(await readFile(snapshotPath, "utf8"), saved, "An existing snapshot is rejected before any environment loading or database connection");
} finally { await rm(directory, { recursive: true, force: true }); }
console.log("Pure word-card snapshot/verifier fixtures passed: exclusive private files, checksums, canonical directions, allowed fields, identity survival, protected concurrent changes, classifier metadata, coherent references and exact dedicated native pairs. No database/provider calls.");
